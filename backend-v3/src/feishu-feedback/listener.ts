import {EventDispatcher,WSClient,LoggerLevel} from '@larksuiteoapi/node-sdk';
import type {Identity} from '../identity/service.js';
import {InterviewFeedback} from './service.js';
export type CardActionHandler=(data:unknown)=>Promise<unknown>;
export function createCardActionRouter(handlers:Record<string,CardActionHandler>){
 const routes=new Map(Object.entries(handlers));
 return async(data:unknown)=>{
  const kind=(data as any)?.action?.value?.kind,handler=typeof kind==='string'?routes.get(kind):undefined;
  return handler?handler(data):{toast:{type:'error',content:'此卡片暂无法处理，请联系对应业务负责人。'}};
 };
}
export function startInterviewFeedbackListener(identity:Identity,additionalHandlers:Record<string,CardActionHandler>={}){
 const service=new InterviewFeedback(identity);if(!service.enabled)return {close(){}};
 const f=identity.config.feishu;
 const dispatcher=new EventDispatcher({loggerLevel:LoggerLevel.error}).register({
  'card.action.trigger':createCardActionRouter({...additionalHandlers,interview_confirmation:data=>service.handleCardAction(data)}),
 });
 const client=new WSClient({appId:f.appId,appSecret:f.appSecret,loggerLevel:LoggerLevel.error});
 void client.start({eventDispatcher:dispatcher}).catch(()=>console.error('Feishu interview feedback connection unavailable'));
 return {close(){client.close({force:true});}};
}
