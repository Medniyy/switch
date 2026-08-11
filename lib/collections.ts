import { BASE_PATH } from "./basePath";

/**
 * SWITCH collection registry — the single source of truth for every wearable
 * collection. Ordered Solana-first, then Ethereum, then Cosmos.
 *
 * The `fetch` descriptor is used ONLY by the build-time scripts in scripts/
 * (fetch-solana.ts / fetch-ethereum.ts / fetch-contract.ts / fetch-covers.ts)
 * to generate the static
 * public/data/<id>.json token index and public/collections/<id>.png cover. The
 * running app never touches it — at runtime everything is static JSON + images.
 */

export type Chain = "solana" | "ethereum" | "cosmos";

/** How a collection's token index + cover are sourced at BUILD time only. */
export type FetchSource =
  | {
      via: "helius";
      /** Magic Eden symbol (e.g. "mad_lads") — used to auto-resolve the on-chain
       *  collection address and the marketplace cover image. */
      meSymbol: string;
      /** Optional explicit Metaplex collection mint; auto-resolved from meSymbol
       *  when omitted. */
      collectionAddress?: string;
      /** Pre-Metaplex-collection sets (no `grouping` on their assets) are
       *  enumerated by verified creator instead. Mutually exclusive with
       *  collectionAddress in spirit; when set it wins. */
      creatorAddress?: string;
      /** Required alongside creatorAddress: a creator wallet often spans
       *  several series, so only names starting with this prefix are indexed
       *  (e.g. "Hot Head #" keeps Katabasis #12 from colliding with token 12). */
      namePrefix?: string;
    }
  | {
      via: "opensea";
      /** OpenSea collection slug (e.g. "pudgypenguins"). */
      slug: string;
      /** Optional explicit contract; auto-resolved from the slug when omitted. */
      contract?: string;
    }
  | {
      via: "contract";
      /** ERC-721 contract — `tokenURI` resolves the metadata (IPFS directory or
       *  HTTPS API), `totalSupply` the token count. No API key, just a public RPC. */
      contract: string;
      /** First token id (0 for most ERC-721 sets, 1 for some). */
      firstId: number;
      /** Token count, when `totalSupply` isn't the minted id range — burns make
       *  the two diverge, and the index should still cover every minted id. */
      supply?: number;
    }
  | {
      via: "cosmwasm";
      /** CW721 contract address. The same shape as `contract` above, reached
       *  through a CosmWasm smart query instead of an EVM `eth_call`:
       *  `nft_info` returns the token URI, `num_tokens` the count. Keyless — a
       *  public LCD endpoint is all it takes. */
      contract: string;
      /** First token id. CW721 ids are strings; these sets number from 1. */
      firstId: number;
      /** Token count, when `num_tokens` isn't the minted id range (see above). */
      supply?: number;
    };

