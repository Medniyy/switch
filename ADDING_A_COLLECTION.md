# Adding a normal collection

The simple path: a collection whose PFPs are worn via the on-device background
removal (chroma-key) fallback — **no precomputed head masks**. This needs no
changes to the camera, editor or renderer.

> Precomputed head masks (the `public/masks/<id>/*` pipeline in `scripts/mask`)
> are an optional per-collection enhancement and are **out of scope here** — a
> collection works without them. That pipeline will get its own doc later.

## 1. Register the collection

Add a `CollectionMeta` entry to `COLLECTIONS` in
[lib/collections.ts](lib/collections.ts):

```ts
{
  id: "my-collection",        // slug — used in routes (/c/my-collection) and file names
  name: "My Collection",      // full display name
  tag: "My Coll",             // short label under the gallery card
  chain: "solana",            // "solana" | "ethereum"
  accent: "#C6F432",          // optional card accent (defaults to the lime brand)
  hidden: true,               // keep hidden until data is generated; remove to show
  fetch: { via: "helius", meSymbol: "my_collection_me_symbol" },
  // Ethereum instead: fetch: { via: "opensea", slug: "my-opensea-slug" },
  // Or, keyless, straight from the contract's own metadata:
  // fetch: { via: "contract", contract: "0x…", firstId: 0 },
}
```

The registry is the single source of truth. Only this file is source you commit
for a new collection; the token index and cover below are **generated build
artifacts** (gitignored — see the README) that ship with the deploy.

## 2. Generate the token index (and cover)

Run the script that matches the collection's chain (keys live in `.env.local` —
see [.env.local.example](.env.local.example)):

```bash
npm run data:solana     # Helius DAS  → public/data/<id>.json   (needs HELIUS_API_KEY)
npm run data:ethereum   # OpenSea v2  → public/data/<id>.json   (needs OPENSEA_API_KEY)
npm run data:contract   # ERC-721 tokenURI → public/data/<id>.json   (no key)
npm run data:covers     # marketplace cover → public/collections/<id>.png
```

`data:contract` is the no-API-key path for an ERC-721 with uniform metadata. It
reads `tokenURI` / `totalSupply` from a public RPC, derives the image + name
template from the first token, then **verifies that template against four sampled
tokens across the range** and aborts rather than writing a bad index. The metadata
host doesn't matter — an IPFS directory (Pudgy Penguins) and an HTTPS API (Lil
Pudgys) both work, as long as only the id varies between tokens. `data:ethereum`
stays the general path for anything irregular.

Watch `totalSupply` vs the minted id range: burns make them diverge (Lil Pudgys
reports 21931 but ids run 0…22221). When they differ, pin the range with an
explicit `supply` — check the upper bound by binary-searching `ownerOf` for the
first id that reverts.

Each script iterates every registry collection it handles and writes
`public/data/<id>.json` ( `{ [tokenNumber]: { name, image } }` ). Re-running is
safe. No key / just testing? Use placeholder data instead:

```bash
npm run data:sample     # picsum art for every collection (skips existing; FORCE=1 to overwrite)
```

## 3. Confirm lookup and visibility

Remove `hidden` (step 1) so the collection joins `VISIBLE_COLLECTIONS`, then:

```bash
npm run dev
```

- **Home** (`/`) shows the new card in the carousel (`VISIBLE_COLLECTIONS`).
- **`/c/<id>`** → type a token number you know exists → the preview resolves
  (`getNFT` reads `public/data/<id>.json`).
- Failure signals: `[ UNKNOWN COLLECTION ]` = not in the registry;
  `[ NO #<n> IN <TAG> ]` = that number isn't in the generated JSON.

## 4. Confirm the fallback path works (no precomputed mask)

With no `public/masks/<id>/index.json`, `useHeadMask` resolves to `"unsupported"`
and the app uses the legacy on-device path (`useNFTImage` + `useCutoutImage` →
`lib/removeBackground.ts`). Select a token and open `/record`: the PFP's flat
background is chroma-keyed away in the browser and worn on your face. This is the
expected path for a normal collection — nothing else is required.

## 5. Confirm no core code changed

A normal collection touches only:

- `lib/collections.ts` (the registry entry), and
- generated `public/data/<id>.json` (+ optional `public/collections/<id>.png`).

`FaceMaskCanvas`, `MaskPreparationFlow`, `PhotoEditor`, `useMediaRecorder` and
`lib/imageUtils.ts` are **not** modified. If adding a collection made you edit any
of those, something is being done the hard way — stop and reconsider.
