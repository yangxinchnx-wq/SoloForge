// Find what element is at the center of the avatar button (first [role=button] with aria-label starting with avatar-related text)
// Use document.elementsFromPoint to find all overlapping elements
(() => {
  const buttons = document.querySelectorAll('[role=button]');
  const avatar = Array.from(buttons).find(b => (b.getAttribute('aria-label') || '').includes('avatar') || b.getAttribute('aria-label') === '\u9009\u62e9\u5934\u50cf(\u6eda\u8f6e\u53ef\u5207\u6362)');
  const name = Array.from(buttons).find(b => b.getAttribute('aria-label') === '\u9009\u62e9\u540d\u5b57(\u6eda\u8f6e\u53ef\u5207\u6362)');
  const results = {};
  for (const [key, el] of [['avatar', avatar], ['name', name]]) {
    if (!el) { results[key] = 'NOT FOUND'; continue; }
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const stack = document.elementsFromPoint(cx, cy);
    results[key] = {
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      center: { x: cx, y: cy },
      elementStack: stack.slice(0, 12).map((e, i) => ({
        i,
        tag: e.tagName,
        cls: (e.className || '').toString().slice(0, 100),
        id: e.id || null,
        role: e.getAttribute && e.getAttribute('role'),
        ariaLabel: e.getAttribute && e.getAttribute('aria-label'),
        zIndex: (() => { try { return getComputedStyle(e).zIndex; } catch { return null; } })(),
        pointerEvents: (() => { try { return getComputedStyle(e).pointerEvents; } catch { return null; } })(),
        position: (() => { try { return getComputedStyle(e).position; } catch { return null; } })(),
        isAvatarItself: e === el,
      })),
    };
  }
  return results;
})();
