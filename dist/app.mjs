import {detectFontIdentity} from './font-identity.mjs';
import {originalFontCoverage, glyphMapEncode, describeMissing, lineFontRuns, parsedHasGlyph} from './font-coverage.mjs';
import {translatePosition, constrainPosition} from './positioning.mjs';
import {readCertificate, signPdfCopy, fingerprints} from './signing.mjs';
import {makeSourceMetadataRecord, metadataJson, parseUploadedMetadata, MAX_USER_METADATA_BYTES} from './metadata.mjs';
import * as pdfjs from './vendor/pdf.mjs';
import { exportNativePdf, inspectSignatureProtection, strayColumnCells, EXPORT_VERSION } from './native-export.mjs';
import { encryptPdfCopy } from './encrypt.mjs';
import { decryptPdfCopy } from './decrypt.mjs';
import { encryptExportCopy, encryptedExportName, validateExportPasswords } from './export-encryption.mjs';
import {normalizeMeasure, formatMeasure, textPaintMode, canvasStrokeWidth, glyphLayout, baselineOffsetFor, sameTextState, paintStateUsable} from './typography.mjs';
import {matchTextOperations} from './text-matching.mjs';
import {buildDocumentFontInventory, fontKey, formatFontInventory} from './font-inventory.mjs';
import {readPdfFileId, sameFileId, fileIdWarning, enforceFileId} from './file-id.mjs';
import {extractStatementRows, checkStatement, formatReport} from './statement-check.mjs';
pdfjs.GlobalWorkerOptions.workerSrc='./vendor/pdf.worker.mjs';
const $=id=>document.getElementById(id), OPS=pdfjs.OPS;
let doc=null, original=null, uploadedOriginal=null, pageNo=1, filename='', selected=null, cache=new Map(), edits=new Map(), history=[], future=[], busy=false, fontCounter=0;
let paintQueue=Promise.resolve(), generation=0, inline=null;
const loadedFonts=new Map();
const originalFonts=new Map();
const originalFontJobs=new Map();
// Document-wide font programs. Keyed by typeface identity, not by the per-page
// PDF.js font id, so a program found on page 1 can draw text on every page.
const fontProgramPool=new Map();
let fontInventory=null;
const documentFontOptions=[];
let positionLocks=new Map();
let signatureState={locked:false,signed:false,count:0,unknown:false};
let sourceMetadata=null, uploadedMetadata=null, metadataReadVersion=0, metadataLoading=false, encryptMetadataVersion=0, skippedEncryptMetadata='';
let sourceFileId=null, workingFileId=null, restoreFileId=null, restoreFileIdName='';
function signatureProtectionMessage(){if(!signatureState.unknown)return 'Digital signature detected. Editing is locked and download returns the original file unchanged. Signature validity is not verified here.';if(signatureState.reason==='decrypt')return 'The password-protected PDF opened for viewing, but its working copy could not be decrypted safely for editing. Editing stays locked; download and Hash original use the exact uploaded bytes.';if(signatureState.reason==='encrypted')return 'This PDF is encrypted. The viewer can open it, but the export engine cannot safely inspect or rewrite encrypted PDFs. It is view-only; download returns the original unchanged. Request an unsigned, unencrypted editing copy from the issuer.';if(signatureState.reason==='library')return 'The PDF inspection library did not load. Reload the page and upload the PDF again. Editing stays locked until inspection succeeds; download returns the original unchanged.';return 'The PDF structure could not be fully inspected. This does not mean a signature was detected. Editing stays locked to protect any existing signature; download returns the original unchanged. Try a fresh original PDF from the issuer.';}
function signatureLockNotice(){notice(signatureProtectionMessage())}

let pageViews=new Map(),pageObserver=null,scrollFrame=null;
function canvasForPage(n){return pageViews.get(n)?.canvas}
function layerForPage(n){return pageViews.get(n)?.layer}
function selectionPage(){return Number(selected?.split(':')[0])||pageNo}
function evictPage(view){if(view.rendering||inline?.block.page===view.n||drag?.block.page===view.n)return;view.canvas.width=view.canvas.height=1;view.rendered=false;for(const element of view.layer.querySelectorAll('.textblock,.movehandle'))element.remove();view.placeholder.hidden=false}
async function setupDocumentViews(){pageObserver?.disconnect();pageViews=new Map();$('documentpages').replaceChildren();const active=doc;for(let n=1;n<=active.numPages;n++){const pdfPage=await active.getPage(n);if(active!==doc)return;const viewport=pdfPage.getViewport({scale:1}),holder=document.createElement('section'),label=document.createElement('div'),paper=document.createElement('div'),canvas=document.createElement('canvas'),layer=document.createElement('div'),placeholder=document.createElement('div');holder.className='document-page';holder.dataset.page=n;holder.setAttribute('aria-label',`PDF page ${n}`);label.className='page-label';label.textContent=`Page ${n} of ${active.numPages}`;paper.className='paper';canvas.className='page-canvas';canvas.width=canvas.height=1;canvas.hidden=true;layer.className='textlayer';placeholder.className='page-placeholder';placeholder.textContent=`Page ${n}`;paper.append(canvas,layer,placeholder);holder.append(label,paper);$('documentpages').append(holder);const view={n,holder,paper,canvas,layer,placeholder,width:viewport.width,height:viewport.height,revision:0,rendered:false,rendering:false,near:false};pageViews.set(n,view);resizePageView(view,Number($('zoom').value));for(const [event,handler] of [['pointerdown',beginDrag],['pointermove',updateDrag],['pointerup',e=>finishDrag(e)],['pointercancel',e=>finishDrag(e,true)]])layer.addEventListener(event,handler)}$('empty').hidden=true;$('documentpages').hidden=false;$('drop').scrollTop=0;if(typeof IntersectionObserver!=='undefined'){pageObserver=new IntersectionObserver(entries=>{if(active!==doc)return;for(const entry of entries){const view=pageViews.get(Number(entry.target.dataset.page));if(!view)continue;view.near=entry.isIntersecting;if(view.near&&!view.rendered)schedulePaint(view.n,false);else if(!view.near)evictPage(view)}},{root:$('drop'),rootMargin:'1000px 0px'});for(const view of pageViews.values())pageObserver.observe(view.holder)}else{for(const view of pageViews.values()){view.near=true;schedulePaint(view.n,false)}}await schedulePaint(1);sync()}
function resizePageView(view,z){view.paper.style.width=view.width*z+'px';view.paper.style.height=view.height*z+'px';view.canvas.style.width=view.width*z+'px';view.canvas.style.height=view.height*z+'px'}
function pageAtReadingLine(rects,line){let best=null,distance=Infinity;for(const {n,top,bottom} of rects){const d=line<top?top-line:line>bottom?line-bottom:0;if(d<distance){distance=d;best=n}}return best}
function updateVisiblePage(){scrollFrame=null;if(!doc)return;const root=$('drop').getBoundingClientRect(),line=root.top+Math.min(180,(root.bottom-root.top)*.3),n=pageAtReadingLine([...pageViews.values()].map(v=>{const r=v.paper.getBoundingClientRect();return {n:v.n,top:r.top,bottom:r.bottom}}),line);if(n&&n!==pageNo){pageNo=n;sync()}}
$('drop').addEventListener('scroll',()=>{if(scrollFrame===null)scrollFrame=requestAnimationFrame(updateVisiblePage)},{passive:true});
function refreshDocumentZoom(){finishInline();const z=Number($('zoom').value);for(const view of pageViews.values()){resizePageView(view,z);view.rendered=false;if(view.near||view.n===pageNo)schedulePaint(view.n);else evictPage(view)}}
function repaintAllLoaded(){for(const view of pageViews.values())if(view.rendered||view.near||view.n===selectionPage())schedulePaint(view.n);}

