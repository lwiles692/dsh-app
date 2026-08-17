#!/usr/bin/env bash
# verify-upstream.sh — dsh 上游协议/栅栏行为回归验证（升级上游版本后必跑）。
#
# Pin（部署脚本与 vendor/ 必须与此一致）：
#   repo    https://github.com/deepseek-ai/deepseek-harness.git
#   commit  47f943859bef60e4160492346772ded9b24f765a   (2026-08-13, master HEAD)
#   版本号  @deepseek-ai/dsh 0.1.0-rc.5（apps/cli/package.json 内树版本）
# 重新获取：git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git vendor/deepseek-harness
#          （上游无 git tag，depth 1 克隆的 master HEAD 即上述 commit；换版本时把 commit 换进来并更新本常量）
#
# 覆盖断言（实测基准 2026-08-16，本机 Linux，Node 24）：
#   - RPC 单段点号路径 POST /api/<method>，envelope {type:'client-request',rpcId,method,payload}
#   - 业务错误恒 200 + {ok:false,error:{code,message}}；carrier 层 404/415/400
#   - WS 下行文本帧（每帧一个完整 JSON server-request）；客户端发帧 → close(1008)
#   - SSE：web 传输面 GET /api/events.{mux,host} 返回 426（web 面强制 WebSocket，
#     SSE 仅存在于 apiproxy fetch handler）
#   - 信任栅栏：Host 回环 / Origin 一致性 / Sec-Fetch-Site / 非 JSON POST 415
#   - PRIVILEGED_METHODS 清单（15 个，源码固化）
#
# 用法：scripts/verify-upstream.sh    （需 vendor/deepseek-harness 已 pnpm install && pnpm run build）
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor/deepseek-harness"
PINNED_COMMIT="47f943859bef60e4160492346772ded9b24f765a"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$1"; }
# assert <name> <actual> <expected>
assert() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$3], got [$2])"; fi; }
# assert_body <name> <body-file> <substring>
assert_body() { if grep -qF "$3" "$2"; then ok "$1"; else bad "$1 (missing [$3] in $(cat "$2"))"; fi; }

# --- 前置检查 ---------------------------------------------------------------
if [ ! -f "$VENDOR/apps/cli/lib/bin.js" ]; then
  echo "error: $VENDOR 未构建。先执行：cd vendor/deepseek-harness && pnpm install && pnpm run build" >&2
  exit 2
fi
if [ -d "$VENDOR/.git" ]; then
  HEAD=$(git -C "$VENDOR" rev-parse HEAD)
  assert "vendor pinned commit" "$HEAD" "$PINNED_COMMIT"
fi

# --- 自启 dsh web（--port 0，OS 分配端口，日志里解析） -----------------------
LOG=$(mktemp); BODY=$(mktemp); WS_DIR=""
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$WS_DIR" ] && rm -rf "$WS_DIR"
  rm -f "$LOG" "$BODY"
}
trap cleanup EXIT

node "$VENDOR/apps/cli/lib/bin.js" web --port 0 >"$LOG" 2>&1 &
SERVER_PID=$!
BASE=""
for _ in $(seq 1 60); do
  BASE=$(grep -oE 'http://127\.0\.0\.1:[0-9]+' "$LOG" | head -1 || true)
  [ -n "$BASE" ] && break
  sleep 0.5
done
if [ -z "$BASE" ]; then echo "error: dsh web 未起来，日志："; cat "$LOG"; exit 2; fi
ok "dsh web started at $BASE"

# --- RPC 协议面 -------------------------------------------------------------
J='content-type: application/json'
env_body() { printf '{"type":"client-request","rpcId":"%s","method":"%s","payload":%s}' "$1" "$2" "$3"; }

code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$BASE/api/host.describe" -H "$J" -d "$(env_body t1 host.describe '{}')")
assert "RPC 单段点号路径 POST /api/host.describe -> 200" "$code" 200
assert_body "envelope 响应 type=server-response" "$BODY" '"type":"server-response"'
assert_body "envelope 响应 rpcId 回显" "$BODY" '"rpcId":"t1"'
assert_body "envelope 响应 result.ok=true" "$BODY" '"ok":true'

