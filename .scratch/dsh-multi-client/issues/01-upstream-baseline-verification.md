# 01 — 上游基线验证与回归脚本

**What to build:** 浅克隆上游 deepseek-harness 到 `vendor/`（pin 到选定版本 tag），确认可构建可运行；通过抓报文与 curl 实验核实并固化协议事实：RPC 单段点号路径（`POST /api/<method>`）、envelope 与恒 200 响应、WS 纯下行文本帧、SSE 回退存在、信任栅栏行为（Host 回环/Origin 一致性/Sec-Fetch-Site/415）、`PRIVILEGED_METHODS` 清单。产出一个可重复运行的验证脚本，后续每次升级上游版本后必跑。

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 上游浅克隆到 `vendor/` 并 `pnpm install && pnpm run build` 通过，`dsh web` 本地可起
- [x] 抓报文核对 RPC 路径格式、envelope、恒 200、WS 文本帧、SSE 回退，与方案调研结论一致（不符则记录实际行为）
- [x] curl 验证栅栏：Host 改写、Origin 一致性、Sec-Fetch-Site、非 JSON POST 的 415
- [x] 验证脚本固化以上断言 + 17 个特权方法清单，重复运行结果稳定
- [x] 记录本次验证通过的上游精确版本号（供部署 pin 用）

## Comments

### 完成内容（2026-08-16）

- 上游地址确认：`docs/plans/dsh-multi-client-plan.md` 已记录为 <https://github.com/deepseek-ai/deepseek-harness>（npm 包 `@deepseek-ai/dsh`，CLI `dsh`）。**上游 GitHub 无任何 git tag**，故 pin 到 master HEAD commit `47f943859bef60e4160492346772ded9b24f765a`（2026-08-13，与调研文档同源）；树内版本号 `@deepseek-ai/dsh 0.1.0-rc.5`（`apps/cli/package.json`）。
- 浅克隆到 `vendor/deepseek-harness`（约 85MB）。**vendor 源码不入库**（已加 `.gitignore`）：体积大且均可从上游重现；pin（URL+commit）固化在 `scripts/verify-upstream.sh` 头部常量，脚本运行时会校验 vendor HEAD 与 pin 一致。重新获取命令见脚本头注释。
- `pnpm install`（19.6s，pnpm 11.7.0）与 `pnpm run build`（exit 0）通过；`node apps/cli/lib/bin.js web` 正常起服务（`dsh web: http://127.0.0.1:3080`）。
- 产出回归脚本 `scripts/verify-upstream.sh`：自启 `dsh web --port 0`（OS 分配端口，日志解析），跑 24 项断言后自清理。**连续运行两次均 pass=24 fail=0**，结果稳定。

### 协议事实结论（实测，与调研预期对照）

符合预期：
- RPC 单段点号路径 `POST /api/host.describe` → 200；envelope 请求 `{type:'client-request',rpcId,method,payload}`，响应 `{type:'server-response',rpcId,result:{ok,value}}`，rpcId 回显。
- 业务错误恒 200：method/path 不匹配返回 200 + `{ok:false,error:{code:'bad-request',...}}`；未知方法 404、非 JSON body 400 属 carrier 层。
- 信任栅栏（curl 实测）：非回环 Host 403；`Host: 127.1` 与 `localhost:<port>` 200；`Sec-Fetch-Site: cross-site` 403 / same-origin 200；Origin 与 Host 不一致 403 / 一致 200 / `Origin: null` 403；非 JSON POST 415。栅栏同样作用于 WS upgrade（evil Host 的 upgrade 被拒）。
- WS 下行纯文本帧：开 mux downlink 后建 workspace+session 触发 7 帧，逐帧均为可解析 JSON `{type:'server-request',rpcId,method,payload}`；客户端发帧 → `close(1008, 'downlink only')`。
- 特权方法钉回环：`settings.describe` 回环 200、非回环 Host 403（双重栅栏）。

**与调研预期不符（以实际为准，已固化进脚本）：**
1. **`PRIVILEGED_METHODS` 实际 15 个，非调研文档所称 17 个**（`packages/client/connection/src/index.ts:89-119` 实数）：`agentPreset.{read,copy,openDocument,remove}`、`host.{pickDirectory,openPath}`、`settings.{describe,openDocument,update,replace,mutate}`、`credentials.{describe,set,unset}`、`llm.discoverModels`。
2. **web 传输面不存在 SSE 回退**：`GET /api/events.mux` 与 `GET /api/events.host` 实测返回 **426 `upgrade required`**（`packages/client/connection/src/index.ts:150-155` 显式拦截）。SSE 实现（`text/event-stream`）仅存在于 `packages/host/apiproxy/src/fetch/handler.ts:254-259`，供进程内 fetch carrier 使用，不暴露于 `dsh web` HTTP 面；浏览器端 `WebApiClient` 只用 WebSocket。→ **网关只需透传 WS，无需 SSE 回退通道**（影响 issue 03 范围）。

### 验证证据

- `pnpm install` → `Done in 19.6s using pnpm v11.7.0`；`pnpm run build` → exit 0（tsc -b + tsdown + vite 前端构建 `✓ built in 2.51s`）。
- `scripts/verify-upstream.sh` 两次运行均 `pass=24 fail=0`（断言清单见脚本输出：RPC/envelope/恒200/404/415/400、栅栏 9 项、特权方法 2 项、SSE 426 ×2、WS 3 项、pin commit 校验、PRIVILEGED_METHODS 15 项清单一致性）。

### 遗留问题

- 上游无 git tag，npm `0.1.0-rc.6`（2026-08-13 20:35 +0800 发布）晚于 master HEAD commit（19:38 +0800），两者对应关系未核实；部署 pin 以 commit `47f9438` 为准，升级时再核对。
- `pnpm install` 有两条无害 WARN（examples/python workspace 的 bin 链接 ENOENT），不影响构建运行。
