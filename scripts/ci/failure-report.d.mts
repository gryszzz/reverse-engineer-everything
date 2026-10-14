import type { NormalizedWorkflowRun } from "./workflow-run.mjs";
import type { StaticDiagnostic } from "./artifacts.mjs";
export type { StaticDiagnostic } from "./artifacts.mjs";
import type { StaticTaskContext } from "./static-task-context.mjs";
export type { StaticTaskContext } from "./static-task-context.mjs";
export interface CiRun {
  readonly id?: string | number;
  readonly run_attempt?: number;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly event?: string;
  readonly path?: string;
  readonly head_sha?: string;
  readonly head_branch?: string;
  readonly repository?: { readonly full_name?: string };
  readonly pull_requests?: readonly {
    readonly base?: {
      readonly sha?: string;
      readonly repo?: { readonly full_name?: string };
    };
  }[];
}

export interface CiJob {
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly run_id?: number;
  readonly run_attempt?: number;
}

export interface StaticEvidence {
  readonly context: StaticTaskContext;
  readonly diagnostics: readonly StaticDiagnostic[];
}

export interface CiFailureReport {
  readonly version: 1;
  readonly observedAt: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly informationalOnly: true;
  readonly gateEffect: string;
  readonly boundedInput: {
    readonly candidateRuns: number;
    readonly limit: number;
    readonly mainCandidateLimit: number;
    readonly mainCandidateRuns: number;
    readonly mainRunLookupLimit: number;
    readonly manifestTruncated: boolean;
  };
  readonly counts: Readonly<
    Record<"matching-main-diagnostics" | "unknown", number>
  >;
  readonly failures: readonly {
    readonly runId: number | string;
    readonly runAttempt: number;
    readonly classification: "matching-main-diagnostics" | "unknown";
    readonly reason: string;
    readonly candidateFailures?: readonly {
      readonly runId: number | string;
      readonly runAttempt: number;
      readonly reason: string;
    }[];
    readonly runHead?: string | null;
    readonly event?: string | null;
    readonly job?: string;
    readonly conclusion?: string | null;
  }[];
}

export interface FailureReportApi {
  getRun(repository: string, id: string | number): Promise<CiRun>;
  getJobs(
    repository: string,
    id: string | number,
    attempt: number,
  ): Promise<readonly CiJob[]>;
  getStaticEvidence(
    repository: string,
    run: CiRun,
    job: CiJob,
  ): Promise<StaticEvidence | null>;
  getAncestry(
    repository: string,
    ancestor: string,
    descendant: string,
  ): Promise<{ status: string; mergeBaseSha: string | null }>;
  verifyExecutionSource(
    repository: string,
    run: CiRun,
    context: StaticTaskContext,
  ): Promise<boolean>;
  getBlobIdentity(
    repository: string,
    ancestor: string,
    descendant: string,
    paths: readonly string[],
  ): Promise<Readonly<Record<string, boolean>>>;
}

export function classifyFailure(input: {
  repository: string;
  defaultBranch: string;
  run: CiRun & NormalizedWorkflowRun;
  job: CiJob;
  diagnostics: readonly StaticDiagnostic[];
  context: StaticTaskContext;
  mainRun: CiRun & NormalizedWorkflowRun;
  mainJob: CiJob;
  mainDiagnostics: readonly StaticDiagnostic[];
  mainContext: StaticTaskContext;
  executionSourcesVerified: boolean;
  ancestry: { status: string; mergeBaseSha: string | null };
  blobs: Readonly<Record<string, boolean>>;
}): {
  classification: "matching-main-diagnostics" | "unknown";
  reason: string;
};

export function reportCiFailures(options: {
  repository: string;
  defaultBranch: string;
  batchManifest: {
    readonly repository: string;
    readonly runs: readonly {
      readonly id: number | string;
      readonly runAttempt: number;
      readonly workflow: string;
      readonly event?: string | null;
      readonly headBranch?: string | null;
      readonly conclusion: string | null;
      readonly status: string;
    }[];
    readonly truncation?: readonly unknown[];
    readonly coverage?: { readonly exhaustive?: boolean };
    readonly selection?: { readonly exhaustive?: boolean };
  };
  api: FailureReportApi;
  outputDirectory?: string;
  summaryPath?: string;
  observedAt?: string;
}): Promise<CiFailureReport>;

export function createGitHubApi(options?: {
  token?: string;
  fetchImpl?: typeof fetch;
  apiRequest?: (
    method: string,
    endpoint: string,
    budget: { requests: number; startedAt: number; limitMs: number },
  ) => Promise<unknown>;
}): FailureReportApi;

export function writeFailureReport(
  report: CiFailureReport,
  outputDirectory?: string,
  summaryPath?: string,
): Promise<{ jsonPath: string; markdownPath: string }>;
