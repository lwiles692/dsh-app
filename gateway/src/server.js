// dsh 多客户端网关（issue 02：骨架 + HTTP 反代）
//
// 把上游 dsh Host 的 SPA 静态文件与 /api 一元 POST 全量反向代理到 UPSTREAM。
// 过上游信任栅栏的关键（见 .scratch/dsh-multi-client/issues/01 Comments）：
//   - Host 改写为上游回环地址（默认 127.0.0.1:3080）
//   - 剥离 Origin / Sec-Fetch-* 头（上游实测：无这些头即视为可信回环请求）
// 请求体上限 160 MiB，对齐上游。本票不含认证与 WS（issue 03/04）。
import Fastify from 'fastify'
import httpProxy from '@fastify/http-proxy'
import { Transform } from 'node:stream'

const UPSTREAM = process.env.UPSTREAM ?? 'http://127.0.0.1:3080'
const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 3000)
const BODY_LIMIT = 160 * 1024 * 1024 // 160 MiB，对齐上游

const upstreamHost = new URL(UPSTREAM).host // 如 127.0.0.1:3080

const tooLargePayload = () => ({
  statusCode: 413,
  code: 'FST_ERR_CTP_BODY_TOO_LARGE',
  error: 'Payload Too Large',
  message: 'Request body is too large',
})

// 标记错误：preParsing 计数流超限时抛出，经 reply-from 包装后按 message 识别映射 413
const BODY_TOO_LARGE_MARK = 'DSH_GATEWAY_BODY_TOO_LARGE'

const app = Fastify({ logger: true, bodyLimit: BODY_LIMIT })

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

await app.register(httpProxy, {
  upstream: UPSTREAM,
  prefix: '/',
  http2: false,
  replyOptions: {
    // 注意：rewriteRequestHeaders 必须放在 replyOptions 下——@fastify/http-proxy v11
    // 只把 replyOptions 透传给逐请求的 reply.from()，顶层同名选项对 HTTP 路径不生效。
    rewriteRequestHeaders: (_req, headers) => {
      const out = { ...headers, host: upstreamHost }
      // 剥离 Origin 与 Sec-Fetch-*：上游栅栏对「无 Origin 的回环请求」放行；
      // 浏览器经网关访问时自带的 Origin（网关源）与上游 Host 不一致会 403。
      delete out.origin
      // undici 不支持 Expect: 100-continue（大 body 的 curl/HTTP 客户端会带），剥离之
      delete out.expect
      for (const key of Object.keys(out)) {
        if (key.startsWith('sec-fetch-')) delete out[key]
      }
      return out
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
