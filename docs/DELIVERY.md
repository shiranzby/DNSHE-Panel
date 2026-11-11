# 当前交付

## 当前状态

2026-11-12：修复注册页使用旧配额的问题。进入注册／配额页强制回源；概览、域名、账号等工作面先显示本地快照，再后台增量同步，60 秒内合并重复触发，后台每轮最多接力三批。手动域名同步和概览刷新同时更新配额与统计；已有列表在后台读取时保留。服务端配额仅复用 60 秒内且账号集合完整的成功结果，旧格式缓存自动失效。

创建前实时校验目标账号；用尽时返回 `quota_exceeded`，不发创建请求。创建成功后仅回填目标账号配额与新域名；创建失败也刷新目标账号。若校验与创建之间耗尽配额，优先提示用尽，不误报后缀任务。客户端成功／失败后均刷新配额、列表与概览，写入后的强制刷新不会被写入前的在途读取吞掉。配额不可读不视为有余额，也不盲目重试注册。此前本地四后缀任务提示一并纳入，明确凭据错误与 520 保留原诊断。

定向回归：绑定／注册 37/37、注册／DDNS 界面 19/19；覆盖旧缓存、用尽零创建、校验后耗尽、读取失败、注册成功后更新与重新进页。阶段回归：工作面 14/14、委派 16/16、续期 8/8、SQLite 22/22、local KV 4/4、预览隔离 9/9、鉴权日志 6/6；Worker/Node 类型、Node 构建、前端自建／Pages 构建通过，Pages 13/13 路由无外部请求与页面错误。已目视注册用尽与配额更新截图。用户授权同步仓库并运行 GitHub 构建；生产自动部署保持禁用，不部署生产、不执行真实注册、不评论 issue。

issue #3 实网复核：随机无效凭据在本地 `quota`、`keys/list` 均返回 401 `auth_invalid_credentials`；经已部署 Workers 的添加账号接口也被正常拒绝，账号 ID 集合未变，诊断会话已注销。此次未重现 520，不能证明报告者当时的故障已修复。详见 [排查说明](issues/3-account-binding-520.md)。私有实例地址与完整证据不进入公开仓库。

### 已发布诊断

2026-11-03：issue #3 的上游错误分类与绑定校验修复已推送；用户随后针对自用实例注册 403 明确授权添加诊断、部署生产，并尝试一个指定域名。注册路径现保留 HTTP 状态、错误码、接口与 Ray ID，失败写脱敏日志，不再丢失 V2 错误信息。生产后端诊断已部署，前端资源指纹与原版一致，D1/KV/AES Secret/定时配置未变，无数据库迁移。未直接评论或关闭 issue。排查与回复草稿见 [issue #3](issues/3-account-binding-520.md)。

实网对照：同一账号凭据由本地进程调用 WHOIS/配额成功，经 Workers HKG 路径调用 WHOIS/配额/注册时返回上游 520。指定域名只提交一次注册请求，之后通过独立只读查询确认仍未注册、配额未变。原截图 403 未重现，不能断言其与本次 520 的具体原因相同；报告者的网络问题也没有被宣称已修复。域名、账号与完整实网证据只留在仓库外。

本轮绑定/注册诊断定向回归为 23/23（初版绑定 15 项，新增注册 8 项），Docker 双架构构建包含相同闸门。阶段回归：委派 16/16、预览隔离 9/9、鉴权日志 6/6、续期规则 8/8、SQLite 22/22、local KV 4/4、用量后端 22/22（含本地 workerd）通过；Worker/Node 类型检查、Node 构建和生产前端构建通过。自动化回归的外部 API 均为合成夹具；上一段明确授权的实网注册尝试是独立证据，不能混为自动化测试。未改前端，也未将旧截图当作本轮实网复现证据。

首推 666278e 的 amd64 镜像构建已通过类型、SQLite 和绑定回归，但旧冒烟脚本的 `docker logs | grep -q` 在 `pipefail` 下提前关闭管道，误报无排程日志。已通过本地反例确认并改为完整读取日志；最终镜像交付必须等待后续 run 的双架构与清单全部成功，不能复用前一失败结论。

## 已发布基线

2026-10-22：修复注册后缓存延迟与自动续期边界，并新增独立“自动续期”工作页。注册后对上游列表做有界重试，仍未出现时通过 Worker waitUntil 继续后台重试，前端轮询本地缓存并明确显示待同步；续期成功但缺少 `new_expires_at` 不再覆盖本地旧值，已过期域名进入候选，缺少到期时间仍保持未知。本轮源码、README 与 Release 说明已整理，生产实例不重复部署。

