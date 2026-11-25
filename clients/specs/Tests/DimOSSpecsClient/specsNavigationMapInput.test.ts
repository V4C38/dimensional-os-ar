import { afterEach, expect, it, vi } from "vitest";
import { SpecsNavigationMapInput } from "../../Assets/Scripts/DimOSSpecsClient/navigation/SpecsNavigationMapInput";
import { SpecsMapGesture } from "../../Assets/Scripts/DimOSSpecsClient/navigation/SpecsMapGesture";
import type { NavigationMapSnapshot } from "DimOSARClient.lspkg/Scripts/DimOSARClient/ClientContracts";
import { InteractorInputType, InteractorTriggerType, TargetingMode } from "../mocks/Interactor";

function setup() {
  const targets = new Map<string, any>();
  const root: any = { isEnabledInHierarchy: true, getTransform: () => ({ getWorldTransform: () => ({ inverse: () => ({ multiplyPoint: (value: vec3) => value }) }) }) };
  const scene = { createSceneObject: (name: string) => {
    const object: any = { name, enabled: true, setParent: vi.fn(), destroy: vi.fn(),
      getTransform: () => ({ setLocalPosition: vi.fn(), getWorldTransform: () => ({ inverse: () => ({ multiplyPoint: (value: vec3) => value }) }) }),
      createComponent: (type: string) => type === "Physics.ColliderComponent" ? { shape: {} } :
        { onTriggerCanceled: { add: (handler: (event: any) => void) => { object.cancel = handler; } } } };
    targets.set(name, object); return object;
  } };
  vi.stubGlobal("global", { scene, deviceInfoSystem: { isEditor: () => false } });
  vi.stubGlobal("Shape", { createSphereShape: () => ({}), createCylinderShape: () => ({}) });
  const ports = { viewport: vi.fn(), submit: vi.fn(), cancelPending: vi.fn(), cancelRoute: vi.fn() };
  const gesture = new SpecsMapGesture(ports);
  const snapshot: NavigationMapSnapshot = { subscription_id: "a", sequence: 1, snapshot_sequence: 1,
    odom_reference_id: "odom", shared_frame_id: "shared", map_odom_rotation: [0, 0, 0, 1], source_generation: 1,
    origin: [-10, -10], resolution: 1, width: 20, height: 20, robot: [0, 0, 0], target: null,
    cells: { length: 400, costAt: () => 0, copyDisplayBytes: () => {} }, heights: [], route: [] };
  gesture.open(); gesture.update(snapshot, true, true, true);
  const hands: any[] = [];
  const dataRoot: any = { ...root };
  const input = new SpecsNavigationMapInput(root, dataRoot, gesture, () => hands);
  const hand = (id: number, target: string) => ({ inputType: id, startPoint: new vec3(0, 10, 0), direction: new vec3(0, -1, 0),
    isActive: () => true, isTriggering: false, targetHitPosition: null, currentTrigger: InteractorTriggerType.Poke,
    activeTargetingMode: TargetingMode.Poke,
    currentInteractable: { getSceneObject: () => targets.get(target) } });
  return { input, gesture, ports, root, dataRoot, targets, hands, hand, snapshot };
}
afterEach(() => vi.unstubAllGlobals());

it("captures a SIK face press and sends exactly one goal on release", () => {
  const h = setup(), hand = h.hand(1, "NavigationMapFaceHit"); h.hands.push(hand); h.input.layout(h.snapshot, true);
  expect(h.input.isCapturingOrPressed()).toBe(false);
  h.input.tick(0, 0.016, 0); hand.isTriggering = true; h.input.tick(1, 0.016, 0);
  expect(h.gesture.active).toBe(true);
  hand.currentInteractable = null; hand.isTriggering = false; h.input.tick(1.1, 0.016, 0);
  expect(h.ports.submit).toHaveBeenCalledOnce(); expect(h.gesture.active).toBe(false);
});

