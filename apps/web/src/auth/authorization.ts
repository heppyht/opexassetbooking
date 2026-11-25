/*───────────────────── Role-Based Access Control ─────────────────────*/
/* Client-side authorization for OPEX Asset Booking operations.
   NOTE: These checks are enforced in the React UI layer only.
   MyGeotab AddInData has no server-side authorization middleware, so
   a determined user with browser console access can bypass these checks.
   A trusted server-side authorization service is required for production
   security guarantees. */

import type { IdentityResolutionState } from "./identityResolver";

/*───────────────────── Roles ─────────────────────*/

export type UserRole =
  | "EMPLOYEE"
  | "APPROVER"
  | "GA"
  | "MANAGEMENT"
  | "ADMIN";

/* Role hierarchy: higher index = more privileges */
const ROLE_RANK: Record<UserRole, number> = {
  EMPLOYEE: 0,
  APPROVER: 1,
  GA: 2,
  MANAGEMENT: 3,
  ADMIN: 4,
};

export function roleHasMinRank(role: string | undefined, minRole: UserRole): boolean {
  const rank = ROLE_RANK[role as UserRole];
  if (rank === undefined) return false;
  return rank >= ROLE_RANK[minRole];
}

/*───────────────────── Permissions ─────────────────────*/

export type BookingAction =
  | "create_booking"
  | "delete_booking"
  | "approve_booking"
  | "reject_booking"
  | "assign_driver"
  | "complete_booking"
  | "cancel_booking"
  | "view_all_bookings"
  | "view_security_dashboard";

export function canPerformAction(
  action: BookingAction,
  identity: IdentityResolutionState | null | undefined,
): boolean {
  if (!identity || identity.status !== "authenticated") return false;
  const roles = identity.principal.roles;

  switch (action) {
    case "create_booking":
      return roles.some(r => roleHasMinRank(r, "EMPLOYEE"));
    case "delete_booking":
      return roles.some(r => roleHasMinRank(r, "EMPLOYEE"));
    case "approve_booking":
      return roles.some(r => roleHasMinRank(r, "APPROVER"));
    case "reject_booking":
      return roles.some(r => roleHasMinRank(r, "APPROVER"));
    case "assign_driver":
      return roles.some(r => roleHasMinRank(r, "APPROVER"));
    case "complete_booking":
      return roles.some(r => roleHasMinRank(r, "EMPLOYEE"));
    case "cancel_booking":
      return roles.some(r => roleHasMinRank(r, "EMPLOYEE"));
    case "view_all_bookings":
      return roles.some(r => roleHasMinRank(r, "EMPLOYEE"));
    case "view_security_dashboard":
      return roles.some(r => roleHasMinRank(r, "ADMIN"));
    default:
      return false;
  }
}

export function getRequiredRole(action: BookingAction): UserRole {
  switch (action) {
    case "approve_booking":
    case "reject_booking":
    case "assign_driver":
      return "APPROVER";
    case "view_security_dashboard":
      return "ADMIN";
    default:
      return "EMPLOYEE";
  }
}

/*───────────────────── Actor Identity Validation ─────────────────────*/

/* Validate that the supplied actorUserId matches the authenticated principal.
   Returns true if the actor is authorized to act on behalf of the given identity. */
export function isAuthorizedActor(
  actorUserId: string | null | undefined,
  identity: IdentityResolutionState | null | undefined,
): boolean {
  if (!actorUserId || !actorUserId.trim()) return false;
  if (!identity || identity.status !== "authenticated") return false;
  return actorUserId.trim() === identity.principal.id.trim();
}

/*───────────────────── Authorization Result ─────────────────────*/

export type AuthorizationResult =
  | { authorized: true }
  | { authorized: false; reason: string; requiredRole?: UserRole };

export function authorizeAction(
  action: BookingAction,
  identity: IdentityResolutionState | null | undefined,
): AuthorizationResult {
  if (!identity) {
    return { authorized: false, reason: "IDENTITY_NOT_RESOLVED", requiredRole: getRequiredRole(action) };
  }
  if (identity.status !== "authenticated") {
    return { authorized: false, reason: `IDENTITY_${identity.status.toUpperCase()}`, requiredRole: getRequiredRole(action) };
  }
  if (!canPerformAction(action, identity)) {
    return { authorized: false, reason: "INSUFFICIENT_ROLE", requiredRole: getRequiredRole(action) };
  }
  return { authorized: true };
}
