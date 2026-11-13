import { readFile } from 'node:fs/promises';
import { readZip } from '../lib/zip.js';

const buffer = await readFile(process.argv[2]);
const files = readZip(buffer);
console.log('条目：', [...files.keys()].join(' '));
const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
console.log('清单：', JSON.stringify(manifest));
const main = files.get('main.js').toString('utf8');
console.log('main.js 长度：', main.length, '开头：', main.slice(0, 40).replace(/\n/g, ' '));
console.log('icon.svg 长度：', files.get('icon.svg').length);
// 也验一下系统自带工具能不能认（PowerShell 的 ZipFile）
