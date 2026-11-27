# KSTRL ↔ website and API: what your side needs to do

This is the contract between the KSTRL desktop app, your website (kstrlsi.base44.app) and your API server (the one in front of Unsloth). Give it to whoever builds the website and server.

## 1. Logging in through the website (optional — the app has its own screen now, see section 8)

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

## 7. Automatic keys (no website needed)

On first launch, if KSTRL knows your API URL (see section 6) and has no key yet, it asks your server for one:

```
POST {API_URL}/v1/kstrl/register
Content-Type: application/json
{ "install_id": "6f1c…-uuid", "platform": "win32", "version": "1.5.1" }
```

Respond with:

```json
{ "key": "sk-…", "plan": "free" }
```

Server rules:

- **Same install_id → same key.** Look the ID up first, so restarts and reinstalls don't create new keys.
- **New install_id → create a key** with your runner's key function on the Free plan, and save `install_id → key` along with the caller's IP.
- **Rate-limit key creation**, e.g. at most 3 new keys per IP per day and a global cap per hour. Answer **429** when it's exceeded. The app quietly tries again on its next launch.
- **Banned installs → 403.** The app then shows Log in. Don't create a new key for them.
- **The master/admin key never leaves the server.** This endpoint creates keys internally.
- If you revoke an automatic key, requests with it get **401**. The app then calls `/register` again (at most every 10 minutes): return a new key to let the install back in, or 403 to keep it out.

If this endpoint doesn't exist (404), KSTRL falls back to Log in / paste a key. Logging in through the website replaces the automatic key with the person's account key.

## 8. Sign up / Log in inside the app (since KSTRL 1.7)

KSTRL now has its own Sign up / Log in screen, so people don't need the website. It shows once on first launch and from **Log In / Sign Up** in the account menu. The app calls your API directly:

```
POST {api}/v1/kstrl/auth/signup   { "name": "...", "email": "...", "password": "...", "install_id": "<uuid>" }
POST {api}/v1/kstrl/auth/login    { "email": "...", "password": "...", "install_id": "<uuid>" }
→ 200 { "key": "<api key for this device>", "name": "...", "email": "...", "plan": "free" | "max" }

POST {api}/v1/kstrl/auth/logout   (Authorization: Bearer <key>)  → 204, revokes that device's key
```

Errors use the usual `{ "error": { "code": "...", "message": "..." } }`; the app shows `message`. Codes the app understands: `email_taken` (409, switches to Log in), `bad_credentials` (401), `weak_password` / `bad_email` (400), `rate_limited` (429), `banned` (403).

- The password is sent once over HTTPS and never stored by the app. Store only a slow hash (Launch uses scrypt).
- Each log-in gets its own key, so logging out on one device doesn't affect the others.
- Count usage per **account**, not per key, so MAX/Free limits apply across all of a person's devices (Launch does this).
- The profile shows the account's **email**.
- If the server returns 404 for these endpoints, the app says "This server doesn't support KSTRL accounts yet." Automatic Free keys (section 7) keep working either way.

Launch implements all of this. Manage accounts in the Launch window's **Accounts** tab, or with `launch users list`, `launch users plan <email> max` and `launch users ban <email>`.

## 9. Context window

Settings → Agents → Context Window (default 12k tokens). Before each model turn, KSTRL trims old tool output and, if that isn't enough, summarises earlier work so every request fits. With a window set, requests also send `max_tokens` equal to the room the prompt leaves, so run Launch with `--ctx` at least as big as the window (the Launch app defaults to 16384).
