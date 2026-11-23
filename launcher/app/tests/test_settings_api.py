"""Settings persistence must read launcher/.env, not the repo directory."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

import app as launcher_app
from config import env_path, merge_env, read_env
from tag_config import ui_from_armodule_config


def test_marker_preference_default_and_explicit_override() -> None:
    assert launcher_app.SettingsBody().marker_preference_s == 3
    assert ui_from_armodule_config({})["marker_preference_s"] == 3
    assert launcher_app.SettingsBody(marker_preference_s=1.5).marker_preference_s == 1.5
    assert ui_from_armodule_config({"localization": {"marker_preference_s": 1.5}})[
        "marker_preference_s"
    ] == 1.5


def test_settings_read_uses_launcher_env_file(app_context, tmp_path: Path, monkeypatch) -> None:
    target = env_path(tmp_path)
    merge_env({"OPENAI_API_KEY": "sk-test"}, target)
    (tmp_path / ".env").write_text("OPENAI_API_KEY=wrong-legacy-location\n")
    app_context.settings_path = target
    assert launcher_app.settings_payload(context=app_context)["openai_api_key"] == "sk-test"


def test_root_env_is_not_imported(tmp_path: Path) -> None:
    from armodule import ProcessManager

    (tmp_path / ".env").write_text("OPENAI_API_KEY=ignored\nROBOT_IP=1.2.3.4\n")
    ProcessManager(root=tmp_path)
    assert not env_path(tmp_path).exists()


@pytest.mark.asyncio
async def test_settings_put_does_not_run_dependency_check(app_context, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "launcher").mkdir()
    target = env_path(tmp_path)
    app_context.settings_path = target
    monkeypatch.setattr(app_context.manager, "root", tmp_path)

    with patch.object(app_context.manager, "run_check", new=AsyncMock()) as mock_check:
        snap = await launcher_app.api_settings_put(
            launcher_app.SettingsBody(openai_api_key="sk-test"),
        context=app_context)

    mock_check.assert_not_called()
    assert read_env(target)["OPENAI_API_KEY"] == "sk-test"
    assert snap["openai_api_key"] == "sk-test"
    assert snap["fiducial_marker"] is False
    assert snap["dimos_log_level"] == "INFO"


@pytest.mark.asyncio
async def test_settings_put_writes_dimos_log_level(
    app_context,
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "launcher").mkdir()
    target = env_path(tmp_path)
    app_context.settings_path = target
    monkeypatch.setattr(app_context.manager, "root", tmp_path)

    snap = await launcher_app.api_settings_put(
        launcher_app.SettingsBody(dimos_log_level="DEBUG"),
    context=app_context)

    assert read_env(target)["DIMOS_LOG_LEVEL"] == "DEBUG"
    assert snap["dimos_log_level"] == "DEBUG"


@pytest.mark.asyncio
async def test_settings_put_writes_selected_profile(
    app_context,
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    (tmp_path / "launcher").mkdir()
    target = env_path(tmp_path)
    app_context.settings_path = target
    monkeypatch.setattr(app_context.manager, "root", tmp_path)

    profile = app_context.robot_profiles.all()[0]
    snap = await launcher_app.api_settings_put(
        launcher_app.SettingsBody(
            profile_id=profile["id"],
            fiducial_marker=True,
            vps=True,
            map_code="map-9",
            mounts=[launcher_app.MountBody()],
            openai_api_key="sk-test",
        )
    , context=app_context)

    data = app_context.robot_profiles.get(profile["id"])
    assert data["armodule"]["localization"]["providers"] == [
        {"type": "fiducial_marker"},
        {"type": "vps", "map_code": "map-9"},
    ]
    assert data["armodule"]["fiducial_marker_mounts"][0]["marker_id"] == 0
    assert snap["fiducial_marker"] is True
    assert snap["vps"] is True
    assert snap["map_code"] == "map-9"
    assert snap["mounts"][0]["marker_id"] == 0


@pytest.mark.asyncio
async def test_settings_put_writes_multiple_fiducial_mounts(
    app_context,
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    (tmp_path / "launcher").mkdir()
    app_context.settings_path = env_path(tmp_path)
    monkeypatch.setattr(app_context.manager, "root", tmp_path)

    profile = app_context.robot_profiles.all()[0]
    snap = await launcher_app.api_settings_put(
        launcher_app.SettingsBody(
            profile_id=profile["id"],
            fiducial_marker=True,
            mounts=[
                launcher_app.MountBody(marker_id=0),
                launcher_app.MountBody(marker_id=2, forward_m=0.1),
            ],
        )
    , context=app_context)

    data = app_context.robot_profiles.get(profile["id"])
    assert [item["marker_id"] for item in data["armodule"]["fiducial_marker_mounts"]] == [0, 2]
    assert [item["marker_id"] for item in snap["mounts"]] == [0, 2]


@pytest.mark.asyncio
async def test_settings_put_rejects_duplicate_marker_ids(
    app_context,
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import HTTPException

    (tmp_path / "launcher").mkdir()
    app_context.settings_path = env_path(tmp_path)
    monkeypatch.setattr(app_context.manager, "root", tmp_path)

    profile = app_context.robot_profiles.all()[0]
    with pytest.raises(HTTPException) as exc_info:
        await launcher_app.api_settings_put(
            launcher_app.SettingsBody(
                profile_id=profile["id"],
                fiducial_marker=True,
                mounts=[
                    launcher_app.MountBody(marker_id=0),
                    launcher_app.MountBody(marker_id=0),
                ],
            )
        , context=app_context)
    assert exc_info.value.status_code == 400
    assert "unique" in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_profile_settings_response_uses_saved_profile(app_context, tmp_path, monkeypatch):
    from robot_profiles import RobotProfiles

    monkeypatch.setattr(app_context, "robot_profiles", RobotProfiles(tmp_path / "profiles.json"))
    app_context.settings_path = tmp_path / "launcher.env"
    profile = app_context.robot_profiles.create("unitree_go2")
    response = await launcher_app.api_settings_put(
        launcher_app.SettingsBody(profile_id=profile["id"], fiducial_marker=True)
    , context=app_context)
    assert response["fiducial_marker"] is True
    assert launcher_app.settings_payload(context=app_context)["fiducial_marker"] is False


@pytest.mark.asyncio
async def test_calibration_without_profile_is_rejected_without_persisting(app_context, tmp_path, monkeypatch):
    from fastapi import HTTPException

    from dimos_config import dimos_config_path

    target = dimos_config_path()
    target.parent.mkdir(parents=True)
    target.write_text('{"armodule":{"localization":{"providers":[]}}}')
    original = target.read_text()
    app_context.settings_path = tmp_path / "launcher.env"
    with pytest.raises(HTTPException, match="Calibration settings require"):
        await launcher_app.api_settings_put(launcher_app.SettingsBody(fiducial_marker=True), context=app_context)
    assert target.read_text() == original
    assert not (tmp_path / "launcher.env").exists()


@pytest.mark.parametrize("origin,fetch_site,allowed", [
    ("http://localhost:8790", "same-origin", True),
    ("https://unrelated.example", "cross-site", False),
    (None, None, True),
    (None, "cross-site", False),
])
def test_launcher_mutation_origin_boundary(origin, fetch_site, allowed):
    from fastapi import HTTPException
    from starlette.requests import Request

    headers = [(b"host", b"localhost:8790")]
    if origin:
        headers.append((b"origin", origin.encode()))
    if fetch_site:
        headers.append((b"sec-fetch-site", fetch_site.encode()))
    request = Request({"type": "http", "method": "POST", "scheme": "http",
                       "path": "/api/armodule/stop", "query_string": b"",
                       "headers": headers, "server": ("localhost", 8790),
                       "client": ("127.0.0.1", 1234)})
    if allowed:
        launcher_app.require_local_launcher(request)
    else:
        with pytest.raises(HTTPException) as error:
            launcher_app.require_local_launcher(request)
        assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_cross_origin_stop_never_dispatches(app_context, monkeypatch):
    from httpx import ASGITransport, AsyncClient

    stop = AsyncMock()
    monkeypatch.setattr(app_context.manager, "stop_armodule", stop)
    transport = ASGITransport(app=launcher_app.create_app(app_context), client=("127.0.0.1", 1234))
    async with AsyncClient(transport=transport, base_url="http://localhost:8790") as client:
        denied = await client.post("/api/armodule/stop?force=true",
                                   headers={"Origin": "https://unrelated.example"})
        assert denied.status_code == 403
        stop.assert_not_awaited()
        accepted = await client.post("/api/armodule/stop?force=true",
                                     headers={"Origin": "http://localhost:8790"})
        assert accepted.status_code == 200
        stop.assert_awaited_once_with(force=True, include_previous=True)


@pytest.mark.asyncio
async def test_untrusted_host_cannot_read_launcher_settings(app_context, monkeypatch):
    from unittest.mock import Mock

    from httpx import ASGITransport, AsyncClient

    payload = Mock(return_value={"openai_api_key": "fake-secret"})
    monkeypatch.setattr(launcher_app, "settings_payload", payload)
    transport = ASGITransport(app=launcher_app.create_app(app_context), client=("127.0.0.1", 1234))
    async with AsyncClient(transport=transport, base_url="http://unrelated.example") as client:
        response = await client.get("/api/settings")
    assert response.status_code == 403
    payload.assert_not_called()


@pytest.mark.asyncio
async def test_local_boundary_applies_to_status_routes_too(app_context, monkeypatch):
    from unittest.mock import Mock

    from httpx import ASGITransport, AsyncClient

    snapshot = Mock(return_value={})
    monkeypatch.setattr(app_context.manager, "snapshot", snapshot)
    transport = ASGITransport(app=launcher_app.create_app(app_context), client=("127.0.0.1", 1234))
    async with AsyncClient(transport=transport, base_url="http://unrelated.example") as client:
        response = await client.get("/api/status")
    assert response.status_code == 403
    snapshot.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("saved", ["[]", "{broken"] )
async def test_invalid_preferences_are_reported_and_preserved(app_context, tmp_path, saved):
    from fastapi import HTTPException

    target = tmp_path / "preferences.json"
    target.write_text(saved)
    app_context.preferences_path = target
    with pytest.raises(HTTPException) as error:
        await launcher_app.api_preferences_get(context=app_context)
    assert error.value.status_code == 400
    assert "Invalid launcher preferences" in error.value.detail
    assert target.read_text() == saved


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["openai_api_key", "multiset_client_id", "multiset_client_secret"])
@pytest.mark.parametrize("separator", ["\n", "\r", "\x85", "\u2028", "\0"])
async def test_multiline_credentials_reject_before_profile_or_env_write(app_context, tmp_path, monkeypatch, field, separator):
    from fastapi import HTTPException

    from robot_profiles import RobotProfiles

    profiles = RobotProfiles(tmp_path / "profiles.json")
    profile = profiles.create("unitree_go2")
    original_profiles = profiles.path.read_bytes()
    target = tmp_path / "launcher.env"
    target.write_text("OPENAI_API_KEY=unchanged\n")
    original_env = target.read_bytes()
    monkeypatch.setattr(app_context, "robot_profiles", profiles)
    app_context.settings_path = target
    body = launcher_app.SettingsBody(
        profile_id=profile["id"], fiducial_marker=True,
        **{field: f"abc{separator}MULTISET_CLIENT_ID=changed"},
    )
    with pytest.raises(HTTPException) as error:
        await launcher_app.api_settings_put(body, context=app_context)
    assert error.value.status_code == 400
    assert profiles.path.read_bytes() == original_profiles
    assert target.read_bytes() == original_env


@pytest.mark.asyncio
async def test_credentials_preserve_outer_trim_quotes_and_blank_deletion(app_context, tmp_path, monkeypatch):
    target = tmp_path / "launcher.env"
    target.write_text("MULTISET_CLIENT_SECRET=old\n")
    app_context.settings_path = target
    monkeypatch.setattr(app_context.manager, "root", tmp_path)
    await launcher_app.api_settings_put(launcher_app.SettingsBody(
        openai_api_key=' \n"sk-test"\r ', multiset_client_secret=" \t\n",
    ), context=app_context)
    assert read_env(target) == {"OPENAI_API_KEY": "sk-test"}


@pytest.mark.asyncio
async def test_mixed_settings_put_rolls_back_profile_on_env_write_failure(app_context, monkeypatch) -> None:
    profile = app_context.robot_profiles.create("openyam")
    before = app_context.robot_profiles.path.read_bytes()

    def fail_write(*args: object) -> None:
        raise OSError("write failed")

    monkeypatch.setattr(launcher_app, "merge_env", fail_write)
    with pytest.raises(OSError, match="write failed"):
        await launcher_app.api_settings_put(launcher_app.SettingsBody(
            profile_id=profile["id"], fiducial_marker=False, openai_api_key="test",
        ), context=app_context)
    assert app_context.robot_profiles.path.read_bytes() == before
