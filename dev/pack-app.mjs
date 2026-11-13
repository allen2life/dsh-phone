// 把 apps-src/<应用>/ 打成一个 .dshapp（就是普通 zip，只改后缀）。
// 用法：node dev/pack-app.mjs note-book
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './make-zip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const name = process.argv[2];
if (!name) {
  console.error('要一个应用目录名，例如 note-book');
  process.exit(2);
}

const sourceDir = path.join(repoRoot, 'apps-src', name);
const entries = [];

async function walk(dir, prefix) {
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    const rel = prefix === '' ? dirent.name : prefix + '/' + dirent.name;
    if (dirent.isDirectory()) {
      await walk(full, rel);
      continue;
    }
    entries.push({ name: rel, data: await readFile(full) });
  }
}

await walk(sourceDir, '');
entries.sort((a, b) => a.name.localeCompare(b.name));

const needed = ['manifest.json', 'main.js', 'icon.svg'];
for (const file of needed) {
  if (!entries.some((entry) => entry.name === file)) {
    console.error('缺少必需文件：' + file);
    process.exit(1);
  }
}

const buffer = makeZip(entries);
const outDir = path.join(repoRoot, 'dist');
await stat(outDir).then(null, async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(outDir, { recursive: true });
});
const outFile = path.join(outDir, name + '.dshapp');
await writeFile(outFile, buffer);
console.log('打好了：' + outFile);
console.log('大小：' + buffer.length + ' 字节，' + entries.length + ' 个文件：' + entries.map((entry) => entry.name).join(' '));
