import {
  createBoatRestClient,
  DEFAULT_BOAT_API_URL,
  isBoatMachineType,
  type BoatMachineType,
  type BoatRestClient,
} from "./boat-rest-client";
import { createModalClient } from "./client";
import { createDaytonaRestClient, type DaytonaRestClient } from "./daytona-rest-client";
import { createE2BRestClient } from "./e2b-rest-client";
import { resolveSandboxBackendName, type SandboxBackendName } from "./provider-name";
import type { SandboxProvider } from "./provider";
import { createBoatProvider, type BoatSandboxProvider } from "./providers/boat-provider";
import { createDaytonaProvider, type DaytonaSandboxProvider } from "./providers/daytona-provider";
import {
  createE2BProvider,
  DEFAULT_E2B_AUTO_PAUSE,
  DEFAULT_E2B_SANDBOX_TIMEOUT_SECONDS,
  type E2BSandboxProvider,
} from "./providers/e2b-provider";
import { createModalProvider, type ModalSandboxProvider } from "./providers/modal-provider";
import { GcpServiceAccountTokenProvider, parseGcpServiceAccountKey } from "./providers/gcp/auth";
import { createGcpComputeClient, type GcpComputeClient } from "./providers/gcp/client";
import {
  createGcpProvider,
  DEFAULT_GCP_BOOT_DISK_SIZE_GB,
  DEFAULT_GCP_DISK_RETENTION_DAYS,
  DEFAULT_GCP_ZONES,
  type GcpProviderConfig,
  type GcpSandboxProvider,
} from "./providers/gcp/provider";
import { createVercelSandboxClient } from "./providers/vercel/client";
import { createVercelProvider, type VercelSandboxProvider } from "./providers/vercel/provider";
import { resolveScmProviderFromEnv } from "../source-control";
import type { Env } from "../types";

function createModalProviderFromEnv(env: Env, backend: "modal" | "modal-vm"): ModalSandboxProvider {
  if (!env.MODAL_API_SECRET || !env.MODAL_WORKSPACE) {
    throw new Error(
      `MODAL_API_SECRET and MODAL_WORKSPACE are required when SANDBOX_PROVIDER=${backend}`
    );
  }

  const client = createModalClient(
    env.MODAL_API_SECRET,
    env.MODAL_WORKSPACE,
    env.MODAL_ENVIRONMENT_WEB_SUFFIX,
    env.MODAL_API_URL
  );

  return createModalProvider(client, backend, resolveScmProviderFromEnv(env.SCM_PROVIDER));
}

function createVercelProviderFromEnv(env: Env): VercelSandboxProvider {
  if (!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID) {
    throw new Error("VERCEL_TOKEN and VERCEL_PROJECT_ID are required when SANDBOX_PROVIDER=vercel");
  }

  const client = createVercelSandboxClient({
    token: env.VERCEL_TOKEN,
    projectId: env.VERCEL_PROJECT_ID,
    teamId: env.VERCEL_TEAM_ID,
    apiBaseUrl: env.VERCEL_SANDBOX_API_BASE_URL,
  });

  return createVercelProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    token: env.VERCEL_TOKEN,
    teamId: env.VERCEL_TEAM_ID,
    apiBaseUrl: env.VERCEL_SANDBOX_API_BASE_URL,
    baseSnapshotId: env.VERCEL_BASE_SNAPSHOT_ID,
    baseSnapshotName: env.VERCEL_BASE_SNAPSHOT_NAME,
    runtime: env.VERCEL_RUNTIME,
    snapshotExpirationMs: parseNumericEnv(
      "VERCEL_SNAPSHOT_EXPIRATION_MS",
      env.VERCEL_SNAPSHOT_EXPIRATION_MS,
      0
    ),
    sandboxAccessPasswordSecret: env.VERCEL_TOKEN,
  });
}

function createGcpProviderFromEnv(env: Env): GcpSandboxProvider {
  const { client, config } = resolveGcpSetupFromEnv(env);
  return createGcpProvider(client, config);
}

/**
 * The Compute Engine client and provider settings a GCP deployment runs with,
 * shared by sandbox sessions and image builds so both create VMs alike.
 */
