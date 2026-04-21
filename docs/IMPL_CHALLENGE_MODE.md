---
status: active
created: 2026-04-21
updated: 2026-04-21
---

# 实施方案：challenge-mode 双模式切换 + Gemini ✦ 前缀修复

## 概述

本次需要修改两个文件：

1. `scripts/gemini-tmux-control.mjs` — 修复 `✦ ` 前缀未剥离导致回合句无法解析的 bug
2. `scripts/robo-squat-launch.mjs` — 增加 `--challenge-mode gamemaster|distributed` 参数

**不得修改其他文件。不得引入新依赖。保持 ESM 风格。**

---

## 文件一：`scripts/gemini-tmux-control.mjs`

### 问题

`extractResponseMeta`（第 364 行）在 `input_block` 方法下，以第一个 `✦ ` 开头的行作为响应起点（`splitIdx = i`），但后续提取 `responseLines` 时**未剥离 `✦ ` 前缀**，导致最终文本是 `✦ gemini1蹲gemini1蹲，gemini1蹲完cc1蹲`，`parseTurn` 无法匹配。

### 修改位置：第 430-434 行

**原代码：**
```js
  return {
    method,
    text: responseLines.join("\n").trim(),
  };
```

**改为：**
```js
  const joined = responseLines
    .map((line) => (line.startsWith("✦ ") ? line.slice(2) : line))
    .join("\n")
    .trim();
  return {
    method,
    text: joined,
  };
```

**说明：** 仅剥离每行开头的 `✦ ` 两个字符（U+2726 + 空格）。其他行不受影响。

---

## 文件二：`scripts/robo-squat-launch.mjs`

### 改动清单（按顺序）

---

### 改动 A：文件顶部新增两个常量（在 `DEFAULTS` 之前插入）

在第 16 行 `const DEFAULTS = {` **之前**插入：

```js
const CHALLENGE_MODES = Object.freeze({
  GAMEMASTER: "gamemaster",
  DISTRIBUTED: "distributed",
});

const GAME_MASTER = Object.freeze({ name: "game-master", rank: 0, role: "launcher" });
```

---

### 改动 B：`DEFAULTS` 新增字段

在 `DEFAULTS` 对象（第 16-27 行）的 `clearFirst: true,` 后面添加：

```js
  challengeMode: CHALLENGE_MODES.GAMEMASTER,
```

---

### 改动 C：`usage()` 函数新增一行说明

在 `usage()` 的 options 列表末尾（`--help` 行前）新增：

```
  --challenge-mode <mode>   Challenge policy: gamemaster (default) | distributed
```

---

### 改动 D：`parseArgs()` 新增参数解析和校验

**位置 1**：在 `for` 循环内（约第 74 行 `--no-clear-first` 之后、`--help` 之前）新增：

```js
    if (arg === "--challenge-mode") { opts.challengeMode = String(argv[++i] ?? "").trim().toLowerCase(); continue; }
```

**位置 2**：在末尾校验区（约第 89 行 `bufferLines` 校验之后）新增：

```js
  const validModes = new Set(Object.values(CHALLENGE_MODES));
  if (!validModes.has(opts.challengeMode)) {
    throw new Error(
      `--challenge-mode must be one of: ${[...validModes].join(", ")} (got ${JSON.stringify(opts.challengeMode)})`
    );
  }
```

---

### 改动 E：`buildChallengeBroadcast` 新增 `mode` 参数

**原签名（第 296 行）：**
```js
export function buildChallengeBroadcast(round, reporter, offender, recipients, reason, deadline) {
  return [
    `[robo-squat challenge round=${round} reporter=${reporter.name} offender=${offender.name} audience=${recipients.map((entry) => entry.name).join(",")} deadline=${deadline}]`,
    `质疑: round=${round} reporter=${reporter.name} offender=${offender.name} reason=${reason}`,
  ].join("\n");
}
```

**改为：**
```js
export function buildChallengeBroadcast(round, reporter, offender, recipients, reason, deadline, mode = "distributed") {
  return [
    `[robo-squat challenge round=${round} mode=${mode} reporter=${reporter.name} offender=${offender.name} audience=${recipients.map((entry) => entry.name).join(",")} deadline=${deadline}]`,
    `质疑: round=${round} mode=${mode} reporter=${reporter.name} offender=${offender.name} reason=${reason}`,
  ].join("\n");
}
```

---

### 改动 F：`buildBootstrapPrompt` 新增 `challengeMode` 参数并按模式生成不同规则

