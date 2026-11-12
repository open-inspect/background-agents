/**
 * GCE instance metadata and startup-script assembly for GCP sandbox VMs.
 *
 * Session configuration reaches the VM as instance metadata attributes. VMs
 * boot from an image built by packages/gcp-infra, which installs the shared
 * sandbox toolchain and runtime (packages/sandbox-images) on public Ubuntu and
 * bakes in the launcher and systemd unit below. The startup-script installs
 * the launcher and unit if the image lacks them, fails clearly if the image
 * has no runtime, and ensures sandbox-runtime.service is started
 * (non-blocking).
 */

import type { CreateSandboxConfig, RestoreConfig, ResumeConfig } from "../../provider";
import { toRepositoryConfigPayload } from "../../sandbox-env";

export const DEFAULT_GCP_VERTEX_LOCATION = "global";

/** Interpreter the shared image installer provides; the runtime is installed into it. */
export const GCP_SANDBOX_RUNTIME_PYTHON = "/opt/openinspect/python/bin/python";

export interface GcpBootMetadataConfig {
  vertexProject: string;
  vertexLocation: string;
}

/**
 * The runtime launcher script installed at /usr/local/bin/oi-sandbox-runtime.
 */
export const GCP_SANDBOX_RUNTIME_START_SCRIPT = `#!/bin/bash

# Starts the background-agents sandbox runtime (the python bridge:
# \`python -m sandbox_runtime.entrypoint\`) with the env contract it expects,
# translated from the GCE instance metadata.

set -euo pipefail

META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
# Kept on the boot disk, which survives stop/resume; /tmp does not survive a reboot.
STATE=/var/lib/oi
install -d -m 0700 "\${STATE}/metadata" "\${STATE}/state"

function meta() {
  local value
  value="$(curl -sf --retry 5 --retry-connrefused -H "Metadata-Flavor: Google" "\${META}/$1" || true)"
  if [ -n "$value" ]; then
    printf '%s' "$value" > "\${STATE}/metadata/$1"
    printf '%s' "$value"
  elif [ -f "\${STATE}/metadata/$1" ]; then
    cat "\${STATE}/metadata/$1"
  fi
}

live_session_id="$(curl -sf --retry 5 --retry-connrefused -H "Metadata-Flavor: Google" "\${META}/session_id" || true)"
if [ -n "$live_session_id" ] && [ "$live_session_id" != "$(cat "\${STATE}/metadata/session_id" 2>/dev/null)" ]; then
  rm -f "\${STATE}/metadata/"*
fi

user_env_vars_raw="$(meta user_env_vars)"
if [ -n "$user_env_vars_raw" ]; then
  while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "skipping invalid user env var name: \${key}" >&2
      continue
    fi
    export "\${key}=\${value}"
  done < <(jq -j 'to_entries[] | .key, "\\u0000", (.value | tostring), "\\u0000"' <<< "$user_env_vars_raw")
fi

SANDBOX_ID="$(meta sandbox_id)"
CONTROL_PLANE_URL="$(meta control_plane_url)"
SANDBOX_AUTH_TOKEN="$(meta sandbox_auth_token)"
session_id="$(meta session_id)"
for required in SANDBOX_ID CONTROL_PLANE_URL SANDBOX_AUTH_TOKEN session_id; do
  if [ -z "\${!required}" ]; then
    echo "missing required instance metadata for \${required}" >&2
    exit 1
  fi
done
export SANDBOX_ID CONTROL_PLANE_URL SANDBOX_AUTH_TOKEN
export REPO_OWNER="$(meta repo_owner)"
export REPO_NAME="$(meta repo_name)"
if [ "$(meta agent_slack_notify_enabled)" = "true" ]; then
  export AGENT_SLACK_NOTIFY_ENABLED=true
fi

timeout_seconds="$(meta timeout_seconds)"
if [ -n "$timeout_seconds" ]; then
  export SANDBOX_TIMEOUT_SECONDS="$timeout_seconds"
fi

repositories="$(meta repositories)"
mcp_servers="$(meta mcp_servers)"
SESSION_CONFIG="$(jq -cn \\
  --arg session_id "$session_id" \\
  --arg branch "$(meta branch)" \\
  --arg harness "$(meta harness)" \\
  --arg provider "$(meta provider)" \\
  --arg model "$(meta model)" \\
  --argjson repositories "\${repositories:-[]}" \\
  --argjson mcp_servers "\${mcp_servers:-[]}" \\
  '(if $provider != "" then $provider else "google-vertex-anthropic" end) as $provider
   | {session_id: $session_id, provider: $provider, bridge_early_connect: true}
   + (if $harness != "" then {harness: $harness} else {} end)
   + (if $model == "" then {}
      elif $harness == "claude" and ($model | contains("/") | not) then {model: "\\($provider)/\\($model)"}
      else {model: $model} end)
   + (if $branch != "" then {branch: $branch} else {} end)
   + (if ($repositories | length) > 0 then {repositories: $repositories} else {} end)
   + (if ($mcp_servers | length) > 0 then {mcp_servers: $mcp_servers} else {} end)')"
export SESSION_CONFIG

sandbox_settings="$(meta sandbox_settings)"
EXPECTED_TUNNEL_PORTS="$(jq -r '.tunnel_ports // [] | map(tostring) | join(",")' <<< "\${sandbox_settings:-null}")"
export EXPECTED_TUNNEL_PORTS

vertex_project="$(meta vertex_project)"
if [ -z "$vertex_project" ]; then
  vertex_project="$(curl -sf --retry 5 --retry-connrefused -H "Metadata-Flavor: Google" \\
    "http://metadata.google.internal/computeMetadata/v1/project/project-id" || true)"
fi
if [ -z "$vertex_project" ]; then
  echo "missing project-id in project metadata" >&2
  exit 1
fi
vertex_location="$(meta vertex_location)"
vertex_location="\${vertex_location:-global}"
export GOOGLE_CLOUD_PROJECT="$vertex_project" GOOGLE_CLOUD_LOCATION="$vertex_location" VERTEX_LOCATION="$vertex_location"
export CLAUDE_CODE_USE_VERTEX=1 CLOUD_ML_REGION="$vertex_location" ANTHROPIC_VERTEX_PROJECT_ID="$vertex_project"

# The runtime writes the boot-complete marker once a boot has synced the checkout,
# run setup.sh and started the harness; a later boot of this disk then keeps the
# checkout and skips setup.sh. An interrupted first boot leaves no marker.
export OPENINSPECT_STATE_DIR="\${STATE}/state"
export OI_BOOT_COMPLETE_MARKER="\${STATE}/boot-complete"
if [ -n "$(meta snapshot_image_id)" ] || [ -e "$OI_BOOT_COMPLETE_MARKER" ]; then
  export RESTORED_FROM_SNAPSHOT=true
fi

cd /workspace
exec ${GCP_SANDBOX_RUNTIME_PYTHON} -m sandbox_runtime.entrypoint
`;

