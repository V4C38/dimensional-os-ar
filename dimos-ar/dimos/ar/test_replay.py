import pytest

from dimos.ar.replay import inspect_recording
from dimos.memory.store.sqlite import SqliteStore
from dimos.msgs.sensor_msgs.JointState import JointState
from dimos.robot.manipulators.openyam.config import make_openyam_model_config


def record(path, streams):
    store = SqliteStore(path=str(path))
    store.start()
    for name, samples in streams.items():
        stream = store.stream(name, JointState)
        for i, sample in enumerate(samples):
            stream.append(sample, ts=10 + i * 0.1)
    store.stop()


def sample():
    model = make_openyam_model_config()
    return JointState(name=list(model.joint_names), position=list(model.home_joints))


@pytest.mark.parametrize("robot", [None, "arm"], ids=["legacy-joints", "qualified-joints"])
def test_arm_recording_validates_payload_not_stream_name(tmp_path, robot):
    path = tmp_path / "arm.db"
    model = make_openyam_model_config(robot=robot)
    measured = JointState(name=list(model.joint_names), position=list(model.home_joints))
    record(path, {"anything": [measured, measured]})
    assert inspect_recording(str(path), "openyam")["streams"] == {"joints": "anything"}


def test_arm_recording_rejects_ambiguous_joint_aliases(tmp_path):
    path = tmp_path / "arm.db"
    measured = sample()
    measured.name.append("arm/" + measured.name[0])
    measured.position.append(0.0)
    record(path, {"joints": [measured]})
    with pytest.raises(ValueError, match="Every arm sample"):
        inspect_recording(str(path), "openyam")


def test_arm_recording_rejects_later_incomplete_sample(tmp_path):
    path = tmp_path / "arm.db"
    record(path, {"joints": [sample(), JointState(name=["other"], position=[0])]})
    with pytest.raises(ValueError, match="Every arm sample"):
        inspect_recording(str(path), "openyam")


def test_multiple_arm_streams_require_explicit_selection(tmp_path):
    path = tmp_path / "arm.db"
    record(path, {"measured": [sample()], "commanded": [sample()]})
    info = inspect_recording(str(path), "openyam")
    assert info["needs_selection"]
    assert set(info["candidates"]["joints"]) == {"measured", "commanded"}
    assert not inspect_recording(str(path), "openyam", {"joints": "measured"})["needs_selection"]
    with pytest.raises(ValueError, match="Invalid joints stream"):
        inspect_recording(str(path), "openyam", {"joints": "missing"})


def test_replay_compositions_have_only_the_ar_publisher_and_keep_config_identity():
    from dimos.ar.replay import openyam_ar_replay, unitree_go2_ar_replay

    for blueprint in (openyam_ar_replay, unitree_go2_ar_replay):
        assert len(blueprint.active_blueprints) == 1
        atom = blueprint.active_blueprints[0]
        assert atom.name == "ARModule"


@pytest.mark.asyncio
async def test_playback_preserves_producer_timing_despite_delayed_camera_delivery(monkeypatch):
    import time
    from types import SimpleNamespace
    from unittest.mock import Mock

    from dimos.ar.replay import RecordedARModule
    from dimos.ar.robot.odometry import RobotOdometry, RobotSourceClock
    from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped

    now = [110.15]
    monkeypatch.setattr(time, "time", lambda: now[0])
    module = object.__new__(RecordedARModule)
    module._last_samples = {}
    module._recording_epoch = 100
    module._odometry = RobotOdometry()
    module._odometry.clock = RobotSourceClock()
    paired = []
    async def odom(sample):
        module._odometry.accept(sample)
    async def image(sample):
        paired.append(module._odometry.history.at_image_ts(sample.ts))
    module.handle_odom = odom
    module.handle_color_image = image
    first = PoseStamped(ts=10, position=[0, 0, 0])
    await module._sample("odom", first)
    await module._sample("odom", PoseStamped(ts=10.1, position=[2, 0, 0]))
    now[0] = 110.3
    await module._sample("color_image", SimpleNamespace(ts=10.05))
    assert paired[0].position[0] == pytest.approx(1)
    assert paired[0].ts_server == pytest.approx(110.05)
    assert first.ts == 10
    latest = module._odometry.history.latest()
    module._state_publisher = SimpleNamespace(publish_odom=Mock())
    for _ in range(3):
        now[0] += 10
        await module._publish_retained()
    assert module._odometry.history.latest() is latest
    assert latest.ts_server == pytest.approx(110.1)
    assert module._state_publisher.publish_odom.call_count == 3


