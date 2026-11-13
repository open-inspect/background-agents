#!/usr/bin/env bash
# One-time setup of a GCP project dedicated to one Open-Inspect deployment.
#
# Idempotent: every step checks before it creates, so re-running it is safe
# and only fills in what is missing. It never deletes anything.
#
# What it sets up (see docs/GCP.md):
#   - Compute Engine, IAM, Cloud DNS, Logging and Vertex AI APIs
#   - the network: a new custom-mode VPC and subnet (default), or the
#     project's existing "default" network (--network default)
#   - Private Google Access on the subnet, so VMs reach Google APIs (Vertex
#     AI) without external IPs
#   - a Cloud Router and Cloud NAT per region, with NAT logging, for VM egress:
#     sandbox VMs get no external IP and reach the control plane, GitHub and
#     package registries through NAT
#   - Cloud DNS query logging on the network
#   - firewall: deny traffic between VMs in the network (sandboxes run
#     untrusted code), allow SSH from IAP (for image builds)
#   - service accounts: the control plane's (creates VMs, disks and images),
#     the sandbox VMs' identity (Vertex AI only), and an image builder's
#
# Usage:
#   packages/gcp-infra/setup-project.sh --project my-project [options]
#
# Options:
#   --project ID          GCP project (required); expected to be dedicated
#   --regions LIST        Comma-separated regions for NAT (default: us-central1)
#   --network NAME        "default" uses the existing default network; any other
#                         name creates a custom-mode VPC (default: open-inspect)
#   --subnet-range CIDR   Subnet range for a created VPC (default: 10.20.0.0/20,
#                         one subnet per region, each the next /20)
#   --prefix NAME         Prefix for created resources (default: open-inspect)
#   --create-keys DIR     Write JSON keys for the control-plane and image-build
#                         service accounts to DIR (blocked by some org policies)
set -euo pipefail

PROJECT=""
REGIONS="us-central1"
NETWORK="open-inspect"
SUBNET_RANGE="10.20.0.0/20"
PREFIX="open-inspect"
KEY_DIR=""

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

while (( $# )); do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --regions) REGIONS="$2"; shift 2 ;;
    --network) NETWORK="$2"; shift 2 ;;
    --subnet-range) SUBNET_RANGE="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --create-keys) KEY_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,37p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ -n "$PROJECT" ]] || die "--project is required"
command -v gcloud >/dev/null || die "gcloud is required"
[[ "$PREFIX" =~ ^[a-z][-a-z0-9]{0,20}$ ]] || die "--prefix must be 1-21 lowercase letters, digits or dashes"

g() { gcloud --project="$PROJECT" --quiet "$@"; }
exists() { g "$@" >/dev/null 2>&1; }

IFS=',' read -r -a REGION_LIST <<< "${REGIONS// /}"
CONTROL_PLANE_SA="${PREFIX}-control-plane@${PROJECT}.iam.gserviceaccount.com"
VM_SA="${PREFIX}-sandbox-vm@${PROJECT}.iam.gserviceaccount.com"
BUILD_SA="${PREFIX}-image-build@${PROJECT}.iam.gserviceaccount.com"

step "Enabling APIs"
g services enable compute.googleapis.com iam.googleapis.com dns.googleapis.com \
  logging.googleapis.com aiplatform.googleapis.com iap.googleapis.com

step "Network: ${NETWORK}"
if [[ "$NETWORK" == "default" ]]; then
  exists compute networks describe default || die "project has no default network; omit --network to create one"
else
  exists compute networks describe "$NETWORK" ||
    g compute networks create "$NETWORK" --subnet-mode=custom --bgp-routing-mode=regional
fi

# The ranges VMs live in, for the VM-to-VM deny rule.
VM_RANGES=()
base_ip="${SUBNET_RANGE%/*}"
IFS='.' read -r o1 o2 o3 o4 <<< "$base_ip"
for i in "${!REGION_LIST[@]}"; do
  region="${REGION_LIST[$i]}"
  if [[ "$NETWORK" == "default" ]]; then
    subnet="default"
    exists compute networks subnets describe default --region="$region" ||
      die "default network has no subnet in ${region}"
  else
    subnet="${NETWORK}-${region}"
    # Each region gets the next /20 after --subnet-range.
    range="${o1}.${o2}.$(( o3 + i * 16 )).${o4}/20"
    exists compute networks subnets describe "$subnet" --region="$region" ||
      g compute networks subnets create "$subnet" --network="$NETWORK" --region="$region" \
        --range="$range" --enable-flow-logs --logging-aggregation-interval=interval-5-sec \
        --logging-flow-sampling=0.5 --logging-metadata=include-all
  fi
  echo "Private Google Access on ${subnet} (${region})"
  g compute networks subnets update "$subnet" --region="$region" --enable-private-ip-google-access
  VM_RANGES+=("$(g compute networks subnets describe "$subnet" --region="$region" --format='value(ipCidrRange)')")

  step "Cloud NAT in ${region}"
  router="${PREFIX}-nat-${region}"
  exists compute routers describe "$router" --region="$region" ||
    g compute routers create "$router" --network="$NETWORK" --region="$region"
  exists compute routers nats describe "$router" --router="$router" --region="$region" ||
    g compute routers nats create "$router" --router="$router" --region="$region" \
      --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges \
      --enable-dynamic-port-allocation --min-ports-per-vm=256 --max-ports-per-vm=65536 \
      --enable-logging --log-filter=ALL
