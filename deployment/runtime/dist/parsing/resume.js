import { parseProfile } from './profile.js';
import { generateResumeProfile } from './resume-model.js';
export async function parseResumeProfile(config, raw, aliases, generate = generateResumeProfile) {
    const parsed = parseProfile(raw, aliases);
    if (parsed.profile.name === '待确认' && !config.modelConfigFile && config.production)
        throw Error('resume_model_not_configured');
    if (parsed.profile.name !== '待确认' || !config.modelConfigFile)
        return { ...parsed, provenance: { method: 'rules', tokens: 0, elapsedMs: 0 } };
    const result = await generate(config, raw);
    return { ...parsed, profile: { ...parsed.profile, name: result.profile.name }, evidence: [...parsed.evidence.filter(e => e.field !== 'name'), ...result.evidence.filter(e => e.field === 'name')], warnings: parsed.warnings.filter(w => w !== 'name_unknown'), parserVersion: 'hybrid-ai-4.0.2', provenance: { method: 'model', model: result.model, tokens: result.tokens, elapsedMs: result.elapsedMs } };
}
//# sourceMappingURL=resume.js.map