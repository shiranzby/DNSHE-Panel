import { DatabaseManager } from "./db";
import type { SubdomainInfo } from "./dnshe";
import { DNSHEClient } from "./dnshe";
import { CloudflareClient, mapZoneToUpstream } from "./cloudflare";
import { computeDnsState } from "./dns-provider";

/**
 * Cloudflare Workers 的 `connect()`。
 *
 * 🔴 这里刻意不在文件顶层静态导入 `cloudflare:sockets`：那是 Workers 专有的虚拟模块，
 *    Node 自建版打包（esbuild --platform=node）时会直接报
 *    `Could not resolve "cloudflare:sockets"` 而构建失败。改到真正发信时动态导入，
 *    并配合构建参数 `--external:cloudflare:sockets`，Node 侧即可正常打包与启动。
 */
type WorkerTlsSocket = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
};
type WorkerConnect = (
  address: { hostname: string; port: number },
  options?: { secureTransport?: "off" | "on" | "starttls"; allowHalfOpen?: boolean }
) => WorkerTlsSocket;

/**
 * Webhook 通知类型定义
 * 
 * NOTE: 支持按 WEBHOOK_TYPE 环境变量构造对应平台的规范 payload，
 * 而非同时携带所有平台的字段。
 */
export type WebhookType = "dingtalk" | "feishu" | "wecom" | "serverchan" | "custom" | "email";

/**
 * Webhook 推送结果
 *
 * NOTE: 这个函数刻意不抛异常 —— 它在 cron 里是「续期已经做完之后」的收尾步骤，
 * 推送失败不该让整个定时任务中断。所以改为回传结果供调用方决定怎么处理：
 * cron 写一条 warning 日志，测试接口把原因回给前端。
 */
export interface WebhookSendResult {
  ok: boolean;
  status?: number;
  detail?: string;
}

/**
 * 把 Server酱 的 SendKey 补全成推送端点
 *
 * 让用户只填 SendKey 就能用 —— 控制台首页给的就是一串 key，而「快速创建入口链接」
 * 那种网页地址反倒最容易被误当成推送地址（POST 上去只会回一段 MethodNotAllowed）。
 *
 * NOTE: 已经是 http(s):// 开头的一律原样透传，不做任何猜测 —— 用户可能用了自建
 * 转发或将来出现的新域名。
 * NOTE: Server酱³ 的 key 形如 sctp<uid>t<随机串>，端点带 uid 子域；Turbo 版
 * （SCT 开头，含 AppKey）统一走 sctapi.ftqq.com。认不出格式时按 Turbo 处理，
 * 失败会由平台返回明确错误码，不会静默。
 */
