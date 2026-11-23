import {z} from '../http/validation.js';
import {fail} from '../http/errors.js';
export type MoneyValue={min:string|null;max:string|null;currency:string;period:'annual'|'monthly';salaryMonths:number|null;includesBonus:'yes'|'no'|'unknown';includesEquity:'yes'|'no'|'unknown';equityNote:string;raw:string;basis:string};
const moneySchema=z.object({
 min:z.string().max(42).nullable().default(null),max:z.string().max(42).nullable().default(null),currency:z.string().regex(/^[A-Z]{3}$/).default('CNY'),period:z.enum(['annual','monthly']).default('annual'),salaryMonths:z.number().int().min(1).max(36).nullable().default(null),
 includesBonus:z.enum(['yes','no','unknown']).default('unknown'),includesEquity:z.enum(['yes','no','unknown']).default('unknown'),equityNote:z.string().max(2000).default(''),raw:z.string().max(4000).default(''),basis:z.string().max(2000).default(''),
}).strict();
export function decimalAmount(value:string|null):string|null{
 if(value===null||value.trim()==='')return null;
 const s=value.trim();if(!/^\d{1,36}(?:\.\d{1,4})?$/.test(s))fail(422,'money_invalid');
 const [whole,fraction='']=s.split('.'),integer=whole.replace(/^0+(?=\d)/,'');
 const places=fraction.replace(/0+$/,'');return integer+(places?'.'+places:'');
}
function scaled(value:string,places:number){const [a,b='']=value.split('.');return BigInt(a+b.padEnd(places,'0'));}
export function compareAmounts(a:string,b:string){const places=Math.max(a.split('.')[1]?.length||0,b.split('.')[1]?.length||0),x=scaled(a,places),y=scaled(b,places);return x<y?-1:x>y?1:0;}
export function multiplyAmount(value:string,factor:number){
 const normalized=decimalAmount(value)!;if(!Number.isSafeInteger(factor)||factor<0||factor>1000000)fail(422,'money_invalid');
 const places=normalized.split('.')[1]?.length||0,n=scaled(normalized,places)*BigInt(factor),digits=n.toString().padStart(places+1,'0');
 return decimalAmount(places?digits.slice(0,-places)+'.'+digits.slice(-places):digits)!;
}
export function parseMoney(input:unknown):MoneyValue{
 const parsed=moneySchema.safeParse(input);if(!parsed.success)fail(422,'money_invalid');
 const m={...parsed.data,min:decimalAmount(parsed.data.min),max:decimalAmount(parsed.data.max)};
 if(m.min!==null&&m.max!==null&&compareAmounts(m.min,m.max)>0||[m.raw,m.basis,m.equityNote].some(s=>s.includes('\0')))fail(422,'money_invalid');
 return m;
}
export function compareMoney(a:MoneyValue,b:MoneyValue){
 const same=a.currency===b.currency&&a.period===b.period&&a.includesBonus===b.includesBonus&&a.includesEquity===b.includesEquity&&a.includesBonus!=='unknown'&&a.includesEquity!=='unknown';
 const left=a.min??a.max,right=b.min??b.max;if(!same||left===null||right===null)fail(422,'money_not_comparable');return compareAmounts(left,right);
}
export type SalaryInterpretation={raw:string;classification:'annual_explicit'|'monthly_with_months'|'unknown';proposedAnnual:string|null;proposed:MoneyValue|null;basis:string};
export function interpretSalary(raw:string):SalaryInterpretation{
 const unknown=(basis='原文未明确年度现金薪酬口径'):SalaryInterpretation=>({raw,classification:'unknown',proposedAnnual:null,proposed:null,basis});
 if(typeof raw!=='string'||raw.length>4000||raw.includes('\0'))return unknown('原始表述需要人工核对');
 const source=raw.replace(/不含(?:股权|期权|股票)/g,'');
 if(/税后|到手|股权|期权|股票|[+＋]/i.test(source))return unknown('税后或现金/股权混合口径，需人工核对');
 const annual=/年包|年薪|年总包|\/年|每年|annual|per\s+year|\/year/i.test(raw),monthly=/月薪|\/月|每月|monthly|per\s+month/i.test(raw);
 if(annual===monthly)return unknown();
 const amount='(\\d+(?:\\.\\d+)?)\\s*(万|千|[kKwW]|元)?(?:\\s*[-—–~～至到]\\s*(\\d+(?:\\.\\d+)?)\\s*(万|千|[kKwW]|元)?)?';
 const prefix=new RegExp('(?:期望(?:税前)?年包|期望年薪|年包|年薪|期望月薪|月薪|annual\\s+salary|monthly\\s+salary)\\s*[:：]?\\s*(?:CNY|RMB|USD|EUR|¥|￥|\\$|€)?\\s*'+amount,'i');
 const suffix=new RegExp(amount+'\\s*(?:\\/年|年薪|年包|每年|\\/月|每月)','i');
 const match=raw.match(prefix)||raw.match(suffix);if(!match)return unknown('金额范围未能可靠识别');
 const months=raw.match(/(?:^|[^\d])(\d{1,2})\s*薪/),salaryMonths=months?Number(months[1]):null;
 const remaining=raw.replace(match[0],'').replace(/\d{1,2}\s*薪/g,'');
 if(/\d/.test(remaining))return unknown('存在多段金额或时间，需人工核对');
 if(monthly&&salaryMonths===null)return unknown('原文仅有月薪，未明确每年发薪月数');
 const currencies=[/USD|美元|\$/i.test(raw)?'USD':null,/EUR|欧元|€/i.test(raw)?'EUR':null,/CNY|RMB|人民币|¥|￥/i.test(raw)?'CNY':null].filter(Boolean);
 if(new Set(currencies).size>1)return unknown('出现不同币种，不能合并');
 const unit=(u:string|undefined)=>u==='万'||u?.toLowerCase()==='w'?10000:u==='千'||u?.toLowerCase()==='k'?1000:1;
 try{
  const min=multiplyAmount(match[1],unit(match[2]||match[4])),max=match[3]?multiplyAmount(match[3],unit(match[4]||match[2])):null;
  const proposed=parseMoney({min:monthly?multiplyAmount(min,salaryMonths!):min,max:monthly&&max!==null?multiplyAmount(max,salaryMonths!):max,currency:currencies[0]||'CNY',period:'annual',salaryMonths,
   includesBonus:/不含(?:奖金|年终)/.test(raw)?'no':/含(?:奖金|年终)/.test(raw)?'yes':'unknown',includesEquity:/不含(?:股权|期权|股票)/.test(raw)?'no':'unknown',raw,basis:monthly?'原文明示月薪及每年发薪月数；候选值需人工采用':'原文明示年度薪酬；候选值需人工采用'});
  return {raw,classification:annual?'annual_explicit':'monthly_with_months',proposedAnnual:proposed.min,proposed,basis:proposed.basis};
 }catch{return unknown('金额或月数范围需要人工核对');}
}
