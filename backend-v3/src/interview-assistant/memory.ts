import {createHash} from 'node:crypto';
import {ConversationCompactor} from './vendor/qwen-live-harness/context-compaction.js';
type Item={id:string;speaker:string;text:string};
type State={compactor:ConversationCompactor;items:Item[];signature:string;pending?:Promise<void>;ready?:string;failed:boolean;touched:number};
function pieces(item:Item){const result:string[]=[];let text='';for(const char of item.text){if(Buffer.byteLength(JSON.stringify({...item,text:text+char}))>1100){result.push(JSON.stringify({...item,text}));text='';}text+=char;}if(text)result.push(JSON.stringify({...item,text}));return result;}
const signature=(items:Item[])=>createHash('sha256').update(JSON.stringify(items)).digest('hex');
/** Only continuity summaries are cached; all authoritative originals remain in the session store. */
export class InterviewMemory {
 private cache=new Map<string,State>();
 constructor(private summarize:(input:string,signal:AbortSignal)=>Promise<string>){}
 prepare(id:string,segments:Item[]){
  const items=segments.map(({id,speaker,text})=>({id,speaker,text}));let state=this.cache.get(id);
  if(state?.failed){state.compactor.close();this.cache.delete(id);state=undefined;}
  if(state&&signature(items.slice(0,state.items.length))!==state.signature){state.compactor.close();this.cache.delete(id);state=undefined;}
  if(!state){
   for(const [key,entry] of this.cache)if(Date.now()-entry.touched>900000){entry.compactor.close();this.cache.delete(key);}
   if(this.cache.size>=32){const key=this.cache.keys().next().value!;this.cache.get(key)!.compactor.close();this.cache.delete(key);}
   state={compactor:new ConversationCompactor(this.summarize,(type)=>{if(type==='compaction.summary_failed')state!.failed=true;}),items:[],signature:signature([]),failed:false,touched:Date.now()};this.cache.set(id,state);
  }
  state.touched=Date.now();
  if(!state.pending&&(state.items.length<items.length||state.failed)){
   const current=state,start=state.items.length;current.failed=false;
   current.pending=(async()=>{try{let buffered=0;
    for(const item of items.slice(start)){
     // Bound each historical entry; current context is supplied separately by original text.
     for(const text of pieces(item)){current.compactor.remember({role:'context',text});if(++buffered%8===0){await current.compactor.refresh();if(current.failed)throw Error('summary_failed');}}
    }
    await current.compactor.refresh();if(current.failed)throw Error('summary_failed');current.items=items;current.signature=signature(items);current.ready=current.compactor.context();current.failed=!current.ready;
   }catch{current.failed=true;}finally{current.pending=undefined;}})();
  }
  const context=state.ready?JSON.stringify({completedHistory:state.ready,newOriginals:items.slice(state.items.length)}):undefined;
  return {context,pending:!!state.pending,failed:state.failed};
 }
 async settle(id:string){await this.cache.get(id)?.pending;}
 close(){for(const state of this.cache.values())state.compactor.close();this.cache.clear();}
}
