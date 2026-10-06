# cockpit-bar: cache timer, API costs and a live workers board for Claude Code

[Deutsch](README.de.md)

![cockpit-bar bar above the Claude Code prompt](docs/hero.png)

A small Claude Code plugin that puts one bar above the prompt. It shows how long the prompt cache stays warm, how full the context is, and what the current chat would cost at API list prices, split by model, subagent, skill, MCP server and tool.

Why: a long chat that sits idle past the cache lifetime gets re-cached on the next message. With a 300k token context that is the most expensive message of the day. The bar shows the countdown so you can answer in time or compact first.

## What it shows

The arrow on the left cycles through three sizes.

| Size | Content |
|---|---|
| ▸ small | weather icon, cache minutes left, context %, total cost |
| ▾ normal | cache countdown bar, cache hit rate of the last answer, context %, compact button, total cost |
| ▴ full | table per model (input, output, cache read, cache write, cache hit, cost), the 5 most expensive sources with bars, and a legend |

Weather icon: ☀️ context below half of the auto-compact limit, 🌧 above half, ⛈ close to the limit (the compact button lights up). The cache bar turns orange below 25% of the cache time and red below 10%.

## Workers board

While subagents run, one row per agent appears under the bar: type, task, a progress bar, tool calls and runtime. The spinner turns into a green check when the agent is done, and the row disappears after 30 seconds. At most 5 rows.

Under each running agent a second grey line shows what it is doing right now, for example `Read notes.md` or `Bash ls -la`.

Claude does not know in advance how many steps an agent needs, so the bar is an estimate from the number of tool calls. It fills more slowly with every call and stays below 95% until the agent has really finished.

## Install

1. Download or clone this repo, for example to `~/.claude/mods/cockpit-bar`.
2. Add the folder to the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/cockpit-bar"
  }
}
```

3. Open a new chat. The bar appears after the first answer.

Needs a Claude Code version with plugin function hooks (`ui.render`, `turn.complete`). Tested with 2.1.286 in the desktop app. In the terminal the bars are drawn with characters, in the desktop app as SVG.

## How the numbers are made

- Cost uses API list prices per million tokens as of 25 September 2026: Fable 5.1 $10 / $50, Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 4.5 $1 / $5. Cache reads and cache writes (1.25x input for 5 minutes, 2x for 1 hour) are counted separately. On a subscription you do not pay these amounts. They show what the chat is worth in API terms.
- Main chat and subagents use the exact token counts of each answer.
- Tools, skills and MCP servers are estimates, marked with `~`: result size divided by 4, priced as one cache write. That amount is already part of the main chat.
- Counting starts when the plugin loads. Earlier messages of a resumed chat are missing.
- The cache lifetime (5 minutes or 1 hour) is not reported by the API. The plugin starts at 60 minutes and corrects itself after a pause between 6 and 55 minutes.

## License

PolyForm Strict 1.0.0. Personal and other noncommercial use is allowed. Changing the code, building on it and passing it on are not allowed. See [LICENSE](LICENSE).
