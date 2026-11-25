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
  addInDataGet,
  addInDataSet,
  addInDataRemove,
  ServiceAccountSession,
  verifySession,
} from "./integrations/mygeotab/client.ts";
import type { AddInDataAddInput, AddInDataSetInput, AddInDataRemoveInput } from "./integrations/mygeotab/client.ts";
import { computePayloadFingerprint } from "./crypto.ts";

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
  delete_booking: "EMPLOYEE",
  view_security_dashboard: "ADMIN",
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
  userName: string,
): Promise<{ ok: true; principal: VerifiedPrincipal } | { ok: false; error: string }> {
  if (!sessionId || !database || !server || !userName) {
    return { ok: false, error: "MISSING_CREDENTIALS" };
  }

  return verifySession(server, database, userName, sessionId);
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
  /* 1. Authenticate: verify session ID with MyGeotab.
     The client sends userName from its MyGeotab session context. We never trust
     it as proof of identity — MyGeotab validates the sessionId against the
     userName and rejects mismatches. */
  const verification = await verifySession(
    req.server,
    req.database,
    req.userName,
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
    req.userName,
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

  /* 3. Require idempotency key on all protected operations */
  if (!req.idempotencyKey) {
    return {
      success: false,
      error: "IDEMPOTENCY_KEY_REQUIRED",
      reason: "IDEMPOTENCY_KEY_REQUIRED",
    };
  }

  /* 4. Compute payload fingerprint for conflict detection.
     Fails closed if SHA-256 is unavailable — protected operations cannot
     proceed without a verifiable fingerprint. */
  let payloadFingerprint: string;
  try {
    payloadFingerprint = await computePayloadFingerprint({
      action: req.action,
      bookingId: req.bookingId,
      /* bookingData is absent for remove (delete) operations; canonicalize()
         rejects `undefined`, so normalize to null to keep the fingerprint
         computable. Objects pass through unchanged. */
      bookingData: req.bookingData ?? null,
      operation: req.operation,
      /* recordId is absent for add operations; canonicalize() rejects
         `undefined`, so normalize to null to keep the fingerprint computable.
         set/remove always carry a string recordId, so this is a no-op for them. */
      recordId: req.recordId ?? null,
    });
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : "FINGERPRINT_FAILED",
      reason: "FINGERPRINT_FAILED",
    };
  }

  /* 5. Get service account credentials for AddInData access */
  const serviceCreds = await serviceSession.getCredentials();

  /* 6. Check idempotency key — return cached result if already processed */
  const idemCheck = await checkIdempotencyKey(
    env,
    serviceCreds,
    addInId,
    req.idempotencyKey,
    payloadFingerprint,
    principal.userName,
    req.action,
    req.bookingId,
  );

  if (idemCheck.found) {
    if ("conflict" in idemCheck && idemCheck.conflict) {
      return {
        success: false,
        error: "IDEMPOTENCY_KEY_CONFLICT",
        reason: `Idempotency key "${req.idempotencyKey}" was previously used with a different payload.`,
      };
    }
    return (idemCheck as { found: true; result: ExecutionResponse }).result;
  }

  /* 7. Perform the AddInData write using service account (trusted, not client) */
  const now = new Date().toISOString();
  const operation = req.operation ?? "add";

  try {
    let resultId: string;
    let actorUserId = principal.userName;

    if (operation === "add") {
      /* 7a. ADD: create a new booking record with verified actor attribution */
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

      const addInput: AddInDataAddInput = {
        addInId,
        details: recordDetails,
      };

      const addResult = await addInDataAdd(env, serviceCreds, addInput);
      resultId = addResult.id;
    } else if (operation === "set") {
      /* 7b. SET: update an existing booking record */
      if (!req.recordId) {
        return {
          success: false,
          error: "RECORD_ID_REQUIRED",
          reason: "recordId is required for set operations",
        };
      }

      const setInput: AddInDataSetInput = {
        addInId,
        id: req.recordId,
        details: req.bookingData || {},
        groups: Array.isArray(req.bookingData?.groups)
          ? (req.bookingData.groups as Array<{ id: string }>)
          : [{ id: "GroupCompanyId" }],
      };

      await addInDataSet(env, serviceCreds, setInput);
      resultId = req.recordId;
    } else if (operation === "remove") {
      /* 7c. REMOVE: delete an existing booking record */
      if (!req.recordId) {
        return {
          success: false,
          error: "RECORD_ID_REQUIRED",
          reason: "recordId is required for remove operations",
        };
      }

      const removeInput: AddInDataRemoveInput = {
        addInId,
        id: req.recordId,
      };

      await addInDataRemove(env, serviceCreds, removeInput);
      resultId = req.recordId;
    } else {
      return {
        success: false,
        error: "UNKNOWN_OPERATION",
        reason: `Unknown operation: ${operation}`,
      };
    }

    /* 8. Return execution result. The frontend is responsible for emitting
       the canonical audit event after a successful Worker write. */
    const executionResult: ExecutionResponse = {
      success: true,
      recordId: resultId,
      actorUserId,
    };

    if (req.idempotencyKey) {
      await storeIdempotencyKey(
        env,
        serviceCreds,
        addInId,
        req.idempotencyKey,
        executionResult,
        payloadFingerprint,
        principal.userName,
        req.action,
        req.bookingId,
      );
    }

    return executionResult;
  } catch (e) {
    const errorResult: ExecutionResponse = {
      success: false,
      error: e instanceof Error ? e.message : "EXECUTION_FAILED",
      reason: "SERVER_ERROR",
    };

    if (req.idempotencyKey) {
      await storeIdempotencyKey(
        env,
        serviceCreds,
        addInId,
        req.idempotencyKey,
        errorResult,
        payloadFingerprint,
        principal.userName,
        req.action,
        req.bookingId,
      );
    }

    return errorResult;
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
    IN_PROGRESS: ["COMPLETED", "CANCELLED"],
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

/* Result of a detailed booking state validation. */
export interface BookingStateValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/* Valid booking statuses. */
const VALID_BOOKING_STATUSES = new Set([
  "DRAFT",
  "SUBMITTED",
  "PENDING_APPROVAL",
  "APPROVED",
  "ASSIGNED",
  "IN_PROGRESS",
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
]);

/* Required audit actions for each booking status. */
const REQUIRED_AUDIT_ACTIONS: Record<string, string[]> = {
  DRAFT: ["BOOKING_CREATED"],
  SUBMITTED: ["BOOKING_CREATED"],
  PENDING_APPROVAL: ["BOOKING_CREATED"],
  APPROVED: ["BOOKING_CREATED", "BOOKING_APPROVED"],
  REJECTED: ["BOOKING_CREATED", "BOOKING_REJECTED"],
  ASSIGNED: ["BOOKING_CREATED", "BOOKING_APPROVED", "VEHICLE_ASSIGNED"],
  IN_PROGRESS: ["BOOKING_CREATED", "BOOKING_APPROVED", "VEHICLE_ASSIGNED", "DRIVER_ASSIGNED"],
  COMPLETED: ["BOOKING_CREATED", "BOOKING_APPROVED", "VEHICLE_ASSIGNED", "DRIVER_ASSIGNED", "BOOKING_COMPLETED"],
  CANCELLED: ["BOOKING_CREATED", "BOOKING_CANCELLED"],
};

/* Comprehensive booking state validation. Checks status validity, transition
   validity, and consistency between booking status and audit trail. Does not
   modify any records — purely advisory. */
export function validateBookingState(
  booking: { id: string; status: string; version?: number },
  auditActions: string[],
): BookingStateValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  /* 1. Status must be a known value */
  if (!VALID_BOOKING_STATUSES.has(booking.status)) {
    errors.push(`Unknown booking status: ${booking.status}`);
    return { valid: false, errors, warnings };
  }

  /* 2. Version must be a positive integer if present */
  if (booking.version !== undefined && (booking.version < 1 || !Number.isInteger(booking.version))) {
    errors.push(`Invalid booking version: ${booking.version}`);
  }

  /* 3. Check that required audit actions are present for the current status */
  const required = REQUIRED_AUDIT_ACTIONS[booking.status];
  if (required) {
    for (const action of required) {
      if (!auditActions.includes(action)) {
        errors.push(`Missing required audit action "${action}" for status "${booking.status}"`);
      }
    }
  }

  /* 4. Warning if version is low relative to audit count */
  if (booking.version !== undefined && auditActions.length > 0 && booking.version < auditActions.length) {
    warnings.push(`Booking version ${booking.version} is lower than audit record count ${auditActions.length}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/* Detailed transition validation result. */
export interface TransitionValidationResult {
  allowed: boolean;
  currentStatus: string;
  newStatus: string;
  error: string | null;
}

/* Validate a booking transition with detailed result. */
export function validateBookingTransition(
  currentStatus: string,
  newStatus: string,
): TransitionValidationResult {
  const error = validateTransition(currentStatus, newStatus);
  return {
    allowed: error === null,
    currentStatus,
    newStatus,
    error,
  };
}

/* Check if a status string is a valid booking status. */
export function isValidBookingStatus(status: string): boolean {
  return VALID_BOOKING_STATUSES.has(status);
}

/* Get all valid transitions from a given status. */
export function getValidTransitions(currentStatus: string): string[] {
  const validTransitions: Record<string, string[]> = {
    DRAFT: ["SUBMITTED"],
    SUBMITTED: ["PENDING_APPROVAL"],
    PENDING_APPROVAL: ["APPROVED", "REJECTED", "CANCELLED"],
    APPROVED: ["ASSIGNED", "CANCELLED"],
    ASSIGNED: ["COMPLETED", "CANCELLED"],
    IN_PROGRESS: ["COMPLETED", "CANCELLED"],
    COMPLETED: [],
    REJECTED: [],
    CANCELLED: [],
  };
  return validTransitions[currentStatus] ?? [];
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

/*───────────────────── Idempotency Key Management ─────────────────────*/

/* Server-side idempotency for protected operations.
   Stores processed keys in AddInData so duplicate requests return the cached result
   instead of re-executing the operation. This prevents replay attacks where a
   client resubmits the same protected operation.

   Does NOT provide atomic exactly-once execution — AddInData has no transactions.
   If two requests with the same key arrive simultaneously, both may execute.
   The idempotency check reduces but does not eliminate replay risk.

   Keys are scoped to (actorUserId, action, bookingId). If the same key is
   presented with a different payload fingerprint, the request is rejected with
   IDEMPOTENCY_KEY_CONFLICT. */

const IDEMPOTENCY_RECORD_TYPE = "idempotency_key";

/* Check if an idempotency key has already been processed.
   Returns the cached result if found and fingerprint matches.
   Returns null if key not found (proceed with execution).
   Throws IDEMPOTENCY_KEY_CONFLICT if key exists but fingerprint differs. */
export async function checkIdempotencyKey(
  env: Env,
  serviceCreds: { database: string; userName: string; sessionId: string },
  addInId: string,
  idempotencyKey: string,
  payloadFingerprint?: string,
  actorUserId?: string,
  action?: string,
  bookingId?: string,
): Promise<{ found: true; result: ExecutionResponse } | { found: false } | { found: true; conflict: true }> {
  try {
    const records = await addInDataGet(env, serviceCreds, {
      addInId,
      whereClause: `details.idempotencyKey = "${idempotencyKey}"`,
      resultsLimit: 1,
    });

    if (!records || records.length === 0) {
      return { found: false };
    }

    const record = records[0];
    const details = record.details as Record<string, unknown>;

    /* Verify key scoping: actor, action, bookingId must match */
    if (
      actorUserId !== undefined &&
      details.actorUserId !== undefined &&
      details.actorUserId !== actorUserId
    ) {
      return { found: true, conflict: true };
    }
    if (
      action !== undefined &&
      details.action !== undefined &&
      details.action !== action
    ) {
      return { found: true, conflict: true };
    }
    if (
      bookingId !== undefined &&
      details.bookingId !== undefined &&
      details.bookingId !== bookingId
    ) {
      return { found: true, conflict: true };
    }

    /* Verify payload fingerprint */
    if (payloadFingerprint !== undefined && details.payloadFingerprint !== undefined) {
      if (details.payloadFingerprint !== payloadFingerprint) {
        return { found: true, conflict: true };
      }
    }

    /* Cached result found */
    if (details.success === true) {
      return {
        found: true,
        result: {
          success: true,
          recordId: details.recordId as string,
          actorUserId: details.actorUserId as string,
        },
      };
    }
    return {
      found: true,
      result: {
        success: false,
        error: (details.error as string) || "UNKNOWN_ERROR",
        reason: (details.reason as string) || "UNKNOWN_REASON",
      },
    };
  } catch {
    return { found: false };
  }
}

/* Store an idempotency key result in AddInData for future duplicate detection. */
export async function storeIdempotencyKey(
  env: Env,
  serviceCreds: { database: string; userName: string; sessionId: string },
  addInId: string,
  idempotencyKey: string,
  result: ExecutionResponse,
  payloadFingerprint?: string,
  actorUserId?: string,
  action?: string,
  bookingId?: string,
): Promise<void> {
  const details: Record<string, unknown> = {
    recordType: IDEMPOTENCY_RECORD_TYPE,
    schemaVersion: 1,
    idempotencyKey,
    success: result.success,
    timestamp: new Date().toISOString(),
  };
  if (payloadFingerprint !== undefined) {
    details.payloadFingerprint = payloadFingerprint;
  }
  if (actorUserId !== undefined) {
    details.actorUserId = actorUserId;
  }
  if (action !== undefined) {
    details.action = action;
  }
  if (bookingId !== undefined) {
    details.bookingId = bookingId;
  }
  if (result.success) {
    details.recordId = (result as { recordId: string }).recordId;
    details.actorUserId = (result as { actorUserId: string }).actorUserId;
  } else {
    details.error = (result as { error: string }).error;
    details.reason = (result as { reason: string }).reason;
  }
  await addInDataAdd(env, serviceCreds, {
    addInId,
    details,
  });
}

