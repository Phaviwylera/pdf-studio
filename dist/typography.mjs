// Canonical typography rules shared by the live preview, the in-place editor
// and native PDF export. All distances are PDF points. Values are normalized to
// 0.001 pt so floating-point noise never reaches the controls or the export.
//
// PDF text advances are glyph advances: the viewer adds the glyph width and the
// character/word spacing values. Browser text layout would additionally apply
// kerning and ligatures, which the PDF export cannot reproduce. The editor
// therefore measures and draws one glyph at a time with kerning disabled, so the
// preview, the editing box and the exported PDF use exactly the same advances.

export const MEASURE_DECIMALS = 3;

export function normalizeMeasure(value, decimals = MEASURE_DECIMALS) {
 const number = Number(value);
 if (!Number.isFinite(number)) return 0;
 const factor = 10 ** decimals;
 const normalized = Math.round(number * factor) / factor;
 return Object.is(normalized, -0) ? 0 : normalized;
}

export function formatMeasure(value, decimals = MEASURE_DECIMALS) {
 return String(normalizeMeasure(value, decimals));
}

// PDF text rendering mode: 0 fill, 1 stroke, 2 fill + stroke. Modes 3+ paint
// nothing or only a clip and are not editable.
export function textPaintMode(mode) {
 const value = Number(mode) || 0;
 if (value === 0) return {fill: true, stroke: false};
 if (value === 1) return {fill: false, stroke: true};
 if (value === 2) return {fill: true, stroke: true};
 return null;
}

// Canvas lineWidth is transformed by the current matrix. Divide by the text's
// horizontal scale so the preview stroke weight matches the exported `w` value
// in page points. A zero PDF line width is a hairline: one output pixel.
export function canvasStrokeWidth(lineWidth, scaleX = 1, deviceScale = 1) {
 const width = Number(lineWidth);
 const horizontal = Math.abs(Number(scaleX)) || 1;
 const device = Math.abs(Number(deviceScale)) || 1;
 const points = Number.isFinite(width) && width > 0 ? width : 1 / device;
 return points / horizontal;
}

// Lay a line out glyph by glyph with PDF spacing semantics. `measure(char)` is
// the glyph advance in points. Character spacing is added between glyphs; word
// spacing is added to the space glyph's advance. Returns each glyph's offset
// from the line start and the total advance width.
export function glyphLayout({text, spacing = 0, wordSpacing = 0, measure}) {
 const glyphs = [];
 let width = 0;
 let count = 0;
 for (const char of Array.from(String(text ?? ''))) {
  if (count > 0) width += Number(spacing) || 0;
  glyphs.push({char, offset: width});
  width += measure(char);
  if (char === ' ') width += Number(wordSpacing) || 0;
  count++;
 }
 return {glyphs, width, count};
}

// Baseline offset inside a CSS line box with the same line height. Used by the
// in-place editor and its selection overlay, which otherwise approximated the
// baseline with a fixed fraction of the font size.
export function baselineOffsetFor(ctx, {fontSize, lineHeight = 1.2} = {}) {
 const size = Number(fontSize) || 0;
 const metrics = ctx.measureText('Mg');
 const ascent = Number.isFinite(metrics.fontBoundingBoxAscent) && metrics.fontBoundingBoxAscent > 0
  ? metrics.fontBoundingBoxAscent
  : Number.isFinite(metrics.actualBoundingBoxAscent) && metrics.actualBoundingBoxAscent > 0
   ? metrics.actualBoundingBoxAscent
   : size * 0.8;
 const descent = Number.isFinite(metrics.fontBoundingBoxDescent) && metrics.fontBoundingBoxDescent > 0
  ? metrics.fontBoundingBoxDescent
  : Number.isFinite(metrics.actualBoundingBoxDescent) && metrics.actualBoundingBoxDescent > 0
   ? metrics.actualBoundingBoxDescent
   : size * 0.2;
 return (size * Number(lineHeight || 1.2) - ascent - descent) / 2 + ascent;
}

export function sameMeasure(a, b, epsilon = 1e-6) {
 return Math.abs((Number(a) || 0) - (Number(b) || 0)) < epsilon;
}

// A block can only be replaced as one style when every text-show operator in
// the block agrees on paint mode, stroke weight/color, spacing and baseline.
export function sameTextState(states) {
 if (!Array.isArray(states) || !states.length) return false;
 const first = states[0];
 const paint = textPaintMode(first.mode);
 if (!paint) return false;
 return states.every(state => {
  if (Number(state.mode) !== Number(first.mode)) return false;
  if (!paintStateUsable(state)) return false;
  if (!sameMeasure(state.fontSize, first.fontSize)) return false;
  if (!sameMeasure(state.charSpacing, first.charSpacing)) return false;
  if (!sameMeasure(state.wordSpacing, first.wordSpacing)) return false;
  if (!sameMeasure(state.textRise, first.textRise)) return false;
  if (!sameMeasure(state.hScale, first.hScale)) return false;
  if (!paint.stroke) return true;
  return sameMeasure(state.lineWidth, first.lineWidth)
   && String(state.strokeColor || '').toLowerCase() === String(first.strokeColor || '').toLowerCase();
 });
}

export function paintStateUsable(state) {
 const paint = textPaintMode(state.mode);
 if (!paint) return false;
 if (paint.fill && state.fillPattern) return false;
 if (paint.stroke && state.strokePattern) return false;
 return true;
}
