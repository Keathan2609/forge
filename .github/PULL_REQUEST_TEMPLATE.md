# Summary

<!-- What does this change and why. One or two sentences. -->

# Changes

<!--
List the substantive changes. If this touches execution semantics — retries, leases,
delivery guarantees, state transitions, the outbox — say so explicitly and explain what
the new behaviour is, because those are the properties the rest of the system is built
on.
-->

-

# Testing

<!--
What you actually ran, and what it reported. If a behaviour is not covered by a test,
say which one and why.
-->

- [ ] `pnpm turbo run typecheck`
- [ ] `pnpm turbo run test`
- [ ] `pnpm test:integration` (needs PostgreSQL and Redis — `pnpm forge:infra`)
- [ ] `pnpm test:e2e` (needs a running stack)

# Checklist

- [ ] No change to delivery semantics, retry semantics or lease behaviour — or the
      change is described above and covered by a test
- [ ] Any new state transition is declared in `RUNTIME_TASK_TRANSITIONS`
- [ ] `pnpm lint` and `pnpm format:check` pass
- [ ] No secrets, credentials or machine-specific paths added
- [ ] Documentation updated if behaviour or setup changed
