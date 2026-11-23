"""Go2 peer replacement for the AR blueprints on the pinned DimOS release."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from concurrent.futures import Future
import contextlib
import copy
import json
import sys
from threading import Event, Lock, Thread, Timer
from typing import Any

from dimos_lcm.std_msgs import Bool
from reactivex.disposable import CompositeDisposable, Disposable
from unitree_webrtc_connect import UnitreeWebRTCConnection as SDKConnection, WebRTCConnectionMethod
from unitree_webrtc_connect.unitree_auth import RobotBusyError

from dimos.ar.robot.live_clock import live_time
from dimos.core.core import rpc
from dimos.core.module import Module
from dimos.core.stream import Out
from dimos.msgs.geometry_msgs.Twist import Twist
from dimos.msgs.sensor_msgs.Image import Image
from dimos.robot.unitree.config import connection_type, require_robot_ip
from dimos.robot.unitree.connection import RTC_TOPIC, UnitreeWebRTCConnection
from dimos.robot.unitree.go2 import connection as native
from dimos.utils.logging_config import setup_logger

logger = setup_logger()

RETRY_DELAY_S = 3.0
ODOMETRY_TIMEOUT_S = 6.0
SIGNALING_TIMEOUT_S = 10.0
REQUEST_TIMEOUT_S = 3.0
PEER_CLOSE_TIMEOUT_S = 3.0
CHANNEL_SETUP_TIMEOUT_S = 15.0
PEER_OPEN_TIMEOUT_S = SIGNALING_TIMEOUT_S + CHANNEL_SETUP_TIMEOUT_S + REQUEST_TIMEOUT_S

# The installed SDK's LAN helper performs synchronous HTTP without a timeout.
# Isolate just this call so a stuck request can be killed and reaped before retry.
_LAN_SIGNALING = """
import contextlib, json, sys
ip, offer, key = json.load(sys.stdin)
try:
    with contextlib.redirect_stdout(sys.stderr):
        from unitree_webrtc_connect.unitree_auth import send_sdp_to_local_peer
        answer = send_sdp_to_local_peer(ip, offer, aes_128_key=key)
except Exception as error:
    print(json.dumps({"error": type(error).__name__}))
else:
    print(json.dumps({"answer": answer}))
