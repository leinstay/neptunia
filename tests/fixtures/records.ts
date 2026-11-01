// Reads a value that its module types as a plain `object` by its fields. The stores and the record answer with objects
// whose shape their module does not write down yet, so a test that asserts on a field goes through this one place.
import type { Untyped } from '../../src/tools/types.ts';

export function asRecord(value: unknown): Record<string, Untyped> {
  return value as Record<string, Untyped>;
}
