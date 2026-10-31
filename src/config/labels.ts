// The two sections of `config/labels.json`: `model`, the wording her requests and the analyzer's requests carry, and
// `owner`, the strings of the owner's answers. `joinLabels` gives the one flat object the engine reads as
// `hot.prompts.labels` (src/hot.js), every key at its path under its section. `splitLabels` sorts a flat labels file,
// a deployment's `prompts.local/labels.json` of the old layout, by the tracked split (tools/config-files-move.mjs).

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

/** `value` set at `keys` under `tree`, the sections on the way made. */
function setAt(tree: Tree, keys: ReadonlyArray<string>, value: unknown): void {
  let node = tree;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (isTree(next)) node = next;
    else node = node[key] = {};
  }
  node[keys[keys.length - 1] ?? ''] = value;
}

/** Whether `tree` holds a leaf at `keys` or any leaf under it. */
function holds(tree: Tree, keys: ReadonlyArray<string>): boolean {
  let node: unknown = tree;
  for (const key of keys) {
    if (!isTree(node) || !Object.hasOwn(node, key)) return false;
    node = node[key];
  }
  return true;
}

/** A flat labels object sorted by `tracked`: a leaf whose path `tracked.owner` holds goes to owner, any other to model. */
export function splitLabels(flat: Record<string, unknown>, tracked: LabelsFile): LabelsFile {
  const out: LabelsFile = { model: {}, owner: {} };
  const walk = (tree: Tree, keys: ReadonlyArray<string>): void => {
    for (const [key, value] of Object.entries(tree)) {
      const at = [...keys, key];
      if (isTree(value) && Object.keys(value).length > 0) walk(value, at);
      else setAt(holds(tracked.owner, at) ? out.owner : out.model, at, value);
    }
  };
  walk(flat, []);
  return out;
}
