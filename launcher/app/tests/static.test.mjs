import test from "node:test";
import assert from "node:assert/strict";
import { settingsWriter, profilesForRobot } from "../static/persistence.mjs";
import { launcherPresentation } from "../static/presentation.mjs";
import { sourceRequest } from "../static/source-selection.mjs";

const response = data => ({ ok: true, json: async () => data });

test("settings saves retain profile/value identity, serialize and recover from failure", async () => {
  const pending = [], saved = [], failed = [];
  const writer = settingsWriter({ request: values => new Promise(resolve => pending.push({ values, resolve })),
    saved: (id, data) => saved.push([id, data]), failed: error => failed.push(error) });
  const edit = { profile_id: "A", mounts: [{ marker_id: 0 }], marker_preference_s: 0 };
  const first = writer.save(edit);
  edit.profile_id = "B"; edit.mounts[0].marker_id = 9;
  const second = writer.save({ ...edit, marker_preference_s: 1.5 });
  await new Promise(setImmediate);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].values, { profile_id: "A", mounts: [{ marker_id: 0 }], marker_preference_s: 0 });
  pending[0].resolve(response({ marker_preference_s: 0 }));
  await first;
  await new Promise(setImmediate);
  assert.equal(pending.length, 2);
  assert.equal(pending[1].values.profile_id, "B");
  pending[1].resolve({ ok: false, statusText: "Failed", json: async () => ({ detail: "disk full" }) });
  assert.equal(await second, null);
  assert.equal(failed.length, 1);
  const third = writer.save({ profile_id: "B", marker_preference_s: 1.5 });
  await new Promise(setImmediate);
  pending[2].resolve(response({ marker_preference_s: 1.5 }));
  await writer.flush();
  assert.deepEqual(saved, [["A", { marker_preference_s: 0 }], ["B", { marker_preference_s: 1.5 }]]);
  assert.equal(await third, await writer.flush());
});

for (const status of [409, 500]) test(`profile creation failure ${status} is bounded`, async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push(options?.method || "GET");
    return options ? { ok: false, status } : response({ profiles: [] });
  };
  await assert.rejects(profilesForRobot(request, "openyam", true), /Could not create/);
  assert.deepEqual(calls, ["GET", "POST"]);
});

test("locked profile loads never create, and successful creation refreshes once", async () => {
  let count = 0;
  const request = async () => {
    count++;
    return response({ profiles: count < 3 ? [] : [{ id: "arm", robot: "openyam" }] });
  };
  assert.deepEqual(await profilesForRobot(request, "openyam", false), []);
  count = 0;
  assert.deepEqual(await profilesForRobot(request, "openyam", true), [{ id: "arm", robot: "openyam" }]);
  assert.equal(count, 3);
});

for (const phase of ["checking", "installing", "starting", "running", "stopping", "ready"]) {
  test(`derived controls for ${phase} preserve hardware gating and service independence`, () => {
    const facts = { status: { phase, check_ok: true }, manipulation: true, simulated: false,
      can: { ready: false }, planner: { ready: true }, settingUp: false };
    const physical = launcherPresentation(facts);
    assert.equal(physical.startDisabled, true);
    const simulated = launcherPresentation({ ...facts, simulated: true });
    assert.equal(simulated.startDisabled, phase !== "ready");
    assert.equal(simulated.locked, ["starting", "running", "stopping"].includes(phase));
    assert.equal(launcherPresentation({ ...facts, manipulation: false }).startDisabled, phase !== "ready");
  });
}

test("pending CAN setup blocks Start without marking DimOS installation incomplete", () => {
  const view = launcherPresentation({
    status: { phase: "ready", check_ok: true }, manipulation: true, simulated: false,
    can: { state: "needs_setup", ready: false }, planner: { ready: true }, settingUp: false,
  });
  assert.equal(view.setupReady, true);
  assert.equal(view.dependencyText, "");
  assert.equal(view.dependencyPhase, "");
  assert.equal(view.startDisabled, true);
});

test("DimOS install badge stays clear while the planner is pending", () => {
  const view = launcherPresentation({
    status: { phase: "ready", check_ok: true }, manipulation: true, simulated: true,
    can: { ready: true }, planner: { ready: false }, settingUp: false,
  });
  assert.equal(view.dependencyText, "");
  assert.equal(view.dependencyPhase, "");
  assert.equal(view.startDisabled, true);
});

test("source request preserves explicit device and replay selection", () => {
  const value = sourceRequest({ selection: "device:can1", address: " 10.0.0.1 ", replay: " /record.db ",
    playback: "recording", streams: { camera: "front" } });
  assert.deepEqual(value, { mode: "device", device_id: "can1", address: "10.0.0.1", replay: "/record.db",
    playback: "recording", streams: { camera: "front" } });
});