done

step "DNS query logging"
dns_policy="${PREFIX}-dns-logging"
exists dns policies describe "$dns_policy" ||
  g dns policies create "$dns_policy" --networks="$NETWORK" --enable-logging \
    --description="Log DNS queries from Open-Inspect sandbox VMs"

step "Firewall"
ranges_csv="$(IFS=,; echo "${VM_RANGES[*]}")"
exists compute firewall-rules describe "${PREFIX}-deny-vm-to-vm" ||
  g compute firewall-rules create "${PREFIX}-deny-vm-to-vm" --network="$NETWORK" \
    --direction=INGRESS --priority=1000 --action=DENY --rules=all --source-ranges="$ranges_csv" \
    --description="Sandbox VMs run untrusted code; block traffic between them"
exists compute firewall-rules describe "${PREFIX}-allow-iap-ssh" ||
  g compute firewall-rules create "${PREFIX}-allow-iap-ssh" --network="$NETWORK" \
    --direction=INGRESS --priority=900 --action=ALLOW --rules=tcp:22 \
    --source-ranges=35.235.240.0/20 --description="SSH from IAP, for image builds"

step "Service accounts"
ensure_sa() {
  local account="$1" name="${1%%@*}" display="$2"
  exists iam service-accounts describe "$account" ||
    g iam service-accounts create "$name" --display-name="$display"
}
grant_project() {
  local member="$1"; shift
  for role in "$@"; do
    g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${member}" \
      --role="$role" --condition=None >/dev/null
    echo "  ${member%%@*}: ${role}"
  done
}
ensure_sa "$CONTROL_PLANE_SA" "Open-Inspect control plane"
ensure_sa "$VM_SA" "Open-Inspect sandbox VMs"
ensure_sa "$BUILD_SA" "Open-Inspect image build"

# The sandbox VMs' identity: agent code can use it, so Vertex AI and log
# writing only. Never give it the control plane's roles.
grant_project "$VM_SA" roles/aiplatform.user roles/logging.logWriter
# The control plane creates, starts and deletes VMs and disks, and creates and
# deletes snapshots and prebuilt images.
grant_project "$CONTROL_PLANE_SA" roles/compute.instanceAdmin.v1 roles/compute.storageAdmin
# The image builder creates VMs and images and SSHes in, through IAP.
grant_project "$BUILD_SA" roles/compute.instanceAdmin.v1 roles/compute.storageAdmin \
  roles/iap.tunnelResourceAccessor
# Only the control plane attaches a service account, and only the VM one:
# scoped to that account, so it can't attach any other (such as the default
# Compute Engine account, which usually holds Editor).
g iam service-accounts add-iam-policy-binding "$VM_SA" \
  --member="serviceAccount:${CONTROL_PLANE_SA}" --role=roles/iam.serviceAccountUser >/dev/null
echo "  ${CONTROL_PLANE_SA%%@*}: roles/iam.serviceAccountUser on ${VM_SA%%@*} only"

if [[ -n "$KEY_DIR" ]]; then
  step "Service account keys"
  mkdir -p "$KEY_DIR"
  for account in "$CONTROL_PLANE_SA" "$BUILD_SA"; do
    key="${KEY_DIR}/${account%%@*}.json"
    if [[ -e "$key" ]]; then
      echo "  ${key} exists; not creating another key"
    else
      (umask 077; g iam service-accounts keys create "$key" --iam-account="$account")
    fi
  done
fi

zones=""
for region in "${REGION_LIST[@]}"; do
  zones+="${zones:+,}$(g compute zones list --filter="region:${region} AND status:UP" \
    --format='value(name)' | sort | tr '\n' ',' | sed 's/,$//')"
done

step "Done. Terraform settings for this project:"
cat <<EOF
sandbox_provider             = "gcp"
gcp_project                  = "${PROJECT}"
gcp_zones                    = "${zones}"
gcp_network                  = "${NETWORK}"
gcp_vm_service_account_email = "${VM_SA}"
gcp_image_build_use_iap      = true
# Secrets: the JSON keys of ${CONTROL_PLANE_SA}
# (gcp_service_account_json) and ${BUILD_SA}
# (gcp_image_build_service_account_json)$( [[ -n "$KEY_DIR" ]] && echo ", written to ${KEY_DIR}" ).
EOF
