# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

`1.0.0` has not shipped yet. Everything below is staged for it; the section will be
renamed once the release is tagged.

Three checks remain before tagging, all of which need a human at a screen: a visual pass
on the English interface, the README screenshots, and a real end-to-end OAuth run
following the setup guides. See [issue #13](https://github.com/vincamor/mail-workflow/issues/13).

### Added

- **Demo mode.** `npm run demo` shows a real conversation tree with no `.env`, no OAuth,
  no account and no folder picking. The dataset is fabricated, never derived from real
  mail: 60 emails over 8 subjects, including a 15-node thread with two branch points.
  Unlike the full app, demo mode works in Firefox, Safari and on mobile, because it does
  not need the File System Access API.
- **`npm run setup`.** An interactive wizard that takes a new user from nothing to a valid
  `.env`: checks Node, prints the exact redirect URI to register, generates
  `SESSION_SECRET`, and never overwrites an existing file without backing it up.
- **`npm run doctor`.** A read-only diagnostic designed to be pasted into a bug report.
  Its most valuable check is consistency: whether the redirect URIs actually match the
  `PORT` and `APP_ORIGIN` the server will listen on — the most common cause of a failed
  sign-in. Secret values are never printed.
- **Step-by-step OAuth guides** for Google Cloud and Microsoft Entra, with the scopes read
  from the source rather than guessed, and troubleshooting keyed by the real error strings
  (`redirect_uri_mismatch`, `invalid_client`, `AADSTS50011`, `AADSTS7000215`).
- **Documentation restructured by audience** — `setup/`, `guides/`, `internal/`, `design/`,
  `specs/` — plus `docs/guides/data-format.md`, which documents exactly what the app writes
  to your disk, and `ROADMAP.md`.
- **Attachment support, designed but not built.** `docs/design/attachments.md` and its
  research note. See [issue #12](https://github.com/vincamor/mail-workflow/issues/12).
- Governance: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and PR
  templates.
- Tooling: ESLint 9 flat config, Prettier, and a CI pipeline running tests on Node 20 and
  22, lint, format, `npm audit`, and a fresh-install job that plays what a brand-new user
  actually does.

### Changed

- **BREAKING — the interface is now English.** UI copy, code comments, log messages, AI
  prompts, test names and the legal pages. The French UI is retired; this was a deliberate
  decision, direct replacement with no i18n layer.
  `docs/internal/glossary.md` is the binding terminology and records the four categories of
  French string that are deliberately kept, because they match real data or an internal
  protocol rather than being prose.
- Package metadata corrected: the package was still named `mailprojetjul` and declared
  `"license": "ISC"` while shipping an MIT `LICENSE`.
- Prettier applied across the codebase, as its own commit.

### Fixed

- **`decodeBase64Data` silently returned undecoded base64.** `cleanData` was declared
  `const` and then reassigned to append padding; the resulting `TypeError` was swallowed by
  the surrounding `catch`, so any input whose length is not a multiple of 4 came back as
  raw base64 instead of text. Found by the `no-const-assign` rule the moment ESLint landed.
- **The server crashed on startup with an empty `.env`.** A dead MSAL client was built at
  `require()` time and throws `invalid_client_credential` on an empty secret — so copying
  `.env.example` verbatim and running `npm start` failed before anything was configured.
  The test suite mocked `@azure/msal-node`, which is what kept it hidden.
- **`OUTLOOK_TENANT_ID` had no effect.** It fed only that dead client while all three OAuth
  endpoints hard-coded `/common/`, so a single-tenant Entra registration failed to sign in
  with no indication why. The variable is now genuinely used.
- **The attachment badge never rendered.** `loadEmailsFromHandle` rebuilds a lightweight
  object from each JSONL line using a field allowlist, and `hasAttachments` was not in it —
  the backend computed the flag, the file stored it, the renderer drew a badge for it, and
  the loader dropped it in between.
- **A front-end test duplicated the code it claimed to test.**
  `progressiveLoading.test.js` inlined copies of the analyzer's functions, so it could stay
  green while the real module was broken. Both suites now load the production file.
- The clean-up report's move button rendered `title="Move to exclure"`, leaking an internal
  JSON key into the interface — invisible while the UI was French.
- All 11 npm audit advisories resolved; audit now reports zero.

### Security

- Workflows declare explicit least-privilege `permissions`; without them they inherited the
  repository default, which is often read-write.
- All GitHub Actions pinned to full commit SHAs. A tag is a mutable pointer; a SHA is not.
- Closed a script-injection path where `RAILWAY_TOKEN` was interpolated into a shell command
  line — then removed the deploy job entirely, since this repository deploys nowhere.
- CodeQL analysis and Dependabot security alerts enabled; CI fails on high and critical
  advisories.
- `.npmrc` sets `engine-strict=true`, so a dependency raising the Node floor fails the
  install instead of merely warning. `connect-redis@10` would otherwise have shipped a
  Node 22 requirement through a green CI.
- Dropped `@azure/msal-node`, which was no longer used by anything.
