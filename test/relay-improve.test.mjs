/**
 * 验证 relay-improve 四项插件侧改动：版本核对 / 转发状态透传 / register 上报 / 旧 state 补 addr。
 * 运行：node test/relay-improve.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const td = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-improve-'))
process.env.RELAY_CLIENT_STATE_DIR = td
// 预置旧版 state.json：binding 缺 addr，验证 loadState 自动补算三级地址
fs.mkdirSync(td, { recursive: true })
fs.writeFileSync(path.join(td, 'state.json'), JSON.stringify({
  bindings: { legacy: { name: 'legacy', session_id: 's-legacy', machine: 'old-pc', workspace: 'old-ws', since: 3 } },
}), 'utf8')

const calls = []
const agent = { id: 'session-imp', status: 'idle', followup() {} }
const agentsSvc = { get(id) { return id === agent.id ? agent : undefined } }
let sendMode = 'ok'   // ok | partial
function reply(obj) { return { ok: true, status: 200, text: async () => JSON.stringify(obj) } }

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url)
  calls.push({ path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null })
  if (u.pathname === '/api/relay/register') return reply({ ok: true, server_version: '0.1.1' })
  if (u.pathname === '/api/relay/unregister') return reply({ ok: true })
  if (u.pathname === '/api/relay/send') {
    if (sendMode === 'partial') return reply({ ok: true, message: { seq: 9 }, delivered: ['macbook'],
      failed: [{ machine: 'pc-backend', error: '离线' }], forward_pending: true, pending_count: 1 })
    return reply({ ok: true, message: { seq: 8 } })
  }
  if (u.pathname === '/api/relay/inbox') return reply({ ok: true, messages: [], next_since: 0 })
  if (u.pathname === '/api/relay/ack') return reply({ ok: true })
  return reply({ error: 'unknown' }, 404)
}

const tools = new Map()
const routes = new Map()
const ctx = {
  tools: { register(def) { tools.set(def.name, def); return () => {} } },
  webServer: { register(r) { routes.set(r.path, r.handler); return () => {} } },
  get(n) { return n === 'agents' ? agentsSvc : undefined },
  effect(fn) { return typeof fn === 'function' ? fn() : undefined },
}
const { apply, PLUGIN_VERSION } = await import('../index.js')
const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))

let passed = 0, failed = 0
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log('  PASS  ' + label) }
  else { failed++; console.log('  FAIL  ' + label + '  ' + detail) }
}

console.log('=== relay-improve 插件侧测试 ===')
check('导出 PLUGIN_VERSION', typeof PLUGIN_VERSION === 'string' && PLUGIN_VERSION === '0.1.1', String(PLUGIN_VERSION))
check('版本与 package.json 一致', PLUGIN_VERSION === pkg.version, `${PLUGIN_VERSION} vs ${pkg.version}`)

apply(ctx, { base: 'http://mock:8765', poll_ms: 5000, heartbeat_ms: 60000, timeout_ms: 1000 })

const bind = await tools.get('relay_bind').execute({ logical_name: 'imp', workspace: 'ws' }, { agent })
check('relay_bind 返回 plugin_version', bind.plugin_version === PLUGIN_VERSION, JSON.stringify(bind))
check('relay_bind 返回 server_version', bind.server_version === '0.1.1', JSON.stringify(bind))
check('register 上报 plugin_version',
  calls.some(c => c.path === '/api/relay/register' && c.body.plugin_version === PLUGIN_VERSION),
  JSON.stringify(calls.filter(c => c.path === '/api/relay/register')))

sendMode = 'partial'
const sent = await tools.get('relay_send').execute({ to: 'fe', content: 'x' }, { agent })
check('透传 delivered', Array.isArray(sent.delivered) && sent.delivered[0] === 'macbook', JSON.stringify(sent))
check('透传 failed', Array.isArray(sent.failed) && sent.failed[0].machine === 'pc-backend', JSON.stringify(sent))
check('透传 forward_pending', sent.forward_pending === true, JSON.stringify(sent))
check('透传 pending_count', sent.pending_count === 1, JSON.stringify(sent))
check('透传后仍是 lossless（无 undefined）', JSON.parse(JSON.stringify(sent)).seq === 9, JSON.stringify(sent))

sendMode = 'ok'
const sent2 = await tools.get('relay_send').execute({ to: 'fe', content: 'y' }, { agent })
check('旧版 send 响应不强行塞字段', !('forward_pending' in sent2) && !('failed' in sent2), JSON.stringify(sent2))

let statusBody = null
routes.get('/relay-client/status')({}, { writeHead() {}, end(b) { statusBody = JSON.parse(b) } })
check('status 暴露 plugin_version', statusBody.plugin_version === PLUGIN_VERSION, JSON.stringify(statusBody))
const legacy = statusBody.bindings.find((b) => b.name === 'legacy')
check('旧 binding 自动补算 addr', legacy && legacy.addr === 'old-pc/old-ws/legacy', JSON.stringify(legacy))

console.log(`\n=== 结果：${passed} passed, ${failed} failed ===`)
if (failed) process.exitCode = 1
