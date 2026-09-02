# Kubernetes manifests

These manifests deploy FORGE to a cluster and demonstrate how each runtime should be
configured. **They are not a production environment**, and this file is explicit about
the gap rather than leaving you to discover it.

```bash
kubectl apply -k infra/kubernetes
kubectl -n forge get pods
kubectl -n forge port-forward svc/forge-web 3000:3000
```

## What is here

| Manifest             | Purpose                                                     |
| -------------------- | ----------------------------------------------------------- |
| `namespace.yaml`     | Namespace and a default-deny NetworkPolicy                  |
| `config.yaml`        | Non-secret configuration, and a Secret **placeholder**      |
| `postgres.yaml`      | Single-replica StatefulSet — for evaluation only            |
| `redis.yaml`         | Single-replica Deployment                                   |
| `migrate-job.yaml`   | `prisma migrate deploy`, run once before the services start |
| `api.yaml`           | API Deployment, Service, HPA and PodDisruptionBudget        |
| `scheduler.yaml`     | Control plane — publisher, reaper, sweepers, cron           |
| `worker.yaml`        | Worker Deployment with an HPA driven by queue depth         |
| `web.yaml`           | Console Deployment and Service                              |
| `kustomization.yaml` | Ties them together and applies common labels                |

## What each runtime needs, and why

**API** — stateless, horizontally scalable. Readiness probes `/health/ready`, which
checks PostgreSQL and Redis; liveness probes `/health`, which checks nothing. Conflating
the two turns a brief database blip into a restart loop that makes the outage permanent.

**Control plane** — every loop is safe to run on N replicas (see
`docs/adr/003-transactional-outbox.md`), so this scales out. Two replicas are configured
rather than one so a node drain does not pause dispatching.

**Workers** — the interesting one. `terminationGracePeriodSeconds: 60` gives a worker
time to drain in-flight tasks on SIGTERM. Anything it cannot finish is recovered by lease
expiry, so a hard kill is _safe_ — but draining avoids a ~15 second delay per task, which
adds up across a rolling deploy.

The worker HPA scales on `forge_queue_depth`, not CPU. A worker waiting on a slow
downstream service uses almost no CPU while the queue grows; CPU-based autoscaling would
scale down exactly when more capacity is needed.

## What would have to change for production

Named honestly, because a manifest that looks production-ready and is not is worse than
one that admits its scope:

1. **PostgreSQL** — the StatefulSet here is a single pod with a PVC. No replication, no
   backups, no point-in-time recovery, no connection pooler. Production means a managed
   service (RDS/Cloud SQL) or an operator such as CloudNativePG, plus PgBouncer, because
   every worker replica holds connections.

2. **Redis** — single instance, no persistence tuning, no failover. Production means a
   managed instance or Redis Sentinel/Cluster. FORGE tolerates losing Redis (it is
   transport, not state) but a failover still stalls dispatch until it recovers.

3. **Secrets** — `config.yaml` contains a Secret with placeholder values so `kubectl
apply -k` works out of the box. Real deployments must use External Secrets Operator,
   Sealed Secrets, or the cloud provider's secret manager. **Never commit real
   credentials to a manifest.**

4. **Ingress and TLS** — not included. There is no Ingress, no cert-manager, no
   `Certificate`. FORGE's dev-mode API key is not an authentication system; production
   needs an identity provider in front of both the API and the console.

5. **Custom metrics for the HPA** — the worker HPA references
   `forge_queue_depth` as an External metric. That requires Prometheus plus
   prometheus-adapter (or KEDA) to be installed and configured. Without it the HPA will
   not scale, and it fails _open_ — the deployment keeps its replica count.

6. **Observability** — no OpenTelemetry Collector, no Prometheus, no Grafana. The
   services export OTLP and expose `/metrics`; something has to collect them.

7. **Resource limits** — the requests and limits here are guesses sized for a demo
   workload. Real values come from measuring your own tasks.

8. **PodSecurityContext** — containers run as non-root with a read-only root filesystem,
   which is right. A production cluster should also enforce Pod Security Admission at the
   namespace level.
