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
- Snapshots and restore use GCE disk snapshots and are off by default (see `gcp_supports_snapshots`
  and `gcp_supports_restore`).
- Each session is placed in one of `gcp_zones`, picked from a hash of the session ID, so sessions
  spread across zones and a session's disk and VM always share a zone. A resumed session stays in
  its disk's zone.
- With `gcp_use_spot = true`, the provider tries a Spot VM first and falls back to a standard VM in
  the same zone when Spot capacity is unavailable.

## Required Configuration

Set these in `terraform/environments/production/terraform.tfvars`:

```hcl
sandbox_provider = "gcp"

gcp_service_account_json     = "{...}"                       # control-plane service account key
gcp_project                  = "my-project"                  # where VMs and disks are created
gcp_image_family             = "my-sandbox-image-family"     # default image (or set per repo)
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

| Terraform variable                  | Env var                        | Required | Default                 | Purpose                                                                     |
| ----------------------------------- | ------------------------------ | -------- | ----------------------- | --------------------------------------------------------------------------- |
| `gcp_service_account_json` (secret) | `GCP_SERVICE_ACCOUNT_JSON`     | yes      | —                       | Service account JSON key used to call the Compute Engine API                |
| `gcp_project`                       | `GCP_PROJECT`                  | yes\*    | key's project           | Project where sandbox VMs and disks are created                             |
| `gcp_zones`                         | `GCP_ZONES`                    | no       | `us-central1-{a,b,c,f}` | Comma-separated zones; each session is placed in one, by session ID hash    |
| `gcp_image_family`                  | `GCP_IMAGE_FAMILY`             | no       | —                       | Default image family or image when a repo doesn't set its own               |
| `gcp_image_project`                 | `GCP_IMAGE_PROJECT`            | no       | `gcp_project`           | Project that hosts the sandbox images                                       |
| `gcp_machine_type`                  | `GCP_MACHINE_TYPE`             | no       | `e2-standard-4`         | VM machine type                                                             |
| `gcp_boot_disk_size_gb`             | `GCP_BOOT_DISK_SIZE_GB`        | no       | `80`                    | Boot disk size in GB                                                        |
| `gcp_boot_disk_type`                | `GCP_BOOT_DISK_TYPE`           | no       | `pd-balanced`           | Boot disk type                                                              |
| `gcp_network`                       | `GCP_NETWORK`                  | no       | —                       | VPC network name or self-link                                               |
| `gcp_subnet`                        | `GCP_SUBNET`                   | no       | —                       | Subnetwork name or self-link                                                |
| `gcp_vm_service_account_email`      | `GCP_VM_SERVICE_ACCOUNT_EMAIL` | no       | —                       | Service account attached to sandbox VMs; unset means **no** service account |
| `gcp_instance_labels`               | `GCP_INSTANCE_LABELS`          | no       | —                       | `key=value,key=value` labels applied to VMs and disks                       |
| `gcp_vertex_project`                | `GCP_VERTEX_PROJECT`           | no       | `gcp_project`           | Vertex AI project, passed to the VM in instance metadata                    |
| `gcp_vertex_location`               | `GCP_VERTEX_LOCATION`          | no       | `global`                | Vertex AI location, passed to the VM in instance metadata                   |
| `gcp_use_spot`                      | `GCP_USE_SPOT`                 | no       | `false`                 | Try a Spot VM first; fall back to standard in the same zone                 |
| `gcp_include_startup_script`        | `GCP_INCLUDE_STARTUP_SCRIPT`   | no       | `true`                  | Inject the sandbox runtime startup script into instance metadata            |
| `gcp_supports_snapshots`            | `GCP_SUPPORTS_SNAPSHOTS`       | no       | `false`                 | Enable GCE disk snapshots                                                   |
| `gcp_supports_restore`              | `GCP_SUPPORTS_RESTORE`         | no       | `false`                 | Enable restoring sandboxes from disk snapshots                              |
| —                                   | `GCP_COMPUTE_API_BASE_URL`     | no       | Google's API            | Overrides the Compute Engine API base URL; for tests only                   |

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
4. `gcp_image_family`
