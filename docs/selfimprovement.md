# Self-development

The persona can propose development work and delegate implementation. The executor works in a separate checkout, creates a branch, checks the change and submits a pull request. It must not edit the checkout running the live core.

## Configure

Set `selfimprovement.checkout` to a development checkout. Run the `selfimprovement` setup step to select the target repository and check the persona's GitHub access. Backend authentication and the GitHub home belong under `data/subharness/`.

`selfimprovement.mode` controls how proposed work is handled. Read its current choices in [configuration](configuration.md) before enabling automation. A repository name without working push access is not a configured development path.

## Schedules and results

The installed executor timer runs at six-hour intervals. Its service is a oneshot and the timer does not catch up missed firings after downtime. The daily self-improvement wake is a separate [inner-life](inner-life.md) event.

The [board](board.md) retains task evidence, attempts and results. A merged change can become context for the persona's later turn. A failed or interrupted attempt remains inspectable through the backend session and task records; it is not an instruction to replay old actions.

Inspect the installed timer through the same systemd scope used during setup. `neptunia selfimprovement run` executes a beat directly and can create work and spend model allowance, so use it as an operational command rather than a health check.

Read the implementation in [src/selfimprovement/service.ts](../src/selfimprovement/service.ts), [unit templates](../deploy/README.md) and [task board](../src/board/).
