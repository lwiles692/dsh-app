// dsh 多客户端网关（issue 02：骨架 + HTTP 反代；issue 03：事件流 WS 透传）
//
// 把上游 dsh Host 的 SPA 静态文件与 /api 一元 POST 全量反向代理到 UPSTREAM，
// 并透传 /api/events.mux 与 /api/events.host 两条纯下行 WebSocket（上游 web 面
// 无 SSE 回退，GET 同路径返回 426，见 issue 01 Comments 实测）。
// 过上游信任栅栏的关键（HTTP 与 WS upgrade 一致，见 issue 01 Comments）：
//   - Host 改写为上游回环地址（默认 127.0.0.1:3080）
//   - 剥离 Origin / Sec-Fetch-* 头（上游实测：无这些头即视为可信回环请求）
// 请求体上限 160 MiB，对齐上游。本票不含认证（issue 04）。
import Fastify from 'fastify'
import httpProxy from '@fastify/http-proxy'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'
import { Transform } from 'node:stream'

const UPSTREAM = process.env.UPSTREAM ?? 'http://127.0.0.1:3080'
const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 3000)
const BODY_LIMIT = 160 * 1024 * 1024 // 160 MiB，对齐上游
const WS_MAX_PAYLOAD = 100 * 1024 * 1024 // 100 MiB，对齐上游 ws 库 maxPayload

const upstreamHost = new URL(UPSTREAM).host // 如 127.0.0.1:3080
const upstreamWsBase = UPSTREAM.replace(/^http/, 'ws') // 如 ws://127.0.0.1:3080

const tooLargePayload = () => ({
  statusCode: 413,
  code: 'FST_ERR_CTP_BODY_TOO_LARGE',
  error: 'Payload Too Large',
  message: 'Request body is too large',
})

// 标记错误：preParsing 计数流超限时抛出，经 reply-from 包装后按 message 识别映射 413
const BODY_TOO_LARGE_MARK = 'DSH_GATEWAY_BODY_TOO_LARGE'

const app = Fastify({
  logger: true,
  bodyLimit: BODY_LIMIT,
  // 长连接约束（issue 03）：WS downlink 空闲挂起不得被掐断——
  // 关掉 Node http server 的 socket 超时与整请求超时（默认 300s 会杀慢请求）。
  connectionTimeout: 0,
  requestTimeout: 0,
})

// 上游 160 MiB 上限在网关侧对等强制（代理走流式透传，fastify 的 bodyLimit
// 对自定义透传 parser 不生效，见 fastify content-type-parser：仅 asString/asBuffer
// 默认 parser 检查 limit）。两道闸：
// 1) 声明了 content-length 超限 -> 直接 413，不读 body；
app.addHook('onRequest', (req, reply, done) => {
  const len = Number(req.headers['content-length'])
  if (Number.isFinite(len) && len > BODY_LIMIT) {
    reply.header('connection', 'close').code(413).send(tooLargePayload())
    return
  }
  done()
})

// 2) chunked/未声明长度 -> 计数 Transform，超限即中止流（错误经 reply-from
//    onError 映射为 413，与上游行为一致）。
app.addHook('preParsing', (_req, _reply, payload, done) => {
  let received = 0
  const counter = new Transform({
    transform (chunk, _enc, cb) {
      received += chunk.length
      if (received > BODY_LIMIT) {
        cb(new Error(BODY_TOO_LARGE_MARK))
        return
      }
      cb(null, chunk)
    },
  })
  done(null, payload.pipe(counter))
})

// 栅栏改写（HTTP 反代与 WS upgrade 共用）：Host 钉到上游回环地址；
// 剥离 Origin 与 Sec-Fetch-*：上游栅栏对「无 Origin 的回环请求」放行，
// 浏览器经网关访问时自带的 Origin（网关源）与上游 Host 不一致会 403。
const rewriteHeaders = (headers) => {
  const out = { ...headers, host: upstreamHost }
  delete out.origin
  // undici 不支持 Expect: 100-continue（大 body 的 curl/HTTP 客户端会带），剥离之
  delete out.expect
  for (const key of Object.keys(out)) {
    if (key.startsWith('sec-fetch-')) delete out[key]
  }
  return out
}

