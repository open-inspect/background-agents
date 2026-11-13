/**
 * The GCP resources one image build owns: the build VM (and its boot disk)
 * the scope's setup hooks run in, and the Compute Engine image saved from
 * that disk.
 *
 * The build VM boots from the deployment's sandbox image. Its whole build env
 * (the repository set, the clone token, the scope's secrets, the callback
 * contract) rides instance metadata, which belongs to the VM and is never
 * part of the disk; the launcher keeps it, and every piece of runtime state,
 * in memory-backed /run, so the image saved from the disk carries the
 * workspace and nothing of the build that produced it.
 *
 * The VM and disk name is fixed by the deployment and build id, so it is
 * bound to the build before the VM exists: nothing can report a build whose
 * row does not already name its source, and a create whose response was lost
 * is found again by name.
 */

import { bytesToHex } from "@open-inspect/shared/auth";
import { createLogger } from "../logger";
import type { ImageBuildProviderTriggerConfig } from "../sandbox/provider";
import { SandboxProviderError } from "../sandbox/provider";
import { SANDBOX_RUNTIME_VERSION } from "../sandbox/runtime-manifest";
import {
  buildImageBuildCallbackEnv,
  buildImageBuildEnvVars,
  DEFERRED_START_ENV_VAR,
  IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY,
  IMAGE_BUILD_MODE_ENV_VAR,
  imageBuildSandboxIdentity,
  scmCloneIdentity,
} from "../sandbox/sandbox-env";
import {
  GcpComputeApiError,
  type GcpComputeClient,
  type GcpImage,
} from "../sandbox/providers/gcp/client";
import { buildGcpImageBuildMetadata } from "../sandbox/providers/gcp/metadata";
import {
  extractGcpZone,
  GCP_LABEL_SOURCE_IMAGE,
  gcpDiskSelfLink,
  gcpSandboxLabels,
  gcpSourceImageLabelValue,
  gcpZoneForSession,
} from "../sandbox/providers/gcp/naming";
import {
  DEFAULT_GCP_BOOT_DISK_SIZE_GB,
  DEFAULT_GCP_BOOT_DISK_TYPE,
  DEFAULT_GCP_IMAGE_FAMILY,
  DEFAULT_GCP_MACHINE_TYPE,
  type GcpProviderConfig,
} from "../sandbox/providers/gcp/provider";
import type { SourceControlProviderName } from "../source-control";

const log = createLogger("image-builds:gcp");

/** Prefix of every prebuilt image name; deletion refuses anything else. */
export const GCP_IMAGE_NAME_PREFIX = "oi-img-";
const GCP_BUILD_VM_NAME_PREFIX = "oi-build-";
const GCP_NAME_SLUG_MAX_CHARS = 28;

/** A build trigger with the scope's own boot image family, if it has one. */
export interface GcpImageBuildTriggerConfig extends ImageBuildProviderTriggerConfig {
  imageFamily?: string | null;
}

export interface GcpImageBuildResourcesConfig {
  scmProvider: SourceControlProviderName;
  /** Names build VMs and images and labels them; distinct per deployment. */
  deploymentName: string;
}

/** What became of a build VM asked to stop for its image. */
export type GcpBuildSourceStop = "stopped" | "stopping" | "missing";

export class GcpImageBuildResources {
  constructor(
    private readonly client: GcpComputeClient,
    private readonly provider: GcpProviderConfig,
    private readonly config: GcpImageBuildResourcesConfig
  ) {}

