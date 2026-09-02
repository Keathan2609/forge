import { WorkflowDefinitionSchema, type WorkflowDefinition } from '@forge/contracts';
import { compileGraph } from '@forge/engine';
import {
  type Prisma,
  type PrismaClient,
  type Tx,
  isUniqueViolation,
  withTransaction,
} from '../client';
import { definitionChecksum } from '../checksum';

/**
 * Workflow definitions and their immutable versions.
 *
 * A definition is an identity (`order-fulfilment`); a version is an executable snapshot.
 * Nothing ever mutates a version, which is what lets a run started an hour ago finish
 * against the graph it began with while new runs use v3.
 */

export interface SaveDefinitionResult {
  definitionId: string;
  versionId: string;
  version: number;
  /** False when the definition was byte-identical to the existing latest version. */
  created: boolean;
  checksum: string;
}

/**
 * Create or update a workflow, returning the version to execute.
 *
 * The whole operation is one transaction: a partially-written version (rows in
 * `workflow_node` but no `workflow_version`, or a bumped `latestVersion` pointing at
 * nothing) would be unrecoverable without manual repair.
 */
export async function saveDefinition(
  prisma: PrismaClient,
  definition: WorkflowDefinition,
  options: { changelog?: string; createdBy?: string } = {},
): Promise<SaveDefinitionResult> {
  // Parse before persisting: this is the boundary where untrusted JSON becomes a
  // document the engine is allowed to execute.
  const parsed = WorkflowDefinitionSchema.parse(definition);
  // Called for its validation side-effect: throws GraphValidationError if the graph is
  // not executable. Nothing here needs the compiled form — the executor compiles it
  // again from the persisted document at dispatch time.
  compileGraph(parsed);
  const checksum = definitionChecksum(parsed);

  return withTransaction(prisma, async (tx) => {
    const existing = await tx.workflowDefinition.findUnique({
      where: { key: parsed.key },
      select: { id: true, latestVersion: true },
    });

    const definitionRow =
      existing ??
      (await tx.workflowDefinition.create({
        data: {
          key: parsed.key,
          name: parsed.name,
          description: parsed.description ?? null,
          latestVersion: 0,
        },
        select: { id: true, latestVersion: true },
      }));

    // Re-saving an unchanged graph returns the existing version rather than creating a
    // duplicate. The unique index on (definitionId, checksum) enforces this even if two
    // callers race here.
    const identical = await tx.workflowVersion.findFirst({
      where: { definitionId: definitionRow.id, checksum },
      select: { id: true, version: true },
    });
    if (identical) {
      await tx.workflowDefinition.update({
        where: { id: definitionRow.id },
        data: { name: parsed.name, description: parsed.description ?? null },
      });
      return {
        definitionId: definitionRow.id,
        versionId: identical.id,
        version: identical.version,
        created: false,
        checksum,
      };
    }

    const nextVersion = definitionRow.latestVersion + 1;

    const version = await tx.workflowVersion.create({
      data: {
        definitionId: definitionRow.id,
        version: nextVersion,
        checksum,
        definition: parsed as unknown as Prisma.InputJsonValue,
        changelog: options.changelog ?? null,
        createdBy: options.createdBy ?? 'system',
      },
      select: { id: true },
    });

    // Normalised projection, for operational queries. The JSON above stays
    // authoritative for execution.
    await tx.workflowNode.createMany({
      data: parsed.nodes.map((node) => ({
        versionId: version.id,
        key: node.key,
        name: node.name ?? node.key,
        type: node.type,
        queue: node.queue,
        timeoutMs: node.timeoutMs,
        maxAttempts: node.retryPolicy.maxAttempts,
        condition: node.condition ?? null,
        config: node.config as Prisma.InputJsonValue,
        position: (node.position ?? null) as Prisma.InputJsonValue,
      })),
    });

    if (parsed.edges.length > 0) {
      await tx.workflowEdge.createMany({
        data: parsed.edges.map((edge) => ({
          versionId: version.id,
          fromKey: edge.from,
          toKey: edge.to,
          condition: edge.condition ?? null,
        })),
        skipDuplicates: true,
      });
    }

    await tx.workflowDefinition.update({
      where: { id: definitionRow.id },
      data: {
        name: parsed.name,
        description: parsed.description ?? null,
        latestVersion: nextVersion,
        archived: false,
      },
    });

    return {
      definitionId: definitionRow.id,
      versionId: version.id,
      version: nextVersion,
      created: true,
      checksum,
    };
  }).catch((err: unknown) => {
    if (isUniqueViolation(err, 'checksum')) {
      // Lost a race with an identical concurrent save — re-read and return that one.
      return resolveExistingVersion(prisma, parsed.key, checksum);
    }
    throw err;
  });
}

async function resolveExistingVersion(
  prisma: PrismaClient,
  key: string,
  checksum: string,
): Promise<SaveDefinitionResult> {
  const version = await prisma.workflowVersion.findFirst({
    where: { checksum, definitionRef: { key } },
    select: { id: true, version: true, definitionId: true },
  });
  if (!version) throw new Error('workflow version disappeared during concurrent save');
  return {
    definitionId: version.definitionId,
    versionId: version.id,
    version: version.version,
    created: false,
    checksum,
  };
}

export interface ResolvedVersion {
  definitionId: string;
  versionId: string;
  version: number;
  workflowKey: string;
  workflowName: string;
  definition: WorkflowDefinition;
}

/** Resolve a workflow key (and optional version) to the exact document to execute. */
export async function resolveVersion(
  client: PrismaClient | Tx,
  key: string,
  version?: number,
): Promise<ResolvedVersion | null> {
  const definition = await client.workflowDefinition.findUnique({
    where: { key },
    select: { id: true, key: true, name: true, latestVersion: true },
  });
  if (!definition) return null;

  const target = version ?? definition.latestVersion;
  if (target < 1) return null;

  const row = await client.workflowVersion.findUnique({
    where: { definitionId_version: { definitionId: definition.id, version: target } },
    select: { id: true, version: true, definition: true },
  });
  if (!row) return null;

  return {
    definitionId: definition.id,
    versionId: row.id,
    version: row.version,
    workflowKey: definition.key,
    workflowName: definition.name,
    definition: row.definition as unknown as WorkflowDefinition,
  };
}

/** Load a version by its own id — used when replaying a historical run. */
export async function loadVersionById(
  client: PrismaClient | Tx,
  versionId: string,
): Promise<ResolvedVersion | null> {
  const row = await client.workflowVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      version: true,
      definition: true,
      definitionId: true,
      definitionRef: { select: { key: true, name: true } },
    },
  });
  if (!row) return null;
  return {
    definitionId: row.definitionId,
    versionId: row.id,
    version: row.version,
    workflowKey: row.definitionRef.key,
    workflowName: row.definitionRef.name,
    definition: row.definition as unknown as WorkflowDefinition,
  };
}

/**
 * Handler types advertised by workers that have heartbeated recently.
 * Fed into validation so the console can warn "nothing can run this node".
 */
export async function knownHandlerTypes(
  prisma: PrismaClient,
  livenessMs = 60_000,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - livenessMs);
  const workers = await prisma.worker.findMany({
    where: { lastHeartbeatAt: { gte: cutoff }, state: { in: ['ONLINE', 'DRAINING'] } },
    select: { capabilities: true },
  });
  return [...new Set(workers.flatMap((w) => w.capabilities))];
}
