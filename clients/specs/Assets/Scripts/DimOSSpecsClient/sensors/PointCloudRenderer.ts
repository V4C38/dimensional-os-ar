import { type ClientTrackingOrigin, mapToClientTrackingPoint } from "DimOSARClient.lspkg/Scripts/DimOSARClient/localization/ClientTracking";

import { LidarFrameSampler } from "DimOSARClient.lspkg/Scripts/DimOSARClient/sensors/LidarRendering";
import { type LidarDisplayMode } from "DimOSARClient.lspkg/Scripts/DimOSARClient/sensors/LidarDisplay";
import type { ReadonlyFacts, Quat, Vec3 } from "DimOSARClient.lspkg/Scripts/DimOSARClient/ClientContracts";
import { clientTrackingToSpecsPoint } from "../utilities/SpecsCoordinates";

const DOT_MATERIAL = requireAsset("../../../Materials/LidarDot.mat") as Material;
export const SPECS_LIDAR_MAX_POINTS = 1000;
const CORNERS = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;

export function composeLidarPoint(point: Readonly<Vec3>, origin: ReadonlyFacts<ClientTrackingOrigin>): Vec3 {
  return clientTrackingToSpecsPoint(mapToClientTrackingPoint(point, origin));
}

@component
export class PointCloudRenderer extends BaseScriptComponent {
  @input("int", "1000")
  maxPoints: number = SPECS_LIDAR_MAX_POINTS;

  private visual: RenderMeshVisual | null = null;
  private builder: MeshBuilder | null = null;
  private readonly indices: number[] = [];
  private readonly vertices: number[] = [];
  private nextCloudAt = -Infinity;
  private lastStyle: readonly (number | string | undefined)[] = [];
  private viewportHeight = 0;
  private positions: readonly Vec3[] = [];
  private positionPoints: readonly Readonly<Vec3>[] | null = null;
  private positionOrigin: ReadonlyFacts<ClientTrackingOrigin> | null = null;
  private readonly sampler = new LidarFrameSampler<ReadonlyFacts<ClientTrackingOrigin>>(composeLidarPoint,
    { maximum: SPECS_LIDAR_MAX_POINTS, minimum: 250, default: SPECS_LIDAR_MAX_POINTS });
  private diagnosticRobot: Readonly<Vec3> | null = null;

  onAwake(): void {
    this.visual = this.getSceneObject().getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    if (!this.visual) throw new Error("PointCloudRenderer requires RenderMeshVisual");
    this.visual.mainMaterial = DOT_MATERIAL.clone();
    this.visual.meshShadowMode = MeshShadowMode.None;
    this.visual.setRenderOrder(-100);
    const pass = this.visual.mainMaterial.mainPass as Pass & { blendMode: BlendMode; depthWrite: boolean; twoSided: boolean };
    pass.blendMode = BlendMode.Normal; pass.depthWrite = false; pass.twoSided = true;
    this.builder = new MeshBuilder([{ name: "position", components: 3 }, { name: "color", components: 4 }, { name: "texture0", components: 2 }]);
    this.builder.topology = MeshTopology.Triangles; this.builder.indexType = MeshIndexType.UInt16;
    for (let i = 0; i < SPECS_LIDAR_MAX_POINTS; i++) {
      const v = i * 4; this.indices.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
    }
    this.hide();
  }

