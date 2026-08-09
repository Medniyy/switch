# Background removal — how it works, what it costs, what's left

Answers the brief of 2026-08-07 ("must work for EVERY collection", "prioritize
a high-quality client-side solution", "don't patch collection by collection").

## What it is now

Nothing is uploaded anywhere. The engines run on-device and their models are
self-hosted and loaded lazily:

1. **Seeds** (`lib/removeBackground.ts`) — count the whole border ring, take
   the dominant colour cluster plus any shade that chains onto it, plus any
   *other* cluster that WRAPS the frame (≥8% of the border, present on 3+
   edges). Only pixels matching those may start the fill.
2. **Matte** (`lib/subjectMatte.ts`) — a pixel is background if it can be
   reached from a seed **without ever stepping over an edge** (a minimax /
   bottleneck path cost), where a "step" is *relative* contrast, not a raw
   channel delta.

`lib/prepareArtwork.ts` is the single entry point. Custom uploads use U²-Netp
(4.6MB, Apache-2.0, lazy) for a general-subject alpha matte, then MediaPipe
selfie segmentation (250KB, Apache-2.0) as a compatibility
fallback. The deterministic edge matte and untouched original remain recovery
choices. If the preferred result keeps an implausible amount of the frame, a
plausible fallback is promoted automatically.

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

## The general-subject ML stage

Evaluated against the brief's licence constraints:

| Option | Licence | Verdict |
|---|---|---|
| `@imgly/background-removal` | **AGPL-3.0** | Licence decision for the whole app, not a library choice. Not adopted. |
| BRIA RMBG-1.4 | **non-commercial** | Ruled out, as flagged. |
| DeepLabV3 (MediaPipe) | Apache-2.0 | **Measured on our art: bailed 4/6, swiss-cheese mattes.** Trained on photographs; a stylised character is out of distribution. Rejected on quality, not licence. |
| Selfie segmenter (MediaPipe) | Apache-2.0 | **Shipped** as the lightweight compatibility fallback. |
| MODNet via onnxruntime-web | Apache-2.0 (model), MIT (runtime) | **Removed after live testing.** Portrait-only training is the wrong domain for arbitrary PFP artwork. |
| **U²-Netp via onnxruntime-web** | Apache-2.0 (model), MIT (runtime) | **Shipped.** Salient-object detection handles portraits, products, animals, and illustration rather than requiring a human class. 4.6MB model + ORT wasm. |

The model is lazy and cached. It adds a 4.6MB first-use download to the shared
ONNX Runtime, and it was evaluated on real BoDoggos plus a portrait before
being wired into the common preparation path.

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
   amount kept or removed. `/create` intentionally offers only the smart CUTOUT
   and KEEP ORIGINAL; the unreliable edge result is replaced by an EDIT action
   that opens the full mask editor. The editor's "Remove background" is
   deterministic and always reprocesses the untouched artwork, so repeat
   presses cannot compound alpha or silently switch engines.

This does not make every bad cutout good. It combines a general-subject model,
a deterministic edge result, the untouched source, and a manual recovery path.

## Performance / UX properties the brief asked for

- **Lazy, never bulk.** Processing happens when a token is prepared, never
  across a collection.
- **Cached.** The prepared bitmap is stored in IndexedDB (`SavedUserMask`)
  and reused; a PFP is processed once per device.
- **Automatic by default**, with a visible **Remove background** button (and
  **Bring back full artwork**) in the mask editor on desktop *and* mobile,
  with undo.
- **Responsive inference.** U²-Netp uses ONNX Runtime's proxy worker with universal
  SIMD/WASM and one thread, avoiding cross-origin-isolation requirements on
  GitHub Pages. The existing MediaPipe CPU path is the fallback.
- **Mobile-safe architecture, not a hardware guarantee.** The WASM path is
  supported by iOS WebKit and Android Chromium, but real-device performance
  and memory use still need testing across the oldest phones we support.
