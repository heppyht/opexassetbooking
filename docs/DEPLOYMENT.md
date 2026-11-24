# Deployment guide — OPEX Asset Booking (AddInData-native)

**Status:** preparation only. No cloud resource has been created, nothing is deployed, no Add-In has been registered, and no secrets have been configured. Every step below is a manual step for you to run.

**Scope:** a single-person test environment targeting the `opex_trial` MyGeotab database. No company domains and no custom domains are used. A company/production deployment is a separate, later decision.

## 1. Architecture

```text
MyGeotab (database: opex_trial)            Browser
    ├── Custom Page Add-In                  └── https://heppyh.github.io/opexassetbooking/
    │    (registered in opex_trial)            │   (GitHub Pages, static React app)
    │    URL: same as above                    │   CORS: https://heppyh.github.io
    │                                          ▼
    ├── Service Add-In                https://opex-vbm-api.<account-subdomain>.workers.dev
    │    (registered in opex_trial)             Cloudflare Worker "opex-vbm-api" (Hono)
    │    URL: .../serviceAddin.js               ├── POST /authz/verify    (verify session)
    │                                             ├── POST /authz/authorize (RBAC check)
    │                                             ├── POST /authz/execute   (server-mediated AddInData write)
    │                                             └── GET  /authz/health  (health check)
    └── AddInData (primary persistence)          All AddInData writes use service account
        booking / notification / audit records   after server-side authorization
        No PostgreSQL, no Hyperdrive, no Neon.
```

## 2. Names and URLs

| Item | Value | Where it is configured |
|---|---|---|
| GitHub account / repo | `HeppyH` / `opexassetbooking` | GitHub |
| Frontend URL | `https://heppyh.github.io/opexassetbooking/` | Vite `base` in `apps/web/vite.config.ts` (`base: "./"`) |
| Service Add-In JS URL | `https://heppyh.github.io/opexassetbooking/serviceAddin.js` | `geotab/opex-vbm-service-config.json` |
| CORS origin | `https://heppyh.github.io` (origin only: no path, no trailing slash, lowercase) | `ALLOWED_ORIGIN` in `apps/api/wrangler.toml` |
| Worker | `opex-vbm-api` | `name` in `apps/api/wrangler.toml` |
| API URL | `https://opex-vbm-api.<account-subdomain>.workers.dev` | GitHub Actions variable `VITE_API_BASE_URL` |
| MyGeotab database | `opex_trial` (unchanged) | `GEOTAB_DATABASE` in `apps/api/wrangler.toml` |
| Custom Page Add-In config | `geotab/opex-vbm-config.json` | Committed configuration |
| Service Add-In config | `geotab/opex-vbm-service-config.json` | Committed configuration |

**Add-In URL character check:** `https://heppyh.github.io/opexassetbooking/` and `https://heppyh.github.io/opexassetbooking/serviceAddin.js` contain no hyphen (`-`), no at sign (`@`), and no hash (`#`) anywhere. They satisfy Geotab's requirement that externally hosted Add-In URLs must not include those characters. Standalone GitHub Pages use and MyGeotab Add-In loading are both unaffected by this rule. Verified against https://developers.geotab.com/myGeotab/addIns/developingAddIns/.

`<account-subdomain>` is your Cloudflare account's workers.dev subdomain. It is shown in the Cloudflare dashboard under Workers & Pages once the subdomain has been registered. It is a placeholder until then; do not invent it.

## 3. Configuration files

| File | Purpose | Secrets? |
|---|---|---|
| `apps/api/wrangler.toml` | Worker name, `workers_dev`, vars (`APP_ENV`, `ALLOWED_ORIGIN`, `GEOTAB_DATABASE`) | None |
| `apps/api/.dev.vars.example` | Template for local `apps/api/.dev.vars` (git-ignored) | Placeholders only |
| `.github/workflows/deploy-pages.yml` | Builds and publishes the frontend; reads `vars.VITE_API_BASE_URL` | None |
| `geotab/opex-vbm-config.json` | Custom Page Add-In configuration | None |
| `geotab/opex-vbm-service-config.json` | Service Add-In configuration | None |

