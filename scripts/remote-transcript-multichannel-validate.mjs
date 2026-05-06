#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const DEFAULT_SESSIONS = {
  discord: "agent:main:discord:direct:1113387681435623444",
  wecom: "agent:main:wecom:direct:wodqkiagaa1tl_yuk5pokzpv6b0nuxrw",
  "openclaw-weixin": "agent:main:openclaw-weixin:direct:o9cq801nwgnbegka5xk4bzn7ifyq@im.wechat",
  qqbot: "agent:main:qqbot:direct:697982e6ca86fe43c7edab6df59c3008",
  yuanbao:
    "agent:main:yuanbao:direct:dcdc1xnhb2kpww7hbbefreozzmfadxkccabgeyjrwbqwvfc1hlhzx5qq7ag0zjpq",
};

function usage() {
  console.log(`Usage: node scripts/remote-transcript-multichannel-validate.mjs [options]

Options:
  --ssh-target <host>        Remote SSH target. Default: szhdy
  --api-base <url>           ClawLens API base. Default: http://127.0.0.1:28789/plugins/clawlens/api
  --gateway-ws <url>         Remote gateway WS URL. Default: ws://127.0.0.1:18789
  --db-path <path>           Remote ClawLens DB path. Default: ~/.openclaw/clawlens/clawlens.db
  --poll-seconds <n>         Poll window per channel. Default: 90
  --poll-interval <n>        Poll interval seconds. Default: 5
  --channels <csv>           Subset of channels. Default: all
  --output-json <path>       JSON artifact path
  --output-md <path>         Markdown summary path
  --help                     Show help
`);
}

function parseArgs(argv) {
  const opts = {
    sshTarget: "szhdy",
    apiBase: "http://127.0.0.1:28789/plugins/clawlens/api",
    gatewayWs: "ws://127.0.0.1:18789",
    dbPath: "~/.openclaw/clawlens/clawlens.db",
    pollSeconds: 90,
    pollInterval: 5,
    channels: Object.keys(DEFAULT_SESSIONS),
    outputJson: `tmp/clawlens-remote-transcript-validation-${new Date().toISOString().slice(0, 10)}.json`,
    outputMd: `tmp/clawlens-remote-transcript-validation-${new Date().toISOString().slice(0, 10)}.md`,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--ssh-target":
        opts.sshTarget = argv[++i];
        break;
      case "--api-base":
        opts.apiBase = argv[++i];
        break;
      case "--gateway-ws":
        opts.gatewayWs = argv[++i];
        break;
      case "--db-path":
        opts.dbPath = argv[++i];
        break;
      case "--poll-seconds":
        opts.pollSeconds = Number(argv[++i]);
        break;
      case "--poll-interval":
        opts.pollInterval = Number(argv[++i]);
        break;
      case "--channels":
        opts.channels = argv[++i].split(",").map((item) => item.trim()).filter(Boolean);
        break;
      case "--output-json":
        opts.outputJson = argv[++i];
        break;
      case "--output-md":
        opts.outputMd = argv[++i];
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const channel of opts.channels) {
    if (!DEFAULT_SESSIONS[channel]) {
      throw new Error(`Unknown channel: ${channel}`);
    }
  }

  if (!Number.isFinite(opts.pollSeconds) || opts.pollSeconds <= 0) {
    throw new Error("--poll-seconds must be > 0");
  }
  if (!Number.isFinite(opts.pollInterval) || opts.pollInterval <= 0) {
    throw new Error("--poll-interval must be > 0");
  }

  return opts;
}

function ensureParentDir(path) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function runCommand(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    input: options.input,
    timeout: options.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(
      [`command failed: ${cmd} ${args.join(" ")}`, stderr, stdout].filter(Boolean).join("\n"),
    );
  }
  return result.stdout;
}

function remotePython(target, payload, script, timeoutMs = 60_000) {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const remoteScript = `#!/usr/bin/env bash
set -euo pipefail
source ~/.bashrc >/dev/null 2>&1 || true
export PATH="/home/openclaw/.nvm/versions/node/v24.14.0/bin:/home/openclaw/.local/share/pnpm:$PATH"
export CLAWLENS_REMOTE_PAYLOAD_B64='${payloadB64}'
python3 - <<'PY'
${script}
PY
`;
  const stdout = runCommand(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, "bash", "-s"],
    { input: remoteScript, timeoutMs },
  ).trim();
  return stdout ? JSON.parse(stdout) : null;
}

