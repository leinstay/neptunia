// The SKILL.md format: a block of front matter between two `---` lines, then the prose. `parseSkillFile` answers a
// skill or one code for the first thing wrong, so the loader (load.ts) can name a broken file and skip only it.
// Front matter holds one `key: value` per line: `name` (kebab-case), `description` (one line, her words), `tools`
// (a flow list `[a.b, c.d]`, empty allowed, or a block list of `- a.b` lines) and the optional `task`, the board task
// the skill came from. Any other key and any other YAML is refused. Pure text in, no disk.

import { createHash } from 'node:crypto';

export type ParsedSkill = {
  name: string;
  description: string;
  tools: Array<string>;
  task: string | null;
  body: string;
  source: string;
  contentHash: string;
};

export type SkillFileCode =
  | 'no-front-matter'
  | 'bad-front-matter'
  | 'no-name'
  | 'bad-name'
  | 'no-description'
  | 'no-tools'
  | 'bad-tools'
  | 'empty-body';

export type SkillParse = { ok: true; skill: ParsedSkill } | { ok: false; code: SkillFileCode };

const FENCE = '---';
const KEYS: ReadonlyArray<string> = ['name', 'description', 'tools', 'task'];
/** A skill's name, which is also its folder: no separator and no dot, so it cannot leave `data/skills/`. */
export const SKILL_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const TOOL = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

type Front = { values: Map<string, string>; list: Array<string> | null };

/** The key/value lines between the fences, or null when a line is neither a pair nor a list item under `tools:`. */
function readFront(lines: ReadonlyArray<string>): Front | null {
  const values = new Map<string, string>();
  let list: Array<string> | null = null;
  let inList = false;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item !== null) {
      if (!inList || list === null) return null;
      list.push((item[1] ?? '').trim());
      continue;
    }
    const pair = /^([a-z]+):(.*)$/.exec(line);
    if (pair === null || !KEYS.includes(pair[1] ?? '')) return null;
    const key = pair[1] ?? '';
    const value = (pair[2] ?? '').trim();
    inList = key === 'tools' && value === '';
    if (inList) list = [];
    values.set(key, value);
  }
  return { values, list };
}

/** The tool names of a flow or block list, sorted without repeats; null when one is no tool name. */
function toolsOf(front: Front): Array<string> | null {
  const raw = front.values.get('tools') ?? '';
  let items: Array<string>;
  if (front.list !== null) items = front.list;
  else if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    items = inner === '' ? [] : inner.split(',').map((item) => item.trim());
  } else return null;
  if (!items.every((item) => TOOL.test(item))) return null;
  return [...new Set(items)].sort();
}

export function parseSkillFile(source: string): SkillParse {
  const lines = source.split('\n');
  if (lines[0]?.trimEnd() !== FENCE) return { ok: false, code: 'no-front-matter' };
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === FENCE);
  if (close < 0) return { ok: false, code: 'bad-front-matter' };
  const front = readFront(lines.slice(1, close));
  if (front === null) return { ok: false, code: 'bad-front-matter' };
  const name = front.values.get('name');
  if (name === undefined || name === '') return { ok: false, code: 'no-name' };
  if (!SKILL_NAME.test(name)) return { ok: false, code: 'bad-name' };
  const description = front.values.get('description') ?? '';
  if (description === '') return { ok: false, code: 'no-description' };
  if (!front.values.has('tools')) return { ok: false, code: 'no-tools' };
  const tools = toolsOf(front);
  if (tools === null) return { ok: false, code: 'bad-tools' };
  const body = lines
    .slice(close + 1)
    .join('\n')
    .trim();
  if (body === '') return { ok: false, code: 'empty-body' };
  const task = front.values.get('task') ?? '';
  return {
    ok: true,
    skill: {
      name,
      description,
      tools,
      task: task === '' ? null : task,
      body,
      source,
      contentHash: createHash('sha256').update(source).digest('hex'),
    },
  };
}
