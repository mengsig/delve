/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';

/** Count real pointer activations and navigation keys. Text entry and waiting for a result are free. */
export async function withinBudget(page: Page, label: string, maximum: number, journey: () => Promise<void>) {
  await test.step(label, async () => {
    const counter = await page.evaluateHandle(() => {
      const actions: string[] = [];
      const stop = new AbortController();
      const options = { capture: true, signal: stop.signal };
      window.addEventListener('click', event => {
        if (event.isTrusted && event.detail > 0) actions.push('click');
      }, options);
      window.addEventListener('keydown', event => {
        if (!event.isTrusted || ['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
        if (event.ctrlKey || event.metaKey || event.altKey || event.key.length > 1) actions.push(event.key);
      }, options);
      return { actions, finish: () => stop.abort() };
    });
    try {
      await journey();
      const actions = await counter.evaluate(meter => meter.actions);
      expect(actions.length, label).toBeGreaterThan(0);
      expect(actions.length, actions.join(', ')).toBeLessThanOrEqual(maximum);
    } finally {
      await counter.evaluate(meter => meter.finish());
      await counter.dispose();
    }
  });
}
