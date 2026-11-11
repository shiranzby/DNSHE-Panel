# Issue #3：添加 DNSHE API 时 HTTP 520

## 结论与边界

### 2026-11-12 复核

重新读取 issue，仍为原始 520 报告，没有补充评论。按授权生成一组随机无效 Key/Secret：

| 路径 | 实测结果 |
| --- | --- |
| 本地直连 `quota` | HTTP 401，`auth_invalid_credentials`，JSON |
| 本地直连 `keys/list` | HTTP 401，`auth_invalid_credentials`，JSON |
| 已部署 Workers 添加账号 | 面板 HTTP 400，`auth_invalid_credentials`，未新增账号 |

生产路径只提交一次无效绑定测试，前后账号 ID 集合一致，独立诊断会话已注销。没有使用真实 DNSHE 凭据，也没有注册域名。公开脚本 `node scripts/diagnose-dnshe-invalid-key.mjs --live-readonly` 仅重现前两项；生产路径操作与证据保留在仓库外，不把个人实例或登录配置公开。

这证明当前错误凭据有正常的拒绝路径，未重现原 520。原故障仍可能属于上游边缘／回源或特定出口的暂时异常，不能仅凭截图断言是哪一层；也不应将“换密钥”当作已证实解法。本轮配额缓存修复针对创建域名的 403，与添加账号 520 分开处理。未评论或关闭 issue。

