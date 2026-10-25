# Style guide

This file says how code and documentation in this repository are written. Where `tsconfig.json`, `eslint.config.js` or `.prettierrc` differ from this text, the tooling files are the authority.

Write English in code, comments, documentation, commit messages and test data. Test data that must be non-Latin is Greek or accented Latin.

## TypeScript on Node 26

Node runs `.ts` files by stripping types, so there is no build step. Use erasable syntax only: `enum`, `namespace`, parameter properties and `import x = require()` do not exist here.

Name the file with its extension in a relative import, because Node resolves nothing else.

```ts
import { openDoor } from './door.ts';
```

`tsc --noEmit` checks types with `strict`, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `allowJs` and `checkJs`. A remaining `.js` file is checked through its JSDoc.

ESLint 9 (flat config) runs typescript-eslint `recommended-type-checked` plus the rules named below. Prettier formats with single quotes, semicolons, a 2-space indent, 120 columns and trailing commas where ES5 allows them.

The code-health check allows a file of at most 2,000 lines, a function of at most 300 lines, nesting of at most 6 and cyclomatic complexity of at most 20. A file already over a limit may only shrink. Waive a rule with one comment above the code.

```ts
// health: allow function-length -- one switch over every wake kind, split would hide the table
```

## Files and modules

Name files and folders in kebab-case. Give each file one topic.

Open every file with one comment paragraph that says what the file does and who calls it.

Use named exports. Export only what another module uses.

Lint: `'import/no-default-export': 'error'`

Import types with `import type`, so type stripping can drop them without guessing.

Lint: `'@typescript-eslint/consistent-type-imports': 'error'`

Group imports in this order: Node built-ins, our modules, relative paths.

The core (`src/`) imports no interface, no plugin and no npm package. An interface or a plugin imports only `src/protocol/`.

`structure.json` at the repository root declares each folder's purpose, allowed imports and size. The code-health check reads it, so a new folder starts with an entry there.

## Types

Use `type` over `interface`. Keep `interface` for declaration merging, with a lint-disable comment that says why.

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

Write `Array<T>`, not `T[]`.

```ts
// Avoid
const kinds: Conversation['kind'][] = ['dm', 'group'];

// Use
const kinds: Array<Conversation['kind']> = ['dm', 'group'];
```

Lint: `'@typescript-eslint/array-type': ['error', { default: 'generic' }]`

Model variants as a discriminated union with a literal discriminator. A state that cannot exist should not be representable.

```ts
// Avoid
type Wake = { isDue: boolean; isErrandDone: boolean; intentionId?: string; errandId?: string };

// Use
type Wake = { kind: 'intention_due'; intentionId: string } | { kind: 'errand_done'; errandId: string };
```

Handle a union with an exhaustive `switch`, so a new variant breaks the build where it matters.

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

Make most properties required. An optional property claims that the code works with and without it.

Declare constants with `as const`, or `as const satisfies T` when the shape must also be checked. Derive the type from the value.

```ts
// Avoid
const WAKE_KINDS: Array<string> = ['heartbeat', 'review'];

// Use
const WAKE_KINDS = ['heartbeat', 'review'] as const;
type WakeKind = (typeof WAKE_KINDS)[number];
```

Use a literal union where other languages use an enum.

Lint: `'no-restricted-syntax': ['error', { selector: 'TSEnumDeclaration', message: 'Replace enum with a literal type or a const assertion.' }]`

Use `unknown` and a type guard, not `any`. The compiler then checks the data where it enters.

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

Write `as` and `!` only with a comment that says why the compiler cannot know what you know. A runtime check is usually better.

Use `@ts-expect-error` with a description, not `@ts-ignore`.

```ts
// Avoid
// @ts-ignore
sendAction(action);

// Use
// @ts-expect-error: the Discord adapter types `flags` as a number, the protocol sends a string
sendAction(action);
```

Lint: `'@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }]`

Give exported functions explicit parameter and return types. Let inference work inside a module.

Lint: `'@typescript-eslint/explicit-module-boundary-types': 'error'`

Keep types simple. Add a generic when a second call site needs it. Skip conditional and mapped type acrobatics. A type describes the data and never exists to satisfy the checker; if the type is harder to read than the code, change the code.

Use `null` for a value that is empty on purpose and `undefined` for a value that is absent.

Mark data `Readonly` where it must not change, and return a new value instead of editing an argument.

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

