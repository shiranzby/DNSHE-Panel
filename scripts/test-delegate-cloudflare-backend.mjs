/** 离线委派回归：真实 Worker 路由、内存 SQLite、合成凭据；所有外部请求均由夹具接管。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: { contents: `export {default as worker} from './src/index'; export {CloudflareClient} from './src/cloudflare'; export {createD1FromSqlite} from './server/d1-sqlite'; export {DatabaseManager,encryptText} from './src/db';`, resolveDir: repo },
  bundle: true, write: false, platform: 'node', target: 'node22', format: 'esm', external: ['cloudflare:sockets'],
});
const source = `${bundle.outputFiles[0].text}\n//# sourceURL=synthetic-delegation-regression.bundle.mjs`;
const { worker, CloudflareClient, createD1FromSqlite, DatabaseManager, encryptText } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const originalFetch = globalThis.fetch;
const targetTag = 'a'.repeat(32);
const otherTag = 'b'.repeat(32);
const zoneTag = 'c'.repeat(32);
const domainId = 101;
const domain = 'synthetic-delegate.cc.cd';
const nameservers = ['alice.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = result => json({ success: true, result });
const zone = (account = targetTag, overrides = {}) => ({ id: zoneTag, name: domain, status: 'pending', name_servers: nameservers, ...(account ? { account: { id: account } } : {}), ...overrides });
const results = [];

async function test(name, run) {
  try { await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  finally { globalThis.fetch = originalFetch; }
}

async function fixture(options = {}, run) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(path.join(repo, 'schema.sql'), 'utf8'));
  const DB = createD1FromSqlite(sqlite);
  const env = { DB, AES_KEY: 'synthetic-delegate-aes-only', ADMIN_TOKEN: 'synthetic-delegate-admin-only' };
  const manager = new DatabaseManager(DB, env.AES_KEY);
  await manager.ensureTables();
  const insertAccount = sqlite.prepare('INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(?,?,?,?,?)');
  insertAccount.run(1, 'Synthetic DNSHE', 'synthetic-dnshe-key', await encryptText('synthetic-dnshe-secret', env.AES_KEY), 'dnshe');
  insertAccount.run(7, 'Synthetic CF A', options.marker ?? `cf:${targetTag}`, await encryptText('synthetic-cf-token-a', env.AES_KEY), 'cloudflare');
  if (options.secondAccount) insertAccount.run(8, 'Synthetic CF B', `cf:${otherTag}`, await encryptText('synthetic-cf-token-b', env.AES_KEY), 'cloudflare');
  sqlite.prepare('INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at) VALUES(?,?,?,?,?,?,?)')
    .run(domainId, 1, 'synthetic-delegate', 'cc.cd', domain, 'active', '2099-01-01');
  const calls = [];
  const snapshot = options.undelegateSnapshot ?? [
    { id: 501, type: 'A', name: '@', content: '192.0.2.10', ttl: 300 },
    { id: 502, type: 'TXT', name: 'docs', content: 'preserve-subdomain', ttl: 300 },
    { id: 503, type: 'NS', name: '@', content: 'legacy.ns.invalid', ttl: 300 },
  ];
  const dnsWrites = () => calls.filter(call => call.kind === 'dnshe' && call.method !== 'GET');
  const selectedTag = options.secondAccount ? otherTag : targetTag;
  const initialDomain = { ...sqlite.prepare('SELECT * FROM domains_cache WHERE id=?').get(domainId) };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const kind = url.hostname === 'api.cloudflare.com' ? 'cloudflare' : url.hostname === 'api005.dnshe.com' ? 'dnshe' : 'unexpected';
    const call = { kind, method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: new Headers(init.headers) };
    calls.push(call);
    if (kind === 'dnshe' && call.query.endpoint === 'dns_records') {
      assert.equal(call.headers.get('X-API-Key'), 'synthetic-dnshe-key');
      assert.equal(call.headers.get('X-API-Secret'), 'synthetic-dnshe-secret');
      if (method === 'GET' && call.query.action === 'list') return json(options.snapshotResponse ?? { success: true, records: snapshot });
      if (method === 'POST' && ['delete', 'create'].includes(call.query.action)) {
        if (options.nsDeleteFailure && call.query.action === 'delete') return json({ success: false, message: 'Synthetic NS delete failure' });
        return json({ success: true, record_id: 900 + calls.length });
      }
    }
    if (kind === 'cloudflare' && /^\/client\/v4\/zones\/[^/]+$/.test(url.pathname) && method === 'DELETE') {
      if (options.zoneDeleteFailure) return json({ success: false, errors: [{ code: 1001, message: 'Synthetic zone delete failure' }] }, 403);
      return json({ success: true, result: null });
    }
    if (kind === 'cloudflare' && url.pathname === '/client/v4/zones') {
      assert.equal(call.headers.get('Authorization'), `Bearer synthetic-cf-token-${options.secondAccount ? 'b' : 'a'}`);
      if (method === 'POST') {
        if (options.createFailure) return json({ success: false, errors: [{ code: 1001, message: 'Synthetic create failure' }] }, 403);
        if (options.existing) return json({ success: false, errors: [{ code: 1061, message: 'Zone already exists (1061)' }] }, 400);
        return ok(zone(selectedTag, options.noNameservers ? { name_servers: [] } : {}));
      }
      if (method === 'GET') {
        if (options.listFailure) return json({ success: false, errors: [{ code: 9109, message: 'Synthetic listing denied' }] }, 403);
        return ok(options.zones ?? [zone(selectedTag)]);
      }
    }
    throw new Error(`Unexpected offline request: ${method} ${url.origin}${url.pathname}`);
  };
  async function delegate(body = options.secondAccount ? { cf_account_id: 8 } : { cf_account_id: 7 }) {
    const response = await worker.fetch(new Request(`https://synthetic.invalid/api/domains/${domainId}/delegate-cloudflare`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), env, { waitUntil() {}, passThroughOnException() {} });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    return { status: response.status, data };
  }
  async function undelegate(body = options.secondAccount ? { cf_account_id: 8 } : { cf_account_id: 7 }) {
    const response = await worker.fetch(new Request(`https://synthetic.invalid/api/domains/${domainId}/undelegate-cloudflare`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), env, { waitUntil() {}, passThroughOnException() {} });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    return { status: response.status, data };
  }
  try { await run({ sqlite, calls, dnsWrites, delegate, undelegate, initialDomain, snapshot }); }
  finally { globalThis.fetch = originalFetch; sqlite.close(); }
}

await test('Cloudflare client rejects numeric and malformed account identifiers before fetch', async () => {
  for (const invalid of [7, '7', '', null, undefined, `cf:${targetTag}`, 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return ok(zone()); };
    await assert.rejects(() => new CloudflareClient('synthetic-only').createZone(domain, invalid));
    assert.equal(calls, 0, `invalid identifier ${String(invalid)} must not leave the process`);
  }
});

await test('Cloudflare client passes the actual trimmed 32-hex account tag and full setup', async () => {
  let body;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return ok(zone()); };
  const created = await new CloudflareClient('synthetic-only').createZone(domain, ` ${targetTag} `);
  assert.deepEqual(body, { name: domain, account: { id: targetTag }, type: 'full' });
  assert.equal(created.id, zoneTag);
});

await test('new delegation sends real account tag, snapshots first, then removes apex conflict and writes both NS', () => fixture({}, async ({ calls, dnsWrites, delegate, snapshot }) => {
  const result = await delegate();
  assert.equal(result.status, 200);
  assert.equal(result.data.success, true);
  assert.equal(result.data.cf_account_id, 7, 'response keeps the local account selector contract');
  assert.equal(result.data.zone_id, zoneTag);
  assert.equal(result.data.zone_reused, false);
  const createIndex = calls.findIndex(call => call.kind === 'cloudflare' && call.method === 'POST');
  assert.equal(calls[createIndex].body.account.id, targetTag);
  assert.equal(calls[0].query.action, 'list', 'read-only snapshot precedes zone creation');
  assert(createIndex < calls.findIndex(call => call.kind === 'dnshe' && call.method === 'POST'));
  assert.deepEqual(dnsWrites().map(call => call.query.action), ['delete', 'create', 'create']);
  assert.equal(dnsWrites()[0].body.record_id, '501', 'non-apex TXT and old NS must not be removed');
  assert.deepEqual(dnsWrites().slice(1).map(call => call.body), nameservers.map(content => ({ subdomain_id: domainId, type: 'NS', name: '@', content, ttl: 86400 })));
  assert.deepEqual(result.data.records, snapshot.filter(row => row.type !== 'NS'));
  assert(!calls.some(call => call.pathname.endsWith('/accounts')), 'no account enumeration permission is required');
}));

await test('explicit selection chooses second Cloudflare account rather than local numeric ID or first account', () => fixture({ secondAccount: true }, async ({ calls, delegate }) => {
  const result = await delegate();
  assert.equal(result.status, 200);
  assert.equal(result.data.cf_account_id, 8);
  assert.equal(calls.find(call => call.kind === 'cloudflare' && call.method === 'POST').body.account.id, otherTag);
}));

await test('single Cloudflare account auto-select still resolves real account tag', () => fixture({}, async ({ calls, delegate }) => {
  assert.equal((await delegate({})).status, 200);
  assert.equal(calls.find(call => call.kind === 'cloudflare' && call.method === 'POST').body.account.id, targetTag);
}));

await test('trimmed uppercase persisted cf marker is accepted without a new account-read request', () => fixture({ marker: `  CF:${targetTag.toUpperCase()}  ` }, async ({ calls, delegate }) => {
  assert.equal((await delegate()).status, 200);
  assert.equal(calls.find(call => call.kind === 'cloudflare' && call.method === 'POST').body.account.id.toLowerCase(), targetTag);
  assert(!calls.some(call => call.pathname.endsWith('/accounts')));
}));

await test('missing, legacy and damaged stored identifiers reject before snapshot or any upstream operation', async () => {
  for (const marker of ['', 'cf:token:synthetic-legacy', 'cf:7', `cf:${'a'.repeat(31)}`, `cf:${'z'.repeat(32)}`, targetTag]) {
    await fixture({ marker }, async ({ sqlite, calls, dnsWrites, delegate, initialDomain }) => {
      const result = await delegate();
      assert.equal(result.status, 400, marker);
      assert.equal(result.data.error_code, 'cf_account_identifier_missing', marker);
      assert.equal(result.data.success, false);
      assert.equal(calls.length, 0, 'no numeric fallback, snapshot or account enumeration');
      assert.equal(dnsWrites().length, 0);
      assert.deepEqual({ ...sqlite.prepare('SELECT * FROM domains_cache WHERE id=?').get(domainId) }, initialDomain);
    });
  }
});

await test('Cloudflare zone creation failure leaves DNSHE records and local domain unchanged', () => fixture({ createFailure: true }, async ({ sqlite, calls, dnsWrites, delegate, initialDomain }) => {
  const result = await delegate();
  assert.equal(result.status, 400);
  assert.equal(result.data.error_code, 'zone_create_failed');
  assert.equal(dnsWrites().length, 0);
  assert.equal(calls.filter(call => call.kind === 'cloudflare').length, 1);
  assert.deepEqual({ ...sqlite.prepare('SELECT * FROM domains_cache WHERE id=?').get(domainId) }, initialDomain);
}));

for (const snapshotResponse of [{ success: false, message: 'Synthetic snapshot failure' }, { success: true, records: null }]) {
  await test(`unconfirmed source snapshot (${JSON.stringify(snapshotResponse)}) refuses all Cloudflare and DNSHE writes`, () => fixture({ snapshotResponse }, async ({ sqlite, calls, dnsWrites, delegate, initialDomain }) => {
    const result = await delegate();
    assert.equal(result.status, 400);
    assert.equal(result.data.error_code, 'snapshot_failed');
    assert.equal(calls.filter(call => call.kind === 'cloudflare').length, 0);
    assert.equal(dnsWrites().length, 0);
    assert.deepEqual({ ...sqlite.prepare('SELECT * FROM domains_cache WHERE id=?').get(domainId) }, initialDomain);
  }));
}

await test('existing zone reuse scopes lookup by real account tag and rejects earlier same-name foreign zone', () => fixture({ existing: true, zones: [zone(otherTag, { id: 'd'.repeat(32) }), zone()] }, async ({ calls, dnsWrites, delegate }) => {
  const result = await delegate();
  assert.equal(result.status, 200);
  assert.equal(result.data.zone_reused, true);
  assert.equal(result.data.zone_id, zoneTag);
  const lookup = calls.find(call => call.kind === 'cloudflare' && call.method === 'GET');
  assert.equal(lookup.query['account.id'], targetTag);
  assert.equal(dnsWrites().length, 3);
}));

await test('same-name zone in a different account is never reused and causes zero DNSHE writes', () => fixture({ existing: true, zones: [zone(otherTag)] }, async ({ delegate, dnsWrites }) => {
  const result = await delegate();
  assert.equal(result.status, 400);
  assert.equal(result.data.error_code, 'zone_create_failed');
  assert.equal(dnsWrites().length, 0);
}));

await test('existing zone with unknown account ownership is not assumed safe', () => fixture({ existing: true, zones: [zone(null)] }, async ({ delegate, dnsWrites }) => {
  const result = await delegate();
  assert.equal(result.status, 400);
  assert.equal(result.data.error_code, 'zone_create_failed');
  assert.equal(dnsWrites().length, 0);
}));

await test('multiple same-account matching zones are rejected instead of choosing an arbitrary result', () => fixture({ existing: true, zones: [zone(), zone(targetTag, { id: 'd'.repeat(32) })] }, async ({ delegate, dnsWrites }) => {
  const result = await delegate();
  assert.equal(result.status, 400);
  assert.equal(result.data.error_code, 'zone_create_failed');
  assert.equal(dnsWrites().length, 0);
}));

await test('existing-zone lookup failure is a controlled error with no DNSHE writes', () => fixture({ existing: true, listFailure: true }, async ({ delegate, dnsWrites }) => {
  const result = await delegate();
  assert.equal(result.status, 400);
  assert.equal(result.data.error_code, 'zone_create_failed');
  assert.equal(dnsWrites().length, 0);
}));

await test('Cloudflare missing nameservers stops before deleting any source record', () => fixture({ noNameservers: true }, async ({ delegate, dnsWrites }) => {
  const result = await delegate();
  assert.equal(result.status, 400);
  assert.equal(result.data.error_code, 'no_name_servers');
  assert.equal(dnsWrites().length, 0);
}));

await test('undelegate restores DNSHE default state before deleting the exact same-account zone', () => fixture({
  undelegateSnapshot: [
    { id: 601, type: 'NS', name: '@', content: 'alice.ns.cloudflare.com', ttl: 86400 },
    { id: 602, type: 'NS', name: '@', content: 'bob.ns.cloudflare.com', ttl: 86400 },
  ],
}, async ({ calls, dnsWrites, undelegate }) => {
  const result = await undelegate();
  assert.equal(result.status, 200);
  assert.equal(result.data.success, true);
  assert.equal(result.data.zone_deleted, true);
  assert.deepEqual(result.data.default_nameservers, ['ns1.dnshe.com', 'ns2.dnshe.com']);
  const sourceWrites = dnsWrites();
  assert.deepEqual(sourceWrites.map((call) => call.query.action), ['delete', 'delete']);
  const deleteIndex = calls.findIndex((call) => call.kind === 'cloudflare' && call.method === 'DELETE');
  const lastSourceDelete = Math.max(...calls.map((call, index) => call.kind === 'dnshe' && call.query.action === 'delete' ? index : -1));
  assert(deleteIndex > lastSourceDelete, 'zone deletion must happen after DNSHE NS restoration');
}));

await test('undelegate never deletes the zone when restoring DNSHE NS fails', () => fixture({
  undelegateSnapshot: [
    { id: 601, type: 'NS', name: '@', content: 'alice.ns.cloudflare.com', ttl: 86400 },
    { id: 602, type: 'NS', name: '@', content: 'bob.ns.cloudflare.com', ttl: 86400 },
  ],
  nsDeleteFailure: true,
}, async ({ calls, undelegate }) => {
  const result = await undelegate();
  assert.equal(result.status, 400);
  assert.equal(result.data.error_code, 'ns_restore_failed');
  assert.equal(calls.filter((call) => call.kind === 'cloudflare' && call.method === 'DELETE').length, 0);
}));

await test('undelegate rejects a foreign same-name zone without touching DNSHE NS', () => fixture({
  undelegateSnapshot: [
    { id: 601, type: 'NS', name: '@', content: 'alice.ns.cloudflare.com', ttl: 86400 },
    { id: 602, type: 'NS', name: '@', content: 'bob.ns.cloudflare.com', ttl: 86400 },
  ],
  existing: true,
  zones: [zone(otherTag)],
}, async ({ calls, dnsWrites, undelegate }) => {
  const result = await undelegate();
  assert.equal(result.status, 200, 'a zone absent from the selected account is treated as an idempotent restore');
  assert.equal(result.data.zone_deleted, false);
  assert.equal(dnsWrites().length, 2);
  assert.equal(calls.filter((call) => call.kind === 'cloudflare' && call.method === 'DELETE').length, 0);
}));

const failed = results.filter(result => !result.passed);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, total: results.length, network: 'mock-only', storage: 'in-memory SQLite', failures: failed }, null, 2));
if (failed.length) process.exitCode = 1;
