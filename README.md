# SWITCH

Wear any NFT PFP as a live face mask, snap a photo or record a clip, and share it.
Multi-chain (Solana + Ethereum), mobile-first, and **fully on-device** — your
camera, microphone, and captures never leave your browser.

> A community tool. All NFT artwork, names, and trademarks belong to their
> respective owners; SWITCH only renders publicly available collection art you
> choose to wear.

---

## How it works

1. **Choose your wear** — the opening gallery lists curated collections (Solana
   first, then Ethereum), each with its own marketplace PFP.
2. **Find your token** — pick a collection, type your token number.
3. **Wear it** — the PFP tracks your face live (photo mode is the default and the
   PFP is on from the first frame).
4. **Snap / record → share** — capture a photo or clip and share or save it. It is
   created and held only on your device.

## Tech

- **Next.js 16** static export (`output: "export"`) — no server, no backend.
- **MediaPipe Tasks Vision** face mask + Canvas 2D compositing (`components/ar/*`).
- On-device background removal (`lib/removeBackground.ts`).
- Cross-platform capture with the iOS-Safari recording fixes
  (`components/recorder/useMediaRecorder.ts`).
- **Zustand** state, **Clash Display + Satoshi** fonts, dark + lime design system.

## Data pipeline (zero runtime backend)

Collections live in a registry (`lib/collections.ts`). Token indexes and cover
art are generated **once, locally** into `public/data/<id>.json` and
`public/collections/<id>.png`, then shipped with the static build. The running app
only reads those static files — **no API keys are bundled and nothing is fetched
from a private backend at runtime** (so there is nothing to host on Railway etc).

```bash
# one-time, on a dev machine (needs keys in .env.local — see .env.local.example)
npm run data:solana     # Helius DAS → Solana collections
npm run data:ethereum   # OpenSea v2 → Ethereum collections
npm run data:covers     # marketplace PFPs → gallery covers
# or, to test the app with placeholder art before fetching real data:
npm run data:sample
```

- **Solana** — Helius DAS `getAssetsByGroup` enumerates each collection; the token
  number is parsed from the asset name. Collection address auto-resolves from the
  Magic Eden symbol.
- **Ethereum** — OpenSea API v2; the ERC-721 `tokenId` is the number the user types.

## Develop

```bash
npm install
npm run data:sample   # placeholder data so every collection works offline
npm run dev           # http://localhost:3000
npm run build         # static export → out/
```

## Privacy & IP

- No accounts, no ads, no upload backend, no sale of data. Optional
  **Umami** (privacy-friendly, cookie-less) analytics is planned for aggregate
  usage only and is **not yet enabled**.
- Camera/mic/captures are processed only on-device. See `/privacy` and `/terms`.

## Repository notes (semi-open)

The parts that matter for **user safety and trust are open** — the full app code,
the on-device processing, and the privacy/terms pages. What is **not** committed
(see `.gitignore`): API keys (`.env.local`) and the **generated collection data +
covers** (`public/data/*.json`, `public/collections/`). Those are rebuilt locally
with `npm run data:*` and deployed with the build, keeping large scraped data —
and the specific curation — out of the public repo. No secrets or bulk data are
ever pushed to git.
