/**
 * Cloudflare API v4 响应类型定义与客户端封装
 *
 * NOTE: 与 DNSHEClient 保持同一套 DNS 记录方法签名（listDnsRecords / createDnsRecord /
 * updateDnsRecord / deleteDnsRecord），index.ts 路由层按账号 provider 分发时无需关心
 * 上游差异。认证只支持 API Token（Bearer）—— Global API Key 属于旧式凭据，不做兼容。
 */

import type {
  ActionResponse,
  CreateDnsRecordResponse,
  DnsRecordInfo,
  ListDnsRecordsResponse,
} from "./dnshe";
import type { UpstreamSubdomain } from "./db";

export type CfReadFailureKind = "permission" | "authentication" | "not_enabled" | "rate_limit" | "timeout" | "network" | "unavailable" | "response" | "query";
export const CF_READ_BUDGET_EXHAUSTED = "本轮 Cloudflare 读取预算已用尽";
export interface CfReadBudget {
  remaining: number;
  deadline: number;
}

/** 只保存供应商诊断，不携带请求头、Token 或完整响应。 */
export class CfReadError extends Error {
  constructor(public readonly kind: CfReadFailureKind, message: string, public readonly detail?: { http_status?: number; code?: number }) {
    super(message);
    this.name = "CfReadError";
  }
}

function cfFailureKind(status: number, detail: string, code?: number): CfReadFailureKind {
  // R2 未开通也返回 403，不能因此要求用户反复扩权或替换 Token。
  if (code === 10042 || /please enable R2|R2 (?:is )?not enabled/i.test(detail)) return "not_enabled";
  if (status === 429 || /rate.?limit|too many requests/i.test(detail)) return "rate_limit";
  if (status === 401 || /invalid.*token|invalid bearer|expired.*token/i.test(detail)) return "authentication";
  if (status === 403 || /permission|not authorized|not authorised|authentication error|access denied/i.test(detail)) return "permission";
  if (status >= 500) return "unavailable";
  return "query";
}

/**
 * 把 Cloudflare zone id 映射为 domains_cache 的数值主键
 *
 * NOTE: domains_cache.id 直接充当路由里的域名 ID，而 CF zone id 是 32 位十六进制
 * 字符串，无法做 INTEGER 主键。这里用双 FNV-1a 拼出一个 53 位稳定哈希：
 * 同一 zone 每次同步得到相同 id（幂等 upsert），不同 zone 几乎不会碰撞；
 * 哈希值远大于 DNSHE 的小整数 subdomain_id，两个提供商的 id 空间实际不相交。
 */
function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function zoneIdToNumericId(zoneId: string): number {
  const h1 = fnv1a32(zoneId, 0x811c9dc5);
  const h2 = fnv1a32(zoneId, 0x811c9dc5 ^ 0x9e3779b9);
  return h1 * 0x200000 + (h2 % 0x200000); // 2^32 * 2^21 = 2^53，落在 JS 安全整数内
}

/** Cloudflare API v4 统一响应外壳 */
interface CfResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages?: unknown[];
  result?: T;
}

/** zone 信息（listZones 返回，只保留面板需要的字段） */
export interface CfZoneInfo {
  id: string;
  name: string;
  status: string;
  created_on?: string;
  name_servers?: string[];
  account?: { id?: string; name?: string };
}

/** Token 校验结果（/user/tokens/verify） */
export interface CfTokenVerifyInfo {
  token_id: string;
  status: string;
}

/** Cloudflare 账号信息（listAccounts 返回） */
export interface CfAccountInfo {
  id: string;
  name: string;
}

/**
 * zone 创建结果
 *
 * NOTE: 只保留「域名委派」流程真正要用的三个字段：新 zone 的 id、CF 分配的两台 NS、
 * 以及 zone 状态。status 建出来必然是 `pending` —— 官方文档明确「zone 创建后处于
 * pending，必须把域名 NS 指过来（或完成 partial 校验）才会 active」。
 */
export interface CfZoneCreateResult {
  id: string;
  name: string;
  status: string;
  name_servers: string[];
}

/** DNS 记录写接口参数 —— 路由层从请求体摊平后构造，name 允许相对名/完整名/@ */
export interface CfDnsWriteParams {
  zone_id: string;
  zone_name: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
  record_id?: string | number;
}

