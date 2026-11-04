# Self-development

The persona files development work in her selfimprovement wake, and a separate executor implements it. The executor works in a separate checkout, creates a branch, checks the change and submits a pull request. It must not edit the checkout running the live core. This guide is for an owner setting that up.

## The wake and the executor

The selfimprovement wake is a persona turn that decides: she files one task or skips, and the wake ends. [Inner life](inner-life.md#heartbeat-and-selfimprovement) describes what it accepts. Neither the wake nor the persona starts an agent. The executor picks up a filed task on its own timer and reads its instructions from `prompts/executor-brief.md`, which `data/prompts/executor-brief.md` replaces. A local `data/prompts/selfdev.md` loads as that brief while `executor-brief.md` is absent from `data/prompts/`. The wake's own prompt is `prompts/selfimprovement.md`.

## Grant her tools

The tracked `bot.access` is empty, so the persona holds no board tool until the deployment grants it. Without `board.propose` the wake can only skip, and without `board.answer` she reads a question she cannot answer. Grant them with `/tools grant`:

```text
/tools grant board.propose
/tools grant board.status
/tools grant board.cancel
/tools grant board.comment
/tools grant board.answer
```

A grant lets her call the tool, and the wake still limits where each one runs. `board.cancel`, `board.comment` and `board.answer` run only in the selfimprovement wake.

## Configure

Set `selfimprovement.checkout` to a development checkout. Run the full `neptunia setup` to select the target repository and check the persona's GitHub access. Backend authentication and the GitHub home belong under `data/subharness/`.

`selfimprovement.mode` controls how proposed work is handled. Read its current choices in [configuration](configuration.md) before enabling automation. A repository name without working push access is not a configured development path.

## Schedules and results

The installed executor timer runs at six-hour intervals. Its service is a oneshot and the timer does not catch up missed firings after downtime. The selfimprovement wake is a separate [inner-life](inner-life.md) event, scheduled and switched with `neptunia service selfimprovement setup`, `enable` and `disable`. Disabling the wake leaves accepted development tasks alone.

The [board](board.md) retains task evidence, attempts and results. A merged change, a question, a blocked task and a proposal from the thinker reach the persona in her next selfimprovement wake, and she decides what to do about them. A failed or interrupted attempt remains inspectable through the backend session and task records; it is not an instruction to replay old actions.

Inspect the installed timer through the same systemd scope used during setup. The unit starts `neptunia worker selfimprovement`, which executes a beat and can create work and spend model allowance. `neptunia service selfimprovement status` reads the state with no such cost.

Read the implementation in [src/selfimprovement/service.ts](../src/selfimprovement/service.ts), [unit templates](../deploy/README.md) and [task board](../src/board/).
