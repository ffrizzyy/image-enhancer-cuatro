/**
 * Read-only page survey for writing a provider config. It reports the *structure* of the page's
 * composer area: file inputs, editable boxes, buttons whose label suggests send/upload/stop, and custom
 * elements. It never reports conversation text; labels are cut to 60 characters, and only controls
 * whose attributes match the keyword list are included.
 */
export const DISCOVERY_SCRIPT = `(() => {
  const cut = (value, n = 60) => String(value == null ? '' : value).slice(0, n);
  const KEYWORDS = /send|submit|upload|attach|add|plus|file|image|photo|picture|stop|cancel|generat|create|prompt|ask|message|tool|menu|remove|delete|close|preview/i;

  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const pick = (el, names) => {
    const out = {};
    for (const name of names) { const v = el.getAttribute(name); if (v) out[name] = cut(v); }
    return out;
  };
  const path = (el) => {
    const parts = [];
    for (let e = el, i = 0; e && i < 5; e = e.parentElement, i++) {
      let s = e.tagName.toLowerCase();
      if (e.id) s += '#' + cut(e.id, 30);
      s += [...e.classList].slice(0, 3).map((c) => '.' + cut(c, 30)).join('');
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const describe = (el, attrs) => ({ tag: el.tagName.toLowerCase(), path: path(el), ...pick(el, attrs), visible: visible(el) });

  // A pruned outline (tags, ids, classes, roles; no text) of the area around the prompt box.
  const outline = (el, depth) => {
    const node = { tag: el.tagName.toLowerCase() };
    if (el.id) node.id = cut(el.id, 30);
    if (el.classList.length) node.class = [...el.classList].slice(0, 4).map((c) => cut(c, 30)).join(' ');
    Object.assign(node, pick(el, ['role', 'aria-label', 'data-test-id', 'data-testid', 'type', 'contenteditable']));
    if (depth > 0) {
      const kids = [...el.children].slice(0, 10).map((c) => outline(c, depth - 1));
      if (kids.length) node.children = kids;
    }
    return node;
  };

  const editable = document.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
  const composerRoot = editable ? (editable.closest('form') || editable.parentElement?.parentElement?.parentElement || editable) : null;

  const controls = [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')]
    .filter((el) => KEYWORDS.test([el.getAttribute('aria-label'), el.getAttribute('data-test-id'), el.getAttribute('mattooltip'), el.getAttribute('title'), el.className].join(' ')))
    .slice(0, 60)
    .map((el) => describe(el, ['aria-label', 'data-test-id', 'data-testid', 'mattooltip', 'title', 'type', 'disabled', 'aria-disabled', 'aria-haspopup', 'aria-expanded']));

  const customTags = new Map();
  for (const el of document.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (tag.includes('-') && !customTags.has(tag)) customTags.set(tag, { tag, openShadowRoot: !!el.shadowRoot });
  }

  // Items of any open menu or overlay: UI labels such as "Upload files", never conversation content.
  const menuItems = [...document.querySelectorAll('[role="menu"] [role="menuitem"], .cdk-overlay-container button, .cdk-overlay-container [role="menuitem"], mat-menu-item, [role="listbox"] [role="option"]')]
    .slice(0, 40)
    .map((el) => ({ ...describe(el, ['aria-label', 'data-test-id', 'data-testid', 'role', 'mattooltip', 'title', 'aria-disabled']), text: cut((el.textContent || '').trim().replace(/\\s+/g, ' '), 30) }));

  // Attached-file previews around the composer: structure only (tags, classes, label attributes, image host).
  const previewRoot = composerRoot ? (composerRoot.closest('input-area-v2, input-container') || composerRoot.parentElement || composerRoot) : null;
  const previews = previewRoot ? [...previewRoot.querySelectorAll('img, [class*="preview"], [class*="attachment"], uploader-file-preview, [data-test-id*="preview"]')].slice(0, 20).map((el) => {
    const info = describe(el, ['aria-label', 'alt', 'data-test-id', 'data-testid', 'role', 'title']);
    if (el.tagName === 'IMG') { try { info.srcHost = new URL(el.src).host; info.srcKind = el.src.startsWith('blob:') ? 'blob' : el.src.startsWith('data:') ? 'data' : 'url'; } catch { info.srcKind = 'other'; } }
    return info;
  }) : [];

  return {
    page: location.origin + location.pathname,
    previews,
    menuItems,
    fileInputs: [...document.querySelectorAll('input[type="file"]')].map((el) => describe(el, ['accept', 'multiple', 'id', 'name'])),
    editables: [...document.querySelectorAll('[contenteditable="true"], [contenteditable=""], textarea, [role="textbox"], input[type="text"]')]
      .map((el) => describe(el, ['role', 'aria-label', 'placeholder', 'data-placeholder', 'contenteditable', 'id'])),
    // Length only (never the text): proves a configured insert reached the composer.
    composerTextLength: editable ? (editable.value ?? editable.textContent ?? '').trim().length : null,
    controls,
    imageCount: document.images.length,
    customElements: [...customTags.values()].slice(0, 60),
    composerOutline: composerRoot ? outline(composerRoot, 6) : null,
  };
})()`;

export interface DiscoveryReport {
  page: string;
  menuItems: unknown[];
  previews: unknown[];
  fileInputs: unknown[];
  editables: unknown[];
  /** How many characters the composer holds after a draft was typed (never the text itself). */
  composerTextLength: number | null;
  controls: unknown[];
  imageCount: number;
  customElements: unknown[];
  composerOutline: unknown;
}
