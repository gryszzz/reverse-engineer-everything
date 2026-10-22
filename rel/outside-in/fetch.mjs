import { USER_AGENT, MAX_DOCUMENT_BYTES } from "./constants.mjs";
import {
  classifyUrl,
  contentTypeBlocked,
  dispositionFilenameBlocked,
  hasCaptcha,
  markedPaywall,
  refusalDetail,
} from "./policy.mjs";
import { evaluateRobots, parseRobots } from "./robots.mjs";
import { sha256 } from "./cache.mjs";
import { lowerHeaders, mediaType } from "./text.mjs";

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function requestHeaders() {
  return {
    "user-agent": USER_AGENT,
    accept:
      "text/html,application/xhtml+xml,application/json,text/yaml,text/markdown,text/plain;q=0.5",
    "accept-language": "en",
  };
}

export function createPublicFetcher(options) {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? sleepDefault;
  const minIntervalMs = options.minIntervalMs ?? 0;
  const fixture = options.fixture ?? null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cache = options.cache;
  const hosts = new Map();
  const robotsByOrigin = new Map();
  const fetches = [];

  function hostState(host) {
    let state = hosts.get(host);
    if (!state) {
      state = { nextAt: 0, blockedUntil: 0, crawlDelayMs: 0 };
      hosts.set(host, state);
    }
    return state;
  }

  async function pace(host) {
    const state = hostState(host);
    const current = now().getTime();
    if (state.blockedUntil > current) {
      return { blocked: true, retryAfterMs: state.blockedUntil - current };
    }
    const wait = Math.max(0, state.nextAt - current);
    if (wait > 0) await sleep(wait);
    const started = now().getTime();
    state.lastRequestAt = started;
    const interval = Math.max(minIntervalMs, state.crawlDelayMs);
    state.nextAt = started + interval;
    return { blocked: false };
  }

  function noteCrawlDelay(host, seconds) {
    const state = hostState(host);
    state.crawlDelayMs = Math.max(state.crawlDelayMs, seconds * 1000);
    if (state.lastRequestAt != null) {
      state.nextAt = Math.max(
        state.nextAt,
        state.lastRequestAt + state.crawlDelayMs,
      );
    }
  }

  function blockHost(host, ms) {
    const state = hostState(host);
    state.blockedUntil = Math.max(state.blockedUntil, now().getTime() + ms);
  }

  async function transport(url) {
    const headers = requestHeaders();
    const cached = cache.get(url);
    if (cached) {
      fetches.push({ url, headers, fromCache: true });
      return {
        status: cached.status,
        headers: lowerHeaders(cached.headers ?? {}),
        body: cached.body,
        fromCache: true,
        fetchedAt: cached.fetched_at,
        contentType: cached.content_type,
      };
    }
    const host = new URL(url).host;
    const paced = await pace(host);
    if (paced.blocked) {
      return { blocked: true, retryAfterMs: paced.retryAfterMs };
    }
    if (fixture) {
      const response = await fixture.respond(url, headers);
      fetches.push({ url, headers, fromCache: false });
      if (!response) return { missing: true };
      return { ...response, fromCache: false, fetchedAt: now().toISOString() };
    }
    const live = await liveGet(url, headers, fetchImpl);
    fetches.push({ url, headers, fromCache: false });
    return { ...live, fromCache: false, fetchedAt: now().toISOString() };
  }

  async function fetchRobots(origin) {
    if (robotsByOrigin.has(origin)) return robotsByOrigin.get(origin);
    const robotsUrl = `${origin}/robots.txt`;
    const policy = classifyUrl(robotsUrl);
    if (!policy.ok) {
      const result = { unavailable: true, detail: policy.detail };
      robotsByOrigin.set(origin, result);
      return result;
    }
    const response = await transport(robotsUrl);
    rememberRobots(robotsUrl, response);
    const result = interpretRobots(response);
    robotsByOrigin.set(origin, result);
    if (Number.isFinite(result.crawlDelaySeconds)) {
      noteCrawlDelay(new URL(origin).host, result.crawlDelaySeconds);
    }
    return result;
  }

  function rememberRobots(robotsUrl, response) {
    if (
      response.fromCache ||
      response.blocked ||
      response.missing ||
      response.networkError
    )
      return;
    if (response.status !== 200 && response.status !== 404) return;
    const body = response.body ?? "";
    const headers = lowerHeaders(response.headers ?? {});
    cache.put(robotsUrl, {
      fetched_at: response.fetchedAt,
      status: response.status,
      content_type: mediaType(headers) || "text/plain",
      sha256: sha256(body),
      bytes: Buffer.byteLength(body),
      headers,
      body,
    });
  }

  async function fetchDocument(rawUrl, role) {
    const decidedAt = now().toISOString();
    const policy = classifyUrl(rawUrl);
    if (!policy.ok) {
      return fail(
        policy.redactedUrl,
        role,
        policy.reason,
        policy.detail,
        decidedAt,
      );
    }
    const robots = await fetchRobots(policy.url.origin);
    if (robots.unavailable) {
      return fail(
        policy.redactedUrl,
        role,
        "robots-unavailable",
        robots.detail ||
          "robots.txt could not be read. The URL was not fetched.",
        decidedAt,
      );
    }
    const decision = evaluateRobots(
      robots.groups,
      USER_AGENT,
      policy.url.pathname,
    );
    noteCrawlDelay(policy.url.host, decision.crawlDelaySeconds);
    if (!decision.allowed) {
      return fail(
        policy.redactedUrl,
        role,
        "robots-disallow",
        decision.rule ?? "Disallow",
        decidedAt,
      );
    }
    const response = await transport(policy.url.toString());
    return interpretDocument(response, policy, role, decision);
  }

  return { fetch: fetchDocument, fetches };

  function interpretDocument(response, policy, role, decision) {
    const url = policy.redactedUrl;
    const fetchedAt = response.fetchedAt ?? now().toISOString();
    if (response.blocked) {
      return fail(
        url,
        role,
        "rate-limit",
        "Host is cooling down after a rate limit. The URL was not fetched.",
        fetchedAt,
      );
    }
    if (response.missing) {
      return fail(
        url,
        role,
        "fixture-miss",
        "No fixture response for this URL.",
        fetchedAt,
      );
    }
    if (response.networkError) {
      return fail(url, role, "fetch-failed", response.networkError, fetchedAt);
    }
    if (response.status >= 300 && response.status < 400) {
      return fail(
        url,
        role,
        "redirect",
        "Redirects are not followed.",
        fetchedAt,
      );
    }
    if (response.status === 429) {
      const retryMs = retryAfterMs(response.headers, now());
      blockHost(policy.url.host, retryMs ?? 60_000);
      return fail(
        url,
        role,
        "rate-limit",
        retryMs
          ? `HTTP 429. Retry-After ${Math.ceil(retryMs / 1000)}s. No retry was sent.`
          : "HTTP 429. No retry was sent.",
        fetchedAt,
      );
    }
    if (response.status === 401 || response.status === 403) {
      return fail(
        url,
        role,
        "auth-required",
        `HTTP ${response.status}. Credentials are not sent.`,
        fetchedAt,
      );
    }
    if (response.status === 402) {
      return fail(
        url,
        role,
        "paywall",
        "HTTP 402. Paywalled content is not fetched.",
        fetchedAt,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return fail(
        url,
        role,
        "fetch-failed",
        `HTTP ${response.status}.`,
        fetchedAt,
      );
    }
    const headers = lowerHeaders(response.headers ?? {});
    const type = response.contentType || mediaType(headers);
    const body = response.body ?? "";
    if (response.tooLarge || Buffer.byteLength(body) > MAX_DOCUMENT_BYTES) {
      return fail(
        url,
        role,
        "too-large",
        "The document exceeds the size limit.",
        fetchedAt,
      );
    }
    if (
      response.binary ||
      contentTypeBlocked(type) ||
      dispositionFilenameBlocked(headers)
    ) {
      return fail(
        url,
        role,
        "source-or-binary",
        "The response is source or binary content and was discarded.",
        fetchedAt,
      );
    }
    if (hasCaptcha(body)) {
      return fail(
        url,
        role,
        "captcha",
        "A captcha was detected. It was not solved.",
        fetchedAt,
      );
    }
    if (markedPaywall(body)) {
      return fail(
        url,
        role,
        "paywall",
        "A paywall marker was present. The page was not extracted.",
        fetchedAt,
      );
    }
    const record = {
      url,
      role,
      status: response.status,
      contentType: type || "application/octet-stream",
      body,
      fetchedAt,
      sha256: sha256(body),
      bytes: Buffer.byteLength(body),
      robots: { allowed: true, rule: decision.rule },
      cacheHit: Boolean(response.fromCache),
      headers,
    };
    if (!response.fromCache) {
      cache.put(policy.url.toString(), {
        fetched_at: fetchedAt,
        status: record.status,
        content_type: record.contentType,
        sha256: record.sha256,
        bytes: record.bytes,
        headers,
        body,
      });
    }
    return { ok: true, document: record };
  }
}

function interpretRobots(response) {
  if (response.blocked) {
    return {
      unavailable: true,
      detail: "robots.txt was not fetched because the host is rate limited.",
    };
  }
  if (response.missing) {
    return {
      unavailable: true,
      detail: "robots.txt has no fixture response. Fail closed.",
    };
  }
  if (response.networkError) {
    return {
      unavailable: true,
      detail: "robots.txt could not be fetched. Fail closed.",
    };
  }
  if (response.status === 404)
    return { groups: [], crawlDelaySeconds: 0, missing: true };
  if (response.status === 429) {
    return {
      unavailable: true,
      detail: "robots.txt returned HTTP 429. Fail closed.",
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      unavailable: true,
      detail: `robots.txt returned HTTP ${response.status}. Fail closed.`,
    };
  }
  const body = response.body ?? "";
  if (hasCaptcha(body) || /<html[\s>]/i.test(body)) {
    return {
      unavailable: true,
      detail: "robots.txt was not a robots document. Fail closed.",
    };
  }
  const groups = parseRobots(body);
  const decision = evaluateRobots(groups, USER_AGENT, "/");
  return { groups, crawlDelaySeconds: decision.crawlDelaySeconds };
}

function fail(url, role, reason, detail, fetchedAt) {
  return {
    ok: false,
    refusal: {
      url,
      role,
      reason,
      detail: refusalDetail(detail),
      fetched_at: fetchedAt,
    },
  };
}

function retryAfterMs(headers, now) {
  const raw = headers?.["retry-after"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - now().getTime());
}

async function liveGet(url, headers, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(15_000),
    });
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    if (response.status >= 300 && response.status < 400) {
      return { status: response.status, headers: responseHeaders, body: "" };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOCUMENT_BYTES) {
      return {
        status: response.status,
        headers: responseHeaders,
        tooLarge: true,
        body: "",
      };
    }
    return {
      status: response.status,
      headers: responseHeaders,
      body: bytes.toString("utf8"),
    };
  } catch (error) {
    return {
      networkError: `Network request failed (${error.name}).`,
      status: 0,
      headers: {},
      body: "",
    };
  }
}
