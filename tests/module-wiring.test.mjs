import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

function exportedSymbols(source) {
 const symbols = new Set();
 for (const match of source.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/g)) symbols.add(match[1]);
 for (const match of source.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
  for (const entry of match[1].split(',')) {
   const parts = entry.trim().split(/\s+as\s+/);
   if (parts[0]) symbols.add((parts[1] || parts[0]).trim());
  }
 }
 return symbols;
}

function siblingImports(source) {
 const imports = new Map();
 const pattern = /\bimport\s+(?!\()([^;]+?)\s+from\s+['"](\.\/[^'"]+\.mjs)['"];?/gs;
 for (const match of source.matchAll(pattern)) {
  const [, clause, specifier] = match;
  const names = new Set();
  const named = clause.match(/\{([^}]+)\}/);
  if (named) {
   for (const entry of named[1].split(',')) {
    const parts = entry.trim().split(/\s+as\s+/);
    if (parts[0]) names.add(parts[0].trim());
   }
  }
  const defaultImport = clause.match(/^\s*([\w$]+)(?:\s*,|\s*$)/);
  if (defaultImport && !clause.trimStart().startsWith('{') && !clause.trimStart().startsWith('*')) names.add('default');
  if (/\*/.test(clause)) names.add('*');
  imports.set(specifier, names);
 }
 return imports;
}

const modulesPromise = (async () => {
 const filenames = (await readdir(dist)).filter(name => name.endsWith('.mjs')).sort();
 return new Map(await Promise.all(filenames.map(async filename => [filename, await readFile(path.join(dist, filename), 'utf8')])));
})();

test('dist modules import every sibling export they call', async () => {
 const modules = await modulesPromise;
 const exportsByModule = new Map([...modules].map(([filename, source]) => [filename, exportedSymbols(source)]));

 for (const [filename, source] of modules) {
  const imports = siblingImports(source);
  for (const [sibling, symbols] of exportsByModule) {
   if (sibling === filename) continue;
   const specifier = `./${sibling}`;
   const imported = imports.get(specifier) || new Set();
   for (const symbol of symbols) {
    if (imported.has(symbol) || imported.has('*')) continue;
    const call = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\(`);
    if (call.test(source)) {
     assert.fail(`${filename} calls ${symbol}() from ${sibling} without importing it`);
    }
   }
  }
 }
});

test('app imports parsedHasGlyph from font-coverage', async () => {
 const modules = await modulesPromise;
 const appImports = siblingImports(modules.get('app.mjs'));
 const appFontCoverageImports = appImports.get('./font-coverage.mjs') || new Set();
 assert.ok(appFontCoverageImports.has('parsedHasGlyph'), 'app.mjs calls parsedHasGlyph() from font-coverage.mjs without importing it');
});
