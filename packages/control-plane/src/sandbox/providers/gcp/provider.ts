/**
 * Native Google Cloud Platform (GCE) sandbox provider.
 *
 * Implements GCE provisioning and the boot disk lifecycle directly in the
 * control plane:
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
import { createLogger, type CorrelationContext } from "../../../logger";
import {
  GcpComputeApiError,
  isGcpCapacityError,
  type GcpComputeClient,
  type GcpDisk,
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
  GCP_LABEL_DEPLOYMENT,
  GCP_LABEL_MANAGED_BY,
  GCP_MANAGED_BY_VALUE,
  extractGcpZone,
  gcpDeploymentLabelValue,
  gcpDiskSelfLink,
  gcpSandboxLabels,
  gcpSandboxName,
  gcpZoneForSession,
  gcpSnapshotName,
} from "./naming";

export const DEFAULT_GCP_ZONES = [
  "us-central1-a",
  "us-central1-b",
  "us-central1-c",
  "us-central1-f",
];
/** Image family packages/gcp-infra builds into; also its GCP_IMAGE_FAMILY default. */
export const DEFAULT_GCP_IMAGE_FAMILY = "open-inspect-sandbox";
export const DEFAULT_GCP_MACHINE_TYPE = "e2-standard-4";
export const DEFAULT_GCP_BOOT_DISK_SIZE_GB = 80;
export const DEFAULT_GCP_BOOT_DISK_TYPE = "pd-balanced";
/** Days a detached sandbox disk is kept before it may be purged; 0 disables purging. */
export const DEFAULT_GCP_DISK_RETENTION_DAYS = 14;
/** Expired disks deleted per purge, so each launch does a small, bounded amount of cleanup. */
const GCP_DISK_PURGE_BATCH_SIZE = 2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** StopConfig.reason the session lifecycle uses when an archive stops a running sandbox. */
const SESSION_ARCHIVED_STOP_REASON = "session_archived";

