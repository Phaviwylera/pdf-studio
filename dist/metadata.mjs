// The downloadable record describes the uploaded file, not the edited export or a verified identity.
export const METADATA_ATTACHMENT = 'pdf-studio-source-metadata.json';
export const MAX_USER_METADATA_BYTES = 8 * 1024 * 1024;

const STANDARD_FIELDS = new Map([
 ['title', 'Title'], ['author', 'Author'], ['subject', 'Subject'],
 ['keywords', 'Keywords'], ['creator', 'Creator'], ['producer', 'Producer'],
 ['creationdate', 'CreationDate'], ['moddate', 'ModDate'], ['modificationdate', 'ModDate'],
 ['trapped', 'Trapped'],
]);
const READ_ONLY_FIELDS = new Set([
 'PDFFormatVersion', 'Language', 'EncryptFilterName', 'IsLinearized',
 'IsAcroFormPresent', 'IsXFAPresent', 'IsCollectionPresent', 'IsSignaturesPresent',
]);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Only PDF Info and raw XMP can be replaced. Document properties such as page count,
// encryption and signatures are not metadata and cannot be recreated from a JSON file.
export function parseUploadedMetadata(data, filename) {
 try {
  return parseUploadedMetadataStrict(data, filename);
 } catch (error) {
  if (error && typeof error === 'object' && !error.metadataError) error.metadataError = true;
  throw error;
 }
}

const TEXT_FIELDS = new Set(['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']);
const INFO_TYPES = 'text, a number, a boolean or a PDF name';

// Source sidecar reports describe the original file: its name, size, hashes,
// page count, version and encryption state. None of that is editable PDF
// metadata, and writing it into Info as Source* fields makes the export look
// like a re-saved copy of another document to validators. The values are
// validated for shape, then ignored.
const SIDECAR_METADATA_FIELDS = new Set(['version', 'pages', 'encrypted', 'decrypted', 'signed', 'linearized', 'language']);

// Any Info key that describes where the file came from is not written by this
// editor, whatever JSON supplied it.
export function isSourceDescriptor(key) {
 return /^source(?:[A-Z0-9_.-]|$)/.test(String(key));
}

function isSidecarReport(value) {
 if (!plainObject(value)) return false;
 const keys = Object.keys(value);
 if (!keys.length || !keys.every(key => key === 'file' || key === 'metadata' || key === 'xmp')) return false;
 if (!('file' in value) && !('metadata' in value)) return false;
 if ('file' in value && !plainObject(value.file)) return false;
 if ('metadata' in value && !plainObject(value.metadata)) return false;
 return true;
}

function describeJsonValue(value) {
 if (Array.isArray(value)) return value.length ? `an array of ${value.length} item${value.length === 1 ? '' : 's'}` : 'an empty array';
 if (plainObject(value)) {
  const keys = Object.keys(value);
  if (!keys.length) return 'an empty object';
  return `an object with ${keys.length === 1 ? 'key' : 'keys'} ${keys.slice(0, 3).map(key => `"${key}"`).join(', ')}${keys.length > 3 ? ', …' : ''}`;
 }
 if (value === null) return 'null';
 if (typeof value === 'string') return 'text';
 return `a ${typeof value}`;
}

