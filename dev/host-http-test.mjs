// 宿主 HTTP 接口的端到端测试：不装插件，直接喂假请求给 index.js 注册的那个 handler。
// 覆盖界面真正会调的六个方法，以及跨域以外的那几条硬约束。
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeZip } from './make-zip.mjs';

const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-phone-http-'));
process.env.DSH_HOME = scratch;

const { apply } = await import('../index.js');

let passed = 0;
const failures = [];

function ok(label, detail) {
  passed += 1;
  console.log('  ok   ' + label + (detail ? '  (' + detail + ')' : ''));
}

function bad(label, detail) {
  failures.push(label + (detail ? ': ' + detail : ''));
  console.log('  FAIL ' + label + (detail ? '  → ' + detail : ''));
}

// ── 假的 webServer：只记住注册了哪条路由，并提供 match（转发模块要问它后端在不在）──
let registered = null;
let fakeRoutes = new Set();
const fakeCtx = {
  effect(factory, label) {
    const disposer = factory();
    return disposer;
  },
  webServer: {
    register(route) {
      registered = route;
      fakeRoutes.add(route.path);
      return () => fakeRoutes.delete(route.path);
    },
    match(pathname) {
      for (const route of fakeRoutes) {
        if (pathname === route || pathname.startsWith(route + '/')) return { path: route };
      }
      return undefined;
    },
    getOrigin() {
      return 'http://127.0.0.1:19999';
    },
    port: 19999,
  },
};

apply(fakeCtx);
if (registered === null) {
  bad('注册了路由');
  process.exit(1);
}
ok('注册了路由', registered.kind + ' ' + registered.path);

/** 造一对假的 request / response。 */
function call(method, params, rawBody) {
  return new Promise((resolve) => {
    const listeners = {};
    const request = {
      method: 'POST',
      url: '/dsh-phone/api',
      on(event, handler) {
        listeners[event] = handler;
      },
      destroy() {},
    };
    let status = 0;
    let body = '';
    const response = {
      writeHead(code) {
        status = code;
      },
      end(text) {
        body = text;
        resolve({ status, body: body === '' ? null : JSON.parse(body) });
      },
    };
    const done = registered.handler(request, response);
    void done;
    const payload = rawBody !== undefined ? rawBody : JSON.stringify({ method, params });
    // 模拟一个 chunk 事件把请求体推进去
    setTimeout(() => {
      if (listeners.data) listeners.data(Buffer.from(payload));
      if (listeners.end) listeners.end();
    }, 0);
  });
}

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';
const MAIN = 'module.exports = function mount(ctx) { return function unmount() {}; };';

function packageBase64(overrides) {
  const manifest = {
    id: 'demo-app',
    name: { zh: '演示', en: 'Demo' },
    version: '1.0.0',
    entry: 'main.js',
    icon: 'icon.svg',
    api: 1,
    permissions: ['storage'],
    ...(overrides || {}),
  };
  const buffer = makeZip([
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    { name: 'main.js', data: MAIN },
    { name: 'icon.svg', data: ICON },
  ]);
  return buffer.toString('base64');
}

console.log('\n=== 1. ping ===');
{
  const reply = await call('ping');
  if (reply.status === 200 && reply.body.ok === true) ok('ping 通了', reply.body.data.root);
  else bad('ping 通了', JSON.stringify(reply));
}

console.log('\n=== 2. 空桌面 ===');
{
  const reply = await call('apps.list', { locale: 'zh' });
  if (reply.body.ok === true && Array.isArray(reply.body.data.apps) && reply.body.data.apps.length === 0) ok('一开始没有应用');
  else bad('一开始没有应用', JSON.stringify(reply.body));
}

