import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Checkout root for the REE product layer. */
export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/** True when candidate is base or a path lexically inside it. */
export const pathInside = (base, candidate) => {
  const offset = relative(resolve(base), resolve(candidate));
  return (
    offset === "" ||
    (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  );
};
