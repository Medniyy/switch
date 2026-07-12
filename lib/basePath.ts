/**
 * The path the app is served under (e.g. "/switch" for a subpath deploy).
 *
 * Next.js prefixes <Link>/router and bundled assets with basePath
 * automatically, but raw fetch() calls and string asset paths (the NFT data
 * JSON and the MediaPipe WASM/model) do NOT — so prepend BASE_PATH to those.
 *
 * Set NEXT_PUBLIC_BASE_PATH to "" to serve from the domain root instead.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * Join BASE_PATH with a root-relative asset path (e.g. "/masks/mad-lads/3.webp")
 * without producing a doubled or missing slash. Use this for any raw string
 * asset URL or fetch() target that Next.js does not prefix automatically.
 */
export function withBasePath(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${p}`;
}
