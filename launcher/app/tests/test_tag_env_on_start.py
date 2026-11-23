"""Start injects CLI secret env names and treats VPS setup as advisory."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from armodule import ProcessManager
from config import env_path, merge_env
from tag_config import DEFAULT_MOUNT, armodule_config_from_ui


def _scripts(tmp_path: Path) -> None:
    (tmp_path / "launcher" / "scripts").mkdir(parents=True)
    (tmp_path / "launcher" / "scripts" / "start.sh").write_text(
        "#!/bin/sh\n", encoding="utf-8"
    )
    (tmp_path / "launcher" / "scripts" / "configure-system.sh").write_text(
        "#!/bin/sh\nexit 0\n", encoding="utf-8"
    )


@pytest.mark.asyncio
async def test_start_armodule_injects_secret_env(tmp_path: Path) -> None:
    _scripts(tmp_path)
    merge_env(
        {
            "OPENAI_API_KEY": "sk-persisted",
            "MULTISET_CLIENT_ID": "id-1",
            "MULTISET_CLIENT_SECRET": "secret-1",
            "DIMOS_LOG_LEVEL": "DEBUG",
        },
        env_path(tmp_path),
    )

    mgr = ProcessManager(root=tmp_path)
    captured: dict[str, str] = {}

    async def fake_spawn(argv, *, env):  # type: ignore[no-untyped-def]
        captured.update(env)

    with (
        patch.object(mgr, "port_in_use", return_value=False),
        patch.object(mgr, "_configure_system_if_needed", new=AsyncMock()),
        patch.object(mgr.runtime, "_spawn", new=fake_spawn),
    ):
        await mgr.start_armodule(blueprint="unitree_go2_ar")

    assert captured["OPENAI_API_KEY"] == "sk-persisted"
    assert captured["MULTISET_CLIENT_ID"] == "id-1"
    assert captured["MULTISET_CLIENT_SECRET"] == "secret-1"
    assert captured["DIMOS_LOG_LEVEL"] == "DEBUG"
    assert captured["DIMOS_AR_LAUNCHER_CONNECTIONS"] == "1"
    assert captured["DIMOS_AR_LAUNCHER_KEEP_AWAKE"] == "1"
    assert "DIMOS_AR_TAG_MOUNTS" not in captured
    assert "DIMOS_PYTHON" not in captured
    assert "--blueprint" in mgr.build_start_argv(blueprint="unitree_go2_ar")


@pytest.mark.asyncio
async def test_selected_can_uses_the_openyam_connection_config(runtime, monkeypatch):
    manager, _, spawn = runtime
    monkeypatch.setenv("CAN_PORT", "old-can")
    monkeypatch.setenv("OPENYAMCONNECTION__CAN_PORT", "stale-selection")
    monkeypatch.setattr("armodule.check_can", AsyncMock(return_value={"ready": True}))
    await manager.start_armodule(blueprint="openyam_ar_planner", can_port="can2")
    env = spawn.call_args.kwargs["env"]
    assert env["OPENYAMCONNECTION__CAN_PORT"] == "can2"
    assert "CAN_PORT" not in env


@pytest.mark.asyncio
async def test_start_armodule_pins_checked_dimos_python(tmp_path: Path) -> None:
    _scripts(tmp_path)
    mgr = ProcessManager(root=tmp_path)
    mgr.dependencies.update_status(dimos_python="/tmp/dimos/.venv/bin/python3")
    captured: dict[str, str] = {}

    async def fake_spawn(argv, *, env):  # type: ignore[no-untyped-def]
        captured.update(env)

    with (
        patch.object(mgr, "port_in_use", return_value=False),
        patch.object(mgr, "_configure_system_if_needed", new=AsyncMock()),
        patch.object(mgr.runtime, "_spawn", new=fake_spawn),
    ):
        await mgr.start_armodule(blueprint="unitree_go2_ar")

    assert captured["DIMOS_PYTHON"] == "/tmp/dimos/.venv/bin/python3"


@pytest.mark.asyncio
async def test_start_armodule_drops_inherited_dimos_python(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _scripts(tmp_path)
    monkeypatch.setenv(
        "DIMOS_PYTHON",
        "/Users/me/.local/share/uv/python/cpython-3.12.12/bin/python3.12",
    )
    mgr = ProcessManager(root=tmp_path)
    captured: dict[str, str] = {}

    async def fake_spawn(argv, *, env):  # type: ignore[no-untyped-def]
        captured.update(env)

    with (
        patch.object(mgr, "port_in_use", return_value=False),
        patch.object(mgr, "_configure_system_if_needed", new=AsyncMock()),
        patch.object(mgr.runtime, "_spawn", new=fake_spawn),
    ):
        await mgr.start_armodule(blueprint="unitree_go2_ar")

    assert "DIMOS_PYTHON" not in captured


@pytest.mark.asyncio
async def test_start_armodule_defaults_log_level_to_info(tmp_path: Path) -> None:
    _scripts(tmp_path)
    mgr = ProcessManager(root=tmp_path)
    captured: dict[str, str] = {}

    async def fake_spawn(argv, *, env):  # type: ignore[no-untyped-def]
        captured.update(env)

    with (
        patch.object(mgr, "port_in_use", return_value=False),
        patch.object(mgr, "_configure_system_if_needed", new=AsyncMock()),
        patch.object(mgr.runtime, "_spawn", new=fake_spawn),
    ):
        await mgr.start_armodule(blueprint="unitree_go2_ar")

    assert captured["DIMOS_LOG_LEVEL"] == "INFO"


@pytest.mark.asyncio
@pytest.mark.parametrize("configured", [False, True])
async def test_start_armodule_skips_only_unconfigured_vps(runtime, monkeypatch, configured) -> None:
    mgr, _children, _spawn = runtime
    for key in ("MULTISET_CLIENT_ID", "MULTISET_CLIENT_SECRET"):
        monkeypatch.delenv(key, raising=False)
        if configured:
            monkeypatch.setenv(key, "value")
    configuration = armodule_config_from_ui(
        fiducial_marker=True,
        vps=True,
        map_code="office",
        mounts=[DEFAULT_MOUNT],
    )
    await mgr.start_armodule(blueprint="unitree_go2_ar", armodule_config=configuration)

    assert mgr.runtime.backend.config_path is not None
    config = json.loads(mgr.runtime.backend.config_path.read_text())["armodule"]
    providers = configuration["localization"]["providers"]
    assert [provider["type"] for provider in providers] == ["fiducial_marker", "vps"]
    assert config["localization"]["providers"] == (providers if configured else providers[:1])
    if configured:
        assert mgr.status.warning is None
    else:
        assert mgr.status.warning is not None and "VPS unavailable" in mgr.status.warning
