# Runtime integration — precomputed head masks (Phase 0)

How the app uses precomputed head-only masks at runtime.

> **Status: dormant.** No collection ships a mask manifest today, so
> `useHeadMask` resolves every token to `"unsupported"` and the on-device path
> (background removal + the user-assisted mask editor) handles everything. This
> document describes the mechanism, which stays in the code ready for use.

## Flow

```
selectedNFT {collection, id}
  → useHeadMask()                       components/ar/useHeadMask.ts
      → fetch /masks/<collection>/index.json   (once per collection, cached)
      → look up String(id)
      → load /masks/<collection>/<id>.webp
  → status: "loading" | "available" | "unsupported" | "rejected"
      available   → composite the head mask by anchor + scale + roll
                    (computeMaskTransform, see Placement below)
      unsupported → legacy path: full remote PFP + browser chroma-key
      rejected    → prepared mask failed runtime approval; NO legacy fallback
                    (show a "not ready" state — see useHeadMask)
      loading     → neither (avoids a flash of the heavy legacy path)
```

- **Video / live camera:** [RecordView](components/ar/RecordView.tsx) picks the
  mask over the legacy `useNFTImage`+`useCutoutImage`, and passes `placement` to
  [FaceMaskCanvas](components/ar/FaceMaskCanvas.tsx), which draws it with a full
  similarity transform (`computeMaskTransform` for a placement mask,
  `computeCenteredMaskTransform` for a user-prepared one). When a mask is used,
  `removeBackground` is **never called**.
- **Photo editor:** [PhotoEditor](components/photo/PhotoEditor.tsx) seeds the
  pre-placed slot from the mask when available (the slot is drag/`object-contain`,
  so no anchor math is needed there).
- **Fallback is preserved.** Any collection/token without a manifest entry (e.g.
  every non-Mad-Lads collection today) transparently uses the old path.

## The manifest

Written by the offline pipeline to `public/masks/<id>/index.json` — the ONLY
mask metadata the app reads. Keyed by `String(token)`:

```json
{ "3": { "maskUrl": "/masks/mad-lads/3.webp", "thumbUrl": "/thumbs/mad-lads/3.webp",
         "anchorX": 0.5, "anchorY": 0.54, "scale": 1, "faceScale": 0.42,
         "qualityScore": 0.92, "needsReview": false,
         "approvedForRuntime": true, "rejectionReasons": [] } }
```

- URLs are stored **without** `BASE_PATH`; the runtime joins it via
  `withBasePath()` ([lib/basePath.ts](lib/basePath.ts)).
- It only contains the ~100-token **test batch**, not the whole collection. Tokens
  outside it correctly use the legacy fallback — expected, not a bug.

## Placement (`computeMaskTransform`, [lib/imageUtils.ts](lib/imageUtils.ts))

The mask WebP has its face at normalized `(anchorX, anchorY)` inside the square,
spanning `faceScale` of the square's width. The renderer maps that onto the live
face as a 2D **similarity transform** (centre + uniform scale + in-plane roll),
NOT an axis-aligned box — so the mask tracks head tilt. From FaceMesh:

```
faceW     = hypot(ear→ear)                    // Euclidean → roll-invariant
centerX   = ear midpoint x
centerY   = forehead↔chin midpoint y
rotation  = eye-line angle                     // in-plane roll (radians)
drawWidth = clamp(faceW * (K + sizeOffset) / faceScale,
                  faceW * 1.2, faceW * 8)      // K = 1.15 (MASK_TRACK_K)
```

The mask is then drawn AROUND its facial anchor:

```
translate(centerX, centerY); rotate(rotation); [flip];
drawImage(mask, -anchorX*dw, -(anchorY + 0.06)*dw, dw, dw)   // 0.06 = MASK_UP_NUDGE
```

where `dw = drawWidth * BASE_COVERAGE_SCALE * rollCoverageScale(rotation)` — a
small, capped overhang so the avatar hides the real hairline.

- **User-prepared masks** (no placement) use `computeCenteredMaskTransform`, which
  returns the SAME shape with the anchor at the square centre (0.5, 0.5) and
  `drawWidth = max(faceW, faceH) * (1.4 + sizeOffset)`. Both paths share one
  smoothed, rotated draw.
- **Manual fit** (`applyMaskFit`) adds the user's left/right, up/down and scale
  offsets in the mask's LOCAL (rotated) frame, so a positioned mask stays attached
  under roll.
- **Smoothing:** every transform is time-based EMA-smoothed with per-frame outlier
  clamps (`smooth` in FaceMaskCanvas), so tracking never jitters or teleports.
- **Flip:** not handled in the math. FaceMaskCanvas applies one geometric mirror
  (`translate(w,0); scale(-1,1)`); under it the centre/rotation stay correct, so
  the anchor is **not** mirrored (avoids double-mirroring).
- **`scale`:** already baked into the WebP at compose time — **not** re-applied.
- **Guards:** `sanitizePlacement` drops an implausible anchor/faceScale back to the
  centered transform; a missing/invalid `faceScale` falls back to
  `FACE_SCALE_FALLBACK = 0.42` (no divide-by-zero / NaN); `drawWidth` is
  hard-clamped to `[faceW*1.2, faceW*8]` so even corrupt metadata can't explode it.
- `faceScale = seg.faceWidth / side` (the detected facial core over the final
  square), written into the manifest by the generator.

## Generating masks

Masks are produced by the offline pipeline, which lives outside this repo. It
emits `public/masks/<collection>/` (the `.webp` masks plus `index.json`) and
`public/thumbs/<collection>/`; dropping those two directories in is all the app
needs — no code change.

## Dev diagnostics

RecordView logs which path each selection takes:

```
[head-mask] precomputed mask: mad-lads/123                    ← mask used, removeBackground NOT called
[head-mask] unsupported token, legacy fallback: smb-gen2/456  ← old chroma-key path
[head-mask] rejected precomputed mask: mad-lads/481           ← failed approval, NOT used (no fallback)
```
