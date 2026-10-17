import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {decryptPdfCopy} from '../dist/decrypt.mjs';

const require = createRequire(import.meta.url);
const PDFLib = require('../dist/vendor/pdf-lib.min.js');
globalThis.PDFLib = PDFLib;
const {encryptPdfCopy} = await import('../dist/encrypt.mjs');
const bytes = text => new TextEncoder().encode(text);
const validPdf = bytes('%PDF-1.7\nworking copy');

function fakeQpdf({exitCode = 0, output = validPdf, errors = []} = {}) {
 const files = new Map();
 let args;
 return {
  files,
  get args() { return args; },
  factory: async () => ({
   FS: {
    writeFile(path, value) { files.set(path, value.slice()); },
    readFile(path) { if (!files.has(path)) throw new Error('file not found'); return files.get(path).slice(); },
    unlink(path) { files.delete(path); },
   },
   callMain(value) { args = value; if (output) files.set(value.at(-1), output.slice()); return exitCode; },
  }),
  errors,
 };
}

test('qpdf receives the PDF password and decrypt arguments without invoking a shell', async () => {
 const qpdf = fakeQpdf();
 const output = await decryptPdfCopy({bytes: bytes('%PDF-1.7\nencrypted'), password: 'a password; --not-a-flag', qpdfFactory: qpdf.factory});
 assert.deepEqual(qpdf.args, ['--password=a password; --not-a-flag', '--decrypt', '/pdf-studio-input.pdf', '/pdf-studio-decrypted.pdf']);
 assert.deepEqual(output, validPdf);
});

test('decryption returns an independent copy and leaves uploaded bytes unchanged', async () => {
 const input = bytes('%PDF-1.7\nsource');
 const before = input.slice();
 const qpdf = fakeQpdf();
 const output = await decryptPdfCopy({bytes: input, password: '', qpdfFactory: qpdf.factory});
 output[0] = 0;
 assert.deepEqual(input, before);
 assert.equal(qpdf.files.size, 0, 'temporary files are removed from qpdf memory');
});

test('a qpdf failure becomes a safe decryption error and still cleans its files', async () => {
 const qpdf = fakeQpdf({exitCode: 2, output: null});
 qpdf.factory = async () => ({
  FS: {
   writeFile(path, value) { qpdf.files.set(path, value.slice()); },
   readFile(path) { return qpdf.files.get(path); },
   unlink(path) { qpdf.files.delete(path); },
  },
  callMain() { return 2; },
 });
 await assert.rejects(decryptPdfCopy({bytes: bytes('%PDF-1.7\nsource'), password: 'wrong', qpdfFactory: qpdf.factory}), /could not be decrypted safely/i);
 assert.equal(qpdf.files.size, 0);
});

test('missing qpdf output is rejected instead of returning an empty document', async () => {
 const qpdf = fakeQpdf({output: null});
 await assert.rejects(decryptPdfCopy({bytes: bytes('%PDF-1.7\nsource'), password: 'secret', qpdfFactory: qpdf.factory}), /could not be decrypted safely/i);
 assert.equal(qpdf.files.size, 0);
});

test('qpdf output must contain a PDF header', async () => {
 const qpdf = fakeQpdf({output: bytes('not a PDF')});
 await assert.rejects(decryptPdfCopy({bytes: bytes('%PDF-1.7\nsource'), password: 'secret', qpdfFactory: qpdf.factory}), /could not be decrypted safely/i);
});

test('decryption rejects missing byte input and a non-string password', async () => {
 await assert.rejects(decryptPdfCopy({bytes: new Uint8Array(), password: 'secret', qpdfFactory: async () => { throw new Error('must not initialize'); }}), /non-empty PDF byte array/);
 await assert.rejects(decryptPdfCopy({bytes: bytes('%PDF-1.7\nsource'), password: null, qpdfFactory: async () => { throw new Error('must not initialize'); }}), /password is required/);
});

test('bundled qpdf/WASM decrypts an AES-256 PDF and rejects an incorrect password', async () => {
 const pdf = await PDFLib.PDFDocument.create();
 pdf.addPage([300, 200]).drawText('Private document', {x: 24, y: 120});
 pdf.setTitle('Private source title');
 const clear = await pdf.save();
 const encrypted = await encryptPdfCopy({bytes: clear, password: 'open-password-123', PDFLib});
 const encryptedBefore = encrypted.slice();
 const qpdf = require('../dist/vendor/qpdf/qpdf.js');
 const wasmBinary = new Uint8Array(await readFile(new URL('../dist/vendor/qpdf/qpdf.wasm', import.meta.url)));
 const factory = options => qpdf({
  ...options,
  instantiateWasm(imports, receive) {
   WebAssembly.instantiate(wasmBinary, imports).then(result => receive(result.instance));
   return {};
  },
 });
 const decrypted = await decryptPdfCopy({bytes: encrypted, password: 'open-password-123', qpdfFactory: factory});
 const opened = await PDFLib.PDFDocument.load(decrypted);
 assert.equal(opened.getPageCount(), 1);
 assert.equal(opened.getTitle(), 'Private source title');
 assert.equal(opened.context.lookup(opened.context.trailerInfo.Encrypt), undefined);
 assert.deepEqual(encrypted, encryptedBefore, 'the uploaded encrypted source bytes remain unchanged');
 await assert.rejects(decryptPdfCopy({bytes: encrypted, password: 'wrong-password', qpdfFactory: factory}), /could not be decrypted safely/i);
 // qpdf's Node build mirrors CLI exit codes onto process.exitCode after callMain.
 process.exitCode = 0;
});
