/**
 * A collection id is just its registry slug (see lib/collections.ts) — e.g.
 * "smb-gen2", "mad-lads", "pudgy-penguins". Kept as a plain string so the app is
 * open to any number of collections across chains.
 */
export type Collection = string;

/** One token's renderable data, as stored in public/data/{collection}.json */
export interface NFTRecord {
  image: string;
  name: string;
}

/** Full lookup table for a collection: tokenId (string) -> record */
export type CollectionData = Record<string, NFTRecord>;

/** Resolved NFT used throughout the UI */
export interface NFT extends NFTRecord {
  id: number;
  collection: Collection;
}
