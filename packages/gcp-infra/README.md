# OpenInspect GCE Image Tooling

Builds the Compute Engine image that GCP sandbox VMs boot from. The control plane talks to the
Compute Engine API directly at runtime; this package only builds images.

## What's here

- **[Shared image package](../sandbox-images/README.md)**: owns the substrate, dependency pins,
  frozen installation bundle, runtime wheel, and verification.
- **`build-image.py`**: stages the shared bundle and creates a throwaway build VM from the public
  Ubuntu image family in `targets.json` (`ubuntu-os-cloud/ubuntu-2404-lts-amd64`). It copies the
  bundle over, runs the shared installer as root, removes build inputs and per-instance identity
  (cloud-init state, machine ID), and saves the boot disk as an image in the configured family. A
  second VM then boots from that image and runs the image verification. Both VMs are deleted,
  including on failure.

The image holds the toolchain and runtime only. Each session VM's startup-script, sent as instance
metadata by the control plane, installs the runtime launcher and systemd unit and starts the runtime
with that session's configuration.

## Requirements

- `gcloud`, authenticated to an account or service account that can create and delete VMs and images
  in the project and SSH into them (OS Login or project SSH keys).
- With `GCP_BUILD_USE_IAP=true`, the VMs get no external IP and SSH goes through IAP, which needs a
  firewall rule allowing TCP 22 from `35.235.240.0/20` and `roles/iap.tunnelResourceAccessor`.
  Without it, the build VMs get an ephemeral external IP for SSH.
- Outbound internet access from the VMs (an external IP, or Cloud NAT with IAP).

## Build

```bash
GCP_PROJECT=my-project npm run sandbox:images -- build --provider gcp
# Output is {"reference":"projects/my-project/global/images/open-inspect-sandbox-<hash>-<time>"}.
```

| Variable                 | Default                | Purpose                                        |
| ------------------------ | ---------------------- | ---------------------------------------------- |
| `GCP_PROJECT`            | required               | Project the VMs and the image are created in   |
| `GCP_ZONE`               | `us-central1-a`        | Zone of the build and verification VMs         |
| `GCP_IMAGE_FAMILY`       | `open-inspect-sandbox` | Family the image is added to                   |
| `GCP_BUILD_MACHINE_TYPE` | `e2-standard-4`        | Machine type of the build and verification VMs |
| `GCP_BOOT_DISK_SIZE_GB`  | `80`                   | Boot disk size; session disks can't be smaller |
| `GCP_NETWORK`            | default network        | VPC network for the VMs                        |
| `GCP_SUBNET`             | —                      | Subnetwork for the VMs                         |
| `GCP_BUILD_USE_IAP`      | `false`                | No external IP; SSH through IAP                |

The control plane boots the newest image in `gcp_image_family`, which defaults to
`open-inspect-sandbox`, so a new build takes effect for new sessions without a deploy. Roll back by
deprecating the bad image (`gcloud compute images deprecate IMAGE --state=DEPRECATED`); the family
then resolves to the previous image. A retry with the same `OPENINSPECT_IMAGE_CANDIDATE` re-verifies
the existing image instead of rebuilding it.
