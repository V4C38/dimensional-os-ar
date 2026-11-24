import { expect, test, type Page } from "@playwright/test";
import { setSelection } from "./fixtures/Input";
import { bootstrap, snapshot } from "./fixtures/Runtime";

async function openMap(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    const app = w.xb.core.scene.children.find((object: any) => object.client?.manipulation);
    const session = app.session as XRSession;
    const dispatch = session.dispatchEvent.bind(session);
    session.dispatchEvent = (event: Event) => {
      // iWER 2.6 emits select before selectstart on press. Real XR emits
      // select immediately before selectend on successful completion.
      if (event.type === "select") return true;
      if (event.type === "selectend" && !w.cancelMapSelection) {
        const { frame, inputSource } = event as XRInputSourceEvent;
        dispatch(new w.IWER.XRInputSourceEvent("select", { frame, inputSource }));
      }
      w.cancelMapSelection = false;
      return dispatch(event);
    };
    app.client.ui.nextSetup();
    app.client.ui.nextSetup();
    app.client.ui.menuOpen = true;
    app.client.setRobotSelected(true);
  });
  await expect.poll(() => snapshot(page).then(s => s.setupCompleted && !s.setupCelebrating)).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return w.xb.core.scene.getObjectByName("Go2 navigation map")?.visible === true;
  })).toBe(true);
}

async function aimAtMap(page: Page, target: string) {
  await page.evaluate((target) => {
    const w = window as any;
    const object = w.xb.core.scene.getObjectByName(target);
    const point = object.position.clone().set(target === "Navigation map face" ? -0.65 : 0, 0, 0);
    object.localToWorld(point);
    const origin = point.clone().add(point.clone().set(0, 0.34, 0.08));
    const direction = point.clone().sub(origin).normalize();
    const rotation = object.quaternion.clone().setFromUnitVectors(point.clone().set(0, 0, -1), direction);
    const controller = w.questDevice.primaryInputMode === "hand"
      ? w.questDevice.hands.right : w.questDevice.controllers.right;
    controller.position.set(origin.x, origin.y, origin.z);
    controller.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
  }, target);
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    const app = w.xb.core.scene.children.find((object: any) => object.client?.manipulation);
    const pointer = w.xb.core.input.controllers.find((controller: any) => controller.inputSource?.handedness === "right");
    return pointer && app.interaction.hit(pointer)?.object.name;
  })).toBe(target);
}

for (const mode of ["controller", "hand"] as const) {
  test(`navigation map separates sphere recenter from goal taps with ${mode}`, async ({ page }) => {
    const runtime = await bootstrap(page, mode, { navigationMap: "live" });
    await openMap(page);
    const goals = () => runtime.commands.filter(command => command.map_target);
    await aimAtMap(page, "Navigation map robot sphere");
    await setSelection(page, 1);
    await setSelection(page, 0);
    expect(goals()).toHaveLength(0);

    await aimAtMap(page, "Navigation map face");
    await setSelection(page, 1);
    await page.evaluate(() => { (window as any).cancelMapSelection = true; });
    await setSelection(page, 0);
    expect(goals()).toHaveLength(0);

    await setSelection(page, 1);
    await setSelection(page, 0);
    await expect.poll(goals).toHaveLength(1);
    const target = goals()[0].map_target.position as [number, number];
    expect(target[0]).toBeLessThan(0);
    await expect.poll(() => page.evaluate(() => {
      const w = window as any;
      const app = w.xb.core.scene.children.find((object: any) => object.client?.manipulation);
      const view = app.client.session.view();
      return { mapTarget: view.navigationMap?.target, mapRoute: view.navigationMap?.route.length,
        worldTarget: view.nav_goal?.pose?.slice(0, 2) };
    })).toEqual({ mapTarget: target, mapRoute: 1, worldTarget: target });
    runtime.close();
  });
}

test("map-only replay subscribes while navigation motion stays unavailable", async ({ page }) => {
  const runtime = await bootstrap(page, "controller", { navigationMap: "recording" });
  await openMap(page);
  await expect.poll(() => runtime.commands.some(command =>
    command.type === "navigation_map_request" && command.enabled)).toBe(true);
  const flags = await page.evaluate(() => {
    const w = window as any;
    const app = w.xb.core.scene.children.find((object: any) => object.client?.manipulation);
    const navigation = app.client.session.view().capabilities.navigation;
    return [navigation.available, navigation.nav_goal.available, navigation.nav_joystick.available, navigation.nav_map.available];
  });
  expect(flags).toEqual([false, false, false, true]);
  await aimAtMap(page, "Navigation map robot sphere");
  await setSelection(page, 1);
  await setSelection(page, 0);
  expect(runtime.commands.some(command => command.map_target || command.type === "nav_goal_request")).toBe(false);
  runtime.close();
});

test("two hand pinch scales the map without sending a goal", async ({ page }) => {
  const runtime = await bootstrap(page, "hand", { navigationMap: "live" });
  await openMap(page);
  await page.evaluate(() => {
    const w = window as any;
    const face = w.xb.core.scene.getObjectByName("Navigation map face");
    for (const [hand, x] of [["left", -0.45], ["right", 0.45]] as const) {
      const point = face.localToWorld(face.position.clone().set(x, 0.25, 0));
      const origin = point.clone().add(point.clone().set(0, 0.30, 0.08));
      const rotation = face.quaternion.clone().setFromUnitVectors(point.clone().set(0, 0, -1), point.clone().sub(origin).normalize());
      const input = w.questDevice.hands[hand];
      input.position.set(origin.x, origin.y, origin.z);
      input.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    }
  });
  const frame = async () => page.evaluate(async () => {
    const session = (window as any).xb.core.renderer.xr.getSession();
    await new Promise<void>(resolve => session.requestAnimationFrame(() => session.requestAnimationFrame(() => resolve())));
  });
  await frame();
  await page.evaluate(() => (window as any).questDevice.hands.right.updatePinchValue(1));
  await frame();
  await page.evaluate(() => (window as any).questDevice.hands.left.updatePinchValue(1));
  await frame();
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    const app = w.xb.core.scene.children.find((object: any) => object.client?.manipulation);
    return Boolean(app.inputController.mapSecondHand);
  })).toBe(true);
  const initial = await page.evaluate(() => {
    const w = window as any;
    return w.xb.core.scene.children.find((object: any) => object.client?.manipulation).inputController.map.mapRadius;
  });
  await page.evaluate(() => { (window as any).questDevice.hands.left.position.x -= 0.08; });
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return w.xb.core.scene.children.find((object: any) => object.client?.manipulation).inputController.map.mapRadius;
  })).toBeLessThan(initial);
  await page.evaluate(() => {
    (window as any).questDevice.hands.left.updatePinchValue(0);
    (window as any).questDevice.hands.right.updatePinchValue(0);
  });
  await frame();
  expect(runtime.commands.some(command => command.map_target)).toBe(false);
  runtime.close();
});
