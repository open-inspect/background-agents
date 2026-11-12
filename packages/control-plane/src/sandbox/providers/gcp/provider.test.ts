import { describe, expect, it, vi, afterEach } from "vitest";
import { GcpServiceAccountTokenProvider, parseGcpServiceAccountKey } from "./auth";
import type { GcpComputeClient } from "./client";
import { GcpComputeApiError } from "./client";
import {
  buildGcpCreateMetadata,
  buildGcpRestoreMetadata,
  buildGcpResumeMetadata,
  buildGcpStartupScript,
} from "./metadata";
import {
  gcpImageSourceUrl,
  gcpSandboxLabels,
  gcpSandboxName,
  gcpSnapshotName,
  gcpZoneForSession,
} from "./naming";
import { GcpSandboxProvider } from "./provider";
import type { CreateSandboxConfig, RestoreConfig, ResumeConfig, StopConfig } from "../../provider";

async function generateTestPrivateKeyPem(): Promise<string> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;
  const base64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

const baseCreateConfig: CreateSandboxConfig = {
  sessionId: "sess-123",
  sandboxId: "sbx-123",
  repoOwner: "acme",
  repoName: "example-repo",
  controlPlaneUrl: "https://cp.example.com",
  sandboxAuthToken: "secret-auth-token",
  harness: "claude",
  provider: "google-vertex-anthropic",
  model: "claude-sonnet-4-6",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GCP naming and image URL resolution", () => {
  it("sanitizes session IDs into valid GCE resource names", () => {
    expect(gcpSandboxName("sess_ABC-123")).toBe("ssess-abc-123");
    expect(gcpSnapshotName("sess_ABC", 1700000000)).toBe("sb-sess-abc-snap-1700000000");
  });

  it("normalizes image family and image self-link references", () => {
    expect(
      gcpImageSourceUrl("my-proj", "sandbox-image-family", {
        treatBareAsFamily: true,
      })
    ).toBe("projects/my-proj/global/images/family/sandbox-image-family");

    expect(
      gcpImageSourceUrl("my-proj", "sandbox-image-family", {
        imageProject: "shared-images",
        treatBareAsFamily: true,
      })
    ).toBe("projects/shared-images/global/images/family/sandbox-image-family");

    expect(
      gcpImageSourceUrl("my-proj", "family/sandbox-image-family", {
        imageProject: "shared-images",
      })
    ).toBe("projects/shared-images/global/images/family/sandbox-image-family");

    expect(
      gcpImageSourceUrl("my-proj", "projects/other/global/images/custom-img-1", {
        treatBareAsFamily: true,
      })
    ).toBe("projects/other/global/images/custom-img-1");

    expect(
      gcpImageSourceUrl("my-proj", "custom-img-1", {
        treatBareAsFamily: false,
      })
    ).toBe("projects/my-proj/global/images/custom-img-1");
  });

  it("constructs standard GCE labels", () => {
    expect(gcpSandboxLabels("sbx-1", "sess-1", "standard", { env: "prod" })).toEqual({
      managed_by: "background-agents-gcp",
      sandbox_id: "sbx-1",
      session_id: "sess-1",
      provisioned: "standard",
      env: "prod",
    });
  });

  it("adds a label-safe deployment label that operator labels cannot override", () => {
    expect(
      gcpSandboxLabels(
        "sbx-1",
        "sess-1",
        "standard",
        { managed_by: "spoofed", deployment: "other" },
        "Acme_Prod"
      )
    ).toEqual({
      managed_by: "background-agents-gcp",
      deployment: "acme-prod",
      sandbox_id: "sbx-1",
      session_id: "sess-1",
      provisioned: "standard",
    });
  });
});

