# Examples

Runnable examples. All of them work against a local stack started with `pnpm forge:dev`.

## Workflow definitions

`workflows/` holds the demo workflows as plain JSON — the same documents the API accepts.
They are exported from `packages/database/src/demo-workflows.ts` by
`pnpm examples:export`, so they cannot drift from what `pnpm demo:seed` installs.

```bash
forge workflows apply examples/workflows/order-fulfilment.json
forge workflows validate examples/workflows/order-fulfilment.json
```

| File                       | Demonstrates                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `order-fulfilment.json`    | Fan-out, fan-in, non-retryable error codes                        |
| `deployment-pipeline.json` | Long sequential chain, conditional production gate                |
| `media-pipeline.json`      | Wide fan-out, per-node queue routing, branch pruning              |
| `resilience-demo.json`     | Retries with visible backoff, dead-lettering, failure propagation |
| `crash-recovery-demo.json` | Worker crash, lease expiry, recovery on another worker            |

The last two need `FORGE_DEMO_MODE=true`, because they use the `simulate.*` handlers.

## SDK

```bash
pnpm tsx examples/sdk/define-and-run.ts
pnpm tsx examples/sdk/stream-events.ts
pnpm tsx examples/sdk/idempotent-trigger.ts
```

## Notes on the definition format

A definition is a plain JSON document. The parts that are easy to get wrong:

**`input` mappings are references, not expressions.** `{ "from": "$.tasks.a.output.x" }`
reads a value; `{ "value": 42 }` is a constant. There is no computation on the input side,
which is what makes input mapping trivially safe.

**Reading a task means depending on it.** A node whose input references
`$.tasks.other.output` must have `other` in its `edges`. Without the edge there is no
guarantee `other` has produced output when this node runs — so the API rejects it rather
than letting you find out in production.

**Conditions are a tiny language, not JavaScript.** Comparison, boolean operators, and
five builtins (`exists`, `len`, `contains`, `lower`, `upper`). No arithmetic, no member
access outside `$`. See [ADR 007](../docs/adr/007-safe-condition-expressions.md).

**Node keys with dots need bracket notation** in paths: `$.tasks["http.fetch"].output`.
Hyphens work in dot notation (`$.tasks.prepare-shipment.output`) because the language has
no subtraction operator to collide with.
