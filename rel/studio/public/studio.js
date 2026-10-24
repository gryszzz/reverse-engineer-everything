import { explainSubject } from "./explain.js";
import { el, statusClass } from "./format.js";
import { advancedLabs, navigation, primaryFlow } from "./flow.js";
import { mountGraph } from "./graph-view.js";

const state = {
  view: "door",
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
  routeChoice: null,
  phase: "idle",
  linkInput: "",
  linkPlan: null,
  timeline: [],
  replayTo: null,
  palette: false,
  paletteQuery: "",
  rebuildPlan: null,
  rebuildResult: null,
  board: null,
  build: null,
  buildName: "",
  buildSpec: "",
  pipeline: null,
  pipelineRunId: null,
  draft: null,
  draftChecks: {},
  liveBuild: null,
  liveBuildId: null,
  selectedFact: null,
  onboardingSeen: true,
  explain: null,
  tour: false,
  tourStep: 0,
  shortcuts: false,
  capabilities: false,
  lessonCatalog: null,
  lesson: null,
  lessonStep: 0,
  diffLab: null,
  modelOptIn: false,
  about: false,
  scrollTo: "",
  draftLoading: false,
  draftFor: "",
  draftError: "",
  boardLoading: false,
  graphLoading: false,
  graphFor: "",
};

function visibleViews() {
  return navigation(mode());
}

function phaseText() {
  if (state.phase === "copying")
    return "Copying the drop into the studio data directory.";
  if (state.phase === "planning")
    return "Reading the link. No network request has been made.";
  if (state.phase === "fetching") return "Fetching the approved URLs.";
  if (state.phase === "running") return "Analysis is running.";
  return "Idle. No fetch and no analysis is running.";
}

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
  state.phase = "idle";
  draw();
}

function field(label, child) {
  return el("label", { class: "field" }, [label, child]);
}

function nextStep(text) {
  return el("p", { class: "next" }, text);
}

function emptyState(title, body, actionLabel, action) {
  return el("div", { class: "empty-state" }, [
    el("h3", {}, title),
    el("p", {}, body),
    actionLabel ? button(actionLabel, action, { class: "primary" }) : null,
  ]);
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
  const runningId = state.project.runs.find(
    (run) => run.status === "running",
  )?.id;
  state.project = await api(`/api/projects/${state.project.id}`);
  if (runningId && state.view === "door") {
    const updated = state.project.runs.find((run) => run.id === runningId);
    if (updated?.status === "completed") {
      state.view = "analyze";
      state.scrollTo = "analyze";
      state.phase = "idle";
      state.notice =
        "Analysis finished. The timeline is recorded engine progress and Evidence.";
    }
  }
  const busy =
    [...state.project.runs, ...state.project.experiments].some(
      (item) => item.status === "running",
    ) ||
    state.project.native_probe?.status === "running" ||
    state.project.trace?.status === "running";
  if (!busy && state.phase === "running") state.phase = "idle";
  const watched =
    state.project.runs.find((run) => run.status === "running") ?? latestRun();
  if (watched)
    state.timeline = (
      await api(`/api/projects/${state.project.id}/runs/${watched.id}/timeline`)
    ).events;
  if (busy) setTimeout(() => refreshProject().then(draw).catch(setError), 400);
  if (watched) draw();
}

function openView(id) {
  if (!visibleViews().some(([viewId]) => viewId === id)) {
    state.notice = "That screen is under Advanced.";
    state.palette = false;
    draw();
    return;
  }
  state.view = id;
  state.palette = false;
  if (
    mode() !== "advanced" &&
    ["door", "analyze", "findings", "build"].includes(id)
  )
    state.scrollTo = id;
  if (id === "board")
    api("/api/board")
      .then((board) => {
        state.board = board;
        draw();
      })
      .catch(setError);
  if (id === "lessons") {
    loadLessons().catch(setError);
    return;
  }
  if (id === "analyze" && state.project) {
    refreshProject().then(draw).catch(setError);
    return;
  }
  draw();
}

function shell() {
  if (!visibleViews().some(([id]) => id === state.view)) state.view = "door";
  const root = document.querySelector("#app");
  root.replaceChildren();
  const advanced = mode() === "advanced";
  root.append(
    ...[
      el("header", { class: "top" }, [
        el("div", { class: "brand" }, [
          el("p", { class: "mark" }, "REE"),
          el("div", {}, [
            el("h1", {}, "Studio"),
            el("p", { class: "tag" }, "On this machine. Nothing is uploaded."),
          ]),
        ]),
        el("div", { class: "top-actions" }, [
          el("span", { class: "pill" }, "127.0.0.1"),
          button(
            document.documentElement.dataset.theme === "light"
              ? "Dark"
              : "Light",
            () => {
              const next =
                document.documentElement.dataset.theme === "light"
                  ? "dark"
                  : "light";
              document.documentElement.dataset.theme = next;
              try {
                localStorage.setItem("ree-studio-theme", next);
              } catch {
                /* the toggle still applies for this page */
              }
              draw();
            },
          ),
          button("Commands", () => {
            state.palette = true;
            state.paletteQuery = "";
            draw();
          }),
          button("Shortcuts", () => {
            state.shortcuts = true;
            draw();
          }),
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
          el("p", { class: "rail-label" }, "Path"),
          ...primaryFlow.map(([id, label]) =>
            button(label, () => openView(id), {
              class: state.view === id ? "nav current" : "nav",
              "aria-current": state.view === id ? "page" : "false",
              dataset: { pathId: id },
            }),
          ),
          ...(advanced
            ? [
                el("p", { class: "rail-label" }, "Advanced"),
                ...advancedLabs.map(([id, label]) =>
                  button(label, () => openView(id), {
                    class: state.view === id ? "nav current" : "nav",
                    "aria-current": state.view === id ? "page" : undefined,
                  }),
                ),
              ]
            : [
                button("Show advanced labs", async () => {
                  if (!state.project) return;
                  state.project = await api(
                    `/api/projects/${state.project.id}`,
                    {
                      method: "PATCH",
                      body: { mode: "advanced" },
                    },
                  );
                  draw();
                }),
              ]),
          el("p", { class: "rail-label" }, "Projects"),
          ...state.projects.map((project) =>
            button(project.name || project.id, () => openProject(project.id), {
              class: state.project?.id === project.id ? "nav current" : "nav",
            }),
          ),
        ]),
        el(
          "main",
          {
            id: "main",
            class: simplePath() ? "wide" : undefined,
            tabindex: "-1",
          },
          [
            state.error
              ? el("p", { class: "banner bad", role: "alert" }, state.error)
              : null,
            state.notice
              ? el("p", { class: "banner", role: "status" }, state.notice)
              : null,
            onboardingCard(),
            flowStepper(),
            panel(),
            explainCard(),
          ],
        ),
      ]),
      studioFooter(),
      state.palette ? palette() : null,
      state.shortcuts ? shortcutSheet() : null,
      state.tour ? tourCard() : null,
    ].filter((node) => node != null),
  );
}

function simplePath() {
  return (
    mode() !== "advanced" &&
    ["door", "analyze", "findings", "build"].includes(state.view)
  );
}

function panel() {
  if (simplePath()) return pathScreen();
  if (state.view === "readiness") return readinessPanel();
  if (state.view === "analyze" || state.view === "theater")
    return theaterPanel();
  if (state.view === "board") return boardPanel();
  if (state.view === "build") return buildPanel();
  if (state.view === "findings") return findingsPanel();
  if (state.view === "door" || !state.project) return doorPanel();
  if (state.view === "rebuild") return rebuildPanel();
  if (state.view === "lessons") return lessonsPanel();
  if (state.view === "diff-lab") return diffLabPanel();
  if (state.view === "trace-lab") return traceLabPanel();
  if (state.view === "intake") return intakePanel();
  if (state.view === "evidence") return evidencePanel();
  if (state.view === "graph") return graphPanel();
  if (state.view === "research") return researchPanel();
  if (state.view === "experiment") return experimentPanel();
  if (state.view === "report") return reportPanel();
  return overviewPanel();
}

function doorPanel(options = {}) {
  const link = el("input", {
    id: "link-input",
    placeholder: "https://github.com/org/repo, a file URL, or an npm package",
    value: state.linkInput,
    oninput: (event) => {
      state.linkInput = event.target.value;
      if (state.linkPlan && state.linkPlan.input !== event.target.value.trim())
        state.linkPlan = null;
    },
  });
  const checkbox = el("input", {
    type: "checkbox",
    id: "authorized",
    onchange: (event) => {
      state.authorized = event.target.checked;
    },
  });
  if (state.authorized) checkbox.checked = true;
  const file = el("input", {
    type: "file",
    id: "artifact-file",
    onchange: (event) => {
      void dropped(event.target.files).catch(setError);
    },
  });
  const folder = el("input", {
    type: "file",
    id: "artifact-folder",
    webkitdirectory: "true",
    multiple: "true",
    onchange: (event) => {
      void dropped(event.target.files).catch(setError);
    },
  });
  const drop = el(
    "div",
    {
      class: "door-drop",
      tabindex: "0",
      role: "region",
      "aria-label": "Drop a file or folder",
      ondragover: (event) => {
        event.preventDefault();
      },
      ondrop: (event) => {
        event.preventDefault();
        void dropped(event.dataTransfer.files).catch(setError);
      },
    },
    "Drop a file, folder, or paste a link",
  );
  const artifact = state.project?.artifacts?.at(-1);
  const ready = artifact?.intake.routes?.find(
    (route) => route.status === "ready",
  );
  const embedded = options.embedded === true;
  return el(
    "section",
    {
      class: embedded ? "path-block door" : "panel door",
      id: embedded ? "path-door" : undefined,
    },
    [
      el(
        "p",
        { class: embedded ? "step-kicker" : "eyebrow" },
        embedded ? "1 · Paste or drop" : "Start",
      ),
      el(
        "h2",
        {},
        embedded
          ? "Paste a link or drop a file"
          : "Drop a file, folder, or paste a link",
      ),
      el(
        "p",
        {},
        embedded
          ? "Approve the fetch plan before anything is downloaded. The route reads the target. It does not launch it."
          : "A drop is copied here and classified. A link is fetched only after you approve the plan. The route reads the target. It does not launch it.",
      ),
      el(
        "p",
        { class: "status-live", role: "status", "data-phase": state.phase },
        phaseText(),
      ),
      stageRow(),
      drop,
      el("div", { class: "file-row" }, [
        field("File", file),
        field("Folder", folder),
      ]),
      field("Link", link),
      button("Show what will be fetched", () => showLinkPlan(link.value)),
      state.linkPlan ? linkPlanCard(state.linkPlan) : null,
      artifact
        ? el("article", { class: "card" }, [
            el("h3", {}, artifact.intake.label),
            el("p", {}, artifact.intake.basis),
            ready
              ? el("p", {}, `Ready route: ${ready.label}.`)
              : el(
                  "p",
                  { class: "note" },
                  "No route is ready for this artifact. Advanced mode lists every status.",
                ),
            artifact.provenance
              ? el(
                  "p",
                  { class: "note" },
                  `Fetched ${artifact.provenance.fetches.map((item) => item.url).join(", ")}. sha256 recorded. Not executed.`,
                )
              : null,
          ])
        : null,
      !embedded && state.capabilities && artifact
        ? capabilitiesPanel(artifact)
        : null,
      el("label", { class: "check" }, [
        checkbox,
        state.linkPlan
          ? "I approve the fetch plan above, and I am authorized to inspect the result. The download is not executed."
          : "I am authorized to inspect this target. The chosen route reads it and does not launch it.",
      ]),
      button(
        state.linkPlan ? "Fetch and analyze" : "Analyze",
        () => frontDoorRun(),
        { class: "primary" },
      ),
      latestRun()
        ? button("Build from this", () => buildFromThis(), { class: "primary" })
        : null,
      embedded
        ? null
        : nextStep(
            "Next: tick authorization, then Analyze. The live timeline is the next screen.",
          ),
      mode() === "advanced"
        ? button("Use the owned JavaScript fixture", () => addOwned())
        : null,
    ],
  );
}

