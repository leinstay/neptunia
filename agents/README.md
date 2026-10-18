# agents/

Each agent has its own folder here. A folder holds `profile.json` (the agent's description) and, for a worker or a development agent, `prompt.md` (its system prompt).

```
agents/
  web/       prompt.md + profile.json   worker: internet errands (search, read pages, download files)
  server/    prompt.md + profile.json   worker: read-only questions about this machine
  thinker/   prompt.md + profile.json   development: picks up development tasks, writes briefs, reviews, tests, merges; never deploys
  dev/       prompt.md + profile.json   development: writes code within one task
  writer/    prompt.md + profile.json   development: writes prompt and documentation text within one task
  drawing/   profile.json               tool: draws the persona's pictures; the core runs it, no model loop and no process
```

There are four kinds. A worker runs as its own process and takes tasks on a socket. A consultation has no process: tools call its model role directly. A development agent works on the code itself: the engine only describes it (tools, effort, default caps, prompt), and a dispatcher or orchestrator outside the engine runs it on OpenCode for one development task at a time. A tool agent has no model loop and no process: the core runs its one tool itself. The agent runner skips consultations, development agents and tool agents.

The development prompts here are generic and public; a deployment adds its own rules to them where it runs the agents.

A deployment can replace a worker's prompt with its own file under `prompts.local/` (the name in `override`, for example `prompts.local/agent-web.md`); the private file wins when it exists. The agent runner (`src/agent-runner/profiles.js`) reads these folders at start; the bot reads them too for the defaults it needs.

For the profile keys, the security model, the protocol and how to add an agent, see [`docs/agents.md`](../docs/agents.md).
