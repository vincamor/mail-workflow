# Microsoft Entra ID setup (Outlook)

A step-by-step guide for connecting Mail Workflow to your own Outlook /
Microsoft 365 account. "Azure Active Directory" was renamed **Microsoft
Entra ID** — you'll see both names in older tutorials and blog posts; the
portal below is the current one.

Total time: ~10 minutes.

---

## 1. Register an application

1. Go to the [Microsoft Entra admin center](https://entra.microsoft.com) and sign in.
2. Browse to **Entra ID** → **App registrations** → **New registration**.
3. **Name**: anything, e.g.
   ```
   Mail Workflow
   ```
4. Leave **Redirect URI** empty here — you'll add it properly under **Authentication** in step 3, as a "Web" platform (adding it on this screen creates it as the wrong platform type for a few UI versions).
5. Choose **Supported account types** — see the next section, this is the option that trips people up.
6. Click **Register**.

<!-- screenshot: New registration form, Supported account types dropdown -->

## 2. Supported account types — and what `OUTLOOK_TENANT_ID=common` actually does here

The registration form offers four options:

| Option                                                | Meaning                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Single tenant only – \<your tenant\>**              | Only users (or guests) inside your own Entra tenant can sign in.                                 |
| **Multiple Entra ID tenants**                         | Any work/school account from any Entra tenant can sign in.                                       |
| **Any Entra ID Tenant + Personal Microsoft accounts** | Any work/school account _and_ personal accounts (Outlook.com, Hotmail, Xbox, Skype) can sign in. |
| **Personal accounts only**                            | Only Outlook.com/Hotmail/personal accounts.                                                      |

`.env.example` ships with:

```
OUTLOOK_TENANT_ID=common
```

`common` is Microsoft's shared endpoint that accepts **both** work/school and
personal accounts, which is why **Any Entra ID Tenant + Personal Microsoft
accounts** is the option that matches it — pick that one unless you
specifically want to lock the app to your own organization (in which case
pick **Single tenant only** and set `OUTLOOK_TENANT_ID` to your tenant's
GUID instead, found on the app's **Overview** page as **Directory (tenant)
ID**).

> **Trap, verified against the current source**: as of this codebase,
> `OUTLOOK_TENANT_ID` is read into an MSAL client object
> (`src/services/outlookService.js`, `msalConfig.auth.authority`), but that
> object (`pca`) is never actually called by `initAuth`, `handleCallback`,
> or the token-refresh logic. Those three functions all hard-code
> `https://login.microsoftonline.com/common/...` directly. **In practice,
> changing `OUTLOOK_TENANT_ID` away from `common` today does not restrict
> which accounts can sign in** — what actually restricts sign-in is the
> **Supported account types** you pick in this step. Leave
> `OUTLOOK_TENANT_ID=common` as shipped; it matches what the code really
> does, and your app registration's own **Supported account types** setting
> is the real gate to configure correctly.

## 3. Add the redirect URI

1. On your app registration, go to **Manage** → **Authentication**.
2. Click **Add a platform** → **Web**.
3. Under **Redirect URIs**, enter exactly:
   ```
   http://localhost:3000/outlook/callback
   ```
4. Click **Configure** / **Save**.

<!-- screenshot: Authentication page, Web platform, Redirect URIs field -->

You can register multiple redirect URIs on the same app later (e.g. for
production) — no need for a second app registration.

## 4. Create a client secret

1. Go to **Manage** → **Certificates & secrets** → **Client secrets** tab → **New client secret**.
2. Enter a description, e.g. `local dev`, and pick an expiry (Microsoft caps this at 24 months).
3. Click **Add**.

<!-- screenshot: New client secret dialog with description and expiry -->

> **Trap**: the secret **Value** is shown only once, immediately after
> creation. Copy it now — after you leave the page, only the **Secret ID**
> (not the value) remains visible, and you cannot recover the value; you'd
> have to create a new secret. Also note the **expiry date**: when it
> passes, sign-in will start failing with `AADSTS7000215` (see
> [Troubleshooting](#troubleshooting)) until you generate a new secret and
> update `.env`.

## 5. Microsoft Graph delegated permissions this app uses

Read directly from `src/services/outlookService.js` (`initAuth` and the
token-exchange call in `handleCallback` request the identical scope list):

| Scope            | Why it's needed                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openid`         | Standard OpenID Connect sign-in.                                                                                                                          |
| `profile`        | Basic profile info alongside the identity token.                                                                                                          |
| `offline_access` | Issues a refresh token, so the app can renew access without asking you to sign in again every hour (`getValidAccessToken` / `refreshOutlookAccessToken`). |
| `User.Read`      | Retrieve your account's email address after sign-in (`GET /v1.0/me`), used as your local folder name and session identifier.                              |
| `Mail.Read`      | Read messages in Inbox and Sent Items to download and analyze them.                                                                                       |
| `Mail.ReadWrite` | Required alongside `Mail.Read` by Microsoft Graph for some mailbox operations the app performs (folder/message access beyond plain read).                 |
| `Mail.Send`      | Send replies from the app's "Répondre" feature (`POST /outlook/reply`, via `/me/messages/{id}/reply`).                                                    |

These are **delegated permissions** (the app acts as the signed-in user, not
as itself) — that's the correct type; you don't need to add anything under
**Application permissions**.

1. Go to **Manage** → **API permissions**.
2. Confirm **Microsoft Graph → User.Read** is present (added automatically on registration).
3. Click **Add a permission** → **Microsoft Graph** → **Delegated permissions**, and add: `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `offline_access`. (`openid` and `profile` are requested automatically as part of standard sign-in and don't need a separate entry.)
4. If you're the admin of your own tenant, you can optionally click **Grant admin consent** to skip the per-user consent prompt — not required for personal use, since you'll simply consent for yourself on first sign-in.

<!-- screenshot: API permissions page with Mail.Read, Mail.ReadWrite, Mail.Send, offline_access listed -->

## 6. Put the values in `.env`

From the app's **Overview** page, copy the **Application (client) ID**.
Combine with the secret **Value** from step 4:

```
OUTLOOK_CLIENT_ID=<Application (client) ID>
```

```
OUTLOOK_CLIENT_SECRET=<the secret Value, copied at creation time>
```

```
OUTLOOK_TENANT_ID=common
```

```
OUTLOOK_REDIRECT_URI=http://localhost:3000/outlook/callback
```

Restart the server (`npm start`) after editing `.env`.

---

## Troubleshooting

### `AADSTS50011` — reply URL / redirect URI mismatch

The redirect URI sent by the app doesn't exactly match what's registered
(case-sensitive, trailing slash matters).

**Fix**: under **Authentication → Web → Redirect URIs**, make sure

```
http://localhost:3000/outlook/callback
```

is present character-for-character, and matches `OUTLOOK_REDIRECT_URI` in `.env`.

### `AADSTS7000215` — invalid client secret

Either the secret's **expiry date has passed**, the wrong value was copied
(the **Secret ID** instead of the **Value**), or there's stray whitespace.

**Fix**: go to **Certificates & secrets**, create a new client secret,
copy the **Value** column immediately, and update `OUTLOOK_CLIENT_SECRET`.

### `AADSTS650057` — invalid resource / permission not found in requested permissions

The app requested a scope that isn't present in its own **API permissions**
list (a mismatch between what the code asks for and what the app
registration declares).

**Fix**: check **API permissions** includes all seven scopes listed in
[section 5](#5-microsoft-graph-delegated-permissions-this-app-uses):
`openid`, `profile`, `offline_access`, `User.Read`, `Mail.Read`,
`Mail.ReadWrite`, `Mail.Send`.

### Consent-required errors (e.g. "Need admin approval", `AADSTS65001`)

A work/school (Entra) tenant can have a policy that disables users from
consenting to app permissions themselves — common in managed organizations.

**Fix**: either sign in with a personal Microsoft account for local testing
(no admin involved), or ask the tenant's Global Administrator to grant
admin consent for the app (**API permissions → Grant admin consent**), or
test against your own tenant where you are the admin.

---

## Personal Microsoft accounts vs. work/school accounts

- **Personal account** (Outlook.com, Hotmail, Live, MSN) = a Microsoft
  Account (MSA), not tied to any organization.
- **Work/school account** = an identity inside a Microsoft Entra tenant
  (e.g. `you@yourcompany.com` on Microsoft 365).

With **Supported account types** set to _Any Entra ID Tenant + Personal
Microsoft accounts_ and `OUTLOOK_TENANT_ID=common` (the shipped default),
both kinds of accounts can sign in. If you instead register the app as
**Single tenant only**, personal accounts and accounts from other
organizations will be rejected outright, regardless of what
`OUTLOOK_TENANT_ID` is set to in `.env` — the tenant restriction lives in
the app registration itself, not in this environment variable (see the
callout in [section 2](#2-supported-account-types--and-what-outlook_tenant_idcommon-actually-does-here)).
