import { afterEach, describe, expect, it, vi } from "vitest";
import { trustedClientIp } from "./trusted-client-ip";

afterEach(() => vi.unstubAllEnvs());

const HEADERS = {
  "X-Vercel-Forwarded-For": "203.0.113.1",
  "CF-Connecting-IP": "198.51.100.2",
  "X-Forwarded-For": "192.0.2.3",
};

describe("trustedClientIp", () => {
  it("reads Vercel's header on Vercel, never Cloudflare's", () => {
    vi.stubEnv("VERCEL", "1");
    expect(trustedClientIp(new Request("https://app.example", { headers: HEADERS }))).toBe(
      "203.0.113.1"
    );
  });

  it("reads Cloudflare's header on Cloudflare, never a forwarded one", () => {
    vi.stubEnv("VERCEL", "");
    const request = new Request("https://app.example", { headers: HEADERS });
    Object.defineProperty(request, "cf", { value: {} });
    expect(trustedClientIp(request)).toBe("198.51.100.2");
  });

  it("vouches for nothing elsewhere", () => {
    vi.stubEnv("VERCEL", "");
    expect(trustedClientIp(new Request("https://app.example", { headers: HEADERS }))).toBeNull();
  });
});
