import { InteractionManager } from "SpectaclesInteractionKit.lspkg/Core/InteractionManager/InteractionManager";
import { InteractorInputType, InteractorTriggerType, TargetingMode, type Interactor } from "SpectaclesInteractionKit.lspkg/Core/Interactor/Interactor";
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import type { NavigationMapSnapshot } from "DimOSARClient.lspkg/Scripts/DimOSARClient/ClientContracts";
import { type MapRegion, SpecsMapGesture } from "./SpecsMapGesture";

type MapHand = Pick<Interactor, "inputType" | "startPoint" | "direction" | "isActive" | "currentInteractable" | "isTriggering" | "targetHitPosition" | "currentTrigger" | "activeTargetingMode">;
type Target = { object: SceneObject; collider: ColliderComponent; region: MapRegion };

/** Native SIK targeting with one captured gesture and an optional second hand. */
export class SpecsNavigationMapInput {
  private readonly targets: Target[] = [];
  private readonly hands = new Map<string, MapHand>();
  private readonly held = new Set<string>();
  private readonly pokePoints = new Map<string, readonly [number, number]>();
  private readonly cancelledUntilRelease = new Set<string>();
  private lastSnapshot: NavigationMapSnapshot | null = null;
  private lastCenter: readonly [number, number] | null = null;
  private lastRadius = 0;
  private lastDiameter = 0;
  private disposed = false;
  constructor(private readonly root: SceneObject, private readonly dataRoot: SceneObject,
    private readonly gesture: SpecsMapGesture, private readonly interactors?: () => readonly MapHand[]) {
    this.add(dataRoot, "NavigationMapFaceHit", "face", "cylinder");
    this.add(dataRoot, "NavigationMapRobotHit", "sphere", "sphere");
    this.add(root, "NavigationMapResizeLeftHit", "resize", "sphere");
    this.add(root, "NavigationMapResizeRightHit", "resize", "sphere");
    this.add(root, "NavigationMapCompassHit", "compass", "sphere");
    this.add(root, "NavigationMapFollowHit", "pin", "sphere");
    this.add(dataRoot, "NavigationMapRecenterHit", "recenter", "sphere");
  }
  private add(parent: SceneObject, name: string, region: MapRegion, shape: "cylinder" | "sphere"): void {
    const object = global.scene.createSceneObject(name); object.setParent(parent);
    const collider = object.createComponent("Physics.ColliderComponent") as ColliderComponent;
    collider.shape = shape === "sphere" ? Shape.createSphereShape() : Shape.createCylinderShape();
    const interactable = object.createComponent(Interactable.getTypeName()) as Interactable;
    interactable.onTriggerCanceled.add(event => {
      const id = String(event.interactor.inputType);
      if (this.gesture.owner === id || this.gesture.secondOwner === id) {
        this.cancelledUntilRelease.add(id); this.gesture.abort(true);
      }
    });
    this.targets.push({ object, collider, region });
  }
  layout(snapshot: NavigationMapSnapshot | null): void {
    const center = this.gesture.viewport.centerM, coverage = this.gesture.viewport.radiusM, diameter = this.gesture.diameterM;
    if (snapshot === this.lastSnapshot && center === this.lastCenter && coverage === this.lastRadius &&
        diameter === this.lastDiameter) return;
    this.lastSnapshot = snapshot; this.lastCenter = center; this.lastRadius = coverage;
    this.lastDiameter = diameter;
    const radius = this.gesture.diameterM * 50, [face, robot, left, right, compass, pin, recenter] = this.targets;
    const cylinder = face.collider.shape as CylinderShape; cylinder.radius = radius; cylinder.length = 0.3;
    const x = snapshot ? (snapshot.robot[0] - center[0]) / this.gesture.metersPerUnit : 0;
    const y = snapshot ? (snapshot.robot[1] - center[1]) / this.gesture.metersPerUnit : 0;
    const distance = Math.hypot(x, y), visible = !!snapshot && distance <= diameter / 2;
    robot.object.enabled = visible;
    if (visible) robot.object.getTransform().setLocalPosition(new vec3(x * 100, 4, -y * 100));
    for (const [target, x, y, z, size] of [
      [left, -radius * 1.08, 0, 0, 1.5], [right, radius * 1.08, 0, 0, 1.5],
      [compass, -1.3, 0.4, radius + 2, 1.3], [pin, 1.3, 0.4, radius + 2, 1.3],
    ] as [Target, number, number, number, number][]) {
      target.object.getTransform().setLocalPosition(new vec3(x, y, z)); (target.collider.shape as SphereShape).radius = size;
    }
    (robot.collider.shape as SphereShape).radius = 1.6;
    recenter.object.enabled = !!snapshot && !visible;
    if (snapshot && !visible && distance > 0) recenter.object.getTransform().setLocalPosition(new vec3(x / distance * radius * 0.89, 1, -y / distance * radius * 0.89));
    (recenter.collider.shape as SphereShape).radius = 1.5;
  }
  owns(object: SceneObject | null): boolean {
    return !!object && this.targets.some(target => target.object === object);
  }
  ownsFace(object: SceneObject): boolean { return this.targets[0].object === object; }
  ownsControl(object: SceneObject): boolean { return this.targets.slice(1).some(target => target.object === object && target.object.enabled); }
  isCapturingOrPressed(): boolean {
    if (this.gesture.active) return true;
    if (this.disposed || !this.root.isEnabledInHierarchy) return false;
    const mask = InteractorInputType.BothHands | (global.deviceInfoSystem.isEditor() ? InteractorInputType.Mouse : 0);
    return (this.interactors?.() ?? InteractionManager.getInstance().getInteractorsByType(mask)).some(hand =>
      hand.isActive() && hand.isTriggering && this.owns(hand.currentInteractable?.getSceneObject() ?? null));
  }
  tick(time: number, dt: number, rotation: number): void {
    if (this.disposed || !this.root.isEnabledInHierarchy) { this.reset(); return; }
    const mask = InteractorInputType.BothHands | (global.deviceInfoSystem.isEditor() ? InteractorInputType.Mouse : 0);
    const hands = this.interactors?.() ?? InteractionManager.getInstance().getInteractorsByType(mask);
    const seen = new Set<string>();
    for (const hand of hands) {
      const id = String(hand.inputType); seen.add(id); this.hands.set(id, hand);
      const previous = this.held.has(id), held = hand.isTriggering;
      if (hand.isActive() && !held && previous && (!hand.startPoint || !hand.direction) &&
          this.gesture.owner === id && !this.gesture.secondOwner && this.pokePoints.has(id)) {
        this.gesture.release(id, this.pokePoints.get(id)!, time, rotation);
        this.held.delete(id); this.pokePoints.delete(id); this.cancelledUntilRelease.delete(id); continue;
      }
      if (!hand.isActive() || !hand.startPoint || !hand.direction) {
        if (previous || held) this.cancelledUntilRelease.add(id);
        if (this.gesture.owner === id || this.gesture.secondOwner === id) this.gesture.abort(true);
        this.held.delete(id); this.pokePoints.delete(id); continue;
      }
      const object = hand.currentInteractable?.getSceneObject() ?? null;
      const target = this.targets.find(item => item.object === object && item.object.enabled);
      const region = this.gesture.owner === id ? this.gesture.region : target?.region;
      const point = this.point(hand, region === "resize" || region === "compass" || region === "pin" ? this.root : this.dataRoot);
      if (!held) this.cancelledUntilRelease.delete(id);
      const insideFace = target?.region !== "face" || !!point && Math.hypot(...point) <= this.gesture.diameterM / 2;
      if (held && !previous && !this.cancelledUntilRelease.has(id) && target && point && insideFace) {
        const poke = (hand.inputType & InteractorInputType.BothHands) !== 0 &&
          hand.currentTrigger === InteractorTriggerType.Poke && hand.activeTargetingMode === TargetingMode.Poke;
        if (!this.gesture.active) {
          this.gesture.begin(id, target.region, point, time, rotation, poke);
          if (poke && target.region === "face") this.pokePoints.set(id, point);
        }
        else {
          const first = this.hands.get(this.gesture.owner ?? ""), firstPoint = first && this.point(first, this.root);
          const secondPoint = this.point(hand, this.root);
          if (firstPoint && secondPoint) this.gesture.beginScale(id, firstPoint, secondPoint);
        }
      }
      if (held && point && this.pokePoints.has(id) && hand.activeTargetingMode === TargetingMode.Poke)
        this.pokePoints.set(id, point);
      if (held && this.gesture.secondOwner) {
        const first = this.hands.get(this.gesture.owner ?? ""), second = this.hands.get(this.gesture.secondOwner);
        const a = first && this.point(first, this.root), b = second && this.point(second, this.root);
        if (a && b) this.gesture.holdScale(a, b);
      } else if (held && point && this.gesture.owner === id) this.gesture.hold(id, point, time, dt);
      if (!held && previous && (this.gesture.owner === id || this.gesture.secondOwner === id)) {
        if (this.gesture.secondOwner) {
          const remaining = this.gesture.owner === id ? this.gesture.secondOwner : this.gesture.owner;
          const handRemaining = remaining && this.hands.get(remaining), remainingPoint = handRemaining && this.point(handRemaining, this.dataRoot);
          if (remaining && remainingPoint) this.gesture.endScale(remaining, remainingPoint); else this.gesture.abort(true);
        } else {
          const releasePoint = this.pokePoints.get(id) ?? point;
          if (releasePoint) this.gesture.release(id, releasePoint, time, rotation); else this.gesture.abort(true);
        }
      }
      if (held) this.held.add(id); else { this.held.delete(id); this.pokePoints.delete(id); }
    }
    for (const id of this.held) if (!seen.has(id)) {
      this.cancelledUntilRelease.add(id);
      if (this.gesture.owner === id || this.gesture.secondOwner === id) this.gesture.abort(true);
      this.held.delete(id); this.hands.delete(id); this.pokePoints.delete(id);
    }
  }
  private point(hand: MapHand, frame: SceneObject): readonly [number, number] | null {
    if (!hand.startPoint || !hand.direction) return null;
    const inverse = frame.getTransform().getWorldTransform().inverse();
    const start = inverse.multiplyPoint(hand.startPoint), end = inverse.multiplyPoint(hand.startPoint.add(hand.direction));
    const direction = end.sub(start);
    if (hand.activeTargetingMode === TargetingMode.Poke && hand.targetHitPosition) {
      const hit = inverse.multiplyPoint(hand.targetHitPosition);
      return [hit.x / 100, -hit.z / 100];
    }
    if (start.y < -0.4) return null;
    if (direction.y >= -0.0001) {
      if (!hand.targetHitPosition) return null;
      const hit = inverse.multiplyPoint(hand.targetHitPosition);
      return hit.y >= -0.4 ? [hit.x / 100, -hit.z / 100] : null;
    }
    const t = -start.y / direction.y;
    if (!Number.isFinite(t) || t < 0) return null;
    const p = start.add(direction.uniformScale(t));
    return [p.x / 100, -p.z / 100];
  }
  reset(): void {
    for (const id of this.held) this.cancelledUntilRelease.add(id);
    if (this.gesture.active) this.gesture.abort(true);
    this.held.clear(); this.hands.clear(); this.pokePoints.clear();
  }
  dispose(): void { if (!this.disposed) { this.reset(); this.cancelledUntilRelease.clear(); this.disposed = true; for (const target of this.targets) target.object.destroy(); } }
}
