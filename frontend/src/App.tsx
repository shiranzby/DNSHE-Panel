import React, { useState, useEffect, useMemo, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Globe,
  Key,
  Database,
  ScrollText,
  RefreshCw,
  Plus,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  X,
  Info,
  ShieldCheck,
  MoreVertical,
  Server,
  Settings,
  UserCheck,
  Search,
  Sparkles,
  Play,
  Download,
  LayoutDashboard,
  Menu,
  Bell,
  Sun,
  Moon,
  Activity,
  LogIn,
  Send,
  Save,
  Pencil,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
  Cloud,
  ExternalLink,
  Copy,
  Gift,
  Rocket,
  Award,
  Lock,
  Filter,
  RotateCcw
} from "lucide-react";
import { toASCII, hasNonASCII, toUnicode } from "./punycode";
import {
  loadWordBanks,
  saveWordBanks,
  makeBankId,
  buildDefaultBanks,
  parseWords,
  BANK_KIND_META,
  type WordBank,
  type BankKind
} from "./wordbanks";
import {
  parseRule,
  countCombos,
  generateCombos,
  BUILTIN_TOKENS
} from "./rulegen";
import {
  DNS_TYPE_OPTIONS,
  CF_DNS_TYPE_OPTIONS,
  CF_DNS_TYPE_SET,
  needsDnsPriority,
  dnsRecordKey,
  toRelativeRecordName,
  parseDnsBatchInput,
  buildDnsEditTargets,
  type ParsedDnsLine
} from "./dnsrecords";

// API 响应基本接口
export interface ApiResponse {
  success: boolean;
  message?: string;
  error_code?: string;
}

// 域名接口
interface Domain {
  id: number;
  account_id: number;
  account_alias: string;
  subdomain: string;
  rootdomain: string;
  full_domain: string;
  status: string;
  created_at?: string;
  expires_at: string;
  last_renewed_at: string | null;
  has_dns?: number | boolean;
  ns1?: string;
  ns2?: string;
  dns_provider?: string | null;
  provider_account_id?: string | number | null;
  disable_ns_management?: boolean;
  /** 上游对象 ID：Cloudflare 行存 zone id；DNSHE 行为空 */
  remote_id?: string | null;
  /** 所属账号的提供商（后端 JOIN accounts 返回） */
  account_provider?: string | null;
}

// 账号接口
interface Account {
  id: number;
  alias: string;
  api_key: string;
  provider?: "dnshe" | "cloudflare";
  created_at: string;
}


// ───────────────── 主域新增：概览聚合 / 域名助力 / API 密钥 ─────────────────

/** `/api/overview` 返回的聚合数据（全部来自本地缓存，不打扰上游） */
interface OverviewData {
  domains: {
    total: number;
    active: number;
    expired: number;
    expiring_soon: number;
    /** 已委派 = NS 已指向 DNSHE 之外（如 Cloudflare） */
    delegated: number;
    /** 未委派 = 仍走 DNSHE 默认解析 */
    not_delegated: number;
  };
  accounts: { total: number; dnshe: number; cloudflare: number };
  quota: {
    total: number;
    used: number;
    available: number;
    /** 本次聚合里「没查到的账号」数 —— 其数值是 0，求和时必须跳过，否则合计算错 */
    failed: number;
    accounts: OverviewQuotaAccount[];
  };
  /** 助力快照尚未同步过时为 null */
  assist: OverviewAssist | null;
}

interface OverviewQuotaAccount {
  account_id: number;
  alias: string;
  used: number;
  base: number;
  invite_bonus: number;
  total: number;
  available: number;
  error: string | null;
}

interface OverviewAssist {
  updated_at: string | null;
  account_count: number;
  assist_remaining: number;
  assist_limit: number;
  managed_domains: number;
  upgraded_domains: number;
  non_upgraded_domains: number;
}

/** 助力快照里的单个账号 */
interface AssistAccount {
  account_id: number;
  name: string;
  assist_required?: number;
  helper_assist_limit?: number;
  helper_assist_count?: number;
  helper_assist_remaining?: number;
  helper_limit_reached?: boolean;
  quota?: Record<string, unknown> | null;
  domains?: AssistDomain[];
  assist_logs?: AssistLogRow[];
  error?: string;
}

/** 助力快照里的单个域名，status 三态：upgraded 永久 / in_progress 助力中 / eligible 可助力 */
interface AssistDomain {
  id: number;
  domain: string;
  status: "upgraded" | "in_progress" | "eligible" | string;
  never_expires?: number;
  expires_at?: string | null;
  assist_code?: string;
  assist_count?: number;
  target_assists?: number;
}

;/** 单条助力日志（上游 assist_logs，role=assisted 表示我们的账号帮了别人） */
interface AssistLogRow {
  id?: number | string;
  role?: string;
  domain?: string;
  assist_code?: string;
  /** 对方（助力码主人）—— DNSHE 侧就是脱敏的，原样展示 */
  counterpart?: string;
  created_at?: string;
}

interface AssistHistoryEntry {
  ts: string;
  assist_code: string;
  count: number;
  accounts?: string[];
}

/** 密钥列表按账号分组（「全部账号」视图用） */
interface ApiKeyGroup {
  account_id: number;
  alias: string;
  keys: ApiKeyRow[];
  error?: string;
}

/** API 密钥（上游 keys/list + 本地 Secret 登记合并后的形态） */
interface ApiKeyRow {
  key_id: number | null;
  key_name: string;
  api_key: string;
  status?: string | null;
  request_count: number | null;
  last_used_at: string | null;
  remote_created_at: string | null;
  /** 是否在本面板创建/重置/回填过 —— 决定 Secret 能否回显 */
  has_secret: boolean;
}

// 配额接口
interface Quota {
  account_id: number;
  alias: string;
  used: number;
  base: number;
  invite_bonus: number;
  total: number;
  available: number;
  error?: string;
}

// DNS 解析记录接口（DNSHE 与 Cloudflare 共用：CF 的 id 是字符串、TTL 1 表示自动）
interface DnsRecord {
  id: number | string;
  record_id?: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  priority: number | null;
  line: string | null;
  proxied?: boolean;
}

// 日志接口
interface AppLog {
  id: number;
  type: "info" | "success" | "warning" | "error";
  category: "sync" | "renew" | "system";
  message: string;
  details: string | null;
  created_at: string;
}

/** 简易异步等待工具（用于轮询后台同步进度） */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 域名显示用的零宽字符占位
 *
 * NOTE: 有用户注册了以零宽字符（U+200B 等）为前缀的域名，直接显示时看起来像
 * 「.ddns.ge」，容易被当成显示异常或空空前缀。仅在渲染时替换为可见的 ◌ 占位符，
 * 复制、搜索、Cloudflare 匹配仍使用原始完整域名，不受影响。
 */
const INVISIBLE_CHAR_RE = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;
const displayDomain = (value: string): string =>
  String(value || "").replace(INVISIBLE_CHAR_RE, "◌");

/**
 * Cloudflare 官方云朵图标（simple-icons 路径，品牌橙 #F38020）
 *
 * NOTE: lucide 没有品牌图标。仅用于「Cloudflare 品牌身份」场景（账号分组标题、
 * 账号卡片）；解析记录表格里的橙色云代理开关仍用 lucide Cloud，表达的是
 * 代理状态语义而不是品牌。
 */
const CloudflareIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="#F38020" className={className} aria-hidden="true">
    <path d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727" />
  </svg>
);

/**
 * 带「显示 / 隐藏」小眼睛的密码输入框
 *
 * 用在所有 type="password" 的位置（登录、初始化、修改密码、API Secret），
 * 让用户能自查手输 / 粘贴的内容，省掉「输了两遍还是不匹配」的来回。
 *
 * NOTE: 必须定义在 App() 外面。若写成 App 内部的组件，App 每次重渲染都会生成
 * 新的组件类型，React 会卸载重挂载整棵子树 —— 明暗态会被重置，输入框还会丢焦点。
 *
 * NOTE: 眼睛按钮一定要写 type="button"。登录页与初始化表单是真 <form onSubmit>，
 * button 默认 type="submit"，点一下眼睛就会顺手把表单提交掉。
 *
 * NOTE: name / autoComplete 一律原样透传给 input，不在这里加工。本项目为了压制
 * Chrome 的凭据预填，刻意把修改密码的三个框都标成 new-password、并给 name 取了
 * 不像 username 的值（见「修改登录密码」处的注释），组件替调用处改写会破坏这套约定。
 */
const PasswordInput: React.FC<{
  value: string;
  onChange: (value: string) => void;
  className: string;
  placeholder?: string;
  name?: string;
  autoComplete?: string;
  required?: boolean;
}> = ({ value, onChange, className, placeholder, name, autoComplete, required }) => {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        /* 明文态切成 type="text"；pr-10 给右侧眼睛让位，避免长密码钻到图标底下。
           Tailwind 生成的 CSS 里 pr-* 排在 px-* 之后，所以能盖住调用处的 px-3 / px-3.5 */
        type={visible ? "text" : "password"}
        name={name}
        autoComplete={autoComplete}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${className} pr-10`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        /* 命中区撑满输入框高度，窄屏上也够点 */
        className="absolute inset-y-0 right-0 px-3 flex items-center text-content-muted hover:text-content-primary transition-colors"
        title={visible ? "隐藏密码" : "显示密码"}
        aria-label={visible ? "隐藏密码" : "显示密码"}
      >
        {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
};

/**
 * 解析线路（Line）可选值
 *
 * NOTE: 取自官网 DNS 管理页 <select name="line"> 的 option value —— 提交值是英文代码
 * 而不是中文标签（「电信」只是显示文案，实际提交 telecom），且 oversea 没有尾部的 s。
 * API 文档只把 line 描述为「解析线路（us.ci/cn.mt可用，其他域名自动忽略）」，从未列出
 * 合法取值，因此这份清单以官网表单为准。
 */
const DNS_LINE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "default", label: "默认" },
  { value: "telecom", label: "电信" },
  { value: "unicom", label: "联通" },
  { value: "mobile", label: "移动" },
  { value: "oversea", label: "海外" },
  { value: "edu", label: "教育网" }
];

/**
 * 支持按线路解析的 NS 后缀默认名单
 *
 * NOTE: 根域的 NS 记录暴露了它实际托管在谁家 DNS 上，这是判断「是否支持按线路
 * （运营商/地域）解析」最有语义的信号 —— 阿里云 DNS 本身就提供运营商线路，
 * 而 DNSHE 自建 NS 不提供。实测九个根域名分成三组，与官网标注完全对得上：
 *   cn.mt / us.ci                  -> vip7/vip8.alidns.com    支持线路
 *   bbroot.com / bot.cd / ccwu.cc  -> a/b.nic.dnshe.org       不支持
 *   cc.cd / ddns.ge / de5.net/l.cd -> a/b.ns.dnshe.org        不支持
 * 名单可在设置页增删，厂商日后把根域迁到别家（或另接一家支持线路的 DNS）时
 * 不必改代码。
 */
const DEFAULT_LINE_NS_SUFFIXES = ["alidns.com"];

/**
 * 线路支持判定的兜底信号：解析服务商账号 ID（domains_cache.provider_account_id）
 *
 * NOTE: 这是 NS 判定之前用的主信号，现已降级为兜底 —— 仅在拿不到根域 NS 时
 * （首次加载未完成、后端 DoH 出站失败）使用，因此不再提供设置页 UI。
 * 实测 us.ci / cn.mt 该值为 1，其余 7 个根域名为 7 或 8，两组无交集；但文档
 * 从未说明该字段语义，属实测相关性而非契约，详见 src/dnshe.ts 里的注释。
 */
const DEFAULT_LINE_PROVIDERS = ["1"];

/**
 * 可一键委派到 Cloudflare 的根域名名单
 *
 * 🔴 判据是 **Public Suffix List**，不是「域名有几个点」。Cloudflare 用它区分
 * 「可注册根域」和「子域」：`x.<root>` 只有当 `<root>` 本身是 public suffix 时
 * 才算根域，免费版才能为它建 full setup zone 并把 NS 委派过去；否则 CF 视其为
 * 子域，Free/Pro 直接拒绝（真委派要 Enterprise）。
 *
 * DNSHE 的 9 个根里只有这 4 个进了 PSL 的 PRIVATE 段（提交者标注
 * `DNSHE : https://www.dnshe.com`）：us.ci / cc.cd / de5.net / ccwu.cc；
 * 另外 5 个（l.cd / cn.mt / bot.cd / ddns.ge / bbroot.com）不在 PSL 里。
 * 复核脚本：`dnshe-deploy/.apitmp/psl-check.py`（每次重拉 PSL，不信任本地副本）。
 *
 * ⚠️ 本表是后端 `src/index.ts` 的 `CF_DELEGATABLE_ROOTS` 的**镜像**，只用来决定
 * 菜单项「可用 / 禁用 + 原因」的渲染；**真正的准入判定在后端**（前端被绕过也进不来）。
 * 两处必须同步，`.apitmp/verify-r19.mjs` 会直接读两个源文件比对集合。
 */
const CF_DELEGATABLE_ROOTS = ["us.ci", "cc.cd", "de5.net", "ccwu.cc"];

/** 该域名的根是否可委派（命中则返回命中的根，否则 null） */
const matchDelegatableRoot = (dom: { full_domain: string; rootdomain: string }): string | null => {
  const root = String(dom.rootdomain || "").trim().toLowerCase();
  const full = String(dom.full_domain || "").trim().toLowerCase();
  return CF_DELEGATABLE_ROOTS.find((r) => root === r || full === r || full.endsWith(`.${r}`)) || null;
};

/**
 * 解析线路下拉框
 *
 * NOTE: 不支持线路的域名是「禁用」而不是隐藏 —— 一是保持表单网格对齐，二是上游对
 * 这类域名会静默忽略 line（不报错），不显式拦住的话用户会以为自己设置生效了。
 */
const DnsLineSelect: React.FC<{
  value: string;
  onChange: (value: string) => void;
  supported: boolean;
  className: string;
  disabled?: boolean;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}> = ({ value, onChange, supported, className, disabled, onKeyDown }) => (
  <select
    value={supported ? value || "default" : "default"}
    onChange={(e) => onChange(e.target.value)}
    onKeyDown={onKeyDown}
    disabled={disabled || !supported}
    title={
      supported
        ? "不同运营商/地域可选择对应的解析线路，无特殊需求保持默认"
        : "该域名的根域 NS 不在「解析线路支持名单」内（即其 DNS 托管商不提供线路解析），填了也会被上游静默忽略"
    }
    className={`${className} disabled:opacity-50 disabled:cursor-not-allowed`}
  >
    {(supported ? DNS_LINE_OPTIONS : DNS_LINE_OPTIONS.slice(0, 1)).map((opt) => (
      <option key={opt.value} value={opt.value}>
        {opt.label}
      </option>
    ))}
  </select>
);

/**
 * 概览页网格列数档位
 *
 * NOTE: 上游把「一行 3 个」写死在 grid 类名里 —— 390px 手机端会挤成 3 个窄条，
 *       而宽屏右半边又空着。这里改成用户可调。
 *
 * 🔴 2026-09-30 第15轮重定档位语义（用户反馈「怎么改列数都没反应」）：
 *   - **auto 档独自承担移动端降级**：手机一律 1 列（用户原话「普通移动端的观感，
 *     全部自适应默认为 1 列是最好的」）→ 平板 2 → 桌面 3 → 宽屏 4。
 *   - **显式档（1/2/3/4）选几列就是几列**，不再降级。原来每档都在手机段写死 2 列，
 *     于是 2/3/4/6 在手机上长得一模一样，用户以为控件坏了。选了没反应比选得挤更糟。
 */
const OVERVIEW_COL_CLASS: Record<string, string> = {
  auto: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
  "1": "grid-cols-1",
  "2": "grid-cols-2",
  "3": "grid-cols-3",
  "4": "grid-cols-4",
};

/**
 * 账户配额卡的列数档位
 *
 * 与指标卡**同一套档位语义**（手机 auto = 1 列）。原注释说「配额卡信息量小、手机端从 2 列起」，
 * 但用户 2026-09-30 明确要求概览页手机端默认 1 列，两者改成一致。
 */
const QUOTA_COL_CLASS: Record<string, string> = {
  auto: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
  "1": "grid-cols-1",
  "2": "grid-cols-2",
  "3": "grid-cols-3",
  "4": "grid-cols-4",
};

/**
 * Cloudflare zone 卡的列数档位
 *
 * 上游把 zone 卡写死成 lg:grid-cols-3，宽屏右半边一直空着。
 *
 * 🔴 与概览页的**唯一区别**：CF 页的列数选择器手机端不展示（用户原话「移动端就默认一列，
 *    不需要选择几列的控件」）⇒ 手机上看不到、也改不了这个值。若各档仍然直写
 *    `grid-cols-3`，用户在桌面选过「3 列」后换手机打开就会莫名其妙是 3 列，
 *    而手机上又没有入口改回去。所以每档都锁死手机段为 `grid-cols-1`，只有 ≥sm 才释放档位。
 */
const CF_COL_CLASS: Record<string, string> = {
  auto: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
  "1": "grid-cols-1",
  "2": "grid-cols-1 sm:grid-cols-2",
  "3": "grid-cols-1 sm:grid-cols-3",
  "4": "grid-cols-1 sm:grid-cols-4",
};

/**
 * 列数档位选项（概览页与 Cloudflare 页共用）
 *
 * 🔴 2026-09-30 第16轮：用户要求「适配自动、1列、2列、3列、4列，不需要5列6列的显示」。
 *   原来只有 2/3/4/6 四档，缺最常用的「1 列」、多了几乎没人用的「6 列」
 *   —— 手机上一张卡一行就得选 `auto`，而 `auto` 在桌面又会变 3/4 列，用户没得挑。
 *   现在五档：自动 + 1/2/3/4。
 *
 * ⚠️ 档位集合一变，`localStorage` 里的历史值（如 `"6"`）就成了**无对应 option 的值**，
 *    `<select value="6">` 会渲染成空白。渲染侧本来就有 `|| CLASS.auto` 兜底，
 *    但选择器本身会看起来"没选中任何一项"，所以读取时按白名单过滤一遍（见 overviewCols 的初始化）。
 */
const OVERVIEW_COL_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "1", label: "1 列" },
  { value: "2", label: "2 列" },
  { value: "3", label: "3 列" },
  { value: "4", label: "4 列" },
];

/**
 * 顶部搜索框的「每页配置」
 *
 * NOTE: 原先这个框在**所有页面**都写着「搜索域名（回车跳转域名列表）」，
 *       于是在密钥页想找一把密钥、在账号页想找一个账号，都会莫名其妙被弹到域名列表。
 *       搜索框应该检索「当前这一页在管的东西」：见 §5 的窄屏重排原则同理 —— 控件要贴着上下文。
 */
const SEARCH_CONFIG: Record<string, { placeholder: string; enabled: boolean }> = {
  dashboard: { placeholder: "搜索域名（回车跳转域名列表）", enabled: true },
  domains: { placeholder: "搜索域名（支持中文与 Punycode）", enabled: true },
  cloudflare: { placeholder: "搜索 zone 或账号", enabled: true },
  assist: { placeholder: "搜索域名或账号", enabled: true },
  accounts: { placeholder: "搜索账号别名或 API Key", enabled: true },
  apikeys: { placeholder: "搜索密钥名称或 API Key", enabled: true },
  register: { placeholder: "搜索域名（回车跳转域名列表）", enabled: true },
  quota: { placeholder: "搜索账号", enabled: true },
  logs: { placeholder: "搜索日志内容", enabled: true },
  /*
   * 设置页：2026-09-30 第16轮之前是 `enabled: false`（「固定表单，没有可检索的列表」）。
   * 用户要求「设置页也可以适配顶栏的像其他页一样的输入搜索框，改为搜索功能即可
   * （后端地址、账户安全、自动续期、解析线路支持名单、通知渠道以及他们的各子级标题
   * 如修改登录密码等）都可以搜索」。
   * ⇒ 设置页的「可检索列表」就是**小节卡片**本身，按 SETTINGS_SECTIONS 的 keywords 匹配。
   */
  settings: { placeholder: "搜索设置项（如：密码 / 续期 / 渠道）", enabled: true },
};

/**
 * 设置页各小节（同时服务两件事：顶栏搜索按关键词过滤、抽屉里的二级菜单跳转）
 *
 * - `id`：卡片 DOM 的 id，抽屉二级菜单点进来时 `scrollIntoView` 用。
 * - `label`：抽屉二级菜单显示的名字。
 * - `keywords`：搜索用的关键词串（含**子标题**，如「修改登录密码」「两步验证」）——
 *   用户明确要求「他们的各子级标题如修改登录密码等都可以搜索」。
 *   匹配方式是「关键词串包含用户输入」（见 settingsSectionVisible），
 *   所以这里要把同义说法、中英文都写进去，漏一个就是搜不到。
 */
const SETTINGS_SECTIONS: Array<{ id: string; label: string; keywords: string }> = [
  {
    id: "settings-backend",
    label: "后端地址",
    keywords:
      "后端地址 后端 worker 地址 workers.dev 自定义后端 服务器地址 已配置 未配置 自动推演 恢复自动",
  },
  {
    id: "settings-security",
    label: "账户安全",
    keywords:
      "账户安全 当前管理员 管理员用户名 修改登录密码 修改密码 原密码 新密码 确认新密码 同时修改用户名 保存新密码 两步验证 2fa totp 动态码 二维码 密钥 secret 开启两步验证 关闭 2fa 已开启 未开启",
  },
  {
    id: "settings-renew",
    label: "自动续期",
    keywords: "自动续期 启用自动续期 续期阈值 阈值 天数 即将到期 renew",
  },
  {
    id: "settings-line-ns",
    label: "解析线路支持名单",
    keywords:
      "解析线路支持名单 线路解析 线路 ns 后缀 ns 记录 根域名 判定结果 电信 联通 移动 海外 教育网 添加 恢复默认 清空实测标记 重新查询 ns",
  },
  {
    id: "settings-notify",
    label: "通知渠道",
    keywords:
      "通知渠道 渠道选择 保存全部设置 邮箱 smtp 端口 发件邮箱 收件邮箱 发件人显示名 授权码 telegram 钉钉 飞书 企业微信 server酱 方糖 通用 webhook bot token chat id sendkey",
  },
];

/**
 * 概览页指标卡
 *
 * 传了 onClick 就渲染成 button（可跳转到对应标签页），否则是纯展示的 div。
 * 抽出来是因为概览现在有三组共 12 张卡，逐张手写会重复太多。
 */
function OverviewMetricCard({
  label,
  value,
  hint,
  icon,
  color,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon: React.ReactNode;
  color: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <div className={`flex items-center gap-2 min-w-0 ${color}`}>
        <span className="flex-shrink-0">{icon}</span>
        <span className="text-[11px] sm:text-xs font-semibold text-content-muted uppercase tracking-wide truncate">
          {label}
        </span>
      </div>
      <div className="text-2xl sm:text-3xl font-black text-content-primary">{value}</div>
      {/* 备注行始终占位：没有备注就留空，否则同一行里「有备注」的卡会比「没备注」的高一截 */}
      <div className="text-[11px] text-content-muted truncate min-h-[15px]">{hint || "\u00A0"}</div>
    </>
  );

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className="glass-card rounded-2xl p-4 sm:p-5 text-left flex flex-col gap-2 sm:gap-3 group min-w-0"
      >
        {inner}
      </button>
    );
  }
  return (
    <div className="glass-card rounded-2xl p-4 sm:p-5 flex flex-col gap-2 sm:gap-3 min-w-0">{inner}</div>
  );
}

/**
 * 把批量粘贴框的文本切成有效行
 *
 * 分隔符为换行 / 分号（中英文），顺手去掉空行与以 # 开头的注释行。
 *
 * NOTE: 原先「解析逻辑」与「按钮上显示的条数」各写了一份，且只有解析那侧过滤 # 注释，
 *       于是带注释粘贴时按钮显示 3 条、实际只绑定 2 条。统一到这里，两边必然一致。
 */
function splitBatchLines(text: string): string[] {
  return text
    .split(/[\n;；]+/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/**
 * API Key 掩码展示：前 8 位 + *** + 后 4 位
 *
 * NOTE: 原先界面上是就地写 substring 链的，同一份表达式抄了两遍（列表 + 编辑弹窗）。
 *       更要紧的是 Key 缺失时 `undefined.substring` 会直接把整个页面渲染炸掉，
 *       这里统一收口并补空值保护；Key 正常时的输出与原内联写法逐字一致。
 */
function maskApiKey(key?: string | null): string {
  const k = key || "";
  if (!k) return "—";
  return `${k.substring(0, 8)}***${k.substring(k.length - 4)}`;
}

/**
 * 主应用组件 - 提供 DNSHE 域名管理控制面板
 */
export default function App() {
  // 当前处于的选项卡（通过 URL hash 持久化，刷新/前进后退保持所在页面）
  type TabKey = "dashboard" | "domains" | "cloudflare" | "assist" | "accounts" | "apikeys" | "register" | "quota" | "logs" | "settings";
  const TAB_KEYS: TabKey[] = ["dashboard", "domains", "cloudflare", "assist", "accounts", "apikeys", "register", "quota", "logs", "settings"];
  const tabFromHash = (): TabKey => {
    const h = window.location.hash.replace(/^#\/?/, "") as TabKey;
    return TAB_KEYS.includes(h) ? h : "dashboard";
  };
  const [activeTab, setActiveTab] = useState<TabKey>(tabFromHash);

  // 主题（明/暗）与侧栏折叠状态
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("DNSHE_THEME") as "light" | "dark") || "dark"
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem("DNSHE_SIDEBAR_COLLAPSED") === "1"
  );

  // 手机端侧栏抽屉开关（仅 <md 生效；≥md 侧栏常驻，这个状态用不上）
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /**
   * 抽屉里「展开中的二级菜单」是哪一个（值为顶层页签 key，null = 全部收起）
   *
   * 目前只有「设置」有下级小节：其余页签都是一个整页、没有可拆的子项。
   * 默认全部收起（§6：数量不确定的列表默认收起），否则抽屉一打开就多出 5 行。
   */
  const [navExpanded, setNavExpanded] = useState<string | null>(null);

  /**
   * 是否处于 md 及以上宽度 —— 手机抽屉与桌面常驻侧栏的分界
   *
   * NOTE: 断点值必须与 Tailwind 的 md (768px) 保持一致：同一个 <aside> 既要在
   * ≥md 作为常驻侧栏参与布局流，又要在 <md 作为 fixed 抽屉，而"折叠成图标条"
   * 这件事只在桌面有意义 —— 折叠态是持久化的，若不区分宽度，从桌面带过来的
   * sidebarCollapsed=1 会让手机抽屉也只剩图标，没有文字标签。
   */
  const [isDesktop, setIsDesktop] = useState<boolean>(
    () => window.matchMedia("(min-width: 768px)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = (e: MediaQueryListEvent) => {
      setIsDesktop(e.matches);
      // 升到桌面宽度时顺手关掉抽屉，避免旋转屏幕后遗留一个打开状态
      if (e.matches) setSidebarOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // 图标条模式：只有桌面 + 已折叠时才成立
  const railMode = isDesktop && sidebarCollapsed;

  // 抽屉打开时支持 Esc 关闭
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);
  // 顶部全局搜索词与通知下拉开关
  const [globalSearch, setGlobalSearch] = useState("");
  const [notifOpen, setNotifOpen] = useState(false);
  // 日志页当前分类：登录 / API / 操作 / 全部
  const [logCategory, setLogCategory] = useState<"all" | "auth" | "api" | "operation">("all");

  // 应用设置状态
  interface AppSettings {
    webhook_url: string;
    webhook_type: string;
    tg_token: string;
    tg_chat_id: string;
    renew_threshold_days: string;
    auto_renew: string;
    // 邮箱（SMTP）通知渠道
    smtp_host: string;
    smtp_port: string;
    smtp_user: string;
    smtp_pass: string;
    smtp_from: string;
    smtp_to: string;
  }
  const [settings, setSettings] = useState<AppSettings>({
    webhook_url: "",
    /* 默认渠道 = 邮箱（SMTP）（用户 2026-09-30 定）。库里已存过值时由 /api/settings 覆盖。 */
    webhook_type: "email",
    tg_token: "",
    tg_chat_id: "",
    renew_threshold_days: "180",
    auto_renew: "1",
    smtp_host: "smtp.qq.com",
    smtp_port: "465",
    smtp_user: "",
    smtp_pass: "",
    smtp_from: "",
    smtp_to: "",
  });
  const [settingsConfigured, setSettingsConfigured] = useState<{ tg_token: boolean; webhook_url: boolean; smtp_pass: boolean }>({ tg_token: false, webhook_url: false, smtp_pass: false });
  const [loadingSettings, setLoadingSettings] = useState(false);
  // 设置页本地后端地址输入
  const [backendUrlInput, setBackendUrlInput] = useState(
    () => localStorage.getItem("DNSHE_BACKEND_URL") || ""
  );
  // 后端地址是否处于编辑状态（保存后收起，不常驻显示在输入框）
  const [backendUrlEditing, setBackendUrlEditing] = useState(false);

  // 同步主题到 <html> 类并持久化
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("DNSHE_THEME", theme);
  }, [theme]);

  // 持久化侧栏折叠
  useEffect(() => {
    localStorage.setItem("DNSHE_SIDEBAR_COLLAPSED", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  // 数据列表状态
  const [domains, setDomains] = useState<Domain[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [quotas, setQuotas] = useState<Quota[]>([]);
  const [logs, setLogs] = useState<AppLog[]>([]);

  // 账号筛选、DNS 类型与下拉菜单状态
  const [selectedAccountFilter, setSelectedAccountFilter] = useState<string>("all");
  const [nsTypeFilter, setNsTypeFilter] = useState<"all" | "default" | "external">("all");
  const [openActionMenuId, setOpenActionMenuId] = useState<number | null>(null);

  // Loading 状态
  const [loadingDomains, setLoadingDomains] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [loadingQuotas, setLoadingQuotas] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Toast 提示状态
  const [toast, setToast] = useState<{ type: "success" | "error" | "info" | "warning"; message: string } | null>(null);

  // 绑定账号表单状态
  const [newAlias, setNewAlias] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [newApiSecret, setNewApiSecret] = useState("");

  // 批量绑定表单状态
  const [batchInput, setBatchInput] = useState("");
  const [batchResults, setBatchResults] = useState<Array<{ api_key: string; alias?: string; success: boolean; message: string }> | null>(null);

  // 绑定账号弹窗（统一承载 DNSHE / Cloudflare 两种提供商与 单个 / 批量 两种方式）
  const [bindModalOpen, setBindModalOpen] = useState(false);
  const [bindProvider, setBindProvider] = useState<"dnshe" | "cloudflare">("dnshe");
  const [bindMode, setBindMode] = useState<"single" | "batch">("single");
  // 批量输入框引用（自绘拖拽调整高度用）
  const batchTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 批量输入框自绘拖拽手柄：直接改 DOM 高度，不走 React 渲染，保证跟手
  const handleBatchResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const ta = batchTextareaRef.current;
    if (!ta) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = ta.offsetHeight;
    const move = (ev: PointerEvent) => {
      const h = Math.max(96, Math.min(480, startH + (ev.clientY - startY)));
      ta.style.height = `${h}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    // 指针被系统取消（来电、手势抢占、切窗口）时不会再有 pointerup，
    // 不接 pointercancel 就会把 move/up 永久挂在 window 上
    window.addEventListener("pointercancel", up);
  };

  // 修改账号表单状态
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [editAlias, setEditAlias] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [editApiSecret, setEditApiSecret] = useState("");

  // 选中的域名与 DNS 记录管理模态框状态
  const [selectedDomain, setSelectedDomain] = useState<Domain | null>(null);
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  const [loadingDns, setLoadingDns] = useState(false);
  const [dnsModalOpen, setDnsModalOpen] = useState(false);

  // 解析记录加载的「请求代号」：只有最后一次发出的请求才有资格写 state。
  // NOTE: 快速连续打开两个域名的解析面板时，先发的请求可能后到，
  //       不设代号就会出现「A 的记录盖掉 B 的面板」——记录表与当前域名对不上。
  const dnsLoadSeqRef = useRef(0);
  const cfLoadSeqRef = useRef(0);

  // 域名列表中被收起的账号分组集合（存 accountId，持久化于本地，刷新后保持上次布局）
  const [collapsedAccounts, setCollapsedAccounts] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_COLLAPSED_ACCOUNTS");
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  });

  // 折叠状态落盘
  const persistCollapsed = (next: Set<number>) => {
    setCollapsedAccounts(next);
    localStorage.setItem("DNSHE_COLLAPSED_ACCOUNTS", JSON.stringify([...next]));
  };

  // 切换单个账号分组展开/收起
  const toggleAccountCollapse = (accountId: number) => {
    const next = new Set(collapsedAccounts);
    if (next.has(accountId)) {
      next.delete(accountId);
    } else {
      next.add(accountId);
    }
    persistCollapsed(next);
  };

  // 展开/收起全部账号分组
  const toggleAllAccounts = () => {
    if (collapsedAccounts.size > 0) {
      persistCollapsed(new Set()); // 存在收起的 → 全部展开
    } else {
      persistCollapsed(new Set(groupedDomains.map(g => g.accountId))); // 全部收起
    }
  };

  // NS 修改模态框状态
  const [nsModalOpen, setNsModalOpen] = useState(false);
  const [nsModalDomain, setNsModalDomain] = useState<Domain | null>(null);
  const [nsRecords, setNsRecords] = useState<DnsRecord[]>([]);
  const [loadingNsModal, setLoadingNsModal] = useState(false);
  const [newCustomNsContent, setNewCustomNsContent] = useState("");
  const [forceReplaceConflict, setForceReplaceConflict] = useState(true);

  // 新建 DNS 记录表单状态
  const [newDnsType, setNewDnsType] = useState("A");
  const [newDnsName, setNewDnsName] = useState("");
  const [newDnsContent, setNewDnsContent] = useState("");
  const [newDnsTtl, setNewDnsTtl] = useState(600);
  const [newDnsPriority, setNewDnsPriority] = useState<number>(10);
  const [newDnsLine, setNewDnsLine] = useState("");
  const [dnsFormOpen, setDnsFormOpen] = useState(false);

  // 行内修改解析记录状态（editingDnsKey 为 dnsRecordKey(rec)，null 表示当前没有在编辑）
  const [editingDnsKey, setEditingDnsKey] = useState<string | null>(null);
  const [editDnsType, setEditDnsType] = useState("A");
  const [editDnsName, setEditDnsName] = useState("");
  const [editDnsContent, setEditDnsContent] = useState("");
  const [editDnsTtl, setEditDnsTtl] = useState(600);
  const [editDnsPriority, setEditDnsPriority] = useState<number>(10);
  const [editDnsLine, setEditDnsLine] = useState("");

  // 批量添加解析记录面板状态（面板上的类型/主机记录/TTL 等作为每行缺省字段的默认值）
  const [dnsBatchOpen, setDnsBatchOpen] = useState(false);
  const [dnsBatchInput, setDnsBatchInput] = useState("");
  const [dnsBatchType, setDnsBatchType] = useState("A");
  const [dnsBatchName, setDnsBatchName] = useState("@");
  const [dnsBatchTtl, setDnsBatchTtl] = useState(600);
  const [dnsBatchPriority, setDnsBatchPriority] = useState<number>(10);
  const [dnsBatchLine, setDnsBatchLine] = useState("");
  const [dnsBatchResults, setDnsBatchResults] = useState<Array<{ label: string; success: boolean; message: string }> | null>(null);

  // 批量删除：已勾选的解析记录键集合
  const [selectedDnsKeys, setSelectedDnsKeys] = useState<Set<string>>(new Set());

  // 批量修改面板状态
  //
  // NOTE: 勾选哪个字段就只覆盖那个字段，其余字段沿用每条记录的原值 —— 批量选中的
  // 记录往往只有 TTL / 线路 需要统一，记录值各不相同（如 6 条不同 IP 的 AAAA），
  // 整表覆盖会把它们改成一模一样。
  const [dnsEditPanelOpen, setDnsEditPanelOpen] = useState(false);
  const [dnsEditFields, setDnsEditFields] = useState({
    type: false,
    name: false,
    content: false,
    ttl: true,
    line: false,
    priority: false,
    // DNSHE 记录没有代理开关，该字段只为满足共享的 buildDnsEditTargets 签名，恒为 false
    proxied: false
  });
  const [batchEditType, setBatchEditType] = useState("A");
  const [batchEditName, setBatchEditName] = useState("@");
  const [batchEditTtl, setBatchEditTtl] = useState(600);
  const [batchEditLine, setBatchEditLine] = useState("");
  const [batchEditPriority, setBatchEditPriority] = useState<number>(10);
  // 记录值逐条给值（键为 record_id）：勾选「记录值」后每行都能单独改，留空即保持原值
  const [batchEditContents, setBatchEditContents] = useState<Record<string, string>>({});
  const [dnsEditResults, setDnsEditResults] = useState<Array<{ label: string; success: boolean; message: string }> | null>(null);

  // ===== Cloudflare 标签页状态（与 DNSHE 的状态相互独立，复用同一套后端路由） =====
  // zones 列表与账号筛选
  const [cfZones, setCfZones] = useState<Domain[]>([]);
  const [loadingCfZones, setLoadingCfZones] = useState(false);
  const [cfAccountFilter, setCfAccountFilter] = useState<string>("all");
  // zones 分组的收起状态（独立于 DNSHE 域名页的 collapsedAccounts，持久化于本地，
  // 刷新 / 重开浏览器后保持上次布局）
  const [cfCollapsedAccounts, setCfCollapsedAccounts] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_CF_COLLAPSED_ACCOUNTS");
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  });

  // 折叠状态落盘
  const persistCfCollapsed = (next: Set<number>) => {
    setCfCollapsedAccounts(next);
    localStorage.setItem("DNSHE_CF_COLLAPSED_ACCOUNTS", JSON.stringify([...next]));
  };
  // 绑定 Cloudflare 账号表单（单个 / 批量共用一套 Token 来源）
  const [cfNewAlias, setCfNewAlias] = useState("");
  const [cfNewToken, setCfNewToken] = useState("");
  // Cloudflare 批量绑定：每行一条「api_token [别名]」
  const [cfBatchBindInput, setCfBatchBindInput] = useState("");
  const [cfBatchBindResults, setCfBatchBindResults] = useState<Array<{ api_key: string; alias?: string; success: boolean; message: string }> | null>(null);
  // 编辑 Cloudflare 账号（换 Token / 改别名）
  const [cfEditingAccount, setCfEditingAccount] = useState<Account | null>(null);
  const [cfEditAlias, setCfEditAlias] = useState("");
  const [cfEditToken, setCfEditToken] = useState("");
  // CF DNS 记录面板（模态框结构同 DNSHE 的 DNS 面板，但没有「解析线路」概念、多了「代理」开关）
  const [cfDnsModalOpen, setCfDnsModalOpen] = useState(false);
  const [cfSelectedZone, setCfSelectedZone] = useState<Domain | null>(null);
  const [cfRecords, setCfRecords] = useState<DnsRecord[]>([]);
  const [loadingCfRecords, setLoadingCfRecords] = useState(false);
  // 记录列表加载失败的原因（区别于「确实没有记录」的空态，避免误导用户去添加）
  const [cfRecordsError, setCfRecordsError] = useState<string | null>(null);
  // CF 新建记录表单（TTL 取值 1 表示 Cloudflare 的「自动」）
  const [cfFormOpen, setCfFormOpen] = useState(false);
  const [cfNewType, setCfNewType] = useState("A");
  const [cfNewName, setCfNewName] = useState("");
  const [cfNewContent, setCfNewContent] = useState("");
  const [cfNewTtl, setCfNewTtl] = useState(1);
  const [cfNewPriority, setCfNewPriority] = useState<number>(10);
  const [cfNewProxied, setCfNewProxied] = useState(false);
  // CF 行内修改
  const [cfEditingKey, setCfEditingKey] = useState<string | null>(null);
  const [cfEditType, setCfEditType] = useState("A");
  const [cfEditName, setCfEditName] = useState("");
  const [cfEditContent, setCfEditContent] = useState("");
  const [cfEditTtl, setCfEditTtl] = useState(1);
  const [cfEditPriority, setCfEditPriority] = useState<number>(10);
  const [cfEditProxied, setCfEditProxied] = useState(false);
  // CF 批量添加
  const [cfBatchOpen, setCfBatchOpen] = useState(false);
  const [cfBatchInput, setCfBatchInput] = useState("");
  const [cfBatchType, setCfBatchType] = useState("A");
  const [cfBatchName, setCfBatchName] = useState("@");
  const [cfBatchTtl, setCfBatchTtl] = useState(1);
  const [cfBatchPriority, setCfBatchPriority] = useState<number>(10);
  const [cfBatchProxied, setCfBatchProxied] = useState(false);
  const [cfBatchResults, setCfBatchResults] = useState<Array<{ label: string; success: boolean; message: string }> | null>(null);
  // CF 批量修改面板（字段：记录值 / TTL / 代理）
  const [cfSelectedKeys, setCfSelectedKeys] = useState<Set<string>>(new Set());
  // 从 DNSHE 域名页交叉提示跳转过来时待定位的 zone（domains_cache id），短暂高亮后自动清除
  const [cfHighlightZoneId, setCfHighlightZoneId] = useState<number | null>(null);
  // CF zone 到期时间：DNSHE 注册的取本地缓存，其余经后端 RDAP 查注册商（后端缓存 7 天）
  const [cfExpiryMap, setCfExpiryMap] = useState<Record<string, { found: boolean; expires_at?: string }>>({});
  const [cfEditPanelOpen, setCfEditPanelOpen] = useState(false);
  const [cfEditFields, setCfEditFields] = useState({
    content: false,
    ttl: true,
    proxied: false
  });

  // ── 一键委派到 Cloudflare（第19轮）──
  // 两阶段：confirm（确认 + 选 CF 账号）→ records（列出待迁移记录让人确认）
  // 阶段划分是刻意的：委派写操作先做完，记录迁移必须由人逐条过目后才落笔
  const [delegateDomain, setDelegateDomain] = useState<Domain | null>(null);
  const [delegateStep, setDelegateStep] = useState<"confirm" | "records">("confirm");
  const [delegateCfAccountId, setDelegateCfAccountId] = useState<string>("");
  const [delegateLoading, setDelegateLoading] = useState(false);
  // 后端返回的业务原因就地展示（不弹 toast），用户需要照着原因改 Token / 换账号
  const [delegateError, setDelegateError] = useState("");
  const [delegateResult, setDelegateResult] = useState<{
    zone_id: string;
    zone_numeric_id: number;
    zone_status: string;
    zone_reused: boolean;
    name_servers: string[];
    ns_written: string[];
    ns_failed: Array<{ ns: string; msg: string }>;
    ns_management_disabled: boolean;
    removed_records: string[];
    records: DnsRecord[];
    cf_account_alias: string;
  } | null>(null);
  // 勾选用「记录在清单里的下标」作键：清单拿到后就冻结，下标即稳定标识
  const [delegateSelectedKeys, setDelegateSelectedKeys] = useState<Set<string>>(new Set());
  const [delegateApplyResults, setDelegateApplyResults] = useState<Array<{ label: string; success: boolean; message: string }> | null>(null);
  const [cfBatchEditTtl, setCfBatchEditTtl] = useState(1);
  const [cfBatchEditProxied, setCfBatchEditProxied] = useState(false);
  const [cfBatchEditContents, setCfBatchEditContents] = useState<Record<string, string>>({});
  const [cfEditResults, setCfEditResults] = useState<Array<{ label: string; success: boolean; message: string }> | null>(null);

  // DNSHE 系统根域名 (支持动态添加)
  const DEFAULT_ROOT_DOMAINS = [
    "us.ci", "l.cd", "cc.cd", "cn.mt", "bot.cd", "de5.net", "ccwu.cc", "ddns.ge", "bbroot.com"
  ];

  const [allRootDomains, setAllRootDomains] = useState<string[]>(() => {
    const saved = localStorage.getItem("DNSHE_CUSTOM_ROOT_DOMAINS");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch (e) {}
    }
    return DEFAULT_ROOT_DOMAINS;
  });
  const [newRootInput, setNewRootInput] = useState("");

  // 域名删除确认状态（删除不可逆，必须输入完整域名二次确认）
  const [deleteModalDomain, setDeleteModalDomain] = useState<Domain | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deleteError, setDeleteError] = useState("");

  // 域名注册与查重状态
  const [searchSubdomain, setSearchSubdomain] = useState("");
  const [searchRootdomain, setSearchRootdomain] = useState("us.ci");
  const [whoisLoading, setWhoisLoading] = useState(false);
  const [whoisResult, setWhoisResult] = useState<{
    searchedDomain?: string;
    success?: boolean;
    registered?: boolean;
    status?: string;
    registered_at?: string;
    expires_at?: string;
    registrant_email?: string;
    nameservers?: string[];
    message?: string;
  } | null>(null);
  const [registerAccountId, setRegisterAccountId] = useState<number | "">("");

  // 规则多域名查重状态
  const [regMode, setRegMode] = useState<"single" | "batch">("single");
  const [batchRules, setBatchRules] = useState<string>("");
  const [excludeChars, setExcludeChars] = useState<string>("");
  const [selectedRoots, setSelectedRoots] = useState<string[]>([]);
  const [batchLength, setBatchLength] = useState<number>(2);
  const [scanStatus, setScanStatus] = useState<"idle" | "running" | "paused" | "completed">("idle");
  const scanControlRef = useRef<"idle" | "running" | "paused" | "completed">("idle");
  // 「本轮扫描」的代号。每点一次「停止 / 重置」就 +1，新一轮「开始」也 +1。
  //
  // NOTE: 上一轮里已经发出去的 whois 请求还在飞，回来时会照样调 setScanProgress /
  //       setScanLogs / updateScanStatus —— 于是出现过「点了停止，进度条又被推着走」
  //       「停止后状态自己跳回暂停」「重新开始后进度被旧请求拉回去」。
  //       各流水线与 processTask 都记下自己出发时的代号，代号一变就闭嘴返回。
  const scanRunGenRef = useRef(0);
  
  const updateScanStatus = (status: "idle" | "running" | "paused" | "completed") => {
    // 停止 / 重置 = 本报废，递增代号让所有在飞的旧请求静默退出
    if (status === "idle") scanRunGenRef.current++;
    scanControlRef.current = status;
    setScanStatus(status);
  };
  const [scanProgress, setScanProgress] = useState<{ total: number; checked: number; available: number }>({ total: 0, checked: 0, available: 0 });
  const [availableDomainsList, setAvailableDomainsList] = useState<Array<{ fullDomain: string; subdomain: string; rootdomain: string; time: string }>>([]);
  const [scanLogs, setScanLogs] = useState<Array<{ id: number; time: string; text: string; status: "available" | "registered" | "error" | "info" }>>([]);

  // ===== 顺序检测（进位递增）与断点续查状态 =====
  // 顺序模式开关：开启后忽略规则框，按字符集进位顺序惰性生成候选（如 aaa→aab→...）
  const [seqMode, setSeqMode] = useState(false);
  // 顺序模式的字符集与长度
  const [seqCharset, setSeqCharset] = useState<"字母" | "数字" | "字母数字">("字母");
  const [seqLength, setSeqLength] = useState<number>(3);
  // 顺序模式的起始串（留空则从最小串开始，如 aaa）
  const [seqStart, setSeqStart] = useState<string>("");
  // 已保存的断点光标（从 localStorage 恢复，供「继续上次」提示使用）
  const [scanCursor, setScanCursor] = useState<{
    seqMode: boolean;
    charset: string;
    length: number;
    lastCandidate: string;
    taskIndex: number;
    checked: number;
    savedAt: string;
  } | null>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_SCAN_CURSOR");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  // 扫描运行期间实时记录当前进度，供暂停/限流时落盘
  const scanCursorRef = useRef<{ lastCandidate: string; taskIndex: number; checked: number }>({
    lastCandidate: "",
    taskIndex: 0,
    checked: 0
  });

  // 查重池：是否忽略池子强制全部重查（用于刷新可能已过期的结论）
  const [ignorePool, setIgnorePool] = useState(false);

  // ===== 官方保留前缀排除名单 =====
  // DNSHE 官方设置为不可注册的前缀（整词匹配，如 ai 不可注册但 ailu 可以）。
  // 查重前直接剔除，避免浪费 API 配额。名单可编辑并持久化。
  const DEFAULT_RESERVED_PREFIXES = ["ai", "jd", "qq", "mail"];
  const [reservedPrefixes, setReservedPrefixes] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_RESERVED_PREFIXES");
      if (!raw) return DEFAULT_RESERVED_PREFIXES;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : DEFAULT_RESERVED_PREFIXES;
    } catch {
      return DEFAULT_RESERVED_PREFIXES;
    }
  });
  // 是否启用保留前缀排除
  const [enableReservedFilter, setEnableReservedFilter] = useState(
    () => localStorage.getItem("DNSHE_RESERVED_FILTER_OFF") !== "1"
  );
  // 新增保留前缀的输入框
  const [newReservedInput, setNewReservedInput] = useState("");

  // 支持按线路解析的 NS 后缀名单（可增删，持久化于浏览器本地）。
  // 判定依据是根域的 NS 记录落在谁家 DNS 上 —— 上游没有「是否支持线路」的字段。
  const [lineNsSuffixes, setLineNsSuffixes] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_LINE_NS_SUFFIXES");
      if (!raw) return DEFAULT_LINE_NS_SUFFIXES;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : DEFAULT_LINE_NS_SUFFIXES;
    } catch {
      return DEFAULT_LINE_NS_SUFFIXES;
    }
  });
  // 新增 NS 后缀的输入框
  const [newLineNsInput, setNewLineNsInput] = useState("");
  // 「恢复默认」的二次确认框（§9：破坏性操作必须二次确认；这里是覆盖用户手工维护的名单）
  const [restoreNsConfirmOpen, setRestoreNsConfirmOpen] = useState(false);

  // 根域 -> NS 主机名列表的本地镜像（null 表示查过但没查到）。
  // 后端已经把结论缓存在 D1，这份镜像只为让首屏判定不用等网络往返。
  const [rootNs, setRootNs] = useState<Record<string, string[] | null>>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_ROOT_NS");
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  });

  // 实测确认支持线路的根域（从解析记录反推而来，优先级高于 NS 判定）
  const [learnedLineRoots, setLearnedLineRoots] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_LINE_ROOTS");
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    } catch {
      return [];
    }
  });

  // ===== 可编辑词库状态 =====
  // 词库分组列表（首次从内置种子导入，之后持久化在 localStorage）
  const [wordBanks, setWordBanks] = useState<WordBank[]>(() =>
    loadWordBanks(new Set(BUILTIN_TOKENS))
  );
  // 词库管理弹窗开关
  const [bankModalOpen, setBankModalOpen] = useState(false);
  // 正在编辑的分组（null 表示新建）
  const [editingBank, setEditingBank] = useState<WordBank | null>(null);
  // 编辑表单字段
  const [bankFormName, setBankFormName] = useState("");
  const [bankFormKind, setBankFormKind] = useState<BankKind>("cn");
  const [bankFormWords, setBankFormWords] = useState("");

  // 后端 Worker 地址
  const backendUrl = localStorage.getItem("DNSHE_BACKEND_URL") || (import.meta as any).env?.VITE_API_BASE_URL || "";

  // ===== 鉴权与登录状态 =====
  // 当前会话 Token（登录成功后签发；存在即视为已登录）
  const [sessionToken, setSessionToken] = useState<string | null>(
    () => sessionStorage.getItem("DNSHE_SESSION") || localStorage.getItem("DNSHE_SESSION")
  );
  // 是否已向后端查询过鉴权状态（决定登录页显示"登录"还是"首次设置"）
  const [authStatusLoaded, setAuthStatusLoaded] = useState(false);
  // 系统是否已初始化（设置过管理员密码）
  const [authInitialized, setAuthInitialized] = useState(true);
  // 系统是否已开启 2FA（登录页直接展示动态码输入框）
  const [authTwoFaEnabled, setAuthTwoFaEnabled] = useState(false);
  // 本次登录是否需要 2FA 动态码（后端返回 need_2fa 时置真）
  const [loginNeeds2fa, setLoginNeeds2fa] = useState(false);

  // 登录表单状态
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginTotp, setLoginTotp] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");

  // 首次初始化表单状态
  const [setupUsername, setSetupUsername] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupPassword2, setSetupPassword2] = useState("");

  // ===== 账户安全（设置页）状态 =====
  // 当前账户信息（用户名 + 2FA 是否开启）
  const [accountInfo, setAccountInfo] = useState<{ username: string; two_fa_enabled: boolean }>({ username: "", two_fa_enabled: false });
  // 修改密码表单
  const [pwOld, setPwOld] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwNew2, setPwNew2] = useState("");
  const [pwNewUsername, setPwNewUsername] = useState("");
  // 2FA 开启流程：生成的密钥与二维码 URI，以及验证动态码
  const [twoFaSetup, setTwoFaSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [twoFaEnableToken, setTwoFaEnableToken] = useState("");
  // 关闭 2FA 时的动态码确认
  const [twoFaDisableToken, setTwoFaDisableToken] = useState("");

  /**
   * 统一 API 请求封装 — 自动注入 Authorization 头部与后端 Worker 基准域名
   */
  const apiFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
    // 从会话存储获取登录后签发的 Session Token
    const token = sessionStorage.getItem("DNSHE_SESSION") || localStorage.getItem("DNSHE_SESSION");
    const storedBackend = backendUrl || localStorage.getItem("DNSHE_BACKEND_URL") || (import.meta as any).env?.VITE_API_BASE_URL;

    // 如果传入相对路径以 /api 开头，智能补全后端基准域名
    //
    // NOTE: 此处不再按当前域名猜测后端地址（原先会拼出 https://api-dnshe.<主域名>）。
    //       那个约定并不成立：Worker 未绑同名自定义域名时该主机根本不解析，
    //       请求只会以一句 Failed to fetch 结束，反而掩盖了「后端地址未配置」这个真实原因。
    //       地址来源现在只有两个：用户在设置页保存的覆盖值，以及构建期烘焙的 VITE_API_BASE_URL。
    let finalUrl = url;
    if (url.startsWith("/api")) {
      if (storedBackend) {
        finalUrl = `${storedBackend.replace(/\/$/, "")}${url}`;
      } else {
        const host = window.location.hostname;
        const isLocalDev = host === "localhost" || host === "127.0.0.1";
        if (!isLocalDev) {
          // 线上两者皆空：走相对路径只会打到 Pages 自身、被 SPA 兜底返回 HTML，
          // 报错会变成 JSON 解析失败。这里直接给出真实原因。
          throw new Error("未配置后端地址（部署时未能推导出 Worker 地址），请在设置页手动填写后端 Worker 地址");
        }
        // 本地开发走 Vite 代理的相对路径
        finalUrl = url;
      }
    }

    const headers = new Headers(options.headers || {});
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    try {
      const res = await fetch(finalUrl, { ...options, headers });
      if (res.status === 401 || res.status === 403) {
        // 会话失效：清理凭据并回到登录页（登录/初始化/状态接口自身除外，避免误清）
        const isAuthEndpoint = url.startsWith("/api/auth/login") || url.startsWith("/api/auth/setup") || url.startsWith("/api/auth/status");
        if (!isAuthEndpoint) {
          sessionStorage.removeItem("DNSHE_SESSION");
          localStorage.removeItem("DNSHE_SESSION");
          setSessionToken(null);
        }
      }
      return res;
    } catch (err) {
      // 遇网络连接异常自动提示配置后端服务
      console.error("API Fetch Error:", err);
      throw err;
    }
  };

  // NOTE: 这里原先有一份 checkAuthStatus() + 无依赖 useEffect，会在挂载时无条件
  //       请求一次 /api/auth/status。它与下面 [sessionToken] 那个 effect 完全重复：
  //       未登录时冷加载会把这个接口打两遍，已登录时这一次请求的结果又根本用不上
  //       （authStatusLoaded 只在未登录分支里被读取）。已删除，只保留会在已登录时
  //       提前 return 的那一个。

  // 保存会话 Token 并进入系统
  //
  // NOTE: 这里刻意不再把 backendUrl 写回 localStorage。backendUrl 在用户没有手动配置时
  //       等于构建期烘焙的 VITE_API_BASE_URL，一旦登录成功就被冻结进 localStorage，
  //       而 localStorage 的优先级又高于烘焙值 —— 之后 CI 重新检测出的新后端地址会被
  //       这个旧值永久遮蔽（部署流水线每次都会重新推导该地址：自定义域名 → workers.dev
  //       子域 → 空），表现为换域名/换后端后登录一直 Failed to fetch，且只能靠清站点数据恢复。
  //       localStorage 只应保存用户在设置页显式填写的覆盖值。
  const persistSession = (token: string) => {
    sessionStorage.setItem("DNSHE_SESSION", token);
    setSessionToken(token);
  };

  // 提交登录（用户名 + 密码，若后端要求则附带 2FA 动态码）
  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLoginError("");

    if (!loginUsername.trim() || !loginPassword) {
      setLoginError("请输入用户名与密码");
      return;
    }
    if (authTwoFaEnabled && !loginTotp.trim()) {
      setLoginError("请输入 6 位动态验证码");
      return;
    }

    setLoginLoading(true);
    try {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: loginUsername.trim(),
          password: loginPassword,
          token: loginTotp.trim() || undefined,
        }),
      });
      const data = await res.json();

      if (data.success && data.session_token) {
        persistSession(data.session_token);
        setLoginPassword("");
        setLoginTotp("");
        setLoginNeeds2fa(false);
        showToast("success", data.message || "🎉 登录成功");
      } else if (data.error_code === "need_2fa") {
        // 密码正确但需要补充动态码
        setLoginNeeds2fa(true);
        setLoginError("请输入身份验证器上的 6 位动态验证码");
      } else if (data.error_code === "not_initialized") {
        setAuthInitialized(false);
        setLoginError("系统尚未初始化，请先设置管理员账户");
      } else {
        setLoginError(data.message || "登录失败");
      }
    } catch (err: any) {
      console.error("Login error:", err);
      // 网络类失败最常见的成因是后端地址不对，且本地覆盖值优先级高于构建期烘焙值，
      // 故直接把当前实际使用的地址与来源写进提示，避免只看到一句 Failed to fetch。
      const override = localStorage.getItem("DNSHE_BACKEND_URL");
      const target = override || backendUrl;
      const hint = target
        ? `当前请求地址：${target}${override ? "（来自本机保存的覆盖值，优先级高于部署时写入的默认地址；如该地址已失效，清除本站点数据即可恢复默认）" : "（来自部署时写入的默认地址）"}`
        : "尚未配置后端地址";
      setLoginError(`登录请求失败：${err?.message || "网络异常"}。${hint}`);
    } finally {
      setLoginLoading(false);
    }
  };

  // 提交首次初始化（自行设置管理员用户名与密码）
  const handleSetup = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLoginError("");

    if (!setupUsername.trim() || setupUsername.trim().length < 3) {
      setLoginError("用户名至少需要 3 个字符");
      return;
    }
    if (setupPassword.length < 8) {
      setLoginError("密码至少需要 8 个字符");
      return;
    }
    if (setupPassword !== setupPassword2) {
      setLoginError("两次输入的密码不一致");
      return;
    }

    setLoginLoading(true);
    try {
      const res = await apiFetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: setupUsername.trim(), password: setupPassword }),
      });
      const data = await res.json();

      if (data.success && data.session_token) {
        persistSession(data.session_token);
        setSetupPassword("");
        setSetupPassword2("");
        setAuthInitialized(true);
        showToast("success", data.message || "🎉 初始化成功");
      } else {
        setLoginError(data.message || "初始化失败");
      }
    } catch (err: any) {
      console.error("Setup error:", err);
      setLoginError(`初始化请求失败：${err?.message || "网络异常"}`);
    } finally {
      setLoginLoading(false);
    }
  };

  // 退出登录
  const handleLogout = async () => {
    // 先让服务端把当前 Bearer 会话作废（token 落库的是哈希，拿到旧 token 也无法重放）
    try {
      const token = sessionStorage.getItem("DNSHE_SESSION") || localStorage.getItem("DNSHE_SESSION");
      if (token) {
        await apiFetch("/api/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch (err) {
      // 网络异常不影响本地登出，静默降级为仅清本地凭据
      console.warn("Logout revoke failed:", err);
    }
    sessionStorage.removeItem("DNSHE_SESSION");
    localStorage.removeItem("DNSHE_SESSION");
    setSessionToken(null);
    setLoginUsername("");
    setLoginPassword("");
    setLoginTotp("");
    setLoginNeeds2fa(false);
    showToast("info", "已退出登录");
  };

  // 读取账户安全信息（用户名 + 2FA 状态）
  const fetchAccountInfo = async () => {
    try {
      const res = await apiFetch("/api/auth/account");
      const data = await res.json();
      if (data.success) {
        setAccountInfo({ username: data.username || "", two_fa_enabled: !!data.two_fa_enabled });
      }
    } catch (e) {
      // 静默失败，设置页其余部分仍可用
    }
  };

  // 修改密码（可选同时改用户名）
  const handleChangePassword = async () => {
    if (!pwOld) {
      showToast("error", "请输入原密码");
      return;
    }
    if (pwNew.length < 8) {
      showToast("error", "新密码至少需要 8 个字符");
      return;
    }
    if (pwNew !== pwNew2) {
      showToast("error", "两次输入的新密码不一致");
      return;
    }
    setActionLoading("change-pw");
    try {
      const payload: Record<string, string> = { old_password: pwOld, new_password: pwNew };
      // 与当前用户名相同时不下发 username：避免浏览器把当前用户名预填进「同时修改用户名」
      // 之后，提交时产生一次毫无意义的改名写入与日志。
      const wantUsername = pwNewUsername.trim();
      if (wantUsername && wantUsername !== (accountInfo.username || "")) {
        payload.username = wantUsername;
      }
      const res = await apiFetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", data.message || "密码修改成功，请重新登录");
        setPwOld(""); setPwNew(""); setPwNew2(""); setPwNewUsername("");
        // 密码已变更，当前会话作废，强制重新登录
        setTimeout(() => handleLogout(), 1500);
      } else {
        showToast("error", data.message || "修改密码失败");
      }
    } catch (e) {
      showToast("error", "修改密码请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 第一步：生成 2FA 密钥与二维码
  const handleStart2faSetup = async () => {
    setActionLoading("2fa-setup");
    try {
      const res = await apiFetch("/api/auth/2fa/setup", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setTwoFaSetup({ secret: data.secret, otpauth_uri: data.otpauth_uri });
        setTwoFaEnableToken("");
      } else {
        showToast("error", data.message || "生成 2FA 密钥失败");
      }
    } catch (e) {
      showToast("error", "生成 2FA 密钥请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 第二步：输入动态码正式开启 2FA
  const handleEnable2fa = async () => {
    if (!twoFaEnableToken.trim()) {
      showToast("error", "请输入身份验证器上的 6 位动态码");
      return;
    }
    setActionLoading("2fa-enable");
    try {
      const res = await apiFetch("/api/auth/2fa/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: twoFaEnableToken.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", data.message || "两步验证已开启");
        setTwoFaSetup(null);
        setTwoFaEnableToken("");
        fetchAccountInfo();
      } else {
        showToast("error", data.message || "开启 2FA 失败");
      }
    } catch (e) {
      showToast("error", "开启 2FA 请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 关闭 2FA（需输入当前动态码确认）
  const handleDisable2fa = async () => {
    if (!twoFaDisableToken) {
      showToast("error", "请输入身份验证器上的 6 位动态码以确认关闭 2FA");
      return;
    }
    setActionLoading("2fa-disable");
    try {
      const res = await apiFetch("/api/auth/2fa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: twoFaDisableToken }),
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", data.message || "两步验证已关闭");
        setTwoFaDisableToken("");
        fetchAccountInfo();
      } else {
        showToast("error", data.message || "关闭 2FA 失败");
      }
    } catch (e) {
      showToast("error", "关闭 2FA 请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 自动淡出 Toast 提示
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // 点击外部关闭三点弹出菜单
  useEffect(() => {
    const handleClickOutside = () => setOpenActionMenuId(null);
    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, []);

  // 显示 Toast 辅助函数
  const showToast = (type: "success" | "error" | "info" | "warning", message: string) => {
    setToast({ type, message });
  };

  // 日期格式化辅助函数：转换为 YYYY/MM/DD（到期时间支持“永久”）
  const formatDate = (dateStr?: string | null, isExpiration = false) => {
    if (!dateStr || dateStr.startsWith("0000")) {
      return isExpiration ? "永久" : "未记录";
    }
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      return isExpiration ? "永久" : dateStr;
    }
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}/${m}/${d}`;
  };

  // 判断域名是否使用默认 NS（ns1.dnshe.com/ns2.dnshe.com）并允许在线 DNS 管理
  const checkHasDns = (dom: Domain) => {
    if (dom.disable_ns_management) return false;
    if (dom.ns1 || dom.ns2) {
      const ns1 = (dom.ns1 || "").toLowerCase();
      const ns2 = (dom.ns2 || "").toLowerCase();
      if (!ns1.includes("dnshe.com") && !ns2.includes("dnshe.com")) return false;
    }
    if (dom.has_dns !== undefined && dom.has_dns !== null) {
      return Number(dom.has_dns) !== 0;
    }
    return true;
  };

  const detectDnsProvider = (nameservers: string[]): string => {
    const hosts = nameservers
      .map((value) => value.trim().toLowerCase().replace(/\.$/, ""))
      .filter(Boolean);
    const matchesDomain = (host: string, domain: string) =>
      host === domain || host.endsWith(`.${domain}`);

    if (hosts.some((host) => matchesDomain(host, "vps8.zz.cd"))) return "vps8";
    if (hosts.some((host) => matchesDomain(host, "ns.cloudflare.com"))) return "Cloudflare";
    if (hosts.some((host) =>
      matchesDomain(host, "dnspod.net") ||
      matchesDomain(host, "dnspod.com") ||
      matchesDomain(host, "dnsv.com") ||
      /(^|\.)dnsv[1-5]\.com$/.test(host)
    )) return "DNSPod";
    if (hosts.some((host) => matchesDomain(host, "vercel-dns.com"))) return "Vercel";
    return "外部 DNS";
  };

  const getDnsProviderLabel = (dom: Domain, records?: DnsRecord[]): string => {
    if (checkHasDns(dom)) return "系统默认";
    if (records) {
      return detectDnsProvider(
        records.filter((record) => record.type === "NS").map((record) => String(record.content || ""))
      );
    }
    return dom.dns_provider && dom.dns_provider !== "external"
      ? dom.dns_provider
      : "外部 DNS";
  };

  // 渲染域名三态徽章：未解析 / 已解析 / 已委派
  //
  // 🔴 必须 `whitespace-nowrap flex-shrink-0`：徽章与域名同在一行 flex 里，
  //    卡片变窄（768/1024 两列布局）时 flex 会把徽章压到不足一个字的宽度，
  //    「已解析」被折成「已解\n析」两行 —— 高度从 22px 变 38px，卡片参差不齐。
  //    域名那侧本来就有 `truncate min-w-0`，所以让徽章不让步是对的（§15）。
  const renderStatusBadge = (dom: Domain) => {
    let statusText = dom.status;
    const isDelegated = Number(dom.has_dns) === 0 || dom.status === "已委派";
    
    if (isDelegated) {
      statusText = "已委派";
    } else if (dom.status === "Registered" || dom.status === "active" || dom.status === "已解析") {
      statusText = "已解析";
    } else if (dom.status === "未解析") {
      statusText = "未解析";
    }

    if (statusText === "已委派") {
      return (
        <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold whitespace-nowrap flex-shrink-0 bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-800/60">
          已委派
        </span>
      );
    }
    if (statusText === "已解析") {
      return (
        <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold whitespace-nowrap flex-shrink-0 bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/80 dark:text-emerald-400 dark:border-emerald-900/60">
          已解析
        </span>
      );
    }
    return (
      <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold whitespace-nowrap flex-shrink-0 bg-elevated text-content-muted border border-border-base">
        未解析
      </span>
    );
  };

  // 渲染单个域名卡片
  const renderDomainCard = (dom: Domain) => {
    const unicodeDomain = displayDomain(toUnicode(dom.full_domain));

    // ── 一键委派到 Cloudflare 的准入判定（第19轮）──
    // 三重门：① CF zone 行本身不是 DNSHE 域名，压根不渲染这个入口；
    // ② 已经委派到 CF 的没必要再来一次；③ 根域名不在 PSL 白名单里的，
    // Cloudflare 根本建不了 zone —— 渲染成**禁用并当场说明原因**，
    // 而不是让人点下去才报错（用户要求「遇到了不支持的就提示禁用」）。
    // 真正的准入判定在后端（前端被绕过也进不来），这里只管"让用户看得懂"。
    const isCfZoneRow = dom.account_provider === "cloudflare";
    const delegatableRoot = matchDelegatableRoot(dom);
    const alreadyOnCloudflare = !checkHasDns(dom) && getDnsProviderLabel(dom) === "Cloudflare";
    const delegateBlockReason = alreadyOnCloudflare
      ? "该域名已委派到 Cloudflare"
      : !delegatableRoot
        ? `根域名 ${dom.rootdomain} 不在 Public Suffix List，CF 视其为子域名（需企业版）`
        : "";

    return (
      <div
        key={dom.id}
        className="bg-surface border border-border-base hover:border-border-base rounded-2xl p-5 flex flex-col justify-between transition-all duration-200 shadow-xl"
      >
        {/* 顶部：域名名称与状态 */}
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => copyToClipboard(dom.full_domain, dom.full_domain)}
            /* 手机上小一号字号，让常见长度的域名不必省略；超长域名仍截断，
               但 title 与「点击复制」拿到的都是完整域名 */
            className="font-mono text-sm sm:text-base font-bold text-content-primary tracking-wide truncate min-w-0 hover:text-indigo-400 transition-colors cursor-pointer text-left"
            title={`点击复制：${dom.full_domain}`}
          >
            {unicodeDomain}
          </button>
          {renderStatusBadge(dom)}
        </div>

      {/* 中间：注册时间与到期时间 */}
      <div className="mt-4 space-y-2 text-xs">
        <div className="flex justify-between items-center">
          <span className="text-content-muted font-medium">注册时间</span>
          <span className="font-mono text-content-secondary">{formatDate(dom.created_at, false)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-content-muted font-medium">到期时间</span>
          <span className="font-mono text-content-secondary">{formatDate(dom.expires_at, true)}</span>
        </div>
      </div>

      {/* 分隔线 */}
      <div className="border-t border-border-base my-3.5" />

      {/* 当前 DNS 服务器 */}
      <div className="flex justify-between items-center text-xs">
        <span className="text-content-muted font-medium">当前 DNS 服务器</span>
        {checkHasDns(dom) ? (
          <span className="bg-elevated text-content-secondary border border-border-base text-xs font-medium px-2.5 py-0.5 rounded-md">
            系统默认
          </span>
        ) : (
          <span className="bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-800/60 text-xs font-medium px-2.5 py-0.5 rounded-md">
            {getDnsProviderLabel(dom)}
          </span>
        )}
      </div>

      {/* 分隔线 */}
      <div className="border-t border-border-base my-3.5" />

      {/* 底部：交叉提示（已绑定 CF 账号的委派域名）+ DNS 按钮与更多三点下拉菜单 */}
      <div className="flex items-center gap-3 relative">
        {/* 交叉提示：委派到 Cloudflare 且同名 zone 已在绑定的 CF 账号中同步过，
            引导用户去 Cloudflare 标签页管理解析记录（纯展示层匹配，不改数据） */}
        {!checkHasDns(dom) && domainKeyCandidates(dom.full_domain).some((k) => cfZoneFullDomainSet.has(k)) && (
          <button
            onClick={() => gotoCfZone(dom.full_domain)}
            className="min-w-0 text-xs font-medium text-sky-600 dark:text-sky-400 hover:text-sky-500 dark:hover:text-sky-300 flex items-center gap-1.5 transition-colors text-left"
            title="已绑定 Cloudflare 账号，点击前往 Cloudflare 标签页并定位到该域名"
          >
            <CloudflareIcon className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">前往 Cloudflare 管理解析</span>
          </button>
        )}

        <div className="flex items-center gap-3 ml-auto flex-shrink-0">
          <button
            onClick={() => handleOpenDnsModal(dom)}
            disabled={!checkHasDns(dom)}
            className={`text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 transition-all shadow-inner ${
              checkHasDns(dom)
                ? "bg-elevated hover:bg-hovered text-content-secondary cursor-pointer"
                : "bg-elevated text-content-muted opacity-50 cursor-not-allowed"
            }`}
          >
            <Settings className={`w-3.5 h-3.5 ${checkHasDns(dom) ? "text-content-muted" : "text-content-muted"}`} /> DNS
          </button>

        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpenActionMenuId(openActionMenuId === dom.id ? null : dom.id);
            }}
            className="p-2 hover:bg-hovered text-content-muted hover:text-content-primary rounded-lg transition-colors"
          >
            <MoreVertical className="w-4 h-4" />
          </button>

          {/* 三点下拉操作菜单 */}
          {openActionMenuId === dom.id && (
            <div 
              onClick={(e) => e.stopPropagation()}
              className="absolute right-0 bottom-10 z-30 w-52 bg-elevated border border-border-base rounded-xl shadow-2xl overflow-hidden text-xs py-1 animate-in fade-in zoom-in-95"
            >
              <button
                onClick={() => {
                  setOpenActionMenuId(null);
                  handleOpenNsModal(dom);
                }}
                className="w-full text-left px-3.5 py-2.5 hover:bg-hovered text-content-secondary hover:text-content-primary flex items-center gap-2"
              >
                <Server className="w-3.5 h-3.5 text-content-muted" /> 修改 NS 记录
              </button>

              {/* 一键委派到 Cloudflare —— 不支持的根域禁用并把原因写在下面
                  （只给 title 的话手机上根本没有悬停，看不见原因） */}
              {!isCfZoneRow && (
                <button
                  onClick={() => {
                    if (delegateBlockReason) return;
                    setOpenActionMenuId(null);
                    handleOpenDelegateModal(dom);
                  }}
                  disabled={!!delegateBlockReason}
                  data-delegatable={delegateBlockReason ? "0" : "1"}
                  title={delegateBlockReason || `把 ${dom.full_domain} 委派到 Cloudflare`}
                  className={`w-full text-left px-3.5 py-2.5 flex items-start gap-2 border-t border-border-base ${
                    delegateBlockReason
                      ? "text-content-muted opacity-60 cursor-not-allowed"
                      : "hover:bg-hovered text-content-secondary hover:text-content-primary"
                  }`}
                >
                  <CloudflareIcon
                    className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${
                      delegateBlockReason ? "text-content-muted" : "text-sky-500"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block">委派到 Cloudflare</span>
                    {delegateBlockReason && (
                      <span className="block mt-0.5 text-[11px] leading-snug text-content-muted whitespace-normal">
                        {delegateBlockReason}
                      </span>
                    )}
                  </span>
                </button>
              )}
              
              <button
                onClick={() => {
                  setOpenActionMenuId(null);
                  handleRenewDomain(dom);
                }}
                disabled={actionLoading === `renew-${dom.id}`}
                className="w-full text-left px-3.5 py-2.5 hover:bg-hovered text-content-secondary hover:text-content-primary flex items-center gap-2 border-t border-border-base"
              >
                <RefreshCw className={`w-3.5 h-3.5 text-content-muted ${actionLoading === `renew-${dom.id}` ? "animate-spin" : ""}`} />
                续期域名
              </button>

              <button
                onClick={() => {
                  setOpenActionMenuId(null);
                  handleOpenDeleteModal(dom);
                }}
                className="w-full text-left px-3.5 py-2.5 hover:bg-rose-50 text-rose-600 hover:text-rose-700 dark:hover:bg-rose-950/40 dark:text-rose-400 dark:hover:text-rose-300 flex items-center gap-2 border-t border-border-base"
              >
                <Trash2 className="w-3.5 h-3.5" /> 删除域名
              </button>
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
};

  // 1. 获取所有域名列表（支持按账号筛选）
  const fetchDomains = async (accountIdFilter?: string) => {
    setLoadingDomains(true);
    try {
      const targetAcc = accountIdFilter ?? selectedAccountFilter;
      const accParam = targetAcc && targetAcc !== "all" ? `&account_id=${targetAcc}` : "";
      const res = await apiFetch(`/api/domains?${accParam}`);
      const data = await res.json();
      if (data.success) {
        const list: Domain[] = data.domains || [];
        setDomains(list);
        // 顺手补齐这批域名根域的 NS（缺哪个查哪个），供线路支持判定使用。
        // 结论在后端 D1 缓存 30 天，命中时不产生任何出站请求。
        const roots = Array.from(
          new Set([
            ...list.map((d) => String(d.rootdomain ?? "").trim().toLowerCase()),
            ...allRootDomains.map((r) => String(r || "").trim().toLowerCase())
          ])
        ).filter(Boolean);
        void fetchRootNs(roots);
      } else {
        showToast("error", data.message || "拉取域名列表失败");
      }
    } catch (e) {
      showToast("error", "网络连接异常，无法获取域名列表");
    } finally {
      setLoadingDomains(false);
    }
  };

  // 2. 获取账号列表
  const fetchAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const res = await apiFetch("/api/accounts");
      const data = await res.json();
      if (data.success) {
        setAccounts(data.accounts || []);
      }
    } catch (e) {
      showToast("error", "获取账号列表失败");
    } finally {
      setLoadingAccounts(false);
    }
  };

  // 2.4 获取 Cloudflare 账号的 zone 列表（后端默认排除这些行，需显式传 provider）
  const fetchCfZones = async (accountIdFilter?: string) => {
    setLoadingCfZones(true);
    try {
      const targetAcc = accountIdFilter ?? cfAccountFilter;
      const accParam = targetAcc && targetAcc !== "all" ? `&account_id=${targetAcc}` : "";
      const res = await apiFetch(`/api/domains?provider=cloudflare${accParam}`);
      const data = await res.json();
      if (data.success) {
        setCfZones(data.domains || []);
      } else {
        showToast("error", data.message || "拉取 Cloudflare zones 失败");
      }
    } catch (e) {
      showToast("error", "网络连接异常，无法获取 Cloudflare zones");
    } finally {
      setLoadingCfZones(false);
    }
  };

  // 2.5 读取某账号域名缓存的「指纹」：域名条数 + 最新的 updated_at
  //
  // NOTE: 后端每个账号的域名是在一次 db.batch 里整批写入的，所以指纹一变
  //       就说明该账号这一轮后台同步已经落库。新绑定账号从「0 条」变为有域名，
  //       换 Key 重新同步则是 updated_at 被刷新，两种场景都能用同一个信号判断。
  const readAccountDomainFingerprint = async (accountId: number, provider?: string): Promise<string | null> => {
    try {
      // Cloudflare 账号的 zone 默认被 /api/domains 排除（它们在独立标签页展示），
      // 指纹查询必须显式带上 provider，否则永远返回「0 条」，同步等待逻辑会失效
      const providerParam = provider === "cloudflare" ? "&provider=cloudflare" : "";
      const res = await apiFetch(`/api/domains?account_id=${accountId}${providerParam}`);
      const data = await res.json();
      if (!data.success) return null;
      const list: Array<Record<string, unknown>> = data.domains || [];
      const newest = list.reduce((max, d) => {
        const v = String(d.updated_at || "");
        return v > max ? v : max;
      }, "");
      return `${list.length}:${newest}`;
    } catch (e) {
      return null;
    }
  };

  // 2.6 等待账号的域名在后端落库后再刷新列表
  //
  // NOTE: 绑定 / 换 Key 接口里的域名同步是 waitUntil 后台任务（逐个域名拉解析记录
  //       判定三态），接口返回「成功」时库里通常还没写完。原先紧接着调 fetchDomains()
  //       只会拿到空列表或旧数据，看起来像「账号绑上了却没有域名」，只能手动刷新页面。
  const waitForAccountDomainSync = async (
    accountIds: number[],
    label: string,
    baseline?: Map<number, string>,
    providerLookup?: (id: number) => string | undefined
  ) => {
    const pending = new Set(accountIds.filter((id) => Number.isFinite(id) && id > 0));
    if (pending.size === 0) {
      fetchDomains();
      return;
    }

    showToast("info", `${label}，正在后台同步域名，完成后自动刷新…`);

    // 后端逐个账号同步，账号之间还有 1.2s 间隔，等待预算随账号数增长
    const deadline = Date.now() + 15_000 + pending.size * 8_000;

    while (pending.size > 0 && Date.now() < deadline) {
      await sleep(1500);

      // 轮询期间会话失效（登出 / 过期）就不再空转
      if (!sessionStorage.getItem("DNSHE_SESSION") && !localStorage.getItem("DNSHE_SESSION")) return;

      // 逐个账号单独查询，不受域名页当前账号筛选影响
      for (const id of [...pending]) {
        const fingerprint = await readAccountDomainFingerprint(id, providerLookup?.(id));
        // 查询失败（null）不终止等待，下一轮继续
        if (fingerprint !== null && fingerprint !== (baseline?.get(id) ?? "0:")) {
          pending.delete(id);
        }
      }
    }

    // 无论是否等齐都刷新一次列表，让已完成的账号立即可见
    fetchDomains();
    fetchCfZones();
    // 后端在同步域名之前已经刷过这些账号的配额缓存，这里顺带把配额也拉新
    invalidateQuotaTabCache();
    fetchQuotas();

    if (pending.size === 0) {
      showToast("success", "域名同步完成，列表已刷新");
    } else {
      showToast(
        "warning",
        `${pending.size} 个账号暂未同步到域名（可能仍在后台进行，也可能该账号名下确实没有域名），可稍后点击「同步所有账号」`
      );
    }
  };

  // 3. 获取配额列表（默认命中缓存，forceRefresh 时强制回源刷新）
  // ═══════════════════════════════════════════════════════════════════════
  // 主域新增：概览聚合 / 域名助力 / API 密钥
  //   （这三块对应的后端路由在 shydns.cc.cd 的 src/index.ts 末尾，1 号站没有）
  // ═══════════════════════════════════════════════════════════════════════

  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);

  /**
   * 顶栏搜索框的占位语
   *
   * 窄屏上长占位语会被截成「搜索域名（回车跳…」，反而什么都看不懂 ——
   * 所以手机端用短语，桌面端才给完整说明。
   */
  const [isNarrowViewport, setIsNarrowViewport] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 640
  );
  useEffect(() => {
    const onResize = () => setIsNarrowViewport(window.innerWidth < 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const mobileSearchPlaceholder = isNarrowViewport
    ? (SEARCH_CONFIG[activeTab]?.placeholder || "搜索").split("（")[0]
    : (SEARCH_CONFIG[activeTab]?.placeholder || "搜索...");

  /**
   * 设置页搜索（2026-09-30 第16轮）
   *
   * 设置页没有「列表」可筛，可检索的对象就是**小节卡片**本身：
   * 命中规则 = 该小节的 keywords 串包含用户输入（大小写不敏感）。
   * 用「包含」而不是分词，是因为用户输入本身就是半个词（「密码」「续期」「渠道」），
   * 分词反而会把这类前缀/子串挡在外面。
   *
   * ⚠️ 只在设置页生效：`activeTab !== "settings"` 时恒为可见，
   *    否则会把其它页的搜索词带到设置页、打开就是一片空白。
   */
  const settingsSearchKw = globalSearch.trim().toLowerCase();
  const isSettingsSearchActive = activeTab === "settings" && settingsSearchKw.length > 0;
  const settingsSectionVisible = (sectionId: string) => {
    if (!isSettingsSearchActive) return true;
    const sec = SETTINGS_SECTIONS.find((s) => s.id === sectionId);
    return !!sec && sec.keywords.toLowerCase().includes(settingsSearchKw);
  };
  const settingsHitCount = isSettingsSearchActive
    ? SETTINGS_SECTIONS.filter((s) => s.keywords.toLowerCase().includes(settingsSearchKw)).length
    : SETTINGS_SECTIONS.length;

  /* 设置页两列布局的列可见性：整列都被搜索过滤掉时，列容器本身也要 hidden ——
     否则 grid 会留下一个空列（右列被顶到第二格，左边空一半）。 */
  const settingsLeftColVisible = ["settings-backend", "settings-security", "settings-renew"].some((id) =>
    settingsSectionVisible(id)
  );
  const settingsRightColVisible = ["settings-line-ns", "settings-notify"].some((id) =>
    settingsSectionVisible(id)
  );

  /**
   * 跳到设置页某个小节（抽屉二级菜单用）
   *
   * NOTE: 不能直接 `scrollIntoView` —— 切页与设置数据加载都是异步的：
   * 目标卡片在「设置页数据还没到位」时根本不在 DOM 里（页面此时是 loading 态）。
   * 所以按 120ms 轮询等它出现（最多 ~1.5s），出现后平滑滚过去并描一圈高亮，
   * 让用户看得见"跳到了哪一张卡"。
   */
  const scrollToSettingsSection = (sectionId: string) => {
    let tries = 0;
    const tick = () => {
      const el = document.getElementById(sectionId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.style.outline = "2px solid rgb(99 102 241 / 0.65)";
        el.style.outlineOffset = "4px";
        window.setTimeout(() => {
          el.style.outline = "";
          el.style.outlineOffset = "";
        }, 1600);
        return;
      }
      if (tries++ < 12) window.setTimeout(tick, 120);
    };
    window.setTimeout(tick, 60);
  };

  /** 分批域名同步的进度（null = 未在同步） */
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number } | null>(null);

  /** 账户配额面板：被「取消勾选」的账号 id（默认空 = 全部显示，新账号自动出现） */
  const [hiddenQuotaAccounts, setHiddenQuotaAccounts] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_OVERVIEW_HIDDEN_ACCOUNTS");
      return raw ? (JSON.parse(raw) as number[]) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem("DNSHE_OVERVIEW_HIDDEN_ACCOUNTS", JSON.stringify(hiddenQuotaAccounts));
  }, [hiddenQuotaAccounts]);

  /**
   * 概览卡片每行列数
   * NOTE: 上游把列数写死在 grid 类名里（一行 3 个），窄屏挤、宽屏空。
   *       这里改成可调，档位语义见 OVERVIEW_COL_CLASS / QUOTA_COL_CLASS。
   *
   * 🔴 2026-09-30 第15轮：档位语义变了 ⇒ 键名升到 `_V2` 做**一次性迁移**。
   *   旧版每档手机段都被写死（选 `3` 在手机上其实只给 2 列），新版 `3` 字面就是 3 列。
   *   旧值的含义已失效，若继续沿用，用户在手机上会继承一个语义已经变了的数字，
   *   而用户这次的要求正是「概览移动端默认 1 列」⇒ 让老值落空、回到 `auto` 才是对的。
   * 🔴 2026-09-30 第16轮：档位集合变了（去掉 6 列、新增 1 列）⇒ 读取时按 option 白名单过滤。
   *   历史值 `"6"` 已无对应 option，`<select value="6">` 会渲染成「什么都没选中」；
   *   这里直接落空回 `auto`，用户下次进页面看到的是一份合法选择。
   */
  const readColPref = (key: string) => {
    const v = localStorage.getItem(key);
    return v && OVERVIEW_COL_OPTIONS.some((o) => o.value === v) ? v : "auto";
  };
  const [overviewCols, setOverviewCols] = useState<string>(() => readColPref("DNSHE_OVERVIEW_COLS_V2"));
  useEffect(() => {
    localStorage.setItem("DNSHE_OVERVIEW_COLS_V2", overviewCols);
  }, [overviewCols]);

  /** Cloudflare 页 zone 卡每行列数（独立于概览页，两页密度需求不同）；键名迁移理由同上 */
  const [cfCols, setCfCols] = useState<string>(() => readColPref("DNSHE_CF_COLS_V2"));
  useEffect(() => {
    localStorage.setItem("DNSHE_CF_COLS_V2", cfCols);
  }, [cfCols]);

  /** 账户配额的「筛选」抽屉是否展开 */
  const [showQuotaFilter, setShowQuotaFilter] = useState(false);

  const fetchOverview = async () => {
    setLoadingOverview(true);
    try {
      const res = await apiFetch("/api/overview");
      const data = await res.json();
      if (data.success) setOverview(data as OverviewData);
    } catch {
      // 概览是只读聚合页，失败时保留上一次数据即可，不弹错误打断用户
    } finally {
      setLoadingOverview(false);
    }
  };

  // ── 域名助力 ──
  const [assistAccounts, setAssistAccounts] = useState<AssistAccount[]>([]);
  const [assistHistory, setAssistHistory] = useState<AssistHistoryEntry[]>([]);
  const [assistUpdatedAt, setAssistUpdatedAt] = useState<string | null>(null);
  const [loadingAssist, setLoadingAssist] = useState(false);
  const [syncingAssist, setSyncingAssist] = useState(false);
  const [assistCodeInput, setAssistCodeInput] = useState("");
  const [assistMaxAccounts, setAssistMaxAccounts] = useState(5);
  const [assisting, setAssisting] = useState(false);
  const [assistResults, setAssistResults] = useState<Array<{ name: string; ok: boolean; message: string }>>([]);
  /** 助力确认弹窗：null = 关闭；开启时记录本次将使用的候选账号 */
  const [assistConfirm, setAssistConfirm] = useState<AssistAccount[] | null>(null);
  /** 弹窗里被取消勾选的账号名 */
  const [assistExcluded, setAssistExcluded] = useState<string[]>([]);
  /** 域名三态筛选：all 全部 / eligible 未永久 / upgraded 永久 */
  const [assistFilter, setAssistFilter] = useState<"all" | "eligible" | "upgraded">("all");
  /** 「最近助力记录」翻页（每页 10 条） */
  const [assistLogPage, setAssistLogPage] = useState(1);

  const fetchAssistStatus = async () => {
    setLoadingAssist(true);
    try {
      const res = await apiFetch("/api/assist/status");
      const data = await res.json();
      if (data.success) {
        setAssistAccounts(data.accounts || []);
        setAssistHistory(data.history || []);
        setAssistUpdatedAt(data.updated_at || null);
      }
    } catch {
      showToast("error", "读取助力缓存失败");
    } finally {
      setLoadingAssist(false);
    }
  };

  const syncAssist = async () => {
    setSyncingAssist(true);
    try {
      const res = await apiFetch("/api/assist/sync", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setAssistAccounts(data.accounts || []);
        setAssistUpdatedAt(data.updated_at || null);
        showToast(
          data.partial ? "warning" : "success",
          data.partial ? "同步完成，部分账号失败（已保留旧数据）" : "已从 DNSHE 拉取最新助力数据"
        );
        fetchOverview();
      } else {
        showToast("error", data.message || "同步失败");
      }
    } catch {
      showToast("error", "同步失败");
    } finally {
      setSyncingAssist(false);
    }
  };

  const generateAssistCode = async (accountId: number, subdomainId: number, domain: string) => {
    try {
      const res = await apiFetch("/api/assist/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId, subdomain_id: subdomainId }),
      });
      const data = await res.json();
      if (data.success) {
        const code = String(data.assist_code || "");
        if (code) {
          // 就地把这张域名卡变成「助力码可复制」状态 —— 不等任何刷新
          setAssistAccounts((prev) =>
            prev.map((a) =>
              a.account_id !== accountId
                ? a
                : {
                    ...a,
                    domains: (a.domains || []).map((d) =>
                      d.id === subdomainId ? { ...d, assist_code: code, status: "in_progress" } : d
                    ),
                  }
            )
          );
        }
        showToast("success", `已为 ${domain} 生成助力码，可在域名卡片上就地复制`);
        // 全量同步放后台补计数，不再阻塞卡片显示
        void syncAssist();
      } else {
        showToast("error", data.message || "生成助力码失败");
      }
    } catch {
      showToast("error", "生成助力码失败");
    }
  };

  /**
   * 触发好友助力
   * ⚠️ 这是真实消耗：每个账号用掉 1 次助力额度且不可撤销，所以先弹确认框列出
   *    「将用哪些账号、共消耗几次」，用户确认后才发请求。
   */
  /**
   * 校验当前助力码并挑出候选账号（按剩余额度从高到低）
   *
   * 返回 null 表示助力码格式不合法。抽出来是因为「触发助力」按钮与真正的
   * triggerAssist 各写了一份完全相同的校验 + 排序，改一处漏一处迟早对不上。
   */
  const buildAssistCandidates = () => {
    const code = assistCodeInput.trim().toUpperCase();
    if (!/^[A-Z0-9]{6,16}$/.test(code)) return null;
    const usable = [...assistAccounts]
      .filter((a) => !a.error && (a.helper_assist_remaining ?? 0) > 0)
      .sort((a, b) => (b.helper_assist_remaining ?? 0) - (a.helper_assist_remaining ?? 0));
    return { code, usable };
  };

  /**
   * 真正发起助力
   *
   * @param excludedIds 要剔除的账号 id（在确认弹窗里取消勾选的那些）。
   *   为什么要能剔除：如果这个助力码对应的域名本来就是你自己某个账号注册的，
   *   DNSHE 不允许「自己的号给自己的号助力」，那个账号必然失败并白白报错。
   *   把它勾掉即可，其余账号照常助力。
   *
   *   ⚠️ 剔除必须随请求发给后端（exclude_account_ids）：后端是自己按余额取前 N 个的，
   *   只在本地把候选过滤一遍，后端仍旧会去助力被勾掉的那个账号。
   */
  const triggerAssist = async (excludedIds: number[] = []) => {
    const built = buildAssistCandidates();
    if (!built) {
      showToast("warning", "助力码格式不正确（6-16 位字母数字）");
      return;
    }
    const { code } = built;
    const usable = built.usable
      .filter((a) => !excludedIds.includes(a.account_id))
      .slice(0, assistMaxAccounts);
    if (usable.length === 0) {
      showToast("warning", "没有可用的账号（可能都被剔除了）");
      return;
    }

    setAssisting(true);
    setAssistResults([]);
    try {
      const res = await apiFetch("/api/assist/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // max_accounts 取「剔除后实际要用的账号数」，与确认弹窗上「共消耗 N 次」严格一致
        body: JSON.stringify({
          assist_code: code,
          max_accounts: usable.length,
          exclude_account_ids: excludedIds,
        }),
      });
      const data = await res.json();
      if (data.success) {
        const okCount: number = data.total_success ?? 0;
        showToast(
          okCount > 0 ? "success" : "warning",
          okCount > 0 ? `助力完成：${okCount} 个账号成功` : "没有账号完成助力，请查看下方明细"
        );
        setAssistResults(data.results || []);
        await syncAssist();
      } else {
        showToast("error", data.message || "助力失败");
      }
    } catch {
      showToast("error", "助力失败");
    } finally {
      setAssisting(false);
    }
  };

  // ── API 密钥 ──
  /** 视图口径：'all' = 全部账号（默认，与域名列表页的分组视图一致），数字 = 只看某个账号 */
  const [apiKeyView, setApiKeyView] = useState<"all" | number>("all");
  const [apiKeyGroups, setApiKeyGroups] = useState<ApiKeyGroup[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([]);
  const [loadingApiKeys, setLoadingApiKeys] = useState(false);
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  /** 「全部账号」视图下已展开的账号分组 */
  const [expandedKeyAccounts, setExpandedKeyAccounts] = useState<number[]>([]);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyIpWhitelist, setNewKeyIpWhitelist] = useState("");
  /** 新建密钥归属的账号（「全部账号」视图下必须显式选一个） */
  const [newKeyAccountId, setNewKeyAccountId] = useState<number | null>(null);
  /** 创建 / 重置后一次性展示的明文（此时上游仍会把 secret 回给我们） */
  const [freshKey, setFreshKey] = useState<{ key_name: string; api_key: string; api_secret: string | null } | null>(null);
  /** 本次会话是否已触发过密钥回填（回填幂等，一次就够） */
  const apiKeyBackfilledRef = useRef(false);

  /**
   * 密钥列表缓存：key = 视图口径（"all" 或某个账号 id），value = 该口径下上次拿到的全量数据。
   *
   * 上游 keys/list 必须按账号逐个请求且有限速，「全部账号」是串行拉完再返回，
   * 账号一多就要等好几秒 —— 每次进页面都干等是不可接受的。
   * 所以改成「旧数据秒开 + 后台增量刷新」：进页面立刻看到上次的数据，
   * 后台再按账号逐个补齐，谁先回来谁先更新，用户全程可以操作。
   */
  const apiKeyCacheRef = useRef<Map<string, ApiKeyGroup[] | ApiKeyRow[]>>(new Map());
  /** 后台增量刷新进行中（表头旁边一个不打断操作的小提示，不铺遮罩） */
  const [refreshingApiKeys, setRefreshingApiKeys] = useState(false);
  /** 防止「进页面」和「手工刷新」两个请求互相覆盖 */
  const apiKeyReqIdRef = useRef(0);
  /** 增量刷新的运行代号：被 force 刷新顶掉后，旧任务的 finally 不许再动徽章状态 */
  const keyIncrRunIdRef = useRef(0);

  /** 「全部账号」口径下的增量刷新：按账号串行重拉，每回来一个就替换对应分组 */
  /**
   * 只读服务端本地库快照（`source=local`，0 次上游请求）。
   * 拿到就返回，拿不到返回 null —— 由调用方退回「整屏等待」。
   */
  const fetchKeySnapshot = async (v: "all" | number): Promise<ApiKeyGroup[] | ApiKeyRow[] | null> => {
    try {
      const res = await apiFetch(`/api/keys?account_id=${v === "all" ? "all" : v}&source=local`);
      const data = await res.json();
      if (!data.success) return null;
      return v === "all" ? ((data.groups || []) as ApiKeyGroup[]) : ((data.keys || []) as ApiKeyRow[]);
    } catch {
      return null;
    }
  };

  /** 单账号视图的后台补齐：只换数据，不转圈（首屏已经用快照铺过了） */
  const refreshOneKeyList = async (v: number, reqId: number) => {
    const runId = ++keyIncrRunIdRef.current;
    setRefreshingApiKeys(true);
    try {
      const res = await apiFetch(`/api/keys?account_id=${v}`);
      const data = await res.json();
      if (apiKeyReqIdRef.current !== reqId) return;
      if (data.success) {
        const rows: ApiKeyRow[] = data.keys || [];
        setApiKeys(rows);
        apiKeyCacheRef.current.set(String(v), rows);
      }
    } catch {
      /* 单个账号补齐失败不打断浏览，保留快照数据 */
    } finally {
      if (keyIncrRunIdRef.current === runId) setRefreshingApiKeys(false);
    }
  };

  const refreshKeyGroupsIncremental = async (base: ApiKeyGroup[], reqId: number) => {
    const runId = ++keyIncrRunIdRef.current;
    setRefreshingApiKeys(true);
    try {
      // 以缓存里的分组顺序为准，保证刷新过程中列表不会跳动
      const next = [...base];
      for (let i = 0; i < next.length; i++) {
        const g = next[i];
        try {
          const res = await apiFetch(`/api/keys?account_id=${g.account_id}`);
          const data = await res.json();
          if (data.success) {
            next[i] = { ...g, keys: (data.keys || []) as ApiKeyRow[], error: undefined };
          }
        } catch {
          /* 单个账号失败不打断整体，保留旧数据 */
        }
        // 期间用户切了视图或又触发了一次刷新 → 丢弃这批结果
        if (apiKeyReqIdRef.current !== reqId) return;
        setApiKeyGroups([...next]);
      }
      apiKeyCacheRef.current.set("all", [...next]);
    } finally {
      // 只有「仍然是最后一次增量刷新」才能收徽章 —— 否则 force 刷新顶掉它之后，
      // 旧任务迟到的 finally 会把新任务刚点亮的徽章误灭（或反过来永久卡住）
      if (keyIncrRunIdRef.current === runId) setRefreshingApiKeys(false);
    }
  };

  /**
   * @param view 视图口径
   * @param mode "auto"（默认）= 有缓存就先铺旧数据并后台增量刷新；"force" = 强制整页重拉（写操作后 / 手工刷新）
   */
  const fetchApiKeys = async (view?: "all" | number, mode: "auto" | "force" = "auto") => {
    const v = view ?? apiKeyView;
    const cacheKey = String(v);
    const reqId = ++apiKeyReqIdRef.current;
    const cached = apiKeyCacheRef.current.get(cacheKey);

    // force = 整页重拉，直接作废进行中的增量刷新并收掉它的徽章
    if (mode === "force") {
      keyIncrRunIdRef.current++;
      setRefreshingApiKeys(false);
    }

    // 先拿「能立刻画出来的那一份」：内存缓存 → 服务端本地库快照（0 次上游请求）。
    // 只要有一份就立刻铺上去、后台再补实时状态，全程不转圈；
    // 两者都没有（首次部署、库里还没登记过）才退回整屏等待。
    let base: ApiKeyGroup[] | ApiKeyRow[] | null | undefined = mode === "force" ? undefined : cached;
    if (mode === "auto" && !base) base = await fetchKeySnapshot(v);
    if (base) {
      if (v === "all") {
        const groups = base as ApiKeyGroup[];
        setApiKeyGroups(groups);
        setExpandedKeyAccounts((prev) =>
          prev.length ? prev : groups.filter((g) => (g.keys || []).length > 0).map((g) => g.account_id)
        );
        setRevealedSecrets({});
        // 后台增量刷新（不 await，页面已经可用了）
        void refreshKeyGroupsIncremental(groups, reqId);
      } else {
        setApiKeys(base as ApiKeyRow[]);
        setRevealedSecrets({});
        void refreshOneKeyList(v, reqId);
      }
      return;
    }

    setLoadingApiKeys(true);
    try {
      const res = await apiFetch(`/api/keys?account_id=${v === "all" ? "all" : v}`);
      const data = await res.json();
      if (apiKeyReqIdRef.current !== reqId) return;
      if (data.success) {
        if (v === "all") {
          const groups: ApiKeyGroup[] = data.groups || [];
          setApiKeyGroups(groups);
          // 默认展开「有密钥」的账号，空账号收起，避免一屏全是空标题
          setExpandedKeyAccounts(groups.filter((g) => (g.keys || []).length > 0).map((g) => g.account_id));
          apiKeyCacheRef.current.set(cacheKey, groups);
        } else {
          const rows: ApiKeyRow[] = data.keys || [];
          setApiKeys(rows);
          apiKeyCacheRef.current.set(cacheKey, rows);
        }
        setRevealedSecrets({});
      } else {
        showToast("error", data.message || "获取密钥列表失败");
      }
    } catch {
      showToast("error", "获取密钥列表失败");
    } finally {
      if (apiKeyReqIdRef.current === reqId) setLoadingApiKeys(false);
    }
  };

  /** 密钥写操作统一入口：create / regenerate / delete / rename */
  const callKeyAction = async (
    accountId: number,
    payload: Record<string, unknown>,
    successMsg: string
  ) => {
    try {
      const res = await apiFetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId, ...payload }),
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", successMsg);
        return data;
      }
      showToast("error", data.message || "操作失败");
      return null;
    } catch {
      showToast("error", "操作失败");
      return null;
    }
  };

  /** 回显已保存的 Secret（仅本面板创建/重置/回填过的才有） */
  const revealSecret = async (accountId: number, apiKey: string) => {
    if (revealedSecrets[apiKey]) {
      // 再次点击 = 收起
      setRevealedSecrets((prev) => {
        const next = { ...prev };
        delete next[apiKey];
        return next;
      });
      return;
    }
    try {
      const res = await apiFetch("/api/keys/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId, api_key: apiKey }),
      });
      const data = await res.json();
      if (data.success && data.api_secret) {
        setRevealedSecrets((prev) => ({ ...prev, [apiKey]: data.api_secret }));
      } else {
        showToast("warning", data.reason || data.message || "该密钥的 Secret 无法回显");
      }
    } catch {
      showToast("error", "读取 Secret 失败");
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("success", `${label}已复制到剪贴板`);
    } catch {
      showToast("error", "复制失败，请手动选中复制");
    }
  };

  const fetchQuotas = async (forceRefresh = false) => {
    setLoadingQuotas(true);
    try {
      const res = await apiFetch(`/api/quota${forceRefresh ? "?refresh=1" : ""}`);
      const data = await res.json();
      if (data.success) {
        setQuotas(data.quotas || []);
      }
    } catch (e) {
      showToast("error", "获取账户配额失败");
    } finally {
      setLoadingQuotas(false);
    }
  };

  // 4. 获取日志列表
  const fetchLogs = async () => {
    setLoadingLogs(true);
    try {
      const res = await apiFetch("/api/logs");
      const data = await res.json();
      if (data.success) {
        setLogs(data.logs || []);
      }
    } catch (e) {
      showToast("error", "获取系统运行日志失败");
    } finally {
      setLoadingLogs(false);
    }
  };

  // 5. 获取应用设置
  const fetchSettings = async () => {
    setLoadingSettings(true);
    try {
      const res = await apiFetch("/api/settings");
      const data = await res.json();
      if (data.success && data.settings) {
        setSettings((prev) => ({ ...prev, ...data.settings }));
        if (data.configured) setSettingsConfigured(data.configured);
      }
    } catch (e) {
      showToast("error", "获取设置失败");
    } finally {
      setLoadingSettings(false);
    }
  };

  // 保存应用设置
  const handleSaveSettings = async () => {
    setActionLoading("save-settings");
    try {
      // 敏感字段：若仍是打码占位（已配置且用户未改动），则不提交，避免覆盖
      const payload: Record<string, string> = {
        webhook_type: settings.webhook_type,
        tg_chat_id: settings.tg_chat_id,
        renew_threshold_days: settings.renew_threshold_days,
        auto_renew: settings.auto_renew,
        // 邮箱渠道的非敏感字段直接提交
        smtp_host: settings.smtp_host,
        smtp_port: settings.smtp_port,
        smtp_user: settings.smtp_user,
        smtp_from: settings.smtp_from,
        smtp_to: settings.smtp_to,
      };
      if (settings.tg_token && !settings.tg_token.startsWith("****")) payload.tg_token = settings.tg_token;
      if (settings.webhook_url && !settings.webhook_url.startsWith("****")) payload.webhook_url = settings.webhook_url;
      if (settings.smtp_pass && !settings.smtp_pass.startsWith("****")) payload.smtp_pass = settings.smtp_pass;

      const res = await apiFetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", "✅ 设置已保存");
        fetchSettings();
      } else {
        showToast("error", data.message || "保存设置失败");
      }
    } catch (e) {
      showToast("error", "保存设置网络请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 测试 Webhook 推送
  const handleTestWebhook = async () => {
    setActionLoading("test-webhook");
    try {
      const payload: Record<string, string> = { webhook_type: settings.webhook_type };
      // 打码值（已配置但未改动）不回传，让后端用库里的原值
      if (settings.webhook_url && !settings.webhook_url.startsWith("****")) {
        payload.webhook_url = settings.webhook_url;
      }
      // 邮箱渠道：把 SMTP 参数一并送去测试
      if (settings.webhook_type === "email") {
        payload.smtp_host = settings.smtp_host;
        payload.smtp_port = settings.smtp_port;
        payload.smtp_user = settings.smtp_user;
        payload.smtp_from = settings.smtp_from;
        payload.smtp_to = settings.smtp_to;
        if (settings.smtp_pass && !settings.smtp_pass.startsWith("****")) payload.smtp_pass = settings.smtp_pass;
      }
      // Telegram 渠道：同样把 Token / Chat ID 送去（可能是刚填、还没保存的值）
      if (settings.webhook_type === "telegram") {
        if (settings.tg_token && !settings.tg_token.startsWith("****")) payload.tg_token = settings.tg_token;
        payload.tg_chat_id = settings.tg_chat_id;
      }
      const res = await apiFetch("/api/settings/test-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", data.message || "测试消息已发送");
      } else {
        showToast("error", data.message || "测试推送失败");
      }
    } catch (e) {
      showToast("error", "测试推送网络请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 保存本地后端地址
  const handleSaveBackendUrl = () => {
    const v = backendUrlInput.trim().replace(/\/$/, "");
    if (v) {
      localStorage.setItem("DNSHE_BACKEND_URL", v);
      showToast("success", "后端地址已保存，即将刷新页面生效");
    } else {
      localStorage.removeItem("DNSHE_BACKEND_URL");
      showToast("info", "已清除自定义后端地址");
    }
    setBackendUrlEditing(false);
    setTimeout(() => window.location.reload(), 1200);
  };

  // 取消编辑，恢复已保存的值并收起输入框
  const handleCancelBackendUrl = () => {
    setBackendUrlInput(localStorage.getItem("DNSHE_BACKEND_URL") || "");
    setBackendUrlEditing(false);
  };

  // 未登录时向后端查询鉴权状态，决定登录页展示"登录"还是"首次设置"
  useEffect(() => {
    if (sessionToken) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/auth/status");
        const data = await res.json();
        if (!cancelled && data.success) {
          setAuthInitialized(!!data.initialized);
          setAuthTwoFaEnabled(!!data.two_fa_enabled);
        }
      } catch (e) {
        // 网络异常时保持默认（已初始化），仍展示登录表单
      } finally {
        if (!cancelled) setAuthStatusLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionToken]);

  // 切换选项卡时同步 URL hash；浏览器前进/后退或手动改 hash 时同步回 state
  useEffect(() => {
    const syncFromHash = () => {
      const next = tabFromHash();
      setActiveTab((prev) => (prev === next ? prev : next));
    };
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  useEffect(() => {
    const want = `#${activeTab}`;
    if (window.location.hash !== want) {
      window.location.hash = want;
    }
  }, [activeTab]);

  // 会话建立后拉取一次全局数据（账号列表 + 全量域名列表）
  //
  // NOTE: 这两个请求原先和下面的标签页数据挤在同一个 [activeTab, sessionToken] effect 里，
  //       于是每切一次标签页就要重新拉一遍账号和全量域名——两个请求各自都要付
  //       「ensureTables + 校验 session + 真实查询」的串行 D1 往返，切页因此固定卡两秒。
  //       它们是侧栏徽标与各页共用的全局数据，跟当前在哪个标签页无关，所以只挂 sessionToken。
  //       增删改、续期、同步等操作后，各自的处理函数里已经显式调用了
  //       fetchAccounts() / fetchDomains() 刷新，不依赖切页来触发。
  // 标签页专属数据的「上次拉取时刻」，用于避免每次点击标签页都重新请求一遍
  const tabDataFetchedAtRef = useRef<Record<string, number>>({});

  // 账号增删改后让「账户配额」页的时效缓存失效
  //
  // NOTE: 配额是按账号聚合的，账号集合一变它就过时了。后端已按账号粒度维护配额缓存，
  //       但前端这层还有 60 秒时效判断——不主动失效的话，解绑账号后立刻切到配额页
  //       仍会显示刚删掉的账号，只能等 60 秒或点「刷新」。
  const invalidateQuotaTabCache = () => {
    delete tabDataFetchedAtRef.current.quota;
  };

  useEffect(() => {
    if (!sessionToken) return;
    // 换会话（登录 / 重新登录）时清空时效记录，让下面的按需拉取重新跑一轮
    tabDataFetchedAtRef.current = {};
    fetchAccounts();
    fetchDomains();
    // CF zones 也随会话拉一次：Cloudflare 标签页要用，域名页的「已在 Cloudflare 管理」
    // 交叉提示也依赖这份列表，不能等用户切到该页才加载
    fetchCfZones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken]);

  // 按当前 ActiveTab 拉取该页专属数据（仅在已登录时触发）
  //
  // NOTE: 这里原先每次切到对应标签页都会无条件重新请求一遍，来回点几下
  //       「设置 / 运行日志 / 账户配额」就是好几轮 D1 往返的白等。改为带时效判断：
  //       日志与配额 60 秒内不重复拉；设置与账户信息只在本次会话首次进入时拉一次
  //       —— 它们只会通过本界面修改，而保存设置、改密码、开关 2FA 等处理函数
  //       已经各自显式调用了对应的 fetch 刷新，不依赖切页触发。
  //       时间戳在发起请求前就写入，这样快速连点同一个标签页也不会打出重复请求。
  useEffect(() => {
    if (!sessionToken) return;
    const now = Date.now();
    const fetchIfStale = (key: string, ttlMs: number, run: () => void) => {
      const last = tabDataFetchedAtRef.current[key];
      if (last !== undefined && now - last < ttlMs) return;
      tabDataFetchedAtRef.current[key] = now;
      run();
    };

    if (activeTab === "dashboard") {
      fetchIfStale("logs", 60_000, fetchLogs);
      fetchIfStale("overview", 30_000, fetchOverview);
    } else if (activeTab === "logs") {
      fetchIfStale("logs", 60_000, fetchLogs);
    } else if (activeTab === "assist") {
      fetchIfStale("assist", 60_000, fetchAssistStatus);
      fetchIfStale("overview", 30_000, fetchOverview);
    } else if (activeTab === "quota") {
      fetchIfStale("quota", 60_000, fetchQuotas);
    } else if (activeTab === "settings") {
      fetchIfStale("settings", Infinity, fetchSettings);
      fetchIfStale("account", Infinity, fetchAccountInfo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, sessionToken]);

  // 域名搜索索引：full_domain 在库中一律以 Punycode(xn--) 存储，
  // 而列表展示的是解码后的中文，直接拿中文关键词匹配 ASCII 串永远搜不到。
  // 这里为每个域名预计算「Punycode 原文 + 中文解码」两种形态供匹配。
  const domainSearchIndex = useMemo(() => {
    const map = new Map<number, string>();
    domains.forEach((d) => {
      const ascii = (d.full_domain || "").toLowerCase();
      const unicode = toUnicode(d.full_domain || "").toLowerCase();
      map.set(d.id, ascii === unicode ? ascii : `${ascii} ${unicode}`);
    });
    return map;
  }, [domains]);

  // DNSHE 账号列表（Cloudflare 账号在独立标签页展示，DNSHE 的账号选择/注册/查重等
  // 场景都应排除它们）
  const dnsheAccounts = useMemo(
    () => accounts.filter((a) => a.provider !== "cloudflare"),
    [accounts]
  );

  // Cloudflare 账号（概览页「Cloudflare 账号」卡片要用；概览数据未回来时做兜底）
  const cfAccounts = useMemo(
    () => accounts.filter((a) => a.provider === "cloudflare"),
    [accounts]
  );

  // ────────── 顶部搜索框：检索「当前这一页在管的东西」 ──────────
  const pageSearchKw = globalSearch.trim().toLowerCase();
  /** 任意一个字段命中即算命中；关键词为空时一律命中 */
  const kwMatch = (...fields: Array<string | null | undefined>) =>
    !pageSearchKw || fields.some((f) => (f || "").toLowerCase().includes(pageSearchKw));

  /** 账户配额页：按账号别名过滤 */
  const filteredQuotas = useMemo(
    () => (pageSearchKw ? quotas.filter((q) => kwMatch(q.alias)) : quotas),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [quotas, pageSearchKw]
  );

  /** 域名助力页：账号名命中则整组保留；否则只保留命中的域名 */
  const filteredAssistAccounts = useMemo(() => {
    if (!pageSearchKw) return assistAccounts;
    return assistAccounts
      .map((a) => {
        if (kwMatch(a.name)) return a;
        const hit = (a.domains || []).filter((d) => kwMatch(d.domain, d.assist_code));
        return hit.length ? { ...a, domains: hit } : null;
      })
      .filter((a): a is AssistAccount => a !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistAccounts, pageSearchKw]);

  /** API 密钥页：账号名命中则整组保留；否则只保留命中的密钥 */
  const filteredKeyGroups = useMemo(() => {
    if (!pageSearchKw) return apiKeyGroups;
    return apiKeyGroups
      .map((g) => {
        if (kwMatch(g.alias)) return g;
        const hit = g.keys.filter((k) => kwMatch(k.key_name, k.api_key));
        return hit.length ? { ...g, keys: hit } : null;
      })
      .filter((g): g is ApiKeyGroup => g !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyGroups, pageSearchKw]);

  const filteredApiKeys = useMemo(
    () => (pageSearchKw ? apiKeys.filter((k) => kwMatch(k.key_name, k.api_key)) : apiKeys),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiKeys, pageSearchKw]
  );

  /** 账号管理页：按别名或 API Key 过滤 */
  const filteredDnsheAccounts = useMemo(
    () => (pageSearchKw ? dnsheAccounts.filter((a) => kwMatch(a.alias, a.api_key)) : dnsheAccounts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dnsheAccounts, pageSearchKw]
  );

  // 「API 密钥」页：进入页面或切换视图口径时取数。
  // auto 模式下命中缓存就先把旧数据铺上去（页面立刻可操作），再后台按账号增量刷新；
  // 只有首次（无缓存）或手工刷新才会整屏等待。
  useEffect(() => {
    if (activeTab !== "apikeys") return;
    fetchApiKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, apiKeyView]);

  // 切换账号视图时清掉「刚创建/重置」的明文提示卡 ——
  // 否则它会一直挂在那儿，让人误以为那是当前账号的密钥
  useEffect(() => {
    setFreshKey(null);
  }, [apiKeyView]);

  // 进入「API 密钥」页时自动把「已绑定账号的凭据」回填进密钥登记表：
  // 账号级的 Key/Secret 本身就是 DNSHE 上的一把有效密钥，回填后就不必显示成「未保存」，
  // 也省得用户为了一把其实能用的密钥去重置（重置还会打断面板自己的认证）。
  useEffect(() => {
    if (activeTab !== "apikeys") return;
    if (apiKeyBackfilledRef.current) return;
    apiKeyBackfilledRef.current = true;
    (async () => {
      try {
        const res = await apiFetch("/api/keys/backfill", { method: "POST" });
        const data = await res.json();
        // 真的回填进去了 ⇒ 当前列表的「未保存」标记已经过时，重新拉一次
        if (data?.success && (data.data?.filled ?? 0) > 0) fetchApiKeys(undefined, "force");
      } catch {
        /* 回填失败不影响列表浏览 */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // 账号序号：以 accounts 列表的顺序为准，而不是分组数组的下标。
  //
  // 分组数组会被搜索/账号筛选裁剪，用它的下标当序号会导致「只看某个账号时永远显示账号 1」。
  // 锚定到 accounts 后，序号在任何筛选下都保持不变，删除账号后又会自然重排。
  const accountSeqMap = useMemo(() => {
    const map = new Map<number, number>();
    dnsheAccounts.forEach((a, i) => map.set(a.id, i + 1));
    return map;
  }, [dnsheAccounts]);

  // 按账号分组处理域名列表
  const groupedDomains = useMemo(() => {
    const kw = globalSearch.trim().toLowerCase();
    // 关键词本身也转一次 Punycode：用户粘贴完整中文域名时可直接命中 ASCII 形态。
    // 注意中文「部分匹配」依赖上面的解码形态，因为半个标签的 Punycode 编码
    // 并不是整标签编码的子串。
    const kwAscii = kw ? toASCII(kw).toLowerCase() : "";
    const source = kw
      ? domains.filter((d) => {
          const hay = domainSearchIndex.get(d.id) || "";
          return hay.includes(kw) || (kwAscii !== kw && hay.includes(kwAscii));
        })
      : domains;
    const map = new Map<string, { alias: string; accountId: number; seq: number; domains: Domain[] }>();

    // 先按「已绑定账号」建组 —— 只要绑了就该出现在列表里，哪怕名下 0 个域名。
    // NOTE: 原先只从 domains 反推分组，导致**空账号在域名列表里凭空消失**：
    //       用户看到「已绑定 6 个账号、托管 49 个域名」，列表里却只有 4 组，
    //       会误以为账号丢了或同步失败。
    dnsheAccounts.forEach((a) => {
      map.set(String(a.id), {
        alias: a.alias,
        accountId: a.id,
        seq: accountSeqMap.get(a.id) ?? 0,
        domains: [],
      });
    });

    // 再把域名挂到对应组；account_id 不在已绑定列表里的（已解绑账号的历史残留）单独建组
    source.forEach((dom) => {
      const key = String(dom.account_id || 0);
      if (!map.has(key)) {
        map.set(key, {
          alias: dom.account_alias || `账号 ${dom.account_id}`,
          accountId: dom.account_id,
          // 已解绑账号的历史域名拿不到序号，用 0 表示（渲染处退化为只显示别名）
          seq: accountSeqMap.get(dom.account_id) ?? 0,
          domains: []
        });
      }
      map.get(key)!.domains.push(dom);
    });

    // 按账号序号排序，让卡片顺序与「账号管理」一致且不随筛选变化；
    // 无序号的（已解绑账号遗留）排在最后
    return Array.from(map.values())
      // 搜索时把 0 命中的空组收掉，否则满屏都是空标题
      .filter((g) => !kw || g.domains.length > 0)
      .sort((a, b) => {
        if (a.seq === 0) return 1;
        if (b.seq === 0) return -1;
        return a.seq - b.seq;
      });
  }, [domains, dnsheAccounts, globalSearch, domainSearchIndex, accountSeqMap]);

  // 当前搜索命中的域名总数 —— 供筛选栏提示使用。
  //
  // NOTE: 表头的「托管域名: N 个」读的是 domains.length（总数），搜索过滤发生在渲染层，
  //       两个数字不一致时很容易被误读成「账号和域名凭空少了一大半」。
  //       把命中数显式摆出来，让过滤状态不再是隐形的。
  const searchHitCount = useMemo(
    () => groupedDomains.reduce((n, g) => n + g.domains.length, 0),
    [groupedDomains]
  );

  // 立即发起域名同步
  /**
   * 立即同步域名（增量 + 分批接力）
   *
   * 🔴 后端两层收敛：① 增量 —— 上游 updated_at 没变过的域名不再重复查解析记录，
   *    稳态下一个账号只花 1 次子请求、「复核」数量为 0；② 预算 —— 单次调用只查得完
   *    预算内的域名（默认 34 个），剩下的用 pending 回传，这里循环接力直到清空。
   *    于是「某个账号域名特别多」也不会再撞上 Workers 免费版 50 个子请求的硬顶。
   *
   * NOTE: 进度以**域名**为单位（复核过的 / 复核过的 + 还欠着的），
   * 而不是账号数 —— 账号会被拆到多轮里，按账号计会重复计数（§8）。
   */
  const handleSyncDomains = async () => {
    setActionLoading("sync");
    setSyncProgress({ done: 0, total: 0 });
    try {
      let remaining: number[] | null = null;
      let round = 0;
      let checkedDomains = 0;
      let leftDomains = 0;
      const doneAccounts = new Set<number>();
      const failedAliases: string[] = [];
      const limitedAliases: string[] = [];

      do {
        round++;
        const res = await apiFetch("/api/domains/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(remaining ? { account_ids: remaining } : {}),
        });
        const data = await res.json();
        if (!data.success) {
          showToast("error", data.message || "启动同步域名任务失败");
          return;
        }
        for (const s of data.synced || []) {
          doneAccounts.add(s.id);
          checkedDomains += s.checked || 0;
          if (s.rateLimited) limitedAliases.push(s.alias);
        }
        for (const f of data.failed || []) failedAliases.push(f.alias);
        leftDomains = data.pending || 0;
        remaining = data.remaining && data.remaining.length ? data.remaining : null;
        setSyncProgress({ done: checkedDomains, total: checkedDomains + leftDomains });
      } while (remaining && round < 40);

      await fetchDomains();
      // 三种收尾状态都要说出来，不能只报「已同步」（§8）
      const notes: string[] = [];
      if (failedAliases.length > 0) {
        notes.push(`${failedAliases.length} 个账号失败：${failedAliases.join("、")}`);
      }
      if (limitedAliases.length > 0) {
        notes.push(`${limitedAliases.join("、")} 被上游限流，其余域名下次同步会自动补齐`);
      }
      if (leftDomains > 0 && remaining === null) {
        notes.push(`还有 ${leftDomains} 个域名未复核，再点一次同步可继续`);
      }
      const summary = `已同步 ${doneAccounts.size} 个账号的域名` +
        (checkedDomains > 0 ? `（本次复核 ${checkedDomains} 个变更）` : "，全部为最新");
      showToast(
        notes.length > 0 ? "warning" : "success",
        notes.length > 0 ? `${summary}；${notes.join("；")}` : summary
      );
    } catch (e) {
      showToast("error", "发起域名同步网络请求失败");
    } finally {
      setActionLoading(null);
      setSyncProgress(null);
    }
  };

  // 绑定新账号（别名可选，留空时后端自动从 API Key 解析密钥名称）
  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newApiKey.trim() || !newApiSecret.trim()) {
      showToast("error", "API Key 与 API Secret 为必填项！");
      return;
    }
    setActionLoading("add-account");
    try {
      const res = await apiFetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alias: newAlias,
          api_key: newApiKey,
          api_secret: newApiSecret
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", `账号 [${data.account?.alias || newAlias || newApiKey}] 验证并绑定成功！`);
        setNewAlias("");
        setNewApiKey("");
        setNewApiSecret("");
        setBindModalOpen(false);
        fetchAccounts();
        // 域名由后端 waitUntil 后台深度同步，轮询等它落库后再刷新列表
        waitForAccountDomainSync(
          [Number(data.account?.id)],
          `账号 [${data.account?.alias || newApiKey}] 绑定成功`
        );
      } else {
        showToast("error", data.message || "账号绑定失败，请检查密钥是否正确");
      }
    } catch (err) {
      showToast("error", "绑定请求发送失败，请检查网络");
    } finally {
      setActionLoading(null);
    }
  };

  // 批量绑定账号（每行一条：API Key + API Secret，支持空格/逗号/Tab 等分隔，别名留空自动解析）
  const handleBatchAddAccounts = async () => {
    const lines = splitBatchLines(batchInput);
    if (lines.length === 0) {
      showToast("error", "请先粘贴至少一条 API Key 与 API Secret");
      return;
    }
    if (lines.length > 50) {
      showToast("error", "单次最多批量绑定 50 个账号");
      return;
    }

    let parsed: Array<{ alias: string; api_key: string; api_secret: string }> = [];

    // 兼容 JSON 数组格式：[{"api_key":"cfsd_xx","api_secret":"yy","alias":"可选"}]
    try {
      const jsonParsed = JSON.parse(batchInput.trim());
      if (Array.isArray(jsonParsed) && jsonParsed.length > 0 && jsonParsed[0]?.api_key) {
        parsed = jsonParsed.map((it) => ({
          alias: it.alias ? String(it.alias).trim() : "",
          api_key: String(it.api_key).trim(),
          api_secret: String(it.api_secret).trim(),
        }));
      }
    } catch (e) {
      // 非 JSON，走逐行解析
    }

    // 逐行解析：key 与 secret 用空格 / Tab / 逗号 / 竖线 分隔
    if (parsed.length === 0) {
      let invalidLines = 0;
      for (const line of lines) {
        const parts = line.split(/[\s,，|]+/).map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
          parsed.push({
            api_key: parts[0],
            api_secret: parts[1],
            alias: parts.length >= 3 ? parts.slice(2).join(" ") : "",
          });
        } else {
          invalidLines++;
        }
      }
      if (invalidLines > 0) {
        showToast("warning", `${invalidLines} 行格式不正确（每行需包含 API Key 与 API Secret），已自动跳过`);
      }
    }

    if (parsed.length === 0) {
      showToast("error", "未能解析出任何有效的账号信息，请检查输入格式");
      return;
    }

    setActionLoading("batch-add-accounts");
    setBatchResults(null);
    try {
      const res = await apiFetch("/api/accounts/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: parsed }),
      });
      const data = await res.json();
      if (data.success) {
        setBatchResults(data.results || []);
        showToast("success", data.message || "批量绑定完成");
        setBatchInput("");
        fetchAccounts();
        // 后端按账号串行同步（每个间隔 1.2s），轮询等这批账号的域名全部落库
        waitForAccountDomainSync(
          (data.account_ids || []).map(Number),
          `${(data.account_ids || []).length} 个账号绑定成功`
        );
      } else {
        showToast("error", data.message || "批量绑定失败");
      }
    } catch (err) {
      showToast("error", "批量绑定请求发送失败，请检查网络");
    } finally {
      setActionLoading(null);
    }
  };

  // 解绑账号
  const handleDeleteAccount = async (id: number) => {
    if (!confirm("确定要解绑该账号吗？这会同步清除该账号缓存的域名及解析日志！")) return;
    setActionLoading(`delete-account-${id}`);
    try {
      const res = await apiFetch(`/api/accounts/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showToast("success", "账户解绑成功");
        fetchAccounts();
        fetchDomains();
        // 后端已从配额缓存中摘掉该账号，同步刷新配额列表，避免配额页还列着它
        invalidateQuotaTabCache();
        fetchQuotas();
      } else {
        showToast("error", data.message || "账户解绑失败");
      }
    } catch (e) {
      showToast("error", "解绑请求发送失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 打开修改账号弹窗
  const openEditAccount = (acc: Account) => {
    setEditingAccount(acc);
    setEditAlias(acc.alias);
    setEditApiKey("");
    setEditApiSecret("");
  };

  // 提交修改账号（可仅改别名，或同时更换 API Key/Secret）
  const handleUpdateAccount = async () => {
    if (!editingAccount) return;
    if (!editAlias.trim()) {
      showToast("error", "账户别名不能为空");
      return;
    }
    if (Boolean(editApiKey.trim()) !== Boolean(editApiSecret.trim())) {
      showToast("error", "更换 API 密钥时，API Key 与 API Secret 需同时填写（留空则保持不变）");
      return;
    }
    setActionLoading(`update-account-${editingAccount.id}`);
    const accountId = editingAccount.id;
    try {
      const body: Record<string, string> = { alias: editAlias.trim() };
      const keyChanged = Boolean(editApiKey.trim() && editApiSecret.trim());
      if (keyChanged) {
        body.api_key = editApiKey.trim();
        body.api_secret = editApiSecret.trim();
      }

      // 换 Key 会触发后台重新深度同步，先记下当前指纹作为「同步已生效」的对照基线
      const baseline = new Map<number, string>();
      if (keyChanged) {
        const current = await readAccountDomainFingerprint(accountId);
        if (current !== null) baseline.set(accountId, current);
      }

      const res = await apiFetch(`/api/accounts/${accountId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", data.message || "账号信息已更新");
        setEditingAccount(null);
        fetchAccounts();
        if (keyChanged) {
          // 只改别名时后端不会重新同步域名，没必要轮询
          waitForAccountDomainSync([accountId], "API 密钥已更换", baseline);
        } else {
          fetchDomains();
          // 后端已就地改掉配额缓存里的别名，刷新一次让配额页的标题跟上
          invalidateQuotaTabCache();
          fetchQuotas();
        }
      } else {
        // 密钥框非空却失败，多半是被密码管理器预填的登录凭据当成了新密钥送去校验
        const hint = keyChanged ? "（若 API Key/Secret 是浏览器自动填充的，请清空这两个框后重试）" : "";
        showToast("error", `${data.message || "更新账号失败"}${hint}`);
      }
    } catch (e) {
      showToast("error", "更新账号请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 手动续期子域名
  const handleRenewDomain = async (domain: Domain) => {
    setActionLoading(`renew-${domain.id}`);
    try {
      const res = await apiFetch(`/api/domains/${domain.id}/renew`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        showToast("success", `域名 [${domain.full_domain}] 手动续期成功！新有效期至 ${data.new_expires_at}`);
        fetchDomains();
      } else {
        showToast("error", data.message || "续期请求被拦截或失败，请检查是否处于续期窗口");
      }
    } catch (e) {
      showToast("error", "续期网络请求发生异常");
    } finally {
      setActionLoading(null);
    }
  };

  // 删除确认校验：中文原文与 Punycode 两种写法都算通过（与后端校验规则保持一致）
  const isDeleteConfirmed = (domain: Domain, input: string) => {
    const typed = input.trim().toLowerCase();
    if (!typed) return false;
    const expected = (domain.full_domain || "").toLowerCase();
    return typed === expected || toASCII(typed).toLowerCase() === expected;
  };

  // 打开删除确认弹窗
  const handleOpenDeleteModal = (domain: Domain) => {
    setDeleteModalDomain(domain);
    setDeleteConfirmInput("");
    setDeleteError("");
  };

  // 执行删除域名（不可逆）
  const handleDeleteDomain = async () => {
    if (!deleteModalDomain) return;
    const dom = deleteModalDomain;

    setActionLoading(`delete-${dom.id}`);
    setDeleteError("");
    try {
      const res = await apiFetch(`/api/domains/${dom.id}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm_domain: deleteConfirmInput.trim() })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", `域名 [${toUnicode(dom.full_domain)}] 已删除`);
        setDeleteModalDomain(null);
        setDeleteConfirmInput("");
        fetchDomains();
      } else {
        // 限制类错误（存在解析记录 / 转赠 / ServerHold / PendingDelete）保留弹窗并就地展示原因
        setDeleteError(data.message || "删除失败");
      }
    } catch (e) {
      setDeleteError("删除请求发生网络异常");
    } finally {
      setActionLoading(null);
    }
  };

  // 打开 NS 管理模态框
  const handleOpenNsModal = async (domain: Domain) => {
    setNsModalDomain(domain);
    setNsModalOpen(true);
    setLoadingNsModal(true);
    setNsRecords([]);
    setNewCustomNsContent("");

    try {
      const res = await apiFetch(`/api/domains/${domain.id}/dns`);
      const data = await res.json();
      if (data.success) {
        const nsOnly = (data.records || []).filter((r: DnsRecord) => r.type === "NS");
        setNsRecords(nsOnly);
      } else {
        showToast("error", data.message || "获取 NS 记录失败");
      }
    } catch (e) {
      showToast("error", "获取 NS 记录网络异常");
    } finally {
      setLoadingNsModal(false);
    }
  };

  // ─────────────────── 一键委派到 Cloudflare（第19轮）───────────────────
  //
  // 为什么是两阶段、且**先委派后迁记录**（用户 2026-10-02 定稿）：
  //   委派（建 zone + 改 NS）与记录迁移是两件独立的事。若在委派前就把记录抄进 CF，
  //   抄错或抄串了用户根本没有反驳的机会；反过来先委派、再把「从 DNSHE 读到的原始
  //   记录清单」摊开让人逐条勾选确认，任何一条不该过去的记录都能当场划掉。
  //   代价是委派生效到记录写入之间有一段解析真空 —— 所以确认框里必须写清楚。

  // 打开委派弹窗（重置两阶段状态，避免上一次的残留串到这一次）
  const handleOpenDelegateModal = (dom: Domain) => {
    setDelegateDomain(dom);
    setDelegateStep("confirm");
    setDelegateError("");
    setDelegateResult(null);
    setDelegateSelectedKeys(new Set());
    setDelegateApplyResults(null);
    // 只绑定了一个 CF 账号就预选，省一次点击；绑了多个才让用户显式挑
    setDelegateCfAccountId(cfAccounts.length === 1 ? String(cfAccounts[0].id) : "");
  };

  // 阶段一：建 zone + 写 NS（全部在后端一次完成），拿回「待迁移记录清单」
  const handleStartDelegate = async () => {
    if (!delegateDomain) return;
    setDelegateLoading(true);
    setDelegateError("");
    try {
      const res = await apiFetch(`/api/domains/${delegateDomain.id}/delegate-cloudflare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cf_account_id: delegateCfAccountId || undefined })
      });
      const data = await res.json();
      if (!data.success) {
        // 就地展示原因（Token 缺权限 / 根域不支持 / 没绑账号），不弹 toast ——
        // 用户需要边看原因边改设置，toast 几秒就没了
        setDelegateError(data.message || "委派失败");
        return;
      }
      setDelegateResult(data);
      // 默认全选：委派的目的是把解析搬过去，逐条取消比逐条勾选常见得多
      setDelegateSelectedKeys(new Set((data.records || []).map((_: DnsRecord, i: number) => String(i))));
      setDelegateStep("records");
      const nsFailed: Array<{ ns: string }> = data.ns_failed || [];
      showToast(
        nsFailed.length === 0 ? "success" : "warning",
        nsFailed.length === 0
          ? `已${data.zone_reused ? "复用" : "创建"} Cloudflare zone，写入 ${data.ns_written.length} 条 NS，委派已提交`
          : `已创建 zone，但 ${nsFailed.length} 条 NS 写入失败，委派尚未生效`
      );
      // DNSHE 侧记录被清理、NS 已变，本地列表的三态过时了，顺手同步一次
      handleSyncDomains();
    } catch (e) {
      setDelegateError("委派请求发生网络异常");
    } finally {
      setDelegateLoading(false);
    }
  };

  // 阶段二：把用户勾选的记录重建到刚建好的 CF zone
  // 复用现成的批量创建接口 —— 它按域名所属账号的 provider 自动分发到 Cloudflare 客户端
  const handleApplyDelegateRecords = async () => {
    if (!delegateResult) return;
    const rows = delegateResult.records || [];
    const picked = rows.filter((_, i) => delegateSelectedKeys.has(String(i)));
    if (picked.length === 0) {
      showToast("warning", "没有勾选任何记录，未写入 Cloudflare");
      return;
    }
    setDelegateLoading(true);
    try {
      const res = await apiFetch(`/api/domains/${delegateResult.zone_numeric_id}/dns/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          records: picked.map((r) => ({
            type: r.type,
            name: r.name,
            content: r.content,
            // CF 以 ttl=1 表示「自动」，这里原样透传；缺 TTL 的老记录给 600 兜底
            ttl: Number(r.ttl) > 0 ? Number(r.ttl) : 600,
            priority: r.priority ?? undefined
          }))
        })
      });
      const data = await res.json();
      if (!data.success) {
        showToast("error", data.message || "写入 Cloudflare 失败");
        return;
      }
      setDelegateApplyResults(data.results || []);
      // §8：收尾必须说清「做了多少 / 成功几个 / 几个没做完」
      const ok = Number(data.success_count) || 0;
      const bad = Number(data.fail_count) || 0;
      showToast(
        bad === 0 ? "success" : "warning",
        bad === 0
          ? `已把 ${ok} 条解析记录重建到 Cloudflare，委派完成`
          : `已重建 ${ok} 条，${bad} 条失败 —— 可对照下方原因处理后重试`
      );
      fetchDomains();
    } catch (e) {
      showToast("error", "写入 Cloudflare 发生网络异常");
    } finally {
      setDelegateLoading(false);
    }
  };

  // 逐条勾选 / 全选（清单冻结后下标即稳定键）
  const toggleDelegateRecord = (key: string) =>
    setDelegateSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleAllDelegateRecords = () => {
    const total = delegateResult?.records?.length ?? 0;
    setDelegateSelectedKeys((prev) =>
      prev.size === total ? new Set() : new Set(Array.from({ length: total }, (_, i) => String(i)))
    );
  };

  // 一键恢复为系统默认 NS / 清理残留 NS 记录（两者都是删除区域内的 NS 解析记录）
  const handleResetToDefaultNs = async () => {
    if (!nsModalDomain) return;
    const isDefaultNs = checkHasDns(nsModalDomain);
    const confirmMsg = isDefaultNs
      ? `域名 [${nsModalDomain.full_domain}] 已委派回系统默认 NS，确定清理区域内残留的 ${nsRecords.length} 条 NS 解析记录吗？`
      : `确定要将域名 [${nsModalDomain.full_domain}] 恢复为系统默认 NS 吗？这会清除当前配置的第三方 NS 记录。`;
    if (!confirm(confirmMsg)) return;

    setActionLoading("reset-ns");
    try {
      // 逐条删除并检查每条的业务结果 —— apiFetch 只在网络层失败时抛异常，
      // 后端返回 {success:false} 时不会抛，若不检查就会误报"恢复成功"而记录仍在。
      const failed: Array<{ ns: string; msg: string }> = [];
      let nsDisabled = false;

      for (const rec of nsRecords) {
        const label = rec.content || rec.name || String(rec.id ?? rec.record_id);
        try {
          const res = await apiFetch(`/api/domains/${nsModalDomain.id}/dns/${rec.id ?? rec.record_id}`, {
            method: "DELETE"
          });
          const data = await res.json().catch(() => ({ success: res.ok }));
          if (!data.success) {
            if (data.error_code === "ns_management_disabled") nsDisabled = true;
            failed.push({ ns: label, msg: data.message || `HTTP ${res.status}` });
          }
        } catch (err) {
          failed.push({ ns: label, msg: err instanceof Error ? err.message : "请求异常" });
        }
      }

      if (failed.length === 0) {
        showToast(
          "success",
          isDefaultNs
            ? `已清理 ${nsRecords.length} 条残留 NS 记录`
            : `域名 [${nsModalDomain.full_domain}] 已成功恢复为系统默认 NS！`
        );
        setNsModalOpen(false);
      } else {
        showToast(
          "error",
          nsDisabled
            ? "DNSHE 上游平台已禁用 NS 管理，无法通过 API 删除 NS 记录。请前往 DNSHE 官网后台手动设置。"
            : `${failed.length} 条 NS 记录删除失败：${failed.map(f => `${f.ns}(${f.msg})`).join("；")}`
        );
        // 失败时保持弹窗打开并刷新列表，让实际剩余记录可见
        handleOpenNsModal(nsModalDomain);
      }
      handleSyncDomains();
    } catch (e) {
      showToast("error", "恢复系统默认 NS 发生异常");
    } finally {
      setActionLoading(null);
    }
  };

  // 把 NS 输入框内容解析为去重后的地址列表（换行/逗号/空格分隔，去掉末尾的根点）
  const parseNsInput = (text: string): string[] =>
    Array.from(
      new Set(
        text
          .split(/[,，;；\s\n]+/)
          .map(s => s.trim().replace(/\.$/, "").toLowerCase())
          .filter(Boolean)
      )
    );

  // 输入框实时解析结果，供表单显示「已识别 N 条」
  const parsedNsList = useMemo(() => parseNsInput(newCustomNsContent), [newCustomNsContent]);

  // 添加自定义 NS 记录 (支持一次填多个，逐条提交；并可自动清理与 NS 冲突的同名记录)
  const handleAddCustomNs = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nsModalDomain) return;

    // NS 委派通常要求至少主备两条，这里逐条提交
    const nsList = parseNsInput(newCustomNsContent);
    if (nsList.length === 0) return;

    setActionLoading("add-ns");
    try {
      if (forceReplaceConflict) {
        // 1. 先查询当前域名的已有解析记录
        const res = await apiFetch(`/api/domains/${nsModalDomain.id}/dns`);
        const data = await res.json();
        if (data.success && Array.isArray(data.records)) {
          // 2. 筛选出非 NS 类型的冲突记录 (如 A, CNAME, TXT, MX 等)
          const conflicts = data.records.filter((r: DnsRecord) => r.type !== "NS");
          const undeleted: string[] = [];
          for (const conf of conflicts) {
            try {
              const delRes = await apiFetch(
                `/api/domains/${nsModalDomain.id}/dns/${conf.id ?? conf.record_id}`,
                { method: "DELETE" }
              );
              const delData = await delRes.json().catch(() => ({ success: delRes.ok }));
              if (!delData.success) undeleted.push(`${conf.type} ${conf.name}`);
            } catch {
              undeleted.push(`${conf.type} ${conf.name}`);
            }
          }
          // 删不掉要说出来：否则后面 NS 添加失败时，用户会以为是别的原因
          if (undeleted.length > 0) {
            showToast("warning", `${undeleted.length} 条冲突记录未能删除：${undeleted.join("、")}`);
          }
        }
      }

      // 3. 逐条创建 NS 记录。上游接口一次只收一条，且有限频，因此串行提交。
      //    单条失败不中断其余条目，最后统一汇报，避免"加了一半却什么都没说"。
      const succeeded: string[] = [];
      const failed: Array<{ ns: string; msg: string }> = [];
      let nsDisabled = false;

      for (const ns of nsList) {
        try {
          const res = await apiFetch(`/api/domains/${nsModalDomain.id}/dns`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "NS", name: "@", content: ns, ttl: 86400 })
          });
          const data = await res.json();
          if (data.success) {
            succeeded.push(ns);
          } else {
            if (data.error_code === "ns_management_disabled") nsDisabled = true;
            failed.push({ ns, msg: data.message || "添加失败" });
          }
        } catch (err) {
          failed.push({ ns, msg: err instanceof Error ? err.message : "请求异常" });
        }
      }

      if (succeeded.length > 0) {
        showToast("success", `成功添加 ${succeeded.length} 条 NS 记录：${succeeded.join("、")}`);
        setNewCustomNsContent("");
        handleOpenNsModal(nsModalDomain);
        handleSyncDomains();
      }

      if (failed.length > 0) {
        showToast(
          "error",
          nsDisabled
            ? "DNSHE 上游平台已禁用 NS 管理，无法通过 API 修改 NS 记录。请前往 DNSHE 官网后台手动设置。"
            : `${failed.length} 条添加失败：${failed.map(f => `${f.ns}(${f.msg})`).join("；")}${
                succeeded.length === 0 ? "。可尝试勾选【强制替换冲突记录】" : ""
              }`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "添加 NS 记录发生异常";
      showToast("error", msg);
    } finally {
      setActionLoading(null);
    }
  };

  // 拉取解析记录列表（只刷新列表，不重置弹窗内已展开的表单与批量结果）
  const reloadDnsRecords = async (domain: Domain, forceRefresh = false) => {
    const seq = ++dnsLoadSeqRef.current;
    setLoadingDns(true);
    // 记录集合变了，之前的勾选与行内编辑都可能指向已不存在的行，一并作废
    setSelectedDnsKeys(new Set());
    setEditingDnsKey(null);
    // 批量修改面板依赖勾选，勾选清空后面板也没有意义（结果回执保留给用户看）
    setDnsEditPanelOpen(false);

    try {
      const res = await apiFetch(`/api/domains/${domain.id}/dns${forceRefresh ? "?refresh=1" : ""}`);
      const data = await res.json();
      // 期间又发起了更晚的一次加载 → 本次结果已过期，丢弃（连 loading 也不动，交给新请求收尾）
      if (seq !== dnsLoadSeqRef.current) return;
      if (data.success) {
        const records: DnsRecord[] = data.records || [];
        setDnsRecords(records);
        // 顺手确认根域是否支持线路（数据本来就要读，零额外上游调用）
        learnLineRootFrom(domain, records);
      } else {
        showToast("error", data.message || "加载 DNS 解析记录失败");
      }
    } catch (e) {
      if (seq !== dnsLoadSeqRef.current) return;
      showToast("error", "加载 DNS 记录发生网络异常");
    } finally {
      if (seq === dnsLoadSeqRef.current) setLoadingDns(false);
    }
  };

  // 打开 DNS 管理面板
  const handleOpenDnsModal = async (domain: Domain, forceRefresh = false) => {
    setSelectedDomain(domain);
    setDnsModalOpen(true);
    setDnsRecords([]);
    setDnsFormOpen(false);

    // 初始化表单字段
    setNewDnsName("");
    setNewDnsContent("");
    setNewDnsType("A");
    setNewDnsTtl(600);
    setNewDnsPriority(10);
    setNewDnsLine("");

    // 初始化批量添加面板
    setDnsBatchOpen(false);
    setDnsBatchInput("");
    setDnsBatchType("A");
    setDnsBatchName("@");
    setDnsBatchTtl(600);
    setDnsBatchPriority(10);
    setDnsBatchLine("");
    setDnsBatchResults(null);

    // 初始化批量修改面板
    setDnsEditPanelOpen(false);
    setDnsEditFields({ type: false, name: false, content: false, ttl: true, line: false, priority: false, proxied: false });
    setDnsEditResults(null);

    await reloadDnsRecords(domain, forceRefresh);
  };

  // 创建新 DNS 记录
  const handleCreateDnsRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDomain) return;
    if (!newDnsContent.trim()) {
      showToast("error", "解析记录值不能为空！");
      return;
    }

    setActionLoading("create-dns");
    try {
      const res = await apiFetch(`/api/domains/${selectedDomain.id}/dns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: newDnsType,
          name: newDnsName || "@",
          content: newDnsContent,
          ttl: newDnsTtl,
          priority: needsDnsPriority(newDnsType) ? newDnsPriority : undefined,
          line: newDnsLine || undefined
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", "DNS 解析记录创建成功！");
        setNewDnsName("");
        setNewDnsContent("");
        setDnsFormOpen(false);
        reloadDnsRecords(selectedDomain);
        fetchDomains();
      } else {
        showToast("error", data.message || "创建解析记录失败");
      }
    } catch (err) {
      showToast("error", "创建解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 进入某条记录的行内编辑态：把当前值灌进编辑表单
  const handleStartEditDnsRecord = (rec: DnsRecord) => {
    setEditingDnsKey(dnsRecordKey(rec));
    setEditDnsType(rec.type || "A");
    // 上游读到的是完整域名，编辑框里要显示相对名（@ / jp），否则改完提交会被上游拒绝
    setEditDnsName(toRelativeRecordName(rec.name, selectedDomain?.full_domain || ""));
    setEditDnsContent(rec.content || "");
    setEditDnsTtl(rec.ttl > 0 ? rec.ttl : 600);
    setEditDnsPriority(rec.priority !== null && rec.priority !== undefined ? rec.priority : 10);
    setEditDnsLine(rec.line || "");
  };

  // 提交行内修改
  const handleUpdateDnsRecord = async (recordId: string | number) => {
    if (!selectedDomain) return;
    if (!editDnsContent.trim()) {
      showToast("error", "解析记录值不能为空！");
      return;
    }

    setActionLoading(`update-dns-${recordId}`);
    try {
      const res = await apiFetch(`/api/domains/${selectedDomain.id}/dns/${recordId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: editDnsType,
          name: editDnsName.trim() || "@",
          content: editDnsContent.trim(),
          ttl: editDnsTtl,
          priority: needsDnsPriority(editDnsType) ? editDnsPriority : undefined,
          line: editDnsLine.trim() || undefined
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", "DNS 解析记录修改成功！");
        setEditingDnsKey(null);
        reloadDnsRecords(selectedDomain);
        fetchDomains();
      } else {
        showToast("error", data.message || "修改解析记录失败");
      }
    } catch (e) {
      showToast("error", "修改解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 行内编辑的键盘操作：回车保存、Esc 取消（表格行里放不了 <form>，只能手工绑定）
  const handleEditDnsKeyDown = (e: React.KeyboardEvent, recordId: string) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleUpdateDnsRecord(recordId);
    } else if (e.key === "Escape") {
      setEditingDnsKey(null);
    }
  };

  /**
   * 单条解析记录在「桌面表格行」与「手机卡片」两种布局下共用的字段节点
   *
   * NOTE: 表格行必须待在 <tbody> 里、卡片必须在表格外，两种布局无法共用一次 map；
   * 但这 6 个受控输入的定义只写这一份 —— 复制两套的话，日后改一处漏一处，
   * 行内编辑很快就会在其中一种宽度下失灵。
   */
  const dnsRowParts = (rec: DnsRecord) => {
    const key = dnsRecordKey(rec);
    const isEditing = editingDnsKey === key;
    const saving = actionLoading === `update-dns-${key}`;

    return {
      key,
      isEditing,
      // ── 勾选（批量操作用）──
      checkbox: (
        <input
          type="checkbox"
          checked={selectedDnsKeys.has(key)}
          onChange={() => toggleDnsSelection(key)}
          className="w-4 h-4 accent-indigo-500 cursor-pointer align-middle"
        />
      ),
      // ── 编辑态控件 ──
      typeSelect: (
        <select
          value={editDnsType}
          onChange={(e) => setEditDnsType(e.target.value)}
          className="w-full form-input px-2 h-8 rounded text-xs text-content-secondary"
        >
          {DNS_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.value}</option>
          ))}
        </select>
      ),
      nameInput: (
        <input
          type="text"
          name="dns-edit-name"
          autoComplete="off"
          value={editDnsName}
          onChange={(e) => setEditDnsName(e.target.value)}
          onKeyDown={(e) => handleEditDnsKeyDown(e, key)}
          placeholder="@ 或 jp"
          title={`只能填相对名：@ 代表 ${selectedDomain?.full_domain ?? ""}，jp 代表 jp.${selectedDomain?.full_domain ?? ""}`}
          className="w-full form-input px-2 h-8 rounded text-xs text-content-secondary"
        />
      ),
      contentInput: (
        <input
          type="text"
          name="dns-edit-content"
          autoComplete="off"
          value={editDnsContent}
          onChange={(e) => setEditDnsContent(e.target.value)}
          onKeyDown={(e) => handleEditDnsKeyDown(e, key)}
          placeholder="记录值"
          className="flex-1 min-w-0 form-input px-2 h-8 rounded text-xs text-content-secondary"
        />
      ),
      priorityInput: needsDnsPriority(editDnsType) ? (
        <input
          type="number"
          name="dns-edit-priority"
          autoComplete="off"
          min={0}
          max={65535}
          value={editDnsPriority}
          onChange={(e) => setEditDnsPriority(parseInt(e.target.value, 10) || 0)}
          onKeyDown={(e) => handleEditDnsKeyDown(e, key)}
          title="优先级"
          className="w-16 form-input px-2 h-8 rounded text-xs text-content-secondary"
        />
      ) : null,
      ttlInput: (
        <input
          type="number"
          name="dns-edit-ttl"
          autoComplete="off"
          min={120}
          max={86400}
          value={editDnsTtl}
          onChange={(e) => setEditDnsTtl(parseInt(e.target.value, 10) || 600)}
          onKeyDown={(e) => handleEditDnsKeyDown(e, key)}
          className="w-full form-input px-2 h-8 rounded text-xs text-content-secondary"
        />
      ),
      lineInput: (
        <DnsLineSelect
          value={editDnsLine}
          onChange={setEditDnsLine}
          supported={domainSupportsLine(selectedDomain)}
          onKeyDown={(e) => handleEditDnsKeyDown(e, key)}
          className="w-full form-input px-2 h-8 rounded text-xs text-content-secondary"
        />
      ),
      saveButton: (
        <button
          onClick={() => handleUpdateDnsRecord(key)}
          disabled={saving}
          className="text-emerald-700 hover:text-emerald-800 disabled:opacity-50 p-2 md:p-1 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:text-emerald-300 dark:hover:bg-emerald-950/40 rounded transition-all"
          title="保存修改（回车）"
        >
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        </button>
      ),
      cancelButton: (
        <button
          onClick={() => setEditingDnsKey(null)}
          className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded transition-all"
          title="取消（Esc）"
        >
          <X className="w-4 h-4" />
        </button>
      ),
      // ── 展示态操作 ──
      editButton: (
        <button
          onClick={() => handleStartEditDnsRecord(rec)}
          className="text-indigo-600 hover:text-indigo-700 p-2 md:p-1 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:text-indigo-300 dark:hover:bg-indigo-950/40 rounded transition-all"
          title="修改此记录"
        >
          <Pencil className="w-4 h-4" />
        </button>
      ),
      deleteButton: (
        <button
          onClick={() => handleDeleteDnsRecord(key)}
          disabled={actionLoading === `delete-dns-${key}`}
          className="text-red-600 hover:text-red-700 disabled:opacity-50 p-2 md:p-1 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-950/40 rounded transition-all"
          title="删除此记录"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      ),
    };
  };

  // 删除 DNS 记录
  // NOTE: domain 显式传入 —— NS 弹窗里删除 NS 记录时打开的是 nsModalDomain，
  // 与 DNS 弹窗的 selectedDomain 不一定是同一个域名（甚至可能为 null）。
  const handleDeleteDnsRecord = async (recordId: string | number, domain: Domain | null = selectedDomain) => {
    if (!domain) return;
    if (!confirm("确定要删除这条 DNS 解析记录吗？这会立即影响该域名的解析！")) return;

    setActionLoading(`delete-dns-${recordId}`);
    try {
      const res = await apiFetch(`/api/domains/${domain.id}/dns/${recordId}`, {
        method: "DELETE"
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", "DNS 解析记录删除成功！");
        if (dnsModalOpen && selectedDomain?.id === domain.id) {
          reloadDnsRecords(domain);
        }
        fetchDomains();
      } else {
        showToast("error", data.message || "删除解析记录失败");
      }
    } catch (e) {
      showToast("error", "删除解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 勾选 / 取消勾选单条记录（用于批量删除）
  const toggleDnsSelection = (key: string) => {
    const next = new Set(selectedDnsKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setSelectedDnsKeys(next);
  };

  // 全选 / 取消全选当前列表
  const toggleAllDnsSelection = () => {
    if (selectedDnsKeys.size === dnsRecords.length) {
      setSelectedDnsKeys(new Set());
    } else {
      setSelectedDnsKeys(new Set(dnsRecords.map(dnsRecordKey)));
    }
  };

  // 当前勾选的记录（批量修改 / 批量删除共用）
  const selectedDnsRecords = useMemo(
    () => dnsRecords.filter((rec) => selectedDnsKeys.has(dnsRecordKey(rec))),
    [dnsRecords, selectedDnsKeys]
  );

  // 批量修改的目标记录：勾选的字段用新值，其余字段沿用每条记录的原值
  const batchEditTargets = useMemo(
    () =>
      buildDnsEditTargets(
        selectedDnsRecords,
        dnsEditFields,
        {
          type: batchEditType,
          name: batchEditName,
          content: "",
          ttl: batchEditTtl,
          line: batchEditLine,
          priority: batchEditPriority,
          proxied: false
        },
        selectedDomain?.full_domain || "",
        batchEditContents
      ),
    [
      selectedDnsRecords,
      selectedDomain,
      dnsEditFields,
      batchEditType,
      batchEditName,
      batchEditContents,
      batchEditTtl,
      batchEditLine,
      batchEditPriority
    ]
  );

  // 真正需要提交的记录：合并后与原记录完全一致的跳过，不为没变化的记录白跑一次上游
  const batchEditChanged = useMemo(
    () => batchEditTargets.filter((t) => !t.unchanged),
    [batchEditTargets]
  );

  // 面板里是否需要露出优先级：改成 MX / SRV，或选中的记录里本来就有 MX / SRV
  const batchEditNeedsPriority = dnsEditFields.type
    ? needsDnsPriority(batchEditType)
    : selectedDnsRecords.some((rec) => needsDnsPriority(rec.type));

  // 打开批量修改面板：默认值取第一条选中记录，避免面板一开就是空的
  const handleOpenDnsEditPanel = () => {
    const first = selectedDnsRecords[0];
    if (first) {
      setBatchEditType(first.type || "A");
      setBatchEditName(toRelativeRecordName(first.name, selectedDomain?.full_domain || ""));
      setBatchEditTtl(first.ttl > 0 ? first.ttl : 600);
      setBatchEditLine(first.line || "");
      setBatchEditPriority(first.priority !== null && first.priority !== undefined ? first.priority : 10);
    }
    // 逐条记录值预填各自原值，用户只改需要改的那几行
    setBatchEditContents(
      Object.fromEntries(selectedDnsRecords.map((rec) => [dnsRecordKey(rec), rec.content || ""]))
    );
    setDnsEditResults(null);
    setDnsEditPanelOpen(true);
  };

  // 批量修改已勾选的解析记录（后端串行提交并逐条回执）
  const handleBatchUpdateDnsRecords = async () => {
    if (!selectedDomain || batchEditTargets.length === 0) return;

    const enabled = Object.entries(dnsEditFields).filter(([, on]) => on).map(([k]) => k);
    if (enabled.length === 0) {
      showToast("error", "请至少勾选一个要修改的字段");
      return;
    }
    if (batchEditChanged.length === 0) {
      showToast("info", "选中的记录与当前值一致，没有需要提交的修改");
      return;
    }
    if (batchEditChanged.length > 50) {
      showToast("error", "单次最多批量修改 50 条解析记录");
      return;
    }

    setActionLoading("batch-update-dns");
    setDnsEditResults(null);
    try {
      const res = await apiFetch(`/api/domains/${selectedDomain.id}/dns/batch-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: batchEditChanged })
      });
      const data = await res.json();
      if (data.success) {
        setDnsEditResults(data.results || []);
        if (data.fail_count === 0) {
          showToast("success", `已修改 ${data.success_count} 条解析记录`);
          setDnsEditPanelOpen(false);
        } else {
          showToast(
            "warning",
            data.error_code === "ns_management_disabled"
              ? "DNSHE 上游平台已禁用 NS 管理，NS 记录无法通过 API 修改。请前往 DNSHE 官网后台手动设置。"
              : `批量修改完成：成功 ${data.success_count} 条，失败 ${data.fail_count} 条（详见下方明细）`
          );
        }
        reloadDnsRecords(selectedDomain);
        fetchDomains();
      } else {
        showToast("error", data.message || "批量修改解析记录失败");
      }
    } catch (e) {
      showToast("error", "批量修改解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 批量删除已勾选的解析记录（后端串行删除并逐条回执）
  const handleBatchDeleteDnsRecords = async () => {
    if (!selectedDomain || selectedDnsKeys.size === 0) return;

    const targets = selectedDnsRecords.map((rec) => ({
      record_id: dnsRecordKey(rec),
      label: `${rec.type} ${rec.name} → ${rec.content}`
    }));

    if (
      !confirm(
        `确定要删除选中的 ${targets.length} 条 DNS 解析记录吗？这会立即影响该域名的解析！\n\n${targets
          .map((t) => t.label)
          .join("\n")}`
      )
    ) {
      return;
    }

    setActionLoading("batch-delete-dns");
    try {
      const res = await apiFetch(`/api/domains/${selectedDomain.id}/dns/batch-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: targets })
      });
      const data = await res.json();
      if (data.success) {
        const failed = (data.results || []).filter((r: { success: boolean }) => !r.success);
        if (failed.length === 0) {
          showToast("success", `已删除 ${data.success_count} 条解析记录`);
        } else {
          showToast(
            "error",
            data.error_code === "ns_management_disabled"
              ? "DNSHE 上游平台已禁用 NS 管理，NS 记录无法通过 API 删除。请前往 DNSHE 官网后台手动设置。"
              : `${failed.length} 条删除失败：${failed
                  .map((f: { label: string; message: string }) => `${f.label}(${f.message})`)
                  .join("；")}`
          );
        }
        reloadDnsRecords(selectedDomain);
        fetchDomains();
      } else {
        showToast("error", data.message || "批量删除解析记录失败");
      }
    } catch (e) {
      showToast("error", "批量删除解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // ===== Cloudflare：数据派生与处理函数 =====
  //
  // NOTE: 与 DNSHE 的 DNS 面板保持同样的交互形态（单条添加 / 行内修改 / 批量添加 /
  //       批量修改 / 批量删除），复用同一批后端路由与 dnsrecords.ts 纯逻辑；
  //       差异点只有两个 —— 没有解析线路，多了橙色云代理开关，TTL 1 表示「自动」。

  // Cloudflare 账号列表（从账号列表中过滤，绑定/解绑后随 accounts 一起刷新）
  const cfAccountList = useMemo(
    () => accounts.filter((a) => a.provider === "cloudflare"),
    [accounts]
  );

  // CF zones 按账号分组。选择特定账号时只生成该账号的分组（其余隐藏，与域名列表页
  // 的账号筛选行为一致）；选中的账号若还没有 zone 数据，保留分组提示用户去同步
  const groupedCfZones = useMemo(() => {
    const groups: Array<{ accountId: number; alias: string; zones: Domain[] }> = [];
    const byId = new Map<number, { accountId: number; alias: string; zones: Domain[] }>();
    cfAccountList.forEach((acc) => {
      if (cfAccountFilter !== "all" && String(acc.id) !== cfAccountFilter) return;
      const group = { accountId: acc.id, alias: acc.alias, zones: [] as Domain[] };
      byId.set(acc.id, group);
      groups.push(group);
    });
    cfZones.forEach((z) => {
      const group = byId.get(z.account_id);
      if (group) group.zones.push(z);
    });
    return groups;
  }, [cfAccountList, cfZones, cfAccountFilter]);

  /** Cloudflare 页搜索：账号名命中则整组保留；否则只保留命中的 zone */
  const filteredCfGroups = useMemo(() => {
    if (!pageSearchKw) return groupedCfZones;
    return groupedCfZones
      .map((g) => {
        if (kwMatch(g.alias)) return g;
        const hit = g.zones.filter((z) => kwMatch(z.full_domain, z.status));
        return hit.length ? { ...g, zones: hit } : null;
      })
      .filter((g): g is { accountId: number; alias: string; zones: Domain[] } => g !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedCfZones, pageSearchKw]);

  // 域名匹配键：Punycode 小写 + 去首尾点（兼容 DNSHE 侧偶发的「.ddns.ge」空前缀形态）
  const normalizeDomainKey = (value: string): string =>
    toASCII(String(value || "").trim().toLowerCase()).replace(/^\.+|\.+$/g, "");

  // 域名匹配候选键
  //
  // NOTE: Cloudflare 建区时按 UTS-46 直接删除「可忽略字符」（零宽空格 U+200B 等），
  // 因此带零宽前缀的域名在 CF 侧的 zone 名可能是剥除后的形态
  // （「\u200B.ddns.ge」→「ddns.ge」而非「xn--zug.ddns.ge」）。
  // 这里生成 原始归一化 / 剥除归一化 两个候选键，任一命中即视为同一域名；
  // 两种形态一致（普通域名）时只返回一个，避免无谓的比对。
  const domainKeyCandidates = (value: string): string[] => {
    const raw = String(value || "");
    const normalized = normalizeDomainKey(raw);
    const stripped = normalizeDomainKey(raw.replace(/[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g, ""));
    return stripped === normalized ? [normalized] : [normalized, stripped];
  };

  // 已同步 zone 的完整域名集合，供 DNSHE 域名页做「已在 Cloudflare 管理」交叉提示
  const cfZoneFullDomainSet = useMemo(
    () => new Set(cfZones.flatMap((z) => domainKeyCandidates(String(z.full_domain || "")))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfZones]
  );

  // DNSHE 注册域名集合，供 CF zone 卡片显示「DNSHE 注册」标识
  const dnsheFullDomainSet = useMemo(
    () => new Set(domains.flatMap((d) => domainKeyCandidates(String(d.full_domain || "")))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [domains]
  );

  // 批量查询非 DNSHE 注册的 zone 到期时间（RDAP；后端 D1 缓存 7 天）
  const fetchCfExpiry = async (zoneList: Domain[]) => {
    const targets = Array.from(
      new Set(
        zoneList
          .filter((z) => !dnsheFullDomainSet.has(normalizeDomainKey(String(z.full_domain || ""))))
          .map((z) => normalizeDomainKey(String(z.full_domain || "")))
          .filter(Boolean)
      )
    ).filter((k) => !(k in cfExpiryMap));
    if (targets.length === 0) return;
    try {
      const res = await apiFetch(`/api/expiry?domains=${encodeURIComponent(targets.join(","))}`);
      const data = await res.json();
      if (data.success && data.expiry) {
        setCfExpiryMap((prev) => ({ ...prev, ...(data.expiry as Record<string, { found: boolean; expires_at?: string }>) }));
      }
    } catch {
      // 到期查询失败不打扰用户，卡片显示 —
    }
  };

  // 进入 Cloudflare 页或 zones 更新时拉取到期时间（已缓存的域名后端直接命中，秒回）
  useEffect(() => {
    if (activeTab !== "cloudflare" || cfZones.length === 0) return;
    void fetchCfExpiry(cfZones);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, cfZones]);

  const cfToggleAccountCollapse = (accountId: number) => {
    const next = new Set(cfCollapsedAccounts);
    if (next.has(accountId)) next.delete(accountId);
    else next.add(accountId);
    persistCfCollapsed(next);
  };

  // 展开/收起全部账号分组（与域名列表页的 toggleAllAccounts 同构：
  // 存在收起的分组 → 全部展开；否则全部收起）
  const cfToggleAllAccounts = () => {
    if (cfCollapsedAccounts.size > 0) {
      persistCfCollapsed(new Set());
    } else {
      persistCfCollapsed(new Set(groupedCfZones.map((g) => g.accountId)));
    }
  };

  // 交叉提示跳转：切到 Cloudflare 标签页并定位到同名 zone 的卡片
  const gotoCfZone = (fullDomain: string) => {
    const keys = domainKeyCandidates(String(fullDomain || ""));
    const zone = cfZones.find((z) =>
      domainKeyCandidates(String(z.full_domain || "")).some((k) => keys.includes(k))
    );
    setActiveTab("cloudflare");
    if (!zone) return;
    // 展开该 zone 所在的账号分组，否则卡片不可见、无从滚动定位
    if (cfCollapsedAccounts.has(zone.account_id)) {
      const next = new Set(cfCollapsedAccounts);
      next.delete(zone.account_id);
      persistCfCollapsed(next);
    }
    setCfHighlightZoneId(zone.id);
  };

  // 定位高亮：等标签页与分组展开渲染完成后平滑滚动到目标卡片，停留数秒自动清除
  useEffect(() => {
    if (cfHighlightZoneId === null || activeTab !== "cloudflare") return;
    const scrollTimer = window.setTimeout(() => {
      document.getElementById(`cf-zone-card-${cfHighlightZoneId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }, 150);
    const clearTimer = window.setTimeout(() => setCfHighlightZoneId(null), 4000);
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [cfHighlightZoneId, activeTab]);

  // 绑定 Cloudflare 账号（后端会先调 /user/tokens/verify 校验 Token）
  const handleCfAddAccount = async () => {
    if (!cfNewToken.trim()) {
      showToast("error", "请填写 Cloudflare API Token");
      return;
    }
    setActionLoading("cf-add-account");
    try {
      const res = await apiFetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "cloudflare", alias: cfNewAlias.trim(), api_token: cfNewToken.trim() })
      });
      const data = await res.json();
      if (data.success) {
        setBindModalOpen(false);
        setCfNewAlias("");
        setCfNewToken("");
        await fetchAccounts();
        // 后台同步 zones 落库后再刷新（fetchCfZones 在等待函数末尾统一调用）
        if (data.account?.id) {
          await waitForAccountDomainSync([data.account.id], "Cloudflare 账号绑定成功", undefined, () => "cloudflare");
        } else {
          await fetchCfZones();
        }
      } else {
        showToast("error", data.message || "绑定 Cloudflare 账号失败");
      }
    } catch (e) {
      showToast("error", "绑定 Cloudflare 账号请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 批量绑定 Cloudflare 账号：每行一条「api_token [别名]」，分隔符支持空格/Tab/逗号/竖线
  const handleCfBatchAddAccounts = async () => {
    const lines = splitBatchLines(cfBatchBindInput);
    if (lines.length === 0) {
      showToast("error", "请至少输入一条 Cloudflare API Token");
      return;
    }

    const parsed: Array<{ api_token: string; alias: string }> = [];
    let invalidLines = 0;
    for (const line of lines) {
      const parts = line.split(/[\s,，|]+/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 1) {
        parsed.push({ api_token: parts[0], alias: parts.length >= 2 ? parts.slice(1).join(" ") : "" });
      } else {
        invalidLines++;
      }
    }
    if (invalidLines > 0) {
      showToast("warning", `${invalidLines} 行格式不正确（每行需包含 API Token），已自动跳过`);
    }
    if (parsed.length === 0) {
      showToast("error", "未能解析出任何有效的账号信息，请检查输入格式");
      return;
    }
    if (parsed.length > 50) {
      showToast("error", "单次最多批量绑定 50 个账号");
      return;
    }

    setActionLoading("cf-batch-add-accounts");
    setCfBatchBindResults(null);
    try {
      const res = await apiFetch("/api/accounts/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "cloudflare", accounts: parsed })
      });
      const data = await res.json();
      if (data.success) {
        setCfBatchBindResults(data.results || []);
        showToast(data.fail_count === 0 ? "success" : "warning", data.message || "批量绑定完成");
        setCfBatchBindInput("");
        await fetchAccounts();
        const ids: number[] = (data.account_ids || []).map(Number);
        if (ids.length > 0) {
          // 后台逐个同步 zones，落库后自动刷新（fetchCfZones 在等待函数末尾统一调用）
          waitForAccountDomainSync(ids, `${ids.length} 个 Cloudflare 账号绑定成功`, undefined, () => "cloudflare");
        } else {
          await fetchCfZones();
        }
      } else {
        showToast("error", data.message || "批量绑定失败");
      }
    } catch (err) {
      showToast("error", "批量绑定请求发送失败，请检查网络");
    } finally {
      setActionLoading(null);
    }
  };

  // 修改 Cloudflare 账号（改别名 / 换 Token）
  const handleCfUpdateAccount = async () => {
    if (!cfEditingAccount) return;
    setActionLoading(`cf-update-account-${cfEditingAccount.id}`);
    try {
      const body: Record<string, string> = { alias: cfEditAlias.trim() };
      if (cfEditToken.trim()) body.api_token = cfEditToken.trim();
      const res = await apiFetch(`/api/accounts/${cfEditingAccount.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success) {
        setCfEditingAccount(null);
        setCfEditAlias("");
        setCfEditToken("");
        await fetchAccounts();
        if (cfEditToken.trim() && data.account?.id) {
          // 换 Token 后重新同步该账号的 zones
          await waitForAccountDomainSync([data.account.id], "Token 已更新", undefined, () => "cloudflare");
        } else {
          await fetchCfZones();
        }
      } else {
        showToast("error", data.message || "更新账号失败");
      }
    } catch (e) {
      showToast("error", "更新账号请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 解绑 Cloudflare 账号（后端级联清理该账号的 zones 缓存）
  const handleCfDeleteAccount = async (acc: Account) => {
    if (!confirm(`确定要解绑 Cloudflare 账号 [${acc.alias}] 吗？\n其名下的 zones 缓存会被一并清理（不影响 Cloudflare 上的实际数据）。`)) {
      return;
    }
    setActionLoading(`cf-delete-account-${acc.id}`);
    try {
      const res = await apiFetch(`/api/accounts/${acc.id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showToast("success", "账号已解绑");
        await fetchAccounts();
        await fetchCfZones();
      } else {
        showToast("error", data.message || "解绑失败");
      }
    } catch (e) {
      showToast("error", "解绑请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 手动触发全量同步（复用后端 /api/domains/sync，它会同步包括 Cloudflare 在内的所有账号）
  const handleCfSyncZones = async () => {
    setActionLoading("cf-sync");
    try {
      const res = await apiFetch("/api/domains/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (!data.success) {
        showToast("error", data.message || "同步任务启动失败");
        return;
      }

      showToast("info", "同步任务已启动，zones 落库后自动刷新…");

      // 以当前各账号的 zones 指纹为基线，落库后自动刷新（与 DNSHE 域名页的等待逻辑同构）
      const accStats = new Map<number, { count: number; newest: string }>();
      cfZones.forEach((z) => {
        const cur = accStats.get(z.account_id) || { count: 0, newest: "" };
        cur.count += 1;
        const updated = String((z as unknown as { updated_at?: string }).updated_at || "");
        if (updated > cur.newest) cur.newest = updated;
        accStats.set(z.account_id, cur);
      });
      const baseline = new Map<number, string>();
      accStats.forEach((v, k) => baseline.set(k, `${v.count}:${v.newest}`));
      const accountIds = (cfAccountList.length > 0
        ? cfAccountList.map((a) => a.id)
        : Array.from(baseline.keys()));
      const deadline = Date.now() + 10_000 + accountIds.length * 5_000;
      const pending = new Set(accountIds);

      while (pending.size > 0 && Date.now() < deadline) {
        await sleep(1500);
        for (const id of [...pending]) {
          const fingerprint = await readAccountDomainFingerprint(id, "cloudflare");
          if (fingerprint !== null && fingerprint !== (baseline.get(id) ?? "0:")) {
            pending.delete(id);
          }
        }
      }

      await fetchCfZones();
      showToast("success", pending.size === 0 ? "zones 同步完成" : "同步仍在后台进行，稍后可再次点击刷新");
    } catch (e) {
      showToast("error", "同步请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 打开 CF 解析记录面板并加载记录
  const reloadCfRecords = async (zone: Domain, forceRefresh = false) => {
    const seq = ++cfLoadSeqRef.current;
    setLoadingCfRecords(true);
    try {
      const res = await apiFetch(`/api/domains/${zone.id}/dns${forceRefresh ? "?refresh=1" : ""}`);
      const data = await res.json();
      // 已被更晚的一次加载取代 → 丢弃，避免上一个 zone 的记录覆盖当前面板
      if (seq !== cfLoadSeqRef.current) return;
      if (data.success) {
        setCfRecords(data.records || []);
        setCfRecordsError(null);
      } else {
        setCfRecordsError(data.message || "获取解析记录失败");
        showToast("error", data.message || "获取解析记录失败");
      }
    } catch (e) {
      if (seq !== cfLoadSeqRef.current) return;
      setCfRecordsError("网络连接异常，无法获取解析记录");
      showToast("error", "网络连接异常，无法获取解析记录");
    } finally {
      if (seq === cfLoadSeqRef.current) setLoadingCfRecords(false);
    }
  };

  const handleCfOpenDnsModal = (zone: Domain) => {
    setCfSelectedZone(zone);
    setCfDnsModalOpen(true);
    setCfRecords([]);
    setCfRecordsError(null);
    setCfSelectedKeys(new Set());
    setCfEditingKey(null);
    setCfFormOpen(false);
    setCfBatchOpen(false);
    setCfEditPanelOpen(false);
    setCfBatchResults(null);
    setCfEditResults(null);
    setCfNewType("A");
    setCfNewName("");
    setCfNewContent("");
    setCfNewTtl(1);
    setCfNewPriority(10);
    setCfNewProxied(false);
    void reloadCfRecords(zone);
  };

  // 新建 CF 解析记录
  const handleCfCreateRecord = async () => {
    if (!cfSelectedZone) return;
    if (!cfNewContent.trim()) {
      showToast("error", "记录值不能为空");
      return;
    }
    setActionLoading("cf-create-dns");
    try {
      const res = await apiFetch(`/api/domains/${cfSelectedZone.id}/dns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: cfNewType,
          name: cfNewName.trim() || "@",
          content: cfNewContent.trim(),
          // 开启代理时 Cloudflare 只接受自动 TTL
          ttl: cfNewProxied ? 1 : cfNewTtl,
          priority: needsDnsPriority(cfNewType) ? cfNewPriority : undefined,
          proxied: cfNewProxied
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", "创建解析记录成功");
        setCfNewName("");
        setCfNewContent("");
        setCfNewProxied(false);
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "创建解析记录失败");
      }
    } catch (e) {
      showToast("error", "创建解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 行内修改：进入编辑态
  const handleCfStartEditRecord = (rec: DnsRecord) => {
    setCfEditingKey(dnsRecordKey(rec));
    setCfEditType(rec.type);
    setCfEditName(toRelativeRecordName(rec.name, cfSelectedZone?.full_domain || ""));
    setCfEditContent(rec.content);
    setCfEditTtl(rec.ttl > 0 ? rec.ttl : 1);
    setCfEditPriority(rec.priority !== null && rec.priority !== undefined ? rec.priority : 10);
    setCfEditProxied(Boolean(rec.proxied));
  };

  // 行内修改：保存
  const handleCfUpdateRecord = async () => {
    if (!cfSelectedZone || !cfEditingKey) return;
    const target = cfRecords.find((r) => dnsRecordKey(r) === cfEditingKey);
    if (!target) return;
    if (!cfEditContent.trim()) {
      showToast("error", "记录值不能为空");
      return;
    }
    setActionLoading(`cf-update-dns-${cfEditingKey}`);
    try {
      const res = await apiFetch(`/api/domains/${cfSelectedZone.id}/dns/${encodeURIComponent(cfEditingKey)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: cfEditType,
          name: cfEditName.trim() || "@",
          content: cfEditContent.trim(),
          ttl: cfEditProxied ? 1 : cfEditTtl,
          priority: needsDnsPriority(cfEditType) ? cfEditPriority : undefined,
          proxied: cfEditProxied
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", "解析记录已更新");
        setCfEditingKey(null);
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "更新解析记录失败");
      }
    } catch (e) {
      showToast("error", "更新解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 删除单条 CF 解析记录
  const handleCfDeleteRecord = async (rec: DnsRecord) => {
    if (!cfSelectedZone) return;
    if (!confirm(`确定要删除记录 ${rec.type} ${rec.name} → ${rec.content} 吗？这会立即影响该域名的解析！`)) {
      return;
    }
    const key = dnsRecordKey(rec);
    setActionLoading(`cf-delete-dns-${key}`);
    try {
      const res = await apiFetch(`/api/domains/${cfSelectedZone.id}/dns/${encodeURIComponent(key)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showToast("success", "解析记录已删除");
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "删除解析记录失败");
      }
    } catch (e) {
      showToast("error", "删除解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // CF 批量添加输入框的实时解析（主机记录提前转相对名，预览与提交一致）
  // NOTE: 行首类型令牌按 Cloudflare 全量类型识别，否则 PTR 这类行首会被误认成主机记录
  const cfParsedBatchLines = useMemo(
    () =>
      parseDnsBatchInput(cfBatchInput, {
        type: cfBatchType,
        name: cfBatchName,
        ttl: cfBatchProxied ? 1 : cfBatchTtl,
        priority: cfBatchPriority
      }, CF_DNS_TYPE_SET).map((r) =>
        r ? { ...r, name: toRelativeRecordName(r.name, cfSelectedZone?.full_domain || "") } : null
      ),
    [cfBatchInput, cfBatchType, cfBatchName, cfBatchTtl, cfBatchPriority, cfBatchProxied, cfSelectedZone]
  );

  const cfValidBatchLines = useMemo(
    () => cfParsedBatchLines.filter((r): r is ParsedDnsLine => r !== null),
    [cfParsedBatchLines]
  );

  // CF 批量添加（面板上的「代理」开关只对 A/AAAA/CNAME 行生效）
  const handleCfBatchCreate = async () => {
    if (!cfSelectedZone) return;
    if (cfValidBatchLines.length === 0) {
      showToast("error", "未能解析出任何有效的解析记录，请检查输入格式");
      return;
    }
    if (cfValidBatchLines.length > 50) {
      showToast("error", "单次最多批量添加 50 条解析记录");
      return;
    }

    const records = cfValidBatchLines.map((r) => ({
      ...r,
      ttl: cfBatchProxied ? 1 : r.ttl,
      proxied: cfBatchProxied && ["A", "AAAA", "CNAME"].includes(r.type) ? true : undefined
    }));

    setActionLoading("cf-batch-create-dns");
    setCfBatchResults(null);
    try {
      const res = await apiFetch(`/api/domains/${cfSelectedZone.id}/dns/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records })
      });
      const data = await res.json();
      if (data.success) {
        setCfBatchResults(data.results || []);
        if (data.fail_count === 0) {
          showToast("success", `已添加 ${data.success_count} 条解析记录`);
          setCfBatchInput("");
        } else {
          showToast("warning", `批量添加完成：成功 ${data.success_count} 条，失败 ${data.fail_count} 条（详见下方明细）`);
        }
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "批量添加解析记录失败");
      }
    } catch (e) {
      showToast("error", "批量添加解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // CF 勾选的记录（批量修改 / 批量删除共用）
  const cfSelectedRecords = useMemo(
    () => cfRecords.filter((rec) => cfSelectedKeys.has(dnsRecordKey(rec))),
    [cfRecords, cfSelectedKeys]
  );

  const cfToggleAllSelection = () => {
    if (cfSelectedKeys.size === cfRecords.length) {
      setCfSelectedKeys(new Set());
    } else {
      setCfSelectedKeys(new Set(cfRecords.map(dnsRecordKey)));
    }
  };

  // CF 批量修改目标（复用 buildDnsEditTargets：内容 / TTL / 代理 三个字段可覆盖）
  const cfBatchEditTargets = useMemo(
    () =>
      buildDnsEditTargets(
        cfSelectedRecords,
        {
          type: false,
          name: false,
          content: cfEditFields.content,
          ttl: cfEditFields.ttl,
          line: false,
          priority: false,
          proxied: cfEditFields.proxied
        },
        {
          type: "A",
          name: "@",
          content: "",
          ttl: cfBatchEditTtl,
          line: "",
          priority: 10,
          proxied: cfBatchEditProxied
        },
        cfSelectedZone?.full_domain || "",
        cfBatchEditContents
      ),
    [cfSelectedRecords, cfSelectedZone, cfEditFields, cfBatchEditTtl, cfBatchEditProxied, cfBatchEditContents]
  );

  const cfBatchEditChanged = useMemo(
    () => cfBatchEditTargets.filter((t) => !t.unchanged),
    [cfBatchEditTargets]
  );

  const handleCfOpenEditPanel = () => {
    setCfBatchEditContents(
      Object.fromEntries(cfSelectedRecords.map((rec) => [dnsRecordKey(rec), rec.content || ""]))
    );
    setCfEditResults(null);
    setCfEditPanelOpen(true);
  };

  // CF 批量修改已勾选的解析记录
  const handleCfBatchUpdateRecords = async () => {
    if (!cfSelectedZone || cfBatchEditTargets.length === 0) return;
    if (!cfEditFields.content && !cfEditFields.ttl && !cfEditFields.proxied) {
      showToast("error", "请至少勾选一个要修改的字段");
      return;
    }
    if (cfBatchEditChanged.length === 0) {
      showToast("info", "选中的记录与当前值一致，没有需要提交的修改");
      return;
    }
    if (cfBatchEditChanged.length > 50) {
      showToast("error", "单次最多批量修改 50 条解析记录");
      return;
    }

    if (!confirm(`确定要修改选中的 ${cfBatchEditChanged.length} 条解析记录吗？`)) {
      return;
    }

    const records = cfBatchEditChanged.map((t) => ({
      record_id: t.record_id,
      label: t.label,
      type: t.type,
      name: t.name,
      content: t.content,
      ttl: cfEditFields.proxied && cfBatchEditProxied ? 1 : t.ttl,
      proxied: cfEditFields.proxied ? cfBatchEditProxied : undefined
    }));

    setActionLoading("cf-batch-update-dns");
    try {
      const res = await apiFetch(`/api/domains/${cfSelectedZone.id}/dns/batch-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records })
      });
      const data = await res.json();
      if (data.success) {
        setCfEditResults(data.results || []);
        const failed = (data.results || []).filter((r: { success: boolean }) => !r.success);
        if (failed.length === 0) {
          showToast("success", `已修改 ${data.success_count} 条解析记录`);
        } else {
          showToast("warning", `批量修改完成：成功 ${data.success_count} 条，失败 ${data.fail_count} 条（详见下方明细）`);
        }
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "批量修改解析记录失败");
      }
    } catch (e) {
      showToast("error", "批量修改解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // CF 批量删除已勾选的解析记录
  const handleCfBatchDeleteRecords = async () => {
    if (!cfSelectedZone || cfSelectedKeys.size === 0) return;

    const targets = cfSelectedRecords.map((rec) => ({
      record_id: dnsRecordKey(rec),
      label: `${rec.type} ${rec.name} → ${rec.content}`
    }));

    if (
      !confirm(
        `确定要删除选中的 ${targets.length} 条解析记录吗？这会立即影响该域名的解析！\n\n${targets
          .map((t) => t.label)
          .join("\n")}`
      )
    ) {
      return;
    }

    setActionLoading("cf-batch-delete-dns");
    try {
      const res = await apiFetch(`/api/domains/${cfSelectedZone.id}/dns/batch-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: targets })
      });
      const data = await res.json();
      if (data.success) {
        const failed = (data.results || []).filter((r: { success: boolean }) => !r.success);
        if (failed.length === 0) {
          showToast("success", `已删除 ${data.success_count} 条解析记录`);
        } else {
          showToast(
            "error",
            `${failed.length} 条删除失败：${failed
              .map((f: { label: string; message: string }) => `${f.label}(${f.message})`)
              .join("；")}`
          );
        }
        setCfSelectedKeys(new Set());
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "批量删除解析记录失败");
      }
    } catch (e) {
      showToast("error", "批量删除解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 渲染单个 Cloudflare zone 卡片
  const renderCfZoneCard = (zone: Domain) => {
    const unicodeDomain = displayDomain(toUnicode(zone.full_domain));
    const isActive = String(zone.status || "").toLowerCase() === "active";
    const isDnsheRegistered = domainKeyCandidates(String(zone.full_domain || "")).some((k) => dnsheFullDomainSet.has(k));
    // 到期时间：DNSHE 注册的取本地缓存的真实到期时间；其余用 RDAP 查询结果（查不到显示 —）
    const dnsheMatch = isDnsheRegistered
      ? domains.find((d) => {
          const keys = domainKeyCandidates(String(d.full_domain || ""));
          return domainKeyCandidates(String(zone.full_domain || "")).some((k) => keys.includes(k));
        })
      : undefined;
    const rdapInfo = cfExpiryMap[normalizeDomainKey(String(zone.full_domain || ""))];
    const expiryText = dnsheMatch?.expires_at
      ? formatDate(dnsheMatch.expires_at, true)
      : rdapInfo?.expires_at
        ? formatDate(rdapInfo.expires_at, true)
        : "—";

    return (
      <div
        key={zone.id}
        id={`cf-zone-card-${zone.id}`}
        className={`bg-surface border rounded-2xl p-5 flex flex-col justify-between transition-all duration-300 shadow-xl ${
          zone.id === cfHighlightZoneId
            ? "border-sky-400 ring-2 ring-sky-400/50"
            : "border-border-base"
        }`}
      >
        {/* 顶部：域名名称与状态 */}
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => copyToClipboard(zone.full_domain, zone.full_domain)}
            className="font-mono text-sm sm:text-base font-bold text-content-primary tracking-wide truncate min-w-0 hover:text-indigo-400 transition-colors cursor-pointer text-left"
            title={`点击复制：${zone.full_domain}`}
          >
            {unicodeDomain}
          </button>
          {isActive ? (
            <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold whitespace-nowrap bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/80 dark:text-emerald-400 dark:border-emerald-900/60 flex-shrink-0">
              已激活
            </span>
          ) : (
            <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold whitespace-nowrap bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/80 dark:text-amber-300 dark:border-amber-900/60 flex-shrink-0">
              待激活
            </span>
          )}
        </div>

        {/* 中间：元信息（到期时间 = DNSHE 本地缓存或 RDAP 查询的注册商侧数据） */}
        <div className="mt-4 space-y-2 text-xs">
          <div className="flex justify-between items-center">
            <span className="text-content-muted font-medium">创建时间</span>
            <span className="font-mono text-content-secondary">{formatDate(zone.created_at, false)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-content-muted font-medium">到期时间</span>
            <span
              className="font-mono text-content-secondary"
              title="注册商侧到期时间（RDAP 查询，7 天缓存）；DNSHE 注册的域名取本地缓存"
            >
              {expiryText}
            </span>
          </div>
          {isDnsheRegistered && (
            <div className="flex justify-between items-center">
              <span className="text-content-muted font-medium">注册来源</span>
              <span className="bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-950/80 dark:text-indigo-300 dark:border-indigo-900/60 text-xs font-medium px-2.5 py-0.5 rounded-md">
                DNSHE 注册
              </span>
            </div>
          )}
        </div>

        <div className="border-t border-border-base my-3.5" />

        {/* 底部：DNS 管理按钮与 Cloudflare 控制台外链 */}
        <div className="flex items-center justify-end gap-2">
          <a
            href={zone.provider_account_id
              ? `https://dash.cloudflare.com/${zone.provider_account_id}/${zone.full_domain}/dns/records`
              : "https://dash.cloudflare.com/"}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-semibold px-3 py-2 rounded-lg flex items-center gap-1.5 bg-elevated hover:bg-hovered text-content-secondary transition-all"
            title={zone.provider_account_id
              ? "在 Cloudflare 控制台打开该 zone 的 DNS 记录页"
              : "点击「同步 zones」后可直达该 zone 的 DNS 记录页（当前缺账号信息，先打开控制台首页）"}
          >
            控制台 <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={() => handleCfOpenDnsModal(zone)}
            className="text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 bg-elevated hover:bg-hovered text-content-secondary cursor-pointer transition-all shadow-inner"
          >
            <Settings className="w-3.5 h-3.5 text-content-muted" /> DNS
          </button>
        </div>
      </div>
    );
  };

  // 批量添加输入框的实时解析结果，供按钮显示「已识别 N 条」并复用于提交
  // NOTE: 主机记录在这里就转成相对名，让预览显示的与真正写进去的完全一致
  const parsedDnsBatchLines = useMemo(
    () =>
      parseDnsBatchInput(dnsBatchInput, {
        type: dnsBatchType,
        name: dnsBatchName,
        ttl: dnsBatchTtl,
        priority: dnsBatchPriority
      }).map((r) =>
        r ? { ...r, name: toRelativeRecordName(r.name, selectedDomain?.full_domain || "") } : null
      ),
    [dnsBatchInput, dnsBatchType, dnsBatchName, dnsBatchTtl, dnsBatchPriority, selectedDomain]
  );

  const validDnsBatchLines = useMemo(
    () => parsedDnsBatchLines.filter((r): r is ParsedDnsLine => r !== null),
    [parsedDnsBatchLines]
  );

  // 批量添加解析记录
  const handleBatchCreateDnsRecords = async () => {
    if (!selectedDomain) return;

    if (validDnsBatchLines.length === 0) {
      showToast("error", "未能解析出任何有效的解析记录，请检查输入格式");
      return;
    }
    if (validDnsBatchLines.length > 50) {
      showToast("error", "单次最多批量添加 50 条解析记录");
      return;
    }

    const records = validDnsBatchLines.map((r) => ({
      ...r,
      line: dnsBatchLine.trim() || undefined
    }));

    setActionLoading("batch-create-dns");
    setDnsBatchResults(null);
    try {
      const res = await apiFetch(`/api/domains/${selectedDomain.id}/dns/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records })
      });
      const data = await res.json();
      if (data.success) {
        setDnsBatchResults(data.results || []);
        if (data.fail_count === 0) {
          showToast("success", `已添加 ${data.success_count} 条解析记录`);
          setDnsBatchInput("");
        } else {
          showToast(
            "warning",
            data.error_code === "ns_management_disabled"
              ? "DNSHE 上游平台已禁用 NS 管理，NS 记录无法通过 API 添加。请前往 DNSHE 官网后台手动设置。"
              : `批量添加完成：成功 ${data.success_count} 条，失败 ${data.fail_count} 条（详见下方明细）`
          );
        }
        reloadDnsRecords(selectedDomain);
        fetchDomains();
      } else {
        showToast("error", data.message || "批量添加解析记录失败");
      }
    } catch (e) {
      showToast("error", "批量添加解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 清除运行日志
  const handleClearLogs = async () => {
    if (!confirm("确定要清空所有的运行日志吗？")) return;
    setActionLoading("clear-logs");
    try {
      const res = await apiFetch("/api/logs/clear", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        showToast("success", "系统日志已成功清空");
        fetchLogs();
      } else {
        showToast("error", data.message || "清空日志失败");
      }
    } catch (e) {
      showToast("error", "清空日志网络请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 执行 WHOIS 域名查重
  const handleCheckWhois = async (
    e?: React.FormEvent,
    overrideSub?: string,
    overrideRoot?: string
  ) => {
    if (e) e.preventDefault();
    // 中文等非 ASCII 前缀/根域名统一转 Punycode (xn--) 再查询
    const sub = toASCII((overrideSub !== undefined ? overrideSub : searchSubdomain).trim());
    const root = toASCII((overrideRoot !== undefined ? overrideRoot : searchRootdomain).trim());

    if (!sub) {
      showToast("error", "请输入想要查询的子域名前缀！");
      return;
    }

    // 官方保留前缀：直接拦截，不浪费一次上游查询
    if (enableReservedFilter && reservedPrefixes.some(p => p.toLowerCase() === sub.toLowerCase())) {
      showToast("error", `前缀 [${sub}] 属于官方保留名单，不可注册（可在批量页的保留名单中调整）`);
      return;
    }

    const fullTargetDomain = `${sub}.${root}`;
    setWhoisLoading(true);

    try {
      const res = await apiFetch(`/api/whois?domain=${encodeURIComponent(fullTargetDomain)}`);
      const data = await res.json();
        if (data.success && data.whois) {
          setWhoisResult({
            searchedDomain: fullTargetDomain,
            ...data.whois
          });
          if (dnsheAccounts.length > 0 && !registerAccountId) {
            setRegisterAccountId(dnsheAccounts[0].id);
          }
        } else {
        showToast("error", data.message || "WHOIS 查询失败");
      }
    } catch (err) {
      showToast("error", "WHOIS 查询请求失败，请检查网络连接");
    } finally {
      setWhoisLoading(false);
    }
  };

  // 提交在线注册免费域名
  const handleRegisterSubdomain = async () => {
    const sub = toASCII(searchSubdomain.trim());
    const root = toASCII(searchRootdomain.trim());
    if (!sub || !root) return;
    if (!registerAccountId) {
      showToast("error", "请先选择用于注册域名的 API 账号！");
      return;
    }

    setActionLoading("register-subdomain");
    try {
      const res = await apiFetch("/api/domains/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: registerAccountId,
          subdomain: sub,
          rootdomain: root
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", `🎉 域名 [${data.full_domain || sub + "." + root}] 注册成功！`);
        setWhoisResult(null);
        setSearchSubdomain("");
        fetchDomains();
        setActiveTab("domains");
      } else {
        showToast("error", data.message || "注册子域名失败，请重试");
      }
    } catch (err) {
      showToast("error", "注册请求失败，请重试");
    } finally {
      setActionLoading(null);
    }
  };

  // 添加与删除自定义根域名 handler
  const handleAddCustomRootDomain = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanRoot = toASCII(newRootInput.trim().replace(/^\./, ""));
    if (!cleanRoot) return;
    if (allRootDomains.includes(cleanRoot)) {
      showToast("error", `根域名 [.${cleanRoot}] 已在列表中！`);
      return;
    }
    const updated = [...allRootDomains, cleanRoot];
    setAllRootDomains(updated);
    setSelectedRoots(prev => Array.from(new Set([...prev, cleanRoot])));
    localStorage.setItem("DNSHE_CUSTOM_ROOT_DOMAINS", JSON.stringify(updated));
    setNewRootInput("");
    showToast("success", `成功追加根域名 [.${cleanRoot}]！`);
  };

  const handleRemoveCustomRootDomain = (rootToRemove: string) => {
    const updated = allRootDomains.filter(r => r !== rootToRemove);
    setAllRootDomains(updated);
    setSelectedRoots(prev => prev.filter(r => r !== rootToRemove));
    localStorage.setItem("DNSHE_CUSTOM_ROOT_DOMAINS", JSON.stringify(updated));
    showToast("info", `已移除根域名 [.${rootToRemove}]`);
  };

  // 批量规则生成：解析与组合逻辑见 rulegen.ts（花括号槽位模型）
  //
  // 生成上限对齐 west.cn 在线版的 30 万条。注意这只是「生成」上限，
  // 实际扫描速度受单账号 1.2s 限频约束（见 handleStartBatchScan 的 RATE_LIMIT_MS）。
  const MAX_PREFIXES = 300000;

  // 让用户自建词库也能作为 {词库名} 标签参与组合 —— 比 west.cn 固定的「我的字典1-6」更灵活
  const resolveBank = useMemo(
    () => (name: string): string[] | null => {
      const bank = wordBanks.find(b => b.name === name);
      return bank ? bank.words : null;
    },
    [wordBanks]
  );

  // 规则实时解析：组合数预估 + 耗时估算
  const rulePreview = useMemo(() => {
    const parsed = parseRule(batchRules, excludeChars, batchLength, resolveBank);
    const total = countCombos(parsed);
    const rootCount = Math.max(selectedRoots.length, 1);
    const workerCount = Math.max(dnsheAccounts.length, 1);
    // 每个候选前缀要对每个根域名各查一次，单账号 1.2s 限频，N 个账号 N 条流水线
    const scanned = Math.min(total, MAX_PREFIXES) * rootCount;
    // 规则本身有效但被排除字符清空 —— 与「还没输入规则」是两回事，提示语要能区分
    const emptiedByExclude =
      total === 0 &&
      parsed.unknownTokens.length === 0 &&
      (parsed.slots.length > 0 || parsed.literalList !== null) &&
      excludeChars.trim().length > 0;
    return {
      parsed,
      total,
      emptiedByExclude,
      isBraceSyntax: batchRules.includes("{"),
      estSeconds: (scanned * 1.2) / workerCount
    };
  }, [batchRules, excludeChars, batchLength, resolveBank, selectedRoots.length, dnsheAccounts.length]);

  // 把秒数格式化为「3.2 小时 / 12 分钟 / 45 秒」
  const formatDuration = (sec: number): string => {
    if (sec < 60) return `${Math.ceil(sec)} 秒`;
    if (sec < 3600) return `${(sec / 60).toFixed(1)} 分钟`;
    if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小时`;
    return `${(sec / 86400).toFixed(1)} 天`;
  };

  // ===== 顺序检测：进位递增生成器 =====
  // 取顺序模式对应的字符集
  const getSeqCharset = (name: string): string[] => {
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    const digits = "0123456789".split("");
    if (name === "数字") return digits;
    if (name === "字母数字") return [...letters, ...digits];
    return letters;
  };

  // 进位递增：给定当前串返回下一个串（qwe→qwf，qwz→qxa）；已到最大串则返回 null
  const nextSeqCandidate = (current: string, charset: string[]): string | null => {
    const idxMap = new Map(charset.map((c, i) => [c, i]));
    const chars = current.split("");
    let pos = chars.length - 1;
    while (pos >= 0) {
      const cur = idxMap.get(chars[pos]);
      if (cur === undefined) return null; // 出现字符集外的字符
      if (cur < charset.length - 1) {
        chars[pos] = charset[cur + 1];
        return chars.join("");
      }
      chars[pos] = charset[0]; // 进位：本位归零，继续向前进位
      pos--;
    }
    return null; // 全部进位完毕，空间穷尽
  };

  // 惰性生成顺序候选：从 start 开始最多取 limit 个（避免 26^4 一次性撑爆内存）
  const generateSeqPrefixes = (
    charsetName: string,
    length: number,
    start: string,
    limit: number
  ): string[] => {
    const charset = getSeqCharset(charsetName);
    const min = charset[0].repeat(length);
    let cur = start && start.length === length ? start.toLowerCase() : min;
    // 起始串含字符集外字符时回退到最小串
    if (cur.split("").some(c => !charset.includes(c))) cur = min;

    const out: string[] = [];
    while (out.length < limit) {
      out.push(cur);
      const nxt = nextSeqCandidate(cur, charset);
      if (nxt === null) break;
      cur = nxt;
    }
    return out;
  };

  // 保存/清除断点光标
  const saveScanCursor = (lastCandidate: string, taskIndex: number, checked: number) => {
    const cursor = {
      seqMode,
      charset: seqCharset,
      length: seqLength,
      lastCandidate,
      taskIndex,
      checked,
      savedAt: new Date().toLocaleString()
    };
    localStorage.setItem("DNSHE_SCAN_CURSOR", JSON.stringify(cursor));
    setScanCursor(cursor);
  };

  const clearScanCursor = () => {
    localStorage.removeItem("DNSHE_SCAN_CURSOR");
    setScanCursor(null);
  };

  // ===== 线路解析支持名单 =====
  const persistLineNsSuffixes = (next: string[]) => {
    const cleaned = Array.from(
      new Set(
        next
          .map((v) => String(v).trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
          .filter(Boolean)
      )
    );
    setLineNsSuffixes(cleaned);
    localStorage.setItem("DNSHE_LINE_NS_SUFFIXES", JSON.stringify(cleaned));
  };

  /**
   * NS 主机名是否落在后缀名单内
   *
   * NOTE: 必须按标签边界比对（相等或 `.` + 后缀结尾），裸 endsWith 会让
   * evilalidns.com 这种域名混进名单。
   */
  const nsHostMatchesSuffix = (host: string): boolean => {
    const h = host.trim().toLowerCase().replace(/\.$/, "");
    if (!h) return false;
    return lineNsSuffixes.some((sfx) => h === sfx || h.endsWith(`.${sfx}`));
  };

  /**
   * 该域名是否支持按线路（运营商/地域）解析
   *
   * 三级优先级：实测已确认的根域 > 根域 NS 命中后缀名单 > provider_account_id 兜底。
   * 兜底只在 NS 未知（首屏未加载完 / 后端 DoH 出站失败）时生效，见 DEFAULT_LINE_PROVIDERS。
   */
  const domainSupportsLine = (dom: Domain | null | undefined): boolean => {
    const root = String(dom?.rootdomain ?? "").trim().toLowerCase();
    if (root && learnedLineRoots.includes(root)) return true;

    const ns = root ? rootNs[root] : undefined;
    if (ns && ns.length > 0) return ns.some(nsHostMatchesSuffix);

    const pid = dom?.provider_account_id;
    if (pid === undefined || pid === null || String(pid).trim() === "") return false;
    return DEFAULT_LINE_PROVIDERS.includes(String(pid).trim());
  };

  /** 根域 NS 单次查询上限，与后端 /api/dns/ns 的 NS_MAX_ROOTS 保持一致 */
  const NS_LOOKUP_BATCH = 20;

  /**
   * 批量查询根域 NS 并写入本地镜像
   *
   * @param roots 待查根域；非 force 时只查镜像里还没有有效结论的（含上次查失败的 null），
   *              命中缓存的根域不会产生任何请求，查询失败的下次调用会自动重试
   * @param force 强制回源（设置页「重新查询 NS」用），会带上 refresh=1 让后端跳过 D1 缓存
   * @returns 本次真正拿到的结论（键为根域，值为 NS 列表或 null 表示查不到）；
   *          调用方据此判断成败，全 null 说明后端 DoH 出站失败或该域名确实没有 NS
   */
  const fetchRootNs = async (roots: string[], force = false): Promise<Record<string, string[] | null>> => {
    const normalized = Array.from(
      new Set(roots.map((r) => String(r || "").trim().toLowerCase()).filter(Boolean))
    );
    // NOTE: 判据是「有没有有效结论」而不是「键在不在」—— 上次查失败留下的 null 必须能
    //       重试，否则一次网络抖动会把该根域永久钉死在「未知」上（镜像进了 localStorage）。
    const pending = force
      ? normalized
      : normalized.filter((r) => {
          const cur = rootNs[r];
          return !(Array.isArray(cur) && cur.length > 0);
        });
    if (pending.length === 0) return {};

    const merged: Record<string, string[] | null> = {};
    for (let i = 0; i < pending.length; i += NS_LOOKUP_BATCH) {
      const batch = pending.slice(i, i + NS_LOOKUP_BATCH);
      try {
        const res = await apiFetch(
          `/api/dns/ns?roots=${encodeURIComponent(batch.join(","))}${force ? "&refresh=1" : ""}`
        );
        const data = await res.json();
        if (data.success && data.ns && typeof data.ns === "object") {
          Object.assign(merged, data.ns as Record<string, string[] | null>);
        }
      } catch (e) {
        // 查不到就让判定走 provider_account_id 兜底，不打扰用户
      }
    }
    if (Object.keys(merged).length === 0) return {};

    // NOTE: 函数式更新 —— 域名列表刷新与设置页手动重查可能并发，闭包里的 rootNs 会过期
    setRootNs((prev) => {
      const next = { ...prev, ...merged };
      localStorage.setItem("DNSHE_ROOT_NS", JSON.stringify(next));
      return next;
    });
    return merged;
  };

  /**
   * 从解析记录反推「该根域支持线路」并记住
   *
   * NOTE: 只加不减。支持线路的域名如果所有记录都留在默认线路，line 全是空值，
   * 据此判「不支持」会误杀 —— 所以这里是单向补充。这是唯一的实测信号（用户确实在
   * 上面设成了非默认线路且上游收下了），比 NS 推断更硬，因此判定时优先级最高。
   * 数据来自本来就要读的解析记录，零额外上游调用。
   */
  const learnLineRootFrom = (dom: Domain, records: DnsRecord[]) => {
    const root = String(dom.rootdomain ?? "").trim().toLowerCase();
    if (!root || learnedLineRoots.includes(root)) return;
    const usesLine = records.some((r) => {
      const v = String(r.line || "").trim().toLowerCase();
      return v !== "" && v !== "default";
    });
    if (!usesLine) return;

    // NOTE: 走函数式更新而不是 persist([...learnedLineRoots, root]) ——
    // 闭包里的 learnedLineRoots 可能已过期（连续打开两个域名时后一次会覆盖前一次的补充）。
    setLearnedLineRoots((prev) => {
      if (prev.includes(root)) return prev;
      const next = [...prev, root];
      localStorage.setItem("DNSHE_LINE_ROOTS", JSON.stringify(next));
      return next;
    });
    showToast("info", `检测到 ${dom.full_domain} 使用了线路解析，已确认根域 ${root} 支持线路`);
  };

  // 添加 NS 后缀（支持一次粘贴多个）
  const handleAddLineNsSuffix = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const incoming = parseWords(newLineNsInput).map((w) => w.toLowerCase());
    if (incoming.length === 0) return;
    const merged = Array.from(new Set([...lineNsSuffixes, ...incoming]));
    const added = merged.length - lineNsSuffixes.length;
    persistLineNsSuffixes(merged);
    setNewLineNsInput("");
    showToast(added > 0 ? "success" : "info", added > 0 ? `已添加 ${added} 个 NS 后缀` : "输入的后缀都已在名单中");
  };

  const handleRemoveLineNsSuffix = (sfx: string) => {
    persistLineNsSuffixes(lineNsSuffixes.filter((s) => s !== sfx));
  };

  /**
   * 恢复默认 NS 后缀名单
   *
   * §9：这会**整份覆盖**用户手工维护的名单，属于破坏性操作 ⇒ 入口按钮先弹二次确认框，
   * 确认后才执行。§8：收尾必须说清「加了几条 / 删了几条」，不能只说一句「已恢复」——
   * 名单本来就等于默认值时，用户需要知道"确实没变化"而不是"是不是没生效"。
   */
  const handleRestoreLineNsSuffixes = () => {
    const removed = lineNsSuffixes.filter((s) => !DEFAULT_LINE_NS_SUFFIXES.includes(s)).length;
    const added = DEFAULT_LINE_NS_SUFFIXES.filter((s) => !lineNsSuffixes.includes(s)).length;
    persistLineNsSuffixes(DEFAULT_LINE_NS_SUFFIXES);
    setRestoreNsConfirmOpen(false);
    showToast(
      "success",
      removed || added
        ? `已恢复默认 NS 后缀名单（新增 ${added} 个 / 移除 ${removed} 个自定义后缀）`
        : "已恢复默认 NS 后缀名单（当前名单本来就与默认一致）"
    );
  };

  // 清空「实测已确认」的根域（判定优先级最高，误判时需要能撤掉）
  const handleClearLearnedLineRoots = () => {
    setLearnedLineRoots([]);
    localStorage.removeItem("DNSHE_LINE_ROOTS");
    showToast("info", "已清空实测确认的根域");
  };

  // 设置页「重新查询 NS」：所有已知根域强制回源
  const handleRefreshRootNs = async () => {
    setActionLoading("ns-lookup");
    try {
      const result = await fetchRootNs(knownRootDomains, true);
      const total = Object.keys(result).length;
      const resolved = Object.values(result).filter((v) => Array.isArray(v) && v.length > 0).length;
      // 一条都没查到通常是后端 DoH 出站被拦（运行日志里会有一条 warning），
      // 报成功会让用户对着满屏「NS 未知」怀疑面板坏了
      if (total === 0) {
        showToast("error", "NS 查询没有返回任何结果，请检查后端连通性");
      } else if (resolved === 0) {
        showToast("error", `${total} 个根域全部查询失败，判定已回退到服务商 ID（详见运行日志）`);
      } else if (resolved < total) {
        showToast("info", `已查到 ${resolved}/${total} 个根域的 NS，其余保持「未知」`);
      } else {
        showToast("success", `${resolved} 个根域的 NS 已刷新`);
      }
    } finally {
      setActionLoading(null);
    }
  };

  /**
   * 所有已知根域名：已缓存域名用到的 ∪ 注册页的根域列表
   *
   * NOTE: 给设置页对照表和 NS 批量查询共用。取并集是为了让用户在还没同步任何域名时
   * 也能先看到判定结论，同时覆盖 allRootDomains 里手工添加的新根域。
   */
  const knownRootDomains = useMemo(() => {
    const set = new Set<string>();
    for (const d of domains) {
      const root = String(d.rootdomain ?? "").trim().toLowerCase();
      if (root) set.add(root);
    }
    for (const root of allRootDomains) {
      const r = String(root || "").trim().toLowerCase();
      if (r) set.add(r);
    }
    return Array.from(set).sort();
  }, [domains, allRootDomains]);

  // ===== 保留前缀名单增删 =====
  const persistReserved = (next: string[]) => {
    setReservedPrefixes(next);
    localStorage.setItem("DNSHE_RESERVED_PREFIXES", JSON.stringify(next));
  };
  // 添加保留前缀（支持一次粘贴多个，逗号/空格/换行分隔）
  const handleAddReserved = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const incoming = parseWords(newReservedInput).map(w => w.toLowerCase());
    if (incoming.length === 0) return;

    const merged = Array.from(new Set([...reservedPrefixes, ...incoming]));
    const added = merged.length - reservedPrefixes.length;
    persistReserved(merged);
    setNewReservedInput("");
    if (added > 0) {
      showToast("success", `已添加 ${added} 个保留前缀`);
    } else {
      showToast("info", "输入的前缀均已在名单中");
    }
  };

  const handleRemoveReserved = (prefix: string) => {
    persistReserved(reservedPrefixes.filter(p => p !== prefix));
    showToast("info", `已从名单移除 [${prefix}]`);
  };

  const handleResetReserved = () => {
    persistReserved(DEFAULT_RESERVED_PREFIXES);
    showToast("success", "已恢复官方默认保留前缀名单");
  };

  // 切换启用状态并持久化
  const toggleReservedFilter = (enabled: boolean) => {
    setEnableReservedFilter(enabled);
    localStorage.setItem("DNSHE_RESERVED_FILTER_OFF", enabled ? "0" : "1");
  };

  // ===== 词库增删改 =====
  // 统一落盘：状态与 localStorage 同步更新
  const persistBanks = (next: WordBank[]) => {
    setWordBanks(next);
    saveWordBanks(next);
  };

  // 打开新建分组弹窗
  const openCreateBank = () => {
    setEditingBank(null);
    setBankFormName("");
    setBankFormKind("cn");
    setBankFormWords("");
    setBankModalOpen(true);
  };

  // 打开编辑分组弹窗
  const openEditBank = (bank: WordBank) => {
    setEditingBank(bank);
    setBankFormName(bank.name);
    setBankFormKind(bank.kind);
    setBankFormWords(bank.words.join(", "));
    setBankModalOpen(true);
  };

  // 保存（新建或更新）分组
  const handleSaveBank = () => {
    const name = bankFormName.trim();
    if (!name) {
      showToast("error", "请填写词库名称！");
      return;
    }
    // 词库名会作为 {名称} 标签写进规则，含花括号或逗号会破坏规则解析
    if (/[{},]/.test(name)) {
      showToast("error", "词库名称不能包含 { } 或逗号，否则无法作为规则标签使用！");
      return;
    }
    // 与内置标签重名会被内置定义遮蔽，导致点击词库标签却取到内置候选集
    if ((BUILTIN_TOKENS as readonly string[]).includes(name)) {
      showToast("error", `[${name}] 与内置标签同名，请换一个词库名称！`);
      return;
    }
    const words = parseWords(bankFormWords);
    if (words.length === 0) {
      showToast("error", "请至少填写一个词条！");
      return;
    }

    // 同类型下不允许重名（编辑自身除外）
    const dup = wordBanks.some(
      b => b.kind === bankFormKind && b.name === name && b.id !== editingBank?.id
    );
    if (dup) {
      showToast("error", `「${BANK_KIND_META[bankFormKind].label}」下已存在同名词库 [${name}]！`);
      return;
    }

    if (editingBank) {
      persistBanks(
        wordBanks.map(b =>
          b.id === editingBank.id ? { ...b, name, kind: bankFormKind, words } : b
        )
      );
      showToast("success", `词库 [${name}] 已更新（${words.length} 个词）`);
    } else {
      persistBanks([...wordBanks, { id: makeBankId(), kind: bankFormKind, name, words }]);
      showToast("success", `已新建词库 [${name}]（${words.length} 个词）`);
    }
    setBankModalOpen(false);
  };

  // 删除分组
  const handleDeleteBank = (bank: WordBank) => {
    if (!confirm(`确定要删除词库 [${bank.name}] 吗？该分组下 ${bank.words.length} 个词条将一并移除。`)) return;
    persistBanks(wordBanks.filter(b => b.id !== bank.id));
    showToast("info", `已删除词库 [${bank.name}]`);
  };

  // 恢复内置默认词库（覆盖当前全部自定义内容）
  const handleResetBanks = () => {
    if (!confirm("确定要恢复内置默认词库吗？您当前所有的自定义词库分组与修改都将被覆盖！")) return;
    const defaults = buildDefaultBanks();
    persistBanks(defaults);
    showToast("success", `已恢复内置默认词库（${defaults.length} 个分组）`);
  };

  // 把词库作为 {词库名} 标签插入规则框。
  // 早先是把整类词逗号展开进输入框，几百个词会把框挤满、完全看不清规则结构；
  // 改插占位符后词库还能与其它标签组合（如 {地名城市}{数字}）。
  const appendWordbank = (words: string[], label: string) => {
    setBatchRules(prev => `${prev}{${label}}`);
    showToast("success", `已插入「${label}」词库标签（${words.length} 个词）`);
  };

  // 执行批量扫域名引擎（resumeFrom 非空时表示从断点续查）
  const handleStartBatchScan = async (resumeFrom?: string) => {
    if (scanControlRef.current === "paused") {
      updateScanStatus("running");
      showToast("info", "▶️ 已恢复批量扫描任务！");
      return;
    }

    if (selectedRoots.length === 0) {
      showToast("error", "请至少勾选一个根域名后缀！");
      return;
    }

    // 顺序模式：按字符集进位递增惰性生成；否则走原有规则词库生成
    let prefixes: string[];
    if (seqMode) {
      const startFrom = resumeFrom || seqStart;
      prefixes = generateSeqPrefixes(seqCharset, seqLength, startFrom, 20000);
      if (prefixes.length === 0) {
        showToast("error", "顺序模式未能生成候选，请检查字符集与长度设置！");
        return;
      }
      showToast(
        "info",
        `🔢 顺序模式：从 [${prefixes[0]}] 开始，本轮生成 ${prefixes.length} 个候选前缀`
      );
    } else {
      const parsed = parseRule(batchRules, excludeChars, batchLength, resolveBank);
      if (parsed.unknownTokens.length > 0) {
        showToast("error", `规则中存在无法识别的标签：${parsed.unknownTokens.join("、")}`);
        return;
      }
      prefixes = generateCombos(parsed, MAX_PREFIXES);
      if (prefixes.length === 0) {
        showToast("error", "根据当前规则未能生成有效的前缀词库，请修改规则！");
        return;
      }
      const totalCombos = countCombos(parsed);
      if (totalCombos > MAX_PREFIXES) {
        showToast(
          "warning",
          `⚠️ 该规则共 ${totalCombos.toLocaleString()} 条组合，已截断为前 ${MAX_PREFIXES.toLocaleString()} 条。超大规则建议改用顺序模式配合断点续查。`
        );
      }
    }

    // ── 官方保留前缀过滤：整词匹配剔除不可注册的前缀，避免浪费 API 配额 ──
    if (enableReservedFilter && reservedPrefixes.length > 0) {
      const reservedSet = new Set(reservedPrefixes.map(p => p.toLowerCase()));
      const before = prefixes.length;
      prefixes = prefixes.filter(p => !reservedSet.has(p.toLowerCase()));
      const removed = before - prefixes.length;
      if (removed > 0) {
        showToast("info", `🚫 已排除 ${removed} 个官方保留前缀（不可注册）`);
      }
      if (prefixes.length === 0) {
        showToast("error", "全部候选前缀都属于官方保留名单，无可查询项！");
        return;
      }
    }

    // 生成任务：中文等非 ASCII 前缀转 Punycode 用于实际查询(queryFull)，
    // 同时保留中文原文(full)用于日志与结果展示
    const allTasks: Array<{ sub: string; root: string; full: string; queryFull: string }> = [];
    for (const sub of prefixes) {
      for (const root of selectedRoots) {
        const full = `${sub}.${root}`;
        allTasks.push({ sub, root, full, queryFull: toASCII(full) });
      }
    }

    // ── 查重池过滤 ──
    // 池子只用于「跳过已确认已注册的域名」，属于纯优化项，不是扫描的前置依赖。
    // 因此这里不再阻塞等待全部批次查完（旧实现串行 await 40+ 次往返，
    // 用户开扫前要白等十几秒），而是：
    //   1) 先同步查第一批，拿到即可开工；
    //   2) 其余批次在后台并发补充进 skipSet，worker 领任务时实时查表跳过。
    const POOL_BATCH = 400; // 与后端单条语句内联上限对齐
    const skipSet = new Set<string>();
    let poolFailed = false;

    const fetchPoolChunk = async (chunk: typeof allTasks) => {
      const res = await apiFetch("/api/whois/pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: chunk.map(t => t.queryFull) })
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.registered)) {
        data.registered.forEach((d: string) => skipSet.add(d));
      }
    };

    const logPoolFailure = (e: unknown) => {
      if (poolFailed) return; // 只提示一次，避免日志被刷屏
      poolFailed = true;
      console.error("查重池查询失败，将退化为全量扫描:", e);
      setScanLogs(prev => [
        {
          id: Date.now() + Math.random(),
          time: new Date().toLocaleTimeString(),
          text: "⚠️ 查重池查询失败，本轮已退化为全量扫描（不影响结果，仅多消耗 API 配额）",
          status: "error"
        },
        ...prev.slice(0, 49)
      ]);
      showToast("warning", "⚠️ 查重池查询失败，已退化为全量扫描");
    };

    if (!ignorePool) {
      const chunks: Array<typeof allTasks> = [];
      for (let i = 0; i < allTasks.length; i += POOL_BATCH) {
        chunks.push(allTasks.slice(i, i + POOL_BATCH));
      }

      // 第一批同步等待：小规模扫描（单批）到这里池子就已完整
      try {
        if (chunks.length > 0) await fetchPoolChunk(chunks[0]);
      } catch (e) {
        logPoolFailure(e);
      }

      // 其余批次后台并发补充，不阻塞扫描启动
      if (chunks.length > 1) {
        void Promise.all(
          chunks.slice(1).map(ch => fetchPoolChunk(ch).catch(logPoolFailure))
        ).then(() => {
          if (!poolFailed && skipSet.size > 0) {
            setScanLogs(prev => [
              {
                id: Date.now() + Math.random(),
                time: new Date().toLocaleTimeString(),
                text: `🗂️ 查重池加载完毕，共命中 ${skipSet.size} 个已注册域名（扫描中自动跳过）`,
                status: "info"
              },
              ...prev.slice(0, 49)
            ]);
          }
        });
      }

      if (skipSet.size > 0) {
        showToast("info", `🗂️ 查重池已命中 ${skipSet.size} 个已注册域名，将在扫描中自动跳过`);
      }
    }

    // 全部候选都在池中（仅当池子已完整加载时才可能成立）
    if (allTasks.length > 0 && skipSet.size >= allTasks.length) {
      showToast("success", "🎉 本轮全部候选均已在查重池中确认为已注册，无需重复查询！");
      updateScanStatus("completed");
      return;
    }

    const totalTasks = allTasks;

    // 多账号并发查重：
    // 为每个 API 账号开一条独立的流水线（worker），各自绑定固定账号并遵守自身 1.2s (1200ms) 限频。
    // N 条流水线同时工作 => 整体吞吐量约为单账号的 N 倍（真并发，而非串行轮询）。
    const RATE_LIMIT_MS = 1200; // 单个 API 账号的独立限频底线
    const workerAccounts = dnsheAccounts.length > 0 ? dnsheAccounts : [null];
    const workerCount = workerAccounts.length;

    // 新一轮开跑：先领一个新代号，上一轮可能还挂在「暂停」上的流水线就此作废
    // （否则它会因为 scanControlRef 又变成 running 而复活，两轮流水线抢同一个任务列表）
    const myGen = ++scanRunGenRef.current;

    updateScanStatus("running");
    setScanProgress({ total: totalTasks.length, checked: 0, available: availableDomainsList.length });
    showToast(
      "info",
      `🚀 开始多账号并发查重！绑定 ${workerCount} 个 API 账号，${workerCount} 条流水线并行（每个 API 独立保障 1.2s 限频），查重吞吐提升约 ${workerCount} 倍！`
    );

    // 共享的任务游标：各 worker 抢占式领取任务，天然实现负载均衡
    let nextTaskIndex = 0;
    let checkedCount = 0;
    let skippedCount = 0; // 因命中查重池而跳过的数量（未消耗上游 API 配额）

    // 单个域名的查询与日志上报逻辑
    const processTask = async (
      task: { sub: string; root: string; full: string; queryFull: string },
      account: (typeof workerAccounts)[number]
    ) => {
      const accountQuery = account ? `&account_id=${account.id}` : "";
      const accAlias = account ? account.alias : "公共轮询";
      const nowTime = new Date().toLocaleTimeString();
      try {
        const res = await apiFetch(`/api/whois?domain=${encodeURIComponent(task.queryFull)}${accountQuery}&batch=1`);
        const data = await res.json();

        // 请求在飞的这段时间里用户可能已经点了停止 / 重新开始 → 本次结果属于上一轮，直接丢弃
        if (myGen !== scanRunGenRef.current) return;

        // 限流感知：撞到 429 / 配额耗尽时自动暂停，保住断点光标供稍后继续
        if (res.status === 429 || data.error_code === "rate_limited" || data.error_code === "quota_exceeded") {
          saveScanCursor(task.sub, nextTaskIndex, checkedCount);
          updateScanStatus("paused");
          setScanLogs(prev => [
            { id: Date.now() + Math.random(), time: nowTime, text: `[${accAlias}] ⛔ 触发 API 限流/配额上限，已自动暂停（断点已保存至 ${task.sub}）`, status: "error" },
            ...prev.slice(0, 49)
          ]);
          showToast("warning", "⛔ 触发 API 限流，已自动暂停并保存断点，稍后可点击继续");
          return;
        }

        if (data.success && data.whois && data.whois.registered === false) {
          setAvailableDomainsList(prev => [
            { fullDomain: task.full, subdomain: task.sub, rootdomain: task.root, time: nowTime },
            ...prev
          ]);
          checkedCount++;
          setScanProgress(p => ({ ...p, checked: checkedCount, available: p.available + 1 }));
          setScanLogs(prev => [
            { id: Date.now() + Math.random(), time: nowTime, text: `[${accAlias}] 校验域名 ${task.full} ➔ 🎉 尚未注册（可立即在线注册！）`, status: "available" },
            ...prev.slice(0, 49)
          ]);
        } else {
          checkedCount++;
          setScanProgress(p => ({ ...p, checked: checkedCount }));
          setScanLogs(prev => [
            { id: Date.now() + Math.random(), time: nowTime, text: `[${accAlias}] 校验域名 ${task.full} ➔ 已被他人注册`, status: "registered" },
            ...prev.slice(0, 49)
          ]);
        }
      } catch (err) {
        if (myGen !== scanRunGenRef.current) return;
        checkedCount++;
        setScanProgress(p => ({ ...p, checked: checkedCount }));
        setScanLogs(prev => [
          { id: Date.now() + Math.random(), time: nowTime, text: `[${accAlias}] 校验域名 ${task.full} ➔ ⚠️ 查询请求异常，已跳过`, status: "error" },
          ...prev.slice(0, 49)
        ]);
      }
    };

    // 单条流水线：固定绑定一个账号，循环领取任务并遵守自身 1.2s 限频
    const runWorker = async (account: (typeof workerAccounts)[number]) => {
      while (true) {
        // 本轮已作废（用户点了停止，或另开了一轮） → 立刻退场
        if (myGen !== scanRunGenRef.current) return;
        // 停止或重置
        if ((scanControlRef.current as string) === "idle") return;
        // 暂停：挂起直到解冻或停止
        while ((scanControlRef.current as string) === "paused") {
          await new Promise(r => setTimeout(r, 300));
          if (myGen !== scanRunGenRef.current) return;
          if ((scanControlRef.current as string) === "idle") return;
        }

        // 抢占式领取下一个任务
        const idx = nextTaskIndex++;
        if (idx >= totalTasks.length) return;

        // 实时记录进度，供暂停/限流时落盘为断点光标
        scanCursorRef.current = {
          lastCandidate: totalTasks[idx].sub,
          taskIndex: idx,
          checked: checkedCount
        };

        // 查重池命中：直接跳过，既不发请求也不占用该账号的限频窗口。
        // 池子在后台持续加载，越往后命中率越完整。
        if (!ignorePool && skipSet.has(totalTasks[idx].queryFull)) {
          checkedCount++;
          skippedCount++;
          setScanProgress(p => ({ ...p, checked: checkedCount }));
          continue;
        }

        const startedAt = Date.now();
        await processTask(totalTasks[idx], account);

        // 该账号自身限频：距上次请求发起不足 1.2s 则补足剩余时间
        const elapsed = Date.now() - startedAt;
        if (elapsed < RATE_LIMIT_MS) {
          await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
        }
      }
    };

    // 所有流水线同时启动，等待全部跑完
    await Promise.all(workerAccounts.map(acc => runWorker(acc)));

    if (myGen === scanRunGenRef.current && scanControlRef.current === "running") {
      updateScanStatus("completed");
      clearScanCursor(); // 正常跑完，断点光标不再需要
      showToast(
        "success",
        skippedCount > 0
          ? `🎉 所有生成的域名字典查询完毕！其中 ${skippedCount} 个命中查重池已跳过，节省了同等数量的 API 配额。`
          : "🎉 所有生成的域名字典查询完毕！"
      );
    }
  };

  // 导出生成的 txt 结果
  const handleExportAvailableTxt = () => {
    if (availableDomainsList.length === 0) {
      showToast("info", "暂无已发现的可用域名供导出！");
      return;
    }

    const content = availableDomainsList.map(item => item.fullDomain).join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `available_domains_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("success", "已成功导出可用域名 txt 文本！");
  };

  // 侧栏菜单项定义
  const navItems: Array<{ key: TabKey; label: string; icon: React.ReactNode; badge?: number }> = [
    { key: "dashboard", label: "概览", icon: <LayoutDashboard className="w-5 h-5" /> },
    { key: "domains", label: "域名列表", icon: <Globe className="w-5 h-5" />, badge: domains.length },
    { key: "cloudflare", label: "Cloudflare", icon: <Cloud className="w-5 h-5" />, badge: cfZones.length },
    { key: "assist", label: "域名助力", icon: <Gift className="w-5 h-5" />, badge: overview?.assist?.assist_remaining },
    { key: "accounts", label: "账号管理", icon: <Key className="w-5 h-5" />, badge: dnsheAccounts.length },
    { key: "apikeys", label: "API 密钥", icon: <Lock className="w-5 h-5" /> },
    { key: "register", label: "注册 / 查重", icon: <Plus className="w-5 h-5" /> },
    { key: "quota", label: "账户配额", icon: <Database className="w-5 h-5" /> },
    { key: "logs", label: "运行日志", icon: <ScrollText className="w-5 h-5" /> },
    { key: "settings", label: "设置", icon: <Settings className="w-5 h-5" /> },
  ];

  // 通知铃铛数据源：最近的告警/错误日志
  const alertLogs = useMemo(
    () => logs.filter((l) => l.type === "error" || l.type === "warning").slice(0, 6),
    [logs]
  );

  // 已读告警标记：持久化最近查看过的告警 ID，用于小铃铛红点显隐
  const [lastAlertSeenId, setLastAlertSeenId] = useState<number>(
    () => Number(localStorage.getItem("DNSHE_LAST_SEEN_ALERT_ID") || 0)
  );
  // 是否存在比上次已读更新/更高的未读告警
  const unreadAlert = useMemo(() => {
    const newest = alertLogs[0];
    return !!newest && newest.id > lastAlertSeenId;
  }, [alertLogs, lastAlertSeenId]);
  // 将当前全部告警标记为已读
  const markAlertsRead = () => {
    const newest = alertLogs[0];
    if (newest) {
      setLastAlertSeenId(newest.id);
      localStorage.setItem("DNSHE_LAST_SEEN_ALERT_ID", String(newest.id));
    }
  };

  // 日志分类映射（兼容历史 category 值）
  //   登录 ← auth
  //   API  ← api / sync / renew
  //   操作 ← operation / system
  const filteredLogs = useMemo(() => {
    if (logCategory === "all") return logs;
    const groupMap: Record<string, string[]> = {
      auth: ["auth"],
      api: ["api", "sync", "renew"],
      operation: ["operation", "system"],
    };
    const allowed = groupMap[logCategory] || [];
    return logs.filter((l) => allowed.includes(l.category));
  }, [logs, logCategory]);

  /**
   * 单条日志在「表格行」与「手机卡片」两种布局下共用的字段节点
   *
   * NOTE: 表格行必须待在 <tbody> 里、卡片必须在表格外，两者无法共用一次 map，
   * 但字段的格式化与样式只写这一份 —— 否则两套布局早晚各自走形。
   */
  const logRowParts = (log: AppLog) => ({
    time: new Date(log.created_at).toLocaleString("zh-CN"),
    badge: (
      /* §15（2026-09-30 修订）：浅色也带底 + 同色系浅边框，与卡片状态徽章同一套视觉。
         此前这里的「浅色只留字色不加底」是 §15 旧版规则的唯一遗留，已按用户裁决统一。 */
      <span className={`inline-block px-2.5 py-0.5 rounded-full font-bold uppercase text-xs flex-shrink-0 border ${
        log.type === "success" ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/80 dark:text-emerald-400 dark:border-emerald-900/60" :
        log.type === "error" ? "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/80 dark:text-red-400 dark:border-red-900/60 animate-pulse" :
        log.type === "warning" ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/80 dark:text-amber-400 dark:border-amber-900/60" :
        "bg-elevated text-content-secondary border-border-base dark:bg-elevated"
      }`}>
        {log.type}
      </span>
    ),
    details: log.details ? (
      <pre className="mt-2 p-2.5 rounded bg-elevated text-content-muted text-[11px] md:text-xs font-mono max-h-40 overflow-auto whitespace-pre-wrap break-all">
        {log.details}
      </pre>
    ) : null,
  });

  // Dashboard 概览统计（纯前端计算）
  const dashboardStats = useMemo(() => {
    const now = Date.now();
    let active = 0;
    let expired = 0;
    domains.forEach((d) => {
      const exp = d.expires_at ? new Date(d.expires_at).getTime() : NaN;
      const isExpired = (!isNaN(exp) && exp < now) || d.status === "已过期";
      if (isExpired) expired++;
      else active++;
    });
    // 最近注册（按 created_at 倒序，前 6 条）
    const recent = [...domains]
      .filter((d) => d.created_at)
      .sort((a, b) => new Date(b.created_at!).getTime() - new Date(a.created_at!).getTime())
      .slice(0, 6);
    return {
      total: domains.length,
      active,
      expired,
      accounts: dnsheAccounts.length,
      recent,
    };
  }, [domains, accounts]);

  // 顶部搜索提交：跳转到域名页并带入搜索词
  /**
   * 回车提交搜索
   *
   * 大部分页面就地过滤（见 filteredQuotas / filteredAssistAccounts / filteredKeyGroups …）；
   * 概览页与注册查重页自己没有列表可筛，回车就把关键词带到域名列表去看结果。
   */
  const handleGlobalSearchSubmit = () => {
    if (activeTab === "dashboard" || activeTab === "register") setActiveTab("domains");
  };

  // ===== 未登录：展示登录 / 首次初始化页面 =====
  if (!sessionToken) {
    // 鉴权状态尚未加载完成时，先展示加载态，避免登录/初始化界面闪烁
    if (!authStatusLoaded) {
      return (
        <div className="flex h-screen items-center justify-center bg-page text-content-primary">
          <RefreshCw className="w-6 h-6 animate-spin text-indigo-500" />
        </div>
      );
    }

    return (
      <div className="flex h-screen items-center justify-center bg-page text-content-primary px-4">
        <div className="w-full max-w-sm bg-surface border border-border-base rounded-2xl shadow-2xl p-7 space-y-6">
          {/* 头部 LOGO */}
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="w-12 h-12 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
              <Globe className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-xl font-black text-content-primary">DNSHE 集控台</h1>
            <p className="text-xs text-content-muted">
              {authInitialized ? "请登录以管理您的免费域名资产" : "首次使用，请设置管理员账户"}
            </p>
          </div>

          {/* 错误提示 */}
          {loginError && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-50 border border-red-200 text-red-700 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-400 text-xs">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{loginError}</span>
            </div>
          )}

          {authInitialized ? (
            /* ── 登录表单 ── */
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-content-secondary">用户名</label>
                <input
                  type="text"
                  autoComplete="username"
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  placeholder="管理员用户名"
                  className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-content-secondary">密码</label>
                <PasswordInput
                  autoComplete="current-password"
                  value={loginPassword}
                  onChange={setLoginPassword}
                  placeholder="登录密码"
                  className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                />
              </div>
              {(authTwoFaEnabled || loginNeeds2fa) && (
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-content-secondary flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> 两步验证动态码
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={loginTotp}
                    onChange={(e) => setLoginTotp(e.target.value)}
                    placeholder="身份验证器上的 6 位数字"
                    className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                  />
                </div>
              )}
              <button
                type="submit"
                disabled={loginLoading}
                className="btn-primary w-full py-2.5 rounded-lg text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {loginLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
                {loginLoading ? "登录中..." : "登录"}
              </button>
            </form>
          ) : (
            /* ── 首次初始化表单 ── */
            <form onSubmit={handleSetup} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-content-secondary">设置用户名</label>
                <input
                  type="text"
                  autoComplete="username"
                  value={setupUsername}
                  onChange={(e) => setSetupUsername(e.target.value)}
                  placeholder="至少 3 个字符"
                  className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-content-secondary">设置密码</label>
                <PasswordInput
                  autoComplete="new-password"
                  value={setupPassword}
                  onChange={setSetupPassword}
                  placeholder="至少 8 个字符"
                  className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-content-secondary">确认密码</label>
                <PasswordInput
                  autoComplete="new-password"
                  value={setupPassword2}
                  onChange={setSetupPassword2}
                  placeholder="再次输入密码"
                  className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                />
              </div>
              <button
                type="submit"
                disabled={loginLoading}
                className="btn-primary w-full py-2.5 rounded-lg text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {loginLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                {loginLoading ? "创建中..." : "创建管理员账户并进入"}
              </button>
            </form>
          )}

          {/* 登录页 Toast 通知 */}
        </div>

        {/* 登录页也需要 Toast 通知（限宽与换行同全局 Toast，理由见那处注释） */}
        {toast && (
          <div className="fixed bottom-5 right-5 z-50 max-w-[min(90vw,28rem)] flex items-start gap-2.5 px-4 py-3 rounded-lg shadow-2xl border text-sm font-semibold bg-surface text-content-primary border-border-base">
            {toast.type === "success" && <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />}
            {toast.type === "error" && <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />}
            {toast.type === "info" && <Info className="w-5 h-5 text-indigo-500 flex-shrink-0" />}
            {toast.type === "warning" && <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" />}
            <span className="min-w-0 break-words line-clamp-6">{toast.message}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    /*
      NOTE: 高度用 100dvh 而非 100vh —— 移动浏览器的 100vh 把地址栏高度也算进去，
      底部内容会被切掉一截。桌面上 dvh 与 vh 等价，渲染结果不变。
    */
    <div className="flex h-[100dvh] overflow-hidden bg-page text-content-primary">

      {/* 手机抽屉遮罩：点击关闭；≥md 侧栏常驻，不需要遮罩 */}
      {/*
        NOTE: 遮罩从**顶栏下沿**开始（top-16），不能 inset-0 —— 否则它会把顶栏一起盖住，
        汉堡按钮就被压在遮罩底下、点不到，也就无法"再点一次收起"。
      */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed left-0 right-0 bottom-0 top-16 z-30 bg-slate-950/60 backdrop-blur-sm md:hidden"
          aria-hidden="true"
        />
      )}

      {/* ===== 导航：<md 为顶栏下拉抽屉，≥md 为常驻可折叠侧栏 ===== */}
      {/*
        NOTE: 同一个 aside 兼任两种形态，导航项只写一份。
        <md：fixed 顶栏下沿通栏（top-16 left-0 right-0），用 translate-y 从**顶栏底下**滑出
             （-translate-y-[calc(100%_+_4rem)] → 0）。关键在于顶栏被抬到 z-[45]（见 <header> 的
             NOTE）—— 抽屉途经 y<64 的那截被顶栏挡住，所以它看起来是从顶栏下沿"长"出来的，
             而不是从屏幕最顶端掉下来。底部再留一段空隙，让它一眼是"下拉的抽屉"而不是整屏页面。
             汉堡始终可见可点，展开态变成 × 能点回来。不占布局流，否则会吃掉手机上一半屏宽。
        ≥md：md:static 归位到布局流（static 会忽略 top/left/right），宽度由 railMode 决定，
             并且**必须显式 md:translate-y-0** —— 手机态留下的负位移
             在切到桌面宽度后依然生效，会把常驻侧栏整个顶出屏幕外。
        2026-09-30 第17轮：用户要求「点击打开菜单的按钮…我要的是从上面下拉出来的抽屉形式」，
        原来的左侧滑入式 aside 保留给 ≥md 的常驻侧栏，<md 换成顶部下拉；
        同轮后半段用户再提「应该从顶栏的下面边缘出来，低于按钮控件才对」⇒ 顶栏加 `relative z-[45]`。
      */}
      <aside
        id="app-nav-panel"
        className={`fixed top-16 left-0 right-0 z-40 w-full max-h-[calc(100dvh-8rem)] flex flex-col overflow-hidden rounded-b-2xl shadow-2xl border-b border-border-base bg-surface transition-transform duration-300 ease-out ${
          sidebarOpen ? "translate-y-0" : "-translate-y-[calc(100%_+_4rem)]"
        } md:static md:z-auto md:translate-y-0 md:max-h-none md:rounded-none md:shadow-none md:border-b-0 md:border-r md:flex-shrink-0 md:transition-all ${
          railMode ? "md:w-16" : "md:w-56"
        }`}
      >
        {/* LOGO + 折叠按钮（≥md 侧栏头部；手机下拉抽屉里不重复顶栏已有的信息与关闭方式） */}
        <div className="hidden md:flex h-16 items-center gap-2 px-3 border-b border-border-base">
          {/* 折叠切换只在桌面有意义：手机上这个按钮所在的抽屉本身就是被汉堡唤出的 */}
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="hidden md:flex p-2 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-all flex-shrink-0"
            title={railMode ? "展开菜单" : "折叠菜单"}
          >
            <Menu className="w-5 h-5" />
          </button>
          {!railMode && (
            <div className="flex items-center gap-1.5 font-black text-content-primary whitespace-nowrap overflow-hidden">
              <Globe className="w-5 h-5 text-indigo-500 flex-shrink-0" />
              <span className="truncate">DNSHE 集控</span>
            </div>
          )}
          {/*
            原来这里有个「手机端抽屉 × 关闭按钮」。第17轮抽屉改到顶栏下沿之后，
            顶栏的汉堡在展开态自己就变成 × 且始终可见可点，遮罩与 Esc 也都还在（§22），
            这个按钮成了永远不会渲染的死代码（父行 md:flex、自己 md:hidden）⇒ 删掉。
          */}
        </div>

        {/* 菜单项 */}
        <nav className="flex-1 py-4 px-2 space-y-1 overflow-y-auto overscroll-contain">
          {navItems.map((item) => {
            /*
              二级菜单：目前只有「设置」有下级小节（后端地址 / 账户安全 / 自动续期 /
              解析线路支持名单 / 通知渠道），其余页签是一个整页、没有可拆的子项。
              railMode（桌面折叠成图标条）下不渲染二级菜单 —— 那个宽度放不下文字。
            */
            const children = item.key === "settings" ? SETTINGS_SECTIONS : null;
            const expanded = navExpanded === item.key;
            return (
              <div key={item.key}>
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => {
                      setActiveTab(item.key);
                      // 手机上选完就收起抽屉，否则内容被遮住还得再点一次
                      setSidebarOpen(false);
                    }}
                    title={railMode ? item.label : undefined}
                    className={`group flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all ${
                      activeTab === item.key
                        ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20"
                        : "text-content-muted hover:text-content-primary hover:bg-hovered"
                    } ${railMode ? "justify-center" : ""}`}
                  >
                    <span className="flex-shrink-0">{item.icon}</span>
                    {!railMode && (
                      <>
                        <span className="flex-1 text-left whitespace-nowrap">{item.label}</span>
                        {item.badge !== undefined && item.badge > 0 && (
                          <span className="text-xs px-1.5 py-0.5 rounded-full bg-black/20 text-current opacity-80">
                            {item.badge}
                          </span>
                        )}
                      </>
                    )}
                  </button>
                  {/* 展开/收起二级菜单的箭头。与左侧主按钮同一行，只占图标宽 */}
                  {children && !railMode && (
                    <button
                      onClick={() => setNavExpanded(expanded ? null : item.key)}
                      className="p-2 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-all flex-shrink-0"
                      title={expanded ? `收起「${item.label}」子菜单` : `展开「${item.label}」子菜单`}
                      aria-label={expanded ? "收起子菜单" : "展开子菜单"}
                      aria-expanded={expanded}
                    >
                      <ChevronDown
                        className={`w-4 h-4 transition-transform duration-300 ${expanded ? "rotate-180" : ""}`}
                      />
                    </button>
                  )}
                </div>
                {/*
                  二级菜单容器用 .nav-sublist（grid-template-rows 0fr↔1fr 过渡，见 index.css）：
                  收起态是**高度 0 + overflow hidden**，不是「不渲染」，这样才能做出展开/收起动画。
                  代价是收起时子项仍在 DOM 里 ⇒ 用 tabIndex={-1} 把它们移出键盘 Tab 序列，
                  否则键盘用户会 focus 到看不见的按钮上。
                */}
                {children && !railMode && (
                  <div className="nav-sublist" data-open={expanded ? "true" : "false"}>
                    <div>
                      <div className="pt-1 pb-0.5 space-y-0.5">
                        {children.map((c) => (
                          <button
                            key={c.id}
                            tabIndex={expanded ? 0 : -1}
                            onClick={() => {
                              // 先切到设置页再滚过去；滚动要等设置数据渲染出来，见 scrollToSettingsSection
                              setActiveTab("settings");
                              setSidebarOpen(false);
                              scrollToSettingsSection(c.id);
                            }}
                            className="w-full flex items-center gap-2 pl-9 pr-3 py-2 rounded-lg text-xs font-semibold text-content-muted hover:text-content-primary hover:bg-hovered transition-all"
                          >
                            <span className="w-1 h-1 rounded-full bg-current flex-shrink-0" />
                            <span className="min-w-0 truncate text-left">{c.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* 抽屉底部退出入口（仅手机）：头部横向空间紧张，退出按钮挪到这里 */}
        <div className="md:hidden border-t border-border-base p-2">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-semibold text-content-secondary hover:text-content-primary hover:bg-hovered transition-all"
          >
            <LogIn className="w-5 h-5 text-amber-400 flex-shrink-0" />
            退出登录
          </button>
        </div>
      </aside>

      {/* ===== 右侧主区（顶部栏 + 内容） ===== */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* ===== 顶部栏 ===== */}
        {/*
          NOTE: `relative z-[45]` 是手机下拉抽屉能"从顶栏底下钻出来"的前提（第17轮补充）。
          <md 时抽屉是 `fixed top-16 z-40`，而顶栏原本是 static（z 自动）—— 定位元素必然
          画在非定位元素之上，于是抽屉在滑出/收回的途中会把顶栏整条盖住，看着就像
          "从屏幕最顶端掉下来"（用户实拍反馈：「完全从顶部出来…应该从顶栏的下面边缘出来」）。
          把顶栏提到 45 层：
            · 45 > 40 ⇒ 抽屉位于 y<64 的那一截被顶栏遮住，只能从顶栏下沿"长"出来；
            · 45 < 50 ⇒ 弹窗 / toast（z-50）依旧盖得住顶栏，层级语义不变。
          顶栏背景是不透明的 `bg-surface`（亮 #ffffff / 暗 #0f151f）且无 backdrop-blur，
          遮挡是实的，不会透出抽屉内容；`border-b` 也随顶栏一起压在抽屉之上。
          ⚠️ 已确认的副作用：顶栏成为层叠上下文后，它内部的「告警通知」面板
          （`fixed ... z-50`）实际被抬到根层的 45 —— 而它本来就该在弹窗之下、内容之上。
        */}
        <header className="relative z-[45] h-16 flex-shrink-0 flex items-center gap-2 sm:gap-3 px-3 sm:px-4 md:px-6 border-b border-border-base bg-surface">
          {/* 全局搜索框 */}
          {/*
            NOTE: min-w-0 是必需的 —— flex 子项默认 min-width:auto，没有它 flex-1 不会真的收缩。
            另外去掉了原来的 max-w-md 与后面的 flex-1 占位块：那对组合会把搜索框卡在 448px、
            右侧再撑出一段纯空白，宽屏下看着像布局没做完。现在搜索框直接吃满所有未占用宽度。
          */}
          <div
            className={`flex-1 min-w-0 relative ${SEARCH_CONFIG[activeTab]?.enabled === false ? "hidden" : ""}`}
          >
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-content-muted pointer-events-none" />
            {/*
              NOTE: type="search" + autoComplete="off" 是为了挡住 Chrome 密码管理器。
              设置页的「修改登录密码」表单一旦被自动填充，Chrome 会去猜用户名字段，
              往前找到的第一个纯文本输入框就是这里，于是把用户名塞进搜索框、
              静默过滤掉域名列表（看起来像账号和域名凭空少了一大半）。
              Chrome 不会把 type="search" 的输入框当作用户名字段。
              原生清除按钮在 index.css 里隐藏，外观与改造前一致。
            */}
            <input
              type="search"
              name="domain-search"
              autoComplete="off"
              value={globalSearch}
              onChange={(e) => setGlobalSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleGlobalSearchSubmit(); }}
              /* 提示语与检索目标都跟着当前页面走（见 SEARCH_CONFIG 的注释） */
              placeholder={mobileSearchPlaceholder}
              className="form-input w-full h-10 pl-9 pr-3 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
            />
          </div>

          {/* 域名页快捷同步 */}
          {activeTab === "domains" && (
            <button
              onClick={handleSyncDomains}
              disabled={actionLoading === "sync" || loadingDomains}
              className="btn-primary h-10 px-2.5 sm:px-3.5 rounded-lg text-sm font-semibold text-white flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            >
              <RefreshCw className={`w-4 h-4 ${actionLoading === "sync" ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">
                {syncProgress && syncProgress.total > 0
                  ? `同步中 ${syncProgress.done}/${syncProgress.total}`
                  : "同步"}
              </span>
            </button>
          )}

          {/* 通知铃铛 */}
          <div className="relative flex-shrink-0">
            <button
              onClick={() => {
                const next = !notifOpen;
                setNotifOpen(next);
                // 通知面板与新抽屉都占「顶栏下沿」这一块，两者不同时开（§10.5 互斥只留一个）
                if (next) setSidebarOpen(false);
                if (next) markAlertsRead();
              }}
              className="relative h-10 w-10 p-0 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-all flex items-center justify-center"
              title="告警通知"
            >
              <Bell className="w-5 h-5" />
              {unreadAlert && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              )}
            </button>
            {notifOpen && (
              /*
                NOTE: 窄屏不能再锚在铃铛上（`absolute right-0`）。第15轮线上实测 390px：
                      面板 x=-36 / w=366，而铃铛右缘在 330 ⇒ 整体偏左、左边被视口切掉
                      （用户截图里「最近告警」被切成「级告警」、WARNING 切成 RNING）。
                      手机端改为**脱离铃铛**：`fixed` + 左右各留 12px（与顶栏 px-3 对齐）+
                      顶栏正下方（h-16 = 64px，再让 4px），这样天然左右对称、永远不出界；
                      ≥sm 才回到「贴着铃铛右缘」的下拉形态。
                      组件的祖先链上没有 transform/filter（§17 实测 transformedAncestors=[]），
                      所以 `fixed` 不会被误当成 absolute 生效。
              */
              <div className="fixed left-3 right-3 top-16 mt-1 max-h-96 overflow-y-auto bg-elevated border border-border-base rounded-xl shadow-2xl z-50 p-2 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80">
                <div className="px-2 py-1.5 text-xs font-bold text-content-muted flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">最近告警</span>
                  {/* 两个动作同为 h-6（§13 同行等高）：文字按钮 + 图标按钮 */}
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <button
                      onClick={() => { markAlertsRead(); setActiveTab("logs"); setNotifOpen(false); }}
                      className="h-6 px-1.5 inline-flex items-center rounded-md text-indigo-600 hover:text-indigo-700 hover:bg-hovered dark:text-indigo-400 dark:hover:text-indigo-300 transition-all"
                    >
                      查看全部
                    </button>
                    <button
                      onClick={() => setNotifOpen(false)}
                      className="h-6 w-6 rounded-md text-content-muted hover:text-content-primary hover:bg-hovered transition-all inline-flex items-center justify-center"
                      title="关闭"
                      aria-label="关闭通知面板"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {alertLogs.length === 0 ? (
                  <div className="px-2 py-6 text-center text-sm text-content-muted">暂无告警</div>
                ) : (
                  alertLogs.map((log) => (
                    <div key={log.id} className="px-2 py-2 rounded-lg hover:bg-hovered text-xs">
                      <div className={`font-semibold ${log.type === "error" ? "text-red-400" : "text-amber-400"}`}>
                        {log.type.toUpperCase()}
                      </div>
                      <div className="text-content-secondary mt-0.5 line-clamp-2">{log.message}</div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 主题切换 */}
          <button
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            className="h-10 w-10 p-0 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-all flex-shrink-0 flex items-center justify-center"
            title={theme === "dark" ? "切换到亮色" : "切换到暗色"}
          >
            {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>

          {/*
            汉堡按钮：唤出手机抽屉（≥md 侧栏常驻，折叠切换在侧栏内部）
            2026-09-30 第16轮按用户要求从「搜索框左边」挪到「主题切换右边」——
            原话：「打开菜单按钮放在主题切换按钮的右边，即贴在顶栏的右边，更符合人的操作习惯」。
            拇指从右下角往上够右手边的最后一个按钮，比横跨整个屏幕去够左上角顺手。

            ⚠️ 尺寸**故意保持 `h-10 w-10`（40×40）而不是用户给出的 `h-9 w-9`（36×36）**：
               顶栏里它和 h-10 的搜索框同行，§9 明文规定「顶栏/工具行图标按钮一律 h-10 w-10，
               不允许出现 h-9」。36px 会同时违反「触控 ≥40px」与「同行控件等高」两条，
               而且它是**唯一**会露出 36px 的按钮 —— 第13轮刚把全顶栏的 h-9 统一成 h-10。
               位置按用户要求移，尺寸仍按规范：这是同一件事的两个维度，不冲突。
          */}
          <button
            onClick={() => {
              const next = !sidebarOpen;
              setSidebarOpen(next);
              // 同上：两个顶栏下沿浮层互斥
              if (next) setNotifOpen(false);
            }}
            className="md:hidden h-10 w-10 p-0 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-all flex-shrink-0 flex items-center justify-center"
            title={sidebarOpen ? "关闭菜单" : "打开菜单"}
            aria-expanded={sidebarOpen}
            aria-controls="app-nav-panel"
          >
            {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>

          {/* 退出登录：手机上头部空间紧张，入口挪进抽屉底部 */}
          <button
            onClick={handleLogout}
            className="hidden md:flex h-10 bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-3 rounded-lg text-sm font-semibold items-center gap-2 transition-all flex-shrink-0"
            title="退出登录"
          >
            <LogIn className="w-4 h-4 text-amber-400" />
            <span className="hidden md:inline">退出登录</span>
          </button>
        </header>

        {/* 主面板内容 */}
        <main className="flex-1 overflow-y-auto px-3 sm:px-4 md:px-6 py-5 md:py-6">

        {/* 页面级过渡：切换标签时旧块卸载、新块挂载，key 变化让淡入动画重放一次。
             只包 tab 块 —— 模态框（编辑账号 / CF 解析面板等）是浮层，跟着淡入会闪一下 */}
        <div key={activeTab} className="page-anim">
        {activeTab === "dashboard" && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
              <div>
                <h2 className="text-2xl font-black text-content-primary flex items-center gap-2">
                  <LayoutDashboard className="w-6 h-6 text-indigo-500" /> 概览
                </h2>
                <p className="text-content-muted mt-1 text-sm">域名资产、账号助力与额度总览</p>
              </div>
              {/* 列数可调：上游把「一行 3 个」写死了，窄屏挤、宽屏空 */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-content-muted whitespace-nowrap">每行列数</span>
                <select
                  value={overviewCols}
                  onChange={(e) => setOverviewCols(e.target.value)}
                  className="form-input text-sm px-3 h-10 rounded-lg"
                  aria-label="概览卡片每行列数"
                >
                  {OVERVIEW_COL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => fetchOverview()}
                  className="p-2 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-colors"
                  title="刷新概览"
                >
                  <RefreshCw className={`w-4 h-4 ${loadingOverview ? "animate-spin" : ""}`} />
                </button>
              </div>
            </div>

            {/* ── 分组 1：域名资产 ── */}
            <section className="space-y-3">
              <h3 className="text-xs font-bold text-content-muted uppercase tracking-wide">域名资产</h3>
              {/* key 随列数变化 → React 重挂载子节点，ov-anim 的淡入动画重放，
                  视觉上就是一次平滑重排（grid-template-columns 本身不可过渡） */}
              <div
                key={overviewCols}
                className={`ov-anim grid ${OVERVIEW_COL_CLASS[overviewCols] || OVERVIEW_COL_CLASS.auto} gap-3 sm:gap-4`}
              >
                <OverviewMetricCard
                  label="已注册域名"
                  value={overview?.domains?.total ?? dashboardStats.total}
                  hint="当前托管在 DNSHE 的域名总数"
                  icon={<Globe className="w-5 h-5" />}
                  color="text-indigo-400"
                  onClick={() => setActiveTab("domains")}
                />
                <OverviewMetricCard
                  label="可注册域名"
                  value={overview?.quota?.available ?? "—"}
                  hint={overview?.quota?.failed ? `${overview?.quota?.failed} 个账号额度未取到` : "各账号剩余额度合计"}
                  icon={<Plus className="w-5 h-5" />}
                  color="text-emerald-400"
                  onClick={() => setActiveTab("quota")}
                />
                <OverviewMetricCard
                  label="已委派域名"
                  value={overview?.domains?.delegated ?? "—"}
                  hint="NS 已指向 Cloudflare 等外部服务商"
                  icon={<Cloud className="w-5 h-5" />}
                  color="text-sky-400"
                  onClick={() => setActiveTab("domains")}
                />
                <OverviewMetricCard
                  label="未委派域名"
                  value={overview?.domains?.not_delegated ?? "—"}
                  hint="仍使用 DNSHE 默认解析"
                  icon={<Server className="w-5 h-5" />}
                  color="text-amber-400"
                  onClick={() => setActiveTab("domains")}
                />
              </div>
            </section>

            {/* ── 分组 2：账号与助力 ── */}
            <section className="space-y-3">
              <h3 className="text-xs font-bold text-content-muted uppercase tracking-wide">账号与助力</h3>
              {/* key 随列数变化 → React 重挂载子节点，ov-anim 的淡入动画重放，
                  视觉上就是一次平滑重排（grid-template-columns 本身不可过渡） */}
              <div
                key={overviewCols}
                className={`ov-anim grid ${OVERVIEW_COL_CLASS[overviewCols] || OVERVIEW_COL_CLASS.auto} gap-3 sm:gap-4`}
              >
                <OverviewMetricCard
                  label="DNSHE 账号"
                  value={overview?.accounts?.dnshe ?? dnsheAccounts.length}
                  icon={<Key className="w-5 h-5" />}
                  color="text-amber-400"
                  onClick={() => setActiveTab("accounts")}
                />
                <OverviewMetricCard
                  label="Cloudflare 账号"
                  value={overview?.accounts?.cloudflare ?? cfAccounts.length}
                  icon={<Cloud className="w-5 h-5" />}
                  color="text-sky-400"
                  onClick={() => setActiveTab("accounts")}
                />
                <OverviewMetricCard
                  label="总助力次数"
                  value={overview?.assist ? overview.assist.assist_limit : "—"}
                  hint={overview?.assist ? `已用 ${overview.assist.assist_limit - overview.assist.assist_remaining} 次` : "去助力页同步"}
                  icon={<Award className="w-5 h-5" />}
                  color="text-indigo-400"
                  onClick={() => setActiveTab("assist")}
                />
                <OverviewMetricCard
                  label="剩余助力次数"
                  value={overview?.assist ? overview.assist.assist_remaining : "—"}
                  hint={overview?.assist ? `上限 ${overview.assist.assist_limit}` : "去助力页同步"}
                  icon={<Gift className="w-5 h-5" />}
                  color="text-emerald-400"
                  onClick={() => setActiveTab("assist")}
                />
                <OverviewMetricCard
                  label="已永久化域名"
                  value={overview?.assist ? overview.assist.upgraded_domains : "—"}
                  hint="已升级为永久，无需续期"
                  icon={<CheckCircle2 className="w-5 h-5" />}
                  color="text-emerald-400"
                  onClick={() => setActiveTab("assist")}
                />
                <OverviewMetricCard
                  label="未永久化域名"
                  value={overview?.assist ? overview.assist.non_upgraded_domains : "—"}
                  hint="仍需按时续期，可生成助力码升级"
                  icon={<AlertTriangle className="w-5 h-5" />}
                  color="text-amber-400"
                  onClick={() => setActiveTab("assist")}
                />
              </div>
            </section>

            {/* ── 账户配额 与 最近注册：宽屏并排两列 ──
                两者每一行的信息量都很小（账号 + 已用/总 + 一条进度条），竖着堆会白占半屏高度。
                ⚠️ 不要加 items-start：那会让两张卡各自缩到内容高度，一高一矮很难看。
                   默认的 stretch + 卡内 flex-1 才能保证左右等高（见 docs/前端设计规范.md §1）。 */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <section className="bg-surface border border-border-base rounded-2xl overflow-hidden flex flex-col">
                <div className="px-4 sm:px-5 py-3.5 border-b border-border-base flex items-center justify-between gap-3 flex-shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Database className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                    <h3 className="font-bold text-content-primary text-sm truncate">账户配额</h3>
                    {overview?.quota?.failed ? (
                      <span className="text-[11px] text-amber-400 flex-shrink-0">
                        {overview?.quota?.failed} 个未取到
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[11px] text-content-muted hidden sm:inline whitespace-nowrap">
                      显示{(overview?.quota?.accounts || []).filter((a) => !hiddenQuotaAccounts.includes(a.account_id)).length}/
                      {(overview?.quota?.accounts || []).length}
                    </span>
                    <button
                      onClick={() => setShowQuotaFilter((v) => !v)}
                      className={`text-[11px] px-2.5 py-1.5 rounded-lg border flex items-center gap-1.5 transition-colors ${
                        showQuotaFilter
                          ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-300"
                          : "border-border-base text-content-muted hover:text-content-primary"
                      }`}
                      title="选择要显示的账号"
                    >
                      <Filter className="w-3 h-3" /> 筛选
                      <ChevronDown
                        className={`w-3 h-3 transition-transform duration-200 ${showQuotaFilter ? "rotate-180" : ""}`}
                      />
                    </button>
                  </div>
                </div>

                {/* 筛选抽屉：展开后按账号勾选，选择结果持久化在本地 */}
                {showQuotaFilter && (
                  <div className="drawer-anim px-4 sm:px-5 py-3 border-b border-border-base bg-surface-hover/40 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-content-secondary">选择要显示的账号</span>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setHiddenQuotaAccounts([])}
                          className="text-[11px] text-indigo-400 hover:text-indigo-300"
                        >
                          全选
                        </button>
                        <button
                          onClick={() =>
                            setHiddenQuotaAccounts((overview?.quota?.accounts || []).map((a) => a.account_id))
                          }
                          className="text-[11px] text-content-muted hover:text-content-primary"
                        >
                          全不选
                        </button>
                      </div>
                    </div>
                    {(overview?.quota?.accounts || []).length === 0 ? (
                      <div className="text-[11px] text-content-muted">尚无账号配额数据</div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {(overview?.quota?.accounts || []).map((a) => {
                          const shown = !hiddenQuotaAccounts.includes(a.account_id);
                          return (
                            <label
                              key={a.account_id}
                              className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border cursor-pointer transition-colors max-w-[220px] ${
                                shown
                                  ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-300"
                                  : "border-border-base text-content-muted"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={shown}
                                onChange={() =>
                                  setHiddenQuotaAccounts((prev) =>
                                    prev.includes(a.account_id)
                                      ? prev.filter((x) => x !== a.account_id)
                                      : [...prev, a.account_id]
                                  )
                                }
                                className="accent-indigo-500"
                              />
                              <span className="truncate">{a.alias}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                <div className="p-4 sm:p-5 flex-1">
                  {!overview ? (
                    <div className="flex justify-center py-8">
                      <RefreshCw className="w-5 h-5 animate-spin text-indigo-500" />
                    </div>
                  ) : (overview.quota.accounts || []).filter((a) => !hiddenQuotaAccounts.includes(a.account_id))
                      .length === 0 ? (
                    <div className="py-8 text-center text-content-muted text-sm">
                      没有可显示的账号（点右上「筛选」重新勾选）
                    </div>
                  ) : (
                    <div
                      key={overviewCols}
                      className={`ov-anim grid ${QUOTA_COL_CLASS[overviewCols] || QUOTA_COL_CLASS.auto} gap-3`}
                    >
                      {(overview.quota.accounts || [])
                        .filter((a) => !hiddenQuotaAccounts.includes(a.account_id))
                        .map((a) => {
                          const used = a.used || 0;
                          const total = a.total || 0;
                          const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
                          const barColor = a.error
                            ? "bg-border-base"
                            : pct >= 100
                            ? "bg-red-500"
                            : pct >= 70
                            ? "bg-amber-500"
                            : "bg-emerald-500";
                          const badge = a.error
                            ? { text: "未取到", cls: "text-content-muted" }
                            : a.available <= 0
                            ? { text: "已满", cls: "text-red-400" }
                            : { text: `剩 ${a.available}`, cls: "text-emerald-400" };
                          return (
                            <div
                              key={a.account_id}
                              className="bg-surface-hover border border-border-soft rounded-xl p-2.5 sm:p-3 min-w-0"
                            >
                              <div className="flex items-center justify-between gap-1.5">
                                <span
                                  className="text-[11px] sm:text-xs font-bold text-content-primary truncate"
                                  title={a.alias}
                                >
                                  {a.alias}
                                </span>
                                <span className={`text-[11px] flex-shrink-0 ${badge.cls}`}>{badge.text}</span>
                              </div>
                              <div className="text-[11px] text-content-muted mt-1.5">
                                已用 {used} / {total}
                              </div>
                              <div className="h-1 rounded-full bg-border-base mt-2 overflow-hidden">
                                <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              </section>

              {/* 最近注册 */}
              <div className="bg-surface border border-border-base rounded-2xl overflow-hidden flex flex-col">
                <div className="px-4 sm:px-5 py-3.5 border-b border-border-base flex items-center gap-2 flex-shrink-0">
                  <Activity className="w-4 h-4 text-indigo-400" />
                  <h3 className="font-bold text-content-primary text-sm">最近注册</h3>
                </div>
                <div className="divide-y divide-border-soft flex-1">
                  {dashboardStats.recent.length === 0 ? (
                    <div className="px-5 py-10 text-center text-content-muted text-sm">暂无数据</div>
                  ) : (
                    dashboardStats.recent.map((d) => (
                      /* NOTE: 手机上域名与账号别名各占一行 —— 挤在一行里两者都会被截断，
                         而这两个信息都要看（长别名在 390px 下会丢掉一半） */
                      <div
                        key={d.id}
                        className="px-4 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-2 hover:bg-hovered transition-colors"
                      >
                        <span className="font-mono text-xs sm:text-sm text-content-primary truncate min-w-0">
                          {d.full_domain}
                        </span>
                        <span className="text-[11px] sm:text-xs text-content-muted truncate min-w-0 sm:flex-shrink-0 sm:max-w-[35%]">
                          {d.account_alias}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════ 域名助力（并入自 dnshe-assist；按本面板设计语言重做，拆为三张卡） ═══════════ */}
        {activeTab === "assist" && (() => {
          /** 按当前筛选口径过滤某个账号下的域名 */
          const filterDomains = (ds: AssistDomain[]) =>
            ds.filter((d) =>
              assistFilter === "all" ? true : assistFilter === "upgraded" ? d.status === "upgraded" : d.status !== "upgraded"
            );

          /** 距离到期还有多少天（永久域名返回 null） */
          const daysLeft = (d: AssistDomain): number | null => {
            if (d.status === "upgraded") return null;
            if (!d.expires_at) return null;
            const t = new Date(d.expires_at).getTime();
            if (isNaN(t)) return null;
            return Math.max(0, Math.round((t - Date.now()) / 86400000));
          };

          const totals = assistAccounts.reduce(
            (acc, a) => {
              acc.remaining += a.helper_assist_remaining ?? 0;
              acc.limit += a.helper_assist_limit ?? 0;
              const ds = a.domains || [];
              acc.domains += ds.length;
              acc.upgraded += ds.filter((d) => d.status === "upgraded").length;
              return acc;
            },
            { remaining: 0, limit: 0, domains: 0, upgraded: 0 }
          );

          return (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-black text-content-primary flex items-center gap-2">
                    <Gift className="w-6 h-6 text-emerald-500" /> 域名助力
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  {assistUpdatedAt ? (
                    <span className="text-[11px] text-content-muted whitespace-nowrap">
                      更新于 {new Date(assistUpdatedAt).toLocaleString("zh-CN")}
                    </span>
                  ) : null}
                  <button
                    onClick={() => syncAssist()}
                    disabled={syncingAssist}
                    className="px-3 py-2 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white flex items-center gap-1.5 transition-colors"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${syncingAssist ? "animate-spin" : ""}`} />
                    {syncingAssist ? "同步中…" : "同步 DNSHE"}
                  </button>
                </div>
              </div>

              {/* 总览条 */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                {[
                  { label: "剩余助力", value: totals.remaining, cls: "text-emerald-400" },
                  { label: "总上限", value: totals.limit, cls: "text-content-primary" },
                  { label: "已永久化", value: totals.upgraded, cls: "text-indigo-400" },
                  { label: "托管域名", value: totals.domains, cls: "text-content-primary" },
                ].map((c) => (
                  <div key={c.label} className="glass-card rounded-2xl p-4 flex flex-col gap-1">
                    <span className="text-[11px] font-semibold text-content-muted uppercase tracking-wide">{c.label}</span>
                    <span className={`text-2xl font-black ${c.cls}`}>{c.value}</span>
                  </div>
                ))}
              </div>

              {/* 好友助力 */}
              <div className="bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Rocket className="w-4 h-4 text-emerald-400" />
                  <h3 className="font-bold text-content-primary text-sm">好友助力</h3>
                </div>
                <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                  <div className="flex-1 space-y-1.5 min-w-0">
                    <label className="text-xs font-semibold text-content-secondary">好友助力码</label>
                    <input
                      type="text"
                      value={assistCodeInput}
                      onChange={(e) => setAssistCodeInput(e.target.value)}
                      placeholder="粘贴好友的助力码"
                      className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                    />
                  </div>
                  <div className="w-full sm:w-28 space-y-1.5">
                    <label className="text-xs font-semibold text-content-secondary">使用账号数</label>
                    <input
                      type="number"
                      min={1}
                      max={15}
                      value={assistMaxAccounts}
                      onChange={(e) => setAssistMaxAccounts(parseInt(e.target.value, 10) || 1)}
                      className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary"
                    />
                  </div>
                  <button
                    onClick={() => {
                      // 与 triggerAssist 共用同一份候选构建逻辑，避免两边规则漂移
                      const built = buildAssistCandidates();
                      if (!built) {
                        showToast("warning", "助力码格式不正确（6-16 位字母数字）");
                        return;
                      }
                      const usable = built.usable.slice(0, assistMaxAccounts);
                      if (usable.length === 0) {
                        showToast("warning", "没有账号有可用助力额度，请先同步");
                        return;
                      }
                      setAssistExcluded([]);
                      setAssistConfirm(usable);
                    }}
                    disabled={assisting || !assistCodeInput.trim()}
                    className="px-4 py-2.5 rounded-lg text-sm font-bold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white flex items-center justify-center gap-2 transition-colors flex-shrink-0"
                  >
                    <Rocket className={`w-4 h-4 ${assisting ? "animate-pulse" : ""}`} />
                    {assisting ? "助力中…" : "触发助力"}
                  </button>
                </div>
                <p className="text-[11px] text-content-muted">
                  按剩余额度从高到低取前 N 个账号依次助力，每个消耗 1 次、单账号上限 15 次；触发前会先列出将使用的账号让你确认。
                </p>
                {assistResults.length > 0 && (
                  <div className="border-t border-border-soft pt-3 space-y-2">
                    <div className="text-xs font-semibold text-content-secondary">
                      本次助力明细
                      <span className="ml-2 text-content-muted font-normal">
                        成功 {assistResults.filter((r) => r.ok).length}/{assistResults.length}
                      </span>
                    </div>
                    {assistResults.map((r, i) => {
                      // 上游对「自己的号给自己的号」返回裸的 self_assist，翻译成人话
                      const isSelf = !r.ok && /self_assist/i.test(r.message);
                      const label = isSelf ? "本账号域名，已跳过" : r.ok ? "助力成功" : r.message;
                      return (
                        <div
                          key={i}
                          className={`flex items-center justify-between gap-3 text-xs px-3 py-2 rounded-lg border ${
                            r.ok
                              ? "border-emerald-500/25 bg-emerald-500/5"
                              : "border-border-base bg-elevated/60"
                          }`}
                        >
                          <span className="text-content-primary font-medium truncate min-w-0">{r.name}</span>
                          <span
                            className={`flex-shrink-0 inline-flex items-center gap-1 font-semibold ${
                              r.ok ? "text-emerald-500 dark:text-emerald-400" : isSelf ? "text-content-muted" : "text-amber-600 dark:text-amber-400"
                            }`}
                          >
                            {r.ok ? (
                              <><CheckCircle2 className="w-3.5 h-3.5" /> {label}</>
                            ) : (
                              <><X className="w-3.5 h-3.5" /> {label}</>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ────── 卡 1：账号助力额度（六列；窄屏按优先级裁列） ────── */}
              <div className="bg-surface border border-border-base rounded-2xl overflow-hidden">
                <div className="px-4 sm:px-5 py-3.5 border-b border-border-base flex items-center gap-2">
                  <Award className="w-4 h-4 text-indigo-400" />
                  <h3 className="font-bold text-content-primary text-sm">账号助力额度</h3>
                </div>
                {loadingAssist && assistAccounts.length === 0 ? (
                  <div className="flex justify-center py-12">
                    <RefreshCw className="w-5 h-5 animate-spin text-indigo-500" />
                  </div>
                ) : assistAccounts.length === 0 ? (
                  <div className="px-5 py-12 text-center text-content-muted text-sm">尚无助力数据，点右上「同步 DNSHE」从上游拉取</div>
                ) : (
                  <div className="overflow-x-auto">
                    {/* 窄屏裁列顺序（先消失的先写 hidden）：邀请奖励 → 使用进度 → 域名数/剩余额度 */}
                    <table className="w-full text-xs min-w-[420px] align-middle">
                      <thead>
                        {/* 对齐规则：首列靠左、末列靠右、中间各列「列头与列内容居中」 */}
                        <tr className="bg-surface-hover text-[11px] font-bold text-content-muted uppercase tracking-wide">
                          <th className="text-left px-4 sm:px-5 py-3">账号</th>
                          <th className="text-center px-3 py-3 hidden md:table-cell whitespace-nowrap">域名数 / 剩余额度</th>
                          <th className="text-center px-3 py-3 whitespace-nowrap">助力剩余/上限</th>
                          <th className="text-center px-3 py-3 hidden lg:table-cell whitespace-nowrap">使用进度</th>
                          <th className="text-center px-3 py-3 hidden xl:table-cell whitespace-nowrap">邀请奖励</th>
                          <th className="text-right px-4 sm:px-5 py-3">状态</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-soft">
                        {filteredAssistAccounts.map((a) => {
                          if (a.error) {
                            return (
                              <tr key={a.name}>
                                <td className="px-4 sm:px-5 py-3 font-bold text-content-primary truncate max-w-[180px]">{a.name}</td>
                                <td colSpan={4} className="px-3 py-3 text-red-400 text-center">{a.error}</td>
                                <td className="px-4 sm:px-5 py-3 text-right text-content-muted">—</td>
                              </tr>
                            );
                          }
                          const remaining = a.helper_assist_remaining ?? 0;
                          const limit = a.helper_assist_limit ?? 15;
                          const used = limit - remaining;
                          const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
                          const q = (a.quota || {}) as { available?: number; total?: number };
                          const domCount = (a.domains || []).length;
                          return (
                            <tr key={a.name} className="hover:bg-hovered transition-colors">
                              <td className="px-4 sm:px-5 py-3 font-bold text-content-primary truncate max-w-[180px]" title={a.name}>
                                {a.name}
                              </td>
                              <td className="px-3 py-3 text-content-secondary hidden md:table-cell whitespace-nowrap text-center">
                                域名 {domCount} 个 · 可注册 {q.available ?? 0}/{q.total ?? 0}
                              </td>
                              <td className="px-3 py-3 font-mono text-content-primary whitespace-nowrap text-center">
                                {remaining} / {limit}
                              </td>
                              <td className="px-3 py-3 hidden lg:table-cell">
                                <span className="flex items-center gap-2 w-[110px] mx-auto">
                                  <span className="flex-1 h-1.5 rounded-full bg-border-base overflow-hidden">
                                    <span
                                      className={`block h-full rounded-full ${
                                        pct >= 100 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500"
                                      }`}
                                      style={{ width: `${pct}%` }}
                                    />
                                  </span>
                                  <span className="text-[11px] text-content-muted w-8 text-right">{pct}%</span>
                                </span>
                              </td>
                              <td className="px-3 py-3 hidden xl:table-cell text-content-secondary whitespace-nowrap font-mono text-center">
                                {((a.quota || {}) as { invite_bonus?: number }).invite_bonus ?? 0} / {a.assist_required ?? 5}
                              </td>
                              <td className="px-4 sm:px-5 py-3 text-right whitespace-nowrap">
                                <span
                                  className={`text-[11px] px-1.5 py-0.5 rounded ${
                                    a.helper_limit_reached
                                      ? "bg-blue-500/15 text-blue-400"
                                      : remaining > 0
                                      ? "bg-emerald-500/15 text-emerald-400"
                                      : "bg-surface-hover text-content-muted"
                                  }`}
                                >
                                  {a.helper_limit_reached ? "已用满" : remaining > 0 ? "可用" : "未用"}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* ────── 卡 2：域名列表（未永久域名可生成助力码） ────── */}
              <div className="bg-surface border border-border-base rounded-2xl overflow-hidden">
                <div className="px-4 sm:px-5 py-3.5 border-b border-border-base flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4 text-indigo-400" />
                    <h3 className="font-bold text-content-primary text-sm">域名列表（未永久域名可生成助力码）</h3>
                  </div>
                  {/* 三态筛选
                      NOTE: 原来是 `flex ... flex-shrink-0` —— 窄屏父容器 flex-col 会把它拉满整行，
                      而按钮按内容宽度排，于是整体靠左、右侧一片空白（用户 2026-09-30 指出）。
                      改 grid-cols-3：窄屏三等分撑满；≥sm 容器宽度回到 auto，自动收缩成紧凑药丸组。 */}
                  <div className="grid grid-cols-3 gap-1 p-0.5 rounded-lg bg-surface-hover border border-border-soft sm:w-auto">
                    {([
                      { k: "all", label: "全部" },
                      { k: "eligible", label: "未永久域名" },
                      { k: "upgraded", label: "永久域名" },
                    ] as const).map((f) => (
                      <button
                        key={f.k}
                        onClick={() => setAssistFilter(f.k)}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-colors whitespace-nowrap ${
                          assistFilter === f.k ? "bg-indigo-600 text-white" : "text-content-muted hover:text-content-primary"
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="p-4 sm:p-5 space-y-6">
                  {assistAccounts.length === 0 ? (
                    <div className="py-10 text-center text-content-muted text-sm">尚无数据，点右上「同步 DNSHE」</div>
                  ) : (
                    filteredAssistAccounts.map((a) => {
                      const visible = filterDomains(a.domains || []);
                      if (visible.length === 0) return null;
                      const q = (a.quota || {}) as { available?: number; total?: number };
                      return (
                        <div key={a.name} className="space-y-3">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <span className="text-sm font-bold text-content-primary">{a.name}</span>
                            <span className="text-[11px] text-content-muted">
                              （{visible.length} 个域名 · 可注册 {q.available ?? 0}/{q.total ?? 0}）
                            </span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                            {visible.map((d) => {
                              const isUp = d.status === "upgraded";
                              const inProgress = d.status === "in_progress";
                              const left = daysLeft(d);
                              return (
                                <div
                                  key={d.id}
                                  className="bg-surface-hover border border-border-soft rounded-xl p-3 flex flex-col gap-2 min-w-0"
                                >
                                  <div className="font-mono text-xs text-content-primary font-bold truncate" title={d.domain}>
                                    {d.domain}
                                  </div>
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    {isUp ? (
                                      <>
                                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">已永久</span>
                                        <span className="text-[11px] text-content-muted">永久</span>
                                      </>
                                    ) : (
                                      <>
                                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">
                                          {inProgress ? "助力中" : "可升级"}
                                        </span>
                                        {d.expires_at ? (
                                          <span className="text-[11px] text-content-muted">
                                            {String(d.expires_at).slice(0, 10)}
                                            {left !== null ? ` (${left} 天)` : ""}
                                          </span>
                                        ) : null}
                                      </>
                                    )}
                                  </div>
                                  {isUp ? (
                                    <span className="text-[11px] text-emerald-400">已完成升级</span>
                                  ) : d.assist_code ? (
                                    <button
                                      onClick={() => copyToClipboard(d.assist_code || "", "助力码")}
                                      className="text-[11px] font-mono text-indigo-300 hover:text-indigo-200 flex items-center gap-1 w-fit"
                                      title="复制助力码发给好友"
                                    >
                                      {d.assist_code}
                                      <Copy className="w-3 h-3" />
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => generateAssistCode(a.account_id, d.id, d.domain)}
                                      className="text-[11px] px-2 py-1 rounded border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 transition-colors w-fit"
                                    >
                                      生成助力码
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* ────── 卡 3：最近助力记录（每页 10 条，可翻页） ────── */}
              {(() => {
                // DNSHE 上游返回的 counterpart/domain 自带星号脱敏；
                // 我们本地有「助力码 → 完整域名」「别名 → 账号」的权威映射，用它把能还原的都还原掉
                const codeToDomain = new Map<string, string>();
                for (const a of assistAccounts) {
                  for (const d of a.domains || []) {
                    if (d.assist_code) codeToDomain.set(d.assist_code.toUpperCase(), d.domain);
                  }
                }
                const unmaskDomain = (v: string, code: string) =>
                  v && !v.includes("*") ? v : codeToDomain.get(code) || v;
                const unmaskAccount = (v: string, domain: string) => {
                  if (!v || !v.includes("*")) return v;
                  // 打码的账号若对应自有账号的域名，就还原成自己的别名
                  const owner = assistAccounts.find((a) => (a.domains || []).some((d) => d.domain === domain));
                  return owner ? owner.name : v;
                };

                const byCode = new Map<string, { code: string; account: string; domain: string; count: number; ts: string }>();
                for (const a of assistAccounts) {
                  for (const l of a.assist_logs || []) {
                    if (l.role !== "assisted" || !l.assist_code) continue;
                    const k = l.assist_code.toUpperCase();
                    const e = byCode.get(k) || { code: k, account: "", domain: "", count: 0, ts: "" };
                    if (l.counterpart) e.account = l.counterpart;
                    if (l.domain) e.domain = l.domain;
                    e.count += 1;
                    if (l.created_at && l.created_at > e.ts) e.ts = l.created_at;
                    byCode.set(k, e);
                  }
                }
                const logs = [...byCode.values()]
                  .map((e) => {
                    const domain = unmaskDomain(e.domain, e.code);
                    return { ...e, domain, account: unmaskAccount(e.account, domain) };
                  })
                  .sort((x, y) => y.ts.localeCompare(x.ts));
                // 快照还没有日志时退回 KV 聚合历史（只有码/次数/时间）
                const rows = logs.length
                  ? logs
                  : assistHistory.map((h) => ({ code: h.assist_code, account: "", domain: "", count: Number(h.count || 1), ts: h.ts || "" }));

                const PAGE_SIZE = 10;
                const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
                const page = Math.min(assistLogPage, pageCount);
                const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

                return (
                  <div className="bg-surface border border-border-base rounded-2xl overflow-hidden">
                    <div className="px-4 sm:px-5 py-3.5 border-b border-border-base flex items-center gap-2">
                      <Activity className="w-4 h-4 text-indigo-400" />
                      <h3 className="font-bold text-content-primary text-sm">最近助力记录</h3>
                      <span className="text-[11px] text-content-muted">共 {rows.length} 条</span>
                    </div>
                    {slice.length === 0 ? (
                      <div className="px-5 py-8 text-center text-content-muted text-sm">
                        还没有助力记录 —— 用「好友助力」帮别人助力后，这里会出现每次助力的账号、域名与助力码
                      </div>
                    ) : (
                      <div className="divide-y divide-border-soft">
                        {slice.map((r, i) => (
                          <div key={`${r.code}-${i}`} className="px-4 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-3">
                            <span className="text-xs text-content-primary font-mono truncate min-w-0">
                              {r.account ? (
                                <>
                                  {r.account}
                                  <span className="text-content-muted px-1">→</span>
                                  <span className="text-indigo-400">{r.domain || "未知域名"}</span>
                                </>
                              ) : (
                                r.code
                              )}
                            </span>
                            <span className="text-[11px] text-content-muted truncate min-w-0 sm:flex-shrink-0">
                              <code className="text-content-secondary">{r.code}</code> · 助力 {r.count} 次
                            </span>
                            <span className="text-[11px] text-content-muted flex-shrink-0">
                              {r.ts ? new Date(r.ts).toLocaleString("zh-CN") : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {pageCount > 1 && (
                      <div className="px-4 sm:px-5 py-2.5 border-t border-border-soft flex items-center justify-between">
                        <button
                          onClick={() => setAssistLogPage((p) => Math.max(1, p - 1))}
                          disabled={page <= 1}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-border-base text-content-secondary hover:text-content-primary disabled:opacity-40 transition-colors"
                        >
                          上一页
                        </button>
                        <span className="text-[11px] text-content-muted">
                          第 {page} / {pageCount} 页
                        </span>
                        <button
                          onClick={() => setAssistLogPage((p) => Math.min(pageCount, p + 1))}
                          disabled={page >= pageCount}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-border-base text-content-secondary hover:text-content-primary disabled:opacity-40 transition-colors"
                        >
                          下一页
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}
              {/* 助力确认弹窗
                  不再用 window.confirm：原生弹窗是一块灰色系统框，跟整体视觉完全脱节，
                  也放不下「剔除某个账号」这种交互。这里是应用内模态框，与设置页/编辑框同一套样式。 */}
              {assistConfirm && (
                /* 移动端贴底抽屉（手机上居中小窗点不到、键盘一弹就出屏），桌面仍居中 */
                <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-slate-950/60 backdrop-blur-sm">
                  <div className="bg-surface border border-border-base w-full max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden drawer-anim max-h-[90vh] sm:max-h-none flex flex-col">
                    <div className="px-5 py-4 border-b border-border-base flex-shrink-0">
                      <h3 className="font-bold text-content-primary text-base">确认助力</h3>
                      <p className="text-xs text-content-muted mt-1">
                        助力码 <span className="font-mono text-content-primary">{assistCodeInput.trim().toUpperCase()}</span>
                        {' · 将使用 '}
                        <span className="text-content-primary font-bold">
                          {assistConfirm.filter((a) => !assistExcluded.includes(a.name)).length}
                        </span>
                        {' 个账号'}
                      </p>
                    </div>
                    <div className="px-5 py-4 space-y-2.5 overflow-y-auto flex-1 min-h-0">
                      <div className="text-xs font-semibold text-content-secondary">参与助力的账号（点击可剔除）</div>
                      {assistConfirm.map((a) => {
                        const on = !assistExcluded.includes(a.name);
                        return (
                          <label
                            key={a.name}
                            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                              on ? "border-indigo-500/40 bg-indigo-500/5" : "border-border-base opacity-55"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() =>
                                setAssistExcluded((p) => (on ? [...p, a.name] : p.filter((x) => x !== a.name)))
                              }
                              className="accent-indigo-500 w-4 h-4"
                            />
                            <span className="flex-1 min-w-0 text-xs text-content-primary truncate">{a.name}</span>
                            <span className="text-[11px] text-content-muted flex-shrink-0">剩余 {a.helper_assist_remaining} 次</span>
                          </label>
                        );
                      })}
                      <p className="text-[11px] text-content-muted leading-relaxed pt-1">
                        共消耗 {assistConfirm.filter((a) => !assistExcluded.includes(a.name)).length} 次助力额度，确认后不可撤销。
                        若这个助力码对应的域名本就是你自己某个账号注册的，请把那个账号取消勾选 ——
                        DNSHE 不允许「自己的号给自己的号助力」，留着它只会白白失败一次。
                      </p>
                    </div>
                    <div className="px-5 py-4 border-t border-border-base flex items-center justify-end gap-2.5 flex-shrink-0">
                      <button
                        onClick={() => setAssistConfirm(null)}
                        className="flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-semibold border border-border-base text-content-secondary hover:text-content-primary transition-colors"
                      >
                        取消
                      </button>
                      <button
                        onClick={async () => {
                          // 弹窗里记的是账号名，发给后端要用 id（后端按 acc.id 剔除）
                          const excludedIds = assistConfirm
                            .filter((a) => assistExcluded.includes(a.name))
                            .map((a) => a.account_id);
                          setAssistConfirm(null);
                          await triggerAssist(excludedIds);
                        }}
                        disabled={assisting || assistConfirm.filter((a) => !assistExcluded.includes(a.name)).length === 0}
                        className="flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-bold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition-colors flex items-center justify-center gap-1.5"
                      >
                        <Rocket className={`w-4 h-4 ${assisting ? "animate-pulse" : ""}`} />
                        {assisting ? "助力中…" : "确认助力"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

            </div>
          );
        })()}

        {/* ═══════════ API 密钥管理（并入自 aloneio/DNSHE-Panel，并补上 Secret 持久化） ═══════════ */}
        {activeTab === "apikeys" && (() => {
          const allKeys = apiKeyView === "all"
            ? apiKeyGroups.flatMap((g) => g.keys)
            : apiKeys;

          /**
           * 渲染一条密钥
           * 桌面：一行七列（表头在列表上方统一给）
           * 移动：四行 —— ①名称在左/状态在右 ②API Key 独占 ③API Secret 独占 ④请求次数在左/最后使用在右
           *       （上游那种「全部字段各占一行」在 390px 下会把单条撑到 300px 高，列表根本翻不动）
           */
          const renderKey = (k: ApiKeyRow, accountId: number, alias: string, showAlias: boolean) => {
            const revealed = revealedSecrets[k.api_key];
            const statusCls =
              k.status === "active"
                ? "bg-emerald-500/15 text-emerald-400"
                : k.status && k.status.includes("上游已不存在")
                ? "bg-surface-hover text-content-muted"
                : "bg-amber-500/15 text-amber-400";

            // 密钥名以 DNSHE 侧为准：上游 keys 只有 list/create/regenerate/delete，没有改名接口，
            // 因此不提供任何本地改名入口（曾经的铅笔编辑控件已移除）。
            const nameBlock = (
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs sm:text-sm font-bold text-content-primary truncate">{k.key_name || "（未命名）"}</span>
                {showAlias ? (
                  <span className="text-[11px] text-content-muted truncate hidden xl:inline">{alias}</span>
                ) : null}
              </div>
            );

            const secretBlock = k.has_secret ? (
              <div className="flex items-center gap-1.5 min-w-0">
                <code className="font-mono text-[11px] text-content-primary truncate">{revealed || "••••••••••••"}</code>
                <button onClick={() => revealSecret(accountId, k.api_key)} className="p-1 rounded text-indigo-400 hover:text-indigo-300 flex-shrink-0" title={revealed ? "隐藏" : "显示 Secret"}>
                  {revealed ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </button>
                {revealed ? (
                  <button onClick={() => copyToClipboard(revealed, "API Secret")} className="p-1 rounded text-content-muted hover:text-content-primary flex-shrink-0" title="复制 Secret">
                    <Copy className="w-3 h-3" />
                  </button>
                ) : null}
              </div>
            ) : (
              <span className="text-[11px] text-content-muted">未保存 · 需重新生成</span>
            );

            const actions = (
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    if (k.key_id === null) {
                      showToast("warning", "该密钥在上游已不存在，无法重置");
                      return;
                    }
                    if (!window.confirm(`重置「${k.key_name}」的 Secret？\n\n旧 Secret 立即失效；如果这正是本账号的绑定凭据，面板会自动把新值同步回账号配置。`)) return;
                    const r = await callKeyAction(accountId, { action: "regenerate", key_id: k.key_id }, "Secret 已重置并加密保存");
                    if (r) {
                      setFreshKey({ key_name: r.key_name, api_key: r.api_key, api_secret: r.api_secret });
                      if (r.bound_synced) showToast("success", "该密钥是本账号的绑定凭据，已自动同步回账号配置");
                      await fetchApiKeys(undefined, "force");
                    }
                  }}
                  className="text-[11px] px-2 py-1.5 rounded border border-border-base text-content-muted hover:text-content-primary transition-colors"
                >
                  重新生成
                </button>
                <button
                  onClick={async () => {
                    if (k.key_id !== null && !window.confirm(`删除密钥「${k.key_name}」？\n\n使用该密钥的程序会立即失去访问权限，此操作不可撤销。`)) return;
                    const ok = await callKeyAction(
                      accountId,
                      { action: "delete", key_id: k.key_id ?? -1, api_key: k.api_key },
                      k.key_id === null ? "已清理本地登记" : "密钥已删除"
                    );
                    if (ok) await fetchApiKeys(undefined, "force");
                  }}
                  className="text-[11px] px-2 py-1.5 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  删除
                </button>
              </div>
            );

            return (
              <div key={`${accountId}-${k.api_key}`} className="lg:grid lg:grid-cols-[1.2fr_1.7fr_1.7fr_1fr] xl:grid-cols-[1.1fr_1.5fr_1.5fr_0.6fr_0.8fr_1fr_1fr] lg:gap-3 lg:items-center px-4 sm:px-5 py-3.5 border-b border-border-soft last:border-b-0">
                {/* ── 移动端：四行 ── */}
                <div className="lg:hidden space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">{nameBlock}</div>
                    <span className={`text-[11px] px-1.5 py-0.5 rounded flex-shrink-0 ${statusCls}`}>{k.status || "未知"}</span>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <code className="font-mono text-[11px] text-content-secondary truncate flex-1 min-w-0">{k.api_key}</code>
                      <button onClick={() => copyToClipboard(k.api_key, "API Key")} className="p-1 rounded text-content-muted hover:text-content-primary flex-shrink-0" title="复制 API Key">
                        <Copy className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  <div className="min-w-0">{secretBlock}</div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-content-muted">
                      请求 <span className="text-content-primary font-mono">{k.request_count ?? "-"}</span>
                    </span>
                    <span className="text-[11px] text-content-muted truncate">
                      最后使用 <span className="text-content-secondary">{k.last_used_at || "从未"}</span>
                    </span>
                  </div>
                  <div className="pt-0.5">{actions}</div>
                </div>

                {/* ── 桌面端：七列（§12 —— 首列靠左、末列靠右、其余列头与内容一律居中）── */}
                <div className="hidden lg:block min-w-0">{nameBlock}</div>
                <div className="hidden lg:flex items-center justify-center gap-1.5 min-w-0">
                  <code className="font-mono text-[11px] text-content-secondary truncate">{k.api_key}</code>
                  <button onClick={() => copyToClipboard(k.api_key, "API Key")} className="p-1 rounded text-content-muted hover:text-content-primary flex-shrink-0" title="复制 API Key">
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
                <div className="hidden lg:flex justify-center min-w-0">{secretBlock}</div>
                <div className="hidden xl:block text-center">
                  <span className={`text-[11px] px-1.5 py-0.5 rounded inline-block ${statusCls}`}>{k.status || "未知"}</span>
                </div>
                <div className="hidden xl:block text-xs text-content-primary font-mono text-center">{k.request_count ?? "-"}</div>
                <div className="hidden xl:block text-[11px] text-content-secondary truncate text-center">{k.last_used_at || "从未使用"}</div>
                <div className="hidden lg:flex justify-end">{actions}</div>
              </div>
            );
          };

          return (
            <div className="space-y-6">
              {/* §14：标题独占一行；控件行 = 账号选择框(flex-1 撑满) + 刷新 + 创建密钥 */}
              <div className="flex items-center gap-2">
                <h2 className="text-2xl font-black text-content-primary flex items-center gap-2">
                  <Lock className="w-6 h-6 text-indigo-500" /> API 密钥
                </h2>
                {refreshingApiKeys && (
                  <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/30">
                    <RefreshCw className="w-3 h-3 animate-spin" /> 更新中
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={apiKeyView === "all" ? "all" : String(apiKeyView)}
                  onChange={(e) => setApiKeyView(e.target.value === "all" ? "all" : parseInt(e.target.value, 10))}
                  className="form-input flex-1 min-w-0 text-sm px-3 h-10 rounded-lg"
                  aria-label="选择账号"
                >
                  <option value="all">全部账号</option>
                  {dnsheAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.alias}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => fetchApiKeys(undefined, "force")}
                  disabled={loadingApiKeys}
                  className="h-10 w-10 flex items-center justify-center rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-colors flex-shrink-0"
                  title="刷新"
                >
                  <RefreshCw className={`w-4 h-4 ${loadingApiKeys ? "animate-spin" : ""}`} />
                </button>
                <button
                  onClick={() => {
                    setNewKeyName("");
                    setNewKeyIpWhitelist("");
                    setNewKeyAccountId(apiKeyView === "all" ? (dnsheAccounts[0]?.id ?? null) : apiKeyView);
                    setShowCreateKey(true);
                  }}
                  disabled={dnsheAccounts.length === 0}
                  className="px-3 h-10 rounded-lg text-sm font-bold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white flex items-center gap-1.5 transition-colors flex-shrink-0 whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" /> 创建密钥
                </button>
              </div>

              {/* 创建表单（内联展开；移动端两个输入框左右均分一行） */}
              {showCreateKey && (
                <div className="drawer-anim bg-surface border border-indigo-500/40 rounded-2xl p-4 sm:p-5 space-y-4">
                  <h3 className="font-bold text-content-primary text-sm flex items-center gap-2">
                    <Plus className="w-4 h-4 text-indigo-400" /> 创建 API 密钥
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-content-secondary">归属账号</label>
                      <select
                        value={newKeyAccountId ?? ""}
                        onChange={(e) => setNewKeyAccountId(parseInt(e.target.value, 10) || null)}
                        className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary"
                      >
                        {dnsheAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.alias}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-content-secondary">密钥名称</label>
                      <input
                        type="text"
                        value={newKeyName}
                        onChange={(e) => setNewKeyName(e.target.value)}
                        placeholder="例如：CC 面板只读"
                        className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-content-secondary">IP 白名单（可选）</label>
                      <input
                        type="text"
                        value={newKeyIpWhitelist}
                        onChange={(e) => setNewKeyIpWhitelist(e.target.value)}
                        placeholder="逗号分隔，留空不限制"
                        className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-content-muted">
                    Secret 只在创建当次由上游返回一次；本面板会立刻加密保存，之后可随时「显示」或复制。
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={async () => {
                        if (!newKeyAccountId) {
                          showToast("warning", "请选择归属账号");
                          return;
                        }
                        if (!newKeyName.trim()) {
                          showToast("warning", "请填写密钥名称");
                          return;
                        }
                        const r = await callKeyAction(
                          newKeyAccountId,
                          { action: "create", key_name: newKeyName.trim(), ip_whitelist: newKeyIpWhitelist.trim() },
                          "密钥创建成功，Secret 已加密保存"
                        );
                        if (r) {
                          setFreshKey({ key_name: r.key_name, api_key: r.api_key, api_secret: r.api_secret });
                          setShowCreateKey(false);
                          await fetchApiKeys(undefined, "force");
                        }
                      }}
                      className="px-4 py-2 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                    >
                      确认创建
                    </button>
                    <button
                      onClick={() => setShowCreateKey(false)}
                      className="px-4 py-2 rounded-lg text-xs font-bold border border-border-base text-content-muted hover:text-content-primary transition-colors"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}

              {/* 刚创建 / 重置出来的明文：这是最容易丢失的时刻，做成醒目的绿色卡 */}
              {freshKey && (
                <div className="drawer-anim bg-emerald-500/10 border border-emerald-500/40 rounded-2xl p-4 sm:p-5 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-bold text-emerald-400 text-sm flex items-center gap-2 min-w-0">
                      <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                      <span className="truncate">{freshKey.key_name} · 已加密保存到本面板</span>
                    </h3>
                    <button onClick={() => setFreshKey(null)} className="text-content-muted hover:text-content-primary flex-shrink-0" title="关闭">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="space-y-2">
                    {[
                      { label: "API Key", value: freshKey.api_key },
                      { label: "API Secret", value: freshKey.api_secret || "(上游未返回 Secret)" },
                    ].map((row) => (
                      <div key={row.label} className="flex items-center gap-2">
                        <span className="text-[11px] text-content-muted w-20 flex-shrink-0">{row.label}</span>
                        <code className="flex-1 min-w-0 font-mono text-[11px] text-content-primary break-all">{row.value}</code>
                        <button onClick={() => copyToClipboard(row.value, row.label)} className="p-1.5 rounded-md text-emerald-400 hover:bg-emerald-500/10 flex-shrink-0" title={`复制 ${row.label}`}>
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 密钥列表 */}
              <div className="bg-surface border border-border-base rounded-2xl overflow-hidden">
                {loadingApiKeys && allKeys.length === 0 ? (
                  <div className="flex justify-center py-12">
                    <RefreshCw className="w-5 h-5 animate-spin text-indigo-500" />
                  </div>
                ) : apiKeyView === "all" ? (
                  apiKeyGroups.length === 0 ? (
                    <div className="px-5 py-12 text-center text-content-muted text-sm">
                      {dnsheAccounts.length === 0 ? "还没有 DNSHE 账号，请先去「账号管理」添加" : "没有可显示的账号"}
                    </div>
                  ) : (
                    <div className="space-y-4 p-4 sm:p-5">
                      {filteredKeyGroups.map((g) => {
                        const open = expandedKeyAccounts.includes(g.account_id);
                        return (
                          <div
                            key={g.account_id}
                            /* 每个账号自成一张卡：原先用 divide-y 的细线分隔几乎看不见，
                               用户要的是像「域名列表 / 账号管理」那样有明显边界的分组 */
                            className="bg-surface border border-border-base rounded-2xl overflow-hidden shadow-sm"
                          >
                            <button
                              onClick={() =>
                                setExpandedKeyAccounts((prev) =>
                                  prev.includes(g.account_id) ? prev.filter((x) => x !== g.account_id) : [...prev, g.account_id]
                                )
                              }
                              className="w-full px-4 sm:px-5 py-3.5 flex items-center gap-3 text-left hover:opacity-90 transition-opacity"
                            >
                              {open ? <ChevronDown className="w-4 h-4 text-indigo-400 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-indigo-400 flex-shrink-0" />}
                              <Key className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                              <span className="text-xs sm:text-sm font-bold text-indigo-700 dark:text-indigo-300 truncate flex-1 min-w-0">{g.alias}</span>
                              {g.error ? (
                                <span className="text-[11px] text-red-400 flex-shrink-0">{g.error}</span>
                              ) : (
                                <>
                                  <span className="text-[11px] text-content-muted flex-shrink-0">{g.keys.length} 把密钥</span>
                                  <span className="text-[11px] text-emerald-400 flex-shrink-0 hidden sm:inline">
                                    {g.keys.filter((k) => k.has_secret).length} 把有 Secret
                                  </span>
                                </>
                              )}
                            </button>
                            {open && !g.error ? (
                              g.keys.length === 0 ? (
                                <div className="px-4 sm:px-5 pb-5 text-[11px] text-content-muted">该账号下没有 API 密钥</div>
                              ) : (
                                <div className="expand-anim border-t border-border-base bg-surface">
                                  {/* 每个分组自带表头：分组可折叠，表头跟着走才不用回滚到页首看列名 */}
                                  <div className="hidden lg:grid lg:grid-cols-[1.2fr_1.7fr_1.7fr_1fr] xl:grid-cols-[1.1fr_1.5fr_1.5fr_0.6fr_0.8fr_1fr_1fr] lg:items-center gap-3 px-4 sm:px-5 py-2.5 bg-surface-hover border-b border-border-base text-[11px] font-bold text-content-muted uppercase tracking-wide">
                                    <span className="text-left">名称</span>
                                    <span className="text-center">API Key</span>
                                    <span className="text-center">API Secret</span>
                                    <span className="hidden xl:block text-center">状态</span>
                                    <span className="hidden xl:block text-center">请求数</span>
                                    <span className="hidden xl:block text-center">最后使用</span>
                                    <span className="text-right">操作</span>
                                  </div>
                                  {g.keys.map((k) => renderKey(k, g.account_id, g.alias, false))}
                                </div>
                              )
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )
                ) : apiKeys.length === 0 ? (
                  <div className="px-5 py-12 text-center text-content-muted text-sm">该账号下没有 API 密钥</div>
                ) : (
                  <div className="divide-y divide-border-soft">
                    <div className="hidden lg:grid lg:grid-cols-[1.2fr_1.7fr_1.7fr_1fr] xl:grid-cols-[1.1fr_1.5fr_1.5fr_0.6fr_0.8fr_1fr_1fr] lg:items-center gap-3 px-4 sm:px-5 py-2.5 bg-surface-hover border-b border-border-base text-[11px] font-bold text-content-muted uppercase tracking-wide">
                      <span className="text-left">名称</span>
                      <span className="text-center">API Key</span>
                      <span className="text-center">API Secret</span>
                      <span className="hidden xl:block text-center">状态</span>
                      <span className="hidden xl:block text-center">请求数</span>
                      <span className="hidden xl:block text-center">最后使用</span>
                      <span className="text-right">操作</span>
                    </div>
                    {filteredApiKeys.map((k) => renderKey(k, apiKeyView as number, "", false))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Tab 5: 域名注册与查重 */}
        {activeTab === "register" && (
          <div className="space-y-6">
            
            {/* 模式选择导航 */}
            {/* 手机上也保持左右均分 —— 两个入口是对等关系，叠成上下两行会多占一倍高度 */}
            <div className="grid grid-cols-2 gap-2 bg-surface p-1.5 rounded-2xl border border-border-base">
              <button
                onClick={() => setRegMode("single")}
                className={`flex-1 py-3 text-sm font-bold rounded-xl transition-all flex items-center justify-center gap-2 ${
                  regMode === "single"
                    ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20"
                    : "text-content-muted hover:text-content-primary hover:bg-hovered"
                }`}
              >
                <Search className="w-4 h-4" /> 精准单域名查重
              </button>
              <button
                onClick={() => setRegMode("batch")}
                className={`flex-1 py-3 text-sm font-bold rounded-xl transition-all flex items-center justify-center gap-2 ${
                  regMode === "batch"
                    ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20"
                    : "text-content-muted hover:text-content-primary hover:bg-hovered"
                }`}
              >
                <Sparkles className="w-4 h-4 text-amber-400" /> 规则多域名查重
              </button>
            </div>

            {/* 模式 A: 精准单域名查重卡片 */}
            {regMode === "single" && (
              <div className="space-y-6">
                {/* 1. 单域名 WHOIS 查重表单卡片 */}
                <div className="bg-surface border border-border-base rounded-2xl p-6 shadow-xl space-y-6">
                  <div>
                    <h3 className="text-lg font-bold text-content-primary flex items-center gap-2">
                      <Search className="w-5 h-5 text-indigo-400" /> 单精准域名 WHOIS 查重与注册
                    </h3>
                    <p className="text-xs text-content-muted mt-1">
                      输入您心仪的二级前缀，选择 9 大免费根域名之一，实时检测域名注册状态及 WHOIS 到期详细信息。
                    </p>
                  </div>

                  <form onSubmit={handleCheckWhois} className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-end">
                    <div className="sm:col-span-6 space-y-2">
                      <label className="block text-xs font-semibold text-content-secondary">
                        二级域名前缀:
                      </label>
                      <input
                        type="text"
                        placeholder="例如: myapp 或 中文域名"
                        value={searchSubdomain}
                        onChange={(e) => setSearchSubdomain(e.target.value)}
                        className="w-full bg-elevated border border-border-base focus:border-indigo-500 rounded-xl px-4 h-10 text-sm text-content-primary placeholder-content-muted focus:outline-none"
                      />
                    </div>

                    <div className="sm:col-span-3 space-y-2">
                      <label className="block text-xs font-semibold text-content-secondary">
                        根域名后缀:
                      </label>
                      <select
                        value={searchRootdomain}
                        onChange={(e) => setSearchRootdomain(e.target.value)}
                        className="w-full bg-elevated border border-border-base focus:border-indigo-500 rounded-xl px-4 h-10 text-sm text-content-primary focus:outline-none"
                      >
                        {allRootDomains.map((rd) => (
                          <option key={rd} value={rd}>
                            .{rd}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="sm:col-span-3">
                      <button
                        type="submit"
                        disabled={whoisLoading}
                        /* whitespace-nowrap：列宽不足以换行时按钮会被撑成两行、比旁边的输入框高一截
                           —— 同一行控件必须等高（§11），宁可字号收缩也不换行 */
                        className="w-full whitespace-nowrap bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm px-4 h-10 rounded-xl transition-all shadow-lg flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        <Search className={`w-4 h-4 flex-shrink-0 ${whoisLoading ? "animate-spin" : ""}`} />
                        {whoisLoading ? "正在查询..." : "WHOIS 查重"}
                      </button>
                    </div>
                  </form>

                  {/* 中文前缀实时 Punycode 预览（置于表单外，避免撑乱 grid 行高） */}
                  {hasNonASCII(searchSubdomain) && (
                    <p className="text-[11px] text-indigo-400 -mt-2 font-mono">
                      将以 Punycode 提交：<span className="font-bold">{toASCII(searchSubdomain.trim())}.{searchRootdomain}</span>
                    </p>
                  )}
                </div>

                {/* 2. WHOIS 查询结果展示 */}
                {whoisResult && (
                  <div>
                    {!whoisResult.registered ? (
                      /* 未注册：绿色可注册卡片 */
                      <div className="bg-surface border border-emerald-500/30 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border-base pb-4">
                          <div className="min-w-0">
                            <span className="inline-block bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/80 dark:text-emerald-400 dark:border-emerald-900/60 text-xs font-bold px-2.5 py-1 rounded-full mb-1">
                              尚未注册
                            </span>
                            <h4 className="text-lg sm:text-xl font-bold text-content-primary break-all">
                              {whoisResult.searchedDomain}
                            </h4>
                          </div>
                          <div className="text-emerald-400 text-xs sm:text-sm font-semibold flex items-start sm:items-center gap-1 min-w-0">
                            <CheckCircle2 className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0 mt-0.5 sm:mt-0" />
                            该域名目前仍处于未注册状态，可以立即在线注册！
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 items-end">
                          <div className="space-y-2">
                            <label className="block text-xs font-semibold text-content-secondary">
                              选择注册的目标账号:
                            </label>
                            <select
                              value={registerAccountId}
                              onChange={(e) => setRegisterAccountId(Number(e.target.value))}
                              className="w-full bg-elevated border border-border-base focus:border-indigo-500 rounded-xl px-4 h-10 text-sm text-content-primary focus:outline-none"
                            >
                              {dnsheAccounts.length === 0 ? (
                                <option value="">暂无可用的绑定账号</option>
                              ) : (
                                dnsheAccounts.map((acc) => (
                                  <option key={acc.id} value={acc.id}>
                                    {acc.alias} (ID: {acc.id})
                                  </option>
                                ))
                              )}
                            </select>
                          </div>

                          <div>
                            <button
                              onClick={handleRegisterSubdomain}
                              disabled={actionLoading === "register-subdomain" || dnsheAccounts.length === 0}
                              className="w-full bg-emerald-600 hover:bg-emerald-500 border border-transparent text-white font-bold text-sm px-6 h-10 rounded-xl transition-all shadow-lg flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Plus className="w-4 h-4" />
                              {actionLoading === "register-subdomain" ? "正在注册中..." : "一键注册该域名"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* 已被注册：红色提示卡片 */
                      <div className="bg-surface border border-red-500/30 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border-base pb-4">
                          <div className="min-w-0">
                            <span className="inline-block bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/80 dark:text-red-400 dark:border-red-900/60 text-xs font-bold px-2.5 py-1 rounded-full mb-1">
                              已被注册
                            </span>
                            <h4 className="text-lg sm:text-xl font-bold text-content-secondary break-all">
                              {whoisResult.searchedDomain}
                            </h4>
                          </div>
                          <div className="text-red-400 text-xs sm:text-sm font-semibold flex items-center gap-1 flex-shrink-0">
                            <AlertTriangle className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />
                            已被他人抢先注册
                          </div>
                        </div>

                        {/* WHOIS 详细数据表 */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs pt-2">
                          <div className="bg-elevated p-3 rounded-lg border border-border-base">
                            <span className="text-content-muted">注册时间：</span>
                            <span className="text-content-secondary font-medium ml-1">{whoisResult.registered_at || "保密 / 未公开"}</span>
                          </div>
                          <div className="bg-elevated p-3 rounded-lg border border-border-base">
                            <span className="text-content-muted">到期时间：</span>
                            <span className="text-content-secondary font-medium ml-1">{whoisResult.expires_at || "保密 / 未公开"}</span>
                          </div>
                          <div className="bg-elevated p-3 rounded-lg border border-border-base sm:col-span-2">
                            <span className="text-content-muted">当前 NS 域名服务器：</span>
                            <span className="text-content-secondary font-medium ml-1">
                              {Array.isArray(whoisResult.nameservers) ? whoisResult.nameservers.join(", ") : "系统默认 NS"}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 模式 B: 规则多域名查重控制台 */}
            {regMode === "batch" && (
              <div className="space-y-6">
                
                {/* 规则与生成配置卡片 */}
                <div className="bg-surface border border-border-base rounded-2xl p-6 shadow-xl space-y-6">
                  
                  {/* 1. 生成规则输入框 */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-baseline flex-wrap gap-x-2 gap-y-1 min-w-0">
                        <label className="block text-sm font-semibold text-content-secondary shrink-0">
                          生成规则:
                        </label>
                        {/* 组合数预估：由各槽位大小相乘得出，不实际生成。
                            放在标题行而非输入框下方 —— 标题行本就有横向留白，不额外占高度。 */}
                        {rulePreview.parsed.unknownTokens.length > 0 ? (
                          <span className="text-xs text-red-400 flex items-center gap-1.5 min-w-0">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">
                              无法识别的标签：{rulePreview.parsed.unknownTokens.join("、")}
                            </span>
                          </span>
                        ) : rulePreview.emptiedByExclude ? (
                          <span className="text-xs text-amber-400 flex items-center gap-1.5 min-w-0">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">
                              排除字符「{excludeChars.trim()}」把某一位的候选全滤掉了，组合数为 0
                            </span>
                          </span>
                        ) : rulePreview.total > 0 ? (
                          <span className="text-xs text-content-muted flex items-center gap-1.5">
                            <Info className="w-3.5 h-3.5 shrink-0 text-indigo-400" />
                            当前规则穷举将会产生
                            <span className="text-red-400 font-bold">
                              {rulePreview.total.toLocaleString()}
                            </span>
                            条域名组合
                          </span>
                        ) : null}
                      </div>
                      <button
                        onClick={() => {
                          setBatchRules("");
                          showToast("info", "已清空生成规则");
                        }}
                        disabled={!batchRules}
                        className="shrink-0 text-xs font-semibold text-content-muted hover:text-red-700 border border-border-base hover:border-red-300 bg-elevated hover:bg-red-50 dark:hover:text-red-400 dark:hover:border-red-500/40 dark:hover:bg-red-950/30 px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        一键清空
                      </button>
                    </div>
                    <div className="flex items-center h-10 bg-elevated border border-border-base rounded-xl px-4 focus-within:border-indigo-500 transition-colors">
                      <input
                        type="text"
                        value={batchRules}
                        onChange={(e) => setBatchRules(e.target.value)}
                        placeholder="例如: {字母}{字母}{字母} 或 my{字母}{数字}，也可直接填 myapp, test123"
                        className="w-full h-full bg-transparent text-content-primary text-sm focus:outline-none"
                      />
                      <span className="text-xs text-indigo-400 font-bold whitespace-nowrap px-2">
                        {rulePreview.parsed.unknownTokens.length > 0
                          ? "⚠ 标签无法识别"
                          : rulePreview.emptiedByExclude
                            ? "⚠ 已被排除字符清空"
                            : rulePreview.total > 0
                              ? "ⓘ 规则就绪"
                              : "ⓘ 待输入规则"}
                      </span>
                    </div>

                    {/* 超限与耗时警告：偶发且文字较长，留在输入框下方，不挤占标题行 */}
                    {rulePreview.total > 0 &&
                      (rulePreview.total > MAX_PREFIXES ||
                        (selectedRoots.length > 0 && rulePreview.total > 5000)) && (
                        <p className="text-xs text-amber-400 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          {rulePreview.total > MAX_PREFIXES && (
                            <span>超出上限，仅处理前 {MAX_PREFIXES.toLocaleString()} 条。</span>
                          )}
                          {selectedRoots.length > 0 && rulePreview.total > 5000 && (
                            <span>
                              按当前 {dnsheAccounts.length || 1} 个账号 × {selectedRoots.length} 个后缀估算，
                              约需 {formatDuration(rulePreview.estSeconds)}，建议改用顺序模式配合断点续查
                            </span>
                          )}
                        </p>
                      )}
                  </div>

                  {/* 2. 排除字符与长度 */}
                  <div className="flex flex-col md:flex-row md:items-start gap-4">
                    <div className="flex-1 min-w-0 space-y-2">
                      {/* 不要给说明文字锁高度：390px 下这段说明要占两行，锁了就会被输入框盖住 */}
                      <label className="block text-xs font-semibold text-content-muted leading-5">
                        排除字符 (可选，若域名中出现定义的字符，则忽略):
                      </label>
                      <input
                        type="text"
                        value={excludeChars}
                        onChange={(e) => setExcludeChars(e.target.value)}
                        placeholder="例如 01ol 避免字符易混淆 (可选)"
                        className="w-full bg-elevated border border-border-base rounded-xl px-4 h-10 text-content-primary text-sm focus:border-indigo-500 focus:outline-none"
                      />
                    </div>
                    <div className="w-full md:w-[19rem] shrink-0 space-y-2">
                      {/* 提示放在标题行：与左列标题同高，不撑高行、不影响两列输入框对齐 */}
                      <div className="flex items-baseline gap-2 h-4 leading-4">
                        <label className="block text-xs font-semibold text-content-muted shrink-0">
                          生成组合长度:
                        </label>
                        {rulePreview.isBraceSyntax && (
                          <span className="text-[11px] text-content-muted/70 truncate">
                            花括号规则由标签数量决定长度，此项不生效
                          </span>
                        )}
                      </div>
                      <select
                        value={batchLength}
                        onChange={(e) => setBatchLength(Number(e.target.value))}
                        disabled={rulePreview.isBraceSyntax}
                        className="w-full bg-elevated border border-border-base rounded-xl px-4 h-10 text-content-primary text-sm focus:border-indigo-500 focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
                        title={
                          rulePreview.isBraceSyntax
                            ? "花括号规则由标签数量决定长度，此项不生效"
                            : undefined
                        }
                      >
                        <option value={2}>2位长度 (如 aa / ba / 88)</option>
                        <option value={3}>3位长度 (如 aaa / 123 / abc)</option>
                        <option value={4}>4位长度 (如 8888 / baba)</option>
                      </select>
                    </div>
                  </div>

                  {/* 3. 快捷标签按钮组 —— 点击插入 {标签} 占位符，可与字面量混排 */}
                  <div className="space-y-2">
                    <label className="block text-xs font-semibold text-content-muted">
                      支持标签 (点击追加到规则框，可任意组合，也可与固定字符混排如 my
                      <span className="text-indigo-400">{"{字母}"}</span>):
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {BUILTIN_TOKENS.map((tag) => (
                        <button
                          key={tag}
                          onClick={() => setBatchRules(prev => `${prev}{${tag}}`)}
                          className="bg-elevated hover:bg-indigo-50 text-content-secondary hover:text-indigo-700 border border-border-base hover:border-indigo-300 dark:hover:bg-indigo-950/60 dark:hover:text-indigo-300 dark:hover:border-indigo-500/40 text-xs px-3 py-1.5 rounded-lg transition-all"
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 3.5 词库分类（点击追加到规则框；支持增删改） */}
                  <div className="space-y-3 border-t border-border-base pt-5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <label className="block text-xs font-semibold text-content-muted">
                        词库 (点击插入 <span className="text-indigo-400">{"{词库名}"}</span> 标签，可与其它标签组合；中文将自动转 Punycode 提交):
                      </label>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={openCreateBank}
                          className="text-xs font-semibold text-indigo-700 hover:text-indigo-800 border border-indigo-200 hover:border-indigo-300 bg-indigo-50 hover:bg-indigo-100 dark:text-indigo-400 dark:hover:text-indigo-300 dark:border-indigo-500/40 dark:hover:border-indigo-500 dark:bg-indigo-950/30 dark:hover:bg-indigo-950/60 px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          新建词库
                        </button>
                        <button
                          onClick={handleResetBanks}
                          className="text-xs font-semibold text-content-muted hover:text-content-primary border border-border-base hover:border-content-muted bg-elevated hover:bg-hovered px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          恢复默认
                        </button>
                      </div>
                    </div>

                    {/* 按分组类型分栏渲染 */}
                    {(Object.keys(BANK_KIND_META) as BankKind[]).map((kind) => {
                      const banks = wordBanks.filter((b) => b.kind === kind);
                      const meta = BANK_KIND_META[kind];
                      return (
                        <div key={kind} className="space-y-1.5">
                          <span className={`text-[11px] font-semibold ${meta.titleClass}`}>
                            {meta.label}
                            <span className="text-content-muted font-normal ml-1">({banks.length})</span>
                          </span>
                          {banks.length === 0 ? (
                            <div className="text-[11px] text-content-muted italic">
                              该分类下暂无词库，可点击右上「新建词库」添加
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {banks.map((bank) => (
                                <div
                                  key={bank.id}
                                  className={`group flex items-center bg-elevated border border-border-base ${meta.hoverBorderClass} rounded-lg overflow-hidden transition-all`}
                                >
                                  {/* 主体：点击追加到规则框 */}
                                  <button
                                    onClick={() => appendWordbank(bank.words, bank.name)}
                                    className={`text-content-secondary ${meta.hoverTextClass} text-xs px-3 py-2.5 md:py-1.5 transition-all`}
                                    title={`点击追加 ${bank.words.length} 个词到规则框`}
                                  >
                                    {bank.name}
                                    <span className="ml-1 text-[10px] text-content-muted">
                                      {bank.words.length}
                                    </span>
                                  </button>
                                  {/* 编辑 / 删除 */}
                                  <button
                                    onClick={() => openEditBank(bank)}
                                    className="px-2.5 py-2.5 md:px-1.5 md:py-1.5 text-content-muted hover:text-indigo-400 hover:bg-hovered transition-all border-l border-border-base"
                                    title="编辑该词库"
                                  >
                                    <Pencil className="w-3.5 h-3.5 md:w-3 md:h-3" />
                                  </button>
                                  <button
                                    onClick={() => handleDeleteBank(bank)}
                                    className="px-2.5 py-2.5 md:px-1.5 md:py-1.5 text-content-muted hover:text-red-400 hover:bg-hovered transition-all border-l border-border-base"
                                    title="删除该词库"
                                  >
                                    <Trash2 className="w-3.5 h-3.5 md:w-3 md:h-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* 3.55 官方保留前缀排除名单 */}
                  <div className="space-y-3 border-t border-border-base pt-5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={enableReservedFilter}
                          onChange={(e) => toggleReservedFilter(e.target.checked)}
                          className="w-4 h-4 accent-red-500"
                        />
                        <span className="text-xs font-semibold text-content-secondary">
                          启用官方保留前缀排除
                          <span className="text-content-muted font-normal ml-1">
                            (整词匹配，如 ai 被排除但 ailu 仍会查询)
                          </span>
                        </span>
                      </label>
                      <button
                        onClick={handleResetReserved}
                        className="text-xs font-semibold text-content-muted hover:text-content-primary border border-border-base hover:border-content-muted bg-elevated hover:bg-hovered px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 shrink-0"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        恢复默认
                      </button>
                    </div>

                    {enableReservedFilter && (
                      <div className="space-y-2.5 pl-6">
                        {/* 已有名单标签 */}
                        <div className="flex flex-wrap gap-2">
                          {reservedPrefixes.length === 0 ? (
                            <span className="text-[11px] text-content-muted italic">
                              名单为空，当前不会排除任何前缀
                            </span>
                          ) : (
                            reservedPrefixes.map((p) => (
                              <span
                                key={p}
                                className="group flex items-center bg-red-50 border border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-500/30 dark:text-red-300 text-xs rounded-lg overflow-hidden"
                              >
                                <span className="px-2.5 py-1 font-mono">{p}</span>
                                <button
                                  onClick={() => handleRemoveReserved(p)}
                                  className="px-1.5 py-1 text-red-500/70 hover:text-red-800 hover:bg-red-100 border-l border-red-200 dark:text-red-400/60 dark:hover:text-red-300 dark:hover:bg-red-900/40 dark:border-red-500/30 transition-all"
                                  title={`从名单移除 ${p}`}
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </span>
                            ))
                          )}
                        </div>

                        {/* 添加输入框 */}
                        <form onSubmit={handleAddReserved} className="flex items-center gap-2">
                          <input
                            type="text"
                            value={newReservedInput}
                            onChange={(e) => setNewReservedInput(e.target.value)}
                            placeholder="添加保留前缀，可一次粘贴多个（逗号/空格分隔）"
                            className="flex-1 bg-elevated border border-border-base rounded-xl px-3 h-10 text-content-primary text-sm focus:border-red-500/60 focus:outline-none"
                          />
                          <button
                            type="submit"
                            disabled={!newReservedInput.trim()}
                            className="bg-elevated hover:bg-hovered text-content-secondary hover:text-content-primary border border-border-base text-xs font-semibold px-3 h-10 rounded-xl transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            添加
                          </button>
                        </form>
                      </div>
                    )}
                  </div>

                  {/* 3.6 顺序检测模式（进位递增 + 断点续查） */}
                  <div className="space-y-3 border-t border-border-base pt-5">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={seqMode}
                        onChange={(e) => setSeqMode(e.target.checked)}
                        className="w-4 h-4 accent-indigo-500"
                      />
                      <span className="text-xs font-semibold text-content-secondary">
                        启用顺序检测模式（按字符集进位递增，如 aaa → aab → aac…，开启后忽略上方规则框）
                      </span>
                    </label>

                    {seqMode && (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pl-6">
                        <div className="space-y-1.5">
                          <label className="block text-[11px] font-semibold text-content-muted">字符集:</label>
                          <select
                            value={seqCharset}
                            onChange={(e) => setSeqCharset(e.target.value as typeof seqCharset)}
                            className="w-full bg-elevated border border-border-base rounded-xl px-3 h-10 text-content-primary text-sm focus:border-indigo-500 focus:outline-none"
                          >
                            <option value="字母">纯字母 (a-z)</option>
                            <option value="数字">纯数字 (0-9)</option>
                            <option value="字母数字">字母+数字 (a-z0-9)</option>
                          </select>
                        </div>
                        <div className="space-y-1.5">
                          <label className="block text-[11px] font-semibold text-content-muted">长度:</label>
                          <select
                            value={seqLength}
                            onChange={(e) => setSeqLength(Number(e.target.value))}
                            className="w-full bg-elevated border border-border-base rounded-xl px-3 h-10 text-content-primary text-sm focus:border-indigo-500 focus:outline-none"
                          >
                            <option value={2}>2 位</option>
                            <option value={3}>3 位</option>
                            <option value={4}>4 位</option>
                          </select>
                        </div>
                        <div className="space-y-1.5">
                          <label className="block text-[11px] font-semibold text-content-muted">起始串 (可选):</label>
                          <input
                            type="text"
                            value={seqStart}
                            onChange={(e) => setSeqStart(e.target.value)}
                            placeholder="如 qwe，留空从头开始"
                            className="w-full bg-elevated border border-border-base rounded-xl px-3 h-10 text-content-primary text-sm focus:border-indigo-500 focus:outline-none"
                          />
                        </div>
                      </div>
                    )}

                    {/* 查重池开关 */}
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={ignorePool}
                        onChange={(e) => setIgnorePool(e.target.checked)}
                        className="w-4 h-4 accent-amber-500"
                      />
                      <span className="text-xs font-semibold text-content-secondary">
                        忽略查重池，强制全部重查
                        <span className="text-content-muted font-normal ml-1">
                          （默认会跳过池中 7 天内已确认「已注册」的域名以节省 API 配额；勾选此项可刷新过期结论）
                        </span>
                      </span>
                    </label>

                    {/* 断点续查提示条 */}
                    {scanCursor && scanStatus !== "running" && (
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-500/30 rounded-xl px-4 py-3">
                        <div className="text-xs text-amber-800 dark:text-amber-300">
                          🔖 检测到上次未完成的扫描断点：
                          <span className="font-mono font-bold mx-1">{scanCursor.lastCandidate || "起点"}</span>
                          （已查 {scanCursor.checked} 个 · 保存于 {scanCursor.savedAt}）
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => handleStartBatchScan(scanCursor.lastCandidate)}
                            className="bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-all"
                          >
                            从断点继续
                          </button>
                          <button
                            onClick={clearScanCursor}
                            className="text-xs text-content-muted hover:text-content-primary px-2 py-1.5"
                          >
                            清除断点
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 4. 根域名后缀多选组 (支持添加自定义根域名) */}
                  <div className="space-y-3 border-t border-border-base pt-5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <label className="text-xs font-semibold text-content-secondary">
                        选择欲检测的 DNSHE 官方及自定义根域名后缀:
                      </label>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setSelectedRoots([...allRootDomains])}
                          className="text-xs text-indigo-400 hover:underline"
                        >
                          全选 ({allRootDomains.length})
                        </button>
                        <span className="text-content-muted">|</span>
                        <button
                          onClick={() => setSelectedRoots([])}
                          className="text-xs text-content-muted hover:underline"
                        >
                          反选
                        </button>
                      </div>
                    </div>

                    {/* 根域名复选框网格 */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
                      {allRootDomains.map((root) => {
                        const isChecked = selectedRoots.includes(root);
                        const isDefault = DEFAULT_ROOT_DOMAINS.includes(root);
                        return (
                          <div
                            key={root}
                            className={`group relative flex items-center justify-between p-2.5 md:p-2 rounded-lg border text-xs font-mono transition-all ${
                              isChecked
                                ? "bg-indigo-100 border-indigo-300 text-indigo-800 dark:bg-indigo-950/40 dark:border-indigo-500/50 dark:text-indigo-300"
                                : "bg-elevated border-border-base text-content-muted hover:text-content-primary"
                            }`}
                          >
                            <label className="flex items-center gap-2 cursor-pointer w-full overflow-hidden">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedRoots(prev => Array.from(new Set([...prev, root])));
                                  } else {
                                    setSelectedRoots(prev => prev.filter(r => r !== root));
                                  }
                                }}
                                className="rounded border-border-base text-indigo-600 focus:ring-0"
                              />
                              <span className="truncate">.{root}</span>
                            </label>

                            {!isDefault && (
                              <button
                                type="button"
                                title="删除该自定义根域名"
                                onClick={() => handleRemoveCustomRootDomain(root)}
                                /*
                                  NOTE: 原本是 opacity-0 group-hover:opacity-100 —— 触屏没有
                                  hover，这个按钮在手机上永远显不出来也点不到。窄屏改为常显，
                                  ≥md 才保留"悬停才出现"的桌面观感。
                                */
                                className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-content-muted hover:text-red-400 p-1.5 md:p-0.5 ml-1 transition-opacity"
                              >
                                <X className="w-3.5 h-3.5 md:w-3 md:h-3" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* 添加自定义根域名输入栏 */}
                    <form onSubmit={handleAddCustomRootDomain} className="flex items-center gap-2 pt-1">
                      <input
                        type="text"
                        placeholder="添加新根域名(如 sample.cd)"
                        value={newRootInput}
                        onChange={(e) => setNewRootInput(e.target.value)}
                        className="bg-elevated border border-border-base focus:border-indigo-500 rounded-lg px-3 h-10 text-sm text-content-primary focus:outline-none flex-1"
                      />
                      <button
                        type="submit"
                        disabled={!newRootInput.trim()}
                        className="bg-elevated hover:bg-hovered text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300 border border-border-base text-xs px-3 h-10 rounded-lg transition-all flex items-center gap-1 disabled:opacity-40 shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" /> 添加根域
                      </button>
                    </form>
                  </div>

                  {/* 5. 主控制按钮条
                      移动端 2×2 网格：一行两个左右均分，而不是让 flex-wrap 随缘折行
                      （随缘折出来的第二行只有一个按钮孤零零贴一边）；桌面端仍是一行。

                      🔴 2026-09-30 第15轮：用户报「查重里已经变成了两个 暂停查询」。
                      线上复现（`.apitmp/diag-r15d.mjs`，拦截 /api/whois 造 paused 态）：
                      暂停态下第 1 格是「恢复查询」、第 2 格是**disabled 的「暂停查询」**，
                      两个并排、都跟"暂停"有关 ⇒ 读起来就是一个重复按钮。
                      修法：**「暂停查询」只在 running 时出现**（其余状态它本来就是禁用态，
                      隐藏零信息损失），第 1 格在非 running 时 `col-span-2` 独占整行，
                      保证「左边永远是生命周期按钮、右边永远只有运行中的暂停」。
                      另外 running 文案由「正在查重中...」缩为「正在查重」+ `whitespace-nowrap`：
                      实测 390px 下 152px 的格子放不下 6 字 + 省略号，会折成两行把整行撑到 64px
                      （邻行 44px），既违反 §13 又难看。 */}
                  <div className="grid grid-cols-2 md:flex md:flex-wrap md:items-center gap-3 border-t border-border-base pt-5">
                    <button
                      onClick={() => handleStartBatchScan()}
                      disabled={scanStatus === "running"}
                      className={`justify-center w-full md:w-auto bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm px-3 sm:px-6 py-3 rounded-xl transition-all shadow-lg flex items-center gap-2 whitespace-nowrap disabled:opacity-50 ${
                        scanStatus === "running" ? "" : "col-span-2"
                      }`}
                    >
                      <Play className={`w-4 h-4 flex-shrink-0 ${scanStatus === "running" ? "animate-spin" : ""}`} />
                      {scanStatus === "running" ? "正在查重" : scanStatus === "paused" ? "恢复查询" : "开始查询"}
                    </button>

                    {scanStatus === "running" && (
                      <button
                        onClick={() => {
                          const c = scanCursorRef.current;
                          saveScanCursor(c.lastCandidate, c.taskIndex, c.checked);
                          updateScanStatus("paused");
                          showToast("info", `⏸️ 已暂停并保存断点（当前位置：${c.lastCandidate || "起点"}）`);
                        }}
                        className="justify-center w-full md:w-auto bg-elevated hover:bg-hovered text-content-secondary font-semibold text-sm px-3 sm:px-5 py-3 rounded-xl transition-all flex items-center whitespace-nowrap"
                      >
                        暂停查询
                      </button>
                    )}

                    <button
                      onClick={() => {
                        updateScanStatus("idle");
                        setAvailableDomainsList([]);
                        setScanLogs([]);
                        setScanProgress({ total: 0, checked: 0, available: 0 });
                        clearScanCursor();
                        showToast("info", "🔄 已重置查重逻辑（断点已清除）");
                      }}
                      className="justify-center w-full md:w-auto bg-elevated hover:bg-hovered text-content-secondary font-semibold text-sm px-3 sm:px-5 py-3 rounded-xl transition-all flex items-center whitespace-nowrap"
                    >
                      重新开始
                    </button>

                    <button
                      onClick={handleExportAvailableTxt}
                      disabled={availableDomainsList.length === 0}
                      className="justify-center w-full md:w-auto md:ml-auto bg-emerald-700 hover:bg-emerald-600 text-white font-semibold text-sm px-3 sm:px-5 py-3 rounded-xl transition-all flex items-center gap-2 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Download className="w-4 h-4 flex-shrink-0" />
                      导出为 txt
                    </button>
                  </div>
                </div>

                {/* 扫描进度与发现结果列表 */}
                {scanProgress.total > 0 && (
                  <div className="bg-surface border border-border-base rounded-2xl p-6 shadow-xl space-y-4">
                    <div className="flex items-center justify-between text-xs font-semibold text-content-secondary">
                      <span>查重进度: {scanProgress.checked} / {scanProgress.total} ({Math.round((scanProgress.checked / scanProgress.total) * 100)}%)</span>
                      <span className="text-emerald-400 font-bold">🎉 发现可用免费域名: {availableDomainsList.length} 个</span>
                    </div>

                    {/* 进度条 */}
                    <div className="w-full bg-elevated rounded-full h-3 overflow-hidden border border-border-base">
                      <div
                        className="bg-indigo-500 h-full transition-all duration-300"
                        style={{ width: `${Math.round((scanProgress.checked / scanProgress.total) * 100)}%` }}
                      ></div>
                    </div>

                    {/* 发现可注册域名的实时表格 */}
                    <div className="space-y-3 pt-2">
                      <h4 className="text-sm font-bold text-content-primary flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        发现未注册域名 (点击注册)
                      </h4>

                      {availableDomainsList.length === 0 ? (
                        <div className="text-center py-8 bg-hovered rounded-xl border border-border-base text-xs text-content-muted">
                          {scanStatus === "running" ? "正在高频查重校验中，请稍候..." : "暂未查出可用的域名"}
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                          {availableDomainsList.map((item, idx) => (
                            <div
                              key={idx}
                              className="bg-emerald-50 border border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-500/30 rounded-xl p-3 flex items-center justify-between gap-2 hover:border-emerald-500 transition-all"
                            >
                              <div className="min-w-0">
                                <span className="font-mono text-sm font-bold text-content-primary block truncate">
                                  {item.fullDomain}
                                </span>
                                <span className="text-[10px] text-content-muted block mt-0.5">
                                  查出时间: {item.time}
                                </span>
                              </div>

                              <button
                                onClick={() => {
                                  const sub = item.subdomain;
                                  const root = item.rootdomain;
                                  setSearchSubdomain(sub);
                                  setSearchRootdomain(root);
                                  setRegMode("single");
                                  if (dnsheAccounts.length > 0 && !registerAccountId) {
                                    setRegisterAccountId(dnsheAccounts[0].id);
                                  }
                                  // 瞬发呈现绿色【尚未注册】卡片，提升即时响应体验
                                  setWhoisResult({
                                    searchedDomain: item.fullDomain,
                                    registered: false
                                  });
                                  // 显式带参数自动触发后台 WHOIS 重新拉取详细元数据
                                  handleCheckWhois(undefined, sub, root);
                                }}
                                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3 py-2 sm:py-1.5 rounded-lg shadow transition-all flex items-center gap-1 flex-shrink-0"
                              >
                                <Plus className="w-3.5 h-3.5" /> 注册
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 实时爆破扫描中文日志卡片 */}
                    <div className="space-y-3 pt-4 border-t border-border-base">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-bold text-content-primary flex items-center gap-2">
                          <ScrollText className="w-4 h-4 text-indigo-400" />
                          实时查询日志 (自动滚动最新 50 条)
                        </h4>
                        <span className="text-xs text-content-muted font-mono">
                          {scanLogs.length > 0 ? `最新推送: ${scanLogs[0].time}` : "等待扫码响应..."}
                        </span>
                      </div>

                      <div className="bg-elevated rounded-xl p-3.5 border border-border-base font-mono text-xs max-h-56 overflow-y-auto space-y-1.5 scrollbar-thin">
                        {scanLogs.length === 0 ? (
                          <div className="text-center py-6 text-content-muted">
                            正在高频检测中，实时中文日志流水将在此处高频输出...
                          </div>
                        ) : (
                          scanLogs.map((log) => (
                            <div key={log.id} className="flex items-start gap-2 border-b border-border-base pb-1 last:border-0">
                              <span className="text-content-muted font-semibold flex-shrink-0">[{log.time}]</span>
                              <span className={`min-w-0 break-all ${
                                log.status === "available"
                                  ? "text-emerald-400 font-bold"
                                  : log.status === "error"
                                  ? "text-amber-400"
                                  : "text-content-muted"
                              }`}>
                                {log.text}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                )}

              </div>
            )}
          </div>
        )}

        {/* Tab 1: 域名列表 */}
        {activeTab === "domains" && (
          <div className="space-y-8">
            {/* 账号与 DNS 筛选控制器 */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 md:gap-4 bg-surface border border-border-base p-3 sm:p-4 rounded-xl">
              <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3 sm:gap-4 w-full md:w-auto">
                {/* NOTE: 下拉框原先是 min-w-[180px]，配上 whitespace-nowrap 的标签在手机上是
                    硬溢出（不是"挤"）。窄屏改为占满行宽并允许收缩，≥md 才恢复最小宽度。 */}
                <div className="flex items-center gap-2 min-w-0 sm:flex-1 md:flex-none">
                  <span className="text-sm font-semibold text-content-secondary flex items-center gap-1.5 whitespace-nowrap flex-shrink-0">
                    <UserCheck className="w-4 h-4 text-indigo-400" /> 选择账号:
                  </span>
                  <select
                    value={selectedAccountFilter}
                    onChange={(e) => {
                      setSelectedAccountFilter(e.target.value);
                      fetchDomains(e.target.value);
                    }}
                    className="form-input px-3 h-10 rounded-lg text-sm text-content-secondary flex-1 min-w-0 md:flex-none md:min-w-[180px]"
                  >
                    <option value="all">全部账号</option>
                    {dnsheAccounts.map((acc) => (
                      <option key={acc.id} value={String(acc.id)}>
                        {acc.alias}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2 min-w-0 sm:flex-1 md:flex-none">
                  <span className="text-sm font-semibold text-content-secondary flex items-center gap-1.5 whitespace-nowrap flex-shrink-0">
                    <Server className="w-4 h-4 text-sky-400" /> DNS 类型:
                  </span>
                  <select
                    value={nsTypeFilter}
                    onChange={(e) => setNsTypeFilter(e.target.value as "all" | "default" | "external")}
                    className="form-input px-3 h-10 rounded-lg text-sm text-content-secondary flex-1 min-w-0 md:flex-none md:min-w-[150px]"
                  >
                    <option value="all">全部 DNS 类型</option>
                    <option value="default">仅系统默认 DNS</option>
                    <option value="external">仅外部 DNS 委派</option>
                  </select>
                </div>
              </div>

              {/* NOTE: 这一组原先没有 flex-wrap，却装着三个 whitespace-nowrap 的元素 */}
              <div className="flex flex-wrap items-center gap-2 sm:gap-4 w-full md:w-auto md:ml-auto md:justify-end">
                {globalSearch.trim() && (
                  <div className="flex items-center gap-1.5 text-xs bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/60 px-2.5 py-1 rounded-full whitespace-nowrap">
                    <Search className="w-3 h-3 shrink-0" />
                    <span className="font-mono">
                      搜索「{globalSearch.trim()}」· 命中 {searchHitCount} 个
                    </span>
                    <button
                      onClick={() => setGlobalSearch("")}
                      className="ml-0.5 font-semibold underline decoration-dotted hover:text-amber-900 dark:hover:text-amber-100 transition-colors"
                    >
                      清除
                    </button>
                  </div>
                )}
                {/* 统计数字禁止折行：折成「托管域名: / 50 个」两行比超宽更难看（§11 换行对齐规则） */}
                <div className="text-xs text-content-muted font-mono whitespace-nowrap">
                  已绑定账户: <span className="text-indigo-400 font-bold">{dnsheAccounts.length}</span> |
                  托管域名: <span className="text-emerald-400 font-bold">{domains.length}</span> 个
                </div>
                {domains.length > 0 && (
                  <button
                    onClick={toggleAllAccounts}
                    className="px-3 h-10 text-sm font-semibold text-content-secondary hover:text-content-primary bg-elevated hover:bg-hovered border border-border-base rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap"
                  >
                    {collapsedAccounts.size > 0 ? (
                      <>
                        <ChevronsUpDown className="w-3.5 h-3.5" />
                        展开
                      </>
                    ) : (
                      <>
                        <ChevronsDownUp className="w-3.5 h-3.5" />
                        收起
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>

            {/* 域名列表展示 */}
            {loadingDomains ? (
              <div className="flex flex-col items-center justify-center py-20 text-content-muted">
                <RefreshCw className="w-8 h-8 animate-spin text-indigo-500 mb-2" />
                <span>正在加载域名列表...</span>
              </div>
            ) : domains.length === 0 ? (
              <div className="text-center py-20 border border-dashed border-border-base rounded-xl bg-surface">
                <Globe className="w-12 h-12 text-content-muted mx-auto mb-3" />
                <h3 className="text-lg font-bold text-content-secondary">未找到域名记录</h3>
                <p className="text-content-muted text-sm mt-1 max-w-md mx-auto">
                  {selectedAccountFilter !== "all" 
                    ? "当前选中账号下没有绑定任何域名。"
                    : "尚未绑定账号或本地缓存中没有域名。请前往「账号管理」添加 API 密钥，然后点击「同步所有账号」。"}
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {groupedDomains.map((group) => {
                  const defaultDomains = group.domains.filter(checkHasDns);
                  const externalDomains = group.domains.filter((d) => !checkHasDns(d));

                  const showDefault = nsTypeFilter === "all" || nsTypeFilter === "default";
                  const showExternal = nsTypeFilter === "all" || nsTypeFilter === "external";
                  const isCollapsed = collapsedAccounts.has(group.accountId);

                  return (
                    <div
                      key={group.accountId}
                      className={`bg-surface p-3 sm:p-4 md:p-6 rounded-2xl border border-border-base shadow-sm ${
                        isCollapsed ? "" : "space-y-4 md:space-y-6"
                      }`}
                    >
                      {/* 账号大标题（可点击展开/收起）；收起时去掉分隔线与下边距，保持上下留白对称 */}
                      <button
                        onClick={() => toggleAccountCollapse(group.accountId)}
                        className={`w-full flex items-center justify-between gap-2 flex-wrap hover:opacity-80 transition-opacity text-left ${
                          isCollapsed ? "" : "border-b border-border-base pb-4"
                        }`}
                      >
                        <h3 className="text-base md:text-lg font-bold text-content-primary flex items-center gap-2 min-w-0">
                          {isCollapsed ? (
                            <ChevronRight className="w-5 h-5 text-indigo-400 shrink-0" />
                          ) : (
                            <ChevronDown className="w-5 h-5 text-indigo-400 shrink-0" />
                          )}
                          <Key className="w-4 h-4 text-indigo-400 shrink-0" />
                          {group.seq > 0 && (
                            <>
                              <span className="text-emerald-400">账号 {group.seq}</span>
                              <span className="text-content-muted">·</span>
                            </>
                          )}
                          <span className="text-indigo-700 dark:text-indigo-300 truncate max-w-full">{group.alias}</span>
                        </h3>
                        {/* 统计徽章：窄屏折到第二行并**撑满整行**（用户 2026-09-30 指出：
                            只靠 ml-auto 挤在右侧、宽度随内容长短变化，移动端看着很别扭）。
                            ≥md 恢复「贴卡片右缘」的小药丸形态（§12 元信息靠右）。
                            仍保留 whitespace-nowrap：它属于 §15 标准档（22px），一旦折行就会变高破坏两档规格。 */}
                        <span className="w-full md:w-auto md:ml-auto text-center md:text-left text-[11px] md:text-xs bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-950/80 dark:text-indigo-300 dark:border-indigo-900/60 px-2 md:px-2.5 py-0.5 rounded-full font-normal whitespace-nowrap">
                          共 {group.domains.length} 个域名（系统默认: {defaultDomains.length} | 外部DNS: {externalDomains.length}）
                        </span>
                      </button>

                      {/* 域名内容区（收起时隐藏） */}
                      {!isCollapsed && (
                      /* 空账号只渲染标题（共 0 个域名），不再放提示文案 */
                      <div className="expand-anim">
                      {/* 子分块 1：系统默认 DNS 域名 */}
                      {showDefault && defaultDomains.length > 0 && (
                        <div className="space-y-3">
                          <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-sm font-bold text-content-secondary">
                            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block shrink-0" />
                            <span>系统默认 DNS 域名 ({defaultDomains.length})</span>
                            <span className="hidden sm:inline text-xs text-content-muted font-normal">—— 支持直接在线管理 DNS 解析记录</span>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 md:gap-6">
                            {defaultDomains.map(renderDomainCard)}
                          </div>
                        </div>
                      )}

                      {/* 子分块 2：外部 DNS 委派域名 */}
                      {showExternal && externalDomains.length > 0 && (
                        <div className="space-y-3 pt-2">
                          <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-sm font-bold text-content-secondary">
                            <span className="w-2.5 h-2.5 rounded-full bg-sky-400 inline-block shrink-0" />
                            <span>外部 DNS 委派域名 ({externalDomains.length})</span>
                            <span className="hidden sm:inline text-xs text-content-muted font-normal">—— 已托管至 Cloudflare 等第三方服务商</span>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 md:gap-6">
                            {externalDomains.map(renderDomainCard)}
                          </div>
                        </div>
                      )}
                      </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Tab 1.5: Cloudflare 独立标签页 */}
        {activeTab === "cloudflare" && (
          <div className="space-y-8">
            {/* 顶部：账号筛选与操作按钮 */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 md:gap-4 bg-surface border border-border-base p-3 sm:p-4 rounded-xl">
              <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3 sm:gap-4 w-full md:w-auto">
                <div className="flex items-center gap-2 min-w-0 sm:flex-1 md:flex-none">
                  <span className="text-sm font-semibold text-content-secondary flex items-center gap-1.5 whitespace-nowrap flex-shrink-0">
                    <UserCheck className="w-4 h-4 text-indigo-400" /> 选择账号:
                  </span>
                  <select
                    value={cfAccountFilter}
                    onChange={(e) => {
                      setCfAccountFilter(e.target.value);
                      fetchCfZones(e.target.value);
                    }}
                    className="form-input px-3 h-10 rounded-lg text-sm text-content-secondary flex-1 min-w-0 md:flex-none md:min-w-[180px]"
                  >
                    <option value="all">全部账号</option>
                    {cfAccountList.map((acc) => (
                      <option key={acc.id} value={String(acc.id)}>
                        {acc.alias}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="text-xs text-content-muted font-mono whitespace-nowrap">
                  已绑定账号: <span className="text-indigo-400 font-bold">{cfAccountList.length}</span> |
                  托管 zones: <span className="text-emerald-400 font-bold">{cfZones.length}</span> 个
                </div>
              </div>

              {/* 工具行：列数选择 + 同步 + 收起/展开
                  窄屏（<sm）只保留「同步」+「收起/展开」两个动作按钮并 2 等分一行；
                  列数选择器**只在 ≥sm 出现** —— 用户原话「移动端就默认一列，不需要选择几列的控件」，
                  手机上一律走 CF_COL_CLASS.auto 的 1 列，留着选择器只会白占一格。
                  没有 zone 时不渲染「收起/展开」，此时降为 1 等分，避免空出一格。
                  NOTE: 同步按钮原来是 `py-2 text-xs`（28~32px），和同行 h-10 的控件不等高 ——
                  同排必须同档，见 §13 / §20。 */}
              <div className={`grid ${cfZones.length > 0 ? "grid-cols-2" : "grid-cols-1"} sm:flex sm:flex-wrap sm:items-center gap-2 w-full md:w-auto md:justify-end`}>
                <div className="hidden sm:flex items-center gap-2 min-w-0">
                  <span className="text-xs text-content-muted whitespace-nowrap">每行列数</span>
                  <select
                    value={cfCols}
                    onChange={(e) => setCfCols(e.target.value)}
                    className="form-input text-sm px-3 h-10 rounded-lg w-full sm:w-auto min-w-0"
                    aria-label="Cloudflare 卡片每行列数"
                  >
                    {OVERVIEW_COL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={handleCfSyncZones}
                  disabled={cfAccountList.length === 0 || actionLoading === "cf-sync"}
                  className="h-10 px-3 text-sm font-semibold text-content-secondary hover:text-content-primary bg-elevated hover:bg-hovered border border-border-base rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${actionLoading === "cf-sync" ? "animate-spin" : ""}`} />
                  同步
                </button>
                {cfZones.length > 0 && (
                  <button
                    onClick={cfToggleAllAccounts}
                    className="h-10 px-3 text-sm font-semibold text-content-secondary hover:text-content-primary bg-elevated hover:bg-hovered border border-border-base rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap"
                  >
                    {cfCollapsedAccounts.size > 0 ? (
                      <>
                        <ChevronsUpDown className="w-3.5 h-3.5 shrink-0" />
                        展开
                      </>
                    ) : (
                      <>
                        <ChevronsDownUp className="w-3.5 h-3.5 shrink-0" />
                        收起
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>

            {/* zones 列表（按账号分组） */}
            {loadingCfZones && cfZones.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-content-muted">
                <RefreshCw className="w-8 h-8 animate-spin text-indigo-500 mb-2" />
                <span>正在加载 Cloudflare zones...</span>
              </div>
            ) : cfAccountList.length === 0 ? (
              <div className="text-center py-20 border border-dashed border-border-base rounded-xl bg-surface">
                <Cloud className="w-12 h-12 text-content-muted mx-auto mb-3" />
                <h3 className="text-lg font-bold text-content-secondary">尚未绑定 Cloudflare 账号</h3>
                <p className="text-content-muted text-sm mt-1 max-w-md mx-auto">
                  请前往「账号管理」使用 API Token（需 Zone.Read 与 Zone DNS Edit 权限）绑定，绑定后在这里管理 zones 与解析记录。
                </p>
                <button
                  onClick={() => setActiveTab("accounts")}
                  className="mt-4 px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white border border-indigo-500 shadow-lg shadow-indigo-900/40 rounded-lg transition-all inline-flex items-center gap-1.5"
                >
                  <Key className="w-3.5 h-3.5" /> 前往账号管理
                </button>
              </div>
            ) : (
              <div className="space-y-6">
                {filteredCfGroups.map((group) => {
                  const isCollapsed = cfCollapsedAccounts.has(group.accountId);
                  return (
                    <div
                      key={group.accountId}
                      className={`bg-surface p-3 sm:p-4 md:p-6 rounded-2xl border border-border-base shadow-sm ${
                        isCollapsed ? "" : "space-y-4 md:space-y-6"
                      }`}
                    >
                      <button
                        onClick={() => cfToggleAccountCollapse(group.accountId)}
                        className={`w-full flex items-center justify-between hover:opacity-80 transition-opacity text-left ${
                          isCollapsed ? "" : "border-b border-border-base pb-4"
                        }`}
                      >
                        <h3 className="text-base md:text-lg font-bold text-content-primary flex items-center gap-2 flex-wrap min-w-0">
                          {isCollapsed ? (
                            <ChevronRight className="w-5 h-5 text-indigo-400 shrink-0" />
                          ) : (
                            <ChevronDown className="w-5 h-5 text-indigo-400 shrink-0" />
                          )}
                          <CloudflareIcon className="w-4 h-4 shrink-0" />
                          <span className="text-indigo-700 dark:text-indigo-300 truncate max-w-full">{group.alias}</span>
                          <span className="text-[11px] md:text-xs bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-900/60 px-2 md:px-2.5 py-0.5 rounded-full font-normal">
                            {group.zones.length} 个 zone
                          </span>
                        </h3>
                      </button>

                      {!isCollapsed && (
                        group.zones.length === 0 ? (
                          <div className="text-center py-8 text-content-muted text-sm">
                            该账号下暂无 zone 数据，点击右上角「同步 zones」从 Cloudflare 拉取。
                          </div>
                        ) : (
                          /* key 随列数变化 → 重挂载重放淡入（grid-template-columns 不可过渡） */
                          <div
                            key={cfCols}
                            className={`ov-anim grid ${CF_COL_CLASS[cfCols] || CF_COL_CLASS.auto} gap-3 sm:gap-4 md:gap-6`}
                          >
                            {group.zones.map(renderCfZoneCard)}
                          </div>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        </div>

        {/* Cloudflare 编辑账号弹窗 */}
        {cfEditingAccount && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md">
            <div className="bg-surface border border-border-base w-full max-w-md max-h-[90dvh] rounded-xl overflow-hidden flex flex-col shadow-2xl">
              <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border-base flex-shrink-0">
                <h3 className="text-lg font-bold text-content-primary flex items-center gap-1.5">
                  <Pencil className="w-5 h-5 text-indigo-400" /> 编辑 Cloudflare 账号
                </h3>
                <button
                  onClick={() => setCfEditingAccount(null)}
                  className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
                <div>
                  <label className="block text-xs font-semibold text-content-muted mb-1.5">账户别名</label>
                  <input
                    type="text"
                    name="cf-edit-alias"
                    autoComplete="off"
                    value={cfEditAlias}
                    onChange={(e) => setCfEditAlias(e.target.value)}
                    className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-content-muted mb-1.5">API Token（留空保持不变）</label>
                  <PasswordInput
                    name="cf-edit-token"
                    autoComplete="new-password"
                    value={cfEditToken}
                    onChange={setCfEditToken}
                    placeholder="如需更换凭据则填写新的 API Token"
                    className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary font-mono"
                  />
                </div>
                <p className="text-[11px] text-content-muted leading-relaxed">
                  仅修改别名时无需填写 Token；更换 Token 会校验新 Token 有效性，并自动重新同步该账号的 zones。
                </p>

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => setCfEditingAccount(null)}
                    className="flex-1 h-10 bg-elevated hover:bg-hovered text-content-muted border border-border-base px-2.5 sm:px-4 rounded-lg text-sm whitespace-nowrap"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleCfUpdateAccount}
                    disabled={actionLoading === `cf-update-account-${cfEditingAccount.id}`}
                    className="flex-1 h-10 btn-primary px-2.5 sm:px-4 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                  >
                    {actionLoading === `cf-update-account-${cfEditingAccount.id}` ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <Save className="w-4 h-4" /> 保存修改
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Cloudflare DNS 解析记录面板 */}
        {cfDnsModalOpen && cfSelectedZone && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md">
            <div className="bg-surface border border-border-base w-full max-w-5xl max-h-[90dvh] rounded-xl flex flex-col shadow-2xl">
              {/* 头部：域名与操作 */}
              <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border-base flex-shrink-0 gap-2">
                <div className="min-w-0">
                  <h3 className="text-base sm:text-lg font-bold text-content-primary font-mono truncate flex items-center gap-2">
                    <Cloud className="w-4 h-4 text-sky-400 flex-shrink-0" />
                    {displayDomain(toUnicode(cfSelectedZone.full_domain))}
                  </h3>
                  <p className="text-xs text-content-muted mt-0.5">
                    Cloudflare 托管 zone · {String(cfSelectedZone.status || "").toLowerCase() === "active" ? "已激活" : "待激活"}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => reloadCfRecords(cfSelectedZone, true)}
                    disabled={loadingCfRecords}
                    title="强制刷新（忽略缓存，重新从 Cloudflare 拉取）"
                    className="p-2 text-content-muted hover:text-content-primary hover:bg-hovered rounded-lg transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${loadingCfRecords ? "animate-spin" : ""}`} />
                  </button>
                  <button
                    onClick={() => setCfDnsModalOpen(false)}
                    className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
                {/* 新建记录折叠面板 */}
                <div className="bg-elevated border border-border-base rounded-xl overflow-hidden">
                  <button
                    onClick={() => { setCfFormOpen(!cfFormOpen); setCfBatchOpen(false); }}
                    className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold text-content-secondary hover:text-content-primary transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      <Plus className="w-4 h-4 text-emerald-400" /> 添加解析记录
                    </span>
                    {cfFormOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>
                  {cfFormOpen && (
                    <div className="px-4 pb-4 space-y-3 border-t border-border-base pt-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-content-muted mb-1.5">记录类型</label>
                          <select
                            value={cfNewType}
                            onChange={(e) => {
                              setCfNewType(e.target.value);
                              if (!["A", "AAAA", "CNAME"].includes(e.target.value)) setCfNewProxied(false);
                            }}
                            className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                          >
                            {CF_DNS_TYPE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-content-muted mb-1.5">主机记录</label>
                          <input
                            type="text"
                            name="cf-new-name"
                            autoComplete="off"
                            value={cfNewName}
                            onChange={(e) => setCfNewName(e.target.value)}
                            placeholder="@ 或 www"
                            className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-content-muted mb-1.5">TTL</label>
                          <select
                            value={cfNewProxied ? 1 : cfNewTtl}
                            onChange={(e) => setCfNewTtl(Number(e.target.value))}
                            disabled={cfNewProxied}
                            title={cfNewProxied ? "开启代理时 Cloudflare 固定使用自动 TTL" : undefined}
                            className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <option value={1}>自动</option>
                            {[60, 300, 600, 1800, 3600, 7200, 18000, 43200, 86400].map((t) => (
                              <option key={t} value={t}>{t} 秒</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-content-muted mb-1.5">
                            优先级 {needsDnsPriority(cfNewType) ? "" : "(无需)"}
                          </label>
                          <input
                            type="number"
                            name="cf-new-priority"
                            autoComplete="off"
                            value={cfNewPriority}
                            onChange={(e) => setCfNewPriority(Number(e.target.value))}
                            disabled={!needsDnsPriority(cfNewType)}
                            className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-content-muted mb-1.5">记录值 Content</label>
                        <input
                          type="text"
                          name="cf-new-content"
                          autoComplete="off"
                          value={cfNewContent}
                          onChange={(e) => setCfNewContent(e.target.value)}
                          placeholder="如 192.0.2.1 / example.com / v=spf1 ..."
                          className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                        />
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        {/* 代理开关仅对 Cloudflare 支持代理的记录类型开放 */}
                        {["A", "AAAA", "CNAME"].includes(cfNewType) ? (
                          <label className="flex items-center gap-2 text-xs text-content-secondary cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={cfNewProxied}
                              onChange={(e) => setCfNewProxied(e.target.checked)}
                              className="w-4 h-4 accent-orange-500"
                            />
                            开启代理（橙色云，隐藏源站 IP，TTL 固定自动）
                          </label>
                        ) : (
                          <span className="text-[11px] text-content-muted">该记录类型不支持 Cloudflare 代理</span>
                        )}
                        <button
                          onClick={handleCfCreateRecord}
                          disabled={actionLoading === "cf-create-dns"}
                          className="btn-primary px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
                        >
                          {actionLoading === "cf-create-dns" ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <Plus className="w-4 h-4" />
                          )}
                          创建记录
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* 批量添加折叠面板 */}
                <div className="bg-elevated border border-border-base rounded-xl overflow-hidden">
                  <button
                    onClick={() => { setCfBatchOpen(!cfBatchOpen); setCfFormOpen(false); }}
                    className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold text-content-secondary hover:text-content-primary transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      <Download className="w-4 h-4 text-sky-400" /> 批量添加解析记录
                    </span>
                    {cfBatchOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>
                  {cfBatchOpen && (
                    <div className="px-4 pb-4 space-y-3 border-t border-border-base pt-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-content-muted mb-1.5">默认类型</label>
                          <select
                            value={cfBatchType}
                            onChange={(e) => setCfBatchType(e.target.value)}
                            className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                          >
                            {CF_DNS_TYPE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-content-muted mb-1.5">默认主机记录</label>
                          <input
                            type="text"
                            name="cf-batch-name"
                            autoComplete="off"
                            value={cfBatchName}
                            onChange={(e) => setCfBatchName(e.target.value)}
                            placeholder="@（留空按 @ 处理）"
                            className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-content-muted mb-1.5">默认 TTL</label>
                          <select
                            value={cfBatchProxied ? 1 : cfBatchTtl}
                            onChange={(e) => setCfBatchTtl(Number(e.target.value))}
                            disabled={cfBatchProxied}
                            className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <option value={1}>自动</option>
                            {[60, 300, 600, 1800, 3600, 7200, 18000, 43200, 86400].map((t) => (
                              <option key={t} value={t}>{t} 秒</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-content-muted mb-1.5">
                            默认优先级 {needsDnsPriority(cfBatchType) ? "" : "(无需)"}
                          </label>
                          <input
                            type="number"
                            name="cf-batch-priority"
                            autoComplete="off"
                            value={cfBatchPriority}
                            onChange={(e) => setCfBatchPriority(Number(e.target.value))}
                            disabled={!needsDnsPriority(cfBatchType)}
                            className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                          />
                        </div>
                      </div>
                      <textarea
                        value={cfBatchInput}
                        onChange={(e) => setCfBatchInput(e.target.value)}
                        placeholder={"每行一条，字段分隔符：竖线 | 逗号 , 或空格\n示例：\n192.0.2.1            仅记录值（默认类型/主机记录）\nwww 192.0.2.2        主机记录 + 记录值\nMX @ mail.example.com 600 10"}
                        className="w-full form-input px-3 py-2.5 rounded-lg text-sm text-content-secondary font-mono min-h-[96px] resize-y"
                      />
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        {["A", "AAAA", "CNAME"].includes(cfBatchType) ? (
                          <label className="flex items-center gap-2 text-xs text-content-secondary cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={cfBatchProxied}
                              onChange={(e) => setCfBatchProxied(e.target.checked)}
                              className="w-4 h-4 accent-orange-500"
                            />
                            默认开启代理（仅对 A/AAAA/CNAME 行生效）
                          </label>
                        ) : <span />}
                        <button
                          onClick={handleCfBatchCreate}
                          disabled={actionLoading === "cf-batch-create-dns" || cfValidBatchLines.length === 0}
                          className="btn-primary px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
                        >
                          {actionLoading === "cf-batch-create-dns" ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <Plus className="w-4 h-4" />
                          )}
                          批量添加{cfValidBatchLines.length > 0 ? `（已识别 ${cfValidBatchLines.length} 条）` : ""}
                        </button>
                      </div>
                      {cfBatchResults && (
                        <div className="space-y-1 max-h-40 overflow-y-auto bg-surface border border-border-base rounded-lg p-3 text-xs">
                          {cfBatchResults.map((r, i) => (
                            <div key={i} className={`flex items-start gap-2 ${r.success ? "text-emerald-500" : "text-red-500"}`}>
                              {r.success ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
                              <span className="font-mono break-all">{r.label} — {r.message}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 批量修改折叠面板 */}
                {cfSelectedKeys.size > 0 && cfEditPanelOpen && (
                  <div className="bg-elevated border border-indigo-500/40 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-bold text-content-primary">
                        批量修改 {cfSelectedKeys.size} 条记录
                      </h4>
                      <button onClick={() => setCfEditPanelOpen(false)} className="text-content-muted hover:text-content-primary">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-4 text-xs text-content-secondary">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={cfEditFields.content}
                          onChange={(e) => setCfEditFields({ ...cfEditFields, content: e.target.checked })}
                          className="w-4 h-4 accent-indigo-500"
                        />
                        记录值（可逐条编辑）
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={cfEditFields.ttl}
                          onChange={(e) => setCfEditFields({ ...cfEditFields, ttl: e.target.checked })}
                          className="w-4 h-4 accent-indigo-500"
                        />
                        TTL
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={cfEditFields.proxied}
                          onChange={(e) => setCfEditFields({ ...cfEditFields, proxied: e.target.checked })}
                          className="w-4 h-4 accent-indigo-500"
                        />
                        代理开关
                      </label>
                    </div>
                    {cfEditFields.ttl && (
                      <div className="max-w-[200px]">
                        <label className="block text-xs font-semibold text-content-muted mb-1.5">新 TTL</label>
                        <select
                          value={cfBatchEditProxied ? 1 : cfBatchEditTtl}
                          onChange={(e) => setCfBatchEditTtl(Number(e.target.value))}
                          disabled={cfEditFields.proxied && cfBatchEditProxied}
                          className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <option value={1}>自动</option>
                          {[60, 300, 600, 1800, 3600, 7200, 18000, 43200, 86400].map((t) => (
                            <option key={t} value={t}>{t} 秒</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {cfEditFields.proxied && (
                      <label className="flex items-center gap-2 text-xs text-content-secondary cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={cfBatchEditProxied}
                          onChange={(e) => setCfBatchEditProxied(e.target.checked)}
                          className="w-4 h-4 accent-orange-500"
                        />
                        将选中记录设为{cfBatchEditProxied ? "已代理（橙色云，TTL 固定自动）" : "仅 DNS（灰色云）"}
                      </label>
                    )}
                    {cfEditFields.content && (
                      <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {cfBatchEditTargets.map((t) => (
                          <div key={t.record_id} className="flex items-center gap-2 text-xs">
                            <span className="font-mono text-content-muted truncate max-w-[40%] flex-shrink-0" title={t.label}>{t.label}</span>
                            <input
                              type="text"
                              value={cfBatchEditContents[t.record_id] ?? ""}
                              onChange={(e) => setCfBatchEditContents({ ...cfBatchEditContents, [t.record_id]: e.target.value })}
                              placeholder={t.origin_content || "保持原值"}
                              className="flex-1 form-input px-3 h-8 rounded-lg text-xs text-content-secondary min-w-0"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-content-muted">
                        将提交 {cfBatchEditChanged.length} 条修改（未变化的自动跳过）
                      </span>
                      <button
                        onClick={handleCfBatchUpdateRecords}
                        disabled={actionLoading === "cf-batch-update-dns" || cfBatchEditChanged.length === 0}
                        className="btn-primary px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
                      >
                        {actionLoading === "cf-batch-update-dns" ? (
                          <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : (
                          <Save className="w-4 h-4" />
                        )}
                        提交修改
                      </button>
                    </div>
                    {cfEditResults && (
                      <div className="space-y-1 max-h-40 overflow-y-auto bg-surface border border-border-base rounded-lg p-3 text-xs">
                        {cfEditResults.map((r, i) => (
                          <div key={i} className={`flex items-start gap-2 ${r.success ? "text-emerald-500" : "text-red-500"}`}>
                            {r.success ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
                            <span className="font-mono break-all">{r.label} — {r.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 记录列表工具条 */}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-xs text-content-muted">
                    共 <span className="text-content-primary font-bold">{cfRecords.length}</span> 条解析记录
                  </div>
                  {cfRecords.length > 0 && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={cfToggleAllSelection}
                        className="px-3 py-1.5 text-xs font-semibold text-content-secondary hover:text-content-primary bg-elevated hover:bg-hovered border border-border-base rounded-lg transition-all"
                      >
                        {cfSelectedKeys.size === cfRecords.length ? "取消全选" : "全选"}
                      </button>
                      {cfSelectedKeys.size > 0 && !cfEditPanelOpen && (
                        <button
                          onClick={handleCfOpenEditPanel}
                          className="px-3 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-900/60 rounded-lg transition-all"
                        >
                          批量修改
                        </button>
                      )}
                      {cfSelectedKeys.size > 0 && (
                        <button
                          onClick={handleCfBatchDeleteRecords}
                          disabled={actionLoading === "cf-batch-delete-dns"}
                          className="px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-900/60 rounded-lg transition-all disabled:opacity-50"
                        >
                          批量删除 ({cfSelectedKeys.size})
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* 记录表格（窄屏横向滚动） */}
                {loadingCfRecords ? (
                  <div className="flex flex-col items-center justify-center py-12 text-content-muted">
                    <RefreshCw className="w-6 h-6 animate-spin text-indigo-500 mb-2" />
                    <span className="text-sm">正在加载解析记录...</span>
                  </div>
                ) : cfRecordsError ? (
                  <div className="text-center py-10 border border-red-300/60 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 rounded-xl">
                    <AlertTriangle className="w-10 h-10 text-red-500 mx-auto mb-2" />
                    <p className="text-red-600 dark:text-red-400 text-sm font-semibold mb-1">解析记录加载失败</p>
                    <p className="text-content-muted text-xs max-w-md mx-auto break-all">{cfRecordsError}</p>
                    <button
                      onClick={() => reloadCfRecords(cfSelectedZone, true)}
                      className="mt-3 px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-400 bg-elevated border border-red-200 dark:border-red-900/60 rounded-lg transition-all inline-flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> 重试
                    </button>
                  </div>
                ) : cfRecords.length === 0 ? (
                  <div className="text-center py-12 border border-dashed border-border-base rounded-xl bg-surface">
                    <Server className="w-10 h-10 text-content-muted mx-auto mb-2" />
                    <p className="text-content-muted text-sm">该 zone 下暂无解析记录，可在上方添加。</p>
                  </div>
                ) : (
                  <div className="border border-border-base rounded-xl overflow-x-auto bg-surface">
                    <table className="w-full text-sm min-w-[760px]">
                      <thead>
                        {/* §12 对齐：类型/代理/TTL 居中，记录值靠左（长文本），操作靠右 */}
                        <tr className="bg-elevated text-left text-xs text-content-muted">
                          <th className="px-3 py-2.5 w-10 text-center">
                            <input
                              type="checkbox"
                              checked={cfSelectedKeys.size === cfRecords.length && cfRecords.length > 0}
                              onChange={cfToggleAllSelection}
                              className="w-4 h-4 accent-indigo-500"
                            />
                          </th>
                          <th className="px-3 py-2.5 text-center">类型</th>
                          <th className="px-3 py-2.5">主机记录</th>
                          <th className="px-3 py-2.5">记录值</th>
                          <th className="px-3 py-2.5 w-16 text-center">代理</th>
                          <th className="px-3 py-2.5 w-20 text-center">TTL</th>
                          <th className="px-3 py-2.5 w-28 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cfRecords.map((rec) => {
                          const key = dnsRecordKey(rec);
                          const isEditing = cfEditingKey === key;
                          const relativeName = toRelativeRecordName(rec.name, cfSelectedZone.full_domain);
                          const supportsProxied = ["A", "AAAA", "CNAME"].includes(rec.type);
                          if (isEditing) {
                            return (
                              <tr key={key} className="border-t border-border-base bg-elevated">
                                <td className="px-3 py-2.5">
                                  <input type="checkbox" checked={cfSelectedKeys.has(key)} onChange={() => {
                                    const next = new Set(cfSelectedKeys);
                                    if (next.has(key)) next.delete(key); else next.add(key);
                                    setCfSelectedKeys(next);
                                  }} className="w-4 h-4 accent-indigo-500" />
                                </td>
                                <td className="px-3 py-2.5">
                                  <select
                                    value={cfEditType}
                                    onChange={(e) => {
                                      setCfEditType(e.target.value);
                                      if (!["A", "AAAA", "CNAME"].includes(e.target.value)) setCfEditProxied(false);
                                    }}
                                    className="form-input px-2 h-8 rounded-lg text-xs text-content-secondary w-24"
                                  >
                                    {CF_DNS_TYPE_OPTIONS.map((opt) => (
                                      <option key={opt.value} value={opt.value}>{opt.value}</option>
                                    ))}
                                  </select>
                                </td>
                                <td className="px-3 py-2.5">
                                  <input
                                    type="text"
                                    value={cfEditName}
                                    onChange={(e) => setCfEditName(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === "Enter") handleCfUpdateRecord(); if (e.key === "Escape") setCfEditingKey(null); }}
                                    className="form-input px-2 h-8 rounded-lg text-xs text-content-secondary w-28"
                                  />
                                </td>
                                <td className="px-3 py-2.5">
                                  <input
                                    type="text"
                                    value={cfEditContent}
                                    onChange={(e) => setCfEditContent(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === "Enter") handleCfUpdateRecord(); if (e.key === "Escape") setCfEditingKey(null); }}
                                    className="form-input px-2 h-8 rounded-lg text-xs text-content-secondary w-full min-w-[180px]"
                                  />
                                  {needsDnsPriority(cfEditType) && (
                                    <input
                                      type="number"
                                      value={cfEditPriority}
                                      onChange={(e) => setCfEditPriority(Number(e.target.value))}
                                      placeholder="优先级"
                                      className="form-input px-2 h-8 rounded-lg text-xs text-content-secondary w-20 mt-1.5"
                                    />
                                  )}
                                </td>
                                <td className="px-3 py-2.5">
                                  {supportsProxied ? (
                                    <input
                                      type="checkbox"
                                      checked={cfEditProxied}
                                      onChange={(e) => setCfEditProxied(e.target.checked)}
                                      title="橙色云代理"
                                      className="w-4 h-4 accent-orange-500"
                                    />
                                  ) : (
                                    <span className="text-content-muted text-xs">—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2.5">
                                  <select
                                    value={cfEditProxied ? 1 : cfEditTtl}
                                    onChange={(e) => setCfEditTtl(Number(e.target.value))}
                                    disabled={cfEditProxied}
                                    className="form-input px-2 h-8 rounded-lg text-xs text-content-secondary w-24 disabled:opacity-50"
                                  >
                                    <option value={1}>自动</option>
                                    {[60, 300, 600, 1800, 3600, 7200, 18000, 43200, 86400].map((t) => (
                                      <option key={t} value={t}>{t}</option>
                                    ))}
                                  </select>
                                </td>
                                <td className="px-3 py-2.5 text-right whitespace-nowrap">
                                  <button
                                    onClick={handleCfUpdateRecord}
                                    disabled={actionLoading === `cf-update-dns-${key}`}
                                    className="text-emerald-500 hover:text-emerald-400 font-semibold text-xs px-2 disabled:opacity-50"
                                  >
                                    {actionLoading === `cf-update-dns-${key}` ? "保存中" : "保存"}
                                  </button>
                                  <button
                                    onClick={() => setCfEditingKey(null)}
                                    className="text-content-muted hover:text-content-primary font-semibold text-xs px-2"
                                  >
                                    取消
                                  </button>
                                </td>
                              </tr>
                            );
                          }
                          return (
                            <tr key={key} className="border-t border-border-base hover:bg-hovered/50 transition-colors">
                              <td className="px-3 py-2.5">
                                <input
                                  type="checkbox"
                                  checked={cfSelectedKeys.has(key)}
                                  onChange={() => {
                                    const next = new Set(cfSelectedKeys);
                                    if (next.has(key)) next.delete(key); else next.add(key);
                                    setCfSelectedKeys(next);
                                  }}
                                  className="w-4 h-4 accent-indigo-500"
                                />
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/60 px-2 py-0.5 rounded font-mono">
                                  {rec.type}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 font-mono text-content-primary text-xs">
                                {relativeName === "@" ? (
                                  <span className="text-content-muted">{cfSelectedZone.full_domain}</span>
                                ) : (
                                  `${relativeName}.${cfSelectedZone.full_domain}`
                                )}
                              </td>
                              <td className="px-3 py-2.5 font-mono text-content-secondary text-xs break-all max-w-[280px]">
                                {rec.content}
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                {rec.proxied ? (
                                  <span className="inline-flex items-center gap-1 text-xs text-orange-500 font-semibold" title="已代理（橙色云）">
                                    <Cloud className="w-3.5 h-3.5" /> 已代理
                                  </span>
                                ) : supportsProxied ? (
                                  <span className="inline-flex items-center gap-1 text-xs text-content-muted" title="仅 DNS（灰色云）">
                                    <Cloud className="w-3.5 h-3.5 opacity-40" /> 仅 DNS
                                  </span>
                                ) : (
                                  <span className="text-content-muted text-xs">—</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 font-mono text-content-secondary text-xs text-center">
                                {Number(rec.ttl) === 1 ? "自动" : `${rec.ttl}s`}
                              </td>
                              <td className="px-3 py-2.5 text-right whitespace-nowrap">
                                <button
                                  onClick={() => handleCfStartEditRecord(rec)}
                                  className="text-indigo-500 hover:text-indigo-400 font-semibold text-xs px-2"
                                  title="编辑"
                                >
                                  <Pencil className="w-3.5 h-3.5 inline" />
                                </button>
                                <button
                                  onClick={() => handleCfDeleteRecord(rec)}
                                  disabled={actionLoading === `cf-delete-dns-${key}`}
                                  className="text-red-500 hover:text-red-400 font-semibold text-xs px-2 disabled:opacity-50"
                                  title="删除"
                                >
                                  <Trash2 className="w-3.5 h-3.5 inline" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: 账号管理 */}
        {activeTab === "accounts" && (
          <div className="space-y-6">
            {/* 顶部：绑定按钮（移动端也一行左右均分 —— 两个入口是对等关系，叠两行白费一倍高度） */}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setBindProvider("dnshe");
                  setBindMode("single");
                  setBindModalOpen(true);
                }}
                className="flex-1 py-3 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white border border-indigo-500 shadow-lg shadow-indigo-900/40 flex items-center justify-center gap-2 transition-all"
              >
                <Plus className="w-5 h-5" />
                绑定 DNSHE 账号
              </button>
              <button
                type="button"
                onClick={() => {
                  setBindProvider("cloudflare");
                  setBindMode("single");
                  setBindModalOpen(true);
                }}
                className="flex-1 py-3 rounded-xl text-sm font-semibold bg-sky-600 hover:bg-sky-500 text-white border border-sky-500 shadow-lg shadow-sky-900/40 flex items-center justify-center gap-2 transition-all"
              >
                <Cloud className="w-5 h-5" />
                绑定 Cloudflare 账号
              </button>
            </div>

            {/* 已绑定的 Cloudflare 账号 */}
            <div>
              <h2 className="text-lg font-bold text-content-primary mb-4 flex items-center gap-2">
                <Cloud className="w-5 h-5 text-sky-400" /> Cloudflare 账号 ({cfAccountList.length})
              </h2>
              {loadingAccounts ? (
                <div className="flex justify-center py-10">
                  <RefreshCw className="w-6 h-6 animate-spin text-indigo-500" />
                </div>
              ) : cfAccountList.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-border-base rounded-xl bg-surface">
                  <Cloud className="w-10 h-10 text-content-muted mx-auto mb-2" />
                  <p className="text-content-muted text-sm">尚未绑定 Cloudflare 账号，点击上方「绑定 Cloudflare 账号」用 API Token 绑定</p>
                </div>
              ) : (
                /* 列数必须与下方「已绑定的 API 账号」一致（同为 2 列）。
                   原来这里是 lg:grid-cols-3，2 个账号时只占 2/3、右侧空整整一列，
                   与下面铺满的 2 列网格并排看就是「没均分」（见设计规范 §28）。 */
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {cfAccountList.map((acc) => (
                    <div key={acc.id} className="bg-surface border border-border-base rounded-xl p-4 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-content-primary truncate flex items-center gap-1.5">
                          <Cloud className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
                          <span className="truncate">{acc.alias}</span>
                        </div>
                        <div className="text-xs text-content-muted font-mono mt-0.5">
                          Token cf:••••{acc.api_key.slice(-4)}
                        </div>
                        <div className="text-[11px] text-content-muted mt-0.5">绑定于 {formatDate(acc.created_at, false)}</div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => {
                            setCfEditingAccount(acc);
                            setCfEditAlias(acc.alias);
                            setCfEditToken("");
                          }}
                          className="p-2 hover:bg-hovered rounded-lg text-content-muted hover:text-content-primary transition-colors"
                          title="编辑账号"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleCfDeleteAccount(acc)}
                          disabled={actionLoading === `cf-delete-account-${acc.id}`}
                          className="p-2 hover:bg-hovered rounded-lg text-content-muted hover:text-red-500 transition-colors disabled:opacity-50"
                          title="解绑账号"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 已绑定的 API 账号 */}
            <div>
              <h2 className="text-lg font-bold text-content-primary mb-4">已绑定的 API 账号 ({dnsheAccounts.length})</h2>

              {loadingAccounts ? (
                <div className="flex justify-center py-10">
                  <RefreshCw className="w-6 h-6 animate-spin text-indigo-500" />
                </div>
              ) : dnsheAccounts.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-border-base rounded-xl bg-surface">
                  <Key className="w-10 h-10 text-content-muted mx-auto mb-2" />
                  <p className="text-content-muted text-sm">尚未绑定任何 API 账户</p>
                </div>
              ) : filteredDnsheAccounts.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-border-base rounded-xl bg-surface">
                  <Search className="w-10 h-10 text-content-muted mx-auto mb-2" />
                  <p className="text-content-muted text-sm">没有匹配「{globalSearch.trim()}」的账号</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {filteredDnsheAccounts.map((acc) => (
                    <div key={acc.id} className="glass-card rounded-xl p-5 border border-border-base flex justify-between items-start gap-4">
                      <div className="min-w-0">
                        <h3 className="font-bold text-content-primary text-base truncate">{acc.alias}</h3>
                        <p className="text-content-muted text-xs mt-1.5 font-mono break-all">
                          Key: {maskApiKey(acc.api_key)}
                        </p>
                        <p className="text-[10px] text-content-muted mt-2">
                          绑定于: {new Date(acc.created_at).toLocaleString("zh-CN")}
                        </p>
                      </div>

                      <div className="flex flex-col gap-2 flex-shrink-0">
                        <button
                          onClick={() => openEditAccount(acc)}
                          disabled={actionLoading === `update-account-${acc.id}`}
                          className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 hover:text-indigo-800 border border-indigo-200 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/60 dark:text-indigo-400 dark:hover:text-indigo-200 dark:border-indigo-900/50 p-2 rounded-lg transition-all"
                          title="修改账号"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteAccount(acc.id)}
                          disabled={actionLoading === `delete-account-${acc.id}`}
                          className="bg-red-50 hover:bg-red-100 text-red-700 hover:text-red-800 border border-red-200 dark:bg-red-950/60 dark:hover:bg-red-900/60 dark:text-red-400 dark:hover:text-red-200 dark:border-red-900/50 p-2 rounded-lg transition-all"
                          title="删除账号"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 修改账号弹窗 */}
        {editingAccount && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md">
            {/* NOTE: max-h + flex-col + 正文 overflow-y-auto 三件套缺一不可 —— 少了 max-h，
                内容超过屏高时会被 overflow-hidden 直接裁掉且滚不到（手机上尤其明显） */}
            <div className="bg-surface border border-border-base w-full max-w-md max-h-[90dvh] rounded-xl overflow-hidden flex flex-col shadow-2xl">
              <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border-base flex-shrink-0">
                <h3 className="text-lg font-bold text-content-primary flex items-center gap-1.5">
                  <Settings className="w-5 h-5 text-indigo-400" /> 修改账号
                </h3>
                <button
                  onClick={() => setEditingAccount(null)}
                  className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
                {/*
                  NOTE: 这三个输入框必须显式标注 autoComplete 与不像凭据的 name。
                  缺了这些提示，Chrome 密码管理器会把「API Secret」当成登录密码框，
                  再顺手把它上方最近的文本框（API Key）当成用户名一起填上——于是
                  只想改个别名时，两个密钥框会被静默填成登录用户名与登录密码。
                  这不只是要手动清空的麻烦：handleUpdateAccount 见到两个框都非空
                  就认定「要换密钥」，把填进去的登录凭据当新密钥送去校验，结果是
                  改别名直接失败在「无法验证新 API 密钥有效性」上。

                  和设置页的密码表单同一套解法：把密码框标成 new-password，表单内
                  就不存在可填充的凭据目标，Chrome 不会发起这次成对填充。
                */}
                <div>
                  <label className="block text-xs font-semibold text-content-muted mb-1.5">账户别名</label>
                  <input
                    type="text"
                    name="dnshe-account-alias"
                    autoComplete="off"
                    value={editAlias}
                    onChange={(e) => setEditAlias(e.target.value)}
                    placeholder="账户别名"
                    className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-content-muted mb-1.5">API Key（留空保持不变）</label>
                  <input
                    type="text"
                    name="dnshe-edit-api-key"
                    autoComplete="off"
                    value={editApiKey}
                    onChange={(e) => setEditApiKey(e.target.value)}
                    placeholder={`当前: ${maskApiKey(editingAccount.api_key)}`}
                    className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-content-muted mb-1.5">API Secret（留空保持不变）</label>
                  <PasswordInput
                    name="dnshe-edit-api-secret"
                    autoComplete="new-password"
                    value={editApiSecret}
                    onChange={setEditApiSecret}
                    placeholder="如需更换密钥则填写新的 API Secret"
                    className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                  />
                </div>
                <p className="text-[11px] text-content-muted leading-relaxed">
                  仅修改别名时无需填写密钥；更换 API Key/Secret 会校验新密钥有效性，并自动重新同步该账号的域名缓存。
                </p>

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => setEditingAccount(null)}
                    className="flex-1 h-10 bg-elevated hover:bg-hovered text-content-muted border border-border-base px-2.5 sm:px-4 rounded-lg text-sm whitespace-nowrap"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleUpdateAccount}
                    disabled={actionLoading === `update-account-${editingAccount.id}`}
                    className="flex-1 h-10 btn-primary px-2.5 sm:px-4 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                  >
                    {actionLoading === `update-account-${editingAccount.id}` ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <Save className="w-4 h-4" /> 保存修改
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 绑定账号弹窗（统一承载 DNSHE / Cloudflare 与 单个 / 批量） */}
        {bindModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md">
            <div className="bg-surface border border-border-base w-full max-w-lg max-h-[90dvh] rounded-xl overflow-hidden flex flex-col shadow-2xl">
              <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border-base flex-shrink-0">
                <h3 className="text-lg font-bold text-content-primary flex items-center gap-1.5">
                  {bindProvider === "cloudflare" ? (
                    <>
                      <Cloud className="w-5 h-5 text-sky-400" /> 绑定 Cloudflare 账号
                    </>
                  ) : (
                    <>
                      <Plus className="w-5 h-5 text-indigo-400" /> 绑定 DNSHE 账号
                    </>
                  )}
                </h3>
                <button
                  onClick={() => setBindModalOpen(false)}
                  className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
                {/* 提供商与方式切换 */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-content-muted mb-1.5">账号提供商</label>
                    <div className="grid grid-cols-2 gap-1 bg-elevated border border-border-base rounded-lg p-1">
                      <button
                        type="button"
                        onClick={() => setBindProvider("dnshe")}
                        className={`py-1.5 rounded-md text-xs font-semibold transition-all ${
                          bindProvider === "dnshe" ? "bg-indigo-600 text-white shadow" : "text-content-muted hover:text-content-primary"
                        }`}
                      >
                        DNSHE
                      </button>
                      <button
                        type="button"
                        onClick={() => setBindProvider("cloudflare")}
                        className={`py-1.5 rounded-md text-xs font-semibold transition-all ${
                          bindProvider === "cloudflare" ? "bg-sky-600 text-white shadow" : "text-content-muted hover:text-content-primary"
                        }`}
                      >
                        Cloudflare
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-content-muted mb-1.5">绑定方式</label>
                    <div className="grid grid-cols-2 gap-1 bg-elevated border border-border-base rounded-lg p-1">
                      <button
                        type="button"
                        onClick={() => setBindMode("single")}
                        className={`py-1.5 rounded-md text-xs font-semibold transition-all ${
                          bindMode === "single" ? "bg-indigo-600 text-white shadow" : "text-content-muted hover:text-content-primary"
                        }`}
                      >
                        单个绑定
                      </button>
                      <button
                        type="button"
                        onClick={() => setBindMode("batch")}
                        className={`py-1.5 rounded-md text-xs font-semibold transition-all ${
                          bindMode === "batch" ? "bg-emerald-600 text-white shadow" : "text-content-muted hover:text-content-primary"
                        }`}
                      >
                        批量绑定
                      </button>
                    </div>
                  </div>
                </div>

                {bindProvider === "dnshe" && bindMode === "single" && (
                  <form onSubmit={handleAddAccount} className="space-y-4 pt-1">
                    {/* NOTE: 与「修改账号」弹窗同理，避免 Chrome 把 API Key/Secret 当成登录凭据对填充 */}
                    <div>
                      <label className="block text-xs font-semibold text-content-muted mb-1.5">账户别名 (可选，留空自动解析)</label>
                      <input
                        type="text"
                        name="dnshe-bind-alias"
                        autoComplete="off"
                        placeholder="如：主账号、测试组"
                        value={newAlias}
                        onChange={(e) => setNewAlias(e.target.value)}
                        className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-content-muted mb-1.5">API Key</label>
                      <input
                        type="text"
                        required
                        name="dnshe-bind-api-key"
                        autoComplete="off"
                        placeholder="cfsd_xxxxxxxxxx"
                        value={newApiKey}
                        onChange={(e) => setNewApiKey(e.target.value)}
                        className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-content-muted mb-1.5">API Secret</label>
                      <PasswordInput
                        required
                        name="dnshe-bind-api-secret"
                        autoComplete="new-password"
                        placeholder="请输入 API Secret"
                        value={newApiSecret}
                        onChange={setNewApiSecret}
                        className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                      />
                    </div>
                    <p className="text-[11px] text-content-muted leading-relaxed">
                      别名留空时，系统会自动调用 DNSHE 密钥列表接口获取该 Key 的名称作为别名。
                    </p>

                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => setBindModalOpen(false)}
                        className="flex-1 h-10 bg-elevated hover:bg-hovered text-content-muted border border-border-base px-2.5 sm:px-4 rounded-lg text-sm whitespace-nowrap"
                      >
                        取消
                      </button>
                      <button
                        type="submit"
                        disabled={actionLoading === "add-account"}
                        className="flex-1 h-10 btn-primary px-2.5 sm:px-4 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                      >
                        {actionLoading === "add-account" ? (
                          <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <Plus className="w-4 h-4" /> 绑定账号
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                )}

                {bindProvider === "dnshe" && bindMode === "batch" && (
                  <div className="space-y-4 pt-1">
                    <p className="text-xs text-content-muted leading-relaxed">
                      每行填入一组 <span className="font-mono text-indigo-400">API Key + API Secret</span>（用空格 / Tab / 逗号分隔），别名自动从 API Key 解析，无需填写。
                    </p>
                    <div className="relative">
                      <textarea
                        ref={batchTextareaRef}
                        value={batchInput}
                        onChange={(e) => setBatchInput(e.target.value)}
                        rows={6}
                        spellCheck={false}
                        placeholder={"cfsd_xxxxxxxx1 你的secret1\ncfsd_xxxxxxxx2 你的secret2\ncfsd_xxxxxxxx3,你的secret3"}
                        className="w-full form-input px-3 py-2.5 rounded-lg text-sm font-mono text-content-secondary resize-none"
                        style={{ height: 160, transition: "none" }}
                      />
                      <div
                        onPointerDown={handleBatchResizeStart}
                        className="absolute bottom-0 right-1 h-4 w-10 cursor-ns-resize touch-none select-none flex items-center justify-center gap-[3px]"
                        title="拖拽调整高度"
                      >
                        <span className="block w-3.5 h-[3px] rounded-full bg-current opacity-50" />
                        <span className="block w-3.5 h-[3px] rounded-full bg-current opacity-50" />
                      </div>
                    </div>
                    <button
                      onClick={handleBatchAddAccounts}
                      disabled={actionLoading === "batch-add-accounts"}
                      className="w-full btn-primary py-2.5 rounded-lg font-semibold text-sm text-white flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {actionLoading === "batch-add-accounts" ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" /> 正在批量验证绑定…
                        </>
                      ) : (
                        <>
                          <Play className="w-4 h-4" /> 开始批量绑定 ({splitBatchLines(batchInput).length} 条)
                        </>
                      )}
                    </button>

                    {batchResults && batchResults.length > 0 && (
                      <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                        {batchResults.map((r, idx) => (
                          <div
                            key={idx}
                            className={`flex items-start justify-between gap-2 text-xs px-3 py-2 rounded-lg border ${
                              r.success
                                ? "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/10 dark:border-emerald-500/30 dark:text-emerald-300"
                                : "bg-red-50 border-red-200 text-red-700 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-300"
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="font-mono truncate">{r.api_key}</div>
                              {r.alias && <div className="text-content-muted truncate">别名: {r.alias}</div>}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {r.success ? <CheckCircle2 className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                              <span>{r.success ? "成功" : r.message}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {bindProvider === "cloudflare" && bindMode === "single" && (
                  <div className="space-y-4 pt-1">
                    <div>
                      <label className="block text-xs font-semibold text-content-muted mb-1.5">账户别名（可选，留空自动解析）</label>
                      <input
                        type="text"
                        name="cf-bind-alias"
                        autoComplete="off"
                        value={cfNewAlias}
                        onChange={(e) => setCfNewAlias(e.target.value)}
                        placeholder="留空将使用 Cloudflare 账号名称"
                        className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-content-muted mb-1.5">API Token</label>
                      <PasswordInput
                        name="cf-bind-token"
                        autoComplete="new-password"
                        value={cfNewToken}
                        onChange={setCfNewToken}
                        placeholder="粘贴 Cloudflare API Token"
                        className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary font-mono"
                      />
                    </div>
                    <p className="text-[11px] text-content-muted leading-relaxed">
                      在 Cloudflare 控制台「My Profile → API Tokens」创建 Token，权限需包含
                      <span className="font-mono text-content-secondary"> Zone:Read </span>与
                      <span className="font-mono text-content-secondary"> Zone DNS:Edit</span>
                      。Token 仅用于调用 Cloudflare 官方 API，绑定后会加密存储并校验有效性。
                    </p>

                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => setBindModalOpen(false)}
                        className="flex-1 h-10 bg-elevated hover:bg-hovered text-content-muted border border-border-base px-2.5 sm:px-4 rounded-lg text-sm whitespace-nowrap"
                      >
                        取消
                      </button>
                      <button
                        onClick={handleCfAddAccount}
                        disabled={actionLoading === "cf-add-account"}
                        className="flex-1 h-10 btn-primary px-2.5 sm:px-4 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                      >
                        {actionLoading === "cf-add-account" ? (
                          <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <Cloud className="w-4 h-4" /> 绑定账号
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {bindProvider === "cloudflare" && bindMode === "batch" && (
                  <div className="space-y-4 pt-1">
                    <p className="text-xs text-content-muted leading-relaxed">
                      每行填入一个 <span className="font-mono text-sky-400">API Token</span>（用空格 / Tab / 逗号 / 竖线分隔），可选择性跟随别名：
                      <span className="font-mono text-content-secondary">token 你的别名</span>。别名留空自动使用 Cloudflare 账号名称。
                    </p>
                    <textarea
                      value={cfBatchBindInput}
                      onChange={(e) => setCfBatchBindInput(e.target.value)}
                      rows={6}
                      spellCheck={false}
                      placeholder={"cfut_xxxxxxxxxxxx1 别名A\ncfut_xxxxxxxxxxxx2 别名B\ncfut_xxxxxxxxxxxx3"}
                      className="w-full form-input px-3 py-2.5 rounded-lg text-sm font-mono text-content-secondary resize-none"
                      style={{ height: 160 }}
                    />
                    <button
                      onClick={handleCfBatchAddAccounts}
                      disabled={actionLoading === "cf-batch-add-accounts"}
                      className="w-full btn-primary py-2.5 rounded-lg font-semibold text-sm text-white flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {actionLoading === "cf-batch-add-accounts" ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" /> 正在批量验证绑定…
                        </>
                      ) : (
                        <>
                          <Play className="w-4 h-4" /> 开始批量绑定 ({splitBatchLines(cfBatchBindInput).length} 条)
                        </>
                      )}
                    </button>

                    {cfBatchBindResults && cfBatchBindResults.length > 0 && (
                      <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                        {cfBatchBindResults.map((r, idx) => (
                          <div
                            key={idx}
                            className={`flex items-start justify-between gap-2 text-xs px-3 py-2 rounded-lg border ${
                              r.success
                                ? "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/10 dark:border-emerald-500/30 dark:text-emerald-300"
                                : "bg-red-50 border-red-200 text-red-700 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-300"
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="font-mono truncate">{r.api_key}</div>
                              {r.alias && <div className="text-content-muted truncate">别名: {r.alias}</div>}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {r.success ? <CheckCircle2 className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                              <span>{r.success ? "成功" : r.message}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {bankModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md">
            <div className="bg-surface border border-border-base w-full max-w-lg max-h-[90dvh] rounded-xl overflow-hidden flex flex-col shadow-2xl">
              <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border-base flex-shrink-0">
                <h3 className="text-lg font-bold text-content-primary flex items-center gap-1.5">
                  {editingBank ? (
                    <>
                      <Pencil className="w-5 h-5 text-indigo-400" /> 编辑词库
                    </>
                  ) : (
                    <>
                      <Plus className="w-5 h-5 text-indigo-400" /> 新建词库
                    </>
                  )}
                </h3>
                <button
                  onClick={() => setBankModalOpen(false)}
                  className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
                <div>
                  <label className="block text-xs font-semibold text-content-muted mb-1.5">
                    词库类型
                  </label>
                  <select
                    value={bankFormKind}
                    onChange={(e) => setBankFormKind(e.target.value as BankKind)}
                    className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                  >
                    {(Object.keys(BANK_KIND_META) as BankKind[]).map((k) => (
                      <option key={k} value={k}>
                        {BANK_KIND_META[k].label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-content-muted mb-1.5">
                    词库名称
                  </label>
                  <input
                    type="text"
                    placeholder="如：热门城市 / 5字母单词 / 我的收藏"
                    value={bankFormName}
                    onChange={(e) => setBankFormName(e.target.value)}
                    className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-content-muted mb-1.5">
                    词条内容
                    <span className="font-normal ml-1">
                      (用逗号、空格或换行分隔，保存时自动去重)
                    </span>
                  </label>
                  <textarea
                    rows={8}
                    placeholder={"如：\n北京, 上海, 广州\n或每行一个词"}
                    value={bankFormWords}
                    onChange={(e) => setBankFormWords(e.target.value)}
                    className="w-full form-input px-3 py-2.5 rounded-lg text-sm text-content-secondary font-mono resize-y"
                  />
                  <p className="text-[11px] text-content-muted mt-1.5">
                    当前解析出 <span className="text-indigo-400 font-bold">{parseWords(bankFormWords).length}</span> 个词条
                  </p>
                </div>
              </div>

              <div className="bg-elevated px-6 py-4 flex items-center justify-end gap-3 border-t border-border-base">
                <button
                  onClick={() => setBankModalOpen(false)}
                  className="px-4 py-2 text-sm font-semibold text-content-secondary hover:text-content-primary bg-surface hover:bg-hovered border border-border-base rounded-lg transition-all"
                >
                  取消
                </button>
                <button
                  onClick={handleSaveBank}
                  className="px-5 py-2 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-all shadow-lg flex items-center gap-2"
                >
                  <Save className="w-4 h-4" />
                  {editingBank ? "保存修改" : "创建词库"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: 账户配额 */}
        {activeTab === "quota" && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4 sm:mb-6">
              <h2 className="text-base sm:text-lg font-bold text-content-primary">各账户域名配额概览</h2>
              <button
                onClick={() => fetchQuotas(true)}
                disabled={loadingQuotas}
                className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-3 py-2 sm:py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 disabled:opacity-60 flex-shrink-0"
                title="强制从 DNSHE 重新拉取配额"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingQuotas ? "animate-spin" : ""}`} />
                刷新
              </button>
            </div>
            
            {loadingQuotas ? (
              <div className="flex justify-center py-20">
                <RefreshCw className="w-8 h-8 animate-spin text-indigo-500" />
              </div>
            ) : quotas.length === 0 ? (
              <div className="text-center py-20 border border-dashed border-border-base rounded-xl bg-surface">
                <Database className="w-12 h-12 text-content-muted mx-auto mb-3" />
                <p className="text-content-muted">没有查到配额数据。请确保至少绑定了一个账户，并且密钥配置无误。</p>
              </div>
            ) : (
              /* 手机 1 列 → 平板 2 → 桌面 3 → 宽屏 4（用户 2026-09-30 第15轮：「移动端的账户配额页
                 也改为一列布局」）。手机 1 列同时消掉了窄卡片溢出：2 列时卡片仅 122px，
                 底部「可用/已用/总配额」每列约 24px，而「总配额」需要 33px（实测溢出 9px）。 */
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-6">
                {filteredQuotas.map((q, idx) => {
                  if (q.error) {
                    return (
                      <div key={idx} className="bg-red-50 border border-red-200 dark:bg-red-950/20 dark:border-red-900/50 rounded-xl p-4 sm:p-5">
                        <h3 className="font-bold text-red-700 dark:text-red-400 truncate">{q.alias}</h3>
                        <p className="text-red-800 dark:text-red-300 text-sm mt-2 flex items-start gap-1.5">
                          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                          <span className="min-w-0 break-words">API 调用异常: {q.error}</span>
                        </p>
                      </div>
                    );
                  }

                  const percent = q.total > 0 ? Math.round((q.used / q.total) * 100) : 0;

                  return (
                    <div key={q.account_id} className="glass-card rounded-xl p-4 sm:p-5 border border-border-base">
                      <div className="flex justify-between items-center gap-2 mb-4">
                        <h3 className="font-bold text-content-primary text-sm sm:text-lg truncate min-w-0">{q.alias}</h3>
                        {/* 可用数已经移到卡片底部三项里，这里不再重复一个「可用: N」徽章 */}
                      </div>

                      {/* 环形/条形进度展示 */}
                      <div className="space-y-3">
                        {/* NOTE: 原来写「已用子域名: 16 / 16」，手机 2 列时这一行放不下会折成两行
                            （用户 2026-09-30 指出）——「子域名」三字是多余的（页面就叫域名配额），
                            去掉后连同空格收窄约 40px，390px 下稳定单行。两侧都加 nowrap 兜底。 */}
                        <div className="flex justify-between items-baseline gap-2 text-xs text-content-muted">
                          <span className="whitespace-nowrap">已用域名: {q.used}/{q.total}</span>
                          <span className="whitespace-nowrap flex-shrink-0">{percent}%</span>
                        </div>
                        <div className="w-full bg-elevated h-2 rounded-full overflow-hidden">
                          <div 
                            className={`h-full rounded-full transition-all duration-500 ${
                              percent > 85 ? "bg-red-500" : percent > 60 ? "bg-amber-500" : "bg-indigo-500"
                            }`} 
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-2 mt-6 pt-4 border-t border-border-base text-center">
                        {/* NOTE: 上游这里原本是「基础配额 / 邀请赠送 / 总配额」。
                            实测 DNSHE 的 total 恒等于 base（邀请赠送并不计入 total），
                            三个数里有两个永远一样 —— 显示出来只会让人怀疑算错。
                            改成真正有信息量的「可用 / 已用 / 总」。 */}
                        <div>
                          <span className="block text-[11px] text-content-muted whitespace-nowrap">可用</span>
                          <span className={`text-sm font-semibold ${q.available <= 0 ? "text-red-400" : "text-emerald-400"}`}>
                            {q.available}
                          </span>
                        </div>
                        <div>
                          <span className="block text-[11px] text-content-muted whitespace-nowrap">已用</span>
                          <span className="text-sm font-semibold text-amber-400">{q.used}</span>
                        </div>
                        <div>
                          <span className="block text-[11px] text-content-muted whitespace-nowrap">总配额</span>
                          <span className="text-sm font-semibold text-content-primary">{q.total}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Tab 4: 运行日志 */}
        {activeTab === "logs" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base sm:text-lg font-bold text-content-primary">运行日志 (最近100条)</h2>
              <button
                onClick={handleClearLogs}
                disabled={actionLoading === "clear-logs"}
                className="bg-red-50 hover:bg-red-100 text-red-700 hover:text-red-800 border border-red-200 dark:bg-red-950/60 dark:hover:bg-red-900/60 dark:text-red-400 dark:hover:text-red-200 dark:border-red-900/50 px-3 py-2 sm:py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all flex-shrink-0"
              >
                清空运行日志
              </button>
            </div>

            {/* 日志分类子标签
                §14 均分规则：窄屏一行四等分撑满（390px 实测每格 85.5px，内容 66px，放得下）；
                ≥sm 回到按内容宽度的紧凑排列（四个小筛选块拉满整行反而难看）。
                NOTE: 原来是 `flex flex-wrap` + `py-2` —— 手机上随缘折成 3+1，
                且 36px 高不达 §9 的 40px 触控下限。 */}
            <div className="grid grid-cols-4 gap-2 sm:flex sm:w-fit">
              {([
                { key: "all", label: "全部", icon: <ScrollText className="w-4 h-4" /> },
                { key: "auth", label: "登录", icon: <LogIn className="w-4 h-4" /> },
                { key: "api", label: "API", icon: <Server className="w-4 h-4" /> },
                { key: "operation", label: "操作", icon: <Activity className="w-4 h-4" /> },
              ] as const).map((t) => (
                <button
                  key={t.key}
                  onClick={() => setLogCategory(t.key)}
                  className={`flex items-center justify-center gap-1.5 px-2 sm:px-4 h-10 rounded-lg text-sm font-semibold whitespace-nowrap transition-all ${
                    logCategory === t.key
                      ? "bg-indigo-600 text-white"
                      : "bg-elevated text-content-muted hover:text-content-primary hover:bg-hovered border border-border-base"
                  }`}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </div>

            {loadingLogs ? (
              <div className="flex justify-center py-20">
                <RefreshCw className="w-6 h-6 animate-spin text-indigo-500" />
              </div>
            ) : filteredLogs.length === 0 ? (
              <div className="text-center py-20 border border-dashed border-border-base rounded-xl bg-surface">
                <ScrollText className="w-12 h-12 text-content-muted mx-auto mb-3" />
                <p className="text-content-muted">该分类下暂无运行日志</p>
              </div>
            ) : (
              <>
                {/* ≥md：保持原有 4 列表格（固定列宽合计 416px + p-4 内边距，在手机上必然横向溢出） */}
                <div className="hidden md:block bg-surface border border-border-base rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm border-collapse">
                      <thead>
                        <tr className="bg-elevated text-content-muted text-xs border-b border-border-base">
                          <th className="p-4 w-44">时间</th>
                          <th className="p-4 w-28 text-center">类型</th>
                          <th className="p-4 w-32 text-center">模块</th>
                          <th className="p-4">描述信息</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-soft font-medium">
                        {filteredLogs.map((log) => {
                          const parts = logRowParts(log);
                          return (
                            <tr key={log.id} className="hover:bg-hovered transition-colors">
                              <td className="p-4 text-xs text-content-muted font-mono">{parts.time}</td>
                              <td className="p-4 text-xs text-center">{parts.badge}</td>
                              <td className="p-4 text-xs text-content-secondary font-semibold capitalize text-center">
                                {log.category}
                              </td>
                              <td className="p-4 text-content-secondary">
                                <div>{log.message}</div>
                                {parts.details}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* <md：每条日志一张卡片，字段纵向堆叠 */}
                <div className="md:hidden space-y-2">
                  {filteredLogs.map((log) => {
                    const parts = logRowParts(log);
                    return (
                      <div
                        key={log.id}
                        className="bg-surface border border-border-base rounded-xl p-3 space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2 text-xs">
                          {parts.badge}
                          <span className="text-content-muted font-mono truncate">{parts.time}</span>
                        </div>
                        <div className="text-sm text-content-secondary break-words">{log.message}</div>
                        <div className="flex items-center gap-1.5 text-[11px] text-content-muted">
                          <Server className="w-3 h-3 flex-shrink-0" />
                          <span className="capitalize">{log.category}</span>
                        </div>
                        {parts.details}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* Tab 7: 设置 */}
        {activeTab === "settings" && (
          /* NOTE: 不要在这里写 max-w-*。CSS 多列布局的列宽由容器宽度决定，
                     容器一被限宽，两列就跟着变窄、右侧留出大片空白（用户截图里就是这个问题）。
                     手机端 columns-2 不会生效（只有 lg: 前缀），所以窄屏天然还是单列。 */
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-black text-content-primary flex items-center gap-2">
                <Settings className="w-6 h-6 text-indigo-500" /> 设置
              </h2>
              <p className="text-content-muted mt-1 text-sm">系统配置、通知渠道与自动续期策略</p>
            </div>

            {loadingSettings ? (
              <div className="flex justify-center py-20">
                <RefreshCw className="w-6 h-6 animate-spin text-indigo-500" />
              </div>
            ) : (
              /* 桌面端两列均分（items-start 让两列各自按内容高度收拢，不被最高的一张拉平） */
              <>
              {/* 搜索命中 0 条时必须有反馈（§8：不能静默）—— 否则卡片全被 hidden 掉，
                  页面只剩下面那个「保存全部设置」，看起来像所有设置项都丢了 */}
              {isSettingsSearchActive && settingsHitCount === 0 && (
                <div className="text-center py-16 border border-dashed border-border-base rounded-xl bg-surface">
                  <Search className="w-10 h-10 text-content-muted mx-auto mb-3" />
                  <p className="text-content-muted text-sm">没有匹配「{globalSearch.trim()}」的设置项</p>
                  <p className="text-xs text-content-muted mt-1">
                    可试试：后端地址 / 密码 / 两步验证 / 续期 / 渠道
                  </p>
                </div>
              )}
              {/* 桌面端两列：每列各自是一根纵向 flex 柱，卡片之间用父级 gap 留白。
                  🔴 不能用 `space-y-*` 做间距：Tailwind 的 space-y 会给「所有非首元素」
                  注入 `margin-bottom: 0`，把卡片自己的 `mb-6` 覆盖掉 —— 实测「账户安全 →
                  自动续期」与「解析线路支持名单 → 通知渠道」的间距因此都变成 0px。
                  也不能用 CSS 多列（columns-2）：那是瀑布流，两列高度天然不齐
                  （实测 1440 下差 191px），做不到「两列底部对齐」。
                  现在 grid 两列 + 每列 flex-col + 末卡 `lg:flex-1` 吸收剩余高度 ⇒ 两列底部齐平。
                  搜索过滤时降为单列：整列被过滤掉的列容器会 hidden，避免留一个空列。 */}
              <div className={`grid grid-cols-1 gap-5 sm:gap-6 items-stretch ${isSettingsSearchActive ? "" : "lg:grid-cols-2"}`}>
                {/* 左列：后端地址 / 账户安全 / 自动续期 */}
                <div className={`flex flex-col gap-5 sm:gap-6 ${settingsLeftColVisible ? "" : "hidden"}`}>
                {/* NOTE: 这里原有一个「外观 / 主题模式」卡片，与顶栏的太阳/月亮切换按钮
                    完全同源（都改 theme 这一个 state），属重复入口，已移除。
                    主题切换保留在顶栏，任何页面都能直接点到，不必先进设置页。 */}

                {/* 后端地址 */}
                <div
                  id="settings-backend"
                  className={`bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-4 ${settingsSectionVisible("settings-backend") ? "" : "hidden"}`}
                >
                  <h3 className="font-bold text-content-primary flex items-center gap-2">
                    <Server className="w-4 h-4 text-indigo-400" /> 后端地址
                  </h3>

                  {backendUrlEditing ? (
                    <div>
                      <label className="text-sm font-semibold text-content-primary">后端 Worker 地址</label>
                      {/*
                        NOTE: 第一行只放输入框、第二行放「保存 / 取消」两等分 —— 用户 2026-09-30 第16轮原话：
                              「保存和取消功能控件移除，其实可在第二行显示均分控件 保存、取消」。
                        原来三个控件挤在同一个 flex 行里：输入框被两个按钮吃掉一半宽度，
                        而按钮又各自靠右，跟上面的 label 完全不对齐；窄屏一折行还会变成
                        「输入框一行 + 两个按钮一行」但**宽度不相等**（按钮按内容宽，不是均分）。
                        现在第二行用 `grid grid-cols-2`，两个按钮严格各占一半、合起来正好等于
                        上面输入框的宽度（§14 第 1 条：控件放不下时按对称切分，2 个控件只能 1+1）。
                      */}
                      <input
                        value={backendUrlInput}
                        onChange={(e) => setBackendUrlInput(e.target.value)}
                        placeholder="https://dnshe-panel.<子域>.workers.dev"
                        className="form-input w-full mt-2 px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                      />
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <button
                          onClick={handleSaveBackendUrl}
                          className="btn-primary h-10 px-3 rounded-lg text-sm font-bold text-white flex items-center justify-center gap-1.5 whitespace-nowrap"
                        >
                          <Save className="w-4 h-4 flex-shrink-0" /> 保存
                        </button>
                        <button
                          onClick={handleCancelBackendUrl}
                          className="h-10 px-3 rounded-lg text-sm font-semibold whitespace-nowrap bg-elevated hover:bg-hovered text-content-secondary border border-border-base"
                        >
                          取消
                        </button>
                      </div>
                      <p className="text-xs text-content-muted mt-2">保存后刷新页面生效；清空保存可恢复自动推演。</p>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-sm min-w-0">
                        {backendUrl ? (
                          <>
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                            <span className="text-content-primary">已配置自定义后端地址</span>
                          </>
                        ) : (
                          <>
                            <Info className="w-4 h-4 text-content-muted flex-shrink-0" />
                            <span className="text-content-muted">未配置，使用自动推演</span>
                          </>
                        )}
                      </div>
                      <button
                        onClick={() => { setBackendUrlInput(localStorage.getItem("DNSHE_BACKEND_URL") || ""); setBackendUrlEditing(true); }}
                        className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 hover:text-indigo-800 border border-indigo-200 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/60 dark:text-indigo-400 dark:hover:text-indigo-200 dark:border-indigo-900/50 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 flex-shrink-0"
                      >
                        <Pencil className="w-3.5 h-3.5" /> {backendUrl ? "修改" : "配置"}
                      </button>
                    </div>
                  )}
                </div>

                {/* 账户安全：修改密码 + 两步验证 */}
                <div
                  id="settings-security"
                  className={`bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-5 ${settingsSectionVisible("settings-security") ? "" : "hidden"}`}
                >
                  <h3 className="font-bold text-content-primary flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" /> 账户安全
                  </h3>

                  {/* 当前账户 */}
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-content-muted flex-shrink-0">当前管理员</span>
                    <span className="font-mono font-semibold text-content-primary flex items-center gap-1.5 min-w-0">
                      <UserCheck className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                      <span className="truncate">{accountInfo.username || "—"}</span>
                    </span>
                  </div>

                  {/* 修改密码 */}
                  <div className="space-y-3 pt-3 border-t border-border-soft">
                    <div className="text-sm font-semibold text-content-primary flex items-center gap-1.5">
                      <Key className="w-4 h-4 text-amber-400" /> 修改登录密码
                    </div>
                    {/*
                      NOTE: 这里刻意不用 autoComplete="current-password" / "username"。
                      Chrome 是「成对」填充凭据的：只要表单里存在一个 current-password
                      目标，它就会连带去找用户名字段填上。上一版把这两个语义标注补齐后，
                      填充确实不再跑到页头搜索框，但改成精准落进「原密码 + 同时修改用户名」，
                      等于换了个地方犯同样的毛病——修改密码表单被预填本来就不是我们想要的。
                      把三个密码框统一标成 new-password（表单内不存在可填充的凭据目标），
                      Chrome 就不会发起这次凭据填充，也就不会再去找用户名字段。
                      name 也故意取成不像 username 的值，避免命中它的启发式。
                    */}
                    <PasswordInput
                      name="dnshe-old-password"
                      autoComplete="new-password"
                      value={pwOld}
                      onChange={setPwOld}
                      placeholder="原密码"
                      className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <PasswordInput
                        name="dnshe-new-password"
                        autoComplete="new-password"
                        value={pwNew}
                        onChange={setPwNew}
                        placeholder="新密码（至少 8 位）"
                        className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                      />
                      <PasswordInput
                        name="dnshe-new-password-confirm"
                        autoComplete="new-password"
                        value={pwNew2}
                        onChange={setPwNew2}
                        placeholder="确认新密码"
                        className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                      />
                    </div>
                    <input
                      type="text"
                      name="dnshe-rename"
                      autoComplete="off"
                      value={pwNewUsername}
                      onChange={(e) => setPwNewUsername(e.target.value)}
                      placeholder={`同时修改用户名（可选，当前：${accountInfo.username || "admin"}）`}
                      className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                    />
                    <div className="flex justify-end">
                      <button
                        onClick={handleChangePassword}
                        disabled={actionLoading === "change-pw"}
                        /* 移动端通栏：孤零零半截按钮浮在右下角很突兀，通栏才像「提交这一组表单」 */
                        className="btn-primary w-full sm:w-auto sm:justify-end px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5 disabled:opacity-50"
                      >
                        <Save className="w-4 h-4" /> 保存新密码
                      </button>
                    </div>
                    <p className="text-[11px] text-content-muted">修改成功后当前会话将失效，需用新凭据重新登录。</p>
                  </div>

                  {/* 两步验证 (2FA)
                      移动端适配：状态徽章贴在小标题右侧，「开启」按钮同一行靠右
                      —— 说明文字独占一行，不跟控件抢宽度 */}
                  <div className="space-y-3 pt-3 border-t border-border-soft">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                        <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                        <span className="text-sm font-semibold text-content-primary">两步验证 (2FA / TOTP)</span>
                        <span className={`text-xs px-2.5 py-1 rounded-full font-semibold whitespace-nowrap flex-shrink-0 ${accountInfo.two_fa_enabled ? "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/80 dark:text-emerald-400 dark:border-emerald-900/60" : "bg-elevated text-content-muted border border-border-base"}`}>
                          {accountInfo.two_fa_enabled ? "已开启" : "未开启"}
                        </span>
                      </div>
                      {!accountInfo.two_fa_enabled && !twoFaSetup && (
                        <button
                          onClick={handleStart2faSetup}
                          disabled={actionLoading === "2fa-setup"}
                          className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50 flex-shrink-0"
                        >
                          <ShieldCheck className="w-4 h-4 text-emerald-400" /> 开启两步验证
                        </button>
                      )}
                    </div>
                    <div className="text-xs text-content-muted -mt-1">开启后登录需额外输入身份验证器的 6 位动态码</div>

                    {/* 未开启且已点了「开启两步验证」：展示密钥/二维码 + 动态码确认 */}
                    {!accountInfo.two_fa_enabled && twoFaSetup && (
                      <div className="bg-elevated border border-border-base rounded-xl p-4 space-y-3">
                            <p className="text-xs text-content-secondary leading-relaxed">
                              1. 用身份验证器（Google / Microsoft Authenticator）扫描下方二维码：
                            </p>
                            <div className="flex justify-center py-2">
                              <div className="bg-white p-3 rounded-xl">
                                <QRCodeSVG value={twoFaSetup.otpauth_uri} size={176} level="M" includeMargin={false} />
                              </div>
                            </div>
                            <p className="text-[11px] text-content-muted">
                              无法扫码时，可在验证器中手动录入以下密钥：
                            </p>
                            {/*
                              NOTE: 密钥块改为**点击即可复制**（2026-09-30 第17轮用户要求）。
                              外观与改造前完全一致（自动高度 + py-2 + break-all，长密钥允许折行），
                              只补上 cursor-pointer / hover 边框高亮 / 点击态，让"可点"这件事看得出来。
                              ⚠️ 不能用 h-10 固定高度：32 位密钥在 280px 窄屏会折成两行，写死 40px 会被裁掉。
                            */}
                            <button
                              type="button"
                              onClick={() => copyToClipboard(twoFaSetup.secret, "2FA 密钥")}
                              title="点击复制密钥"
                              className="w-full font-mono text-sm bg-surface border border-border-base rounded-lg px-3 py-2 break-all text-indigo-400 select-all text-center tracking-wider cursor-pointer hover:border-indigo-400/60 hover:bg-hovered active:scale-[0.99] transition-all"
                            >
                              {twoFaSetup.secret}
                            </button>
                            <p className="text-xs text-content-secondary">2. 输入验证器当前显示的 6 位动态码以完成开启：</p>
                            {/*
                              NOTE: 与「后端地址」同一套形状 —— 输入框第一行独占，动作按钮第二行两等分。
                              用户 2026-09-30 第16轮原话：「确认开启、取消 也改为一行两个控件均分撑满，
                              对齐上面的输入框」。原来 `flex flex-wrap` 里输入框 `flex-1`、
                              两个按钮按内容宽靠右，窄屏折行后两按钮宽度还不相等。
                            */}
                            <input
                              type="text"
                              inputMode="numeric"
                              maxLength={6}
                              value={twoFaEnableToken}
                              onChange={(e) => setTwoFaEnableToken(e.target.value.replace(/\D/g, ""))}
                              placeholder="6 位动态码"
                              className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                            />
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                onClick={handleEnable2fa}
                                disabled={actionLoading === "2fa-enable"}
                                className="btn-primary h-10 px-3 rounded-lg text-sm font-bold text-white flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                              >
                                <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> 确认开启
                              </button>
                              <button
                                onClick={() => { setTwoFaSetup(null); setTwoFaEnableToken(""); }}
                                className="h-10 px-3 rounded-lg text-sm font-semibold whitespace-nowrap bg-elevated hover:bg-hovered text-content-secondary border border-border-base"
                              >
                                取消
                              </button>
                            </div>
                      </div>
                    )}

                    {/* 已开启：输入当前动态码确认关闭 */}
                    {accountInfo.two_fa_enabled && (
                      <div className="flex flex-wrap gap-2">
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          value={twoFaDisableToken}
                          onChange={(e) => setTwoFaDisableToken(e.target.value.replace(/\D/g, ""))}
                          placeholder="输入身份验证器当前 6 位动态码"
                          className="form-input flex-1 px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                        />
                        <button
                          onClick={handleDisable2fa}
                          disabled={actionLoading === "2fa-disable"}
                          className="bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 dark:bg-red-500/10 dark:hover:bg-red-500/20 dark:text-red-400 dark:border-red-500/30 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
                        >
                          关闭 2FA
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* 自动续期 */}
                <div
                  id="settings-renew"
                  className={`bg-surface border border-border-base rounded-2xl p-4 sm:p-5 lg:flex-1 space-y-4 ${settingsSectionVisible("settings-renew") ? "" : "hidden"}`}
                >
                  <h3 className="font-bold text-content-primary flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 text-emerald-400" /> 自动续期
                  </h3>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-content-primary">启用自动续期</div>
                      <div className="text-xs text-content-muted mt-0.5">定时任务自动为即将到期的域名续期</div>
                    </div>
                    <button
                      onClick={() => setSettings((s) => ({ ...s, auto_renew: s.auto_renew === "1" ? "0" : "1" }))}
                      className={`w-12 h-6 rounded-full transition-all relative flex-shrink-0 ${settings.auto_renew === "1" ? "bg-indigo-600" : "bg-elevated border border-border-base"}`}
                    >
                      <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${settings.auto_renew === "1" ? "left-6" : "left-0.5"}`} />
                    </button>
                  </div>
                  <div className="pt-2 border-t border-border-soft">
                    <label className="text-sm font-semibold text-content-primary">续期阈值（天）</label>
                    <p className="text-xs text-content-muted mt-0.5 mb-2">剩余有效期低于此值时触发续期；续期结果（成功 / 失败）会通过通知渠道推送</p>
                    <input
                      type="number"
                      value={settings.renew_threshold_days}
                      onChange={(e) => setSettings((s) => ({ ...s, renew_threshold_days: e.target.value }))}
                      className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary"
                    />
                  </div>
                </div>
                </div>

                {/* 右列：解析线路支持名单 / 通知渠道（这两张卡最长，放同一列）
                    NOTE: 卡片自身的缩进没有跟着列容器再加一级 —— 只补了包裹标签。
                          重排这 500 行的缩进会让本轮 diff 完全失去可读性。 */}
                <div className={`flex flex-col gap-5 sm:gap-6 ${settingsRightColVisible ? "" : "hidden"}`}>

                {/* 解析线路支持名单 */}
                <div
                  id="settings-line-ns"
                  className={`bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-4 ${settingsSectionVisible("settings-line-ns") ? "" : "hidden"}`}
                >
                  {/*
                    NOTE: 「恢复默认」原来跟输入框、添加按钮挤在同一个表单行里 —— 它是**整份覆盖名单**
                    的破坏性动作，却长得像第三个同级控件，且三者的高度/字号互不相同
                    （输入框 h-10 text-sm，两个按钮 text-xs py-2 ≈ 32px，同行不等高，违反 §13/§18）。
                    用户 2026-09-30 第16轮原话：「恢复默认控件应该直接放在…卡片的右上角，不要单独一行」。
                    现在它挪到标题行右侧，与标题同一行；点击先弹二次确认框。
                  */}
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-bold text-content-primary flex items-center gap-2 min-w-0">
                      <Server className="w-4 h-4 text-sky-600 dark:text-sky-400 flex-shrink-0" />
                      <span className="truncate">解析线路支持名单</span>
                    </h3>
                    <button
                      onClick={() => setRestoreNsConfirmOpen(true)}
                      className="h-10 px-3 rounded-lg text-sm font-semibold whitespace-nowrap flex items-center gap-1.5 flex-shrink-0 bg-elevated hover:bg-hovered text-content-secondary border border-border-base"
                      title="把名单恢复为面板内置的默认值（会覆盖当前手工维护的名单）"
                    >
                      <RotateCcw className="w-4 h-4 flex-shrink-0" /> 恢复默认
                    </button>
                  </div>
                  <p className="text-xs text-content-muted leading-relaxed">
                    上游 API 没有「域名是否支持按线路解析」的字段，本面板按根域名的
                    <span className="font-mono text-indigo-600 dark:text-indigo-400"> NS 记录 </span>
                    判断：NS 落在下列后缀内（即该根域托管在提供线路解析的 DNS 商），其下域名就可以选择
                    电信 / 联通 / 移动 / 海外 / 教育网，其余只能保持默认。上游对不支持的域名会
                    <b>静默忽略</b>线路参数而不报错，所以这里主动拦住，避免出现「设了线路却没生效」。
                    NS 由后端查询并缓存 30 天。
                  </p>

                  <div className="flex flex-wrap gap-2">
                    {lineNsSuffixes.length === 0 ? (
                      <span className="text-xs text-content-muted">名单为空，所有域名都会按「不支持线路」处理</span>
                    ) : (
                      lineNsSuffixes.map((sfx) => (
                        <span
                          key={sfx}
                          className="group flex items-center bg-sky-50 border border-sky-200 text-sky-700 dark:bg-sky-950/30 dark:border-sky-500/30 dark:text-sky-300 text-xs rounded-lg overflow-hidden"
                        >
                          <span className="px-2.5 py-1 font-mono">*.{sfx}</span>
                          <button
                            onClick={() => handleRemoveLineNsSuffix(sfx)}
                            className="px-1.5 py-1 text-sky-500/70 hover:text-sky-800 hover:bg-sky-100 border-l border-sky-200 dark:text-sky-400/60 dark:hover:text-sky-300 dark:hover:bg-sky-900/40 dark:border-sky-500/30 transition-all"
                            title={`从名单移除 ${sfx}`}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))
                    )}
                  </div>

                  {/*
                    NOTE: 输入框与「添加」必须同高同字号（§13/§18 A 档 = h-10 text-sm）。
                    原先输入框是 h-10 text-sm，而「添加 / 恢复默认」是 text-xs + py-2（≈32px），
                    一行里三种规格，用户原话「都没有统一号」。
                    宽度：输入框 `flex-1 min-w-0`（flex 子项默认 min-width:auto，不写 min-w-0
                    它在 280px 上不会真的收缩），按钮 `flex-shrink-0` ——
                    这样**任何宽度下都保持一行**，不会折不等的行（§14 第 1 条）。
                  */}
                  <form onSubmit={handleAddLineNsSuffix} className="flex items-center gap-2">
                    <input
                      type="text"
                      name="dnshe-line-ns-suffix"
                      autoComplete="off"
                      value={newLineNsInput}
                      onChange={(e) => setNewLineNsInput(e.target.value)}
                      placeholder="NS 后缀，如 alidns.com，可一次填多个（逗号 / 空格分隔）"
                      className="form-input flex-1 min-w-0 px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                    />
                    <button
                      type="submit"
                      className="btn-primary h-10 px-3 sm:px-4 rounded-lg text-sm font-bold text-white flex items-center justify-center gap-1.5 flex-shrink-0 whitespace-nowrap"
                    >
                      <Plus className="w-4 h-4 flex-shrink-0" /> 添加
                    </button>
                  </form>

                  {knownRootDomains.length > 0 && (
                    <div className="pt-3 border-t border-border-soft space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-content-secondary">各根域名的 NS 与判定结果</div>
                        <div className="flex items-center gap-2">
                          {learnedLineRoots.length > 0 && (
                            <button
                              onClick={handleClearLearnedLineRoots}
                              className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-2.5 py-1 rounded-lg text-[11px] font-semibold flex-shrink-0"
                              title="清空「实测已确认」标记，让判定完全回到 NS 名单"
                            >
                              清空实测标记
                            </button>
                          )}
                          <button
                            onClick={handleRefreshRootNs}
                            disabled={actionLoading === "ns-lookup"}
                            className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-2.5 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 flex-shrink-0 disabled:opacity-50"
                          >
                            <RefreshCw className={`w-3 h-3 ${actionLoading === "ns-lookup" ? "animate-spin" : ""}`} />
                            重新查询 NS
                          </button>
                        </div>
                      </div>
                      {knownRootDomains.map((root) => {
                        const ns = rootNs[root];
                        const learned = learnedLineRoots.includes(root);
                        const on = learned || (!!ns && ns.length > 0 && ns.some(nsHostMatchesSuffix));
                        // NS 尚未查到时判定实际走 provider_account_id 兜底，标注出来免得用户以为面板失灵
                        const unknown = !ns || ns.length === 0;
                        return (
                          <div key={root} className="text-[11px] font-mono flex flex-wrap items-baseline gap-x-2">
                            <span className={on ? "text-sky-700 dark:text-sky-300 font-bold" : "text-content-muted"}>
                              {root}
                            </span>
                            <span className="text-content-muted">→</span>
                            <span className="text-content-secondary break-all">
                              {unknown ? "NS 未知（判定回退到服务商 ID）" : ns!.join("、")}
                            </span>
                            {on && <span className="text-[10px] text-sky-700 dark:text-sky-300">（支持线路）</span>}
                            {learned && <span className="text-[10px] text-emerald-700 dark:text-emerald-300">（实测已确认）</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 通知 */}
                <div
                  id="settings-notify"
                  className={`bg-surface border border-border-base rounded-2xl p-4 sm:p-5 lg:flex-1 space-y-4 ${settingsSectionVisible("settings-notify") ? "" : "hidden"}`}
                >
                  <h3 className="font-bold text-content-primary flex items-center gap-2">
                    <Bell className="w-4 h-4 text-amber-400" /> 通知渠道
                  </h3>

                  {/* 渠道选择：Telegram 已于 2026-09-30 并入这里。
                      原来 Telegram 是独立一块，而且后端**无条件**补发一份 —— 选「邮箱」也会收到 TG 消息，
                      界面上却看不出来。现在「选哪个就发哪个」，默认邮箱。 */}
                  <div className="space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <label htmlFor="notify-channel" className="text-sm font-semibold text-content-primary">
                        渠道选择
                      </label>
                      <select
                        id="notify-channel"
                        value={settings.webhook_type}
                        onChange={(e) => setSettings((s) => ({ ...s, webhook_type: e.target.value }))}
                        className="form-input w-full sm:w-56 px-3 h-10 rounded-lg text-sm text-content-primary"
                      >
                        <option value="email">邮箱 (SMTP)</option>
                        <option value="telegram">Telegram</option>
                        <option value="custom">通用 (custom)</option>
                        <option value="dingtalk">钉钉 (dingtalk)</option>
                        <option value="feishu">飞书 (feishu)</option>
                        <option value="wecom">企业微信 (wecom)</option>
                        <option value="serverchan">Server酱 · 方糖 (serverchan)</option>
                      </select>
                    </div>

                    {settings.webhook_type === "email" ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <label className="text-xs font-semibold text-content-secondary">SMTP 服务器</label>
                          <input
                            value={settings.smtp_host}
                            onChange={(e) => setSettings((s) => ({ ...s, smtp_host: e.target.value }))}
                            placeholder="smtp.qq.com"
                            className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs font-semibold text-content-secondary">端口（465 = 隐式 TLS）</label>
                          <input
                            value={settings.smtp_port}
                            onChange={(e) => setSettings((s) => ({ ...s, smtp_port: e.target.value }))}
                            placeholder="465"
                            className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs font-semibold text-content-secondary">发件邮箱</label>
                          <input
                            value={settings.smtp_user}
                            onChange={(e) => setSettings((s) => ({ ...s, smtp_user: e.target.value }))}
                            placeholder="you@qq.com"
                            className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs font-semibold text-content-secondary">授权码（不是登录密码）</label>
                          <input
                            type="password"
                            value={settings.smtp_pass}
                            onChange={(e) => setSettings((s) => ({ ...s, smtp_pass: e.target.value }))}
                            placeholder={settingsConfigured.smtp_pass ? "已配置（留空不修改）" : "QQ 邮箱的 SMTP 授权码"}
                            className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs font-semibold text-content-secondary">发件人显示名（可选）</label>
                          <input
                            value={settings.smtp_from}
                            onChange={(e) => setSettings((s) => ({ ...s, smtp_from: e.target.value }))}
                            placeholder="留空即用发件邮箱"
                            className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs font-semibold text-content-secondary">收件邮箱</label>
                          <input
                            value={settings.smtp_to}
                            onChange={(e) => setSettings((s) => ({ ...s, smtp_to: e.target.value }))}
                            placeholder="接收续期报告的邮箱"
                            className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                          />
                        </div>
                      </div>
                    ) : settings.webhook_type === "telegram" ? (
                      <div className="space-y-3">
                        <input
                          value={settings.tg_token}
                          onChange={(e) => setSettings((s) => ({ ...s, tg_token: e.target.value }))}
                          placeholder={settingsConfigured.tg_token ? "已配置（留空不修改）" : "Bot Token"}
                          className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                        />
                        <input
                          value={settings.tg_chat_id}
                          onChange={(e) => setSettings((s) => ({ ...s, tg_chat_id: e.target.value }))}
                          placeholder="Chat ID"
                          className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                        />
                      </div>
                    ) : (
                      <input
                        value={settings.webhook_url}
                        onChange={(e) => setSettings((s) => ({ ...s, webhook_url: e.target.value }))}
                        placeholder={
                          settingsConfigured.webhook_url
                            ? "已配置（留空不修改）"
                            : settings.webhook_type === "serverchan"
                            ? "SendKey，如 SCTxxxxxxxxxxxxxxxx"
                            : "Webhook URL"
                        }
                        className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                      />
                    )}

                    <div className="flex justify-end">
                      <button
                        onClick={handleTestWebhook}
                        disabled={actionLoading === "test-webhook"}
                        className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-4 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50 flex-shrink-0"
                      >
                        <Send className="w-4 h-4" />
                        {settings.webhook_type === "email" ? "发送测试邮件" : "测试推送"}
                      </button>
                    </div>
                    <p className="text-[11px] text-content-muted leading-relaxed">
                      {settings.webhook_type === "email" ? (
                        <>
                          QQ 邮箱请先到「设置 → 账户 → POP3/IMAP/SMTP 服务」开启服务并生成<b>授权码</b>，
                          把它填进上面的「授权码」（<b>不是</b>邮箱登录密码）；端口填 465。
                          发信走 Cloudflare 的 TLS 长连接，若一直超时，说明该服务商屏蔽了 Cloudflare 出口 IP，可改用 Webhook。
                        </>
                      ) : settings.webhook_type === "telegram" ? (
                        <>
                          在 Telegram 里找 <b>@BotFather</b> 创建机器人拿到 Bot Token；Chat ID 可用
                          <b> @userinfobot</b> 查询自己的，群聊的 ID 是负数（把机器人拉进群后发条消息，
                          访问 <code className="font-mono">getUpdates</code> 即可看到）。
                        </>
                      ) : settings.webhook_type === "serverchan" ? (
                        <>
                          直接填 Server酱 控制台首页的 <b>SendKey</b> 即可，系统会自动补全推送地址
                          （Turbo 版与 Server酱³ 都支持）；<b>不要</b>填「快速创建入口链接」那种网页地址。
                        </>
                      ) : (
                        <>平台类型要与 URL 来源对上，否则对方会因字段名不认而拒收。</>
                      )}
                      {" "}续期报告只在<b>确实有域名被续期时</b>推送，平时不会有心跳消息；推送失败会在「运行日志」里留一条 warning。
                    </p>
                  </div>
                </div>
                </div>

              </div>
                {/* 保存按钮：放在两列容器外面，始终横跨整行停在底部 */}
                <div className="flex justify-end">
                  <button
                    onClick={handleSaveSettings}
                    disabled={actionLoading === "save-settings"}
                    className="btn-primary px-6 py-2.5 rounded-lg text-sm font-bold text-white flex items-center gap-2 disabled:opacity-50"
                  >
                    <Save className="w-4 h-4" /> 保存全部设置
                  </button>
                </div>
              </>
            )}
          </div>
        )}

      </main>
      </div>

      {/* DNS 解析管理模态框 (Modal) */}
      {dnsModalOpen && selectedDomain && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="bg-surface border border-border-base w-full max-w-4xl max-h-[90dvh] rounded-xl overflow-hidden flex flex-col shadow-2xl">
            {/* 模态框头部 */}
            <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-2 border-b border-border-base flex-shrink-0">
              {/* NOTE: min-w-0 + truncate —— 长 IDN 域名（xn-- 形式很长）会把右侧按钮挤出屏幕 */}
              <div className="min-w-0">
                <h3 className="text-base sm:text-lg font-bold text-content-primary flex items-center gap-1.5">
                  <ShieldCheck className="text-indigo-400 w-5 h-5 flex-shrink-0" />
                  <span className="truncate">DNS 解析记录管理</span>
                </h3>
                <p className="text-xs text-content-muted mt-0.5 font-mono truncate">
                  域名: {selectedDomain.full_domain}
                </p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => reloadDnsRecords(selectedDomain, true)}
                  disabled={loadingDns}
                  className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded disabled:opacity-50"
                  title="强制刷新（重新从 DNSHE 拉取）"
                >
                  <RefreshCw className={`w-4 h-4 ${loadingDns ? "animate-spin" : ""}`} />
                </button>
                <button
                  onClick={() => setDnsModalOpen(false)}
                  className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* 模态框主体 */}
            <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4 sm:space-y-6">
              
              {/* 新建 DNS 记录表单折叠面板 */}
              <div className="border border-border-base rounded-lg overflow-hidden bg-hovered">
                <button
                  onClick={() => setDnsFormOpen(!dnsFormOpen)}
                  className="w-full px-4 py-3 bg-elevated hover:bg-hovered flex justify-between items-center text-sm font-semibold text-content-secondary transition-colors"
                >
                  <span>{dnsFormOpen ? "隐藏新建解析表单" : "➕ 添加新解析记录"}</span>
                </button>

                {dnsFormOpen && (
                  <form onSubmit={handleCreateDnsRecord} className="p-4 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4 border-t border-border-base">
                    <div>
                      <label className="block text-[11px] md:text-[10px] text-content-muted font-bold uppercase mb-1">记录类型</label>
                      <select
                        value={newDnsType}
                        onChange={(e) => setNewDnsType(e.target.value)}
                        className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                      >
                        {DNS_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] md:text-[10px] text-content-muted font-bold uppercase mb-1">主机记录</label>
                      <input
                        type="text"
                        name="dns-new-name"
                        autoComplete="off"
                        placeholder="例如 @ 或 www"
                        value={newDnsName}
                        onChange={(e) => setNewDnsName(e.target.value)}
                        className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                      />
                    </div>

                    <div className="md:col-span-2 lg:col-span-1">
                      <label className="block text-[11px] md:text-[10px] text-content-muted font-bold uppercase mb-1">记录值 (Content)</label>
                      <input
                        type="text"
                        name="dns-new-content"
                        autoComplete="off"
                        required
                        placeholder="例如 192.0.2.1"
                        value={newDnsContent}
                        onChange={(e) => setNewDnsContent(e.target.value)}
                        className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] md:text-[10px] text-content-muted font-bold uppercase mb-1">TTL (秒)</label>
                      <input
                        type="number"
                        name="dns-new-ttl"
                        autoComplete="off"
                        min={120}
                        max={86400}
                        value={newDnsTtl}
                        onChange={(e) => setNewDnsTtl(parseInt(e.target.value, 10) || 600)}
                        className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                      />
                    </div>

                    {needsDnsPriority(newDnsType) && (
                      <div>
                        <label className="block text-[11px] md:text-[10px] text-content-muted font-bold uppercase mb-1">优先级</label>
                        <input
                          type="number"
                          name="dns-new-priority"
                          autoComplete="off"
                          min={0}
                          max={65535}
                          value={newDnsPriority}
                          onChange={(e) => setNewDnsPriority(parseInt(e.target.value, 10) || 0)}
                          className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                        />
                      </div>
                    )}

                    <div>
                      <label className="block text-[11px] md:text-[10px] text-content-muted font-bold uppercase mb-1">解析线路</label>
                      <DnsLineSelect
                        value={newDnsLine}
                        onChange={setNewDnsLine}
                        supported={domainSupportsLine(selectedDomain)}
                        className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                      />
                    </div>

                    <div className="flex items-end md:col-span-3 lg:col-span-1">
                      <button
                        type="submit"
                        disabled={actionLoading === "create-dns"}
                        className="w-full btn-primary py-2 rounded text-sm font-semibold text-white flex items-center justify-center gap-1"
                      >
                        {actionLoading === "create-dns" && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                        确认保存
                      </button>
                    </div>
                  </form>
                )}
              </div>

              {/* 批量添加解析记录折叠面板 */}
              <div className="border border-border-base rounded-lg overflow-hidden bg-hovered">
                <button
                  onClick={() => setDnsBatchOpen(!dnsBatchOpen)}
                  className="w-full px-4 py-3 bg-elevated hover:bg-hovered flex justify-between items-center text-sm font-semibold text-content-secondary transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-emerald-400" />
                    {dnsBatchOpen ? "隐藏批量添加面板" : "批量添加解析记录"}
                  </span>
                  {!dnsBatchOpen && (
                    <span className="text-[10px] text-content-muted font-normal">一行一条，缺省字段取下方默认值</span>
                  )}
                </button>

                {dnsBatchOpen && (
                  <div className="p-4 space-y-4 border-t border-border-base">
                    <p className="text-xs text-content-muted leading-relaxed">
                      每行一条记录，支持 <span className="font-mono text-indigo-400">记录值</span> /
                      <span className="font-mono text-indigo-400"> 主机记录 记录值</span> /
                      <span className="font-mono text-indigo-400"> 类型 主机记录 记录值 [TTL] [优先级]</span>；
                      字段分隔符优先级为 <span className="font-mono">竖线 &gt; 逗号 &gt; 空格</span>
                      （TXT 记录值本身含空格时请改用竖线或逗号分隔），<span className="font-mono">#</span> 开头的行会被忽略。
                      未写明的字段取下方默认值，单次最多 50 条。
                      主机记录只能是相对名 —— <span className="font-mono text-indigo-400">@</span> 代表
                      <span className="font-mono"> {selectedDomain.full_domain}</span>，
                      填完整域名会自动剥成相对名。
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                      <div>
                        <label className="block text-[11px] md:text-[10px] text-content-muted font-bold uppercase mb-1">默认类型</label>
                        <select
                          value={dnsBatchType}
                          onChange={(e) => setDnsBatchType(e.target.value)}
                          className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                        >
                          {DNS_TYPE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[11px] md:text-[10px] text-content-muted font-bold uppercase mb-1">默认主机记录</label>
                        <input
                          type="text"
                          name="dns-batch-name"
                          autoComplete="off"
                          placeholder="@ 或 www"
                          value={dnsBatchName}
                          onChange={(e) => setDnsBatchName(e.target.value)}
                          className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] md:text-[10px] text-content-muted font-bold uppercase mb-1">默认 TTL (秒)</label>
                        <input
                          type="number"
                          name="dns-batch-ttl"
                          autoComplete="off"
                          min={120}
                          max={86400}
                          value={dnsBatchTtl}
                          onChange={(e) => setDnsBatchTtl(parseInt(e.target.value, 10) || 600)}
                          className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                        />
                      </div>

                      {needsDnsPriority(dnsBatchType) && (
                        <div>
                          <label className="block text-[11px] md:text-[10px] text-content-muted font-bold uppercase mb-1">默认优先级</label>
                          <input
                            type="number"
                            name="dns-batch-priority"
                            autoComplete="off"
                            min={0}
                            max={65535}
                            value={dnsBatchPriority}
                            onChange={(e) => setDnsBatchPriority(parseInt(e.target.value, 10) || 0)}
                            className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                          />
                        </div>
                      )}

                      <div>
                        <label className="block text-[11px] md:text-[10px] text-content-muted font-bold uppercase mb-1">解析线路</label>
                        <DnsLineSelect
                          value={dnsBatchLine}
                          onChange={setDnsBatchLine}
                          supported={domainSupportsLine(selectedDomain)}
                          className="w-full form-input px-3 h-10 rounded-lg text-sm text-content-secondary"
                        />
                      </div>
                    </div>

                    {/* NOTE: 占位示例一律用文档保留段（RFC 3849 的 2001:db8::/32、
                        RFC 5737 的 192.0.2.0/24、RFC 2606 的 example.com），不放真实地址 */}
                    <textarea
                      value={dnsBatchInput}
                      onChange={(e) => setDnsBatchInput(e.target.value)}
                      rows={6}
                      name="dns-batch-input"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={"2001:db8::5010:e191\n2001:db8::527:8a4e\nAAAA ipv6 2001:db8::e095:d9aa\nA www 192.0.2.1 600\nMX @ mail.example.com 600 10"}
                      className="w-full form-input px-3 py-2.5 rounded-lg text-sm font-mono text-content-secondary resize-y"
                    />

                    <button
                      onClick={handleBatchCreateDnsRecords}
                      disabled={actionLoading === "batch-create-dns" || validDnsBatchLines.length === 0}
                      className="w-full btn-primary py-2.5 rounded-lg font-semibold text-sm text-white flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {actionLoading === "batch-create-dns" ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" /> 正在逐条提交…
                        </>
                      ) : (
                        <>
                          <Play className="w-4 h-4" /> 开始批量添加 (已识别 {validDnsBatchLines.length} 条)
                        </>
                      )}
                    </button>

                    {/* 无法解析的行（缺少记录值）会被跳过，这里明确告知条数，避免静默丢弃 */}
                    {parsedDnsBatchLines.length > validDnsBatchLines.length && (
                      <p className="text-xs text-amber-400 flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        有 {parsedDnsBatchLines.length - validDnsBatchLines.length} 行无法解析（缺少记录值），提交时会自动跳过
                      </p>
                    )}

                    {/* 解析预览：提交前先让用户核对每行被解析成了什么 */}
                    {validDnsBatchLines.length > 0 && (
                      <div className="max-h-40 overflow-y-auto pr-1 space-y-1">
                        {validDnsBatchLines.map((r, idx) => (
                          <div key={idx} className="text-[11px] font-mono text-content-muted flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-indigo-400 font-bold w-12 shrink-0">{r.type}</span>
                            <span className="w-20 sm:w-24 shrink-0 truncate" title={r.name}>{r.name}</span>
                            <span className="w-full sm:flex-1 sm:w-auto truncate text-content-secondary" title={r.content}>{r.content}</span>
                            <span className="shrink-0">TTL {r.ttl}</span>
                            {r.priority !== undefined && <span className="shrink-0">优先级 {r.priority}</span>}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 逐条提交结果回执 */}
                    {dnsBatchResults && dnsBatchResults.length > 0 && (
                      <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                        {dnsBatchResults.map((r, idx) => (
                          <div
                            key={idx}
                            className={`flex items-start justify-between gap-2 text-xs px-3 py-2 rounded-lg border ${
                              r.success
                                ? "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/10 dark:border-emerald-500/30 dark:text-emerald-300"
                                : "bg-red-50 border-red-200 text-red-700 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-300"
                            }`}
                          >
                            <div className="font-mono min-w-0 truncate" title={r.label}>{r.label}</div>
                            <div className="flex items-center gap-1 shrink-0">
                              {r.success ? <CheckCircle2 className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                              <span>{r.success ? "成功" : r.message}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* DNS 记录列表展现 */}
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <h4 className="text-sm font-bold text-content-primary">
                    当前解析记录列表
                    {dnsRecords.length > 0 && (
                      <span className="ml-2 text-xs text-content-muted font-normal">共 {dnsRecords.length} 条</span>
                    )}
                  </h4>

                  {selectedDnsKeys.size > 0 && (
                    <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                      <span className="text-xs text-content-muted">已选 {selectedDnsKeys.size} 条</span>
                      <button
                        onClick={() => setSelectedDnsKeys(new Set())}
                        className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-2.5 py-2 sm:py-1.5 rounded-lg text-xs font-semibold"
                      >
                        取消选择
                      </button>
                      <button
                        onClick={() => (dnsEditPanelOpen ? setDnsEditPanelOpen(false) : handleOpenDnsEditPanel())}
                        className={`px-2.5 py-2 sm:py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 border transition-colors ${
                          dnsEditPanelOpen
                            ? "bg-indigo-100 border-indigo-300 text-indigo-800 dark:bg-indigo-500/20 dark:border-indigo-500/50 dark:text-indigo-200"
                            : "bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/60 dark:text-indigo-300 dark:border-indigo-900/60"
                        }`}
                        title="批量修改已勾选记录的指定字段"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        批量修改 ({selectedDnsKeys.size})
                      </button>
                      <button
                        onClick={handleBatchDeleteDnsRecords}
                        disabled={actionLoading === "batch-delete-dns"}
                        className="bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 dark:bg-red-950/60 dark:hover:bg-red-900/60 dark:text-red-300 dark:border-red-900/60 px-2.5 py-2 sm:py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50"
                        title="批量删除已勾选的解析记录"
                      >
                        {actionLoading === "batch-delete-dns" ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                        批量删除 ({selectedDnsKeys.size})
                      </button>
                    </div>
                  )}
                </div>

                {/* 批量修改面板：勾选哪个字段就只覆盖那个字段 */}
                {dnsEditPanelOpen && selectedDnsKeys.size > 0 && (
                  <div className="mb-3 border border-indigo-200 bg-indigo-50 dark:border-indigo-900/60 dark:bg-indigo-950/20 rounded-lg p-4 space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      {/* NOTE: 强调色必须分主题给值 —— 浅色字（*-200/300）只在暗色底上成立，
                          压在亮色主题的浅底上对比度会掉到 1.1:1 左右，等于没画。
                          全项目的 tint chip 都按「亮色 bg-*-50 + text-*-700，暗色原值加
                          dark: 前缀」这一套写，dark 变体带 :is(.dark *) 后缀，特异性比
                          同名亮色类多一个 class，所以暗色渲染与改造前完全一致。 */}
                      <h5 className="text-xs font-bold text-indigo-700 dark:text-indigo-200 flex items-center gap-1.5">
                        <Pencil className="w-3.5 h-3.5" />
                        批量修改 {selectedDnsKeys.size} 条记录
                      </h5>
                      <span className="text-[10px] text-content-muted hidden sm:inline">只有勾选的字段会被覆盖，其余字段保留各自原值</span>
                    </div>
                    <p className="text-[11px] text-content-muted sm:hidden -mt-2">只有勾选的字段会被覆盖，其余保留原值</p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {/* 记录类型 */}
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={dnsEditFields.type}
                          onChange={(e) => setDnsEditFields({ ...dnsEditFields, type: e.target.checked })}
                          className="w-4 h-4 accent-indigo-500 cursor-pointer shrink-0"
                        />
                        <span className="text-xs text-content-secondary w-20 shrink-0">记录类型</span>
                        <select
                          value={batchEditType}
                          onChange={(e) => setBatchEditType(e.target.value)}
                          disabled={!dnsEditFields.type}
                          className="flex-1 form-input px-2 h-8 rounded text-xs text-content-secondary disabled:opacity-40"
                        >
                          {DNS_TYPE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </label>

                      {/* TTL */}
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={dnsEditFields.ttl}
                          onChange={(e) => setDnsEditFields({ ...dnsEditFields, ttl: e.target.checked })}
                          className="w-4 h-4 accent-indigo-500 cursor-pointer shrink-0"
                        />
                        <span className="text-xs text-content-secondary w-20 shrink-0">TTL (秒)</span>
                        <input
                          type="number"
                          name="dns-bulk-ttl"
                          autoComplete="off"
                          min={120}
                          max={86400}
                          value={batchEditTtl}
                          onChange={(e) => setBatchEditTtl(parseInt(e.target.value, 10) || 600)}
                          disabled={!dnsEditFields.ttl}
                          className="flex-1 form-input px-2 h-8 rounded text-xs text-content-secondary disabled:opacity-40"
                        />
                      </label>

                      {/* 主机记录 */}
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={dnsEditFields.name}
                          onChange={(e) => setDnsEditFields({ ...dnsEditFields, name: e.target.checked })}
                          className="w-4 h-4 accent-indigo-500 cursor-pointer shrink-0"
                        />
                        <span className="text-xs text-content-secondary w-20 shrink-0">主机记录</span>
                        <input
                          type="text"
                          name="dns-bulk-name"
                          autoComplete="off"
                          placeholder="@ 或 jp"
                          title={`只能填相对名：@ 代表 ${selectedDomain.full_domain}`}
                          value={batchEditName}
                          onChange={(e) => setBatchEditName(e.target.value)}
                          disabled={!dnsEditFields.name}
                          className="flex-1 form-input px-2 h-8 rounded text-xs text-content-secondary disabled:opacity-40"
                        />
                      </label>

                      {/* 解析线路 */}
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={dnsEditFields.line}
                          onChange={(e) => setDnsEditFields({ ...dnsEditFields, line: e.target.checked })}
                          disabled={!domainSupportsLine(selectedDomain)}
                          className="w-4 h-4 accent-indigo-500 cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                        />
                        <span className="text-xs text-content-secondary w-20 shrink-0">解析线路</span>
                        <DnsLineSelect
                          value={batchEditLine}
                          onChange={setBatchEditLine}
                          supported={domainSupportsLine(selectedDomain)}
                          disabled={!dnsEditFields.line}
                          className="flex-1 form-input px-2 h-8 rounded text-xs text-content-secondary disabled:opacity-40"
                        />
                      </label>

                      {/* 记录值：只在这里开关，具体新值在下方逐条编辑 */}
                      <label className="flex items-center gap-2 md:col-span-2">
                        <input
                          type="checkbox"
                          checked={dnsEditFields.content}
                          onChange={(e) => setDnsEditFields({ ...dnsEditFields, content: e.target.checked })}
                          className="w-4 h-4 accent-indigo-500 cursor-pointer shrink-0"
                        />
                        <span className="text-xs text-content-secondary w-20 shrink-0">记录值</span>
                        <span className="text-[11px] text-content-muted">
                          {dnsEditFields.content
                            ? "在下方逐条编辑各自的新记录值，不改的行保持原值"
                            : "勾选后可在下方逐条编辑记录值"}
                        </span>
                      </label>

                      {/* 优先级：仅在改成 MX / SRV 或选中记录含 MX / SRV 时出现 */}
                      {batchEditNeedsPriority && (
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={dnsEditFields.priority}
                            onChange={(e) => setDnsEditFields({ ...dnsEditFields, priority: e.target.checked })}
                            className="w-4 h-4 accent-indigo-500 cursor-pointer shrink-0"
                          />
                          <span className="text-xs text-content-secondary w-20 shrink-0">优先级</span>
                          <input
                            type="number"
                            name="dns-bulk-priority"
                            autoComplete="off"
                            min={0}
                            max={65535}
                            value={batchEditPriority}
                            onChange={(e) => setBatchEditPriority(parseInt(e.target.value, 10) || 0)}
                            disabled={!dnsEditFields.priority}
                            className="flex-1 form-input px-2 h-8 rounded text-xs text-content-secondary disabled:opacity-40"
                          />
                        </label>
                      )}
                    </div>

                    {/* 记录值逐条编辑时，提示重复值会造成重复记录（上游通常直接拒绝） */}
                    {dnsEditFields.content && (() => {
                      const values = batchEditTargets.map((t) => `${t.type}|${t.name}|${t.content}`);
                      const dupCount = values.length - new Set(values).size;
                      return dupCount > 0 ? (
                        <p className="text-xs text-amber-400 flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          有 {dupCount} 条记录的「类型 + 主机记录 + 记录值」与其它行重复，上游可能拒绝写入
                        </p>
                      ) : null;
                    })()}

                    {/* 变更预览：逐条显示「原记录 → 改后」；勾了记录值时该列可就地编辑 */}
                    <div className="max-h-56 overflow-y-auto pr-1 space-y-1">
                      {batchEditTargets.map((t) => (
                        <div
                          key={t.record_id}
                          /* NOTE: 窄屏改为纵向两段（原记录 / 改后），横排 7 段在手机上必然溢出 */
                          className={`text-[11px] font-mono flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 rounded px-1 py-1 sm:py-0.5 border-b border-border-soft sm:border-0 last:border-0 ${
                            t.unchanged ? "opacity-45" : ""
                          }`}
                          title={t.unchanged ? "与原记录一致，提交时会跳过" : undefined}
                        >
                          <span className="text-content-muted flex-1 truncate min-w-0" title={t.label}>{t.label}</span>
                          <ChevronRight className="w-3 h-3 text-content-muted shrink-0 rotate-90 sm:rotate-0" />
                          <span className="flex items-center gap-2 min-w-0 sm:contents">
                            <span className="text-indigo-400 shrink-0">{t.type}</span>
                            <span className="text-content-secondary shrink-0 max-w-[7rem] truncate" title={t.name}>{t.name}</span>
                          </span>
                          {dnsEditFields.content ? (
                            <input
                              type="text"
                              name={`dns-bulk-content-${t.record_id}`}
                              autoComplete="off"
                              value={batchEditContents[t.record_id] ?? ""}
                              onChange={(e) =>
                                setBatchEditContents({ ...batchEditContents, [t.record_id]: e.target.value })
                              }
                              placeholder={t.origin_content}
                              title="留空则保持原记录值"
                              className="flex-1 min-w-0 form-input px-2 h-8 rounded text-xs text-content-secondary"
                            />
                          ) : (
                            <span className="text-content-secondary flex-1 truncate min-w-0" title={t.content}>{t.content}</span>
                          )}
                          <span className="flex items-center gap-2 sm:contents">
                            <span className="text-content-muted shrink-0">TTL {t.ttl}</span>
                            {t.priority !== undefined && <span className="text-content-muted shrink-0">优先级 {t.priority}</span>}
                            <span className="text-content-muted shrink-0">{t.line || "默认线路"}</span>
                          </span>
                        </div>
                      ))}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleBatchUpdateDnsRecords}
                        disabled={actionLoading === "batch-update-dns" || batchEditChanged.length === 0}
                        className="flex-1 btn-primary py-2 rounded-lg font-semibold text-sm text-white flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        {actionLoading === "batch-update-dns" ? (
                          <>
                            <RefreshCw className="w-4 h-4 animate-spin" /> 正在逐条提交…
                          </>
                        ) : (
                          <>
                            <Save className="w-4 h-4" />
                            {batchEditChanged.length === 0
                              ? "没有需要提交的修改"
                              : `应用到 ${batchEditChanged.length} 条记录${
                                  batchEditChanged.length < batchEditTargets.length
                                    ? `（跳过 ${batchEditTargets.length - batchEditChanged.length} 条无变化）`
                                    : ""
                                }`}
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => setDnsEditPanelOpen(false)}
                        className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-4 py-2 rounded-lg text-sm font-semibold"
                      >
                        取消
                      </button>
                    </div>

                    {/* 逐条提交结果回执 */}
                    {dnsEditResults && dnsEditResults.length > 0 && (
                      <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                        {dnsEditResults.map((r, idx) => (
                          <div
                            key={idx}
                            className={`flex items-start justify-between gap-2 text-xs px-3 py-2 rounded-lg border ${
                              r.success
                                ? "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/10 dark:border-emerald-500/30 dark:text-emerald-300"
                                : "bg-red-50 border-red-200 text-red-700 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-300"
                            }`}
                          >
                            <div className="font-mono min-w-0 truncate" title={r.label}>{r.label}</div>
                            <div className="flex items-center gap-1 shrink-0">
                              {r.success ? <CheckCircle2 className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                              <span>{r.success ? "成功" : r.message}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {loadingDns ? (
                  <div className="flex justify-center py-10">
                    <RefreshCw className="w-6 h-6 animate-spin text-indigo-500" />
                  </div>
                ) : dnsRecords.length === 0 ? (
                  <div className="text-center py-10 bg-hovered rounded-lg border border-border-base text-content-muted text-sm">
                    暂无解析记录。请点击上方按钮添加第一条记录。
                  </div>
                ) : (
                  <>
                    {/* ≥md：保持原有 7 列表格（手机上这张表最小需要约 750px，只能横拖） */}
                    <div className="hidden md:block bg-hovered border border-border-base rounded-lg overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm border-collapse">
                          <thead>
                            <tr className="bg-elevated text-content-muted text-[10px] uppercase font-bold tracking-wider border-b border-border-base">
                              <th className="p-3 w-10">
                                <input
                                  type="checkbox"
                                  checked={dnsRecords.length > 0 && selectedDnsKeys.size === dnsRecords.length}
                                  onChange={toggleAllDnsSelection}
                                  className="w-4 h-4 accent-indigo-500 cursor-pointer align-middle"
                                  title="全选 / 取消全选"
                                />
                              </th>
                              <th className="p-3">类型</th>
                              <th className="p-3">主机记录</th>
                              <th className="p-3">解析记录值</th>
                              <th className="p-3 w-20">TTL</th>
                              <th className="p-3 w-24">线路</th>
                              <th className="p-3 w-20 text-center">操作</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border-soft text-content-secondary">
                            {dnsRecords.map((rec) => {
                              const p = dnsRowParts(rec);

                              // 行内编辑态：整行换成输入控件，保存 / 取消就地完成
                              if (p.isEditing) {
                                return (
                                  <tr key={p.key} className="bg-indigo-500/5">
                                    <td className="p-3" />
                                    <td className="p-2">{p.typeSelect}</td>
                                    <td className="p-2">{p.nameInput}</td>
                                    <td className="p-2">
                                      <div className="flex items-center gap-1.5">
                                        {p.contentInput}
                                        {p.priorityInput}
                                      </div>
                                    </td>
                                    <td className="p-2">{p.ttlInput}</td>
                                    <td className="p-2">{p.lineInput}</td>
                                    <td className="p-2">
                                      <div className="flex items-center justify-center gap-1">
                                        {p.saveButton}
                                        {p.cancelButton}
                                      </div>
                                    </td>
                                  </tr>
                                );
                              }

                              return (
                                <tr key={p.key} className="hover:bg-hovered">
                                  <td className="p-3">{p.checkbox}</td>
                                  <td className="p-3 font-bold text-xs text-indigo-400">{rec.type}</td>
                                  <td className="p-3 font-mono text-xs">{rec.name}</td>
                                  <td className="p-3 font-mono text-xs break-all max-w-xs" title={rec.content}>
                                    {rec.priority !== null && rec.priority !== undefined && `[优先级: ${rec.priority}] `}
                                    {rec.content}
                                  </td>
                                  <td className="p-3 text-xs text-content-muted">{rec.ttl}</td>
                                  <td className="p-3 text-xs text-content-muted">{rec.line || "默认"}</td>
                                  <td className="p-3">
                                    <div className="flex items-center justify-center gap-1">
                                      {p.editButton}
                                      {p.deleteButton}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* <md：每条记录一张卡片，字段纵向堆叠；编辑态在同一张卡里展开 */}
                    <div className="md:hidden space-y-2">
                      {/* 卡片模式下表头消失了，全选入口单独给一行 */}
                      <label className="flex items-center gap-2 px-1 py-1 text-xs text-content-muted">
                        <input
                          type="checkbox"
                          checked={dnsRecords.length > 0 && selectedDnsKeys.size === dnsRecords.length}
                          onChange={toggleAllDnsSelection}
                          className="w-4 h-4 accent-indigo-500 cursor-pointer"
                        />
                        全选（共 {dnsRecords.length} 条）
                      </label>

                      {dnsRecords.map((rec) => {
                        const p = dnsRowParts(rec);

                        if (p.isEditing) {
                          return (
                            <div
                              key={p.key}
                              className="bg-indigo-500/5 border border-indigo-500/40 rounded-lg p-3 space-y-2.5"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-bold text-indigo-700 dark:text-indigo-300 uppercase tracking-wider">
                                  修改解析记录
                                </span>
                                <div className="flex items-center gap-1">
                                  {p.saveButton}
                                  {p.cancelButton}
                                </div>
                              </div>
                              <div>
                                <label className="block text-[11px] text-content-muted mb-1">记录类型</label>
                                {p.typeSelect}
                              </div>
                              <div>
                                <label className="block text-[11px] text-content-muted mb-1">主机记录</label>
                                {p.nameInput}
                              </div>
                              <div>
                                <label className="block text-[11px] text-content-muted mb-1">
                                  记录值{p.priorityInput ? " / 优先级" : ""}
                                </label>
                                <div className="flex items-center gap-1.5">
                                  {p.contentInput}
                                  {p.priorityInput}
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <label className="block text-[11px] text-content-muted mb-1">TTL (秒)</label>
                                  {p.ttlInput}
                                </div>
                                <div>
                                  <label className="block text-[11px] text-content-muted mb-1">解析线路</label>
                                  {p.lineInput}
                                </div>
                              </div>
                            </div>
                          );
                        }

                        return (
                          <div
                            key={p.key}
                            className={`bg-hovered border rounded-lg p-3 space-y-2 ${
                              selectedDnsKeys.has(p.key) ? "border-indigo-500/50" : "border-border-base"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              {p.checkbox}
                              <span className="font-bold text-xs text-indigo-400">{rec.type}</span>
                              <span className="ml-auto flex items-center gap-1">
                                {p.editButton}
                                {p.deleteButton}
                              </span>
                            </div>
                            <div className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1 text-xs">
                              <span className="text-content-muted">主机记录</span>
                              <span className="font-mono text-content-secondary break-all">{rec.name}</span>

                              <span className="text-content-muted">记录值</span>
                              <span className="font-mono text-content-secondary break-all">
                                {rec.priority !== null && rec.priority !== undefined && `[优先级: ${rec.priority}] `}
                                {rec.content}
                              </span>

                              <span className="text-content-muted">TTL</span>
                              <span className="text-content-secondary">{rec.ttl}</span>

                              <span className="text-content-muted">线路</span>
                              <span className="text-content-secondary">{rec.line || "默认"}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

            </div>

            {/* 模态框页脚 */}
            <div className="bg-elevated px-4 sm:px-6 py-4 border-t border-border-base flex justify-end flex-shrink-0">
              <button
                onClick={() => setDnsModalOpen(false)}
                className="bg-elevated hover:bg-hovered text-content-secondary text-sm font-semibold px-4 py-2 rounded-lg"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* NS 域名服务器修改与重置模态框 (NS Modal) */}
      {/*
        「解析线路支持名单 → 恢复默认」的二次确认框（§9：破坏性操作必须二次确认）。
        这一动作不是"追加"，而是**整份覆盖**用户手工维护的名单，所以确认文案要写清损失是什么，
        并把「当前名单 vs 默认名单」并排列出来，让用户不用回忆自己加过什么。
      */}
      {restoreNsConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="bg-surface border border-border-base w-full max-w-md rounded-2xl overflow-hidden flex flex-col shadow-2xl">
            <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-2 border-b border-border-base flex-shrink-0">
              <h3 className="text-base font-bold text-content-primary flex items-center gap-2 min-w-0">
                <RotateCcw className="w-5 h-5 text-amber-500 flex-shrink-0" />
                <span className="truncate">恢复默认 NS 后缀名单</span>
              </h3>
              <button
                onClick={() => setRestoreNsConfirmOpen(false)}
                className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded flex-shrink-0"
                title="关闭"
                aria-label="关闭确认框"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 sm:p-6 space-y-4">
              <div className="p-4 rounded-xl border border-amber-200 bg-amber-50 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200 flex gap-3">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                <div className="space-y-1 min-w-0">
                  <p className="font-bold">这会覆盖你当前维护的名单</p>
                  <p className="text-xs leading-relaxed opacity-90">
                    恢复后名单只保留内置默认值，你手工添加的后缀会被移除；已缓存的 NS 判定结果不受影响。
                  </p>
                </div>
              </div>
              <div className="text-xs space-y-2">
                <div className="flex items-start gap-2">
                  <span className="text-content-muted flex-shrink-0 w-16">当前名单</span>
                  <span className="font-mono text-content-secondary break-all min-w-0">
                    {lineNsSuffixes.length > 0
                      ? lineNsSuffixes.map((s) => `*.${s}`).join("、")
                      : "（空）"}
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-content-muted flex-shrink-0 w-16">默认名单</span>
                  <span className="font-mono text-content-secondary break-all min-w-0">
                    {DEFAULT_LINE_NS_SUFFIXES.map((s) => `*.${s}`).join("、")}
                  </span>
                </div>
              </div>
            </div>
            <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-end gap-2 border-t border-border-base flex-shrink-0">
              <button
                onClick={() => setRestoreNsConfirmOpen(false)}
                className="h-10 px-4 rounded-lg text-sm font-semibold whitespace-nowrap bg-elevated hover:bg-hovered text-content-secondary border border-border-base"
              >
                取消
              </button>
              <button
                onClick={handleRestoreLineNsSuffixes}
                className="btn-primary h-10 px-4 rounded-lg text-sm font-bold text-white flex items-center gap-1.5 whitespace-nowrap"
              >
                <RotateCcw className="w-4 h-4 flex-shrink-0" /> 确认恢复
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除域名确认弹窗 —— 不可逆操作，需输入完整域名二次确认 */}
      {deleteModalDomain && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="bg-surface border border-rose-200 dark:border-rose-900/60 w-full max-w-lg max-h-[90dvh] rounded-2xl overflow-hidden flex flex-col shadow-2xl">
            {/* 头部 */}
            <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-2 border-b border-border-base flex-shrink-0">
              <div className="min-w-0">
                <h3 className="text-lg font-bold text-content-primary flex items-center gap-2">
                  <Trash2 className="text-rose-400 w-5 h-5 flex-shrink-0" />
                  删除域名
                </h3>
                <p className="text-xs text-content-muted mt-0.5 font-mono truncate">
                  {toUnicode(deleteModalDomain.full_domain)}
                </p>
              </div>
              <button
                onClick={() => setDeleteModalDomain(null)}
                className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded flex-shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 内容 */}
            <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
              <div className="p-4 rounded-xl border border-rose-200 bg-rose-50 text-sm text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200 flex gap-3">
                <AlertTriangle className="w-5 h-5 shrink-0 text-rose-600 dark:text-rose-400 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold">此操作不可逆</p>
                  <p className="text-xs text-rose-700/90 dark:text-rose-300/90 leading-relaxed">
                    删除后域名将立即释放，可能被他人抢注，且无法恢复。
                  </p>
                </div>
              </div>

              <div className="p-4 rounded-xl border border-border-base bg-hovered text-xs text-content-secondary leading-relaxed">
                <p className="font-semibold text-content-primary mb-1.5 flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5 text-content-muted" /> 上游限制说明
                </p>
                <p className="text-content-muted">
                  域名存在<span className="text-content-secondary font-medium">解析记录历史</span>，
                  或处于<span className="text-content-secondary font-medium">转赠、ServerHold、PendingDelete</span> 等状态时，
                  上游不支持删除操作。此限制无法绕过，如被拒绝请按提示处理后重试。
                </p>
              </div>

              <div>
                <label className="text-xs text-content-muted font-medium block mb-1.5">
                  请输入完整域名以确认删除：
                  <span className="font-mono text-content-primary ml-1">
                    {toUnicode(deleteModalDomain.full_domain)}
                  </span>
                </label>
                <input
                  autoFocus
                  value={deleteConfirmInput}
                  onChange={(e) => { setDeleteConfirmInput(e.target.value); setDeleteError(""); }}
                  placeholder="在此输入完整域名"
                  className="w-full bg-elevated border border-border-base rounded-lg px-3 h-10 text-sm text-content-primary focus:outline-none focus:border-rose-700"
                />
              </div>

              {deleteError && (
                <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300 flex gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{deleteError}</span>
                </div>
              )}
            </div>

            {/* 底部操作 */}
            <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-end gap-3 border-t border-border-base flex-shrink-0">
              <button
                onClick={() => setDeleteModalDomain(null)}
                className="text-xs font-semibold px-4 py-2 rounded-lg bg-elevated hover:bg-hovered text-content-secondary border border-border-base"
              >
                取消
              </button>
              <button
                onClick={handleDeleteDomain}
                disabled={
                  actionLoading === `delete-${deleteModalDomain.id}` ||
                  !isDeleteConfirmed(deleteModalDomain, deleteConfirmInput)
                }
                className={`text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 transition-all ${
                  isDeleteConfirmed(deleteModalDomain, deleteConfirmInput) &&
                  actionLoading !== `delete-${deleteModalDomain.id}`
                    ? "bg-rose-600 hover:bg-rose-500 text-white cursor-pointer"
                    : "bg-elevated text-content-muted opacity-50 cursor-not-allowed"
                }`}
              >
                {actionLoading === `delete-${deleteModalDomain.id}` ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 一键委派到 Cloudflare（第19轮）──
          两阶段形状：① 确认 + 选 CF 账号（写操作都发生在这里）→ ② 列出从 DNSHE
          读到的原始记录让人逐条确认。顺序是「先委派、再列记录」——用户 2026-10-02
          定的：抄记录之前先把委派做完，用户才有机会对着真实清单划掉不该过去的条目。
          代价是委派生效到记录写回之间有一段解析真空，所以第一阶段必须把代价说透。 */}
      {delegateDomain && (
        <div
          data-deleg-modal="1"
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md"
        >
          <div className="bg-surface border border-border-base w-full max-w-2xl max-h-[90dvh] rounded-2xl overflow-hidden flex flex-col shadow-2xl">
            {/* 模态框头部 */}
            <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-2 border-b border-border-base flex-shrink-0">
              <div className="min-w-0">
                <h3 className="text-base sm:text-lg font-bold text-content-primary flex items-center gap-2">
                  <CloudflareIcon className="text-sky-400 w-5 h-5 flex-shrink-0" />
                  <span className="truncate">委派到 Cloudflare</span>
                </h3>
                <p className="text-xs text-content-muted mt-0.5 font-mono truncate">
                  域名: {delegateDomain.full_domain}
                </p>
              </div>
              <button
                onClick={() => setDelegateDomain(null)}
                aria-label="关闭委派弹窗"
                className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded flex-shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 步骤指示：两态各自可辨，用户随时知道自己在第几步 */}
            <div className="px-4 sm:px-6 pt-4 flex items-center gap-2 flex-shrink-0">
              {[
                { key: "confirm" as const, label: "① 建 zone 并写入 NS" },
                { key: "records" as const, label: "② 确认并迁移解析" }
              ].map((s) => (
                <span
                  key={s.key}
                  data-deleg-step={s.key}
                  data-deleg-active={delegateStep === s.key ? "1" : "0"}
                  className={`flex-1 min-w-0 h-8 flex items-center justify-center rounded-lg text-xs font-semibold whitespace-nowrap ${
                    delegateStep === s.key
                      ? "bg-indigo-600 text-white"
                      : s.key === "confirm"
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-400 dark:border-emerald-900/60"
                        : "bg-elevated text-content-muted border border-border-base"
                  }`}
                >
                  {s.label}
                </span>
              ))}
            </div>

            {/* 模态框内容 */}
            <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4">
              {delegateStep === "confirm" ? (
                <>
                  {/* 破坏性动作必须写清「会发生什么、损失是什么」（§9 / §23） */}
                  <div className="p-3.5 rounded-xl border border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/40 space-y-2">
                    <p className="text-xs font-bold text-amber-800 dark:text-amber-300">
                      这一步会改动 DNSHE 侧
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-200/90 leading-relaxed">
                      点击「开始委派」后会依次：① 在 Cloudflare 建一个 full setup zone；
                      ② 把 Cloudflare 分配的两台 NS 写到 DNSHE 侧；③ 清掉 apex 上与 NS 冲突的
                      非 NS 记录（不清理则 NS 写不进去）。记录迁移放在下一步、由你逐条确认。
                    </p>
                    <p className="text-xs font-bold text-rose-700 dark:text-rose-300 leading-relaxed">
                      委派生效后原解析立即失效，直到下一步把记录写进 Cloudflare 为止 —— 这段真空期
                      域名不可访问。
                    </p>
                  </div>

                  {/* 根域准入结论：把「凭什么能」讲明白，而不是只给一个报错 */}
                  <div className="p-3.5 rounded-xl border border-sky-200 bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/40">
                    <p className="text-xs text-sky-800 dark:text-sky-300 leading-relaxed">
                      根域名 <span className="font-mono font-semibold">{delegateDomain.rootdomain}</span> 在
                      Public Suffix List 里，Cloudflare 会把它当可注册根域 —— 免费版即可为
                      <span className="font-mono"> {delegateDomain.full_domain} </span>建立 zone 并把 NS 委派过去。
                    </p>
                  </div>

                  {/* 目标账号：绑了多个才让选，只有一个就直接写明（少一次点击） */}
                  {cfAccounts.length > 1 ? (
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-content-secondary">
                        委派到哪个 Cloudflare 账号
                      </label>
                      <select
                        value={delegateCfAccountId}
                        onChange={(e) => setDelegateCfAccountId(e.target.value)}
                        className="form-input w-full px-3 h-10 rounded-lg text-sm text-content-primary"
                      >
                        <option value="">请选择账号…</option>
                        {cfAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.alias}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : cfAccounts.length === 1 ? (
                    <div className="flex items-center justify-between gap-2 p-3.5 rounded-xl border border-border-base bg-hovered">
                      <span className="text-xs text-content-muted font-medium">目标 Cloudflare 账号</span>
                      <span className="text-xs font-semibold text-content-primary truncate min-w-0">
                        {cfAccounts[0].alias}
                      </span>
                    </div>
                  ) : (
                    <div className="p-3.5 rounded-xl border border-rose-200 bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/40">
                      <p className="text-xs text-rose-700 dark:text-rose-300 leading-relaxed">
                        还没有绑定 Cloudflare 账号。请先到「账号管理」绑定一个 API Token
                        （需 Zone:Read + Zone DNS:Edit 权限）。
                      </p>
                    </div>
                  )}

                  {delegateError && (
                    <div className="p-3.5 rounded-xl border border-rose-200 bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/40">
                      <p
                        data-deleg-error
                        className="text-xs text-rose-700 dark:text-rose-300 leading-relaxed break-words"
                      >
                        {delegateError}
                      </p>
                    </div>
                  )}
                </>
              ) : (
                delegateResult && (
                  <>
                    {/* 委派结果一览 */}
                    <div className="p-3.5 rounded-xl border border-border-base bg-hovered space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-content-secondary">
                          {delegateResult.zone_reused ? "已复用已有 zone" : "已新建 zone"}
                        </span>
                        <span
                          data-deleg-zone-status={delegateResult.zone_status}
                          className={`text-xs px-2.5 py-0.5 rounded-full font-semibold whitespace-nowrap flex-shrink-0 border ${
                            delegateResult.zone_status === "active"
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/80 dark:text-emerald-400 dark:border-emerald-900/60"
                              : "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/80 dark:text-amber-400 dark:border-amber-900/60"
                          }`}
                        >
                          {delegateResult.zone_status === "active" ? "已激活" : "待激活"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-content-muted font-medium flex-shrink-0">账号</span>
                        <span className="font-mono text-content-secondary truncate min-w-0">
                          {delegateResult.cf_account_alias}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-content-muted font-medium flex-shrink-0">zone</span>
                        <span className="font-mono text-content-secondary truncate min-w-0">
                          {delegateResult.zone_id}
                        </span>
                      </div>
                      <div className="text-xs">
                        <span className="text-content-muted font-medium block mb-1.5">
                          已写入 DNSHE 的 NS
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {delegateResult.ns_written.map((ns) => (
                            <span
                              key={ns}
                              className="font-mono text-[11px] bg-surface border border-border-base rounded px-2 py-0.5"
                            >
                              {ns}
                            </span>
                          ))}
                        </div>
                      </div>
                      <p className="text-[11px] text-content-muted leading-snug">
                        Cloudflare 是异步去父区检测这两台 NS 的（分钟级），检测通过后 zone 状态会自动变成
                        「已激活」。可到 Cloudflare 标签页同步一次查看最新状态。
                      </p>
                    </div>

                    {/* NS 写失败：说清是哪条、为什么，并给出下一步动作（§8） */}
                    {delegateResult.ns_failed.length > 0 && (
                      <div className="p-3.5 rounded-xl border border-rose-200 bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/40 space-y-1.5">
                        <p className="text-xs font-bold text-rose-700 dark:text-rose-300">
                          {delegateResult.ns_failed.length} 条 NS 写入失败，委派尚未生效
                        </p>
                        {delegateResult.ns_failed.map((f) => (
                          <p
                            key={f.ns}
                            className="text-[11px] font-mono text-rose-700 dark:text-rose-300 break-all"
                          >
                            {f.ns} —— {f.msg}
                          </p>
                        ))}
                        {delegateResult.ns_management_disabled && (
                          <p className="text-[11px] text-rose-700 dark:text-rose-300 leading-snug">
                            DNSHE 上游已禁用该域名的 NS 管理，只能到 DNSHE 官网后台手动把 NS 改成上面两台。
                          </p>
                        )}
                      </div>
                    )}

                    {/* 被清掉的 apex 冲突记录：必须说出来，否则用户以为记录"凭空少了" */}
                    {delegateResult.removed_records.length > 0 && (
                      <div className="p-3.5 rounded-xl border border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/40">
                        <p className="text-xs font-bold text-amber-800 dark:text-amber-300 mb-1">
                          已清理 {delegateResult.removed_records.length} 条 apex 冲突记录
                        </p>
                        {delegateResult.removed_records.map((r) => (
                          <p
                            key={r}
                            className="text-[11px] font-mono text-amber-700 dark:text-amber-200/90 break-all"
                          >
                            {r}
                          </p>
                        ))}
                        <p className="text-[11px] text-amber-700 dark:text-amber-200/90 mt-1 leading-snug">
                          它们也在下面的迁移清单里，勾选后会在 Cloudflare 重新建回来。
                        </p>
                      </div>
                    )}

                    {/* 迁移清单 */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="text-xs font-bold text-content-secondary uppercase tracking-wider min-w-0 truncate">
                          待迁移记录（已选 {delegateSelectedKeys.size} / {delegateResult.records.length}）
                        </h4>
                        {delegateResult.records.length > 0 && (
                          <button
                            onClick={toggleAllDelegateRecords}
                            className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 whitespace-nowrap flex-shrink-0 h-8 px-2 rounded-lg hover:bg-hovered"
                          >
                            {delegateSelectedKeys.size === delegateResult.records.length ? "全不选" : "全选"}
                          </button>
                        )}
                      </div>

                      {delegateResult.records.length === 0 ? (
                        <div className="border border-dashed border-border-base rounded-xl p-6 text-center">
                          <p className="text-xs text-content-muted">
                            该域名原本没有可迁移的解析记录，无需重建。
                          </p>
                        </div>
                      ) : (
                        <div className="bg-hovered border border-border-base rounded-xl overflow-hidden divide-y divide-border-soft max-h-64 overflow-y-auto">
                          {delegateResult.records.map((rec, i) => {
                            const key = String(i);
                            return (
                              <label
                                key={key}
                                data-deleg-rec={key}
                                data-deleg-checked={delegateSelectedKeys.has(key) ? "1" : "0"}
                                className="p-3 flex items-start gap-2.5 cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={delegateSelectedKeys.has(key)}
                                  onChange={() => toggleDelegateRecord(key)}
                                  className="mt-0.5 w-4 h-4 rounded border-border-base text-indigo-600 focus:ring-indigo-500 flex-shrink-0 cursor-pointer"
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-2">
                                    <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold whitespace-nowrap flex-shrink-0 bg-elevated text-content-secondary border border-border-base">
                                      {rec.type}
                                    </span>
                                    <span className="font-mono text-xs text-content-primary truncate min-w-0">
                                      {rec.name}
                                    </span>
                                  </span>
                                  <span className="block font-mono text-[11px] text-content-muted truncate mt-0.5">
                                    {rec.content}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                      <p className="text-[11px] text-content-muted leading-snug">
                        NS 与 SOA 不在清单里 —— 新建的 Cloudflare zone 自带这两类，重复写会直接冲突。
                      </p>
                    </div>

                    {/* 逐条写入结果（§8：失败要逐条列出别名与原因） */}
                    {delegateApplyResults && (
                      <div
                        data-deleg-apply="1"
                        className="bg-hovered border border-border-base rounded-xl p-3 space-y-1 max-h-40 overflow-y-auto"
                      >
                        {delegateApplyResults.map((r, i) => (
                          <div
                            key={i}
                            className={`flex items-start gap-2 text-[11px] ${
                              r.success ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
                            }`}
                          >
                            {r.success ? (
                              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                            ) : (
                              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                            )}
                            <span className="font-mono break-all">
                              {r.label} —— {r.message}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )
              )}
            </div>

            {/* 模态框页脚：两按钮各占一半（§14 第 9 条：一行两个控件均分撑满） */}
            <div
              data-deleg-foot="1"
              className="px-4 sm:px-6 py-4 border-t border-border-base bg-elevated flex-shrink-0"
            >
              {delegateStep === "confirm" ? (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setDelegateDomain(null)}
                    disabled={delegateLoading}
                    className="h-10 flex items-center justify-center whitespace-nowrap bg-elevated hover:bg-hovered text-content-secondary border border-border-base rounded-lg text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleStartDelegate}
                    disabled={
                      delegateLoading ||
                      cfAccounts.length === 0 ||
                      (cfAccounts.length > 1 && !delegateCfAccountId)
                    }
                    className="h-10 flex items-center justify-center gap-1.5 whitespace-nowrap bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {delegateLoading && <RefreshCw className="w-4 h-4 animate-spin flex-shrink-0" />}
                    {delegateLoading ? "委派中…" : "开始委派"}
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setDelegateDomain(null)}
                    disabled={delegateLoading}
                    className="h-10 flex items-center justify-center whitespace-nowrap bg-elevated hover:bg-hovered text-content-secondary border border-border-base rounded-lg text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    关闭
                  </button>
                  <button
                    onClick={handleApplyDelegateRecords}
                    disabled={delegateLoading || delegateSelectedKeys.size === 0}
                    className="h-10 flex items-center justify-center gap-1.5 whitespace-nowrap bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {delegateLoading && <RefreshCw className="w-4 h-4 animate-spin flex-shrink-0" />}
                    {delegateLoading ? "写入中…" : "确认写入"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {nsModalOpen && nsModalDomain && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="bg-surface border border-border-base w-full max-w-2xl max-h-[90dvh] rounded-2xl overflow-hidden flex flex-col shadow-2xl">
            {/* 模态框头部 */}
            <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-2 border-b border-border-base flex-shrink-0">
              <div className="min-w-0">
                <h3 className="text-base sm:text-lg font-bold text-content-primary flex items-center gap-2">
                  <Server className="text-sky-400 w-5 h-5 flex-shrink-0" />
                  <span className="truncate">NS 域名服务器设置 / 域名委派</span>
                </h3>
                <p className="text-xs text-content-muted mt-0.5 font-mono truncate">
                  域名: {nsModalDomain.full_domain}
                </p>
              </div>
              <button
                onClick={() => setNsModalOpen(false)}
                className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded flex-shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 模态框内容 */}
            <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4 sm:space-y-6">
              
              {/* 当前 NS 状态指示
                  以域名自身的委派状态（checkHasDns，来自同步的 ns1/ns2 字段）为准，
                  而不是区域内 NS 解析记录的条数 —— 两者是两回事：
                  官网把 NS 改回 ns1/ns2.dnshe.com 后，区域里遗留的 NS 记录不会自动消失。 */}
              {(() => {
                const isDefaultNs = checkHasDns(nsModalDomain);
                const hasLeftoverNs = nsRecords.length > 0;
                const providerLabel = getDnsProviderLabel(nsModalDomain, nsRecords);
                return (
                  <div className="p-4 rounded-xl border border-border-base bg-hovered flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <span className="text-xs text-content-muted block font-medium">当前 NS 运行状态</span>
                      <span className="text-sm font-bold text-content-primary mt-1 block">
                        {isDefaultNs
                          ? "系统默认 (ns1.dnshe.com / ns2.dnshe.com)"
                          : `${providerLabel} 委派托管中`}
                      </span>
                      {isDefaultNs && hasLeftoverNs && (
                        <span className="text-[11px] text-amber-400 mt-1 block">
                          域名已委派回系统默认，但区域内仍残留 {nsRecords.length} 条 NS 解析记录，建议清理
                        </span>
                      )}
                    </div>
                    <div className="shrink-0">
                      {isDefaultNs ? (
                        <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/80 dark:text-emerald-400 dark:border-emerald-900/60 text-xs px-3 py-1 rounded-full font-semibold">
                          系统默认
                        </span>
                      ) : (
                        <span className="bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-800/60 text-xs px-3 py-1 rounded-full font-semibold">
                          {providerLabel}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* 已设置的 NS 记录列表 */}
              {loadingNsModal ? (
                <div className="flex justify-center py-6">
                  <RefreshCw className="w-6 h-6 animate-spin text-indigo-500" />
                </div>
              ) : nsRecords.length > 0 ? (
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-content-secondary uppercase tracking-wider">
                    {checkHasDns(nsModalDomain)
                      ? "区域内残留的 NS 解析记录"
                      : "当前委派的第三方 NS 服务器列表"}
                  </h4>
                  <div className="bg-hovered border border-border-base rounded-xl overflow-hidden divide-y divide-border-soft">
                    {nsRecords.map((rec) => (
                      <div key={rec.id} className="p-3.5 flex justify-between items-center text-xs font-mono">
                        <span className="text-content-secondary">{rec.content}</span>
                        <button
                          onClick={async () => {
                            await handleDeleteDnsRecord(rec.id ?? rec.record_id!, nsModalDomain);
                            handleOpenNsModal(nsModalDomain);
                            handleSyncDomains();
                          }}
                          disabled={actionLoading === `delete-dns-${rec.id ?? rec.record_id}`}
                          className="text-red-600 hover:text-red-700 p-2 md:p-1 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-950/40 rounded transition-all"
                          title="删除此 NS 记录"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={handleResetToDefaultNs}
                    disabled={actionLoading === "reset-ns"}
                    className="w-full bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/60 dark:hover:bg-emerald-900/60 dark:text-emerald-300 dark:border-emerald-900/60 py-2.5 rounded-xl font-semibold text-xs flex items-center justify-center gap-2 transition-all shadow-inner mt-2"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${actionLoading === "reset-ns" ? "animate-spin" : ""}`} />
                    {checkHasDns(nsModalDomain)
                      ? `清理这 ${nsRecords.length} 条残留 NS 记录`
                      : "一键恢复为系统默认 NS (ns1.dnshe.com / ns2.dnshe.com)"}
                  </button>
                </div>
              ) : (
                <div className="text-center py-4 bg-hovered rounded-xl border border-border-base text-content-muted text-xs">
                  当前处于系统默认 NS。填下方表单可直接新增外部 NS 并切为「外部 DNS 委派」模式。
                </div>
              )}

              {/* 添加自定义第三方 NS 表单 */}
              <form onSubmit={handleAddCustomNs} className="p-4 border border-border-base rounded-xl bg-hovered space-y-3">
                <h4 className="text-xs font-bold text-content-secondary">添加 / 变更自定义 NS 服务器</h4>
                <div>
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <label className="block text-[10px] text-content-muted font-bold uppercase">
                      第三方 NS 服务器地址
                    </label>
                    {parsedNsList.length > 0 && (
                      <span className="text-[10px] text-indigo-400 font-semibold">
                        已识别 {parsedNsList.length} 条
                      </span>
                    )}
                  </div>
                  <textarea
                    required
                    rows={3}
                    placeholder={"每行一个，或用逗号/空格分隔，例如：\ndara.ns.cloudflare.com\nrick.ns.cloudflare.com"}
                    value={newCustomNsContent}
                    onChange={(e) => setNewCustomNsContent(e.target.value)}
                    className="w-full form-input px-3 py-2.5 rounded-lg text-sm text-content-secondary font-mono resize-y"
                  />
                  <p className="text-[10px] text-content-muted mt-1">
                    可一次填多个（NS 委派通常需要主备至少两条），将逐条提交
                  </p>
                </div>
                <div className="flex items-center gap-2 py-1">
                  <input
                    type="checkbox"
                    id="forceReplaceNs"
                    checked={forceReplaceConflict}
                    onChange={(e) => setForceReplaceConflict(e.target.checked)}
                    className="w-4 h-4 text-indigo-600 rounded bg-surface border-border-base focus:ring-indigo-500 cursor-pointer"
                  />
                  <label htmlFor="forceReplaceNs" className="text-xs text-content-secondary font-medium cursor-pointer flex items-center gap-1">
                    强制替换冲突记录
                    <span className="text-[11px] text-content-muted font-normal">（自动删除同名 A / CNAME / TXT / MX 等冲突解析）</span>
                  </label>
                </div>
                <button
                  type="submit"
                  disabled={actionLoading === "add-ns" || parsedNsList.length === 0}
                  className="w-full btn-primary py-2.5 rounded-lg font-semibold text-xs text-white flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {actionLoading === "add-ns" && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  {parsedNsList.length > 1
                    ? `添加 ${parsedNsList.length} 条 NS 委派记录`
                    : "添加 NS 委派记录"}
                </button>
              </form>

            </div>

            {/* 页脚 */}
            <div className="bg-elevated px-4 sm:px-6 py-4 border-t border-border-base flex justify-end flex-shrink-0">
              <button
                onClick={() => setNsModalOpen(false)}
                className="bg-elevated hover:bg-hovered text-content-secondary text-sm font-semibold px-4 py-2 rounded-lg"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 全局 Toast 通知 */}
      {toast && (
        /* NOTE: 必须限宽 + 换行 —— 推送失败会把平台返回的原文带上来（Server酱 填错地址时
           对方回的是一整段 XML），不限宽的话 toast 会横着铺满整个视口。 */
        <div className="fixed bottom-5 right-5 z-50 max-w-[min(90vw,28rem)] flex items-start gap-2.5 px-4 py-3 rounded-lg shadow-2xl border transition-all duration-300 transform translate-y-0 text-sm font-semibold bg-surface text-content-primary border-border-base">
          {toast.type === "success" && <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />}
          {toast.type === "error" && <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />}
          {toast.type === "info" && <Info className="w-5 h-5 text-indigo-500 flex-shrink-0" />}
          {toast.type === "warning" && <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" />}
          <span className="min-w-0 break-words line-clamp-6">{toast.message}</span>
        </div>
      )}

    </div>
  );
}
