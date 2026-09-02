# 007 — A purpose-built expression language for conditions

**Status:** accepted
**Date:** 2026-09-01

## Context

Workflow definitions arrive over an HTTP API, from anyone allowed to call it. Nodes and
edges can carry a condition — `$.input.branch == 'main'` — that FORGE evaluates inside
the control plane against the execution context.

That is a request to evaluate a user-supplied string in a privileged process. The obvious
implementations are all remote code execution:

```ts
eval(condition); // trivially RCE
new Function('ctx', 'return ' + c); // identically RCE
vm.runInNewContext(condition, ctx); // escapable; `vm` is not a security boundary
```

Node's own documentation says plainly that `vm` must not be used to run untrusted code —
escaping it via `this.constructor.constructor('return process')()` is a two-line trick.

## Decision

**A hand-written lexer, parser and evaluator for a deliberately tiny language.**

The grammar is small enough to state completely:

```
expr       := or
or         := and ( '||' and )*
and        := unary ( '&&' unary )*
unary      := '!' unary | comparison
comparison := primary ( ('=='|'!='|'>='|'<='|'>'|'<') primary )?
primary    := '(' expr ')' | literal | path | call
```

What it can produce: booleans, numbers, strings, null, and arrays of those. What it does
not have, at all:

- assignment, or any mutation
- member access outside the whitelisted `$` context
- loops, recursion, or user-defined functions
- any host callable beyond five pure builtins (`exists`, `len`, `contains`, `lower`,
  `upper`)

Additional hard limits: 512 characters, 200 AST nodes, and path segments matching
`__proto__`, `constructor` or `prototype` are rejected at parse time. Path resolution uses
`Object.hasOwn` at every step, so it stays off the prototype chain even for a crafted
context.

Parsing is separated from evaluation, so a definition is validated once when it is saved
rather than failing mid-run — the console reports a bad condition as you type it.

## Alternatives considered

**A sandboxed VM (`isolated-vm`, `vm2`).** `isolated-vm` is a genuine boundary; `vm2` was
deprecated after a series of escapes. Rejected because it is a native dependency that
complicates every build and container image, to run a language whose entire useful
surface is comparison and boolean logic. The threat model does not justify shipping a
JavaScript engine.

**A general expression library (JSONata, expr-eval, filtrex).** Reasonable, and would
have been less code. Rejected on threat surface: each supports far more than FORGE needs
(arithmetic, function definition, arbitrary member access), and each therefore has more
to get wrong. A dependency's security posture becomes yours, and here the alternative was
~450 lines of code that is fully covered by tests.

**CEL (Common Expression Language).** Exactly the right tool conceptually, and what
Kubernetes uses. Rejected because the mature implementations are Go and C++; the
JavaScript ports were less mature than writing a parser this small.

**No conditions at all.** Genuinely considered — conditional branching could be pushed
into task handlers, which are trusted code. Rejected because "only run the production
deploy on `main`" is a workflow-shaping concern, and expressing it as a handler that
sometimes does nothing loses the distinction between `SKIPPED` and `SUCCEEDED` in the
graph, which is exactly the thing an operator wants to see.

## Consequences

**Good.**

- No code-execution surface. The worst a malicious condition achieves is a parse error.
- Total and fast: no recursion, no unbounded loops, no way to hang the control plane.
- Errors carry a character position, so the editor points at the problem.
- Zero dependencies, and fully covered — 43 tests including explicit prototype-pollution
  and injection attempts.

**Bad, and accepted.**

- The language is genuinely limited. No arithmetic, no string concatenation, no date
  handling. Anything more goes in a task handler, which is reviewed code.
- It is bespoke, so it is one more thing to learn and to maintain. The grammar is
  documented above and in `expression.ts`.
- A node key containing a dot needs bracket notation (`$.tasks["http.fetch"]`), because
  dots are the segment separator. Hyphens work in dot notation only because the language
  has no subtraction operator to collide with — which is stated in the code, since it is
  the kind of thing a future change could quietly break.
