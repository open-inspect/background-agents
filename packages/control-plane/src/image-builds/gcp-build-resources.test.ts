import { describe, expect, it, vi } from "vitest";
import type { ImageBuildProviderTriggerConfig } from "../sandbox/provider";
import { SANDBOX_RUNTIME_VERSION } from "../sandbox/runtime-manifest";
import type { GcpComputeClient } from "../sandbox/providers/gcp/client";
import { GcpImageBuildResources, gcpImageBuildVmName, gcpImageName } from "./gcp-build-resources";

const BUILD_ID = "imgb-acme-repo-1757000000000-ab12";
const GCE_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

function createClient(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const client = {
    project: "test-proj",
    calls,
    createDisk: vi.fn(async (spec: { name: string; zone: string }) => {
      calls.push("createDisk");
      return { name: spec.name, zone: `projects/test-proj/zones/${spec.zone}` };
    }),
    createInstance: vi.fn(async (spec: { name: string; zone: string }) => {
      calls.push("createInstance");
      return { name: spec.name, status: "RUNNING", zone: `projects/test-proj/zones/${spec.zone}` };
    }),
    getInstance: vi.fn(async () => null as unknown),
    getDisk: vi.fn(async () => null as unknown),
    requestStopInstance: vi.fn(async () => undefined),
    deleteInstance: vi.fn(async () => undefined),
    deleteDisk: vi.fn(async () => undefined),
    requestCreateImage: vi.fn(async () => undefined),
    getImage: vi.fn(async () => null),
    deleteImage: vi.fn(async () => undefined),
    ...overrides,
  };
  return client;
}

function createResources(client: ReturnType<typeof createClient>) {
  return new GcpImageBuildResources(
    client as unknown as GcpComputeClient,
    {
      project: "test-proj",
      zones: ["us-central1-a", "us-central1-b"],
      defaultImageFamily: "open-inspect-sandbox",
      vmServiceAccountEmail: "vm@test-proj.iam.gserviceaccount.com",
      includeStartupScript: true,
    },
    { scmProvider: "github", deploymentName: "acme" }
  );
}

function triggerConfig(
  overrides: Partial<ImageBuildProviderTriggerConfig> = {}
): ImageBuildProviderTriggerConfig {
  return {
    buildId: BUILD_ID,
    scopeKind: "repo",
    scopeId: "acme/repo",
    repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "main" }],
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
    callbackToken: "token-1",
    userEnvVars: { NPM_TOKEN: "secret-1", FROM_REPO_IMAGE: "true", IMAGE_BUILD_MODE: "false" },
    cloneToken: "clone-1",
    buildExecutionTimeoutSeconds: 1800,
    providerSessionTimeoutSeconds: 3600,
    onProviderSessionCreated: vi.fn(async () => undefined),
    correlation: { request_id: "r", trace_id: "t" },
    ...overrides,
  };
}

describe("GcpImageBuildResources.triggerImageBuild", () => {
  it("binds the VM name before creating anything, then boots it in build mode", async () => {
    const client = createClient();
    const config = triggerConfig({
      onProviderSessionCreated: vi.fn(async () => {
        client.calls.push("bind");
      }),
    });

    await createResources(client).triggerImageBuild(config);

    const name = await gcpImageBuildVmName("acme", BUILD_ID);
    expect(client.calls).toEqual(["bind", "createDisk", "createInstance"]);
    expect(config.onProviderSessionCreated).toHaveBeenCalledWith(name);
    expect(client.createDisk).toHaveBeenCalledWith(
      expect.objectContaining({
        name,
        sourceImage: "open-inspect-sandbox",
        treatBareImageAsFamily: true,
      }),
      config.correlation
    );
    expect(client.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        name,
        maxRunDurationSeconds: 3600,
        serviceAccountEmail: "vm@test-proj.iam.gserviceaccount.com",
        labels: expect.objectContaining({
          managed_by: "background-agents-gcp",
          deployment: "acme",
        }),
      }),
      config.correlation
    );
  });

  it("delivers the build env as metadata with the callback contract and the boot markers stated last", async () => {
    const client = createClient();

    await createResources(client).triggerImageBuild(triggerConfig());

    const spec = vi.mocked(client.createInstance).mock.calls[0][0] as unknown as {
      metadata: Record<string, string>;
      labels: Record<string, string>;
    };
    expect(spec.metadata.image_build_mode).toBe("true");
    expect(spec.metadata["startup-script"]).toContain("oi-sandbox-runtime");
    const env = JSON.parse(spec.metadata.image_build_env) as Record<string, string>;
    expect(env).toMatchObject({
      IMAGE_BUILD_MODE: "true",
      FROM_REPO_IMAGE: "false",
      OI_DEFERRED_START: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      SANDBOX_VERSION: SANDBOX_RUNTIME_VERSION,
      OI_REPO_IMAGE_BUILD_ID: BUILD_ID,
      OI_REPO_IMAGE_PROVIDER_SESSION_ID: await gcpImageBuildVmName("acme", BUILD_ID),
      OI_REPO_IMAGE_CALLBACK_TOKEN: "token-1",
      OI_IMAGE_BUILD_EXECUTION_TIMEOUT_SECONDS: "1800",
      VCS_CLONE_TOKEN: "clone-1",
      NPM_TOKEN: "secret-1",
    });
    // Secrets live only in the metadata attribute, never in labels.
    expect(JSON.stringify(spec.labels)).not.toContain("secret-1");
    expect(JSON.stringify(spec.labels)).not.toContain("clone-1");
  });

  it("leaves cleanup of a failed create to the workflow, which already has the name", async () => {
    const client = createClient({
      createInstance: vi.fn(async () => {
        throw new Error("quota exceeded");
      }),
    });
    const config = triggerConfig();

    await expect(createResources(client).triggerImageBuild(config)).rejects.toThrow(
      "Failed to trigger GCP image build"
    );
    expect(config.onProviderSessionCreated).toHaveBeenCalledTimes(1);
    expect(client.deleteDisk).not.toHaveBeenCalled();
  });
});

