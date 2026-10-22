# REE accuracy bench

These fixtures are source-owned. They are not third-party programs. `experiments/ree-bench/ground-truth.json` lists modules, functions, imports, calls, endpoints, strings, and behaviors read from the fixture source and public pages. `node ree.mjs bench` runs REE on each fixture and scores precision and recall against that file. Thresholds live in `thresholds.json`.

The native case compiles `native/fixture.c` with `gcc -nostdlib -static -O0 -Wl,-e,entry` and inspects the ELF. It needs `REA_PWNTOOLS_PYTHON` pointing at a Python with pwntools 4.15.0, pyelftools 0.33, and Unicorn 2.1.2. REE does not install those packages. The archive case packs `js-app` into an ASAR at run time.

A false claim fails the run even when recall for that type is not gated. Recall is not gated for JavaScript call edges or behavioral postconditions, or for native rodata strings. On these fixtures the semantic graph records call sites and does not emit `calls` relations, and `inspect-binary-layout` has no string-literal field. `statistics.modules` counts bundler registrations. The bench reads source-module graph nodes instead.