// --- issue 03：事件流 WS 透传 ------------------------------------------------
// /api/events.mux 与 /api/events.host：纯下行 WS。手动处理 upgrade（@fastify/websocket），
// 网关作为 ws 客户端连上游同路径，双向逐帧转发（上行帧上游会回 close(1008) 'downlink only'，
// 该行为经透传原样保留）。帧到达即转发：perMessageDeflate 关闭，无压缩 buffering；
// maxPayload 双向 100 MiB，对齐上游 ws 库默认上限。
const EVENT_PATHS = ['/api/events.mux', '/api/events.host']

await app.register(websocket, {
  options: { maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false },
})

// ws 库不允许回传的 close code（保留码）：对端异常断开（1006）等映射为 1001
const relayClose = (target) => (code, reason) => {
  const c = code >= 1000 && code !== 1005 && code !== 1006 && code !== 1015 ? code : 1001
  if (target.readyState === WebSocket.OPEN || target.readyState === WebSocket.CONNECTING) {
    target.close(c, reason)
  }
}

const proxyEventStream = (clientSocket, req, path) => {
  // 与 02 HTTP 反代一致的栅栏改写；另剥离客户端握手头，由 ws 客户端自行生成
  const headers = rewriteHeaders(req.headers)
  for (const key of Object.keys(headers)) {
    if (key === 'connection' || key === 'upgrade' || key.startsWith('sec-websocket-')) delete headers[key]
  }
  const protocols = req.headers['sec-websocket-protocol'] // 子协议原样透传（上游未启用，防御性）
  const upstream = new WebSocket(`${upstreamWsBase}${path}`, protocols ?? [], {
    headers,
    maxPayload: WS_MAX_PAYLOAD,
    perMessageDeflate: false,
  })

  // 纯下行：上游帧实时转发给客户端，无 buffering
  upstream.on('message', (data, isBinary) => {
    if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(data, { binary: isBinary })
  })
  // 客户端上行帧透传给上游（协议上属违规，上游会以 close(1008) 拒绝，行为保留）
  clientSocket.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
  })
  upstream.on('close', relayClose(clientSocket))
  clientSocket.on('close', relayClose(upstream))
  upstream.on('error', () => clientSocket.terminate())
  clientSocket.on('error', () => upstream.terminate())
  // 上游拒绝 upgrade（如上游挂了）：通知客户端而不是静默挂起
  upstream.on('unexpected-response', () => clientSocket.close(1011, 'upstream rejected upgrade'))
}

for (const path of EVENT_PATHS) {
  app.get(path, {
    wsHandler: (socket, req) => proxyEventStream(socket, req, path),
  }, (_req, reply) => {
    // 非 upgrade 的普通 GET：镜像上游行为（426，web 面无 SSE 回退）
    reply.code(426).type('text/plain; charset=utf-8').send('upgrade required')
  })
}

await app.register(httpProxy, {
  upstream: UPSTREAM,
  prefix: '/',
  http2: false,
  replyOptions: {
    // 注意：rewriteRequestHeaders 必须放在 replyOptions 下——@fastify/http-proxy v11
    // 只把 replyOptions 透传给逐请求的 reply.from()，顶层同名选项对 HTTP 路径不生效。
    rewriteRequestHeaders: (_req, headers) => rewriteHeaders(headers),
    onError: (reply, { error }) => {
      if (typeof error?.message === 'string' && error.message.includes(BODY_TOO_LARGE_MARK)) {
        reply.header('connection', 'close').code(413).send(tooLargePayload())
        return
      }
      reply.send(error)
    },
  },
})

await app.listen({ host: HOST, port: PORT })
