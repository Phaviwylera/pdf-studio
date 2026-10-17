# PDF Studio

Browser-local PDF text editing with continuous scrolling, native-text export with an optional AES-256 password-protected copy, password-protected PDF decryption in WebAssembly, source metadata inspection and optional replacement, standalone AES-256 PDF encryption with optional JSON-based native metadata replacement, fixed-decimal alignment, per-text X/Y position locks, SHA-256/SHA-512 fingerprints, and authorized RSA PFX/P12 signing.

Live app: https://pdf-studio.phavithiranofficial.chatgpt.site

## Run

Windows: double-click `START.cmd`. Keep the console open; close it to stop. Windows PowerShell is required. Organization script policies may block it. The launcher was packaged on Linux and has not been executed on Windows.

Any platform with Python 3:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:8765/. Do not open index.html directly: JavaScript modules and PDF workers require a local web server. All runtime dependencies are bundled; no build step or npm installation is required.

## Editing

Click text to type in place. Enter commits; Shift+Enter inserts a line; Escape cancels. Drag the move handle or use arrow keys. Alignment, Apply changes, exact coordinates, Lock X anchor, and Lock Y baseline are together in the sticky inspector header. Position locks are per text block, last for the current open document session, and are not embedded as PDF permissions.

No-change downloads preserve the original bytes unless a metadata replacement JSON is selected. Native exports preserve selectable edited text and existing artwork where the source structure supports safe replacement. Font matching and replacement are not universal; review exported documents.

### Export options

**Export PDF** on an editable document opens an export choice. **Regular export** downloads the normal native PDF. **AES-256 password-protected export** first creates that same native export — including applied edits and any loaded metadata replacement — and then passes exactly those bytes to the existing `encryptPdfCopy` function. The protected result downloads with `-encrypted.pdf` in its name (for example `statement-edited-encrypted.pdf`).

Encryption asks for an open password and a matching confirmation, each at least 8 characters, plus an optional owner password (at least 8 characters and different from the open password; blank uses the open password). Everything runs in this browser: passwords are not uploaded, logged or persisted, are used only for that export, and the password fields are cleared after the attempt and whenever the dialog closes. Lost passwords cannot be recovered.

Signed and view-only documents bypass the export choice: **Export PDF** (shown as **Download original**) downloads the exact uploaded bytes unchanged. **Hash original** also keeps fingerprinting the exact uploaded bytes, even when a password-protected document has been unlocked into an editable working copy. The standalone **Encrypt PDF** action remains independent of the open document and of this export choice.

### Typography consistency

The preview, the in-place editor and native export share one typography model, so an edit never picks up a fraction of a point or a different rendering style between stages:

- Font size, X/Y baseline, letter spacing, word spacing, stroke weight and line height are PDF points, normalized to 0.001 pt. The controls show the normalized value that is actually used.
- Text advances are PDF glyph advances. Browser kerning and ligatures are deliberately disabled in the preview and the editing box because the PDF export writes glyph-by-glyph advances; enabling them in only one stage would change widths and positions.
- Letter spacing is PDF `Tc`, word spacing is `Tw`, and both are applied to the same glyphs in the preview and the exported content stream.
- The source text rendering mode (`Tr`) is preserved: fill, stroke, or fill + stroke. Stroke color and line width (`w`) are captured and re-exported, and stroke-only text is not silently filled.
- Text rise (`Ts`) is folded into the captured baseline, so superscripts and raised labels keep their baseline instead of jumping to the unraised line.
- Multi-line line height is the same multiplier in both stages. The in-place editor and its selection overlay place the first baseline from the actual font metrics of the same CSS line box, not from a fixed fraction of the font size.
- Original horizontal scaling is captured once as a horizontal text scale. Stroke weight is compensated for that scale in the preview so it matches the exported `w` value in page points.
- The text color control is the fill color. For stroke-only text it shows and edits the stroke color instead, so the visible color never sits in a hidden channel; fill + stroke text keeps its separately captured stroke color. Underlines follow the visible paint channel.

If a text block mixes paint modes, stroke weights, colors, spacing or text rise between its text-show operators, it is treated as inspection-only rather than exporting a guessed style. Complex-script shaping is outside this model.

### Original fonts

When a PDF embeds a font program, the editor registers that program for the document and uses it for the live preview, the in-place text box, and export, so typed capitals, digits and other characters render in the PDF's own typeface instead of the browser fallback. Coverage is checked against the whole embedded font, not only the glyphs observed on the page you are editing: a character that appears in a heading on page 3 is available when editing page 1 of the same document.

