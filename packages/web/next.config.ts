import path from "path";
import type { NextConfig } from "next";

const monorepoRoot = path.join(__dirname, "../..");

const nextConfig: NextConfig = {
  agentRules: false,
  output: "standalone",
  // Both must match the monorepo root for Turbopack to resolve workspace packages
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
  async headers() {
    return [
      {
        source: "/mermaid-renderer.html",
        // Also isolate direct navigation, not just embeds with the sandbox attribute.
        // The generated document supplies its stricter hash-based resource policy.
        headers: [{ key: "Content-Security-Policy", value: "sandbox allow-scripts" }],
      },
      {
        // The OAuth consent page grants an app access as the signed-in user, so no other page may
        // frame it and trick a click onto Allow. Its URL carries the app's request, which no
        // destination needs as a referrer.
        source: "/oauth/authorize",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
