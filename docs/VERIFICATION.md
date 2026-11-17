# 验证

## 单元测试（无需真实环境）

```bash
npm test
```

覆盖 64 项 mock 断言：

- `test/relay-client.test.mjs`（52 项）：apply/dispose 生命周期、工具注册、`relay_bind/send/unbind/forget` 全路径、收件箱轮询与注入、三级回退、游标 ack、失败与网络错误分支、卸载清理
- `test/address.test.mjs`（12 项）：machine_id/workspace 绑定、`to`/`cc` 三级地址透传、from 用本会话别名、status 暴露三级地址

测试不依赖真实 DSH 或 panel，用临时目录隔离状态（`RELAY_CLIENT_STATE_DIR`）。

## 真实链路集成测试

需先启动一个开了 relay 的 pcpanel（测试默认打 `http://127.0.0.1:18769`，可用 `RELAY_PANEL_BASE` 覆盖）：

```bash
npm run test:integration
```

验证插件与真实 panel 的注册/发消息/收件/注入/ack 全链路。

## 手工冒烟

1. 会话 A 调 `relay_bind` 绑定 `po`，会话 B 绑定 `fe`
2. 会话 A 调 `relay_send`：`to=fe, type=note, content=ping`
3. 会话 B 应自动收到注入消息，`thread`/`from` 字段正确
4. `GET /relay-client/status` 检查绑定与游标
5. 重启 DSH，绑定应自动恢复；游标不回退、不重复收旧消息

## 跨机验证

- 两端 panel 通讯录互记（看板「会话中继」分区可查）
- 用完整三级地址 `macbook/workspace/alias` 发消息
- 对端会话收到后，`relay_send` 回复短别名即可命中
