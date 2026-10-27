# Style guide

Conventions for the engine's code, kept short so people and agents actually read them. The tooling files (`tsconfig.json`, `eslint.config.js`, `.prettierrc`) have the last word when they and this page disagree.

Write English in code, comments, documentation, commit messages and test data. Test data that has to be non-Latin is Greek or accented Latin.

## TypeScript on Node 26

- Node runs `.ts` files by stripping the types, so there is no build step. That limits you to erasable syntax: `enum`, `namespace`, parameter properties and `import x = require()` do not work here.
- Put the extension in a relative import, because Node resolves nothing else.

```ts
import { openDoor } from './door.ts';
```

- `tsc --noEmit` checks types with `strict`, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `allowJs` and `checkJs`. A leftover `.js` file is checked through its JSDoc.
- ESLint 9 (flat config) runs typescript-eslint `recommended-type-checked` plus the rules named below.
- Prettier formats with single quotes, semicolons, a 2-space indent, 120 columns and trailing commas where ES5 allows them.
- The code-health check allows a file of up to 2,000 lines, a function of up to 300, nesting of 6 and cyclomatic complexity of 20. A file that is already over a limit may only shrink.
- To waive a rule, write one comment above the code that says why.

```ts
// health: allow function-length -- one switch over every wake kind, split would hide the table
```

## Files and modules

- Name files and folders in kebab-case, and give each file one topic.
- Open every file with one comment paragraph that says what the file does and who calls it.
- Use named exports, and export only what another module uses.

Lint: `'import/no-default-export': 'error'`

- Import types with `import type`, so type stripping can drop them without guessing.

Lint: `'@typescript-eslint/consistent-type-imports': 'error'`

- Order imports as Node built-ins, then our modules, then relative paths.
- The core (`src/`) imports no interface, no plugin and no npm package. An interface or a plugin imports only `src/protocol/`.
- `structure.json` at the repository root declares each folder's purpose, allowed imports and size, and the code-health check reads it. A new folder starts with an entry there.

## Types

- Use `type`, not `interface`. The one place `interface` is still needed is declaration merging, and that spot gets a lint-disable comment saying so.

```ts
// Avoid
interface Conversation {
  kind: 'dm' | 'group' | 'channel' | 'thread';
}

// Use
type Conversation = {
  kind: 'dm' | 'group' | 'channel' | 'thread';
};
```

Lint: `'@typescript-eslint/consistent-type-definitions': ['error', 'type']`

- Write `Array<T>`, not `T[]`.

```ts
// Avoid
const kinds: Conversation['kind'][] = ['dm', 'group'];

// Use
const kinds: Array<Conversation['kind']> = ['dm', 'group'];
```

Lint: `'@typescript-eslint/array-type': ['error', { default: 'generic' }]`

- Model variants as a discriminated union with a literal discriminator, so a state that cannot exist cannot be written down.

```ts
// Avoid
type Wake = { isDue: boolean; isErrandDone: boolean; intentionId?: string; errandId?: string };

// Use
type Wake = { kind: 'intention_due'; intentionId: string } | { kind: 'errand_done'; errandId: string };
```

- Handle a union with an exhaustive `switch`. When someone adds a variant, the build breaks exactly where it matters.

```ts
// Avoid
function describeWake(wake: Wake): string {
  if (wake.kind === 'intention_due') {
    return 'an intention is due';
  }
  return 'an errand finished';
}

// Use
function describeWake(wake: Wake): string {
  switch (wake.kind) {
    case 'intention_due':
      return 'an intention is due';
    case 'errand_done':
      return 'an errand finished';
  }
}
```

Lint: `'@typescript-eslint/switch-exhaustiveness-check': 'error'`

- Make most properties required. An optional property says the code works with and without it, so use one only when that is true.
- Declare constants with `as const`, or `as const satisfies T` when the shape needs checking too, and derive the type from the value.

```ts
// Avoid
const WAKE_KINDS: Array<string> = ['heartbeat', 'review'];

// Use
const WAKE_KINDS = ['heartbeat', 'review'] as const;
type WakeKind = (typeof WAKE_KINDS)[number];
```

- Where another language would use an enum, use a literal union.

Lint: `'no-restricted-syntax': ['error', { selector: 'TSEnumDeclaration', message: 'Replace enum with a literal type or a const assertion.' }]`

- Reach for `unknown` and a type guard instead of `any`, so the compiler checks the data where it comes in.

```ts
// Avoid
function readToolCall(raw: any): ToolCall {
  return raw;
}

// Use
function readToolCall(raw: unknown): ToolCall {
  if (!isToolCall(raw)) {
    throw new Error('tool call has no name; the model must send { name, arguments }');
  }
  return raw;
}
```

- Write `as` or `!` only with a comment explaining what you know that the compiler cannot. A runtime check is usually the better fix.
- Use `@ts-expect-error` with a description, never `@ts-ignore`.

```ts
// Avoid
// @ts-ignore
sendAction(action);

// Use
// @ts-expect-error: the Discord adapter types `flags` as a number, the protocol sends a string
sendAction(action);
```

Lint: `'@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }]`

- Give exported functions explicit parameter and return types. Inside a module, let inference do the work.

Lint: `'@typescript-eslint/explicit-module-boundary-types': 'error'`

- Keep types simple. Add a generic when a second call site needs it, and skip conditional and mapped type tricks. A type describes the data and does not exist to satisfy the checker. If the type is harder to read than the code, change the code.
- `null` is a value that is empty on purpose, `undefined` is a value that is absent.
- Mark data `Readonly` where it must not change, and return a new value instead of editing an argument.

