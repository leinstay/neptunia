# Documentation

Neptunia is a persona engine. One instance serves one chat server, one bot account, one personality supplied through prompt files. The engine itself is character-neutral: who the persona is and how it talks are defined entirely in text files you write.

## How the parts fit

```
  interface (Discord, ...)
      |
      v
  event door ── validates, deduplicates
      |
      v
  pipeline ── triggers, memory prefetch, classifiers
      |
      v
  turn ── prompt assembly, token budget, LLM request, tool loop
      |
      v
  actions ── messages, reactions, drawings, voice, errands
      |
      v
  memory ── profiles, episodes, lore, journal, recall
```

A message arrives through an interface adapter. The event door validates it and passes it to the pipeline. The pipeline decides whether the persona answers (a mention, a reply, a name trigger, a spontaneous cut-in) and collects the context: memory profiles, channel history, media descriptions, recall hits. A turn assembles everything into one LLM request under a token budget, sends it, and acts on the output (messages, reactions, tool calls). Memory is updated by the persona's own memory session.

The persona's inner life (heartbeat wakes, intentions, the diary) runs the same turn machinery on a timer instead of on an incoming message.

## Documentation index

| Document | What it covers |
|---|---|
| [Getting started](getting-started.md) | Requirements, install, configuration layers, environment keys, first run, service setup, tests, contributing |
| [The core](core.md) | The event door, a turn step by step, the tool loop, prompt assembly and cache layout, model roles and keys, safety rails |
| [Memory](memory.md) | Concepts, data model, write and read paths, the memory session, recall, scopes, configuration |
| [Inner life](inner-life.md) | Heartbeat, daily review, intentions, inner turns, caps, the kill switch, the virtual-week harness |
| [Diary](diary.md) | The diary feature |
| [Errands](errands.md) | task.run, errand agents, the runner, sandbox users, results returning as a turn |
| [Development agents](development-agents.md) | The dev and thinker agents, profiles, the two run paths |
| [Interfaces](interfaces.md) | The interface port and protocol, the Discord adapter, adding an interface |
| [Media](media.md) | Pictures, video, drawing, voice messages, GIFs, custom emoji, web and server search |
| [Configuration reference](configuration.md) | Every key in config.json |
| [Owner commands](owner-commands.md) | The /nep command tree and the access model |
| [Prompt contract](prompt-contract.md) | The contract between prompt files and code: files, placeholders, labels, output tags |
| [Style guide](../STYLEGUIDE.md) | How code and documentation are written |
