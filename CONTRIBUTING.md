# Contributing to Mail Workflow

Thanks for taking the time to contribute. This guide covers everything you need to get a
local environment running, understand the project's structural rules, and open a PR that's
easy to review.

## Prerequisites

- **Node.js >= 20** (see `.nvmrc`; `nvm use` if you use nvm).
- **Chrome or Edge 86+** to actually run the app in a browser — it relies on the
  **File System Access API**, which Firefox and Safari do not implement. You can still edit
  and test backend code on any OS/browser; you just can't exercise the local-folder storage
  flow without Chromium.
- Your own OAuth apps (Google Cloud project for Gmail, Azure app registration for Outlook)
  if you want to test the OAuth flows end to end. Step-by-step guides:
  [`docs/setup/google-cloud.md`](docs/setup/google-cloud.md) and
  [`docs/setup/azure-ad.md`](docs/setup/azure-ad.md). `npm run setup` walks you
  through both interactively, and `npm run doctor` diagnoses a broken `.env`.

## Local setup

```bash
git clone https://github.com/vincamor/mail-workflow.git
cd mail-workflow
npm ci
cp .env.example .env      # fill in OAuth credentials, SESSION_SECRET, etc.
npm start                 # http://localhost:3000
```

Redis is optional — sessions are kept in-memory when `REDIS_URL` is unset, which is fine for
local development.

### Running tests

```bash
npm test
```

This project's front-end is plain ES modules with no bundler, and Jest's native ESM support
requires the `--experimental-vm-modules` Node flag. That flag is baked into the `test`
script in `package.json` — **always run `npm test`, not `npx jest`**, or the front-end suites
under `tests/frontend/` will fail to resolve `import`/`export` syntax. Backend suites
(`tests/backend/`) are plain CommonJS and would work under `npx jest` too, but keep using
`npm test` for consistency.

Keep the suite green before every commit; CI runs it on Node 20 and 22.

## Project layout

```
src/
  app.js                 Express entry: helmet, CORS, sessions, static, routes
  config/                OAuth env
  middleware/             requireAuth
  routes/                 gmail.js, outlook.js, ai.js (rate-limited)
  services/               gmailService, outlookService, emailUtils, aiService, quoteStripper,
                           emailAnalyzer_browser.js (client-side analysis -> {nodes, links})
  public/
    index.html
    js/                   ES modules: treeRenderer, themeManager, analysis, emails, auth,
                           folders, folderResolver, storage, groups, aiChat*, ...
    styles/                base/variables.css (design tokens) + layout + components
tests/
  backend/                 gmailService, outlookService, emailUtils, aiService,
                           quoteStripper, aiFilterPrompts
  frontend/                progressiveLoading, aiChat, aiChatStore, folderResolver,
                           demoMode
scripts/                   setup.js, doctor.js, demo.js, generate-demo-data.js
docs/
  setup/                   Google Cloud and Azure AD guides
  guides/                  deployment, on-disk data format
  internal/                architecture, filesystem handles, Outlook implementation
  design/                  design notes for work not yet built
  specs/                   decision records
```

See [`docs/README.md`](docs/README.md) for an index grouped by audience, and
[`docs/internal/architecture.md`](docs/internal/architecture.md) for the detailed
walkthrough.

The **backend is CommonJS** (`require`/`module.exports`), the **front-end is ES modules**
(`import`/`export`, loaded via `<script type="module">`). **There is no build step** — the
front-end under `src/public/` is served as-is by Express, with no bundler or transpiler in
the loop. After changing a backend file (`src/services/`, `src/app.js`, ...) you need to
restart the server (`npm start`); after changing a front-end file (`src/public/`), a hard
refresh (Ctrl+Shift+R) is enough.

### `src/public/js/package.json` — do not delete

That file contains exactly `{"type":"module"}` and nothing else. It looks like a stray or
leftover file, but it is load-bearing: it tells Node's module resolver (used by Jest when it
loads front-end test files) that `.js` files under `src/public/js/` are ES modules rather
than CommonJS. Without it, the front-end test suites in `tests/frontend/` fail to import the
modules under test. If you're tidying up files, leave this one alone.

## Tree-rendering invariants

