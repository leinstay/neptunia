# Style guide

How the engine's code is written. It applies to every `.ts` and `.js` file in `src/`, `interfaces/`, `plugins/`, `bin/`, `tools/` and `tests/`.

## Scope and tooling

TypeScript runs directly on Node 26 through type stripping. There is no build step, so only erasable syntax is allowed. That rules out `enum`, `namespace`, parameter properties and `import x = require()`.

- Relative imports name the file with its extension: `import { openDoor } from './door.ts'`. Node resolves nothing else.
- `tsc --noEmit` checks types in CI with `strict: true`, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `allowJs` and `checkJs`. A `.js` file is checked through its JSDoc until it moves to TypeScript.
- ESLint 9 (flat config) runs typescript-eslint `recommended-type-checked` plus the rules named in the sections below.
- Prettier formats: single quotes, semicolons, 2-space indent, 120 columns, trailing commas where ES5 allows them.
- ESLint and Prettier run in CI and in the pre-commit hook. The formatter touches changed files only, so a commit never carries a reformatting of code nobody edited.
- A code-health check enforces: file at most 2,000 lines, function at most 300 lines, nesting at most 6, cyclomatic complexity at most 20. A file already over a limit may only shrink. A waiver is one comment above the code: `// health: allow <rule> -- <why>`.
- When `tsconfig.json`, `eslint.config.js` or `.prettierrc` and this text differ, the tooling files are the authority. Fix the text.

## Files and modules

- File and folder names are lower-case kebab-case.
- One topic per file. A file that needs "and" to describe it is two files.
- Every file opens with one comment paragraph saying what the file does and who calls it. No copyright line.
- Named exports only. Export only what another module uses.
- Type-only imports use `import type`, so type stripping can drop them without guessing.
- Imports come in three groups, in this order: Node built-ins, our modules, relative paths.
- No `../..` across a package boundary. The core never imports an interface or a plugin. An interface or plugin imports only `src/protocol/`.
- The core (`src/`) has no npm dependency. Dependencies live in `interfaces/<name>/` and `plugins/<name>/`, each with its own `package.json`.
- Each module's size and allowed imports are declared in `structure.json` at the repository root. The code-health script checks the file against the code.

## Types

- Use `type` aliases, never `interface`. The one exception is declaration merging, and it carries a comment that disables the lint rule and says why.
- Write `Array<T>` and `ReadonlyArray<T>`, never `T[]`.
- Model variants as a discriminated union with a literal discriminator, not as boolean flags or a pile of optional fields. A state that cannot exist should not be representable.
- Handle every union with an exhaustive `switch` (`switch-exhaustiveness-check`), so adding a variant breaks the build where it matters.
- Make most properties required. An optional property is a claim that the code works both with and without it.
- Use `as const`, and `as const satisfies T` when the shape must also be checked, for constants. Derive the type from the value instead of writing both.
- Use literal unions where other languages use enums: `type ConversationKind = 'dm' | 'group' | 'channel' | 'thread'`.
- Use `unknown` plus a type guard, never `any`.
- No `as` and no `!` without a comment saying why the compiler cannot know what you know. Prefer a runtime check.
- `@ts-expect-error` with a description is allowed. `@ts-ignore` and `@ts-nocheck` are not.
- Exported functions have explicit parameter and return types. Inside a module, let inference work.
- Keep types simple:
  - No generic until a second call site needs it.
  - No conditional or mapped type acrobatics.
  - No type written to satisfy the checker instead of describing the data. If the type is harder to read than the code, change the code.
