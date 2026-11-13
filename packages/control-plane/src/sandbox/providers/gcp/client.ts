/**
 * Worker-compatible Google Compute Engine REST client for GCP sandboxes.
 *
 * Implements the GCE operations the GCP sandbox provider uses:
 * - Zonal instances: get, insert, start, delete, setMetadata
 * - Zonal persistent disks: get, list, insert, delete, createSnapshot
 * - Global snapshots: delete
 * - Global images: insert, get, delete; zonal instances: stop
 * - Long-running operation waiting (/zonalOperations/.../wait, /globalOperations/.../wait)
 */

import { z } from "zod";
import { createLogger, type CorrelationContext } from "../../../logger";
import { withRequestDeadline } from "../../request-deadline";
import type { GcpTokenProvider } from "./auth";
import {
  extractGcpZone,
  gcpDiskTypeUrl,
  gcpImageSourceUrl,
  gcpMachineTypeUrl,
  gcpSnapshotSourceUrl,
} from "./naming";

const log = createLogger("gcp-compute-client");

const DEFAULT_COMPUTE_API_BASE_URL = "https://compute.googleapis.com/compute/v1";
const USER_AGENT = "open-inspect/gcp-sandbox";

const DEFAULT_API_DEADLINE_MS = 60_000;
const DEFAULT_OPERATION_WAIT_DEADLINE_MS = 180_000;
const OPERATION_POLL_DELAY_MS = 1_000;

export interface GcpComputeClientConfig {
  project: string;
  tokenProvider: GcpTokenProvider;
  apiBaseUrl?: string;
  imageProject?: string;
}

export interface GcpDiskSpec {
  name: string;
  zone: string;
  sizeGb: number;
  type: string;
  sourceImage?: string;
  sourceSnapshot?: string;
  labels?: Record<string, string>;
  treatBareImageAsFamily?: boolean;
}

export interface GcpInstanceSpec {
  name: string;
  zone: string;
  machineType: string;
  bootDiskSelfLink: string;
  network?: string;
  subnet?: string;
  tags?: string[];
  labels?: Record<string, string>;
  metadata?: Record<string, string>;
  serviceAccountEmail?: string;
  spot?: boolean;
  /**
   * GCE stops (never deletes) the VM after this long, whatever the control
   * plane does: a bound on a VM nothing is left to stop. Its disk is kept.
   */
  maxRunDurationSeconds?: number;
}

export interface GcpImageSpec {
  name: string;
  /** Zonal disk self-link or `projects/<p>/zones/<z>/disks/<name>` path. */
  sourceDisk: string;
  family?: string;
  labels?: Record<string, string>;
}

const gcpMetadataItemSchema = z.object({
  key: z.string(),
  value: z.string().optional(),
});

const gcpInstanceSchema = z.object({
  name: z.string(),
  status: z.string().optional(),
  zone: z.string().optional(),
  selfLink: z.string().optional(),
  metadata: z
    .object({
      fingerprint: z.string().optional(),
      items: z.array(gcpMetadataItemSchema).optional(),
    })
    .optional(),
});

export type GcpInstance = z.infer<typeof gcpInstanceSchema>;

const gcpDiskSchema = z.object({
  name: z.string(),
  status: z.string().optional(),
  zone: z.string().optional(),
  selfLink: z.string().optional(),
  creationTimestamp: z.string().optional(),
  lastAttachTimestamp: z.string().optional(),
  lastDetachTimestamp: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  /** Instances the disk is attached to; empty or absent when detached. */
  users: z.array(z.string()).optional(),
});

const gcpDiskListSchema = z.object({
  items: z.array(gcpDiskSchema).optional(),
  nextPageToken: z.string().optional(),
});

export type GcpDisk = z.infer<typeof gcpDiskSchema>;

const gcpImageSchema = z.object({
  name: z.string(),
  /** PENDING while GCE copies the disk, then READY or FAILED. */
  status: z.string().optional(),
  sourceDisk: z.string().optional(),
  selfLink: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

export type GcpImage = z.infer<typeof gcpImageSchema>;

const gcpOperationErrorEntrySchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

const gcpOperationSchema = z.object({
  name: z.string(),
  status: z.string().optional(),
  zone: z.string().optional(),
  selfLink: z.string().optional(),
  httpErrorStatusCode: z.number().optional(),
  httpErrorMessage: z.string().optional(),
  error: z
    .object({
      errors: z.array(gcpOperationErrorEntrySchema).optional(),
    })
    .optional(),
});

export type GcpOperation = z.infer<typeof gcpOperationSchema>;

export class GcpComputeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseText?: string
  ) {
    super(message);
    this.name = "GcpComputeApiError";
  }
}

