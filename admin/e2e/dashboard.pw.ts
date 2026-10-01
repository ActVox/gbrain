import { test, expect } from './fixtures';

// Protects visible dashboard states and actual browser EventSource retry. The
// existing admin suite covers credentials/consent, not dashboard connectivity.
// Reverting Dashboard.tsx loses stale-data messaging and closes the stream before
// its server-specified retry. No production-only test seam is introduced.
test('failed statistics remain unavailable, then retain a clearly stale snapshot', async ({ page, brain }) => {
  await page.goto(await brain.loginLink());
  let failing = true;
  await page.route('**/admin/api/stats', route => route.fulfill({ status: failing ? 503 : 200, json: failing ? { error: 'service_unavailable' } : { connected_agents: 17, requests_today: 42, active_tokens: 9 } }));
  await page.goto("about:blank");
  await page.goto(`${brain.url}/admin/#dashboard`);
  await expect(page.getByText('Dashboard data unavailable. Retry with Refresh.')).toBeVisible();
  await expect(page.locator('.metric-value').first()).toHaveText('—');
  failing = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.metric-value').first()).toHaveText('17');
  failing = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Updates unavailable. Showing the last successful snapshot.')).toBeVisible();
  await expect(page.locator('.metric-value').first()).toHaveText('17');
});

test('event stream reconnects after interruption and closes when leaving the dashboard', async ({ page, brain }) => {
  await page.goto(await brain.loginLink());
  let connections = 0;
  await page.route('**/admin/events', route => {
    connections++;
    const event = { agent: 'example-agent', operation: `read-${connections}`, scopes: 'read', latency_ms: 20, status: 'success', timestamp: new Date().toISOString() };
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `retry: 4000\ndata: ${JSON.stringify(event)}\n\n` });
  });
  await page.goto("about:blank");
  await page.goto(`${brain.url}/admin/#dashboard`);
  await expect(page.getByRole('cell', { name: 'read-1', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'read-2', exact: true })).toBeVisible({ timeout: 12000 });
  await page.getByRole('link', { name: 'Calibration', exact: true }).click();
  const afterLeaving = connections;
  await page.waitForTimeout(4500); // Longer than the real EventSource retry interval.
  expect(connections).toBe(afterLeaving);
});

test('filter, inspect and recover empty results; theme and navigation work on mobile', async ({ page, brain }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(await brain.loginLink());
  await page.route('**/admin/events', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: ['success_with_warnings', 'denied_after_list'].map((status, index) => `data: ${JSON.stringify({ agent: 'example-agent', operation: `query-${index}`, scopes: 'read', latency_ms: 20, status, timestamp: new Date().toISOString() })}\n\n`).join('') }));
  await page.goto("about:blank");
  await page.goto(`${brain.url}/admin/#dashboard`);
  await page.getByRole('button', { name: 'Errors', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'query-1', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'query-0', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Details for query-1 from example-agent' }).click();
  await expect(page.getByRole('dialog')).toContainText('does not identify the cause');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Details for query-1 from example-agent' })).toBeFocused();
  await page.getByRole('button', { name: 'Successful', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'success_with_warnings', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Find a request' }).fill('no-match');
  await expect(page.getByText('No matching requests. Clear the search or choose All.')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Find a request' }).clear();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: /Switch to .* theme/ }).click();
  const theme = await page.locator('html').getAttribute('data-theme');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme!);
  await page.getByRole('link', { name: 'Agents', exact: true }).click();
  await expect(page.getByRole('button', { name: '+ OAuth Client', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