export interface CollectionMeta {
  /** Slug used in routes (/c/<id>) and file names (public/data/<id>.json). */
  id: string;
  /** Full display name. */
  name: string;
  /** Short name-tag shown under the gallery card. */
  tag: string;
  chain: Chain;
  /** Optional per-collection accent (hex). Falls back to the lime brand accent. */
  accent?: string;
  /** Hide from the gallery + routes without deleting it (e.g. data not ready). */
  hidden?: boolean;
  /**
   * Set `false` for art the chroma-key genuinely cannot separate, so the editor
   * opens on the UNTOUCHED artwork instead of a mangled automatic cutout. The
   * user then erases the background by hand (and "Restore artwork" in the editor
   * gets them back to this state at any point). Defaults to enabled.
   */
  autoCutout?: boolean;
  /**
   * Cut this collection's art with the geometric edge matte FIRST, instead of
   * the general-subject model.
   *
   * Set it for art built as a crisp character on a flat designed backdrop —
   * pixel art especially. The model looks for the salient object and on that
   * art it reliably answers "the head", amputating the body: measured
   * 2026-08-10, SMB Gen2 #4 kept 0.206 against the matte's 0.428 (halo and
   * shirt gone) and SMB Gen3 #6 kept 0.254 against 0.411 (tail and body gone).
   * The matte's own weakness — soft or low-contrast outlines — is exactly what
   * this art does not have, so it is the better first choice here.
   *
   * Leave it unset for 3D renders, photographs, and painterly art (Claynosaurz,
   * The Bullpen, Sensei), where the model wins by the same measurement.
   */
  preferMatteCutout?: boolean;
  /**
   * This collection's backdrops are SCENES — photographs or paintings — rather
   * than the designed flat backdrop PFP art normally sits on. It turns the
   * collapse guard off, and only that.
   *
   * The guard promotes the other engine when the leading one keeps less than
   * COLLAPSE_RATIO of what the other kept, on the reasoning that it amputated
   * the subject. That reasoning needs both engines to be plausible readings of
   * the same image. On a scene they are not: the matte has no border to walk in
   * from, so it keeps almost the whole frame and scores high precisely BECAUSE
   * it failed, while a correct model cutout legitimately scores low. The guard
   * then reads the good result as the collapsed one and hands the background
   * back. Measured on Retardio Cousins 2026-08-11, segmenter vs matte coverage:
   * #11 0.374/0.931, #1500 0.411/0.913, #4000 0.376/0.917, #4444 0.384/0.776 —
   * all four swapped to the matte and opened with the scene fully intact, and
   * "Remove background" could not fix it because it applies the same guard.
   *
   * Leave it unset for art on a flat designed backdrop, where the matte is the
   * meaningful second opinion the guard was built on (see `preferMatteCutout`).
   */
  sceneBackdrop?: boolean;
  /**
   * Index the Helius CDN mirror (`content.files[].cdn_uri`) instead of the
   * collection's own image host. Set this when that host is slow enough to hurt:
   * Mad Lads serves ~5.7MB PNGs from an S3 bucket that regularly needs 90s+,
   * while the same bytes come off the CDN in ~3s cold and under a second warm.
   * Build-time only — it just changes which URL is written into the token index.
   */
  preferCdn?: boolean;
  /**
   * Take the gallery cover from the collection's lowest-numbered token instead
   * of the collection NFT's own art. Some collections never replaced the art
   * they minted the collection NFT with — Solana in Pajamas still carries the
   * pre-reveal silhouette — which makes for a dead card. Build-time only.
   */
  coverFromToken?: boolean;
  fetch: FetchSource;
}

