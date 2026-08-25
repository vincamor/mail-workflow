# Security Policy

## Supported versions

Mail Workflow has not yet reached a `1.0.0` release; there is no stable release line yet.
Until then, security fixes target the `main` branch only. Once `1.0.0` ships, this section
will be updated with a supported-versions table.

| Version | Supported |
| ------- | --------- |
| `main`  | Yes       |

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Report it privately through
[GitHub Security Advisories for this repository](https://github.com/vincamor/mail-workflow/security/advisories/new).
This is a solo-maintained project; a private advisory is the fastest and safest way to reach
the maintainer without exposing the issue before a fix is available.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal repro is very helpful).
- The affected file(s)/endpoint(s) if you know them.

### Response time

This is a solo-maintained open-source project, so response time is best-effort:

- Acknowledgement: within 7 days.
- Initial assessment (valid / not valid, severity): within 14 days.
- Fix or mitigation timeline communicated once the report is triaged.

If you don't hear back within two weeks, it's fine to follow up on the same advisory thread.

## Security model

This section states plainly what Mail Workflow does and does not protect against, so
reporters and self-hosters can reason about impact.

### Data storage

- Emails are downloaded and stored **only in a local folder the user explicitly picks** on
  their own machine, via the File System Access API (plus IndexedDB for indexes/metadata).
  The server has **no database** and keeps **no copy** of any email content.
- OAuth access/refresh tokens live **only in the server session** — in-memory by default, or
  in Redis if `REDIS_URL` is configured — and expire with the session cookie after **2
  hours**. The browser never talks to Google/Microsoft directly; the server acts as a
  stateless OAuth proxy for the duration of a request.

### The AI proxy (`/api/ai/*`)

- Every route under `/api/ai/*` requires an **authenticated session** (`requireAuth`
  middleware) and is **rate-limited**.
- The `baseUrl` supplied by the client for an AI provider is validated against an anti-SSRF
  allowlist: it rejects addresses that resolve to private, loopback, or link-local ranges,
  cloud metadata IPs/hostnames (including the IPv6-mapped forms of all of the above), and it
  refuses to follow HTTP redirects from the provider (`redirect: 'manual'`), so a provider
  cannot redirect the server into fetching a private/internal address on its behalf. A local
  Ollama endpoint is only permitted when explicitly opted into via `ALLOW_LOCAL_AI`.
- The user's AI provider API key is **never logged and never persisted server-side**; it is
  forwarded to the configured provider for the lifetime of the request only.

### Rendering untrusted email content

- Email bodies are HTML from third parties (arbitrary senders) and are treated as untrusted.
  The body is rendered inside an `<iframe sandbox="allow-same-origin">` — **without**
  `allow-scripts`. This sandbox restriction, not the accompanying regex-based sanitizer, is
  the primary control that prevents a malicious email from executing script in the app's
  origin. `allow-scripts` must never be added to that iframe.

### OAuth flow

- OAuth uses a `state` parameter that is checked on callback to prevent CSRF against the
  OAuth flow.
- The session is regenerated (`session.regenerate()`) after a successful login, to prevent
  session fixation.
- `POST /auth/logout` destroys the server session (and with it, the OAuth tokens it held).

### What this app does not protect against

- **A compromised or malicious local machine.** Emails on disk in the user-chosen folder are
  plain JSONL files with no additional encryption at rest; anyone with access to that
  machine/account can read them, same as any other local file.
- **A malicious or compromised AI provider.** Once a request leaves the proxy for the
  provider the user configured, the app has no further control over that provider's handling
  of the data sent to it (the thread content, for chat/clean-up features).
- **Vulnerabilities in third-party dependencies** you introduce by self-hosting with an
  outdated Node version or unpatched packages — keep `npm audit` clean and Node at the
  version pinned in `.nvmrc`/`engines`.

### Self-hosting responsibilities

If you deploy this yourself:

- Set a strong, unique `SESSION_SECRET` in production. The app refuses to start in
  production without one.
- Set `APP_ORIGIN` to your actual public origin (used for CORS); do not leave it defaulting
  to `localhost` in production.
- **Never commit `.env`.** If a credential (OAuth client secret, `SESSION_SECRET`, Redis URL
  with embedded credentials, etc.) has ever touched disk in a place that could have been
  committed or shared, rotate it.
- Use HTTPS in front of the app in production; session cookies and OAuth redirects assume a
  trusted transport.
