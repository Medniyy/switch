import type { Collection, CollectionData, NFT } from "./types";
import { BASE_PATH, withBasePath } from "./basePath";

/**
 * Runtime NFT data access — pure static, zero backend.
 *
 * Every collection ships a pre-built index at public/data/<id>.json
 * ({ [tokenNumber]: { image, name } }), generated once on a dev machine by the
 * scripts in scripts/ (Helius DAS for Solana, OpenSea for Ethereum). At runtime
 * we just fetch that JSON once, cache it in memory, and look tokens up by number.
 * No API keys ship in the app; a token lookup is an O(1) map read.
 */

const cache = new Map<Collection, CollectionData>();
const inflight = new Map<Collection, Promise<CollectionData>>();

function loadCollection(collection: Collection): Promise<CollectionData> {
  const cached = cache.get(collection);
  if (cached) return Promise.resolve(cached);

  const existing = inflight.get(collection);
  if (existing) return existing;

  const promise = fetch(`${BASE_PATH}/data/${collection}.json`)
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load ${collection} data`);
      return res.json() as Promise<CollectionData>;
    })
    .then((data) => {
      cache.set(collection, data);
      inflight.delete(collection);
      return data;
    })
    .catch((err) => {
      inflight.delete(collection);
      throw err;
    });

  inflight.set(collection, promise);
  return promise;
}

/** Warm the cache (call on collection focus) so the first search is instant. */
export function preloadCollection(collection: Collection): void {
  void loadCollection(collection).catch(() => {});
}

/**
 * Hook for rewriting art URLs to a more reliable / CORS-safe gateway if needed.
 * Currently a passthrough: arweave.net serves the SMB art directly with
 * `Access-Control-Allow-Origin: *` (canvas-safe for recording), so no rewrite is
 * required. (An earlier arweave.net→permagate.io rewrite was removed — permagate
 * now 502s, which is what broke SMB image loading.)
 */
export function resilientImage(url: string): string {
  // A hand-shipped collection (`via: "local"`) indexes its art as a
  // root-relative path rather than an absolute URL. Next never rewrites raw
  // string asset paths, so the deploy's basePath has to be added here.
  if (url.startsWith("/")) return withBasePath(url);
  return url;
}

/** Look up a single token by number. Returns null if the id doesn't exist. */
export async function getNFT(
  collection: Collection,
  id: number
): Promise<NFT | null> {
  const data = await loadCollection(collection);
  const record = data[String(id)];
  if (!record) return null;
  return {
    id,
    collection,
    name: record.name,
    image: resilientImage(record.image),
  };
}

/** How many tokens the collection actually has (for grids). */
export async function getCollectionSize(
  collection: Collection
): Promise<number> {
  const data = await loadCollection(collection);
  return Object.keys(data).length;
}

/** Resolve several ids at once (used by the recently-viewed grid). */
export async function getNFTs(
  refs: { collection: Collection; id: number }[]
): Promise<NFT[]> {
  const resolved = await Promise.all(
    refs.map((ref) => getNFT(ref.collection, ref.id).catch(() => null))
  );
  return resolved.filter((nft): nft is NFT => nft !== null);
}
