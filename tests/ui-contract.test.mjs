import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('encrypt dialog accepts an optional metadata .json file and no longer embeds a report', async () => {
 const html = await read('../dist/index.html');
 assert.match(html, /id="encrypt-metadata" type="file" accept="\.json,application\/json"/);
 assert.doesNotMatch(html, /encrypt-embed-metadata/);
 assert.doesNotMatch(html, /Embed the PDF’s native metadata/);
 const app = await read('../dist/app.mjs');
 assert.doesNotMatch(app, /encrypt-embed-metadata/);
 assert.match(app, /metadataFile:metadataPayload/);
 assert.match(app, /\$\('encrypt-metadata'\)\.files\[0\]/);
 assert.match(app, /for\(const id of \['encrypt-file','encrypt-metadata'/);
 assert.match(html, /id="encrypt-metadata-clear"/);
 assert.match(html, /id="encrypt-without-metadata" hidden/);
 assert.match(html, /id="encrypt-metadata-status" role="status"/);
 assert.match(app, /\$\('encrypt-without-metadata'\)\.hidden=false/);
 assert.match(app, /\$\('encrypt-form'\)\.requestSubmit\(\)/);
 assert.match(app, /async function inspectEncryptMetadata/);
 assert.match(app, /\$\('encrypt-metadata'\)\.onchange=inspectEncryptMetadata/);
 assert.match(app, /error\.metadataError/);
 assert.match(html, /id="encrypt-fallback-dialog"/);
 assert.match(html, /id="encrypt-fallback-continue" class="primary">Encrypt without the JSON/);
 assert.match(app, /function showEncryptMetadataFallback/);
 assert.match(app, /showEncryptMetadataFallback\(metadataFile\.name,error\.message\)/);
 assert.match(app, /\$\('encrypt-fallback-continue'\)\.onclick/);
});

test('metadata upload keeps a successful filename visible and confirms it is loaded for export', async () => {
 const app = await read('../dist/app.mjs');
 const start = app.indexOf('async function selectMetadataUpload');
 const end = app.indexOf('function clearEncryptionForm', start);
 assert.ok(start >= 0 && end > start, 'metadata upload handler is present');
 const handler = app.slice(start, end);
 assert.match(handler, /loaded=true/);
 assert.match(handler, /loaded for export/);
 const clears = [...handler.matchAll(/\$\('metadata-file'\)\.value=''/g)];
 assert.equal(clears.length, 1, 'the file input is only cleared when loading fails or the document changes');
 assert.match(handler, /if\(!loaded\)\$\('metadata-file'\)\.value=''/);
});

test('downloads expose a manual retry outside blocked preview frames', async () => {
 const html = await read('../dist/index.html');
 const app = await read('../dist/app.mjs');
 assert.match(html, /id="download-ready" class="download-ready"/);
 assert.match(html, /id="download-ready-link" download>Save again/);
 assert.match(html, /id="download-ready-open" target="_blank"/);
 assert.match(html, /id="download-ready-newtab" hidden>Open app in new tab/);
 assert.match(html, /id="encrypt-download-hint"/);
 assert.match(app, /document\.body\.append\(anchor\);anchor\.click\(\);anchor\.remove\(\)/);
 assert.match(app, /10\*60\*1000/);
 assert.match(app, /window\.self!==window\.top/);
 assert.match(app, /window\.open\(location\.href,'_blank','noopener'\)/);
 assert.match(app, /import \{ decryptPdfCopy \} from '\.\/decrypt\.mjs'/);
 assert.match(app, /workingBytes=await decryptPdfCopy\(\{bytes,password:acceptedPassword\?\?''\}\)/);
 assert.match(app, /original=workingBytes;uploadedOriginal=bytes/);
 assert.match(app, /new Blob\(\[uploadedOriginal\.slice\(\)\]/);
 assert.match(app, /\):uploadedOriginal\.slice\(\);/);
 const decrypt = await read('../dist/decrypt.mjs');
 assert.match(decrypt, /--decrypt/);
 assert.match(decrypt, /new URL\('\.\/vendor\/qpdf\/qpdf\.wasm', import\.meta\.url\)/);
});

test('file identifier dialog restores the original /ID into exports', async () => {
 const html = await read('../dist/index.html');
 const app = await read('../dist/app.mjs');
 assert.match(html, /id="fileid" disabled>File ID</);
 assert.match(html, /id="fileid-dialog"/);
 assert.match(html, /id="fileid-info" class="fingerprint-output"/);
 assert.match(html, /id="fileid-file" type="file" accept="application\/pdf,\.pdf"/);
 assert.match(html, /id="fileid-status" role="status"/);
 assert.match(html, /id="fileid-clear" disabled/);
 assert.match(app, /import \{readPdfFileId, sameFileId, fileIdWarning, enforceFileId\} from '\.\/file-id\.mjs'/);
 assert.match(app, /const uploadedFileId=await readPdfFileId\(bytes,PDFLib\)/);
 assert.match(app, /sourceFileId=uploadedFileId;workingFileId=nextWorkingFileId/);
 assert.match(app, /function activeFileId\(\)\{return restoreFileId\|\|sourceFileId\|\|null\}/);
 assert.match(app, /async function selectFileIdSource\(file\)/);
 assert.match(app, /\$\('fileid-file'\)\.onchange=\(\)=>selectFileIdSource/);
 assert.match(app, /const fileId=activeFileId\(\);/);
 assert.match(app, /metadataRecord:sourceMetadata,uploadedMetadata,fileId,onProgress:status/);
 assert.match(app, /enforceFileId\(\{bytes:nativeBytes,fileId,PDFLib\}\)/);
 assert.match(app, /ownerPassword:passwords\.ownerPassword,algorithm:\$\('export-algorithm'\)\.value,fileId,PDFLib,onProgress/);
 assert.match(app, /signPdfCopy\(\{bytes,sourceBytes:uploadedOriginal,credential,PDFLib,forge:window\.forge,fileId\}\)/);
 assert.match(app, /encryptPdfCopy\(\{bytes,password,ownerPassword,algorithm:\$\('encrypt-algorithm'\)\.value,metadataFile:metadataPayload,fileId:await readPdfFileId/);
});

test('the Fonts dialog reports page-1 programs and reuses them on every page', async () => {
 const html = await read('../dist/index.html');
 const app = await read('../dist/app.mjs');
 assert.match(html, /id="fontid" disabled>Fonts</);
 assert.match(html, /id="fontid-dialog"/);
 assert.match(html, /id="fontid-info" class="fingerprint-output"/);
 assert.match(html, /id="fontid-status" role="status"/);
 assert.match(html, /id="fontid-clear" disabled/);
 assert.match(app, /import \{buildDocumentFontInventory, fontKey, formatFontInventory\} from '\.\/font-inventory\.mjs'/);
 assert.match(app, /const fontProgramPool=new Map\(\)/);
 assert.match(app, /const documentFontOptions=\[\]/);
 assert.match(app, /async function loadDocumentFonts\(\)/);
 assert.match(app, /await loadDocumentFonts\(\);\n/);
 assert.match(app, /async function primeDocumentFonts\(inventory\)/);
 assert.match(app, /async function poolProgram\(key,data,page,baseFont\)/);
 assert.match(app, /function applyProgramDonor\(record,page\)/);
 assert.match(app, /function documentFontForBlock\(block,text\)/);
 assert.match(app, /function documentFontForPage\(page\)/);
 assert.match(app, /\$\('fontid'\)\.onclick=openFontDialog/);
 assert.match(app, /\$\('fontid'\)\.disabled=!doc\|\|busy\|\|metadataLoading/);
 assert.match(app, /const docFont=documentFontOptions\[0\]/);
 assert.match(app, /document font\$?\{?.*available on every page/);
});

test('document fonts are exported by reusing their existing font dictionary', async () => {
 const app = await read('../dist/app.mjs');
 const exporter = await read('../dist/native-export.mjs');
 const font = await read('../dist/document-font.mjs');
 assert.match(app, /function documentFontPlans\(\)/);
 assert.match(app, /function donorResourceName\(inventory,font,page\)/);
 assert.match(app, /metadataRecord:sourceMetadata,uploadedMetadata,fileId,documentFonts:documentFontPlans\(\),onProgress:status/);
 assert.match(app, /metadataRecord:sourceMetadata,uploadedMetadata,documentFonts:documentFontPlans\(\),fileId:activeFileId\(\)\}/);
 assert.match(exporter, /import \{readDocumentFont, documentFontEncoder\} from '\.\/document-font\.mjs'/);
 assert.match(exporter, /documentFonts=new Map\(\)/);
 assert.match(exporter, /else if\(documentFonts\.has\(block\.font\)&&!fonts\.get\(block\.font\)\)/);
 assert.match(exporter, /fontObject=ref;/);
 assert.match(font, /export function parseToUnicode\(text\)/);
 assert.match(font, /export function parseCidWidths\(descendant, context, L\)/);
 assert.match(font, /export function readDocumentFont\(ref, context, L\)/);
 assert.match(font, /export function documentFontEncoder\(font, \{wordSpacing = 0\} = \{\}\)/);
});

test('the encryption algorithm can be chosen for an export and for the standalone encryptor', async () => {
 const html = await read('../dist/index.html');
 const app = await read('../dist/app.mjs');
 for (const id of ['export-algorithm', 'encrypt-algorithm'])
  assert.match(html, new RegExp(`<select id="${id}">`), `${id} offers a choice`);
 assert.match(html, /<option value="AES-256" selected>AES-256/, 'AES-256 stays the default');
 assert.match(html, /<option value="RC4-128">RC4 128-bit/, 'the legacy scheme is offered');
 assert.match(app, /algorithm:\$\('export-algorithm'\)\.value/);
 assert.match(app, /algorithm:\$\('encrypt-algorithm'\)\.value/);
 // RC4 needs no Web Crypto, so a plain http page can still produce one.
 assert.match(await read('../dist/encrypt.mjs'), /RC4 128-bit works without it/);
});
