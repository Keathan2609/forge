'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { forgeApi } from '@/lib/api';
import { Card, ErrorBox, ui } from '@/components/ui';

/**
 * Trigger a run from the console.
 *
 * The input is free-form JSON rather than a generated form: `inputSchema` is
 * documentation, not a validating schema, and generating a form from it would imply a
 * guarantee the platform does not make. The textarea is pre-filled from the schema's
 * keys so there is still something to edit rather than an empty box.
 */
export function TriggerPanel({
  workflowKey,
  inputSchema,
}: {
  workflowKey: string;
  inputSchema: Record<string, unknown>;
}): ReactNode {
  const router = useRouter();
  const [value, setValue] = useState(() => suggestInput(inputSchema));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trigger = async (): Promise<void> => {
    setError(null);

    let input: Record<string, unknown>;
    try {
      input = value.trim() === '' ? {} : (JSON.parse(value) as Record<string, unknown>);
    } catch (err) {
      setError('Input is not valid JSON: ' + (err as Error).message);
      return;
    }
    if (typeof input !== 'object' || Array.isArray(input) || input === null) {
      setError('Input must be a JSON object.');
      return;
    }

    setBusy(true);
    try {
      const result = await forgeApi.trigger(workflowKey, input);
      // Navigate straight to the live view — triggering and then hunting for the run in
      // a list is a needless step.
      router.push('/console/runs/' + result.runId);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Card title="Trigger a run">
      <div className={ui.field}>
        <label className={ui.label} htmlFor="trigger-input">
          Input (JSON)
        </label>
        <textarea
          id="trigger-input"
          className={ui.textarea}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          rows={7}
        />
        {Object.keys(inputSchema).length > 0 && (
          <p className={ui.hint}>Expected: {Object.keys(inputSchema).join(', ')}</p>
        )}
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      <div className={ui.actions} style={{ marginTop: 'var(--space-3)' }}>
        <button
          className={ui.button + ' ' + ui.buttonPrimary}
          onClick={() => void trigger()}
          disabled={busy}
        >
          {busy ? 'Starting…' : 'Run workflow'}
        </button>
      </div>
    </Card>
  );
}

/**
 * Build a starter payload from the definition's `inputSchema`.
 *
 * The schema values are prose ("string — git branch"), so the type is inferred from the
 * leading word. This is a convenience for the editor, not validation — the API is the
 * authority on what a valid input is.
 */
function suggestInput(schema: Record<string, unknown>): string {
  const keys = Object.keys(schema);
  if (keys.length === 0) return '{}';

  const sample: Record<string, unknown> = {};
  for (const key of keys) {
    const hint = String(schema[key] ?? '').toLowerCase();
    if (hint.startsWith('number')) sample[key] = 0;
    else if (hint.startsWith('boolean')) sample[key] = true;
    else if (hint.startsWith('array')) sample[key] = [];
    else if (hint.startsWith('object')) sample[key] = {};
    else sample[key] = '';
  }
  return JSON.stringify(sample, null, 2);
}
