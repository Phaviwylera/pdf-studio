#!/usr/bin/env node
// Statement layout report.
//
// Describes how a statement is laid out — column positions, row structure, the
// shape of its numbers — without printing the numbers themselves. Run it on a
// statement locally and paste the output when a column layout needs support.
//
//   node tools/statement-layout.mjs statement.pdf
//   node tools/statement-layout.mjs statement.pdf --json --rows 5
//   node tools/statement-layout.mjs statement.pdf --reveal     (full text)
//
// Password-protected PDFs cannot be read here: save an unencrypted copy first
// (the editor can open the protected file with its password and export a plain
// copy without changing anything).

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');

// pdf.js is browser-first; these three shims are all it needs for text.
if (typeof globalThis.DOMMatrix === 'undefined') {
 globalThis.DOMMatrix = class DOMMatrix {
  constructor() { Object.assign(this, {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}); }
  multiply() { return this; }
  translate() { return this; }
  scale() { return this; }
  invertSelf() { return this; }
 };
}
if (!Promise.try) Promise.try = (fn, ...args) => new Promise(resolve => resolve(fn(...args)));
if (!Uint8Array.prototype.toHex) {
 Object.defineProperty(Uint8Array.prototype, 'toHex', {
  value() { return Array.from(this, byte => byte.toString(16).padStart(2, '0')).join(''); },
 });
}

const MASK = '#';

/** Mask the identifying parts of a string but keep its shape. */
export function maskText(text, {reveal = false} = {}) {
 if (reveal) return text;
 return String(text ?? '')
  .replace(/\d/g, MASK)
  .replace(/[A-Za-z]{5,}/g, word => `${word.slice(0, 3)}…`)
  .replace(/\s+/g, ' ')
  .trim();
}

// A whole cell is a number, not just a cell that ends in digits.
const NUMBER = /^(?:[A-Z]{2,3}\s*|\u20b9|\$|€|£)?\(?-?\d[\d,]*(?:\.\d{1,3})?\s*(?:Dr|Cr)?\)?$/i;

/** The shape of a number cell, with every digit replaced. */
export function amountShape(text) {
 const value = String(text ?? '').trim();
 if (!NUMBER.test(value)) return null;
 return value.replace(/\d/g, MASK);
}

function rowsOf(items, tolerance = 2.5) {
 const rows = [];
 for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
  const row = rows.find(candidate => Math.abs(candidate.y - item.y) <= tolerance);
  if (row) row.items.push(item);
  else rows.push({y: item.y, items: [item]});
 }
 for (const row of rows) row.items.sort((a, b) => a.x - b.x);
 return rows.sort((a, b) => b.y - a.y);
}

/** Group the x positions of one page into column bands. */
export function columnsOf(items, tolerance = 8) {
 const numeric = items.filter(item => NUMBER.test(item.text.trim()));
 const sorted = [...numeric].sort((a, b) => a.x - b.x);
 const bands = [];
 for (const item of sorted) {
  const band = bands[bands.length - 1];
  if (band && item.x - band.max <= tolerance) {
   band.max = Math.max(band.max, item.x);
   band.items.push(item);
  } else bands.push({min: item.x, max: item.x, items: [item]});
 }
 return bands.map((band, index) => ({
  index: index + 1,
  from: Math.round(band.min),
  to: Math.round(band.max),
  cells: band.items.length,
  shapes: [...new Set(band.items.map(item => amountShape(item.text)).filter(Boolean))].slice(0, 4),
  alignedRight: band.items.length > 1 && new Set(band.items.map(item => Math.round(item.x))).size <= Math.max(2, band.items.length / 4),
 }));
}

