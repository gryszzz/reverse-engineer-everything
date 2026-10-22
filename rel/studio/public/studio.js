import { el, statusClass } from "./format.js";
import { mountGraph } from "./graph-view.js";

const state = {
  view: "overview",
  projects: [],
  project: null,
  readiness: null,
  researchConfig: null,
  notice: "",
  error: "",
  edge: null,
  source: null,
  graph: null,
  evidence: null,
  preview: null,
  diff: null,
  report: "",
  authorized: false,
};

const views = [
  ["overview", "Overview"],
  ["intake", "Intake"],
  ["readiness", "Readiness"],
  ["evidence", "Evidence"],
  ["graph", "Graph"],
  ["research", "Research"],
  ["experiment", "Experiment"],
  ["report", "Report"],
];

let token = "";

async function api(path, options = {}) {
  const headers = {};
  if (token) headers["x-ree-studio-token"] = token;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function setError(error) {
  state.error = error instanceof Error ? error.message : String(error);
  state.notice = "";
  draw();
}

function field(label, child) {
  return el("label", { class: "field" }, [label, child]);
}

function button(label, onclick, attrs = {}) {
  return el(
    "button",
    {
      type: "button",
      ...attrs,
      onclick: (event) => {
        Promise.resolve(onclick(event)).catch(setError);
      },
    },
    label,
  );
}

function latestRun() {
  return (
    state.project?.runs?.findLast?.((run) => run.status === "completed") ??
    [...(state.project?.runs ?? [])]
      .reverse()
      .find((run) => run.status === "completed") ??
    null
  );
}

function mode() {
  return state.project?.mode ?? "simple";
}

async function refreshProject() {
  if (!state.project) return;
  state.project = await api(`/api/projects/${state.project.id}`);
  const busy = [...state.project.runs, ...state.project.experiments].some(
    (item) => item.status === "running",
  );
  if (busy) setTimeout(() => refreshProject().then(draw).catch(setError), 800);
}

function shell() {
  const root = document.querySelector("#app");
  root.replaceChildren();
  const advanced = mode() === "advanced";
  root.append(
    el("header", { class: "top" }, [
      el("div", { class: "brand" }, [
        el("p", { class: "mark" }, "REE"),
        el("div", {}, [
          el("h1", {}, "Investigation Studio"),
          el("p", { class: "tag" }, "Local evidence. No account. No upload."),
        ]),
      ]),
      el("div", { class: "top-actions" }, [
        el("span", { class: "pill" }, "127.0.0.1"),
        button(advanced ? "Advanced" : "Simple", async () => {
          if (!state.project) return;
          state.project = await api(`/api/projects/${state.project.id}`, {
            method: "PATCH",
            body: { mode: advanced ? "simple" : "advanced" },
          });
          draw();
        }),
      ]),
    ]),
    el("div", { class: "layout" }, [
      el("nav", { class: "rail", "aria-label": "Studio" }, [
        el("p", { class: "rail-label" }, "Workspace"),
        ...views.map(([id, label]) =>
          button(
            label,
            () => {
              state.view = id;
              draw();
            },
            {
              class: state.view === id ? "nav current" : "nav",
              "aria-current": state.view === id ? "page" : undefined,
            },
          ),
        ),
        el("p", { class: "rail-label" }, "Projects"),
        ...state.projects.map((project) =>
          button(project.name || project.id, () => openProject(project.id), {
            class: state.project?.id === project.id ? "nav current" : "nav",
          }),
        ),
      ]),
      el("main", { id: "main", tabindex: "-1" }, [
        state.error
          ? el("p", { class: "banner bad", role: "alert" }, state.error)
          : null,
        state.notice
          ? el("p", { class: "banner", role: "status" }, state.notice)
          : null,
        panel(),
      ]),
    ]),
  );
}

function panel() {
  if (state.view === "readiness") return readinessPanel();
  if (!state.project) return welcome();
  if (state.view === "intake") return intakePanel();
  if (state.view === "evidence") return evidencePanel();
  if (state.view === "graph") return graphPanel();
  if (state.view === "research") return researchPanel();
  if (state.view === "experiment") return experimentPanel();
  if (state.view === "report") return reportPanel();
  return overviewPanel();
}

function welcome() {
  const name = el("input", {
    id: "project-name",
    maxlength: "80",
    value: "First investigation",
  });
  const question = el("input", {
    id: "project-question",
    maxlength: "500",
    value: "Which files import which?",
  });
  return el("section", { class: "panel" }, [
    el("h2", {}, "Start a local investigation"),
    el(
      "p",
      {},
      "Create a project on this machine, add an artifact you are allowed to inspect, and run static JavaScript analysis through the REA engine. Projects resume from the studio data directory.",
    ),
    field("Project name", name),
    field("Question", question),
    button(
      "Create project",
      async () => {
        const project = await api("/api/projects", {
          method: "POST",
          body: { name: name.value, question: question.value, mode: "simple" },
        });
        await loadProjects();
        await openProject(project.id);
      },
      { class: "primary" },
    ),
  ]);
}

function overviewPanel() {
  const project = state.project;
  const run = latestRun();
  return el("section", { class: "panel" }, [
    el("h2", {}, project.name),
    el("p", {}, project.question || "No question saved yet."),
    el("dl", { class: "facts" }, [
      fact("Artifacts", project.artifacts.length),
      fact("Static runs", project.runs.length),
      fact("Latest Evidence", run?.evidence_id || "none yet"),
      fact("Experiments", project.experiments.length),
    ]),
    mode() === "advanced"
      ? el(
          "pre",
          { class: "mono" },
          `Project file stays under the studio data directory.\nProject id: ${project.id}`,
        )
      : el(
          "p",
          { class: "note" },
          "Simple Mode hides raw commands. Switch to Advanced when you want providers, Evidence ids, and the exact analyzer command.",
        ),
  ]);
}

function fact(label, value) {
  return el("div", {}, [el("dt", {}, label), el("dd", {}, String(value))]);
}

function intakePanel() {
  const path = el("input", {
    id: "artifact-path",
    placeholder: "/absolute/path/to/app",
  });
  const question = el("input", {
    id: "question",
    value: state.project.question || "",
    maxlength: "500",
  });
  const checkbox = el("input", {
    type: "checkbox",
    id: "authorized",
    onchange: (event) => {
      state.authorized = event.target.checked;
    },
  });
  if (state.authorized) checkbox.checked = true;
  return el("section", { class: "panel" }, [
    el("h2", {}, "Artifact intake"),
    el(
      "p",
      {},
      "Classification reads a directory listing or the first 32 bytes of a file. It does not analyze or launch the target.",
    ),
    button("Use the owned JavaScript fixture", () => addOwned(), {
      class: "primary",
    }),
    field("Path you are authorized to inspect", path),
    button("Classify path", () => addPath(path.value)),
    el("div", { class: "stack" }, state.project.artifacts.map(artifactCard)),
    el("h3", {}, "Static analysis"),
    field("Question stored with the next run", question),
    el("label", { class: "check" }, [
      checkbox,
      "I am authorized to inspect the selected target. This reads source and does not launch it.",
    ]),
    button("Run static analysis", () => analyze(question.value), {
      class: "primary",
    }),
    el("div", { class: "stack" }, state.project.runs.map(runCard)),
  ]);
}

function artifactCard(artifact) {
  return el("article", { class: "card", dataset: { artifact: artifact.id } }, [
    el("h3", {}, artifact.intake.label),
    el("p", {}, artifact.path),
    el("p", {}, artifact.intake.basis),
    el(
      "p",
      { class: statusClass(artifact.intake.capability) },
      artifact.intake.capability,
    ),
    el("p", { class: "note" }, artifact.intake.note),
  ]);
}

function runCard(run) {
  const rows = [
    el("h3", {}, `${run.status} · ${run.kind}`),
    el(
      "p",
      { class: statusClass(run.status) },
      run.evidence_id || run.error || "Waiting for the analyzer.",
    ),
  ];
  if (run.summary?.counts)
    rows.push(
      el(
        "p",
        {},
        `${run.summary.counts.nodes} nodes, ${run.summary.counts.edges} edges.`,
      ),
    );
  if (mode() === "advanced" && run.command?.argv)
    rows.push(el("pre", { class: "mono" }, run.command.argv.join(" ")));
  if (run.status === "running")
    rows.push(button("Cancel analysis", () => cancelRun(run.id)));
  return el("article", { class: "card" }, rows);
}

function readinessPanel() {
  const report = state.readiness;
  if (!report)
    return el("section", { class: "panel" }, [
      el("p", {}, "Reading readiness…"),
    ]);
  return el("section", { class: "panel" }, [
    el("h2", {}, "What this machine can actually do"),
    el("p", {}, report.verification_meaning),
    el(
      "p",
      { class: "note" },
      `Runtime build: ${report.runtime_built ? "present" : "missing"}. Host platform: ${report.host?.host?.platform ?? "unknown"}.`,
    ),
    el("div", { class: "stack" }, report.routes.map(routeCard)),
    mode() === "advanced"
      ? el(
          "pre",
          { class: "mono" },
          JSON.stringify(report.tool_commands_on_path, null, 2),
        )
      : null,
  ]);
}

function routeCard(route) {
  return el("article", { class: "card" }, [
    el("h3", {}, route.label),
    el("p", {}, `Engine: ${route.engine}. Studio: ${route.studio}.`),
    el(
      "p",
      {},
      `Prerequisites: ${route.prerequisites}. Configured: ${route.configured}.`,
    ),
    el(
      "p",
      { class: statusClass(route.verified_on_host) },
      route.verified_on_host,
    ),
    el("p", { class: "note" }, route.notes),
  ]);
}

function evidencePanel() {
  const find = el("input", { id: "evidence-find", value: "cli.mjs" });
  return el("section", { class: "panel" }, [
    el("h2", {}, "Evidence"),
    el(
      "p",
      {},
      "Search uses the saved application graph. A hit is a recorded relationship, not proof that code ran.",
    ),
    field("Find", find),
    button("Search saved Evidence", () => loadEvidence(find.value), {
      class: "primary",
    }),
    state.evidence
      ? evidenceResult(state.evidence)
      : el("p", { class: "empty" }, "No Evidence window loaded."),
  ]);
}

function evidenceResult(result) {
  return el("div", {}, [
    el(
      "p",
      {},
      `Evidence ${result.evidence_id}. Matching ${result.matching}; showing ${result.displayed}.`,
    ),
    el("p", { class: "note" }, result.status || ""),
    el(
      "ul",
      {},
      (result.edges || result.relations || []).map((edge) =>
        el(
          "li",
          {},
          `${edge.source?.label ?? ""} → ${edge.target?.label ?? ""} (${edge.edge_id || edge.relation_id}) ${edge.state || ""} ${edge.confidence || ""}`,
        ),
      ),
    ),
  ]);
}

function graphPanel() {
  const find = el("input", { id: "graph-find", value: "" });
  const basis = el(
    "select",
    { id: "graph-basis" },
    [
      ["", "Any basis"],
      ["inferred", "Inferred"],
      ["derived", "Derived"],
      ["observed", "Observed"],
      ["unclassified", "Unclassified"],
    ].map(([value, label]) => el("option", { value }, label)),
  );
  const holder = el("div", { id: "graph-holder" });
  if (state.graph) mountGraph(holder, state.graph, selectEdge);
  return el("section", { class: "panel" }, [
    el("h2", {}, "Architecture graph"),
    el(
      "p",
      {},
      "The map contains only relationships stored on the selected Evidence record. Static inference stays distinct from a captured execution.",
    ),
    field("Filter", find),
    field("Basis", basis),
    button("Load window", () => loadGraph(find.value, basis.value), {
      class: "primary",
    }),
    holder,
    state.edge ? edgeDetail() : null,
    state.source ? sourceDetail() : null,
  ]);
}

function edgeDetail() {
  const edge = state.edge;
  return el("article", { class: "card" }, [
    el("h3", {}, edge.relation),
    el("p", {}, `${edge.source.label} → ${edge.target.label}`),
    el("p", {}, edge.interpretation),
    el(
      "p",
      {},
      `State ${edge.state || "unrecorded"}; confidence ${edge.confidence || "unrecorded"}; authority ${edge.authority || "unrecorded"}.`,
    ),
    mode() === "advanced"
      ? el("pre", { class: "mono" }, JSON.stringify(edge.location, null, 2))
      : null,
    button("Open recorded source", () => loadSource(edge.edge_id)),
  ]);
}

function sourceDetail() {
  const source = state.source;
  if (!source.available)
    return el(
      "p",
      { class: "note" },
      source.reason || "Source excerpt unavailable.",
    );
  return el(
    "pre",
    { class: "mono" },
    source.lines
      .map(
        (line) => `${line.highlighted ? ">" : " "} ${line.line}: ${line.text}`,
      )
      .join("\n"),
  );
}

function researchPanel() {
  const config = state.researchConfig;
  const sessions = state.project.research_sessions ?? [];
  return el("section", { class: "panel" }, [
    el("h2", {}, "Research notebook"),
    el("p", {}, config?.remote_reason || "Remote model calls are refused."),
    el(
      "p",
      {},
      `Local stages are ${config?.enabled ? "on" : "off"}. A configured key is ${config?.key_configured ? "present and unused" : "not present"}.`,
    ),
    button(
      config?.enabled ? "Turn local research off" : "Turn local research on",
      toggleResearch,
    ),
    button("Run local stages", runResearch, {
      class: "primary",
      disabled: !config?.enabled,
    }),
    ...sessions.slice(-1).map(sessionCard),
  ]);
}

function sessionCard(session) {
  return el("article", { class: "card" }, [
    el("h3", {}, `Session ${session.id}`),
    el(
      "p",
      {},
      `Tool calls ${session.tool_calls} / budget ${session.tool_call_budget}. Remote: ${session.remote_calls}.`,
    ),
    el("h4", {}, "Facts"),
    el(
      "ul",
      {},
      (session.facts ?? []).map((item) =>
        el("li", {}, `${item.stage}: ${item.fact}`),
      ),
    ),
    el("h4", {}, "Hypotheses"),
    (session.hypotheses ?? []).length
      ? el(
          "ul",
          {},
          session.hypotheses.map((item) =>
            el("li", {}, `${item.stage}: ${item.hypothesis}`),
          ),
        )
      : el("p", {}, "No hypotheses were produced."),
    el("h4", {}, "Unknowns"),
    el(
      "ul",
      {},
      (session.unknowns ?? []).map((item) =>
        el("li", {}, `${item.stage}: ${item.unknown}`),
      ),
    ),
  ]);
}

function experimentPanel() {
  const preview = state.preview;
  return el("section", { class: "panel" }, [
    el("h2", {}, "Experiment lab"),
    el(
      "p",
      {},
      "The only runnable target is the repository-owned notes search. The preview is the exact command. Approval must match its digest. Output stays separate from static Evidence.",
    ),
    button("Preview owned-fixture probe", loadPreview, { class: "primary" }),
    preview
      ? el("article", { class: "card" }, [
          el("p", {}, preview.approval),
          el(
            "p",
            {},
            `Query ${preview.query}; timeout ${preview.timeout_ms} ms.`,
          ),
          el("pre", { class: "mono" }, preview.argv.join(" ")),
          el(
            "p",
            {},
            `Planner: ${preview.planner.status}. ${preview.planner.result?.assessment?.state || preview.planner.reason || ""}`,
          ),
          button("Approve and run this exact command", () =>
            approveProbe(preview.plan_digest),
          ),
        ])
      : null,
    el(
      "div",
      { class: "stack" },
      (state.project.experiments ?? []).map(experimentCard),
    ),
  ]);
}

function experimentCard(experiment) {
  return el("article", { class: "card" }, [
    el("h3", {}, experiment.status),
    el(
      "p",
      {},
      (experiment.observation?.ids ?? []).join(", ") ||
        experiment.stderr ||
        "No capture yet.",
    ),
    ...(experiment.comparison ?? []).map((item) =>
      el(
        "p",
        {},
        `${item.hypothesis_id}: ${item.matches ? "matched the capture" : "did not match the capture"}.`,
      ),
    ),
    el("p", { class: "note" }, experiment.separation || ""),
    el("p", { class: "note" }, experiment.engine_reassessment_reason || ""),
    experiment.status === "running"
      ? button("Cancel probe", () => cancelProbe(experiment.id))
      : null,
  ]);
}

function reportPanel() {
  return el("section", { class: "panel" }, [
    el("h2", {}, "Report"),
    el(
      "p",
      {},
      "The report restates saved project records. It does not add findings.",
    ),
    button("Refresh report", loadReport, { class: "primary" }),
    button("Save report beside the project", saveReport),
    state.report
      ? el("pre", { class: "mono report" }, state.report)
      : el("p", { class: "empty" }, "No report loaded."),
  ]);
}

async function loadProjects() {
  const data = await api("/api/projects");
  state.projects = data.projects;
}

async function openProject(id) {
  state.project = await api(`/api/projects/${id}`);
  state.view = "overview";
  state.error = "";
  draw();
  await refreshProject();
}

async function addOwned() {
  state.project = await api(
    `/api/projects/${state.project.id}/artifacts/owned-fixture`,
    {
      method: "POST",
      body: {},
    },
  );
  state.notice = "Owned fixture classified. No analysis has run.";
  draw();
}

async function addPath(path) {
  state.project = await api(`/api/projects/${state.project.id}/artifacts`, {
    method: "POST",
    body: { path },
  });
  state.notice = "Path classified. No analysis has run.";
  draw();
}

async function analyze(question) {
  const artifact = state.project.artifacts.at(-1);
  if (!artifact) throw new Error("Add an artifact before analysis.");
  if (!state.authorized)
    throw new Error("Confirm authorization before analysis.");
  state.project = await api(`/api/projects/${state.project.id}/runs`, {
    method: "POST",
    body: { artifact_id: artifact.id, authorized: true, question },
  });
  state.notice = "Static analysis started.";
  draw();
  await refreshProject();
  draw();
}

async function cancelRun(runId) {
  state.project = await api(
    `/api/projects/${state.project.id}/runs/${runId}/cancel`,
    {
      method: "POST",
      body: {},
    },
  );
  draw();
}

async function loadEvidence(find) {
  const run = latestRun();
  if (!run) throw new Error("Complete a static run before searching Evidence.");
  state.evidence = await api(
    `/api/projects/${state.project.id}/runs/${run.id}/evidence?find=${encodeURIComponent(find)}&limit=12`,
  );
  draw();
}

async function loadGraph(find, basis) {
  const run = latestRun();
  if (!run) throw new Error("Complete a static run before opening the graph.");
  const params = new URLSearchParams({ find, basis, limit: "80" });
  state.graph = await api(
    `/api/projects/${state.project.id}/runs/${run.id}/graph?${params}`,
  );
  state.edge = null;
  state.source = null;
  draw();
}

async function selectEdge(edge) {
  state.edge = edge;
  state.source = null;
  draw();
}

async function loadSource(edgeId) {
  const run = latestRun();
  state.source = await api(
    `/api/projects/${state.project.id}/runs/${run.id}/source?edge_id=${encodeURIComponent(edgeId)}`,
  );
  draw();
}

async function toggleResearch() {
  state.researchConfig = await api("/api/research", {
    method: "PUT",
    body: { enabled: !state.researchConfig?.enabled },
  });
  draw();
}

async function runResearch() {
  state.project = await api(`/api/projects/${state.project.id}/research`, {
    method: "POST",
    body: {},
  });
  state.notice = "Local research stages finished. No model was called.";
  draw();
}

async function loadPreview() {
  state.preview = await api(
    `/api/projects/${state.project.id}/experiments/preview`,
  );
  draw();
}

async function approveProbe(planDigest) {
  state.project = await api(`/api/projects/${state.project.id}/experiments`, {
    method: "POST",
    body: { approved: true, plan_digest: planDigest },
  });
  state.notice = "Probe started with the approved command.";
  draw();
  await refreshProject();
  draw();
}

async function cancelProbe(experimentId) {
  state.project = await api(
    `/api/projects/${state.project.id}/experiments/${experimentId}/cancel`,
    {
      method: "POST",
      body: {},
    },
  );
  draw();
}

async function loadReport() {
  const result = await api(`/api/projects/${state.project.id}/report`);
  state.report = result.markdown;
  draw();
}

async function saveReport() {
  const result = await api(`/api/projects/${state.project.id}/report`, {
    method: "POST",
    body: {},
  });
  state.report = result.markdown;
  state.notice = `Saved ${result.path}`;
  draw();
}

function draw() {
  try {
    shell();
  } catch (error) {
    document.querySelector("#app").textContent = error.message;
  }
}

async function boot() {
  const session = await api("/api/session");
  token = session.token;
  state.readiness = await api("/api/readiness");
  state.researchConfig = await api("/api/research");
  await loadProjects();
  draw();
}

boot().catch(setError);
