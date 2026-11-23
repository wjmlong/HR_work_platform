import {api} from './api.ts';
export const requestMailboxSync=(base:string)=>api<{requestId:string}>(base+'/sync',{method:'POST',body:{}});
export const requestMailboxCollection=(base:string,requestId:string)=>api<any>(base+'/update',{method:'POST',body:{requestId}});