export function normalizeServerChanEndpoint(input: string): string {
  const v = input.trim();
  if (!v) return v;
  if (/^https?:\/\//i.test(v)) return v;
  const sc3 = v.match(/^sctp(\d+)t/i);
  if (sc3) return `https://${sc3[1]}.push.ft07.com/send/${v}.send`;
  return `https://sctapi.ftqq.com/${v}.send`;
}

/**
 * 推送 Webhook 通知
 */
export async function sendWebhookNotification(
  webhookUrl: string,
  message: string,
  webhookType: WebhookType = "custom"
): Promise<WebhookSendResult> {
  if (!webhookUrl) return { ok: false, detail: "未配置 Webhook 地址" };
  // Server酱 允许只填 SendKey，其余平台一律要求完整地址
  const endpoint = webhookType === "serverchan" ? normalizeServerChanEndpoint(webhookUrl) : webhookUrl;
  try {
    let payload: Record<string, unknown>;

    switch (webhookType) {
      case "dingtalk":
        // 钉钉机器人 Webhook 格式
        payload = {
          msgtype: "text",
          text: { content: message }
        };
        break;
      case "feishu":
        // 飞书机器人 Webhook 格式
        payload = {
          msg_type: "text",
          content: { text: message }
        };
        break;
      case "wecom":
        // 企业微信机器人 Webhook 格式
        payload = {
          msgtype: "text",
          text: { content: message }
        };
        break;
      case "serverchan":
        // Server酱（方糖）Turbo / ³ ——「标题 + 正文」两段式，与其他平台的单字段不同。
        //
        // NOTE: title 上限 32 字符，正文必须走 desp。用通用格式（text/content）虽然能通
        // （text 会被当成标题），但多行续期报告会被截成一行标题、正文全丢，所以必须单列。
        // 首行正好是「【DNSHE 域名自动续期报告】」这类摘要，拿来做标题最合适；
        // 消息本身仍完整放进 desp，不做截断。
        payload = {
          title: (message.split("\n")[0] || "DNSHE 通知").slice(0, 32),
          desp: message
        };
        break;
      case "custom":
      default:
        // 通用格式，兼容大多数 Webhook 服务
        payload = {
          text: message,
          content: message
        };
        break;
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const bodyText = (await res.text().catch(() => "")).slice(0, 500);

    if (!res.ok) {
      console.error(`Webhook push failed with status: ${res.status}`);
      return { ok: false, status: res.status, detail: bodyText || `HTTP ${res.status}` };
    }

    // NOTE: 钉钉 / 飞书 / 企业微信 / Server酱 在「token 失效」「机器人被移出群」这类
    // 错误上一律回 HTTP 200，真正的错误码藏在响应体里（钉钉与企微是 errcode/errmsg，
    // 飞书与 Server酱 是 code/message 或 code/msg）。只看 res.ok 会把这些失败当成
    // 推送成功 —— 界面显示已发送、群里什么都没有，比没有测试按钮更误导。
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const code = parsed.errcode ?? parsed.code;
      if (code !== undefined && Number(code) !== 0) {
        const reason = String(parsed.errmsg ?? parsed.msg ?? parsed.message ?? bodyText);
        console.error(`Webhook rejected by platform: ${code} ${reason}`);
        return { ok: false, status: res.status, detail: `平台返回错误 ${code}：${reason}` };
      }
    } catch {
      // 通用 Webhook 往往回非 JSON（甚至空响应），HTTP 2xx 即视为成功
    }

    return { ok: true, status: res.status, detail: bodyText };
  } catch (e) {
    console.error("Failed to send Webhook notification:", e);
    return { ok: false, detail: e instanceof Error ? e.message : "请求异常" };
  }
}

/**
 * 推送 Telegram 通知
 *
 * NOTE: 通过 Telegram Bot API 的 sendMessage 接口推送文本消息。
 */
/** SMTP 发信配置（QQ 邮箱 / 163 / Gmail 等通用） */
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  /** QQ 邮箱这里要填「授权码」，不是登录密码 */
  pass: string;
  /** 发件人，留空则用 user */
  from?: string;
  to: string;
}

/**
 * 通过 SMTP 发送纯文本邮件
 *
 * NOTE: Workers 没有 SMTP 库可用，这里用 `connect()` 直接开一条 TLS 长连接
 *       （`secureTransport: "on"` = 隐式 TLS，对应 465 端口；若填 587 则需要 STARTTLS，
 *       本实现未做 STARTTLS，界面上会引导用户填 465）。
 *
 * 常见失败与对应含义（都原样回给用户，便于自查）：
 *   535 / 认证失败 → QQ 邮箱必须用「授权码」而不是登录密码
 *   连接超时       → 端口填错（465 才是隐式 TLS），或该 SMTP 服务商封了 Cloudflare 出口 IP
 */
