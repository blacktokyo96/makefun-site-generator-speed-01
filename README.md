[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/blacktokyo96/makefun-site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/blacktokyo96/makefun-site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# Faster makefun-site 1.0.0

A faster drop-in for make.fun's own makefun-site 1.0.0: `solve.js` exports
`run(input)` and returns exactly the output tree `build(input)` returns for
every case — every path, every file's text, byte for byte, including
`build-report.txt`.

## How it is faster

The reference lexes Markdown into token objects, renders inline markup one
character at a time through `escapeHtml` per character, slugifies with
`normalize` + regex on every call, and walks template trees with string
`+=` and scope-chain objects. This implementation:

- Renders Markdown in a single pass over the body — no token objects, no
  per-character escaping. Inline markup is found by a native regex scan
  for the next special character; plain runs are copied as slices.
- Slugifies with an ASCII fast path plus a per-case cache (titles, tag
  names and heading texts repeat heavily); the Unicode path is the
  reference algorithm verbatim.
- Parses front matter by scanning lines in place, and renders Markdown
  from the same text without copying the body.
- Compiles each template once per case into a node tree and renders into
  a string array (one `join` per page), with scopes kept as a frame
  stack (push/pop, no scope object per iteration).
- Counts words with a charCode scan (no `/\S+/g` match array), resolves
  link schemes with a charCode scan (no regex), and computes each
  source's card once, shared by its page view and the lists.
- `main.ts` keeps the house driver's `--no-incremental-marking` and adds
  `--no-opt`: on this short, fresh-process workload the optimizing
  compiler costs more CPU than its faster code saves, so the entry runs
  under the baseline compiler.

No state is kept between `run()` calls: every cache is created fresh
inside `run()`, so each case is answered alone. No dependencies, no
WebAssembly, no native addons, no network.

## Verification

- Practice set: 3/3 cases identical to makefun-site 1.0.0 (official
  scorer).
- Differential testing: 300+ cases identical — 150 handcrafted edge
  cases (template parse errors, include cycles/depth, nested emphasis,
  every front-matter refusal, Unicode slugs, empty/missing inputs) and
  150 cases drawn from the kit's own generator with fresh seeds.
- Local cold-process CPU (this VM, median of interleaved runs):
  baseline ~1.35 s, this entry ~0.56 s for the 3 practice cases
  (~2.4x). Official timing is the grader's heat; local numbers are
  indicative only.

## Run it

Node.js 22, no dependencies, no network:

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<dir> node main.ts
```
