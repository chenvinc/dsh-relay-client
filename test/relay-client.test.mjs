/**
 * relay-client 的 mock 集成测试：不依赖真实 DSH / pcpanel。
 * 运行：node dsh-relay-client/_test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const td = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-client-test-'))
process.env.RELAY_CLIENT_STATE_DIR = td

const calls = []
let inboxMessages = []
let injected = []
let acked = []
let sendFails = false  // 回归测试用：模拟 panel 发送失败（如目标不在通讯录）
let sendNoSeq = false  // 模拟 panel 只回 {ok:true} 不带 message（旧版插件在这里漏 undefined）
let sendNetFail = false  // 模拟 fetch 层失败（panel 未启动）
let forgetFails = false  // 模拟移出通讯录失败（节点不存在）
const agent = {
  id: 'session-po',
  status: 'idle',
  followup(msg) { injected.push(msg) },
}
const agentsSvc = { get(id) { return id === 'session-po' ? agent : undefined } }

function reply(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) }
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url)
  calls.push({
    path: u.pathname,
    method: opts.method || 'GET',
    query: Object.fromEntries(u.searchParams),
    body: opts.body ? JSON.parse(opts.body) : null,
  })
  if (u.pathname === '/api/relay/register') return reply({ ok: true })
  if (u.pathname === '/api/relay/unregister') return reply({ ok: true })
  if (u.pathname === '/api/relay/forget') {
    if (forgetFails) return reply({ ok: false, error: '未知节点：ghost' })
    return reply({ ok: true, machine_id: 'ghost', forgotten: true, was_linked: true })
  }
  if (u.pathname === '/api/relay/send') {
    if (sendNetFail) {
      const err = new TypeError('fetch failed')
      err.cause = { code: 'ECONNREFUSED' }
      throw err
    }
    if (sendFails) return reply({ ok: false, error: 'to 解析失败：通讯录无此会话：backend' })
    if (sendNoSeq) return reply({ ok: true })
    return reply({ ok: true, message: { seq: 42, id: 'msg_out' } })
  }
  if (u.pathname === '/api/relay/ack') {
    acked.push(JSON.parse(opts.body))
    return reply({ ok: true })
  }
  if (u.pathname === '/api/relay/inbox') {
    const since = Number(u.searchParams.get('since') || 0) || 0
    const visible = inboxMessages.filter(m => m.seq > since)
    return reply({ ok: true, messages: visible, next_since: visible.at(-1)?.seq || since })
  }
  return reply({ error: 'unknown endpoint ' + u.pathname }, 404)
}

const tools = new Map()
const routes = new Map()
let disposer = null
const ctx = {
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
  get(name) { return name === 'agents' ? agentsSvc : undefined },
  effect(fn) { disposer = fn(); return disposer },
}

const { apply, name } = await import('../index.js')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let passed = 0
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log('  PASS  ' + label) }
  else { console.log('  FAIL  ' + label + '  ' + detail); process.exitCode = 1 }
}

console.log('=== relay-client mock 集成测试 ===')
check('导出名正确', name === 'relay-client', String(name))
apply(ctx, { base: 'http://mock:8765', poll_ms: 120, heartbeat_ms: 5000, timeout_ms: 1000 })
await sleep(60)

check('注册了 relay_bind 工具', tools.has('relay_bind'), [...tools.keys()].join(','))
check('注册了 relay_send 工具', tools.has('relay_send'), [...tools.keys()].join(','))
check('注册了 status 路由', routes.has('/relay-client/status'), [...routes.keys()].join(','))
check('注册了 bind 路由', routes.has('/relay-client/bind'))
check('空绑定时不发无效网络请求', calls.length === 0, JSON.stringify(calls))

// 1) 会话内绑定：exec.agent.id 自动成为 sessionId
const bindResult = await tools.get('relay_bind').execute(
  { logical_name: 'po', workspace: '/work/po' }, { agent: agent })
check('relay_bind 成功', bindResult.ok === true, JSON.stringify(bindResult))
const regCall = calls.filter(c => c.path === '/api/relay/register').at(-1)
check('注册 body 带逻辑名与 sessionId', regCall.body.logical_name === 'po' && regCall.body.session_id === 'session-po', JSON.stringify(regCall.body))

// 2) 主动发消息：from 由 exec.agent 推导，不靠参数传入
const sendResult = await tools.get('relay_send').execute(
  { to: 'fe', cc: ['be'], type: 'dispatch', thread: 'issue-42', content: '请实现登录页' },
  { agent: agent })
check('relay_send 成功', sendResult.ok === true && sendResult.seq === 42, JSON.stringify(sendResult))
const sendCall = calls.filter(c => c.path === '/api/relay/send').at(-1)
check('发送 body.from 自动识别', sendCall.body.from === 'po', JSON.stringify(sendCall.body))
check('发送 body 保留 to/cc/type/thread', sendCall.body.to === 'fe' && sendCall.body.cc[0] === 'be' &&
  sendCall.body.type === 'dispatch' && sendCall.body.thread === 'issue-42', JSON.stringify(sendCall.body))

// 2b) 回归：panel 发送失败时，返回体必须是 lossless JSON（无 undefined 字段）且保留真实错误
sendFails = true
const failResult = await tools.get('relay_send').execute(
  { to: 'backend', content: 'x' }, { agent: agent })
sendFails = false
check('发送失败时 seq 显式为 null（非 undefined）', failResult.seq === null, JSON.stringify(failResult))
check('发送失败时保留真实错误', failResult.ok === false && /通讯录无此会话/.test(failResult.error || ''), JSON.stringify(failResult))
check('发送失败返回体是 lossless JSON（无 undefined 值）',
  JSON.stringify(JSON.parse(JSON.stringify(failResult))) === JSON.stringify(failResult), JSON.stringify(failResult))

// 2c) 回归：panel 回 {ok:true} 但不带 message.seq —— 旧版会把 undefined 写进返回体
sendNoSeq = true
const noSeqResult = await tools.get('relay_send').execute(
  { to: 'fe', content: 'y' }, { agent: agent })
sendNoSeq = false
check('panel 未给 seq 时返回 ok', noSeqResult.ok === true, JSON.stringify(noSeqResult))
check('返回体不含 undefined 的 seq 键', !('seq' in noSeqResult) ||
  noSeqResult.seq === null, JSON.stringify(noSeqResult))

// 2d) 回归：fetch 层失败（panel 未启动）要给出可诊断的错误，而不是裸 "fetch failed"
sendNetFail = true
const netResult = await tools.get('relay_send').execute(
  { to: 'fe', content: 'z' }, { agent: agent })
sendNetFail = false
check('网络失败时返回 ok=false', netResult.ok === false, JSON.stringify(netResult))
check('网络失败错误里带 URL 与底层错误码',
  /\/api\/relay\/send/.test(netResult.error || '') && /\d+\.\d+\.\d+\.\d+:8765|:\/\//.test(netResult.error || '') &&
  /ECONNREFUSED/.test(netResult.error || ''), String(netResult.error))
check('网络失败提示 panel 未启动', /panel 未启动/.test(netResult.error || ''), String(netResult.error))

// 3) 未绑定会话不能冒名发送
const rogue = await tools.get('relay_send').execute(
  { to: 'fe', content: 'x' }, { agent: { id: 'session-unknown' } })
check('未绑定会话被拒绝', rogue.ok === false && /relay_bind/.test(rogue.error), JSON.stringify(rogue))

// 4) 轮询注入：收到消息 → 注入 agent → 推进游标 → ack
inboxMessages = [{
  seq: 7, id: 'msg_in_7', from: 'fe', to: 'po', cc: [], type: 'progress',
  thread: 'issue-42', content: '前端进度 30%', created_at: '2026-11-16T00:00:00+08:00',
}]
await sleep(250)
check('消息被注入会话', injected.length === 1, JSON.stringify(injected))
check('注入内容含来源与 thread', injected[0] &&
  injected[0].content[0].text.includes('from=fe') &&
  injected[0].content[0].text.includes('thread=issue-42') &&
  injected[0].content[0].text.includes('前端进度 30%'))
check('注入后 ack', acked.some(a => a.message_id === 'msg_in_7' && a.by === 'po'), JSON.stringify(acked))
let state = JSON.parse(fs.readFileSync(path.join(td, 'state.json'), 'utf8'))
check('游标持久化到 state', state.bindings.po.since === 7, JSON.stringify(state.bindings.po))

// 5) 忙时不打断：游标不推进，消息不被注入
agent.status = 'running'
inboxMessages = [{ seq: 8, id: 'msg_in_8', from: 'be', to: 'po', cc: [], type: 'result',
  thread: 'issue-42', content: '后端完成', created_at: '2026-11-16T00:00:00+08:00' }]
await sleep(250)
check('忙时不注入', injected.length === 1, JSON.stringify(injected.length))
state = JSON.parse(fs.readFileSync(path.join(td, 'state.json'), 'utf8'))
check('忙时游标不推进（保序重试）', state.bindings.po.since === 7, JSON.stringify(state.bindings.po))
check('忙时记录原因', /忙/.test(state.bindings.po.last_error || ''), state.bindings.po.last_error)

// 6) 恢复空闲后重试成功
agent.status = 'idle'
await sleep(250)
check('恢复空闲后补投成功', injected.length === 2, String(injected.length))
state = JSON.parse(fs.readFileSync(path.join(td, 'state.json'), 'utf8'))
check('补投后游标推进到 8', state.bindings.po.since === 8, JSON.stringify(state.bindings.po))

// 7) status 路由输出可读状态
const statusRes = {
  writeHead() {},
  end(body) { statusRes.body = JSON.parse(body) },
}
routes.get('/relay-client/status')({}, statusRes)
check('status 路由返回绑定状态', statusRes.body.bindings.some(b => b.name === 'po'), JSON.stringify(statusRes.body))

// 7b) relay_unbind：注销/继承/防误删（放在游标用例后，避免干扰 4-6 的 po 绑定）
check('注册了 relay_unbind 工具', tools.has('relay_unbind'), [...tools.keys()].join(','))
const rogueUnbind = await tools.get('relay_unbind').execute(
  { logical_name: 'po' }, { agent: { id: 'session-unknown' } })
check('其它会话不能注销别人的别名', rogueUnbind.ok === false && /不属于当前会话/.test(rogueUnbind.error || ''), JSON.stringify(rogueUnbind))
const noneUnbind = await tools.get('relay_unbind').execute(
  {}, { agent: { id: 'session-nobody' } })
check('未绑定会话注销被拒', noneUnbind.ok === false && /没有绑定/.test(noneUnbind.error || ''), JSON.stringify(noneUnbind))
// 继承语义：同名重绑覆盖 sessionId，游标 since=8 延续
const rebind = await tools.get('relay_bind').execute(
  { logical_name: 'po' }, { agent: { id: 'session-po2' } })
check('同名重绑（继承）成功且回显 addr', rebind.ok === true && /\/po$/.test(rebind.addr || ''), JSON.stringify(rebind))
state = JSON.parse(fs.readFileSync(path.join(td, 'state.json'), 'utf8'))
check('继承后游标延续（since 仍为 8）', state.bindings.po.since === 8 && state.bindings.po.session_id === 'session-po2',
  JSON.stringify(state.bindings.po))
// 继承后旧会话已不持有 po，应被拒绝注销
const oldOwnerUnbind = await tools.get('relay_unbind').execute(
  { logical_name: 'po' }, { agent: agent })
check('继承后旧会话不能注销', oldOwnerUnbind.ok === false && /不属于当前会话/.test(oldOwnerUnbind.error || ''), JSON.stringify(oldOwnerUnbind))
// 新持有者注销自己：ok、调用 panel unregister、本地清除
const unregBefore = calls.filter(c => c.path === '/api/relay/unregister').length
const selfUnbind = await tools.get('relay_unbind').execute(
  { logical_name: 'po' }, { agent: { id: 'session-po2' } })
check('持有者注销成功', selfUnbind.ok === true && selfUnbind.name === 'po', JSON.stringify(selfUnbind))
check('注销调用了 panel unregister',
  calls.filter(c => c.path === '/api/relay/unregister').length === unregBefore + 1)
state = JSON.parse(fs.readFileSync(path.join(td, 'state.json'), 'utf8'))
check('注销后本地绑定清除', !state.bindings.po, JSON.stringify(Object.keys(state.bindings)))
// 笔误修正场景：绑新名后留空参数自解绑
await tools.get('relay_bind').execute({ logical_name: 'po' }, { agent: agent })
const selfUnbindNoArg = await tools.get('relay_unbind').execute({}, { agent: agent })
check('留空参数注销当前会话别名', selfUnbindNoArg.ok === true && selfUnbindNoArg.name === 'po', JSON.stringify(selfUnbindNoArg))
// 为卸载用例恢复绑定
await tools.get('relay_bind').execute({ logical_name: 'po' }, { agent: agent })

// 7c) relay_forget：节点级移出通讯录（区别于 relay_unbind 的会话级注销）
check('注册了 relay_forget 工具', tools.has('relay_forget'), [...tools.keys()].join(','))
const forgetNoArg = await tools.get('relay_forget').execute({}, { agent: agent })
check('缺 machine_id 时拒绝', forgetNoArg.ok === false && /machine_id/.test(forgetNoArg.error || ''), JSON.stringify(forgetNoArg))
const selfMid = String(os.hostname()).trim().toLowerCase()
const forgetSelf = await tools.get('relay_forget').execute({ machine_id: selfMid }, { agent: agent })
check('拒绝移出本机节点', forgetSelf.ok === false && /本机/.test(forgetSelf.error || ''), JSON.stringify(forgetSelf))
const forgetOk = await tools.get('relay_forget').execute({ machine_id: '  Ghost  ' }, { agent: agent })
check('移出节点成功', forgetOk.ok === true && forgetOk.machine_id === 'ghost', JSON.stringify(forgetOk))
check('machine_id 归一化为小写并去空格',
  calls.filter(c => c.path === '/api/relay/forget').at(-1).body.machine_id === 'ghost',
  JSON.stringify(calls.filter(c => c.path === '/api/relay/forget').at(-1)))
check('回传原配对状态', forgetOk.was_linked === true, JSON.stringify(forgetOk))
check('移出结果 lossless', JSON.stringify(JSON.parse(JSON.stringify(forgetOk))) === JSON.stringify(forgetOk))
forgetFails = true
const forgetErr = await tools.get('relay_forget').execute({ machine_id: 'ghost' }, { agent: agent })
forgetFails = false
check('panel 报错时透出原因', forgetErr.ok === false && /未知节点/.test(forgetErr.error || ''), JSON.stringify(forgetErr))
check('失败结果 lossless', JSON.stringify(JSON.parse(JSON.stringify(forgetErr))) === JSON.stringify(forgetErr))

// 8) 卸载清理
const before = calls.length
disposer()
await sleep(250)
check('卸载后停止轮询', calls.length === before, String(calls.length - before))
check('卸载后工具已注销', tools.size === 0)
check('卸载后路由已注销', routes.size === 0)

fs.rmSync(td, { recursive: true, force: true })
console.log('\n=== 结果：' + passed + ' passed ===')
