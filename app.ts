import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const FIXED_DATE = '2026-01-01T00:00:00Z';
const ZERO_OID = '0'.repeat(40);

// --- In-Memory Forge Store ---
interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  content: Buffer;
  sha: string;
}

interface IssueComment {
  id: number;
  body: string;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  user: { login: string; id: number };
  labels: { id: number; name: string; color: string }[];
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; sha: string; repo: { full_name: string } };
  user: { login: string; id: number };
  merged: boolean;
  mergeable: boolean;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  files?: PullRequestFile[];
}

interface Repository {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; id: number };
  private: boolean;
  default_branch: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  refs: Map<string, string>; // ref name (e.g. 'refs/heads/main') -> sha
  objects: Map<string, GitObject>; // sha -> GitObject
  issues: Issue[];
  issueComments: Map<number, IssueComment[]>;
  labels: { id: number; name: string; color: string }[];
  pulls: PullRequest[];
}

class ForgeStore {
  repos = new Map<string, Repository>(); // "owner/repo" -> Repository
  nextId = 1;

  getRepo(owner: string, repoName: string): Repository | undefined {
    return this.repos.get(`${owner.toLowerCase()}/${repoName.toLowerCase()}`);
  }

  ensureRepo(owner: string, repoName: string): Repository {
    const key = `${owner.toLowerCase()}/${repoName.toLowerCase()}`;
    let repo = this.repos.get(key);
    if (!repo) {
      repo = {
        id: this.nextId++,
        name: repoName,
        full_name: `${owner}/${repoName}`,
        owner: { login: owner, id: 1 },
        private: false,
        default_branch: 'main',
        description: null,
        created_at: FIXED_DATE,
        updated_at: FIXED_DATE,
        refs: new Map(),
        objects: new Map(),
        issues: [],
        issueComments: new Map(),
        labels: [
          { id: 1, name: 'bug', color: 'd73a4a' },
          { id: 2, name: 'enhancement', color: 'a2eeef' }
        ],
        pulls: []
      };
      this.repos.set(key, repo);
    }
    return repo;
  }
}

const store = new ForgeStore();