Most PDF producers embed only a **subset** of the font — the glyphs actually used somewhere in that document. Characters that are absent from the subset cannot be drawn with the original font; the editor then names the missing characters and uses a substitute for the edit (or a loaded TTF/OTF) rather than exporting blank glyphs. To recover those characters, load the full TTF/OTF in **Available font → Load font file** and choose **Best font match**. Standard PDF fonts without an embedded program (Helvetica, Times, Courier) use the bundled standard-font program that PDF.js loads (Liberation in this build) for typed text, with family substitutes only when a character is absent.

## Source metadata

After opening a PDF, click **Metadata** to inspect and download a JSON record of its native PDF Info fields (including custom fields) and XMP XML, when available. Calculated PDF.js document properties are not shown as Info metadata. Without a replacement upload, an edited native export preserves the source PDF's Info dictionary and XMP stream and embeds `pdf-studio-source-metadata.json` as a provenance attachment. An unchanged download remains byte-for-byte original.

To **replace the PDF's native metadata**, choose a UTF-8 `.json` file (up to 8 MB) in the Metadata dialog. You can use the JSON downloaded from this app, a flat object such as `{"Title":"New title","Author":"Name","Custom":{"Project":"123"}}`, or `{"info":{"Title":"New title"},"xmp":{"raw":"<x:xmpmeta ...>...</x:xmpmeta>"}}` with valid XMP XML. The supplied Info fields replace the entire old document Info dictionary; fields not included are removed. The supplied `xmp.raw` replaces the catalog XMP stream; if absent, that XMP entry is removed. This is not secure redaction of old values copied elsewhere in the PDF (such as page-level metadata or existing attachments). Standard text fields, PDF dates, Trapped, and scalar custom Info fields are supported. Text fields also accept a list of names, which is joined into one string. A downloader **sidecar file report** is also accepted:

```json
{
  "file": {"name": "statement.pdf", "sizeBytes": 583255, "hashes": {"SHA-1": "…", "SHA-256": "…"}},
  "metadata": {"version": "1.4", "pages": 15, "encrypted": true, "Producer": "openhtmltopdf.com", "CreationDate": "D:20261017110332+05'30'", "decrypted": true}
}
```

Its mapping is: `metadata` keys that name standard PDF fields (`Title`, `Author`, `Subject`, `Keywords`, `Creator`, `Producer`, `CreationDate`, `ModDate`, `Trapped`) become those native Info fields; `metadata.version`, `pages`, `encrypted` and `decrypted` become the custom fields `SourcePDFVersion`, `SourcePageCount`, `SourceEncrypted` and `SourceDecrypted`; `file.name` and `file.sizeBytes` become `SourceFilename` and `SourceFileSizeBytes`; each `file.hashes` entry becomes `SourceSHA1`, `SourceSHA256`, `SourceSHA384`, `SourceSHA512`, etc.; other scalar `file` values become `Source<Key>`. Optional top-level `xmp` works as above. In a flat object, every top-level key except `xmp`/`XMP` and `Custom` is treated as an Info field. Other nested objects and arrays have no native PDF Info representation: the error names the exact JSON field and received type, and an encryption attempt offers **Encrypt without metadata** instead of silently dropping values. PDF.js-derived properties (page count, PDF version, encryption, signatures, etc.) are not writable metadata; they are ignored in an app-generated report or rejected in other files. Unsupported values are rejected rather than silently inserted. The source provenance attachment and uploaded JSON are **not** newly attached when overriding metadata.

After a successful upload, the Metadata dialog keeps the selected filename visible and confirms that the replacement is loaded for export. The replacement is kept in browser memory for the current document, can be removed before export, and is cleared when another PDF opens. Even with no text edits, replacing metadata rewrites the PDF and changes its size and hashes. This is descriptive metadata, **not** a digital signature or proof of issuer identity. Signed or uninspectable PDFs remain view-only in the editor. Password-protected PDFs can be opened with their password and are decrypted to an editable working copy in-browser with qpdf compiled to WebAssembly. The uploaded bytes are never modified. If qpdf cannot safely decrypt a PDF, it stays view-only. This metadata-replacement flow does not extract certificates.

## Encrypt a PDF

Use **Encrypt PDF** for a standalone password-protection flow; it does not depend on which document is open in the editor. Choose an unencrypted PDF, enter and confirm an open password (at least 8 characters), and optionally set a separate owner password. The tool creates a PDF-standard AES-256 encrypted copy locally in the browser. Use HTTPS or localhost; the original file is not changed. Already-encrypted and digitally signed PDFs are refused rather than rewritten.