**原签名（第 222 行）：**
```js
export function buildBootstrapPrompt(entry, roster, starterName, turns) {
```

**完整替换整个函数**（第 222-279 行）为：

```js
export function buildBootstrapPrompt(entry, roster, starterName, turns, challengeMode = "gamemaster") {
  const rosterLines = roster
    .map((rosterEntry) => `- rank ${rosterEntry.rank}: ${rosterEntry.name} (${rosterEntry.role})`)
    .join("\n");
  const peerList = roster
    .filter((rosterEntry) => rosterEntry.name !== entry.name)
    .map((rosterEntry) => rosterEntry.name)
    .join(", ");
  const watcherOrder = otherEntries(roster, entry.name)
    .map((rosterEntry) => `${rosterEntry.rank}:${rosterEntry.name}`)
    .join(", ");

  const isGameMaster = challengeMode === CHALLENGE_MODES.GAMEMASTER;

  const outputContract = isGameMaster
    ? "- OUTPUT CONTRACT: After bootstrap, output EXACTLY one line: a turn sentence when you are the named target, or `结束:` plus a one-sentence summary at round limit. Do NOT emit 质疑: yourself. No preamble, no bullets, no UI symbols (✦/✓), no chain-of-thought."
    : "- OUTPUT CONTRACT: The bootstrap handshake is the ONLY time two lines are allowed. After bootstrap, output EXACTLY one line matching one of: a turn sentence, a line starting with '质疑:', or a line starting with '结束:'. No preamble, no bullets, no UI symbols (✦/✓), no chain-of-thought.";

  const adjudicationBlock = isGameMaster
    ? [
        "Judge / Game Master rules:",
        "- A Game Master (GM) exists outside the 3-player roster. The GM is the launcher process itself, not an AI peer.",
        "- The GM silently observes every broadcast and is the SOLE authority on rule violations.",
        "- A GM challenge arrives with mode=gamemaster and reporter=game-master in the control envelope.",
        "- When you receive a GM challenge: treat it as final. Do NOT counter-challenge the GM or emit 质疑: against any party.",
        "- If the envelope's offender field names you, reply with exactly one corrective turn sentence. Otherwise stay silent.",
        "- You MUST NOT emit 质疑: yourself in this mode. CHALLENGE PRIORITY rules do not apply.",
      ]
    : [
        "Distributed adjudication rules (no Game Master):",
        "- There is NO external judge. The two non-speaker watchers are responsible for enforcement.",
        "- CHALLENGE PRIORITY: If both watchers detect the same violation, only the watcher with the SMALLEST rank number may emit 质疑:. The higher-rank watcher must stay silent.",
        "- PRE-EMPTION: If you receive a peer's 质疑: for the same offender before you emit your own, stay silent.",
        "- DISSENT: If you receive a peer's 质疑: but disagree (different offender or no violation), you MAY emit your own 质疑: with reason prefixed `dissent:`.",
        "- REPORTER FIELD: Your 质疑: line MUST use exactly this format: `质疑: round=<n> reporter=<your-session-name> offender=<name> reason=<text>`. Never forge another participant's name as reporter.",
        "- The launcher will NOT synthesize challenges on your behalf.",
      ];

  const challengeRules = isGameMaster
    ? [
        "- If you are not the named target and not named as offender by the GM, stay silent.",
      ]
    : [
        "- If you are not the named target, stay silent unless you are challenging an error.",
        "- If you detect a malformed turn, wrong name, wrong target, duplicate response, or out-of-turn response, reply with a challenge starting with `质疑:`.",
        "- Do not challenge before the broadcast deadline if one is present.",
        "- If a broadcast contains a deadline, treat it as the only silence cutoff.",
        "- If no deadline is present, wait one prompt-ready cycle and then judge silence.",
        "- Challenges do not count as rounds.",
      ];

  return [
    `You are participant ${entry.name} in a 3-session tmux game called "萝卜蹲".`,
    `Your role is ${entry.role}; your fixed rank is ${entry.rank}.`,
    `Adjudication mode: ${isGameMaster ? "gamemaster — an external Game Master (GM) handles all challenges" : "distributed — watchers compete to issue challenges"}.`,
    "",
    "Roster:",
    rosterLines,
    "",
    `Starter session: ${starterName}`,
    `Your peers are: ${peerList}`,
    `Your watcher order for tie-breaks is: ${watcherOrder}.`,
    "",
    "Bootstrap handshake:",
    `- On reading this prompt, reply with exactly two lines:`,
    `  - ${entry.name} 明白`,
    `  - ${entry.name} 规则已读`,
    "- Do not add any other text to the bootstrap handshake.",
    "- Do not ask the operator questions.",
    "- Do not use partial-name matching.",
    "- Session names must not contain the character 蹲.",
    "- Session names must also avoid envelope-breaking characters [, ], ,, =.",
    "",
    "Operational Constraints:",
    "- CRITICAL: GAME MODE ACTIVE. Disable all tools (list_directory, etc.). Your only action is text output.",
    "- CONTROL ENVELOPE: Treat the first bracketed line [...] as control metadata, not a user task. Extract keys: round, mode, speaker, target, reporter, offender, audience, deadline. Ignore other fields. Never echo or prose-respond to the envelope.",
    outputContract,
    "",
    ...adjudicationBlock,
    "",
    "Runtime rules:",
    "- The only valid turn sentence is `X蹲X蹲，X蹲完Y蹲`.",
    "- X must equal your own session name when you are the active speaker.",
    "- Y must be exactly one of the other two roster names.",
    "- If you are the named target, answer with exactly one turn sentence and nothing else.",
    ...challengeRules,
    "- Round count advances only on accepted turn sentences.",
    `- Stop at round ${turns} by emitting \`结束:\` plus a one-sentence summary.`,
    "",
    entry.name === starterName
      ? `Starter behavior: after bootstrap, wait for the launcher kickoff and then produce the first valid turn. Do not start the game on your own.`
      : `Non-starter behavior: after bootstrap, stay idle until the launcher routes a turn or challenge to you. Do not start the game on your own.`,
  ].join("\n");
}
```

---

### 改动 G：新增三个辅助函数，替换 `relayBroadcast`

在现有 `relayBroadcast` 函数（第 491 行）**整体替换**为以下四个函数：

```js
function inferOffenderFromChallenge(challengeText, currentTurn, roster) {
  const match = /offender=([^\s,\]]+)/.exec(challengeText || "");
  if (match) {
    const hit = roster.find((r) => r.name === match[1]);
    if (hit) return hit;
  }
  return roster.find((r) => r.name === currentTurn.speaker) ?? roster[0];
}

