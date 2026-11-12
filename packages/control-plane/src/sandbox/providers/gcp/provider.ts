/**
 * Native Google Cloud Platform (GCE) sandbox provider.
 *
 * Implements the GCE provisioning and disk lifecycle from background_agents_gcp_sandbox
 * directly in the control plane:
 * - Single persistent boot disk (`autoDelete: false`) named after the session ID.
 * - `createSandbox` resolves the image family/image from `sandboxSettings.imageFamily`
 *   (or `userEnvVars.REPO_IMAGE`, `prebuiltImageId`, `defaultImageFamily`), creates
 *   the boot disk, and provisions a VM with GCE instance metadata.
 * - `stopSandbox` deletes the VM instance (`intent: "preserve"` keeps the boot disk
 *   so `resumeSandbox` can re-create a VM against it; `intent: "destroy"` also deletes
 *   the boot disk).
 * - `resumeSandbox` ensures an existing VM is started or re-provisions a fresh VM
 *   against the kept boot disk; returns `shouldSpawnFresh: true` when the disk is gone.
 * - `takeSnapshot` / `restoreFromSnapshot` create and boot from GCE disk snapshots
 *   when enabled.
 */

import { supportsConfigurableSandboxTimeout } from "@open-inspect/shared/types/integrations";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  signalUntilDeadline,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxLifetime,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../../provider";
import {
  GcpComputeApiError,
  isGcpCapacityError,
  type GcpComputeClient,
  type GcpInstance,
} from "./client";
import {
  DEFAULT_GCP_VERTEX_LOCATION,
  buildGcpCreateMetadata,
  buildGcpRestoreMetadata,
  buildGcpResumeMetadata,
  type GcpBootMetadataConfig,
} from "./metadata";
import {
  extractGcpZone,
  gcpDiskSelfLink,
  gcpSandboxLabels,
  gcpSandboxName,
  gcpSnapshotName,
} from "./naming";

export const DEFAULT_GCP_ZONES = [
  "us-central1-a",
  "us-central1-b",
  "us-central1-c",
  "us-central1-f",
];
export const DEFAULT_GCP_MACHINE_TYPE = "e2-standard-4";
export const DEFAULT_GCP_BOOT_DISK_SIZE_GB = 80;
export const DEFAULT_GCP_BOOT_DISK_TYPE = "pd-balanced";

export interface GcpProviderConfig {
  project: string;
  zones: string[];
  defaultImageFamily?: string;
  machineType?: string;
  bootDiskSizeGb?: number;
  bootDiskType?: string;
  network?: string;
  subnet?: string;
  vmServiceAccountEmail?: string;
  instanceLabels?: Record<string, string>;
  vertexProject?: string;
  vertexLocation?: string;
  useSpot?: boolean;
  includeStartupScript?: boolean;
  supportsSnapshots?: boolean;
  supportsRestore?: boolean;
}

export class GcpSandboxProvider implements SandboxProvider {
  readonly name = "gcp";
  readonly capabilities: SandboxProviderCapabilities;

  restoreFromSnapshot?: (config: RestoreConfig) => Promise<RestoreResult>;
  takeSnapshot?: (config: SnapshotConfig) => Promise<SnapshotResult>;
  resumeSandbox: (config: ResumeConfig) => Promise<ResumeResult>;
  stopSandbox: (config: StopConfig) => Promise<StopResult>;

  private readonly zones: string[];
  private readonly machineType: string;
  private readonly bootDiskSizeGb: number;
  private readonly bootDiskType: string;
  private readonly bootMetadataConfig: GcpBootMetadataConfig;
  private readonly includeStartupScript: boolean;