console.log('\n=== 3. 从 base64 装一个包 ===');
{
  const reply = await call('apps.install', { data: packageBase64(), locale: 'zh' });
  if (reply.body.ok === true && reply.body.data.id === 'demo-app') ok('装上了', reply.body.data.displayName);
  else bad('装上了', JSON.stringify(reply.body));

  const list = await call('apps.list', { locale: 'zh' });
  const apps = list.body.data.apps;
  if (apps.length === 1) ok('桌面上有一个');
  else bad('桌面上有一个', String(apps.length));
  if (String(apps[0].iconData).startsWith('data:image/svg+xml;base64,')) ok('图标直接带在列表里（界面不用再取文件）');
  else bad('图标直接带在列表里', String(apps[0].iconData).slice(0, 30));
  if (apps[0].backendReady === true) ok('没有后端的应用标记为可用');
  else bad('没有后端的应用标记为可用', String(apps[0].backendReady));

  const source = await call('apps.source', { id: 'demo-app' });
  if (source.body.ok === true && source.body.data.source.includes('module.exports')) ok('应用代码读得出来');
  else bad('应用代码读得出来', JSON.stringify(source.body).slice(0, 120));
}

console.log('\n=== 4. 重复装要走「覆盖还是取消」那条分支 ===');
{
  const reply = await call('apps.install', { data: packageBase64(), locale: 'zh' });
  if (reply.body.ok === false && reply.body.code === 'already-exists' && reply.body.existing.name === '演示') {
    ok('回了 already-exists 和名字', reply.body.error);
  } else {
    bad('回了 already-exists 和名字', JSON.stringify(reply.body));
  }
  const again = await call('apps.install', { data: packageBase64({ version: '2.0.0' }), locale: 'zh', overwrite: true });
  if (again.body.ok === true && again.body.data.replaced === true) ok('带 overwrite 覆盖成功', again.body.data.version);
  else bad('带 overwrite 覆盖成功', JSON.stringify(again.body));
}

console.log('\n=== 5. 私有存储 ===');
{
  const set = await call('storage.set', { id: 'demo-app', value: { text: '你好' } });
  if (set.body.ok === true && set.body.data.value.text === '你好') ok('写进去了');
  else bad('写进去了', JSON.stringify(set.body));

  const get = await call('storage.get', { id: 'demo-app' });
  if (get.body.ok === true && get.body.data.value.text === '你好') ok('读回来了');
  else bad('读回来了', JSON.stringify(get.body));
}

console.log('\n=== 6. 没申 host 就调后端，必须被拦 ===');
{
  const reply = await call('app.call', { id: 'demo-app', method: 'ping', params: {} });
  if (reply.body.ok === false && /没有申请访问后端的权限/.test(reply.body.error)) ok('拦住了', reply.body.error);
  else bad('拦住了', JSON.stringify(reply.body));
}

console.log('\n=== 7. 申了 host 但没配 backend ===');
{
  const reply = await call('apps.install', { data: packageBase64({ id: 'hostonly', permissions: ['host'] }), locale: 'zh' });
  if (reply.body.ok !== true) bad('装 hostonly', JSON.stringify(reply.body));
  const call1 = await call('app.call', { id: 'hostonly', method: 'ping' });
  if (call1.body.ok === false && /没有配置后端/.test(call1.body.error)) ok('说清楚了缺什么', call1.body.error);
  else bad('说清楚了缺什么', JSON.stringify(call1.body));
}

console.log('\n=== 8. 配了 backend 但那个后端没在跑 ===');
{
  const reply = await call('apps.install', {
    data: packageBase64({ id: 'needs-backend', permissions: ['host'], backend: 'dsh-music' }),
    locale: 'zh',
  });
  if (reply.body.ok !== true) bad('装 needs-backend', JSON.stringify(reply.body));

  const list = await call('apps.list', { locale: 'zh' });
  const row = list.body.data.apps.find((one) => one.id === 'needs-backend');
  if (row && row.backendReady === false) ok('列表里标出「需要后端」', String(row.backendReady));
  else bad('列表里标出「需要后端」', JSON.stringify(row && row.backendReady));

  const called = await call('app.call', { id: 'needs-backend', method: 'ping' });
  if (called.body.ok === false && /没有运行/.test(called.body.error)) ok('点开时说的是人话', called.body.error);
  else bad('点开时说的是人话', JSON.stringify(called.body));

  // 假装那个后端插件起来了
  fakeRoutes.add('/dsh-music');
  const list2 = await call('apps.list', { locale: 'zh' });
  const row2 = list2.body.data.apps.find((one) => one.id === 'needs-backend');
  if (row2 && row2.backendReady === true) ok('后端出现后同一个应用变成可用', String(row2.backendReady));
  else bad('后端出现后同一个应用变成可用', JSON.stringify(row2 && row2.backendReady));
  fakeRoutes.delete('/dsh-music');
}

