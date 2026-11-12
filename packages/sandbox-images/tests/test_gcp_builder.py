"""The GCE image builder: build, verify, reuse and cleanup through a fake gcloud."""

import runpy
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[3]
BUILDER = ROOT / "packages/gcp-infra/build-image.py"


class FakeGcloud:
    def __init__(self, image_status=None, fail_on=None):
        self.calls = []
        self.image_status = image_status
        self.fail_on = fail_on

    def __call__(self, *args, capture=False, check=True):
        self.calls.append(args)
        returncode, stdout = 0, ""
        if args[:3] == ("compute", "images", "describe"):
            returncode = 0 if self.image_status else 1
            stdout = self.image_status or ""
        if self.fail_on and any(self.fail_on in str(arg) for arg in args):
            if check:
                raise subprocess.CalledProcessError(1, ["gcloud", *args])
            returncode = 1
        return subprocess.CompletedProcess(["gcloud", *args], returncode, stdout, "")

    def commands(self, *prefix):
        return [call for call in self.calls if call[: len(prefix)] == prefix]


@pytest.fixture
def builder(monkeypatch, tmp_path):
    def load(gcloud):
        # run_path returns a copy; patch the globals the builder's functions actually use.
        namespace = runpy.run_path(str(BUILDER))["main"].__globals__
        bundle = tmp_path / "bundle"
        bundle.mkdir(exist_ok=True)
        (bundle / "image-config.sh").write_text("OI_OS=debian\n")
        results = []
        namespace["gcloud"] = gcloud
        namespace["pack_bundle"] = lambda *_: SimpleNamespace(
            directory=bundle, plan={"buildHash": "abcdef0123456789"}
        )
        namespace["write_build_result"] = results.append
        monkeypatch.setattr(namespace["time"], "sleep", lambda _: None)
        monkeypatch.setenv("GCP_PROJECT", "test-proj")
        monkeypatch.setenv("OPENINSPECT_IMAGE_CANDIDATE", "open-inspect-sandbox-abc-1")
        return namespace, results

    return load


def test_builds_from_public_ubuntu_saves_to_the_family_and_verifies(builder):
    gcloud = FakeGcloud()
    namespace, results = builder(gcloud)

    namespace["main"]()

    build_create, verify_create = gcloud.commands("compute", "instances", "create")
    assert "--image-family=ubuntu-2404-lts-amd64" in build_create
    assert "--image-project=ubuntu-os-cloud" in build_create
    assert "--image=open-inspect-sandbox-abc-1" in verify_create
    (image_create,) = gcloud.commands("compute", "images", "create")
    assert "--family=open-inspect-sandbox" in image_create
    assert any(arg.startswith("--source-disk=") for arg in image_create)
    ssh_commands = [
        arg for call in gcloud.commands("compute", "ssh") for arg in call if "--command=" in arg
    ]
    assert any("install/install.sh" in arg for arg in ssh_commands)
    assert any("smoke_test.py verify" in arg for arg in ssh_commands)
    assert len(gcloud.commands("compute", "instances", "delete")) == 2
    assert results == ["projects/test-proj/global/images/open-inspect-sandbox-abc-1"]


def test_retry_reverifies_a_ready_image_without_rebuilding(builder):
    gcloud = FakeGcloud(image_status="READY")
    namespace, results = builder(gcloud)

    namespace["main"]()

    assert not gcloud.commands("compute", "images", "create")
    (create,) = gcloud.commands("compute", "instances", "create")
    assert "--image=open-inspect-sandbox-abc-1" in create
    assert results == ["projects/test-proj/global/images/open-inspect-sandbox-abc-1"]


def test_refuses_to_rebuild_over_a_failed_image(builder):
    gcloud = FakeGcloud(image_status="FAILED")
    namespace, results = builder(gcloud)

    with pytest.raises(RuntimeError, match="FAILED"):
        namespace["main"]()

    assert not gcloud.commands("compute", "instances", "create")
    assert results == []


def test_failed_install_still_deletes_the_build_vm_and_saves_no_image(builder):
    gcloud = FakeGcloud(fail_on="install.sh")
    namespace, results = builder(gcloud)

    with pytest.raises(subprocess.CalledProcessError):
        namespace["main"]()

    assert not gcloud.commands("compute", "images", "create")
    (delete,) = gcloud.commands("compute", "instances", "delete")
    assert "--delete-disks=all" in delete
    assert results == []


def test_cleanup_leaves_no_session_state_or_instance_identity():
    namespace = runpy.run_path(str(BUILDER))
    command = namespace["cleanup_command"]()
    assert "/var/lib/oi" in command
    assert "cloud-init clean" in command
    assert "/etc/machine-id" in command


@pytest.mark.parametrize("name", ["Upper-case", "1-starts-with-digit", "x" * 64, "ends-with-"])
def test_candidate_name_must_be_a_valid_image_name(monkeypatch, name):
    namespace = runpy.run_path(str(BUILDER))
    monkeypatch.setenv("OPENINSPECT_IMAGE_CANDIDATE", name)
    with pytest.raises(RuntimeError, match="GCE image name"):
        namespace["candidate_name"]("open-inspect-sandbox", "abcdef0123456789")
