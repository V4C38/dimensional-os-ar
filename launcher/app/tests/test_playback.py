"""Exercise the private replay process transport."""

import asyncio
import json

import pytest

from playback import PlaybackSession


@pytest.mark.asyncio
async def test_playback_requests_use_owned_socket() -> None:
    playback = PlaybackSession()
    observed = []

    async def accept(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        observed.append(json.loads(await reader.readline()))
        writer.write(
            b'{"state":"seeking","elapsed_s":2,"duration_s":4,"generation":3}\n'
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    try:
        server = await asyncio.start_unix_server(accept, path=playback.path)
        async with server:
            assert await playback.request("seek", 2) == {
                "session_id": playback.id,
                "state": "seeking",
                "elapsed_s": 2,
                "duration_s": 4,
                "generation": 3,
            }
            assert observed == [{"action": "seek", "elapsed_s": 2}]
    finally:
        playback.close()
    assert not playback.path.parent.exists()


@pytest.mark.asyncio
async def test_replay_controls_follow_the_owned_backend(runtime, app_context) -> None:
    import httpx

    from app import create_app

    manager, _, spawn = runtime
    app_context.manager = manager
    await manager.start_armodule(blueprint="unitree_go2_ar", robot_ip="simulated")
    playback = manager.runtime.backend.playback
    assert playback is not None
    assert spawn.call_args.kwargs["env"]["DIMOS_AR_PLAYBACK_SOCKET"] == str(playback.path)

    async def accept(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        command = json.loads(await reader.readline())
        elapsed = command.get("elapsed_s", 0)
        writer.write(
            json.dumps({
                "state": "seeking" if command["action"] == "seek" else "paused",
                "elapsed_s": elapsed,
                "duration_s": 10,
                "generation": 1,
            }).encode() + b"\n"
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(accept, path=playback.path)
    async with server, httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app(app_context)),
        base_url="http://127.0.0.1",
    ) as client:
        reply = await client.post("/api/replay/playback", json={
            "session_id": "old", "action": "stop",
        })
        assert reply.status_code == 409
        reply = await client.post("/api/replay/playback", json={
            "session_id": playback.id, "action": "seek", "elapsed_s": 6,
        })
        assert reply.status_code == 200
        assert reply.json()["state"] == "seeking"
        assert reply.json()["elapsed_s"] == 6
        status = await client.get("/api/status")
        assert status.json()["playback"]["session_id"] == playback.id
    await manager.stop_backend()
    assert manager.snapshot()["playback"] is None
