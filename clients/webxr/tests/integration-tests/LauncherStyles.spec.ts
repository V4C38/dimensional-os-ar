import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

const launcherCss = readFileSync(new URL("../../../../launcher/app/static/app.css", import.meta.url), "utf8");

test("launcher shared controls retain metrics, keyboard focus and enabled-only hover", async ({ page }) => {
  await page.setContent(`<style>${launcherCss}</style><main class="app">
    <section>
      <button id="enabled">Enabled</button>
      <button id="disabled" disabled>Disabled</button>
      <select id="select"><option>Robot</option></select>
      <input id="input" value="Profile">
      <details><summary id="summary">Calibration</summary></details>
    </section>
  </main>`);
  const selectors = await page.evaluate(() => Array.from(document.styleSheets[0].cssRules)
    .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
    .map(rule => rule.selectorText));
  expect(selectors).toContain(".app :is(button, select)");
  expect(selectors).toContain(".app :is(button, summary, select, input):focus-visible");
  expect(selectors).toContain(".app :is(button, summary):hover:not(:disabled)");
  for (const id of ["enabled", "disabled", "select", "input", "summary"]) {
    const control = page.locator(`#${id}`);
    await expect(control).toHaveCSS("height", "44px");
    await expect(control).toHaveCSS("border-radius", "6px");
  }
  const enabled = page.locator("#enabled");
  const disabled = page.locator("#disabled");
  const normalBackground = await enabled.evaluate(element => getComputedStyle(element).backgroundColor);
  const disabledBackground = await disabled.evaluate(element => getComputedStyle(element).backgroundColor);
  await enabled.hover();
  await expect(enabled).not.toHaveCSS("background-color", normalBackground);
  await disabled.hover();
  await expect(disabled).toHaveCSS("background-color", disabledBackground);
  await page.mouse.move(1200, 850);
  await expect(enabled).toHaveCSS("background-color", normalBackground);
  await page.keyboard.press("Tab");
  await expect(enabled).toBeFocused();
  await expect(enabled).toHaveCSS("outline-style", "solid");
  await expect(enabled).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Tab");
  await expect(page.locator("#select")).toBeFocused();
  await expect(page.locator("#select")).toHaveCSS("outline-width", "2px");
});

const launcherLogModule = readFileSync(new URL("../../../../launcher/app/static/log-console.mjs", import.meta.url), "utf8");

test("launcher logs highlight failures and confirmed connections without coloring ordinary progress", async ({ page }) => {
  await page.setContent(`<style>${launcherCss}</style><div class="log" id="log"></div>`);
  const tones = await page.evaluate(async source => {
    const { logConsole } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    const logEl = document.querySelector("#log")!;
    const logger = logConsole({ logEl, logFilterLevel: { value: "debug" },
      logFilterSource: { value: "all" }, copyLogBtn: {} });
    for (const line of ["Start error: device unavailable", "WebRTC connected", "Preparing camera", "CAN ready"])
      logger.appendLog(line);
    await new Promise(requestAnimationFrame);
    return [...logEl.children].map(node => ({ tone: (node as HTMLElement).dataset.tone,
      color: getComputedStyle(node).color }));
  }, launcherLogModule);
  expect(tones.map(line => line.tone)).toEqual(["error", "success", "normal", "success"]);
  expect(tones[0].color).not.toBe(tones[2].color);
  expect(tones[1].color).not.toBe(tones[2].color);
  expect(tones[1].color).toBe(tones[3].color);
});