// --- Git Object & Packfile Helpers ---
function computeSha(type: string, content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\0`);
  const sha = createHash('sha1').update(header).update(content).digest('hex');
  return sha;
}

function storeObject(repo: Repository, type: 'commit' | 'tree' | 'blob' | 'tag', content: Buffer): string {
  const sha = computeSha(type, content);
  repo.objects.set(sha, { type, content, sha });
  return sha;
}

// --- Git Packfile Reader & Writer ---
function readVarint(buf: Buffer, offset: number): { value: number; length: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return { value, length: pos - offset };
}

function parsePackfile(buf: Buffer, repo: Repository): void {
  if (buf.length < 12) return;
  const signature = buf.toString('ascii', 0, 4);
  if (signature !== 'PACK') return;
  const version = buf.readUInt32BE(4);
  const numObjects = buf.readUInt32BE(8);
  let offset = 12;

  const objects: { type: number; sha?: string; data?: Buffer; offset: number; baseOffset?: number; baseSha?: string; rawType: number }[] = [];

  for (let i = 0; i < numObjects && offset < buf.length - 20; i++) {
    const objOffset = offset;
    const b = buf[offset++];
    let type = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (offset >= buf.length) break;
      b = buf[offset++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }

    const rawType = type;
    let baseOffset: number | undefined;
    let baseSha: string | undefined;

    if (type === 6) { // OBJ_OFS_DELTA
      let deltaOffset = 0;
      let shiftOFS = 0;
      while (offset < buf.length) {
        const eb = buf[offset++];
        deltaOffset = (deltaOffset << 7) | (eb & 0x7f);
        if (!(eb & 0x80)) break;
        deltaOffset++;
      }
      baseOffset = objOffset - deltaOffset;
    } else if (type === 7) { // OBJ_REF_DELTA
      if (offset + 20 > buf.length) break;
      baseSha = buf.toString('hex', offset, offset + 20);
      offset += 20;
    }

    // Inflate zlib data
    try {
      const inflated = inflateSync(buf.subarray(offset));
      // determine consumed zlib bytes roughly or via inflateSync length if needed, but inflateSync consumes exactly the zlib stream.
      // Wait, inflateSync consumes the compressed stream. How many bytes were consumed?
      // Node zlib doesn't return consumed bytes easily unless we use zlib.Unzip or inspect.
      // Actually, we can use a zlib stream or trial inflate or inflateSync with chunking.
      // Better: use node:zlib inflateSync on remaining buffer. Since inflateSync stops at end of zlib stream, we can find out where it ended or use a streaming approach.
      // Alternatively, write a small helper using zlib inflate chunk or sync with maxOutputLength.
    } catch {
      break;
    }
    break; // We can implement a robust packfile parser or rely on simple push objects.
  }
}

// Simplified Git Packfile Decoder / Encoder for Push / Clone
function decodePackfileAndStore(packBuf: Buffer, repo: Repository): string[] {
  const updatedShas: string[] = [];
  if (packBuf.length < 12) return updatedShas;
  const numObjects = packBuf.readUInt32BE(8);
  let offset = 12;

  for (let i = 0; i < numObjects && offset < packBuf.length - 20; i++) {
    let b = packBuf[offset++];
    const typeNum = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (offset >= packBuf.length) break;
      b = packBuf[offset++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }

    if (typeNum === 6 || typeNum === 7) {
      if (typeNum === 6) {
        // skip ofs delta offset bytes
        while (offset < packBuf.length) {
          const eb = packBuf[offset++];
          if (!(eb & 0x80)) break;
        }
      } else {
        offset += 20; // skip base sha
      }
    }

    let low = 2;
    let high = packBuf.length - offset - 20;
    if (high < low) high = low;
    let exact = -1;
    let inflated: Buffer = Buffer.alloc(0);

    while (low <= high) {
      const mid = (low + high) >> 1;
      try {
        const res = inflateSync(packBuf.subarray(offset, offset + mid));
        if (res.length === size) {
          exact = mid;
          inflated = res;
          high = mid - 1;
        } else if (res.length > size) {
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      } catch {
        low = mid + 1;
      }
    }

    if (exact !== -1) {
      offset += exact;
      let typeStr: 'commit' | 'tree' | 'blob' | 'tag' = 'blob';
      if (typeNum === 1) typeStr = 'commit';
      else if (typeNum === 2) typeStr = 'tree';
      else if (typeNum === 3) typeStr = 'blob';
      else if (typeNum === 4) typeStr = 'tag';

      const sha = storeObject(repo, typeStr, inflated);
      updatedShas.push(sha);
    } else {
      break;
    }
  }
  return updatedShas;
}

function buildPackfile(objects: GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);

  const bufs: Buffer[] = [header];
  for (const obj of objects) {
    const content = obj.content;
    let typeNum = 3; // blob
    if (obj.type === 'commit') typeNum = 1;
    else if (obj.type === 'tree') typeNum = 2;
    else if (obj.type === 'tag') typeNum = 4;

    let size = content.length;
    const headerByte = ((typeNum & 7) << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [headerByte];
    while (size > 0) {
      headBytes[headBytes.length - 1] |= 0x80;
      headBytes.push(size & 0x7f);
      size >>= 7;
    }
    const compressed = deflateSync(content);
    bufs.push(Buffer.from(headBytes));
    bufs.push(compressed);
  }

  const allWithoutSha = Buffer.concat(bufs);
  const checksum = createHash('sha1').update(allWithoutSha).digest();
  return Buffer.concat([allWithoutSha, checksum]);
}

// --- pkt-line helpers ---
function encodePktLine(str: string | Uint8Array): Buffer {
  const data = typeof str === 'string' ? Buffer.from(str) : Buffer.from(str);
  const len = data.length + 4;
  const lenHex = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(lenHex, 'ascii'), data]);
}

function parsePktLines(buf: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;
    const lenHex = buf.toString('ascii', offset, offset + 4);
    if (lenHex === '0000') {
      packets.push(Buffer.from('0000', 'ascii'));
      offset += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (isNaN(len) || len === 0) break;
    if (offset + len > buf.length) break;
    packets.push(buf.subarray(offset + 4, offset + len));
    offset += len;
  }
  return packets;
}

// --- Response Caching ---
const responseCache = new Map<string, Buffer>();
function clearCache() {
  responseCache.clear();
}

// --- App Factory ---
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // Enable keep-alive and noDelay
    req.socket.setNoDelay(true);

    const parsedUrl = new URL(req.url ?? '/', 'http://entry');
    const path = parsedUrl.pathname;
    const method = req.method ?? 'GET';

    // Health check
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // GitHub API root
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // Git Smart HTTP (/<owner>/<repo>.git/...)
    const gitMatch = path.match(/^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\.git(\/.*)?$/);
    if (gitMatch) {
      const owner = gitMatch[1];
      const repoName = gitMatch[2];
      const gitPath = gitMatch[3] || '/';
      handleGitRequest(req, res, owner, repoName, gitPath, parsedUrl);
      return;
    }

    // REST v3 API (/api/v3/...)
    if (path.startsWith('/api/v3/')) {
      handleRestRequest(req, res, path, method, parsedUrl);
      return;
    }

    // GraphQL API (/api/graphql)
    if (path === '/api/graphql' && method === 'POST') {
      handleGraphQL(req, res);
      return;
    }

    // MCP API (/mcp)
    if (path === '/mcp' && (method === 'POST' || method === 'GET')) {
      handleMCP(req, res);
      return;
    }

    // 404
    sendJson(res, 404, { message: 'Not Found' });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

// --- Git Smart HTTP Handler ---
async function handleGitRequest(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, gitPath: string, parsedUrl: URL) {
  const repo = store.ensureRepo(owner, repoName);

  if (gitPath === '/info/refs') {
    const service = parsedUrl.searchParams.get('service');
    if (service === 'git-upload-pack' || service === 'git-receive-pack') {
      const contentType = `application/x-${service}-advertisement`;
      const isV2 = req.headers['git-protocol'] === 'version=2';

      const bufs: Buffer[] = [];
      bufs.push(encodePktLine(`# service=${service}\n`));
      bufs.push(Buffer.from('0000', 'ascii'));

      if (service === 'git-upload-pack') {
        if (isV2) {
          bufs.push(encodePktLine('version 2\n'));
          bufs.push(encodePktLine('agent=makefun-git/1.0\n'));
          bufs.push(encodePktLine('ls-refs\n'));
          bufs.push(encodePktLine('fetch\n'));
          bufs.push(Buffer.from('0000', 'ascii'));
        } else {
          // v0 refs
          const headSha = repo.refs.get('refs/heads/main') || repo.refs.get('HEAD') || ZERO_OID;
          const caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed no-done symref=HEAD:refs/heads/main agent=makefun-git/1.0';
          bufs.push(encodePktLine(`${headSha} HEAD\0${caps}\n`));
          for (const [refName, sha] of repo.refs.entries()) {
            if (refName !== 'HEAD') {
              bufs.push(encodePktLine(`${sha} ${refName}\n`));
            }
          }
          bufs.push(Buffer.from('0000', 'ascii'));
        }
      } else {
        // receive-pack v0
        const headSha = repo.refs.get('refs/heads/main') || ZERO_OID;
        const caps = 'report-status report-status-v2 side-band side-band-64k ofs-delta object-format=sha1 agent=makefun-git/1.0';
        bufs.push(encodePktLine(`${headSha} HEAD\0${caps}\n`));
        for (const [refName, sha] of repo.refs.entries()) {
          if (refName !== 'HEAD') {
            bufs.push(encodePktLine(`${sha} ${refName}\n`));
          }
        }
        bufs.push(Buffer.from('0000', 'ascii'));
      }

      const body = Buffer.concat(bufs);
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': body.length,
        'cache-control': 'no-cache'
      });
      res.end(body);
      return;
    }
  }

  if (gitPath === '/git-upload-pack' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const reqBody = Buffer.concat(chunks);
    const isV2 = req.headers['git-protocol'] === 'version=2';

    if (isV2) {
      // v2 upload-pack protocol
      const packets = parsePktLines(reqBody).map((p) => p.toString('utf8'));
      const bufs: Buffer[] = [];
      let command = '';
      for (const str of packets) {
        const line = str.trim();
        if (line.startsWith('command=')) {
          command = line.slice('command='.length).trim();
        }
      }
      if (command === 'ls-refs') {
        const headSha = repo.refs.get('refs/heads/main') || ZERO_OID;
        bufs.push(encodePktLine(`${headSha} HEAD symref-target:refs/heads/main\n`));
        for (const [refName, sha] of repo.refs.entries()) {
          bufs.push(encodePktLine(`${sha} ${refName}\n`));
        }
        bufs.push(Buffer.from('0000', 'ascii')); // flush: end of ls-refs response
      } else if (command === 'fetch') {
        const done = packets.some((s) => s.trim().startsWith('done'));
        if (!done) {
          // negotiate: no haves -> ready + NAK, client replies with done
          bufs.push(encodePktLine('acknowledgments\n'));
          bufs.push(encodePktLine('ready\n'));
          bufs.push(encodePktLine('NAK\n'));
          bufs.push(Buffer.from('0000', 'ascii'));
        } else {
          const allObjs = [...repo.objects.values()];
          const pack = buildPackfile(allObjs);
          bufs.push(encodePktLine('packfile\n'));
          // side-band-64k wrap pack data (band 1 = pack)
          let offset = 0;
          while (offset < pack.length) {
            const chunk = pack.subarray(offset, offset + 65516);
            const pkt = Buffer.concat([Buffer.from([1]), chunk]);
            bufs.push(encodePktLine(pkt));
            offset += 65516;
          }
          bufs.push(Buffer.from('0000', 'ascii')); // flush
        }
      } else {
        // unknown v2 command: send an empty packfile response
        bufs.push(Buffer.from('0000', 'ascii'));
      }

      const resp = Buffer.concat(bufs);
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'content-length': resp.length
      });
      res.end(resp);
      return;
    } else {
      // v0 upload-pack
      const allObjs = [...repo.objects.values()];
      const pack = buildPackfile(allObjs);
      const sbBufs: Buffer[] = [];
      sbBufs.push(encodePktLine('NAK\n'));
      let offset = 0;
      while (offset < pack.length) {
        const chunk = pack.subarray(offset, offset + 65516);
        const pkt = Buffer.concat([Buffer.from([1]), chunk]);
        sbBufs.push(encodePktLine(pkt));
        offset += 65516;
      }
      sbBufs.push(Buffer.from('0000', 'ascii'));

      const resp = Buffer.concat(sbBufs);
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'content-length': resp.length
      });
      res.end(resp);
      return;
    }
  }

  if (gitPath === '/git-receive-pack' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const reqBody = Buffer.concat(chunks);

    // Parse commands and packfile from receive-pack request
    const packets = parsePktLines(reqBody);
    const commands: { oldSha: string; newSha: string; refName: string }[] = [];
    let packBuf: Buffer | null = null;

    let parsingCommands = true;
    for (const pkt of packets) {
      if (pkt.length === 4 && pkt.toString('ascii') === '0000') {
        parsingCommands = false;
        continue;
      }
      if (parsingCommands) {
        const line = pkt.toString('utf8').trim();
        const parts = line.split(' ');
        if (parts.length >= 3) {
          commands.push({ oldSha: parts[0], newSha: parts[1], refName: parts[2] });
        }
      } else {
        // subsequent bytes or packfile
        // In receive-pack, after commands flush, the rest of reqBody contains the packfile.
      }
    }

    // Extract packfile from reqBody
    // Find 'PACK' signature in reqBody
    const packIndex = reqBody.indexOf('PACK');
    if (packIndex !== -1) {
      packBuf = reqBody.subarray(packIndex);
      decodePackfileAndStore(packBuf, repo);
    }

    // Update refs
    for (const cmd of commands) {
      if (cmd.newSha === ZERO_OID) {
        repo.refs.delete(cmd.refName);
      } else {
        repo.refs.set(cmd.refName, cmd.newSha);
        if (cmd.refName.startsWith('refs/heads/')) {
          repo.default_branch = cmd.refName.replace('refs/heads/', '');
        }
      }
    }
    repo.refs.set('HEAD', repo.refs.get(`refs/heads/${repo.default_branch}`) || ZERO_OID);
    clearCache();

    // Report status side-band-64k response
    const statusLines: string[] = ['unpack ok\n'];
    for (const cmd of commands) {
      statusLines.push(`ok ${cmd.refName}\n`);
    }
    statusLines.push('');

    const statusPktData = Buffer.from(statusLines.join(''));
    // Wrap in side-band-64k (channel 1)
    const pkt = encodePktLine(Buffer.concat([Buffer.from([1]), statusPktData]));
    const flush = Buffer.from('0000', 'ascii');
    const resp = Buffer.concat([pkt, flush]);

    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-result',
      'content-length': resp.length
    });
    res.end(resp);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// --- REST v3 Handler ---
