/**
 * cost-calculator.test.ts
 * 覆盖 5 类：正常值 / 异常值 / 不同状态返回 / 并发 / 边界值
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculateCost, loadCostConfig } from "../src/cost-calculator.js";

const OPENAI_GPT4O = { input: 5e-6, output: 15e-6, cacheRead: 0.5e-6, cacheWrite: 1e-6 };
const CLAUDE3 = { input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheWrite: 1.25e-6 };

// ── 1. 正常值 ──────────────────────────────────────────────────────────────

describe("calculateCost — 正常值", () => {
  test("全字段 usage 精确计算", () => {
    const cost = calculateCost(
      { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
      OPENAI_GPT4O,
    );
    const expected =
      1000 * 5e-6 + 500 * 15e-6 + 200 * 0.5e-6 + 100 * 1e-6;
    assert.equal(cost, expected);
  });

  test("只有 input + output", () => {
    const cost = calculateCost({ input: 2000, output: 800 }, CLAUDE3);
    assert.equal(cost, 2000 * 3e-6 + 800 * 15e-6);
  });

  test("返回值类型为 number", () => {
    const cost = calculateCost({ input: 100, output: 50 }, OPENAI_GPT4O);
    assert.equal(typeof cost, "number");
  });
});

describe("loadCostConfig — 正常值", () => {
  test("单 provider 单 model 加载成功", () => {
    const config = {
      models: {
        providers: {
          openai: { models: { "gpt-4o": { cost: OPENAI_GPT4O } } },
        },
      },
    };
    const map = loadCostConfig(config);
    assert.equal(map.size, 1);
    assert.deepEqual(map.get("openai:gpt-4o"), OPENAI_GPT4O);
  });

  test("多 provider 多 model 全部写入", () => {
    const config = {
      models: {
        providers: {
          openai: {
            models: {
              "gpt-4o": { cost: OPENAI_GPT4O },
              "gpt-4o-mini": { cost: { input: 0.15e-6, output: 0.6e-6, cacheRead: 0.075e-6, cacheWrite: 0.15e-6 } },
            },
          },
          anthropic: { models: { "claude-3-5-sonnet": { cost: CLAUDE3 } } },
        },
      },
    };
    const map = loadCostConfig(config);
    assert.equal(map.size, 3);
    assert.ok(map.has("openai:gpt-4o"));
    assert.ok(map.has("openai:gpt-4o-mini"));
    assert.ok(map.has("anthropic:claude-3-5-sonnet"));
  });
});

// ── 2. 异常值 ──────────────────────────────────────────────────────────────

describe("calculateCost — 异常值", () => {
  test("costConfig 为 undefined → 返回 null", () => {
    assert.equal(calculateCost({ input: 100 }, undefined), null);
  });

  test("usage 全字段缺失 → cost = 0", () => {
    assert.equal(calculateCost({}, OPENAI_GPT4O), 0);
  });

  test("usage 字段为 undefined → 视为 0", () => {
    const cost = calculateCost(
      { input: undefined, output: undefined, cacheRead: undefined, cacheWrite: undefined },
      OPENAI_GPT4O,
    );
    assert.equal(cost, 0);
  });
});

describe("loadCostConfig — 异常值", () => {
  test("null 输入 → 空 Map", () => {
    assert.equal(loadCostConfig(null).size, 0);
  });

  test("providers 不是 object → 空 Map", () => {
    assert.equal(loadCostConfig({ models: { providers: "bad" } }).size, 0);
  });

  test("model 没有 cost 字段 → 跳过", () => {
    const config = {
      models: { providers: { openai: { models: { "gpt-4o": { context: 128000 } } } } },
    };
    assert.equal(loadCostConfig(config).size, 0);
  });

  test("cost.input 不是 number → 跳过", () => {
    const config = {
      models: {
        providers: {
          openai: { models: { "gpt-4o": { cost: { input: "cheap", output: 0 } } } },
        },
      },
    };
    assert.equal(loadCostConfig(config).size, 0);
  });

  test("models 字段不是 object → 跳过该 provider", () => {
    const config = {
      models: {
        providers: {
          bad_provider: { models: null },
          good_provider: { models: { m1: { cost: CLAUDE3 } } },
        },
      },
    };
    assert.equal(loadCostConfig(config).size, 1);
  });
});

// ── 3. 不同状态返回 ────────────────────────────────────────────────────────

describe("calculateCost — 不同状态", () => {
  test("仅 cache 流量有费用（input/output 为 0）", () => {
    const cost = calculateCost(
      { input: 0, output: 0, cacheRead: 1000, cacheWrite: 500 },
      OPENAI_GPT4O,
    );
    assert.equal(cost, 1000 * 0.5e-6 + 500 * 1e-6);
    assert.ok(cost! > 0);
  });

  test("cacheRead cost < input cost（相同 token 量）", () => {
    const cacheOnlyCost = calculateCost({ input: 0, output: 0, cacheRead: 1000 }, OPENAI_GPT4O)!;
    const inputOnlyCost = calculateCost({ input: 1000, output: 0 }, OPENAI_GPT4O)!;
    assert.ok(cacheOnlyCost < inputOnlyCost, "cache read should be cheaper than input");
  });

  test("cost = 0 时 costConfig 全零", () => {
    const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    assert.equal(calculateCost({ input: 9999, output: 9999, cacheRead: 9999, cacheWrite: 9999 }, zeroCost), 0);
  });
});

// ── 4. 并发 ────────────────────────────────────────────────────────────────

describe("calculateCost — 并发安全", () => {
  test("1000 次并发调用结果一致", async () => {
    const results = await Promise.all(
      Array.from({ length: 1000 }, () =>
        Promise.resolve(calculateCost({ input: 100, output: 50, cacheRead: 20, cacheWrite: 10 }, OPENAI_GPT4O)),
      ),
    );
    const first = results[0]!;
    assert.ok(results.every((r) => r === first), "all results should be identical");
  });

  test("并发 loadCostConfig 调用互不干扰", async () => {
    const configs = Array.from({ length: 50 }, (_, i) => ({
      models: { providers: { [`p${i}`]: { models: { [`m${i}`]: { cost: OPENAI_GPT4O } } } } },
    }));
    const maps = await Promise.all(configs.map((c) => Promise.resolve(loadCostConfig(c))));
    maps.forEach((m, i) => {
      assert.equal(m.size, 1);
      assert.ok(m.has(`p${i}:m${i}`));
    });
  });
});

// ── 5. 边界值 ──────────────────────────────────────────────────────────────

describe("calculateCost — 边界值", () => {
  test("超大 token 量（10M tokens）", () => {
    const cost = calculateCost({ input: 10_000_000, output: 10_000_000 }, OPENAI_GPT4O);
    assert.equal(cost, 10_000_000 * 5e-6 + 10_000_000 * 15e-6);
    assert.ok(isFinite(cost!));
  });

  test("token 量为 1（最小正整数）", () => {
    const cost = calculateCost({ input: 1, output: 1 }, OPENAI_GPT4O);
    assert.equal(cost, 5e-6 + 15e-6);
  });

  test("浮点 token 量不崩溃", () => {
    const cost = calculateCost({ input: 1.5, output: 2.7 }, OPENAI_GPT4O);
    assert.ok(isFinite(cost!));
  });

  test("provider:model key 包含特殊字符", () => {
    const config = {
      models: {
        providers: {
          "openai.v2": { models: { "gpt-4o:2024-11": { cost: OPENAI_GPT4O } } },
        },
      },
    };
    const map = loadCostConfig(config);
    assert.ok(map.has("openai.v2:gpt-4o:2024-11"));
  });

  test("200 个 model 的大型 config 不超时", () => {
    const models: Record<string, { cost: typeof OPENAI_GPT4O }> = {};
    for (let i = 0; i < 200; i++) models[`model-${i}`] = { cost: OPENAI_GPT4O };
    const config = { models: { providers: { mega: { models } } } };
    const map = loadCostConfig(config);
    assert.equal(map.size, 200);
  });
});
