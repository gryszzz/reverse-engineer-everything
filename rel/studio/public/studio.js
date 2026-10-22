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
  onboardingSeen: true,
  explain: null,
  tour: false,
  tourStep: 0,
  shortcuts: false,
  capabilities: false,
  lessonCatalog: null,
  lesson: null,
  lessonStep: 0,
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
      state.phase = "idle";
      state.notice =
        "Analysis finished. The timeline is recorded engine progress and Evidence.";
    }
  }
  const busy =
    [...state.project.runs, ...state.project.experiments].some(
      (item) => item.status === "running",
    ) || state.project.native_probe?.status === "running";
  if (!busy && state.phase === "running") state.phase = "idle";
  const watched =
    state.project.runs.find((run) => run.status === "running") ?? latestRun();
  if (watched)
    state.timeline = (
      await api(`/api/projects/${state.project.id}/runs/${watched.id}/timeline`)
    ).events;
  if (busy) setTimeout(() => refreshProject().then(draw).catch(setError), 400);
}

function openView(id) {
  state.view = id;
  state.palette = false;
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
    el("header", { class: "top" }, [
      el("div", { class: "brand" }, [
        el("p", { class: "mark" }, "REE"),
        el("div", {}, [
          el("h1", {}, "Investigation Studio"),
          el(
            "p",
            { class: "tag" },
            "Local evidence. No account. No remote upload.",
          ),
        ]),
      ]),
      el("div", { class: "top-actions" }, [
        el("span", { class: "pill" }, "127.0.0.1"),
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
        el("p", { class: "rail-label" }, "Workspace"),
        ...primaryFlow.map(([id, label]) =>
          button(label, () => openView(id), {
            class: state.view === id ? "nav current" : "nav",
            "aria-current": state.view === id ? "page" : undefined,
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
                state.project = await api(`/api/projects/${state.project.id}`, {
                  method: "PATCH",
                  body: { mode: "advanced" },
                });
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
      el("main", { id: "main", tabindex: "-1" }, [
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
      ]),
    ]),
    state.palette ? palette() : null,
    state.shortcuts ? shortcutSheet() : null,
    state.tour ? tourCard() : null,
  );
}

function panel() {
  if (state.view === "readiness") return readinessPanel();
  if (state.view === "analyze" || state.view === "theater")
    return theaterPanel();
  if (state.view === "board") return boardPanel();
  if (state.view === "build") return buildPanel();
  if (state.view === "door" || !state.project) return doorPanel();
  if (state.view === "rebuild") return rebuildPanel();
  if (state.view === "findings") return findingsPanel();
  if (state.view === "lessons") return lessonsPanel();
  if (state.view === "intake") return intakePanel();
  if (state.view === "evidence") return evidencePanel();
  if (state.view === "graph") return graphPanel();
  if (state.view === "research") return researchPanel();
  if (state.view === "experiment") return experimentPanel();
  if (state.view === "report") return reportPanel();
  return overviewPanel();
}

function doorPanel() {
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
  return el("section", { class: "panel door" }, [
    el("p", { class: "eyebrow" }, "Investigation Studio"),
    el("h2", {}, "Drop a file, folder, or paste a link"),
    el(
      "p",
      {},
      "A local drop is copied into this studio and classified. A link is fetched only after you approve the URLs below. REE then picks a ready route and waits for the authorization tick. Nothing is executed.",
    ),
    el(
      "p",
      { class: "note" },
      "Simple Mode is the default. The first ready route is selected for you. Authorization stays off until you tick it. Research stays off.",
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
    state.capabilities && artifact ? capabilitiesPanel(artifact) : null,
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
    mode() === "advanced"
      ? button("Use the owned JavaScript fixture", () => addOwned())
      : null,
  ]);
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
  return el("article", { class: "card" }, [
    el("h3", {}, "This is what will be fetched"),
    el("p", {}, plan.note),
    ...plan.requests.map((request) =>
      el(
        "p",
        { class: "mono" },
        `${request.purpose}: ${request.url} · limit ${request.limit_bytes} bytes · ${request.timeout_ms} ms${request.exact ? "" : " · the exact URL is constrained by this rule"}`,
      ),
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
  for (const event of events) {
    if (event.file && !files.includes(event.file)) files.push(event.file);
  }
  const edges = events.filter(
    (event) => event.phase === "edge" && event.to && files.includes(event.from),
  );
  return { files, edges };
}

function flowStepper() {
  return el(
    "ol",
    { class: "stepper" },
    primaryFlow.map(([id, label]) =>
      el(
        "li",
        { class: state.view === id ? "current" : "" },
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
      "Drop a file or paste a link you are allowed to fetch. Analyze shows the engine progress that route actually emits. Findings quote saved Evidence. Board lists Scout records and behavior specs you ingest. Build writes a clean-room folder and a dry-run handoff.",
    ),
    button("Hide this introduction", async () => {
      await api("/api/onboarding", { method: "POST", body: {} });
      state.onboardingSeen = true;
      draw();
    }),
  ]);
}

function boardPanel() {
  const input = el("textarea", {
    id: "board-json",
    rows: "8",
    placeholder: "Paste a Scout target or a behavior spec JSON object.",
  });
  const scout = state.board?.scout ?? [];
  const specs = state.board?.specs ?? [];
  return el("section", { class: "panel" }, [
    el("h2", {}, "Board"),
    el(
      "p",
      {},
      "Scout scores stay the integers in the file. A behavior spec is listed by coverage and has no market score.",
    ),
    !state.board || (scout.length === 0 && specs.length === 0)
      ? el(
          "p",
          { class: "empty" },
          "No opportunities ingested. Paste a Scout target or an outside-in spec.",
        )
      : null,
    scout.length
      ? el(
          "ul",
          {},
          scout.map((item) =>
            el(
              "li",
              {},
              `${item.target_name}: ${item.listing.scores.total}/25, confidence ${item.listing.confidence}. ${item.listing.note}`,
            ),
          ),
        )
      : null,
    specs.length
      ? el(
          "ul",
          {},
          specs.map((item) =>
            el(
              "li",
              {},
              `${item.target_name}: ${item.listing.coverage.features} features. ${item.listing.note}`,
            ),
          ),
        )
      : null,
    input,
    button("Ingest", async () => {
      const value = JSON.parse(input.value);
      state.board = await api("/api/board", { method: "POST", body: value });
      state.notice = "Ingested. Scores were not invented.";
      draw();
    }),
  ]);
}

function buildPanel() {
  const name = el("input", {
    id: "build-name",
    placeholder: "New product name",
  });
  const spec = el("textarea", {
    id: "build-spec",
    rows: "8",
    placeholder: "Paste a ree.outside-in.behavior-spec.v1 object.",
  });
  const result = state.build;
  return el("section", { class: "panel" }, [
    el("h2", {}, "Build"),
    el(
      "p",
      {},
      "Writes a new folder in the studio data directory. Source is a feature registry. Quotes are not copied. The handoff is a dry run: Blast is not notified, Guard is not called, and Vault is not copied.",
    ),
    !result
      ? el(
          "p",
          { class: "empty" },
          "No scaffold yet. A declaration match is not a running product.",
        )
      : el("article", { class: "card" }, [
          el("p", {}, `Build ${result.build_id}`),
          el(
            "p",
            {},
            `Accounted ${result.verify.accounted} of ${result.verify.total}.`,
          ),
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
            "Dry run. Launch still needs Guard PASS and Tony's go-ahead.",
          ),
        ]),
    field("Product name", name),
    spec,
    button("Scaffold and verify", async () => {
      state.build = await api("/api/builds", {
        method: "POST",
        body: { product_name: name.value, spec: JSON.parse(spec.value) },
      });
      state.notice =
        "Scaffold written. Features are declared, not implemented.";
      draw();
    }),
  ]);
}

function watchedRun() {
  return (
    state.project?.runs?.find((run) => run.status === "running") ??
    state.project?.runs?.at(-1) ??
    null
  );
}

function processFact(event) {
  const parts = [event.at, event.kind];
  if (event.route_id) parts.push(event.route_id);
  if (event.bytes) parts.push(`${event.bytes} bytes`);
  if (event.evidence_id) parts.push(event.evidence_id);
  if (event.code !== undefined && event.code !== null)
    parts.push(`exit ${event.code}`);
  return parts.filter((part) => part !== undefined && part !== "").join(" ");
}

function theaterPanel() {
  const events = shownEvents();
  const stats = theaterStats(events);
  const graph = theaterGraph(events);
  const holder = el("div", { class: "theater-graph", id: "theater-graph" });
  holder.append(theaterSvg(graph));
  const run = watchedRun();
  const processEvents = run?.events ?? [];
  return el("section", { class: "panel theater" }, [
    el("p", { class: "eyebrow" }, "Investigation Theater"),
    el("h2", {}, "Analyze"),
    el(
      "p",
      {},
      "Each line is an engine progress event or a fact read from written Evidence. Process lines are start, the first output chunk, and exit. Nothing here is simulated.",
    ),
    !state.project
      ? el(
          "p",
          { class: "empty" },
          "No project yet. Drop a file on the front door.",
        )
      : null,
    state.project && !run
      ? el(
          "p",
          { class: "empty" },
          "No analysis has started. Choose Analyze on the front door after you authorize the target.",
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
      stat("Edges", String(stats.edges)),
      stat(
        "Evidence",
        stats.evidence ? stats.evidence.slice(0, 12) + "…" : "not yet",
      ),
    ]),
    stageRow(),
    holder,
    events.length
      ? el(
          "ol",
          { class: "timeline" },
          events.map((event) =>
            el("li", {}, [
              el("span", { class: "phase" }, event.phase),
              el("span", {}, event.message),
              event.phase === "module" && event.file
                ? button("Explain this", () =>
                    showExplain({
                      kind: "module",
                      label: event.file,
                      node_kind: "javascript-module",
                      evidence_id: stats.evidence,
                    }),
                  )
                : null,
            ]),
          ),
        )
      : run
        ? el(
            "p",
            { class: "empty" },
            "This run has no recorded engine progress lines.",
          )
        : state.project
          ? el(
              "p",
              { class: "empty" },
              "The theater is empty because no analysis has written progress yet. Use the front door: drop a target, tick authorization, and press Analyze. A line appears only when the engine emits it.",
            )
          : null,
    processEvents.length
      ? el(
          "ol",
          { class: "timeline" },
          processEvents.map((event) => el("li", {}, processFact(event))),
        )
      : run && events.length === 0
        ? el("p", { class: "empty" }, "This run has no recorded engine events.")
        : null,
    button("Replay recorded timeline", () => replayTimeline(), {
      class: "primary",
    }),
  ]);
}

function stat(label, value) {
  return el("div", {}, [el("dt", {}, label), el("dd", {}, value)]);
}

function stageRow() {
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
  title.setAttribute("fill", "#b9a6ff");
  title.textContent =
    graph.files.length === 0
      ? "No parsed file has been reported yet."
      : "Files the engine reported while parsing.";
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
    path.setAttribute(
      "d",
      `M 236 ${from + 16} C 300 ${from + 16}, 300 ${to + 16}, 236 ${to + 16}`,
    );
    path.setAttribute("class", "edge-line");
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
      : el(
          "p",
          { class: "empty" },
          "No completed analysis yet. Drop a target on the front door, authorize it, and press Analyze. A finding appears only after Evidence is saved.",
        ),
    run
      ? null
      : button(
          "Go to the front door",
          () => {
            state.view = "door";
            draw();
          },
          { class: "primary" },
        ),
    holder,
    state.edge ? edgeDetail() : null,
    state.source ? sourceDetail() : null,
    mode() === "advanced"
      ? null
      : el(
          "p",
          { class: "note" },
          "Advanced mode opens readiness, the exact command, and the rest of the workspace.",
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
  state.linkPlan = await api(`/api/projects/${state.project.id}/links/plan`, {
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
    body: "Analyze, Findings, and Explain this restate engine progress and Evidence. Board and Build turn a behavior spec into a clean-room folder. A local explanation does not call a model and does not fill an unknown.",
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
    ["4", "Board"],
    ["5", "Build"],
    ["L", "Lessons"],
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
      4: "board",
      5: "build",
    };
    if (event.key.toLowerCase() === "l") {
      openView("lessons");
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
  draw();
}

boot().catch(setError);
