# ClawLens

ClawLens is an [OpenClaw](https://github.com/openclaw/openclaw) audit plugin focused on run-level visibility. It adds a Chat-side Audit panel, per-run execution detail, message-to-run lookup, heartbeat separation, and logger-based message mapping that the built-in Usage view does not provide.

## What It Does

ClawLens is built around one question:

- when a single chat message triggers one run, what exactly happened inside that run?

Current capabilities include:

- Run-level audit cards in Chat
- Timeline and turns for each run
- `current-message-run` lookup for the latest chat message
- Separation of normal chat runs and heartbeat/background runs
- Live refresh for current runs while the panel is open
- SSE updates for run lifecycle, LLM calls, tool execution, and transcript turns
- Optional logger import for `message_id -> runId` mapping enrichment
- Dual-cost display support from stored official/calculated totals

## Current Architecture

```text
OpenClaw runtime/hooks
  -> Collector
  -> Store (SQLite)
  -> API routes / SSE
  -> Chat-side injected Audit UI

Optional side path:
llm-api-logger files
  -> logger-message-mapper
  -> logger-import
  -> Store source upgrade / message mapping enrichment
```

Core modules:

- `extensions/clawlens/src/collector.ts`
  collects lifecycle, transcript, llm, and tool events
- `extensions/clawlens/src/store.ts`
  persists runs, turns, llm calls, tool executions, logger import state
- `extensions/clawlens/src/api-routes.ts`
  serves audit/session/run/message/import endpoints
- `extensions/clawlens/ui/inject.js`
  injects the Audit sidebar into OpenClaw Chat
- `extensions/clawlens/ui/styles.css`
  styles the sidebar and host-layout offset

## Data Sources

ClawLens currently uses these OpenClaw/plugin sources:

- `api.runtime.events.onAgentEvent`
  run lifecycle start/end/error
- `api.runtime.events.onSessionTranscriptUpdate`
  transcript turn capture and message-level indexing
- `api.on("llm_input")`
  prompt preview and run kind classification
- `api.on("llm_output")`
  LLM call detail
- `api.on("after_tool_call")`
  tool execution detail
- `api.on("agent_end")`
  end-of-run fallback conversation capture

Important behavior notes:

- transcript turns and run detail are not derived from a single source; they are merged
- heartbeat traffic is treated as a separate run kind and excluded from chat-facing audit queries by default
- logger import is optional and exists to strengthen `message_id -> runId` mapping, not to make the base audit UI work
- OpenClaw reference code is kept as a local reference checkout under `projects-ref/openclaw/` and is not a runtime dependency or hard repository binding

## API

Current plugin routes:

- `GET /plugins/clawlens/api/overview`
- `GET /plugins/clawlens/api/sessions`
- `GET /plugins/clawlens/api/run/:runId`
- `GET /plugins/clawlens/api/audit`
- `GET /plugins/clawlens/api/audit/run/:runId`
- `GET /plugins/clawlens/api/audit/message/:messageId`
- `GET /plugins/clawlens/api/audit/session/:sessionKey`
- `GET /plugins/clawlens/api/audit/session/:sessionKey/current-message-run`
- `POST /plugins/clawlens/api/audit/logger/import`
- `GET /plugins/clawlens/api/events?token=...`

Useful query options on `audit/session/:sessionKey`:

- `limit`
- `before`
- `since`
- `compact=1`
- `excludeKinds=heartbeat`
- `requireConversation=1`

## Configuration

Plugin config schema currently supports:

```json
{
  "collector": {
    "enabled": true,
    "snapshotIntervalMs": 60000,
    "retentionDays": 30,
    "debugLogs": false,
    "loggerImportDir": "/path/to/logger-dir",
    "loggerImportMaxFileSizeMb": 100
  },
  "compare": {
    "enabled": false,
    "models": [
      { "provider": "anthropic", "model": "claude-sonnet-4-20250514" }
    ],
    "channels": ["telegram"],
    "timeoutMs": 300000,
    "maxConcurrent": 3
  }
}
```

Notes:

- `collector.debugLogs` enables structured debug logging for collector/store paths
- `collector.loggerImportDir` enables startup-time logger import attempts
- `collector.loggerImportMaxFileSizeMb` protects against oversized logger files

## Installation

ClawLens is loaded as an OpenClaw extension from source files.

```bash
cp -r extensions/clawlens ~/.openclaw/extensions/clawlens

openclaw config set plugins.installs.clawlens.source path
openclaw config set plugins.installs.clawlens.spec ~/.openclaw/extensions/clawlens

openclaw gateway restart

curl -s http://localhost:18789/plugins/clawlens/api/overview
```

If you use logger import, also configure:

```bash
openclaw config set plugins.config.clawlens.collector.loggerImportDir /path/to/logger-dir
openclaw config set plugins.config.clawlens.collector.loggerImportMaxFileSizeMb 100
```

## Compatibility

- Node.js: `22.5.0+`
- Storage: `node:sqlite`
- OpenClaw: current code targets the plugin/runtime APIs used in this repository snapshot

If Node is below `22.5.0`, ClawLens now fails fast during plugin registration.

## Document Map

Recommended current-entry documents:

- [architecture.md](docs/architecture.md) — current architecture authority
- [clawlens-usage.md](docs/clawlens-usage.md)
- [PROMPT_IMPLEMENTATION.md](docs/PROMPT_IMPLEMENTATION.md)
- [ANALYSIS_CHAT_AUDIT.md](docs/ANALYSIS_CHAT_AUDIT.md)
- [ANALYSIS_CHAT_AUDIT_ENHANCEMENTS.md](docs/ANALYSIS_CHAT_AUDIT_ENHANCEMENTS.md)
- [ANALYSIS_LLM_API_LOGGER_MESSAGE_MAPPING.md](docs/ANALYSIS_LLM_API_LOGGER_MESSAGE_MAPPING.md)
- [PLAYBOOK_ENGINEERING_LESSONS.md](docs/PLAYBOOK_ENGINEERING_LESSONS.md)
- [GOVERNANCE_DOCS_PLAN.md](docs/GOVERNANCE_DOCS_PLAN.md)
- [archive/history/README.md](docs/archive/history/README.md)

Prompt / analysis playbooks:

- [PLAYBOOK_ANALYSIS_PROMPT.md](docs/PLAYBOOK_ANALYSIS_PROMPT.md)
- [ANALYSIS_PROMPT_PLAYBOOK_GENERAL.md](docs/prompts/ANALYSIS_PROMPT_PLAYBOOK_GENERAL.md)
- [ANALYSIS_PROMPT_PLAYBOOK_DOC_REVIEW.md](docs/prompts/ANALYSIS_PROMPT_PLAYBOOK_DOC_REVIEW.md)
- [ANALYSIS_PROMPT_PLAYBOOK_DEBUG.md](docs/prompts/ANALYSIS_PROMPT_PLAYBOOK_DEBUG.md)

Current discussion / pending-plan area:

- [plans/README.md](docs/plans/README.md)
- [ANALYSIS_CODEX_COLLABORATION_WORKFLOW_2026-04-03.md](docs/plans/ANALYSIS_CODEX_COLLABORATION_WORKFLOW_2026-04-03.md)
- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](docs/plans/ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](docs/plans/IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_PR_WORKFLOW_2026-04-03.md](docs/plans/IMPLEMENTATION_OPENCLAW_PR_WORKFLOW_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_REMOTE_DEBUG_PATCH_WORKFLOW_2026-04-03.md](docs/plans/IMPLEMENTATION_OPENCLAW_REMOTE_DEBUG_PATCH_WORKFLOW_2026-04-03.md)

