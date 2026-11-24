import type { GeotabApiLike } from "../config/lifecycleBridge";

export type AppMode = "DEMO" | "ADDIN_DATA";

export type SessionContext = {
  userName?: string;
  database?: string;
  server?: string;
  sessionId?: string;
};

export type VerifiedPrincipal = {
  id: string;
  name: string;
  roles: string[];
  session: SessionContext;
};

export type IdentityResolutionState =
  | { status: "loading"; session?: SessionContext }
  | { status: "authenticated"; principal: VerifiedPrincipal; session: SessionContext }
  | { status: "unresolved"; session?: SessionContext; reason: string }
  | { status: "error"; session?: SessionContext; reason: string };

type RawUser = {
  id?: unknown;
  name?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  role?: unknown;
};

function toSessionContext(session: unknown): SessionContext {
  if (!session || typeof session !== "object") return {};
  const s = session as Record<string, unknown>;
  return {
    userName: typeof s.userName === "string" ? s.userName : undefined,
    database: typeof s.database === "string" ? s.database : undefined,
    server: typeof s.server === "string" ? s.server : undefined,
    sessionId: typeof s.sessionId === "string" ? s.sessionId : undefined,
  };
}

function getSession(api: GeotabApiLike): Promise<SessionContext | null> {
  return new Promise((resolve) => {
    try {
      if (typeof api.getSession !== "function") {
        resolve(null);
        return;
      }
      api.getSession((session) => {
        resolve(session ? toSessionContext(session) : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function apiCall<T>(api: GeotabApiLike, method: string, params: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      if (typeof api.call !== "function") {
        reject(new Error("GEOTAB_API_CALL_UNAVAILABLE"));
        return;
      }
      api.call(method, params, (result) => resolve(result as T), (err) => reject(err ?? new Error("GEOTAB_API_ERROR")));
    } catch (e) {
      reject(e ?? new Error("GEOTAB_API_CALL_THROWN"));
    }
  });
}

function normalizePrincipal(raw: RawUser, session: SessionContext): VerifiedPrincipal | null {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const name =
    typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : [typeof raw.firstName === "string" ? raw.firstName.trim() : "", typeof raw.lastName === "string" ? raw.lastName.trim() : ""]
          .filter(Boolean)
          .join(" ") || session.userName || "Unknown";
  const role = typeof raw.role === "string" && raw.role.trim() ? raw.role.trim() : "EMPLOYEE";
  return { id, name, roles: [role], session: { ...session } };
}

/**
 * Deterministically resolve the authenticated MyGeotab principal.
 * - Uses session context from the MyGeotab runtime (getSession) and retains it on the principal.
 * - Performs a targeted User lookup via api.call Get using the session userName as search criteria.
 * - Accepts only a single unambiguous match with a canonical non-empty user id.
 * - Never infers identity from display-name equality alone as a fallback, never assumes email
 *   equality proves id equality, and never returns demo/local identities.
 * - Does not log or expose credentials/sensitive session tokens.
 */
export async function resolveAuthenticatedPrincipal(
  api: GeotabApiLike | null | undefined,
): Promise<IdentityResolutionState> {
  if (!api || typeof api.call !== "function") {
    return { status: "unresolved", reason: "MyGeotab API is not available." };
  }

  const session = await getSession(api);
  if (!session || !session.userName || !session.userName.trim()) {
    return { status: "unresolved", session: session ?? undefined, reason: "Authenticated MyGeotab session is unavailable." };
  }

  const normalizedSession: SessionContext = {
    userName: session.userName.trim(),
    database: session.database,
    server: session.server,
  };

  try {
    const users = await apiCall<RawUser[]>(api, "Get", {
      typeName: "User",
      search: { name: normalizedSession.userName },
      resultsLimit: 10,
    });

    const candidates = Array.isArray(users) ? users : [];
    if (candidates.length === 0) {
      return { status: "unresolved", session: normalizedSession, reason: "Authenticated MyGeotab user could not be found." };
    }
    if (candidates.length > 1) {
      return { status: "unresolved", session: normalizedSession, reason: "Authenticated MyGeotab user identity is ambiguous." };
    }

    const principal = normalizePrincipal(candidates[0], normalizedSession);
    if (!principal) {
      return { status: "unresolved", session: normalizedSession, reason: "Authenticated MyGeotab user record is missing a verified identifier." };
    }

    return { status: "authenticated", principal, session: normalizedSession };
  } catch (e) {
    const reason = e instanceof Error ? e.message : "Failed to resolve authenticated MyGeotab identity.";
    return { status: "error", session: normalizedSession, reason };
  }
}

export function isLiveIdentityVerified(state: IdentityResolutionState | null | undefined): boolean {
  return !!state && state.status === "authenticated";
}

export function canPerformLiveWrite(
  mode: AppMode,
  state: IdentityResolutionState | null | undefined,
): boolean {
  if (mode !== "ADDIN_DATA") return true;
  return isLiveIdentityVerified(state);
}

export function getLiveBlockedReason(
  mode: AppMode,
  state: IdentityResolutionState | null | undefined,
): string | null {
  if (mode !== "ADDIN_DATA") return null;
  if (!state) return "Authenticated MyGeotab identity is not resolved.";
  if (state.status === "loading") return "Resolving authenticated MyGeotab identity…";
  if (state.status === "authenticated") return null;
  if (state.status === "unresolved") return state.reason || "Authenticated MyGeotab identity could not be verified.";
  return state.reason || "Failed to resolve authenticated MyGeotab identity.";
}

/**
 * Actor identity for booking/approval operations (this phase: make available; audit persistence documented separately).
 * - LIVE (ADDIN_DATA): verified MyGeotab principal id only.
 * - DEMO: explicit demo actor id (never used when mode is LIVE).
 */
export function getActorIdForMode(
  mode: AppMode,
  identity: IdentityResolutionState | null | undefined,
  demoActorId: string | null | undefined,
): string | null {
  if (mode === "ADDIN_DATA") {
    return identity && identity.status === "authenticated" ? identity.principal.id : null;
  }
  return demoActorId && demoActorId.trim() ? demoActorId : null;
}

/*───────────────────── Session Credentials for Server-Side Verification ─────────────────────*/

/* Returns the session credentials needed to verify identity with the server-side
   authorization API. Only available when identity is authenticated in ADDIN_DATA mode.
   Never returns passwords or other secrets. */
export function getSessionCredentials(
  mode: AppMode,
  identity: IdentityResolutionState | null | undefined,
): { sessionId: string; database: string; server: string; userName: string } | null {
  if (mode !== "ADDIN_DATA") return null;
  if (!identity || identity.status !== "authenticated") return null;
  const { session } = identity;
  if (!session?.sessionId || !session?.database || !session?.server || !session?.userName) {
    return null;
  }
  return {
    sessionId: session.sessionId,
    database: session.database,
    server: session.server,
    userName: session.userName,
  };
}
