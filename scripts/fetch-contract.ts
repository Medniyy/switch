/**
 * Build-time: enumerate a collection straight from its own contract and write
 * public/data/<id>.json = { [tokenId]: { name, image } }.
 *
 * Two chains, one shape. An ERC-721 answers `tokenURI(id)` and `totalSupply()`
 * over an Ethereum RPC; a CW721 answers `nft_info` and `num_tokens` over a
 * CosmWasm smart query. Both point at the collection's metadata — an IPFS
 * directory (Pudgy Penguins, Bluefrens) or an HTTPS API (Lil Pudgys) — and both
 * carry the same requirement: every token's `image` / `name` differ only by the
 * id. That pattern is DERIVED from the first token and then VERIFIED against
 * sampled tokens across the range — a mismatch aborts rather than writing a bad
 * index.
 *
 * Needs no API key on either chain, only public endpoints.
 *
 * Run once locally: `npm run data:contract`.
 */
import { COLLECTIONS, type CollectionMeta } from "../lib/collections";
import { loadEnv, fetchJSON, writeData, sleep } from "./_util";

loadEnv();

const RPC = process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com";
/** Cosmos Hub REST. Bluefrens trades on Stargaze but lives here, as a
 *  `cosmos1…` CosmWasm contract. */
const LCD = process.env.COSMOS_LCD_URL || "https://rest.cosmos.directory/cosmoshub";
const GATEWAY = process.env.IPFS_GATEWAY || "https://ipfs.io/ipfs/";

/** Placeholder standing in for the token id inside a derived template. NUL so
 *  it can never collide with a real character in a name or URL. */
const ID = "\u0000";

interface TokenMeta {
  name?: string;
  image?: string;
}

async function ethCall(to: string, data: string): Promise<string> {
  const res = await fetchJSON<{ result?: string; error?: { message: string } }>(
    RPC,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
    }
  );
  if (res.error) throw new Error(res.error.message);
  if (!res.result) throw new Error("empty eth_call result");
  return res.result;
}

/** Decode an ABI-encoded `string` return value. */
function decodeString(hex: string): string {
  const body = hex.slice(2);
  const len = parseInt(body.slice(64, 128), 16);
  return Buffer.from(body.slice(128, 128 + len * 2), "hex").toString("utf8");
}

/** `tokenURI(uint256)` — selector 0xc87b56dd. */
async function erc721TokenURI(contract: string, id: number): Promise<string> {
  const arg = id.toString(16).padStart(64, "0");
  return decodeString(await ethCall(contract, `0xc87b56dd${arg}`));
}

/** `totalSupply()` — selector 0x18160ddd. */
async function erc721Supply(contract: string): Promise<number> {
  return parseInt(await ethCall(contract, "0x18160ddd"), 16);
}

/**
 * Run a CosmWasm smart query. The message is base64url-encoded into the path —
 * plain base64 would break the URL, since `+` and `/` are meaningful there.
 */
async function cosmwasmQuery<T>(contract: string, msg: unknown): Promise<T> {
  const encoded = Buffer.from(JSON.stringify(msg))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const res = await fetchJSON<{ data?: T; message?: string }>(
    `${LCD}/cosmwasm/wasm/v1/contract/${contract}/smart/${encoded}`
  );
  if (res.data === undefined) {
    throw new Error(res.message ?? "empty smart-query result");
  }
  return res.data;
}

/** CW721 `nft_info` — the `token_uri` is the ERC-721 `tokenURI` equivalent. */
async function cw721TokenURI(contract: string, id: number): Promise<string> {
  const info = await cosmwasmQuery<{ token_uri?: string }>(contract, {
    nft_info: { token_id: String(id) },
  });
  if (!info.token_uri) throw new Error(`token ${id} has no token_uri`);
  return info.token_uri;
}

/** CW721 `num_tokens`. */
async function cw721Supply(contract: string): Promise<number> {
  const { count } = await cosmwasmQuery<{ count: number }>(contract, {
    num_tokens: {},
  });
  return count;
}

