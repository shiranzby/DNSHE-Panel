# 当前交付

## 当前状态

2026-11-03：审查 issue #3 截图，确认错误来自 DNSHE 上游 HTTP 520；报告者的实际网络根因仍需接口、时间与 Ray ID，不能声称已修复对方的回源/出口问题。新增上游错误分类与绑定校验反例，修复填写别名时 HTTP 200 异常响应可能误通过校验的问题。两条绑定路径及更换凭据均有校验超时，失败不写账号、换凭据失败保旧。用户随后授权完善并推送源码、拟定回复；不部署生产、不直接评论或关闭 issue。排查与回复草稿见 [issue #3](issues/3-account-binding-520.md)。

本轮绑定定向回归为 15/15，新增“收到 520 后取消挂起错误页正文”反例；Docker 双架构构建加入相同闸门。阶段回归：委派 16/16、预览隔离 9/9、鉴权日志 6/6、续期规则 8/8、SQLite 22/22、local KV 4/4、用量后端 22/22（含本地 workerd）通过；Worker/Node 类型检查与 Node 构建通过。外部 API 均为合成夹具，未使用真人凭据或远端业务写入。未改前端，也未将旧截图或生产版本当作本轮实网复现证据。

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
