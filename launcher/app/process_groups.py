"""Signal and reap process groups started by the launcher."""

from __future__ import annotations

import asyncio
import os
import signal
import time
from collections.abc import Callable, Coroutine, Sequence
from pathlib import Path
from typing import Any


async def start_owned_process(
    spawn: Coroutine[Any, Any, asyncio.subprocess.Process],
    record: Callable[[asyncio.subprocess.Process], None],
) -> asyncio.subprocess.Process:
    """Publish the child handle before an interrupted spawn unwinds."""
    launch = asyncio.create_task(spawn)
    try:
        proc = await asyncio.shield(launch)
    except asyncio.CancelledError:
        try:
            proc = await launch
        except OSError:
            pass
        else:
            record(proc)
        raise
    record(proc)
    return proc


class ProcessGroups:
    def __init__(self, log: Callable[[str], None]) -> None:
        self.log = log
        self.stopping_pids: set[int] = set()

    async def stop(
        self,
        proc: asyncio.subprocess.Process | None,
        label: str,
        grace: float,
    ) -> bool:
        if proc is None:
            return False
        if proc.returncode is not None:
            try:
                os.killpg(proc.pid, 0)
            except ProcessLookupError:
                return False
        return await self.stop_group(proc.pid, label, grace, proc=proc)

    async def stop_group(
        self, group: int, label: str, grace: float, *,
        proc: asyncio.subprocess.Process | None = None,
    ) -> bool:
        async def wait_for_exit() -> None:
            if proc is not None and proc.returncode is None:
                await proc.wait()
            while _group_alive(group):
                await asyncio.sleep(0.02)

        self.stopping_pids.add(group)
        try:
            self.log(f"Stopping {label} (SIGINT)…")
            try:
                os.killpg(group, signal.SIGINT)
            except ProcessLookupError:
                return False
            try:
                await asyncio.wait_for(wait_for_exit(), timeout=grace)
            except TimeoutError:
                self.log(f"{label} did not stop in time — sending SIGKILL")
                try:
                    os.killpg(group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await asyncio.wait_for(wait_for_exit(), timeout=2)
        finally:
            self.stopping_pids.discard(group)
        return True

    async def force_stop(self, processes: Sequence[asyncio.subprocess.Process | None]) -> list[int]:
        groups = self.stopping_pids | {p.pid for p in processes if p is not None}
        roots = self.stopping_pids | {
            p.pid for p in processes if p is not None and p.returncode is None
        }
        group_members: set[int] = set()
        children: dict[int, list[int]] = {}
        for entry in Path("/proc").iterdir() if Path("/proc").is_dir() else []:
            if not entry.name.isdigit():
                continue
            try:
                fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
                pid = int(entry.name)
                children.setdefault(int(fields[1]), []).append(pid)
                if int(fields[2]) in groups:
                    group_members.add(pid)
            except (OSError, ValueError, IndexError):
                continue
        if not Path("/proc").is_dir():
            process = await asyncio.create_subprocess_exec(
                "ps", "-axo", "pid=,ppid=,pgid=", stdout=asyncio.subprocess.PIPE
            )
            output, _ = await process.communicate()
            for line in output.decode().splitlines():
                fields = line.split()
                if len(fields) == 3:
                    pid, parent, group = map(int, fields)
                    children.setdefault(parent, []).append(pid)
                    if group in groups:
                        group_members.add(pid)
        owned: list[int] = []

        def collect(pid: int) -> None:
            if pid in owned:
                return
            owned.append(pid)
            for child in children.get(pid, []):
                collect(child)

        # A worker can outlive its parent and be reparented while still
        # belonging to the launcher-owned process group.
        for pid in roots | group_members:
            collect(pid)
        self.log("Force stopping owned runtime processes…")
        for pid in reversed(owned):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 2

        def alive(pid: int) -> bool:
            try:
                return (
                    Path(f"/proc/{pid}/stat")
                    .read_text()
                    .rsplit(")", 1)[1]
                    .split()[0]
                    != "Z"
                )
            except (OSError, IndexError):
                if Path("/proc").is_dir():
                    return False
                try:
                    os.kill(pid, 0)
                    return True
                except ProcessLookupError:
                    return False

        while any(alive(pid) for pid in owned) and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        return [pid for pid in owned if alive(pid)]


def _group_alive(group: int) -> bool:
    try:
        os.killpg(group, 0)
    except ProcessLookupError:
        return False
    proc_dir = Path("/proc")
    if not proc_dir.is_dir():
        return True
    for entry in proc_dir.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            if int(fields[2]) == group and fields[0] != "Z":
                return True
        except (OSError, ValueError, IndexError):
            continue
    return False
