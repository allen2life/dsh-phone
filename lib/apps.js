// 应用登记表 + 安装/卸载 + 私有存储。
//
// 位置约定（任务书 11 章）：都落在 DSH 主目录下，不在插件代码目录里，
// 这样换插件版本、重装插件，装过的应用还在。
//
//   <DSH 主目录>/dsh-phone/apps/<应用id>/     一个应用一个文件夹（清单、入口、图标）
//   <DSH 主目录>/dsh-phone/apps/<应用id>.json  这个应用的私有设置（卸载时一起删）
//   <DSH 主目录>/dsh-phone/phone.json          手机的设置：每个应用是什么时候装的
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { listEntries, readZip, safeEntryPath } from './zip.js';

const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh');
export const DATA_ROOT = path.join(DSH_HOME, 'dsh-phone');
export const APPS_DIR = path.join(DATA_ROOT, 'apps');
export const PHONE_FILE = path.join(DATA_ROOT, 'phone.json');

/** 本轮只认这一个接口版本。 */
const API_VERSION = 1;
/** 允许的权限，清单里写了没在这个表里的直接判错。 */
const ALLOWED_PERMISSIONS = new Set(['storage', 'host']);
/** 图标最大字节数。 */
const MAX_ICON_BYTES = 512 * 1024;
/** 私有存储单份最大字节数。 */
const MAX_STORAGE_BYTES = 1024 * 1024;
const ICON_MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** 能直接给用户看的错误：message 就是人话，不用再翻译。 */
export class AppError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AppError';
    this.code = code || 'app-error';
  }
}

function fail(message, code) {
  throw new AppError(message, code);
}

// ── 手机的设置 ──────────────────────────────────────────────

function emptyPhone() {
  return { version: 1, apps: {} };
}

