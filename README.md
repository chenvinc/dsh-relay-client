# dsh-relay-client

> 让 DeepSeek Harness 的会话之间能互相喊话 —— 同一台机器，或局域网里的另一台。

[English](./README.en.md) · [架构](./docs/ARCHITECTURE.md) · [契约](./docs/CONTRACT.md) · [安装](./docs/INSTALL.md) · [验证](./docs/VERIFICATION.md)

[![npm](https://img.shields.io/npm/v/dsh-relay-client?color=CB3837)](https://www.npmjs.com/package/dsh-relay-client)
[![License](https://img.shields.io/github/license/chenvinc/dsh-relay-client?color=4B6EF5)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-64%20passing-brightgreen)](./test)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](./package.json)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.2--rc.1-4B6EF5)](./package.json)
[![Topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)

## 它能做什么

多个 DSH 会话并行工作时，跨会话/跨机器传消息通常要绕 GitHub issue、共享文件或人工复制粘贴。这个插件把这件事变成一次工具调用：

- 每个会话用 `relay_bind` 声明一个逻辑名（如 `po`、`fe`、`macbook/dsh-proj/backend`）
- 用 `relay_send` 给另一个会话发消息，支持单播 `to` 与抄送 `cc`
- 后台轮询本机 panel 的收件箱，把发给自己的消息**自动注入对应会话**（`Agent.followup` → `steer` → `inbox` 三级回退）
- 三级地址 `机器名 / 工作区 / 别名` 寻址，跨机器由 panel 联邦层转发，插件本身只连本机

插件**不改 DSH 核心、不打补丁到其他插件**；只通过 bundle patch 把自己装进 profile。

## 前置条件

需要一个**本机运行的 pcpanel**（提供 `/api/relay/*` 控制面）：默认 `http://127.0.0.1:8765`。
跨机器通信还需对端也跑一个 panel，并通过 UDP 8766 自动发现、在通讯录里互记对方（见 [安装](./docs/INSTALL.md)）。

没有 panel 时插件仍可加载，但 `relay_send` 会失败——它本质是把 panel 当作"运营商"，自己只做"手机"。

## 安装

```bash
cd ~/.dsh/profiles/web        # 你的 DSH profile 目录
pnpm add dsh-relay-client     # 或 npm install dsh-relay-client
```

再把 `dsh-relay-client` 追加到该 profile `package.json` 的 `dsh.profile.bundles`，
并在 `cordis.patch.yml` 里填 `base` / `machine_id` / `workspace`。完整步骤见
[安装文档](./docs/INSTALL.md)。注意：这是 DSH 的 bundle 插件，`npm install -g` 装到全局不会被加载。
`machine_id` **必须与本机 panel 的 `config.relay.machine_id` 完全一致**，否则跨机三级寻址会失败。

## 工具

| 工具 | 作用 |
|---|---|
| `relay_bind` | 把当前会话绑定到逻辑名（会话内调用时自动取当前 sessionId） |
| `relay_unbind` | 注销本会话的某个别名（笔误修正 / 任务归档） |
| `relay_forget` | 从通讯录移除一个已知节点（对端下线时清理） |
| `relay_send` | 发消息，支持 `to` / `cc` 三级地址、`type`、`thread` |

会话内典型用法：

```text
你：绑个名，然后告诉 backend 会话接口契约定了
agent：（调用 relay_bind 绑定 po）
agent：（调用 relay_send，to=backend，type=contract，content=...）
```

## HTTP 端点

插件暴露两个本机端点，便于面板或 `curl` 直接操作：

- `GET /relay-client/status` —— 当前绑定与连接状态
- `POST /relay-client/bind` / `/unbind` —— 显式绑定/解绑（传 `session_id`）

## 设计取舍

- **控制面/数据面分离**：panel 只做注册表、寻址、审计；会话注入走 DSH 原生的 `Agent.followup`，不新建通讯内核
- **身份显式绑定**：后台定时器拿不到"当前会话"，所以逻辑名必须由会话自己 `relay_bind` 声明，或从 HTTP 端点显式传入
- **状态落盘可恢复**：绑定关系写在 `~/.dsh/state/relay-client/state.json`（可用 `RELAY_CLIENT_STATE_DIR` 覆盖），重启自动恢复
- **局域网内不做 token 鉴权**（与 panel 一致）；如需公网访问请自行加反向代理与鉴权

## 验证

```bash
npm test              # 64 项 mock 测试（无需真实 DSH / panel）
npm run test:integration   # 真实链路，需先启动 pcpanel 的 relay 服务
```

## License

MIT © chenvinc
