import { NavigationMapController, clipNavigationMapSegment, navigationMapContains, panNavigationMap } from "DimOSARClient.lspkg/Scripts/DimOSARClient/navigation/NavigationMapProjection";
import type { NavigationMapSnapshot } from "DimOSARClient.lspkg/Scripts/DimOSARClient/ClientContracts";

type XY = readonly [number, number];
export type MapRegion = "face" | "sphere" | "resize" | "compass" | "pin" | "recenter";
type Gesture = { owner: string; region: MapRegion; start: XY; center: XY; marker: XY; radius: number;
  at: number; moved: boolean; motion: boolean; allowFaceTap: boolean; rotation: number; reference: string; generation: number };
type Scale = { owner: string; distance: number; radius: number; angle: number; rotation: number };

/** Map coordinates are local metres; times are monotonic seconds. */
export class SpecsMapGesture {
  readonly viewport = new NavigationMapController();
  diameterM = 0.22;
  compassEnabled = true;
  manualRotation = 0;
  ghost: XY | null = null;
  private gesture: Gesture | null = null;
  private scale: Scale | null = null;
  private snapshot: NavigationMapSnapshot | null = null;
  private source: { reference: string; generation: number } | null = null;
  private canSend = false;
  private clickToWalk = true;

  constructor(private readonly ports: {
    viewport(value: { center?: XY; radiusM: number } | null): void;
    submit(value: XY): void;
    cancelPending(): void;
  }) {}

  get active(): boolean { return this.gesture !== null; }
  get owner(): string | null { return this.gesture?.owner ?? null; }
  get region(): MapRegion | null { return this.gesture?.region ?? null; }
  get secondOwner(): string | null { return this.scale?.owner ?? null; }
  get metersPerUnit(): number { return this.viewport.radiusM / (this.diameterM / 2); }

