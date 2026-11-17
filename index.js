/**
 * dsh-relay-client —— pcpanel 中继与 DSH 会话之间的轻量桥。
 *
 * 不修改 DSH 核心、不打补丁到其他插件。只做三件事：
 *   1. 通过 relay_send / relay_bind 工具，让会话里的 agent 能主动喊话与绑定身份；
 *   2. 后台轮询 pcpanel 收件箱，把发给自己的消息注入对应会话；
 *   3. HTTP 状态/绑定端点，便于面板或直接 curl 操作。
 *
 * 会话身份的来源：后台定时器里没有 initiator，拿不到"当前会话"，所以逻辑名必须
 * 由会话自己通过 relay_bind 工具声明（此时 exec.agent.id 就是当前 sessionId），
 * 或通过 POST /relay-client/bind 显式传 session_id。绑定结果落盘，重启后自动恢复。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'relay-client'
export const inject = ['tools', 'webServer']

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TYPES = ['dispatch', 'progress', 'contract', 'result', 'ack', 'note']

const DEFAULTS = {
  base: 'http://127.0.0.1:8765',
  // 本机稳定机器名：三级地址第一级，必须与本机 panel 的 config.relay.machine_id 一致。
  // 留空时回退到 hostname（此时三级地址机器名可能与 panel 不一致，跨机定位会失败，务必显式配置）。
  machine_id: '',
  workspace: '',
  poll_ms: 2000,
  heartbeat_ms: 60000,
  limit: 20,
  timeout_ms: 8000,
}

function configOf(config) {
  const raw = config && typeof config.get === 'function' ? (config.get() || {}) : (config || {})
  const out = { ...DEFAULTS, ...raw }
  out.poll_ms = Math.max(100, Number(out.poll_ms) || DEFAULTS.poll_ms)
  out.heartbeat_ms = Math.max(5000, Number(out.heartbeat_ms) || DEFAULTS.heartbeat_ms)
  out.limit = Math.max(1, Math.min(200, Number(out.limit) || DEFAULTS.limit))
  out.base = String(out.base || DEFAULTS.base).replace(/\/+$/, '')
  return out
}

function stateDir() {
  return process.env.RELAY_CLIENT_STATE_DIR ||
    path.join(os.homedir(), '.dsh', 'state', 'relay-client')
}

function statePath() {
  return path.join(stateDir(), 'state.json')
}

function loadState() {
  try {
    const obj = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    const bindings = {}
    for (const [key, value] of Object.entries(obj.bindings || {})) {
      if (value && typeof value === 'object') bindings[key] = value
    }
    return { bindings }
  } catch {
    return { bindings: {} }
  }
}

function saveState(state) {
  const file = statePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function safeAgents(ctx) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (viaGet) return viaGet
  } catch { /* 非活跃上下文 */ }
  try { return ctx.agents } catch { return undefined }
}

async function httpJson(base, endpoint, { method = 'GET', body, timeout } = {}) {
  const url = base + endpoint
  let res
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    })
  } catch (err) {
    // Node 的 fetch 失败只会抛 "fetch failed"，看不出是端口没开还是超时。
    // 补上 URL + 底层错误码，排障时不用再猜（常见：ECONNREFUSED=panel 没启动）。
    const cause = (err && (err.cause && (err.cause.code || err.cause.message))) ||
      (err && err.name) || 'unknown'
    const hint = String(cause) === 'ECONNREFUSED' ? '（本机 panel 未启动或端口不通）' : ''
    throw new Error('连不上中继 ' + url + '：' + String(cause) + hint)
  }
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text.slice(0, 200) } }
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (data.error || data.raw || ''))
  return data
}

function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'user' },
  }
}

function formatIncoming(msg) {
  const cc = (msg.cc || []).length ? ' cc=' + msg.cc.join(',') : ''
  const thread = msg.thread ? ' thread=' + msg.thread : ''
  const from = msg.from_addr || msg.from
  return '[relay:' + msg.type + '] from=' + from + cc + thread + ' seq=' + msg.seq + '\n' +
    msg.content + '\n\n' +
    '（这是另一个 DSH 会话通过中继发来的消息，from 为三级地址 机器名/工作区/别名。' +
    '如需回复，可调用 relay_send 工具，to 填该三级地址或它的短别名。）'
}

