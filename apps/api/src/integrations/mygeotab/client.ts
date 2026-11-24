/*───────────────────── Server-Side MyGeotab Client ─────────────────────*/
/* Minimal JSON-RPC client for server-side MyGeotab API access.
   Used to:
   1. Authenticate as a service account for AddInData operations
   2. Verify end-user session IDs (security boundary)
   3. Look up user roles/clearances
   4. Perform AddInData Add/Set/Get/Remove on behalf of authorized users

   All calls go over HTTPS to the MyGeotab server.
   No credentials are logged or returned to the client. */

import type { Env, UserRole, VerifiedPrincipal } from "../../types.ts";

export interface LoginResult {
  credentials: {
    database: string;
    userName: string;
    sessionId: string;
  };
  path: string;
}

export interface MyGeotabError extends Error {
  code?: number;
  data?: unknown;
}

export interface GetSessionResult {
  credentials: {
    database: string;
    userName: string;
    sessionId: string;
  };
  path: string;
}

export interface UserRecord {
  id: string;
  userName: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  securityClearance?: string;
  active?: boolean;
}

export interface AddInDataRecord {
  id: string;
  addInId: string;
  details: Record<string, unknown>;
  groups?: Array<{ id: string }>;
}

/*───────────────────── JSON-RPC Client ─────────────────────*/

class MyGeotabApiError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "MyGeotabApiError";
    this.code = code;
    this.data = data;
  }
}

async function myGeotabCall<T>(
  server: string,
  method: string,
  params: Record<string, unknown>,
  credentials?: { database: string; userName: string; sessionId?: string; password?: string },
): Promise<T> {
  const url = `https://${server}/apiv1`;
  const body: Record<string, unknown> = {
    method,
    params: { ...params },
  };
  if (credentials) {
    (body.params as Record<string, unknown>).credentials = credentials;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new MyGeotabApiError(response.status, `HTTP ${response.status}: ${response.statusText}`);
  }

  const json = await response.json() as {
    result?: T;
    error?: { message: string; data?: unknown; name?: string };
    id?: unknown;
  };

  if (json.error) {
    throw new MyGeotabApiError(
      -32603,
      json.error.message,
      json.error.data,
    );
  }

  return json.result as T;
}

/*───────────────────── Authentication ─────────────────────*/

/* Authenticate as a service account. Returns credentials for AddInData access. */
export async function authenticateServiceAccount(
  env: Env,
): Promise<{ credentials: { database: string; userName: string; sessionId: string }; path: string }> {
  const username = env.GEOTAB_SERVICE_USERNAME;
  const password = env.GEOTAB_SERVICE_PASSWORD;
  const server = env.GEOTAB_SERVICE_SERVER || "my.geotab.com";

  if (!username || !password) {
    throw new Error("SERVICE_ACCOUNT_NOT_CONFIGURED");
  }

  const result = await myGeotabCall<LoginResult>(
    server,
    "Authenticate",
    {
      userName: username,
      database: env.GEOTAB_DATABASE,
      password,
    },
  );

  return {
    credentials: {
      database: result.credentials.database,
      userName: result.credentials.userName,
      sessionId: result.credentials.sessionId,
    },
    path: result.path,
  };
}

/* Verify an end-user session ID by making a Get User call with those credentials.
   If the session ID is valid, the call succeeds and we can resolve the user's identity.
   If invalid, MyGeotab returns an authentication error. */
export async function verifySession(
  server: string,
  database: string,
  userName: string,
  sessionId: string,
): Promise<{ ok: true; principal: VerifiedPrincipal } | { ok: false; error: string }> {
  try {
    /* Get User by userName to confirm the session is valid and resolve roles */
    const users = await myGeotabCall<UserRecord[]>(
      server,
      "Get",
      {
        typeName: "User",
        search: { userName },
        resultsLimit: 1,
        selectClause: "id,userName,email,firstName,lastName,securityClearance,active",
      },
      { database, userName, sessionId },
    );

    if (!users || users.length === 0) {
      return { ok: false, error: "USER_NOT_FOUND" };
    }

    const user = users[0];
    if (!user.active) {
      return { ok: false, error: "USER_INACTIVE" };
    }

    const roles = resolveRoles(user.securityClearance, user.userName);

    return {
      ok: true,
      principal: {
        userName,
        database,
        server,
        sessionId,
        roles,
        authenticatedAt: new Date().toISOString(),
      },
    };
  } catch (e) {
    if (e instanceof MyGeotabApiError) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: e instanceof Error ? e.message : "VERIFICATION_FAILED" };
  }
}

/*───────────────────── Role Resolution ─────────────────────*/

/* Map MyGeotab security clearance to application roles.
   MyGeotab security clearances are configured per-database. We map known
   clearance names to application roles, falling back to EMPLOYEE for
   unrecognized clearances. */
