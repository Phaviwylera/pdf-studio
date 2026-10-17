import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');
globalThis.PDFLib = L; // The bundled encryptor reads the same UMD global as the browser.
const {exportNativePdf} = await import('../dist/native-export.mjs');
const {parseUploadedMetadata} = await import('../dist/metadata.mjs');
const {encryptPdfCopy} = await import('../dist/encrypt.mjs');
const {decryptPdfCopy} = await import('../dist/decrypt.mjs');
const {
 MIN_EXPORT_PASSWORD_LENGTH, encryptExportCopy, encryptedExportName, validateExportPasswords,
} = await import('../dist/export-encryption.mjs');
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const latin1 = new TextDecoder('latin1');
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const key = name => L.PDFName.of(name);

async function fixture() {
 const pdf = await L.PDFDocument.create();
 pdf.setTitle('Original title');
 pdf.setAuthor('Original author');
 pdf.addPage([300, 200]).drawText('Existing text', {x: 30, y: 150});
 return pdf.save();
}

function addedText(text) {
 return new Map([['1:new', {
  id: '1:new', added: true, page: 1, text, x: 42, y: 42, size: 12,
  font: 'Arial', bold: false, italic: false, color: '#112233', spacing: 0,
  lineheight: 1.2, align: 'left', scaleX: 1, ops: [],
 }]]);
}

const getPage = async () => ({vp: {transform: [1, 0, 0, -1, 0, 200]}, info: {ops: []}});

function infoEntries(pdf) {
 const info = pdf.context.trailerInfo.Info && pdf.context.lookup(pdf.context.trailerInfo.Info, L.PDFDict);
 return info ? Object.fromEntries([...info.entries()].map(([name, value]) => [name.toString(), value.toString()])) : {};
}

function pageContent(pdf, index = 0) {
 const raw = pdf.context.lookup(pdf.getPage(index).node.get(key('Contents')));
 const streams = raw instanceof L.PDFArray ? [...raw.asArray()].map(ref => pdf.context.lookup(ref)) : [raw];
 return streams.map(stream => latin1.decode(L.decodePDFRawStream(stream).decode())).join('\n');
}

function qpdfFactory() {
 const qpdf = require('../dist/vendor/qpdf/qpdf.js');
 const wasmBinary = new Uint8Array(require('node:fs').readFileSync(new URL('../dist/vendor/qpdf/qpdf.wasm', import.meta.url)));
 return options => qpdf({
  ...options,
  instantiateWasm(imports, receive) {
   WebAssembly.instantiate(wasmBinary, imports).then(result => receive(result.instance));
   return {};
  },
 });
}

test('export passwords require 8 characters, a matching confirmation and distinct optional owner password', () => {
 assert.equal(MIN_EXPORT_PASSWORD_LENGTH, 8);
 assert.deepEqual(
  validateExportPasswords({password: 'open-pass-1', confirmation: 'open-pass-1', ownerPassword: ''}),
  {password: 'open-pass-1', ownerPassword: ''},
 );
 assert.deepEqual(
  validateExportPasswords({password: ' open-pass-1 ', confirmation: ' open-pass-1 ', ownerPassword: 'owner-pass-2'}),
  {password: ' open-pass-1 ', ownerPassword: 'owner-pass-2'},
  'passwords are not silently trimmed',
 );
 assert.throws(() => validateExportPasswords({password: 'short', confirmation: 'short'}), /at least 8 characters/);
 assert.throws(() => validateExportPasswords({password: '', confirmation: ''}), /at least 8 characters/);
 assert.throws(() => validateExportPasswords({password: 'open-pass-1', confirmation: 'open-pass-2'}), /do not match/);
 assert.throws(() => validateExportPasswords({password: 'open-pass-1', confirmation: 'open-pass-1', ownerPassword: 'short'}), /at least 8 characters/);
 assert.throws(() => validateExportPasswords({password: 'open-pass-1', confirmation: 'open-pass-1', ownerPassword: 'open-pass-1'}), /different owner password/);
});

test('encrypted editor exports are named clearly', () => {
 assert.equal(encryptedExportName('statement-edited.pdf'), 'statement-edited-encrypted.pdf');
 assert.equal(encryptedExportName('statement-metadata-updated.PDF'), 'statement-metadata-updated-encrypted.pdf');
 assert.equal(encryptedExportName(''), 'document-encrypted.pdf');
 assert.equal(encryptedExportName(), 'document-encrypted.pdf');
});

test('invalid export passwords stop before the native export is encrypted', async () => {
 let calls = 0;
 const encryptPdfCopy = async () => { calls++; return new Uint8Array(); };
 await assert.rejects(encryptExportCopy({
  bytes: encoder.encode('%PDF-1.7\nnative'), password: 'short', confirmation: 'short', PDFLib: L, encryptPdfCopy,
 }), /at least 8 characters/);
 await assert.rejects(encryptExportCopy({
  bytes: encoder.encode('%PDF-1.7\nnative'), password: 'open-pass-1', confirmation: 'different-1', PDFLib: L, encryptPdfCopy,
 }), /do not match/);
 await assert.rejects(encryptExportCopy({
  bytes: new Uint8Array(), password: 'open-pass-1', confirmation: 'open-pass-1', PDFLib: L, encryptPdfCopy,
 }), /Create the native export/);
 assert.equal(calls, 0);
});

