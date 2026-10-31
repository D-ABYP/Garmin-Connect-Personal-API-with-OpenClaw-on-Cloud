# Garmin Connect Personal API MCP

面向单用户 OpenClaw / Kimi Claw 的 Garmin 只读数据服务。通过 stdio 提供四个 MCP 工具，并附带教练 Skill、上午/睡前报告模板和邮件辅助脚本。
声明：基于Nicolasvegam/garmin-connect-mcp项目(原项目链接：https://github.com/Nicolasvegam/garmin-connect-mcp)，利用Garmin Connect Personal API和相关文件，部分重写项目。

## 安全边界

- 只使用 Garmin Connect **Personal API**，不使用 Garmin 邮箱、密码、SSO 或第三方 OAuth consumer。
- API Key 只从本地文件读取，不能通过命令行或环境变量直接传入原始 Key。
- 只读：不提供创建、修改、删除 Garmin 数据的能力。
- 不返回经纬度、GPS 轨迹、polyline、FIT 或活动 ZIP 文件。
- MCP 只提供数据；训练解释、建议和计划由 Claw 生成。
- 修改长期训练计划前，教练 Skill 要求先展示差异并取得明确确认。

官方资料：[Personal API](https://developer.garmin.com/gc-developer-program/personal/)、[FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)、[Swagger](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)。

## 环境要求

- Node.js 20+
- Garmin Connect Personal API Key
- 邮件辅助需要 Python 3；仅使用 Python 标准库
- OpenClaw 与 stdio MCP 运行在同一主机或共享持久文件系统的云环境中

## 本地构建与测试

```bash
npm ci
npm test
npm run typecheck
npm run build
python -m unittest discover -s tests -p "test_*.py"
```

所有 Node 测试使用模拟 Personal API；Python 测试使用模拟 SMTP，不需要真实凭据或网络。

旧 `src/client/`、旧工具和 `src/setup.ts` 仅保留作参考，不进入新入口或构建产物。旧真实 API 集成测试不属于离线测试套件。

## 配置 Personal API Key

默认 Key 文件：

```text
~/.config/garmin/api_key
```

文件只包含 Key 本身，不要添加引号、变量名或其他内容。可通过 `GARMIN_API_KEY_FILE` 修改路径。请限制文件权限，例如：

```bash
chmod 600 ~/.config/garmin/api_key
```

服务通过官方 Obtain Token 接口换取 access token。token 有效期最长 24 小时，不支持 refresh token；客户端从 JWT `exp` 判断过期时间并自动重新获取。

默认本地文件：

| 内容 | 默认路径 | 覆盖变量 |
|---|---|---|
| API Key | `~/.config/garmin/api_key` | `GARMIN_API_KEY_FILE` |
| access token | `~/.config/garmin/access_token.json` | `GARMIN_TOKEN_CACHE_FILE` |
| 数据缓存 | `~/.config/garmin/cache/` | `GARMIN_CACHE_DIR` |
| 邮件去重状态 | `~/.config/garmin/notify-state.json` | `GARMIN_NOTIFY_STATE_FILE` |

云端部署时，这些路径应位于持久且仅当前用户可读写的卷中。不要把 Key、token、缓存或 SMTP 配置提交到 Git。

## 启动与 OpenClaw stdio 注册

本地构建后启动：

```bash
npm start
```

服务通过 stdio 通信，日志写入 stderr。以下示例假设项目位于 `/srv/garmin-connect-mcp`，运行用户为 `/home/openclaw`：

```bash
openclaw mcp add garmin \
  --command node \
  --arg /srv/garmin-connect-mcp/build/index.js \
  --cwd /srv/garmin-connect-mcp \
  --env GARMIN_API_KEY_FILE=/home/openclaw/.config/garmin/api_key \
  --env GARMIN_TOKEN_CACHE_FILE=/home/openclaw/.config/garmin/access_token.json \
  --env GARMIN_CACHE_DIR=/home/openclaw/.config/garmin/cache

openclaw mcp doctor garmin --probe
```

`doctor --probe` 会实际启动 MCP 并列出能力。首次使用真实 Key 前，请确认运行 OpenClaw Gateway 的账户对 Key、token 和缓存目录具有正确权限。

## 四个只读工具

| 工具 | 参数 | 返回内容 |
|---|---|---|
| `get_recovery_context` | `date`、`baseline_days=28` | 睡眠、评分、HRV、静息心率、Body Battery、压力、呼吸、历史序列、基线和同步异常 |
| `get_training_day_context` | `date`、`history_days=42` | 当日全部活动、健康汇总、训练效果、HR 区间及周频率/负荷趋势 |
| `get_training_history` | `start_date`、`end_date` | 56–84 天历史，按周汇总次数、时长、强度分布、负荷和主要项目 |
| `get_activity_details` | `activity_id` | 配速、心率、爬升、分段、训练效果和 HR 区间，不含位置轨迹 |

返回统一为：

```json
{
  "meta": {
    "date": "2026-10-30",
    "timezone": "Asia/Shanghai",
    "units": {},
    "cache": {}
  },
  "data": {},
  "issues": []
}
```

- 每个数据项独立处理错误；失败或缺失为 `null`，不会用零值编造。
- 只有整周读取成功且没有活动时，空训练周才使用真实的零计数；读取失败的空周及其聚合返回 `null`，并标记 `complete=false` 和 `missingDays`。
- HRV 数值单位统一标为毫秒（`ms`）。
- Personal API 不提供活动心率/配速时间序列时，对应字段为 `null` 并带有 `unsupported_field` 问题。
- 活动详情的 HR 区间来自同一活动 ID 的官方活动列表摘要。

### 缓存策略

- 当日数据：10 分钟 TTL。
- 最近两天：6 小时 TTL，允许迟到同步。
- 较旧历史：长期复用。
- 活动按日分片并分页去重，只拉取缺失或过期分片。
- 业务缓存按 API Key 的 SHA-256 指纹隔离；更换账户后不会复用旧账户数据，原始 Key 不进入缓存文件名。
- 写入缓存前先删除位置等不允许返回的字段。

## 教练 Skill 与报告模板

安装项目中的教练 Skill：

```bash
openclaw skills install ./coach --as garmin-training-coach
```

或把 `coach/` 复制为 OpenClaw 工作区中的 `skills/garmin-training-coach/`。

文件：

- `coach/SKILL.md`：上午恢复、睡前复盘、备赛调整、单活动分析及长期计划确认门槛。
- `coach/profile.example.yaml`：虚构运动员配置示例。
- `coach/plan.example.yaml`：虚构备赛计划示例。
- `coach/templates/morning.md`：上午恢复报告模板。
- `coach/templates/evening.md`：睡前训练复盘模板。

## 每日任务示例

以下命令只是配置示例，本项目不会自动创建任务。请按实际时区调整 `--tz`。

上午 10:00：

```bash
openclaw automations create "0 10 * * *" \
  '使用 $garmin-training-coach 生成今天上午恢复报告。调用 get_recovery_context，明确缺失数据和同步异常，不修改长期计划。保存到 coach/reports/，文件名使用 morning-加报告日期。' \
  --name "Garmin morning recovery" \
  --tz "Asia/Shanghai" \
  --session isolated
```

睡前 23:00：

```bash
openclaw automations create "0 23 * * *" \
  '使用 $garmin-training-coach 生成今天睡前训练复盘。调用 get_training_day_context，必要时调用 get_activity_details。保存到 coach/reports/，文件名使用 evening-加报告日期；长期计划调整必须先展示差异并取得用户确认。' \
  --name "Garmin evening review" \
  --tz "Asia/Shanghai" \
  --session isolated
```

检查任务：

```bash
openclaw automations list
openclaw automations runs <job-id>
```

## 邮件辅助

默认配置文件为 `~/.config/garmin/email.env`，示例：

```dotenv
SMTP_HOST=smtp.example.invalid
SMTP_PORT=587
SMTP_USERNAME=your-smtp-username
SMTP_PASSWORD=replace-with-your-smtp-password
SMTP_FROM=coach@example.invalid
SMTP_TO=athlete@example.invalid
SMTP_SECURITY=starttls
SMTP_TIMEOUT=30
```

`SMTP_SECURITY` 支持 `ssl`、`starttls` 和 `none`。不要提交真实配置。

测试 SMTP：

```bash
python scripts/notify_email.py --test
```

发送已有报告：

```bash
python scripts/notify_email.py \
  --report coach/reports/morning-2026-10-30.md \
  --report-id morning-2026-10-30
```

脚本不会修改报告。相同 ID 和内容会跳过；相同 ID 但内容不同会拒绝。跨进程文件锁覆盖检查、发送和状态写入，防止并发任务重复通知。`--config` 可指定其他 env 文件。邮件发送成功但状态写入失败时，重试仍可能重复发送，因此状态目录必须持久且可写。

## 常见问题

| 问题 | 检查与处理 |
|---|---|
| `missing_api_key` 或 `empty_api_key` | 检查 Key 路径、文件内容和运行用户权限；`GARMIN_API_KEY_FILE` 必须指向 Gateway 实际可读的文件 |
| 401 / 403 | Key 可能已过期或被撤销，请在 Garmin Connect 重新创建；客户端会重新获取 token，不会使用 refresh token |
| 更换 Key 后仍使用旧 token | 正常缓存按 Key 指纹隔离并自动更新；同时检查 `GARMIN_TOKEN_CACHE_FILE` 是否可写 |
| 超时、网络错误、429、5xx | 检查云端到 `personal.connectapi.garmin.com` 的网络；客户端有限重试并支持 `Retry-After`，不要高频重复调用 |
| 字段为 `null` | 查看 `issues`：可能是设备/账户不支持、尚未同步、204、404 或字段未由 Personal API 提供，不要当成零 |
| 历史突然重新拉取 | 检查缓存目录是否持久、是否超过当日/最近两天 TTL，以及缓存 schema 是否更新 |
| `doctor --probe` 没有工具 | 检查 `command`、`cwd`、Node 路径、工具过滤器和 Gateway stderr；确认注册的是 `build/index.js` |
| SMTP 测试失败 | 检查端口、SSL/STARTTLS、用户名、密码、发件人和服务商限制；错误输出不会显示密码 |
| 报告未重复发送 | 相同 `report-id` 和内容会被去重；检查 `GARMIN_NOTIFY_STATE_FILE` |

## 验证边界

离线测试验证了官方 Swagger 形状的模拟响应、错误处理、缓存、隐私清理和 MCP 协议调用。另已完成一次脱敏只读 live 验证：Obtain Token、四个服务方法、56 天历史、第二次调用的缓存命中、活动分段和 HR 区间合并均成功，输出未包含位置字段。实际账户的睡眠 epoch 数字时间戳也已做兼容处理。

不同设备的字段可空性、长期限流行为、真实 SMTP 交付和 OpenClaw 部署环境仍需分别验证。旧内部 Garmin API 不作为本项目的接口依据。

## License

MIT
