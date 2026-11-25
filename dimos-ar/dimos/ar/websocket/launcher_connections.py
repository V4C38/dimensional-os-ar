"""Emit the current connection list over the launcher-owned backend pipe."""

import json
import os


class LauncherConnections:
    def __init__(self) -> None:
        self.enabled = os.environ.get("DIMOS_AR_LAUNCHER_CONNECTIONS") == "1"
        self._last: str | None = None

    def publish(self, robot: str, status: str, clients: tuple[tuple[str, str], ...]) -> None:
        if not self.enabled:
            return
        rows = [{"kind": "robot", "name": robot, "status": status}]
        rows.extend(
            {"kind": "client", "id": client_id, "name": name, "status": "online"}
            for client_id, name in clients
        )
        message = json.dumps(rows, separators=(",", ":"))
        if message != self._last:
            try:
                print(f"DIMOS_AR_CONNECTIONS {message}", flush=True)
            except BrokenPipeError:
                self.enabled = False
            else:
                self._last = message