新增定向回归：`npm run test:renewal:rules`（8/8），覆盖缺失日期、进入阈值、越过阈值、已过期及续期响应缺失字段。委派 16/16、SQLite 22/22、local KV 4/4、登录审计 6/6、预览隔离 9/9、注册/DDNS 16/16 均通过；前后端构建均通过。Pages 13/13 路由及续期三模式×两宽度通过，无外部请求和页面/控制台错误，六张深色截图已目视。真实域名注册／续期写入未执行。

2026-10-20：一键委派已改用 Cloudflare 绑定中的真实 Account ID，不再传面板账号主键。缺失标识、快照未确认、已有 Zone 归属不符或不唯一时中止，避免误修改 DNSHE 记录；客户端也校验 Account ID 格式。本轮无数据库迁移、前端改动或额外账号读取权限。

定向回归：`npm run test:delegate:cf`，真实 Worker 路由、内存 SQLite、合成外部服务 16/16 通过。另已通过 Worker／Node 类型检查、Node 构建、SQLite 22/22、local KV 4/4、权限合同 3/3、用量后端 22/22（含 workerd）、预览隔离 9/9、登录审计 6/6。真实 Cloudflare 建 Zone、DNSHE 写 NS 和公网激活不属于本轮生产只读验收；不得以离线通过宣称实际委派已完成。

注册页已加入账号配额选择约束：账号选项内显示已用／剩余或用尽状态，不额外添加规则备注；已用尽账号不可选，未知或读取失败保持独立语义，全部用尽时禁止提交。定向回归为 `npm run test:register-ddns:ui`，包含选择框与注册按钮对齐检查。

本仓库当前交付包含两条彼此隔离的路径：

1. **GitHub Pages 真实前端演示**：由 `frontend/src` 构建，使用 `VITE_STATIC_DEMO=1` 注入合成 API 响应，不连接后端。
2. **可部署产品源码**：Worker 与 Docker 自建版仍保留完整 API、D1/KV、认证和业务逻辑，部署时使用操作者自己的资源配置。

Pages 演示入口：<https://shiranzby.github.io/DNSHE-Panel/>。

## Pages 演示内容

- 真实 React 前端的 13 个 hash 路由：概览、域名列表、Cloudflare、域名助力、账号管理、API 密钥、注册查重、账户配额、动态 DNS、自动续期、CF 用量、运行日志和设置。
- 设计风、数据风、卡片风三种平级切换。
- 浅色／深色主题、侧边栏导航、页面切换和键盘可达控件。
- 所有样本数据均为合成数据；演示不读取 Cookie、Token、本地文件或远程 API。页面组件、CSS、状态和交互来自 `frontend/src`，不是独立重绘页面。

本地查看：

```powershell
$env:VITE_API_BASE_URL="/"
$env:VITE_STATIC_DEMO="1"
npm run build:pages --prefix frontend
python -m http.server 4173 --directory frontend/dist
```

然后打开 `http://127.0.0.1:4173/`。

## Docker 助力缓存修复

Docker 自建版此前在没有 Cloudflare KV 时会返回“未绑定 ASSIST_KV”。当前实现提供 SQLite-backed local KV：

- 启动时自动把本地 KV 注入 `ASSIST_KV`；
- 数据写入自建版 SQLite，并随挂载的 `/data` 目录持久化；
- 不需要为 Docker 自建版额外创建 Cloudflare KV；
- Cloudflare Workers 仍按自己的 `wrangler.toml` 配置 `ASSIST_KV` namespace。

相关回归：

```powershell
npm run test:local-kv
npm run build:node
npm run verify:node
```

## 验收边界

- Pages 构建与后端构建分别验证，不能把真实前端的合成 API 适配器当作已配置的后端实例。
- 业务写入、登录会话、数据库、KV 和外部凭据不随 Pages 发布。
- 真实部署前应复制 `.env.example`，创建自己的 D1/KV，注入自己的密钥，并在隔离环境完成读写验证。
- 前端界面回归使用合成数据；任何真实账号验收都应明确限定为只读并与日用实例隔离。

## 当前验证命令

```powershell
git diff --check
npm run test:delegate:cf
npm run test:renewal:rules
npm run test:accounts:binding
npm run test:local-kv
npm run build:node
npm run verify:node
npm run build:selfhost --prefix frontend
npm run build:pages --prefix frontend
```

Pages 工作流安装 `frontend` 依赖，使用 `VITE_STATIC_DEMO=1` 构建真实前端，再上传 `frontend/dist`。
