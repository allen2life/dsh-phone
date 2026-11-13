// 宿主半的离线验收：不装插件、不开界面，只验「解压 → 校验 → 装/卸 → 私有存储」。
// 用法：node dev/host-test.mjs
import { mkdtemp, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeZip } from './make-zip.mjs';

const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-phone-test-'));
process.env.DSH_HOME = scratch;

const apps = await import('../lib/apps.js');
const zip = await import('../lib/zip.js');

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

async function expectThrow(label, fn, expectedFragment) {
  try {
    await fn();
    bad(label, '没有抛错，应该抛「' + expectedFragment + '」');
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (message.includes(expectedFragment)) ok(label, message);
    else bad(label, '抛的是「' + message + '」，期望包含「' + expectedFragment + '」');
  }
}

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24"/></svg>';
const MAIN = 'module.exports = function mount(ctx) { return function unmount() {}; };';

function manifest(overrides) {
  return JSON.stringify({
    id: 'note-book',
    name: { zh: '便签本', en: 'Notebook' },
    version: '1.0.0',
    entry: 'main.js',
    icon: 'icon.svg',
    api: 1,
    permissions: ['storage'],
    description: '写一句话',
    ...(overrides || {}),
  });
}

function packageOf(entries) {
  return makeZip(entries);
}

function goodPackage(overrides) {
  return packageOf([
    { name: 'manifest.json', data: manifest(overrides) },
    { name: 'main.js', data: MAIN },
    { name: 'icon.svg', data: ICON },
  ]);
}

console.log('数据目录：' + apps.DATA_ROOT);
console.log('\n=== 1. 正常的包能装上 ===');
{
  const result = await apps.installPackage(goodPackage(), { locale: 'zh' });
  if (result.id === 'note-book' && result.replaced === false) ok('装上了', result.displayName + ' v' + result.version);
  else bad('装上了', JSON.stringify(result));

  const list = await apps.listApps('zh');
  if (list.length === 1 && list[0].id === 'note-book') ok('登记表里有一个应用');
  else bad('登记表里有一个应用', JSON.stringify(list));

  if (String(list[0].iconData).startsWith('data:image/svg+xml;base64,')) ok('图标读成了 data URI');
  else bad('图标读成了 data URI', String(list[0].iconData).slice(0, 40));

  if (typeof list[0].installedAt === 'number' && list[0].installedAt > 0) ok('记下了安装时间');
  else bad('记下了安装时间', String(list[0].installedAt));

  const source = await apps.readAppSource('note-book');
  if (source.source.includes('module.exports')) ok('应用代码读得出来');
  else bad('应用代码读得出来', source.source.slice(0, 40));

  const dir = path.join(apps.APPS_DIR, 'note-book');
  const files = (await readdir(dir)).sort();
  if (files.join(',') === 'icon.svg,main.js,manifest.json') ok('落盘的就是包里的三个文件', files.join(' '));
  else bad('落盘的就是包里的三个文件', files.join(' '));
}

console.log('\n=== 2. 私有存储：存、读、没权限拦 ===');
{
  await apps.writeStorage('note-book', { text: '你好' });
  const value = await apps.readStorage('note-book');
  if (value && value.text === '你好') ok('存进去又读回来了');
  else bad('存进去又读回来了', JSON.stringify(value));

  const file = path.join(apps.APPS_DIR, 'note-book.json');
  const raw = await readFile(file, 'utf8');
  if (JSON.parse(raw).value.text === '你好') ok('存储落在 apps/note-book.json', file);
  else bad('存储落在 apps/note-book.json', raw);

  const manifestOf = await apps.readManifest('note-book');
  apps.assertPermission(manifestOf, 'storage');
  ok('有 storage 权限，检查通过');

  await expectThrow('没申 host 时调后端被拦', () => apps.assertPermission(manifestOf, 'host'), '没有申请访问后端的权限');
}

