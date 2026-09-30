/**
 * D1 → SQLite 适配层自检
 *
 * 跑法：npm run test:node
 *
 * 目的不是覆盖业务逻辑，而是钉住适配层与 D1 的行为差异 —— 这些点一旦跑偏，
 * 症状都是「Cloudflare 上正常、自建版数据莫名其妙」，不容易一眼看出来：
 *   · batch() 的原子性（syncAccountDomains 把 UPSERT 与 DELETE 混在一批里）
 *   · bind() 的不可变语义（buildDomainUpsert 的返回值同时给 run() 和 batch() 用）
 *   · meta.changes（purgeExpiredCache / pruneExpiredLogs 靠它报告清理条数）
 *   · first() 无行时返回 null 而不是 undefined
 *   · 外键级联（deleteAccount 依赖 ON DELETE CASCADE 清 domains_cache）
 *   · AES-GCM / PBKDF2 在 Node 的 WebCrypto 上与 Workers 行为一致
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { DatabaseManager } from "../src/db";
import type { UpstreamSubdomain } from "../src/db";
import { planDnsChecks, DNS_THREE_STATES } from "../src/dns-provider";
import type { CachedDomainStamp } from "../src/dns-provider";
import { createD1FromSqlite } from "./d1-sqlite";

const AES_KEY = "test-only-key-do-not-reuse";

let passed = 0;
async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const d1 = createD1FromSqlite(sqlite);
  return { sqlite, d1, dbm: new DatabaseManager(d1, AES_KEY) };
}

function sub(id: number, name: string, extra: Partial<UpstreamSubdomain> = {}): UpstreamSubdomain {
  return {
    id,
    subdomain: name,
    rootdomain: "cn.mt",
    full_domain: `${name}.cn.mt`,
    status: "已解析",
    created_at: "2026-01-01 00:00:00",
    expires_at: "2027-01-01 00:00:00",
    dns_state_known: true,
    has_dns: 1,
    dns_provider: "system",
    ...extra,
  };
}

console.log("\nD1 → SQLite 适配层自检");

const { sqlite, d1, dbm } = freshDb();

await it("ensureTables() 建表成功（走 batch + PRAGMA table_info）", async () => {
  assert.equal(await dbm.ensureTables(), true);
  const tables = await d1
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>();
  const names = tables.results.map((r) => r.name);
  for (const expected of ["accounts", "cache", "domains_cache", "logs", "settings"]) {
    assert.ok(names.includes(expected), `缺少表 ${expected}`);
  }
});

await it("first() 无匹配行时返回 null（D1 语义，非 undefined）", async () => {
  const row = await d1.prepare("SELECT id FROM accounts WHERE id = ?").bind(999).first();
  assert.equal(row, null);
});

await it("run() 回报 meta.changes 与 meta.last_row_id", async () => {
  const res = await d1
    .prepare("INSERT INTO accounts (alias, api_key, api_secret) VALUES (?, ?, ?)")
    .bind("测试账号", "cfsd_test_key", "plain:c2VjcmV0")
    .run();
  assert.equal(res.meta.changes, 1);
  assert.equal(res.meta.last_row_id, 1);
  assert.equal(res.success, true);
});

await it("setSetting/getSetting 往返，且 UPSERT 覆盖旧值", async () => {
  await dbm.setSetting("probe", "v1");
  assert.equal(await dbm.getSetting("probe"), "v1");
  await dbm.setSetting("probe", "v2");
  assert.equal(await dbm.getSetting("probe"), "v2");
});

await it("PBKDF2 密码哈希与校验（Node WebCrypto）", async () => {
  await dbm.setPassword("admin", "Sm0keTest!2026");
  assert.equal(await dbm.verifyPassword("Sm0keTest!2026"), true);
  assert.equal(await dbm.verifyPassword("wrong-password"), false);
  const cfg = await dbm.getAuthConfig();
  assert.equal(cfg.username, "admin");
  assert.equal(cfg.initialized, true);
});

await it("AES-GCM 加密的 2FA 密钥可原文取回", async () => {
  await dbm.setTwoFaSecret("JBSWY3DPEHPK3PXP");
  const cfg = await dbm.getAuthConfig();
  assert.equal(cfg.twoFaSecret, "JBSWY3DPEHPK3PXP");
  // 库里存的必须是密文
  const stored = await dbm.getSetting("auth_2fa_secret");
  assert.ok(stored && !stored.includes("JBSWY3DPEHPK3PXP"), "2FA 密钥不应以明文落库");
});

await it("syncAccountDomains() 批量写入（batch + buildDomainUpsert）", async () => {
  await dbm.syncAccountDomains(1, [sub(101, "alpha"), sub(102, "beta"), sub(103, "gamma")]);
  const domains = await dbm.getDomains();
  assert.equal(domains.length, 3);
  assert.deepEqual(
    domains.map((d) => d.full_domain).sort(),
    ["alpha.cn.mt", "beta.cn.mt", "gamma.cn.mt"]
  );
  // LEFT JOIN 出来的账号别名
  assert.equal(domains[0].account_alias, "测试账号");
});

await it("syncAccountDomains() 会删除上游已不存在的域名（同一批里混 DELETE）", async () => {
  await dbm.syncAccountDomains(1, [sub(101, "alpha"), sub(102, "beta")]);
  const left = (await dbm.getDomains()).map((d) => d.id).sort();
  assert.deepEqual(left, [101, 102]);
});

await it("dns_state_known 缺失时不覆盖已识别出的三态", async () => {
  await dbm.syncAccountDomains(1, [
    sub(101, "alpha", { dns_state_known: true, status: "已委派", has_dns: 0, dns_provider: "Cloudflare" }),
    sub(102, "beta"),
  ]);
  // 第二次同步不带 dns_state_known（模拟 subdomains/list 没有解析记录）
  await dbm.syncAccountDomains(1, [
    sub(101, "alpha", { dns_state_known: undefined, status: "active", dns_provider: undefined, has_dns: undefined, ns1: "ns1.cloudflare.com" }),
    sub(102, "beta"),
  ]);
  const alpha = await dbm.getDomainById(101);
  assert.equal(alpha?.status, "已委派", "三态被上游注册态覆盖了");
  assert.equal(alpha?.dns_provider, "Cloudflare");
});

await it("remote_updated_at 只在真正复核过时才写入（增量同步的判据）", async () => {
  // 复核过：带上上游时间戳
  await dbm.syncAccountDomains(1, [
    sub(101, "alpha", { remote_updated_at: "2026-09-29 21:40:44" }),
  ]);
  assert.equal((await dbm.getDomainById(101))?.remote_updated_at, "2026-09-29 21:40:44");

  // 没复核（缺 dns_state_known）：不能动已存的时间戳，更不能把它写成 null ——
  // 否则下次同步会把这个域名当成「从没查过」而永久重复查询
  await dbm.syncAccountDomains(1, [
    sub(101, "alpha", { dns_state_known: undefined, remote_updated_at: "2026-09-29 21:40:44" }),
    sub(102, "beta"),
  ]);
  assert.equal((await dbm.getDomainById(101))?.remote_updated_at, "2026-09-29 21:40:44");
  assert.equal((await dbm.getDomainById(102))?.remote_updated_at, null);
});

await it("getDomainSyncIndex() 一次取回全部域名的增量快照", async () => {
  const index = await dbm.getDomainSyncIndex();
  const alpha = index.get(101);
  assert.ok(alpha, "快照里缺少已存在的域名");
  assert.equal(alpha.account_id, 1);
  assert.ok(DNS_THREE_STATES.has(String(alpha.status)), "快照里的 status 应是三态之一");
  assert.equal(alpha.remote_updated_at, "2026-09-29 21:40:44");
  assert.ok(alpha.updated_at, "缺 updated_at 就无法判断「多久没复核过」");
  // 未复核过的域名 remote_updated_at 为 null（下次同步会把它排进复核队列）
  assert.equal(index.get(102)?.remote_updated_at, null);
});

await it("planDnsChecks() 只挑出真正需要联网复核的域名", () => {
  const stamp = (status: string, remote: string | null, updated: string | null): CachedDomainStamp => ({
    status,
    remote_updated_at: remote,
    updated_at: updated,
  });
  const stamps = new Map<number, CachedDomainStamp>([
    [1, stamp("已解析", "2026-09-01 00:00:00", "2026-09-30 10:00:00")],
    [2, stamp("已解析", "2026-09-01 00:00:00", "2026-09-30 10:00:00")],
    [3, stamp("active", null, "2026-09-30 10:00:00")],
    [4, stamp("已委派", "2026-08-01 00:00:00", "2026-08-01 09:00:00")],
    [6, stamp("已解析", "2026-09-01 00:00:00", "2026-09-30 10:00:00")],
  ]);
  const listed = [
    { id: 1, updated_at: "2026-09-01 00:00:00" }, // 上游没变 + 三态已知 → 跳过（唯一省下子请求的一条）
    { id: 2, updated_at: "2026-09-20 00:00:00" }, // 上游变过 → changed
    { id: 3, updated_at: "2026-09-01 00:00:00" }, // 缓存里不是三态 → unknown-state
    { id: 4, updated_at: "2026-08-01 00:00:00" }, // 上游没变但太久没复核 → stale
    { id: 5, updated_at: "2026-09-01 00:00:00" }, // 缓存里没有 → new
    { id: 6 },                                    // 上游不给时间戳 → 不敢跳过 → changed
  ];

  const plan = planDnsChecks(listed, stamps, "2026-09-25 00:00:00");
  assert.equal(plan.skipped, 1, "只有 id=1 该被跳过");
  // 优先级：new → changed → unknown-state → stale
  assert.deepEqual(plan.ids, [5, 2, 6, 3, 4]);
  assert.equal(plan.reasons.get(5), "new");
  assert.equal(plan.reasons.get(2), "changed");
  assert.equal(plan.reasons.get(6), "changed");
  assert.equal(plan.reasons.get(3), "unknown-state");
  assert.equal(plan.reasons.get(4), "stale");

  // 关掉时间兜底时，只有「上游没变 + 三态已知」的才跳过
  const noCutoff = planDnsChecks(listed, stamps, null);
  assert.ok(!noCutoff.ids.includes(4), "cutoff=null 时不该因年龄复核");
  assert.ok(!noCutoff.ids.includes(1));
});

await it("planDnsChecks() 同优先级内按「最久没复核」排队", () => {
  const mk = (updated: string): CachedDomainStamp => ({
    status: "已解析",
    remote_updated_at: "2026-01-01 00:00:00",
    updated_at: updated,
  });
  // 全部都是 changed（上游时间戳与缓存不一致），按本地写入时间升序
  const stamps = new Map<number, CachedDomainStamp>([
    [11, mk("2026-09-30 10:00:00")],
    [12, mk("2026-08-01 10:00:00")],
    [13, mk("2026-09-01 10:00:00")],
  ]);
  const plan = planDnsChecks(
    [
      { id: 11, updated_at: "2026-09-30 00:00:00" },
      { id: 12, updated_at: "2026-09-30 00:00:00" },
      { id: 13, updated_at: "2026-09-30 00:00:00" },
    ],
    stamps,
    null
  );
  assert.deepEqual(plan.ids, [12, 13, 11], "预算不够时应优先刷新最久没查过的");
});

await it("upsertDomain() 单条写入走同一个 bind() 结果（不可变语义）", async () => {
  await dbm.upsertDomain(1, sub(104, "delta"));
  const delta = await dbm.getDomainById(104);
  assert.equal(delta?.full_domain, "delta.cn.mt");
  // 已存在的行再 upsert 一次只更新，不重复插入
  await dbm.upsertDomain(1, sub(104, "delta", { expires_at: "2028-01-01 00:00:00" }));
  assert.equal((await dbm.getDomains()).filter((d) => d.id === 104).length, 1);
  assert.equal((await dbm.getDomainById(104))?.expires_at, "2028-01-01 00:00:00");
});

await it("bind() 返回新语句，不会互相踩参数", async () => {
  const stmt = d1.prepare("SELECT ? AS v");
  const a = stmt.bind("first");
  const b = stmt.bind("second");
  assert.equal((await a.first<{ v: string }>())?.v, "first");
  assert.equal((await b.first<{ v: string }>())?.v, "second");
});

await it("batch() 出错时整批回滚", async () => {
  const before = (await dbm.getDomains()).length;
  await assert.rejects(
    d1.batch([
      d1.prepare("INSERT INTO domains_cache (id, account_id, subdomain, rootdomain, full_domain, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(901, 1, "ok", "cn.mt", "ok.cn.mt", "未解析", "2027-01-01 00:00:00"),
      // account_id = 12345 违反外键约束，整批必须回退
      d1.prepare("INSERT INTO domains_cache (id, account_id, subdomain, rootdomain, full_domain, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(902, 12345, "bad", "cn.mt", "bad.cn.mt", "未解析", "2027-01-01 00:00:00"),
    ])
  );
  assert.equal((await dbm.getDomains()).length, before, "失败的 batch 留下了半成品数据");
  assert.equal(await d1.prepare("SELECT id FROM domains_cache WHERE id = ?").bind(901).first(), null);
});

await it("缓存读写与 purgeExpiredCache() 的 meta.changes", async () => {
  await dbm.setCache("api_cache:probe", JSON.stringify({ hit: true }));
  assert.equal(await dbm.getCache("api_cache:probe"), '{"hit":true}');
  // 手动写一条已过期的缓存行
  await d1.prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)")
    .bind("api_cache:stale", "x", 1).run();
  assert.equal(await dbm.getCache("api_cache:stale"), null, "过期行不该被读到");
  assert.equal(await dbm.purgeExpiredCache(), 1);
  assert.equal(await dbm.getCache("api_cache:probe"), '{"hit":true}', "未过期的行被误删");
});

await it("查重池批量查询（域名内联为字面量，绑定参数恒为 1）", async () => {
  await dbm.addToWhoisPool("taken.cn.mt");
  const hits = await dbm.getWhoisPool(["taken.cn.mt", "free.cn.mt"]);
  assert.deepEqual(hits, ["taken.cn.mt"]);
});

await it("日志写入与按分类过滤", async () => {
  await dbm.writeLog("success", "operation", "适配层自检日志", { probe: 1 });
  const all = await dbm.getLogs(10);
  assert.ok(all.length > 0);
  const ops = await dbm.getLogs(10, ["operation"]);
  assert.ok(ops.every((l) => l.category === "operation"));
  assert.ok(ops.some((l) => l.message === "适配层自检日志"));
});

await it("markDomainRenewed() 更新到期时间与续期时间", async () => {
  await dbm.markDomainRenewed(101, "2029-01-01 00:00:00");
  const row = await dbm.getDomainById(101);
  assert.equal(row?.expires_at, "2029-01-01 00:00:00");
  assert.ok(row?.last_renewed_at);
});

await it("upsertApiKey() 不带 Secret 的列表同步不会抹掉已保存的密文", async () => {
  // ① 创建 / 重置密钥时带 Secret 落库
  await dbm.upsertApiKey({
    accountId: 1, keyId: 7, keyName: "主密钥", apiKey: "k_alpha", apiSecret: "s_alpha", status: "active",
  });
  assert.equal(await dbm.revealApiKeySecret(1, "k_alpha"), "s_alpha");

  // ② 列表同步（上游永远不回传 Secret）：只更新状态字段，密文必须原样保留。
  //    这条是 `/api/keys` 每次刷新都把上游清单登记进库之后的**安全底线**。
  await dbm.upsertApiKey({
    accountId: 1, keyId: 7, keyName: "主密钥", apiKey: "k_alpha",
    status: "disabled", requestCount: 42, lastUsedAt: "2026-09-30 10:00:00",
  });
  assert.equal(
    await dbm.revealApiKeySecret(1, "k_alpha"), "s_alpha",
    "不带 Secret 的同步把已保存的密文抹掉了"
  );

  const row = (await dbm.listStoredApiKeys(1)).find((r) => r.apiKey === "k_alpha");
  assert.equal(row?.hasSecret, true, "hasSecret 被列表同步改成了 false");
  assert.equal(row?.status, "disabled", "状态字段没被同步更新");
  assert.equal(row?.requestCount, 42);

  // ③ 只有真的带回新 Secret（重置）时才覆盖
  await dbm.upsertApiKey({
    accountId: 1, keyId: 7, keyName: "主密钥", apiKey: "k_alpha", apiSecret: "s_beta",
  });
  assert.equal(await dbm.revealApiKeySecret(1, "k_alpha"), "s_beta");

  // ④ 上游新出现、本地从未持有的密钥：登记成一条，但 hasSecret 必须是 false ——
  //    上游不会回传 Secret，不能假装本地有（否则「回显」按钮会去解密一个 null）
  await dbm.upsertApiKey({
    accountId: 1, keyId: 8, keyName: "历史密钥", apiKey: "k_beta", status: "active",
  });
  const beta = (await dbm.listStoredApiKeys(1)).find((r) => r.apiKey === "k_beta");
  assert.equal(beta?.hasSecret, false, "本地没有密文时应标记 hasSecret=false");
  assert.equal(beta?.keyId, 8);
});

await it("deleteAccount() 依赖外键级联清掉 domains_cache", async () => {
  assert.ok((await dbm.getDomains()).length > 0);
  await dbm.deleteAccount(1);
  assert.equal((await dbm.getAccounts()).length, 0);
  assert.equal((await dbm.getDomains()).length, 0, "外键级联没生效，域名缓存成了孤儿数据");
});

sqlite.close();

console.log(`\n${passed} 项通过${process.exitCode ? "，存在失败项" : "，全部通过"}\n`);
