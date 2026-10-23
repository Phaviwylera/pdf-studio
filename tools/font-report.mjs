#!/usr/bin/env node
// Report the fonts of a PDF and show which page owns each embedded program.
//
//   node tools/font-report.mjs statement.pdf
//   node tools/font-report.mjs statement.pdf --page 4
//   node tools/font-report.mjs statement.pdf --json
//
// This is the command-line form of the in-app Fonts dialog: page 1 (or the
// earliest page that embeds a program) is the donor for every later page that
// uses the same typeface without its own program.

import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {
 buildDocumentFontInventory, formatFontInventory, summarizeFontInventory, reuseTable,
} from '../dist/font-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const L = require(path.join(root, 'dist/vendor/pdf-lib.min.js'));

function usage(status = 1) {
 const text = 'Usage: node tools/font-report.mjs <file.pdf> [--page N] [--json]';
 (status ? console.error : console.log)(text);
 process.exit(status);
}

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) usage(args.length ? 0 : 1);

let file = null, page = null, json = false;
for (let i = 0; i < args.length; i++) {
 const arg = args[i];
 if (arg === '--json') json = true;
 else if (arg === '--page') {
  page = Number(args[++i]);
  if (!Number.isInteger(page) || page < 1) {
   console.error('--page needs a positive page number.');
   process.exit(1);
  }
 } else if (arg.startsWith('-')) {
  console.error(`Unknown option: ${arg}`);
  usage();
 } else file = arg;
}
if (!file) usage();

let bytes;
try {
 bytes = new Uint8Array(await readFile(file));
} catch (error) {
 console.error(`Could not read ${file}: ${error.message}`);
 process.exit(1);
}

let inventory;
try {
 inventory = await buildDocumentFontInventory(bytes, L);
} catch (error) {
 console.error(`Could not inspect ${file}: ${error.message}`);
 process.exit(1);
}

if (page && page > inventory.pageCount) {
 console.error(`${file} has ${inventory.pageCount} page(s); --page ${page} is out of range.`);
 process.exit(1);
}

if (json) {
 console.log(JSON.stringify({file: path.basename(file), ...summarizeFontInventory(inventory)}, null, 2));
} else {
 console.log(`${file} — ${inventory.pageCount} page${inventory.pageCount === 1 ? '' : 's'}`);
 console.log(formatFontInventory(inventory, {page: page ?? 1}));
 const reused = reuseTable(inventory).filter(row => row.donorPage && row.reusedOn.length);
 if (reused.length) {
  console.log('');
  for (const row of reused) {
   console.log(`Reuse: ${row.label} program from page ${row.donorPage} → page${row.reusedOn.length === 1 ? '' : 's'} ${row.reusedOn.join(', ')}`);
  }
 }
}