"""


class SignalingError(RuntimeError):
    """A sanitized failure from the LAN signaling process."""


class _BoundedSDKConnection(SDKConnection):  # type: ignore[misc]
    async def get_answer_from_local_peer(self, pc: Any, ip: str) -> Any:
        description = pc.localDescription
        offer = {
            "id": "STA_localNetwork",
            "sdp": description.sdp,
            "type": description.type,
            "token": self.token,
        }
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            _LAN_SIGNALING,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            payload = json.dumps([ip, json.dumps(offer), self.aes_128_key]).encode()
            response, _ = await asyncio.wait_for(process.communicate(payload), SIGNALING_TIMEOUT_S)
        finally:
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                await process.wait()
        reply = json.loads(response)
        if "error" in reply:
            raise SignalingError(reply["error"])
        return reply["answer"]


class _Peer(UnitreeWebRTCConnection):  # type: ignore[misc]
    """One immutable native resource per SDK peer, with native codecs and commands."""

    stop_timer: Timer | None

    def __init__(
        self, ip: str, key: str | None, velocity_api: bool, loop: asyncio.AbstractEventLoop
    ) -> None:
        super().__init__(ip, aes_128_key=key, velocity_api=velocity_api)
        self.loop = loop
        self.conn = _BoundedSDKConnection(WebRTCConnectionMethod.LocalSTA, ip=ip, aes_128_key=key)
        self.retired = False
        self.requests: set[Future[Any]] = set()
        self._requests_lock = Lock()
        self.last_odometry: float | None = None

    def connect(self) -> None:
        # The native constructor invokes this virtual method. The owner opens
        # the peer on its loop, without the native connect-time mode command.
        pass

    @property
    def open(self) -> bool:
        return (
            not self.retired
            and self.conn.pc is not None
            and self.conn.pc.connectionState == "connected"
            and self.conn.datachannel.channel.readyState == "open"
        )

    def _publish_movement(self, x: float, y: float, yaw: float) -> None:
        if self.open:
            super()._publish_movement(x, y, yaw)

    def move(self, twist: Twist, duration: float = 0.0) -> bool:
        if not self.open:
            return False

        async def send() -> bool:
            if not self.open:
                return False
            until = live_time() + duration
            while self.open:
                self._publish_movement(twist.linear.x, twist.linear.y, twist.angular.z)
                if duration <= 0:
                    return True
                if live_time() >= until:
                    self._publish_movement(0, 0, 0)
                    return True
                await asyncio.sleep(0.01)
            return False

        if self.stop_timer is not None:
            self.stop_timer.cancel()
        self.stop_timer = Timer(self.cmd_vel_timeout, self.stop_movement)
        self.stop_timer.daemon = True
        self.stop_timer.start()
        return bool(self._request(send(), max(duration, 0) + REQUEST_TIMEOUT_S))

    def publish_request(self, topic: str, data: dict[Any, Any]) -> Any:
        async def send() -> Any:
            if not self.open:
                return {}
            return await self.conn.datachannel.pub_sub.publish_request_new(topic, data)

        return self._request(send(), REQUEST_TIMEOUT_S) or {}

    def _request(self, request: Any, timeout: float) -> Any:
        if self.retired or not self.loop.is_running():
            request.close()
            return None
        with self._requests_lock:
            if self.retired:
                request.close()
                return None
            result = asyncio.run_coroutine_threadsafe(request, self.loop)
            self.requests.add(result)
        try:
            return result.result(timeout=timeout)
        except Exception as error:  # noqa: BLE001 -- worker request boundary
            result.cancel()
            logger.debug("Go2 request ended", reason=type(error).__name__)
            return None
        finally:
            with self._requests_lock:
                self.requests.discard(result)

    async def retire(self) -> None:
        with self._requests_lock:
            self.retired = True
            for result in tuple(self.requests):
                result.cancel()
        if self.stop_timer is not None:
            self.stop_timer.cancel()
        try:
            await asyncio.wait_for(self.conn.disconnect(), PEER_CLOSE_TIMEOUT_S)
        except Exception as error:  # noqa: BLE001 -- peer cleanup boundary
            logger.debug("Go2 peer cleanup failed", reason=type(error).__name__)


class RetryableGo2Connection(native.GO2Connection):  # type: ignore[misc]
    """Keep the native Go2 module stable while replacing its live transport."""

    go2_peer_online: Out[Bool]

    def __init__(self, **kwargs: Any) -> None:
        Module.__init__(self, **kwargs)
        self._camera_info_stop = Event()
        cfg = self.config
        mode = connection_type(replay=cfg.g.replay, simulation=cfg.g.simulation).lower()
        self._live = mode == "webrtc" and cfg.ip not in ("fake", "mock", "replay", "mujoco")
        if self._live:
            self._ip = require_robot_ip(cfg.ip, native._ROBOT_IP_GUIDANCE)
            self._peer: _Peer | None = None
            self._worker: Thread | None = None
            self._task: asyncio.Task[None] | None = None
            self._closing = Event()
            self._ready_peer = False
            self._initialized = False
        else:
            self.connection = native.make_connection(
                cfg.ip, cfg, aes_128_key=cfg.aes_128_key, velocity_api=cfg.velocity_api
            )
            if hasattr(self.connection, "camera_info_static"):
                self.camera_info_static = self.connection.camera_info_static
        if cfg.frame_id_prefix and self.camera_info_static.frame_id:
            self.camera_info_static = copy.copy(self.camera_info_static)
            self.camera_info_static.frame_id = native._prefixed(
                cfg.frame_id_prefix, self.camera_info_static.frame_id
            )

    @rpc  # type: ignore[untyped-decorator]
    def start(self) -> None:
        if not self._live:
            super().start()
            return
        Module.start(self)
        self._camera_info_stop.clear()
        self._closing.clear()
        self.register_disposable(Disposable(self.cmd_vel.subscribe(self.move)))
        if self.config.camera:
            self._camera_info_thread = Thread(target=self.publish_camera_info, daemon=True)
            self._camera_info_thread.start()
        self._worker = Thread(target=lambda: asyncio.run(self._supervise()), daemon=True)
        self._worker.start()

    @property
    def connection(self) -> Any:
        if self._live:
            peer = self._peer
            return peer if self._ready_peer and peer is not None else _OFFLINE
        return self._stock_connection

    @connection.setter
    def connection(self, value: Any) -> None:
        self._stock_connection = value

    @rpc  # type: ignore[untyped-decorator]
    def stop(self) -> None:
        if not self._live:
            super().stop()
            return
        self._camera_info_stop.set()
        self._closing.set()
        try:
            self.liedown()
        finally:
            Module.stop(self)
            task = self._task
            if task is not None:
                task.get_loop().call_soon_threadsafe(task.cancel)
            if self._worker is not None:
                self._worker.join(timeout=PEER_CLOSE_TIMEOUT_S + REQUEST_TIMEOUT_S)
            if self._camera_info_thread is not None:
                self._camera_info_thread.join(timeout=1.0)

    def _initial_setup(self, peer: _Peer) -> None:
        peer.publish_request(
            RTC_TOPIC["MOTION_SWITCHER"], {"api_id": 1002, "parameter": {"name": peer.mode}}
        )
        if self.config.motion_mode and peer.open and not self._closing.is_set():
            peer.set_motion_mode(self.config.motion_mode)
        if self._closing.is_set() or not peer.open:
            return
        peer.standup()
        if self._closing.wait(3) or not peer.open:
            return
        peer.balance_stand()
        if self.config.mode == native.Go2Mode.RAGE and peer.open and not self._closing.is_set():
            peer.set_rage_mode(True)
        if peer.open and not self._closing.is_set():
            peer.set_obstacle_avoidance(self.config.obstacle_avoidance)

    def _publish_peer_online(self, online: bool) -> None:
        if self.go2_peer_online.transport is not None:
            self.go2_peer_online.publish(Bool(online))

    async def _supervise(self) -> None:
        task = asyncio.current_task()
        if task is not None:
            self._task = task
        outage = live_time()
        attempts = 0
        busy_reported = False
        while not self._closing.is_set():
            attempts += 1
            healthy = False
            peer = _Peer(
                self._ip,
                self.config.aes_128_key,
                self.config.velocity_api,
                asyncio.get_running_loop(),
            )
            self._peer = peer
            subscriptions = CompositeDisposable()

            def forward(
                handler: Callable[[Any], None], source: _Peer = peer
            ) -> Callable[[Any], None]:
                def receive(value: Any) -> None:
                    if not source.retired and self._peer is source:
                        handler(value)

                return receive

            def on_odometry(pose: Any, source: _Peer = peer) -> None:
                first = source.last_odometry is None
                source.last_odometry = live_time()
                if first:
                    self._publish_peer_online(True)
                self._publish_tf(pose)

            def on_image(image: Image) -> None:
                image.frame_id = native._prefixed(self.config.frame_id_prefix, image.frame_id)
                self.color_image.publish(image)

            attempt_started = live_time()
            stage = "handshake"
            try:
                logger.debug("Go2 connection attempt", attempt=attempts)
                await asyncio.wait_for(peer.conn.connect(), PEER_OPEN_TIMEOUT_S)
                stage = "stream setup"
                await asyncio.wait_for(
                    peer.conn.datachannel.disableTrafficSaving(True), REQUEST_TIMEOUT_S
                )
                peer.conn.datachannel.set_decoder(decoder_type="native")
                attached_at = live_time()
                subscriptions.add(peer.odom_stream().subscribe(forward(on_odometry)))
                subscriptions.add(peer.lowstate_stream().subscribe(forward(self._on_lowstate)))
                if self.config.lidar:
                    subscriptions.add(peer.lidar_stream().subscribe(forward(self.lidar.publish)))
                if self.config.camera:
                    subscriptions.add(peer.video_stream().subscribe(forward(on_image)))
                if not self._initialized:
                    self._initialized = True
                    await asyncio.to_thread(self._initial_setup, peer)
                stage = "telemetry"
                while (
                    peer.open
                    and live_time()
                    - (peer.last_odometry if peer.last_odometry is not None else attached_at)
                    < ODOMETRY_TIMEOUT_S
                ):
                    if peer.last_odometry is not None and not healthy:
                        healthy = self._ready_peer = True
                        logger.info(
                            "Go2 connected", attempts=attempts, elapsed=live_time() - outage
                        )
                    await asyncio.sleep(0.1)
            except RobotBusyError:
                if not busy_reported:
                    logger.warning("Go2 rejected the WebRTC offer as busy")
                    busy_reported = True
            except Exception as error:  # noqa: BLE001 -- retry boundary
                reason = str(error) if isinstance(error, SignalingError) else type(error).__name__
                logger.debug(
                    "Go2 connection attempt failed",
                    stage=stage,
                    reason=reason,
                    elapsed=live_time() - attempt_started,
                )
            finally:
                self._ready_peer = False
                self._peer = None
                subscriptions.dispose()
                if peer.last_odometry is not None:
                    self._publish_peer_online(False)
                await peer.retire()

            if healthy:
                logger.info("Go2 disconnected")
                outage = live_time()
                attempts = 0
                busy_reported = False
            else:
                logger.debug("Go2 connection retry scheduled", delay=RETRY_DELAY_S)
                await asyncio.sleep(RETRY_DELAY_S)


class _DisconnectedConnection:
    def __getattr__(self, _name: str) -> Callable[..., bool]:
        # All commands on the live module use the native synchronous interface.
        return lambda *args, **kwargs: False


_OFFLINE = _DisconnectedConnection()