test("launcher prioritizes session controls and shows live connection details", async ({ page }) => {
  await page.addInitScript(() => {
    class ConnectionEvents extends EventTarget {
      constructor() {
        super();
        window.addEventListener("launcher-test-snapshot", (event) => {
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify((event as CustomEvent).detail) }));
        });
      }
      onmessage: ((event: MessageEvent) => void) | null = null;
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: ConnectionEvents });
  });
  page.on("pageerror", error => { throw error; });
  let browses = 0;
  let runningSince: number | undefined;
  let pickerStart: string | undefined;
  let canSetups = 0;
  let canUnavailable = false;
  await page.route("http://launcher.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/" || /^\/static\/[\w.-]+\.(css|js|mjs)$/.test(path)) {
      const name = path === "/" ? "index.html" : path.slice("/static/".length);
      const type = name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "text/javascript";
      await route.fulfill({
        contentType: type,
        body: readFileSync(new URL(`../../../../launcher/app/static/${name}`, import.meta.url)),
      });
      return;
    }
    if (path === "/api/apriltag/0.png") {
      await route.fulfill({
        contentType: "image/png",
        body: readFileSync(new URL("../../../../assets/markers/apriltag_robot_0.png", import.meta.url)),
      });
      return;
    }
    if (path === "/api/discovery") {
      const arm = new URL(route.request().url()).searchParams.get("robot") === "openyam";
      await route.fulfill({ json: { devices: arm ? [{ id: "can0", address: "can0", label: "can0" }] : [] } });
      return;
    }
    if (path === "/api/can/status") {
      await route.fulfill({ json: canUnavailable ? { state: "not_required", ready: true } :
        { state: canSetups ? "ready" : "down", ready: !!canSetups } });
      return;
    }
    if (path === "/api/can/setup") {
      canSetups++;
      await route.fulfill({ json: { state: "ready", ready: true, interface: "can0" } });
      return;
    }
    if (path === "/api/settings") {
      await route.fulfill({ json: { defaults: {
        blueprints: [
          { id: "unitree-go2-ar", label: "Go2", description: "Go2 navigation", robot: "unitree_go2", agent: true, manipulation: false },
          { id: "openyam-ar-planner", label: "OpenYAM", description: "OpenYAM manipulation", robot: "openyam", manipulation: true },
        ],
        log_levels: ["DEBUG", "INFO", "WARNING", "ERROR"], log_level: "INFO",
        localization: { travel_threshold_m: 1, heading_threshold_deg: 30 },
        mounts: [{
          marker_id: 0, print_size_mm: 70, forward_m: 0.18, lateral_m: 0,
          up_m: 0.06, yaw_deg: -90, pitch_deg: -15, roll_deg: 0,
        }],
        preset_marker_ids: [0, 1, 2],
      } } });
      return;
    }
    if (path === "/api/webxr/start") {
      await route.fulfill({ json: {
        phase: "running", webxr_phase: "running", webxr_local_url: "https://localhost:5173/",
      } });
      return;
    }
    if (path === "/api/setup/location") {
      const { mode, clone_dir } = route.request().postDataJSON();
      await route.fulfill({ json: mode === "clone"
        ? clone_dir
          ? { state: "download", message: "DimOS is missing here." }
          : { state: "invalid", message: "Enter a folder path." }
        : { state: "found", message: "DimOS installation found." } });
      return;
    }
    if (path === "/api/browse-dimos-install") {
      pickerStart = route.request().postDataJSON().path;
      await route.fulfill({ json: { path: "/tmp/chosen-dimos" } });
      return;
    }
    if (path === "/api/browse-replay") {
      await route.fulfill({ json: { path: `/tmp/recording-${++browses}.db` } });
      return;
    }
    if (path === "/api/replay/inspect") {
      await route.fulfill({ json: { streams: {}, candidates: {} } });
      return;
    }
    await route.fulfill({ json: path === "/api/status" ? {
      phase: runningSince ? "running" : "idle",
      running_since_ms: runningSince,
      connections: [],
      dimos_install_dir: "/tmp/current-dimos",
    } : {} });
  });
  await page.goto("http://launcher.test/");
  const leftPane = page.locator("#sidePanel");
  await expect(leftPane.getByRole("heading", { name: "dimOS ARModule" })).toBeVisible();
  const infoButton = leftPane.getByRole("button", { name: "Blueprint information" });
  const blueprintInfo = leftPane.locator("#blueprintInfo");
  await expect(blueprintInfo).toBeHidden();
  await expect(infoButton.locator(".blueprint-info-icon")).toHaveCSS("border-radius", "50%");
  await infoButton.hover();
  await expect(blueprintInfo).toHaveText("Go2 navigation");
  await expect(blueprintInfo).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(blueprintInfo).toBeHidden();
  await infoButton.press("Enter");
  await expect(blueprintInfo).toBeVisible();
  await infoButton.press("Escape");
  await expect(blueprintInfo).toBeHidden();
  await expect(page.locator(".log-panel").getByRole("heading", { name: "dimOS ARModule" })).toHaveCount(0);
  await expect(leftPane.getByRole("button", { name: "Run blueprint" })).toBeVisible();
  const idleStop = leftPane.getByRole("button", { name: "Stop blueprint" });
  await expect(idleStop).toBeVisible();
  await expect(idleStop).toBeEnabled();
  const run = leftPane.getByRole("button", { name: "Run blueprint" });
  expect((await idleStop.boundingBox())!.x).toBeLessThan((await run.boundingBox())!.x);
  await expect(page.locator("#logPanel")).toBeHidden();
  const sessionWidth = (await leftPane.boundingBox())!.width;
  await leftPane.getByRole("button", { name: "View logs" }).click();
  const logs = page.locator("#logPanel");
  await expect(logs).toBeVisible();
  expect((await leftPane.boundingBox())!.width).toBe(sessionWidth);
  const logWidth = (await logs.boundingBox())!.width;
  expect(logWidth).toBeLessThan(sessionWidth);
  const handle = (await page.locator("#splitter").boundingBox())!;
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 220, y);
  expect((await logs.boundingBox())!.width).toBe(logWidth + 220);
  await page.mouse.move(x + 80, y);
  await page.mouse.up();
  expect((await logs.boundingBox())!.width).toBe(logWidth - 80);
  await leftPane.getByRole("button", { name: "Hide logs" }).click();
  const card = page.locator("#ipCard");
  await expect(card).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("launcher-test-snapshot", {
    detail: { type: "connections", connections: [{ kind: "robot", name: "Go2", status: "online" }] },
  })));
  await expect(card.getByRole("listitem")).toHaveText("Go2 · Connected");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("launcher-test-snapshot", {
    detail: { type: "status", phase: "running", webxr_phase: "stopped", connections: [] },
  })));
  await expect(card.getByText("Not running")).toBeVisible();
  await card.getByRole("button", { name: "Start WebXR" }).click();
  await expect(card.getByRole("link", { name: "https://localhost:5173/" })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("launcher-test-snapshot", {
    detail: { type: "status", phase: "running", pin: "1234", webxr_url: "https://launcher.test/xr", host_ip: "192.0.2.1", connections: [] },
  })));
  await expect(card.getByRole("heading", { name: "Connection status" })).toBeVisible();
  await expect(card.getByText("PIN", { exact: true })).toBeVisible();
  await expect(card.getByText("1234")).toBeVisible();
  await expect(card.getByText("192.0.2.1")).toBeVisible();
  await expect(card.getByText("WebXR URL")).toBeVisible();
  await expect(leftPane.locator("#stateDetail")).toBeHidden();
  await expect(card.getByRole("link", { name: "https://launcher.test/xr" })).toHaveAttribute("href", "https://launcher.test/xr");
  await expect(card.getByRole("link", { name: "https://launcher.test/xr" })).toHaveCSS("color", "rgb(255, 255, 255)");
  expect((await card.locator("#webxrNetworkRow").boundingBox())!.y)
    .toBe((await card.locator("#pinRow").boundingBox())!.y);
  await expect(leftPane.getByRole("button", { name: "Stop blueprint" })).toBeEnabled();
  await expect(card.getByText("Waiting for connections")).toBeVisible();
  const publish = (connections: readonly object[]) => page.evaluate((connections) => {
    window.dispatchEvent(new CustomEvent("launcher-test-snapshot", { detail: { type: "connections", connections } }));
  }, connections);
  await publish([
    { kind: "robot", name: "Go2", status: "online" },
    { kind: "client", name: "Spectacles", id: "headset-1", status: "online" },
  ]);
  await expect(card.getByRole("listitem")).toHaveText(["Go2 · Connected", "SPECS · headset-1 · Connected"]);
  await publish([
    { kind: "robot", name: "Go2 (Recording)", status: "online", online_since_ms: Date.now() - 65_000 },
  ]);
  await expect(card.getByRole("listitem")).toContainText("Go2 (Recording) · Playing");
  await expect(card.locator(".connection-duration")).toHaveText(/^1:0[5-9]$/);
  await expect(card.getByText("Waiting for connections")).toBeHidden();
  await publish([]);
  await expect(card.getByText("Waiting for connections")).toBeVisible();
  await expect(card.getByRole("listitem")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("launcher-test-snapshot", {
    detail: { type: "status", phase: "idle", check_ok: true, dimos_install_dir: "/tmp/current-dimos", connections: [] },
  })));
  const install = page.locator("#installBanner");
  const setupSummary = install.locator("summary");
  await expect(setupSummary).toContainText("dimOS install");
  await expect(setupSummary).toHaveCSS("height", "34px");
  await expect(setupSummary).toHaveCSS("background-color", /\/ 0\.6\)$/);
  const setupHeading = leftPane.getByRole("heading", { name: "dimOS setup" });
  expect((await setupHeading.boundingBox())!.y).toBeLessThan((await setupSummary.boundingBox())!.y);
  const blueprintBounds = (await page.getByLabel("Blueprint", { exact: true }).boundingBox())!;
  const setupBounds = (await setupSummary.boundingBox())!;
  expect((await setupHeading.boundingBox())!.y).toBeLessThan(blueprintBounds.y);
  expect(blueprintBounds.y + blueprintBounds.height).toBeLessThan(setupBounds.y);
  expect(setupBounds.x).toBe(blueprintBounds.x);
  const disclosureArrow = await setupSummary.evaluate(summary => getComputedStyle(summary, "::after").backgroundImage);
  await expect(page.getByLabel("Blueprint", { exact: true })).toHaveCSS("background-image", disclosureArrow);
  await install.locator("summary").click();
  await expect(install.getByRole("group", { name: "Installation source" })).toBeVisible();
  const path = install.getByLabel("Installation folder");
  await expect(path).toHaveValue("/tmp/current-dimos");
  await path.fill("/tmp/edited-dimos");
  expect(pickerStart).toBeUndefined();
  await install.getByRole("button", { name: "Browse…" }).click();
  await expect(path).toHaveValue("/tmp/chosen-dimos");
  expect(pickerStart).toBe("/tmp/edited-dimos");
  await install.getByText("Download from GitHub").click();
  const destination = install.getByLabel("Download folder");
  await expect(install.getByText("Enter a folder path.")).toBeVisible();
  await expect(install.getByRole("button", { name: "Download & install" })).toBeDisabled();
  await destination.fill("/tmp/empty-dimos");
  await expect(install.getByText("DimOS is missing here.")).toBeVisible();
  await expect(install.getByRole("button", { name: "Download & install" })).toBeEnabled();
  await install.getByText("Existing install").click();

  const robot = page.getByRole("group", { name: "Robot", exact: true });
  const robotSource = robot.getByLabel("Robot source", { exact: true });
  await expect(robot.getByRole("combobox", { name: "Robot config", exact: true })).toBeVisible();
  await expect(robotSource.locator("option")).toHaveText(["Auto (scan on start)", "Manual IP", "Simulated hardware"]);
  const setupFonts = await page.locator(".robot-setup-field .label").evaluateAll(labels =>
    labels.map(label => {
      const style = getComputedStyle(label);
      return [style.fontFamily, style.fontSize, style.fontWeight];
    }),
  );
  expect(new Set(setupFonts.map(font => font.join("|"))).size).toBe(1);
  const refresh = robot.getByRole("button", { name: "Refresh robots" });
  await expect(refresh).toHaveCSS("height", "34px");
  await expect(refresh).toHaveCSS("width", "40px");
  await expect(infoButton).toHaveCSS("width", "40px");
  await expect(refresh).toHaveCSS("border-top-color", /\/ 0\.6\)$/);
  for (const control of await leftPane.locator(".primary-config-control").all()) {
    await expect(control).toHaveCSS("height", "40px");
    await expect(control).toHaveCSS("font-weight", "400");
    await expect(control).toHaveCSS("background-color", "rgb(53, 53, 55)");
  }
  for (const field of ["#webrtcCard", "#canCard"]) {
    await expect(robot.locator(field)).toHaveCSS("height", "34px");
    await expect(robot.locator(field)).toHaveCSS("background-color", /\/ 0\.6\)$/);
  }
  await expect(robot.getByLabel("Robot IP address")).toBeHidden();
  await robotSource.selectOption("manual");
  const manualIp = robot.getByLabel("Robot IP address");
  await expect(manualIp).toBeFocused();
  await expect(manualIp).toHaveCSS("height", "34px");
  await expect(robot.getByText("Robot IP address", { exact: true })).toHaveCount(0);
  const manualSpacing = await robot.locator("#manualIpField").evaluate(field => {
    const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    const bounds = field.getBoundingClientRect();
    return {
      indent: bounds.left - rect("robotSource").left,
      gap: bounds.top - rect("robotSource").bottom,
    };
  });
  await expect(robot.locator("#webrtcCard")).toBeHidden();
  await expect(refresh).toBeHidden();
  await manualIp.fill("192.168.1.10");
  await robotSource.selectOption("auto");
  await expect(manualIp).toBeHidden();
  await expect(robot.locator("#webrtcCard")).toBeVisible();
  await robotSource.selectOption("manual");
  await expect(manualIp).toHaveValue("192.168.1.10");
  await robotSource.selectOption("auto");
  const switchBlueprint = (id: string) => page.getByLabel("Blueprint", { exact: true })
    .evaluate((select: HTMLSelectElement, id) => {
      select.value = id;
      select.dispatchEvent(new Event("change"));
      return ["canCard", "webrtcCard"].map(card => !document.getElementById(card)!.classList.contains("hidden"));
    }, id);
  expect(await switchBlueprint("openyam-ar-planner")).toEqual([true, false]);
  await expect(robotSource.locator('option[value="auto"]')).toHaveText("Auto (first available CAN interface)");
  const expectSourceIndent = async (childId: string) => {
    const spacing = await robotSource.evaluate((source, id) => {
      const parent = source.getBoundingClientRect();
      const child = document.getElementById(id)!.getBoundingClientRect();
      return { indent: child.left - parent.left, gap: child.top - parent.bottom };
    }, childId);
    expect(spacing.indent).toBeCloseTo(manualSpacing.indent);
    expect(spacing.gap).toBeCloseTo(manualSpacing.gap);
  };
  await expectSourceIndent("robotSetupRow");
  const setupCan = robot.getByRole("button", { name: "Set up CAN" });
  await expect(setupCan).toHaveText("Set up CAN");
  await expect(setupCan).toHaveCSS("height", "34px");
  await setupCan.click();
  await expect(refresh).toHaveText("↻");
  expect(canSetups).toBe(1);
  canUnavailable = true;
  await refresh.click();
  await expect(robot.locator("#canSummary")).toHaveText("Unavailable");
  await robotSource.selectOption("simulated");
  await expect(robot.locator("#robotSetupRow")).toBeHidden();
  await expectSourceIndent("replayRow");
  await expect(robot.getByText("Add an OpenYAM recording to start.")).toHaveCount(0);
  await robotSource.selectOption("auto");
  expect(await switchBlueprint("unitree-go2-ar")).toEqual([false, true]);
  await expectSourceIndent("robotSetupRow");
  await expect(robot.locator(":scope > details")).toHaveCount(0);
  await expect(card.getByText("accept the HTTPS certificate warning", { exact: false })).toHaveCount(0);
  await refresh.click();
  await expect(robot.locator("#webrtcSummary")).toHaveText("None found");
  await expect(robot.locator("#discoveryStatus, #canSetupResult")).toHaveCount(0);
  await robotSource.selectOption("manual");
  await expect(robot.getByLabel("Robot IP address")).toBeVisible();
  await robotSource.selectOption("simulated");
  await expect(refresh).toBeHidden();
  await expect(robot.locator("#webrtcSummary")).toBeHidden();
  const recording = robot.getByLabel("Recording", { exact: true });
  await expect(recording.locator("option")).toHaveText(["Go2 example"]);
  await expect(recording).toHaveCSS("height", "34px");
  const addRecording = robot.getByRole("button", { name: "Add recording" });
  await expect(addRecording).toHaveCSS("height", "34px");
  await expect(addRecording).toHaveCSS("width", "40px");
  await expect(addRecording).toHaveCSS("border-top-color", /\/ 0\.6\)$/);
  await robot.getByRole("button", { name: "Add recording" }).click();
  await expect(recording).toHaveValue("/tmp/recording-1.db");
  await robot.getByRole("button", { name: "Add recording" }).click();
  await expect(recording.locator("option")).toHaveText(["Go2 example", "recording-1.db", "recording-2.db"]);
  await recording.selectOption("/tmp/recording-1.db");
  await expect(recording).toHaveValue("/tmp/recording-1.db");
  const profile = page.getByRole("region", { name: "Robot config" });
  await expect(profile.locator("#locCard")).toHaveCount(1);
  await expect(profile.locator("#agentConfig")).toBeVisible();
  const primarySelector = profile.getByRole("combobox", { name: "Robot config", exact: true });
  await expect(primarySelector).toHaveCSS("height", "40px");
  await expect(primarySelector).toHaveCSS("background-color", "rgb(53, 53, 55)");
  for (const card of ["#locCard", "#agentConfig"]) {
    const summary = profile.locator(`${card} > summary`);
    await expect(summary).toHaveCSS("height", "34px");
    await expect(summary).toHaveCSS("background-color", /\/ 0\.6\)$/);
  }
  expect(await profile.evaluate(section => {
    const selector = section.querySelector("#robotProfileSelect")!.getBoundingClientRect();
    const localization = section.querySelector("#locCard")!.getBoundingClientRect();
    const agent = section.querySelector("#agentConfig")!.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(section.querySelector("#locCard")!.parentElement!).rowGap);
    return localization.left === selector.left
      && Math.abs(localization.top - selector.bottom - gap) < 0.1
      && Math.abs(agent.top - localization.bottom - gap) < 0.1;
  })).toBe(true);
  const localization = page.locator("#locCard");
  const localizationSummary = localization.locator(":scope > summary");
  await localizationSummary.hover();
  await expect(localizationSummary).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(localizationSummary).toHaveCSS("padding-inline-start", "12px");
  await localizationSummary.click();
  await expect(localization).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(localizationSummary).toHaveCSS("box-shadow", "none");
  const relocalization = localization.locator(".localization-option");
  const marker = localization.getByText("Fiducial marker", { exact: true });
  const vps = localization.getByText("VPS", { exact: true });
  const markerSwitch = localization.getByRole("switch", { name: "Fiducial marker" });
  await expect(markerSwitch).not.toBeChecked();
  await marker.click();
  await expect(markerSwitch).toBeChecked();
  const collapsedMarker = localization.locator(".tag-card:not([open]) .tag-thumbnail").first();
  await expect(collapsedMarker).toBeVisible();
  await expect.poll(() => collapsedMarker.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await localization.locator(".tag-card > summary").first().click();
  await localization.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(localization.getByText("No fiducial markers configured.")).toBeVisible();
  await expect(localization.locator(".tag-card")).toHaveCount(0);
  await localization.getByRole("button", { name: "Restore defaults" }).click();
  await expect(collapsedMarker).toBeVisible();
  expect(await localization.locator("#vpsPanel").evaluate(panel =>
    !!(panel.compareDocumentPosition(document.getElementById("nativeMapField")!) & Node.DOCUMENT_POSITION_FOLLOWING),
  )).toBe(true);
  await vps.click();
  await marker.click();
  const map = relocalization.getByLabel("Prescanned LiDAR map");
  await expect(map).toBeHidden();
  await relocalization.getByText("Relocalization policy").click();
  await expect(map).toBeVisible();
  await expect(relocalization.getByLabel("Minimum distance (m)")).toHaveValue("1");
  await expect(relocalization.getByLabel("Minimum rotation (°)")).toHaveValue("30");
  await expect(localization.getByLabel("MultiSet client secret", { exact: true })).toHaveAttribute("type", "password");
  await expect(localization.getByRole("button", { name: "Show MultiSet secret" })).toHaveCSS("height", "34px");
  await expect(install.getByRole("button", { name: "Browse…" })).toHaveCSS("height", "34px");
  const agent = profile.locator("#agentConfig");
  await agent.locator("summary").click();
  const apiKey = agent.getByLabel("OpenAI API key", { exact: true });
  await expect(apiKey).toHaveAttribute("type", "password");
  await expect(agent.getByRole("button", { name: "Show API key" })).toHaveCSS("height", "34px");
  await agent.getByRole("button", { name: "Show API key" }).click();
  await expect(apiKey).toHaveAttribute("type", "text");
  await agent.getByRole("button", { name: "Hide API key" }).click();
  await expect(apiKey).toHaveAttribute("type", "password");
  await leftPane.getByRole("button", { name: "View logs" }).click();
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(localization.locator("#vpsPanel")).toHaveCSS(
      "grid-template-columns",
      /^\d+(?:\.\d+)?px$/,
    );
    const settingsWidths = await page.locator("#dimosPythonField, #agentConfig .settings-row")
      .evaluateAll(rows => rows.map(row => getComputedStyle(row).gridTemplateColumns.split(" ").length));
    expect(settingsWidths).toEqual(Array(2).fill(width === 375 ? 1 : 2));
    await expect(relocalization.locator(".settings-fields")).toHaveCSS(
      "grid-template-columns",
      width === 375 ? /^\d+(?:\.\d+)?px$/ : /^\d+(?:\.\d+)?px \d+(?:\.\d+)?px$/,
    );
    const controls = await page.locator(".app").evaluate(app => {
      const style = (selector: string) => getComputedStyle(app.querySelector(selector)!);
      const buttons = [...app.querySelectorAll(".panel button")].filter(button => button.getClientRects().length);
      const icons = buttons.filter(button => button.classList.contains("btn-icon"));
      const logControls = [...app.querySelectorAll(".log-actions :is(button, select)")].map(control => getComputedStyle(control));
      return {
        title: style(".brand-title").fontSize,
        heading: style("#locCard summary").fontSize,
        hint: style("#markersEmpty").fontSize,
        log: style(".log").fontSize,
        buttonHeights: [...new Set(buttons.map(button => getComputedStyle(button).height))],
        buttonFonts: [...new Set(buttons.map(button => getComputedStyle(button).fontSize))],
        iconWidths: [...new Set(icons.map(button => getComputedStyle(button).width))],
        logControlHeights: [...new Set(logControls.map(control => control.height))],
        logControlFonts: [...new Set(logControls.map(control => control.fontSize))],
        consistentControlFamily: [...buttons.map(button => getComputedStyle(button)), ...logControls]
          .every(control => control.fontFamily === style(".brand-title").fontFamily),
        fitsViewport: app.scrollWidth <= window.innerWidth,
      };
    });
    expect(controls).toMatchObject({
      title: "21px", heading: "14px", hint: "12px", log: "12px",
      buttonHeights: ["40px", "34px"], buttonFonts: ["14px"], iconWidths: ["40px"],
      logControlHeights: ["32px"], logControlFonts: ["12px"], consistentControlFamily: true, fitsViewport: true,
    });
  }
  await expect(page.getByLabel("Startup log level")).toBeEnabled();
  await marker.click();
  await localizationSummary.click();
  await publish([]);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("launcher-test-snapshot", {
    detail: { type: "status", phase: "running", connections: [] },
  })));
  await expect(page.getByLabel("Startup log level")).toBeDisabled();
  await localizationSummary.click();
  await expect(localization).toHaveCSS("display", "block");
  await expect(localization.getByLabel("Prescanned LiDAR map")).toBeDisabled();
  const markerCard = localization.locator(".tag-card").first();
  await markerCard.locator("summary").click();
  await expect(markerCard).toHaveCSS("display", "block");
  await expect(markerCard.getByLabel("Marker type")).toBeDisabled();
  await expect(markerCard.getByRole("link", { name: "Printable PDF" })).toHaveAttribute("href", "/api/apriltag/0.pdf?size_mm=70");
  await expect(page.getByLabel("Filter log by level")).toBeEnabled();
  const updatePhase = (phase: string, error?: string) => page.evaluate(({ phase, error }) => {
    window.dispatchEvent(new CustomEvent("launcher-test-snapshot", {
      detail: { type: "status", phase, error, check_ok: true, connections: [] },
    }));
  }, { phase, error });
  await updatePhase("starting");
  await expect(leftPane.getByRole("button", { name: "Cancel startup" })).toBeVisible();
  await expect(leftPane.locator("#actionNote")).toHaveText("Starting DimOS");
  await expect(leftPane.locator("#actionElapsed")).toHaveText("0:01");
  await updatePhase("stopping");
  await expect(leftPane.locator("#actionNote")).toHaveText("Stopping DimOS");
  await expect(leftPane.locator("#actionElapsed")).toHaveText("0:00");
  await expect(leftPane.getByRole("button", { name: "Force stop" })).toBeVisible();
  await updatePhase("error", "Robot could not connect");
  await expect(leftPane.getByText("Robot could not connect")).toBeVisible();
  runningSince = Date.now() - 92_000;
  await page.reload();
  await expect(leftPane.locator("#actionNote")).toHaveText("Blueprint running");
  await expect(leftPane.locator("#actionElapsed")).toHaveText(/^1:3[2-9]$/);
  await expect(leftPane.getByRole("button", { name: "Run blueprint" })).toBeVisible();

});

