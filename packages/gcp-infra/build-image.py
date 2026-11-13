#!/usr/bin/env python3
"""Build and verify a GCE sandbox image from the provider-neutral image bundle.

A throwaway build VM boots from a public Ubuntu image family, the shared
installation bundle is copied to it and installed, the launcher and systemd
unit the control plane expects are left to the session's startup-script, and
the VM's boot disk is saved as an image in the configured image family. The
image is marked DEPRECATED, which a family lookup skips, until a second VM
boots from it and passes the image verification exactly as a session VM will;
only then is it made ACTIVE, so sessions following the family never boot an
unverified image. Every VM this build creates is deleted, including on
failure; a failed image stays DEPRECATED for investigation.

Drives the `gcloud` CLI, which owns authentication (user credentials, a
service account, or workload identity) and SSH key setup.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/sandbox-images/src"))

from sandbox_images.bundle import pack_bundle  # noqa: E402
from sandbox_images.native import write_build_result  # noqa: E402

PROVIDER = "gcp"
DEFAULT_ZONE = "us-central1-a"
DEFAULT_IMAGE_FAMILY = "open-inspect-sandbox"
DEFAULT_BUILD_MACHINE_TYPE = "e2-standard-4"
DEFAULT_BOOT_DISK_SIZE_GB = 80
MANAGED_BY_LABEL = "managed_by=background-agents-gcp"

BUNDLE_UPLOAD_PATH = "/tmp/openinspect-image.tar.gz"
BUNDLE_EXTRACT_DIR = "/tmp/openinspect-image"
INSTALL_SCRIPT = f"{BUNDLE_EXTRACT_DIR}/packages/sandbox-images/install/install.sh"
APT_CONFIG_PATH = "/tmp/openinspect-apt.conf"
APT_LOCK_TIMEOUT_SECONDS = 600
VERIFY_COMMAND = "sudo /opt/openinspect/python/bin/python /app/verify/smoke_test.py verify"

IMAGE_NAME_PATTERN = re.compile(r"^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$")
SSH_READY_TIMEOUT_SECONDS = 5 * 60
SSH_RETRY_SECONDS = 10


def gcloud(*args: str, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess:
    command = ["gcloud", *args, "--quiet"]
    return subprocess.run(command, check=check, text=True, capture_output=capture)


class Builder:
    def __init__(self) -> None:
        self.project = required_env("GCP_PROJECT")
        self.zone = os.environ.get("GCP_ZONE") or DEFAULT_ZONE
        self.family = os.environ.get("GCP_IMAGE_FAMILY") or DEFAULT_IMAGE_FAMILY
        self.machine_type = os.environ.get("GCP_BUILD_MACHINE_TYPE") or DEFAULT_BUILD_MACHINE_TYPE
        self.disk_size_gb = int(
            os.environ.get("GCP_BOOT_DISK_SIZE_GB") or DEFAULT_BOOT_DISK_SIZE_GB
        )
        self.network = os.environ.get("GCP_NETWORK") or ""
        self.subnet = os.environ.get("GCP_SUBNET") or ""
        self.use_iap = (os.environ.get("GCP_BUILD_USE_IAP") or "").lower() in ("1", "true")
        self.ssh_flags = ["--tunnel-through-iap"] if self.use_iap else []

    def scope(self) -> list[str]:
        return [f"--project={self.project}"]

    def zonal(self) -> list[str]:
        return [*self.scope(), f"--zone={self.zone}"]

    def image_status(self, name: str) -> str | None:
        result = gcloud(
            "compute",
            "images",
            "describe",
            name,
            *self.scope(),
            "--format=value(status)",
            capture=True,
            check=False,
        )
        return result.stdout.strip() or None if result.returncode == 0 else None

    def create_vm(self, name: str, image_args: list[str]) -> None:
        network = []
        if self.network:
            network.append(f"--network={self.network}")
        if self.subnet:
            network.append(f"--subnet={self.subnet}")
        gcloud(
            "compute",
            "instances",
            "create",
            name,
            *self.zonal(),
            f"--machine-type={self.machine_type}",
            *image_args,
            f"--boot-disk-size={self.disk_size_gb}GB",
            "--boot-disk-type=pd-balanced",
            # Build VMs need no identity; without this gcloud attaches the
            # project's default Compute Engine account, which usually holds Editor.
            "--no-service-account",
            "--no-scopes",
            f"--labels={MANAGED_BY_LABEL},purpose=image-build",
            *network,
            *(["--no-address"] if self.use_iap else []),
        )

    def delete_vm(self, name: str) -> None:
        gcloud(
            "compute", "instances", "delete", name, *self.zonal(), "--delete-disks=all", check=False
        )

    def ssh(self, name: str, command: str) -> None:
        gcloud("compute", "ssh", name, *self.zonal(), *self.ssh_flags, f"--command={command}")

    def wait_for_ssh(self, name: str) -> None:
        deadline = time.monotonic() + SSH_READY_TIMEOUT_SECONDS
        while True:
            result = gcloud(
                "compute",
                "ssh",
                name,
                *self.zonal(),
                *self.ssh_flags,
                "--command=true",
                capture=True,
                check=False,
            )
            if result.returncode == 0:
                return
            if time.monotonic() >= deadline:
                raise RuntimeError(f"SSH to {name} not ready: {result.stderr[-2000:]}")
            time.sleep(SSH_RETRY_SECONDS)

    def build(self, name: str, bundle_directory: Path) -> None:
        base_project, base_family = base_image()
        vm = f"{name[:50]}-build"
        print(f"GCE image build VM {vm} from {base_project}/{base_family}", flush=True)
        self.create_vm(vm, [f"--image-family={base_family}", f"--image-project={base_project}"])
        try:
            self.wait_for_ssh(vm)
            with tempfile.TemporaryDirectory(prefix="openinspect-gcp-") as directory:
                archive = Path(directory) / "bundle.tar.gz"
                with tarfile.open(archive, "w:gz") as tar:
                    tar.add(bundle_directory, arcname=".", recursive=True)
                gcloud(
                    "compute",
                    "scp",
                    str(archive),
                    f"{vm}:{BUNDLE_UPLOAD_PATH}",
                    *self.zonal(),
                    *self.ssh_flags,
                )
            self.ssh(vm, prepare_command())
            self.ssh(vm, install_command())
            self.ssh(vm, cleanup_command())
            gcloud("compute", "instances", "stop", vm, *self.zonal())
            gcloud(
                "compute",
                "images",
                "create",
                name,
                *self.scope(),
                f"--source-disk={vm}",
                f"--source-disk-zone={self.zone}",
                f"--family={self.family}",
                f"--labels={MANAGED_BY_LABEL}",
                "--guest-os-features=UEFI_COMPATIBLE,VIRTIO_SCSI_MULTIQUEUE,GVNIC",
            )
            # Hide it from family lookups until verification passes.
            self.set_image_state(name, "DEPRECATED")
        finally:
            self.delete_vm(vm)

    def set_image_state(self, name: str, state: str) -> None:
        gcloud("compute", "images", "deprecate", name, *self.scope(), f"--state={state}")

    def verify(self, name: str) -> None:
        vm = f"{name[:49]}-verify"
        print(f"GCE image verification VM {vm}", flush=True)
        self.create_vm(vm, [f"--image={name}", f"--image-project={self.project}"])
        try:
            self.wait_for_ssh(vm)
            self.ssh(vm, VERIFY_COMMAND)
        finally:
            self.delete_vm(vm)


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def base_image() -> tuple[str, str]:
    """The public base image family from targets.json, as (project, family)."""
    targets = json.loads((ROOT / "packages/sandbox-images/targets.json").read_text())
    project, _, family = targets[PROVIDER]["base"].partition("/")
    if not project or not family:
        raise RuntimeError("targets.json gcp.base must be <image-project>/<image-family>")
    return project, family


def prepare_command() -> str:
    """Unpack the bundle once cloud-init has finished with apt."""
    return " && ".join(
        [
            "sudo cloud-init status --wait >/dev/null || true",
            f"mkdir -p {BUNDLE_EXTRACT_DIR}",
            f"tar -xzf {shlex.quote(BUNDLE_UPLOAD_PATH)} -C {BUNDLE_EXTRACT_DIR}",
            f"printf 'DPkg::Lock::Timeout \"{APT_LOCK_TIMEOUT_SECONDS}\";\\n' > {APT_CONFIG_PATH}",
        ]
    )


def install_command() -> str:
    """Run the shared installer as root with the apt lock wait applied."""
    return f"sudo env APT_CONFIG={APT_CONFIG_PATH} bash {INSTALL_SCRIPT}"


def cleanup_command() -> str:
    """Remove build inputs and per-instance identity so the image boots fresh."""
    return " && ".join(
        [
            f"rm -rf {BUNDLE_EXTRACT_DIR} {APT_CONFIG_PATH} {shlex.quote(BUNDLE_UPLOAD_PATH)}",
            # Never bake session state: a VM from this image is a fresh boot.
            "sudo rm -rf /var/lib/oi /root/.npm /root/.cache",
            "sudo apt-get clean",
            "sudo cloud-init clean --logs",
            "sudo truncate -s 0 /etc/machine-id",
        ]
    )


def candidate_name(family: str, build_hash: str) -> str:
    name = (
        os.environ.get("OPENINSPECT_IMAGE_CANDIDATE")
        or f"{family[:30]}-{build_hash[:12]}-{time.time_ns() // 1_000_000_000}"
    )
    if not IMAGE_NAME_PATTERN.fullmatch(name):
        raise RuntimeError(
            f"GCE image name {name!r} must be 1-63 lowercase letters, digits or dashes, "
            "starting with a letter; shorten GCP_IMAGE_FAMILY"
        )
    return name


def main() -> None:
    builder = Builder()
    bundle = pack_bundle(ROOT, PROVIDER, ROOT / ".cache/sandbox-images")
    name = candidate_name(builder.family, bundle.plan["buildHash"])

    status = builder.image_status(name)
    if status is None:
        builder.build(name, bundle.directory)
    elif status == "READY":
        # A retry re-verifies the retained artifact instead of rebuilding it.
        print(f"GCE image {name} already exists; verifying it", flush=True)
    else:
        raise RuntimeError(f"GCE image {name} exists with status {status!r}; delete it first")
    builder.verify(name)
    builder.set_image_state(name, "ACTIVE")
    write_build_result(f"projects/{builder.project}/global/images/{name}")


if __name__ == "__main__":
    main()
