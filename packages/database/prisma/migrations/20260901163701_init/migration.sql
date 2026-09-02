-- CreateEnum
CREATE TYPE "WorkflowRunState" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "TaskRunState" AS ENUM ('PENDING', 'BLOCKED', 'READY', 'QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'DEAD_LETTERED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TaskAttemptState" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABANDONED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkerState" AS ENUM ('ONLINE', 'DRAINING', 'OFFLINE', 'UNRESPONSIVE');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "OutboxEventType" AS ENUM ('TASK_DISPATCH', 'RUN_ADVANCE', 'EVENT_BROADCAST');

-- CreateEnum
CREATE TYPE "DeadLetterStatus" AS ENUM ('OPEN', 'REPLAYED', 'ACKNOWLEDGED');

-- CreateTable
CREATE TABLE "workflow_definition" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "latestVersion" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_version" (
    "id" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "changelog" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_node" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "queue" TEXT NOT NULL DEFAULT 'default',
    "timeoutMs" INTEGER NOT NULL,
    "maxAttempts" INTEGER NOT NULL,
    "condition" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "position" JSONB,

    CONSTRAINT "workflow_node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_edge" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "fromKey" TEXT NOT NULL,
    "toKey" TEXT NOT NULL,
    "condition" TEXT,

    CONSTRAINT "workflow_edge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_schedule" (
    "id" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT,
    "runAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "input" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastRunId" UUID,
    "lastFiredKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run" (
    "id" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "workflowName" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "state" "WorkflowRunState" NOT NULL DEFAULT 'PENDING',
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "errorMessage" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "triggeredBy" TEXT NOT NULL DEFAULT 'api',
    "idempotencyKey" TEXT,
    "scheduleId" UUID,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "cancelReason" TEXT,
    "timeoutMs" INTEGER NOT NULL,
    "traceId" TEXT,
    "eventSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "workflow_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_run" (
    "id" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "queue" TEXT NOT NULL DEFAULT 'default',
    "state" "TaskRunState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "recoveries" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "retryPolicy" JSONB NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "timeoutMs" INTEGER NOT NULL,
    "nextAttemptAt" TIMESTAMP(3),
    "workerId" TEXT,
    "traceId" TEXT,
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_attempt" (
    "id" UUID NOT NULL,
    "taskRunId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "state" "TaskAttemptState" NOT NULL DEFAULT 'RUNNING',
    "workerId" TEXT,
    "dispatchId" UUID,
    "input" JSONB,
    "output" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "errorStack" TEXT,
    "traceId" TEXT,
    "spanId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "task_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "state" "WorkerState" NOT NULL DEFAULT 'ONLINE',
    "version" TEXT NOT NULL,
    "queues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "concurrency" INTEGER NOT NULL DEFAULT 1,
    "activeTasks" INTEGER NOT NULL DEFAULT 0,
    "tasksCompleted" INTEGER NOT NULL DEFAULT 0,
    "tasksFailed" INTEGER NOT NULL DEFAULT 0,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shutdownAt" TIMESTAMP(3),

    CONSTRAINT "worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_lease" (
    "id" UUID NOT NULL,
    "taskRunId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "workerId" UUID NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewals" INTEGER NOT NULL DEFAULT 0,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,

    CONSTRAINT "worker_lease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_event" (
    "id" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "taskRunId" UUID,
    "nodeKey" TEXT,
    "workerId" TEXT,
    "attemptNumber" INTEGER,
    "traceId" TEXT,
    "message" TEXT,
    "payload" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "type" "OutboxEventType" NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letter" (
    "id" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "taskRunId" UUID NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT NOT NULL,
    "input" JSONB,
    "lastOutput" JSONB,
    "status" "DeadLetterStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "replayRunId" UUID,

    CONSTRAINT "dead_letter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definition_key_key" ON "workflow_definition"("key");

-- CreateIndex
CREATE INDEX "workflow_definition_archived_updatedAt_idx" ON "workflow_definition"("archived", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_version_definitionId_version_key" ON "workflow_version"("definitionId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_version_definitionId_checksum_key" ON "workflow_version"("definitionId", "checksum");

-- CreateIndex
CREATE INDEX "workflow_node_type_idx" ON "workflow_node"("type");

-- CreateIndex
CREATE INDEX "workflow_node_queue_idx" ON "workflow_node"("queue");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_node_versionId_key_key" ON "workflow_node"("versionId", "key");

-- CreateIndex
CREATE INDEX "workflow_edge_versionId_idx" ON "workflow_edge"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_edge_versionId_fromKey_toKey_key" ON "workflow_edge"("versionId", "fromKey", "toKey");

-- CreateIndex
CREATE INDEX "workflow_schedule_enabled_nextRunAt_idx" ON "workflow_schedule"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "workflow_schedule_definitionId_idx" ON "workflow_schedule"("definitionId");

-- CreateIndex
CREATE INDEX "workflow_run_state_createdAt_idx" ON "workflow_run"("state", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "workflow_run_workflowKey_createdAt_idx" ON "workflow_run"("workflowKey", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "workflow_run_createdAt_idx" ON "workflow_run"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "workflow_run_state_startedAt_idx" ON "workflow_run"("state", "startedAt");

-- CreateIndex
CREATE INDEX "workflow_run_scheduleId_idx" ON "workflow_run"("scheduleId");

-- CreateIndex
CREATE INDEX "task_run_state_nextAttemptAt_idx" ON "task_run"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "task_run_workflowRunId_state_idx" ON "task_run"("workflowRunId", "state");

-- CreateIndex
CREATE INDEX "task_run_state_queue_idx" ON "task_run"("state", "queue");

-- CreateIndex
CREATE INDEX "task_run_workerId_state_idx" ON "task_run"("workerId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "task_run_workflowRunId_nodeKey_key" ON "task_run"("workflowRunId", "nodeKey");

-- CreateIndex
CREATE INDEX "task_attempt_workerId_startedAt_idx" ON "task_attempt"("workerId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "task_attempt_state_startedAt_idx" ON "task_attempt"("state", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "task_attempt_taskRunId_attemptNumber_key" ON "task_attempt"("taskRunId", "attemptNumber");

-- CreateIndex
CREATE INDEX "worker_state_lastHeartbeatAt_idx" ON "worker"("state", "lastHeartbeatAt");

-- CreateIndex
CREATE INDEX "worker_lease_releasedAt_expiresAt_idx" ON "worker_lease"("releasedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "worker_lease_workerId_releasedAt_idx" ON "worker_lease"("workerId", "releasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "worker_lease_taskRunId_attemptNumber_key" ON "worker_lease"("taskRunId", "attemptNumber");

-- CreateIndex
CREATE INDEX "execution_event_workflowRunId_occurredAt_idx" ON "execution_event"("workflowRunId", "occurredAt");

-- CreateIndex
CREATE INDEX "execution_event_type_occurredAt_idx" ON "execution_event"("type", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "execution_event_occurredAt_idx" ON "execution_event"("occurredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "execution_event_workflowRunId_seq_key" ON "execution_event"("workflowRunId", "seq");

-- CreateIndex
CREATE INDEX "outbox_event_status_availableAt_createdAt_idx" ON "outbox_event"("status", "availableAt", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_event_aggregateId_idx" ON "outbox_event"("aggregateId");

-- CreateIndex
CREATE INDEX "outbox_event_status_createdAt_idx" ON "outbox_event"("status", "createdAt");

-- CreateIndex
CREATE INDEX "idempotency_record_expiresAt_idx" ON "idempotency_record"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_record_scope_key_key" ON "idempotency_record"("scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "dead_letter_taskRunId_key" ON "dead_letter"("taskRunId");

-- CreateIndex
CREATE INDEX "dead_letter_status_createdAt_idx" ON "dead_letter"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "dead_letter_workflowKey_status_idx" ON "dead_letter"("workflowKey", "status");

-- AddForeignKey
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "workflow_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_node" ADD CONSTRAINT "workflow_node_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "workflow_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_edge" ADD CONSTRAINT "workflow_edge_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "workflow_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_schedule" ADD CONSTRAINT "workflow_schedule_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "workflow_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "workflow_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "workflow_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_run" ADD CONSTRAINT "task_run_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "workflow_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "task_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_lease" ADD CONSTRAINT "worker_lease_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "task_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_lease" ADD CONSTRAINT "worker_lease_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_event" ADD CONSTRAINT "execution_event_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "workflow_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter" ADD CONSTRAINT "dead_letter_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "workflow_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter" ADD CONSTRAINT "dead_letter_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "task_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
