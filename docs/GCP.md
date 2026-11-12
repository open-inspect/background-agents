# GCP Sandbox Provider

Open-Inspect can run coding sessions on Google Compute Engine VMs. The control plane talks directly
to the Compute Engine REST API from Cloudflare Workers using a service account key; there is no
separate service to deploy for this provider.

## How It Works

- Each session gets a single persistent boot disk (`autoDelete: false`) named after the session ID,
  and a VM booted from it.
- **Stop** deletes the VM but keeps the boot disk. **Resume** starts the existing VM or creates a
  new VM attached to the kept disk. If the disk is gone, the session spawns fresh.
- **Destroy** deletes both the VM and the boot disk.
- **Archiving** a session whose sandbox is running deletes its boot disk too; unarchiving it later
  starts a fresh sandbox. A session archived while its sandbox is already stopped keeps its disk
  until the retention purge removes it.
- **Disk retention**: after each new sandbox is provisioned, a background task deletes up to two
  detached sandbox disks that have gone unused (no create, attach, or detach) for longer than
  `gcp_disk_retention_days` (14 days by default), oldest first. Set it to `0` to disable purging. A
  session whose disk was purged starts fresh. See
  [Multiple deployments in one project](#multiple-deployments-in-one-project) for which disks are
  eligible.
- Snapshots and restore use GCE disk snapshots and are off by default (see `gcp_supports_snapshots`
  and `gcp_supports_restore`).
- Each session is placed in one of `gcp_zones`, picked from a hash of the session ID, so sessions
  spread across zones and a session's disk and VM always share a zone. A resumed session stays in
  its disk's zone.
- With `gcp_use_spot = true`, the provider tries a Spot VM first and falls back to a standard VM in
  the same zone when Spot capacity is unavailable.

## Multiple Deployments in One Project

Several deployments can share a GCP project. Every VM, disk, and snapshot is labeled with
`managed_by=background-agents-gcp` and `deployment=<deployment_name>` (lowercased, with characters
other than letters, digits, and `-` replaced by `-`). Operator labels from `gcp_instance_labels`
cannot override these two.

The disk retention purge only deletes disks that are detached, in the configured zones, and carry
**both** labels with this deployment's name. Give each deployment sharing a project a distinct
`deployment_name`; two deployments whose names normalize to the same label value would purge each
other's disks.

Disks created before the `deployment` label was introduced have no deployment label, so their owner
can't be determined and the purge never deletes them. Remove them manually once they're no longer
needed:

```bash
gcloud compute disks list --project=PROJECT \
  --filter='labels.managed_by=background-agents-gcp AND -labels.deployment:* AND -users:*'
gcloud compute disks delete DISK_NAME --zone=ZONE --project=PROJECT
```

## Sandbox Image

Sandbox VMs boot from an image that has the shared sandbox toolchain and runtime installed.
[`packages/gcp-infra`](../packages/gcp-infra/README.md) builds it by installing the same bundle the
other providers use onto the public Ubuntu 24.04 image family
(`ubuntu-os-cloud/ubuntu-2404-lts-amd64`). The new image stays deprecated, so its family skips it,
until a VM booted from it passes the image verification.

**Built by Terraform (default).** With `gcp_build_image = true`, `terraform apply` builds a new
image whenever the runtime, the image package, or the builder changes, named
`open-inspect-sandbox-<hash>`, and pins the control plane to that exact image only after it is
verified. `gcloud` and `uv` must be installed where Terraform runs; GitHub-hosted runners have both.
Authenticate the build with `gcp_image_build_service_account_json`, or leave it empty to use
gcloud's existing credentials.

**Built by hand.** With `gcp_build_image = false`, build images yourself and the control plane boots
the newest one in `gcp_image_family` (default `open-inspect-sandbox`), so a new build applies to new
sessions without a deploy:

```bash
GCP_PROJECT=my-project npm run sandbox:images -- build --provider gcp
```

A VM booted from an image without the runtime stops at startup with a message pointing here, in the
VM's serial console output.

The build credentials need the same Compute Engine permissions as the control plane, plus
`compute.images.create`, `compute.images.deprecate`, and SSH access to the build VMs (instance
metadata SSH keys, or OS Login with `roles/compute.osAdminLogin`). Use a separate build service
account rather than the control plane's.

## Required Configuration

Set these in `terraform/environments/production/terraform.tfvars`:

```hcl
sandbox_provider = "gcp"

gcp_service_account_json     = "{...}"                       # control-plane service account key
gcp_project                  = "my-project"                  # where VMs and disks are created
gcp_vm_service_account_email = "sandbox-vm@my-project.iam.gserviceaccount.com" # identity of the VMs
```

## Service Accounts and IAM

The provider uses two separate service accounts:

1. **Control-plane service account** (`gcp_service_account_json`): the Cloudflare Worker uses its
   key to call the Compute Engine API. It creates and deletes the VMs and disks.
2. **VM service account** (`gcp_vm_service_account_email`): the identity attached to each sandbox
   VM, with the `cloud-platform` scope. Code in the sandbox gets credentials for it from the
   metadata server, for example to call Vertex AI. If this is unset, **VMs run with no service
   account**: the Compute Engine API does not fall back to the project's default Compute Engine
   service account the way the Console and `gcloud` do.

Use a dedicated VM service account with only the roles the sandbox needs. Sandboxes run untrusted,
agent-written code, so anything this account can do, the agent can do.

### Control-plane service account permissions

The simplest setup uses predefined roles:

| Role                             | Granted on                         | Why                                                                      |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `roles/compute.instanceAdmin.v1` | `gcp_project`                      | Create, start, delete VMs; create, attach, delete disks; set metadata    |
| `roles/iam.serviceAccountUser`   | the VM service account (only)      | Attach the VM service account to instances (`iam.serviceAccounts.actAs`) |
| `roles/compute.imageUser`        | `gcp_image_project`, if different  | Boot disks from images in another project                                |
| `roles/compute.networkUser`      | the subnet, if on a Shared VPC     | Place VMs on a subnet in a host project                                  |
| `roles/compute.storageAdmin`     | `gcp_project`, if snapshots are on | Create and delete disk snapshots                                         |

Grant `roles/iam.serviceAccountUser` on the VM service account itself, not on the project. Granting
it project-wide lets the control plane attach any service account in the project to a VM.

For a custom role, these are the permissions the provider uses:

```text
# Instances
compute.instances.create
compute.instances.get
compute.instances.start
compute.instances.delete
compute.instances.setMetadata
compute.instances.setLabels
compute.instances.setServiceAccount   # when gcp_vm_service_account_email is set

# Disks
compute.disks.create
compute.disks.get
compute.disks.list                    # disk retention purge
compute.disks.delete
compute.disks.use
compute.disks.setLabels

# Images and machine types
compute.images.useReadOnly
compute.images.getFromFamily
compute.machineTypes.get
compute.diskTypes.get

# Networking
compute.subnetworks.use
compute.networks.use                  # when using a network without an explicit subnet

# Operations
compute.zoneOperations.get
compute.globalOperations.get          # snapshots only

# Snapshots (only when gcp_supports_snapshots / gcp_supports_restore are true)
compute.disks.createSnapshot
compute.snapshots.create
compute.snapshots.delete
compute.snapshots.setLabels
compute.snapshots.useReadOnly

# On the VM service account
iam.serviceAccounts.actAs
```

### VM service account permissions

Grant only what the sandbox needs. For Vertex AI models, that is `roles/aiplatform.user` on
`gcp_vertex_project`. Add nothing else by default.

## Networking

VMs are created **without an external IP address**. They still need outbound access to the control
plane, GitHub, package registries, and model APIs, so the chosen network or subnet must have
[Cloud NAT](https://cloud.google.com/nat/docs/overview) or another egress path. On the `default`
network without Cloud NAT, VMs boot but never connect, and the launch fails at the connect watchdog.

## All Deployment Settings

Every setting below applies only when `sandbox_provider = "gcp"`. Terraform variables map to the
control-plane Worker environment variables shown.

| Terraform variable                              | Env var                        | Required | Default                 | Purpose                                                                     |
| ----------------------------------------------- | ------------------------------ | -------- | ----------------------- | --------------------------------------------------------------------------- |
| `gcp_service_account_json` (secret)             | `GCP_SERVICE_ACCOUNT_JSON`     | yes      | —                       | Service account JSON key used to call the Compute Engine API                |
| `gcp_project`                                   | `GCP_PROJECT`                  | yes\*    | key's project           | Project where sandbox VMs and disks are created                             |
| `gcp_zones`                                     | `GCP_ZONES`                    | no       | `us-central1-{a,b,c,f}` | Comma-separated zones; each session is placed in one, by session ID hash    |
| `gcp_image_family`                              | `GCP_IMAGE_FAMILY`             | no       | `open-inspect-sandbox`  | Default image family or image when a repo doesn't set its own               |
| `gcp_image_project`                             | `GCP_IMAGE_PROJECT`            | no       | `gcp_project`           | Project that hosts the sandbox images                                       |
| `gcp_machine_type`                              | `GCP_MACHINE_TYPE`             | no       | `e2-standard-4`         | VM machine type                                                             |
| `gcp_boot_disk_size_gb`                         | `GCP_BOOT_DISK_SIZE_GB`        | no       | `80`                    | Boot disk size in GB                                                        |
| `gcp_boot_disk_type`                            | `GCP_BOOT_DISK_TYPE`           | no       | `pd-balanced`           | Boot disk type                                                              |
| `gcp_network`                                   | `GCP_NETWORK`                  | no       | —                       | VPC network name or self-link                                               |
| `gcp_subnet`                                    | `GCP_SUBNET`                   | no       | —                       | Subnetwork name or self-link                                                |
| `gcp_vm_service_account_email`                  | `GCP_VM_SERVICE_ACCOUNT_EMAIL` | no       | —                       | Service account attached to sandbox VMs; unset means **no** service account |
| `gcp_instance_labels`                           | `GCP_INSTANCE_LABELS`          | no       | —                       | `key=value,key=value` labels applied to VMs and disks                       |
| `gcp_vertex_project`                            | `GCP_VERTEX_PROJECT`           | no       | `gcp_project`           | Vertex AI project, passed to the VM in instance metadata                    |
| `gcp_vertex_location`                           | `GCP_VERTEX_LOCATION`          | no       | `global`                | Vertex AI location, passed to the VM in instance metadata                   |
| `gcp_use_spot`                                  | `GCP_USE_SPOT`                 | no       | `false`                 | Try a Spot VM first; fall back to standard in the same zone                 |
| `gcp_include_startup_script`                    | `GCP_INCLUDE_STARTUP_SCRIPT`   | no       | `true`                  | Inject the sandbox runtime startup script into instance metadata            |
| `gcp_supports_snapshots`                        | `GCP_SUPPORTS_SNAPSHOTS`       | no       | `false`                 | Enable GCE disk snapshots                                                   |
| `gcp_supports_restore`                          | `GCP_SUPPORTS_RESTORE`         | no       | `false`                 | Enable restoring sandboxes from disk snapshots                              |
| `gcp_disk_retention_days`                       | `GCP_DISK_RETENTION_DAYS`      | no       | `14`                    | Days a detached disk may go unused before it is purged; `0` disables        |
| `gcp_build_image`                               | `GCP_IMAGE_FAMILY` (pinned)    | no       | `true`                  | Build and verify the image with Terraform and pin the control plane to it   |
| `gcp_image_build_service_account_json` (secret) | —                              | no       | gcloud's credentials    | Credentials for the image build                                             |
| `gcp_image_build_use_iap`                       | —                              | no       | `false`                 | Build VMs get no external IP; SSH through IAP                               |
| —                                               | `GCP_COMPUTE_API_BASE_URL`     | no       | Google's API            | Overrides the Compute Engine API base URL; for tests only                   |

\* Terraform requires `gcp_project`. When running the control plane outside Terraform, an unset
`GCP_PROJECT` falls back to the service account key's `project_id`.

For GitHub Actions deploys, `.github/workflows/terraform.yml` reads each setting from a repository
variable or secret of the same name in upper case (for example `GCP_ZONES`).
`GCP_SERVICE_ACCOUNT_JSON` must be a secret.

## Per-Repository Settings

These are set in the web UI under the repository's Sandbox settings (or through the integration
settings API):

- **Image family** (`imageFamily`): GCP only. Overrides `gcp_image_family` for that repository. Must
  be a non-empty string with no whitespace; clearing it falls back to the deployment default.
- **Session timeout**: supported.
- CPU and memory overrides and resource limits are **not** supported. Machine size is set
  deployment-wide by `gcp_machine_type`.

### Image Resolution Order

For a fresh sandbox, the boot image is the first of these that is set:

1. The repository's `imageFamily` sandbox setting
2. A `REPO_IMAGE` repository secret (legacy override, treated as an image rather than a family)
3. A prebuilt image ID, if one exists for the repository
4. `gcp_image_family`, or the `open-inspect-sandbox` family if unset
