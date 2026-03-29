/* ═══════════════════════════════════════════════════════════════════
   GSAP ANIMATION STUDIO — studio.js  v4
   · Multi-page import (HTML file + URL fetch)
   · iframe sandbox with postMessage bridge for selection
   · URL rewriting for assets/fonts/styles
   · Link interception for in-page navigation
   · Per-page animation isolation
   · All v3 features: undo/redo, resize, code editor, drag-reorder
═══════════════════════════════════════════════════════════════════ */

'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════════

const state = {
  // Pages registry
  pages:          [],       // [{id, label, url, html, baseUrl, animations:[]}]
  activePageId:   null,

  // Per-session (not persisted to pages)
  selectMode:       false,
  editingId:        null,
  selectedAnimId:   null,
  scrollTriggerOn:  false,
  scrubOn:          false,
  scrubAmount:      1,        // smoothing seconds (0 = scroll-linked)
  stPin:            false,
  stMarkers:        false,
  stOnce:           false,
  stToggleActions:  'play none none none',
  stCustomTA:       false,
  timelineOn:       false,
  panelCollapsed:   false,
  panelWidth:       300,
  timelineHeight:   140,
  undoStack:        [],
  redoStack:        [],
  codeParseTimer:   null,
  dragSrcIndex:     null,

  // iframe bridge
  frameReady:       false,
  liveMode:         false,
  hoverEl:          null,   // {selector, rect}
  selections:        [],   // [{selector, rect}] — multi-select array
};

// Shorthand: get current page's animations[]
function getAnims()    { const p = activePage(); return p ? p.animations : []; }
function activePage()  { return state.pages.find(p => p.id === state.activePageId) || null; }

// ══════════════════════════════════════════════════════════════════════════════
// DOM REFS
// ══════════════════════════════════════════════════════════════════════════════

const frame             = document.getElementById('page-frame');
const overlayLayer      = document.getElementById('overlay-layer');
const hoverHighlight    = document.getElementById('hover-highlight');
const hoverLabel        = document.getElementById('hover-label');
const selectedHighlights= document.getElementById('selected-highlights');
const instructionOverlay= document.getElementById('instruction-overlay');
const emptyState        = document.getElementById('empty-state');
const animConfig        = document.getElementById('anim-config');
const selectorInput     = document.getElementById('selector-input');
const codeEditor        = document.getElementById('code-editor');
const toast             = document.getElementById('toast');
const timelineBody      = document.getElementById('timeline-body');
const timelineSection   = document.getElementById('timeline-section');
const tlResizeHandle    = document.getElementById('timeline-resize-handle');
const rightPanel        = document.getElementById('right-panel');
const resizeHandle      = document.getElementById('resize-handle');
const collapseTab       = document.getElementById('collapse-tab');
const editIndicator     = document.getElementById('edit-indicator');
const editIndicatorText = document.getElementById('edit-indicator-text');
const addAnimBtn        = document.getElementById('add-anim-btn');
const commitBtn         = document.getElementById('commit-btn');
const dirtyBadge        = document.getElementById('dirty-badge');
const parseError        = document.getElementById('parse-error');
const welcomeScreen     = document.getElementById('welcome-screen');
const loadingOverlay    = document.getElementById('loading-overlay');
const loadingText       = document.getElementById('loading-text');
const pageTabs          = document.getElementById('page-tabs');

// ══════════════════════════════════════════════════════════════════════════════
// IFRAME CONTENT SCRIPT
// Injected into the frame's srcdoc — communicates via postMessage
// ══════════════════════════════════════════════════════════════════════════════

const FRAME_SCRIPT = `
(function() {
  'use strict';
  let selectMode = false;
  let lastHovered = null;

  // Generate a stable CSS selector for an element
  function getSelector(el) {
    if (el.id) return '#' + el.id;
    // Try meaningful class combo
    const cls = Array.from(el.classList)
      .filter(c => !c.startsWith('gsap-') && c.length < 40)
      .slice(0, 3).join('.');
    if (cls) {
      const sel = el.tagName.toLowerCase() + '.' + cls;
      if (document.querySelectorAll(sel).length <= 5) return '.' + cls;
    }
    // data attributes
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-') && attr.value.length < 30) {
        return '[' + attr.name + '="' + attr.value + '"]';
      }
    }
    // Path fallback
    return buildPath(el);
  }

  function buildPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body) {
      let seg = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (siblings.length > 1) seg += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = cur.parentElement;
      if (parts.length > 4) break;
    }
    return parts.join(' > ');
  }

  function getRect(el) {
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, left: r.left, width: r.width, height: r.height, scrollY: window.scrollY };
  }

  // Listen for commands from parent
  window.addEventListener('message', e => {
    if (e.data.type === 'SET_SELECT_MODE') {
      selectMode = e.data.value;
      document.body.style.cursor = selectMode ? 'crosshair' : '';
    }
    if (e.data.type === 'PREVIEW_ANIM') runPreview(e.data.anim);
    if (e.data.type === 'PREVIEW_ALL')  runAllPreviews(e.data.anims);
    if (e.data.type === 'RESET_ALL')    resetAll();

    // Live preview: parent sends code as string, frame injects it as a <script> tag.
    // Using postMessage avoids contentDocument cross-origin restrictions entirely.
    if (e.data.type === 'INJECT_LIVE') {
      try {
        var old = document.getElementById('__gsap_live__');
        if (old) old.remove();
        var tag = document.createElement('script');
        tag.id = '__gsap_live__';
        tag.textContent = e.data.code;
        document.body.appendChild(tag);
      } catch(err) {
        window.parent.postMessage({ type: 'LIVE_ERROR', message: 'Inject: ' + err.message }, '*');
      }
    }

    if (e.data.type === 'RESET_LIVE') {
      try {
        if (window.gsap) {
          window.gsap.killTweensOf('*');
          if (window.ScrollTrigger) {
            window.ScrollTrigger.getAll().forEach(function(t) { t.kill(); });
          }
        }
        document.querySelectorAll('*').forEach(function(el) {
          el.style.transform = '';
          el.style.opacity = '';
          el.style.visibility = '';
        });
        var s = document.getElementById('__gsap_live__');
        if (s) s.remove();
        window.parent.postMessage({ type: 'RESET_DONE' }, '*');
      } catch(err) {}
    }
  });

  // Hover
  document.addEventListener('mouseover', e => {
    if (!selectMode) return;
    const el = e.target;
    if (!el || el === document.body || el === document.documentElement) return;
    lastHovered = el;
    window.parent.postMessage({ type: 'HOVER', selector: getSelector(el), rect: getRect(el) }, '*');
  });

  document.addEventListener('mouseout', e => {
    if (!selectMode) return;
    window.parent.postMessage({ type: 'HOVER_OUT' }, '*');
  });

  // Click to select (shift = add to selection, plain click = replace)
  document.addEventListener('click', e => {
    if (!selectMode) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target;
    if (!el || el === document.body || el === document.documentElement) return;
    const sel  = getSelector(el);
    const rect = getRect(el);
    window.parent.postMessage({
      type: 'SELECT',
      selector: sel,
      rect,
      tag: el.tagName.toLowerCase(),
      additive: e.shiftKey || e.metaKey || e.ctrlKey,
    }, '*');
  }, true);

  // On scroll: re-broadcast rects of all selected elements so parent can reposition highlights
  window.addEventListener('scroll', () => {
    window.parent.postMessage({ type: 'SCROLL', scrollY: window.scrollY }, '*');
  }, { passive: true });

  // Let parent ask for fresh rects of specific selectors
  window.addEventListener('message', e => {
    if (e.data.type === 'GET_RECTS') {
      const rects = e.data.selectors.map(sel => {
        try {
          const el = document.querySelector(sel);
          return el ? { selector: sel, rect: getRect(el) } : null;
        } catch(_) { return null; }
      }).filter(Boolean);
      window.parent.postMessage({ type: 'RECTS_RESULT', rects }, '*');
    }
  });

  // Link interception — navigate within studio
  document.addEventListener('click', e => {
    if (selectMode) return;
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript')) return;
    e.preventDefault();
    window.parent.postMessage({ type: 'NAVIGATE', href: a.href }, '*');
  });

  // Preview helpers
  function fromProps(a) {
    const f = {};
    if (a.x) f.x = a.x; if (a.y) f.y = a.y;
    if (a.scale !== 1) f.scale = a.scale;
    if (a.opacity !== 1) f.opacity = a.opacity;
    if (a.rotation) f.rotation = a.rotation;
    return f;
  }
  function tStr(f) {
    let t='';
    if(f.x) t+='translateX('+f.x+'px) ';
    if(f.y) t+='translateY('+f.y+'px) ';
    if(f.scale) t+='scale('+f.scale+') ';
    if(f.rotation) t+='rotate('+f.rotation+'deg) ';
    return t.trim()||'none';
  }
  function runPreview(a) {
    const els = document.querySelectorAll(a.selector);
    if (!els.length) return;
    const f = fromProps(a);
    els.forEach(el=>{ el.style.transform=tStr(f); el.style.opacity=f.opacity!==undefined?f.opacity:''; el.style.transition='none'; });
    setTimeout(()=>{ els.forEach(el=>{ el.style.transition='all '+a.duration+'s cubic-bezier(.16,1,.3,1)'; el.style.transform=''; el.style.opacity=''; }); }, 50);
  }
  function runAllPreviews(anims) {
    resetAll();
    anims.forEach(a => {
      const f = fromProps(a);
      const els = document.querySelectorAll(a.selector);
      if (!els.length) return;
      els.forEach(el=>{ el.style.transform=tStr(f); el.style.opacity=f.opacity!==undefined?f.opacity:''; el.style.transition='none'; });
      setTimeout(()=>{ els.forEach(el=>{ el.style.transition='all '+a.duration+'s cubic-bezier(.16,1,.3,1)'; el.style.transform=''; el.style.opacity=''; }); }, (a.delay||0)*1000+50);
    });
  }
  function resetAll() {
    document.querySelectorAll('*').forEach(el=>{ if(el.style.transition||el.style.transform){ el.style.transform=el.style.opacity=el.style.transition=''; } });
  }

  // Signal ready
  window.parent.postMessage({ type: 'FRAME_READY' }, '*');
})();
`;

