# Fonts

SWITCH self-hosts two variable fonts (single TTF each, all weights):

- **Clash Display** — display / headings (`--font-display`)
- **Satoshi** — body / UI (`--font-body`)

Both are by the **Indian Type Foundry**, distributed free via
[Fontshare](https://www.fontshare.com) under the Fontshare / ITF Free Font
Licence (free for personal and commercial use, self-hosting permitted). Downloaded
from `https://api.fontshare.com/v2/fonts/download/clash-display` and `/satoshi`.

Wired in `app/layout.tsx` via `next/font/local`. Self-hosting keeps production
builds from depending on a font CDN at `next build` time.
