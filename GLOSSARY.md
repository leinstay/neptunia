# Glossary

The engine's words, for anyone naming something in the code, the database, a document or a label. An identifier, a comment, a label or a config key uses these words and no synonym. The column on the right lists what not to write for the same thing. Text a model reads may use plain language where a word below would read as jargon.

## Where the persona is

| Word | Meaning | Avoid |
|---|---|---|
| `core` | The platform-neutral engine in `src/`. | |
| `interface` | A package for one platform, and the top level of every path of places. The command line is an interface and a place. | platform |
| `adapter` | The part of an interface that translates between the platform and the protocol. | |
| `place` | Anything the persona can be in or name: a root, a channel, a thread, a `dm`, the command line. | location |
| `root` | The top place of an interface, such as one Discord server. An interface may have many. | `guild`, `community` |
| `chat` | A place where lines are written: a channel, a thread, a `dm`, the command line. A root is a place and no chat. | `conversation`, room |
| `dm` | A one-to-one chat. | private chat, PM, `direct` |
| `group` | The scope of a place people share. A place's scope is `group` or `dm`. | public |
| `native kind` | What a platform calls a place, such as `server` or `channel`, a value the interface supplies. The core never branches on it. | |

## What the persona does

| Word | Meaning | Avoid |
|---|---|---|
| `event`, `action` | What arrives from an interface, and what the core asks an interface to do. | |
| `turn`, `step` | One run of the persona, and one model call inside it. | |
| `turn frame` | The facts of one turn, fixed before any block of its request: its kind, why she is awake, whom she answers, where she is and which blocks it holds. | |
| `turn kind` | Which of the frame's lists of blocks a turn takes. | mode |
| `wake` | A row of the queue of turns the engine starts itself. | |
| `service` | One of the three scheduled mechanics: `heartbeat`, `selfreflection`, `selfimprovement`. | |
| `service turn` | A turn of a service, with no chat and no place. | |
| `selfreflection` | The service that writes her dated entries, and those entries as a store. Prompts tell her she keeps a diary. | `diary` |
| `mirror` | A place a stored entry of `selfreflection` is copied to. | |
| `intention` | Something the persona decided to do later. It is no service. | intent |
| `tool` | Code with a schema that the model calls. | |
| `skill` | A prose procedure over tools. | |
| `command` | What a person types in the CLI. | |
| `errand` | A background job handed to an agent. | |
| `agent` | A model with a profile that works on an errand or a development task. | |

## What the engine keeps

| Word | Meaning | Avoid |
|---|---|---|
| `memory` | What the persona keeps between turns. | |
| `model role` | The name under which a model is configured. | |
| `labels` | The wording of what code inserts into a prompt, and the strings the owner sees. | |
| `config`, `local layer` | The shipped settings, and the files of one deployment that override them. | private layer |
| `lease` | A time-limited claim on a resource. | |
