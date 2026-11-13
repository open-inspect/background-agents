import { describe, expect, it, vi } from "vitest";
import { GcpComputeApiError, type GcpImage } from "../sandbox/providers/gcp/client";
import { ImageBuildFinalizationAttemptError } from "./finalization-error";
import { GCP_IMAGE_SAVE_DEADLINE_MS, GcpImageBuildAdapter } from "./gcp-adapter";
import type { GcpBuildSourceStop, GcpImageBuildResources } from "./gcp-build-resources";
import { resolveImageBuildProviderSessionTimeoutSeconds } from "./timeouts";
import type { FinalizeImageBuildInput, ImageBuildPlan } from "./types";

const BUILD_ID = "imgb-acme-repo-1757000000000-ab12";
const VM_NAME = "oi-build-acme-repo-1757000000000-ab12-0123456789abcdef";
const IMAGE_NAME = "oi-img-acme-repo-1757000000000-ab12-0123456789abcdef";
const IMAGE_REF = `projects/test-proj/global/images/${IMAGE_NAME}`;
const correlation = { request_id: "request-1", trace_id: "trace-1" };

function image(overrides: Partial<GcpImage> = {}): GcpImage {
  return {
    name: IMAGE_NAME,
    status: "READY",
    sourceDisk: `https://www.googleapis.com/compute/v1/projects/test-proj/zones/us-central1-a/disks/${VM_NAME}`,
    ...overrides,
  };
}

function createResources(overrides: Record<string, unknown> = {}) {
  return {
    triggerImageBuild: vi.fn(async () => undefined),
    stopBuildSandboxForSave: vi.fn(async (): Promise<GcpBuildSourceStop> => "stopped"),
    imageName: vi.fn(async () => IMAGE_NAME),
    imageReference: vi.fn((name: string) => `projects/test-proj/global/images/${name}`),
    saveImage: vi.fn(async () => undefined),
    getImage: vi.fn(async (): Promise<GcpImage | null> => image()),
    deleteProviderImage: vi.fn(async () => undefined),
    deleteBuildSandbox: vi.fn(async () => undefined),
    ...overrides,
  };
}

type ResourcesMock = ReturnType<typeof createResources>;

function createAdapter(resources: ResourcesMock) {
  return new GcpImageBuildAdapter(resources as unknown as GcpImageBuildResources, {
    saveObservationMs: 30,
    savePollIntervalMs: 1,
  });
}

function finalizeInput(overrides: Partial<FinalizeImageBuildInput> = {}): FinalizeImageBuildInput {
  return {
    buildId: BUILD_ID,
    providerSessionId: VM_NAME,
    correlation,
    operation: null,
    reserveOperation: vi.fn(async () => true),
    ...overrides,
  };
}

function plan(): ImageBuildPlan {
  return {
    buildId: BUILD_ID,
    scope: { kind: "repo", id: "acme/repo" },
    repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "main" }],
    repositoriesFingerprint: "fp-1",
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
    buildTimeoutMs: 1_800_000,
    correlation,
    callbackToken: "a".repeat(64),
    cloneAuth: { type: "credential_helper", token: "clone-1" },
  };
}

