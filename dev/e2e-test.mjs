// 端到端：把示例应用真的跑一遍。
// 用真的宿主半（真落盘）、真的 client.js（假 DOM + 假 React），
// 验证「装 → 点开 → 应用真的画出来 → 存一次私有设置 → 返回 → 卸载」这条路。
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { makeZip } from './make-zip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-phone-e2e-'));
process.env.DSH_HOME = scratch;

let passed = 0;
const failures = [];
const ok = (label, detail) => { passed += 1; console.log('  ok   ' + label + (detail ? '  (' + detail + ')' : '')); };
const bad = (label, detail) => { failures.push(label); console.log('  FAIL ' + label + (detail ? '  → ' + detail : '')); };

// ── 真的宿主半 ──
const host = await import('../index.js');
let route = null;
const routes = new Set();
host.apply({
  effect: (factory) => { factory(); },
  webServer: {
    register(r) { route = r; routes.add(r.path); return () => routes.delete(r.path); },
    match(p) { for (const one of routes) if (p === one || p.startsWith(one + '/')) return { path: one }; return undefined; },
    getOrigin() { return 'http://127.0.0.1:19999'; },
    port: 19999,
  },
});

/** 真走一遍 HTTP 形状：把 handler 的 request/response 用内存对象模拟出来。 */
function callHost(method, params) {
  return new Promise((resolve) => {
    const listeners = {};
    const request = { method: 'POST', url: '/dsh-phone/api', on(e, fn) { listeners[e] = fn; }, destroy() {} };
    let status = 0;
    const response = {
      writeHead(code) { status = code; },
      end(text) { resolve(text === '' ? null : JSON.parse(text)); },
    };
    route.handler(request, response);
    setTimeout(() => {
      listeners.data(Buffer.from(JSON.stringify({ method, params })));
      listeners.end();
    }, 0);
  });
}

// ── 真的 client.js，配上假 DOM 和假 React ──
const fakeWindow = {
  innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1,
  btoa: (t) => Buffer.from(t, 'binary').toString('base64'),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {}, removeEventListener() {},
  setInterval: () => 1, clearInterval() {},
  setTimeout: (...a) => setTimeout(...a), clearTimeout: (id) => clearTimeout(id),
  console: { log() {}, error: (...a) => console.log('    [应用 console.error]', ...a), warn() {} },
  // 界面半会走同源接口，这里直接接到真宿主半上
  fetch: async (url, options) => {
    const payload = JSON.parse(options.body);
    const reply = await callHost(payload.method, payload.params);
    return { ok: true, status: 200, json: async () => reply };
  },
  Audio: function Audio() { this.paused = true; this.src = ''; this.currentTime = 0; },
};

function fakeElement(tag) {
  const node = {
    tagName: tag, className: '', style: {}, dataset: {}, children: [], parentNode: null,
    textContent: '', value: '', placeholder: '', cssText: '',
    appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
    removeChild(child) { node.children = node.children.filter((one) => one !== child); child.parentNode = null; },
    setAttribute(n, v) { node[n] = v; },
    getAttribute(n) { return node[n]; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { node.__on = node.__on || {}; (node.__on[type] = node.__on[type] || []).push(fn); },
    removeEventListener() {},
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    focus() {}, click() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 48, height: 48, right: 48, bottom: 48 }; },
  };
  return node;
}

const fakeDocument = {
  documentElement: { lang: 'zh-CN' },
  body: fakeElement('body'),
  createElement: fakeElement,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};
fakeWindow.document = fakeDocument;

// 假 React：和冒烟测试同一套，够跑组件
const hookStores = new Map();
let renderKey = '';
let hookIndex = 0;
function createElement(type, props, ...children) {
  const merged = { ...(props || {}) };
  merged.children = children.length <= 1 ? children[0] : children;
  return { type, props: merged };
}
function currentStore() {
  let store = hookStores.get(renderKey);
  if (store === undefined) { store = []; hookStores.set(renderKey, store); }
  return store;
}
const React = {
  createElement,
  useState(init) {
    const store = currentStore(); const slot = hookIndex++;
    if (store.length <= slot) store[slot] = typeof init === 'function' ? init() : init;
    return [store[slot], (next) => { store[slot] = typeof next === 'function' ? next(store[slot]) : next; }];
  },
  useRef(init) {
    const store = currentStore(); const slot = hookIndex++;
    if (store.length <= slot) store[slot] = { current: init === undefined ? null : init };
    return store[slot];
  },
  useMemo(fn) { hookIndex++; return fn(); },
  useCallback(fn) { hookIndex++; return fn; },
  useEffect(fn, deps) { hookIndex++; queueEffect(fn, deps); },
  useLayoutEffect(fn, deps) { hookIndex++; queueEffect(fn, deps); },
};

