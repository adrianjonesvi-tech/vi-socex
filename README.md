# Vi-SOCEX — Visual & Social Content Exchange

Multi-tenant marketing + CRM platform for the vi-tech suite.
Live: https://vi-socex.netlify.app (landing) · https://vi-socex.netlify.app/app (app)
Netlify site ID: `2020deec-311d-4d09-94e1-fdbaef4e7e1c`

## Structure
| Path | What it is |
|---|---|
| `public/index.html` | Public landing page |
| `public/app/index.html` | The whole app — single-file React (Babel in-browser) |
| `public/survey/index.html` | Public questionnaire page (no login) |
| `netlify/functions/` | Backend (Netlify Functions v2 + Netlify Blobs storage) |
| `netlify.toml` | Publish dir (`public/` only) + functions directory |

Only `public/` is published as static files. Everything else (function source, `package.json`,
this README) stays out of the deploy so it can't be downloaded.

## Backend endpoints
| Function | Route | Purpose |
|---|---|---|
| `auth.mts` | `/api/auth` | Login/logout/me, team invites, profile, list-members, password reset |
| `data.mts` | `/api/data` | Tenant-scoped key/value data store (see *Multi-user sync* below) |
| `generate.mts` | `/api/generate` | AI generation (posts, articles, ad copy, brand/company/case-study extraction, questionnaires, overviews, vision) |
| `market-report-background.mts` | `/api/market-report-background` | Long-running web-researched market reports (background function) |
| `report-status.mts` | `/api/report-status` | Polling for market report jobs |
| `send-email.mts` | `/api/send-email` | Queues a marketing email send (drops invalid, duplicate and unsubscribed/suppressed addresses) |
| `send-email-background.mts` | `/api/send-email-background` | Sends a queued job via Resend's batch API with a per-recipient unsubscribe link (background function) |
| `send-status.mts` | `/api/send-status` | Polling for send jobs |
| `unsubscribe.mts` | `/api/unsubscribe` | Public unsubscribe page + one-click unsubscribe (signed links, no login) |
| `suppressions.mts` | `/api/suppressions` | Workspace's unsubscribe list for the app; DELETE re-subscribes one address |
| `public-survey.mts` | `/api/public-survey` | Public survey load/submit |
| `assets.mts` | `/api/assets` | Binary file storage (≈4.5 MB per file limit) |
| `scan-website.mts` | `/api/scan-website` | Website text/colour scan |
| `rss.mts` | `/api/rss` | RSS feed reader |

## Environment variables (set in Netlify → Site configuration → Environment variables)
Never commit these values.
- `RESEND_KEY` — Resend API key (named this way to avoid Netlify's sensitive-value detection loop)
- `RESEND_FROM_EMAIL` — survey sender, e.g. `surveys@vi-tech.io`
- `RESEND_AUTH_FROM_EMAIL` — optional; invite/reset sender (defaults to `info@<same domain>`)
- `RESEND_FROM_NAME` — optional display name
- `ADMIN_SEED_SECRET` — protects the admin-only `seed` / `admin-delete-user` auth actions (marked secret,
  functions scope only). `seed` only creates new logins; it refuses (409) if the email already has one.
- Anthropic access is injected automatically by Netlify's AI Gateway (no key needed)

## Multi-user sync (important)
Several people edit the same tenant data at once. `data.mts` uses **strong consistency** and stamps a
**version** in each blob's metadata. The browser sends `X-Base-Version` with every save; if a teammate
saved in between, the server returns **409 + the current value** and the browser performs a
**three-way merge** (`__merge3` in `app/index.html`) so both people's changes survive. Open tabs poll
`GET /api/data?versions=1` every 20 s (and on focus) and pull in changed sections. Saves without the
header (old open tabs) are still accepted for backward compatibility.

## Marketing email and unsubscribes
Every send goes through `send-email` → `send-email-background`. Each email gets an unsubscribe link and
`List-Unsubscribe` / one-click headers. Unsubscribes are stored in the `visocex-suppressions` store
(`<tenantId>/<encoded email>`), not in the contacts list, so the server never overwrites a teammate's
save; every send checks that store plus contacts whose status is Unsubscribed/Suppressed/Not eligible,
whichever audience was picked. Open tabs pull the list and mark matching contacts Unsubscribed through
the normal merge path. Send jobs (`visocex-send-jobs`) hold the per-job secret that signs unsubscribe
links, so don't delete them — old emails' links stop working without them.

### Who emails come from (per workspace)
All email goes through the site's one Resend account (`RESEND_KEY`, which must be a **full-access** key so
the app can add and check domains). Each workspace sends from its own name and address on its own
domain, set up by a workspace **admin** (`isAdmin: true` on the login record in `visocex-tenants`) under
Company Info → Email sender (`email-sender.mts`): save name/address → "Set up <domain>" adds it to
Resend (region eu-west-1) → add the DNS records shown → "Check again". Stores: `visocex-email-senders`
(`<tenantId>` → name, address) and `visocex-email-domains` (`<domain>` → owning tenantId). A domain
belongs to one workspace; one already in Resend can only be linked by an admin whose login is on it.
`send-email` refuses until the workspace's sender is complete, owned and verified. Admins are set
directly on the login records; there's no admin-management screen yet.

## Backups
`backup-daily.mts` (scheduled, 00:00 UTC, logic in `netlify/lib/backup.mts`) copies `visocex-data`,
`visocex-tenants`, `visocex-report-jobs`, `visocex-suppressions`, `visocex-email-senders` and
`visocex-email-domains` into the `visocex-backups` store under
`daily/<YYYY-MM-DD>/<store>/<key>` (original metadata kept), writes `manifests/<date>`, copies uploaded
files once to `assets/<key>`, and keeps 30 days. Outcome: `status/last-run` and `status/last-success`
in that store, plus `[backup]` lines in the function log. Run on demand from Netlify → Logs → Functions
→ backup-daily → Run now. Optional env var `BACKUP_ALERT_EMAIL` emails on failure.
These backups live on the same Netlify site — keep periodic off-site copies too.

On-demand workspace snapshots (`snapshot.mts`, `/api/snapshot`, logic in `netlify/lib/snapshot.mts`):
`POST` copies every section of the caller's workspace to `snapshots/<tenantId>/<id>/<section>` in the
same backups store, reads each copy back to check it, then writes `snapshot-manifests/<tenantId>/<id>`
(no manifest = not a snapshot). `GET` lists the workspace's snapshots. Kept 30 days; past 50 recent
snapshots a new one is refused rather than pushing older ones out. Meant to be taken automatically
before an import or undo; restoring from one is part of the undo work.

## Deploying
Deployed directly to the Netlify site above (no build step). From the repo root with the Netlify CLI
(`netlify.toml` points it at `public/` and `netlify/functions/`):
`netlify deploy --prod --site 2020deec-311d-4d09-94e1-fdbaef4e7e1c`
Previous deploys remain available for instant rollback in the Netlify dashboard → Deploys.
