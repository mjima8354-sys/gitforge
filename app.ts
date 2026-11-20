// GitHub-compatible git forge: git smart HTTP (upload-pack v0+v2, receive-pack v0),
// REST v3, GraphQL v4 and MCP, all over one in-process store. Node 22 stdlib only.
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { inflateSync, deflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const FIXED_DATE = '2026-01-01T00:00:00Z';
const FIXED_EPOCH = 1767225600;
const ZERO_OID = '0'.repeat(40);
const VIEWER = 'adaiversen';

interface GitObject { type: 'commit' | 'tree' | 'blob' | 'tag'; content: Buffer; sha: string }
interface IssueComment { id: number; body: string; user: { login: string; id: number }; created_at: string; updated_at: string }
interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  user: { login: string; id: number }; labels: { id: number; name: string; color: string }[];
  comments: number; created_at: string; updated_at: string; closed_at: string | null;
}
interface PullRequestFile { filename: string; status: string; additions: number; deletions: number; changes: number }
interface PullRequest {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; sha: string; repo: { full_name: string } };
  user: { login: string; id: number }; merged: boolean; mergeable: boolean; merged_at: string | null;
  merge_commit_sha: string | null; created_at: string; updated_at: string; base_tip: string;
}
interface Repository {
  id: number; name: string; full_name: string; owner: { login: string; id: number };
  private: boolean; default_branch: string; description: string | null;
  created_at: string; updated_at: string;
  refs: Map<string, string>; objects: Map<string, GitObject>;
  issues: Issue[]; issueComments: Map<number, IssueComment[]>; nextCommentId: number;
  labels: { id: number; name: string; color: string }[]; pulls: PullRequest[];
}

class ForgeStore {
  repos = new Map<string, Repository>(); // "owner/repo" (lowercased) -> Repository
  nextId = 1;
  nextNodeId = 1;
  getRepo(owner: string, repoName: string): Repository | undefined {
    return this.repos.get(`${owner.toLowerCase()}/${repoName.toLowerCase()}`);
  }
  ensureRepo(owner: string, repoName: string, opts: { private?: boolean; description?: string | null } = {}): Repository {
    const key = `${owner.toLowerCase()}/${repoName.toLowerCase()}`;
    let repo = this.repos.get(key);
    if (!repo) {
      repo = {
        id: this.nextId++, name: repoName, full_name: `${owner}/${repoName}`,
        owner: { login: owner, id: 1 }, private: opts.private ?? false, default_branch: 'main',
        description: opts.description ?? null, created_at: FIXED_DATE, updated_at: FIXED_DATE,
        refs: new Map(), objects: new Map(), issues: [], issueComments: new Map(), nextCommentId: 1,
        labels: [], pulls: [],
      };
      this.repos.set(key, repo);
    }
    return repo;
  }
}
const store = new ForgeStore();

// ---------------------------------------------------------------- git object model
function shaOf(type: string, content: Buffer): string {
  return createHash('sha1').update(Buffer.from(`${type} ${content.length}\0`)).update(content).digest('hex');
}
function storeObject(repo: Repository, type: GitObject['type'], content: Buffer): string {
  const sha = shaOf(type, content);
  const existing = repo.objects.get(sha);
  if (existing) return sha;
  repo.objects.set(sha, { type, content, sha });
  return sha;
}
function parseCommit(content: Buffer): { tree: string; parents: string[]; message: string } {
  const text = content.toString('utf8');
  const header = text.split('\n\n')[0];
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  const message = text.slice(header.length + 2);
  return { tree, parents, message };
}
interface TreeEntry { mode: string; name: string; oid: string }
function parseTree(content: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = content.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > content.length) break;
    const mode = content.toString('ascii', offset, space);
    const name = content.toString('utf8', space + 1, nul);
    const oid = content.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}
function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
function commitTree(repo: Repository, commitSha: string): string {
  const obj = repo.objects.get(commitSha);
  return obj ? parseCommit(obj.content).tree : '';
}
type Flat = Map<string, { mode: string; sha: string }>;
function flattenTree(repo: Repository, treeSha: string, prefix = ''): Flat {
  const out: Flat = new Map();
  if (!treeSha) return out;
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.content)) {
    const path = prefix + entry.name;
    if (entry.mode === '40000' || entry.mode === '040000') {
      for (const [p, v] of flattenTree(repo, entry.oid, path + '/')) out.set(p, v);
    } else {
      out.set(path, { mode: entry.mode === '100755' ? '100755' : '100644', sha: entry.oid });
    }
  }
  return out;
}
/** Build nested tree objects from a flat map; returns the root tree sha. */
function buildTree(repo: Repository, flat: Flat): string {
  interface Node { dirs: Map<string, Node>; files: Map<string, { mode: string; sha: string }> }
  const root: Node = { dirs: new Map(), files: new Map() };
  for (const [path, v] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      let next = node.dirs.get(segments[i]);
      if (!next) { next = { dirs: new Map(), files: new Map() }; node.dirs.set(segments[i], next); }
      node = next;
    }
    node.files.set(segments[segments.length - 1], v);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: write(child) });
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.sha });
    return storeObject(repo, 'tree', encodeTree(entries));
  };
  return write(root);
}
function makeCommit(repo: Repository, message: string, parents: string[], treeSha: string): string {
  const ident = `makefun <forge@makefun.local> ${FIXED_EPOCH} +0000`;
  const lines = [`tree ${treeSha}`, ...parents.map((p) => `parent ${p}`), `author ${ident}`, `committer ${ident}`].join('\n');
  return storeObject(repo, 'commit', Buffer.from(`${lines}\n\n${message}\n`, 'utf8'));
}
function commitFiles(repo: Repository, message: string, parentShas: string[], updates: Record<string, Buffer | null>): { commitSha: string; treeSha: string } {
  const flat: Flat = parentShas.length ? flattenTree(repo, commitTree(repo, parentShas[0])) : new Map();
  for (const [path, content] of Object.entries(updates)) {
    if (content === null) flat.delete(path);
    else flat.set(path, { mode: '100644', sha: storeObject(repo, 'blob', content) });
  }
  const treeSha = buildTree(repo, flat);
  const commitSha = makeCommit(repo, message, parentShas, treeSha);
  return { commitSha, treeSha };
}
interface ReachOpts { depth?: number; stopAt?: Set<string> }
/** All objects reachable from the given oids (commits with generation depth, trees, blobs, tags). */
function reachableObjects(repo: Repository, startOids: string[], opts: ReachOpts = {}): Set<string> {
  const seen = new Set<string>();
  const maxDepth = opts.depth ?? Number.POSITIVE_INFINITY;
  const shallowCommits = new Set<string>();
  interface QueueItem { sha: string; depth: number }
  const commitQueue: QueueItem[] = [];
  const enqueueTag = (sha: string, depth: number) => {
    const obj = repo.objects.get(sha);
    if (!obj) return;
    if (!seen.has(sha)) seen.add(sha);
    if (obj.type === 'tag') {
      const m = obj.content.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (m) enqueueTag(m[1], depth);
    } else if (obj.type === 'commit') {
      commitQueue.push({ sha, depth });
    } else {
      seen.add(sha);
    }
  };
  for (const oid of startOids) enqueueTag(oid, 1);
  while (commitQueue.length) {
    const { sha, depth } = commitQueue.shift()!;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    const { tree, parents } = parseCommit(obj.content);
    if (tree) seen.add(tree);
    if (tree) {
      const obj2 = repo.objects.get(tree);
      if (obj2 && obj2.type === 'tree') {
        const stack = [tree];
        const visitedTrees = new Set<string>();
        while (stack.length) {
          const t = stack.pop()!;
          const to = repo.objects.get(t);
          if (!to || to.type !== 'tree' || visitedTrees.has(t)) continue;
          visitedTrees.add(t);
          for (const entry of parseTree(to.content)) {
            seen.add(entry.oid);
            const eo = repo.objects.get(entry.oid);
            if (eo && eo.type === 'tree') stack.push(entry.oid);
          }
        }
      }
    }
    if (depth >= maxDepth && parents.length) shallowCommits.add(sha);
    if (depth < maxDepth) {
      for (const parent of parents) {
        if (!seen.has(parent)) commitQueue.push({ sha: parent, depth: depth + 1 });
      }
    }
  }
  void opts.stopAt;
  return seen;
}
/** Commits reachable from a tip, newest first. */
function commitChain(repo: Repository, tipSha: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = tipSha ? [tipSha] : [];
  while (stack.length) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    out.push(sha);
    for (const parent of parseCommit(obj.content).parents) stack.push(parent);
  }
  out.sort((a, b) => {
    void a; void b; return 0;
  });
  // parent-first ordering: children before parents (walk order gives that naturally, keep list as-is)
  return out;
}
function resolveRef(repo: Repository, ref: string): string | null {
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const sha = repo.refs.get(candidate);
    if (sha) return sha;
  }
  return null;
}
function tipOf(repo: Repository, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

// ---------------------------------------------------------------- packfile read/write
function readVarint(buf: Buffer, offset: number): { value: number; length: number } {
  let value = 0, shift = 0, pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return { value, length: pos - offset };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    const r = readVarint(delta, offset);
    offset += r.length;
    return r.value;
  };
  readSize(); // base size
  const resultSize = readSize();
  const out = Buffer.alloc(resultSize);
  let pos = 0;
  while (offset < delta.length && pos < resultSize) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0, copySize = 0;
      if (op & 0x01) copyOffset |= delta[offset++];
      if (op & 0x02) copyOffset |= delta[offset++] << 8;
      if (op & 0x04) copyOffset |= delta[offset++] << 16;
      if (op & 0x08) copyOffset |= delta[offset++] << 24;
      if (op & 0x10) copySize |= delta[offset++];
      if (op & 0x20) copySize |= delta[offset++] << 8;
      if (op & 0x40) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, pos, copyOffset, copyOffset + copySize);
      pos += copySize;
    } else {
      delta.copy(out, pos, offset, offset + op);
      offset += op;
      pos += op;
    }
  }
  return out.subarray(0, pos);
}
function decodePackfile(packBuf: Buffer, repo: Repository): { stored: Set<string>; error: string | null } {
  const stored = new Set<string>();
  if (packBuf.length < 32) return { stored, error: 'pack too short' };
  const version = packBuf.readUInt32BE(4);
  if (version !== 2 && version !== 3) return { stored, error: `bad pack version ${version}` };
  const numObjects = packBuf.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, { type: GitObject['type']; data: Buffer }>();
  for (let i = 0; i < numObjects && offset < packBuf.length - 20; i++) {
    const objOffset = offset;
    let b = packBuf[offset++];
    const typeNum = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (offset >= packBuf.length) return { stored, error: 'pack truncated in object header' };
      b = packBuf[offset++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset = -1, baseSha = '';
    if (typeNum === 6) {
      let deltaOffset = 0, ofsShift = 0;
      while (offset < packBuf.length) {
        const eb = packBuf[offset++];
        deltaOffset = (deltaOffset << 7) | (eb & 0x7f);
        if (!(eb & 0x80)) break;
        ofsShift += 7;
      }
      baseOffset = objOffset - deltaOffset;
    } else if (typeNum === 7) {
      baseSha = packBuf.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const data = inflateExact(packBuf, offset, size);
    if (data === null) return { stored, error: 'pack object failed to inflate' };
    // find compressed length by re-deflating? Instead advance via zlib stream length:
    const consumed = compressedLength(packBuf, offset);
    if (consumed < 0) return { stored, error: 'pack object stream undecodable' };
    offset += consumed;
    if (typeNum >= 1 && typeNum <= 4) {
      const typeStr = (['', 'commit', 'tree', 'blob', 'tag'])[typeNum] as GitObject['type'];
      byOffset.set(objOffset, { type: typeStr, data });
      stored.add(storeObject(repo, typeStr, data));
    } else {
      byOffset.set(objOffset, { type: typeNum === 6 ? 'ofs-delta' : 'ref-delta', data });
    }
  }
  // resolve deltas
  for (const [objOffset, entry] of byOffset) {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') continue;
    let base: { type: GitObject['type']; data: Buffer } | undefined;
    if (entry.type === 'ofs-delta') base = byOffset.get(baseOffset);
    else {
      const bo = repo.objects.get(baseSha);
      if (bo) base = { type: bo.type, data: bo.content };
    }
    if (!base) {
      // look up by stored sha from this pack
      for (const cand of byOffset.values()) {
        if (cand.type !== 'ofs-delta' && cand.type !== 'ref-delta' && shaOf(cand.type, cand.data) === baseSha) { base = cand; break; }
      }
    }
    if (!base) continue; // unresolvable delta: skip (the object stays absent)
    const full = applyDelta(base.data, entry.data);
    const type = base.type;
    byOffset.set(objOffset, { type, data: full });
    stored.add(storeObject(repo, type, full));
  }
  return { stored, error: null };
}
function inflateExact(buf: Buffer, offset: number, size: number): Buffer | null {
  const res = inflateSync(buf.subarray(offset), { maxOutputLength: Math.max(size, 1) });
  if (res.length !== size) return null;
  return res;
}
function compressedLength(buf: Buffer, offset: number): number {
  // zlib streams end with an adler32 trailer; inflateSync consumed everything to the end, so
  // instead of guessing, run a streaming inflate via zlib's "chunk" trick: use inflateSync on
  // progressively larger windows. The pack is bounded (max 100 MiB guard) so the search is cheap.
  let low = 8, high = Math.min(buf.length - offset, 8 * 1024 * 1024);
  let ok = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    try {
      inflateSync(buf.subarray(offset, offset + mid));
      ok = mid;
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  return ok;
}
function buildPackfile(objects: GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const bufs: Buffer[] = [header];
  for (const obj of objects) {
    let typeNum = 3;
    if (obj.type === 'commit') typeNum = 1;
    else if (obj.type === 'tree') typeNum = 2;
    else if (obj.type === 'tag') typeNum = 4;
    let size = obj.content.length;
    const headBytes: number[] = [((typeNum & 7) << 4) | (size & 0x0f)];
    size >>= 4;
    while (size > 0) {
      headBytes[headBytes.length - 1] |= 0x80;
      headBytes.push(size & 0x7f);
      size >>= 7;
    }
    bufs.push(Buffer.from(headBytes));
    bufs.push(deflateSync(obj.content));
  }
  const all = Buffer.concat(bufs);
  return Buffer.concat([all, createHash('sha1').update(all).digest()]);
}

// ---------------------------------------------------------------- pkt-line helpers
function encodePktLine(data: string | Uint8Array): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
interface Pkt { kind: 'data' | 'flush' | 'delim' | 'other'; payload: Buffer; raw: Buffer }
function decodePktLines(buf: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenHex = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0), raw: buf.subarray(offset, offset + 4) }); offset += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0), raw: buf.subarray(offset, offset + 4) }); offset += 4; continue; }
    if (len === 2) { packets.push({ kind: 'other', payload: Buffer.alloc(0), raw: buf.subarray(offset, offset + 4) }); offset += 4; continue; }
    if (offset + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len), raw: buf.subarray(offset, offset + len) });
    offset += len;
  }
  return packets;
}

