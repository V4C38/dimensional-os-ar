"""System-config elevation gating."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import armodule
from armodule import ProcessManager


def test_configure_noop_off_darwin(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(armodule.sys, "platform", "linux")
    mgr = ProcessManager(root=tmp_path)
    spawn = AsyncMock()
    monkeypatch.setattr(armodule.asyncio, "create_subprocess_exec", spawn)

    import asyncio

    # Must return without touching osascript / raising on non-macOS.
    asyncio.run(mgr._configure_system_if_needed())
    spawn.assert_not_awaited()


async def test_macos_zenoh_skips_elevation(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(armodule.sys, "platform", "darwin")
    manager = ProcessManager(root=tmp_path)
    monkeypatch.setattr(manager, "_selected_python", lambda: "/selected/bin/python")
    probe = AsyncMock(return_value="zenoh")
    spawn = AsyncMock()
    monkeypatch.setattr(armodule, "run_json_probe", probe)
    monkeypatch.setattr(armodule.asyncio, "create_subprocess_exec", spawn)
    await manager._configure_system_if_needed()
    probe.assert_awaited_once()
    spawn.assert_not_awaited()