const REMOTE_SEND_SCRIPT = `
import json
import os
import pathlib
import subprocess
import sys
import uuid

payload = json.loads(__import__("base64").b64decode(os.environ["CLAWLENS_REMOTE_PAYLOAD_B64"]).decode("utf-8"))
cfg = json.loads(pathlib.Path("~/.openclaw/openclaw.json").expanduser().read_text())
token = cfg["gateway"]["auth"]["token"]
params = {
    "sessionKey": payload["sessionKey"],
    "message": payload["message"],
    "idempotencyKey": payload["idempotencyKey"],
}
cmd = [
    "/home/openclaw/.nvm/versions/node/v24.14.0/bin/openclaw",
    "gateway",
    "call",
    "chat.send",
    "--url", payload["gatewayWs"],
    "--token", token,
    "--timeout", str(payload.get("timeoutMs", 15000)),
    "--json",
    "--params", json.dumps(params, ensure_ascii=False),
]
res = subprocess.run(cmd, text=True, capture_output=True, timeout=payload.get("subprocessTimeoutSeconds", 30))
stdout = None
if res.stdout.strip():
    stdout = json.loads(res.stdout)
print(json.dumps({
    "ok": res.returncode == 0,
    "returnCode": res.returncode,
    "stdout": stdout,
    "stderr": res.stderr,
    "idempotencyKey": payload["idempotencyKey"],
}, ensure_ascii=False))
`;