  constructor(
    private readonly client: GcpComputeClient,
    private readonly config: GcpProviderConfig
  ) {
    if (!config.project.trim()) {
      throw new Error("GcpSandboxProvider requires project");
    }
    const zones = config.zones.map((z) => z.trim()).filter(Boolean);
    if (zones.length === 0) {
      throw new Error("GcpSandboxProvider requires at least one zone in GCP_ZONES");
    }
    this.zones = zones;
    this.machineType = config.machineType?.trim() || DEFAULT_GCP_MACHINE_TYPE;
    this.bootDiskSizeGb = config.bootDiskSizeGb ?? DEFAULT_GCP_BOOT_DISK_SIZE_GB;
    if (this.bootDiskSizeGb <= 0) {
      throw new Error("GCP_BOOT_DISK_SIZE_GB must be > 0");
    }
    this.bootDiskType = config.bootDiskType?.trim() || DEFAULT_GCP_BOOT_DISK_TYPE;
    this.bootMetadataConfig = {
      vertexProject: config.vertexProject?.trim() || config.project.trim(),
      vertexLocation: config.vertexLocation?.trim() || DEFAULT_GCP_VERTEX_LOCATION,
    };
    this.includeStartupScript = config.includeStartupScript ?? false;

    this.capabilities = {
      supportsSandboxTimeout: supportsConfigurableSandboxTimeout(this.name),
      supportsSnapshots: config.supportsSnapshots ?? false,
      supportsRestore: config.supportsRestore ?? false,
      supportsPersistentResume: true,
      supportsExplicitStop: true,
    };

    if (this.capabilities.supportsRestore) {
      this.restoreFromSnapshot = (c) => this.doRestoreFromSnapshot(c);
    }
    if (this.capabilities.supportsSnapshots) {
      this.takeSnapshot = (c) => this.doTakeSnapshot(c);
    }
    this.resumeSandbox = (c) => this.doResumeSandbox(c);
    this.stopSandbox = (c) => this.doStopSandbox(c);
  }

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    const observedAtMs = Date.now();
    const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS;

