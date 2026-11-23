export type MoneyValue={min:string|null;max:string|null;currency:string;period:'annual'|'monthly';salaryMonths:number|null;includesBonus:'yes'|'no'|'unknown';includesEquity:'yes'|'no'|'unknown';equityNote:string;raw:string;basis:string};
export function moneyDraft(value:Partial<MoneyValue>|null|undefined):MoneyValue{
 return {min:null,max:null,currency:'CNY',period:'annual',salaryMonths:null,includesBonus:'unknown',includesEquity:'unknown',equityNote:'',raw:'',basis:'',...value};
}
export function changeMoneyPeriod(value:MoneyValue,period:MoneyValue['period']):MoneyValue{
 return value.period===period?value:{...value,period,min:null,max:null,basis:'口径已变更，请核对后重新填写金额'};
}
export function moneyText(value:MoneyValue|null|undefined):string{
 if(!value)return '未明确';const amount=value.min===null&&value.max===null?'金额未明确':value.min&&value.max?value.min+'–'+value.max:value.min!==null?value.min+' 起':'不高于 '+value.max;
 return `${amount} ${value.currency} / ${value.period==='annual'?'年':'月'}${value.salaryMonths?' · '+value.salaryMonths+' 薪':''}`;
}