test("request scopes retire stale successes and failures without retiring a newer request", async () => {
  const { ScopedRequests } = await import("../static/source-selection.mjs");
  const requests = new ScopedRequests();
  let selection = "first";
  const first = requests.begin("replay", () => selection);
  assert.equal(requests.busy("replay"), true);
  selection = "second";
  assert.equal(first.current(), false);
  assert.equal(requests.busy("replay"), false);
  const second = requests.begin("replay", () => selection);
  first.finish();
  assert.equal(second.current(), true);
  requests.cancel("replay");
  assert.equal(second.current(), false);
});

test("configuration consumes service metadata without blueprint-specific policy", async () => {
  const { LaunchConfiguration } = await import("../static/source-selection.mjs");
  const selection = new LaunchConfiguration({ blueprint: "custom-arm" });
  selection.configure({ blueprints: [
    { id: "custom-arm", robot: "openyam", manipulation: true, agent: false },
    { id: "custom-dog", robot: "unitree_go2", manipulation: false, agent: true },
  ], log_levels: ["ERROR"], log_level: "ERROR" });
  assert.equal(selection.manipulation, true);
  assert.equal(selection.replayRobot, "openyam");
  selection.selectBlueprint("custom-dog");
  assert.equal(selection.manipulation, false);
  assert.equal(selection.replayRobot, "go2");
  assert.deepEqual(selection.logLevels, ["ERROR"]);
});

test("profile editor cancels debounce on explicit save and retains queued profile identity", async () => {
  const { ProfileSettingsEditor } = await import("../static/persistence.mjs");
  let callback, cancelled = 0;
  const writes = [];
  const editor = new ProfileSettingsEditor({ save: async values => { writes.push(structuredClone(values)); return values; } }, {
    setTimeout: value => { callback = value; return 1; }, clearTimeout: () => { cancelled++; },
  });
  editor.settingsReady = true;
  editor.robotProfileId = "A";
  let draft = { profile_id: "A", value: 1 };
  editor.schedule(() => draft);
  draft.value = 2;
  await editor.save(draft);
  editor.robotProfileId = "B";
  assert.equal(editor.persistTimer, null);
  assert.equal(cancelled, 2);
  assert.deepEqual(writes, [{ profile_id: "A", value: 2 }]);
  assert.equal(typeof callback, "function");
});

test("edited preferences reject delayed hydration and serialized writes retain snapshots", async () => {
  const { LauncherPreferences } = await import("../static/persistence.mjs");
  const preferences = new LauncherPreferences();
  const bodies = [], pending = [];
  const request = body => new Promise(resolve => { bodies.push(JSON.parse(body)); pending.push(resolve); });
  preferences.values.go2_source = "manual";
  const first = preferences.save(request, "10.0.0.1");
  assert.equal(preferences.hydrate({ go2_source: "auto" }), false);
  preferences.values.go2_source = "simulated";
  const second = preferences.save(request, "10.0.0.2");
  await new Promise(setImmediate);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].go2_source, "manual");
  pending[0]({ ok: true });
  await first;
  await new Promise(setImmediate);
  assert.equal(bodies[1].go2_source, "simulated");
  assert.equal(bodies[1].manual_ip, "10.0.0.2");
  pending[1]({ ok: true });
  await second;
});

test("obsolete profile loads cannot create profiles after the robot selection changes", async () => {
  let current = true;
  const calls = [];
  const request = async (_url, options) => {
    calls.push(options?.method || "GET");
    current = false;
    return response({ profiles: [] });
  };
  assert.deepEqual(await profilesForRobot(request, "openyam", true, () => current), []);
  assert.deepEqual(calls, ["GET"]);
});

