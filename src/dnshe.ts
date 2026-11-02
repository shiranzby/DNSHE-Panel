/**
 * DNSHE API 响应类型定义
 * 
 * NOTE: 为每个 API 端点定义具体的响应接口，替代原先的 Promise<any> 返回类型，
 * 使所有调用方获得编译期的字段提示和类型校验。
 */

/** 通用基础响应 */
export interface BaseResponse {
  success: boolean;
  message?: string;
  error?: string;
}

/** 配额查询响应 */
export interface QuotaResponse extends BaseResponse {
  quota?: {
    used: number;
    base: number;
    invite_bonus: number;
    total: number;
    available: number;
  };
}

/** 子域名列表响应 */
export interface ListSubdomainsResponse extends BaseResponse {
  subdomains?: SubdomainInfo[];
  total?: number;
  page?: number;
  per_page?: number;
}

/** 子域名信息 */
export interface SubdomainInfo {
  id: number;
  subdomain: string;
  rootdomain: string;
  full_domain: string;
  status: string;
  expires_at?: string;
  created_at?: string;
  /**
   * 上游的最后修改时间
   *
   * NOTE: 实测 subdomains/list 默认返回该字段，域名区域里任何解析记录被增删改都会推进它。
   * 三态（已委派/已解析/未解析）完全由区域内记录推导，因此它没变 ⇔ 三态没变 ——
   * 增量同步据此跳过没必要的 dns_records/list 调用（见 dns-provider.ts 的 planDnsChecks）。
   */
  updated_at?: string;
  disable_ns_management?: boolean | number;
  has_dns?: boolean | number;
  ns1?: string;
  ns2?: string;
  /**
   * 该域名所在的解析服务商账号 ID —— `subdomains/list` 不传 fields 时默认就返回，
   * 无需额外调用。
   *
   * NOTE: 「域名是否支持按线路（运营商/地域）解析」在 API 里无从查起 —— 文档没有
   * 任何线路能力字段（`fields` 参数枚举了子域名的全部可选字段，里面没有），也没有
   * 根域名列表或 capability 接口；官网自己也是把「目前只有 us.ci 与 cn.mt 支持」
   * 写死在文案里的。实测同一账号下 us.ci / cn.mt 的该值为 1，其余 7 个根域名为
   * 7 或 8，两组取值无交集。
   *
   * 但文档从未说明这个字段的语义，属实测相关性而非契约。现已改用根域名的 NS 记录
   * 作为主判定信号（见 `/api/dns/ns` 与前端 DNSHE_LINE_NS_SUFFIXES）—— NS 落在
   * vip*.alidns.com 的根域支持线路，落在 DNSHE 自建 NS 的不支持，语义比裸数字明确
   * 得多。本字段降级为 NS 查不到时的兜底信号，前端不再提供对应的可编辑名单。
   */
  provider_account_id?: number | string | null;
}

/** 续期响应 */
export interface RenewResponse extends BaseResponse {
  new_expires_at?: string;
}

/** DNS 记录列表响应 */
export interface ListDnsRecordsResponse extends BaseResponse {
  records?: DnsRecordInfo[];
}

/** DNS 记录信息 */
export interface DnsRecordInfo {
  // Cloudflare 的记录 id 是 32 位十六进制字符串，DNSHE 是数字，统一放宽为联合类型
  id: number | string;
  record_id?: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  priority?: number | null;
  line?: string | null;
  proxied?: boolean;
}

/** 创建 DNS 记录响应 */
export interface CreateDnsRecordResponse extends BaseResponse {
  record?: DnsRecordInfo;
}

/** API 密钥信息 */
export interface ApiKeyInfo {
  id: number;
  key_name?: string;
  api_key: string;
  status: string;
  request_count?: number;
  last_used_at?: string;
  created_at?: string;
}

/** 列出 API 密钥响应 */
export interface ListApiKeysResponse extends BaseResponse {
  keys?: ApiKeyInfo[];
  count?: number;
}

/**
 * 密钥写操作（创建 / 重新生成 / 删除）响应
 *
 * ⚠️ api_secret 只在「创建」与「重新生成」的**当次响应**里出现，且官方加了
 *    `warning: Please save the api_secret, it will not be shown again`。
 */
