"""Run the local launcher and open its page after this server is listening."""

from __future__ import annotations

import asyncio
import shutil
import sys

import uvicorn

HOST = "127.0.0.1"
PORT = 8790


async def serve() -> None:
    server = uvicorn.Server(
        uvicorn.Config("app:create_app", factory=True, host=HOST, port=PORT, timeout_graceful_shutdown=2)
    )
    task = asyncio.create_task(server.serve())
    while not server.started and not task.done():
        await asyncio.sleep(0.05)
    if server.started and (opener := shutil.which("open")):
        try:
            await asyncio.create_subprocess_exec(opener, f"http://{HOST}:{PORT}")
        except OSError as exc:
            print(f"Could not open launcher in the browser: {exc}", file=sys.stderr)
    await task


if __name__ == "__main__":
    asyncio.run(serve())
