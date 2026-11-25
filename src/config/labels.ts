// The two sections of `config/labels.json`: `model`, the wording the persona's requests and the analyzer's requests carry, and
// `owner`, the strings of the owner's answers. `joinLabels` gives the one flat object the engine reads as
// `hot.prompts.labels` (src/hot.ts), every key at its path under its section.

export type LabelsFile = { model: Record<string, unknown>; owner: Record<string, unknown> };

type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `owner` laid over `model` into a new object; throws naming the dotted key of a leaf both hold. */
function joinTrees(model: Tree, owner: Tree, prefix: string): Tree {
  const out: Tree = { ...model };
  for (const [key, value] of Object.entries(owner)) {
    const at = prefix === '' ? key : `${prefix}.${key}`;
    const there = out[key];
    if (there === undefined) out[key] = value;
    else if (isTree(there) && isTree(value)) out[key] = joinTrees(there, value, at);
    else throw new Error(`labels: ${at} is in both model and owner`);
  }
  return out;
}

/** `{ model, owner }` of a parsed labels file, a missing or malformed section as `{}`. */
export function labelsFileOf(parsed: unknown): LabelsFile {
  const tree = (value: unknown): Record<string, unknown> => (isTree(value) ? value : {});
  const file = tree(parsed);
  return { model: tree(file.model), owner: tree(file.owner) };
}

/** The two sections deep-merged into one flat object; throws, naming the dotted key, when a leaf is in both. */
export function joinLabels(file: LabelsFile): Record<string, unknown> {
  return joinTrees(file.model, file.owner, '');
}
