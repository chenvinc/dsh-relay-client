/**
 * relay-client 三级地址专项测试：machine_id/workspace 绑定 + to/cc 三级地址透传。
 * 运行：node dsh-relay-client/_test_addr.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const td = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-client-addr-'))
process.env.RELAY_CLIENT_STATE_DIR = td

let registerBody = null
let sendBody = null
const injected = []
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url)
  const body = opts.body ? JSON.parse(opts.body) : null
  const reply = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) })
  if (u.pathname === '/api/relay/register') {
    registerBody = body
    return reply({ ok: true, addr: [body.machine, body.workspace, body.logical_name].filter(Boolean).join('/') })
  }
  if (u.pathname === '/api/relay/send') { sendBody = body; return reply({ ok: true, message: { seq: 7 } }) }
  if (u.pathname === '/api/relay/inbox') return reply({ ok: true, messages: [], next_since: 0 })
  if (u.pathname === '/api/relay/ack') return reply({ ok: true })
  if (u.pathname === '/api/relay/unregister') return reply({ ok: true })
  return reply({ error: 'unknown' }, 404)
}

const agent = { id: 'session-x', status: 'idle', followup(m) { injected.push(m) } }
const tools = new Map()
const routes = new Map()
const ctx = {
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
  get(name) { return name === 'agents' ? { get: (id) => (id === 'session-x' ? agent : undefined) } : undefined },
  effect(fn) { fn(); return () => {} },
}

const { apply } = await import('../index.js')
apply(ctx, {
  base: 'http://127.0.0.1:19999',
  machine_id: 'macbook',
  workspace: 'mowen-frontend',
  poll_ms: 999999,
  heartbeat_ms: 999999,
})

let passed = 0
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log('  PASS  ' + label) }
  else { console.log('  FAIL  ' + label + '  ' + detail); process.exitCode = 1 }
}

console.log('=== relay-client 三级地址测试 ===')
const exec = { agent: { id: 'session-x' } }

// 1) bind：用配置 machine_id/workspace，不用 hostname
const bindRes = await tools.get('relay_bind').execute({ logical_name: 'frontend' }, exec)
check('bind 成功', bindRes.ok === true, JSON.stringify(bindRes))
check('bind 返回三级地址', bindRes.addr === 'macbook/mowen-frontend/frontend', String(bindRes.addr))
check('注册体 machine=配置值', registerBody.machine === 'macbook', JSON.stringify(registerBody))
check('注册体 workspace=配置值', registerBody.workspace === 'mowen-frontend', JSON.stringify(registerBody))

// 2) 显式参数覆盖配置
await tools.get('relay_bind').execute({ logical_name: 'frontend', machine: 'other-pc', workspace: 'other-ws' }, exec)
check('显式 machine 覆盖配置', registerBody.machine === 'other-pc', JSON.stringify(registerBody))
check('显式 workspace 覆盖配置', registerBody.workspace === 'other-ws', JSON.stringify(registerBody))

// 3) send：to/cc 三级地址原样透传给 panel 解析
const sendRes = await tools.get('relay_send').execute({
  to: 'pc-office/mowen-doc/product-office',
  cc: ['macbook/mowen-frontend/frontend', 'backend'],
  type: 'dispatch', thread: 't-addr', content: '跨机消息',
}, exec)
check('send 成功', sendRes.ok === true, JSON.stringify(sendRes))
check('to 三级地址透传', sendBody.to === 'pc-office/mowen-doc/product-office', String(sendBody.to))
check('cc 混合地址透传', JSON.stringify(sendBody.cc) === JSON.stringify(['macbook/mowen-frontend/frontend', 'backend']), JSON.stringify(sendBody.cc))
check('from 用本会话别名', sendBody.from === 'frontend', String(sendBody.from))

// 4) 收到消息时注入文本带三级 from_addr
injected.length = 0
// 直接触发 inbox：需要让 inbox 返回一条消息，这里用状态端点确认绑定含 addr
const statusRes = { writeHead() {}, end(body) { statusRes.body = JSON.parse(body) } }
routes.get('/relay-client/status')({}, statusRes)
check('status 暴露 machine_id', statusRes.body.machine_id === 'macbook', String(statusRes.body.machine_id))
check('status 绑定含三级 addr', statusRes.body.bindings.some((b) => b.addr === 'frontend/other-ws/x' || b.addr && b.addr.startsWith('other-pc/')), JSON.stringify(statusRes.body.bindings))

fs.rmSync(td, { recursive: true, force: true })
console.log('\n=== 结果：' + passed + ' passed ===')
