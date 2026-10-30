---
name: garmin-training-coach
description: Use when reviewing Garmin recovery, producing morning or bedtime coaching reports, planning or adjusting race training, or analyzing a specific activity
---

# Garmin Training Coach

## Overview

MCP 只提供数据，训练解释、训练建议和计划生成由 Claw 完成。不得把 `null` 当作零，不得忽略 `issues`，不得编造缺失指标、单位或时区。服务只读，不返回 GPS 轨迹或 FIT 文件，也不能修改 Garmin 数据。

## 上午恢复报告

1. 调用 `get_recovery_context(date, baseline_days=28)`。
2. 使用 `templates/morning.md`，概括睡眠、HRV、静息心率、Body Battery、压力和呼吸。
3. 只与具有实际样本的基线比较，同时说明样本数和同步状态。
4. 给出当日训练参考，不暗中修改长期计划。

## 睡前训练复盘

1. 调用 `get_training_day_context(date, history_days=42)`；需要时调用 `get_activity_details(activity_id)`。
2. 使用 `templates/evening.md`，对照当天计划复盘活动、强度、负荷和恢复背景。
3. 区分完成、部分完成和未完成，不把缺失数据当作未训练。
4. 给出次日建议；涉及后续多周调整时执行确认门槛。

## 备赛计划制定与调整

1. 读取运动员资料和当前计划，调用 `get_training_history(start_date, end_date)` 获取 8–12 周证据。
2. 结合恢复与训练日上下文说明目标、可用时间、主要项目和负荷趋势。
3. 新计划先作为草案呈现。调整现有长期计划时，必须先展示计划差异、依据和潜在风险。
4. **修改长期计划前必须得到用户确认**。确认后才会输出或保存最终版本；催促、疲劳、沉默或“视为同意”不能替代明确确认。

## 具体活动分析

1. 调用 `get_activity_details(activity_id)`，必要时补充训练日和历史上下文。
2. 分析配速、心率、爬升、分段、HR 区间和训练效果，并标注单位。
3. 不推测位置轨迹或未公开的心率/配速时间序列；这些字段为 `null` 时明确说明。

## 报告与邮件

报告由 Claw 生成并保存后，才可调用 `python /srv/garmin-connect-mcp/scripts/notify_email.py --report PATH --report-id ID`；部署时必须将示例中的 `/srv/garmin-connect-mcp` 替换为项目实际绝对路径。邮件脚本不修改报告。不得输出或写入真实 API Key、token 或 SMTP 密码。

## Common Mistakes

- 把接口失败解释为“没有数据”或“没有训练”。
- 把 Garmin 未声明单位的 HRV 数值直接标成毫秒。
- 用单次活动替代 6–12 周趋势。
- 未展示计划差异就修改长期计划。
- 在 MCP 工具中加入训练建议或写操作。