function capabilitiesPanel(artifact) {
  const routes = artifact.intake?.routes ?? [];
  const ready = routes.filter((route) => route.status === "ready");
  const blocked = routes.filter((route) => route.status !== "ready");
  const lines = [
    ready.length
      ? `Run ${ready.map((route) => route.label).join(", ")}. That route reads the target. It does not launch it.`
      : "No route is ready. Open Readiness in Advanced Mode to see which tool is missing. The studio will not invent a result.",
  ];
  if (
    artifact.intake?.kind === "javascript" ||
    ready.some((route) => /javascript/i.test(route.label))
  )
    lines.push(
      "After a JavaScript analysis, Analyze replays the engine’s progress and Findings lists saved sentences.",
    );
  lines.push(
    "Choose Explain this on a finding, module, or graph node. With no model configured, the text is a local template over stored fields.",
  );
  lines.push(
    "Evidence rebuild, under Advanced and after a JavaScript Evidence run, writes a module map. It does not copy source. Build, on the simple path, scaffolds a new folder from a behavior spec.",
  );
  if (blocked.length)
    lines.push(
      `${blocked.length} route${blocked.length === 1 ? " is" : "s are"} not ready on this machine.`,
    );
  return el("article", { class: "card capabilities", id: "capabilities" }, [
    el("h3", {}, "What can I do with this?"),
    el(
      "ul",
      {},
      lines.map((line) => el("li", {}, line)),
    ),
    button("Hide this panel", () => {
      state.capabilities = false;
      draw();
    }),
  ]);
}

function linkPlanCard(plan) {
  return el("article", { class: "card plan" }, [
    el("h3", {}, "This is what will be fetched"),
    el("p", {}, plan.note),
    el(
      "dl",
      { class: "plan-list" },
      plan.requests.flatMap((request) => [
        el("dt", {}, request.purpose),
        el("dd", {}, [
          el("code", {}, request.url),
          el(
            "span",
            { class: "note" },
            `${request.limit_bytes} bytes · ${request.timeout_ms} ms${request.exact ? "" : " · the exact URL is constrained by this rule"}`,
          ),
        ]),
      ]),
    ),
    plan.git ? el("pre", { class: "mono" }, plan.git.argv.join(" ")) : null,
    el("p", { class: "note" }, `Destination: ${plan.destination}.`),
    plan.available === false
      ? el("p", { class: "bad" }, plan.unavailable_reason)
      : null,
  ]);
}

function shownEvents() {
  if (state.replayTo === null) return state.timeline;
  return state.timeline.slice(0, state.replayTo);
}

function theaterStats(events) {
  const files = events.filter(
    (event) => event.phase === "parse_javascript_source",
  );
  const latest = files.at(-1);
  const evidence = events.find((event) => event.phase === "evidence");
  const modules = new Set(
    events
      .filter((event) => event.phase === "module" && event.file)
      .map((event) => event.file),
  );
  return {
    files: files.length,
    fileTotal: latest?.file_total ?? null,
    modules: modules.size,
    edges: events.filter((event) => event.phase === "edge").length,
    functions: events.filter((event) => event.phase === "function").length,
    calls: events.filter((event) => event.phase === "call").length,
    strings: events.filter((event) => event.phase === "string").length,
    behaviors: events.filter((event) => event.phase === "behavior").length,
    evidence: evidence?.evidence_id ?? null,
    provider: events.find((event) => event.provider)?.provider ?? "unrecorded",
  };
}

