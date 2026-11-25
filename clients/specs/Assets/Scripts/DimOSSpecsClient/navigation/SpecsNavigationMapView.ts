import type { NavigationMapSnapshot, RobotDescription, ReadonlyFacts } from "DimOSARClient.lspkg/Scripts/DimOSARClient/ClientContracts";
import type { NavigationMapController } from "DimOSARClient.lspkg/Scripts/DimOSARClient/navigation/NavigationMapProjection";
import { AdaptiveStrokeRenderer, WorldMeshRenderer, circleMesh, sphereMesh, strokeMesh2D } from "../presentation/WorldMeshRenderer";
import { createText, COLOR_WHITE } from "../presentation/UIKit";
import { SpecsMapPixels, projectSpecsMap } from "./SpecsMapGesture";

const IMAGE_MATERIAL = requireAsset("SpectaclesUIKit.lspkg/Materials/Image.mat") as Material;
const SEGMENTS = 72;
// Height samples are small map accents on Spectacles; bound mesh work and draw
// load independently of the source cloud size while retaining its full extent.
const MAX_HEIGHT_SAMPLES = 64;

/** Native map geometry; input, panel positioning and subscriptions are owned separately. */
export class SpecsNavigationMapView {
  readonly root: SceneObject;
  readonly dataRoot: SceneObject;
  private readonly disc: WorldMeshRenderer;
  private readonly background: WorldMeshRenderer;
  private readonly rim: WorldMeshRenderer;
  private readonly route: AdaptiveStrokeRenderer;
  private readonly robot: WorldMeshRenderer;
  private readonly target: WorldMeshRenderer;
  private readonly ghost: WorldMeshRenderer;
  private readonly heading: AdaptiveStrokeRenderer;
  private readonly tether: AdaptiveStrokeRenderer;
  private readonly heights: WorldMeshRenderer;
  private readonly resizeLeft: WorldMeshRenderer;
  private readonly resizeRight: WorldMeshRenderer;
  private readonly compass: WorldMeshRenderer;
  private readonly follow: WorldMeshRenderer;
  private readonly compassIcon: WorldMeshRenderer;
  private readonly followIcon: WorldMeshRenderer;
  private readonly recenter: WorldMeshRenderer;
  private readonly scale: AdaptiveStrokeRenderer;
  private readonly scaleLabel: Text;
  private debugRoot: SceneObject | null = null;
  private debugBox: AdaptiveStrokeRenderer | null = null;
  private debugAxes: AdaptiveStrokeRenderer[] = [];
  private debugKey = "";
  private projected: ReturnType<typeof projectSpecsMap> | null = null;
  private readonly pixels = new SpecsMapPixels();
  private texture: Texture | null = null;
  private textureWidth = 0;
  private textureHeight = 0;
  private padded = new Uint8Array(0);
  private lastSnapshot: NavigationMapSnapshot | null = null;
  private lastCenter: readonly [number, number] | null = null;
  private lastRadius = 0;
  private lastDiameter = 0;
  private loadingDiameter = 0;
  private controlsDiameter = 0;
  private rotation: number | null = null;
  private lastGhost: readonly [number, number] | null = null;
  private disposed = false;
  private textureUploads = 0;
  private geometryUpdates = 0;
  private readonly updateMilliseconds = new Uint32Array(32);
  private updateSamples = 0;
  private worstUpdateMs = 0;