  /**
   * Start an image build: bind the build VM's name to the build, then create
   * its boot disk from the deployment's sandbox image and boot it in
   * image-build mode. The runtime clones every repository, runs each
   * `.openinspect/setup.sh`, reports completion over the callback, and idles
   * until finalization stops the VM and saves its disk. GCE stops the VM
   * itself once the provider-session lifetime has passed, so a build the
   * control plane loses track of stops billing for compute and keeps its disk
   * for finalization or cleanup.
   *
   * The bind comes first, so every failure after it is the workflow's to clean
   * up by name, including a VM whose create response never arrived.
   */
  async triggerImageBuild(config: GcpImageBuildTriggerConfig): Promise<void> {
    const name = await gcpImageBuildVmName(this.config.deploymentName, config.buildId);
    const identity = imageBuildSandboxIdentity(config, Date.now());
    const zone = gcpZoneForSession(config.buildId, this.provider.zones);
    // The image the scope's sessions boot: its own family, else the default.
    const sourceImage =
      config.imageFamily?.trim() ||
      this.provider.defaultImageFamily?.trim() ||
      DEFAULT_GCP_IMAGE_FAMILY;
    const labels = {
      ...gcpSandboxLabels(
        identity.sandboxId,
        config.buildId,
        "image-build",
        this.provider.instanceLabels,
        this.config.deploymentName
      ),
      [GCP_LABEL_SOURCE_IMAGE]: gcpSourceImageLabelValue(sourceImage),
    };
    const metadata = buildGcpImageBuildMetadata(this.buildEnv(config, identity.sandboxId, name));

    await config.onProviderSessionCreated(name);
    try {
      await this.client.createDisk(
        {
          name,
          zone,
          sizeGb: this.provider.bootDiskSizeGb ?? DEFAULT_GCP_BOOT_DISK_SIZE_GB,
          type: this.provider.bootDiskType?.trim() || DEFAULT_GCP_BOOT_DISK_TYPE,
          sourceImage,
          treatBareImageAsFamily: true,
          labels,
        },
        config.correlation
      );
      await this.client.createInstance(
        {
          name,
          zone,
          machineType: this.provider.machineType?.trim() || DEFAULT_GCP_MACHINE_TYPE,
          bootDiskSelfLink: gcpDiskSelfLink(this.client.project, zone, name),
          network: this.provider.network,
          subnet: this.provider.subnet,
          labels,
          metadata,
          serviceAccountEmail: this.provider.vmServiceAccountEmail,
          maxRunDurationSeconds: config.providerSessionTimeoutSeconds,
        },
        config.correlation
      );
    } catch (error) {
      throw classifyGcpBuildError("Failed to trigger GCP image build", error);
    }
    log.info("gcp.image_build_triggered", {
      build_id: config.buildId,
      scope_kind: config.scopeKind,
      scope_id: config.scopeId,
      instance: name,
      zone,
      request_id: config.correlation.request_id,
      trace_id: config.correlation.trace_id,
    });
  }

  /**
   * Bring a build VM to a stop so its disk can be imaged. A stopped VM is
   * already there; a running one is asked to stop and reported `stopping`,
   * so a later delivery finds it stopped rather than this call waiting on GCE.
   */
  async stopBuildSandboxForSave(name: string, signal?: AbortSignal): Promise<GcpBuildSourceStop> {
    const instance = await this.client.getInstance(name, this.provider.zones, undefined, signal);
    if (!instance) return "missing";
    if (instance.status === "TERMINATED") return "stopped";
    if (instance.status !== "STOPPING") {
      const zone = extractGcpZone(instance.zone) || this.provider.zones[0];
      await this.client.requestStopInstance(zone, name, undefined, signal);
    }
    return "stopping";
  }

  /** The image a build is saved under in this deployment. */
  imageName(buildId: string): Promise<string> {
    return gcpImageName(this.config.deploymentName, buildId);
  }

  /** The full reference sessions boot a saved image by. */
  imageReference(imageName: string): string {
    return `projects/${this.client.project}/global/images/${imageName}`;
  }

  /**
   * Submit the image of a build VM's boot disk. GCE answers at once with the
   * image PENDING; an image already under the name is reported as a 409.
   */
  async saveImage(buildVmName: string, imageName: string, signal?: AbortSignal): Promise<void> {
    const disk = await this.client.getDisk(buildVmName, this.provider.zones, undefined, signal);
    if (!disk) {
      throw new SandboxProviderError(`GCP build disk ${buildVmName} no longer exists`, "permanent");
    }
    const zone = extractGcpZone(disk.zone) || this.provider.zones[0];
    await this.client.requestCreateImage(
      {
        name: imageName,
        sourceDisk: gcpDiskSelfLink(this.client.project, zone, buildVmName),
        labels: {
          ...gcpSandboxLabels(
            imageName,
            buildVmName,
            "prebuilt-image",
            this.provider.instanceLabels,
            this.config.deploymentName
          ),
          // Carried over from the build disk: the image this one stands in for.
          ...(disk.labels?.[GCP_LABEL_SOURCE_IMAGE]
            ? { [GCP_LABEL_SOURCE_IMAGE]: disk.labels[GCP_LABEL_SOURCE_IMAGE] }
            : {}),
        },
      },
      undefined,
      signal
    );
  }

  /** The image under `name`, or null when GCE has none. */
  getImage(name: string, signal?: AbortSignal): Promise<GcpImage | null> {
    return this.client.getImage(name, undefined, signal);
  }