    try {
      const metadata = buildGcpCreateMetadata(
        { ...config, timeoutSeconds },
        this.bootMetadataConfig,
        this.includeStartupScript
      );

      const name = gcpSandboxName(config.sessionId);
      const existing = await this.client.getInstance(name, this.zones, config.correlation);
      if (existing) {
        const running = await this.ensureRunning(existing, metadata, config.correlation);
        return {
          sandboxId: config.sandboxId,
          providerObjectId:
            running.selfLink ||
            `projects/${this.client.project}/zones/${extractGcpZone(running.zone) || this.zones[0]}/instances/${name}`,
          createdAt: Date.now(),
          lifetime: this.lifetimeFrom(observedAtMs, timeoutSeconds),
        };
      }

      const sourceImage = this.resolveSourceImage(config);
      const primaryZone = this.zones[0];

      await this.client.createDisk(
        {
          name,
          zone: primaryZone,
          sizeGb: this.bootDiskSizeGb,
          type: this.bootDiskType,
          sourceImage: sourceImage.image,
          treatBareImageAsFamily: sourceImage.isFamily,
          labels: gcpSandboxLabels(
            config.sandboxId,
            config.sessionId,
            "pending",
            this.config.instanceLabels
          ),
        },
        config.correlation
      );

      let instance: GcpInstance;
      try {
        instance = await this.spawnWithFallback(
          config.sandboxId,
          config.sessionId,
          name,
          metadata,
          config.correlation
        );
      } catch (spawnError) {
        await this.client.deleteDisk(primaryZone, name, config.correlation).catch(() => undefined);
        throw spawnError;
      }

      return {
        sandboxId: config.sandboxId,
        providerObjectId:
          instance.selfLink ||
          `projects/${this.client.project}/zones/${extractGcpZone(instance.zone) || primaryZone}/instances/${name}`,
        createdAt: Date.now(),
        lifetime: this.lifetimeFrom(observedAtMs, timeoutSeconds),
      };
    } catch (error) {
      throw this.classifyError("Failed to create GCP sandbox", error);
    }
  }

  private async doRestoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    const observedAtMs = Date.now();
    const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS;

    try {
      const metadata = buildGcpRestoreMetadata(
        { ...config, timeoutSeconds },
        this.bootMetadataConfig,
        this.includeStartupScript
      );
      const diskName = gcpSandboxName(config.sessionId);
      const primaryZone = this.zones[0];

      await this.client.createDisk(
        {
          name: diskName,
          zone: primaryZone,
          sizeGb: this.bootDiskSizeGb,
          type: this.bootDiskType,
          sourceSnapshot: config.snapshotImageId,
          labels: gcpSandboxLabels(
            config.sandboxId,
            config.sessionId,
            "restored",
            this.config.instanceLabels
          ),
        },
        config.correlation
      );

      const instance = await this.spawnWithFallback(
        config.sandboxId,
        config.sessionId,
        diskName,
        metadata,
        config.correlation
      );

      return {
        success: true,
        sandboxId: config.sandboxId,
        providerObjectId:
          instance.selfLink ||
          `projects/${this.client.project}/zones/${extractGcpZone(instance.zone) || primaryZone}/instances/${diskName}`,
        lifetime: this.lifetimeFrom(observedAtMs, timeoutSeconds),
      };
    } catch (error) {
      throw this.classifyError("Failed to restore GCP sandbox from snapshot", error);
    }
  }

  private async doTakeSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      const signal = signalUntilDeadline(config.deadlineAtMs, config.signal);
      const diskName = gcpSandboxName(config.sessionId);
      const disk = await this.client.getDisk(diskName, this.zones, config.correlation, signal);
      if (!disk) {
        return { success: false, error: `boot disk "${diskName}" not found` };
      }

      const snapshotName = gcpSnapshotName(config.sessionId, Math.floor(Date.now() / 1000));
      const zone = extractGcpZone(disk.zone) || this.zones[0];
      await this.client.createDiskSnapshot(
        zone,
        diskName,
        snapshotName,
        gcpSandboxLabels(
          config.providerObjectId,
          config.sessionId,
          "snapshot",
          this.config.instanceLabels
        ),
        config.correlation,
        signal
      );

      return { success: true, imageId: snapshotName };
    } catch (error) {
      throw this.classifyError("Failed to take GCP sandbox snapshot", error);
    }
  }

  private async doResumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    const observedAtMs = Date.now();
    const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS;

    try {
      const name = gcpSandboxName(config.sessionId);
      const existing = await this.client.getInstance(name, this.zones, config.correlation);
      if (existing) {
        const started = await this.ensureStarted(existing, config.correlation);
        return {
          success: true,
          providerObjectId:
            started.selfLink ||
            `projects/${this.client.project}/zones/${extractGcpZone(started.zone) || this.zones[0]}/instances/${name}`,
          lifetime: this.lifetimeFrom(observedAtMs, timeoutSeconds),
        };
      }

      const disk = await this.client.getDisk(name, this.zones, config.correlation);
      if (!disk) {
        return {
          success: false,
          error: `Boot disk "${name}" no longer exists in GCP`,
          shouldSpawnFresh: true,
        };
      }

      const metadata = buildGcpResumeMetadata(
        config,
        this.bootMetadataConfig,
        this.includeStartupScript
      );
      const diskZone = extractGcpZone(disk.zone) || this.zones[0];
      const instance = await this.spawnWithFallback(
        config.sandboxId,
        config.sessionId,
        name,
        metadata,
        config.correlation,
        [diskZone]
      );

      return {
        success: true,
        providerObjectId:
          instance.selfLink ||
          `projects/${this.client.project}/zones/${diskZone}/instances/${name}`,
        lifetime: this.lifetimeFrom(observedAtMs, timeoutSeconds),
      };
    } catch (error) {
      throw this.classifyError("Failed to resume GCP sandbox", error);
    }
  }

  private async doStopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      const signal = signalUntilDeadline(config.deadlineAtMs, config.signal);
      const name = gcpSandboxName(config.sessionId);
      const instance = await this.client.getInstance(name, this.zones, config.correlation, signal);

      if (instance) {
        const zone = extractGcpZone(instance.zone) || this.zones[0];
        await this.client.deleteInstance(zone, name, config.correlation, signal);
      }

      if (config.intent === "destroy") {
        const disk = await this.client.getDisk(name, this.zones, config.correlation, signal);
        if (disk) {
          const diskZone = extractGcpZone(disk.zone) || this.zones[0];
          await this.client.deleteDisk(diskZone, name, config.correlation, signal);
        }
      }

      return { success: true };
    } catch (error) {
      throw this.classifyError("Failed to stop GCP sandbox", error);
    }
  }

  /**
   * Resolves the boot image or image family for a fresh sandbox.
   *
   * Priority order:
   * 1. `sandboxSettings.imageFamily` (configured per-repo or globally in the UX)
   * 2. `userEnvVars.REPO_IMAGE` (legacy per-repo secret override)
   * 3. `prebuiltImageId`
   * 4. `config.defaultImageFamily` (`GCP_IMAGE_FAMILY` / `GCP_AGENT_IMAGE`)
   */
  private resolveSourceImage(config: CreateSandboxConfig): { image: string; isFamily: boolean } {
    const settingsFamily = config.sandboxSettings?.imageFamily?.trim();
    if (settingsFamily) {
      return { image: settingsFamily, isFamily: true };
    }

    const envImage = config.userEnvVars?.REPO_IMAGE?.trim();
    if (envImage) {
      return { image: envImage, isFamily: false };
    }

    const prebuilt = config.prebuiltImageId?.trim();
    if (prebuilt) {
      return { image: prebuilt, isFamily: false };
    }

    const defaultFamily = this.config.defaultImageFamily?.trim();
    if (defaultFamily) {
      return { image: defaultFamily, isFamily: true };
    }

    throw new SandboxProviderError(
      "No GCP sandbox image configured: set an image family for the repository in Sandbox settings or configure GCP_IMAGE_FAMILY",
      "permanent"
    );
  }

  private async ensureStarted(
    instance: GcpInstance,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<GcpInstance> {
    if (
      instance.status === "RUNNING" ||
      instance.status === "PROVISIONING" ||
      instance.status === "STAGING"
    ) {
      return instance;
    }
    const zone = extractGcpZone(instance.zone) || this.zones[0];
    await this.client.startInstance(zone, instance.name, correlation);
    return (await this.client.getInstance(instance.name, [zone], correlation)) ?? instance;
  }

  private async ensureRunning(
    instance: GcpInstance,
    metadata: Record<string, string>,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<GcpInstance> {
    const zone = extractGcpZone(instance.zone) || this.zones[0];
    if (
      instance.status === "RUNNING" ||
      instance.status === "PROVISIONING" ||
      instance.status === "STAGING"
    ) {
      const fingerprint = instance.metadata?.fingerprint ?? "";
      await this.client.setInstanceMetadata(
        zone,
        instance.name,
        fingerprint,
        metadata,
        correlation
      );
      return (await this.client.getInstance(instance.name, [zone], correlation)) ?? instance;
    }

    await this.client.startInstance(zone, instance.name, correlation);
    return (await this.client.getInstance(instance.name, [zone], correlation)) ?? instance;
  }

  private async spawnWithFallback(
    sandboxId: string,
    sessionId: string,
    diskName: string,
    metadata: Record<string, string>,
    correlation?: CreateSandboxConfig["correlation"],
    targetZones: readonly string[] = this.zones
  ): Promise<GcpInstance> {
    let lastError: unknown;

    if (this.config.useSpot) {
      for (const zone of targetZones) {
        try {
          return await this.createInstanceInZone(
            sandboxId,
            sessionId,
            diskName,
            zone,
            metadata,
            true,
            correlation
          );
        } catch (error) {
          lastError = error;
          if (!isGcpCapacityError(error)) {
            break;
          }
        }
      }
    }

    const primaryZone = targetZones[0] ?? this.zones[0];
    try {
      return await this.createInstanceInZone(
        sandboxId,
        sessionId,
        diskName,
        primaryZone,
        metadata,
        false,
        correlation
      );
    } catch (error) {
      throw lastError ?? error;
    }
  }

  private async createInstanceInZone(
    sandboxId: string,
    sessionId: string,
    diskName: string,
    zone: string,
    metadata: Record<string, string>,
    spot: boolean,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<GcpInstance> {
    const provisioning = spot ? "spot" : "standard";
    return this.client.createInstance(
      {
        name: gcpSandboxName(sessionId),
        zone,
        machineType: this.machineType,
        bootDiskSelfLink: gcpDiskSelfLink(this.client.project, zone, diskName),
        network: this.config.network,
        subnet: this.config.subnet,
        labels: gcpSandboxLabels(sandboxId, sessionId, provisioning, this.config.instanceLabels),
        metadata,
        serviceAccountEmail: this.config.vmServiceAccountEmail,
        spot,
      },
      correlation
    );
  }

  private lifetimeFrom(observedAtMs: number, timeoutSeconds: number): SandboxLifetime {
    if (!this.capabilities.supportsSandboxTimeout) {
      return { kind: "none", observedAtMs };
    }
    return {
      kind: "finite",
      expiresAtMs: observedAtMs + timeoutSeconds * 1000,
      observedAtMs,
      source: "conservative_start_bound",
    };
  }

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof SandboxProviderError) {
      return error;
    }
    if (error instanceof GcpComputeApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

export function createGcpProvider(
  client: GcpComputeClient,
  config: GcpProviderConfig
): GcpSandboxProvider {
  return new GcpSandboxProvider(client, config);
}