export async function sendSmtpMail(cfg: SmtpConfig, subject: string, body: string): Promise<WebhookSendResult> {
  if (!cfg.host || !cfg.port || !cfg.user || !cfg.pass || !cfg.to) {
    return { ok: false, detail: "SMTP 配置不完整：需要服务器、端口、账号、授权码、收件人" };
  }
  const from = cfg.from || cfg.user;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

  // cloudflare:sockets 只在 Workers 运行时存在；Node 自建版取不到，此时如实说明并让用户改用 Webhook。
  let connect: WorkerConnect;
  try {
    ({ connect } = (await import("cloudflare:sockets")) as unknown as { connect: WorkerConnect });
  } catch {
    return {
      ok: false,
      detail: "当前运行时不支持 SMTP 直连（cloudflare:sockets 仅在 Cloudflare Workers 上可用），自建版请改用 Webhook 通知渠道",
    };
  }

  let socket: WorkerTlsSocket;
  try {
    socket = connect(
      { hostname: cfg.host, port: cfg.port },
      { secureTransport: "on", allowHalfOpen: false }
    );
  } catch (e) {
    return { ok: false, detail: `无法建立连接：${e instanceof Error ? e.message : String(e)}` };
  }

  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let buf = "";

  /** 读一条完整 SMTP 响应（多行响应以「3 位码 + 空格」结尾） */
  const readResponse = async (): Promise<string> => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const nl = buf.indexOf("\r\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (/^\d{3} /.test(line)) return line;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    throw new Error("等待 SMTP 响应超时");
  };
  const cmd = async (line: string) => {
    await writer.write(enc.encode(line + "\r\n"));
    return readResponse();
  };

  try {
    const greet = await readResponse();
    if (!greet.startsWith("220")) throw new Error(`服务端问候异常：${greet}`);

    await cmd("EHLO shydns.cc.cd");

    const authStart = await cmd("AUTH LOGIN");
    if (!authStart.startsWith("334")) throw new Error(`服务端不支持 AUTH LOGIN：${authStart}`);
    const userResp = await cmd(b64(cfg.user));
    if (!userResp.startsWith("334")) throw new Error(`用户名被拒绝：${userResp}`);
    const passResp = await cmd(b64(cfg.pass));
    if (!passResp.startsWith("235")) {
      throw new Error(`登录失败：${passResp}（QQ 邮箱请填「授权码」而非登录密码）`);
    }

    const mailFrom = await cmd(`MAIL FROM:<${from}>`);
    if (!mailFrom.startsWith("250")) throw new Error(`发件人被拒绝：${mailFrom}`);
    const rcptTo = await cmd(`RCPT TO:<${cfg.to}>`);
    if (!rcptTo.startsWith("250")) throw new Error(`收件人被拒绝：${rcptTo}`);

    const dataStart = await cmd("DATA");
    if (!dataStart.startsWith("354")) throw new Error(`DATA 被拒绝：${dataStart}`);

    const headers = [
      `From: =?UTF-8?B?${b64("DNSHE 集控台")}?= <${from}>`,
      `To: <${cfg.to}>`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      `Date: ${new Date().toUTCString()}`,
    ].join("\r\n");
    // base64 正文按 76 字符折行，否则部分服务端会拒收
    const payload = `${headers}\r\n\r\n${(b64(body).match(/.{1,76}/g) || []).join("\r\n")}`;
    await writer.write(enc.encode(`${payload}\r\n.\r\n`));

    const done = await readResponse();
    if (!done.startsWith("250")) throw new Error(`邮件未被接收：${done}`);

    await cmd("QUIT").catch(() => undefined);
    return { ok: true, detail: "SMTP 发送成功" };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Workers 的 sockets 在连不上时只抛 "Stream was cancelled."，对用户完全没有信息量，
    // 这里补上「连的是谁」，让「域名写错」和「端口写错」可区分。
    const detail =
      /stream was cancelled|cancelled/i.test(raw) || raw === "Stream was cancelled."
        ? `无法连接到 ${cfg.host}:${cfg.port}（域名不存在、端口错误，或该服务商屏蔽了 Cloudflare 出口 IP）`
        : raw;
    return { ok: false, detail };
  } finally {
    try {
      writer.releaseLock();
      reader.releaseLock();
      await socket.close();
    } catch {
      /* 关闭失败无需处理 */
    }
  }
}

export async function sendTelegramNotification(botToken: string, chatId: string, message: string) {  if (!botToken || !chatId) return;
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error(`Telegram push failed with status: ${res.status}`);
    }
  } catch (e) {
    console.error("Failed to send Telegram notification:", e);
  }
}

// NOTE: 使用 DNSHEClient 的类型签名来定义分页拉取接口
interface SubdomainClient {
  listSubdomains(page: number, perPage: number): Promise<{
    success?: boolean;
    subdomains?: SubdomainInfo[];
    total?: number;
    message?: string;
  }>;
}

/**
 * 分页拉取某个账号下的全部子域名
 *
 * NOTE: DNSHE API 的 per_page 最大值为 500。循环分页直到所有数据拉取完毕。
 */
