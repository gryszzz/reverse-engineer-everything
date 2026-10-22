import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { compareLab, factsFromEvidence } from "./diff.mjs";

const FILE_CAP = 500;
const TEXT_CAP = 32_000;

function listing(root) {
  const info = statSync(root);
  if (!info.isDirectory())
    return [relative(root, root) || root.split(sep).at(-1)];
  const files = [];
  const walk = (directory, depth) => {
    if (depth > 6 || files.length >= FILE_CAP) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) files.push(relative(root, full));
      if (files.length >= FILE_CAP) return;
    }
  };
  walk(root, 0);
  return files.sort();
}

function textOf(file) {
  const info = statSync(file);
  if (!info.isFile() || info.size > TEXT_CAP) return null;
  const data = readFileSync(file);
  if (data.includes(0)) return null;
  return data.toString("utf8");
}

export function diffArtifactPair({
  left,
  right,
  leftRecord = null,
  rightRecord = null,
}) {
  const leftFacts = factsFromEvidence(leftRecord);
  const rightFacts = factsFromEvidence(rightRecord);
  let filesLeft = null;
  let filesRight = null;
  try {
    filesLeft = listing(left.path);
    filesRight = listing(right.path);
  } catch {
    filesLeft = null;
    filesRight = null;
  }
  const leftText = textOf(left.path);
  const rightText = textOf(right.path);
  return compareLab(
    {
      label: left.label ?? left.path,
      evidence_id: leftFacts.evidence_id,
      files: filesLeft,
      evidence_files: leftFacts.evidence_files,
      functions: leftFacts.functions,
      dependencies: leftFacts.dependencies,
      strings: leftFacts.strings,
      text: leftText !== null && rightText !== null ? leftText : null,
    },
    {
      label: right.label ?? right.path,
      evidence_id: rightFacts.evidence_id,
      files: filesRight,
      evidence_files: rightFacts.evidence_files,
      functions: rightFacts.functions,
      dependencies: rightFacts.dependencies,
      strings: rightFacts.strings,
      text: leftText !== null && rightText !== null ? rightText : null,
    },
  );
}
