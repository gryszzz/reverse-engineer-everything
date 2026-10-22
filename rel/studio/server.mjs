import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { routesForTarget } from "./engine-routes.mjs";
import {
  hasApplicationGraph,
  projectEngineEvidence,
  projectEngineGraph,
} from "./engine-window.mjs";
import { approveSetup } from "./setup-offers.mjs";
import { engineChildEnv } from "./tool-env.mjs";
import { writeUpload } from "./uploads.mjs";
import { approveLink, performLink, planLink } from "./links.mjs";
import { fileURLToPath } from "node:url";
import { classifyTarget } from "../intake.mjs";
import {
  exploreEvidence,
  exploreSemanticEvidence,
} from "../evidence-explorer.mjs";
import { cancelStaticAnalysis, startStaticAnalysis } from "./analysis.mjs";
import {
  claimRows,
  claimTimeline,
  moduleComparisons,
  planOwnedNativeProbe,
  rebuildPlan,
  rebuildTimeline,
  spawnOwnedNativeProbe,
  writeRebuild,
} from "./rebuild.mjs";
import { appendTimeline, readTimeline } from "./theater.mjs";
import {
  compareEdgeIds,
  compareSummaries,
  applicationEdgeIds,
} from "./diff.mjs";
import { loadEvidence } from "./evidence.mjs";
import { studioError } from "./errors.mjs";
import {
  launchOwnedProbe,
  launchPlanner,
  observationFromProbe,
  ownedFixturePlan,
} from "./experiment.mjs";
import {
  interpretRelationship,
  projectApplicationGraph,
  relationshipBasis,
} from "./graph.mjs";
import { withStudioLock } from "./lock.mjs";
import { createProjectStore, newId } from "./projects.mjs";
import {
  assessStudioReadiness,
  countStudioVerifications,
} from "./readiness.mjs";
import { renderStudioReport } from "./report.mjs";
import { factsFromEvidence } from "./diff.mjs";
import { diffArtifactPair } from "./diff-lab.mjs";
import { lessonCatalog, renderLesson } from "./lessons.mjs";
import { runLocalResearch } from "./research.mjs";
import { readRecordedSource } from "./source.mjs";
import {
  ownedTraceArgv,
  ownedTraceScenario,
  projectProcessCapture,
  spawnOwnedTrace,
  traceRuntimeReady,
} from "./trace.mjs";

const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/studio.css", ["studio.css", "text/css; charset=utf-8"]],
  ["/studio.js", ["studio.js", "text/javascript; charset=utf-8"]],
  ["/graph-view.js", ["graph-view.js", "text/javascript; charset=utf-8"]],
  ["/format.js", ["format.js", "text/javascript; charset=utf-8"]],
  ["/flow.js", ["flow.js", "text/javascript; charset=utf-8"]],
  ["/explain.js", ["explain.js", "text/javascript; charset=utf-8"]],
]);
const REMOTE_REASON =
  "Remote model calls are refused. No Evidence, source, or project text is uploaded.";
const experiments = new Map();

export function defaultStudioDataDir() {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "REE", "studio");
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "ree", "studio");
}

function send(
  res,
  status,
  body,
  type = "application/json; charset=utf-8",
  extra = {},
) {
  const payload = Buffer.from(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    ...extra,
  });
  res.end(payload);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value));
}

function readRaw(req, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        rejectBody(studioError("A dropped file exceeds 8 MiB.", 413));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", () =>
      rejectBody(studioError("Could not read the request.")),
    );
  });
}

function runSetupCommand(argv) {
  return new Promise((resolveCommand) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: engineChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 120000);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 16000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveCommand({
        exit_code: null,
        signal: null,
        stdout,
        stderr: error.message,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveCommand({ exit_code: code, signal, stdout, stderr });
    });
  });
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65536) {
        rejectBody(studioError("Request body exceeds 64 KiB.", 413));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw === "") return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(studioError("Expected a JSON object."));
      }
    });
    req.on("error", () =>
      rejectBody(studioError("Could not read the request.")),
    );
  });
}

function integerParam(value, fallback, max) {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max)
    throw studioError("A numeric query parameter is out of range.");
  return parsed;
}

function researchPath(root) {
  return join(root, "research.json");
}

