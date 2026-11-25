import { describe, expect, it, vi } from "vitest";
import type { EnrichedRunRow } from "../db/automation-store";
import { createLogger } from "../logger";
import type { SourceControlProvider } from "../source-control/types";
import {
  AutomationCommitStatusService,
  buildCommitStatusTriggerMetadata,
  commitStatusForRun,
  parseCommitStatusTarget,
} from "./commit-status-service";

const log = createLogger("commit-status-test", {}, "error");

const prEvent = {
  repositoryId: 7,
  repoOwner: "acme",
  repoName: "web",
  pullRequest: { number: 42, headSha: "abc123" },
};

const run: EnrichedRunRow = {
  id: "run-1",
  automation_id: "auto-1",
  invocation_id: "inv-1",
  session_id: "sess-1",
  status: "running",
  skip_reason: null,
  failure_reason: null,
  scheduled_at: 0,
  started_at: 0,
  completed_at: null,
  execution_deadline_at: null,
  created_at: 0,
  repo_owner: "acme",
  repo_name: "web",
  repo_id: 7,
  base_branch: null,
  environment_id: null,
  first_prompt_pending: 0,
  session_title: null,
  artifact_summary: null,
};

const metadata = buildCommitStatusTriggerMetadata(
  { commit_status_context: "open-inspect", event_type: "pull_request.synchronize" },
  prEvent
);

function harness(
  { webAppUrl }: { webAppUrl?: string } = { webAppUrl: "https://inspect.example.com/" }
) {
  const createCommitStatus = vi
    .fn<SourceControlProvider["createCommitStatus"]>()
    .mockResolvedValue(undefined);
  const getRunById =
    vi.fn<(automationId: string, runId: string) => Promise<EnrichedRunRow | null>>();
  const service = new AutomationCommitStatusService({
    provider: () => ({ createCommitStatus }) as unknown as SourceControlProvider,
    store: { getRunById },
    webAppUrl,
    log,
  });
  return { service, createCommitStatus, getRunById };
}

describe("buildCommitStatusTriggerMetadata", () => {
  it("records the head commit and context for a reporting PR event", () => {
    expect(parseCommitStatusTarget(metadata)).toEqual({
      repositoryId: 7,
      repoOwner: "acme",
      repoName: "web",
      sha: "abc123",
      context: "open-inspect",
    });
  });

  it.each([
    ["no context", { commit_status_context: null, event_type: "pull_request.opened" }, prEvent],
    [
      "an event without a head commit to gate",
      { commit_status_context: "open-inspect", event_type: "pull_request.closed" },
      prEvent,
    ],
    [
      "a payload without a head SHA",
      { commit_status_context: "open-inspect", event_type: "pull_request.opened" },
      { ...prEvent, pullRequest: { number: 42 } },
    ],
  ])("records nothing for %s", (_label, automation, event) => {
    expect(buildCommitStatusTriggerMetadata(automation, event)).toBeNull();
  });

  it("ignores metadata written for another purpose", () => {
    expect(parseCommitStatusTarget(JSON.stringify({ channel: "C1", messageTs: "1.2" }))).toBeNull();
    expect(parseCommitStatusTarget("not json")).toBeNull();
  });
});

describe("commitStatusForRun", () => {
  it.each([
    ["starting", "pending"],
    ["running", "pending"],
    ["retrying", "pending"],
    ["completed", "success"],
    ["failed", "failure"],
  ] as const)("reports a %s run as %s", (status, state) => {
    expect(commitStatusForRun({ status, failure_reason: null })?.state).toBe(state);
  });

  it.each(["skipped", "unauthorized"] as const)("reports nothing for a %s run", (status) => {
    expect(commitStatusForRun({ status, failure_reason: null })).toBeNull();
  });

  it("fits a long failure reason in GitHub's description limit", () => {
    const status = commitStatusForRun({ status: "failed", failure_reason: "x".repeat(500) });
    expect(status?.description.length).toBe(140);
  });
});

describe("AutomationCommitStatusService", () => {
  it("posts the run's state on the recorded head commit, scoped to that repository", async () => {
    const { service, createCommitStatus } = harness();

    await service.publish({ ...run, status: "completed" }, metadata);

    expect(createCommitStatus).toHaveBeenCalledExactlyOnceWith(
      {
        owner: "acme",
        name: "web",
        sha: "abc123",
        context: "open-inspect",
        state: "success",
        description: "Open-Inspect run completed",
        targetUrl: "https://inspect.example.com/session/sess-1",
      },
      { kind: "repositories", repositoryIds: [7] }
    );
  });

  it("omits the link when the web app URL is not configured", async () => {
    const { service, createCommitStatus } = harness({});

    await service.publish(run, metadata);

    expect(createCommitStatus.mock.calls[0]![0]).not.toHaveProperty("targetUrl");
  });

  it("posts nothing for a firing that recorded no target", async () => {
    const { service, createCommitStatus } = harness();

    await service.publish(run, null);

    expect(createCommitStatus).not.toHaveBeenCalled();
  });

  it("never throws when GitHub refuses the status", async () => {
    const { service, createCommitStatus } = harness();
    createCommitStatus.mockRejectedValue(new Error("403 Resource not accessible"));

    await expect(service.publish(run, metadata)).resolves.toBeNull();
  });

  it("refreshes from the stored run, so a run a callback finished reports its real outcome", async () => {
    const { service, createCommitStatus, getRunById } = harness();
    getRunById.mockResolvedValue({
      ...run,
      status: "completed",
      invocation_trigger_metadata: metadata,
    });

    await service.refresh([{ automation_id: "auto-1", id: "run-1" }]);

    expect(getRunById).toHaveBeenCalledWith("auto-1", "run-1");
    expect(createCommitStatus).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: "success" }),
      expect.anything()
    );
  });

  it("re-posts the finished outcome when a run completed while pending was in flight", async () => {
    const { service, createCommitStatus, getRunById } = harness();
    getRunById.mockResolvedValue({
      ...run,
      status: "completed",
      invocation_trigger_metadata: metadata,
    });

    await service.publishAndReconcile({ ...run, status: "running" }, metadata);

    expect(createCommitStatus.mock.calls.map(([status]) => status.state)).toEqual([
      "pending",
      "success",
    ]);
  });

  it("posts once when the run is still in progress after the post", async () => {
    const { service, createCommitStatus, getRunById } = harness();
    getRunById.mockResolvedValue({ ...run, invocation_trigger_metadata: metadata });

    await service.publishAndReconcile(run, metadata);

    expect(createCommitStatus).toHaveBeenCalledOnce();
  });

  it("reads nothing for a firing without a target", async () => {
    const { service, getRunById } = harness();

    await service.publishAndReconcile(run, null);

    expect(getRunById).not.toHaveBeenCalled();
  });

  it("keeps refreshing the other runs when one read fails", async () => {
    const { service, createCommitStatus, getRunById } = harness();
    getRunById
      .mockRejectedValueOnce(new Error("D1 unavailable"))
      .mockResolvedValueOnce({ ...run, status: "failed", invocation_trigger_metadata: metadata });

    await expect(
      service.refresh([
        { automation_id: "auto-1", id: "run-0" },
        { automation_id: "auto-1", id: "run-1" },
      ])
    ).resolves.toBeUndefined();

    expect(createCommitStatus).toHaveBeenCalledOnce();
  });
});