export function resolveRoles(securityClearance: string | undefined, _userName: string): UserRole[] {
  const clearance = (securityClearance || "").toUpperCase();

  if (clearance.includes("ADMINISTRATOR")) {
    return ["ADMIN"];
  }
  if (clearance.includes("MANAGEMENT")) {
    return ["MANAGEMENT"];
  }
  if (clearance.includes("GA")) {
    return ["GA"];
  }
  if (clearance.includes("APPROVER")) {
    return ["APPROVER"];
  }
  if (clearance.includes("SUPERVISOR")) {
    return ["MANAGEMENT", "APPROVER"];
  }
  /* Default: authenticated user with View Only or Default clearance */
  return ["EMPLOYEE"];
}

/*───────────────────── AddInData Operations ─────────────────────*/

export interface AddInDataAddInput {
  addInId: string;
  details: Record<string, unknown>;
  groups?: Array<{ id: string }>;
}

export interface AddInDataSetInput {
  id: string;
  addInId: string;
  details: Record<string, unknown>;
  groups?: Array<{ id: string }>;
}

export interface AddInDataGetInput {
  addInId: string;
  search?: Record<string, unknown>;
  whereClause?: string;
  selectClause?: string;
  resultsLimit?: number;
}

export interface AddInDataRemoveInput {
  id: string;
  addInId: string;
}

/* Add an AddInData record using service account credentials. */
export async function addInDataAdd(
  env: Env,
  serviceCredentials: { database: string; userName: string; sessionId: string },
  input: AddInDataAddInput,
): Promise<{ id: string }> {
  const server = env.GEOTAB_SERVICE_SERVER || "my.geotab.com";
  const result = await myGeotabCall<{ id: string }>(
    server,
    "Add",
    {
      typeName: "AddInData",
      entity: {
        addInId: input.addInId,
        details: input.details,
        groups: input.groups,
      },
    },
    serviceCredentials,
  );
  return result;
}

/* Set (update) an AddInData record using service account credentials. */
export async function addInDataSet(
  env: Env,
  serviceCredentials: { database: string; userName: string; sessionId: string },
  input: AddInDataSetInput,
): Promise<void> {
  const server = env.GEOTAB_SERVICE_SERVER || "my.geotab.com";
  await myGeotabCall<void>(
    server,
    "Set",
    {
      typeName: "AddInData",
      entity: {
        id: input.id,
        addInId: input.addInId,
        details: input.details,
        groups: input.groups,
      },
    },
    serviceCredentials,
  );
}

/* Get AddInData records using service account credentials. */
export async function addInDataGet(
  env: Env,
  serviceCredentials: { database: string; userName: string; sessionId: string },
  input: AddInDataGetInput,
): Promise<Array<{ id: string; addInId: string; details: Record<string, unknown>; groups?: Array<{ id: string }> }>> {
  const server = env.GEOTAB_SERVICE_SERVER || "my.geotab.com";
  const result = await myGeotabCall<Array<AddInDataRecord>>(
    server,
    "Get",
    {
      typeName: "AddInData",
      search: { addInId: input.addInId, ...(input.search || {}) },
      ...(input.whereClause ? { whereClause: input.whereClause } : {}),
      ...(input.selectClause ? { selectClause: input.selectClause } : {}),
      ...(input.resultsLimit ? { resultsLimit: input.resultsLimit } : {}),
    },
    serviceCredentials,
  );
  return result.map(r => ({
    id: r.id,
    addInId: r.addInId,
    details: r.details,
    groups: r.groups,
  }));
}

/* Remove an AddInData record using service account credentials. */
export async function addInDataRemove(
  env: Env,
  serviceCredentials: { database: string; userName: string; sessionId: string },
  input: AddInDataRemoveInput,
): Promise<void> {
  const server = env.GEOTAB_SERVICE_SERVER || "my.geotab.com";
  await myGeotabCall<void>(
    server,
    "Remove",
    {
      typeName: "AddInData",
      entity: { id: input.id },
    },
    serviceCredentials,
  );
}

/*───────────────────── Service Account Session Manager ─────────────────────*/

/* Caches service account credentials and refreshes before expiry.
   Sessions expire after 14 days or on password change. */
export class ServiceAccountSession {
  private credentials: { database: string; userName: string; sessionId: string } | null = null;
  private obtainedAt: number = 0;
  private readonly TTL_MS = 13 * 24 * 60 * 60 * 1000; /* Refresh 1 day before expiry */
  private readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async getCredentials(): Promise<{ database: string; userName: string; sessionId: string }> {
    const now = Date.now();
    if (this.credentials && now - this.obtainedAt < this.TTL_MS) {
      return this.credentials;
    }
    const result = await authenticateServiceAccount(this.env);
    this.credentials = result.credentials;
    this.obtainedAt = now;
    return this.credentials;
  }

  async refresh(): Promise<void> {
    const result = await authenticateServiceAccount(this.env);
    this.credentials = result.credentials;
    this.obtainedAt = Date.now();
  }
}
