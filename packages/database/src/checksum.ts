import { createHash } from 'node:crypto';

/**
 * Content-addressed workflow versions.
 *
 * Saving a definition that is byte-identical to the current version should be a no-op,
 * not a new version — otherwise a CI job that re-applies the same definition on every
 * deploy inflates the version history and detaches historical runs from a meaningful
 * lineage. Comparing raw JSON strings would fail on key order alone, so the document is
 * canonicalised first.
 */

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      // Editor-only layout hints must not create a new executable version.
      if (key === 'position') continue;
      if (v === undefined) continue;
      out[key] = canonicalise(v);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

export function definitionChecksum(definition: unknown): string {
  return createHash('sha256').update(canonicalJson(definition)).digest('hex');
}

/** Hash of a request body, used to detect idempotency-key reuse with different input. */
export function requestHash(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex').slice(0, 32);
}
