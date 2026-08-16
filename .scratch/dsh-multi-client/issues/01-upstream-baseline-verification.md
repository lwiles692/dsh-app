# 01 — 上游基线验证与回归脚本

**What to build:** 浅克隆上游 deepseek-harness 到 `vendor/`（pin 到选定版本 tag），确认可构建可运行；通过抓报文与 curl 实验核实并固化协议事实：RPC 单段点号路径（`POST /api/<method>`）、envelope 与恒 200 响应、WS 纯下行文本帧、SSE 回退存在、信任栅栏行为（Host 回环/Origin 一致性/Sec-Fetch-Site/415）、`PRIVILEGED_METHODS` 清单。产出一个可重复运行的验证脚本，后续每次升级上游版本后必跑。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 上游浅克隆到 `vendor/` 并 `pnpm install && pnpm run build` 通过，`dsh web` 本地可起
- [ ] 抓报文核对 RPC 路径格式、envelope、恒 200、WS 文本帧、SSE 回退，与方案调研结论一致（不符则记录实际行为）
- [ ] curl 验证栅栏：Host 改写、Origin 一致性、Sec-Fetch-Site、非 JSON POST 的 415
- [ ] 验证脚本固化以上断言 + 17 个特权方法清单，重复运行结果稳定
- [ ] 记录本次验证通过的上游精确版本号（供部署 pin 用）