test('the editor encrypts exactly the bytes produced by the native export', async () => {
 const original = await fixture();
 const before = original.slice();
 const replacement = parseUploadedMetadata(encoder.encode(JSON.stringify({
  Title: 'Exported title', Author: 'Exported author', Custom: {Project: 'A-1'},
 })), 'replacement.json');
 const nativeBytes = await exportNativePdf({
  original, edits: addedText('Protected edit'), PDFLib: L, uploadedMetadata: replacement, getPage,
 });
 const nativePdf = await L.PDFDocument.load(nativeBytes, {updateMetadata: false});
 assert.equal(nativePdf.getTitle(), 'Exported title');
 assert.equal(nativePdf.getAuthor(), 'Exported author');
 assert.equal(infoEntries(nativePdf)['/Project'], L.PDFHexString.fromText('A-1').toString());
 assert.match(pageContent(nativePdf), /50726F7465637465642065646974/i, 'the edit is in the native export');

 let captured = null;
 const encrypted = await encryptExportCopy({
  bytes: nativeBytes, password: 'export-open-123', confirmation: 'export-open-123',
  ownerPassword: 'export-owner-456', PDFLib: L,
  encryptPdfCopy: async options => {
   captured = options.bytes;
   return encryptPdfCopy(options);
  },
 });
 assert.deepEqual(captured, nativeBytes, 'the unmodified native export bytes reach encryptPdfCopy');
 assert.deepEqual(original, before, 'the uploaded source bytes are never changed');
 assert.match(decoder.decode(encrypted), /\/AESV3/);
 assert.match(decoder.decode(encrypted), /\/Encrypt/);
 await assert.rejects(L.PDFDocument.load(encrypted), /encrypted/i, 'the downloaded PDF is actually password protected');
});

test('an AES-256 editor export decrypts back to the edited, metadata-replaced document', async () => {
 const original = await fixture();
 const replacement = parseUploadedMetadata(encoder.encode(JSON.stringify({
  Title: 'Protected export', Author: 'Protected author', Custom: {Project: 'A-1'},
 })), 'replacement.json');
 const nativeBytes = await exportNativePdf({
  original, edits: addedText('Protected edit'), PDFLib: L, uploadedMetadata: replacement, getPage,
 });
 const encrypted = await encryptExportCopy({
  bytes: nativeBytes, password: 'export-open-123', confirmation: 'export-open-123', PDFLib: L,
 });
 assert.notDeepEqual(encrypted, nativeBytes);
 const factory = qpdfFactory();
 await assert.rejects(
  decryptPdfCopy({bytes: encrypted, password: 'wrong-password', qpdfFactory: factory}),
  /could not be decrypted safely/i,
 );
 const clear = await decryptPdfCopy({bytes: encrypted, password: 'export-open-123', qpdfFactory: factory});
 const opened = await L.PDFDocument.load(clear);
 assert.equal(opened.getPageCount(), 1);
 assert.equal(opened.getTitle(), 'Protected export');
 assert.equal(opened.getAuthor(), 'Protected author');
 assert.equal(infoEntries(opened)['/Project'].toLowerCase(), L.PDFHexString.fromText('A-1').toString().toLowerCase());
 assert.match(pageContent(opened), /50726F7465637465642065646974/i, 'the edit survives encryption and decryption');
 // qpdf's Node build mirrors CLI exit codes onto process.exitCode after callMain.
 process.exitCode = 0;
});

test('Export PDF asks for a regular or encrypted copy before any download', async () => {
 const html = await read('../dist/index.html');
 const app = await read('../dist/app.mjs');
 assert.match(html, /id="export-dialog"/);
 assert.match(html, /id="export-mode-standard" name="export-encryption" value="standard" checked/);
 assert.match(html, /id="export-mode-encrypted" name="export-encryption" value="encrypted"/);
 assert.match(html, /id="export-password-fields" hidden/);
 assert.match(html, /<label>Open password<input id="export-password" type="password" autocomplete="new-password" minlength="8">/);
 assert.match(html, /<label>Confirm open password<input id="export-confirm" type="password" autocomplete="new-password" minlength="8">/);
 assert.match(html, /<label>Owner password <span class="small">Optional; leave blank to use the open password<\/span><input id="export-owner" type="password" autocomplete="new-password" minlength="8">/);
 assert.match(html, /id="export-submit" class="primary">Export PDF/);
 assert.match(html, /signed and view-only documents skip the export choice entirely/i);
 assert.match(app, /\$\('export'\)\.onclick=openExportOptions/);
 assert.match(app, /function openExportOptions\(\)\{finishInline\(\);if\(!doc\|\|busy\|\|metadataLoading\)return;if\(signatureState\.locked\)\{downloadOriginalCopy\(\);return\}clearExportForm\(\);\$\('export-dialog'\)\.showModal\(\)\}/);
 assert.match(app, /\$\('export-form'\)\.onsubmit=exportPdf/);
 assert.match(app, /\$\('export-mode-standard'\)\.onchange=syncExportMode;\$\('export-mode-encrypted'\)\.onchange=syncExportMode/);
});

