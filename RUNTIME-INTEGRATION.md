# Runtime integration — precomputed head masks (Phase 0)

How the app uses the offline head-only masks at runtime, and how to regenerate
them. Scope so far: **Mad Lads only** (the collection with a tuned config).

## Flow

```
selectedNFT {collection, id}
  → useHeadMask()                       components/ar/useHeadMask.ts
      → fetch /masks/<collection>/index.json   (once per collection, cached)
      → look up String(id)
      → load /masks/<collection>/<id>.webp
  → status: "loading" | "available" | "unavailable"
      available   → composite the head mask by anchor/scale (computeMaskBox)
      unavailable → legacy path: full remote PFP + browser chroma-key
      loading     → neither (avoids a flash of the heavy legacy path)
```

- **Video / live camera:** [RecordView](components/ar/RecordView.tsx) picks the
  mask over the legacy `useNFTImage`+`useCutoutImage`, and passes `placement` to
  [FaceMaskCanvas](components/ar/FaceMaskCanvas.tsx), which draws it with
  `computeMaskBox` instead of the centered `computeFaceBox`. When a mask is used,
  `removeBackground` is **never called**.
- **Photo editor:** [PhotoEditor](components/photo/PhotoEditor.tsx) seeds the
  pre-placed slot from the mask when available (the slot is drag/`object-contain`,
  so no anchor math is needed there).
- **Fallback is preserved.** Any collection/token without a manifest entry (e.g.
  every non-Mad-Lads collection today) transparently uses the old path.

## The manifest

Written by [build-test-batch.ts](scripts/build-test-batch.ts) to
`public/masks/<id>/index.json` — the ONLY mask metadata the app reads (the
`mask-review/` outputs are for humans). Keyed by `String(token)`:

```json
{ "3": { "maskUrl": "/masks/mad-lads/3.webp", "thumbUrl": "/thumbs/mad-lads/3.webp",
         "anchorX": 0.5, "anchorY": 0.54, "scale": 1, "faceScale": 0.42,
         "qualityScore": 0.92, "needsReview": false } }
```

- URLs are stored **without** `BASE_PATH`; the runtime joins it via
  `withBasePath()` ([lib/basePath.ts](lib/basePath.ts)).
- It only contains the ~100-token **test batch**, not the whole collection. Tokens
  outside it correctly use the legacy fallback — expected, not a bug.

## Placement (`computeMaskBox`, [lib/imageUtils.ts](lib/imageUtils.ts))

The mask WebP has its face at normalized `(anchorX, anchorY)` inside the square,
spanning `faceScale` of the square's width. To map the mask's face onto the live
face (ear-to-ear width `faceW`, centre `cx,cy` from FaceMesh):

```
dw = faceW * (K + sizeOffset) / faceScale     // K = 1.15 framing multiplier
dw = dh                                         // square
dx = cx - anchorX * dw
dy = cy - anchorY * dw - dw * 0.06              // 6% upward nudge (eyes over eyes)
```

- **Flip:** not handled here. FaceMaskCanvas applies one geometric mirror
  (`translate(w,0); scale(-1,1)`); under it `dx = cx - anchorX*dw` stays correct,
  so the anchor is **not** mirrored (avoids double-mirroring).
- **`scale`:** already baked into the WebP at compose time — **not** re-applied.
- **Guards:** `sizeMultiplier = max(0.5, K + sizeOffset)`; if `faceScale` is
  missing/invalid, `FACE_SCALE_FALLBACK = 0.42` is used (no divide-by-zero / NaN).
- `faceScale = seg.faceWidth / side` (the detected facial core over the final
  square), added to metadata in [process.ts](scripts/mask/process.ts).

## Regenerate

```
npx tsx scripts/build-test-batch.ts mad-lads
```

Needs `.env.local` `HELIUS_API_KEY` + network. Writes the masks, thumbs,
`mask-review/mad-lads/*`, and `public/masks/mad-lads/index.json`.

Headless placement check (proof the formula lands the face on target):
`mask-review/mad-lads/placement-proof.png` (regenerate with the scratchpad
`place-proof.mjs`).

## Dev diagnostics

RecordView logs which path each selection takes:

```
[head-mask] precomputed mask: mad-lads/123     ← mask used, removeBackground NOT called
[head-mask] legacy fallback: smb-gen2/456      ← old chroma-key path
[head-mask] loading needsReview mask: mad-lads/481   ← flagged mask, still loaded
```
