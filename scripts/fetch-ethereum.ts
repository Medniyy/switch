/**
 * Build-time: enumerate each Ethereum collection via the OpenSea API v2 and write
 * public/data/<id>.json = { [tokenId]: { name, image } }. For ERC-721s the token
 * id IS the number the user types.
 *
 * Run once locally: `npm run data:ethereum` (needs OPENSEA_API_KEY in .env.local).
 */
import { COLLECTIONS, type CollectionMeta } from "../lib/collections";
import { loadEnv, fetchJSON, writeData, numberFromName, sleep } from "./_util";

loadEnv();

const KEY = process.env.OPENSEA_API_KEY;
if (!KEY) {
  console.error("Missing OPENSEA_API_KEY in .env.local");
  process.exit(1);
}
const BASE = "https://api.opensea.io/api/v2";
const headers = { "x-api-key": KEY, accept: "application/json" };

interface OSNft {
  identifier: string;
  name?: string;
  image_url?: string;
  display_image_url?: string;
}

async function fetchCollection(meta: CollectionMeta): Promise<void> {
  if (meta.fetch.via !== "opensea") return;
  process.stdout.write(`• ${meta.name}\n`);

  const slug = meta.fetch.slug;
  const out: Record<string, { name: string; image: string }> = {};
  let next: string | undefined;
  let skipped = 0;

  for (;;) {
    const url = new URL(`${BASE}/collection/${slug}/nfts`);
    url.searchParams.set("limit", "200");
    if (next) url.searchParams.set("next", next);

    const data = await fetchJSON<{ nfts: OSNft[]; next?: string }>(url.toString(), {
      headers,
    });
    const nfts = data.nfts ?? [];
    for (const n of nfts) {
      const num = /^\d+$/.test(n.identifier)
        ? Number(n.identifier)
        : numberFromName(n.name);
      const image = n.display_image_url || n.image_url;
      const name = n.name || `${meta.tag} #${n.identifier}`;
      if (num === null || !image) {
        skipped++;
        continue;
      }
      out[String(num)] = { name, image };
    }
    if (!data.next) break;
    next = data.next;
    await sleep(250); // stay under OpenSea rate limits
  }

  if (skipped) console.log(`  (skipped ${skipped} without an image)`);
  writeData(meta.id, out);
}

(async () => {
  const eth = COLLECTIONS.filter((c) => c.fetch.via === "opensea");
  for (const meta of eth) {
    try {
      await fetchCollection(meta);
    } catch (err) {
      console.error(`  ✗ ${meta.id}: ${(err as Error).message}`);
    }
  }
  console.log("Done.");
})();
