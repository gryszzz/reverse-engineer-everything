import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolve TypeScript fixture specifiers written as .js, the same way the test runner does. */
export async function resolve(specifier, context, nextResolve) {
  if (typeof specifier === "string" && specifier.endsWith(".js")) {
    const candidate = specifier.replace(/\.js$/u, ".ts");
    try {
      const resolved = await nextResolve(candidate, context);
      if (existsSync(fileURLToPath(resolved.url))) return resolved;
    } catch {
      // The .ts sibling is absent. Keep the original specifier.
    }
  }
  return nextResolve(specifier, context);
}
