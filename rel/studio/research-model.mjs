const REFUSED =
  "No REE_MODEL_API_KEY is set. No model was called and no Evidence was uploaded.";

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function modelSettings(env = process.env) {
  const key =
    typeof env.REE_MODEL_API_KEY === "string"
      ? env.REE_MODEL_API_KEY.trim()
      : "";
  const provider = ["openai", "xai", "anthropic"].includes(
    env.REE_MODEL_PROVIDER,
  )
    ? env.REE_MODEL_PROVIDER
    : "openai";
  const baseUrl =
    typeof env.REE_MODEL_BASE_URL === "string" && env.REE_MODEL_BASE_URL !== ""
      ? env.REE_MODEL_BASE_URL
      : provider === "xai"
        ? "https://api.x.ai/v1"
        : "https://api.openai.com/v1";
  const budget = numberOrNull(
    env.REE_MODEL_BUDGET_USD === undefined || env.REE_MODEL_BUDGET_USD === ""
      ? 0.05
      : Number(env.REE_MODEL_BUDGET_USD),
  );
  return {
    configured: key.length > 0,
    provider,
    model:
      typeof env.REE_MODEL_NAME === "string" && env.REE_MODEL_NAME !== ""
        ? env.REE_MODEL_NAME
        : provider === "anthropic"
          ? "claude-3-5-haiku-latest"
          : "gpt-4o-mini",
    base_url:
      provider === "anthropic" ? "https://api.anthropic.com/v1" : baseUrl,
    max_tokens: 600,
    budget_usd: budget,
    usd_per_million:
      env.REE_MODEL_USD_PER_MILLION === undefined ||
      env.REE_MODEL_USD_PER_MILLION === ""
        ? null
        : numberOrNull(Number(env.REE_MODEL_USD_PER_MILLION)),
    key,
  };
}

export function publicModelSettings(env = process.env) {
  const settings = modelSettings(env);
  return {
    configured: settings.configured,
    provider: settings.provider,
    model: settings.model,
    budget_usd: settings.budget_usd,
    remote_calls: "refused",
  };
}

