/** 显式运行的实网只读诊断：随机无效凭据，不绑定账号、不注册、不读取真实凭据。 */
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--live-readonly')) {
  console.error('仅在需要实网验证时运行：node scripts/diagnose-dnshe-invalid-key.mjs --live-readonly');
  process.exit(1);
}
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/dnshe.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', target: 'node22', format: 'esm',
});
const { DNSHEClient } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const client = new DNSHEClient(`invalid-diagnostic-${randomBytes(16).toString('hex')}`, randomBytes(32).toString('hex'));
const results = [];
for (const [endpoint, action] of [['quota', () => client.getQuota(8000)], ['keys/list', () => client.listApiKeys()]]) {
  const started = Date.now();
  try {
    await action();
    results.push({ endpoint, outcome: 'unexpected-success', elapsed_ms: Date.now() - started });
    process.exitCode = 1;
  } catch (error) {
    results.push({ endpoint, outcome: 'rejected', status: error.status, code: error.code, diagnostic: error.diagnostic, elapsed_ms: Date.now() - started });
  }
}
console.log(JSON.stringify({ at: new Date().toISOString(), source: 'local-node-direct', credentials: 'random-invalid-only', requests: 2, results }, null, 2));
