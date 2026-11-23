"""Atomic launcher-wide choices, kept separate from robot calibration."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from config import replace_private_file
from dimos_config import dimos_config_path


def path() -> Path:
    return dimos_config_path().with_name("ar-launcher.json")


def read(target: Path | None = None) -> dict[str, Any]:
    try:
        data = json.loads((target or path()).read_text())
        if not isinstance(data, dict):
            raise TypeError("launcher preferences must be a JSON object")
        return data
    except FileNotFoundError:
        return {}


def save(values: dict[str, Any], target: Path | None = None) -> None:
    data = json.dumps(values, allow_nan=False).encode("utf-8")
    replace_private_file(target or path(), data)