Optionally choose a UTF-8 `.json` metadata file (up to 8 MB) to **replace the PDF's native Info/XMP metadata** before encryption. The dialog accepts the metadata JSON downloaded from this app, a flat object such as `{"Title":"New title","Author":"Name","Custom":{"Project":"123"}}`, or `{"info":{"Title":"New title"},"xmp":{"raw":"<x:xmpmeta ...>...</x:xmpmeta>"}}` with valid XMP XML. When supplied, only the JSON's Info fields become the PDF's Info dictionary; fields not included are removed, and missing XMP is removed. The JSON file itself is **not** attached to the encrypted PDF. Leave the file empty to retain the source PDF's existing native Info/XMP metadata unchanged. Info values must be text, a number, a boolean or a PDF name object such as `{"name":"False"}`; lists are joined for the standard text fields. Nested objects and arrays have no native PDF Info representation, so a rejected file reports the exact field and type. A file/fingerprint report such as `{"file":{"name":"…","sizeBytes":123,"hashes":{…}},"metadata":{"version":"1.7","pages":3}}` is recognised as structural report data rather than metadata. In either case a dialog offers **Encrypt without the JSON**, so encryption still proceeds with the PDF's existing native metadata instead of stopping. PDF structure properties (page count, PDF version, encryption, signatures, etc.) cannot be set from JSON. This is descriptive metadata, not secure redaction of values copied elsewhere in the PDF, and it is not a digital signature. Passwords are used only for this operation, are not stored or sent, and cannot be recovered if lost. PDF permission flags are not used as a substitute for the open password.

Downloads use a blob link appended to the page. After any download the app shows a **Download ready** panel with the filename, size, a **Save again** link, an **Open file** link, and — inside an embedded preview — **Open app in new tab**. Embedded preview frames can block automatic downloads even when the file was created successfully; use that panel or open the app in its own tab and retry there.

Run metadata, typography, export-choice, encryption, decryption, and fingerprint regression tests with `node --test tests/*.test.mjs` (Node.js required only for tests). Typography tests cover 0.001 pt normalization, glyph-advance layout without kerning, word/letter spacing, paint modes, stroke weight and baseline placement. Syntax-check the runtime and test modules with `node --check dist/*.mjs` and `node --check tests/*.mjs` before running the suite.

## Protection and signing

In the editor, signed and uninspectable PDFs remain view-only. A password-protected PDF is decrypted only after its password is accepted, using qpdf/WASM in the browser; the unlocked working copy can then be edited and exported (including as a newly AES-256 encrypted copy). The exact uploaded bytes remain available unchanged: locked/signed downloads and **Hash original** use those bytes. Wrong or cancelled passwords, or a PDF that qpdf cannot safely decrypt, do not unlock editing and show a clear view-only message. Signed PDFs stay protected even if a password is known. The standalone Encrypt PDF action accepts only unencrypted, unsigned sources. Existing signatures are detected structurally, not validated cryptographically by the viewer.

New signed copies use an authorized user-provided RSA 2048+ PFX/P12 certificate and include a signing record page. Certificates/passwords are processed in browser memory, not uploaded. Expiry, key matching, and declared key usage are checked. Certificate trust, revocation, and trusted timestamps are not checked. This does not restore an issuer signature after changes. SHA-256/SHA-512 identify exact file bytes, not issuer identity.

## Source layout

- `dist/app.mjs`: UI, editing, page rendering and export orchestration.
- `dist/native-export.mjs`: native PDF text replacement and signature protection.
- `dist/encrypt.mjs`: standalone AES-256 PDF encryption with optional JSON-based native Info/XMP replacement.
- `dist/export-encryption.mjs`: editor export password rules, encrypted download naming, and the native-export-to-`encryptPdfCopy` handoff.
- `dist/decrypt.mjs`: browser-only decryption of password-protected PDFs with bundled qpdf/WASM.
- `dist/vendor/qpdf/`: qpdf 11.0.0 WebAssembly runtime and Apache-2.0 license.
- `dist/typography.mjs`: the shared typography model (0.001 pt measures, glyph advances, spacing, paint modes, stroke weight and baseline placement).
- `dist/positioning.mjs`: axis-lock helpers.
- `dist/metadata.mjs`: source metadata report, Info/XMP replacement or preservation, and optional provenance attachment.
- `dist/font-identity.mjs`: Arial/Helvetica family, style and subset-name recognition.
- `dist/font-coverage.mjs`: embedded-font character coverage, missing-glyph reporting and mixed font-run selection for canvas previews.
- `dist/signing.mjs`: PFX/P12 handling, signed-copy creation and fingerprints.
- `dist/vendor/`: bundled PDF.js, pdf-lib, fontkit, Forge and supporting assets, plus `pdf-encrypt/` (@pdfsmaller/pdf-encrypt 1.2.0, MIT) for AES-256 PDF security and `qpdf/` (qpdf 11.0.0, Apache-2.0) for in-browser decryption.

Third-party assets retain their bundled notices/licenses. This repository does not include user PDFs, credentials, signing certificates, temporary test keys, or hosting authentication.
