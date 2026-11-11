#!/usr/bin/env node
/**
 * 注册查重 / DDNS 定向回归。
 * 仅使用本地 Vite 与 Playwright headless，所有 API 都在页面请求层拦截，
 * 不登录远端、不写业务数据、不占用前台键鼠。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.REGISTER_DDNS_PORT || 3016);
const base = new URL(process.env.BASE || `http://127.0.0.1:${port}`);
assert(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname));

let devServer = null;
if (!process.env.BASE) {
  const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", `npm --prefix frontend run dev -- --mode selfhost --host 127.0.0.1 --port ${port}`]
    : ["--prefix", "frontend", "run", "dev", "--", "--mode", "selfhost", "--host", "127.0.0.1", "--port", String(port)];
  devServer = spawn(command, args, {
    cwd: repo,
    stdio: "ignore",
    windowsHide: true,
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const res = await fetch(base);
      if (res.ok) break;
    } catch { /* Vite 尚未启动 */ }
    await delay(250);
  }
}

const { chromium } = await import(process.env.REVIEW_PLAYWRIGHT
  ? pathToFileURL(process.env.REVIEW_PLAYWRIGHT).href
  : "playwright");
const browser = await chromium.launch({ headless: true });
const shotDir = process.env.REGISTER_DDNS_SHOT_DIR;
if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
const report = { passed: false, tests: [], requests: [], pageErrors: [] };

const check = async (name, action) => {
  try {
    await action();
    report.tests.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.tests.push({ name, passed: false, reason: error?.message || String(error) });
    console.log(`FAIL ${name}: ${error?.message || error}`);
    throw error;
  }
};

const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  serviceWorkers: "block",
  reducedMotion: "reduce",
});
await context.addInitScript(() => {
  localStorage.setItem("DNSHE_BACKEND_URL", "");
  if (!sessionStorage.getItem("RULE_CACHE_TEST_INITIALIZED")) {
    localStorage.removeItem("DNSHE_REGISTER_HISTORY");
    localStorage.removeItem("DNSHE_DOMAIN_CHECK_CACHE_V1");
    sessionStorage.setItem("RULE_CACHE_TEST_INITIALIZED", "1");
  }
  sessionStorage.setItem("DNSHE_SESSION", "synthetic-register-ddns");
});
const page = await context.newPage();
page.setDefaultTimeout(9000);
page.on("pageerror", (error) => report.pageErrors.push(error.message));
let whoisResponseMode = "available";
let quotaMode = "available";
let registerAttempts = 0;
let registerMode = 'failure';
let registeredDomain = null;