export interface KeysActionResponse extends BaseResponse {
  api_key?: string;
  api_secret?: string;
  warning?: string;
  key_id?: number;
}

/**
 * 永久升级中心（好友助力）响应
 *
 * state 字段未逐项声明：上游对 `permanent_upgrade` 的响应结构没有稳定契约，
 * 实测含 helper_assist_limit / helper_assist_count / helper_assist_remaining /
 * assist_required / helper_limit_reached / assist_logs / requests。
 * 这里保持宽松，由调用方按需取值。
 */
export interface PermanentUpgradeResponse extends BaseResponse {
  state?: Record<string, unknown>;
  data?: Record<string, unknown>;
  count?: number;
  gifts?: GiftInfo[];
}

/** DDNS 更新响应 */
export interface DdnsUpdateResponse extends BaseResponse {
  status?: string;      // good = 地址已变更；nochg = 无变化
  changed?: boolean;    // 本次是否真的改动了 IP
  ip?: string;          // 生效的 IP
}

/** 助力（礼物）记录 */
export interface GiftInfo {
  id: number;
  code?: string;
  full_domain?: string;
  status?: string;      // pending / accepted / cancelled / expired
  from_userid?: number;
  to_userid?: number;
  expires_at?: string;
  created_at?: string;
}

/** 通用操作响应（用于更新、删除等不返回额外数据的操作） */
export interface ActionResponse extends BaseResponse {}

/** 注册子域名响应 */
export interface RegisterSubdomainResponse extends BaseResponse {
  subdomain_id?: number;
  full_domain?: string;
}

/** 创建 DNS 记录参数 */
export interface CreateDnsRecordParams {
  subdomain_id: number;
  type: string;
  name?: string;
  content: string;
  ttl?: number;
  priority?: number;
  line?: string;
  weight?: number;
  port?: number;
  target?: string;
}

/** 更新 DNS 记录参数 */
export interface UpdateDnsRecordParams extends CreateDnsRecordParams {
  record_id: string | number;
}

/** 保留上游状态与错误码，不能把网络失败翻译成“密钥无效”。 */
export class DNSHEApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "DNSHEApiError";
  }
}

