import type { Parsed } from "./profile.js";
export type HumanCorrection = {
  field: string;
  value: unknown;
  actorId: string;
  reason: string;
  at: string;
};
export function applyCorrections(
  parsed: Parsed,
  corrections: HumanCorrection[] = [],
): Parsed & { assertions: HumanCorrection[] } {
  const facts = corrections || [];
  for (const item of facts) {
    (parsed.profile as any)[item.field] = item.value;
    parsed.evidence = parsed.evidence.filter((e) =>
      item.field === "skills"
        ? !e.field.startsWith("skill:")
        : e.field !== item.field,
    );
  }
  parsed.warnings=parsed.warnings.filter(w=>!w.startsWith('missing_')&&(w!=='name_unknown'||parsed.profile.name==='待确认'));
  for(const field of ['phone','email','education','school','bachelorSchool','experienceYears','location'] as const)
    if(parsed.profile[field]===null||parsed.profile[field]==='')parsed.warnings.push('missing_'+field);
  return { ...parsed, assertions: facts };
}
