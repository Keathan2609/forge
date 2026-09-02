# Contributing

## Setup

Requires Node ≥ 20.11, pnpm ≥ 10 and Docker.

```bash
pnpm install
pnpm forge:dev      # containers + all five runtimes with live reload
pnpm demo:seed      # demo workflows and backfilled history
```

PostgreSQL is on **5435** and Redis on **6381** — offset from the defaults so this stack
runs alongside an existing local install.

## Before opening a pull request

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:setup && pnpm test:integration
pnpm exec prettier --check "**/*.{ts,tsx,js,mjs,json,md,yml,yaml}"
```

CI runs all of these plus a Docker build of every runtime image.

## Where code goes

The boundary that matters most:

**`packages/engine` must stay pure.** No database, no network, no clock reads that are
not injected, no `Date.now()` outside a defaulted parameter. It is the reason the entire
orchestration policy has 190 tests that run in milliseconds. If a change to the engine
needs I/O, the change belongs somewhere else.

| Layer                | Belongs there                                                |
| -------------------- | ------------------------------------------------------------ |
| `packages/contracts` | Zod schemas, view models, enums, queue message shapes        |
| `packages/engine`    | DAG analysis, state machine, retry maths, expressions — pure |
| `packages/database`  | Prisma schema, repositories, transactions                    |
| `packages/transport` | Redis queues and pub/sub                                     |
| `apps/api`           | HTTP surface, validation, auth, SSE                          |
| `apps/worker`        | Task execution, handler registry, lease renewal              |
| `apps/scheduler`     | Control-plane loops                                          |

## A note on Prisma Client generation

`prisma generate` runs from `packages/database`'s **postinstall**, not from its `build`.

Coupling codegen to the build means every build tries to replace the native query-engine
binary — which fails with `EPERM` whenever a worker or the API has it loaded — and
regenerates a client whose schema has not changed. If you edit `schema.prisma`, run:

```bash
pnpm db:generate      # stop the running stack first, on Windows
pnpm db:migrate --name your_change
```

## Adding a state transition

FORGE has shipped three bugs of exactly one shape: a component performed a transition the
state machine forbade. The engine's tests asserted the plan, the state machine's tests
asserted the table, and neither noticed they disagreed.

So there is a process:

1. Add the transition to `TASK_TRANSITIONS` (or `WORKFLOW_TRANSITIONS`) with a comment
   explaining why it is legal.
2. Add it to `RUNTIME_TASK_TRANSITIONS` with the component that performs it.
3. `packages/engine/test/transition-coverage.test.ts` will fail if the two disagree.

Skipping step 2 means the guard does not cover your new code path.

## Adding a task handler

Handlers live in `apps/worker/src/handlers/`. A node's `type` is a key into the registry —
never anything the worker interprets, loads or evaluates. That constraint is what makes it
safe to accept workflow definitions over an HTTP API, so:

- **never** shell out, `eval`, or dynamically import based on task input
- validate input and throw `NonRetryableError` for deterministic failures, so the retry
  budget is not spent on a certainty
- respect `ctx.signal` — it fires on timeout, lease loss and cancellation
- long-running handlers should call `ctx.progress()` and check `ctx.isCancelled()`

Anything under `simulate.*` is demo-only and must be marked `demoOnly: true`.

## Writing tests

- **Engine changes** need unit tests. There is no excuse for an untested scheduling rule;
  they need no infrastructure.
- **Anything touching leases, the outbox, idempotency or recovery** needs an integration
  test. Those behaviours only exist in the interaction between the engine, the database's
  constraints and the transport — a test that mocks any of the three will pass while the
  system is broken.
- Integration tests use their own database and Redis index (`pnpm test:setup`). They must
  keep working while `pnpm forge:dev` is running.

## Style

Enforced by ESLint and Prettier; `pnpm lint --fix` handles most of it.

Two things the tooling cannot check:

**Comments explain why, not what.** `// increment the counter` above `count++` is noise.
`// Marking before pushing would silently drop every message whose push failed` is the
reason the code is in that order, and it is the difference between someone preserving the
behaviour and someone "simplifying" it.

**No `any`.** `unknown` plus a narrowing check, or a named type. `strict` and
`noUncheckedIndexedAccess` are on for every package.

## Commits

Conventional Commits:

```
feat(engine): support conditional edges on fan-in
fix(worker): abort in-flight work when a lease renewal fails
docs(adr): record why Redis is not the source of truth
```

## Reporting a security issue

Open a private security advisory rather than a public issue. Areas of particular
interest: the condition expression parser (`packages/engine/src/expression.ts`), payload
validation (`packages/contracts/src/workflow.ts`), and the handler registry.