- `null` means empty on purpose. `undefined` means absent.
- Mark data `Readonly` where it must not be mutated, and return new values instead of editing arguments.
- Types for an external contract (a provider's API, a database row) live next to the code that reads it, and are checked where the data enters.

## Functions and variables

- `const` by default. `let` only when the variable is reassigned. Never `var`. One variable per statement.
- Named functions are function declarations. Arrow functions are for callbacks.
- A function has one responsibility, takes its dependencies as arguments and returns a value.
- Side effects (network, disk, the database, logging) sit at the edge. Logic inside is pure, so it can be tested without a fake of the world.
- Take a single object parameter once a function has more than two related arguments. Keep most arguments required.
- Randomness and clocks are injected as `rng` and `now`. Logic never calls `Math.random()` or `Date.now()` itself.
- No `this`-based code where a function and a closure do the job.
- A class is for state and lifetime that belong together, such as a connection or a store. It is never a namespace for static methods. Export plain functions instead.
- Iterate with `for...of`, using `Object.entries` and friends for objects. Never `for...in` on an array.
- Compare with `===` and `!==`. Use `==` only as `== null` when both `null` and `undefined` are meant.
- Control-flow blocks always have braces.
- Throw `Error` or a subclass, always with `new`. The message names the cause and the fix: `unknown wake kind "heartbeat-late"; use one of the kinds in WAKE_KINDS`.
- No empty `catch`. A `catch` that deliberately ignores an error says why in a comment.
- Fail loud at a boundary. A wrong event, a wrong config key or a wrong tool call is refused with a reason, never patched over.
- No defensive clutter: no check for a condition the types already exclude, no fallback for a value that cannot be missing.

## Naming

- `camelCase` for variables, functions and properties.
- `PascalCase` for types.
- `CONSTANT_CASE` for module-level constants. An object or array constant is named in the singular (`WAKE_KIND`).
- Booleans start with `is`, `has`, `can`, `should`, `did` or `will`.
- Generic parameters are `T` plus a word: `TEvent`. Never a single letter.
- Acronyms are words: `fetchUrl`, `httpCode`, `parseJson`.
- No `I` prefix on types, no leading or trailing underscores, no type in the name (`nameString`).
- No abbreviation that is not already a word. `cfg`, `msg` and `ctx` are out. `id`, `url` and `db` are in.

### Terminology

The engine's vocabulary is binding in identifiers, comments, labels and config keys. One word per thing.

| Word | Means |
|---|---|
| `core` | The platform-neutral engine in `src/`. |
| `interface` | A package for one platform. Its `adapter` translates between the platform and the protocol. |
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
| `wake` | A turn the persona starts herself. Kinds: `heartbeat`, `selfreflection`, `selfimprovement`, `intention_due`, `errand_done`, `review`, `attend`, `feedback`. Wake kinds are one word, never hyphenated. |
| `memory` | What the persona keeps between turns. |
| `labels` | The wording of what code inserts into a prompt. |
| `config`, `local layer` | The shipped settings and the private files that override them. |
| `lease` | A time-limited claim on a resource. |

These words are not used: `op`, `operation`, `helper`, `organ`, `task` (for an errand), `intent`, `place`, `guild`, and `channel` outside the Discord package.

## Comments

- A comment says why. It never repeats what the next line plainly does. The file header paragraph is the one place for "what".
- No history. Words like `now`, `was`, `no longer`, `moved from` and `previously` mean the comment is telling a story the git log already holds.
- No commented-out code. Delete it.
- A `TODO` names the plan it belongs to. A `TODO` without a plan does not exist.
- A constant's comment says where the value came from: a measurement, a platform limit, or the owner's decision with its date.
- `/** JSDoc */` goes on exported functions whose signature does not say enough. It is written in Markdown, and block tags start their own line.
- Everything else uses `//`. Several `//` lines, never a `/* */` block.
- Comments use the terminology above. No second name for a thing.
- Comments and logs say "the persona", never a character's name.

## Tests

- Tests use `node:test`. One test file per module, named `tests/<module>.test.ts`.
- A test name says what should happen and when: `refuses a wake kind that is not in the list when the event arrives`.
- Arrange, act, assert, with few of each. A test with five acts is five tests.
- Tests are black-box on the module's exports. They do not reach into internals.
- A test sets every setting it depends on. It never relies on a default from `config.json`, so changing a default breaks no test.
- No snapshots.
- No test for what nothing sane could break.
- Randomness and clocks are injected, as in the code.
- Test data is English, Greek or accented Latin, never Cyrillic.
- Temp files go under `TMPDIR` and the test removes them.

## The public repository

- English only, in code, comments, docs and test data.
- No Cyrillic in any tracked file.
- Nothing about a real person, a real server or a real character.
- No model-facing string in `src/`. Those live in the labels and prompt files (see the [prompt contract](prompt-contract.md)).
- No secret anywhere except `.env`.

## Not used

- `enum`, `namespace`, parameter properties, decorators
- default exports
- `var`, `any`, `@ts-ignore`, `/// <reference>`
- wrapper objects (`new String`, `new Number`) and the `Array()` and `Object()` constructors
- `arguments`, `eval`, `with`, edits to a `prototype`, mixins
- `#private` fields (the rare class uses `private`)
- getters with side effects
- `parseInt` for base 10 (use `Number()` and check the result)
- automatic semicolon insertion (write the semicolons)

## Sources

Based on the [TypeScript Style Guide](https://mkosir.github.io/typescript-style-guide/) by mkosir, with the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) as the fallback for what it does not cover.
Where they disagree, this document wins over both, and mkosir wins over Google.
