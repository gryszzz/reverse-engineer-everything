import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { studioError } from "./errors.mjs";
import { pathInside, repositoryRoot } from "./paths.mjs";

const PROJECT_ID = /^prj_[a-f0-9]{32}$/u;
const text = (value) => (typeof value === "string" ? value : "");

export function newId(prefix, bytes = 8) {
  return prefix + randomBytes(bytes).toString("hex");
}

export function assertDataDir(dataDir) {
  if (typeof dataDir !== "string" || dataDir.trim() === "")
    throw studioError("Provide a studio data directory outside the checkout.");
  const resolved = resolve(dataDir);
  if (pathInside(repositoryRoot, resolved))
    throw studioError(
      "Studio data must live outside the REE checkout so analysis output is not written into the repository.",
    );
  return resolved;
}

function cleanName(name) {
  if (typeof name !== "string") throw studioError("Project name is required.");
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80)
    throw studioError("Project name must be 1–80 characters.");
  if (/[\u0000-\u001f]/u.test(trimmed))
    throw studioError("Project name cannot contain control characters.");
  return trimmed;
}

function cleanQuestion(question) {
  if (question === undefined || question === null || question === "")
    return null;
  if (typeof question !== "string" || question.length > 500)
    throw studioError("Question must be text of at most 500 characters.");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(question))
    throw studioError("Question cannot contain control characters.");
  return question;
}

function cleanMode(mode) {
  if (mode === undefined) return "simple";
  if (mode !== "simple" && mode !== "advanced")
    throw studioError("Mode must be simple or advanced.");
  return mode;
}

function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function readProjectFile(path) {
  const project = JSON.parse(readFileSync(path, "utf8"));
  if (project?.schema_version !== 1)
    throw studioError("Unsupported project schema.");
  return project;
}

export function createProjectStore(dataDir) {
  const root = assertDataDir(dataDir);
  const projectsDir = join(root, "projects");
  mkdirSync(projectsDir, { recursive: true });

  const projectPath = (id) => {
    if (!PROJECT_ID.test(id)) throw studioError("Unknown project.", 404);
    return join(projectsDir, id, "project.json");
  };

  const list = () => {
    const entries = readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .slice(0, 200);
    return entries.map((entry) => {
      const path = join(projectsDir, entry.name, "project.json");
      try {
        if (lstatSync(path).isSymbolicLink())
          return {
            id: entry.name,
            error: "Refusing to follow a project symlink.",
          };
        const project = readProjectFile(path);
        return {
          id: project.id,
          name: project.name,
          question: project.question,
          mode: project.mode,
          updated_at: project.updated_at,
          artifact_count: project.artifacts.length,
          run_count: project.runs.length,
        };
      } catch (error) {
        return {
          id: entry.name,
          error: error instanceof Error ? error.message : "Unreadable project.",
        };
      }
    });
  };

  const read = (id) => {
    const path = projectPath(id);
    if (!existsSync(path)) throw studioError("Unknown project.", 404);
    if (lstatSync(path).isSymbolicLink())
      throw studioError("Refusing to follow a project symlink.", 404);
    return readProjectFile(path);
  };

  const write = (project) => {
    const directory = join(projectsDir, project.id);
    mkdirSync(directory, { recursive: true });
    writeJson(join(directory, "project.json"), project);
    return project;
  };

  return {
    root,
    projectsDir,
    list,
    read,
    create(input) {
      const now = new Date().toISOString();
      const project = {
        schema_version: 1,
        id: newId("prj_", 16),
        name: cleanName(input.name),
        question: cleanQuestion(input.question),
        mode: cleanMode(input.mode),
        created_at: now,
        updated_at: now,
        artifacts: [],
        runs: [],
        experiments: [],
        research_sessions: [],
      };
      return write(project);
    },
    update(id, mutate) {
      const current = read(id);
      const next = mutate(structuredClone(current));
      if (next?.id !== id || next.schema_version !== 1)
        throw studioError("Project update lost its identity.");
      next.updated_at = new Date().toISOString();
      return write(next);
    },
    directory(id) {
      if (!PROJECT_ID.test(text(id)))
        throw studioError("Unknown project.", 404);
      return join(projectsDir, id);
    },
  };
}
