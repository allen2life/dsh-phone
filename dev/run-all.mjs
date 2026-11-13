// 一次跑完四份测试。任何一份有失败，退出码就不是 0。
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = [
  ['host-test.mjs', '宿主半：解压、校验、装卸、存储、路径穿越'],
  ['host-http-test.mjs', '宿主 HTTP 接口：方法分派与边界'],
  ['client-smoke.mjs', '界面半：注册、结构、尺寸、契约字段'],
  ['e2e-test.mjs', '端到端：真装包、真跑应用、真存盘'],
];

let failed = 0;
for (const [file, label] of suites) {
  console.log('\n### ' + label + ' (' + file + ')');
  const run = spawnSync(process.execPath, [file], { cwd: here, stdio: 'inherit' });
  if (run.status !== 0) {
    failed += 1;
    console.log('  ✗ 这一份没通过：' + file);
  }
}

console.log('\n' + (failed === 0 ? '全部通过。' : failed + ' 份没通过。'));
process.exit(failed === 0 ? 0 : 1);
