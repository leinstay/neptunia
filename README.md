# Neptunia

A fully vibe-coded harness for building unique AI personas in chat interfaces. Discord ships today. The interface layer is built for others such as Telegram and Twitter. The persona passes for a regular chat member.

Memory is close to unlimited. Recall works by full-text search over learned word stems and trigrams in one SQLite database, int8 embedding vectors for meaning, time windows around each hit, reciprocal-rank fusion across all of these, and audience-scoped visibility.

The tools focus on making a believable companion. Out of the box, the persona can write and later edit or delete its own messages (with emoji, including custom server emoji on Discord), see pictures and short videos, search the web and the server's own message history, read pages behind links, find information, images and files on the internet through an errand agent, record voice messages, and draw itself in different outfits while keeping a consistent look and a consistent world. Something in the space of [Hermes Agent](https://github.com/NousResearch/hermes-agent), [SillyTavern](https://github.com/SillyTavern/SillyTavern) and [OpenViking](https://github.com/volcengine/OpenViking).

<p align="center"><img src=".github/assets/hero.webp" width="720" alt="A pink-haired girl in a purple hoodie tending potted plants on a night rooftop"></p>

## Documentation

- [Overview and index](docs/README.md)
- [Getting started](docs/getting-started.md)
- [The core: turns, tools and prompts](docs/core.md)
- [Memory](docs/memory.md)
- [Inner life](docs/inner-life.md)
- [Diary](docs/diary.md)
- [Errands and agents](docs/errands.md)
- [Development agents](docs/development-agents.md)
- [Interfaces](docs/interfaces.md)
- [Media: pictures, video, drawing, voice](docs/media.md)
- [Configuration reference](docs/configuration.md)
- [Owner commands](docs/owner-commands.md)
- [Prompt contract](docs/prompt-contract.md)

## License

[MIT](LICENSE)