function notice(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(notice.timer);notice.timer=setTimeout(()=>$('toast').hidden=true,6500)}
function status(message){$('status').textContent=message}
function setBusy(value){busy=value;document.body.classList.toggle('busy',value);$('loading').hidden=!value;sync();$('encrypt').disabled=value}
function sync(){$('matchfont').disabled=signatureState.locked||busy||!currentBlock()||!(currentBlock().canEdit||currentBlock().added);$('sign').disabled=!doc||busy||metadataLoading||signatureState.locked;$('metadata').disabled=!doc||busy||metadataLoading;$('metadata-file').disabled=!doc||busy||metadataLoading||signatureState.locked;$('metadata-remove').disabled=!doc||busy||metadataLoading||signatureState.locked||!uploadedMetadata;$('hashes').disabled=!doc||busy||metadataLoading;$('fileid').disabled=!doc||busy||metadataLoading;$('fontid').disabled=!doc||busy||metadataLoading;$('statement').disabled=!doc||busy||metadataLoading;$('apply').disabled=signatureState.locked||busy||!currentBlock()||!(currentBlock().canEdit||currentBlock().added);$('align').disabled=$('apply').disabled;syncPositionLocks();$('export').disabled=!doc||busy||metadataLoading;$('add').disabled=!doc||busy||signatureState.locked;$('export').textContent=signatureState.locked?'Download original':'Export PDF';$('signaturestatus').hidden=!doc;$('signaturestatus').textContent=signatureState.unknown?'Inspection unavailable · view only':signatureState.locked?'Signature protected · view only':'Signature protection on';$('signature-message').hidden=!signatureState.locked;$('signature-message').textContent=signatureProtectionMessage();$('prev').disabled=!doc||pageNo<=1||busy;$('next').disabled=!doc||pageNo>=doc.numPages||busy;$('undo').disabled=!history.length||busy;$('redo').disabled=!future.length||busy;$('dirty').hidden=!(edits.size||uploadedMetadata);$('dirty').textContent=edits.size?'Unsaved changes':'Metadata replacement ready';$('pageinfo').textContent=doc?`${pageNo} / ${doc.numPages}`:'— / —';for(const b of $('pages').querySelectorAll('button')){b.classList.toggle('active',Number(b.dataset.page)===pageNo);b.querySelector('span').textContent=[...edits.values()].some(e=>e.page===Number(b.dataset.page))?'Edited':''}}
const norm=s=>(s||'').normalize('NFKC').replace(/\s/g,'');
function infer(name,metadata={}){const n=String(name||'').replace(/^[A-Z]{6}\+/,'').replace(/[_,-]+/g,' '),mono=metadata.isMonospace||metadata.monospace||/courier|mono|consolas|menlo|typewriter/i.test(n),sans=/sans|arial|helvetica|calibri|carlito|roboto|segoe|tahoma|verdana|lato|gothic|inter(?:\s|$)/i.test(n),serif=!sans&&/times|serif|roman|garamond|cambria|caladea|baskerville|palatino|georgia|bookman|century/i.test(n);return {font:mono?'Courier New':serif?'Times New Roman':'Arial',bold:!!(metadata.bold||metadata.black)||/bold|black|heavy|demi|semibold/i.test(n),italic:!!metadata.italic||/italic|oblique|slanted/i.test(n)}}
function fontFamilyKey(name){return String(name||'').replace(/^[A-Z]{6}\+/,'').replace(/[^a-z0-9]/ig,'').toLowerCase().replace(/(?:(?:semibold|demibold|bold|italic|oblique|regular|roman|medium|light|heavy|black|thin|book|normal|psmt|mt))+$/g,'');}
function clearDocumentFonts(){for(const option of documentFontOptions){loadedFonts.delete(option.family);for(const node of [...$('font').options])if(node.value===option.family)node.remove()}documentFontOptions.length=0;for(const record of fontProgramPool.values()){if(record.face)try{document.fonts.delete(record.face)}catch{}}fontProgramPool.clear();fontInventory=null}
function clearOriginalFonts(){for(const record of originalFonts.values()){if(record.face)try{document.fonts.delete(record.face)}catch{}}originalFonts.clear();originalFontJobs.clear();clearDocumentFonts()}
// Register one embedded program as a private @font-face. Used for the page's own
// font, for a reused donor program, and for the document-font choices.
async function registerFontProgram(data){let parsed=null;try{parsed=window.fontkit.create(data)}catch{parsed=null}let family='',face=null;try{family=`PdfFont${++fontCounter}`;face=new FontFace(family,data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));await face.load();document.fonts.add(face)}catch{family='';face=null}return {parsed,family,face}}
// Keep the earliest page's program for a typeface: page 1 is the donor that later
// pages borrow from, even when their own resources embed nothing.
async function poolProgram(key,data,page,baseFont){if(!key||!data?.length)return null;const existing=fontProgramPool.get(key);if(existing?.parsed&&(!page||(existing.page&&existing.page<=page)))return existing;const program=await registerFontProgram(data);const entry={key,baseFont,page:page||null,data,parsed:program.parsed,family:program.family,face:program.face};fontProgramPool.set(key,entry);return entry}
// Detect the fonts of the opened PDF and expose page 1's programs everywhere:
// as reuse donors for later pages and as choices in the font list.
function donorResourceName(inventory,font,page){
 const onPage=inventory?.pages?.find(entry=>entry.page===page)?.fonts?.find(entry=>entry.key===font.key);
 return onPage?.resourceName||font.resourceNames?.[0]||null;
}
// Export plans: block font family → the existing font dictionary to reuse.
function documentFontPlans(){
 const plans=new Map();
 for(const option of documentFontOptions)if(option.resourceName)plans.set(option.family,{page:option.page,resourceName:option.resourceName});
 return plans;
}
async function primeDocumentFonts(inventory){for(const font of inventory?.fonts||[]){if(!font.program)continue;const donor=await poolProgram(font.key,font.program,font.programPage,font.baseFont);if(!donor?.family)continue;loadedFonts.set(donor.family,{face:donor.face,data:donor.data,name:font.baseFont,parsed:donor.parsed,style:{bold:!!font.bold,italic:!!font.italic},documentPage:donor.page,documentKey:font.key});documentFontOptions.push({family:donor.family,label:`${font.displayFamily||font.baseFont}${font.bold?' Bold':''}${font.italic?' Italic':''}`,baseFont:font.baseFont,page:donor.page,resourceName:donorResourceName(inventory,font,donor.page)});$('font').append(new Option(`${font.displayFamily||font.baseFont}${font.bold?' Bold':''}${font.italic?' Italic':''} — page ${donor.page} (document font)`,donor.family))}}
// A later page whose /Font has no usable program borrows page 1's program for
// both the preview and the native export.
function documentFontForBlock(block,text){
 if(!block)return null;
 const key=fontKey(block.fontName||'');
 if(!key)return null;
 const option=documentFontOptions.find(entry=>entry.baseFont&&fontKey(entry.baseFont)===key);
 if(!option)return null;
 const upload=loadedFonts.get(option.family);
 if(!upload?.parsed)return null;
 const covered=Array.from(String(text??'').replace(/[\r\n]/g,'')).every(char=>parsedHasGlyph(upload.parsed,char)||char===' '||char==='\t');
 return covered?option:null;
}
function applyProgramDonor(record,page){const donor=fontProgramPool.get(record.key);if(!donor?.parsed)return record;const own=record.parsed?.numGlyphs||0,gain=donor.parsed.numGlyphs||0;if(record.parsed&&gain<=own)return record;record.parsed=donor.parsed;record.family=donor.family||record.family;record.face=donor.face||record.face;record.data=donor.data;if(donor.page&&donor.page!==page)record.reusedFrom=donor.page;return record}
async function ensureOriginalFont(id,font,page=null){
 if(!id)return null;
 if(originalFonts.has(id))return originalFonts.get(id);
 if(!font)return null;
 let job=originalFontJobs.get(id);
 if(!job){
  job=(async()=>{
   let data=null;try{data=font.data?new Uint8Array(font.data):null}catch{data=null}
   const key=fontKey(font.name||id),record={id,key,family:'',parsed:null,data,name:font.name||id};
   if(data){const program=await registerFontProgram(data);record.parsed=program.parsed;record.family=program.family;record.face=program.face}
   if(data)await poolProgram(key,data,page,record.name);
   applyProgramDonor(record,page);
   originalFonts.set(id,record);
   return record;
  })();
  originalFontJobs.set(id,job);
  job.catch(()=>{}).finally(()=>originalFontJobs.delete(id));
 }
 return job;
}
function matchingUpload(block,text,uploads=loadedFonts){const target=fontFamilyKey(block.fontName);if(!target)return null;for(const [family,upload] of uploads){const parsed=upload.parsed;if(!parsed)continue;const keys=[parsed.familyName,parsed.postscriptName,parsed.fullName].filter(Boolean).map(fontFamilyKey);if(!keys.includes(target))continue;const style=infer(parsed.subfamilyName||parsed.fullName);if(style.bold!==block.bold||style.italic!==block.italic)continue;if(!Array.from(text.replaceAll('\n','')).every(c=>parsed.hasGlyphForCodePoint(c.codePointAt(0))))continue;return {family,upload};}return null;}
function originalCoverageFor(block,text){return originalFontCoverage({glyphMap:block?.glyphMap,parsed:originalRecord(block)?.parsed},text)}
function matchingStatus(block){if(block.font==='original'){const coverage=originalCoverageFor(block,block.text),docFont=!originalRecord(block)?.parsed?documentFontForBlock(block,block.text):null;if(docFont&&coverage.ok===false)return `No embedded program for this page · ${docFont.label} from page ${docFont.page} is available`;if(coverage.ok)return originalRecord(block)?.parsed?'Original PDF font selected · full embedded font coverage':'Original PDF font selected · observed glyphs available';return `This PDF embeds a subset of its font, missing ${describeMissing(coverage.missing)} · load the full TTF/OTF or use a substitute`}const upload=loadedFonts.get(block.font);if(upload)return 'Loaded font: '+(upload.parsed?.fullName||upload.name)+' · embedded on export';return /Times|Georgia/.test(block.font)?'Approximate Times-family export · load the actual font for a closer match':/Courier/.test(block.font)?'Approximate Courier-family export':'Approximate Helvetica-family export · load the actual font for a closer match';}
function chooseBestFont(){finishInline();const b=currentBlock();if(!b||busy||signatureState.locked||!(b.canEdit||b.added))return;const original=originalBlock(b.id)||b,desired={...original,bold:$('bold').checked,italic:$('italic').checked},text=$('text').value,coverage=originalCoverageFor(original,text);if(original.embeddedName&&desired.bold===original.bold&&desired.italic===original.italic&&coverage.ok){$('font').value='original';notice('Original PDF font selected. Apply changes to use it.');}else{const match=matchingUpload(desired,text);$('font').value=match?.family||infer(original.fontName).font;notice(match?'Matching loaded family and style selected. Apply changes to use it.':coverage.missing.length?`This PDF embeds only a subset of its font, which is missing ${describeMissing(coverage.missing)}. A standard-family substitute is selected; load the full TTF/OTF for those characters.`:'No matching loaded font with the required style. A standard-family substitute is selected; load the original TTF/OTF for a closer match.');}$('fontstatus').textContent=matchingStatus({...b,font:$('font').value,text});}
function colorHex(value){return typeof value==='string'?value:'#'+Array.from(value).slice(0,3).map(v=>Math.round(Number(v)*255).toString(16).padStart(2,'0')).join('')}
function grayHex(value){const v=Math.round(Number(value)*255).toString(16).padStart(2,'0');return '#'+v.repeat(3)}
function cmykHex(value){const [c,m,y,k]=Array.from(value).map(Number);return '#'+[c,m,y].map(v=>Math.round(255*(1-Math.min(1,Math.max(0,v)))*(1-Math.min(1,Math.max(0,k)))).toString(16).padStart(2,'0')).join('')}
function opsInfo(list,page){let state={font:null,fontSize:0,color:'#000000',strokeColor:'#000000',mode:0,lineWidth:1,charSpacing:0,wordSpacing:0,textRise:0,hScale:100,pattern:false,strokePattern:false},stack=[],result=[],fontMaps=new Map();for(let i=0;i<list.fnArray.length;i++){const fn=list.fnArray[i],a=list.argsArray[i];if(fn===OPS.save)stack.push({...state});else if(fn===OPS.restore)state=stack.pop()||state;else if(fn===OPS.setFont){state.font=a[0];state.fontSize=a[1]}else if(fn===OPS.setTextRenderingMode)state.mode=a[0];else if(fn===OPS.setLineWidth)state.lineWidth=a[0];else if(fn===OPS.setCharSpacing)state.charSpacing=a[0];else if(fn===OPS.setWordSpacing)state.wordSpacing=a[0];else if(fn===OPS.setTextRise)state.textRise=a[0];else if(fn===OPS.setHScale)state.hScale=a[0];else if(fn===OPS.setGState){for(const entry of a[0]||[]){if(entry?.[0]==='LW')state.lineWidth=entry[1]}}else if(fn===OPS.setFillColorN)state.pattern=true;else if(fn===OPS.setStrokeColorN)state.strokePattern=true;else if(fn===OPS.setFillRGBColor){state.pattern=false;state.color=colorHex(typeof a[0]==='string'?a[0]:a)}else if(fn===OPS.setStrokeRGBColor){state.strokePattern=false;state.strokeColor=colorHex(typeof a[0]==='string'?a[0]:a)}else if(fn===OPS.setFillGray){state.pattern=false;state.color=grayHex(a[0])}else if(fn===OPS.setStrokeGray){state.strokePattern=false;state.strokeColor=grayHex(a[0])}else if(fn===OPS.setFillCMYKColor){state.pattern=false;state.color=cmykHex(a)}else if(fn===OPS.setStrokeCMYKColor){state.strokePattern=false;state.strokeColor=cmykHex(a)}if(fn===OPS.showText){const glyphs=a[0]||[],str=glyphs.filter(g=>typeof g!=='number').map(g=>g.unicode||'').join('');let font;try{font=page.commonObjs.get(state.font)}catch{}let map=fontMaps.get(state.font);if(!map){map=new Map();fontMaps.set(state.font,map)}for(const g of glyphs)if(typeof g!=='number'&&g.unicode&&g.fontChar)map.set(g.unicode,g.fontChar);result.push({index:i,str,glyphs,fontId:state.font,font,fontSize:state.fontSize,color:state.color,strokeColor:state.strokeColor,lineWidth:state.lineWidth,charSpacing:state.charSpacing,wordSpacing:state.wordSpacing,textRise:state.textRise,hScale:state.hScale,mode:state.mode,pattern:state.pattern,strokePattern:state.strokePattern})}}return {ops:result,fontMaps}}
async function getPage(n){if(cache.has(n))return cache.get(n);const page=await doc.getPage(n);const content=await page.getTextContent({includeMarkedContent:false});const vp=page.getViewport({scale:1});const scratch=document.createElement('canvas');scratch.width=Math.ceil(vp.width);scratch.height=Math.ceil(vp.height);await page.render({canvasContext:scratch.getContext('2d'),viewport:vp,recordOperations:true}).promise;const list=await page.getOperatorList({intent:'display'});const info=opsInfo(list,page);const items=content.items.filter(x=>x.str&&norm(x.str));const prepared=items.map(item=>{const t=pdfjs.Util.transform(vp.transform,item.transform);return {item,t,x:normalizeMeasure(t[4]),y:normalizeMeasure(t[5]),size:normalizeMeasure(Math.hypot(t[2],t[3])),rawX:t[4],rawY:t[5],rawSize:Math.hypot(t[2],t[3]),angle:Math.atan2(t[1],t[0])}});const bbox=page.recordedBBoxes;const operationMatches=matchTextOperations(prepared.map(({item,x,y,size})=>({text:item.str,fontId:item.fontName,x,y,tolerance:Math.max(30,size*4)})),info.ops.map(o=>({...o,bbox:bbox&&!bbox.isEmpty(o.index)?{x:bbox.minX(o.index)*vp.width,y:bbox.maxY(o.index)*vp.height}:null})));const blocks=prepared.map(({item,t,x,y,size,rawX,rawY,rawSize,angle},k)=>{const style=content.styles[item.fontName]||{};let font;try{font=page.commonObjs.get(item.fontName)}catch{}const name=font?.name||style.fontFamily||item.fontName, guess=infer(name,font||{});const matches=operationMatches[k],states=matches.map(o=>({mode:o.mode,fontSize:o.fontSize,lineWidth:o.lineWidth,charSpacing:o.charSpacing,wordSpacing:o.wordSpacing,textRise:o.textRise,hScale:o.hScale,strokeColor:o.strokeColor,fillPattern:o.pattern,strokePattern:o.strokePattern})),safe=matches.length>0&&matches.every(o=>o.font&&!o.font.isType3Font&&!o.font.disableFontFace)&&sameTextState(states)&&states.every(paintStateUsable)&&Math.abs(angle)<0.001&&!style.vertical;const map=info.fontMaps.get(item.fontName)||new Map(),matchState=matches[0]||{},rawRise=safe?Number(matchState.textRise||0):0,rise=safe?normalizeMeasure(rawRise):0;
 // The producer's own numbers, kept alongside the rounded ones the controls
 // show: an export that puts back 403.237 for 403.23749 reads as another program
 // writing into the page, so an untouched block is drawn at its exact position.
 return {id:`${n}:${k}`,page:n,text:item.str,x,y:normalizeMeasure(y-rise),size,width:normalizeMeasure(item.width),xExact:rawX,yExact:rawY-rawRise,sizeExact:rawSize,widthExact:item.width,spacingExact:matchState.charSpacing||0,wordSpacingExact:matchState.wordSpacing||0,strokeWidthExact:matchState.lineWidth??1,height:normalizeMeasure(item.height),angle,fontName:name,fontId:item.fontName,embeddedName:font?.loadedName,fontCss:font?.systemFontInfo?.css||`"${font?.loadedName}", ${font?.fallbackName||guess.font}`,fontEmbedded:!!font?.data,glyphMap:map,canEdit:safe,ops:safe?matches.map(o=>o.index):[],color:matches[0]?.color||'#000000',strokeColor:matchState.strokeColor||'#000000',strokeWidth:normalizeMeasure(matchState.lineWidth??1),textMode:Number(matchState.mode)||0,font:font?.loadedName?'original':guess.font,fallback:guess.font,bold:guess.bold,italic:guess.italic,underline:false,spacing:normalizeMeasure(matchState.charSpacing||0),wordSpacing:normalizeMeasure(matchState.wordSpacing||0),lineheight:1.2,align:'left',scaleX:1}});for(const id of [...new Set(blocks.filter(b=>b.font==='original'&&b.fontId).map(b=>b.fontId))]){let font;try{font=page.commonObjs.get(id)}catch{}await ensureOriginalFont(id,font,n)}for(const b of blocks){if(b.font==='original'){const ctx=scratch.getContext('2d'),w=naturalWidth(ctx,b,b.text);b.scaleX=w>0?b.width/w:1;if(b.scaleX<.25||b.scaleX>4)b.scaleX=1}}const data={page,content,vp,blocks,list,info};cache.set(n,data);return data}