function elapsedLabel(events) {
  if (events.length === 0) return "0.0s";
  const start = Date.parse(events[0].at);
  const running = state.project?.runs?.some((run) => run.status === "running");
  const end = running ? Date.now() : Date.parse(events.at(-1).at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "0.0s";
  return `${((end - start) / 1000).toFixed(1)}s`;
}

function theaterGraph(events) {
  const files = [];
  const add = (file) => {
    if (typeof file === "string" && file && !files.includes(file))
      files.push(file);
  };
  for (const event of events) {
    if (event.phase === "call") {
      add(event.from);
      add(event.to);
    } else add(event.file);
  }
  const edges = events.filter((event) => {
    if (event.phase !== "edge" && event.phase !== "call") return false;
    return event.to && files.includes(event.from) && files.includes(event.to);
  });
  return { files, edges };
}

function flowStepper() {
  return el(
    "ol",
    { class: "stepper" },
    primaryFlow.map(([id, label]) =>
      el(
        "li",
        {
          class: state.view === id ? "current" : "",
          dataset: { pathId: id },
        },
        button(label, () => openView(id), { class: "step" }),
      ),
    ),
  );
}

function onboardingCard() {
  if (state.onboardingSeen) return null;
  return el("section", { class: "card onboarding" }, [
    el("h2", {}, "First run"),
    el(
      "p",
      {},
      "Drop a file or paste a link you are allowed to fetch. Analyze shows only the engine events that route records. Findings lists saved Evidence. Build writes a new folder from a behavior spec.",
    ),
    button("Hide this introduction", async () => {
      await api("/api/onboarding", { method: "POST", body: {} });
      state.onboardingSeen = true;
      draw();
    }),
  ]);
}

function pickLabel(pick) {
  const route = pick.route
    ? `${pick.route.method} ${pick.route.path}`
    : "no route";
  return `${pick.name}: ${route}`;
}

function agentVerdictLine(pick) {
  return `${pick.agent}: ${pick.verdict}. ${pick.reason} Angle: ${pick.angle}. ${pick.date}`;
}

function agentVerdicts(item) {
  const shared =
    (state.board?.agent_picks?.length ?? 0) > 0 ||
    (state.board?.agent_pick_errors?.length ?? 0) > 0;
  if (!shared) return null;
  const verdicts = item.agent_picks ?? [];
  if (verdicts.length === 0)
    return el("p", { class: "note" }, "No agent verdict for this entry.");
  return el(
    "ul",
    { class: "agent-picks" },
    verdicts.map((pick) =>
      el("li", { dataset: { verdict: pick.verdict } }, agentVerdictLine(pick)),
    ),
  );
}

function opportunityList(items, text) {
  if (!items.length) return null;
  return el(
    "ul",
    {},
    items.map((item) => el("li", {}, [text(item), agentVerdicts(item)])),
  );
}

function agentVerdictSections() {
  const unmatched = state.board?.unmatched_agent_picks ?? [];
  const errors = state.board?.agent_pick_errors ?? [];
  return [
    unmatched.length
      ? el("section", {}, [
          el("h3", {}, "Verdicts with no matching entry"),
          el(
            "ul",
            { id: "unmatched-agent-picks" },
            unmatched.map((pick) => el("li", {}, agentVerdictLine(pick))),
          ),
        ])
      : null,
    errors.length
      ? el("section", {}, [
          el("h3", {}, "Verdict files that were not shown"),
          el(
            "ul",
            { id: "agent-pick-errors" },
            errors.map((error) =>
              el("li", {}, `${error.file}: ${error.reason}`),
            ),
          ),
        ])
      : null,
  ];
}

function boardPanel() {
  const input = el("textarea", {
    id: "board-json",
    rows: "8",
    placeholder: "Paste a Scout target or a behavior spec JSON object.",
  });
  const scout = state.board?.scout ?? [];
  const specs = state.board?.specs ?? [];
  const picks = state.board?.picks ?? [];
  return el("section", { class: "panel" }, [
    el("h2", {}, "Board"),
    el(
      "p",
      {},
      "Scout scores stay the integers in the file. A behavior spec is listed by coverage and has no market score. A pick is a pipeline feature whose route test passed. An agent verdict from the shared folder is build, skip, or maybe, and it is shown beside the matching entry.",
    ),
    el("h3", {}, "Picks"),
    picks.length === 0
      ? el(
          "p",
          { class: "empty" },
          "No picks yet. Run the owned web pipeline. Guard was not called. Blast was not notified. Scale was not called.",
        )
      : el("ul", { id: "board-picks" }, [
          ...picks.map((pick) => el("li", {}, pickLabel(pick))),
          el(
            "li",
            { class: "note" },
            "These picks are files on the board. Guard was not called. Blast was not notified. Scale was not called.",
          ),
        ]),
    !state.board ||
    (scout.length === 0 && specs.length === 0 && picks.length === 0)
      ? el(
          "p",
          { class: "empty" },
          "No opportunities ingested. Paste a Scout target or an outside-in spec.",
        )
      : null,
    opportunityList(
      scout,
      (item) =>
        `${item.target_name}: ${item.listing.scores.total}/25, confidence ${item.listing.confidence}. ${item.listing.note}`,
    ),
    opportunityList(
      specs,
      (item) =>
        `${item.target_name}: ${item.listing.coverage.features} features. ${item.listing.note}`,
    ),
    ...agentVerdictSections(),
    input,
    button("Ingest", async () => {
      const value = JSON.parse(input.value);
      state.board = await api("/api/board", { method: "POST", body: value });
      state.notice = "Ingested. Scores were not invented.";
      draw();
    }),
    nextStep(
      "Next: open Build and build from a behavior spec you already have.",
    ),
  ]);
}

let pipelinePoll = 0;

async function pollPipeline(ticket) {
  if (ticket !== pipelinePoll || !state.pipelineRunId) return;
  try {
    const snapshot = await api("/api/pipeline/" + state.pipelineRunId);
    if (ticket !== pipelinePoll) return;
    state.pipeline = snapshot;
    if (snapshot.finished && snapshot.message) {
      state.error = snapshot.message;
      state.notice = "";
    } else if (snapshot.finished)
      state.notice =
        "Owned web pipeline finished. Sell steps stayed a dry run.";
    draw();
    if (!snapshot.finished) setTimeout(() => pollPipeline(ticket), 200);
  } catch (error) {
    if (ticket !== pipelinePoll) return;
    setError(error);
  }
}

let livePoll = 0;

function factForStatement(statement) {
  const events = state.timeline.filter(
    (event) => event.evidence_id && event.evidence_id === statement.evidence_id,
  );
  const named = events.filter(
    (event) =>
      typeof event.fact === "string" && statement.text?.includes(event.fact),
  );
  if (named.length === 1) return named[0];
  const mint = events.find((event) => event.phase === "evidence");
  if (mint)
    return {
      ...mint,
      path: statement.path,
      sentence: statement.text,
    };
  return {
    source: "evidence",
    phase: "finding",
    message: statement.text,
    evidence_id: statement.evidence_id,
    path: statement.path,
    produced_by: {
      phase: null,
      message: null,
      note: "No progress line names this fact. It was read from Evidence.",
    },
  };
}

async function pollLive(ticket) {
  if (ticket !== livePoll || !state.liveBuildId) return;
  try {
    const snapshot = await api("/api/live-builds/" + state.liveBuildId);
    if (ticket !== livePoll) return;
    state.liveBuild = snapshot;
    if (snapshot.finished && snapshot.error) {
      state.error = snapshot.error;
      state.notice = "";
    } else if (snapshot.finished && snapshot.status === "verified")
      state.notice =
        "Tests finished. Package as product writes the tarball. Sell steps stay a dry run.";
    else if (snapshot.status === "packaged")
      state.notice = snapshot.package_path
        ? `Packaged ${snapshot.package_path}. Guard was not called.`
        : "Packaged. Guard was not called.";
    draw();
    if (!snapshot.finished) setTimeout(() => pollLive(ticket), 200);
  } catch (error) {
    if (ticket !== livePoll) return;
    setError(error);
  }
}

async function startLive(body) {
  const started = await api("/api/live-builds", { method: "POST", body });
  state.liveBuildId = started.live_id;
  state.liveBuild = {
    live_id: started.live_id,
    status: "running",
    finished: false,
    events: [],
  };
  state.error = "";
  state.notice = "Build is writing files, then running tests.";
  livePoll += 1;
  draw();
  pollLive(livePoll);
}

async function buildFromThis() {
  const run = latestRun();
  if (!run || !state.project)
    throw new Error("Complete an investigation before building.");
  const draft = await api(
    `/api/projects/${state.project.id}/runs/${run.id}/spec-draft`,
    { method: "POST", body: {} },
  );
  state.draft = draft;
  state.draftFor = run.id;
  state.draftError = "";
  state.draftChecks = Object.fromEntries(
    (draft.features ?? []).map((feature) => [feature.id, true]),
  );
  if (!state.buildName) state.buildName = "REE Product";
  state.view = "build";
  state.scrollTo = "build";
  state.notice = draft.note;
  draw();
}

function draftCard() {
  const draft = state.draft;
  if (!draft) return null;
  const features = draft.features ?? [];
  const endpoints = draft.endpoints ?? [];
  const canRebuild = features.length > 0 || endpoints.length > 0;
  return el("article", { class: "card" }, [
    el("h3", {}, "Spec from this investigation"),
    el("p", {}, draft.note || ""),
    !canRebuild
      ? el(
          "p",
          { class: "empty" },
          "This input does not support a rebuild. No feature was recovered, and none was invented.",
        )
      : features.length === 0
        ? el(
            "p",
            {},
            `${endpoints.length} endpoints were recovered. Rebuild uses those routes.`,
          )
        : el(
            "div",
            { class: "stack feature-grid" },
            features.map((feature) =>
              el("label", { class: "check feature" }, [
                el("input", {
                  type: "checkbox",
                  checked: state.draftChecks[feature.id] ? "checked" : false,
                  onchange: (event) => {
                    state.draftChecks[feature.id] = event.target.checked;
                  },
                }),
                el("span", {}, [
                  el("strong", {}, feature.name),
                  feature.detail
                    ? el("span", { class: "note" }, feature.detail)
                    : null,
                ]),
              ]),
            ),
          ),
    canRebuild
      ? button(
          "Rebuild and verify",
          () => {
            const ids = features
              .filter((feature) => state.draftChecks[feature.id])
              .map((feature) => feature.id);
            const run = latestRun();
            return startLive({
              product_name: state.buildName || "REE Product",
              project_id: state.project.id,
              run_id: run.id,
              feature_ids: ids,
            });
          },
          { class: "primary" },
        )
      : null,
  ]);
}

function liveCard(live) {
  if (!live) return null;
  const events = live.events ?? [];
  return el("article", { class: "card" }, [
    el("h3", {}, `Live build ${live.status || "running"}`),
    live.verify
      ? el("div", { class: "metrics" }, [
          metric("Implemented", live.verify.implemented),
          metric("Unimplemented", live.verify.unimplemented),
          metric("Failed", live.verify.failed),
        ])
      : el(
          "p",
          { class: "note" },
          "Files and tests appear as they are recorded.",
        ),
    events.length
      ? el(
          "ol",
          { class: "timeline" },
          events.map((event) =>
            el(
              "li",
              {
                class: statusClass(
                  event.match === "fail" || event.status === "failed"
                    ? "failed"
                    : event.match === "pass" ||
                        event.phase === "file" ||
                        event.status === "implemented"
                      ? "completed"
                      : event.phase === "test"
                        ? "running"
                        : "recorded",
                ),
              },
              [
                el("span", { class: "phase" }, event.phase || "step"),
                el("span", {}, event.message || ""),
              ],
            ),
          ),
        )
      : null,
    live.package_ready && !live.package_path
      ? button("Package as product", () => packageLive(), { class: "primary" })
      : null,
    live.package_path ? el("p", {}, `Package ${live.package_path}`) : null,
    live.handoff_dir
      ? el(
          "p",
          { class: "note" },
          `Dry-run handoff ${live.handoff_dir}. Guard was not called.`,
        )
      : null,
    live.handoff_error ? el("p", {}, live.handoff_error) : null,
    live.error ? el("p", { class: "bad" }, live.error) : null,
    gapsCard(live.gaps),
    betterCard(live.improvements),
  ]);
}

async function packageLive() {
  state.liveBuild = await api(
    "/api/live-builds/" + state.liveBuildId + "/package",
    {
      method: "POST",
      body: {},
    },
  );
  state.notice =
    "Packaged product.tgz. Guard, Blast, Scale, and Vault were not called.";
  draw();
}

function buildPanel() {
  const name = el("input", {
    id: "build-name",
    placeholder: "New product name",
    value: state.buildName,
    oninput: (event) => {
      state.buildName = event.target.value;
    },
  });
  const spec = el(
    "textarea",
    {
      id: "build-spec",
      rows: "8",
      placeholder: "Paste a ree.outside-in.behavior-spec.v1 object.",
      oninput: (event) => {
        state.buildSpec = event.target.value;
      },
    },
    state.buildSpec,
  );
  const result = state.build;
  const pipeline = state.pipeline;
  const pipelineRunning = pipeline && pipeline.finished !== true;
  const live = state.liveBuild;
  return el("section", { class: "panel" }, [
    el("h2", {}, "Build"),
    el(
      "p",
      {},
      "A clean-room HTTP product from this spec. Quotes are not copied. Launch stays a dry run.",
    ),
    draftCard(),
    liveCard(live),
    !result
      ? emptyState(
          "No build yet",
          "Paste a spec and a product name that is not the spec target. Each feature gets CRUD routes and a behavior test. Login and logout issue and revoke a token when the spec has them. findBy filters and inventory counts are built when the spec declares them. Stripe checkout stays off until STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and an existing price id are set. Pipeline picks are on Board, under Advanced.",
          null,
          null,
        )
      : el("article", { class: "card" }, [
          el("p", {}, `Build ${result.build_id}`),
          el("div", { class: "metrics" }, [
            metric("Implemented", result.verify.implemented),
            metric("Unimplemented", result.verify.unimplemented),
            metric("Failed", result.verify.failed),
          ]),
          el(
            "p",
            {},
            result.handoff_dir
              ? `Handoff ${result.handoff_dir}`
              : result.handoff_error,
          ),
          el(
            "p",
            { class: "note" },
            "Dry run. Launch still needs Guard PASS and Tony's go-ahead. Login and logout are built when the spec has them. Stripe checkout stays off until an existing test key and price id are set.",
          ),
          gapsCard(result.gaps),
          betterCard(result.improvements),
        ]),
    field("Product name", name),
    el("details", { class: "spec-json" }, [
      el("summary", {}, "Spec JSON"),
      spec,
    ]),
    button("Build and verify", async () => {
      state.buildName = name.value;
      state.buildSpec = spec.value;
      await startLive({
        product_name: name.value,
        spec: JSON.parse(spec.value),
      });
    }),
    el("article", { class: "card" }, [
      el("h3", {}, "Owned web pipeline"),
      el(
        "p",
        {},
        "One run of experiments/ree-bench/web. The product name is Board Desk. Stages update from the checkpoint file. Guard, Blast, Scale, and Vault stay files. Nothing is submitted or notified.",
      ),
      pipeline
        ? el(
            "ol",
            { class: "timeline" },
            (pipeline.stages ?? []).map((stage) =>
              el(
                "li",
                {
                  class: statusClass(
                    stage.status === "passed"
                      ? "completed"
                      : stage.status === "failed"
                        ? "failed"
                        : stage.status,
                  ),
                },
                [
                  el("span", { class: "phase" }, stage.id),
                  el("span", { class: "status-pill" }, stage.status),
                ],
              ),
            ),
          )
        : el(
            "p",
            { class: "note" },
            "No pipeline run yet. The stage list appears here while the run is in progress.",
          ),
      pipeline?.message ? el("p", {}, pipeline.message) : null,
      gapsCard(pipeline?.gaps),
      betterCard(pipeline?.improvements),
      button(
        "Run owned web pipeline",
        async () => {
          const started = await api("/api/pipeline", {
            method: "POST",
            body: { fixture: "web", product_name: "Board Desk" },
          });
          state.pipelineRunId = started.run_id;
          state.pipeline = {
            run_id: started.run_id,
            status: "running",
            finished: false,
            stages: [],
          };
          state.notice = "Owned web pipeline is running.";
          state.error = "";
          pipelinePoll += 1;
          draw();
          pollPipeline(pipelinePoll);
        },
        { class: "primary", disabled: pipelineRunning },
      ),
    ]),
    nextStep("Next: paste the spec and Build, or run the owned web pipeline."),
  ]);
}

function watchedRun() {
  return (
    state.project?.runs?.find((run) => run.status === "running") ??
    state.project?.runs?.at(-1) ??
    null
  );
}

function betterCard(improvements) {
  if (!improvements) return null;
  const items = Array.isArray(improvements.items) ? improvements.items : [];
  return el("article", { class: "card", "data-better": "1" }, [
    el("h3", {}, improvements.title || "What we do better"),
    improvements.note ? el("p", { class: "note" }, improvements.note) : null,
    items.length === 0
      ? el("p", {}, "The list is empty.")
      : el(
          "ol",
          {},
          items.map((item) =>
            el(
              "li",
              {},
              item.quote_omitted
                ? `${item.id} (improvement). The quote repeated a recorded name and was omitted from this panel.`
                : `${item.rank}. ${item.id} (improvement). ${item.kind}. ${item.quote}`,
            ),
          ),
        ),
  ]);
}

function gapsCard(gaps) {
  if (!gaps || !Array.isArray(gaps.items) || gaps.items.length === 0)
    return null;
  return el("article", { class: "card", "data-gaps": "1" }, [
    el("h3", {}, gaps.title || "What we can't read or build yet"),
    gaps.note ? el("p", { class: "note" }, gaps.note) : null,
    el(
      "ul",
      {},
      gaps.items.map((item) => el("li", {}, item.text || "")),
    ),
  ]);
}

function metric(label, value) {
  return el("div", { class: "metric" }, [
    el("span", { class: "metric-value" }, String(value ?? 0)),
    el("span", { class: "metric-label" }, label),
  ]);
}

function processDetail(event) {
  const parts = [];
  if (event.route_id) parts.push(event.route_id);
  if (event.bytes) parts.push(`${event.bytes} bytes`);
  if (event.evidence_id) parts.push(event.evidence_id);
  if (event.code !== undefined && event.code !== null)
    parts.push(`exit ${event.code}`);
  return parts.join(" ") || event.at || "";
}

function theaterPanel(options = {}) {
  const embedded = options.embedded === true;
  const events = shownEvents();
  const stats = theaterStats(events);
  const graph = theaterGraph(events);
  const holder = el("div", { class: "theater-graph", id: "theater-graph" });
  holder.append(theaterSvg(graph));
  const run = watchedRun();
  const processEvents = run?.events ?? [];
  return el(
    "section",
    {
      class: embedded ? "path-block theater" : "panel theater",
      id: embedded ? "path-analyze" : undefined,
    },
    [
      el(
        "p",
        { class: embedded ? "step-kicker" : "eyebrow" },
        embedded ? "2 · Watch it analyze" : "Live analysis",
      ),
      el("h2", {}, "Analyze"),
      el(
        "p",
        {},
        embedded
          ? "The graph and timeline use recorded engine events. A line appears only after the engine writes it."
          : "Each line is an engine progress event or a fact read from written Evidence. Process lines are start, the first output chunk, and exit.",
      ),
      !state.project
        ? emptyState(
            "Nothing to watch yet",
            "Drop a file on the front door. A line appears only when the engine emits it.",
            "Go to the front door",
            () => {
              state.view = "door";
              draw();
            },
          )
        : null,
      state.project && !run
        ? emptyState(
            "No analysis has started",
            "Authorize the target on the front door, then press Analyze.",
            "Go to the front door",
            () => {
              state.view = "door";
              draw();
            },
          )
        : null,
      el("div", { class: "stats" }, [
        stat("Provider", stats.provider),
        stat("Elapsed", elapsedLabel(events)),
        stat(
          "Files parsed",
          stats.fileTotal
            ? `${stats.files}/${stats.fileTotal}`
            : String(stats.files),
        ),
        stat("Modules", String(stats.modules)),
        stat("Functions", String(stats.functions)),
        stat("Imports", String(stats.edges)),
        stat("Calls", String(stats.calls)),
        stat("Strings", String(stats.strings)),
        stat("Behaviors", String(stats.behaviors)),
        stat(
          "Evidence",
          stats.evidence ? stats.evidence.slice(0, 12) + "…" : "not yet",
        ),
      ]),
      stageRow(),
      recordedPhaseRow(events),
      holder,
      factCard(),
      events.length > 0 && !events.some((event) => event.phase === "hypothesis")
        ? el(
            "p",
            { class: "note" },
            "No hypothesis decision was recorded for this run.",
          )
        : null,
      events.length
        ? el(
            "ol",
            { class: "timeline" },
            events.map((event) =>
              el("li", {}, [
                el("span", { class: "phase" }, event.phase),
                button(
                  event.message,
                  () => {
                    state.selectedFact = event;
                    draw();
                  },
                  { class: "quiet" },
                ),
              ]),
            ),
          )
        : run
          ? el(
              "p",
              { class: "empty" },
              "This run has no recorded engine progress lines.",
            )
          : null,
      processEvents.length
        ? el(
            "ol",
            { class: "timeline" },
            processEvents.map((event) =>
              el("li", {}, [
                el("span", { class: "phase" }, event.kind || "process"),
                el("span", {}, processDetail(event)),
              ]),
            ),
          )
        : run && events.length === 0
          ? el(
              "p",
              { class: "empty" },
              "This run has no recorded engine events.",
            )
          : null,
      events.length
        ? button("Replay recorded timeline", () => replayTimeline(), {
            class: "primary",
          })
        : null,
      embedded
        ? null
        : nextStep(
            events.length
              ? "Next: open Findings and read the sentences that name an Evidence id."
              : "Next: start from the front door. This screen stays empty until the engine writes a line.",
          ),
    ],
  );
}

function pathScreen() {
  return el("div", { class: "path-screen" }, [
    doorPanel({ embedded: true }),
    theaterPanel({ embedded: true }),
    findingsVisual(),
    buildVisual(),
  ]);
}

function findingsVisual() {
  const run = latestRun();
  const statements = run?.narrative?.statements ?? [];
  const holder = el("div", { id: "graph-holder", class: "theater-graph" });
  if (state.graph) mountGraph(holder, state.graph, selectEdge);
  return el("section", { class: "path-block", id: "path-findings" }, [
    el("p", { class: "step-kicker" }, "3 · Findings"),
    el("h2", {}, "Findings"),
    el(
      "p",
      { class: "note" },
      "Each card is a saved sentence. The graph shows stored relationships only.",
    ),
    !run
      ? emptyState(
          "No findings yet",
          "A card appears only after Evidence is saved.",
          null,
          null,
        )
      : null,
    statements.length
      ? el(
          "div",
          { class: "finding-grid" },
          statements.map((statement) =>
            el("article", { class: "card finding" }, [
              el("p", { class: "finding-text" }, statement.text),
              el(
                "p",
                { class: "note" },
                [statement.evidence_id, statement.path]
                  .filter(Boolean)
                  .join(" · "),
              ),
              el("div", { class: "card-actions" }, [
                button("Explain this", () =>
                  showExplain({
                    kind: "finding",
                    text: statement.text,
                    evidence_id: statement.evidence_id,
                    path: statement.path,
                    unknowns: run.narrative?.unknowns ?? [],
                  }),
                ),
                button("Show evidence", () => {
                  state.selectedFact = factForStatement(statement);
                  state.view = "findings";
                  draw();
                }),
              ]),
            ]),
          ),
        )
      : run
        ? el(
            "p",
            { class: "empty" },
            "This run saved Evidence and no finding sentences.",
          )
        : null,
    (run?.narrative?.unknowns ?? []).length
      ? el("div", { class: "chip-row" }, [
          el("span", { class: "note" }, "Unknowns"),
          ...run.narrative.unknowns.map((item) =>
            el("span", { class: "status-pill" }, item),
          ),
        ])
      : null,
    holder,
    factCard(),
    run
      ? button("Build from this", () => buildFromThis(), { class: "primary" })
      : null,
  ]);
}

function buildVisual() {
  const name = el("input", {
    id: "build-name",
    placeholder: "New product name",
    value: state.buildName,
    oninput: (event) => {
      state.buildName = event.target.value;
    },
  });
  const scout = state.board?.scout ?? [];
  const specs = state.board?.specs ?? [];
  const picks = state.board?.picks ?? [];
  return el("section", { class: "path-block", id: "path-build" }, [
    el("p", { class: "step-kicker" }, "4 · What to build"),
    el("h2", {}, "What to build"),
    el(
      "p",
      { class: "note" },
      "Features come from this investigation. Scores and picks are the integers already stored on the board. Nothing here is invented, and a behavior spec has no market score.",
    ),
    state.draftLoading
      ? el("p", { class: "note" }, "Reading the spec draft from Evidence.")
      : null,
    state.draftError ? el("p", { class: "empty" }, state.draftError) : null,
    latestRun()
      ? null
      : el(
          "p",
          { class: "empty" },
          "Finish an analysis before building. A rebuild is offered only when saved Evidence yields features.",
        ),
    draftCard(),
    el("h3", {}, "Scores"),
    scout.length === 0
      ? el(
          "p",
          { class: "note" },
          "No scout score is stored. Scores are not invented.",
        )
      : el(
          "div",
          { class: "score-row" },
          scout.map((item) =>
            el("article", { class: "card score" }, [
              el("h3", {}, item.target_name || "Scout target"),
              el("div", { class: "metrics" }, [
                metric(
                  "Score",
                  item.listing?.scores?.total === undefined ||
                    item.listing?.scores?.total === null
                    ? "unrecorded"
                    : `${item.listing.scores.total}/25`,
                ),
                metric(
                  "Confidence",
                  item.listing?.confidence === undefined ||
                    item.listing?.confidence === null
                    ? "unrecorded"
                    : item.listing.confidence,
                ),
              ]),
              item.listing?.note
                ? el("p", { class: "note" }, item.listing.note)
                : null,
              agentVerdicts(item),
            ]),
          ),
        ),
    el("h3", {}, "Spec coverage"),
    specs.length === 0
      ? el(
          "p",
          { class: "note" },
          "No behavior spec is on the board. A spec has no market score.",
        )
      : el(
          "div",
          { class: "score-row" },
          specs.map((item) =>
            el("article", { class: "card score" }, [
              el("h3", {}, item.target_name || "Behavior spec"),
              metric(
                "Features",
                item.listing?.coverage?.features === undefined ||
                  item.listing?.coverage?.features === null
                  ? "unrecorded"
                  : item.listing.coverage.features,
              ),
              el("p", { class: "note" }, "No market score."),
              item.listing?.note
                ? el("p", { class: "note" }, item.listing.note)
                : null,
              agentVerdicts(item),
            ]),
          ),
        ),
    el("h3", {}, "Picks"),
    picks.length === 0
      ? el(
          "p",
          { class: "note" },
          "No picks yet. A pick is a pipeline feature whose route test passed.",
        )
      : el(
          "ul",
          { id: "board-picks" },
          picks.map((pick) => el("li", {}, pickLabel(pick))),
        ),
    field("Product name", name),
    el(
      "p",
      { class: "note" },
      "Spec JSON stays under Advanced. Quotes are not copied. Launch stays a dry run.",
    ),
    liveCard(state.liveBuild),
  ]);
}

function studioFooter() {
  return el("footer", { class: "studio-footer" }, [
    el("div", {}, [
      el("p", {}, "REE is built on morluto's REA engine (MIT)."),
      state.about
        ? el(
            "p",
            { class: "note" },
            "The studio is the REE product layer. Analysis, Evidence, and providers come from the inherited REA engine. This checkout is MIT, copyright (c) 2026 morluto.",
          )
        : null,
    ]),
    button(state.about ? "Hide about" : "About", () => {
      state.about = !state.about;
      draw();
    }),
  ]);
}

let pathObserver = null;

function watchPath() {
  if (pathObserver) {
    pathObserver.disconnect();
    pathObserver = null;
  }
  if (!simplePath()) return;
  const blocks = ["door", "analyze", "findings", "build"]
    .map((id) => document.getElementById(`path-${id}`))
    .filter(Boolean);
  if (blocks.length === 0) return;
  pathObserver = new IntersectionObserver(
    (entries) => {
      const hit = entries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (left, right) => right.intersectionRatio - left.intersectionRatio,
        )[0];
      if (!hit) return;
      const id = hit.target.id.slice("path-".length);
      if (!id || state.view === id) return;
      state.view = id;
      for (const node of document.querySelectorAll("[data-path-id]")) {
        const on = node.dataset.pathId === id;
        node.classList.toggle("current", on);
        if (node.classList.contains("nav"))
          node.setAttribute("aria-current", on ? "page" : "false");
      }
    },
    { threshold: [0.35, 0.6] },
  );
  for (const block of blocks) pathObserver.observe(block);
}

