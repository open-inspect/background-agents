/**
 * Google Cloud Service Account authentication (OAuth2 JWT Bearer grant).
 *
 * Uses the Web Crypto API (RSASSA-PKCS1-v1_5 + SHA-256) so it runs in both
 * Cloudflare Workers and Node.js without external SDK dependencies.
 */

import { z } from "zod";
import { base64UrlEncode } from "../../../auth/encoding";

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const COMPUTE_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const TOKEN_FETCH_TIMEOUT_MS = 15_000;

export const gcpServiceAccountKeySchema = z.object({
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.string().min(1).optional(),
  project_id: z.string().optional(),
});

export type GcpServiceAccountKey = z.infer<typeof gcpServiceAccountKeySchema>;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

/**
 * Parse a GCP service account JSON key string.
 */
export function parseGcpServiceAccountKey(raw: string): GcpServiceAccountKey {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error("GCP_SERVICE_ACCOUNT_JSON must be valid JSON");
  }

  const parsed = gcpServiceAccountKeySchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error("GCP_SERVICE_ACCOUNT_JSON must include client_email and private_key fields");
  }
  return parsed.data;
}

function parsePemPrivateKey(pem: string): Uint8Array {
  const pemContents = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s/g, "");

  const binaryString = atob(pemContents);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = parsePemPrivateKey(pem);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["sign"]
    );
  } catch {
    throw new Error(
      "Unable to import GCP service account private_key. Ensure it is a valid PKCS#8 RSA key."
    );
  }
}

async function createServiceAccountJwt(
  credentials: GcpServiceAccountKey,
  cryptoKey: CryptoKey,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<string> {
  const tokenUri = credentials.token_uri || DEFAULT_TOKEN_URI;
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: credentials.client_email,
    sub: credentials.client_email,
    scope: COMPUTE_SCOPE,
    aud: tokenUri,
    iat: nowSeconds - 30,
    exp: nowSeconds + 3600,
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(payload)
  )}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export interface GcpTokenProvider {
  getAccessToken(signal?: AbortSignal): Promise<string>;
}

/**
 * Caches imported CryptoKey and exchanged OAuth2 access tokens in memory.
 */
export class GcpServiceAccountTokenProvider implements GcpTokenProvider {
  private cryptoKeyPromise?: Promise<CryptoKey>;
  private cachedToken?: { accessToken: string; expiresAtMs: number };
  private refreshInFlight?: Promise<string>;

  constructor(private readonly credentials: GcpServiceAccountKey) {}

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.cachedToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
      return this.cachedToken.accessToken;
    }

    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    const promise = this.refreshAccessToken(signal).finally(() => {
      if (this.refreshInFlight === promise) {
        this.refreshInFlight = undefined;
      }
    });
    this.refreshInFlight = promise;
    return promise;
  }

  private async getCryptoKey(): Promise<CryptoKey> {
    this.cryptoKeyPromise ||= importRsaPrivateKey(this.credentials.private_key).catch((err) => {
      this.cryptoKeyPromise = undefined;
      throw err;
    });
    return this.cryptoKeyPromise;
  }

  private async refreshAccessToken(signal?: AbortSignal): Promise<string> {
    const cryptoKey = await this.getCryptoKey();
    const assertion = await createServiceAccountJwt(this.credentials, cryptoKey);
    const tokenUri = this.credentials.token_uri || DEFAULT_TOKEN_URI;

    const timeoutSignal = AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const response = await fetch(tokenUri, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      signal: combinedSignal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to exchange GCP service account JWT: ${response.status} ${text}`);
    }

    const raw = await response.json();
    const parsed = tokenResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("Invalid GCP OAuth2 token response");
    }

    this.cachedToken = {
      accessToken: parsed.data.access_token,
      expiresAtMs: Date.now() + parsed.data.expires_in * 1000,
    };
    return parsed.data.access_token;
  }
}