/** DNSHE API 请求封装类。 */
export class DNSHEClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;

  constructor(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    // 从文档得知 API 地址
    this.baseUrl = "https://api005.dnshe.com/index.php";
  }

  /**
   * 通用请求封装 — 支持泛型返回值类型
   */
  /**
   * 裸请求：不抛异常，把 HTTP 状态与解析结果一并返回。
   *
   * 为什么单独抽一层：V2 适配要判断"这个失败是不是因为端点不存在"才能决定要不要回退旧版，
   * 抛异常的 request() 拿不到状态码；DDNS 也需要替换鉴权头（它用专用 token，不是 key/secret）。
   */
  private async requestRaw<T extends BaseResponse>(
    endpoint: string,
    action: string,
    method: "GET" | "POST",
    params: Record<string, unknown> = {},
    headersOverride?: Record<string, string>,
    timeoutMs = 0
  ): Promise<{ ok: boolean; status: number; data: T | null; message: string; code: string }> {
    let url = `${this.baseUrl}?m=domain_hub&endpoint=${endpoint}&action=${action}`;

    const headers: Record<string, string> = headersOverride ?? {
      "X-API-Key": this.apiKey,
      "X-API-Secret": this.apiSecret,
      "Content-Type": "application/json",
    };

    const options: RequestInit = {
      method,
      headers,
    };

    // keys/list 在上游偶发挂起时不能把整个 API 密钥页拖到 Worker 超时。
    // 只在调用方明确给出 timeout 时安装独立 AbortController，保持其它旧调用行为不变。
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      const controller = new AbortController();
      timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      options.signal = controller.signal;
    }

    if (method === "GET") {
      const queryParams = new URLSearchParams();
      for (const [key, val] of Object.entries(params)) {
        if (val !== undefined && val !== null) {
          queryParams.append(key, String(val));
        }
      }
      const queryString = queryParams.toString();
      if (queryString) {
        url += `&${queryString}`;
      }
    } else {
      options.body = JSON.stringify(params);
    }

    try {
      const response = await fetch(url, options);
      if (response.status >= 500) {
        // 不等待可能挂起的错误页正文；5xx 不是凭据被拒绝，只保留安全的诊断信息。
        void response.body?.cancel().catch(() => {});
        const ray = response.headers.get("cf-ray") || "";
        const trace = /^[a-zA-Z0-9-]{1,64}$/.test(ray) ? `；Ray ID: ${ray}` : "";
        return {
          ok: false, status: response.status, data: null, code: "dnshe_upstream_error",
          message: `DNSHE 上游服务返回 HTTP ${response.status}（${endpoint}${action ? "/" + action : ""}${trace}），不能据此判断密钥无效。请稍后重试；若本地可用而 Workers 持续失败，请联系 DNSHE 排查请求出口或使用可访问上游的 Docker 主机。`,
        };
      }
      const parsed = await response.json().catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return null;
      });
      const body: Record<string, unknown> = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      const message =
        (typeof body.message === "string" && body.message) ||
        (typeof body.msg === "string" && body.msg) ||
        (typeof body.error === "string" && body.error) ||
        (typeof body.detail === "string" && body.detail) ||
        (response.ok ? "" : `HTTP error! status: ${response.status}`);
      /*
       * 🔴 `error_code` 必须单独带出来（第24轮E 修正）。
       *    官方错误的真实形态是 `{"message":"IP not allowed","error_code":"auth_ip_not_allowed"}`
       *    —— **message 里并不含错误码**。早期版本只把 message 抛出去，
       *    于是 index.ts 里按 `raw.includes("auth_ip_not_allowed")` 匹配永远不命中，
       *    整张错误码翻译表等于死代码。
       */
      const code =
        (typeof body.error_code === "string" && body.error_code) ||
        (typeof body.code === "string" && body.code) ||
        "";
      if (response.ok && typeof body.success !== "boolean") {
        return { ok: false, status: response.status, data: null, code: "dnshe_invalid_response", message: `DNSHE ${endpoint}${action ? "/" + action : ""} 未返回有效 API JSON，不能验证密钥；请检查上游网关响应。` };
      }
      return { ok: response.ok, status: response.status, data: body as unknown as T, message, code };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`DNSHE API Error [${endpoint}/${action}]:`, message);
      const timedOut = error instanceof Error && error.name === "AbortError";
      return {
        ok: false, status: 0, data: null,
        message: timedOut ? "DNSHE 上游请求超时，请稍后重试；不能据此判断密钥无效。" : "无法连接 DNSHE 上游服务，请检查服务端出口网络；本地 curl 成功不代表 Workers 出口可用。",
        code: timedOut ? "dnshe_timeout" : "dnshe_network_error",
      };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  /** 抛异常版请求（保持原有调用方行为不变） */
  private async request<T extends BaseResponse>(
    endpoint: string,
    action: string,
    method: "GET" | "POST",
    params: Record<string, unknown> = {},
    headersOverride?: Record<string, string>,
    timeoutMs = 0
  ): Promise<T> {
    const r = await this.requestRaw<T>(endpoint, action, method, params, headersOverride, timeoutMs);
    if (!r.ok || r.data?.success === false) {
      // 把上游错误码挂在异常上，路由层的 translateUpstreamError 才能按码翻译
      throw new DNSHEApiError(r.message || `HTTP error! status: ${r.status}`, r.status, r.code || "dnshe_api_error");
    }
    return r.data as T;
  }

  /**
   * V2 端点适配：先按官方 V2（新 action + 新参数名）发，确认"端点不存在"才回退旧版。
   *
   * 背景：官方 `docs/api-reference.json` 已把 `subdomains/register` → `subdomains/create`
   * （参数 `rootdomain` → `domain`）、`permanent_upgrade/*` → `gifts/*`。
   * 旧端点目前仍可用（线上注册/助力都在跑），但文档只写新名 ⇒ 将来可能下线。
   *
   * 🔴 只在 404 / not_found 时回退：quota_exceeded、rate_limit、参数校验这类错误说明
   *    V2 端点**存在**，回退只会把同样的错误再演一遍，还可能重复计一次写操作。
   */
  private async requestV2<T extends BaseResponse>(
    v2: { endpoint: string; action: string; params: Record<string, unknown> },
    legacy: { endpoint: string; action: string; params: Record<string, unknown> },
    method: "GET" | "POST" = "POST"
  ): Promise<T> {
    const first = await this.requestRaw<T>(v2.endpoint, v2.action, method, v2.params);
    if (first.ok) return first.data as T;
    const notExist =
      first.status === 404 || /not[_ ]?found|unknown|not support|不存在|不支持/i.test(first.message || "");
    if (!notExist) throw new Error(first.message || `HTTP error! status: ${first.status}`);
    const second = await this.requestRaw<T>(legacy.endpoint, legacy.action, method, legacy.params);
    if (second.ok) return second.data as T;
    throw new Error(second.message || first.message || `HTTP error! status: ${second.status}`);
  }

  /**
   * 获取账号额度配额
   */
  async getQuota(timeoutMs = 0): Promise<QuotaResponse> {
    return this.request<QuotaResponse>("quota", "", "GET", {}, undefined, timeoutMs);
  }

  /**
   * 列出当前账号的 API 密钥列表
   * 可用于校验密钥有效性，并从中读取密钥名称 (key_name) 作为账户别名
   */
  async listApiKeys(): Promise<ListApiKeysResponse> {
    // 密钥页允许回退到本地快照；8 秒后明确失败，不能无限等待或把超时伪装成空列表。
    return this.request<ListApiKeysResponse>("keys", "list", "GET", {}, undefined, 8000);
  }

  /**
   * 创建新的 API 密钥
   *
   * NOTE: 响应里的 api_secret **只返回这一次**（官方文档原文：it will not be shown again）。
   *       调用方必须在拿到后立刻加密落库，否则该 Secret 永久丢失，只能重新生成。
   */
  async createApiKey(keyName: string, ipWhitelist?: string): Promise<KeysActionResponse> {
    return this.request<KeysActionResponse>("keys", "create", "POST", {
      key_name: keyName,
      ip_whitelist: ipWhitelist || undefined,
    });
  }

  /**
   * 重新生成指定密钥的 Secret（旧 Secret 立即失效）
   * 同样只在本次响应里返回新的 api_secret。
   */
  async regenerateApiKey(keyId: number): Promise<KeysActionResponse> {
    return this.request<KeysActionResponse>("keys", "regenerate", "POST", { key_id: keyId });
  }

  /**
   * 删除 API 密钥
   */
  async deleteApiKey(keyId: number): Promise<KeysActionResponse> {
    return this.request<KeysActionResponse>("keys", "delete", "POST", { key_id: keyId });
  }

  /**
   * 查询永久升级中心（好友助力）状态
   * 返回的 state 含 helper_assist_remaining / helper_assist_limit / helper_assist_count /
   * assist_logs / requests 等字段。
   */
  async getPermanentUpgradeState(page = 1, perPage = 50): Promise<PermanentUpgradeResponse> {
    return this.requestV2<PermanentUpgradeResponse>(
      { endpoint: "gifts", action: "list", params: { page, per_page: perPage } },
      { endpoint: "permanent_upgrade", action: "list", params: { page, per_page: perPage } },
      "GET"
    );
  }

  /**
   * 为某个子域名生成助力码（生成后别人可用该码给你助力）
   */
  async createUpgradeCode(subdomainId: number): Promise<PermanentUpgradeResponse> {
    return this.requestV2<PermanentUpgradeResponse>(
      { endpoint: "gifts", action: "initiate", params: { subdomain_id: subdomainId } },
      { endpoint: "permanent_upgrade", action: "create", params: { subdomain_id: subdomainId } }
    );
  }

  /**
   * 撤销助力码（官方 V2 `gifts/cancel`）
   *
   * 语义（官方文档原文）：`gift_id` 必须指向**由当前账号发起、仍处于 pending** 的助力；
   * 撤销后该 pending 转移即失效。已被接受的助力不能撤销 —— 域名已过户，无可撤销。
   */
  async cancelGift(giftId: number): Promise<PermanentUpgradeResponse> {
    return this.requestV2<PermanentUpgradeResponse>(
      { endpoint: "gifts", action: "cancel", params: { gift_id: giftId } },
      { endpoint: "permanent_upgrade", action: "cancel", params: { gift_id: giftId } }
    );
  }

  /**
   * 用好友的助力码触发助力（消耗本账号 1 次助力额度）
   *
   * NOTE: DNSHE 明确不支持批量助力，必须逐个账号调用；调用方需自行串行 + 加间隔。
   */
  async assistByCode(assistCode: string): Promise<PermanentUpgradeResponse> {
    return this.requestV2<PermanentUpgradeResponse>(
      { endpoint: "gifts", action: "accept", params: { code: assistCode } },
      { endpoint: "permanent_upgrade", action: "assist", params: { assist_code: assistCode } }
    );
  }

  /**
   * DDNS 动态解析更新（官方 V2：`endpoint=ddns&action=update`）
   *
   * - 令牌**按记录签发**：在 DNSHE 控制台「域名管理 → DDNS」为某条 A/AAAA 记录单独创建，
   *   该令牌只能更新它绑定的那条记录的 IP。
   * - 鉴权用 `Authorization: Bearer <token>` 或 `X-DDNS-Token`，**绝不放进 URL / body**。
   * - `ip` 省略时用请求来源 IP；传 IPv6 时必须与绑定的 AAAA 记录匹配。
   * - `status=good` 表示地址已变更；`status=nochg` + `changed=false` 同样算成功且不调用 DNS 提供商。
   * - 路由固定 `https://api005.dnshe.com`，与面板所在主机名无关。
   */
  async updateDdns(token: string, ip?: string): Promise<DdnsUpdateResponse> {
    return this.request<DdnsUpdateResponse>(
      "ddns",
      "update",
      "POST",
      ip ? { ip } : {},
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    );
  }

  /**
   * 列出子域名列表 (支持分页和搜索)
   *
   * 第24轮D 对齐官方 V2 `subdomains/list` 参数：
   * - `per_page` 默认 100 → **500**（官方上限 1–500）。原默认值从未被真用到
   *   （两处调用方都显式传 500），留着只是个陷阱：谁随手调用谁就多拉 4 倍分页。
   * - 新增 `sortBy` / `sortDir`：同步循环按 `id asc` 拉取，**分页顺序确定**。
   *   上游默认排序若在翻页间隙发生变化，>500 个域名的账号会漏/重域名。
   * - `include_total: 1` 保留 —— 分页循环靠 total 提前收尾，少发一次请求。
   *
   * ⚠️ 官方还有 `rootdomain` / `created_from` / `fields` 等过滤参数，本项目**故意不用**：
   *   域名列表读的是 D1 快照（0 次上游请求），过滤在本地做；而同步必须拿全量，
   *   传 rootdomain 只会让同步漏域名。真要在上游侧过滤，得先想清"过滤 vs 全量快照"的边界。
   */
  async listSubdomains(
    page = 1,
    perPage = 500,
    search = "",
    status = "",
    sortBy = "id",
    sortDir: "asc" | "desc" = "asc"
  ): Promise<ListSubdomainsResponse> {
    return this.request<ListSubdomainsResponse>("subdomains", "list", "GET", {
      page,
      per_page: perPage,
      search: search || undefined,
      status: status || undefined,
      sort_by: sortBy || undefined,
      sort_dir: sortDir || undefined,
      include_total: 1
    });
  }

  /**
   * 注册新的子域名
   */
  async registerSubdomain(subdomain: string, rootdomain: string): Promise<RegisterSubdomainResponse> {
    // V2：action=create + 字段名 domain（官方明确 rootdomain 是响应/过滤字段，不是注册字段）
    return this.requestV2<RegisterSubdomainResponse>(
      { endpoint: "subdomains", action: "create", params: { subdomain, domain: rootdomain } },
      { endpoint: "subdomains", action: "register", params: { subdomain, rootdomain } }
    );
  }

  /*
   * NOTE: 上游有 `subdomains/get`（单域名详情 + 解析记录），本项目**刻意不实现**。
   *   2026-10-16 完备性审计确认它在本架构里是冗余的，加了反而多一次上游调用：
   *     · 列表读的是 D1 快照，0 次上游请求；
   *     · 写操作后由 syncDomainStatusAfterDnsChange 用 listDnsRecords 定向回源
   *       （同样 1 次上游调用，且域名元数据本来就从 D1 拿，不需要 get 再返回一遍）；
   *     · 续期后的新到期时间由 renew 响应直接写回（markDomainRenewed）。
   *   若将来要做「跨账号单域名直查」，再把它加回来。
   */

  /**
   * 续期子域名
   */
  async renewSubdomain(subdomainId: number): Promise<RenewResponse> {
    return this.request<RenewResponse>("subdomains", "renew", "POST", {
      subdomain_id: subdomainId
    });
  }

  /**
   * 删除子域名
   */
  async deleteSubdomain(subdomainId: number): Promise<ActionResponse> {
    return this.request<ActionResponse>("subdomains", "delete", "POST", {
      subdomain_id: subdomainId
    });
  }

  /**
   * 列出子域名的 DNS 解析记录
   *
   * NOTE: 参数放宽为 number | string —— 路由层对 DNSHE / Cloudflare 客户端做联合分发时
   * 传同一个 remote_id（DNSHE 行是数字主键，CF 行是 zone id 字符串），实际只走数字。
   */
  async listDnsRecords(subdomainId: number | string): Promise<ListDnsRecordsResponse> {
    return this.request<ListDnsRecordsResponse>("dns_records", "list", "GET", {
      subdomain_id: subdomainId
    });
  }

  /**
   * 创建 DNS 解析记录
   */
  async createDnsRecord(params: CreateDnsRecordParams): Promise<CreateDnsRecordResponse> {
    return this.request<CreateDnsRecordResponse>("dns_records", "create", "POST", params as unknown as Record<string, unknown>);
  }

  /**
   * 修改 DNS 解析记录
   *
   * NOTE: 与删除接口一致 —— 记录标识为纯数字时同时以内部 id 和 record_id 两种
   * 形式下发，兼容上游对两种字段的不同要求。
   */
  async updateDnsRecord(params: UpdateDnsRecordParams): Promise<ActionResponse> {
    const payload: Record<string, unknown> = { ...params };
    const numId = Number(params.record_id);
    if (!isNaN(numId) && numId > 0) {
      payload.id = numId;
    }
    payload.record_id = String(params.record_id);

    return this.request<ActionResponse>("dns_records", "update", "POST", payload);
  }

  /**
   * 删除 DNS 解析记录
   *
   * NOTE: subdomainId 放宽为 number | string，理由同 listDnsRecords。
   */
  async deleteDnsRecord(subdomainId: number | string, recordId: string | number): Promise<ActionResponse> {
    const params: Record<string, unknown> = {
      subdomain_id: subdomainId
    };
    
    // 如果是纯数字或数值型字符串，作为内部 id 传递；同时补充 record_id 保证兼容
    const numId = Number(recordId);
    if (!isNaN(numId) && numId > 0) {
      params.id = numId;
      params.record_id = String(recordId);
    } else {
      params.record_id = String(recordId);
    }

    return this.request<ActionResponse>("dns_records", "delete", "POST", params);
  }

  /**
   * WHOIS 查询域名可注册性
   */
  async whois(domain: string): Promise<{ success: boolean; domain?: string; registered?: boolean; status?: string; registered_at?: string; expires_at?: string; registrant_email?: string; nameservers?: string[]; message?: string }> {
    return this.request<{ success: boolean; domain?: string; registered?: boolean; status?: string; registered_at?: string; expires_at?: string; registrant_email?: string; nameservers?: string[]; message?: string }>("whois", "", "GET", {
      domain
    });
  }
}
