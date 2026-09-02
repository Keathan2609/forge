import type { ReactNode } from 'react';
import { forgeApi } from '@/lib/api';
import { ErrorBox, PageHeader } from '@/components/ui';
import { DeadLetterList } from './dead-letter-list';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dead letters' };

export default async function DeadLettersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}): Promise<ReactNode> {
  const { status = 'OPEN' } = await searchParams;

  try {
    const page = await forgeApi.deadLetters(status);
    return <DeadLetterList items={page.items} status={status} />;
  } catch (err) {
    return (
      <>
        <PageHeader title="Dead letters" />
        <ErrorBox>Could not load dead letters: {(err as Error).message}</ErrorBox>
      </>
    );
  }
}
