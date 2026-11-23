export type RuleQuestion = {
  id: string;
  skill: string;
  prompt: string;
  followups: string[];
  referencePoints: string[];
  source: {
    kind: "rule_catalog" | "generic_template";
    id: string;
    version: number;
  };
  coverage: "specialized" | "generic";
};
const data: Record<
  string,
  { prompt: string; followups: string[]; referencePoints: string[] }
> = {
  Java: {
    prompt:
      "一个 Java 服务在并发增加时出现偶发重复写入，你如何定位并设计一致性控制？",
    followups: ["如何区分线程内同步和跨进程事务？", "重试时如何保证幂等？"],
    referencePoints: [
      "明确共享状态与事务边界",
      "结合唯一约束、锁或乐观版本控制",
      "用可重现并发测试验证",
    ],
  },
  Python: {
    prompt:
      "一个 Python 数据处理任务在大文件输入时内存持续上涨，你如何测量并改进？",
    followups: [
      "迭代器与批处理各适用什么情形？",
      "如何验证异常和取消后资源释放？",
    ],
    referencePoints: [
      "先测峰值内存与对象生命周期",
      "使用有界流式处理",
      "保留正确性与性能的对照数据",
    ],
  },
  PyTorch: {
    prompt: "训练集指标提升而验证集下降时，你如何分析 PyTorch 训练过程？",
    followups: ["如何检查数据泄漏与训练/推理模式？", "如何让实验可复现？"],
    referencePoints: [
      "区分泛化问题与数据流程错误",
      "检查 train/eval、梯度及随机性",
      "对照实验记录实际结果",
    ],
  },
  大模型: {
    prompt: "如何为一个基于大模型的业务能力设计评测与失败兜底？",
    followups: ["如何区分模型错误和检索错误？", "敏感数据如何控制外发？"],
    referencePoints: [
      "使用具体任务和人工标注集",
      "报告失败类别及分母",
      "对未配置、超时与低置信结果明确降级",
    ],
  },
  Docker: {
    prompt: "容器重启后出现数据丢失，你如何分析挂载与持久化设计？",
    followups: ["如何验证备份可恢复？", "镜像层与数据卷各承担什么？"],
    referencePoints: [
      "核对实际挂载路径和卷生命周期",
      "独立临时目标执行恢复验证",
      "避免把可写镜像层当数据持久化",
    ],
  },
  Kubernetes: {
    prompt: "一个 Kubernetes 服务滚动更新时请求失败率上升，你如何定位？",
    followups: [
      "readiness 与 liveness 的语义有什么区别？",
      "如何验证终止排空和回滚？",
    ],
    referencePoints: [
      "以请求与事件时间线定位",
      "检查探针、容量和终止宽限期",
      "通过可观测的负载验证修复",
    ],
  },
};
export function questionFor(skill: string): RuleQuestion {
  const q = data[skill] || {
    prompt: "请以一个实际项目说明你如何使用 " + skill + " 完成岗位相关任务。",
    followups: [
      "你的具体职责、约束与验证方法是什么？",
      "遇到失败时如何复盘与改进？",
    ],
    referencePoints: [
      "职责和项目事实可核对",
      "解释方案取舍",
      "给出验证方法和局限",
    ],
  };
  const id = "professional." + skill + ".v1";
  const specialized = !!data[skill];
  return {
    id,
    skill,
    ...q,
    coverage: specialized ? "specialized" : "generic",
    source: {
      kind: specialized ? "rule_catalog" : "generic_template",
      id: specialized ? id : "general.project.v1",
      version: 1,
    },
  };
}
export interface MaterialProvider {
  readonly name: string;
  generate(input: {
    requirements: unknown;
    professionalEvidence: unknown;
  }): Promise<unknown>;
}
export const modelCapability = {
  configured: false,
  provider: null,
  reason: "首发使用规则题库；大模型接口预留，未发送外部请求",
};