// ══════════════════════════════════════════════════════════════════════════════
// postMessage BRIDGE — receive from iframe
// ══════════════════════════════════════════════════════════════════════════════

window.addEventListener('message', e => {
  const d = e.data;
  if (!d || !d.type) return;

  switch (d.type) {
    case 'FRAME_READY':
      state.frameReady = true;
      sendToFrame('SET_SELECT_MODE', { value: state.selectMode });
      break;

    case 'HOVER':
      if (!state.selectMode) return;
      showHoverHighlight(d.selector, d.rect);
      break;

    case 'HOVER_OUT':
      hoverHighlight.style.display = 'none';
      break;

    case 'SELECT':
      if (!state.selectMode) return;
      handleSelect(d.selector, d.rect, d.additive);
      break;

    case 'SCROLL':
      // Frame scrolled — request fresh rects for all selections so highlights follow
      if (state.selections.length > 0) {
        sendToFrame('GET_RECTS', { selectors: state.selections.map(s => s.selector) });
      }
      break;

    case 'RECTS_RESULT':
      // Update selection rects and repaint highlights
      d.rects.forEach(({ selector, rect }) => {
        const s = state.selections.find(s => s.selector === selector);
        if (s) s.rect = rect;
      });
      repaintSelectedHighlights();
      break;

    case 'NAVIGATE':
      handleFrameNavigate(d.href);
      break;

    case 'LIVE_INFO': {
      const hint = document.getElementById('live-scroll-hint');
      if (hint) {
        const canScroll = d.scrollHeight > d.clientHeight + 50;
        hint.textContent = canScroll ? '— scroll to trigger' : '— page too short to scroll';
      }
      break;
    }

    case 'LIVE_ERROR':
      showToast('GSAP error: ' + d.message);
      break;
  }
});

function sendToFrame(type, data = {}) {
  try { frame.contentWindow.postMessage({ type, ...data }, '*'); } catch(e) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// HOVER + SELECT HANDLING (overlay positioned over iframe)
// ══════════════════════════════════════════════════════════════════════════════

function showHoverHighlight(selector, rect) {
  // overlay-layer is position:absolute inside .demo-site, which the iframe
  // also fills completely. So rect coords from the frame (viewport-relative,
  // scroll-adjusted) map directly onto the overlay — no frameRect offset needed.
  const top = rect.top - rect.scrollY;
  hoverHighlight.style.display = 'block';
  hoverHighlight.style.left    = rect.left + 'px';
  hoverHighlight.style.top     = top + 'px';
  hoverHighlight.style.width   = rect.width  + 'px';
  hoverHighlight.style.height  = rect.height + 'px';
  hoverLabel.textContent = selector;
}

function handleSelect(selector, rect, additive = false) {
  const existingIdx = state.selections.findIndex(s => s.selector === selector);

  if (additive) {
    // Shift/Cmd+click: toggle this element in the selection
    if (existingIdx !== -1) {
      // Already selected — deselect it
      state.selections.splice(existingIdx, 1);
    } else {
      state.selections.push({ selector, rect });
    }
  } else {
    // Plain click: replace selection (unless clicking the only selected element)
    if (state.selections.length === 1 && existingIdx === 0) {
      // Clicking the only selected element deselects it
      state.selections = [];
    } else {
      state.selections = [{ selector, rect }];
    }
  }

  if (state.selections.length === 0) {
    clearSelected();
    return;
  }

  // Build comma-joined selector string for GSAP array syntax
  const combined = state.selections.map(s => s.selector).join(', ');
  selectorInput.value = combined;

  emptyState.style.display         = 'none';
  animConfig.style.display         = 'block';
  instructionOverlay.style.display = 'none';

  if (state.panelCollapsed) togglePanel();
  repaintSelectedHighlights();
  const count = state.selections.length;
  setStatus(count === 1
    ? `Selected: ${selector}`
    : `${count} elements selected — shift+click to add/remove`);
  syncFromFields();
}

// Paint one highlight div per selected element
function repaintSelectedHighlights() {
  selectedHighlights.innerHTML = '';
  const n = state.selections.length;

  // Update count badge
  const badge = document.getElementById('selection-count');
  if (badge) {
    if (n > 1) { badge.textContent = `${n} selected`; badge.style.display = 'inline'; }
    else        { badge.style.display = 'none'; }
  }

  state.selections.forEach(({ selector, rect }, i) => {
    const top = rect.top - rect.scrollY;
    const div = document.createElement('div');
    div.className = 'selected-highlight';
    div.style.cssText = `left:${rect.left}px;top:${top}px;width:${rect.width}px;height:${rect.height}px`;
    const lbl = document.createElement('div');
    lbl.className = 'selected-label' + (n > 1 ? ' multi' : '');
    lbl.textContent = n > 1 ? `[${i + 1}] ${selector}` : selector;
    div.appendChild(lbl);
    selectedHighlights.appendChild(div);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// PAGE MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

function createPage(label, html, baseUrl = '') {
  return {
    id:         Date.now() + Math.random(),
    label,
    html,
    baseUrl,
    animations: [],
  };
}

function addPage(page) {
  state.pages.push(page);
  renderPageTabs();
  switchPage(page.id);
  updatePageCount();
}

function switchPage(id) {
  // Save current animations back to current page before switching
  if (state.activePageId) {
    const cur = activePage();
    if (cur) cur.animations = [...getAnims()];
  }

  state.activePageId   = id;
  state.editingId      = null;
  state.selectedAnimId = null;
  state.selections     = [];
  state.frameReady     = false;
  if (typeof exitLiveMode === 'function') exitLiveMode();

  clearSelected();
  renderPageTabs();

  const page = activePage();
  if (!page) return;

  loadHtmlIntoFrame(page.html, page.baseUrl);
  afterAnimationsChange();
  setStatus(`Loaded: ${page.label}`);
}

function removePage(id) {
  const idx = state.pages.findIndex(p => p.id === id);
  if (idx === -1) return;
  state.pages.splice(idx, 1);

  if (state.activePageId === id) {
    if (state.pages.length) {
      switchPage(state.pages[Math.max(0, idx - 1)].id);
    } else {
      state.activePageId = null;
      showWelcomeScreen();
    }
  }
  renderPageTabs();
  updatePageCount();
}

function renderPageTabs() {
  pageTabs.innerHTML = '';
  state.pages.forEach(page => {
    const tab = document.createElement('div');
    tab.className = 'page-tab' + (page.id === state.activePageId ? ' active' : '');

    const favicon = document.createElement('div');
    favicon.className = 'page-tab-favicon';
    favicon.textContent = page.label[0]?.toUpperCase() || '?';

    const label = document.createElement('span');
    label.textContent = page.label;
    label.style.cssText = 'max-width:120px;overflow:hidden;text-overflow:ellipsis;';

    const close = document.createElement('div');
    close.className = 'page-tab-close';
    close.textContent = '×';
    close.title = 'Remove page';
    close.onclick = ev => { ev.stopPropagation(); removePage(page.id); };

    tab.onclick = () => { if (page.id !== state.activePageId) switchPage(page.id); };
    tab.appendChild(favicon); tab.appendChild(label); tab.appendChild(close);
    pageTabs.appendChild(tab);
  });
}

function showWelcomeScreen() {
  welcomeScreen.style.display = 'flex';
  frame.style.display         = 'none';
  overlayLayer.style.display  = 'none';
  instructionOverlay.style.display = 'none';
  timelineBody.innerHTML = '<div class="tl-empty">No page loaded — import a page to start</div>';
}

function hideWelcomeScreen() {
  welcomeScreen.style.display = 'none';
  frame.style.display         = 'block';
  overlayLayer.style.display  = 'block';
}

// ══════════════════════════════════════════════════════════════════════════════
// HTML LOADING — rewrite + inject into iframe srcdoc
// ══════════════════════════════════════════════════════════════════════════════

function loadHtmlIntoFrame(html, baseUrl) {
  showLoading('Loading page...');
  hideWelcomeScreen();

  // Reset ready flag: new srcdoc = fresh frame context
  state.frameReady = false;

  const rewritten = rewriteUrls(html, baseUrl);
  const injected  = injectFrameScript(rewritten);

  // One-time load listener instead of .onload assignment (avoids clobbering)
  const onLoad = () => {
    frame.removeEventListener('load', onLoad);
    hideLoading();
    instructionOverlay.style.display = 'block';
    // Always push current selectMode into the fresh frame context.
    // FRAME_READY postMessage may race with this, so both paths send it.
    setTimeout(() => {
      sendToFrame('SET_SELECT_MODE', { value: state.selectMode });
    }, 100);
  };

  frame.addEventListener('load', onLoad);
  frame.srcdoc = injected;
}

function rewriteUrls(html, baseUrl) {
  if (!baseUrl) return html;

  const base = new URL(baseUrl);
  const origin = base.origin;
  const basePath = base.href.substring(0, base.href.lastIndexOf('/') + 1);

  function resolve(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:') ||
        url.startsWith('http') || url.startsWith('//') || url.startsWith('#')) return url;
    try {
      if (url.startsWith('/')) return origin + url;
      return basePath + url;
    } catch(e) { return url; }
  }

  return html
    // src="..." href="..." url(...)
    .replace(/\bsrc=["']([^"']+)["']/g,  (m, u) => `src="${resolve(u)}"`)
    .replace(/\bhref=["']([^"'#][^"']*)["']/g, (m, u) => {
      // Don't rewrite nav links — keep them for interception
      if (u.endsWith('.css') || u.endsWith('.png') || u.endsWith('.jpg') || u.endsWith('.woff2') || u.endsWith('.woff') || u.endsWith('.ico')) {
        return `href="${resolve(u)}"`;
      }
      return m; // leave page links alone
    })
    .replace(/url\(['"]?([^'")]+)['"]?\)/g, (m, u) => `url("${resolve(u)}")`);
}

function injectFrameScript(html) {
  // FRAME_SCRIPT is already a self-executing IIFE — inject verbatim.
  // Neutralise any </script> sequences inside the injected code.
  const safe = FRAME_SCRIPT.replace(/<\/script/gi, '<\\\/script');
  const scriptTag = '<script>\n' + safe + '\n<\/script>';
  // Prefer injecting before </body>; fall back to appending
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, scriptTag + '</body>');
  }
  return html + scriptTag;
}

