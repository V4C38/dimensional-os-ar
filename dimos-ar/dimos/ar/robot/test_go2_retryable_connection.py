from __future__ import annotations

import asyncio
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

from reactivex.subject import Subject
from unitree_webrtc_connect.unitree_auth import RobotBusyError

from dimos.ar.robot import go2_retryable_connection as go2
from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from test_support.module import MockRPC


def test_retries_until_shutdown_and_does_not_repeat_startup(monkeypatch):
    peers = []
    odometry = Event()

    class Peer:
        retired = False
        last_odometry = None

        def __init__(self, *_args):
            peers.append(self)
            self.index = len(peers)
            self.open = True
            self.stream = Subject()
            self.connected = Event()
            self.conn = SimpleNamespace(
                connect=self.connect,
                datachannel=SimpleNamespace(
                    disableTrafficSaving=self.disable_traffic_saving, set_decoder=lambda **_: None
                ),
            )

        async def connect(self):
            if self.index in (1, 3, 4):
                raise RobotBusyError()

        async def disable_traffic_saving(self, _enabled):
            pass

        def odom_stream(self):
            return self.stream

        def lowstate_stream(self):
            return Subject()

        async def retire(self):
            self.retired = True

    monkeypatch.setattr(go2, "_Peer", Peer)
    monkeypatch.setattr(go2, "RETRY_DELAY_S", 0.01)
    connection = go2.RetryableGo2Connection(
        ip="192.0.2.1", camera=False, lidar=False, rpc_transport=MockRPC
    )
    initial_setup = Mock()
    connection._initial_setup = initial_setup
    connection._publish_peer_online = Mock()
    connection.cmd_vel.transport = Mock()
    connection._publish_tf = Mock(side_effect=lambda _pose: odometry.set())

    async def drive():
        task = asyncio.create_task(connection._supervise())
        try:
            while len(peers) < 2 or not peers[1].stream.observers:
                await asyncio.sleep(0.001)
            first = PoseStamped(position=[1, 0, 0])
            peers[1].stream.on_next(first)
            assert odometry.is_set()
            while not connection._ready_peer:
                await asyncio.sleep(0.001)

            peers[1].open = False
            while len(peers) < 5 or not peers[4].stream.observers:
                await asyncio.sleep(0.001)
            assert all(peer.retired for peer in peers[:4])
            old = PoseStamped(position=[2, 0, 0])
            newest = PoseStamped(position=[3, 0, 0])
            peers[1].stream.on_next(old)
            peers[4].stream.on_next(newest)
            assert [call.args[0] for call in connection._publish_tf.call_args_list] == [
                first,
                newest,
            ]
            initial_setup.assert_called_once_with(peers[1])
            assert [call.args[0] for call in connection._publish_peer_online.call_args_list] == [
                True,
                False,
                True,
            ]
        finally:
            connection._closing.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert all(peer.retired for peer in peers)

    asyncio.run(asyncio.wait_for(drive(), 2))


def test_stalled_signaling_child_is_killed_and_reaped(monkeypatch):
    original_spawn = asyncio.create_subprocess_exec
    children = []

    async def spawn(*args, **kwargs):
        child = await original_spawn(*args, **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(go2, "_LAN_SIGNALING", "import time; time.sleep(60)")
    monkeypatch.setattr(go2, "SIGNALING_TIMEOUT_S", 0.05)
    sdk = go2._BoundedSDKConnection(go2.WebRTCConnectionMethod.LocalSTA, ip="192.0.2.1")
    pc = SimpleNamespace(localDescription=SimpleNamespace(sdp="offer", type="offer"))

    async def attempt():
        try:
            await sdk.get_answer_from_local_peer(pc, "192.0.2.1")
        except TimeoutError:
            assert len(children) == 1
            assert children[0].returncode is not None
        else:
            raise AssertionError("blocked signaling did not time out")

    asyncio.run(asyncio.wait_for(attempt(), 2))