Current research references:

- [research/README.md](docs/research/README.md)
- [RESEARCH_OPENCLAW_TOOL_CALL_FLOW.md](docs/research/RESEARCH_OPENCLAW_TOOL_CALL_FLOW.md)
- [RESEARCH_OPENCLAW_CLI_PLUGINS_LIST_FLOW.md](docs/research/RESEARCH_OPENCLAW_CLI_PLUGINS_LIST_FLOW.md)
- [ANALYSIS_OPENCLAW_CLI_PHANTOM_READ.md](docs/research/ANALYSIS_OPENCLAW_CLI_PHANTOM_READ.md)
- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](docs/research/RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md](docs/research/RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md)
- [ANALYSIS_OPENCLAW_SESSION_POLLUTION_FIX_PROPOSAL.md](docs/research/ANALYSIS_OPENCLAW_SESSION_POLLUTION_FIX_PROPOSAL.md)

Maintenance helper:

- `bash scripts/update-openclaw-reference-version.sh`
  updates the OpenClaw reference version line in `docs/architecture.md` from the local `projects-ref/openclaw/` checkout

## Current Status

The main Chat Audit path is working:

- latest message to current run lookup
- run detail capture
- turns rendering
- heartbeat/chat separation in chat-facing audit queries
- logger import entrypoint and idempotent import state

Long-term Chat Audit enhancement work is tracked in:

- [ANALYSIS_CHAT_AUDIT_ENHANCEMENTS.md](docs/ANALYSIS_CHAT_AUDIT_ENHANCEMENTS.md)
- [CHAT_AUDIT_REMAINING_WORK_HISTORY.md](docs/archive/history/CHAT_AUDIT_REMAINING_WORK_HISTORY.md)

## License

MIT
