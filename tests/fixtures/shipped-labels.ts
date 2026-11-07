// The tracked labels (`config/labels.json`, both sections joined as src/hot.ts joins them), for the tests of the request
// blocks whose keys the fixture of tests/fixtures/labels.ts does not hold. A test reads values off a request, never the
// wording of a label.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinLabels, labelsFileOf } from '../../src/config/labels.ts';
import type { Labels } from '../../src/turn/request/types.ts';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'labels.json');

function isLabels(value: Record<string, unknown>): value is Labels {
  return typeof value.self === 'string' && typeof value.units === 'object' && typeof value.transcript === 'object';
}

function read(): Labels {
  const parsed: unknown = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const joined = joinLabels(labelsFileOf(parsed));
  if (!isLabels(joined)) throw new Error('config/labels.json lacks the keys of a request');
  return joined;
}

export const shippedLabels: Labels = read();
