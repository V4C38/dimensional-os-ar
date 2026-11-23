"""A launcher run owns its AR snapshot without rewriting native configuration."""

import json

import pytest

from dimos_config import dimos_config_path, write_runtime_config


@pytest.mark.parametrize("map_file", ["office", "/maps/saved.map.db", None])
def test_saved_map_setting_reaches_native_module_without_replacing_native_options(
    tmp_path, monkeypatch, map_file
):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    source = dimos_config_path()
    source.parent.mkdir(parents=True)
    original = {"pgovoxelmapper": {"map_file": "old", "emit_every": 7}}
    source.write_text(json.dumps(original))
    target = write_runtime_config(
        {"localization": {"native_map_file": map_file}}, use_go2_localization=True
    )
    try:
        actual = json.loads(target.read_text())
        assert actual["pgovoxelmapper"] == {
            "map_file": map_file, "emit_every": 7,
        }
        assert actual["armodule"]["localization"]["native_map_file"] == map_file
        assert json.loads(source.read_text()) == original
    finally:
        target.unlink()


def test_old_map_is_preserved_and_requests_a_keyframe_map(tmp_path):
    old_map = tmp_path / "saved.pc2.lcm"
    old_map.write_bytes(b"legacy map")
    with pytest.raises(ValueError, match=r"Select a \.map\.db"):
        write_runtime_config(
            {"localization": {"native_map_file": str(old_map)}}, use_go2_localization=True
        )
    assert old_map.read_bytes() == b"legacy map"


def test_native_premap_is_also_used_for_ar_registration():
    source = dimos_config_path()
    source.parent.mkdir(parents=True)
    source.write_text(json.dumps({"pgovoxelmapper": {"map_file": "office"}}))
    target = write_runtime_config({}, use_go2_localization=True)
    try:
        assert json.loads(target.read_text())["armodule"]["localization"]["native_map_file"] == "office"
    finally:
        target.unlink()


def test_go2_replay_omits_live_mapper_settings_and_retains_saved_profile():
    profile = {"localization": {"native_map_file": "old.pc2.lcm"}}
    target = write_runtime_config(profile)
    try:
        assert json.loads(target.read_text())["armodule"]["localization"]["native_map_file"] is None
        assert profile["localization"]["native_map_file"] == "old.pc2.lcm"
    finally:
        target.unlink()


def test_runtime_snapshot_replaces_ar_settings_and_preserves_native_config(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    source = dimos_config_path()
    source.parent.mkdir(parents=True)
    original = {"g": {"robot_ip": "10.0.0.1"}, "other": {"speed": 2},
                "armodule": {"stationary_base": {"position": [9, 9, 9]}}}
    source.write_text(json.dumps(original))
    profile = {"localization": {"providers": []}, "robot_display_name": "Desk"}
    target = write_runtime_config(profile)
    try:
        profile["localization"]["providers"].append({"type": "vps"})
        actual = json.loads(target.read_text())
        assert actual == {**original, "armodule": {"localization": {"providers": []}, "robot_display_name": "Desk"}}
        assert json.loads(source.read_text()) == original
        assert target.stat().st_mode & 0o777 == 0o600
    finally:
        target.unlink()


def test_openyam_snapshot_omits_go2_section(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    source = dimos_config_path()
    source.parent.mkdir(parents=True)
    source.write_text(json.dumps({"go2relocalization": {"map_file": "office"}}))
    profile = {"localization": {"native_map_file": None}}
    target = write_runtime_config(profile)
    try:
        assert json.loads(target.read_text()) == {"armodule": profile}
        assert "go2relocalization" in json.loads(source.read_text())
    finally:
        target.unlink()


@pytest.mark.asyncio
async def test_run_config_is_passed_to_child_and_removed_on_stop(runtime):
    manager, _, spawn = runtime
    await manager.start_armodule(blueprint="unitree_go2_ar",
                                 armodule_config={"robot_display_name": "Desk"})
    target = manager.runtime.backend.config_path
    assert target is not None
    argv = list(spawn.call_args.args)
    assert argv[argv.index("--config") + 1] == str(target)
    await manager.stop_backend()
    assert not target.exists()


@pytest.mark.asyncio
async def test_spawn_failure_cleans_owned_config(runtime, monkeypatch):
    from unittest.mock import AsyncMock

    manager, _, _ = runtime
    original_spawn = manager.runtime._spawn
    target = None
    async def fail(*args, **kwargs):
        nonlocal target
        target = manager.runtime.backend.config_path
        raise OSError("spawn failed")
    monkeypatch.setattr(manager.runtime, "_spawn", AsyncMock(side_effect=fail))
    with pytest.raises(OSError, match="spawn failed"):
        await manager.start_armodule(blueprint="unitree_go2_ar")
    assert target is not None and not target.exists()
    assert manager.runtime.backend.config_path is None
    from armodule import Phase
    assert manager.status.phase is Phase.ERROR
    assert manager.status.error == "spawn failed"
    assert manager.runtime.backend.process is None
    monkeypatch.setattr(manager.runtime, "_spawn", original_spawn)
    await manager.start_armodule(blueprint="unitree_go2_ar")
    assert manager.status.phase is Phase.STARTING
    assert manager.runtime.backend.process is not None
