import { itemById } from "./catalog.mjs";

export function filterByTag(items, tag) {
  const match = itemById(items, tag);
  if (match === null) return [];
  return [match];
}
