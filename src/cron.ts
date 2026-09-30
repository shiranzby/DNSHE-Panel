import { DatabaseManager, beijingTimeString } from "./db";
import type { UpstreamSubdomain } from "./db";
import type { SubdomainInfo } from "./dnshe";
import { DNSHEClient } from "./dnshe";
import { CloudflareClient, mapZoneToUpstream } from "./cloudflare";
import {
  computeDnsState,
  isRateLimitedMessage,
  mapWithConcurrency,
  planDnsChecks,
} from "./dns-provider";
import type { DnsState } from "./dns-provider";

/**
 * 单次 Worker 调用允许消耗的**网络**子请求数
 *
 * NOTE: 免费版硬上限是 50，这里留出余量给 D1 / KV / 鉴权 / 日志写入
 * （一次同步实际会用到：1 次账号查询 + 1 次快照查询 + 1 次 upsert 批 + 1~2 次日志）。
 */
export const SYNC_SUBREQUEST_BUDGET = 34;

/**
 * 复核解析记录的并发上限
 *
 * NOTE: 上游 DNSHE 有账号级速率限制，早先那种 Promise.all 全量并发会直接打出
 * 「Rate limit exceeded」，而失败又被静默吞掉 —— 表现为三态长期不更新却查不到原因。
 * 6 是实测的折中：16 个域名约 1 秒内跑完，又不容易触发限流。
 */
const SYNC_DNS_CONCURRENCY = 6;

/**
 * 兜底复核周期
 *
 * NOTE: 主判据是「上游 updated_at 有没有变」，但万一上游哪天改了这个字段的语义，
 * 三态会被永久冻结在旧值。这里再加一条「本地行超过 7 天没被写过就强制复核」，
 * 保证最坏情况下每周也会自我纠正一次。
 */
const DNS_RECHECK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;


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
 *
 * 🔴 增量：即使只同步一个账号，域名数超过预算时仍会触顶（50 个域名 = 51 次请求）。
 *    因此这里再做一层「只查变过的」——上游 subdomains/list 会给出每个域名的 updated_at，
 *    域名区域里任何解析记录被增删改都会推进它；三态又完全由区域内记录推导，
 *    所以「上游 updated_at 与上次复核时一致」等价于「三态没变」，那一次 listDnsRecords 可以省掉。
 *    ⇒ 稳态下一个账号只花 1 次请求（列表页），冷启动/改名后才按域名付费。
 *
 * @param opts.budget 本次允许消耗的网络子请求数上限（含列表分页）；
 *                    达到上限就停下，把剩余的域名留给下一次调用，绝不硬撞 50 的硬顶。
 */