await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== base.origin) return route.abort();
  if (!url.pathname.startsWith("/api/")) return route.continue();
  report.requests.push({ method: request.method(), path: url.pathname, search: url.search });
  if (url.pathname === "/api/domains/register") {
    registerAttempts++;
    quotaMode = "exhausted";
    if (registerMode === 'success') {
      const input = request.postDataJSON();
      registeredDomain = { id: 301, account_id: 1, full_domain: `${input.subdomain}.${input.rootdomain}`, subdomain: input.subdomain, rootdomain: input.rootdomain, status: 'active', expires_at: '2099-01-01' };
      return route.fulfill({ json: { success: true, full_domain: registeredDomain.full_domain, cache_sync: 'synced' } });
    }
    return route.fulfill({ status: 400, json: { success: false, error_code: "quota_exceeded", message: "该账号配额已用尽，请选择其他账号。" } });
  }
  if (url.pathname === "/api/domains/sync") return route.fulfill({ json: { success: true, synced: [{ id: 1, checked: 0 }], failed: [], remaining: [], done: true } });
  if (url.pathname === "/api/auth/status") return route.fulfill({ json: { initialized: true, two_fa_enabled: false } });
  if (url.pathname === "/api/auth/account") return route.fulfill({ json: { success: true, username: "合成管理员", two_fa_enabled: false } });
  if (url.pathname === "/api/accounts") return route.fulfill({ json: { success: true, accounts: [
    { id: 1, alias: "合成账号", provider: "dnshe", api_key: "synthetic" },
    ...(quotaMode === "mixed" ? [{ id: 2, alias: "剩余额度账号", provider: "dnshe", api_key: "synthetic-2" }] : []),
  ] } });
  if (url.pathname === "/api/domains") return route.fulfill({ json: { success: true, domains: registeredDomain ? [registeredDomain] : [], last_sync: { at: null, type: "empty" } } });
  if (url.pathname === "/api/overview") return route.fulfill({ json: { success: true, domains: { total: 0, active: 0, expired: 0, expiring_soon: 0, delegated: 0, not_delegated: 0 }, accounts: { total: 1, dnshe: 1, cloudflare: 0 }, quota: { total: 0, used: 0, available: 0, failed: 0, accounts: [] }, assist: null } });
  if (url.pathname === "/api/quota") return route.fulfill({ json: {
    success: true,
    quotas: quotaMode === "null"
      ? [{ account_id: 1, alias: "合成账号", used: null, total: null, available: null }]
      : quotaMode === "error"
      ? [{ account_id: 1, alias: "合成账号", used: 0, total: 0, available: 0, error: "合成读取失败" }]
      : quotaMode === "mixed"
      ? [
        { account_id: 1, alias: "合成账号", used: 5, total: 5, available: 0 },
        { account_id: "2", alias: "剩余额度账号", used: 2, total: 5, available: 3 },
      ]
      : quotaMode === "exhausted"
      ? [{ account_id: 1, alias: "合成账号", used: 5, base: 5, invite_bonus: 0, total: 5, available: 0 }]
      : [{ account_id: 1, alias: "合成账号", used: 1, base: 5, invite_bonus: 0, total: 5, available: 4 }]
  } });
  if (url.pathname === "/api/assist/status") return route.fulfill({ json: { success: true, accounts: [], history: [] } });
  if (url.pathname === "/api/keys") return route.fulfill({ json: { success: true, groups: [], keys: [] } });
  if (url.pathname === "/api/logs") return route.fulfill({ json: { success: true, logs: [] } });
  if (url.pathname === "/api/ddns") return route.fulfill({ json: { success: true, bindings: [] } });
  if (url.pathname === "/api/expiry") return route.fulfill({ json: { success: true, results: [] } });
  if (url.pathname === "/api/cf/quota") return route.fulfill({ json: { success: true, accounts: [], limits: null } });
  if (url.pathname === "/api/whois/pool") return route.fulfill({ json: { success: true, registered: [] } });
  if (url.pathname === "/api/whois") {
    if (whoisResponseMode === "error") return route.fulfill({ status: 503, json: { success: false, message: "合成上游暂不可用" } });
    return route.fulfill({ json: { success: true, whois: { registered: false, status: whoisResponseMode } } });
  }
  return route.fulfill({ json: { success: true } });
});

const registerMain = page.locator('main[data-workspace="register"]');
const gotoRegister = async () => {
  await page.goto(new URL("/#register", base).href, { waitUntil: "networkidle" });
  await registerMain.waitFor();
};