const log = createLogger("gcp-provider");

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
  /**
   * Deployment that owns the VMs, disks, and snapshots this provider creates
   * (DEPLOYMENT_NAME), written to the deployment label. The retention purge
   * only ever deletes disks carrying this deployment's label, and is disabled
   * when this is unset.
   */
  deploymentName?: string;
  /** Defaults to DEFAULT_GCP_DISK_RETENTION_DAYS; 0 disables purging. */
  diskRetentionDays?: number;
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
  private readonly diskRetentionMs: number;

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
    const diskRetentionDays = config.diskRetentionDays ?? DEFAULT_GCP_DISK_RETENTION_DAYS;
    if (!Number.isFinite(diskRetentionDays) || diskRetentionDays < 0) {
      throw new Error("GCP_DISK_RETENTION_DAYS must be >= 0");
    }
    this.diskRetentionMs = diskRetentionDays * MS_PER_DAY;
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
      const primaryZone = gcpZoneForSession(config.sessionId, this.zones);

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
            this.config.instanceLabels,
            this.config.deploymentName
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
          config.correlation,
          primaryZone
        );
      } catch (spawnError) {
        await this.client.deleteDisk(primaryZone, name, config.correlation).catch(() => undefined);
        throw spawnError;
      }
      this.startExpiredDiskPurge(name, config.correlation);

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
      const primaryZone = gcpZoneForSession(config.sessionId, this.zones);

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
            this.config.instanceLabels,
            this.config.deploymentName
          ),
        },
        config.correlation
      );

      const instance = await this.spawnWithFallback(
        config.sandboxId,
        config.sessionId,
        diskName,
        metadata,
        config.correlation,
        primaryZone
      );
      this.startExpiredDiskPurge(diskName, config.correlation);

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
          this.config.instanceLabels,
          this.config.deploymentName
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
        diskZone
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

      // Archiving a session deletes its disk even when the lifecycle asks to
      // preserve it: an archived session is not expected to resume, and a
      // later unarchive spawns fresh (resume reports shouldSpawnFresh).
      if (config.intent === "destroy" || config.reason === SESSION_ARCHIVED_STOP_REASON) {
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
   * Purge expired disks in the background. Never awaited by the launch and
   * never throws: cleanup must not slow or fail provisioning.
   */
  private startExpiredDiskPurge(excludeDiskName: string, correlation?: CorrelationContext): void {
    if (this.diskRetentionMs <= 0 || !this.config.deploymentName) return;
    void this.purgeExpiredDisks(excludeDiskName, correlation).catch((error) => {
      log.warn("gcp.disk_purge_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Deletes up to GCP_DISK_PURGE_BATCH_SIZE of the longest-unused sandbox disks
   * whose last use is older than the retention cutoff. Only detached disks
   * labeled as created by this provider for this deployment are considered;
   * disks without a deployment label (created before it existed) are never
   * purged, since their owner cannot be determined.
   */
  async purgeExpiredDisks(
    excludeDiskName?: string,
    correlation?: CorrelationContext,
    nowMs: number = Date.now()
  ): Promise<string[]> {
    const deploymentName = this.config.deploymentName;
    if (this.diskRetentionMs <= 0 || !deploymentName) return [];
    const cutoffMs = nowMs - this.diskRetentionMs;
    const deployment = gcpDeploymentLabelValue(deploymentName);
    const filter =
      `(labels.${GCP_LABEL_MANAGED_BY} = "${GCP_MANAGED_BY_VALUE}") AND ` +
      `(labels.${GCP_LABEL_DEPLOYMENT} = "${deployment}")`;

    const candidates: Array<{ disk: GcpDisk; zone: string; lastUsedMs: number }> = [];
    for (const zone of this.zones) {
      const disks = await this.client.listDisks(zone, filter, correlation);
      for (const disk of disks) {
        if (disk.name === excludeDiskName) continue;
        // Re-check ownership locally rather than trusting the server-side filter alone.
        if (disk.labels?.[GCP_LABEL_MANAGED_BY] !== GCP_MANAGED_BY_VALUE) continue;
        if (disk.labels?.[GCP_LABEL_DEPLOYMENT] !== deployment) continue;
        if (disk.users && disk.users.length > 0) continue;
        const lastUsedMs = gcpDiskLastUsedMs(disk);
        if (lastUsedMs === null || lastUsedMs >= cutoffMs) continue;
        candidates.push({ disk, zone: extractGcpZone(disk.zone) || zone, lastUsedMs });
      }
    }

    candidates.sort((a, b) => a.lastUsedMs - b.lastUsedMs);
    const deleted: string[] = [];
    for (const { disk, zone, lastUsedMs } of candidates.slice(0, GCP_DISK_PURGE_BATCH_SIZE)) {
      await this.client.deleteDisk(zone, disk.name, correlation);
      deleted.push(disk.name);
      log.info("gcp.disk_purged", {
        disk_name: disk.name,
        zone,
        last_used_at: new Date(lastUsedMs).toISOString(),
      });
    }
    return deleted;
  }

  /**
   * Resolves the boot image or image family for a fresh sandbox.
   *
   * Priority order:
   * 1. `sandboxSettings.imageFamily` (configured per-repo or globally in the UX)
   * 2. `userEnvVars.REPO_IMAGE` (legacy per-repo secret override)
   * 3. `prebuiltImageId`
   * 4. `config.defaultImageFamily` (`GCP_IMAGE_FAMILY`), else DEFAULT_GCP_IMAGE_FAMILY
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

    const defaultFamily = this.config.defaultImageFamily?.trim() || DEFAULT_GCP_IMAGE_FAMILY;
    return { image: defaultFamily, isFamily: true };
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

  /**
   * Creates the VM in `zone`, the zone of its boot disk (a zonal disk can only
   * attach to a VM in the same zone). With Spot enabled, a Spot VM is tried
   * first and a capacity error falls back to a standard VM.
   */
  private async spawnWithFallback(
    sandboxId: string,
    sessionId: string,
    diskName: string,
    metadata: Record<string, string>,
    correlation: CreateSandboxConfig["correlation"],
    zone: string
  ): Promise<GcpInstance> {
    if (this.config.useSpot) {
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
        if (!isGcpCapacityError(error)) throw error;
      }
    }

    return this.createInstanceInZone(
      sandboxId,
      sessionId,
      diskName,
      zone,
      metadata,
      false,
      correlation
    );
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
        labels: gcpSandboxLabels(
          sandboxId,
          sessionId,
          provisioning,
          this.config.instanceLabels,
          this.config.deploymentName
        ),
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

/**
 * Most recent of a disk's creation, attach, and detach times, or null when GCE
 * reports none (such a disk is never purged).
 */
function gcpDiskLastUsedMs(disk: GcpDisk): number | null {
  const times = [disk.creationTimestamp, disk.lastAttachTimestamp, disk.lastDetachTimestamp]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((value) => Number.isFinite(value));
  return times.length > 0 ? Math.max(...times) : null;
}
