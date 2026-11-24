/*───────────────────── OPEX VBM API — Server-Side Authorization ─────────────────────*/
/* Cloudflare Worker providing trusted server-side authorization for the
   OPEX Asset Booking Add-In.
   
   Endpoints:
     POST /authz/verify    - Verify MyGeotab session ID, return verified identity
     POST /authz/authorize - Check if verified identity can perform an action
     POST /authz/execute   - Execute protected operation server-side (service account)
     GET  /authz/health    - Health check

   AddInData remains the primary persistence layer. This worker does NOT
   use PostgreSQL. All AddInData writes are performed by a service account
   after server-side authorization. */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types.ts";
import {
  handleAuthorize,
  handleExecute,
  verifyIdentity,
  type AuthorizationRequest,
  type ExecutionRequest,
} from "./authz.ts";
import { ServiceAccountSession } from "./integrations/mygeotab/client.ts";

const app = new Hono<{ Bindings: Env }>();

/*───────────────────── Middleware ─────────────────────*/

/* CORS: only allow the frontend origin */
app.use("/authz/*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && origin !== c.env.ALLOWED_ORIGIN) {
    return c.json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
  }
  return await next();
});

app.use("/authz/*", cors({
  origin: (origin, c) => origin === c.env.ALLOWED_ORIGIN ? origin : "",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  maxAge: 600,
}));

/*───────────────────── Health ─────────────────────*/

app.get("/authz/health", c => c.json({
  ok: true,
  service: "opex-vbm-authz",
  environment: c.env.APP_ENV,
  tenantTarget: c.env.GEOTAB_DATABASE,
  serviceAccountConfigured: !!(
    c.env.GEOTAB_SERVICE_USERNAME &&
    c.env.GEOTAB_SERVICE_PASSWORD
  ),
}));

/*───────────────────── Verify Session ─────────────────────*/

app.post("/authz/verify", async c => {
  const body = await c.req.json().catch(() => null) as
    | null
    | { sessionId?: string; database?: string; server?: string; userName?: string };

  if (!body?.sessionId || !body?.database || !body?.server || !body?.userName) {
    return c.json({ ok: false, error: "MISSING_CREDENTIALS" }, 400);
  }

  const result = await verifyIdentity(body.sessionId, body.database, body.server, body.userName);

  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, 401);
  }

  return c.json({
    ok: true,
    principal: result.principal,
  });
});

/*───────────────────── Authorize ─────────────────────*/

app.post("/authz/authorize", async c => {
  const body = await c.req.json().catch(() => null) as
    | null
    | AuthorizationRequest;

  if (!body?.sessionId || !body?.database || !body?.server || !body?.userName || !body?.action) {
    return c.json({ authorized: false, error: "MISSING_REQUEST_FIELDS", reason: "BAD_REQUEST" }, 400);
  }

  const result = await handleAuthorize(c.env, body);

  if (!result.authorized) {
    return c.json(result, 403);
  }

  return c.json(result, 200);
});

/*───────────────────── Execute (Server-Mediated AddInData Write) ─────────────────────*/

app.post("/authz/execute", async c => {
  const body = await c.req.json().catch(() => null) as
    | null
    | ExecutionRequest;

  if (!body?.sessionId || !body?.database || !body?.server || !body?.userName || !body?.action || !body?.bookingId) {
    return c.json({ success: false, error: "MISSING_REQUEST_FIELDS", reason: "BAD_REQUEST" }, 400);
  }

  const serviceSession = new ServiceAccountSession(c.env);

  try {
    const result = await handleExecute(c.env, serviceSession, c.env.GEOTAB_DATABASE, body);

    if (!result.success) {
      return c.json(result, 403);
    }

    return c.json(result, 200);
  } catch (e) {
    return c.json({
      success: false,
      error: e instanceof Error ? e.message : "EXECUTION_FAILED",
      reason: "SERVER_ERROR",
    }, 500);
  }
});

app.notFound(c => c.json({ error: "NOT_FOUND" }, 404));

app.onError((err, c) => {
  return c.json({
    error: "INTERNAL_ERROR",
    message: c.env.APP_ENV === "development" ? err.message : "Unexpected error",
  }, 500);
});

export default app;
