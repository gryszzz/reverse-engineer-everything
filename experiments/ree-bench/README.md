# REE accuracy bench

These fixtures are source-owned. They are not third-party programs. `experiments/ree-bench/ground-truth.json` lists modules, functions, imports, calls, endpoints, strings, and behaviors read from the fixture source and public pages. `node ree.mjs bench` runs REE on each fixture and scores precision and recall against that file. Thresholds live in `thresholds.json`. A false claim fails the run. Recall for calls, static behaviors, and native string literals is gated on these fixtures.

Call keys are `callerPath:callerName->calleePath:calleeName` for a resolved `calls` edge. Behavior keys are `module:function kind detail` for a fact inferred from syntax, with confidence and a limitation. A behavior marked observed is a provenance failure. Native strings are NUL-terminated printable ASCII from file-backed `.rodata`, `.rodata.*`, and `.data`, with a file offset that includes the terminating NUL. The native cases compile `native/fixture.c` with `gcc -nostdlib -static -O0 -Wl,-e,entry`. `native-stripped` then runs `strip --strip-all`. Both need `REA_PWNTOOLS_PYTHON` pointing at a Python with pwntools 4.15.0, pyelftools 0.33, and Unicorn 2.1.2. REE does not install those packages. The archive case packs `js-app` into an ASAR at run time.

`statistics.modules` counts bundler registrations. The bench reads source-module graph nodes instead.

These recoveries stay out of the ground truth because the static facts do not establish them:

- A destructured dynamic import (`const { name } = await import(...)`), a re-export, a computed callee, `eval` / `Function`, or a method reached through a later assignment.
- Control-flow postconditions that are not a direct `return`, and any claim that a behavior ran.
- String bytes outside file-backed `.rodata` and `.data`, non-ASCII text, and literals past the 256-string / 256-byte / 1 MiB scan bound.
- Function names in a stripped symbol table. `native-stripped` expects no function findings.
- `node:fs` `readFile` and `readFileSync` are one `io readFile` fact. External `node:` modules are not resolved calls.
