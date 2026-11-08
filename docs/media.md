# Media and search

The persona uses descriptions of media as durable conversational evidence. It does not need to watch the same image again on every turn. Runtime caches keep active work small; successful description versions remain in the database.

## Descriptions and originals

A saved description can be reused after a restart or cache eviction. Explicit rewatching creates another description version. A failed refresh does not erase the successful version already stored.

The engine does not promise to download every attachment it encounters. Selfreflection originals are preserved under `data/media/`, with database references and checksums. A GIF of the library keeps every link it was seen under in the `extra` of its `media` row, and `src/memory/gif-keeper.ts` caches its file under `data/media/gifs/` when a download gives one. `path` on a `media` row is null or a file under `media/`. The vector of a GIF's caption is a row of `vectors` under `gif:<item id>`, read by `src/memory/db/gif-vectors.ts`, so a flush of the library writes no vector. A cached description, an external URL and a preserved original are different things when preparing a backup.

## Available abilities

A voice message or an audio file reaches the describer on the `video` role through the prompt `describe-audio`. `fetchAudio` in `src/media/fetch-video.ts` carries it as a short clip, packaged by `ffmpegAudioArgs` in `src/media/video-sites.ts`, and `audioPart` in `src/memory/describe.ts` puts it in the request. `fetchAudio` takes an answer of type `audio/*` or `video/*` and refuses any other, so a page a CDN answers with never reaches `ffmpeg`. The clip's black picture stops with the sound, at most a tenth of a second past it. A file refused for its size is not tried again, and a passing failure is tried again after an hour, or at once when the owner's `backfill-media` asks with `retryMisses`, with the cause kept on the cache entry. A text file's text form is the opening of its own words, with no model. A transcript and what she voiced are quoted speech as a whole, so the script check of a description does not apply to them and they stay in the language spoken.

Drawing and voice use their configured model roles and credentials. `ffmpeg` supports audio conversion and video preparation, and `yt-dlp` retrieves supported videos. The optional YouTube Data API key supplies metadata rather than vision. Configure it through [setup](setup.md#optional-modules).

The turn's senses report which abilities are available. A configured credential alone is not proof that a remote provider is reachable. Tool failures return to the turn so the persona can decide how to proceed.

## Search

Three paths reach the web, and each has its own availability. Turning quick search off changes neither of the other two.

Quick search is the core's `web.search`, in [src/web/lookup.ts](../src/web/lookup.ts). It runs on the one engine in `web.quickSearch.engine`, which is `openrouter`, `brave` or `exa`. No engine is built in, so it stays off until `neptunia setup` or `/search engine` chooses one. The tool result says why it is off: `no-engine`, `no-model` for `openrouter` without `web.quickSearch.model`, `no-key` for an engine without its key, or `disabled` by `web.quickSearch.enabled`. When the chosen engine fails, the result names the engine and the cause, `timeout`, `rate-limited` or `credentials` among them, and no other engine answers in its place. The `openrouter` engine sends one request with the web plugin, which sets no `engine`, under the purpose `quick-search`.

Page reading is `web.read`, with no model request. [src/web/fetch-page.ts](../src/web/fetch-page.ts) checks the address of the link and of every redirect against private ranges, caps the size and refuses unsupported content. The text she reads names the address the page ended at, on an empty page too, and a user name or password written into a link reaches neither that text nor the cache. The read stays in the media cache under `page:<hash of the address>` until a later read replaces it, and past `web.links.readCacheHours` a `web.read` of the address fetches the page again. It is the link's text form: `readLinks` and `cachedReads` in [src/web/lookup.ts](../src/web/lookup.ts) answer it for every link to that address, in place of the preview and with no fetch. A transcript shows at most `LINK_EXCERPT_CHARS`, 700, of it, the length of a preview, so a read page adds nothing to a request beyond what its preview did.

Deep search is an errand for the scout, which searches with its harness's own tools: the OpenCode route uses its `websearch` tool on the route's key.

When only deep search is available, the persona can use it directly. When both are available, the model chooses the appropriate tool and can follow an unhelpful quick result with deeper work. See [keys](keys.md#quick-search) for routing and [errands](errands.md) for the scout.

Implementation entry points are [src/media/](../src/media/), [src/tools/operations/](../src/tools/operations/) and [src/memory/db/](../src/memory/db/).
