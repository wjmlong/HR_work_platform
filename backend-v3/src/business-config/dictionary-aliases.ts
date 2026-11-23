import type {ConfigDocument} from './types.js';
// Normalize only new drafts/explicit repair versions; published history is immutable.
export function normalizeDictionaryAliases<T extends ConfigDocument>(document:T):T {
 if(document.kind!=='dictionary')return document;
 return {...document,options:document.options.map(option=>({...option,aliases:[...new Set(option.aliases.flatMap(alias=>alias.split(/[,，、;；\n]/).map(term=>term.trim()).filter(Boolean)))]}))};
}