async function handleRestRequest(req: IncomingMessage, res: ServerResponse, path: string, method: string, parsedUrl: URL) {
  // Current user
  if (path === '/api/v3/user') {
    sendJson(res, 200, {
      login: 'octocat',
      id: 1,
      node_id: 'MDQ6VXNlcjE=',
      avatar_url: 'https://github.com/images/error/octocat_happy.gif',
      type: 'User',
      name: 'monalisa octocat'
    });
    return;
  }

  // User repos / org repos / create repo
  if (path === '/api/v3/user/repos' || path.match(/^\/api\/v3\/(?:users|orgs)\/[A-Za-z0-9._-]+\/repos$/)) {
    if (method === 'GET') {
      const allRepos = [...store.repos.values()].map(repoToRest);
      sendJson(res, 200, allRepos);
      return;
    }
    if (method === 'POST') {
      const body = await parseJsonBody(req);
      const name = body.name || 'test-repo';
      const owner = body.owner || 'octocat';
      const repo = store.ensureRepo(owner, name);
      repo.description = body.description || null;
      repo.private = body.private ?? false;
      clearCache();
      sendJson(res, 201, repoToRest(repo));
      return;
    }
  }

  // Repo CRUD (/api/v3/repos/:owner/:repo)
  const repoMatch = path.match(/^\/api\/v3\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(.*)$/);
  if (repoMatch) {
    const owner = repoMatch[1];
    const repoName = repoMatch[2];
    const subPath = repoMatch[3] || '';
    const repo = store.ensureRepo(owner, repoName);

    if (subPath === '' || subPath === '/') {
      if (method === 'GET') {
        sendJson(res, 200, repoToRest(repo));
        return;
      }
      if (method === 'PATCH') {
        const body = await parseJsonBody(req);
        if (body.name) repo.name = body.name;
        if (body.description !== undefined) repo.description = body.description;
        if (body.private !== undefined) repo.private = body.private;
        if (body.default_branch) repo.default_branch = body.default_branch;
        clearCache();
        sendJson(res, 200, repoToRest(repo));
        return;
      }
      if (method === 'DELETE') {
        store.repos.delete(`${owner.toLowerCase()}/${repoName.toLowerCase()}`);
        clearCache();
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // Branches (/api/v3/repos/:owner/:repo/branches)
    if (subPath === '/branches') {
      if (method === 'GET') {
        const branches = [];
        for (const [refName, sha] of repo.refs.entries()) {
          if (refName.startsWith('refs/heads/')) {
            const name = refName.replace('refs/heads/', '');
            branches.push({
              name,
              commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` },
              protected: false
            });
          }
        }
        sendJson(res, 200, branches);
        return;
      }
    }

    // Commits (/api/v3/repos/:owner/:repo/commits)
    if (subPath.startsWith('/commits')) {
      if (method === 'GET') {
        const commits = [];
        for (const [sha, obj] of repo.objects.entries()) {
          if (obj.type === 'commit') {
            commits.push({
              sha,
              commit: {
                author: { name: 'octocat', email: 'octocat@github.com', date: FIXED_DATE },
                committer: { name: 'octocat', email: 'octocat@github.com', date: FIXED_DATE },
                message: obj.content.toString('utf8').split('\n\n')[1] || 'commit message'
              },
              html_url: `/${owner}/${repoName}/commit/${sha}`,
              url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}`
            });
          }
        }
        sendJson(res, 200, commits);
        return;
      }
    }

    // Contents (/api/v3/repos/:owner/:repo/contents/:path)
    if (subPath.startsWith('/contents/')) {
      const filePath = subPath.replace('/contents/', '');
      if (method === 'GET') {
        // Return file content as base64
        const blobSha = computeSha('blob', Buffer.from(filePath));
        sendJson(res, 200, {
          name: filePath.split('/').pop(),
          path: filePath,
          sha: blobSha,
          size: 13,
          type: 'file',
          content: Buffer.from('hello world').toString('base64'),
          encoding: 'base64'
        });
        return;
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req);
        const contentBase64 = body.content || '';
        const fileContent = Buffer.from(contentBase64, 'base64');
        const blobSha = storeObject(repo, 'blob', fileContent);
        const commitSha = storeObject(repo, 'commit', Buffer.from(`tree tree-sha\nauthor octocat <octocat@github.com> 1700000000 +0000\ncommitter octocat <octocat@github.com> 1700000000 +0000\n\n${body.message || 'update file'}\n`));
        repo.refs.set(`refs/heads/${body.branch || repo.default_branch}`, commitSha);
        clearCache();
        sendJson(res, 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: fileContent.length },
          commit: { sha: commitSha, message: body.message || 'update file' }
        });
        return;
      }
    }

    // Issues (/api/v3/repos/:owner/:repo/issues)
    if (subPath === '/issues' || subPath === '/issues/') {
      if (method === 'GET') {
        sendJson(res, 200, repo.issues);
        return;
      }
      if (method === 'POST') {
        const body = await parseJsonBody(req);
        const issue: Issue = {
          id: store.nextId++,
          number: repo.issues.length + 1,
          title: body.title || 'New Issue',
          body: body.body || '',
          state: 'open',
          user: { login: 'octocat', id: 1 },
          labels: body.labels ? body.labels.map((l: string, i: number) => ({ id: i + 1, name: l, color: 'ededed' })) : [],
          comments: 0,
          created_at: FIXED_DATE,
          updated_at: FIXED_DATE,
          closed_at: null
        };
        repo.issues.push(issue);
        clearCache();
        sendJson(res, 201, issue);
        return;
      }
    }

    // Issue by number (/api/v3/repos/:owner/:repo/issues/:number)
    const issueMatch = subPath.match(/^\/issues\/([0-9]+)(\/comments)?$/);
    if (issueMatch) {
      const issueNum = parseInt(issueMatch[1], 10);
      const isComments = !!issueMatch[2];
      const issue = repo.issues.find(i => i.number === issueNum);

      if (!issue) {
        sendJson(res, 404, { message: 'Issue Not Found' });
        return;
      }

      if (isComments) {
        const comments = repo.issueComments.get(issueNum) || [];
        if (method === 'GET') {
          sendJson(res, 200, comments);
          return;
        }
        if (method === 'POST') {
          const body = await parseJsonBody(req);
          const comment: IssueComment = {
            id: store.nextId++,
            body: body.body || '',
            user: { login: 'octocat', id: 1 },
            created_at: FIXED_DATE,
            updated_at: FIXED_DATE
          };
          comments.push(comment);
          repo.issueComments.set(issueNum, comments);
          issue.comments = comments.length;
          clearCache();
          sendJson(res, 201, comment);
          return;
        }
      }

      if (method === 'GET') {
        sendJson(res, 200, issue);
        return;
      }
      if (method === 'PATCH') {
        const body = await parseJsonBody(req);
        if (body.title) issue.title = body.title;
        if (body.body !== undefined) issue.body = body.body;
        if (body.state) {
          issue.state = body.state;
          issue.closed_at = body.state === 'closed' ? FIXED_DATE : null;
        }
        issue.updated_at = FIXED_DATE;
        clearCache();
        sendJson(res, 200, issue);
        return;
      }
    }

    // Labels (/api/v3/repos/:owner/:repo/labels)
    if (subPath === '/labels') {
      if (method === 'GET') {
        sendJson(res, 200, repo.labels);
        return;
      }
      if (method === 'POST') {
        const body = await parseJsonBody(req);
        const label = { id: store.nextId++, name: body.name || 'label', color: body.color || 'ededed' };
        repo.labels.push(label);
        clearCache();
        sendJson(res, 201, label);
        return;
      }
    }

    // Releases (/api/v3/repos/:owner/:repo/releases)
    if (subPath === '/releases' || subPath === '/releases/') {
      if (method === 'GET') {
        sendJson(res, 200, [], { 'X-GitHub-Request-Id': `${store.nextId.toString(16)}` });
        return;
      }
    }

    if (subPath.startsWith('/git/trees/') && method === 'GET') {
      const sha = subPath.slice('/git/trees/'.length).replace(/\/$/, '');
      if (repo.objects.has(sha)) {
        sendJson(res, 200, { sha, url: '/api/v3/repos/octocat/demo/git/trees/' + sha, tree: [], truncated: false });
      } else {
        sendJson(res, 404, { message: 'Not Found' });
      }
      return;
    }

    // Pull requests (/api/v3/repos/:owner/:repo/pulls)
    if (subPath === '/pulls' || subPath === '/pulls/') {
      if (method === 'GET') {
        sendJson(res, 200, repo.pulls);
        return;
      }
      if (method === 'POST') {
        const body = await parseJsonBody(req);
        const pr: PullRequest = {
          id: store.nextId++,
          number: repo.pulls.length + 1,
          title: body.title || 'New PR',
          body: body.body || '',
          state: 'open',
          head: { ref: body.head || 'feature', sha: '1111111111111111111111111111111111111111', repo: { full_name: repo.full_name } },
          base: { ref: body.base || 'main', sha: repo.refs.get('refs/heads/main') || ZERO_OID, repo: { full_name: repo.full_name } },
          user: { login: 'octocat', id: 1 },
          merged: false,
          mergeable: true,
          merged_at: null,
          created_at: FIXED_DATE,
          updated_at: FIXED_DATE,
          files: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 1, changes: 2 }]
        };
        repo.pulls.push(pr);
        clearCache();
        sendJson(res, 201, pr);
        return;
      }
    }

    // Pull request by number (/api/v3/repos/:owner/:repo/pulls/:number)
    const prMatch = subPath.match(/^\/pulls\/([0-9]+)(\/files|\/comments|\/merge)?$/);
    if (prMatch) {
      const prNum = parseInt(prMatch[1], 10);
      const action = prMatch[2];
      const pr = repo.pulls.find(p => p.number === prNum);

      if (!pr) {
        sendJson(res, 404, { message: 'PR Not Found' });
        return;
      }

      if (action === '/files') {
        sendJson(res, 200, pr.files || []);
        return;
      }
      if (action === '/comments') {
        sendJson(res, 200, []);
        return;
      }
      if (action === '/merge' && method === 'PUT') {
        pr.merged = true;
        pr.state = 'merged';
        pr.merged_at = FIXED_DATE;
        clearCache();
        sendJson(res, 200, { sha: '2222222222222222222222222222222222222222', merged: true, message: 'Pull Request successfully merged' });
        return;
      }

      if (method === 'GET') {
        sendJson(res, 200, pr);
        return;
      }
      if (method === 'PATCH') {
        const body = await parseJsonBody(req);
        if (body.title) pr.title = body.title;
        if (body.state) pr.state = body.state;
        clearCache();
        sendJson(res, 200, pr);
        return;
      }
    }

    // Merges (/api/v3/repos/:owner/:repo/merges)
    if (subPath === '/merges' && method === 'POST') {
      sendJson(res, 201, { sha: '3333333333333333333333333333333333333333' });
      return;
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function repoToRest(repo: Repository) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: repo.owner,
    private: repo.private,
    html_url: `/${repo.full_name}`,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at
  };
}

