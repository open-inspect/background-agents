import { redirect } from "next/navigation";
import { z } from "zod";
import {
  OAUTH_AUTHORIZATION_REQUEST_PARAMETERS,
  oauthAuthorizationRequestSchema,
  oauthConsentResponseSchema,
  type OAuthAuthorizationRequest,
  type OAuthConsentResponse,
} from "@open-inspect/shared/types/oauth";
import { OAuthConsent } from "@/components/oauth/oauth-consent";
import { ErrorBanner } from "@/components/ui/error-banner";
import { AuthenticationUnavailableError } from "@/lib/authentication-unavailable-error";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { getServerAuthSession, type ServerAuthSession } from "@/lib/server-auth-session";
import { MAX_RETURN_TO_LENGTH, signInPath } from "@/lib/sign-in-return-to";
import { APP_NAME } from "@/lib/site-config";

export const dynamic = "force-dynamic";

/** This page's own path: sign-in returns here, and only here, with the request intact. */
const AUTHORIZE_PATH = "/oauth/authorize";

function SignInRefused({ message }: { message: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold text-foreground">An app could not sign in</h1>
      <ErrorBanner role="alert">{message}</ErrorBanner>
      <p className="text-sm text-muted-foreground">
        Return to the app and try again. Nothing was shared with it.
      </p>
    </main>
  );
}

interface AuthorizePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** The authorization request's parameters, each at most once; null when one is repeated. */
function authorizationRequest(
  query: Record<string, string | string[] | undefined>
): OAuthAuthorizationRequest | null {
  const request: Record<string, string> = {};
  for (const name of OAUTH_AUTHORIZATION_REQUEST_PARAMETERS) {
    const value = query[name];
    if (Array.isArray(value)) return null;
    if (value !== undefined) request[name] = value;
  }
  const parsed = oauthAuthorizationRequestSchema.safeParse(request);
  return parsed.success ? parsed.data : null;
}

const refusalBodySchema = z.object({ error: z.string().optional(), code: z.string().optional() });

/** What a refusal of the signed-in user, rather than of the app, tells them. */
function refusalMessage(body: unknown): string {
  const parsed = refusalBodySchema.safeParse(body);
  if (parsed.success && parsed.data.code === "active_user_required") {
    return "Your workspace access is disabled.";
  }
  return parsed.success && parsed.data.error && parsed.data.error !== "Forbidden"
    ? parsed.data.error
    : "Your account cannot sign apps in to this workspace.";
}

/**
 * The control plane's verdict on the request for the signed-in user, a refusal of the user
 * themselves (`{ refused }`), or null when it could not be had.
 */
async function checkRequest(
  request: OAuthAuthorizationRequest
): Promise<OAuthConsentResponse | { refused: string } | null> {
  try {
    const response = await controlPlaneUserFetch("/oauth/authorize/check", {
      method: "POST",
      body: JSON.stringify(request),
    });
    if (response.status === 403) {
      return { refused: refusalMessage(await response.json().catch(() => null)) };
    }
    if (!response.ok) return null;
    return oauthConsentResponseSchema.parse(await response.json());
  } catch {
    return null;
  }
}

/**
 * The OAuth authorization endpoint for MCP clients signing in. A signed-out user signs in first and
 * returns here. The control plane checks the request (the app, where it returns, what it asks for)
 * only once the user is signed in, so an unauthenticated visitor cannot make it fetch anything.
 */
export default async function OAuthAuthorizePage({ searchParams }: AuthorizePageProps) {
  const request = authorizationRequest(await searchParams);
  if (request === null) {
    return <SignInRefused message="The app's sign-in request is not valid." />;
  }
  // The request must survive the round trip through sign-in, which returns only to a path of
  // bounded length; refused here, it is refused the same way for every user.
  const returnPath = `${AUTHORIZE_PATH}?${new URLSearchParams(request)}`;
  if (returnPath.length > MAX_RETURN_TO_LENGTH) {
    return <SignInRefused message="The app's sign-in request is too long." />;
  }

  let session: ServerAuthSession | null;
  try {
    session = await getServerAuthSession();
  } catch (error) {
    if (error instanceof AuthenticationUnavailableError) {
      return <SignInRefused message={`Signing in to ${APP_NAME} is temporarily unavailable.`} />;
    }
    throw error;
  }
  if (!session) {
    redirect(signInPath(returnPath));
  }

  const consent = await checkRequest(request);
  if (consent !== null && "refused" in consent) {
    return <SignInRefused message={consent.refused} />;
  }
  if (consent === null) {
    return <SignInRefused message="The app's request could not be checked. Try again shortly." />;
  }
  if (consent.kind === "redirect") redirect(consent.url);
  if (consent.kind === "error") return <SignInRefused message={consent.message} />;
  return <OAuthConsent consent={consent} request={request} />;
}