code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$BASE/api/host.describe" -H "$J" -d "$(env_body t2 session.list '{}')")
assert "业务错误恒 200（method/path 不匹配）" "$code" 200
assert_body "业务错误 {ok:false,error.code=bad-request}" "$BODY" '"ok":false,"error":{"code":"bad-request"'

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/no.such" -H "$J" -d "$(env_body t3 no.such '{}')")
assert "未知方法 -> 404（carrier 层）" "$code" 404

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/host.describe" -H 'content-type: text/plain' -d "$(env_body t4 host.describe '{}')")
assert "非 JSON POST -> 415" "$code" 415

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/host.describe" -H "$J" -d 'not json')
assert "JSON content-type 但 body 非 JSON -> 400" "$code" 400

# --- 信任栅栏 ---------------------------------------------------------------
D="$(env_body f1 host.describe '{}')"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/host.describe" -H 'Host: evil.com' -H "$J" -d "$D")
assert "栅栏: 非回环 Host -> 403" "$code" 403
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/host.describe" -H 'Host: 127.1' -H "$J" -d "$D")
assert "栅栏: 回环简写 Host 127.1 -> 200" "$code" 200
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/host.describe" -H "Host: localhost:${BASE##*:}" -H "$J" -d "$D")
assert "栅栏: localhost:<port> -> 200" "$code" 200
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/host.describe" -H 'Sec-Fetch-Site: cross-site' -H "$J" -d "$D")
assert "栅栏: Sec-Fetch-Site cross-site -> 403" "$code" 403
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/host.describe" -H 'Sec-Fetch-Site: same-origin' -H "$J" -d "$D")
assert "栅栏: Sec-Fetch-Site same-origin -> 200" "$code" 200
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/host.describe" -H 'Origin: http://evil.com' -H "$J" -d "$D")
assert "栅栏: Origin 与 Host 不一致 -> 403" "$code" 403
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/host.describe" -H "Origin: $BASE" -H "$J" -d "$D")
assert "栅栏: Origin 与 Host 一致 -> 200" "$code" 200
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/host.describe" -H 'Origin: null' -H "$J" -d "$D")
assert "栅栏: Origin null -> 403" "$code" 403

# 特权方法：回环可达；非回环 Host 双重拒绝（普通栅栏 + 特权钉回环）
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/settings.describe" -H "$J" -d "$(env_body p1 settings.describe '{}')")
assert "特权方法 settings.describe 回环可达 -> 200" "$code" 200
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/settings.describe" -H 'Host: evil.com' -H "$J" -d "$(env_body p2 settings.describe '{}')")
assert "特权方法 settings.describe 非回环 Host -> 403" "$code" 403

# --- SSE：web 传输面实际为 426（SSE 不在 web 面暴露） -------------------------
code=$(curl -s -o "$BODY" -w '%{http_code}' --max-time 5 "$BASE/api/events.host")
assert "GET /api/events.host -> 426（web 面无 SSE 回退）" "$code" 426
assert_body "426 响应体 upgrade required" "$BODY" 'upgrade required'
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/events.mux")
assert "GET /api/events.mux -> 426（web 面无 SSE 回退）" "$code" 426

# --- WS：下行文本帧 / 客户端帧 1008 / 栅栏适用于 upgrade ----------------------
WS_DIR=$(mktemp -d)
BASE="$BASE" WS_DIR="$WS_DIR" node --input-type=module <<'EOF'
const base = process.env.BASE
const wsBase = base.replace(/^http/, 'ws')
const fail = (msg) => { console.log(`FAIL ${msg}`); process.exitCode = 1 }
const ok = (msg) => console.log(`ok   ${msg}`)
const post = (method, payload, rpcId) => fetch(`${base}/api/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
}).then(r => r.json())

// 1) 客户端发帧 -> close(1008)
{
  const ws = new WebSocket(`${wsBase}/api/events.host`)
  const done = new Promise(res => {
    ws.onopen = () => ws.send('ping')
    ws.onclose = (e) => res(e.code === 1008 ? ok('WS 客户端发帧 -> close(1008)') : fail(`WS 客户端发帧 close code=${e.code}`))
    ws.onerror = () => {}
  })
  await Promise.race([done, new Promise(res => setTimeout(() => res(fail('WS 1008 断言超时')), 5000))])
}

// 2) 栅栏适用于 WS upgrade（evil Host 被拒）
{
  const ws = new WebSocket(`${wsBase}/api/events.host`, { headers: { Host: 'evil.com', Origin: 'http://evil.com' } })
  const done = new Promise(res => {
    ws.onopen = () => res(fail('WS upgrade 带 evil Host 却被接受'))
    ws.onerror = () => res(ok('WS upgrade 带 evil Host -> 拒绝'))
  })
  await Promise.race([done, new Promise(res => setTimeout(() => res(fail('WS 栅栏断言超时')), 5000))])
}

// 3) 下行纯文本帧：开 mux downlink，建 workspace+session 触发帧，逐帧须为可解析 JSON
{
  const ws = new WebSocket(`${wsBase}/api/events.mux`)
  let frames = 0, allTextJson = true
  ws.onmessage = (e) => {
    frames++
    if (typeof e.data !== 'string') { allTextJson = false; return }
    try {
      const p = JSON.parse(e.data)
      if (p.type !== 'server-request') allTextJson = false
    } catch { allTextJson = false }
  }
  const opened = new Promise(res => { ws.onopen = res })
  await Promise.race([opened, new Promise(res => setTimeout(res, 5000))])
  if (ws.readyState !== WebSocket.OPEN) fail('WS mux downlink 未打开')
  else {
    const w = await post('workspace.create', { path: process.env.WS_DIR, name: 'verify-probe' }, 'v-wc')
    if (!w.result.ok) fail(`workspace.create 失败: ${w.result.error?.message}`)
    else {
      const list = await post('workspace.list', {}, 'v-wl')
      const id = list.result.value.items.find(i => i.path === process.env.WS_DIR)?.workspaceId
      const s = id && await post('session.create', { workspaceId: id }, 'v-sc')
      if (!s?.result?.ok) fail(`session.create 失败: ${JSON.stringify(s?.result?.error)}`)
      await new Promise(res => setTimeout(res, 3000))
      if (id) await post('workspace.delete', { workspaceId: id }, 'v-wd')
      if (frames > 0 && allTextJson) ok(`WS 下行纯文本帧（${frames} 帧，每帧一个完整 JSON server-request）`)
      else if (frames === 0) fail('WS mux 未收到任何下行帧')
      else fail('WS 下行帧含非文本/非 server-request 帧')
    }
  }
}
process.exit(process.exitCode ?? 0)
EOF
[ $? -eq 0 ] || FAIL=$((FAIL+1))

# --- PRIVILEGED_METHODS 清单（源码固化，15 个） -------------------------------
VENDOR="$VENDOR" node --input-type=module <<'EOF'
import { readFileSync } from 'node:fs'
const src = readFileSync(`${process.env.VENDOR}/packages/client/connection/src/index.ts`, 'utf8')
const m = src.match(/PRIVILEGED_METHODS = new Set\(\[([\s\S]*?)\]\)/)
const actual = m ? [...m[1].matchAll(/'([a-zA-Z.]+)'/g)].map(x => x[1]).sort() : []
const expected = [
  'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.read', 'agentPreset.remove',
  'credentials.describe', 'credentials.set', 'credentials.unset',
  'host.openPath', 'host.pickDirectory', 'llm.discoverModels',
  'settings.describe', 'settings.mutate', 'settings.openDocument', 'settings.replace', 'settings.update',
].sort()
const same = actual.length === expected.length && actual.every((v, i) => v === expected[i])
if (same) console.log(`ok   PRIVILEGED_METHODS 清单一致（${actual.length} 个）`)
else {
  console.log(`FAIL PRIVILEGED_METHODS 漂移: actual=[${actual.join(',')}] expected=[${expected.join(',')}]`)
  process.exit(1)
}
EOF
[ $? -eq 0 ] || FAIL=$((FAIL+1))

# --- 汇总 -------------------------------------------------------------------
echo "---"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
