from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, Protocol

from dimos.ar.robot.odometry import PoseSample
from dimos.msgs.geometry_msgs.Pose import Pose

DistortionModel = Literal["none", "plumb_bob", "equidistant"]


class CapturePolicy(StrEnum):
    ROBOT_LOS_REQUIRED = "robot_los_required"
    ROBOT_LOS_PREFERRED = "robot_los_preferred"
    ANY_ANGLE = "any_angle"


class LocalizationProviderType(StrEnum):
    FIDUCIAL_MARKER = "fiducial_marker"
    VPS = "vps"


@dataclass(frozen=True)
class Intrinsics:
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int
    distortion_model: DistortionModel
    distortion: tuple[float, ...]


@dataclass(frozen=True)
class Observation:
    jpeg: bytes
    intrinsics: Intrinsics
    camera_pose: Pose
    ts_server: float


@dataclass(frozen=True)
class LocalizedPose:
    pose: Pose
    frame_id: str
    confidence: float


class Localizer(Protocol):
    def localize(self, observations: Sequence[Observation]) -> LocalizedPose | None: ...


@dataclass(frozen=True)
class TagSighting:
    pose: Pose
    ts: float


@dataclass(frozen=True)
class TagResult:
    alignment: LocalizedPose | None
    robot_pose: PoseSample | None
    sighting: TagSighting | None
    alignment_ts: float | None = None
    sighting_has_reference: bool = False


class SnapshotLocalizer(Localizer, Protocol):
    def snapshot(self) -> SnapshotLocalizer: ...

    def localize_tag(self, observations: Sequence[Observation]) -> TagResult: ...


class AsyncLocalizer(Protocol):
    async def localize(self, observations: Sequence[Observation]) -> LocalizedPose | None: ...

    async def close(self) -> None: ...
