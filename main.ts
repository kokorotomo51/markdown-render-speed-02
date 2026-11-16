// Driver for the markdown-render-speed-02 entry: reads every case from the
// input directory, renders each one with parse() from parse.js, and writes
// the HTML strings in order to the output directory as html.json.
// Runs as `node main.ts` on Node 22 (type stripping; erasable syntax only).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Array<{ id: string; markdown: string }>;
const out: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) out[i] = parse(cases[i].markdown);
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