async function extractPages(file) {
 const bytes = new Uint8Array(await readFile(file));
 let document;
 try {
  document = await L.PDFDocument.load(bytes, {updateMetadata: false, ignoreEncryption: false});
 } catch (error) {
  if (/encrypt/i.test(error?.message || '')) {
   throw new Error('This PDF is password protected. Save an unencrypted copy (the editor can open it with the password) and run the report again.');
  }
  throw new Error(`This PDF could not be read: ${error?.message || 'unknown error'}`);
 }
 const pdfjs = await import('../dist/vendor/pdf.mjs');
 const task = pdfjs.getDocument({data: bytes.slice(), useSystemFonts: false, isEvalSupported: false, verbosity: 0});
 const pdf = await task.promise;
 const pages = [];
 for (let n = 1; n <= pdf.numPages; n++) {
  const page = await pdf.getPage(n);
  const {width, height} = page.getViewport({scale: 1});
  const content = await page.getTextContent();
  const items = content.items
   .filter(item => typeof item.str === 'string' && item.str.trim())
   .map(item => ({
    text: item.str,
    x: Math.round(item.transform[4] * 10) / 10,
    y: Math.round(item.transform[5] * 10) / 10,
    width: Math.round((item.width || 0) * 10) / 10,
   }));
  pages.push({page: n, width: Math.round(width), height: Math.round(height), items});
 }
 await task.destroy();
 return {pages, pageCount: document.getPageCount()};
}

export function layoutReport({pages, pageCount}, {reveal = false, rows = 3} = {}) {
 const lines = [`${pageCount} page${pageCount === 1 ? '' : 's'}`];
 let totalRows = 0, numericRows = 0;
 for (const page of pages) {
  const grouped = rowsOf(page.items);
  const columns = columnsOf(page.items);
  const withNumbers = grouped.filter(row => row.items.some(item => NUMBER.test(item.text.trim())));
  totalRows += grouped.length;
  numericRows += withNumbers.length;
  lines.push('', `Page ${page.page} · ${page.width}×${page.height} pt · ${page.items.length} text runs · ${grouped.length} rows (${withNumbers.length} with numbers)`);
  lines.push(`  numeric columns: ${columns.length ? columns.map(column => `x ${column.from}–${column.to} (${column.shapes.join(' | ') || 'shape unknown'})`).join(', ') : 'none'}`);
  if (columns.length >= 2) {
   lines.push(`  balance column: x ${columns[columns.length - 1].from}–${columns[columns.length - 1].to} · amount column: x ${columns[columns.length - 2].from}–${columns[columns.length - 2].to}`);
   if (columns.length > 2) lines.push(`  ${columns.length} numeric columns — a separate credit/debit pair is not supported yet`);
  }
  const samples = grouped.slice(0, rows * 3).filter(row => row.items.length);
  for (const row of samples.slice(0, rows * 3)) {
   const cells = row.items.map(item => `[x${Math.round(item.x)}] ${maskText(item.text, {reveal})}`).join('  ');
   lines.push(`  y ${Math.round(row.y)}: ${cells}`);
  }
 }
 lines.push('', `Rows found: ${totalRows}; rows carrying numbers: ${numericRows}.`);
 lines.push('Digits are masked by default. Use --reveal to print the text as it is.');
 return lines.join('\n');
}

async function main(argv) {
 const file = argv.find(argument => !argument.startsWith('--'));
 if (!file) {
  console.error('Usage: node tools/statement-layout.mjs <statement.pdf> [--json] [--reveal] [--rows N]');
  process.exitCode = 2;
  return;
 }
 const reveal = argv.includes('--reveal');
 const json = argv.includes('--json');
 const rowIndex = argv.indexOf('--rows');
 const rows = rowIndex >= 0 ? Math.max(1, Number(argv[rowIndex + 1]) || 3) : 3;
 const extracted = await extractPages(path.resolve(file));
 const report = json
  ? {
   file: path.basename(file),
   pageCount: extracted.pageCount,
   pages: extracted.pages.map(page => ({
    page: page.page, width: page.width, height: page.height,
    rows: rowsOf(page.items).length,
    columns: columnsOf(page.items),
    samples: rowsOf(page.items).slice(0, rows).map(row => row.items.map(item => ({x: item.x, y: item.y, text: maskText(item.text, {reveal})}))),
   })),
  }
  : layoutReport(extracted, {reveal, rows});
 console.log(typeof report === 'string' ? report : JSON.stringify(report, null, 2));
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invoked) {
 main(process.argv.slice(2)).catch(error => {
  console.error(error.message || String(error));
  process.exitCode = 1;
 });
}