describe("GCP metadata and startup-script", () => {
  const bootConfig = { vertexProject: "vertex-proj", vertexLocation: "global" };

  it("builds create metadata matching the startup-script contract", () => {
    const metadata = buildGcpCreateMetadata(
      {
        ...baseCreateConfig,
        branch: "main",
        agentSessionId: "agent-1",
        agentSlackNotifyEnabled: true,
        timeoutSeconds: 3600,
        repositories: [
          {
            repoOwner: "acme",
            repoName: "example-repo",
            baseBranch: "main",
            baseSha: "0123456789abcdef0123456789abcdef01234567",
          },
        ],
        userEnvVars: { FOO: "bar" },
        sandboxSettings: { tunnelPorts: [3000, 8080] },
      },
      bootConfig,
      true
    );

    expect(metadata).toMatchObject({
      session_id: "sess-123",
      sandbox_id: "sbx-123",
      control_plane_url: "https://cp.example.com",
      sandbox_auth_token: "secret-auth-token",
      repo_owner: "acme",
      repo_name: "example-repo",
      branch: "main",
      agent_session_id: "agent-1",
      harness: "claude",
      provider: "google-vertex-anthropic",
      model: "claude-sonnet-4-6",
      code_server_enabled: "false",
      agent_slack_notify_enabled: "true",
      timeout_seconds: "3600",
      vertex_project: "vertex-proj",
      vertex_location: "global",
      user_env_vars: JSON.stringify({ FOO: "bar" }),
      sandbox_settings: JSON.stringify({ tunnel_ports: [3000, 8080] }),
    });
    expect(JSON.parse(metadata.repositories)).toEqual([
      {
        repo_owner: "acme",
        repo_name: "example-repo",
        branch: "main",
        base_sha: "0123456789abcdef0123456789abcdef01234567",
      },
    ]);
    expect(metadata["startup-script"]).toContain("/usr/local/bin/oi-sandbox-runtime");
    expect(metadata["startup-script"]).toContain("sandbox-runtime.service");
  });

  it("omits startup-script when disabled and prunes empty fields", () => {
    const metadata = buildGcpCreateMetadata(baseCreateConfig, bootConfig, false);
    expect(metadata["startup-script"]).toBeUndefined();
    expect(metadata.branch).toBeUndefined();
    expect(metadata.agent_session_id).toBeUndefined();
    expect(metadata.agent_slack_notify_enabled).toBeUndefined();
  });

  it("builds restore and resume metadata", () => {
    const restoreConfig: RestoreConfig = {
      ...baseCreateConfig,
      snapshotImageId: "snap-1",
    };
    const restoreMeta = buildGcpRestoreMetadata(restoreConfig, bootConfig, false);
    expect(restoreMeta.snapshot_image_id).toBe("snap-1");
    expect(restoreMeta.harness).toBe("claude");

    const resumeConfig: ResumeConfig = {
      providerObjectId: "inst-1",
      sessionId: "sess-123",
      sandboxId: "sbx-123",
    };
    const resumeMeta = buildGcpResumeMetadata(resumeConfig, bootConfig, false);
    expect(resumeMeta).toEqual({
      session_id: "sess-123",
      sandbox_id: "sbx-123",
      vertex_project: "vertex-proj",
      vertex_location: "global",
    });
  });

  it("renders a valid startup-script", () => {
    const script = buildGcpStartupScript();
    expect(script).toContain("python -m sandbox_runtime.entrypoint");
    expect(script).toContain("RESTORED_FROM_SNAPSHOT=true");
    expect(script).toContain("systemctl start --no-block sandbox-runtime.service");
  });

  it("refuses to start without the image's runtime and keeps runtime state on the boot disk", () => {
    const script = buildGcpStartupScript();
    const runtimeCheck = script.indexOf("if [ ! -x /opt/openinspect/python/bin/python ]");
    expect(runtimeCheck).toBeGreaterThan(-1);
    expect(runtimeCheck).toBeLessThan(script.indexOf("systemctl"));
    expect(script).toContain('export OPENINSPECT_STATE_DIR="${STATE}/state"');
    expect(script).toContain('export OI_BOOT_COMPLETE_MARKER="${STATE}/boot-complete"');
    expect(script).toContain(
      "exec /opt/openinspect/python/bin/python -m sandbox_runtime.entrypoint"
    );
    expect(script).not.toContain("first-boot-id");
  });
});

