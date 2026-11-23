from __future__ import annotations

from unittest.mock import Mock

import pytest
from reactivex import Subject

from dimos.ar.blueprints import unitree_go2_ar, unitree_go2_ar_agentic
from dimos.ar.module import ARModule
from dimos.ar.robot.profiles.profile import RobotName
from test_support.module import MockRPC


@pytest.mark.parametrize("blueprint", [unitree_go2_ar, unitree_go2_ar_agentic])
def test_go2_blueprints_use_one_native_mapper_for_mapping_and_relocalization(blueprint) -> None:
    if blueprint is None:
        pytest.skip("Go2 blueprint is not installed")
    from dimos.navigation.go2.loop_closure.module import PGOVoxelMapper

    atoms = [atom for atom in blueprint.active_blueprints if atom.module is PGOVoxelMapper]
    assert len(atoms) == 1
    assert atoms[0].kwargs.get("map_file") is None
    assert {stream.name for stream in atoms[0].streams} >= {"tf", "global_map", "odom", "lidar"}


@pytest.mark.parametrize("blueprint", [unitree_go2_ar, unitree_go2_ar_agentic])
def test_go2_blueprints_have_consistent_stream_types(blueprint) -> None:
    if blueprint is None:
        pytest.skip("Go2 blueprint is not installed")
    stream_types = {}
    for atom in blueprint.active_blueprints:
        for stream in atom.streams:
            prior = stream_types.setdefault(stream.name, stream.type)
            assert stream.type == prior, f"Conflicting types for {stream.name} in {atom.module}"


def test_unitree_go2_ar_selects_robot_explicitly() -> None:
    if unitree_go2_ar is None:
        pytest.skip("unitree_go2 blueprint is not installed")
    atoms = [atom for atom in unitree_go2_ar.active_blueprints if atom.module is ARModule]
    assert len(atoms) == 1
    assert atoms[0].kwargs["robot"] is RobotName.UNITREE_GO2
    assert atoms[0].kwargs.get("agent", False) is False
    ports = {stream.name for stream in atoms[0].streams}
    assert {"odom", "lidar", "path", "ar_navigation_status", "goal_request", "stop_movement"} <= ports
    assert {"human_input", "agent", "agent_idle", "tele_cmd_vel"} <= ports


def test_unitree_go2_ar_agentic_wires_agent_ports() -> None:
    if unitree_go2_ar_agentic is None:
        pytest.skip("unitree_go2_agentic blueprint is not installed")
    atoms = [atom for atom in unitree_go2_ar_agentic.active_blueprints if atom.module is ARModule]
    assert len(atoms) == 1
    assert atoms[0].kwargs["robot"] is RobotName.UNITREE_GO2
    assert atoms[0].kwargs["agent"] is True
    ports = {stream.name for stream in atoms[0].streams}
    assert {"human_input", "agent", "agent_idle"} <= ports
    names = {atom.module.__name__ for atom in unitree_go2_ar_agentic.active_blueprints}
    assert {"ARGuardedAgent", "ARPersonFollowSkillContainer", "ARReplanningAStarPlanner"} <= names
    assert "Agent" not in names
    assert "McpServer" in names


@pytest.mark.parametrize("blueprint", [unitree_go2_ar, unitree_go2_ar_agentic])
def test_go2_blueprints_connect_preview_costmap(blueprint) -> None:
    if blueprint is None:
        pytest.skip("Go2 blueprint is not installed")
    ar = next(atom for atom in blueprint.active_blueprints if atom.module is ARModule)
    inputs = [stream for stream in ar.streams if stream.name == "global_costmap"]
    assert len(inputs) == 1 and inputs[0].direction == "in"
    outputs = [
        stream
        for atom in blueprint.active_blueprints
        for stream in atom.streams
        if stream.name == "global_costmap" and stream.direction == "out"
    ]
    assert outputs, "autoconnect requires a global_costmap producer in both Go2 blueprints"
    assert outputs[0].type == inputs[0].type


