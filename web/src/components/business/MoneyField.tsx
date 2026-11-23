import {useId} from 'react';
import {moneyDraft,changeMoneyPeriod,type MoneyValue} from '../../lib/money';
export default function MoneyField({value,onChange,disabled=false,range=true}:{value:Partial<MoneyValue>|null|undefined;onChange:(value:MoneyValue)=>void;disabled?:boolean;range?:boolean}){
 const id=useId(),m=moneyDraft(value),set=(part:Partial<MoneyValue>)=>onChange({...m,...part});
 return <fieldset className="money-fields" disabled={disabled}>
  <div className="form-grid">
   <label htmlFor={id+'-min'}>{range?'最低金额':'金额'}<input id={id+'-min'} inputMode="decimal" value={m.min??''} maxLength={42} placeholder="直接填写元金额，如 300000" onChange={e=>set({min:e.target.value||null})}/></label>
   {range&&<label htmlFor={id+'-max'}>最高金额<input id={id+'-max'} inputMode="decimal" value={m.max??''} maxLength={42} onChange={e=>set({max:e.target.value||null})}/></label>}
   <label htmlFor={id+'-currency'}>币种<input id={id+'-currency'} value={m.currency} maxLength={3} placeholder="CNY" onChange={e=>set({currency:e.target.value.toUpperCase()})}/></label>
   <label htmlFor={id+'-period'}>金额口径<select id={id+'-period'} value={m.period} onChange={e=>onChange(changeMoneyPeriod(m,e.target.value as MoneyValue['period']))}><option value="annual">税前现金年包</option><option value="monthly">税前月薪</option></select></label>
   <label htmlFor={id+'-months'}>每年发薪月数（未明确可留空）<input id={id+'-months'} type="number" min={1} max={36} step={1} value={m.salaryMonths??''} onChange={e=>set({salaryMonths:e.target.value===''?null:Number(e.target.value)})}/></label>
   {(['includesBonus','includesEquity'] as const).map(key=><label key={key} htmlFor={id+'-'+key}>{key==='includesBonus'?'现金金额是否含奖金':'原始总包是否另含股权'}<select id={id+'-'+key} value={m[key]} onChange={e=>set({[key]:e.target.value})}><option value="unknown">未明确</option><option value="yes">是</option><option value="no">否</option></select></label>)}
  </div>
  {m.includesEquity==='yes'&&<label>股权单独说明<textarea value={m.equityNote} maxLength={2000} onChange={e=>set({equityNote:e.target.value})}/></label>}
  <label>薪酬原始表述<textarea value={m.raw} maxLength={4000} onChange={e=>set({raw:e.target.value})}/></label>
  <label>核对与口径说明<textarea value={m.basis} maxLength={2000} onChange={e=>set({basis:e.target.value})}/></label>
  <p className="muted">金额以元填写。股权单独记录；原文、月薪和年包保留各自口径，换算候选值须人工确认。</p>
 </fieldset>;
}
