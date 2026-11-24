import type { NavigationMapSnapshot } from "../ClientContracts";

type XY = readonly [number, number];

/** Portable viewport state, with physical dock and SDK input left to the host. */
export class NavigationMapController {
  centerM: XY = [0, 0];
  radiusM = 4;
  private panCenterM: XY | null = null;

  get followingRobot(): boolean { return this.panCenterM === null; }
  get request(): { center?: XY; radiusM: number } {
    return { center: this.panCenterM ?? undefined, radiusM: this.radiusM };
  }

  follow(robot?: readonly [number, number, number]): void {
    this.panCenterM = null;
    if (robot) this.updateCenter(robot);
  }

  toggleFollow(robot?: readonly [number, number, number]): void {
    if (this.followingRobot) this.panCenterM = this.centerM;
    else this.follow(robot);
  }

  updateCenter(robot: readonly [number, number, number]): void {
    const [x, y] = this.panCenterM ?? robot;
    if (this.centerM[0] !== x || this.centerM[1] !== y) this.centerM = [x, y];
  }

  panTo(center: XY): void { this.centerM = this.panCenterM = center; }

  zoom(radius: number): boolean {
    const next = Math.max(0.5, Math.min(radius, 20));
    if (next === this.radiusM) return false;
    this.radiusM = next;
    return true;
  }

  toNative(point: XY, metersPerUnit: number): XY {
    return [this.centerM[0] + point[0] * metersPerUnit, this.centerM[1] + point[1] * metersPerUnit];
  }

  toLocal(point: XY, metersPerUnit: number): XY {
    return [(point[0] - this.centerM[0]) / metersPerUnit, (point[1] - this.centerM[1]) / metersPerUnit];
  }
}

export function navigationMapContains(snapshot: NavigationMapSnapshot, point: XY): boolean {
  const x = (point[0] - snapshot.origin[0]) / snapshot.resolution;
  const y = (point[1] - snapshot.origin[1]) / snapshot.resolution;
  return x >= 0 && y >= 0 && x < snapshot.width && y < snapshot.height;
}

export function panNavigationMap(center: XY, start: XY, end: XY, metersPerUnit: number): XY {
  return [center[0] + (start[0] - end[0]) * metersPerUnit,
    center[1] + (start[1] - end[1]) * metersPerUnit];
}

export function clipNavigationMapSegment(start: XY, end: XY, radius: number): [number, number, number, number] | null {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return null;
  const b = start[0] * dx + start[1] * dy;
  const c = start[0] * start[0] + start[1] * start[1] - radius * radius;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const near = Math.max(0, (-b - Math.sqrt(discriminant)) / a), far = Math.min(1, (-b + Math.sqrt(discriminant)) / a);
  if (far <= near) return null;
  return [start[0] + near * dx, start[1] + near * dy, start[0] + far * dx, start[1] + far * dy];
}
