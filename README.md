# Vi-SOCEX — Visual & Social Content Exchange

Multi-tenant marketing + CRM platform for the vi-tech suite.
Live: https://vi-socex.netlify.app (landing) · https://vi-socex.netlify.app/app (app)
Netlify site ID: `2020deec-311d-4d09-94e1-fdbaef4e7e1c`

## Structure
| Path | What it is |
|---|---|
| `index.html` | Public landing page |
| `app/index.html` | The whole app — single-file React (Babel in-browser) |
| `survey/index.html` | Public questionnaire page (no login) |
| `netlify/functions/` | Backend (Netlify Functions v2 + Netlify Blobs storage) |
| `netlify.toml` | Publish root + functions directory |

## Backend endpoints
| Function | Route | Purpose |
|---|---|---|
| `auth.mts` | `/api/auth` | Login/logout/me, team invites, profile, list-members, password reset |
| `data.mts` | `/api/data` | Tenant-scoped key/value data store (see *Multi-user sync* below) |
| `generate.mts` | `/api/generate` | AI generation (posts, articles, ad copy, brand/company/case-study extraction, questionnaires, overviews, vision) |
| `market-report-background.mts` | `/api/market-report-background` | Long-running web-researched market reports (background function) |
| `report-status.mts` | `/api/report-status` | Polling for market report jobs |
| `send-email.mts` | `/api/send-email` | Questionnaire email distribution via Resend |
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
- `ADMIN_SEED_SECRET` — protects the admin-only `seed` / `admin-delete-user` auth actions
- Anthropic access is injected automatically by Netlify's AI Gateway (no key needed)

## Multi-user sync (important)
Several people edit the same tenant data at once. `data.mts` uses **strong consistency** and stamps a
**version** in each blob's metadata. The browser sends `X-Base-Version` with every save; if a teammate
saved in between, the server returns **409 + the current value** and the browser performs a
**three-way merge** (`__merge3` in `app/index.html`) so both people's changes survive. Open tabs poll
`GET /api/data?versions=1` every 20 s (and on focus) and pull in changed sections. Saves without the
header (old open tabs) are still accepted for backward compatibility.

## Deploying
Deployed directly to the Netlify site above (no build step). From the repo root with the Netlify CLI:
`netlify deploy --prod --site 2020deec-311d-4d09-94e1-fdbaef4e7e1c`
Previous deploys remain available for instant rollback in the Netlify dashboard → Deploys.
