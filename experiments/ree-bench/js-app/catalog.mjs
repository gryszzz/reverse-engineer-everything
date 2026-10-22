// Owned accuracy fixture. No network, accounts, or third-party code.
export const ITEM_TAG = "alpha-item";

export function itemById(items, id) {
  for (const item of items) {
    if (item.id === id) return item;
  }
  return null;
}
