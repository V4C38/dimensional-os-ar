"""Named robot-instance calibration profiles, separate from robot-type defaults."""

from __future__ import annotations

import copy
import json
import re
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from uuid import uuid4

from config import replace_private_file
from dimos_config import dimos_config_path
from robot_sources import BLUEPRINTS, blueprint_definition
from tag_config import DEFAULT_MOUNT, merge_armodule_settings, ui_from_armodule_config

_LOCK = threading.RLock()


def profiles_path() -> Path:
    return dimos_config_path().with_name("ar-profiles.json")


def robot_preset(robot: str) -> dict[str, Any]:
    if robot == "openyam":
        path = Path(__file__).with_name("profiles") / "openyam.json"
        return dict(json.loads(path.read_text(encoding="utf-8"))["armodule"])
    return {}


def default_mount(robot: str) -> dict[str, Any]:
    return ui_from_armodule_config(robot_preset(robot))["mounts"][0] if robot == "openyam" else dict(DEFAULT_MOUNT)


class RobotProfiles:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or profiles_path()

    def all(self) -> list[dict[str, Any]]:
        with _LOCK:
            if not self.path.exists():
                self._save(
                    [
                        {
                            "id": uuid4().hex,
                            "robot": "unitree_go2",
                            "name": "UnitreeGo2_1",
                            "armodule": {},
                        }
                    ]
                )
            data = json.loads(self.path.read_text())
            if not isinstance(data, list):
                raise TypeError("robot profiles must contain a list")
            return copy.deepcopy(data)

    def get(self, profile_id: str) -> dict[str, Any]:
        return (
            next((p for p in self.all() if p["id"] == profile_id), None)
            or self._missing()
        )

    @staticmethod
    def _missing() -> Any:
        raise ValueError("unknown robot profile")

    def create(
        self, robot: str, name: str | None = None, source_id: str | None = None
    ) -> dict[str, Any]:
        if robot not in {item.robot for item in BLUEPRINTS.values()}:
            raise ValueError("unknown robot type")
        with _LOCK:
            profiles = self.all()
            source = next((profile for profile in profiles if profile["id"] == source_id), None)
            if source_id and source is None:
                self._missing()
            if source is not None and source["robot"] != robot:
                raise ValueError("cannot duplicate a different robot type")
            config = source["armodule"] if source else robot_preset(robot)
            if name is None:
                stem = source["name"] if source else ("UnitreeGo2" if robot == "unitree_go2" else "OpenYAM")
                name = self._next_name(stem, profiles)
            profile = {
                "id": uuid4().hex,
                "robot": robot,
                "name": self._name(name),
                "armodule": config,
            }
            self._save([*profiles, profile])
            return copy.deepcopy(profile)

    def update(
        self,
        profile_id: str,
        *,
        name: str | None = None,
        settings: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with _LOCK:
            profiles = self.all()
            profile = next((p for p in profiles if p["id"] == profile_id), None)
            if profile is None:
                self._missing()
            assert profile is not None
            if name is not None:
                profile["name"] = self._name(name)
            if settings is not None:
                config = merge_armodule_settings(
                    profile["armodule"], settings, default_mount=default_mount(profile["robot"])
                )
                self._validate_native_map(profile["robot"], config)
                profile["armodule"] = config
            self._save(profiles)
            return copy.deepcopy(profile)

    def delete(self, profile_id: str) -> None:
        with _LOCK:
            profiles = self.all()
            self.get(profile_id)
            self._save([p for p in profiles if p["id"] != profile_id])

    def snapshot(self, profile_id: str, blueprint: str) -> dict[str, Any]:
        profile = self.get(profile_id)
        if blueprint_definition(blueprint).robot != profile["robot"]:
            raise ValueError("robot profile is incompatible with blueprint")
        self._validate_native_map(profile["robot"], profile["armodule"])
        config = copy.deepcopy(profile["armodule"])
        if config.get("fiducial_marker_mounts") == []:
            config.pop("fiducial_marker_mounts")
            localization = config.get("localization")
            if localization is not None:
                localization["providers"] = [
                    provider for provider in localization.get("providers", [])
                    if provider.get("type") != "fiducial_marker"
                ]
        return {**config, "robot_display_name": profile["name"]}

    @staticmethod
    def _validate_native_map(robot: str, config: dict[str, Any]) -> None:
        if robot != "unitree_go2" and (config.get("localization") or {}).get("native_map_file"):
            raise ValueError("Saved LiDAR maps are supported only by Unitree Go2")

    @staticmethod
    def _next_name(stem: str, profiles: list[dict[str, Any]]) -> str:
        stem = re.sub(r"_\d+$", "", stem)
        indices = [int(match.group(1)) for profile in profiles if (match := re.fullmatch(re.escape(stem) + r"_(\d+)", profile["name"]))]
        suffix = f"_{max(indices, default=0) + 1}"
        return stem[:80 - len(suffix)] + suffix

    @staticmethod
    def _name(name: str) -> str:
        if not name.strip() or len(name) > 80:
            raise ValueError("profile name must contain 1 to 80 characters")
        return name.strip()

    @contextmanager
    def rollback_on_error(self) -> Iterator[None]:
        with _LOCK:
            previous = self.path.read_bytes() if self.path.exists() else None
            try:
                yield
            except BaseException:
                if previous is None:
                    self.path.unlink(missing_ok=True)
                elif not self.path.exists() or self.path.read_bytes() != previous:
                    replace_private_file(self.path, previous)
                raise

    def _save(self, profiles: list[dict[str, Any]]) -> None:
        data = json.dumps(profiles, indent=2, allow_nan=False).encode("utf-8")
        replace_private_file(self.path, data)
