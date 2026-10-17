// Describes reported names; recognition is not proof of an installed/embedded font.
export function detectFontIdentity(value,metadata={}){
 const raw=String(value||'').replace(/^\s*font-family\s*:\s*/i,'').replace(/;\s*$/,'');
 const reportedFamilies=(raw.match(/"[^"]*"|'[^']*'|[^,]+/g)||[]).map(s=>s.trim().replace(/^["']|["']$/g,'')).filter(Boolean);
 const primary=reportedFamilies[0]||'',subset=primary.match(/^\/?([A-Z]{6})\+/),name=primary.replace(/^\/?[A-Z]{6}\+/,'').replace(/^\//,'').replace(/#([\da-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
 const compact=name.replace(/[\s_-]/g,'').toLowerCase();let family=null;
 if(/^arialnarrow/.test(compact))family='Arial Narrow';
 else if(/^arial/.test(compact))family='Arial';
 else if(/^helveticaneue/.test(compact))family='Helvetica Neue';
 else if(/^helvetica/.test(compact))family='Helvetica';
 else if(/^sansserif$/.test(compact))family='sans-serif';
 const bold=!!(metadata.bold||metadata.black)||/bold|black|heavy|demi|semibold/i.test(name),italic=!!metadata.italic||/italic|oblique|slanted/i.test(name);
 return {family,style:bold?(italic?'Bold Italic':'Bold'):(italic?'Italic':'Regular'),subsetPrefix:subset?.[1]||null,reportedFamilies,cssFallback:'Arial, "Helvetica Neue", Helvetica, sans-serif',recognition:family?'reported-name match':'unrecognized'};
}