it("uses the last finger contact when SIK clears poke targeting on release", () => {
  const h = setup(), hand = h.hand(InteractorInputType.LeftHand, "NavigationMapFaceHit"); h.hands.push(hand);
  hand.targetHitPosition = new vec3(4, 0, 0); hand.isTriggering = true; h.input.tick(1, 0.016, 0);
  hand.currentInteractable = null; hand.targetHitPosition = null; hand.activeTargetingMode = TargetingMode.Indirect;
  hand.startPoint = new vec3(0, 10, 0); hand.isTriggering = false; h.input.tick(1.1, 0.016, 0);
  expect(h.ports.submit).toHaveBeenCalledOnce();
  expect(h.ports.submit.mock.calls[0][0][0]).toBeCloseTo(4 * 4 / 11);
});

it("finishes a poke when its active targeting provider disappears on release", () => {
  const h = setup(), hand = h.hand(InteractorInputType.LeftHand, "NavigationMapFaceHit"); h.hands.push(hand);
  hand.targetHitPosition = new vec3(4, 0, 0); hand.isTriggering = true; h.input.tick(1, 0.016, 0);
  hand.currentInteractable = null; hand.startPoint = null; hand.direction = null; hand.isTriggering = false;
  h.input.tick(1.1, 0.016, 0);
  expect(h.ports.submit).toHaveBeenCalledOnce();
});

it("does not send a face-tap goal for cursor or pinch input", () => {
  for (const [id, trigger, mode] of [
    [InteractorInputType.Mouse, InteractorTriggerType.Poke, TargetingMode.Poke],
    [InteractorInputType.LeftHand, InteractorTriggerType.Pinch, TargetingMode.Indirect],
    [InteractorInputType.RightHand, InteractorTriggerType.Pinch, TargetingMode.Direct],
  ]) {
    const h = setup(), hand = h.hand(id, "NavigationMapFaceHit"); h.hands.push(hand);
    hand.currentTrigger = trigger; hand.activeTargetingMode = mode;
    hand.isTriggering = true; h.input.tick(1, 0.016, 0);
    hand.isTriggering = false; h.input.tick(1.1, 0.016, 0);
    expect(h.ports.submit).not.toHaveBeenCalled();
  }
});

it("still pans with a pinch and submits a dragged robot marker", () => {
  const h = setup(), hand = h.hand(InteractorInputType.LeftHand, "NavigationMapFaceHit");
  hand.currentTrigger = InteractorTriggerType.Pinch; hand.activeTargetingMode = TargetingMode.Indirect; h.hands.push(hand);
  hand.isTriggering = true; h.input.tick(1, 0.016, 0);
  hand.startPoint = new vec3(3, 10, 0); h.input.tick(1.3, 0.016, 0);
  hand.isTriggering = false; h.input.tick(1.4, 0.016, 0);
  expect(h.gesture.viewport.followingRobot).toBe(false); expect(h.ports.submit).not.toHaveBeenCalled();
  hand.currentInteractable = { getSceneObject: () => h.targets.get("NavigationMapRobotHit") };
  hand.startPoint = new vec3(0, 10, 0); hand.isTriggering = true; h.input.tick(2, 0.016, 0);
  hand.startPoint = new vec3(3, 10, 0); h.input.tick(2.3, 0.016, 0);
  hand.isTriggering = false; h.input.tick(2.4, 0.016, 0);
  expect(h.ports.submit).toHaveBeenCalledOnce();
});

it("reports an active map press before the gesture poll captures it", () => {
  const h = setup(), hand = h.hand(1, "NavigationMapFaceHit"); h.hands.push(hand);
  hand.isTriggering = true;
  expect(h.gesture.active).toBe(false); expect(h.input.isCapturingOrPressed()).toBe(true);
  h.root.isEnabledInHierarchy = false; expect(h.input.isCapturingOrPressed()).toBe(false);
});

