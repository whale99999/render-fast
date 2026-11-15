// Driver for the render-fast entry.
//
// The harness drops a cases file at /input/cases.json holding an array of
// { id, markdown } records. Every record is rendered on its own through
// parse() — no state is shared between records — and the resulting HTML
// strings are written, in the same order, as a JSON array to
// /output/html.json. When run outside the harness the two directories can
// be overridden with MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

type CaseRecord = { id: string; markdown: string };

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const raw: string = readFileSync(join(inputDir, "cases.json"), "utf8");
const records: CaseRecord[] = JSON.parse(raw) as CaseRecord[];

const rendered: string[] = new Array<string>(records.length);
for (let k = 0; k < records.length; k++) {
  rendered[k] = parse(records[k].markdown);
}

writeFileSync(join(outputDir, "html.json"), JSON.stringify(rendered));
