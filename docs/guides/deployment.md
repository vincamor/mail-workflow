# Self-hosting

**Who this is for:** anyone who wants to host Mail Workflow somewhere other than
their own laptop.

Deployment is **optional, and it is yours to run**. Mail Workflow is meant to be
cloned and run by each person on their own machine; this repository does not
deploy anywhere and ships no deployment job. Emails never leave the machine that
downloads them either way — the server is only an OAuth proxy. Hosting it buys
you a stable HTTPS origin and a URL you can open from any of your own devices.

The examples below use Railway because it is the smallest amount of setup, but
nothing here is Railway-specific: the app is a plain Node process started with
`npm start`, so any host that runs Node 20+ works the same way.

---

## 1. Put the app on a host

Pick either approach — you do not need both.

**Option A — connect the repository (deploys on every push)**

1. Fork or push your copy to your own GitHub repository.
2. On https://railway.app: **New Project → Deploy from GitHub repo**, and pick
   that repository.
3. Railway builds it and re-deploys on each push. Nothing is configured on the
   GitHub side: no secret, no token, no workflow.

**Option B — deploy from your machine**

```bash
npm i -g @railway/cli
railway login
railway up
```

Useful when you would rather not connect a repository at all.

> Do **not** add a `RAILWAY_TOKEN` secret to a GitHub Actions workflow unless you
> have written that workflow yourself. This repository's CI only runs tests and
> lint — it has no deploy step to feed a token to.

## 2. Configure the app (runtime variables)

In **Railway → your service → Variables** (or your host's equivalent), set the
variables the app needs at runtime:

| Variable                                                               | Role                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SESSION_SECRET`                                                       | Required outside development — the app refuses to start without it when `NODE_ENV=production`                            |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REDIRECT_URI`       | Gmail OAuth                                                                                                              |
| `OUTLOOK_CLIENT_ID` / `OUTLOOK_CLIENT_SECRET` / `OUTLOOK_REDIRECT_URI` | Outlook OAuth                                                                                                            |
| `OUTLOOK_TENANT_ID`                                                    | `common` for personal + multi-tenant accounts, or your tenant GUID for a single-tenant Entra registration                |
| `APP_ORIGIN`                                                           | Public origin of the app (e.g. `https://<project>.up.railway.app`), used for CORS                                        |
| `REDIS_URL`                                                            | Provided automatically if you add the Railway Redis plugin. Without it, sessions are in-memory and lost on every restart |
| `ALLOW_LOCAL_AI`                                                       | `true` only if you point the AI proxy at a local Ollama — pointless in production, and it relaxes the anti-SSRF guard    |
| `PORT`                                                                 | Set by the host automatically — do not set it yourself                                                                   |

See [`.env.example`](../../.env.example) for the full list and the inline notes
on each variable.

Generate a strong session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 3. Update the OAuth redirect URIs

Go back to the provider consoles (Google Cloud Console, Azure portal) and add the
deployed URLs, keeping them **byte-identical** to `GMAIL_REDIRECT_URI` and
`OUTLOOK_REDIRECT_URI`:

```
https://<your-domain>/gmail/callback
https://<your-domain>/outlook/callback
```

A mismatch here is the single most common cause of a failed sign-in. See
[`docs/setup/google-cloud.md`](../setup/google-cloud.md) and
[`docs/setup/azure-ad.md`](../setup/azure-ad.md).

## 4. Verify

`npm run doctor` checks the consistency between `PORT`, `APP_ORIGIN` and the
redirect URIs, and tells you exactly which value to change when they disagree.
Run it against the same environment the server sees.

The app also exposes `GET /health`, which returns `{"status":"ok"}` — useful as
a host health check.

---

## What deployment does not change

- **The browser requirement stays.** The app needs the File System Access API,
  so a deployed instance is still Chrome/Edge-only for real use. (`?demo=1`
  works everywhere — see [the demo mode notes](../internal/architecture.md#15-demo-mode).)
- **The server still stores nothing.** No database is provisioned or needed; the
  only server-side state is the session, in Redis or in memory.
- **Your emails still land on your own disk**, in the local folder you pick from
  the browser. Hosting the server does not move them anywhere.
- **Docker is an explicit non-goal** — see
  [the release design spec](../specs/2026-08-25-oss-repo-design.md), section 2.
