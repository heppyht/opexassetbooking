/*───────────────────── Server Authorization Client ─────────────────────*/
/* Client-side client for the OPEX VBM server-side authorization API.
   All requests go to the Cloudflare Worker at the configured API base URL.
   The client never sends passwords or secrets — only session IDs obtained
   from the MyGeotab runtime. */

export type ServerAuthzConfig = {
  baseUrl: string;
};

export type VerifyResult =
  | { ok: true; principal: { userName: string; database: string; server: string; sessionId: string; roles: string[]; authenticatedAt: string } }
  | { ok: false; error: string };

export type AuthorizeResult =
  | { authorized: true; principal: { userName: string; roles: string[] }; requiredRole?: string }
  | { authorized: false; error: string; reason: string; requiredRole?: string };

export type ExecuteRequest = {
  sessionId: string;
  database: string;
  server: string;
  userName: string;
  action: string;
  bookingId: string;
  bookingData?: Record<string, unknown>;
  operation?: "add" | "set" | "remove";
  recordId?: string;
  /** Stable idempotency key; required by the Worker to deduplicate retries. */
  idempotencyKey?: string;
};

export type ExecuteResult =
  | { success: true; recordId: string; actorUserId: string }
  | { success: false; error: string; reason: string };

export class ServerAuthzError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ServerAuthzError";
    this.status = status;
  }
}

async function request<T>(config: ServerAuthzConfig, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new ServerAuthzError(response.status, errorBody.error || `Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

/*───────────────────── Public API ─────────────────────*/

export class ServerAuthzClient {
  private config: ServerAuthzConfig;

  constructor(config: ServerAuthzConfig) {
    this.config = config;
  }

  async verifySession(
    sessionId: string,
    database: string,
    server: string,
  ): Promise<VerifyResult> {
    return request<VerifyResult>(this.config, "/authz/verify", { sessionId, database, server });
  }

  async authorize(
    sessionId: string,
    database: string,
    server: string,
    action: string,
    bookingId?: string,
    userName?: string,
  ): Promise<AuthorizeResult> {
    return request<AuthorizeResult>(this.config, "/authz/authorize", { sessionId, database, server, userName, action, bookingId });
  }

  async execute(
    sessionId: string,
    database: string,
    server: string,
    action: string,
    bookingId: string,
    bookingData?: Record<string, unknown>,
    operation?: "add" | "set" | "remove",
    recordId?: string,
    idempotencyKey?: string,
    userName?: string,
  ): Promise<ExecuteResult> {
    return request<ExecuteResult>(this.config, "/authz/execute", {
      sessionId,
      database,
      server,
      userName,
      action,
      bookingId,
      bookingData,
      operation,
      recordId,
      idempotencyKey,
    });
  }
}

/*───────────────────── Configuration & Fail-Closed Gate ─────────────────────*/
/* Helpers that resolve the Worker base URL from build-time configuration and
   construct the client. Kept in this module (a dependency-free leaf) so the
   resolution and fail-closed behavior can be unit-tested directly.

   Security invariants:
   - When the API base URL is missing/empty, no client is created so protected
     operations cannot be sent to the trusted Worker (fail closed).
   - The gate never falls back to direct AddInData writes for protected
     operations when server-side authorization is unavailable in live mode.
   - Credentials/session IDs are never included in thrown errors or logs. */

export type AuthzEnvLike = Record<string, unknown> | null | undefined;

/* Resolve the trusted Worker API base URL from the Vite build-time env.
   Fails closed: returns "" (no client) when the value is absent or blank. */
export function resolveAuthzBaseUrl(env: AuthzEnvLike): string {
  if (!env || typeof env !== "object") return "";
  const raw = (env as Record<string, unknown>).VITE_API_BASE_URL;
  if (typeof raw !== "string") return "";
  return raw.trim();
}

/* Create a ServerAuthzClient only when a non-empty base URL is configured.
   Returns null otherwise so authorization cannot be attempted or bypassed. */
export function createServerAuthzClient(baseUrl: string): ServerAuthzClient | null {
  const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!trimmed) return null;
  return new ServerAuthzClient({ baseUrl: trimmed });
}

export type ServerAuthzSessionCreds = {
  sessionId: string;
  database: string;
  server: string;
  /** MyGeotab user name; required by the Worker to verify the session. */
  userName: string;
};

/* Server-side authorization gate for protected operations.
   - ADDIN_DATA (live) mode requires credentials AND a configured Worker client.
     If either is missing, it throws SERVER_AUTHZ_NOT_CONFIGURED and never falls
     back to a direct write.
   - When the Worker denies (authorized === false) or errors, it throws so the
     caller aborts before any persistence occurs.
   - DEMO mode with no server context returns without server authorization; the
     caller uses the local demo provider only (never live AddInData). */
export async function authorizeServerAction(params: {
  serverAuthz: ServerAuthzClient | null;
  mode: string;
  creds: ServerAuthzSessionCreds | null;
  action: string;
  bookingId?: string;
}): Promise<void> {
  const { serverAuthz, mode, creds, action, bookingId } = params;

  if (!creds || !serverAuthz) {
    if (mode === "ADDIN_DATA") {
      throw new Error("SERVER_AUTHZ_NOT_CONFIGURED");
    }
    return;
  }

  const authz = await serverAuthz.authorize(creds.sessionId, creds.database, creds.server, action, bookingId, creds.userName);
  if (!authz.authorized) {
    throw new Error(`NOT_AUTHORIZED: ${authz.error}`);
  }
}
