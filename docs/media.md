# Media and search

The persona uses descriptions of media as durable conversational evidence. It does not need to watch the same image again on every turn. Runtime caches keep active work small; successful description versions remain in the database.

## Descriptions and originals

A saved description can be reused after a restart or cache eviction. Explicit rewatching creates another description version. A failed refresh does not erase the successful version already stored.

The engine does not promise to download every attachment it encounters. Diary originals are preserved under `data/media/`, with database references and checksums. GIF library entries can remain external links. A cached description, an external URL and a preserved original are different things when preparing a backup.

## Available abilities

Drawing and voice use their configured model roles and credentials. `ffmpeg` supports audio conversion and video preparation, and `yt-dlp` retrieves supported videos. The optional YouTube Data API key supplies metadata rather than vision. Configure it through [setup](setup.md#optional-modules).

The turn's senses report which abilities are available. A configured credential alone is not proof that a remote provider is reachable. Tool failures return to the turn so the persona can decide how to proceed.

## Search

Quick search returns search results through OpenRouter, Brave or Exa. Deep search delegates research to the scout. Page reading is another capability. These have separate availability: disabling quick search does not by itself disable the scout or page reading.

When only deep search is available, the persona can use it directly. When both are available, the model chooses the appropriate tool and can follow an unhelpful quick result with deeper work. See [keys](keys.md#quick-search) for routing and [errands](errands.md) for the scout.

Implementation entry points are [src/media/](../src/media/), [src/tools/impl/](../src/tools/impl/) and [src/memory/db/](../src/memory/db/).