test("expanded select matches launcher controls and preserves keyboard selection", async ({ page }) => {
  await page.setContent(`<style>${launcherCss}</style><main class="app">
    <button>Launcher button</button>
    <select aria-label="Source">
      <option>Auto</option>
      <option disabled>Unavailable</option>
      <option>Recording</option>
    </select>
  </main>`);
  const select = page.getByRole("combobox", { name: "Source" });
  await select.focus();
  await select.press("Space");
  await expect(page.locator("select:open")).toHaveCount(1);
  const picker = await select.evaluate(element => {
    const style = getComputedStyle(element, "::picker(select)");
    return { appearance: style.appearance, color: style.backgroundColor, radius: style.borderRadius };
  });
  const buttonBackground = await page.getByRole("button").evaluate(element => getComputedStyle(element).backgroundColor);
  expect(picker).toEqual({ appearance: "base-select", color: buttonBackground, radius: "6px" });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(select).toHaveValue("Recording");
  await expect(page.locator("select:open")).toHaveCount(0);
});

test("launcher waits for a profile switch and reports a rejected stop", async ({ page }) => {
  const marker = {
    marker_id: 0, print_size_mm: 70, forward_m: 0.18, lateral_m: 0,
    up_m: 0.06, yaw_deg: -90, pitch_deg: -15, roll_deg: 0,
  };
  const defaults = {
    blueprints: [
      { id: "go2-a", label: "Go2 A", description: "Go2 navigation", robot: "unitree_go2" },
      { id: "go2-b", label: "Go2 B", description: "Go2 navigation", robot: "unitree_go2" },
    ],
    log_levels: ["INFO"], log_level: "INFO",
    localization: { travel_threshold_m: 1, heading_threshold_deg: 30 },
    mounts: [marker], preset_marker_ids: [0, 1, 2],
  };
  const profiles = ["First", "Second"].map((name, index) => ({
    id: name, name, robot: "unitree_go2",
    settings: { mounts: [{ ...marker, marker_id: index }], fiducial_marker: true },
  }));
  let profileReads = 0;
  let launchProfile: string | undefined;
  let resolveSave: () => void;
  const firstSave = new Promise<void>(resolve => { resolveSave = resolve; });
  let firstSavePending = true;
  let resolveStop: () => void;
  const stopAttempt = new Promise<void>(resolve => { resolveStop = resolve; });
  await page.route("http://launcher.test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/" || /^\/static\/[\w.-]+\.(css|js|mjs)$/.test(path)) {
      const filename = path === "/" ? "index.html" : path.slice("/static/".length);
      const contentType = filename.endsWith(".html") ? "text/html" : filename.endsWith(".css") ? "text/css" : "text/javascript";
      await route.fulfill({
        contentType,
        body: readFileSync(new URL(`../../../../launcher/app/static/${filename}`, import.meta.url)),
      });
      return;
    }
    if (path === "/api/settings") {
      if (route.request().method() === "PUT" && firstSavePending) {
        firstSavePending = false;
        await firstSave;
      }
      await route.fulfill({ json: { defaults } });
      return;
    }
    if (path === "/api/robot-profiles") {
      profileReads++;
      await route.fulfill({ json: { profiles } });
      return;
    }
    if (path === "/api/launcher-preferences") {
      await route.fulfill({ json: { go2_source: "simulated", replay: "/tmp/saved.db" } });
      return;
    }
    if (path === "/api/replay/inspect") {
      await route.fulfill({ json: { streams: {}, candidates: { color: ["camera-a", "camera-b"] }, needs_selection: true } });
      return;
    }
    if (path === "/api/armodule/start") {
      launchProfile = route.request().postDataJSON().profile_id;
      await route.fulfill({ json: { phase: "ready", check_ok: true } });
      return;
    }
    if (path === "/api/armodule/stop") {
      await stopAttempt;
      await route.fulfill({ status: 409, json: { detail: "Shutdown unavailable" } });
      return;
    }
    await route.fulfill({ json: path === "/api/status" ? { phase: "ready", check_ok: true } : {} });
  });
  await page.goto("http://launcher.test/");
  const run = page.getByRole("button", { name: "Run blueprint" });
  await expect(run).toBeEnabled();
  const localization = page.locator("#locCard");
  await localization.locator(":scope > summary").click();
  const markerCards = localization.locator(".tag-card");
  const saveSent = page.waitForRequest(request => request.url().endsWith("/api/settings") && request.method() === "PUT");
  await localization.getByRole("button", { name: "Add marker" }).click();
  await expect(markerCards).toHaveCount(2);
  for (const summary of await markerCards.locator("summary").all()) await summary.click();
  const typePicker = markerCards.first().getByRole("combobox", { name: "Marker type" });
  const printSize = markerCards.first().getByRole("spinbutton", { name: "Print size (mm)" });
  await printSize.fill("");
  await printSize.blur();
  await expect(printSize).toHaveValue("70");
  await typePicker.focus();
  await typePicker.selectOption("2");
  await expect(markerCards.first().getByRole("combobox", { name: "Marker type" })).toBeFocused();
  await expect(localization.locator(".tag-card[open]")).toHaveCount(2);
  const beforeBlueprintSelection = profileReads;
  await page.getByLabel("Blueprint", { exact: true }).selectOption("go2-b");
  await expect(markerCards).toHaveCount(2);
  expect(profileReads).toBe(beforeBlueprintSelection);

  const profile = page.getByRole("combobox", { name: "Robot config", exact: true });
  await profile.selectOption("Second");
  await saveSent;
  await expect(run).toBeDisabled();
  await expect(profile).toBeDisabled();
  resolveSave!();
  await expect(run).toBeEnabled();
  await expect(markerCards).toHaveCount(1);
  await run.click();
  await expect.poll(() => launchProfile).toBe("Second");

  const stop = page.getByRole("button", { name: "Stop blueprint" });
  await stop.click();
  await expect(stop).toBeDisabled();
  await expect(run).toBeDisabled();
  resolveStop!();
  await expect(page.getByRole("alert").filter({ hasText: "Stop error: Shutdown unavailable" })).toBeVisible();
  await expect(stop).toBeEnabled();
  await expect(run).toBeEnabled();

  const robotSource = page.getByLabel("Robot source", { exact: true });
  await expect(robotSource).toHaveValue("simulated");
  await expect(page.getByLabel("Recording", { exact: true })).toHaveValue("/tmp/saved.db");
  await expect(page.getByLabel("color stream")).toBeVisible();
});