// ---------------------------------------------------------------- git smart HTTP
function sidebandWrap(data: Buffer, chunks: Buffer[]): void {
  let offset = 0;
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + 65500);
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
    offset += chunk.length;
  }
}
function computeSendSet(repo: Repository, wants: string[], haves: string[], depth: number | null, clientShallow: string[]): {
  send: GitObject[]; shallow: string[]; unshallow: string[];
} {
  const wantDepth = depth ?? Number.POSITIVE_INFINITY;
  const heldDepth = clientShallow.length > 0 ? (depth !== null ? 1 : 1) : Number.POSITIVE_INFINITY;
  const wanted = depth !== null
    ? reachableObjects(repo, wants, { depth: wantDepth })
    : reachableObjects(repo, wants);
  const held = haves.length ? reachableObjects(repo, haves, { depth: heldDepth }) : new Set<string>();
  const sendShas = [...wanted].filter((sha) => !held.has(sha));
  // shallow boundaries: included commits whose parents are excluded (or missing)
  const shallow: string[] = [];
  const unshallow = new Set<string>();
  if (depth !== null) {
    for (const sha of wanted) {
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      const { parents } = parseCommit(obj.content);
      if (parents.length && parents.some((p) => !wanted.has(p))) shallow.push(sha);
      else if (parents.length === 0 && depth !== Number.POSITIVE_INFINITY) shallow.push(sha);
      if (clientShallow.includes(sha) && parents.length && wanted.has(parents[0])) unshallow.add(sha);
    }
  } else {
    for (const boundary of clientShallow) {
      const obj = repo.objects.get(boundary);
      if (obj && obj.type === 'commit') {
        const parent = parseCommit(obj.content).parents[0];
        if (parent && wanted.has(parent)) unshallow.add(boundary);
        else if (parent && !wanted.has(parent)) shallow.push(boundary);
      }
    }
  }
  const send = sendShas
    .map((sha) => repo.objects.get(sha))
    .filter((o): o is GitObject => Boolean(o));
  return { send, shallow, unshallow: [...unshallow] };
}
function lsRefsResponse(repo: Repository, opts: { symrefs?: boolean; peel?: boolean; prefixes?: string[] }): Buffer[] {
  const chunks: Buffer[] = [];
  const prefixes = opts.prefixes ?? [];
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const headSha = repo.refs.get(`refs/heads/${repo.default_branch}`) ?? null;
  if (headSha && matches('HEAD')) {
    let line = `${headSha} HEAD`;
    if (opts.symrefs) line += ` symref-target:refs/heads/${repo.default_branch}`;
    chunks.push(encodePktLine(line + '\n'));
  }
  for (const [name, sha] of repo.refs) {
    if (name === 'HEAD' || !matches(name)) continue;
    let line = `${sha} ${name}`;
    const obj = repo.objects.get(sha);
    if (opts.peel && name.startsWith('refs/tags/') && obj && obj.type === 'tag') {
      const m = obj.content.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (m) line += ` peeled:${m[1]}`;
    }
    chunks.push(encodePktLine(line + '\n'));
  }
  chunks.push(FLUSH);
  return chunks;
}
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function isV2Request(req: IncomingMessage): boolean {
  const header = String(req.headers['git-protocol'] ?? '');
  return header.split(':').some((part) => part.trim() === 'version=2');
}
function gitNotFound(res: ServerResponse): void {
  const text = 'Not Found\n';
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function handleGitRequest(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, gitPath: string, parsedUrl: URL): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    // A push cannot invent a repository: a missing one is 404 on both services.
    gitNotFound(res);
    return;
  }
  if (gitPath === '/info/refs') {
    const service = parsedUrl.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { gitNotFound(res); return; }
    const chunks: Buffer[] = [];
    chunks.push(encodePktLine(`# service=${service}\n`));
    chunks.push(FLUSH);
    const v2 = service === 'git-upload-pack' && isV2Request(req);
    if (v2) {
      chunks.push(encodePktLine('version 2\n'));
      chunks.push(encodePktLine('agent=makefun-forge/1.0\n'));
      chunks.push(encodePktLine('ls-refs=unborn\n'));
      chunks.push(encodePktLine('fetch=shallow\n'));
      chunks.push(encodePktLine('object-format=sha1\n'));
      chunks.push(FLUSH);
    } else if (service === 'git-upload-pack') {
      const headSha = tipOf(repo, repo.default_branch);
      const caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed no-done object-format=sha1 agent=makefun-forge/1.0';
      if (headSha) chunks.push(encodePktLine(`${headSha} HEAD\0${caps}\n`));
      else {
        // unborn HEAD: advertise capabilities alone on a capability line
        chunks.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
      }
      for (const [name, sha] of repo.refs) {
        if (name !== 'HEAD') chunks.push(encodePktLine(`${sha} ${name}\n`));
      }
      chunks.push(FLUSH);
    } else {
      const headSha = tipOf(repo, repo.default_branch);
      const caps = 'report-status report-status-v2 side-band side-band-64k ofs-delta delete-refs object-format=sha1 agent=makefun-forge/1.0';
      if (headSha) chunks.push(encodePktLine(`${headSha} HEAD\0${caps}\n`));
      else chunks.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
      for (const [name, sha] of repo.refs) {
        if (name !== 'HEAD') chunks.push(encodePktLine(`${sha} ${name}\n`));
      }
      chunks.push(FLUSH);
    }
    const body = Buffer.concat(chunks);
    res.writeHead(200, {
      'content-type': `application/x-${service}-advertisement`,
      'cache-control': 'no-cache',
      'content-length': body.length,
    });
    res.end(body);
    return;
  }

  if (gitPath === '/git-upload-pack' && req.method === 'POST') {
    const reqBody = await readBody(req);
    const chunks: Buffer[] = [];
    if (isV2Request(req)) {
      const packets = decodePktLines(reqBody);
      let command = '';
      const args: string[] = [];
      for (const pkt of packets) {
        if (pkt.kind !== 'data') continue;
        const line = pkt.payload.toString('utf8').replace(/\n$/, '');
        if (line.startsWith('command=')) command = line.slice('command='.length);
        else args.push(line);
      }
      if (command === 'ls-refs') {
        const wants = { symrefs: args.includes('symrefs'), peel: args.includes('peel'), prefixes: args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length)) };
        chunks.push(...lsRefsResponse(repo, wants));
      } else if (command === 'fetch') {
        const wants: string[] = [], haves: string[] = [], clientShallow: string[] = [];
        let depth: number | null = null, done = false;
        for (const a of args) {
          if (a.startsWith('want ')) wants.push(a.slice(5).trim());
          else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
          else if (a.startsWith('shallow ')) clientShallow.push(a.slice(8).trim());
          else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7).trim(), 10);
          else if (a === 'done') done = true;
        }
        if (!done) {
          chunks.push(encodePktLine('acknowledgments\n'));
          chunks.push(encodePktLine('ready\n'));
          chunks.push(encodePktLine('NAK\n'));
          chunks.push(DELIM);
          chunks.push(FLUSH);
        } else {
          const { send, shallow, unshallow } = computeSendSet(repo, wants, haves, depth, clientShallow);
          const pack = buildPackfile(send);
          if (shallow.length || unshallow.length) {
            chunks.push(encodePktLine('shallow-info\n'));
            for (const sha of shallow) chunks.push(encodePktLine(`shallow ${sha}\n`));
            for (const sha of unshallow) chunks.push(encodePktLine(`unshallow ${sha}\n`));
            chunks.push(DELIM);
          } else {
            chunks.push(encodePktLine('acknowledgments\n'));
            chunks.push(encodePktLine('NAK\n'));
            chunks.push(DELIM);
          }
          chunks.push(encodePktLine('packfile\n'));
          sidebandWrap(pack, chunks);
          chunks.push(FLUSH);
        }
      } else {
        chunks.push(FLUSH);
      }
    } else {
      // v0 fetch
      const packets = decodePktLines(reqBody);
      const wants: string[] = [], haves: string[] = [];
      let depth: number | null = null;
      for (const pkt of packets) {
        if (pkt.kind !== 'data') continue;
        const line = pkt.payload.toString('utf8').replace(/\n$/, '').split('\0')[0];
        if (line.startsWith('want ')) {
          const parts = line.slice(5).split(' ');
          wants.push(parts[0]);
          for (const extra of parts.slice(1)) if (extra.startsWith('deepen=')) depth = parseInt(extra.slice(7), 10) || null;
        } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      }
      const { send } = computeSendSet(repo, wants, haves, depth, []);
      const pack = buildPackfile(send);
      chunks.push(encodePktLine('NAK\n'));
      sidebandWrap(pack, chunks);
      chunks.push(FLUSH);
    }
    const resp = Buffer.concat(chunks);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': resp.length });
    res.end(resp);
    return;
  }

  if (gitPath === '/git-receive-pack' && req.method === 'POST') {
    const reqBody = await readBody(req);
    const packets = decodePktLines(reqBody);
    const commands: { oldSha: string; newSha: string; refName: string }[] = [];
    let packStart = -1;
    let parsingCommands = true;
    let rawOffset = 0;
    for (const pkt of packets) {
      rawOffset += pkt.raw.length;
      if (pkt.kind === 'flush') { parsingCommands = false; continue; }
      if (!parsingCommands) continue;
      const line = pkt.payload.toString('utf8').replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldSha: parts[0], newSha: parts[1], refName: parts[2].split('\0')[0] });
      }
    }
    const packIndex = reqBody.indexOf('PACK', rawOffset);
    if (packIndex !== -1) packStart = packIndex;
    let unpackDetail = 'ok';
    if (packStart !== -1) {
      const result = decodePackfile(reqBody.subarray(packStart), repo);
      if (result.error) unpackDetail = result.error;
    }
    // fast-forward validation
    const isAncestor = (ancestor: string, commit: string, seen = new Set<string>()): boolean => {
      if (ancestor === commit) return true;
      if (seen.has(commit)) return false;
      seen.add(commit);
      const obj = repo.objects.get(commit);
      if (!obj || obj.type !== 'commit') return false;
      for (const parent of parseCommit(obj.content).parents) {
        if (isAncestor(ancestor, parent, seen)) return true;
      }
      return false;
    };
    const applied: typeof commands = [];
    const reportLines: string[] = [`unpack ${unpackDetail}\n`];
    for (const cmd of commands) {
      if (cmd.newSha !== ZERO_OID && !repo.objects.has(cmd.newSha)) {
        reportLines.push(`ng ${cmd.refName} missing necessary objects\n`);
        continue;
      }
      if (cmd.oldSha === ZERO_OID) {
        if (repo.refs.has(cmd.refName)) { reportLines.push(`ng ${cmd.refName} fetch first\n`); continue; }
      } else if (cmd.newSha === ZERO_OID) {
        if (!repo.refs.has(cmd.refName)) { reportLines.push(`ng ${cmd.refName} already deleted\n`); continue; }
        if (!repo.refs.get(cmd.refName)) { reportLines.push(`ng ${cmd.refName} fetch first\n`); continue; }
      } else {
        const cur = repo.refs.get(cmd.refName);
        if (cur === undefined || cur !== cmd.oldSha) { reportLines.push(`ng ${cmd.refName} fetch first\n`); continue; }
        if (!isAncestor(cur, cmd.newSha)) { reportLines.push(`ng ${cmd.refName} non-fast-forward\n`); continue; }
      }
      applied.push(cmd);
      reportLines.push(`ok ${cmd.refName}\n`);
    }
    for (const cmd of applied) {
      if (cmd.newSha === ZERO_OID) repo.refs.delete(cmd.refName);
      else {
        repo.refs.set(cmd.refName, cmd.newSha);
        if (cmd.refName.startsWith('refs/heads/')) repo.default_branch = cmd.refName.replace('refs/heads/', '');
      }
    }
    const headSha = tipOf(repo, repo.default_branch);
    if (headSha) repo.refs.set('HEAD', headSha);
    else repo.refs.delete('HEAD');
    const statusPktData = Buffer.from(reportLines.join(''));
    const chunks: Buffer[] = [];
    sidebandWrap(statusPktData, chunks);
    chunks.push(FLUSH);
    const resp = Buffer.concat(chunks);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': resp.length });
    res.end(resp);
    return;
  }
  gitNotFound(res);
}

