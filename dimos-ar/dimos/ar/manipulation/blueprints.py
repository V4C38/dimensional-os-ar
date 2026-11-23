"""Official OpenYAM composition, loaded only by its optional entry point."""

from dimos.ar.manipulation.following import ARManipulationCoordinator
from dimos.ar.manipulation.model import ReferencePose
from dimos.ar.manipulation.model_config import (
    make_ar_openyam_model,
    openyam_gripper_feedback_limits,
    soft_joint_limits,
)
from dimos.ar.manipulation.module import ARManipulationModule
from dimos.ar.module import ARModule
from dimos.ar.robot.profiles.profile import RobotName
from dimos.control.coordinator import TaskConfig
from dimos.core.coordination.blueprints import autoconnect
from dimos.core.global_config import global_config
from dimos.robot.manipulators.damiao.damiao_blueprint import (
    arm_connection,
    arm_declaration,
    arm_remaps,
)
from dimos.robot.manipulators.openyam.blueprints.basic import _gripper_task, _trajectory_task
from dimos.robot.manipulators.openyam.connection import OpenYamConnection
from dimos.robot.manipulators.openyam.joints import OPENYAM_GRIPPER_JOINT

_model = make_ar_openyam_model()
_declaration = arm_declaration(OpenYamConnection)
if global_config.simulation:
    _connection_class = OpenYamConnection
    _connection = arm_connection(_connection_class)
else:
    from dimos.ar.manipulation.protected_hardware import ProtectedOpenYamConnection

    _connection_class = ProtectedOpenYamConnection
    _connection = _connection_class.blueprint(
        instance_name="OpenYamConnection",
        **_declaration.model_dump(exclude={"instance_name"}),
        safety_limits=soft_joint_limits(_model),
    )
_pose_groups = [g for g in _model.planning_groups if g.tip_link]
_tasks = {g.name: f"ar_follow_{g.name}" for g in _pose_groups}

openyam_ar_planner = autoconnect(
    ARManipulationModule.blueprint(
        model=_model,
        instance_name="ManipulationModule",
        following_tasks=_tasks,
        model_asset_url="/models/openyam.glb",
        model_visual_profile="openyam",
        gripper_joint_names=[OPENYAM_GRIPPER_JOINT],
        reversed_feedback_joint_limits=openyam_gripper_feedback_limits(),
        gripper_tasks={"manipulator": "arm_gripper"},
        joint_arrival_tolerance_rad=0.05,
    ),
    _connection,
    ARManipulationCoordinator.blueprint(
        instance_name="ControlCoordinator",
        connections=[_declaration],
        require_motor_protection=not global_config.simulation,
        tasks=[
            _trajectory_task(),
            _gripper_task(),
            *[
                TaskConfig(
                    name=_tasks[group.name],
                    type="ar_cartesian_ik",
                    joint_names=list(group.joint_names),
                    priority=20,
                    params={"robot_model": _model, "target_frame": group.tip_link},
                )
                for group in _pose_groups
            ],
        ],
    ),
    ARModule.blueprint(
        robot=RobotName.OPENYAM,
        stationary_base=ReferencePose(),
    ),
).remappings(arm_remaps(_connection_class, ARManipulationCoordinator)).solidify()

openyam_ar_planner = openyam_ar_planner.global_config(
    n_workers=len(openyam_ar_planner.active_blueprints),
)
