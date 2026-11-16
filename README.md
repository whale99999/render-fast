# render-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/whale99999/render-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/whale99999/render-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

## What this is

A from-scratch Markdown renderer that behaves exactly like marked 18.1.3
with its default options (GitHub-flavoured Markdown on, line breaks off,
pedantic mode off) while using less CPU time. For every input string,
`parse(markdown)` returns the same HTML — byte for byte — that
`marked.parse(markdown)` would return: same whitespace, same entity
handling, same attribute order, including the places where marked departs
from the CommonMark and GFM specifications.

The renderer has no dependencies. `parse.js` is a plain ES module and
`main.ts` uses only Node.js built-ins.

## How it works

Rendering happens in three stages, all inside `parse.js`:

1. **Block pass.** The source is walked once, left to right. At each
   position the first character decides which block constructs are even
   possible (a `#` can start a heading, a `` ` `` or `~` a fence, `>` a
   blockquote, and so on), so the scanner never probes constructs that
   cannot match. The pass produces a token tree and collects every link
   reference definition it passes.
2. **Inline pass.** Each leaf block's text is scanned once. Before
   scanning, a masked copy of the text is built — same length, but with
   code spans and resolvable link labels neutralised — so the emphasis
   and strikethrough scanners never pair a delimiter inside a code span
   or link label with one outside it. Emphasis matching follows the
   reference's delimiter-run rules (including the rule of three and the
   underscore intraword restrictions).
3. **Emission.** The token tree is walked and HTML is appended to a
   single output string. Nothing is cached between `parse()` calls;
   every call starts from fresh state.

`main.ts` is the harness driver. It reads the case set (a JSON array of
`{"id", "markdown"}` objects) from `cases.json` in the input directory,
renders each case independently with `parse()`, and writes the HTML
strings, in order, as a JSON array to `html.json` in the output
directory.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

The two environment variables default to `/input` and `/output` when
unset. Node 22 runs `main.ts` directly through its native TypeScript
type stripping.

---

<sub>Entered on [make.fun](https://make.fun/?ref=881py9z1&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
