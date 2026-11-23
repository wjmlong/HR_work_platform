import {Field} from '../ui';
import MoneyField from './MoneyField';
import {fieldVisible,matches,type EffectiveDefinition,type FieldValues} from '../../lib/business-config';
export function DynamicFields({definition,visibilityDefinition=definition,values,mode,onChange,errors={},deferRequired=false}:{definition:EffectiveDefinition;visibilityDefinition?:EffectiveDefinition;values:FieldValues;mode:'create'|'edit'|'read';onChange:(values:FieldValues)=>void;errors?:Record<string,string>;deferRequired?:boolean}){
 const set=(id:string,value:unknown)=>onChange({...values,[id]:value});
 const fields=definition.fields.filter(f=>fieldVisible(visibilityDefinition,f,values)).sort((a,b)=>a.order-b.order);
 return <div className="form-grid">{fields.map(f=>{
  const v=values[f.fieldId],required=f.required||!!f.requiredWhen&&matches(f.requiredWhen,values,id=>{const dep=visibilityDefinition.fields.find(f=>f.fieldId===id);return !!dep&&fieldVisible(visibilityDefinition,dep,values);}),id='field-'+f.fieldId;
  const props={id,name:f.fieldId,required:required&&!deferRequired,disabled:mode==='read','aria-invalid':!!errors[f.fieldId],'aria-describedby':errors[f.fieldId]?id+'-error':undefined};
  let control;
  if(f.type==='money'||f.type==='money_range')control=<fieldset><legend>{f.label}{required?" *":""}</legend><MoneyField value={v} onChange={v=>set(f.fieldId,v)} range={f.type==='money_range'} disabled={mode==='read'} /></fieldset>;
  else if(f.type==='select')control=<select {...props} value={v??''} onChange={e=>set(f.fieldId,e.target.value||null)}><option value="">请选择</option>{f.options.filter(o=>o.active||o.id===v).sort((a,b)=>a.order-b.order).map(o=><option key={o.id} value={o.id} disabled={!o.active&&o.id!==v}>{o.label}{o.active?'':'（已停用）'}</option>)}{v&&!f.options.some(o=>o.id===v)&&<option value={v}>{v}（原值）</option>}</select>;
  else if(f.type==='multiselect'&&!f.coreKey)control=<select {...props} multiple value={v||[]} onChange={e=>set(f.fieldId,[...e.target.selectedOptions].map(o=>o.value))}>{f.options.filter(o=>o.active||(v||[]).includes(o.id)).map(o=><option key={o.id} value={o.id}>{o.label}{o.active?'':'（已停用）'}</option>)}</select>;
  else if(f.type==='boolean')control=<select {...props} value={v===true?'true':v===false?'false':''} onChange={e=>set(f.fieldId,e.target.value===''?null:e.target.value==='true')}><option value="">未明确</option><option value="true">是</option><option value="false">否</option></select>;
  else if(f.type==='longtext')control=<textarea {...props} value={v??''} rows={4} maxLength={f.constraints.maxLength??30000} placeholder={f.placeholder} onChange={e=>set(f.fieldId,e.target.value)}/>;
  else if(f.type==='multiselect')control=<input {...props} value={(v||[]).join('，')} placeholder={f.placeholder||'逗号分隔，保留原始业务用词'} onChange={e=>set(f.fieldId,e.target.value.split(/[,，;；\n]/).map(s=>s.trim()).filter(Boolean))}/>;
  else control=<input {...props} type={f.type==='number'?'number':f.type==='datetime'?'datetime-local':f.type==='date'?'date':'text'} min={f.constraints.min} max={f.constraints.max} step={f.type==='number'?(f.constraints.precision===undefined?'any':10**-f.constraints.precision):undefined} maxLength={f.constraints.maxLength} placeholder={f.placeholder} value={f.type==='datetime'&&v?new Date(new Date(v).getTime()-new Date(v).getTimezoneOffset()*60000).toISOString().slice(0,16):v??''} onChange={e=>set(f.fieldId,e.target.value===''?null:f.type==='number'?Number(e.target.value):f.type==='datetime'?new Date(e.target.value).toISOString():e.target.value)} />;
  return <div key={f.fieldId} className={f.type==='longtext'||f.type.startsWith('money')?'span-2':''}>{f.type.startsWith('money')?control:<Field label={f.label+(f.unit?'（'+f.unit+'）':'')} required={required} hint={f.description}>{control}</Field>}{errors[f.fieldId]&&<p id={id+'-error'} className="error" role="alert">{errors[f.fieldId]}</p>}</div>;
 })}</div>;
}
