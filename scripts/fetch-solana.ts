/**
 * Build-time: enumerate each Solana collection via the Helius DAS API and write
 * public/data/<id>.json = { [tokenNumber]: { name, image } }.
 *
 * Run once locally: `npm run data:solana` (needs HELIUS_API_KEY in .env.local).
 * The deployed app reads the resulting static JSON — no key, no runtime API.
 */
import { COLLECTIONS, type CollectionMeta } from "../lib/collections";
import { loadEnv, writeData, numberFromName, sleep } from "./_util";
import {
  rpc,
  imageOf,
  nameOf,
  resolveCollectionAddress,
  type DasAsset,
} from "./_solana";

loadEnv();
if (!process.env.HELIUS_API_KEY) {
  console.error("Missing HELIUS_API_KEY in .env.local");
  process.exit(1);
}

async function fetchCollection(meta: CollectionMeta): Promise<void> {
  if (meta.fetch.via !== "helius") return;
  process.stdout.write(`• ${meta.name}\n`);

  let address = meta.fetch.collectionAddress;
  if (!address) {
    address = await resolveCollectionAddress(meta.fetch.meSymbol);
    console.log(`  resolved collection ${address}`);
  }

  const out: Record<string, { name: string; image: string }> = {};
  let page = 1;
  let skipped = 0;
  for (;;) {
    const result = await rpc<{ items: DasAsset[] }>("getAssetsByGroup", {
      groupKey: "collection",
      groupValue: address,
      page,
      limit: 1000,
    });
    const items = result.items ?? [];
    if (items.length === 0) break;
    for (const a of items) {
      const name = nameOf(a);
      const num = numberFromName(name);
      const image = imageOf(a, meta.preferCdn);
      if (num === null || !image || !name) {
        skipped++;
        continue;
      }
      out[String(num)] = { name, image };
    }
    if (items.length < 1000) break;
    page++;
    await sleep(120); // gentle on the RPC
  }
  if (skipped) console.log(`  (skipped ${skipped} without a number/image)`);
  writeData(meta.id, out);
}

(async () => {
  const solana = COLLECTIONS.filter((c) => c.fetch.via === "helius");
  for (const meta of solana) {
    try {
      await fetchCollection(meta);
    } catch (err) {
      console.error(`  ✗ ${meta.id}: ${(err as Error).message}`);
    }
  }
  console.log("Done.");
})();