console.log('\n=== 3. 同一个包重复装要问一句 ===');
{
  await expectThrow(
    '重复装不带 overwrite 就拒绝',
    () => apps.installPackage(goodPackage(), { locale: 'zh' }),
    '要覆盖它吗',
  );
  const result = await apps.installPackage(goodPackage({ version: '1.1.0' }), { locale: 'zh', overwrite: true });
  if (result.replaced === true && result.version === '1.1.0') ok('带 overwrite 能覆盖', 'v' + result.version);
  else bad('带 overwrite 能覆盖', JSON.stringify(result));
  const list = await apps.listApps('zh');
  if (list.length === 1) ok('覆盖以后桌面还是一个');
  else bad('覆盖以后桌面还是一个', String(list.length));
}

console.log('\n=== 4. 坏包全部要给人话 ===');
{
  await expectThrow('不是 zip', () => apps.installPackage(Buffer.from('这不是压缩包，只是一段文字而已，长度够了吧，嗯应该够了'), {}), '压缩包');

  await expectThrow('空文本', () => apps.installPackage(Buffer.alloc(0), {}), '压缩包');

  const noManifest = packageOf([{ name: 'main.js', data: MAIN }]);
  await expectThrow('缺 manifest.json', () => apps.installPackage(noManifest, {}), '没有 manifest.json');

  await expectThrow(
    '缺 name',
    () => apps.installPackage(packageOf([
      { name: 'manifest.json', data: manifest({ name: undefined }) },
      { name: 'main.js', data: MAIN },
      { name: 'icon.svg', data: ICON },
    ]), {}),
    '少了 name',
  );

  await expectThrow(
    'api 版本不对',
    () => apps.installPackage(packageOf([
      { name: 'manifest.json', data: manifest({ api: 2 }) },
      { name: 'main.js', data: MAIN },
      { name: 'icon.svg', data: ICON },
    ]), {}),
    '只认 1',
  );

  await expectThrow(
    'id 带大写',
    () => apps.installPackage(packageOf([
      { name: 'manifest.json', data: manifest({ id: 'NoteBook' }) },
      { name: 'main.js', data: MAIN },
      { name: 'icon.svg', data: ICON },
    ]), {}),
    '小写英文',
  );

  await expectThrow(
    '不认识的权限',
    () => apps.installPackage(packageOf([
      { name: 'manifest.json', data: manifest({ permissions: ['storage', 'camera'] }) },
      { name: 'main.js', data: MAIN },
      { name: 'icon.svg', data: ICON },
    ]), {}),
    '不认识的权限',
  );

  await expectThrow(
    '配了 backend 却没申 host',
    () => apps.installPackage(packageOf([
      { name: 'manifest.json', data: manifest({ backend: 'dsh-music' }) },
      { name: 'main.js', data: MAIN },
      { name: 'icon.svg', data: ICON },
    ]), {}),
    '没写 host',
  );

  await expectThrow(
    '入口文件不在包里',
    () => apps.installPackage(packageOf([
      { name: 'manifest.json', data: manifest() },
      { name: 'icon.svg', data: ICON },
    ]), {}),
    '找不到入口文件',
  );

  await expectThrow(
    '图标文件不在包里',
    () => apps.installPackage(packageOf([
      { name: 'manifest.json', data: manifest({ icon: 'nope.png' }) },
      { name: 'main.js', data: MAIN },
    ]), {}),
    '找不到图标文件',
  );

  await expectThrow(
    '图标后缀不认识',
    () => apps.installPackage(packageOf([
      { name: 'manifest.json', data: manifest({ icon: 'icon.txt' }) },
      { name: 'main.js', data: MAIN },
      { name: 'icon.txt', data: ICON },
    ]), {}),
    '图标只能是',
  );

  await expectThrow(
    'manifest.json 不是 JSON',
    () => apps.installPackage(packageOf([
      { name: 'manifest.json', data: '{ 这不是 json ' },
      { name: 'main.js', data: MAIN },
      { name: 'icon.svg', data: ICON },
    ]), {}),
    '不是合法的 JSON',
  );
}

