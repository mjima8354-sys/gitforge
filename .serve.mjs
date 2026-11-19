import { createApp } from '/root/makefun/build/github-core-clone-01/app.ts';
const s = createApp();
await new Promise((r) => s.listen(8791, '127.0.0.1', r));
console.log('listening 8791');
setInterval(() => {}, 1 << 30);
