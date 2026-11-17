# Media and search

The persona uses descriptions of media as durable conversational evidence. It does not need to watch the same image again on every turn. A description lives on its item's row of `media` and nowhere else.

## Descriptions and originals

A saved description is reused after a restart or after the cache's cap retired its row: `getMediaDescription` reads it from the retired row, and the describer writes it back. An explicit rewatch replaces the entry with its new answer. A failed refresh keeps the successful description and stamps it with the failure.

## How a picture is described

`describe` in `src/memory/describe.ts` sends the picture to the `vision` role as a data URL under the system message of `prompts.describe`. The caption is the whole answer, every line joined into one line with single spaces. Its length is `DESCRIPTION_CHARS`, 1500 characters. Stickers and emoji take the same path. The prompt asks for what the picture shows, each figure and what it wears, the legible words, what could not work as drawn, and the place and the light.

A GIF's description takes the same 1500 characters, a video summary `VIDEO_DESCRIPTION_CHARS`, 6000, and an audio summary `AUDIO_DESCRIPTION_CHARS`, 3000. A second look takes the length of its media. Each prompt learns its length through `{{maxChars}}`. The describer cuts no answer. An answer over its length goes once to the summarizer in `src/behavior/summarize.ts`, one `analyzer` request with the purpose `summarize`, and its result is stored whole, even when it is still longer. A failed summary keeps the answer whole.

A GIF is watched as a short clip through the prompt `describe-gif`, else `describe-video`. Its answer is prose, stored as one text on one line. The transcript, the answer of `media.find` and the candidate list of the media pick show that text whole, through `labels.gifs.entry` in the two lists.

The vision model learns who she is through `{{self}}` in the prompt. When `prompts.appearance` is not blank and the core knows her name in the place (`selfName`, given to `createDescriber` and read from `getSelfName` in `src/core.ts`), `{{self}}` is the prompt `describe-self` with `{{name}}` and `{{appearance}}`. A figure that matches the appearance is named by her name. Otherwise `{{self}}` is empty and leaves no blank paragraph. The GIF and video prompts carry no `{{self}}`.

The engine does not promise to download every attachment it encounters. Diary originals are preserved under `data/media/`, with database references and checksums. Every file of the owner's command line chat, in both directions, is copied to `data/media/cli/` by `src/chat/kept-media.ts`, and the `path` of its `media` row names the copy ([cli](cli.md#kept-files)). A GIF of the library keeps every link it was seen under in the `extra` of its `media` row, and `src/memory/gif-keeper.ts` caches its file under `data/media/gifs/` when a download gives one. `path` on a `media` row is null or a file under `media/`. The vector of a GIF's caption is a row of `vectors` under `gif:<item id>`, read by `src/memory/db/gif-vectors.ts`, so a flush of the library writes no vector. A cached description, an external URL and a preserved original are different things when preparing a backup.

## Available abilities

A voice message or an audio file reaches the describer on the `video` role through the prompt `describe-audio`. `fetchAudio` in `src/media/fetch-video.ts` carries it as a short clip, packaged by `ffmpegAudioArgs` in `src/media/video-sites.ts`, and `audioPart` in `src/memory/describe.ts` puts it in the request. `fetchAudio` takes an answer of type `audio/*` or `video/*` and refuses any other, so a page a CDN answers with never reaches `ffmpeg`. The clip's black picture stops with the sound, at most a tenth of a second past it. A file refused for its size is not tried again, and a passing failure is tried again after an hour, with the cause kept on the cache entry. A text file's text form is the opening of its own words, with no model. A transcript and what she voiced are quoted speech as a whole, so the script check of a description does not apply to them and they stay in the language spoken.

Drawing and voice use their configured model roles and credentials. `ffmpeg` supports audio conversion and video preparation, and `yt-dlp` retrieves supported videos. The optional YouTube Data API key supplies metadata rather than vision. Configure it through [setup](setup.md#optional-modules).

The turn's senses report which abilities are available. A configured credential alone is not proof that a remote provider is reachable. Tool failures return to the turn so the persona can decide how to proceed.

## Search

Three paths reach the web, and each has its own availability. Turning quick search off changes neither of the other two.

Quick search is the core's `web.search`, in [src/web/lookup.ts](../src/web/lookup.ts). It runs on the one engine in `web.quickSearch.engine`, which is `openrouter`, `brave` or `exa`. No engine is built in, so it stays off until `neptunia setup` or `/search engine` chooses one. The tool result says why it is off: `no-engine`, `no-model` for `openrouter` without a `search` chain in `models.routes.search`, `no-key` for an engine without its key, or `disabled` by `web.quickSearch.enabled`. When the chosen engine fails, the result names the engine and the cause, `timeout`, `rate-limited` or `credentials` among them, and no other engine answers in its place. The `openrouter` engine sends one request with the web plugin, which sets no `engine`, under the purpose `quick-search`.

Page reading is `web.read`, with no model request. [src/web/fetch-page.ts](../src/web/fetch-page.ts) checks the address of the link and of every redirect against private ranges, caps the size and refuses unsupported content. The text she reads names the address the page ended at, on an empty page too, and a user name or password written into a link reaches neither that text nor the cache. The read stays in the media cache under `page:<hash of the address>` until a later read replaces it, and past `web.links.readCacheHours` a `web.read` of the address fetches the page again. It is the link's text form: `readLinks` and `cachedReads` in [src/web/lookup.ts](../src/web/lookup.ts) answer it for every link to that address, in place of the preview and with no fetch. A transcript shows at most `LINK_EXCERPT_CHARS`, 700, of it, the length of a preview, so a read page adds nothing to a request beyond what its preview did.

Deep search is an errand for the scout, which searches with its harness's own tools: the OpenCode route uses its `websearch` tool on the route's key.

When only deep search is available, the persona can use it directly. When both are available, the model chooses the appropriate tool and can follow an unhelpful quick result with deeper work. See [keys](keys.md#quick-search) for routing and [errands](errands.md) for the scout.

Implementation entry points are [src/media/](../src/media/), [src/tools/operations/](../src/tools/operations/) and [src/memory/db/](../src/memory/db/).
