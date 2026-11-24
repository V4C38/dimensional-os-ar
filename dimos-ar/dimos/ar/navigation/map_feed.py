"""Bounded native navigation-map presentation on the existing bulk lane."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from itertools import pairwise
import math
import time
from typing import Any

import numpy as np

from dimos.ar.numeric import quaternion_yaw
from dimos.ar.robot.odometry import AcceptedOdometry
from dimos.ar.spatial import FrameSnapshot, transform_pose
from dimos.ar.websocket.bulk import BulkPeer
from dimos.ar.websocket.protocol import NavigationMapRequest
from dimos.msgs.nav_msgs.OccupancyGrid import OccupancyGrid
from dimos.msgs.sensor_msgs.PointCloud2 import PointCloud2
from dimos.utils.logging_config import setup_logger

XY = tuple[float, float]
NavigationGeometry = tuple[XY | None, tuple[XY, ...]]
logger = setup_logger()


def _segment_in_crop(
    a: XY, b: XY, low: XY, high: XY,
) -> tuple[float, float, float, float] | None:
    start, end = 0.0, 1.0
    for p, q, minimum, maximum in zip(a, b, low, high, strict=True):
        delta = q - p
        if not delta:
            if p < minimum or p > maximum:
                return None
            continue
        left, right = sorted(((minimum - p) / delta, (maximum - p) / delta))
        start, end = max(start, left), min(end, right)
        if start > end:
            return None
    dx, dy = b[0] - a[0], b[1] - a[1]
    return a[0] + dx * start, a[1] + dy * start, a[0] + dx * end, a[1] + dy * end


def _height_points(cloud: PointCloud2 | None, robot: XY) -> np.ndarray:
    if cloud is None:
        return np.empty((0, 3), dtype="<f4")
    xyz = cloud.points_f32()
    distance_sq = np.sum((xyz[:, :2] - np.array(robot)) ** 2, axis=1)
    xyz = xyz[(distance_sq <= 9) & (xyz[:, 2] >= 0.12) & (xyz[:, 2] <= 2.0)]
    if not len(xyz):
        return np.empty((0, 3), dtype="<f4")
    columns = np.floor(xyz[:, :2] / 0.24).astype(np.int64)
    order = np.lexsort((xyz[:, 1], xyz[:, 0], -xyz[:, 2], columns[:, 1], columns[:, 0]))
    columns = columns[order]
    first = np.r_[True, np.any(columns[1:] != columns[:-1], axis=1)]
    representatives = xyz[order[first]]
    if len(representatives) > 128:
        representatives = representatives[np.linspace(0, len(representatives) - 1, 128, dtype=int)]
    return np.asarray(representatives, dtype="<f4")


def _encode_crop(
    grid: OccupancyGrid, center: XY, robot: tuple[float, float, float],
    heights: np.ndarray, geometry: NavigationGeometry, radius_m: float = 6.0,
) -> tuple[dict[str, Any], bytes] | None:
    resolution = float(grid.resolution)
    grid_x, grid_y = float(grid.origin.position.x), float(grid.origin.position.y)
    if not all(map(math.isfinite, (resolution, grid_x, grid_y))) or resolution <= 0:
        return None
    width, height = grid.grid.shape[1], grid.grid.shape[0]
    if not width or not height:
        return None
    # Prefetch surrounding cells so a panning viewport stays filled while its
    # next replaceable snapshot is encoded and delivered.
    n = max(1, math.ceil(min(max(width, height) * 2, 3 * radius_m / resolution)))
    # Clamp in native metres before computing cell indices for distant pans.
    center_x = min(grid_x + width * resolution, max(grid_x, center[0]))
    center_y = min(grid_y + height * resolution, max(grid_y, center[1]))
    start_x = math.floor((center_x - grid_x) / resolution) - n // 2
    start_y = math.floor((center_y - grid_y) / resolution) - n // 2
    x, y = max(0, start_x), max(0, start_y)
    costs = grid.grid[y:min(height, start_y + n), x:min(width, start_x + n)]
    height, width = costs.shape
    if not width or not height:
        return None
    low = grid_x + x * resolution, grid_y + y * resolution
    stride = max(1, math.ceil(max(width, height) / 240))
    if stride > 1:
        rows, cols = math.ceil(height / stride), math.ceil(width / stride)
        padded = np.pad(costs, ((0, rows * stride - height), (0, cols * stride - width)),
                        constant_values=-1)
        costs = padded.reshape(rows, stride, cols, stride).max(axis=(1, 3))
        height, width = costs.shape
        resolution *= stride
    high = low[0] + width * resolution, low[1] + height * resolution
    target, path = geometry
    runs: list[list[XY]] = []
    last: XY | None = None
    for a, b in pairwise(path):
        segment = _segment_in_crop(a, b, low, high)
        if segment is None:
            last = None
            continue
        start, end = (segment[0], segment[1]), (segment[2], segment[3])
        if last is not None and math.dist(last, start) < 1e-9:
            runs[-1].append(end)
        else:
            runs.append([start, end])
        last = end
    # Keep connected visible runs when simplifying rather than skipping segments.
    if len(runs) > 256:
        selected = sorted(range(len(runs)), key=lambda index: -len(runs[index]))[:256]
        runs = [runs[index] for index in sorted(selected)]
    remaining = 256 - len(runs)
    interiors = sum(len(run) - 2 for run in runs)
    segments: list[tuple[float, float, float, float]] = []
    for run in runs:
        interior = len(run) - 2
        allocation = min(interior, (remaining * interior // interiors) if interiors else 0)
        samples = np.linspace(0, len(run) - 1, allocation + 2, dtype=int)
        segments.extend((*run[a], *run[b]) for a, b in pairwise(samples))
    route = np.asarray(segments, dtype="<f4")
    return ({
        "resolution": resolution, "origin": low, "width": width, "height": height,
        "robot": robot, "height_count": len(heights), "route_count": len(route), "target": target,
    }, np.asarray(costs, dtype=np.int8).tobytes() + heights.tobytes() + route.tobytes())


class NavigationMapFeed:
    def __init__(
        self, *, peers: Callable[[], tuple[BulkPeer, ...]],
        pose: Callable[[], AcceptedOdometry | None],
        identity: Callable[[], tuple[str, int]],
        geometry: Callable[[], NavigationGeometry],
        frames: Callable[[], FrameSnapshot],
        available: Callable[[], bool],
        recording: bool,
    ) -> None:
        self._peers, self._pose, self._identity = peers, pose, identity
        self._geometry, self._available, self._recording = geometry, available, recording
        self._frames = frames
        self._grid: OccupancyGrid | None = None
        self._lidar: tuple[PointCloud2, float] | None = None
        self._reset = 0
        self._snapshot = 0
        self._task: asyncio.Task[None] | None = None

    def contains(self, position: XY) -> bool:
        grid = self._grid
        if grid is None or not math.isfinite(grid.resolution) or grid.resolution <= 0:
            return False
        height, width = grid.grid.shape
        x, y = float(grid.origin.position.x), float(grid.origin.position.y)
        resolution = float(grid.resolution)
        return (
            x <= position[0] < x + int(width) * resolution
            and y <= position[1] < y + int(height) * resolution
        )

    def update_grid(self, grid: OccupancyGrid) -> None:
        self._grid = grid

    def update_lidar(self, lidar: PointCloud2) -> None:
        self._lidar = lidar, time.monotonic()

    def reset(self) -> None:
        self._reset += 1
        self._grid = self._lidar = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        self.reset()

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(0.2)
            try:
                await self._publish()
            except Exception:
                logger.exception("Navigation map snapshot failed")

    async def _publish(self) -> None:
        if not self._available() or self._grid is None:
            return
        peers = [(peer, peer.navigation_map_request) for peer in self._peers()]
        pose = self._pose()
        if not peers or pose is None:
            return
        robot = (*pose.position[:2], quaternion_yaw(pose.orientation))
        grid, geometry, reset, identity = self._grid, self._geometry(), self._reset, self._identity()
        frames = self._frames()
        if frames.odom_reference_id != identity[0]:
            return
        _, map_odom_rotation = transform_pose(frames.T_map_odom, (0, 0, 0), (0, 0, 0, 1))
        cloud = None
        if self._lidar is not None:
            lidar, received = self._lidar
            age = pose.sample.ts_server - lidar.ts if self._recording else time.monotonic() - received
            if age <= 1.0:
                cloud = lidar

        def encode() -> list[tuple[BulkPeer, NavigationMapRequest, dict[str, Any], bytes]]:
            heights = _height_points(cloud, (robot[0], robot[1]))
            result = []
            for peer, request in peers:
                if request is None:
                    continue
                encoded = _encode_crop(grid, request.center or robot[:2], robot, heights, geometry, request.radius_m)
                if encoded is not None:
                    result.append((peer, request, *encoded))
            return result

        results = await asyncio.to_thread(encode)
        if reset != self._reset or identity != self._identity() or frames is not self._frames() or not self._available():
            return
        self._snapshot += 1
        active = self._peers()
        for peer, request, header, data in results:
            if peer in active:
                peer.navigation_map(request, {
                    **header, "subscription_id": request.subscription_id,
                    "sequence": request.sequence, "snapshot_sequence": self._snapshot,
                    "odom_reference_id": identity[0], "source_generation": identity[1],
                    "shared_frame_id": frames.shared_frame_id, "map_odom_rotation": map_odom_rotation,
                }, data)
