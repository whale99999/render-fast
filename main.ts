// Harness driver for render-fast.
//
// Reads the case set from the input directory, renders every case on its
// own with parse() (no state is carried between cases), and writes the
// resulting HTML strings, in order, as a JSON array to the output
// directory. Directory locations come from the MAKEFUN_INPUT_DIR /
// MAKEFUN_OUTPUT_DIR environment variables, defaulting to /input and
// /output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

function dirFromEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

// Render every case independently and collect the HTML strings in input
// order. parse() keeps no state between calls, so each case is rendered
// exactly as if it were the only one.
function renderAll(cases: Case[]): string[] {
  const html: string[] = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    html[i] = parse(cases[i].markdown);
  }
  return html;
}

function main(): void {
  const inputDir = dirFromEnv('MAKEFUN_INPUT_DIR', '/input');
  const outputDir = dirFromEnv('MAKEFUN_OUTPUT_DIR', '/output');
  const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const cases = JSON.parse(raw) as Case[];
  const html = renderAll(cases);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();