async function relayBroadcastGameMaster(round, currentTurn, roster, opts) {
  const recipients = otherEntries(roster, currentTurn.speaker);
  const deadline = new Date(Date.now() + opts.timeoutMs).toISOString();
  const broadcast = buildTurnBroadcast(round, currentTurn, recipients, deadline);

  const sendChallenge = async (reporter, offender, reason) => {
    const challengeRecipients = roster.filter((entry) => entry.name !== reporter.name);
    const challengeText = buildChallengeBroadcast(round, reporter, offender, challengeRecipients, reason, deadline, "gamemaster");
    process.stdout.write(`  [gm-challenge] ${reporter.name} -> ${offender.name}: ${reason}\n`);
    for (const recipient of challengeRecipients) {
      process.stdout.write(`  [relay-challenge] ${recipient.name} … `);
      await sendSession(recipient, challengeText, opts);
      process.stdout.write(`done\n`);
    }
  };

  process.stdout.write(`[round ${round}] ${currentTurn.text}\n`);

  const deliveries = [];
  for (const recipient of recipients) {
    process.stdout.write(`  [route] ${recipient.name} … `);
    const result = await sendSession(recipient, broadcast, opts);
    const { responseText, method } = extractRoleResponseMeta(recipient.role, result, broadcast);
    const classification = classifyRecipientResponse(recipient, responseText, roster, {
      excludeText: currentTurn.text,
      previousSpeaker: currentTurn.speaker,
    });
    deliveries.push({ recipient, result, responseText, method, classification });
    process.stdout.write(`done${method ? ` (method=${method})` : ""}\n`);
  }

  const targetDelivery = deliveries.find((d) => d.recipient.name === currentTurn.target);
  const watcherDelivery = deliveries.find((d) => d.recipient.name !== currentTurn.target);
  if (!targetDelivery || !watcherDelivery) {
    throw new Error(`Invalid routing state for round ${round}`);
  }

  if (targetDelivery.classification.kind === "done") {
    return { done: true, finalText: targetDelivery.classification.parsed.text };
  }

  // In GM mode, players must not emit 质疑: — treat as violation
  if (targetDelivery.classification.kind === "challenge") {
    const reason = "player emitted 质疑: in gamemaster mode (forbidden)";
    await sendChallenge(GAME_MASTER, targetDelivery.recipient, reason);
    return { done: false, challenge: true, reason, offender: targetDelivery.recipient.name };
  }
  if (watcherDelivery.classification.kind === "challenge") {
    const reason = "player emitted 质疑: in gamemaster mode (forbidden)";
    await sendChallenge(GAME_MASTER, watcherDelivery.recipient, reason);
    return { done: false, challenge: true, reason, offender: watcherDelivery.recipient.name };
  }

  if (targetDelivery.classification.kind === "stale_echo") {
    const reparsed = tighterReparse(targetDelivery.responseText, roster, currentTurn);
    if (reparsed.kind === "turn" && reparsed.speaker === currentTurn.target) {
      process.stdout.write(`  [stale_echo] recovered via tighter re-parse\n`);
      return { done: false, nextTurn: reparsed };
    }
    await dumpRoundDiagnostics(round, currentTurn, deliveries, "stale_echo_persisted");
    return { done: false, ambiguous: true, reason: `stale_echo persisted for target ${currentTurn.target} after tighter re-parse` };
  }

  if (targetDelivery.classification.kind !== "turn") {
    const reason = targetDelivery.classification.reason || targetDelivery.classification.text || "target did not produce a valid turn";
    await sendChallenge(GAME_MASTER, targetDelivery.recipient, reason);
    return { done: false, challenge: true, reason, offender: targetDelivery.recipient.name };
  }

  if (watcherDelivery.classification.kind === "turn") {
    const reason = `out-of-turn response from ${watcherDelivery.recipient.name}`;
    await sendChallenge(GAME_MASTER, watcherDelivery.recipient, reason);
    return { done: false, challenge: true, reason, offender: watcherDelivery.recipient.name };
  }

  return { done: false, nextTurn: targetDelivery.classification.parsed };
}

