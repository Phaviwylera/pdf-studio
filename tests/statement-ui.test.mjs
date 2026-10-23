import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = name => readFile(new URL(`../dist/${name}`, import.meta.url), 'utf8');

test('the header offers a Statement check button next to the other document tools', async () => {
 const html = await read('index.html');
 assert.match(html, /<button id="statement" disabled>Statement check<\/button>/);
 assert.ok(html.indexOf('id="fontid"') < html.indexOf('id="statement"'), 'the button sits with the document tools');
});

test('the statement dialog exposes a status line, a report, the fixes and a re-check', async () => {
 const html = await read('index.html');
 for (const id of ['statement-dialog', 'statement-close', 'statement-status', 'statement-info', 'statement-apply', 'statement-refresh'])
  assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
 assert.match(html, /<pre id="statement-info" class="fingerprint-output">/, 'the report is shown as copyable text');
 assert.match(html, /<button type="button" id="statement-apply" class="primary" disabled>Fix balances<\/button>/);
 assert.match(html, /Undo restores the previous text/, 'the dialog says the change is reversible');
});

test('the editor wires the button, the dialog and the fixes to the checker', async () => {
 const app = await read('app.mjs');
 assert.match(app, /import \{extractStatementRows, checkStatement, formatReport\} from '\.\/statement-check\.mjs';/);
 assert.match(app, /\$\('statement'\)\.onclick=openStatementCheck/);
 assert.match(app, /\$\('statement-apply'\)\.onclick=applyStatementFixes/);
 assert.match(app, /\$\('statement-refresh'\)\.onclick=openStatementCheck/);
 assert.match(app, /\$\('statement'\)\.disabled=!doc\|\|busy\|\|metadataLoading/);
 // The check reads every page, with the edits already made, and reports on it.
 assert.match(app, /async function statementPageData\(\)/);
 assert.match(app, /for\(let n=1;n<=doc\.numPages;n\+\+\)/);
 assert.match(app, /edits\.get\(block\.id\)\|\|block/);
 assert.match(app, /statementReport=checkStatement\(extracted\.rows\)/);
 // Applying fixes records one undo step and only touches editable balance cells.
 assert.match(app, /async function applyStatementFixes\(\)/);
 assert.match(app, /history\.push\(snapshot\(\)\)/);
 assert.match(app, /target\.canEdit\|\|target\.added/);
 assert.match(app, /edits\.set\(target\.id,\{\.\.\.\(edits\.get\(target\.id\)\|\|target\),text:fix\.to\}\)/);
 assert.match(app, /await runStatementCheck\(\)/, 'the report is refreshed after the fixes');
 assert.match(app, /openStatementCheck,applyStatementFixes,get statementReport\(\)/, 'the test hook exposes the feature');
});

test('every statement element the script touches exists in the page', async () => {
 const app = await read('app.mjs');
 const html = await read('index.html');
 const ids = new Set([...app.matchAll(/\$\('(statement[A-Za-z-]*)'\)/g)].map(match => match[1]));
 assert.ok(ids.size >= 6, 'the script touches the statement controls');
 for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `${id} is present in index.html`);
});
