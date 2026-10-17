# PDF Studio

Browser-local PDF text editing with continuous scrolling, native-text export, source metadata inspection and optional replacement, fixed-decimal alignment, per-text X/Y position locks, SHA-256/SHA-512 fingerprints, and authorized RSA PFX/P12 signing.

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

## Source metadata

After opening a PDF, click **Metadata** to inspect and download a JSON record of its native PDF Info fields (including custom fields) and XMP XML, when available. Calculated PDF.js document properties are not shown as Info metadata. Without a replacement upload, an edited native export preserves the source PDF's Info dictionary and XMP stream and embeds `pdf-studio-source-metadata.json` as a provenance attachment. An unchanged download remains byte-for-byte original.

To **replace the PDF's native metadata**, choose a UTF-8 `.json` file (up to 8 MB) in the Metadata dialog. You can use the JSON downloaded from this app, a flat object such as `{"Title":"New title","Author":"Name","Custom":{"Project":"123"}}`, or `{"info":{"Title":"New title"},"xmp":{"raw":"<x:xmpmeta ...>...</x:xmpmeta>"}}` with valid XMP XML. The supplied Info fields replace the entire old document Info dictionary; fields not included are removed. The supplied `xmp.raw` replaces the catalog XMP stream; if absent, that XMP entry is removed. This is not secure redaction of old values copied elsewhere in the PDF (such as page-level metadata or existing attachments). Standard text fields, PDF dates, Trapped, and scalar custom Info fields are supported. PDF.js-derived properties (page count, PDF version, encryption, signatures, etc.) are not writable metadata; they are ignored in an app-generated report or rejected in other files. Unsupported values are rejected rather than silently inserted. The source provenance attachment and uploaded JSON are **not** newly attached when overriding metadata.

The replacement is kept in browser memory for the current document, can be removed before export, and is cleared when another PDF opens. Even with no text edits, replacing metadata rewrites the PDF and changes its size and hashes. This is descriptive metadata, **not** a digital signature or proof of issuer identity. Signed, encrypted, or uninspectable PDFs remain view-only and cannot be rewritten. This step does not add decryption/re-encryption or certificate extraction.

Run the metadata/export regression tests with `node --test tests/*.test.mjs` (Node.js required only for tests).

## Protection and signing

Signed, encrypted, and uninspectable PDFs remain view-only. Existing signatures are detected structurally, not validated cryptographically by the viewer. Original download remains unchanged.

New signed copies use an authorized user-provided RSA 2048+ PFX/P12 certificate and include a signing record page. Certificates/passwords are processed in browser memory, not uploaded. Expiry, key matching, and declared key usage are checked. Certificate trust, revocation, and trusted timestamps are not checked. This does not restore an issuer signature after changes. SHA-256/SHA-512 identify exact file bytes, not issuer identity.

## Source layout

- `dist/app.mjs`: UI, editing, page rendering and export orchestration.
- `dist/native-export.mjs`: native PDF text replacement and signature protection.
- `dist/positioning.mjs`: axis-lock helpers.
- `dist/metadata.mjs`: source metadata report, Info/XMP replacement or preservation, and optional provenance attachment.
- `dist/font-identity.mjs`: Arial/Helvetica family, style and subset-name recognition.
- `dist/signing.mjs`: PFX/P12 handling, signed-copy creation and fingerprints.
- `dist/vendor/`: bundled PDF.js, pdf-lib, fontkit, Forge and supporting assets.

Third-party assets retain their bundled notices/licenses. This repository does not include user PDFs, credentials, signing certificates, temporary test keys, or hosting authentication.