/** Cloudflare 返回的 DNS 记录原始形状（只声明会用到的字段） */
interface CfDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  priority?: number | null;
  proxied?: boolean;
}

/**
 * 把主机记录转成 Cloudflare 要求的完整域名
 *
 * NOTE: 路由层的 normalizeDnsRecordName 已把输入统一成 @ / 相对名（ASCII 小写），
 * 这里只需补全 zone 后缀；name 传来时已是完整名（例如批量编辑回填）则原样保留。
 */
function toFqdnRecordName(name: string, zoneName: string): string {
  const zone = String(zoneName || "").trim().replace(/\.+$/, "").toLowerCase();
  const trimmed = String(name || "").trim().replace(/\.+$/, "").toLowerCase();
  if (!trimmed || trimmed === "@") {
    return zone;
  }
  if (!zone || trimmed === zone || trimmed.endsWith(`.${zone}`)) {
    return trimmed;
  }
  return `${trimmed}.${zone}`;
}

/** 把 Cloudflare 记录映射为与 DNSHE 一致的内部形状 */
function mapCfRecord(rec: CfDnsRecord): DnsRecordInfo {
  return {
    id: rec.id,
    name: rec.name,
    type: rec.type,
    content: rec.content,
    // Cloudflare 以 ttl=1 表示「自动」，前端据此显示「自动」
    ttl: Number(rec.ttl) || 1,
    priority: rec.priority ?? null,
    line: null,
    proxied: Boolean(rec.proxied),
  };
}

/**
 * 把 Cloudflare zone 映射为 domains_cache 的上游行
 *
 * NOTE: status 直接存 zone 的原始状态（active/pending/moved），这些行只在 Cloudflare
 * 标签页展示，由该页面自己渲染状态徽标，不走 DNSHE 的三态语义。expires_at 用 0000
 * 前缀占位，前端 formatDate 会显示成「永久」。数值主键由 zoneIdToNumericId（db.ts）产出。
 * provider_account_id 借存 CF 账号 id —— DNSHE 行用它做线路判定兜底，CF 行用不到
 * 那套语义，正好复用给前端拼控制台深链（dash.cloudflare.com/{账号id}/{zone名}）。
 */
export function mapZoneToUpstream(zone: CfZoneInfo): UpstreamSubdomain {
  return {
    id: zoneIdToNumericId(zone.id),
    subdomain: "",
    rootdomain: zone.name,
    full_domain: zone.name,
    status: zone.status || "active",
    created_at: zone.created_on || "",
    expires_at: "0000-00-00 00:00:00",
    has_dns: 1,
    dns_provider: "Cloudflare",
    provider_account_id: zone.account?.id || null,
    remote_id: zone.id,
    dns_state_known: true
  };
}

/**
 * Cloudflare API 请求封装类
 */
export class CloudflareClient {
  private apiToken: string;
  private baseUrl = "https://api.cloudflare.com/client/v4";

  constructor(apiToken: string, private readonly readTimeoutMs = 10_000, private readonly readBudget?: CfReadBudget) {
    this.apiToken = String(apiToken || "").trim();
  }

  withReadBudget(budget: CfReadBudget): CloudflareClient {
    return new CloudflareClient(this.apiToken, this.readTimeoutMs, budget);
  }

  private safeDetail(detail: string): string {
    return (this.apiToken ? detail.split(this.apiToken).join("[REDACTED]") : detail).slice(0, 1000);
  }

