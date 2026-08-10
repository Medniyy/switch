/**
 * Build-time: download each collection's PFP into public/collections/<id>.png for
 * the gallery cards.
 *  - Solana: the collection NFT's own art via Helius (reliable; no ME throttle).
 *  - Ethereum: the collection image via OpenSea (needs OPENSEA_API_KEY).
 *  - Cosmos: the CW721's own `collection_info` image (keyless).
 *
 * Whatever the chain, anything that fails to produce a URL falls back to the
 * collection's first token — see firstTokenImage.
 *
 * Run once locally: `npm run data:covers`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { COLLECTIONS, type CollectionMeta } from "../lib/collections";
import {
  loadEnv,
  fetchJSON,
  ensureDir,
  COVERS_DIR,
  DATA_DIR,
  sleep,
} from "./_util";
import { rpc, imageOf, resolveCollectionAddress, type DasAsset } from "./_solana";

loadEnv();
const OPENSEA_KEY = process.env.OPENSEA_API_KEY;
const LCD = process.env.COSMOS_LCD_URL || "https://rest.cosmos.directory/cosmoshub";
const GATEWAY = process.env.IPFS_GATEWAY || "https://ipfs.io/ipfs/";

async function solanaCoverUrl(meta: CollectionMeta): Promise<string | null> {
  if (meta.fetch.via !== "helius") return null;
  const address =
    meta.fetch.collectionAddress ??
    (await resolveCollectionAddress(meta.fetch.meSymbol));
  // The collection address is itself an NFT whose art is the collection PFP.
  const asset = await rpc<DasAsset>("getAsset", { id: address });
  return imageOf(asset);
}

async function ethereumCoverUrl(meta: CollectionMeta): Promise<string | null> {
  if (meta.fetch.via !== "opensea" || !OPENSEA_KEY) return null;
  const data = await fetchJSON<{ image_url?: string }>(
    `https://api.opensea.io/api/v2/collections/${meta.fetch.slug}`,
    { headers: { "x-api-key": OPENSEA_KEY, accept: "application/json" } }
  );
  return data.image_url ?? null;
}

/**
 * The CW721's own collection art. `get_collection_info_and_extension` is the
 * CosmWasm equivalent of the collection NFT's metadata on Solana — for
 * Bluefrens it is a real character PFP, not a wordmark, which is exactly what
 * the card wants.
 */
async function cosmosCoverUrl(meta: CollectionMeta): Promise<string | null> {
  if (meta.fetch.via !== "cosmwasm") return null;
  const msg = Buffer.from(JSON.stringify({ get_collection_info_and_extension: {} }))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const res = await fetchJSON<{ data?: { extension?: { image?: string } } }>(
    `${LCD}/cosmwasm/wasm/v1/contract/${meta.fetch.contract}/smart/${msg}`
  );
  const image = res.data?.extension?.image;
  if (!image) return null;
  return image.startsWith("ipfs://")
    ? GATEWAY + image.slice("ipfs://".length)
    : image;
}

/**
 * Fallback cover: the collection's lowest-numbered token, read from the already
 * generated public/data/<id>.json. Metaplex Core collections (e.g. Sensei) often
 * carry no art of their own, and a PFP from the set is exactly what the card
 * shows for every other collection anyway.
 */
function firstTokenImage(id: string): string | null {
  const file = resolve(DATA_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    { image?: string }
  >;
  const first = Object.keys(data)
    .map(Number)
    .sort((a, b) => a - b)[0];
  return data[String(first)]?.image ?? null;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

(async () => {
  ensureDir(COVERS_DIR);
  for (const c of COLLECTIONS) {
    try {
      const primary = c.coverFromToken
        ? null
        : c.fetch.via === "helius"
          ? await solanaCoverUrl(c)
          : c.fetch.via === "cosmwasm"
            ? await cosmosCoverUrl(c)
            : await ethereumCoverUrl(c);
      const url = primary ?? firstTokenImage(c.id);
      if (!url) {
        console.log(`- ${c.id}: no cover url (skipped)`);
        continue;
      }
      if (!primary) console.log(`  (${c.id}: using first token as cover)`);
      await download(url, resolve(COVERS_DIR, `${c.id}.png`));
      console.log(`✓ ${c.id}.png`);
    } catch (err) {
      console.error(`✗ ${c.id}: ${(err as Error).message}`);
    }
    await sleep(400);
  }
  console.log("Done.");
})();
