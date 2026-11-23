import { LauncherSession } from "./launcher-session.mjs";
import { sourceRequest, replayPreferenceKey, LaunchConfiguration, HardwareDiscovery } from "./source-selection.mjs?v=launcher-controls-12";
import { logConsole } from "./log-console.mjs";
import { markerMountEditor } from "./marker-mount-editor.mjs";
import { settingsWriter, profilesForRobot, ProfileSettingsEditor, LauncherPreferences } from "./persistence.mjs";
import { launcherPresentation } from "./presentation.mjs?v=launcher-controls-7";
(() => {
  const $ = (id) => document.getElementById(id);


  const stateValue = $("stateValue");
  const stateDetail = $("stateDetail");
  const hostIp = $("hostIp");
  const webxrNetwork = $("webxrNetwork");
  const warningText = $("warningText");
  const errorText = $("errorText");
  const controlsCard = $("controlsCard");
  const actionsBar = $("actionsBar");
  const installBanner = $("installBanner");
  const installHint = $("installHint");
  const dimosVersionHint = $("dimosVersionHint");
  const depsSummary = $("depsSummary");
  const cloneDir = $("cloneDir");
  const dimosPython = $("dimosPython");
  const browseDimosInstall = $("browseDimosInstall");
  let installPathEdited = false;
  let clonePathEdited = false;
  let locationCheck = null;
  let locationTimer;
  let installError = "";
  const cloneDirField = $("cloneDirField");
  const dimosPythonField = $("dimosPythonField");
  const dimosRefField = $("dimosRefField");
  const dimosRef = $("dimosRef");
  const installBtn = $("installBtn");
  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");
  const robotIp = $("robotIp");
  const apiKey = $("apiKey");
  const revealKey = $("revealKey");
  const logEl = $("log");
  const copyLogBtn = $("copyLogBtn");
  const clearLogBtn = $("clearLogBtn");
  const logFilterLevel = $("logFilterLevel");
  const logFilterSource = $("logFilterSource");
  const sidePanel = $("sidePanel");
  const splitter = $("splitter");
  const tagList = $("tagList");
  const addTagBtn = $("addTagBtn");
  const restoreTagsBtn = $("restoreTagsBtn");
  const fiducialEnabled = $("fiducialEnabled");
  const vpsEnabled = $("vpsEnabled");
  const blueprintSelect = $("blueprintSelect");
  const blueprintInfo = $("blueprintInfo");
  const blueprintHelp = $("blueprintHelp");
  const blueprintHelpBtn = $("blueprintHelpBtn");
  const agentConfig = $("agentConfig");
  const locCard = $("locCard");
  const locSummary = $("locSummary");
  const agentSummary = $("agentSummary");
  const logLevel = $("logLevel");
  const fiducialPanel = $("fiducialPanel");
  const vpsPanel = $("vpsPanel");
  const vpsVendor = $("vpsVendor");
  const mapCode = $("mapCode");
  const nativeMapFile = $("nativeMapFile");
  const multisetClientId = $("multisetClientId");
  const multisetClientSecret = $("multisetClientSecret");
  const revealMultiset = $("revealMultiset");

  const { appendLog, clearLog, copyLog, applyLogFilter } = logConsole({ logEl, logFilterLevel, logFilterSource, copyLogBtn });

  const configuration = new LaunchConfiguration({ blueprint: blueprintSelect.value });
  const hardware = new HardwareDiscovery(fetch);
  const preferences = new LauncherPreferences();
  const service = new LauncherSession({
    publishStatus: applyStatus,
    publishConnections: applyConnectionStatus,
    publishLog: line => appendLog(line),
    refreshHardware: () => {
      void refreshPlanner();
      if ($("robotSource").value === "simulated") return;
      void refreshCan();
      if (manipulationSelected() && !document.hidden) {
        void refreshRobotDiscovery({ quiet: true });
      }
    },
    retireRequests: () => {
      editor.cancelScheduled();
      hardware.requests.clear();
      editor.requests.clear();
      preferences.requests.clear();
    },
  });
  let keyVisible = false;
  let multisetVisible = false;


  const savedBlueprint = localStorage.getItem("dimos.blueprint");
  let metadataReady = false;
  const editor = new ProfileSettingsEditor(settingsWriter({
    request: body => fetch("/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    saved: (profileId, data) => editor.saved(profileId, data),
    failed: error => appendLog(`Settings save failed: ${error.message || error}`),
  }));

  const markerEditor = markerMountEditor({
    tagList,
    empty: $("markersEmpty"),
    addTagBtn,
    restoreTagsBtn,
    editor,
    isLocked: configIsLocked,
    changed: () => { syncConfigCards(); schedulePersist(); },
    report: appendLog,
  });

  function applyBlueprintInfo({ refreshProfiles = true } = {}) {
    configuration.selectBlueprint(blueprintSelect.value);
    const spec = configuration.spec;
    if (!spec) return;
    blueprintInfo.textContent = spec.description || "";
    blueprintHelp.classList.toggle("hidden", !spec.description);
    blueprintHelpBtn.setAttribute("aria-expanded", "false");
    const manipulation = spec.manipulation;
    $("nativeMapField").classList.toggle("hidden", manipulation);
    nativeMapFile.disabled = configIsLocked() || manipulation;


    const rememberedSource = preferences.values[`${configuration.replayRobot}_source`] || "auto";
    renderSourceOptions(rememberedSource);
    syncSource();

    if (editor.settingsReady) {
      if (refreshProfiles) void refreshRobotProfiles();
      if (rememberedSource.startsWith("device:")) void refreshRobotDiscovery();
    }
    agentConfig.classList.toggle("hidden", !spec.agent);
    syncConfigCards();
    syncHardwareSetup();
    if (manipulation) void refreshPlanner();
  }

  function renderSourceOptions(selected = $("robotSource").value, missing = "saved") {
    const select = $("robotSource");
    select.querySelector('[value="auto"]').textContent = manipulationSelected()
      ? "Auto (first available CAN interface)" : "Auto (scan on start)";
    select.querySelectorAll('[value^="device:"], [value="manual"]').forEach(option => option.remove());
    const add = (value, label) => {
      const option = document.createElement("option"); option.value = value; option.textContent = label;
      select.insertBefore(option, select.querySelector('[value="simulated"]'));
    };
    if (!manipulationSelected()) add("manual", "Manual IP");
    for (const device of (hardware.discoveredRobots[configuration.replayRobot] || [])) {
      const option = new Option(device.label || device.id, `device:${device.id}`);
      select.append(option);
    }
    if (selected.startsWith("device:") && ![...select.options].some(option => option.value === selected)) add(selected, `${selected.slice(7)} (${missing})`);
    select.value = selected;
  }

  function manipulationSelected() { return configuration.manipulation; }
  function presentation() {
    return launcherPresentation({ status: service.status, manipulation: manipulationSelected(),
      simulated: $("robotSource").value === "simulated", can: hardware.canStatus, planner: hardware.plannerStatus,
      settingUp: Boolean(hardware.requests.busy("canSetup") || service.status.can_setup_running || hardware.canStatus.setting_up) });
  }
  function canRequired() { return presentation().canRequired; }
  function canSetupRequired() {
    return canRequired() && ["down", "unconfigured", "bus_off"].includes(hardware.canStatus.state);
  }
  function syncHardwareSetup() {
    const selected = manipulationSelected();
    const card = $("canCard");
    card.classList.toggle("hidden", !selected);
    const source = $("robotSource").value;
    const manual = !selected && source === "manual";
    const simulated = source === "simulated";
    $("webrtcCard").classList.toggle("hidden", selected || manual);
    $("robotSetupRow").classList.toggle("hidden", simulated || manual);
    $("manualIpField").classList.toggle("hidden", !manual);
    $("webrtcSummary").textContent = simulated ? "Not required" : hardware.go2DiscoveryState.text;
    $("webrtcSummary").dataset.phase = simulated ? "" : hardware.go2DiscoveryState.phase;
    const canReady = hardware.canStatus.state === "ready" && hardware.canStatus.ready;
    const missing = canRequired() && !canReady;
    card.classList.toggle("needs-setup", missing);
    const canPhase = hardware.canStatus.state === "error" ? "error" : canReady ? "ready" : hardware.canStatus.state === "checking" ? "checking" : "needs_setup";
    $("canSummary").textContent = canReady ? "Ready · 1 Mbit/s" : hardware.canStatus.state === "checking" ? "Checking…" : ["error", "not_required"].includes(hardware.canStatus.state) ? "Unavailable" : "Setup needed";
    $("canSummary").dataset.phase = canPhase;
    const settingUp = hardware.requests.busy("canSetup") || service.status.can_setup_running || hardware.canStatus.setting_up;
    const setupRequired = canSetupRequired();
    const refresh = $("refreshRobots");
    const action = setupRequired ? "Set up CAN" : "Refresh robots";
    refresh.textContent = setupRequired ? "Set up CAN" : "↻";
    refresh.classList.toggle("btn-icon", !setupRequired);
    refresh.setAttribute("aria-label", action);
    refresh.title = action;
    $("canSummary").title = hardware.canStatus.message || "";
    if (settingUp) $("canSummary").textContent = "Setting up…";
    renderControls();
  }

  function environmentScope() {
    return JSON.stringify([configuration.selectionRevision, configuration.blueprint, hardware.plannerPython]);
  }
  function canScope() {
    return JSON.stringify([environmentScope(), $("robotSource").value, hardware.resolvedCan]);
  }
  function replayScope() {
    return JSON.stringify([environmentScope(), $("robotSource").value, $("playbackSource").value]);
  }
  function canInterface() {
    const selection = $("robotSource").value;
    return selection.startsWith("device:") ? selection.slice(7) : hardware.resolvedCan;
  }

  function refreshCan() {
    return hardware.refreshCan({
      enabled: manipulationSelected() && $("robotSource").value !== "simulated" && !document.hidden,
      scope: canScope, interface: canInterface(), changed: syncHardwareSetup,
    });
  }
  function refreshPlanner() {
    return hardware.refreshPlanner({
      enabled: manipulationSelected() && !document.hidden,
      scope: environmentScope, changed: syncHardwareSetup,
    });
  }
  function setupCan() {
    return hardware.setupCan({
      enabled: !configIsLocked(), scope: canScope, interface: canInterface(), changed: syncHardwareSetup,
      progress: ({ phase, error }) => {
        if (phase === "error") appendLog(`CAN setup: ${error}`);
      },
    });
  }

  function fiducialConfigured() {
    return editor.mounts.length > 0;
  }

  function vpsConfigured() {
    return Boolean(
      mapCode.value.trim() &&
        multisetClientId.value.trim() &&
        multisetClientSecret.value.trim()
    );
  }

  function locNotSetup() {
    const markerOn = fiducialEnabled.checked;
    const vpsOn = vpsEnabled.checked;
    if (!markerOn && !vpsOn) return true;
    if (markerOn && !fiducialConfigured()) return true;
    if (vpsOn && !vpsConfigured()) return true;
    return false;
  }

  function agentNotSetup() {
    return Boolean(configuration.spec?.agent) && !apiKey.value.trim();
  }

  function syncConfigCards(render = true) {
    const locMissing = locNotSetup();
    locCard.classList.toggle("needs-setup", locMissing);
    locSummary.textContent = locMissing ? "incomplete" : "";
    locSummary.dataset.phase = locMissing ? "needs_setup" : "";

    const agentMissing = agentNotSetup();
    agentConfig.classList.toggle("needs-setup", agentMissing);
    agentSummary.textContent = agentMissing ? "incomplete" : "";
    agentSummary.dataset.phase = agentMissing ? "needs_setup" : "";

    if (render) renderControls();
  }


  function schedulePersist() {
    if (configIsLocked()) return;
    editor.schedule(settingsBody);
  }

  const policyDefaults = {};
  const policyKeys = [...document.querySelectorAll("[data-localization-policy]")].map(input => input.id);
  const policyInputs = Object.fromEntries(policyKeys.map(key => [key, $(key)]));
  Object.values(policyInputs).forEach(input => {
    input.addEventListener("change", () => { if (input.reportValidity()) schedulePersist(); });
    input.addEventListener("blur", () => { if (input.reportValidity()) schedulePersist(); });
  });

  function settingsBody() {
    return {
      profile_id: editor.robotProfileId,
      ...Object.fromEntries(Object.entries(policyInputs).map(([key, input]) => [key, Number(input.value)])),
      openai_api_key: apiKey.value.trim() || null,
      multiset_client_id: multisetClientId.value.trim() || null,
      multiset_client_secret: multisetClientSecret.value.trim() || null,
      fiducial_marker: fiducialEnabled.checked,
      vps: vpsEnabled.checked,
      vps_vendor: vpsVendor.value || "multiset",
      map_code: mapCode.value.trim() || null,
      native_map_file: manipulationSelected() ? null : nativeMapFile.value.trim() || null,
      mounts: editor.mounts,
      dimos_log_level: logLevel.value || configuration.defaultLogLevel,
    };
  }

  function saveSettings() { return editor.save(settingsBody()); }
  async function flushSettings() { return saveSettings(); }

  function applySettingsPayload(data) {
    if (!metadataReady) {
      configuration.selectBlueprint(savedBlueprint || blueprintSelect.value);
      configuration.configure(data.defaults);
      blueprintSelect.replaceChildren(...data.defaults.blueprints.map(spec => {
        const option = document.createElement("option");
        option.value = spec.id;
        option.textContent = spec.label;
        return option;
      }));
      blueprintSelect.value = configuration.blueprint;
      logLevel.replaceChildren(...configuration.logLevels.map(level => {
        const option = document.createElement("option");
        option.value = level;
        option.textContent = level;
        return option;
      }));
      metadataReady = true;
    }
    Object.assign(policyDefaults, data.defaults.localization);
    markerEditor.configure(data.defaults);
    markerEditor.load(data.mounts);
    fiducialEnabled.checked = Boolean(data.fiducial_marker);
    vpsEnabled.checked = Boolean(data.vps);
    vpsVendor.value = data.vps_vendor || "multiset";
    if (document.activeElement !== nativeMapFile) nativeMapFile.value = data.native_map_file || "";
    if (document.activeElement !== mapCode) {
      mapCode.value = data.map_code || "";
    }
    if (document.activeElement !== apiKey && "openai_api_key" in data) {
      apiKey.value = data.openai_api_key || "";
    }
    if (document.activeElement !== logLevel && "dimos_log_level" in data) {
      const level = String(data.dimos_log_level || configuration.defaultLogLevel).toUpperCase();
      logLevel.value = configuration.logLevels.includes(level) ? level : configuration.defaultLogLevel;
    }
    if (document.activeElement !== multisetClientId && "multiset_client_id" in data) {
      multisetClientId.value = data.multiset_client_id || "";
    }
    if (document.activeElement !== multisetClientSecret && "multiset_client_secret" in data) {
      multisetClientSecret.value = data.multiset_client_secret || "";
    }
    Object.entries(policyInputs).forEach(([key, input]) => {
      if (document.activeElement !== input) input.value = String(data[key] ?? policyDefaults[key]);
    });
    editor.settingsReady = true;
    syncLocalizationPanels();
    markerEditor.render();
    applyBlueprintInfo();
  }

  function profileTransitionPending() {
    return editor.requests.busy("load") || editor.requests.busy("switch");
  }

  function configIsLocked() { return presentation().locked || profileTransitionPending(); }

  function setConfigLocked(locked) {
    Object.values(policyInputs).forEach(input => { input.disabled = locked; });
    controlsCard.classList.toggle("locked", locked);
    blueprintSelect.disabled = locked;
    for (const id of ["robotProfileSelect", "robotProfileName", "newRobotProfile", "deleteRobotProfile", "robotSource", "playbackSource", "robotIp", "editReplay", "profileEdit", "profileDone", "saveProfileName", "cancelProfileName", "confirmDeleteProfile"]) { const control = $(id); if (control) control.disabled = locked; }
    $("refreshRobots").disabled = locked || $("robotSource").value === "simulated" ||
      hardware.requests.busy("canSetup") || service.status.can_setup_running ||
      hardware.canStatus.setting_up || hardware.requests.busy("discovery") ||
      service.status.check_ok !== true || ["checking", "installing"].includes(service.status.phase);
    $("replayStreams").querySelectorAll("select").forEach(select => { select.disabled = locked; });
    apiKey.disabled = locked;
    revealKey.disabled = locked;
    fiducialEnabled.disabled = locked;
    vpsEnabled.disabled = locked;
    vpsVendor.disabled = locked;
    mapCode.disabled = locked;
    nativeMapFile.disabled = locked || manipulationSelected();
    multisetClientId.disabled = locked;
    multisetClientSecret.disabled = locked;
    revealMultiset.disabled = locked;
    logLevel.disabled = locked;
    markerEditor.setLocked(locked);
    $("editReplay").disabled = locked;
  }


  function syncLocalizationPanels() {
    fiducialPanel.classList.toggle("hidden", !fiducialEnabled.checked);
    vpsPanel.classList.toggle("hidden", !vpsEnabled.checked);
  }

  function describeState(status, view) {
    const p = status.phase || "idle";
    switch (p) {
      case "checking":
        return { label: "Checking setup", detail: "", phase: "checking" };
      case "installing":
        return { label: "Installing", detail: "", phase: "installing" };
      case "starting":
        return { label: "Starting", detail: `Starting DimOS with ${configuration.blueprint}…`, phase: "starting" };
      case "running":
        return { label: "Running", detail: "", phase: "running" };
      case "stopping":
        return { label: "Stopping", detail: "Stopping the DimOS session…", phase: "stopping" };
      case "error":
        return {
          label: "Error",
          detail: status.error || "ARModule failed — check the log",
          phase: "error",
        };
      default: {
        if (status.check_ok !== true || view.hardwareMissing) {
          return { label: "Setup incomplete", detail: "", phase: "needs_setup" };
        }
        if (status.warning) {
          return { label: "Warning", detail: "", phase: "needs_setup" };
        }
        if (p === "idle" || !editor.settingsReady || !editor.robotProfileId) {
          return { label: "Idle", detail: "", phase: "idle" };
        }
        return { label: "Ready to start", detail: "", phase: "ready" };
      }
    }
  }

  function applyHeader(status, view) {
    const info = describeState(status || {}, view);
    stateValue.textContent = info.label;
    $("statePill").dataset.phase = info.phase;
    stateDetail.textContent = info.detail;
    stateDetail.dataset.phase = info.phase;
    stateDetail.classList.toggle("hidden", !info.detail);
  }

  const actionNotes = {
    checking: "Checking setup",
    installing: "Installing dependencies",
    can_setup: "Setting up CAN",
    preparing: "Preparing launch",
    starting: "Starting DimOS",
    running: "Blueprint running",
    stopping: "Stopping DimOS",
  };
  let actionPhase = "";
  let actionTimer;
  let runningSince = null;

  function formatElapsed(milliseconds) {
    const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function updateActionStatus(phase) {
    const started = phase === "running" ? service.status.running_since_ms ?? null : null;
    if (phase === actionPhase && started === runningSince) return;
    actionPhase = phase;
    runningSince = started;
    window.clearInterval(actionTimer);
    const note = actionNotes[phase];
    $("actionStatus").classList.toggle("hidden", !note);
    $("actionNote").textContent = note || "";
    if (!note) return;

    const initialElapsed = Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
    const actionStarted = performance.now() - initialElapsed;
    const tick = () => {
      $("actionElapsed").textContent = formatElapsed(performance.now() - actionStarted);
    };
    tick();
    actionTimer = window.setInterval(tick, 1000);
  }

  const pendingStops = new Set();

  function renderControls() {
    const view = presentation();
    applyHeader(service.status, view);
    depsSummary.textContent = view.dependencyText;
    depsSummary.dataset.phase = view.dependencyPhase;
    syncInstallBanner(view);
    startBtn.disabled = view.startDisabled || !editor.settingsReady || !editor.robotProfileId ||
      editor.requests.busy("start") || editor.requests.busy("install") ||
      profileTransitionPending() || pendingStops.size > 0;
    stopBtn.disabled = pendingStops.has(service.status.phase === "stopping");
    const phase = service.status.phase;
    const starting = phase === "starting" || editor.requests.busy("start");
    const canSetup = service.status.can_setup_running || hardware.requests.busy("canSetup");
    const installing = phase === "installing" || editor.requests.busy("install");
    const preparing = phase === "checking" || installing || canSetup;
    updateActionStatus(actionNotes[phase] ? phase : starting ? "preparing"
      : installing ? "installing" : canSetup ? "can_setup" : "");
    const stopLabel = phase === "stopping" ? view.stopLabel
      : starting ? "Cancel startup"
      : preparing && !view.locked ? "Cancel setup" : "Stop blueprint";
    stopBtn.setAttribute("aria-label", stopLabel);
    stopBtn.title = stopLabel;
    stopBtn.classList.toggle("danger", view.stopDanger);
    setConfigLocked(view.locked || profileTransitionPending());
  }

  function setupMode() {
    return document.querySelector('input[name="setupMode"]:checked')?.value || "existing";
  }

  function setupLocation() {
    return setupMode() === "clone"
      ? { mode: "clone", clone_dir: cloneDir.value.trim(), dimos_ref: dimosRef.value }
      : { mode: "existing", dimos_python: dimosPython.value.trim() };
  }

  function checkSetupLocation() {
    window.clearTimeout(locationTimer);
    const body = JSON.stringify(setupLocation());
    const request = editor.requests.begin("setupLocation", () => JSON.stringify(setupLocation()));
    const publish = result => { if (request.current()) locationCheck = { body, result }; };
    installError = "";
    publish({ state: "checking", message: "Checking folder…" });
    renderControls();
    locationTimer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/setup/location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (!response.ok) throw new Error(response.statusText);
        publish(await response.json());
      } catch {
        publish({ state: "unknown", message: "Could not check this folder." });
      } finally {
        if (request.current()) renderControls();
        request.finish();
      }
    }, 250);
  }

  function syncInstallBanner(view) {
    const installDisabled = view.installDisabled || editor.requests.busy("install");
    const selectedCheck = locationCheck?.body === JSON.stringify(setupLocation()) ? locationCheck.result : null;
    const ready = view.setupReady;
    const needsInstall = !ready;
    const cloning = setupMode() === "clone";
    const installedPath = service.status.dimos_install_dir || service.status.dimos_python || "";
    const pathChanged = installPathEdited && dimosPython.value.trim() !== installedPath;
    const showInstall = needsInstall || cloning || pathChanged;
    if (selectedCheck && showInstall && !installDisabled) {
      depsSummary.textContent = {
        checking: "Checking folder…",
        invalid: "Folder needs attention",
        download: "Installation needed",
        found: "DimOS found",
        unknown: "Folder unchecked",
      }[selectedCheck.state] || "";
      depsSummary.dataset.phase = selectedCheck.state === "found" ? "ready" : "needs_setup";
    }
    dimosPython.disabled = browseDimosInstall.disabled = cloneDir.disabled = dimosRef.disabled = installDisabled;
    installBanner.querySelectorAll('input[name="setupMode"]').forEach(input => { input.disabled = installDisabled; });

    installHint.textContent = installError || (showInstall && !installDisabled && selectedCheck?.message) || (needsInstall
      ? service.status.check_ok === true
        ? "Install the manipulation planner dependencies to use this blueprint."
        : "A DimOS environment is required to continue."
      : cloning ? "Download DimOS into the folder below." : "");
    installHint.classList.toggle("hidden", !installHint.textContent);
    dimosRefField.classList.toggle("hidden", !cloning);
    installBtn.textContent = cloning ? "Download & install" : needsInstall ? "Install" : "Use folder";
    installBtn.classList.toggle("hidden", !showInstall);
    installBtn.disabled = installDisabled || ["checking", "invalid"].includes(selectedCheck?.state) ||
      !(cloning ? cloneDir.value.trim() : dimosPython.value.trim());
    const needsAttention = needsInstall && !installDisabled && service.status.check_ok != null;
    if (needsAttention && !installBanner.classList.contains("needs-setup")) installBanner.open = true;
    installBanner.classList.toggle("needs-setup", needsAttention);

    const versionBits = [];
    if (service.status.dimos_version) versionBits.push(`DimOS ${service.status.dimos_version}`);
    if (service.status.dimos_ref) versionBits.push(service.status.dimos_ref);
    dimosVersionHint.textContent = versionBits.join(" · ");
    dimosVersionHint.classList.toggle("hidden", versionBits.length === 0);
  }

  let connectionTimer;
  function renderConnections(rows) {
    window.clearInterval(connectionTimer);
    const clocks = [];
    const list = $("connectionList");
    if (list) {
      rows = Array.isArray(rows) ? rows : [];
      list.replaceChildren(...rows.map(({ kind, name, id, status: state, online_since_ms: onlineSince }) => {
        const row = document.createElement("li");
        const dot = document.createElement("span");
        dot.className = `connection-indicator ${state}`;
        dot.setAttribute("aria-hidden", "true");
        const displayName = kind === "client" && /^(spectacles|specs)$/i.test(name || "") ? "SPECS" : name;
        const identity = [displayName || (kind === "client" ? "AR client" : "Robot"), id]
          .filter(Boolean).join(" · ");
        const recording = kind === "robot" && name?.endsWith(" (Recording)");
        const label = { online: recording ? "Playing" : "Connected", offline: "Disconnected", waiting: "Waiting" }[state];
        row.append(dot, `${identity} · ${label}`);
        if (state === "online" && Number.isFinite(onlineSince)) {
          const elapsed = document.createElement("span");
          elapsed.className = "connection-duration mono";
          clocks.push({ elapsed, onlineSince });
          row.append(elapsed);
        }
        return row;
      }));
      $("connectionsEmpty").hidden = rows.length !== 0;
      if (clocks.length) {
        const tick = () => {
          const now = Date.now();
          for (const { elapsed, onlineSince } of clocks) {
            elapsed.textContent = formatElapsed(now - onlineSince);
          }
        };
        tick();
        connectionTimer = window.setInterval(tick, 1000);
      }
    }
  }

  function applyConnectionStatus(status) {
    renderConnections(status.connections);
    const { pin, host_ip: ip, webxr_phase: webxrPhase, webxr_error: webxrError } = status;
    const url = status.webxr_url || status.webxr_local_url;
    const running = status.phase === "running";
    $("ipCard").classList.toggle("hidden", status.phase !== "running" && !pin && !url && !status.connections?.length);
    $("pinRow").classList.toggle("hidden", !pin);
    $("pinSummary").textContent = pin ?? "";
    $("hostIpRow").classList.toggle("hidden", !ip);
    hostIp.textContent = ip ?? "";
    $("webxrNetworkRow").classList.toggle("hidden", !url && !running);
    const startWebxr = $("startWebxr");
    startWebxr.classList.toggle("hidden", !running || Boolean(url) || webxrPhase === "starting");
    if (url || webxrPhase === "starting" || !running) $("webxrStartError").classList.add("hidden");
    webxrNetwork.replaceChildren();
    if (url) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = url;
      webxrNetwork.append(link);
    } else {
      webxrNetwork.textContent = webxrPhase === "starting" ? "Starting…"
        : webxrError ? `Unavailable · ${webxrError}` : "Not running";
    }
  }

  function applyStatus(status) {

    if (!installPathEdited && document.activeElement !== dimosPython && (status.dimos_install_dir || status.dimos_python)) {
      dimosPython.value = status.dimos_install_dir || status.dimos_python;
    }
    const environmentChanged = hardware.observeStatus(status);

    applyConnectionStatus(status);

    if (status.warning) {
      warningText.textContent = status.warning;
      warningText.classList.remove("hidden");
    } else {
      warningText.classList.add("hidden");
    }

    if (status.error && service.status.phase !== "error") {
      errorText.textContent = status.error;
      errorText.classList.remove("hidden");
    } else {
      errorText.classList.add("hidden");
    }

    syncConfigCards(false);

    controlsCard.classList.remove("hidden");
    actionsBar.classList.remove("hidden");

    if (status.default_clone_dir && !clonePathEdited && !cloneDir.value) {
      cloneDir.value = status.default_clone_dir;
      if (setupMode() === "clone") checkSetupLocation();
    }

    syncHardwareSetup();
    if (environmentChanged) { void refreshPlanner(); }

  }

  function syncSetupMode() {
    const existing = setupMode() === "existing";
    cloneDirField.classList.toggle("hidden", existing);
    dimosPythonField.classList.toggle("hidden", !existing);
    renderControls();
  }

  function initSplitter() {
    const app = sidePanel.closest(".app");
    const logPanel = $("logPanel");
    const savedWidth = Number(localStorage.getItem("launcher.logWidth"));
    if (Number.isFinite(savedWidth) && savedWidth >= 220) app.style.setProperty("--log-width", `${savedWidth}px`);

    let dragging = false;
    let dragStart = 0;
    let initialWidth = 0;

    const resize = (width) => {
      const next = Math.min(window.innerWidth - 285, Math.max(220, Math.round(width)));
      app.style.setProperty("--log-width", `${next}px`);
      localStorage.setItem("launcher.logWidth", String(next));
    };

    splitter.addEventListener("pointerdown", (ev) => {
      dragging = true;
      dragStart = ev.clientX;
      initialWidth = logPanel.getBoundingClientRect().width;
      document.body.classList.add("resizing");
      splitter.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });

    splitter.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      resize(initialWidth + dragStart - ev.clientX);
    });

    const endDrag = (ev) => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("resizing");
      try {
        splitter.releasePointerCapture(ev.pointerId);
      } catch (_) {
        /* ignore */
      }
    };

    splitter.addEventListener("pointerup", endDrag);
    splitter.addEventListener("pointercancel", endDrag);

    splitter.addEventListener("keydown", (ev) => {
      const current = logPanel.getBoundingClientRect().width;
      if (ev.key === "ArrowLeft") {
        resize(current + 20);
        ev.preventDefault();
      } else if (ev.key === "ArrowRight") {
        resize(current - 20);
        ev.preventDefault();
      }
    });
  }

  blueprintHelpBtn.addEventListener("click", () => {
    const open = blueprintHelpBtn.getAttribute("aria-expanded") === "true";
    blueprintHelpBtn.setAttribute("aria-expanded", String(!open));
  });
  document.addEventListener("pointerdown", (event) => {
    if (!blueprintHelp.contains(event.target)) blueprintHelpBtn.setAttribute("aria-expanded", "false");
  });
  blueprintHelp.addEventListener("keydown", (event) => {
    if (event.key === "Escape") blueprintHelpBtn.setAttribute("aria-expanded", "false");
  });

  blueprintSelect.addEventListener("change", () => {
    if (configIsLocked()) return;
    const previousRobot = configuration.robot;
    const selected = blueprintSelect.value;
    const robotChanged = configuration.blueprints.get(selected)?.robot !== previousRobot;
    if (robotChanged) void flushSettings();
    configuration.selectBlueprint(selected);
    if (robotChanged) {
      editor.setProfiles([], null, null);
      $("robotProfileSelect").replaceChildren();
    }
    localStorage.setItem("dimos.blueprint", configuration.blueprint);
    applyBlueprintInfo({ refreshProfiles: robotChanged });
  });

  fiducialEnabled.addEventListener("change", () => {
    syncLocalizationPanels();
    syncConfigCards();
    schedulePersist();
  });
  vpsEnabled.addEventListener("change", () => {
    syncLocalizationPanels();
    syncConfigCards();
    schedulePersist();
  });
  [vpsVendor, mapCode, nativeMapFile, multisetClientId, multisetClientSecret, logLevel].forEach((el) => {
    el.addEventListener("change", schedulePersist);
    el.addEventListener("blur", schedulePersist);
  });
  [mapCode, nativeMapFile, multisetClientId, multisetClientSecret].forEach((el) => {
    el.addEventListener("input", syncConfigCards);
  });
  apiKey.addEventListener("input", syncConfigCards);


  document.querySelectorAll('input[name="setupMode"]').forEach((el) => {
    el.addEventListener("change", () => {
      syncSetupMode();
      checkSetupLocation();
    });
  });
  syncSetupMode();
  const toggleLogs = $("toggleLogs");
  toggleLogs.addEventListener("click", () => {
    const open = toggleLogs.getAttribute("aria-expanded") === "false";
    toggleLogs.setAttribute("aria-expanded", String(open));
    toggleLogs.textContent = open ? "Hide logs" : "View logs";
    $("logPanel").classList.toggle("hidden", !open);
    splitter.classList.toggle("hidden", !open);
    toggleLogs.closest(".app").classList.toggle("logs-open", open);
    if (open) $("logPanel").scrollIntoView({ block: "nearest" });
  });
  initSplitter();
  applyBlueprintInfo();
  markerEditor.render();
  window.addEventListener("pageshow", applyBlueprintInfo);

  revealKey.addEventListener("click", () => {
    keyVisible = !keyVisible;
    apiKey.type = keyVisible ? "text" : "password";
    revealKey.textContent = keyVisible ? "Hide" : "Show";
    revealKey.setAttribute("aria-label", keyVisible ? "Hide API key" : "Show API key");
  });
  revealMultiset.addEventListener("click", () => {
    multisetVisible = !multisetVisible;
    multisetClientSecret.type = multisetVisible ? "text" : "password";
    revealMultiset.textContent = multisetVisible ? "Hide" : "Show";
    revealMultiset.setAttribute("aria-label", multisetVisible ? "Hide MultiSet secret" : "Show MultiSet secret");
  });

  copyLogBtn.addEventListener("click", copyLog);
  clearLogBtn.addEventListener("click", clearLog);
  logFilterLevel.addEventListener("change", applyLogFilter);
  logFilterSource.addEventListener("change", applyLogFilter);

  dimosPython.addEventListener("input", () => {
    installPathEdited = true;
    checkSetupLocation();
  });

  cloneDir.addEventListener("input", () => {
    clonePathEdited = true;
    checkSetupLocation();
  });
  dimosRef.addEventListener("change", checkSetupLocation);

  browseDimosInstall.addEventListener("click", async () => {
    if (editor.requests.busy("pythonPicker")) return;
    const request = editor.requests.begin("pythonPicker", () => JSON.stringify([environmentScope(), dimosPython.value]));
    try {
      const res = await fetch("/api/browse-dimos-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dimosPython.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!request.current()) return;
      if (!res.ok) {
        appendLog(`File chooser error: ${data.detail || res.statusText}`);
      } else if (data.path) {
        dimosPython.value = data.path;
        dimosPython.dispatchEvent(new Event("input"));
      }
    } catch (err) {
      if (request.current()) appendLog(`File chooser error: ${err}`);
    } finally {
      request.finish();
    }
  });

  installBtn.addEventListener("click", async () => {
    if (editor.requests.busy("install")) return;
    const body = { ...setupLocation(), manipulation: configuration.manipulation };
    const request = editor.requests.begin("install", () => null);
    installError = "";
    renderControls();
    const revision = service.revision;
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : res.statusText);
      service.applyResponse(data, revision);
      if (request.current()) checkSetupLocation();
      void refreshCan(); void refreshPlanner();
    } catch (err) {
      if (request.current()) {
        installError = `Setup error: ${err.message || err}`;
        appendLog(installError);
      }
    } finally {
      request.finish();
      renderControls();
    }
  });

  apiKey.addEventListener("change", schedulePersist);

  function showActionError(message) {
    const startError = $("startError");
    startError.textContent = message;
    startError.classList.toggle("hidden", !message);
  }

  startBtn.addEventListener("click", async () => {
    showActionError("");
    startBtn.disabled = true;
    const selection = () => JSON.stringify([environmentScope(), editor.robotProfileId,
      $("robotSource").value, robotIp.value, $("playbackSource").value,
      preferences.replayStreams[configuration.replayRobot]]);
    const request = editor.requests.begin("start", selection);
    renderControls();
    const saved = await saveSettings();
    if (!request.current()) { request.finish(); renderControls(); return; }
    if (!saved) {
      showActionError("Could not save the launch settings. Try again or view logs for details.");
      request.finish();
      renderControls();
      return;
    }
    await saveLauncherPreferences().catch(reportPreferencesError);
    if (!request.current()) { request.finish(); renderControls(); return; }
    const body = {
      blueprint: configuration.blueprint,
      profile_id: editor.robotProfileId,
      source: sourceRequest({ selection: $("robotSource").value, address: robotIp.value,
        replay: $("playbackSource").value, playback: "recording",
        streams: preferences.replayStreams[configuration.replayRobot] || {} }),
    };
    const revision = service.revision;
    try {
      const res = await fetch("/api/armodule/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && request.current()) {
        const detail = data.detail;
        if (Array.isArray(detail?.devices)) {
          hardware.discoveredRobots[configuration.replayRobot] = detail.devices;
          renderSourceOptions();
        }
        const message = detail?.message || (typeof detail === "string" ? detail : res.statusText) || "Could not start ARModule.";
        showActionError(message);
        appendLog(`Start error: ${message}`);
      }
      service.applyResponse(data, revision);
    } catch (err) {
      if (request.current()) {
        showActionError(String(err));
        appendLog(`Start error: ${err}`);
      }
    } finally {
      request.finish();
      renderControls();
    }
  });

  $("startWebxr").addEventListener("click", async () => {
    const button = $("startWebxr");
    const error = $("webxrStartError");
    button.disabled = true;
    error.classList.add("hidden");
    const revision = service.revision;
    try {
      const response = await fetch("/api/webxr/start", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : response.statusText);
      service.applyResponse(data, revision);
    } catch (failure) {
      if (service.status.phase === "running" && !service.status.webxr_url && !service.status.webxr_error) {
        error.textContent = failure.message;
        error.classList.remove("hidden");
      }
    } finally {
      button.disabled = false;
    }
  });

  stopBtn.addEventListener("click", async () => {
    const force = service.status.phase === "stopping";
    if (pendingStops.has(force)) return;
    editor.requests.cancel("start");
    showActionError("");
    pendingStops.add(force);
    renderControls();
    const revision = service.revision;
    try {
      const res = await fetch(`/api/armodule/stop?force=${force}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : res.statusText);
      service.applyResponse(data, revision);
    } catch (err) {
      const message = `Stop error: ${err.message || err}`;
      showActionError(message);
      appendLog(message);
    } finally {
      pendingStops.delete(force);
      renderControls();
    }
  });

  async function loadConfig() {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("Could not load launcher settings");
      applySettingsPayload(await res.json());
      applyRobotProfile();
      void loadLauncherPreferences();
    } catch (error) {
      appendLog(`Settings load failed: ${error}`);
    }
  }

  async function loadDimosRefs() {
    const request = editor.requests.begin("refs", () => dimosRef.value);
    try {
      const res = await fetch("/api/dimos-refs");
      if (!res.ok) return;
      const data = await res.json();
      if (!request.current()) return;
      const refs = data.refs;
      const selected = dimosRef.value;
      const pinned = document.createElement("option");
      pinned.value = "";
      pinned.textContent = `Project revision (${data.default.slice(0, 8)})`;
      dimosRef.replaceChildren(
        pinned,
        ...refs.map((ref) => {
          const option = document.createElement("option");
          option.value = ref;
          option.textContent = ref;
          return option;
        })
      );
      dimosRef.value = refs.includes(selected) ? selected : "";
    } catch (_) {
      // Ref suggestions are optional; the selected value remains usable offline.
    } finally { request.finish(); }
  }

  loadConfig();
  loadDimosRefs();
  service.start();
  window.addEventListener("pagehide", () => service.stop());
  window.addEventListener("pageshow", event => { if (event.persisted) service.start(); });

  async function refreshRobotProfiles(preferredId = editor.robotProfileId) {
    const robot = configuration.robot;
    if (!robot) return;
    const request = editor.requests.begin("load", () => configuration.selectionRevision);
    renderControls();
    try {
      const profiles = await profilesForRobot(fetch, robot, !presentation().locked, request.current);
      if (!request.current()) return;
      const previousId = editor.robotProfileId;
      const remembered = localStorage.getItem(`dimos.profile.${robot}`);
      editor.setProfiles(profiles, preferredId, remembered);
      const select = $("robotProfileSelect");
      select.replaceChildren(...profiles.map(profile => new Option(profile.name, profile.id)));
      const selected = profiles.find(profile => profile.id === editor.robotProfileId);
      if (!selected) return;
      localStorage.setItem(`dimos.profile.${robot}`, selected.id);
      select.value = selected.id;
      if (selected.id === previousId) $("robotProfileName").value = selected.name;
      else applyRobotProfile();
    } catch (error) {
      if (request.current()) appendLog(error.message);
    } finally {
      request.finish();
      renderControls();
    }
  }
  function applyRobotProfile() {
    const profile = editor.robotProfiles.find(p => p.id === editor.robotProfileId);
    if (!profile) return;
    $("robotProfileName").value = profile.name;
    const settings = profile.settings;
    fiducialEnabled.checked = settings.fiducial_marker;
    vpsEnabled.checked = settings.vps;
    mapCode.value = settings.map_code || "";
    nativeMapFile.value = settings.native_map_file || "";
    markerEditor.load(settings.mounts);
    Object.entries(policyInputs).forEach(([key, input]) => {
      input.value = String(settings[key] ?? policyDefaults[key]);
    });
    syncLocalizationPanels(); markerEditor.render(); syncConfigCards();
  }
  $("robotProfileSelect").addEventListener("change", async () => {
    if (configIsLocked()) return;
    const select = $("robotProfileSelect");
    const request = editor.requests.begin("switch", () => JSON.stringify([configuration.selectionRevision, select.value]));
    renderControls();
    try {
      const saved = await flushSettings();
      if (!request.current()) return;
      if (editor.robotProfileId && !saved) {
        select.value = editor.robotProfileId;
        showActionError("Could not save the current robot config. Try again or view logs for details.");
        return;
      }
      editor.robotProfileId = select.value;
      localStorage.setItem(`dimos.profile.${configuration.robot}`, editor.robotProfileId);
      applyRobotProfile();
    } finally {
      request.finish();
      renderControls();
    }
  });
  function syncSource() {
    const simulated = $("robotSource").value === "simulated";

    const replayRow = $("replayRow");
    const wasHidden = replayRow.classList.contains("hidden");
    replayRow.classList.toggle("hidden", !simulated);
    const robot = configuration.replayRobot;
    const recordingsChanged = robot !== preferences.playbackRobot;
    if (recordingsChanged) {
      preferences.playbackRobot = robot;
      renderRecordingOptions();
      $("replayStreams").replaceChildren();
      $("replayStatus").textContent = "";
    }
    if (simulated && (wasHidden || recordingsChanged) && $("playbackSource").value) void inspectReplay();
    syncHardwareSetup();
    if (manipulationSelected() && !simulated) {
      if ($("robotSource").value === "auto" && service.status.check_ok === true) {
        void refreshRobotDiscovery({ quiet: true });
      } else {
        void refreshCan();
      }
    }
  }
  robotIp.addEventListener("change", () => { void saveLauncherPreferences().catch(reportPreferencesError); });
  $("robotSource").addEventListener("change", () => {
    preferences.values[`${configuration.replayRobot}_source`] = $("robotSource").value;
    syncSource();
    if ($("robotSource").value === "manual" && !robotIp.value.trim()) robotIp.focus();
    void saveLauncherPreferences().catch(reportPreferencesError);
  });
  function refreshRobotDiscovery({ quiet = false } = {}) {
    return hardware.discover({
      enabled: !presentation().locked && !["manual", "simulated"].includes($("robotSource").value) && !hardware.requests.busy("canSetup")
        && (!quiet || service.status.check_ok === true) && !!configuration.robot,
      robot: configuration.robot,
      auto: () => $("robotSource").value === "auto",
      scope: () => JSON.stringify([environmentScope(), ["manual", "simulated"].includes($("robotSource").value)]),
      changed: syncHardwareSetup,
      received: () => {
        if (configuration.manipulation) void refreshCan();
        renderSourceOptions($("robotSource").value, "unavailable");
      },
    });
  }
  $("refreshRobots").addEventListener("click", () => {
    if (canSetupRequired()) void setupCan();
    else void refreshRobotDiscovery();
  });
  function renderRecordingOptions() {
    const robot = configuration.replayRobot;
    const selected = preferences.values[replayPreferenceKey(robot)] || "";
    const paths = new Set([...(preferences.recordings[robot] || []), selected].filter(Boolean));
    const select = $("playbackSource");
    select.replaceChildren(new Option("Default recording", ""), ...Array.from(paths, path => {
      const option = new Option(path.split(/[\\/]/).at(-1) || path, path);
      option.title = path;
      return option;
    }));
    select.value = selected;
  }

  function chooseRecording(path) {
    const robot = configuration.replayRobot;
    if (path === (preferences.values[replayPreferenceKey(robot)] || "")) return;
    preferences.requests.cancel("inspect");
    preferences.replayStreams[robot] = {};
    preferences.values[replayPreferenceKey(robot)] = path;
    $("replayStreams").replaceChildren();
    $("replayStatus").textContent = "";
    renderRecordingOptions();
    syncSource();
    void saveLauncherPreferences().catch(reportPreferencesError);
    if (path) void inspectReplay();
  }

  $("playbackSource").addEventListener("change", () => chooseRecording($("playbackSource").value));
  async function inspectReplay() {
    const request = preferences.requests.begin("inspect", replayScope);
    const path = $("playbackSource").value;
    if (!path) {
      request.finish();
      return;
    }
    const robot = configuration.replayRobot;
    $("replayStatus").textContent = "Checking recording…";
    try {
      const response = await fetch("/api/replay/inspect", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({path, robot: robot === "go2" ? "unitree_go2" : robot, streams: preferences.replayStreams[robot] || {}})});
      const data = await response.json();
      if (!request.current()) return;
      if (!response.ok) throw new Error(data.detail || "Invalid recording");
      preferences.replayStreams[robot] = data.streams;
      $("replayStreams").replaceChildren();
      for (const [role, choices] of Object.entries(data.candidates)) {
        if (choices.length < 2) continue;
        const label = document.createElement("label"); label.className = "field"; label.textContent = `${role} stream`;
        const select = document.createElement("select"); select.setAttribute("aria-label", `${role} stream`);
        select.disabled = configIsLocked();
        const empty = document.createElement("option"); empty.value = ""; empty.textContent = "Choose stream"; select.append(empty);
        for (const name of choices) { const option = document.createElement("option"); option.value = name; option.textContent = name; select.append(option); }
        select.value = data.streams[role] || "";
        select.addEventListener("change", () => { if (select.value) preferences.replayStreams[robot][role] = select.value; else delete preferences.replayStreams[robot][role]; void inspectReplay(); });
        label.append(select); $("replayStreams").append(label);
      }
      $("replayStatus").textContent = data.needs_selection ? "Choose streams before starting." : "Recording ready · read-only · 1×";
      void saveLauncherPreferences().catch(reportPreferencesError);
    } catch (error) {
      if (request.current()) $("replayStatus").textContent = String(error);
    } finally { request.finish(); }
  }
  $("editReplay").addEventListener("click", async () => {
    if (configIsLocked()) return;
    const request = preferences.requests.begin("browse", replayScope);
    try {
      const response = await fetch("/api/browse-replay", { method: "POST" });
      const data = await response.json();
      if (!request.current()) return;
      if (!response.ok) throw new Error(data.detail || "Could not select recording");
      if (data.path) {
        const robot = configuration.replayRobot;
        const paths = preferences.recordings[robot] ??= [];
        if (!paths.includes(data.path)) paths.push(data.path);
        chooseRecording(data.path);
      }
    } catch (error) {
      if (request.current()) $("replayStatus").textContent = String(error);
    } finally { request.finish(); }
  });
  async function loadLauncherPreferences() {
    try {
      const response = await fetch("/api/launcher-preferences");
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Could not load saved preferences");
      if (presentation().locked || !preferences.hydrate(data)) return;
      if (typeof data.manual_ip === "string") robotIp.value = data.manual_ip;
      const value = preferences.values[`${configuration.replayRobot}_source`] || "auto";
      renderSourceOptions(value);
      syncSource();
      if (value.startsWith("device:")) void refreshRobotDiscovery();
    } catch (error) {
      if (!preferences.edited) appendLog(`Could not load launcher preferences: ${error}`);
    }
  }
  function reportPreferencesError(error) { appendLog(`Could not save launcher preferences: ${error}`); }
  function saveLauncherPreferences() {
    preferences.values[`${configuration.replayRobot}_source`] = $("robotSource").value;
    return preferences.save(body => fetch("/api/launcher-preferences", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body,
    }), robotIp.value.trim());
  }
  $("profileEdit").addEventListener("click", () => {
    if (configIsLocked()) return;
    const editor = $("profileEditor");
    editor.classList.toggle("hidden");
    $("profileEdit").setAttribute("aria-expanded", String(!editor.classList.contains("hidden")));
    if (!editor.classList.contains("hidden")) $("robotProfileName").focus();
  });
  const closeProfileEditor = () => { $("robotProfileName").value = editor.robotProfiles.find(profile => profile.id === editor.robotProfileId)?.name || ""; $("deleteProfileConfirm").classList.add("hidden"); $("profileEditor").classList.add("hidden"); $("profileEdit").setAttribute("aria-expanded", "false"); };
  $("profileDone").addEventListener("click", closeProfileEditor);
  document.addEventListener("click", event => {
    if (!$("profileEditor").contains(event.target) && !$("profileEdit").contains(event.target)) closeProfileEditor();
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeProfileEditor(); });
  $("cancelProfileName").addEventListener("click", closeProfileEditor);
  $("robotProfileName").addEventListener("keydown", event => { if (event.key === "Enter") $("saveProfileName").click(); });
  function profileScope() {
    return JSON.stringify([configuration.blueprint, editor.robotProfileId]);
  }
  $("saveProfileName").addEventListener("click", async () => {
    if (configIsLocked() || !editor.robotProfileId || editor.requests.busy("rename")) return;
    const id = editor.robotProfileId;
    const request = editor.requests.begin("rename", profileScope);
    try {
      const response = await fetch(`/api/robot-profiles/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: $("robotProfileName").value }),
      });
      if (!request.current()) return;
      if (!response.ok) throw new Error("Could not save profile name. Use 1–80 characters.");
      $("profileError").classList.add("hidden");
      await refreshRobotProfiles();
      if (request.current()) closeProfileEditor();
    } catch (error) {
      if (!request.current()) return;
      $("profileError").textContent = String(error);
      $("profileError").classList.remove("hidden");
    } finally { request.finish(); }
  });
  async function createRobotProfile() {
    if (configIsLocked() || editor.requests.busy("create")) return;
    const robot = configuration.robot;
    const request = editor.requests.begin("create", environmentScope);
    try {
      const saved = await saveSettings();
      if (!request.current() || !saved) return;
      const response = await fetch("/api/robot-profiles", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ robot, source_id: null }),
      });
      const created = await response.json();
      if (!request.current()) return;
      if (!response.ok) throw new Error("Profile creation failed");
      await refreshRobotProfiles(created.id);
    } catch (error) {
      if (request.current()) appendLog(String(error));
    } finally { request.finish(); }
  }
  $("newRobotProfile").addEventListener("click", createRobotProfile);
  $("deleteRobotProfile").addEventListener("click", () => $("deleteProfileConfirm").classList.remove("hidden"));
  $("confirmDeleteProfile").addEventListener("click", async () => {
    if (configIsLocked() || !editor.robotProfileId || editor.requests.busy("delete")) return;
    const id = editor.robotProfileId;
    const request = editor.requests.begin("delete", profileScope);
    try {
      const response = await fetch(`/api/robot-profiles/${id}`, { method: "DELETE" });
      if (!request.current()) return;
      if (!response.ok) throw new Error("Profile deletion failed");
      $("deleteProfileConfirm").classList.add("hidden");
      await refreshRobotProfiles(null);
    } catch (error) {
      if (request.current()) appendLog(String(error));
    } finally { request.finish(); }
  });
})();