## 4. Environment and secrets

| Variable | Deployed Worker | Local (`.dev.vars`) | Secret? | How set |
|---|---|---|---|---|
| `APP_ENV` | `production` | `development` | No | `wrangler.toml` `[vars]` |
| `ALLOWED_ORIGIN` | `https://heppyh.github.io` | `http://localhost:5173` | No | `wrangler.toml` `[vars]` |
| `GEOTAB_DATABASE` | `opex_trial` | `opex_trial` | No | `wrangler.toml` `[vars]` |
| `GEOTAB_SERVICE_USERNAME` | Required | Required | Yes | `wrangler secret put` |
| `GEOTAB_SERVICE_PASSWORD` | Required | Required | Yes | `wrangler secret put` |
| `GEOTAB_SERVICE_SERVER` | Optional (defaults `my.geotab.com`) | Optional | Yes | `wrangler secret put` |

Rules:

- Service account credentials (`GEOTAB_SERVICE_USERNAME`, `GEOTAB_SERVICE_PASSWORD`, `GEOTAB_SERVICE_SERVER`) MUST be set via `wrangler secret put`. They must never appear in `wrangler.toml`, `.dev.vars`, `.env`, git, chat, commits, issues, logs, or screenshots.
- `.gitignore` already excludes `.dev.vars`, `.env` and `.env.*` (except `.env.example`).
- The frontend bundle is public. It must never contain a database URL, password, token or MyGeotab credential.
- Session IDs are bearer credentials. They travel to the Worker over HTTPS only and must never be logged, stored or echoed.

## 5. Cloudflare Worker deployment (manual)

Prerequisites: a Cloudflare account, Node.js 22, and `npx wrangler login` (an interactive browser login on your own machine).

1. Set the four service account secrets on the Worker (never in files):
   ```bash
   cd apps/api
   npx wrangler secret put GEOTAB_SERVICE_USERNAME
   npx wrangler secret put GEOTAB_SERVICE_PASSWORD
   npx wrangler secret put GEOTAB_SERVICE_SERVER
   ```
   `AUTHZ_JWT_SECRET` is not used by the current Worker code and is intentionally omitted.

2. Deploy from `apps/api`:
   ```bash
   cd apps/api
   npx wrangler deploy
   ```

3. Note the printed URL, `https://opex-vbm-api.<account-subdomain>.workers.dev`. If the account has no workers.dev subdomain yet, Cloudflare asks you to register one; it is part of the URL and cannot be guessed.

4. Verify:
   ```bash
   curl -s https://opex-vbm-api.<account-subdomain>.workers.dev/authz/health
   ```
   Expected: `"ok":true`, `"service":"opex-vbm-authz"`, `"tenantTarget":"opex_trial"`, `"serviceAccountConfigured":true` (after secrets are set).

Local development: `cd apps/api && npx wrangler dev --port 8787`. `wrangler dev` uses local `.dev.vars` (from `.dev.vars.example` template). Never run `wrangler dev --remote` against a database you care about.

## 6. Frontend on GitHub Pages (manual)

GitHub Pages must already be set to **Source: GitHub Actions** (see `docs/GITHUB_PAGES.md`).

1. After the Worker answers `/authz/health`, add the repository **variable** (not a secret): Settings → Secrets and variables → Actions → Variables → `VITE_API_BASE_URL` = `https://opex-vbm-api.<account-subdomain>.workers.dev` (no trailing slash).
2. Re-run the workflow "Deploy web to GitHub Pages" (or push to `main`). The build embeds the value; with the variable unset the UI keeps showing "Backend not connected".
3. Open `https://heppyh.github.io/opexassetbooking/`. Expect the status card to show the API as connected.

## 7. MyGeotab Add-In registration (requires tenant administrator)

Registering the Add-In in `opex_trial` needs a tenant administrator and is a separate manual step. Do not create or modify live tenant records during this assessment.

### Custom Page Add-In