export async function fetchAllSubdomainsFromClient(client: SubdomainClient): Promise<SubdomainInfo[]> {
  const allSubdomains: SubdomainInfo[] = [];
  const perPage = 500;
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await client.listSubdomains(page, perPage);
    if (!res || !res.success || !Array.isArray(res.subdomains)) {
      throw new Error(res?.message || "响应数据格式错误");
    }

    allSubdomains.push(...res.subdomains);

    // 判断是否还有下一页：当返回的数据量不足一页，或已达到 total 总数时停止
    if (res.subdomains.length < perPage) {
      hasMore = false;
    } else if (res.total !== undefined && allSubdomains.length >= res.total) {
      hasMore = false;
    } else {
      page++;
    }

    // 安全保护：最多拉取 50 页（25000 条），防止无限循环
    if (page > 50) {
      console.error("Pagination safety limit reached (50 pages), stopping.");
      break;
    }
  }

  return allSubdomains;
}

/**
 * 同步单个账号的域名（只做域名/DNS 状态同步，不触发续期）
 *
 * 🔴 为什么要抽出来：整包同步在 Workers 免费版会撞上**单次调用 50 个子请求**的上限 ——
 *    每个域名都要单独发一次 `listDnsRecords`，6 个账号 50 个域名 ≈ 53+ 次请求。
 *    一旦超限，异常会被账号级 try/catch 吞掉，**循环里后续账号的写入被静默跳过**，
 *    表现为「某些账号在域名列表里凭空消失」，且日志里看不出任何异常。
 *    ⇒ 拆成「一次调用只同步一个账号」，由调用方分批驱动。
 */
export async function syncOneAccountDomains(
  dbManager: DatabaseManager,
  accountId: number
): Promise<{ alias: string; count: number }> {
  const { client, alias, provider } = await dbManager.getClientForAccount(accountId);

  if (provider === "cloudflare") {
    if (!(client instanceof CloudflareClient)) throw new Error("Cloudflare 账号客户端异常");
    const zones = await client.listZones();
    await dbManager.syncAccountDomains(accountId, zones.map(mapZoneToUpstream));
    return { alias, count: zones.length };
  }

  if (!(client instanceof DNSHEClient)) throw new Error("未知的账号提供商");

  const subdomains = await fetchAllSubdomainsFromClient(client);
  const withDnsInfo = await Promise.all(
    subdomains.map(async (sub) => {
      try {
        const recordsRes = await client.listDnsRecords(sub.id);
        return { ...sub, ...computeDnsState(recordsRes.records || []) };
      } catch {
        // 单个域名的 DNS 查询失败不阻断整账号同步（保留缓存中已有的三态）
        return { ...sub };
      }
    })
  );
  await dbManager.syncAccountDomains(accountId, withDnsInfo);
  return { alias, count: subdomains.length };
}

/**
 * 核心定时任务：全量同步所有账号的域名并自动续期即将到期的域名
 */