function parseUploadedMetadataStrict(data, filename) {
 if (!(data instanceof Uint8Array) || !/\.json$/i.test(filename || '')) throw new Error('Choose a .json metadata file.');
 if (!data.length || data.length > MAX_USER_METADATA_BYTES) throw new Error('Metadata JSON must be between 1 byte and 8 MB.');
 let parsed;
 try { parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(data)); }
 catch { throw new Error('Metadata must be a valid UTF-8 JSON object.'); }
 if (!plainObject(parsed)) throw new Error('Metadata must be a valid UTF-8 JSON object.');

 const report = parsed.schema === 'pdf-studio/source-metadata/v1';
 if ('schema' in parsed && !report) throw new Error('Unsupported metadata report schema.');
 const structured = report || 'info' in parsed;
 if (structured) {
  const allowed = report ? ['schema', 'note', 'source', 'info', 'xmp', 'available'] : ['info', 'xmp'];
  for (const key of Object.keys(parsed)) if (!allowed.includes(key)) throw new Error(`Unsupported metadata field: ${key}. Supported keys are ${allowed.join(', ')}.`);
  if (!plainObject(parsed.info)) throw new Error('The info field must be an object.');
 }
 const rawInfo = structured ? parsed.info : parsed;
 // Some downloaders write a sidecar report with the source file details and its
 // PDF properties, for example
 // {"file":{"name","sizeBytes","hashes"},"metadata":{"version","pages","Producer","CreationDate"}}.
 // File hashes and structural details cannot live in PDF Info under their original
 // names, so they are written as clearly prefixed custom Info fields.
 const sidecar = !structured && isSidecarReport(parsed);
 const fields = [], seen = new Set(), ignored = [], problems = [];
 function addField(key, value, custom = false, path = key) {
  if (value === null) return;
  if (READ_ONLY_FIELDS.has(key)) {
   if (report) {ignored.push(key); return;}
   throw new Error(`${key} is a PDF structure property, not editable metadata.`);
  }
  if (!/^[\x20-\x7e]{1,100}$/.test(key) || key.includes('/')) throw new Error(`Unsupported PDF Info key: ${key}.`);
  const canonical = custom ? key : (STANDARD_FIELDS.get(key.toLowerCase()) || key);
  if (seen.has(canonical)) throw new Error(`Duplicate PDF Info key: ${canonical}.`);
  seen.add(canonical);
  const type = canonical === 'Trapped' ? 'trapped' : ['CreationDate', 'ModDate'].includes(canonical) ? 'date' : 'value';
  if (type === 'trapped') {
   const name = plainObject(value) && typeof value.name === 'string' ? value.name : value;
   if (!['True', 'False', 'Unknown'].includes(name)) throw new Error(`PDF Info field "${path}" must be True, False or Unknown; received ${describeJsonValue(value)}.`);
   fields.push({key: canonical, type: 'name', value: name});
  } else if (type === 'date') {
   const pdfDate = typeof value === 'string' && /^D:\d{4}(?:\d{2}){0,5}(?:Z|[+-]\d{2}'?\d{2}'?)?$/.test(value);
   const isoDate = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
   if (!pdfDate && !isoDate) throw new Error(`PDF Info field "${path}" must be a PDF date or an ISO date-time; received ${describeJsonValue(value)}.`);
   fields.push({key: canonical, type: 'date', value});
  } else if (TEXT_FIELDS.has(canonical)) {
   // A list of names is a common JSON representation of a text field; PDF stores it as one string.
   const items = Array.isArray(value) ? value : null;
   const list = items && items.every(item => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean');
   if (typeof value === 'string') fields.push({key: canonical, type: 'text', value});
   else if (list) fields.push({key: canonical, type: 'text', value: items.map(item => String(item)).join(', ')});
   else problems.push(`PDF Info field "${path}" must be text or a list of names; received ${describeJsonValue(value)}.`);
  } else if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
   fields.push({key: canonical, type: typeof value, value});
  } else if (plainObject(value) && typeof value.name === 'string' && Object.keys(value).length === 1) {
   fields.push({key: canonical, type: 'name', value: value.name});
  } else {
   // PDF Info values are flat scalars. Nested objects and arrays have no native
   // representation, so name the exact field instead of writing a misleading value.
   problems.push(`PDF Info field "${path}" must be ${INFO_TYPES}; received ${describeJsonValue(value)}.`);
  }
 }
 if (sidecar) {
  for (const [key, value] of Object.entries(parsed.metadata || {})) {
   const path = `metadata.${key}`;
   if (value === null) continue;
   if (SIDECAR_METADATA_FIELDS.has(key)) ignored.push(`metadata.${key}`);
   else addField(key, value, false, path);
  }
  if (parsed.file !== undefined) {
   if (!plainObject(parsed.file)) throw new Error('The file field must be an object of source file details.');
   for (const [key, value] of Object.entries(parsed.file)) {
    const path = `file.${key}`;
    if (value === null) continue;
    if (key === 'hashes') {
     if (!plainObject(value)) { problems.push(`PDF Info field "${path}" must be an object of hash values; received ${describeJsonValue(value)}.`); continue; }
     for (const [algorithm, digest] of Object.entries(value)) {
      if (digest === null) continue;
      if (typeof digest !== 'string') { problems.push(`PDF Info hash "${path}.${algorithm}" must be text; received ${describeJsonValue(digest)}.`); continue; }
      ignored.push(`file.hashes.${algorithm}`);
     }
    } else if (plainObject(value) || Array.isArray(value)) problems.push(`PDF Info field "${path}" must be ${INFO_TYPES}; received ${describeJsonValue(value)}.`);
    else ignored.push(path);
   }
  }
 } else for (const [key, value] of Object.entries(rawInfo)) {
  const path = structured ? `info.${key}` : key;
  if (key === 'Custom') {
   if (!plainObject(value)) throw new Error(`The ${path} field must be an object of custom PDF Info values.`);
   for (const [customKey, customValue] of Object.entries(value)) addField(customKey, customValue, true, `${path}.${customKey}`);
  } else if (!structured && (key === 'xmp' || key === 'XMP')) continue;
  else addField(key, value, false, path);
 }
 if (problems.length) {
  const shown = problems.slice(0, 3).join(' ');
  throw new Error(`${shown}${problems.length > 3 ? ` ${problems.length - 3} more PDF Info field${problems.length - 3 === 1 ? ' is' : 's are'} unsupported.` : ''} Nothing was changed or downloaded. PDF Info values must be ${INFO_TYPES}; nested objects and arrays cannot be stored.`);
 }
 if (fields.length > 200) throw new Error('Metadata has more than 200 PDF Info fields.');
 const xmp = structured ? parsed.xmp : parsed.xmp ?? parsed.XMP;
 if ('xmp' in parsed && 'XMP' in parsed) throw new Error('Provide XMP only once.');
 let xmpRaw = null;
 if (xmp !== undefined && xmp !== null) {
  if (typeof xmp === 'string') xmpRaw = xmp;
  else if (plainObject(xmp) && (typeof xmp.raw === 'string' || xmp.raw === null)) xmpRaw = xmp.raw;
  else throw new Error('XMP must contain raw XML (xmp.raw).');
  if (xmpRaw && (!xmpRaw.trim().startsWith('<') || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xmpRaw))) throw new Error('XMP must be XML without a document type declaration.');
  if (xmpRaw && typeof DOMParser !== 'undefined' && new DOMParser().parseFromString(xmpRaw, 'application/xml').querySelector('parsererror')) throw new Error('XMP XML is not well formed.');
 }
 return {name: filename, byteLength: data.length, fields, xmpRaw: xmpRaw || null, ignored, format: sidecar ? 'sidecar' : report ? 'report' : structured ? 'info' : 'flat'};
}

