export function csvCell(value:unknown){
 const text=value==null?'':String(value),safe=/^[=+\-@\t\r]/.test(text.trimStart())?"'"+text:text;
 return '"'+safe.replaceAll('"','""')+'"';
}
export function csvDocument(rows:unknown[][]){return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';}