@pytest.mark.parametrize("blueprint", [unitree_go2_ar, unitree_go2_ar_agentic])
def test_go2_blueprints_connect_correlated_navigation_status(blueprint) -> None:
    if blueprint is None:
        pytest.skip("Go2 blueprint is not installed")
    ar = next(atom for atom in blueprint.active_blueprints if atom.module is ARModule)
    incoming = next(stream for stream in ar.streams if stream.name == "ar_navigation_status")
    planner = next(
        atom for atom in blueprint.active_blueprints
        if atom.module.__name__ == "ARReplanningAStarPlanner"
    )
    outgoing = next(stream for stream in planner.streams if stream.name == incoming.name)
    assert incoming.direction == "in" and outgoing.direction == "out"
    assert incoming.type == outgoing.type


def test_go2_agentic_control_providers_match_rpc_specs() -> None:
    if unitree_go2_ar_agentic is None:
        pytest.skip("unitree_go2_agentic blueprint is not installed")

    from dimos.ar.navigation.native_planner import ARReplanningAStarPlanner
    from dimos.ar.robot.agent_control import ARAgentNavigationSpec, ARFollowingQuiescenceSpec
    from dimos.ar.robot.guarded_agent import ARPersonFollowSkillContainer
    from dimos.spec.utils import spec_annotation_compliance

    assert spec_annotation_compliance(ARReplanningAStarPlanner, ARAgentNavigationSpec)
    assert spec_annotation_compliance(ARPersonFollowSkillContainer, ARFollowingQuiescenceSpec)


@pytest.mark.parametrize("blueprint", [unitree_go2_ar, unitree_go2_ar_agentic])
def test_go2_composition_resolves_control_and_delivers_peer_odometry(blueprint, monkeypatch):
    if blueprint is None:
        pytest.skip("Go2 blueprint is not installed")

    from dimos.ar.navigation.native_planner import ARReplanningAStarPlanner
    from dimos.ar.robot.go2_retryable_connection import RetryableGo2Connection
    from dimos.core.coordination.module_coordinator import resolve_module_refs
    from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
    from dimos.robot.unitree.go2 import connection

    refs = resolve_module_refs(blueprint)
    assert refs["armodule", "_navigation_control"] == ARReplanningAStarPlanner.name
    if blueprint is unitree_go2_ar_agentic:
        assert refs["armodule", "_agent_control"] == "arguardedagent"
        assert refs["arguardedagent", "_mcp_server"] == "mcpserver"

    atoms = {atom.module: atom for atom in blueprint.active_blueprints}
    peer = Mock(spec=connection.Go2ConnectionProtocol)
    odometry = Subject()
    peer.odom_stream.return_value = odometry
    peer.lowstate_stream.return_value = Subject()
    peer.lidar_stream.return_value = Subject()
    monkeypatch.setattr(connection, "make_connection", Mock(return_value=peer))

    assert atoms[RetryableGo2Connection].name == "go2connection"
    emitted = next(s for s in atoms[RetryableGo2Connection].streams if s.name == "go2_peer_online")
    consumed = next(s for s in atoms[ARModule].streams if s.name == "go2_peer_online")
    assert emitted.direction == "out" and consumed.direction == "in"
    assert emitted.type == consumed.type
    native = RetryableGo2Connection(
        **atoms[RetryableGo2Connection].kwargs, ip="mock", rpc_transport=MockRPC, camera=False
    )
    planner = ARReplanningAStarPlanner(
        **atoms[ARReplanningAStarPlanner].kwargs, rpc_transport=MockRPC
    )
    native.cmd_vel.transport = Mock()
    native.odom.transport = Mock()
    for input_port in planner.inputs.values():
        input_port.transport = Mock()
    planner.odom.transport.subscribe.side_effect = lambda cb, port: native.odom.subscribe(cb)
    try:
        planner.start()
        native.start()
        pose = PoseStamped(position=[1, 2, 0])
        odometry.on_next(pose)
        assert planner._planner._current_odom is pose
    finally:
        native.stop()
        planner.stop()
    peer.stop.assert_called_once()