function readResearchConfig(root) {
  const path = researchPath(root);
  if (!existsSync(path))
    return {
      enabled: false,
      key_configured: false,
      remote_calls: "refused",
      remote_reason: REMOTE_REASON,
    };
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 65536)
    throw studioError("research.json must be a file of at most 64 KiB.");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return {
    enabled: parsed.enabled === true,
    key_configured:
      typeof parsed.api_key === "string" && parsed.api_key.length > 0,
    remote_calls: "refused",
    remote_reason: REMOTE_REASON,
  };
}

function writeResearchEnabled(root, enabled) {
  if (typeof enabled !== "boolean")
    throw studioError("enabled must be true or false.");
  const path = researchPath(root);
  const current = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : {};
  current.enabled = enabled;
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
  return readResearchConfig(root);
}

function asStudio(fn) {
  try {
    return fn();
  } catch (error) {
    if (Number.isInteger(error?.status)) throw error;
    throw studioError(
      error instanceof Error ? error.message : "Request failed.",
    );
  }
}

function publicRoutes(path, kind) {
  return routesForTarget({ path, kind }).map((route) => ({
    id: route.id,
    label: route.label,
    status: route.status,
    detail: route.detail,
    provider: route.provider,
    command: route.command,
    family: route.family,
  }));
}

function intakeSnapshot(path) {
  const detected = asStudio(() => classifyTarget(path));
  return {
    id: newId("art_"),
    path: detected.target,
    added_at: new Date().toISOString(),
    intake: {
      kind: detected.kind,
      label: detected.label,
      capability: detected.capability,
      basis: detected.basis,
      meaning: detected.meaning,
      documentation: detected.documentation,
      needs: detected.needs,
      input_type: detected.input_type ?? null,
      exists: detected.exists,
      routes: publicRoutes(detected.target, detected.kind),
      note: "Intake classification only. No analysis has run.",
    },
  };
}

function requireRun(project, runId) {
  const run = project.runs.find((item) => item.id === runId);
  if (!run) throw studioError("Unknown run.", 404);
  if (run.status !== "completed" || !run.evidence_id)
    throw studioError("That run has no retained Evidence.", 409);
  return run;
}

function evidenceRecord(run) {
  return loadEvidence(join(run.output_dir, "evidence.json"));
}

function semanticWindow(record, find, limit) {
  const result = exploreSemanticEvidence(record, { find, limit });
  const edges = result.relations.map((relation) => {
    const basis = relationshipBasis(relation);
    let location = null;
    if (typeof relation.location === "string") {
      try {
        location = JSON.parse(relation.location);
      } catch {
        location = null;
      }
    }
    const source = {
      id: relation.source.id,
      label: relation.source.label,
      kind: relation.source.kind ?? null,
      group: relation.source.label,
      present: true,
    };
    const target = {
      id: relation.target.id,
      label: relation.target.label,
      kind: relation.target.kind ?? null,
      group: relation.target.label,
      present: true,
    };
    return {
      edge_id: relation.relation_id,
      relation: relation.relation,
      source,
      target,
      location,
      state: relation.state,
      confidence: relation.confidence,
      authority: relation.authority,
      basis,
      interpretation: interpretRelationship(record.operation, basis),
      limitations: (relation.limitations ?? []).slice(0, 8),
    };
  });
  const nodes = new Map();
  for (const edge of edges) {
    nodes.set(edge.source.id, edge.source);
    nodes.set(edge.target.id, edge.target);
  }
  return {
    graph: "semantic",
    operation: record.operation ?? null,
    evidence_id: result.evidence_id,
    graph_id: result.semantic_graph_id,
    coverage: result.coverage,
    total_nodes: result.counts.nodes,
    total_edges: result.counts.relations,
    matching: result.matching,
    displayed: result.displayed,
    truncated: result.truncated,
    offset: 0,
    nodes: [...nodes.values()],
    edges,
    execution_note:
      "Semantic relationships are a bounded static-analysis window. They are not captured executions.",
  };
}

