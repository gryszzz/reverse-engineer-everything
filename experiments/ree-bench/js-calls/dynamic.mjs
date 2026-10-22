export async function load(items, id) {
  const catalog = await import("./catalog.mjs");
  return catalog.itemById(items, id);
}