// ══════════════════════════════════════════════════════════════════════════════
// FRAME NAVIGATION (link clicks inside iframe)
// ══════════════════════════════════════════════════════════════════════════════

async function handleFrameNavigate(href) {
  const page = activePage();
  if (!page) return;

  // If same origin as current page, try to fetch
  showLoading(`Navigating to ${href}…`);

  try {
    const html = await fetchPageHtml(href);
    page.html    = html;
    page.baseUrl = href;
    page.label   = labelFromUrl(href);
    renderPageTabs();
    loadHtmlIntoFrame(html, href);
    setStatus(`Navigated: ${href}`);
    showToast(`Navigated — animations preserved`);
  } catch(e) {
    hideLoading();
    showToast(`Can't navigate: ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// IMPORT MODAL
// ══════════════════════════════════════════════════════════════════════════════

function openImportModal() {
  document.getElementById('modal-backdrop').style.display = 'block';
  document.getElementById('import-modal').style.display  = 'flex';
  document.getElementById('url-input').focus();
}

function closeImportModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  document.getElementById('import-modal').style.display  = 'none';
  document.getElementById('url-error').style.display     = 'none';
}

function switchModalTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('mtab-' + tab).classList.add('active');
  document.getElementById('mtab-url-body').style.display  = tab === 'url'  ? 'block' : 'none';
  document.getElementById('mtab-file-body').style.display = tab === 'file' ? 'block' : 'none';
}

// ── URL FETCH ─────────────────────────────────────────────────────────────────

async function fetchUrl() {
  const url = document.getElementById('url-input').value.trim();
  if (!url) return;

  const errEl = document.getElementById('url-error');
  errEl.style.display = 'none';

  let finalUrl = url;
  if (!finalUrl.startsWith('http')) finalUrl = 'https://' + finalUrl;

  showLoading(`Fetching ${finalUrl}…`);
  closeImportModal();

  try {
    const html = await fetchPageHtml(finalUrl);
    const label = pageNameInput() || labelFromUrl(finalUrl);
    addPage(createPage(label, html, finalUrl));
    showToast(`Page loaded: ${label}`);
  } catch(err) {
    hideLoading();
    // Re-open modal with error
    openImportModal();
    errEl.textContent = `Fetch failed: ${err.message}. Try the HTML File tab instead.`;
    errEl.style.display = 'block';
  }
}

async function fetchPageHtml(url) {
  // Try direct first (works for same-origin / CORS-enabled)
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (res.ok) return await res.text();
  } catch(e) { /* fall through to proxy */ }

  // Proxy fallback
  const proxy = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  const res   = await fetch(proxy);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data  = await res.json();
  if (!data.contents) throw new Error('Empty response from proxy');
  return data.contents;
}

// ── FILE IMPORT ───────────────────────────────────────────────────────────────

function handleFileDrop(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadHtmlFile(file);
}

function handleFileInput(e) {
  const file = e.target.files[0];
  if (file) loadHtmlFile(file);
}

function loadHtmlFile(file) {
  const label = pageNameInput() || file.name.replace(/\.(html?)/i, '');
  const reader = new FileReader();
  reader.onload = ev => {
    const html = ev.target.result;
    // For local files, baseUrl is empty — relative paths won't resolve
    // but styles/scripts using absolute or inline URLs will work
    addPage(createPage(label, html, ''));
    closeImportModal();
    showToast(`File loaded: ${label}`);
  };
  reader.readAsText(file);
}

// ── DEMO PAGE ─────────────────────────────────────────────────────────────────

function loadDemoPage() {
  const html = getDemoHTML();
  addPage(createPage('Demo — Luminary', html, ''));
}

function getDemoHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Luminary — Demo</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',system-ui,sans-serif;background:#fafafa;color:#111}
  nav{display:flex;justify-content:space-between;align-items:center;padding:20px 72px;border-bottom:1px solid #eee;background:#fff}
  .nav-logo{font-size:18px;font-weight:700;letter-spacing:-.5px}
  .nav-links{display:flex;gap:28px}
  .nav-link{color:#888;font-size:13px;text-decoration:none}
  .hero{padding:80px 72px 100px;max-width:960px}
  .hero-tag{display:inline-block;background:#f0f0f0;color:#555;font-size:10px;font-weight:600;padding:3px 10px;border-radius:3px;margin-bottom:20px;letter-spacing:.6px;text-transform:uppercase;border:1px solid #e0e0e0}
  .hero-title{font-size:60px;font-weight:700;line-height:1.06;color:#111;margin-bottom:20px;letter-spacing:-2px}
  .hero-subtitle{font-size:17px;color:#777;max-width:480px;line-height:1.65;margin-bottom:36px}
  .cta-button{display:inline-block;background:#111;color:#fff;padding:13px 28px;border-radius:5px;font-size:14px;font-weight:600;text-decoration:none;border:none;cursor:pointer}
  .section{padding:80px 72px}
  .section-title{font-size:34px;font-weight:700;color:#111;margin-bottom:48px;letter-spacing:-1px}
  .cards-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
  .card{background:#fff;border-radius:10px;padding:28px;border:1px solid #e8e8e8}
  .card-icon{width:40px;height:40px;border-radius:8px;background:#111;margin-bottom:16px;display:flex;align-items:center;justify-content:center;font-size:18px}
  .card-title{font-size:16px;font-weight:600;color:#111;margin-bottom:8px}
  .card-text{font-size:13px;color:#888;line-height:1.6}
  .features{padding:80px 72px;background:#fff;border-top:1px solid #eee}
  .feature-row{display:flex;gap:48px;align-items:center;margin-bottom:64px}
  .feature-row:last-child{margin-bottom:0}
  .feature-copy{flex:1}
  .feature-visual{flex:1;height:200px;background:#f5f5f5;border-radius:10px;border:1px solid #eee;display:flex;align-items:center;justify-content:center;font-size:40px;color:#ccc}
  .feature-label{font-size:11px;font-weight:600;color:#888;letter-spacing:.8px;text-transform:uppercase;margin-bottom:12px}
  .feature-title{font-size:28px;font-weight:700;color:#111;margin-bottom:12px;letter-spacing:-.5px}
  .feature-desc{font-size:14px;color:#777;line-height:1.7}
  footer{padding:40px 72px;border-top:1px solid #eee;display:flex;justify-content:space-between;align-items:center}
  .footer-logo{font-size:16px;font-weight:700;color:#111}
  .footer-note{font-size:12px;color:#aaa}
</style>
</head>
<body>

<nav>
  <div class="nav-logo">Luminary</div>
  <div class="nav-links">
    <a href="#" class="nav-link">Product</a>
    <a href="#" class="nav-link">Pricing</a>
    <a href="#" class="nav-link">Docs</a>
    <a href="#" class="nav-link">Blog</a>
  </div>
</nav>

<div class="hero">
  <div class="hero-tag">New Release</div>
  <h1 class="hero-title">Design meets<br>velocity.</h1>
  <p class="hero-subtitle">Build faster, ship smarter. The platform that makes complex animations feel effortless for every team.</p>
  <button class="cta-button">Get started free →</button>
</div>

<section class="section">
  <h2 class="section-title">Everything you need</h2>
  <div class="cards-grid">
    <div class="card">
      <div class="card-icon">⚡</div>
      <div class="card-title">Blazing Fast</div>
      <div class="card-text">Optimized rendering pipeline that keeps every animation at 60fps, even on low-power devices.</div>
    </div>
    <div class="card">
      <div class="card-icon">◎</div>
      <div class="card-title">Pixel Perfect</div>
      <div class="card-text">Sub-pixel precision with hardware acceleration. Your animations look exactly as designed.</div>
    </div>
    <div class="card">
      <div class="card-icon">⊞</div>
      <div class="card-title">Extensible</div>
      <div class="card-text">Plugin architecture lets you add custom effects, easing functions, and motion paths.</div>
    </div>
  </div>
</section>

<section class="features">
  <div class="feature-row">
    <div class="feature-copy">
      <div class="feature-label">Timeline</div>
      <h3 class="feature-title">Sequence with precision</h3>
      <p class="feature-desc">Build complex multi-step animations with our visual timeline. Control every frame, add staggered reveals, and scrub through the sequence in real time.</p>
    </div>
    <div class="feature-visual">🎬</div>
  </div>
  <div class="feature-row">
    <div class="feature-visual">🎯</div>
    <div class="feature-copy">
      <div class="feature-label">ScrollTrigger</div>
      <h3 class="feature-title">Scroll-driven magic</h3>
      <p class="feature-desc">Animate elements as they enter the viewport. Scrub animations to scroll position for immersive storytelling that feels natural on any device.</p>
    </div>
  </div>
</section>

<footer>
  <div class="footer-logo">Luminary</div>
  <div class="footer-note">© 2026 Luminary Inc. All rights reserved.</div>
</footer>

</body>
</html>`;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function labelFromUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '').split('/').pop();
    return path || u.hostname;
  } catch(e) { return url.substring(0, 20); }
}