function currentBlock(){if(!selected)return null;return edits.get(selected)||cache.get(selectionPage())?.blocks.find(b=>b.id===selected)}
function originalBlock(id){for(const data of cache.values()){const b=data.blocks.find(x=>x.id===id);if(b)return b}return null}
function embeddedEncode(block,text){return glyphMapEncode(block?.glyphMap,text)}
function originalRecord(block){if(!block?.fontId)return null;return originalFonts.get(block.fontId)||null}
function blockFamily(block){return block.font==='original'?block.fallback:block.font}
function genericFamily(family){return /Times|Georgia/.test(family)?'serif':/Courier/.test(family)?'monospace':'sans-serif'}
function fontRuns(block,text){const family=blockFamily(block),generic=genericFamily(family),prefix=`${block.italic?'italic ':''}${block.bold?'bold ':''}${block.size}px `,fallbackCss=`${prefix}"${family}", ${generic}`,record=block.font==='original'?originalRecord(block):null,programCss=record?.family?`${prefix}"${record.family}", ${generic}`:'',privateCss=block.font==='original'&&block.embeddedName&&block.fontCss?`${prefix}${block.fontCss}`:'';if(block.font!=='original')return [{text:String(text??'').replace(/[\r\n]/g,''),css:fallbackCss}];return lineFontRuns({glyphMap:block.glyphMap,parsed:record?.parsed},text,{fallbackCss,programCss,privateCss})}
function shapeLine(ctx,b,text){const glyphs=[];let width=0,count=0;for(const run of fontRuns(b,text)){ctx.font=run.css;const layout=glyphLayout({text:run.text,spacing:b.spacing||0,wordSpacing:b.wordSpacing||0,measure:char=>ctx.measureText(char).width}),lead=count?b.spacing||0:0;for(const glyph of layout.glyphs)glyphs.push({char:glyph.char,css:run.css,offset:width+lead+glyph.offset});width+=lead+layout.width;count+=layout.count}return {glyphs,width,count}}
function runWidth(ctx,b,text){return shapeLine(ctx,b,text).width}
function naturalWidth(ctx,b,text){return shapeLine(ctx,{...b,spacing:0,wordSpacing:0},text).width}
function measure(ctx,b,text){return runWidth(ctx,b,text)*b.scaleX}
function textStart(ctx,b,line){const width=measure(ctx,b,line);if(b.align==='right')return b.x-width;if(b.align==='center')return b.x-width/2;if(b.align==='decimal'){const i=line.indexOf('.'),prefix=i<0?line:line.slice(0,i),gap=(b.spacing||0)+(prefix.endsWith(' ')?(b.wordSpacing||0):0);return b.x-measure(ctx,b,prefix)-(i>0?gap*b.scaleX:0)}return b.x}
function drawBlock(ctx,b,scale){if(b.removed||!b.text)return;const paint=textPaintMode(b.textMode??0)||{fill:true,stroke:false};ctx.save();ctx.scale(scale,scale);ctx.fillStyle=b.color;ctx.strokeStyle=b.strokeColor||b.color;ctx.textBaseline='alphabetic';ctx.textAlign='left';try{ctx.fontKerning='none'}catch{}const lines=b.text.split('\n');lines.forEach((line,i)=>{const shaped=shapeLine(ctx,b,line),start=textStart(ctx,b,line),baseline=b.y+i*b.size*b.lineheight;ctx.save();ctx.translate(start,baseline);ctx.scale(b.scaleX,1);ctx.fillStyle=b.color;ctx.strokeStyle=b.strokeColor||b.color;const strokeWidth=canvasStrokeWidth(b.strokeWidth??1,b.scaleX,scale);for(const glyph of shaped.glyphs){ctx.font=glyph.css;if(paint.fill)ctx.fillText(glyph.char,glyph.offset,0);if(paint.stroke){ctx.lineWidth=strokeWidth;ctx.strokeText(glyph.char,glyph.offset,0)}}ctx.restore();if(b.underline){ctx.strokeStyle=paint.fill?b.color:(b.strokeColor||b.color);ctx.lineWidth=Math.max(.5,b.size/16);ctx.beginPath();ctx.moveTo(start,baseline+b.size*.14);ctx.lineTo(start+measure(ctx,b,line),baseline+b.size*.14);ctx.stroke()}});ctx.restore()}
async function renderEdited(data,canvas,scale,hideId=null){const vp=data.page.getViewport({scale});canvas.width=Math.ceil(vp.width);canvas.height=Math.ceil(vp.height);const ctx=canvas.getContext('2d');const pageEdits=[...edits.values()].filter(e=>e.page===data.page.pageNumber);const suppress=new Set(pageEdits.flatMap(e=>e.ops||[]));if(hideId){const hidden=pageEdits.find(b=>b.id===hideId)||data.blocks.find(b=>b.id===hideId);for(const index of hidden?.ops||[])suppress.add(index)}let mute=false;const fills=ctx.fillText.bind(ctx),strokes=ctx.strokeText.bind(ctx);ctx.fillText=(...a)=>{if(!mute)fills(...a)};ctx.strokeText=(...a)=>{if(!mute)strokes(...a)};try{await data.page.render({canvasContext:ctx,viewport:vp,operationsFilter:index=>{mute=suppress.has(index);return true}}).promise}finally{mute=false;ctx.fillText=fills;ctx.strokeText=strokes}for(const e of pageEdits)if(e.id!==hideId)drawBlock(ctx,e,scale);return vp}
function schedulePaint(n=selectionPage(),force=true){const view=pageViews.get(n);if(!view||!doc)return paintQueue;const version=generation,revision=++view.revision;paintQueue=paintQueue.catch(()=>{}).then(async()=>{if(version!==generation||revision!==view.revision||(!force&&!view.near)||!doc)return;view.rendering=true;try{const data=await getPage(n);if(version!==generation||revision!==view.revision)return;view.width=data.vp.width;view.height=data.vp.height;const z=Number($('zoom').value),dpr=Math.min(devicePixelRatio||1,2);await renderEdited(data,view.canvas,z*dpr,inline?.block.page===n?inline.id:null);if(version!==generation||revision!==view.revision)return;resizePageView(view,z);view.canvas.hidden=false;view.placeholder.hidden=true;view.rendered=true;renderLayer(data,z);sync();if(n===pageNo)status(signatureState.locked?`Page ${n} of ${doc.numPages} · signature protected · view only`:`Page ${n} of ${doc.numPages} · click text to edit`)}finally{view.rendering=false;if(!view.near&&!force)evictPage(view)}}).catch(error=>{view.placeholder.textContent='Could not render this page';notice(error.message||'Unable to render this page')});return paintQueue}
function renderLayer(data,z){const n=data.page.pageNumber,layer=layerForPage(n),canvas=canvasForPage(n);if(!layer||!canvas)return;for(const element of layer.querySelectorAll('.textblock,.movehandle'))element.remove();const ctx=canvas.getContext('2d');const blocks=[...data.blocks,...[...edits.values()].filter(e=>e.page===n&&e.added)];for(const originalB of blocks){const b=edits.get(originalB.id)||originalB;if(b.removed)continue;const button=document.createElement('button');button.type='button';button.className='textblock'+(selected===b.id?' selected':'')+(edits.has(b.id)?' edited':'');button.dataset.id=b.id;button.title=b.text+(b.canEdit||b.added?'':' — inspection only');button.setAttribute('aria-label',`Select text: ${b.text}`);const lines=b.text.split('\n');const width=Math.max(8,...lines.map(l=>measure(ctx,b,l)));const start=Math.min(...lines.map(l=>textStart(ctx,b,l)));const top=blockTop(ctx,b);Object.assign(button.style,{left:start*z+'px',top:top*z+'px',width:width*z+'px',height:(lines.length*b.size*b.lineheight)*z+'px',transform:b.angle?`rotate(${b.angle}rad)`:'none'});button.classList.toggle('movable',!signatureState.locked&&(b.canEdit||b.added));button.onclick=()=>startInline(b.id);layer.append(button);if(selected===b.id&&!signatureState.locked&&(b.canEdit||b.added)){const handle=document.createElement('button');handle.type='button';handle.className='movehandle';handle.dataset.id=b.id;handle.textContent='✥';handle.title='Drag to move this whole text block';handle.setAttribute('aria-label','Move selected text block');handle.style.left=(start+width)*z+8+'px';handle.style.top=top*z-8+'px';layer.append(handle)}}}
function select(id){const previous=selectionPage();selected=id;pageNo=selectionPage();if(previous!==pageNo&&cache.has(previous))renderLayer(cache.get(previous),Number($('zoom').value));sync();const b=currentBlock();if(!b)return;$('controls').hidden=false;$('selectionhint').hidden=true;$('selectionname').textContent=b.added?'Added text':'Selected text';$('detected').textContent=b.added?'New text':b.fontName;const identity=detectFontIdentity(b.fontName,originalBlock(b.id)||b);$('fontidentity').textContent=identity.family?'Recognized: '+identity.family+' · '+identity.style+(identity.subsetPrefix?' · subset '+identity.subsetPrefix:''):'Reported font name retained · family not explicitly recognized';$('fontidentity').title=identity.reportedFamilies.length>1?'Reported fallback list: '+identity.reportedFamilies.join(', '):'Name-based recognition; font availability is checked separately.';for(const id of ['text','color','font','align'])$(id).value=b[id];for(const id of ['size','spacing','lineheight','x','y'])$(id).value=formatMeasure(b[id]);$('wordspacing').value=formatMeasure(b.wordSpacing);const paintState=textPaintMode(b.textMode??0);if(paintState?.stroke&&!paintState.fill)$('color').value=/^#[0-9a-f]{6}$/i.test(b.strokeColor||'')?b.strokeColor:b.color;for(const id of ['bold','italic','underline'])$(id).checked=b[id];const originalOption=$('font').querySelector('[value="original"]');if(originalOption)originalOption.remove();if(b.embeddedName){const option=new Option(b.fontEmbedded?'Original embedded font':'Original PDF font','original');$('font').prepend(option)}$('font').value=b.font;$('fontstatus').textContent=matchingStatus(b);const paint=textPaintMode(b.textMode??0);$('textpaint').textContent=!paint?'Invisible text · view only':paint.fill&&paint.stroke?`Fill + stroke · ${formatMeasure(b.strokeWidth??1)} pt`:paint.stroke?`Stroke only · ${formatMeasure(b.strokeWidth??1)} pt`:'Fill only';$('unsupported').hidden=!signatureState.locked&&(b.canEdit||b.added);$('unsupported').textContent='This text uses a drawing structure that cannot be safely replaced here. You can inspect it or add separate text.';$('apply').disabled=signatureState.locked||!(b.canEdit||b.added);$('delete').disabled=signatureState.locked||!(b.canEdit||b.added);if(signatureState.locked)$('unsupported').textContent='Signed-document protection is always on. Editing is disabled; download the original unchanged or ask the issuer for a corrected, newly signed document.';for(const field of $('controls').querySelectorAll('input,textarea,select'))field.disabled=signatureState.locked;syncPositionLocks();$('decimalhelp').hidden=b.align!=='decimal';renderLayer(cache.get(selectionPage()),Number($('zoom').value))}
function startInline(id){if(busy)return;if(signatureState.locked){select(id);signatureLockNotice();return;}if(inline?.id===id){inline.element.focus();return}finishInline();select(id);const block=currentBlock();if(!block||!(block.canEdit||block.added)){notice('This text cannot be safely replaced here.');return}const element=document.createElement('textarea');element.className='inline-editor';element.value=block.text;element.spellcheck=false;element.wrap='off';element.setAttribute('aria-label','Edit text directly on the PDF');inline={id,block:{...block},element,initial:block.text};element.addEventListener('input',()=>{$('text').value=element.value;positionInline()});element.addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();finishInline(true)}else if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();event.stopPropagation();finishInline()} });element.addEventListener('blur',()=>{if(inline?.element===element)finishInline()});layerForPage(block.page).append(element);positionInline();element.focus({preventScroll:true});element.setSelectionRange(element.value.length,element.value.length);schedulePaint();status('Type directly on the page · Enter to finish · Shift+Enter for a new line · Esc to cancel')}
function inlineFamily(block){const record=block.font==='original'?originalRecord(block):null;if(record?.family&&record.parsed&&Array.from(String(block.text??'').replace(/[\r\n]/g,'')).every(c=>parsedHasGlyph(record.parsed,c)))return `"${record.family}", ${block.fallback}`;const family=blockFamily(block);return `"${family}", ${genericFamily(family)}`}
function inlineFont(b){return `${b.italic?'italic ':''}${b.bold?'bold ':''}${b.size}px ${inlineFamily(b)}`}
function blockTop(ctx,b){ctx.save();ctx.font=inlineFont(b);const offset=baselineOffsetFor(ctx,{fontSize:b.size,lineHeight:b.lineheight});ctx.restore();return b.y-offset}
function positionInline(){if(!inline)return;const b={...inline.block,text:inline.element.value},z=Number($('zoom').value),ctx=canvasForPage(b.page).getContext('2d'),lines=b.text.split('\n'),unscaled=Math.max(b.size*2,...lines.map(line=>shapeLine(ctx,b,line).width)),sx=Number(b.scaleX)||1,left=Math.min(...lines.map(line=>textStart(ctx,b,line))),top=blockTop(ctx,b),paint=textPaintMode(b.textMode??0)||{fill:true,stroke:false},strokeWidth=Math.max(.01,canvasStrokeWidth(b.strokeWidth??1,sx,1)*z);Object.assign(inline.element.style,{left:left*z+'px',top:top*z+'px',width:(unscaled+8/z)*z+'px',height:(lines.length*b.size*b.lineheight+2)*z+'px',transform:sx===1?'none':`scaleX(${sx})`,transformOrigin:'0 0',fontFamily:inlineFamily(b),fontSize:b.size*z+'px',fontWeight:b.bold?'bold':'normal',fontStyle:b.italic?'italic':'normal',letterSpacing:(b.spacing||0)*z+'px',wordSpacing:(b.wordSpacing||0)*z+'px',lineHeight:String(b.lineheight),color:paint.fill?b.color:'transparent',caretColor:paint.fill?b.color:(b.strokeColor||b.color),textDecoration:b.underline?'underline':'none',textDecorationColor:paint.fill?b.color:(b.strokeColor||b.color),fontKerning:'none',fontVariantLigatures:'none',fontFeatureSettings:'"kern" 0, "liga" 0'});const stroke=paint.stroke?`${strokeWidth}px ${b.strokeColor||b.color}`:'';if('webkitTextStroke'in inline.element.style)inline.element.style.webkitTextStroke=stroke;else if(stroke)inline.element.style.textShadow=`0 0 ${Math.max(1,strokeWidth)}px ${b.strokeColor||b.color}`;$('text').value=inline.element.value}
function finishInline(cancel=false){if(!inline)return;const session=inline;inline=null;session.element.remove();if(!cancel&&session.element.value!==session.initial){selected=session.id;$('text').value=session.element.value;apply()}else{selected=session.id;if(cancel)$('text').value=session.initial;schedulePaint()}status(cancel?'Text edit cancelled':'Text edit finished')}
// Pointer events stay on the persistent layer, even when selection outlines redraw.
let drag=null,dragFrame=null;
function syncPositionLocks(){const b=currentBlock(),locks=b?positionLocks.get(b.id)||{}:{},disabled=signatureState.locked||busy||!b||!(b.canEdit||b.added);$('lockx').disabled=$('locky').disabled=disabled;$('lockx').checked=!!locks.x;$('locky').checked=!!locks.y;$('x').disabled=disabled||!!locks.x;$('y').disabled=disabled||!!locks.y;$('positionhint').textContent=!b?'Select text to set its position locks.':locks.x&&locks.y?'X anchor and Y baseline fixed.':locks.x?'X anchor fixed; vertical movement allowed.':locks.y?'Y baseline fixed; horizontal movement allowed.':'Drag freely, or lock an axis to keep it fixed.';}
function togglePositionLock(axis,checked){finishInline();const b=currentBlock();if(!b||busy||signatureState.locked||!(b.canEdit||b.added))return;positionLocks.set(b.id,{...positionLocks.get(b.id),[axis]:checked});syncPositionLocks();}
$('lockx').onchange=()=>togglePositionLock('x',$('lockx').checked);$('locky').onchange=()=>togglePositionLock('y',$('locky').checked);
function translatedBlock(block,dx,dy){const moved=translatePosition(block,dx,dy,positionLocks.get(block.id));return {...moved,x:normalizeMeasure(moved.x),y:normalizeMeasure(moved.y)};}
function queueDragPaint(){if(dragFrame!==null)return;dragFrame=requestAnimationFrame(()=>{dragFrame=null;schedulePaint()})}
function beginDrag(event){if(busy||event.button!==0)return;if(signatureState.locked){const target=event.target.closest('.textblock');if(target)select(target.dataset.id);signatureLockNotice();return;}const target=event.target.closest('.movehandle');if(!target){const text=event.target.closest('.textblock');if(text){event.preventDefault();startInline(text.dataset.id)}return;}const id=target.dataset.id;finishInline();select(id);const block=currentBlock();if(positionLocks.get(id)?.x&&positionLocks.get(id)?.y){notice('Both coordinates are locked. Unlock an axis beside Alignment to move this text.');return;}if(!block||!(block.canEdit||block.added))return;event.preventDefault();drag={pointer:event.pointerId,id,block:{...block},before:snapshot(),startX:event.clientX,startY:event.clientY,zoom:Number($('zoom').value),moved:false,layer:layerForPage(block.page)};drag.layer.setPointerCapture(event.pointerId)}
function updateDrag(event){if(!drag||event.pointerId!==drag.pointer)return;const dx=(event.clientX-drag.startX)/drag.zoom,dy=event.shiftKey?0:(event.clientY-drag.startY)/drag.zoom;if(!drag.moved&&Math.hypot(dx,dy)*drag.zoom<3)return;const block=translatedBlock(drag.block,dx,dy);if(!drag.moved&&block.x===drag.block.x&&block.y===drag.block.y)return;drag.moved=true;edits.set(drag.id,block);$('x').value=formatMeasure(block.x);$('y').value=formatMeasure(block.y);document.body.classList.add('dragging');queueDragPaint();status('Moving whole text block · hold Shift for horizontal movement')}
function finishDrag(event,cancel=false){if(!drag||(event&&event.pointerId!==drag.pointer))return;const session=drag;drag=null;if(dragFrame!==null){cancelAnimationFrame(dragFrame);dragFrame=null}if(session.layer.hasPointerCapture(session.pointer))session.layer.releasePointerCapture(session.pointer);document.body.classList.remove('dragging');if(session.moved){if(cancel)edits=session.before;else{history.push(session.before);if(history.length>60)history.shift();future=[];invalidateCurrentExportFingerprint()}sync();schedulePaint();select(session.id);status(cancel?'Move cancelled':'Text block moved')} }
function nudgeSelection(dx,dy){if(signatureState.locked)return false;const block=currentBlock();if(!block||busy||!(block.canEdit||block.added))return false;const moved=translatedBlock(block,dx,dy);if(moved.x===block.x&&moved.y===block.y){status('Position locked');return true;}commit(()=>edits.set(block.id,moved));select(block.id);status('Text block moved');return true}




