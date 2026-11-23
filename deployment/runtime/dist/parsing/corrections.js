export function applyCorrections(parsed, corrections = []) {
    const facts = corrections || [];
    for (const item of facts) {
        parsed.profile[item.field] = item.value;
        parsed.evidence = parsed.evidence.filter((e) => item.field === "skills"
            ? !e.field.startsWith("skill:")
            : e.field !== item.field);
    }
    parsed.warnings = parsed.warnings.filter(w => !w.startsWith('missing_') && (w !== 'name_unknown' || parsed.profile.name === '待确认'));
    for (const field of ['phone', 'email', 'education', 'school', 'bachelorSchool', 'experienceYears', 'location'])
        if (parsed.profile[field] === null || parsed.profile[field] === '')
            parsed.warnings.push('missing_' + field);
    return { ...parsed, assertions: facts };
}
//# sourceMappingURL=corrections.js.map