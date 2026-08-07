/**
 * Fetch an ML model with REAL progress, and keep it on the device.
 *
 * Two problems this solves, both about how the wait feels:
 *
 *  1. MediaPipe (and any wasm runtime) takes a model URL and gives you back
 *     nothing until it is done. On a slow connection that is many seconds of
 *     a screen that looks frozen — the app appears broken rather than busy.
 *     Fetching the bytes ourselves first lets us report actual percentage,
 *     and because it lands in the HTTP/Cache-Storage cache the loader that
 *     runs afterwards gets it instantly instead of downloading twice.
 *
 *  2. It should USUALLY only be slow once. Cache Storage survives reloads
 *     and closed tabs, so a later avatar normally skips the download. Note
 *     the word "usually": the cache can be cleared by the user or evicted
 *     under storage pressure, so never promise the model is permanently on
 *     the device — the UI says "cached on this device, future uses should
 *     start faster", which is what we can actually guarantee.
 *
 * Falls back gracefully everywhere: no Cache Storage (private mode, old
 * browsers) still works, just without persistence, and a failed prefetch is
 * not fatal because the model loader can always fetch the URL itself. An
 * evicted entry simply means one more download, never a broken flow.
 */

const CACHE_NAME = "switch-models-v1";

export interface PrefetchProgress {
  /** 0..1 when the server sent a length, otherwise null (indeterminate). */
  ratio: number | null;
  /** Bytes received so far. */
  loaded: number;
  /** Total bytes, when known. */
  total: number | null;
  /** True when the model was already on the device — no download at all. */
  cached: boolean;
}

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === "undefined") return null;
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/** Whether this model is already on the device (so the UI can skip the bar). */
export async function isModelCached(url: string): Promise<boolean> {
  const cache = await openCache();
  if (!cache) return false;
  try {
    return !!(await cache.match(url));
  } catch {
    return false;
  }
}

/**
 * Download `url` (or read it from the device cache), reporting progress.
 *
 * Resolves once the bytes are local. The caller then hands the SAME url to
 * whatever loader wants it, which now resolves from cache.
 */
export async function prefetchModel(
  url: string,
  onProgress?: (p: PrefetchProgress) => void
): Promise<void> {
  const cache = await openCache();

  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        onProgress?.({ ratio: 1, loaded: 0, total: null, cached: true });
        return;
      }
    } catch {
      /* unreadable cache — just download */
    }
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    // Let the real loader deal with it; reporting "done" keeps the UI moving
    // rather than parking on a bar that will never fill.
    onProgress?.({ ratio: 1, loaded: 0, total: null, cached: false });
    return;
  }

  const header = res.headers.get("content-length");
  const total = header ? Number(header) : null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({
      ratio: total ? Math.min(1, loaded / total) : null,
      loaded,
      total,
      cached: false,
    });
  }

  if (cache) {
    try {
      const body = new Blob(chunks as BlobPart[]);
      await cache.put(url, new Response(body, { headers: res.headers }));
    } catch {
      /* over quota or blocked — the download still warmed the HTTP cache */
    }
  }
  onProgress?.({ ratio: 1, loaded, total, cached: false });
}
