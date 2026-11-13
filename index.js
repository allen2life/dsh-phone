// 宿主半：解压、校验、安装卸载、应用私有存储、替应用转后端请求。
// 界面一个字都不在这里画；所有落盘的事都在这里做。
//
// 只开一个前缀路由 /dsh-phone，用 { method, params } 分派，
// 和这台机器上已有的音乐插件保持同一种形状，界面半好写。
import {
  AppError,
  DATA_ROOT,
  assertPermission,
  installPackage,
  listApps,
  readAppSource,
  readManifest,
  readStorage,
  uninstallApp,
  writeStorage,
} from './lib/apps.js';
import { backendReady, forwardCall } from './lib/forward.js';

const ROUTE_PATH = '/dsh-phone';
const API_PATH = '/dsh-phone/api';
/** 一个应用包撑死几十兆，留够余量。 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error('文件太大了（最多 64MB）'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** 把内部错误翻成一句人话；界面直接把它显示给用户。 */
function describe(error) {
  if (error instanceof AppError) return { ok: false, error: error.message, code: error.code };
  const message = error && error.message ? String(error.message) : String(error);
  return { ok: false, error: message };
}

function asId(value) {
  return typeof value === 'string' ? value : '';
}

function createMethods(ctx) {
  return {
    /** 界面半用它确认宿主半起来了。 */
    async ping() {
      return { ok: true, data: { alive: true, root: DATA_ROOT } };
    },



    async 'apps.list'(params) {
      const locale = params && params.locale === 'en' ? 'en' : 'zh';
      const apps = await listApps(locale);
      // 顺带告诉界面每个应用的后端现在在不在，桌面好标「需要后端」。
      const withBackend = apps.map((app) => ({
        ...app,
        backendReady: app.backend === '' ? true : backendReady(ctx, app.backend),
      }));
      return { ok: true, data: { apps: withBackend } };
    },

    async 'apps.source'(params) {
      const app = await readAppSource(asId(params && params.id));
      return { ok: true, data: app };
    },

    async 'apps.install'(params) {
      const encoded = params && typeof params.data === 'string' ? params.data : '';
      if (encoded === '') return { ok: false, error: '没有收到文件内容' };
      let buffer;
      try {
        buffer = Buffer.from(encoded, 'base64');
      } catch {
        return { ok: false, error: '文件内容读不出来，可能传坏了' };
      }
      if (buffer.length === 0) return { ok: false, error: '这个文件是空的' };
      const locale = params && params.locale === 'en' ? 'en' : 'zh';
      try {
        const result = await installPackage(buffer, {
          overwrite: params && params.overwrite === true,
          locale,
        });
        return { ok: true, data: result };
      } catch (error) {
        if (error instanceof AppError && error.code === 'already-exists') {
          return { ok: false, code: 'already-exists', error: error.message, existing: error.existing };
        }
        throw error;
      }
    },

    async 'apps.uninstall'(params) {
      const result = await uninstallApp(asId(params && params.id));
      return { ok: true, data: result };
    },

    async 'storage.get'(params) {
      const id = asId(params && params.id);
      const manifest = await readManifest(id);
      assertPermission(manifest, 'storage');
      const value = await readStorage(id);
      return { ok: true, data: { value } };
    },

    async 'storage.set'(params) {
      const id = asId(params && params.id);
      const manifest = await readManifest(id);
      assertPermission(manifest, 'storage');
      const value = await writeStorage(id, params ? params.value : null);
      return { ok: true, data: { value } };
    },

    /** 应用的后端请求：权限、backend、转发全在宿主半。 */
    async 'app.call'(params) {
      const id = asId(params && params.id);
      const method = params && typeof params.method === 'string' ? params.method : '';
      const payload = await forwardCall(ctx, id, method, params ? params.params : undefined);
      return { ok: true, data: payload };
    },
  };
}

function createHandler(ctx) {
  const methods = createMethods(ctx);
  return async function handle(request, response) {
    const pathname = String(request.url || '').split('?')[0];
    if (pathname !== API_PATH) {
      sendJson(response, 404, { ok: false, error: '没有这个路径' });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: '只接受 POST' });
      return;
    }
    let payload;
    try {
      const body = await readBody(request);
      const text = body.toString('utf8');
      payload = text === '' ? {} : JSON.parse(text);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: '请求体不是合法 JSON：' + (error && error.message ? error.message : '解析失败') });
      return;
    }
    const name = String(payload.method || '');
    const handler = methods[name];
    if (typeof handler !== 'function') {
      sendJson(response, 200, { ok: false, error: '没有这个方法：' + name });
      return;
    }
    try {
      const result = await handler(payload.params || {});
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 200, describe(error));
    }
  };
}

/** Web 服务就绪时才注册；服务被替换时自动重挂。 */
export const inject = ['webServer'];

export function apply(ctx) {
  const handler = createHandler(ctx);
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler }),
    'dsh-phone: 宿主接口',
  );

}