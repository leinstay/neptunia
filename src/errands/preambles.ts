// The preamble of one errand run, picked by agent and model from the deployment's private
// prompt layer: the optional files of data/prompts/preambles/ (loaded live by src/hot.ts under the keys
// `preambles/<base name>`), with no tracked default. One shared text does not fit
// every model, so a run's preamble is the matching files, in this order, joined by a blank line:
//   all.md                 every run;
//   <agent>.md             the runs of one agent (`scout.md`, `server.md`, ...);
//   @<model>.md            the runs on one model;
//   <agent>@<model>.md     the runs of one agent on one model.
// <model> is the last path segment of the run's model id, lowercased and otherwise literal:
// `openrouter/anthropic/claude-sonnet-4.6` and `google/claude-sonnet-4.6` both read
// `@claude-sonnet-4.6.md`, and `claude-sonnet-4-6` does not. An empty file is skipped. Every
// matching file goes in whole: the composed text has no length cap, how much to write is the
// deployment's choice. Pure: no I/O, no log; the caller logs the file names and lengths, never a text.

import { objOf } from '../tools/types.ts';

/** What joins two preamble files. */
const SEPARATOR = '\n\n';

/**
 * The file-name form of a model id: its last path segment, lowercased, with no other change. Null for a blank or
 * non-string id and for an id that ends in a slash.
 */
export function modelSlug(model: unknown): string | null {
  if (typeof model !== 'string') return null;
  const segment = model.trim().toLowerCase().split('/').pop() ?? '';
  return segment === '' ? null : segment;
}

/**
 * The base names (no `.md`) of data/prompts/preambles/ a run of `agent` on `model` reads, in
 * composition order: `all`, `<agent>`, `@<model>`, `<agent>@<model>`.
 */
export function preambleNames(agent: unknown, model: string | null | undefined): Array<string> {
  const slug = modelSlug(model);
  const named = typeof agent === 'string' && agent !== '' ? agent : null;
  const names = ['all'];
  if (named !== null) names.push(named);
  if (slug !== null) names.push(`@${slug}`);
  if (named !== null && slug !== null) names.push(`${named}@${slug}`);
  return names;
}

/** `value` trimmed when it is a string, else ''. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The preamble of one run.
 * `preambles` is the live preamble files by base name (src/hot.ts#promptsInFolder of `preambles`) and `model` the run's model id. `files` are the sent
 * files (`preambles/<name>.md`), in order, and `chars` the length of `text`.
 */
export function composePreamble({
  preambles,
  agent,
  model = null,
}: {
  preambles?: unknown;
  agent?: string;
  model?: string | null;
} = {}): { text: string; files: Array<string>; chars: number } {
  const folder = objOf(preambles);
  const parts: Array<{ file: string; text: string }> = [];
  for (const name of preambleNames(agent, model)) {
    const text = Object.hasOwn(folder, name) ? textOf(folder[name]) : '';
    if (text) parts.push({ file: `preambles/${name}.md`, text });
  }
  const text = parts.map((part) => part.text).join(SEPARATOR);
  return { text, files: parts.map((part) => part.file), chars: text.length };
}
