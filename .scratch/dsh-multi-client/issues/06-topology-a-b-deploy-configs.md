# 06 — 形态 A/B 部署配置

**What to build:** runbook 补齐另外两种拓扑：形态 A（公网 VPS 跑 Caddy+网关，WireGuard/frp 隧道回连开发机的 dsh Host，公网域名自动证书）与形态 B（单机内网，Caddy+网关+Host 同在开发机，自有域名 DNS-01 签证书或内网 CA）。各给一套 Caddyfile 与进程托管参考实现（systemd 单元 + launchd plist），隧道配置样例。网关上游地址等差异全部走配置，代码不变。

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] 形态 A 的 Caddyfile + 隧道样例 + runbook 章节齐套
- [ ] 形态 B 的 Caddyfile（DNS-01 或内网 CA）+ runbook 章节齐套
- [ ] systemd 单元与 launchd plist 两份参考实现覆盖网关与 dsh Host
- [ ] 至少其中一种形态在真实环境实测通过（视持有资源而定，记录验证的是哪种）
