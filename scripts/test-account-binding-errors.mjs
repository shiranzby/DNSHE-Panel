/** 绑定错误与注册诊断：真实路由、内存 SQLite、合成上游响应，不使用真人凭据或网络。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: { contents: `export {default as worker} from './src/index'; export {DNSHEClient} from './src/dnshe'; export {createD1FromSqlite} from './server/d1-sqlite'; export {DatabaseManager,encryptText,decryptText} from './src/db';`, resolveDir: repo },
  bundle: true, write: false, platform: 'node', target: 'node22', format: 'esm', external: ['cloudflare:sockets'],
});
const source = `${bundle.outputFiles[0].text}\n//# sourceURL=synthetic-account-binding.bundle.mjs`;
const { worker, DNSHEClient, createD1FromSqlite, DatabaseManager, encryptText, decryptText } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const originalFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const credentials = { api_key: 'synthetic-binding-key', api_secret: 'synthetic-binding-secret' };
const ray = 'abc123def4567890-SIN';
const edgeError = () => new Response('<html>synthetic upstream edge error; never return this page</html>', { status: 520, headers: { 'Content-Type': 'text/html', 'CF-Ray': ray } });
let passed = 0;
let failed = 0;

async function fixture(upstream, run, { existing = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(path.join(repo, 'schema.sql'), 'utf8'));
  const DB = createD1FromSqlite(sqlite);
  const env = { DB, AES_KEY: 'synthetic-binding-aes-only', ADMIN_TOKEN: 'synthetic-binding-admin-only' };
  const manager = new DatabaseManager(DB, env.AES_KEY);
  await manager.ensureTables();
  if (existing) sqlite.prepare('INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,?,?,?,?)')
    .run('Original alias', 'old-synthetic-key', await encryptText('old-synthetic-secret', env.AES_KEY), 'dnshe');
  const calls = [];
  const tasks = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api005.dnshe.com', 'all outbounds must be synthetic DNSHE requests');
    const call = { endpoint: url.searchParams.get('endpoint'), action: url.searchParams.get('action'), method: init.method, body: init.body ? JSON.parse(init.body) : undefined, headers: new Headers(init.headers), signal: init.signal };
    calls.push(call);
    return upstream(call);
  };
  async function request(body, route = '/api/accounts', method = 'POST') {
    const response = await worker.fetch(new Request(`https://synthetic.invalid${route}`, {
      method, headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), env, { waitUntil(task) { tasks.push(task); }, passThroughOnException() {} });
    return { status: response.status, body: await response.json() };
  }
  try { await run({ request, calls, tasks, sqlite, env }); }
  finally { await Promise.allSettled(tasks); globalThis.fetch = originalFetch; sqlite.close(); }
}

async function test(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
function noBinding(sqlite, tasks) {
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM logs WHERE type='success'").get().n, 0);
  assert.equal(tasks.length, 0, 'failure must not schedule domain synchronization');
}

for (const alias of ['', 'Synthetic alias']) {
  await test(`HTTP 520 (${alias ? 'quota' : 'keys/list'}) is an upstream failure, not a credential error`, () => fixture(edgeError, async ({ request, calls, tasks, sqlite }) => {
    const result = await request({ ...credentials, alias });
    assert.equal(result.status, 502);
    assert.equal(result.body.error_code, 'dnshe_upstream_error');
    assert.match(result.body.message, /HTTP 520/);
    assert.match(result.body.message, /不能据此判断密钥无效/);
    assert(result.body.message.includes(ray));
    assert(!result.body.message.includes('<html>'));
    assert(!JSON.stringify(result).includes(credentials.api_secret));
    assert.equal(calls.length, 1, 'do not blindly retry upstream failures');
    assert.equal(calls[0].endpoint, alias ? 'quota' : 'keys');
    assert(calls[0].signal, 'binding verification must have a timeout');
    noBinding(sqlite, tasks);
  }));
}

await test('batch preserves a per-account 520 diagnosis and never reports a successful bind', () => fixture(edgeError, async ({ request, sqlite, tasks }) => {
  const result = await request({ accounts: [credentials] }, '/api/accounts/batch');
  assert.equal(result.body.success_count, 0);
  assert.equal(result.body.fail_count, 1);
  assert.match(result.body.results[0].message, /不能据此判断密钥无效/);
  noBinding(sqlite, tasks);
}));

await test('credential rotation on 520 preserves the old credential and alias', () => fixture(edgeError, async ({ request, calls, sqlite, tasks }) => {
  const before = { ...sqlite.prepare('SELECT * FROM accounts WHERE id=1').get() };
  const result = await request({ ...credentials, alias: 'Changed alias' }, '/api/accounts/1', 'PUT');
  assert.equal(result.status, 502);
  assert.equal(result.body.error_code, 'dnshe_upstream_error');
  assert.deepEqual({ ...sqlite.prepare('SELECT * FROM accounts WHERE id=1').get() }, before);
  assert.equal(tasks.length, 0);
  assert(calls[0].signal);
}, { existing: true }));

await test('network failure has a distinct actionable code and no saved account', () => fixture(() => { throw new TypeError('fetch failed'); }, async ({ request, sqlite, tasks }) => {
  const result = await request(credentials);
  assert.equal(result.status, 502);
  assert.equal(result.body.error_code, 'dnshe_network_error');
  noBinding(sqlite, tasks);
}));

await test('timeout has a distinct code rather than a credential rejection', () => fixture(call => {
  assert(call.signal);
  throw new DOMException('Synthetic aborted request', 'AbortError');
}, async ({ request, sqlite, tasks }) => {
  const result = await request(credentials);
  assert.equal(result.status, 504);
  assert.equal(result.body.error_code, 'dnshe_timeout');
  noBinding(sqlite, tasks);
}));

await test('the real deadline aborts a fetch waiting for headers', () => fixture(call => new Promise((_resolve, reject) => {
  call.signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
}), async () => {
  await assert.rejects(() => new DNSHEClient(credentials.api_key, credentials.api_secret).getQuota(20), error => error.code === 'dnshe_timeout');
}));

await test('the real deadline aborts a hanging JSON body after headers arrive', () => fixture(call => new Response(new ReadableStream({
  start(controller) {
    call.signal.addEventListener('abort', () => controller.error(new DOMException('Body timed out', 'AbortError')), { once: true });
  },
})), async () => {
  await assert.rejects(() => new DNSHEClient(credentials.api_key, credentials.api_secret).getQuota(20), error => error.code === 'dnshe_timeout');
}));

await test('520 is classified from headers without waiting for an error page body', async () => {
  let cancelled = false;
  await fixture(call => new Response(new ReadableStream({
    start(controller) {
      call.signal.addEventListener('abort', () => controller.error(new DOMException('Error page timed out', 'AbortError')), { once: true });
    },
    cancel() { cancelled = true; },
  }), { status: 520, headers: { 'CF-Ray': ray } }), async () => {
    await assert.rejects(() => new DNSHEClient(credentials.api_key, credentials.api_secret).getQuota(20), error => error.code === 'dnshe_upstream_error' && error.status === 520);
    assert.equal(cancelled, true, 'discard the upstream error page body');
  });
});

for (const [status, code, message] of [[403, 'auth_ip_not_allowed', 'IP not allowed'], [401, 'auth_invalid_credentials', 'Invalid API key']]) {
  await test(`HTTP ${status} preserves ${code} and is not reclassified as 520`, () => fixture(() => json({ success: false, error_code: code, message }, status), async ({ request, sqlite, tasks }) => {
    const result = await request(credentials);
    assert.equal(result.status, 400, 'upstream 401 must not invalidate the panel session');
    assert.equal(result.body.error_code, code);
    assert(!result.body.message.includes('HTTP 520'));
    noBinding(sqlite, tasks);
  }));
}

await test('HTTP 200 HTML cannot pass quota verification and create an account', () => fixture(() => new Response('<html>not an API response</html>'), async ({ request, sqlite, tasks }) => {
  const result = await request({ ...credentials, alias: 'Synthetic alias' });
  assert.equal(result.status, 502);
  assert.equal(result.body.error_code, 'dnshe_invalid_response');
  noBinding(sqlite, tasks);
}));

await test('HTTP 200 success:false is a failed verification, not an account binding', () => fixture(() => json({ success: false, error_code: 'api_access_disabled', message: 'API disabled' }), async ({ request, sqlite, tasks }) => {
  const result = await request({ ...credentials, alias: 'Synthetic alias' });
  assert.equal(result.status, 400);
  assert.equal(result.body.error_code, 'api_access_disabled');
  noBinding(sqlite, tasks);
}));

for (const alias of ['', 'Synthetic alias']) {
  await test(`healthy ${alias ? 'quota' : 'keys/list'} still binds and encrypts the credential`, () => fixture(call => {
    if (call.endpoint === 'subdomains') return json({ success: true, subdomains: [] });
    return call.endpoint === 'keys' ? json({ success: true, keys: [{ ...credentials, id: 9, key_name: 'Resolved name' }] }) : json({ success: true, quota: { used: 0, total: 5, available: 5 } });
  }, async ({ request, sqlite, env, calls }) => {
    const result = await request({ ...credentials, alias });
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    const saved = sqlite.prepare('SELECT * FROM accounts').get();
    assert.equal(saved.alias, alias || 'Resolved name');
    assert.notEqual(saved.api_secret, credentials.api_secret);
    assert.equal(await decryptText(saved.api_secret, env.AES_KEY), credentials.api_secret);
    assert.equal(calls[0].headers.get('X-API-Key'), credentials.api_key);
    assert.equal(calls[0].headers.get('X-API-Secret'), credentials.api_secret);
  }));
}

const registration = { account_id: 1, subdomain: 'synthetic-register-test', rootdomain: 'l.cd' };
const registrationDomain = `${registration.subdomain}.${registration.rootdomain}`;
for (const scenario of [
  { name: 'API IP allowlist', code: 'auth_ip_not_allowed', message: 'IP not allowed' },
  { name: 'API disabled', code: 'api_access_disabled', message: 'API access disabled' },
  { name: 'unknown policy is not an unknown endpoint', code: 'registration_denied', message: 'Unknown policy; not found in allowed roots' },
]) {
  await test(`registration 403: ${scenario.name}; no write retry and safe diagnostics logged`, () => fixture(() => json({ success: false, error_code: scenario.code, message: scenario.message }, 403), async ({ request, calls, sqlite, tasks }) => {
    const result = await request(registration, '/api/domains/register');
    assert.equal(result.status, 400, 'do not invalidate the panel session for an upstream denial');
    assert.equal(result.body.error_code, scenario.code);
    assert.deepEqual(result.body.upstream, { status: 403, endpoint: 'subdomains', action: 'create', response_type: 'json' });
    assert.equal(calls.length, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM domains_cache').get().n, 0);
    assert.equal(tasks.length, 0);
    const log = sqlite.prepare("SELECT type,details FROM logs WHERE category='api'").get();
    assert.equal(log.type, 'warning');
    assert.equal(JSON.parse(log.details).upstream.status, 403);
  }, { existing: true }));
}

await test('registration non-JSON 403 preserves Ray ID without reflecting HTML or assuming a policy', () => fixture(() => new Response('<html>sensitive upstream body</html>', { status: 403, headers: { 'CF-Ray': ray } }), async ({ request, calls, sqlite }) => {
  const result = await request(registration, '/api/domains/register');
  assert.equal(result.body.error_code, 'dnshe_upstream_forbidden');
  assert.equal(result.body.upstream.ray_id, ray);
  assert.equal(result.body.upstream.response_type, 'non-json');
  assert.match(result.body.message, /拒绝原因尚未确认/);
  assert.equal(calls.length, 1);
  assert(!JSON.stringify(result).includes('sensitive upstream body'));
  assert(!sqlite.prepare('SELECT details FROM logs').get().details.includes('sensitive upstream body'));
}, { existing: true }));

await test('registration diagnostics redact credentials echoed in an upstream message', () => fixture(() => json({ success: false, error_code: 'registration_denied', message: 'Rejected old-synthetic-key and old-synthetic-secret' }, 403), async ({ request, sqlite }) => {
  const result = await request(registration, '/api/domains/register');
  const combined = JSON.stringify(result) + JSON.stringify(sqlite.prepare('SELECT * FROM logs').all());
  assert(!combined.includes('old-synthetic-key'));
  assert(!combined.includes('old-synthetic-secret'));
}, { existing: true }));

await test('registration 429 preserves quota semantics, does not retry or call it a gateway denial', () => fixture(() => json({ success: false, error_code: 'quota_exceeded', message: 'Quota exceeded' }, 429), async ({ request, calls }) => {
  const result = await request(registration, '/api/domains/register');
  assert.equal(result.body.error_code, 'quota_exceeded');
  assert.equal(result.body.upstream.status, 429);
  assert.equal(calls.length, 1);
}, { existing: true }));

for (const legacy of [false, true]) {
  await test(`registration success and ${legacy ? 'explicit 404 fallback' : 'primary request'} remain unchanged`, () => fixture(call => {
    if (call.endpoint === 'subdomains' && call.method === 'POST') {
      if (legacy && call.action === 'create') return json({ success: false, message: 'Unknown endpoint' }, 404);
      return json({ success: true, subdomain_id: 301, full_domain: registrationDomain });
    }
    if (call.endpoint === 'quota') return json({ success: true, quota: { used: 1, base: 8, total: 8, available: 7 } });
    if (call.endpoint === 'subdomains') return json({ success: true, subdomains: [{ id: 301, subdomain: registration.subdomain, rootdomain: registration.rootdomain, full_domain: registrationDomain, status: 'active', expires_at: '2099-01-01' }], count: 1 });
    if (call.endpoint === 'dns_records') return json({ success: true, records: [] });
    throw new Error('Unexpected synthetic request');
  }, async ({ request, calls, sqlite }) => {
    const result = await request(registration, '/api/domains/register');
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.cache_sync, 'synced');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM domains_cache').get().n, 1);
    const writes = calls.filter(call => call.method === 'POST');
    assert.equal(writes.length, legacy ? 2 : 1);
    assert.deepEqual(writes[0].body, { subdomain: registration.subdomain, domain: registration.rootdomain });
    if (legacy) assert.deepEqual(writes[1].body, { subdomain: registration.subdomain, rootdomain: registration.rootdomain });
  }, { existing: true }));
}

console.log(JSON.stringify({ passed, failed, network: 'mock-only', storage: 'in-memory SQLite' }));
if (failed) process.exitCode = 1;
