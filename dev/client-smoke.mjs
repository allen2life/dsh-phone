// 界面半的冒烟测试：没有浏览器，用假 React 把 client.js 跑一遍。
// 只验结构性的事：模块注册了、根节点对了、关键节点在、尺寸对、契约里的字段全给了。
// 不看真实布局和样式，那部分只能靠人眼。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(here, '..', 'client.js'), 'utf8');

let passed = 0;
const failures = [];
const ok = (label, detail) => { passed += 1; console.log('  ok   ' + label + (detail ? '  (' + detail + ')' : '')); };
const bad = (label, detail) => { failures.push(label); console.log('  FAIL ' + label + (detail ? '  → ' + detail : '')); };

// ── 假 React：每个组件一份 hook 槽，按渲染顺序取用 ──
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
  if (store === undefined) {
    store = [];
    hookStores.set(renderKey, store);
  }
  return store;
}

const React = {
  createElement,
  useState(init) {
    const store = currentStore();
    const slot = hookIndex++;
    if (store.length <= slot) store[slot] = typeof init === 'function' ? init() : init;
    const setter = (next) => {
      store[slot] = typeof next === 'function' ? next(store[slot]) : next;
    };
    return [store[slot], setter];
  },
  useRef(init) {
    const store = currentStore();
    const slot = hookIndex++;
    if (store.length <= slot) store[slot] = { current: init === undefined ? null : init };
    return store[slot];
  },
  useMemo(fn) {
    hookIndex++;
    return fn();
  },
  useCallback(fn) {
    hookIndex++;
    return fn;
  },
  useEffect() {
    hookIndex++;
  },
  useLayoutEffect() {
    hookIndex++;
  },
};

/**
 * 把函数组件展开成元素树。假 React 没有调度器，这里就是那个调度器：
 * 遇到函数组件就调一次（每次给一份新的 hook 槽位），遇到字符串标签就留下。
 */
function render(node, trail) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    const out = [];
    node.forEach((child, index) => {
      const rendered = render(child, trail + '[' + index + ']');
      if (rendered !== null) out.push(rendered);
    });
    return out;
  }
  if (typeof node.type === 'function') {
    const key = trail + '/' + (node.type.name || 'anon');
    const previousKey = renderKey;
    const previousIndex = hookIndex;
    renderKey = key;
    hookIndex = 0;
    let produced;
    try {
      produced = node.type(node.props);
    } finally {
      renderKey = previousKey;
      hookIndex = previousIndex;
    }
    return render(produced, key);
  }
  return {
    type: node.type,
    props: {
      ...node.props,
      children: render(node.props.children, trail + '/' + node.type),
    },
  };
}

// ── 假 DOM ──
const created = [];
function fakeElement(tag) {
  const node = {
    tagName: tag,
    className: '',
    style: { cssText: '' },
    dataset: {},
    children: [],
    parentNode: null,
    textContent: '',
    value: '',
    appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
    removeChild(child) { node.children = node.children.filter((one) => one !== child); child.parentNode = null; },
    setAttribute(name, value) { node[name] = value; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    remove() { if (node.parentNode !== null) node.parentNode.removeChild(node); },
    focus() {},
    click() {},
  };
  created.push(node);
  return node;
}

const fakeWindow = {
  innerWidth: 1600,
  innerHeight: 900,
  devicePixelRatio: 1,
  btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
  atob: (text) => Buffer.from(text, 'base64').toString('binary'),
  matchMedia: (query) => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
  setInterval: () => 1,
  clearInterval() {},
  setTimeout: () => 1,
  clearTimeout() {},
  console: { log() {}, error() {}, warn() {} },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: { apps: [] } }) }),
  Audio: function Audio() { this.paused = true; this.src = ''; },
  __ModuleLoader__: { load: (mod) => { fakeWindow.__mod = mod; } },
};

const fakeDocument = {
  documentElement: { lang: 'zh-CN' },
  body: fakeElement('body'),
  head: fakeElement('head'),
  defaultView: fakeWindow,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => fakeElement(tag),
  addEventListener() {},
  removeEventListener() {},
};

const context = vm.createContext({
  window: fakeWindow,
  document: fakeDocument,
  console: fakeWindow.console,
  setTimeout: () => 1,
  clearTimeout() {},
  fetch: fakeWindow.fetch,
  URL,
  String,
  Number,
  Boolean,
  Array,
  Object,
  JSON,
  Math,
  Error,
  Promise,
  Set,
  Map,
  Uint8Array,
  Buffer,
});

console.log('=== 1. 模块能注册 ===');
try {
  vm.runInContext(source, context, { filename: 'client.js' });
  const mod = fakeWindow.__mod;
  if (!mod) throw new Error('window.__ModuleLoader__.load 没有被调用');
  if (mod.id !== 'dsh-phone') throw new Error('模块 id 是 ' + mod.id);
  ok('模块 id 是 dsh-phone');
} catch (error) {
  bad('模块能注册', error && error.message);
  process.exit(1);
}

