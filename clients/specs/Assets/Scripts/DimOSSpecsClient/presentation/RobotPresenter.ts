import type { ReadonlyFacts } from "DimOSARClient.lspkg/Scripts/DimOSARClient/ClientContracts";
import { type ClientTrackingOrigin as MutableClientTrackingOrigin } from "DimOSARClient.lspkg/Scripts/DimOSARClient/localization/ClientTracking";
import { getRobotActivityState, robotTitleText, projectRobotPose, robotFloorOffset, type RobotMarkerApplyInput } from "DimOSARClient.lspkg/Scripts/DimOSARClient/robot/RobotPresentation";
import type { ARModuleSessionState } from "DimOSARClient.lspkg/Scripts/DimOSARClient/websocket/ARModuleSession";
import type { Quat, RobotDescription, Vec3 } from "DimOSARClient.lspkg/Scripts/DimOSARClient/ClientContracts";
import { sessionLinkStatus } from "DimOSARClient.lspkg/Scripts/DimOSARClient/presentation/ControlPanelPresentation";
import { robotDeadzoneRadiusM } from "DimOSARClient.lspkg/Scripts/DimOSARClient/navigation/NavigationInteraction";
import { RuntimePoseSmoothing } from "../utilities/RuntimePoseSmoothing";

import { clientTrackingToSpecsPoint, clientTrackingToSpecsPose, yawRotationFromPlanarDirection } from "../utilities/SpecsCoordinates";

import { RobotWorldRenderer } from "./RobotWorldRenderer";
import { findChildRecursive } from "./UIKit";

type ClientTrackingOrigin = ReadonlyFacts<MutableClientTrackingOrigin>;
type RobotActivityVoice = { asrRunning: boolean; ttsPlaying: boolean };

export interface RobotMarkerApplyContext {
  debugEnabled: boolean;
}

const GO2_BASE_HEIGHT_M = 0.33;

export function robotFloorOffsetCm(robot: ReadonlyFacts<RobotDescription>): Vec3 {
  return clientTrackingToSpecsPoint([0, 0, -robot.base_height_m]);
}

export function robotDeadzoneRadiusCm(robot: ReadonlyFacts<RobotDescription>): number {
  return robotDeadzoneRadiusM(robot.footprint_m) * 100;
}

@component
export class RobotPresenter extends BaseScriptComponent {
  @input
  odometryRoot: SceneObject;

  private worldVisuals: RobotWorldRenderer | null = null;
  private onToggle: (() => void) | null = null;
  private eye: SceneObject | null = null;
  private canToggle: ((sourceId: string) => boolean) | null = null;
  private viewportHeight = 1024;
  bindSelection(onToggle: () => void, camera: SceneObject, canToggle?: (sourceId: string) => boolean): void {
    this.onToggle = onToggle; this.eye = camera; this.canToggle = canToggle ?? null;
  }
  setSelected(selected: boolean): void { this.worldVisuals?.setSelected(selected); }
  setHovered(hovered: boolean): void { this.worldVisuals?.setHovered(hovered); }
  ownsTarget(object: SceneObject): boolean { return this.worldVisuals?.ownsTarget(object) === true; }
  setNavigationFloor(visible: boolean, opacity: number): void { this.worldVisuals?.setFloorVisible(visible, opacity); }
  setViewportHeight(height: number): void { this.viewportHeight = height; }
  floorCircleBounds() {
    const p = this.floorPose()?.position, world = this.worldPosition();
    return p && world ? { center: [world.x, p.y + 1.5, world.z] as [number, number, number], radius: 6 } : undefined;
  }

  private readonly poseSmoothing = new RuntimePoseSmoothing();
  private origin: ClientTrackingOrigin | null = null;
  private placedOrigin: ClientTrackingOrigin | null = null;
  private robot: ReadonlyFacts<RobotDescription> | null = null;
  private presented = false;
  private referenceFloorHeight: number | null = null;
  setFloorHeight(height: number | null): void { this.referenceFloorHeight = height; }
  private motionRoot: SceneObject | null = null;
  private debugViewRoot: SceneObject | null = null;
  onAwake(): void {
    this.configureSceneRefs();
    this.reset();
    const updateEvent = this.createEvent("UpdateEvent");
    updateEvent.bind(() => this.tick(getDeltaTime()));
  }

