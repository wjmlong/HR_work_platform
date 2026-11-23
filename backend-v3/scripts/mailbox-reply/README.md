# 单收件人邮件回复的 EWS 发信通道

已核实正式同步入口是 `recruit-mailbox-sync.service` → `sync.py` → `ews.py`，现运行代码使用 EWS/NTLMv2，不是 POP3。原客户端的 `GetFolder`、`SyncFolderItems`、`GetItem` 只读限制保持不变。

`bridge.py` 是独立进程，接收应用鉴权并经 HR 核对的单收件人邮件。它从既有 `Ews` 初始化复用证书 DER SHA-256 pin 和 `dependencyPath`，使用同样的 NTLMv2、`tls-server-end-point` channel binding、证书链及主机名验证。无需在 Node 容器安装 Python 或实现 NTLM 密码学。测试接口仍固定发送到 `recruiting-operator@example.invalid`；正式回复接口允许已确认的单个地址。发往该验证邮箱的记录不计入候选人已回复，正式模式不自动追加测试主题前缀。

## 宿主机配置

以现有 `lab`（UID 1000）运行；禁止 root 运行。新私有目录建议为 `/home/lab/data/recruit-workbench/private/mail-reply`，目录权限 `0700`，所有配置和 token 为 `0600`，所有者为 `lab:lab`。现有 Docker `/data` 挂载已经覆盖该目录。

`bridge.json`：

```json
{
  "mailboxConfigFile": "/home/lab/data/recruit-workbench/private/mail-reply/ews-account.json",
  "readOnlyClientFile": "/home/lab/apps/recruit-mailbox/ews.py",
  "socketPath": "/home/lab/data/recruit-workbench/private/mail-reply/ews.sock",
  "tokenFile": "/home/lab/data/recruit-workbench/private/mail-reply/ews.token",
  "receiptRoot": "/home/lab/data/recruit-workbench/private/mail-reply/bridge-receipts"
}
```

由管理员将现有邮箱私有配置安全复制为 `ews-account.json`；保留实际 `host`、`domain`、`username`、`password`、`account`、`certificate`、`certificateSha256` 和 `dependencyPath`。不会读取或修改原同步状态。`certificateSha256` 是证书 DER 的指纹，不是 PEM 文本的哈希。证书及依赖继续使用现有宿主机绝对路径。

`ews.token` 是随机生成的 32 字节十六进制值（64 个字符），只写入私有文件，不打印、不提交仓库。bridge 与 Node 读取同一文件。

按 `recruit-mail-reply.service.example` 安装独立 service；原同步 service 不变。启动前可运行以下**只读**校验，它仅执行 `GetFolder`，不会发信：

```sh
sudo -u lab /usr/bin/python3 /home/lab/apps/recruit-workbench/current/scripts/mailbox-reply/bridge.py --config /home/lab/data/recruit-workbench/private/mail-reply/bridge.json --check
```

## Node 私有配置

将 `RECRUIT_V4_MAIL_REPLY_CONFIG_FILE` 指向容器内的私有 JSON，内容：

```json
{
  "transport": "ews-bridge",
  "socketPath": "/data/mail-reply/ews.sock",
  "tokenFile": "/data/mail-reply/ews.token",
  "from": {
    "name": "招聘团队",
    "address": "填写 ews-account.json 中 account 的原值"
  }
}
```

`from.address` 必须精确匹配账户配置，不能使用模板示例地址。缺配置、bridge 未启动、socket/token 权限不正确时，模板仍可预览，但不能发送。SMTP 原配置格式仍兼容，不会自动尝试回退 SMTP。

## 行为及验证

`GET /status` 通过 token 鉴权，只返回发送账号、固定验证邮箱、`singleRecipientReplies` 能力和配置 HMAC revision；不进行网络登录。配置 revision 覆盖账号配置、证书 pin、只读客户端和 sender 代码，变化后必须重新预览。`POST /send` 只接收结构化纯文本邮件，限制 64 KiB，不接收任意 EWS 操作、XML、附件或外部 URL。地址严格限制为一个邮箱，不接受多个收件人、抄送或密送。业务权限、来源邮件和预览签名由应用发送服务校验，bridge 另行验证信封、固定发件账号及消息幂等键。

发送使用 `CreateItem` + `SendAndSaveCopy`，正文由受限字段生成 MIME，保留 `Message-ID`、`In-Reply-To`、`References`。Node 数据库收据先提交，bridge 再将本地收据 fsync 后请求 EWS。相同 messageId 不重复发送；进程关闭、网络结果未知或响应缺失/异常记为 unknown，不自动重试。只有明确的拒绝响应记为 failed。Python 3.6 的 MIME 先按 LF 序列化，再统一转换为 CRLF，避免中文发件人造成重复回车和收件人头解析错误。发送成功仅表示 Exchange 接受，不表示收件人已读。

本地 mock 测试：

```sh
cd backend-v3/scripts/mailbox-reply
python3 -m unittest -v test_bridge.py
```

测试涵盖纯文本 MIME/线程头、单收件人、测试前缀限制、参数和注入拒绝、NTLMv2/channel binding/pin、重启与超时去重、异常响应分类、Unix socket 鉴权和大小限制。测试不接触公司邮箱。

官方接口依据：[发送邮件](https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/how-to-send-email-messages-by-using-ews-in-exchange)、[MIME 内容](https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/how-to-import-items-by-using-ews-in-exchange)。