export async function syncOneAccountDomains(
  dbManager: DatabaseManager,
  accountId: number,
  opts: { budget?: number; concurrency?: number } = {}
): Promise<{
  alias: string;
  count: number;
  /** 本次实际消耗的网络子请求数 */
  used: number;
  /** 本次真正复核了解析记录的域名数 */
  checked: number;
  /** 因为预算不够留给下一次的域名数 */
  pending: number;
  /** 复核失败的域名数（限流/网络抖动） */
  failedChecks: number;
  /** 命中限流（失败原因里出现限流文案） */
  rateLimited: boolean;
  /** 上游原始域名列表，供调用方接着做续期扫描（省掉再拉一次列表） */
  subdomains: SubdomainInfo[];
}> {
  const budget = opts.budget === undefined ? Number.POSITIVE_INFINITY : opts.budget;
  const concurrency = opts.concurrency ?? SYNC_DNS_CONCURRENCY;
  const { client, alias, provider } = await dbManager.getClientForAccount(accountId);

  if (provider === "cloudflare") {
    if (!(client instanceof CloudflareClient)) throw new Error("Cloudflare 账号客户端异常");
    const zones = await client.listZones();
    await dbManager.syncAccountDomains(accountId, zones.map(mapZoneToUpstream));
    // Cloudflare 的 zone 有效期由注册商管理，不存在续期扫描，因此不回传列表
    return {
      alias,
      count: zones.length,
      // listZones 是**分页**拉取（每页 50），按页数如实记账 —— 固定写 1 会让
      // 大账号（>50 个 zone）的成本被低估，共享预算就有越过 50 硬顶的风险。
      used: Math.max(1, Math.ceil(zones.length / 50)),
      // 🔴 语义：checked = 「本次为复核解析记录而额外发出的域名级请求数」。
      //    CF 这条路径一次列表就把全部 zone 都刷了，没有任何域名是被单独复核的，
      //    所以是 0。早先这里写 zones.length，导致界面每次同步都显示
      //    「本次复核 29 个变更」——明明什么都没变，属于虚假进度。
      checked: 0,
      pending: 0,
      failedChecks: 0,
      rateLimited: false,
      subdomains: [],
    };
  }

  if (!(client instanceof DNSHEClient)) throw new Error("未知的账号提供商");

  const subdomains = await fetchAllSubdomainsFromClient(client);
  // 列表分页的开销：fetchAllSubdomainsFromClient 每页 500 条发一次请求
  const listCost = Math.max(1, Math.ceil(subdomains.length / 500));
  let used = listCost;

  // ── 挑出真正需要上网复核的域名 ───────────────────────────────
  const stamps = await dbManager.getDomainSyncIndex();
  const cutoff = beijingTimeString(new Date(Date.now() - DNS_RECHECK_MAX_AGE_MS));
  const plan = planDnsChecks(subdomains, stamps, cutoff);

  const affordable = Math.max(0, Math.min(plan.ids.length, budget - used));
  const toCheck = plan.ids.slice(0, affordable);
  const untouchable = plan.ids.length - toCheck.length;

  const checkedById = new Map<
    number,
    { id: number; dns_state_known: true; remote_updated_at?: string } & DnsState
  >();
  let failedChecks = 0;
  let rateLimited = false;

  if (toCheck.length > 0) {
    const byId = new Map(subdomains.map((s) => [s.id, s]));
    await mapWithConcurrency(toCheck, concurrency, async (id) => {
      const sub = byId.get(id);
      try {
        const recordsRes = await client.listDnsRecords(id);
        checkedById.set(id, {
          id,
          ...computeDnsState(recordsRes.records || []),
          // 记下本次复核时的上游时间戳；下次它没变就直接跳过
          remote_updated_at: sub?.updated_at ? String(sub.updated_at) : undefined,
        });
      } catch (e: unknown) {
        failedChecks++;
        const msg = e instanceof Error ? e.message : "";
        if (isRateLimitedMessage(msg)) rateLimited = true;
      }
    });
    used += toCheck.length;
  }

  // 未复核的域名照原样回写：syncAccountDomains 在缺少 dns_state_known 时会保留库里的三态，
  // 但**必须带上**它们，否则会被当成「上游已删除」而从缓存里清掉。
  const merged: UpstreamSubdomain[] = subdomains.map((sub) => {
    const checked = checkedById.get(sub.id);
    return checked ? ({ ...sub, ...checked } as UpstreamSubdomain) : (sub as UpstreamSubdomain);
  });

  await dbManager.syncAccountDomains(accountId, merged);

  return {
    alias,
    count: subdomains.length,
    used,
    checked: checkedById.size,
    pending: untouchable + failedChecks,
    failedChecks,
    rateLimited,
    subdomains,
  };
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

  // 轮转起点：上一轮跑到哪，这一轮从那之后接着排队，保证每个账号都能轮到。
  // 🔴 早先的实现是「每轮只处理一个账号」，代价是全部账号要 6 小时才覆盖一轮。
  //    有了增量复核（没变过的域名不产生网络请求）之后，一轮的开销降到「每账号 1 次」，
  //    因此这里改为「在预算内从游标处尽量多扫」，稳态下每小时就能把全部账号过一遍。
  const cursorRaw = await dbManager.getSetting("sync_cursor");
  const cursor = Number.isFinite(parseInt(cursorRaw || "0", 10)) ? parseInt(cursorRaw || "0", 10) : 0;
  const start = allAccounts.length > 0 ? cursor % allAccounts.length : 0;
  const accounts = [...allAccounts.slice(start), ...allAccounts.slice(0, start)];

  let totalSynced = 0;
  let totalRenewSuccess = 0;
  let totalRenewFail = 0;
  const renewLogs: string[] = [];
  const partialAccounts: string[] = [];
  const limitedAccounts: string[] = [];
  let deferredRenew = 0;

  /** 本轮共享的网络子请求预算：同步与续期都在里面扣，绝不越过免费版 50 的硬顶 */
  let budget = SYNC_SUBREQUEST_BUDGET;
  let processed = 0;

  for (const acc of accounts) {
    // 预算见底就收队：剩下的账号留给下一轮（游标会从没处理到的那个接着走）
    if (budget <= 1) break;
    processed++;
    try {
      const r = await syncOneAccountDomains(dbManager, acc.id, { budget });
      budget -= r.used;
      totalSynced += r.count;

      // 没查完的域名（预算被截断或上游限流）与限流都要留痕，
      // 否则用户看到的只是「三态偶尔不更新」，排查时毫无线索。
      if (r.pending > 0) partialAccounts.push(`${r.alias}(${r.pending})`);
      if (r.rateLimited) limitedAccounts.push(r.alias);
      if (r.failedChecks > 0 && !r.rateLimited) {
        await dbManager.writeLog(
          "warning",
          "sync",
          `账号 [${r.alias}] 有 ${r.failedChecks} 个域名的解析记录复核失败，已保留缓存的旧三态，下次同步会重试`
        );
      }

      const subdomains = r.subdomains;

      // 2. 扫描该账号下的域名，判断是否需要续期
      //
      // NOTE: 先只用列表里的到期时间筛出候选，真的有人要续期时才去取客户端 ——
      // 绝大多数域名都远未到期（阈值 180 天），为「什么都不用做」多花一次 D1 查询不值。
      const renewCandidates: Array<{ id: number; fullDomain: string }> = [];
      if (autoRenewEnabled) {
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
          if (remainingDays >= 0 && remainingDays <= renewThresholdDays) {
            renewCandidates.push({ id: sub.id as number, fullDomain: sub.full_domain as string });
          }
        }
      }

      if (renewCandidates.length > 0) {
        // 预算不够就整体顺延到下一轮：续期也是一次请求，硬发会撞 50 的硬顶，
        // 结果可能是「上游已续期、本地没更新」这种更难排查的半成品状态。
        if (budget <= 1) {
          deferredRenew += renewCandidates.length;
        } else {
          budget--; // 取客户端（解密 + D1 查询）本身也要算一次
          const { client } = await dbManager.getClientForAccount(acc.id);
          if (!(client instanceof DNSHEClient)) throw new Error("未知的账号提供商");

          for (const cand of renewCandidates) {
            if (budget <= 0) {
              deferredRenew++;
              continue;
            }
            budget--;

            try {
              // 触发续期
              const renewResult = await client.renewSubdomain(cand.id);
              if (renewResult && renewResult.success) {
                totalRenewSuccess++;
                const newExpiresAt = renewResult.new_expires_at || "";

                // 更新本地到期时间缓存
                await dbManager.markDomainRenewed(cand.id, newExpiresAt);

                const msg = `域名 [${cand.fullDomain}] (账户: ${acc.alias}) 自动续期成功！新有效期至: ${newExpiresAt}`;
                await dbManager.writeLog("success", "renew", msg, renewResult);
                renewLogs.push(`✅ ${msg}`);
              } else {
                throw new Error(renewResult.message || "未知原因导致的续期失败");
              }
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : "";

              // 针对尚未到免费续期窗口的情况，只作为普通信息记录，避免推送红色警报
              if (errMsg.includes("renewal_not_yet_available") || errMsg.includes("not yet available")) {
                await dbManager.writeLog("info", "renew", `域名 [${cand.fullDomain}] 自动续期请求已提交，但因尚未进入免费续期窗口被拦截，将在后续定时任务中重试。`);
              } else if (isRateLimitedMessage(errMsg)) {
                // 限流不是「失败」，下一轮重试即可，不必让用户以为域名要掉了
                totalRenewFail++;
                await dbManager.writeLog("warning", "renew", `域名 [${cand.fullDomain}] 自动续期被上游限流拦截，将在下一轮定时任务重试。`);
              } else {
                totalRenewFail++;
                const msg = `域名 [${cand.fullDomain}] (账户: ${acc.alias}) 自动续期失败：${errMsg}`;
                await dbManager.writeLog("error", "renew", msg, err instanceof Error ? (err.stack || errMsg) : errMsg);
                renewLogs.push(`❌ ${msg}`);
              }
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

  if (allAccounts.length > 0) {
    await dbManager.setSetting("sync_cursor", String((start + processed) % allAccounts.length));
  }

  // 本轮没查完的域名/被限流的账号都写一条日志，避免「静默只更新了一半」
  if (partialAccounts.length > 0 || limitedAccounts.length > 0) {
    await dbManager.writeLog(
      "warning",
      "sync",
      `本轮子请求预算已用尽（上限 ${SYNC_SUBREQUEST_BUDGET}），部分域名顺延到下一轮` +
        (partialAccounts.length > 0 ? `：待复核 ${partialAccounts.join("、")}` : "") +
        (limitedAccounts.length > 0 ? `；被上游限流：${limitedAccounts.join("、")}` : "")
    );
  }
  if (deferredRenew > 0) {
    await dbManager.writeLog(
      "warning",
      "renew",
      `有 ${deferredRenew} 个域名已到续期阈值，但本轮预算用尽未发起续期，将在下一轮定时任务处理`
    );
  }

  // 整理并发送总结通知
  const summaryMsg =
    `自动同步任务结束。本次覆盖 ${processed}/${allAccounts.length} 个账号，同步域名 ${totalSynced} 个，` +
    `消耗子请求 ${budget < SYNC_SUBREQUEST_BUDGET ? SYNC_SUBREQUEST_BUDGET - budget : 0}/${SYNC_SUBREQUEST_BUDGET}，` +
    `自动续期成功 ${totalRenewSuccess} 个，续期失败 ${totalRenewFail} 个。`;
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
