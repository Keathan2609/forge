import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ApiError, forgeApi } from '@/lib/api';
import { RunView } from './run-view';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<{ title: string }> {
  const { id } = await params;
  try {
    const run = await forgeApi.run(id);
    return { title: run.workflowKey + ' · ' + run.state };
  } catch {
    return { title: 'Run' };
  }
}

/**
 * Run detail.
 *
 * The initial run and its event backlog are fetched server-side so the page is complete
 * on first paint — including for a finished run, which then never opens a stream at all.
 * The client component takes over for live updates.
 */
export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;

  try {
    const [run, events] = await Promise.all([forgeApi.run(id), forgeApi.runEvents(id)]);
    return <RunView runId={id} initialRun={run} initialEvents={events.items} />;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}
