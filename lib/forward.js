// 替应用转后端请求。
//
// 为什么必须在宿主半：应用和界面跑在同一块页面地盘里，让页面自己 fetch 等于没有权限检查。
// 协议就是任务书 9.5 那一条：POST /<backend>/api，body { method, params }，回什么原样交回。
import { readManifest } from './apps.js';

/** 这个后端等多久算超时。 */
const FORWARD_TIMEOUT_MS = 45000;

class ForwardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForwardError';
  }
}

function fail(message) {
  throw new ForwardError(message);
}

/** 宿主自己的地址。端口可能被配置成别的，所以每次都从服务上读。 */
function originOf(ctx) {
  try {
    return ctx.webServer.getOrigin();
  } catch {
    return 'http://127.0.0.1:' + String(ctx.webServer.port || 19387);
  }
}

/** 后端这条路有没有人认领：插件没装或没开时，那条路由根本不存在。 */
export function backendReady(ctx, backend) {
  if (typeof backend !== 'string' || backend === '') return false;
  try {
    const route = ctx.webServer.match('/' + backend + '/api');
    return route !== undefined && route !== null;
  } catch {
    return false;
  }
}

/**
 * 应用调 ctx.api.call(方法名, 参数) 时，由这里代劳。
 * 权限判断全在这里做，界面半说了不算。
 */
export async function forwardCall(ctx, appId, method, params) {
  const manifest = await readManifest(appId);
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];

  if (!permissions.includes('host')) fail('这个应用没有申请访问后端的权限');
  const backend = typeof manifest.backend === 'string' ? manifest.backend.trim() : '';
  if (backend === '') fail('这个应用没有配置后端');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(backend)) fail('这个应用的 backend 名字不合法：' + backend);
  if (!backendReady(ctx, backend)) {
    fail('这个应用需要的后端插件（' + backend + '）现在没有运行，先把那个插件打开');
  }

  const name = typeof method === 'string' ? method.trim() : '';
  if (name === '') fail('调用后端时没给方法名');

  const url = originOf(ctx) + '/' + backend + '/api';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: name, params: params === undefined ? {} : params }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') fail('后端在 ' + Math.round(FORWARD_TIMEOUT_MS / 1000) + ' 秒内没有回话');
    fail('连不上后端（' + backend + '）：' + (error && error.message ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => '');
  if (text.trim() === '') {
    fail('后端（' + backend + '）回了空内容（HTTP ' + response.status + '）');
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail('后端（' + backend + '）返回的不是 JSON（HTTP ' + response.status + '）');
  }
  // 原样交回：应用自己认 ok / data / error 这套。
  return payload;
}
