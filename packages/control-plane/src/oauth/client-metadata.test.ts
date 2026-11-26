import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_METADATA_MAX_BYTES,
  fetchClientMetadata,
  isLoopbackRedirectUri,
  isRegisteredRedirectUri,
} from "./client-metadata";

const CLIENT = "https://client.example/oauth/metadata";

function serving(document: unknown, init?: ResponseInit) {
  return vi.fn(async (_request: Request) =>
    typeof document === "string" ? new Response(document, init) : Response.json(document, init)
  );
}

describe("fetchClientMetadata", () => {
  it("fetches the document without following redirects, and reads its redirect URIs", async () => {
    const fetcher = serving({
      client_id: CLIENT,
      client_name: "Anything",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
    });
    await expect(fetchClientMetadata(CLIENT, fetcher)).resolves.toEqual({
      clientId: CLIENT,
      redirectUris: ["https://client.example/callback"],
      clientName: "Anything",
    });
    const [request] = fetcher.mock.calls[0]!;
    expect(request.url).toBe(CLIENT);
    expect(request.redirect).toBe("manual");
  });

  it("keeps a client name only when it is short, plain text", async () => {
    for (const [name, shown] of [
      ["Claude Code", "Claude Code"],
      ["x".repeat(61), null],
      ["Evil\u0007", null],
      [42, null],
    ] as const) {
      const fetcher = serving({
        client_id: CLIENT,
        client_name: name,
        redirect_uris: ["https://client.example/cb"],
      });
      await expect(fetchClientMetadata(CLIENT, fetcher)).resolves.toMatchObject({
        clientName: shown,
      });
    }
  });

  it("accepts a public client however the document says so, and nothing else", async () => {
    const document = (extra: object) =>
      serving({ client_id: CLIENT, redirect_uris: ["https://client.example/cb"], ...extra });
    for (const accepted of [
      {},
      { token_endpoint_auth_method: "none" },
      { token_endpoint_auth_methods_supported: ["none"] },
      { token_endpoint_auth_methods_supported: ["private_key_jwt", "none"] },
      { token_endpoint_auth_methods_supported: ["none"], token_endpoint_auth_method: "none" },
    ]) {
      await expect(
        fetchClientMetadata(CLIENT, document(accepted)),
        JSON.stringify(accepted)
      ).resolves.toMatchObject({ clientId: CLIENT });
    }
    for (const refused of [
      { token_endpoint_auth_method: "private_key_jwt" },
      { token_endpoint_auth_methods_supported: ["private_key_jwt"] },
      // The plural is honoured over a singular `none`.
      {
        token_endpoint_auth_methods_supported: ["private_key_jwt"],
        token_endpoint_auth_method: "none",
      },
      // A singular value outside the plural is inconsistent.
      {
        token_endpoint_auth_methods_supported: ["none"],
        token_endpoint_auth_method: "private_key_jwt",
      },
      { client_secret: "shh" },
      { client_secret_expires_at: 0 },
    ]) {
      await expect(
        fetchClientMetadata(CLIENT, document(refused)),
        JSON.stringify(refused)
      ).rejects.toThrow("authenticates in a way");
    }
  });

  it("does not repeat the document host's status to the user", async () => {
    await expect(fetchClientMetadata(CLIENT, serving("nope", { status: 418 }))).rejects.toThrow(
      "The app's metadata document could not be fetched"
    );
  });

  it.each([
    ["a redirect", serving("", { status: 302, headers: { Location: "https://elsewhere/" } })],
    ["an error status", serving("nope", { status: 404 })],
    [
      "a document for another client",
      serving({ client_id: "https://other.example/m", redirect_uris: ["https://x/"] }),
    ],
    ["no redirect URIs", serving({ client_id: CLIENT, redirect_uris: [] })],
    [
      "a confidential client",
      serving({
        client_id: CLIENT,
        redirect_uris: ["https://client.example/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    ],
    [
      "another grant",
      serving({
        client_id: CLIENT,
        redirect_uris: ["https://client.example/cb"],
        grant_types: ["client_credentials"],
      }),
    ],
    [
      "another response type",
      serving({
        client_id: CLIENT,
        redirect_uris: ["https://client.example/cb"],
        response_types: ["token"],
      }),
    ],
    ["not JSON", serving("<html>")],
    [
      "an oversized document",
      serving({
        client_id: CLIENT,
        redirect_uris: ["https://client.example/cb"],
        padding: "x".repeat(CLIENT_METADATA_MAX_BYTES),
      }),
    ],
    [
      "a failed fetch",
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    ],
  ])("refuses %s", async (_label, fetcher) => {
    await expect(fetchClientMetadata(CLIENT, fetcher)).rejects.toThrow();
  });
});

describe("redirect URI matching", () => {
  const metadata = {
    clientId: CLIENT,
    redirectUris: [
      "https://client.example/callback",
      "https://elsewhere.example/callback",
      "http://localhost/callback",
      "http://127.0.0.1/callback",
    ],
  };

  it("matches a registered URI on the client's origin exactly", () => {
    expect(isRegisteredRedirectUri(metadata, "https://client.example/callback")).toBe(true);
    expect(isRegisteredRedirectUri(metadata, "https://client.example/callback?x=1")).toBe(false);
    expect(isRegisteredRedirectUri(metadata, "https://client.example/callback/")).toBe(false);
    expect(isRegisteredRedirectUri(metadata, "https://client.example/callback#x")).toBe(false);
  });

  it("refuses a registered URI on another origin than the client's", () => {
    expect(isRegisteredRedirectUri(metadata, "https://elsewhere.example/callback")).toBe(false);
  });

  it("matches a loopback URI whatever its port, by name or address", () => {
    expect(isRegisteredRedirectUri(metadata, "http://localhost:53682/callback")).toBe(true);
    expect(isRegisteredRedirectUri(metadata, "http://127.0.0.1:8/callback")).toBe(true);
    expect(isRegisteredRedirectUri(metadata, "http://127.0.0.1:8/other")).toBe(false);
    expect(isRegisteredRedirectUri(metadata, "http://[::1]:8/callback")).toBe(false);
    expect(isRegisteredRedirectUri(metadata, "https://localhost:8/callback")).toBe(false);
  });

  it("knows a loopback redirect", () => {
    expect(isLoopbackRedirectUri("http://127.0.0.1:1/cb")).toBe(true);
    expect(isLoopbackRedirectUri("http://[::1]/cb")).toBe(true);
    expect(isLoopbackRedirectUri("https://client.example/cb")).toBe(false);
    expect(isLoopbackRedirectUri("not a url")).toBe(false);
  });
});