[原始 issue](https://github.com/shiranzby/DNSHE-Panel/issues/3) 的截图为“无法验证 API 密钥有效性: HTTP error! status: 520”。报错来自面板服务端调用 DNSHE 校验接口，不是浏览器直接调用 DNSHE，也不是面板登录失败。

Cloudflare 将 520 定义为源站返回空、未知或异常响应。源站异常、回源协议问题、出口或防火墙限制都是可能原因；截图不足以确定其中哪一个，也不能证明密钥无效。参考 [Cloudflare 官方 520 说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-520/)。

尚未访问报告者的 Worker 日志、DNSHE 侧日志或凭据。本地用合成响应复现了相同错误路径，但没有复现报告者所在网络的真实 520；不将本地诊断修正宣称为 DNSHE 源站故障已修复。

## 为什么 curl 可用、面板不一定可用

```text
浏览器 → 用户的面板 Worker → api005.dnshe.com → DNSHE 应用
本地 curl ────────────────→ api005.dnshe.com → DNSHE 应用
```

两个请求的出口、链路和可能的接口不同。未填写账号别名时面板调用 `keys/list` 获取名称；填写别名时调用 `quota`。对方的 curl 未说明具体端点，不能当成等价验证。上游请求若在边缘或回源阶段失败，可能不会进入 DNSHE 的 API 计数逻辑，“无调用记录”不等于面板从未发出请求。

DNSHE 主 API 使用 `m=domain_hub` 与 `X-API-Key` / `X-API-Secret`，不要混用 `m=dns` 的单 Bearer Token 或 DDNS Token。参见 [DNSHE 官方 API 文档](https://github.com/dnshe/DNSHE-FreeDomains/blob/main/docs/api.md)。

## 排查顺序

1. 在浏览器开发者工具中，只记录 `/api/accounts` 的响应状态与错误正文；不要公开请求载荷或 Authorization。旧版面板可能把上游 520 包装成自己的 HTTP 400，应以错误正文中的上游状态为准。
2. 使用同一组凭据，在本地或计划用于 Docker 的主机上分别比较 `keys/list` 和 `quota`，不是只测试另一条查询接口。
3. 记录发生时间与时区、接口、HTTP 状态和 Cloudflare Ray ID。520 本身不能证明“Workers IP 被封”，需要 DNSHE 核查边缘与源站日志。
4. 若 `quota` 正常而 `keys/list` 不正常，尝试填写别名绑定。这只更换只读校验端点，不跳过密钥验证。两者都异常则不可用“跳过验证”掩盖。
5. 若确认只有 Workers 路径持续失败，可选一台已验证能访问 API 的主机，按 README 使用 Docker。仅换一个前端域名不改变 Worker 对上游的调用路径；更换面板自己的 SSL 模式也不能保证解决上游 520。

主机侧只读配额检查（先在本地环境中设置凭据，不把真实值粘贴进命令记录或 issue）：

```bash
curl --silent --show-error --max-time 15 --dump-header - \
  'https://api005.dnshe.com/index.php?m=domain_hub&endpoint=quota' \
  -H "X-API-Key: ${DNSHE_API_KEY}" \
  -H "X-API-Secret: ${DNSHE_API_SECRET}"
```

不要上传未经脱敏的 `curl -v`、HAR 或部署环境变量；`keys/list` 的成功响应也可能包含完整 API Key。

## 代码修正

- 收到 520/其它 5xx 响应头后取消错误页正文，返回上游不可用诊断，保留接口和格式受限的 Ray ID，不透传上游 HTML，也不因等待错误页而把已知 520 改成普通超时。
- 绑定与更换凭据保留上游错误码，区分网络失败、超时、IP 白名单与凭据拒绝。上游 401 不会让面板会话被错误注销。
- 两种绑定校验均有 8 秒超时；不增加盲目重试、不换陌生代理，也不关闭校验。
- 修复命名账号的校验漏洞：HTTP 200 的 HTML、缺失布尔 `success` 或 `success:false` 不再被当作验证成功。
- 校验失败零账号写入；更换凭据失败保留原账号、别名与密文。
- 注册路径同样保留 V2 错误码、HTTP 状态、响应类型和 Ray ID，失败写脱敏日志；403/429 不盲目回退旧接口重试写入。上游消息回显的凭据被替换，不保存完整错误页。

验证：`npm run test:accounts:binding`，当前 37/37 通过，含绑定、注册诊断与配额时效反例；Docker 构建已加入此项闸门。回归使用本地夹具与内存 SQLite，不使用真人凭据。历史版本 23/23 通过后，用户曾另行授权在自用实例部署诊断并尝试一个指定域名；该次实网请求收到 520，独立只读查询确认域名未注册、配额未变。未向 issue 发消息或关闭问题。

自有环境的对照结果为：同一凭据在本地读取 WHOIS/配额成功，Workers HKG 路径却收到 520。这支持“访问路径存在差异”，不等于已经证明 DNSHE 源站故障或刻意屏蔽，也不能替代报告者自己的日志。无凭据的公共 WHOIS 当前可能要求认证，不应再假定匿名查询一定可用。

## 可交给部署 AI 的指令

> 请按 DNSHE-Panel 当前 README 排查“添加账号时报上游 HTTP 520”。先区分面板自己的响应与 DNSHE 上游响应，只读检查实际使用的 keys/list 或 quota。凭据只能在我的本地环境中使用，禁止输出、上传或发给第三方代理。记录脱敏的时间、HTTP 状态、错误码与 Ray ID。不要把 520 当成密钥无效；不要禁用鉴权、清空 D1/KV、删除数据卷或重新生成 AES_KEY。若能确认 Workers 路径持续失败而某台主机的同端点测试成功，再提出 Docker 方案；业务数据迁移和切换生产入口必须另外确认。

AI 可以帮助核对部署和整理诊断，但无法保证绕过上游网络故障或替 DNSHE 修复源站。

## 可回复 issue 的摘要（尚未发送）

> 感谢反馈，已检查截图。这里的 HTTP 520 是面板调用 DNSHE 校验接口时收到的上游错误，不等同于 Key/Secret 无效。上游请求可能在进入 API 计数逻辑之前失败，因此“DNSHE 无调用记录”和这个错误并不矛盾。
>
> 仓库已改进这条错误链：区分上游错误、网络超时和凭据拒绝，保留接口与可用的 Ray ID，并修复了异常响应可能误通过校验的问题。更新代码并重新部署后可以得到更明确的诊断，但不能保证上游 520 随之消失。
>
> 请先比较本地 curl 与面板是否调用同一端点：未填写别名时使用 keys/list，填写别名时使用 quota。如果只有 keys/list 失败而 quota 正常，可以先填写别名绑定，仍会执行密钥校验。如果还有问题，请补充脱敏后的报错时间/时区、接口和 Ray ID，不要提供 Key、Secret、会话 Token 或完整 HAR。
>
> 本地与 Workers 的出口不同，目前还不能确定是 DNSHE 源站异常还是特定出口链路受限。若确认 Workers 持续失败，而另一台主机的同端点测试成功，可以考虑按 README 用 Docker 部署；也可以让 AI 按排查文档辅助核对配置，但不建议关闭鉴权、清库或反复更换密钥。
