# OAuth provider setup

Mail Workflow needs its own OAuth app per provider — you bring your own
credentials, the server never ships with any. Pick the guide(s) for the
provider(s) you want to connect:

- **[Google Cloud setup (Gmail)](google-cloud.md)** — create a Google Cloud project, enable the Gmail API, configure the OAuth consent screen in Testing mode, create a Web OAuth client, and fill `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REDIRECT_URI`.
- **[Microsoft Entra ID setup (Outlook)](azure-ad.md)** — register an app, choose the right supported-account-types option, create a client secret, grant the Microsoft Graph delegated permissions, and fill `OUTLOOK_CLIENT_ID` / `OUTLOOK_CLIENT_SECRET` / `OUTLOOK_TENANT_ID` / `OUTLOOK_REDIRECT_URI`.

Both guides end with a troubleshooting section keyed by the exact error
strings you'll see (`redirect_uri_mismatch`, `AADSTS50011`, etc.) and a note
on what changes for a production deployment.

You only need to follow the guide(s) for the provider(s) you actually plan
to use — Gmail and Outlook setup are fully independent.