console.log('\n=== 9. 坏包给人话（走 HTTP 这一层）===');
{
  const notZip = (await call('apps.install', { data: Buffer.from('随便一段文字，肯定不是 zip 吧应该够长了').toString('base64') })).body;
  if (notZip.ok === false && /压缩包/.test(notZip.error)) ok('不是 zip', notZip.error);
  else bad('不是 zip', JSON.stringify(notZip));

  const empty = (await call('apps.install', { data: '' })).body;
  if (empty.ok === false && /没有收到文件内容/.test(empty.error)) ok('空数据', empty.error);
  else bad('空数据', JSON.stringify(empty));
}

console.log('\n=== 10. 卸载 ===');
{
  const reply = await call('apps.uninstall', { id: 'hostonly' });
  if (reply.body.ok === true) ok('卸掉了 hostonly');
  else bad('卸掉了 hostonly', JSON.stringify(reply.body));
  const list = await call('apps.list', { locale: 'zh' });
  if (!list.body.data.apps.some((one) => one.id === 'hostonly')) ok('桌面上没有了');
  else bad('桌面上没有了', JSON.stringify(list.body.data.apps.map((one) => one.id)));
}

console.log('\n=== 11. 路径与方法的边界 ===');
{
  const wrongPath = await new Promise((resolve) => {
    const request = { method: 'POST', url: '/dsh-phone/other', on() {} };
    const response = { writeHead(code) { resolve({ status: code }); }, end() {} };
    registered.handler(request, response);
  });
  if (wrongPath.status === 404) ok('别的路径回 404');
  else bad('别的路径回 404', String(wrongPath.status));

  const wrongMethod = await new Promise((resolve) => {
    const request = { method: 'GET', url: '/dsh-phone/api', on() {} };
    const response = { writeHead(code) { resolve({ status: code }); }, end() {} };
    registered.handler(request, response);
  });
  if (wrongMethod.status === 405) ok('GET 回 405');
  else bad('GET 回 405', String(wrongMethod.status));

  const badJson = await new Promise((resolve) => {
    const listeners = {};
    const request = { method: 'POST', url: '/dsh-phone/api', on(e, fn) { listeners[e] = fn; }, destroy() {} };
    let status = 0;
    const response = {
      writeHead(code) { status = code; },
      end(text) { resolve({ status, body: text === '' ? null : JSON.parse(text) }); },
    };
    registered.handler(request, response);
    setTimeout(() => {
      listeners.data(Buffer.from('{ 这不是 json'));
      listeners.end();
    }, 0);
  });
  if (badJson.status === 400 && /不是合法 JSON/.test(badJson.body.error)) ok('坏 JSON 回 400 且说人话');
  else bad('坏 JSON 回 400 且说人话', JSON.stringify(badJson));

  const unknownMethod = await call('没这个方法');
  if (unknownMethod.body.ok === false && /没有这个方法/.test(unknownMethod.body.error)) ok('未知方法回一句人话');
  else bad('未知方法回一句人话', JSON.stringify(unknownMethod.body));
}

console.log('\n=== 12. 数据落在 DSH 主目录，不落在插件目录 ===');
{
  const installed = await stat(path.join(scratch, 'dsh-phone', 'apps', 'demo-app', 'manifest.json'));
  if (installed.isFile()) ok('应用在 <DSH 主目录>/dsh-phone/apps/demo-app', '');
  else bad('应用在 <DSH 主目录>/dsh-phone/apps/demo-app', '');
  const phoneJson = await readFile(path.join(scratch, 'dsh-phone', 'phone.json'), 'utf8');
  if (JSON.parse(phoneJson).apps['demo-app']) ok('手机设置写在 phone.json');
  else bad('手机设置写在 phone.json', phoneJson);
}

await rm(scratch, { recursive: true, force: true });
console.log('\n通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
  for (const one of failures) console.log('  - ' + one);
  process.exit(1);
}
