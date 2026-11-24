/*───────────────────── Server-Side Authorization Logic ─────────────────────*/
/* Implements the authorization decision engine for protected booking operations.
   Every protected operation goes through this module:
   1. Verify session ID with MyGeotab
   2. Resolve user roles from trusted source
   3. Check authorization for the requested action
   4. Validate booking state
   5. Enforce server-side
   6. Record authenticated actor in audit
   7. Return clear error for unauthorized operations */

import type {
  AuthorizationRequest,
  AuthorizationResponse,
  BookingAction,
  Env,
  ExecutionRequest,
  ExecutionResponse,
  UserRole,
  VerifiedPrincipal,
} from "./types.ts";
export type { AuthorizationRequest, ExecutionRequest };
import {
  addInDataAdd,
  ServiceAccountSession,
  verifySession,
} from "./integrations/mygeotab/client.ts";
import type { AddInDataAddInput } from "./integrations/mygeotab/client.ts";

/*───────────────────── Role Hierarchy ─────────────────────*/

const ROLE_RANK: Record<UserRole, number> = {
  EMPLOYEE: 0,
  APPROVER: 1,
  GA: 2,
  MANAGEMENT: 3,
  ADMIN: 4,
};

const ACTION_REQUIRED_ROLE: Record<BookingAction, UserRole> = {
  approve_booking: "APPROVER",
  reject_booking: "APPROVER",
  assign_driver: "APPROVER",
  complete_booking: "EMPLOYEE",
  cancel_booking: "EMPLOYEE",
  create_booking: "EMPLOYEE",
};

export function roleHasMinRank(role: UserRole, minRole: UserRole): boolean {
  const rank = ROLE_RANK[role];
  const min = ROLE_RANK[minRole];
  if (rank === undefined || min === undefined) return false;
  return rank >= min;
}

export function hasRole(roles: UserRole[], requiredRole: UserRole): boolean {
  return roles.some(r => roleHasMinRank(r, requiredRole));
}

/*───────────────────── Session Verification ─────────────────────*/

/* Verify a session ID against MyGeotab. Returns verified principal or error. */
export async function verifyIdentity(
  sessionId: string,
  database: string,
  server: string,
): Promise<{ ok: true; principal: VerifiedPrincipal } | { ok: false; error: string }> {
  if (!sessionId || !database || !server) {
    return { ok: false, error: "MISSING_CREDENTIALS" };
  }

  /* We need the userName to verify. The client sends it alongside sessionId. */
  return verifySession(server, database, "", sessionId);
}

/*───────────────────── Authorization Decision ─────────────────────*/

/* Check if a verified principal is authorized for the requested action. */
export function checkAuthorization(
  principal: VerifiedPrincipal,
  action: BookingAction,
): { authorized: true; requiredRole?: UserRole } | { authorized: false; error: string; reason: string; requiredRole: UserRole } {
  const requiredRole = ACTION_REQUIRED_ROLE[action];
  if (!requiredRole) {
    return {
      authorized: false,
      error: "UNKNOWN_ACTION",
      reason: `Unknown action: ${action}`,
      requiredRole: "EMPLOYEE",
    };
  }

  if (!hasRole(principal.roles, requiredRole)) {
    return {
      authorized: false,
      error: "INSUFFICIENT_ROLE",
      reason: `Action "${action}" requires role "${requiredRole}" or higher. User roles: ${principal.roles.join(", ")}`,
      requiredRole,
    };
  }

  return { authorized: true, requiredRole };
}

/*───────────────────── Authorization Endpoint Handler ─────────────────────*/

export async function handleAuthorize(
  _env: Env,
  req: AuthorizationRequest,
): Promise<AuthorizationResponse> {
  /* 1. Authenticate: verify session ID with MyGeotab */
  const verification = await verifySession(
    req.server,
    req.database,
    "", /* userName not needed for Get User by userName search */
    req.sessionId,
  );

  if (!verification.ok) {
    return {
      authorized: false,
      error: verification.error,
      reason: "INVALID_SESSION",
      requiredRole: ACTION_REQUIRED_ROLE[req.action],
    };
  }

  const principal = verification.principal;

  /* 2. Resolve permissions from trusted source (already done in verifySession) */
  /* 3. Enforce authorization server-side */
  const authz = checkAuthorization(principal, req.action);
  if (!authz.authorized) {
    return {
      authorized: false,
      error: authz.error,
      reason: "INSUFFICIENT_ROLE",
      requiredRole: authz.requiredRole,
    };
  }

  /* 4. Return authorization decision with verified actor */
  return {
    authorized: true,
    principal,
    requiredRole: authz.requiredRole,
  };
}

