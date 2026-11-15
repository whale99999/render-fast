// Entry point for the render-fast submission.
//
// What the harness hands us: a directory (MAKEFUN_INPUT_DIR, or /input
// by default) containing cases.json — an array of { id, markdown }
// objects. What it expects back: html.json in the output directory
// (MAKEFUN_OUTPUT_DIR, or /output), a JSON array holding the rendered
// HTML for each case in the original order.
//
// Every case is rendered by a separate parse() call, exactly as if it
// were the only document in the world: nothing is carried over from
// one case to the next.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

interface InputCase {
  id: string;
  markdown: string;
}

function envDir(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

const casesPath = join(envDir("MAKEFUN_INPUT_DIR", "/input"), "cases.json");
const outPath = join(envDir("MAKEFUN_OUTPUT_DIR", "/output"), "html.json");

const inputCases = JSON.parse(readFileSync(casesPath, "utf8")) as InputCase[];

const html: string[] = [];
for (const inputCase of inputCases) {
  html.push(parse(inputCase.markdown));
}

writeFileSync(outPath, JSON.stringify(html));