const REMOTE_SNAPSHOT_SCRIPT = `
import json
import os
import pathlib
import sqlite3
import subprocess
import sys

payload = json.loads(__import__("base64").b64decode(os.environ["CLAWLENS_REMOTE_PAYLOAD_B64"]).decode("utf-8"))

cfg = json.loads(pathlib.Path("~/.openclaw/openclaw.json").expanduser().read_text())
token = cfg["gateway"]["auth"]["token"]
session_key = payload["sessionKey"]
marker = payload["marker"]
db_path = pathlib.Path(os.path.expanduser(payload["dbPath"]))

def gateway_call(method, params, timeout_ms=12000, subprocess_timeout=30):
    cmd = [
        "/home/openclaw/.nvm/versions/node/v24.14.0/bin/openclaw",
        "gateway",
        "call",
        method,
        "--url", payload["gatewayWs"],
        "--token", token,
        "--timeout", str(timeout_ms),
        "--json",
        "--params", json.dumps(params, ensure_ascii=False),
    ]
    res = subprocess.run(cmd, text=True, capture_output=True, timeout=subprocess_timeout)
    out = None
    if res.stdout.strip():
        out = json.loads(res.stdout)
    return {
        "ok": res.returncode == 0,
        "returnCode": res.returncode,
        "stdout": out,
        "stderr": res.stderr,
    }

history_call = gateway_call("chat.history", {"sessionKey": session_key, "limit": 12})
history_payload = history_call["stdout"] or {}
session_id = history_payload.get("sessionId")

messages = history_payload.get("messages") if isinstance(history_payload.get("messages"), list) else []
marker_message_indexes = []
assistant_after_marker = 0
for idx, message in enumerate(messages):
    text_fragments = []
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                text_fragments.append(item["text"])
    combined = "\\n".join(text_fragments)
    if marker in combined:
        marker_message_indexes.append(idx)
if marker_message_indexes:
    first_marker_idx = marker_message_indexes[0]
    assistant_after_marker = sum(
        1 for message in messages[first_marker_idx + 1:]
        if isinstance(message, dict) and message.get("role") == "assistant"
    )
else:
    first_marker_idx = None

session_file = None
if isinstance(session_id, str) and session_id:
    session_file = pathlib.Path(f"~/.openclaw/agents/main/sessions/{session_id}.jsonl").expanduser()

session_file_summary = {
    "path": str(session_file) if session_file else None,
    "exists": bool(session_file and session_file.exists()),
    "markerFound": False,
    "markerRawMatchCount": 0,
    "assistantAfterMarker": False,
    "totalLines": 0,
    "mtimeMs": None,
    "markerRawPreview": [],
}

if session_file and session_file.exists():
    raw_lines = session_file.read_text(errors="replace").splitlines()
    session_file_summary["totalLines"] = len(raw_lines)
    session_file_summary["mtimeMs"] = int(session_file.stat().st_mtime * 1000)
    marker_indexes = [idx for idx, line in enumerate(raw_lines) if marker in line]
    session_file_summary["markerFound"] = bool(marker_indexes)
    session_file_summary["markerRawMatchCount"] = len(marker_indexes)
    if marker_indexes:
        marker_idx = marker_indexes[0]
        session_file_summary["markerRawPreview"] = raw_lines[max(0, marker_idx - 1): marker_idx + 3]
        for line in raw_lines[marker_idx + 1:]:
            if '"role":"assistant"' in line or '"role": "assistant"' in line:
                session_file_summary["assistantAfterMarker"] = True
                break

db_summary = {
    "exists": db_path.exists(),
    "recentRuns": [],
    "recentTurns": [],
    "markerTurnsSession": [],
    "markerTurnsAnySession": [],
    "latestRunTurnCount": 0,
    "latestRunTurns": [],
    "latestRunPromptPreview": None,
}

if db_path.exists():
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    db_summary["recentRuns"] = [
        dict(row) for row in cur.execute(
            """
            SELECT run_id, session_key, started_at, status, total_llm_calls, total_tool_calls
            FROM runs
            WHERE session_key = ?
            ORDER BY started_at DESC
            LIMIT 3
            """,
            (session_key,),
        ).fetchall()
    ]
    db_summary["recentTurns"] = [
        dict(row) for row in cur.execute(
            """
            SELECT run_id, role, message_id, source_kind, timestamp, session_file, content_preview
            FROM conversation_turns
            WHERE session_key = ?
            ORDER BY COALESCE(timestamp, 0) DESC, id DESC
            LIMIT 6
            """,
            (session_key,),
        ).fetchall()
    ]
    like = f"%{marker}%"
    db_summary["markerTurnsSession"] = [
        dict(row) for row in cur.execute(
            """
            SELECT session_key, run_id, role, message_id, source_kind, timestamp, session_file, content_preview
            FROM conversation_turns
            WHERE session_key = ? AND content_preview LIKE ?
            ORDER BY COALESCE(timestamp, 0) DESC, id DESC
            LIMIT 10
            """,
            (session_key, like),
        ).fetchall()
    ]
    db_summary["markerTurnsAnySession"] = [
        dict(row) for row in cur.execute(
            """
            SELECT session_key, run_id, role, message_id, source_kind, timestamp, session_file, content_preview
            FROM conversation_turns
            WHERE content_preview LIKE ?
            ORDER BY COALESCE(timestamp, 0) DESC, id DESC
            LIMIT 10
            """,
            (like,),
        ).fetchall()
    ]
    latest_run = db_summary["recentRuns"][0] if db_summary["recentRuns"] else None
    if latest_run:
        latest_run_id = latest_run["run_id"]
        db_summary["latestRunTurnCount"] = cur.execute(
            "SELECT COUNT(*) FROM conversation_turns WHERE run_id = ?",
            (latest_run_id,),
        ).fetchone()[0]
        db_summary["latestRunTurns"] = [
            dict(row) for row in cur.execute(
                """
                SELECT run_id, role, message_id, source_kind, timestamp, session_file, content_preview
                FROM conversation_turns
                WHERE run_id = ?
                ORDER BY turn_index ASC
                LIMIT 10
                """,
                (latest_run_id,),
            ).fetchall()
        ]
        prompt_row = cur.execute(
            """
            SELECT user_prompt_preview
            FROM llm_calls
            WHERE run_id = ? AND user_prompt_preview IS NOT NULL AND TRIM(user_prompt_preview) != ''
            ORDER BY started_at ASC
            LIMIT 1
            """,
            (latest_run_id,),
        ).fetchone()
        db_summary["latestRunPromptPreview"] = prompt_row[0] if prompt_row else None
    conn.close()

print(json.dumps({
    "historyCall": history_call,
    "historySummary": {
        "sessionId": session_id,
        "messageCount": len(messages),
        "markerFound": bool(marker_message_indexes),
        "markerMessageIndexes": marker_message_indexes,
        "assistantMessagesAfterMarker": assistant_after_marker,
        "latestMessages": messages[-4:],
    },
    "sessionFile": session_file_summary,
    "db": db_summary,
}, ensure_ascii=False))
`;