export function isGcpNotFoundError(error: unknown): boolean {
  return error instanceof GcpComputeApiError && error.status === 404;
}

export function isGcpAlreadyExistsError(error: unknown): boolean {
  return error instanceof GcpComputeApiError && error.status === 409;
}

export function isGcpCapacityError(error: unknown): boolean {
  if (!(error instanceof GcpComputeApiError)) return false;
  if (error.status < 400) return false;
  const text = `${error.message} ${error.responseText ?? ""}`.toLowerCase();
  return (
    text.includes("resource_exhausted") ||
    text.includes("zone_resource_pool_exhausted") ||
    text.includes("quota") ||
    text.includes("out of resources") ||
    text.includes("no available instances") ||
    text.includes("preemptible")
  );
}

export class GcpComputeClient {
  readonly project: string;
  private readonly apiBaseUrl: string;
  private readonly imageProject?: string;

  constructor(private readonly config: GcpComputeClientConfig) {
    if (!config.project.trim()) {
      throw new Error("GcpComputeClient requires project");
    }
    this.project = config.project.trim();
    this.apiBaseUrl = (config.apiBaseUrl || DEFAULT_COMPUTE_API_BASE_URL).replace(/\/+$/, "");
    this.imageProject = config.imageProject?.trim() || undefined;
  }

