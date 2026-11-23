import { mapToClientTrackingPose, rotateVecByQuat, type ClientTrackingOrigin } from "../localization/ClientTracking";
import type { ARModuleSessionState } from "../websocket/ARModuleSession";
import { deriveSessionLinkPhase, NO_ROBOT_CONNECTED_LABEL } from "../presentation/ControlPanelPresentation";
import type { BaseSighting, Pose, RobotDescription, ReadonlyFacts, Vec3, Quat } from "../ClientContracts";

/** The single robot selection owner. Views receive facts; hover never changes selection. */
export class RobotSelection {
  private selected = false;
  private eligible = false;
  private readonly listeners = new Set<(selected: boolean) => void>();

  isSelected(): boolean { return this.selected; }
  snapshot(): Readonly<{ selected: boolean; eligible: boolean }> { return { selected: this.selected, eligible: this.eligible }; }
  setEligible(eligible: boolean): void { this.eligible = eligible; if (!eligible) this.clear(); }
  setSelected(selected: boolean): void {
    const next = selected && this.eligible;
    if (next === this.selected) return;
    this.selected = next;
    for (const listener of this.listeners) listener(next);
  }
  toggle(): void { this.setSelected(!this.selected); }
  clear(): void { this.setSelected(false); }
  subscribe(listener: (selected: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export type RobotActivityState = "Stopped" | "Idle" | "Following Path" | "Thinking" | "Responding" | "Listening";

export type RobotMarkerApplyInput =
  | { mode: "hidden" }
  | { mode: "lastSeen"; robot: ReadonlyFacts<RobotDescription>; sighting: ReadonlyFacts<BaseSighting> }
  | {
      mode: "localizedOdom";
      robot: ReadonlyFacts<RobotDescription>;
      pose: ReadonlyFacts<Pose>;
      origin: ReadonlyFacts<ClientTrackingOrigin>;
      view: ARModuleSessionState;
    };

export function deriveRobotMarkerApplyInput(input: {
  setupCompleted: boolean;
  view: ARModuleSessionState;
  origin: ReadonlyFacts<ClientTrackingOrigin> | null;
}): RobotMarkerApplyInput {
  const { view, origin } = input;
  const robot = view.hello?.robot;
  if (!robot) return { mode: "hidden" };
  if (view.baseSighting && (!origin || !view.pose || view.robotTelemetry === "unavailable" ||
      view.baseSighting.ts > view.pose.ts)) {
    return { mode: "lastSeen", robot, sighting: view.baseSighting };
  }
  if (input.setupCompleted && view.capabilities?.navigation.available && origin &&
      view.hasTrackingOrigin && view.pose && view.robotTelemetry !== "unavailable") {
    return { mode: "localizedOdom", robot, pose: view.pose, origin, view };
  }
  return { mode: "hidden" };
}

export function getRobotActivityState(view: ARModuleSessionState, voice?: { ttsPlaying: boolean; asrRunning: boolean }): RobotActivityState {
  if (view.state?.safety?.stopped === true) return "Stopped";
  if (view.nav !== null && view.nav.state === "following_path") {
    return "Following Path";
  }
  if (view.state?.agent.idle === false) {
    return "Thinking";
  }
  if (voice?.ttsPlaying) return "Responding";
  if (voice?.asrRunning) return "Listening";
  return "Idle";
}

export function robotTitleText(view: ARModuleSessionState): string {
  const linkPhase = deriveSessionLinkPhase(view);
  if (linkPhase === "disconnected" || linkPhase === "connecting") {
    return NO_ROBOT_CONNECTED_LABEL;
  }
  return view.hello?.robot.display_name ?? NO_ROBOT_CONNECTED_LABEL;
}


/** Localized pose policy stays in Core; the host converts units/axes and applies smoothing. */
export function projectRobotPose(
  input: Extract<RobotMarkerApplyInput, { mode: "localizedOdom" }>,
): ReadonlyFacts<{ position: Vec3; orientation: Quat }> {
  return mapToClientTrackingPose(input.pose, input.origin);
}

/** Rotated base-to-floor offset, in metres in the caller's coordinate basis. */
export function robotFloorOffset(
  orientation: Readonly<Quat>,
  baseHeightM: number,
  upAxis: "y" | "z" = "z",
): Readonly<Vec3> {
  return rotateVecByQuat(orientation, upAxis === "y" ? [0, -baseHeightM, 0] : [0, 0, -baseHeightM]);
}
