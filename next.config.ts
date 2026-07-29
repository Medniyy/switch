import type { NextConfig } from "next";

// Default to a domain root. Override with NEXT_PUBLIC_BASE_PATH="/subpath" to
// serve TOTEM under a subpath (e.g. a GitHub Pages project site).
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// DEV ONLY: Next 15+/16 blocks cross-origin requests to dev resources (e.g. the
// HMR websocket) from non-localhost origins. To hot-reload on a real phone over
// the LAN, set DEV_LAN_ORIGIN to that phone-facing host (e.g. "192.168.0.100" or
// "192.168.0.100:3000"). Scoped to exactly what you pass — nothing is loosened by
// default, and it has no effect on the production static export.
const allowedDevOrigins = (process.env.DEV_LAN_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // Pure static export — no server, no API routes. Deploys to any static host.
  output: "export",
  basePath,
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}),
  // Expose the basePath to client code for raw fetch()/asset string paths.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  // Static export has no Image Optimization server; NFT art + covers load directly
  // via plain <img>. Disable the optimizer.
  images: {
    unoptimized: true,
  },
  // Trailing slashes make static hosting routing predictable.
  trailingSlash: true,
};

export default nextConfig;
