// Document font inventory and page-1 font reuse.
//
// A PDF can repeat the same typeface on every page, but only the first pages may
// carry a usable embedded font program. Editing page 9 then falls back to a
// browser substitute even though page 1 already has the right font inside the
// same file. This module reads the /Font resources of every page, groups them by
// typeface identity, and names the page that should donate its embedded program
// when a later page's own program is missing or too small.

const STYLE_WORDS = /(?:semibold|demibold|bold|italic|oblique|regular|roman|medium|light|heavy|black|thin|book|normal|psmt|mt)/gi;
// Style suffixes repeat (BoldMT, ItalicMT, BoldItalic) and only the *last* run
// belongs to the style, so strip the tail repeatedly instead of once.
const STYLE_TAIL = /(?:(?:semibold|demibold|bold|italic|oblique|regular|roman|medium|light|heavy|black|thin|book|normal|psmt|mt))+$/;

function cleanName(value) {
 const raw = String(value || '').replace(/^\//, '').replace(/#([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
 return raw.trim();
}

// pdf-lib and some producers append a random numeric suffix to embedded names
// (`LiberationSans-7572`). It changes per file, so it is not part of the identity.
const RANDOM_SUFFIX = /-\d{3,6}$/;

function stripRandomSuffix(name) {
 return String(name || '').replace(RANDOM_SUFFIX, '');
}

function compactFamily(name) {
 const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
 return compact.replace(STYLE_TAIL, '') || compact;
}

function displayFamily(baseFont) {
 const stripped = stripRandomSuffix(baseFont);
 // Camel-case names read better with a space: OpenSans → Open Sans.
 const spaced = stripped.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
 return spaced.replace(STYLE_WORDS, '').replace(/[\s_-]+/g, ' ').trim() || spaced;
}

/** Split a PDF BaseFont such as `ABCDEF+OpenSans-Bold` into identity parts. */
export function splitFontName(name) {
 const raw = cleanName(name);
 const subset = raw.match(/^([A-Z]{6})\+/)?.[1] || null;
 const baseFont = raw.replace(/^[A-Z]{6}\+/, '');
 const identity = stripRandomSuffix(baseFont);
 const bold = /bold|black|heavy|demi|semibold/i.test(baseFont);
 const italic = /italic|oblique|slanted/i.test(baseFont);
 return {raw, baseFont, subset, family: compactFamily(identity), displayFamily: displayFamily(identity), bold, italic};
}

/** Stable typeface identity used to decide whether two font resources are the
 *  same face. The subset tag is deliberately ignored: two pages of one document
 *  usually embed differently tagged subsets of the same face. */
export function fontKey(name) {
 const parts = splitFontName(name);
 return `${parts.family}|${parts.bold ? 'bold' : 'regular'}|${parts.italic ? 'italic' : 'upright'}`;
}

export function fontLabel(font) {
 if (!font) return 'Unknown font';
 const family = font.displayFamily || font.family || font.baseFont;
 return `${family}${font.bold ? ' Bold' : ''}${font.italic ? ' Italic' : ''}`;
}

function streamBytes(value, context, L) {
 let stream = value;
 try {
  if (L.PDFRef && stream instanceof L.PDFRef) stream = context.lookup(stream);
  if (stream instanceof L.PDFRawStream) return L.decodePDFRawStream(stream).decode();
  if (stream instanceof L.PDFStream) return stream.getUnencodedContents();
 } catch {}
 return null;
}

function readName(dict, key, L) {
 const value = dict?.get?.(L.PDFName.of(key));
 if (!value) return null;
 try {
  if (typeof value.decodeText === 'function') return cleanName(value.decodeText());
 } catch {}
 return cleanName(value.toString());
}

/**
 * Read one font resource dictionary. Type0 fonts keep the descriptor on their
 * CIDFont descendant; subset tags on the Type0 BaseFont are the useful name.
 */
export function readFontResource(ref, context, L) {
 let dict = ref;
 try {
  if (L.PDFRef && dict instanceof L.PDFRef) dict = context.lookup(dict);
 } catch {
  return null;
 }
 if (!(dict instanceof L.PDFDict)) return null;
 const subtype = readName(dict, 'Subtype', L) || 'Unknown';
 const baseFont = readName(dict, 'BaseFont', L) || readName(dict, 'Name', L) || '';
 let target = dict;
 if (subtype === 'Type0') {
  const descendants = dict.lookupMaybe(L.PDFName.of('DescendantFonts'), L.PDFArray);
  const first = descendants?.get?.(0);
  if (first) {
   try {
    const descendant = L.PDFRef && first instanceof L.PDFRef ? context.lookup(first) : first;
    if (descendant instanceof L.PDFDict) target = descendant;
   } catch {}
  }
 }
 const descriptor = target.lookupMaybe(L.PDFName.of('FontDescriptor'), L.PDFDict);
 let programKey = null, program = null;
 if (descriptor) {
  for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
   const value = descriptor.get(L.PDFName.of(key));
   if (!value) continue;
   programKey = key;
   program = streamBytes(value, context, L);
   break;
  }
 }
 return {
  baseFont: baseFont || `${subtype} font`,
  subtype,
  bold: /bold|black|heavy|demi|semibold/i.test(baseFont),
  italic: /italic|oblique|slanted/i.test(baseFont),
  embedded: !!programKey,
  programKey,
  program: program && program.length ? program : null,
 };
}

function mergeEntry(entry, resource, pageNumber) {
 if (!entry.pages.includes(pageNumber)) entry.pages.push(pageNumber);
 if (resource.baseFont && !entry.baseFonts.includes(resource.baseFont)) entry.baseFonts.push(resource.baseFont);
 entry.subtypes.add(resource.subtype);
 entry.embedded = entry.embedded || resource.embedded;
 // The earliest page that actually embeds a program becomes the donor, so a
 // document whose page 1 carries the real font is the preferred source.
 if (resource.program && !entry.program) {
  entry.program = resource.program;
  entry.programPage = pageNumber;
  entry.programKey = resource.programKey;
 }
}

