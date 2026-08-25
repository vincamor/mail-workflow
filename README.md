# Mail Workflow

**Analyze and visualize your email conversations — entirely on your own machine.**

Mail Workflow connects to Gmail or Outlook, downloads your mail **to a local folder you choose**, reconstructs each discussion as an interactive **conversation tree**, and lets a **local or remote AI** help you triage and understand it. No server ever stores your emails, and your AI provider key never leaves your setup except to reach the provider you configured.

> Privacy-first by design: a stateless OAuth proxy + client-side storage (File System Access API + IndexedDB). There is no database.

---

## Features

- **Gmail & Outlook** via OAuth2 (you bring your own OAuth app — see setup).
- **Local-only storage** — emails saved as JSONL in a folder you pick; nothing is kept server-side.
- **Conversation trees** — native SVG rendering (zero front-end dependencies): zoom, pan, auto-fit, timelines, per-participant avatars.
- **AI assistant (multi-provider)** — Ollama (local), OpenAI, Anthropic, or any OpenAI-compatible endpoint:
  - **"Faire le Ménage" (Clean-up)** — code pre-filter + two AI passes flag newsletters/spam and produce an interactive report (exclude / keep / unsure) you edit before applying.
  - **Chat per subject** — ask questions about a thread or draft a reply, with the thread injected as context.
- **Themes** — 5 switchable themes (dark chromatic + one light), persisted locally.

## Requirements

- **Node.js ≥ 20**
- **Chrome or Edge 86+** — the File System Access API is required (Firefox/Safari/mobile are not supported).
- **Your own OAuth apps**: a Google Cloud project (Gmail API) and/or an Azure app registration (Microsoft Graph). See [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md) and [docs/OUTLOOK_IMPLEMENTATION.md](docs/OUTLOOK_IMPLEMENTATION.md).
- *(Optional)* Redis for persistent sessions; in-memory sessions are used if `REDIS_URL` is unset.

## Quick start

```bash
git clone <your-fork-url> mail-workflow
cd mail-workflow
npm ci
cp .env.example .env      # then fill in your OAuth credentials
npm start                 # http://localhost:3000
```

Then in the browser: connect Gmail/Outlook → pick a local folder → download → select a subject to see its tree.

### OAuth in short

Reading email uses Google *restricted* scopes. For **personal / self-hosted** use you don't need Google's public verification: create your own Google Cloud project, configure the OAuth consent screen in **Testing** mode, and add your own address as a **test user** (up to ~100). Set the redirect URIs to `http://localhost:3000/gmail/callback` and `http://localhost:3000/outlook/callback`. Fill the matching values in `.env`.

## Tests

```bash
npm test        # Jest — backend + front-end (ESM) suites
```

Continuous integration runs the full suite on Node 20 & 22 (see `.github/workflows/ci.yml`). There is **no build step** — the front-end is vanilla ES modules served statically.

## Deployment

Optional. A Railway deploy job is wired into the CI workflow (push to `main`, gated on a `RAILWAY_TOKEN` secret). See [docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md).

## Architecture (short)

```
src/
  app.js                 Express entry (stateless OAuth proxy, sessions in Redis or memory)
  routes/                gmail · outlook · ai
  services/              gmailService · outlookService · emailUtils · aiService · quoteStripper
  public/
    index.html
    js/                  ES modules (treeRenderer, analysis, emails, aiChat, themeManager, …)
    styles/              design tokens + components
tests/                   backend + frontend (Jest, --experimental-vm-modules for ESM)
docs/                    architecture & deployment notes
```

- **OAuth proxy** — the browser never talks to Google/Microsoft directly; tokens live only in the server session for the request's lifetime.
- **Client-side analysis** — JSONL is streamed and parsed in the browser; conversation topology (`{nodes, links}`) is built by `emailAnalyzer_browser.js`.
- **AI proxy** — `/api/ai/*` forwards to your configured provider with your key (never logged, never persisted). `baseUrl` is validated to block SSRF, and the routes require an authenticated session.

## Privacy

Your emails are stored **only** in the local folder you select. The server keeps no copy and no database. Your AI provider key is stored in your browser's `localStorage` and sent only to the provider you configured, through the proxy.

## Contributing

Issues and PRs welcome. Please keep the test suite green (`npm test`) and read `CLAUDE.md` for the project conventions and the tree-rendering invariants that must not be broken.

## License

MIT — see [LICENSE](LICENSE).
