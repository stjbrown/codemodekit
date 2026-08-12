# Skill evaluation

Test behavior, not prose coverage. Keep a small table or JSON fixture outside the runtime skill directory so evaluation artifacts are not shipped as instructions unless intentionally useful.

## Minimum cases

Create at least:

- two requests that should activate the skill;
- one nearby request that should not activate it;
- one simple read workflow;
- one dependent multi-tool workflow;
- one ambiguous request that should trigger a focused question;
- one upstream failure or missing-result case; and
- one write or destructive case when such tools exist.

## Assertions

Grade whether the agent:

- activates the intended skill and avoids unrelated activation;
- uses `run_typescript` rather than trying to call hidden upstream tools directly;
- chooses tools and arguments present in the current declarations;
- composes related work into one execution;
- asks only consequential questions;
- respects tool policy and documented write boundaries;
- handles missing structured content or tool failure safely; and
- returns a bounded answer shaped for the request.

## Forward test

When an agent runner is available, run representative cases with the authored skill and with the generated baseline or prior version. Use fresh contexts and compare tool traces, outputs, retries, and user-facing quality. Do not reveal the expected implementation or suspected defect to the test agent.

Repeat flaky trigger cases several times before changing the description. A description succeeds when relevant prompts activate reliably without capturing adjacent unrelated work.
