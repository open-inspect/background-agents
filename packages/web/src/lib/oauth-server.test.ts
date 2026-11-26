import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { FixedWindowRateLimiter } from "./oauth-server";

describe("FixedWindowRateLimiter", () => {
  it("allows a key its limit per window, then refuses it until the window passes", () => {
    const limiter = new FixedWindowRateLimiter(2, 1000);
    expect([limiter.take("a", 0), limiter.take("a", 10), limiter.take("a", 20)]).toEqual([
      true,
      true,
      false,
    ]);
    expect(limiter.take("b", 20)).toBe(true);
    expect(limiter.take("a", 1000)).toBe(true);
  });

  it("forgets the oldest key beyond its capacity", () => {
    const limiter = new FixedWindowRateLimiter(1, 1000, 2);
    limiter.take("a", 0);
    limiter.take("b", 0);
    limiter.take("c", 0);
    // "a" was dropped, so it starts a fresh window.
    expect(limiter.take("a", 1)).toBe(true);
    expect(limiter.take("c", 1)).toBe(false);
  });
});