console.log('\n=== 5. 路径穿越必须挡住（硬要求）===');
{
  const traversal = packageOf([
    { name: 'manifest.json', data: manifest() },
    { name: 'main.js', data: MAIN },
    { name: 'icon.svg', data: ICON },
    { name: '../../escape.txt', data: '我跑出去了' },
  ]);
  await expectThrow('包里写 ../../', () => apps.installPackage(traversal, {}), '想跳到上级目录');

  const absolute = packageOf([
    { name: 'manifest.json', data: manifest() },
    { name: 'main.js', data: MAIN },
    { name: 'icon.svg', data: ICON },
    { name: '/tmp/evil.txt', data: 'x' },
  ]);
  await expectThrow('包里写绝对路径', () => apps.installPackage(absolute, {}), '绝对路径');

  const drive = packageOf([
    { name: 'manifest.json', data: manifest() },
    { name: 'main.js', data: MAIN },
    { name: 'icon.svg', data: ICON },
    { name: 'C:/evil.txt', data: 'x' },
  ]);
  await expectThrow('包里写盘符', () => apps.installPackage(drive, {}), '盘符');

  // 确认「应用目录」外面真的没有多出东西
  const outside = await readdir(scratch);
  if (outside.indexOf('escape.txt') < 0 && outside.indexOf('evil.txt') < 0) ok('数据目录外面没有多出文件', outside.join(' '));
  else bad('数据目录外面没有多出文件', outside.join(' '));
  const staged = (await readdir(apps.APPS_DIR)).filter((name) => name.startsWith('.staging-'));
  if (staged.length === 0) ok('失败的安装没留下临时目录');
  else bad('失败的安装没留下临时目录', staged.join(' '));
}

console.log('\n=== 6. 卸载要连私有存储一起清 ===');
{
  await apps.uninstallApp('note-book');
  const list = await apps.listApps('zh');
  if (list.length === 0) ok('桌面空了');
  else bad('桌面空了', String(list.length));
  const dirExists = await stat(path.join(apps.APPS_DIR, 'note-book')).then(() => true, () => false);
  const storageExists = await stat(path.join(apps.APPS_DIR, 'note-book.json')).then(() => true, () => false);
  if (!dirExists) ok('应用目录删掉了');
  else bad('应用目录删掉了', '还在');
  if (!storageExists) ok('私有存储删掉了');
  else bad('私有存储删掉了', '还在');
  await expectThrow('卸载没装过的应用', () => apps.uninstallApp('note-book'), '已经不在手机里了');
}

console.log('\n=== 7. 别的应用不受影响 ===');
{
  await apps.installPackage(goodPackage(), { locale: 'zh' });
  const second = packageOf([
    { name: 'manifest.json', data: JSON.stringify({
      id: 'stack-app', name: '堆叠台', version: '0.1.0', entry: 'main.js', icon: 'icon.svg', api: 1, permissions: [],
    }) },
    { name: 'main.js', data: MAIN },
    { name: 'icon.svg', data: ICON },
  ]);
  await apps.installPackage(second, { locale: 'zh' });
  await apps.writeStorage('note-book', { keep: true });
  await apps.uninstallApp('stack-app');
  const list = await apps.listApps('zh');
  if (list.length === 1 && list[0].id === 'note-book') ok('卸载另一个，这个还在');
  else bad('卸载另一个，这个还在', JSON.stringify(list.map((one) => one.id)));
  const value = await apps.readStorage('note-book');
  if (value && value.keep === true) ok('被卸载的应用没碰别人的私有存储');
  else bad('被卸载的应用没碰别人的私有存储', JSON.stringify(value));
  const fresh = packageOf([
    { name: 'manifest.json', data: JSON.stringify({
      id: 'no-perm', name: '没权限的', version: '0.1.0', entry: 'main.js', icon: 'icon.svg', api: 1, permissions: [],
    }) },
    { name: 'main.js', data: MAIN },
    { name: 'icon.svg', data: ICON },
  ]);
  await apps.installPackage(fresh, { locale: 'zh' });
  await expectThrow('没申 storage 时读写被拦', async () => {
    const m = await apps.readManifest('no-perm');
    apps.assertPermission(m, 'storage');
  }, '没有申请存储权限');
}

console.log('\n=== 8. 排序按安装时间 ===');
{
  const list = await apps.listApps('zh');
  const ids = list.map((one) => one.id);
  if (ids.join(',') === 'note-book,no-perm') ok('先装的在前', ids.join(' → '));
  else bad('先装的在前', ids.join(' → '));
}

await rm(scratch, { recursive: true, force: true });
console.log('\n通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
  for (const one of failures) console.log('  - ' + one);
  process.exit(1);
}