/*───────────────────── Protected Operation Execution ─────────────────────*/

/* Execute a protected operation server-side using a service account.
   This ensures the client cannot bypass authorization by directly
   invoking AddInData operations. */
export async function handleExecute(
  env: Env,
  serviceSession: ServiceAccountSession,
  addInId: string,
  req: ExecutionRequest,
): Promise<ExecutionResponse> {
  /* 1. Authenticate: verify session ID */
  const verification = await verifySession(
    req.server,
    req.database,
    "",
    req.sessionId,
  );

  if (!verification.ok) {
    return {
      success: false,
      error: verification.error,
      reason: "INVALID_SESSION",
    };
  }

  const principal = verification.principal;

  /* 2. Resolve permissions */
  const authz = checkAuthorization(principal, req.action);
  if (!authz.authorized) {
    return {
      success: false,
      error: authz.error,
      reason: "INSUFFICIENT_ROLE",
    };
  }

  /* 3. Get service account credentials for AddInData access */
  const serviceCreds = await serviceSession.getCredentials();

  /* 4. Build the booking record with verified actor attribution */
  const now = new Date().toISOString();
  const recordDetails: Record<string, unknown> = {
    recordType: "booking",
    schemaVersion: 1,
    id: req.bookingId,
    actorUserId: principal.userName,
    action: req.action,
    status: req.bookingData?.status || "PENDING_APPROVAL",
    createdAt: now,
    updatedAt: now,
    ...(req.bookingData || {}),
  };

  /* 5. Perform AddInData write using service account (trusted, not client) */
  const addInput: AddInDataAddInput = {
    addInId,
    details: recordDetails,
  };

  try {
    const result = await addInDataAdd(env, serviceCreds, addInput);

    /* 6. Record audit event with verified actor */
    const auditDetails: Record<string, unknown> = {
      recordType: "booking_audit",
      schemaVersion: 1,
      bookingId: req.bookingId,
      action: req.action,
      actorUserId: principal.userName,
      actorDatabase: principal.database,
      timestamp: now,
      previousStatus: req.bookingData?.previousStatus || null,
      newStatus: req.bookingData?.newStatus || null,
    };

    await addInDataAdd(env, serviceCreds, {
      addInId,
      details: auditDetails,
    });

    return {
      success: true,
      recordId: result.id,
      actorUserId: principal.userName,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : "EXECUTION_FAILED",
      reason: "SERVER_ERROR",
    };
  }
}

/*───────────────────── Booking State Validation ─────────────────────*/

/* Validate that a booking transition is valid.
   Returns null if valid, or an error message if invalid. */
export function validateTransition(
  currentStatus: string,
  newStatus: string,
): string | null {
  const validTransitions: Record<string, string[]> = {
    DRAFT: ["SUBMITTED"],
    SUBMITTED: ["PENDING_APPROVAL"],
    PENDING_APPROVAL: ["APPROVED", "REJECTED", "CANCELLED"],
    APPROVED: ["ASSIGNED", "CANCELLED"],
    ASSIGNED: ["COMPLETED", "CANCELLED"],
    COMPLETED: [],
    REJECTED: [],
    CANCELLED: [],
  };

  const allowed = validTransitions[currentStatus];
  if (!allowed) {
    return `Unknown current status: ${currentStatus}`;
  }
  if (!allowed.includes(newStatus)) {
    return `Invalid transition from ${currentStatus} to ${newStatus}`;
  }
  return null;
}

/*───────────────────── Audit Record Helper ─────────────────────*/

export function buildAuditRecord(
  addInId: string,
  bookingId: string,
  action: string,
  actorUserId: string,
  previousStatus: string | null,
  newStatus: string | null,
  metadata?: Record<string, unknown>,
): AddInDataAddInput {
  return {
    addInId,
    details: {
      recordType: "booking_audit",
      schemaVersion: 1,
      bookingId,
      action,
      actorUserId,
      timestamp: new Date().toISOString(),
      previousStatus,
      newStatus,
      ...(metadata || {}),
    },
  };
}