  apply(input: RobotMarkerApplyInput, ctx: RobotMarkerApplyContext): void {
    this.origin = input.mode === "localizedOdom" ? input.origin : null;
    switch (input.mode) {
      case "hidden":
        this.applyHidden();
        return;
      case "lastSeen": {
        if (!this.motionRoot) return;
        this.poseSmoothing.reset();
        this.placedOrigin = null;
        const pose = clientTrackingToSpecsPose(input.sighting);
        this.motionRoot.getTransform().setWorldPosition(toVec3(pose.position));
        this.motionRoot.getTransform().setWorldRotation(toQuat(pose.orientation));
        this.robot = input.robot;
        this.worldVisuals?.setRobot(input.robot);
        this.worldVisuals?.setPickingEnabled(false);
        this.presented = true;
        this.getSceneObject().enabled = this.motionRoot.enabled = true;
        this.applyDebugViewVisibility(ctx.debugEnabled);
        return;
      }
      case "localizedOdom":
        this.applyLocalizedOdom(input, ctx);
        return;
    }
  }

  dispose(): void {
    this.reset(); this.worldVisuals?.dispose(); this.worldVisuals = null;
    this.onToggle = null; this.eye = null; this.canToggle = null;
  }

  reset(): void {
    this.origin = null;
    this.referenceFloorHeight = null;
    this.presented = false;
    this.placedOrigin = null;
    this.robot = null;
    this.poseSmoothing.reset();
    this.getSceneObject().enabled = false;
    if (this.motionRoot) {
      this.motionRoot.enabled = false;
    }
    this.applyDebugViewVisibility(null);
    this.worldVisuals?.reset();
  }

  refreshLabels(
    debugEnabled: boolean,
    view: ARModuleSessionState,
    voice: RobotActivityVoice & { status?: string },
  ): void {
    const title = this.presented && !this.origin ? this.robot?.display_name ?? "Robot" : robotTitleText(view);
    const state = this.presented && !this.origin ? "Last seen" : getRobotActivityState(view, voice);
    this.worldVisuals?.labels(title, state, debugEnabled ? view.pose?.position.map(v => v.toFixed(2)).join(", ") ?? "" : "", sessionLinkStatus(view).color);
    this.applyDebugViewVisibility(debugEnabled);
  }

  tick(dt: number): void {
    if (this.presented && this.motionRoot && !this.worldVisuals) {
      this.worldVisuals = new RobotWorldRenderer(this.motionRoot, sourceId => {
        if (this.canToggle?.(sourceId) !== false) this.onToggle?.();
      });
      this.worldVisuals.setRobot(this.robot);
      const toggle = findChildRecursive(this.motionRoot, "RobotToggleButton");
      if (toggle) toggle.enabled = false;
    }
    this.worldVisuals?.setPickingEnabled(this.origin !== null);
    this.worldVisuals?.tick(dt, this.floorPose(), this.eye?.getTransform().getWorldPosition() ?? null, this.viewportHeight);
    // The copy follows the displayed position after the existing pose smoothing.
    if (!this.origin || !this.presented || !this.motionRoot || !this.poseSmoothing.isTracking) {
      this.worldVisuals?.updateCorrection(null, null, this.viewportHeight);
      return;
    }
    const transform = this.motionRoot.getTransform();
    const current = {
      position: transform.getWorldPosition(),
      rotation: transform.getWorldRotation(),
    };
    const smoothed = this.poseSmoothing.tick(current, dt);
    if (!smoothed) {
      return;
    }
    transform.setWorldPosition(smoothed.position);
    transform.setWorldRotation(smoothed.rotation);
    this.worldVisuals?.updateCorrection(this.origin, this.floorWorldY(), this.viewportHeight);
  }

  worldPosition(): vec3 | null {
    if (!this.origin || !this.presented || !this.motionRoot) {
      return null;
    }
    return this.motionRoot.getTransform().getWorldPosition();
  }

  worldRotation(): quat | null {
    if (!this.origin || !this.presented || !this.motionRoot) {
      return null;
    }
    return this.motionRoot.getTransform().getWorldRotation();
  }

  floorWorldY(): number | null {
    return this.floorPose()?.position.y ?? null;
  }