Put the types of an external contract (a provider's API, a database row) next to the code that reads it.

## Functions and variables

Use `const`, and `let` only when the variable is reassigned.

Write named functions as declarations and callbacks as arrows.

Give a function one responsibility: it takes its dependencies as arguments and returns a value. Keep side effects (network, disk, the database, logging) at the edge and the logic inside pure, so tests need no fake of the world.

Past two related arguments, take one object parameter. Keep most arguments required.

```ts
// Avoid
pickReaction(event, 0.3, true, 40);

// Use
pickReaction({ event, chance: 0.3, canUseGif: true, maxLength: 40 });
```

Inject `rng` and `now` instead of calling `Math.random()` or `Date.now()` in logic.

Use a class only where state and lifetime belong together, such as a connection or a store. Export plain functions instead of a class of static methods.

Iterate with `for...of`. Compare with `===`; the one loose form is `== null`, for `null` and `undefined` together. Put braces on every block.

Throw `new Error()` with a message that names the cause and the fix.

```ts
// Avoid
throw new Error('bad wake');

// Use
throw new Error(`unknown wake kind "${kind}"; use one of ${WAKE_KINDS.join(', ')}`);
```

Leave no empty `catch` without a comment that says why the error is ignored.

Fail loud at a boundary. A wrong event, config key or tool call is refused with a reason.

Skip checks for what the types already exclude.

## Naming

Use `camelCase` for variables, functions and properties, `PascalCase` for types and `CONSTANT_CASE` for module constants.

Start booleans with `is`, `has`, `can` or `should`.

Name a generic parameter `T` plus a word.

```ts
// Avoid
function firstOf<T, K extends string>(items: Array<T>, key: K): T | undefined;

// Use
function firstOf<TItem, TKey extends string>(items: Array<TItem>, key: TKey): TItem | undefined;
```

Write acronyms as words: `fetchUrl`, `parseJson`.

Leave off the `I` prefix, leading and trailing underscores, and the type in the name (`nameString`). Abbreviate only to words that are words already: `id`, `url` and `db` are fine, `cfg` and `msg` are not.

### The engine's words

| Word | Meaning |
|---|---|
| `core` | The platform-neutral engine in `src/`. |
| `interface`, `adapter` | A package for one platform; its adapter translates between the platform and the protocol. |
| `conversation` | Where people talk. Kinds: `dm`, `group`, `channel`, `thread`. |
| `event`, `action` | What arrives from an interface, and what the core asks an interface to do. |
| `turn`, `step` | One run of the persona over an event or a wake, and one model call inside it. |
| `tool` | Code with a schema that the model calls. |
| `skill` | A prose procedure over tools. |
| `command` | What a person types in the CLI. |
| `errand` | A background job handed to an agent. |
| `agent` | A model with a profile that works on an errand or a development task. |
| `model role` | The name under which a model is configured. |
| `intention` | Something the persona decided to do later. |
| `wake` | A turn the persona starts herself. Kinds, each one word: `heartbeat`, `selfreflection`, `selfimprovement`, `intention_due`, `errand_done`, `review`, `attend`, `feedback`. |
| `memory` | What the persona keeps between turns. |
| `labels` | The wording of what code inserts into a prompt, and the strings the owner sees. |
| `config`, `local layer` | The shipped settings, and the private files that override them. |
| `lease` | A time-limited claim on a resource. |

An identifier, a comment, a label or a config key uses these words and no synonym.

## Comments

Say why. The header paragraph is the "what", so a comment never repeats what the next line does.

Leave history to the git log. Delete commented-out code.

Name the plan a `TODO` belongs to.

Say where a constant's value came from: a measurement, a platform limit, or a decision with its date.

```ts
// Discord rejects a message over 2000 characters.
const MESSAGE_LIMIT = 2000;
```

Put JSDoc on an exported function only when its signature does not say enough. Use `//` lines everywhere else.

Write "the persona" in comments and logs, never a character's name.

## Tests

Use `node:test` and `node:assert/strict`. Put the tests of a module in `tests/<module>.test.ts`.

Name a test for what happens and when: `refuses a wake kind outside the list when the event arrives`.

Arrange, act, assert, with few of each. Test the exports of a module and nothing behind them.

Set every setting a test depends on, so a changed default breaks no test.

Write no snapshots, and no test for what nothing sane could break.

Create temp files under `TMPDIR` and remove them in the test.

## Documentation

This section covers `docs/` and the Markdown files at the repository root.

Give each document one topic and a kebab-case file name. List every file in [`docs/README.md`](docs/README.md) with one line.

Start with a paragraph that says what the document covers and for whom.

Write in the present tense about the code as it is. History, "now", "was" and roadmaps do not belong in documentation; a plan is not documentation.

Use `##` and `###` headings, and keep them short.

Bold only a lead-in phrase at the start of a paragraph, as in [`CONTRIBUTING.md`](CONTRIBUTING.md).

Use a table for a reference (config keys, commands, labels) and prose for behaviour.

Put every path, key, command and value in a code fence or inline code.

Link other documents with a relative link, and use a bare URL only for something outside the repository.

Name the module that implements the behaviour a document describes.

Name no real person, server or character in the public documentation.

Generate a reference table from the code where a script can do it, and say so in the table's first line. `docs/configuration.md` and the codes table in `docs/prompt-contract.md` are generated.

Change the document in the same pull request as the code it describes.

## Sources

This guide builds on mkosir's [TypeScript Style Guide](https://mkosir.github.io/typescript-style-guide/) and, where that says less, Google's [TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html). This file wins where they differ.
