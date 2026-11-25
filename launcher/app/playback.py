"""Launcher-owned private connection to a recording playback process."""

from __future__ import annotations

import asyncio
import json
import math
import tempfile
from pathlib import Path
from typing import Literal, TypedDict, cast
from uuid import uuid4

PLAYBACK_SOCKET_ENV = "DIMOS_AR_PLAYBACK_SOCKET"

PlaybackAction = Literal["status", "play", "pause", "stop", "seek"]
PlaybackState = Literal["playing", "paused", "stopped", "seeking", "ended", "error"]


class PlaybackStatus(TypedDict):
    session_id: str
    state: PlaybackState
    elapsed_s: float
    duration_s: float
    generation: int


class PlaybackSession:
    def __init__(self) -> None:
        # Keep the path below the Unix-domain socket limit on macOS as well as Linux.
        self._directory = tempfile.TemporaryDirectory(prefix="dimos-replay-", dir="/tmp")
        self.path = Path(self._directory.name) / "replay.sock"
        self.id = uuid4().hex
        self.status: PlaybackStatus | None = None
        self.poller: asyncio.Task[None] | None = None
        self.lock = asyncio.Lock()

    async def request(
        self, action: PlaybackAction, elapsed_s: float | None = None
    ) -> PlaybackStatus:
        async with asyncio.timeout(1):
            reader, writer = await asyncio.open_unix_connection(self.path, limit=4096)
            try:
                payload: dict[str, str | float] = {"action": action}
                if elapsed_s is not None:
                    payload["elapsed_s"] = elapsed_s
                writer.write(json.dumps(payload, allow_nan=False).encode() + b"\n")
                await writer.drain()
                reply = json.loads(await reader.readline())
            finally:
                writer.close()
                await writer.wait_closed()
        if not isinstance(reply, dict):
            raise TypeError("Invalid playback response")
        if "error" in reply:
            raise RuntimeError(str(reply["error"]))
        state, elapsed, duration, generation = (
            reply.get(key) for key in ("state", "elapsed_s", "duration_s", "generation")
        )
        if (
            state not in ("playing", "paused", "stopped", "seeking", "ended", "error")
            or not isinstance(elapsed, (float, int))
            or isinstance(elapsed, bool)
            or not isinstance(duration, (float, int))
            or isinstance(duration, bool)
            or not math.isfinite(elapsed)
            or not math.isfinite(duration)
            or not 0 <= elapsed <= duration
            or type(generation) is not int
            or generation < 0
        ):
            raise ValueError("Invalid playback status")
        return {
            "session_id": self.id,
            "state": cast(PlaybackState, state),
            "elapsed_s": elapsed,
            "duration_s": duration,
            "generation": generation,
        }

    def close(self) -> None:
        if self.poller is not None:
            self.poller.cancel()
        self._directory.cleanup()
