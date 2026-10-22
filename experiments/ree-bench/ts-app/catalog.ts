// Owned accuracy fixture. TypeScript source, not emitted JavaScript.
export const ITEM_TAG: string = "beta-item";

export function itemById(
  items: { id: string }[],
  id: string,
): { id: string } | null {
  for (const item of items) {
    if (item.id === id) return item;
  }
  return null;
}
