/**
 * Naming, labeling, and resource URL conventions for GCP Compute Engine sandboxes.
 *
 * Mirrors the conventions from background_agents_gcp_sandbox/gcp/naming.go.
 */

export const GCP_LABEL_MANAGED_BY = "managed_by";
export const GCP_LABEL_SANDBOX_ID = "sandbox_id";
export const GCP_LABEL_SESSION_ID = "session_id";
export const GCP_LABEL_PROVISIONED = "provisioned";

export const GCP_MANAGED_BY_VALUE = "background-agents-gcp";

const MAX_GCE_NAME_LENGTH = 63;
const NAME_SANITIZER = /[^a-z0-9-]+/g;

function sanitize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(NAME_SANITIZER, "-")
    .replace(/^-+|-+$/g, "");
}

function clamp(value: string): string {
  return value.length <= MAX_GCE_NAME_LENGTH ? value : value.slice(0, MAX_GCE_NAME_LENGTH);
}

function labelSafe(value: string): string {
  return clamp(sanitize(value));
}

/**
 * Shared GCE resource name for a sandbox's instance and boot disk.
 * Keyed on the sanitized session ID so any lifecycle op can locate both from
 * the session ID alone. GCE names must start with a lowercase letter and be <= 63 chars.
 */
export function gcpSandboxName(sessionId: string): string {
  return clamp(`s${sanitize(sessionId)}`).replace(/-+$/g, "");
}

/**
 * Snapshot name for a sandbox at a point in time.
 */
export function gcpSnapshotName(sessionId: string, nowEpochSeconds: number): string {
  return clamp(`sb-${sanitize(sessionId)}-snap-${nowEpochSeconds}`);
}

/**
 * Standard label set for a sandbox's GCE resources.
 */
export function gcpSandboxLabels(
  sandboxId: string,
  sessionId: string,
  provisioning: string,
  extra?: Record<string, string>
): Record<string, string> {
  return {
    [GCP_LABEL_MANAGED_BY]: GCP_MANAGED_BY_VALUE,
    [GCP_LABEL_SANDBOX_ID]: labelSafe(sandboxId),
    [GCP_LABEL_SESSION_ID]: labelSafe(sessionId),
    [GCP_LABEL_PROVISIONED]: labelSafe(provisioning),
    ...extra,
  };
}

export function gcpMachineTypeUrl(zone: string, machineType: string): string {
  return `zones/${zone}/machineTypes/${machineType}`;
}

export function gcpDiskTypeUrl(zone: string, diskType: string): string {
  return `zones/${zone}/diskTypes/${diskType}`;
}

export function gcpSnapshotSourceUrl(project: string, snapshot: string): string {
  return `projects/${project}/global/snapshots/${snapshot}`;
}

export function gcpDiskSelfLink(project: string, zone: string, disk: string): string {
  return `projects/${project}/zones/${zone}/disks/${disk}`;
}

/**
 * Normalizes an image reference or image family into a partial resource URL
 * suitable for Disk.sourceImage.
 *
 * - Already-qualified references ("https://...", "projects/.../images/...",
 *   "global/images/...") are returned as-is.
 * - "family/<name>" is expanded into "projects/<imageProject>/global/images/family/<name>".
 * - A bare name is resolved in `<imageProject>` (defaulting to `<project>`):
 *   when `treatBareAsFamily` is true (default for image family settings), it resolves
 *   to `projects/<imageProject>/global/images/family/<name>`; otherwise to
 *   `projects/<imageProject>/global/images/<name>`.
 */
export function gcpImageSourceUrl(
  project: string,
  imageOrFamily: string,
  options: { imageProject?: string; treatBareAsFamily?: boolean } = {}
): string {
  const trimmed = imageOrFamily.trim();
  if (!trimmed) return "";

  const targetProject = options.imageProject?.trim() || project;
  if (trimmed.startsWith("family/")) {
    return `projects/${targetProject}/global/images/${trimmed}`;
  }
  if (trimmed.includes("/")) {
    return trimmed;
  }
  if (options.treatBareAsFamily) {
    return `projects/${targetProject}/global/images/family/${trimmed}`;
  }
  return `projects/${targetProject}/global/images/${trimmed}`;
}

/**
 * Extracts the trailing zone name from a GCE zone URL or self-link.
 */
export function extractGcpZone(zoneLink: string | undefined): string {
  if (!zoneLink) return "";
  const parts = zoneLink.split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * Zone for a new sandbox's boot disk and VM, chosen from `zones` by an FNV-1a
 * hash of the session ID. Spreads sessions across zones while keeping the
 * choice stable for a session, so a retried create targets the same zone as
 * any disk an earlier attempt left behind.
 */
export function gcpZoneForSession(sessionId: string, zones: readonly string[]): string {
  if (zones.length === 0) {
    throw new Error("gcpZoneForSession requires at least one zone");
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return zones[(hash >>> 0) % zones.length];
}
