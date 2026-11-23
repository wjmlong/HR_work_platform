import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {ROOT,type Config} from '../config.js';
import {profileInput} from '../recruiting/schema.js';
import type {Parsed,Evidence} from './profile.js';
export const RECOGNITION_VERSION='deepseek-vision-1.0.0';
export const RECOGNIZED_FIELDS=['name','phone','email','school','major','education','intent','experienceYears','firstEmployment','skills','companies'] as const;
const compact=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/\s+/g,'');
function span(raw:string,quote:string){
 const exact=raw.indexOf(quote);if(exact>=0)return {start:exact,end:exact+quote.length};
 let text='',offset=0;const positions:{start:number;end:number}[]=[];
 for(const ch of raw){const normalized=compact(ch);for(let i=0;i<normalized.length;i++)positions.push({start:offset,end:offset+ch.length});text+=normalized;offset+=ch.length;}
 const needle=compact(quote),start=needle?text.indexOf(needle):-1;
 return start<0?null:{start:positions[start].start,end:positions[start+needle.length-1].end};
}
export function adaptRecognition(value:any):Parsed&{raw:string;documentType:string;recognition:any;provenance:{method:'model';model:string;tokens:number;elapsedMs:number}}{
 if(value?.status!=='ok'||typeof value.source_text!=='string'||value.source_text.length>2*1024*1024||!['resume','cover_letter','other','unknown'].includes(value.prediction?.document_type))throw Error('resume_recognition_invalid');
 const raw=value.source_text,recognition=value.prediction,documentType=recognition.document_type;
 const candidate=['resume','cover_letter'].includes(documentType),input:Record<string,unknown>={name:'待确认'};
 if(candidate)for(const key of RECOGNIZED_FIELDS){const v=recognition.profile?.[key];if(v!==null&&v!==undefined&&!(key==='name'&&v===''))input[key]=v;}
 const profile=profileInput.parse(input),evidence:Evidence[]=[];
 if(candidate)for(const item of recognition.evidence||[]){
  const field=String(item.field||'').replace(/^profile\./,''),quote=item.quote;
  if(!RECOGNIZED_FIELDS.includes(field as any)||typeof quote!=='string'||!quote)continue;
  const where=span(raw,quote);if(!where)continue;
  const add=(field:string)=>{const text=raw.slice(where.start,where.end);evidence.push({field,...where,text,line:raw.slice(0,where.start).split('\n').length,id:createHash('sha256').update(field+':'+where.start+':'+text).digest('hex').slice(0,16)});};
  add(field);if(field==='skills')for(const skill of profile.skills)if(compact(quote).includes(compact(skill)))add('skill:'+skill);
 }
 const calls=Array.isArray(value.calls)?value.calls:[];
 return {raw,profile,evidence,documentType,recognition,parserVersion:RECOGNITION_VERSION,warnings:(recognition.warnings||[]).filter((x:unknown)=>typeof x==='string'),provenance:{method:'model',model:calls[0]?.requested_model||'deepseek-v4.1-flash',tokens:calls.reduce((n:number,c:any)=>n+(Number(c.usage?.total_tokens)||0),0),elapsedMs:Math.round((Number(value.seconds)||0)*1000)}};
}
export async function recognizeDocument(config:Config,input:{file?:string;kind?:string;sha256?:string;text?:string}){
 if(!config.recognitionConfigFile)throw Error('resume_recognition_not_configured');
 const response=await new Promise<string>((resolve,reject)=>{
  const proc=execFile(config.recognitionPython||'python3',[path.join(ROOT,'python/recognition/cli.py'),'--config',config.recognitionConfigFile!],{timeout:15*60*1000,maxBuffer:16*1024*1024,windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,LANG:'C.UTF-8',PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}},(error,stdout)=>error?reject(Error(error.killed?'resume_recognition_timeout':'resume_recognition_failed')):resolve(stdout));
  proc.stdin?.on('error',()=>{});proc.stdin?.end(JSON.stringify(input));
 });
 try{return adaptRecognition(JSON.parse(response));}catch{throw Error('resume_recognition_invalid');}
}
