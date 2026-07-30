/**
 * Public usage stats, read straight from Umami by the browser.
 *
 * Umami's normal API needs an account token, which a static public app cannot
 * hold. Instead we use its SHARE path: enabling "Share URL" on a website mints a
 * `shareId`, and `GET /api/share/<shareId>` exchanges that for a short-lived
 * read token scoped to exactly one website's aggregate numbers. Nothing here can
 * read anything else, and no credential ships in the bundle.
 *
 * Everything degrades to `null` — a missing share id, an unreachable instance, a
 * shape we don't recognise. Callers render nothing rather than a broken widget,
 * so the layout is identical to the pre-analytics app when stats are unavailable.
 */

import { UMAMI_SRC } from "./analytics";

export const UMAMI_SHARE_ID = process.env.NEXT_PUBLIC_UMAMI_SHARE_ID ?? "";

/** Umami has no "all time" query, so we start before the site existed. */
const ALL_TIME_START = Date.UTC(2024, 0, 1);
/** Stats move slowly; don't re-query on every mount within a session. */
const CACHE_MS = 5 * 60 * 1000;
const CACHE_KEY = "switch:stats";

export interface CountryCount {
  code: string;
  visitors: number;
}

export interface SwitchStats {
  /** Unique visitors, all time. */
  visitors: number;
  /** How many distinct countries have shown up. */
  countries: number;
  /** The country with the most visitors, or null when none resolved. */
  topCountry: CountryCount | null;
  /** collectionId → times opened. Only ids present in the data appear. */
  collectionOpens: Record<string, number>;
  /** The most-opened collection id, or null on a tie-less empty set. */
  topCollection: string | null;
}

/** The host Umami is served from, derived from the tracker script URL. */
function umamiOrigin(): string | null {
  try {
    return new URL(UMAMI_SRC).origin;
  } catch {
    return null;
  }
}

/**
 * Umami has returned metric counts as both `{ value: n }` and a bare `n` across
 * 2.x releases; accept either rather than pinning to one point version.
 */
function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "value" in v) {
    const inner = (v as { value: unknown }).value;
    if (typeof inner === "number" && Number.isFinite(inner)) return inner;
  }
  return 0;
}

/** Umami metrics come back as [{ x: label, y: count }]. */
interface MetricRow {
  x: string | null;
  y: unknown;
}

function rows(data: unknown): MetricRow[] {
  return Array.isArray(data) ? (data as MetricRow[]) : [];
}

const EVENT_PREFIX = "open:";

function readCache(): SwitchStats | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; stats: SwitchStats };
    if (Date.now() - parsed.at > CACHE_MS) return null;
    return parsed.stats;
  } catch {
    return null;
  }
}

function writeCache(stats: SwitchStats) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), stats }));
  } catch {
    // Private mode / quota — caching is an optimisation, not a requirement.
  }
}

/**
 * Fetch the public stats, or null if they can't be obtained for any reason.
 */
export async function fetchStats(
  signal?: AbortSignal
): Promise<SwitchStats | null> {
  const origin = umamiOrigin();
  if (!origin || !UMAMI_SHARE_ID) return null;

  const cached = readCache();
  if (cached) return cached;

  try {
    const shareRes = await fetch(`${origin}/api/share/${UMAMI_SHARE_ID}`, {
      signal,
    });
    if (!shareRes.ok) return null;
    const share = (await shareRes.json()) as {
      token?: string;
      websiteId?: string;
    };
    if (!share.token || !share.websiteId) return null;

    const headers = { "x-umami-share-token": share.token };
    const range = `startAt=${ALL_TIME_START}&endAt=${Date.now()}`;
    const base = `${origin}/api/websites/${share.websiteId}`;

    const [statsRes, countryRes, eventRes] = await Promise.all([
      fetch(`${base}/stats?${range}`, { headers, signal }),
      fetch(`${base}/metrics?${range}&type=country`, { headers, signal }),
      fetch(`${base}/metrics?${range}&type=event`, { headers, signal }),
    ]);
    if (!statsRes.ok) return null;

    const statsJson = (await statsRes.json()) as Record<string, unknown>;
    const countryRows = countryRes.ok ? rows(await countryRes.json()) : [];
    const eventRows = eventRes.ok ? rows(await eventRes.json()) : [];

    const countries = countryRows
      .filter((r) => !!r.x)
      .map((r) => ({ code: r.x as string, visitors: num(r.y) }))
      .sort((a, b) => b.visitors - a.visitors);

    const collectionOpens: Record<string, number> = {};
    for (const row of eventRows) {
      if (!row.x?.startsWith(EVENT_PREFIX)) continue;
      const id = row.x.slice(EVENT_PREFIX.length);
      if (id) collectionOpens[id] = (collectionOpens[id] ?? 0) + num(row.y);
    }
    const topCollection =
      Object.entries(collectionOpens).sort((a, b) => b[1] - a[1])[0]?.[0] ??
      null;

    const stats: SwitchStats = {
      visitors: num(statsJson.visitors),
      countries: countries.length,
      topCountry: countries[0] ?? null,
      collectionOpens,
      topCollection,
    };
    writeCache(stats);
    return stats;
  } catch {
    return null;
  }
}
