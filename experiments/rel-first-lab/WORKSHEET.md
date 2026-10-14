# REE investigation worksheet

Copy this template for each exercise. Never turn a prediction into an observation.

**Question:** Why does searching "bridge" produce this ordering?

**Scope:** experiments/rel-first-lab/ only.

| Claim                                         | Type of evidence           | Check                                  | Status               |
| --------------------------------------------- | -------------------------- | -------------------------------------- | -------------------- |
| Bridge Patterns is listed first               | Runtime observation        | Run cli.mjs bridge                     | Check locally        |
| Title-prefix outranks title-substring matches | Source-derived explanation | Read search.mjs                        | Check source         |
| Tag-only matches are included                 | Source and test            | Read search.mjs, run verify.mjs        | Check locally        |
| REA's graph mapped the imports correctly      | Analyzer evidence          | Run local REA and inspect the Evidence | **Not verified yet** |

## Findings

- **Exact command:**
- **Output I observed:**
- **Code or Evidence supporting the explanation:**
- **What I inferred but did not observe:**
- **Unknowns and coverage limits:**
- **A test that could disprove the explanation:**
- **Result of that test:**

## Efficiency (optional)

| Measurement                           | Value              |
| ------------------------------------- | ------------------ |
| Cold/warm runtime                     |                    |
| Evidence output size                  |                    |
| Extra commands required               |                    |
| Did the evidence answer the question? | Yes / No / Partial |

A completed command does not prove that every conclusion is correct. Preserve the source and state of each finding.
