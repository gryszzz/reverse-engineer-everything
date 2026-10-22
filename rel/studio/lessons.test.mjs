import assert from "node:assert/strict";
import { test } from "node:test";
import { lessonCatalog, renderLesson } from "./lessons.mjs";

test("the catalog names four owned-fixture lessons and does not run tools", () => {
  const lessons = lessonCatalog();
  assert.deepEqual(
    lessons.map((lesson) => lesson.title),
    [
      "Your first binary",
      "How Electron apps are built",
      "Reading disassembly",
      "Comparing versions",
    ],
  );
  assert.equal(
    lessons.some((lesson) =>
      lesson.steps.some((step) => step.observation !== undefined),
    ),
    false,
  );
});

test("the first binary lesson reads tiny.c and does not execute the ELF", async () => {
  const lesson = await renderLesson("first-binary");
  assert.equal(lesson.behavior, "unknown");
  assert.match(lesson.steps[0].observation.text, /not executed/);
  assert.match(lesson.steps[1].observation.text, /return 0/);
  const headers = lesson.steps[2].observation;
  if (headers.status === "shown") {
    assert.equal(headers.evidence, null);
    assert.doesNotMatch(headers.text, /Evidence/);
  } else {
    assert.match(headers.reason, /objdump/);
  }
});

test("the Electron lesson quotes rank from the owned search file", async () => {
  const lesson = await renderLesson("electron-apps");
  const rank = lesson.steps.find((step) => step.id === "rank");
  assert.match(rank.observation.text, /function rank/);
  assert.equal(rank.observation.evidence, null);
  const pending = lesson.steps.find((step) => step.id === "analyze");
  assert.match(pending.hint, /unknown/);
});

test("disassembly is objdump stdout or an explicit unavailable step", async () => {
  const lesson = await renderLesson("disassembly");
  const step = lesson.steps[0].observation;
  if (step.status === "shown") {
    assert.equal(step.tool, "objdump");
    assert.equal(step.evidence, null);
    assert.match(step.text, /<.*>:/);
  } else {
    assert.equal(step.status, "unavailable");
    assert.match(step.reason, /objdump/);
    assert.equal(step.text, undefined);
  }
});

test("version comparison is a source diff and leaves behavior unknown", async () => {
  const lesson = await renderLesson("compare-versions");
  const diff = lesson.steps[0].observation;
  assert.equal(diff.status, "shown");
  assert.match(diff.text, /floor/);
  assert.match(diff.note, /Behavior is unknown/);
  assert.equal(lesson.behavior, "unknown");
});

test("an unknown lesson id renders nothing", async () => {
  assert.equal(await renderLesson("made-up"), null);
});