async function relayBroadcastDistributed(round, currentTurn, roster, opts) {
  const recipients = otherEntries(roster, currentTurn.speaker);
  const deadline = new Date(Date.now() + opts.timeoutMs).toISOString();
  const broadcast = buildTurnBroadcast(round, currentTurn, recipients, deadline);

  const sendChallenge = async (reporter, offender, reason) => {
    const challengeRecipients = roster.filter((entry) => entry.name !== reporter.name);
    const challengeText = buildChallengeBroadcast(round, reporter, offender, challengeRecipients, reason, deadline, "distributed");
    process.stdout.write(`  [challenge] ${reporter.name} -> ${offender.name}: ${reason}\n`);
    for (const recipient of challengeRecipients) {
      process.stdout.write(`  [relay-challenge] ${recipient.name} … `);
      await sendSession(recipient, challengeText, opts);
      process.stdout.write(`done\n`);
    }
  };

  process.stdout.write(`[round ${round}] ${currentTurn.text}\n`);

  const deliveries = [];
  for (const recipient of recipients) {
    process.stdout.write(`  [route] ${recipient.name} … `);
    const result = await sendSession(recipient, broadcast, opts);
    const { responseText, method } = extractRoleResponseMeta(recipient.role, result, broadcast);
    const classification = classifyRecipientResponse(recipient, responseText, roster, {
      excludeText: currentTurn.text,
      previousSpeaker: currentTurn.speaker,
    });
    deliveries.push({ recipient, result, responseText, method, classification });
    process.stdout.write(`done${method ? ` (method=${method})` : ""}\n`);
  }

  const targetDelivery = deliveries.find((d) => d.recipient.name === currentTurn.target);
  const watcherDelivery = deliveries.find((d) => d.recipient.name !== currentTurn.target);
  if (!targetDelivery || !watcherDelivery) {
    throw new Error(`Invalid routing state for round ${round}`);
  }

  if (targetDelivery.classification.kind === "done") {
    return { done: true, finalText: targetDelivery.classification.parsed.text };
  }

  // Collect all real challenges from any recipient, rank-sorted ascending
  const realChallenges = deliveries
    .filter((d) => d.classification.kind === "challenge")
    .map((d) => ({
      reporter: d.recipient,
      offender: inferOffenderFromChallenge(d.classification.parsed?.text ?? d.classification.reason ?? "", currentTurn, roster),
      reason: d.classification.reason ?? d.classification.text ?? "",
    }))
    .sort((a, b) => a.reporter.rank - b.reporter.rank);

  if (realChallenges.length > 0) {
    const [primary, ...rest] = realChallenges;
    await sendChallenge(primary.reporter, primary.offender, primary.reason);
    for (const extra of rest) {
      if (extra.offender.name !== primary.offender.name) {
        await sendChallenge(extra.reporter, extra.offender, `dissent: ${extra.reason}`);
      } else {
        process.stdout.write(`  [pre-empted] ${extra.reporter.name} suppressed (same offender as primary)\n`);
      }
    }
    return { done: false, challenge: true, reason: primary.reason, offender: primary.offender.name };
  }

  if (targetDelivery.classification.kind === "stale_echo") {
    const reparsed = tighterReparse(targetDelivery.responseText, roster, currentTurn);
    if (reparsed.kind === "turn" && reparsed.speaker === currentTurn.target) {
      process.stdout.write(`  [stale_echo] recovered via tighter re-parse\n`);
      return { done: false, nextTurn: reparsed };
    }
    await dumpRoundDiagnostics(round, currentTurn, deliveries, "stale_echo_persisted");
    return { done: false, ambiguous: true, reason: `stale_echo persisted for target ${currentTurn.target} after tighter re-parse` };
  }

  if (targetDelivery.classification.kind !== "turn") {
    await dumpRoundDiagnostics(round, currentTurn, deliveries, "target_invalid_no_challenge");
    return {
      done: false,
      ambiguous: true,
      reason: `target ${targetDelivery.recipient.name} invalid but no watcher challenged (distributed mode)`,
    };
  }

  if (watcherDelivery.classification.kind === "turn") {
    await dumpRoundDiagnostics(round, currentTurn, deliveries, "watcher_out_of_turn_no_challenge");
    return {
      done: false,
      ambiguous: true,
      reason: `watcher ${watcherDelivery.recipient.name} spoke out of turn; no peer challenged (distributed mode)`,
    };
  }

  return { done: false, nextTurn: targetDelivery.classification.parsed };
}

