/**
 * 面板样式：只作为字符串注入，不依赖宿主 CSS 构建链。
 *
 * 颜色分两层：
 *   1. `--lu-p-*` 是亮/暗两套兜底色，只在宿主 token 缺失时生效（本地预览、宿主改主题前）。
 *   2. 语义 token `--lu-*` 优先吃宿主的 `--dsw-alias-*` / `--dsw-shadow-*`，
 *      跟随 DSH 明暗主题；A 股红涨绿跌是产品语义色，固定不走宿主品牌色。
 */
export const STYLE = `
.luo-root {
  --lu-p-paper: #f7f4ed;
  --lu-p-surface: #fffdf8;
  --lu-p-surface-2: #f0ece2;
  --lu-p-ink: #1b1d22;
  --lu-p-ink-2: #5b5e66;
  --lu-p-ink-3: #8b8e95;
  --lu-p-line: #e3ded2;
  --lu-p-line-strong: #cec7b6;
  --lu-p-accent: #9a6a1c;
  --lu-p-shadow-1: 0 1px 2px rgba(27, 29, 34, 0.05), 0 1px 1px rgba(27, 29, 34, 0.03);
  --lu-p-shadow-2: 0 10px 30px rgba(27, 29, 34, 0.10);
  --lu-p-grid: rgba(27, 29, 34, 0.055);
  --lu-p-up: #b3362f;
  --lu-p-down: #0d7a52;
  --lu-p-warn: #9a5b12;
  --lu-serif: "Songti SC", "Noto Serif SC", "Source Han Serif SC", ui-serif, Georgia, serif;
  --lu-sans: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  --lu-mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
  --lu-r-sm: 6px;
  --lu-r-md: 10px;
  --lu-r-lg: 14px;

  --lu-bg: var(--dsw-alias-bg-base, var(--lu-p-paper));
  --lu-surface: color-mix(in srgb, var(--lu-ink) 2.5%, var(--dsw-alias-bg-layer-1, var(--lu-p-surface)));
  --lu-surface-2: color-mix(in srgb, var(--lu-ink) 6%, var(--lu-surface));
  --lu-ink: var(--dsw-alias-label-primary, var(--lu-p-ink));
  --lu-ink-2: var(--dsw-alias-label-secondary, var(--lu-p-ink-2));
  --lu-ink-3: color-mix(in srgb, var(--dsw-alias-label-tertiary, var(--lu-p-ink-3)) 72%, var(--lu-ink));
  --lu-line: var(--dsw-alias-border-l1, var(--lu-p-line));
  --lu-line-strong: var(--dsw-alias-border-l2, var(--lu-p-line-strong));
  --lu-accent: var(--dsw-alias-brand-primary, var(--lu-p-accent));
  --lu-accent-soft: color-mix(in srgb, var(--lu-accent) 12%, transparent);
  --lu-up: var(--lu-p-up);
  --lu-down: var(--lu-p-down);
  --lu-up-soft: color-mix(in srgb, var(--lu-up) 12%, transparent);
  --lu-down-soft: color-mix(in srgb, var(--lu-down) 12%, transparent);
  /* 状态色与涨跌色分开：健康/启用用 ok，失败/风险用 bad；涨跌仍用 A 股红涨绿跌。 */
  --lu-ok: color-mix(in srgb, var(--dsw-alias-state-success-primary, #0d7a52) 76%, var(--lu-ink));
  --lu-bad: var(--dsw-alias-state-error-primary, var(--lu-p-up));
  --lu-ok-soft: color-mix(in srgb, var(--lu-ok) 12%, transparent);
  --lu-bad-soft: color-mix(in srgb, var(--lu-bad) 12%, transparent);
  --lu-warn: color-mix(in srgb, var(--dsw-alias-state-warn-primary, var(--lu-p-warn)) 74%, var(--lu-ink));
  --lu-warn-soft: color-mix(in srgb, var(--lu-warn) 13%, transparent);
  --lu-hover: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--lu-ink) 4.5%, transparent));
  --lu-shadow-1: var(--dsw-shadow-lv1, var(--lu-p-shadow-1));
  --lu-shadow-2: var(--dsw-shadow-lv2, var(--lu-p-shadow-2));
  --lu-grid: var(--lu-p-grid);

  height: 100%;
  min-height: 0;
  overflow: auto;
  color: var(--lu-ink);
  background-color: var(--lu-bg);
  background-image: radial-gradient(var(--lu-grid) 0.5px, transparent 0.5px);
  background-size: 22px 22px;
  font: 14px/1.55 var(--lu-sans);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .luo-root {
    --lu-p-paper: #0e1013;
    --lu-p-surface: #15181c;
    --lu-p-surface-2: #1c2025;
    --lu-p-ink: #efece5;
    --lu-p-ink-2: #a9abb0;
    --lu-p-ink-3: #7a7d83;
    --lu-p-line: #272b31;
    --lu-p-line-strong: #363b43;
    --lu-p-accent: #d8a441;
    --lu-p-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
    --lu-p-shadow-2: 0 16px 44px rgba(0, 0, 0, 0.5);
    --lu-p-grid: rgba(239, 236, 229, 0.05);
    --lu-p-up: #ff8177;
    --lu-p-down: #46d19b;
    --lu-p-warn: #e0a44a;
  }
}
.luo-root *, .luo-root *::before, .luo-root *::after { box-sizing: border-box; }

.luo-shell { max-width: 1240px; margin: 0 auto; padding: 26px clamp(18px, 3vw, 44px) 56px; }

.luo-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding-bottom: 18px; border-bottom: 1px solid var(--lu-line); }
.luo-eyebrow { display: flex; align-items: center; gap: 8px; color: var(--lu-accent); font: 600 10.5px/1 var(--lu-sans); letter-spacing: 0.18em; text-transform: uppercase; }
.luo-eyebrow i { width: 5px; height: 5px; border-radius: 50%; background: var(--lu-accent); }
.luo-title { margin: 12px 0 6px; font: 400 clamp(26px, 2.7vw, 34px)/1.08 var(--lu-serif); letter-spacing: -0.015em; }
.luo-sub { margin: 0; color: var(--lu-ink-2); font-size: 13px; }
.luo-head-side { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
.luo-stamp { font: 11px/1 var(--lu-mono); color: var(--lu-ink-3); letter-spacing: 0.02em; }
.luo-stamp b { color: var(--lu-ink-2); font-weight: 500; }

.luo-btn { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 14px; border: 1px solid var(--lu-line-strong); border-radius: 999px; background: transparent; color: var(--lu-ink); font: 500 12px/1 var(--lu-sans); cursor: pointer; transition: background .18s ease, border-color .18s ease, transform .18s ease; }
.luo-btn:hover { background: var(--lu-hover); border-color: var(--lu-ink-3); }
.luo-btn:active { transform: translateY(1px); }
.luo-btn:focus-visible { outline: 2px solid var(--lu-accent); outline-offset: 2px; }
.luo-btn[disabled] { cursor: progress; opacity: .65; }
.luo-btn svg { width: 13px; height: 13px; }
.luo-btn.is-loading svg { animation: luo-spin .9s linear infinite; }

.luo-pill { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border: 1px solid transparent; border-radius: 999px; background: var(--lu-surface-2); color: var(--lu-ink-2); font: 600 10.5px/1 var(--lu-sans); letter-spacing: .04em; white-space: nowrap; }
.luo-pill.is-up { color: var(--lu-up); background: var(--lu-up-soft); }
.luo-pill.is-down { color: var(--lu-down); background: var(--lu-down-soft); }
.luo-pill.is-accent { color: var(--lu-accent); background: var(--lu-accent-soft); }
.luo-pill.is-warn { color: var(--lu-warn); background: var(--lu-warn-soft); }
.luo-pill.is-ok { color: var(--lu-ok); background: var(--lu-ok-soft); }
.luo-pill.is-bad { color: var(--lu-bad); background: var(--lu-bad-soft); }
.luo-pill.is-quiet { color: var(--lu-ink-3); background: transparent; border-color: var(--lu-line); }
.luo-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.luo-section { margin-top: 22px; animation: luo-rise .5s cubic-bezier(.22,.68,.24,1) both; }
.luo-section-h { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; margin-bottom: 10px; }
.luo-section-t { margin: 0; font: 600 10.5px/1 var(--lu-sans); letter-spacing: .16em; text-transform: uppercase; color: var(--lu-ink-3); }
.luo-section-meta { font: 11px/1 var(--lu-mono); color: var(--lu-ink-3); }

.luo-grid { display: grid; gap: 12px; }
.luo-grid.is-kpi { grid-template-columns: repeat(auto-fit, minmax(178px, 1fr)); }
.luo-grid.is-index { grid-template-columns: repeat(auto-fit, minmax(196px, 1fr)); }
.luo-grid.is-two { grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); align-items: start; }
.luo-grid.is-halves { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }

.luo-card { position: relative; border: 1px solid var(--lu-line); border-radius: var(--lu-r-md); background: var(--lu-surface); padding: 16px 18px; box-shadow: var(--lu-shadow-1); }
.luo-card-h { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.luo-card-t { margin: 0; font: 600 10.5px/1 var(--lu-sans); letter-spacing: .14em; text-transform: uppercase; color: var(--lu-ink-3); }
.luo-card-meta { font: 11px/1.3 var(--lu-mono); color: var(--lu-ink-3); text-align: right; }

.luo-kpi { border: 1px solid var(--lu-line); border-radius: var(--lu-r-md); background: var(--lu-surface); padding: 14px 16px 13px; box-shadow: var(--lu-shadow-1); }
.luo-kpi-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; font: 600 10px/1 var(--lu-sans); letter-spacing: .13em; text-transform: uppercase; color: var(--lu-ink-3); }
.luo-kpi-value { margin-top: 9px; font: 500 clamp(21px, 2.1vw, 27px)/1.05 var(--lu-mono); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.luo-kpi-sub { margin-top: 6px; font: 11px/1.4 var(--lu-mono); color: var(--lu-ink-3); }
.luo-kpi-sub b { font-weight: 500; color: var(--lu-ink-2); }

.luo-up { color: var(--lu-up); }
.luo-down { color: var(--lu-down); }
.luo-ok { color: var(--lu-ok); }
.luo-bad { color: var(--lu-bad); }
.luo-flat { color: var(--lu-ink-2); }
.luo-mono { font-family: var(--lu-mono); font-variant-numeric: tabular-nums; }
.luo-strong { color: var(--lu-ink); font-weight: 600; }
.luo-muted { color: var(--lu-ink-3); }

.luo-index { position: relative; overflow: hidden; border: 1px solid var(--lu-line); border-radius: var(--lu-r-md); background: var(--lu-surface); padding: 14px 16px 12px; box-shadow: var(--lu-shadow-1); }
.luo-index::before { content: ""; position: absolute; inset: 0 0 auto; height: 2px; background: linear-gradient(90deg, var(--lu-tone, var(--lu-line-strong)), transparent 78%); }
.luo-index-top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.luo-index-name { font: 500 13px/1.2 var(--lu-sans); color: var(--lu-ink-2); letter-spacing: .01em; }
.luo-index-code { font: 10px/1 var(--lu-mono); color: var(--lu-ink-3); }
.luo-index-price { margin-top: 10px; font: 500 24px/1 var(--lu-mono); font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.luo-index-delta { display: flex; align-items: baseline; gap: 8px; margin-top: 7px; font: 12px/1 var(--lu-mono); font-variant-numeric: tabular-nums; }
.luo-index-src { margin-top: 9px; font: 10px/1 var(--lu-mono); color: var(--lu-ink-3); }

.luo-breadth { display: flex; height: 8px; overflow: hidden; border-radius: 999px; background: var(--lu-surface-2); }
.luo-breadth > span { display: block; height: 100%; transition: width .5s cubic-bezier(.22,.68,.24,1); }
.luo-breadth-legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 12px; font: 11px/1.4 var(--lu-mono); color: var(--lu-ink-3); }
.luo-breadth-legend b { font-weight: 500; color: var(--lu-ink); }
.luo-substats { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 10px; margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--lu-line); }
.luo-substat-k { font: 600 9.5px/1 var(--lu-sans); letter-spacing: .1em; text-transform: uppercase; color: var(--lu-ink-3); }
.luo-substat-v { margin-top: 6px; font: 500 16px/1 var(--lu-mono); font-variant-numeric: tabular-nums; }

.luo-table-wrap { margin: 0 -6px; max-height: 356px; overflow: auto; }
.luo-table { width: 100%; border-collapse: collapse; }
.luo-table th { position: sticky; top: 0; z-index: 1; padding: 6px 8px 8px; border-bottom: 1px solid var(--lu-line); background: var(--lu-surface); color: var(--lu-ink-3); font: 600 9.5px/1 var(--lu-sans); letter-spacing: .1em; text-transform: uppercase; text-align: right; white-space: nowrap; }
.luo-table th:first-child { text-align: left; }
.luo-table td { padding: 9px 8px; border-bottom: 1px solid color-mix(in srgb, var(--lu-line) 62%, transparent); text-align: right; font: 12.5px/1.35 var(--lu-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.luo-table td:first-child { text-align: left; font-family: var(--lu-sans); white-space: normal; }
.luo-table tbody tr { transition: background .14s ease; }
.luo-table tbody tr:hover { background: var(--lu-hover); }
.luo-table tbody tr:last-child td { border-bottom: 0; }
.luo-stock-name { display: block; color: var(--lu-ink); font-weight: 500; }
.luo-stock-code { display: block; margin-top: 2px; color: var(--lu-ink-3); font: 10px/1 var(--lu-mono); letter-spacing: .02em; }

.luo-advice-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; }
.luo-advice { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--lu-line); border-left: 2px solid var(--lu-tone, var(--lu-line-strong)); border-radius: var(--lu-r-md); background: var(--lu-surface); padding: 15px 16px 14px; box-shadow: var(--lu-shadow-1); }
.luo-advice-h { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.luo-advice-title { font: 500 14px/1.25 var(--lu-sans); }
.luo-advice-sub { margin-top: 3px; color: var(--lu-ink-3); font: 10.5px/1.4 var(--lu-mono); }
.luo-advice-premise { color: var(--lu-ink-2); font-size: 12.5px; line-height: 1.55; }
.luo-meter { height: 4px; overflow: hidden; border-radius: 999px; background: var(--lu-surface-2); }
.luo-meter > i { display: block; height: 100%; border-radius: inherit; background: var(--lu-accent); transition: width .6s cubic-bezier(.22,.68,.24,1); }
.luo-meter-row { display: flex; align-items: center; gap: 10px; }
.luo-meter-row .luo-meter { flex: 1; }
.luo-meter-cap { font: 10px/1 var(--lu-mono); color: var(--lu-ink-3); white-space: nowrap; }
.luo-details { margin-top: 2px; }
.luo-details > summary { cursor: pointer; color: var(--lu-ink-3); font: 600 10px/1.4 var(--lu-sans); letter-spacing: .06em; text-transform: uppercase; list-style: none; }
.luo-details > summary::-webkit-details-marker { display: none; }
.luo-details > summary::before { content: "＋"; display: inline-block; width: 12px; color: var(--lu-accent); }
.luo-details[open] > summary::before { content: "－"; }
.luo-details > summary:hover { color: var(--lu-ink-2); }
.luo-dl { margin: 8px 0 0; display: grid; gap: 7px; }
.luo-dl div { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 8px; }
.luo-dl dt { color: var(--lu-ink-3); font: 10px/1.5 var(--lu-sans); letter-spacing: .06em; text-transform: uppercase; }
.luo-dl dd { margin: 0; color: var(--lu-ink-2); font-size: 12px; line-height: 1.5; }
.luo-dl dd ul { margin: 0; padding-left: 14px; }
.luo-dl dd li + li { margin-top: 3px; }
.luo-fine { color: var(--lu-ink-3); font-size: 10.5px; line-height: 1.45; }

.luo-list { display: flex; flex-direction: column; }
.luo-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 10px 6px; border-bottom: 1px solid color-mix(in srgb, var(--lu-line) 62%, transparent); }
.luo-row:last-child { border-bottom: 0; }
.luo-row:hover { background: var(--lu-hover); }
.luo-row-main { min-width: 0; }
.luo-row-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--lu-ink); }
.luo-row-title b { font-weight: 600; }
.luo-row-sub { margin-top: 3px; color: var(--lu-ink-3); font-size: 11.5px; line-height: 1.45; overflow-wrap: anywhere; }
.luo-row-side { text-align: right; font: 10.5px/1.5 var(--lu-mono); color: var(--lu-ink-3); white-space: nowrap; }
.luo-pri { width: 3px; align-self: stretch; min-height: 26px; border-radius: 999px; background: var(--lu-line-strong); }
.luo-pri.is-urgent { background: var(--lu-up); }
.luo-pri.is-important { background: var(--lu-warn); }
.luo-pri.is-normal { background: var(--lu-ink-3); }

.luo-watch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 6px; border-bottom: 1px solid color-mix(in srgb, var(--lu-line) 62%, transparent); }
.luo-watch-row:last-child { border-bottom: 0; }
.luo-watch-name { font-size: 12.5px; color: var(--lu-ink); }
.luo-watch-meta { margin-top: 2px; color: var(--lu-ink-3); font: 10.5px/1.4 var(--lu-mono); }

.luo-strategy-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; padding: 12px 6px; border-bottom: 1px solid color-mix(in srgb, var(--lu-line) 62%, transparent); }
.luo-strategy-row:last-child { border-bottom: 0; }
.luo-strategy-name { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font: 500 13.5px/1.3 var(--lu-sans); }
.luo-strategy-desc { margin-top: 4px; color: var(--lu-ink-2); font-size: 12px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.luo-strategy-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 7px; }
.luo-strategy-side { text-align: right; font: 10.5px/1.6 var(--lu-mono); color: var(--lu-ink-3); white-space: nowrap; }

.luo-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(72px, 1fr)); gap: 12px; }
.luo-stat-k { font: 600 9px/1.2 var(--lu-sans); letter-spacing: .08em; text-transform: uppercase; color: var(--lu-ink-3); }
.luo-stat-v { margin-top: 5px; font: 500 15px/1 var(--lu-mono); font-variant-numeric: tabular-nums; }
.luo-divider { height: 1px; margin: 14px 0; background: var(--lu-line); }
.luo-subblock { margin-top: 16px; padding-top: 12px; border-top: 1px dashed var(--lu-line); }
.luo-subblock-t { margin-bottom: 7px; font: 600 9.5px/1 var(--lu-sans); letter-spacing: .12em; text-transform: uppercase; color: var(--lu-ink-3); }

.luo-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; padding: 14px 4px 10px; color: var(--lu-ink-3); }
.luo-empty-mark { font: 400 18px/1 var(--lu-serif); color: var(--lu-line-strong); }
.luo-empty-t { font-size: 12.5px; color: var(--lu-ink-2); }
.luo-empty-h { font: 11px/1.5 var(--lu-mono); }

.luo-err { border: 1px dashed color-mix(in srgb, var(--lu-warn) 45%, var(--lu-line)); border-radius: var(--lu-r-sm); padding: 10px 12px; background: var(--lu-warn-soft); color: var(--lu-warn); font: 11.5px/1.5 var(--lu-mono); overflow-wrap: anywhere; }

.luo-skel { position: relative; overflow: hidden; border-radius: var(--lu-r-sm); background: var(--lu-surface-2); }
.luo-skel::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--lu-ink) 7%, transparent), transparent); animation: luo-shimmer 1.5s ease-in-out infinite; }
.luo-skel.is-line { height: 11px; margin: 8px 0; }
.luo-skel.is-value { height: 26px; width: 62%; margin-top: 10px; }
.luo-skel.is-card { height: 92px; }

.luo-foot { display: flex; justify-content: space-between; gap: 18px; margin-top: 30px; padding-top: 14px; border-top: 1px solid var(--lu-line); color: var(--lu-ink-3); font-size: 11px; line-height: 1.55; }
.luo-foot b { color: var(--lu-ink-2); font-weight: 500; }
.luo-foot-right { text-align: right; font-family: var(--lu-mono); }

.luo-root ::-webkit-scrollbar { width: 8px; height: 8px; }
.luo-root ::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--lu-ink) 18%, transparent); border-radius: 999px; }
.luo-root ::-webkit-scrollbar-track { background: transparent; }

@keyframes luo-shimmer { 100% { transform: translateX(100%); } }
@keyframes luo-spin { to { transform: rotate(360deg); } }
@keyframes luo-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

@media (max-width: 900px) {
  .luo-grid.is-two { grid-template-columns: minmax(0, 1fr); }
  .luo-head { flex-direction: column; align-items: flex-start; }
  .luo-head-side { justify-content: flex-start; }
}
@media (prefers-reduced-motion: reduce) {
  .luo-root *, .luo-root *::before, .luo-root *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
`;
