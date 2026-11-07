// B10 of the master plan and the owner's answer 13 of 2026-11-07: the engine's name for the mechanism is
// `selfreflection` everywhere, and only the text of the prompt files and the label values the model reads keep the
// persona's own word for her diary. Her pictures are `media:selfreflection:` ids in `media/selfreflection`, her block is
// `<selfreflection>`, and a deployment's local prompt files carry the new names (the deploy renames the live one), so
// src/hot.ts maps no old file name and src/config/cut.ts lists no old key. Old names live only in the code that
// migrates them: the shipped schema migrations and the ones that follow them (src/memory/db/schema.ts), the offline
// converter and the data moves (src/memory/migration/), and the config moves (src/config-moves.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readSource, sourceFiles } from './fixtures/source-tree.ts';

const exists = (file: string): boolean => fs.existsSync(path.join(ROOT, file));

const MODULES: ReadonlyArray<[string, string]> = [
  ['src/behavior/diary.ts', 'src/behavior/selfreflection.ts'],
  ['src/behavior/diary-turn.ts', 'src/behavior/selfreflection-turn.ts'],
  ['src/turn/diary.ts', 'src/turn/selfreflection.ts'],
  ['src/turn/request/diary.ts', 'src/turn/request/selfreflection.ts'],
  ['src/memory/db/diary-media.ts', 'src/memory/db/selfreflection-media.ts'],
  ['src/memory/db/diary-past.ts', 'src/memory/db/selfreflection-past.ts'],
  ['src/memory/db/diary-audience.ts', 'src/memory/db/selfreflection-audience.ts'],
  ['src/memory/db/map/diary.ts', 'src/memory/db/map/selfreflection.ts'],
  ['prompts/diary.md', 'prompts/selfreflection.md'],
  ['prompts/diary-seeds.md', 'prompts/selfreflection-seeds.md'],
  ['prompts/diary-plan.md', 'prompts/selfreflection-planner.md'],
  ['docs/diary.md', 'docs/selfreflection.md'],
];

for (const [old, renamed] of MODULES) {
  test(`${old} is ${renamed}`, () => {
    // Bug: a module is copied under the new name and the old one stays, and the two drift apart.
    assert.deepEqual([exists(old), exists(renamed)], [false, true]);
  });
}

// ---- the keys of the tracked settings and labels --------------------------------------------------------------------

/** Every object key at any depth of a JSON value, dotted. */
function keysOf(value: unknown, prefix = ''): Array<string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, inner]) => [`${prefix}${key}`, ...keysOf(inner, `${prefix}${key}.`)]);
}

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

for (const file of ['config/labels.json', 'config/config.json', 'config/tools.json']) {
  test(`no key of ${file} is spelled with the diary`, () => {
    // Bug: a label or a setting keeps its old key, and the code that reads the new one finds the default.
    assert.deepEqual(
      keysOf(readJson(file)).filter((key) => /diary/i.test(key)),
      []
    );
  });
}

test('the labels of the selfreflection wake sit in the section selfreflection', () => {
  // Bug: the wake reads `labels.selfreflection` while the file still holds `labels.diary`, and its posts lose their words.
  // The specifier read the file's root; config/labels.json holds the sections the model reads under `model`.
  const labels = readJson('config/labels.json') as { model: Record<string, Record<string, unknown>> };
  const wanted = ['audienceRefused', 'intro', 'publicationPlaces'];
  assert.deepEqual(
    Object.keys(labels.model.selfreflection ?? {})
      .filter((key) => wanted.includes(key))
      .sort(),
    wanted
  );
});

// ---- the lexical gate -----------------------------------------------------------------------------------------------

/** Files that hold the old names because they migrate them. */
const MIGRATING = (file: string): boolean =>
  file === 'src/memory/db/schema.ts' || file.startsWith('src/memory/migration/') || file === 'src/config-moves.ts';

/** What stays of a line once the display name of the settings section, which the owner reads, is taken out of it. */
function withoutPersonaWord(file: string, line: string): string {
  return file === 'bin/setting-presentation.ts' ? line.replace(/selfreflection:\s*'Diary'/, '') : line;
}

test('no source file outside the migrating ones says diary', () => {
  // Bug: a reader keeps the old table, the old purpose or the old mode, and the rename works in a test and not in the engine.
  const found: Array<string> = [];
  for (const file of sourceFiles(['src', 'bin', 'cli', 'interfaces'])) {
    if (MIGRATING(file)) continue;
    readSource(file)
      .split('\n')
      .forEach((line, index) => {
        if (/diary/i.test(withoutPersonaWord(file, line))) found.push(`${file}:${index + 1}`);
      });
  }
  assert.deepEqual(found, []);
});
