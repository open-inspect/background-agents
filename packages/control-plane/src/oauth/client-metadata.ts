/**
 * OAuth clients identified by client ID metadata documents: the client's id is the HTTPS URL of a
 * JSON document describing it, which the authorization server fetches.
 *
 * Only clients the API policy lists are ever fetched, by their exact URL, so a request cannot
 * point this server at an address of its choosing. The fetch follows no redirect, is capped in
 * size and time, and the document must name itself as the client it describes.
 */

import { readBodyCapped } from "@open-inspect/shared/http-body";
import { z } from "zod";

/** Largest client metadata document accepted. Real ones are a few hundred bytes. */
export const CLIENT_METADATA_MAX_BYTES = 5 * 1024;

/** How long fetching a client metadata document may take. */
const CLIENT_METADATA_FETCH_TIMEOUT_MS = 5_000;

/** The parts of a client metadata document this server reads. Others are ignored. */
const clientMetadataSchema = z.object({
  client_id: z.string(),
  client_name: z.unknown().optional(),
  redirect_uris: z.array(z.string()).min(1),
  token_endpoint_auth_method: z.string().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  client_secret: z.unknown().optional(),
  client_secret_expires_at: z.unknown().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

export interface ClientMetadata {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  /** The document's own name for the client, if it gives a short plain one. Self-asserted. */
  readonly clientName: string | null;
}

/** Longest client name shown; a longer one is not shown at all. */
const CLIENT_NAME_MAX_LENGTH = 60;

function displayableName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > CLIENT_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    return null;
  }
  return name;
}

export class ClientMetadataError extends Error {}

/**
 * Whether a document lets its client authenticate at the token endpoint with `none`, the only
 * method this server accepts. Per the client ID metadata document draft (-03, section 5): the
 * plural `token_endpoint_auth_methods_supported` is what a client should send and must be honoured
 * when present; the singular `token_endpoint_auth_method` may be read only when the plural is
 * absent, and must then be among the plural's values if both appear; `none` is assumed only when
 * neither is present (never the RFC 7591 default of `client_secret_basic`). A document may not
 * carry a client secret at all.
 */
function usesNoClientAuthentication(document: z.infer<typeof clientMetadataSchema>): boolean {
  if (document.client_secret !== undefined || document.client_secret_expires_at !== undefined) {
    return false;
  }
  const plural = document.token_endpoint_auth_methods_supported;
  const singular = document.token_endpoint_auth_method;
  if (plural !== undefined) {
    return plural.includes("none") && (singular === undefined || plural.includes(singular));
  }
  return (singular ?? "none") === "none";
}

/** Fetches with the platform's `fetch` unless a test supplies another. */
export type ClientMetadataFetch = (request: Request) => Promise<Response>;

/**
 * Fetch and validate the metadata document a client id names. The caller must already have
 * checked that the id is one the policy lists.
 */
export async function fetchClientMetadata(
  clientId: string,
  fetcher: ClientMetadataFetch = (request) => fetch(request)
): Promise<ClientMetadata> {
  let response: Response;
  try {
    response = await fetcher(
      new Request(clientId, {
        headers: { Accept: "application/json" },
        // No `cache` option: the Workers runtime at this deployment's compatibility date rejects
        // it. Nothing here caches a document, and each sign-in fetches it afresh.
        redirect: "manual",
        signal: AbortSignal.timeout(CLIENT_METADATA_FETCH_TIMEOUT_MS),
      })
    );
  } catch {
    throw new ClientMetadataError("The app's metadata document could not be fetched");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new ClientMetadataError("The app's metadata document could not be fetched");
  }
  const bytes = await readBodyCapped(response.body, CLIENT_METADATA_MAX_BYTES);
  if (bytes === null) throw new ClientMetadataError("The app's metadata document is too large");
  let parsed: z.infer<typeof clientMetadataSchema>;
  try {
    parsed = clientMetadataSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new ClientMetadataError("The app's metadata document is not valid");
  }
  if (parsed.client_id !== clientId) {
    throw new ClientMetadataError("The app's metadata document names a different app");
  }
  // This server issues tokens to public clients only, which prove possession with PKCE.
  if (!usesNoClientAuthentication(parsed)) {
    throw new ClientMetadataError("The app authenticates in a way this server does not support");
  }
  if (parsed.grant_types && !parsed.grant_types.includes("authorization_code")) {
    throw new ClientMetadataError("The app does not use the authorization code flow");
  }
  if (parsed.response_types && !parsed.response_types.includes("code")) {
    throw new ClientMetadataError("The app does not use the authorization code flow");
  }
  return {
    clientId,
    redirectUris: parsed.redirect_uris,
    clientName: displayableName(parsed.client_name),
  };
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Whether a redirect URI sends the code to an app on the user's own device. */
export function isLoopbackRedirectUri(value: string): boolean {
  const url = parseUrl(value);
  return url !== null && url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
}

/** The URI without its port, for comparing loopback redirects (RFC 8252 §7.3). */
function withoutPort(url: URL): string {
  const copy = new URL(url.href);
  copy.port = "";
  return copy.href;
}

/**
 * Whether `redirectUri` is one the client registered. A loopback redirect matches a registered
 * loopback URI whatever its port, since a native app binds whichever port is free; any other must
 * match exactly and be served from the client's own origin.
 */
export function isRegisteredRedirectUri(
  metadata: Pick<ClientMetadata, "clientId" | "redirectUris">,
  redirectUri: string
): boolean {
  const requested = parseUrl(redirectUri);
  if (requested === null || requested.hash !== "" || redirectUri.includes("#")) return false;
  if (isLoopbackRedirectUri(redirectUri)) {
    const bare = withoutPort(requested);
    return metadata.redirectUris.some(
      (registered) => isLoopbackRedirectUri(registered) && withoutPort(new URL(registered)) === bare
    );
  }
  return (
    requested.protocol === "https:" &&
    requested.origin === new URL(metadata.clientId).origin &&
    metadata.redirectUris.includes(redirectUri)
  );
}
