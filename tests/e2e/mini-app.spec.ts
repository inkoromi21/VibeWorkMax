import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const width of [360, 390, 1280]) {
  test(`demo shell is responsive and accessible at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/problem');
    await expect(page.getByRole('heading', { name: 'С чем нужна помощь?' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}

test('failed server connection is explicit and preserves local interaction', async ({ page }) => {
  await page.route('**/api/mini-app/**', (route) => route.abort('failed'));
  await page.goto('/problem');
  await expect(page.getByRole('status')).toContainText('Demo-режим');
  await page.getByLabel('Ваш запрос').fill('Хочу разобрать тему');
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page).toHaveURL(/\/diagnosis$/);
});

test('an already opened mini app remains usable when the device goes offline', async ({
  context,
  page,
}) => {
  await page.goto('/problem');
  await expect(page.getByRole('heading', { name: 'С чем нужна помощь?' })).toBeVisible();
  await context.setOffline(true);
  await page.getByLabel('Ваш запрос').fill('Продолжить сохранённый сценарий без сети');
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page).toHaveURL(/\/diagnosis$/);
  await expect(page.locator('.route-focus')).toBeFocused();
});