  constructor(parent: SceneObject) {
    this.root = global.scene.createSceneObject("SpecsNavigationMap"); this.root.setParent(parent);
    this.dataRoot = global.scene.createSceneObject("NavigationMapData"); this.dataRoot.setParent(this.root);
    this.disc = new WorldMeshRenderer(this.dataRoot, "NavigationMapFace", IMAGE_MATERIAL);
    this.background = new WorldMeshRenderer(this.dataRoot, "NavigationMapBackground");
    this.rim = new WorldMeshRenderer(this.root, "NavigationMapRim");
    this.route = new AdaptiveStrokeRenderer(this.dataRoot, "NavigationMapRoute");
    this.heading = new AdaptiveStrokeRenderer(this.dataRoot, "NavigationMapHeading");
    this.tether = new AdaptiveStrokeRenderer(this.dataRoot, "NavigationMapTether");
    this.robot = this.marker("NavigationMapRobot", 0.8);
    this.target = this.marker("NavigationMapTarget", 0.9);
    this.ghost = this.marker("NavigationMapGhost", 0.9);
    this.ghost.hide();
    this.heights = new WorldMeshRenderer(this.dataRoot, "NavigationMapHeights");
    this.resizeLeft = new WorldMeshRenderer(this.root, "NavigationMapResizeLeft");
    this.resizeRight = new WorldMeshRenderer(this.root, "NavigationMapResizeRight");
    this.compass = new WorldMeshRenderer(this.root, "NavigationMapCompass");
    this.follow = new WorldMeshRenderer(this.root, "NavigationMapFollow");
    this.compassIcon = new WorldMeshRenderer(this.root, "NavigationMapCompassIcon");
    this.followIcon = new WorldMeshRenderer(this.root, "NavigationMapFollowIcon");
    this.recenter = new WorldMeshRenderer(this.dataRoot, "NavigationMapRecenter");
    this.scale = new AdaptiveStrokeRenderer(this.root, "NavigationMapScale");
    this.scaleLabel = createText({ parent: this.root, name: "NavigationMapScaleLabel", text: "Loading map…", fontSize: 18, color: COLOR_WHITE,
      position: new vec3(0, 0.3, 0), horizontalAlignment: HorizontalAlignment.Center,
      worldSpaceRect: Rect.create(-4, 4, -1, 1) });
    this.scaleLabel.getSceneObject().getTransform().setLocalRotation(quat.angleAxis(-Math.PI / 2, vec3.right()));
  }
  private marker(name: string, radius: number): WorldMeshRenderer {
    const visual = new WorldMeshRenderer(this.dataRoot, name), geometry = sphereMesh(radius, 12, 8);
    visual.triangles(geometry.positions, geometry.indices, [1, 1, 1, 1], undefined, geometry.normals);
    return visual;
  }
  setVisible(visible: boolean): void { this.root.enabled = visible; }
  place(lowerEdge: vec3, yaw: number, diameterM: number): void {
    const scale = 0.75, radiusCm = diameterM * 50 * scale;
    const transform = this.root.getTransform();
    transform.setWorldPosition(lowerEdge.add(new vec3(Math.sin(yaw) * radiusCm, -6 * scale, Math.cos(yaw) * radiusCm)));
    transform.setWorldRotation(quat.angleAxis(yaw, vec3.up()));
    transform.setWorldScale(vec3.one().uniformScale(scale));
  }
  setRotation(radians: number): void {
    if (this.rotation === radians) return;
    this.rotation = radians;
    this.dataRoot.getTransform().setLocalRotation(quat.angleAxis(radians, vec3.up()));
  }
  draw(snapshot: NavigationMapSnapshot, viewport: NavigationMapController, diameterM: number, ghost: readonly [number, number] | null,
    compassEnabled = true, debug = false, robotDescription: ReadonlyFacts<RobotDescription> | null = null): void {
    if (this.disposed || !this.root.enabled) return;
    const startedAt = Date.now();
    const wasLoading = this.loadingDiameter !== 0;
    this.loadingDiameter = 0;
    this.background.hide();
    const converted = this.pixels.update(snapshot);
    if (converted) this.uploadTexture(snapshot.width, snapshot.height, converted);
    const center = viewport.centerM;
    const changed = snapshot !== this.lastSnapshot || center !== this.lastCenter || viewport.radiusM !== this.lastRadius || diameterM !== this.lastDiameter;
    if (changed) {
      this.geometryUpdates++;
      const frame = projectSpecsMap(snapshot, viewport, diameterM), radiusCm = frame.radius * 100;
      this.projected = frame;
      this.drawDisc(snapshot, center, viewport.radiusM, radiusCm);
      if (diameterM !== this.lastDiameter || wasLoading) {
        const ring = circleMesh(radiusCm * 1.015, radiusCm * 0.05, 1, SEGMENTS);
        this.rim.triangles(ring.positions, ring.indices, [0.125, 0.125, 0.13, 1]);
      }
      const segments: [number, number, number][] = [];
      for (const [x1, y1, x2, y2] of frame.route) segments.push([x1 * 100, 0.3, -y1 * 100], [x2 * 100, 0.3, -y2 * 100]);
      this.route.segments(segments, 0.15, 1, 10000, 0);
      this.robot.object.enabled = frame.robotVisible;
      this.heading.object.enabled = frame.robotVisible;
      this.tether.object.enabled = frame.robotVisible;
      if (frame.robotVisible) {
        const x = frame.robot[0] * 100, z = -frame.robot[1] * 100, yaw = snapshot.robot[2];
        this.robot.object.getTransform().setLocalPosition(new vec3(x, 4, z));
        this.heading.segments([[x, 0.2, z], [x + Math.cos(yaw) * 0.9, 0.2, z - Math.sin(yaw) * 0.9]], 0.2, 1, 10000, 0);
        this.tether.segments([[x, 0.2, z], [x, 3.3, z]], 0.1, 1, 0.2, 0.2);
      }
      this.target.object.enabled = frame.target !== null;
      if (frame.target) this.target.object.getTransform().setLocalPosition(new vec3(frame.target[0] * 100, 0.9, -frame.target[1] * 100));
      this.drawHeights(frame.heights);
      const bar = frame.scaleHalfWidthM * 100, barZ = -radiusCm * 0.72;
      this.scale.segments([[-bar, 0.3, barZ], [bar, 0.3, barZ], [-bar, 0.3, barZ - 0.3], [-bar, 0.3, barZ + 0.3],
        [bar, 0.3, barZ - 0.3], [bar, 0.3, barZ + 0.3]], 0.12, 1, 10000, 0);
      this.scaleLabel.text = `${Number(frame.scaleM.toPrecision(3))} m`;
      this.scaleLabel.getSceneObject().getTransform().setLocalPosition(new vec3(0, 0.4, barZ - 0.6));
      this.recenter.object.enabled = frame.recenter !== null;
      if (frame.recenter) {
        this.recenter.object.getTransform().setLocalPosition(new vec3(frame.recenter[0] * 100, 1, -frame.recenter[1] * 100));
        this.recenter.object.getTransform().setLocalRotation(quat.angleAxis(Math.atan2(frame.robot[1], frame.robot[0]), vec3.up()));
      }
      this.ensureControls(radiusCm);
      this.lastSnapshot = snapshot; this.lastCenter = center; this.lastRadius = viewport.radiusM; this.lastDiameter = diameterM;
    }
    this.compass.setColor(compassEnabled ? [0.9, 0.9, 0.9, 1] : [0.35, 0.35, 0.35, 1]);
    this.follow.setColor(viewport.followingRobot ? [0.9, 0.9, 0.9, 1] : [0.35, 0.35, 0.35, 1]);
    this.compassIcon.setColor(compassEnabled ? [0.1, 0.1, 0.1, 1] : [1, 1, 1, 1]);
    this.followIcon.setColor(viewport.followingRobot ? [0.1, 0.1, 0.1, 1] : [1, 1, 1, 1]);
    if (this.projected) this.drawDebug(snapshot, this.projected, debug, robotDescription);
    if (ghost !== this.lastGhost) {
      this.ghost.object.enabled = ghost !== null;
      if (ghost) this.ghost.object.getTransform().setLocalPosition(new vec3(ghost[0] * 100, 0.9, -ghost[1] * 100));
      this.lastGhost = ghost;
    }
    if (changed || converted) {
      const elapsed = Math.max(0, Date.now() - startedAt);
      this.updateMilliseconds[Math.min(this.updateMilliseconds.length - 1, elapsed)]++;
      this.updateSamples++; this.worstUpdateMs = Math.max(this.worstUpdateMs, elapsed);
    }
  }
  private drawDebug(snapshot: NavigationMapSnapshot, frame: ReturnType<typeof projectSpecsMap>,
    enabled: boolean, description: ReadonlyFacts<RobotDescription> | null): void {
    if (!enabled || !description) { if (this.debugRoot) this.debugRoot.enabled = false; return; }
    const [length, width, height] = description.body_bounds_m;
    const extent = Math.max(Math.hypot(length, width) / 2, 0.24) / frame.metersPerUnit;
    if (Math.hypot(...frame.robot) + extent > frame.radius) { if (this.debugRoot) this.debugRoot.enabled = false; return; }
    if (!this.debugRoot) {
      this.debugRoot = global.scene.createSceneObject("NavigationMapRobotDebug"); this.debugRoot.setParent(this.dataRoot);
      this.debugBox = new AdaptiveStrokeRenderer(this.debugRoot, "NavigationMapRobotBounds");
      this.debugAxes = ["X", "Y", "Z"].map(axis => new AdaptiveStrokeRenderer(this.debugRoot!, `NavigationMapRobotAxis${axis}`));
    }
    this.debugRoot.enabled = true;
    const transform = this.debugRoot.getTransform();
    transform.setLocalPosition(new vec3(frame.robot[0] * 100, 0.2 + description.base_height_m * 100 / frame.metersPerUnit, -frame.robot[1] * 100));
    transform.setLocalRotation(quat.angleAxis(snapshot.robot[2], vec3.up()));
    transform.setLocalScale(vec3.one().uniformScale(1 / frame.metersPerUnit));
    const key = `${length},${width},${height},${description.base_height_m}`;
    if (this.debugKey === key) return;
    this.debugKey = key;
    const minY = -description.base_height_m * 100, maxY = minY + height * 100, hx = length * 50, hz = width * 50;
    const corners: [number, number, number][] = [];
    for (const y of [minY, maxY]) for (const x of [-hx, hx]) for (const z of [-hz, hz]) corners.push([x, y, z]);
    const points: [number, number, number][] = [];
    for (const [a, b] of [[0,1],[0,2],[1,3],[2,3],[4,5],[4,6],[5,7],[6,7],[0,4],[1,5],[2,6],[3,7]]) points.push(corners[a], corners[b]);
    this.debugBox!.segments(points, 0.1, 1, 10000, 0);
    const axes: [number, number, number][] = [[24,0,0],[0,24,0],[0,0,-24]];
    const colors: [number, number, number][] = [[1,0,0],[0,1,0],[0,0,1]];
    axes.forEach((end, index) => this.debugAxes[index].segments([[0,0,0],end], 0.15, 1, 10000, 0, false, colors[index]));
  }
  private drawControls(radius: number): void {
    const handle = strokeMesh2D([[-0.5, -2.8, -0.8, -1.4], [-0.8, -1.4, -0.9, 0],
      [-0.9, 0, -0.8, 1.4], [-0.8, 1.4, -0.5, 2.8]], [1, 1, 1, 1], 0.3, "xz");
    for (const [mesh, side] of [[this.resizeLeft, -1], [this.resizeRight, 1]] as const) {
      mesh.triangles(handle.positions, handle.indices, [0.7, 0.7, 0.7, 1]);
      mesh.object.getTransform().setLocalPosition(new vec3(side * radius * 1.08, 0.2, 0));
      mesh.object.getTransform().setLocalRotation(side === 1 ? quat.angleAxis(Math.PI, vec3.up()) : quat.quatIdentity());
    }
    const button = circleMesh(1.15, 1.15, 1, 24);
    for (const [mesh, x] of [[this.compass, -1.3], [this.follow, 1.3]] as const) {
      mesh.triangles(button.positions, button.indices, [0.9, 0.9, 0.9, 1]);
      mesh.object.getTransform().setLocalPosition(new vec3(x, 0.25, radius + 2));
    }
    const icons = [
      { mesh: this.compassIcon, x: -1.3, lines: [[0,0.7,-0.45,-0.55],[-0.45,-0.55,0,-0.3],[0,-0.3,0.45,-0.55],[0.45,-0.55,0,0.7]] },
      { mesh: this.followIcon, x: 1.3, lines: [[-0.5,0.6,0.5,0.6],[0.5,0.6,0.3,0.1],[0.3,0.1,0.55,-0.2],
        [0.55,-0.2,-0.55,-0.2],[-0.55,-0.2,-0.3,0.1],[-0.3,0.1,-0.5,0.6],[0,-0.2,0,-0.8]] },
    ];
    for (const icon of icons) {
      const glyph = strokeMesh2D(icon.lines, icon.lines.map(() => 1), 0.13, "xz");
      icon.mesh.triangles(glyph.positions, glyph.indices, [0.1, 0.1, 0.1, 1]);
      icon.mesh.object.getTransform().setLocalPosition(new vec3(icon.x, 0.4, radius + 2));
    }
    const arrow = strokeMesh2D([[-0.65, -0.55, 0.65, 0], [0.65, 0, -0.65, 0.55]], [1, 1], 0.22, "xz");
    this.recenter.triangles(arrow.positions, arrow.indices, [1, 1, 1, 1]);
  }
  private ensureControls(radius: number): void {
    if (this.controlsDiameter === radius) return;
    this.controlsDiameter = radius;
    this.drawControls(radius);
  }
  clear(): void {
    if (this.lastSnapshot === null) return;
    this.lastSnapshot = null; this.lastCenter = null; this.lastGhost = null;
    this.projected = null;
    this.disc.hide(); this.route.hide(); this.robot.hide(); this.target.hide(); this.ghost.hide();
    this.heading.hide(); this.tether.hide(); this.heights.hide(); this.pixels.clear();
    if (this.debugRoot) this.debugRoot.enabled = false;
  }
  loading(diameterM: number): void {
    if (!this.root.enabled || this.disposed) return;
    this.clear();
    if (diameterM === this.loadingDiameter) return;
    this.loadingDiameter = diameterM;
    const radius = diameterM * 50, disc = circleMesh(radius, radius, 1, SEGMENTS), rim = circleMesh(radius * 1.015, radius * 0.05, 1, SEGMENTS);
    this.background.triangles(disc.positions, disc.indices, [0.125, 0.125, 0.13, 1]);
    this.rim.triangles(rim.positions, rim.indices, [0.2, 0.2, 0.2, 1]);
    this.scale.hide(); this.target.hide(); this.robot.hide(); this.ghost.hide(); this.recenter.hide();
    this.scaleLabel.text = "Loading map…";
    this.scaleLabel.getSceneObject().getTransform().setLocalPosition(new vec3(0, 0.4, 0));
    this.ensureControls(radius);
  }
  private uploadTexture(width: number, height: number, rgba: Uint8Array): void {
    const w = width + 2, h = height + 2;
    if (!this.texture || this.textureWidth !== w || this.textureHeight !== h) {
      this.texture = ProceduralTextureProvider.createWithFormat(w, h, TextureFormat.RGBA8Unorm);
      this.textureWidth = w; this.textureHeight = h; this.padded = new Uint8Array(w * h * 4);
      (this.disc.material.mainPass as Pass & { baseTex: Texture }).baseTex = this.texture;
      // Only the one-pixel border persists between uploads. Interior pixels are
      // fully replaced below, so initializing them on every snapshot is wasteful.
      for (let i = 0; i < w * h; i++) {
        const p = i * 4; this.padded[p] = this.padded[p + 1] = this.padded[p + 2] = 32; this.padded[p + 3] = 255;
      }
    }
    for (let y = 0; y < height; y++) this.padded.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), ((y + 1) * w + 1) * 4);
    (this.texture.control as ProceduralTextureProvider).setPixels(0, 0, w, h, this.padded);
    this.textureUploads++;
  }
  diagnostics(): { textureUploads: number; geometryUpdates: number; textureBytes: number; visible: boolean;
    updateSamples: number; p95UpdateMs: number; worstUpdateMs: number } {
    const threshold = Math.ceil(this.updateSamples * 0.95);
    let count = 0, p95 = 0;
    for (let i = 0; i < this.updateMilliseconds.length && count < threshold; i++) { count += this.updateMilliseconds[i]; p95 = i; }
    return { textureUploads: this.textureUploads, geometryUpdates: this.geometryUpdates,
      textureBytes: this.padded.byteLength, visible: this.root.enabled, updateSamples: this.updateSamples,
      p95UpdateMs: p95, worstUpdateMs: this.worstUpdateMs };
  }
  private drawDisc(snapshot: NavigationMapSnapshot, center: readonly [number, number], radiusM: number, radiusCm: number): void {
    const positions: number[] = [0, 0, 0], uvs: number[] = [], indices: number[] = [];
    const uv = (x: number, y: number) => {
      uvs.push((1 + (center[0] + x * radiusM - snapshot.origin[0]) / snapshot.resolution) / this.textureWidth,
        (1 + (center[1] + y * radiusM - snapshot.origin[1]) / snapshot.resolution) / this.textureHeight);
    };
    uv(0, 0);
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = i / SEGMENTS * Math.PI * 2, x = Math.cos(a), y = Math.sin(a);
      positions.push(x * radiusCm, 0, -y * radiusCm); uv(x, y);
      if (i) indices.push(0, i, i + 1);
    }
    this.disc.triangles(positions, indices, [1, 1, 1, 1], uvs);
  }
  private drawHeights(heights: readonly { position: readonly [number, number, number]; hue: number }[]): void {
    const vertices: number[] = [], indices: number[] = [];
    const stride = Math.max(1, Math.ceil(heights.length / MAX_HEIGHT_SAMPLES));
    for (let index = 0; index < heights.length; index += stride) {
      const { position: [x, y, z], hue } = heights[index];
      const rgb = hsl(hue, 0.72, 0.62), start = vertices.length / 12, size = 0.15;
      for (const [dx, dz] of [[-size, -size], [size, -size], [-size, size], [size, size]]) {
        vertices.push(x * 100 + dx, z * 100, -y * 100 + dz, 0, 1, 0, ...rgb, 1, 0, 0);
      }
      indices.push(start, start + 1, start + 2, start + 2, start + 1, start + 3);
    }
    this.heights.upload(vertices, indices);
  }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.pixels.clear(); this.root.destroy(); this.texture = null; } }
}

function hsl(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation, h = hue * 6;
  const x = chroma * (1 - Math.abs(h % 2 - 1)), m = lightness - chroma / 2;
  const rgb = h < 1 ? [chroma, x, 0] : h < 2 ? [x, chroma, 0] : h < 3 ? [0, chroma, x] :
    h < 4 ? [0, x, chroma] : h < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}
