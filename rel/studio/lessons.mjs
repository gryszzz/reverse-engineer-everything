import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const lessonRoot = fileURLToPath(new URL("../../", import.meta.url));

const OWNED = {
  elf: "experiments/ree-fixtures/tiny-linux-x64.elf",
  source: "experiments/ree-fixtures/tiny.c",
  lab: "experiments/rel-first-lab",
  search: "experiments/rel-first-lab/search.mjs",
  cli: "experiments/rel-first-lab/cli.mjs",
  authority: "experiments/ree-investigation-boundary/authority.c",
  candidate: "experiments/ree-investigation-boundary/candidate.c",
};

const LESSONS = [
  {
    id: "first-binary",
    title: "Your first binary",
    fixture: OWNED.elf,
    summary:
      "Read the owned ELF and the C file beside it. The lesson does not execute the binary.",
    steps: [
      {
        id: "locate",
        title: "Find the owned ELF",
        hint: "This file is in the checkout. Adding it on the front door classifies it. Classification does not run it.",
        action: { type: "stat", path: OWNED.elf },
      },
      {
        id: "source",
        title: "Read the C file that built it",
        hint: "tiny.c is the owned source. The ELF is a separate file. Matching them is not proof of how the ELF was built unless you rebuild it.",
        action: { type: "read", path: OWNED.source },
      },
      {
        id: "headers",
        title: "Ask objdump for headers",
        hint: "When objdump is on PATH, this is its stdout for file headers. It is not an Evidence record. The studio route inspect-with-objdump file_headers is the Evidence path.",
        action: { type: "objdump", path: OWNED.elf, args: ["-f"] },
      },
    ],
  },
  {
    id: "electron-apps",
    title: "How Electron apps are built",
    fixture: OWNED.lab,
    summary:
      "Walk the owned JavaScript lab. Import lines are source text until a static analysis records them.",
    steps: [
      {
        id: "files",
        title: "See the lab files",
        hint: "cli.mjs imports search.mjs. That is source text, not a runtime trace.",
        action: { type: "read", path: OWNED.cli },
      },
      {
        id: "rank",
        title: "Where search ranking starts",
        hint: "function rank is in search.mjs. The lesson quotes that owned file. It does not claim an Evidence id until you run the JavaScript route.",
        action: {
          type: "excerpt",
          path: OWNED.search,
          pattern: "function rank",
        },
      },
      {
        id: "analyze",
        title: "Record Evidence separately",
        hint: "Use the front door on experiments/rel-first-lab and the JavaScript route. Until that run finishes, module counts and edge ids are unknown.",
        action: { type: "note" },
      },
    ],
  },
  {
    id: "disassembly",
    title: "Reading disassembly",
    fixture: OWNED.elf,
    summary:
      "Show objdump -d for the owned ELF when the tool exists. Missing tools stay unavailable.",
    steps: [
      {
        id: "tool",
        title: "Disassemble the owned ELF",
        hint: "objdump -d reads the file. It does not execute it. If objdump is missing, this step stays unavailable instead of showing a sample listing.",
        action: { type: "objdump", path: OWNED.elf, args: ["-d"] },
      },
      {
        id: "read",
        title: "What the listing is",
        hint: "Addresses and mnemonics in that stdout are objdump’s text. They are not REA Evidence and they are not a decompilation.",
        action: { type: "note" },
      },
    ],
  },
  {
    id: "compare-versions",
    title: "Comparing versions",
    fixture: OWNED.authority,
    summary:
      "Compare two owned C files. The diff is source text. Behavior stays unknown.",
    steps: [
      {
        id: "diff",
        title: "Diff the authority and the candidate",
        hint: "authority.c multiplies. candidate.c rounds with floor. This lesson shows changed lines only. It does not score behavior.",
        action: {
          type: "diff",
          left: OWNED.authority,
          right: OWNED.candidate,
        },
      },
      {
        id: "behavior",
        title: "Leave behavior unknown",
        hint: "A source diff is not an execution. The owned native probe, when you approve it, reports claim statuses for a different harness. It does not turn this diff into a pass.",
        action: { type: "note" },
      },
    ],
  },
];

function insideRoot(root, target) {
  const base = realpathSync(root);
  const resolved = realpathSync(target);
  if (resolved !== base && !resolved.startsWith(base + sep))
    throw new Error("Lesson path left the checkout.");
  return resolved;
}

function ownedFile(root, relative) {
  if (!Object.values(OWNED).includes(relative))
    throw new Error("Lesson path is not in the owned catalog.");
  const full = join(root, relative);
  if (!existsSync(full)) return null;
  return insideRoot(root, full);
}

