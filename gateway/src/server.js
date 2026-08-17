// dsh 网关：认证 + 反向代理 + WS 透传，上游为回环 dsh Host。
// 过上游信任栅栏：Host 改写为上游回环地址，剥离 Origin / Sec-Fetch-* 头
//（上游栅栏对无 Origin 的回环请求放行）。
// 除 GET/POST /login 外的一切请求（含 WS upgrade）须持有效 cookie，否则 401。
import Fastify from 'fastify'
import httpProxy from '@fastify/http-proxy'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'
import { Transform } from 'node:stream'
import { createHash, timingSafeEqual } from 'node:crypto'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { patchHtml } from './mobile-patch.js'

const UPSTREAM = process.env.UPSTREAM ?? 'http://127.0.0.1:3080'
const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 3000)
const BODY_LIMIT = 160 * 1024 * 1024 // 160 MiB，对齐上游
const WS_MAX_PAYLOAD = 100 * 1024 * 1024 // 100 MiB，对齐上游 ws 库 maxPayload

const upstreamHost = new URL(UPSTREAM).host
const upstreamWsBase = UPSTREAM.replace(/^http/, 'ws')

const AUTH_TOKEN = process.env.AUTH_TOKEN
const COOKIE_NAME = 'dsh_auth'
const COOKIE_MAX_AGE = 365 * 24 * 3600
const secureRaw = (process.env.AUTH_COOKIE_SECURE ?? 'true').trim().toLowerCase()
const COOKIE_SECURE = !(secureRaw === 'false' || secureRaw === '0' || secureRaw === 'no')
const LOGIN_RATE_MAX = 10
const LOGIN_RATE_WINDOW_MS = 60_000

// 移动布局补丁注入开关。全部规则包在 @media (max-width: 768px) 内，桌面不受影响。
const patchRaw = (process.env.MOBILE_CSS_PATCH ?? 'true').trim().toLowerCase()
const MOBILE_PATCH = !(patchRaw === 'false' || patchRaw === '0' || patchRaw === 'no')

const tooLargePayload = () => ({
  statusCode: 413,
  code: 'FST_ERR_CTP_BODY_TOO_LARGE',
  error: 'Payload Too Large',
  message: 'Request body is too large',
})

// preParsing 计数流超限时抛出该标记，经 reply-from onError 按 message 识别映射 413
const BODY_TOO_LARGE_MARK = 'DSH_GATEWAY_BODY_TOO_LARGE'

const app = Fastify({
  logger: true,
  bodyLimit: BODY_LIMIT,
  // WS downlink 长连接空闲挂起：默认 300s 请求超时会掐断，置 0 关闭。
  connectionTimeout: 0,
  requestTimeout: 0,
})

if (!AUTH_TOKEN || AUTH_TOKEN.length < 32) {
  console.error('[dsh-gateway] AUTH_TOKEN 未配置或过短：需 ≥128 bit 随机 token（≥32 个字符），例如 `openssl rand -hex 16`')
  process.exit(1)
}
if (!COOKIE_SECURE) {
  app.log.warn('AUTH_COOKIE_SECURE=false：cookie Secure 标志已显式降配关闭，仅限 HTTP 回环/可信内网，切勿暴露到不可信网络')
}

// 比较一律对摘要做恒定时间，明文不比较、不落日志；cookie 值存 sha256(token) 的 hex，
// 校验时对其再取摘要比较。
const sha256 = (s) => createHash('sha256').update(s).digest()
const tokenDigest = sha256(AUTH_TOKEN)
const expectedCookieDigest = sha256(tokenDigest.toString('hex'))
const tokenOk = (t) => typeof t === 'string' && t.length > 0 && timingSafeEqual(sha256(t), tokenDigest)
const cookieOk = (v) => typeof v === 'string' && v.length > 0 && timingSafeEqual(sha256(v), expectedCookieDigest)

const readAuthCookie = (req) => {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim()
  }
  return undefined
}

