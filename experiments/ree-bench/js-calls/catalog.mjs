// Owned accuracy fixture. The string is the ground-truth literal.
export const ITEM_TAG = "gamma-item";

export function itemById(items, id) {
  for (const item of items) {
    if (item.id === id) return item;
  }
  return null;
}
