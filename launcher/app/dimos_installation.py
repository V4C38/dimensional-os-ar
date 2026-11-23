"""Resolve and inspect local DimOS installations before launching setup."""

from __future__ import annotations

import os
import subprocess
import sys
import tomllib
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
    """Accept either a DimOS checkout folder or its Python executable."""
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
        "Choose a DimOS install folder with a Python 3.12 environment, or its Python executable"
    )


def check_setup_location(mode: str, path: str | None) -> dict[str, str]:
    raw = (path or "").strip()
    if not raw:
        return {"state": "invalid", "message": "Enter a folder path."}
    folder = Path(raw).expanduser()
    if mode == "clone":
        if not folder.exists() or (folder.is_dir() and not any(folder.iterdir())):
            return {"state": "download", "message": "DimOS is missing here. Download and install it to use this folder."}
        if not is_dimos_source_tree(folder):
            return {"state": "invalid", "message": "Choose an empty folder or a DimOS checkout."}
    try:
        resolve_dimos_python(raw)
    except ValueError:
        if mode == "clone":
            return {"state": "download", "message": "Checkout found. Install DimOS in this folder."}
        return {"state": "invalid", "message": "No working Python 3.12 DimOS install found in this location."}
    return {"state": "found", "message": "DimOS installation found."}


if __name__ == "__main__":
    raise SystemExit(0 if is_dimos_source_tree(Path(sys.argv[1])) else 1)