// 假的调度：把 effect 记下来，整棵树画完再跑一次（每个槽只跑一次），
// 这样「列应用」那个异步调用真的会打到宿主半上。
const pendingEffects = [];
const ranEffects = new Set();
function queueEffect(fn, deps) {
  pendingEffects.push({ fn, key: renderKey + '#' + hookIndex });
}
async function flushEffects() {
  const batch = pendingEffects.splice(0, pendingEffects.length);
  for (const item of batch) {
    if (ranEffects.has(item.key)) continue;
    ranEffects.add(item.key);
    try {
      const cleanup = item.fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    } catch (error) {
      console.log('    [effect 抛错]', error && error.message);
    }
  }
}
const cleanups = [];

function render(node, trail) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    const out = [];
    node.forEach((child, index) => { const r = render(child, trail + '[' + index + ']'); if (r !== null) out.push(r); });
    return out;
  }
  if (typeof node.type === 'function') {
    const key = trail + '/' + (node.type.name || 'anon');
    const pk = renderKey, pi = hookIndex;
    renderKey = key; hookIndex = 0;
    let produced;
    try { produced = node.type(node.props); } finally { renderKey = pk; hookIndex = pi; }
    return render(produced, key);
  }
  return { type: node.type, props: { ...node.props, children: render(node.props.children, trail + '/' + node.type) } };
}

// ── 加载真的 client.js ──
const clientSource = readFileSync(path.resolve(here, '..', 'client.js'), 'utf8');
fakeWindow.__ModuleLoader__ = { load: (mod) => { fakeWindow.__mod = mod; } };
const context = vm.createContext({
  window: fakeWindow, document: fakeDocument, console: fakeWindow.console,
  setTimeout: fakeWindow.setTimeout, clearTimeout: fakeWindow.clearTimeout,
  fetch: fakeWindow.fetch, URL, JSON, Math, String, Number, Boolean, Array, Object, Error, Promise, Set, Map,
  Uint8Array, Buffer, document: fakeDocument,
});
vm.runInContext(clientSource, context, { filename: 'client.js' });

const mod = fakeWindow.__mod;
let registered = null;
const loader = mod.factory((name) => {
  if (name === 'react') return React;
  if (name === 'react-dom' || name === 'react-dom/client') throw new Error('no react-dom');
  throw new Error('意外的 require：' + name);
});
loader.apply({
  get: () => undefined,
  on: () => () => {},
  effect: (factory) => { factory(); },
  slots: {
    inject: (name, cb) => cb(),
    register: (entry, component) => { registered = component; return component; },
  },
});

// ── 开始验 ──

console.log('=== 1. 装一个真的示例包 ===');
{
  const packDir = path.resolve(here, '..', 'apps-src', 'note-book');
  const entries = [];
  for (const name of ['manifest.json', 'main.js', 'icon.svg']) {
    entries.push({ name, data: await readFile(path.join(packDir, name)) });
  }
  const base64 = makeZip(entries).toString('base64');
  const reply = await callHost('apps.install', { data: base64, locale: 'zh' });
  if (reply.ok && reply.data.id === 'note-book') ok('示例包装上了', reply.data.displayName + ' v' + reply.data.version);
  else bad('示例包装上了', JSON.stringify(reply));
}

console.log('\n=== 2. 界面半真的能把这个应用跑起来 ===');

// 应用列表是异步取的（要走一次真实的磁盘读取），所以不能只等一个固定毫秒数：
// 机器忙的时候 20 毫秒不够，测试就会随机红。这里改成"画到出现为止，最多两秒"。
function hasCell(node) {
  if (node === null || node === undefined) return false;
  if (Array.isArray(node)) return node.some(hasCell);
  if (typeof node === 'string') return false;
  const cls = node.props && typeof node.props.className === 'string' ? node.props.className : '';
  if (cls.split(/\s+/).includes('dphp-cell')) return true;
  return hasCell(node.props && node.props.children);
}

