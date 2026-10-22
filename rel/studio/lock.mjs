const tails = new Map();

/** Serialize project-file updates for one studio data directory. */
export function withStudioLock(key, fn) {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  tails.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