export const GCP_SANDBOX_RUNTIME_SERVICE_UNIT = `[Unit]
Description=background-agents sandbox runtime (runs opencode + connects to the control plane)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=/root
ExecStart=/usr/local/bin/oi-sandbox-runtime
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

/**
 * GCE startup-script that provisions the runtime systemd unit if not already
 * baked into the image and ensures the service is running.
 */
export function buildGcpStartupScript(): string {
  return `#!/bin/bash
set -euo pipefail

if [ ! -x ${GCP_SANDBOX_RUNTIME_PYTHON} ]; then
  echo "openinspect: ${GCP_SANDBOX_RUNTIME_PYTHON} not found; boot an image built by packages/gcp-infra (see docs/GCP.md)" >&2
  exit 1
fi

if [ ! -x /usr/local/bin/oi-sandbox-runtime ]; then
  cat << 'OI_RUNTIME_EOF' > /usr/local/bin/oi-sandbox-runtime
${GCP_SANDBOX_RUNTIME_START_SCRIPT}OI_RUNTIME_EOF
  chmod 0755 /usr/local/bin/oi-sandbox-runtime
fi

if [ ! -f /etc/systemd/system/sandbox-runtime.service ]; then
  cat << 'OI_SERVICE_EOF' > /etc/systemd/system/sandbox-runtime.service
${GCP_SANDBOX_RUNTIME_SERVICE_UNIT}OI_SERVICE_EOF
  chmod 0644 /etc/systemd/system/sandbox-runtime.service
  systemctl daemon-reload
  systemctl enable sandbox-runtime.service
fi

if ! systemctl is-active --quiet sandbox-runtime.service; then
  systemctl start --no-block sandbox-runtime.service
