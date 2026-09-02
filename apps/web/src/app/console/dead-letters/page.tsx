import type { ReactNode } from 'react';
import { forgeApi } from '@/lib/api';
import { ErrorBox, PageHeader } from '@/components/ui';
import { DeadLetterList } from './dead-letter-list';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dead letters' };

const STATUSES = ['OPEN', 'REPLAYED', 'ACKNOWLEDGED'] as const;

export default async function DeadLettersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}): Promise<ReactNode> {
  const { status = 'OPEN' } = await searchParams;

  try {
    // All three buckets, in parallel. The filter row shows a count against every status,
    // not just the selected one — "12 open, 3 replayed, 7 acknowledged" is the shape of
    // the backlog, and it is not visible if the page only ever fetches what is on screen.
    const pages = await Promise.all(STATUSES.map((s) => forgeApi.deadLetters(s)));
    const counts = Object.fromEntries(
      STATUSES.map((s, i) => [s, pages[i]?.items.length ?? 0]),
    ) as Record<string, number>;

    const selected = STATUSES.indexOf(status as (typeof STATUSES)[number]);
    const items = (selected >= 0 ? pages[selected] : pages[0])?.items ?? [];

    return <DeadLetterList items={items} status={status} counts={counts} />;
  } catch (err) {
    return (
      <>
        <PageHeader title="Dead letters" />
        <ErrorBox>Could not load dead letters: {(err as Error).message}</ErrorBox>
      </>
    );
  }
}