test("replay timeline keeps playback buttons, scrubber and time in one row", async ({ page }) => {
  await page.setContent(`<style>${launcherCss}</style><main class="app" style="width: 460px">
    <div class="replay-timeline-controls">
      <button class="btn ghost replay-icon" aria-label="Play">▶</button>
      <button class="btn ghost replay-icon" aria-label="Pause">Ⅱ</button>
      <button class="btn ghost replay-icon" aria-label="Stop">■</button>
      <input type="range" id="replayPosition" aria-label="Recording position" />
      <span id="replayTime">00:00 / 01:00</span>
    </div></main>`);
  const boxes = await Promise.all([
    page.getByRole("button", { name: "Play" }).boundingBox(),
    page.getByRole("button", { name: "Stop" }).boundingBox(),
    page.getByRole("slider").boundingBox(),
    page.locator("#replayTime").boundingBox(),
  ]);
  const [play, stop, slider, time] = boxes;
  expect(play && stop && slider && time).toBeTruthy();
  expect(play!.x).toBeLessThan(stop!.x);
  expect(stop!.x + stop!.width).toBeLessThanOrEqual(slider!.x);
  expect(slider!.x + slider!.width).toBeLessThanOrEqual(time!.x);
  expect(Math.abs((slider!.y + slider!.height / 2) - (play!.y + play!.height / 2))).toBeLessThan(1);
});

