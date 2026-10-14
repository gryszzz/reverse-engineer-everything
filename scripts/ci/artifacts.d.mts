import type { NormalizedWorkflowRun } from "./workflow-run.mjs";
import type { StaticTaskContext } from "./static-task-context.mjs";
export type { StaticTaskContext } from "./static-task-context.mjs";

export interface StaticDiagnostic {
  readonly kind: "lint" | "jscpd";
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly code?: string;
  readonly message?: string;
  readonly severity?: string;
}

export function classifyFailure(input: {
  repository: string;
  defaultBranch: string;
  run: Record<string, unknown> & NormalizedWorkflowRun;
  job: Record<string, unknown>;
  diagnostics: readonly StaticDiagnostic[];
  context: StaticTaskContext;
  mainRun: Record<string, unknown> & NormalizedWorkflowRun;
  mainJob: Record<string, unknown>;
  mainDiagnostics: readonly StaticDiagnostic[];
  mainContext: StaticTaskContext;
  executionSourcesVerified: boolean;
  ancestry: { status: string; mergeBaseSha: string | null };
  blobs: Readonly<Record<string, boolean>>;
}): {
  classification: "matching-main-diagnostics" | "unknown";
  reason: string;
};

export function diagnosticPaths(item: StaticDiagnostic): readonly string[];
export function isFailedConclusion(
  value: unknown,
): value is "failure" | "timed_out";
export function isEligibleMainRun(
  run: Record<string, unknown>,
  defaultBranch: string,
  repository: string,
): boolean;
export function pullRequestBaseSha(
  run: Record<string, unknown>,
  repository: string,
): string | null;
export function safeSha(value: unknown): string | null;
export function validRepoPath(value: unknown): value is string;
export function selectStaticCheckArtifact(
  page: unknown,
  run: { id?: string | number; head_sha?: string },
  runAttempt: number,
): unknown | null;

export function readStaticCheckArtifact(options: {
  repository: string;
  artifactId: number | string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  context: StaticTaskContext;
  diagnostics: readonly StaticDiagnostic[];
}>;

export function parseStaticArchive(archivePath: string): Promise<{
  context: StaticTaskContext;
  diagnostics: readonly StaticDiagnostic[];
}>;
