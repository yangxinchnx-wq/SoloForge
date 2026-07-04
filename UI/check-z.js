JSON.stringify({
  edgeResize: Array.from(document.querySelectorAll('div')).filter(d => {
    const s = d.getAttribute('style') || '';
    return s.includes('9998') || s.includes('z-index: 999');
  }).map(d => ({
    z: d.style.zIndex,
    pos: d.style.position,
    rect: d.getBoundingClientRect()
  })),
  modals: Array.from(document.querySelectorAll('div')).filter(d => {
    const s = d.className || '';
    return s.includes('z-[100]') || s.includes('fixed inset-0');
  }).map(d => ({
    z: d.style.zIndex,
    cls: d.className.substring(0, 100),
    rect: d.getBoundingClientRect()
  })),
  bodyClass: document.body.className,
  bodyHTMLLen: document.body.innerHTML.length
})