// ---------------------------------------------------------------- REST v3
let requestCounter = 0;
function requestId(): string {
  requestCounter = (requestCounter + 1) % 0xffffff;
  return `${FIXED_EPOCH.toString(16)}${requestCounter.toString(16).padStart(6, '0')}`;
}
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...headers,
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': requestId(), ...headers });
  res.end();
}
function repoToRest(repo: Repository) {
  return {
    id: repo.id, node_id: nodeId('Repository', String(repo.id)),
    name: repo.name, full_name: repo.full_name,
    owner: { login: repo.owner.login, id: repo.owner.id, type: 'User' },
    private: repo.private, description: repo.description, fork: false,
    default_branch: repo.default_branch, created_at: repo.created_at, updated_at: repo.updated_at,
    pushed_at: repo.updated_at, html_url: `/${repo.full_name}`, url: `/api/v3/repos/${repo.full_name}`,
    has_issues: true,
  };
}
function nodeId(kind: string, key: string): string {
  return 'R_' + Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}
function nodeKey(id: string): { kind: string; key: string } | null {
  if (!id.startsWith('R_')) return null;
  try {
    const decoded = Buffer.from(id.slice(2), 'base64url').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) return null;
    return { kind: decoded.slice(0, sep), key: decoded.slice(sep + 1) };
  } catch { return null; }
}
function issueToRest(issue: Issue) {
  return {
    id: issue.id, node_id: nodeId('Issue', `${issue.id}`), number: issue.number, title: issue.title,
    body: issue.body, state: issue.state, user: issue.user, labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color, default: false })),
    comments: issue.comments, created_at: issue.created_at, updated_at: issue.updated_at, closed_at: issue.closed_at,
    html_url: '', url: '', repository_url: '', events_url: '', labels_url: '', comments_url: '', author_association: 'OWNER',
  };
}
function prToRest(pr: PullRequest) {
  return {
    id: pr.id, node_id: nodeId('PullRequest', `${pr.id}`), number: pr.number, title: pr.title, body: pr.body,
    state: pr.state === 'open' ? 'open' : 'closed', merged: pr.merged, mergeable: pr.mergeable,
    merged_at: pr.merged_at, merge_commit_sha: pr.merge_commit_sha,
    head: pr.head, base: pr.base, user: pr.user,
    created_at: pr.created_at, updated_at: pr.updated_at, closed_at: pr.state === 'open' ? null : (pr.merged_at ?? pr.updated_at),
    draft: false, commits_url: '', files_url: '', review_comments_url: '', comments_url: '', statuses_url: '',
    requested_reviewers: [], labels: [],
  };
}
async function parseJsonBody(req: IncomingMessage): Promise<{ ok: true; body: any } | { ok: false }> {
  const raw = await readBody(req);
  const text = raw.toString('utf8');
  if (text.trim() === '') return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && /^Bearer \S+$/i.test(header);
}
function viewerRepos(): Repository[] {
  return [...store.repos.values()].filter((repo) => repo.owner.login.toLowerCase() === VIEWER.toLowerCase())
    .sort((a, b) => a.id - b.id);
}
function contentFileJson(repo: Repository, path: string, sha: string, size: number) {
  const obj = repo.objects.get(sha);
  return {
    name: path.split('/').pop(), path,
    sha, size,
    type: 'file',
    content: obj ? obj.content.toString('base64') : '',
    encoding: 'base64',
    url: `/api/v3/repos/${repo.full_name}/contents/${path}`,
    git_url: '', html_url: '', download_url: '',
    _links: {},
  };
}
function contentsEntry(repo: Repository, prefix: string, name: string, sha: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  const isTree = obj?.type === 'tree';
  const path = prefix + name;
  return {
    name, path, sha,
    size: isTree ? 0 : (obj ? obj.content.length : 0),
    type: isTree ? 'dir' : 'file',
    url: `/api/v3/repos/${repo.full_name}/contents/${path}`,
    git_url: '', html_url: '', download_url: null,
    _links: {},
  };
}
function pullFiles(repo: Repository, pr: PullRequest): PullRequestFile[] {
  const baseFlat = pr.base.sha ? flattenTree(repo, commitTree(repo, pr.base.sha)) : new Map();
  const headFlat = pr.head.sha ? flattenTree(repo, commitTree(repo, pr.head.sha)) : new Map();
  const files: PullRequestFile[] = [];
  for (const [path, entry] of headFlat) {
    const before = baseFlat.get(path);
    if (before && before.sha === entry.sha) continue;
    const obj = repo.objects.get(entry.sha);
    const oldObj = before ? repo.objects.get(before.sha) : null;
    const additions = obj ? obj.content.toString('utf8').split('\n').filter((l) => l.length > 0).length : 0;
    const deletions = oldObj ? oldObj.content.toString('utf8').split('\n').filter((l) => l.length > 0).length : 0;
    files.push({
      filename: path,
      status: before ? 'modified' : 'added',
      additions: Math.max(additions, 1),
      deletions: before ? deletions : 0,
      changes: Math.max(additions, 1) + (before ? deletions : 0),
    });
  }
  for (const path of baseFlat.keys()) {
    if (!headFlat.has(path)) files.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
  }
  return files;
}
/** Squash-merge a pull request onto its base branch; returns null detail on conflict. */
function mergePull(repo: Repository, pr: PullRequest): { ok: true; sha: string } | { ok: false; detail: string } {
  if (pr.merged) return { ok: false, detail: 'Pull Request already merged' };
  const baseTip = tipOf(repo, pr.base.ref);
  if (!baseTip) return { ok: false, detail: 'the base branch is gone' };
  const baseAtPr = flattenTree(repo, commitTree(repo, pr.base.sha));
  const headFlat = flattenTree(repo, commitTree(repo, pr.head.sha));
  const current = flattenTree(repo, commitTree(repo, baseTip));
  const merged: Flat = new Map(current);
  for (const [path, entry] of headFlat) {
    const atPr = baseAtPr.get(path);
    if (!atPr || atPr.sha === entry.sha) {
      merged.set(path, entry);
      continue;
    }
    const now = current.get(path);
    if (now && now.sha !== atPr.sha && now.sha !== entry.sha) {
      return { ok: false, detail: 'Pull Request is not mergeable: a conflicting change landed on the base branch' };
    }
    merged.set(path, entry);
  }
  for (const path of baseAtPr.keys()) {
    if (!headFlat.has(path)) {
      const atPr = baseAtPr.get(path)!;
      const now = current.get(path);
      if (now && now.sha !== atPr.sha) {
        // both removed/changed: only conflict if the base changed it after the PR base
        if (now.sha !== atPr.sha) continue;
      }
      merged.delete(path);
    }
  }
  const treeSha = buildTree(repo, merged);
  const message = `Merge pull request #${pr.number} from ${pr.head.ref}\n\n${pr.title}\n`;
  const commitSha = makeCommit(repo, message, [baseTip], treeSha);
  repo.refs.set(`refs/heads/${pr.base.ref}`, commitSha);
  repo.refs.set('HEAD', commitSha);
  pr.merged = true;
  pr.state = 'closed';
  pr.merged_at = FIXED_DATE;
  pr.merge_commit_sha = commitSha;
  return { ok: true, sha: commitSha };
}

