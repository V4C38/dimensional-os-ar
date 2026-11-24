import { NavigationMapController, clipNavigationMapSegment, navigationMapContains, panNavigationMap } from "@dimos-ar-client/navigation/NavigationMapProjection";
import { inversePose, multiplyRotation, rotateVecByQuat } from "@dimos-ar-client/localization/ClientTracking";
import * as THREE from "three";
import { Text } from "troika-three-text";
import type { NavigationMapSnapshot } from "@dimos-ar-client/ClientContracts";
import { registerRayTarget } from "../input/WebXRInteraction";
import { disposeTextResources, syncText, UI_FONT_SEMIBOLD } from "../presentation/SceneResources";
import { AdaptiveDashedLineRenderer } from "../presentation/AdaptiveDashedLineRenderer";
import { PANEL_DRAG_BAR_HALF_WIDTH, panelDragBar, panelIcon } from "../presentation/RobotPanelFrame";
import { DIMOS_AR_DESIGN } from "../presentation/DimOSARDesign";
import { buttonSurfaceBacking, glassMaterial, tintButtonBacking } from "../presentation/SurfaceMaterials";

type XY = readonly [number, number];
type Region = "face" | "sphere" | "resize" | "recenter" | "cancel" | "compass" | "pin";
type Ray = { origin: readonly number[]; direction: readonly number[] };

export interface NavigationMapPorts {
  view(): NavigationMapSnapshot | null;
  robotDescription?(): { body_bounds_m: readonly [number, number, number]; base_height_m: number } | null;
  setViewport(viewport: { center?: XY; radiusM: number } | null): void;
  submit(position: XY): Promise<void>;
  cancelPending(): void;
  cancelRoute(): Promise<void>;
  error(message: string): void;
  feedback?(message: string, pending: boolean): void;
}

const RADIUS_M = 4;
const TAP_TIME_MS = 350;
const DRAG_HOLD_MS = 180;
const DRAG_THRESHOLD_M = 0.012;
const HANDLE_GAP = 0.008;
const HANDLE_HALF_WIDTH = PANEL_DRAG_BAR_HALF_WIDTH / 2;
const MAP_CONTROL_SIZE = DIMOS_AR_DESIGN.controls.iconSize * 3 / 8;
const MAP_CONTROL_THICKNESS = (DIMOS_AR_DESIGN.depth.secondary + DIMOS_AR_DESIGN.depth.controlOverlap) *
  DIMOS_AR_DESIGN.depth.controlThicknessScale / 2;
const HANDLE_LENGTH = 0.12;

function curvedHandle(radius: number): THREE.ShapeGeometry {
  const centerRadius = radius * 1.015 + HANDLE_GAP + HANDLE_HALF_WIDTH;
  const halfAngle = HANDLE_LENGTH / (2 * centerRadius);
  const start = -Math.PI / 2 - halfAngle, end = -Math.PI / 2 + halfAngle;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, centerRadius + HANDLE_HALF_WIDTH, start, end, false);
  shape.absarc(centerRadius * Math.cos(end), centerRadius * Math.sin(end), HANDLE_HALF_WIDTH, end, end + Math.PI, false);
  shape.absarc(0, 0, centerRadius - HANDLE_HALF_WIDTH, end, start, true);
  shape.absarc(centerRadius * Math.cos(start), centerRadius * Math.sin(start), HANDLE_HALF_WIDTH, start + Math.PI, start + Math.PI * 2, false);
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

function unitBoxEdges(): THREE.EdgesGeometry {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.EdgesGeometry(box);
  box.dispose();
  return edges;
}

