"""OpenYAM motor protection at the native Damiao connection's read/write boundary."""

from __future__ import annotations

import math
import threading
import time
from typing import Any

from dimos.ar.manipulation.model_config import COMMAND_TRACKING_LEAD_RAD
from dimos.ar.manipulation.protection import MotorProtection, ProtectionPolicy
from dimos.core.core import rpc
from dimos.msgs.sensor_msgs.JointState import JointState
from dimos.robot.manipulators.damiao.arm import ArmReading
from dimos.robot.manipulators.openyam.connection import OpenYamConnection, OpenYamConnectionConfig


class ProtectedOpenYamConfig(OpenYamConnectionConfig):  # type: ignore[misc]
    safety_limits: dict[str, tuple[float, float]]
    protection_policy: ProtectionPolicy = ProtectionPolicy()


class ProtectedOpenYamConnection(OpenYamConnection):  # type: ignore[misc]
    config: ProtectedOpenYamConfig

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        # Stop/resume RPCs and the subscription use one admission boundary. Native
        # command() also takes this lock while validating and issuing the batch.
        self._hardware_lock = threading.RLock()
        self._admit_commands_after = float("-inf")
        self.guard = MotorProtection(self.config.protection_policy)
        prefix = self.config.source + "/"
        self._soft_limits = {
            name.removeprefix(prefix): bounds for name, bounds in self.config.safety_limits.items()
        }
        if set(self._soft_limits) != set(self.robot.arm_joint_names) or any(
            not (math.isfinite(low) and math.isfinite(high) and low < high)
            for low, high in self._soft_limits.values()
        ):
            raise ValueError("OpenYAM requires finite soft limits for every arm joint")
        self._positions: dict[str, float] = {}
        self._issued: dict[str, float] = {}
        self._velocity: dict[str, float] = {}
        self._last_write: float | None = None
        self._hold_positions: dict[str, float] | None = None
        self._stop_latched = False

    def _on_position(self, msg: JointState) -> None:
        with self._hardware_lock:
            if self._stop_latched or not msg.ts > self._admit_commands_after:
                return
            super()._on_position(msg)

    def _read_state(self) -> ArmReading:
        reading = super()._read_state()
        arm = self._arm
        self._positions = dict(zip(self.joint_names, reading.position, strict=True))
        if arm is None or not arm.active:
            return reading
        rows = []
        # ArmReading exposes kinematics. The SDK motor owns temperature and fault flags.
        for i, name in enumerate(self.robot.arm_joint_names):
            motor = arm._arms["arm"][name]
            rows.append(
                {
                    "joint": name,
                    "position": reading.position[i],
                    "velocity": reading.velocity[i],
                    "effort": reading.effort[i],
                    "command": self._issued.get(name, reading.position[i]),
                    "temperature_mos": motor.temperature_mos,
                    "temperature_rotor": motor.temperature_rotor,
                    "fault": motor.fault,
                    "enabled": motor.is_enabled,
                }
            )
        self.guard.observe(rows, time.monotonic())
        if self.guard.state == "fault":
            raise RuntimeError(self.guard.reason)
        if self.guard.state == "paused":
            self._stop_latched = True
        if self._stop_latched:
            if self._hold_positions is None:
                self._hold_positions = dict(self._positions)
                self._issued = dict(self._positions)
                self._velocity.clear()
            arm.command(self._hold_positions)
        return reading

    def _feedback_failed(self, error: Exception) -> None:
        self.guard.state = "fault"
        self.guard.reason = f"OpenYAM feedback failed: {error}"
        super()._feedback_failed(error)

    def halt(self) -> None:
        if self._hold_positions is None:
            super().halt()
        elif self._arm is not None and self._arm.active and self._fault is None:
            self._arm.command(self._hold_positions)
        self._issued.clear()
        self._velocity.clear()
        self._last_write = None

    @rpc  # type: ignore[untyped-decorator]
    def ar_arm_hold(self, stopped: bool) -> bool:
        with self._hardware_lock:
            if stopped:
                self._stop_latched = True
            if self._fault or not self._connected or self._arm is None or not self._arm.active:
                return False
            if self.guard.state == "fault" or (not stopped and self.guard.scale == 0):
                return False
            # A newly latched hold samples and sends a fixed measured pose in this read.
            if stopped:
                self._read_state()
            else:
                self._hold_positions = None
                self._issued = dict(self._positions)
                self._velocity.clear()
                self._last_write = None
                self._admit_commands_after = time.time()
                self._stop_latched = False
            return True

    @rpc  # type: ignore[untyped-decorator]
    def ar_motor_protection(self) -> dict[str, Any]:
        with self._hardware_lock:
            return self.guard.snapshot()

    @rpc  # type: ignore[untyped-decorator]
    def ar_resume_motor_protection(self) -> bool:
        with self._hardware_lock:
            return bool(self._connected and not self._fault and self.guard.resume(time.monotonic()))

    def write(self, values: dict[str, float]) -> None:
        if self.guard.state == "fault" or self._fault:
            raise RuntimeError(self.guard.reason or self._fault)
        if self._stop_latched:
            if self._hold_positions is None:
                raise RuntimeError("OpenYAM has no confirmed measured hold")
            return
        if not self._positions:
            raise RuntimeError("OpenYAM has no measured joint positions")
        now = time.monotonic()
        dt = min(0.02, max(0.001, now - self._last_write)) if self._last_write is not None else 0.01
        bounded = dict(values)
        issued = {}
        velocities = {}
        for name, (lower, upper) in self._soft_limits.items():
            key = f"{self.config.source}/{name}/position"
            if key not in values:
                continue
            measured = self._positions[name]
            prev = self._issued.get(name, measured)
            target = max(lower, min(upper, values[key]))
            scale = self.guard.scale
            acceleration = 2.0 * scale
            distance = target - prev
            desired = math.copysign(
                min(scale, math.sqrt(2.0 * acceleration * abs(distance)), abs(distance) / dt),
                distance,
            )
            old_v = self._velocity.get(name, 0.0)
            velocity = max(old_v - acceleration * dt, min(old_v + acceleration * dt, desired))
            value = prev + velocity * dt
            value = max(min(prev, lower), min(max(prev, upper), value))
            value = max(
                measured - COMMAND_TRACKING_LEAD_RAD,
                min(measured + COMMAND_TRACKING_LEAD_RAD, value),
            )
            bounded[key] = issued[name] = value
            velocities[name] = (value - prev) / dt
        super().write(bounded)
        self._issued.update(issued)
        self._velocity.update(velocities)
        self._last_write = now
