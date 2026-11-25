import { describe, expect, it, vi } from "vitest";
import { SpecsMapGesture } from "../../Assets/Scripts/DimOSSpecsClient/navigation/SpecsMapGesture";
import type { NavigationMapSnapshot } from "DimOSARClient.lspkg/Scripts/DimOSARClient/ClientContracts";

function fixture() {
  const ports = { viewport: vi.fn(), submit: vi.fn(), cancelPending: vi.fn() };
  const gesture = new SpecsMapGesture(ports);
  const snapshot: NavigationMapSnapshot = { subscription_id: "a", sequence: 1, snapshot_sequence: 1,
    odom_reference_id: "odom", shared_frame_id: "shared", map_odom_rotation: [0, 0, 0, 1], source_generation: 1,
    origin: [-10, -10], resolution: 1, width: 20, height: 20, robot: [0, 0, 0], target: null,
    cells: { length: 400, costAt: () => 0, copyDisplayBytes: () => {} }, heights: [], route: [] };
  gesture.open(); gesture.update(snapshot, true, true);
  return { ports, gesture, snapshot };
}

describe("Specs map gestures", () => {
  it("submits a face tap but not a sphere tap or a cancelled gesture", () => {
    const { ports, gesture: g } = fixture();
    g.begin("right", "face", [0, 0], 1, 0, true); g.release("right", [0.005, 0], 1.1, 0);
    expect(ports.submit).toHaveBeenCalledOnce();
    g.begin("right", "sphere", [0, 0], 2, 0); g.release("right", [0, 0], 2.1, 0);
    g.begin("right", "face", [0, 0], 3, 0); g.abort(true); g.release("right", [0, 0], 3.1, 0);
    expect(ports.submit).toHaveBeenCalledOnce(); expect(ports.cancelPending).toHaveBeenCalledOnce();
  });
  it("consumes a two-hand gesture when either hand is released", () => {
    const { ports, gesture: g } = fixture();
    g.begin("right", "face", [0, 0], 1, 0);
    expect(g.beginScale("left", [-0.04, 0], [0.04, 0])).toBe(true);
    g.holdScale([-0.08, 0], [0.08, 0]); expect(g.viewport.radiusM).toBe(2);
    g.endScale("left", [0, 0]); g.release("left", [0, 0], 1.2, 0);
    expect(ports.submit).not.toHaveBeenCalled();
  });
  it("retires a held gesture on replay generation changes and motion loss", () => {
    const { ports, gesture: g, snapshot } = fixture();
    g.begin("right", "face", [0, 0], 1, 0);
    g.update({ ...snapshot, source_generation: 2 }, true, true, true);
    g.release("right", [0, 0], 1.1, 0);
    expect(ports.cancelPending).toHaveBeenCalledOnce(); expect(ports.submit).not.toHaveBeenCalled();
    g.begin("right", "face", [0, 0], 2, 0); g.update(snapshot, false, true, true);
    g.release("right", [0, 0], 2.1, 0); expect(ports.submit).not.toHaveBeenCalled();
  });
  it("keeps replay maps interactive without sending motion", () => {
    const { ports, gesture: g, snapshot } = fixture(); g.update(snapshot, false, true, false);
    g.begin("right", "face", [0, 0], 1, 0); g.hold("right", [0.03, 0], 1.3, 0.1);
    g.release("right", [0.03, 0], 1.4, 0);
    expect(g.viewport.followingRobot).toBe(false); expect(ports.submit).not.toHaveBeenCalled();
  });
});

it("converts bounded occupancy once per immutable grid", async () => {
  const { SpecsMapPixels } = await import("../../Assets/Scripts/DimOSSpecsClient/navigation/SpecsMapGesture");
  const { snapshot } = fixture();
  const copy = vi.fn((buffer: Uint8Array) => { buffer[0] = 0; buffer[1] = 1; buffer[2] = 101; });
  const pixels = new SpecsMapPixels();
  const grid = { ...snapshot, cells: { ...snapshot.cells, copyDisplayBytes: copy } };
  const output = pixels.update(grid)!;
  expect([...output.slice(0, 12)]).toEqual([36, 36, 36, 255, 54, 64, 66, 255, 209, 194, 171, 255]);
  expect(pixels.update(grid)).toBeNull(); expect(copy).toHaveBeenCalledOnce();
  pixels.clear(); expect(pixels.update(grid)).not.toBeNull();
  expect(() => pixels.update({ ...grid, width: 241 })).toThrow();
});

