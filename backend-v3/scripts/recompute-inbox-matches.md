收件箱岗位匹配维护（不会调用模型、创建岗位申请或推进阶段）

正常运行的 worker 每分钟为过期或没有结果的收件箱简历排队，每轮最多25人。同一资料和岗位指纹失败后不自动重复请求。列表读取缓存；模型请求只在后台执行，沿用现有企业模型配置。

默认命令只读，明确指定候选人范围；`--candidate-id` 可重复。`--all-inbox` 每次最多审阅300人。运行环境沿用已有 `RECRUIT_V4_*` 环境配置，不在命令中填写密码。

```sh
node scripts/recompute-inbox-matches.mjs --candidate-id CANDIDATE_UUID --repair-generic-intent
```

先审阅输出的 `items` 与 `previewHash`。符合原始导入缺陷的通用假意向才会出现 `repair`：原任务带邮箱来源、`initialPosition` 与当前值相同、附件解析意向为空、从v1到当前每一个资料历史意向值均未变化。只清空该意向字段，保留姓名等其他资料，增加版本、资料历史及审计。任何资料/岗位变化使预览hash失效。

```sh
node scripts/recompute-inbox-matches.mjs --candidate-id CANDIDATE_UUID --repair-generic-intent --apply --preview-hash REVIEWED_HASH --actor-id ACTIVE_HR_UUID
```

省略 `--repair-generic-intent` 只安排缺失/过期岗位匹配。模型恢复后若需重试同一资料的失败结果，预览和apply均加 `--force-recompute`。apply只入队；不会同步调用模型。脚本从已构建的 `dist` 加载，不需要release包含src或tsx。维护操作按既有数据库权限执行，必须在计划发布的代码和指定数据库环境运行。默认dry-run不执行迁移、不写入数据。

旧邮件正文超过4000字时，worker从现有邮箱原件档案补读完整正文；原件不可用则保留待确认。原件读取不会修改旧导入任务。推荐结果写在最新简历 `configuration_refs.inboxMatch` 中，不写入本人意向；候选人、简历或在招岗位变化立即使结果失效。
