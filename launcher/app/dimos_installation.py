"""Resolve and inspect local dimOS installations before launching setup."""

from __future__ import annotations

import os
import subprocess
import sys
import tomllib
from functools import cache
from importlib.metadata import PackageNotFoundError, version
from importlib.util import find_spec
from pathlib import Path


def is_dimos_source_tree(folder: Path) -> bool:
    if not (folder / ".git").exists():
        return False
    try:
        with (folder / "pyproject.toml").open("rb") as stream:
            project = tomllib.load(stream).get("project", {})
    except (OSError, ValueError):
        return False
    return isinstance(project, dict) and project.get("name") == "dimos"


def resolve_dimos_python(path: str) -> str:
    """Accept either a dimOS checkout folder or its Python executable."""
    selected = Path(path).expanduser().absolute()
    candidates = [selected]
    if selected.is_dir():
        search_dirs = (
            [selected] if selected.name in {".venv", "venv"}
            else [selected / ".venv", selected / "venv", selected]
        )
        candidates = [
            root / "bin" / executable
            for root in search_dirs
            for executable in ("python3", "python")
        ]
    for candidate in candidates:
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            continue
        try:
            subprocess.run(
                [
                    str(candidate),
                    "-c",
                    "import sys\nif sys.version_info[:2] != (3, 12): sys.exit(1)\nimport dimos",
                ],
                check=True,
                capture_output=True,
                timeout=10,
            )
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            continue
        else:
            # Keep the venv path itself; its Python executable is commonly a symlink
            # to a shared interpreter, and the venv location carries the environment.
            return str(candidate)
    raise ValueError(
        "Choose a dimOS install folder with a Python 3.12 environment, or its Python executable"
    )


@cache
def dimos_requirement() -> str:
    manifest = Path(__file__).resolve().parents[2] / "dimos-ar" / "pyproject.toml"
    with manifest.open("rb") as stream:
        return str(next(dep for dep in tomllib.load(stream)["project"]["dependencies"]
                        if dep.startswith("dimos>=")))


def dimos_install_state(*, installed: bool, version_text: str | None) -> str:
    from packaging.requirements import Requirement
    from packaging.version import InvalidVersion

    if not installed:
        return "missing"
    if version_text:
        try:
            if not Requirement(dimos_requirement()).specifier.contains(version_text, prereleases=True):
                return "incompatible"
        except InvalidVersion:
            return "incompatible"
    return "found"


def print_install_metadata() -> None:
    try:
        print(f"DIMOS_VERSION={version('dimos')}")
    except PackageNotFoundError:
        pass
    spec = find_spec("dimos")
    if not spec or not spec.origin:
        return
    source = Path(spec.origin).resolve().parent.parent
    if not (source / ".git").exists():
        print("DIMOS_REF=wheel")
        return
    try:
        branch, description = (
            subprocess.check_output(["git", "-C", str(source), *args], text=True).strip()
            for args in (("rev-parse", "--abbrev-ref", "HEAD"), ("describe", "--always", "--dirty"))
        )
        print(f"DIMOS_REF={branch} {description}")
    except (OSError, subprocess.CalledProcessError):
        pass


def check_setup_location(mode: str, path: str | None) -> dict[str, str]:
    raw = (path or "").strip()
    if not raw:
        return {"state": "invalid", "message": "Enter a folder path."}
    folder = Path(raw).expanduser()
    if mode == "clone":
        if not folder.exists() or (folder.is_dir() and not any(folder.iterdir())):
            return {"state": "download", "message": "dimOS is missing here. Download and install it to use this folder."}
        if not is_dimos_source_tree(folder):
            return {"state": "invalid", "message": "Choose an empty folder or a dimOS checkout."}
    try:
        interpreter = resolve_dimos_python(raw)
    except ValueError:
        if mode == "clone":
            return {"state": "download", "message": "Checkout found. Install dimOS in this folder."}
        return {"state": "invalid", "message": "No working Python 3.12 dimOS install found in this location."}
    metadata = subprocess.run([interpreter, __file__, "--metadata"], check=False,
                              capture_output=True, text=True, timeout=10)
    fields = dict(line.lower().split("=", 1)
                  for line in metadata.stdout.splitlines()
                  if line.startswith(("DIMOS_VERSION=", "DIMOS_REF=")))
    return {"state": dimos_install_state(installed=True, version_text=fields.get("dimos_version")),
            **fields}


if __name__ == "__main__":
    if sys.argv[1] == "--metadata":
        print_install_metadata()
    else:
        raise SystemExit(0 if is_dimos_source_tree(Path(sys.argv[1])) else 1)