/** 三级注入：followup → steer → inbox.append，忙时不打断。 */
function deliver(agents, sessionId, text) {
  const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (!agent) return { ok: false, reason: '会话不在宿主中（sessionId=' + sessionId + '）' }
  const status = agent.status
  if (status && status !== 'idle') {
    return { ok: false, reason: '会话正忙（status=' + status + '），稍后重试', busy: true }
  }
  const message = userMessage(text)
  try {
    if (typeof agent.followup === 'function') {
      agent.followup(message)
      return { ok: true, via: 'followup' }
    }
    if (typeof agent.steer === 'function') {
      agent.steer(message)
      return { ok: true, via: 'steer' }
    }
    const inbox = agent.inbox || (agent.session && agent.session.inbox)
    if (inbox && typeof inbox.append === 'function') {
      inbox.append('next-turn', message)
      return { ok: true, via: 'inbox.append' }
    }
    return { ok: false, reason: '宿主未提供注入入口' }
  } catch (err) {
    return { ok: false, reason: '注入异常：' + (err && err.message ? err.message : String(err)) }
  }
}

/** DSH 要求工具返回值是 lossless JSON：任何 undefined / 函数 / 循环引用都会让
 *  整个结果被判为非 JSON，真实错误被吞成 "value is not lossless JSON"。
 *  这里统一兜底：序列化一遍再回来，undefined 键自动消失，保证任何分支都不会脏。 */
function lossless(value) {
  if (value === undefined || value === null) return { ok: false, error: '未知原因' }
  try {
    const s = JSON.stringify(value)
    if (typeof s !== 'string') return { ok: false, error: '结果不可序列化' }
    const back = JSON.parse(s)
    return (back && typeof back === 'object' && !Array.isArray(back)) ? back : { ok: false, error: '结果不是对象' }
  } catch (err) {
    return { ok: false, error: '结果序列化失败：' + (err && err.message ? err.message : String(err)) }
  }
}

function toolDef(name, description, parameters, outputSchema, execute) {
  // 普通对象形状与 @deepseek-ai/dsh-tools 的 defineTool 输出一致；
  // 这样即使 profile 里 dsh-tools 版本不同也能注册。
  return {
    name,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render: (_args, value) => [{
        type: 'text',
        text: value && value.ok
          ? 'relay: ok' + (value.seq ? ' (seq=' + value.seq + ')' : '')
          : 'relay: 失败 —— ' + ((value && value.error) || '未知原因'),
      }],
    },
    async execute(args, exec) {
      try {
        return lossless(await execute(args || {}, exec || {}))
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) }
      }
    },
  }
}

