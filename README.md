# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/1touhou/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/1touhou/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's makefun-site 1.0.0: it returns exactly makefun-site's answer (the output tree — every page, index, tag page, `build-report.txt` and static file, byte for byte) for every input `{ site, templates, files }`, while building the site with index-driven scans instead of the reference's token graphs and per-line regexes.

## How it is faster

- Front matter is read with a line scanner and hand-rolled value checks, not a regex per line.
- Markdown is lexed by a first-character dispatch (fence, heading, break, quote, list or paragraph) and rendered inline by a native scan that jumps from one markup character to the next, moving the plain text between them in whole slices.
- Templates are parsed once per case into node trees and rendered with a scope chain of prototype-linked objects, so a variable costs one property read; slugs, long dates and word counts are cached or table-driven, and each post's card is computed once and reused by its page.
- No per-character allocations: no token objects, no per-line regexes in the hot paths, no repeated `wordsOf` regex matches.

On the kit's practice set (3 cases, 257–486 sources each) `run()` takes ~150 ms against makefun-site 1.0.0's ~470 ms on this machine (interleaved rounds, same process), and the whole entry runs end to end in ~0.3 s against the baseline's ~0.9 s. Exact match verified on all 3 practice cases and on 30 further cases drawn from fresh seeds with the kit's own generator.

## Run it

```sh
node main.ts
```

It reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`) and writes `/output/answers.json`: one answer per case, in the cases' order. Dependency-free, JavaScript/TypeScript only, deterministic — two runs write identical bytes.

---

<sub>Entered on [make.fun](https://make.fun/?ref=3bes5xfn&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