Using `geotab/opex-vbm-config.json`:
- `name`: "OPEX Asset Booking Management"
- `supportEmail`: "heppy@opexcg.com"
- `version`: "0.1.0"
- `items[0].url`: `https://heppyh.github.io/opexassetbooking/`
- `items[0].path`: `ActivityLink`
- `items[0].menuName.en`: "OPEX Asset Booking"
- `items[0].category`: `AddIns`

Navigate to Administration → System → System Settings → Add-Ins. Select New Add-In and paste the configuration. Select Save, then refresh the page.

### Service Add-In

Using `geotab/opex-vbm-service-config.json`:
- `name`: "OPEX Asset Booking – Notification Service"
- `supportEmail`: "heppy@opexcg.com"
- `version`: "0.1.0"
- `items[0].serviceName`: "OPEX Notification Service"
- `items[0].serviceSrc`: `https://heppyh.github.io/opexassetbooking/serviceAddin.js`

Register through the same Add-Ins system settings page.

### URL character verification

Both Add-In URLs were verified character by character against Geotab's rule that externally hosted Add-In URLs must not contain `-`, `@`, or `#`:
- `https://heppyh.github.io/opexassetbooking/` — contains none of these characters.
- `https://heppyh.github.io/opexassetbooking/serviceAddin.js` — contains none of these characters.

No URL change is required.

## 8. Tenant connection and validation

The target MyGeotab database is `opex_trial`. Live tenant validation must be performed against `opex_trial` using test users (Admin, Approver, Standard, Driver) and disposable test data only. Do not create or modify production records.

Validation scenarios:
- Session verification via `/authz/verify` with real MyGeotab sessions
- Role resolution from MyGeotab security clearances
- Booking creation, approval, assignment, completion, cancellation via `/authz/execute`
- Optimistic locking on concurrent updates
- Audit record creation and tamper detection
- Notification delivery via Service Add-In
- Direct AddInData bypass confirmation (documented residual risk — see SECURITY_THREAT_MODEL.md)

## 9. Verification checklist (after you run the manual steps)

- [ ] Cloudflare Worker `opex-vbm-api` is deployed and reachable
- [ ] Four service account secrets are set via `wrangler secret put`
- [ ] `GET /authz/health` returns `ok: true`, `serviceAccountConfigured: true`
- [ ] GitHub Pages frontend is deployed at `https://heppyh.github.io/opexassetbooking/`
- [ ] `VITE_API_BASE_URL` variable is set in GitHub Actions
- [ ] Custom Page Add-In is registered in `opex_trial` (requires tenant admin)
- [ ] Service Add-In is registered in `opex_trial` (requires tenant admin)
- [ ] Add-In URLs contain no `-`, `@`, or `#` (verified above)
- [ ] No secret appears in `git diff`, the Pages bundle, Worker logs, or Actions logs
- [ ] Live tenant validation performed against `opex_trial` with test users

## 10. Rollback

- **Frontend:** re-run an earlier successful "Deploy web to GitHub Pages" workflow run, or revert the commit and push.
- **Worker:** `npx wrangler rollback` returns to the previous Worker version; `npx wrangler deployments list` shows versions. To take the API offline, delete the Worker from the dashboard.
- **Add-In:** remove the Add-In from `opex_trial` System Settings, or point its URL at the last known-good version.
- **Secrets:** rotate service account credentials via `wrangler secret put` if compromised; no data store reset is needed since AddInData is the persistence layer.

## 11. Sources

- Geotab: [Developing Add-Ins](https://developers.geotab.com/myGeotab/addIns/developingAddIns/), [AddInData Storage API](https://developers.geotab.com/myGeotab/addIns/addInStorage/), [Working with Rate Limits](https://developers.geotab.com/myGeotab/guides/rateLimits)
- Cloudflare: [Wrangler secrets](https://developers.cloudflare.com/workers/wrangler/commands/#secret), [Workers deploy](https://developers.cloudflare.com/workers/wrangler/commands/#deploy)
- GitHub: [GitHub Pages](https://docs.github.com/pages)