describe("GcpServiceAccountTokenProvider", () => {
  it("parses service account JSON and exchanges signed JWT for an access token", async () => {
    const privateKey = await generateTestPrivateKeyPem();
    const keyJson = JSON.stringify({
      client_email: "sandbox-sa@my-proj.iam.gserviceaccount.com",
      private_key: privateKey,
      project_id: "my-proj",
    });

    const parsed = parseGcpServiceAccountKey(keyJson);
    expect(parsed.client_email).toBe("sandbox-sa@my-proj.iam.gserviceaccount.com");

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ access_token: "ya29.test-token", expires_in: 3600 }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokenProvider = new GcpServiceAccountTokenProvider(parsed);
    const token1 = await tokenProvider.getAccessToken();
    const token2 = await tokenProvider.getAccessToken();

    expect(token1).toBe("ya29.test-token");
    expect(token2).toBe("ya29.test-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid service account JSON", () => {
    expect(() => parseGcpServiceAccountKey("not-json")).toThrow(
      "GCP_SERVICE_ACCOUNT_JSON must be valid JSON"
    );
    expect(() => parseGcpServiceAccountKey(JSON.stringify({ client_email: "a@b" }))).toThrow(
      "GCP_SERVICE_ACCOUNT_JSON must include client_email and private_key fields"
    );
  });
});

describe("GcpSandboxProvider", () => {
  function createMockGcpClient(overrides: Partial<GcpComputeClient> = {}): GcpComputeClient {
    return {
      project: "test-project",
      getInstance: vi.fn(async () => null),
      getInstanceInZone: vi.fn(),
      createInstance: vi.fn(async (spec) => ({
        name: spec.name,
        status: "RUNNING",
        zone: `projects/test-project/zones/${spec.zone}`,
        selfLink: `https://compute.googleapis.com/compute/v1/projects/test-project/zones/${spec.zone}/instances/${spec.name}`,
      })),
      setInstanceMetadata: vi.fn(async () => undefined),
      startInstance: vi.fn(async () => undefined),
      deleteInstance: vi.fn(async () => undefined),
      getDisk: vi.fn(async () => null),
      getDiskInZone: vi.fn(),
      createDisk: vi.fn(async (spec) => ({
        name: spec.name,
        status: "READY",
        zone: `projects/test-project/zones/${spec.zone}`,
      })),
      deleteDisk: vi.fn(async () => undefined),
      createDiskSnapshot: vi.fn(async () => undefined),
      deleteSnapshot: vi.fn(async () => undefined),
      listDisks: vi.fn(async () => []),
      ...overrides,
    } as unknown as GcpComputeClient;
  }

  it("uses per-repo sandboxSettings.imageFamily over defaultImageFamily", async () => {
    const client = createMockGcpClient();
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones: ["us-central1-a", "us-central1-b"],
      defaultImageFamily: "default-family",
      includeStartupScript: true,
    });

    const result = await provider.createSandbox({
      ...baseCreateConfig,
      sandboxSettings: { imageFamily: "repo-custom-family" },
    });

    expect(client.createDisk).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ssess-123",
        zone: "us-central1-a",
        sourceImage: "repo-custom-family",
        treatBareImageAsFamily: true,
      }),
      undefined
    );
    expect(client.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ssess-123",
        zone: "us-central1-a",
        metadata: expect.objectContaining({
          session_id: "sess-123",
          "startup-script": expect.stringContaining("oi-sandbox-runtime"),
        }),
      }),
      undefined
    );
    expect(result.providerObjectId).toContain("/instances/ssess-123");
  });

  it("boots the gcp-infra image family when no image is configured", async () => {
    const client = createMockGcpClient();
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones: ["us-central1-a"],
    });

    await provider.createSandbox(baseCreateConfig);

    expect(client.createDisk).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceImage: "open-inspect-sandbox",
        treatBareImageAsFamily: true,
      }),
      undefined
    );
  });

  it("falls back to defaultImageFamily when repo imageFamily is not set", async () => {
    const client = createMockGcpClient();
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones: ["us-central1-a"],
      defaultImageFamily: "sandbox-image-family",
    });

    await provider.createSandbox(baseCreateConfig);

    expect(client.createDisk).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceImage: "sandbox-image-family",
        treatBareImageAsFamily: true,
      }),
      undefined
    );
  });

  it("cleans up boot disk when VM creation fails", async () => {
    const client = createMockGcpClient({
      createInstance: vi.fn(async () => {
        throw new GcpComputeApiError("quota exceeded", 403);
      }),
    });
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones: ["us-central1-a"],
      defaultImageFamily: "sandbox-image-family",
    });

    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      errorType: "permanent",
    });
    expect(client.deleteDisk).toHaveBeenCalledWith("us-central1-a", "ssess-123", undefined);
  });

  it("creates the disk and VM in the session's zone, falling back from Spot to standard there", async () => {
    const attempts: Array<{ zone: string; spot?: boolean }> = [];
    const client = createMockGcpClient({
      createInstance: vi.fn(async (spec) => {
        attempts.push({ zone: spec.zone, spot: spec.spot });
        if (spec.spot) {
          throw new GcpComputeApiError("ZONE_RESOURCE_POOL_EXHAUSTED", 403);
        }
        return {
          name: spec.name,
          status: "RUNNING",
          zone: `projects/test-project/zones/${spec.zone}`,
          selfLink: `https://compute.googleapis.com/compute/v1/projects/test-project/zones/${spec.zone}/instances/${spec.name}`,
        };
      }),
    });

    const zones = ["us-central1-a", "us-central1-b", "us-central1-c", "us-central1-f"];
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones,
      defaultImageFamily: "sandbox-image-family",
      useSpot: true,
    });

    await provider.createSandbox(baseCreateConfig);

    const zone = gcpZoneForSession(baseCreateConfig.sessionId, zones);
    expect(client.createDisk).toHaveBeenCalledWith(expect.objectContaining({ zone }), undefined);
    expect(attempts).toEqual([
      { zone, spot: true },
      { zone, spot: false },
    ]);
  });

  it("does not try other zones when a Spot create fails for a non-capacity reason", async () => {
    const client = createMockGcpClient({
      createInstance: vi.fn(async () => {
        throw new GcpComputeApiError("permission denied", 403);
      }),
    });
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones: ["us-central1-a", "us-central1-b"],
      defaultImageFamily: "sandbox-image-family",
      useSpot: true,
    });

    await expect(provider.createSandbox(baseCreateConfig)).rejects.toThrow();
    expect(client.createInstance).toHaveBeenCalledTimes(1);
  });

  it("deletes only the VM on preserve stop and deletes both VM and disk on destroy stop", async () => {
    const client = createMockGcpClient({
      getInstance: vi.fn(async () => ({
        name: "ssess-123",
        status: "RUNNING",
        zone: "projects/test-project/zones/us-central1-a",
      })),
      getDisk: vi.fn(async () => ({
        name: "ssess-123",
        status: "READY",
        zone: "projects/test-project/zones/us-central1-a",
      })),
    });
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones: ["us-central1-a"],
      defaultImageFamily: "sandbox-image-family",
    });

    const preserveStop: StopConfig = {
      providerObjectId: "inst-1",
      sessionId: "sess-123",
      reason: "inactivity_timeout",
      intent: "preserve",
    };
    await provider.stopSandbox(preserveStop);
    expect(client.deleteInstance).toHaveBeenCalledTimes(1);
    expect(client.deleteDisk).not.toHaveBeenCalled();

    await provider.stopSandbox({ ...preserveStop, intent: "destroy" });
    expect(client.deleteInstance).toHaveBeenCalledTimes(2);
    expect(client.deleteDisk).toHaveBeenCalledWith(
      "us-central1-a",
      "ssess-123",
      undefined,
      undefined
    );
  });

  it("deletes the boot disk when a running session is archived, even with preserve intent", async () => {
    const client = createMockGcpClient({
      getInstance: vi.fn(async () => ({
        name: "ssess-123",
        status: "RUNNING",
        zone: "projects/test-project/zones/us-central1-a",
      })),
      getDisk: vi.fn(async () => ({
        name: "ssess-123",
        status: "READY",
        zone: "projects/test-project/zones/us-central1-a",
      })),
    });
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones: ["us-central1-a"],
      defaultImageFamily: "sandbox-image-family",
    });

    await provider.stopSandbox({
      providerObjectId: "inst-1",
      sessionId: "sess-123",
      reason: "session_archived",
      intent: "preserve",
    });

    expect(client.deleteInstance).toHaveBeenCalledTimes(1);
    expect(client.deleteDisk).toHaveBeenCalledWith(
      "us-central1-a",
      "ssess-123",
      undefined,
      undefined
    );
  });

  it("resumes by re-creating VM against kept boot disk or requests fresh spawn if disk is gone", async () => {
    const clientWithDisk = createMockGcpClient({
      getInstance: vi.fn(async () => null),
      getDisk: vi.fn(async () => ({
        name: "ssess-123",
        status: "READY",
        zone: "projects/test-project/zones/us-central1-b",
      })),
    });
    const provider1 = new GcpSandboxProvider(clientWithDisk, {
      project: "test-project",
      zones: ["us-central1-a", "us-central1-b"],
      defaultImageFamily: "sandbox-image-family",
    });

    const resumed = await provider1.resumeSandbox({
      providerObjectId: "old-inst",
      sessionId: "sess-123",
      sandboxId: "sbx-123",
    });
    expect(resumed.success).toBe(true);
    expect(clientWithDisk.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ssess-123",
        zone: "us-central1-b",
      }),
      undefined
    );

    const clientWithoutDisk = createMockGcpClient({
      getInstance: vi.fn(async () => null),
      getDisk: vi.fn(async () => null),
    });
    const provider2 = new GcpSandboxProvider(clientWithoutDisk, {
      project: "test-project",
      zones: ["us-central1-a"],
      defaultImageFamily: "sandbox-image-family",
    });

    const missing = await provider2.resumeSandbox({
      providerObjectId: "old-inst",
      sessionId: "sess-123",
      sandboxId: "sbx-123",
    });
    expect(missing).toEqual({
      success: false,
      error: 'Boot disk "ssess-123" no longer exists in GCP',
      shouldSpawnFresh: true,
    });
  });

  it("takes and restores disk snapshots when enabled", async () => {
    const client = createMockGcpClient({
      getDisk: vi.fn(async () => ({
        name: "ssess-123",
        status: "READY",
        zone: "projects/test-project/zones/us-central1-a",
      })),
    });
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones: ["us-central1-a"],
      defaultImageFamily: "sandbox-image-family",
      supportsSnapshots: true,
      supportsRestore: true,
    });

    const snap = await provider.takeSnapshot!({
      providerObjectId: "inst-1",
      sessionId: "sess-123",
      reason: "inactivity",
    });
    expect(snap.success).toBe(true);
    expect(snap.imageId).toMatch(/^sb-sess-123-snap-\d+$/);

    const restored = await provider.restoreFromSnapshot!({
      ...baseCreateConfig,
      snapshotImageId: snap.imageId!,
    });
    expect(restored.success).toBe(true);
    expect(client.createDisk).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSnapshot: snap.imageId,
      }),
      undefined
    );
  });
});

