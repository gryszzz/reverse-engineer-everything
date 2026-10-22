export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
  return node;
}

export function statusClass(value) {
  if (
    value === "completed" ||
    value === "present" ||
    value === "implemented" ||
    value === "ready"
  )
    return "ok";
  if (
    value === "failed" ||
    value === "missing" ||
    value === "missing-tool" ||
    value === "unsupported"
  )
    return "bad";
  if (value === "running" || value === "recorded-in-this-studio") return "live";
  return "muted";
}
