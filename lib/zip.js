// 最小 zip 读取器：只认 .dshapp 需要的两种压缩法（存储 / deflate），不引任何第三方库。
//
// 为什么自己写：任务书不许给 DSH 加第三方依赖，而应用包只是普通 zip。
// 安全底线全在这里：解出来的每个条目都要过一道路径检查，绝不写到应用目录外面。
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** 一个包里最多这么多条目，防止「一堆零字节文件」把解压拖死。 */
const MAX_ENTRIES = 512;
/** 单个条目解压后的上限。 */
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
/** 整个包解压后的上限。 */
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

function fail(message) {
  throw new ZipError(message);
}

/** 从尾部往前找中央目录结束记录。注释最长 65535 字节，所以最多回退这么多。 */
function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === SIG_EOCD) return offset;
  }
  return -1;
}

/**
 * 读出压缩包里的条目表。不写盘，只做解析，方便先校验再落盘。
 * @param {Buffer} buffer 整个压缩包
 * @returns {{ name: string, method: number, compressedSize: number, size: number, offset: number, isDirectory: boolean }[]}
 */
export function listEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) fail('这不是一个压缩包（文件太小）');
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) fail('这不是一个合法的 zip 压缩包（找不到中央目录）');

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const countOnDisk = buffer.readUInt16LE(eocd + 8);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  if (diskNumber !== 0 || centralDisk !== 0) fail('不支持分卷压缩包');
  if (count === 0xffff || centralOffset === 0xffffffff) fail('不支持 zip64 压缩包，请重新打包');
  if (count === 0) fail('压缩包是空的');
  if (count > MAX_ENTRIES) fail(`压缩包里文件太多（${count} 个，最多 ${MAX_ENTRIES} 个）`);
  if (countOnDisk !== count) fail('压缩包的条目数对不上，可能已经损坏');
  if (centralOffset + centralSize > buffer.length) fail('压缩包的中央目录越界，可能已经损坏');

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length) fail('压缩包的中央目录被截断了');
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) fail('压缩包的中央目录格式不对');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > buffer.length) fail('压缩包的条目名被截断了');

    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = rawName.toString(flags & 0x800 ? 'utf8' : 'utf8');
    if (flags & 0x1) fail(`压缩包里的「${name}」是加密的，不支持`);
    entries.push({
      name,
      method,
      compressedSize,
      size,
      offset: localOffset,
      isDirectory: name.endsWith('/') || name.endsWith('\\'),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * 把条目名收拾成一个安全的相对路径；不安全就抛错。
 * 这里是那条「硬要求」：包里的 ../../ 绝不能把文件写到应用目录外面。
 */
export function safeEntryPath(name) {
  if (typeof name !== 'string' || name === '') fail('压缩包里有一个没名字的条目');
  const unified = name.replace(/\\/g, '/');
  if (unified.startsWith('/')) fail(`压缩包里的「${name}」是绝对路径，不允许`);
  if (/^[a-zA-Z]:/.test(unified)) fail(`压缩包里的「${name}」带盘符，不允许`);
  if (unified.includes('\0')) fail('压缩包里有一个条目名带空字符');
  if (unified.includes(':')) fail(`压缩包里的「${name}」带冒号，不允许`);
  const parts = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') fail(`压缩包里的「${name}」想跳到上级目录，不允许`);
    parts.push(segment);
  }
  if (parts.length === 0) fail('压缩包里有一个条目名是空的');
  return parts.join('/');
}

/** 拿一个条目的原始字节。方法只支持 store(0) 和 deflate(8)。 */
function readEntryData(buffer, entry) {
  const offset = entry.offset;
  if (offset + 30 > buffer.length) fail(`「${entry.name}」的数据越界`);
  if (buffer.readUInt32LE(offset) !== SIG_LOCAL) fail(`「${entry.name}」的本地头格式不对`);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) fail(`「${entry.name}」的数据被截断了`);
  const raw = buffer.subarray(start, end);

  if (entry.method === 0) {
    if (raw.length > MAX_ENTRY_BYTES) fail(`「${entry.name}」太大了`);
    return Buffer.from(raw);
  }
  if (entry.method === 8) {
    let inflated;
    try {
      inflated = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch (error) {
      fail(`「${entry.name}」解压失败：${error && error.message ? error.message : String(error)}`);
    }
    return inflated;
  }
  fail(`「${entry.name}」用了不认识的压缩方式（${entry.method}），请用普通 zip 重新打包`);
}

/**
 * 解开整个包，返回 路径 → Buffer 的映射。目录条目跳过。
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
export function readZip(buffer) {
  const entries = listEntries(buffer);
  const files = new Map();
  let total = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const safe = safeEntryPath(entry.name);
    if (files.has(safe)) fail(`压缩包里「${safe}」出现了两次`);
    if (entry.size > MAX_ENTRY_BYTES) fail(`「${safe}」太大了（${entry.size} 字节）`);
    const data = readEntryData(buffer, entry);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) fail('压缩包解开以后太大了');
    files.set(safe, data);
  }
  if (files.size === 0) fail('压缩包里没有文件');
  return files;
}