describe("gcpZoneForSession", () => {
  const zones = ["us-central1-a", "us-central1-b", "us-central1-c", "us-central1-f"];

  it("is stable for a session", () => {
    expect(gcpZoneForSession("sess-123", zones)).toBe(gcpZoneForSession("sess-123", zones));
  });

  it("spreads sessions across every zone", () => {
    const picked = new Set(
      Array.from({ length: 200 }, (_, i) => gcpZoneForSession(`session-${i}`, zones))
    );
    expect(picked).toEqual(new Set(zones));
  });

  it("returns the only zone when one is configured", () => {
    expect(gcpZoneForSession("anything", ["europe-west1-b"])).toBe("europe-west1-b");
  });

  it("rejects an empty zone list", () => {
    expect(() => gcpZoneForSession("sess-123", [])).toThrow();
  });
});

describe("GcpSandboxProvider disk retention purge", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW_MS = Date.parse("2026-11-12T00:00:00Z");
  const daysAgo = (days: number) => new Date(NOW_MS - days * DAY_MS).toISOString();

  const OWN_LABELS = { managed_by: "background-agents-gcp", deployment: "acme" };

  function disk(name: string, fields: Record<string, unknown>) {
    return {
      name,
      zone: "projects/test-project/zones/us-central1-a",
      labels: OWN_LABELS,
      ...fields,
    };
  }

  function createPurgeClient(disks: unknown[]): GcpComputeClient {
    return {
      project: "test-project",
      listDisks: vi.fn(async () => disks),
      deleteDisk: vi.fn(async () => undefined),
      getInstance: vi.fn(async () => null),
      createDisk: vi.fn(async (spec) => ({ name: spec.name, zone: spec.zone })),
      createInstance: vi.fn(async (spec) => ({
        name: spec.name,
        status: "RUNNING",
        zone: `projects/test-project/zones/${spec.zone}`,
      })),
    } as unknown as GcpComputeClient;
  }

  it("deletes only the two longest-unused detached disks past the cutoff", async () => {
    const client = createPurgeClient([
      disk("expired-30d", { creationTimestamp: daysAgo(30) }),
      disk("expired-20d", { creationTimestamp: daysAgo(40), lastDetachTimestamp: daysAgo(20) }),
      disk("expired-15d", { creationTimestamp: daysAgo(15) }),
      disk("old-but-recently-used", {
        creationTimestamp: daysAgo(60),
        lastDetachTimestamp: daysAgo(2),
      }),
      disk("attached", { creationTimestamp: daysAgo(90), users: ["instances/x"] }),
      disk("no-timestamps", {}),
      disk("excluded", { creationTimestamp: daysAgo(100) }),
    ]);
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones: ["us-central1-a"],
      deploymentName: "acme",
    });

    const deleted = await provider.purgeExpiredDisks("excluded", undefined, NOW_MS);

    expect(deleted).toEqual(["expired-30d", "expired-20d"]);
    expect(client.listDisks).toHaveBeenCalledWith(
      "us-central1-a",
      '(labels.managed_by = "background-agents-gcp") AND (labels.deployment = "acme")',
      undefined
    );
    expect(client.deleteDisk).toHaveBeenCalledTimes(2);
  });

  it("honors a custom retention and does nothing when retention is 0", async () => {
    const disks = [disk("ten-days", { creationTimestamp: daysAgo(10) })];

    const short = createPurgeClient(disks);
    await expect(
      new GcpSandboxProvider(short, {
        project: "test-project",
        zones: ["us-central1-a"],
        deploymentName: "acme",
        diskRetentionDays: 7,
      }).purgeExpiredDisks(undefined, undefined, NOW_MS)
    ).resolves.toEqual(["ten-days"]);

    const disabled = createPurgeClient(disks);
    await expect(
      new GcpSandboxProvider(disabled, {
        project: "test-project",
        zones: ["us-central1-a"],
        deploymentName: "acme",
        diskRetentionDays: 0,
      }).purgeExpiredDisks(undefined, undefined, NOW_MS)
    ).resolves.toEqual([]);
    expect(disabled.listDisks).not.toHaveBeenCalled();
  });

  it("never purges another deployment's disks or unlabeled legacy disks", async () => {
    const client = createPurgeClient([
      disk("other-deployment", {
        creationTimestamp: daysAgo(90),
        labels: { managed_by: "background-agents-gcp", deployment: "someone-else" },
      }),
      disk("legacy-no-deployment", {
        creationTimestamp: daysAgo(90),
        labels: { managed_by: "background-agents-gcp" },
      }),
      disk("not-managed", { creationTimestamp: daysAgo(90), labels: { deployment: "acme" } }),
      disk("own", { creationTimestamp: daysAgo(30) }),
    ]);
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones: ["us-central1-a"],
      deploymentName: "acme",
    });

    await expect(provider.purgeExpiredDisks(undefined, undefined, NOW_MS)).resolves.toEqual([
      "own",
    ]);
  });

  it("does not purge at all without a deployment name", async () => {
    const client = createPurgeClient([disk("own", { creationTimestamp: daysAgo(30) })]);
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones: ["us-central1-a"],
    });

    await expect(provider.purgeExpiredDisks(undefined, undefined, NOW_MS)).resolves.toEqual([]);
    expect(client.listDisks).not.toHaveBeenCalled();
  });

  it("labels new disks and VMs with the deployment", async () => {
    const client = createPurgeClient([]);
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones: ["us-central1-a"],
      defaultImageFamily: "sandbox-image-family",
      deploymentName: "acme",
    });

    await provider.createSandbox(baseCreateConfig);

    const deploymentLabel = expect.objectContaining({ deployment: "acme" });
    expect(client.createDisk).toHaveBeenCalledWith(
      expect.objectContaining({ labels: deploymentLabel }),
      undefined
    );
    expect(client.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ labels: deploymentLabel }),
      undefined
    );
  });

  it("rejects a negative retention", () => {
    expect(
      () =>
        new GcpSandboxProvider(createPurgeClient([]), {
          project: "test-project",
          zones: ["us-central1-a"],
          diskRetentionDays: -1,
        })
    ).toThrow("GCP_DISK_RETENTION_DAYS must be >= 0");
  });

  it("starts a purge after provisioning without waiting for it or failing on its errors", async () => {
    let releaseList!: () => void;
    const client = createPurgeClient([]);
    client.listDisks = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          releaseList = () => reject(new Error("list failed"));
        })
    );
    const provider = new GcpSandboxProvider(client, {
      project: "test-project",
      zones: ["us-central1-a"],
      defaultImageFamily: "sandbox-image-family",
      deploymentName: "acme",
    });

    const result = await provider.createSandbox(baseCreateConfig);

    expect(result.providerObjectId).toContain("ssess-123");
    expect(client.listDisks).toHaveBeenCalled();
    releaseList();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.deleteDisk).not.toHaveBeenCalled();
  });
});
