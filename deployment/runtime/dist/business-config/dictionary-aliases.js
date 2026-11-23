// Normalize only new drafts/explicit repair versions; published history is immutable.
export function normalizeDictionaryAliases(document) {
    if (document.kind !== 'dictionary')
        return document;
    return { ...document, options: document.options.map(option => ({ ...option, aliases: [...new Set(option.aliases.flatMap(alias => alias.split(/[,，、;；\n]/).map(term => term.trim()).filter(Boolean)))] })) };
}
//# sourceMappingURL=dictionary-aliases.js.map