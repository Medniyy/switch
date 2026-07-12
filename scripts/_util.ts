/**
 * Shared helpers for the build-time data scripts (Solana/Ethereum/covers).
 * These run ONLY on a dev machine and write into public/. Nothing here ships to
 * the browser. API keys come from .env.local and are never bundled.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
export const DATA_DIR = resolve(ROOT, "public", "data");
export const COVERS_DIR = resolve(ROOT, "public", "collections");

/** Load .env.local into process.env (no dependency; simple KEY=VALUE parser). */
export function loadEnv(): void {
  const file = resolve(ROOT, ".env.local");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch JSON with retries + backoff. 429s wait much longer (rate-limit aware).
 *  Sends a browser UA by default (some gateways 403/429 requests without one). */
export async function fetchJSON<T = unknown>(
  url: string,
  init: RequestInit = {},
  { retries = 5, backoffMs = 800 } = {}
): Promise<T> {
  const headers = {
    "User-Agent": "Mozilla/5.0 (SWITCH data build)",
    ...(init.headers ?? {}),
  };
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers });
      if (res.status === 429) {
        // Rate limited — back off hard (per-minute windows are common).
        throw new Error("HTTP 429");
      }
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const is429 = err instanceof Error && err.message === "HTTP 429";
        await sleep(is429 ? 12_000 * (attempt + 1) : backoffMs * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Write a token index ({ [number]: {name,image} }) to public/data/<id>.json. */
export function writeData(id: string, data: Record<string, unknown>): void {
  ensureDir(DATA_DIR);
  const out = resolve(DATA_DIR, `${id}.json`);
  writeFileSync(out, JSON.stringify(data));
  const n = Object.keys(data).length;
  console.log(`  ✓ ${id}.json — ${n} tokens`);
}

/** Pull the token number out of an NFT name, e.g. "Mad Lad #1234" → 1234. */
export function numberFromName(name: string | undefined): number | null {
  if (!name) return null;
  const hash = name.match(/#\s*(\d+)/);
  if (hash) return Number(hash[1]);
  const trailing = name.match(/(\d+)\s*$/);
  return trailing ? Number(trailing[1]) : null;
}
