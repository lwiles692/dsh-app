// probe-ws.mjs — 经网关的事件流 WS 透传验收探针。
// 用法（在 gateway/ 目录下，依赖网关已起、上游 dsh web 已起）：
//   node scripts/probe-ws.mjs stream            # 经网关开 mux downlink，触发 workspace+session 事件，逐帧校验
//   node scripts/probe-ws.mjs fence             # WS upgrade 栅栏：直连上游 evil 头被拒 / 经网关被改写放行
//   node scripts/probe-ws.mjs idle [seconds]    # 空闲挂起 N 秒（默认 180）后确认连接仍在且事件仍能到达
//   node scripts/probe-ws.mjs reconnect         # 指数退避重连循环（配合手动重启网关验证恢复）
import WebSocket from 'ws'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:3000'
const UPSTREAM = process.env.UPSTREAM ?? 'http://127.0.0.1:3080'
const COOKIE = process.env.COOKIE // 认证 cookie（如 COOKIE='dsh_auth=...'）
const wsOf = (base, path) => `${base.replace(/^http/, 'ws')}${path}`

let failures = 0
const ok = (msg) => console.log(`ok   ${msg}`)
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`) }
const ts = () => new Date().toISOString().slice(11, 19)

// 经网关发一元 RPC（envelope 与上游一致）
const post = (base, method, payload, rpcId) => fetch(`${base}/api/${method}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(COOKIE ? { cookie: COOKIE } : {}) },
  body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
}).then(r => r.json())

// 触发一组 mux 事件：workspace.create -> session.create（收尾 workspace.delete）。
// 返回清理函数。
async function triggerEvents (base, wsDir, tag) {
  const w = await post(base, 'workspace.create', { path: wsDir, name: `probe-${tag}` }, `${tag}-wc`)
  if (!w.result?.ok) throw new Error(`workspace.create 失败: ${JSON.stringify(w.result?.error)}`)
  const list = await post(base, 'workspace.list', {}, `${tag}-wl`)
  const workspaceId = list.result.value.items.find(i => i.path === wsDir)?.workspaceId
  if (!workspaceId) throw new Error('workspace.list 未找到新建 workspace')
  const s = await post(base, 'session.create', { workspaceId }, `${tag}-sc`)
  if (!s.result?.ok) throw new Error(`session.create 失败: ${JSON.stringify(s.result?.error)}`)
  return async () => { await post(base, 'workspace.delete', { workspaceId }, `${tag}-wd`).catch(() => {}) }
}

const connectMux = (base, { headers, onFrame } = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsOf(base, '/api/events.mux'), {
    headers: { ...(COOKIE ? { cookie: COOKIE } : {}), ...headers },
    perMessageDeflate: false,
  })
  const timer = setTimeout(() => { ws.terminate(); reject(new Error('open 超时')) }, 5000)
  ws.on('open', () => { clearTimeout(timer); resolve(ws) })
  ws.on('error', (e) => { clearTimeout(timer); reject(e) })
  ws.on('message', (data, isBinary) => onFrame?.(data, isBinary))
})

// 帧校验器：纯文本、可解析 JSON、type=server-request
const frameChecker = () => {
  const state = { frames: 0, allGood: true }
  return {
    state,
    onFrame (data, isBinary) {
      state.frames++
      if (isBinary || typeof data.toString !== 'function') { state.allGood = false; return }
      try {
        const p = JSON.parse(data.toString())
        if (p.type !== 'server-request') state.allGood = false
      } catch { state.allGood = false }
    },
  }
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms))

async function cmdStream () {
  const wsDir = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  const checker = frameChecker()
  const ws = await connectMux(GATEWAY, { onFrame: checker.onFrame })
  ok(`经网关 WS 连接建立 ${wsOf(GATEWAY, '/api/events.mux')}`)
  const t0 = Date.now()
  const cleanup = await triggerEvents(GATEWAY, wsDir, 'st')
  await sleep(3000)
  const lat = Date.now() - t0
  await cleanup()
  ws.close()
  if (checker.state.frames > 0 && checker.state.allGood) {
    ok(`流式事件实时到达：${checker.state.frames} 帧 / ${lat}ms 窗口内逐条收到，全部为文本 JSON server-request`)
  } else if (checker.state.frames === 0) fail('未收到任何下行帧')
  else fail('存在非文本/非 server-request 帧')
  rmSync(wsDir, { recursive: true, force: true })
}