// 认证中间件：onRequest 对 http-proxy 通配路由与 WS upgrade 路由同样生效。
app.addHook('onRequest', (req, reply, done) => {
  if ((req.raw.url ?? '').split('?')[0] === '/login') return done()
  if (cookieOk(readAuthCookie(req))) return done()
  reply.code(401).type('text/plain; charset=utf-8').send('unauthorized: missing or invalid auth cookie')
})

// 登录端点限流（固定窗口，按 IP）
const loginAttempts = new Map()
const loginRateLimited = (ip) => {
  const now = Date.now()
  let e = loginAttempts.get(ip)
  if (!e || now >= e.resetAt) {
    e = { count: 0, resetAt: now + LOGIN_RATE_WINDOW_MS }
    loginAttempts.set(ip, e)
  }
  e.count++
  return e.count > LOGIN_RATE_MAX
}

// 上游 160 MiB 上限在网关侧对等强制：fastify 的 bodyLimit 对流式透传不生效
//（content-type parser 仅对默认 parser 检查 limit），需手动两道闸：
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

// 栅栏改写（HTTP 反代与 WS upgrade 共用）：Host 钉到上游回环地址，剥离
// Origin 与 Sec-Fetch-*（浏览器自带的 Origin 与上游 Host 不一致会 403）。
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

// --- 事件流 WS 透传 ----------------------------------------------------------
// /api/events.mux 与 /api/events.host 为纯下行 WS：网关作为 ws 客户端连上游同路径，
// 双向逐帧转发。上行帧上游会回 close(1008) 'downlink only'，该行为原样保留。
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
  // 栅栏改写同 HTTP 反代；另剥离客户端握手头，由 ws 客户端自行生成
  const headers = rewriteHeaders(req.headers)
  for (const key of Object.keys(headers)) {
    if (key === 'connection' || key === 'upgrade' || key.startsWith('sec-websocket-')) delete headers[key]
  }
  const protocols = req.headers['sec-websocket-protocol']
  const upstream = new WebSocket(`${upstreamWsBase}${path}`, protocols ?? [], {
    headers,
    maxPayload: WS_MAX_PAYLOAD,
    perMessageDeflate: false,
  })

  upstream.on('message', (data, isBinary) => {
    if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(data, { binary: isBinary })
  })
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
    // 非 upgrade 的普通 GET：镜像上游行为（上游 web 面无 SSE 回退，恒 426）
    reply.code(426).type('text/plain; charset=utf-8').send('upgrade required')
  })
}

