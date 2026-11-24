import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { NavigationMapSnapshot } from "@dimos-ar-client/ClientContracts";
import { clipNavigationMapSegment, navigationMapContains, panNavigationMap } from "@dimos-ar-client/navigation/NavigationMapProjection";
import { WebXRNavigationMap } from "../src/navigation/WebXRNavigationMap";
import { closestPoint } from "../src/input/WebXRInteraction";

const snapshot: NavigationMapSnapshot = {
  subscription_id: "map-1", sequence: 1, snapshot_sequence: 1, odom_reference_id: "recording", source_generation: 0,
  shared_frame_id: "shared", map_odom_rotation: [0, 0, 0, 1],
  origin: [-6, -6], width: 12, height: 12, resolution: 1,
  cells: { length: 144, costAt: () => -1, copyDisplayBytes: destination => { destination.fill(0); } }, heights: [], robot: [0, 0, 0], target: [2, 2], route: [[0, 0, 2, 2]],
};

function fixture(motion = true) {
  const submit = vi.fn().mockResolvedValue(undefined);
  const setViewport = vi.fn(), cancelPending = vi.fn();
  const cancelRoute = vi.fn().mockResolvedValue(undefined);
  const map = new WebXRNavigationMap({ view: () => snapshot, robotDescription: () => ({ body_bounds_m: [0.6, 0.3, 0.4], base_height_m: 0.2 }), submit, setViewport,
    cancelPending, cancelRoute, error: vi.fn() });
  map.update(true, true, motion, false, new THREE.Vector3(), 0, 1, 0.2);
  const face = map.object.getObjectByName("Navigation map face")!;
  const sphere = map.object.getObjectByName("Navigation map robot sphere")!;
  const at = (x: number, z: number) => {
    const origin = new THREE.Vector3(x, 1, z + map.object.position.z);
    const point = new THREE.Vector3(x, map.object.position.y, z + map.object.position.z);
    return { ray: { origin: origin.toArray(), direction: [0, -1, 0] }, point };
  };
  return { map, submit, setViewport, cancelPending, face, sphere, at };
}

describe("navigation map geometry", () => {
  it("aligns native map axes using the matching localization and falls back to the initial headset heading", () => {
    const { map } = fixture();
    const data = (map as any).mapData as THREE.Group;
    const headset = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
    map.setOrientation(headset, 0.2, null);
    expect(data.rotation.z).toBeCloseTo(Math.PI / 2 + 0.4 - 0.2);
    map.setOrientation(new THREE.Quaternion(), 0.2, { shared_frame_id: "shared", odom_reference_id: "recording", orientation: [0, 0, Math.sin(0.3), Math.cos(0.3)] });
    expect(data.rotation.z).toBeCloseTo(Math.PI / 2 - 0.6 - 0.2);
    map.setOrientation(new THREE.Quaternion(), 0.2, { shared_frame_id: "other", odom_reference_id: "recording", orientation: [0, 0, 0, 1] });
    expect(data.rotation.z).toBeCloseTo(Math.PI / 2 + 0.4 - 0.2);
    map.dispose();
  });

  it("toggles the compass and recenters the robot without submitting navigation", () => {
    const f = fixture();
    f.map.setOrientation(new THREE.Quaternion(), 0, null);
    const activate = (name: string) => {
      const control = f.map.object.getObjectByName(name)!;
      control.updateWorldMatrix(true, false);
      const point = control.getWorldPosition(new THREE.Vector3());
      const ray = { origin: [point.x, point.y + 1, point.z], direction: [0, -1, 0] };
      expect(f.map.begin(control, ray, point, 10)).toBe(true);
      f.map.complete(ray, 20);
      f.map.abort();
    };
    activate("Compass orientation");
    f.map.setOrientation(new THREE.Quaternion(), 0, null);
    expect(((f.map as any).mapData as THREE.Group).rotation.z).toBe(0);
    f.map.viewport.panTo([2, 2]);
    activate("Follow robot");
    expect(f.map.viewport.followingRobot).toBe(true);
    expect(f.submit).not.toHaveBeenCalled();
    f.map.dispose();
  });

  it("transforms a rotated map tap back to native navigation coordinates", () => {
    const f = fixture();
    f.map.setOrientation(new THREE.Quaternion(), 0, null);
    const point = f.at(0.07, 0);
    expect(f.map.begin(f.face, point.ray, point.point, 0)).toBe(true);
    f.map.complete(point.ray, 100);
    expect(f.submit).toHaveBeenCalledWith([expect.closeTo(0), expect.closeTo(-2.54545)]);
    f.map.dispose();
  });
  it("shows the robot axes and actual bounds only while debug is enabled", () => {
    const { map } = fixture();
    const debug = map.object.getObjectByName("Navigation map robot debug")!;
    const bounds = map.object.getObjectByName("Navigation map robot bounds")!;
    expect(debug.visible).toBe(false);
    map.setDebug(true);
    map.update(true, true, true, false, new THREE.Vector3(), 0, 2, 0.01);
    expect(debug.visible).toBe(true);
    expect(bounds.scale.toArray()).toEqual([0.6, 0.3, 0.4]);
    map.setDebug(false);
    map.update(true, true, true, false, new THREE.Vector3(), 0, 3, 0.01);
    expect(debug.visible).toBe(false);
    map.dispose();
  });
  it("distinguishes received native unknown cells from an unreceived crop area", () => {
    expect(navigationMapContains(snapshot, [-6, -6])).toBe(true);
    expect(navigationMapContains(snapshot, [6, 0])).toBe(false);
    expect(navigationMapContains(snapshot, [0, -6.00001])).toBe(false);
  });

  it("clips route segments to the disc and keeps the grabbed map coordinate under the pointer", () => {
    expect(clipNavigationMapSegment([-9, 0], [9, 0], 4)).toEqual([-4, 0, 4, 0]);
    expect(clipNavigationMapSegment([-5, 7], [6, 7], 4)).toBeNull();
    expect(panNavigationMap([5, 4], [1, 2], [2, 2], 3)).toEqual([2, 4]);
  });

  it("computes a near-hand hit against the circular edge instead of its bounding box", () => {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1));
    const point = closestPoint(disc, new THREE.Vector3(1, 1, 0.2));
    expect(point.length()).toBeCloseTo(1);
    expect(point.z).toBe(0);
  });
});