function pageNameInput() {
  return document.getElementById('page-name-input').value.trim();
}

function showLoading(msg = 'Loading…') {
  loadingText.textContent = msg;
  loadingOverlay.style.display = 'flex';
}
function hideLoading() {
  loadingOverlay.style.display = 'none';
}

function updatePageCount() {
  document.getElementById('page-count').textContent = `${state.pages.length} page${state.pages.length !== 1 ? 's' : ''}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// SELECT MODE
// ══════════════════════════════════════════════════════════════════════════════

function toggleSelectMode() {
  state.selectMode = !state.selectMode;
  const badge = document.getElementById('mode-badge');
  const btn   = document.getElementById('toggle-select-btn');
  badge.textContent = state.selectMode ? 'SELECT' : 'PREVIEW';
  badge.classList.toggle('active', state.selectMode);
  btn.classList.toggle('active',   state.selectMode);
  sendToFrame('SET_SELECT_MODE', { value: state.selectMode });
  if (!state.selectMode) hoverHighlight.style.display = 'none';
}

function clearSelected() {
  state.selections       = [];
  selectorInput.value    = '';
  selectedHighlights.innerHTML  = '';
  hoverHighlight.style.display  = 'none';
  emptyState.style.display      = 'flex';
  animConfig.style.display      = 'none';
  const badge = document.getElementById('selection-count');
  if (badge) badge.style.display = 'none';
  setStatus('Ready — click to select · shift+click to multi-select');
}

// ══════════════════════════════════════════════════════════════════════════════
// UNDO / REDO  (operates on activePage().animations)
// ══════════════════════════════════════════════════════════════════════════════

function snapshot() {
  const page = activePage(); if (!page) return;
  state.undoStack.push({ pageId: page.id, anims: JSON.stringify(page.animations) });
  if (state.undoStack.length > 60) state.undoStack.shift();
  state.redoStack = [];
  updateUndoButtons();
}

function undo() {
  if (!state.undoStack.length) return;
  const page = activePage(); if (!page) return;
  state.redoStack.push({ pageId: page.id, anims: JSON.stringify(page.animations) });
  const snap = state.undoStack.pop();
  if (snap.pageId === page.id) page.animations = JSON.parse(snap.anims);
  state.editingId = null;
  afterAnimationsChange(); updateUndoButtons(); showToast('Undo');
}

function redo() {
  if (!state.redoStack.length) return;
  const page = activePage(); if (!page) return;
  state.undoStack.push({ pageId: page.id, anims: JSON.stringify(page.animations) });
  const snap = state.redoStack.pop();
  if (snap.pageId === page.id) page.animations = JSON.parse(snap.anims);
  state.editingId = null;
  afterAnimationsChange(); updateUndoButtons(); showToast('Redo');
}

function updateUndoButtons() {
  document.getElementById('btn-undo').disabled = state.undoStack.length === 0;
  document.getElementById('btn-redo').disabled = state.redoStack.length === 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// PANEL + TIMELINE RESIZE
// ══════════════════════════════════════════════════════════════════════════════

function applyPanelWidth(w) {
  state.panelWidth = Math.min(540, Math.max(220, w));
  rightPanel.style.width = state.panelWidth + 'px';
}
applyPanelWidth(state.panelWidth);

resizeHandle.addEventListener('mousedown', e => {
  if (state.panelCollapsed) return;
  e.preventDefault();
  resizeHandle.classList.add('dragging');
  document.body.style.cssText += 'cursor:col-resize;user-select:none';
  const sx = e.clientX, sw = state.panelWidth;
  const mv = e => applyPanelWidth(sw + (sx - e.clientX));
  const up = () => { resizeHandle.classList.remove('dragging'); document.body.style.cursor=document.body.style.userSelect=''; document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); };
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
});

function togglePanel() {
  state.panelCollapsed = !state.panelCollapsed;
  rightPanel.classList.toggle('collapsed', state.panelCollapsed);
  resizeHandle.classList.toggle('hidden',   state.panelCollapsed);
  collapseTab.textContent = state.panelCollapsed ? '‹' : '›';
  if (!state.panelCollapsed) applyPanelWidth(state.panelWidth);
}

function applyTimelineHeight(h) {
  state.timelineHeight = Math.min(380, Math.max(32, h));
  timelineSection.style.height = state.timelineHeight + 'px';
}
applyTimelineHeight(state.timelineHeight);

tlResizeHandle.addEventListener('mousedown', e => {
  e.preventDefault();
  tlResizeHandle.classList.add('dragging');
  document.body.style.cssText += 'cursor:row-resize;user-select:none';
  const sy = e.clientY, sh = state.timelineHeight;
  const mv = e => applyTimelineHeight(sh + (sy - e.clientY));
  const up = () => { tlResizeHandle.classList.remove('dragging'); document.body.style.cursor=document.body.style.userSelect=''; document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); };
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
});

// ══════════════════════════════════════════════════════════════════════════════
// ANIMATION TYPE / PRESETS / FIELDS
// ══════════════════════════════════════════════════════════════════════════════

const ANIM_DEFAULTS = {
  fade:  {x:0,y:0,scale:1,opacity:0,rotation:0},
  slide: {x:0,y:60,scale:1,opacity:0,rotation:0},
  scale: {x:0,y:0,scale:.8,opacity:0,rotation:0},
  rotate:{x:0,y:0,scale:1,opacity:0,rotation:-15},
};

function setAnimType(type) {
  document.querySelectorAll('.anim-type-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('type-' + type).classList.add('active');
  const d = ANIM_DEFAULTS[type];
  setF('x-input',d.x); setF('y-input',d.y); setF('scale-input',d.scale);
  setF('opacity-input',d.opacity); setF('rotation-input',d.rotation);
  syncFromFields();
}

const PRESETS = {
  'hero-in':   {x:0,y:80,scale:1,opacity:0,rotation:0,  duration:1.2,ease:'power3.out',delay:0},
  'fade-up':   {x:0,y:40,scale:1,opacity:0,rotation:0,  duration:.8, ease:'power2.out',delay:0},
  'bounce-in': {x:0,y:0, scale:.3,opacity:0,rotation:0, duration:1.0,ease:'bounce.out',delay:0},
  'slide-left':{x:-80,y:0,scale:1,opacity:0,rotation:0, duration:.7, ease:'power2.out',delay:0},
  'zoom-in':   {x:0,y:0, scale:.6,opacity:0,rotation:0, duration:.8, ease:'back.out(1.7)',delay:0},
  'flip':      {x:0,y:0, scale:1, opacity:0,rotation:-90,duration:.9,ease:'power3.out',delay:0},
};

function applyPreset(name) {
  const p = PRESETS[name]; if (!p) return;
  setF('x-input',p.x); setF('y-input',p.y); setF('scale-input',p.scale);
  setF('opacity-input',p.opacity); setF('rotation-input',p.rotation);
  setSl('duration-slider','duration-val',p.duration,'s');
  setSl('delay-slider','delay-val',p.delay,'s');
  const s = document.getElementById('ease-input');
  for (const o of s.options) if (o.value===p.ease){s.value=p.ease;break;}
  syncFromFields(); showToast(`Preset "${name}" applied`);
}

function setF(id, val) { document.getElementById(id).value = val; }
function setSl(id, vid, v, sfx) { document.getElementById(id).value=v; document.getElementById(vid).textContent=parseFloat(v).toFixed(1)+sfx; }

function toggleScrollTrigger() {
  state.scrollTriggerOn = !state.scrollTriggerOn;
  document.getElementById('scroll-toggle').classList.toggle('on', state.scrollTriggerOn);
  document.getElementById('st-panel').style.display = state.scrollTriggerOn ? 'block' : 'none';
  syncFromFields(); updateCDN();
}
function toggleScrub() {
  state.scrubOn = !state.scrubOn;
  document.getElementById('scrub-toggle').classList.toggle('on', state.scrubOn);
  document.getElementById('scrub-num-wrap').style.display = state.scrubOn ? 'flex' : 'none';
  syncFromFields();
}

// ST flag pills (pin / markers / once)
function toggleSTFlag(id) {
  const map = { 'st-pin': 'stPin', 'st-markers': 'stMarkers', 'st-once': 'stOnce' };
  const key = map[id]; if (!key) return;
  state[key] = !state[key];
  document.getElementById(id).classList.toggle('active', state[key]);
  syncFromFields();
}

// toggleActions preset chips
function applyTAPreset(value, chipEl) {
  document.querySelectorAll('.st-ta-chip').forEach(c => c.classList.remove('active'));
  chipEl.classList.add('active');
  const customWrap = document.getElementById('st-ta-custom');
  if (value === 'custom') {
    state.stCustomTA = true;
    customWrap.style.display = 'block';
    buildCustomTA();
  } else {
    state.stCustomTA = false;
    state.stToggleActions = value;
    customWrap.style.display = 'none';
    syncFromFields();
  }
}

// Build toggleActions string from the 4 custom selects
function buildCustomTA() {
  const enter     = document.getElementById('ta-enter').value;
  const leave     = document.getElementById('ta-leave').value;
  const enterBack = document.getElementById('ta-enter-back').value;
  const leaveBack = document.getElementById('ta-leave-back').value;
  state.stToggleActions = `${enter} ${leave} ${enterBack} ${leaveBack}`;
  document.getElementById('st-toggle-actions').value = state.stToggleActions;
  syncFromFields();
}

// Activate the correct preset chip for a given toggleActions string
function syncTAChips(value) {
  const chips = document.querySelectorAll('.st-ta-chip');
  let matched = false;
  chips.forEach(c => {
    c.classList.remove('active');
    if (c.dataset.preset === value) { c.classList.add('active'); matched = true; }
  });
  // Stamp data-preset onto chips if not already done
  if (!chips[0].dataset.preset) {
    const presets = ['play none none none','play none none reverse','restart none none none','play none none reset','play pause resume reverse','custom'];
    chips.forEach((c,i) => c.dataset.preset = presets[i]);
  }
  // Re-check after stamping
  let found = false;
  chips.forEach(c => {
    c.classList.remove('active');
    if (c.dataset.preset === value) { c.classList.add('active'); found = true; }
  });
  if (!found) {
    // mark custom chip active and populate selects
    document.getElementById('st-ta-custom-chip').classList.add('active');
    document.getElementById('st-ta-custom').style.display = 'block';
    const parts = value.split(' ');
    if (parts.length === 4) {
      const ids = ['ta-enter','ta-leave','ta-enter-back','ta-leave-back'];
      ids.forEach((id,i) => { const el=document.getElementById(id); if(el) el.value=parts[i]; });
    }
    state.stCustomTA = true;
  } else {
    document.getElementById('st-ta-custom').style.display = state.stCustomTA ? 'block' : 'none';
    state.stCustomTA = false;
  }
}
function toggleTimeline() {
  state.timelineOn = !state.timelineOn;
  document.getElementById('timeline-toggle').classList.toggle('on', state.timelineOn);
  syncFromFields();
}

function readFields() {
  return {
    selector:      selectorInput.value.trim() || '.element',
    method:        document.getElementById('gsap-method').value,
    ease:          document.getElementById('ease-input').value,
    duration:      parseFloat(document.getElementById('duration-slider').value),
    delay:         parseFloat(document.getElementById('delay-slider').value),
    x:             parseFloat(document.getElementById('x-input').value)       || 0,
    y:             parseFloat(document.getElementById('y-input').value)       || 0,
    scale:         parseFloat(document.getElementById('scale-input').value),
    opacity:       parseFloat(document.getElementById('opacity-input').value),
    rotation:      parseFloat(document.getElementById('rotation-input').value)|| 0,
    stagger:       parseFloat(document.getElementById('stagger-input').value) || 0,
    scrollTrigger:     state.scrollTriggerOn,
    stTrigger:         document.getElementById('st-trigger').value.trim(),
    stStart:           document.getElementById('st-start').value,
    stEnd:             document.getElementById('st-end').value,
    scrub:             state.scrubOn,
    scrubAmount:       parseFloat(document.getElementById('scrub-amount').value) || 1,
    stToggleActions:   document.getElementById('st-toggle-actions').value || 'play none none none',
    stPin:             state.stPin,
    stMarkers:         state.stMarkers,
    stOnce:            state.stOnce,
    inTimeline:    state.timelineOn,
  };
}

function populateFields(p) {
  selectorInput.value = p.selector || '';
  setF('x-input',p.x??0); setF('y-input',p.y??0);
  setF('scale-input',p.scale??1); setF('opacity-input',p.opacity??0);
  setF('rotation-input',p.rotation??0); setF('stagger-input',p.stagger??0);
  setSl('duration-slider','duration-val',p.duration??1,'s');
  setSl('delay-slider','delay-val',p.delay??0,'s');
  const e=document.getElementById('ease-input');
  let easeFound = false;
  for(const o of e.options) if(o.value===p.ease){ e.value=p.ease; easeFound=true; break; }
  // If not in list, set value directly — browser keeps it as a custom value
  if (!easeFound && p.ease) e.value = p.ease;
  document.getElementById('gsap-method').value = p.method||'from';
  state.scrollTriggerOn  = !!p.scrollTrigger;
  state.scrubOn          = !!p.scrub;
  state.scrubAmount      = p.scrubAmount ?? 1;
  state.stPin            = !!p.stPin;
  state.stMarkers        = !!p.stMarkers;
  state.stOnce           = !!p.stOnce;
  state.stToggleActions  = p.stToggleActions || 'play none none none';
  state.timelineOn       = !!p.inTimeline;

  document.getElementById('scroll-toggle').classList.toggle('on', state.scrollTriggerOn);
  document.getElementById('st-panel').style.display = state.scrollTriggerOn ? 'block' : 'none';
  document.getElementById('scrub-toggle').classList.toggle('on', state.scrubOn);
  document.getElementById('scrub-num-wrap').style.display = state.scrubOn ? 'flex' : 'none';
  document.getElementById('scrub-amount').value = state.scrubAmount;
  document.getElementById('timeline-toggle').classList.toggle('on', state.timelineOn);
  document.getElementById('st-pin').classList.toggle('active', state.stPin);
  document.getElementById('st-markers').classList.toggle('active', state.stMarkers);
  document.getElementById('st-once').classList.toggle('active', state.stOnce);
  document.getElementById('st-toggle-actions').value = state.stToggleActions;
  if (p.stStart)   setF('st-start',   p.stStart);
  if (p.stEnd)     setF('st-end',     p.stEnd);
  if (p.stTrigger) setF('st-trigger', p.stTrigger);
  syncTAChips(state.stToggleActions);
}

// ══════════════════════════════════════════════════════════════════════════════
// SYNC FIELDS → CODE
// ══════════════════════════════════════════════════════════════════════════════

function syncFromFields() {
  if (state.editingId !== null) {
    const page = activePage(); if (!page) return;
    const idx = page.animations.findIndex(a => a.id === state.editingId);
    if (idx !== -1) { page.animations[idx] = {...page.animations[idx], ...readFields()}; renderTimeline(); renderAnimationsList(); }
  }
  codeEditor.value = generateFullCode();
  clearCodeError();
}

// ══════════════════════════════════════════════════════════════════════════════
// CODE EDITOR — 500ms debounce parse
// ══════════════════════════════════════════════════════════════════════════════

codeEditor.addEventListener('input', () => {
  dirtyBadge.textContent = 'parsing…'; dirtyBadge.classList.add('visible');
  clearTimeout(state.codeParseTimer);
  state.codeParseTimer = setTimeout(parseCodeEditor, 500);
});

function parseCodeEditor() {
  const raw = codeEditor.value;
  try {
    const parsed = parseGSAPCode(raw);
    const page   = activePage(); if (!page) return;
    snapshot();
    page.animations = parsed;
    state.editingId = null;
    afterAnimationsChange(false);
    dirtyBadge.textContent = `${parsed.length} anim${parsed.length!==1?'s':''} parsed`;
    setTimeout(() => dirtyBadge.classList.remove('visible'), 1800);
    clearCodeError(); showToast('Code synced ✓');
  } catch(err) { showCodeError(err.message); dirtyBadge.classList.remove('visible'); }
}

function showCodeError(msg) { parseError.textContent='⚠ '+msg; parseError.classList.add('visible'); }
function clearCodeError()   { parseError.classList.remove('visible'); }

function parseGSAPCode(code) {
  const results = [];
  const callRe = /gsap\.(from|to|fromTo)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*(\{[\s\S]*?\})\s*\)/g;
  const tlRe   = /tl\.(from|to|fromTo)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*(\{[\s\S]*?\})\s*(?:,\s*["'`][^"'`]*["'`])?\s*\)/g;
  function extractObj(s) { return Function('"use strict";return('+s+')')(); }
  function objToAnim(method, selector, obj, inTimeline) {
    const st = obj.scrollTrigger;
    return { id: Date.now()+Math.random(), selector, method,
      ease: obj.ease||'power3.out', duration: obj.duration??1, delay: obj.delay??0,
      x: obj.x??0, y: obj.y??0, scale: obj.scale??1, opacity: obj.opacity??(method==='to'?1:0),
      rotation: obj.rotation??0, stagger: obj.stagger??0,
      scrollTrigger: !!st,
      stTrigger:     st?.trigger !== selector ? (st?.trigger || '') : '',
      stStart:       st?.start || 'top 80%',
      stEnd:         st?.end   || 'bottom 20%',
      scrub:         !!(st?.scrub !== undefined && st?.scrub !== false),
      scrubAmount:   typeof st?.scrub === 'number' ? st.scrub : 1,
      stToggleActions: st?.toggleActions || 'play none none none',
      stPin:         !!st?.pin,
      stMarkers:     !!st?.markers,
      stOnce:        !!st?.once,
      inTimeline };
  }
  let m;
  while ((m=callRe.exec(code))!==null) { try { results.push(objToAnim(m[1],m[2],extractObj(m[3]),false)); } catch(e){} }
  while ((m=tlRe.exec(code))!==null)   { try { results.push(objToAnim(m[1],m[2],extractObj(m[3]),true));  } catch(e){} }
  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
// ADD / EDIT / COMMIT
// ══════════════════════════════════════════════════════════════════════════════

function commitAnimation() {
  if (!selectorInput.value.trim()) { showToast('Select an element first'); return; }
  const page = activePage(); if (!page) { showToast('No page loaded'); return; }

  snapshot();
  const props = readFields();

  if (state.editingId !== null) {
    const idx = page.animations.findIndex(a => a.id === state.editingId);
    if (idx !== -1) page.animations[idx] = {...page.animations[idx], ...props};
    cancelEdit(); showToast(`Updated — ${props.selector}`);
  } else {
    page.animations.push({...props, id: Date.now()});
    showToast(`Added — ${props.selector}`);
  }
  afterAnimationsChange(); showTab('layers');
}

function editAnimation(id) {
  const page = activePage(); if (!page) return;
  const anim = page.animations.find(a => a.id === id); if (!anim) return;
  state.editingId = id; state.selectedAnimId = id;
  emptyState.style.display='none'; animConfig.style.display='block';
  populateFields(anim);
  const idx = page.animations.findIndex(a => a.id === id);
  editIndicator.style.display='flex';
  editIndicatorText.textContent=`Editing #${idx+1} — ${anim.selector}`;
  addAnimBtn.textContent='↩ Save changes'; commitBtn.textContent='Save Changes';
  showTab('animate'); if (state.panelCollapsed) togglePanel();
  renderTimeline(); renderAnimationsList();
}

function cancelEdit() {
  state.editingId=null;
  editIndicator.style.display='none';
  addAnimBtn.textContent='+ Add to stack'; commitBtn.textContent='Add Animation';
  renderTimeline(); renderAnimationsList();
}

function copyAnimValues(id) {
  const page = activePage(); if (!page) return;
  const anim = page.animations.find(a => a.id === id); if (!anim) return;
  populateFields(anim); selectorInput.value=anim.selector;
  emptyState.style.display='none'; animConfig.style.display='block';
  state.editingId=null;
  editIndicator.style.display='none';
  addAnimBtn.textContent='+ Add to stack'; commitBtn.textContent='Add Animation';
  if (state.panelCollapsed) togglePanel();
  showTab('animate'); syncFromFields();
  showToast('Values copied — modify and Add');
}

function deleteAnim(id) {
  const page = activePage(); if (!page) return;
  snapshot();
  page.animations = page.animations.filter(a => a.id !== id);
  if (state.editingId === id) cancelEdit();
  if (state.selectedAnimId === id) state.selectedAnimId = null;
  afterAnimationsChange();
}

function clearAllAnimations() {
  const page = activePage(); if (!page) return;
  snapshot(); page.animations = []; state.editingId=null; state.selectedAnimId=null;
  cancelEdit(); afterAnimationsChange(); showToast('All animations cleared');
}

function selectAnim(id) {
  state.selectedAnimId = id; renderTimeline(); renderAnimationsList();
}

function afterAnimationsChange(updateCodeEditor = true) {
  renderTimeline(); renderAnimationsList(); updateAnimCount();
  if (updateCodeEditor) codeEditor.value = generateFullCode();
  updateCDN();
  if (typeof maybeSyncLive === 'function') maybeSyncLive();
}

// ══════════════════════════════════════════════════════════════════════════════
// TIMELINE RENDER
// ══════════════════════════════════════════════════════════════════════════════

const TL_SHADES = [
  {bg:'rgba(255,255,255,.10)',bd:'rgba(255,255,255,.24)',fg:'#ccc'},
  {bg:'rgba(255,255,255,.06)',bd:'rgba(255,255,255,.15)',fg:'#888'},
  {bg:'rgba(255,255,255,.13)',bd:'rgba(255,255,255,.30)',fg:'#ddd'},
  {bg:'rgba(255,255,255,.05)',bd:'rgba(255,255,255,.13)',fg:'#777'},
  {bg:'rgba(255,255,255,.08)',bd:'rgba(255,255,255,.20)',fg:'#aaa'},
];

function renderTimeline() {
  timelineBody.innerHTML = '';
  const anims = getAnims();
  if (!anims.length) {
    timelineBody.innerHTML = '<div class="tl-empty">No animations — select elements and add animations</div>';
    return;
  }
  const total = anims.reduce((acc,a) => Math.max(acc,(a.delay||0)+(a.duration||1)),0)||4;
  anims.forEach((anim,i) => {
    const c = TL_SHADES[i%TL_SHADES.length];
    const isSel = anim.id===state.selectedAnimId || anim.id===state.editingId;
    const row = document.createElement('div');
    row.className = 'tl-row';

    const label = document.createElement('div');
    label.className = 'tl-row-label'+(isSel?' selected':'');
    label.textContent = anim.selector; label.title = anim.selector;
    label.onclick = () => { selectAnim(anim.id); editAnimation(anim.id); };

    const track = document.createElement('div');
    track.className = 'tl-track';

    if (i===0) {
      const cur = document.createElement('div');
      cur.className='tl-cursor'; cur.id='tl-cursor-main'; cur.style.left='0%';
      track.appendChild(cur);
    }

    const block = document.createElement('div');
    block.className = 'tl-block'+(isSel?' selected':'');
    block.style.cssText=`left:${((anim.delay||0)/total*100).toFixed(2)}%;width:${Math.max((anim.duration||1)/total*100,3).toFixed(2)}%;background:${c.bg};border:1px solid ${c.bd};color:${c.fg}`;
    block.textContent = `${anim.method}·${anim.duration}s`;
    block.title = `${anim.selector} — ${anim.duration}s ${anim.ease}`;
    block.onclick = () => { selectAnim(anim.id); editAnimation(anim.id); };
    track.appendChild(block);

    row.appendChild(label); row.appendChild(track);
    timelineBody.appendChild(row);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// LAYERS LIST — drag-to-reorder
// ══════════════════════════════════════════════════════════════════════════════

function renderAnimationsList() {
  const list = document.getElementById('animations-list');
  const anims = getAnims();
  if (!anims.length) {
    list.innerHTML='<div class="empty-state"><div class="empty-icon">≡</div><div class="empty-title">No animations</div><div class="empty-desc">Select elements and add animations.</div></div>';
    return;
  }
  list.innerHTML='';
  anims.forEach((anim,i) => {
    const isSel = anim.id===state.selectedAnimId||anim.id===state.editingId;
    const item = document.createElement('div');
    item.className='anim-item'+(isSel?' selected':'');
    item.draggable=true;
    item.innerHTML=`
      <div class="anim-item-drag-handle" title="Drag to reorder">⋮⋮</div>
      <div class="anim-item-content">
        <div class="anim-item-header">
          <span class="anim-item-selector">${anim.selector}</span>
          <span class="anim-item-type">gsap.${anim.method}</span>
        </div>
        <div class="anim-item-desc">${buildDesc(anim)}</div>
        <div class="anim-item-actions">
          <button class="icon-btn" onclick="editAnimation(${anim.id})">✎ Edit</button>
          <button class="icon-btn" onclick="copyAnimValues(${anim.id})">⎘ Copy</button>
          <button class="icon-btn" onclick="previewAnim(${i})">▶</button>
          <button class="icon-btn" onclick="deleteAnim(${anim.id})">✕</button>
        </div>
      </div>`;
    item.addEventListener('dragstart', e => { state.dragSrcIndex=i; item.classList.add('dragging-item'); e.dataTransfer.effectAllowed='move'; });
    item.addEventListener('dragend',   () => { item.classList.remove('dragging-item'); list.querySelectorAll('.anim-item').forEach(el=>el.classList.remove('drag-over-item')); });
    item.addEventListener('dragover',  e => { e.preventDefault(); item.classList.add('drag-over-item'); });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over-item'));
    item.addEventListener('drop', e => {
      e.preventDefault(); item.classList.remove('drag-over-item');
      const src=state.dragSrcIndex, dest=i;
      if (src===null||src===dest) return;
      const page=activePage(); if(!page) return;
      snapshot();
      const a=[...page.animations];
      const [moved]=a.splice(src,1); a.splice(dest,0,moved);
      page.animations=a; state.dragSrcIndex=null;
      afterAnimationsChange();
    });
    list.appendChild(item);
  });
}

function buildDesc(a) {
  const p=[];
  if(a.y!==0)p.push(`y:${a.y}`); if(a.x!==0)p.push(`x:${a.x}`);
  if(a.scale!==1)p.push(`scale:${a.scale}`); if(a.opacity!==1)p.push(`op:${a.opacity}`);
  if(a.rotation!==0)p.push(`rot:${a.rotation}`);
  p.push(`${a.duration}s`,a.ease.split('.')[0]);
  if(a.scrollTrigger)p.push('ST'); if(a.inTimeline)p.push('TL');
  return p.join(' · ');
}

// ══════════════════════════════════════════════════════════════════════════════
// CODE GENERATION
// ══════════════════════════════════════════════════════════════════════════════

function buildAnimObj(p) {
  const o={};
  if(p.x!==0)o.x=p.x; if(p.y!==0)o.y=p.y; if(p.scale!==1)o.scale=p.scale;
  if(p.opacity!==1)o.opacity=p.opacity; if(p.rotation!==0)o.rotation=p.rotation;
  o.duration=p.duration; if(p.delay>0)o.delay=p.delay; o.ease=p.ease;
  if(p.stagger>0)o.stagger=p.stagger;
  if (p.scrollTrigger) {
    const trigger = p.stTrigger || p.selector;
    const st = { trigger };
    if (p.stStart)  st.start = p.stStart;
    if (p.stEnd)    st.end   = p.stEnd;
    // scrub: true (locked) or number (smoothing)
    if (p.scrub) st.scrub = (p.scrubAmount && p.scrubAmount > 0) ? p.scrubAmount : true;
    // toggleActions — omit if scrub is on (they conflict) or if it's the default
    if (!p.scrub && p.stToggleActions && p.stToggleActions !== 'play none none none') {
      st.toggleActions = p.stToggleActions;
    } else if (!p.scrub) {
      st.toggleActions = p.stToggleActions;
    }
    if (p.stPin)     st.pin     = true;
    if (p.stMarkers) st.markers = true;
    if (p.stOnce)    st.once    = true;
    o.scrollTrigger = st;
  }
  return o;
}
function objToCode(obj,ind='  '){
  return Object.entries(obj).map(([k,v])=>{
    if(typeof v==='object'&&v!==null){const inn=Object.entries(v).map(([k2,v2])=>`${ind}  ${k2}: ${JSON.stringify(v2)},`).join('\n');return `${ind}${k}: {\n${inn}\n${ind}},`;}
    return `${ind}${k}: ${typeof v==='string'?`"${v}"`:v},`;
  }).join('\n');
}
function animToCode(anim){
  const props=objToCode(buildAnimObj(anim));
  if(anim.inTimeline){const ind=props.split('\n').map(l=>'    '+l).join('\n');return `  .from("${anim.selector}", {\n${ind}\n  })`;}
  return `gsap.${anim.method}("${anim.selector}", {\n${props}\n});`;
}
function generateFullCode(){
  const anims=getAnims();
  if(!anims.length) return '// No animations added yet.\n// Import a page, select elements, and add animations.';
  const lines=[];
  const usesST=anims.some(a=>a.scrollTrigger);
  const standalone=anims.filter(a=>!a.inTimeline);
  const tlItems=anims.filter(a=>a.inTimeline);
  if(usesST)lines.push('gsap.registerPlugin(ScrollTrigger);','');
  standalone.forEach(a=>lines.push(animToCode(a),''));
  if(tlItems.length){lines.push('const tl = gsap.timeline();','','tl');tlItems.forEach((a,i)=>lines.push(animToCode(a)+(i===tlItems.length-1?';':'')));lines.push('');}
  return lines.join('\n').trim();
}
function updateCDN(){
  const anims=getAnims();
  const usesST=anims.some(a=>a.scrollTrigger)||state.scrollTriggerOn;
  const cdn=document.getElementById('cdn-output');
  let html=`<span class="cm">&lt;!-- GSAP --&gt;</span>\n<span class="str">&lt;script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js"&gt;&lt;/script&gt;</span>`;
  if(usesST)html+=`\n<span class="str">&lt;script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/ScrollTrigger.min.js"&gt;&lt;/script&gt;</span>`;
  cdn.innerHTML=html;
}

// ══════════════════════════════════════════════════════════════════════════════
// PREVIEW (sent to iframe via postMessage)
// ══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// LIVE PREVIEW — injects real GSAP into the iframe document
// ═══════════════════════════════════════════════════════════════

const GSAP_CDN         = 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js';
const SCROLLTRIGGER_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/ScrollTrigger.min.js';

function toggleLivePreview() {
  if (!activePage()) { showToast('Import a page first'); return; }
  if (!getAnims().length) { showToast('No animations to preview'); return; }

  if (state.liveMode) {
    injectLiveGSAP();
    showToast('Live preview updated');
  } else {
    state.liveMode = true;
    document.getElementById('live-preview-btn').classList.add('live-active');
    document.getElementById('live-preview-btn').textContent = '▶ Update Live';
    document.getElementById('live-badge').style.display = 'flex';
    injectLiveGSAP();
    showToast('GSAP injected — scroll to trigger animations');
  }
}

function injectLiveGSAP() {
  const anims  = getAnims();
  if (!anims.length) return;
  const usesST = anims.some(a => a.scrollTrigger);
  const code   = generateFullCode();

  // Indent the user code for embedding inside a function body
  const indented = code.split('\n').map(l => '      ' + l).join('\n');

  const stRegister = usesST ? '      gsap.registerPlugin(ScrollTrigger);' : '';
  const stRefresh  = usesST
    ? [
        '      ScrollTrigger.refresh();',
        '      window.parent.postMessage({',
        '        type: "LIVE_INFO",',
        '        scrollHeight: document.documentElement.scrollHeight,',
        '        clientHeight: window.innerHeight',
        '      }, "*");',
      ].join('\n')
    : '';

  const loadBlock = usesST
    ? [
        '    loadScript("' + GSAP_CDN + '", function() {',
        '      loadScript("' + SCROLLTRIGGER_CDN + '", function() {',
        '        run();',
        '      });',
        '    });',
      ].join('\n')
    : [
        '    loadScript("' + GSAP_CDN + '", function() {',
        '      run();',
        '    });',
      ].join('\n');

  const alreadyLoaded = usesST
    ? 'window.gsap && window.ScrollTrigger'
    : 'window.gsap';

  const bootScript = [
    '(function() {',
    '  // Kill any existing GSAP context',
    '  if (window.gsap) {',
    '    try { window.gsap.killTweensOf("*"); } catch(e) {}',
    '    if (window.ScrollTrigger) {',
    '      try { window.ScrollTrigger.getAll().forEach(function(t){t.kill();}); } catch(e) {}',
    '    }',
    '  }',
    '',
    '  function run() {',
    '    try {',
    stRegister,
    indented,
    stRefresh,
    '    } catch(err) {',
    '      window.parent.postMessage({ type: "LIVE_ERROR", message: err.message }, "*");',
    '    }',
    '  }',
    '',
    '  function loadScript(src, cb) {',
    '    var s = document.createElement("script");',
    '    s.src = src; s.onload = cb;',
    '    document.head.appendChild(s);',
    '  }',
    '',
    '  if (' + alreadyLoaded + ') {',
    '    run();',
    '  } else {',
    loadBlock,
    '  }',
    '})();',
  ].join('\n')

  // Deliver via postMessage so the frame's own script tag handles injection.
  // This works regardless of file:// vs http:// origin context.
  sendToFrame('INJECT_LIVE', { code: bootScript });
}

function resetLive() {
  sendToFrame('RESET_LIVE');
  showToast('Animations reset');
}

function exitLiveMode() {
  state.liveMode = false;
  const btn = document.getElementById('live-preview-btn');
  btn.classList.remove('live-active');
  btn.textContent = '▶ Live Preview';
  document.getElementById('live-badge').style.display = 'none';
  const hint = document.getElementById('live-scroll-hint');
  if (hint) hint.textContent = '';
}

// Re-inject with debounce when animations change while live
function maybeSyncLive() {
  if (!state.liveMode) return;
  clearTimeout(window._liveTimer);
  window._liveTimer = setTimeout(injectLiveGSAP, 900);
}

// LIVE_INFO and LIVE_ERROR handled in main postMessage bridge below

// CSS fallback preview (legacy — used by per-row ▶ buttons in layers)
function previewAll() {
  if (state.liveMode) { injectLiveGSAP(); return; }
  const anims = getAnims();
  if (!anims.length) { showToast('No animations'); return; }
  sendToFrame('PREVIEW_ALL', { anims });
  const cur = document.getElementById('tl-cursor-main');
  if (cur) { cur.style.transition='none'; cur.style.left='0%'; setTimeout(()=>{ cur.style.transition='left 2s linear'; cur.style.left='100%'; }, 50); }
  showToast('Playing\u2026');
}

function previewAnim(i) {
  const anims = getAnims(); const a = anims[i]; if (!a) return;
  sendToFrame('PREVIEW_ANIM', { anim: a });
  showToast('Previewing ' + a.selector);
}

function resetAll() {
  if (state.liveMode) { resetLive(); return; }
  sendToFrame('RESET_ALL');
  const cur = document.getElementById('tl-cursor-main');
  if (cur) { cur.style.transition='none'; cur.style.left='0%'; }
}

// ══════════════════════════════════════════════════════════════════════════════
// TABS + MISC
// ══════════════════════════════════════════════════════════════════════════════

function showTab(name){
  document.querySelectorAll('.tab-content').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('.panel-tab').forEach(el=>el.classList.remove('active'));
  document.getElementById('tab-'+name+'-content').classList.add('active');
  document.getElementById('tab-'+name).classList.add('active');
  if(name==='code'){codeEditor.value=generateFullCode();updateCDN();}
  if(name==='layers')renderAnimationsList();
}
function updateRange(slider,valId,sfx){document.getElementById(valId).textContent=parseFloat(slider.value).toFixed(1)+sfx;}
function updateAnimCount(){const n=getAnims().length;document.getElementById('anim-count').textContent=`${n} animation${n!==1?'s':''}`;}
function setStatus(msg){document.getElementById('status-text').textContent=msg;}
function showToast(msg){
  toast.textContent=msg; toast.classList.add('show');
  clearTimeout(window._tt); window._tt=setTimeout(()=>toast.classList.remove('show'),2200);
}
function copyCode(){
  navigator.clipboard.writeText(generateFullCode()).then(()=>showToast('Code copied')).catch(()=>showToast('Copy failed'));
}
function downloadCode(){
  const blob=new Blob([generateFullCode()],{type:'text/javascript'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='gsap-animations.js'; a.click();
}
function copyCDN(){
  const usesST=getAnims().some(a=>a.scrollTrigger)||state.scrollTriggerOn;
  let s=`<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js"><\/script>`;
  if(usesST)s+=`\n<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/ScrollTrigger.min.js"><\/script>`;
  navigator.clipboard.writeText(s).then(()=>showToast('CDN tags copied')).catch(()=>{});
}

// ══════════════════════════════════════════════════════════════════════════════
// KEYBOARD
// ══════════════════════════════════════════════════════════════════════════════

document.addEventListener('keydown', e => {
  const meta = e.metaKey||e.ctrlKey;
  if (e.key==='Escape')               { clearSelected(); cancelEdit(); }
  if (e.key==='s'&&meta)              { e.preventDefault(); toggleSelectMode(); }
  if (e.key==='p'&&meta)              { e.preventDefault(); toggleLivePreview(); }
  if (e.key==='['&&meta)              { e.preventDefault(); togglePanel(); }
  if (e.key==='z'&&meta&&!e.shiftKey) { e.preventDefault(); undo(); }
  if (e.key==='z'&&meta&&e.shiftKey)  { e.preventDefault(); redo(); }
  if (e.key==='Enter'&&e.shiftKey&&document.activeElement!==codeEditor) commitAnimation();
  if (e.key==='i'&&meta)              { e.preventDefault(); openImportModal(); }
});

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════

showWelcomeScreen();
updateCDN();
renderAnimationsList();
updateUndoButtons();
updatePageCount();

// Stamp data-preset on toggleActions chips so syncTAChips works immediately
(function stampTAPresets() {
  const presets = [
    'play none none none',
    'play none none reverse',
    'restart none none none',
    'play none none reset',
    'play pause resume reverse',
    'custom',
  ];
  document.querySelectorAll('.st-ta-chip').forEach((c, i) => {
    c.dataset.preset = presets[i] || 'custom';
  });
  syncTAChips('play none none none');
})();
