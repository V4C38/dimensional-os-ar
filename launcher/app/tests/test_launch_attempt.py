"""Command and event ownership regressions."""

import asyncio

import pytest

from armodule import ProcessManager
from launcher_events import LauncherEvents


@pytest.mark.asyncio
async def test_stop_retires_launch_attempt_before_spawn(tmp_path):
    manager = ProcessManager(root=tmp_path)
    entered = asyncio.Event()
    release = asyncio.Event()
    spawned = False

    async def launch():
        nonlocal spawned
        entered.set()
        await release.wait()
        spawned = True
        return {}

    start = asyncio.create_task(manager.run_launch_attempt(launch))
    await entered.wait()
    await manager.stop_armodule()
    release.set()
    with pytest.raises(RuntimeError, match="Startup cancelled"):
        await start
    assert not spawned


@pytest.mark.asyncio
async def test_status_snapshot_precedes_live_events_during_log_replay():
    phase = "ready"
    events = LauncherEvents(lambda: {"phase": phase})
    events.append_log("Starting launcher")
    async with asyncio.timeout(1):
        stream = events.subscribe()
        try:
            assert (await anext(stream))["type"] == "log"
            phase = "starting"
            events.emit({"type": "status", "phase": phase})
            phase = "running"
            events.emit({"type": "status", "phase": phase})
            assert [(await anext(stream))["phase"] for _ in range(3)] == [
                "ready", "starting", "running",
            ]
        finally:
            await stream.aclose()
