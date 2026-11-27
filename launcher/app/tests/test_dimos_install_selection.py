"""Selecting a visible checkout folder must retain its virtual environment."""

from unittest.mock import AsyncMock

import pytest

import app as launcher_app
import dimos_installation


def test_checkout_with_spaces_preserves_venv_symlink(tmp_path, monkeypatch):
    checkout = tmp_path / "my dimOS install"
    bin_dir = checkout / ".venv" / "bin"
    bin_dir.mkdir(parents=True)
    shared_python = tmp_path / "shared-python"
    shared_python.write_text("#!/bin/sh\nexit 0\n")
    shared_python.chmod(0o755)
    interpreter = bin_dir / "python3"
    interpreter.symlink_to(shared_python)
    calls = []
    monkeypatch.setattr(dimos_installation.subprocess, "run", lambda args, **kwargs: calls.append(args))

    assert dimos_installation.resolve_dimos_python(str(checkout)) == str(interpreter)
    assert calls[0][0] == str(interpreter)
    assert dimos_installation.resolve_dimos_python(str(checkout / ".venv")) == str(interpreter)


def test_checkout_without_environment_explains_folder_requirement(tmp_path):
    with pytest.raises(ValueError, match="dimOS install folder"):
        dimos_installation.resolve_dimos_python(str(tmp_path))


