import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/** Rows written by a generated product's SQLite store. */
export function savedRecords(dataDir) {
  const db = new DatabaseSync(join(dataDir, "data", "store.sqlite"));
  try {
    return db
      .prepare("SELECT body FROM records")
      .all()
      .map((row) => JSON.parse(row.body));
  } finally {
    db.close();
  }
}
