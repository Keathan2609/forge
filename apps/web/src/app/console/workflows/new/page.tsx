import type { ReactNode } from 'react';
import { WorkflowEditor } from './editor';

export const metadata = { title: 'New workflow' };

export default function NewWorkflowPage(): ReactNode {
  return <WorkflowEditor />;
}
