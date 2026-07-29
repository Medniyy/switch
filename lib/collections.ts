import { BASE_PATH } from "./basePath";

/**
 * SWITCH collection registry — the single source of truth for every wearable
 * collection. Ordered Solana-first, then Ethereum.
 *
 * The `fetch` descriptor is used ONLY by the build-time scripts in scripts/
 * (fetch-solana.ts / fetch-ethereum.ts / fetch-covers.ts) to generate the static
 * public/data/<id>.json token index and public/collections/<id>.png cover. The
 * running app never touches it — at runtime everything is static JSON + images.
 */

export type Chain = "solana" | "ethereum";

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
];

/** The brand lime — default card accent when a collection sets none. */
export const DEFAULT_ACCENT = "#C6F432";

export function getCollection(id: string): CollectionMeta | undefined {
  return COLLECTIONS.find((c) => c.id === id);
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
