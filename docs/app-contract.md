# 应用接口契约

这份文档是手机和应用之间唯一的约定。写应用的人只看这一份就够。

接口版本：`api: 1`。手机只认 1，别的版本会在安装时被拒绝。

---

## 一、应用包长什么样

普通 zip，后缀改成 `.dshapp`：

```
我的应用.dshapp
├── manifest.json    必须有
├── main.js          必须有，入口
└── icon.svg         必须有（svg / png / jpg / webp 都行）
```

内嵌文件夹可以，但入口和图标按 `manifest.json` 里写的相对路径找。

### manifest.json

```json
{
  "id": "my-app",
  "name": { "zh": "我的应用", "en": "My App" },
  "version": "1.0.0",
  "entry": "main.js",
  "icon": "icon.svg",
  "api": 1,
  "permissions": ["storage"],
  "description": "一句话介绍，可以省。"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 小写英文、数字、连字符，不能以连字符开头，最多 64 字 |
| `name` | 是 | 字符串，或者 `{ "zh": "...", "en": "..." }` |
| `version` | 是 | 版本号字符串 |
| `entry` | 是 | 入口文件名 |
| `icon` | 是 | 图标文件名 |
| `api` | 是 | 固定填 `1` |
| `permissions` | 是 | 数组，没有就写 `[]` |
| `backend` | 否 | 后端插件的路由前缀名，比如 `"dsh-music"` |
| `description` | 否 | 一句话，最多 200 字 |

写错任何一条，安装会被拒绝，并给一句能看懂的话说清哪里不行。**不会装一半。**

### 权限只有两种

| 权限 | 能用什么 |
|---|---|
| `storage` | 存自己的私有设置，卸载时一起删 |
| `host` | 调它 `backend` 指定的后端接口 |

只给清单里写了的。没写就调，直接抛错。

配了 `backend` 却忘了写 `host`，安装时就会被拒绝——这两个必须成对出现。

---

## 二、入口

`main.js` 是一个 CommonJS 小模块。它要交出一个挂载函数，这个函数**必须**返回卸载函数：

```js
module.exports = function mount(ctx) {
  // 往 ctx.root 里画
  return function unmount() {
    // 停定时器、停音频、清 DOM、取消订阅
  };
};
```

手机在三种情况下会调卸载函数：回桌面、手机收起（放歌例外）、卸载应用。

**挂载函数不返回卸载函数，手机会拒绝打开这个应用**，并告诉你原因。

`main.js` 能拿到什么：

- 只有 `react`（手机给的那一份），以及手机确实提供时的 `react-dom`
- 别的一律拿不到：`require('fs')`、`require('axios')` 都会抛错

**不许自己带 React。** 页面里有两份 React 会直接崩。

---

## 三、手机交给应用的东西

完整清单，就这十样，多一个都没有。

### 1. `ctx.root`

一块空的 `<div>`，应用往里面画。挂载那一刻它已经在内屏里，量得到 **264 × 340**，内容超出用滚动。

```js
console.log(ctx.root.getBoundingClientRect().width); // 264
```

### 2. `ctx.react`

手机那一份 React。用它可以，但不能自带。

```js
const h = ctx.react.createElement;
```

### 3. `ctx.reactDOM`

把 React 树真正挂进 DOM 的渲染器。手机上就是 React 那一版 `react-dom`。

**可能是 `null`**（宿主没提供时），用之前必须判：

```js
if (!ctx.reactDOM) throw new Error('手机没给 react-dom');
const root = ctx.reactDOM.createRoot(ctx.root);
root.render(h('div', null, '你好'));
```

卸载时记得 `root.unmount()`。

### 4. `ctx.api.call(方法名, 参数)`

调自己的后端，返回 Promise。

```js
const data = await ctx.api.call('search', { word: '海' });
```

背后发生的事：

1. 手机查这个应用有没有申 `host` 权限，有没有配 `backend`
2. 由**宿主半**（Node 那一侧）向 `/<backend>/api` 发一个 POST：

   ```json
   { "method": "search", "params": { "word": "海" } }
   ```

3. 把对方回的 JSON **原样**交给你

**两种失败要分开看：**

| 情况 | 你会得到什么 |
|---|---|
| 后端正常回了个失败（比如 `{"ok": false, "error": "..."}`） | 原样交给你，**不抛错**，自己判 |
| 没申 `host` 权限 / 没配 `backend` | 抛错 |
| 后端没起来、超时、回的不是 JSON | 抛错 |

所以应用里要 `try/catch` 包住，再判返回内容里的 `ok`。

请求**不可能**由应用自己发出去——这一条是硬规矩。

### 5. `ctx.storage.get()` / `ctx.storage.set(值)`

应用自己的私有设置。返回值就是上次存的东西，从没存过是 `null`。

```js
const saved = await ctx.storage.get();           // { count: 3 } 或 null
await ctx.storage.set({ count: 4 });
```

行为要说清楚，不然会踩：

- 存的是**一整份**，不是按键。每次 `set` 覆盖全部。
- 上限 **1MB**（按存进去的 JSON 字节数算），超了会抛错。
- 每次读写都是**一次网络往返**（几十毫秒），不要每敲一个字就存一次。攒一下再存。
- 卸载应用时这份数据一起删掉，不给恢复。
- 每个应用只能碰自己那一份。

### 6. `ctx.locale`

当前语言，`'zh'` 或 `'en'`。**是活的**，每次读都是最新值。

### 7. `ctx.theme`

当前主题，`'light'` 或 `'dark'`。同样是活的。

应用里的颜色建议直接用 DSH 的主题变量（`var(--dsw-alias-*)`），那样跟着主题走，不用自己判。这个字段留给画布、图表这类必须知道明暗的东西。

### 8. `ctx.onChange(回调)`

语言或主题变了通知你。返回一个取消订阅的函数。

回调收到一个对象，**只有两个字段**：

```js
const off = ctx.onChange(({ locale, theme }) => {
  // 重画
});
// 卸载时
off();
```

没有别的字段，也不会有别的事件。定时器、数据刷新这类事应用自己管。

### 9. `ctx.permissions`

清单里那句 `permissions` 的原样副本，只读数组。

```js
const canStore = ctx.permissions.includes('storage');
if (canStore) {
  // 画带保存功能的界面
} else {
  // 画一个说明：这个应用没要存储权限
}
```

有了它，就不用"先调一次、被拒了再改界面"。

### 10. `ctx.setPlaying(真 / 假)`

告诉手机"我这边还在出声，收起手机别把我关掉"。

```js
await audio.play();
ctx.setPlaying(true);