async function handleRestRequest(req: IncomingMessage, res: ServerResponse, path: string, method: string, parsedUrl: URL): Promise<void> {
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const q = parsedUrl.searchParams;

  if (path === '/api/v3/' || path === '/api/v3') {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      user_repositories_url: '/api/v3/user/repos{?per_page,page}',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      meta_url: '/api/v3/meta',
      code_search_url: '',
      issue_search_url: '',
      graphql_url: '/api/graphql',
    }, { 'x-oauth-scopes': 'repo, workflow, write:packages, read:user' });
    return;
  }
  if (path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '3.6.0-makefun-forge-1.0', verifiable_password_authentication: false });
    return;
  }
  if (path === '/api/v3/user') {
    sendJson(res, 200, {
      login: VIEWER, id: 1, node_id: nodeId('User', '1'), type: 'User',
      name: 'Ada Daiversen', created_at: FIXED_DATE, avatar_url: '', url: `/api/v3/users/${VIEWER}`,
    });
    return;
  }
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, parseInt(q.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
      const all = viewerRepos();
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        headers.link = `<${`/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`}>; rel="next", <${`/api/v3/user/repos?per_page=${perPage}&page=1`}>; rel="first", <${`/api/v3/user/repos?per_page=${perPage}&page=${Math.ceil(all.length / perPage)}`}>; rel="last"`;
      }
      sendJson(res, 200, slice.map(repoToRest), headers);
      return;
    }
    if (method === 'POST') {
      const parsed = await parseJsonBody(req);
      if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
      const body = parsed.body;
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) { sendJson(res, 422, { message: 'Validation Failed: name is required' }); return; }
      if (store.getRepo(VIEWER, name)) {
        sendJson(res, 422, { message: `name already exists on this account: ${VIEWER}/${name}` });
        return;
      }
      const repo = store.ensureRepo(VIEWER, name, {
        private: body.private ?? false,
        description: typeof body.description === 'string' ? body.description : null,
      });
      if (typeof body.default_branch === 'string' && body.default_branch) repo.default_branch = body.default_branch;
      sendJson(res, 201, repoToRest(repo));
      return;
    }
  }

  const repoMatch = path.match(/^\/api\/v3\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(\/.*)?$/);
  if (repoMatch) {
    const owner = repoMatch[1];
    const repoName = repoMatch[2];
    const subPath = repoMatch[3] ?? '';
    const repo = store.getRepo(owner, repoName);
    if (!repo || repo.owner.login.toLowerCase() !== owner.toLowerCase()) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const fullNamePath = `/api/v3/repos/${repo.full_name}`;

    if (subPath === '' || subPath === '/') {
      if (method === 'GET') { sendJson(res, 200, repoToRest(repo)); return; }
      if (method === 'PATCH') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const body = parsed.body;
        if (typeof body.description === 'string' || body.description === null) repo.description = body.description;
        if (typeof body.name === 'string' && body.name) repo.name = body.name;
        if (typeof body.default_branch === 'string' && body.default_branch) repo.default_branch = body.default_branch;
        if (typeof body.private === 'boolean') repo.private = body.private;
        repo.updated_at = FIXED_DATE;
        sendJson(res, 200, repoToRest(repo));
        return;
      }
      if (method === 'DELETE') {
        store.repos.delete(`${repo.owner.login.toLowerCase()}/${repo.name.toLowerCase()}`);
        sendEmpty(res, 204);
        return;
      }
    }

    if (subPath === '/branches' && method === 'GET') {
      const branches = [];
      for (const [refName, sha] of repo.refs) {
        if (!refName.startsWith('refs/heads/')) continue;
        branches.push({
          name: refName.replace('refs/heads/', ''),
          commit: { sha, url: `${fullNamePath}/commits/${sha}` },
          protected: false,
        });
      }
      branches.sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, branches);
      return;
    }

    if (subPath === '/git/refs' && method === 'POST') {
      const parsed = await parseJsonBody(req);
      if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
      const body = parsed.body;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref || !/^[0-9a-f]{40}$/.test(sha)) { sendJson(res, 422, { message: 'Validation Failed: ref and sha are required' }); return; }
      if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Reference already exists' }); return; }
      repo.refs.set(ref, sha);
      if (ref.startsWith('refs/heads/')) repo.refs.delete('HEAD');
      sendJson(res, 201, { ref, node_id: nodeId('GitRef', ref), object: { sha, type: 'commit', url: `${fullNamePath}/git/commits/${sha}` }, url: `${fullNamePath}/git/${ref}` });
      return;
    }
    const refMatch = subPath.match(/^\/git\/refs\/heads\/([A-Za-z0-9._/-]+)$/);
    if (refMatch && method === 'GET') {
      const ref = `refs/heads/${refMatch[1]}`;
      const sha = repo.refs.get(ref);
      if (!sha) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, { ref, node_id: nodeId('GitRef', ref), object: { sha, type: 'commit', url: '' }, url: '' });
      return;
    }

    if (subPath.startsWith('/commits') && method === 'GET') {
      const refParam = q.get('sha');
      const tip = refParam ? resolveRef(repo, refParam) : tipOf(repo, repo.default_branch);
      if (!tip) { sendJson(res, 200, []); return; }
      const chain = commitChain(repo, tip);
      sendJson(res, 200, chain.map((sha) => {
        const obj = repo.objects.get(sha)!;
        const { message } = parseCommit(obj.content);
        return {
          sha,
          node_id: nodeId('Commit', sha),
          commit: {
            author: { name: 'makefun', email: 'forge@makefun.local', date: FIXED_DATE },
            committer: { name: 'makefun', email: 'forge@makefun.local', date: FIXED_DATE },
            message,
            tree: { sha: parseCommit(obj.content).tree, url: '' },
            url: '',
            verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
          },
          parents: parseCommit(obj.content).parents.map((p) => ({ sha: p, url: '' })),
          html_url: '', url: '',
        };
      }));
      return;
    }

    if (subPath.startsWith('/contents')) {
      const filePath = subPath.replace(/^\/contents\/?/, '');
      if (method === 'PUT') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const body = parsed.body;
        if (typeof body.content !== 'string') { sendJson(res, 422, { message: 'Validation Failed: content is required' }); return; }
        const fileContent = Buffer.from(body.content, 'base64');
        const branch = typeof body.branch === 'string' && body.branch ? body.branch : repo.default_branch;
        const tip = tipOf(repo, branch);
        if (!tip && body.sha) { sendJson(res, 409, { message: 'does not exist or the sha is stale' }); return; }
        if (tip) {
          const existing = flattenTree(repo, commitTree(repo, tip)).get(filePath);
          if (existing && typeof body.sha === 'string' && body.sha && body.sha !== existing.sha) {
            sendJson(res, 409, { message: 'does not have the last commit: the sha is stale' });
            return;
          }
        }
        const updates: Record<string, Buffer | null> = { [filePath]: fileContent };
        const { commitSha } = commitFiles(repo, typeof body.message === 'string' && body.message ? body.message : 'update file', tip ? [tip] : [], updates);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        repo.refs.set('HEAD', commitSha);
        repo.updated_at = FIXED_DATE;
        const blobSha = shaOf('blob', fileContent);
        const existed = Boolean(tip && flattenTree(repo, commitTree(repo, tip)).has(filePath));
        sendJson(res, existed ? 200 : 201, {
          content: {
            name: filePath.split('/').pop(), path: filePath,
            sha: blobSha, size: fileContent.length, type: 'file',
            encoding: 'base64',
            url: `${fullNamePath}/contents/${filePath}`,
            git_url: '', html_url: '', download_url: '', _links: {},
          },
          commit: {
            sha: commitSha, node_id: nodeId('Commit', commitSha),
            message: typeof body.message === 'string' && body.message ? body.message : 'update file',
            author: { name: 'makefun', email: 'forge@makefun.local', date: FIXED_DATE },
            committer: { name: 'makefun', email: 'forge@makefun.local', date: FIXED_DATE },
            html_url: '', url: '', tree: { sha: commitTree(repo, commitSha), url: '' },
            parents: tip ? [{ sha: tip, url: '' }] : [],
            verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
          },
        });
        return;
      }
      if (method === 'GET') {
        const ref = q.get('ref') ?? repo.default_branch;
        const tip = resolveRef(repo, ref);
        if (!tip) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const flat = flattenTree(repo, commitTree(repo, tip));
        if (filePath === '') {
          const entries = [...flat.keys()].filter((p) => !p.includes('/')).map((name) => contentsEntry(repo, '', name, flat.get(name)!.sha));
          sendJson(res, 200, entries);
          return;
        }
        const direct = flat.get(filePath);
        if (direct) {
          const obj = repo.objects.get(direct.sha);
          sendJson(res, 200, contentFileJson(repo, filePath, direct.sha, obj ? obj.content.length : 0));
          return;
        }
        const prefix = filePath.endsWith('/') ? filePath : filePath + '/';
        const children = [...flat.keys()].filter((p) => p.startsWith(prefix));
        if (children.length) {
          const dirs = new Set<string>();
          const files: string[] = [];
          for (const child of children) {
            const rest = child.slice(prefix.length);
            if (rest.includes('/')) dirs.add(rest.split('/')[0]);
            else files.push(rest);
          }
          const entries: Record<string, unknown>[] = [];
          for (const dir of [...dirs].sort()) entries.push({ ...contentsEntry(repo, prefix, dir, ''), type: 'dir' });
          for (const file of files.sort()) entries.push(contentsEntry(repo, prefix, file, flat.get(prefix + file)!.sha));
          sendJson(res, 200, entries);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'DELETE') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const body = parsed.body;
        const tip = tipOf(repo, repo.default_branch);
        if (!tip) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const existing = flattenTree(repo, commitTree(repo, tip)).get(filePath);
        if (!existing) { sendJson(res, 404, { message: 'Not Found' }); return; }
        if (typeof body.sha === 'string' && body.sha && body.sha !== existing.sha) {
          sendJson(res, 409, { message: 'does not have the last commit: the sha is stale' });
          return;
        }
        const { commitSha } = commitFiles(repo, typeof body.message === 'string' && body.message ? body.message : 'delete file', [tip], { [filePath]: null });
        repo.refs.set(`refs/heads/${repo.default_branch}`, commitSha);
        repo.refs.set('HEAD', commitSha);
        sendJson(res, 200, {
          content: null,
          commit: { sha: commitSha, node_id: nodeId('Commit', commitSha), message: typeof body.message === 'string' ? body.message : 'delete file', html_url: '', url: '', author: {}, committer: {} },
        });
        return;
      }
    }

    if (subPath.startsWith('/git/trees/') && method === 'GET') {
      const sha = subPath.slice('/git/trees/'.length);
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'tree') { sendJson(res, 404, { message: 'Not Found' }); return; }
      const flat = flattenTree(repo, sha);
      sendJson(res, 200, {
        sha, url: `${fullNamePath}/git/trees/${sha}`,
        tree: [...flat.entries()].map(([p, v]) => ({ path: p, mode: v.mode, type: 'blob', sha: v.sha, size: repo.objects.get(v.sha)?.content.length ?? 0, url: '' })),
        truncated: false,
      });
      return;
    }

    if (subPath === '/labels') {
      if (method === 'GET') { sendJson(res, 200, repo.labels); return; }
      if (method === 'POST') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const body = parsed.body;
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) { sendJson(res, 422, { message: 'Validation Failed: name is required' }); return; }
        const existing = repo.labels.find((l) => l.name === name);
        if (existing) { sendJson(res, 422, { message: 'Label already exists' }); return; }
        const label = { id: store.nextId++, name, color: typeof body.color === 'string' && body.color ? body.color : 'ededed' };
        repo.labels.push(label);
        sendJson(res, 201, { ...label, default: false, url: '', description: null });
        return;
      }
    }

    if (subPath === '/issues') {
      if (method === 'GET') {
        const state = q.get('state') ?? 'open';
        const sort = q.get('sort') ?? 'created';
        const direction = q.get('direction') ?? 'desc';
        const perPage = Math.max(1, Math.min(100, parseInt(q.get('per_page') ?? '30', 10) || 30));
        let list = [...repo.issues];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        } else if (sort === 'updated') {
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        sendJson(res, 200, list.slice(0, perPage).map(issueToRest));
        return;
      }
      if (method === 'POST') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const body = parsed.body;
        const title = typeof body.title === 'string' ? body.title : '';
        if (!title) { sendJson(res, 422, { message: 'Validation Failed: title is required' }); return; }
        const labelNames: string[] = Array.isArray(body.labels)
          ? body.labels.map((l: unknown) => (typeof l === 'string' ? l : (l && typeof l === 'object' && typeof (l as any).name === 'string' ? (l as any).name : ''))).filter(Boolean)
          : [];
        for (const name of labelNames) {
          if (!repo.labels.some((l) => l.name === name)) {
            sendJson(res, 422, { message: `Validation Failed: label ${JSON.stringify(name)} does not exist` });
            return;
          }
        }
        const issue: Issue = {
          id: store.nextId++, number: repo.issues.length + 1,
          title, body: typeof body.body === 'string' ? body.body : '', state: 'open',
          user: { login: VIEWER, id: 1 },
          labels: labelNames.map((name) => ({ ...repo.labels.find((l) => l.name === name)! })),
          comments: 0, created_at: FIXED_DATE, updated_at: FIXED_DATE, closed_at: null,
        };
        repo.issues.push(issue);
        sendJson(res, 201, issueToRest(issue));
        return;
      }
    }
    const issueMatch = subPath.match(/^\/issues\/([0-9]+)(\/comments)?$/);
    if (issueMatch) {
      const issue = repo.issues.find((i) => i.number === parseInt(issueMatch[1], 10));
      if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (issueMatch[2] === '/comments') {
        const comments = repo.issueComments.get(issue.number) ?? [];
        if (method === 'GET') { sendJson(res, 200, comments); return; }
        if (method === 'POST') {
          const parsed = await parseJsonBody(req);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
          const body = parsed.body;
          const comment: IssueComment = {
            id: repo.nextCommentId++, body: typeof body.body === 'string' ? body.body : '',
            user: { login: VIEWER, id: 1 }, created_at: FIXED_DATE, updated_at: FIXED_DATE,
          };
          comments.push(comment);
          repo.issueComments.set(issue.number, comments);
          issue.comments = comments.length;
          sendJson(res, 201, { ...comment, html_url: '', issue_url: '', url: '' });
          return;
        }
      }
      if (method === 'GET') { sendJson(res, 200, issueToRest(issue)); return; }
      if (method === 'PATCH') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const body = parsed.body;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string' || body.body === null) issue.body = typeof body.body === 'string' ? body.body : '';
        if (body.state === 'open' || body.state === 'closed') {
          issue.state = body.state;
          issue.closed_at = body.state === 'closed' ? FIXED_DATE : null;
        }
        issue.updated_at = FIXED_DATE;
        sendJson(res, 200, issueToRest(issue));
        return;
      }
    }

    if (subPath === '/pulls') {
      if (method === 'GET') {
        const state = q.get('state') ?? 'open';
        const perPage = Math.max(1, Math.min(100, parseInt(q.get('per_page') ?? '30', 10) || 30));
        let list = [...repo.pulls];
        if (state === 'open') list = list.filter((p) => p.state === 'open' && !p.merged);
        else if (state === 'closed') list = list.filter((p) => p.state !== 'open');
        list.sort((a, b) => b.number - a.number);
        sendJson(res, 200, list.slice(0, perPage).map(prToRest));
        return;
      }
      if (method === 'POST') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const body = parsed.body;
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : '';
        const headSha = tipOf(repo, head);
        const baseSha = tipOf(repo, base);
        if (!headSha || !baseSha) {
          sendJson(res, 422, { message: 'Validation Failed: head and base branches must exist on this repository' });
          return;
        }
        const pr: PullRequest = {
          id: store.nextId++, number: repo.pulls.length + 1,
          title: typeof body.title === 'string' ? body.title : '',
          body: typeof body.body === 'string' ? body.body : '',
          state: 'open',
          head: { ref: head, sha: headSha, repo: { full_name: repo.full_name } },
          base: { ref: base, sha: baseSha, repo: { full_name: repo.full_name } },
          user: { login: VIEWER, id: 1 },
          merged: false, mergeable: true, merged_at: null, merge_commit_sha: null,
          created_at: FIXED_DATE, updated_at: FIXED_DATE, base_tip: baseSha,
        };
        repo.pulls.push(pr);
        sendJson(res, 201, prToRest(pr));
        return;
      }
    }
    const prMatch = subPath.match(/^\/pulls\/([0-9]+)(\/files|\/comments|\/merge)?$/);
    if (prMatch) {
      const pr = repo.pulls.find((p) => p.number === parseInt(prMatch[1], 10));
      if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (prMatch[2] === '/files') {
        sendJson(res, 200, pullFiles(repo, pr));
        return;
      }
      if (prMatch[2] === '/comments') { sendJson(res, 200, []); return; }
      if (prMatch[2] === '/merge' && method === 'PUT') {
        const result = mergePull(repo, pr);
        if (!result.ok) {
          sendJson(res, pr.merged ? 405 : 405, { message: result.detail });
          return;
        }
        sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      if (method === 'GET') { sendJson(res, 200, prToRest(pr)); return; }
      if (method === 'PATCH') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const body = parsed.body;
        if (typeof body.title === 'string') pr.title = body.title;
        if (typeof body.body === 'string') pr.body = body.body;
        if (body.state === 'open' || body.state === 'closed') pr.state = body.state === 'closed' && !pr.merged ? 'closed' : pr.state;
        sendJson(res, 200, prToRest(pr));
        return;
      }
    }

    if (subPath === '/merges' && method === 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- GraphQL v4
interface Sel { alias: string; name: string; args: Record<string, unknown>; selections: Sel[] | null; fragmentOn: string | null }
interface Op { type: 'query' | 'mutation'; name: string; vars: Record<string, { type: string }>; selections: Sel[] }
function tokenizeGql(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '{' || c === '}' || c === '(' || c === ')' || c === ':' || c === ',' || c === '[' || c === ']' || c === '$' || c === '!' || c === '...') {
      if (c === '.') { tokens.push('...'); i += 3; continue; }
      tokens.push(c); i++; continue;
    }
    if (c === '"') {
      if (text.startsWith('"""', i)) {
        const end = text.indexOf('"""', i + 3);
        tokens.push(JSON.stringify(text.slice(i + 3, end < 0 ? text.length : end)));
        i = (end < 0 ? text.length : end + 3);
        continue;
      }
      let j = i + 1;
      let out = '"';
      while (j < text.length) {
        if (text[j] === '\\') { out += text[j] + text[j + 1]; j += 2; continue; }
        if (text[j] === '"') break;
        out += text[j]; j++;
      }
      tokens.push(out + '"');
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
    if (j === i) { i++; continue; }
    tokens.push(text.slice(i, j));
    i = j;
  }
  return tokens;
}
function parseGql(text: string): Op[] {
  const tokens = tokenizeGql(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t?: string): string => {
    const token = tokens[pos++];
    if (t !== undefined && token !== t) throw new Error(`parse: expected ${t}, got ${token}`);
    return token;
  };
  const parseValue = (vars: boolean): unknown => {
    const token = peek();
    if (token === '$') {
      eat('$');
      return { __var: eat() };
    }
    if (token === '[') {
      eat('[');
      const list: unknown[] = [];
      while (peek() !== ']') list.push(parseValue(vars));
      eat(']');
      return list;
    }
    if (token === '{') {
      eat('{');
      const obj: Record<string, unknown> = {};
      while (peek() !== '}') {
        const key = eat();
        eat(':');
        obj[key] = parseValue(vars);
      }
      eat('}');
      return obj;
    }
    eat();
    if (token.startsWith('"')) return JSON.parse(token);
    if (/^-?[0-9]+$/.test(token)) return parseInt(token, 10);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    return { __enum: token };
  };
  const parseSelections = (vars: boolean): Sel[] => {
    eat('{');
    const sels: Sel[] = [];
    while (peek() !== '}') {
      if (peek() === '...') {
        eat('...');
        eat('on');
        const on = eat();
        sels.push({ alias: '', name: '', args: {}, selections: parseSelections(vars), fragmentOn: on });
        continue;
      }
      let name = eat();
      let alias = name;
      if (peek() === ':') { eat(':'); name = eat(); }
      const args: Record<string, unknown> = {};
      if (peek() === '(') {
        eat('(');
        while (peek() !== ')') {
          const argName = eat();
          eat(':');
          args[argName] = parseValue(vars);
        }
        eat(')');
      }
      const labels: string[] = [];
      while (peek() === '!') eat('!');
      void labels;
      sels.push({ alias, name, args, selections: peek() === '{' ? parseSelections(vars) : null, fragmentOn: null });
    }
    eat('}');
    return sels;
  };
  const ops: Op[] = [];
  while (pos < tokens.length) {
    if (peek() === '{') {
      ops.push({ type: 'query', name: '', vars: {}, selections: parseSelections(true) });
      continue;
    }
    const kind = eat();
    const name = peek() && peek() !== '(' && peek() !== '{' ? eat() : '';
    const vars: Record<string, { type: string }> = {};
    if (peek() === '(') {
      eat('(');
      while (peek() !== ')') {
        eat('$');
        const varName = eat();
        eat(':');
        let type = eat();
        while (peek() === '!' || peek() === '[' || peek() === ']') { type += peek(); eat(); }
        vars[varName] = { type };
      }
      eat(')');
    }
    while (peek() === '@') { eat('@'); eat(); if (peek() === '(') { eat('('); let depth = 1; while (depth > 0 && pos < tokens.length) { const t = eat(); if (t === '(') depth++; if (t === ')') depth--; } } }
    ops.push({ type: kind === 'mutation' ? 'mutation' : 'query', name, vars, selections: parseSelections(true) });
  }
  return ops;
}
function resolveValue(value: unknown, vars: Record<string, unknown>): unknown {
  if (value && typeof value === 'object' && '__var' in (value as any)) {
    const name = (value as any).__var;
    return vars[name];
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, vars));
  if (value && typeof value === 'object' && '__enum' in (value as any)) return (value as any).__enum;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveValue(v, vars);
    return out;
  }
  return value;
}
const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'closedAt', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'body', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'url', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'url', 'ref', 'description'],
  SearchType: [],
};
const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};
interface GqlIssueRef { repo: Repository; issue: Issue }
interface GqlPrRef { repo: Repository; pr: PullRequest }
interface Connection { __t: 'connection'; nodes: unknown[]; next: boolean; endCursor: string }
function issueView(issue: GqlIssueRef) {
  return {
    __t: 'Issue',
    id: nodeId('Issue', `${issue.repo.full_name}#${issue.issue.number}`),
    number: issue.issue.number,
    title: issue.issue.title,
    state: issue.issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.issue.body,
  };
}
function prView(pr: GqlPrRef) {
  return {
    __t: 'PullRequest',
    id: nodeId('PullRequest', `${pr.repo.full_name}#${pr.pr.number}`),
    number: pr.pr.number,
    state: pr.pr.merged ? 'MERGED' : pr.pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.pr.merged,
    mergeable: pr.pr.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    headRefName: pr.pr.head.ref,
    baseRefName: pr.pr.base.ref,
    files: { __t: 'PRFileConnection', nodes: pullFiles(pr.repo, pr.pr).slice(0, 100).map((f) => ({ __t: 'PRFile', path: f.filename, additions: f.additions, deletions: f.deletions })) },
  };
}
function repoView(repo: Repository) {
  return {
    __t: 'Repository',
    id: nodeId('Repository', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.full_name,
    owner: { __t: 'User', login: repo.owner.login },
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.default_branch}`) ? { __t: 'Ref', name: repo.default_branch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    issues: (args: Record<string, unknown>) => {
      const first = typeof args.first === 'number' ? args.first : 100;
      const after = typeof args.after === 'string' ? parseInt(Buffer.from(args.after, 'base64url').toString('utf8'), 10) : null;
      const states = Array.isArray(args.states) && args.states.length ? (args.states as string[]).map((s) => String(s).toLowerCase()) : null;
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      let list = [...repo.issues];
      if (states) list = list.filter((i) => states.includes(i.state));
      if (orderBy?.direction === 'ASC') list.sort((a, b) => a.number - b.number);
      else if (orderBy?.direction === 'DESC') list.sort((a, b) => b.number - a.number);
      else list.sort((a, b) => a.number - b.number);
      let startIndex = 0;
      if (after !== null && Number.isFinite(after)) {
        startIndex = list.findIndex((i) => i.number > after);
        if (startIndex < 0) startIndex = list.length;
      }
      const page = list.slice(startIndex, startIndex + first);
      const hasNext = startIndex + first < list.length;
      const endCursor = page.length ? Buffer.from(String(page[page.length - 1].number), 'utf8').toString('base64url') : '';
      return {
        __t: 'IssueConnection',
        nodes: page.map((i) => issueView({ repo, issue: i })),
        next: hasNext,
        endCursor,
      } satisfies Connection as unknown as Connection;
    },
    issue: (args: Record<string, unknown>) => {
      const issue = repo.issues.find((i) => i.number === args.number);
      return issue ? issueView({ repo, issue }) : null;
    },
    pullRequest: (args: Record<string, unknown>) => {
      const pr = repo.pulls.find((p) => p.number === args.number);
      return pr ? prView({ repo, pr }) : null;
    },
    pullRequests: (args: Record<string, unknown>) => {
      const first = typeof args.first === 'number' ? args.first : 100;
      const list = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
      return { __t: 'PullRequestConnection', nodes: list.map((p) => prView({ repo, pr: p })), next: false, endCursor: '' };
    },
  };
}
function resolveSelections(target: unknown, typeName: string, selections: Sel[], vars: Record<string, unknown>, errors: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.fragmentOn) {
      if (sel.fragmentOn !== typeName && !(typeName === 'Repository' && sel.fragmentOn === 'Node')) continue;
      Object.assign(out, resolveSelections(target, sel.fragmentOn, sel.selections ?? [], vars, errors));
      continue;
    }
    if (sel.name.startsWith('__')) {
      out[sel.alias || sel.name] = sel.name === '__typename' ? typeName : null;
      continue;
    }
    const handler = (SCHEMA as Record<string, Record<string, unknown>>)[typeName]?.[sel.name];
    if (handler === undefined) {
      errors.push(`Field '${sel.name}' does not exist on type '${typeName}'`);
      out[sel.alias || sel.name] = null;
      continue;
    }
    let value: unknown;
    if (typeof handler === 'function') value = (handler as (t: unknown, a: Record<string, unknown>) => unknown)(target, sel.args);
    else value = handler;
    value = resolveValue(value, vars);
    if (value && typeof value === 'object' && '__t' in (value as any)) {
      const v = value as { __t: string };
      if (v.__t === 'connection') {
        const conn = value as unknown as Connection;
        const connOut: Record<string, unknown> = {};
        for (const sub of sel.selections ?? []) {
          if (sub.name === 'nodes') connOut[sub.alias || 'nodes'] = (conn.nodes as unknown[]).map((node) => node ? resolveSelections(node, (node as any).__t, sub.selections ?? [], vars, errors) : null);
          else if (sub.name === 'pageInfo') {
            const pageInfo = { hasNextPage: conn.next, endCursor: conn.endCursor };
            const piOut: Record<string, unknown> = {};
            for (const sub2 of sub.selections ?? []) piOut[sub2.name] = (pageInfo as any)[sub2.name];
            connOut[sub.alias || 'pageInfo'] = piOut;
          } else connOut[sub.name] = null;
        }
        out[sel.alias || sel.name] = connOut;
        continue;
      }
      out[sel.alias || sel.name] = resolveSelections(value, v.__t, sel.selections ?? [], vars, errors);
      continue;
    }
    if (Array.isArray(value)) {
      const itemType = value.length && value[0] && typeof value[0] === 'object' && '__t' in (value[0] as any) ? (value[0] as any).__t : null;
      out[sel.alias || sel.name] = itemType
        ? value.map((item) => item ? resolveSelections(item, itemType, sel.selections ?? [], vars, errors) : null)
        : value;
      continue;
    }
    out[sel.alias || sel.name] = value;
  }
  return out;
}
const SCHEMA: Record<string, Record<string, unknown>> = {
  Query: {
    viewer: () => ({ __t: 'Viewer', login: VIEWER }),
    repository: (_t: unknown, args: Record<string, unknown>) => {
      const repo = typeof args.owner === 'string' && typeof args.name === 'string'
        ? store.getRepo(String(args.owner), String(args.name))
        : undefined;
      if (!repo || repo.owner.login.toLowerCase() !== String(args.owner).toLowerCase()) return null;
      return repoView(repo);
    },
    node: (_t: unknown, args: Record<string, unknown>) => {
      const key = nodeKey(String(args.id));
      if (!key) return null;
      if (key.kind === 'Repository') {
        const repo = [...store.repos.values()].find((r) => String(r.id) === key.key);
        return repo ? repoView(repo) : null;
      }
      return null;
    },
    __type: (_t: unknown, args: Record<string, unknown>) => {
      const name = String(args.name);
      if (INTROSPECTION_FIELDS[name] !== undefined) {
        return { __t: '__Type', fields: INTROSPECTION_FIELDS[name].map((f) => ({ name: f })), enumValues: null };
      }
      if (INTROSPECTION_ENUMS[name] !== undefined) {
        return { __t: '__Type', fields: null, enumValues: INTROSPECTION_ENUMS[name].map((e) => ({ name: e })) };
      }
      return null;
    },
  },
  Viewer: { login: VIEWER },
  User: { login: VIEWER },
  Ref: { name: (t: any) => t.name },
};
function performGqlOperation(op: Op, variables: Record<string, unknown>, errors: string[]): { data: Record<string, unknown> | null } {
  const vars: Record<string, unknown> = {};
  for (const name of Object.keys(op.vars)) vars[name] = variables[name];
  if (op.type === 'mutation') {
    const out = runMutation(op, vars, errors);
    return { data: out };
  }
  const data = resolveSelections({ __t: 'Query' }, 'Query', op.selections, vars, errors);
  return { data };
}
function runMutation(op: Op, vars: Record<string, unknown>, errors: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.fragmentOn) continue;
    const input = (resolveValue(sel.args.input ?? {}, vars) ?? {}) as Record<string, unknown>;
    const wrap = (value: Record<string, unknown> | null): Record<string, unknown> => {
      const sub: Record<string, unknown> = {};
      for (const child of sel.selections ?? []) {
        if (child.fragmentOn) continue;
        const inner = child.name === 'pullRequest' ? value : child.name === 'issue' ? value : child.name === 'commentEdge' ? value : null;
        if (inner === null) { sub[child.alias || child.name] = child.name === 'commentEdge' ? { node: null } : null; continue; }
        if (child.name === 'commentEdge') {
          const nodeSel = (child.selections ?? []).find((s) => s.name === 'node');
          sub[child.alias || 'commentEdge'] = {
            node: nodeSel ? resolveSelections(value, child.name === 'commentEdge' ? (value as any).__t : 'Issue', nodeSel.selections ?? [], vars, errors) : null,
          };
          continue;
        }
        const nodeType = (value as any).__t;
        sub[child.alias || child.name] = value === null ? null : resolveSelections(value, nodeType, child.selections ?? [], vars, errors);
      }
      return sub;
    };
    if (sel.name === 'createIssue') {
      const key = nodeKey(String(input.repositoryId ?? ''));
      const repo = key?.kind === 'Repository' ? [...store.repos.values()].find((r) => String(r.id) === key.key) : undefined;
      if (!repo) { errors.push('Could not resolve to a repository with the global id'); out[sel.alias || sel.name] = { issue: null }; continue; }
      const issue: Issue = {
        id: store.nextId++, number: repo.issues.length + 1,
        title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open',
        user: { login: VIEWER, id: 1 }, labels: [], comments: 0,
        created_at: FIXED_DATE, updated_at: FIXED_DATE, closed_at: null,
      };
      repo.issues.push(issue);
      out[sel.alias || sel.name] = wrap({ ...issueView({ repo, issue }), __t: 'Issue' } as any);
      continue;
    }
    if (sel.name === 'closeIssue') {
      const key = nodeKey(String(input.issueId ?? ''));
      let found: GqlIssueRef | null = null;
      if (key?.kind === 'Issue') {
        for (const repo of store.repos.values()) {
          const issue = repo.issues.find((i) => nodeId('Issue', `${repo.full_name}#${i.number}`) === input.issueId);
          if (issue) { issue.state = 'closed'; issue.closed_at = FIXED_DATE; found = { repo, issue }; break; }
        }
      }
      out[sel.alias || sel.name] = found ? wrap({ ...issueView(found), __t: 'Issue' } as any) : wrap(null as any);
      continue;
    }
    if (sel.name === 'createPullRequest') {
      const key = nodeKey(String(input.repositoryId ?? ''));
      const repo = key?.kind === 'Repository' ? [...store.repos.values()].find((r) => String(r.id) === key.key) : undefined;
      if (!repo) { errors.push('Could not resolve to a repository with the global id'); out[sel.alias || sel.name] = { pullRequest: null }; continue; }
      const head = String(input.headRefName ?? ''), base = String(input.baseRefName ?? '');
      const headSha = tipOf(repo, head), baseSha = tipOf(repo, base);
      if (!headSha || !baseSha) {
        errors.push(`Head branch ${head} or base branch ${base} does not exist`);
        out[sel.alias || sel.name] = { pullRequest: null };
        continue;
      }
      const pr: PullRequest = {
        id: store.nextId++, number: repo.pulls.length + 1,
        title: String(input.title ?? ''), body: '', state: 'open',
        head: { ref: head, sha: headSha, repo: { full_name: repo.full_name } },
        base: { ref: base, sha: baseSha, repo: { full_name: repo.full_name } },
        user: { login: VIEWER, id: 1 }, merged: false, mergeable: true, merged_at: null,
        merge_commit_sha: null, created_at: FIXED_DATE, updated_at: FIXED_DATE, base_tip: baseSha,
      };
      repo.pulls.push(pr);
      out[sel.alias || sel.name] = wrap(prView({ repo, pr }) as any);
      continue;
    }
    if (sel.name === 'mergePullRequest') {
      let done: GqlPrRef | null = null;
      for (const repo of store.repos.values()) {
        const pr = repo.pulls.find((p) => nodeId('PullRequest', `${repo.full_name}#${p.number}`) === input.pullRequestId);
        if (pr) { done = { repo, pr }; break; }
      }
      if (!done || done.pr.merged) {
        if (done && done.pr.merged) { /* already merged: report current state */ }
        else { errors.push('Could not resolve to a pull request with the global id'); out[sel.alias || sel.name] = { pullRequest: null }; continue; }
      } else {
        const result = mergePull(done.repo, done.pr);
        if (!result.ok) { errors.push(result.detail); out[sel.alias || sel.name] = { pullRequest: null }; continue; }
      }
      out[sel.alias || sel.name] = wrap(prView(done) as any);
      continue;
    }
    if (sel.name === 'addComment') {
      let created: { repo: Repository; comment: IssueComment } | null = null;
      for (const repo of store.repos.values()) {
        for (const issue of repo.issues) {
          if (nodeId('Issue', `${repo.full_name}#${issue.number}`) === input.subjectId) {
            const comments = repo.issueComments.get(issue.number) ?? [];
            const comment: IssueComment = {
              id: repo.nextCommentId++, body: String(input.body ?? ''),
              user: { login: VIEWER, id: 1 }, created_at: FIXED_DATE, updated_at: FIXED_DATE,
            };
            comments.push(comment);
            repo.issueComments.set(issue.number, comments);
            issue.comments = comments.length;
            created = { repo, comment };
            break;
          }
        }
        if (created) break;
      }
      const commentNode = created ? { __t: 'IssueComment', id: `IC_${created.comment.id}`, body: created.comment.body } : null;
      out[sel.alias || sel.name] = wrap(commentNode as any);
      continue;
    }
    errors.push(`Unknown mutation '${sel.name}'`);
    out[sel.alias || sel.name] = null;
  }
  return out;
}
async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const runOne = (entry: any): unknown => {
    const query = typeof entry?.query === 'string' ? entry.query : '';
    const variables = (entry?.variables && typeof entry.variables === 'object' ? entry.variables : {}) as Record<string, unknown>;
    const errors: string[] = [];
    try {
      const ops = parseGql(query);
      let op = ops[0];
      if (typeof entry?.operationName === 'string' && entry.operationName) {
        op = ops.find((candidate) => candidate.name === entry.operationName) ?? op;
      }
      if (!op) return { errors: [{ message: 'No operation found' }] };
      const { data } = performGqlOperation(op, variables, errors);
      return errors.length ? { data, errors: errors.map((message) => ({ message })) } : { data };
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(body));
}