export function providerCall(settings, prompt) {
  const tool = {
    name: "model.complete",
    arguments: {
      provider: settings.provider,
      model: settings.model,
      max_tokens: settings.max_tokens,
    },
  };
  if (settings.provider === "anthropic") {
    return {
      tool,
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.key,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: settings.model,
        max_tokens: settings.max_tokens,
        messages: [{ role: "user", content: prompt }],
      },
    };
  }
  const root = settings.base_url.replace(/\/$/u, "");
  return {
    tool,
    url: `${root}/chat/completions`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.key}`,
    },
    body: {
      model: settings.model,
      max_tokens: settings.max_tokens,
      messages: [{ role: "user", content: prompt }],
    },
  };
}

export function usageTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  if (
    typeof usage.input_tokens === "number" &&
    typeof usage.output_tokens === "number"
  )
    return usage.input_tokens + usage.output_tokens;
  return null;
}

export function costFromUsage(usage, usdPerMillion) {
  const tokens = usageTokens(usage);
  if (tokens === null)
    return {
      status: "unknown",
      usd: null,
      tokens: null,
      reason: "The provider response did not include token usage.",
    };
  if (usdPerMillion === null)
    return {
      status: "unknown",
      usd: null,
      tokens,
      reason:
        "REE_MODEL_USD_PER_MILLION is not set, so the dollar cost is unknown.",
    };
  return {
    status: "computed",
    usd: (tokens / 1_000_000) * usdPerMillion,
    tokens,
    reason: null,
  };
}

function parseAnswer(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return parsed;
  } catch {
    return null;
  }
}

export function verifyAnswer(answer, allowedIds) {
  const allowed = new Set(allowedIds);
  const facts = [];
  const rejected = [];
  const claims = Array.isArray(answer?.facts) ? answer.facts : [];
  for (const claim of claims) {
    const text = typeof claim?.text === "string" ? claim.text : "";
    const ids = Array.isArray(claim?.evidence_ids)
      ? claim.evidence_ids.filter((id) => typeof id === "string")
      : [];
    if (text === "" || ids.length === 0 || ids.some((id) => !allowed.has(id))) {
      rejected.push(text || "empty claim");
      continue;
    }
    facts.push({ text, evidence_ids: ids });
  }
  const hypotheses = Array.isArray(answer?.hypotheses)
    ? answer.hypotheses.filter((item) => typeof item === "string").slice(0, 8)
    : [];
  const unknowns = [
    ...(Array.isArray(answer?.unknowns)
      ? answer.unknowns.filter((item) => typeof item === "string").slice(0, 8)
      : []),
    ...rejected.map(
      (text) =>
        `Rejected because it cited no retrieved Evidence id: ${text.slice(0, 180)}`,
    ),
  ];
  return { facts, hypotheses, unknowns, rejected };
}

function promptFor(question, evidenceIds, passages) {
  return [
    "Answer only from the retrieved Evidence passages.",
    "Return JSON with facts (each text plus evidence_ids), hypotheses, and unknowns.",
    "A fact must cite an evidence id from this list. Do not invent ids.",
    `Question: ${question}`,
    `Allowed evidence ids: ${evidenceIds.join(", ") || "(none)"}`,
    "Passages:",
    passages.slice(0, 6000),
  ].join("\n");
}

function stage(id, tool, status, extra) {
  return {
    id,
    tool,
    status,
    facts: extra.facts ?? [],
    hypotheses: extra.hypotheses ?? [],
    unknowns: extra.unknowns ?? [],
    tool_call: extra.tool_call ?? null,
    result: extra.result ?? null,
  };
}

export async function askWithEvidence({
  env = process.env,
  question,
  evidenceIds,
  passages,
  complete,
}) {
  const settings = modelSettings(env);
  if (!settings.configured || typeof complete !== "function") {
    return {
      remote_calls: "refused",
      remote_reason: REFUSED,
      cost: { status: "unknown", usd: null, tokens: null, reason: REFUSED },
      stages: [],
    };
  }
  if (!evidenceIds?.length) {
    return {
      remote_calls: "refused",
      remote_reason:
        "No Evidence id was retrieved, so the model was not called.",
      cost: {
        status: "unknown",
        usd: null,
        tokens: null,
        reason: "No call was made.",
      },
      stages: [
        stage("SCOUT", "retrieveEvidence", "not-run", {
          unknowns: ["No Evidence id was retrieved."],
        }),
      ],
    };
  }
  const call = providerCall(
    settings,
    promptFor(question, evidenceIds, passages),
  );
  const response = await complete(call);
  const cost = costFromUsage(response?.usage, settings.usd_per_million);
  const over =
    cost.status === "computed" &&
    settings.budget_usd !== null &&
    cost.usd > settings.budget_usd;
  const parsed = response?.ok ? parseAnswer(response.text) : null;
  const verified = over
    ? {
        facts: [],
        hypotheses: [],
        unknowns: [
          "The computed cost exceeded REE_MODEL_BUDGET_USD, so the model claims were not kept.",
        ],
        rejected: [],
      }
    : verifyAnswer(parsed, evidenceIds);
  if (!response?.ok)
    verified.unknowns.unshift(
      `The model request failed: ${response?.error || "unknown error"}.`,
    );
  if (response?.ok && !parsed)
    verified.unknowns.unshift(
      "The model response was not the requested JSON, so no fact was kept.",
    );
  return {
    remote_calls: "called",
    remote_reason:
      "The model saw retrieved Evidence passages only. Claims that cite no retrieved id were rejected.",
    cost,
    over_budget: over,
    stages: [
      stage("SCOUT", "retrieveEvidence", "completed", {
        tool_call: {
          name: "retrieveEvidence",
          arguments: { evidence_ids: evidenceIds },
        },
        facts: evidenceIds.map((id) => `Retrieved Evidence ${id}.`),
      }),
      stage("MAPPER", "passages", "completed", {
        tool_call: {
          name: "boundPassages",
          arguments: { characters: Math.min(passages.length, 6000) },
        },
        facts: ["Passages were limited to retrieved stage text."],
      }),
      stage("ANALYST", "model.complete", over ? "discarded" : "completed", {
        tool_call: call.tool,
        result: { cost, over_budget: over },
        facts: verified.facts.map(
          (fact) => `${fact.text} (${fact.evidence_ids.join(", ")})`,
        ),
        hypotheses: verified.hypotheses,
      }),
      stage("VERIFIER", "cite-retrieved-evidence", "completed", {
        tool_call: {
          name: "rejectUncitedClaims",
          arguments: { allowed: evidenceIds },
        },
        facts: verified.facts.map((fact) => fact.text),
        unknowns: verified.unknowns,
      }),
      stage("REPORTER", "verified-answer", "completed", {
        facts: verified.facts.map(
          (fact) => `${fact.text} Evidence ${fact.evidence_ids.join(", ")}.`,
        ),
        hypotheses: verified.hypotheses,
        unknowns: verified.unknowns,
        result: { cost },
      }),
    ],
  };
}

export function responseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const choice = payload.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  const block = payload.content?.find?.((item) => item?.type === "text");
  return typeof block?.text === "string" ? block.text : "";
}

export async function completeWithFetch(call) {
  const response = await fetch(call.url, {
    method: "POST",
    headers: call.headers,
    body: JSON.stringify(call.body),
    signal: AbortSignal.timeout(20_000),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    return {
      ok: false,
      error:
        payload?.error?.message || payload?.error || `HTTP ${response.status}`,
      usage: payload?.usage ?? null,
      text: "",
    };
  }
  return {
    ok: true,
    text: responseText(payload),
    usage: payload?.usage ?? null,
  };
}
