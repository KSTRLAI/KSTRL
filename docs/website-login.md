# KSTRL ↔ website and API: what your side needs to do

This is the contract between the KSTRL desktop app, your website (kstrlsi.base44.app) and your API server (the one in front of Unsloth). Give it to whoever builds the website and server.

## 1. Logging in from the app

When someone clicks **Log in** in KSTRL, the app opens this page in their browser:

```
https://kstrlsi.base44.app/app-login?state=<random>&redirect_uri=kstrl://auth&app=desktop
```

The `app-login` page must:

1. If the visitor isn't logged in on the website, show your normal login, then continue.
2. Find (or create) that user's **API key**.
3. Redirect the browser to:

```
kstrl://auth?state=<the same state>&key=<api key>&name=<display name>&email=<email>
```

- `state` must be copied back exactly. KSTRL ignores links with a state it didn't create in the last 15 minutes.
- `name` and `email` are optional. They're shown in the app until the account endpoint answers.
- Optional `api_url=https://…`: tells a fresh install where your API is. It's only used if the app has no API URL yet, and must be https.
- On failure, redirect to `kstrl://auth?state=<state>&error=<message>`. The app shows the message.

A logged-in visitor never sees a form: they click Log in in the app, the browser flashes, and they're back in KSTRL, logged in. Browsers usually ask "Open KSTRL?" the first time.

URL-encode the values (`encodeURIComponent`).

## 2. The API key

Every request from KSTRL to your API carries `Authorization: Bearer <api key>`. Your server should:

- Reject unknown or revoked keys with **401**. The app then asks the user to log in again.
- Track usage per key and refuse requests when the daily limit is used up, with **429** and a body containing `usage_limit`, e.g. `{"error":{"code":"usage_limit","message":"Daily usage limit reached"}}`.

## 3. Account endpoint (plan and usage)

```
GET {API_URL}/v1/kstrl/account
Authorization: Bearer <api key>
```

Response:

```json
{
  "name": "Amir",
  "email": "amir@example.com",
  "plan": "free",                  // "free" or "max"
  "usage": { "used": 412.5, "limit": 2500, "resetsAt": 1767225600000 }
}
```

- `used` and `limit` are credits for today. `resetsAt` is a Unix time in milliseconds (optional; defaults to local midnight).
- KSTRL calls this at launch, every 10 minutes, and after every reply. It shows these numbers in Plan & Usage and blocks chat when `used >= limit`.
- If this endpoint doesn't exist (404), KSTRL falls back to counting usage on the PC, which anyone can bypass. The server-side numbers are what make limits and MAX real.

### Credits formula (so the server and app agree)

```
credits = (prompt_tokens + 3 × completion_tokens) / 1000 × model weight × mode weight
```

| Model (server model the app asks for) | weight |
|---|---|
| Colossus 2 | 0.5 |
| Colossus 2.1 | 1 |
| Colossus 2.2 | 1.6 |
| Colossus 2.2 UC (UltraCode) | 2.5 |
| Colossus 3 | 4 |

| Mode | weight |
|---|---|
| Build | 1 |
| Plan | 0.5 |
| Ask | 0.35 |
| Tab autocomplete | 0.15 |

Daily limits: Free 2,500, KSTRL MAX 50,000 (20×).

The app sends the mode in the `X-KSTRL-Mode` header (`build`, `plan`, `ask`, `complete`) and the Colossus model in `X-KSTRL-Model`, so the server can apply the same weights.

## 4. Upgrading to MAX

Take payment on the website (e.g. Stripe) and mark the account as `max`. The account endpoint then returns `"plan": "max"` and the app picks it up within 10 minutes, or right away after the next reply.

## 5. Crash reports (optional)

If a user turns on **Settings → General → Send Crash Reports**, KSTRL posts errors to:

```
POST {API_URL}/v1/kstrl/crash
Authorization: Bearer <api key>
{ "version": "1.5.0", "platform": "win32", "arch": "x64", "source": "main|renderer|process", "message": "…", "stack": "…" }
```

The home folder is replaced with `~` before sending; no code or chats are included. Each distinct error is sent at most once an hour. Errors are always written locally to the logs folder (Settings → General → Open Logs Folder).

## 6. Built-in API URL

Set the repository variable **KSTRL_API_URL** (GitHub → repo → Settings → Secrets and variables → Actions → Variables) to your API's address, e.g. `https://api.kstrl.ai`. The next build includes it, so the login dialog no longer asks for an API URL.
