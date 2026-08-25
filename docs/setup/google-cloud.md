# Google Cloud Console setup (Gmail)

A step-by-step guide for connecting Mail Workflow to your own Gmail account.
You will create your own Google Cloud project and OAuth client — no Google
verification is required for personal/self-hosted use (see
[Testing mode, explained honestly](#testing-mode-explained-honestly) below).

Total time: ~10 minutes.

---

## 1. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and sign in with the Google account you want to read mail from (or any Google account — it doesn't have to be the same one).
2. Click the project selector at the top of the page, then **New Project**.
3. Give it a name, e.g.
   ```
   mail-workflow
   ```
4. Click **Create** and wait for the notification that the project is ready, then select it from the project selector.

<!-- screenshot: Google Cloud project selector, "New Project" dialog -->

## 2. Enable the Gmail API

1. With your project selected, open the menu (☰) → **APIs & Services** → **Library**.
2. Search for:
   ```
   Gmail API
   ```
3. Click the **Gmail API** result, then click **Enable**.

<!-- screenshot: Gmail API page in the API Library with the Enable button -->

## 3. Configure the OAuth consent screen

Google now calls this section **Google Auth Platform**. It has four tabs:
**Branding**, **Audience**, **Data Access**, **Clients**.

1. Open the menu (☰) → **Google Auth Platform** (if this is the first time, it may say **Get started**).
2. **Branding**: enter an app name (e.g. `Mail Workflow`) and a support email (your own address is fine). Save.
3. **Audience**: select **External** as the user type.
   > External is required unless you have a Google Workspace organization and deliberately want to restrict the app to your own domain (**Internal**). Choosing **Internal** by mistake produces the `org_internal` error described below — see [Troubleshooting](#troubleshooting).
4. Confirm the **publishing status** is **Testing** — this is the default and you should **not** click "Publish App" for personal/self-hosted use.
5. Still under **Audience**, scroll to **Test users** → **Add users**, and add your own Gmail address:
   ```
   your-address@gmail.com
   ```
   Click **Save**.

<!-- screenshot: Audience tab, publishing status "Testing", Test users list -->

You can skip **Data Access** (declaring scopes there) — it's only needed if you later submit the app for verification. In Testing mode, the app requests its scopes directly at sign-in time (see step 5 below) and that's enough.

### Testing mode, explained honestly

Gmail's read scope (`gmail.readonly`) is a Google **restricted scope**. For a
publicly-verified app, restricted scopes require a paid third-party security
assessment (CASA). **You do not need this for personal or self-hosted use** —
as long as your project's OAuth consent screen stays in **Testing** and your
own address is listed as a **test user**, you can authenticate indefinitely
without Google's verification.

The real limits of Testing mode:

- **Up to ~100 test users** can be listed — irrelevant for a single self-hosted user, but relevant if you're setting this up for a small team.
- **The "Google hasn't verified this app" warning screen** appears every time a test user signs in. This is expected and safe to click through *because you created the app yourself* — click **Advanced**, then **Go to Mail Workflow (unsafe)** to continue.
- **Refresh tokens issued to test users expire after 7 days** ([confirmed in Google's current documentation](https://support.google.com/cloud/answer/15549945)). In practice this rarely matters here: the app's own session cookie already expires after **2 hours** (`maxAge` in `src/app.js`), so you re-run the Google sign-in flow well before the 7-day mark in normal use. If you leave the app connected and idle for more than a week, the next API call will fail and you'll simply need to reconnect via the "Connect Gmail" button — no data is lost, since emails already downloaded live in your local folder, not in the token.

> **Trap**: don't confuse "Testing" (fine forever for personal use) with the
> idea that you *must* eventually verify. You only need verification if you
> want to hand this app to the public with more than ~100 users, or remove
> the warning screen.

## 4. Create the OAuth client ID

1. Go to the **Clients** tab (still under Google Auth Platform).
2. Click **Create Client**.
3. **Application type**: select **Web application**.
4. **Name**: anything, e.g. `Mail Workflow local`.
5. Under **Authorized redirect URIs**, click **Add URI** and paste exactly:
   ```
   http://localhost:3000/gmail/callback
   ```
6. Click **Create**.

<!-- screenshot: Create OAuth client ID form, Web application type, Authorized redirect URIs field -->

> **Trap**: the client secret is shown **only once**, right after creation.
> If you navigate away without copying it, the console will only ever show
> you the last 4 characters afterward — you'd have to rotate the secret to
> get a new one. Copy both values immediately.

You now have a **Client ID** and a **Client secret**.

## 5. Scopes this app requests

Mail Workflow requests these scopes (read directly from `src/services/gmailService.js`, `initAuth`):

| Scope | Why it's needed |
|---|---|
| `https://www.googleapis.com/auth/gmail.readonly` | Read your inbox/sent/archived messages so they can be downloaded to your local folder and analyzed. |
| `https://www.googleapis.com/auth/gmail.send` | Send replies from the app's "Répondre" / "Répondre à tous" feature (`POST /gmail/reply`). |
| `openid` | Standard OpenID Connect sign-in, required to retrieve your identity. |
| `email` | Retrieve your email address, used as your local folder name and session identifier (`userId`). |
| `profile` | Basic profile info returned alongside `email` by Google's userinfo endpoint. |

None of these are declared as a fixed scope list on the consent screen in
Testing mode — they are requested live by `oauth2Client.generateAuthUrl()`
each time you click "Connect Gmail", and Google's warning screen will list
them for you (and your test users) to review before consenting.

## 6. Put the values in `.env`

Open `.env` (copied from `.env.example`) and fill in:

```
GMAIL_CLIENT_ID=<your client ID>.apps.googleusercontent.com
```
```
GMAIL_CLIENT_SECRET=<your client secret>
```
```
GMAIL_REDIRECT_URI=http://localhost:3000/gmail/callback
```

Restart the server (`npm start`) after editing `.env`.

---

## Troubleshooting

### `redirect_uri_mismatch`
The redirect URI your app sent doesn't exactly match one registered on the
OAuth client (case-sensitive, and `http` vs `https` / trailing slash matter).

**Fix**: open **Google Auth Platform → Clients → your client**, and compare
the **Authorized redirect URIs** entry character-by-character against
`GMAIL_REDIRECT_URI` in `.env`. They must be identical.

### `invalid_client`
The client ID or client secret is wrong, has extra whitespace, was rotated,
or belongs to a different Google Cloud project than the one you enabled the
Gmail API in.

**Fix**: re-copy `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` from **Clients**
in the same project where you enabled the Gmail API. If you lost the secret,
rotate it (a new one is generated) and update `.env`.

### `access_denied`
Either you clicked "Cancel" on the consent screen, or you signed in with a
Google account that **isn't listed as a test user** while the app is in
Testing mode.

**Fix**: add that account's address under **Audience → Test users**, then
try connecting again.

### "App is blocked" / "Google hasn't verified this app"
This is the expected unverified-app warning for a Testing-mode app — it is
not an error. It only lets **test users** through.

**Fix**: click **Advanced** → **Go to <app name> (unsafe)**. If a user isn't
listed as a test user, they'll get `access_denied` instead of this screen —
add them as a test user first.

### `Error 403: org_internal`
The OAuth consent screen's **User type** (Audience) was set to **Internal**,
which restricts sign-in to accounts inside a specific Google Workspace
organization. A personal `@gmail.com` account (or any account outside that
org) will always be rejected.

**Fix**: in **Audience**, set the user type to **External** (this option
only appears if the underlying Google Cloud organization allows it; a
project created under a plain personal Google account defaults to External
already).

---

## Production deployment

For a public deployment (e.g. Railway), two things change from the local setup above:

1. Add a **second** authorized redirect URI on the same OAuth client (you don't need a second client) pointing at your HTTPS domain:
   ```
   https://your-app.example.com/gmail/callback
   ```
2. Set the matching environment variables on your host:
   ```
   GMAIL_REDIRECT_URI=https://your-app.example.com/gmail/callback
   ```
   ```
   APP_ORIGIN=https://your-app.example.com
   ```
   `APP_ORIGIN` controls the app's CORS allow-list (see `src/app.js`) — it is unrelated to the Google redirect URI but must also point at the real public URL.

If you expect **more than ~100 distinct users**, or want to remove the
unverified-app warning for a public audience, that's when Google's
verification process (including CASA for restricted scopes) becomes
mandatory — out of scope for a personal/self-hosted setup.
