import { GcpComputeApiError, type GcpImage } from "../sandbox/providers/gcp/client";
import { ImageBuildFinalizationAttemptError } from "./finalization-error";
import {
  isGcpUnavailable,
  type GcpBuildSourceStop,
  type GcpImageBuildResources,
} from "./gcp-build-resources";
import type { ImageBuildProviderImageRef } from "./model";
import { resolveImageBuildProviderSessionTimeoutSeconds } from "./timeouts";
import type {
  CompletedImageBuildInput,
  DeleteImageInput,
  FailedImageBuildInput,
  FinalizeImageBuildInput,
  ImageBuildAdapter,
  ImageBuildPlan,
  ImageBuildProviderOperation,
  ImageBuildStartCallbacks,
  ReconcileOrphanOperationInput,
  ReconcileOrphanOperationOutcome,
} from "./types";

const MS_PER_SECOND = 1000;

/**
 * When a build's image must have settled. GCE copies the whole boot disk into
 * the image, which for a large disk takes several minutes.
 */
export const GCP_IMAGE_SAVE_DEADLINE_MS = 30 * 60 * MS_PER_SECOND;

/** How long one finalization attempt watches an image, and how often it looks. */
export interface GcpImageBuildAdapterTimings {
  /** After this, the attempt reports the image pending and the next delivery takes over. */
  saveObservationMs: number;
  savePollIntervalMs: number;
}

const DEFAULT_GCP_IMAGE_BUILD_ADAPTER_TIMINGS: GcpImageBuildAdapterTimings = {
  saveObservationMs: 90_000,
  savePollIntervalMs: 5_000,
};

/**
 * GCP adapter for provider-session image builds.
 *
 * A GCP prebuilt image is a Compute Engine image of the build VM's boot disk,
 * under a name this deployment derives from the build. Creating one is
 * asynchronous (PENDING until READY or FAILED) and needs the VM stopped, so
 * finalization is resumable: each delivery stops the VM if it is still
 * running, reserves the image name under the build's lease, submits the
 * image, and then reconciles that name until it settles or the operation's
 * fixed deadline passes. A delivery that finds a reservation already recorded
 * only reconciles it.
 *
 * The name is the image's idempotency key: GCE refuses a second image under
 * a name, so a repeated submission can never leak an extra image, and a
 * reserved name with no image under it may simply be submitted again while
 * the deadline allows.
 */
export class GcpImageBuildAdapter implements ImageBuildAdapter {
  private readonly timings: GcpImageBuildAdapterTimings;

  constructor(
    private readonly resources: GcpImageBuildResources,
    timings: Partial<GcpImageBuildAdapterTimings> = {}
  ) {
    this.timings = { ...DEFAULT_GCP_IMAGE_BUILD_ADAPTER_TIMINGS, ...timings };
  }

  async startBuild(plan: ImageBuildPlan, callbacks: ImageBuildStartCallbacks): Promise<void> {
    await this.resources.triggerImageBuild({
      scopeKind: plan.scope.kind,
      scopeId: plan.scope.id,
      repositories: plan.repositories,
      buildId: plan.buildId,
      callbackUrl: plan.callbackUrl,
      failureCallbackUrl: plan.failureCallbackUrl,
      callbackToken: plan.callbackToken,
      userEnvVars: plan.userEnvVars,
      cloneToken: plan.cloneAuth.type === "credential_helper" ? plan.cloneAuth.token : undefined,
      buildExecutionTimeoutSeconds: Math.ceil(plan.buildTimeoutMs / MS_PER_SECOND),
      providerSessionTimeoutSeconds: resolveImageBuildProviderSessionTimeoutSeconds(
        plan.buildTimeoutMs
      ),
      onProviderSessionCreated: callbacks.bindProviderSession,
      correlation: plan.correlation,
    });
  }

  async finalizeSuccessfulBuild(
    input: FinalizeImageBuildInput
  ): Promise<ImageBuildProviderImageRef> {
    if (input.operation) {
      return await this.awaitImage(input, input.operation, { submitted: false });
    }
    return await this.submitImage(input);
  }

  async cleanupCompletedBuild(input: CompletedImageBuildInput): Promise<void> {
    // The image is a standalone copy; the build VM and its disk are not needed again.
    await this.resources.deleteBuildSandbox(input.providerSessionId, input.signal);
  }

  async cleanupFailedBuild(input: FailedImageBuildInput): Promise<void> {
    await this.resources.deleteBuildSandbox(input.providerSessionId, input.signal);
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.resources.deleteProviderImage(input.image.providerImageId, input.signal);
  }

