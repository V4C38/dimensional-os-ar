"""Bounded launcher commands that own and reap their subprocess group."""

from __future__ import annotations

import asyncio
import os
import signal
from contextlib import suppress
from pathlib import Path
from typing import TypedDict

from process_groups import start_owned_process


class CommandOptions(TypedDict, total=False):
    cwd: Path
    env: dict[str, str]


async def capture_command(
    executable: str, *arguments: str, timeout: float | None = None,
    cwd: Path | None = None, env: dict[str, str] | None = None,
) -> tuple[int, bytes, bytes]:
    options: CommandOptions = {}
    if cwd is not None:
        options["cwd"] = cwd
    if env is not None:
        options["env"] = env
    child = None

    def record(proc: asyncio.subprocess.Process) -> None:
        nonlocal child
        child = proc

    try:
        proc = await start_owned_process(asyncio.create_subprocess_exec(
            executable, *arguments, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True, **options,
        ), record)
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
        assert proc.returncode is not None
        return proc.returncode, out, err
    except BaseException:
        if child is not None:
            # Shell helpers such as Git can leave children holding the capture pipes.
            with suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGKILL)
            with suppress(TimeoutError):
                await asyncio.wait_for(child.wait(), timeout=2)
        raise
