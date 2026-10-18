// The preamble of one errand run, picked by agent and model from the deployment's private
// prompt layer: the optional files of prompts.local/preambles/ (loaded live by src/hot.js into
// `hot.prompts.preambles`, by base name), with no tracked default. One shared text does not fit
// every model, so a run's preamble is the matching files, in this order, joined by a blank line:
//   all.md                 every run;
//   <agent>.md             the runs of one agent (`web.md`, `server.md`, ...);
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

/** The provider prefix an OpenCode model id may carry, also matched without it. */
const PROVIDER_PREFIX = 'openrouter/';
/** What joins two preamble files. */
const SEPARATOR = '\n\n';

/**
 * The file-name forms of a model id: the whole id lowercased with every character outside
 * [a-z0-9.] replaced by `-`, then, when the id starts with `openrouter/`, the same of the rest.
 * `[]` for a blank or non-string id.
 * @param {unknown} model
 * @returns {string[]}
 */
export function modelSlugs(model) {
  if (typeof model !== 'string' || !model.trim()) return [];
  const id = model.trim().toLowerCase();
  const slug = (value) => value.replace(/[^a-z0-9.]/g, '-');
  const out = [slug(id)];
  if (id.startsWith(PROVIDER_PREFIX) && id.length > PROVIDER_PREFIX.length) out.push(slug(id.slice(PROVIDER_PREFIX.length)));
  return [...new Set(out)];
}

/**
 * The base names (no `.md`) of prompts.local/preambles/ a run of `agent` on `model` reads, in
 * composition order: `all`, `<agent>`, `@<model>` per form, `<agent>@<model>` per form.
 * @param {string} agent
 * @param {string|null|undefined} model
 * @returns {string[]}
 */
export function preambleNames(agent, model) {
  const slugs = modelSlugs(model);
  const names = ['all'];
  const hasAgent = typeof agent === 'string' && agent !== '';
  if (hasAgent) names.push(agent);
  for (const slug of slugs) names.push(`@${slug}`);
  if (hasAgent) for (const slug of slugs) names.push(`${agent}@${slug}`);
  return [...new Set(names)];
}

/** `value` trimmed when it is a string, else ''. */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The preamble of one run.
 * @param {object} options
 * @param {object|undefined} options.prompts  The live prompts (`preambles`: base name -> text).
 * @param {string} options.agent
 * @param {string|null} [options.model]  The run's model id.
 * @param {number} [options.maxChars]  The cap of the composed text (characters).
 * @returns {{ text: string, files: string[], dropped: string[], chars: number }}  `files`: the
 *   sent files (`preambles/<name>.md`), in order; `dropped`:
 *   the matching files left out by the cap; `chars`: the length of `text`.
 */
export function composePreamble({ prompts, agent, model = null, maxChars = Infinity } = {}) {
  const folder = prompts?.preambles && typeof prompts.preambles === 'object' ? prompts.preambles : {};
  const parts = [];
  for (const name of preambleNames(agent, model)) {
    const text = Object.hasOwn(folder, name) ? textOf(folder[name]) : '';
    if (text) parts.push({ file: `preambles/${name}.md`, text });
  }
  const files = [];
  const dropped = [];
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
