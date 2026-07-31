---
name: add-collection
description: Add a new wearable NFT collection to SWITCH — registry entry, token index, cover art, and the checks that catch a bad one. Use when asked to add, enable, un-hide or re-sync a collection, or when given a Magic Eden / OpenSea / contract link.
---

# Adding a collection

[ADDING_A_COLLECTION.md](../../../ADDING_A_COLLECTION.md) is the reference. This
skill is the operational version: the order to do things in, and the traps that
have actually bitten.

A normal collection touches **two source files at most** — `lib/collections.ts`
and (rarely) a build script. `FaceMaskCanvas`, `MaskPreparationFlow`,
`PhotoEditor` and `lib/imageUtils.ts` are never edited to add one. If you find
yourself in those, stop.

## 1. Probe before you register

Confirm the collection resolves and see what the art looks like:

```bash
curl -s "https://api-mainnet.magiceden.dev/v2/collections/<me_symbol>/listings?limit=1"
```

The response gives you the display name, a token name (check the `#<n>` pattern
`numberFromName` relies on) and an image URL. No listings = no resolution path;
pin `collectionAddress` in the registry instead.

## 2. Register it hidden

Add the `CollectionMeta` to `COLLECTIONS` in [lib/collections.ts](../../../lib/collections.ts)
with `hidden: true`. Pick `accent` later — you need the art first.

## 3. Generate the index and cover

```bash
npm run data:solana     # via: "helius"    (needs HELIUS_API_KEY)
npm run data:ethereum   # via: "opensea"   (needs OPENSEA_API_KEY)
npm run data:contract   # via: "contract"  (keyless, public RPC)
npm run data:covers
```

Each script loops **every** registry collection of its kind. That is safe and
idempotent — re-running rewrites the others byte-identically, and an index is
only rewritten on success, so a failed fetch cannot truncate one.

## 4. Verify — this is the part that matters

Do all four. Each has caught a real problem.

**Token count and id range.** A gappy index is usually burned tokens, not a bug:

```bash
node -e "const d=require('./public/data/<id>.json');const k=Object.keys(d).map(Number).sort((a,b)=>a-b);console.log('count',k.length,'min',k[0],'max',k.at(-1))"
```

For `via: "contract"`, `totalSupply()` is **not** the id range when tokens are
burned. Lil Pudgys reports 21931 but ids run 0…22221 — trusting it silently
drops the top 291. Binary-search `ownerOf` for the first reverting id and pin
`supply`.

**CORS on the image host.** The canvas pipeline taints without it, and the
failure is silent until export:

```bash
curl -s -o /dev/null -D - -H "Origin: https://switchsol.xyz" "<image url>" | grep -i "access-control-allow-origin"
```

Check *every* host in the index, not just the first — collections mix hosts.

**Background flatness** decides `autoCutout`. Sample corners across several
tokens with `sharp`. Four corners the same flat colour → chroma-key works, leave
`autoCutout` alone. Backdrop and garment sharing an RGB (Sensei's black-on-black)
→ set `autoCutout: false` so the editor seeds untouched art.

**Look at the cover.** Read the generated `public/collections/<id>.png`. If it is
a pre-reveal silhouette or placeholder, the collection NFT never got real art —
set `coverFromToken: true` and re-run `data:covers`. Do not hand-drop a file in;
the next `data:covers` overwrites it.

## 5. Un-hide and prove it

Remove `hidden`, pick `accent` from the art, then:

```bash
npx tsc --noEmit && npm run lint && npm test && npm run build
```

Drive the real app with the **drive-app** skill: the collection page must resolve
a token, and the mask editor must show a clean cutout on the checkerboard. A
healthy bust PFP clears ~40–50% of the frame with all four corner alphas at 0.
80%+ cleared means the chroma-key ate the character.

Nothing else is needed — no precomputed masks, and analytics picks the collection
up automatically (stats key off `open:<id>` generically).
