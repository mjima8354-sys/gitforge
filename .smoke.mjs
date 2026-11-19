// Smoke test the gitforge: start app, git clone -> push -> clone roundtrip + REST sanity.
import { createApp } from '/root/makefun/build/github-core-clone-01/app.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const server = createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const h = await (await fetch(base + '/healthz')).json();
console.log('healthz', JSON.stringify(h));
const rootResp = await fetch(base + '/api/v3');
console.log('api root', rootResp.status, rootResp.headers.get('x-oauth-scopes'));

// create repo via REST
const cr = await fetch(base + '/api/v3/user/repos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'demo' }) });
console.log('create repo', cr.status);

const dir = mkdtempSync(join(tmpdir(), 'forge-'));
const run = (cmd, opts = {}) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (opts.q) return r;
  console.log('$', cmd, '->', r.status);
  if (r.stderr.trim()) console.log(r.stderr.trim().split('\n').slice(-3).join('\n'));
  return r;
};
run(`timeout 30 git clone ${base}/demo/demo.git seed`);
let r = run('cd seed && git config user.email t@t && git config user.name t && echo hello > a.txt && git add a.txt && git commit -qm init && git push origin HEAD:refs/heads/main', { q: true });
console.log('push status', r.status, r.stderr.trim().split('\n').slice(-2).join(' | '));
r = run(`timeout 30 git clone ${base}/demo/demo.git seed2`, { q: true });
console.log('clone2 status', r.status);
const head1 = run('cd seed && git rev-parse HEAD', { q: true }).stdout.trim();
const head2 = run('cd seed2 && git rev-parse HEAD', { q: true }).stdout.trim();
console.log('head1', head1, 'head2', head2, 'MATCH', head1 === head2 && head1.length === 40);
rmSync(dir, { recursive: true, force: true });
server.close();
process.exit(0);