  /**
   * Delete a prebuilt image; one already gone counts as deleted. Refuses any
   * image not named as a prebuild, so a bad reference can never delete the
   * deployment's sandbox image.
   */
  async deleteProviderImage(providerImageId: string, signal?: AbortSignal): Promise<void> {
    const name = providerImageId.split("/").pop() ?? "";
    if (!name.startsWith(GCP_IMAGE_NAME_PREFIX)) {
      throw new SandboxProviderError(
        `Refusing to delete GCP image ${providerImageId}: not a prebuilt image`,
        "permanent"
      );
    }
    await this.client.deleteImage(name, undefined, signal);
  }

  /**
   * Delete a build VM and its boot disk for good: once its image is saved, or
   * once the build has failed. Either already gone counts as deleted.
   */
  async deleteBuildSandbox(name: string, signal?: AbortSignal): Promise<void> {
    const instance = await this.client.getInstance(name, this.provider.zones, undefined, signal);
    if (instance) {
      const zone = extractGcpZone(instance.zone) || this.provider.zones[0];
      await this.client.deleteInstance(zone, name, undefined, signal);
    }
    const disk = await this.client.getDisk(name, this.provider.zones, undefined, signal);
    if (disk) {
      const zone = extractGcpZone(disk.zone) || this.provider.zones[0];
      await this.client.deleteDisk(zone, name, undefined, signal);
    }
  }

  /** The env a build runs with, delivered as instance metadata. */
  private buildEnv(
    config: ImageBuildProviderTriggerConfig,
    sandboxId: string,
    providerSessionId: string
  ): Record<string, string> {
    const envVars = buildImageBuildEnvVars({
      sandboxId,
      repositories: config.repositories,
      scmIdentity: scmCloneIdentity(this.config.scmProvider),
      cloneToken: config.cloneToken,
      baseEnvVars: config.userEnvVars,
    });
    Object.assign(envVars, {
      [IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY]: String(config.buildExecutionTimeoutSeconds),
      ...buildImageBuildCallbackEnv({
        buildId: config.buildId,
        callbackUrl: config.callbackUrl,
        failureCallbackUrl: config.failureCallbackUrl,
        token: config.callbackToken,
        providerSessionId,
      }),
      // The boot markers are stated last, so a scope secret can neither hold
      // the build dormant nor reshape it.
      [IMAGE_BUILD_MODE_ENV_VAR]: "true",
      [DEFERRED_START_ENV_VAR]: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: "false",
      SANDBOX_VERSION: SANDBOX_RUNTIME_VERSION,
    });
    return envVars;
  }
}

/**
 * The image a build is saved under: fixed by the deployment and build id, so
 * a repeated submission finds the earlier one (GCE refuses a second image
 * under a name) and two deployments sharing a project cannot collide. The
 * build id's own text leads so the console shows which scope it belongs to.
 */
export function gcpImageName(deploymentName: string, buildId: string): Promise<string> {
  return gcpBuildResourceName(GCP_IMAGE_NAME_PREFIX, deploymentName, buildId);
}

/** The build VM and boot disk name for a build, fixed like its image name. */
export function gcpImageBuildVmName(deploymentName: string, buildId: string): Promise<string> {
  return gcpBuildResourceName(GCP_BUILD_VM_NAME_PREFIX, deploymentName, buildId);
}

async function gcpBuildResourceName(
  prefix: string,
  deploymentName: string,
  buildId: string
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${deploymentName}:${buildId}`)
  );
  const slug = buildId
    .toLowerCase()
    .replace(/^imgb-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, GCP_NAME_SLUG_MAX_CHARS)
    .replace(/^-+|-+$/g, "");
  const digestHex = bytesToHex(new Uint8Array(digest)).slice(0, 16);
  return `${prefix}${slug ? `${slug}-` : ""}${digestHex}`;
}

/** Whether a failed GCP call left the requested operation's outcome unknown. */
export function isGcpUnavailable(error: unknown): boolean {
  if (error instanceof SandboxProviderError) return error.errorType === "transient";
  if (error instanceof GcpComputeApiError) return error.status === 429 || error.status >= 500;
  return SandboxProviderError.isTransientNetworkError(error);
}

function classifyGcpBuildError(message: string, error: unknown): SandboxProviderError {
  if (error instanceof SandboxProviderError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  const status = error instanceof GcpComputeApiError ? error.status : undefined;
  return SandboxProviderError.fromFetchError(`${message}: ${detail}`, error, status);
}
