// Reuse a font dictionary that already lives in the PDF.
//
// A page whose /Font resources carry no embedded program can still be edited in
// the document's own typeface: the program is already inside the file, usually
// from page 1. Instead of extracting the program and embedding it again (which
// needs a full font parser and rewrites the subset), the editor points the edited
// page's /Font resource at the existing font object and draws with that font's
// character codes. The exported file keeps byte-identical font data — no second
// subset, no substitute family.

const hex4 = code => (code & 0xffff).toString(16).padStart(4, '0').toUpperCase();

function latin1(bytes) {
 let text = '';
 for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
 return text;
}

function streamText(value, context, L) {
 let stream = value;
 try {
  if (L.PDFRef && stream instanceof L.PDFRef) stream = context.lookup(stream);
  if (!stream) return null;
  const bytes = stream instanceof L.PDFRawStream ? L.decodePDFRawStream(stream).decode() : stream.getUnencodedContents();
  return latin1(bytes);
 } catch {
  return null;
 }
}

function utf16HexToText(hex) {
 const clean = String(hex || '').replace(/[^0-9a-f]/gi, '');
 let text = '';
 for (let i = 0; i + 4 <= clean.length; i += 4) {
  const unit = parseInt(clean.slice(i, i + 4), 16);
  if (Number.isNaN(unit)) continue;
  text += String.fromCharCode(unit);
  if (unit >= 0xd800 && unit <= 0xdbff && i + 7 < clean.length) {
   const low = parseInt(clean.slice(i + 4, i + 8), 16);
   if (low >= 0xdc00 && low <= 0xdfff) {
    text = text.slice(0, -1) + String.fromCharCode(unit, low);
    i += 4;
   }
  }
 }
 return text;
}

/**
 * Parse a ToUnicode CMap into a character → code map. Both `bfchar` and
 * `bfrange` forms are supported, including the array form of `bfrange`.
 * Codes keep their original byte width (2 bytes for Identity-H fonts).
 */
export function parseToUnicode(text) {
 const codes = new Map();
 if (!text) return codes;
 const add = (code, chars) => {
  const width = Math.max(1, code.length / 2);
  const normalized = code.toLowerCase();
  for (const char of chars) if (!codes.has(char)) codes.set(char, {code: normalized, width});
 };
 const decodeHex = hex => utf16HexToText(hex);
 const hexString = value => value.replace(/[<>\s]/g, '');
 const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
 for (const section of text.matchAll(bfchar)) {
  for (const match of section[1].matchAll(/<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>/g)) {
   const code = hexString(match[1]);
   if (!code) continue;
   const chars = decodeHex(hexString(match[2]));
   if (chars) add(code, chars);
  }
 }
 const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
 for (const section of text.matchAll(bfrange)) {
  const body = section[1];
  const entries = body.matchAll(/<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>\s*(<([0-9a-fA-F\s]*)>|\[([\s\S]*?)\])/g);
  for (const match of entries) {
   const first = parseInt(hexString(match[1]) || '0', 16);
   const last = parseInt(hexString(match[2]) || '0', 16);
   const width = Math.max(1, hexString(match[1]).length / 2);
   if (!Number.isFinite(first) || !Number.isFinite(last) || last < first || last - first > 0xffff) continue;
   const list = match[5];
   if (list) {
    const targets = [...list.matchAll(/<([0-9a-fA-F\s]*)>/g)].map(item => hexString(item[1]));
    targets.forEach((target, index) => {
     const chars = decodeHex(target);
     if (chars && first + index <= last) add(width === 2 ? hex4(first + index) : hex4(first + index).slice(-2), chars);
    });
    continue;
   }
   const base = hexString(match[4] || '');
   if (!base) continue;
   const baseValue = parseInt(base, 16);
   const offset = first;
   for (let code = first; code <= last; code++) {
    const chars = decodeHex(hex4(baseValue + (code - offset)).padStart(base.length, '0'));
    if (chars) add(width === 2 ? hex4(code) : hex4(code).slice(-2), chars);
   }
  }
 }
 return codes;
}

/**
 * Read the `/W` array (and `/DW`) of a CIDFont descendant into a width map keyed
 * by the same hexadecimal code used by the ToUnicode mapping.
 */