export async function loadPhone() {
  try {
    const raw = await readFile(PHONE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const apps = parsed && typeof parsed.apps === 'object' && parsed.apps !== null ? parsed.apps : {};
    return { version: 1, apps };
  } catch {
    return emptyPhone();
  }
}

export async function savePhone(next) {
  await mkdir(DATA_ROOT, { recursive: true });
  const temporary = PHONE_FILE + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
  try {
    await rename(temporary, PHONE_FILE);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return next;
}

// ── 清单校验 ────────────────────────────────────────────────

function cleanText(value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 名字可以是字符串，也可以是 { zh, en }。 */
function resolveName(value, locale) {
  if (typeof value === 'string') return { zh: cleanText(value, 40), en: cleanText(value, 40) };
  if (value !== null && typeof value === 'object') {
    return { zh: cleanText(value.zh, 40), en: cleanText(value.en, 40) };
  }
  return { zh: '', en: '' };
}

function nameFor(names, locale) {
  if (locale === 'en') return names.en || names.zh;
  return names.zh || names.en;
}

/**
 * 校验清单。这里每一句报错都是给用户看的，必须说清哪个字段不对。
 * @returns 清洗后的清单
 */
export function normalizeManifest(raw) {
  if (raw === null || typeof raw !== 'object') fail('manifest.json 不是一个对象');

  const id = cleanText(raw.id, 64);
  if (id === '') fail('manifest.json 少了 id');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('应用 id 只能用小写英文、数字和连字符，且不能以连字符开头：' + id);

  const names = resolveName(raw.name);
  if (names.zh === '' && names.en === '') fail('manifest.json 少了 name');

  const version = cleanText(raw.version, 32);
  if (version === '') fail('manifest.json 少了 version');

  const entry = cleanText(raw.entry, 160);
  if (entry === '') fail('manifest.json 少了 entry');

  const icon = cleanText(raw.icon, 160);
  if (icon === '') fail('manifest.json 少了 icon');

  if (raw.api === undefined || raw.api === null) fail('manifest.json 少了 api（本轮固定填 1）');
  if (String(raw.api) !== String(API_VERSION)) fail('这个应用要的接口版本是 ' + String(raw.api) + '，手机只认 1');

  if (!Array.isArray(raw.permissions)) fail('manifest.json 的 permissions 必须是一个数组（没有权限就写 []）');
  const permissions = [];
  for (const item of raw.permissions) {
    const name = cleanText(item, 24);
    if (!ALLOWED_PERMISSIONS.has(name)) fail('不认识的权限：' + name + '（本轮只有 storage 和 host）');
    if (!permissions.includes(name)) permissions.push(name);
  }

  let backend = '';
  if (raw.backend !== undefined && raw.backend !== null && String(raw.backend).trim() !== '') {
    backend = cleanText(raw.backend, 64);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(backend)) fail('backend 应该是后端插件的路由前缀名，比如 dsh-music');
    if (!permissions.includes('host')) fail('清单里配了 backend，但权限里没写 host，这个应用调不了后端');
  }

  const description = typeof raw.description === 'string' ? cleanText(raw.description, 200) : '';

  return {
    id,
    name: names,
    displayName: nameFor(names, 'zh'),
    version,
    entry,
    icon,
    api: API_VERSION,
    permissions,
    backend,
    description,
  };
}

function hostDisplayName(manifest) {
  return manifest.name.zh || manifest.name.en || manifest.id;
}

// ── 读盘 ────────────────────────────────────────────────────

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function iconMimeOf(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ICON_MIME[ext] || '';
}

async function iconDataUri(appDir, iconName) {
  const mime = iconMimeOf(iconName);
  if (mime === '') return '';
  try {
    const data = await readFile(path.join(appDir, iconName));
    if (data.length > MAX_ICON_BYTES) return '';
    return 'data:' + mime + ';base64,' + data.toString('base64');
  } catch {
    return '';
  }
}

/** 从磁盘把一个应用读成桌面要用的那一份（不含代码）。 */
async function readInstalled(id) {
  const appDir = path.join(APPS_DIR, id);
  const manifest = await readJsonFile(path.join(appDir, 'manifest.json'));
  if (manifest === null) return null;
  const info = {
    ...manifest,
    iconData: await iconDataUri(appDir, manifest.icon),
  };
  return info;
}

// ── 对外：列应用 ────────────────────────────────────────────

export async function listApps(locale) {
  await mkdir(APPS_DIR, { recursive: true });
  let dirents = [];
  try {
    dirents = await readdir(APPS_DIR, { withFileTypes: true });
  } catch {
    dirents = [];
  }
  const phone = await loadPhone();
  const apps = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    if (dirent.name.startsWith('.')) continue;
    const info = await readInstalled(dirent.name);
    if (info === null) continue;
    const record = phone.apps[dirent.name];
    let installedAt = record && Number(record.installedAt) ? Number(record.installedAt) : 0;
    if (installedAt === 0) {
      try {
        const st = await stat(path.join(APPS_DIR, dirent.name));
        installedAt = Math.round(st.birthtimeMs || st.mtimeMs || 0);
      } catch {
        installedAt = 0;
      }
    }
    apps.push({
      id: info.id || dirent.name,
      name: info.name || { zh: dirent.name, en: dirent.name },
      displayName: nameFor(info.name || {}, locale || 'zh') || dirent.name,
      version: info.version || '',
      description: info.description || '',
      permissions: Array.isArray(info.permissions) ? info.permissions : [],
      backend: typeof info.backend === 'string' ? info.backend : '',
      icon: info.icon || '',
      iconData: info.iconData || '',
      installedAt,
    });
  }
  apps.sort((a, b) => (a.installedAt === b.installedAt ? a.id.localeCompare(b.id) : a.installedAt - b.installedAt));
  return apps;
}

// ── 对外：装一个应用 ────────────────────────────────────────

/** 先把包拆在内存里查一遍，任何一项不过就整包拒掉，磁盘一个字节都不写。 */
export function inspectPackage(buffer) {
  let files;
  try {
    files = readZip(buffer);
  } catch (error) {
    fail(error && error.message ? error.message : '这个文件不是一个能读的压缩包', 'zip');
  }

  const manifestBytes = files.get('manifest.json');
  if (manifestBytes === undefined) fail('压缩包里没有 manifest.json');

  let rawManifest;
  try {
    rawManifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    fail('manifest.json 不是合法的 JSON：' + (error && error.message ? error.message : '解析失败'));
  }
  const manifest = normalizeManifest(rawManifest);

  // 入口和图标要在包里，而且不能靠 ../ 跳出去（safeEntryPath 已经保证条目名安全）
  let entryName;
  let iconName;
  try {
    entryName = safeEntryPath(manifest.entry);
    iconName = safeEntryPath(manifest.icon);
  } catch (error) {
    fail(error && error.message ? error.message : 'entry 或 icon 的路径不合法');
  }
  if (!files.has(entryName)) fail('压缩包里找不到入口文件：' + manifest.entry);
  if (!files.has(iconName)) fail('压缩包里找不到图标文件：' + manifest.icon);
  if (iconMimeOf(iconName) === '') fail('图标只能是 svg、png、jpg 或 webp：' + manifest.icon);

  const iconBytes = files.get(iconName);
  if (iconBytes.length > MAX_ICON_BYTES) fail('图标文件太大了（最多 512KB）');

  const source = files.get(entryName).toString('utf8');
  if (source.trim() === '') fail('入口文件是空的：' + manifest.entry);

  return { manifest, files, entryName, iconName, source };
}

function isInsideApps(child) {
  const relative = path.relative(APPS_DIR, path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 装一个包。overwrite 为 false 而目标已存在时，抛一个带 already-exists 码的错误，
 * 由界面问用户「覆盖还是取消」。
 */
export async function installPackage(buffer, options) {
  const settings = options || {};
  const inspected = inspectPackage(buffer);
  const { manifest, files, entryName, iconName } = inspected;
  const id = manifest.id;

  await mkdir(APPS_DIR, { recursive: true });
  const targetDir = path.join(APPS_DIR, id);
  if (!isInsideApps(targetDir)) fail('应用 id 不安全：' + id);

  const existed = await stat(targetDir).then(() => true, () => false);
  if (existed && settings.overwrite !== true) {
    const message = '已经装过一个叫「' + hostDisplayName(manifest) + '」的应用了，要覆盖它吗？';
    const error = new AppError(message, 'already-exists');
    error.existing = { id, name: hostDisplayName(manifest) };
    throw error;
  }

  // 先写到旁边的临时目录，整个写完再改名过去：中途失败不会留下半个应用。
  const stagingDir = path.join(APPS_DIR, '.staging-' + id + '-' + Date.now().toString(36));
  if (!isInsideApps(stagingDir)) fail('临时目录不安全');
  await mkdir(stagingDir, { recursive: true });
  try {
    for (const [relative, data] of files) {
      const destination = path.join(stagingDir, relative);
      if (!isInsideApps(destination)) fail('压缩包里的「' + relative + '」想写到应用目录外面，已拒绝安装');
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, data);
    }
    if (existed) await rm(targetDir, { recursive: true, force: true });
    await rename(stagingDir, targetDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof AppError) throw error;
    fail('写入应用目录失败：' + (error && error.message ? error.message : String(error)));
  }

  // 记一笔安装时间；覆盖安装保留原来的顺序，桌面不会因为重装而换位。
  const phone = await loadPhone();
  // 覆盖安装保留原来的安装时间，桌面上的位置不会因为重装而换。
  if (!phone.apps[id]) phone.apps[id] = { installedAt: Date.now() };
  phone.apps[id].version = manifest.version;
  phone.apps[id].entry = entryName;
  phone.apps[id].icon = iconName;
  await savePhone(phone);

  return {
    id,
    name: manifest.name,
    displayName: nameFor(manifest.name, settings.locale || 'zh'),
    version: manifest.version,
    replaced: existed,
  };
}

// ── 对外：卸载 ──────────────────────────────────────────────

export async function uninstallApp(id) {
  const key = cleanText(id, 64);
  if (key === '') fail('没说要卸载哪个应用');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) fail('应用 id 不合法：' + key);
  const appDir = path.join(APPS_DIR, key);
  if (!isInsideApps(appDir)) fail('应用 id 不安全：' + key);

  const existed = await stat(appDir).then(() => true, () => false);
  const storageFile = path.join(APPS_DIR, key + '.json');
  const hadStorage = await stat(storageFile).then(() => true, () => false);
  if (!existed && !hadStorage) fail('这个应用已经不在手机里了', 'not-installed');

  await rm(appDir, { recursive: true, force: true });
  await unlink(storageFile).catch(() => {});

  const phone = await loadPhone();
  if (phone.apps[key] !== undefined) {
    delete phone.apps[key];
    await savePhone(phone);
  }
  return { id: key };
}

// ── 对外：应用代码 ──────────────────────────────────────────

/** 界面半靠这个拿到应用入口源码。代码只在这里读，界面半不碰文件系统。 */
export async function readAppSource(id) {
  const key = cleanText(id, 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) fail('应用 id 不合法：' + key);
  const appDir = path.join(APPS_DIR, key);
  if (!isInsideApps(appDir)) fail('应用 id 不安全：' + key);
  const manifest = await readJsonFile(path.join(appDir, 'manifest.json'));
  if (manifest === null) fail('这个应用没装好，找不到它的 manifest.json', 'not-installed');
  const entry = safeEntryPath(String(manifest.entry || ''));
  const source = await readFile(path.join(appDir, entry), 'utf8').catch(() => null);
  if (source === null) fail('这个应用的入口文件不见了：' + entry, 'not-installed');
  return {
    id: key,
    source,
    manifest: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
      backend: typeof manifest.backend === 'string' ? manifest.backend : '',
      description: typeof manifest.description === 'string' ? manifest.description : '',
    },
  };
}

