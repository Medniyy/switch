/**
 * Shared Solana helpers for the build-time scripts. Helius DAS for asset data,
 * with collection-address resolution via a Magic Eden listing (the ME *listings*
 * endpoint is reliable; the ME collection-info endpoint is heavily IP-throttled,
 * so we avoid it entirely and read the collection's cover from Helius instead).
 */
import { fetchJSON } from "./_util";

export interface DasAsset {
  id: string;
  content?: {
    /** `json_name` is the off-chain name; some collections leave the on-chain
     *  `name` blank on a subset of assets and only fill in `json_name`. */
    metadata?: { name?: string; json_name?: string };
    links?: { image?: string };
    files?: { uri?: string; cdn_uri?: string; mime?: string }[];
  };
  grouping?: { group_key: string; group_value: string }[];
}

export function heliusRpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("Missing HELIUS_API_KEY in .env.local");
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

export async function rpc<T>(method: string, params: unknown): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "switch", method, params });
  const res = await fetchJSON<{ result: T; error?: { message: string } }>(
    heliusRpcUrl(),
    { method: "POST", headers: { "Content-Type": "application/json" }, body }
  );
  if (res.error) throw new Error(res.error.message);
  return res.result;
}

/** Mime types we can wear directly — one decoded frame, no animation. */
const STILL_IMAGE = /^image\/(png|jpe?g|webp)$/i;

/**
 * The URL to index for an asset.
 *
 * `preferCdn` (a per-collection registry flag) picks the Helius CDN mirror over
 * the collection's own host, for collections whose host is too slow to be
 * usable. The mirror serves the same bytes and sends `Access-Control-Allow-
 * Origin: *`, which the canvas pipeline requires.
 */
export function imageOf(a: DasAsset, preferCdn = false): string | null {
  const files = a.content?.files ?? [];
  // Prefer a still raster whenever the collection ships one alongside an
  // animated original: the canvas pipeline only ever draws a single frame, and
  // some collections (Sensei) point `links.image` at a 30MB+ GIF that would be
  // downloaded in full on a phone for nothing.
  const image = a.content?.links?.image;
  if (image && /\.gif(\?|$)/i.test(image)) {
    const still = files.find((f) => f.mime && STILL_IMAGE.test(f.mime));
    const uri = preferCdn
      ? (still?.cdn_uri ?? still?.uri)
      : (still?.uri ?? still?.cdn_uri);
    if (uri) return uri;
  }
  if (preferCdn) {
    const cdn = files.find((f) => f.cdn_uri)?.cdn_uri;
    if (cdn) return cdn;
  }
  return image ?? files[0]?.cdn_uri ?? files[0]?.uri ?? null;
}

/** The asset's display name — falls back to the off-chain `json_name`. */
export function nameOf(a: DasAsset): string | null {
  const m = a.content?.metadata;
  return m?.name || m?.json_name || null;
}

/** Resolve the on-chain collection address from a Magic Eden symbol. */
export async function resolveCollectionAddress(
  meSymbol: string
): Promise<string> {
  const listings = await fetchJSON<{ tokenMint: string }[]>(
    `https://api-mainnet.magiceden.dev/v2/collections/${meSymbol}/listings?limit=1`
  );
  const mint = listings?.[0]?.tokenMint;
  if (!mint) throw new Error(`No listings to resolve address for ${meSymbol}`);
  const asset = await rpc<DasAsset>("getAsset", { id: mint });
  const group = asset.grouping?.find((g) => g.group_key === "collection");
  if (!group) throw new Error(`Asset ${mint} has no collection group`);
  return group.group_value;
}
