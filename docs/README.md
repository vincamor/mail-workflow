# Documentation

Everything written down about Mail Workflow, grouped by what you are trying to
do. Start with the row that matches your intent — you do not need the others.

---

## I want to run it

| Document | For you if… |
|---|---|
| [../README.md](../README.md) | You just arrived. What the app is, what it needs, and the two commands that start it |
| [setup/README.md](setup/README.md) | You are about to create the OAuth credentials and want to know which provider guide you need |
| [setup/google-cloud.md](setup/google-cloud.md) | You use **Gmail**. Creating the Google Cloud project, enabling the API, and why the consent screen can stay in Testing mode |
| [setup/azure-ad.md](setup/azure-ad.md) | You use **Outlook**. Registering the Azure AD / Entra app, its permissions and redirect URIs |
| [guides/data-format.md](guides/data-format.md) | You want to know exactly what the app writes to your disk before you point it at your mailbox — and how to read those files without the app |

Stuck on `invalid_client` or a redirect-URI mismatch? Run `npm run doctor`
first: it is non-interactive, side-effect free, and prints the remedy rather than
the symptom.

## I want to deploy it

| Document | For you if… |
|---|---|
| [guides/deployment.md](guides/deployment.md) | You want the app hosted rather than local. Railway via GitHub Actions: the token, the secrets, the runtime variables, and what deployment does *not* change |

## I want to change it

| Document | For you if… |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | You are opening a pull request and want the workflow, the commit style and the test expectations |
| [../CLAUDE.md](../CLAUDE.md) | You want the short version: commands, project rules, and the tree-rendering invariants that must not be broken. Read it before your first change |
| [internal/architecture.md](internal/architecture.md) | You need the full picture: what every module does, how they are wired, which parts are fragile and why the memory-sensitive code looks the way it does |
| [internal/filesystem-handles.md](internal/filesystem-handles.md) | You are working on folder selection, downloading, syncing, or anything that reads or writes the local JSONL. Call chains, permissions, streams, and the bugs already fixed there |
| [internal/outlook-implementation.md](internal/outlook-implementation.md) | You are touching Outlook, or wondering why it behaves differently from Gmail in one specific place |
| [guides/data-format.md](guides/data-format.md) | You are writing code that produces or consumes the JSONL. It is the on-disk contract, and both providers must satisfy it |
| [../ROADMAP.md](../ROADMAP.md) | You are looking for something to work on, or want to know whether a gap you found is already known |
| [../SECURITY.md](../SECURITY.md) | You found a vulnerability, or you are changing the AI proxy, the OAuth flow or the email-body iframe |

## Design notes and specs

Decision records. They explain *why* things are the way they are; they are not
instructions and they are not kept in sync with the code.

| Document | What it answers |
|---|---|
| [specs/2026-08-25-oss-repo-design.md](specs/2026-08-25-oss-repo-design.md) | Why the repository is shaped like this: the open-source release plan, the decisions taken (English-only UI, no Docker, no npm package), the demo-mode design, and the defects the release work uncovered |
| [design/attachments-research.md](design/attachments-research.md) | What attachment support would actually cost. Verified API facts on Gmail and Graph attachments, quota, size thresholds, CSP and filename safety — research only, no design decisions |

---

**Something here contradicts the code?** The code wins. These documents are
maintained by hand; open an issue, or fix the document in the same pull request
as the behaviour change.
