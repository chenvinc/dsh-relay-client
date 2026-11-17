# 架构

## 定位：手机与运营商

```
DSH 会话（装本插件）          pcpanel（本机，控制面）         对端 pcpanel
     │                              │                            │
     │  relay_send / bind           │   /api/relay/*             │  UDP 8766 发现
     ├─────────────────────────────►│                            │  8765 联邦转发
     │  轮询 inbox                  ├───────────────────────────►│
     │◄─────────────────────────────│◄───────────────────────────│
     │  Agent.followup 注入          │   通讯录 / 消息库 / 审计     │
```

- **插件 = 手机**：只连本机 panel（默认 `127.0.0.1:8765`），不直接跨机。
- **panel = 运营商**：查通讯录，决定本地投递还是转发对端，跨机靠联邦层（UDP 8766 自动发现 + relay-peers 地址簿）。
- **DSH 会话 = 终点**：消息最终由 `Agent.followup()` 注入目标会话，数据面复用 DSH 原生能力。

## 为什么这么切

1. **控制面/数据面分离**：panel 不新建通讯内核，只做注册表、显式寻址、审计；注入走 DSH 原生 API，避免重复造轮子。
2. **身份显式绑定**：后台定时器里没有 initiator，拿不到"当前会话"，所以逻辑名必须由会话自己通过 `relay_bind` 声明（此时 `exec.agent.id` 就是 sessionId），或 HTTP bind 显式传 `session_id`。
3. **不侵入 DSH**：不改核心、不补丁其他插件，只通过 bundle patch 加载自己。

## 三级地址

`machine_id / workspace / alias`

| 级别 | 含义 | 例子 |
|---|---|---|
| machine_id | 机器稳定名（须与本机 panel 一致） | `pc-office`、`macbook` |
| workspace | 会话所在工作区（可空） | `mowen-frontend-windows` |
| alias | 会话逻辑名（全网唯一时短名即可命中） | `po`、`backend` |

`to` 可写短名（唯一命中）、`workspace/alias`、完整 `machine/workspace/alias`。`cc` 同理，支持混合。

## 消息类型

`dispatch` / `progress` / `contract` / `result` / `ack` / `note`。
只有 `to` / `cc` 命中的会话会被唤醒；消息游标（seq）保证不重复收旧消息。

## 状态与恢复

绑定关系落盘在 `~/.dsh/state/relay-client/state.json`（`RELAY_CLIENT_STATE_DIR` 可覆盖），写临时文件后原子改名，重启自动恢复。游标随消息 ack 前移。
