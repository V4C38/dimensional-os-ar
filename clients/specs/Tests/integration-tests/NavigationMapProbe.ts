import { integrationTestsEnabled } from "../Scripts/Integration Test Harness";
import { emitReviewEvent, findProductionRoot } from "./IntegrationHost";
import { IntegrationInput } from "./IntegrationInput";
import { IntegrationV2Fixture } from "./IntegrationV2Fixture";
import { INTEGRATION_CATALOG as CATALOG } from "./IntegrationCatalog";
import { specsToClientTrackingPoint } from "../Scripts/DimOSSpecsClient/utilities/SpecsCoordinates";
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { InteractorInputType, InteractorTriggerType, TargetingMode } from "SpectaclesInteractionKit.lspkg/Core/Interactor/Interactor";

/** Native map probe: real Core bulk decoding, renderers and SIK interactor; hardware facts are fixtures. */
@component
export class ReviewScenario extends BaseScriptComponent {
  @input startDelayS = 5;
  private root: any;
  private peer!: IntegrationV2Fixture;
  private input: IntegrationInput | null = null;
  private sent: any[] = [];
  private pendingCommands: any[] = [];
  private elapsed = 0;
  private phase = -1;
  private failed = false;
  private mapRequest: any = null;
  private receivedGoal: any = null;
  private emit(value: Record<string, unknown>): void { emitReviewEvent(value); }
  private check(name: string, passed: boolean): void { this.failed ||= !passed; this.emit({ type: "result", name, passed }); }
  private wire(value: Record<string, unknown>): void { this.peer.send(value); }
  onAwake(): void {
    if (!integrationTestsEnabled(this.getSceneObject())) return;
    this.createEvent("OnStartEvent").bind(() => this.createEvent("UpdateEvent").bind(() => this.tick()));
    this.createEvent("OnDestroyEvent").bind(() => this.input?.restore());
  }
  private prepare(): void {
    this.root = findProductionRoot();
    if (!this.root) throw new Error("Production composition root missing");
    const root = this.root, camera = root.cameraObject.getTransform(), rotation = camera.getWorldRotation();
    const desired = camera.getWorldPosition().add(rotation.multiplyVec3(new vec3(0, -45, -170)));
    const point = specsToClientTrackingPoint([desired.x, desired.y, desired.z]);
    const origin = CATALOG.fixtures.pose.map((v: number, i: number) => v - point[i]);
    const tracking = root.cameraObject.getComponent("Component.DeviceTracking") as DeviceTracking;
    tracking.enabled = false;
    this.peer = new IntegrationV2Fixture(value => root.session.onTransportText(JSON.stringify(value) + "\n"), "native-map", () => getTime());
    this.peer.onMapGoal = target => { this.receivedGoal = target; };
    root.transport.createSibling = () => this.peer;
    root.transport.connect = () => {}; root.transport.close = () => {};
    root.transport.sendText = (text: string) => {
      for (const line of text.trim().split("\n")) {
        const message = JSON.parse(line); this.sent.push(message);
        if (message.type === "navigation_map_request") {
          if (message.enabled) { this.mapRequest = message; this.peer.navigationMap(message, "native-map-odom"); }
          else this.mapRequest = null;
        }
        this.pendingCommands.push(message);
      }
    };
    root.uiPresenter.setupWizardController.invalidatePending();
    root.session.stop(); root.session.start(); root.session.onTransportOpen();
    const request = this.sent.find(row => row.type === "hello_request"), yes = { available: true, reason: null }, no = { available: false, reason: "Fixture" };
    this.wire({ type: "hello", protocol_version: 2, bulk_url: "/bulk", bulk_token: "fixture-token", bulk_epoch: "fixture-epoch",
      client_id: "native-map", odom_reference_id: "native-map-odom", resume_token: "fixture-resume",
      localization: { providers: ["fiducial_marker"] }, time_sync: { ts_client: request.ts_client, ts_server: getTime() },
      robot: CATALOG.fixtures.robot, capabilities: { manipulation: no, object_detection: no, lidar: yes, localization: yes, estop: yes, agent: yes,
        navigation: { ...yes, nav_goal: { ...yes, preview: true }, nav_joystick: no, nav_map: yes } } });
    this.peer.reset();
    this.wire({ type: "state", server: { connected_clients: 1 }, lidar: { enabled: false, min_height_m: -10, max_height_m: 10, max_range_m: 5 },
      nav: { state: "idle", outcome: null }, agent: { idle: true } });
    root.episode.tick();
    root.clientTrackingOriginStore.setFromLocalizationResult({ alignment_id: "probe", shared_frame_id: "fixture-map", odom_reference_id: "native-map-odom",
      tracking_reference_id: [...this.sent].reverse().find(row => row.type === "localization_tracking")?.tracking_reference_id,
      position: origin, orientation: [0, 0, 0, 1], confidence: 1, ts: getTime() });
    this.wire({ type: "pose", position: CATALOG.fixtures.pose, orientation: [0, 0, 0, 1], ts: getTime() });
    root.uiPresenter.setupWizardController.flow.finish(); root.uiPresenter.setupWizardController.hide(); root.uiPresenter.finishWizard();
    root.syncSelectionEligibility();
    root.selection.setSelected(true);
    root.uiPresenter.mainMenuView.showPage("sensors");
    this.input = new IntegrationInput(InteractorInputType.LeftHand); this.input.active = true;
    this.input.triggerType = InteractorTriggerType.Poke; this.input.targetingMode = TargetingMode.Poke;
  }
  private tick(): void {
    // A real WebSocket delivers server responses after sendText returns.
    // Keep fixture replies asynchronous so Core can register its pending request.
    for (const message of this.pendingCommands.splice(0)) this.peer.command(message);
    this.elapsed += Math.min(0.1, getDeltaTime());
    if (!this.root) { if (this.elapsed >= this.startDelayS) { this.prepare(); this.elapsed = 0; } return; }
    if (this.elapsed < (this.phase === 2 || this.phase === 4 ? 0.1 : 2)) return;
    this.elapsed = 0; this.phase++;
    const ui = this.root.uiPresenter, map = ui.navigationMap, view = ui.navigationMapView, input = this.input!;
    if (this.phase === 0) {
      this.check("map-subscribed", !!this.mapRequest);
      this.check("map-snapshot-decoded", !!this.root.session.view().navigationMap);
      this.check("map-rendered", !!view && view.root.enabled && view.disc.object.enabled && !!view.texture);
      this.check("map-controls-visible", ui.mainMenuView.navMapRoot.enabled && ui.mainMenuView.mapToggle.labelText.text === "Map · On");
      this.emit({ type: "scene", name: "navigation-map-capabilities", videoOnly: false });
    } else if (this.phase === 1) {
      ui.mainMenuView.showPage("main");
    } else if (this.phase === 2) {
      this.emit({ type: "scene", name: "navigation-map-main", videoOnly: false });
      const face = ui.navigationMapInput.targets[0].object as SceneObject;
      const target = face.getComponent(Interactable.getTypeName()) as Interactable;
      const transform = view.dataRoot.getTransform(), point = transform.getWorldTransform().multiplyPoint(new vec3(-5, 0, 0));
      const from = point.add(new vec3(0, 20, 0)); input.ray(from, point, target); input.hover(target);
      input.triggerType = InteractorTriggerType.Pinch; input.targetingMode = TargetingMode.Indirect; input.start(target);
      this.check("map-sik-press-registered", !!target && (target.targetingMode & TargetingMode.Poke) !== 0);
    } else if (this.phase === 3) {
      this.check("map-gesture-captured", map.gesture.active);
      input.end();
    } else if (this.phase === 4) {
      this.check("map-ray-tap-sends-goal", this.sent.some(row => row.map_target));
      input.triggerType = InteractorTriggerType.Poke; input.targetingMode = TargetingMode.Poke; input.start();
    } else if (this.phase === 5) {
      this.check("map-poke-captured", map.gesture.active);
      input.end();
    } else if (this.phase === 6) {
      this.check("map-goal-authority", this.sent.filter(row => row.type === "interaction_request" && row.action === "confirm" && !!row.map_target).length === 2);
      this.check("map-goal-arrived", !!this.receivedGoal);
      ui.mainMenuView.showPage("sensors");
    } else if (this.phase === 7) {
      input.press(ui.mainMenuView.mapToggle.button);
      this.check("native-map-toggle", ui.navMapEnabled === false);
    } else if (this.phase === 8) {
      this.check("map-unsubscribed-on-hide", this.mapRequest === null && !view.root.enabled);
      input.restore(); this.emit({ type: "complete", passed: !this.failed }); this.enabled = false;
    }
  }
}