fi
`;
}

function pruneEmpty(metadata: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value.trim() !== "") {
      result[key] = value;
    }
  }
  return result;
}

function putJsonIfNotEmpty(metadata: Record<string, string>, key: string, value: unknown): void {
  if (value == null) return;
  if (Array.isArray(value) && value.length === 0) return;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
    return;
  }
  metadata[key] = JSON.stringify(value);
}

function serializeSandboxSettings(
  config: CreateSandboxConfig | RestoreConfig
): Record<string, unknown> | null {
  const tunnelPorts = config.sandboxSettings?.tunnelPorts;
  if (!tunnelPorts || tunnelPorts.length === 0) {
    return null;
  }
  return { tunnel_ports: tunnelPorts };
}

export function buildGcpCreateMetadata(
  config: CreateSandboxConfig,
  bootConfig: GcpBootMetadataConfig,
  includeStartupScript = false
): Record<string, string> {
  const metadata: Record<string, string> = {
    session_id: config.sessionId,
    sandbox_id: config.sandboxId,
    control_plane_url: config.controlPlaneUrl,
    sandbox_auth_token: config.sandboxAuthToken,
    repo_owner: config.repoOwner ?? "",
    repo_name: config.repoName ?? "",
    branch: config.branch ?? "",
    agent_session_id: config.agentSessionId ?? "",
    harness: config.harness ?? "",
    provider: config.provider ?? "",
    model: config.model ?? "",
    code_server_enabled: String(config.codeServerEnabled ?? false),
    vertex_project: bootConfig.vertexProject,
    vertex_location: bootConfig.vertexLocation,
  };

  if (config.timeoutSeconds !== undefined && config.timeoutSeconds > 0) {
    metadata.timeout_seconds = String(config.timeoutSeconds);
  }

  if (config.repositories && config.repositories.length > 0) {
    putJsonIfNotEmpty(metadata, "repositories", config.repositories.map(toRepositoryConfigPayload));
  }
  putJsonIfNotEmpty(metadata, "user_env_vars", config.userEnvVars);
  putJsonIfNotEmpty(metadata, "mcp_servers", config.mcpServers);
  putJsonIfNotEmpty(metadata, "sandbox_settings", serializeSandboxSettings(config));

  if (config.agentSlackNotifyEnabled) {
    metadata.agent_slack_notify_enabled = "true";
  }
  if (includeStartupScript) {
    metadata["startup-script"] = buildGcpStartupScript();
  }

  return pruneEmpty(metadata);
}

export function buildGcpRestoreMetadata(
  config: RestoreConfig,
  bootConfig: GcpBootMetadataConfig,
  includeStartupScript = false
): Record<string, string> {
  const metadata: Record<string, string> = {
    session_id: config.sessionId,
    sandbox_id: config.sandboxId,
    control_plane_url: config.controlPlaneUrl,
    sandbox_auth_token: config.sandboxAuthToken,
    repo_owner: config.repoOwner ?? "",
    repo_name: config.repoName ?? "",
    branch: config.branch ?? "",
    harness: config.harness ?? "",
    provider: config.provider ?? "",
    model: config.model ?? "",
    snapshot_image_id: config.snapshotImageId,
    code_server_enabled: String(config.codeServerEnabled ?? false),
    vertex_project: bootConfig.vertexProject,
    vertex_location: bootConfig.vertexLocation,
  };

  if (config.timeoutSeconds !== undefined && config.timeoutSeconds > 0) {
    metadata.timeout_seconds = String(config.timeoutSeconds);
  }

  if (config.repositories && config.repositories.length > 0) {
    putJsonIfNotEmpty(metadata, "repositories", config.repositories.map(toRepositoryConfigPayload));
  }
  putJsonIfNotEmpty(metadata, "user_env_vars", config.userEnvVars);
  putJsonIfNotEmpty(metadata, "mcp_servers", config.mcpServers);
  putJsonIfNotEmpty(metadata, "sandbox_settings", serializeSandboxSettings(config));

  if (config.agentSlackNotifyEnabled) {
    metadata.agent_slack_notify_enabled = "true";
  }
  if (includeStartupScript) {
    metadata["startup-script"] = buildGcpStartupScript();
  }

  return pruneEmpty(metadata);
}

export function buildGcpResumeMetadata(
  config: ResumeConfig,
  bootConfig: GcpBootMetadataConfig,
  includeStartupScript = false
): Record<string, string> {
  const metadata: Record<string, string> = {
    session_id: config.sessionId,
    sandbox_id: config.sandboxId,
    vertex_project: bootConfig.vertexProject,
    vertex_location: bootConfig.vertexLocation,
  };
  if (includeStartupScript) {
    metadata["startup-script"] = buildGcpStartupScript();
  }
  return pruneEmpty(metadata);
}
