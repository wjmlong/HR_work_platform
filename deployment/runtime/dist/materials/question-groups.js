import { questionFor } from './catalog.js';
export const questionStatement = '要点是参考答案（达标线），用于面试官判分与人事做面试官训练；不是让候选人背的标准答案。';
const core = [
    ['开场破冰', '最近关注的一个与你应聘岗位有关的变化是什么？你怎样核对信息？', ['信息来源与适用范围是什么？'], ['区分亲历事实与转述', '说明信息来源和核对办法', '给出自己的判断及其局限']],
    ['开场破冰', '你希望通过这次面试了解岗位的哪些事情？', ['哪些信息会影响你的选择？'], ['问题具体、与岗位有关', '说明自己的判断依据', '能够讨论双方需要补充的信息']],
    ['自我介绍', '请用两分钟介绍与你应聘岗位最相关的一段经历。', ['你本人负责的部分与团队负责的部分分别是什么？'], ['角色边界清楚', '重点有组织', '结果可核对，不能把团队成果全归给自己']],
    ['自我介绍', '你认为最能说明当前能力的一项成果是什么？', ['怎样衡量结果，数据来自哪里？'], ['给出背景、个人行动和结果', '区分指标变化与本人贡献', '无法量化时说明可核对的产物及限制']],
    ['离职动机', '你在寻找下一份岗位时最希望发展什么？', ['当前岗位与未来期待之间的具体差距是什么？'], ['能说明发展诉求与岗位的关系', '给出具体期待而非笼统抱怨', '薪酬与工作条件可以讨论，不据动机标签下结论']],
    ['离职动机', '这份岗位哪些要求与你的期待一致，哪些还需要对齐？', ['发展、薪酬和工作安排的优先顺序是什么？'], ['了解岗位职责', '对取舍有清楚排序', '有尚未对齐的条件时能够明确提出']],
    ['行为面试（STAR）', '请介绍一个最有挑战项目当时的背景（S）。', ['当时的约束、利益相关方和信息缺口是什么？'], ['背景具体且可核对', '说明约束与信息来源', '不将后来知道的结果倒填成当时判断']],
    ['行为面试（STAR）', '在这个项目中，你承担的任务与目标（T）是什么？', ['哪些目标由你负责，验收标准由谁确定？'], ['任务边界清楚', '目标和验收标准具体', '能区分个人责任与协作责任']],
    ['行为面试（STAR）', '为完成任务，你具体采取了哪些行动（A）？', ['备选方案、取舍与反馈调整分别是什么？'], ['行动具体且按因果顺序展开', '说明为什么这样做', '能讲清关键取舍和失败后的调整']],
    ['行为面试（STAR）', '项目最终产生了什么结果（R）？', ['做完了与有效果分别有什么证据？'], ['必须区分「做完了」与「有效果」', '说明结果、基线和分母', '对外部因素、贡献归属和持续性有说明']],
    ['风险核对', '请按时间说明与你应聘岗位相关的经历变动。', ['哪些时间或职责还需要双方进一步核对？'], ['时间线与简历事实能够对照', '未知部分坦诚说明', '变动原因就事论事，由人工核对，不按次数自动下结论']],
    ['风险核对', '是否有可能影响履职的竞业、保密或交接义务？', ['哪些内容需要人事与本人进一步确认？'], ['说明已知义务与待确认范围', '不要求披露原单位商业秘密', '需要核对时明确后续负责人']],
    ['风险核对', '你预计何时可以到岗，有哪些需要提前安排的事项？', ['到岗时间是否受交接或其他已知安排影响？'], ['时间和前提条件明确', '能够说明不确定事项', '双方约定需要继续确认的动作']],
];
export function groupedQuestions(requirements) {
    const questions = core.map(([group, prompt, followups, referencePoints], i) => ({ id: 'core.' + i + '.v2', group, skill: '岗位通用核对', prompt, followups, referencePoints, source: { kind: 'rule_catalog', id: 'core.' + i, version: 2 }, coverage: 'generic', basis: 'not_applicable', evidence: [] }));
    const ordered = [...requirements.filter(r => r.status !== 'matched'), ...requirements.filter(r => r.status === 'matched')];
    if (!ordered.length)
        ordered.push({ requirement: '岗位专业实践', status: 'not_applicable', evidence: [] });
    const technical = [0, 1, 2].map(i => {
        const item = ordered[i % ordered.length], base = questionFor(item.requirement);
        return { ...base, id: base.id + '.probe' + i, group: '专业深挖', prompt: i === 0 ? base.prompt : i === 1 ? '使用 ' + item.requirement + ' 时，适用边界和不适用的情况是什么？如何在项目中验证？' : '请说明一次与 ' + item.requirement + ' 有关的失败或踩坑，根因、修复与预防办法分别是什么？', referencePoints: i === 0 ? base.referencePoints : i === 1 ? ['说明适用与不适用边界', '解释备选方案及取舍', '提供验证方法和反例'] : ['区分症状和根因', '说明实际行动及验证结果', '复盘能够形成可检验的预防措施'], basis: item.status, evidence: item.evidence || [] };
    });
    questions.splice(10, 0, ...technical);
    const missing = requirements.find(r => r.status === 'not_matched');
    if (missing)
        questions.push({ id: 'weak.' + missing.requirement + '.v2', group: '弱项专项', skill: missing.requirement, prompt: '简历中尚未检索到 ' + missing.requirement + ' 的直接证据。你有哪些相关经历，或准备怎样学习并验证这项能力？', followups: ['已经做过、尚未做过与学习计划分别是什么？'], referencePoints: ['坦诚+学习路径也算过，含糊应付不算', '区分已有事实与学习计划', '给出可执行、可验证的补足办法'], source: { kind: 'rule_catalog', id: 'weak.first_missing', version: 2 }, coverage: 'generic', basis: missing.status, evidence: missing.evidence || [] });
    return questions;
}
//# sourceMappingURL=question-groups.js.map