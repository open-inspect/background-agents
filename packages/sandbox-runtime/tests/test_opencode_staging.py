"""Tests for staging skills and bin scripts, and resolving OpenCode's config dir."""

from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from sandbox_runtime.constants import BIN_INSTALL_DIR_ENV_VAR
from sandbox_runtime.log_config import get_logger
from sandbox_runtime.opencode_server import OpenCodeServer, resolve_opencode_global_config_dir
from sandbox_runtime.sandbox_bin import install_bin_scripts
from tests.runtime_helpers import make_opencode_server


def _make_opencode_server() -> OpenCodeServer:
    """Create an OpenCodeServer with default test config."""
    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        },
    ):
        return make_opencode_server()


@contextmanager
def _patch_paths(
    skills: Path | str = "/nonexistent",
    bin_src: Path | str = "/nonexistent",
    bin_dest: Path | str = "/nonexistent",
):
    """Patch Path() calls to redirect the skills and bin paths."""
    with patch("sandbox_runtime.opencode_server.Path") as MockPath:
        MockPath.side_effect = lambda p: Path(
            str(p)
            .replace("/app/sandbox_runtime/skills", str(skills))
            .replace("/app/sandbox_runtime/bin", str(bin_src))
            .replace("/usr/local/bin", str(bin_dest))
        )
        yield


class TestInstallBinScripts:
    """Cases for install_bin_scripts(): standalone CLIs both harnesses share."""

    @staticmethod
    def _install(monkeypatch, src: Path, dest: Path) -> list[str]:
        # The canonical override, so an ambient value on the host never wins.
        monkeypatch.setenv(BIN_INSTALL_DIR_ENV_VAR, str(dest))
        return install_bin_scripts(get_logger("test"), bin_dir=src)

    def test_scripts_installed_to_bin(self, tmp_path, monkeypatch):
        """Checked-in bin scripts should be installed as executable commands."""
        src = tmp_path / "app" / "sandbox_runtime" / "bin"
        src.mkdir(parents=True)
        (src / "upload-media.js").write_text("#!/usr/bin/env node\n// upload cli")
        (src / "oi-git-sign").write_text("#!/bin/sh\n# signer launcher")
        dest = tmp_path / "usr-local-bin"
        dest.mkdir()

        installed_names = self._install(monkeypatch, src, dest)

        assert installed_names == ["oi-git-sign", "upload-media"]
        installed = dest / "upload-media"
        assert installed.exists()
        assert installed.read_text() == "#!/usr/bin/env node\n// upload cli"
        assert installed.stat().st_mode & 0o755
        signer = dest / "oi-git-sign"
        assert signer.exists()
        assert signer.read_text() == "#!/bin/sh\n# signer launcher"
        assert signer.stat().st_mode & 0o755

    def test_scripts_fall_back_to_the_default_bin_without_the_override(self, tmp_path, monkeypatch):
        """Without OPENINSPECT_BIN_INSTALL_DIR the default directory is used."""
        src = tmp_path / "app" / "sandbox_runtime" / "bin"
        src.mkdir(parents=True)
        (src / "upload-media.js").write_text("#!/usr/bin/env node\n// upload cli")
        default_dest = tmp_path / "usr-local-bin"
        monkeypatch.delenv(BIN_INSTALL_DIR_ENV_VAR, raising=False)
        monkeypatch.setattr(
            "sandbox_runtime.sandbox_bin.DEFAULT_BIN_INSTALL_DIR", str(default_dest)
        )

        install_bin_scripts(get_logger("test"), bin_dir=src)

        installed = default_dest / "upload-media"
        assert installed.exists()
        assert installed.read_text() == "#!/usr/bin/env node\n// upload cli"

    def test_non_js_files_skipped(self, tmp_path, monkeypatch):
        """Files that are neither extensionless nor .js are not installed."""
        src = tmp_path / "app" / "sandbox_runtime" / "bin"
        src.mkdir(parents=True)
        (src / "upload-media.js").write_text("// cli")
        (src / "README.md").write_text("# docs")
        dest = tmp_path / "usr-local-bin"
        dest.mkdir()

        self._install(monkeypatch, src, dest)

        assert (dest / "upload-media").exists()
        assert not (dest / "README").exists()
        assert not (dest / "README.md").exists()

    def test_noop_when_bin_dir_missing(self, tmp_path, monkeypatch):
        """A missing bundled bin directory installs nothing and creates nothing."""
        dest = tmp_path / "usr-local-bin"

        assert self._install(monkeypatch, tmp_path / "missing-bin", dest) == []
        assert not dest.exists()