// --- 登录页与登录端点 --------------------------------------------------------
const LOGIN_PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh gateway · 登录</title>
<style>
body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#141414;color:#eee}
form{display:flex;flex-direction:column;gap:.75rem;width:20rem}
h1{font-size:1.1rem;margin:0}
input,button{padding:.55rem;font-size:1rem;border-radius:4px;border:1px solid #444;background:#1e1e1e;color:#eee}
button{cursor:pointer;background:#2d2d2d}
#err{color:#ff7070;min-height:1.2em;margin:0;font-size:.9rem}
</style>
</head>
<body>
<form id="f">
<h1>dsh gateway</h1>
<input id="t" type="password" placeholder="access token" autocomplete="off" autofocus>
<button type="submit">登录</button>
<p id="err"></p>
</form>
<script>
const f=document.getElementById('f'),t=document.getElementById('t'),err=document.getElementById('err');
f.addEventListener('submit',async(e)=>{
  e.preventDefault();err.textContent='';
  try{
    const r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:t.value})});
    if(r.status===204){location.href='/';return}
    err.textContent=r.status===429?'尝试过多，请稍后再试':'token 无效';
  }catch{err.textContent='网络错误'}
  t.value='';t.focus();
});
</script>
</body>
</html>
`

app.get('/login', (_req, reply) => {
  reply.type('text/html; charset=utf-8').send(LOGIN_PAGE)
})

app.post('/login', (req, reply) => {
  if (loginRateLimited(req.ip)) {
    app.log.warn({ ip: req.ip }, '登录端点限流触发，拒绝请求')
    return reply.code(429).type('application/json').send({ error: 'too many login attempts, try again later' })
  }
  if (!tokenOk(req.body?.token)) {
    app.log.info({ ip: req.ip }, '登录失败：token 不匹配')
    return reply.code(401).type('application/json').send({ error: 'invalid token' })
  }
  loginAttempts.delete(req.ip)
  const secure = COOKIE_SECURE ? '; Secure' : ''
  reply.header('set-cookie', `${COOKIE_NAME}=${tokenDigest.toString('hex')}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}${secure}`)
  return reply.code(204).send()
})

await app.register(httpProxy, {
  upstream: UPSTREAM,
  prefix: '/',
  http2: false,
  replyOptions: {
    // rewriteRequestHeaders 必须放在 replyOptions 下：@fastify/http-proxy v11 只把
    // replyOptions 透传给逐请求的 reply.from()，顶层同名选项对 HTTP 路径不生效。
    rewriteRequestHeaders: (req, headers) => {
      const out = rewriteHeaders(headers)
      // HTML 文档请求要求上游回未压缩的 200 全量正文，注入路径才能改写
      //（304 无正文可注入）；其余静态资源保持原有压缩与缓存行为。
      if (MOBILE_PATCH && typeof req.headers.accept === 'string' && req.headers.accept.includes('text/html')) {
        delete out['accept-encoding']
        delete out['if-none-match']
        delete out['if-modified-since']
      }
      return out
    },
    // 注入移动布局补丁。reply-from 在调用本回调前已把上游状态码与响应头复制到
    // reply，非补丁路径 reply.send(res.stream) 即默认行为。
    onResponse: (req, reply, res) => {
      const contentType = String(res.headers['content-type'] ?? '')
      if (!MOBILE_PATCH || res.statusCode !== 200 || !contentType.includes('text/html')) {
        reply.send(res.stream)
        return
      }
      // 补丁路径：HTML 文档很小（SPA 壳 ~12KB），收全量后改写。
      const chunks = []
      res.stream.on('data', (chunk) => chunks.push(chunk))
      res.stream.on('error', (err) => {
        // 响应头尚未发出：剥掉正文相关的头后以 502 收尾，客户端拿到明确错误。
        req.log.warn({ err: err.message }, '移动补丁：上游 HTML 流读取失败')
        reply.removeHeader('content-encoding')
        reply.removeHeader('content-length')
        reply.code(502).type('text/plain; charset=utf-8').send('gateway: upstream html stream error')
      })
      res.stream.on('end', () => {
        const raw = Buffer.concat(chunks)
        // 非 UTF-8 文档改写会破坏编码：透传不注入
        const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]
        if (charset !== undefined && !/^utf-?8$/i.test(charset)) {
          req.log.warn({ charset }, '移动补丁：HTML 非 UTF-8，原样透传')
          reply.send(raw)
          return
        }
        // 文档请求已剥 accept-encoding，正常为 identity；上游仍压缩时解压再改写
        let buf = raw
        const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase()
        try {
          if (enc === 'gzip') buf = gunzipSync(buf)
          else if (enc === 'br') buf = brotliDecompressSync(buf)
          else if (enc === 'deflate') buf = inflateSync(buf)
          else if (enc !== '' && enc !== 'identity') throw new Error(`unknown content-encoding: ${enc}`)
        } catch (err) {
          // 解压失败则原始字节透传（原 content-encoding/content-length 仍匹配），不注入
          req.log.warn({ err: err.message }, '移动补丁：HTML 解压失败，原样透传')
          reply.send(raw)
          return
        }
        reply.removeHeader('content-encoding')
        reply.removeHeader('content-length')
        // 正文已改写，原校验器失效：避免客户端攒下错误 etag/last-modified
        reply.removeHeader('etag')
        reply.removeHeader('last-modified')
        reply.send(patchHtml(buf.toString('utf8')))
      })
    },
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