async function parseJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

// --- GraphQL Handler ---
async function handleGraphQL(req: IncomingMessage, res: ServerResponse) {
  const body = await parseJsonBody(req);
  const query = body.query || '';

  let data: any = {};
  if (query.includes('viewer')) {
    data.viewer = { login: 'octocat', id: 'MDQ6VXNlcjE=' };
  } else if (query.includes('repository')) {
    data.repository = {
      id: 'R_kgDOH12345',
      name: 'test-repo',
      owner: { login: 'octocat' },
      issues: { nodes: [] },
      pullRequests: { nodes: [] }
    };
  } else {
    data.viewer = { login: 'octocat' };
  }

  sendJson(res, 200, { data });
}

// --- MCP Handler ---
async function handleMCP(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'GET') {
    sendJson(res, 200, { name: 'github-mcp-server', version: '1.0.0' });
    return;
  }

  const body = await parseJsonBody(req);
  const { id, method, params } = body;

  if (method === 'initialize') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'github-mcp-server', version: '1.0.0' }
      }
    });
    return;
  }

  if (method === 'notifications/initialized') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'create_repository', description: 'Create a repository', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
          { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' } } } }
        ]
      }
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};
    let resultText = 'Success';

    if (toolName === 'create_repository') {
      const repo = store.ensureRepo('octocat', args.name || 'mcp-repo');
      resultText = JSON.stringify(repoToRest(repo));
    } else if (toolName === 'create_issue') {
      const repo = store.ensureRepo(args.owner || 'octocat', args.repo || 'test-repo');
      const issue: Issue = {
        id: store.nextId++,
        number: repo.issues.length + 1,
        title: args.title || 'MCP Issue',
        body: args.body || '',
        state: 'open',
        user: { login: 'octocat', id: 1 },
        labels: [],
        comments: 0,
        created_at: FIXED_DATE,
        updated_at: FIXED_DATE,
        closed_at: null
      };
      repo.issues.push(issue);
      resultText = JSON.stringify(issue);
    }

    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: resultText }]
      }
    });
    return;
  }

  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}
