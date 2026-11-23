"""Hardware-free verification of the official planning scene and AR worker snapshots."""

import xml.etree.ElementTree as ET

import numpy as np

from dimos.ar.manipulation.model_config import (
    make_ar_openyam_model,
    openyam_gripper_feedback_limits,
)
from dimos.ar.manipulation.module import ARManipulationModule
from dimos.manipulation.manipulation_module import ManipulationModule
from dimos.msgs.geometry_msgs.Pose import Pose
from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from dimos.msgs.sensor_msgs.JointState import JointState


def check_scene():
    limits = openyam_gripper_feedback_limits()
    jaw, (native_open, native_closed) = next(iter(limits.items()))
    model = make_ar_openyam_model()
    module = ARManipulationModule(model=model, reversed_feedback_joint_limits=limits)
    adapter = module._adapter
    names = model.joint_names
    raw = JointState(name=list(names), position=list(model.home_joints))
    raw.position[names.index(jaw)] = native_closed
    try:
        module._initialize_planning()
        module._started = True
        module._on_joint_state(raw)
        feedback = adapter.feedback
        assert feedback is not None and feedback.position[names.index(jaw)] == native_open
        collision_links = [link.attrib["name"] for link in ET.fromstring(model.model.load().xml).findall("link")
                           if link.findall("collision")]
        scene = module._world_monitor.world._scene
        assert all(scene.getCollisionGeometryIDs(link) for link in collision_links)
        assert module._world_monitor.is_state_valid(feedback), "home must remain valid"
        group = module.list_planning_groups()[0].id
        pose = module._world_monitor.get_group_ee_pose(group, feedback)
        target = PoseStamped(frame_id="world", position=[pose.x + 0.01, pose.y, pose.z], orientation=pose.orientation)
        evaluation = adapter.evaluate(group, target)
        assert evaluation.success, evaluation.message
        plan = adapter.plan_to_poses({group: target}, speed_scale=0.2)
        assert plan.succeeded and plan.plan is not None
        assert set(plan.plan.trajectory.joint_names) == set(names) - {jaw}
        retired_worker = adapter.worker
        assert retired_worker is not None
        old_pid = retired_worker.process.pid
        retired_worker.process.terminate()
        retired_worker.process.wait(timeout=5)
        try:
            adapter.plan_to_poses({group: target}, speed_scale=0.2)
        except (OSError, EOFError):
            pass
        else:
            raise AssertionError("a dead planner transport did not fail its current request")
        assert retired_worker.closed
        obstacle = module.add_obstacle(
            "new-environment-obstacle", Pose(position=target.position), "sphere", [1.0]
        )
        assert obstacle
        assert not module._world_monitor.is_state_valid(feedback), "parent world ignored the obstacle"
        assert not adapter.evaluate(group, target).success, "advisory worker ignored the new obstacle"
        try:
            adapter.execute(blocking=False, plan_id=plan.plan.plan_id)
        except ValueError as exc:
            assert "scene changed" in str(exc)
        else:
            raise AssertionError("a plan from the old scene remained executable")
        try:
            adapter.plan_to_poses({group: target}, speed_scale=0.2)
        except ValueError:
            pass
        else:
            raise AssertionError("checked planner ignored the new obstacle")
        assert adapter.worker is not retired_worker
        assert adapter.worker.process.pid != old_pid
        assert module.remove_obstacle(obstacle)
        assert adapter.evaluate(group, target).success
        assert adapter.plan_to_poses({group: target}, speed_scale=0.2).succeeded
        world = module._world_monitor.world
        # Centers of the distal contact pads in the managed finger meshes.
        with world.scratch_context() as context:
            world.set_joint_state(context, feedback)
            left = world.get_link_pose(context, "hand_left_finger") @ [0.084, -0.0454, 0, 1]
            right = world.get_link_pose(context, "hand_right_finger") @ [0.084, 0.0448, 0, 1]
            assert np.linalg.norm(left[:3] - right[:3]) < 0.01
        obstacle = module.add_obstacle(
            "closed-pad-contact", Pose(position=left[:3].tolist()), "sphere", [0.005]
        )
        assert obstacle and not module._world_monitor.is_state_valid(feedback)
        raw.position[names.index(jaw)] = native_open
        module._on_joint_state(raw)
        opened = adapter.feedback
        assert opened is not None
        with world.scratch_context() as context:
            world.set_joint_state(context, opened)
            left = world.get_link_pose(context, "hand_left_finger") @ [0.084, -0.0454, 0, 1]
            right = world.get_link_pose(context, "hand_right_finger") @ [0.084, 0.0448, 0, 1]
            assert np.linalg.norm(left[:3] - right[:3]) > 0.09
        assert module._world_monitor.is_state_valid(opened), "open pads still touch the test obstacle"
        assert module.remove_obstacle(obstacle)
        module._on_joint_state(JointState(name=names[:-1], position=raw.position[:-1]))
        assert adapter.feedback is None, "missing jaw measurement was accepted"
        print("Official planning scene synchronization verified", flush=True)
    finally:
        adapter.close_workers()
        ManipulationModule.stop(module)


if __name__ == "__main__":
    check_scene()
