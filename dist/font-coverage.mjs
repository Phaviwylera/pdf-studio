// Original-font coverage helpers. The editor uses these to decide whether the
// PDF's own font program can render an edit, instead of looking only at glyphs
// observed on one page.

const escapeChar = char => {
 const code = char.codePointAt(0);
 if (code < 0x20 || code === 0x7f || code === 0xa0) return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
 return char;
};

export function describeMissing(chars, limit = 10) {
 const unique = [...new Set(chars)];
 const shown = unique.slice(0, limit).map(escapeChar);
 return shown.join(' ') + (unique.length > limit ? ` and ${unique.length - limit} more` : '');
}

// Encode text for the font-face glyph map that PDF.js assigns to each page.
// Spaces keep their literal code point, matching the original font's space.
export function glyphMapEncode(glyphMap, text) {
 if (!glyphMap) return null;
 let encoded = '';
 for (const char of Array.from(String(text ?? ''))) {
  if (char === '\n' || char === '\r') continue;
  if (char === ' ') { encoded += ' '; continue; }
  const mapped = glyphMap.get(char);
  if (!mapped) return null;
  encoded += mapped;
 }
 return encoded;
}

export function parsedHasGlyph(parsed, char) {
 if (!parsed || typeof parsed.hasGlyphForCodePoint !== 'function') return false;
 const codePoint = char.codePointAt(0);
 if (codePoint === undefined) return false;
 try { return !!parsed.hasGlyphForCodePoint(codePoint); } catch { return false; }
}

// Characters that the PDF font cannot draw. The font program (when available)
// covers every glyph embedded in the document, including glyphs that were only
// used on a different page. The observed glyph map remains a fallback for fonts
// without an embedded program (standard PDF fonts and repaired fonts).
export function missingOriginalGlyphs({glyphMap, parsed} = {}, text) {
 const missing = [];
 for (const char of new Set(Array.from(String(text ?? '')))) {
  if (char === '\n' || char === '\r' || char === ' ' || char === '\t') continue;
  if (glyphMap?.has(char)) continue;
  if (parsedHasGlyph(parsed, char)) continue;
  missing.push(char);
 }
 return missing;
}

export function originalFontCoverage(block, text) {
 const missing = missingOriginalGlyphs(block, text);
 return {ok: missing.length === 0, missing, encoded: missing.length ? null : glyphMapEncode(block?.glyphMap, text)};
}

// Split a line into canvas font runs. Preferred order per character:
// 1. the embedded font program with its real Unicode mapping,
// 2. the page-observed private-use glyph mapping,
// 3. the fallback family.
// Mixed runs keep the original font for supported characters instead of
// silently replacing the whole line because of one unsupported character.
export function lineFontRuns(block, text, {fallbackCss, programCss, privateCss}) {
 const runs = [];
 const push = (value, css) => {
  if (!value) return;
  const last = runs[runs.length - 1];
  if (last && last.css === css) last.text += value;
  else runs.push({text: value, css});
 };
 for (const char of Array.from(String(text ?? ''))) {
  if (char === '\n' || char === '\r') continue;
  if (char === ' ') {
   if (programCss && parsedHasGlyph(block?.parsed, char)) push(char, programCss);
   else if (privateCss) push(char, privateCss);
   else push(char, fallbackCss);
   continue;
  }
  if (programCss && parsedHasGlyph(block?.parsed, char)) { push(char, programCss); continue; }
  const mapped = block?.glyphMap?.get(char);
  if (mapped && privateCss) { push(mapped, privateCss); continue; }
  push(char, fallbackCss);
 }
 if (!runs.length) runs.push({text: '', css: fallbackCss});
 return runs;
}