try {
  await gotoRegister();
  await check("单域名查重写入历史", async () => {
    await registerMain.getByRole("button", { name: /精确单域名查重/ }).click();
    await registerMain.locator("input").first().fill("demo-check");
    await registerMain.locator("select").first().selectOption("us.ci");
    await registerMain.getByRole("button", { name: "WHOIS 查重", exact: true }).click();
    await registerMain.getByText("尚未注册", { exact: true }).waitFor();
    assert.match(
      await registerMain.locator("select option").filter({ hasText: "合成账号" }).first().textContent(),
      /已用\s*1\s*·\s*剩余\s*4/
    );
    assert.equal(await registerMain.locator('#register-account-quota-hint').count(), 0, '账号下方不应出现额外配额备注');
    const accountBox = await registerMain.locator('select').filter({ has: page.locator('option', { hasText: '合成账号' }) }).boundingBox();
    const registerBox = await registerMain.getByRole('button', { name: '一键注册该域名', exact: true }).boundingBox();
    assert(Math.abs(accountBox.y - registerBox.y) <= 1, '账号选择框与注册按钮上边缘必须对齐');
    assert(Math.abs(accountBox.height - registerBox.height) <= 1, '账号选择框与注册按钮必须同高');
    assert.equal(await registerMain.getByRole("region", { name: "查询历史" }).getByText("demo-check.us.ci", { exact: true }).count(), 1);
  });

  await check("可注册结果按账号配额禁用注册目标并提示已用与剩余", async () => {
    quotaMode = "exhausted";
    await page.reload({ waitUntil: "networkidle" });
    await registerMain.getByRole("button", { name: /精确单域名查重/ }).click();
    await registerMain.locator("input").first().fill("quota-check");
    await registerMain.getByRole("button", { name: "WHOIS 查重", exact: true }).click();
    await registerMain.getByText("尚未注册", { exact: true }).waitFor();
    const accountOption = registerMain.locator("select option").filter({ hasText: "合成账号" }).first();
    assert.equal(await accountOption.isDisabled(), true);
    assert.match(await accountOption.textContent(), /已用\s*5\/5\s*·\s*配额用尽/);
    assert.equal(await registerMain.locator('#register-target-account').inputValue(), "");
    assert.equal(await registerMain.getByRole("button", { name: "一键注册该域名", exact: true }).isDisabled(), true);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'register-exhausted.png'), fullPage: true });
    assert.equal(await registerMain.locator('#register-target-account option[value=""]').textContent(), "所有账号配额均已用尽");
    quotaMode = "available";
    await page.reload({ waitUntil: "networkidle" });
  });

  await check("未知或读取失败的配额不误判用尽", async () => {
    for (const mode of ["null", "error"]) {
      quotaMode = mode;
      await page.reload({ waitUntil: "networkidle" });
      await registerMain.getByRole("button", { name: /精确单域名查重/ }).click();
      await registerMain.locator("input").first().fill(`quota-${mode}`);
      await registerMain.getByRole("button", { name: "WHOIS 查重", exact: true }).click();
      await registerMain.getByText("尚未注册", { exact: true }).waitFor();
      const option = registerMain.locator('#register-target-account option').filter({ hasText: "合成账号" });
      assert.equal(await option.isDisabled(), false);
      assert.match(await option.textContent(), mode === "error" ? /配额读取失败/ : /配额未读取/);
      assert.equal(await registerMain.getByRole("button", { name: "一键注册该域名", exact: true }).isEnabled(), true);
    }
  });

  await check("进入与重新进入注册页均强制刷新配额，后台同步域名", async () => {
    quotaMode = "available";
    const before = report.requests.length;
    await page.reload({ waitUntil: "networkidle" });
    assert(report.requests.slice(before).some(r => r.path === "/api/quota" && r.search === "?refresh=1"));
    assert(report.requests.slice(before).some(r => r.path === "/api/domains/sync"));
    await page.evaluate(() => { location.hash = '#dashboard'; });
    await page.locator('main[data-workspace="dashboard"]').waitFor();
    quotaMode = "exhausted";
    const reenter = report.requests.length;
    await page.evaluate(() => { location.hash = '#register'; });
    await registerMain.waitFor();
    await page.waitForLoadState('networkidle');
    assert(report.requests.slice(reenter).some(r => r.path === "/api/quota" && r.search === "?refresh=1"));
  });

  await check("注册失败后刷新配额并禁用用尽账号，不重放创建", async () => {
    quotaMode = "available";
    await page.reload({ waitUntil: "networkidle" });
    await registerMain.getByRole("button", { name: /精确单域名查重/ }).click();
    await registerMain.locator("input").first().fill("quota-race");
    await registerMain.getByRole("button", { name: "WHOIS 查重", exact: true }).click();
    await registerMain.getByText("尚未注册", { exact: true }).waitFor();
    const before = report.requests.length;
    await registerMain.getByRole("button", { name: "一键注册该域名", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#register-target-account option[value="1"]')?.disabled === true);
    assert.equal(registerAttempts, 1);
    const after = report.requests.slice(before);
    const create = after.findIndex(r => r.path === '/api/domains/register');
    assert(after.slice(create + 1).some(r => r.path === '/api/quota' && r.search === '?refresh=1'));
    assert(after.some(r => r.path === '/api/domains'));
    assert(after.some(r => r.path === '/api/overview'));
    assert.equal(await registerMain.getByRole("button", { name: "一键注册该域名", exact: true }).isDisabled(), true);
    quotaMode = "available";
    await page.reload({ waitUntil: "networkidle" });
  });

  await check("混合额度自动选择有剩余的账号并兼容字符串账号ID", async () => {
    quotaMode = "mixed";
    await page.reload({ waitUntil: "networkidle" });
    await registerMain.getByRole("button", { name: /精确单域名查重/ }).click();
    await registerMain.locator("input").first().fill("quota-mixed");
    await registerMain.getByRole("button", { name: "WHOIS 查重", exact: true }).click();
    await registerMain.getByText("尚未注册", { exact: true }).waitFor();
    const select = registerMain.locator('#register-target-account');
    await page.waitForFunction(() => document.querySelector('#register-target-account')?.value === "2");
    assert.equal(await select.locator('option[value="1"]').isDisabled(), true);
    assert.equal(await select.locator('option[value="2"]').isEnabled(), true);
    assert.match(await select.locator('option[value="2"]').textContent(), /已用 2 · 剩余 3/);
    quotaMode = "available";
    await page.reload({ waitUntil: "networkidle" });
  });

  await check("注册成功后域名列表出现新对象，账户配额同步用尽", async () => {
    registerMode = 'success';
    quotaMode = 'available';
    await page.reload({ waitUntil: 'networkidle' });
    await registerMain.getByRole('button', { name: /精确单域名查重/ }).click();
    await registerMain.locator('input').first().fill('registered-sync');
    await registerMain.getByRole('button', { name: 'WHOIS 查重', exact: true }).click();
    await registerMain.getByText('尚未注册', { exact: true }).waitFor();
    await registerMain.getByRole('button', { name: '一键注册该域名', exact: true }).click();
    const domainsMain = page.locator('main[data-workspace="domains"]');
    await domainsMain.waitFor();
    await domainsMain.getByText(registeredDomain.full_domain, { exact: true }).first().waitFor();
    await page.evaluate(() => { location.hash = '#quota'; });
    const quotaMain = page.locator('main[data-workspace="quota"]');
    await quotaMain.waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(await quotaMain.locator('.ew-quota-summary > div > strong').textContent(), '0');
    assert.equal(await quotaMain.locator('.ew-quota-focus-facts b').first().textContent(), '5');
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'quota-after-registration.png'), fullPage: true });
    await page.evaluate(() => { location.hash = '#register'; });
    await registerMain.waitFor();
    registerMode = 'failure';
    registeredDomain = null;
    quotaMode = 'available';
    await page.reload({ waitUntil: 'networkidle' });
  });

  await check("账号默认全选，取消全部或最后一项不会意外恢复全选，空范围不能启动", async () => {
    await registerMain.getByRole("button", { name: /规则多域名查重/ }).click();
    const scope = registerMain.getByRole("button", { name: "查重账号范围", exact: true });
    assert.equal(await scope.getAttribute("aria-expanded"), "false");
    assert.equal(await registerMain.getByRole("group", { name: "可用查重账号", exact: true }).count(), 0);
    await scope.click();
    const panel = registerMain.getByRole("group", { name: "可用查重账号", exact: true });
    const triggerBox = await scope.boundingBox();
    const panelBox = await panel.boundingBox();
    assert(panelBox.y - triggerBox.y - triggerBox.height >= 10, "列表与范围控件必须留有间距");
    const all = registerMain.getByRole("checkbox", { name: "全部账号轮转", exact: true });
    const account = registerMain.getByRole("checkbox", { name: "查重账号：合成账号", exact: true });
    assert.equal(await all.isChecked(), true);
    assert.equal(await account.isChecked(), true);
    const before = report.requests.filter(request => request.path === "/api/whois").length;
    await all.uncheck();
    assert.equal(await account.isChecked(), false);
    assert.equal(await registerMain.getByRole("button", { name: "开始查询", exact: true }).isDisabled(), true);
    await registerMain.getByText("请至少勾选一个查重账号", { exact: true }).waitFor();
    await account.check();
    assert.equal(await all.isChecked(), true);
    await account.uncheck();
    assert.equal(await all.isChecked(), false);
    assert.equal(await account.isChecked(), false);
    assert.equal(await registerMain.getByRole("button", { name: "开始查询", exact: true }).isDisabled(), true);
    assert.equal(report.requests.filter(request => request.path === "/api/whois").length, before);
    await all.check();
    assert.equal(await account.isChecked(), true);
    await account.focus();
    await page.keyboard.press("Escape");
    assert.equal(await scope.getAttribute("aria-expanded"), "false");
    assert.equal(await scope.evaluate(element => element === document.activeElement), true);
    await scope.click();
    await registerMain.getByRole("region", { name: "规则与过滤", exact: true }).getByPlaceholder(/例如: \{字母\}/).click();
    assert.equal(await scope.getAttribute("aria-expanded"), "false");
  });

  await check("规则与过滤常驻，排除与缓存仅保留并列选项，排除编辑和图标重置仍可用", async () => {
    const rules = registerMain.getByRole("region", { name: "规则与过滤", exact: true });
    assert.equal(await rules.isVisible(), true);
    assert.equal(await registerMain.locator(".flow-advanced").count(), 0);
    assert.equal(await registerMain.locator("summary").filter({ hasText: /高级规则与过滤|自定义前缀排除|查重缓存策略/ }).count(), 0);
    const exclusion = rules.getByRole("checkbox", { name: "启用自定义前缀排除", exact: true });
    const force = rules.getByRole("checkbox", { name: "忽略本机结果与查重池，强制全部重查", exact: true });
    assert.equal(await exclusion.isVisible(), true);
    assert.equal(await force.isVisible(), true);
    const options = await rules.locator(".register-maintenance-option").evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, width: rect.width };
    }));
    assert.equal(options.length, 2);
    assert(Math.abs(options[0].top - options[1].top) <= 1);
    assert(Math.abs(options[0].width - options[1].width) <= 1);
    await exclusion.check();
    const editor = rules.getByPlaceholder("添加自定义排除前缀（逗号/空格分隔）", { exact: true });
    await editor.fill("excluded");
    await editor.locator("xpath=ancestor::form").getByRole("button", { name: "添加", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("DNSHE_RESERVED_PREFIXES"))), ["excluded"]);
    const reset = rules.getByRole("button", { name: "重置自定义前缀排除为空", exact: true });
    assert.equal((await reset.textContent()).trim(), "");
    await reset.click();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("DNSHE_RESERVED_PREFIXES"))), []);
    await exclusion.uncheck();
    assert.equal(await editor.count(), 0);
  });

  await check("批量查重完成后写入摘要历史", async () => {
    await registerMain.getByRole("button", { name: /规则多域名查重/ }).click();
    const advanced = registerMain.getByRole("region", { name: "规则与过滤", exact: true });
    await advanced.locator('input[placeholder^="例如:"]').waitFor({ state: "visible" });
    const rule = registerMain.getByPlaceholder(/例如: \{字母\}/);
    await rule.fill("batch");
    await registerMain.getByRole("checkbox", { name: ".us.ci", exact: true }).check();
    await registerMain.getByRole("button", { name: "开始查询", exact: true }).click();
    await page.waitForTimeout(1500);
    await registerMain.getByText("批量完成", { exact: true }).waitFor();
    assert((await registerMain.getByText(/1 已查/).count()) >= 1);
  });

  await check("字符组合融入高级规则，自定义长度字符集和起点但不自动查询", async () => {
    const requestsBefore = report.requests.filter(request => request.path === "/api/whois").length;
    const controls = registerMain.getByRole("region", { name: "字符组合规则", exact: true });
    assert.equal(await registerMain.getByRole("region", { name: "短域名发现", exact: true }).count(), 0);
    assert.equal(await controls.locator("xpath=ancestor::div[contains(@class,'register-rules')]").count(), 1);
    await controls.getByRole("checkbox", { name: /按字符组合顺序查询/ }).check();
    await controls.getByLabel("组合字符集", { exact: true }).selectOption("字母数字");
    await controls.getByLabel("组合长度", { exact: true }).fill("2");
    assert.match(await controls.textContent(), /1,296/);
    await controls.getByLabel("组合长度", { exact: true }).fill("5");
    assert.match(await controls.textContent(), /60,466,176/);
    await controls.getByLabel("组合字符集", { exact: true }).selectOption("custom");
    await controls.getByLabel("自定义组合字符", { exact: true }).fill("AaBB119!");
    assert.equal(await controls.getByLabel("自定义组合字符", { exact: true }).inputValue(), "ab19");
    await controls.getByLabel("组合长度", { exact: true }).fill("2");
    await controls.getByLabel("组合起始串", { exact: true }).fill("b1");
    assert.match(await controls.textContent(), /剩余\s*10\s*个前缀/);
    await controls.getByLabel("组合起始串", { exact: true }).fill("zz");
    await controls.getByRole("alert").getByText(/起始串长度和字符/).waitFor();
    assert.equal(report.requests.filter(request => request.path === "/api/whois").length, requestsBefore);
    await controls.getByLabel("组合起始串", { exact: true }).fill("");
    await controls.getByRole("checkbox", { name: /按字符组合顺序查询/ }).uncheck();
  });

  await check("高级规则支持正则过滤并拒绝无效表达式", async () => {
    const rule = registerMain.getByPlaceholder(/例如: \{字母\}/);
    const regex = registerMain.getByLabel(/正则表达式过滤/);
    await rule.fill("{数字}{数字}");
    await regex.fill("^0");
    assert.equal(await registerMain.locator("[data-batch-preview]").getAttribute("data-batch-preview"), "10");
    await regex.fill("[");
    await registerMain.getByRole("alert").getByText(/表达式无效/).waitFor();
    await regex.fill("");
  });

  await check("刷新恢复每个域名的真实结果和查询时间，恢复本身不查询", async () => {
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("DNSHE_DOMAIN_CHECK_CACHE_V1") || "null")?.records?.length >= 2);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("DNSHE_DOMAIN_CHECK_CACHE_V1")));
    assert(saved.records.some(record => record.domain === "demo-check.us.ci" && record.outcome === "available" && Number.isFinite(Date.parse(record.checkedAt))));
    assert(saved.records.some(record => record.domain === "batch.us.ci" && record.outcome === "available"));
    const requestsBefore = report.requests.filter(request => request.path === "/api/whois").length;
    await page.reload({ waitUntil: "networkidle" });
    await registerMain.waitFor();
    const results = registerMain.getByRole("region", { name: "已查询结果", exact: true });
    await results.getByRole("button", { name: /demo-check.us.ci，可注册，回填查询/ }).waitFor();
    assert.equal(await results.count(), 1);
    assert.equal(await results.evaluate(element => !!(element.compareDocumentPosition(element.parentElement.querySelector('.register-history-panel')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    await results.getByLabel("查询结果状态", { exact: true }).selectOption("registered");
    await registerMain.getByRole("button", { name: /规则多域名查重/ }).click();
    assert.equal(await results.getByLabel("查询结果状态", { exact: true }).inputValue(), "registered");
    assert.equal(await results.count(), 1);
    await results.getByLabel("查询结果状态", { exact: true }).selectOption("all");
    assert.equal(report.requests.filter(request => request.path === "/api/whois").length, requestsBefore);
  });

  await check("历史行可恢复批量规则", async () => {
    await registerMain.getByRole("button", { name: /批量完成/ }).click();
    assert.equal(await registerMain.getByPlaceholder(/例如: \{字母\}/).inputValue(), "batch");
  });

  await check("新一轮复用24小时已确认结果，强制重查可绕过缓存", async () => {
    let historyCount = await page.evaluate(() => JSON.parse(localStorage.getItem("DNSHE_REGISTER_HISTORY")).length);
    const callsBefore = report.requests.filter(request => request.path === "/api/whois").length;
    await registerMain.getByRole("button", { name: "开始查询", exact: true }).click();
    await page.waitForFunction(previous => JSON.parse(localStorage.getItem("DNSHE_REGISTER_HISTORY")).length > previous, historyCount);
    assert.equal(report.requests.filter(request => request.path === "/api/whois").length, callsBefore);
    await registerMain.getByRole("button", { name: "重新开始", exact: true }).click();
    await registerMain.getByRole("checkbox", { name: /忽略本机结果与查重池/ }).check();
    historyCount = await page.evaluate(() => JSON.parse(localStorage.getItem("DNSHE_REGISTER_HISTORY")).length);
    await registerMain.getByRole("button", { name: "开始查询", exact: true }).click();
    await page.waitForFunction(previous => JSON.parse(localStorage.getItem("DNSHE_REGISTER_HISTORY")).length > previous, historyCount);
    assert.equal(report.requests.filter(request => request.path === "/api/whois").length, callsBefore + 1);
  });

  await check("官方保留以真实status为依据，ai不再被默认拦截或显示注册按钮", async () => {
    whoisResponseMode = "reserved";
    await registerMain.getByRole("button", { name: /精确单域名查重/ }).click();
    await registerMain.locator("input").first().fill("ai");
    await registerMain.getByRole("button", { name: "WHOIS 查重", exact: true }).click();
    await registerMain.getByRole("status").getByText("官方保留 · reserved", { exact: true }).waitFor();
    assert.equal(await registerMain.getByRole("button", { name: "一键注册该域名", exact: true }).count(), 0);
    const row = await page.evaluate(() => JSON.parse(localStorage.getItem("DNSHE_DOMAIN_CHECK_CACHE_V1")).records.find(record => record.domain === "ai.us.ci"));
    // Wait for the coalesced write when the last network response was faster than 400ms.
    if (!row) await page.waitForFunction(() => JSON.parse(localStorage.getItem("DNSHE_DOMAIN_CHECK_CACHE_V1")).records.some(record => record.domain === "ai.us.ci"));
  });

  await check("上游失败不推断官方政策并保留前次确认", async () => {
    whoisResponseMode = "error";
    await registerMain.getByRole("button", { name: "WHOIS 查重", exact: true }).click();
    await registerMain.getByRole("status").getByText("查询失败", { exact: true }).waitFor();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("DNSHE_DOMAIN_CHECK_CACHE_V1")).records.find(record => record.domain === "ai.us.ci")?.outcome === "error");
    const row = await page.evaluate(() => JSON.parse(localStorage.getItem("DNSHE_DOMAIN_CHECK_CACHE_V1")).records.find(record => record.domain === "ai.us.ci"));
    assert.equal(row.lastConfirmed.outcome, "reserved");
    assert.equal(await registerMain.getByRole("button", { name: "一键注册该域名", exact: true }).count(), 0);
    whoisResponseMode = "available";
  });

  await check("不带完整配置的旧批量历史仍可恢复常驻规则且不自动查询", async () => {
    await page.evaluate(() => {
      const entries = JSON.parse(localStorage.getItem("DNSHE_REGISTER_HISTORY") || "[]");
      entries.unshift({ id: "legacy-batch-without-config", kind: "batch", domain: "legacy.us.ci", subdomain: "legacy", rootdomain: "us.ci", rule: "legacy", summary: "旧批量记录", checkedAt: new Date().toISOString(), registered: false, status: "可注册", checkedCount: 1, availableCount: 1 });
      localStorage.setItem("DNSHE_REGISTER_HISTORY", JSON.stringify(entries));
    });
    const before = report.requests.filter(request => request.path === "/api/whois").length;
    await page.reload({ waitUntil: "networkidle" });
    await registerMain.getByRole("region", { name: "查询历史", exact: true }).getByRole("button", { name: /旧批量记录/ }).click();
    assert.equal(await registerMain.getByRole("region", { name: "规则与过滤", exact: true }).getByPlaceholder(/例如: \{字母\}/).inputValue(), "legacy");
    assert.equal(report.requests.filter(request => request.path === "/api/whois").length, before);
  });

  await check("DDNS 空绑定显示明确的模拟运行面", async () => {
    await page.goto(new URL("/#ddns", base).href, { waitUntil: "networkidle" });
    const ddnsMain = page.locator('main[data-workspace="ddns"]');
    await ddnsMain.getByText("模拟数据 · 不会写入 DNS", { exact: true }).waitFor();
    assert((await ddnsMain.getByText(/第 2 次重试/).count()) >= 1);
    assert((await ddnsMain.getByText(/最近事件/).count()) >= 1);
    await page.getByRole("group", { name: "界面画风", exact: true }).getByRole("button", { name: "卡片风", exact: true }).click();
    await ddnsMain.locator('[data-ddns-view="cards"]').waitFor();
    assert.equal(await ddnsMain.locator(".ddns-binding-card").count(), 2);
    assert.equal(await ddnsMain.locator(".ddns-actions").count(), 0);
    assert((await ddnsMain.getByText("仅演示 · 无真实令牌", { exact: true }).count()) === 2);
  });
} finally {
  report.passed = report.tests.length === 19 && report.tests.every((test) => test.passed) && report.pageErrors.length === 0;
  await browser.close();
  if (devServer?.pid && process.platform === "win32") {
    // 同步等待进程树退出，避免测试结束后留下占用 3016 的 Vite 子进程。
    spawnSync("taskkill", ["/PID", String(devServer.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    devServer?.kill("SIGTERM");
  }
  console.log(JSON.stringify({ passed: report.passed, tests: report.tests.length, requests: report.requests.length, pageErrors: report.pageErrors }));
  if (!report.passed) process.exitCode = 1;
}
