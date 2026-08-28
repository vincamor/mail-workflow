# CLAUDE.md — Mail Workflow

Guidance for AI coding assistants and contributors. Keep it accurate; prune it when it drifts.

## What this is

A privacy-first web app to analyze and visualize Gmail/Outlook conversations.
Architecture: **Express.js** backend (stateless OAuth proxy, no database) + **vanilla JS** front-end (ES modules) + **local storage** (File System Access API + IndexedDB). Emails live only in a local folder the user picks. A multi-provider AI proxy (`/api/ai/*`) powers cleanup and per-subject chat.

## Commands

```bash
npm ci            # install (reproducible)
npm start         # node src/app.js -> http://localhost:3000
npm test          # Jest (backend + front-end ESM via --experimental-vm-modules)
```

- Configure `.env` from `.env.example` before starting (OAuth credentials, `SESSION_SECRET`).
- Redis is optional: sessions are in-memory when `REDIS_URL` is unset.
- After changing backend files (`src/services/`, `src/app.js`), restart the server.
- After changing front-end files (`src/public/`), a hard refresh (Ctrl+Shift+R) is enough.
- **No build step** — the front-end is served as-is (no bundler/transpiler).

## Project rules

1. **Preserve existing HTML IDs** (`#subjectsList`, `#treeVisualization`, …) and DOM structure — adding is fine, removing is not.
2. **Do not break the `{nodes, links}` shape** produced by `emailAnalyzer_browser.js`.
3. **Colors via CSS variables only** — no hardcoded colors in CSS or JS, so themes apply everywhere.
4. **Keep `npm test` green** before every commit.

## Tree rendering invariants (do NOT break)

Before touching `treeRenderer.js` or `tree-visualization.css`, read this. These are **structural**, not cosmetic — breaking them misaligns arrows and fragments the trunk.

1. **Uniform node height** — `nodeHeightFor()` returns one constant for every node. Horizontal variance (`nodeWidthFor`) is fine; **vertical variance is forbidden** (arrow anchors are `cy = node.y + h/2`; if `h` varies within a lane, arrows step).
2. **Root is distinguished by its border/width, not its height** (`.node.root` stroke).
3. **Trunk = longest-path-from-root** from `nodes[0]` (`longestPath` in `calculateYLevels`) — not a participant sort, not pure chronology.
4. **Branches alternate ±1, ±2** per participant group, sorted by size.
5. **Auto-fit** never scales a small tree above natural size (`MAX_FIT_SCALE = 1`).

Any visual change that seems to need per-node height variance must instead use **width**, **border**, **glow**, or **type** — never `nodeHeightFor`.

## Security notes (keep these intact)

- **`/api/ai/*` requires an authenticated session, is rate-limited, and validates `baseUrl`** (blocks private/loopback/link-local/metadata IPs incl. IPv6-mapped, and refuses redirects) to prevent SSRF. The user's AI key is never logged or persisted server-side.
- **OAuth** uses a `state` parameter (checked in callbacks) and `session.regenerate()` after login; `POST /auth/logout` destroys the session.
- The **email body iframe is `sandbox` WITHOUT `allow-scripts`** — this is the critical XSS guard. Never add `allow-scripts`; the regex sanitizer alone is not sufficient.
- Never commit `.env`. Rotate any credential that has touched disk before publishing.

## Architecture map

```
src/
  app.js                          Express entry: helmet, CORS (APP_ORIGIN), sessions, static, routes
  config/oauth.js                 OAuth env
  middleware/authMiddleware.js    requireAuth
  routes/                         gmail.js · outlook.js · ai.js  (rate-limiters)
  services/
    emailUtils.js                 shared: SSE streaming, filtering, auto-exclusion
    emailAnalyzer_browser.js      client-side analysis (ES module) -> {nodes, links}
    gmailService.js · outlookService.js
    aiService.js                  multi-provider request building + anti-SSRF baseUrl validation
    quoteStripper.js              quoted-text stripping (shared front/back)
  public/
    index.html
    tree-visualization.css        tree styles (100% CSS variables)
    js/                           app, treeRenderer, themeManager, analysis, emails, auth,
                                  folders, folderResolver, storage, groups, groupContextMenu,
                                  email-detail, reply, filterUI, panels, ui, aiChat*, aiFilter*
    styles/                       base/variables.css (tokens) + layout + components
tests/
  backend/                        gmailService, outlookService, emailUtils, aiService,
                                  quoteStripper, aiFilterPrompts
  frontend/                       progressiveLoading, aiChat, aiChatStore, folderResolver, demoMode
scripts/                          setup.js · doctor.js · demo.js · generate-demo-data.js
docs/
  README.md                       documentation index, grouped by audience
  setup/                          OAuth provider guides (google-cloud, azure-ad)
  guides/                         deployment.md · data-format.md   (user-facing)
  internal/                       architecture.md · filesystem-handles.md ·
                                  outlook-implementation.md        (contributor-facing)
  design/                         attachments-research.md
  specs/                          2026-08-25-oss-repo-design.md
ROADMAP.md                        decided / considered / known defects (repo root)
```

### Front-end wiring

Modules avoid `window.*` globals: cross-module coupling uses callback injection
(`setNodeClickHandler`, `setSelectSubjectHandler`, `setOnFiltersSaved`) and a small
pub/sub (`onSubjectSelected`). The data folder is resolved tolerantly by
`folderResolver.js` (accepts the root, the `EmailWorkflow` folder, or the account
folder directly), used by every reader/writer so they agree on one folder.

## Conventions

- **English everywhere** — UI copy, code comments, log messages, docs. See
  [docs/internal/glossary.md](docs/internal/glossary.md) for the binding terminology
  (notably `sujet` → **subject**, never _thread_) and for the three categories of
  French string that are deliberately kept: AI-prompt JSON keys
  (`exclure`/`garder`/`incertain`), the marketing-email detection regexes in
  `aiFilter.js`, and the French Gmail quote patterns in `email-detail.js`. Those match
  real user data or an internal protocol — translating them breaks behaviour.
- Small, focused commits; conventional-commit style (`fix(tree): …`).
- ES modules front-end, CommonJS backend. Front-end tests load ESM via dynamic `import()` and require `npm test` (not `npx jest`) for the `--experimental-vm-modules` flag.
