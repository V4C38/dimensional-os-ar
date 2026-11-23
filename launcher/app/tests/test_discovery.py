from unittest.mock import AsyncMock

import pytest

import command_capture
import discovery


@pytest.mark.asyncio
async def test_discovery_uses_selected_interpreter_and_preserves_identity(monkeypatch):
    proc = AsyncMock(returncode=0)
    proc.communicate.return_value = (b'[{"id":"serial-A","address":"192.168.1.4","transport":"lan"}]\n', b'')
    spawn = AsyncMock(return_value=proc)
    monkeypatch.setattr(command_capture.asyncio, "create_subprocess_exec", spawn)
    devices = await discovery.discover_devices("/selected/python", "unitree_go2")
    assert spawn.call_args.args[0] == "/selected/python"
    assert devices[0]["id"] == "serial-A"
    assert spawn.call_args.args[1].endswith("scripts/robot_discovery.py")
    assert spawn.call_args.args[2] == "unitree_go2"


@pytest.mark.asyncio
async def test_discovery_failure_is_not_empty_success(monkeypatch):
    proc = AsyncMock(returncode=1)
    proc.communicate.return_value = (b'', b'Permission denied')
    monkeypatch.setattr(command_capture.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc))
    with pytest.raises(ValueError, match="Permission denied"):
        await discovery.discover_devices("/selected/python", "openyam")


@pytest.mark.asyncio
async def test_auto_no_devices_never_starts_or_switches_to_simulation(app_context, monkeypatch):
    from fastapi import HTTPException

    import app

    monkeypatch.setattr(type(app_context.manager), "selected_python", "/test/python")
    monkeypatch.setattr(app, "discover_devices", AsyncMock(return_value=[]))
    start = AsyncMock()
    monkeypatch.setattr(app_context.manager, "start_armodule", start)
    with pytest.raises(HTTPException) as error:
        await app.api_armodule_start(app.StartBody(blueprint="unitree_go2_ar", profile_id="go2", source=app.SourceBody(mode="auto")), context=app_context)
    assert error.value.status_code == 409
    assert error.value.detail["suggest_simulated"] is False
    start.assert_not_awaited()


@pytest.mark.asyncio
async def test_selected_can_is_injected_without_profile_mutation(app_context, monkeypatch):
    import app

    monkeypatch.setattr(type(app_context.manager), "selected_python", "/test/python")
    monkeypatch.setattr(app, "discover_devices", AsyncMock(return_value=[{"id": "can2", "address": "can2"}]))
    monkeypatch.setattr(app_context.robot_profiles, "snapshot", lambda *args: {"robot_display_name": "Bench"})
    start = AsyncMock()
    monkeypatch.setattr(app_context.manager, "start_armodule", start)
    monkeypatch.setattr(app_context.manager, "snapshot", dict)
    await app.api_armodule_start(app.StartBody(blueprint="openyam_ar_planner", profile_id="bench", source=app.SourceBody(mode="device", device_id="can2")), context=app_context)
    assert start.call_args.kwargs["can_port"] == "can2"
    assert start.call_args.kwargs["armodule_config"] == {"robot_display_name": "Bench"}


@pytest.mark.asyncio
async def test_missing_explicit_device_does_not_switch_to_simulation(app_context, monkeypatch):
    from fastapi import HTTPException

    import app

    monkeypatch.setattr(type(app_context.manager), "selected_python", "/test/python")
    monkeypatch.setattr(app, "discover_devices", AsyncMock(return_value=[]))
    start = AsyncMock()
    monkeypatch.setattr(app_context.manager, "start_armodule", start)
    with pytest.raises(HTTPException) as error:
        await app.api_armodule_start(app.StartBody(blueprint="unitree_go2_ar", profile_id="go2", source=app.SourceBody(mode="device", device_id="missing")), context=app_context)
    assert error.value.detail["suggest_simulated"] is False
    start.assert_not_awaited()


def test_preferences_are_independent_of_profiles_and_replace_atomically(tmp_path, monkeypatch):
    import preferences

    target = tmp_path / "ar-launcher.json"
    monkeypatch.setattr(preferences, "path", lambda: target)
    preferences.save({"go2_source": "simulated", "replay": "/a recording.db"})
    assert preferences.read()["replay"] == "/a recording.db"
    assert list(tmp_path.iterdir()) == [target]
    preferences.save({"go2_source": "auto"})
    assert preferences.read() == {"go2_source": "auto"}


@pytest.mark.asyncio
async def test_manual_ip_pins_connection_without_discovery(app_context, monkeypatch):
    import app

    discover = AsyncMock()
    start = AsyncMock()
    monkeypatch.setattr(app_context.robot_profiles, "snapshot", lambda *args: {})
    monkeypatch.setattr(app, "api_discovery", discover)
    monkeypatch.setattr(app_context.manager, "start_armodule", start)
    monkeypatch.setattr(app_context.manager, "snapshot", dict)
    await app.api_armodule_start(app.StartBody(blueprint="unitree_go2_ar", profile_id="go2",
        source=app.SourceBody(mode="manual", address="192.168.1.42")), context=app_context)
    discover.assert_not_awaited()
    assert start.call_args.kwargs["robot_ip"] == "192.168.1.42"


