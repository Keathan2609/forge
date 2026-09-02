import { expect, test, type Page } from '@playwright/test';

/**
 * Console end-to-end tests.
 *
 * These drive the real console against a real stack: an actual API, actual workers,
 * actual PostgreSQL. Nothing is mocked, because the console's only job is to show what
 * the system is genuinely doing — a suite with a stubbed API would verify that the stub
 * renders, which is not a property worth protecting.
 *
 * Selectors are scoped by role and region rather than by bare text. The console
 * deliberately repeats vocabulary ("Workers" is a nav link, a heading and a stat label),
 * so an unscoped `getByText` is ambiguous by construction rather than by accident.
 *
 * Prerequisites: `pnpm forge:dev && pnpm demo:seed`.
 */

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';

/** Trigger a run through the API so the test controls exactly what it observes. */
async function triggerRun(
  page: Page,
  workflowKey: string,
  input: Record<string, unknown>,
): Promise<string> {
  const response = await page.request.post(API + '/v1/workflows/' + workflowKey + '/runs', {
    data: { input },
    headers: { 'content-type': 'application/json' },
  });
  expect(response.ok(), 'trigger request should succeed').toBeTruthy();
  const body = (await response.json()) as { runId: string };
  return body.runId;
}

test.describe('landing page', () => {
  test('states what the system is and links to the console', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'FORGE', level: 1 })).toBeVisible();
    await expect(page.getByText('Built to survive failure.')).toBeVisible();

    // The architecture diagram is inline SVG with a real description, not a decorative
    // image — so it is both accessible and legible at any zoom.
    await expect(page.getByRole('img', { name: /architecture/i })).toBeVisible();

    await page.getByRole('link', { name: 'Open Console' }).click();
    await expect(page).toHaveURL(/\/console$/);
  });
});

test.describe('console overview', () => {
  test('shows live platform state', async ({ page }) => {
    await page.goto('/console');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

    // Scope to <main> so the nav's "Workers" link does not collide with the stat label.
    const content = page.getByRole('main');
    for (const label of ['Active runs', 'Running tasks', 'Workers', 'Success rate']) {
      await expect(content.getByText(label, { exact: true })).toBeVisible();
    }

    // The header status strip polls /v1/system/status; it must resolve, not hang.
    await expect(page.getByRole('banner').getByText(/healthy|degraded/)).toBeVisible({
      timeout: 15_000,
    });
  });

  test('navigates to every section', async ({ page }) => {
    await page.goto('/console');
    const nav = page.getByRole('navigation');

    for (const [link, heading] of [
      ['Runs', 'Runs'],
      ['Workflows', 'Workflows'],
      ['Workers', 'Workers'],
      ['Dead letters', 'Dead letters'],
      ['Schedules', 'Schedules'],
      ['System', 'System'],
    ] as const) {
      // Not `exact`: the dead-letter link's accessible name includes its badge count
      // ("Dead letters 4"), so an exact match would only pass when the queue is empty.
      await nav.getByRole('link', { name: link }).first().click();
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    }
  });
});

