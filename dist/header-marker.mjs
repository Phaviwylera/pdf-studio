// Header marker bookkeeping.
//
// pdf-lib writes its own binary marker directly after the version line:
//
//   %PDF-1.7
//   %<81><81><81><81>      four 0x81 bytes, written by this library and nobody else
//
// A file produced by Apache PDFBox (what writes openhtmltopdf.com documents)
// carries "%<E2><E3><CF><D3>" there instead, and a file with no marker carries
// none. So a checker that reads the bytes after the header can tell which
// program saved the file last, however truthful the /Info dictionary is about
// the generator. Every rewrite this app performs — a text edit, a metadata
// change, an encryption, a file-id repair — has to leave that line as the
// opened document had it.
//
// Alignment is always length-preserving. A saved PDF addresses its objects by
// absolute byte offset, so adding or removing a byte before the first object
// would invalidate every cross-reference entry and damage the file it was
// meant to make look untouched.

export const LIBRARY_MARKER = Uint8Array.from([0x25, 0x81, 0x81, 0x81, 0x81]);

/** The comment line after the version line, newline excluded, or {end, marker: null}. */
export function headerMarker(bytes) {
 const end = bytes.indexOf(0x0a);
 if (end < 0 || bytes[0] !== 0x25) return {end, marker: null};
 const start = end + 1;
 if (bytes[start] !== 0x25) return {end, marker: null};
 let stop = start;
 while (stop < bytes.length && bytes[stop] !== 0x0a) stop++;
 return {end, marker: bytes.slice(start, stop)};
}

export function isLibraryMarker(marker) {
 return !!marker && marker.length === LIBRARY_MARKER.length && marker.every((byte, index) => byte === LIBRARY_MARKER[index]);
}

/**
 * Replace pdf-lib's marker with the one the opened document carried. A file
 * that had no marker keeps a plain "%" comment of the same length rather than
 * gaining a claim it never made; a marker too long to fit is not invented
 * either. Bytes, and therefore every offset below them, are never moved.
 */
export function alignHeader(bytes, original) {
 const {end, marker} = headerMarker(bytes);
 if (end < 0 || !marker) return bytes;
 if (!isLibraryMarker(marker)) return bytes;
 const wanted = headerMarker(original).marker;
 // Same marker already: nothing to align, and nothing to gain by rewriting it.
 if (wanted && isLibraryMarker(wanted)) return bytes;
 const out = bytes.slice();
 const start = end + 1;
 if (wanted && wanted.length <= marker.length) {
  out.set(wanted, start);
  out.fill(0x20, start + wanted.length, start + marker.length);
  return out;
 }
 out.fill(0x20, start + 1, start + marker.length);
 return out;
}