for (const failure of [false, true]) test(`hardware owner retires an obsolete planner ${failure ? "failure" : "success"}`, async () => {
  const { HardwareDiscovery } = await import("../static/source-selection.mjs");
  const pending = [];
  const hardware = new HardwareDiscovery(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  let interpreter = "first";
  const options = { enabled: true, scope: () => interpreter, changed: () => {} };
  const first = hardware.refreshPlanner(options);
  interpreter = "second";
  const second = hardware.refreshPlanner(options);
  pending[1].resolve(response({ ready: true, state: "ready", message: "current" }));
  await second;
  if (failure) pending[0].reject(new Error("obsolete"));
  else pending[0].resolve(response({ ready: false, state: "error", message: "obsolete" }));
  await first;
  assert.equal(hardware.plannerStatus.message, "current");
  assert.equal(hardware.requests.busy("planner"), false);
});

test("hardware owner serializes CAN setup admission and publishes readiness once", async () => {
  const { HardwareDiscovery } = await import("../static/source-selection.mjs");
  let resolve;
  const progress = [];
  const hardware = new HardwareDiscovery(() => new Promise(value => { resolve = value; }));
  const options = { enabled: true, scope: () => "arm/can0", interface: "can0", changed: () => {}, progress: value => progress.push(value.phase) };
  const first = hardware.setupCan(options);
  assert.equal(hardware.setupCan(options), undefined);
  assert.equal(hardware.requests.busy("canSetup"), true);
  resolve(response({ ready: true, interface: "can0" }));
  await first;
  assert.deepEqual(progress, ["checking", "ready"]);
  assert.equal(hardware.canStatus.ready, true);
});

test("hardware requests call the injected fetch without an object receiver", async () => {
  const { HardwareDiscovery } = await import("../static/source-selection.mjs");
  const calls = [], progress = [], discoveries = [];
  const hardware = new HardwareDiscovery(async function (path, options) {
    // Browser fetch rejects a HardwareDiscovery receiver with Illegal invocation.
    assert.equal(this, undefined);
    calls.push([path, options]);
    return response({ ready: true, devices: [] });
  });
  const options = { enabled: true, scope: () => "arm/can0", interface: "can0", changed() {} };
  await hardware.refreshCan(options);
  assert.equal(hardware.canStatus.ready, true);
  await hardware.setupCan({ ...options, progress: value => progress.push(value.phase) });
  assert.deepEqual(progress, ["checking", "ready"]);
  await hardware.refreshPlanner(options);
  assert.equal(hardware.plannerStatus.ready, true);
  await hardware.discover({ ...options, robot: "openyam", auto: () => false,
    received: value => discoveries.push(value) });
  assert.equal(discoveries.length, 1);
  assert.deepEqual(calls, [
    ["/api/can/status?interface=can0", undefined],
    ["/api/can/setup?interface=can0", { method: "POST" }],
    ["/api/planner/status", undefined],
    ["/api/discovery?robot=openyam", undefined],
  ]);
});


test("saved source and recording selections survive launcher reload", async () => {
  const { LauncherPreferences } = await import("../static/persistence.mjs");
  const preferences = new LauncherPreferences();
  preferences.hydrate({
    go2_source: "simulated", openyam_source: "device:can1",
    replay: "/recordings/go2.db", openyam_replay: "/recordings/arm.db",
    replay_streams: { go2: { lidar: "lidar" } },
    recordings: { go2: ["/recordings/go2.db"] },
  });
  assert.equal(preferences.values.go2_source, "simulated");
  assert.equal(preferences.values.openyam_source, "device:can1");
  assert.equal(preferences.values.replay, "/recordings/go2.db");
  assert.equal(preferences.values.openyam_replay, "/recordings/arm.db");
  assert.deepEqual(preferences.replayStreams.go2, { lidar: "lidar" });
  assert.deepEqual(preferences.recordings.go2, ["/recordings/go2.db"]);
});

test("automatic CAN discovery replaces a stale interface after reconnect", async () => {
  const { HardwareDiscovery } = await import("../static/source-selection.mjs");
  let devices = [{ id: "can1", address: "can1" }];
  const hardware = new HardwareDiscovery(async path => response(
    path.startsWith("/api/discovery") ? { devices } : { ready: true },
  ));
  const options = { enabled: true, scope: () => "arm", changed() {} };
  const discover = () => hardware.discover({
    ...options, robot: "openyam", auto: () => true, received() {},
  });
  await discover();
  await hardware.refreshCan({ ...options, interface: "can1" });
  assert.equal(hardware.resolvedCan, "can1");
  assert.equal(hardware.canStatus.ready, true);

  devices = [];
  await discover();
  assert.equal(hardware.canStatus.ready, false);

  devices = [{ id: "can2", address: "can2" }];
  await discover();
  assert.equal(hardware.resolvedCan, "can2");
  await hardware.refreshCan({ ...options, interface: "can2" });
  assert.equal(hardware.canStatus.ready, true);
});

test("replay scrubber holds the draft and serializes the latest seek", async () => {
  const { replayTimeline } = await import("../static/replay-timeline.mjs");
  function element() {
    return Object.assign(new EventTarget(), { setAttribute() {} });
  }
  const root = element(), slider = element(), time = element(), status = element();
  const buttons = { play: element(), pause: element(), stop: element() };
  const requests = [];
  const timeline = replayTimeline({
    root, slider, time, status, buttons,
    request: (_, options) => new Promise(resolve => requests.push({ body: JSON.parse(options.body), resolve })),
  });
  const active = { session_id: "recording", state: "playing", elapsed_s: 3, duration_s: 65 };
  timeline.observe(active);
  assert.equal(root.hidden, false);
  assert.equal(time.textContent, "00:03 / 01:05");
  slider.value = "20";
  slider.dispatchEvent(new Event("input"));
  timeline.observe({ ...active, elapsed_s: 4 });
  assert.equal(slider.value, "20");
  assert.equal(requests.length, 0);
  slider.dispatchEvent(new Event("change"));
  assert.deepEqual(requests[0].body, { session_id: "recording", action: "seek", elapsed_s: 20 });
  assert.equal(status.textContent, "Seeking…");

  for (const position of ["25", "30"]) {
    slider.value = position;
    slider.dispatchEvent(new Event("input"));
    slider.dispatchEvent(new Event("change"));
  }
  assert.equal(requests.length, 1);
  requests[0].resolve(response({}));
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.elapsed_s, 30);

  timeline.observe(null);
  requests[1].resolve(response({}));
  await new Promise(setImmediate);
  assert.equal(root.hidden, true);
});