describe("GcpImageBuildResources lifecycle", () => {
  const vm = (status: string) => ({
    name: "oi-build-x",
    status,
    zone: "projects/test-proj/zones/us-central1-b",
  });

  it("reports a stopped VM, asks a running one to stop, and reports a missing one", async () => {
    const stopped = createClient({ getInstance: vi.fn(async () => vm("TERMINATED")) });
    await expect(createResources(stopped).stopBuildSandboxForSave("oi-build-x")).resolves.toBe(
      "stopped"
    );
    expect(stopped.requestStopInstance).not.toHaveBeenCalled();

    const running = createClient({ getInstance: vi.fn(async () => vm("RUNNING")) });
    await expect(createResources(running).stopBuildSandboxForSave("oi-build-x")).resolves.toBe(
      "stopping"
    );
    expect(running.requestStopInstance).toHaveBeenCalledWith(
      "us-central1-b",
      "oi-build-x",
      undefined,
      undefined
    );

    const stopping = createClient({ getInstance: vi.fn(async () => vm("STOPPING")) });
    await expect(createResources(stopping).stopBuildSandboxForSave("oi-build-x")).resolves.toBe(
      "stopping"
    );
    expect(stopping.requestStopInstance).not.toHaveBeenCalled();

    await expect(
      createResources(createClient()).stopBuildSandboxForSave("oi-build-x")
    ).resolves.toBe("missing");
  });

  it("images the build disk in its own zone, labeled for this deployment", async () => {
    const client = createClient({
      getDisk: vi.fn(async () => ({
        name: "oi-build-x",
        zone: "projects/test-proj/zones/us-central1-b",
      })),
    });

    await createResources(client).saveImage("oi-build-x", "oi-img-x");

    expect(client.requestCreateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "oi-img-x",
        sourceDisk: expect.stringContaining("zones/us-central1-b/disks/oi-build-x"),
        labels: expect.objectContaining({ deployment: "acme" }),
      }),
      undefined,
      undefined
    );
  });

  it("deletes only prebuilt images, by name or full reference", async () => {
    const client = createClient();
    const resources = createResources(client);

    await resources.deleteProviderImage("projects/test-proj/global/images/oi-img-abc");
    expect(client.deleteImage).toHaveBeenCalledWith("oi-img-abc", undefined, undefined);

    await expect(resources.deleteProviderImage("open-inspect-sandbox-0123")).rejects.toThrow(
      "not a prebuilt image"
    );
    await expect(
      resources.deleteProviderImage("projects/test-proj/global/images/family/open-inspect-sandbox")
    ).rejects.toThrow("not a prebuilt image");
  });

  it("deletes the build VM, then its disk, either one already gone", async () => {
    const client = createClient({
      getInstance: vi.fn(async () => vm("TERMINATED")),
      getDisk: vi.fn(async () => ({
        name: "oi-build-x",
        zone: "projects/test-proj/zones/us-central1-b",
      })),
    });
    await createResources(client).deleteBuildSandbox("oi-build-x");
    expect(client.deleteInstance).toHaveBeenCalledWith(
      "us-central1-b",
      "oi-build-x",
      undefined,
      undefined
    );
    expect(client.deleteDisk).toHaveBeenCalledWith(
      "us-central1-b",
      "oi-build-x",
      undefined,
      undefined
    );

    const gone = createClient();
    await expect(createResources(gone).deleteBuildSandbox("oi-build-x")).resolves.toBeUndefined();
    expect(gone.deleteInstance).not.toHaveBeenCalled();
  });
});

describe("GCP image build names", () => {
  it("are valid GCE names, stable per build and distinct per deployment", async () => {
    const image = await gcpImageName("acme", BUILD_ID);
    const vm = await gcpImageBuildVmName("acme", BUILD_ID);

    expect(image).toMatch(GCE_NAME);
    expect(vm).toMatch(GCE_NAME);
    expect(image.startsWith("oi-img-acme-repo-")).toBe(true);
    expect(await gcpImageName("acme", BUILD_ID)).toBe(image);
    expect(await gcpImageName("other", BUILD_ID)).not.toBe(image);
    expect(await gcpImageName("acme", `imgb-${"x".repeat(200)}`)).toMatch(GCE_NAME);
  });
});
