import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { documentUrl } from "../ingest/docs.mjs";
import { analyzeOutsideIn } from "../outside-in/analyze.mjs";
import { USER_AGENT } from "../outside-in/constants.mjs";
import { requestHeaders } from "../outside-in/fetch.mjs";
import { evaluateRobots, parseRobots } from "../outside-in/robots.mjs";
import { selectCrawlLinks } from "./crawl.mjs";
import { detectInput } from "./detect.mjs";
import {
  analyzerDecision,
  analyzeAuthorizedTarget,
  behaviorsMarkdown,
} from "./evidence.mjs";
import { readGithubRepo } from "./github.mjs";
import { classifyProjectFile, projectName, selectProject } from "./local.mjs";
import { readNpmPackage, readNpmTarball } from "./npm.mjs";

export const READ_SCHEMA = "ree.read.v1";

const NOTE = [
  "Public documents only. There is no login, no cookie, and no Authorization header.",
  "A website is crawled one hop, same origin, for docs, pricing, feature, changelog, and API links.",
  "robots.txt is obeyed and requests are rate-limited.",
  "Source and binary files are not copied.",
  "Counts are what this run recorded. They are not a percentage of the original product.",
].join(" ");

export class ReadError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReadError";
  }
}

export async function readSource({
  input,
  outDir,
  name = null,
  authorized = false,
  fetchImpl = null,
  sleep = null,
  minIntervalMs = null,
  now = null,
  analyzeImpl = null,
} = {}) {
  if (!input || !outDir) throw new ReadError("Use read <input> --out DIR.");
  const detected = detectInput(input);
  if (detected.kind === "empty" || detected.kind === "missing")
    throw new ReadError(detected.reason);
  if (detected.kind === "npm" && detected.ok === false)
    throw new ReadError(detected.reason);
  if (detected.kind === "github" && detected.ok === false)
    throw new ReadError(detected.reason);
  const gap = minIntervalMs ?? (fetchImpl ? 0 : 1000);
  const pause =
    sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const liveFetch = fetchImpl ?? globalThis.fetch;
  const plan = await planInput({
    detected,
    name,
    authorized,
    fetchImpl: liveFetch,
    sleep: pause,
    minIntervalMs: gap,
    outDir,
    analyzeImpl,
  });
  const result = await analyzeOutsideIn({
    ...plan.request,
    fixture: plan.fixture ?? undefined,
    outDir,
    fetchImpl: plan.fixture
      ? async () => {
          throw new Error("read attempted a network fetch after collection");
        }
      : liveFetch,
    sleep: pause,
    minIntervalMs: plan.fixture ? 0 : gap,
    now: now ?? undefined,
  });
  const report = writeReport(outDir, {
    input: String(input),
    detected: plan.detected,
    network: plan.network,
    authorization: plan.authorization,
    skipped: plan.skipped,
    provenance: plan.provenance ?? [],
    spec: result.spec,
  });
  return { ...result, read: report };
}

async function planInput(options) {
  const { detected } = options;
  if (detected.kind === "url" && detected.ok === false) {
    return {
      detected: "website",
      network: false,
      authorization: "public",
      fixture: null,
      skipped: [{ target: detected.href, reason: detected.reason }],
      request: {
        target: { name: options.name || "public page", urls: [detected.href] },
      },
    };
  }
  if (detected.kind === "website") return planWebsite(detected, options);
  if (detected.kind === "github") return planGithub(detected, options);
  if (detected.kind === "npm") return planNpm(detected, options);
  if (detected.kind === "npm-tarball") return planTarball(detected, options);
  if (detected.kind === "file") return planFile(detected, options);
  if (detected.kind === "directory") return planDirectory(detected, options);
  throw new ReadError("That input is not a supported read target.");
}

