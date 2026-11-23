import {memberLabel} from '../lib/member-label';
import {useState} from 'react';
import {api} from '../lib/api';import {useResource,useDebounced,type Row} from '../lib/state';
import {Resource} from '../lib/state';import {Pagination} from './ui';import {toggleMember} from '../lib/workflows';
export default function MemberPicker({role,value,onChange,multiple=true}:{role:'viewer'|'interviewer'|'owner'|'cc';value:string[];onChange:(ids:string[])=>void;multiple?:boolean}){
 const [text,setText]=useState(''),[page,setPage]=useState(1),search=useDebounced(text);
 const data=useResource<Row>(s=>api('/assignment-members?role='+role+'&query='+encodeURIComponent(search)+'&page='+page,{signal:s}),[role,search,page]);
 const names=useResource<Row>(s=>value.length?api('/assignment-members?role='+role+'&pageSize=100&ids='+value.join(','),{signal:s}):Promise.resolve({items:[]}),[role,value.join(',')]);
 const known=new Map<string,string>((names.data?.items||[]).map((p:Row)=>[p.id,memberLabel(p as {name:string})]));
 return <fieldset><legend>{role==='cc'?'抄送具体责任人（可选）':role==='viewer'?'可查看成员':role==='owner'?'线索负责人':'面试官（至少一位）'}</legend>
 <input aria-label="检索可分配成员" placeholder="按姓名检索全部可分配成员" value={text} onChange={e=>{setText(e.target.value);setPage(1)}}/>
 <p className="muted">已选 {value.length} 人；翻页和搜索会保留已选成员。</p>
 <div className="chips">{value.map(id=><button type="button" key={id} onClick={()=>onChange(value.filter(v=>v!==id))} aria-label={'移除成员'+(known.get(id)||'不可选成员')}>{known.get(id)||'停用或不可选成员'} ×</button>)}</div>
 <Resource {...data} preserve={data.data!==undefined} retry={data.reload}>{data.data?.items.map((p:Row)=><label className="check" key={p.id}><input type="checkbox" checked={value.includes(p.id)} onChange={()=>onChange(multiple?toggleMember(value,p.id):[p.id])}/>{memberLabel(p as {name:string})}</label>)}</Resource>
 <Pagination page={page} total={data.data?.total||0} onChange={setPage}/></fieldset>
}
