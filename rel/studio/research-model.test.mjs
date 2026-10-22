import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askWithEvidence,
  costFromUsage,
  providerCall,
  verifyAnswer,
} from "./research-model.mjs";

const env = {
  REE_MODEL_API_KEY: "test-key",
  REE_MODEL_PROVIDER: "openai",
  REE_MODEL_BASE_URL: "https://example.test/v1",
  REE_MODEL_NAME: "test-model",
  REE_MODEL_BUDGET_USD: "0.05",
  REE_MODEL_USD_PER_MILLION: "2",
};

test("the verifier drops a claim that cites no retrieved Evidence id", () => {
  const result = verifyAnswer(
    {
      facts: [
        { text: "Imports are inferred.", evidence_ids: ["ev_kept"] },
        { text: "Settings live in main.", evidence_ids: [] },
        { text: "Invented.", evidence_ids: ["ev_other"] },
      ],
      hypotheses: ["The feature might start in cli.mjs."],
      unknowns: ["Runtime behavior is unknown."],
    },
    ["ev_kept"],
  );
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].text, "Imports are inferred.");
  assert.equal(result.rejected.length, 2);
  assert.equal(result.hypotheses.length, 1);
});

test("a missing usage field leaves cost unknown", () => {
  const cost = costFromUsage({}, 2);
  assert.equal(cost.status, "unknown");
  assert.equal(cost.usd, null);
});

test("an over-budget response does not keep model claims", async () => {
  let called = 0;
  const result = await askWithEvidence({
    env,
    question: "Where does search start?",
    evidenceIds: ["ev_kept"],
    passages: "Evidence ev_kept. search.mjs exports searchNotes.",
    complete: async (call) => {
      called += 1;
      assert.equal(call.tool.arguments.model, "test-model");
      assert.equal(JSON.stringify(call.tool).includes("test-key"), false);
      assert.equal(call.headers.authorization, "Bearer test-key");
      return {
        ok: true,
        text: JSON.stringify({
          facts: [
            { text: "searchNotes is exported.", evidence_ids: ["ev_kept"] },
          ],
          hypotheses: [],
          unknowns: [],
        }),
        usage: { total_tokens: 100_000_000 },
      };
    },
  });
  assert.equal(called, 1);
  assert.equal(result.remote_calls, "called");
  assert.equal(result.over_budget, true);
  assert.equal(
    result.stages.find((stage) => stage.id === "REPORTER").facts.length,
    0,
  );
});

test("a cited fact is kept and the tool call is recorded", async () => {
  const result = await askWithEvidence({
    env: { ...env, REE_MODEL_USD_PER_MILLION: "" },
    question: "How does it handle settings?",
    evidenceIds: ["ev_kept"],
    passages: "Evidence ev_kept.",
    complete: async () => ({
      ok: true,
      text: JSON.stringify({
        facts: [
          { text: "The record names search.mjs.", evidence_ids: ["ev_kept"] },
          { text: "No citation.", evidence_ids: [] },
        ],
        hypotheses: ["Settings might be flags."],
        unknowns: ["No settings table was retrieved."],
      }),
      usage: null,
    }),
  });
  assert.equal(result.cost.status, "unknown");
  const reporter = result.stages.find((stage) => stage.id === "REPORTER");
  assert.match(reporter.facts[0], /ev_kept/);
  assert.match(reporter.unknowns.join(" "), /Rejected/);
  assert.deepEqual(reporter.hypotheses, ["Settings might be flags."]);
});

test("no key refuses the call before complete", async () => {
  let called = false;
  const result = await askWithEvidence({
    env: {},
    question: "Where?",
    evidenceIds: ["ev_kept"],
    passages: "Evidence ev_kept.",
    complete: async () => {
      called = true;
      return { ok: true, text: "{}", usage: null };
    },
  });
  assert.equal(called, false);
  assert.equal(result.remote_calls, "refused");
});

test("xAI and Anthropic calls use their request shapes", () => {
  const xai = providerCall(
    {
      provider: "xai",
      model: "grok",
      base_url: "https://api.x.ai/v1",
      max_tokens: 600,
      key: "secret",
    },
    "question",
  );
  assert.equal(xai.url, "https://api.x.ai/v1/chat/completions");
  assert.equal(xai.tool.arguments.provider, "xai");
  const anthropic = providerCall(
    {
      provider: "anthropic",
      model: "claude",
      base_url: "ignored",
      max_tokens: 600,
      key: "secret",
    },
    "question",
  );
  assert.equal(anthropic.url, "https://api.anthropic.com/v1/messages");
  assert.equal(anthropic.headers["x-api-key"], "secret");
  assert.equal(JSON.stringify(anthropic.tool).includes("secret"), false);
});
