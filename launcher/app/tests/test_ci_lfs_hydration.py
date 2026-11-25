"""Local CI hydrates existing pointers without reviving intentionally deleted assets."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize("failures,success,attempts", [(2, True, 3), (4, False, 4)])
def test_hydration_retries_failed_fetches_and_stops_on_persistent_failure(
    tmp_path: Path, failures: int, success: bool, attempts: int
) -> None:
    script = (Path(__file__).resolve().parents[2] / "scripts/run-ci.sh").read_text()
    function = re.search(r"(?ms)^hydrate_existing_lfs\(\) \{\n.*?^\}\n", script)
    assert function is not None
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_git = fake_bin / "git"
    fake_git.write_text(
        '#!/bin/bash\n'
        'if [[ "$3 $4" == "lfs fetch" ]]; then\n'
        '  echo fetch >> "$CALLS"\n'
        '  count=$(grep -c "^fetch$" "$CALLS")\n'
        '  if (( count <= FAILURES )); then echo "HTTP 502" >&2; exit 1; fi\n'
        'elif [[ "$3" == "ls-files" ]]; then\n'
        '  echo ls-files >> "$CALLS"\n'
        'else\n'
        '  echo unexpected >> "$CALLS"; exit 2\n'
        'fi\n'
    )
    fake_git.chmod(0o755)
    fake_sleep = fake_bin / "sleep"
    fake_sleep.write_text('#!/bin/bash\necho "sleep $1" >> "$CALLS"\n')
    fake_sleep.chmod(0o755)
    calls = tmp_path / "calls"
    env = {**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}",
           "CALLS": str(calls), "FAILURES": str(failures)}
    result = subprocess.run(
        ["/bin/bash", "-c", "set -euo pipefail\n" + function.group()
         + '\nROOT="$1"\nhydrate_existing_lfs "$2"\n', "fixture", str(tmp_path), "assets/**"],
        check=False, env=env, capture_output=True, text=True,
    )
    lines = calls.read_text().splitlines()
    assert (result.returncode == 0) is success
    assert lines.count("fetch") == attempts
    assert [line for line in lines if line.startswith("sleep ")] == ["sleep 2", "sleep 4", "sleep 8"][:attempts - 1]
    assert ("ls-files" in lines) is success
    assert "unexpected" not in lines
    if not success:
        assert "failed after 4 attempts" in result.stderr


def test_hydration_fetches_pointers_but_preserves_working_deletions(
    tmp_path: Path,
) -> None:
    if not shutil.which("git") or not shutil.which("git-lfs"):
        pytest.skip("Git and Git LFS are required for the local CI hydration fixture")
    env = {
        **os.environ,
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_LFS_SKIP_SMUDGE": "1",
    }

    def git(directory: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", str(directory), *args],
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )

    remote, seed, checkout = (
        tmp_path / name for name in ("local remote.git", "seed", "checkout with spaces")
    )
    git(tmp_path, "init", "--bare", "--initial-branch=main", str(remote))
    git(tmp_path, "init", "--initial-branch=main", str(seed))
    git(seed, "config", "user.name", "CI fixture")
    git(seed, "config", "user.email", "ci-fixture@example.invalid")
    git(seed, "lfs", "install", "--local")
    git(seed, "lfs", "track", "*.bin", "*.lspkg")
    payloads = {
        "keep pointer.bin": b"first LFS payload",
        "keep archive.lspkg": b"Core package payload",
        "keep\nnewline.bin": b"second LFS payload",
        "deleted pointer.bin": b"must not reappear",
    }
    for name, payload in payloads.items():
        path = seed / "fixtures shaders" / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(payload)
    git(seed, "add", ".")
    git(seed, "commit", "-m", "LFS fixture")
    git(seed, "remote", "add", "origin", str(remote))
    git(seed, "push", "-u", "origin", "main")
    git(tmp_path, "clone", "--no-checkout", str(remote), str(checkout))
    git(checkout, "lfs", "install", "--local")
    git(checkout, "checkout", "main")
    for name in payloads:
        assert (
            (checkout / "fixtures shaders" / name)
            .read_bytes()
            .startswith(b"version https://git-lfs.github.com/spec/v1\n")
        )
    deleted = checkout / "fixtures shaders/deleted pointer.bin"
    deleted.unlink()

    script = (Path(__file__).resolve().parents[2] / "scripts/run-ci.sh").read_text()
    # Execute the production function alone, never source the CI job entrypoint.
    function = re.search(r"(?ms)^hydrate_existing_lfs\(\) \{\n.*?^\}\n", script)
    assert function is not None
    command = [
        "/bin/bash",
        "-c",
        "set -euo pipefail\n"
        + function.group()
        + '\nROOT="$1"\nhydrate_existing_lfs "$2"\n',
        "ci-lfs-fixture",
        str(checkout),
        "fixtures shaders/*.bin,fixtures shaders/*.lspkg",
    ]
    for _ in range(2):
        subprocess.run(command, env=env, check=True, capture_output=True, text=True)
        assert not deleted.exists()
        for name, payload in payloads.items():
            if name != deleted.name:
                assert (checkout / "fixtures shaders" / name).read_bytes() == payload
    assert (
        " D fixtures shaders/deleted pointer.bin\0"
        in git(checkout, "status", "--porcelain", "-z").stdout
    )
    # An empty path selection must not fall back to checkout of every LFS file.
    for name in payloads:
        (checkout / "fixtures shaders" / name).unlink(missing_ok=True)
    subprocess.run(command, env=env, check=True, capture_output=True, text=True)
    assert not any((checkout / "fixtures shaders").iterdir())
