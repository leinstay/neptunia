// The preamble of one errand run, picked by agent and model from the deployment's private
// prompt layer: the optional files of prompts.local/preambles/ (loaded live by src/hot.js into
// `hot.prompts.preambles`, by base name), with no tracked default. One shared text does not fit
// every model, so a run's preamble is the matching files, in this order, joined by a blank line:
//   all.md                 every run;
//   <agent>.md             the runs of one agent (`scout.md`, `server.md`, ...);
//   @<model>.md            the runs on one model;
//   <agent>@<model>.md     the runs of one agent on one model.
// <model> is the run's model id lowercased, every character outside [a-z0-9.] replaced by `-`
// (`openrouter/moonshotai/kimi-k3` -> `openrouter-moonshotai-kimi-k3`); an id with a leading
// `openrouter/` provider prefix also matches without it (`moonshotai-kimi-k3`), the full form
// first when both files exist. An empty file is skipped.
// The composed text is capped at `maxChars` (the protocol's MAX_PREAMBLE_CHARS): over it, the
// files are taken in order, whole, each only while it still fits, and the rest are named as
// dropped, so a run is never refused for its preamble. Pure: no I/O, no log; the caller logs the
// file names and lengths, never a text.

import { objOf } from '../tools/types.ts';

/** The provider prefix an OpenCode model id may carry, also matched without it. */
const PROVIDER_PREFIX = 'openrouter/';
/** What joins two preamble files. */
const SEPARATOR = '\n\n';

/**
 * The file-name forms of a model id: the whole id lowercased with every character outside
 * [a-z0-9.] replaced by `-`, then, when the id starts with `openrouter/`, the same of the rest.
 * `[]` for a blank or non-string id.
 */
export function modelSlugs(model: unknown): Array<string> {
  if (typeof model !== 'string' || !model.trim()) return [];
  const id = model.trim().toLowerCase();
  const slug = (value: string): string => value.replace(/[^a-z0-9.]/g, '-');
  const out = [slug(id)];
  if (id.startsWith(PROVIDER_PREFIX) && id.length > PROVIDER_PREFIX.length)
    out.push(slug(id.slice(PROVIDER_PREFIX.length)));
  return [...new Set(out)];
}

/**
 * The base names (no `.md`) of prompts.local/preambles/ a run of `agent` on `model` reads, in
 * composition order: `all`, `<agent>`, `@<model>` per form, `<agent>@<model>` per form.
 */
export function preambleNames(agent: unknown, model: string | null | undefined): Array<string> {
  const slugs = modelSlugs(model);
  const names = ['all'];
  if (typeof agent === 'string' && agent !== '') {
    names.push(agent);
    for (const slug of slugs) names.push(`@${slug}`);
    for (const slug of slugs) names.push(`${agent}@${slug}`);
  } else {
    for (const slug of slugs) names.push(`@${slug}`);
  }
  return [...new Set(names)];
}

/** `value` trimmed when it is a string, else ''. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The preamble of one run.
 * `prompts` is the live prompts (`preambles`: base name to text), `model` the run's model id and `maxChars` the cap
 * of the composed text. `files` are the sent files (`preambles/<name>.md`), in order, `dropped` the matching files
 * the cap left out, `chars` the length of `text`.
 */
export function composePreamble({
  prompts,
  agent,
  model = null,
  maxChars = Infinity,
}: {
  prompts?: { preambles?: unknown };
  agent?: string;
  model?: string | null;
  maxChars?: number;
} = {}): { text: string; files: Array<string>; dropped: Array<string>; chars: number } {
  const folder = objOf(prompts?.preambles);
  const parts: Array<{ file: string; text: string }> = [];
  for (const name of preambleNames(agent, model)) {
    const text = Object.hasOwn(folder, name) ? textOf(folder[name]) : '';
    if (text) parts.push({ file: `preambles/${name}.md`, text });
  }
  const files: Array<string> = [];
  const dropped: Array<string> = [];
  let text = '';
  for (const part of parts) {
    const next = text ? `${text}${SEPARATOR}${part.text}` : part.text;
    if (next.length > maxChars) {
      dropped.push(part.file);
      continue;
    }
    text = next;
    files.push(part.file);
  }
  return { text, files, dropped, chars: text.length };
}