function primePath() {
  if (!simplePath()) return;
  const run = latestRun();
  if (
    run &&
    state.project &&
    state.draftFor !== run.id &&
    !state.draftLoading
  ) {
    state.draftLoading = true;
    const projectId = state.project.id;
    const runId = run.id;
    api(`/api/projects/${projectId}/runs/${runId}/spec-draft`, {
      method: "POST",
      body: {},
    })
      .then((draft) => {
        state.draftLoading = false;
        if (state.project?.id !== projectId || latestRun()?.id !== runId)
          return;
        state.draft = draft;
        state.draftFor = runId;
        state.draftError = "";
        state.draftChecks = Object.fromEntries(
          (draft.features ?? []).map((feature) => [feature.id, true]),
        );
        if (!state.buildName) state.buildName = "REE Product";
        draw();
      })
      .catch((error) => {
        state.draftLoading = false;
        state.draftFor = runId;
        state.draftError =
          error instanceof Error ? error.message : String(error);
        draw();
      });
  }
  if (
    run &&
    run.kind !== "outside-in" &&
    state.project &&
    state.graphFor !== run.id &&
    !state.graphLoading
  ) {
    state.graphLoading = true;
    const projectId = state.project.id;
    const runId = run.id;
    api(`/api/projects/${projectId}/runs/${runId}/graph?limit=40`)
      .then((graph) => {
        state.graphLoading = false;
        if (state.project?.id !== projectId) return;
        state.graphFor = runId;
        state.graph = graph;
        draw();
      })
      .catch(() => {
        state.graphLoading = false;
        state.graphFor = runId;
      });
  }
  if (state.board === null && !state.boardLoading) {
    state.boardLoading = true;
    api("/api/board")
      .then((board) => {
        state.board = board;
        state.boardLoading = false;
        draw();
      })
      .catch(() => {
        state.boardLoading = false;
        state.board = { scout: [], specs: [], picks: [] };
      });
  }
}

