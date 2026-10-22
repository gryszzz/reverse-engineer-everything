import { ITEM_TAG } from "./catalog.ts";
import { filterByTag } from "./filter.ts";

export function run(items: { id: string }[]): { id: string }[] {
  return filterByTag(items, ITEM_TAG);
}
