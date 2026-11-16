# Setting up sign-in

Unifeye signs people in through an OpenID Connect provider. This page has step-by-step setup for
four common ones:

- [Zitadel](#zitadel)
- [Keycloak](#keycloak)
- [Microsoft Entra ID](#microsoft-entra-id) (formerly Azure AD)
- [Google Workspace](#google-workspace)

Any other OIDC provider works too. Follow [What every provider needs](#what-every-provider-needs)
and map each item to your provider's screens.

None of these setups has been tested against a real provider yet (see
[verification.md](verification.md)). Settings can be named differently or sit in a different place
in your provider's version. If something doesn't match, use [Troubleshooting](#troubleshooting).

In the examples below, `https://unifeye.example.com` is your Unifeye address (`APP_URL`).

## What every provider needs

| Item | Value |
| --- | --- |
| Flow | Authorization Code with PKCE (S256) |
| Redirect URI | `https://unifeye.example.com/api/auth/callback` |
| Post-logout redirect URI | `https://unifeye.example.com/signed-out` |
| Back-channel logout URI (optional) | `https://unifeye.example.com/api/auth/backchannel-logout` |
| Claims in the **ID token** | `sub`, plus `name` and `email` for display, plus the claim you admit people on |
| Refresh token (recommended) | Lets Unifeye notice disabled users. See [Session re-checks](deployment.md#session-re-checks) |

Unifeye reads everything from the ID token and never calls the userinfo endpoint. If a claim only
appears in the access token or userinfo, Unifeye doesn't see it.

The admission rule (`OIDC_ADMIT_CLAIM`, `OIDC_ADMIT_VALUES`) decides who gets in. It is explained
under [Admission rule](deployment.md#admission-rule).

### Groups from your provider

Unifeye can put people into its groups based on a claim in the ID token, so a role or group you
assign in your provider gives access to that Unifeye group's cameras.

1. Pick the claim. By default it's the admission claim (`OIDC_ADMIT_CLAIM`). To use a different one,
   set `OIDC_GROUPS_CLAIM` (same formats: string, array, object keys, or a dotted path). Set it to
   `none` to turn group sync off.
2. In Admin > Groups, open a group and select the values under **Sync from**. Values from everyone's
   latest sign-in are listed; type any other value to add it.

People join a group when their claim includes one of its values, and leave it when the value goes
away. This happens at every sign-in and at every [session re-check](deployment.md#session-re-checks),
so a removal takes effect within `OIDC_RECHECK_SECONDS` (5 minutes by default). Sessions without a
refresh token only re-sync at the next sign-in. A mapping change in Admin applies right away, using
the values from each person's latest sign-in or re-check.

Memberships added this way show a sync icon and are locked in Admin: change them in your provider.
People you add by hand stay until you remove them, whatever the claim says.

Per provider:

| Provider | Typical `OIDC_GROUPS_CLAIM` | Values look like |
| --- | --- | --- |
| Zitadel | `urn:zitadel:iam:org:project:roles` (needs the `urn:zitadel:iam:org:projects:roles` scope) | role keys, e.g. `front-desk` |
| Keycloak | `groups` or `realm_access.roles` | group names (with a leading `/` if **Full group path** is on) or role names |
| Entra ID | `roles` (app roles) or `groups` | app role values, or group **object IDs** |
| Google Workspace | none | Google puts no groups in the ID token |

If the claim is missing from a token, Unifeye treats it as empty and removes that person's synced
memberships. Make sure the provider includes the claim on refreshed ID tokens too.

### The first administrator

Unifeye makes one person an administrator: the one whose issuer and subject (`sub`) match
`BOOTSTRAP_ADMIN_ISSUER` and `BOOTSTRAP_ADMIN_SUBJECT`. The setup for each provider below says where
to find the subject. If you can't find it:

1. Start Unifeye with the bootstrap settings empty and sign in once. You get a Staff account.
2. List the people who have signed in. The last two columns are the issuer and the subject:

   ```sh
   docker compose exec app node cli.mjs users
   ```

3. Set `BOOTSTRAP_ADMIN_ISSUER` and `BOOTSTRAP_ADMIN_SUBJECT` to those values, then restart with
   `docker compose up -d`.
4. Sign in again. That account is now an administrator.

This only works once. After the first administrator exists, give other people admin rights in
Admin > People.

---

## Zitadel

You need an existing Zitadel instance and an organization the staff accounts belong to.

### 1. Create the application

1. Open your organization, go to **Projects**, and create a project called `Unifeye` (or use an
   existing one).
2. In the project, choose **New application**, name it `Unifeye`, and pick type **Web**.
3. Authentication method: **PKCE**.
4. Redirect URIs: `https://unifeye.example.com/api/auth/callback`
5. Post-logout URIs: `https://unifeye.example.com/signed-out`
6. Create it, then copy the **Client ID**.

### 2. Application settings

Open the application and check:

- **Grant types:** turn on **Refresh Token** next to Authorization Code.
- **Token settings:** turn on **User Info inside ID Token**. Without it, `name` and `email` are not
  in the ID token and people show up without a name. If you admit on roles (below), also turn on
  **User Roles inside ID Token**.
- **Back-channel logout URI:** if your version shows this field, set it to
  `https://unifeye.example.com/api/auth/backchannel-logout`. On some versions it first has to be
  turned on as an instance feature. Without it, signing out of Zitadel elsewhere doesn't end Unifeye
  sessions right away; the refresh-token check still catches disabled users.

### 3. Choose who can sign in

Pick one.

**Everyone in one or more organizations.** Zitadel puts the user's organization ID in the ID token
when Unifeye asks for an extra scope:

```env
OIDC_SCOPES=openid profile email offline_access urn:zitadel:iam:user:resourceowner
OIDC_ADMIT_CLAIM=urn:zitadel:iam:user:resourceowner:id
OIDC_ADMIT_VALUES=<organization ID>    # several IDs can be separated by commas
```

The organization ID is shown on the organization's overview page.

**Only people given a role in the project** (recommended when the organization has people who
shouldn't see cameras):

1. In the project, open **Roles** and add a role, for example `unifeye`.
2. Under **Authorizations**, give that role to each person who should have access.
3. In the project's general settings, turn on **Assert Roles on Authentication**. Turning on
   **Check authorization on Authentication** as well makes Zitadel refuse people without a role
   before they reach Unifeye.
4. Make sure **User Roles inside ID Token** is on for the application (step 2).

```env
OIDC_SCOPES=openid profile email offline_access
OIDC_ADMIT_CLAIM=urn:zitadel:iam:org:project:roles
OIDC_ADMIT_VALUES=unifeye
```

Leave `OIDC_ADMIT_VALUES` empty to admit anyone who holds any role in the project.

### 4. Settings

```env
OIDC_ISSUER=https://<your instance domain>     # e.g. https://acme-abc123.zitadel.cloud
OIDC_CLIENT_ID=<client ID from step 1>
# plus the OIDC_SCOPES / OIDC_ADMIT_* lines from step 3
BOOTSTRAP_ADMIN_ISSUER=https://<your instance domain>
BOOTSTRAP_ADMIN_SUBJECT=<user ID>
```

The subject is the user's **ID**, shown at the top of the user's page under **Users**.

---

## Keycloak

These steps use the admin console in recent Keycloak versions. You need a realm the staff accounts
live in; the examples use a realm called `acme`.

### 1. Create the client

1. In the realm, go to **Clients > Create client**.
2. Client type: **OpenID Connect**. Client ID: `unifeye`.
3. **Client authentication:** off (a public client; PKCE protects the code exchange). You can turn it
   on instead and set `OIDC_CLIENT_SECRET` from the **Credentials** tab.
4. **Authentication flow:** keep **Standard flow** on. Turn **Direct access grants** off.
5. Login settings:
   - Valid redirect URIs: `https://unifeye.example.com/api/auth/callback`
   - Valid post logout redirect URIs: `https://unifeye.example.com/signed-out`
   - Web origins: `https://unifeye.example.com`
6. Save. On the client's **Advanced** tab, set **Proof Key for Code Exchange Code Challenge Method**
   to `S256`.
7. On the **Settings** tab, under **Logout settings**: turn **Front channel logout** off, set
   **Backchannel logout URL** to `https://unifeye.example.com/api/auth/backchannel-logout`, and keep
   **Backchannel logout session required** on.

### 2. Choose who can sign in

The simplest way is a group.

1. Go to **Groups**, create a group called `unifeye`, and add the people who should have access.
2. Open **Clients > unifeye > Client scopes** and click **unifeye-dedicated**.
3. **Add mapper > By configuration > Group Membership**:
   - Name and Token Claim Name: `groups`
   - **Full group path:** off, so the value is `unifeye` and not `/unifeye`
   - **Add to ID token:** on
4. Save.

```env
OIDC_ADMIT_CLAIM=groups
OIDC_ADMIT_VALUES=unifeye
```

To use a realm role instead, give the role (for example `unifeye`) to the right people. Then, under
**Client scopes > roles > Mappers > realm roles**, turn on **Add to ID token**. That mapper adds roles
to the access token only by default. Then set:

```env
OIDC_ADMIT_CLAIM=realm_access.roles
OIDC_ADMIT_VALUES=unifeye
```

### 3. Refresh tokens

Unifeye asks for `offline_access`, so Keycloak issues an offline token that outlives the Keycloak
browser session. The user needs the `offline_access` realm role, which every user gets through the
realm's default roles unless you removed it. A disabled user's token is refused at the next check.

### 4. Settings

```env
OIDC_ISSUER=https://<keycloak host>/realms/acme
OIDC_CLIENT_ID=unifeye
OIDC_SCOPES=openid profile email offline_access
OIDC_ADMIT_CLAIM=groups
OIDC_ADMIT_VALUES=unifeye
BOOTSTRAP_ADMIN_ISSUER=https://<keycloak host>/realms/acme
BOOTSTRAP_ADMIN_SUBJECT=<user ID>
```

The subject is the user's **ID** (a UUID) on the user's **Details** tab under **Users**. Older
Keycloak versions put `/auth` before `/realms` in the issuer; copy the exact `issuer` value from
`<issuer>/.well-known/openid-configuration`.

---

## Microsoft Entra ID

These steps use the [Microsoft Entra admin center](https://entra.microsoft.com/). You need to be
able to register applications and manage enterprise applications in the tenant.

### Limits

- **Signing out of Microsoft doesn't end Unifeye sessions right away.** Entra doesn't send
  back-channel logout. Disabled accounts and revoked sessions are still noticed through the
  refresh-token check, within `OIDC_RECHECK_SECONDS`.
- **The client secret expires.** Entra secrets last at most two years. When one expires, nobody can
  sign in until you create a new secret and update `OIDC_CLIENT_SECRET`. Put the renewal in a
  calendar.

### 1. Register the application

1. Go to **Identity > Applications > App registrations > New registration**.
2. Name: `Unifeye`. Supported account types: **Accounts in this organizational directory only**
   (single tenant).
3. Redirect URI: platform **Web**, value `https://unifeye.example.com/api/auth/callback`. Use
   **Web**, not **Single-page application**: Unifeye exchanges the code on the server, which Entra
   refuses for single-page application redirects.
4. Register, then copy the **Application (client) ID** and **Directory (tenant) ID** from the
   overview page.
5. Under **Authentication**, add a second redirect URI: `https://unifeye.example.com/signed-out`.
   Entra only sends people back after sign-out to an address registered here. Leave the
   implicit-grant boxes unchecked.
6. Under **Certificates & secrets > Client secrets**, create a secret and copy its **Value** (not
   its ID). It's shown only once.

### 2. Claims

Under **Token configuration**, choose **Add optional claim**, token type **ID**, and add `email`.
Without it, the ID token often has no email address. Entra only fills it for users who have one
set.

### 3. Choose who can sign in

Use an app role. Members of your tenant who weren't given the role can't sign in.

1. In the app registration, open **App roles > Create app role**:
   - Display name: `Unifeye user`
   - Allowed member types: **Users/Groups**
   - Value: `Unifeye.User`
2. Go to **Identity > Applications > Enterprise applications**, open **Unifeye**, and under
   **Users and groups** assign the `Unifeye user` role to the people who should have access.
   Assigning a group instead of individual people needs an Entra ID P1 or P2 licence.
3. Under the enterprise application's **Properties**, set **Assignment required?** to **Yes**.
   Entra then refuses unassigned people before they reach Unifeye.

```env
OIDC_ADMIT_CLAIM=roles
OIDC_ADMIT_VALUES=Unifeye.User
```

Entra only includes `roles` in the ID token for people who were given a role, so everyone else is
refused.

Admitting on the `groups` claim also works but needs more care. Entra puts group object IDs (not
names) in the ID token, and leaves the list out entirely when someone is in more than about 200
groups. Unifeye then refuses that person. If you use groups, under **Token configuration > Add
groups claim** choose **Groups assigned to the application** to keep the list short, and put the
group's object ID in `OIDC_ADMIT_VALUES`.

### 4. Settings

```env
OIDC_ISSUER=https://login.microsoftonline.com/<tenant ID>/v2.0
OIDC_CLIENT_ID=<application (client) ID>
OIDC_CLIENT_SECRET=<secret value>
OIDC_SCOPES=openid profile email offline_access
OIDC_ADMIT_CLAIM=roles
OIDC_ADMIT_VALUES=Unifeye.User
BOOTSTRAP_ADMIN_ISSUER=https://login.microsoftonline.com/<tenant ID>/v2.0
BOOTSTRAP_ADMIN_SUBJECT=<subject>
```

Use the tenant ID in the issuer, not `common` or `organizations`; those don't have a fixed issuer.

The subject is **not** the user's object ID shown in the admin center. Entra gives each application
its own `sub` for a user. Use the steps in [The first administrator](#the-first-administrator) to
find it.

Refresh tokens: with `offline_access`, Entra issues a refresh token that Unifeye uses every
`OIDC_RECHECK_SECONDS`. Disabling a user, deleting them, or choosing **Revoke sessions** on their
page makes Entra refuse it, and Unifeye then ends that person's sessions. A Conditional Access policy
that requires the person to sign in again (for example after a sign-in frequency limit) also makes
the check fail. In that case they're signed out of Unifeye and simply sign in again.

---

## Google Workspace

Google sign-in works, with a few differences from the other two.

### Limits

- **Google asks for consent at every sign-in.** Google only hands out the refresh token Unifeye
  uses to re-check sessions when it shows its consent screen, so the settings below ask for it
  each time. People see a short "Unifeye wants to access your Google Account" page and click
  **Continue**. If you would rather skip it, see [Without refresh tokens](#without-refresh-tokens).
- **Signing out of Unifeye doesn't sign you out of Google.** People return to the signed-out page
  and stay signed in to their Google account.
- **No groups.** Google's ID token doesn't include Workspace groups, so you can admit a whole domain
  but not a subset of it. Control who sees what with groups and camera grants inside Unifeye; new
  people start with no cameras.

### 1. OAuth consent screen

In the [Google Cloud console](https://console.cloud.google.com/), create or select a project that
belongs to your Workspace organization.

1. Go to **APIs & Services > OAuth consent screen** (called **Google Auth Platform** in newer
   versions of the console).
2. User type / audience: **Internal**. Only accounts in your Workspace organization can then sign
   in.
3. Fill in the app name and support email. Scopes: `openid`, `email`, `profile`.

### 2. Create the client

1. Go to **APIs & Services > Credentials > Create credentials > OAuth client ID**.
2. Application type: **Web application**. Name: `Unifeye`.
3. Authorized redirect URIs: `https://unifeye.example.com/api/auth/callback`
4. Create it, then copy the **Client ID** and **Client secret**. Google requires the secret for web
   clients even with PKCE.

### 3. Settings

```env
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=<client ID>.apps.googleusercontent.com
OIDC_CLIENT_SECRET=<client secret>
OIDC_SCOPES=openid profile email          # leave out offline_access; Google does not support it
OIDC_AUTH_PARAMS=access_type=offline&prompt=consent
OIDC_ADMIT_CLAIM=hd
OIDC_ADMIT_VALUES=example.com             # your Workspace domain(s), comma-separated
BOOTSTRAP_ADMIN_ISSUER=https://accounts.google.com
BOOTSTRAP_ADMIN_SUBJECT=<subject>
```

`OIDC_AUTH_PARAMS` asks Google for a refresh token (`access_type=offline`) and makes it issue a new
one at every sign-in (`prompt=consent`); without `prompt=consent`, Google only issues one the first
time someone signs in. Unifeye uses the token every `OIDC_RECHECK_SECONDS` to check that the account
still works. When an account is suspended or deleted, Google should refuse the token and Unifeye ends
that person's sessions. Check this once with a test account, using step 6 of
[Checking a real identity provider](verification.md#checking-a-real-identity-provider).

Google keeps a limited number of refresh tokens per person for each client and quietly drops the
oldest past that (about 100). Someone with more Unifeye sessions than that open at once would lose
the oldest ones.

`hd` (hosted domain) is the Workspace domain of the account. Personal Gmail accounts don't have it,
so this rule also keeps them out if the consent screen is ever switched to External.

Google's subject is a long number that the admin console doesn't show. Use the steps in
[The first administrator](#the-first-administrator) to find it.

### Without refresh tokens

To skip the consent screen, leave `OIDC_AUTH_PARAMS` out. Unifeye then has no way to tell when a
Workspace account is suspended, and that person keeps access until their Unifeye session ends.
Shorten sessions to limit this, and disable people in Admin > People when they leave:

```env
SESSION_IDLE_MINUTES=240
SESSION_ABSOLUTE_HOURS=24
```

---

## Troubleshooting

**"Your account is not set up for Unifeye" for everyone.** The admission claim is missing from the
ID token or has a different name or value. The app log shows `sign-in refused` with reason
`not_admitted` and the claim it looked for. Paste an ID token into a JWT decoder you trust (or decode
the middle part with `base64 -d`) and compare its claims with `OIDC_ADMIT_CLAIM` and
`OIDC_ADMIT_VALUES`. Usual causes: the claim is only added to the access token, a group appears with
its full path (`/unifeye`), or a provider-specific scope is missing from `OIDC_SCOPES`.

**"The sign-in service is not reachable."** Unifeye couldn't load
`<OIDC_ISSUER>/.well-known/openid-configuration`. Check that the container can reach that address
and that `OIDC_ISSUER` matches the `issuer` in that document exactly (watch for a trailing slash).

**Entra: sign-in fails with error AADSTS9002327.** The redirect URI was registered under
**Single-page application**. Move it to the **Web** platform.

**"Sign-in could not be completed."** The provider sent people back but the token didn't check out.
The app log (`docker compose logs app`) has a `sign-in refused` line with the reason. Common ones: wrong client ID, a client secret set or missing, a
redirect URI that doesn't match exactly, or a clock that is off by more than 30 seconds.

**People appear without a name or email.** `name` or `email` isn't in the ID token. Turn on the
provider's option to put profile claims in the ID token (Zitadel: **User Info inside ID Token**;
Entra: add the `email` optional claim).

**The first administrator wasn't created.** The issuer or subject doesn't match exactly. Compare them
with the output of `node cli.mjs users`.
