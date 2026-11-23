from __future__ import annotations

import json

import pytest

from dimos.ar.websocket.launcher_connections import LauncherConnections


def test_launcher_publishes_connection_changes_only(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("DIMOS_AR_LAUNCHER_CONNECTIONS", "1")
    publisher = LauncherConnections()
    publisher.publish("Go2", "waiting", ())
    publisher.publish("Go2", "online", ("client",))
    publisher.publish("Go2", "online", ("client",))
    publisher.publish("Go2", "online", ())
    rows = [
        json.loads(line.removeprefix("DIMOS_AR_CONNECTIONS "))
        for line in capsys.readouterr().out.splitlines()
    ]
    assert rows == [
        [{"kind": "robot", "name": "Go2", "status": "waiting"}],
        [
            {"kind": "robot", "name": "Go2", "status": "online"},
            {"kind": "client", "id": "client", "status": "online"},
        ],
        [{"kind": "robot", "name": "Go2", "status": "online"}],
    ]


def test_cli_run_does_not_publish_launcher_records(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("DIMOS_AR_LAUNCHER_CONNECTIONS", raising=False)
    LauncherConnections().publish("Go2", "online", ())
    assert capsys.readouterr().out == ""