test.describe('workflows', () => {
  test('lists the seeded workflows and opens one', async ({ page }) => {
    await page.goto('/console/workflows');

    await expect(page.getByRole('link', { name: 'order-fulfilment' })).toBeVisible();
    await page.getByRole('link', { name: 'order-fulfilment' }).click();

    await expect(page.getByRole('heading', { name: 'Order Fulfilment' })).toBeVisible();

    // The DAG renders as real nodes, not a placeholder.
    await expect(page.locator('.react-flow__node')).toHaveCount(5);
    await expect(
      page.locator('.react-flow__node').filter({ hasText: 'validate-order' }),
    ).toBeVisible();

    // Graph analysis comes from the engine, not from hard-coded copy.
    await expect(page.getByText('Critical path')).toBeVisible();
  });

  test('validates a graph in the editor against the real engine', async ({ page }) => {
    await page.goto('/console/workflows/new');
    await expect(page.getByRole('heading', { name: 'Workflow editor' })).toBeVisible();

    // A single default node is a valid DAG, so validation should pass. This asserts the
    // API round trip, not a client-side guess.
    await expect(page.getByText('Valid DAG')).toBeVisible({ timeout: 20_000 });

    // Adding a node from the palette updates the graph…
    await page.getByRole('button', { name: /^delay/ }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);

    // …and selects it, so the inspector switches to that node's settings. That is the
    // intended behaviour — you have just added a node, so you want to configure it.
    await expect(page.getByText('Node · delay')).toBeVisible();
    await expect(page.getByLabel('Queue')).toHaveValue('default');

    // Going back shows validation, which has re-run against the API for the new graph.
    await page.getByRole('button', { name: 'Back to validation' }).click();
    await expect(page.getByText('Valid DAG')).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('run execution', () => {
  test('streams a run to completion and shows per-task detail', async ({ page }) => {
    const runId = await triggerRun(page, 'order-fulfilment', {
      orderId: 'e2e_' + Date.now().toString(36),
      amount: 4999,
      items: [{ sku: 'E2E-1', qty: 1 }],
    });

    await page.goto('/console/runs/' + runId);
    await expect(page.getByRole('heading', { name: 'Order Fulfilment' })).toBeVisible();

    // The run reaches SUCCEEDED without the page reloading — this is the SSE path.
    const main = page.getByRole('main');
    await expect(main.getByText('Succeeded').first()).toBeVisible({ timeout: 60_000 });
    await expect(main.getByText('5/5 tasks')).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(5);

    // The timeline is populated from the durable event log.
    await expect(page.getByText(/run created for order-fulfilment/)).toBeVisible();

    // Selecting a node loads its detail: input, output, worker, attempts.
    await page.locator('.react-flow__node').filter({ hasText: 'prepare-shipment' }).click();

    // The card title is uppercased by CSS (`text-transform`), so the DOM text is the
    // raw node key. Asserting on the rendered casing would be asserting on a stylesheet.
    // `exact` matters: the timeline card's title also contains the node key
    // ("Timeline · prepare-shipment"), so a substring match picks the wrong card.
    const panel = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'prepare-shipment', exact: true }) })
      .first();
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Worker', { exact: true })).toBeVisible();
    await expect(panel.getByText('Input', { exact: true })).toBeVisible();
    await expect(panel.getByText('Output', { exact: true })).toBeVisible();
    await expect(panel.getByText('Depends on')).toBeVisible();

    // …and filters the timeline to that node.
    await expect(page.getByText('Timeline · prepare-shipment')).toBeVisible();
    await page.getByRole('button', { name: 'Show all' }).click();
    await expect(page.getByText('Timeline · prepare-shipment')).toBeHidden();
  });

  test('shows retries and a dead letter for a workflow designed to fail', async ({ page }) => {
    test.slow(); // retries with exponential backoff take ~20s by design

    const runId = await triggerRun(page, 'resilience-demo', { scenario: 'retry' });

    // Wait for the run to finish via the API *before* loading the page.
    //
    // Live streaming is covered by the test above; this one is about whether the console
    // renders a completed run's retry history correctly. Loading the page mid-run and
    // racing the stream would conflate the two, and make a failure ambiguous between
    // "the timeline is wrong" and "the stream was slow".
    await expect
      .poll(
        async () => {
          const response = await page.request.get(API + '/v1/runs/' + runId);
          const run = (await response.json()) as { state: string };
          return run.state;
        },
        { timeout: 120_000, intervals: [1_000] },
      )
      .toBe('FAILED');

    await page.goto('/console/runs/' + runId);

    // `flaky-step` fails twice before succeeding, with visible exponential backoff.
    await expect(page.getByText(/retry \d+\/5 in \d+ms/).first()).toBeVisible();

    // `always-fails` exhausts its budget and is dead-lettered.
    await expect(page.getByText(/exhausted its retry budget/).first()).toBeVisible();

    // The run fails, and downstream work is cancelled rather than left hanging.
    await expect(page.getByRole('main').getByText('Failed').first()).toBeVisible();
    await expect(page.getByRole('main').getByText(/dead-lettered/)).toBeVisible();
  });

  test('filters the run list by state', async ({ page }) => {
    await page.goto('/console/runs');

    await page.getByRole('link', { name: 'succeeded', exact: true }).click();
    await expect(page).toHaveURL(/state=SUCCEEDED/);

    // Every visible state badge must match the filter.
    const badges = page.locator('tbody tr td:nth-child(3)');
    const count = await badges.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < Math.min(count, 10); i++) {
      await expect(badges.nth(i)).toContainText('Succeeded');
    }
  });
});

test.describe('operations', () => {
  test('shows the worker fleet with live allocation', async ({ page }) => {
    await page.goto('/console/workers');

    await expect(page.getByRole('heading', { name: 'Workers', level: 1 })).toBeVisible();

    const main = page.getByRole('main');
    await expect(main.getByText('Capacity', { exact: true })).toBeVisible();

    // At least one worker must be registered, or the platform cannot execute anything.
    // `role=meter` is the per-worker slot bar, which only exists for a real worker card.
    await expect(main.getByRole('meter').first()).toBeVisible();
    await expect(main.getByText(/\d+ \/ \d+ slots/).first()).toBeVisible();
  });

  test('shows dead letters with their full attempt history', async ({ page }) => {
    await page.goto('/console/dead-letters');
    await expect(page.getByRole('heading', { name: 'Dead letters', level: 1 })).toBeVisible();

    const entries = page.locator('button[aria-expanded]');
    if ((await entries.count()) === 0) {
      // Nothing dead-lettered yet is a legitimate state; the empty message must say so.
      await expect(page.getByText(/No open dead letters/)).toBeVisible();
      return;
    }

    // Expanding shows every attempt, which is the whole point of the page.
    await entries.first().click();
    await expect(page.getByText(/Attempt history/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry task' })).toBeVisible();
  });

  test('reports component health and links to the observability stack', async ({ page }) => {
    await page.goto('/console/system');

    const components = page.locator('section').filter({ hasText: 'COMPONENTS' }).first();
    await expect(components.getByText('PostgreSQL')).toBeVisible();
    await expect(components.getByText('Redis')).toBeVisible();
    await expect(components.getByText('Outbox', { exact: true })).toBeVisible();

    // Metric names shown here must be the ones actually exported by the services.
    await expect(page.getByText('forge_outbox_lag_seconds')).toBeVisible();
    await expect(page.getByText('forge_worker_lease_recoveries_total')).toBeVisible();
  });
});

test.describe('resilience of the console itself', () => {
  test('renders a useful message for a run that does not exist', async ({ page }) => {
    const response = await page.goto('/console/runs/00000000-0000-4000-8000-000000000000');
    expect(response?.status()).toBe(404);
    await expect(page.getByText(/Not found/i).first()).toBeVisible();
  });

  test('rejects a malformed run id at the boundary', async ({ page }) => {
    const response = await page.request.get(API + '/v1/runs/not-a-uuid');
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('InvalidIdentifier');
  });
});