  apply(input: { points: readonly Readonly<Vec3>[] | null; origin: ReadonlyFacts<ClientTrackingOrigin> | null;
    mode?: LidarDisplayMode; robot?: Readonly<Vec3> | null; baseHeightM?: number; orientation?: Readonly<Quat>;
    bounds?: Readonly<Vec3>; pointLimit?: number; obstacleRangeM?: number; viewportHeight?: number }): void {
    const mode = input.mode ?? "full", points = input.points, origin = input.origin;
    if (!origin || !points?.length || mode === "off") { this.hide(); return; }
    if (!this.visual || !this.builder) throw new Error("PointCloudRenderer is not initialized");
    const height = input.viewportHeight ?? 1024;
    if (this.viewportHeight !== height) {
      (this.visual.mainMaterial.mainPass as Pass & { viewportHeightPx: number }).viewportHeightPx = height;
      this.viewportHeight = height;
    }
    const pointLimit = Math.min(SPECS_LIDAR_MAX_POINTS, input.pointLimit ?? this.maxPoints);
    const [length, width] = input.bounds ?? [];
    const [lastMode, lastLimit, lastRange, lastHeight, lastLength, lastWidth] = this.lastStyle;
    const settingsChanged = !this.visual.enabled || origin !== this.positionOrigin || mode !== lastMode ||
      pointLimit !== lastLimit || input.obstacleRangeM !== lastRange || input.baseHeightM !== lastHeight ||
      length !== lastLength || width !== lastWidth;
    const now = getTime();
    if (!settingsChanged && (points === this.positionPoints || now < this.nextCloudAt)) return;
    this.lastStyle = [mode, pointLimit, input.obstacleRangeM, input.baseHeightM, length, width];
    this.nextCloudAt = now + 1;
    this.diagnosticRobot = input.robot ?? null;
    const frame = this.sampler.sample({ ...input, points, origin, mode, pointLimit });
    // Like WebXR's scene-root point cloud, these vertices are already in world
    // coordinates. Keep authored/ancestor transforms out of the cloud entirely.
    const transform = this.getSceneObject().getTransform();
    transform.setWorldPosition(vec3.zero()); transform.setWorldRotation(quat.quatIdentity());
    transform.setWorldScale(vec3.one());
    this.visual.enabled = true;
    if (!frame.positionsChanged && !frame.colorsChanged) return;
    this.positions = frame.positions;
    this.positionPoints = points;
    this.positionOrigin = origin;
    const count = frame.positions.length;
    const vertices = this.vertices;
    vertices.length = 0;
    for (let i = 0; i < count; i++) {
      for (const [u, v] of CORNERS) {
        vertices.push(...frame.positions[i], ...frame.colors[i], u, v);
      }
    }
    if (this.builder.getVerticesCount()) this.builder.eraseVertices(0, this.builder.getVerticesCount());
    if (this.builder.getIndicesCount()) this.builder.eraseIndices(0, this.builder.getIndicesCount());
    this.builder.appendVerticesInterleaved(vertices); this.builder.appendIndices(this.indices.slice(0, count * 6));
    if (!this.builder.isValid()) throw new Error("LiDAR billboard mesh is invalid");
    this.builder.updateMesh(); this.visual.mesh = this.builder.getMesh();
  }
  /** Bounded debug evidence: compare the raw sample, CPU transform and native projection. */
  spatialDiagnostics(camera: Camera): Record<string, unknown> {
    const transform = this.getSceneObject().getTransform();
    const matrix = transform.getWorldTransform();
    return { points: this.positionPoints?.length ?? 0, renderedPoints: this.positions.length,
      origin: this.positionOrigin,
      samples: this.positions.slice(0, 3).map((world, index) => {
        const renderedWorld = matrix.multiplyPoint(new vec3(...world));
        const screen = camera.worldSpaceToScreenSpace(renderedWorld);
        const rawIndex = Math.floor(index * (this.positionPoints?.length ?? 0) / Math.max(1, this.positions.length));
        const raw = this.positionPoints?.[rawIndex];
        const planarDistanceM = raw && this.diagnosticRobot ? Math.hypot(raw[0] - this.diagnosticRobot[0], raw[1] - this.diagnosticRobot[1]) : null;
        return { map: raw, worldCm: world, planarDistanceM,
          renderedWorldCm: [renderedWorld.x, renderedWorld.y, renderedWorld.z], screen: [screen.x, screen.y] };
      }) };
  }
  hide(): void { if (this.visual?.enabled) this.visual.enabled = false; }
  clear(): void { this.hide(); this.sampler.clear(); this.positionPoints = null; this.positionOrigin = null; }
}