describe("GcpImageBuildAdapter", () => {
  it("starts a build with the provider-session lifetime and the clone token", async () => {
    const resources = createResources();
    const bind = vi.fn(async () => undefined);

    await createAdapter(resources).startBuild(plan(), { bindProviderSession: bind });

    expect(resources.triggerImageBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: BUILD_ID,
        cloneToken: "clone-1",
        buildExecutionTimeoutSeconds: 1800,
        providerSessionTimeoutSeconds: resolveImageBuildProviderSessionTimeoutSeconds(1_800_000),
        onProviderSessionCreated: bind,
      })
    );
  });

  it("stops the VM, reserves the name, submits the image and adopts it once READY", async () => {
    const resources = createResources({
      getImage: vi
        .fn()
        .mockResolvedValueOnce(image({ status: "PENDING" }))
        .mockResolvedValue(image()),
    });
    const input = finalizeInput();

    const ref = await createAdapter(resources).finalizeSuccessfulBuild(input);

    expect(ref).toEqual({ providerImageId: IMAGE_REF, providerSessionId: VM_NAME });
    expect(resources.stopBuildSandboxForSave).toHaveBeenCalledWith(VM_NAME, undefined);
    expect(input.reserveOperation).toHaveBeenCalledWith(IMAGE_NAME, expect.any(Number));
    expect(resources.saveImage).toHaveBeenCalledTimes(1);
  });

  it("reports pending while the VM is still stopping, before reserving anything", async () => {
    const resources = createResources({
      stopBuildSandboxForSave: vi.fn(async (): Promise<GcpBuildSourceStop> => "stopping"),
    });
    const input = finalizeInput();

    await expect(createAdapter(resources).finalizeSuccessfulBuild(input)).rejects.toMatchObject({
      outcome: "pending",
    });
    expect(input.reserveOperation).not.toHaveBeenCalled();
    expect(resources.saveImage).not.toHaveBeenCalled();
  });

  it("fails a build whose VM is gone", async () => {
    const resources = createResources({
      stopBuildSandboxForSave: vi.fn(async (): Promise<GcpBuildSourceStop> => "missing"),
    });
    await expect(createAdapter(resources).finalizeSuccessfulBuild(finalizeInput())).rejects.toThrow(
      "no longer exists"
    );
  });

  it("submits nothing without the reservation", async () => {
    const resources = createResources();
    const input = finalizeInput({ reserveOperation: vi.fn(async () => false) });

    await expect(createAdapter(resources).finalizeSuccessfulBuild(input)).rejects.toMatchObject({
      outcome: "pending",
    });
    expect(resources.saveImage).not.toHaveBeenCalled();
  });

  it("treats an image already under the name as its own earlier submission", async () => {
    const resources = createResources({
      saveImage: vi.fn(async () => {
        throw new GcpComputeApiError("already exists", 409);
      }),
    });

    await expect(
      createAdapter(resources).finalizeSuccessfulBuild(finalizeInput())
    ).resolves.toMatchObject({ providerImageId: IMAGE_REF });
  });

  it("only reconciles a reservation an earlier delivery recorded, resubmitting once if absent", async () => {
    const resources = createResources({
      getImage: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(image()),
    });
    const input = finalizeInput({
      operation: { ref: IMAGE_NAME, deadlineAt: Date.now() + GCP_IMAGE_SAVE_DEADLINE_MS },
    });

    await createAdapter(resources).finalizeSuccessfulBuild(input);

    expect(resources.stopBuildSandboxForSave).not.toHaveBeenCalled();
    expect(input.reserveOperation).not.toHaveBeenCalled();
    expect(resources.saveImage).toHaveBeenCalledTimes(1);
  });

  it("fails the build when the image FAILED or came from another disk", async () => {
    const failed = createResources({ getImage: vi.fn(async () => image({ status: "FAILED" })) });
    await expect(createAdapter(failed).finalizeSuccessfulBuild(finalizeInput())).rejects.toThrow(
      "failed to create"
    );

    const foreign = createResources({
      getImage: vi.fn(async () =>
        image({ sourceDisk: "projects/test-proj/zones/us-central1-a/disks/someone-else" })
      ),
    });
    await expect(createAdapter(foreign).finalizeSuccessfulBuild(finalizeInput())).rejects.toThrow(
      "another disk"
    );
  });

  it("reports pending after its observation window and ambiguous past the deadline", async () => {
    const pending = createResources({ getImage: vi.fn(async () => image({ status: "PENDING" })) });
    await expect(
      createAdapter(pending).finalizeSuccessfulBuild(finalizeInput())
    ).rejects.toMatchObject({ outcome: "pending" });

    const expired = createResources({ getImage: vi.fn(async () => image({ status: "PENDING" })) });
    const error = await createAdapter(expired)
      .finalizeSuccessfulBuild(
        finalizeInput({ operation: { ref: IMAGE_NAME, deadlineAt: Date.now() - 1 } })
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageBuildFinalizationAttemptError);
    expect(error).toMatchObject({ outcome: "ambiguous" });
  });

  it("reconciles orphaned image names", async () => {
    const input = {
      buildId: BUILD_ID,
      operationRef: IMAGE_NAME,
      providerSessionId: VM_NAME,
      correlation,
    };
    const absent = createResources({ getImage: vi.fn(async () => null) });
    await expect(createAdapter(absent).reconcileOrphanOperation(input)).resolves.toEqual({
      type: "absent",
    });

    const pending = createResources({ getImage: vi.fn(async () => image({ status: "PENDING" })) });
    await expect(createAdapter(pending).reconcileOrphanOperation(input)).resolves.toEqual({
      type: "pending",
    });

    const ready = createResources();
    await expect(createAdapter(ready).reconcileOrphanOperation(input)).resolves.toEqual({
      type: "deleted",
    });
    expect(ready.deleteProviderImage).toHaveBeenCalledWith(IMAGE_NAME, undefined);
  });

  it("deletes the build VM after success and failure, and images by reference", async () => {
    const resources = createResources();
    const adapter = createAdapter(resources);

    await adapter.cleanupCompletedBuild({
      buildId: BUILD_ID,
      providerSessionId: VM_NAME,
      correlation,
    });
    await adapter.cleanupFailedBuild({
      buildId: BUILD_ID,
      providerSessionId: VM_NAME,
      errorMessage: "boom",
      correlation,
    });
    await adapter.deleteImage({ image: { providerImageId: IMAGE_REF } });

    expect(resources.deleteBuildSandbox).toHaveBeenCalledTimes(2);
    expect(resources.deleteProviderImage).toHaveBeenCalledWith(IMAGE_REF, undefined);
  });
});
