import {testDatabase,actor} from './helpers.js';
import {Identity} from '../src/identity/service.js';
import {FeishuProvider} from '../src/identity/provider.js';
import {BusinessConfigService} from '../src/business-config/service.js';
export async function configFixture(t:any){
 const f=await testDatabase();t.after(f.cleanup);
 const admin=await actor(f.db),identity=new Identity(f.db,f.config,new FeishuProvider(f.config));
 const configs=new BusinessConfigService(identity);await configs.seed();
 return {...f,admin,identity,configs};
}
export function fieldDefinition(overrides:Record<string,unknown>={}){
 return {fieldId:'custom.portfolio',type:'text',label:'作品集说明',active:true,required:false,order:100,group:'补充信息',...overrides};
}
export async function publishDefinition(f:any,document:any){
 const current=await f.configs.effective(f.admin,document.entity);
 const draft=await f.configs.saveDraft(f.admin,{key:'fields.'+document.entity,baseVersion:current.ref.version,document});
 return f.configs.publish(f.admin,await f.configs.preview(f.admin,draft.id));
}
