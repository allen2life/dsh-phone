// 示例应用：便签本。
// 这是手机自己带的示例包，用来证明「导入 → 桌面出现图标 → 点开能跑 → 能返回 → 能卸载」这条路是通的。
// 它只干两件事：显示一句话、把自己的设置存进私有存储（任务书 12 章的建议）。
//
// 应用契约（任务书 9.4）：交出一个挂载函数，收到 ctx，必须返回卸载函数。
// 这里不用 React，直接往 ctx.root 里画 DOM——契约没要求用 React，只用 DOM 也能跑。
module.exports = function mount(ctx) {
  var doc = ctx.root.ownerDocument || document;
  var texts = {
    zh: {
      title: '便签本',
      hint: '在下面写一句话，它会被记住。\n关掉手机再打开，这句话还在。',
      placeholder: '写点什么…',
      saved: '已保存',
      saving: '保存中…',
      empty: '还没写过东西',
      locale: '当前语言',
      theme: '当前主题',
      permission: '这个应用没有申请存储权限，所以记不住东西。',
    },
    en: {
      title: 'Notebook',
      hint: 'Write a line below and it will be remembered.\nClose the phone and open it again — it is still here.',
      placeholder: 'Write something…',
      saved: 'Saved',
      saving: 'Saving…',
      empty: 'Nothing written yet',
      locale: 'Language',
      theme: 'Theme',
      permission: 'This app has no storage permission, so nothing can be remembered.',
    },
  };

  var locale = ctx.locale === 'en' ? 'en' : 'zh';
  var theme = ctx.theme === 'dark' ? 'dark' : 'light';
  var t = texts[locale];

  var wrap = doc.createElement('div');
  wrap.style.cssText = [
    'box-sizing:border-box',
    'height:100%',
    'padding:14px',
    'display:flex',
    'flex-direction:column',
    'gap:8px',
    'font-size:12px',
    'color:var(--dsw-alias-label-primary)',
  ].join(';');

  var title = doc.createElement('div');
  title.textContent = t.title;
  title.style.cssText = 'font-size:13px;font-weight:600';

  var hint = doc.createElement('div');
  hint.textContent = t.hint;
  hint.style.cssText = 'font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap';

  var input = doc.createElement('textarea');
  input.placeholder = t.placeholder;
  input.style.cssText = [
    'box-sizing:border-box',
    'width:100%',
    'min-height:72px',
    'resize:none',
    'padding:8px',
    'border-radius:8px',
    'font-size:12px',
    'line-height:18px',
    'font-family:inherit',
    'color:var(--dsw-alias-label-primary)',
    'background:var(--dsw-alias-bg-layer-2)',
    'border:1px solid var(--dsw-alias-border-l1)',
    'outline:none',
  ].join(';');

  var note = doc.createElement('div');
  note.style.cssText = 'font-size:10px;line-height:15px;color:var(--dsw-alias-label-caption);min-height:15px';

  var meta = doc.createElement('div');
  meta.style.cssText = 'margin-top:auto;font-size:10px;line-height:15px;color:var(--dsw-alias-label-caption)';

  wrap.appendChild(title);
  wrap.appendChild(hint);
  wrap.appendChild(input);
  wrap.appendChild(note);
  wrap.appendChild(meta);

  var saveTimer = 0;
  var disposed = false;

  function renderMeta() {
    var lines = [t.locale + '：' + locale, t.theme + '：' + theme];
    if (!hasStorage) lines.push(t.permission);
    meta.textContent = lines.join('\n');
    meta.style.whiteSpace = 'pre-wrap';
  }

  // 手机现在会直接把清单里那份权限告诉应用，不用"先调一次、被拒了再改界面"。
  // 老手机没有这个字段时（permissions 不是数组）就当作有，行为跟以前一样。
  var hasStorage = !Array.isArray(ctx.permissions) || ctx.permissions.indexOf('storage') >= 0;

  // 读一次自己的私有设置：把上次写的那句话放回来。
  if (hasStorage && typeof ctx.storage.get === 'function') {
    ctx.storage.get().then(
      function (value) {
        if (disposed) return;
        if (value && typeof value.text === 'string') {
          input.value = value.text;
          note.textContent = t.saved;
        } else {
          note.textContent = t.empty;
        }
      },
      function (error) {
        if (disposed) return;
        hasStorage = false;
        note.textContent = (error && error.message) || t.permission;
        renderMeta();
      },
    );
  }

  input.addEventListener('input', function () {
    note.textContent = t.saving;
    window.clearTimeout(saveTimer);
    // 停手半秒再存，边打边存没意义
    saveTimer = window.setTimeout(function () {
      if (disposed || typeof ctx.storage.set !== 'function') return;
      ctx.storage.set({ text: input.value }).then(
        function () {
          if (!disposed) note.textContent = t.saved;
        },
        function (error) {
          if (!disposed) note.textContent = (error && error.message) || t.permission;
        },
      );
    }, 500);
  });

  var offChange = ctx.onChange(function (snapshot) {
    if (disposed || snapshot === null || typeof snapshot !== 'object') return;
    if (snapshot.locale === 'zh' || snapshot.locale === 'en') {
      locale = snapshot.locale;
      t = texts[locale];
      title.textContent = t.title;
      hint.textContent = t.hint;
      input.placeholder = t.placeholder;
    }
    if (typeof snapshot.theme === 'string') theme = snapshot.theme;
    renderMeta();
  });

  renderMeta();
  ctx.root.appendChild(wrap);

  return function unmount() {
    disposed = true;
    window.clearTimeout(saveTimer);
    if (typeof offChange === 'function') offChange();
    if (wrap.parentNode !== null) wrap.parentNode.removeChild(wrap);
  };
};
