# ClawLens

An audit plugin for [OpenClaw](https://github.com/openclaw/openclaw) that provides per-run execution tracing, cost verification, and multi-model comparison — capabilities the built-in Usage view doesn't offer.

## Why ClawLens?

OpenClaw's Usage view already tracks session-level token counts, cost breakdowns, daily trends, and conversation logs. ClawLens doesn't duplicate any of that. Instead, it answers questions the official view can't:

- **What happened inside a single run?** — When a user message triggers 3 LLM calls and 2 tool executions, the Usage view shows only the aggregate. ClawLens shows the full waterfall: LLM → tool → LLM → tool → LLM, with per-step tokens, cost, and duration.

- **Is the cost data accurate?** — ClawLens captures both the cost returned by the LLM provider (via pi-ai) and an independently calculated cost using OpenClaw's own pricing config. If they differ, ClawLens flags the discrepancy and explains why.

- **Are different channels getting different system prompts?** — ClawLens hashes the system prompt on every LLM call and detects when the same agent sends different prompts to the same model across channels.

- **How do models compare on the same task?** — ClawLens can intercept a user message and fan it out to multiple models in parallel, recording a side-by-side comparison of their tool usage, token consumption, and results.

## Architecture

```
┌───────────────────────────────────────────────┐
│              OpenClaw Gateway                  │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │           ClawLens Plugin               │  │
│  │                                         │  │
│  │  Collector ──→ Store (SQLite)           │  │
│  │  Comparator        ↓                    │  │
│  │  SSE Manager ←── API Routes             │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│  Control UI ←── inject.js (audit sidebar)     │
└───────────────────────────────────────────────┘
```

### Data Collection

| Source | Granularity | What it captures |
|--------|-------------|-----------------|
| `onSessionTranscriptUpdate` | per-LLM-call | Token usage + cost per individual model call (waterfall data) |
| `onAgentEvent` | per-run | Run lifecycle — start, end, error, duration |
| `api.on("llm_input")` | per-LLM-call | System prompt hash, user prompt preview |
| `api.on("after_tool_call")` | per-tool-call | Tool name, params, result, duration, errors |
| `api.on("agent_end")` | per-run | Full conversation turn chain |
| `api.on("llm_output")` | per-run | Cumulative run usage (for overview totals) |

### Three-Tier Data Model

Every data point in the UI is labeled with its source:

| Label | Color | Meaning |
|-------|-------|---------|
| `OFFICIAL` | Gray | Same data source as the built-in Usage view (identical `message.usage` object) |
| `CALCULATED` | Blue | ClawLens independently re-calculates cost using OpenClaw's 3-layer pricing fallback |
| `EXCLUSIVE` | Teal | Data the Usage view doesn't have at all (waterfall, tool details, system prompt diff) |

When OFFICIAL and CALCULATED costs match (within 0.1%), a green checkmark appears. When they differ, a yellow warning shows the reason (e.g., pi-ai built-in pricing vs. user-configured pricing).

## Features

### Per-Run Audit Waterfall

Injected as a sidebar in the Chat view. Each user message maps to a Run card showing:

```
#1 Run                                    6.8s
帮我搜索今天的新闻并写个摘要
4,800 tok  OFFICIAL    $0.0150  OFFICIAL
                       $0.0148  CALCULATED  ≈ ✓
2 LLM · 1 tool

TIMELINE  EXCLUSIVE
|■■■LLM 1.2s■■■|  |■■■■tool 3.5s■■■■|  |■■LLM 2.1s■■|

TURNS
  user       帮我搜索今天的新闻并写个摘要
  assistant  我来帮你搜索...[tool_call: web_search]
  tool       web_search → 5 results
  assistant  以下是今天的新闻摘要...
```

### Cost Verification

ClawLens stores two cost values for every LLM call:

- **`official_cost`** — Extracted directly from `message.usage.cost.total` (calculated by pi-ai using its built-in pricing table)
- **`calculated_cost`** — Re-calculated by ClawLens using `resolveModelCostConfig()` with the full 3-layer fallback (models.json → user config → gateway pricing cache)

This catches pricing mismatches that would otherwise go unnoticed.

### Multi-Model Comparison (Module B)

When enabled, intercepts user messages on specified channels and runs the same prompt through multiple models in parallel:

```yaml
clawlens:
  compare:
    enabled: true
    models:
      - provider: anthropic
        model: claude-sonnet-4-20250514
      - provider: openai
        model: gpt-4o
      - provider: google
        model: gemini-2.5-flash
    channels: ["telegram"]
```

### System Prompt Diff Detection

Hashes the system prompt on every `llm_input` event. Detects when:
- Different channels inject different system prompts for the same agent
- System prompts change between runs in the same session
- A compaction or reset altered the effective system prompt

## Installation

ClawLens is an OpenClaw extension. No build step required — `.ts` files are loaded directly.

```bash
# Copy to extensions directory
cp -r clawlens/ ~/.openclaw/extensions/clawlens/

# Register in config
openclaw config set plugins.installs.clawlens.source path
openclaw config set plugins.installs.clawlens.spec ~/.openclaw/extensions/clawlens

# Restart gateway
openclaw gateway restart

# Verify
curl -s http://localhost:18789/plugins/clawlens/api/overview
```

## API

| Endpoint | Description |
|----------|-------------|
| `GET /plugins/clawlens/api/overview` | Global stats: active runs, 24h totals |
| `GET /plugins/clawlens/api/audit/session/:key` | Full audit data for a session — all runs with waterfall + turns |
| `GET /plugins/clawlens/api/audit/run/:id` | Single run audit detail |
| `GET /plugins/clawlens/api/events?token=...` | SSE stream for real-time updates |

## Compatibility

- **OpenClaw**: v2026.3.22+ (verified through v2026.3.23-2, no breaking changes)
- **Node.js**: 22.16+ (24 recommended)
- **Storage**: SQLite via `node:sqlite` (Node built-in, no npm dependencies)

## Project Documents

| Document | Description |
|----------|-------------|
| [analysis-raw.md](docs/analysis-raw.md) | OpenClaw source code analysis — call chains, hooks, data structures |
| [architecture.md](docs/architecture.md) | ClawLens architecture design with data consistency proofs |
| [claude-code-prompt.md](docs/claude-code-prompt.md) | Implementation prompt for creating ClawLens from scratch |
| [claude-code-prompt-update.md](docs/claude-code-prompt-update.md) | Incremental prompt for adding audit view to existing codebase |
| [clawlens-usage.md](docs/clawlens-usage.md) | End-user UI documentation |

## How This Project Was Built

ClawLens was designed entirely through conversation with Claude (Anthropic), including:

- Deep source code analysis of OpenClaw v2026.3.22 internals
- Architecture design with full data consistency proofs against the official Usage view
- Discovery that `llm_output` hook fires once per-run (not per-call), leading to the `onSessionTranscriptUpdate` approach
- Discovery that pi-ai embeds cost calculations in `message.usage.cost`, enabling dual-cost verification
- UI mockup design using OpenClaw's actual CSS variables and layout patterns
- Version compatibility analysis across 3.22 → 3.23 → 3.23-2

The implementation prompts in `docs/` are designed to be fed directly to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) for automated code generation and deployment.

## License

MIT