  floorPose(): { position: vec3; rotation: quat } | null {
    const pose = this.rawFloorPose();
    if (pose && this.referenceFloorHeight !== null) pose.position.y = this.referenceFloorHeight;
    return pose;
  }

  containsBodyPoint(point: vec3): boolean {
    const position = this.worldPosition(), rotation = this.worldRotation();
    if (!position || !rotation || !this.robot) return false;
    const local = new quat(rotation.w, -rotation.x, -rotation.y, -rotation.z).multiplyVec3(point.sub(position));
    const [length, width, height] = this.robot.body_bounds_m.map(value => value * 100);
    const floor = -this.robot.base_height_m * 100;
    return Math.abs(local.x) <= width / 2 && Math.abs(local.z) <= length / 2 && local.y > floor + 3 && local.y <= floor + height;
  }

  rawFloorPose(): { position: vec3; rotation: quat } | null {
    const position = this.worldPosition();
    const rotation = this.worldRotation();
    if (!position || !rotation) {
      return null;
    }
    const baseHeightM = this.robot?.base_height_m ?? GO2_BASE_HEIGHT_M;
    const offset = robotFloorOffset(fromQuat(rotation), baseHeightM, "y").map(value => value * 100);
    // Ground marker arrows use local +X, while native robot forward is local -Z.
    const forward = rotation.multiplyVec3(new vec3(0, 0, -1));
    return {
      position: new vec3(position.x + offset[0], position.y + offset[1], position.z + offset[2]),
      rotation: yawRotationFromPlanarDirection(forward.x, forward.z),
    };
  }

  deadzoneRadiusCm(): number | null {
    if (!this.presented || !this.robot) {
      return null;
    }
    return robotDeadzoneRadiusCm(this.robot);
  }

  private applyHidden(): void {
    this.presented = false;
    this.placedOrigin = null;
    this.getSceneObject().enabled = false;
    if (this.motionRoot) {
      this.motionRoot.enabled = false;
    }
    this.applyDebugViewVisibility(null);
    this.worldVisuals?.reset();
  }

  private applyLocalizedOdom(
    input: Extract<RobotMarkerApplyInput, { mode: "localizedOdom" }>,
    ctx: RobotMarkerApplyContext,
  ): void {
    if (!this.motionRoot) {
      return;
    }
    const specs = clientTrackingToSpecsPose(
      projectRobotPose(input),
    );
    const position = toVec3(specs.position);
    const rotation = toQuat(specs.orientation);
    const snap = !this.presented || this.placedOrigin !== input.origin;
    this.placedOrigin = input.origin;
    this.poseSmoothing.setTarget({ position, rotation }, snap);
    if (snap) {
      this.motionRoot.getTransform().setWorldPosition(position);
      this.motionRoot.getTransform().setWorldRotation(rotation);
    }
    this.robot = input.robot;
    this.worldVisuals?.setRobot(input.robot);
    this.presented = true;
    this.getSceneObject().enabled = true;
    this.motionRoot.enabled = true;
    this.applyDebugViewVisibility(ctx.debugEnabled);
  }

  private configureSceneRefs(): void {
    const root = this.getSceneObject();
    this.motionRoot = this.odometryRoot ?? findChildRecursive(root, "RobotOdometryRoot");
    if (!this.motionRoot) {
      this.motionRoot = root;
    }
    const toggle = findChildRecursive(this.motionRoot, "RobotToggleButton");
    if (toggle) toggle.enabled = false;
    this.debugViewRoot = findChildRecursive(this.motionRoot, "RobotDebugView");
    if (this.debugViewRoot) {
      this.debugViewRoot.enabled = false;
    }
  }

  private applyDebugViewVisibility(debugEnabled: boolean | null): void {
    if (!this.debugViewRoot) {
      return;
    }
    this.debugViewRoot.enabled = this.presented && (debugEnabled ?? false);
  }


}

function toVec3(value: Vec3): vec3 {
  return new vec3(value[0], value[1], value[2]);
}

function toQuat(value: Quat): quat {
  return new quat(value[3], value[0], value[1], value[2]);
}

function fromQuat(value: quat): Quat {
  return [value.x, value.y, value.z, value.w];
}
