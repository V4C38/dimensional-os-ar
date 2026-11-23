"""Bounded, non-actuating discovery through the selected DimOS environment."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from command_capture import capture_command


async def run_json_probe(
    python: str, *arguments: str, timeout: float, error: str | None = None,
    cwd: Path | None = None, env: dict[str, str] | None = None,
) -> Any:
    code, out, err = await capture_command(python, *arguments, timeout=timeout, cwd=cwd, env=env)
    if code and error:
        raise ValueError(err.decode(errors="replace")[-2000:] or error)
    lines = out.decode().splitlines()
    if not lines:
        raise ValueError(error or "Probe returned no JSON")
    return json.loads(lines[-1])


async def discover_devices(python: str, robot: str) -> list[dict[str, Any]]:
    if robot not in {"unitree_go2", "openyam"}:
        raise ValueError("Unknown robot type")
    helper = Path(__file__).resolve().parents[1] / "scripts" / "robot_discovery.py"
    devices = await run_json_probe(python, str(helper), robot, timeout=8, error="Discovery failed")
    if not isinstance(devices, list) or any(
        not isinstance(device, dict)
        or not all(isinstance(device.get(key), str) and device[key].strip() for key in ("id", "address"))
        for device in devices
    ):
        raise ValueError("Invalid discovery response")
    return devices


async def validate_replay(python: str, path: str, robot: str = "unitree_go2", streams: dict[str, str] | None = None) -> dict[str, Any]:
    code = """import json,sys
from dimos.ar.replay import inspect_recording
print(json.dumps(inspect_recording(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))))
"""
    recording = await run_json_probe(
        python, "-c", code, path, robot, json.dumps(streams or {}),
        timeout=30, error="Replay validation failed",
    )
    if (
        not isinstance(recording, dict)
        or not isinstance(recording.get("needs_selection"), bool)
        or not isinstance(recording.get("streams"), dict)
        or not all(isinstance(value, str) for value in recording["streams"].values())
        or not isinstance(recording.get("candidates"), dict)
        or not all(
            isinstance(names, list) and all(isinstance(name, str) for name in names)
            for names in recording["candidates"].values()
        )
    ):
        raise TypeError("Invalid replay inspection response")
    return recording