export function makeSourceMetadataRecord({filename,byteLength,pageCount,inspection,metadata}) {
 // PDF.js mixes actual /Info entries with calculated document properties. Show
 // only native Info fields here so the inspector reflects what was written.
 const info = Object.fromEntries(Object.entries(metadata?.info || {}).filter(([key]) => !READ_ONLY_FIELDS.has(key)));
 const xmp = metadata?.metadata;
 return {
  schema: 'pdf-studio/source-metadata/v1',
  note: 'Source PDF metadata only. This record is not a digital signature or proof that an edited PDF is unchanged.',
  source: {
   filename,
   bytes: byteLength,
   pages: pageCount,
   encryption: inspection?.reason === 'encrypted' ? 'encrypted' : inspection?.unknown ? 'unknown' : 'not detected',
  },
  info: JSON.parse(JSON.stringify(info)),
  xmp: xmp ? {fields: Object.fromEntries(xmp), raw: xmp.getRaw()} : null,
  available: !!metadata,
 };
}

export function metadataJson(record) {
 return JSON.stringify(record, null, 2) + '\n';
}

// pdf-lib edits the document loaded from the source PDF. Save its full Info dictionary
// (including unknown/custom keys) and its catalog XMP stream, not just common fields.
export function capturePdfMetadata(document, L) {
 const context = document.context;
 const infoRef = context.trailerInfo.Info;
 const info = infoRef ? context.lookup(infoRef, L.PDFDict) : null;
 if (infoRef && !info) throw new Error('Cannot preserve the source PDF Info metadata.');
 return {info: info?.clone(context) || null, xmp: document.catalog.get(L.PDFName.of('Metadata'))};
}