export const COLLECTIONS: CollectionMeta[] = [
  // ---- Solana (first) ----
  {
    id: "smb-gen2",
    name: "Solana Monkey Business",
    tag: "SMB Gen2",
    chain: "solana",
    accent: "#FEC133",
    preferMatteCutout: true,
    fetch: {
      via: "helius",
      meSymbol: "solana_monkey_business",
      collectionAddress: "SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W",
    },
  },
  {
    id: "smb-gen3",
    name: "SMB Gen3",
    tag: "SMB Gen3",
    chain: "solana",
    accent: "#FEC133",
    preferMatteCutout: true,
    fetch: {
      via: "helius",
      meSymbol: "smb_gen3",
      collectionAddress: "8Rt3Ayqth4DAiPnW9MDFi63TiQJHmohfTWLMQFHi4KZH",
    },
  },
  {
    id: "mad-lads",
    name: "Mad Lads",
    tag: "Mad Lads",
    chain: "solana",
    accent: "#E1443F",
    // madlads.s3.us-west-2.amazonaws.com is by far the slowest host in the
    // roster — every other collection lands in under 2s, this one often doesn't
    // finish at all. Index the CDN mirror instead.
    preferCdn: true,
    preferMatteCutout: true,
    fetch: { via: "helius", meSymbol: "mad_lads" },
  },
  {
    id: "famous-fox-federation",
    name: "Famous Fox Federation",
    tag: "Famous Foxes",
    chain: "solana",
    accent: "#F0972B",
    fetch: { via: "helius", meSymbol: "famous_fox_federation" },
  },
  {
    id: "bo-doggos",
    name: "Bo Doggos",
    tag: "Bo Doggos",
    chain: "solana",
    fetch: { via: "helius", meSymbol: "bodoggos" },
  },
  {
    id: "sensei",
    name: "Sensei",
    tag: "Sensei",
    chain: "solana",
    accent: "#4E7CD6",
    fetch: { via: "helius", meSymbol: "sensei" },
  },
  {
    id: "solana-in-pajamas",
    name: "Solana in Pajamas",
    tag: "Pajamas",
    chain: "solana",
    accent: "#00E7E7",
    // The collection NFT is still the pre-reveal silhouette — use real art.
    coverFromToken: true,
    fetch: {
      via: "helius",
      meSymbol: "solana_in_pajamas",
      // Auto-resolution walks ME listings, and this collection currently has
      // none — pinned so a re-run can't fail on an empty order book.
      collectionAddress: "FDtiqzvkM5qhyBMCFQ1gX7qHpPEDKvuX2kwoet3up1t9",
    },
  },
  {
    id: "the-bullpen",
    name: "The Bullpen",
    tag: "Bullpen",
    chain: "solana",
    accent: "#9BA83B",
    fetch: {
      via: "helius",
      meSymbol: "the_bullpen",
      // ME's v2 listings endpoint returns [] for this collection (pool-style
      // listings only), which breaks the auto-resolution path — pinned from a
      // real token's DAS grouping instead.
      collectionAddress: "C5gHBKXwA8jduXNk3HyAVLnLBN6PEM8fTqkNNh5uyyjJ",
    },
  },
  {
    id: "claynosaurz",
    name: "Claynosaurz",
    tag: "Claynosaurz",
    chain: "solana",
    accent: "#4FC3E8",
    fetch: { via: "helius", meSymbol: "claynosaurz" },
  },
  {
    id: "retardio-cousins",
    name: "Retardio Cousins",
    tag: "Retardio",
    chain: "solana",
    accent: "#F0A0C0",
    // Hand-painted characters over photographic and painterly backdrops (a
    // street market, a highway, a Monet) — no flat backdrop anywhere, so the
    // general-subject model leads and `preferMatteCutout` stays off: this is
    // precisely the art the geometric matte walks straight through. That same
    // fact is why the collapse guard has to be off here (see `sceneBackdrop`).
    sceneBackdrop: true,
    fetch: { via: "helius", meSymbol: "retardio_cousins" },
  },
  {
    id: "hot-heads",
    name: "Hot Heads",
    tag: "Hot Heads",
    chain: "solana",
    accent: "#FF5A1F",
    // No collection grouping (see fetch below) means no collection NFT to
    // read a cover from either — use the first token's art.
    coverFromToken: true,
    // Pre-Metaplex-collection mint: assets carry NO collection grouping, so
    // they can only be enumerated by verified creator. That wallet also minted
    // Katabasis, Gates of Hell and a pile of 1/1 collabs — the name prefix is
    // what keeps them out. The real set is Hot Head #1–#78.
    fetch: {
      via: "helius",
      meSymbol: "hot_heads",
      creatorAddress: "CywHUY59AFi7nmGf9kVfNgd39TD9rnkyx6GfWsn5iNnE",
      namePrefix: "Hot Head #",
    },
  },

  // ---- Ethereum ----
  {
    id: "pudgy-penguins",
    name: "Pudgy Penguins",
    tag: "Pudgy Penguins",
    chain: "ethereum",
    accent: "#5CA9E6",
    // Sourced straight from the contract's own IPFS metadata rather than
    // OpenSea, so the index rebuilds with no API key (npm run data:contract).
    fetch: {
      via: "contract",
      contract: "0xbd3531da5cf5857e7cfaa92426877b022e612cf8",
      firstId: 0,
    },
  },
  {
    id: "lil-pudgys",
    name: "Lil Pudgys",
    tag: "Lil Pudgys",
    chain: "ethereum",
    accent: "#7FC5F2",
    fetch: {
      via: "contract",
      contract: "0x524cab2ec69124574082676e6f654a18df49a048",
      firstId: 0,
      // 291 burned, so totalSupply() (21931) is short of the minted range 0…22221.
      supply: 22222,
    },
  },
  {
    id: "veefriends",
    name: "VeeFriends",
    tag: "VeeFriends",
    chain: "ethereum",
    accent: "#4B9CD3",
    hidden: true,
    fetch: { via: "opensea", slug: "veefriends" },
  },
  {
    id: "milady",
    name: "Milady Maker",
    tag: "Milady",
    chain: "ethereum",
    accent: "#C9B6E4",
    hidden: true,
    fetch: { via: "opensea", slug: "milady" },
  },

  // ---- Cosmos ----
  {
    id: "bluefrens",
    name: "Bluefrens",
    tag: "Bluefrens",
    chain: "cosmos",
    accent: "#28D8F8",
    // Crisp pixel-art characters with hard outlines — exactly the art the
    // geometric matte reads better than the general-subject model. See
    // `preferMatteCutout` for the measurements behind that choice.
    preferMatteCutout: true,
    // Traded on Stargaze, but deployed to the Cosmos Hub (a `cosmos1…` CosmWasm
    // contract), so the index comes straight off the chain rather than through
    // Stargaze's API: 1420 tokens, ids 1…1420, metadata in one IPFS directory.
    fetch: {
      via: "cosmwasm",
      contract:
        "cosmos1dpx0r360h5wvszg9q8y9qz98rncyuscygql8zfxt0wvya307p4pq8l7nz2",
      firstId: 1,
    },
  },
];