def test_go2_replay_rebuilds_costmap_without_later_scans(tmp_path):
    from threading import Event

    import numpy as np

    from dimos.ar.replay import RecordingReader
    from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
    from dimos.msgs.sensor_msgs.PointCloud2 import PointCloud2

    path = tmp_path / "recording.db"
    store = SqliteStore(path=str(path))
    store.start()
    try:
        odom = store.stream("pose", PoseStamped)
        lidar = store.stream("scan", PointCloud2)
        xy = np.stack(np.meshgrid(np.arange(0, 1, 0.03), np.arange(0, 1, 0.03)), axis=-1).reshape(-1, 2)
        floor = np.column_stack((xy, np.zeros(len(xy))))
        for i in range(3):
            stamp = 10.0 + i
            odom.append(PoseStamped(ts=stamp, position=[1 + i, 0, 0]), ts=stamp)
            lidar.append(PointCloud2.from_numpy(floor + np.array([i, 0, 0]), timestamp=stamp), ts=stamp)
    finally:
        store.stop()
    source = RecordingReader(str(path), {"odom": "pose", "lidar": "scan"}, True)
    try:
        early, grid = source.advance(1.0, True, Event())
        assert grid is not None
        assert dict(early)["odom"].ts == 11
        initial = grid.grid.copy()
        _, later = source.advance(2.0, True, Event())
        assert later is not None
        assert later.grid.shape != initial.shape
        _, rebuilt = source.advance(1.0, True, Event())
        assert rebuilt is not None
        assert np.array_equal(rebuilt.grid, initial)
    finally:
        source.close()


def test_replay_seek_retires_old_observations_and_preserves_resume_intent(monkeypatch):
    from threading import Event
    import time
    from unittest.mock import Mock

    from dimos.ar.replay import RecordedARModule

    monkeypatch.setattr(time, "monotonic", lambda: 40.0)
    module = object.__new__(RecordedARModule)
    module._playback_ready = True
    module._playback_state = "playing"
    module._playback_cursor = 0
    module._playback_start = 35
    module._duration = 30
    module._recording_generation = 2
    module._advance_cancel = Event()
    module._pending_seek = None
    module._last_samples = {"odom": object()}
    module._odometry = Mock()
    module._state_publisher = Mock()
    module._robot_observations = Mock()
    module._localization = Mock()
    module._navigation_map = Mock()
    module._broadcast_state = Mock()

    assert module._command({"action": "pause"})["elapsed_s"] == 5
    assert module._command({"action": "seek", "elapsed_s": 7}) == {
        "state": "seeking", "duration_s": 30, "elapsed_s": 7, "generation": 3,
    }
    assert module._pending_seek == (7, "paused")
    assert module._advance_cancel.is_set()
    assert module._last_samples == {}
    module._navigation_map.reset.assert_called_once()
    module._command({"action": "play"})
    module._command({"action": "seek", "elapsed_s": 9})
    assert module._pending_seek == (9, "playing")
    module._command({"action": "stop"})
    assert module._pending_seek == (0, "stopped")
    assert module._recording_generation == 5
    module._pending_seek = None
    module._playback_state = "ended"
    module._command({"action": "seek", "elapsed_s": 4})
    assert module._pending_seek == (4, "playing")
