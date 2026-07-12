/**
 * gen-sample-data.ts — placeholder data for EVERY registry collection so the app
 * is fully testable before the real indexes are fetched. Points at deterministic,
 * CORS-friendly picsum images (so canvas compositing + recording work end to end).
 *
 * Skips any collection that already has real data unless FORCE=1.
 *
 *   npm run data:sample
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { COLLECTIONS } from "../lib/collections";
import { writeData, DATA_DIR } from "./_util";

const SAMPLE = 120; // ids 1..120 per collection — enough to test the flow
const force = process.env.FORCE === "1";

for (const c of COLLECTIONS) {
  const path = resolve(DATA_DIR, `${c.id}.json`);
  if (!force && existsSync(path)) {
    console.log(`- ${c.id}.json exists (skipped; FORCE=1 to overwrite)`);
    continue;
  }
  const out: Record<string, { name: string; image: string }> = {};
  for (let id = 1; id <= SAMPLE; id++) {
    out[String(id)] = {
      image: `https://picsum.photos/seed/switch-${c.id}-${id}/512`,
      name: `${c.tag} #${id}`,
    };
  }
  writeData(c.id, out);
}
console.log("Sample data ready.");
