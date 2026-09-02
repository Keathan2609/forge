import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateWorkflowRequestSchema,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowSummaryView,
  type WorkflowVersionView,
} from '@forge/contracts';
import { validateDefinition, criticalPathLength, compileGraph } from '@forge/engine';
import {
  knownHandlerTypes,
  listVersions,
  listWorkflows,
  resolveVersion,
  saveDefinition,
  type PrismaClient,
} from '@forge/database';
import type { Logger } from '@forge/logger';
import { FORGE_LOGGER, FORGE_PRISMA } from '../infra/providers';
import { WorkflowKeyPipe, zodBody } from '../common/validation';

/**
 * Workflow definitions and versions.
 *
 * The API owns definitions; it never executes them. Saving is idempotent by content —
 * posting the same graph twice returns the same version rather than inflating the
 * history, which matters because CI pipelines re-apply definitions on every deploy.
 */
@Controller('v1/workflows')
export class WorkflowsController {
  constructor(
    @Inject(FORGE_PRISMA) private readonly prisma: PrismaClient,
    @Inject(FORGE_LOGGER) private readonly logger: Logger,
  ) {}

  @Get()
  async list(): Promise<{ items: WorkflowSummaryView[] }> {
    return { items: await listWorkflows(this.prisma) };
  }

  /**
   * Validate a definition without saving it.
   *
   * The DAG editor calls this as you draw, so it returns *every* issue rather than
   * failing on the first, and separates errors (unsaveable) from warnings (saveable but
   * worth knowing — an unknown handler type, a node timeout longer than the run's).
   */
  @Post('validate')
  async validate(@Body(zodBody(WorkflowDefinitionSchema)) definition: WorkflowDefinition): Promise<{
    valid: boolean;
    errors: unknown[];
    warnings: unknown[];
    analysis?: { nodes: number; edges: number; entryNodes: string[]; criticalPath: number };
  }> {
    const knownTypes = await knownHandlerTypes(this.prisma);
    const result = validateDefinition(definition, { knownTypes });

    if (!result.valid) {
      return { valid: false, errors: result.errors, warnings: result.warnings };
    }

    const graph = compileGraph(definition, { knownTypes });
    return {
      valid: true,
      errors: [],
      warnings: result.warnings,
      analysis: {
        nodes: definition.nodes.length,
        edges: definition.edges.length,
        entryNodes: [...graph.entryNodes],
        criticalPath: criticalPathLength(graph),
      },
    };
  }

  @Post()
  async create(
    @Body(zodBody(CreateWorkflowRequestSchema))
    body: {
      definition: WorkflowDefinition;
      changelog?: string;
    },
  ): Promise<{ key: string; version: number; created: boolean; checksum: string }> {
    const result = await saveDefinition(this.prisma, body.definition, {
      ...(body.changelog ? { changelog: body.changelog } : {}),
    });

    this.logger.info(
      {
        workflowKey: body.definition.key,
        version: result.version,
        created: result.created,
        nodes: body.definition.nodes.length,
      },
      result.created ? 'workflow version created' : 'workflow definition unchanged',
    );

    return {
      key: body.definition.key,
      version: result.version,
      created: result.created,
      checksum: result.checksum,
    };
  }

  @Get(':key')
  async get(
    @Param('key', WorkflowKeyPipe) key: string,
    @Query('version') version?: string,
  ): Promise<{
    key: string;
    name: string;
    version: number;
    definition: WorkflowDefinition;
    analysis: { nodes: number; edges: number; entryNodes: string[]; criticalPath: number };
  }> {
    const resolved = await resolveVersion(this.prisma, key, version ? Number(version) : undefined);
    if (!resolved) throw new NotFoundException('workflow "' + key + '" not found');

    const graph = compileGraph(resolved.definition);
    return {
      key: resolved.workflowKey,
      name: resolved.workflowName,
      version: resolved.version,
      definition: resolved.definition,
      analysis: {
        nodes: resolved.definition.nodes.length,
        edges: resolved.definition.edges.length,
        entryNodes: [...graph.entryNodes],
        criticalPath: criticalPathLength(graph),
      },
    };
  }

  @Get(':key/versions')
  async versions(
    @Param('key', WorkflowKeyPipe) key: string,
  ): Promise<{ items: WorkflowVersionView[] }> {
    const items = await listVersions(this.prisma, key);
    if (items.length === 0) throw new NotFoundException('workflow "' + key + '" not found');
    return { items };
  }
}