describe("navigation map gestures", () => {
  it("reopens following the robot after the viewport has been panned", () => {
    const f = fixture();
    const start = f.at(0, 0), end = f.at(0.05, 0);
    expect(f.map.begin(f.face, start.ray, start.point, 0)).toBe(true);
    f.map.hold(end.ray, 200);
    f.map.abort();
    const update = (open: boolean, t: number) => f.map.update(open, true, true, false, new THREE.Vector3(), 0, t, 0.2);
    update(true, 300);
    expect(f.setViewport).toHaveBeenLastCalledWith({ center: [expect.any(Number), 0], radiusM: 4 });
    update(false, 400);
    update(true, 500);
    expect(f.setViewport).toHaveBeenLastCalledWith({ radiusM: 4 });
    f.map.dispose();
  });

  it("retires a robot drag when navigation via map is turned off", () => {
    const f = fixture();
    const start = f.at(0, 0), end = f.at(0.07, 0);
    expect(f.map.begin(f.sphere, start.ray, start.point, 0)).toBe(true);
    f.map.setClickToWalk(false);
    f.map.setClickToWalk(true);
    f.map.complete(end.ray, 250);
    expect(f.cancelPending).toHaveBeenCalledOnce();
    expect(f.submit).not.toHaveBeenCalled();
    f.map.dispose();
  });

  it("routes a surface tap and keeps robot taps separate from motion", () => {
    const f = fixture();
    const face = f.at(0.07, 0);
    expect(f.map.begin(f.face, face.ray, face.point, 0)).toBe(true);
    f.map.complete(face.ray, 100);
    expect(f.submit).toHaveBeenCalledWith([expect.closeTo(2.54545), expect.closeTo(0)]);
    f.map.abort();
    const robot = f.at(0, 0);
    expect(f.map.begin(f.sphere, robot.ray, robot.point, 120)).toBe(true);
    f.map.complete(robot.ray, 190);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.setViewport).toHaveBeenLastCalledWith({ radiusM: 4 });
    f.map.dispose();
  });

  it("preserves the elevated robot grab offset and latches a pan even when it returns", () => {
    const f = fixture();
    const start = f.at(0.035, 0), next = f.at(0.07, 0);
    f.map.begin(f.sphere, start.ray, start.point, 0);
    f.map.complete(next.ray, 250);
    expect(f.submit).toHaveBeenCalledWith([expect.closeTo(1.27273), expect.closeTo(0)]);
    f.map.abort();
    f.map.begin(f.face, start.ray, start.point, 300);
    f.map.hold(next.ray);
    f.map.complete(start.ray, 500);
    expect(f.submit).toHaveBeenCalledTimes(1);
    f.map.dispose();
  });

  it("waits for a sustained press before panning and never treats the drag as a goal", () => {
    const f = fixture();
    const start = f.at(0.03, 0), end = f.at(0.07, 0);
    f.map.begin(f.face, start.ray, start.point, 0);
    f.map.hold(end.ray, 100);
    expect(f.map.viewport.centerM).toEqual([0, 0]);
    f.map.hold(end.ray, 200);
    expect(f.map.viewport.centerM[0]).toBeLessThan(0);
    f.map.complete(end.ray, 250);
    expect(f.submit).not.toHaveBeenCalled();
    f.map.dispose();
  });

  it("disables map taps and keeps marker taps inert", () => {
    const f = fixture();
    f.map.setClickToWalk(false);
    const face = f.at(0.07, 0);
    f.map.begin(f.face, face.ray, face.point, 0);
    f.map.complete(face.ray, 100);
    expect(f.submit).not.toHaveBeenCalled();
    f.map.abort();
    const robot = f.at(0, 0);
    f.map.begin(f.sphere, robot.ray, robot.point, 120);
    f.map.complete(robot.ray, 190);
    expect(f.setViewport).toHaveBeenLastCalledWith({ radiusM: 4 });
    f.map.dispose();
  });

  it("allows two hands to rotate the map only when compass is off", () => {
    const f = fixture();
    const left = f.at(-0.04, 0), right = f.at(0.04, 0), turned = f.at(0, 0.06);
    const data = (f.map as any).mapData as THREE.Group;
    const scale = () => {
      expect(f.map.begin(f.face, left.ray, left.point, 0)).toBe(true);
      expect(f.map.beginScale(left.ray, right.ray)).toBe(true);
      f.map.holdScale(left.ray, turned.ray);
      f.map.abort();
    };
    scale();
    expect(data.rotation.z).toBe(0);
    const compass = f.map.object.getObjectByName("Compass orientation")!;
    const point = compass.getWorldPosition(new THREE.Vector3());
    const ray = { origin: [point.x, point.y + 1, point.z], direction: [0, -1, 0] };
    expect(f.map.begin(compass, ray, point, 10)).toBe(true);
    f.map.complete(ray, 20);
    f.map.abort();
    scale();
    expect(data.rotation.z).toBeLessThan(-0.5);
    expect(f.submit).not.toHaveBeenCalled();
    f.map.dispose();
  });

  it("scales map data with two hands without submitting a goal", () => {
    const f = fixture();
    const left = f.at(-0.03, 0), right = f.at(0.03, 0), farther = f.at(0.09, 0);
    expect(f.map.begin(f.face, left.ray, left.point, 0)).toBe(true);
    expect(f.map.beginScale(left.ray, right.ray)).toBe(true);
    f.map.holdScale(left.ray, farther.ray);
    expect((f.map as any).mapRadius).toBeCloseTo(2);
    f.map.endScale();
    f.map.complete(left.ray, 100);
    expect(f.submit).not.toHaveBeenCalled();
    f.map.dispose();
  });

  it("retires captured goals and immediately releases the viewport on XR suspension", () => {
    const f = fixture();
    const face = f.at(0.07, 0);
    f.map.begin(f.face, face.ray, face.point, 0);
    f.map.suspend();
    f.map.complete(face.ray, 100);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.cancelPending).toHaveBeenCalled();
    expect(f.setViewport).toHaveBeenLastCalledWith(null);
    expect(f.map.object.visible).toBe(false);
    f.map.dispose();
  });

  it("rejects a completed face tap when its release ray hits from underneath", () => {
    const f = fixture();
    const face = f.at(0.07, 0);
    f.map.begin(f.face, face.ray, face.point, 0);
    f.map.complete({ origin: [0.07, -1, 0.12], direction: [0, 1, 0] }, 100);
    expect(f.submit).not.toHaveBeenCalled();
    f.map.dispose();
  });

  it("keeps replay panning and recentering available while all gestures remain read-only", () => {
    const f = fixture(false);
    const start = f.at(0, 0), next = f.at(0.03, 0);
    f.map.begin(f.face, start.ray, start.point, 0);
    f.map.hold(next.ray);
    f.map.complete(next.ray, 140);
    f.map.abort();
    f.map.update(true, true, false, false, new THREE.Vector3(), 0, 250, 0.016);
    expect(f.setViewport).toHaveBeenLastCalledWith({ center: [expect.any(Number), 0], radiusM: 4 });
    const pin = f.map.object.getObjectByName("Follow robot")!;
    const point = pin.getWorldPosition(new THREE.Vector3());
    const ray = { origin: [point.x, point.y + 1, point.z], direction: [0, -1, 0] };
    expect(f.map.begin(pin, ray, point, 300)).toBe(true);
    f.map.complete(ray, 350);
    expect(f.setViewport).toHaveBeenLastCalledWith({ radiusM: 4 });
    expect(f.submit).not.toHaveBeenCalled();
    f.map.dispose();
  });
});
