// Native content-stream edits. No page image is created by this module.
import {capturePdfMetadata, restorePdfMetadata, attachSourceMetadata, applyUploadedMetadata} from './metadata.mjs';
import {ensureCatalogVersion} from './pdf-version.mjs';
import {alignHeader} from './header-marker.mjs';
import {applyFileId, sameFileId, fileIdFromDocument} from './file-id.mjs';
import {readDocumentFont, documentFontEncoder} from './document-font.mjs';
import {fontKey} from './font-inventory.mjs';
import {parseAmount} from './statement-check.mjs';
const WS=c=>c===0||c===9||c===10||c===12||c===13||c===32;
const DELIM=c=>WS(c)||'()<>[]{}/%'.includes(String.fromCharCode(c));
const ascii=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return s};
const bytes=s=>Uint8Array.from(s,c=>c.charCodeAt(0));
const number=value=>{if(!Number.isFinite(value))throw new Error('Invalid PDF text coordinate.');return String(Math.round(value*1e7)/1e7)};
const hex=data=>Array.from(data,b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
function tokenize(source){let pos=0;function skip(){while(pos<source.length){const c=source.charCodeAt(pos);if(WS(c)){pos++;continue}if(c===37){while(pos<source.length&&!/[\r\n]/.test(source[pos]))pos++;continue}break}}function next(){skip();if(pos>=source.length)return null;const start=pos,c=source[pos++];if(c==='('){let depth=1,result=[];while(pos<source.length&&depth){let ch=source[pos++];if(ch==='\\'){if(pos>=source.length)break;ch=source[pos++];if(ch==='\r'){if(source[pos]==='\n')pos++;continue}if(ch==='\n')continue;const escapes={n:10,r:13,t:9,b:8,f:12};if(ch in escapes)result.push(escapes[ch]);else if(/[0-7]/.test(ch)){let oct=ch;for(let i=0;i<2&&/[0-7]/.test(source[pos]||'x');i++)oct+=source[pos++];result.push(parseInt(oct,8)&255)}else result.push(ch.charCodeAt(0))}else if(ch==='('){depth++;result.push(40)}else if(ch===')'){if(--depth)result.push(41)}else if(ch==='\r'){if(source[pos]==='\n')pos++;result.push(10)}else result.push(ch.charCodeAt(0))}if(depth)throw new Error('Unterminated PDF string.');return {kind:'string',value:Uint8Array.from(result),start,end:pos}}if(c==='<'&&source[pos]!=='<'){let h='';while(pos<source.length&&source[pos]!=='>'){const ch=source[pos++];if(!/\s/.test(ch)){if(!/[\da-f]/i.test(ch))throw new Error('Invalid PDF hexadecimal string.');h+=ch}}if(source[pos++]!=='>')throw new Error('Unterminated PDF hexadecimal string.');if(h.length%2)h+='0';return {kind:'string',value:Uint8Array.from(h.match(/../g)||[],x=>parseInt(x,16)),start,end:pos}}if(c==='['){const value=[];while(true){skip();if(source[pos]===']'){pos++;break}const item=next();if(!item)throw new Error('Unterminated PDF array.');value.push(item)}return {kind:'array',value,start,end:pos}}if(c==='<'&&source[pos]==='<'){pos++;const value=[];while(true){skip();if(source.slice(pos,pos+2)==='>>'){pos+=2;break}const item=next();if(!item)throw new Error('Unterminated PDF dictionary.');value.push(item)}return {kind:'dict',value,start,end:pos}}if(c==='/'){while(pos<source.length&&!DELIM(source.charCodeAt(pos)))pos++;return {kind:'name',value:source.slice(start+1,pos).replace(/#([\da-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16))),start,end:pos}}if(')]>{}'.includes(c))throw new Error('Unexpected PDF delimiter.');while(pos<source.length&&!DELIM(source.charCodeAt(pos)))pos++;const raw=source.slice(start,pos);return {kind:/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)?'number':/^(true|false|null)$/.test(raw)?'value':'operator',value:/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)?Number(raw):raw,start,end:pos}}return {next}}
export function parseContent(source){const lexer=tokenize(source),operations=[];let operands=[],token;while((token=lexer.next())){if(token.kind!=='operator'){operands.push(token);continue}if(token.value==='BI')throw new Error('This page contains an inline image stream that cannot be safely edited yet. No image conversion was performed.');operations.push({op:token.value,args:operands,start:operands[0]?.start??token.start,end:token.end});operands=[]}if(operands.length)throw new Error('Incomplete PDF content operation.');return operations}
function lookup(dict,key,L){return dict?.lookupMaybe(L.PDFName.of(key),L.PDFDict)}
function getDecoded(stream,L){if(stream instanceof L.PDFRawStream)return L.decodePDFRawStream(stream).decode();if(stream instanceof L.PDFStream)return stream.getUnencodedContents();throw new Error('Unsupported PDF content stream. No image conversion was performed.')}
function collectContent(value,context,L){if(!value)return '';const object=context.lookup(value);if(object instanceof L.PDFArray){let content='';for(let i=0;i<object.size();i++)content+=collectContent(object.get(i),context,L)+'\n';return content}return ascii(getDecoded(object,L))}
function cloneResources(resources,context,L){const root=resources?resources.clone(context):context.obj({});for(const key of ['Font','XObject']){const sub=lookup(root,key,L);root.set(L.PDFName.of(key),sub?sub.clone(context):context.obj({}))}return root}
function glyphBytes(raw,codes,type0){const paths=new Map();function solve(i,offset){const key=i+':'+offset;if(paths.has(key))return paths.get(key);if(i===codes.length)return offset===raw.length?[]:null;if(raw.length-offset<codes.length-i)return null;const sizes=type0?[2,1,3,4]:[1,2,3,4];for(const length of sizes){if(offset+length>raw.length)continue;let code=0;for(let j=0;j<length;j++)code=code*256+raw[offset+j];if(code!==codes[i])continue;const rest=solve(i+1,offset+length);if(rest!==null){const answer=[raw.slice(offset,offset+length),...rest];paths.set(key,answer);return answer}}paths.set(key,null);return null}return solve(0,0)}
function concatenate(parts){const total=parts.reduce((n,p)=>n+p.length,0),result=new Uint8Array(total);let i=0;for(const p of parts){result.set(p,i);i+=p.length}return result}
function stringBytes(operation){const a=operation.args;if(operation.op==='TJ'){const arr=a[0];if(arr?.kind!=='array')throw new Error('Malformed PDF text array.');return concatenate(arr.value.filter(x=>x.kind==='string').map(x=>x.value))}const text=a.at(-1);if(text?.kind!=='string')throw new Error('Malformed PDF text string.');return text.value}
function decodeGlyphs(slot,info,L){const glyphs=info.glyphs.filter(g=>typeof g!=='number');const raw=stringBytes(slot.operation);const subtype=slot.fontDict?.get(L.PDFName.of('Subtype'))?.toString();const decoded=glyphBytes(raw,glyphs.map(g=>g.originalCharCode),subtype==='/Type0');if(!decoded)throw new Error('Text encoding did not match the original drawing operation. No image conversion was performed.');return {glyphs,decoded}}
function advanceOnly(slot,info){if(!(slot.state.size>0))throw new Error('Unsupported text advance. No image conversion was performed.');const unit=(info.font.fontMatrix?.[0]??.001);let adjustment=0;for(const g of info.glyphs){if(typeof g==='number')adjustment+=g;else adjustment-=g.width*unit*1000+(slot.state.spacing+(g.isSpace?slot.state.word:0))*1000/slot.state.size}const prefix=slot.operation.op==="'"?'T* ':slot.operation.op==='"'?`${number(slot.state.word)} Tw ${number(slot.state.spacing)} Tc T* `:'';return `${prefix}[${number(adjustment)}] TJ`}
// Advance of one text-show operation in 1000-unit text space (the unit TJ
// numbers use). Positive means the pen moved forward.
function operationAdvance(slot,info){const size=slot.state.size||0;if(!(size>0))return null;const unit=info.font?.fontMatrix?.[0]??.001;let advance=0;for(const g of info.glyphs){if(typeof g==='number'){advance-=g;continue}advance+=g.width*unit*1000+(slot.state.spacing+(g.isSpace?slot.state.word:0))*1000/size}return advance}
// A resource name that looks like the document's own: F1, F2 … instead of a
// name that names the editor.
function freshName(dict,prefix,counter,L){let name;do{name=L.PDFName.of(`${prefix}${++counter.value}`)}while(dict.has(name));return name}
// The page may already name the very object we want to draw with. Reusing that
// name keeps the resource dictionary exactly as the producer wrote it, instead
// of adding a second name for one font program.
function existingName(dict,ref){if(!dict||!ref)return null;const target=ref.toString();for(const [key,value] of dict.entries())if(value?.toString()===target)return key;return null}
// Only the characters changed: same font, size, position, colors and spacing.
// Such an edit can be written into the original operator, which leaves no
// deleted text, no spacing-only trace and no extra font resource.
function sameTextStyle(current,original){
 if(!current||!original)return false;
 if(current.font!=='original')return false;
 if(original.font&&original.font!=='original')return false;
 for(const key of ['size','x','y','color','strokeColor','strokeWidth','textMode','spacing','wordSpacing','lineheight','align','scaleX','underline','bold','italic'])if(String(current[key]??'')!==String(original[key]??''))return false;
 return true;
}
// Replace the original show operations in place. The first operator carries the
// new glyphs plus one TJ adjustment that keeps the following text exactly where
// it was; the remaining operators of the same run are removed outright.
function patchInPlace(pairs,text,encoder,L){
 const first=pairs[0];if(!first)return null;
 if(pairs.some(pair=>pair.slot.fontDict!==first.slot.fontDict))return null;
 const size=first.slot.state.size;if(!(size>0))return null;
 if(originalMissingChars(first.map,text).length)return null;
 let total=0;for(const pair of pairs){const advance=operationAdvance(pair.slot,pair.info);if(advance===null)return null;total+=advance}
 let encoded;try{encoded=encoder(text,size)}catch{return null}
 const widthUnits=(encoded.width||0)*1000/size;
 const prefix=first.slot.operation.op==="'"?`T* `:first.slot.operation.op==='"'?`${number(first.slot.state.word)} Tw ${number(first.slot.state.spacing)} Tc T* `:'';
 const show=encoded.show?encoded.show.replace(/^\[/,'').replace(/\]\s*TJ$/,''):`<${encoded.hex}>`;
 // A TJ adjustment that makes the new run end exactly where the old one did is a
 // horizontal squeeze, and a forensic check reads it as edited text. It is also
 // pointless when nothing follows on the line, so it is only written when later
 // text really depends on the pen position and the difference is noticeable.
 // A value in a money column is placed by its right edge. Rewriting it inside the
 // old show operation would leave the column ragged, so a value whose width
 // changed is left to the caller, which moves it instead of squeezing it.
 if(valueInColumn(text)&&Math.abs(widthUnits-total)>10)return null;
 if(!pairs.some(pair=>!deletable(pair.slot)))return `${prefix}${encoded.show||`<${encoded.hex}> Tj`}`;
 const adjust=Math.round((widthUnits-total)*1000)/1000;
 if(Math.abs(adjust)<Math.max(10,widthUnits*.02))return `${prefix}${encoded.show||`<${encoded.hex}> Tj`}`;
 return `${prefix}[${show} ${number(adjust)}] TJ`;
}
// Removing a show operation shifts every later run on the same line, so the
// remaining advance has to be written somehow. When the next operator starts a
// fresh line (or the text object ends) nothing depends on the pen position, and
// the operation can simply disappear — which leaves no deleted-text trace.
const LINE_RESETS=new Set(['T*','Td','TD','Tm',"'",'"','ET','BT']);
function deletable(slot){
 const operations=slot.node.operations||[];
 const index=operations.indexOf(slot.operation);
 if(index<0)return false;
 for(let i=index+1;i<operations.length;i++){
  const op=operations[i].op;
  if(['Tj','TJ',"'",'"'].includes(op))return false;
  // Path and colour operators do not move the pen but do not start a new
  // line either, so only explicit line resets make removal safe.
  if(LINE_RESETS.has(op))return true;
 }
 return true;
}
// Rewrite an edited run inside its own text object: the original show operation
// is replaced by the new glyphs carrying their own state operators. Nothing is
// drawn in an appended block, so the export has no "characters removed, spacing
// kept" gap and no separately drawn replacement text.
// Write one line of a block inside the text object it already lives in, using
// the fonts that page already names. Only operators whose value differs from
// what the producer left in effect are emitted, so the replacement keeps the
// document's own operator vocabulary.
function drawInPlace(block,segments,viewport,original,matrixOp=null,matrixPatches=null,placement=null,placeable=true,ctm=null,nested=false,columnEdge=null){
 const inv=inverse(viewport.transform),lines=String(block.text??'').split('\n').filter(line=>line.length);
 const scale=formScale(ctm);
 // A run inside a form is written in the form's own coordinates, so a position
 // taken from the page has to be pulled back through the matrix chain.
 const place=matrix=>ctm&&!(ctm[0]===1&&ctm[1]===0&&ctm[2]===0&&ctm[3]===1&&ctm[4]===0&&ctm[5]===0)?compose(inverse(ctm),matrix):matrix;
 if(!lines.length||!segments.length)return null;
 // A moved or re-aligned block is placed from its own coordinates; only an edit
 // that leaves the block where it was may reuse the producer's placement.
 const moved=placementChanged(block,original);
 // A form clips its own content. A block the user moved can end up outside that
 // clip, where the page would silently drop it; the page stream has no such clip,
 // so it is drawn there instead. The run is still removed from the form, which
 // keeps the page from showing the old value as well.
 if(moved&&nested)return null;
 const differs=(key,fallback)=>String(block[key]??fallback)!==String(original?.[key]??fallback);
 const mode=[0,1,2].includes(Number(block.textMode))?Number(block.textMode):0;
 const originalMode=[0,1,2].includes(Number(original?.textMode))?Number(original.textMode):0;
 let content='';
 if(Number(block.spacing||0)!==Number(original?.spacing||0))content+=`${number(block.spacing||0)} Tc\n`;
 if(Number(block.wordSpacing||0)!==Number(original?.wordSpacing||0))content+=`${number(block.wordSpacing||0)} Tw\n`;
 if(mode!==originalMode)content+=`${mode} Tr\n`;
 if(String(block.color||'')!==String(original?.color||''))content+=`${rgb(block.color).map(number).join(' ')} rg\n`;
 if(mode!==0&&mode!==originalMode){
  const strokeHex=/^#[0-9a-f]{6}$/i.test(block.strokeColor||'')?block.strokeColor:block.color;
  content+=`${rgb(strokeHex).map(number).join(' ')} RG\n${number(block.strokeWidth??1)} w\n`;
 }
 for(const [index,line] of lines.entries()){
  const y=block.y+index*block.size*block.lineheight;
  let lineSegments=segments;
  if(lines.length>1){
   // Multi-line blocks are written with the first segment's font; the caller
   // only offers more than one segment for a single line.
   lineSegments=[{...segments[0],text:line}];
  }
  let cursor=placedStart(block,lineSegments,original,!moved,columnEdge);
  // A run that already has a producer matrix is placed from that matrix, not
  // from the preview's coordinates: same decimals, same row. A moved block has
  // no such matrix to reuse, and a squeezed one must not be inherited: text
  // written through a 0.96 scale matrix reads as a squeezed edit.
  const uniform=!matrixOp||!!matrixOrigin(matrixOp);
  const exact=index===0&&!moved&&uniform&&scale===1&&columnEdge===null?placement:null;
  if(exact)cursor=exact.x;
  for(const segment of lineSegments){
   const encoded=segment.encoder(segment.text,block.size);
   // The producer placed every value with a plain translation matrix. Write the
   // replacement the same way, and write nothing at all when the pen is already
   // there — a second matrix is what makes an edit stand out.
   const where=!moved&&uniform&&(exact
    ?Math.abs(exact.x-exact.origin.x)<1e-9&&Math.abs(exact.y-exact.origin.y)<1e-9
    :(index===0&&original&&Math.abs(cursor-Number(original.xExact??original.x))<1e-6&&Math.abs(y-Number(original.yExact??original.y))<1e-6));
   // The block's size is measured in page units. A replacement given a fresh
   // page-space matrix already cancels the form's own scale, so it states the
   // size as the editor shows it; a kept producer matrix is still inside that
   // scale, so the size is divided back through it.
   if(differs('size',0)||segment.fontName!==original?.fontResourceName||(!where&&scale!==1))
    content+=`${segment.fontName} ${number(where?block.size/scale:block.size)} Tf\n`;
   if(!where){
    // A new Tm inside a text object that draws more than one run moves every
    // later run with it. When this object's own matrix cannot be replaced, the
    // block is drawn separately instead, which leaves the neighbours alone.
    if(!placeable)return null;
    const matrix=exact
     ?`1 0 0 1 ${number(exact.x)} ${number(exact.y)} Tm`
     :`${place(compose(inv,[1,0,0,-1,cursor,y])).map(number).join(' ')} Tm`;
    // The producer already wrote a matrix for this run: give it the new value
    // instead of leaving two, so the object still has one placement.
    if(index===0&&matrixOp&&matrixPatches)matrixPatches.push({start:matrixOp.start,end:matrixOp.end,text:matrix});
    else content+=`${matrix}\n`;
   }
   content+=`${encoded.show||`<${encoded.hex}> Tj`}\n`;
   cursor+=encoded.width;
  }
 }
 return content;
}
// Split text into runs each of which one already-present font can write. A table
// cell split over a label font and a value font stays one text object.
function splitRuns(text,segments){
 const runs=[];let index=0;
 while(index<text.length){
  let best=null;
  for(const segment of segments){
   let end=index;
   while(end<text.length&&segment.covers(text[end]))end++;
   if(end>index&&(!best||end>best.end))best={segment,end};
  }
  if(!best)return null;
  runs.push({...best.segment,text:text.slice(index,best.end)});
  index=best.end;
 }
 return runs;
}
// The placement a producer wrote for this run, at the precision it wrote it.
// A rewritten value must keep the row's baseline exactly: re-deriving the same
// number from the preview's rounded block coordinates turns 403.23749 into
// 403.237, which is the trace of another program writing into the page.
// The origin a run written with Td landed on: every show keeps the text-object
// placement its own Td chain asked for, which is where the page actually paints it.
function translateOrigin(origin,tx,ty){return [origin[0],origin[1],origin[2],origin[3],origin[0]*tx+origin[2]*ty+origin[4],origin[1]*tx+origin[3]*ty+origin[5]]}
function matrixOrigin(op){
 try{
  const v=(op?.args||[]).map(arg=>Number(arg?.value??arg));
  if(v.length!==6||!v.every(Number.isFinite))return null;
  if(v[0]!==1||v[1]!==0||v[2]!==0||v[3]!==1)return null;
  return {x:v[4],y:v[5]};
 }catch{return null}
}
// Where the replacement goes, measured from the producer's own origin: a column
// value keeps the right edge the document ended at, prose keeps its left edge.
// Both advances come from the same encoder, so a width table that is a little
// optimistic about a glyph cancels between the two and the edge still lands.
function exactPlacement(pairs,block,segments,matrixOp,original){
 const origin=matrixOp?matrixOrigin(matrixOp):null;
 if(!origin||segments.length!==1||block.text.indexOf('\n')>=0)return null;
 const encoder=segments[0].encoder;
 const previous=String(pairs[0].info?.str??original?.text??'');
 if(!previous)return null;
 const before={...block,spacing:original?.spacing??block.spacing,wordSpacing:original?.wordSpacing??block.wordSpacing};
 let advanceBefore,advanceAfter;
 try{
  advanceBefore=textMetrics(encoder,previous,before).width;
  advanceAfter=textMetrics(encoder,block.text,block).width;
 }catch{return null}
 if(!Number.isFinite(advanceBefore)||!Number.isFinite(advanceAfter))return null;
 const column=valueInColumn(previous)&&valueInColumn(block.text);
 return {x:column?origin.x+(advanceBefore-advanceAfter):origin.x,y:origin.y,origin};
}
// A producer that painted the same value twice leaves the editor with two blocks
// over one run: the coordinates in the preview then belong to the other block, and
// removing this run would delete the text the user never selected. When the run's
// own matrix paints somewhere else than the block claims, the run is left alone and
// the replacement is drawn beside it.
function paintsElsewhere(block,matrixOp,ctm,viewport){
 const origin=matrixOp?matrixOrigin(matrixOp):null;
 if(!origin)return false;
 try{
  // Both are matrices applied to the run's own origin; the point painted is the
  // translation they end at.
  const painted=compose(ctm||[1,0,0,1,0,0],[1,0,0,1,origin.x,origin.y]);
  const claimed=compose(inverse(viewport.transform),[1,0,0,-1,Number(block.x),Number(block.y)]);
  // Only the horizontal axis is compared: the run's own x is the same number the
  // editor shows, while y depends on the viewer's page transform.
  return Math.abs(painted[4]-claimed[4])>1.5;
 }catch{return false}
}
// The editor numbers text runs in its own order, and a producer that paints one
// value twice can make an index name the wrong copy: the block then shows one
// place and its operation paints another. The run that actually paints where the
// block is wins; otherwise the index is trusted as before.
function paintedPoint(slot){
 try{
  const origin=slot?.textObject?.origin;
  if(!origin||origin.length!==6)return null;
  const at=compose(slot.node?.ctm||[1,0,0,1,0,0],[1,0,0,1,Number(origin[4]),Number(origin[5])]);
  return [at[4],at[5]];
 }catch{return null}
}
function runAt(block,viewport,expected,entries){
 const point=(()=>{try{const m=compose(inverse(viewport.transform),[1,0,0,-1,Number(block.x),Number(block.y)]);return [m[4],m[5]]}catch{return null}})();
 if(!point)return null;
 const want=String(block.text??'');
 for(const entry of entries){
  if(String(entry.info?.str??'')!==want)continue;
  const at=paintedPoint(entry.slot);
  if(at&&Math.abs(at[0]-point[0])<=1.5&&Math.abs(at[1]-point[1])<=1.5)return entry;
 }
 return expected;
}
function rewriteInPlace(pairs,block,fontResources,viewport,targets,original,matrixPatches=null,L=null,nodeFontResources=null,columnEdge=null){
 if(block.removed||!String(block.text??'')||block.underline)return null;
 const first=pairs[0];if(!first)return null;
 // All runs of the block have to live in one content stream; their fonts may
 // differ, because the replacement is written with fonts the page already has.
 if(pairs.some(pair=>pair.slot.node!==first.slot.node))return null;
 if(!(Number(block.size)>0))return null;
 // The name a run may use is the one its own resources dictionary defines: text
 // inside a form is written with the form's font names, not the page's.
 const nodeFonts=nodeFontResources||(L?lookup(first.slot.node?.resources,'Font',L):null)||fontResources;
 const usable=[];
 for(const target of targets||[]){
  if(!target)continue;
  const fontName=existingName(nodeFonts,target.fontObject)||existingName(fontResources,target.fontObject);
  if(!fontName)continue;
  usable.push({...target,fontName:fontName.toString()});
 }
 if(!usable.length)return null;
 const singleLine=block.text.indexOf('\n')<0;
 let segments=null;
 for(const target of usable){
  try{target.encoder(block.text,block.size);segments=[{...target,text:block.text}];break}catch{}
 }
 if(!segments&&singleLine&&block.align==='left'){
  const runs=splitRuns(block.text,usable.map(target=>({...target,covers:character=>target.map?target.map.has(character):false})));
  if(runs)segments=runs;
 }
 if(!segments)return null;
 // Tell the writer which font the object already had, so an unchanged font is
 // not restated: the replacement keeps the producer's exact operator sequence.
 const originalFontName=existingName(nodeFonts,first.slot.fontObject)||existingName(fontResources,first.slot.fontObject);
 // A matrix can only be reused when the text object exists to place this one run.
 const holder=first.slot.textObject;
 const matrixOp=matrixPatches&&pairs.length===1&&holder&&holder.shows.length===1?first.slot.matrixAt:null;
 // The run is kept when its own placement contradicts the block's coordinates.
 const paintMatrix=matrixOp||(first.slot.textObject?.origin?.length===6?{args:first.slot.textObject.origin.map(value=>({value}))}:null);
 if(placementChanged(block,original)&&paintsElsewhere(original||block,paintMatrix,first.slot.node?.ctm,viewport))return false;
 try{const placement=matrixOp?exactPlacement(pairs,block,segments,matrixOp,original):null;const placeable=!!matrixOp||(holder&&holder.shows.length===1);return drawInPlace(block,segments,viewport,{...original,fontResourceName:originalFontName?originalFontName.toString():null},matrixOp,matrixPatches,placement,placeable,first.slot.node?.ctm,!!first.slot.node?.nested,columnEdge)}catch{return null}
}
function buildTree(source,resources,state,context,L,slots,ancestors=[],depth=0){if(depth>30)throw new Error('PDF form nesting is too deep.');const ctmStart=state.ctm||[1,0,0,1,0,0];const node={source,resources,patches:[],forms:[],ctm:ctmStart};let current={...state},saves=[],textObject=null,ctm=ctmStart;node.operations=parseContent(source);for(const operation of node.operations){const a=operation.args;if(operation.op==='BT'){textObject={matrix:null,shows:[],moved:false,origin:[1,0,0,1,0,0]}}
if(operation.op==='q')saves.push({...current,ctm});else if(operation.op==='Q'){const savedState=saves.pop();if(savedState){current=savedState;if(savedState.ctm)ctm=savedState.ctm}}else if(operation.op==='cm'){ctm=compose(ctm,a.slice(0,6).map(value=>Number(value?.value??value)))}else if(operation.op==='Tf'){const fonts=lookup(resources,'Font',L),key=a[0]?.value;const fontObject=fonts?.get(L.PDFName.of(key||''));current={...current,fontObject,fontDict:fontObject?context.lookup(fontObject,L.PDFDict):null,size:a[1]?.value}}else if(operation.op==='Tc')current.spacing=a[0]?.value;else if(operation.op==='Tw')current.word=a[0]?.value;else if(operation.op==='gs'){const ext=lookup(resources,'ExtGState',L),g=ext?.lookupMaybe(L.PDFName.of(a[0]?.value||''),L.PDFDict),font=g?.lookupMaybe(L.PDFName.of('Font'),L.PDFArray);if(font)current={...current,fontObject:font.get(0),fontDict:context.lookup(font.get(0),L.PDFDict),size:font.lookup(1,L.PDFNumber).asNumber()}}else if(['Tj','TJ',"'",'"'].includes(operation.op)){if(operation.op==='"'){current.word=a[0]?.value;current.spacing=a[1]?.value}if(!current.fontObject)throw new Error('PDF text has no resolvable font resource.');if(textObject){textObject.shows.push(operation);if(operation.op==="'"||operation.op==='"')textObject.moved=true}slots.push({node,operation,state:{...current},fontObject:current.fontObject,fontDict:current.fontDict,textObject,matrixAt:textObject&&!textObject.moved?textObject.matrix:null})}else if(operation.op==='Tm'){if(textObject){textObject.matrix=operation;textObject.origin=a.slice(0,6).map(value=>Number(value?.value??value))}}else if(operation.op==='Td'||operation.op==='TD'||operation.op==='T*'){if(textObject){textObject.moved=true;if(operation.op==='T*')textObject.origin=null;else{const tx=Number(a[0]?.value??a[0]),ty=Number(a[1]?.value??a[1]);textObject.origin=textObject.origin&&Number.isFinite(tx)&&Number.isFinite(ty)?translateOrigin(textObject.origin,tx,ty):null}}}else if(operation.op==='Do'){const xobjects=lookup(resources,'XObject',L),key=L.PDFName.of(a[0]?.value||''),ref=xobjects?.get(key),object=ref?context.lookup(ref):null;if(object instanceof L.PDFStream&&object.dict.get(L.PDFName.of('Subtype'))?.toString()==='/Form'){if(ancestors.includes(object))throw new Error('Recursive PDF form cannot be safely edited.');const childResources=lookup(object.dict,'Resources',L)||resources;const matrixEntry=object.dict.get(L.PDFName.of('Matrix'));const formCtm=compose(ctm,matrixEntry instanceof L.PDFArray?matrixEntry.asArray().map(value=>Number(value?.value??value)):[1,0,0,1,0,0]);const child=buildTree(ascii(getDecoded(object,L)),childResources,{...current,ctm:formCtm},context,L,slots,[...ancestors,object],depth+1);child.nested=true;node.forms.push({operation,object,child})}}}return node}
function applyPatches(source,patches){let text=source;for(const p of [...patches].sort((a,b)=>b.start-a.start))text=text.slice(0,p.start)+p.text+text.slice(p.end);return text}
function saveTree(node,context,L,counter){let resources=null;const patches=[...node.patches];for(const form of node.forms){const child=saveTree(form.child,context,L,counter);if(!child.changed)continue;if(!resources)resources=cloneResources(node.resources,context,L);const dict=form.object.dict.clone(context);dict.delete(L.PDFName.of('Filter'));dict.delete(L.PDFName.of('DecodeParms'));dict.delete(L.PDFName.of('Length'));dict.set(L.PDFName.of('Resources'),child.resources||form.child.resources);const stream=context.flateStream(bytes(child.source));for(const [key,value] of dict.entries())stream.dict.set(key,value);const ref=context.register(stream),xs=lookup(resources,'XObject',L);const name=freshName(xs,'Fm',counter,L);xs.set(name,ref);patches.push({start:form.operation.start,end:form.operation.end,text:`${name.toString()} Do`})}return {changed:patches.length>0,source:applyPatches(node.source,patches),resources}}
export function originalMissingChars(map,text){return [...new Set(Array.from(String(text??'').replace(/[\r\n]/g,'')))].filter(char=>!map?.has(char))}
function originalEncoder(map,text,size){let encoded=[],width=0,count=0;const keys=[...map.keys()].sort((a,b)=>b.length-a.length);for(let i=0;i<text.length;){let match=keys.find(k=>text.startsWith(k,i));if(!match)throw new Error(`The original font cannot encode ${JSON.stringify(text[i])}. Choose an available font or load a TTF/OTF font; no image conversion was performed.`);const item=map.get(match);encoded.push(item.bytes);width+=item.unitWidth*size;count++;i+=match.length}return {hex:hex(concatenate(encoded)),width,count}}
// A font dictionary this document already has can write the text with a plain
// string. The producer's own operators use one, so a replacement does too: a
// tokenised TJ is only needed when word spacing has to be written as an offset.
export function documentHexEncoder(font){
 const advance=code=>((font.widths.get(code)??font.defaultWidth)/1000);
 return (text,size)=>{
  const chars=Array.from(String(text??'').replace(/[\r\n]/g,''));
  let hex='',width=0;
  for(const char of chars){
   const entry=font.codes.get(char);
   if(!entry)throw new Error(`This PDF's embedded font has no character mapping for ${JSON.stringify(char)}.`);
   hex+=entry.code;width+=advance(entry.code)*size;
  }
  return {hex,width,count:chars.length};
 };
}
function standardName(block){const family=block.font==='original'?block.fallback:block.font;if(/Times|Georgia/.test(family))return block.bold?(block.italic?'Times-BoldItalic':'Times-Bold'):(block.italic?'Times-Italic':'Times-Roman');const mono=/Courier/.test(family),root=mono?'Courier':'Helvetica';return root+(block.bold?(block.italic?'-BoldOblique':'-Bold'):(block.italic?'-Oblique':''))}
// The advance of a run as the document's own font defines it. block.scaleX is a
// browser measurement correction (item.width / canvas width); writing it into the
// page would squeeze the replacement into the old width, which is the one thing a
// forensic check reads as an edit.
function textMetrics(encoder,text,block){const item=encoder(text,block.size),spaces=(String(text??'').match(/ /g)||[]).length;return {...item,width:item.width+Math.max(0,item.count-1)*(block.spacing||0)+spaces*(block.wordSpacing||0)}}
export function alignedStart(encoder,line,b){if(b.align==='right')return b.x-textMetrics(encoder,line,b).width;if(b.align==='center')return b.x-textMetrics(encoder,line,b).width/2;if(b.align==='decimal'){const index=line.indexOf('.'),prefix=index<0?line:line.slice(0,index),gap=(b.spacing||0)+(prefix.endsWith(' ')?(b.wordSpacing||0):0);return b.x-textMetrics(encoder,prefix,b).width-(index>0?gap:0)}return b.x}
// A value in a right-aligned column ("300.00(Dr)") keeps the column's right edge
// when it is rewritten, so the money column still lines up. Prose keeps its left
// edge. Neither is stretched.
function valueInColumn(text){return !!parseAmount(String(text??''))}
// The editor rounds every measurement it shows to 0.001 pt, so a block it read
// from the page carries 403.237 where the producer wrote 403.23749. When the user
// did not move that block, the producer's own numbers are still the ones to write:
// a row that comes back rounded is the trace of another program typing into the
// page. The exact value is only used while it still describes what is displayed.
function exactNumber(display,exact){
 const value=Number(exact);
 if(!Number.isFinite(value))return display;
 return Math.abs(value-Number(display))<=5e-4?value:display;
}
function exactBlock(block,original){
 if(!original)return block;
 const precise={...block};
 for(const [key,exactKey] of [['x','xExact'],['y','yExact'],['size','sizeExact'],['width','widthExact'],['spacing','spacingExact'],['wordSpacing','wordSpacingExact'],['strokeWidth','strokeWidthExact']]){
  if(original[exactKey]===undefined)continue;
  precise[key]=exactNumber(block[key],original[exactKey]);
 }
 return precise;
}
// A statement right-aligns its money: several values end on the same x, and those
// shared edges are the columns the page itself declares. The cluster is taken from
// the page as it was opened, so a value the user retyped cannot redefine a column.
// Each column remembers which rows it covers: a value is only put back into a column
// that its own part of the table uses, never one from another block of figures.
function columnEdges(blocks){
 const rights=(blocks||[]).filter(block=>valueInColumn(block.text)&&Number(block.width)>0)
  .map(block=>({right:Number(block.x)+Number(block.width),y:Number(block.y)}))
  .filter(entry=>Number.isFinite(entry.right)&&Number.isFinite(entry.y)).sort((a,b)=>a.right-b.right);
 const groups=[];
 for(const entry of rights){
  const last=groups[groups.length-1];
  if(last&&Math.abs(entry.right-last.sum/last.count)<=1){last.sum+=entry.right;last.count++;last.rows.push(entry.y)}
  else groups.push({sum:entry.right,count:1,rows:[entry.y]});
 }
 return groups.filter(group=>group.count>=3)
  .map(group=>({edge:group.sum/group.count,rows:group.rows}))
  .sort((a,b)=>a.edge-b.edge);
}
// A value that already ends on its column is left alone. One that sits off every
// column keeps the column edge its neighbours share, so a shorter replacement does
// not drift left of the line the rest of the page ends on.
function columnEdgeFor(block,original,edges){
 if(!edges?.length||!original||placementChanged(block,original))return null;
 if(!valueInColumn(original.text)||!valueInColumn(block.text))return null;
 const right=Number(original.x)+Number(original.width);
 if(!Number.isFinite(right))return null;
 const near=edges.filter(column=>column.rows.some(y=>Math.abs(y-Number(block.y))<=60));
 if(!near.length)return null;
 let nearest=null;
 for(const column of near)if(nearest===null||Math.abs(column.edge-right)<Math.abs(nearest-right))nearest=column.edge;
 if(nearest===null||Math.abs(nearest-right)<=1||Math.abs(nearest-right)>45)return null;
 return nearest;
}
function placedStart(block,segments,original,column=true,columnEdge=null){
 const width=segments.reduce((total,segment)=>total+textMetrics(segment.encoder,segment.text,block).width,0);
 if(block.align==='decimal')return block.x-width;
 if(block.align==='right')return block.x-width;
 if(block.align==='center')return block.x-width/2;
 // The right edge of a money column is only kept for a value that was edited in
 // place. A block the user moved is drawn where they moved it: block.x is the
 // left edge the preview shows. Applying the column rule there would snap the
 // text back into the old column and ignore the move.
 if(column&&columnEdge!==null&&columnEdge!==undefined&&Number.isFinite(Number(columnEdge)))return Number(columnEdge)-width;
 if(column&&original&&Number(original.width)>0&&valueInColumn(original.text)&&valueInColumn(block.text))return original.x+Number(original.width)-width;
 return block.x;
}
// True when the user changed where the block sits or how it is aligned. The
// producer's own matrix describes the old position, so it cannot be reused.
function placementChanged(block,original){
 if(!original)return false;
 const near=(a,b)=>Math.abs(Number(a)-Number(b))<=1e-3;
 return !near(block.x,original.x)||!near(block.y,original.y)||String(block.align||'left')!==String(original.align||'left');
}
function inverse(m){const [a,b,c,d,e,f]=m,det=a*d-b*c;if(!det)throw new Error('Invalid PDF viewport.');return [d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det]}
// The scale a form's matrix chain applies to the text drawn inside it. The
// producer writes its font sizes in the form's own units, while a replacement is
// measured in page units: a run placed through a scaled form has to be told the
// size the page will show, or it is drawn at the form's scale on top of its own.
function formScale(ctm){if(!ctm)return 1;const [a,b,c,d]=ctm;if(b||c)return 1;const scale=Math.sqrt(Math.abs(a*d));return Number.isFinite(scale)&&scale>0?scale:1}
function compose(m,n){return [m[0]*n[0]+m[2]*n[1],m[1]*n[0]+m[3]*n[1],m[0]*n[2]+m[2]*n[3],m[1]*n[2]+m[3]*n[3],m[0]*n[4]+m[2]*n[5]+m[4],m[1]*n[4]+m[3]*n[5]+m[5]]}
function rgb(color){if(!/^#[\da-f]{6}$/i.test(color))throw new Error('Invalid text color.');return [1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255)}
function drawNative(block,encoder,fontName,viewport,original=null,columnEdge=null){const text=String(block.text??'');if(block.removed||!text)return '';const anchor=original&&!placementChanged(block,original)?original:null;const color=rgb(block.color).map(number).join(' '),strokeHex=/^#[0-9a-f]{6}$/i.test(block.strokeColor||'')?block.strokeColor:block.color,strokeColor=rgb(strokeHex).map(number).join(' '),mode=[0,1,2].includes(Number(block.textMode))?Number(block.textMode):0,spacing=number(block.spacing||0),wordSpacing=number(block.wordSpacing||0),strokeWidth=number(block.strokeWidth??1),inv=inverse(viewport.transform);let content='';for(const [index,line] of text.split('\n').entries()){if(!line)continue;const x=placedStart(block,[{encoder,text:line}],anchor,true,columnEdge),y=block.y+index*block.size*block.lineheight,matrix=compose(inv,[1,0,0,-1,x,y]);const encoded=encoder(line,block.size);
 // Only the operators this block actually needs: default text state is left to
 // the viewer instead of being restated on every line.
 const state=`${fontName} ${number(block.size)} Tf\n${mode?`${mode} Tr\n`:''}${Number(spacing)?`${spacing} Tc\n`:''}${Number(wordSpacing)?`${wordSpacing} Tw\n`:''}${mode?`${strokeColor} RG\n${strokeWidth} w\n`:''}`;
 content+=`q\n${color} rg\nBT\n${state}${matrix.map(number).join(' ')} Tm\n${encoded.show||`<${encoded.hex}> Tj`}\nET\nQ\n`;if(block.underline){const length=textMetrics(encoder,line,block).width,from=compose(inv,[1,0,0,1,x,y+block.size*.14]),to=compose(inv,[1,0,0,1,x+length,y+block.size*.14]);content+=`q ${mode===1?strokeColor:color} RG ${number(Math.max(.5,block.size/16))} w ${number(from[4])} ${number(from[5])} m ${number(to[4])} ${number(to[5])} l S Q\n`}}return content}
export function signatureProtectionForDocument(document,L){
 const signatures=new Set(),seen=new Set(),pending=[document.catalog];
 while(pending.length){
  let object=pending.pop();if(!object)continue;
  if(object instanceof L.PDFRef){object=document.context.lookup(object);if(!object)throw new Error('Unresolved PDF reference during signature inspection');}
  if(seen.has(object))continue;seen.add(object);
  const dict=object instanceof L.PDFStream?object.dict:object;
  if(dict instanceof L.PDFDict){
   const type=dict.get(L.PDFName.of('Type'))?.toString(),field=dict.get(L.PDFName.of('FT'))?.toString();
   const rawRange=dict.get(L.PDFName.of('ByteRange'));
   if(rawRange||type==='/Sig'){
    const range=rawRange?document.context.lookup(rawRange):null,contents=dict.get(L.PDFName.of('Contents'));
    if(rawRange&&!(range instanceof L.PDFArray))throw new Error('Malformed signature byte range');
    if((range&&range.size()>=4)||(type==='/Sig'&&contents))signatures.add(dict);
   }
   if(field==='/Sig'){
    const value=dict.get(L.PDFName.of('V'));
    if(value&&value.toString()!=='null'){
     const resolved=document.context.lookup(value);
     if(!(resolved instanceof L.PDFDict))throw new Error('Malformed signature field value');
     signatures.add(resolved);
    }
   }
   for(const [,value] of dict.entries())pending.push(value);
  }else if(object instanceof L.PDFArray){for(let i=0;i<object.size();i++)pending.push(object.get(i));}
 }
 return {locked:signatures.size>0,signed:signatures.size>0,count:signatures.size,unknown:false};
}
export async function inspectSignatureProtection(original,L){
 try{
  if(!L?.PDFDocument)throw new Error('PDF inspection library unavailable');
  const document=await L.PDFDocument.load(original.slice(),{updateMetadata:false});
  return signatureProtectionForDocument(document,L);
 }catch(error){
  const encrypted=(L?.EncryptedPDFError&&error instanceof L.EncryptedPDFError)||/encrypted/i.test(error?.message||'');
  return {locked:true,signed:false,count:0,unknown:true,reason:encrypted?'encrypted':!L?.PDFDocument?'library':'parse'};
 }
}
// Every font dictionary the document already contains, nearest page first, with
// its code map. New characters are served from these instead of embedding a
// second copy of a typeface that is already in the file.
function documentFontCandidates(document, context, L, pageIndex = 0) {
 const pages = [...Array(document.getPageCount()).keys()].sort((a, b) => Math.abs(a - pageIndex) - Math.abs(b - pageIndex));
 const seen = new Set(), candidates = [];
 for (const index of pages) {
  const fonts = lookup(document.getPage(index).node.Resources(), 'Font', L);
  if (!fonts) continue;
  for (const [name, ref] of fonts.entries()) {
   if (!ref) continue;
   const key = ref.toString();
   if (seen.has(key)) continue;
   seen.add(key);
   let font = null;
   try { font = readDocumentFont(ref, context, L); } catch { font = null; }
   if (font) candidates.push({ref, font, name: name.toString(), page: index + 1});
  }
 }
 return candidates;
}
function encodesAll(font, text) { return [...new Set(String(text))].every(character => font.codes.has(character)); }
// The subset a producer embedded rarely covers new characters, and embedding the
// same program again shows up as a second copy of the typeface (ArialMT and
// ArialMT-7098). Only a typeface the file does not contain yet is embedded.
function mayEmbedTypeface(candidates, baseFont) {
 const identity = fontKey(baseFont || '');
 return !identity || !candidates.some(entry => fontKey(entry.font.baseFont || '') === identity);
}
export async function exportNativePdf({original,edits,getPage,fonts=new Map(),originalFonts=new Map(),documentFonts=new Map(),PDFLib:L,fontkit,metadataRecord=null,uploadedMetadata=null,fileId=null,attachProvenance=false,headerSource=null,onProgress=()=>{}}){
 // The header marker to keep. Normally the opened file's own; for a protected
 // upload it is the bytes the user chose, because the working copy was written
 // by the decryptor and would otherwise hand its marker to the export.
 const headerDonor=headerSource||original;
 const changes=[...edits.values()];
 if(!changes.length&&!uploadedMetadata){
  if(!fileId)return original.slice();
  // No text or metadata change, but the working copy (for example a qpdf
  // decryption) may carry a different /ID than the file the user uploaded.
  try{const untouched=await L.PDFDocument.load(original.slice(),{updateMetadata:false});if(sameFileId(fileId,fileIdFromDocument(untouched,L)))return original.slice();applyFileId(untouched,fileId,L);return alignHeader(await untouched.save({useObjectStreams:true,addDefaultPage:false}),headerDonor)}
  catch{return original.slice()}
 }
 let output;try{output=await L.PDFDocument.load(original.slice(),{updateMetadata:false})}catch(error){throw new Error('This PDF cannot be safely rewritten as native content. Open an unlocked PDF first. No image conversion was performed.')}if(signatureProtectionForDocument(output,L).locked)throw new Error('Signature protection is mandatory. This PDF contains a digital signature and cannot be edited. Export the original unchanged or have the issuer sign a new document.');const savedMetadata=capturePdfMetadata(output,L);if(fontkit)output.registerFontkit(fontkit);const context=output.context,fontCache=new Map(),counter={value:0},pages=[...new Set(changes.map(b=>b.page))];for(const n of pages){onProgress(`Exporting native text on page ${n}…`);const page=output.getPage(n-1),data=await getPage(n),pageChanges=changes.filter(b=>b.page===n);let resources=cloneResources(page.node.Resources(),context,L);const slots=[],needsRemoval=pageChanges.some(b=>b.ops?.length),source=collectContent(page.node.get(L.PDFName.of('Contents')),context,L),tree=needsRemoval?buildTree(source,resources,{size:0,spacing:0,word:0,fontObject:null,fontDict:null},context,L,slots):{source,resources,patches:[],forms:[]};const ops=data.info.ops;
  // The money columns this page declares, measured before any edit touches it.
  const edges=columnEdges(data.blocks);if(needsRemoval&&slots.length!==ops.length)throw new Error(`Page ${n} has a text structure that cannot be mapped safely. No image conversion was performed.`);const byIndex=new Map(),fontMaps=new Map(),inPlace=new Set();const matrixPatches=[];if(needsRemoval){for(let i=0;i<slots.length;i++){const slot=slots[i],info=ops[i];const pair=decodeGlyphs(slot,info,L),map=fontMaps.get(slot.fontDict)||new Map();fontMaps.set(slot.fontDict,map);pair.glyphs.forEach((glyph,j)=>{if(glyph.unicode&&!map.has(glyph.unicode))map.set(glyph.unicode,{bytes:pair.decoded[j],unitWidth:glyph.width*(info.font.fontMatrix?.[0]??.001)})});byIndex.set(info.index,{slot,info,map})}for(const block of pageChanges){
   const originalEntry=(data.blocks||[]).find(entry=>entry.id===block.id);
   let pairs=(block.ops||[]).map(index=>byIndex.get(index));
   if(!pairs.length||pairs.some(pair=>!pair))throw new Error('The selected text operation cannot be safely removed.');
   if(pairs.length===1&&originalEntry&&byIndex.size){
    const resolved=runAt(originalEntry,data.vp,pairs[0],byIndex.values());
    if(resolved)pairs=[resolved];
   }
   const original=originalEntry;
   // The producer's own numbers and the column this page uses for money: both are
   // taken from the untouched page, so an edit cannot watermark itself.
   const precise=exactBlock(block,original),columnEdge=columnEdgeFor(block,original,edges);
   const shown=String(block.text??'');
   if(!block.removed&&shown){
    matrixPatches.length=0;
    const sameStyle=sameTextStyle(block,original);
    // Text written through a matrix that is not a plain translation comes out
    // horizontally squeezed. Patching glyphs into that operator would keep the
    // squeeze (and change nothing else), so the block is rewritten with a fresh,
    // uniform matrix instead — the width the preview showed.
    const uniformMatrix=!pairs[0].slot.matrixAt||!!matrixOrigin(pairs[0].slot.matrixAt);
    let patched;
    // A value that sits off its column is re-placed, not patched where it stands.
    if(sameStyle&&uniformMatrix&&columnEdge===null)patched=patchInPlace(pairs,block.text,text=>originalEncoder(pairs[0].map,text,pairs[0].slot.state.size),L);
    if(!patched){
     // A style change still replaces the run where it is, using a font the page
     // already has (its own font or the reused document font). Only when no such
     // font can write the text does the block get drawn separately.
     const targets=[];
     if(block.font==='original'){
      const used=new Set();
      for(const pair of pairs){
       const key=pair.slot.fontObject?.toString();
       if(!key||used.has(key))continue;
       used.add(key);
       targets.push({fontObject:pair.slot.fontObject,map:pair.map,encoder:(text,size)=>originalEncoder(pair.map,text,size)});
      }
     }else if(documentFonts.has(block.font)){
      const plan=documentFonts.get(block.font),donorPage=output.getPage(Math.max(0,(plan?.page||1)-1));
      const ref=lookup(donorPage.node.Resources(),'Font',L)?.get(L.PDFName.of(plan?.resourceName||''));
      if(ref){
       const donor=readDocumentFont(ref,context,L);
       targets.push({fontObject:ref,map:donor.codes,encoder:documentFontEncoder(donor,{wordSpacing:block.wordSpacing||0})});
      }
     }
     patched=rewriteInPlace(pairs,precise,lookup(resources,'Font',L),data.vp,targets,original,matrixPatches,L,lookup(pairs[0]?.slot.node?.resources,'Font',L),columnEdge);
     if(patched===false)continue;
     if(!patched&&block.font==='original'){
      // A producer embeds only the glyphs that page drew, so the page's own
      // program may lack a character of the replacement. Another page normally
      // has the same typeface with that glyph: point at that program, keep the
      // text object where the producer put it, and only fall back to a separate
      // block when no program in the document can write the text.
      const peers=documentFontCandidates(output,context,L,n-1),identity=fontKey(block.fontName||'');
      const donor=peers.find(entry=>encodesAll(entry.font,block.text)&&(!identity||fontKey(entry.font.baseFont||'')===identity))||peers.find(entry=>encodesAll(entry.font,block.text));
      if(donor){
       const fontResources=lookup(resources,'Font',L),name=existingName(fontResources,donor.ref)||freshName(fontResources,'F',counter,L);
       const added=!fontResources.has(name);
       fontResources.set(name,donor.ref);
       targets.push({fontObject:donor.ref,map:donor.font.codes,encoder:(block.wordSpacing||0)===0?documentHexEncoder(donor.font):documentFontEncoder(donor.font,{wordSpacing:block.wordSpacing})});
       matrixPatches.length=0;
       patched=rewriteInPlace(pairs,precise,lookup(resources,'Font',L),data.vp,targets,original,matrixPatches,L,lookup(pairs[0]?.slot.node?.resources,'Font',L),columnEdge);
       if(!patched&&added)fontResources.delete(name);
       if(patched===false)continue;
      }
     }
    }
    if(patched){
     for(const patch of matrixPatches)pairs[0].slot.node.patches.push(patch);
     pairs[0].slot.node.patches.push({start:pairs[0].slot.operation.start,end:pairs[0].slot.operation.end,text:patched});
     for(const pair of pairs.slice(1))pair.slot.node.patches.push({start:pair.slot.operation.start,end:pair.slot.operation.end,text:''});
     inPlace.add(block.id);
     continue;
    }
   }
   for(const pair of pairs){
    const text=pair.slot.operation.op==="'"||pair.slot.operation.op==='"'||!deletable(pair.slot)?advanceOnly(pair.slot,pair.info):'';
    pair.slot.node.patches.push({start:pair.slot.operation.start,end:pair.slot.operation.end,text});
   }
  }}
const saved=saveTree(tree,context,L,counter);if(saved.resources)resources=saved.resources;const fontResources=lookup(resources,'Font',L);let drawing='';for(const block of pageChanges){const original=(data.blocks||[]).find(entry=>entry.id===block.id);if(block.removed||!String(block.text??'')||inPlace.has(block.id))continue;const precise=exactBlock(block,original),columnEdge=columnEdgeFor(block,original,edges);let encoder,fontObject;if(block.font==='original'&&block.ops?.length){
 const pair=byIndex.get(block.ops[0]),missing=originalMissingChars(pair.map,block.text);
 if(!missing.length){
  fontObject=pair.slot.fontObject;
  encoder=(text,size)=>originalEncoder(pair.map,text,size);
 }else{
  const record=originalFonts.get(block.fontId)||originalFonts.get(pair.info.fontId);
  const current=pair.slot.fontObject?.toString();
  // Its own dictionary comes first: the observed page map only covers the glyphs
  // this page drew, while its ToUnicode maps the whole subset.
  const candidates=documentFontCandidates(output,context,L,n-1);
  const own=candidates.find(entry=>entry.ref.toString()===current);
  const reuse=(own&&encodesAll(own.font,block.text)?own:null)||candidates.find(entry=>encodesAll(entry.font,block.text));
  if(reuse){
   // Another font in this document already covers the text: point at it (its
   // object is reused, nothing is embedded).
   fontObject=reuse.ref;
   encoder=documentFontEncoder(reuse.font,{wordSpacing:block.wordSpacing||0});
  }else if(record?.data&&mayEmbedTypeface(candidates,record.name)){
   let embedded=fontCache.get(`original:${fontKey(record.name||'')||record.id}`);
   if(!embedded){
    try{embedded=await output.embedFont(new Uint8Array(record.data),{subset:true})}catch{embedded=null}
    if(embedded)fontCache.set(`original:${fontKey(record.name||'')||record.id}`,embedded);
   }
   if(!embedded)throw new Error(`The original font cannot encode ${JSON.stringify(missing[0])}. Choose an available font or load a TTF/OTF font; no image conversion was performed.`);
   fontObject=embedded.ref;
   const spaceGlyph=record?.parsed?.glyphForCodePoint?.(32),spaceAdvance=pair.map.get(' ')?.unitWidth??(spaceGlyph&&record.parsed.unitsPerEm?spaceGlyph.advanceWidth/record.parsed.unitsPerEm:.25);
   encoder=(text,size)=>{try{const words=String(text).split(' '),space=spaceAdvance*size,wordGap=size>0?(((block.wordSpacing||0)+(block.spacing||0))*1000/size):0,width=words.filter(word=>word).reduce((total,word)=>total+embedded.widthOfTextAtSize(word,size),0)+Math.max(0,words.length-1)*space;if(words.length===1)return {hex:embedded.encodeText(text).asString(),width,count:Array.from(text).length};const tokens=[];for(let i=0;i<words.length;i++){if(i)tokens.push(number(-spaceAdvance*1000-wordGap));if(words[i])tokens.push(`<${embedded.encodeText(words[i]).asString()}>`)}return {hex:'',width,count:Array.from(text).length,show:`[${tokens.join(' ')}] TJ`}}catch(error){throw new Error(`The original embedded font cannot encode ${JSON.stringify(missing[0]||'a replacement character')}. Load the full TTF/OTF for this font; no image conversion was performed.`)}}
  }else{
   // Name the character no font in this document can write, not just the first
   // one the page never happened to show.
   const best=candidates.reduce((a,entry)=>!a||entry.font.codes.size>a.font.codes.size?entry:a,null);
   const uncovered=best?[...new Set(block.text)].filter(character=>!best.font.codes.has(character)):[];
   throw new Error(`The original font cannot encode ${JSON.stringify(uncovered[0]||missing[0])}. Choose an available font or load a TTF/OTF font; no image conversion was performed.`);
  }
 }
}else if(documentFonts.has(block.font)&&!fonts.get(block.font)){
 // Reuse the font dictionary that is already in this PDF (normally the page-1
 // program) instead of embedding the program a second time: the edited page's
 // /Font resource points at the existing object and the text is written with
 // that font's own codes.
 const plan=documentFonts.get(block.font),donorPage=output.getPage(Math.max(0,(plan?.page||1)-1));
 const donorFonts=lookup(donorPage.node.Resources(),'Font',L),ref=donorFonts?.get(L.PDFName.of(plan?.resourceName||''));
 const donorFont=ref?readDocumentFont(ref,context,L):null;
 if(!donorFont)throw new Error(`The document font for page ${plan?.page||1} could not be reused. Choose another font for this text.`);
 // The shared naming step below registers this page's font resource; it points
 // at the donor object itself, so nothing is re-embedded.
 fontObject=ref;
 encoder=documentFontEncoder(donorFont,{wordSpacing:block.wordSpacing||0});
}else{
 // A standard or loaded substitute must not create a second copy of a typeface
 // the document already contains: reuse the document's own font when it is the
 // same typeface and covers the text.
 const upload=fonts.get(block.font),identity=fontKey(block.fontName||'');
 const candidate=!upload&&identity?documentFontCandidates(output,context,L,n-1).find(entry=>fontKey(entry.font.baseFont||'')===identity&&encodesAll(entry.font,block.text)):null;
 if(candidate){fontObject=candidate.ref;encoder=documentFontEncoder(candidate.font,{wordSpacing:block.wordSpacing||0})}
 else{
 const key=upload?block.font:standardName(block);let font=fontCache.get(key);if(!font){try{font=upload?await output.embedFont(upload.data,{subset:true}):await output.embedFont(key)}catch(error){throw new Error('This font could not be embedded. Load a valid TTF or OTF font; no image conversion was performed.')}fontCache.set(key,font)}fontObject=font.ref;encoder=(text,size)=>{try{return {hex:font.encodeText(text).asString(),width:font.widthOfTextAtSize(text,size),count:Array.from(text).length}}catch(error){throw new Error('This font cannot encode a replacement character. Choose the original font or load a TTF/OTF font; no image conversion was performed.')}}
 }}const reused=existingName(fontResources,fontObject);
 const name=reused||freshName(fontResources,'F',counter,L);
 if(!reused)fontResources.set(name,fontObject);
 drawing+=drawNative(precise,encoder,name.toString(),data.vp,original,columnEdge)}if(drawing||saved.resources)page.node.set(L.PDFName.of('Resources'),resources);
  const contents=saved.changed?saved.source:tree.source;
  // With no new drawing there is no need for a graphics-state wrapper; writing
  // the patched stream as-is keeps the page looking untouched.
  const body=drawing?`q\n${contents}\nQ\n${drawing}`:contents;
  page.node.set(L.PDFName.of('Contents'),context.register(context.flateStream(bytes(body))))}if(uploadedMetadata)applyUploadedMetadata(output,uploadedMetadata,L);else{
  // A provenance attachment points at another document, which is exactly what a
  // "re-saved copy of another PDF" check looks for. It is opt-in only.
  if(attachProvenance)await attachSourceMetadata(output,metadataRecord,L);
  restorePdfMetadata(output,L,savedMetadata)}if(fileId)applyFileId(output,fileId,L);
 // The header written by the PDF library is 1.7; a catalog /Version left at
 // 1.4 would describe the file as an older document than its own structure.
 ensureCatalogVersion(output,'1.7',L);
 return alignHeader(await output.save({useObjectStreams:true,addDefaultPage:false}),headerDonor)}
