export type DnsProvider = "system" | "Cloudflare" | "DNSPod" | "Vercel" | "vps8" | "external";

function normalizeNameserver(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * 根据域名当前委派的 NS 地址识别 DNS 托管商。
 *
 * NOTE: vps8 使用的是自有 NS 域名，优先于通用服务商规则匹配。
 */
export function detectDnsProvider(nameservers: string[]): DnsProvider {
  const hosts = nameservers.map(normalizeNameserver).filter(Boolean);

  if (hosts.length === 0 || hosts.every((host) => matchesDomain(host, "dnshe.com"))) {
    return "system";
  }

  if (hosts.some((host) => matchesDomain(host, "vps8.zz.cd"))) {
    return "vps8";
  }

  if (hosts.some((host) => matchesDomain(host, "ns.cloudflare.com"))) {
    return "Cloudflare";
  }

  if (hosts.some((host) =>
    matchesDomain(host, "dnspod.net") ||
    matchesDomain(host, "dnspod.com") ||
    matchesDomain(host, "dnsv.com") ||
    /(^|\.)dnsv[1-5]\.com$/.test(host)
  )) {
    return "DNSPod";
  }

  if (hosts.some((host) => matchesDomain(host, "vercel-dns.com"))) {
    return "Vercel";
  }

  return "external";
}

/**
 * 由域名区域内的解析记录推导出缓存所需的三态与托管商信息。
 *
 * NOTE: 域名三态（已委派 / 已解析 / 未解析）只能由真实解析记录推导出来，
 * 上游 subdomains/list 接口返回的 status 只有 active 之类的注册态。
 * 所有写入 domains_cache 的调用方都必须经过这里，dns_state_known 是
 * 「本次确实拿到了解析记录」的凭证 —— 缺少它时 syncAccountDomains
 * 会保留数据库里已有的三态，避免把「已委派」误刷成「已解析」。
 */
export interface DnsState {
  status: "已委派" | "已解析" | "未解析";
  has_dns: number;
  dns_provider: DnsProvider;
  dns_state_known: true;
}

/** 三态取值的唯一真源（由 computeDnsState 产出、db 层写库校验、同步层判断缓存是否可用） */
export const DNS_THREE_STATES: ReadonlySet<string> = new Set(["已委派", "已解析", "未解析"]);

/** 缓存里这一行的三态是否可信（不可信说明还没成功拉到过解析记录） */
export function hasKnownDnsState(status: string | null | undefined): boolean {
  return !!status && DNS_THREE_STATES.has(status);
}

export function computeDnsState(records: Array<{ type?: string; content?: unknown }>): DnsState {
  const dnsProvider = detectDnsProvider(
    records.filter((record) => record.type === "NS").map((record) => String(record.content || ""))
  );

  if (dnsProvider !== "system") {
    return { status: "已委派", has_dns: 0, dns_provider: dnsProvider, dns_state_known: true };
  }
  if (records.length > 0) {
    return { status: "已解析", has_dns: 1, dns_provider: dnsProvider, dns_state_known: true };
  }
  return { status: "未解析", has_dns: 1, dns_provider: dnsProvider, dns_state_known: true };
}

// ───────────────────────── 增量同步：决定「谁还需要上网复核」 ─────────────────────────

/**
 * 缓存里与「是否需要复核解析记录」相关的字段
 *
 * NOTE: remote_updated_at 是上游 subdomains/list 返回的 updated_at ——
 * 域名区域里任何一条解析记录被增删改，上游都会推进这个时间戳。
 * 三态完全由区域内的记录推导（NS 在不在、记录有没有），
 * 因此「上游 updated_at 与上次复核时一致」⇒ 三态必然没变，可以直接跳过那次网络请求。
 */
export interface CachedDomainStamp {
  status: string | null;
  /** 上次复核时上游给的 updated_at（未复核过的行为 null） */
  remote_updated_at: string | null;
  /** 本地行最后一次写入时间（北京时间字符串，定宽可比较） */
  updated_at: string | null;
}

/** 需要复核的原因，仅用于日志与排查 */
export type DnsCheckReason = "new" | "changed" | "unknown-state" | "stale";

export interface DnsCheckPlan {
  /** 需要复核的域名 id，按 (原因优先级, 最久未复核) 排序 */
  ids: number[];
  reasons: Map<number, DnsCheckReason>;
  /** 被跳过（直接沿用缓存）的数量 = 省下的子请求数 */
  skipped: number;
}

/** 原因优先级：先保证正确性（新域名/上游变过/状态缺失），最后才是「太久没查」的兜底 */
const REASON_PRIORITY: Record<DnsCheckReason, number> = {
  new: 0,
  changed: 1,
  "unknown-state": 2,
  stale: 3,
};

/**
 * 挑出本次真正需要用网络复核解析记录的域名
 *
 * 三条判定，任一成立就要复核：
 *   1. 缓存里没有这个域名（新注册 / 刚绑定）→ new
 *   2. 上游 updated_at 与上次复核时不一致（区域内的记录被动过）→ changed
 *   3. 缓存里的 status 不是三态（从没成功拉到过解析记录）→ unknown-state
 * 外加一条兜底：本地行太久没被写过（说明连续多次同步都被跳过）→ stale，
 * 防止上游 updated_at 语义变化导致三态永久冻结在旧值。
 *
 * @param listed  上游 subdomains/list 返回的域名（只用到 id 与 updated_at）
 * @param stamps  缓存里该账号的域名状态快照
 * @param cutoff  本地 updated_at 早于这个北京时间字符串即算 stale；传 null 关闭该兜底
 */
export function planDnsChecks(
  listed: Array<{ id: number; updated_at?: string | null }>,
  stamps: Map<number, CachedDomainStamp>,
  cutoff: string | null
): DnsCheckPlan {
  const reasons = new Map<number, DnsCheckReason>();
  let skipped = 0;

  for (const item of listed) {
    const cached = stamps.get(item.id);
    const remote = item.updated_at ? String(item.updated_at) : "";

    let reason: DnsCheckReason | null = null;
    if (!cached) {
      reason = "new";
    } else if (!hasKnownDnsState(cached.status)) {
      reason = "unknown-state";
    } else if (!remote || cached.remote_updated_at !== remote) {
      // 上游时间戳对不上就复核。注意 !remote 也走这一支 ——
      // 拿不到 updated_at 时无法判断有没有变，宁可多查一次，也不假设它没变。
      reason = "changed";
    } else if (cutoff && (!cached.updated_at || cached.updated_at < cutoff)) {
      reason = "stale";
    }

    if (reason) {
      reasons.set(item.id, reason);
    } else {
      skipped++;
    }
  }

  const ids = [...reasons.keys()].sort((a, b) => {
    const pa = REASON_PRIORITY[reasons.get(a)!];
    const pb = REASON_PRIORITY[reasons.get(b)!];
    if (pa !== pb) return pa - pb;
    // 同优先级内，本地最久没被写过的排前面 —— 预算不够时也能轮着刷新
    const ua = stamps.get(a)?.updated_at || "";
    const ub = stamps.get(b)?.updated_at || "";
    return ua < ub ? -1 : ua > ub ? 1 : 0;
  });

  return { ids, reasons, skipped };
}

/**
 * 受限并发地跑一批任务
 *
 * NOTE: 上游 DNSHE 有账号级速率限制，一次性 Promise.all 打出去会触发
 * 「Rate limit exceeded」，而原先那种「每个域名独立 try/catch + 静默沿用旧值」的写法
 * 会把限流失败吞掉，表现为三态一直不更新却毫无痕迹。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    })
  );

  return results;
}

/** 上游常见的限流/过载文案，用于把「限流」与「真失败」区分开 */
export function isRateLimitedMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("rate limit") ||
    m.includes("too many request") ||
    m.includes("请求太频繁") ||
    m.includes("频率") ||
    m.includes("429")
  );
}