async function planWebsite(detected, options) {
  const skipped = [];
  const url = detected.url;
  let html = null;
  const allowed = await robotsAllow(options.fetchImpl, url);
  if (!allowed.ok) {
    skipped.push({ target: url.href, reason: allowed.reason });
  } else {
    try {
      const response = await options.fetchImpl(url.href, {
        method: "GET",
        redirect: "manual",
        headers: requestHeaders(),
      });
      if (response.status >= 200 && response.status < 300)
        html = await response.text();
      else
        skipped.push({
          target: url.href,
          reason: `The first page returned HTTP ${response.status}. Linked pages were not selected.`,
        });
    } catch {
      skipped.push({
        target: url.href,
        reason:
          "The first page could not be read for links. The collector still requests that URL.",
      });
    }
  }
  const links = html
    ? selectCrawlLinks(html, url.href)
    : { selected: [], skipped: [] };
  skipped.push(...links.skipped);
  const pricing = links.selected.find((link) => link.role === "pricing");
  const changelog = links.selected.find((link) => link.role === "changelog");
  return {
    detected: "website",
    network: true,
    authorization: "public",
    fixture: null,
    skipped,
    request: {
      target: {
        name: chosen(options.name, url.hostname),
        urls: [url.href],
      },
      docs: links.selected
        .filter((link) => link.role === "docs")
        .map((link) => ({ url: link.url })),
      pricingUrl: pricing?.url ?? null,
      changelogUrl: changelog?.url ?? null,
    },
  };
}

async function planGithub(detected, options) {
  const read = await readGithubRepo({
    owner: detected.owner,
    repo: detected.repo,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    minIntervalMs: options.minIntervalMs,
  });
  return collected(read, {
    detected: "github",
    network: true,
    authorization: "public",
    name: chosen(
      options.name,
      read.name || `${detected.owner}/${detected.repo}`,
    ),
  });
}

async function planNpm(detected, options) {
  const read = await readNpmPackage({
    name: detected.name,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    minIntervalMs: options.minIntervalMs,
  });
  return collected(read, {
    detected: "npm",
    network: true,
    authorization: "public",
    name: chosen(options.name, read.name || detected.name),
  });
}

function planTarball(detected, options) {
  const read = readNpmTarball(detected.path);
  return collected(read, {
    detected: "npm-tarball",
    network: false,
    authorization: "local",
    name: chosen(options.name, read.name),
  });
}

function planFile(detected, options) {
  const rel = basename(detected.path);
  const text = readFileSync(detected.path, "utf8");
  const classified = classifyProjectFile(rel, text);
  const skipped = [];
  const documents = [];
  if (!classified) {
    const analyzer = analyzerDecision(detected.path);
    if (analyzer.reason) skipped.push({ target: rel, reason: analyzer.reason });
    else
      skipped.push({
        target: rel,
        reason:
          "Not an OpenAPI, Swagger, Postman, GraphQL, HTML, or Markdown document.",
      });
  } else if (classified.bodyKind === "types") {
    skipped.push({
      target: rel,
      reason:
        "A lone declaration file is read from a project folder or a tarball.",
    });
  } else {
    documents.push({
      url: documentUrl(rel),
      role: classified.role === "html" ? "root" : classified.role,
      kind: classified.kind,
      type: classified.type,
      body: text,
    });
  }
  return collected(
    { documents, skipped, name: rel },
    {
      detected: "file",
      network: false,
      authorization: "local",
      name: chosen(options.name, rel),
    },
  );
}

async function planDirectory(detected, options) {
  const selected = selectProject(detected.path);
  const documents = selected.selected.map((item) => ({
    url: item.url,
    role: item.role,
    kind: item.kind,
    type: item.type,
    body: item.body,
  }));
  const skipped = [...selected.skipped];
  const provenance = [];
  const decision = analyzerDecision(detected.path);
  if (decision.run) {
    if (options.authorized !== true) {
      skipped.push({
        target: detected.path,
        reason:
          "Static JavaScript analysis needs --authorized. Public docs in the folder were still read. The target was not executed.",
      });
    } else {
      const analyze = options.analyzeImpl ?? analyzeAuthorizedTarget;
      const evidence = await analyze({
        target: detected.path,
        outDir: options.outDir,
      });
      if (evidence?.skipped) {
        skipped.push({ target: detected.path, reason: evidence.skipped });
      } else {
        const rendered = behaviorsMarkdown(evidence?.behaviors);
        skipped.push(...rendered.skipped);
        if (rendered.markdown) {
          documents.push({
            url: documentUrl("analyzer-behaviors.md"),
            role: "docs",
            kind: "sdk-readme",
            type: "text/markdown; charset=utf-8",
            body: rendered.markdown,
          });
        }
        if (evidence?.evidence_id) {
          provenance.push({
            target: evidence.evidence_id,
            note: "Evidence id recorded. Behavior labels were promoted. Source text was not copied.",
          });
        }
      }
    }
  } else if (decision.reason && decision.detected?.input_type !== "directory") {
    skipped.push({ target: detected.path, reason: decision.reason });
  }
  return collected(
    {
      documents,
      skipped,
      name: projectName(detected.path) || basename(detected.path),
    },
    {
      detected: "directory",
      network: false,
      authorization: options.authorized ? "authorized" : "local",
      provenance,
      name: chosen(
        options.name,
        projectName(detected.path) || basename(detected.path),
      ),
    },
  );
}

