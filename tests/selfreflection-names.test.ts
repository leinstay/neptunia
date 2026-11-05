// B10 of the master plan: the engine's name for the mechanism is `selfreflection` everywhere, and only the text inside
// the prompts keeps the persona's own word for her diary. That word survives in three places the code does not own: the
// text of the prompt files and the label values the model reads, the block tags it reads in a request (`<diary>`), and
// the folder of her pictures on disk (`media/diary`) with the ids already stored (`media:diary:`). Everything else, the
// modules, the settings, the label keys, the prompt file names, the tables and the units, says `selfreflection`. Old
// names live only in the code that migrates them: the shipped schema migrations and the one that follows them
// (src/memory/db/schema.ts), the offline converter (src/memory/migration/), the config moves and the config cut
// (src/config-moves.ts, src/config/cut.ts), and the map of old local prompt file names (src/hot.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHot } from '../src/hot.ts';
import { tempDir } from './fixtures/tmp.ts';
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

// ---- the local prompt files of a deployment ------------------------------------------------------------------------

const LOCAL_MOVES: ReadonlyArray<[string, string]> = [
  ['diary', 'selfreflection'],
  ['diary-seeds', 'selfreflection-seeds'],
];

for (const [old, renamed] of LOCAL_MOVES) {
  test(`a local ${old}.md replaces the prompt ${renamed}, as lookup.md replaced query-builder`, () => {
    // Bug: the deployment's own writer prompt or seed list is ignored after the rename and the tracked one is sent.
    const dir = tempDir('nep-selfreflection-local-');
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ bot: { timezone: 'UTC' } }));
    fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompts', `${renamed}.md`), 'tracked text');
    fs.mkdirSync(path.join(dir, 'data', 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'prompts', `${old}.md`), 'local text');
    const hot = createHot({ rootDir: dir });
    try {
      assert.equal(hot.prompts[renamed], 'local text');
      assert.equal(hot.promptSources[renamed], 'local');
      assert.equal(Object.hasOwn(hot.prompts, old), false);
    } finally {
      hot.close();
    }
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
  const labels = readJson('config/labels.json') as Record<string, Record<string, unknown>>;
  const wanted = ['audienceRefused', 'intro', 'publicationPlaces'];
  assert.deepEqual(
    Object.keys(labels.selfreflection ?? {})
      .filter((key) => wanted.includes(key))
      .sort(),
    wanted
  );
});

// ---- the lexical gate -----------------------------------------------------------------------------------------------

/** Files that hold the old names because they migrate them. */
const MIGRATING = (file: string): boolean =>
  file === 'src/memory/db/schema.ts' ||
  file.startsWith('src/memory/migration/') ||
  file === 'src/config-moves.ts' ||
  file === 'src/config/cut.ts';

/** What stays of a line once the three places that keep the persona's word are taken out of it. */
function withoutPersonaWord(file: string, line: string): string {
  let rest = line.replace(/<\/?diary>/g, '').replace(/media:diary:/g, '');
  rest = rest.replace(/media['"]?\s*,\s*['"]diary['"]|media\/diary/g, '');
  // The request builders name the block and the budget section the persona's word.
  if (file === 'src/behavior/prompt.ts' || file.startsWith('src/turn/request/'))
    rest = rest.replace(/(['"])diary\1/g, '');
  // The map of old local prompt file names, and nothing else of src/hot.ts.
  if (
    file === 'src/hot.ts' &&
    (/^\s*['"]?diary(?:-plan|-seeds)?['"]?\s*:\s*['"]selfreflection/.test(line) || /data\/prompts\/diary/.test(line))
  )
    rest = '';
  // The display name of the settings section, which the owner reads.
  if (file === 'bin/setting-presentation.ts') rest = rest.replace(/selfreflection:\s*'Diary'/, '');
  return rest;
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
