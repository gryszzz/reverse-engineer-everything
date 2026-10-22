import { itemById } from "./catalog.mjs";

const find = itemById;

export function run(items, id) {
  return find(items, id);
}
