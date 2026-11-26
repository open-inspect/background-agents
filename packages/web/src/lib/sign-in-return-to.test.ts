import { describe, expect, it } from "vitest";
import { safeReturnTo, signInPath } from "./sign-in-return-to";

describe("safeReturnTo", () => {
  it.each([
    ["/", "/"],
    [
      "/oauth/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fx&state=1",
      "/oauth/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fx&state=1",
    ],
    ["/settings?tab=tokens#ignored", "/settings?tab=tokens"],
  ])("keeps the same-origin path %s", (value, expected) => {
    expect(safeReturnTo(value)).toBe(expected);
  });

  it.each([
    ["an absolute URL", "https://evil.example/"],
    ["a protocol-relative URL", "//evil.example/path"],
    ["a dot segment before a protocol-relative path", "/.//evil.example"],
    ["a parent segment before a protocol-relative path", "/..//evil.example"],
    ["a nested parent segment before a protocol-relative path", "/a/..//evil.example"],
    ["an encoded dot segment before a protocol-relative path", "/%2e//evil.example"],
    ["an encoded parent segment before a protocol-relative path", "/%2e%2e//evil.example"],
    ["a dot segment before a backslash", "/./\\evil.example"],
    ["an encoded backslash after a dot segment", "/.//%5cevil.example"],
    ["a backslash a browser reads as a slash", "/\\evil.example"],
    ["a relative path", "settings"],
    ["a control character", "/\u0000"],
    ["a scheme", "javascript:alert(1)"],
    ["a repeated parameter", ["/a", "/b"]],
    ["nothing", undefined],
    ["an over-long path", `/${"a".repeat(9000)}`],
  ])("refuses %s", (_label, value) => {
    expect(safeReturnTo(value)).toBeNull();
  });
});

describe("signInPath", () => {
  it("names the path to return to as a query parameter", () => {
    expect(signInPath("/oauth/authorize?a=1&b=2")).toBe(
      "/login?returnTo=%2Foauth%2Fauthorize%3Fa%3D1%26b%3D2"
    );
  });
});