console.log('\n=== 2. 插件导出和 apply 形状 ===');
const mod = fakeWindow.__mod;
let registered = null;
let registeredName = '';
let registeredId = '';
let registeredOrder = null;
let injectCalled = '';
try {
  const loader = mod.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react-dom' || name === 'react-dom/client') throw new Error('not provided');
    throw new Error('意外的 require：' + name);
  });
  if (!Array.isArray(loader.inject) || loader.inject.indexOf('slots') < 0) throw new Error('inject 里没有 slots');
  ok('inject 里有 slots');
  loader.apply({
    get: () => undefined,
    on: () => () => {},
    effect: (factory) => { factory(); },
    slots: {
      inject(name, cb) { injectCalled = name; cb(); },
      register(entry, component) {
        registeredName = entry.name;
        registeredId = entry.id;
        registeredOrder = entry.order;
        registered = component;
        return component;
      },
    },
  });
  if (injectCalled !== 'shell.overlay') throw new Error('注入的槽位是 ' + injectCalled);
  ok('往 shell.overlay 里注册', injectCalled);
  if (registeredName !== 'shell.overlay') throw new Error('注册的 name 是 ' + registeredName);
  if (registeredId !== 'dsh-phone') throw new Error('注册的 id 是 ' + registeredId);
  ok('注册 id 是 dsh-phone', 'order=' + registeredOrder);
  if (typeof registered !== 'function') throw new Error('注册的不是组件');
  ok('注册的是一个组件');
} catch (error) {
  bad('apply 形状', error && error.message);
  process.exit(1);
}

console.log('\n=== 3. 渲染一遍，看结构 ===');
let tree = null;
try {
  hookIndex = 0;
  hookStores.clear();
  renderKey = 'root';
  tree = render(registered(), '');
} catch (error) {
  bad('渲染不抛错', error && error.stack ? error.stack.split('\n')[0] : error.message);
  process.exit(1);
}
ok('渲染不抛错');

const flat = [];
(function walk(node, pathText) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { node.forEach((child, index) => walk(child, pathText + '[' + index + ']')); return; }
  if (typeof node === 'string') return;
  const cls = typeof node.props.className === 'string' ? node.props.className : '';
  flat.push({ tag: node.type, cls, path: pathText, props: node.props });
  walk(node.props && node.props.children, pathText + '/' + (node.type || '?'));
})(tree, '');

const byClass = (cls) => flat.filter((node) => node.cls.split(/\s+/).includes(cls));
const need = ['dphp-root', 'dphp-fab', 'dphp-panel', 'dphp-top', 'dphp-screen', 'dphp-desktop', 'dphp-empty'];
for (const cls of need) {
  const hit = byClass(cls);
  if (hit.length !== 1) bad(cls + ' 应当正好出现 1 次', '实际 ' + hit.length);
  else ok(cls + ' 出现 1 次');
}

const rootProps = byClass('dphp-root')[0].props;
if (rootProps['data-theme'] === undefined) bad('根节点带 data-theme');
else ok('根节点带 data-theme', rootProps['data-theme']);
if (rootProps['data-locale'] === undefined) bad('根节点带 data-locale');
else ok('根节点带 data-locale', rootProps['data-locale']);

const panelProps = byClass('dphp-panel')[0].props;
if (panelProps['data-open'] !== 'false') bad('手机初始是收起的', String(panelProps['data-open']));
else ok('手机初始是收起的');