function stat(label, value) {
  return el("div", {}, [el("dt", {}, label), el("dd", {}, value)]);
}

function recordedPhaseRow(events) {
  const phases = [];
  for (const event of events) {
    if (typeof event.phase === "string" && !phases.includes(event.phase))
      phases.push(event.phase);
  }
  if (phases.length === 0) return null;
  return el(
    "ol",
    { class: "stages", "aria-label": "Recorded phases" },
    phases.map((phase) =>
      el("li", { class: "current", "data-stage": phase }, phase),
    ),
  );
}

function factCard() {
  const event = state.selectedFact;
  if (!event) return null;
  const produced = event.produced_by;
  const step = produced?.phase
    ? `${produced.phase}: ${produced.message}`
    : (produced?.note ??
      "No progress line names this fact. It was read from Evidence.");
  return el("article", { class: "card fact-card" }, [
    el("h3", {}, "Recorded fact"),
    el("p", {}, event.message || event.sentence || "No message was stored."),
    el(
      "p",
      { class: "note" },
      `Source: ${event.source || "unrecorded"}. Phase: ${event.phase || "unrecorded"}.`,
    ),
    event.evidence_id ? el("p", {}, `Evidence ${event.evidence_id}`) : null,
    event.node_id ? el("p", {}, `Node ${event.node_id}`) : null,
    event.relation_id ? el("p", {}, `Relation ${event.relation_id}`) : null,
    event.path ? el("p", {}, `Path ${event.path}`) : null,
    event.state ? el("p", {}, `Evidence state: ${event.state}.`) : null,
    event.authority ? el("p", {}, `Authority: ${event.authority}.`) : null,
    event.location?.line
      ? el(
          "p",
          {},
          `Location line ${event.location.line}${event.location.column === null || event.location.column === undefined ? "" : `, column ${event.location.column}`}.`,
        )
      : null,
    el("p", {}, `Producing step: ${step}`),
    button("Close", () => {
      state.selectedFact = null;
      draw();
    }),
  ]);
}

function stageRow() {
  if (!state.phase || state.phase === "idle") return null;
  const stages = [
    ["copying", "Copy"],
    ["planning", "Plan"],
    ["fetching", "Fetch"],
    ["running", "Analyze"],
  ];
  return el(
    "ol",
    { class: "stages" },
    stages.map(([id, label]) =>
      el(
        "li",
        { class: state.phase === id ? "current" : "", "data-stage": id },
        label,
      ),
    ),
  );
}

