# Architecture Decision Record — ADR-001

**Title:** Trusted Server-Side Authorization with AddInData as Primary Storage

**Status:** Proposed (branch `security/server-auth`)

**Date:** 2026-11-24

**Authors:** Kilo (software engineering agent)

## Context

The OPEX Asset Booking application was originally architected with a PostgreSQL database and Cloudflare Worker backend (Phase 1-3). Phase 3 migrated to native MyGeotab AddInData as the sole persistent storage, removing the external backend entirely.

Phase 5 identified a critical security gap: client-side RBAC (implemented in React) cannot prevent users from bypassing frontend authorization by directly calling AddInData methods from the browser console. MyGeotab documentation confirms that Default User clearance includes Add/Set/Get/Remove for AddInData objects — this is a platform-level permission that cannot be restricted per-Add-In through custom security identifiers.

Phase 6 implemented a trusted server-side authorization layer (Cloudflare Worker + Hono) that:
1. Verifies MyGeotab session IDs server-side
2. Resolves user roles from MyGeotab security clearances
3. Enforces authorization server-side for all protected booking operations
4. Performs AddInData writes using a service account (not the client)
5. Records the verified actor in audit history

## Decision

**Use a trusted authorization Worker as a server-side gate for all protected booking operations, while keeping AddInData as the primary application persistence layer.**

### Architecture

```
Client (React Add-In, GitHub Pages)
├── GET bookings → AddInData (direct read, no authz gate needed for reads)
├── Protected write (approve/reject/assign/complete/cancel/create)
│   └── POST /authz/execute → Cloudflare Worker (Hono)
│       ├─ Verify sessionId → MyGeotab Get User API
│       ├─ Check roles → MyGeotab User record
│       ├─ Enforce RBAC (server-side)
│       ├─ Write booking → AddInData (service account)
│       └─ Write audit → AddInData (service account)
```

### Alternatives Considered

| Alternative | Pros | Cons | Decision |
|---|---|---|---|
| Client-side RBAC only (Phase 5) | Simple, no backend | Bypassable via browser console | ❌ Rejected |
| Full PostgreSQL backend (Phase 3 architecture) | Full server-side control | Contradicts native-only design goal | ❌ Rejected |
| Trusted authorization Worker + AddInData | Server-side authz, AddInData storage | Direct AddInData bypass still possible | ✅ Selected |
| Service Add-In reconciliation | Detects/tamper-proofs direct writes | Additional infrastructure, future work | ⚠️ Recommended follow-up |
| OAuth2/OIDC federation | Standard identity protocol | MyGeotab Add-In doesn't support external IdP | ❌ Not supported |

## Consequences

### Positive
- Server-side authorization enforcement for all UI-initiated protected operations
- Verified actor attribution in audit records (not spoofed client IDs)
- AddInData remains the sole persistent storage (no PostgreSQL)
- Service account credentials managed as Cloudflare secrets (not in frontend)
- CORS restricted to frontend origin only

### Negative
- Direct AddInData writes from browser console cannot be prevented at platform level
- Additional infrastructure dependency (Cloudflare Worker)
- Service account session management (14-day expiry, auto-refresh)
- Client must be online to perform protected operations (no offline mode)

### Neutral
- Read operations remain client-direct for performance
- Demo mode unchanged (in-memory, no server dependency)

## Rationale

MyGeotab AddInData is a client-side storage API with no server-side authorization middleware. Custom security identifiers in `configuration.json` control Add-In menu visibility, not AddInData API permissions. The trusted authorization Worker is the best available approach within the constraints of the native-only architecture.

## Implementation Notes

- Service account must be configured in MyGeotab `opex_trial` with ManageAddInData clearance
- Service account credentials set via `wrangler secret put` (never in `.dev.vars` or code)
- `VITE_AUTHZ_API_BASE_URL` set in frontend environment
- All AddInData writes go through the service account; the client never writes protected operations directly

## Open Questions / Future Work

1. **Service Add-In validation:** A background Service Add-In could reconcile AddInData records and flag/remove unauthorized ones (direct client writes).
2. **Custom security identifiers:** Define `"securityIds": [{"name": "Manage OPEX Bookings", ...}]` in Add-In configuration for granular view control (does not affect AddInData API permissions).
3. **Session verification caching:** Cache verified sessions to reduce MyGeotab API calls (respect rate limits).
4. **Add-In URL character restriction:** The GitHub Pages URLs (`https://heppyh.github.io/opexassetbooking/` and `.../serviceAddin.js`) were verified character by character and contain no hyphen (`-`), at sign (`@`), or hash (`#`). They satisfy Geotab's requirement for externally hosted Add-In URLs (see DEPLOYMENT.md section 2).

## Related Documents

- SECURITY_PERMISSION_MATRIX.md — AddInData permission matrix
- SECURITY_THREAT_MODEL.md — Threat model with attack paths
- DEPLOYMENT.md — Deployment guide
- ARCHITECTURE.md — Original architecture notes
