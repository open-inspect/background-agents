import { readBodyCapped } from "@open-inspect/shared/http-body";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PRIVATE_NO_STORE_HEADERS, relayJsonResponse } from "@/lib/control-plane-json-proxy";

/** An approval names a request and a grant; this is far above any real one. */
const MAX_APPROVAL_BYTES = 64 * 1024;

/**
 * The consent page's approval: forwards the signed-in user's choice to the control plane, which
 * checks it, records an authorization code, and answers where to send the browser with it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  // Approving issues a credential to an app, so it happens only from this app's own consent page:
  // positive browser Fetch Metadata evidence, as the API policy's own changes require.
  if (request.headers.get("sec-fetch-site") !== "same-origin") {
    return NextResponse.json(
      { error: "Same-origin Fetch Metadata is required" },
      { status: 403, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyCapped(request.body, MAX_APPROVAL_BYTES);
  } catch {
    // A body that broke off is never forwarded in part.
    return NextResponse.json(
      { error: "The approval could not be read; try again" },
      { status: 400, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }
  if (bytes === null) {
    return NextResponse.json(
      { error: "The approval is too large" },
      { status: 413, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }
  try {
    return await relayJsonResponse(
      await controlPlaneUserFetch("/oauth/authorize/approve", {
        method: "POST",
        body: new TextDecoder().decode(bytes),
      })
    );
  } catch {
    return NextResponse.json(
      { error: "The approval could not be recorded; try again" },
      { status: 502, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }
}