function theaterSvg(graph) {
  const height = Math.max(120, graph.files.length * 42 + 24);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 640 ${height}`);
  svg.setAttribute("class", "graph");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Modules named by recorded progress");
  const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
  title.setAttribute("x", "16");
  title.setAttribute("y", "20");
  title.setAttribute("fill", "currentColor");
  title.textContent =
    graph.files.length === 0
      ? "No parsed file has been reported yet."
      : "Files and calls named by recorded events.";
  svg.append(title);
  const yOf = new Map();
  graph.files.forEach((file, index) => {
    const y = 36 + index * 42;
    yOf.set(file, y);
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", "16");
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", "220");
    rect.setAttribute("height", "32");
    rect.setAttribute("rx", "8");
    rect.setAttribute("class", "node-shape");
    const label = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "text",
    );
    label.setAttribute("x", "28");
    label.setAttribute("y", String(y + 21));
    label.textContent = file;
    const open = () =>
      showExplain({
        kind: "module",
        label: file,
        node_kind: "javascript-module",
        evidence_id:
          state.timeline.find((event) => event.phase === "evidence")
            ?.evidence_id ?? null,
      });
    rect.addEventListener("click", open);
    label.addEventListener("click", open);
    svg.append(rect, label);
  });
  for (const edge of graph.edges) {
    const from = yOf.get(edge.from);
    const to = yOf.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const call = edge.phase === "call";
    path.setAttribute(
      "d",
      call
        ? `M 236 ${from + 16} C 420 ${from + 16}, 420 ${to + 16}, 236 ${to + 16}`
        : `M 236 ${from + 16} C 300 ${from + 16}, 300 ${to + 16}, 236 ${to + 16}`,
    );
    path.setAttribute("class", call ? "edge-line edge-call" : "edge-line");
    svg.append(path);
  }
  const minimap = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  minimap.setAttribute("viewBox", `0 0 640 ${height}`);
  minimap.setAttribute("class", "minimap");
  minimap.setAttribute("aria-hidden", "true");
  for (const y of yOf.values()) {
    const mark = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    mark.setAttribute("x", "16");
    mark.setAttribute("y", String(y));
    mark.setAttribute("width", "220");
    mark.setAttribute("height", "32");
    mark.setAttribute("class", "node-shape");
    minimap.append(mark);
  }
  const frame = document.createElement("div");
  frame.className = "graph-frame";
  frame.append(svg, minimap);
  return frame;
}

function replayTimeline() {
  if (state.timeline.length === 0) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    state.replayTo = null;
    draw();
    return;
  }
  state.replayTo = 0;
  const step = () => {
    if (state.replayTo === null) return;
    state.replayTo += 1;
    draw();
    if (state.replayTo < state.timeline.length) setTimeout(step, 180);
    else state.replayTo = null;
  };
  step();
}

function rebuildPanel() {
  const output = el("input", {
    id: "rebuild-output",
    placeholder: "/tmp/ree-rebuild",
  });
  const approved = el("input", { type: "checkbox", id: "rebuild-approved" });
  const plan = state.rebuildPlan;
  return el("section", { class: "panel" }, [
    el("p", { class: "eyebrow" }, "Rebuild Studio"),
    el("h2", {}, "Original identities and a reconstructed map"),
    el(
      "p",
      {},
      "The preview lists recovered module identities from Evidence. Writing creates stubs only. It does not copy source, and it does not claim the result behaves like the original.",
    ),
    field("New output folder outside this checkout", output),
    button("Preview rebuild", () => previewRebuild(output.value)),
    plan
      ? el("article", { class: "card" }, [
          el("p", {}, plan.statement),
          el("table", { class: "data" }, [
            el(
              "caption",
              {},
              "Original identity compared with the file that will be written",
            ),
            el(
              "thead",
              {},
              el(
                "tr",
                {},
                ["Module", "Identity", "Implementation", "Verification"].map(
                  (name) => el("th", {}, name),
                ),
              ),
            ),
            el(
              "tbody",
              {},
              plan.modules.map((module) =>
                el("tr", {}, [
                  el("td", {}, module.file),
                  el("td", {}, module.identity),
                  el("td", {}, module.implementation),
                  el("td", {}, module.verification),
                ]),
              ),
            ),
          ]),
          ...(plan.comparisons ?? []).map((row) =>
            el("details", { class: "compare-row" }, [
              el(
                "summary",
                {},
                `${row.file}: identity ${row.identity}, rebuilt ${row.implementation}, verification ${row.verification}, engine match ${row.engine_match}, text ${row.text_relation}`,
              ),
              row.original_excerpt
                ? el("div", { class: "compare" }, [
                    el("div", {}, [
                      el("h4", {}, "Original, read for display"),
                      el("pre", { class: "mono" }, row.original_excerpt),
                    ]),
                    el("div", {}, [
                      el("h4", {}, "Reconstructed stub"),
                      el("pre", { class: "mono" }, row.rebuilt_text),
                    ]),
                  ])
                : el(
                    "p",
                    {},
                    "The original file was not available beside this recovered identity.",
                  ),
              row.diff
                ? el("pre", { class: "mono diff" }, row.diff)
                : el(
                    "p",
                    { class: "note" },
                    "No text mismatch to show. Engine verification remains unverified.",
                  ),
            ]),
          ),
        ])
      : null,
    el("label", { class: "check" }, [
      approved,
      "I approve writing this reconstructed map into the folder above.",
    ]),
    button(
      "Write rebuild and run the map test",
      () => runRebuild(output.value, approved.checked),
      { class: "primary" },
    ),
    state.rebuildResult
      ? el(
          "p",
          { class: state.rebuildResult.map_test === "green" ? "ok" : "bad" },
          [
            `Map test ${state.rebuildResult.map_test}. Behavior remains ${state.rebuildResult.behavior}.`,
          ],
        )
      : null,
    el("h3", {}, "Owned native fixture"),
    el(
      "p",
      { class: "note" },
      "The native probe runs only when the artifact is experiments/ree-investigation-boundary. It uses the existing reconstruction verifier. Claim results stay pass, fail, or unknown.",
    ),
    field(
      "New probe output folder",
      el("input", { id: "probe-output", placeholder: "/tmp/ree-native-probe" }),
    ),
    button("Run owned native probe", () => runNativeProbe()),
    nativeClaims(),
  ]);
}

function nativeClaims() {
  const probe = state.project?.native_probe;
  if (!probe) return null;
  return el("article", { class: "card" }, [
    el("h3", {}, `Native probe ${probe.status}`),
    el("p", {}, probe.note || probe.error || ""),
    el(
      "ul",
      {},
      (probe.claims ?? []).map((claim) =>
        el("li", {}, `${claim.name}: ${claim.status} (${claim.scope})`),
      ),
    ),
  ]);
}

async function previewRebuild(output) {
  const run = latestRun();
  if (!run) throw new Error("Complete an analysis before rebuilding.");
  state.rebuildPlan = await api(
    `/api/projects/${state.project.id}/runs/${run.id}/rebuild/preview`,
    { method: "POST", body: { output } },
  );
  state.rebuildResult = null;
  draw();
}

async function runRebuild(output, approved) {
  if (!approved) throw new Error("Check the box to write the rebuild.");
  if (!state.rebuildPlan) throw new Error("Preview the rebuild first.");
  const run = latestRun();
  state.rebuildResult = await api(
    `/api/projects/${state.project.id}/runs/${run.id}/rebuild`,
    {
      method: "POST",
      body: { output, approved: true, digest: state.rebuildPlan.digest },
    },
  );
  state.notice = `Rebuild map test ${state.rebuildResult.map_test}. Behavior is unverified.`;
  state.timeline = (
    await api(`/api/projects/${state.project.id}/runs/${run.id}/timeline`)
  ).events;
  draw();
}

async function runNativeProbe() {
  const artifact = state.project?.artifacts?.at(-1);
  if (!artifact)
    throw new Error("Add the owned C fixture before the native probe.");
  const output = document.querySelector("#probe-output")?.value ?? "";
  const approved =
    document.querySelector("#rebuild-approved")?.checked === true;
  if (!approved)
    throw new Error("Check the box to run the owned native probe.");
  state.project = await api(`/api/projects/${state.project.id}/native-probe`, {
    method: "POST",
    body: { artifact_id: artifact.id, output, approved: true },
  });
  state.notice = "Owned native probe started.";
  draw();
  await refreshProject();
  draw();
}

function palette() {
  const query = state.paletteQuery.toLowerCase();
  const items = visibleViews().filter(([, label]) =>
    label.toLowerCase().includes(query),
  );
  const input = el("input", {
    id: "palette-input",
    placeholder: "Jump to a view",
    value: state.paletteQuery,
    oninput: (event) => {
      state.paletteQuery = event.target.value;
      draw();
    },
    onkeydown: (event) => {
      if (event.key === "Enter" && items[0]) {
        event.preventDefault();
        openView(items[0][0]);
      }
    },
  });
  queueMicrotask(() => document.querySelector("#palette-input")?.focus());
  return el(
    "div",
    { class: "palette", role: "dialog", "aria-label": "Commands" },
    [
      el("div", { class: "palette-card" }, [
        input,
        el(
          "ul",
          {},
          items.map(([id, label]) =>
            el(
              "li",
              {},
              button(label, () => openView(id)),
            ),
          ),
        ),
        items.length === 0
          ? el("p", { class: "empty" }, "No view matches that text.")
          : null,
        el("p", { class: "note" }, "Esc closes. Ctrl+K or Cmd+K opens."),
      ]),
    ],
  );
}

function traceLabPanel() {
  const trace = state.project?.trace;
  const view = trace?.projection;
  const approved = el("input", { type: "checkbox", id: "trace-approved" });
  return el("section", { class: "panel" }, [
    el("p", { class: "eyebrow" }, "Trace Lab"),
    el("h2", {}, "Owned process observation"),
    el(
      "p",
      {},
      "This runs capture-process on experiments/rel-first-lab/cli.mjs with the query bridge. The capture is stored apart from static Evidence. Network and IPC events are not recorded by that contract.",
    ),
    el("label", { class: "check" }, [
      approved,
      "I approve this owned capture. It runs with my user permissions and is not a sandbox.",
    ]),
    button("Run owned trace", () => runOwnedTrace(approved.checked), {
      class: "primary",
    }),
    !trace
      ? el(
          "p",
          { class: "empty" },
          "No capture yet. Nothing is launched until you check the box and press Run owned trace.",
        )
      : el("article", { class: "card" }, [
          el("h3", {}, `Trace ${trace.status}`),
          trace.error ? el("p", { class: "bad" }, trace.error) : null,
          view
            ? el("div", {}, [
                el(
                  "p",
                  { class: "note" },
                  `Separate from static Evidence. Capture id ${view.evidence_id || "none"}.`,
                ),
                el(
                  "p",
                  {},
                  `Terminal frames: ${view.terminal?.frames ?? "unknown"}.`,
                ),
                el("h3", {}, "Filesystem checkpoints"),
                el(
                  "p",
                  { class: "note" },
                  view.filesystem?.note || view.filesystem?.reason,
                ),
                el(
                  "ul",
                  {},
                  (view.filesystem?.effects ?? [])
                    .slice(0, 12)
                    .map((effect) =>
                      el("li", {}, `${effect.status}: ${effect.path}`),
                    ),
                ),
                el("h3", {}, "Network"),
                el("p", {}, view.network.reason),
                el("h3", {}, "IPC"),
                el("p", {}, view.ipc.reason),
                el("h3", {}, "Static path correlation"),
                (view.correlated ?? []).length
                  ? el(
                      "ul",
                      {},
                      view.correlated.map((item) =>
                        el("li", {}, `${item.static_label}: ${item.note}`),
                      ),
                    )
                  : el(
                      "p",
                      { class: "note" },
                      "No checkpoint path matched a stored static label.",
                    ),
              ])
            : null,
        ]),
  ]);
}

function diffLines(prefix, items) {
  if (!items?.length) return null;
  return el(
    "pre",
    { class: "mono diff" },
    items.map((item) => `${prefix} ${item}`).join("\n"),
  );
}

function diffDimension(title, dimension) {
  if (!dimension) return null;
  if (dimension.status !== "compared")
    return el("article", { class: "card" }, [
      el("h3", {}, title),
      el("p", { class: "note" }, dimension.reason || "Unknown."),
    ]);
  return el("article", { class: "card" }, [
    el("h3", {}, title),
    el("p", {}, `${dimension.shared_count} shared.`),
    diffLines("-", dimension.only_left),
    diffLines("+", dimension.only_right),
    dimension.only_left.length === 0 && dimension.only_right.length === 0
      ? el("p", { class: "note" }, "No difference in this dimension.")
      : null,
  ]);
}

function diffLabPanel() {
  const artifacts = state.project?.artifacts ?? [];
  if (!state.project || artifacts.length < 2)
    return el("section", { class: "panel" }, [
      el("p", { class: "eyebrow" }, "Diff Lab"),
      el("h2", {}, "Drop two versions"),
      el(
        "p",
        { class: "empty" },
        "Add two artifacts on the front door or in Intake. Diff Lab compares their directory listings and, when both have Evidence, stored file identities and dependency edge ids. Functions, strings, and behavior stay unknown until those identities are stored.",
      ),
      button(
        "Go to the front door",
        () => {
          state.view = "door";
          draw();
        },
        { class: "primary" },
      ),
    ]);
  const left = el(
    "select",
    { id: "diff-left" },
    artifacts.map((artifact) =>
      el(
        "option",
        { value: artifact.id },
        artifact.intake?.label || artifact.id,
      ),
    ),
  );
  const right = el(
    "select",
    { id: "diff-right" },
    artifacts.map((artifact, index) =>
      el(
        "option",
        { value: artifact.id, selected: index === 1 ? "selected" : undefined },
        artifact.intake?.label || artifact.id,
      ),
    ),
  );
  const result = state.diffLab;
  return el("section", { class: "panel" }, [
    el("p", { class: "eyebrow" }, "Diff Lab"),
    el("h2", {}, "Two versions, only stored differences"),
    el(
      "p",
      {},
      "A path or edge id shown here was listed or saved. A dimension marked unknown was not stored. That is not evidence the dimension is empty.",
    ),
    field("Left version", left),
    field("Right version", right),
    button("Compare versions", () => runDiffLab(left.value, right.value), {
      class: "primary",
    }),
    result
      ? el("div", { class: "stack" }, [
          el("p", { class: "note" }, result.note),
          el(
            "p",
            {},
            `Left Evidence ${result.left.evidence_id || "none"}. Right Evidence ${result.right.evidence_id || "none"}.`,
          ),
          diffDimension("Structural listing", result.structural),
          diffDimension("Evidence file identities", result.evidence_files),
          diffDimension("Functions", result.functions),
          diffDimension("Dependencies", result.dependencies),
          diffDimension("Strings", result.strings),
          el("article", { class: "card" }, [
            el("h3", {}, "Behavior"),
            el("p", { class: "note" }, result.behavior.reason),
          ]),
          result.text?.status === "shown"
            ? el("article", { class: "card" }, [
                el("h3", {}, "Text"),
                el("p", { class: "note" }, result.text.note),
                el("pre", { class: "mono diff" }, result.text.lines.join("\n")),
              ])
            : el("article", { class: "card" }, [
                el("h3", {}, "Text"),
                el(
                  "p",
                  { class: "note" },
                  result.text?.reason || "No text diff.",
                ),
              ]),
        ])
      : null,
  ]);
}

function lessonsPanel() {
  if (!state.lessonCatalog)
    return el("section", { class: "panel" }, [
      el("h2", {}, "Guided lessons"),
      el(
        "p",
        { class: "empty" },
        "Lessons use owned fixtures in this checkout. Open the list to read them. A missing tool stays unavailable.",
      ),
      button("Load lessons", () => loadLessons(), { class: "primary" }),
    ]);
  const lesson = state.lesson;
  const step = lesson?.steps?.[state.lessonStep];
  return el("section", { class: "panel" }, [
    el("h2", {}, "Guided lessons"),
    el(
      "p",
      {},
      "Each lesson reads an owned fixture. It does not launch a target, and it does not invent tool output.",
    ),
    el(
      "div",
      { class: "stack" },
      state.lessonCatalog.lessons.map((item) =>
        button(item.title, () => openLesson(item.id), {
          class: lesson?.id === item.id ? "nav current" : "nav",
        }),
      ),
    ),
    lesson
      ? el("article", { class: "card" }, [
          el("h3", {}, lesson.title),
          el("p", {}, lesson.summary),
          el("p", { class: "note" }, `Fixture: ${lesson.fixture}`),
          step
            ? el("div", {}, [
                el(
                  "p",
                  { class: "eyebrow" },
                  `Step ${state.lessonStep + 1} of ${lesson.steps.length}`,
                ),
                el("h3", {}, step.title),
                el("p", {}, step.hint),
                step.observation.status === "unavailable"
                  ? el("p", { class: "empty" }, step.observation.reason)
                  : el(
                      "pre",
                      { class: "mono" },
                      step.observation.text || step.observation.note || "",
                    ),
                step.observation.note && step.observation.status === "shown"
                  ? el("p", { class: "note" }, step.observation.note)
                  : null,
              ])
            : null,
          button(
            state.lessonStep < lesson.steps.length - 1
              ? "Next hint"
              : "Back to the first hint",
            () => {
              state.lessonStep =
                state.lessonStep < lesson.steps.length - 1
                  ? state.lessonStep + 1
                  : 0;
              draw();
            },
            { class: "primary" },
          ),
        ])
      : el(
          "p",
          { class: "empty" },
          "Choose a lesson. The steps stay on the fixture named in the catalog.",
        ),
  ]);
}

function findingsPanel() {
  const run = latestRun();
  const holder = el("div", { id: "graph-holder" });
  if (state.graph) mountGraph(holder, state.graph, selectEdge);
  return el("section", { class: "panel" }, [
    el("h2", {}, "Findings"),
    el(
      "p",
      {},
      "Each sentence points at saved Evidence. Unknowns stay listed. The map shows stored relationships only.",
    ),
    run
      ? runCard(run)
      : emptyState(
          "No findings yet",
          "A finding appears only after Evidence is saved. Drop a target, authorize it, and press Analyze.",
          "Go to the front door",
          () => {
            state.view = "door";
            draw();
          },
        ),
    holder,
    factCard(),
    state.edge ? edgeDetail() : null,
    state.source ? sourceDetail() : null,
    mode() === "advanced"
      ? null
      : el(
          "p",
          { class: "note" },
          "Advanced opens readiness, the exact command, and the rest of the workspace.",
        ),
    run
      ? button("Build from this", () => buildFromThis(), { class: "primary" })
      : null,
    nextStep(
      run
        ? "Next: Build from this. Review the spec, uncheck features you do not want, then rebuild and verify."
        : "Next: finish an analysis. Build is for a behavior spec, not for copying this target.",
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
    run
      ? button("Build from this", () => buildFromThis(), { class: "primary" })
      : null,
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
  const file = el("input", {
    type: "file",
    id: "artifact-file",
    onchange: (event) => {
      void dropped(event.target.files).catch(setError);
    },
  });
  const folder = el("input", {
    type: "file",
    id: "artifact-folder",
    webkitdirectory: "true",
    multiple: "true",
    onchange: (event) => {
      void dropped(event.target.files).catch(setError);
    },
  });
  const drop = el(
    "div",
    {
      class: "drop",
      tabindex: "0",
      ondragover: (event) => {
        event.preventDefault();
      },
      ondrop: (event) => {
        event.preventDefault();
        void dropped(event.dataTransfer.files).catch(setError);
      },
    },
    "Drop a file or folder here. It is copied into this studio data directory and classified. Nothing is analyzed until you check authorization and run a route.",
  );
  return el("section", { class: "panel" }, [
    el("h2", {}, "Artifact intake"),
    el(
      "p",
      {},
      "Classification reads a directory listing or the first bytes of a file. It does not analyze or launch the target.",
    ),
    drop,
    el("div", { class: "file-row" }, [
      field("File", file),
      field("Folder", folder),
    ]),
    button("Use the owned JavaScript fixture", () => addOwned()),
    field("Path you are authorized to inspect", path),
    button("Classify path", () => addPath(path.value)),
    el("div", { class: "stack" }, state.project.artifacts.map(artifactCard)),
    el("h3", {}, "Run a ready route"),
    field("Question stored with the next run", question),
    el("label", { class: "check" }, [
      checkbox,
      "I am authorized to inspect the selected target. The chosen route reads it and does not launch it, except a configured Ghidra overview which still does not modify the file.",
    ]),
    button("Run selected route", () => analyze(question.value), {
      class: "primary",
    }),
    el("div", { class: "stack" }, state.project.runs.map(runCard)),
  ]);
}

function artifactCard(artifact) {
  const routes = artifact.intake.routes ?? [];
  const ready = routes.find((route) => route.status === "ready");
  const chosen =
    state.routeChoice?.artifactId === artifact.id
      ? state.routeChoice.routeId
      : ready?.id;
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
    ...routes.map((route) =>
      el("label", { class: "check" }, [
        el("input", {
          type: "radio",
          name: `route-${artifact.id}`,
          checked: route.id === chosen ? "checked" : false,
          onchange: () => {
            state.routeChoice = { artifactId: artifact.id, routeId: route.id };
          },
        }),
        `${route.label}: ${route.status}. ${route.detail}`,
      ]),
    ),
    button("Check routes again", () => refreshRoutes(artifact.id)),
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
  if (run.provider?.id)
    rows.push(
      el(
        "p",
        {},
        `Provider ${run.provider.name || run.provider.id} (${run.provider.id}).`,
      ),
    );
  for (const statement of run.narrative?.statements ?? [])
    rows.push(
      el("p", {}, [
        statement.text,
        " ",
        el(
          "span",
          { class: "note" },
          `${statement.evidence_id} · ${statement.path}`,
        ),
        " ",
        button("Explain this", () =>
          showExplain({
            kind: "finding",
            text: statement.text,
            evidence_id: statement.evidence_id,
            path: statement.path,
            unknowns: run.narrative?.unknowns ?? [],
          }),
        ),
        " ",
        button("Show evidence", () => {
          state.selectedFact = factForStatement(statement);
          state.view = "findings";
          draw();
        }),
      ]),
    );
  if ((run.narrative?.unknowns ?? []).length)
    rows.push(
      el(
        "p",
        { class: "note" },
        `Unknowns: ${run.narrative.unknowns.join(" ")}`,
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
    setupPanel(report),
    mode() === "advanced"
      ? el(
          "pre",
          { class: "mono" },
          JSON.stringify(report.tool_commands_on_path, null, 2),
        )
      : null,
  ]);
}

function setupPanel(report) {
  const setup = report.setup;
  if (!setup) return null;
  return el("div", { class: "stack" }, [
    el("h3", {}, "Setup"),
    el(
      "p",
      {},
      "An install runs only after you check the box for the exact command. The studio then runs that argv and checks the route again.",
    ),
    ...setup.offers.map((offer) => {
      const box = el("input", { type: "checkbox" });
      return el("article", { class: "card" }, [
        el("h3", {}, offer.id),
        el("pre", { class: "mono" }, offer.argv.join(" ")),
        el("p", {}, offer.changes),
        el("p", { class: "note" }, offer.does_not),
        offer.available
          ? el("label", { class: "check" }, [
              box,
              "I approve running this exact command.",
            ])
          : el("p", { class: "note" }, offer.unavailable_reason),
        offer.available
          ? button("Run this exact command", () =>
              approveSetup(offer, box.checked),
            )
          : null,
      ]);
    }),
    ...setup.guidance.map((item) => el("p", { class: "note" }, item.text)),
  ]);
}

function routeCard(route) {
  return el("article", { class: "card" }, [
    el("h3", {}, route.label),
    route.status
      ? el("p", { class: statusClass(route.status) }, route.status)
      : null,
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
      : el(
          "p",
          { class: "empty" },
          "No Evidence window is loaded. Search after a completed run. A hit is a recorded relationship, not a new analysis.",
        ),
  ]);
}

function evidenceResult(result) {
  const narrative = latestRun()?.narrative;
  return el("div", {}, [
    el(
      "p",
      {},
      `Evidence ${result.evidence_id}. Matching ${result.matching}; showing ${result.displayed}.`,
    ),
    result.provider
      ? el(
          "p",
          {},
          `Provider ${result.provider.name || result.provider.id} (${result.provider.id}). Operation ${result.operation || "unrecorded"}.`,
        )
      : null,
    el("p", { class: "note" }, result.graph_note || result.status || ""),
    ...(narrative?.statements ?? []).map((statement) =>
      el("p", {}, [
        statement.text,
        " ",
        el(
          "span",
          { class: "note" },
          `${statement.evidence_id} · ${statement.path}`,
        ),
      ]),
    ),
    (narrative?.unknowns ?? []).length
      ? el("p", { class: "note" }, `Unknowns: ${narrative.unknowns.join(" ")}`)
      : null,
    latestRun()
      ? button("Build from this", () => buildFromThis(), { class: "primary" })
      : null,
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
    state.graph
      ? null
      : el(
          "p",
          { class: "empty" },
          "No graph window is loaded. Load one after a completed run. The map shows stored relationships only.",
        ),
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
      `Local stages are ${config?.enabled ? "on" : "off"}. An env model key is ${config?.key_configured ? "set" : "not set"}. A model runs only when local research is on and you check the box.`,
    ),
    config?.model
      ? el(
          "p",
          { class: "note" },
          `Provider ${config.model.provider}, model ${config.model.model}, budget ${config.model.budget_usd ?? "unset"} USD. Cost stays unknown unless the provider returns usage and REE_MODEL_USD_PER_MILLION is set.`,
        )
      : null,
    button(
      config?.enabled ? "Turn local research off" : "Turn local research on",
      toggleResearch,
    ),
    el("label", { class: "check" }, [
      el("input", {
        type: "checkbox",
        id: "model-opt-in",
        checked: state.modelOptIn ? "checked" : false,
        onchange: (event) => {
          state.modelOptIn = event.target.checked;
        },
      }),
      "Ask the model with retrieved Evidence only. Claims that cite no retrieved id are rejected.",
    ]),
    button("Run research", runResearch, {
      class: "primary",
      disabled: !config?.enabled,
    }),
    ...sessions.slice(-1).map(sessionCard),
    latestRun()
      ? button("Build from this", () => buildFromThis(), { class: "primary" })
      : null,
  ]);
}

function sessionCard(session) {
  return el("article", { class: "card" }, [
    el("h3", {}, `Session ${session.id}`),
    el(
      "p",
      {},
      `Tool calls ${session.tool_calls} / budget ${session.tool_call_budget}. Remote: ${session.remote_calls}. Cost: ${session.cost?.status || "not recorded"}${session.cost?.tokens != null ? `, tokens ${session.cost.tokens}` : ""}${session.cost?.usd != null ? `, USD ${session.cost.usd}` : ""}.`,
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
  try {
    localStorage.setItem("ree-studio-project", id);
  } catch {
    /* the project still opens for this page */
  }
  state.view = mode() === "advanced" ? "overview" : "door";
  state.capabilities = state.project.artifacts.length > 0;
  state.error = "";
  draw();
  await refreshProject();
}

async function ensureProject() {
  if (state.project) return;
  const project = await api("/api/projects", {
    method: "POST",
    body: {
      name: "Investigation",
      question: "What is this, in plain language?",
      mode: "simple",
    },
  });
  await loadProjects();
  state.project = project;
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
  state.capabilities = true;
  draw();
}

async function addPath(path) {
  state.project = await api(`/api/projects/${state.project.id}/artifacts`, {
    method: "POST",
    body: { path },
  });
  state.notice = "Path classified. No analysis has run.";
  state.capabilities = true;
  draw();
}

async function dropped(fileList) {
  const files = [...(fileList ?? [])].slice(0, 24);
  if (files.length === 0) return;
  state.phase = "copying";
  draw();
  await ensureProject();
  let batch = null;
  let project = null;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const headers = {
      "x-ree-studio-token": token,
      "content-type": "application/octet-stream",
      "x-ree-artifact-name": file.name,
    };
    if (file.webkitRelativePath)
      headers["x-ree-artifact-relative"] = file.webkitRelativePath;
    if (batch) headers["x-ree-upload-batch"] = batch;
    if (index === files.length - 1) headers["x-ree-classify"] = "true";
    const response = await fetch(
      `/api/projects/${state.project.id}/artifacts/bytes`,
      { method: "POST", headers, body: file },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Drop failed");
    batch = data.batch_id;
    if (data.project) project = data.project;
  }
  if (project) state.project = project;
  state.phase = "idle";
  state.notice =
    "Drop copied into the studio data directory and classified. No analysis has run.";
  state.capabilities = true;
  draw();
}

async function showLinkPlan(input) {
  await ensureProject();
  state.phase = "planning";
  draw();
  const route = /^https?:\/\//iu.test(input.trim())
    ? "outside-in/plan"
    : "links/plan";
  state.linkPlan = await api(`/api/projects/${state.project.id}/${route}`, {
    method: "POST",
    body: { input },
  });
  state.linkInput = input.trim();
  state.phase = "idle";
  state.notice = "Nothing has been fetched.";
  draw();
}

async function frontDoorRun() {
  if (!state.authorized)
    throw new Error("Confirm authorization before analysis.");
  await ensureProject();
  const typed = state.linkInput.trim();
  if (typed) {
    if (!state.linkPlan || state.linkPlan.input !== typed) {
      await showLinkPlan(typed);
      state.notice = "Review the fetch plan, then confirm authorization again.";
      draw();
      return;
    }
    if (state.linkPlan.kind === "outside-in") {
      state.phase = "running";
      state.draft = null;
      state.draftFor = "";
      state.draftError = "";
      draw();
      const started = await api(
        `/api/projects/${state.project.id}/outside-in`,
        {
          method: "POST",
          body: {
            input: state.linkPlan.input,
            approved: true,
            plan_digest: state.linkPlan.plan_digest,
            authorized: true,
          },
        },
      );
      state.project = started.project;
      state.notice = started.note;
      state.phase = "idle";
      state.view = "findings";
      state.scrollTo = "findings";
      state.linkInput = "";
      state.linkPlan = null;
      draw();
      await refreshProject();
      return;
    }
    state.phase = "fetching";
    draw();
    state.project = await api(`/api/projects/${state.project.id}/links`, {
      method: "POST",
      body: {
        input: state.linkPlan.input,
        approved: true,
        plan_digest: state.linkPlan.plan_digest,
      },
    });
    state.linkInput = "";
    state.linkPlan = null;
    state.capabilities = true;
  }
  state.phase = "running";
  await analyze(state.project.question || "");
}

async function refreshRoutes(artifactId) {
  state.project = await api(
    `/api/projects/${state.project.id}/artifacts/${artifactId}/routes`,
    { method: "POST", body: {} },
  );
  state.notice = "Routes checked again. No analysis has run.";
  draw();
}

async function approveSetup(offer, checked) {
  if (!checked) throw new Error("Check the box to approve the exact command.");
  const result = await api("/api/setup", {
    method: "POST",
    body: {
      offer_id: offer.id,
      approved: true,
      command_digest: offer.command_digest,
    },
  });
  state.readiness = result.readiness;
  state.notice = `Command exited ${result.exit_code}. Routes were checked again.`;
  draw();
}

async function analyze(question) {
  const artifact =
    state.project.artifacts.find(
      (item) => item.id === state.routeChoice?.artifactId,
    ) ?? state.project.artifacts.at(-1);
  if (!artifact) throw new Error("Add an artifact before analysis.");
  if (!state.authorized)
    throw new Error("Confirm authorization before analysis.");
  const routeId =
    state.routeChoice?.artifactId === artifact.id
      ? state.routeChoice.routeId
      : artifact.intake.routes?.find((route) => route.status === "ready")?.id;
  state.phase = "running";
  state.project = await api(`/api/projects/${state.project.id}/runs`, {
    method: "POST",
    body: {
      artifact_id: artifact.id,
      authorized: true,
      question,
      route_id: routeId,
    },
  });
  state.notice = "Static analysis started.";
  state.view = "analyze";
  state.scrollTo = "analyze";
  state.replayTo = null;
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
  if (edge?.kind === "node") {
    const nodeKind = edge.node_kind ?? null;
    showExplain({
      kind: nodeKind === "javascript-module" ? "module" : "node",
      id: edge.id,
      label: edge.label,
      node_kind: nodeKind,
      group: edge.group,
      evidence_id: latestRun()?.evidence_id ?? null,
    });
    return;
  }
  state.edge = edge;
  state.source = null;
  showExplain({
    ...edge,
    kind: "edge",
    evidence_id: latestRun()?.evidence_id ?? null,
  });
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
    body: { model: state.modelOptIn === true },
  });
  state.notice = state.modelOptIn
    ? "Research finished. A model ran only if an env key was set, and uncited claims were rejected."
    : "Local research stages finished. No model was called.";
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
    const keep = state.scrollTo ? 0 : window.scrollY;
    shell();
    if (state.scrollTo) {
      document.getElementById(`path-${state.scrollTo}`)?.scrollIntoView({
        block: "start",
      });
      state.scrollTo = "";
    } else if (keep > 0) window.scrollTo(0, keep);
    if (state.view === "analyze") {
      for (const list of document.querySelectorAll("#main .timeline"))
        list.scrollTop = list.scrollHeight;
    }
    watchPath();
    primePath();
  } catch (error) {
    document.querySelector("#app").textContent = error.message;
  }
}

async function runOwnedTrace(approved) {
  if (!state.project) throw new Error("Open a project before running a trace.");
  state.project = await api(`/api/projects/${state.project.id}/trace`, {
    method: "POST",
    body: { approved },
  });
  state.notice = "Owned trace started. It is not part of static Evidence.";
  draw();
  await refreshProject();
  draw();
}

async function runDiffLab(leftId, rightId) {
  state.diffLab = await api(`/api/projects/${state.project.id}/diff-lab`, {
    method: "POST",
    body: { left_artifact_id: leftId, right_artifact_id: rightId },
  });
  draw();
}

async function loadLessons() {
  state.lessonCatalog = await api("/api/lessons");
  draw();
}

async function openLesson(id) {
  state.lesson = await api(`/api/lessons/${id}`);
  state.lessonStep = 0;
  state.view = "lessons";
  draw();
}

function showExplain(subject) {
  state.explain = explainSubject(subject);
  draw();
}

function explainCard() {
  const item = state.explain;
  if (!item) return null;
  return el("aside", { class: "explain", "aria-label": "Explanation" }, [
    el("h3", {}, item.title),
    el("p", { class: "note" }, "Local template. No model was called."),
    el("p", {}, item.text),
    explainList("Facts", item.facts, "No stored fact was attached."),
    explainList(
      "Hypotheses",
      item.hypotheses,
      "None. A template does not guess.",
    ),
    explainList("Unknowns", item.unknowns, "None recorded."),
    item.evidence_ids.length
      ? el("p", { class: "note" }, `Evidence: ${item.evidence_ids.join(", ")}`)
      : el("p", { class: "note" }, "No Evidence id."),
    button("Close explanation", () => {
      state.explain = null;
      draw();
    }),
  ]);
}

function explainList(title, items, empty) {
  return el("div", {}, [
    el("h4", {}, title),
    el(
      "ul",
      {},
      (items.length ? items : [empty]).map((line) => el("li", {}, line)),
    ),
  ]);
}

const TOUR = [
  {
    title: "Drop a target",
    body: "The front door copies a file, folder, or an approved link into this studio. Nothing is analyzed until you tick authorization.",
  },
  {
    title: "One primary action",
    body: "Each screen has one filled button. Here it is Analyze, or Fetch and analyze after you approve a link preview.",
  },
  {
    title: "Read what was saved",
    body: "Analyze shows recorded engine lines. Findings lists saved Evidence. Build writes a new folder from a behavior spec and does not copy the target. A local explanation does not call a model.",
  },
];

function tourCard() {
  const step = TOUR[state.tourStep] ?? TOUR[0];
  return el(
    "div",
    { class: "palette", role: "dialog", "aria-label": "First-run tour" },
    [
      el("div", { class: "palette-card" }, [
        el(
          "p",
          { class: "eyebrow" },
          `Tour ${state.tourStep + 1} of ${TOUR.length}`,
        ),
        el("h2", {}, step.title),
        el("p", {}, step.body),
        el("div", { class: "top-actions" }, [
          state.tourStep > 0
            ? button("Back", () => {
                state.tourStep -= 1;
                draw();
              })
            : null,
          state.tourStep < TOUR.length - 1
            ? button(
                "Next",
                () => {
                  state.tourStep += 1;
                  draw();
                },
                { class: "primary" },
              )
            : button("Start on the front door", () => finishTour(), {
                class: "primary",
              }),
          button("Skip tour", () => finishTour()),
        ]),
      ]),
    ],
  );
}

function finishTour() {
  state.tour = false;
  try {
    localStorage.setItem("ree-studio-tour-v1", "done");
  } catch {
    /* private mode can refuse storage; the tour stays dismissed for this page */
  }
  draw();
}

function shortcutSheet() {
  const rows = [
    ["Ctrl or Cmd K", "Open the command list"],
    ["?", "Open this shortcut list"],
    ["Escape", "Close the command list, shortcuts, tour, or explanation"],
    ["1", "Front door"],
    ["2", "Analyze"],
    ["3", "Findings"],
    ["4", "Build"],
    ["L", "Lessons, under Advanced"],
    ["D", "Diff Lab, under Advanced"],
    ["T", "Trace Lab, under Advanced"],
  ];
  return el(
    "div",
    { class: "palette", role: "dialog", "aria-label": "Keyboard shortcuts" },
    [
      el("div", { class: "palette-card" }, [
        el("h2", {}, "Keyboard shortcuts"),
        el(
          "ul",
          {},
          rows.map(([key, action]) => el("li", {}, `${key}: ${action}`)),
        ),
        button("Close", () => {
          state.shortcuts = false;
          draw();
        }),
      ]),
    ],
  );
}

function typingTarget(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;
}

async function boot() {
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      state.palette = !state.palette;
      state.paletteQuery = "";
      draw();
      document.querySelector("#palette-input")?.focus();
      return;
    }
    if (event.key === "Escape") {
      if (!state.palette && !state.shortcuts && !state.tour && !state.explain)
        return;
      const touring = state.tour;
      state.palette = false;
      state.shortcuts = false;
      state.explain = null;
      if (touring) finishTour();
      else draw();
      return;
    }
    if (typingTarget(event.target)) return;
    if (event.key === "?") {
      state.shortcuts = !state.shortcuts;
      draw();
      return;
    }
    const viewKeys = {
      1: "door",
      2: "analyze",
      3: "findings",
      4: "build",
    };
    if (event.key.toLowerCase() === "l") {
      openView("lessons");
      return;
    }
    if (event.key.toLowerCase() === "d") {
      openView("diff-lab");
      return;
    }
    if (event.key.toLowerCase() === "t") {
      openView("trace-lab");
      return;
    }
    if (viewKeys[event.key]) openView(viewKeys[event.key]);
  });
  try {
    state.tour = localStorage.getItem("ree-studio-tour-v1") !== "done";
  } catch {
    state.tour = false;
  }
  const session = await api("/api/session");
  token = session.token;
  state.onboardingSeen = session.onboarding_seen === true;
  state.readiness = await api("/api/readiness");
  state.researchConfig = await api("/api/research");
  await loadProjects();
  let saved = null;
  try {
    saved = localStorage.getItem("ree-studio-project");
  } catch {
    saved = null;
  }
  if (saved && state.projects.some((project) => project.id === saved))
    await openProject(saved);
  else draw();
}

boot().catch(setError);
