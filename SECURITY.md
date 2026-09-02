# Security Policy

## Supported versions

FORGE is a single-developer project and has not been released as a versioned artifact.
Only the current `main` branch is maintained.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

Use GitHub's **private vulnerability reporting** on this repository:
[Security → Report a vulnerability](https://github.com/Keathan2609/forge/security/advisories/new).
If that is unavailable to you, contact the repository owner through their
[GitHub profile](https://github.com/Keathan2609).

A useful report includes what an attacker can do, the steps to reproduce it, and the
commit you tested against. Please allow time for a fix before disclosing publicly.

## Scope

FORGE accepts workflow definitions over an HTTP API, so the parts most worth scrutiny
are the ones that turn submitted data into behaviour:

- the condition expression parser (`packages/engine/src/expression.ts`), which is
  hand-written specifically to avoid `eval`, `new Function` and `vm`
- workflow and input schema validation (`packages/contracts`), including prototype
  pollution defences
- task handler registration and dispatch in the worker
- API input validation, identifier handling and database access

## Known limitations

These are deliberate properties of a portfolio project, documented so they are not
mistaken for oversights. They are not vulnerabilities in themselves, but they do mean
FORGE should not be exposed to untrusted networks as it stands:

- **Authentication is a single shared API key**, compared in constant time and disabled
  by default in local development. There is no user model, no RBAC and no rotation.
- **Transport and storage are unencrypted** in the shipped Docker Compose and Kubernetes
  manifests. There is no TLS, and the committed Kubernetes `Secret` contains explicit
  `CHANGE_ME` placeholders rather than real credentials.
- **Failure-injection handlers** (`simulate.*`) can crash the worker process by design.
  They are only registered when `FORGE_DEMO_MODE=true`, which the API refuses to combine
  with `NODE_ENV=production`.
- **The Kubernetes manifests are not production-ready.** `infra/kubernetes/README.md`
  enumerates what would have to change first.
