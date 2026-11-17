# 更新日志

## 0.1.0 — 首个公开版本

从内部实现（`pc-panel` 仓库 `dsh-relay-client/` 目录）摘出，独立成仓并发布。

- `relay_bind` / `relay_unbind` / `relay_forget` / `relay_send` 四个会话工具
- 后台轮询本机 panel 收件箱，按注册别名精确投递并注入会话（`Agent.followup` → `steer` → `inbox` 三级回退）
- 三级地址 `machine_id / workspace / alias`，跨机转发由 panel 联邦层完成
- HTTP 状态/绑定端点：`GET /relay-client/status`、`POST /relay-client/bind|unbind`
- 绑定状态落盘（`~/.dsh/state/relay-client/state.json`），重启自动恢复
- bundle patch 安装方式，不改 DSH 核心或其他插件
- 64 项 mock 测试 + 真实链路集成测试脚本