it("projects robot, target, clipped route and bounded height points into the dock", async () => {
  const { projectSpecsMap } = await import("../../Assets/Scripts/DimOSSpecsClient/navigation/SpecsMapGesture");
  const { gesture, snapshot } = fixture();
  const frame = projectSpecsMap({ ...snapshot, robot: [8, 0, 0], target: [1, 0],
    route: [[-10, 0, 10, 0]], heights: [[0, 0, 1.5], [9, 9, 1]] }, gesture.viewport, 0.22);
  expect(frame.robotVisible).toBe(false);
  expect(frame.recenter?.[0]).toBeCloseTo(0.11 * 0.89);
  expect(frame.target?.[0]).toBeCloseTo(0.0275);
  expect(frame.route).toHaveLength(1);
  expect(frame.route[0][0]).toBeCloseTo(-0.11);
  expect(frame.route[0][2]).toBeCloseTo(0.11);
  expect(frame.heights).toHaveLength(1);
  expect(frame.heights[0].hue).toBeCloseTo(0);
  expect(frame.scaleM).toBe(2);
});

it("subscribes only while open and ignores retired goal feedback", async () => {
  const { SpecsMapSession } = await import("../../Assets/Scripts/DimOSSpecsClient/navigation/SpecsMapGesture");
  const { snapshot } = fixture();
  let complete!: () => void;
  const session = { setNavigationMapViewport: vi.fn(), cancelPendingNavigationMapGoal: vi.fn(),
    requestNavigationCancellation: vi.fn(async () => {}),
    submitNavigationMapGoal: vi.fn(() => new Promise<void>(resolve => { complete = resolve; })) };
  const feedback = vi.fn(), map = new SpecsMapSession(session, feedback);
  map.update(true, snapshot, true, true);
  map.update(true, snapshot, true, true);
  expect(session.setNavigationMapViewport).toHaveBeenCalledTimes(1);
  map.gesture.begin("hand", "face", [0, 0], 1, 0, true); map.gesture.release("hand", [0, 0], 1.1, 0);
  expect(session.submitNavigationMapGoal).toHaveBeenCalledOnce();
  map.update(false, null, false, true);
  expect(session.setNavigationMapViewport).toHaveBeenLastCalledWith(null);
  complete(); await Promise.resolve();
  expect(feedback).toHaveBeenCalledTimes(1);
  map.dispose(); expect(session.setNavigationMapViewport).toHaveBeenCalledTimes(2);
});

it("does not publish an old goal result after a replay seek", async () => {
  const { SpecsMapSession } = await import("../../Assets/Scripts/DimOSSpecsClient/navigation/SpecsMapGesture");
  const { snapshot } = fixture(); let complete!: () => void;
  const session = { setNavigationMapViewport: vi.fn(), cancelPendingNavigationMapGoal: vi.fn(),
    requestNavigationCancellation: vi.fn(async () => {}),
    submitNavigationMapGoal: vi.fn(() => new Promise<void>(resolve => { complete = resolve; })) };
  const feedback = vi.fn(), map = new SpecsMapSession(session, feedback);
  map.update(true, snapshot, true, true);
  map.gesture.begin("hand", "face", [0, 0], 1, 0, true); map.gesture.release("hand", [0, 0], 1.1, 0);
  map.update(true, { ...snapshot, source_generation: 2 }, true, true);
  complete(); await Promise.resolve();
  expect(feedback).toHaveBeenCalledTimes(1);
  expect(session.cancelPendingNavigationMapGoal).toHaveBeenCalledOnce();
});

it("preserves a panned viewport across a seek but recenters when the odometry reference changes", () => {
  const { gesture, snapshot } = fixture();
  gesture.viewport.panTo([2, 1]);
  gesture.update(null, false, true);
  expect(gesture.viewport.followingRobot).toBe(false);
  gesture.update({ ...snapshot, source_generation: 2 }, false, true);
  expect(gesture.viewport.centerM).toEqual([2, 1]);
  gesture.update(null, false, true);
  gesture.update({ ...snapshot, odom_reference_id: "new-odom", source_generation: 3, robot: [4, 5, 0] }, false, true);
  expect(gesture.viewport.followingRobot).toBe(true);
  expect(gesture.viewport.centerM).toEqual([4, 5]);
});
