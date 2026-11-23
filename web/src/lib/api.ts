let csrf = "";
export const realtimeProtocols=()=>["recruit-realtime","csrf."+csrf];
// Only opaque digests and operation IDs live in memory. Never persist form,
// resume or credential plaintext. An uncertain operation survives form retries.
const pending = new Map<string,string>();
export function setCsrf(value: string) {
  if(value!==csrf)pending.clear();
  csrf = value;
}
async function operationDigest(path:string,method:string,body:unknown) {
  const digest = async(value:BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const parts:unknown[]=[];
  if(body instanceof FormData){
    for(const [name,value] of body.entries())parts.push([name,typeof value==='string'?value:{name:value.name,type:value.type,size:value.size,hash:await digest(await value.arrayBuffer())}]);
  }else parts.push(body);
  return digest(new TextEncoder().encode(JSON.stringify([csrf,method,path,parts])));
}
const messages: Record<string, string> = {
 calendar_sync_disabled:"共享面试日历同步未开启，请联系管理员配置。",
 calendar_event_changed:"飞书事件已更新，请关闭此窗口、刷新同步记录后重新核对。",
 calendar_local_changed:"工作台安排已更新，请关闭此窗口、刷新后重新核对。",
 calendar_binding_participant_invalid:"主责或 HR 必须从该日程的内部参与人选择。",
 directory_inactive:"员工已停用或不在招聘应用通讯录范围，请核对。",
 membership_disabled:"该成员已禁用或拒绝，不能自动恢复。",
 assistant_busy:"已有实时连接或服务繁忙，请停止旧连接后重试。",
 temporary_realtime_relay_required:"临时权限需使用工作台的实时语音连接，请刷新页面。",
 shared_calendar_sync_enabled:"共享日历已自动同步，无需另行发送邀请。",
 interview_deleted:"这场面试已移入回收记录，请恢复后再编辑或评估。",
 active_workflow_exists:"此人仍有正在推进的招聘流程，请先在流程中记录结果。",
 mailbox_not_found:'邮箱或邮件尚未同步，请稍后刷新。',
 mailbox_attachment_not_importable:'该附件暂不支持直接解析，请下载原件处理。',
 mailbox_already_imported_other_job:'该简历已经导入其他岗位，请在原候选人流程中处理转岗。',
 mailbox_integrity_error:'归档文件校验未通过，请联系管理员检查。',
 mailbox_sync_pending:'邮箱仍在同步，请稍后再次更新。',
 mailbox_existing_immutable:'更新只补入新人，不能覆盖已有人员的简历或人工修改。',
 assistant_minutes_missing:'模型未生成有效纪要，会话和原话已保留，请重试结束。',
 assistant_candidate_evidence_required:'当前为不区分说话人的纪要，不能直接作为个人能力评估草稿。',
 assistant_excerpt_invalid:'摘录必须是混合记录中连续存在的原话，请核对文本。',
 assistant_realtime_not_configured:'Qwen Realtime 尚未配置，请联系管理员。',
 assistant_realtime_unavailable:'Qwen Realtime 建连失败，请检查 API 配置、模型权限及网络。',
 assistant_realtime_invalid:'实时服务未返回有效连接应答，未开始采集。',
 assistant_context_preparing:'正在整理本场长历史，请稍后重新连接；原话未丢失。',
 assistant_context_budget:'面试文字已超过当前上下文预算，已停止实时更新。原话仍保留，请先结束复盘。',
 feishu_new_interview_only:'仅可为本次新建的面试安排创建飞书日程。',
 feishu_interview_changed:'面试安排已变更，请先核对安排和飞书日程，避免发送过期邀请。',
 feishu_meeting_busy:'正在创建同一场会议，请稍后重试。',
 feishu_meeting_time_invalid:'面试时间已过去，请核对开始时间。',
 feishu_participant_invalid:'所选面试官的企业账号已失效或不可用，请核对成员。',
 feishu_calendar_not_ready:'山子招聘的应用日历尚不可用，请核对飞书日历权限。',
 feishu_meeting_unavailable:'飞书请求超时，可重试确认结果；不会重复新建日程。',
 feishu_meeting_invalid:'飞书返回的信息不完整，请稍后重试。',
 feishu_invitation_pending:'日程已创建，部分邀请尚未确认，请重试完成邀请。',
 feishu_meeting_link_pending:'日程已创建，会议链接尚未就绪，请稍后重试。',
 feishu_meeting_cancelled:'飞书日程已取消，请在飞书中核对。',

 model_not_configured:"公司模型尚未配置，请联系管理员。",
 model_config_invalid:"模型配置无效，请联系管理员核对。",
 model_unavailable:"公司模型暂时不可用或请求超时，未保存新题库，请稍后重试。",
 model_response_invalid:"模型返回的题单格式不完整，未保存，请重新生成或使用规则题库。",
 not_applicable_note_required:'标记不适用时必须填写说明。',
 checklist_incomplete:'必需资料仍有待处理项，请先逐项核对。',
 checklist_already_open:'此清单已启用，请载入最新进度。',
 checklist_item_retired:'此事项已停用，请查看历史记录。',
 cc_recipient_invalid:'具体责任人已失效或不属于当前企业，请重新选择。',
 inactive_item_required:'停用事项不能保持必需。',
 duplicate_checklist_item:'清单事项标识重复，请使用独立事项。',
 match_weight_sum:'技能、经验和学历权重之和必须为 100%。',
 match_threshold_order:'绿色阈值必须高于橙色阈值。',
 match_group_weight:'至少一个技能组的权重必须大于 0。',
 match_duplicate_condition:'同组技能条件重复，请合并重复条件。',
 match_skill_unregistered:'请从已登记的专业技能中选择条件。',
 duplicate_evaluation_anchor:'同一维度不能重复设置相同分数的锚点。',
 duplicate_evaluation_dimension:'评分维度重复，请检查配置。',
 question_limit:'题目数量超过上限，请减少各组出题数量。',
 prd_default_immutable:'PRD 默认模板保持只读，请复制为公司模板。',

  evaluation_score_required:'请补齐评估模板中要求的有效评分（1–5 分，步长 0.5）。',
  evaluation_dimension_forbidden:'年龄、性别及薪酬不能用作评分维度。',
  material_source_forbidden:'材料包含当前无权读取的历史字段，请联系管理员或按当前授权重新生成。',
  source_fields_forbidden:'原件包含当前无权读取的字段；可查看获授权的专业事实。',
  template_preview_stale:'模板预览已过期，请刷新预览并重新核对。',
  template_preview_invalid:'模板预览凭据无效，请重新预览。',
  template_reference_invalid:'请选择已发布且用途一致的模板版本。',
  question_placeholder_forbidden:'题库占位符不在允许范围内，或当前无权读取对应字段。',
  question_template_not_applicable:'请核对题库的岗位族、等级和面试轮次适用范围。',
  matching_sort_forbidden: "当前字段权限不支持按参考分排序，请选择其他排序或打开单条对照",
  matching_inputs_forbidden: "当前字段权限不允许查看此专业对照或相关材料，请联系管理员",
  legacy_unpinned_task: "此任务来自旧版，缺少固定输入版本，请明确重新发起重算",
  backup_attachments_omitted: "此副本不含简历附件，请下载轻量副本；完整备份需从原始数据导出。",
  backup_requires_cli:
    "网页备份导入、导出上限为 64MiB；大备份请使用管理员本机备份/恢复工具，也可省略简历附件生成轻量备份",
  offer_nodes_incomplete:
    "Offer 前 4 项节点未齐备，请先在「招聘助手」勾选并保存后再流转到已发 offer",
  review_incomplete:
    "归档条件未齐备：纪要 5 项、输出自查 6 项与「结论不成立条件」都需人工完成后才能归档",
  real_name_invalid: "请填写真实姓名，平台隐名不能作为核对身份的依据",
  invalid_backup_json: "JSON 备份格式不正确，请检查导出文件或粘贴内容",
  import_preview_invalid: "预览已过期或输入/权限已变化，请重新校验后确认",
  import_confirmation: "请先核对预览并确认创建独立副本",
  migration_conflicts: "备份存在未处理冲突，请重新校验并补齐映射",
  credential_key_missing: "校招密钥不可用，请恢复本机私有密钥后重试",
  rate_limited: "操作过于频繁，请稍后重试（凭据查看每 5 分钟最多 10 次；AI 出题最多 20 次）",
  duplicate_field_label: "字段名称不能重复",
  duplicate_option: "选项标识或启用名称重复，请检查",
  field_range_invalid: "最小值不能大于最大值",
  hidden_field_required: "隐藏或停用字段不能保持必填",
  condition_cycle: "条件依赖存在循环，请调整相关字段",
  condition_unsatisfiable: "条件互相矛盾，请检查等值、范围和空值规则",
  condition_permission_dependency: "条件引用的字段权限不足，或依赖字段已停用",
  condition_field_unknown: "条件引用了不存在的字段",
  credential_field_forbidden: "账号密码及访问凭据请使用校招专用加密入口",
  field_invalid: "请检查此字段的内容、类型或范围",
  field_required: "请补充必填字段",
  configured_query_required: "此字段包含条件权限，请使用字段视图查询或导出",
  field_query_forbidden: "当前列、条件或导出字段已失效，或没有读取权限，请重新选择",
  view_invalid: "此视图含失效字段或已收回的权限，请修改后再查询",
  configuration_changed: "配置已更新，输入内容已保留，请核对新配置后再保存",
  client_update_required: "页面已更新，请刷新后使用新版工作台",
  historical_application: "此申请已归档，请打开候选人的当前流程",
  flow_reason_required: "请选择流转原因",
  flow_opinion_required: "流转意见至少填写 5 个字",
  termination_required: "请选择终止原因，其他原因须补充说明",
  primary_interviewer_required: "请选择参与本场的主责面试官",
  job_level_required: "保存前必须选择内部岗位等级",
  real_name_required: "平台隐名候选人请先补录真实姓名，再进入面试环节",
  market_source_required: "市场参考值必须注明来源",
  job_close_confirmation: "候选人名单已有变化，请重新查看关闭提醒并确认",
  private_evaluation_draft:
    "主责评估仍是他人的私有草稿，请由原作者或录入者提交后再协作修订",
  login_required: "请先通过企业飞书登录",
  session_invalid: "登录已失效，请重新登录",
  approval_required: "账号正在等待管理员审批",
  forbidden: "当前账号没有此项权限",
  version_conflict: "记录已被其他人更新，请刷新后核对再操作",
  duplicate_record: "已存在相同记录，请核对重复申请",
  matching_in_progress: "专业条件正在重算，请稍后再试",
  contact_time_required: "请记录实际联系时间",
  contact_state_conflict: "已记录实际联系时，初始状态不能选择未联系",
  stage_confirmation: "跨阶段操作需要确认和理由",
  rejection_required: "请填写淘汰原因与详细说明",
  candidate_has_applications: "请先处理或删除此人的关联申请",
  candidate_deleted: "请先恢复候选人",
  resume_required: "请先为申请选择简历版本",
  directory_unavailable: "飞书通讯录暂时不可用，请稍后再试",
  database_unavailable: "服务暂时不可用，修改尚未提交",
  invalid_input: "请检查必填字段、内容和格式",
  job_closed: "岗位已关闭，请重新选择在招岗位",
  evaluation_incomplete: "提交前请填写事实、总结和人工结论",
  file_too_large: "单份文件不得超过 10MB",
  invalid_document: "文件无法提取，请检查格式或改用粘贴文本",
  citation_immutable: "原始引用不能改写，请另增人工问题",
  last_admin: "至少保留一名有效管理员",
  csrf_invalid: "会话校验失败，请刷新页面",
  oauth_state_invalid: "本次登录已过期，请重新发起飞书登录",
};
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(
    code: string,
    status: number,
  ) {
    super(messages[code] || messages[code.split(':')[0]] || `操作未完成（${code}）`);
    this.code = code; this.status = status;
  }
}
export async function api<T = any>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    key?: string;
    raw?: boolean;
  } = {},
): Promise<T> {
  const method = options.method || "GET",
    headers: Record<string, string> = {};
  let intent:string|undefined;
  if (method !== "GET") {
    headers["x-csrf-token"] = csrf;
    if(!options.key){
      intent=await operationDigest(path,method,options.body);
      if(!pending.has(intent))pending.set(intent,crypto.randomUUID());
    }
    headers["idempotency-key"] = options.key || pending.get(intent!)!;
  }
  const isForm = options.body instanceof FormData;
  if (options.body !== undefined && !isForm)
    headers["content-type"] = "application/json";
  const response = await fetch("/api/v4" + path, {
    method,
    headers,
    body:
      options.body === undefined
        ? undefined
        : isForm
          ? (options.body as FormData)
          : JSON.stringify(options.body),
    signal: options.signal,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    let code = "request_failed";
    try {
      code = (await response.json()).error?.code || code;
    } catch {}
    if(response.status===403&&/^\/interviews\/[^/]+\/(assistant|materials|schedule|evaluation)/.test(path))window.dispatchEvent(new CustomEvent('interview-access-denied',{detail:path.split('/')[2]}));
    if (response.status === 401) {
      setCsrf("");
      window.dispatchEvent(new Event("session-expired"));
    }
    if(intent && response.status>=400 && response.status<500 && ![408,429].includes(response.status))pending.delete(intent);
    throw new ApiError(code, response.status);
  }
  // A truncated successful response is still uncertain: retry the same key.
  const result=options.raw?await response.blob():(await response.json()).data;
  if(intent)pending.delete(intent);
  return result as T;
}
export const query = <T = any>(
  path: string,
  body: unknown = {},
  signal?: AbortSignal,
) => api<T>(path, { method: "POST", body, signal });
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function csvDocument(rows: (string | number | null | undefined)[][]) {
  const cell = (value: string | number | null | undefined) => {
    const text = String(value ?? "");
    const safe = /^[=+\-@\t\r]/.test(text.trimStart()) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  return "\ufeff" + rows.map(row => row.map(cell).join(",")).join("\r\n");
}

export function downloadCsv(name: string, rows: (string | number | null | undefined)[][]) {
  const text = csvDocument(rows);
  download(new Blob([text], { type: "text/csv;charset=utf-8" }), name);
}
export async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}
