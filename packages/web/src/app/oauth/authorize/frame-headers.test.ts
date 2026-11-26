import { expect, it } from "vitest";
import nextConfig from "../../../../next.config";

it("serves the consent page so no other page can frame it", async () => {
  const rules = (await nextConfig.headers?.()) ?? [];
  const consent = rules.find((rule) => rule.source === "/oauth/authorize");
  expect(consent?.headers).toEqual(
    expect.arrayContaining([
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Cache-Control", value: "private, no-store" },
    ])
  );
});