// 暂停、放完、切走的时候
ctx.setPlaying(false);
```

四条规则：

1. 默认是假。重复调同一件事，结果一样。
2. **只有"收起手机"这一个动作看它。** 回桌面、切到别的应用、卸载、关页面，一样照常卸载。
3. 它拦不住卸载，也不能让应用在手机没打开的时候启动。
4. 手机另外还会自己听一遍（包了一层 `window.Audio`，也查容器里的 `audio`/`video` 标签）。两个只要有一个说在响，就留着。所以不认识这条的老应用也不会坏。

手机收起但应用还在跑的时候，圆按钮上会点一个小圆点提示。

---

## 四、应用不能做的事

| 不行 | 为什么 |
|---|---|
| 自带 React | 页面里两份 React 会崩 |
| 改手机的界面结构 | 只在自己那块 `ctx.root` 里画 |
| 一次开多个应用 | 手机就是这么设计的 |
| 自己发网络请求 | 要什么跟 `ctx.api.call` 说，由宿主半去要 |
| 读写文件 | 只通过 `ctx.storage`，而且只有自己那一份 |

---

## 五、尺寸

内屏固定 **264 × 340**。写死就好，不用量，也不用做响应式——它不会变。

顶栏高 30，由手机画，应用画不到那里。

---

## 六、最小可跑的例子

```js
// main.js
module.exports = function mount(ctx) {
  const box = document.createElement('div');
  box.style.cssText = 'padding:16px;font:13px/1.6 sans-serif;color:var(--dsw-alias-label-primary)';
  box.textContent = '读设置中…';
  ctx.root.appendChild(box);

  let count = 0;
  const off = ctx.onChange(() => {
    box.dataset.locale = ctx.locale;
  });

  if (ctx.permissions.includes('storage')) {
    ctx.storage.get().then((saved) => {
      count = saved && typeof saved.count === 'number' ? saved.count : 0;
      box.textContent = '点了 ' + count + ' 次';
    });
  }

  box.addEventListener('click', () => {
    count += 1;
    box.textContent = '点了 ' + count + ' 次';
    if (ctx.permissions.includes('storage')) void ctx.storage.set({ count });
  });

  return function unmount() {
    off();
    ctx.root.removeChild(box);
  };
};
```

配一个 `manifest.json`（`permissions: ["storage"]`）和一个 48×48 的 `icon.svg`，打包就能装。

完整一点看 `apps-src/note-book/`。
