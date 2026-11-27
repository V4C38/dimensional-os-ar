import { afterEach, expect, it, vi } from "vitest";
import { NavigationMapController } from "DimOSARClient.lspkg/Scripts/DimOSARClient/navigation/NavigationMapProjection";
import type { NavigationMapSnapshot } from "DimOSARClient.lspkg/Scripts/DimOSARClient/ClientContracts";

vi.mock("../../Assets/Scripts/DimOSSpecsClient/presentation/WorldMeshRenderer", () => {
  const shape = () => ({ positions: [0, 0, 0], indices: [0, 0, 0], normals: [0, 1, 0] });
  class Renderer {
    object = { enabled: true, getTransform: () => ({ setLocalPosition() {}, setLocalRotation() {}, setLocalScale() {} }) };
    material = { mainPass: {} };
    triangles() { this.object.enabled = true; }
    segments() { this.object.enabled = true; }
    upload(_vertices: number[], indices: number[]) { this.object.enabled = indices.length > 0; }
    hide() { this.object.enabled = false; }
    setColor() {}
  }
  return { WorldMeshRenderer: Renderer, AdaptiveStrokeRenderer: Renderer, circleMesh: shape, sphereMesh: shape, strokeMesh2D: shape };
});
vi.mock("../mocks/UIKit.ts", () => ({ COLOR_WHITE: {}, createText: () => {
  const object = { enabled: true, getTransform: () => ({ setLocalPosition() {}, setLocalRotation() {} }) };
  return { text: "", getSceneObject: () => object };
} }));
import { SpecsNavigationMapView } from "../../Assets/Scripts/DimOSSpecsClient/navigation/SpecsNavigationMapView";

afterEach(() => { vi.unstubAllGlobals(); delete (quat as any).angleAxis; });
it("uploads a changed grid once and performs no map work while hidden or unchanged", () => {
  const upload = vi.fn(), scene = { createSceneObject: () => ({ enabled: true, setParent() {}, destroy() {},
    getTransform: () => ({ setLocalPosition() {}, setLocalRotation() {}, setLocalScale() {} }) }) };
  vi.stubGlobal("global", { scene });
  vi.stubGlobal("HorizontalAlignment", { Center: 0 });
  vi.stubGlobal("Rect", { create: () => ({}) });
  vi.stubGlobal("TextureFormat", { RGBA8Unorm: 0 });
  vi.stubGlobal("ProceduralTextureProvider", { createWithFormat: () => ({ control: { setPixels: upload } }) });
  (quat as any).angleAxis = () => quat.quatIdentity();
  const snapshot: NavigationMapSnapshot = { subscription_id: "a", sequence: 1, snapshot_sequence: 1,
    odom_reference_id: "odom", shared_frame_id: "shared", map_odom_rotation: [0, 0, 0, 1], source_generation: 1,
    origin: [-2, -2], resolution: 1, width: 4, height: 4, robot: [0, 0, 0], target: null,
    cells: { length: 16, costAt: () => 0, copyDisplayBytes: dst => dst.fill(1) }, heights: [], route: [] };
  const view = new SpecsNavigationMapView({} as SceneObject), viewport = new NavigationMapController();
  const rim = vi.spyOn((view as any).rim, "triangles"), handle = vi.spyOn((view as any).resizeLeft, "triangles");
  view.setVisible(false); view.draw(snapshot, viewport, .22, null);
  expect(upload).not.toHaveBeenCalled(); expect(view.diagnostics().geometryUpdates).toBe(0);
  view.setVisible(true); view.draw(snapshot, viewport, .22, null); view.draw(snapshot, viewport, .22, null);
  expect(upload).toHaveBeenCalledOnce(); expect(view.diagnostics().geometryUpdates).toBe(1);
  expect((view as any).ghost.object.enabled).toBe(false);
  expect(view.diagnostics().updateSamples).toBe(1);
  expect(view.diagnostics().textureBytes).toBe(6 * 6 * 4);
  expect(rim).toHaveBeenCalledTimes(1); expect(handle).toHaveBeenCalledTimes(1);
  const disc = vi.spyOn((view as any).disc, "triangles"), route = vi.spyOn((view as any).route, "segments");
  view.draw({ ...snapshot, sequence: 2, robot: [0, 0, 1] }, viewport, .22, null);
  expect(disc).not.toHaveBeenCalled(); expect(route).not.toHaveBeenCalled();
  expect(upload).toHaveBeenCalledOnce();
  expect(rim).toHaveBeenCalledTimes(1); expect(handle).toHaveBeenCalledTimes(1);
  view.draw({ ...snapshot, route: [[0, 0, 2, 0]] }, viewport, .22, null);
  const [segments, width, , , , , , opacities] = route.mock.calls.at(-1)! as any[];
  expect(width).toBe(0.15);
  expect((view as any).route.minimumPixels).toBe(1);
  expect(opacities[0]).toBe(0);
  expect(opacities.at(-1)).toBeCloseTo(0);
  expect(Math.max(...opacities)).toBe(1);
  expect(segments.length).toBeGreaterThan(2);
  viewport.panTo([1, 0]); view.draw(snapshot, viewport, .22, null);
  expect(upload).toHaveBeenCalledOnce(); expect(view.diagnostics().geometryUpdates).toBe(4);
  expect(view.diagnostics().updateSamples).toBe(4);
  expect(rim).toHaveBeenCalledTimes(1); expect(handle).toHaveBeenCalledTimes(1);
  view.draw(snapshot, viewport, .24, null);
  expect(rim).toHaveBeenCalledTimes(2); expect(handle).toHaveBeenCalledTimes(2);
  view.loading(.24); view.draw(snapshot, viewport, .24, null);
  expect(rim).toHaveBeenCalledTimes(4); expect(handle).toHaveBeenCalledTimes(2);
  view.setVisible(false); view.draw({ ...snapshot, cells: { ...snapshot.cells } }, viewport, .22, null);
  expect(upload).toHaveBeenCalledTimes(2); view.dispose();
});
