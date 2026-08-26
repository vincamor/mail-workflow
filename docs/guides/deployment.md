# Deploying to Railway

**Who this is for:** anyone who wants to host Mail Workflow somewhere other than
their own laptop.

Deployment is **optional**. Mail Workflow is designed to run locally, and the
emails never leave the machine that downloads them either way — the server is
only an OAuth proxy. Hosting it buys you a stable HTTPS origin and a URL you can
open from any of your own machines.

`.github/workflows/ci.yml` contains a `deploy` job that pushes to Railway
**on every push to `main`**, after the `test` and `lint` jobs pass. The job stays
inert — it prints a GitHub warning and deploys nothing — until the
`RAILWAY_TOKEN` secret exists, so nothing breaks before you configure it.

Two places that are easy to confuse:

- **GitHub Actions secrets/variables** — used by the *deployment* (authenticating
  to Railway).
- **Railway variables** — used by the *running app* (`SESSION_SECRET`, OAuth
  credentials, `REDIS_URL`, `APP_ORIGIN`, `ALLOW_LOCAL_AI`, …). These go on the
  Railway side, never in GitHub.

---

## 1. Get a Railway token

1. Go to https://railway.app and open **your project**.
2. **Settings → Tokens** — a *project* token is recommended, since it is scoped
   to that project alone.
   - Alternative: an account token from https://railway.app/account/tokens.
3. Click **Create Token**, name it (e.g. `github-actions`), and **copy the
   value** — it is shown only once.

## 2. Add the token to GitHub as a secret

1. In the GitHub repository: **Settings → Secrets and variables → Actions**.
2. **Secrets** tab → **New repository secret**.
3. Name: `RAILWAY_TOKEN`
4. Secret: *(paste the token from step 1)*
5. **Add secret**.

## 3. (Optional) Target a specific service

Only useful if your Railway project has **several services**.

1. Same page → **Variables** tab → **New repository variable**.
2. Name: `RAILWAY_SERVICE`
3. Value: the exact service name as displayed in Railway.
4. **Add variable**.

If you set nothing, the workflow runs `railway up --detach` and Railway deploys
the project's default service.

## 4. Configure the app on the Railway side (runtime variables)

In **Railway → your service → Variables**, add the variables the app needs at
runtime (these do **not** go in GitHub):

| Variable | Role |
|---|---|
| `SESSION_SECRET` | Required outside development — the app refuses to start without it when `NODE_ENV=production` |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REDIRECT_URI` | Gmail OAuth |
| `OUTLOOK_CLIENT_ID` / `OUTLOOK_CLIENT_SECRET` / `OUTLOOK_REDIRECT_URI` | Outlook OAuth |
| `OUTLOOK_TENANT_ID` | `common` for personal + multi-tenant accounts, or your tenant GUID for a single-tenant Entra registration |
| `APP_ORIGIN` | Public origin of the app (e.g. `https://<project>.up.railway.app`), used for CORS |
| `REDIS_URL` | Provided automatically if you add the Railway Redis plugin. Without it, sessions are in-memory and are lost on every restart |
| `ALLOW_LOCAL_AI` | `true` only if you point the AI proxy at a local Ollama — pointless in production, and it relaxes the anti-SSRF guard |
| `PORT` | Managed by Railway automatically — do not set it |

See `.env.example` for the full list and the inline notes on each variable.

Remember to update the **OAuth redirect URIs** on the provider side (Google Cloud
Console / Azure portal) with the Railway URL, and to keep them byte-identical to
`GMAIL_REDIRECT_URI` and `OUTLOOK_REDIRECT_URI`. A mismatch here is the single
most common cause of a failed sign-in. `npm run doctor` checks that consistency
for you.

## 5. Trigger and verify

1. Merge or push to **`main`**. On a `feature/*` branch the deploy job is
   deliberately skipped (`if: github.ref == 'refs/heads/main'`).
2. GitHub → **Actions** tab → open the run → **Deploy to Railway** job.
3. If something goes wrong: check that `RAILWAY_TOKEN` is present (the job emits
   a warning when it is missing) and that the Railway service starts with
   `npm start`.

---

## What deployment does not change

- **The browser requirement stays.** The app needs the File System Access API,
  so a deployed instance is still Chrome/Edge-only for real use. (`?demo=1`
  works everywhere — see [the demo mode notes](../internal/architecture.md#15-demo-mode).)
- **The server still stores nothing.** No database is provisioned or needed; the
  only server-side state is the session, in Redis or in memory.
- **Docker is an explicit non-goal** — see
  [the release design spec](../specs/2026-08-25-oss-repo-design.md), section 2.
