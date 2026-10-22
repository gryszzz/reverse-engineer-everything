export class Catalog {
  itemById(items, id) {
    for (const item of items) {
      if (item.id === id) return item;
    }
    return null;
  }

  lookup(items, id) {
    return this.itemById(items, id);
  }
}

export function run(items, id) {
  const catalog = new Catalog();
  return catalog.itemById(items, id);
}
