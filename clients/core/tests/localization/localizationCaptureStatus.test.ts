import { describe, expect, it } from "vitest";
import { localizationCaptureStatus } from "../../src/presentation/ControlPanelPresentation";
import type { ARModuleSessionState } from "../../src/websocket/ARModuleSession";

function view(overrides: Partial<ARModuleSessionState> = {}): ARModuleSessionState {
  return {
    connection: "disconnected",
    hasTrackingOrigin: false,
    hello: null,
    state: null,
    pose: null,
    nav_goal: null,
    lidar: null,
    capabilities: null,
    nav: null,
    agentMessage: null,
    lastError: null,
    ...overrides,
  };
}

describe("localizationCaptureStatus", () => {
  it("gives mapped-room guidance for VPS frames instead of asking for a marker", () => {
    const session = view({ connection: "ready", capabilities: {
      localization: { available: true, reason: null },
    } as ARModuleSessionState["capabilities"] });
    expect(localizationCaptureStatus(session, { phase: "capturing", lastError: null,
      purpose: "headset" }).text).toBe("Scanning .\nLook around the mapped room");
  });
  it("asks for the marker while capturing fiducial frames and reports when the batch is being checked", () => {
    const session = view({ connection: "ready", capabilities: {
      localization: { available: true, reason: null },
    } as ARModuleSessionState["capabilities"] });
    expect(localizationCaptureStatus(session, { phase: "capturing", purpose: "robot", lastError: null }).text)
      .toBe("Scanning .\nLook at the marker");
    expect(localizationCaptureStatus(session, { phase: "awaiting_result", purpose: "robot", lastError: null }).text)
      .toBe("Checking the capture…");
  });

  it("animates one, two, three dots and shows runtime scans despite an existing origin", () => {
    const session = view({ connection: "ready", hasTrackingOrigin: true, capabilities: {
      localization: { available: true, reason: null },
    } as ARModuleSessionState["capabilities"] });
    const episode = { phase: "capturing" as const, lastError: null };
    expect([0, 0.45, 0.85, 1.25].map((t) => localizationCaptureStatus(session, episode, t).text))
      .toEqual(["Scanning .\nLook at the marker", "Scanning ..\nLook at the marker", "Scanning ...\nLook at the marker", "Scanning .\nLook at the marker"]);
  });

  it("returns portable tones", () => {
    expect(localizationCaptureStatus(view(), { phase: "idle", lastError: null }).color).toBe("muted");
    expect(
      localizationCaptureStatus(
        view({
          connection: "ready",
          hasTrackingOrigin: true,
          capabilities: {
            manipulation: { available: false, reason: "No arm" },
            object_detection: { available: false, reason: "No detector" },
            lidar: { available: true, reason: null },
            navigation: {
              available: true,
              reason: null,
              nav_goal: { preview: false, available: true, reason: null },
              nav_joystick: { available: true, reason: null },
              nav_map: { available: false, reason: "Map unavailable" },
            },
            localization: { available: true, reason: null },
            estop: { available: true, reason: null },
            agent: { available: true, reason: null },
          },
        }),
        { phase: "idle", lastError: null },
      ).color,
    ).toBe("success");
  });
});
