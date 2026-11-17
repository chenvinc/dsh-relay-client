/**
 * 真实链路集成验证：插件 ↔ 真实 pcpanel relay HTTP 服务。
 * 由 _run_integration.py 启动 pcpanel 后调用本脚本。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.env.RELAY_PANEL_BASE || 'http://127.0.0.1:18769'
const td = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-integration-'))
process.env.RELAY_CLIENT_STATE_DIR = td

const injected = []
const agent = { id: 'session-po', status: 'idle', followup(msg) { injected.push(msg) } }
const agentsSvc = { get(id) { return id === 'session-po' ? agent : undefined } }
const tools = new Map()
const routes = new Map()
let disposer = null
const ctx = {
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  webServer: { register(r) { routes.set(r.path, r.handler); return () => routes.delete(r.path) } },
  get(n) { return n === 'agents' ? agentsSvc : undefined },
  effect(fn) { disposer = fn(); return disposer },
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(ep, body) {
  const res = await fetch(BASE + ep, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

let passed = 0
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log('  PASS  ' + label) }
  else { console.log('  FAIL  ' + label + '  ' + detail); process.exitCode = 1 }
}

console.log('=== relay-client 真实链路集成验证 ===')
const { apply } = await import('../index.js')
apply(ctx, { base: BASE, poll_ms: 300, heartbeat_ms: 5000, timeout_ms: 3000 })

// 主理会话通过工具绑定逻辑名（真实路径：exec.agent.id 提供 sessionId）
const bound = await tools.get('relay_bind').execute(
  { logical_name: 'po', workspace: '/work/product-office' }, { agent })
check('po 通过工具绑定成功', bound.ok === true, JSON.stringify(bound))

// 前端会话在 pcpanel 注册（真实 HTTP）
const reg = await api('/api/relay/register', {
  logical_name: 'fe', session_id: 'session-fe-real', machine: 'mac', workspace: '/work/frontend',
})
check('fe 在 pcpanel 注册成功', reg.ok === true, JSON.stringify(reg))

// 前端下发消息给主理（走真实 pcpanel 消息总线）
const sent = await api('/api/relay/send', {
  from: 'fe', to: 'po', type: 'dispatch', thread: 'issue-42', content: '请拆分前端任务',
})
check('fe 发消息成功', sent.ok === true && sent.message.seq > 0, JSON.stringify(sent))

// 主理插件轮询拉到并注入
await sleep(900)
check('主理会话被真实注入', injected.length === 1, JSON.stringify(injected))
check('注入内容正确', injected[0]?.content[0].text.includes('请拆分前端任务'), JSON.stringify(injected))

// 主理用工具回信给前端
const reply = await tools.get('relay_send').execute(
  { to: 'fe', type: 'result', thread: 'issue-42', content: '已拆分：登录页 + 契约确认' },
  { agent })
check('主理 relay_send 工具回信成功', reply.ok === true && reply.seq > sent.message.seq, JSON.stringify(reply))

const feInbox = await api('/api/relay/inbox?name=fe&since=0&limit=50')
check('fe 收件箱看到主理回信', feInbox.messages?.some(m => m.from === 'po' && m.content.includes('已拆分')),
  JSON.stringify(feInbox.messages))
check('回信由 po 已读回执', (await api('/api/relay/history?thread=issue-42')).messages
  .some(m => m.from === 'fe' && (m.acks || []).includes('po')))

disposer()
fs.rmSync(td, { recursive: true, force: true })
console.log('\n=== 结果：' + passed + ' passed ===')
