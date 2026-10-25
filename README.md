<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.png">
    <img src=".github/assets/banner.png" width="700" alt="Neptunia - AI character engine for Discord">
  </picture>
</p>
<p align="center">
  <a href="https://github.com/leinstay/neptunia/stargazers"><img src="https://img.shields.io/github/stars/leinstay/neptunia" alt="GitHub stars"></a>
  <a href="https://github.com/leinstay/neptunia/forks"><img src="https://img.shields.io/github/forks/leinstay/neptunia" alt="GitHub forks"></a>
  <a href="https://github.com/leinstay/neptunia/issues"><img src="https://img.shields.io/github/issues/leinstay/neptunia" alt="GitHub issues"></a>
  <a href="https://github.com/leinstay/neptunia/pulls"><img src="https://img.shields.io/github/issues-pr/leinstay/neptunia" alt="GitHub pull requests"></a>
  <a href="https://github.com/leinstay/neptunia/blob/main/LICENSE"><img src="https://img.shields.io/github/license/leinstay/neptunia" alt="License"></a>
  <a href="https://github.com/leinstay/neptunia/actions/workflows/test.yml"><img src="https://github.com/leinstay/neptunia/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="docs/README.md"><img src="https://img.shields.io/badge/docs-documentation-blue" alt="Documentation"></a>
</p>

---

A fully vibe-coded harness for building unique neuropersonas in different chat interfaces (Discord, Telegram, Twitter, etc.) with near-unlimited memory. Recall works by full-text search over learned word stems and trigrams in one SQLite database, int8 embedding vectors for meaning, time windows around each hit, reciprocal-rank fusion across all of these, and audience-scoped visibility.

All built-in tools focus on making a believable human-like companion. Out of the box, the persona can write and later edit or delete its own messages, react with emoji, see images and videos, search the web, read pages behind links, find information, images and files on the internet through an errand agent, send GIFs, stickers and custom server emoji, record voice messages, and draw itself in different outfits while keeping a consistent look and a consistent world. It remembers people and keeps its own attitude to each of them, keeps a diary, sets its own intentions and wakes on its own heartbeat to keep promises, and talks in private messages with a separate private memory. Think of [Hermes Agent](https://github.com/NousResearch/hermes-agent) meets [SillyTavern](https://github.com/SillyTavern/SillyTavern) with [OpenViking](https://github.com/volcengine/OpenViking)'s modified memory.

<p align="center"><img src=".github/assets/hero.webp" width="720" alt="A pink-haired girl in a purple hoodie tending potted plants on a night rooftop"></p>
