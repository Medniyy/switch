# SWITCH — Architecture

A one-page map of how the app is put together. For the precomputed head-mask
runtime see [RUNTIME-INTEGRATION.md](RUNTIME-INTEGRATION.md).

## What it is

A mobile-first web app that lets you wear an NFT PFP as a live, face-tracked mask,
then snap a photo or record a clip and share it. It is a **Next.js static export**
(`next.config.ts` → `output: "export"`) — plain HTML/JS/CSS + assets, no API routes.
React 19, Zustand for state, MediaPipe Tasks Vision (self-hosted WASM + model) for
face landmarks, Canvas 2D for compositing.

## Core architectural principle

> The core camera, tracking, editing and rendering experience is currently
> client-side. Any future backend functionality should remain optional and
> isolated from the core local media pipeline.

Everything that touches the camera, face tracking, editing, rendering and export
runs in the browser today. This is not "no backend forever" — a future service
(e.g. AI) may exist, but it must stay **optional** and **outside** the local media
path, so the core experience keeps working with no backend present.

## Main data flows

**Selection** — pick a collection and token, load it into state:

```
Home (app/page.tsx) → CollectionFinder (/c/[collection])
   type token number → getNFT() (lib/nftData.ts, reads /data/<id>.json)
   → useAppStore.setSelectedNFT(nft) → router.push("/record")
```

**Rendering** — the live loop that produces the recordable canvas:

```
useCameraStream ─┐
useFaceMesh ─────┤
selectedNFT ─────┴→ RecordView → FaceMaskCanvas (rAF loop):
    resolve mask: useHeadMask (precomputed) | useNFTImage+useCutoutImage (fallback)
                  | loadSavedMask (IndexedDB, user-prepared)
    draw video → detect landmarks → similarity transform (lib/imageUtils.ts)
              → EMA smoothing → draw mask (rotate around anchor) → write LiveMaskTrack
    → useMediaRecorder records the canvas → RecordingResult
```

## Where responsibilities live

| Area | Location |
| --- | --- |
| Routing / shell | `app/**`, `components/layout/AppShell.tsx` |
| Global state | `store/useAppStore.ts` (one flat store) |
| Render math (pure, no React) | `lib/imageUtils.ts` — the tested core, exposed to tests via `__switchMath` |
| Live compositing loop | `components/ar/FaceMaskCanvas.tsx` |
| Camera / mic lifecycle | `components/ar/useCameraStream.ts`, `lib/audio.ts` |
| Face landmarker | `components/ar/useFaceMesh.ts`, `lib/mediapipe.ts` |
| Recording | `components/recorder/useMediaRecorder.ts` |
| Mask preparation + brush editor | `components/mask-prep/MaskPreparationFlow.tsx` |
| Photo composition (multi-PFP) | `components/photo/PhotoEditor.tsx`, `lib/photo.ts` |
| Saved-mask persistence | `lib/userMasks.ts` (IndexedDB, versioned + migrated) |
| Collections registry | `lib/collections.ts` (single source of truth) |
| Static token data | `lib/nftData.ts` + generated `public/data/<id>.json` |
| Precomputed head masks | `components/ar/useHeadMask.ts` + `public/masks/<id>/*` |
| Effects | `lib/bananaRain.ts` (one effect today, self-contained) |

## The live-camera ↔ photo-editor seam

There are two "wear a PFP" surfaces and one bridge between them:

- **Live camera** (`FaceMaskCanvas`) places the mask with a full similarity
  transform — facial anchor + ear-to-ear scale + in-plane roll — and writes the
  latest draw to a `LiveMaskTrack` ref every frame.
- **Photo editor** (`PhotoEditor`) places PFPs as free slots (centered box,
  `object-contain`, no face anchor) that the user drags/scales/rotates.
- **The bridge** is `placementFromLiveTrack` in `components/ar/RecordView.tsx`:
  when you snap a photo, it converts the live `LiveMaskTrack` (canvas space, inside
  a possibly-mirrored context) into an editor `InitialPlacement` (photo space) so
  the worn PFP lands exactly where it sat on your face. This mirror/rotation/anchor
  math is subtle — treat it as a real contract, not incidental glue.

## Rules future development should preserve

1. **Keep the core client-side.** Any backend is optional and isolated from the
   local media pipeline (see the principle above).
2. **Keep render math pure** in `lib/imageUtils.ts` — no React, no DOM. It is the
   unit-tested seam; logic added there stays testable without a camera.
3. **Keep mask-image consumers provenance-agnostic.** The renderer/editor take an
   `HTMLImageElement` (+ optional placement); they never assume how it was produced
   (NFT art, user edit, or a future AI/constructed asset). Don't add that assumption.
4. **Collections are data.** A normal collection is added via `lib/collections.ts`
   + generated `public/data` — never by editing camera, editor or renderer code
   (see [ADDING_A_COLLECTION.md](ADDING_A_COLLECTION.md)).
5. **Gate features by stable collection id**, never by display-name matching
   (e.g. `isMonkeyDaoCollection` in `lib/collections.ts`).
6. **Keep effects self-contained** in their own `lib/<effect>.ts` like
   `bananaRain.ts`; don't build an effect framework for a single effect.
7. **Keep `FaceMaskCanvas` source-agnostic.** It takes a plain `<video>` element,
   not a `MediaStream`; preserve that so an uploaded video can reuse the same loop.
8. **Keep dev/test seams dev-only** (`__switchMath`, `__switchMaskEditor`,
   `__appStore`) — guarded by `process.env.NODE_ENV !== "production"`.
