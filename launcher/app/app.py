"""Thin FastAPI UI wrapper around launcher/scripts/setup.sh and start.sh."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal, cast
from urllib.parse import urlsplit

from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    File,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from apriltag_assets import decode_marker_id, ensure_pdf, ensure_png
from armodule import ProcessManager
from can_setup import INTERFACE
from command_capture import capture_command
from config import (
    DEFAULT_LOG_LEVEL,
    LOG_LEVELS,
    env_path,
    merge_env,
    normalize_log_level,
    read_env,
    validate_env_value,
)
from dimos_installation import check_setup_location, resolve_dimos_python
from discovery import discover_devices, validate_replay
from robot_profiles import RobotProfiles, default_mount
from robot_sources import (
    BLUEPRINTS,
    SourceBody,
    SourceSelectionRequired,
    blueprint_definition,
    blueprint_metadata,
    resolve_robot_source,
)
from tag_config import (
    DEFAULT_MOUNT,
    LOCALIZATION_POLICY_DEFAULTS,
    PRESET_MARKER_IDS,
    normalize_ui_mounts,
    ui_from_armodule_config,
)

STATIC_DIR = Path(__file__).resolve().parent / "static"
DIMOS_REMOTE = "https://github.com/dimensionalOS/dimos"
logger = logging.getLogger(__name__)
@dataclass
class LauncherContext:
    manager: ProcessManager
    robot_profiles: RobotProfiles
    settings_path: Path | None = None
    preferences_path: Path | None = None

    @property
    def settings_file(self) -> Path:
        return self.settings_path or env_path(self.manager.root)

    @property
    def preferences_file(self) -> Path:
        return self.preferences_path or self.robot_profiles.path.with_name("ar-launcher.json")


def get_context(request: Request) -> LauncherContext:
    return cast(LauncherContext, request.app.state.launcher)


ContextDependency = Annotated[LauncherContext, Depends(get_context)]
setup_routes = APIRouter()
runtime_routes = APIRouter()
configuration_routes = APIRouter()


def require_local_launcher(request: Request) -> None:
    """Reject non-loopback clients (server binds 127.0.0.1 only)."""
    client = request.client.host if request.client else ""
    if client not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="launcher is localhost-only")
    if request.url.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise HTTPException(status_code=403, detail="untrusted launcher host")
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        origin = request.headers.get("origin")
        if origin:
            parsed = urlsplit(origin)
            if (parsed.scheme, parsed.netloc) != (request.url.scheme, request.url.netloc):
                raise HTTPException(status_code=403, detail="launcher requires same-origin requests")
        if request.headers.get("sec-fetch-site") == "cross-site":
            raise HTTPException(status_code=403, detail="cross-site launcher request")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    manager = _app.state.launcher.manager
    check_task = asyncio.create_task(manager.ensure_check())
    try:
        yield
    finally:
        if not check_task.done():
            check_task.cancel()
            try:
                await check_task
            except asyncio.CancelledError:
                pass
        try:
            await manager.stop_armodule()
        except Exception:
            logger.exception("ARModule stop during launcher shutdown failed")




class SetupBody(BaseModel):
    manipulation: bool = False
    mode: Literal["existing", "clone"] = "clone"
    dimos_python: str | None = None
    clone_dir: str | None = None
    dimos_ref: str | None = None


class StartBody(BaseModel):
    model_config = {"extra": "forbid"}

    takeover_pids: list[int] | None = None
    source: SourceBody
    profile_id: str
    blueprint: str = Field(json_schema_extra={"enum": list(BLUEPRINTS)})

    @field_validator("blueprint")
    @classmethod
    def known_blueprint(cls, value: str) -> str:
        return blueprint_definition(value).id


class MountBody(BaseModel):
    model_config = {"extra": "forbid"}

    marker_id: int = DEFAULT_MOUNT["marker_id"]
    print_size_mm: float = DEFAULT_MOUNT["print_size_mm"]
    forward_m: float = DEFAULT_MOUNT["forward_m"]
    lateral_m: float = DEFAULT_MOUNT["lateral_m"]
    up_m: float = DEFAULT_MOUNT["up_m"]
    yaw_deg: float = DEFAULT_MOUNT["yaw_deg"]
    pitch_deg: float = DEFAULT_MOUNT["pitch_deg"]
    roll_deg: float = DEFAULT_MOUNT["roll_deg"]


class SettingsBody(BaseModel):
    model_config = {"extra": "forbid"}

    travel_threshold_m: float = Field(
        default=LOCALIZATION_POLICY_DEFAULTS["travel_threshold_m"], gt=0, allow_inf_nan=False
    )
    heading_threshold_deg: float = Field(
        default=LOCALIZATION_POLICY_DEFAULTS["heading_threshold_deg"], gt=0, le=180, allow_inf_nan=False
    )
    marker_preference_s: float = Field(
        default=LOCALIZATION_POLICY_DEFAULTS["marker_preference_s"], ge=0, allow_inf_nan=False
    )
    headset_travel_threshold_m: float = Field(
        default=LOCALIZATION_POLICY_DEFAULTS["headset_travel_threshold_m"], gt=0, allow_inf_nan=False
    )
    profile_id: str | None = None
    openai_api_key: str | None = None
    multiset_client_id: str | None = None
    multiset_client_secret: str | None = None
    fiducial_marker: bool = False
    vps: bool = False
    vps_vendor: Literal["multiset"] = "multiset"
    map_code: str | None = None
    native_map_file: str | None = None
    mounts: list[MountBody] | None = None
    dimos_log_level: str | None = Field(
        default=None, json_schema_extra={"enum": [*sorted(LOG_LEVELS), None]}
    )

    @field_validator("dimos_log_level")
    @classmethod
    def known_log_level(cls, value: str | None) -> str | None:
        if value is not None and value not in LOG_LEVELS:
            raise ValueError("Unknown log level")
        return value


def _blank_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def settings_payload(profile_id: str | None = None, *, context: LauncherContext) -> dict[str, Any]:
    stored = read_env(context.settings_file)
    profile = context.robot_profiles.get(profile_id) if profile_id else None
    ui = ui_from_armodule_config(
        profile["armodule"] if profile else {},
        default_mount=default_mount(profile["robot"]) if profile else None,
    )
    return {
        "openai_api_key": stored.get("OPENAI_API_KEY", ""),
        "multiset_client_id": stored.get("MULTISET_CLIENT_ID", ""),
        "multiset_client_secret": stored.get("MULTISET_CLIENT_SECRET", ""),
        "dimos_log_level": normalize_log_level(stored.get("DIMOS_LOG_LEVEL")),
        "fiducial_marker": ui["fiducial_marker"],
        "vps": ui["vps"],
        "vps_vendor": ui["vps_vendor"],
        "map_code": ui["map_code"],
        "native_map_file": ui["native_map_file"],
        "mounts": ui["mounts"],
        **{key: ui[key] for key in LOCALIZATION_POLICY_DEFAULTS},
        "defaults": {
            "blueprints": blueprint_metadata(),
            "log_levels": sorted(LOG_LEVELS),
            "log_level": DEFAULT_LOG_LEVEL,
            "mounts": [dict(DEFAULT_MOUNT)],
            "mounts_by_robot": {item.robot: [default_mount(item.robot)] for item in BLUEPRINTS.values()},
            "preset_marker_ids": list(PRESET_MARKER_IDS),
            "localization": dict(LOCALIZATION_POLICY_DEFAULTS),
        },
    }


def _parse_dimos_refs(raw: str) -> list[str]:
    refs: list[str] = []
    seen: set[str] = set()
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        name = parts[1]
        if name.endswith("^{}"):
            continue
        prefix = "refs/heads/"
        tag_prefix = "refs/tags/"
        if name.startswith(prefix):
            short = name[len(prefix) :]
        elif name.startswith(tag_prefix):
            short = name[len(tag_prefix) :]
        else:
            continue
        if short in seen:
            continue
        seen.add(short)
        refs.append(short)
    if "main" in seen:
        refs.remove("main")
        refs.insert(0, "main")
    return refs


@runtime_routes.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@runtime_routes.get("/api/status")
async def api_status(context: ContextDependency) -> dict[str, Any]:
    return context.manager.snapshot()


@setup_routes.get("/api/dimos-refs")
async def api_dimos_refs(context: ContextDependency) -> dict[str, Any]:
    try:
        code, out, err = await capture_command(
            "git", "ls-remote", "--heads", "--tags", DIMOS_REMOTE, timeout=15
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail="git is required to list DimOS refs") from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Timed out listing DimOS refs") from exc
    if code:
        detail = err.decode("utf-8", errors="replace").strip() or "git ls-remote failed"
        raise HTTPException(status_code=502, detail=detail)
    refs = _parse_dimos_refs(out.decode("utf-8", errors="replace"))
    return {"refs": refs, "default": (context.manager.root / ".dimos-revision").read_text().strip()}


class BrowseInstallBody(BaseModel):
    path: str = ""


@setup_routes.post("/api/browse-dimos-install")
async def api_browse_dimos_install(body: BrowseInstallBody) -> dict[str, str | None]:
    """Open a native folder chooser for an existing DimOS installation."""
    current = body.path.strip()
    start_dir = Path(current).expanduser() if current else Path.home()
    if start_dir.is_file():
        start_dir = start_dir.parent
    if start_dir.name == "bin" and start_dir.parent.name in {".venv", "venv"}:
        start_dir = start_dir.parent.parent
    if start_dir.name in {".venv", "venv"}:
        start_dir = start_dir.parent
    start_dir = start_dir if start_dir.is_dir() else Path.home()
    return {"path": await _choose_path("Select DimOS installation", directory=start_dir)}


async def _choose_path(
    title: str, *, directory: Path | None = None, file_filter: str | None = None
) -> str | None:
    if not _has_display():
        raise HTTPException(status_code=409, detail="Enter a local path; no desktop chooser is available")
    if sys.platform == "darwin":
        kind = "folder" if directory is not None else "file"
        location = f" default location (POSIX file {json.dumps(str(directory), ensure_ascii=False)})" if directory else ""
        script = f"POSIX path of (choose {kind} with prompt {json.dumps(title)}{location})"
        command = ["osascript", "-e", script]
    else:
        chooser = shutil.which("zenity")
        if not chooser:
            raise HTTPException(status_code=501, detail="Enter a local path or install zenity")
        command = [chooser, "--file-selection", f"--title={title}"]
        if directory is not None:
            command.extend(["--directory", f"--filename={directory}/"])
        if file_filter:
            command.append(f"--file-filter={file_filter}")
    try:
        code, out, _ = await capture_command(*command)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=501, detail="A native chooser is unavailable") from exc
    return (out.decode(errors="replace").strip() or None) if code == 0 else None


def _has_display() -> bool:
    return sys.platform == "darwin" or bool(
        os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
    )


@setup_routes.post("/api/setup/location")
async def api_setup_location(body: SetupBody) -> dict[str, str]:
    try:
        path = body.dimos_python if body.mode == "existing" else body.clone_dir
        return await asyncio.to_thread(check_setup_location, body.mode, path)
    except (OSError, ValueError):
        return {"state": "invalid", "message": "Could not access this location."}


@setup_routes.post("/api/setup")
async def api_setup(body: SetupBody, context: ContextDependency) -> dict[str, Any]:
    try:
        if body.mode == "existing":
            if not body.dimos_python or not body.dimos_python.strip():
                raise HTTPException(status_code=400, detail="dimos_python is required")
            dimos_python = await asyncio.to_thread(
                resolve_dimos_python, body.dimos_python.strip()
            )
            await context.manager.run_setup(
                dimos_python=dimos_python,
                manipulation=body.manipulation,
            )
        else:
            raw_folder = (body.clone_dir or "").strip()
            clone_dir = (
                Path(raw_folder).expanduser().absolute()
                if raw_folder else context.manager.root.parent / "dimos"
            )
            dimos_ref = (body.dimos_ref or "").strip() or None
            await context.manager.run_setup(
                clone_dir=str(clone_dir),
                dimos_ref=dimos_ref,
                manipulation=body.manipulation,
            )
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return context.manager.snapshot()


@setup_routes.post("/api/check")
async def api_check(context: ContextDependency) -> dict[str, Any]:
    try:
        return await context.manager.run_check()
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@configuration_routes.get("/api/settings")
async def api_settings_get(context: ContextDependency) -> dict[str, Any]:
    return settings_payload(context=context)


@setup_routes.get("/api/can/status")
async def api_can_status(interface: str = INTERFACE, *, context: ContextDependency) -> dict[str, Any]:
    return await context.manager.can_status(interface) if interface != INTERFACE else await context.manager.can_status()


@setup_routes.post("/api/can/setup")
async def api_can_setup(interface: str = INTERFACE, *, context: ContextDependency) -> dict[str, Any]:
    try:
        return await context.manager.setup_can(interface) if interface != INTERFACE else await context.manager.setup_can()
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@setup_routes.get("/api/planner/status")
async def api_planner_status(context: ContextDependency) -> dict[str, Any]:
    return await context.manager.planner_status()


@configuration_routes.put("/api/settings")
async def api_settings_put(body: SettingsBody, context: ContextDependency) -> dict[str, Any]:
    if not context.manager.can_edit_configuration:
        raise HTTPException(
            status_code=409, detail="stop ARModule before editing settings"
        )
    try:
        env_updates = {
            key: _blank_to_none(getattr(body, field))
            for field, key in (
                ("openai_api_key", "OPENAI_API_KEY"),
                ("multiset_client_id", "MULTISET_CLIENT_ID"),
                ("multiset_client_secret", "MULTISET_CLIENT_SECRET"),
            )
            if field in body.model_fields_set
        }
        if "dimos_log_level" in body.model_fields_set:
            env_updates["DIMOS_LOG_LEVEL"] = normalize_log_level(body.dimos_log_level)
        for value in env_updates.values():
            validate_env_value(value)
        mounts = normalize_ui_mounts(
            [item.model_dump() for item in body.mounts]
            if body.mounts is not None
            else None
        )
        settings = body.model_dump(exclude_unset=True)
        if "mounts" in settings:
            settings["mounts"] = mounts
        if body.profile_id and env_updates:
            with context.robot_profiles.rollback_on_error():
                context.robot_profiles.update(body.profile_id, settings=settings)
                merge_env(env_updates, context.settings_file)
        elif body.profile_id:
            context.robot_profiles.update(body.profile_id, settings=settings)
        elif body.model_fields_set & {
            "fiducial_marker", "vps", "vps_vendor", "map_code", "native_map_file", "mounts",
            *LOCALIZATION_POLICY_DEFAULTS,
        }:
            raise ValueError("Calibration settings require a robot profile")
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if env_updates and not body.profile_id:
        merge_env(env_updates, context.settings_file)
    return {**context.manager.snapshot(), **settings_payload(body.profile_id, context=context)}


@configuration_routes.get("/api/apriltag/{tag_id}.png")
async def api_apriltag_png(tag_id: int) -> FileResponse:
    try:
        path = ensure_png(tag_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return FileResponse(path, media_type="image/png")


@configuration_routes.get("/api/apriltag/{tag_id}.pdf")
async def api_apriltag_pdf(tag_id: int, size_mm: float = 70.0) -> FileResponse:
    try:
        path = ensure_pdf(tag_id, print_size_mm=size_mm)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return FileResponse(path, media_type="application/pdf")


@configuration_routes.post("/api/apriltag/decode")
async def api_apriltag_decode(file: Annotated[UploadFile, File()]) -> dict[str, Any]:
    filename = (file.filename or "").lower()
    if not filename.endswith(".png"):
        raise HTTPException(
            status_code=400, detail="upload a PNG of an AprilTag 36h11 marker"
        )
    data = await file.read()
    try:
        marker_id = decode_marker_id(data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"marker_id": marker_id}


@runtime_routes.post("/api/armodule/start")
async def api_armodule_start(body: StartBody, context: ContextDependency) -> dict[str, Any]:
    try:
        return await context.manager.run_launch_attempt(lambda: prepare_and_start(body, context))
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


async def prepare_and_start(body: StartBody, context: LauncherContext) -> dict[str, Any]:
    source = body.source
    robot = blueprint_definition(body.blueprint).robot
    python = context.manager.selected_python
    devices = []
    if source.mode in {"auto", "device"}:
        if not python:
            raise HTTPException(status_code=409, detail="Select a DimOS environment first")
        try:
            devices = await discover_devices(python, robot)
        except (TypeError, ValueError, OSError, TimeoutError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        resolved = resolve_robot_source(robot, source, devices)
    except SourceSelectionRequired as exc:
        raise HTTPException(status_code=409, detail={
            "message": str(exc), "suggest_simulated": exc.suggest_simulated,
            "devices": exc.devices,
        }) from exc
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    robot_ip, can_port, simulation, replay = resolved.robot_ip, resolved.can_port, resolved.simulation, resolved.replay
    replay_streams = source.streams
    if replay:
        if not python:
            raise HTTPException(status_code=409, detail="Select a DimOS environment first")
        try:
            info = await validate_replay(python, replay, robot, replay_streams)
            if info["needs_selection"]:
                raise ValueError("Select recording streams before starting")
            replay_streams = info["streams"]
        except (TypeError, ValueError, OSError, TimeoutError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if python != context.manager.selected_python:
        raise HTTPException(status_code=409, detail="DimOS environment changed during startup")
    try:
        await context.manager.start_armodule(
            blueprint=body.blueprint,
            takeover_pids=body.takeover_pids,
            robot_ip=robot_ip,
            armodule_config=context.robot_profiles.snapshot(body.profile_id, body.blueprint),
            simulation=simulation,
            can_port=can_port,
            replay=replay,
            replay_streams=replay_streams if replay else None,
        )
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not start ARModule: {exc}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return context.manager.snapshot()


@runtime_routes.post("/api/armodule/stop")
async def api_armodule_stop(force: bool = False, *, context: ContextDependency) -> dict[str, Any]:
    await context.manager.stop_armodule(force=force, include_previous=True)
    return context.manager.snapshot()


@runtime_routes.post("/api/webxr/start")
async def api_webxr_start(context: ContextDependency) -> dict[str, Any]:
    try:
        await context.manager.start_webxr()
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return context.manager.snapshot()


@runtime_routes.post("/api/webxr/stop")
async def api_webxr_stop(context: ContextDependency) -> dict[str, Any]:
    await context.manager.stop_webxr()
    return context.manager.snapshot()


@runtime_routes.post("/api/backend/stop")
async def api_backend_stop(context: ContextDependency) -> dict[str, Any]:
    await context.manager.stop_backend()
    return context.manager.snapshot()


@runtime_routes.get("/api/events")
async def api_events(context: ContextDependency) -> StreamingResponse:
    async def event_stream() -> AsyncIterator[str]:
        async for event in context.manager.subscribe():
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


class RobotProfileBody(BaseModel):
    name: str | None = None
    robot: Literal["unitree_go2", "openyam"] = "unitree_go2"
    source_id: str | None = None


@configuration_routes.get("/api/robot-profiles")
async def api_robot_profiles(context: ContextDependency) -> dict[str, Any]:
    return {
        "profiles": [
            {
                **profile,
                "settings": ui_from_armodule_config(
                    profile["armodule"],
                    default_mount=default_mount(profile["robot"]),
                ),
            }
            for profile in context.robot_profiles.all()
        ]
    }


@configuration_routes.post("/api/robot-profiles")
async def api_create_robot_profile(body: RobotProfileBody, context: ContextDependency) -> dict[str, Any]:
    _require_profile_editable(context)
    try:
        return context.robot_profiles.create(body.robot, body.name, body.source_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@configuration_routes.put("/api/robot-profiles/{profile_id}"
)
async def api_rename_robot_profile(
    profile_id: str, body: RobotProfileBody, context: ContextDependency) -> dict[str, Any]:
    _require_profile_editable(context)
    try:
        if body.name is None:
            raise ValueError("A profile name is required")
        return context.robot_profiles.update(profile_id, name=body.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@configuration_routes.delete("/api/robot-profiles/{profile_id}"
)
async def api_delete_robot_profile(profile_id: str, context: ContextDependency) -> dict[str, bool]:
    _require_profile_editable(context)
    try:
        context.robot_profiles.delete(profile_id)
        return {"deleted": True}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@runtime_routes.get("/api/discovery")
async def api_discovery(robot: Literal["unitree_go2", "openyam"], context: ContextDependency) -> dict[str, Any]:
    python = context.manager.selected_python
    if not python:
        raise HTTPException(status_code=409, detail="Select a DimOS environment first")
    try:
        return {"devices": await discover_devices(python, robot)}
    except (TypeError, ValueError, OSError, TimeoutError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _require_profile_editable(context: LauncherContext) -> None:
    if not context.manager.can_edit_configuration:
        raise HTTPException(status_code=409, detail="Stop ARModule before editing profiles")


class ReplayBody(BaseModel):
    path: str
    robot: Literal["unitree_go2", "openyam"]
    streams: dict[str, str] = Field(default_factory=dict)


@runtime_routes.post("/api/replay/inspect")
async def api_inspect_replay(body: ReplayBody, context: ContextDependency) -> dict[str, Any]:
    if not context.manager.selected_python:
        raise HTTPException(status_code=409, detail="Select a DimOS environment first")
    try:
        return await validate_replay(context.manager.selected_python, body.path, body.robot, body.streams)
    except (TypeError, ValueError, OSError, TimeoutError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@runtime_routes.post("/api/browse-replay")
async def api_browse_replay() -> dict[str, str | None]:
    return {"path": await _choose_path("Select replay database", file_filter="Replay databases | *.db")}


class PreferencesBody(BaseModel):
    go2_source: str = "auto"
    openyam_source: str = "auto"
    replay: str = ""
    openyam_replay: str = ""
    replay_streams: dict[str, dict[str, str]] = Field(default_factory=dict)
    recordings: dict[str, list[str]] = Field(default_factory=dict)
    manual_ip: str = ""


@configuration_routes.get("/api/launcher-preferences")
async def api_preferences_get(context: ContextDependency) -> dict[str, Any]:
    import preferences

    try:
        return PreferencesBody.model_validate(preferences.read(context.preferences_file)).model_dump()
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid launcher preferences: {exc}") from exc


@configuration_routes.put("/api/launcher-preferences")
async def api_preferences_put(body: PreferencesBody, context: ContextDependency) -> dict[str, Any]:
    import preferences

    _require_profile_editable(context)
    preferences.save(body.model_dump(), context.preferences_file)
    return body.model_dump()



def create_app(context: LauncherContext | None = None) -> FastAPI:
    app = FastAPI(
        title="DimOS ARModule", lifespan=lifespan,
        dependencies=[Depends(require_local_launcher)],
    )
    app.state.launcher = context if context is not None else LauncherContext(
        ProcessManager(), RobotProfiles(),
    )
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
    for router in (setup_routes, runtime_routes, configuration_routes):
        app.include_router(router)
    return app
