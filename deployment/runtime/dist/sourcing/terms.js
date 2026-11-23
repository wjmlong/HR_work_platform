const institution = /(大学|学院|学校|研究院|研究所|实验室|科学院|公司|集团|银行|医院|中心|university|institute|lab|inc|corp)/i;
export function searchTermPlan(word) {
    const lower = word.toLowerCase(), broaden = /^[\u4e00-\u9fff]{2,}$/.test(word) && !institution.test(word);
    const coverage = Array.from({ length: word.length }, () => new Set()), grams = new Set();
    if (broaden)
        for (const size of [2, 3])
            for (let index = 0; index + size <= word.length; index++) {
                const gram = word.slice(index, index + size);
                grams.add(gram);
                for (let at = index; at < index + size; at++)
                    coverage[at].add(gram);
            }
    return { word: lower, ascii: /^[a-z0-9_]+$/i.test(word), broaden, grams: [...grams], coverage: coverage.map(items => [...items]) };
}
//# sourceMappingURL=terms.js.map