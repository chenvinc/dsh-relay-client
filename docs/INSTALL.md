# 安装

`dsh-relay-client` 是 DeepSeek Harness 的 **bundle 插件**，要装进某个 DSH profile 才会被加载。
它是插件而不是命令行工具——`npm install -g dsh-relay-client` 装到全局后 DSH 不会读取。

## 1. 装进 profile

```bash
cd ~/.dsh/profiles/web        # 换成你的 profile 目录（默认叫 web）
pnpm add dsh-relay-client     # 用 npm 的话：npm install dsh-relay-client
```

## 2. 登记为 bundle

编辑 profile 的 `package.json`，把包名追加到 `dsh.profile.bundles` 数组末尾：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        // …已有的 bundle…
        "dsh-relay-client"
      ]
    }
  }
}
```

包内自带 `dsh.bundle.patch`（即 `cordis.patch.yml`），DSH 的 bundle 加载器会按它把插件条目
插进配置树，**不需要改 DSH 核心，也不自动改其他插件**。

## 3. 配置

在 profile 的 `cordis.patch.yml` 里写一条（推荐用覆盖式，这样升级包不会冲掉你的本机配置；
如果文件里已有 `id: relay-client` 的条目，直接改它的 `config`，不要重复插一条）：

```yaml
- insert:
    - id: relay-client
      name: dsh-relay-client
      config:
        base: http://127.0.0.1:8765        # 本机 panel 地址
        machine_id: macbook                 # 必须与本机 panel 的 config.relay.machine_id 一致
        workspace: ""                       # 三级地址第二级，可留空
        poll_ms: 2000
        heartbeat_ms: 60000
```

**`machine_id` 是最容易错的一项**：它是三级地址第一级，留空会回退到 hostname，此时若与
panel 配置不一致，跨机定位会失败。多台机器应分别设成不同值（如 `pc-office` / `pc-backend` / `macbook`）。

## 4. 重启 DSH 并确认加载

重启 `dsh web`（或在面板的 DSH 卡片里点「重启」），然后确认条目已进配置树：

```bash
dsh --profile web --dump-config | grep -A6 relay-client
```

新开一个会话，应能调用 `relay_bind` / `relay_send` / `relay_unbind` / `relay_forget` 四个工具。

## 5. 准备 panel

本机需运行 pcpanel（提供 `/api/relay/*` 控制面），默认端口 8765。看板里应能看到「会话中继」分区。

跨机器通信还需：
- 对端也跑一份 panel（Mac 端用 macpanel）
- 两端在同一局域网，UDP 8766 发现可达
- 看板的通讯录里互记对方（自动发现后确认配对，或手动 link）

插件只连**本机** panel（像手机只连本地运营商），跨机转发由 panel 联邦层完成。

## 6. 验证

在任意 DSH 会话里调用：

```text
relay_bind 绑定一个逻辑名（如 po）
relay_send 给已知别名发一条 note
```

插件也会在 DSH Web 服务上暴露 `GET /relay-client/status`，但受 DSH 登录态保护，
命令行验证优先用上面的工具调用。完整验证步骤见 [VERIFICATION.md](./VERIFICATION.md)。

## 卸载

1. 从 profile 的 `dsh.profile.bundles` 移除 `dsh-relay-client`；
2. `pnpm remove dsh-relay-client`；
3. 删掉 profile `cordis.patch.yml` 里的 `relay-client` 条目。

状态文件保留在 `~/.dsh/state/relay-client/`，如需彻底清理手动删除即可。