  /**
   * Look up a VM by name across the configured zones; returns null if not found in any zone.
   */
  async getInstance(
    name: string,
    zones: readonly string[],
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<GcpInstance | null> {
    for (const zone of zones) {
      try {
        return await this.getInstanceInZone(zone, name, correlation, signal);
      } catch (error) {
        if (isGcpNotFoundError(error)) {
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  async getInstanceInZone(
    zone: string,
    name: string,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<GcpInstance> {
    return this.requestJson(
      `/projects/${encodeURIComponent(this.project)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(name)}`,
      { method: "GET", signal },
      gcpInstanceSchema,
      correlation,
      "getInstance",
      DEFAULT_API_DEADLINE_MS
    );
  }

  async createInstance(
    spec: GcpInstanceSpec,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<GcpInstance> {
    const body = buildInstanceResource(spec);
    const op = await this.requestJson(
      `/projects/${encodeURIComponent(this.project)}/zones/${encodeURIComponent(spec.zone)}/instances`,
      {
        method: "POST",
        body: JSON.stringify(body),
        signal,
      },
      gcpOperationSchema,
      correlation,
      "insertInstance",
      DEFAULT_API_DEADLINE_MS
    );
    await this.waitForZonalOperation(spec.zone, op, correlation, signal);
    return this.getInstanceInZone(spec.zone, spec.name, correlation, signal);
  }

  async setInstanceMetadata(
    zone: string,
    name: string,
    fingerprint: string,
    metadata: Record<string, string>,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void> {
    const items = Object.entries(metadata).map(([key, value]) => ({ key, value }));
    const op = await this.requestJson(
      `/projects/${encodeURIComponent(this.project)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(name)}/setMetadata`,
      {
        method: "POST",
        body: JSON.stringify({ fingerprint, items }),
        signal,
      },
      gcpOperationSchema,
      correlation,
      "setInstanceMetadata",
      DEFAULT_API_DEADLINE_MS
    );
    await this.waitForZonalOperation(zone, op, correlation, signal);
  }

  async startInstance(
    zone: string,
    name: string,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void> {
    const op = await this.requestJson(
      `/projects/${encodeURIComponent(this.project)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(name)}/start`,
      {
        method: "POST",
        signal,
      },
      gcpOperationSchema,
      correlation,
      "startInstance",
      DEFAULT_API_DEADLINE_MS
    );
    await this.waitForZonalOperation(zone, op, correlation, signal);
  }

  async deleteInstance(
    zone: string,
    name: string,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const op = await this.requestJson(
        `/projects/${encodeURIComponent(this.project)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(name)}`,
        {
          method: "DELETE",
          signal,
        },
        gcpOperationSchema,
        correlation,
        "deleteInstance",
        DEFAULT_API_DEADLINE_MS
      );
      await this.waitForZonalOperation(zone, op, correlation, signal);
    } catch (error) {
      if (isGcpNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }

  async getDisk(
    name: string,
    zones: readonly string[],
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<GcpDisk | null> {
    for (const zone of zones) {
      try {
        return await this.getDiskInZone(zone, name, correlation, signal);
      } catch (error) {
        if (isGcpNotFoundError(error)) {
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  async getDiskInZone(
    zone: string,
    name: string,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<GcpDisk> {
    return this.requestJson(
      `/projects/${encodeURIComponent(this.project)}/zones/${encodeURIComponent(zone)}/disks/${encodeURIComponent(name)}`,
      { method: "GET", signal },
      gcpDiskSchema,
      correlation,
      "getDisk",
      DEFAULT_API_DEADLINE_MS
    );
  }

  /**
   * List disks in one zone, optionally narrowed by a Compute Engine filter
   * expression (e.g. `labels.managed_by="x"`). Follows every page.
   */
  async listDisks(
    zone: string,
    filter?: string,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<GcpDisk[]> {
    const disks: GcpDisk[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams();
      if (filter) params.set("filter", filter);
      if (pageToken) params.set("pageToken", pageToken);
      const query = params.toString();
      const page = await this.requestJson(
        `/projects/${encodeURIComponent(this.project)}/zones/${encodeURIComponent(zone)}/disks${query ? `?${query}` : ""}`,
        { method: "GET", signal },
        gcpDiskListSchema,
        correlation,
        "listDisks",
        DEFAULT_API_DEADLINE_MS
      );
      disks.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return disks;
  }

  async createDisk(
    spec: GcpDiskSpec,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<GcpDisk> {
    if (!spec.sourceImage && !spec.sourceSnapshot) {
      throw new Error(`disk "${spec.name}": sourceImage or sourceSnapshot required`);
    }

    const body: Record<string, unknown> = {
      name: spec.name,
      sizeGb: String(spec.sizeGb),
      type: gcpDiskTypeUrl(spec.zone, spec.type),
      labels: spec.labels,
    };

    if (spec.sourceImage) {
      body.sourceImage = gcpImageSourceUrl(this.project, spec.sourceImage, {
        imageProject: this.imageProject,
        treatBareAsFamily: spec.treatBareImageAsFamily,
      });
    }
    if (spec.sourceSnapshot) {
      body.sourceSnapshot = gcpSnapshotSourceUrl(this.project, spec.sourceSnapshot);
    }

    try {
      const op = await this.requestJson(
        `/projects/${encodeURIComponent(this.project)}/zones/${encodeURIComponent(spec.zone)}/disks`,
        {
          method: "POST",
          body: JSON.stringify(body),
          signal,
        },
        gcpOperationSchema,
        correlation,
        "insertDisk",
        DEFAULT_API_DEADLINE_MS
      );
      await this.waitForZonalOperation(spec.zone, op, correlation, signal);
    } catch (error) {
      if (isGcpAlreadyExistsError(error)) {
        return this.getDiskInZone(spec.zone, spec.name, correlation, signal);
      }
      throw error;
    }

    return this.getDiskInZone(spec.zone, spec.name, correlation, signal);
  }

  async deleteDisk(
    zone: string,
    name: string,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const op = await this.requestJson(
        `/projects/${encodeURIComponent(this.project)}/zones/${encodeURIComponent(zone)}/disks/${encodeURIComponent(name)}`,
        {
          method: "DELETE",
          signal,
        },
        gcpOperationSchema,
        correlation,
        "deleteDisk",
        DEFAULT_API_DEADLINE_MS
      );
      await this.waitForZonalOperation(zone, op, correlation, signal);
    } catch (error) {
      if (isGcpNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }

  async createDiskSnapshot(
    zone: string,
    diskName: string,
    snapshotName: string,
    labels?: Record<string, string>,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void> {
    const op = await this.requestJson(
      `/projects/${encodeURIComponent(this.project)}/zones/${encodeURIComponent(zone)}/disks/${encodeURIComponent(diskName)}/createSnapshot`,
      {
        method: "POST",
        body: JSON.stringify({
          name: snapshotName,
          labels,
        }),
        signal,
      },
      gcpOperationSchema,
      correlation,
      "createDiskSnapshot",
      DEFAULT_API_DEADLINE_MS
    );
    await this.waitForZonalOperation(zone, op, correlation, signal);
  }

  /**
   * Ask GCE to stop a VM, keeping its disks, and return without waiting: a
   * caller that must know the outcome reads the instance status later.
   */
  async requestStopInstance(
    zone: string,
    name: string,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void> {
    await this.requestJson(
      `/projects/${encodeURIComponent(this.project)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(name)}/stop`,
      { method: "POST", signal },
      gcpOperationSchema,
      correlation,
      "stopInstance",
      DEFAULT_API_DEADLINE_MS
    );
  }

  /**
   * Submit an image created from a disk and return without waiting: a large
   * disk takes minutes to copy, so callers poll getImage until READY. An image
   * already under the name is reported as a 409 GcpComputeApiError.
   */
  async requestCreateImage(
    spec: GcpImageSpec,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void> {
    await this.requestJson(
      `/projects/${encodeURIComponent(this.project)}/global/images`,
      {
        method: "POST",
        body: JSON.stringify({
          name: spec.name,
          sourceDisk: spec.sourceDisk,
          ...(spec.family ? { family: spec.family } : {}),
          ...(spec.labels ? { labels: spec.labels } : {}),
        }),
        signal,
      },
      gcpOperationSchema,
      correlation,
      "insertImage",
      DEFAULT_API_DEADLINE_MS
    );
  }

  /** The image under `name` in this project, or null when there is none. */
  async getImage(
    name: string,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<GcpImage | null> {
    try {
      return await this.requestJson(
        `/projects/${encodeURIComponent(this.project)}/global/images/${encodeURIComponent(name)}`,
        { method: "GET", signal },
        gcpImageSchema,
        correlation,
        "getImage",
        DEFAULT_API_DEADLINE_MS
      );
    } catch (error) {
      if (isGcpNotFoundError(error)) return null;
      throw error;
    }
  }

  /**
   * Delete an image and return once GCE accepts the request; one already gone
   * counts as deleted.
   */
  async deleteImage(name: string, correlation?: CorrelationContext, signal?: AbortSignal) {
    try {
      await this.requestJson(
        `/projects/${encodeURIComponent(this.project)}/global/images/${encodeURIComponent(name)}`,
        { method: "DELETE", signal },
        gcpOperationSchema,
        correlation,
        "deleteImage",
        DEFAULT_API_DEADLINE_MS
      );
    } catch (error) {
      if (isGcpNotFoundError(error)) return;
      throw error;
    }
  }

  async deleteSnapshot(
    snapshotName: string,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const op = await this.requestJson(
        `/projects/${encodeURIComponent(this.project)}/global/snapshots/${encodeURIComponent(snapshotName)}`,
        {
          method: "DELETE",
          signal,
        },
        gcpOperationSchema,
        correlation,
        "deleteSnapshot",
        DEFAULT_API_DEADLINE_MS
      );
      await this.waitForGlobalOperation(op, correlation, signal);
    } catch (error) {
      if (isGcpNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }

  private async waitForZonalOperation(
    zone: string,
    initial: GcpOperation,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void> {
    const resolvedZone = extractGcpZone(initial.zone) || zone;
    await this.waitForOperation(
      `/projects/${encodeURIComponent(this.project)}/zones/${encodeURIComponent(resolvedZone)}/operations/${encodeURIComponent(initial.name)}/wait`,
      initial,
      correlation,
      signal
    );
  }

  private async waitForGlobalOperation(
    initial: GcpOperation,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void> {
    await this.waitForOperation(
      `/projects/${encodeURIComponent(this.project)}/global/operations/${encodeURIComponent(initial.name)}/wait`,
      initial,
      correlation,
      signal
    );
  }

  private async waitForOperation(
    waitPath: string,
    initial: GcpOperation,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void> {
    let op = initial;
    const deadlineAtMs = Date.now() + DEFAULT_OPERATION_WAIT_DEADLINE_MS;

    while (op.status !== "DONE") {
      if (Date.now() >= deadlineAtMs) {
        throw new GcpComputeApiError(
          `GCP operation ${op.name} timed out before reaching DONE`,
          504
        );
      }
      op = await this.requestJson(
        waitPath,
        { method: "POST", signal },
        gcpOperationSchema,
        correlation,
        "waitOperation",
        DEFAULT_OPERATION_WAIT_DEADLINE_MS
      );
      if (op.status !== "DONE") {
        await new Promise((resolve) => setTimeout(resolve, OPERATION_POLL_DELAY_MS));
      }
    }

    const errors = op.error?.errors;
    if (errors && errors.length > 0) {
      const details = errors.map((e) => [e.code, e.message].filter(Boolean).join(": ")).join("; ");
      const status = op.httpErrorStatusCode || 400;
      throw new GcpComputeApiError(
        `GCP operation ${op.name} failed: ${details || op.httpErrorMessage || "unknown error"}`,
        status,
        details
      );
    }
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    correlation: CorrelationContext | undefined,
    endpoint: string,
    deadlineMs: number
  ): Promise<T> {
    const startTime = Date.now();
    let httpStatus: number | undefined;
    let outcome: "success" | "error" = "error";

    try {
      const result = await withRequestDeadline(
        "GCP Compute",
        endpoint,
        deadlineMs,
        init.signal ?? undefined,
        async (signal) => {
          const accessToken = await this.config.tokenProvider.getAccessToken(signal);
          const headers = new Headers(init.headers);
          headers.set("Authorization", `Bearer ${accessToken}`);
          if (init.body !== undefined && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
          }
          headers.set("User-Agent", USER_AGENT);
          if (correlation?.trace_id) headers.set("x-trace-id", correlation.trace_id);
          if (correlation?.request_id) headers.set("x-request-id", correlation.request_id);

          const response = await fetch(`${this.apiBaseUrl}${path}`, {
            ...init,
            headers,
            signal,
          });
          httpStatus = response.status;

          const text = await response.text();
          if (!response.ok) {
            throw new GcpComputeApiError(
              `GCP Compute API error (${endpoint}): ${response.status} ${text}`,
              response.status,
              text
            );
          }

          let payload: unknown;
          try {
            payload = JSON.parse(text);
          } catch (error) {
            throw new GcpComputeApiError(
              `GCP Compute API returned invalid JSON for ${endpoint}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              response.status,
              text
            );
          }

          const parsed = schema.safeParse(payload);
          if (!parsed.success) {
            throw new GcpComputeApiError(
              `GCP Compute API returned invalid ${endpoint} response: ${z.prettifyError(parsed.error)}`,
              response.status,
              text
            );
          }
          return parsed.data;
        }
      );

      outcome = "success";
      return result;
    } finally {
      log.info("gcp_compute.request", {
        event: "gcp_compute.request",
        endpoint,
        trace_id: correlation?.trace_id,
        request_id: correlation?.request_id,
        session_id: correlation?.session_id,
        sandbox_id: correlation?.sandbox_id,
        http_status: httpStatus,
        duration_ms: Date.now() - startTime,
        outcome,
      });
    }
  }
}

function buildInstanceResource(spec: GcpInstanceSpec): Record<string, unknown> {
  const networkInterface: Record<string, unknown> = {};
  if (spec.network) {
    networkInterface.network = spec.network;
  }
  if (spec.subnet) {
    networkInterface.subnetwork = spec.subnet;
  }

  const instance: Record<string, unknown> = {
    name: spec.name,
    machineType: gcpMachineTypeUrl(spec.zone, spec.machineType),
    disks: [
      {
        source: spec.bootDiskSelfLink,
        autoDelete: false,
        boot: true,
        type: "PERSISTENT",
      },
    ],
    networkInterfaces: [networkInterface],
    labels: spec.labels,
  };

  if (spec.tags && spec.tags.length > 0) {
    instance.tags = { items: spec.tags };
  }

  if (spec.metadata && Object.keys(spec.metadata).length > 0) {
    instance.metadata = {
      items: Object.entries(spec.metadata).map(([key, value]) => ({ key, value })),
    };
  }

  if (spec.serviceAccountEmail) {
    instance.serviceAccounts = [
      {
        email: spec.serviceAccountEmail,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      },
    ];
  }

  const scheduling: Record<string, unknown> = {};
  if (spec.spot) {
    Object.assign(scheduling, {
      provisioningModel: "SPOT",
      preemptible: true,
      automaticRestart: false,
      onHostMaintenance: "TERMINATE",
    });
  }
  if (spec.maxRunDurationSeconds !== undefined && spec.maxRunDurationSeconds > 0) {
    Object.assign(scheduling, {
      maxRunDuration: { seconds: String(Math.ceil(spec.maxRunDurationSeconds)) },
      instanceTerminationAction: "STOP",
    });
  }
  if (Object.keys(scheduling).length > 0) {
    instance.scheduling = scheduling;
  }

  return instance;
}

export function createGcpComputeClient(config: GcpComputeClientConfig): GcpComputeClient {
  return new GcpComputeClient(config);
}