  /**
   * A reserved name settles once GCE has no image under it or its image is
   * deleted. An image still being created keeps the obligation.
   */
  async reconcileOrphanOperation(
    input: ReconcileOrphanOperationInput
  ): Promise<ReconcileOrphanOperationOutcome> {
    const image = await this.resources.getImage(input.operationRef, input.signal);
    if (!image) return { type: "absent" };
    if (image.status === "PENDING") return { type: "pending" };
    // The name is this deployment's by construction; an image under it made
    // from another disk would still be someone else's artifact.
    if (!isImageOf(image, input.providerSessionId)) return { type: "absent" };
    await this.resources.deleteProviderImage(input.operationRef, input.signal);
    return { type: "deleted" };
  }

  /**
   * First delivery for a build: stop the VM, reserve the image name and
   * submit the image. Nothing is submitted without a reservation, and a VM
   * that is still stopping is reported as pending rather than imaged mid-stop.
   */
  private async submitImage(input: FinalizeImageBuildInput): Promise<ImageBuildProviderImageRef> {
    let stopped: GcpBuildSourceStop;
    try {
      stopped = await this.resources.stopBuildSandboxForSave(input.providerSessionId, input.signal);
    } catch (error) {
      // Nothing is reserved or submitted yet; a later delivery retries.
      if (!isGcpUnavailable(error)) throw error;
      throw new ImageBuildFinalizationAttemptError(
        "GCP build VM is temporarily unavailable",
        "definitely_not_created",
        { cause: error }
      );
    }
    if (stopped === "missing") {
      throw new Error("GCP build VM no longer exists");
    }
    if (stopped === "stopping") {
      throw new ImageBuildFinalizationAttemptError("GCP build VM is still stopping", "pending");
    }

    const operation: ImageBuildProviderOperation = {
      ref: await this.resources.imageName(input.buildId),
      deadlineAt: Date.now() + GCP_IMAGE_SAVE_DEADLINE_MS,
    };
    if (!(await input.reserveOperation(operation.ref, operation.deadlineAt))) {
      throw new ImageBuildFinalizationAttemptError(
        "Another delivery holds this build's image reservation",
        "pending"
      );
    }

    await this.save(input, operation.ref);
    return await this.awaitImage(input, operation, { submitted: true });
  }

  /**
   * Submit the image under the reserved name. One already under it is this
   * build's own earlier request; a request whose outcome is unknown is
   * reconciled under the name.
   */
  private async save(input: FinalizeImageBuildInput, name: string): Promise<void> {
    try {
      await this.resources.saveImage(input.providerSessionId, name, input.signal);
    } catch (error) {
      if (error instanceof GcpComputeApiError && error.status === 409) return;
      if (isGcpUnavailable(error)) return;
      throw error;
    }
  }

  /**
   * Poll the reserved name until it names a READY image of this build's disk.
   *
   * No image under a reserved name means no accepted request, so the image is
   * submitted (once per delivery) unless the operation's deadline has passed.
   * A FAILED image fails the build. The attempt stops watching after its
   * observation window and reports pending; past the deadline the build
   * fails and maintenance reclaims whatever the name later holds. An image
   * that is already READY is adopted whatever the clock says.
   */
  private async awaitImage(
    input: FinalizeImageBuildInput,
    operation: ImageBuildProviderOperation,
    state: { submitted: boolean }
  ): Promise<ImageBuildProviderImageRef> {
    const attemptDeadline = Date.now() + this.timings.saveObservationMs;
    let submitted = state.submitted;
    for (;;) {
      let image: GcpImage | null | undefined;
      try {
        image = await this.resources.getImage(operation.ref, input.signal);
      } catch (error) {
        // An unreachable API says nothing about the image; a later read decides.
        if (!isGcpUnavailable(error)) throw error;
        image = undefined;
      }

      if (image) {
        if (image.status === "READY") {
          if (!isImageOf(image, input.providerSessionId)) {
            throw new Error("GCP image under this build's name was made from another disk");
          }
          return {
            providerImageId: this.resources.imageReference(operation.ref),
            providerSessionId: input.providerSessionId,
          };
        }
        if (image.status === "FAILED") {
          throw new Error(`GCP image ${operation.ref} failed to create`);
        }
      } else if (image === null && !submitted && Date.now() < operation.deadlineAt) {
        submitted = true;
        await this.save(input, operation.ref);
      }

      const now = Date.now();
      if (now >= operation.deadlineAt) {
        throw new ImageBuildFinalizationAttemptError(
          "GCP image creation deadline exhausted",
          "ambiguous"
        );
      }
      if (now >= attemptDeadline) {
        throw new ImageBuildFinalizationAttemptError(
          `GCP image is still ${image?.status ?? "unconfirmed"}`,
          "pending"
        );
      }
      await delay(this.timings.savePollIntervalMs, input.signal);
    }
  }
}

/**
 * Whether an image was made from the build's disk (named like its VM). An
 * image that names no source, or a row that has dropped its VM, leaves
 * nothing to compare, and the name itself is the deployment's.
 */
function isImageOf(image: GcpImage, providerSessionId: string | null): boolean {
  if (!image.sourceDisk || !providerSessionId) return true;
  return image.sourceDisk.endsWith(`/disks/${providerSessionId}`);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
