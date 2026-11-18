# 更新日志

## 0.1.2 — 安装文档修正

- 文档：安装说明改为正确的「装进 DSH profile」方式——`pnpm add dsh-relay-client` +
  在 `dsh.profile.bundles` 登记 + 在 `cordis.patch.yml` 配置 `base` / `machine_id` /
  `workspace`；删除会被误读为可用的 `npm install -g` 全局安装写法。
- 代码与 0.1.1 一致，仅重新打包以同步 npm 页面上的 README。

## 0.1.1 — 转发可见性与版本核对

配合 panel 端中继改良：

- `relay_send` 透传 `delivered` / `failed` / `forward_pending` / `pending_count`，
  本地副本成功不再掩盖跨机投递失败；服务端把失败项入待重投队列，按机器指数退避重投。
- `relay_bind` 与 `GET /relay-client/status` 返回 `plugin_version`，register 握手把版本
  上报给 panel（心跳续约同样上报），三端可核对是否跑同一版代码。
- `loadState` 对旧版 `state.json` 中缺 `addr` 的 binding 自动补算三级地址，无需重新绑定。

## 0.1.0 — 首个公开版本

从内部实现（`pc-panel` 仓库 `dsh-relay-client/` 目录）摘出，独立成仓并发布。

- `relay_bind` / `relay_unbind` / `relay_forget` / `relay_send` 四个会话工具
- 后台轮询本机 panel 收件箱，按注册别名精确投递并注入会话（`Agent.followup` → `steer` → `inbox` 三级回退）
- 三级地址 `machine_id / workspace / alias`，跨机转发由 panel 联邦层完成
- HTTP 状态/绑定端点：`GET /relay-client/status`、`POST /relay-client/bind|unbind`
- 绑定状态落盘（`~/.dsh/state/relay-client/state.json`），重启自动恢复
- bundle patch 安装方式，不改 DSH 核心或其他插件
- 64 项 mock 测试 + 真实链路集成测试脚本