@pytest.mark.asyncio
async def test_setup_resolves_folder_before_installing(app_context, monkeypatch):
    interpreter = "/selected/dimos/.venv/bin/python3"
    monkeypatch.setattr(launcher_app, "resolve_dimos_python", lambda path: interpreter)
    setup = AsyncMock()
    monkeypatch.setattr(app_context.manager, "run_setup", setup)
    await launcher_app.api_setup(
        launcher_app.SetupBody(mode="existing", dimos_python="/selected/dimos", manipulation=True)
    , context=app_context)
    setup.assert_awaited_once_with(dimos_python=interpreter, manipulation=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("override", [None, "main"])
async def test_clone_setup_only_passes_an_explicit_ref(app_context, monkeypatch, override):
    setup = AsyncMock()
    monkeypatch.setattr(app_context.manager, "run_setup", setup)
    await launcher_app.api_setup(
        launcher_app.SetupBody(mode="clone", clone_dir="/chosen/checkout", dimos_ref=override)
    , context=app_context)
    setup.assert_awaited_once_with(clone_dir="/chosen/checkout", dimos_ref=override, manipulation=False)


@pytest.mark.asyncio
async def test_successful_setup_remembers_selected_environment(tmp_path, monkeypatch):
    from armodule import ProcessManager
    from config import env_path, read_env

    manager = ProcessManager(root=tmp_path)
    monkeypatch.setattr(manager, "_running_dimos_pids", AsyncMock(return_value=[]))
    monkeypatch.setattr(manager.dependencies, "_run_tracked", AsyncMock(return_value=0))
    check = AsyncMock()
    monkeypatch.setattr(manager.dependencies, "_check_dependencies", check)
    interpreter = str(tmp_path / "chosen" / ".venv" / "bin" / "python3")
    await manager.run_setup(dimos_python=interpreter)
    assert read_env(env_path(tmp_path))["DIMOS_PYTHON"] == interpreter
    check.assert_awaited_once()


@pytest.mark.parametrize("existing", [False, True])
def test_source_setup_installs_dimos_and_ar_in_one_transaction(tmp_path, existing):
    import os
    import shutil
    import subprocess
    import sys
    from pathlib import Path

    scripts = tmp_path / "launcher" / "scripts"
    scripts.mkdir(parents=True)
    (tmp_path / "dimos-ar").mkdir()
    (tmp_path / ".dimos-revision").write_text("tested-main-commit\n")
    source = tmp_path / "chosen dimOS"
    (source / ".git").mkdir(parents=True)
    (source / "pyproject.toml").write_text('[project]\nname="dimos"\n')
    interpreter = source / ".venv" / "bin" / "python3"
    interpreter.parent.mkdir(parents=True)
    interpreter.write_text('#!/bin/bash\nif [[ "${2:-}" == "--source" ]]; then printf "%s\n" "${DIMOS_TEST_SOURCE}"; fi\n')
    interpreter.chmod(0o755)
    original = Path(__file__).resolve().parents[2] / "scripts"
    command = scripts / "setup.sh"
    shutil.copyfile(original / "setup.sh", command)
    app_dir = scripts.parent / "app"
    app_dir.mkdir()
    shutil.copyfile(original / "../app/dimos_installation.py", app_dir / "dimos_installation.py")
    # No clone, environment mutation or package install is allowed in this shell test.
    (scripts / "dimos_lib.sh").write_text(
        'print_color() { :; }\n'
        'python_has_dimos() { return 0; }\n'
        'python_has_dimos_ar() { return 0; }\n'
        'python_pip_install() { printf "%s\\0" "$@" >> "${INSTALL_LOG}"; }\n'
    )
    tools = tmp_path / "bin"
    tools.mkdir()
    git = tools / "git"
    git.write_text(
        '#!/bin/sh\nprintf "%s\\n" "$@" >> "$DIMOS_GIT_LOG"\n'
        'case "$3" in\n'
        'show-ref) exit 1 ;;\n'
        'rev-parse) printf "%s\\n" "resolved-commit" ;;\n'
        'esac\n'
    )
    git.chmod(0o755)
    wrong_python = tools / "python3.13"
    wrong_python.write_text('#!/bin/sh\ntouch "$DIMOS_WRONG_PYTHON"\nexit 0\n')
    wrong_python.chmod(0o755)
    bootstrap = tools / "python3.12"
    bootstrap.symlink_to(sys.executable)
    log = tmp_path / "install.args"
    arguments = ["--dimos-python", str(interpreter)] if existing else ["--clone-dir", str(source)]
    subprocess.run(["/bin/bash", str(command), "--yes", "--manipulation", *arguments],
                   env={**os.environ, "PATH": str(tools) + os.pathsep + os.defpath,
                        "DIMOS_TEST_SOURCE": str(source), "INSTALL_LOG": str(log),
                        "DIMOS_GIT_LOG": str(tmp_path / "git.log"),
                        "DIMOS_WRONG_PYTHON": str(tmp_path / "wrong-python")},
                   capture_output=True, text=True, check=True, timeout=10)
    assert not (tmp_path / "wrong-python").exists()
    if not existing:
        traced_git = (tmp_path / "git.log").read_text().splitlines()
        assert "tested-main-commit^{commit}" in traced_git
        assert traced_git[-1] == "resolved-commit"
    assert log.read_bytes().decode().split("\0") == [str(interpreter), "-e", ".[dev,manipulation]", "-e", str(source) + "[planning]", ""]


@pytest.mark.asyncio
@pytest.mark.parametrize("platform,directory", [("darwin", True), ("linux", False)])
async def test_native_chooser_preserves_selection_and_cancellation(tmp_path, monkeypatch, platform, directory):
    from unittest.mock import AsyncMock

    monkeypatch.setattr(launcher_app.sys, "platform", platform)
    monkeypatch.setattr(launcher_app, "_has_display", lambda: True)
    monkeypatch.setattr(launcher_app.shutil, "which", lambda _: "/bin/zenity")
    proc = AsyncMock(returncode=0)
    proc.communicate.return_value = (b"/chosen path\n", b"")
    spawn = AsyncMock(return_value=proc)
    monkeypatch.setattr(launcher_app.asyncio, "create_subprocess_exec", spawn)
    assert await launcher_app._choose_path("Choose", directory=tmp_path if directory else None,
                                          file_filter=None if directory else "Replay | *.db", folders=directory) == "/chosen path"
    args = spawn.call_args.args
    assert "choose folder" in args[-1] if platform == "darwin" else "--file-filter=Replay | *.db" in args
    if platform == "darwin":
        assert f'default location (POSIX file "{tmp_path}")' in args[-1]
    proc.returncode = 1
    assert await launcher_app._choose_path("Choose") is None


@pytest.mark.parametrize(
    ("mode", "selection", "expected"),
    [
        ("existing", "empty", "invalid"),
        ("clone", "", "invalid"),
        ("clone", "empty", "download"),
        ("clone", "missing", "download"),
        ("clone", "occupied", "invalid"),
    ],
)
@pytest.mark.asyncio
async def test_setup_location_distinguishes_installs_and_download_targets(
    tmp_path, mode, selection, expected
):
    (tmp_path / "empty").mkdir()
    (tmp_path / "occupied").mkdir()
    (tmp_path / "occupied" / "unrelated.txt").touch()
    folder = str(tmp_path / selection) if selection else ""
    result = await launcher_app.api_setup_location(
        launcher_app.SetupBody(mode=mode, dimos_python=folder, clone_dir=folder)
    )
    assert result["state"] == expected


def test_relative_interpreter_uses_selected_file_not_path(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    interpreter = tmp_path / "python"
    interpreter.touch(mode=0o700)
    calls = []
    monkeypatch.setattr(dimos_installation.subprocess, "run", lambda args, **kwargs: calls.append(args))
    assert dimos_installation.resolve_dimos_python("python") == str(interpreter)
    assert calls[0][0] == str(interpreter)
    assert "(3, 12)" in calls[0][2]


def test_clone_location_rejects_checkout_of_another_project(tmp_path):
    (tmp_path / ".git").mkdir()
    (tmp_path / "pyproject.toml").write_text('[project]\nname="another-project"\n')
    assert dimos_installation.check_setup_location("clone", str(tmp_path))["state"] == "invalid"


@pytest.mark.asyncio
async def test_ref_listing_timeout_is_reported_as_gateway_timeout(app_context, monkeypatch):
    from fastapi import HTTPException

    command = AsyncMock(side_effect=TimeoutError)
    monkeypatch.setattr(launcher_app, "capture_command", command)
    with pytest.raises(HTTPException) as error:
        await launcher_app.api_dimos_refs(context=app_context)
    assert error.value.status_code == 504
    assert command.call_args.kwargs["timeout"] == 15
