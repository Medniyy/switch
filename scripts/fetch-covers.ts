/**
 * Build-time: download each collection's PFP into public/collections/<id>.png for
 * the gallery cards.
 *  - Solana: the collection NFT's own art via Helius (reliable; no ME throttle).
 *  - Ethereum: the collection image via OpenSea (needs OPENSEA_API_KEY).
 *
 * Run once locally: `npm run data:covers`.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { COLLECTIONS, type CollectionMeta } from "../lib/collections";
import { loadEnv, fetchJSON, ensureDir, COVERS_DIR, sleep } from "./_util";
import { rpc, imageOf, resolveCollectionAddress, type DasAsset } from "./_solana";

loadEnv();
const OPENSEA_KEY = process.env.OPENSEA_API_KEY;

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
      const url =
        c.fetch.via === "helius"
          ? await solanaCoverUrl(c)
          : await ethereumCoverUrl(c);
      if (!url) {
        console.log(`- ${c.id}: no cover url (skipped)`);
        continue;
      }
      await download(url, resolve(COVERS_DIR, `${c.id}.png`));
      console.log(`✓ ${c.id}.png`);
    } catch (err) {
      console.error(`✗ ${c.id}: ${(err as Error).message}`);
    }
    await sleep(400);
  }
  console.log("Done.");
})();