async function readText(file) {
  const data = await readFile(file);
  if (data.includes(0))
    return {
      status: "unavailable",
      reason: "The file contains NUL bytes, so it is not shown as text.",
      bytes: data.length,
    };
  const text = data.toString("utf8");
  return {
    status: "shown",
    text: text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text,
    bytes: data.length,
  };
}

function objdump(file, args) {
  const result = spawnSync("objdump", [...args, "--", file], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 200_000,
  });
  if (result.error) {
    const missing = result.error.code === "ENOENT";
    return {
      status: "unavailable",
      reason: missing
        ? "objdump was not found on PATH. No disassembly was invented."
        : `objdump did not run: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return {
      status: "unavailable",
      reason: `objdump exited ${result.status}. Stderr: ${(result.stderr || "").slice(0, 400)}`,
    };
  }
  const text = result.stdout || "";
  return {
    status: "shown",
    text: text.length > 8000 ? `${text.slice(0, 8000)}\n…` : text,
    tool: "objdump",
    evidence: null,
  };
}

function lineDiff(left, right) {
  const a = left.split("\n");
  const b = right.split("\n");
  const rows = a.length + 1;
  const cols = b.length + 1;
  const score = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      score[i][j] =
        a[i] === b[j]
          ? score[i + 1][j + 1] + 1
          : Math.max(score[i + 1][j], score[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length && out.length < 80) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (score[i + 1][j] >= score[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i += 1;
    } else {
      out.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length && out.length < 80) {
    out.push(`- ${a[i]}`);
    i += 1;
  }
  while (j < b.length && out.length < 80) {
    out.push(`+ ${b[j]}`);
    j += 1;
  }
  return out.join("\n");
}

async function observe(action, root) {
  if (action.type === "note") {
    return {
      status: "note",
      text: "No tool was run for this step.",
    };
  }
  if (action.type === "stat") {
    const file = ownedFile(root, action.path);
    if (!file)
      return {
        status: "unavailable",
        reason: `${action.path} is not in this checkout.`,
      };
    const info = statSync(file);
    return {
      status: "shown",
      text: `${action.path}\n${info.size} bytes\nnot executed`,
    };
  }
  if (action.type === "read" || action.type === "excerpt") {
    const file = ownedFile(root, action.path);
    if (!file)
      return {
        status: "unavailable",
        reason: `${action.path} is not in this checkout.`,
      };
    const loaded = await readText(file);
    if (loaded.status !== "shown" || action.type !== "excerpt") return loaded;
    const lines = loaded.text.split("\n");
    const start = lines.findIndex((line) => line.includes(action.pattern));
    if (start < 0)
      return {
        status: "unavailable",
        reason: `The pattern ${action.pattern} was not in ${action.path}.`,
      };
    return {
      status: "shown",
      text: lines.slice(start, start + 8).join("\n"),
      source: "owned-file",
      evidence: null,
    };
  }
  if (action.type === "objdump") {
    const file = ownedFile(root, action.path);
    if (!file)
      return {
        status: "unavailable",
        reason: `${action.path} is not in this checkout.`,
      };
    return objdump(file, action.args);
  }
  if (action.type === "diff") {
    const left = ownedFile(root, action.left);
    const right = ownedFile(root, action.right);
    if (!left || !right)
      return {
        status: "unavailable",
        reason: "One of the owned versions is missing.",
      };
    const leftText = await readText(left);
    const rightText = await readText(right);
    if (leftText.status !== "shown" || rightText.status !== "shown")
      return {
        status: "unavailable",
        reason: "A version was not readable as text, so no diff was invented.",
      };
    return {
      status: "shown",
      text: lineDiff(leftText.text, rightText.text),
      note: "Source line diff of two owned files. Behavior is unknown. This is not Evidence.",
    };
  }
  return { status: "unavailable", reason: "Unknown lesson action." };
}

export function lessonCatalog() {
  return LESSONS.map((lesson) => ({
    id: lesson.id,
    title: lesson.title,
    fixture: lesson.fixture,
    summary: lesson.summary,
    steps: lesson.steps.map((step) => ({
      id: step.id,
      title: step.title,
      hint: step.hint,
    })),
  }));
}

export async function renderLesson(id, root = lessonRoot) {
  const lesson = LESSONS.find((item) => item.id === id);
  if (!lesson) return null;
  const steps = [];
  for (const step of lesson.steps) {
    steps.push({
      id: step.id,
      title: step.title,
      hint: step.hint,
      observation: await observe(step.action, root),
    });
  }
  return {
    id: lesson.id,
    title: lesson.title,
    fixture: lesson.fixture,
    summary: lesson.summary,
    behavior: "unknown",
    steps,
  };
}
