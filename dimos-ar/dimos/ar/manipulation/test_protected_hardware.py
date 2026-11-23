"""Exercise the native connection's command boundary with a fake Damiao arm."""

import math
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

pytest.importorskip("can_motor_control")
from dimos.ar.manipulation.model_config import COMMAND_TRACKING_LEAD_RAD
from dimos.ar.manipulation.protected_hardware import ProtectedOpenYamConnection
from dimos.robot.manipulators.damiao.arm import ArmReading


@pytest.fixture
def device(request):
    names = ProtectedOpenYamConnection.robot.arm_joint_names
    connection = ProtectedOpenYamConnection(
        source="arm", can_port="test", safety_limits={n: [-1, 1] for n in names}
    )
    # The connection is constructed normally; only hardware IO is substituted.
    reading = ArmReading([0.0] * 7, [0.0] * 7, [0.0] * 7)
    motors = {
        n: SimpleNamespace(temperature_mos=28, temperature_rotor=31, fault=0, is_enabled=True)
        for n in names
    }
    connection._arm = SimpleNamespace(
        active=True,
        _arms={"arm": motors},
        read=Mock(return_value=reading),
        command=Mock(),
        disable=Mock(),
        hold=Mock(),
    )
    request.addfinalizer(connection.stop)
    connection._connected = True
    connection._read_state()
    return connection, reading, connection._arm


def test_motor_boundary_limits_outward_commands(device, monkeypatch):
    arm, reading, native = device
    now = [0.0]
    monkeypatch.setattr("dimos.ar.manipulation.protected_hardware.time.monotonic", lambda: now[0])
    for _ in range(300):
        arm.write({"arm/yam_joint1/position": 10})
        value = native.command.call_args.args[0]["yam_joint1"]
        assert abs(value - reading.position[0]) <= 0.010001
        assert value <= 1
        reading.position[0] = value
        arm._read_state()
        now[0] += 0.01
    assert value == 1.0


def test_loaded_arm_can_overcome_five_degree_tracking_offset(device, monkeypatch):
    arm, reading, native = device
    now = [0.0]
    moving = False
    monkeypatch.setattr("dimos.ar.manipulation.protected_hardware.time.monotonic", lambda: now[0])
    for _ in range(500):
        arm.write({"arm/yam_joint1/position": 0.6})
        value = native.command.call_args.args[0]["yam_joint1"]
        error = value - reading.position[0]
        assert abs(error) <= COMMAND_TRACKING_LEAD_RAD + 1e-9
        moving |= error > math.radians(6)
        if moving:
            reading.position[0] += max(-0.01, min(0.01, error))
        arm._read_state()
        now[0] += 0.01
    assert moving
    assert abs(reading.position[0] - 0.6) < 0.001


def test_measured_hold_includes_jaw_and_stays_at_first_reading(device):
    arm, reading, native = device
    reading.position[:] = [1.02] * 6 + [0.002]
    assert arm.ar_arm_hold(True)
    assert native.command.call_args.args[0] == dict(
        zip(arm.joint_names, reading.position, strict=True)
    )
    reading.position[0] = 1.03
    arm._read_state()
    arm.write({"arm/yam_joint1/position": 0.0})
    assert native.command.call_args.args[0]["yam_joint1"] == 1.02
    assert arm.ar_arm_hold(False)
    assert arm._hold_positions is None
    arm.write({"arm/yam_joint1/position": 0.2})
    assert native.command.call_args.args[0]["yam_joint1"] < 1.03


def test_hot_motor_holds_then_requires_recovery_and_release(device, monkeypatch):
    arm, reading, native = device
    now = [1.0]
    monkeypatch.setattr("dimos.ar.manipulation.protected_hardware.time.monotonic", lambda: now[0])
    native._arms["arm"]["yam_joint1"].temperature_mos = 75
    arm._read_state()
    assert arm.ar_motor_protection()["state"] == "paused"
    assert not arm.ar_arm_hold(False)
    assert not arm.ar_resume_motor_protection()
    native._arms["arm"]["yam_joint1"].temperature_mos = 28
    arm._read_state()
    now[0] += 3
    arm._read_state()
    assert arm.ar_resume_motor_protection()
    assert arm.ar_arm_hold(False)


def test_can_read_failure_latches_fault_and_blocks_writes(device):
    arm, _, native = device
    native.read.side_effect = OSError("send buffer full")
    with pytest.raises(OSError):
        arm._read_state()
    assert arm.ar_motor_protection()["state"] == "fault"
    native.disable.assert_called_once()
    with pytest.raises(RuntimeError, match="send buffer full"):
        arm.write({"arm/yam_joint1/position": 0.4})
    native.command.assert_not_called()
    assert not arm.ar_arm_hold(True)
    assert not arm.ar_resume_motor_protection()


def test_queued_position_batch_from_before_resume_cannot_move_arm(device, monkeypatch):
    from dimos.msgs.sensor_msgs.JointState import JointState

    arm, _, native = device
    clock = [100.0]
    monkeypatch.setattr("dimos.ar.manipulation.protected_hardware.time.time", lambda: clock[0])
    assert arm.ar_arm_hold(True)
    clock[0] = 101.0
    assert arm.ar_arm_hold(False)
    native.command.reset_mock()
    arm._on_position(JointState(ts=100.5, name=["arm/yam_joint1"], position=[0.1]))
    native.command.assert_not_called()
    arm._on_position(JointState(ts=101.1, name=["arm/yam_joint1"], position=[0.1]))
    native.command.assert_called_once()
