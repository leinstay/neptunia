# Configuration

This reference is generated from the settings schema. Each row gives the accepted type, shipped default and implementation reader. Change personal values through the CLI or `data/config/config.json`; arrays replace defaults whole and objects merge by key.

Use [getting started](getting-started.md) for a first installation, [keys](keys.md) for credentials and models, and [memory](memory.md) for recall and audience behavior. `/config check` validates stored overrides. Model credentials and interface secrets are kept outside this settings file.

To update this reference after a schema change, run `node scripts/config-doc.ts > docs/configuration.md`. Edit the prose in `scripts/config-doc.template.md` and the setting definitions in `src/config/schema/`.

## interfaces

<!-- settings: interfaces -->

## bot

<!-- settings: bot -->

## models.base

<!-- settings: models.base -->

## models.abilities

<!-- settings: models.abilities -->

## models.byPurpose

<!-- settings: models.byPurpose -->

## models.errands

<!-- settings: models.errands -->

## models.development

<!-- settings: models.development -->

## llm

<!-- settings: llm -->

## memoryDb

<!-- settings: memoryDb -->

## memoryDb.session

<!-- settings: memoryDb.session -->

## embed

<!-- settings: embed -->

## context

<!-- settings: context -->

## context.pull

<!-- settings: context.pull -->

## mention

<!-- settings: mention -->

## missed

<!-- settings: missed -->

## typing

<!-- settings: typing -->

## pace

<!-- settings: pace -->

## format

<!-- settings: format -->

## split

<!-- settings: split -->

## route

<!-- settings: route -->

## memory

<!-- settings: memory -->

## media

<!-- settings: media -->

## web

<!-- settings: web -->

## participation

<!-- settings: participation -->

## recall

<!-- settings: recall -->

## recall.db

<!-- settings: recall.db -->

## recall.prefetch

<!-- settings: recall.prefetch -->

## image

<!-- settings: image -->

## speech

<!-- settings: speech -->

## tools

<!-- settings: tools -->

## skills

<!-- settings: skills -->

## watcher

<!-- settings: watcher -->

## selfimprovement

<!-- settings: selfimprovement -->

## development

<!-- settings: development -->

## selfreflection

<!-- settings: selfreflection -->

## mirrors

The owner's `/mirror` commands choose the destinations and each destination's backfill interval, which live in memory. These two settings bound one delivery.

<!-- settings: mirrors -->

## private

<!-- settings: private -->

## errands

<!-- settings: errands -->

## agents

<!-- settings: agents -->

## board

<!-- settings: board -->

## intentions

<!-- settings: intentions -->

## wakes

<!-- settings: wakes -->

## heartbeat

<!-- settings: heartbeat -->

## appendStore

<!-- settings: appendStore -->

## archive

<!-- settings: archive -->

## diagnostics

<!-- settings: diagnostics -->

## cli

<!-- settings: cli -->