/** The brand lime — default card accent when a collection sets none. */
export const DEFAULT_ACCENT = "#C6F432";

export function getCollection(id: string): CollectionMeta | undefined {
  return COLLECTIONS.find((c) => c.id === id);
}

/**
 * Whether a collection's art should get the automatic chroma-key cutout as its
 * starting mask. Unknown ids default to `true` so a collection is never silently
 * opted out by a typo.
 */
export function usesAutoCutout(id: string | null | undefined): boolean {
  if (!id) return true;
  return getCollection(id)?.autoCutout !== false;
}

/**
 * Whether this collection's art should be cut with the general-subject model
 * first (the default) or with the geometric matte first. See
 * `preferMatteCutout` for the measurements behind each choice. Unknown ids —
 * and custom uploads, which pass no id — get the model, its training domain.
 */
export function prefersSegmenterCutout(id: string | null | undefined): boolean {
  if (!id) return true;
  return getCollection(id)?.preferMatteCutout !== true;
}

/**
 * Whether this source is collection ARTWORK — a character on a designed
 * backdrop — rather than a photograph a user supplied. Only artwork may use
 * `collapseGuard`, because only there is the geometric matte a meaningful
 * second opinion. Custom avatars carry a collection id too, so an unknown id
 * is not enough on its own to answer this.
 */
export function isCollectionArtwork(id: string | null | undefined): boolean {
  return !!id && !!getCollection(id);
}

/**
 * Whether `collapseGuard` may run for this source. Being collection artwork is
 * necessary but not sufficient: a collection whose backdrops are scenes rather
 * than a flat designed field breaks the comparison the guard rests on, and
 * there the guard reliably promotes the WORSE result. See `sceneBackdrop`.
 *
 * This is the value every caller should pass — `isCollectionArtwork` alone
 * answers a different question (artwork vs. a user's photo).
 */
export function usesCollapseGuard(id: string | null | undefined): boolean {
  if (!id) return false;
  const collection = getCollection(id);
  return !!collection && collection.sceneBackdrop !== true;
}

/**
 * The MonkeyDAO collections — Solana Monkey Business Gen2 & Gen3 — which unlock
 * the secret "Banana Rain" filter. Gated by stable collection id (never by
 * display-name string matching) so renames can't accidentally expose or hide it.
 */
export const MONKEY_DAO_COLLECTION_IDS = ["smb-gen2", "smb-gen3"] as const;

export function isMonkeyDaoCollection(id: string | null | undefined): boolean {
  return !!id && (MONKEY_DAO_COLLECTION_IDS as readonly string[]).includes(id);
}

/** Cover image path for a collection card (marketplace PFP, downloaded at build). */
export function coverSrc(id: string): string {
  return `${BASE_PATH}/collections/${id}.png`;
}

/** Collections shown in the gallery + given routes (excludes hidden ones). */
export const VISIBLE_COLLECTIONS = COLLECTIONS.filter((c) => !c.hidden);

export const SOLANA_COLLECTIONS = VISIBLE_COLLECTIONS.filter(
  (c) => c.chain === "solana"
);
export const ETHEREUM_COLLECTIONS = VISIBLE_COLLECTIONS.filter(
  (c) => c.chain === "ethereum"
);
export const COSMOS_COLLECTIONS = VISIBLE_COLLECTIONS.filter(
  (c) => c.chain === "cosmos"
);