it("cancels a captured SIK gesture when tracking disappears or the map closes", () => {
  const h = setup(), hand = h.hand(1, "NavigationMapFaceHit"); h.hands.push(hand);
  hand.isTriggering = true; h.input.tick(1, 0.016, 0); h.hands.length = 0; h.input.tick(1.1, 0.016, 0);
  expect(h.ports.cancelPending).toHaveBeenCalledOnce(); expect(h.ports.submit).not.toHaveBeenCalled();
  h.hands.push(hand); h.input.tick(1.2, 0.016, 0); expect(h.gesture.active).toBe(false); h.hands.length = 0;
  h.hands.push(hand); hand.isTriggering = false; h.input.tick(2, 0.016, 0);
  hand.isTriggering = true; h.input.tick(2.1, 0.016, 0); h.root.isEnabledInHierarchy = false; h.input.tick(2.2, 0.016, 0);
  expect(h.ports.cancelPending).toHaveBeenCalledTimes(2); expect(h.ports.submit).not.toHaveBeenCalled();
});

it("transfers a two-hand zoom without emitting a goal on either release", () => {
  const h = setup(), a = h.hand(1, "NavigationMapFaceHit"), b = h.hand(2, "NavigationMapFaceHit");
  a.startPoint = new vec3(-4, 10, 0); b.startPoint = new vec3(4, 10, 0); h.hands.push(a, b);
  a.isTriggering = true; h.input.tick(1, 0.016, 0);
  b.isTriggering = true; h.input.tick(1.05, 0.016, 0);
  expect(h.gesture.secondOwner).toBe("2");
  b.startPoint = new vec3(8, 10, 0); h.input.tick(1.1, 0.016, 0);
  expect(h.gesture.viewport.radiusM).toBeLessThan(4);
  a.isTriggering = false; h.input.tick(1.15, 0.016, 0);
  b.isTriggering = false; h.input.tick(1.2, 0.016, 0);
  expect(h.ports.submit).not.toHaveBeenCalled(); expect(h.gesture.active).toBe(false);
});

it("measures two-hand scaling in the fixed dock frame even as the map rotates", () => {
  const h = setup(), a = h.hand(1, "NavigationMapFaceHit"), b = h.hand(2, "NavigationMapFaceHit");
  h.hands.push(a, b);
  const point = vi.spyOn(h.input as any, "point").mockImplementation((hand: any, frame: unknown) =>
    [hand.inputType * (frame === h.root ? 0.02 : 0.04), 0]);
  const beginScale = vi.spyOn(h.gesture, "beginScale"), holdScale = vi.spyOn(h.gesture, "holdScale");
  a.isTriggering = true; h.input.tick(1, 0.016, 0);
  b.isTriggering = true; h.input.tick(1.1, 0.016, 0);
  expect(beginScale).toHaveBeenCalledWith("2", [0.02, 0], [0.04, 0]);
  expect(holdScale).toHaveBeenLastCalledWith([0.02, 0], [0.04, 0]);
  point.mockRestore();
});

it("ignores a ray entering the map from beneath", () => {
  const h = setup(), hand = h.hand(1, "NavigationMapFaceHit");
  hand.startPoint = new vec3(0, -3, 0); hand.direction = new vec3(0, 1, 0); hand.isTriggering = true;
  h.hands.push(hand); h.input.tick(1, 0.016, 0);
  expect(h.gesture.active).toBe(false); expect(h.ports.submit).not.toHaveBeenCalled();
});

it("cancels a SIK trigger cancellation even if it is followed by a release", () => {
  const h = setup(), hand = h.hand(1, "NavigationMapFaceHit"); h.hands.push(hand);
  hand.isTriggering = true; h.input.tick(1, 0.016, 0);
  h.targets.get("NavigationMapFaceHit").cancel({ interactor: { inputType: 1 } });
  hand.isTriggering = false; h.input.tick(1.1, 0.016, 0);
  expect(h.ports.cancelPending).toHaveBeenCalledOnce(); expect(h.ports.submit).not.toHaveBeenCalled();
});

it("does not capture a face hit when the projected ray misses the circular map", () => {
  const h = setup(), hand = h.hand(1, "NavigationMapFaceHit");
  hand.startPoint = new vec3(12, 10, 0); hand.isTriggering = true; h.hands.push(hand);
  h.input.tick(1, 0.016, 0);
  expect(h.gesture.active).toBe(false); expect(h.ports.submit).not.toHaveBeenCalled();
});