@pytest.mark.asyncio
async def test_arm_recording_requires_file_and_never_falls_back_to_hardware(app_context, monkeypatch):
    from fastapi import HTTPException

    import app

    start = AsyncMock()
    monkeypatch.setattr(app_context.manager, "start_armodule", start)
    with pytest.raises(HTTPException, match="Choose an OpenYAM recording"):
        await app.api_armodule_start(app.StartBody(blueprint="openyam_ar_planner",
            profile_id="arm", source=app.SourceBody(mode="simulated", playback="recording")), context=app_context)
    start.assert_not_awaited()


@pytest.mark.asyncio
async def test_arm_recording_passes_validated_stream_binding_to_process(app_context, monkeypatch, tmp_path):
    import app

    path = tmp_path / "recording.db"
    path.touch()
    streams = {"joints": "measured"}
    validate = AsyncMock(return_value={"streams": streams, "needs_selection": False})
    start = AsyncMock()
    monkeypatch.setattr(app, "validate_replay", validate)
    app_context.manager.dependencies.update_status(dimos_python="/selected/python")
    monkeypatch.setattr(app_context.manager, "start_armodule", start)
    monkeypatch.setattr(app_context.manager, "snapshot", dict)
    monkeypatch.setattr(app_context.robot_profiles, "snapshot", lambda *args: {})
    await app.api_armodule_start(app.StartBody(blueprint="openyam_ar_planner", profile_id="arm",
        source=app.SourceBody(mode="simulated", playback="recording", replay=str(path), streams=streams)), context=app_context)
    validate.assert_awaited_once_with("/selected/python", str(path), "openyam", streams)
    assert start.call_args.kwargs["replay"] == str(path)
    assert start.call_args.kwargs["replay_streams"] == streams
    assert start.call_args.kwargs["can_port"] is None


def test_missing_preferences_ignore_old_robot_ip(tmp_path, monkeypatch):
    import preferences

    monkeypatch.setattr(preferences, "path", lambda: tmp_path / "missing.json")
    monkeypatch.setenv("ROBOT_IP", "fake")
    assert preferences.read() == {}


@pytest.mark.asyncio
async def test_probe_timeout_kills_and_reaps_its_own_process(monkeypatch):
    import asyncio
    from unittest.mock import Mock

    proc = AsyncMock(returncode=None, pid=123)
    kill_group = Mock()
    monkeypatch.setattr(command_capture.os, "killpg", kill_group)
    # Use an actual blocked communicate so cancellation exercises the shared finally.
    async def blocked():
        await asyncio.Event().wait()
    proc.communicate.side_effect = blocked
    monkeypatch.setattr(command_capture.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc))
    with pytest.raises(TimeoutError):
        await discovery.run_json_probe("/selected/python", "probe.py", timeout=0.001)
    kill_group.assert_called_once_with(proc.pid, command_capture.signal.SIGKILL)
    proc.wait.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_probe_cancelled_during_spawn_reaps_the_late_child(monkeypatch):
    import asyncio
    from unittest.mock import Mock

    entered, release = asyncio.Event(), asyncio.Event()
    proc = AsyncMock(returncode=None, pid=123)
    kill_group = Mock()

    async def delayed_spawn(*args, **kwargs):
        entered.set()
        await release.wait()
        return proc

    monkeypatch.setattr(command_capture.os, "killpg", kill_group)
    monkeypatch.setattr(command_capture.asyncio, "create_subprocess_exec", delayed_spawn)
    task = asyncio.create_task(discovery.run_json_probe("/selected/python", "probe.py", timeout=1))
    async with asyncio.timeout(1):
        await entered.wait()
        task.cancel()
        await asyncio.sleep(0)
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    kill_group.assert_called_once_with(proc.pid, command_capture.signal.SIGKILL)
    proc.wait.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_discovery_rejects_records_missing_identity(monkeypatch):
    monkeypatch.setattr(discovery, "run_json_probe", AsyncMock(return_value=[{"address": "can0"}]))
    with pytest.raises(ValueError, match="Invalid discovery response"):
        await discovery.discover_devices("/selected/python", "openyam")


@pytest.mark.asyncio
async def test_replay_rejects_malformed_stream_schema(monkeypatch):
    monkeypatch.setattr(discovery, "run_json_probe", AsyncMock(return_value={
        "streams": {"odom": 1}, "candidates": {}, "needs_selection": False,
    }))
    with pytest.raises(TypeError, match="Invalid replay inspection response"):
        await discovery.validate_replay("/selected/python", "anything.db")
