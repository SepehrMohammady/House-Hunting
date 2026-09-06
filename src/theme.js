/**
 * Shared palette, responsive rules and dark mode for every generated page.
 *
 * Why it is built this way:
 *
 * The pages are still table-and-inline-style documents, because the report can
 * also be emailed and mail clients strip external CSS and modern layout. Inline
 * styles are therefore the base rendering, and they carry the LIGHT palette so a
 * client that understands nothing still shows a readable page.
 *
 * Everything responsive or dark lives in one <style> block instead. Inline
 * styles outrank a stylesheet, so those rules must use !important to win - that
 * is not sloppiness, it is the only way to repaint an inline-styled document.
 *
 * Dark mode is three-state, which is what "follow the device, but let me
 * override" actually requires:
 *   - no attribute        -> follow prefers-color-scheme
 *   - data-theme="dark"   -> force dark even on a light device
 *   - data-theme="light"  -> force light even on a dark device
 * The media-query block is guarded with :not([data-theme="light"]) so an
 * explicit light choice is not overridden by the device preference.
 */

/** Light palette. These values are what gets written inline. */
export const C = {
  ink: '#1a1d21',
  muted: '#6b7280',
  line: '#e5e7eb',
  bg: '#f6f7f9',
  card: '#ffffff',
  good: '#0f7b3f',
  goodBg: '#e6f4ec',
  warn: '#9a4b00',
  warnBg: '#fdf0e3',
  cool: '#1e4fa3',
  coolBg: '#e8effb',
  dim: '#6b7280',
  dimBg: '#f1f2f4',
};

/**
 * Dark palette.
 *
 * Not the light one inverted: the accent colours are lightened and desaturated
 * so they stay legible on a dark ground, and the "surface" is a touch lighter
 * than the page so cards still read as raised.
 */
export const D = {
  ink: '#e7eaee',
  muted: '#9aa4b0',
  line: '#2b3138',
  bg: '#101316',
  card: '#1a1e23',
  good: '#5ed69b',
  goodBg: '#123122',
  warn: '#f2b366',
  warnBg: '#382614',
  cool: '#7db3ff',
  coolBg: '#152740',
  dim: '#9aa4b0',
  dimBg: '#252b32',
};

/**
 * Where each layout has to stop being a table.
 *
 * These are NOT a taste-driven "mobile" width. A table expands to fit its
 * content, so `max-width:100%` cannot save a row whose cells are 170 + 130 + 180
 * plus a details column - the table simply overflows and the page scrolls
 * sideways. The breakpoint therefore has to sit just above the width the table
 * actually needs, or there is a dead zone between the two where it still
 * overflows. An earlier 640px breakpoint left exactly that gap, and every tablet
 * landed in it.
 */
const STACK_BELOW = {
  report: 940, // 900px sheet + 2x10px body padding, plus a little slack
  index: 860, // 820px sheet + the same
};

/**
 * The single <style> block every page includes.
 *
 * `scope` picks which layout rules are emitted - the report and the archive
 * index have different table shapes - but the colour rules are shared.
 */