function collected(read, meta) {
  const provenance = [
    ...(meta.provenance ?? []),
    ...(read.provenance ?? []),
    ...(read.calls ?? []).map((call) => ({
      target: call.url,
      note: "Public request. No Authorization header was sent.",
    })),
  ];
  if (read.documents.length === 0) {
    return {
      ...meta,
      provenance,
      fixture: emptyFixture(),
      skipped: read.skipped,
      request: {
        target: {
          name: meta.name,
          urls: ["https://owned.docs/empty"],
        },
      },
    };
  }
  const files = new Map(
    read.documents.map((doc) => [doc.url, { body: doc.body, type: doc.type }]),
  );
  const root =
    read.documents.find((doc) => doc.role === "root" || doc.role === "html") ??
    read.documents[0];
  const docs = read.documents.filter(
    (doc) => doc !== root && doc.role !== "pricing",
  );
  const pricing = read.documents.find(
    (doc) => doc.role === "pricing" && doc !== root,
  );
  return {
    ...meta,
    provenance,
    fixture: memoryFixture(files),
    skipped: read.skipped,
    request: {
      target: { name: meta.name, urls: [root.url] },
      docs: docs.map((doc) => ({ url: doc.url, kind: doc.kind })),
      pricingUrl: pricing?.url ?? null,
    },
  };
}

function memoryFixture(files) {
  return {
    reads: [],
    async respond(url) {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/robots.txt")) {
        return {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: "",
        };
      }
      const hit = files.get(parsed.href) ?? files.get(url);
      if (!hit)
        return {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: "",
        };
      return {
        status: 200,
        headers: { "content-type": hit.type },
        body: hit.body,
      };
    },
  };
}

function emptyFixture() {
  return memoryFixture(new Map());
}

async function robotsAllow(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(`${url.origin}/robots.txt`, {
      method: "GET",
      redirect: "manual",
      headers: requestHeaders(),
    });
  } catch {
    return {
      ok: false,
      reason: "robots.txt could not be read. Linked pages were not selected.",
    };
  }
  if (response.status === 404) return { ok: true };
  if (response.status !== 200)
    return {
      ok: false,
      reason: `robots.txt returned HTTP ${response.status}. Linked pages were not selected.`,
    };
  const body = await response.text();
  if (/<html[\s>]/iu.test(body))
    return {
      ok: false,
      reason:
        "robots.txt was not a robots document. Linked pages were not selected.",
    };
  const decision = evaluateRobots(parseRobots(body), USER_AGENT, url.pathname);
  if (!decision.allowed)
    return {
      ok: false,
      reason: "robots.txt disallows that page. Linked pages were not selected.",
    };
  return { ok: true };
}

function chosen(name, fallback) {
  const text = typeof name === "string" ? name.trim() : "";
  if (text) return text;
  const plain = String(fallback ?? "").trim();
  if (!plain) throw new ReadError("A document name is required.");
  return plain;
}

function writeReport(outDir, record) {
  const read = (record.spec.sources ?? []).map((source) => ({
    url: source.url,
    role: source.role,
    sha256: source.sha256,
    fetched_at: source.fetched_at,
  }));
  const report = {
    schema_version: READ_SCHEMA,
    input: record.input,
    detected: record.detected,
    network: record.network,
    authorization: record.authorization,
    status: record.spec.status,
    read,
    skipped: record.skipped,
    provenance: record.provenance ?? [],
    coverage: {
      documents_read: read.length,
      documents_skipped: record.skipped.length,
      features: record.spec.features?.length ?? 0,
      endpoints: record.spec.api?.endpoints?.length ?? 0,
    },
    note: NOTE,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "read.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  return report;
}