```ts
// Avoid
function dropOldest(turns: Array<Turn>): Array<Turn> {
  turns.splice(0, 1);
  return turns;
}

// Use
function dropOldest(turns: ReadonlyArray<Turn>): Array<Turn> {
  return turns.slice(1);
}
```

- Keep the types of an external contract (a provider's API, a database row) next to the code that reads it.

## Functions and variables

- Use `const`, and `let` only when the variable is reassigned.
- Write named functions as declarations and callbacks as arrows.
- A function does one thing: it takes its dependencies as arguments and returns a value. Keep side effects (network, disk, database, logging) at the edge and the logic pure, so tests need no fake of the world.
- Past two related arguments, take one object parameter. Most arguments should be required.

```ts
// Avoid
pickReaction(event, 0.3, true, 40);

// Use
pickReaction({ event, chance: 0.3, canUseGif: true, maxLength: 40 });
```

- Inject `rng` and `now` instead of calling `Math.random()` or `Date.now()` inside logic.
- Use a class only where state and lifetime belong together, like a connection or a store. Export plain functions, not a class of static methods.
- Iterate with `for...of`, compare with `===` (the one loose form is `== null`, which catches `null` and `undefined` together), and put braces on every block.
- Throw `new Error()` with a message that names the cause and the fix.

```ts
// Avoid
throw new Error('bad wake');

// Use
throw new Error(`unknown wake kind "${kind}"; use one of ${WAKE_KINDS.join(', ')}`);
```

- An empty `catch` needs a comment saying why the error is ignored.
- Fail loudly at a boundary. A wrong event, config key or tool call gets refused with a reason.
- Skip checks for what the types already rule out.

## Naming

- `camelCase` for variables, functions and properties, `PascalCase` for types, `CONSTANT_CASE` for module constants.
- Start booleans with `is`, `has`, `can` or `should`.
- Name a generic parameter `T` plus a word.

```ts
// Avoid
function firstOf<T, K extends string>(items: Array<T>, key: K): T | undefined;

// Use
function firstOf<TItem, TKey extends string>(items: Array<TItem>, key: TKey): TItem | undefined;
```

- Write acronyms as words: `fetchUrl`, `parseJson`.
- Skip the `I` prefix, leading and trailing underscores, and the type in the name (`nameString`). Abbreviate only to words that are words already: `id`, `url` and `db` are fine, `cfg` and `msg` are not.

### Terminology

| Word | Meaning |
|---|---|
| `core` | The platform-neutral engine in `src/`. |
| `interface`, `adapter` | A package for one platform; its adapter translates between the platform and the protocol. |
| `conversation` | Where people talk. |
| `community` | A group of conversations under one membership: a Discord server, a Telegram channel's audience. |
| `event`, `action` | What arrives from an interface, and what the core asks an interface to do. |
| `turn`, `step` | One run of the persona over an event or a wake, and one model call inside it. |
| `tool` | Code with a schema that the model calls. |
| `skill` | A prose procedure over tools. |
| `command` | What a person types in the CLI. |
| `errand` | A background job handed to an agent. |
| `agent` | A model with a profile that works on an errand or a development task. |
| `model role` | The name under which a model is configured. |
| `intention` | Something the persona decided to do later. |
| `wake` | A turn the persona starts herself. |
| `memory` | What the persona keeps between turns. |
| `labels` | The wording of what code inserts into a prompt, and the strings the owner sees. |
| `config`, `local layer` | The shipped settings, and the private files that override them. |
| `lease` | A time-limited claim on a resource. |

An identifier, a comment, a label or a config key uses these words and no synonym.

## Comments

- Say why. The header paragraph already says what the file does, so a comment never repeats what the next line does.
- Leave history to the git log, and delete commented-out code.
- A `TODO` names the plan it belongs to.
- Say where a constant's value came from: a measurement, a platform limit, or a decision with its date.

```ts
// Discord rejects a message over 2000 characters.
const MESSAGE_LIMIT = 2000;
```

- Put JSDoc on an exported function only when its signature does not say enough. Everywhere else, use `//` lines.
- In comments and logs, write "the persona", never a character's name.

## Tests

- Use `node:test` and `node:assert/strict`, and put the tests of a module in `tests/<module>.test.ts`.
- Name a test for what happens and when: `refuses a wake kind outside the list when the event arrives`.
- Arrange, act, assert, and keep each part small. Test a module's exports and nothing behind them.
- Set every setting a test depends on, so a changed default breaks no test.
- Write no snapshots, and no test for something nothing sane could break.
- Create temp files under `TMPDIR` and remove them in the test.
- Run only the tests of the module you changed, from the repository root with `TMPDIR` set to a scratch folder: `node --test --test-reporter=dot tests/<module>.test.ts`. The whole suite runs once, before the pull request is opened, not after every edit.
- Keep the output quiet by default: the `dot` reporter, no verbose mode, no coverage. When something fails, rerun that one file with `--test-reporter=spec` and read the first failing trace, not the whole log.
- Pipe long output through `tail`; the last 40 lines are enough to see the summary. Never paste a test log into a commit, an issue or a document.
- When you need one function from a file, search for it first and read that range instead of the whole file.

## Sources

This guide builds on mkosir's [TypeScript Style Guide](https://mkosir.github.io/typescript-style-guide/) and, where that says less, Google's [TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html). This file wins where they differ.