async function cmdFence () {
  // 直连上游带 evil Host/Origin -> 应被栅栏拒绝（对照组）
  try {
    await connectMux(UPSTREAM, { headers: { Host: 'evil.com', Origin: 'http://evil.com' } })
    fail('直连上游 evil Host/Origin 的 upgrade 竟被接受')
  } catch {
    ok('直连上游 evil Host/Origin -> upgrade 被拒（栅栏生效，对照组）')
  }
  // 经网关带 evil Origin -> 网关剥离/改写后应放行
  try {
    const ws = await connectMux(GATEWAY, { headers: { Origin: 'http://evil.com', 'Sec-Fetch-Site': 'cross-site' } })
    ok('经网关 evil Origin + Sec-Fetch-Site: cross-site -> upgrade 放行（网关改写头过栅栏）')
    ws.close()
  } catch (e) {
    fail(`经网关 upgrade 被拒: ${e.message}`)
  }
  // 非 upgrade 普通 GET 经网关 -> 应与上游一致 426
  const r = await fetch(`${GATEWAY}/api/events.mux`)
  const body = await r.text()
  if (r.status === 426) ok(`普通 GET /api/events.mux 经网关 -> 426 (${body.trim()})，与上游一致`)
  else fail(`普通 GET 经网关 -> ${r.status}，期望 426`)
}

async function cmdIdle (seconds = 180) {
  const wsDir = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  const checker = frameChecker()
  const ws = await connectMux(GATEWAY, { onFrame: checker.onFrame })
  ok(`WS 已连接，空闲挂起 ${seconds}s（不发任何帧）…`)
  let closedEarly = null
  ws.on('close', (code, reason) => { closedEarly = { code, reason: reason.toString() } })
  await sleep(seconds * 1000)
  if (closedEarly) {
    fail(`空闲 ${seconds}s 内连接被中断: code=${closedEarly.code} reason=${closedEarly.reason}`)
  } else if (ws.readyState !== WebSocket.OPEN) {
    fail(`空闲 ${seconds}s 后 readyState=${ws.readyState}（非 OPEN）`)
  } else {
    ok(`空闲 ${seconds}s 后连接仍 OPEN`)
    const cleanup = await triggerEvents(GATEWAY, wsDir, 'idle')
    await sleep(3000)
    await cleanup()
    if (checker.state.frames > 0) ok(`空闲后事件仍能到达（${checker.state.frames} 帧）`)
    else fail('空闲后未收到事件帧')
  }
  ws.close()
  rmSync(wsDir, { recursive: true, force: true })
}

async function cmdReconnect () {
  // 指数退避重连循环（1s -> 2s -> 4s …上限 15s），模拟浏览器客户端。
  // 用法：启动后手动重启网关，观察重连成功且重连后事件仍能到达。
  // 仅当一代连接真正 open 且收到过事件帧才计入 verifiedGens，满 2 代（初始+重连后）收工。
  const wsDir = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  let attempt = 0
  let verifiedGens = 0
  const connect = () => new Promise((resolve) => {
    const checker = frameChecker()
    let opened = false
    const ws = new WebSocket(wsOf(GATEWAY, '/api/events.mux'), {
      headers: COOKIE ? { cookie: COOKIE } : undefined,
      perMessageDeflate: false,
    })
    ws.on('message', checker.onFrame)
    ws.on('open', async () => {
      opened = true
      console.log(`[${ts()}] 连接建立（第 ${attempt + 1} 次尝试）`)
      attempt = 0
      // 每成功建连一次就触发一组事件，证明该代连接下行可用
      try {
        const cleanup = await triggerEvents(GATEWAY, wsDir, `rc${verifiedGens}`)
        await sleep(2000)
        await cleanup()
        console.log(`[${ts()}] 本代连接收到 ${checker.state.frames} 帧${checker.state.frames > 0 ? '（下行可用）' : '（无帧！）'}`)
        if (checker.state.frames > 0) verifiedGens++
        if (verifiedGens >= 2) { ws.close(); resolve() } // 初始连接 + 重连后各验证一代即收工
      } catch (e) { console.log(`[${ts()}] 触发事件失败: ${e.message}`) }
    })
    ws.on('close', (code) => {
      if (verifiedGens >= 2) return resolve()
      const delay = Math.min(1000 * 2 ** attempt, 15000)
      attempt++
      console.log(`[${ts()}] ${opened ? '连接断开' : '连接被拒'} code=${code}，${delay}ms 后指数退避重连…`)
      setTimeout(() => connect().then(resolve), delay)
    })
    ws.on('error', () => {}) // error 后必有 close，退避逻辑在 close 里
  })
  await connect()
  ok(`断开后指数退避重连可恢复，重连后事件流恢复（共验证 ${verifiedGens} 代连接）`)
  rmSync(wsDir, { recursive: true, force: true })
}

const [, , cmd, arg] = process.argv
try {
  if (cmd === 'stream') await cmdStream()
  else if (cmd === 'fence') await cmdFence()
  else if (cmd === 'idle') await cmdIdle(Number(arg ?? 180))
  else if (cmd === 'reconnect') await cmdReconnect()
  else { console.error('usage: probe-ws.mjs stream|fence|idle [seconds]|reconnect'); process.exit(2) }
} catch (e) {
  fail(`探针异常: ${e.message}`)
}
process.exit(failures ? 1 : 0)
