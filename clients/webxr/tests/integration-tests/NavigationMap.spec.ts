import { expect, test, type Page } from "@playwright/test";
import { moveInput, pointIndexAtButton, setSelection, summonMenu, tapSelection } from "./fixtures/Input";
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

    await tapSelection(page);
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

test("drags a map goal while the other wrist moves the attached menu", async ({ page }) => {
  const runtime = await bootstrap(page, "hand", { navigationMap: "live" });
  await openMap(page);
  const anchor = (action: "close" | "move" | "read") => page.evaluate(async action => {
    const w = window as any;
    const app = w.xb.core.scene.children.find((object: any) => object.client?.manipulation);
    if (action === "close") app.client.ui.menuOpen = false;
    if (action === "move") {
      const hand = w.questDevice.hands.left;
      hand.position.x += 0.12;
      const turn = app.mainMenu.panel.quaternion.clone().setFromAxisAngle(app.mainMenu.panel.position.clone().set(0, 1, 0), 0.2);
      turn.multiply(turn.clone().set(hand.quaternion.x, hand.quaternion.y, hand.quaternion.z, hand.quaternion.w));
      hand.quaternion.set(turn.x, turn.y, turn.z, turn.w);
    }
    await new Promise<void>(resolve => app.session.requestAnimationFrame(() =>
      app.session.requestAnimationFrame(() => resolve())));
    const panel = app.mainMenu.panel;
    return { hand: app.inputController.panels.menuAnchor.source?.handedness ?? null,
      captured: app.inputController.map.capturing,
      position: panel.position.toArray(), rotation: panel.quaternion.toArray() };
  }, action);
  await anchor("close");
  await summonMenu(page);
  expect((await anchor("read")).hand).toBe("left");
  await page.waitForTimeout(250);
  await aimAtMap(page, "Navigation map robot sphere");
  await setSelection(page, 1);
  // This is a held interaction: use a drag, which remains valid regardless of
  // how long the frame-synchronized anchor checks take on software rendering.
  await moveInput(page, [-0.025, 0, 0], 150);
  const held = await anchor("read");
  expect(held.captured).toBe(true);
  expect(await anchor("move")).toEqual(held);
  await setSelection(page, 0);
  await expect.poll(() => runtime.commands.filter(command => command.map_target)).toHaveLength(1);
  await expect.poll(async () => (await anchor("read")).position).not.toEqual(held.position);
  expect((await anchor("read")).hand).toBe("left");
  runtime.close();
});

test("finger pokes toggle the compass and follow pin without placing a goal", async ({ page }) => {
  const runtime = await bootstrap(page, "hand", { navigationMap: "live" });
  await openMap(page);
  const controlState = () => page.evaluate(() => {
    const w = window as any;
    const map = w.xb.core.scene.children.find((object: any) => object.client?.manipulation).inputController.map;
    return { compass: map.compassEnabled, follow: map.viewport.followingRobot };
  });
  expect(await controlState()).toEqual({ compass: true, follow: true });
  for (const [label, expected] of [
    ["Compass orientation", { compass: false, follow: true }],
    ["Follow robot", { compass: false, follow: false }],
  ] as const) {
    for (const distance of [0.05, 0.02, 0.005, 0.04]) {
      await pointIndexAtButton(page, label, distance, true);
    }
    expect(await controlState()).toEqual(expected);
  }
  expect(runtime.commands.some(command => command.map_target)).toBe(false);
  runtime.close();
});

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
