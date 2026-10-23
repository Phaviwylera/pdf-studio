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
 assert.match(app, /ownerPassword:passwords\.ownerPassword,fileId,PDFLib,onProgress/);
 assert.match(app, /signPdfCopy\(\{bytes,sourceBytes:uploadedOriginal,credential,PDFLib,forge:window\.forge,fileId\}\)/);
 assert.match(app, /encryptPdfCopy\(\{bytes,password,ownerPassword,metadataFile:metadataPayload,fileId:await readPdfFileId/);
});
