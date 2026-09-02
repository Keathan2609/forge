import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ApiError, forgeApi } from '@/lib/api';
import { WorkflowEditor } from '../../new/editor';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<{ title: string }> {
  const { key } = await params;
  return { title: 'Edit ' + key };
}

/**
 * Edit an existing workflow.
 *
 * Saving creates a *new version* rather than mutating the current one — in-flight runs
 * keep executing the graph they started with. That is the whole point of versioning, and
 * it is why this page reuses the create editor unchanged.
 */
export default async function EditWorkflowPage({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<ReactNode> {
  const { key } = await params;
  try {
    const workflow = await forgeApi.workflow(key);
    return <WorkflowEditor initial={workflow.definition} />;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}