export function resolveGcpSetupFromEnv(env: Env): {
  client: GcpComputeClient;
  config: GcpProviderConfig;
} {
  if (!env.GCP_SERVICE_ACCOUNT_JSON) {
    throw new Error("GCP_SERVICE_ACCOUNT_JSON is required when SANDBOX_PROVIDER=gcp");
  }
  const credentials = parseGcpServiceAccountKey(env.GCP_SERVICE_ACCOUNT_JSON);
  const project = env.GCP_PROJECT?.trim() || credentials.project_id?.trim() || "";
  if (!project) {
    throw new Error("GCP_PROJECT is required when SANDBOX_PROVIDER=gcp");
  }
  const configuredZones = splitCsvEnv(env.GCP_ZONES);
  const zones = configuredZones.length > 0 ? configuredZones : DEFAULT_GCP_ZONES;

  const client = createGcpComputeClient({
    project,
    tokenProvider: new GcpServiceAccountTokenProvider(credentials),
    apiBaseUrl: env.GCP_COMPUTE_API_BASE_URL,
    imageProject: env.GCP_IMAGE_PROJECT,
  });

  const config: GcpProviderConfig = {
    project,
    zones,
    defaultImageFamily: env.GCP_IMAGE_FAMILY,
    machineType: env.GCP_MACHINE_TYPE,
    bootDiskSizeGb: parseNumericEnv(
      "GCP_BOOT_DISK_SIZE_GB",
      env.GCP_BOOT_DISK_SIZE_GB,
      DEFAULT_GCP_BOOT_DISK_SIZE_GB
    ),
    bootDiskType: env.GCP_BOOT_DISK_TYPE,
    network: env.GCP_NETWORK,
    subnet: env.GCP_SUBNET,
    vmServiceAccountEmail: env.GCP_VM_SERVICE_ACCOUNT_EMAIL,
    instanceLabels: parseKeyValueCsvEnv(env.GCP_INSTANCE_LABELS),
    vertexProject: env.GCP_VERTEX_PROJECT,
    vertexLocation: env.GCP_VERTEX_LOCATION,
    useSpot: parseBooleanEnv("GCP_USE_SPOT", env.GCP_USE_SPOT, false),
    includeStartupScript: parseBooleanEnv(
      "GCP_INCLUDE_STARTUP_SCRIPT",
      env.GCP_INCLUDE_STARTUP_SCRIPT,
      true
    ),
    supportsSnapshots: parseBooleanEnv("GCP_SUPPORTS_SNAPSHOTS", env.GCP_SUPPORTS_SNAPSHOTS, false),
    supportsRestore: parseBooleanEnv("GCP_SUPPORTS_RESTORE", env.GCP_SUPPORTS_RESTORE, false),
    deploymentName: env.DEPLOYMENT_NAME,
    diskRetentionDays: parseNumericEnv(
      "GCP_DISK_RETENTION_DAYS",
      env.GCP_DISK_RETENTION_DAYS,
      DEFAULT_GCP_DISK_RETENTION_DAYS
    ),
  };
  return { client, config };
}

/**
 * The Daytona transport for one operation, shared by the session provider and
 * the image-build resources.
 *
 * Only creating a sandbox needs a base image. Finalizing and reclaiming what
 * an earlier configuration created must stay possible after a provider
 * switch, when no Daytona base snapshot is built any more.
 */
export function createDaytonaRestClientFromEnv(
  env: Env,
  options: { requireBaseSnapshot: boolean }
): DaytonaRestClient {
  if (!env.DAYTONA_API_URL || !env.DAYTONA_API_KEY) {
    throw new Error(
      "DAYTONA_API_URL and DAYTONA_API_KEY are required when SANDBOX_PROVIDER=daytona"
    );
  }
  if (options.requireBaseSnapshot && !env.DAYTONA_BASE_SNAPSHOT) {
    throw new Error("DAYTONA_BASE_SNAPSHOT is required to create Daytona sandboxes");
  }

  return createDaytonaRestClient({
    apiUrl: env.DAYTONA_API_URL,
    apiKey: env.DAYTONA_API_KEY,
    target: env.DAYTONA_TARGET,
    baseSnapshot: env.DAYTONA_BASE_SNAPSHOT,
    toolboxApiUrl: env.DAYTONA_TOOLBOX_API_URL,
  });
}

function createDaytonaProviderFromEnv(env: Env): DaytonaSandboxProvider {
  const client = createDaytonaRestClientFromEnv(env, { requireBaseSnapshot: true });

  return createDaytonaProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    gitlabAccessToken: env.GITLAB_ACCESS_TOKEN,
    sandboxAccessPasswordSecret: client.config.apiKey,
    autoStopIntervalMinutes: parseNumericEnv(
      "DAYTONA_AUTO_STOP_INTERVAL_MINUTES",
      env.DAYTONA_AUTO_STOP_INTERVAL_MINUTES,
      120
    ),
    autoArchiveIntervalMinutes: parseNumericEnv(
      "DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES",
      env.DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES,
      10080
    ),
  });
}