export function styleBlock(scope = 'report') {
  const dark = `
    body, .sheet-wrap { background:${D.bg} !important; }
    .sheet { background:${D.card} !important; border-color:${D.line} !important; }
    .band { background:${D.bg} !important; border-color:${D.line} !important; }
    .row { border-color:${D.line} !important; }
    .row-a { background:${D.card} !important; }
    .row-b { background:${D.bg} !important; }
    .row-hl { background:${D.coolBg} !important; }
    .t-ink, .t-ink a { color:${D.ink} !important; }
    .t-muted { color:${D.muted} !important; }
    .t-cool, .t-cool a { color:${D.cool} !important; }
    .t-good { color:${D.good} !important; }
    .t-warn { color:${D.warn} !important; }
    .chip-good { background:${D.goodBg} !important; color:${D.good} !important; }
    .chip-warn { background:${D.warnBg} !important; color:${D.warn} !important; }
    .chip-cool { background:${D.coolBg} !important; color:${D.cool} !important; }
    .chip-dim  { background:${D.dimBg}  !important; color:${D.dim}  !important; }
    .btn { background:${D.cool} !important; color:#0d1117 !important; }
    .warnbox { background:${D.warnBg} !important; border-color:${D.warn} !important; }
    .warnbox div { color:${D.warn} !important; }
    .ph { background:${D.dimBg} !important; color:${D.muted} !important; }
    img { border-color:${D.line} !important; }
    .card { background:${D.card} !important; border-color:${D.line} !important; }
    input { background:${D.bg} !important; color:${D.ink} !important; border-color:${D.line} !important; }
    .toggle { background:${D.dimBg} !important; color:${D.ink} !important; border-color:${D.line} !important; }
  `;

  // Stack the listing row. Each cell becomes a full-width block, so the four
  // columns turn into one card per listing and nothing scrolls sideways.
  const mobileReport = `
    .sheet { width:100% !important; border-radius:0 !important; border-left:0 !important; border-right:0 !important; }
    .row { display:block !important; width:100% !important; }
    .row > td { display:block !important; width:100% !important; box-sizing:border-box !important; }
    .c-photo { padding:14px 14px 0 !important; }
    /* Capped so a stacked card on a tablet does not become a letterbox. */
    .c-photo img, .c-photo .ph { width:100% !important; max-width:520px !important; height:200px !important; line-height:200px !important; }
    .c-main { padding:12px 14px 4px !important; }
    .c-cost { padding:4px 14px 0 !important; text-align:left !important; }
    .c-cost .cost-figure { display:inline-block !important; margin-right:8px !important; }
    .c-cost .cost-label { display:inline-block !important; }
    .c-cost .cost-note { display:block !important; margin-top:4px !important; }
    .c-contact { padding:10px 14px 18px !important; }
    .btn { display:block !important; text-align:center !important; padding:12px !important; }
    .stat { display:inline-block !important; padding:0 22px 10px 0 !important; }
    .sec { padding:20px 14px 6px !important; }
    .hdr { padding:18px 14px 16px !important; }
    .band { padding:12px 14px !important; }
  `;

  const mobileIndex = `
    .sheet { width:100% !important; border-radius:0 !important; border-left:0 !important; border-right:0 !important; }
    .row { display:block !important; width:100% !important; padding:12px 14px !important; box-sizing:border-box !important; }
    .row > td { display:inline-block !important; width:auto !important; padding:0 10px 0 0 !important; }
    .row > td.i-open { display:block !important; width:100% !important; padding:10px 0 0 !important; text-align:left !important; }
    .btn { display:block !important; text-align:center !important; padding:11px !important; }
    .stat { display:inline-block !important; padding:0 22px 10px 0 !important; }
    .hdr { padding:20px 14px 16px !important; }
  `;

  const mobile = scope === 'index' ? mobileIndex : mobileReport;

  return `<style>
  /* Tell the browser both themes are supported, so form controls and
     scrollbars are painted to match rather than staying stubbornly light. */
  :root { color-scheme: light dark; }

  img { max-width:100%; }

  /* Device preference, unless the reader has explicitly chosen light. */
  @media (prefers-color-scheme: dark) {
    html:not([data-theme="light"]) { ${dark} }
  }
  /* Explicit choice wins in both directions. */
  html[data-theme="dark"] { ${dark} }

  @media only screen and (max-width:${STACK_BELOW[scope] ?? STACK_BELOW.report}px) {
    ${mobile}
  }
</style>`;
}

/**
 * Theme switch.
 *
 * Rendered hidden and revealed by script, so an email client - which strips the
 * script - never shows a button that cannot work. Choice is remembered per
 * browser; clearing it falls back to the device preference.
 */
export function themeToggle() {
  return (
    `<button id="tt" class="toggle" type="button" aria-label="Switch theme" style="display:none;` +
    `border:1px solid ${C.line};background:${C.dimBg};color:${C.ink};border-radius:6px;` +
    `padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;line-height:1;">` +
    `<span id="ttl">Dark</span></button>` +
    `<script>(function(){
  var b=document.getElementById('tt'),l=document.getElementById('ttl'),r=document.documentElement;
  if(!b) return;
  var media=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)');
  function stored(){ try { return localStorage.getItem('hh-theme'); } catch(e){ return null; } }
  function effective(){
    var s=stored();
    if(s==='dark'||s==='light') return s;
    return media&&media.matches?'dark':'light';
  }
  function paint(){
    var e=effective();
    // Only stamp the attribute when overriding, so an unset preference keeps
    // following the device if it changes while the page is open.
    var s=stored();
    if(s==='dark'||s==='light') r.setAttribute('data-theme',s); else r.removeAttribute('data-theme');
    l.textContent = e==='dark' ? 'Light' : 'Dark';
  }
  b.style.display='inline-block';
  b.addEventListener('click',function(){
    var next = effective()==='dark' ? 'light' : 'dark';
    try { localStorage.setItem('hh-theme',next); } catch(e){}
    paint();
  });
  if(media&&media.addEventListener) media.addEventListener('change',paint);
  paint();
})();</script>`
  );
}
