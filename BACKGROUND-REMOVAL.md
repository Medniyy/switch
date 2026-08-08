# Background removal — how it works, what it costs, what's left

Answers the brief of 2026-08-07 ("must work for EVERY collection", "prioritize
a high-quality client-side solution", "don't patch collection by collection").

## What it is now

Nothing is uploaded anywhere. Two stages run on-device; the subject model is
bundled with the app and loaded lazily:

1. **Seeds** (`lib/removeBackground.ts`) — count the whole border ring, take
   the dominant colour cluster plus any shade that chains onto it, plus any
   *other* cluster that WRAPS the frame (≥8% of the border, present on 3+
   edges). Only pixels matching those may start the fill.
2. **Matte** (`lib/subjectMatte.ts`) — a pixel is background if it can be
   reached from a seed **without ever stepping over an edge** (a minimax /
   bottleneck path cost), where a "step" is *relative* contrast, not a raw
   channel delta.

`lib/prepareArtwork.ts` is the single entry point. Collection art and custom
uploads both call it: selfie segmenter (250KB, Apache-2.0, lazy) → matte →
untouched original. If the preferred result keeps an implausible amount of the
frame, a plausible fallback is promoted automatically.

## Why this shape

The old code judged each pixel by its distance to a sampled backdrop colour.
That cannot distinguish "smooth continuation of the backdrop" from "a
different thing that happens to be a similar colour", which produced every
failure we had, and is why three collections had been switched off:

| Failure | Old cause | Fixed by |
|---|---|---|
| Bullpen kept 13% of its vignette, bull sat in an olive disc | gradient drifts away from the sample | bottleneck path — a gradient is many tiny steps |
| Claynosaurz punched holes through faces | white eyes within tolerance of a pale backdrop | interiors are unreachable without crossing the outline |
| Sensei/Bullpen dark bodies eaten | a dark outline is only ~20 levels wide | relative contrast (÷ local brightness) scores it ~70 |
| Claynosaurz seeded inside the character | sampler assumed the top corners are backdrop | count the whole border ring instead |
| Hot Heads left half its scene | sky and mountains too far apart to chain | wrap-anchors (3+ edges) |

## Measured (24 tokens, all 12 collections, desktop Chrome)

Every token keys — no bails. 10–700ms each, no download.

**Clean by eye:** SMB Gen2, SMB Gen3, Mad Lads, Famous Foxes, Bo Doggos,
Sensei, Solana in Pajamas, The Bullpen, Pudgy Penguins, Lil Pudgys.

**Still imperfect — the honest gap:**
- **Claynosaurz** — depth-of-field outlines plus pale body parts on pastel
  gradients. Colour cannot separate a near-white belly from a near-white
  backdrop; only shape/semantics can.
- **Hot Heads** — 1/1 pixel-art *scenes* (sky, mountains, rooms). "Which
  region is background" is a semantic question here, not a colour one.

A fragmentation quality gate was prototyped to auto-reject mangled results
and **removed**: it rejected the good Bullpen cutout while passing the bad
Claynosaurz one, so it threw away more than it saved.

## If we want those two solved: the ML stage

Evaluated against the brief's licence constraints:

| Option | Licence | Verdict |
|---|---|---|
| `@imgly/background-removal` | **AGPL-3.0** | Licence decision for the whole app, not a library choice. Not adopted. |
| BRIA RMBG-1.4 | **non-commercial** | Ruled out, as flagged. |
| DeepLabV3 (MediaPipe) | Apache-2.0 | **Measured on our art: bailed 4/6, swiss-cheese mattes.** Trained on photographs; a stylised character is out of distribution. Rejected on quality, not licence. |
| Selfie segmenter (MediaPipe) | Apache-2.0 | **Shipped** as the default subject-aware pass for uploads and collection art; the matte remains the fallback. |
| **U²-Netp via onnxruntime-web** | Apache-2.0 (model), MIT (runtime) | **The recommended next POC.** Salient-object detection generalises to illustration far better than semantic segmentation. ~4.7MB model + ORT wasm. |

Cost of that path: a real dependency and a multi-MB lazy download for two
collections. Worth prototyping against Claynosaurz + Hot Heads specifically
before committing — per the brief, judged on our art, not on demos.

## When it gets the subject wrong (2026-08-08)

Neither engine can reliably tell you it failed — a fragmentation quality gate
was built and removed because it rejected the good Bullpen cutout while
passing the mangled Claynosaurz one. So the handling is: **route better, and
make failure a tap to fix instead of a dead end.**

1. **The subject-aware result comes first.** Both collection art and uploads
   pass `preferSegmenter`. Sensei #22 proved that the matte can report plausible
   coverage while erasing most of a dark character; the segmenter preserves it.
   The matte is still promoted when the model fails or keeps an implausible
   amount of the frame.
2. **Losers are kept, not discarded.** `prepareArtwork` returns
   `alternatives` (every other engine that produced something, always ending
   in the untouched original) plus a `suspicious` flag for an implausible
   amount kept or removed. /create shows them as EDGE CUTOUT / AI CUTOUT /
   KEEP ORIGINAL. The editor's "Remove background" is deterministic and always
   reprocesses the untouched artwork, so repeat presses cannot compound alpha
   or silently switch engines.

This does not make a bad cutout good. It makes it recoverable without the
brush, which is the honest thing we can do before adding a model that
understands subjects generally (U²-Netp, above).

## Performance / UX properties the brief asked for

- **Lazy, never bulk.** Processing happens when a token is prepared, never
  across a collection.
- **Cached.** The prepared bitmap is stored in IndexedDB (`SavedUserMask`)
  and reused; a PFP is processed once per device.
- **Automatic by default**, with a visible **Remove background** button (and
  **Bring back full artwork**) in the mask editor on desktop *and* mobile,
  with undo.
- **No main-thread inference for the matte** is still open: it is 10–700ms of
  synchronous JS during preparation. Moving it into a Worker is the obvious
  next optimisation and matters most on low-end Android.
- **Untested on real mobile hardware.** Every number here is desktop Chrome.
