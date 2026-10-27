<!-- Generated from structure.json by `node tools/code-health.mjs --docs`. Do not edit by hand. -->

# Repository structure

Every folder and file pattern of the tracked tree has a purpose, a layer, a list of what its files may import and a rule on whether its modules need a test. Anyone who adds a file or an import checks the row that covers it. `npm run health` fails when a tracked file matches no row, when an import falls outside its row, and when a module in a row marked `required` has no test. When two rows cover a file, the more specific one applies. Files in a `local` row exist only in a deployment and are never tracked.

| Path | Layer | Purpose | May import | Test |
|---|---|---|---|---|
| `README.md` | public | The project README for people who find the repository. | nothing | none |
| `*.md` | public | The root documents: agent rules, style guide, writing guide, contributing and security policy. | nothing | none |
| `LICENSE` | public | The license text. | nothing | none |
| `.github/` | public | The continuous integration workflow, the issue and pull request templates and the README images. | nothing | none |
| `.env.example` | public | The names of the environment keys a deployment sets, without values. | nothing | none |
| `.env` | local | The deployment keys, never committed. | nothing | none |
| `.agents/` | local | The working folder of the agents of one deployment. | nothing | none |
| `prompts.local/` | local | A deployment prompt layer that shadows the tracked prompts. | nothing | none |
| `config.local.json` | local | A deployment settings layer over config.json. | nothing | none |
| `config.local/` | local | A deployment's tool texts, laid over the tracked ones. | nothing | none |
| `data/` | local | A deployment memory, state and logs. | nothing | none |
| `config.json` | public | The tracked default settings. | nothing | none |
| `config/` | public | The tracked texts of the persona's tools. | nothing | none |
| `package.json` | public | The root package: scripts, workspaces and development dependencies. | nothing | none |
| `package-lock.json` | public | The locked dependency tree. | nothing | none |
| `tsconfig.json` | public | The TypeScript compiler options used for type checking. | nothing | none |
| `eslint.config.js` | public | The ESLint flat configuration. | `@eslint/js`, `globals`, `eslint-plugin-import-x`, `typescript-eslint`, `tools/eslint-test-rules.mjs` | none |
| `stryker.config.json` | public | The Stryker settings that stay the same on every mutation run. | nothing | none |
| `eslint-suppressions.json` | public | The recorded ESLint violations that may only shrink. | nothing | none |
| `type-baseline.json` | public | The recorded type errors that may only shrink. | nothing | none |
| `code-health-baseline.json` | public | The recorded size and structure breaches that may only shrink. | nothing | none |
| `prose-baseline.json` | public | The recorded prose violations that may only shrink. | nothing | none |
| `structure.json` | public | This manifest of the tracked tree. | nothing | none |
| `.prettierrc` | public | The Prettier options. | nothing | none |
| `.prettierignore` | public | The files Prettier never formats. | nothing | none |
| `.gitignore` | public | The paths git ignores. | nothing | none |
| `.gitattributes` | public | The git attributes of the tree. | nothing | none |
| `.nvmrc` | public | The Node version of the project. | nothing | none |
| `prompts/` | public | The tracked prompt files and labels the model reads. | nothing | none |
| `docs/` | public | How the engine works, one topic per file. | nothing | none |
| `agents/` | public | The profile and prompt of each errand and development agent. | nothing | none |
| `bin/` | public | Entry points that run as their own process. | `node:*`, `src/**` | none |
| `deploy/` | public | The systemd units and the install script. | nothing | none |
| `interfaces/README.md` | public | The overview of the interface packages. | nothing | none |
| `interfaces/discord/` | public | The Discord interface: the only code that imports discord.js, translating between the platform and the protocol. It reads the core's media classifier and video-site matcher, pure modules, and classifies Discord's embeds and media addresses itself. | `node:*`, `discord.js`, `src/media/classify.js`, `src/media/video-sites.js`, `src/protocol/**` | required |
| `tests/` | public | The node:test files, one per module. | `discord.js`, `eslint`, `node:*`, `src/**`, `interfaces/**`, `tools/**`, `bin/**`, `tests/**` | none |
| `tests/fixtures/` | public | Fakes, harnesses and sample data the tests share. | `discord.js`, `node:*`, `src/**`, `interfaces/**`, `tools/**`, `bin/**`, `tests/**` | none |
| `tools/` | public | Scripts for development and measurement, never run by the engine. | `node:*`, `src/**`, `interfaces/**`, `tools/**`, `typescript`, `discord.js` | none |
| `tools/lib/` | public | What the scripts under tools share. | `node:*`, `src/**`, `interfaces/**`, `tools/**` | none |
| `tools/fixtures/` | public | Sample data for the virtual-week harness. | nothing | none |
| `tools/prompts/` | public | Example scenario files for the tools. | nothing | none |
| `src/*.js` | public | The small modules every part uses: settings, hot reload, logging, paths, time and text formatting. | `node:*`, `src/**` | required |
| `src/config-moves.ts` | public | The config keys of an earlier name and the new name each one is read under, applied to the local config before it is laid over config.json. | nothing | required |
| `src/index.js` | public | The entry point: reads the paths and the environment, loads the Discord package by path, starts the core and owns the process signals and exit. It imports no Discord. | `node:*`, `src/*.js` | none |
| `src/core.js` | public | The composition root: `startCore` builds the core over the paths, the environment and the interfaces it is given. Proved by the slice test. It imports no Discord. | `node:*`, `src/*.js`, `src/agent-runner/**`, `src/behavior/**`, `src/errands/**`, `src/intentions/**`, `src/llm/**`, `src/media/**`, `src/memory/**`, `src/protocol/**`, `src/speech/**`, `src/tools/**`, `src/web/**`, `src/interface/directory.ts`, `src/interface/door.js`, `src/interface/link.ts`, `src/interface/members.ts`, `src/interface/principals.ts`, `src/interface/reads.ts`, `src/interface/socket.ts` | none |
| `src/agent-runner/` | public | The process that works errands: the socket server, the profiles, the OpenCode driver and the sweep. | `node:*`, `src/**` | required |
| `src/behavior/` | public | What a turn does: the pipeline, triggers, prefetch, prompt assembly, recall, the inner turn and the heartbeat. | `node:*`, `src/**` | required |
| `src/behavior/inner/types.ts` | public | The shapes the inner life modules share. Types only: nothing runs, so nothing is tested. | `node:*`, `src/**` | none |
| `src/behavior/inner/settings.ts` | public | The inner life's settings: the wake kinds, the `innerLife` defaults and `innerSettings`. Tested through the inner life tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/queue.ts` | public | The inner life's wake queue and its state file `inner.json`: the door's handler of `inner.wake`, the wakes an intention gives and how queued wakes coalesce. Tested through the inner life tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/places.ts` | public | Her attention and the places view of the inner life: the place index, the attend wakes and the places page. Tested through the inner life tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/review.ts` | public | The inner life's day review: its drawn moment and the channels she spoke in lately. Tested through the inner life tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/heartbeat.ts` | public | The heartbeat's schedule: its timer, its wake, its facts and the log line of its outcome. Tested through the inner life and heartbeat tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/drain.ts` | public | The inner life's drain: one inner turn for the queue's first group, its wake run, its retries and its feedback facts. Tested through the inner life and fault-injection tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/facts.ts` | public | The inner life's facts: what did not go through in a turn, kept until a model answer carried them. Tested through the inner life and inner turn tests. | `node:*`, `src/**` | none |
| `src/behavior/inner/status.ts` | public | The owner's status of the inner life and its kill switch. Tested through the inner life and status tests. | `node:*`, `src/**` | none |
| `src/errands/` | public | The errand service: the ledger, the store, the client to the runner and the turns that bring results back. | `node:*`, `src/**` | required |
| `src/intentions/` | public | The persona intentions: model, store, sources and the service that wakes them. | `node:*`, `src/**` | required |
| `src/errands/types.ts` | public | The shapes the errand modules share. Types only: nothing runs, so nothing is tested. | `node:*`, `src/**` | none |
| `src/intentions/types.ts` | public | The shapes the intention modules share. Types only: nothing runs, so nothing is tested. | `node:*`, `src/**` | none |
| `src/interface/` | public | The core side of the interface port: the door that admits events, the link to an interface, the socket server, the fake interface and typing leases. | `node:*`, `src/**` | required |
| `src/llm/` | public | The language model calls: OpenRouter, roles, budgets, token counts, limits and output parsing. | `node:*`, `src/**` | required |
| `src/media/` | public | Pictures, video, audio, GIFs and drawing on the core side. | `node:*`, `src/**` | required |
| `src/memory/` | public | The memory modules above the database: records, lore, episodes, recall ranking, vectors and backfills. | `node:*`, `src/**` | required |
| `src/memory/db/` | public | The memory database: schema, the single writer, sessions, wakes and the read paths. | `node:*`, `src/**` | required |
| `src/memory/db/diary-past.ts` | public | Schema v15's data step that makes her past messages in a diary mirror's place entries. Tested through the v15 migration tests. | `node:*`, `src/**` | none |
| `src/memory/db/mirrors.ts` | public | The reads of the diary's mirrors over the memory database: the places her diary is posted to and whether a conversation is one. Tested through the mirror and diary mirror tests. | `node:*`, `src/**` | none |
| `src/memory/db/map/` | public | The mapping of memory rows to records and back. | `node:*`, `src/**` | required |
| `src/memory/db/readers/` | public | The read queries of the memory database. | `node:*`, `src/**` | required |
| `src/tools/impl/` | public | The owner operations behind the /nep commands. | `node:*`, `src/**` | required |
| `src/protocol/` | public | The neutral protocol of events, actions and envelopes between the core and its interfaces, and the serving side of the link. | `node:*`, `src/**` | required |
| `src/interface/legacy.ts` | public | The types of what the core reads from an interface's `legacy`, one field per seam stage 3 removes. Types only. | nothing | none |
| `src/protocol/host.ts` | public | The types of what the core hands an interface when it starts one and what the interface hands back. Types only. | `src/protocol/**` | none |
| `src/tools/` | public | The tools the persona can call: definitions, registry, executors and the gateway. | `node:*`, `src/**` | required |
| `src/speech/` | public | Voice messages: text preparation, synthesis and audio conversion. | `node:*`, `src/**` | required |
| `src/web/` | public | Web search, page fetching and link reading. | `node:*`, `src/**` | required |
