# pi-gear-router

Per-turn three-gear model routing for [Pi](https://pi.dev), judged by [TypeSafe Jev](https://typesafe.ai).

Jev scores each incoming turn `0..2`. The score picks **light**, **standard**, or **heavy**, and each gear names its own model and thinking level. The expensive tier is spent only where it changes the outcome.

```
light     0.0 – 0.5   cheap model, low effort
standard  0.5 – 1.5   mid model, medium effort
heavy     1.5 – 2.0   strong model, high effort
```

Built on Pi's [virtual models](https://pi.dev/docs/latest/virtual-models). You select one model, `gears/auto`; Pi dispatches each turn to a physical model underneath.

## Why three gears, not two

Most routers pick between a cheap and an expensive model. That forces ordinary work — a refactor, a debugging question, a docstring — into one of two buckets, and both choices are wrong: the cheap tier is too weak for some of it, the expensive tier is wasteful for the rest.

A middle tier is where most engineering turns actually land. Three continuous anchors let the classifier express "this needs more than light, less than heavy" instead of rounding to the nearest wrong answer.

## Install

Requires `TYPESAFE_API_KEY` in the shell:

```sh
export TYPESAFE_API_KEY="apikey_..."
```

Pi 1.1.0 ships the `typesafe/jev-latest` classifier in its bundled catalog, so no `models.json` entry is needed. Verify:

```sh
pi auth check --provider typesafe   # expect: ready
```

Then install and select the virtual model:

```sh
pi install /path/to/pi-gear-router
pi --model gears/auto
```

To make it the default, in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "gears",
  "defaultModel": "auto",
  "enabledModels": ["gears/**", "yourprovider/**"]
}
```

Note that `enabledModels` filters the startup and cycling set. If you already scope your models with `enabledModels`, add `gears/**` or the virtual model will not be selectable.

## Configure

Create `~/.pi/agent/pi-gear-router/settings.json`:

```json
{
  "enabled": true,
  "gearBias": 0,
  "judgeTimeoutMs": 15000,
  "gears": {
    "light":    { "provider": "yourprovider", "model": "cheap-model-id",      "thinkingLevel": "low" },
    "standard": { "provider": "yourprovider", "model": "balanced-model-id",  "thinkingLevel": "medium" },
    "heavy":    { "provider": "yourprovider", "model": "frontier-model-id",   "thinkingLevel": "high" }
  }
}
```

Any three models in ascending capability order work, across providers. `src/defaults.ts` ships Anthropic haiku/sonnet/opus as a starting point.

### `gearBias`

Shifts the score by up to ±0.4, so you tune cost against quality without editing boundaries:

| Value | Effect |
|---|---|
| `-1` | Nearly everything lands on standard |
| `0` | Neutral, trust the classifier |
| `+1` | Any real complexity escalates to heavy |

If simple work keeps landing on standard, try `-0.3`. If the classifier seems to under-rate hard work, try `+0.3`.

### `judgeTimeoutMs`

Decision calls are slower than ordinary chat calls. The default here is 15s; pi's own default of 5s cuts off many verdicts and silently degrades you to `standard`.

## How it works

Before each turn Pi calls `route()`, which returns a physical model and thinking level.

- **One judge call per turn.** The verdict is stored as router state on the session branch, so tool follow-ups and retries reuse it. State follows `/tree` and forks and survives compaction.
- **Sticky within a turn.** `continuation` returns the model that just answered, `retry` the model that failed. This keeps prompt caches and thinking signatures valid; switching only happens between turns, where the cache is already cold.
- **Degrades, never fails.** No classifier, no key, a timeout, or an unparsable answer all fall back to `standard` and keep the turn running. A malformed config falls back to defaults rather than disabling routing.
- **Cheap outside the loop.** Compaction summaries and extension-initiated calls go to `light` without consulting the judge.

### The judge question

The classifier is asked for the **lowest** tier likely to finish correctly, not "how hard is this". The latter biases every ordinary request upward and is the most common way routers overspend.

The prompt also tells it not to inherit difficulty from earlier turns when the current request stands alone, and to use recent messages only to resolve references and follow-up intent.

## Picking your gears

Do not assume the cheapest model is the cheapest tier. Cheap models with strong reasoning can be worse than useless at high effort: they spend the whole output budget on reasoning tokens and return an empty body, which looks like a broken tier.

Concretely, while building this on a local gateway, one model marketed as cheap exhausted a 4000-token budget on four of eight tasks and returned a 502 on a fifth, all at `high` effort. The same model was fine at `low`. Pin `light` to a low thinking level and verify with real tasks before trusting it.

`src/defaults.ts` records the full measurement behind the example configuration there, including the rejected candidate.

## Design notes

Adapted from [pi-gearshift](https://github.com/iharuya/pi-gearshift) (MIT), which pioneered Jev-driven gear routing for Pi. The judge question wording and the bias-shifting design follow that project. Three differences:

1. **Virtual models instead of `before_agent_start` + `pi.setModel()`.** A virtual model is a real catalog entry: selection survives resume, no global mutation of Pi's current model, and the footer shows both selection and dispatched model.
2. **Pi's built-in `classify()` instead of the TypeSafe SDK.** One less dependency, and no API key handling in this package. The cost is that Pi's `score` question exposes only `instructions` and `criteria`, so gearshift's `context` / `objective` / `guidance` split is folded into a single `instructions` string.
3. **Lenient config.** gearshift treats an unusable config as a reason to disable routing; this treats it as a reason to use defaults. For an optimisation, degrading is better than failing.

## Known limits

- One Jev call per turn adds latency before the first token.
- The router has no pricing table, so it cannot cost-account a turn or tell you what it saved. Judge token counts land in router state but are not surfaced.
- Three tiers is a deliberate simplification. More tiers means more boundary decisions and a noisier classifier, not better routing.

## License

MIT. See [LICENSE](LICENSE).