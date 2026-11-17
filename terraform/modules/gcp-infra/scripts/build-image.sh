#!/usr/bin/env bash
# Build and verify the GCP sandbox image with packages/gcp-infra/build-image.py.
set -euo pipefail

for required in GCP_PROJECT GCP_ZONE OPENINSPECT_IMAGE_CANDIDATE DEPLOY_PATH; do
  if [[ -z "${!required:-}" ]]; then
    echo "Error: ${required} environment variable is not set" >&2
    exit 1
  fi
done
if ! command -v gcloud >/dev/null; then
  echo "Error: gcloud is required to build the GCP sandbox image" >&2
  exit 1
fi

# Authenticate gcloud with the build service account for this run only, without
# touching the operator's gcloud configuration.
if [[ -n "${GCP_BUILD_SERVICE_ACCOUNT_JSON:-}" ]]; then
  credentials_dir="$(mktemp -d)"
  trap 'rm -rf "$credentials_dir"' EXIT
  umask 077
  printf '%s' "$GCP_BUILD_SERVICE_ACCOUNT_JSON" > "$credentials_dir/key.json"
  export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="$credentials_dir/key.json"
  export CLOUDSDK_CONFIG="$credentials_dir/gcloud"
fi
unset GCP_BUILD_SERVICE_ACCOUNT_JSON

echo "Building GCP sandbox image ${OPENINSPECT_IMAGE_CANDIDATE} in ${GCP_PROJECT}"
cd "${DEPLOY_PATH}"
uv run --frozen python build-image.py
echo "GCP sandbox image ${OPENINSPECT_IMAGE_CANDIDATE} built and verified"
