# Interfaces

An interface connects a platform to the persona. It translates platform messages into protocol events and executes the actions the core returns. Discord is the shipped implementation; another platform uses the same contract.

## Package contract

Start with [InterfaceHost](../src/protocol/host.ts), [events](../src/protocol/events.ts) and the [adapter types](../src/protocol/adapter.ts). A package exports `start(host)` and returns a `RunningInterface` with `iface`, `open()` and `stop()`. It may provide `reconnect()`.

The host supplies a connection, client token, live settings, logger and a directory for interface state. `open()` releases incoming events after the core has installed its handlers. Declare capabilities such as history, reactions, attachments and search honestly; unsupported operations return an explicit result.

Keep platform SDK imports in the interface package. The interface imports only the shared protocol from the engine. It never opens `memory.db`. Use [the fake interface package](../tests/fixtures/interfaces/fake/) for a small executable reference, and [Discord](../interfaces/discord/) for a full implementation.

## Identity and audience

Every account and conversation belongs to an interface namespace. Preserve native IDs as identifiers, not display names. Supply community, conversation, author, timestamps and visibility information in the event shape. A direct conversation is private even when its participant also belongs to a server.

Account linking is performed by the owner's [memory commands](memory.md#one-person-several-accounts). An interface must not infer that matching names or native IDs on another platform refer to the same person.

Delivery reports distinguish success, failure and unknown outcome. Preserve the idempotency key across split messages. After a connection loss, an uncertain delivery must not become an unconditional retry days later.

## Setup contract

The package's `setup.json` declares a `settings` array. Each setting has `key`, `question`, `kind` and optional `required`. Kinds are `text`, `list` and `secret`.

```json
{
  "settings": [
    { "key": "token", "question": "Platform token", "kind": "secret", "required": true },
    { "key": "servers", "question": "Server IDs", "kind": "list" }
  ]
}
```

The shared setup stores values under `data/interfaces/<name>/`. Secrets go to `credentials.json`; other values go to `config.json`. Technical state belongs in that directory too. Disabling the package preserves both its state and the core's memories.

## Clients and principals

The core socket authenticates each client against `clients.json` and its token file. An interface client has kind `interface` and a fixed `iface`. It supplies platform events, not owner administrative commands. CLI and agent clients have separate kinds and permissions.

```bash
node scripts/client-token.ts add NAME --kind interface --iface NAME
```

See [setup](setup.md) for where the selected data root is stored. Tokens must be readable by the user running that client.

## Interfaces as units

With `interfaces.mode` set to `units`, run a package through `neptunia interface run <name>` or its `neptunia-interface@<name>.service` unit. The core and the interface must select the same persona root and matching socket credentials.

An authored package can live under `data/interfaces/<name>/`; otherwise the loader uses `interfaces/<name>/` from the engine. Personal interface code therefore travels with a whole-persona backup. Package dependencies still need installation on the destination machine.
