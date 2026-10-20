# Contributing

## Setup

```bash
git clone https://github.com/leinstay/neptunia.git
cd neptunia && npm install
npm test
```

Node.js 24 (the major version is pinned: `engines` in `package.json`, `.nvmrc`). No build step, no TypeScript, no `dotenv`. Tests run with `node --test` and need no network, Discord connection or LLM calls.

## Before you start

Neptunia is a Discord pseudo-user engine: one instance, one server, one bot account, one personality supplied through prompt files. The engine stays character-neutral. A character's behaviour belongs in a deployment's own `prompts.local/`, never in `src/` or tracked `prompts/`. Pull requests that add character-specific logic will be declined.

Open an issue before a change of behaviour, a new config setting, a new owner command or a new prompt file, so the design is agreed before the code. A bug fix with a test can go straight to a pull request.

New runtime dependencies are not accepted without prior discussion in an issue.

## Making a change

Fork the repository, branch from `main`, make the change, open a pull request back to `main`.

**Keep it small.** One change per pull request. Around 200 changed lines is a fair guide; split bigger work and land it in slices. If a feature needs discussion, open an issue first.

**Tests.** Every pull request must pass `npm test`, and CI runs it automatically. Tests use `node:test` and `node:assert/strict`. Name tests `subject: behaviour`. Tests never read a real `prompts.local/` or `data/`; I/O goes through fakes. When a test needs non-Latin text, use Greek or accented Latin.

**Code conventions:**

- 2-space indent, single quotes, semicolons.
- Every module starts with a header comment saying why it exists; JSDoc on exports.
- Comments and logs say "the persona" or "the bot", never a character name.
- Pure core, thin I/O: decisions are pure functions with injected `rng` / `now`; discord.js and `fetch` stay at the edges.
- Hot values (`hot.config`, `hot.prompts`) are read at the moment of use, never cached in a long-lived variable.
- The model's output is data: only the tags in the output contract are acted on.
- Logs carry counts, never message contents.

**Every behaviour has a config setting.** A new behaviour needs its switch or number in `config.json` (`features.*` for on/off) and a row in the [configuration reference](docs/configuration.md).

**No model-facing text in `src/`.** Anything the model or the chat reads lives in `prompts/*.md` and `prompts/labels.json`. The prompt-to-code contract (placeholders, `labels.json` keys, context blocks, output tags, analyzer JSON) is documented in [`docs/prompt-contract.md`](docs/prompt-contract.md). A change on one side of the contract changes the other in the same pull request.

**English only.** Code, comments, commit messages, documentation and prompt defaults are all English. A deployment's `prompts.local/` can be in any language, but it is never committed.

**Commit messages.** English, imperative subject line. The body says why when the subject is not enough.

**Privacy.** Never include in an issue or pull request:

- `data/` contents (member profiles, attitudes, episodes)
- Real Discord messages, member names or IDs
- A character card from `prompts.local/`
- `.env` values, tokens or API keys

Log lines pasted into an issue must be redacted. The log format is JSON with counts; the only content that could leak is dry-run output containing the persona's messages.

## Pull requests and review

The pull request description should say:

- **What** changed and **why**.
- **How** you tested it.
- Whether the change adds a config setting, a prompt file or a contract change.

CI runs `npm test` on every pull request; the tests must pass. A single maintainer reviews, may ask for changes, and may squash on merge. What fits the project is the maintainer's call.

## AI-assisted contributions

This project is built with AI coding assistants, so they are not banned. The rule: the human who opens the pull request has read, tested and can explain every line. The pull request must follow the same conventions as any other: no drive-by comment rewrites, no added logging, no new abstractions the change does not need. A pull request that would take longer to fix than to rewrite may be closed.

## Licence

By contributing you agree your contribution is licensed under the repository's [MIT licence](LICENSE). No CLA.