  open(): void { this.ports.viewport(this.viewport.request); }
  close(): void {
    this.abort(true); this.snapshot = null; this.source = null; this.viewport.follow(); this.ports.viewport(null);
  }
  update(snapshot: NavigationMapSnapshot | null, canSend: boolean, clickToWalk: boolean): void {
    if (!snapshot && this.snapshot) this.abort(true);
    if (snapshot && this.source && (snapshot.odom_reference_id !== this.source.reference ||
        snapshot.source_generation !== this.source.generation)) {
      const changedReference = snapshot.odom_reference_id !== this.source.reference;
      this.abort(true);
      if (changedReference) { this.viewport.follow(snapshot?.robot); this.ports.viewport(this.viewport.request); }
    }
    if (snapshot) this.source = { reference: snapshot.odom_reference_id, generation: snapshot.source_generation };
    this.snapshot = snapshot; this.canSend = canSend; this.clickToWalk = clickToWalk;
    if ((!canSend || !clickToWalk) && this.gesture) { this.gesture.motion = false; this.ghost = null; }
    if (!this.gesture && snapshot) this.viewport.updateCenter(snapshot.robot);
  }
  begin(owner: string, region: MapRegion, point: XY, time: number, rotation: number, allowFaceTap = false): boolean {
    if (this.gesture || !point.every(Number.isFinite)) return false;
    const snap = this.snapshot;
    this.gesture = { owner, region, start: point, center: this.viewport.centerM,
      marker: snap ? this.viewport.toLocal([snap.robot[0], snap.robot[1]], this.metersPerUnit) : [0, 0], radius: this.diameterM / 2,
      at: time, moved: false, motion: this.canSend && this.clickToWalk && !!snap, allowFaceTap, rotation,
      reference: snap?.odom_reference_id ?? "", generation: snap?.source_generation ?? -1 };
    return true;
  }
  hold(owner: string, point: XY, time: number, deltaS: number): void {
    const g = this.gesture;
    if (!g || g.owner !== owner || this.scale || !point.every(Number.isFinite)) return;
    if (Math.hypot(point[0] - g.start[0], point[1] - g.start[1]) >= 0.012) g.moved = true;
    if (!g.moved || g.region === "face" && time - g.at < 0.18) return;
    const alpha = 1 - Math.exp(-18 * Math.max(0, Math.min(deltaS, 0.1)));
    if (g.region === "face") {
      const target = panNavigationMap(g.center, g.start, point, this.metersPerUnit), current = this.viewport.centerM;
      this.viewport.panTo([current[0] + (target[0] - current[0]) * alpha, current[1] + (target[1] - current[1]) * alpha]);
      this.ports.viewport(this.viewport.request);
    } else if (g.region === "resize") {
      const target = Math.max(0.16, Math.min(0.42, 2 * (g.radius + Math.hypot(...point) - Math.hypot(...g.start))));
      this.diameterM += (target - this.diameterM) * alpha;
    } else if (g.region === "sphere") {
      const drop: XY = [g.marker[0] + point[0] - g.start[0], g.marker[1] + point[1] - g.start[1]];
      this.ghost = g.motion && this.valid(drop) ? drop : null;
    }
  }
  beginScale(owner: string, first: XY, second: XY): boolean {
    const g = this.gesture;
    if (!g || g.owner === owner || this.scale || !["face", "sphere", "resize"].includes(g.region)) return false;
    const distance = Math.hypot(second[0] - first[0], second[1] - first[1]);
    if (!Number.isFinite(distance) || distance < 0.015) return false;
    g.moved = true; this.ghost = null;
    this.scale = { owner, distance, radius: this.viewport.radiusM,
      angle: Math.atan2(second[1] - first[1], second[0] - first[0]), rotation: this.manualRotation };
    return true;
  }
  holdScale(first: XY, second: XY): void {
    const scale = this.scale;
    if (!scale) return;
    const distance = Math.hypot(second[0] - first[0], second[1] - first[1]);
    if (!Number.isFinite(distance)) return;
    if (!this.compassEnabled && distance >= 0.015) {
      const value = scale.rotation + Math.atan2(second[1] - first[1], second[0] - first[0]) - scale.angle;
      this.manualRotation = ((value + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    }
    if (this.viewport.zoom(scale.radius * scale.distance / Math.max(distance, 0.015))) this.ports.viewport(this.viewport.request);
  }
  endScale(remainingOwner: string, point: XY): void {
    if (!this.scale || !this.gesture) return;
    this.scale = null;
    this.gesture = { ...this.gesture, owner: remainingOwner, region: "face", start: point,
      center: this.viewport.centerM, radius: this.diameterM / 2, moved: true, motion: false };
  }
  disallowFaceTap(owner: string): void {
    if (this.gesture?.owner === owner) this.gesture.allowFaceTap = false;
  }
  release(owner: string, point: XY, time: number, rotation: number): void {
    const g = this.gesture, snap = this.snapshot;
    if (!g || g.owner !== owner || this.scale) return;
    if (Math.hypot(point[0] - g.start[0], point[1] - g.start[1]) >= 0.012) g.moved = true;
    if (!g.moved && g.region === "compass") this.compassEnabled = !this.compassEnabled;
    else if (!g.moved && (g.region === "pin" || g.region === "recenter")) {
      if (g.region === "pin") this.viewport.toggleFollow(snap?.robot); else this.viewport.follow(snap?.robot);
      this.ports.viewport(this.viewport.request);
    } else if (g.motion && this.canSend && this.clickToWalk && snap && snap.odom_reference_id === g.reference &&
        snap.source_generation === g.generation && Math.abs(g.rotation - rotation) < 0.001) {
      const tap = g.region === "face" && g.allowFaceTap && !g.moved && time - g.at <= 0.35;
      const drop = g.region === "sphere" && g.moved;
      const target: XY = drop ? [g.marker[0] + point[0] - g.start[0], g.marker[1] + point[1] - g.start[1]] : point;
      if ((tap || drop) && this.valid(target)) this.ports.submit(this.viewport.toNative(target, this.metersPerUnit));
    }
    this.abort(false);
  }
  abort(cancelPending: boolean): void {
    this.gesture = null; this.scale = null; this.ghost = null;
    if (cancelPending) this.ports.cancelPending();
  }
  private valid(point: XY): boolean {
    return !!this.snapshot && point.every(Number.isFinite) && Math.hypot(...point) <= this.diameterM / 2 &&
      navigationMapContains(this.snapshot, this.viewport.toNative(point, this.metersPerUnit));
  }
}

/** Converts each immutable grid only once; native texture upload remains a host operation. */
export class SpecsMapPixels {
  private cells: NavigationMapSnapshot["cells"] | null = null;
  private bytes = new Uint8Array(0);
  private rgba = new Uint8Array(0);
  private width = 0;
  private height = 0;
  uploads = 0;

  update(snapshot: NavigationMapSnapshot): Uint8Array | null {
    if (snapshot.cells === this.cells && snapshot.width === this.width && snapshot.height === this.height) return null;
    const count = snapshot.width * snapshot.height;
    if (!Number.isSafeInteger(count) || count <= 0 || snapshot.width > 240 || snapshot.height > 240 || snapshot.cells.length !== count)
      throw new Error("Invalid navigation map dimensions");
    if (this.bytes.length !== count) { this.bytes = new Uint8Array(count); this.rgba = new Uint8Array(count * 4); }
    snapshot.cells.copyDisplayBytes(this.bytes);
    for (let i = 0; i < count; i++) {
      const value = this.bytes[i], offset = i * 4;
      if (value === 0) this.rgba[offset] = this.rgba[offset + 1] = this.rgba[offset + 2] = 36;
      else {
        const amount = (value - 1) / 100;
        this.rgba[offset] = Math.round((0.21 + 0.61 * amount) * 255);
        this.rgba[offset + 1] = Math.round((0.25 + 0.51 * amount) * 255);
        this.rgba[offset + 2] = Math.round((0.26 + 0.41 * amount) * 255);
      }
      this.rgba[offset + 3] = 255;
    }
    this.cells = snapshot.cells; this.width = snapshot.width; this.height = snapshot.height; this.uploads++;
    return this.rgba;
  }
  clear(): void { this.cells = null; this.bytes = new Uint8Array(0); this.rgba = new Uint8Array(0); this.width = this.height = 0; }
}

/** SDK-free geometry for the native view; all map-space outputs use local metres. */
export function projectSpecsMap(snapshot: NavigationMapSnapshot, viewport: NavigationMapController, diameterM: number, includeRoute = true) {
  const radius = diameterM / 2, metersPerUnit = viewport.radiusM / radius;
  const local = (point: XY): XY => viewport.toLocal(point, metersPerUnit);
  const robot = local([snapshot.robot[0], snapshot.robot[1]]), distance = Math.hypot(...robot);
  const target = snapshot.target ? local(snapshot.target) : null;
  const route: [number, number, number, number][] = [];
  if (includeRoute) for (const [x1, y1, x2, y2] of snapshot.route) {
    const segment = clipNavigationMapSegment(local([x1, y1]), local([x2, y2]), radius - 0.0015);
    if (segment) route.push(segment);
  }
  const ideal = viewport.radiusM * 0.5, magnitude = 10 ** Math.floor(Math.log10(ideal));
  const scaleM = [1, 2, 5, 10].map(value => value * magnitude).find(value => value >= ideal) ?? magnitude;
  return { radius, metersPerUnit, robot, robotVisible: distance <= radius,
    recenter: distance > radius ? [robot[0] / distance * radius * 0.89, robot[1] / distance * radius * 0.89] as XY : null,
    target: target && Math.hypot(...target) <= radius ? target : null, route, scaleM,
    scaleHalfWidthM: scaleM / metersPerUnit / 2 };
}

/** Owns the native map subscription and bridges navigation intent to ClientCore. */
export class SpecsMapSession {
  readonly gesture: SpecsMapGesture;
  private opened = false;
  private epoch = 0;
  private shown: NavigationMapSnapshot | null = null;
  private nextRedraw = 0;
  private source: { reference: string; generation: number } | null = null;
  constructor(private readonly session: {
    setNavigationMapViewport(value: { center?: XY; radiusM: number } | null): void;
    submitNavigationMapGoal(value: XY): Promise<void>;
    cancelPendingNavigationMapGoal(): void;
  }, private readonly feedback: (message: string, state: "pending" | "success" | "error") => void) {
    this.gesture = new SpecsMapGesture({
      viewport: value => this.session.setNavigationMapViewport(value),
      cancelPending: () => this.session.cancelPendingNavigationMapGoal(),
      submit: value => {
        const epoch = this.epoch; this.feedback("Sending goal…", "pending");
        try {
          void this.session.submitNavigationMapGoal(value).then(() => {
            if (this.opened && epoch === this.epoch) this.feedback("Goal sent", "success");
          }, error => this.reportError(epoch, error));
        } catch (error) { this.reportError(epoch, error); }
      },
    });
  }
  private reportError(epoch: number, error: unknown): void {
    if (this.opened && epoch === this.epoch) this.feedback(error instanceof Error ? error.message : String(error), "error");
  }
  update(open: boolean, latest: NavigationMapSnapshot | null, canSend: boolean, clickToWalk: boolean,
    now: number): NavigationMapSnapshot | null {
    if (open !== this.opened) {
      this.opened = open; this.epoch++;
      if (open) this.gesture.open(); else this.gesture.close();
    }
    const snapshot = open ? latest : null;
    if (this.source && (!snapshot || this.source.reference !== snapshot.odom_reference_id ||
        this.source.generation !== snapshot.source_generation)) this.epoch++;
    const previous = this.shown;
    if (!snapshot || !previous || previous.subscription_id !== snapshot.subscription_id ||
        previous.source_generation !== snapshot.source_generation || previous.odom_reference_id !== snapshot.odom_reference_id ||
        previous.shared_frame_id !== snapshot.shared_frame_id ||
        previous.target?.[0] !== snapshot.target?.[0] || previous.target?.[1] !== snapshot.target?.[1] ||
        (snapshot !== previous && now >= this.nextRedraw)) {
      this.shown = snapshot;
      this.nextRedraw = now + 0.4;
    }
    this.source = snapshot ? { reference: snapshot.odom_reference_id, generation: snapshot.source_generation } : null;
    if (open) this.gesture.update(this.shown, canSend, clickToWalk);
    return this.shown;
  }
  dispose(): void { if (this.opened) { this.opened = false; this.epoch++; this.gesture.close(); } }
}
