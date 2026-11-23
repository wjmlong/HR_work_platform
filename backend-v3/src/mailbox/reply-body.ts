// Only named HTTPS links are formatted; all other draft content remains literal text.
// Keep the equivalent MIME renderer in scripts/mailbox-reply/bridge.py in sync.
const links=/\[([^\]\r\n]+)\]\((https:\/\/[^\s<>"'()]+)\)/g;
const escapeHtml=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

export function replyBody(text:string):{text:string;html?:string}{
 const matches=[...text.matchAll(links)];
 if(!matches.length)return {text};
 let html='',offset=0;
 for(const match of matches){
  html+=escapeHtml(text.slice(offset,match.index))+`<a href="${escapeHtml(match[2])}">${escapeHtml(match[1])}</a>`;
  offset=match.index!+match[0].length;
 }
 html+=escapeHtml(text.slice(offset));
 return {text:text.replace(links,(_all,label,url)=>`${label} (${url})`),html:`<div>${html.replace(/\r\n|\r|\n/g,'<br>\n')}</div>`};
}
