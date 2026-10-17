const INPUT_PATH = '/pdf-studio-input.pdf';
const OUTPUT_PATH = '/pdf-studio-decrypted.pdf';

async function defaultQpdfFactory(options) {
 const {default: createQpdf} = await import('./vendor/qpdf/qpdf.mjs');
 return createQpdf(options);
}

function isPdf(bytes) {
 const header = new TextDecoder().decode(bytes.subarray(0, 1024));
 return header.includes('%PDF-');
}

/** Decrypt a PDF into a fresh in-memory byte array with the bundled qpdf/WASM CLI. */
export async function decryptPdfCopy({bytes, password, qpdfFactory = defaultQpdfFactory}) {
 if (!(bytes instanceof Uint8Array) || !bytes.length) {
  throw new TypeError('Choose a non-empty PDF byte array to decrypt.');
 }
 if (typeof password !== 'string') {
  throw new TypeError('A PDF password is required to decrypt this document.');
 }

 const input = bytes.slice();
 const errors = [];
 let module;
 try {
  module = await qpdfFactory({
   locateFile: name => name.endsWith('.wasm') ? new URL('./vendor/qpdf/qpdf.wasm', import.meta.url).href : name,
   stdout: () => {},
   stderr: message => errors.push(String(message)),
  });
  if (!module?.FS?.writeFile || !module?.FS?.readFile || !module?.callMain) {
   throw new Error('The qpdf WebAssembly runtime did not initialize correctly.');
  }
  module.FS.writeFile(INPUT_PATH, input);
  const exitCode = module.callMain([`--password=${password}`, '--decrypt', INPUT_PATH, OUTPUT_PATH]);
  if (exitCode !== 0) {
   throw new Error(errors.join('\n') || `qpdf exited with status ${exitCode}.`);
  }
  const output = module.FS.readFile(OUTPUT_PATH);
  if (!(output instanceof Uint8Array) || !output.length || !isPdf(output)) {
   throw new Error('qpdf did not produce a valid PDF.');
  }
  return output.slice();
 } catch (error) {
  const detail = `${errors.join('\n')} ${error?.message || ''}`;
  const passwordProblem = /password|invalid password|incorrect password|user password/i.test(detail);
  throw new Error(passwordProblem
   ? 'The password was accepted for viewing, but qpdf could not decrypt this PDF for editing.'
   : 'This PDF could not be decrypted safely for editing. It can remain open in view-only mode.');
 } finally {
  try { module?.FS?.unlink(INPUT_PATH); } catch {}
  try { module?.FS?.unlink(OUTPUT_PATH); } catch {}
  input.fill(0);
 }
}