export function parseCidWidths(descendant, context, L) {
 const widths = new Map();
 if (!descendant) return {widths, defaultWidth: 1000};
 const data = descendant instanceof L.PDFDict ? descendant : context.lookup(descendant);
 const dw = data?.lookupMaybe?.(L.PDFName.of('DW'), L.PDFNumber);
 const defaultWidth = dw ? dw.asNumber() : 1000;
 const array = data?.lookupMaybe?.(L.PDFName.of('W'), L.PDFArray);
 if (!array) return {widths, defaultWidth};
 let index = 0;
 while (index < array.size()) {
  const first = array.lookup(index, L.PDFNumber)?.asNumber();
  const next = array.lookup(index + 1);
  if (!Number.isFinite(first) || !next) break;
  if (next instanceof L.PDFArray) {
   for (let offset = 0; offset < next.size(); offset++) {
    const width = next.lookup(offset, L.PDFNumber)?.asNumber();
    if (Number.isFinite(width)) widths.set(hex4(first + offset).toLowerCase(), width);
   }
   index += 2;
  } else {
   const last = next.asNumber?.();
   const width = array.lookup(index + 2, L.PDFNumber)?.asNumber();
   if (!Number.isFinite(last) || !Number.isFinite(width)) break;
   if (last - first > 0xffff) break;
   for (let code = first; code <= last; code++) widths.set(hex4(code).toLowerCase(), width);
   index += 3;
  }
 }
 return {widths, defaultWidth};
}

/**
 * Build a reusable description of an existing font dictionary: the character
 * codes needed to draw text with it and the advances to align it.
 */
export function readDocumentFont(ref, context, L) {
 let dict = ref;
 try {
  if (L.PDFRef && dict instanceof L.PDFRef) dict = context.lookup(dict);
 } catch {
  return null;
 }
 if (!(dict instanceof L.PDFDict)) return null;
 const subtype = String(dict.get(L.PDFName.of('Subtype'))?.toString?.() || '').replace(/^\//, '');
 const baseFont = dict.get(L.PDFName.of('BaseFont'))?.toString?.() || '';
 const toUnicode = streamText(dict.get(L.PDFName.of('ToUnicode')), context, L);
 const codes = parseToUnicode(toUnicode);
 const descendantRef = dict.lookupMaybe(L.PDFName.of('DescendantFonts'), L.PDFArray)?.get?.(0);
 const {widths, defaultWidth} = parseCidWidths(descendantRef, context, L);
 return {ref, subtype, baseFont, codes, widths, defaultWidth, composite: subtype === 'Type0'};
}

/**
 * Encode text with the codes of an existing font dictionary. Character spacing
 * is written as Tc by the caller; word spacing needs a TJ offset because a
 * 2-byte CID font has no single-byte code 32 for Tw to act on.
 */
export function documentFontEncoder(font, {wordSpacing = 0} = {}) {
 if (!font) throw new Error('The document font could not be read.');
 return (text, size) => {
  const chars = Array.from(String(text ?? '').replace(/[\r\n]/g, ''));
  const missing = chars.filter(char => char !== ' ' && !font.codes.has(char));
  if (missing.length) {
   throw new Error(`This PDF's embedded font has no character mapping for ${[...new Set(missing)].map(char => JSON.stringify(char)).join(' ')}. Load the full TTF/OTF to add those characters.`);
  }
  const space = font.codes.get(' ');
  const spaceCode = space?.code || '0020';
  const spaceAdvance = (space ? font.widths.get(space.code) : undefined) ?? font.defaultWidth;
  const pieces = [];
  let width = 0, pendingGap = 0;
  const flushGap = () => {
   if (!pendingGap) return;
   pieces.push(String(-Math.round(pendingGap)));
   pendingGap = 0;
  };
  for (const char of chars) {
   if (char === ' ') {
    pieces.push(`<${spaceCode}>`);
    width += spaceAdvance / 1000 * size;
    // The space glyph already advances; only the extra word spacing is written
    // as a TJ offset (a negative number moves the pen forward).
    pendingGap += wordSpacing * 1000;
    continue;
   }
   const entry = font.codes.get(char);
   flushGap();
   pieces.push(`<${entry.code}>`);
   width += ((font.widths.get(entry.code) ?? font.defaultWidth) / 1000) * size;
  }
  flushGap();
  const show = pieces.length ? `[${pieces.join(' ')}] TJ` : '<> Tj';
  return {hex: '', show, width, count: chars.length};
 };
}