  /** 读取超时包含响应体；不为写请求添加可能造成提交状态不明的自动重试。 */
  private async readJson<T>(url: string, init: RequestInit): Promise<{ response: Response; data: T }> {
    if (this.readBudget && this.readBudget.remaining <= 0) {
      throw new CfReadError("query", `${CF_READ_BUDGET_EXHAUSTED}，已保留可用快照；下次刷新优先补读未完成的账号`);
    }
    const timeoutMs = Math.min(this.readTimeoutMs, this.readBudget ? this.readBudget.deadline - Date.now() : this.readTimeoutMs);
    if (timeoutMs <= 0) throw new CfReadError("timeout", "本轮 Cloudflare 刷新已到时间上限，已保留可用快照，请稍后重试");
    if (this.readBudget) this.readBudget.remaining--;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // workerd 仅支持 follow/manual；手动拒绝跳转，避免一次 fetch 绕过批次预算。
      const response = await fetch(url, { ...init, signal: controller.signal, ...(this.readBudget ? { redirect: "manual" as const } : {}) });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new CfReadError("response", `Cloudflare 读取收到重定向 (HTTP ${response.status})，已拒绝跳转以遵守本轮读取预算`);
      }
      try {
        return { response, data: await response.json() as T };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new CfReadError(cfFailureKind(response.status, "") === "query" ? "response" : cfFailureKind(response.status, ""), `Cloudflare 响应无法解析 (HTTP ${response.status})`);
      }
    } catch (error) {
      if (controller.signal.aborted) throw new CfReadError("timeout", `Cloudflare 读取超时（最长 ${this.readTimeoutMs / 1000} 秒／次），请稍后重试`);
      if (error instanceof CfReadError) throw error;
      throw new CfReadError("network", "Cloudflare 网络连接失败，请稍后重试");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 通用请求封装 —— 非 2xx 或 success=false 时抛出带 CF 错误信息的异常
   */
  private async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    query?: Record<string, unknown>,
    body?: unknown
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, val] of Object.entries(query)) {
        if (val !== undefined && val !== null && val !== "") {
          url.searchParams.append(key, String(val));
        }
      }
    }

    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };

    let response: Response;
    let data: CfResponse<T>;
    if (method === "GET") {
      ({ response, data } = await this.readJson<CfResponse<T>>(url.toString(), init));
    } else {
      response = await fetch(url.toString(), init);
      try {
        data = (await response.json()) as CfResponse<T>;
      } catch {
        throw new Error(`Cloudflare API 响应异常 (HTTP ${response.status})`);
      }
    }

    if (!response.ok || !data.success) {
      const firstCode = (data.errors || [])[0]?.code;
      const detail = this.safeDetail((data.errors || [])
        .map((err) => err?.message)
        .filter(Boolean)
        .join("; "));
      if (method === "GET") {
        throw new CfReadError(cfFailureKind(response.status, detail, firstCode), `Cloudflare 读取失败 (HTTP ${response.status}${firstCode ? ` / code ${firstCode}` : ""})：${detail || "上游未提供原因"}`, { http_status: response.status, code: firstCode });
      }
      // NOTE: Cloudflare 对「Token 无效」和「Token 缺少该操作的权限」一律返回
      // Authentication error (code 10000/9109)。最常见的原因是 Token 只有
      // Zone:Read（拉 zone 列表够用，一旦读写解析记录就被拒），或 zone 范围
      // 未覆盖该账号 / 域名，翻译成可操作的中文指引而不是裸的英文原文。
      const isAuthError =
        firstCode === 9109 ||
        firstCode === 10000 ||
        /authentication error|invalid bearer|not authorized|missing authorization/i.test(detail);
      if (isAuthError) {
        throw new Error(
          "Cloudflare API 认证失败：请到 Cloudflare 控制台编辑该账号绑定的 API Token，确认包含 Zone:Read 与 Zone DNS:Edit 权限，且 zone 范围覆盖此域名（Include 指定账号或 All zones），改完无需重新绑定即可重试"
        );
      }
      throw new Error(`Cloudflare API 错误: ${detail || `HTTP ${response.status}`}`);
    }

    return data.result as T;
  }

  /**
   * 校验 API Token 有效性（返回 Token 自身 id 与 active 状态）
   */
  async verifyToken(): Promise<CfTokenVerifyInfo> {
    const result = await this.request<{ id: string; status: string }>("GET", "/user/tokens/verify");
    return { token_id: result.id, status: result.status };
  }

  /**
   * 列出 Token 可访问的 Cloudflare 账号（用于别名解析与唯一键）
   */
  async listAccounts(): Promise<CfAccountInfo[]> {
    const accounts: CfAccountInfo[] = [];
    let page = 1;
    while (page <= 10) {
      const results = await this.request<CfAccountInfo[]>("GET", "/accounts", { page, per_page: 50 });
      accounts.push(...(results || []));
      if (!results || results.length < 50) break;
      page++;
    }
    return accounts;
  }

  /**
   * 分页列出账号下全部 zone
   */
  async listZones(accountId?: string): Promise<CfZoneInfo[]> {
    const zones: CfZoneInfo[] = [];
    let page = 1;
    while (page <= 50) {
      const results = await this.request<CfZoneInfo[]>("GET", "/zones", { page, per_page: 50, "account.id": accountId });
      zones.push(...(results || []));
      if (!results || results.length < 50) break;
      page++;
    }
    return zones;
  }

  /**
   * 在指定账号下创建一个 full setup zone（「域名委派到 Cloudflare」第一步）
   *
   * 🔴 前置条件由调用方保证：只有「可注册根域名」才建得成。Cloudflare 用 Public
   *    Suffix List 判根域/子域 —— x.<root> 只有在 <root> 本身是 public suffix 时
   *    才算根域（免费版可建 full zone + 委派 NS）；否则 CF 视为子域，Free/Pro 直接
   *    拒绝，真委派要 Enterprise。DNSHE 的 9 个根里只有 4 个在 PSL 里。
   *
   * NOTE: 三个刻意的取舍
   *   · `type: "full"` —— 本 zone 的权威解析交给 Cloudflare，这正是「委派」的含义；
   *     partial（CNAME 接入）会保留原权威 DNS，与委派语义不符。
   *   · 不传 `jump_start` —— 那会让 CF 自己去扫旧解析并预填记录，结果不可预期；
   *     记录迁移必须走「用户确认后显式写入」，见 /api/domains/:id/delegate-cloudflare。
   *   · 不读 `vanity_name_servers` —— 自定义 NS 是 Business+ 专属，本项目不涉及。
   */
  async createZone(name: string, accountId: string): Promise<CfZoneCreateResult> {
    const cloudflareAccountId = String(accountId ?? "").trim();
    if (!/^[a-f\d]{32}$/i.test(cloudflareAccountId)) {
      throw new Error("Cloudflare Account ID 必须为 32 位十六进制标识，不能使用面板账号 ID");
    }
    const result = await this.request<CfZoneInfo>("POST", "/zones", undefined, {
      name: String(name || "").trim().toLowerCase(),
      account: { id: cloudflareAccountId },
      type: "full",
    });
    return {
      id: String(result.id),
      name: result.name || name,
      status: result.status || "pending",
      name_servers: (result.name_servers || []).map((host) => String(host)),
    };
  }

  /**
   * 读取单个 zone 的当前状态
   *
   * NOTE: 给「刷新状态」用。委派写完之后 CF 要自己去父区查 NS 才会把 zone 从
   * pending 翻成 active，这个检测是异步的（分钟级），所以不做阻塞轮询 ——
   * 用户点一次刷新就问一次，成本 1 个子请求。
   */
  /**
   * 列出账号下的 D1 数据库（第24轮H：CF 免费额度页用）
   *
   * 🔴 第24轮K 纠正：这个接口**返回 `file_size`**，就是"已用存储"的真实值。
   *    上一轮我写"CF 的 D1 API 不返回库大小"，是错的 —— 当时只看到了
   *    uuid/name/created_at 就下了结论。返回体里还有 `version` / `num_tables`
   *    / `file_size`；`file_size` 单位是字节。
   */
  async listD1Databases(
    accountId: string | number
  ): Promise<Array<{ uuid: string; name: string; created_at?: string; file_size?: number; num_tables?: number }>> {
    const res = await this.request<
      Array<{ uuid: string; name: string; created_at?: string; file_size?: number; num_tables?: number }>
    >("GET", `/accounts/${accountId}/d1/database`);
    return Array.isArray(res) ? res : [];
  }

  /**
   * 列出账号下的 KV 命名空间（第24轮H）
   *
   * 🔴 第24轮K 纠正：列命名空间本身确实不返回用量，但 **KV 的读/写/删/列次数
   *    可以走 GraphQL Analytics**（见 `cfGraphql`）—— 上一轮说"拿不到用量"不准确。
   */
  async listKvNamespaces(accountId: string | number): Promise<Array<{ id: string; title: string }>> {
    const res = await this.request<Array<{ id: string; title: string }>>(
      "GET",
      `/accounts/${accountId}/storage/kv/namespaces`
    );
    return Array.isArray(res) ? res : [];
  }

  /** 列出 R2 桶（第24轮K：免费额度页全景用） */
  async listR2Buckets(accountId: string | number): Promise<Array<{ name: string; creation_date?: string }>> {
    const res = await this.request<{ buckets?: Array<{ name: string; creation_date?: string }> }>(
      "GET",
      `/accounts/${accountId}/r2/buckets`
    );
    return Array.isArray(res?.buckets) ? res.buckets : [];
  }

  /** 列出 Pages 项目（第24轮K） */
  async listPagesProjects(accountId: string | number): Promise<Array<{ name: string; domains?: string[] }>> {
    try {
      const res = await this.request<Array<{ name: string; domains?: string[] }>>(
        "GET",
        `/accounts/${accountId}/pages/projects`
      );
      return Array.isArray(res) ? res : [];
    } catch (error) {
      // Pages 的 403 常见文案是 “Authentication error”，但它并不等价于 Token 失效：
      // 账号范围或 Account → Cloudflare Pages → Read 缺失同样会返回 10000/9109。
      // 保留原 HTTP/code 文本，同时给出可执行的修复方向，避免界面把资源误报成不存在。
      if (error instanceof CfReadError && (error.kind === "permission" || error.kind === "authentication")) {
        throw new CfReadError(error.kind,
          `${error.message}。需核对 Pages Read/Write 与目标账号范围；此响应本身不能区分缺权限、旧 Token 或范围不符。`, error.detail);
      }
      throw error;
    }
  }

  /** 列出 Workers 脚本（第24轮K） */
  async listWorkerScripts(accountId: string | number): Promise<Array<{ id: string }>> {
    const res = await this.request<Array<{ id: string }>>("GET", `/accounts/${accountId}/workers/scripts`);
    return Array.isArray(res) ? res : [];
  }

  /** 列出 Tunnel（第24轮K） */
  async listTunnels(accountId: string | number): Promise<Array<{ id: string; name: string; status?: string }>> {
    const res = await this.request<Array<{ id: string; name: string; status?: string }>>(
      "GET",
      `/accounts/${accountId}/cfd_tunnel?is_deleted=false`
    );
    return Array.isArray(res) ? res : [];
  }

  /**
   * 🔴 GraphQL Analytics —— 用量数据的**正式出口**（第24轮K 新增）
   *
   * 为什么必须有这一层：CF 的"用了多少"（请求数 / 行读行写 / KV 操作 / R2 存取
   * / DNS 查询量）**不在 REST 里**，全部走 `POST /graphql`。上一轮我只探了 REST，
   * 于是错误地得出"API 不暴露用量"的结论，还把它写进了页面文案。用户纠正后实测：
   * 这些数据全都拿得到。
   *
   * 使用 Bearer Token，需 Account Analytics:Read 且资源范围覆盖目标账号。
   * 数据集可用性、历史与单次查询范围另受产品和套餐限制，不能仅凭空集判断缺权限。
   *
   * @returns `data` 段；失败保留诊断，由采集层逐数据集容错。
   */
  async cfGraphql<T = unknown>(query: string): Promise<T | undefined> {
    const { response, data: payload } = await this.readJson<{ data?: T; errors?: Array<{ message?: string; code?: number }> }>(`${this.baseUrl}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    if (!response.ok || (payload.errors?.length ?? 0) > 0) {
      const detail = this.safeDetail((payload.errors || []).map((error) => error.message).filter(Boolean).join("; "));
      const code = payload.errors?.[0]?.code;
      throw new CfReadError(cfFailureKind(response.status, detail, code), `Cloudflare Analytics 读取失败 (HTTP ${response.status}${code ? ` / code ${code}` : ""})：${detail || "上游未提供原因"}`, { http_status: response.status, code });
    }
    return payload.data;
  }

  async getZone(zoneId: string | number): Promise<CfZoneInfo> {
    return this.request<CfZoneInfo>("GET", `/zones/${encodeURIComponent(String(zoneId))}`);
  }

  /**
   * 删除一个已确认归属的 zone。
   * 调用方必须先按真实 Cloudflare Account ID 精确查找并校验名称；这里不接受域名，
   * 避免把同名 zone 或其它账号的 zone 误删。
   */
  async deleteZone(zoneId: string | number): Promise<void> {
    await this.request("DELETE", `/zones/${encodeURIComponent(String(zoneId))}`);
  }

  /**
   * 列出 zone 下全部 DNS 解析记录（分页拉全，映射为内部形状）
   */
  async listDnsRecords(zoneId: string | number): Promise<ListDnsRecordsResponse> {
    const records: DnsRecordInfo[] = [];
    let page = 1;
    while (page <= 50) {
      const results = await this.request<CfDnsRecord[]>(
        "GET",
        `/zones/${encodeURIComponent(String(zoneId))}/dns_records`,
        { page, per_page: 100 }
      );
      records.push(...(results || []).map(mapCfRecord));
      if (!results || results.length < 100) break;
      page++;
    }
    return { success: true, records };
  }

  /**
   * 结构化类型的内容 → Cloudflare data 对象
   *
   * NOTE: Cloudflare 对 SRV / LOC / DNSKEY / DS / SVCB / HTTPS / TLSA / SSHFP 等
   * 结构化类型要求通过 data 对象提交。面板上用户按 RFC 惯例用空格分隔填写内容
   * （如 SRV「10 5 8080 example.com」、DS「2371 13 2 <摘要>」），这里按类型拆解
   * 字段；字段数不符等无法解析的情形返回 null，调用方保留原 content 提交，
   * 由 Cloudflare 返回明确的错误信息。
   */
  private buildStructuredData(type: string, content: string, priorityParam?: number): Record<string, unknown> | null {
    const parts = content.split(/\s+/).filter(Boolean);
    const unquote = (v: string) => v.replace(/^"(.*)"$/, "$1");
    const stripM = (v: string) => Number(String(v).replace(/m$/i, ""));
    const isNum = (v: string) => Number.isFinite(Number(v));

    switch (type) {
      case "SRV":
        if (parts.length !== 4 || !parts.slice(0, 3).every(isNum)) return null;
        return {
          priority: priorityParam ?? Number(parts[0]),
          weight: Number(parts[1]),
          port: Number(parts[2]),
          target: parts[3],
        };
      case "URI":
        if (parts.length < 3 || !isNum(parts[0]) || !isNum(parts[1])) return null;
        return { priority: priorityParam ?? Number(parts[0]), weight: Number(parts[1]), target: parts.slice(2).join(" ") };
      case "SSHFP":
        if (parts.length < 3 || !isNum(parts[0]) || !isNum(parts[1])) return null;
        return { algorithm: Number(parts[0]), type: Number(parts[1]), fingerprint: parts.slice(2).join("") };
      case "TLSA":
      case "SMIMEA":
        if (parts.length < 4 || !parts.slice(0, 3).every(isNum)) return null;
        return { usage: Number(parts[0]), selector: Number(parts[1]), matching_type: Number(parts[2]), certificate: parts.slice(3).join("") };
      case "DS":
        if (parts.length < 4 || !parts.slice(0, 3).every(isNum)) return null;
        return { key_tag: Number(parts[0]), algorithm: Number(parts[1]), digest_type: Number(parts[2]), digest: parts.slice(3).join("") };
      case "DNSKEY":
        if (parts.length < 4 || !parts.slice(0, 3).every(isNum)) return null;
        return { flags: Number(parts[0]), protocol: Number(parts[1]), algorithm: Number(parts[2]), public_key: parts.slice(3).join("") };
      case "CERT":
        if (parts.length < 4 || !isNum(parts[1]) || !isNum(parts[2])) return null;
        return { type: isNum(parts[0]) ? Number(parts[0]) : parts[0], key_tag: Number(parts[1]), algorithm: Number(parts[2]), certificate: parts.slice(3).join("") };
      case "NAPTR":
        if (parts.length < 6 || !isNum(parts[0]) || !isNum(parts[1])) return null;
        return { order: Number(parts[0]), preference: Number(parts[1]), flags: unquote(parts[2]), service: unquote(parts[3]), regexp: unquote(parts[4]), replacement: parts.slice(5).join(" ") };
      case "SVCB":
      case "HTTPS":
        if (parts.length < 2 || !isNum(parts[0])) return null;
        return {
          priority: priorityParam ?? Number(parts[0]),
          target: parts[1],
          ...(parts.length > 2 ? { value: parts.slice(2).join(" ") } : {}),
        };
      case "LOC": {
        // RFC 1876：「纬度1 纬度2 纬秒 N 经度1 经度2 经秒 E 海拔 [尺寸 水平精度 垂直精度]」
        if (parts.length < 9 || !isNum(parts[0]) || !isNum(parts[1]) || !isNum(parts[2]) || !isNum(parts[4]) || !isNum(parts[5]) || !isNum(parts[6])) return null;
        const data: Record<string, unknown> = {
          lat_degrees: Number(parts[0]),
          lat_minutes: Number(parts[1]),
          lat_seconds: Number(parts[2]),
          lat_direction: parts[3].toUpperCase(),
          long_degrees: Number(parts[4]),
          long_minutes: Number(parts[5]),
          long_seconds: Number(parts[6]),
          long_direction: parts[7].toUpperCase(),
          altitude: stripM(parts[8]),
        };
        if (parts[9] !== undefined) data.size = stripM(parts[9]);
        if (parts[10] !== undefined) data.precision_horz = stripM(parts[10]);
        if (parts[11] !== undefined) data.precision_vert = stripM(parts[11]);
        return data;
      }
      default:
        return null;
    }
  }

  /**
   * 根据写参数构造 CF 请求体：相对名转完整域名、代理记录强制自动 TTL、
   * MX 缺省优先级时从内容前缀解析、结构化类型转为 data 对象
   */
  private buildWritePayload(params: CfDnsWriteParams): Record<string, unknown> {
    const type = String(params.type || "").trim().toUpperCase();
    const name = toFqdnRecordName(params.name, params.zone_name);
    let content = String(params.content || "").trim();

    const payload: Record<string, unknown> = {
      type,
      name,
      content,
      // 开启代理（橙色云）时 Cloudflare 只接受自动 TTL (1)
      ttl: params.proxied ? 1 : (Number(params.ttl) > 0 ? Number(params.ttl) : 1),
      proxied: Boolean(params.proxied),
    };

    if (type === "MX") {
      let priority = Number(params.priority);
      // 兼容「10 mail.example.com」写法：内容前缀的数字视作优先级
      if (!Number.isFinite(priority) || priority < 0) {
        const match = content.match(/^(\d+)\s+(.+)$/);
        if (match) {
          priority = Number(match[1]);
          content = match[2];
        }
      }
      payload.content = content;
      if (Number.isFinite(priority) && priority >= 0) {
        payload.priority = priority;
      }
      return payload;
    }

    // 结构化类型：内容自动转 data 对象；解析不出则保留 content，由 Cloudflare 报具体错误
    const structured = this.buildStructuredData(
      type,
      content,
      Number.isFinite(Number(params.priority)) ? Number(params.priority) : undefined
    );
    if (structured) {
      payload.data = structured;
      delete payload.content;
    }

    return payload;
  }

  /**
   * 创建 DNS 解析记录
   */
  async createDnsRecord(params: CfDnsWriteParams): Promise<CreateDnsRecordResponse> {
    const record = await this.request<CfDnsRecord>(
      "POST",
      `/zones/${encodeURIComponent(params.zone_id)}/dns_records`,
      undefined,
      this.buildWritePayload(params)
    );
    return { success: true, record: mapCfRecord(record) };
  }

  /**
   * 修改 DNS 解析记录（PUT 整条覆盖，与 DNSHE 上游的整条覆盖语义一致）
   */
  async updateDnsRecord(params: CfDnsWriteParams): Promise<ActionResponse> {
    await this.request(
      "PUT",
      `/zones/${encodeURIComponent(params.zone_id)}/dns_records/${encodeURIComponent(String(params.record_id))}`,
      undefined,
      this.buildWritePayload(params)
    );
    return { success: true };
  }

  /**
   * 删除 DNS 解析记录
   */
  async deleteDnsRecord(zoneId: string | number, recordId: string | number): Promise<ActionResponse> {
    await this.request(
      "DELETE",
      `/zones/${encodeURIComponent(String(zoneId))}/dns_records/${encodeURIComponent(String(recordId))}`
    );
    return { success: true };
  }
}
