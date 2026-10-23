import {signatureProtectionForDocument} from './native-export.mjs';
import {applyFileId} from './file-id.mjs';
function binary(bytes){let result='';for(let i=0;i<bytes.length;i+=8192)result+=String.fromCharCode(...bytes.subarray(i,i+8192));return result;}
export async function fingerprints(bytes){const hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');const [sha256,sha512]=await Promise.all([crypto.subtle.digest('SHA-256',bytes),crypto.subtle.digest('SHA-512',bytes)]);return {bytes:bytes.length,sha256:hex(sha256),sha512:hex(sha512)};}
export function readCertificate(bytes,password,F,now=new Date()){
 if(bytes.length>4*1024*1024)throw new Error('Certificate file exceeds 4 MB.');
 let p12;try{p12=F.pkcs12.pkcs12FromAsn1(F.asn1.fromDer(binary(bytes)),false,password);}catch{throw new Error('Could not unlock this PFX/P12. Check its password and use a supported RSA certificate.');}
 const o=F.pki.oids,keys=[...(p12.getBags({bagType:o.pkcs8ShroudedKeyBag})[o.pkcs8ShroudedKeyBag]||[]),...(p12.getBags({bagType:o.keyBag})[o.keyBag]||[])].map(b=>b.key).filter(Boolean);
 const certs=(p12.getBags({bagType:o.certBag})[o.certBag]||[]).map(b=>b.cert).filter(Boolean);
 const matches=[];for(const key of keys)for(const cert of certs)if(key.n&&cert.publicKey.n&&key.n.equals(cert.publicKey.n)&&key.e.equals(cert.publicKey.e))matches.push({key,cert});
 if(matches.length!==1)throw new Error('Use a PFX/P12 containing exactly one matching RSA signing key and certificate.');
 const {key,cert}=matches[0];if(key.n.bitLength()<2048)throw new Error('Use an RSA signing key of at least 2048 bits.');
 if(now<cert.validity.notBefore||now>cert.validity.notAfter)throw new Error('This signing certificate is not currently within its validity dates.');
 const ku=cert.getExtension('keyUsage');if(ku&&!ku.digitalSignature&&!ku.nonRepudiation)throw new Error('This certificate does not permit digital signatures.');
 const name=cert.subject.getField('CN')?.value||cert.subject.attributes.map(a=>a.value).join(', ');
 const issuer=cert.issuer.getField('CN')?.value||cert.issuer.attributes.map(a=>a.value).join(', ');
 if(name.length>256||issuer.length>256||cert.serialNumber.length>128)throw new Error('Certificate identity exceeds supported display limits.');
 const der=F.asn1.toDer(F.pki.certificateToAsn1(cert)).getBytes();const fingerprint=F.md.sha256.create().update(der).digest().toHex();
 return {key,cert,certs,info:{name,issuer,serial:cert.serialNumber,validFrom:cert.validity.notBefore.toISOString(),validTo:cert.validity.notAfter.toISOString(),fingerprint,algorithm:'RSA / SHA-256'}};
}
function printable(s){return String(s).replace(/[^\x20-\x7e]/g,'?');}
export async function signPdfCopy({bytes,sourceBytes,credential,PDFLib:L,forge:F,now=new Date(),fileId=null}){
 const d=await L.PDFDocument.load(bytes.slice(),{updateMetadata:false});
 if(fileId)applyFileId(d,fileId,L);
 if(signatureProtectionForDocument(d,L).locked)throw new Error('Existing signed PDFs are protected. Use an unsigned editing copy authorized by the issuer.');
 if(now<credential.cert.validity.notBefore||now>credential.cert.validity.notAfter)throw new Error('The certificate is outside its validity dates.');
 const source=await fingerprints(sourceBytes),info=credential.info;
 const page=d.addPage([595.28,841.89]),font=await d.embedFont(L.StandardFonts.Helvetica),bold=await d.embedFont(L.StandardFonts.HelveticaBold);let y=785;
 function lines(text,size=10,b=false){const width=490;let line='';for(const word of printable(text).split(' ')){if(font.widthOfTextAtSize(line+word,size)>width&&line){page.drawText(line,{x:52,y,size,font:b?bold:font});y-=size+6;line='';}if(font.widthOfTextAtSize(word,size)>width){for(let i=0;i<word.length;i+=64){page.drawText(word.slice(i,i+64),{x:52,y,size,font:b?bold:font});y-=size+6;}}else line+=word+' ';}if(line){page.drawText(line,{x:52,y,size,font:b?bold:font});y-=size+6;}y-=7;}
 lines('SIGNING RECORD',20,true);lines('New signed copy',14,true);lines('Signed by: '+info.name);lines('Certificate issuer: '+info.issuer);lines('Certificate serial: '+info.serial);lines('Certificate SHA-256: '+info.fingerprint);lines('Signing time (device clock): '+now.toISOString());lines('Source file SHA-256: '+source.sha256);lines('Source file SHA-512: '+source.sha512);lines('This copy was signed with a user-provided certificate. It does not restore or represent an earlier issuer signature.');lines('Certificate trust and revocation status have not been checked. No trusted timestamp is included.');
 const sig=d.context.obj({Type:'Sig',Filter:'Adobe.PPKLite',SubFilter:'adbe.pkcs7.detached',ByteRange:[0,9999999999,9999999999,9999999999],Contents:L.PDFHexString.of('0'.repeat(32768)),Name:L.PDFString.of(printable(info.name)),Reason:L.PDFString.of('New signed copy; see Signing Record page'),M:L.PDFString.fromDate(now)});
 const sigRef=d.context.register(sig);const widget=d.context.obj({Type:'Annot',Subtype:'Widget',FT:'Sig',Rect:[0,0,0,0],V:sigRef,T:L.PDFString.of('PDF Studio authorized signer'),F:132,P:page.ref});const widgetRef=d.context.register(widget);page.node.addAnnot(widgetRef);
 let form=d.catalog.lookupMaybe(L.PDFName.of('AcroForm'),L.PDFDict);if(!form){form=d.context.obj({Fields:[]});d.catalog.set(L.PDFName.of('AcroForm'),d.context.register(form));}let fields=form.lookupMaybe(L.PDFName.of('Fields'),L.PDFArray);if(!fields){fields=d.context.obj([]);form.set(L.PDFName.of('Fields'),fields);}fields.push(widgetRef);form.set(L.PDFName.of('SigFlags'),L.PDFNumber.of(3));
 const out=await d.save({useObjectStreams:false,addDefaultPage:false});const raw=binary(out),marker='/ByteRange [ 0 9999999999 9999999999 9999999999 ]',at=raw.indexOf(marker);if(at<0||raw.indexOf(marker,at+1)>=0)throw new Error('Could not safely locate signature placeholder.');
 const contentsAt=raw.indexOf('/Contents <'+'0'.repeat(64),at);if(contentsAt<0)throw new Error('Missing signature contents placeholder.');const start=contentsAt+'/Contents '.length,end=start+32768+2;
 if(raw[end-1]!=='>')throw new Error('Unexpected signature placeholder size.');const range=`/ByteRange [ 0 ${start} ${end} ${out.length-end} ]`;if(range.length>marker.length)throw new Error('PDF exceeds signing range capacity.');out.set(new TextEncoder().encode(range.padEnd(marker.length,' ')),at);
 const signed=new Uint8Array(start+out.length-end);signed.set(out.subarray(0,start));signed.set(out.subarray(end),start);
 const p7=F.pkcs7.createSignedData();p7.content=F.util.createBuffer(binary(signed));for(const cert of credential.certs)p7.addCertificate(cert);p7.addSigner({key:credential.key,certificate:credential.cert,digestAlgorithm:F.pki.oids.sha256,authenticatedAttributes:[{type:F.pki.oids.contentType,value:F.pki.oids.data},{type:F.pki.oids.messageDigest},{type:F.pki.oids.signingTime,value:now}]});p7.sign({detached:true});const signature=F.util.bytesToHex(F.asn1.toDer(p7.toAsn1()).getBytes());if(signature.length>32768)throw new Error('Certificate chain exceeds the signature container capacity.');out.set(new TextEncoder().encode(signature.padEnd(32768,'0')),start+1);return {bytes:out,fingerprints:await fingerprints(out),signer:info,source};
}
