import { test, expect } from "@playwright/test";

test("loads shell and renders nav", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto("/");

  await expect(page.locator(".brand")).toHaveText("Woo");
  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dubspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Taskspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "IDE" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat" })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: "Enter" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Leave" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Look" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Who" })).toBeHidden();
  await expect(page.locator(".chat-form")).toBeHidden();

  // Wait for the websocket session to bind an actor — the actor field
  // starts as "connecting..." and updates once op:"session" arrives.
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(" | ")}`).toEqual([]);
});

test("switches between tabs", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });

  await page.getByRole("button", { name: "Dubspace" }).click();
  await expect(page.getByRole("button", { name: "Dubspace" })).toHaveClass(/active/);

  await page.getByRole("button", { name: "Taskspace" }).click();
  await expect(page.getByRole("button", { name: "Taskspace" })).toHaveClass(/active/);

  await page.getByRole("button", { name: "IDE" }).click();
  await expect(page.getByRole("button", { name: "IDE" })).toHaveClass(/active/);

  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page.getByRole("button", { name: "Chat" })).toHaveClass(/active/);
});

test("narrow layout keeps nav tabs on one row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/");
  await expect(page.locator(".actor")).toHaveCount(1);

  const nav = page.locator(".nav");
  const tabs = page.locator(".nav-button");
  await expect(tabs).toHaveCount(4);

  const metrics = await nav.evaluate((element) => {
    const navRect = element.getBoundingClientRect();
    const tabRects = Array.from(element.querySelectorAll(".nav-button")).map((tab) => tab.getBoundingClientRect());
    return {
      navHeight: navRect.height,
      sameRow: tabRects.every((rect) => Math.abs(rect.top - tabRects[0].top) < 2),
      withinWidth: tabRects[tabRects.length - 1].right <= navRect.right + 1
    };
  });

  expect(metrics.sameRow).toBe(true);
  expect(metrics.withinWidth).toBe(true);
  expect(metrics.navHeight).toBeLessThan(56);
});

test("chat controls follow room membership", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
  const actor = (await page.locator(".actor").textContent())?.trim() ?? "";

  await expect(page.getByRole("button", { name: "Enter" })).toBeVisible();
  await expect(page.locator(".chat-form")).toBeHidden();

  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("button", { name: "Leave" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Look" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Who" })).toBeVisible();
  await expect(page.locator(".chat-form")).toBeVisible();
  await expect(page.locator(".presence-list")).toContainText(actor);
  await expect(page.locator("[data-chat-input]")).toBeFocused();

  const chatFitsViewport = await page.locator(".chat-layout").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom <= window.innerHeight + 1 && rect.height > 0;
  });
  expect(chatFitsViewport).toBe(true);

  await page.locator("[data-chat-input]").fill("draft text");
  await page.getByRole("button", { name: "Who" }).click();
  await expect(page.locator("[data-chat-input]")).toBeFocused();
  await expect(page.locator("[data-chat-input]")).toHaveValue("draft text");

  await page.getByRole("button", { name: "Look" }).click();
  await expect(page.locator("[data-chat-input]")).toBeFocused();
  await expect(page.locator("[data-chat-input]")).toHaveValue("draft text");

  await page.getByRole("button", { name: "Leave" }).click();
  await expect(page.getByRole("button", { name: "Enter" })).toBeVisible();
  await expect(page.locator(".chat-form")).toBeHidden();
  await expect(page.getByRole("button", { name: "Who" })).toBeHidden();
});
