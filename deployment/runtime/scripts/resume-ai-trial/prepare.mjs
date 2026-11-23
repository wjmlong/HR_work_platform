// Isolated, local-only document preparation. No credentials or network in this child.
import fs from 'node:fs/promises';
import {fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import yauzl from 'yauzl';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {createCanvas,loadImage} from '@napi-rs/canvas';
const LIMITS={bytes:10*1024*1024,pages:10,edge:1600,pixels:2560000,text:60000,payload:12*1024*1024};
export async function prepare(file){
 const stat=await fs.stat(file);if(stat.size>LIMITS.bytes)throw Error('file_too_large');
 const bytes=await fs.readFile(file),ext=file.split('.').pop().toLowerCase();const pages=[];
 if(ext==='txt')pages.push({page:1,text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)});
 else if(ext==='docx'){
  const text=await new Promise((resolve,reject)=>{yauzl.fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(err,zip)=>{if(err)return reject(Error('invalid_docx'));let total=0,count=0,xml;const bad=()=>{zip.close();reject(Error('invalid_docx'));};zip.on('error',bad);zip.on('entry',e=>{if(++count>200||(total+=e.uncompressedSize)>20*1024*1024||e.uncompressedSize>10*1024*1024||e.fileName.split('/').includes('..')||/vbaProject/i.test(e.fileName))return bad();if(e.fileName!=='word/document.xml')return zip.readEntry();zip.openReadStream(e,(err,stream)=>{if(err)return bad();let chunks=[],size=0;stream.on('error',bad);stream.on('data',c=>{size+=c.length;if(size>10*1024*1024){stream.destroy();bad();}else chunks.push(c);});stream.on('end',()=>{xml=Buffer.concat(chunks).toString('utf8');zip.readEntry();});});});zip.on('end',()=>{try{if(!xml||/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw Error();const nodes=new XMLParser({preserveOrder:true,ignoreAttributes:true,trimValues:false}).parse(xml);const walk=n=>Array.isArray(n)?n.map(walk).join(''):n&&typeof n==='object'?Object.entries(n).map(([k,v])=>k==='#text'?String(v):k==='w:tab'?'\t':k==='w:br'?'\n':walk(v)+(k==='w:p'?'\n':'')).join(''):'';resolve(walk(nodes));}catch{reject(Error('invalid_docx'));}});zip.readEntry();});});pages.push({page:1,text,source:'docx_text'});
 }else if(ext==='pdf'&&process.env.RECRUIT_TRIAL_PYTHON){
  const {stdout}=await promisify(execFile)(process.env.RECRUIT_TRIAL_PYTHON,[fileURLToPath(new URL('./pdfium_prepare.py',import.meta.url)),file],{timeout:30000,maxBuffer:14*1024*1024,env:{PATH:process.env.PATH,LANG:'en_US.UTF-8'}});const parsed=JSON.parse(stdout);return {pages:parsed.pages,limits:LIMITS,nativeMaxRssKiB:parsed.nativeMaxRssKiB,nativeMs:parsed.nativeMs};
 }else if(ext==='pdf'){
  const {getDocument,OPS}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true,disableFontFace:true,cMapUrl:fileURLToPath(new URL('../../node_modules/pdfjs-dist/cmaps/',import.meta.url)),cMapPacked:true,standardFontDataUrl:fileURLToPath(new URL('../../node_modules/pdfjs-dist/standard_fonts/',import.meta.url)),wasmUrl:fileURLToPath(new URL('../../node_modules/pdfjs-dist/wasm/',import.meta.url))});
  const doc=await task.promise;
  try{if(doc.numPages>LIMITS.pages)throw Error('page_limit');
   // Sequential rendering: release each page's canvas before moving to the next.
   for(let n=1;n<=doc.numPages;n++){
    const p=await doc.getPage(n),content=await p.getTextContent();
    const text=content.items.filter(x=>'str'in x).map(x=>x.str+(x.hasEOL?'\n':' ')).join('');
    const hasImages=(await p.getOperatorList()).fnArray.some(x=>[OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject,OPS.paintImageXObjectRepeat,OPS.paintInlineImageXObjectGroup,OPS.paintImageMaskXObjectGroup].includes(x));
    if(text.trim().length>=80&&!hasImages)pages.push({page:n,text});
    else{const original=p.getViewport({scale:1});const scale=Math.min(2,LIMITS.edge/Math.max(original.width,original.height));
     const viewport=p.getViewport({scale});const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
     await p.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
     pages.push({page:n,image:'data:image/jpeg;base64,'+canvas.toBuffer('image/jpeg',85).toString('base64')});canvas.width=1;canvas.height=1;
    }p.cleanup();
   }
  }finally{await task.destroy();}
 }else if(['png','jpg','jpeg'].includes(ext)){
  const image=await loadImage(bytes);if(image.width*image.height>20000000)throw Error('image_pixel_limit');
  const scale=Math.min(1,LIMITS.edge/Math.max(image.width,image.height));const c=createCanvas(Math.ceil(image.width*scale),Math.ceil(image.height*scale));c.getContext('2d').drawImage(image,0,0,c.width,c.height);
  pages.push({page:1,image:'data:image/jpeg;base64,'+c.toBuffer('image/jpeg',85).toString('base64')});
 }else throw Error('trial_format_unsupported');
 if(pages.reduce((n,p)=>n+(p.text?.length||0),0)>LIMITS.text)throw Error('text_limit');
 if(Buffer.byteLength(JSON.stringify(pages))>LIMITS.payload)throw Error('payload_limit');
 return {pages,limits:LIMITS};
}
if(process.send)process.once('message',async ({file})=>{const start=Date.now();try{const data=await prepare(file);process.send({ok:true,...data,preparationMs:Date.now()-start,maxRssKiB:process.resourceUsage().maxRSS+(data.nativeMaxRssKiB||0)},()=>process.disconnect());}catch(e){process.send({ok:false,error:e.message},()=>process.disconnect());}});