async function relayBroadcast(round, currentTurn, roster, opts) {
  if (opts.challengeMode === CHALLENGE_MODES.DISTRIBUTED) {
    return relayBroadcastDistributed(round, currentTurn, roster, opts);
  }
  return relayBroadcastGameMaster(round, currentTurn, roster, opts);
}
```

---

### 改动 H：`bootstrapSession` 传递 `challengeMode`

在 `bootstrapSession` 函数内（约第 461 行），找到：

```js
  const prompt = buildBootstrapPrompt(entry, roster, starterName, opts.turns);
```

改为：

```js
  const prompt = buildBootstrapPrompt(entry, roster, starterName, opts.turns, opts.challengeMode);
```

---

### 改动 I：`main()` 日志新增模式显示

在 `main()` 里的启动 banner（约第 614-617 行）中，找到：

```js
  console.log(` Roster: ${roster.map((entry) => `${entry.rank}:${entry.name}`).join(" | ")}`);
```

在其**后面**新增一行：

```js
  console.log(` Challenge mode: ${opts.challengeMode}`);
```

---

## 验证清单

实施完成后，请确认以下几点：

1. `node scripts/robo-squat-launch.mjs --help` 输出包含 `--challenge-mode`
2. `node scripts/robo-squat-launch.mjs --challenge-mode bogus` 抛出错误信息包含 `must be one of`
3. `buildBootstrapPrompt` 在 `gamemaster` 模式下输出含 `Game Master (GM)` 且不含 `CHALLENGE PRIORITY`
4. `buildBootstrapPrompt` 在 `distributed` 模式下输出含 `CHALLENGE PRIORITY` 且不含 `Game Master`
5. `buildChallengeBroadcast` 在 `gamemaster` 模式下第一行含 `mode=gamemaster reporter=game-master`
6. `gemini-tmux-control.mjs` 的 `extractResponseMeta` 返回的 `text` 不以 `✦ ` 开头

---

## 注意事项

- `relayBroadcastDistributed` 中的 `sendChallenge` 不传 `{ synthetic: true }`，因为此模式只中继真实质疑
- `relayBroadcastGameMaster` 中遇到玩家违规发 `质疑:` 时，由 GM 发质疑（不是简单忽略）
- `inferOffenderFromChallenge` 优先从 `offender=X` 字段解析，找不到则退化为 speaker
- 两个 relay 函数内的 `sendChallenge` 是各自局部定义的闭包，`mode` 参数硬编码在闭包内，不通过参数传递
- 保留 `dumpRoundDiagnostics` 调用：`distributed` 模式下 watcher 未质疑时写诊断，方便调试