test("reload restores a running replay and its timeline", async ({ page }) => {
  await page.addInitScript(() => {
    class SilentEvents { onmessage = null; close() {} }
    Object.defineProperty(window, "EventSource", { value: SilentEvents });
  });
  const playback = { session_id: "replay-1", state: "paused", elapsed_s: 12, duration_s: 60, generation: 0 };
  await page.route("http://launcher.test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/" || /^\/static\/[\w.-]+\.(css|js|mjs)$/.test(path)) {
      const name = path === "/" ? "index.html" : path.slice("/static/".length);
      await route.fulfill({
        contentType: name.endsWith(".html") ? "text/html" : name.endsWith(".css") ? "text/css" : "text/javascript",
        body: readFileSync(new URL(`../../../../launcher/app/static/${name}`, import.meta.url)),
      });
    } else if (path === "/api/settings") {
      await route.fulfill({ json: { defaults: {
        blueprints: [{ id: "unitree-go2-ar", label: "Go2", robot: "unitree_go2", manipulation: false }],
        log_levels: ["INFO"], log_level: "INFO",
        localization: { travel_threshold_m: 1, heading_threshold_deg: 30 }, mounts: [], preset_marker_ids: [],
      } } });
    } else if (path === "/api/status") {
      await route.fulfill({ json: { phase: "running", check_ok: true, blueprint: "unitree-go2-ar", playback } });
    } else if (path === "/api/launcher-preferences") {
      await route.fulfill({ json: { go2_source: "simulated", replay: "/tmp/saved.db" } });
    } else if (path === "/api/robot-profiles") {
      await route.fulfill({ json: { profiles: [{ id: "go2", name: "Go2", robot: "unitree_go2", settings: { mounts: [] } }] } });
    } else if (path === "/api/replay/inspect") {
      await route.fulfill({ json: { streams: {}, candidates: {}, needs_selection: false } });
    } else {
      await route.fulfill({ json: {} });
    }
  });
  await page.goto("http://launcher.test/");
  for (let visit = 0; visit < 2; visit++) {
    await expect(page.getByLabel("Robot source", { exact: true })).toHaveValue("simulated");
    await expect(page.getByLabel("Recording", { exact: true })).toHaveValue("/tmp/saved.db");
    await expect(page.getByLabel("Recording position")).toBeVisible();
    await expect(page.locator("#replayTime")).toHaveText("00:12 / 01:00");
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
    if (visit === 0) await page.reload();
  }
});