// ── 对外：私有存储 ──────────────────────────────────────────

function storagePath(id) {
  const key = cleanText(id, 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) fail('应用 id 不合法：' + key);
  const file = path.join(APPS_DIR, key + '.json');
  if (!isInsideApps(file)) fail('应用 id 不安全：' + key);
  return file;
}

/** 私有存储在落盘前要确认权限，调用方负责传 manifest 里的 permissions。 */
export function assertPermission(manifest, permission) {
  const list = manifest && Array.isArray(manifest.permissions) ? manifest.permissions : [];
  if (!list.includes(permission)) {
    if (permission === 'storage') fail('这个应用没有申请存储权限，读不了也写不了自己的设置');
    if (permission === 'host') fail('这个应用没有申请访问后端的权限');
    fail('这个应用没有申请「' + permission + '」权限');
  }
}

export async function readStorage(id) {
  const file = storagePath(id);
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && 'value' in parsed ? parsed.value : null;
  } catch {
    return null;
  }
}

export async function writeStorage(id, value) {
  const file = storagePath(id);
  const body = JSON.stringify({ value: value === undefined ? null : value });
  if (Buffer.byteLength(body) > MAX_STORAGE_BYTES) fail('这个应用的私有设置太大了（最多 1MB）');
  await mkdir(APPS_DIR, { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  await writeFile(temporary, body, 'utf8');
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return value === undefined ? null : value;
}

/** 给转发模块用：拿到某个应用已装好的清单（含权限和后端前缀）。 */
export async function readManifest(id) {
  const key = cleanText(id, 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) fail('应用 id 不合法：' + key);
  const manifest = await readJsonFile(path.join(APPS_DIR, key, 'manifest.json'));
  if (manifest === null) fail('这个应用没装好，找不到它的 manifest.json', 'not-installed');
  return manifest;
}

/** 只给测试和排错用：包里的条目名列表。 */
export function listPackageEntries(buffer) {
  return listEntries(buffer).map((entry) => entry.name);
}