export function apply(ctx, options = {}) {
  const cfg = configOf(options)
  const state = loadState()
  const log = []
  let disposed = false
  let timerPoll = null
  let timerBeat = null

  function line(text) {
    log.push(new Date().toISOString() + ' ' + String(text).slice(0, 300))
    if (log.length > 100) log.shift()
  }

  function findBySession(sessionId) {
    return Object.values(state.bindings).find(b => b.session_id === sessionId)
  }

  async function bind(logicalName, sessionId, machine, workspace) {
    const n = String(logicalName || '').trim().toLowerCase()
    const sid = String(sessionId || '').trim()
    if (!NAME_RE.test(n)) return { ok: false, error: '逻辑名不合法：' + n }
    if (!sid) return { ok: false, error: '缺少 session_id（请在会话内用 relay_bind 工具，或 HTTP bind 时显式传）' }
    const old = state.bindings[n] || {}
    // 机器名优先级：显式参数 > 配置 machine_id > hostname。
    // workspace 优先级：显式参数 > 配置 workspace。
    const machineName = String(machine || cfg.machine_id || os.hostname()).slice(0, 120).toLowerCase()
    const ws = String(workspace || cfg.workspace || '').slice(0, 240).toLowerCase()
    const binding = {
      name: n,
      session_id: sid,
      machine: machineName,
      workspace: ws,
      addr: [machineName, ws, n].filter(Boolean).join('/'),
      since: Number(old.since) || 0,
      last_error: '',
      last_seen: new Date().toISOString(),
    }
    state.bindings[n] = binding
    saveState(state)
    try {
      const r = await httpJson(cfg.base, '/api/relay/register', {
        method: 'POST',
        body: { logical_name: n, session_id: sid, machine: binding.machine, workspace: binding.workspace },
        timeout: cfg.timeout_ms,
      })
      if (!r.ok) throw new Error(r.error || '注册被拒绝')
      line('已注册 ' + binding.addr + ' -> ' + sid)
      return { ok: true, name: n, session_id: sid, addr: r.addr || binding.addr }
    } catch (err) {
      binding.last_error = '注册失败：' + err.message
      saveState(state)
      return { ok: false, error: binding.last_error }
    }
  }

  async function unbind(logicalName) {
    const n = String(logicalName || '').trim().toLowerCase()
    const existed = Boolean(state.bindings[n])
    delete state.bindings[n]
    saveState(state)
    try {
      await httpJson(cfg.base, '/api/relay/unregister', {
        method: 'POST', body: { logical_name: n }, timeout: cfg.timeout_ms,
      })
    } catch { /* 本地已解绑，服务端 TTL 会自然过期 */ }
    return { ok: existed, name: n }
  }

  // ---- 工具 1：会话内绑定身份（唯一可靠拿到当前 sessionId 的入口）----
  const bindTool = toolDef(
    'relay_bind',
    '把当前 DSH 会话绑定到本机 pcpanel 中继的会话别名。每个需要跨会话通讯的会话都要先调用一次。' +
    '绑定后本会话的三级地址为 机器名/工作区/别名，全网唯一，可被其它机器按此地址找到。' +
    '同名重绑即「继承」：旧会话上下文满后，新会话用相同 logical_name 重绑可接管该地址，' +
    '消息游标（seq）延续，不会重复收旧消息。绑定笔误修正：先 relay_unbind 旧名，再 bind 新名。',
    {
      logical_name: { type: 'string', required: true, description: '本会话别名，例如 product-office / frontend / backend（小写字母、数字、-、_）。这是三级地址的第三级' },
      machine: { type: 'string', required: false, description: '机器名（三级地址第一级），默认取插件配置的 machine_id，须与本机 panel 的 machine_id 一致' },
      workspace: { type: 'string', required: false, description: '工作区名（三级地址第二级），默认取插件配置的 workspace' },
    },
    { type: 'object', properties: { ok: { type: 'boolean' }, name: { type: 'string' }, session_id: { type: 'string' }, addr: { type: 'string' } } },
    async (args, exec) => {
      const sessionId = String(exec.agent?.id || exec.agent?.session?.id || '')
      return bind(args.logical_name, sessionId, args.machine, args.workspace)
    },
  )

  // ---- 工具 2：注销自己的绑定（归档下线 / 修正笔误）----
  const unbindTool = toolDef(
    'relay_unbind',
    '把当前 DSH 会话从中继通讯录里注销（下线）。' +
    '用途：任务完成归档下线；绑定笔误修正（先 relay_unbind 旧名，再 relay_bind 新名）。' +
    '只能注销当前会话自己持有的别名，不能动其它会话的身份；' +
    '若新会话要接管旧别名（继承），不要 unbind，直接用 relay_bind 同名重绑。',
    {
      logical_name: { type: 'string', required: false, description: '要注销的别名；留空表示注销当前会话绑定的别名' },
    },
    { type: 'object', properties: { ok: { type: 'boolean' }, name: { type: 'string' }, addr: { type: 'string' }, error: { type: 'string' } } },
    async (args, exec) => {
      const sessionId = String(exec.agent?.id || exec.agent?.session?.id || '')
      if (!sessionId) return { ok: false, error: '拿不到当前 sessionId' }
      let n = String(args.logical_name || '').trim().toLowerCase()
      if (!n) {
        const mine = findBySession(sessionId)
        if (!mine) return { ok: false, error: '当前会话没有绑定任何别名' }
        n = mine.name
      }
      const b = state.bindings[n]
      if (!b) return { ok: false, error: '别名 ' + n + ' 未绑定' }
      if (b.session_id !== sessionId) {
        return { ok: false, error: '别名 ' + n + ' 不属于当前会话，拒绝注销；若为继承接管请用 relay_bind 同名重绑' }
      }
      const addr = b.addr || ''
      const r = await unbind(n)
      const out = { ok: Boolean(r.ok), name: n }
      if (addr) out.addr = addr
      return out
    },
  )

  // ---- 工具 3：把机器节点彻底移出通讯录（清理幽灵节点 / 反悔配对）----
  const forgetTool = toolDef(
    'relay_forget',
    '把一台机器节点彻底移出本机中继通讯录。' +
    '与 relay_unbind 的区别：unbind 注销的是"本会话的别名"（会话级），' +
    'forget 删除的是"一整个机器节点"（节点级），会同时解除配对并忽略它后续的广播，不会被自动加回来。' +
    '典型用途：清理已下线/抓包遗留的幽灵节点、反悔某次配对。对端仍在线的话会收到解除通知；' +
    '想恢复只要重新配对（relay_bind 不会恢复节点，需在 panel 界面或 /api/relay/link 重新配对）。',
    {
      machine_id: { type: 'string', required: true, description: '要移出的机器名（三级地址第一级），例如 macbook / pc-office。不能是本机 machine_id' },
    },
    { type: 'object', properties: { ok: { type: 'boolean' }, machine_id: { type: 'string' }, was_linked: { type: 'boolean' }, error: { type: 'string' } } },
    async (args) => {
      const mid = String(args.machine_id || '').trim().toLowerCase()
      if (!mid) return { ok: false, error: 'machine_id 必填' }
      if (mid === String(cfg.machine_id || os.hostname()).trim().toLowerCase()) {
        return { ok: false, error: '不能移出本机节点' }
      }
      const r = await httpJson(cfg.base, '/api/relay/forget',
        { method: 'POST', body: { machine_id: mid }, timeout: cfg.timeout_ms })
      if (r && r.ok === false) return { ok: false, error: r.error || '移出失败' }
      return { ok: true, machine_id: mid, was_linked: Boolean(r && r.was_linked) }
    },
  )

  // ---- 工具 2：主动发消息给别的会话 ----
  const sendTool = toolDef(
    'relay_send',
    '通过本机 pcpanel 中继给另一个 DSH 会话发消息（本机 panel 像运营商，会自动查通讯录并转发到目标机器）。' +
    '只有 to 或 cc 指定的会话会收到，不会误唤醒其他会话。',
    {
      to: {
        type: 'string', required: false,
        description: '单播目标：可写短别名（如 frontend，全网唯一时即命中）、两级 工作区/别名（如 mowen-frontend/frontend），' +
          '或三级全地址（如 macbook/mowen-frontend/frontend，精确定位到某台机器）。重名时必须写全称。广播时留空但必须填 cc 或 thread',
      },
      cc: { type: 'array', items: { type: 'string' }, required: false, description: '抄送的会话地址数组（格式同 to），例如 ["product-office","macbook/mowen-frontend/frontend"]' },
      type: { type: 'string', required: false, enum: TYPES, description: '消息类型：dispatch(下发)/progress(进度)/contract(契约协商)/result(结果)/ack/note' },
      thread: { type: 'string', required: false, description: '线程标识，例如 issue-42；同一任务的所有消息用它串联' },
      content: { type: 'string', required: true, description: '消息正文' },
      channel: { type: 'string', required: false, description: '项目/主题频道名' },
    },
    { type: 'object', properties: { ok: { type: 'boolean' }, seq: { type: 'integer' }, error: { type: 'string' } } },
    async (args, exec) => {
      const sessionId = String(exec.agent?.id || exec.agent?.session?.id || '')
      const mine = findBySession(sessionId)
      if (!mine) {
        return { ok: false, error: '当前会话尚未绑定逻辑名，请先调用 relay_bind' }
      }
      const r = await httpJson(cfg.base, '/api/relay/send', {
        method: 'POST',
        body: {
          from: mine.name, to: args.to || null, cc: args.cc || [],
          type: args.type || 'note', thread: args.thread || '',
          content: args.content, channel: args.channel || '',
        },
        timeout: cfg.timeout_ms,
      })
      line('发出 seq=' + (r.message?.seq || '?') + ' from=' + mine.name + ' to=' + (args.to || 'cc'))
      // DSH 要求工具返回 lossless JSON：任何 undefined 字段都会让整个结果被判为非 JSON，
      // 真实错误（如"通讯录无此会话"）就被吞成 "value is not lossless JSON"。
      // 因此失败时 seq 必须是显式值（null），且 error 只在存在时给出。
      const out = { ok: Boolean(r.ok), seq: r.message?.seq ?? null }
      if (r.error) out.error = r.error
      return out
    },
  )

  // ---- 定时器：心跳 + 收件箱轮询 ----
  async function heartbeat() {
    if (disposed) return
    for (const b of Object.values(state.bindings)) {
      try {
        const r = await httpJson(cfg.base, '/api/relay/register', {
          method: 'POST',
          body: { logical_name: b.name, session_id: b.session_id, machine: b.machine, workspace: b.workspace },
          timeout: cfg.timeout_ms,
        })
        if (!r.ok) throw new Error(r.error || '注册被拒绝')
        b.last_error = ''
      } catch (err) {
        b.last_error = '心跳失败：' + err.message
        line(b.name + ' ' + b.last_error)
      }
    }
    saveState(state)
  }

  let polling = false
  async function poll() {
    // 互斥：一轮没跑完不要开下一轮，否则两边都从同一个 since 拉到同一批消息，
    // 会造成重复注入。游标在整轮处理完才落盘，重入是最危险的竞态。
    if (disposed || polling) return
    polling = true
    try {
      const agents = safeAgents(ctx)
      for (const b of Object.values(state.bindings)) {
        let data
        try {
          data = await httpJson(cfg.base,
            '/api/relay/inbox?name=' + encodeURIComponent(b.name) +
            '&since=' + encodeURIComponent(b.since || 0) + '&limit=' + cfg.limit,
            { timeout: cfg.timeout_ms })
          if (!data.ok) throw new Error(data.error || '拉取失败')
        } catch (err) {
          b.last_error = '收件箱拉取失败：' + err.message
          line(b.name + ' ' + b.last_error)
          continue
        }
        for (const msg of (data.messages || [])) {
          // 双保险：不盲信服务端过滤。版本不一致或服务端返回历史消息时，
          // 这里仍按 since 与 to/cc 再筛一遍，避免重复注入（重复喊话比漏一条更糟）。
          if (Number(msg.seq) <= Number(b.since || 0)) continue
          if (msg.to !== b.name && !(msg.cc || []).includes(b.name)) continue
          const result = deliver(agents, b.session_id, formatIncoming(msg))
          if (!result.ok) {
            b.last_error = result.reason
            line(b.name + ' 投递失败 seq=' + msg.seq + '：' + result.reason)
            break  // 保序：前面没送成就不推进游标，也不处理后面的消息
          }
          b.since = msg.seq
          b.last_error = ''
          line(b.name + ' 注入 seq=' + msg.seq + ' via=' + result.via)
          try {
            await httpJson(cfg.base, '/api/relay/ack', {
              method: 'POST', body: { message_id: msg.id, by: b.name }, timeout: cfg.timeout_ms,
            })
          } catch (err) {
            line(b.name + ' ack 失败 seq=' + msg.seq + '：' + err.message)
          }
        }
        saveState(state)
      }
    } catch (err) {
      line('轮询异常：' + (err && err.message ? err.message : String(err)))
    } finally {
      polling = false
    }
  }

  // ---- 生命周期：工具注册 + 路由 + 定时器，全部交给 effect 回收 ----
  ctx.effect(() => {
    const disposers = []
    try {
      disposers.push(ctx.tools.register(bindTool))
      disposers.push(ctx.tools.register(sendTool))
      disposers.push(ctx.tools.register(unbindTool))
      disposers.push(ctx.tools.register(forgetTool))
    } catch (err) {
      line('工具注册失败：' + (err && err.message ? err.message : String(err)))
    }

    if (ctx.webServer && typeof ctx.webServer.register === 'function') {
      const routes = [
        {
          kind: 'exact', path: '/relay-client/status', handler: (_req, res) => {
            const body = JSON.stringify({
              ok: true, base: cfg.base, machine_id: cfg.machine_id || os.hostname(),
              workspace: cfg.workspace, poll_ms: cfg.poll_ms,
              bindings: Object.values(state.bindings), log: log.slice(-20),
            })
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(body)
          },
        },
        {
          kind: 'exact', path: '/relay-client/bind', handler: async (req, res) => {
            let body = {}
            try {
              const chunks = []
              for await (const chunk of req) chunks.push(chunk)
              body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            } catch { /* 空 body 用默认值 */ }
            const result = await bind(body.logical_name || body.name, body.session_id,
              body.machine, body.workspace)
            res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(result))
          },
        },
        {
          kind: 'exact', path: '/relay-client/unbind', handler: async (req, res) => {
            let body = {}
            try {
              const chunks = []
              for await (const chunk of req) chunks.push(chunk)
              body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            } catch { /* ignore */ }
            const result = await unbind(body.logical_name || body.name)
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(result))
          },
        },
      ]
      for (const route of routes) {
        try { disposers.push(ctx.webServer.register(route)) }
        catch (err) { line('路由注册失败 ' + route.path + '：' + err.message) }
      }
    }

    // 启动即注册一次 + 立即轮询一次，之后按配置周期续约/拉取
    heartbeat().catch(() => {})
    poll().catch(() => {})
    timerBeat = setInterval(() => heartbeat().catch(() => {}), cfg.heartbeat_ms)
    timerPoll = setInterval(() => poll().catch(() => {}), cfg.poll_ms)
    try { timerBeat.unref?.(); timerPoll.unref?.() } catch { /* 测试环境可能没有 unref */ }

    return () => {
      if (disposed) return
      disposed = true
      if (timerBeat) clearInterval(timerBeat)
      if (timerPoll) clearInterval(timerPoll)
      for (let i = disposers.length - 1; i >= 0; i--) {
        try { disposers[i]?.() } catch { /* 单个清理失败不影响其余 */ }
      }
    }
  }, 'relay-client:runtime')

  return { name, state }
}
