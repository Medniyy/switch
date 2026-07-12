import type { NextConfig } from "next";

// Default to a domain root. Override with NEXT_PUBLIC_BASE_PATH="/subpath" to
// serve TOTEM under a subpath (e.g. a GitHub Pages project site).
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // Pure static export — no server, no API routes. Deploys to any static host.
  output: "export",
  basePath,
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
