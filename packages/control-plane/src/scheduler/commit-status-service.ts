import {
  githubEventSupportsCommitStatus,
  type GitHubAutomationEvent,
} from "@open-inspect/shared/triggers";
import { z } from "zod";
import type { AutomationRow, AutomationRunRow, AutomationStore } from "../db/automation-store";
import type { Logger } from "../logger";
import { repositoryCredentialScope } from "../source-control/credential-scope";
import type { CommitStatusState, SourceControlProvider } from "../source-control/types";

/** Run states a later write never changes, apart from a timeout's late-success correction. */
const TERMINAL_RUN_STATUSES: ReadonlySet<AutomationRunRow["status"]> = new Set([
  "completed",
  "failed",
]);

/**
 * Re-read rounds after a post. A run reaches a terminal state once and is corrected
 * at most once more, so two rounds settle it; the third only absorbs a failed post.
 */
const MAX_RECONCILE_ROUNDS = 3;

/** GitHub caps a commit status description at 140 characters. */
const COMMIT_STATUS_DESCRIPTION_MAX_LENGTH = 140;

/**
 * Where a run reports its commit status, snapshotted on the invocation when it fires so
 * a later edit of the automation's context cannot strand a status it already posted.
 */
const commitStatusTargetSchema = z.object({
  repositoryId: z.number().int().positive(),
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  sha: z.string().min(1),
  context: z.string().min(1),
});
export type CommitStatusTarget = z.infer<typeof commitStatusTargetSchema>;

const commitStatusTriggerMetadataSchema = z.object({ commitStatus: commitStatusTargetSchema });

/**
 * Trigger metadata for a GitHub event firing that should report a commit status, or
 * null when the automation posts none or the event carries no head commit.
 */
export function buildCommitStatusTriggerMetadata(
  automation: Pick<AutomationRow, "commit_status_context" | "event_type">,
  event: Pick<GitHubAutomationEvent, "repositoryId" | "repoOwner" | "repoName" | "pullRequest">
): string | null {
  const context = automation.commit_status_context;
  const sha = event.pullRequest?.headSha;
  if (!context || !sha || !githubEventSupportsCommitStatus(automation.event_type)) return null;
  const target: CommitStatusTarget = {
    repositoryId: event.repositoryId,
    repoOwner: event.repoOwner,
    repoName: event.repoName,
    sha,
    context,
  };
  return JSON.stringify({ commitStatus: target });
}

export function parseCommitStatusTarget(metadata: string | null): CommitStatusTarget | null {
  if (!metadata) return null;
  try {
    const parsed = commitStatusTriggerMetadataSchema.safeParse(JSON.parse(metadata));
    return parsed.success ? parsed.data.commitStatus : null;
  } catch {
    return null;
  }
}

/** The status a run reports in its current state; null for states that report nothing. */
export function commitStatusForRun(
  run: Pick<AutomationRunRow, "status" | "failure_reason">
): { state: CommitStatusState; description: string } | null {
  switch (run.status) {
    case "starting":
    case "running":
    case "retrying":
      return { state: "pending", description: "Open-Inspect run in progress" };
    case "completed":
      return { state: "success", description: "Open-Inspect run completed" };
    case "failed": {
      const reason = run.failure_reason ? `: ${run.failure_reason}` : "";
      return {
        state: "failure",
        description: truncate(`Open-Inspect run failed${reason}`),
      };
    }
    default:
      // Skipped and unauthorized runs never ran on this commit.
      return null;
  }
}

function truncate(text: string): string {
  return text.length <= COMMIT_STATUS_DESCRIPTION_MAX_LENGTH
    ? text
    : `${text.slice(0, COMMIT_STATUS_DESCRIPTION_MAX_LENGTH - 1)}…`;
}

export interface AutomationCommitStatusServiceDeps {
  /** Resolved lazily: a deployment without a GitHub App never reaches it. */
  provider(): SourceControlProvider;
  store: Pick<AutomationStore, "getRunById">;
  /** Web app origin for the status link; the status carries no link without it. */
  webAppUrl?: string;
  log: Logger;
}