`src/public/js/treeRenderer.js` and `src/public/tree-visualization.css` implement the
conversation-tree SVG rendering. These
rules are **structural, not cosmetic** — breaking them misaligns arrows or fragments the
trunk, and the bug is often only visible on trees with an irregular shape. Full detail is in
[`CLAUDE.md`](CLAUDE.md#tree-rendering-invariants-do-not-break); short version:

1. **Every node has the same height.** `nodeHeightFor()` must return one constant value for
   every node, always. Arrow anchors are computed as `cy = node.y + h/2`; if `h` varies
   within a lane, arrows step out of alignment. Horizontal variance (`nodeWidthFor`) is fine.
2. The **root** node is distinguished by border/stroke width, never by height.
3. The **trunk** is the longest path from the root (`nodes[0]`), computed in
   `calculateYLevels`/`longestPath` — not a participant sort, not pure chronological order.
4. **Branches alternate** `±1, ±2` per participant group, sorted by group size.
5. **Auto-fit never scales a small tree above its natural size** (`MAX_FIT_SCALE = 1`).

If a visual change seems to require per-node height variance, it doesn't — use width,
border, glow, or a `type`-based style instead. Never touch `nodeHeightFor`'s return value
per-node.

## CSS colors

All colors are CSS variables defined in the design-tokens stylesheet (`base/variables.css`
and friends) so that themes apply everywhere. **Never hardcode a color** (hex, `rgb()`,
named color) in a `.css` file or inline in JS — reference a `var(--...)` token instead, and
add a new token if the one you need doesn't exist yet.

## HTML structure

Existing HTML IDs (`#subjectsList`, `#treeVisualization`, and others referenced from
front-end JS) must be **preserved**. Adding new elements/IDs is fine; removing or renaming an
existing one breaks whatever module queries it by ID. When in doubt, grep the front-end JS
for the ID before renaming or deleting it in `index.html`.

## Security invariant: the email body iframe

Email HTML bodies are rendered inside an `<iframe>` with `sandbox="allow-same-origin"` (see
`src/public/js/email-detail.js`) and **no `allow-scripts`**. This is the primary XSS guard
for this app — a malicious email body cannot execute script inside that iframe. **Never add
`allow-scripts`** to that sandbox attribute, even to fix a rendering quirk; the regex-based
sanitizer that also runs on the body is a secondary defense, not a substitute for the sandbox
restriction. See the "Security notes" section of `CLAUDE.md` for the full list of security
invariants (OAuth `state` checks, session regeneration on login, the `/api/ai/*` anti-SSRF
`baseUrl` validation, etc.) — those apply to any change touching auth or the AI proxy too.

## Commit style

This project uses **Conventional Commits**. Keep commits small and focused. Examples drawn
from this codebase's own history/conventions:

```
fix(tree): correct trunk anchor when root has a single child
feat(ai): add baseUrl validation for OpenAI-compatible providers
docs(readme): clarify Redis is optional in dev
chore(deps): bump googleapis to ^153.0.0
test(quoteStripper): cover nested quote markers
refactor(folderResolver): accept the account folder directly
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`, `perf`. A scope in
parentheses (the module or area touched — `tree`, `ai`, `gmail`, `outlook`, `auth`, ...) is
encouraged but not mandatory.

## Opening a PR

Before opening a PR, please make sure:

- `npm test` passes.
- `npm run lint` is clean (`npm run lint:fix` for auto-fixable issues).
- No new hardcoded colors were introduced outside CSS variables.
- If you touched `treeRenderer.js` or the tree stylesheet, the invariants above still hold —
  ideally verified against a couple of real conversation trees of different shapes.
- If you touched the email body rendering, the iframe sandbox still has no `allow-scripts`.
- Existing HTML IDs referenced by front-end JS are still present.
- Commits are small, focused, and follow the conventional-commit style above.

The PR template will walk you through the same checklist.

## Questions

Open a [GitHub Discussion](https://github.com/vincamor/mail-workflow/discussions) for
questions, or an issue for anything you believe is a bug or a well-scoped feature request. Do
not open a public issue for a security vulnerability — see [SECURITY.md](SECURITY.md).