class TestInstallSkills:
    """Cases for _install_skills() bundled Skill installation."""

    def test_complete_skill_directories_are_copied(self, tmp_path):
        """Bundled Skills should include companion files and directories."""
        sup = _make_opencode_server()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        skills_dir = tmp_path / "app" / "sandbox" / "skills"
        agent_browser_dir = skills_dir / "agent-browser"
        scripts_dir = agent_browser_dir / "scripts"
        references_dir = agent_browser_dir / "references"
        scripts_dir.mkdir(parents=True)
        references_dir.mkdir()
        (agent_browser_dir / "SKILL.md").write_text("# agent-browser")
        (scripts_dir / "helper.py").write_text("print('helper')")
        (references_dir / "notes.md").write_text("Use this reference")
        pycache_dir = scripts_dir / "__pycache__"
        pycache_dir.mkdir()
        (pycache_dir / "helper.cpython-314.pyc").write_bytes(b"compiled")

        record_video_dir = skills_dir / "record-video"
        record_video_dir.mkdir()
        (record_video_dir / "SKILL.md").write_text("# record-video")
        (record_video_dir / "helper.txt").write_text("fresh install")

        (skills_dir / "README.md").write_text("not a skill")
        no_skill_dir = skills_dir / "not-a-skill"
        no_skill_dir.mkdir()
        (no_skill_dir / "notes.md").write_text("missing SKILL.md")

        existing_file = workdir / ".opencode" / "skills" / "agent-browser" / "local.txt"
        existing_file.parent.mkdir(parents=True)
        existing_file.write_text("keep me")

        with _patch_paths(
            skills=skills_dir,
        ):
            installed = sup._install_skills(workdir)

        skill_dest = workdir / ".opencode" / "skills" / "agent-browser"
        assert (skill_dest / "SKILL.md").read_text() == "# agent-browser"
        assert (skill_dest / "scripts" / "helper.py").read_text() == "print('helper')"
        assert (skill_dest / "references" / "notes.md").read_text() == "Use this reference"
        assert not (skill_dest / "scripts" / "__pycache__").exists()
        assert existing_file.read_text() == "keep me"
        fresh_skill_dest = workdir / ".opencode" / "skills" / "record-video"
        assert (fresh_skill_dest / "SKILL.md").read_text() == "# record-video"
        assert (fresh_skill_dest / "helper.txt").read_text() == "fresh install"
        assert not (workdir / ".opencode" / "skills" / "README.md").exists()
        assert not (workdir / ".opencode" / "skills" / "not-a-skill").exists()
        assert installed == {
            ".opencode/skills/agent-browser/SKILL.md",
            ".opencode/skills/agent-browser/references/notes.md",
            ".opencode/skills/agent-browser/scripts/helper.py",
            ".opencode/skills/record-video/SKILL.md",
            ".opencode/skills/record-video/helper.txt",
        }
        assert ".opencode/skills/agent-browser/local.txt" not in installed

    def test_skills_dir_non_directory_is_ignored(self, tmp_path):
        """A non-directory skills path should not raise or copy files."""
        sup = _make_opencode_server()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        skills_file = tmp_path / "app" / "sandbox" / "skills"
        skills_file.parent.mkdir(parents=True)
        skills_file.write_text("not a directory")

        with _patch_paths(
            skills=skills_file,
        ):
            sup._install_skills(workdir)

        assert not (workdir / ".opencode" / "skills").exists()


class TestResolveGlobalConfigDir:
    """Cases for OpenCode's xdg-basedir resolution."""

    def test_uses_opencode_config_dir_override(self, tmp_path, monkeypatch):
        """OPENCODE_CONFIG_DIR wins over XDG_CONFIG_HOME and is used verbatim."""
        monkeypatch.setenv("OPENCODE_CONFIG_DIR", str(tmp_path / "custom"))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
        assert resolve_opencode_global_config_dir() == tmp_path / "custom"

    def test_uses_xdg_config_home(self, tmp_path, monkeypatch):
        """Without the override, $XDG_CONFIG_HOME/opencode is used."""
        monkeypatch.delenv("OPENCODE_CONFIG_DIR", raising=False)
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
        assert resolve_opencode_global_config_dir() == tmp_path / "xdg" / "opencode"

    def test_falls_back_to_home_config(self, tmp_path, monkeypatch):
        """With neither set, ~/.config/opencode is used."""
        monkeypatch.delenv("OPENCODE_CONFIG_DIR", raising=False)
        monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
        monkeypatch.setenv("HOME", str(tmp_path / "home"))
        assert resolve_opencode_global_config_dir() == tmp_path / "home" / ".config" / "opencode"
