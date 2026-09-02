import type { ReactNode } from 'react';
import { forgeApi } from '@/lib/api';
import { ErrorBox, PageHeader } from '@/components/ui';
import { ScheduleList } from './schedule-list';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Schedules' };

export default async function SchedulesPage(): Promise<ReactNode> {
  try {
    const { items } = await forgeApi.schedules();
    return <ScheduleList items={items} />;
  } catch (err) {
    return (
      <>
        <PageHeader title="Schedules" />
        <ErrorBox>Could not load schedules: {(err as Error).message}</ErrorBox>
      </>
    );
  }
}
