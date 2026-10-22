import { ITEM_TAG } from "./catalog.mjs";
import { filterByTag } from "./filter.mjs";

export function run(items) {
  return filterByTag(items, ITEM_TAG);
}
