import asyncio
from dataclasses import replace
from types import SimpleNamespace

import numpy as np

from dimos.ar.navigation.map_feed import NavigationMapFeed, _encode_crop
from dimos.ar.replication.interaction import (
    NAVIGATION_MAP_SOURCE,
    InteractionCoordinator,
    InteractionRequest,
    NavigationMapTarget,
    SharedTarget,
    decode_interaction_request,
)
from dimos.ar.spatial import FrameSnapshot, frozen_matrix
from dimos.ar.websocket.protocol import NavigationMapRequest, decode_inbound
from dimos.msgs.geometry_msgs.Pose import Pose
from dimos.msgs.nav_msgs.OccupancyGrid import OccupancyGrid


def test_native_crop_preserves_cost_rows_and_connected_route() -> None:
    costs = np.arange(400 * 300, dtype=np.int64).reshape(400, 300)
    costs = np.asarray((costs % 102) - 1, dtype=np.int8)
    grid = OccupancyGrid(
        grid=costs, resolution=0.05, origin=Pose(position=[-7.5, -10.0, 0.0])
    )
    path = tuple((float(x), 0.0) for x in np.linspace(-9, 9, 512))
    height = np.array([[1, 2, 1]], dtype="<f4")
    encoded = _encode_crop(grid, (0, 0), (1, 2, 0), height, ((9, 0), path), 4)
    assert encoded is not None
    header, body = encoded
    assert header["origin"] == (-6.0, -6.0)
    assert body[: 240 * 240] == costs[80:320, 30:270].tobytes()
    assert header["target"] == (9, 0)
    assert header["height_count"] == 1
    assert len(body) <= 65_536
    segments = np.frombuffer(body[240 * 240 + 12 :], dtype="<f4").reshape(-1, 4)
    assert len(segments) <= 256
    assert tuple(segments[0, :2]) == (-6.0, 0.0)
    assert tuple(segments[-1, 2:]) == (6.0, 0.0)
    np.testing.assert_array_equal(segments[:-1, 2:], segments[1:, :2])


def test_crop_prefetches_around_the_visible_viewport() -> None:
    grid = OccupancyGrid(grid=np.zeros((800, 800), dtype=np.int8), resolution=0.05,
                         origin=Pose(position=[-20, -20, 0]))
    encoded = _encode_crop(grid, (0, 0), (0, 0, 0), np.empty((0, 3)), (None, ()), 4)
    assert encoded is not None
    header, _ = encoded
    assert header["origin"] == (-6, -6)
    assert header["width"] * header["resolution"] == 12
    assert header["height"] * header["resolution"] == 12


def test_zoomed_out_viewport_keeps_extent_and_high_costs_under_the_cell_cap() -> None:
    costs = np.full((800, 800), -1, dtype=np.int8)
    costs[400, 400] = 100
    grid = OccupancyGrid(grid=costs, resolution=0.05, origin=Pose(position=[-20, -20, 0]))
    encoded = _encode_crop(grid, (0, 0), (0, 0, 0), np.empty((0, 3)), (None, ()), 20)
    assert encoded is not None
    header, body = encoded
    assert header["width"] == header["height"] == 200
    assert header["resolution"] == 0.2
    assert header["origin"] == (-20, -20)
    assert set(np.frombuffer(body, dtype=np.int8)) == {-1, 100}


def test_map_viewport_and_native_confirm_decode() -> None:
    viewport = decode_inbound(
        '{"type":"navigation_map_request","subscription_id":"a","sequence":4,'
        '"enabled":true,"radius_m":6,"center":[1,2]}'
    )
    assert viewport == NavigationMapRequest("a", 4, True, (1, 2))
    request = decode_interaction_request({
        "request_id": "a", "action": "confirm",
        "map_target": {"position": [1, 2], "source_generation": 3, "odom_reference_id": "odom"},
    })
    assert request.map_target == NavigationMapTarget((1, 2), "odom", 3)


def test_map_snapshot_carries_the_native_to_shared_rotation() -> None:
    transform = np.eye(4)
    transform[:2, :2] = [[0, -1], [1, 0]]
    frame = replace(FrameSnapshot.initial("odom"), shared_frame_id="shared", T_map_odom=frozen_matrix(transform))
    sent = []
    peer = SimpleNamespace(navigation_map_request=NavigationMapRequest("view", 1, True, None))
    peer.navigation_map = lambda request, header, data: sent.append(header)
    pose = SimpleNamespace(position=(0, 0, 0), orientation=(0, 0, 0, 1))
    feed = NavigationMapFeed(peers=lambda: [peer], pose=lambda: pose, identity=lambda: ("odom", 0),
                             geometry=lambda: (None, ()), frames=lambda: frame,
                             available=lambda: True, recording=False)
    feed.update_grid(OccupancyGrid(grid=np.zeros((4, 4), dtype=np.int8), resolution=1.0,
                                   origin=Pose(position=[-2.0, -2.0, 0.0])))
    asyncio.run(feed._publish())
    assert sent[0]["shared_frame_id"] == "shared"
    np.testing.assert_allclose(np.abs(sent[0]["map_odom_rotation"]), [0, 0, 2 ** -0.5, 2 ** -0.5])


def test_refused_map_target_preserves_the_world_target() -> None:
    owner = InteractionCoordinator()
    client = "client"
    owner.connect(client)
    world_acquire = owner.handle(client, InteractionRequest(
        "acquire-world", "acquire", owner.epoch,
        kind="navigation_planning", position=(1, 2, 0), orientation=(0, 0, 0, 1),
    ))
    owner.handle(client, InteractionRequest(
        "commit-world", "confirm", owner.epoch, lease_id=world_acquire.lease_id, sequence=0,
        position=(1, 2, 0), orientation=(0, 0, 0, 1),
    ), commit=lambda *_: True)
    world = owner.target
    assert world is not None
    map_acquire = owner.handle(client, InteractionRequest(
        "acquire-map", "acquire", owner.epoch, kind="navigation_planning",
        source_id=NAVIGATION_MAP_SOURCE,
    ))
    native = NavigationMapTarget((3, 4), "odom", 0)
    request = InteractionRequest(
        "confirm-map", "confirm", owner.epoch, lease_id=map_acquire.lease_id, sequence=0,
        map_target=native,
    )
    refused = owner.handle(client, request, commit_map=lambda _: None)
    assert refused.status == "rejected"
    assert owner.authority is None
    assert owner.target is world
    called: list[NavigationMapTarget] = []

    def unexpected(target: NavigationMapTarget) -> SharedTarget | None:
        called.append(target)
        return None

    assert owner.handle(client, request, commit_map=unexpected).status == "rejected"
    assert called == []
