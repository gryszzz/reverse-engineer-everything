# Pipeline contracts

`/home/box/shared/ree-pipeline/contracts.md` was not on this machine and was not in the repository. This file is the contract the `pipeline` command implements. It does not describe a live Guard, Blast, Scale, or Vault API. Those names are files a person can send later.

## Command

```sh
node ree.mjs pipeline TARGET --out DIR [--name NAME] [--resume] [--authorized] [--json]
  [--approve-launch] [--approve-guard] [--approve-blast] [--approve-scale] [--approve-vault]
```

The studio button `Run owned web pipeline` posts `{ "fixture": "web", "product_name": "Board Desk" }`. The server resolves `experiments/ree-bench/web` itself. The button does not accept an arbitrary path.

## Stages

The stages run in this order. Each one writes `checkpoints/<stage>.json`. A failed stage writes `status: "failed"`, sets `stopped_at`, and does not run later stages. The process exits 1 and the stderr line is `pipeline stopped at <stage>. <why>`. Usage errors (missing `--out`, a target that is not a directory, an output directory that already has `run.json` without `--resume`) exit 2.

| Stage       | What is real                                                                                                                    | What stays a file                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| scope       | Classifies the target. An owned fixture has `request.json` and `manifest.json` and makes no network request.                    |                                                                                      |
| investigate | Owned fixture: outside-in reads the fixture. `--authorized` artifact: static JavaScript or ASAR analysis.                       | A non-JavaScript target stops with the analyzer's message. No findings are invented. |
| findings    | Outside-in: features and endpoints with citations. A feature with no citation is kept and marked.                               | Artifact evidence is linked. Product features are not invented from it.              |
| spec        | The clean-room spec is the outside-in behavior spec. No endpoints are added.                                                    | Static analysis is not a behavior spec. Rebuild does not invent features.            |
| rebuild     | HTTP routes whose feature names equal an endpoint summary or operation id.                                                      | Other features stay unimplemented. Original code is not read or copied.              |
| verify      | `npm test` route tests, plus `accuracy.json`.                                                                                   | `accuracy.json` is the endpoint-name rule. It is not `node ree.mjs bench`.           |
| package     | Checks README, PRICING.md, LICENSE, NOTICE, LANDING.md, and `product.tgz`. Customer copy must not contain the spec target name. |                                                                                      |
| guard       | Writes `guard/submission.json`.                                                                                                 | Guard is not called. `sign_off` stays `not-submitted`.                               |
| handoff     | Writes the Blast, Scale, and Vault files and ingests the spec onto a board.                                                     | Blast is not notified. Scale is not called. Vault is not copied.                     |

## Resume

`out/run.json` is `ree.pipeline.run.v1`. Starting again in that directory without `--resume` is an error. `--resume` keeps `run_id`, skips a stage whose checkpoint is `passed` and whose output files still exist, and retries the first stage that is not reusable. A passed stage with a missing output is run again. Changing `--approve-*` flags makes the guard and handoff stages run again. Earlier checkpoints stay as they were.

## Approval flags

`--approve-launch`, `--approve-guard`, `--approve-blast`, `--approve-scale`, and `--approve-vault` record that a person asked. They do not perform the sell action.

- `dry_run` stays true.
- `notified_blast` stays false.
- `notified_scale` stays false.
- Guard `sign_off` stays `not-submitted`. The note says Guard was not called.
- `approved_for_vault_copy` stays false. `approval_requested` may be true.
- `launch_approved` is true only when `--approve-launch` was passed. That is a record, not a launch.
- If `/home/box/shared` exists and `--approve-launch` was passed, the handoff directory is copied to `/home/box/shared/ree-to-blast/<build_id>/`. Blast is still not notified. On a machine without that directory, the files stay under `--out`.

## Schemas

Checkpoint `ree.pipeline.checkpoint.v1`: `run_id`, `stage`, `status` (`passed` or `failed`), `started_at`, `finished_at`, `message`, `outputs` (paths relative to the run directory), `provenance`.

Run `ree.pipeline.run.v1`: `run_id` (`run_` plus 16 hex characters), `target`, `product_name`, `dry_run`, `approvals`, `stages`, `stopped_at`, `finished`, `code`, `message`.

Findings `ree.pipeline.findings.v1`.

Accuracy `ree.pipeline.accuracy.v1`. `not_the_corpus_bench` is true. Precision and recall use the endpoint-name rule: empty expected and empty observed are null; empty observed and a non-empty expected set are precision 1 and recall 0. A pass that was not expected, or an expected route that did not pass, fails the verify stage.

Handoff files, under `handoff/<build_id>/`:

- `ree.blast.handoff.v1` in `handoff.json`
- `ree.guard.submission.v1` in `guard/submission.json` (also copied to `out/guard/submission.json`)
- `ree.scale.handoff.v1` in `scale/manifest.json`
- `ree.vault.manifest.v1` in `vault/manifest.json`

Scale's `approved` field mirrors `--approve-scale`. `notified_scale` stays false. `package` is `product.tgz`.

## Customer package

The product directory contains README, PRICING.md, LICENSE, NOTICE, LANDING.md, and `product.tgz`. NOTICE names REE and REA, copyright (c) 2026 morluto, and says original code was not viewed or copied. It does not name the target. LANDING.md names the new product, the routes that run, and the feature ids that were not built. It does not name the target and does not repeat spec quotes.