export function restorePdfMetadata(document, L, saved) {
 const context = document.context;
 if (saved.info) context.trailerInfo.Info = context.register(saved.info);
 else delete context.trailerInfo.Info;
 const key = L.PDFName.of('Metadata');
 if (saved.xmp) document.catalog.set(key, saved.xmp);
 else document.catalog.delete(key);
}

function attachmentNames(document, L) {
 const context = document.context;
 const root = document.catalog.lookupMaybe(L.PDFName.of('Names'), L.PDFDict);
 const pending = [root?.get(L.PDFName.of('EmbeddedFiles'))];
 const seen = new Set(), names = new Set();
 while (pending.length) {
  const node = pending.pop();
  if (!node) continue;
  const dict = context.lookup(node);
  if (!(dict instanceof L.PDFDict) || seen.has(dict)) continue;
  seen.add(dict);
  const entries = dict.lookupMaybe(L.PDFName.of('Names'), L.PDFArray);
  if (entries) for (let i = 0; i < entries.size(); i += 2) {
   const name = context.lookup(entries.get(i))?.decodeText?.();
   if (name) names.add(name);
  }
  const kids = dict.lookupMaybe(L.PDFName.of('Kids'), L.PDFArray);
  if (kids) for (let i = 0; i < kids.size(); i++) pending.push(kids.get(i));
 }
 return names;
}

function uniqueAttachmentName(document, L, requested) {
 const used = attachmentNames(document, L);
 const stem = requested.slice(0, -5);
 let filename = requested, suffix = 2;
 while (used.has(filename)) filename = `${stem}-${suffix++}.json`;
 return filename;
}

export async function attachSourceMetadata(document, record, L) {
 if (!record) return;
 await document.attach(new TextEncoder().encode(metadataJson(record)), uniqueAttachmentName(document, L, METADATA_ATTACHMENT), {
  mimeType: 'application/json',
  description: 'Metadata of the uploaded source PDF; not a verification seal',
 });
}

// Replace, rather than merge: fields absent from the uploaded JSON must not retain
// old Info/XMP values. This never changes signatures, encryption or page structure.
export function applyUploadedMetadata(document, upload, L) {
 const context = document.context, info = context.obj({});
 for (const field of upload.fields) {
  // Defensive: a hand-written JSON may still contain Source* descriptor keys.
  if (isSourceDescriptor(field.key)) continue;
  let value;
  if (field.type === 'text' || field.type === 'string') value = L.PDFHexString.fromText(field.value);
  else if (field.type === 'date') value = field.value.startsWith('D:') ? L.PDFString.of(field.value) : L.PDFString.fromDate(new Date(field.value));
  else if (field.type === 'name') value = L.PDFName.of(field.value);
  else if (field.type === 'number') value = L.PDFNumber.of(field.value);
  else if (field.type === 'boolean') value = field.value ? L.PDFBool.True : L.PDFBool.False;
  else throw new Error('Unsupported metadata value type.');
  info.set(L.PDFName.of(field.key), value);
 }
 const oldInfo = context.trailerInfo.Info;
 // Replace the old indirect object as well as the trailer pointer. Otherwise a
 // full pdf-lib rewrite can leave the previous private metadata as an orphan.
 if (oldInfo instanceof L.PDFRef) context.assign(oldInfo, info);
 if (upload.fields.length) context.trailerInfo.Info = oldInfo instanceof L.PDFRef ? oldInfo : context.register(info);
 else delete context.trailerInfo.Info;
 const xmpKey = L.PDFName.of('Metadata'), oldXmp = document.catalog.get(xmpKey);
 if (oldXmp instanceof L.PDFRef) {
  // A Metadata stream can be shared with other objects. Replace its bytes with
  // empty, valid XML when removing it rather than breaking any shared reference.
  const xml = upload.xmpRaw || '<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>';
  context.assign(oldXmp, context.flateStream(new TextEncoder().encode(xml), {Type: 'Metadata', Subtype: 'XML'}));
 }
 if (upload.xmpRaw) {
  if (oldXmp instanceof L.PDFRef) document.catalog.set(xmpKey, oldXmp);
  else document.catalog.set(xmpKey, context.register(context.flateStream(new TextEncoder().encode(upload.xmpRaw), {Type: 'Metadata', Subtype: 'XML'})));
 } else document.catalog.delete(xmpKey);
}