test('the signed/view-only path downloads the uploaded original before any export prompt', async () => {
 const app = await read('../dist/app.mjs');
 const locked = app.indexOf('if(signatureState.locked){downloadOriginalCopy();return}');
 const modal = app.indexOf("$('export-dialog').showModal()");
 assert.ok(locked >= 0, 'the locked bypass is present');
 assert.ok(modal >= 0, 'the export dialog is present');
 assert.ok(locked < modal, 'Export PDF checks signature protection before opening the dialog');
 assert.match(app, /function downloadOriginalCopy\(\)\{download\(new Blob\(\[uploadedOriginal\.slice\(\)\]/);
 assert.match(app, /async function exportPdf\(event\)\{[\s\S]*?if\(signatureState\.locked\)\{downloadOriginalCopy\(\);return\}/);
});

test('encrypted export validates, natively exports, encrypts, downloads and clears passwords', async () => {
 const app = await read('../dist/app.mjs');
 const start = app.indexOf('async function exportPdf(event)');
 const end = app.indexOf('let signingCredential', start);
 assert.ok(start >= 0 && end > start, 'the export handler is present');
 const handler = app.slice(start, end);
 assert.ok(handler.indexOf('exportNativePdf(') < handler.indexOf('encryptExportCopy('), 'the native export happens first');
 assert.match(handler, /encryptExportCopy\(\{bytes,password:passwords\.password,confirmation:passwords\.password,ownerPassword:passwords\.ownerPassword,PDFLib/);
 assert.doesNotMatch(handler, /metadataFile/, 'metadata is already inside the native export bytes');
 assert.match(handler, /const name=encryptedExportName\(currentExportName\(\)\)/);
 assert.match(handler, /download\(new Blob\(\[protectedBytes\],\{type:'application\/pdf'\}\),name\)/);
 assert.match(handler, /finally\{\s*clearExportPasswords\(\)/);
 assert.doesNotMatch(handler, /localStorage|sessionStorage|indexedDB|fetch\(/);
 assert.match(handler, /const encrypted=!!event&&\$\('export-mode-encrypted'\)\.checked/);
 assert.match(handler, /validateExportPasswords\(\{password:\$\('export-password'\)\.value,confirmation:\$\('export-confirm'\)\.value,ownerPassword:\$\('export-owner'\)\.value\}\)/);
 assert.match(handler, /download\(new Blob\(\[bytes\],\{type:'application\/pdf'\}\),currentExportName\(\)\)/, 'the regular export path is retained');
 assert.match(handler, /if\(encrypted\)\{[\s\S]*?\}else\{[\s\S]*?currentExportName\(\)/, 'regular and encrypted downloads are distinct branches');
});

test('password fields are cleared on close, cancel, mode change and after use', async () => {
 const app = await read('../dist/app.mjs');
 assert.match(app, /function clearExportPasswords\(\)\{for\(const id of \['export-password','export-confirm','export-owner'\]\)\$\(id\)\.value=''\}/);
 const clear = app.slice(app.indexOf('function clearExportPasswords'), app.indexOf('function showExportFeedback'));
 assert.match(clear, /'export-password'/);
 assert.match(clear, /'export-confirm'/);
 assert.match(clear, /'export-owner'/);
 assert.doesNotMatch(clear, /encrypt-/);
 assert.match(app, /\$\('export-dialog'\)\.addEventListener\('cancel',event=>\{if\(busy\)event\.preventDefault\(\);else closeExportDialog\(\)\}\)/);
 assert.match(app, /\$\('export-dialog'\)\.addEventListener\('close',\(\)=>\{if\(!busy\)clearExportForm\(\)\}\)/);
 assert.match(app, /function closeExportDialog\(\)\{if\(\$\('export-dialog'\)\.open\)\$\('export-dialog'\)\.close\(\);clearExportForm\(\)\}/);
 assert.match(app, /function syncExportMode\(\)\{const encrypted=\$\('export-mode-encrypted'\)\.checked;[^}]*if\(!encrypted\)clearExportPasswords\(\)/);
});

test('the standalone Encrypt PDF action keeps its own dialog and flow', async () => {
 const app = await read('../dist/app.mjs');
 assert.match(app, /\$\('encrypt'\)\.onclick=\(\)=>\{if\(busy\)return;clearEncryptionForm\(\);\$\('encrypt-dialog'\)\.showModal\(\)\}/);
 assert.match(app, /\$\('encrypt-form'\)\.onsubmit=encryptStandalonePdf/);
 assert.match(app, /async function encryptStandalonePdf\(event\)/);
 const clear = app.slice(app.indexOf('function clearEncryptionForm'), app.indexOf('function showEncryptMetadataFallback'));
 assert.doesNotMatch(clear, /export-password|export-confirm|export-owner/);
});
