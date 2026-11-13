// dsh-phone — 网页部分。
//
// 右下角一个小手机：点圆按钮开合，桌面排应用图标，点图标在屏幕里打开应用。
// 所有落盘的事（解压、装、卸、私有存储、转后端）都在宿主半，这里只画界面。
//
// 位置和让位规则照抄同目录的 dsh-music：贴着对话内容区右边界，右侧栏拉宽盖住
// 这条走廊时整体淡出；盯住内容区盒子的尺寸，位置直接写到节点上，不进 React 状态。
window.__ModuleLoader__.load({
  id: 'dsh-phone',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;

    // react-dom 只是「有就拿给应用」，手机自己的界面不用它；拿不到也不影响手机跑。
    let ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch (error) {
      ReactDOM = null;
    }

    // ────────────────────────────── 常量 ──────────────────────────────

    const API = '/dsh-phone/api';
    /** 右侧栏宽过这个数，说明这条走廊被占了，整个手机让位（和音乐插件同一阈值）。 */
    const COVERED_GAP = 420;
    /** 圆按钮底边离输入框下边缘的距离（和音乐插件同一数值）。 */
    const FAB_OFFSET = 20;
    /** 手机开合时长。 */
    const OPEN_MS = 150;
    /** 点图标进应用、返回桌面时的时长。 */
    const APP_MS = 180;
    /** 长按多久算长按。 */
    const HOLD_MS = 520;

    const DICT = {
      zh: {
        title: '小手机',
        desktop: '桌面',
        add: '装一个应用',
        close: '收起',
        back: '回到桌面',
        empty: '这里还没有应用',
        emptyHint: '点右上角 ＋ 选一个 .dshapp，或者直接把文件拖到手机上。',
        installing: '正在安装…',
        installed: '装好了',
        removed: '卸载掉了',
        uninstall: '卸载',
        cancel: '取消',
        replace: '覆盖',
        alreadyTitle: '已经有这个应用了',
        alreadyBody: (name) => '手机里已经装过一个叫「' + name + '」的应用。要覆盖它，还是取消？',
        removeTitle: '卸载这个应用',
        removeBody: (name) => '卸载「' + name + '」，它的设置也会一起删掉。别的应用不受影响。',
        needsBackend: '需要后端',
        needsBackendBody: (backend) =>
          '这个应用要靠后端插件「' + backend + '」干活，而它现在没有运行。\n先把 ' + backend + ' 那一行打开，再回来点它。',
        appFailed: '这个应用没起来',
        retry: '重试',
        notPackage: (name) => '只能装 .dshapp 文件，这个是「' + name + '」',
        readFailed: '这个文件读不出来',
        noUnmount: '这个应用没有交出卸载函数，手机不敢开它',
        hintTrust: '只装你信任的应用',
      },
      en: {
        title: 'Little phone',
        desktop: 'Home',
        add: 'Add an app',
        close: 'Collapse',
        back: 'Back to home',
        empty: 'No apps yet',
        emptyHint: 'Tap + above to pick a .dshapp, or drop the file onto the phone.',
        installing: 'Installing…',
        installed: 'Installed',
        removed: 'Uninstalled',
        uninstall: 'Uninstall',
        cancel: 'Cancel',
        replace: 'Replace',
        alreadyTitle: 'Already installed',
        alreadyBody: (name) => 'This phone already has an app called "' + name + '". Replace it, or cancel?',
        removeTitle: 'Uninstall this app',
        removeBody: (name) => 'Uninstall "' + name + '"? Its saved settings go too. Other apps are untouched.',
        needsBackend: 'Needs backend',
        needsBackendBody: (backend) =>
          'This app needs the backend plugin "' + backend + '", which is not running.\nTurn that plugin on, then come back.',
        appFailed: 'This app did not start',
        retry: 'Retry',
        notPackage: (name) => 'Only .dshapp files can be installed; this is "' + name + '"',
        readFailed: 'This file cannot be read',
        noUnmount: 'This app returned no unmount function, so the phone will not open it',
        hintTrust: 'Only install apps you trust',
      },
    };

    // ────────────────────────────── 样式 ──────────────────────────────
    // 颜色只用宿主的主题变量，浅色深色都跟着走；图标本身的颜色不算。
    const CSS = [
      /* 根：宽度和定位跟音乐插件的浮层一致，圆按钮才对得上同一个位置 */
      '.dphp-root{position:fixed;z-index:60;right:12px;bottom:96px;width:264px;pointer-events:none;',
      'opacity:1;transition:opacity 160ms ease-out}',
      '.dphp-root[data-hidden="true"]{opacity:0;pointer-events:none}',

      /* 圆按钮：40 x 40，贴在根层左上角，和音乐插件的圆按钮完全同一处 */
      '.dphp-fab{position:absolute;left:0;bottom:0;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;',
      'pointer-events:auto;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-secondary);box-shadow:0 2px 8px rgba(0,0,0,.10);',
      'transition:transform 120ms cubic-bezier(0.23,1,0.32,1),background-color 120ms ease,color 120ms ease,opacity 140ms ease-out;',
      'animation:dphp-fab-in 200ms cubic-bezier(0.23,1,0.32,1)}',
      '.dphp-fab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dphp-fab:active{transform:scale(0.94)}',
      '.dphp-fab[data-open="true"]{opacity:0;pointer-events:none}',
      '.dphp-fabdot{position:absolute;right:6px;top:6px;width:6px;height:6px;border-radius:50%;',
      'background:var(--dsw-alias-brand-primary);opacity:0;transition:opacity 160ms ease-out}',
      '.dphp-fabdot[data-on="true"]{opacity:1}',
      '@keyframes dphp-fab-in{from{opacity:0;transform:scale(0.9) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}',

      /* 整机外框：280 x 420，圆角 20，一圈细边框，里面就是屏幕。
         内边距 24 / 7 让 30 的顶栏和 264 x 340 的内屏正好落在框内。 */
      '.dphp-panel{position:absolute;right:0;bottom:0;width:280px;height:420px;box-sizing:border-box;',
      'padding:24px 7px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:20px;',
      'background:var(--dsw-alias-bg-overlay);pointer-events:auto;transform-origin:bottom right;',
      'box-shadow:0 16px 40px rgba(0,0,0,.20),0 2px 8px rgba(0,0,0,.10);',
      'transition:opacity 150ms ease-out,transform 150ms cubic-bezier(0.23,1,0.32,1)}',
      '.dphp-panel[data-open="false"]{opacity:0;transform:translateY(10px) scale(0.97);pointer-events:none}',
      '.dphp-panel[data-drag="true"]{border-color:var(--dsw-alias-brand-primary);',
      'box-shadow:0 0 0 2px var(--dsw-alias-brand-primary),0 16px 40px rgba(0,0,0,.20)}',

      /* 顶栏：左边说现在在哪，右边是操作按钮 */
      '.dphp-top{height:30px;flex:0 0 30px;display:flex;align-items:center;gap:2px;min-width:0}',
      '.dphp-topleft{display:flex;align-items:center;gap:2px;min-width:0;flex:1}',
      '.dphp-title{font-size:11px;line-height:30px;font-weight:600;color:var(--dsw-alias-label-primary);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dphp-btn{width:24px;height:24px;flex:0 0 auto;border:0;border-radius:8px;display:grid;place-items:center;',
      'background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;',
      'transition:background-color 120ms ease,color 120ms ease,transform 120ms cubic-bezier(0.23,1,0.32,1)}',
      '.dphp-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dphp-btn:active{transform:scale(0.92)}',

      /* 内屏：264 x 340，硬要求，音乐界面按这个尺寸画的 */
      '.dphp-screen{position:relative;width:264px;height:340px;flex:0 0 340px;overflow:hidden;',
      'border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',

      '.dphp-desktop{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;padding:10px}',
      '.dphp-desktop[data-show="false"]{display:none}',
      '.dphp-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px 6px}',
      '.dphp-slot{position:relative;min-width:0}',
      '.dphp-cell{display:flex;flex-direction:column;align-items:center;gap:4px;padding:0;width:100%;border:0;',
      'background:transparent;cursor:pointer;min-width:0;user-select:none;-webkit-user-select:none;',
      '-webkit-touch-callout:none;touch-action:manipulation}',
      '.dphp-icon{position:relative;width:48px;height:48px;border-radius:12px;overflow:hidden;display:grid;place-items:center;',
      'background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);',
      'transition:transform 120ms cubic-bezier(0.23,1,0.32,1)}',
      '.dphp-cell:hover .dphp-icon{transform:translateY(-1px)}',
      '.dphp-cell:active .dphp-icon{transform:scale(0.94)}',
      '.dphp-icon img{width:100%;height:100%;object-fit:cover;display:block}',
      '.dphp-name{max-width:100%;font-size:10px;line-height:12px;color:var(--dsw-alias-label-secondary);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}',
      '.dphp-badge{position:absolute;right:-3px;top:-3px;width:12px;height:12px;border-radius:50%;',
      'background:var(--dsw-alias-state-warn-primary);border:1.5px solid var(--dsw-alias-bg-layer-1)}',
      '.dphp-longmask{position:absolute;inset:0;display:grid;place-items:center;border-radius:12px;',
      'background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent)}',
      '.dphp-longbtn{border:0;border-radius:8px;padding:3px 7px;font-size:10px;line-height:14px;cursor:pointer;',
      'white-space:nowrap;background:var(--dsw-alias-state-error-primary);color:#fff}',

      '.dphp-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;gap:6px;padding:0 26px;text-align:center}',
      '.dphp-emptytitle{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dphp-emptyhint{font-size:10px;line-height:15px;color:var(--dsw-alias-label-caption)}',
      '.dphp-trust{margin-top:12px;text-align:center;font-size:9px;line-height:13px;',
      'color:var(--dsw-alias-label-caption);opacity:.75}',

      /* 应用窗口：占满整个内屏 */
      '.dphp-app{position:absolute;inset:0;background:var(--dsw-alias-bg-overlay);transform-origin:bottom right}',
      '.dphp-app[data-show="false"]{display:none}',
      '.dphp-applayer{position:absolute;inset:0}',
      '.dphp-appbody{position:absolute;inset:0;overflow:auto}',

      '.dphp-fail{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;gap:8px;padding:0 22px;text-align:center;background:var(--dsw-alias-bg-overlay)}',
      '.dphp-failtitle{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dphp-failbody{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);',
      'white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto}',
      '.dphp-failbtn{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:4px 12px;font-size:11px;',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}',

      '.dphp-toast{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);max-width:224px;',
      'padding:5px 10px;border-radius:10px;font-size:10px;line-height:15px;text-align:center;',
      'background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);',
      'color:var(--dsw-alias-label-primary);box-shadow:0 4px 12px rgba(0,0,0,.14);pointer-events:none;',
      'white-space:pre-wrap;word-break:break-word;animation:dphp-toast-in 140ms cubic-bezier(0.23,1,0.32,1)}',
      '@keyframes dphp-toast-in{from{opacity:0;transform:translate(-50%,4px)}to{opacity:1;transform:translate(-50%,0)}}',

      '.dphp-veil{position:absolute;inset:0;display:grid;place-items:center;',
      'background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 72%,transparent)}',
      '.dphp-dialog{width:224px;padding:12px;border-radius:12px;display:flex;flex-direction:column;gap:8px;',
      'background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);',
      'box-shadow:0 12px 28px rgba(0,0,0,.20)}',
      '.dphp-dialogtitle{font-size:12px;line-height:17px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dphp-dialogbody{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);',
      'white-space:pre-wrap;word-break:break-word}',
      '.dphp-dialogrow{display:flex;justify-content:flex-end;gap:6px}',
      '.dphp-ghost{border:1px solid var(--dsw-alias-border-l1);background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font-size:11px}',
      '.dphp-primary{border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);',
      'color:var(--dsw-alias-label-primary-foreground);border-radius:8px;padding:4px 10px;font-size:11px;cursor:pointer}',
      '.dphp-danger{border:1px solid var(--dsw-alias-state-error-primary);',
      'background:var(--dsw-alias-state-error-primary);color:#fff;border-radius:8px;padding:4px 10px;',
      'font-size:11px;cursor:pointer}',
      '.dphp-file{display:none}',

      /* 系统开了「减少动态效果」：只保留淡入淡出，不做缩放位移 */
      '@media (prefers-reduced-motion:reduce){',
      '.dphp-root,.dphp-panel,.dphp-fab,.dphp-icon{transition-duration:1ms!important}',
      '.dphp-panel[data-open="false"]{transform:none}',
      '.dphp-fab{animation:none!important}',
      '.dphp-toast{animation:none!important}',
      '.dphp-fab:active,.dphp-btn:active,.dphp-cell:active .dphp-icon,.dphp-cell:hover .dphp-icon{transform:none}',
      '}',
    ].join('\n');

    // ────────────────────────────── 宿主接口 ──────────────────────────────

    /**
     * 一问一答。宿主半永远回 { ok, data } 或 { ok: false, error }；
     * 网络本身断了也要合成同样形状，界面就不用写两套判断。
     */
    async function callHost(method, params) {
      let response;
      try {
        response = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, params: params === undefined ? {} : params }),
        });
      } catch (error) {
        return { ok: false, error: '连不上手机的服务端：' + (error && error.message ? error.message : String(error)) };
      }
      if (!response.ok) return { ok: false, error: '服务端回了 HTTP ' + response.status };
      let payload;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, error: '服务端返回的不是 JSON' };
      }
      if (payload === null || typeof payload !== 'object') return { ok: false, error: '服务端返回的内容看不懂' };
      return payload;
    }

    // ────────────────────────────── 主题与语言 ──────────────────────────────

    /**
     * 把宿主的语言和主题翻成手机要的两个值，并让界面能订阅变化。
     * 读不到服务就按页面语言和系统配色兜底，不让手机因为读不到就画不出来。
     */
    function createBridge(ctx) {
      const listeners = new Set();

      const readLocale = () => {
        try {
          const service = ctx.get('locale');
          const active = service && typeof service.getLocale === 'function' ? service.getLocale().active : '';
          if (typeof active === 'string' && active !== '') {
            return String(active).toLowerCase().startsWith('zh') ? 'zh' : 'en';
          }
        } catch {
          /* 退到页面语言 */
        }
        try {
          const lang = document.documentElement.lang || '';
          return String(lang).toLowerCase().startsWith('zh') ? 'zh' : 'en';
        } catch {
          return 'zh';
        }
      };

      const readTheme = () => {
        try {
          const service = ctx.get('theme');
          const snapshot = service && typeof service.getTheme === 'function' ? service.getTheme() : null;
          const scheme = snapshot && snapshot.active ? snapshot.active.colorScheme : '';
          if (scheme === 'dark' || scheme === 'light') return scheme;
        } catch {
          /* 退到系统配色 */
        }
        try {
          return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        } catch {
          return 'light';
        }
      };

      let state = { locale: readLocale(), theme: readTheme() };

      const publish = () => {
        const next = { locale: readLocale(), theme: readTheme() };
        if (next.locale === state.locale && next.theme === state.theme) return;
        state = next;
        for (const listener of listeners) {
          try {
            listener(state);
          } catch {
            /* 某个订阅抛了不影响别人 */
          }
        }
      };

      ctx.effect(() => {
        const offs = [];
        try {
          if (typeof ctx.on === 'function') offs.push(ctx.on('theme/change', publish));
        } catch {
          /* 没有这个事件就靠下面的低频对齐 */
        }
        try {
          if (typeof ctx.on === 'function') offs.push(ctx.on('locale/change', publish));
        } catch {
          /* 同上 */
        }
        try {
          const service = ctx.get('locale');
          if (service && typeof service.subscribe === 'function') offs.push(service.subscribe(publish));
        } catch {
          /* 同上 */
        }
        // 语言和主题最终都体现在 DOM 的 lang 属性和配色服务上，低频对一眼就够。
        const timer = window.setInterval(publish, 800);
        return () => {
          window.clearInterval(timer);
          for (const off of offs) {
            try {
              if (typeof off === 'function') off();
            } catch {
              /* 退订失败不用管 */
            }
          }
        };
      }, 'dsh-phone: 主题与语言');

      return {
        get state() {
          return state;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    // ────────────────────────────── 应用代码怎么跑 ──────────────────────────────

    /**
     * 把 main.js 的源码跑成一个挂载函数。
     * 应用是普通 CommonJS 小模块：module.exports = function mount(ctx) {...}。
     * 这里只给它 react（以及宿主确实有的 react-dom），别的一概拿不到。
     */
    function loadMountFunction(source, id) {
      const moduleObject = { exports: {} };
      const scopedRequire = (name) => {
        if (name === 'react') return React;
        if (name === 'react-dom' || name === 'react-dom/client') {
          if (ReactDOM !== null) return ReactDOM;
          throw new Error('这个应用要用 react-dom，但宿主没有提供');
        }
        throw new Error('应用只能拿到 react，拿不到「' + name + '」');
      };
      let factory;
      try {
        // 应用不许自带 React：它只能拿到上面那一个 require 里的这一份。
        factory = new Function(
          'module',
          'exports',
          'require',
          'console',
          source + '\n//# sourceURL=dshapp/' + id + '/main.js',
        );
      } catch (error) {
        throw new Error('应用代码有语法错误：' + (error && error.message ? error.message : String(error)));
      }
      factory(moduleObject, moduleObject.exports, scopedRequire, window.console);
      const exported = moduleObject.exports;
      if (typeof exported === 'function') return exported;
      if (exported && typeof exported.default === 'function') return exported.default;
      if (exported && typeof exported.mount === 'function') return exported.mount;
      throw new Error('入口没有交出挂载函数：module.exports 必须是一个函数');
    }

    /**
     * 盯着应用里正在响的媒体。
     *
     * 为什么要这么干：任务书 4.5 和第 8 章要求「音乐正在播放时，收起手机不能卸载它」，
     * 但应用契约（9.4）里没有「我在播」这条消息，应用也不会主动说。
     * 所以手机自己看：应用挂载期间新造出来的 Audio 实例，加上它容器里的 audio / video 标签，
     * 只要有一个在响，收起手机时就留着它。
     *
     * 只包应用挂载期间造出来的实例，卸载时立刻还原，不留痕迹给宿主。
     */
    function createMediaWatch() {
      const created = [];
      const original = window.Audio;

      const note = (media) => {
        if (media === null || media === undefined) return;
        if (created.indexOf(media) < 0) created.push(media);
      };

      if (typeof original === 'function') {
        try {
          const Wrapped = function Audio() {
            const instance = new original(...arguments);
            note(instance);
            return instance;
          };
          Wrapped.prototype = original.prototype;
          window.Audio = Wrapped;
        } catch {
          /* 包不上就只靠容器里那几个标签 */
        }
      }

      return {
        note,
        isPlaying(root) {
          for (const media of created) {
            try {
              if (media.paused === false) return true;
            } catch {
              /* 实例已经废了 */
            }
          }
          if (root !== null && root !== undefined) {
            let nodes = [];
            try {
              nodes = root.querySelectorAll('audio, video');
            } catch {
              nodes = [];
            }
            for (const node of nodes) {
              try {
                if (node.paused === false) return true;
              } catch {
                /* 同上 */
              }
            }
          }
          return false;
        },
        dispose() {
          if (typeof original === 'function') {
            try {
              window.Audio = original;
            } catch {
              /* 还原不了也就这样 */
            }
          }
          created.length = 0;
        },
      };
    }

    // ────────────────────────────── 小工具 ──────────────────────────────

    function reducedMotion() {
      try {
        return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch {
        return false;
      }
    }

    function svgIcon(path, size) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: path }),
      );
    }

    const ICON = {
      phoneBody: 'M7 2.5h10a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2Z',
      back: 'M15 5l-7 7 7 7',
      close: 'M6 6l12 12M18 6L6 18',
      plus: 'M12 5v14M5 12h14',
    };

    // ────────────────────────────── 手机 ──────────────────────────────

    function Phone({ ctx, bridge }) {
      const [env, setEnv] = useState(bridge.state);
      const [apps, setApps] = useState([]);
      const [open, setOpen] = useState(false);
      const [activeId, setActiveId] = useState('');
      const [appState, setAppState] = useState(''); // '' | 'loading' | 'running' | 'failed'
      const [appError, setAppError] = useState('');
      const [anim, setAnim] = useState(null);
      const [toast, setToast] = useState(null);
      const [dialog, setDialog] = useState(null);
      const [holdId, setHoldId] = useState('');
      const [dragging, setDragging] = useState(false);

      const rootRef = useRef(null);
      const screenRef = useRef(null);
      const layerRef = useRef(null);
      const inputRef = useRef(null);
      const mountedRef = useRef(null);
      const mediaRef = useRef(null);
      // 应用自己说的「我在出声」（契约里的 setPlaying），和 mediaRef 的探测取或。
      const playingRef = useRef(false);
      const originRef = useRef({ x: 0, y: 0 });
      const openRef = useRef(false);
      const activeRef = useRef('');
      const toastTimer = useRef(0);
      const holdTimer = useRef(0);
      const animTimer = useRef(0);
      const envRef = useRef(env);

      const locale = env.locale;
      const theme = env.theme;
      const t = DICT[locale] || DICT.zh;

      envRef.current = env;

      const app = useMemo(() => apps.find((one) => one.id === activeId) || null, [apps, activeId]);

      // ── 语言 / 主题变了就重画一次 ──
      useEffect(() => bridge.subscribe(setEnv), [bridge]);

      const say = useCallback((message) => {
        setToast(message);
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 3000);
      }, []);

      // ── 位置：贴着对话内容区右边界；右侧栏盖住走廊时整体淡出 ──
      // 和音乐插件同一套做法：盯住内容区那个盒子，位置直接写到节点上，不进 React 状态，
      // 这样右侧栏推拉时不会连带重渲染整棵树。
      useLayoutEffect(() => {
        let hiddenNow = null;
        let watched = null;

        const apply = () => {
          const node = rootRef.current;
          if (node === null) return;
          let right = 12;
          let bottom = 96;
          let hidden = false;
          try {
            // 和音乐插件用一模一样的取法：querySelector 取文档里第一个。
            // 不要改成「取面积最大」——页面里还有一个横向占满窗口的会话容器，
            // 按面积会选中它，算出来 gap 为 0，手机就贴到窗口最右边压住概览卡了。
            const content = document.querySelector('[data-conversation-content]');
            if (content !== null) {
              const rect = content.getBoundingClientRect();
              if (rect.width > 200 && rect.height > 80) {
                const gap = window.innerWidth - rect.right;
                right = Math.max(12, Math.round(gap + 12));
                hidden = gap > COVERED_GAP;
              }
            }
            // 竖直方向只认输入框的下边缘：输入框贴底，下边缘不会变；
            // 按它的高度或中线算，输入框一长高整块就往上飘。
            const composer = document.querySelector('[data-conversation-region="composer"]');
            if (composer !== null) {
              const rect = composer.getBoundingClientRect();
              if (rect.height > 40) bottom = Math.max(16, Math.round(window.innerHeight - rect.bottom + FAB_OFFSET));
            }
          } catch {
            /* 用默认值 */
          }
          node.style.right = right + 'px';
          node.style.bottom = bottom + 'px';
          if (hidden !== hiddenNow) {
            hiddenNow = hidden;
            node.setAttribute('data-hidden', hidden ? 'true' : 'false');
            // 被走廊挡住时连手机一起收起，拉回来才不会看见一个停在半路的界面。
            if (hidden && openRef.current) setOpen(false);
          }
        };

        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
        const watch = () => {
          const target = document.querySelector('[data-conversation-content]');
          if (observer === null || target === watched) return;
          if (watched !== null) observer.unobserve(watched);
          watched = target;
          if (watched !== null) observer.observe(watched);
        };

        watch();
        apply();
        window.addEventListener('resize', apply);
        window.addEventListener('scroll', apply, true);
        const timer = window.setInterval(() => {
          watch();
          apply();
        }, 500);
        return () => {
          window.clearInterval(timer);
          window.removeEventListener('resize', apply);
          window.removeEventListener('scroll', apply, true);
          if (observer !== null) observer.disconnect();
        };
      }, []);

      openRef.current = open;
      activeRef.current = activeId;

      // ── 列应用 ──
      const refresh = useCallback(async () => {
        const reply = await callHost('apps.list', { locale: envRef.current.locale });
        if (reply.ok) {
          setApps(Array.isArray(reply.data.apps) ? reply.data.apps : []);
        } else {
          say(reply.error || '读不到应用列表');
        }
        return reply;
      }, [say]);

      // 语言换了要重新列一次：应用显示名是宿主按语言给的。
      useEffect(() => {
        void refresh();
      }, [refresh, env.locale]);

      // ── 停掉正在跑的应用 ──
      const teardown = useCallback(() => {
        const mounted = mountedRef.current;
        mountedRef.current = null;
        if (mounted !== null) {
          try {
            mounted.unmount();
          } catch (error) {
            window.console.error('[dsh-phone] 应用卸载时出错：', error);
          }
          if (mounted.root.parentNode !== null) mounted.root.parentNode.removeChild(mounted.root);
        }
        if (mediaRef.current !== null) {
          mediaRef.current.dispose();
          mediaRef.current = null;
        }
        setAppState('');
        setAppError('');
      }, []);

      // ── 打开一个应用：从被点的那个图标的位置放大展开 ──
      const openApp = useCallback(
        async (target) => {
          if (target === null || target === undefined) return;
          teardown();
          // 立刻把「当前是哪个应用」记进 ref：后面几个 await 之间要拿它跟目标比对，
          // 等 React 下一次渲染再更新就晚了。
          activeRef.current = target.id;
          setActiveId(target.id);
          setAppState('loading');
          setAppError('');

          // 记下图标中心，进/出都在这个点上缩放
          try {
            const icon = document.querySelector('[data-app="' + target.id + '"] .dphp-icon');
            const screen = screenRef.current;
            if (icon !== null && screen !== null) {
              const iconRect = icon.getBoundingClientRect();
              const screenRect = screen.getBoundingClientRect();
              originRef.current = {
                x: Math.round(iconRect.left + iconRect.width / 2 - screenRect.left),
                y: Math.round(iconRect.top + iconRect.height / 2 - screenRect.top),
              };
            }
          } catch {
            originRef.current = { x: 132, y: 120 };
          }
          if (!reducedMotion()) {
            setAnim('in');
            // 播完就撤掉这条动画：同一个动画名一直挂着，下次点别的图标不会重新开始。
            window.clearTimeout(animTimer.current);
            animTimer.current = window.setTimeout(() => setAnim(null), APP_MS + 30);
          }

          const reply = await callHost('apps.source', { id: target.id });
          if (activeRef.current !== target.id) return;
          if (!reply.ok) {
            setAppState('failed');
            setAppError(reply.error || t.appFailed);
            return;
          }

          const layer = layerRef.current;
          if (layer === null) {
            setAppState('failed');
            setAppError(t.appFailed);
            return;
          }

          let mountFn;
          try {
            mountFn = loadMountFunction(reply.data.source, target.id);
          } catch (error) {
            setAppState('failed');
            setAppError(error && error.message ? error.message : String(error));
            return;
          }

          const rootElement = document.createElement('div');
          rootElement.className = 'dphp-appbody';
          layer.appendChild(rootElement);

          const watch = createMediaWatch();
          mediaRef.current = watch;
          playingRef.current = false;

          const permissions = Array.isArray(reply.data.manifest.permissions) ? reply.data.manifest.permissions : [];
          const backend = typeof reply.data.manifest.backend === 'string' ? reply.data.manifest.backend : '';
          const listeners = new Set();

          const appContext = {
            // 应用往这里画。挂载那一刻它已经在内屏里，量得到 264x340。
            root: rootElement,
            // 只能用宿主这一份 React，自带会出两个 React。
            react: React,
            // 把 React 树真正挂进 DOM 的那个渲染器。宿主给不出来时是 null，应用自己得判。
            reactDOM: ReactDOM,
            // 语言和主题是活的：应用每次读都拿到最新值，不用自己存一份。
            get locale() {
              return envRef.current.locale;
            },
            get theme() {
              return envRef.current.theme;
            },
            // 清单里那句 permissions 的原样副本，只读。应用想判断自己有没有某个许可，看这里，不用先撞一次墙。
            permissions: Object.freeze(permissions.slice()),

            api: {
              async call(method, params) {
                if (!permissions.includes('host')) throw new Error('这个应用没有申请访问后端的权限');
                if (backend === '') throw new Error('这个应用没有配置后端');
                // 请求由宿主半发出去，返回原样交给应用（拆掉手机自己的信封）。
                const answer = await callHost('app.call', { id: target.id, method, params });
                if (!answer.ok) throw new Error(answer.error || '后端调用失败');
                return answer.data;
              },
            },

            storage: {
              async get() {
                if (!permissions.includes('storage')) throw new Error('这个应用没有申请存储权限');
                const answer = await callHost('storage.get', { id: target.id });
                if (!answer.ok) throw new Error(answer.error || '读不到设置');
                return answer.data.value;
              },
              async set(value) {
                if (!permissions.includes('storage')) throw new Error('这个应用没有申请存储权限');
                const answer = await callHost('storage.set', { id: target.id, value });
                if (!answer.ok) throw new Error(answer.error || '存不上设置');
                return answer.data.value;
              },
            },

            onChange(listener) {
              if (typeof listener !== 'function') return () => {};
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },

            /**
             * 我这边还在出声，收起手机别把我关掉。
             *
             * 只有「收起手机」这一个动作看它；回桌面、切走、卸载、关页面一律照常卸载，
             * 它拦不住卸载，也不能让应用在手机没开的时候启动。
             * 手机另外还会自己听一遍（包一层 window.Audio），两个只要有一个在响就留着，
             * 所以不认识这条的老应用不会坏。
             */
            setPlaying(value) {
              playingRef.current = value === true;
            },
          };

          let unmount = null;
          try {
            unmount = mountFn(appContext);
          } catch (error) {
            layer.removeChild(rootElement);
            watch.dispose();
            mediaRef.current = null;
            setAppState('failed');
            setAppError(error && error.message ? error.message : String(error));
            return;
          }
          if (typeof unmount !== 'function') {
            layer.removeChild(rootElement);
            watch.dispose();
            mediaRef.current = null;
            setAppState('failed');
            setAppError(t.noUnmount);
            return;
          }

          mountedRef.current = {
            root: rootElement,
            unmount,
            notify(snapshot) {
              for (const listener of listeners) {
                try {
                  listener(snapshot);
                } catch {
                  /* 应用自己的回调炸了不关手机的事 */
                }
              }
            },
          };
          setAppState('running');
        },
        [t, teardown],
      );

      // 语言 / 主题变了，通知正在跑的应用（契约里的 ctx.onChange）
      useEffect(() => {
        const mounted = mountedRef.current;
        if (mounted !== null && typeof mounted.notify === 'function') {
          mounted.notify({ locale: env.locale, theme: env.theme });
        }
      }, [env.locale, env.theme]);

      // ── 回桌面：缩回原来那个图标，再真的卸载 ──
      const goHome = useCallback(() => {
        const finish = () => {
          window.clearTimeout(animTimer.current);
          setAnim(null);
          teardown();
          setActiveId('');
          setHoldId('');
        };
        if (mountedRef.current === null) {
          finish();
          return;
        }
        if (reducedMotion()) {
          finish();
          return;
        }
        setAnim('out');
        window.clearTimeout(animTimer.current);
        animTimer.current = window.setTimeout(finish, APP_MS);
      }, [teardown]);

      // ── 收起手机：唯一的例外在这里 ──
      const collapse = useCallback(() => {
        const mounted = mountedRef.current;
        // 两条路取或：应用自己声明的，和手机自己听出来的。
        const sniffed = mounted !== null && mediaRef.current !== null && mediaRef.current.isPlaying(mounted.root);
        const playing = mounted !== null && (playingRef.current || sniffed);
        if (playing) {
          // 正在放音：应用留着继续跑，只把手机收起来。
          // 不能卸载它，否则歌就断了；重新打开手机还能看到它、还能暂停。
          setOpen(false);
          return;
        }
        teardown();
        setActiveId('');
        setOpen(false);
      }, [teardown]);

      // ── 装一个文件 ──
      const installFile = useCallback(
        async (file, overwrite) => {
          if (file === null || file === undefined) return;
          if (!/\.dshapp$/i.test(file.name || '')) {
            say(t.notPackage(file.name || '?'));
            return;
          }
          say(t.installing);
          let data;
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            // 分块转 base64：一次性拼一个几十兆的字符串会把栈压爆
            let binary = '';
            const CHUNK = 0x8000;
            for (let index = 0; index < bytes.length; index += CHUNK) {
              binary += String.fromCharCode.apply(null, bytes.subarray(index, index + CHUNK));
            }
            data = window.btoa(binary);
          } catch (error) {
            say(t.readFailed + '：' + (error && error.message ? error.message : String(error)));
            return;
          }

          const reply = await callHost('apps.install', {
            data,
            overwrite: overwrite === true,
            locale: envRef.current.locale,
          });
          if (!reply.ok) {
            if (reply.code === 'already-exists') {
              setDialog({ kind: 'replace', file, name: (reply.existing && reply.existing.name) || file.name || '' });
              return;
            }
            say(reply.error || '装不上');
            return;
          }
          await refresh();
          say(t.installed + '：' + (reply.data.displayName || reply.data.id));
        },
        [refresh, say, t],
      );

      // ── 卸载 ──
      const doUninstall = useCallback(
        async (target) => {
          const reply = await callHost('apps.uninstall', { id: target.id });
          if (!reply.ok) {
            say(reply.error || '卸不掉');
            return;
          }
          if (activeRef.current === target.id) {
            teardown();
            setActiveId('');
          }
          await refresh();
          say(t.removed + '：' + target.displayName);
        },
        [refresh, say, t, teardown],
      );

      // ── 长按 ──
      const startHold = useCallback((id) => {
        window.clearTimeout(holdTimer.current);
        holdTimer.current = window.setTimeout(() => setHoldId(id), HOLD_MS);
      }, []);

      const cancelHold = useCallback(() => {
        window.clearTimeout(holdTimer.current);
      }, []);

      // ── 拖文件进来 ──
      const onDragOver = useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        setDragging(true);
      }, []);

      const onDragLeave = useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
      }, []);

      const onDrop = useCallback(
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragging(false);
          const files = event.dataTransfer ? event.dataTransfer.files : null;
          if (files === null || files.length === 0) return;
          void installFile(files[0], false);
        },
        [installFile],
      );

      // ── 清理 ──
      useEffect(
        () => () => {
          window.clearTimeout(toastTimer.current);
          window.clearTimeout(holdTimer.current);
          window.clearTimeout(animTimer.current);
          const mounted = mountedRef.current;
          mountedRef.current = null;
          if (mounted !== null) mounted.unmount();
          if (mediaRef.current !== null) mediaRef.current.dispose();
        },
        [],
      );

      // 手机开着的时候，如果别的窗口装了应用，这里不会自动知道；
      // 打开手机那一刻refresh 一次就够了，不做轮询。
      // ── 桌面 ──
      const cells = apps.map((one) => {
        const holding = holdId === one.id;
        const missing = one.backend !== '' && one.backendReady === false;
        return h(
          'div',
          { key: one.id, className: 'dphp-slot' },
          h(
            'button',
            {
              className: 'dphp-cell',
              type: 'button',
              'data-app': one.id,
              title: missing ? one.displayName + '（' + t.needsBackend + '）' : one.displayName,
              onPointerDown: (event) => {
                if (event.button !== undefined && event.button !== 0) return;
                startHold(one.id);
              },
              onPointerUp: cancelHold,
              onPointerLeave: cancelHold,
              onPointerCancel: cancelHold,
              onContextMenu: (event) => {
                event.preventDefault();
                setHoldId(one.id);
              },
              onClick: () => {
                if (holdId !== '') {
                  setHoldId('');
                  return;
                }
                if (missing) {
                  setDialog({ kind: 'backend', name: one.displayName, backend: one.backend });
                  return;
                }
                void openApp(one);
              },
            },
            h(
              'span',
              { className: 'dphp-icon' },
              one.iconData !== ''
                ? h('img', { src: one.iconData, alt: '', draggable: false })
                : svgIcon(ICON.phoneBody, 26),
              missing ? h('span', { className: 'dphp-badge', title: t.needsBackend }) : null,
            ),
            h('span', { className: 'dphp-name' }, one.displayName),
          ),
          holding
            ? h(
                'div',
                { className: 'dphp-longmask' },
                h(
                  'button',
                  {
                    className: 'dphp-longbtn',
                    type: 'button',
                    onClick: (event) => {
                      event.stopPropagation();
                      setHoldId('');
                      setDialog({ kind: 'uninstall', app: one });
                    },
                  },
                  t.uninstall,
                ),
              )
            : null,
        );
      });

      const desktop = h(
        'div',
        { className: 'dphp-desktop', 'data-show': activeId === '' ? 'true' : 'false', 'data-desktop': 'true' },
        apps.length === 0
          ? h(
              'div',
              { className: 'dphp-empty' },
              h(
                'svg',
                {
                  viewBox: '0 0 24 24',
                  width: 30,
                  height: 30,
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.4,
                  strokeLinejoin: 'round',
                  'aria-hidden': true,
                  style: { color: 'var(--dsw-alias-label-caption)' },
                },
                h('rect', { x: 7, y: 3, width: 10, height: 18, rx: 3 }),
                h('path', { d: 'M11 6h2', strokeLinecap: 'round' }),
              ),
              h('div', { className: 'dphp-emptytitle' }, t.empty),
              h('div', { className: 'dphp-emptyhint' }, t.emptyHint),
            )
          : h(
              'div',
              null,
              h('div', { className: 'dphp-grid', 'data-grid': 'true' }, cells),
              // 任务书 13 章要求界面上也说清楚这件事，不能只写在说明里
              h('div', { className: 'dphp-trust' }, t.hintTrust),
            ),
      );

      // ── 应用窗口：占满整个内屏，顶栏留在上面 ──
      const appStyle = anim === null
        ? undefined
        : {
            transformOrigin: originRef.current.x + 'px ' + originRef.current.y + 'px',
            animation: (anim === 'in' ? 'dphp-app-in ' : 'dphp-app-out ') + APP_MS + 'ms cubic-bezier(0.23,1,0.32,1) forwards',
          };

      const appWindow = h(
        'div',
        {
          className: 'dphp-app',
          'data-show': activeId === '' ? 'false' : 'true',
          'data-state': appState,
          style: appStyle,
        },
        appState === 'failed'
          ? h(
              'div',
              { key: 'fail', className: 'dphp-fail' },
              h('div', { className: 'dphp-failtitle' }, t.appFailed),
              h('div', { className: 'dphp-failbody' }, appError),
              h(
                'button',
                {
                  className: 'dphp-failbtn',
                  type: 'button',
                  onClick: () => {
                    const target = apps.find((one) => one.id === activeRef.current) || null;
                    setActiveId('');
                    teardown();
                    if (target !== null) void openApp(target);
                  },
                },
                t.retry,
              ),
            )
          : null,
        // 应用自己画的那块：React 不往里塞任何东西，只由手机挂/摘子节点。
        h('div', { key: 'layer', className: 'dphp-applayer', ref: layerRef }),
      );

      // ── 顶栏 ──
      const inApp = activeId !== '';
      const topbar = h(
        'div',
        { className: 'dphp-top' },
        h(
          'div',
          { className: 'dphp-topleft' },
          inApp
            ? h(
                'button',
                { className: 'dphp-btn', type: 'button', title: t.back, 'aria-label': t.back, onClick: goHome },
                svgIcon(ICON.back, 15),
              )
            : null,
          h('div', { className: 'dphp-title', title: inApp && app !== null ? app.displayName : t.desktop },
            inApp && app !== null ? app.displayName : t.desktop),
        ),
        inApp
          ? null
          : h(
              'button',
              {
                className: 'dphp-btn',
                type: 'button',
                title: t.add,
                'aria-label': t.add,
                onClick: () => {
                  if (inputRef.current !== null) inputRef.current.click();
                },
              },
              svgIcon(ICON.plus, 15),
            ),
        h(
          'button',
          { className: 'dphp-btn', type: 'button', title: t.close, 'aria-label': t.close, onClick: collapse },
          svgIcon(ICON.close, 14),
        ),
      );

      // ── 对话框 ──
      let dialogNode = null;
      if (dialog !== null && dialog.kind === 'replace') {
        dialogNode = h(
          'div',
          { className: 'dphp-veil' },
          h(
            'div',
            { className: 'dphp-dialog' },
            h('div', { className: 'dphp-dialogtitle' }, t.alreadyTitle),
            h('div', { className: 'dphp-dialogbody' }, t.alreadyBody(dialog.name)),
            h(
              'div',
              { className: 'dphp-dialogrow' },
              h('button', { className: 'dphp-ghost', type: 'button', onClick: () => setDialog(null) }, t.cancel),
              h(
                'button',
                {
                  className: 'dphp-primary',
                  type: 'button',
                  onClick: () => {
                    const file = dialog.file;
                    setDialog(null);
                    void installFile(file, true);
                  },
                },
                t.replace,
              ),
            ),
          ),
        );
      } else if (dialog !== null && dialog.kind === 'uninstall') {
        dialogNode = h(
          'div',
          { className: 'dphp-veil' },
          h(
            'div',
            { className: 'dphp-dialog' },
            h('div', { className: 'dphp-dialogtitle' }, t.removeTitle),
            h('div', { className: 'dphp-dialogbody' }, t.removeBody(dialog.app.displayName)),
            h(
              'div',
              { className: 'dphp-dialogrow' },
              h('button', { className: 'dphp-ghost', type: 'button', onClick: () => setDialog(null) }, t.cancel),
              h(
                'button',
                {
                  className: 'dphp-danger',
                  type: 'button',
                  onClick: () => {
                    const target = dialog.app;
                    setDialog(null);
                    void doUninstall(target);
                  },
                },
                t.uninstall,
              ),
            ),
          ),
        );
      } else if (dialog !== null && dialog.kind === 'backend') {
        dialogNode = h(
          'div',
          { className: 'dphp-veil' },
          h(
            'div',
            { className: 'dphp-dialog' },
            h('div', { className: 'dphp-dialogtitle' }, t.needsBackend),
            h('div', { className: 'dphp-dialogbody' }, t.needsBackendBody(dialog.backend)),
            h(
              'div',
              { className: 'dphp-dialogrow' },
              h('button', { className: 'dphp-ghost', type: 'button', onClick: () => setDialog(null) }, t.cancel),
            ),
          ),
        );
      }

      const panel = h(
        'div',
        {
          className: 'dphp-panel',
          'data-open': open ? 'true' : 'false',
          'data-drag': dragging ? 'true' : 'false',
          role: 'dialog',
          'aria-label': t.title,
          onDragOver,
          onDragEnter: onDragOver,
          onDragLeave,
          onDrop,
        },
        topbar,
        h(
          'div',
          { className: 'dphp-screen', ref: screenRef, 'data-screen': 'true' },
          desktop,
          appWindow,
          dialogNode,
          toast !== null ? h('div', { className: 'dphp-toast' }, toast) : null,
          h('input', {
            ref: inputRef,
            className: 'dphp-file',
            type: 'file',
            accept: '.dshapp',
            tabIndex: -1,
            onChange: (event) => {
              const files = event.target.files;
              const file = files && files.length > 0 ? files[0] : null;
              event.target.value = '';
              if (file !== null) void installFile(file, false);
            },
          }),
        ),
      );

      const fab = h(
        'button',
        {
          className: 'dphp-fab',
          type: 'button',
          title: open ? t.close : t.title,
          'aria-label': open ? t.close : t.title,
          'data-open': open ? 'true' : 'false',
          'data-fab': 'true',
          onClick: () => {
            if (open) {
              collapse();
              return;
            }
            setOpen(true);
            void refresh().then(() => {
              // 上次因为还在放音而留下的那个应用，这一眼要重新看见它
              if (mountedRef.current !== null && activeId !== '') setAppState('running');
            });
          },
        },
        h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: 18,
            height: 18,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          h('rect', { x: 7, y: 2.5, width: 10, height: 19, rx: 2.5 }),
          h('path', { d: 'M10.5 5.5h3' }),
        ),
        h('span', {
          className: 'dphp-fabdot',
          // 手机收起但应用还在跑（正在放歌那种情况），按钮上点一个小圆点提示一声
          'data-on': !open && activeId !== '' ? 'true' : 'false',
        }),
      );

      return h(
        'div',
        { className: 'dphp-root', ref: rootRef, 'data-theme': theme, 'data-locale': locale, 'data-phone': 'true' },
        h('style', null, CSS),
        fab,
        panel,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const bridge = createBridge(ctx);
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-phone', order: 20 }, () => h(Phone, { ctx, bridge })),
        );
      },
    };
  },
});
