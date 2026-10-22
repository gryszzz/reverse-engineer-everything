import { formatBench, runBench } from "./run.mjs";

export async function runBenchCommand(argv) {
  let json = false;
  let only = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--case") {
      only = argv[++index];
      if (!only) throw new Error("--case requires an id.");
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "node ree.mjs bench [--json] [--case ID]\nScores owned fixtures. Ground truth is experiments/ree-bench/ground-truth.json.",
      );
      return 0;
    } else throw new Error(`Unknown bench option: ${arg}`);
  }
  const result = await runBench({ only });
  console.log(json ? JSON.stringify(result, null, 2) : formatBench(result));
  return result.passed ? 0 : 1;
}
