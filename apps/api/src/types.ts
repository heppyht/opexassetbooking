/*───────────────────── Shared Types ─────────────────────*/

export type BookingAction =
  | "approve_booking"
  | "reject_booking"
  | "assign_driver"
  | "complete_booking"
  | "cancel_booking"
  | "create_booking";

export type UserRole = "EMPLOYEE" | "APPROVER" | "GA" | "MANAGEMENT" | "ADMIN";

export interface VerifiedPrincipal {
  userName: string;
  database: string;
  server: string;
  sessionId: string;
  roles: UserRole[];
  authenticatedAt: string;
}

export interface SessionVerifyRequest {
  sessionId: string;
  database: string;
  server: string;
}

export type SessionVerifyResponse =
  | { ok: true; principal: VerifiedPrincipal }
  | { ok: false; error: string };

export interface AuthorizationRequest {
  sessionId: string;
  database: string;
  server: string;
  action: BookingAction;
  bookingId?: string;
  actorUserId?: string;
}

export type AuthorizationResponse =
  | { authorized: true; principal: VerifiedPrincipal; requiredRole?: UserRole; token?: string }
  | { authorized: false; error: string; reason: "UNAUTHENTICATED" | "UNAUTHORIZED" | "INVALID_SESSION" | "INSUFFICIENT_ROLE"; requiredRole?: UserRole };

export interface ExecutionRequest {
  sessionId: string;
  database: string;
  server: string;
  action: BookingAction;
  bookingId: string;
  bookingData?: Record<string, unknown>;
}

export type ExecutionResponse =
  | { success: true; recordId: string; actorUserId: string }
  | { success: false; error: string; reason: string };

/*───────────────────── Environment ─────────────────────*/

export interface Env {
  APP_ENV: string;
  ALLOWED_ORIGIN: string;
  GEOTAB_DATABASE: string;

  /* Service account credentials — set via `wrangler secret put`, never in .dev.vars */
  GEOTAB_SERVICE_USERNAME?: string;
  GEOTAB_SERVICE_PASSWORD?: string;
  GEOTAB_SERVICE_SERVER?: string;

  /* JWT secret for signing authorization tokens — set via `wrangler secret put` */
  AUTHZ_JWT_SECRET?: string;
}