type PublishableRun = Pick<
  AutomationRunRow,
  "id" | "automation_id" | "session_id" | "status" | "failure_reason"
>;

/**
 * Commit statuses for PR-event automation runs. A run reports `pending` when it starts
 * and `success` or `failure` when it finishes, on the head commit its firing recorded.
 * Publishing is best effort and never throws.
 */
export class AutomationCommitStatusService {
  constructor(private readonly deps: AutomationCommitStatusServiceDeps) {}

  /**
   * Post the status for a run in the state given, under its firing's recorded target.
   * For a state the caller just wrote itself, such as the run-complete transition.
   * Returns the state posted, or null when nothing was posted.
   */
  async publish(
    run: PublishableRun,
    triggerMetadata: string | null | undefined
  ): Promise<CommitStatusState | null> {
    const target = parseCommitStatusTarget(triggerMetadata ?? null);
    if (!target) return null;
    const status = commitStatusForRun(run);
    if (!status) return null;
    try {
      const targetUrl = this.targetUrl(run.session_id);
      await this.deps.provider().createCommitStatus(
        {
          owner: target.repoOwner,
          name: target.repoName,
          sha: target.sha,
          context: target.context,
          state: status.state,
          description: status.description,
          ...(targetUrl ? { targetUrl } : {}),
        },
        repositoryCredentialScope([target.repositoryId])
      );
      return status.state;
    } catch (error) {
      this.deps.log.warn("Automation commit status post failed", {
        event: "scheduler.commit_status_failed",
        automation_id: run.automation_id,
        run_id: run.id,
        state: status.state,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return null;
    }
  }

  /**
   * Post a state the caller read or held in memory, then make sure it did not land
   * over a newer outcome. GitHub keeps the last status posted per context, so a
   * stale post that arrives after a newer one would stick. Every post here is
   * followed by a re-read of the run: if the run reached a different terminal state
   * before the re-read, that state is posted and re-read in turn; if it changes
   * after, the writer of that change posts later still. A run changes terminal
   * state at most once (a timeout's late-success correction), so this settles
   * within a few rounds. Never throws.
   */
  async publishAndReconcile(
    run: PublishableRun,
    triggerMetadata: string | null | undefined
  ): Promise<void> {
    if (!parseCommitStatusTarget(triggerMetadata ?? null)) return;
    let posted = await this.publish(run, triggerMetadata);
    let metadata = triggerMetadata;
    try {
      for (let round = 0; round < MAX_RECONCILE_ROUNDS; round++) {
        const current = await this.deps.store.getRunById(run.automation_id, run.id);
        if (!current || !TERMINAL_RUN_STATUSES.has(current.status)) return;
        if (commitStatusForRun(current)?.state === posted) return;
        metadata = current.invocation_trigger_metadata ?? metadata;
        posted = await this.publish(current, metadata);
      }
    } catch (error) {
      this.deps.log.warn("Automation commit status reconcile failed", {
        event: "scheduler.commit_status_failed",
        automation_id: run.automation_id,
        run_id: run.id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Re-read runs and post each one's current status. For callers that changed runs in
   * bulk without seeing the result, such as the recovery sweep: a run a callback
   * finished meanwhile reports its real outcome, not the sweep's.
   */
  async refresh(runs: ReadonlyArray<Pick<AutomationRunRow, "automation_id" | "id">>) {
    await Promise.all(
      runs.map(async ({ automation_id, id }) => {
        try {
          const run = await this.deps.store.getRunById(automation_id, id);
          if (run) await this.publishAndReconcile(run, run.invocation_trigger_metadata);
        } catch (error) {
          this.deps.log.warn("Automation commit status refresh failed", {
            event: "scheduler.commit_status_failed",
            automation_id,
            run_id: id,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      })
    );
  }

  private targetUrl(sessionId: string | null): string | undefined {
    if (!this.deps.webAppUrl || !sessionId) return undefined;
    return `${this.deps.webAppUrl.replace(/\/$/, "")}/session/${encodeURIComponent(sessionId)}`;
  }
}