function summaryOf(run) {
  if (run.summary) return { ...run.summary, evidence_id: run.evidence_id };
  const path = join(run.output_dir, "summary.json");
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (stat.size > 2_000_000) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function completedRun(project, artifactId) {
  return [...project.runs]
    .reverse()
    .find(
      (run) => run.artifact_id === artifactId && run.status === "completed",
    );
}

function evidenceFor(run) {
  if (!run?.output_dir) return null;
  const path = join(run.output_dir, "evidence.json");
  if (!existsSync(path) || statSync(path).size > 8_000_000) return null;
  try {
    return loadEvidence(path);
  } catch {
    return null;
  }
}

function diffLab(project, body) {
  const left = project.artifacts.find(
    (artifact) => artifact.id === body.left_artifact_id,
  );
  const right = project.artifacts.find(
    (artifact) => artifact.id === body.right_artifact_id,
  );
  if (!left || !right)
    throw studioError("Choose two artifacts in this project.", 404);
  if (left.id === right.id)
    throw studioError("Choose two different artifacts.", 409);
  return diffArtifactPair({
    left: { path: left.path, label: left.intake?.label ?? left.path },
    right: { path: right.path, label: right.intake?.label ?? right.path },
    leftRecord: evidenceFor(completedRun(project, left.id)),
    rightRecord: evidenceFor(completedRun(project, right.id)),
  });
}

function projectDiff(project, leftId, rightId) {
  const left = requireRun(project, leftId);
  const right = requireRun(project, rightId);
  const comparison = compareSummaries(summaryOf(left), summaryOf(right));
  const files = [left, right].map((run) =>
    join(run.output_dir, "evidence.json"),
  );
  const tooLarge = files.some((path) => statSync(path).size > 8_000_000);
  return {
    ...comparison,
    edge_ids: tooLarge
      ? {
          status: "skipped",
          reason:
            "Edge-id comparison skipped because an Evidence file exceeds 8 MiB.",
        }
      : compareEdgeIds(
          applicationEdgeIds(loadEvidence(files[0])),
          applicationEdgeIds(loadEvidence(files[1])),
        ),
  };
}

async function handleApi(context) {
  const { store, method, pathname, query, body, token } = context;
  if (method === "GET" && pathname === "/api/session")
    return {
      token,
      bind: "127.0.0.1",
      owned_fixture: "experiments/rel-first-lab",
      uploads: "local-copy",
      links: "approved-fetch",
      accounts: "none",
      onboarding_seen: existsSync(join(store.root, "onboarding.json")),
    };
  if (context.headerToken !== token)
    throw studioError("Missing studio token.", 401);
  if (method === "POST" && pathname === "/api/onboarding") {
    writeFileSync(
      join(store.root, "onboarding.json"),
      `${JSON.stringify({ seen_at: new Date().toISOString() })}\n`,
    );
    return { seen: true };
  }
  if (method === "GET" && pathname === "/api/board") {
    const { readOpportunityBoard } = await import("./product-flow.mjs");
    return readOpportunityBoard(store.root);
  }
  if (method === "POST" && pathname === "/api/board") {
    try {
      const { ingestOpportunity } = await import("./product-flow.mjs");
      return ingestOpportunity(store.root, body);
    } catch (error) {
      if (error?.status) throw error;
      throw studioError(
        error instanceof Error ? error.message : "Board ingest failed.",
        400,
      );
    }
  }
  if (method === "POST" && pathname === "/api/builds") {
    const { createBuild } = await import("./product-flow.mjs");
    return createBuild(store.root, body);
  }
  if (method === "GET" && pathname === "/api/lessons")
    return { lessons: lessonCatalog() };
  const lessonMatch = pathname.match(/^\/api\/lessons\/([a-z0-9-]+)$/u);
  if (method === "GET" && lessonMatch) {
    const lesson = await renderLesson(lessonMatch[1]);
    if (!lesson) throw studioError("Unknown lesson.", 404);
    return lesson;
  }
  if (method === "GET" && pathname === "/api/readiness")
    return assessStudioReadiness({
      verifiedCounts: countStudioVerifications(store),
    });
  if (method === "GET" && pathname === "/api/research")
    return readResearchConfig(store.root);
  if (method === "PUT" && pathname === "/api/research")
    return writeResearchEnabled(store.root, body.enabled);
  if (method === "POST" && pathname === "/api/setup") {
    const readiness = assessStudioReadiness({
      verifiedCounts: countStudioVerifications(store),
    });
    const argv = approveSetup({
      offerId: body.offer_id,
      approved: body.approved,
      commandDigest: body.command_digest,
      catalog: readiness.setup,
    });
    const result = await runSetupCommand(argv);
    return {
      argv,
      ...result,
      readiness: assessStudioReadiness({
        verifiedCounts: countStudioVerifications(store),
      }),
    };
  }
  if (method === "GET" && pathname === "/api/projects")
    return { projects: store.list() };
  if (method === "POST" && pathname === "/api/projects")
    return store.create(body);
  const projectId = pathname.match(
    /^\/api\/projects\/(prj_[a-f0-9]{32})/u,
  )?.[1];
  if (!projectId) throw studioError("Unknown API route.", 404);
  const rest = pathname.slice(`/api/projects/${projectId}`.length);
  if (method === "GET" && rest === "") return store.read(projectId);
  if (method === "PATCH" && rest === "")
    return store.update(projectId, (project) => {
      if (body.name !== undefined) project.name = body.name.trim();
      if (body.question !== undefined) project.question = body.question || null;
      if (body.mode !== undefined) {
        if (body.mode !== "simple" && body.mode !== "advanced")
          throw studioError("Mode must be simple or advanced.");
        project.mode = body.mode;
      }
      if (!project.name || project.name.length > 80)
        throw studioError("Project name must be 1–80 characters.");
      return project;
    });
  if (method === "POST" && rest === "/artifacts") {
    if (typeof body.path !== "string" || body.path.length > 4096)
      throw studioError("Provide a target path.");
    const artifact = intakeSnapshot(body.path);
    return store.update(projectId, (project) => {
      if (project.artifacts.some((item) => item.path === artifact.path))
        throw studioError("That artifact is already in the project.");
      project.artifacts.push(artifact);
      return project;
    });
  }
  if (method === "POST" && rest === "/links/plan") return planLink(body.input);
  if (method === "POST" && rest === "/links") {
    const plan = approveLink({
      input: body.input,
      approved: body.approved,
      planDigest: body.plan_digest,
    });
    const destination = join(
      store.directory(projectId),
      "links",
      newId("lnk_"),
    );
    const saved = await performLink(plan, { destination });
    const artifact = intakeSnapshot(saved.path);
    artifact.provenance = {
      input: plan.input,
      kind: saved.kind,
      executes: false,
      fetches: saved.fetches,
      destination: saved.path,
    };
    artifact.intake.note =
      "Fetched after an approved plan. The bytes were not executed.";
    return store.update(projectId, (project) => {
      project.artifacts.push(artifact);
      return project;
    });
  }
  if (method === "POST" && rest === "/artifacts/owned-fixture") {
    const artifact = intakeSnapshot(
      realpathSync(
        fileURLToPath(
          new URL("../../experiments/rel-first-lab/", import.meta.url),
        ),
      ),
    );
    return store.update(projectId, (project) => {
      if (!project.artifacts.some((item) => item.path === artifact.path))
        project.artifacts.push(artifact);
      return project;
    });
  }
  const refreshRoutes = rest.match(
    /^\/artifacts\/(art_[a-f0-9]{16})\/routes$/u,
  );
  if (method === "POST" && refreshRoutes) {
    return store.update(projectId, (project) => {
      const artifact = project.artifacts.find(
        (item) => item.id === refreshRoutes[1],
      );
      if (!artifact) throw studioError("Unknown artifact.", 404);
      const detected = asStudio(() => classifyTarget(artifact.path));
      artifact.intake.routes = publicRoutes(detected.target, detected.kind);
      return project;
    });
  }
  if (method === "POST" && rest === "/runs")
    return startStaticAnalysis({
      store,
      projectId,
      artifactId: body.artifact_id,
      question: body.question ?? null,
      authorized: body.authorized,
      routeId: typeof body.route_id === "string" ? body.route_id : null,
    });
  const cancelRun = rest.match(/^\/runs\/(run_[a-f0-9]{16})\/cancel$/u);
  if (method === "POST" && cancelRun) {
    if (!cancelStaticAnalysis(store.root, cancelRun[1]))
      throw studioError("That analysis is not running.", 409);
    return store.read(projectId);
  }
  const timeline = rest.match(/^\/runs\/(run_[a-f0-9]{16})\/timeline$/u);
  if (method === "GET" && timeline) {
    const run = store
      .read(projectId)
      .runs.find((item) => item.id === timeline[1]);
    if (!run) throw studioError("Unknown run.", 404);
    return { events: readTimeline(run.output_dir) };
  }
  const rebuildPreview = rest.match(
    /^\/runs\/(run_[a-f0-9]{16})\/rebuild\/preview$/u,
  );
  if (method === "POST" && rebuildPreview) {
    const project = store.read(projectId);
    const run = requireRun(project, rebuildPreview[1]);
    const record = evidenceRecord(run);
    const artifact = project.artifacts.find(
      (item) => item.id === run.artifact_id,
    );
    return {
      ...rebuildPlan(record, body.output),
      comparisons: artifact ? moduleComparisons(record, artifact.path) : [],
    };
  }
  const rebuildWrite = rest.match(/^\/runs\/(run_[a-f0-9]{16})\/rebuild$/u);
  if (method === "POST" && rebuildWrite) {
    if (body.approved !== true)
      throw studioError(
        "Check the box to write the reconstructed module map.",
        403,
      );
    const run = requireRun(store.read(projectId), rebuildWrite[1]);
    const written = writeRebuild(evidenceRecord(run), body.output, body.digest);
    for (const event of rebuildTimeline(written))
      appendTimeline(run.output_dir, event);
    return written;
  }
  if (method === "POST" && rest === "/trace") {
    if (body.approved !== true)
      throw studioError("Check the box to run the owned process capture.", 403);
    if (!traceRuntimeReady())
      throw studioError(
        "The built runtime is absent, so capture-process was not started.",
        409,
      );
    const project = store.read(projectId);
    if (project.trace?.status === "running")
      throw studioError("A trace is already running.", 409);
    const scenarioPath = join(store.root, "trace-scenario.json");
    const scenario = ownedTraceScenario();
    writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
    const labels = [];
    for (const run of project.runs) {
      if (run.status !== "completed") continue;
      const facts = factsFromEvidence(evidenceFor(run));
      for (const file of facts.evidence_files ?? []) labels.push(file);
    }
    const startedAt = new Date().toISOString();
    store.update(projectId, (current) => {
      current.trace = {
        status: "running",
        separate_from_static_evidence: true,
        started_at: startedAt,
        finished_at: null,
        argv: ownedTraceArgv(scenarioPath),
        projection: null,
        error: null,
      };
      return current;
    });
    const child = spawnOwnedTrace(scenarioPath, engineChildEnv());
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 8_000_000) stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      let projection = null;
      let error = null;
      try {
        const parsed = JSON.parse(stdout);
        if (parsed?.error)
          error =
            typeof parsed.message === "string" ? parsed.message : parsed.error;
        else projection = projectProcessCapture(parsed, labels);
      } catch {
        error = `Capture exited ${code} signal ${signal}. ${stderr.slice(0, 400)}`;
      }
      if (!projection && !error)
        error = `Capture exited ${code} signal ${signal}.`;
      store.update(projectId, (current) => {
        current.trace = {
          ...current.trace,
          status: projection ? "completed" : "failed",
          finished_at: new Date().toISOString(),
          projection,
          error,
        };
        return current;
      });
    });
    return store.read(projectId);
  }
  if (method === "POST" && rest === "/native-probe") {
    if (body.approved !== true)
      throw studioError(
        "Check the box to run the owned native reconstruction probe.",
        403,
      );
    const project = store.read(projectId);
    const artifact = project.artifacts.find(
      (item) => item.id === body.artifact_id,
    );
    if (!artifact) throw studioError("Unknown artifact.", 404);
    const plan = planOwnedNativeProbe(artifact.path, body.output);
    if (project.native_probe?.status === "running")
      throw studioError("A native probe is already running.", 409);
    const timelineDir = project.runs.find(
      (item) =>
        item.artifact_id === artifact.id &&
        item.status === "completed" &&
        item.output_dir,
    )?.output_dir;
    const startedAt = new Date().toISOString();
    store.update(projectId, (current) => {
      current.native_probe = {
        status: "running",
        artifact_id: artifact.id,
        output: plan.output,
        argv: plan.argv,
        started_at: startedAt,
        finished_at: null,
        claims: [],
        note: plan.note,
      };
      return current;
    });
    if (timelineDir)
      appendTimeline(timelineDir, {
        source: "verify-reconstruction",
        phase: "native-probe",
        message: "Started the owned native reconstruction probe.",
      });
    const child = spawnOwnedNativeProbe(plan, { env: engineChildEnv() });
    const timer = setTimeout(() => child.kill("SIGTERM"), 300000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      let claims = [];
      let error = null;
      try {
        const summaryPath = join(plan.output, "summary.json");
        if (existsSync(summaryPath))
          claims = claimRows(JSON.parse(readFileSync(summaryPath, "utf8")));
        else error = `Owned probe exited ${code} signal ${signal}.`;
      } catch (cause) {
        error =
          cause instanceof Error
            ? cause.message
            : "Could not read the probe summary.";
      }
      if (timelineDir) {
        for (const event of claimTimeline(claims))
          appendTimeline(timelineDir, event);
        if (error)
          appendTimeline(timelineDir, {
            source: "verify-reconstruction",
            phase: "native-probe",
            message: error,
          });
      }
      store.update(projectId, (current) => {
        if (!current.native_probe) return current;
        current.native_probe = {
          ...current.native_probe,
          status: error ? "failed" : "completed",
          finished_at: new Date().toISOString(),
          claims,
          error,
        };
        return current;
      });
    });
    return store.read(projectId);
  }
  const evidence = rest.match(/^\/runs\/(run_[a-f0-9]{16})\/evidence$/u);
  if (method === "GET" && evidence) {
    const run = requireRun(store.read(projectId), evidence[1]);
    const record = evidenceRecord(run);
    const limit = integerParam(query.get("limit"), 12, 40);
    if (limit < 1) throw studioError("Limit must be at least 1.");
    const find = query.get("find") ?? "";
    if (query.get("graph") === "semantic") {
      if (!hasApplicationGraph(record))
        throw studioError(
          "This Evidence record has no semantic application graph.",
          409,
        );
      return asStudio(() => exploreSemanticEvidence(record, { find, limit }));
    }
    if (!hasApplicationGraph(record))
      return projectEngineEvidence(record, { find, limit });
    return asStudio(() => exploreEvidence(record, { find, limit }));
  }
  const graph = rest.match(/^\/runs\/(run_[a-f0-9]{16})\/graph$/u);
  if (method === "GET" && graph) {
    const run = requireRun(store.read(projectId), graph[1]);
    const record = evidenceRecord(run);
    const find = query.get("find") ?? "";
    if (!hasApplicationGraph(record)) {
      const requested = integerParam(query.get("limit"), 80, 200);
      return projectEngineGraph(record, {
        find,
        limit: Math.max(1, requested),
      });
    }
    if (query.get("graph") === "semantic") {
      const requested = integerParam(query.get("limit"), 40, 200);
      return asStudio(() =>
        semanticWindow(record, find, Math.min(40, Math.max(1, requested))),
      );
    }
    const limit = integerParam(query.get("limit"), 80, 200);
    return asStudio(() =>
      projectApplicationGraph(record, {
        find,
        relation: query.get("relation") ?? "",
        basis: query.get("basis") ?? "",
        limit: Math.max(1, limit),
        offset: integerParam(query.get("offset"), 0, 100000),
      }),
    );
  }
  const source = rest.match(/^\/runs\/(run_[a-f0-9]{16})\/source$/u);
  if (method === "GET" && source) {
    const run = requireRun(store.read(projectId), source[1]);
    const artifact = store
      .read(projectId)
      .artifacts.find((item) => item.id === run.artifact_id);
    if (!artifact)
      throw studioError("The run's artifact is no longer in the project.", 404);
    const record = evidenceRecord(run);
    if (!hasApplicationGraph(record))
      return {
        available: false,
        evidence_id: record.evidence_id,
        reason:
          "This route does not record a JavaScript source location. Use the statement path on the Evidence.",
      };
    return asStudio(() =>
      readRecordedSource(record, query.get("edge_id") ?? "", artifact.path),
    );
  }
  if (method === "POST" && rest === "/diff-lab")
    return diffLab(store.read(projectId), body);
  if (method === "GET" && rest === "/diff")
    return projectDiff(
      store.read(projectId),
      query.get("left") ?? "",
      query.get("right") ?? "",
    );
  if (method === "GET" && rest === "/report")
    return { markdown: renderStudioReport(store.read(projectId)) };
  if (method === "POST" && rest === "/report") {
    const markdown = renderStudioReport(store.read(projectId));
    const path = join(store.directory(projectId), "REE_STUDIO_REPORT.md");
    writeFileSync(path, markdown);
    return { path, markdown };
  }
  if (method === "POST" && rest === "/research") {
    const config = readResearchConfig(store.root);
    if (!config.enabled)
      throw studioError("Research is off for this data directory.", 403);
    const project = store.read(projectId);
    const completed = project.runs.filter((run) => run.status === "completed");
    const latest = completed.at(-1) ?? null;
    const record = latest ? evidenceRecord(latest) : null;
    const diff =
      completed.length >= 2
        ? projectDiff(project, completed.at(-2).id, completed.at(-1).id)
        : null;
    const experiment =
      [...project.experiments].reverse().find((item) => item.observation) ??
      null;
    const result = runLocalResearch({
      enabled: true,
      keyConfigured: config.key_configured,
      project,
      record,
      diff,
      experiment,
    });
    if (result.tool_calls > result.tool_call_budget)
      throw studioError("Research exceeded its tool-call budget.", 409);
    const session = {
      id: newId("res_"),
      created_at: new Date().toISOString(),
      ...result,
    };
    return store.update(projectId, (current) => {
      current.research_sessions.push(session);
      if (current.research_sessions.length > 5)
        current.research_sessions.shift();
      return current;
    });
  }
  if (method === "GET" && rest === "/experiments/preview") {
    const plan = ownedFixturePlan();
    return {
      fixture: "experiments/rel-first-lab",
      query: plan.query,
      argv: plan.argv,
      cwd: plan.cwd,
      timeout_ms: plan.timeout_ms,
      max_stdout_bytes: plan.max_stdout_bytes,
      hypotheses: plan.hypotheses,
      bound_files: plan.files,
      plan_digest: plan.plan_digest,
      planner: await launchPlanner(),
      existing_static_evidence: store
        .read(projectId)
        .runs.filter((run) => run.status === "completed")
        .map((run) => ({
          id: run.id,
          evidence_id: run.evidence_id,
          counts: run.summary?.counts ?? null,
        })),
      approval:
        "Nothing runs until a later request repeats this digest and sets approved to true.",
      separation:
        "An approved probe stores runtime output on the experiment. It does not modify static Evidence.",
    };
  }
  if (method === "POST" && rest === "/experiments") {
    if (body.approved !== true)
      throw studioError(
        "The owned-fixture probe requires approved: true.",
        403,
      );
    const plan = ownedFixturePlan();
    if (body.plan_digest !== plan.plan_digest)
      throw studioError(
        "The preview changed. Review the command again before approving.",
        409,
      );
    if (experiments.has(store.root))
      throw studioError("An owned-fixture probe is already running.", 409);
    experiments.set(store.root, { id: "pending", cancel() {} });
    let planner;
    try {
      planner = await launchPlanner();
    } catch (error) {
      experiments.delete(store.root);
      throw error;
    }
    const experimentId = newId("exp_");
    const record = {
      id: experimentId,
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      plan_digest: plan.plan_digest,
      command: { argv: plan.argv, cwd: plan.cwd, timeout_ms: plan.timeout_ms },
      hypotheses: plan.hypotheses,
      planner,
      observation: null,
      comparison: [],
      separation:
        "Runtime capture stays on this experiment record and is not merged into static evidence.json.",
      engine_reassessment: "not-run",
      engine_reassessment_reason:
        "The probe result is not sent to discriminate-finite-hypotheses because it has no REA Evidence ID.",
    };
    let project;
    try {
      project = await withStudioLock(store.root, () =>
        store.update(projectId, (current) => {
          current.experiments.push(record);
          return current;
        }),
      );
    } catch (error) {
      if (experiments.get(store.root)?.id === "pending")
        experiments.delete(store.root);
      throw error;
    }
    const handle = launchOwnedProbe(plan);
    experiments.set(store.root, { id: experimentId, cancel: handle.cancel });
    void handle.done.then((result) =>
      withStudioLock(store.root, () => {
        const current = experiments.get(store.root);
        const stopped = current?.cancelled === true;
        experiments.delete(store.root);
        const outcome = observationFromProbe(result);
        store.update(projectId, (currentProject) => {
          const saved = currentProject.experiments.find(
            (item) => item.id === experimentId,
          );
          if (!saved) return currentProject;
          Object.assign(saved, outcome, {
            status: stopped ? "cancelled" : outcome.status,
            finished_at: new Date().toISOString(),
          });
          return currentProject;
        });
      }),
    );
    return project;
  }
  const cancelExperiment = rest.match(
    /^\/experiments\/(exp_[a-f0-9]{16})\/cancel$/u,
  );
  if (method === "POST" && cancelExperiment) {
    const current = experiments.get(store.root);
    if (!current || current.id !== cancelExperiment[1])
      throw studioError("That probe is not running.", 409);
    current.cancelled = true;
    current.cancel();
    return store.read(projectId);
  }
  throw studioError("Unknown API route.", 404);
}

