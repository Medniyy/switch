# Testing SWITCH on a real phone

## Why `http://<your-LAN-IP>:3000` looks broken on a phone

The live camera is the core of the app. `navigator.mediaDevices.getUserMedia()`
(and other powerful web APIs) are only exposed in a **secure context**: HTTPS, or
the special hostnames `localhost` / `127.0.0.1`.

A phone reaches your dev machine by its **LAN IP over plain HTTP**
(`http://192.168.x.x:3000`), which is **not** a secure context. Measured directly:

| Origin | `isSecureContext` | `navigator.mediaDevices` | IndexedDB | assets |
| --- | --- | --- | --- | --- |
| `http://localhost:3000` | `true` | available | works | load 200 |
| `http://127.0.0.1:3000` | `true` | available | works | load 200 |
| `http://192.168.0.100:3000` | **`false`** | **`undefined`** | works | load 200 |

So on the LAN IP the page **loads fine** (HTML/JS/CSS/images all 200, IndexedDB
works) but the camera can never start — which makes the whole experience appear
broken. **This is not a CSS/layout bug and not a CORS/asset problem.** It is the
HTTP secure-context restriction.

### Secondary (dev-only): hot-reload over the LAN

Next.js 15+/16 blocks cross-origin requests to dev resources (the HMR websocket)
from non-localhost origins:

```
⚠ Blocked cross-origin request to Next.js dev resource /_next/webpack-hmr from "192.168.0.100".
```

This only disables **hot-reload** over the LAN; it does not break the running app.
To allow it, set `DEV_LAN_ORIGIN` before starting dev (see below). Nothing is
loosened by default.

## The fix: serve the phone over HTTPS

You need a **browser-trusted HTTPS URL** the phone can open. Options, best first:

### Option A (recommended) — a quick tunnel (trusted cert, zero device setup)

Keep `npm run dev` running, then in another terminal expose it with a tunnel that
provides a real, publicly-trusted certificate:

```bash
# Cloudflare (no account needed for a quick tunnel):
cloudflared tunnel --url http://localhost:3000
#   → prints https://<random>.trycloudflare.com  — open THAT on the phone

# or ngrok:
ngrok http 3000
#   → prints https://<random>.ngrok-free.app
```

The phone opens the `https://…` URL, gets a valid cert (no warnings, no CA to
install), and the camera works. Best for fast iterative testing. Note the tunnel
URL is temporary and public-by-obscurity — fine for personal testing; don't leave
it running unattended.

### Option B — private HTTPS preview deploy (most stable)

SWITCH is a **pure static export** (`output: "export"`), so any static host gives
you real HTTPS instantly. Deploy a **private/password-protected preview**:

- Vercel: `vercel` (preview deployments are private to your account; add Password
  Protection for extra safety).
- Cloudflare Pages / Netlify: drag-drop the `out/` folder or connect the repo.

Use this when you want a stable URL to test on several devices, not per-keystroke.

### Option C — `next dev --experimental-https` (localhost only; NOT for phones)

```bash
npm run dev:https      # next dev --experimental-https --hostname 0.0.0.0
```

This generates a **self-signed cert via `mkcert`** and, on first run, tries to
install an `mkcert` root CA into your OS trust store (interactive; may prompt for
your password / elevation). It makes `https://localhost:3001` a secure context on
**your desktop**, which is useful for desktop camera testing.

It is **not** a good phone method:
- the generated cert is for `localhost`, not your LAN IP, so a phone hitting the IP
  gets a certificate-mismatch error;
- the phone doesn't trust the `mkcert` root CA (installing a custom CA on iOS is
  impractical).

Do **not** tell testers to "ignore the certificate warning" — that trains unsafe
behavior and doesn't give a secure context anyway. Use Option A or B for phones.

## Enabling LAN hot-reload (optional, dev only)

If you specifically want hot-reload while opening the dev server by LAN IP:

```bash
# Windows PowerShell
$env:DEV_LAN_ORIGIN="192.168.0.100:3000"; npm run dev
# bash
DEV_LAN_ORIGIN="192.168.0.100:3000" npm run dev
```

`next.config.ts` passes this to `allowedDevOrigins` (only the host you provide).
Replace the IP with your machine's current LAN address. Remember: this restores
hot-reload, but the camera still needs HTTPS (Option A/B) because of the
secure-context rule above.

## Summary

- **App-breaking root cause:** HTTP secure-context → no `mediaDevices` → no camera.
  Fix = serve the phone over trusted HTTPS (tunnel or private preview).
- **Dev hot-reload over LAN:** Next dev-origin block → set `DEV_LAN_ORIGIN`.
- Neither is a layout bug; the responsive UI renders correctly on the LAN IP.
