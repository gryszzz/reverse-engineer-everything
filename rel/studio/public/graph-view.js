import { el } from "./format.js";

const svgNS = "http://www.w3.org/2000/svg";

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attrs))
    node.setAttribute(key, String(value));
  return node;
}

/** Draw only the nodes and edges in the supplied window. Positions are display-only. */
export function mountGraph(container, payload, onSelect) {
  container.replaceChildren();
  const note = el("p", { class: "note" }, payload.execution_note || "");
  if (!payload.edges || payload.edges.length === 0) {
    container.append(
      note,
      el("p", { class: "empty" }, "This window has no recorded relationships."),
    );
    return;
  }
  const groups = new Map();
  for (const node of payload.nodes) {
    const key = node.group || "unlabeled";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const pos = new Map();
  let column = 0;
  let maxY = 120;
  for (const nodes of groups.values()) {
    nodes.forEach((node, row) => {
      const point = { x: 28 + column * 230, y: 28 + row * 72 };
      pos.set(node.id, point);
      maxY = Math.max(maxY, point.y + 64);
    });
    column += 1;
  }
  const width = Math.max(680, column * 230 + 48);
  const height = maxY + 24;
  const frame = el("div", { class: "graph-frame" });
  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": "Recorded relationship window",
  });
  svg.classList.add("graph");
  const viewport = svgEl("g");
  for (const edge of payload.edges) {
    const from = pos.get(edge.source.id);
    const to = pos.get(edge.target.id);
    if (!from || !to) continue;
    const path = svgEl("path", {
      d: `M ${from.x + 150} ${from.y + 22} C ${from.x + 190} ${from.y + 22}, ${to.x - 40} ${to.y + 22}, ${to.x} ${to.y + 22}`,
      class: `edge edge-${edge.basis || "unclassified"}`,
    });
    path.addEventListener("click", () => onSelect(edge));
    viewport.append(path);
  }
  for (const node of payload.nodes) {
    const point = pos.get(node.id);
    if (!point) continue;
    const group = svgEl("g", {
      class: "node",
      transform: `translate(${point.x} ${point.y})`,
    });
    group.append(svgEl("rect", { width: 168, height: 44, rx: 8 }));
    const label = svgEl("text", { x: 12, y: 27 });
    label.textContent = node.label.slice(0, 22);
    group.append(label);
    viewport.append(group);
  }
  svg.append(viewport);
  frame.append(svg);
  const table = el("table", { class: "data" });
  table.append(
    el("caption", {}, "Recorded relationships in this window"),
    el("thead", {}, [
      el(
        "tr",
        {},
        ["From", "Relation", "To", "Basis", "Evidence"].map((name) =>
          el("th", {}, name),
        ),
      ),
    ]),
  );
  const body = el("tbody");
  for (const edge of payload.edges) {
    const row = el("tr", {}, [
      el("td", {}, edge.source.label),
      el("td", {}, edge.relation),
      el("td", {}, edge.target.label),
      el("td", {}, edge.basis),
      el("td", {}, edge.edge_id || ""),
    ]);
    row.tabIndex = 0;
    row.addEventListener("click", () => onSelect(edge));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect(edge);
      }
    });
    body.append(row);
  }
  table.append(body);
  container.append(note, frame, table);
}