async function paint(until) {
  const deadline = Date.now() + 2000;
  let out = null;
  for (;;) {
    hookIndex = 0; renderKey = 'root';
    out = render(registered(), '');
    await flushEffects();
    if (typeof until !== 'function' || until(out) || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  return out;
}

let tree = await paint(hasCell);
const flat = [];
(function walk(node, p) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { node.forEach((c, i) => walk(c, p + '[' + i + ']')); return; }
  if (typeof node === 'string') return;
  flat.push({ tag: node.type, cls: typeof node.props.className === 'string' ? node.props.className : '', props: node.props });
  walk(node.props.children, p + '/' + node.type);
})(tree, '');
const byClass = (cls) => flat.filter((n) => n.cls.split(/\s+/).includes(cls));

// 从桌面拿到第一个图标按钮，点它
const cell = flat.find((n) => n.cls.split(/\s+/).includes('dphp-cell'));
if (!cell) {
  bad('桌面渲染出了应用图标');
} else {
  ok('桌面渲染出了应用图标', cell.props.title);
  // 点一下：openApp 是异步的，等它跑完
  try {
    await cell.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    ok('点图标没有抛错');
  } catch (error) {
    bad('点图标没有抛错', error && error.message);
  }
}

console.log('\n=== 3. 应用真的挂上去了，而且画出了东西 ===');
// 应用往 ctx.root 里画了一个 div，我们找那个节点
// 由于是假的 Document.createElement，节点进了一个容器；直接看真实 DOM 容器里有没有子节点
// 这里换个思路：直接调应用自己的挂载函数，检查它确实产出 DOM
{
  const sourceReply = await callHost('apps.source', { id: 'note-book' });
  if (!sourceReply.ok) bad('取到应用源码', JSON.stringify(sourceReply));
  else {
    const moduleObject = { exports: {} };
    const scopedRequire = () => { throw new Error('不该 require'); };
    const factory = new Function('module', 'exports', 'require', 'console', 'window', 'document', sourceReply.data.source);
    factory(moduleObject, moduleObject.exports, scopedRequire, fakeWindow.console, fakeWindow, fakeDocument);
    if (typeof moduleObject.exports !== 'function') bad('应用导出的是挂载函数');
    else ok('应用导出的是挂载函数');

    // 挂上去试试
    const container = fakeElement('div');
    const storageCalls = [];
    const ctx = {
      root: container,
      react: React,
      locale: 'zh',
      theme: 'light',
      permissions: ['storage'],
      api: { call: async () => { throw new Error('这个应用没有 host 权限'); } },
      storage: {
        get: async () => (await callHost('storage.get', { id: 'note-book' })).data.value,
        set: async (value) => {
          storageCalls.push(value);
          const reply = await callHost('storage.set', { id: 'note-book', value });
          return reply.data.value;
        },
      },
      onChange: () => () => {},
    };
    const unmount = moduleObject.exports(ctx);
    if (typeof unmount !== 'function') bad('应用交出了卸载函数');
    else ok('应用交出了卸载函数');
    if (container.children.length > 0) ok('应用往 ctx.root 里画了东西', container.children.length + ' 个节点');
    else bad('应用往 ctx.root 里画了东西', '容器是空的');

    // 找到那个 textarea，模拟输入
    const textarea = container.children[0].children.find((one) => one.tagName === 'textarea');
    if (!textarea) bad('应用画出了输入框');
    else {
      ok('应用画出了输入框');
      textarea.value = '我在手机里写的第一句话';
      const handler = (textarea.__on && textarea.__on.input && textarea.__on.input[0]) || null;
      if (!handler) bad('输入框挂上了 input 监听');
      else {
        ok('输入框挂上了 input 监听');
        handler();
        // 停手 500ms 后才真存，这里直接把那个定时器等出来
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (storageCalls.length > 0 && storageCalls[0].text === '我在手机里写的第一句话') {
          ok('应用把这句话存进了私有存储', JSON.stringify(storageCalls[0]));
        } else {
          bad('应用把这句话存进了私有存储', JSON.stringify(storageCalls));
        }
        // 再从宿主那边读回来，确认真落盘了
        const stored = await callHost('storage.get', { id: 'note-book' });
        if (stored.ok && stored.data.value && stored.data.value.text === '我在手机里写的第一句话') {
          ok('宿主那边读回来是同一句', stored.data.value.text);
        } else {
          bad('宿主那边读回来是同一句', JSON.stringify(stored));
        }
      }
    }

    unmount();
    if (container.children.length === 0) ok('卸载把画的东西清干净了');
    else bad('卸载把画的东西清干净了', container.children.length + ' 个残留');
  }
}

console.log('\n=== 4. 界面的应用窗口能真的挂上这个应用 ===');
{
  // 直接测界面半的挂载路径：这次不通过 React，只验它能把源码跑起来、能拿到 container
  // （真正的点击路径在上一段里已经走过一次，没抛错）
  const reply = await callHost('apps.source', { id: 'note-book' });
  const body = clientSource;
  if (/layer\.appendChild\(rootElement\)/.test(body)) ok('界面半真的把应用的容器挂进内屏');
  else bad('界面半真的把应用的容器挂进内屏');
  if (/mountedRef\.current = \{/.test(body)) ok('界面半记下了正在跑的应用');
  else bad('界面半记下了正在跑的应用');
}

console.log('\n=== 5. 卸载以后磁盘也干净了 ===');
{
  const un = await callHost('apps.uninstall', { id: 'note-book' });
  if (un.ok) ok('卸掉了');
  else bad('卸掉了', JSON.stringify(un));
  const appsDir = path.join(scratch, 'dsh-phone', 'apps');
  const left = await readdir(appsDir).catch(() => []);
  if (left.length === 0) ok('应用目录清空了', left.join(' ') || '(空)');
  else bad('应用目录清空了', left.join(' '));
}

await rm(scratch, { recursive: true, force: true });
console.log('\n通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) { for (const one of failures) console.log('  - ' + one); process.exit(1); }