async function fetchJson(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await sleep(500 * attempt);
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchApiSnapshot(apiBase, sessionKey) {
  const encoded = encodeURIComponent(sessionKey);
  const [audit, requireConversation, currentMessageRun] = await Promise.all([
    fetchJson(`${apiBase}/audit/session/${encoded}?limit=3&compact=0&excludeKinds=heartbeat`),
    fetchJson(
      `${apiBase}/audit/session/${encoded}?limit=3&compact=0&excludeKinds=heartbeat&requireConversation=1`,
    ),
    fetchJson(`${apiBase}/audit/session/${encoded}/current-message-run`),
  ]);
  return {
    audit,
    requireConversation,
    currentMessageRun,
  };
}

function compactApiSnapshot(snapshot) {
  const runs = Array.isArray(snapshot?.audit?.runs) ? snapshot.audit.runs : [];
  const requireRuns = Array.isArray(snapshot?.requireConversation?.runs)
    ? snapshot.requireConversation.runs
    : [];
  return {
    auditRunIds: runs.map((run) => run.runId),
    auditTopRun: runs[0]
      ? {
          runId: runs[0].runId,
          status: runs[0].status,
          startedAt: runs[0].startedAt,
          turnCount: Array.isArray(runs[0].turns) ? runs[0].turns.length : 0,
        }
      : null,
    requireConversationRunIds: requireRuns.map((run) => run.runId),
    currentMessageRun: snapshot?.currentMessageRun ?? null,
  };
}

function findRunId(run) {
  return typeof run?.runId === "string" ? run.runId : null;
}

function classifyChannel(result) {
  const baselineTopRunId = findRunId(result.baseline.api?.audit?.runs?.[0]);
  const finalTopRunId = findRunId(result.final.api?.audit?.runs?.[0]);
  const finalTopRunStartedAt = result.final.api?.audit?.runs?.[0]?.startedAt ?? null;
  const baselineTopRunStartedAt = result.baseline.api?.audit?.runs?.[0]?.startedAt ?? null;
  const sendRunId = result.send?.stdout?.runId ?? result.send?.stdout?.payload?.runId ?? null;
  const current = result.final.api?.currentMessageRun ?? {};
  const latestRunId = finalTopRunId ?? sendRunId;
  const latestRunTurnCount = Number(result.final.remote?.db?.latestRunTurnCount ?? 0);
  const markerTurnsSession = Array.isArray(result.final.remote?.db?.markerTurnsSession)
    ? result.final.remote.db.markerTurnsSession
    : [];
  const markerTurnsAny = Array.isArray(result.final.remote?.db?.markerTurnsAnySession)
    ? result.final.remote.db.markerTurnsAnySession
    : [];
  const sessionHasMarker =
    result.final.remote?.sessionFile?.markerFound === true ||
    result.final.remote?.historySummary?.markerFound === true;
  const sendRunSeen =
    typeof sendRunId === "string" &&
    [
      ...(result.final.api?.audit?.runs ?? []).map((run) => run?.runId),
      ...(result.final.remote?.db?.recentRuns ?? []).map((run) => run?.run_id),
    ].includes(sendRunId);
  const runObserved =
    sendRunSeen ||
    (typeof finalTopRunId === "string" &&
      finalTopRunId !== baselineTopRunId &&
      typeof finalTopRunStartedAt === "number" &&
      (typeof baselineTopRunStartedAt !== "number" || finalTopRunStartedAt > baselineTopRunStartedAt));
  const requireConversationVisible = (result.final.api?.requireConversation?.runs ?? []).some(
    (run) => run?.runId === latestRunId,
  );
  const currentStatus = current?.status ?? "none";
  const bindingStatus = `${currentStatus}/${current?.lookupBasis ?? "unknown"}${
    current?.matchedTurn?.sourceKind ? `/${current.matchedTurn.sourceKind}` : ""
  }`;
  const panelVisibilityImpact = latestRunId
    ? requireConversationVisible
      ? "visible"
      : "hidden by requireConversation=1"
    : "no latest run";

  let verdict = "PARTIAL";
  if (!sessionHasMarker) {
    verdict = "FAIL-NO-TRANSCRIPT";
  } else if (!runObserved) {
    verdict = "FAIL-NO-RUN";
  } else if (latestRunTurnCount === 0 && markerTurnsSession.length === 0) {
    verdict = "FAIL-RUN-ONLY";
  } else if (currentStatus === "resolved" && current?.run?.runId === latestRunId) {
    verdict = "PASS";
  } else {
    verdict = "PARTIAL";
  }

  return {
    verdict,
    sessionHasMarker,
    runObserved,
    sendRunId,
    latestRunId,
    latestRunTurnCount,
    latestTurn:
      markerTurnsSession[0] ??
      result.final.remote?.db?.recentTurns?.[0] ??
      null,
    bindingStatus,
    panelVisibilityImpact,
    requireConversationVisible,
    currentMessageRunStatus: currentStatus,
    markerTurnsAnySession: markerTurnsAny,
  };
}

function formatMarkdownReport(report) {
  const lines = [];
  lines.push(`# ClawLens Remote Multi-Channel Transcript Validation`);
  lines.push("");
  lines.push(`- Generated at: ${report.generatedAt}`);
  lines.push(`- SSH target: ${report.config.sshTarget}`);
  lines.push(`- API base: ${report.config.apiBase}`);
  lines.push(`- Poll window: ${report.config.pollSeconds}s every ${report.config.pollInterval}s`);
  lines.push("");
  lines.push(`| Channel | Verdict | Session file | Latest run | Latest turn | Binding status | Panel visibility |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const channel of report.channels) {
    const latestTurn = channel.classification.latestTurn;
    lines.push(
      `| ${channel.channel} | ${channel.classification.verdict} | ${
        channel.final.remote?.sessionFile?.path ?? "n/a"
      } | ${channel.classification.latestRunId ?? "n/a"} | ${
        latestTurn ? `${latestTurn.role ?? "?"}/${latestTurn.message_id ?? latestTurn.messageId ?? "no-message-id"}` : "n/a"
      } | ${channel.classification.bindingStatus} | ${channel.classification.panelVisibilityImpact} |`,
    );
  }
  lines.push("");
  for (const channel of report.channels) {
    lines.push(`## ${channel.channel}`);
    lines.push("");
    lines.push(`- Session key: \`${channel.sessionKey}\``);
    lines.push(`- Marker: \`${channel.marker}\``);
    lines.push(`- Verdict: \`${channel.classification.verdict}\``);
    lines.push(`- Send run id: \`${channel.classification.sendRunId ?? "n/a"}\``);
    lines.push(`- Latest run id: \`${channel.classification.latestRunId ?? "n/a"}\``);
    lines.push(`- Binding status: \`${channel.classification.bindingStatus}\``);
    lines.push(`- Panel visibility: \`${channel.classification.panelVisibilityImpact}\``);
    lines.push(
      `- Session transcript marker found: \`${String(channel.classification.sessionHasMarker)}\`; run observed: \`${String(channel.classification.runObserved)}\`; latest run turn count: \`${channel.classification.latestRunTurnCount}\``,
    );
    if (channel.classification.verdict === "FAIL-RUN-ONLY") {
      const misbound = channel.classification.markerTurnsAnySession
        .filter((row) => row.session_key !== channel.sessionKey)
        .map((row) => `${row.session_key}:${row.run_id}:${row.role}`)
        .join(", ");
      lines.push(`- Misbound marker turns in other sessions: ${misbound || "none observed"}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = {
    generatedAt: new Date().toISOString(),
    config: opts,
    channels: [],
  };

  for (const channel of opts.channels) {
    const sessionKey = DEFAULT_SESSIONS[channel];
    const marker = `CLAWLENS_TRANSCRIPT_TEST ${channel} ${new Date().toISOString()} ${randomUUID().slice(0, 8)}`;
    const idempotencyKey = `clawlens-transcript-${channel}-${randomUUID()}`;
    try {
      console.error(`[${channel}] baseline snapshot`);
      const baselineApi = await fetchApiSnapshot(opts.apiBase, sessionKey);
      const baselineRemote = remotePython(
        opts.sshTarget,
        {
          sessionKey,
          marker,
          gatewayWs: opts.gatewayWs,
          dbPath: opts.dbPath,
        },
        REMOTE_SNAPSHOT_SCRIPT,
        90_000,
      );

      console.error(`[${channel}] send marker`);
      const send = remotePython(
        opts.sshTarget,
        {
          sessionKey,
          message: marker,
          idempotencyKey,
          gatewayWs: opts.gatewayWs,
          timeoutMs: 15000,
          subprocessTimeoutSeconds: 30,
        },
        REMOTE_SEND_SCRIPT,
        90_000,
      );

      const polls = [];
      const deadline = Date.now() + opts.pollSeconds * 1000;
      while (true) {
        console.error(`[${channel}] polling`);
        const [api, remote] = await Promise.all([
          fetchApiSnapshot(opts.apiBase, sessionKey),
          Promise.resolve(
            remotePython(
              opts.sshTarget,
              {
                sessionKey,
                marker,
                gatewayWs: opts.gatewayWs,
                dbPath: opts.dbPath,
              },
              REMOTE_SNAPSHOT_SCRIPT,
              90_000,
            ),
          ),
        ]);
        polls.push({
          at: new Date().toISOString(),
          api: compactApiSnapshot(api),
          remote: {
            historySummary: remote.historySummary,
            sessionFile: remote.sessionFile,
            recentRuns: remote.db?.recentRuns ?? [],
            recentTurns: remote.db?.recentTurns ?? [],
            markerTurnsSession: remote.db?.markerTurnsSession ?? [],
            latestRunTurnCount: remote.db?.latestRunTurnCount ?? 0,
          },
        });

        const latestRunId = findRunId(api?.audit?.runs?.[0]) ?? null;
        const markerTurnsSession = remote?.db?.markerTurnsSession ?? [];
        const currentStatus = api?.currentMessageRun?.status ?? "none";
        const shouldStop =
          (remote?.sessionFile?.markerFound === true || remote?.historySummary?.markerFound === true) &&
          (typeof latestRunId === "string" || typeof send?.stdout?.runId === "string") &&
          ((currentStatus === "resolved" && markerTurnsSession.length > 0) || Date.now() >= deadline);
        if (shouldStop || Date.now() >= deadline) {
          break;
        }
        await sleep(opts.pollInterval * 1000);
      }

      const finalApi = await fetchApiSnapshot(opts.apiBase, sessionKey);
      const finalRemote = remotePython(
        opts.sshTarget,
        {
          sessionKey,
          marker,
          gatewayWs: opts.gatewayWs,
          dbPath: opts.dbPath,
        },
        REMOTE_SNAPSHOT_SCRIPT,
        90_000,
      );

      const channelResult = {
        channel,
        sessionKey,
        marker,
        idempotencyKey,
        baseline: {
          api: baselineApi,
          remote: baselineRemote,
        },
        send,
        polls,
        final: {
          api: finalApi,
          remote: finalRemote,
        },
      };
      channelResult.classification = classifyChannel(channelResult);
      report.channels.push(channelResult);
      console.error(`[${channel}] ${channelResult.classification.verdict}`);
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      report.channels.push({
        channel,
        sessionKey,
        marker,
        idempotencyKey,
        error: message,
        classification: {
          verdict: "SCRIPT-ERROR",
          latestRunId: null,
          bindingStatus: "error",
          panelVisibilityImpact: "unknown",
        },
      });
      console.error(`[${channel}] SCRIPT-ERROR`);
      console.error(message);
    }
  }

  ensureParentDir(opts.outputJson);
  ensureParentDir(opts.outputMd);
  writeFileSync(resolve(opts.outputJson), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(opts.outputMd), formatMarkdownReport(report));

  const summary = report.channels.map((channel) => ({
    channel: channel.channel,
    verdict: channel.classification.verdict,
    latestRunId: channel.classification.latestRunId,
    bindingStatus: channel.classification.bindingStatus,
    panelVisibilityImpact: channel.classification.panelVisibilityImpact,
  }));
  console.log(JSON.stringify({ ok: true, outputJson: resolve(opts.outputJson), outputMd: resolve(opts.outputMd), summary }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
