# Limited drop: Deaton

A temporary, one-of-one wearable that leads the gallery — the Deaton skull, with
a link out to [app.jurassic.finance](https://app.jurassic.finance/) so anyone who
finds it can go get it.

It is a **normal registry collection** with three extra registry flags, not a new
subsystem. That is the point: when the drop ends it comes out with one entry
deletion and no untangling.

## What it does

| Ask | How |
| --- | --- |
| Show up in the main menu | `COLLECTIONS` entry → `VISIBLE_COLLECTIONS` → the home + welcome carousels |
| First card in the app | The entry is **first in the `COLLECTIONS` array** (the carousel keeps registry order) |
| `LIMITED` tag, always visible | `limited: true` → the badge takes the chain ticker's slot on the card, no hover needed |
| Discoverable jurassic.finance link | `link: { … }` → a bordered link under the title on `/c/deaton` |
| Worn at 165% by default | `defaultScale: 1.65` → the fit a newly prepared mask starts at |

Two smaller consequences of being a one-of-one:

- `singleToken: 1` — `/c/deaton` skips the number pad entirely and opens on the
  "WEAR THIS" card. A keypad to find the only token there is would be theatre.
- `fetch: { via: "local" }` — nothing scrapes this one. Its index and art are
  placed by hand (below) and every `npm run data:*` script skips it.

## The art

**One file, used as both the gallery cover and the mask:**

```
public/collections/deaton.png     ← transparent PNG, square-ish, ~1024px
public/data/deaton.json           ← the one-token index, points at the file above
```

Both paths are **gitignored** (like every other collection's art and index — see
`.gitignore`), so the file lives on the build machine and ships with
`npm run deploy`. It is never committed to this public repo.

`autoCutout: false` is set because the art is supplied already cut out: the
cutout engines have nothing to key out and would only risk eating the horns. If
you swap in art that still has a background, drop that flag.

The shipped PNG was cut from a JPEG on flat white with ImageMagick. Reuse this
if the art is ever re-supplied — the `Erode` step is the one that matters, it
removes the JPEG halo that otherwise leaves white slivers in the tooth gaps:

```bash
magick photo.jpg -alpha set -fuzz 22% -transparent white   -channel A -morphology Erode Octagon:1 -blur 0x0.6 -level 20%,80% +channel   -background none -gravity center -extent 1024x1024   PNG32:public/collections/deaton.png
```

Sanity check the result with `magick … -alpha extract -format "%[fx:100*mean]"`:
the shipped cut reads **45.3% mean alpha**. A sharp drop from that means the key
ate bone, not background.

## Removing the drop

1. Delete the `deaton` entry from `COLLECTIONS` in `lib/collections.ts`.
2. Delete `public/collections/deaton.png` and `public/data/deaton.json`.
3. Delete this file.
4. `npm run build` — nothing else references the drop by name.

The four registry fields it introduced (`defaultScale`, `limited`, `singleToken`,
`link`) and the `via: "local"` fetch source are generic and can stay; with no
collection setting them they are inert. Remove them too if you want the registry
back exactly as it was — the render sites are the `collection.limited` branch in
`components/gallery/CollectionCard.tsx`, the `meta.singleToken` / `meta.link`
branches in `app/c/[collection]/CollectionFinder.tsx`, and `defaultFitFor` in
`components/mask-prep/MaskPreparationFlow.tsx`.
