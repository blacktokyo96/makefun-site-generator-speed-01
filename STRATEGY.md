# Strategy

Goal: beat makefun-site 1.0.0 on CPU time in the final heat while
returning byte-identical output on every case.

## What the reference spends its time on

Profiled on the practice set (3 cases, 250–480 sources each): Markdown
rendering is ~55% of `run()` (lex tokens + per-character `escapeHtml` +
recursive `inline` with `slice` copies), template rendering ~37%
(tree walk, string `+=`, scope-chain lookups, per-iteration scope
objects), everything else ~8%.

## Optimizations (all legitimate implementation improvements)

1. **Single-pass Markdown.** No lex tokens. Blocks are classified by
   scanning line bounds in place; inline markup is located by a native
   regex scan for the next special character, plain runs are copied as
   slices, and nested markup recurses on ranges, never on copies.
2. **Fast slugify.** ASCII fast path (NFKD is the identity on ASCII)
   plus a per-case `Map` cache. The Unicode path is the reference
   algorithm verbatim, so NFKD/combining-mark behavior is identical.
3. **No repeated work.** Front matter is scanned without splitting the
   file; the body is rendered from the same text. Each source's card
   (words, excerpt, tags) is computed once and shared. `longDate` is
   cached per case.
4. **Template rendering.** One parse per template per case; rendering
   appends to a string array (one `join` per page); scopes are a frame
   stack with push/pop; loop frames are still allocated per iteration
   (required: includes can re-enter the same loop).
5. **V8 flags.** `main.ts` keeps `--no-incremental-marking` and adds
   `--no-opt`. Measured cold, interleaved against the house baseline:
   `--no-opt` alone is worth ~1.6x on this workload, because a fresh
   process per timed run pays TurboFan's compile time on every run while
   the run itself is short.

## Correctness discipline

Every optimization was kept only after differential testing against
makefun-site 1.0.0: the 3 practice cases, 150 handcrafted edge cases
and 150 generator-drawn cases with fresh seeds — all identical. One
real bug was caught this way (`\>` must write `&gt;`, because `>` is
both escapable and in the escape table) and fixed.

## Risks for the final heat

- The scored set is drawn from a new drand round, but by the same
  generator, so the workload shape (sources, templates, markup mix)
  matches the practice set.
- Cold-process timing dominates: the entry is tuned for fresh-process
  CPU, not steady-state throughput.
- Native-addon entries may take the top places; this entry competes
  as pure JavaScript within the stated runtime rules.