export async function runDailySyncAndRenewal(
  dbManager: DatabaseManager,
  webhookUrl?: string,
  webhookType: WebhookType = "custom"
) {
  await dbManager.ensureTables();
  await dbManager.writeLog("info", "system", "自动定时任务启动：开始执行域名同步与到期检测续期任务");

  // 读取数据库应用配置（优先级高于环境变量）
  const appCfg = await dbManager.getAllAppSettings();
  const renewThresholdDays = (() => {
    const v = parseInt(appCfg["renew_threshold_days"] || "", 10);
    return isNaN(v) || v <= 0 ? 180 : v;
  })();
  const autoRenewEnabled = appCfg["auto_renew"] !== "0"; // 默认开启
  const effectiveWebhookUrl = appCfg["webhook_url"] || webhookUrl || "";
  const effectiveWebhookType = (appCfg["webhook_type"] as WebhookType) || webhookType;
  const tgToken = appCfg["tg_token"] || "";
  const tgChatId = appCfg["tg_chat_id"] || "";

  let allAccounts: Array<{ id: number; alias: string }> = [];
  try {
    allAccounts = await dbManager.getAccounts();
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "未知错误";
    await dbManager.writeLog("error", "system", "同步任务失败：无法获取绑定的账户列表", message);
    return;
  }

  // 🔴 轮转：每轮只处理一个账号。
  //    整包处理的代价是「每域名 1 次 listDnsRecords」，6 账号 50 域名 ≈ 53+ 次子请求，
  //    而 Workers 免费版单次调用上限是 50 —— 超限的那部分会被账号级 try/catch 吞掉，
  //    表现为部分账号的域名永久同步不进去。改为轮转后单轮开销恒为「1 + 该账号域名数」。
  //    配合每小时触发，全部账号在 6 小时内至少覆盖一轮。
  const cursorRaw = await dbManager.getSetting("sync_cursor");
  const cursor = Number.isFinite(parseInt(cursorRaw || "0", 10)) ? parseInt(cursorRaw || "0", 10) : 0;
  const idx = allAccounts.length > 0 ? cursor % allAccounts.length : 0;
  const accounts = allAccounts.length > 0 ? [allAccounts[idx]] : [];
  if (allAccounts.length > 0) {
    await dbManager.setSetting("sync_cursor", String((idx + 1) % allAccounts.length));
  }

  let totalSynced = 0;
  let totalRenewSuccess = 0;
  let totalRenewFail = 0;
  const renewLogs: string[] = [];

  for (const acc of accounts) {
    try {
      // 1. 获取解密后的 API 客户端
      const { client, alias, provider } = await dbManager.getClientForAccount(acc.id);

      // 1.5 Cloudflare 账号：只同步 zone 列表。zone 的有效期由注册商管理，
      //     不存在 DNSHE 式续期，直接跳过续期扫描。
      if (provider === "cloudflare") {
        if (!(client instanceof CloudflareClient)) {
          throw new Error("Cloudflare 账号客户端异常");
        }
        const zones = await client.listZones();
        await dbManager.syncAccountDomains(acc.id, zones.map(mapZoneToUpstream));
        totalSynced += zones.length;
        continue;
      }

      if (!(client instanceof DNSHEClient)) {
        throw new Error("未知的账号提供商");
      }

      // 2. 分页拉取该账户在 DNSHE 系统的全部域名
      const subdomains = await fetchAllSubdomainsFromClient(client);
      
      // 3. 并发获取每个子域名的 DNS 记录，自动计算真实状态（已委派 / 已解析 / 未解析）
      const subdomainsWithDnsInfo = await Promise.all(
        subdomains.map(async (sub) => {
          try {
            const recordsRes = await client.listDnsRecords(sub.id);
            const records = recordsRes.records || [];
            return { ...sub, ...computeDnsState(records) };
          } catch (e) {
            // 上游临时失败时不带 dns_state_known，缓存中已识别出的三态与托管商保持不变。
            return { ...sub };
          }
        })
      );

      // 4. 同步到本地 cache
      await dbManager.syncAccountDomains(acc.id, subdomainsWithDnsInfo);
      totalSynced += subdomains.length;
      
      // 4. 扫描该账号下的域名，判断是否需要续期
      for (const sub of subdomains) {
        const expiresAt = sub.expires_at as string | undefined;
        if (!expiresAt) continue;

        // 计算到期剩余天数
        const expiresTime = new Date(expiresAt).getTime();
        const nowTime = Date.now();
        const remainingDays = (expiresTime - nowTime) / (1000 * 60 * 60 * 24);

        // NOTE: DNSHE 免费域名有效期为 1 年，且平台允许随时续期。
        // 续期阈值默认 180 天（可在设置页配置 renew_threshold_days）：
        // 剩余有效期不足阈值时自动续期，防止遗忘导致域名过期丢失。
        if (autoRenewEnabled && remainingDays >= 0 && remainingDays <= renewThresholdDays) {
          const subId = sub.id as number;
          const fullDomain = sub.full_domain as string;

          try {
            // 触发续期
            const renewResult = await client.renewSubdomain(subId);
            if (renewResult && renewResult.success) {
              totalRenewSuccess++;
              const newExpiresAt = renewResult.new_expires_at || "";
              
              // 更新本地到期时间缓存
              await dbManager.markDomainRenewed(subId, newExpiresAt);
              
              const msg = `域名 [${fullDomain}] (账户: ${alias}) 自动续期成功！新有效期至: ${newExpiresAt}`;
              await dbManager.writeLog("success", "renew", msg, renewResult);
              renewLogs.push(`✅ ${msg}`);
            } else {
              throw new Error(renewResult.message || "未知原因导致的续期失败");
            }
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : "";
            
            // 针对尚未到免费续期窗口的情况，只作为普通信息记录，避免推送红色警报
            if (errMsg.includes("renewal_not_yet_available") || errMsg.includes("not yet available")) {
              await dbManager.writeLog("info", "renew", `域名 [${fullDomain}] 自动续期请求已提交，但因尚未进入免费续期窗口被拦截，将在后续定时任务中重试。`);
            } else {
              totalRenewFail++;
              const msg = `域名 [${fullDomain}] (账户: ${alias}) 自动续期失败：${errMsg}`;
              await dbManager.writeLog("error", "renew", msg, err instanceof Error ? (err.stack || errMsg) : errMsg);
              renewLogs.push(`❌ ${msg}`);
            }
          }
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "未知错误";
      const stack = e instanceof Error ? (e.stack || message) : message;
      await dbManager.writeLog("error", "sync", `同步账号 [${acc.alias}] 的域名数据失败：${message}`, stack);
    }
  }

  // 整理并发送总结通知
  const summaryMsg = `自动同步任务结束。本次同步域名数: ${totalSynced} 个，自动续期成功: ${totalRenewSuccess} 个，续期失败: ${totalRenewFail} 个。`;
  await dbManager.writeLog("info", "system", summaryMsg);

  // 自动清理 30 天前的过期日志
  await dbManager.pruneExpiredLogs();

  // 自动清理已过期的缓存行（含 7 天 TTL 的查重池），避免 cache 表只进不出
  const purgedCache = await dbManager.purgeExpiredCache();
  if (purgedCache > 0) {
    await dbManager.writeLog("info", "system", `已清理 ${purgedCache} 条过期缓存记录（含查重池）`);
  }

  // 自动清理已过期会话，避免 settings 表被 sess_ 行无限撑大
  // （鉴权中间件每个请求都要查这张表，行数失控会直接拖慢所有接口）
  const purgedSessions = await dbManager.purgeExpiredSessions();
  if (purgedSessions > 0) {
    await dbManager.writeLog("info", "system", `已清理 ${purgedSessions} 条过期登录会话`);
  }

  // 如果有域名触发了续期，则向配置的通知渠道推送消息
  if (renewLogs.length > 0) {
    const notifyBody = `【DNSHE 域名自动续期报告】\n${summaryMsg}\n\n详细明细：\n${renewLogs.join("\n")}`;
    if (effectiveWebhookType === "email") {
      // 邮箱渠道走 SMTP，与 Webhook 是两个互斥的出口（webhook_url 在这里没有意义）
      const result = await sendSmtpMail(
        {
          host: String(appCfg["smtp_host"] || ""),
          port: parseInt(appCfg["smtp_port"] || "465", 10) || 465,
          user: String(appCfg["smtp_user"] || ""),
          pass: String(appCfg["smtp_pass"] || ""),
          from: String(appCfg["smtp_from"] || ""),
          to: String(appCfg["smtp_to"] || ""),
        },
        "DNSHE 域名自动续期报告",
        notifyBody
      );
      if (!result.ok) {
        await dbManager.writeLog("warning", "system", "续期报告邮件发送失败（SMTP）", result.detail || "");
      }
    } else if (effectiveWebhookUrl) {
      // NOTE: 推送失败要留痕 —— 原先只 console.error，用户在面板里完全看不到，
      // 表现为「续期成功了但一直没收到通知」且无从排查。
      const result = await sendWebhookNotification(effectiveWebhookUrl, notifyBody, effectiveWebhookType);
      if (!result.ok) {
        await dbManager.writeLog(
          "warning",
          "system",
          `续期报告 Webhook 推送失败（${effectiveWebhookType}）`,
          result.detail || `HTTP ${result.status ?? "?"}`
        );
      }
    }
    if (tgToken && tgChatId) {
      await sendTelegramNotification(tgToken, tgChatId, notifyBody);
    }
  }
}
