import FieldHistory from './FieldHistory';
import {useState} from 'react';
import {api,ApiError} from '../../lib/api';
import {Resource,useResource,useApp} from '../../lib/state';
import {useBusinessDefinition} from '../../lib/use-business-definition';
import {coreToValues,fieldPayload,mergeFormAfterDefinitionChange,type EntityKind,type EffectiveDefinition,type FieldValues} from '../../lib/business-config';
import {Form} from '../ui';
import {DynamicFields} from './DynamicFields';
type Props={kind:EntityKind;id?:string;core:any;customFields?:FieldValues;mode?:'create'|'edit';coreOnly?:boolean;omitCoreKeys?:string[];allowIncomplete?:boolean;childrenFirst?:boolean;submit?:string;children?:React.ReactNode;onCancel:()=>void;onSubmit:(payload:any,form:HTMLFormElement)=>Promise<void>};
export default function ConfiguredForm(props:Props){
 const def=useBusinessDefinition(props.kind),custom=useResource<FieldValues>(s=>props.customFields?Promise.resolve(props.customFields):props.id&&!props.coreOnly?api('/business-config/objects/'+props.kind+'/'+props.id,{signal:s}):Promise.resolve({}),[props.kind,props.id]);
 return <Resource {...def} preserve={def.data!==undefined} retry={def.reload}><Resource {...custom} preserve={custom.data!==undefined} retry={custom.reload}>{def.data&&custom.data&&<Editor {...props} initialDefinition={def.data} initialCustom={custom.data}/>}</Resource></Resource>;
}
function Editor({initialDefinition,initialCustom,...props}:Props&{initialDefinition:EffectiveDefinition;initialCustom:FieldValues}){
 const {user}=useApp(),[definition,setDefinition]=useState(initialDefinition),[values,setValues]=useState<FieldValues>(()=>({...coreToValues(initialDefinition,props.core),...initialCustom,...Object.fromEntries(initialDefinition.fields.filter(f=>props.mode==='create'&&f.defaultValue!==undefined).map(f=>[f.fieldId,f.defaultValue]))})),[review,setReview]=useState<string[]|null>(null),[errors,setErrors]=useState<Record<string,string>>({});
 const writable={...definition,fields:definition.fields.filter(f=>f.access.write.some(r=>user.roles.includes(r))&&(!props.coreOnly||!!f.coreKey)&&!props.omitCoreKeys?.includes(f.coreKey||''))};
 return <><Form submit={props.submit} onCancel={props.onCancel} onSubmit={async form=>{
  if(review)throw Error('请先核对新配置及保留的草稿内容');setErrors({});
  try{await props.onSubmit(fieldPayload(writable,values,definition),form);}catch(e){
   if(e instanceof ApiError&&e.code==='configuration_changed'){
    const next=await api<EffectiveDefinition>('/business-config/effective/'+props.kind),merged=mergeFormAfterDefinitionChange(definition,next,values);setDefinition(next);setValues(merged.values);setReview(merged.removedFields);throw Error('配置已更新，输入内容保留在当前页面，请核对后再次保存');
   }
   if(e instanceof ApiError&&e.code.includes(':')){const [reason,...id]=e.code.split(':');setErrors({[id.join(':')]:reason==='field_required'?'请补充此项':'请检查此字段的内容、范围和格式'});}throw e;
  }
 }}>
  {review&&<div className="notice warning" role="alert">配置已变化。{review.length>0&&<p>已停用或失去权限的草稿字段保留在页面内存：{review.map(id=>initialDefinition.fields.find(f=>f.fieldId===id)?.label||'原字段').join('、')}。这些内容不会提交。</p>}<button type="button" onClick={()=>setReview(null)}>已核对新配置，继续编辑</button></div>}
  {props.childrenFirst&&props.children}
  <DynamicFields definition={writable} visibilityDefinition={definition} values={values} mode={props.mode||'edit'} onChange={setValues} errors={errors} deferRequired={props.allowIncomplete}/>
  {!props.childrenFirst&&props.children}
 </Form>{props.id&&!props.coreOnly&&<FieldHistory kind={props.kind} id={props.id}/>}</>;
}