export function openStudioInBrowser(url) {
  const platform = process.platform;
  const spec =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd.exe", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(spec[0], spec[1], {
    stdio: "ignore",
    detached: platform !== "win32",
    windowsHide: true,
  });
  child.on("error", () => {
    console.error(
      "The browser did not open. Copy the printed local URL instead.",
    );
  });
  child.unref();
}

export async function startStudio({
  port = 0,
  dataDir = defaultStudioDataDir(),
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw studioError("The studio port must be an integer from 0 to 65535.");
  const store = createProjectStore(resolve(dataDir));
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    try {
      const address = req.socket.remoteAddress;
      if (
        address !== "127.0.0.1" &&
        address !== "::1" &&
        address !== "::ffff:127.0.0.1"
      ) {
        sendJson(res, 403, {
          error: "Studio requests must come from this machine.",
        });
        return;
      }
      const boundPort = server.address().port;
      const host = req.headers.host;
      if (
        host !== `127.0.0.1:${boundPort}` &&
        host !== `localhost:${boundPort}`
      ) {
        sendJson(res, 403, { error: "Studio only accepts its loopback host." });
        return;
      }
      const origin = req.headers.origin;
      if (
        typeof origin === "string" &&
        origin !== `http://127.0.0.1:${boundPort}` &&
        origin !== `http://localhost:${boundPort}`
      ) {
        sendJson(res, 403, {
          error: "Cross-origin studio requests are refused.",
        });
        return;
      }
      const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
      if (req.method === "GET" || req.method === "HEAD") {
        const file = FILES.get(url.pathname);
        if (file) {
          const data = await readFile(join(PUBLIC, file[0]));
          res.writeHead(req.method === "HEAD" ? 200 : 200, {
            "Content-Type": file[1],
            "Content-Length": data.length,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy":
              "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "Referrer-Policy": "no-referrer",
            "X-Frame-Options": "DENY",
          });
          res.end(req.method === "HEAD" ? undefined : data);
          return;
        }
      }
      if (!url.pathname.startsWith("/api/")) {
        send(
          res,
          404,
          "Not part of the Investigation Studio.",
          "text/plain; charset=utf-8",
        );
        return;
      }
      if (!["GET", "POST", "PUT", "PATCH"].includes(req.method)) {
        sendJson(res, 405, { error: "Method not allowed." });
        return;
      }
      const upload = url.pathname.match(
        /^\/api\/projects\/(prj_[a-f0-9]{32})\/artifacts\/bytes$/u,
      );
      if (req.method === "POST" && upload) {
        if (req.headers["x-ree-studio-token"] !== token)
          throw studioError("Missing studio token.", 401);
        const bytes = await readRaw(req, 8 * 1024 * 1024);
        const saved = writeUpload({
          directory: store.directory(upload[1]),
          batchId:
            typeof req.headers["x-ree-upload-batch"] === "string"
              ? req.headers["x-ree-upload-batch"]
              : null,
          name: req.headers["x-ree-artifact-name"],
          relative:
            typeof req.headers["x-ree-artifact-relative"] === "string"
              ? req.headers["x-ree-artifact-relative"]
              : null,
          bytes,
        });
        let project = null;
        if (req.headers["x-ree-classify"] === "true") {
          const artifact = intakeSnapshot(saved.classifyPath);
          project = store.update(upload[1], (current) => {
            if (current.artifacts.some((item) => item.path === artifact.path))
              throw studioError("That artifact is already in the project.");
            current.artifacts.push(artifact);
            return current;
          });
        }
        sendJson(res, 201, {
          batch_id: saved.batchId,
          path: saved.path,
          project,
        });
        return;
      }
      const hasBody = req.method !== "GET";
      if (
        hasBody &&
        !String(req.headers["content-type"] ?? "").includes("application/json")
      )
        throw studioError("Send application/json.");
      const body = hasBody ? await readBody(req) : {};
      if (
        hasBody &&
        (body === null || typeof body !== "object" || Array.isArray(body))
      )
        throw studioError("Expected a JSON object.");
      const value = await handleApi({
        store,
        method: req.method,
        pathname: url.pathname,
        query: url.searchParams,
        body,
        token,
        headerToken: req.headers["x-ree-studio-token"],
      });
      sendJson(res, req.method === "POST" ? 201 : 200, value);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      sendJson(res, status, {
        error: status === 500 ? "The studio request failed." : error.message,
      });
    }
  });
  await new Promise((resolveReady, rejectReady) => {
    const onError = (error) => rejectReady(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveReady();
    });
  });
  const actualPort = server.address().port;
  return {
    server,
    token,
    dataDir: store.root,
    url: `http://127.0.0.1:${actualPort}/`,
  };
}
