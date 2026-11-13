import { afterEach, describe, expect, it, vi } from "vitest";
import { GcpComputeApiError, GcpComputeClient } from "./client";

const BASE = "https://compute.test/compute/v1";

function createClient() {
  return new GcpComputeClient({
    project: "test-proj",
    apiBaseUrl: BASE,
    tokenProvider: { getAccessToken: async () => "token" },
  });
}

function respond(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn(
    async () => responses.shift() ?? respond(200, { name: "op", status: "DONE" })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestOf(fetchMock: ReturnType<typeof stubFetch>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
  return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GcpComputeClient image and stop operations", () => {
  it("submits an image from a disk without waiting for it", async () => {
    const fetchMock = stubFetch(respond(200, { name: "op-1", status: "RUNNING" }));

    await createClient().requestCreateImage({
      name: "oi-img-x",
      sourceDisk: "projects/test-proj/zones/us-central1-a/disks/oi-build-x",
      labels: { deployment: "acme" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestOf(fetchMock)).toEqual({
      url: `${BASE}/projects/test-proj/global/images`,
      method: "POST",
      body: {
        name: "oi-img-x",
        sourceDisk: "projects/test-proj/zones/us-central1-a/disks/oi-build-x",
        labels: { deployment: "acme" },
      },
    });
  });

  it("reports an existing image name as a 409", async () => {
    stubFetch(respond(409, { error: { message: "already exists" } }));
    await expect(
      createClient().requestCreateImage({ name: "oi-img-x", sourceDisk: "d" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("reads an image, and null when there is none", async () => {
    stubFetch(respond(200, { name: "oi-img-x", status: "READY", sourceDisk: "d" }), respond(404));
    const client = createClient();

    await expect(client.getImage("oi-img-x")).resolves.toMatchObject({ status: "READY" });
    await expect(client.getImage("oi-img-x")).resolves.toBeNull();
  });

  it("deletes an image, one already gone counting as deleted", async () => {
    const fetchMock = stubFetch(respond(200, { name: "op", status: "RUNNING" }), respond(404));
    const client = createClient();

    await client.deleteImage("oi-img-x");
    await client.deleteImage("oi-img-x");

    expect(requestOf(fetchMock)).toMatchObject({
      url: `${BASE}/projects/test-proj/global/images/oi-img-x`,
      method: "DELETE",
    });
  });

  it("asks a VM to stop without waiting", async () => {
    const fetchMock = stubFetch(respond(200, { name: "op", status: "RUNNING" }));
    await createClient().requestStopInstance("us-central1-a", "oi-build-x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestOf(fetchMock)).toMatchObject({
      url: `${BASE}/projects/test-proj/zones/us-central1-a/instances/oi-build-x/stop`,
      method: "POST",
    });
  });

  it("bounds a VM's run time with a stop that keeps its disk", async () => {
    const fetchMock = stubFetch(
      respond(200, { name: "op", status: "DONE" }),
      respond(200, { name: "oi-build-x", status: "RUNNING" })
    );

    await createClient().createInstance({
      name: "oi-build-x",
      zone: "us-central1-a",
      machineType: "e2-standard-4",
      bootDiskSelfLink: "projects/test-proj/zones/us-central1-a/disks/oi-build-x",
      maxRunDurationSeconds: 3600,
    });

    expect(requestOf(fetchMock).body.scheduling).toEqual({
      maxRunDuration: { seconds: "3600" },
      instanceTerminationAction: "STOP",
    });
  });

  it("sends no scheduling for an unbounded standard VM", async () => {
    const fetchMock = stubFetch(
      respond(200, { name: "op", status: "DONE" }),
      respond(200, { name: "vm", status: "RUNNING" })
    );
    await createClient().createInstance({
      name: "vm",
      zone: "us-central1-a",
      machineType: "e2-standard-4",
      bootDiskSelfLink: "d",
    });
    expect(requestOf(fetchMock).body.scheduling).toBeUndefined();
  });

  it("is a GcpComputeApiError for other failures", async () => {
    stubFetch(respond(403, { error: { message: "denied" } }));
    await expect(createClient().getImage("oi-img-x")).rejects.toBeInstanceOf(GcpComputeApiError);
  });
});
