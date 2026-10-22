import { itemById } from "./catalog.ts";

export function filterByTag(
  items: { id: string }[],
  tag: string,
): { id: string }[] {
  const match = itemById(items, tag);
  if (match === null) return [];
  return [match];
}