export class WebXRNavigationMap {
  readonly object = new THREE.Group();
  private readonly content = new THREE.Group();
  private readonly worldPosition = new THREE.Vector3();
  private readonly worldScale = new THREE.Vector3();
  private readonly parentRotation = new THREE.Quaternion();
  private readonly dockRotation = new THREE.Quaternion();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly mapData = new THREE.Group();
  private readonly plate: THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial>;
  private readonly underside = new THREE.Mesh(new THREE.CircleGeometry(1, 72),
    new THREE.MeshBasicMaterial({ color: 0x202022, side: THREE.BackSide }));
  private readonly side = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.004, 72, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x202022 }));
  private readonly sphere = this.marker(0xffffff, 0.008);
  private readonly ghost = this.marker(0xffffff, 0.009);
  private readonly target = this.marker(0xffffff, 0.009);
  private readonly tether = new AdaptiveDashedLineRenderer(0.001, 0.002, 0.002, 1);
  private readonly rim = new THREE.Mesh(new THREE.RingGeometry(0.965, 1.015, 72), new THREE.MeshBasicMaterial({ color: 0x202022 }));
  private readonly resize = panelDragBar();
  private readonly resizeRight = panelDragBar();
  private readonly compass = this.roundControl("Compass orientation");
  private readonly pinButton = this.roundControl("Follow robot");
  private compassEnabled = true;
  private manualRotation = 0;
  private initialHeading: number | null = null;
  private readonly sphereHit = new THREE.Mesh(new THREE.SphereGeometry(0.016), new THREE.MeshBasicMaterial({ visible: false }));
  private readonly recenter = this.marker(0xffffff, 0.013);
  private readonly recenterArrow = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.024, 4).rotateZ(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff }));
  private readonly cancel = new THREE.Mesh(new THREE.PlaneGeometry(0.057, 0.021),
    new THREE.MeshBasicMaterial({ color: 0x333333 }));
  private readonly cancelText = new Text();
  private readonly heading = this.lines(1, 0xffffff);
  private readonly scaleBar = this.lines(3, 0xdddddd);
  private readonly scaleLabel = new Text();
  private readonly route = this.lines(256, 0xffffff);
  private readonly points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 0.003, vertexColors: true }));
  private readonly debugRobot = new THREE.Group();
  private readonly debugBounds = new THREE.LineSegments(unitBoxEdges(), new THREE.LineBasicMaterial({ color: 0xffffff }));
  private debugEnabled = false;
  private texture: THREE.DataTexture | null = null;
  private pixels = new Uint8Array(0);
  private drawn: { snapshot: NavigationMapSnapshot | null; center: XY; radius: number; cancel: boolean; mapRadius: number } | null = null;
  private source: { reference: string; generation: number } | null = null;
  private cells: NavigationMapSnapshot["cells"] | null = null;
  private snapshot: NavigationMapSnapshot | null = null;
  readonly viewport = new NavigationMapController();
  private metersPerUnit = RADIUS_M / 0.14;
  private diameter = 0.22;
  private handleRadius = 0;
  get mapRadius(): number { return this.viewport.radiusM; }
  private scaleGesture: { distance: number; radius: number; angle: number; rotation: number } | null = null;
  private progress = 0;
  private open = false;
  private canSend = false;
  private clickToWalk = true;
  private canCancel = false;
  private dirtyViewport = false;
  private lastHoldAt = 0;
  private gesture: { region: Region; target: THREE.Object3D; start: XY; center: XY; radius: number; at: number; moved: boolean; motion: boolean; rotation: number; marker: XY } | null = null;

  constructor(private readonly ports: NavigationMapPorts) {
    this.plate = new THREE.Mesh(new THREE.CircleGeometry(1, 72), new THREE.ShaderMaterial({
      uniforms: { grid: { value: null }, bounds: { value: new THREE.Vector4() }, center: { value: new THREE.Vector2() },
        ready: { value: false }, mapRadius: { value: RADIUS_M }, panelTint: { value: new THREE.Color(0x202022) } },
      vertexShader: `varying vec2 positionOnDisc;
        void main() { positionOnDisc = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D grid; uniform vec4 bounds; uniform vec2 center; uniform bool ready; uniform float mapRadius; uniform vec3 panelTint; varying vec2 positionOnDisc;
        void main() {
          vec2 st = (center + positionOnDisc * mapRadius - bounds.xy) / max(bounds.zw, vec2(.001));
          vec3 color = panelTint;
          if (ready && all(greaterThanEqual(st, vec2(0))) && all(lessThan(st, vec2(1)))) {
            float v = texture2D(grid, st).r * 255.0;
            color = v < .5 ? vec3(.14) : mix(vec3(.21, .25, .26), vec3(.82, .76, .67), (v - 1.0) / 100.0);
          }
          gl_FragColor = vec4(color, 1.0);
          #include <colorspace_fragment>
        }`,
    }));
    this.rim.position.z = 0.001;
    this.underside.position.z = -0.004;
    this.side.rotation.x = Math.PI / 2;
    this.side.position.z = -0.002;
    this.underside.name = "Navigation map underside";
    this.object.name = "Go2 navigation map";
    this.object.userData.navigationMapDock = true;
    this.object.visible = false;
    this.content.rotation.x = -Math.PI / 2;
    this.object.add(this.content);
    this.plate.name = "Navigation map face";
    this.sphereHit.name = "Navigation map robot sphere";
    this.resize.name = "Navigation map resize";
    this.resizeRight.name = "Navigation map resize right";
    this.resize.position.set(0, -1.07, 0.004);
    this.recenter.name = "Recenter navigation map";
    this.recenter.material.visible = false;
    this.recenter.add(this.recenterArrow);
    this.cancel.name = "Cancel route";
    this.cancelText.text = "Cancel route";
    this.cancelText.font = UI_FONT_SEMIBOLD;
    this.cancelText.fontSize = 0.0072;
    this.cancelText.anchorX = "center";
    this.cancelText.anchorY = "middle";
    this.cancelText.color = 0xffffff;
    this.cancelText.position.z = 0.0006;
    this.cancelText.raycast = () => {};
    this.cancel.add(this.cancelText);
    syncText(this.cancelText);
    this.scaleLabel.font = UI_FONT_SEMIBOLD;
    this.scaleLabel.fontSize = 0.008;
    this.scaleLabel.anchorX = "center";
    this.scaleLabel.anchorY = "bottom";
    this.scaleLabel.color = 0xdddddd;
    this.scaleLabel.raycast = () => {};
    this.tether.setSegments([[0, 0, 0.001], [0, 0, 0.032]]);
    this.debugRobot.name = "Navigation map robot debug";
    this.debugBounds.name = "Navigation map robot bounds";
    this.debugRobot.add(this.debugBounds);
    for (const [axis, color] of [[new THREE.Vector3(1, 0, 0), 0xff0000], [new THREE.Vector3(0, 1, 0), 0x00ff00], [new THREE.Vector3(0, 0, 1), 0x0000ff]] as const) {
      this.debugRobot.add(new THREE.ArrowHelper(axis, new THREE.Vector3(), 0.24, color, 0.055, 0.04));
    }
    this.debugRobot.traverse(node => { node.raycast = () => {}; });
    this.addControlIcon(this.compass, [[0, .018], [-.009, -.012], [0, -.006], [.009, -.012], [0, .018]]);
    this.addControlIcon(this.pinButton, [[-.009, .012], [.009, .012], [.005, .004], [.005, 0],
      [.009, -.004], [-.009, -.004], [-.005, 0], [-.005, .004], [-.009, .012], [0, -.004], [0, -.017]]);
    this.mapData.add(this.plate, this.sphere, this.sphereHit, this.tether.object,
      this.heading, this.route, this.target, this.points, this.recenter, this.ghost, this.debugRobot);
    this.content.add(this.underside, this.side, this.rim, this.resize, this.resizeRight, this.mapData, this.scaleBar, this.scaleLabel, this.cancel, this.compass, this.pinButton);
    this.points.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(128 * 3), 3));
    this.points.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(128 * 3), 3));
    this.points.frustumCulled = false;
    this.register(this.plate, "face", 6);
    this.register(this.sphereHit, "sphere", 5);
    this.register(this.resize, "resize", 5);
    this.register(this.resizeRight, "resize", 5);
    this.register(this.compass, "compass", 3);
    this.register(this.pinButton, "pin", 3);
    this.register(this.recenter, "recenter", 5);
    this.register(this.cancel, "cancel", 4);
  }

  setClickToWalk(enabled: boolean): void {
    if (this.clickToWalk === enabled) return;
    this.clickToWalk = enabled;
    if (!enabled) {
      if (this.gesture) this.gesture.motion = false;
      this.ghost.visible = false;
      this.ports.cancelPending();
    }
  }
  setOrientation(headset: THREE.Quaternion, dockYaw: number, origin: { shared_frame_id: string; odom_reference_id: string; orientation: readonly number[] } | null): void {
    if (this.initialHeading === null) {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(headset);
      if (forward.x * forward.x + forward.z * forward.z >= 1e-6) {
        this.initialHeading = Math.atan2(-forward.x, -forward.z);
      }
    }
    if (!this.object.visible) return;
    let worldAngle = this.initialHeading ?? dockYaw;
    if (origin && this.snapshot && origin.shared_frame_id === this.snapshot.shared_frame_id && origin.odom_reference_id === this.snapshot.odom_reference_id) {
      const [x, y, z, w] = origin.orientation;
      const inverse = inversePose({ position: [0, 0, 0], orientation: [x, y, z, w] });
      const [east, north] = rotateVecByQuat(multiplyRotation(inverse.orientation, this.snapshot.map_odom_rotation), [1, 0, 0]);
      if (Math.hypot(east, north) >= 1e-6) worldAngle = Math.atan2(north, east);
    }
    const rotation = this.compassEnabled ? Math.PI / 2 + worldAngle - dockYaw : this.manualRotation;
    if (rotation !== this.mapData.rotation.z) this.mapData.rotation.z = rotation;
  }
  resetTrackingReference(): void { this.initialHeading = null; }

  setDebug(enabled: boolean): void {
    if (this.debugEnabled !== enabled) { this.debugEnabled = enabled; this.drawn = null; }
  }

  setMotionAvailable(available: boolean) {
    this.canSend = available;
    if (!available && this.gesture) this.gesture.motion = false;
  }

  get capturing() { return this.gesture !== null; }
  get physicalRadius() { return this.diameter / 2; }
  owns(object: THREE.Object3D) { return object.userData.navigationMap === this; }
  canInteract(object: THREE.Object3D, point: THREE.Vector3) {
    return this.open && this.progress > 0.35 && this.owns(object) &&
      this.content.worldToLocal(point.clone()).z >= -0.003;
  }

  private register(mesh: THREE.Mesh, region: Region, priority: number): void {
    mesh.userData.navigationMap = this;
    mesh.userData.mapRegion = region;
    mesh.userData.rayPriority = priority;
    if (mesh.geometry.type !== "SphereGeometry") {
      mesh.userData.proximityTarget = false;
      mesh.userData.topFaceOnly = true;
    }
    registerRayTarget(mesh);
  }

  private marker(color: number, radius: number) {
    return new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), new THREE.MeshBasicMaterial({ color }));
  }

  private roundControl(name: string) {
    const size = MAP_CONTROL_SIZE;
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(size / 2, 48),
      glassMaterial({ width: size, height: size, radius: size / 2, tint: DIMOS_AR_DESIGN.colors.control, alpha: 1, rim: 0.08, rimWidth: 0.002 }));
    mesh.name = name;
    const backing = buttonSurfaceBacking(size, size, size / 2, MAP_CONTROL_THICKNESS);
    backing.renderOrder = mesh.renderOrder - 1;
    mesh.add(backing);
    return Object.assign(mesh, { backing });
  }

  private addControlIcon(control: THREE.Mesh, points: readonly (readonly [number, number])[]): void {
    const icon = panelIcon(points.flatMap((point, index) =>
      index ? [points[index - 1], point] : []));
    icon.scale.setScalar(0.375);
    icon.position.z = 0.001;
    icon.traverse(node => { node.raycast = () => {}; });
    control.add(icon);
  }

  private lines(capacity: number, color: number) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 6), 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
    lines.frustumCulled = false;
    return lines;
  }

  update(open: boolean, selected: boolean, canSend: boolean, canCancel: boolean, lowerEdge: THREE.Vector3,
    yaw: number, time: number, deltaS: number): void {
    if (!selected) this.viewport.follow();
    this.setMotionAvailable(canSend);
    this.canCancel = canCancel;
    if (open !== this.open) {
      this.open = open;
      if (open) this.ports.setViewport(this.viewport.request);
      else {
        this.viewport.follow();
        this.abort(true);
        this.ports.setViewport(null);
        this.snapshot = null;
      }
    }
    this.progress = THREE.MathUtils.clamp(this.progress + (open ? 1 : -1) * deltaS / 0.2, 0, 1);
    this.object.visible = this.progress > 0;
    this.object.userData.rayDisabled = !this.object.visible;
    if (this.object.visible) this.place(lowerEdge, yaw);
    if (!open) return;
    if (this.dirtyViewport) this.requestViewport(time);
    const snapshot = this.ports.view();
    if (snapshot) {
      if (this.source && (this.source.reference !== snapshot.odom_reference_id ||
          this.source.generation !== snapshot.source_generation)) {
        this.abort(true);
        if (this.source.reference !== snapshot.odom_reference_id) {
          this.viewport.follow();
          this.requestViewport(time);
        }
      }
      if (!this.source || this.source.reference !== snapshot.odom_reference_id ||
          this.source.generation !== snapshot.source_generation) {
        this.source = { reference: snapshot.odom_reference_id, generation: snapshot.source_generation };
      }
      this.snapshot = snapshot;
    }
    else if (this.snapshot) {
      this.snapshot = null;
      this.abort(true);
    }
    if (!this.gesture && this.snapshot) this.viewport.updateCenter(this.snapshot.robot);
    this.draw(canCancel);
  }

  place(lowerEdge: THREE.Vector3, yaw: number): void {
    const parent = this.object.parent;
    this.object.position.set(lowerEdge.x + Math.sin(yaw) * this.physicalRadius,
      lowerEdge.y - 0.06, lowerEdge.z + Math.cos(yaw) * this.physicalRadius);
    this.dockRotation.setFromAxisAngle(this.worldUp, yaw);
    const appearance = Math.max(0.001, 1 - (1 - this.progress) ** 3);
    this.object.scale.setScalar(appearance);
    if (parent) {
      parent.worldToLocal(this.object.position);
      this.object.quaternion.copy(parent.getWorldQuaternion(this.parentRotation).invert()).multiply(this.dockRotation);
      this.object.scale.divide(parent.getWorldScale(this.worldScale));
    } else this.object.quaternion.copy(this.dockRotation);
  }

  updateHover(objects: readonly (THREE.Object3D | undefined)[]): void {
    this.resize.material.opacity = objects.includes(this.resize) || this.gesture?.region === "resize" ? 1 : 0.6;
    this.resizeRight.material.opacity = objects.includes(this.resizeRight) || this.gesture?.region === "resize" ? 1 : 0.6;
    this.sphere.material.color.setHex(objects.includes(this.sphereHit) ? 0xffffff : 0xffffff);
    this.recenterArrow.material.color.setHex(objects.includes(this.recenter) ? 0xffffff : 0xffffff);
    this.cancel.material.color.setHex(objects.includes(this.cancel) ? 0x666666 : 0x333333);
    for (const [control, active] of [[this.compass, this.compassEnabled], [this.pinButton, this.viewport.followingRobot]] as const) {
      const tint = control.material.uniforms.uTint.value as THREE.Color;
      const hovered = objects.includes(control);
      tint.set(active ? DIMOS_AR_DESIGN.colors.primary : DIMOS_AR_DESIGN.colors.secondary);
      control.material.uniforms.uHover.value = hovered ? 1 : 0;
      const icon = control.children.find(child => child !== control.backing) as THREE.Mesh | undefined;
      if (icon) (icon.material as THREE.MeshBasicMaterial).color.set(
        active ? DIMOS_AR_DESIGN.colors.primaryText : DIMOS_AR_DESIGN.colors.ink);
      tintButtonBacking(control.backing, tint, hovered ? 1 : 0);
    }
  }

  private draw(canCancel: boolean): void {
    const radius = this.diameter / 2;
    if (this.drawn?.snapshot === this.snapshot && this.drawn.center === this.viewport.centerM &&
        this.drawn.radius === radius && this.drawn.mapRadius === this.mapRadius && this.drawn.cancel === canCancel) return;
    this.drawn = { snapshot: this.snapshot, center: this.viewport.centerM, radius, mapRadius: this.mapRadius, cancel: canCancel };
    this.metersPerUnit = this.mapRadius / radius;
    this.plate.material.uniforms.mapRadius.value = this.mapRadius;
    for (const mesh of [this.plate, this.underside, this.rim]) mesh.scale.set(radius, radius, 1);
    this.side.scale.set(radius, 1, radius);
    if (this.handleRadius !== radius) {
      this.resize.geometry.dispose();
      this.resize.geometry = curvedHandle(radius);
      if (this.handleRadius === 0) this.resizeRight.geometry.dispose();
      this.resizeRight.geometry = this.resize.geometry;
      this.handleRadius = radius;
    }
    this.resize.position.set(0, 0, 0.004);
    this.resizeRight.position.copy(this.resize.position);
    this.resize.rotation.z = -Math.PI / 2;
    this.resizeRight.rotation.z = Math.PI / 2;
    const controlOffset = MAP_CONTROL_SIZE / 2 + 0.0015;
    const front = -radius * 1.015 - MAP_CONTROL_SIZE / 2 - 0.0015;
    this.compass.position.set(-controlOffset, front, MAP_CONTROL_THICKNESS);
    this.pinButton.position.set(controlOffset, front, MAP_CONTROL_THICKNESS);
    this.cancel.visible = canCancel;
    this.cancel.position.set(radius * 0.48, radius * 0.42, 0.008);
    const snapshot = this.snapshot;
    this.plate.material.uniforms.ready.value = !!snapshot;
    this.plate.material.uniforms.center.value.set(...this.viewport.centerM);
    this.sphere.visible = this.sphereHit.visible = this.tether.object.visible = false;
    this.debugRobot.visible = false;
    this.heading.visible = this.target.visible = this.recenter.visible = false;
    this.route.geometry.setDrawRange(0, 0);
    this.points.geometry.setDrawRange(0, 0);
    const barY = radius * 0.72;
    const ideal = this.mapRadius * 0.5;
    const magnitude = 10 ** Math.floor(Math.log10(ideal));
    const value = [1, 2, 5, 10].map(n => n * magnitude).find(n => n >= ideal) ?? magnitude;
    const half = value / this.metersPerUnit / 2;
    this.setSegments(this.scaleBar, [[-half, barY, half, barY], [-half, barY - 0.003, -half, barY + 0.003],
      [half, barY - 0.003, half, barY + 0.003]], 0.002);
    this.scaleBar.visible = snapshot !== null;
    const scaleText = snapshot ? `${Number(value.toPrecision(3))} m` : "Loading map…";
    if (this.scaleLabel.text !== scaleText) { this.scaleLabel.text = scaleText; syncText(this.scaleLabel); }
    this.scaleLabel.position.set(0, snapshot ? barY + 0.004 : 0, 0.003);
    if (!snapshot) return;
    this.updateTexture(snapshot);
    const robot = this.local([snapshot.robot[0], snapshot.robot[1]]);
    const distance = Math.hypot(...robot);
    const description = this.ports.robotDescription?.();
    if (this.debugEnabled && description) {
      const [length, width, height] = description.body_bounds_m;
      const extent = Math.hypot(length, width) / (2 * this.metersPerUnit);
      this.debugRobot.visible = distance + Math.max(extent, 0.24 / this.metersPerUnit) <= radius;
      this.debugRobot.position.set(...robot, 0.002 + description.base_height_m / this.metersPerUnit);
      this.debugRobot.rotation.z = snapshot.robot[2];
      this.debugRobot.scale.setScalar(1 / this.metersPerUnit);
      this.debugBounds.scale.set(length, width, height);
      this.debugBounds.position.z = height / 2 - description.base_height_m;
    }
    this.sphere.visible = this.sphereHit.visible = this.tether.object.visible = distance <= radius;
    this.heading.visible = this.sphere.visible;
    this.recenter.visible = distance > radius;
    if (this.sphere.visible) {
      this.sphere.position.set(...robot, 0.04);
      this.sphereHit.position.copy(this.sphere.position);
      this.tether.object.position.set(...robot, 0);
      const yaw = snapshot.robot[2];
      this.setSegments(this.heading, [[...robot, robot[0] + Math.cos(yaw) * 0.009, robot[1] + Math.sin(yaw) * 0.009]], 0.002);
    } else {
      this.recenter.position.set(robot[0] / distance * radius * 0.89, robot[1] / distance * radius * 0.89, 0.01);
      this.recenterArrow.rotation.z = Math.atan2(robot[1], robot[0]);
    }
    if (snapshot.target) {
      const target = this.local(snapshot.target);
      this.target.visible = Math.hypot(...target) <= radius;
      this.target.position.set(...target, 0.009);
    }
    const route = this.route.geometry.getAttribute("position");
    let routeCount = 0;
    for (const [x1, y1, x2, y2] of snapshot.route) {
      if (routeCount >= route.count / 2) break;
      const segment = clipNavigationMapSegment(this.local([x1, y1]), this.local([x2, y2]), radius);
      if (!segment) continue;
      route.setXYZ(routeCount * 2, segment[0], segment[1], 0.003);
      route.setXYZ(routeCount * 2 + 1, segment[2], segment[3], 0.003);
      routeCount++;
    }
    route.needsUpdate = true;
    this.route.geometry.setDrawRange(0, routeCount * 2);
    const positions = this.points.geometry.getAttribute("position"), colors = this.points.geometry.getAttribute("color");
    this.points.material.size = 0.003 * THREE.MathUtils.clamp(Math.sqrt(radius / 0.14), 0.85, 1.25);
    let count = 0;
    const color = new THREE.Color();
    for (const [index, [x, y, z]] of snapshot.heights.entries()) {
      const p = this.local([x, y]), d = Math.hypot(...p) / radius;
      if (d > 0.86 || count >= positions.count) continue;
      if (this.mapRadius >= 4 && d > 0.55 && index % 3 === 2) continue;
      const taper = 1 - THREE.MathUtils.smoothstep(d, 0.55, 1);
      positions.setXYZ(count, ...p, 0.004 + Math.max(0, z) / this.metersPerUnit * taper);
      color.setHSL(0.60 - THREE.MathUtils.clamp(z / 1.5, 0, 1) * 0.60, 0.72, 0.62);
      colors.setXYZ(count++, color.r, color.g, color.b);
    }
    positions.needsUpdate = colors.needsUpdate = true;
    this.points.geometry.setDrawRange(0, count);
  }

  private updateTexture(snapshot: NavigationMapSnapshot): void {
    if (this.cells !== snapshot.cells) {
      if (!this.texture || this.texture.image.width !== snapshot.width || this.texture.image.height !== snapshot.height) {
        this.texture?.dispose();
        this.pixels = new Uint8Array(snapshot.width * snapshot.height);
        this.texture = new THREE.DataTexture(this.pixels, snapshot.width, snapshot.height,
          THREE.RedFormat, THREE.UnsignedByteType);
        this.plate.material.uniforms.grid.value = this.texture;
      }
      snapshot.cells.copyDisplayBytes(this.pixels);
      this.texture.needsUpdate = true;
      this.cells = snapshot.cells;
    }
    this.plate.material.uniforms.bounds.value.set(...snapshot.origin, snapshot.width * snapshot.resolution, snapshot.height * snapshot.resolution);
  }

  private setSegments(lines: THREE.LineSegments, segments: readonly (readonly [number, number, number, number])[], z: number): void {
    const vertices = lines.geometry.getAttribute("position");
    const count = Math.min(segments.length, vertices.count / 2);
    for (let index = 0; index < count; index++) {
      const [x1, y1, x2, y2] = segments[index];
      vertices.setXYZ(index * 2, x1, y1, z);
      vertices.setXYZ(index * 2 + 1, x2, y2, z);
    }
    vertices.needsUpdate = true;
    lines.geometry.setDrawRange(0, count * 2);
  }

  begin(object: THREE.Object3D, ray: Ray, fallback: THREE.Vector3, time: number): boolean {
    const region = object.userData.mapRegion as Region;
    if (!this.canInteract(object, fallback)) return false;
    const start = this.pick(ray, region);
    if (!start) return false;
    this.gesture = { region, target: object, start, center: this.viewport.centerM, radius: this.diameter / 2,
      at: time, moved: false, motion: this.canSend && this.clickToWalk && this.snapshot !== null, rotation: this.mapData.rotation.z, marker: [this.sphere.position.x, this.sphere.position.y] };
    this.lastHoldAt = time;
    return true;
  }

  directRay(point: THREE.Vector3): Ray | null {
    if (point.y < this.object.getWorldPosition(this.worldPosition).y - 0.004) return null;
    return { origin: [point.x, point.y + 0.10, point.z], direction: [0, -1, 0] };
  }

  pointer(ray: Ray, target = this.gesture?.target): THREE.Vector3 | null {
    const region = target?.userData.mapRegion as Region | undefined;
    if (target && region && ["compass", "pin", "cancel", "recenter"].includes(region)) {
      return target.getWorldPosition(new THREE.Vector3());
    }
    const point = this.pick(ray, region);
    if (!point) return null;
    const radius = this.diameter / 2;
    if (target && region === "resize") {
      const handle = target;
      const local = new THREE.Vector3(point[0], point[1], 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), -handle.rotation.z);
      const centerRadius = radius * 1.015 + HANDLE_GAP + HANDLE_HALF_WIDTH;
      const halfAngle = HANDLE_LENGTH / (2 * centerRadius);
      const angle = THREE.MathUtils.clamp(Math.atan2(local.x, -local.y), -halfAngle, halfAngle);
      return handle.localToWorld(new THREE.Vector3(centerRadius * Math.sin(angle), -centerRadius * Math.cos(angle), 0));
    }
    const distance = Math.hypot(...point);
    const factor = distance > radius ? radius / distance : 1;
    return this.mapData.localToWorld(new THREE.Vector3(point[0] * factor, point[1] * factor, region === "sphere" ? this.sphere.position.z : 0.002));
  }

  hold(ray: Ray, time = performance.now()): void {
    const gesture = this.gesture, current = this.pick(ray);
    if (!gesture || !current) { this.ghost.visible = false; return; }
    const alpha = 1 - Math.exp(-18 * Math.max(0, Math.min(0.1, (time - this.lastHoldAt) / 1000)));
    this.lastHoldAt = time;
    const movement = Math.hypot(current[0] - gesture.start[0], current[1] - gesture.start[1]);
    if (movement * this.object.getWorldScale(this.worldScale).x >= DRAG_THRESHOLD_M) gesture.moved = true;
    if (!gesture.moved) return;
    if (gesture.region === "face" && time - gesture.at < DRAG_HOLD_MS) return;
    if (gesture.region === "face") {
      const target = panNavigationMap(gesture.center, gesture.start, current, this.metersPerUnit);
      this.viewport.panTo([
        THREE.MathUtils.lerp(this.viewport.centerM[0], target[0], alpha),
        THREE.MathUtils.lerp(this.viewport.centerM[1], target[1], alpha),
      ]);
      this.dirtyViewport = true;
    } else if (gesture.region === "resize") {
      const radial = Math.hypot(...current) - Math.hypot(...gesture.start);
      this.diameter = THREE.MathUtils.lerp(this.diameter, THREE.MathUtils.clamp((gesture.radius + radial) * 2, 0.16, 0.42), alpha);
    } else if (gesture.region === "sphere") {
      const point = this.dropPoint(current, gesture);
      this.ghost.visible = gesture.motion && this.valid(point);
      this.ghost.position.set(...point, 0.009);
    }
  }

  beginScale(first: Ray, second: Ray): boolean {
    if (!this.gesture || !["face", "sphere", "resize"].includes(this.gesture.region)) return false;
    const a = this.pick(first, "resize"), b = this.pick(second, "resize");
    if (!a || !b) return false;
    const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (distance < 0.015) return false;
    this.gesture.moved = true;
    this.ghost.visible = false;
    this.scaleGesture = { distance, radius: this.mapRadius,
      angle: Math.atan2(b[1] - a[1], b[0] - a[0]), rotation: this.manualRotation };
    return true;
  }

  holdScale(first: Ray, second: Ray): void {
    const a = this.pick(first, "resize"), b = this.pick(second, "resize"), scale = this.scaleGesture;
    if (!a || !b || !scale) return;
    const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (!this.compassEnabled && distance >= 0.015) {
      const delta = Math.atan2(b[1] - a[1], b[0] - a[0]) - scale.angle;
      this.manualRotation = THREE.MathUtils.euclideanModulo(scale.rotation + delta + Math.PI, 2 * Math.PI) - Math.PI;
      this.mapData.rotation.z = this.manualRotation;
    }
    if (this.viewport.zoom(scale.radius * scale.distance / Math.max(distance, 0.015))) {
      this.dirtyViewport = true;
    }
  }

  endScale(remaining?: Ray): void {
    this.scaleGesture = null;
    const start = remaining && this.pick(remaining, "face");
    if (this.gesture && start) {
      this.gesture = { ...this.gesture, region: "face", start, center: this.viewport.centerM,
        radius: this.diameter / 2, moved: true };
    }
  }

  complete(ray: Ray, time: number): void {
    const gesture = this.gesture;
    if (!gesture || !this.open) return;
    this.hold(ray, time);
    const current = this.pick(ray);
    if (!current) return;
    if (!gesture.moved && gesture.region === "compass") {
      this.compassEnabled = !this.compassEnabled;
    } else if (!gesture.moved && (gesture.region === "recenter" || gesture.region === "pin")) {
      if (gesture.region === "pin") this.viewport.toggleFollow(this.snapshot?.robot);
      else this.viewport.follow(this.snapshot?.robot);
      this.requestViewport(time);
    } else if (gesture.region === "cancel" && this.canCancel && !gesture.moved) {
      void this.ports.cancelRoute().catch(error => this.ports.error(String(error)));
    } else if (gesture.motion && this.clickToWalk && Math.abs(gesture.rotation - this.mapData.rotation.z) < 0.001) {
      const drop = gesture.region === "sphere" && gesture.moved;
      const tap = gesture.region === "face" && !gesture.moved && time - gesture.at <= TAP_TIME_MS;
      const point = drop ? this.dropPoint(current, gesture) : current;
      const latest = this.ports.view();
      if ((tap || drop) && this.valid(point) && latest &&
          latest.odom_reference_id === this.snapshot?.odom_reference_id &&
          latest.source_generation === this.snapshot.source_generation) {
        this.ports.feedback?.("Sending goal…", true);
        void this.ports.submit(this.native(point)).then(
          () => { if (this.open) this.ports.feedback?.("Goal sent", false); },
          error => { if (this.open) this.ports.error(error instanceof Error ? error.message : String(error)); });
      }
    }
  }

  abort(cancelPending = false): void {
    this.gesture = null;
    this.scaleGesture = null;
    this.ghost.visible = false;
    if (cancelPending) {
      this.ports.cancelPending();
      this.dirtyViewport = false;
    }
  }

  private requestViewport(_time: number): void {
    this.dirtyViewport = false;
    this.ports.setViewport(this.viewport.request);
  }

  private pick(ray: Ray, region: Region | undefined = this.gesture?.region): XY | null {
    const frame = region && ["resize", "compass", "pin", "cancel"].includes(region) ? this.content : this.mapData;
    frame.updateWorldMatrix(true, false);
    const origin = frame.worldToLocal(new THREE.Vector3(ray.origin[0], ray.origin[1], ray.origin[2]));
    const p = frame.worldToLocal(new THREE.Vector3(ray.origin[0] + ray.direction[0],
      ray.origin[1] + ray.direction[1], ray.origin[2] + ray.direction[2])).sub(origin);
    if (origin.z < 0 || p.z >= -0.0001) return null;
    const distance = -origin.z / p.z;
    return [origin.x + p.x * distance, origin.y + p.y * distance];
  }
  private dropPoint(point: XY, gesture: NonNullable<WebXRNavigationMap["gesture"]>): XY {
    return [gesture.marker[0] + point[0] - gesture.start[0], gesture.marker[1] + point[1] - gesture.start[1]];
  }
  private valid(point: XY) {
    return Math.hypot(...point) <= this.diameter / 2 && !!this.snapshot && navigationMapContains(this.snapshot, this.native(point));
  }
  private native(point: XY): XY {
    return this.viewport.toNative(point, this.metersPerUnit);
  }
  private local(point: XY): XY {
    return this.viewport.toLocal(point, this.metersPerUnit);
  }

  suspend(): void {
    this.open = false;
    this.viewport.follow();
    this.progress = 0;
    this.object.visible = false;
    this.object.userData.rayDisabled = true;
    this.snapshot = null;
    this.abort(true);
    this.ports.setViewport(null);
  }

  dispose(): void {
    this.suspend();
    this.tether.object.removeFromParent();
    this.tether.dispose();
    this.texture?.dispose();
    this.cancelText.removeFromParent();
    disposeTextResources(this.cancelText);
    this.scaleLabel.removeFromParent();
    disposeTextResources(this.scaleLabel);
    this.object.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    this.object.removeFromParent();
  }
}