/** The two chain-specific calls, chosen once per collection. */
function chainCalls(meta: CollectionMeta) {
  const cosmos = meta.fetch.via === "cosmwasm";
  return {
    tokenURI: cosmos ? cw721TokenURI : erc721TokenURI,
    supply: cosmos ? cw721Supply : erc721Supply,
  };
}

/** ipfs://<cid>/<path> → a gateway URL the browser can load; https:// as-is. */
function toGateway(uri: string): string {
  return uri.startsWith("ipfs://") ? GATEWAY + uri.slice("ipfs://".length) : uri;
}

type TokenUriFn = (contract: string, id: number) => Promise<string>;

async function tokenMeta(
  tokenURI: TokenUriFn,
  contract: string,
  id: number
): Promise<TokenMeta> {
  return fetchJSON<TokenMeta>(toGateway(await tokenURI(contract, id)));
}

/**
 * Turn a concrete value for `id` into a template by replacing the id occurrence
 * with a placeholder. Only the LAST occurrence is replaced (the id appears at
 * the end of both `.../penguin/123.png` and `Pudgy Penguin #123`), so a CID that
 * happens to contain the same digits is never clobbered.
 */
function templateOf(value: string, id: number): string | null {
  const idx = value.lastIndexOf(String(id));
  if (idx === -1) return null;
  return value.slice(0, idx) + ID + value.slice(idx + String(id).length);
}

const render = (template: string, id: number) =>
  template.replaceAll(ID, String(id));

async function fetchCollection(meta: CollectionMeta): Promise<void> {
  if (meta.fetch.via !== "contract" && meta.fetch.via !== "cosmwasm") return;
  process.stdout.write(`• ${meta.name}\n`);

  const { tokenURI, supply: supplyOf } = chainCalls(meta);
  const { contract, firstId } = meta.fetch;
  const supply = meta.fetch.supply ?? (await supplyOf(contract));
  const lastId = firstId + supply - 1;
  console.log(`  supply ${supply} — ids ${firstId}…${lastId}`);

  // Derive the templates from the first token.
  const first = await tokenMeta(tokenURI, contract, firstId);
  if (!first.image) throw new Error(`token ${firstId} has no image`);
  const imageTemplate = templateOf(toGateway(first.image), firstId);
  if (!imageTemplate) {
    throw new Error(`token ${firstId} image does not embed its id: ${first.image}`);
  }
  const nameTemplate = first.name ? templateOf(first.name, firstId) : null;

  // Verify across the range before trusting the pattern for every token.
  const samples = [
    firstId + 1,
    firstId + Math.floor(supply / 3),
    firstId + Math.floor((supply * 2) / 3),
    lastId,
  ].filter((n, i, a) => n > firstId && n <= lastId && a.indexOf(n) === i);

  for (const id of samples) {
    const m = await tokenMeta(tokenURI, contract, id);
    const expected = render(imageTemplate, id);
    if (toGateway(m.image ?? "") !== expected) {
      throw new Error(
        `pattern check failed at #${id}\n    expected ${expected}\n    actual   ${toGateway(m.image ?? "")}`
      );
    }
    if (nameTemplate && m.name !== render(nameTemplate, id)) {
      throw new Error(
        `name pattern failed at #${id}: ${m.name} ≠ ${render(nameTemplate, id)}`
      );
    }
    await sleep(120);
  }
  console.log(`  ✓ pattern verified at #${samples.join(", #")}`);

  const out: Record<string, { name: string; image: string }> = {};
  for (let id = firstId; id <= lastId; id++) {
    out[String(id)] = {
      name: nameTemplate ? render(nameTemplate, id) : `${meta.tag} #${id}`,
      image: render(imageTemplate, id),
    };
  }
  writeData(meta.id, out);
}

(async () => {
  const targets = COLLECTIONS.filter(
    (c) => c.fetch.via === "contract" || c.fetch.via === "cosmwasm"
  );
  for (const meta of targets) {
    try {
      await fetchCollection(meta);
    } catch (err) {
      console.error(`  ✗ ${meta.id}: ${(err as Error).message}`);
    }
  }
  console.log("Done.");
})();
