# Mail Workflow

[![CI](https://github.com/vincamor/mail-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/vincamor/mail-workflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

Mail Workflow reads your Gmail or Outlook mailbox and reconstructs each discussion as an
interactive conversation tree, so you can see who replied to whom and where a thread split.

It is built for people who would rather not put their mail on someone else's server. Emails are
written only to a local folder you pick yourself; the server is a stateless OAuth proxy with no
database and no copy of anything. You run it on your own machine, with your own OAuth app.

## Try the demo

Three commands, no OAuth, no account, no `.env`:

```bash
git clone https://github.com/vincamor/mail-workflow.git
cd mail-workflow && npm install && npm run demo
```

It opens `http://localhost:3000/?demo=1` on a bundled sample dataset — 60 fictional emails
across 8 threads. The demo is strictly read-only: folder picking, download, sync and reply are
hidden, the AI assistant is off, and nothing is written to disk or to IndexedDB.

Because the demo reads its data over HTTP rather than through the File System Access API, it
also runs on Firefox, Safari and mobile — unlike the full app, which needs Chrome or Edge.

<!-- screenshot: conversation tree, demo mode -->

## Features

- **Gmail and Outlook** over OAuth2. You bring your own OAuth app; no credentials are shared
  with a third party.
- **Local-only storage.** Emails are written as JSONL to a folder you choose through the File
  System Access API. IndexedDB holds the folder handle and local metadata. The server stores
  nothing.
- **Conversation trees** drawn as native SVG — zoom, pan, auto-fit, a date timeline and
  per-participant avatars. No charting library, no framework, no bundler.
- **Filters, groups and search** over the subject list, saved locally.
- **AI assistant, multi-provider** — Ollama (local), OpenAI, Anthropic, or any OpenAI-compatible
  endpoint. Two features use it: a clean-up pass that combines a code pre-filter with two AI
  passes and produces an editable report (exclude / keep / unsure) you approve before it
  applies, and a per-thread chat that answers questions about a conversation or drafts a reply
  with the thread as context.
- **Reply** to a thread from the app, through the provider's API.
- **Five themes** (four dark, one light), persisted in the browser.

One thing to know before you run it: **the user interface is still in French.** A full migration
to English is the next planned milestone — see [ROADMAP.md](ROADMAP.md). Everything else,
documentation included, is in English.

## Requirements

- **Node.js >= 20.** CI runs the suite on 20 and 22.
- **Chrome or Edge 86+** for the full app. It depends on the File System Access API, which
  Firefox and Safari do not implement and mobile browsers do not offer. There is no fallback: on
  an unsupported browser the app shows a notice instead of loading. Demo mode is the exception
  and works anywhere.
- **Your own OAuth app** — a Google Cloud project for Gmail, an Azure AD / Microsoft Entra
  registration for Outlook, or both.
- Redis is optional. Without `REDIS_URL`, sessions are kept in memory and lost on restart.

## Quick start

The technical half takes two commands:

```bash
npm run setup     # interactive wizard: writes .env, generates a session secret
npm start         # http://localhost:3000
```

The other half is not compressible. Creating the OAuth app in a provider console takes about
15 minutes and **no script can automate it**: reading Gmail uses a Google _restricted_ scope, so
nobody can create that project for you or hand you their client secret. `npm run setup` prints
the exact redirect URI to paste into the console, which is the single most common cause of a
failed first login.

- [Google Cloud setup (Gmail)](docs/setup/google-cloud.md) — including why the consent screen
  stays in **Testing** mode, and why that is fine for personal use.
- [Azure AD / Entra ID setup (Outlook)](docs/setup/azure-ad.md).

If something does not work, run `npm run doctor`. It is read-only, prints no secret values, and
checks the things that actually break — Node version, `.env` completeness, and whether your
redirect URIs agree with the `PORT` and `APP_ORIGIN` the server will use. Its output is meant to
be pasted into a bug report as-is.

Then, in the browser: sign in → pick a local folder → download → select a subject to see its
tree.

## How it works

**A stateless OAuth proxy.** The browser never talks to Google or Microsoft. It calls the local
Express server, which holds the OAuth tokens in the server session — in memory, or in Redis if
you configured it — for the lifetime of that session; the cookie expires after two hours, and
`POST /auth/logout` destroys it. The OAuth flow uses a `state` parameter checked on callback,
and the session is regenerated after login.

**Analysis runs in your browser.** Downloaded mail is streamed from the local JSONL file and
parsed client-side. `emailAnalyzer_browser.js` derives the conversation topology — a
`{nodes, links}` graph — from headers and quoted text, and `treeRenderer.js` lays it out and
draws the SVG. The server is not involved and never sees the content.

**The AI proxy is a proxy, not a service.** `/api/ai/*` forwards your request to the provider you
configured, with your key. Every route requires an authenticated session and is rate-limited. The
`baseUrl` you supply is validated against SSRF: official domains only for OpenAI and Anthropic,
DNS resolution plus rejection of private, loopback, link-local and cloud-metadata addresses
(including their IPv6-mapped forms) for anything else, and provider redirects are refused rather
than followed. That guard also blocks a local Ollama endpoint unless you explicitly opt in with
`ALLOW_LOCAL_AI`. Your key is never logged and never persisted server-side.

## Privacy and security

- **No database, anywhere.** The server has no persistence layer. It cannot retain your mail
  because it has nowhere to put it.
- **No server-side copy of any email.** Message content passes through the proxy on its way from
  the provider to your browser and is never written down.
- **Your AI key stays in your browser** (`localStorage`) and is sent only to the provider you
  configured, for the duration of one request.
- **Email HTML renders in an `<iframe sandbox="allow-same-origin">` with no `allow-scripts`.**
  That sandbox restriction — not the regex sanitizer that also runs — is what stops a malicious
  email from executing script. It must never be relaxed.

What the app does _not_ protect against is stated just as plainly in [SECURITY.md](SECURITY.md):
the JSONL files on disk are not encrypted at rest, and once a request reaches the AI provider you
chose, its handling is that provider's business. Report vulnerabilities privately through the
process described there, not in a public issue.

## Scripts

| Script           | What it does                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm start`      | Runs the server on `PORT` (default 3000).                                                                                                                                            |
| `npm run dev`    | Same, with `node --watch` restarting on backend changes.                                                                                                                             |
| `npm run demo`   | Starts the app on the bundled sample dataset and opens it. No `.env` needed.                                                                                                         |
| `npm run setup`  | Interactive first-run wizard. Renders `.env` from `.env.example`, backs up any existing file, writes atomically.                                                                     |
| `npm run doctor` | Non-interactive diagnostic. Read-only, prints no secret values, exits non-zero if a check fails.                                                                                     |
| `npm test`       | Jest, backend and front-end. Use `npm test`, never `npx jest` — the front-end suites need the `--experimental-vm-modules` flag baked into the script. (`test:ci` is the CI variant.) |
| `npm run lint`   | ESLint over the repo. `lint:fix` applies the auto-fixable findings.                                                                                                                  |
| `npm run format` | Prettier, write mode. `format:check` is the read-only version CI runs.                                                                                                               |

## Project layout

```
src/
  app.js            Express entry: helmet, CORS, sessions, static, routes
  routes/           gmail · outlook · ai (each rate-limited)
  services/         gmailService · outlookService · emailUtils · aiService · quoteStripper
                    emailAnalyzer_browser.js — client-side analysis, served to the browser
  public/
    index.html
    js/             ES modules: treeRenderer, analysis, emails, aiChat*, themeManager, …
    styles/         design tokens + components (every color is a CSS variable)
    demo/           the fictional sample dataset
scripts/            setup.js · doctor.js · demo.js
tests/              backend (CommonJS) + frontend (ESM)
```

The backend is CommonJS; the front-end is ES modules loaded directly by the browser. See
[docs/internal/architecture.md](docs/internal/architecture.md) for the full picture, and
[docs/README.md](docs/README.md) for the documentation index — including
[the JSONL data format](docs/guides/data-format.md) and
[deployment](docs/guides/deployment.md).

## Non-goals

- **No build step and no bundler.** `src/public/` is served exactly as written. Changing a
  front-end file needs a hard refresh, not a rebuild.
- **No Docker image.** The app needs Chrome or Edge on the client and a writable local folder on
  the user's machine either way; containerising the Express server removes neither constraint, so
  it would add a moving part without removing friction.
- **Not published to npm.** This is meant to be cloned and modified — your own filters, themes
  and prompts. Shipping it as an installable tool would imply a frozen one.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. The parts that matter most are the
tree-rendering invariants and the iframe sandbox rule — both are structural, and both are easy to
break without noticing.

Planned work is in [ROADMAP.md](ROADMAP.md); shipped changes in [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).
