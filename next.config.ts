import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Every page is per-user and permission-dependent; nothing is statically cached.
  serverExternalPackages: ["better-sqlite3", "unifi-protect"],
  poweredByHeader: false,
  devIndicators: false,
  // Development only: extra hostnames (comma separated) allowed to load dev assets, e.g. a tunnel.
  allowedDevOrigins: process.env.DEV_ALLOWED_ORIGINS?.split(",") ?? [],
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" },
    ] }];
  },
};

export default nextConfig;
