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

export type ExecuteResult =
  | { success: true; recordId: string; actorUserId: string }
  | { success: false; error: string; reason: string };

class ServerAuthzError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ServerAuthzError";
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
  constructor(private config: ServerAuthzConfig) {}

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
  ): Promise<AuthorizeResult> {
    return request<AuthorizeResult>(this.config, "/authz/authorize", { sessionId, database, server, action, bookingId });
  }

  async execute(
    sessionId: string,
    database: string,
    server: string,
    action: string,
    bookingId: string,
    bookingData?: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    return request<ExecuteResult>(this.config, "/authz/execute", { sessionId, database, server, action, bookingId, bookingData });
  }
}