/**
 * Walk every page of a PDF and group its /Font resources by typeface.
 * Returns {pageCount, pages:[{page, fonts:[…]}], fonts:[…]}.
 */
export async function buildDocumentFontInventory(bytes, L) {
 const document = await L.PDFDocument.load(bytes.slice(), {ignoreEncryption: true, updateMetadata: false});
 const context = document.context;
 const entries = new Map();
 const pages = [];
 const pageCount = document.getPageCount();
 for (let index = 0; index < pageCount; index++) {
  const pageNumber = index + 1;
  const page = document.getPage(index);
  const resources = page.node.Resources?.();
  const fontDict = resources?.lookupMaybe?.(L.PDFName.of('Font'), L.PDFDict) || null;
  const fonts = [];
  if (fontDict) {
   for (const [name, ref] of fontDict.entries()) {
    const resource = readFontResource(ref, context, L);
    if (!resource) continue;
    const key = fontKey(resource.baseFont);
    let entry = entries.get(key);
    if (!entry) {
     entry = {
      key, family: splitFontName(resource.baseFont).family, baseFont: resource.baseFont, baseFonts: [],
      bold: resource.bold, italic: resource.italic, subtypes: new Set(), embedded: false,
      program: null, programPage: null, programKey: null, pages: [], resourceNames: [],
     };
     entries.set(key, entry);
    }
    mergeEntry(entry, resource, pageNumber);
    if (!entry.resourceNames.includes(name.decodeText?.() || name.toString())) {
     entry.resourceNames.push(name.decodeText?.() || name.toString());
    }
    fonts.push({page: pageNumber, resourceName: name.decodeText?.() || name.toString(), key, baseFont: resource.baseFont, subtype: resource.subtype, embedded: resource.embedded});
   }
  }
  pages.push({page: pageNumber, fonts});
 }
 return {
  pageCount,
  pages,
  fonts: [...entries.values()].map(entry => ({...entry, subtypes: [...entry.subtypes], pages: [...entry.pages].sort((a, b) => a - b)})),
 };
}

export function pageFontList(inventory, page) {
 return inventory?.pages?.find(entry => entry.page === Number(page))?.fonts || [];
}

/** Fonts seen on page 1, in resource order. */
export function pageOneFonts(inventory) {
 return pageFontList(inventory, 1);
}

/** The usable embedded program for a typeface, preferring `page` and then the
 *  earliest page that carries one (normally page 1). */
export function reusableProgram(inventory, {key, page = 1} = {}) {
 const font = inventory?.fonts?.find(entry => entry.key === key);
 if (!font?.program) return null;
 return {key, family: font.family, baseFont: font.baseFont, program: font.program, programPage: font.programPage, requestedPage: page, reused: font.programPage !== page};
}

/** Typefaces a page uses but cannot draw with, mapped to the page that can. */
export function reuseTable(inventory) {
 const rows = [];
 for (const font of inventory?.fonts || []) {
  const usedOn = font.pages;
  const donorPage = font.programPage;
  const missingOn = donorPage ? usedOn.filter(page => page !== donorPage) : usedOn;
  rows.push({
   key: font.key, family: font.family, label: fontLabel(font), baseFont: font.baseFont,
   bold: font.bold, italic: font.italic, subtype: font.subtypes.join('/'), embedded: font.embedded,
   pages: usedOn, donorPage, donorPageLabel: donorPage === 1 ? 'page 1' : donorPage ? `page ${donorPage}` : null,
   reusedOn: donorPage ? missingOn : [], unusableOn: donorPage ? [] : usedOn,
  });
 }
 return rows;
}

/** Text report for the Fonts dialog and the command-line tool. */
export function formatFontInventory(inventory, {page = null} = {}) {
 if (!inventory) return 'No font inventory available.';
 const lines = [`${inventory.fonts.length} typeface${inventory.fonts.length === 1 ? '' : 's'} across ${inventory.pageCount} page${inventory.pageCount === 1 ? '' : 's'}.`];
 for (const row of reuseTable(inventory)) {
  const pages = row.pages.join(', ');
  const flags = [row.subtype, row.embedded ? 'embedded' : 'not embedded'].filter(Boolean).join(' · ');
  lines.push('');
  lines.push(`${row.label}  (${row.baseFont})`);
  lines.push(`  ${flags}`);
  lines.push(`  used on page${row.pages.length === 1 ? '' : 's'} ${pages}`);
  if (row.donorPage) {
   lines.push(`  program: ${row.donorPageLabel}${row.reusedOn.length ? ` · reused on page${row.reusedOn.length === 1 ? '' : 's'} ${row.reusedOn.join(', ')}` : ''}`);
  } else {
   lines.push('  program: not embedded anywhere · edits fall back to a substitute family');
  }
 }
 if (page !== null) {
  const fonts = pageFontList(inventory, page);
  lines.push('', `Page ${page}: ${fonts.length ? fonts.map(font => font.baseFont).join(', ') : 'no text fonts'}`);
 }
 return lines.join('\n');
}

/** Compact JSON-safe summary (drops the raw program bytes). */
export function summarizeFontInventory(inventory) {
 return {
  pageCount: inventory?.pageCount || 0,
  types: inventory?.fonts?.length || 0,
  fonts: reuseTable(inventory).map(({key, family, baseFont, subtype, embedded, pages, donorPage, reusedOn}) => ({
   key, family, baseFont, subtype, embedded, pages, donorPage, reusedOn,
  })),
 };
}
