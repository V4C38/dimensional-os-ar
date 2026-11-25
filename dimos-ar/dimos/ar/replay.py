"""Validated, read-only recordings without robot connections or control modules."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
import copy
from dataclasses import asdict, replace
from functools import partial
import heapq
import json
import math
import os
from pathlib import Path
from threading import Event
import time
from typing import Any, ClassVar

from dimos.ar.manipulation.model import ReferencePose
from dimos.ar.module import ARModule
from dimos.ar.robot.capabilities import Capability, CapabilityName
from dimos.ar.robot.odometry import RobotSourceClock
from dimos.ar.robot.profiles.profile import RobotName
from dimos.ar.websocket.protocol import encode_text
from dimos.core.core import rpc
from dimos.mapping.pointclouds.occupancy import HeightCostConfig, height_cost_occupancy
from dimos.memory.store.sqlite import SqliteStore
from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from dimos.msgs.nav_msgs.OccupancyGrid import OccupancyGrid
from dimos.msgs.nav_msgs.Path import Path as RecordedPath
from dimos.msgs.sensor_msgs.CameraInfo import CameraInfo
from dimos.msgs.sensor_msgs.Image import Image
from dimos.msgs.sensor_msgs.JointState import JointState
from dimos.msgs.sensor_msgs.PointCloud2 import PointCloud2
from dimos.msgs.std_msgs.Float32 import Float32
from dimos.navigation.go2.loop_closure.pgo_map import PGOMap
from dimos.robot.manipulators.openyam.joints import OPENYAM_ARM_JOINTS, OPENYAM_GRIPPER_JOINT
from dimos.utils.logging_config import setup_logger

logger = setup_logger()


def _openyam_joint_names(sample: JointState) -> list[str]:
    # Earlier OpenYAM recordings stored the same arm measurements without the robot namespace.
    return [f"arm/{name}" if name in OPENYAM_ARM_JOINTS else name for name in sample.name]


def inspect_recording(
    path: str, robot: str, selected: dict[str, str] | None = None
) -> dict[str, Any]:
    source = Path(path).expanduser()
    if source.suffix != ".db" or not source.is_file():
        raise ValueError("Choose an existing .db recording")
    store = SqliteStore(path=str(source), must_exist=True)
    store.start()
    try:
        required = (
            {"joints": JointState}
            if robot == "openyam"
            else {
                "odom": PoseStamped,
                "lidar": PointCloud2,
                "color_image": Image,
            }
        )
        optional = (
            {"gripper": Float32}
            if robot == "openyam"
            else {"camera_info": CameraInfo, "path": RecordedPath, "target": PoseStamped}
        )
        candidates: dict[str, list[str]] = {}
        streams: dict[str, str] = {}
        selected = selected or {}
        for role, expected in {**required, **optional}.items():
            candidates[role] = []
            for name in store.list_streams():
                if role == "target" and name == streams.get("odom"):
                    continue
                stream = store.stream(name)
                if not isinstance(stream.data_type, type) or not issubclass(
                    stream.data_type, expected
                ):
                    continue
                if stream.count() and isinstance(stream.first().data, expected):
                    candidates[role].append(name)
            choices = candidates[role]
            if role in selected and selected[role] not in choices:
                raise ValueError(f"Invalid {role} stream: {selected[role]}")
            if role in selected:
                streams[role] = selected[role]
            elif role == "target":
                targets = [name for name in choices if name.rsplit("/", 1)[-1] in
                           {"goal", "goal_request", "target"}]
                if len(targets) == 1:
                    streams[role] = targets[0]
            elif len(choices) == 1:
                streams[role] = choices[0]
            elif not choices and role in required:
                raise ValueError(f"Recording needs a nonempty {expected.__name__} stream ({role})")
        if robot == "openyam" and "joints" in streams:
            from dimos.robot.manipulators.openyam.config import make_openyam_model_config

            names = set(make_openyam_model_config(robot="arm").joint_names)
            for observation in store.stream(streams["joints"]):
                sample = observation.data
                sample_names = _openyam_joint_names(sample) if isinstance(sample, JointState) else []
                if (
                    not names.issubset(sample_names)
                    or len(set(sample_names)) != len(sample_names)
                    or len(sample.position) != len(sample_names)
                    or not all(math.isfinite(q) for q in sample.position)
                ):
                    raise ValueError(
                        "Every arm sample must contain all model joints with finite positions"
                    )
        if "gripper" in streams:
            for observation in store.stream(streams["gripper"]):
                sample = observation.data
                if (
                    not isinstance(sample, Float32)
                    or not math.isfinite(sample.data)
                    or not 0 <= sample.data <= 1
                ):
                    raise ValueError("Recorded gripper opening must be normalized 0-1")
        return {
            "streams": streams,
            "candidates": candidates,
            "needs_selection": any(role not in streams for role in required),
        }
    finally:
        store.stop()



class RecordingReader:
    """One worker owns the ordered stream cursors and the native mapper."""

    def __init__(self, path: str, bindings: dict[str, str], mapping: bool) -> None:
        self.store = SqliteStore(path=path, must_exist=True)
        self.store.start()
        self.streams = {role: self.store.stream(name).order_by("ts")
                        for role, name in bindings.items()}
        self.anchor = min(stream.first().ts for stream in self.streams.values())
        self.duration = float(max(stream.last().ts for stream in self.streams.values()) - self.anchor)
        self.mapping = mapping
        self.mapper: PGOMap | None = None
        self.cursors: dict[str, Iterator[Any]] = {}
        self.reset()

    def reset(self) -> None:
        if self.mapper is not None:
            self.mapper.dispose()
        self.mapper = PGOMap() if self.mapping else None
        self.latest: dict[str, Any] = {}
        self._close_cursors()
        self.cursors = {role: iter(stream) for role, stream in self.streams.items()}
        self.pending: list[tuple[float, int, str, Any]] = []
        self.position = -1.0
        self.grid: OccupancyGrid | None = None
        self.scan_count = 0
        self.grid_scan_count = 0
        for role in self.cursors:
            self._next(role)

    def _next(self, role: str) -> None:
        sample = next(self.cursors[role], None)
        if sample is not None:
            # A same-timestamp scan uses the odometry from that timestamp.
            priority = {"odom": 0, "camera_info": 1, "gripper": 2, "target": 3}.get(role, 4)
            heapq.heappush(self.pending, (float(sample.ts), priority, role, sample.data))

    def advance(
        self, elapsed: float, restore: bool, cancelled: Event, *, rasterize: bool = True
    ) -> tuple[list[tuple[str, Any]], OccupancyGrid | None]:
        if elapsed < self.position:
            self.reset()
        present: list[tuple[str, Any]] = []
        stamp = self.anchor + elapsed
        if restore:
            # Only odometry and LiDAR contribute to the cumulative mapper.
            # Push the other roles' seek through to the recording store.
            mapping_roles = {"odom", "lidar"} if self.mapper is not None else set()
            self.pending = [entry for entry in self.pending if entry[2] in mapping_roles]
            heapq.heapify(self.pending)
            for role, stream in self.streams.items():
                if role in mapping_roles:
                    continue
                if cancelled.is_set():
                    return [], None
                close = getattr(self.cursors[role], "close", None)
                if close is not None:
                    close()
                self.latest.pop(role, None)
                try:
                    observation = stream.time_range(self.anchor, stamp).last()
                except LookupError:
                    pass
                else:
                    sample = copy.copy(observation.data)
                    sample.ts = observation.ts
                    self.latest[role] = sample
                self.cursors[role] = iter(stream.after(stamp))
                self._next(role)
        while self.pending and self.pending[0][0] <= stamp and not cancelled.is_set():
            ts, _, role, msg = heapq.heappop(self.pending)
            sample = copy.copy(msg)
            sample.ts = ts
            self.latest[role] = sample
            self.position = max(self.position, float(ts - self.anchor))
            self._next(role)
            if not restore:
                present.append((role, sample))
            if role == "lidar" and self.mapper is not None and "odom" in self.latest:
                self.mapper.add(sample, self.latest["odom"])
                self.scan_count += 1
        if cancelled.is_set():
            return [], None
        self.position = elapsed
        if rasterize and self.mapper is not None and self.scan_count != self.grid_scan_count and (
            restore or self.grid is None or self.scan_count - self.grid_scan_count >= 5
            or not self.pending
        ):
            self.grid_scan_count = self.scan_count
            cloud = self.mapper.global_map()
            if len(cloud):
                self.grid = height_cost_occupancy(cloud, **asdict(HeightCostConfig()))
                return (list(self.latest.items()) if restore else present), self.grid
        return (list(self.latest.items()) if restore else present), self.grid if restore else None

    def _close_cursors(self) -> None:
        for cursor in self.cursors.values():
            close = getattr(cursor, "close", None)
            if close is not None:
                close()

    def close(self) -> None:
        if self.mapper is not None:
            self.mapper.dispose()
        self._close_cursors()
        self.store.stop()


class RecordedARModule(ARModule):
    """Publishes recording messages through the normal AR handlers at 1x, once."""

    _recording_source: ClassVar[bool] = True

    @rpc  # type: ignore[untyped-decorator]
    def build(self) -> None:
        super().build()
        # Playback translates producer timestamps once, before normal handlers.
        self._odometry.clock = RobotSourceClock()
        from dimos.memory.replay import resolve_db_path

        self._recording_path = os.environ.get("REPLAY_DB") or str(resolve_db_path("go2_short"))
        selected = json.loads(os.environ.get("DIMOS_AR_REPLAY_STREAMS", "{}"))
        if not os.environ.get("REPLAY_DB"):
            # The bundled Go2 dataset includes alternate embedded image streams;
            # retain its official connection's canonical stream binding.
            selected = {"odom": "odom", "lidar": "lidar", "color_image": "color_image", **selected}
        self._recording_robot = (
            "openyam" if self.config.robot == RobotName.OPENYAM else "unitree_go2"
        )
        info = inspect_recording(self._recording_path, self._recording_robot, selected)
        if info["needs_selection"]:
            raise ValueError("Choose the recording streams in the launcher")
        self._streams = info["streams"]
        unavailable = Capability(False, "Recording playback is read-only")
        self._capabilities = replace(
            self._capabilities,
            _items={
                name: unavailable
                if name in {CapabilityName.NAVIGATION, CapabilityName.AGENT, CapabilityName.ESTOP}
                else cap
                for name, cap in self._capabilities._items.items()
            },
            _navigation=dict.fromkeys(self._capabilities._navigation, unavailable),
        )
        if self._recording_robot == "openyam":
            self._capabilities._items[CapabilityName.MANIPULATION] = Capability(True, None)
        self._last_samples: dict[str, Any] = {}
        self._recording_epoch = 0.0
        self._playback_start = 0.0
        self._duration = 0.0
        self._playback_state = "playing"
        self._playback_cursor = 0.0
        self._recording_anchor = 0.0
        self._recording_generation = 0
        self._recorded_navigation_geometry: tuple[
            tuple[float, float] | None, tuple[tuple[float, float], ...]
        ] = None, ()
        self._pending_seek: tuple[float, str] | None = None
        self._advance_cancel = Event()
        self._map_advance_cancel = Event()
        self._playback_ready = False
        self._recorded_camera_task: asyncio.Task[None] | None = None
        self._recording_task: asyncio.Task[None] | None = None
        self._arm_fk: Any = None
        if self._recording_robot == "openyam":
            from dimos.ar.manipulation.model import describe_model
            from dimos.control.tasks.pose_target_ik import (
                PinkPoseTargetSolver,
                PoseTargetIKTaskConfig,
            )
            from dimos.robot.manipulators.openyam.config import make_openyam_model_config

            self._arm_model = make_openyam_model_config(robot="arm")
            frames = tuple(g.tip_link for g in self._arm_model.planning_groups if g.tip_link)
            self._arm_fk = PinkPoseTargetSolver(
                PoseTargetIKTaskConfig(
                    joint_names=tuple(self._arm_model.joint_names),
                    robot_model=self._arm_model,
                    target_frames=frames,
                )
            )
            self._arm_descriptor = describe_model(
                self._arm_model.model.load().xml,
                "/models/openyam.glb",
                visual_profile="openyam",
                gripper_joint_names=[OPENYAM_GRIPPER_JOINT],
            )

    def _hello_body(self, client_id: str) -> Any:
        return replace(
            super()._hello_body(client_id),
            source={
                "kind": "recording",
                "read_only": True,
                "name": Path(self._recording_path).name,
            },
        )

    def _elapsed(self) -> float:
        elapsed = time.monotonic() - self._playback_start if self._playback_state == "playing" else 0.0
        return min(self._duration, self._playback_cursor + max(0.0, elapsed))

    def _playback_status(self) -> dict[str, Any]:
        return {"state": self._playback_state, "elapsed_s": self._elapsed(),
                "duration_s": self._duration, "generation": self._recording_generation}

    def _state_snapshot(self) -> Any:
        status = self._playback_status()
        status["source_generation"] = status.pop("generation")
        return replace(super()._state_snapshot(), playback=status)

    def _seek(self, elapsed: float, then: str) -> None:
        self._recording_generation += 1
        self._advance_cancel.set()
        if map_cancel := getattr(self, "_map_advance_cancel", None):
            map_cancel.set()
        self._pending_seek = elapsed, then
        if camera_task := getattr(self, "_recorded_camera_task", None):
            camera_task.cancel()
        self._playback_state = "seeking"
        self._playback_cursor = elapsed
        self._last_samples.clear()
        self._recorded_navigation_geometry = None, ()
        self._odometry.reset_recording_samples()
        self._state_publisher.invalidate_source()
        self._robot_observations.clear()
        self._localization.retire_pending()
        self._navigation_map.reset()
        self._broadcast_state()

    def _command(self, body: object) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise TypeError("Invalid playback request")
        action = body.get("action")
        state = self._playback_state
        if action == "status":
            return self._playback_status()
        if not self._playback_ready or state == "error":
            raise ValueError("Recording playback is unavailable")
        if action == "seek":
            stamp = body.get("elapsed_s")
            if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or not math.isfinite(stamp):
                raise ValueError("Invalid seek time")
            then = self._pending_seek[1] if self._pending_seek else (
                "playing" if state in ("playing", "ended") else "paused"
            )
            self._seek(min(self._duration, max(0.0, stamp)), then)
        elif action == "stop":
            self._seek(0.0, "stopped")
        elif action in ("play", "pause"):
            then = "playing" if action == "play" else "paused"
            if state == "ended" and action == "play":
                self._seek(0.0, "playing")
            elif self._pending_seek:
                self._pending_seek = self._pending_seek[0], then
            elif (state, action) in (("playing", "pause"), ("paused", "play"), ("stopped", "play")):
                self._playback_cursor = self._elapsed()
                now = time.monotonic()
                if then == "playing":
                    self._recording_epoch += now - self._playback_start
                self._playback_start = now
                self._playback_state = then
                self._broadcast_state()
        else:
            raise ValueError("Unknown playback action")
        return self._playback_status()

    async def _playback_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            try:
                raw = await asyncio.wait_for(reader.readline(), 1.0)
                reply = self._command(json.loads(raw))
            except (TypeError, ValueError, TimeoutError) as exc:
                reply = {"error": str(exc)}
            writer.write((json.dumps(reply, allow_nan=False) + "\n").encode())
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    @rpc  # type: ignore[untyped-decorator]
    def start(self) -> None:
        super().start()
        self._loop.call_soon_threadsafe(self._start_recording)

    def _start_recording(self) -> None:
        self._recording_task = asyncio.create_task(self._play())

    async def _play(self) -> None:
        loop = asyncio.get_running_loop()
        pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ar-recording")
        source: RecordingReader | None = None
        opening: asyncio.Future[RecordingReader] | None = None
        endpoint: asyncio.AbstractServer | None = None
        mapping: asyncio.Task[None] | None = None
        try:
            if path := os.environ.get("DIMOS_AR_PLAYBACK_SOCKET"):
                endpoint = await asyncio.start_unix_server(
                    self._playback_connection, path, limit=4096
                )
            opening = loop.run_in_executor(
                pool, RecordingReader, self._recording_path, self._streams,
                False,
            )
            source = await asyncio.shield(opening)
            self._duration = source.duration
            self._recording_anchor = source.anchor
            self._recording_epoch = time.time() - source.anchor
            self._playback_start = time.monotonic()
            self._playback_ready = True
            if self._recording_robot == "unitree_go2":
                mapping = asyncio.create_task(self._reconstruct_map())
            while True:
                await self._play_tick(source, pool)
                self._broadcast_state()
                await asyncio.sleep(0.05)
        except Exception:
            logger.exception("Recording playback failed")
            self._playback_cursor = self._elapsed()
            self._playback_state = "error"
            self._broadcast_state()
            if endpoint is not None:
                await asyncio.Event().wait()
        finally:
            self._advance_cancel.set()
            if mapping is not None:
                mapping.cancel()
                await asyncio.gather(mapping, return_exceptions=True)
            if endpoint is not None:
                endpoint.close()
                await endpoint.wait_closed()
            if self._recorded_camera_task is not None:
                self._recorded_camera_task.cancel()
                await asyncio.gather(self._recorded_camera_task, return_exceptions=True)
            if source is None and opening is not None:
                (result,) = await asyncio.gather(opening, return_exceptions=True)
                if isinstance(result, RecordingReader):
                    source = result
            if source is not None:
                await loop.run_in_executor(pool, source.close)
            pool.shutdown(wait=False, cancel_futures=True)

    async def _reconstruct_map(self) -> None:
        """Keep cumulative map work off the playback cursor's ordered worker."""
        loop = asyncio.get_running_loop()
        pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ar-recording-map")
        streams = {role: self._streams[role] for role in ("odom", "lidar")}
        opening = loop.run_in_executor(pool, RecordingReader, self._recording_path, streams, True)
        source: RecordingReader | None = None
        published_generation = -1
        had_subscribers = False
        try:
            source = await asyncio.shield(opening)
            while True:
                generation = self._recording_generation
                elapsed = self._elapsed() + self._recording_anchor - source.anchor
                subscribers = bool(self._ws_server.navigation_map_peers())
                refresh = subscribers and (not had_subscribers or published_generation != generation)
                if elapsed >= 0 and (elapsed != source.position or refresh):
                    self._map_advance_cancel = Event()
                    advance = partial(source.advance, elapsed, refresh, self._map_advance_cancel,
                                      rasterize=subscribers)
                    _, grid = await loop.run_in_executor(pool, advance)
                    if grid is not None and generation == self._recording_generation:
                        self._navigation_map.update_grid(grid)
                        published_generation = generation
                had_subscribers = subscribers
                await asyncio.sleep(0.2)
        except Exception:
            logger.exception("Recording navigation map reconstruction failed")
        finally:
            self._map_advance_cancel.set()
            if source is None:
                (result,) = await asyncio.gather(opening, return_exceptions=True)
                if isinstance(result, RecordingReader):
                    source = result
            if source is not None:
                await loop.run_in_executor(pool, source.close)
            pool.shutdown(wait=False, cancel_futures=True)

    async def _play_tick(self, source: RecordingReader, pool: ThreadPoolExecutor) -> None:
        pending = self._pending_seek
        if pending is None and self._playback_state != "playing":
            await self._publish_retained()
            return
        elapsed = pending[0] if pending else min(self._elapsed(), source.position + 1.1)
        generation = self._recording_generation
        self._advance_cancel = Event()
        loop = asyncio.get_running_loop()
        samples, _ = await loop.run_in_executor(
            pool, source.advance, elapsed, pending is not None, self._advance_cancel
        )
        if generation != self._recording_generation:
            return
        if pending:
            # Re-anchor wall time, but retain elapsed-time separation of restored samples.
            self._recording_epoch = time.time() - source.anchor - elapsed
            samples.sort(key=lambda item: (
                item[0] not in ("odom", "camera_info", "gripper"), item[1].ts,
                {"odom": 0, "camera_info": 1, "gripper": 2, "target": 3}.get(item[0], 4)
            ))
        if pending and self._recorded_camera_task is not None:
            await asyncio.gather(self._recorded_camera_task, return_exceptions=True)
        for role, sample in samples:
            if generation != self._recording_generation:
                return
            if pending and role == "lidar" and source.anchor + elapsed - sample.ts > 1.0:
                continue
            if role == "color_image":
                if self._recorded_camera_task is None or self._recorded_camera_task.done():
                    self._recorded_camera_task = asyncio.create_task(self._sample(role, sample))
                    self._recorded_camera_task.add_done_callback(self._camera_done)
            else:
                await self._sample(role, sample, restoring=pending is not None)
        if generation != self._recording_generation:
            return
        if pending:
            assert self._pending_seek is not None
            self._playback_cursor = elapsed
            self._playback_state = self._pending_seek[1]
            self._pending_seek = None
            self._playback_start = time.monotonic()
        elif elapsed >= self._duration and self._playback_state == "playing":
            self._playback_cursor = elapsed
            self._playback_state = "ended"

    @staticmethod
    def _camera_done(task: asyncio.Task[None]) -> None:
        if not task.cancelled() and (error := task.exception()) is not None:
            logger.warning("Replay camera sample failed", error=str(error))

    async def _publish_retained(self) -> None:
        # Retention is presentation, not a new source measurement or camera query.
        pose = self._odometry.history.latest()
        if pose is not None:
            self._state_publisher.publish_odom(
                pose, source_generation=getattr(self, "_recording_generation", None)
            )
        for role in ("lidar", "joints"):
            sample = self._last_samples.get(role)
            if sample is None:
                continue
            if role == "lidar" and self._recording_anchor + self._elapsed() - sample.ts > 1.0:
                continue
            msg = copy.copy(sample)
            msg.ts = float(sample.ts) + self._recording_epoch
            if role == "joints":
                self._publish_arm(msg)
            else:
                await self.handle_lidar(msg)

    async def _sample(self, role: str, sample: Any, *, restoring: bool = False) -> None:
        self._last_samples[role] = sample
        msg = copy.copy(sample)
        if role == "gripper":
            return
        if role in ("path", "target"):
            odom = self._last_samples.get("odom")
            if odom is None or msg.frame_id != odom.frame_id:
                return
            target, path = self._recorded_navigation_geometry
            if role == "path":
                path = tuple((pose.x, pose.y) for pose in msg.poses)
                if not all(math.isfinite(x) and math.isfinite(y) for x, y in path):
                    return
                if not path:
                    target = None
            else:
                target = (msg.x, msg.y)
                if not all(map(math.isfinite, target)):
                    return
                path = ()
            self._recorded_navigation_geometry = target or (path[-1] if path else None), path
            return
        msg.ts = float(sample.ts) + self._recording_epoch
        if role == "joints":
            self._publish_arm(msg)
        elif role == "odom" and restoring:
            # A cursor can land well after the last measured pose. Restore the
            # measurement at its recorded time; camera freshness is independent.
            await self._accept_odom(msg, received_at=msg.ts)
        else:
            await getattr(self, f"handle_{role}")(msg)

    def _publish_arm(self, sample: JointState) -> None:
        sample = copy.copy(sample)
        sample.name = _openyam_joint_names(sample)
        frames = tuple(g.tip_link for g in self._arm_model.planning_groups if g.tip_link)
        poses = self._arm_fk.frame_poses(sample, frames)
        joints = dict(zip(sample.name, sample.position, strict=True))
        groups = self._arm_model.planning_groups
        self._ws_server.schedule_broadcast_text(
            encode_text(
                {
                    "type": "manipulation_state",
                    "available": True,
                    "read_only": True,
                    "source_generation": self._recording_generation,
                    "simulated": True,
                    "ts": time.time(),
                    "model": self._arm_descriptor,
                    "root_pose": {"position": [0, 0, 0], "orientation": [0, 0, 0, 1]},
                    "groups": [
                        {
                            "id": g.name,
                            "joint_names": list(g.joint_names),
                            "base_frame": self._arm_model.base_link,
                            "tip_frame": g.tip_link,
                            "has_gripper": "gripper" in self._streams,
                            "following": False,
                        }
                        for g in groups
                    ],
                    "observations": {
                        g.name: {
                            "joints": joints,
                            "measured_at": sample.ts,
                            "pose": {
                                "position": [
                                    poses[g.tip_link].x,
                                    poses[g.tip_link].y,
                                    poses[g.tip_link].z,
                                ],
                                "orientation": [
                                    poses[g.tip_link].orientation.x,
                                    poses[g.tip_link].orientation.y,
                                    poses[g.tip_link].orientation.z,
                                    poses[g.tip_link].orientation.w,
                                ],
                            },
                            "gripper": self._last_samples["gripper"].data
                            if "gripper" in self._last_samples
                            else None,
                        }
                        for g in groups
                        if g.tip_link
                    },
                    "execution": "idle",
                    "following": False,
                    "stopped": False,
                    "plan": None,
                }
            )
        )

    def _on_manipulation_request(self, request: Any, client_id: str, clock_offset: float) -> None:
        self._ws_server.schedule_send_to_client(
            client_id,
            encode_text(
                {
                    "type": "manipulation_result",
                    "request_id": request.request_id,
                    "action": request.action,
                    "group_id": request.group_id,
                    "status": "rejected",
                    "code": "read_only",
                    "message": "Recording playback is read-only",
                }
            ),
        )

    @rpc  # type: ignore[untyped-decorator]
    def stop(self) -> None:
        if getattr(self, "_ar_stopping", False):
            return
        task = getattr(self, "_recording_task", None)
        if task is not None:
            self._loop.call_soon_threadsafe(task.cancel)
        super().stop()


openyam_ar_replay = RecordedARModule.blueprint(
    instance_name="ARModule", robot=RobotName.OPENYAM, stationary_base=ReferencePose()
).global_config(n_workers=1)
unitree_go2_ar_replay = RecordedARModule.blueprint(
    instance_name="ARModule", robot=RobotName.UNITREE_GO2
).global_config(n_workers=1)
