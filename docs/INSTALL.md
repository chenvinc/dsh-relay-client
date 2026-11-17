# 安装

## 1. 安装插件包

```bash
npm install -g dsh-relay-client
```

或作为 bundle 装进某个 DSH profile（推荐，便于按 profile 隔离配置）。

## 2. 加到 DSH profile

把仓库里的 [cordis.patch.yml](../cordis.patch.yml) 那条 `insert` 追加到你 profile 的 `cordis.patch.yml`（或由 bundle 加载器读取）。这只是加载插件，不改 DSH 核心或其他插件代码。

## 3. 配置

关键字段（在插件 config 或 bundle patch 里填）：

```yaml
base: http://127.0.0.1:8765        # 本机 panel 地址
machine_id: pc-office               # 必须与本机 panel config.relay.machine_id 一致
workspace: mowen-frontend-windows   # 可空
poll_ms: 2000
heartbeat_ms: 60000
```

**`machine_id` 是最容易错的一项**：它是三级地址第一级，留空会回退到 hostname，此时若与 panel 配置不一致，跨机定位会失败。三台机器应分别设不同值（如 `pc-office` / `pc-backend` / `macbook`）。

## 4. 准备 panel

本机需运行 pcpanel（提供 `/api/relay/*`），默认端口 8765。看板里应能看到「会话中继」分区。

跨机器通信还需：
- 对端也跑一份 panel（Mac 端用 macpanel）
- 两端在同一局域网，UDP 8766 发现可达
- 看板的通讯录里互记对方（自动发现后确认配对，或手动 link）

## 5. 验证

在任意 DSH 会话里调用：

```text
relay_bind 绑定一个逻辑名（如 po）
relay_send 给已知别名发一条 note
```

或 `curl http://127.0.0.1:<插件端口>/relay-client/status` 看绑定状态。
完整验证步骤见 [VERIFICATION.md](./VERIFICATION.md)。

## 卸载

从 profile 的 cordis.patch.yml 移除那条 insert 即可；状态文件保留在 `~/.dsh/state/relay-client/`，如需彻底清理手动删除。