// ---------------------------------------------------------------- MCP
const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'github-mcp-server', version: '1.0.0' };
const MCP_TOOLS: Record<string, { description: string; required: string[]; properties: string[] }> = {
  create_repo: { description: 'Create a new GitHub repository in the authenticated account', required: ['name'], properties: ['name', 'description', 'private'] },
  get_repo: { description: 'Get details for one repository', required: ['owner', 'repo'], properties: ['owner', 'repo'] },
  create_issue: { description: 'Create a new issue in a repository', required: ['owner', 'repo', 'title'], properties: ['owner', 'repo', 'title', 'body'] },
  list_issues: { description: 'List issues in a repository', required: ['owner', 'repo'], properties: ['owner', 'repo', 'state'] },
  create_pull_request: { description: 'Create a new pull request in a repository', required: ['owner', 'repo', 'title', 'head', 'base'], properties: ['owner', 'repo', 'title', 'head', 'base'] },
  merge_pull_request: { description: 'Merge a pull request (squash)', required: ['owner', 'repo', 'pull_number'], properties: ['owner', 'repo', 'pull_number'] },
};
function mcpToolsList(): unknown[] {
  return Object.entries(MCP_TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(tool.properties.map((p) => [p, { type: ['pull_number', 'private'].includes(p) ? ['number', 'boolean'] : 'string', description: p }])) as Record<string, unknown>,
      required: tool.required,
    },
  }));
}
function mcpJsonRpc(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
function mcpToolResult(text: string, isError = false) {
  return { content: [{ type: 'text', text }], isError: isError || undefined };
}
function runMcpTool(name: string, args: Record<string, unknown>): { result: unknown } | { error: { code: number; message: string } } {
  const tool = MCP_TOOLS[name];
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  const str = (key: string): string => (typeof args[key] === 'string' ? args[key] as string : '');
  const num = (key: string): number => (typeof args[key] === 'number' ? args[key] as number : Number(args[key]));
  const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length) return { error: { code: -32602, message: `Missing required arguments: ${missing.join(', ')}` } };
  const owner = str('owner') || VIEWER;
  let repoName = str('repo');
  if (!repoName && typeof args.full_name === 'string' && args.full_name.includes('/')) repoName = args.full_name.split('/')[1];
  switch (name) {
    case 'create_repo': {
      const name2 = str('name');
      if (!name2) return { error: { code: -32602, message: 'Missing required arguments: name' } };
      if (store.getRepo(VIEWER, name2)) return mcpToolResult(JSON.stringify({ error: 'name already exists on this account' }), true);
      const repo = store.ensureRepo(VIEWER, name2, { private: args.private === undefined ? true : Boolean(args.private), description: str('description') || null });
      return mcpToolResult(JSON.stringify({ ...repoToRest(repo), default_branch: repo.default_branch }));
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return mcpToolResult(JSON.stringify({ error: 'Not Found' }), true);
      return mcpToolResult(JSON.stringify({ ...repoToRest(repo), full_name: repo.full_name, default_branch: repo.default_branch }));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return mcpToolResult(JSON.stringify({ error: 'Not Found' }), true);
      const issue: Issue = {
        id: store.nextId++, number: repo.issues.length + 1,
        title: str('title'), body: str('body'), state: 'open',
        user: { login: VIEWER, id: 1 }, labels: [], comments: 0,
        created_at: FIXED_DATE, updated_at: FIXED_DATE, closed_at: null,
      };
      repo.issues.push(issue);
      return mcpToolResult(JSON.stringify(issueToRest(issue)));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return mcpToolResult(JSON.stringify({ error: 'Not Found' }), true);
      const state = str('state') || 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return mcpToolResult(JSON.stringify(list.map(issueToRest)));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return mcpToolResult(JSON.stringify({ error: 'Not Found' }), true);
      const head = str('head'), base = str('base');
      const headSha = tipOf(repo, head), baseSha = tipOf(repo, base);
      if (!headSha || !baseSha) return mcpToolResult(JSON.stringify({ error: 'head and base branches must exist' }), true);
      const pr: PullRequest = {
        id: store.nextId++, number: repo.pulls.length + 1,
        title: str('title'), body: str('body'), state: 'open',
        head: { ref: head, sha: headSha, repo: { full_name: repo.full_name } },
        base: { ref: base, sha: baseSha, repo: { full_name: repo.full_name } },
        user: { login: VIEWER, id: 1 }, merged: false, mergeable: true, merged_at: null,
        merge_commit_sha: null, created_at: FIXED_DATE, updated_at: FIXED_DATE, base_tip: baseSha,
      };
      repo.pulls.push(pr);
      return mcpToolResult(JSON.stringify({ ...prToRest(pr), head_url: '', base_url: '' }));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return mcpToolResult(JSON.stringify({ error: 'Not Found' }), true);
      const pr = repo.pulls.find((p) => p.number === num('pull_number'));
      if (!pr) return mcpToolResult(JSON.stringify({ error: 'Not Found' }), true);
      const result = mergePull(repo, pr);
      if (!result.ok) return mcpToolResult(JSON.stringify({ error: result.detail }), true);
      return mcpToolResult(JSON.stringify({ sha: result.sha, merged: true, message: 'Pull Request successfully merged' }));
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}
async function handleMCP(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) {
    mcpJsonRpc(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: MCP tools require an Authorization header' } });
    return;
  }
  if (req.method === 'DELETE') {
    sendEmpty(res, 204);
    return;
  }
  const raw = await readBody(req);
  let body: any;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    mcpJsonRpc(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the request body is not valid JSON' } });
    return;
  }
  const respond = (id: unknown, payload: unknown) => mcpJsonRpc(res, 200, { jsonrpc: '2.0', id, result: payload });
  const respondError = (id: unknown, code: number, message: string, status = 200) => mcpJsonRpc(res, status, { jsonrpc: '2.0', id, error: { code, message } });
  const handle = (entry: any, isNotification: boolean): unknown => {
    const method = typeof entry?.method === 'string' ? entry.method : '';
    if (method === 'server/discover') {
      return {
        _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_REVISIONS[0], serverInfo: MCP_SERVER_INFO },
        serverInfo: MCP_SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
        supportedVersions: MCP_REVISIONS,
        instructions: 'GitHub-compatible forge tools over REST-backed storage.',
      };
    }
    if (method === 'initialize') {
      const requested = typeof entry?.params?.protocolVersion === 'string' ? entry.params.protocolVersion : '';
      const version = MCP_REVISIONS.includes(requested) ? requested : MCP_REVISIONS[0];
      return {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        supportedVersions: MCP_REVISIONS,
      };
    }
    if (method === 'notifications/initialized' || isNotification) return undefined;
    if (method === 'tools/list') return { tools: mcpToolsList() };
    if (method === 'tools/call') {
      const name = typeof entry?.params?.name === 'string' ? entry.params.name : '';
      const args = entry?.params?.arguments && typeof entry.params.arguments === 'object' ? entry.params.arguments : {};
      const outcome = runMcpTool(name, args);
      if ('error' in outcome) return undefined; // handled by caller
      return outcome.result;
    }
    if (method === 'ping') return {};
    return { __unknown: method };
  };
  // notifications (no id): acknowledge without a body
  if (body && typeof body === 'object' && !Array.isArray(body) && body.id === undefined) {
    res.writeHead(202, { 'content-type': 'text/plain; charset=utf-8' });
    res.end();
    return;
  }
  if (Array.isArray(body)) {
    const replies: unknown[] = [];
    for (const entry of body) {
      const result = handle(entry, false);
      if (result === undefined) {
        const outcome = runMcpTool(String(entry?.params?.name ?? ''), entry?.params?.arguments ?? {});
        if ('error' in outcome) replies.push({ jsonrpc: '2.0', id: entry?.id ?? null, error: outcome.error });
        else replies.push({ jsonrpc: '2.0', id: entry?.id ?? null, result: outcome.result });
        continue;
      }
      if (result && typeof result === 'object' && '__unknown' in result) {
        replies.push({ jsonrpc: '2.0', id: entry?.id ?? null, error: { code: -32601, message: `Method not found: ${(result as any).__unknown}` } });
        continue;
      }
      replies.push({ jsonrpc: '2.0', id: entry?.id ?? null, result });
    }
    mcpJsonRpc(res, 200, replies);
    return;
  }
  const result = handle(body, false);
  if (result === undefined) {
    const outcome = runMcpTool(String(body?.params?.name ?? ''), body?.params?.arguments ?? {});
    if ('error' in outcome) { respondError(body?.id ?? null, outcome.error.code, outcome.error.message); return; }
    respond(body?.id ?? null, outcome.result);
    return;
  }
  if (result && typeof result === 'object' && '__unknown' in result) {
    respondError(body?.id ?? null, -32601, `Method not found: ${(result as any).__unknown}`);
    return;
  }
  respond(body?.id ?? null, result);
}

// ---------------------------------------------------------------- server
export function createApp(): Server {
  const server = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = parsedUrl.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    try {
      if (path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      const gitMatch = path.match(/^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\.git(\/.*)?$/);
      if (gitMatch) {
        await handleGitRequest(req, res, gitMatch[1], gitMatch[2], gitMatch[3] ?? '/', parsedUrl);
        return;
      }
      if (path === '/api/graphql' || path === '/api/graphql/') {
        await handleGraphQL(req, res);
        return;
      }
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        await handleMCP(req, res);
        return;
      }
      if (path.startsWith('/api/')) {
        await handleRestRequest(req, res, path, method, parsedUrl);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
      } catch {
        res.end();
      }
    }
  });
  return server;
}
