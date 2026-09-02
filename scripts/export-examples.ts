/**
 * Export the demo workflow definitions to `examples/workflows/*.json`.
 *
 * The definitions live in TypeScript (`packages/database/src/demo-workflows.ts`) so they
 * are type-checked against the schema and cannot drift from what `pnpm demo:seed`
 * installs. This writes the same documents out as plain JSON, which is what a user
 * actually posts to the API — so the examples are generated rather than a second,
 * hand-maintained copy that would eventually disagree.
 *
 *   pnpm examples:export
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_WORKFLOWS } from '@forge/database';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'examples', 'workflows');

mkdirSync(outDir, { recursive: true });

for (const workflow of DEMO_WORKFLOWS) {
  const path = resolve(outDir, workflow.key + '.json');
  writeFileSync(path, JSON.stringify(workflow, null, 2) + '\n', 'utf8');
  console.log(
    '  ' +
      workflow.key.padEnd(24) +
      workflow.nodes.length +
      ' nodes, ' +
      workflow.edges.length +
      ' edges',
  );
}

console.log('\nwrote ' + DEMO_WORKFLOWS.length + ' definitions to examples/workflows/');
