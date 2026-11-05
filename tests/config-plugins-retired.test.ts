// `plugins.*` is a retired setting: the plugin mechanism left the engine (src/plugins/, its schema and commands are gone),
// and a layer written before that still sets the section. The migration takes the whole section out and says so, as it
// does for every other retired key, so `/config check` stops reporting a key nothing can act on. Unrelated unknown keys
// stay reported: a section with a similar name, and a key beside the retired one. The layers are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveConfigKeys } from '../src/config-moves.ts';
import { checkConfig } from '../src/config/check.ts';
import { cutConfigKeys } from '../src/config/cut.ts';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';

/** A local layer as `/config check` and the loader see it. */
function settled(layer: Record<string, unknown>) {
  const moved = moveConfigKeys(layer);
  const after = cutConfigKeys(moved.config);
  return { config: after.config, removed: [...moved.dropped.map(String), ...after.cut] };
}

test('the plugin section of an old layer goes through the migration, named in its report', () => {
  // Bug: every `/config check` fails on a section the owner has no command left to change.
  const { config, removed } = settled({ plugins: { callDeadlineMs: 30_000, echo: { enabled: true } } });
  assert.equal(Object.hasOwn(config, 'plugins'), false);
  assert.ok(
    removed.some((key) => key === 'plugins' || key.startsWith('plugins.')),
    'the report names what left'
  );
  assert.deepEqual(checkConfig(config, CONFIG_SCHEMA), []);
});

test('a plugins value of any shape is retired, whatever it holds', () => {
  // Bug: the migration handles the object form, and a hand-written scalar still fails the check forever.
  const { config } = settled({ plugins: true });
  assert.deepEqual(checkConfig(config, CONFIG_SCHEMA), []);
});

test('unknown keys beside the plugin section stay reported', () => {
  // Bug: the retirement is written as a suppression of the unknown-settings check, which then hides real mistakes.
  const { config } = settled({
    plugins: { echo: { enabled: true } },
    pluginsLocal: { echo: true },
    nosuch: { key: 1 },
    llm: { nosuch: 1 },
  });
  assert.deepEqual(
    checkConfig(config, CONFIG_SCHEMA)
      .map((problem) => problem.key)
      .sort(),
    ['llm.nosuch', 'nosuch', 'pluginsLocal']
  );
});