document.addEventListener('keydown',event=>{if(event.key==='Escape'&&drag){finishDrag(null,true);event.preventDefault();return}if(event.ctrlKey||event.metaKey||event.altKey||/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)||event.target.isContentEditable)return;const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(direction&&nudgeSelection(direction[0]*(event.shiftKey?10:1),direction[1]*(event.shiftKey?10:1)))event.preventDefault()});
function snapshot(){return new Map([...edits].map(([id,b])=>[id,{...b}]))}
function commit(fn){if(signatureState.locked){signatureLockNotice();return;}history.push(snapshot());if(history.length>60)history.shift();future=[];fn();invalidateCurrentExportFingerprint();sync();schedulePaint()}
function apply(){if(signatureState.locked){signatureLockNotice();return;}const b=currentBlock();if(!b||!(b.canEdit||b.added))return;let e={...b};for(const id of ['text','color','font','align'])e[id]=$(id).value;for(const id of ['size','spacing','lineheight','x','y']){const raw=Number($(id).value);if(!Number.isFinite(raw)){notice('Enter valid numeric typography values.');return}e[id]=normalizeMeasure(raw)}const rawWordSpacing=Number($('wordspacing').value);if(!Number.isFinite(rawWordSpacing)){notice('Enter valid numeric typography values.');return}e.wordSpacing=normalizeMeasure(rawWordSpacing);e=constrainPosition(b,e,positionLocks.get(b.id));if(e.size<1||e.size>300||e.lineheight<.5||e.lineheight>4||e.spacing<-10||e.spacing>40||e.wordSpacing<-10||e.wordSpacing>40){notice('Use the size and spacing limits shown in the controls.');return}for(const id of ['bold','italic','underline'])e[id]=$(id).checked;e.textMode=Number.isInteger(b.textMode)?b.textMode:0;e.strokeWidth=normalizeMeasure(b.strokeWidth??1);e.strokeColor=/^#[0-9a-f]{6}$/i.test(b.strokeColor||'')?b.strokeColor:b.color;if(e.textMode===1)e.strokeColor=e.color;else if(e.textMode===2&&e.color!==b.color&&String(b.strokeColor||'').toLowerCase()===String(b.color||'').toLowerCase())e.strokeColor=e.color;e.removed=false;const orig=originalBlock(e.id),coverage=originalCoverageFor(orig||e,e.text);if(e.font==='original'&&((orig&&(e.bold!==orig.bold||e.italic!==orig.italic))||!coverage.ok)){const docFont=!coverage.ok?documentFontForBlock(orig||e,e.text):null,match=docFont?null:matchingUpload({...e,fontName:orig?.fontName||e.fontName},e.text);e.font=docFont?.family||match?.family||e.fallback;notice(docFont?`This page has no usable embedded program for ${orig?.fontName||e.fontName}; using the document copy from page ${docFont.page}, which covers this text.`:match?'Using a matching loaded font with the required style and character coverage.':coverage.missing.length?`This PDF embeds only a subset of its font, which is missing ${describeMissing(coverage.missing)}. Using a standard-family substitute; load the full TTF/OTF for those characters.`:'The original font cannot render this text/style here. Using a standard-family substitute; load the original TTF/OTF for a closer match.');}const chosenUpload=loadedFonts.get(e.font);if(chosenUpload?.style&&(chosenUpload.style.bold!==e.bold||chosenUpload.style.italic!==e.italic)){const variant=matchingUpload({...e,fontName:chosenUpload.parsed.familyName},e.text);if(variant)e.font=variant.family;else{notice('Load the matching bold/italic font variant. This font file has a fixed style; it will not be silently simulated.');return;}}e.scaleX=Number.isFinite(orig?.scaleX)&&orig.scaleX>0?orig.scaleX:Number.isFinite(b.scaleX)&&b.scaleX>0?b.scaleX:1;commit(()=>edits.set(e.id,e));select(e.id);status('Text change applied')}
async function openFile(file){
 finishInline();if(busy)return;$('loading').textContent='Opening document…';if(!file)return;
 if((edits.size||uploadedMetadata)&&!confirm('Open another PDF and discard unsaved changes and uploaded metadata?'))return;
 setBusy(true);let passwordCancelled=false;
 try{
  await paintQueue;
  const bytes=new Uint8Array(await file.arrayBuffer());
  const uploadedFileId=await readPdfFileId(bytes,PDFLib);
  let acceptedPassword=null;
  const loading=pdfjs.getDocument({data:bytes.slice(),cMapUrl:'./vendor/cmaps/',cMapPacked:true,standardFontDataUrl:'./vendor/standard_fonts/',wasmUrl:'./vendor/wasm/',fontExtraProperties:true});
  loading.onPassword=(update,reason)=>{
   const password=prompt(reason===pdfjs.PasswordResponses.INCORRECT_PASSWORD?'Incorrect password. Try again:':'This PDF is password protected. Enter its password:');
   if(password===null){passwordCancelled=true;loading.destroy();return}
   acceptedPassword=password;update(password);
  };
  const next=await loading.promise;
  let workingBytes=bytes;
  const uploadedInspection=await inspectSignatureProtection(bytes,PDFLib);
  let nextSignatureState=uploadedInspection;
  if(nextSignatureState.reason==='encrypted'){
   try{
    workingBytes=await decryptPdfCopy({bytes,password:acceptedPassword??''});
    nextSignatureState=await inspectSignatureProtection(workingBytes,PDFLib);
    if(nextSignatureState.reason==='encrypted')throw new Error('The decrypted PDF is still encrypted.');
   }catch{
    workingBytes=bytes;
    nextSignatureState={locked:true,signed:false,count:0,unknown:true,reason:'decrypt'};
   }
  }
  const nextWorkingFileId=workingBytes===bytes?uploadedFileId:await readPdfFileId(workingBytes,PDFLib);
  acceptedPassword=null;
  let nextMetadata=null;try{nextMetadata=await next.getMetadata()}catch{}
  const nextMetadataRecord=makeSourceMetadataRecord({filename:file.name||'document.pdf',byteLength:bytes.length,pageCount:next.numPages,inspection:uploadedInspection,metadata:nextMetadata});
  if(doc)await doc.destroy();doc=next;clearSigning();hashRecord=null;fingerprintedPdf=null;$('hash-pdf-download').disabled=true;$('hash-info').textContent='Choose which file to fingerprint.';$('hash-download').disabled=true;
  original=workingBytes;uploadedOriginal=bytes;sourceFileId=uploadedFileId;workingFileId=nextWorkingFileId;restoreFileId=null;restoreFileIdName='';$('fileid-file').value='';signatureState=nextSignatureState;sourceMetadata=nextMetadataRecord;uploadedMetadata=null;metadataReadVersion++;metadataLoading=false;$('metadata-file').value='';metadataUploadStatus();filename=file.name||'document.pdf';pageNo=1;selected=null;cache=new Map();edits=new Map();positionLocks=new Map();history=[];future=[];clearOriginalFonts();$('filename').textContent=filename;$('controls').hidden=true;$('selectionhint').hidden=false;$('pages').replaceChildren();
  await loadDocumentFonts();
  for(let i=1;i<=doc.numPages;i++){const b=document.createElement('button');b.className='pagebutton';b.dataset.page=i;const label=document.createElement('b');label.textContent=`Page ${i}`;b.append(label,document.createElement('span'));b.onclick=()=>navigate(i);$('pages').append(b)}
  generation++;await setupDocumentViews();
  status(signatureState.reason==='decrypt'?'Password accepted · decryption unavailable · view only':signatureState.locked?'Signature protection on · original-only download':`${workingBytes!==bytes?'PDF unlocked in this browser · editable working copy ready':'Scroll through the document and click text to edit'}${documentFontOptions.length?` · ${documentFontOptions.length} document font${documentFontOptions.length===1?'':'s'} available on every page`:''}`);
  if(signatureState.reason==='decrypt')signatureLockNotice();
  else if(workingBytes!==bytes)notice('Password accepted. An unlocked working copy is ready to edit; the uploaded PDF remains unchanged.');
 }catch(e){
  if(passwordCancelled){notice('Password entry was cancelled. The protected PDF was not opened or changed.');status('Password required to open this PDF');}
  else{notice(e.message||'Unable to open this PDF');status('Could not open PDF')}
 }finally{setBusy(false);$('file').value=''}
}
function navigate(n){finishInline();if(busy||!doc||n<1||n>doc.numPages)return;const view=pageViews.get(n);if(!view)return;pageNo=n;sync();schedulePaint(n);const root=$('drop'),top=root.scrollTop+view.holder.getBoundingClientRect().top-root.getBoundingClientRect().top-16;root.scrollTo({top,behavior:'smooth'})}
async function add(){finishInline();if(!doc||busy)return;if(signatureState.locked){signatureLockNotice();return;}const n=pageNo;await schedulePaint(n);const data=cache.get(n);if(!data)return;const id=`${n}:new:${crypto.randomUUID()}`;const docFont=documentFontOptions[0],b={id,page:n,text:'New text',x:72,y:72,size:12,width:60,height:12,angle:0,fontName:docFont?.baseFont||'New text',font:docFont?.family||'Arial',fallback:docFont?.baseFont||'Arial',color:'#000000',bold:false,italic:false,underline:false,spacing:0,wordSpacing:0,textMode:0,strokeColor:'#000000',strokeWidth:1,lineheight:1.2,align:'left',scaleX:1,ops:[],canEdit:true,added:true};commit(()=>edits.set(id,b));select(id)}
function undo(){if(busy||signatureState.locked)return;finishInline();if(!history.length)return;future.push(snapshot());edits=history.pop();invalidateCurrentExportFingerprint();if(selected&&!currentBlock())selected=null;sync();repaintAllLoaded();if(selected)select(selected);else{$('controls').hidden=true;$('selectionhint').hidden=false}}
function redo(){if(busy||signatureState.locked)return;finishInline();if(!future.length)return;history.push(snapshot());edits=future.pop();invalidateCurrentExportFingerprint();sync();repaintAllLoaded();if(selected&&currentBlock())select(selected)}
function formatBytes(size){return size<1024?`${size} B`:size<1024*1024?`${(size/1024).toFixed(1)} KB`:`${(size/(1024*1024)).toFixed(2)} MB`}
function currentExportName(){return filename.replace(/\.pdf$/i,'')+(uploadedMetadata&&!edits.size?'-metadata-updated.pdf':'-edited.pdf')}

// ---- File identifier (/ID) ----
// A PDF trailer can hold two byte strings: the permanent identifier created with
// the file and the changing identifier rewritten on every save. The uploaded
// original's pair is captured at open time (before any in-browser decryption) and
// written back into exports so downstream file-identity checks stay valid.
async function loadDocumentFonts(){
 fontInventory=null;
 if(!original)return;
 try{fontInventory=await buildDocumentFontInventory(original,PDFLib);await primeDocumentFonts(fontInventory)}catch{fontInventory=null}
}
function documentFontForPage(page){
 const fonts=fontInventory?.pages?.find(entry=>entry.page===Number(page))?.fonts||[];
 return fonts.map(font=>{const known=fontInventory.fonts.find(entry=>entry.key===font.key)||{};return {...font,donorPage:known.programPage??null,label:`${known.displayFamily||font.baseFont}${known.bold?' Bold':''}${known.italic?' Italic':''}`}})
}
function fontDialogText(){
 if(!fontInventory)return 'No font information is available for this document yet.';
 const lines=[fontInventory.fonts.length?`${fontInventory.fonts.length} typeface${fontInventory.fonts.length===1?'':'s'} across ${fontInventory.pageCount} page${fontInventory.pageCount===1?'':'s'}.`:'No text fonts were found in the PDF resources.',''];
 const current=documentFontForPage(pageNo);
 lines.push(`Page ${pageNo} uses:`);
 if(!current.length)lines.push('  (no text fonts on this page)');
 for(const font of current)lines.push(`  ${font.label}  ·  ${font.embedded?'embedded program on this page':font.donorPage?`program reused from page ${font.donorPage}`:'no embedded program · substitute family'}`);
 lines.push('');
 lines.push(formatFontInventory(fontInventory).split('\n').slice(1).join('\n'));
 return lines.join('\n');
}
function syncFontDialog(){
 if(!doc)return;
 $('fontid-info').textContent=fontDialogText();
 const current=documentFontForPage(pageNo),reused=current.filter(font=>!font.embedded&&font.donorPage);
 $('fontid-status').textContent=!fontInventory?'Font inspection is unavailable for this PDF; edits use the detected font or a substitute family.':reused.length?`Page ${pageNo} has no embedded program for ${reused.map(font=>font.label).join(', ')}; edits reuse page ${reused[0].donorPage}'s program, so typed text keeps the document's own typeface.`:`Every font used on page ${pageNo} carries its own embedded program. Document fonts detected on any page are listed in Available font, so they can be used on every page.`;
 $('fontid-clear').disabled=!documentFontOptions.length||busy||signatureState.locked;
}
function openFontDialog(){if(!doc||busy||metadataLoading)return;syncFontDialog();$('fontid-dialog').showModal()}
function selectDocumentFont(family){
 if(!family||busy||signatureState.locked)return;
 const option=documentFontOptions.find(entry=>entry.family===family);
 if(!option)return;
 $('font').value=family;
 const block=currentBlock();
 if(block&&(block.canEdit||block.added)){
  $('text').value=$('text').value||block.text;
  $('fontstatus').textContent=matchingStatus({...block,font:family,text:$('text').value});
  notice(`${option.label} (page ${option.page} font, reused without re-embedding) is selected. Apply changes to use it on page ${block.page}.`);
 }else notice(`${option.label} is available in Available font for any text you edit or add.`);
}
function activeFileId(){return restoreFileId||sourceFileId||null}
function fileIdLines(label,id){
 if(!id)return `${label}\n  No trailer /ID found.`;
 const same=id.permanent===id.changing;
 return `${label}\n  Permanent (created): ${id.permanent}\n  Changing (last save): ${same?'same as permanent':id.changing}`;
}
function workingFileIdChanged(){return !!(workingFileId&&sourceFileId&&!sameFileId(workingFileId,sourceFileId))}
function fileIdDialogText(){
 const target=activeFileId();
 let text=fileIdLines('Uploaded original',sourceFileId)+'\n\n';
 if(workingFileIdChanged())text+=`Working copy after in-browser decryption\n  Permanent (created): ${workingFileId.permanent}\n  Changing (last save): ${workingFileId.changing}\n  The decryption rewrite changed the changing identifier; that value is not exported.\n\n`;
 text+=fileIdLines(restoreFileId?`Identifier to restore from “${restoreFileIdName}”`:'Identifier written into the next export',target);
 return text;
}
function fileIdDialogStatus(){
 if(!doc)return 'Open a PDF to inspect its file identifier.';
 if(signatureState.locked)return 'This document is view-only, so export and download return the uploaded bytes unchanged. Its /ID is already the original.';
 if(restoreFileId)return `The next export writes the /ID pair from “${restoreFileIdName}”. Choose the untouched original PDF if that is not the right file.`;
 if(!sourceFileId)return 'The uploaded PDF has no trailer /ID. If you still have an untouched original that has one, choose it below to restore that identifier.';
 if(workingFileIdChanged())return 'The in-browser decryption gave the working copy a new changing identifier. The next export restores both values from the uploaded original.';
 return 'The next export keeps the uploaded original /ID pair unchanged.';
}
function syncFileIdDialog(){
 if(!doc)return;
 $('fileid-info').textContent=fileIdDialogText();
 $('fileid-status').textContent=fileIdDialogStatus();
 $('fileid-clear').disabled=!restoreFileId||busy||signatureState.locked;
 $('fileid-file').disabled=!!busy||signatureState.locked;
}
function openFileIdDialog(){if(!doc||busy||metadataLoading)return;$('fileid-file').value='';syncFileIdDialog();$('fileid-dialog').showModal()}
function clearRestoredFileId(){
 if(busy)return;
 restoreFileId=null;restoreFileIdName='';$('fileid-file').value='';
 invalidateCurrentExportFingerprint();syncFileIdDialog();sync();status('Using the opened document’s file identifier');
}
async function selectFileIdSource(file){
 if(!file||!doc||busy)return;
 $('fileid-file').value='';
 try{
  if(!file.size)throw new Error('That PDF is empty.');
  if(file.size>128*1024*1024)throw new Error('Choose a PDF under 128 MB.');
  const bytes=new Uint8Array(await file.arrayBuffer());
  const id=await readPdfFileId(bytes,PDFLib);
  if(!id)throw new Error('That PDF has no trailer /ID to restore.');
  restoreFileId=id;restoreFileIdName=file.name||'selected PDF';
  invalidateCurrentExportFingerprint();syncFileIdDialog();sync();
  status('Original file identifier loaded for the next export');
  notice(`The next export writes the /ID pair from “${restoreFileIdName}”. Export again to replace a changed identifier.`);
 }catch(error){notice(error.message||'Could not read that PDF’s file identifier.')}
}
function downloadOriginalCopy(){download(new Blob([uploadedOriginal.slice()],{type:'application/pdf'}),filename);status('Original downloaded unchanged · signature protection on');notice('The original file was downloaded byte-for-byte unchanged. Existing signature validity is not verified here.')}
function clearExportPasswords(){for(const id of ['export-password','export-confirm','export-owner'])$(id).value=''}
function clearExportForm(){clearExportPasswords();$('export-mode-standard').checked=true;$('export-password-fields').hidden=true;for(const id of ['export-password','export-confirm'])$(id).required=false;$('export-feedback').hidden=true;$('export-feedback').textContent='';$('export-submit').disabled=false;$('export-close').disabled=false}
function showExportFeedback(message){$('export-feedback').textContent=message||'';$('export-feedback').hidden=!message}
function syncExportMode(){const encrypted=$('export-mode-encrypted').checked;$('export-password-fields').hidden=!encrypted;for(const id of ['export-password','export-confirm'])$(id).required=encrypted;if(!encrypted)clearExportPasswords();showExportFeedback('')}
function closeExportDialog(){if($('export-dialog').open)$('export-dialog').close();clearExportForm()}
function openExportOptions(){finishInline();if(!doc||busy||metadataLoading)return;if(signatureState.locked){downloadOriginalCopy();return}clearExportForm();$('export-dialog').showModal()}
// An export leaves the statement lined up: amount cells an earlier round left
// short of their column keep their text and font and are written back onto the
// column the rest of the page uses. Reading every page here is a text pass only;
// a page with nothing to line up never reaches the writer.
async function alignmentEdits(edits){
 const aligned=new Map();
 if(!doc)return aligned;
 for(let n=1;n<=doc.numPages;n+=1){
  let cells;
  try{
   const page=await doc.getPage(n);
   const content=await page.getTextContent({includeMarkedContent:false});
   const vp=page.getViewport({scale:1});
   const items=content.items.filter(item=>item.str&&norm(item.str)).map(item=>{const t=pdfjs.Util.transform(vp.transform,item.transform);return {text:item.str,x:t[4],y:t[5],width:item.width}});
   if(!strayColumnCells(items).length)continue;
   const data=await getPage(n);
   cells=strayColumnCells(data.blocks);
  }catch{continue}
  for(const block of cells)if((block.canEdit||block.added)&&!edits.has(block.id)&&!aligned.has(block.id))aligned.set(block.id,{...block});
 }
 return aligned;
}
async function exportPdf(event){
 event?.preventDefault?.();
 finishInline();if(!doc||busy||metadataLoading)return;
 if(signatureState.locked){downloadOriginalCopy();return}
 const encrypted=!!event&&$('export-mode-encrypted').checked;
 let passwords=null;
 if(encrypted){
  if(!$('export-form').reportValidity())return;
  try{passwords=validateExportPasswords({password:$('export-password').value,confirmation:$('export-confirm').value,ownerPassword:$('export-owner').value})}
  catch(error){showExportFeedback(error.message);status('Encrypted export not started');return}
 }
 $('loading').textContent=encrypted?'Exporting native PDF and encrypting…':'Exporting native PDF…';
 $('export-submit').disabled=true;$('export-close').disabled=true;showExportFeedback('');
 setBusy(true);
 try{
  await paintQueue;
  const fileId=activeFileId();
  // Cells that still sit short of their column are handed to the writer as edits
  // that keep their own text, so the export lines the page up without touching
  // what the user typed.
  const aligned=await alignmentEdits(edits);
  const linedUp=aligned.size;
  const exportEdits=linedUp?new Map([...aligned,...edits]):edits;
  const nativeBytes=await exportNativePdf({original,edits:exportEdits,getPage,fonts:loadedFonts,originalFonts,PDFLib,fontkit:window.fontkit,metadataRecord:sourceMetadata,uploadedMetadata,fileId,documentFonts:documentFontPlans(),headerSource:uploadedOriginal,onProgress:status});
  const checkedExport=await enforceFileId({bytes:nativeBytes,fileId,PDFLib});
  const bytes=checkedExport.bytes;
  let idWarning=checkedExport.status==='preserved'||checkedExport.status==='none'?'':fileIdWarning(fileId,checkedExport.actual||null);
  if(encrypted){
   const protectedBytes=await encryptExportCopy({bytes,password:passwords.password,confirmation:passwords.password,ownerPassword:passwords.ownerPassword,algorithm:$('export-algorithm').value,fileId,PDFLib,onProgress:message=>{showExportFeedback(message);status(message)}});
   const protectedId=await readPdfFileId(protectedBytes,PDFLib);
   if(fileId&&!sameFileId(fileId,protectedId))idWarning='The AES-256 copy could not keep the original file identifier.';
   const name=encryptedExportName(currentExportName());
   download(new Blob([protectedBytes],{type:'application/pdf'}),name);
   closeExportDialog();
   status(`Encrypted PDF downloaded · AES-256 · ${formatBytes(protectedBytes.length)} · uploaded original ${formatBytes(uploadedOriginal.length)}${fileId&&!idWarning?' · file ID preserved':''}${linedUp?` · ${linedUp} amount${linedUp===1?'':'s'} lined up`:''}`);
   notice(`AES-256 password-protected PDF downloaded as “${name}”. ${uploadedMetadata?'Your edits and replaced Info/XMP metadata are included.':'Your edits and the existing native metadata are included.'} Passwords stayed in this browser and were cleared; they cannot be recovered.${idWarning?' '+idWarning:''}`)
  }else{
   download(new Blob([bytes],{type:'application/pdf'}),currentExportName());
   closeExportDialog();
   status(`${uploadedMetadata&&!edits.size?'Exported PDF with replaced metadata':'Exported native PDF'} · ${formatBytes(bytes.length)} · uploaded original ${formatBytes(uploadedOriginal.length)}${fileId&&!idWarning?' · file ID preserved':''}${linedUp?` · ${linedUp} amount${linedUp===1?'':'s'} lined up`:''}`);
   notice((uploadedMetadata?'PDF Info/XMP replaced from your JSON; omitted source fields were removed. Exported bytes and hashes changed.':'PDF exported with selectable text and existing graphics. No page images were created.')+(linedUp?` ${linedUp} amount${linedUp===1?'':'s'} that sat short of the column ${linedUp===1?'was':'were'} put back on it; the text is unchanged.`:'')+(idWarning?' '+idWarning:''))
  }
 }catch(error){
  showExportFeedback(error.message||(encrypted?'Encrypted PDF export failed. No password was stored.':'Native PDF export failed. No image conversion was performed.'));
  notice(error.message||'Native PDF export failed. No image conversion was performed.');
  status(encrypted?'Encrypted export could not complete':'Native PDF export could not safely complete')
 }finally{
  clearExportPasswords();
  $('export-submit').disabled=false;$('export-close').disabled=false;
  setBusy(false)
 }
}
let signingCredential=null,hashRecord=null,fingerprintedPdf=null,certificateReadVersion=0;
function clearSigning(){certificateReadVersion++;signingCredential=null;$('p12-password').value='';$('p12-file').value='';$('p12-authorized').checked=false;$('p12-sign').disabled=true;$('p12-info').textContent='Choose a certificate to see the signing identity.';$('sign-feedback').textContent='';}
async function inspectP12(){const readVersion=++certificateReadVersion;signingCredential=null;$('p12-sign').disabled=true;$('p12-inspect').disabled=true;try{const file=$('p12-file').files[0];if(!file)throw new Error('Choose a PFX or P12 certificate.');if(!/\.(pfx|p12)$/i.test(file.name))throw new Error('Choose a .pfx or .p12 file.');const bytes=new Uint8Array(await file.arrayBuffer());if(readVersion!==certificateReadVersion){bytes.fill(0);return;}try{signingCredential=readCertificate(bytes,$('p12-password').value,window.forge);}finally{bytes.fill(0);$('p12-password').value='';}$('p12-info').textContent=JSON.stringify(signingCredential.info,null,2);$('sign-feedback').textContent='Certificate read. Check the identity and confirm your signing authority.';$('p12-sign').disabled=!$('p12-authorized').checked;}catch(e){$('p12-info').textContent='Certificate could not be read.';$('sign-feedback').textContent=e.message;}finally{$('p12-inspect').disabled=false;}}
async function downloadSignedCopy(){finishInline();if(!doc||busy||metadataLoading||signatureState.locked||!signingCredential||!$('p12-authorized').checked)return;const credential=signingCredential;setBusy(true);$('p12-sign').disabled=true;$('sign-close').disabled=true;$('p12-inspect').disabled=true;$('sign-feedback').textContent='Preparing and signing the new copy…';try{await paintQueue;const fileId=activeFileId();const bytes=await exportNativePdf({original,edits,getPage,fonts:loadedFonts,originalFonts,PDFLib,fontkit:window.fontkit,metadataRecord:sourceMetadata,uploadedMetadata,fileId,headerSource:uploadedOriginal,onProgress:status});const result=await signPdfCopy({bytes,sourceBytes:uploadedOriginal,credential,PDFLib,forge:window.forge,fileId});const name=filename.replace(/\.pdf$/i,'')+'-signed-copy.pdf';download(new Blob([result.bytes],{type:'application/pdf'}),name);fingerprintedPdf={blob:new Blob([result.bytes],{type:'application/pdf'}),name};$('hash-pdf-download').disabled=false;hashRecord={file:name,kind:'new signed copy',signer:result.signer,source:result.source,...result.fingerprints};$('hash-info').textContent=JSON.stringify(hashRecord,null,2);$('hash-download').disabled=false;clearSigning();$('sign-dialog').close();$('hash-dialog').showModal();status('Signed copy downloaded · original retained');notice('New signature added with your certificate. Check certificate trust in your PDF reader.');}catch(e){$('sign-feedback').textContent=e.message||'Signing failed.';}finally{signingCredential=null;$('p12-sign').disabled=true;$('p12-password').value='';$('p12-inspect').disabled=false;$('sign-close').disabled=false;setBusy(false);}}
async function calculateFingerprints(current){finishInline();if(!doc||busy||metadataLoading)return;setBusy(true);$('hash-original').disabled=$('hash-current').disabled=true;try{await paintQueue;const bytes=current&&!signatureState.locked?await exportNativePdf({original,edits,getPage,fonts:loadedFonts,originalFonts,PDFLib,fontkit:window.fontkit,metadataRecord:sourceMetadata,uploadedMetadata,documentFonts:documentFontPlans(),fileId:activeFileId(),headerSource:uploadedOriginal}):uploadedOriginal.slice();const name=current&&!signatureState.locked?currentExportName():filename;fingerprintedPdf={blob:new Blob([bytes],{type:'application/pdf'}),name};$('hash-pdf-download').disabled=false;hashRecord={file:name,kind:current&&!signatureState.locked?'current native export':'original',...await fingerprints(bytes)};$('hash-info').textContent=JSON.stringify(hashRecord,null,2);$('hash-download').disabled=false;}catch(e){$('hash-info').textContent=e.message||'Fingerprint calculation failed.';}finally{$('hash-original').disabled=$('hash-current').disabled=false;setBusy(false);}}
function describeMetadataFields(upload,limit=8){
 const names=upload.fields.map(field=>field.key);
 const shown=names.slice(0,limit).join(', ')+(names.length>limit?`, … (${names.length-limit} more)`:'');
 return shown||'no Info fields';
}
function metadataUploadStatus(){
 if(signatureState.locked){$('metadata-upload-status').textContent='This PDF is view-only. Uploaded metadata cannot be embedded.';return}
 if(!uploadedMetadata){$('metadata-upload-status').textContent='No metadata replacement loaded. The source PDF’s native Info/XMP is retained.';return}
 const info=uploadedMetadata.fields.length?`Its ${uploadedMetadata.fields.length} Info field${uploadedMetadata.fields.length===1?'':'s'} replace PDF Info: ${describeMetadataFields(uploadedMetadata)}.`:'It removes the PDF Info dictionary.';
 const xmp=uploadedMetadata.xmpRaw?'The supplied XMP replaces existing XMP.':'Existing XMP is removed.';
 const kind=uploadedMetadata.format==='sidecar'?' Source file report recognised; its real PDF fields are applied and file hashes/structure are ignored.':'';
 $('metadata-upload-status').textContent=`${uploadedMetadata.name} (${formatBytes(uploadedMetadata.byteLength)}) loaded for export. ${info} ${xmp} Omitted original fields are removed.${kind}${uploadedMetadata.ignored.length?' Non-metadata PDF structure fields were ignored.':''}`;
}
function invalidateCurrentExportFingerprint(){
 if(hashRecord?.kind!=='current native export')return;
 hashRecord=null;fingerprintedPdf=null;$('hash-pdf-download').disabled=true;$('hash-download').disabled=true;$('hash-info').textContent='The current export changed. Calculate its fingerprints again.';
}
async function selectMetadataUpload(file){
 if(!file||!doc||busy||signatureState.locked)return;
 const active=doc,version=++metadataReadVersion;metadataLoading=true;$('metadata-upload-status').textContent='Reading metadata JSON…';sync();
 let loaded=false;
 try{
  if(!file.size||file.size>MAX_USER_METADATA_BYTES)throw new Error('Metadata JSON must be between 1 byte and 8 MB.');
  const data=new Uint8Array(await file.arrayBuffer());
  if(version!==metadataReadVersion||active!==doc)return;
  const candidate=parseUploadedMetadata(data,file.name);
  uploadedMetadata=candidate;invalidateCurrentExportFingerprint();loaded=true;metadataUploadStatus();status(`Metadata JSON loaded for export · ${candidate.name} · ${candidate.fields.length} Info field${candidate.fields.length===1?'':'s'}`);
 }catch(error){if(version===metadataReadVersion&&active===doc){metadataUploadStatus();notice(error.message||'Could not read metadata JSON.')}}
 finally{if(version===metadataReadVersion){metadataLoading=false;if(!loaded)$('metadata-file').value='';sync()}}
}
function clearEncryptionForm(){skippedEncryptMetadata='';encryptMetadataVersion++;for(const id of ['encrypt-file','encrypt-metadata','encrypt-password','encrypt-confirm','encrypt-owner'])$(id).value='';$('encrypt-feedback').hidden=true;$('encrypt-feedback').textContent='';$('encrypt-without-metadata').hidden=true;setEncryptMetadataStatus('');}
function showEncryptMetadataFallback(name,message){
 $('encrypt-fallback-message').textContent=`The selected file “${name}” cannot be used as PDF metadata. ${message}`;
 $('encrypt-fallback-dialog').dataset.metadataName=name;
 $('encrypt-fallback-dialog').showModal();
}
async function encryptStandalonePdf(event){
 event.preventDefault();
 if(busy)return;
 const skippedThisRun=skippedEncryptMetadata;
 skippedEncryptMetadata='';
 const file=$('encrypt-file').files[0],password=$('encrypt-password').value,ownerPassword=$('encrypt-owner').value,metadataFile=$('encrypt-metadata').files[0];
 $('encrypt-without-metadata').hidden=true;
 if(!file){$('encrypt-feedback').textContent='Choose a PDF first.';$('encrypt-feedback').hidden=false;return}
 if(password!==$('encrypt-confirm').value){$('encrypt-feedback').textContent='The open passwords do not match.';$('encrypt-feedback').hidden=false;return}
 if(!$('encrypt-form').reportValidity())return;
 let metadataPayload=null;
 if(metadataFile){
  try{
   if(!metadataFile.size||metadataFile.size>MAX_USER_METADATA_BYTES){const error=new Error('Metadata JSON must be between 1 byte and 8 MB.');error.metadataError=true;throw error}
   const data=new Uint8Array(await metadataFile.arrayBuffer());
   parseUploadedMetadata(data,metadataFile.name);
   metadataPayload={name:metadataFile.name,data};
  }catch(error){
   if(error.metadataError){
    setEncryptMetadataStatus(error.message,true);
    $('encrypt-feedback').textContent=error.message;
    $('encrypt-feedback').hidden=false;
    showEncryptMetadataFallback(metadataFile.name,error.message);
    return;
   }
   $('encrypt-feedback').textContent=error.message||'Could not read the metadata JSON.';
   $('encrypt-feedback').hidden=false;
   return;
  }
 }
 $('encrypt-submit').disabled=true;$('encrypt-close').disabled=true;$('encrypt-feedback').hidden=false;$('encrypt-feedback').textContent='Preparing the encrypted copy…';
 setBusy(true);
 try{
  const bytes=new Uint8Array(await file.arrayBuffer());
  const encrypted=await encryptPdfCopy({bytes,password,ownerPassword,algorithm:$('encrypt-algorithm').value,metadataFile:metadataPayload,fileId:await readPdfFileId(bytes,PDFLib),PDFLib,onProgress:message=>{$('encrypt-feedback').textContent=message;status(message)}});
  const name=file.name.replace(/\.pdf$/i,'')+'-encrypted.pdf';
  download(new Blob([encrypted],{type:'application/pdf'}),name);
  $('encrypt-dialog').close();
  clearEncryptionForm();
  status(`Encrypted PDF downloaded · ${formatBytes(encrypted.length)}`);
  notice(skippedThisRun?`PDF encrypted with AES-256. The selected JSON “${skippedThisRun}” was not used because it cannot be written as PDF Info/XMP metadata, so the PDF’s existing native metadata was retained. Keep the open password safe; it cannot be recovered.`:metadataPayload?'PDF encrypted with AES-256 and native Info/XMP replaced from your JSON. Keep the open password safe; it cannot be recovered.':'PDF encrypted with AES-256; existing native metadata was retained. Keep the open password safe; it cannot be recovered.');
 }catch(error){
  const message=error.message||'Could not encrypt this PDF.';
  if(error.metadataError){
   setEncryptMetadataStatus(message,true);
   $('encrypt-feedback').textContent=`${message} Nothing was downloaded. Fix the JSON and try again, or encrypt without it to keep the PDF’s existing native metadata.`;
   $('encrypt-without-metadata').hidden=false;
  }else $('encrypt-feedback').textContent=message;
 }finally{
  setBusy(false);$('encrypt-submit').disabled=false;$('encrypt-close').disabled=false;
 }
}

function setEncryptMetadataStatus(message,warning=false){$('encrypt-metadata-status').hidden=!message;$('encrypt-metadata-status').textContent=message;$('encrypt-metadata-status').classList.toggle('warning',warning);}
async function inspectEncryptMetadata(){
 if(busy)return;
 const version=++encryptMetadataVersion,file=$('encrypt-metadata').files[0];
 $('encrypt-without-metadata').hidden=true;$('encrypt-feedback').hidden=true;$('encrypt-feedback').textContent='';
 if(!file){setEncryptMetadataStatus('');return}
 try{
  if(!file.size||file.size>MAX_USER_METADATA_BYTES)throw new Error('Metadata JSON must be between 1 byte and 8 MB.');
  const data=new Uint8Array(await file.arrayBuffer());
  if(version!==encryptMetadataVersion)return;
  const parsed=parseUploadedMetadata(data,file.name);
  setEncryptMetadataStatus(`${parsed.name} loaded: ${parsed.fields.length} PDF Info field${parsed.fields.length===1?'':'s'} (${describeMetadataFields(parsed)})${parsed.xmpRaw?' and replacement XMP':''}. These become the encrypted PDF’s native Info${parsed.xmpRaw?' and XMP':''}; the JSON file is not attached.${parsed.format==='sidecar'?' Source file report recognised: its real PDF fields are applied and file hashes/structure are ignored.':''}`);
 }catch(error){
  if(version!==encryptMetadataVersion)return;
  error.metadataError=true;
  setEncryptMetadataStatus(`${error.message} Fix the JSON, choose another file, or encrypt without it to keep the PDF’s existing native metadata.`,true);
  $('encrypt-without-metadata').hidden=false;
 }
}
$('encrypt-metadata').onchange=inspectEncryptMetadata;
$('encrypt-metadata-clear').onclick=()=>{if(busy)return;encryptMetadataVersion++;$('encrypt-metadata').value='';$('encrypt-without-metadata').hidden=true;$('encrypt-feedback').hidden=true;$('encrypt-feedback').textContent='';setEncryptMetadataStatus('')};
$('encrypt-without-metadata').onclick=()=>{if(busy)return;encryptMetadataVersion++;$('encrypt-metadata').value='';$('encrypt-without-metadata').hidden=true;$('encrypt-feedback').hidden=true;$('encrypt-feedback').textContent='';setEncryptMetadataStatus('Encrypting without a metadata JSON; the PDF’s existing native metadata is retained.');$('encrypt-form').requestSubmit()};
$('encrypt-fallback-continue').onclick=()=>{const name=$('encrypt-fallback-dialog').dataset.metadataName||'The selected JSON';skippedEncryptMetadata=name;encryptMetadataVersion++;$('encrypt-metadata').value='';$('encrypt-without-metadata').hidden=true;setEncryptMetadataStatus(`Encrypting without “${name}”; the PDF’s existing native Info/XMP metadata is retained.`,true);$('encrypt-fallback-dialog').close();$('encrypt-feedback').hidden=true;$('encrypt-feedback').textContent='';$('encrypt-form').requestSubmit()};
$('encrypt-fallback-back').onclick=()=>{$('encrypt-fallback-dialog').close();$('encrypt-metadata').focus()};
$('encrypt-fallback-close').onclick=()=>$('encrypt-fallback-dialog').close();
$('encrypt').onclick=()=>{if(busy)return;clearEncryptionForm();$('encrypt-dialog').showModal()};$('encrypt-close').onclick=()=>{if(busy)return;clearEncryptionForm();$('encrypt-dialog').close()};$('encrypt-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();else clearEncryptionForm()});$('encrypt-form').onsubmit=encryptStandalonePdf;
$('export-form').onsubmit=exportPdf;
$('export-close').onclick=()=>{if(!busy)closeExportDialog()};$('export-cancel').onclick=()=>{if(!busy)closeExportDialog()};
$('export-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();else closeExportDialog()});
$('export-dialog').addEventListener('close',()=>{if(!busy)clearExportForm()});
$('export-mode-standard').onchange=syncExportMode;$('export-mode-encrypted').onchange=syncExportMode;
$('statement').onclick=openStatementCheck;$('statement-close').onclick=()=>$('statement-dialog').close();$('statement-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault()});$('statement-refresh').onclick=openStatementCheck;$('statement-apply').onclick=applyStatementFixes;$('fontid').onclick=openFontDialog;$('fontid-close').onclick=()=>$('fontid-dialog').close();$('fontid-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault()});$('fontid-clear').onclick=()=>{if(!documentFontOptions.length||busy)return;const first=documentFontOptions[0];selectDocumentFont(first.family);$('fontid-dialog').close()};$('fileid').onclick=openFileIdDialog;$('fileid-close').onclick=()=>$('fileid-dialog').close();$('fileid-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault()});$('fileid-file').onchange=()=>selectFileIdSource($('fileid-file').files[0]);$('fileid-clear').onclick=clearRestoredFileId;
$('metadata').onclick=()=>{if(!doc||busy||!sourceMetadata)return;$('metadata-info').textContent=metadataJson(sourceMetadata);metadataUploadStatus();$('metadata-dialog').showModal();};$('metadata-close').onclick=()=>$('metadata-dialog').close();$('metadata-download').onclick=()=>{if(!sourceMetadata)return;download(new Blob([metadataJson(sourceMetadata)],{type:'application/json'}),'pdf-studio-source-metadata.json');status('Source metadata JSON downloaded');};$('metadata-file').onchange=()=>selectMetadataUpload($('metadata-file').files[0]);$('metadata-remove').onclick=()=>{if(!uploadedMetadata||busy||metadataLoading)return;metadataReadVersion++;uploadedMetadata=null;$('metadata-file').value='';invalidateCurrentExportFingerprint();metadataUploadStatus();sync();status('Metadata replacement removed from the next export');};
$('sign').onclick=()=>{if(doc&&!busy&&!signatureState.locked){clearSigning();$('sign-dialog').showModal();}};$('sign-close').onclick=()=>{clearSigning();$('sign-dialog').close();};$('sign-dialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();else clearSigning();});$('sign-dialog').addEventListener('close',()=>{if(!busy)clearSigning();});$('p12-inspect').onclick=inspectP12;$('p12-file').onchange=()=>{certificateReadVersion++;signingCredential=null;$('p12-sign').disabled=true;$('p12-authorized').checked=false;$('p12-info').textContent='Read the selected certificate to inspect its identity.';};$('p12-authorized').onchange=()=>{$('p12-sign').disabled=!signingCredential||!$('p12-authorized').checked;};$('p12-sign').onclick=downloadSignedCopy;$('hashes').onclick=()=>{if(!doc||busy)return;$('hash-dialog').showModal();};$('hash-close').onclick=()=>$('hash-dialog').close();$('hash-original').onclick=()=>calculateFingerprints(false);$('hash-current').onclick=()=>calculateFingerprints(true);$('hash-pdf-download').onclick=()=>{if(fingerprintedPdf)download(fingerprintedPdf.blob,fingerprintedPdf.name);};$('hash-download').onclick=()=>{if(hashRecord)download(new Blob([JSON.stringify(hashRecord,null,2)],{type:'application/json'}),'pdf-fingerprints.json');};
const downloadUrls=new Map();
// Sandboxed preview iframes can silently block programmatic downloads. The anchor
// must be in the document, and a persistent link lets the user retry or save
// manually when the automatic download never reaches their browser.
function download(blob,name){
 const url=URL.createObjectURL(blob);
 try{const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.rel='noopener';anchor.style.display='none';document.body.append(anchor);anchor.click();anchor.remove()}catch{}
 downloadUrls.set(url,setTimeout(()=>{downloadUrls.delete(url);URL.revokeObjectURL(url)},10*60*1000));
 $('download-ready-name').textContent=name;
 const link=$('download-ready-link');link.href=url;link.download=name;link.textContent='Save again';
 $('download-ready-open').href=url;
 const embedded=window.self!==window.top;
 $('download-ready-hint').textContent=`${formatBytes(blob.size)} ready. If the file did not appear in your Downloads, use the save link${embedded?' or open the preview in its own tab, because embedded previews can block automatic downloads':''}.`;
 $('download-ready-newtab').hidden=!embedded;
 $('download-ready').hidden=false;
}
$('download-ready-close').onclick=()=>{$('download-ready').hidden=true};
$('encrypt-download-hint').hidden=window.self===window.top;
$('download-ready-newtab').onclick=()=>{window.open(location.href,'_blank','noopener')};
async function loadFont(file){if(!file)return;try{if(!/\.(ttf|otf)$/i.test(file.name))throw new Error('Use a TTF or OTF font for native PDF export.');const family=`UploadedFont${++fontCounter}`,data=new Uint8Array(await file.arrayBuffer()),parsed=window.fontkit.create(data);if(!parsed.familyName||typeof parsed.hasGlyphForCodePoint!=='function')throw new Error('Use a single TTF/OTF font, not a font collection.');const loadedStyle=infer(parsed.subfamilyName||parsed.fullName),face=new FontFace(family,data.slice().buffer,{weight:loadedStyle.bold?'700':'400',style:loadedStyle.italic?'italic':'normal'});await face.load();document.fonts.add(face);loadedFonts.set(family,{face,data,name:file.name,parsed,style:loadedStyle});$('font').append(new Option(file.name.replace(/\.[^.]+$/,''),family));$('font').value=family;$('bold').checked=loadedStyle.bold;$('italic').checked=loadedStyle.italic;$('fontstatus').textContent=matchingStatus({...currentBlock(),font:family});notice('Font loaded: '+(parsed.fullName||file.name)+'. Use Best font match to compare its family, style and character coverage.')}catch(error){notice(error.message||'This font could not be loaded. Try a valid TTF or OTF font.')}finally{$('fontfile').value=''}}
async function practice(){const p=await PDFLib.PDFDocument.create();const page=p.addPage([595.28,841.89]);const font=await p.embedFont(PDFLib.StandardFonts.Helvetica),bold=await p.embedFont(PDFLib.StandardFonts.HelveticaBold),italic=await p.embedFont(PDFLib.StandardFonts.HelveticaOblique);page.drawText('PRACTICE',{x:160,y:430,size:64,font:bold,color:PDFLib.rgb(.75,.82,.95),rotate:PDFLib.degrees(35),opacity:.45});page.drawText('DESIGN STUDIO',{x:54,y:775,size:20,font:bold,color:PDFLib.rgb(.1,.22,.48)});page.drawText('A document for practicing text edits',{x:54,y:747,size:12,font:italic,color:PDFLib.rgb(.4,.45,.55)});page.drawLine({start:{x:54,y:727},end:{x:540,y:727},thickness:1,color:PDFLib.rgb(.8,.85,.92)});page.drawText('Typography & alignment',{x:54,y:679,size:16,font:bold});page.drawText('Select any line to change its font, size, spacing or color.',{x:54,y:651,size:12,font});page.drawText('Change the amount below and choose Fixed decimal point.',{x:54,y:626,size:12,font});page.drawText('The original artwork stays behind the replacement text.',{x:54,y:601,size:12,font});page.drawText('Amount',{x:54,y:510,size:12,font:bold});page.drawText('1234.56',{x:410,y:510,size:16,font});page.drawText('0123456789',{x:54,y:460,size:12,font});page.drawText('Header, body and footer text can all be selected.',{x:54,y:367,size:12,font});page.drawLine({start:{x:54,y:85},end:{x:540,y:85},thickness:1,color:PDFLib.rgb(.8,.85,.92)});page.drawText('Practice document | Page 1',{x:54,y:60,size:10,font,color:PDFLib.rgb(.4,.45,.55)});const second=p.addPage([595.28,841.89]);second.drawText('Second page',{x:54,y:775,size:20,font:bold});second.drawText('Untouched pages retain their original PDF structure.',{x:54,y:733,size:12,font});const bytes=await p.save();await openFile(new File([bytes],'practice.pdf',{type:'application/pdf'}))}
$('buildtag').textContent=`export engine v${EXPORT_VERSION}`;$('matchfont').onclick=chooseBestFont;$('open').onclick=$('emptyopen').onclick=()=>{if(!busy)$('file').click()};$('file').onchange=()=>openFile($('file').files[0]);$('sample').onclick=practice;$('zoom').onchange=refreshDocumentZoom;$('prev').onclick=()=>navigate(pageNo-1);$('next').onclick=()=>navigate(pageNo+1);$('add').onclick=add;$('apply').onclick=()=>{if(inline)finishInline();else apply()};$('undo').onclick=undo;$('redo').onclick=redo;$('export').onclick=openExportOptions;$('loadfont').onclick=()=>$('fontfile').click();$('fontfile').onchange=()=>loadFont($('fontfile').files[0]);$('controls').onsubmit=e=>{e.preventDefault();apply()};$('align').onchange=()=>{const b=currentBlock();if(!b)return;const previous=b.align,next=$('align').value;$('decimalhelp').hidden=next!=='decimal';if(next==='decimal'&&previous!=='decimal'&&!positionLocks.get(b.id)?.x){const ctx=canvasForPage(b.page).getContext('2d');const line=b.text.split('\n')[0],i=line.indexOf('.'),prefix=i<0?line:line.slice(0,i),gap=((b.spacing||0)+(prefix.endsWith(' ')?(b.wordSpacing||0):0))*b.scaleX;$('x').value=formatMeasure(textStart(ctx,b,line)+measure(ctx,b,prefix)+(i>0?gap:0))}};$('reset').onclick=()=>{if(!selected)return;const id=selected;commit(()=>edits.delete(id));if(originalBlock(id))select(id);else{selected=null;$('controls').hidden=true;$('selectionhint').hidden=false}};$('delete').onclick=()=>{const b=currentBlock();if(!b||!(b.canEdit||b.added))return;commit(()=>b.added?edits.delete(b.id):edits.set(b.id,{...b,removed:true}));selected=null;$('controls').hidden=true;$('selectionhint').hidden=false};document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!/INPUT|TEXTAREA/.test(e.target.tagName)){e.preventDefault();e.shiftKey?redo():undo()}});for(const event of ['dragenter','dragover'])$('drop').addEventListener(event,e=>{e.preventDefault();e.dataTransfer.dropEffect='copy'});$('drop').addEventListener('drop',e=>{e.preventDefault();const file=e.dataTransfer.files[0];if(file)openFile(file)});
if(document.modelContext?.registerTool){try{document.modelContext.registerTool({name:'inspect_open_pdf',description:'Read the open PDF page and the selected text. Does not change or export the document.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:()=>({filename,page:pageNo,pages:doc?.numPages||0,changedRuns:edits.size,selection:currentBlock()?{text:currentBlock().text,font:currentBlock().fontName,size:currentBlock().size}:null})})}catch{}}
// --- Statement arithmetic -------------------------------------------------
// The check reads every page the same way the viewer does, applies the edits
// already made, and reports where the numbers stop adding up.
let statementReport=null, statementPages=null, statementChecking=false;
async function statementPageData(){
 const pages=[];
 for(let n=1;n<=doc.numPages;n++){
  $('statement-status').textContent=`Reading page ${n} of ${doc.numPages}…`;
  let data;
  try{data=await getPage(n)}catch{continue}
  const originals=new Map(data.blocks.map(block=>[block.id,block]));
  const blocks=data.blocks.map(block=>edits.get(block.id)||block).filter(block=>!block.removed);
  for(const edit of edits.values())if(edit.page===n&&edit.added&&!edit.removed)blocks.push(edit);
  pages.push({page:n,blocks,originals});
 }
 return pages;
}
function renderStatementReport(){
 const report=statementReport;
 if(!report)return;
 $('statement-info').textContent=formatReport(report);
 const fixes=report.fixes?.length||0;
 $('statement-status').textContent=report.empty?'No transaction rows were found. Statement check needs a table with dates, amounts and a running balance.':fixes?`${fixes} balance cell${fixes===1?'':'s'} do not follow from the amounts.${fixes>20?' An edited amount shifts every balance after it, so the fix runs to the end of the statement.':''} Review them, then use Fix balances.`:'Every row adds up. The statement is arithmetically consistent.';
 $('statement-apply').disabled=!fixes||signatureState.locked||busy;
 $('statement-apply').textContent=fixes?`Fix ${fixes} balance${fixes===1?'':'s'}`:'Balances already agree';
 $('statement-refresh').disabled=!doc;
}
async function runStatementCheck(){
 if(!doc)return null;
 statementPages=await statementPageData();
 const extracted=extractStatementRows(statementPages);
 statementReport=checkStatement(extracted.rows);
 statementReport.skipped=extracted.skipped.length;
 renderStatementReport();
 return statementReport;
}
async function openStatementCheck(){
 if(!doc||busy||metadataLoading||statementChecking)return;
 if(!$('statement-dialog').open)$('statement-dialog').showModal();
 statementChecking=true;
 $('statement-apply').disabled=true;$('statement-refresh').disabled=true;
 $('statement-status').textContent='Reading the statement…';
 try{await runStatementCheck()}
 catch(error){statementReport=null;$('statement-info').textContent=error.message||'The statement could not be checked.';$('statement-status').textContent='The check stopped before it finished.'}
 finally{statementChecking=false;$('statement-refresh').disabled=!doc;sync()}
}
// Rewrite only the balance cells that no longer follow from the amounts, in the
// shape the document already uses, then re-check the whole statement.
async function applyStatementFixes(){
 const fixes=statementReport?.fixes||[];
 if(!fixes.length||busy||statementChecking||signatureState.locked)return;
 // One edited amount moves every balance after it, so a big statement can need
 // hundreds of cells rewritten. Say so before touching the document.
 const narrationFixes=fixes.filter(fix=>fix.kind==='narration').length,balanceFixes=fixes.length-narrationFixes;
 if(fixes.length>25){
  const pages=new Set(fixes.map(fix=>fix.page)).size;
  const what=[balanceFixes?`${balanceFixes} balance cell${balanceFixes===1?'':'s'}`:'',narrationFixes?`${narrationFixes} remarks code${narrationFixes===1?'':'s'}`:''].filter(Boolean).join(' and ');
  if(!confirm(`This rewrites ${what} across ${pages} page${pages===1?'':'s'}, so every row after the edited amount adds up again. Continue?`))return;
 }
 setBusy(true);
 try{
  const byPage=new Map();
  for(const fix of fixes){if(!byPage.has(fix.page))byPage.set(fix.page,[]);byPage.get(fix.page).push(fix)}
  const applied=[],missed=[];
  let recorded=false;
  for(const [page,list] of byPage){
   const data=await getPage(page);
   for(const fix of list){
    const candidates=data.blocks.filter(block=>norm((edits.get(block.id)||block).text)===norm(fix.from));
    candidates.sort((a,b)=>Math.hypot(a.x-fix.x,a.y-fix.y)-Math.hypot(b.x-fix.x,b.y-fix.y));
    const target=candidates[0];
    if(!target||!(target.canEdit||target.added)){missed.push(fix);continue}
    if(!recorded){history.push(snapshot());if(history.length>60)history.shift();future=[];recorded=true}
    edits.set(target.id,{...(edits.get(target.id)||target),text:fix.to});
    applied.push(fix);
   }
  }
  if(applied.length){invalidateCurrentExportFingerprint();for(const page of byPage.keys())schedulePaint(page,true)}
  sync();
  await runStatementCheck();
  notice(missed.length?`${applied.length} cell${applied.length===1?'':'s'} updated; ${missed.length} could not be edited here. Undo restores the text.`:`${applied.length} cell${applied.length===1?'':'s'} updated. Undo restores the text.`);
 }catch(error){notice(error.message||'The balances could not be updated.')}
 finally{setBusy(false);sync()}
}
// Local test hook uses the same operations as the interface; no network or document persistence.
window.pdfStudio={practice,getPage,select,apply,exportPdf,renderEdited,embeddedEncode,originalCoverageFor,fontRuns,translatedBlock,nudgeSelection,startInline,finishInline,pageAtReadingLine,setupDocumentViews,schedulePaint,loadDocumentFonts,documentFontForPage,selectDocumentFont,openStatementCheck,applyStatementFixes,get statementReport(){return statementReport},get state(){return {doc,edits,pageNo,cache,pageViews,signatureState,fontInventory,documentFontOptions,originalFonts}}};
