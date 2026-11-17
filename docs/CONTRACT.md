# 契约

本插件与 panel 之间靠 HTTP API 解耦。此文件记录插件依赖的端点与字段，供两端独立演进时对齐。

## 插件依赖的 panel 端点

均经 `config.base`（默认 `http://127.0.0.1:8765`）访问：

| 端点 | 用途 |
|---|---|
| `POST /api/relay/register` | 注册逻辑名 → sessionId → 机器/workspace；心跳续约 |
| `POST /api/relay/unregister` | 会话下线时注销 |
| `POST /api/relay/send` | 发消息（`to`/`cc`/`type`/`thread`/`content`），返回 `seq` |
| `GET /api/relay/inbox?name=&seq=` | 拉取收件箱（游标续传） |
| `POST /api/relay/ack` | 确认已消费，游标前移 |
| `POST /api/relay/forget` | 从通讯录移除节点 |

失败策略：网络错误/非 2xx 返回 `{ok:false,error}` 给工具调用方，不静默吞掉。

## 地址与身份字段

- `machine_id` 必须与 panel 的 `config.relay.machine_id` 完全一致
- 三级地址的解析在 panel 联邦层完成，插件只做透传与格式校验
- 逻辑名正则：`^[a-z0-9][a-z0-9_-]{0,63}$`

## 版本兼容

- 插件 `package.json` 的 `dsh.engines.dsh` 声明 DSH 版本范围
- panel 侧 API 变更应在此文件与 CHANGELOG 同步记录
- 当前 panel 端点是内部协议（局域网使用，无 token 鉴权），非稳定公开 REST

## 插件暴露给外部

| 端点 | 用途 |
|---|---|
| `GET /relay-client/status` | 绑定状态、base、machine_id |
| `POST /relay-client/bind` | 显式绑定（传 `session_id`） |
| `POST /relay-client/unbind` | 显式解绑 |

## 状态文件

`~/.dsh/state/relay-client/state.json`，结构 `{ bindings: { alias: {...} } }`。
