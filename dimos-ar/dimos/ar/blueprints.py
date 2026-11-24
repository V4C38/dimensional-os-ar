from __future__ import annotations

from dimos.ar.module import ARModule
from dimos.ar.navigation.native_planner import ARReplanningAStarPlanner
from dimos.ar.robot.capabilities import blueprint_has_object_detection
from dimos.ar.robot.profiles.profile import RobotName
from dimos.core.coordination.blueprints import Blueprint, MetaBlueprint, autoconnect
from dimos.navigation.go2.replanning_a_star.module import ReplanningAStarPlanner
from dimos.protocol.service.system_configurator.clock_sync import ClockSyncConfigurator

try:
    from dimos.robot.unitree.go2.blueprints.smart.unitree_go2 import unitree_go2
except ModuleNotFoundError:
    unitree_go2 = None

try:
    from dimos.robot.unitree.go2.blueprints.agentic.unitree_go2_agentic import (
        unitree_go2_agentic,
    )
except ModuleNotFoundError:
    unitree_go2_agentic = None


def _go2_ar_blueprint(source: MetaBlueprint, *, agent: bool = False) -> Blueprint:
    from dimos.ar.robot.go2_retryable_connection import RetryableGo2Connection
    from dimos.robot.unitree.go2.connection import GO2Connection

    native = source.solidify()
    native_args = {atom.module: atom.kwargs for atom in native.active_blueprints}
    replacements = {ReplanningAStarPlanner: ARReplanningAStarPlanner}
    if agent:
        from dimos.agents.agent import Agent
        from dimos.agents.skills.person_follow import PersonFollowSkillContainer
        from dimos.ar.robot.guarded_agent import ARGuardedAgent, ARPersonFollowSkillContainer

        replacements.update({
            Agent: ARGuardedAgent,
            PersonFollowSkillContainer: ARPersonFollowSkillContainer,
        })
    composed = autoconnect(
        native.disabled_modules(GO2Connection, *replacements),
        RetryableGo2Connection.blueprint(
            instance_name=GO2Connection.name, **native_args[GO2Connection]
        ),
        *(adapter.blueprint(**native_args[original]) for original, adapter in replacements.items()),
        ARModule.blueprint(
            robot=RobotName.UNITREE_GO2,
            navigation_map=True,
            agent=agent,
            object_detection=blueprint_has_object_detection(native),
        ),
    ).solidify()
    # One worker per active module keeps sensor processing from starving the AR worker.
    return composed.global_config(n_workers=len(composed.active_blueprints)).configurators(
        ClockSyncConfigurator()
    )


unitree_go2_ar = _go2_ar_blueprint(unitree_go2) if unitree_go2 is not None else None
unitree_go2_ar_agentic = (
    _go2_ar_blueprint(unitree_go2_agentic, agent=True) if unitree_go2_agentic is not None else None
)