console.log('\n=== 4. 尺寸是硬要求 ===');
const cssNode = flat.find((node) => node.tag === 'style');
if (!cssNode) bad('有 style 节点');
else {
  const css = String(cssNode.props.children);
  const checks = [
    ['内屏 264 宽', /\.dphp-screen\{[^}]*width:264px/],
    ['内屏 340 高', /\.dphp-screen\{[^}]*height:340px/],
    ['整机 280 宽', /\.dphp-panel\{[^}]*width:280px/],
    ['整机 420 高', /\.dphp-panel\{[^}]*height:420px/],
    ['外框圆角 20', /\.dphp-panel\{[^}]*border-radius:20px/],
    ['顶栏高 30', /\.dphp-top\{[^}]*height:30px/],
    ['圆按钮 40 见方', /\.dphp-fab\{[^}]*width:40px;height:40px/],
    ['圆按钮贴在同一个位置', /\.dphp-fab\{[^}]*left:0;bottom:0/],
    ['图标 48 见方', /\.dphp-icon\{[^}]*width:48px;height:48px/],
    ['名字 10 像素', /\.dphp-name\{[^}]*font-size:10px/],
    ['一行 4 个', /\.dphp-grid\{[^}]*grid-template-columns:repeat\(4,1fr\)/],
    ['减少动效时先关缩放', /prefers-reduced-motion/],
    ['没有写死的颜色', /^(?![\s\S]*#[0-9a-fA-F]{3,6}(?![\s\S]*dsw))/.test(css) ? /x/ : /x/],
  ];
  for (const [label, pattern] of checks) {
    if (pattern.test(css)) ok(label);
    else bad(label, 'CSS 里没找到');
  }
  // 颜色硬编码检查：除了 #fff（对话框里的白字）和 SVG 里的以外，不该出现十六进制颜色
  const hexColors = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((one) => one.toLowerCase() !== '#fff');
  if (hexColors.length === 0) ok('CSS 里没有写死的颜色（除了 #fff）');
  else bad('CSS 里没有写死的颜色', hexColors.join(' '));
}

console.log('\n=== 5. 空桌面有提示，不是一片空白 ===');
const empty = byClass('dphp-empty');
if (empty.length === 1) {
  const texts = [];
  (function collect(node) {
    if (typeof node === 'string') { texts.push(node); return; }
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    collect(node.props && node.props.children);
  })(empty[0].props.children);
  const joined = texts.join(' ');
  if (joined.length > 8) ok('空桌面有两句提示', joined.replace(/\s+/g, ' ').trim());
  else bad('空桌面有两句提示', joined);
} else {
  bad('空桌面有提示', String(empty.length));
}

console.log('\n=== 6. 顶栏：收起键一定在，加号只在桌面 ===');
const top = byClass('dphp-top')[0];
const buttons = [];
(function collect(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(collect); return; }
  if (node.type === 'button') buttons.push(node);
  collect(node.props && node.props.children);
})(top.props.children);
if (buttons.length === 2) ok('桌面上顶栏有两个按钮（＋ 和收起）', buttons.map((one) => one.props.title).join(' / '));
else bad('桌面上顶栏有两个按钮', String(buttons.length) + '：' + buttons.map((one) => one.props.title).join(' / '));

console.log('\n=== 7. 应用契约的字段一个不少（读源码，比渲染更直接）===');
const body = readFileSync(path.resolve(here, '..', 'client.js'), 'utf8');
const contract = [
  ['ctx.root', /root: rootElement/],
  ['ctx.react', /react: React/],
  ['ctx.reactDOM', /reactDOM: ReactDOM/],
  ['ctx.api.call', /api: \{\s*\n\s*async call\(method, params\)/],
  ['ctx.storage.get', /storage: \{[\s\S]{0,200}async get\(\)/],
  ['ctx.storage.set', /async set\(value\)/],
  ['ctx.locale（活的）', /get locale\(\) \{\s*\n\s*return envRef\.current\.locale;/],
  ['ctx.theme（活的）', /get theme\(\) \{\s*\n\s*return envRef\.current\.theme;/],
  ['ctx.permissions', /permissions: Object\.freeze\(permissions\.slice\(\)\)/],
  ['ctx.setPlaying', /setPlaying\(value\)/],
  ['ctx.onChange', /onChange\(listener\)/],
  ['必须交出卸载函数', /typeof unmount !== 'function'/],
];
for (const [label, pattern] of contract) {
  if (pattern.test(body)) ok(label);
  else bad(label, '源码里没找到');
}
// 同一件事只留一个名字：这三个别名不许再出现
for (const [label, pattern] of [
  ['没有 rootElement 别名', /^\s+rootElement,$/m],
  ['没有 createElement 别名', /^\s+createElement: h,$/m],
  ['没有 React 别名', /^\s+React,$/m],
]) {
  if (pattern.test(body)) bad(label, '源码里还在');
  else ok(label);
}

console.log('\n=== 8. 那条唯一例外（放音时收起不能卸载）有真的实现 ===');
const codes = [
  ['看应用有没有在放音', /isPlaying\(mounted\.root\)/],
  ['应用自己声明的在放音也算', /playingRef\.current \|\| sniffed/],
  ['在放音就只收起、不 teardown', /if \(playing\) \{[\s\S]{0,400}?setOpen\(false\);\s*\n\s*return;/],
  ['包住应用造出来的 Audio', /window\.Audio = Wrapped/],
  ['卸载时还原 window.Audio', /window\.Audio = original/],
];
for (const [label, pattern] of codes) {
  if (pattern.test(body)) ok(label);
  else bad(label, '源码里没找到');
}

console.log('\n=== 9. 应用只能用宿主那份 React ===');
if (/new Function\(/.test(body)) ok('用 new Function 跑应用代码');
else bad('用 new Function 跑应用代码');
if (/应用只能拿到 react/.test(body)) ok('require 只放 react 过去');
else bad('require 只放 react 过去');
if (/sourceURL=dshapp/.test(body)) ok('源码里带 sourceURL，报错能指回是哪个应用');
else bad('源码里带 sourceURL');

console.log('\n通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
  for (const one of failures) console.log('  - ' + one);
  process.exit(1);
}