function createE2BProviderFromEnv(env: Env): E2BSandboxProvider {
  if (!env.E2B_API_KEY || !env.E2B_TEMPLATE_ID) {
    throw new Error("E2B_API_KEY and E2B_TEMPLATE_ID are required when SANDBOX_PROVIDER=e2b");
  }

  const client = createE2BRestClient({
    apiUrl: env.E2B_API_URL || "https://api.e2b.app",
    apiKey: env.E2B_API_KEY,
    templateId: env.E2B_TEMPLATE_ID,
  });

  return createE2BProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    sandboxAccessPasswordSecret: env.E2B_API_KEY,
    sandboxTimeoutSeconds: parseNumericEnv(
      "E2B_SANDBOX_TIMEOUT_SECONDS",
      env.E2B_SANDBOX_TIMEOUT_SECONDS,
      DEFAULT_E2B_SANDBOX_TIMEOUT_SECONDS
    ),
    autoPause: parseBooleanEnv("E2B_AUTO_PAUSE", env.E2B_AUTO_PAUSE, DEFAULT_E2B_AUTO_PAUSE),
  });
}

/**
 * The Boat transport, shared by the session provider and the image-build
 * resources. Only creating a sandbox needs the base snapshot; finalizing and
 * reclaiming what an earlier configuration created must stay possible after
 * a provider switch, when no Boat base snapshot is built any more.
 */
export function createBoatRestClientFromEnv(env: Env): BoatRestClient {
  if (!env.BOAT_API_KEY) {
    throw new Error("BOAT_API_KEY is required when SANDBOX_PROVIDER=boat");
  }
  return createBoatRestClient({
    apiUrl: env.BOAT_API_URL || DEFAULT_BOAT_API_URL,
    apiKey: env.BOAT_API_KEY,
    org: env.BOAT_ORG?.trim() || undefined,
  });
}

/** Machine size for a sandbox whose scope requests no CPU or memory. */
export function resolveBoatDefaultMachineType(env: Env): BoatMachineType {
  const defaultMachineType = env.BOAT_SANDBOX_TYPE?.trim() || "default";
  if (!isBoatMachineType(defaultMachineType)) {
    throw new Error("BOAT_SANDBOX_TYPE must be one of small, default, large, xlarge");
  }
  return defaultMachineType;
}

function createBoatProviderFromEnv(env: Env): BoatSandboxProvider {
  if (!env.BOAT_API_KEY || !env.BOAT_BASE_SNAPSHOT) {
    throw new Error("BOAT_API_KEY and BOAT_BASE_SNAPSHOT are required when SANDBOX_PROVIDER=boat");
  }

  return createBoatProvider(createBoatRestClientFromEnv(env), {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    sandboxAccessPasswordSecret: env.BOAT_API_KEY,
    baseSnapshot: env.BOAT_BASE_SNAPSHOT,
    defaultMachineType: resolveBoatDefaultMachineType(env),
    deploymentName: env.DEPLOYMENT_NAME,
  });
}

export function createSandboxProviderFromEnv(env: Env, backend: "boat"): BoatSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "daytona"): DaytonaSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "e2b"): E2BSandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend: "modal" | "modal-vm"
): ModalSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "vercel"): VercelSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "gcp"): GcpSandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend?: SandboxBackendName
): SandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend: SandboxBackendName = resolveSandboxBackendName(env.SANDBOX_PROVIDER)
): SandboxProvider {
  switch (backend) {
    case "boat":
      return createBoatProviderFromEnv(env);
    case "daytona":
      return createDaytonaProviderFromEnv(env);
    case "vercel":
      return createVercelProviderFromEnv(env);
    case "e2b":
      return createE2BProviderFromEnv(env);
    case "gcp":
      return createGcpProviderFromEnv(env);
    case "modal":
    case "modal-vm":
      return createModalProviderFromEnv(env, backend);
  }
}

function parseNumericEnv(name: string, value: string | undefined, defaultValue: number): number {
  const raw = value?.trim();
  if (!raw) return defaultValue;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a valid number`);
  }
  return parsed;
}

function parseBooleanEnv(name: string, value: string | undefined, defaultValue: boolean): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be a valid boolean`);
}

function splitCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseKeyValueCsvEnv(value: string | undefined): Record<string, string> | undefined {
  const entries = splitCsvEnv(value);
  if (entries.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const eqIndex = entry.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = entry.slice(0, eqIndex).trim();
    const val = entry.slice(eqIndex + 1).trim();
    if (key) {
      out[key] = val;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
