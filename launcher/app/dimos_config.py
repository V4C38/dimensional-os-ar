"""Locate launcher-owned settings and freeze native configuration for each run."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def dimos_config_path() -> Path:
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "dimos" / "config"


def write_runtime_config(armodule: dict[str, Any], *, use_go2_localization: bool = False) -> Path:
    """Preserve native configuration while replacing AR settings for this run."""
    source = dimos_config_path()
    data = json.loads(source.read_text()) if source.is_file() else {}
    if not isinstance(data, dict):
        raise TypeError("DimOS configuration must contain a JSON object")
    data["armodule"] = armodule
    localization = armodule.get("localization") or {}
    old_relocalizer = data.pop("go2relocalization", None) or {}
    if use_go2_localization:
        mapper = data.get("pgovoxelmapper") or {}
        if "native_map_file" in localization:
            mapper["map_file"] = localization["native_map_file"] or None
            if not mapper["map_file"]:
                mapper.pop("save_map", None)
        elif old_relocalizer.get("map_file") and not mapper.get("map_file"):
            raise ValueError(
                "The saved Go2 relocalizer map uses an older format. "
                "Select a .map.db keyframe map or clear Saved LiDAR map."
            )
        map_file = mapper.get("map_file")
        if map_file and str(map_file).lower().endswith(".pc2.lcm"):
            raise ValueError(
                "The selected .pc2.lcm map contains a flat point cloud. "
                "Select a .map.db keyframe map or clear Saved LiDAR map."
            )
        if mapper:
            data["pgovoxelmapper"] = mapper
        if map_file and "native_map_file" not in localization:
            data["armodule"] = {**armodule, "localization": {**localization, "native_map_file": map_file}}
    else:
        data.pop("pgovoxelmapper", None)
        if localization.get("native_map_file"):
            data["armodule"] = {**armodule, "localization": {**localization, "native_map_file": None}}
    with tempfile.NamedTemporaryFile(mode="w", prefix="dimos-ar-run-", suffix=".json", delete=False) as stream:
        target = Path(stream.name)
        try:
            json.dump(data, stream, allow_nan=False)
        except BaseException:
            target.unlink(missing_ok=True)
            raise
    return target
