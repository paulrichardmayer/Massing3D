// Draggable, corner-dockable floating panels. Drag a panel by its grip and
// release: it snaps to the nearest corner. Panels sharing a corner stack
// vertically (registration order = closeness to the corner edge), which is
// how the layer settings panel sits directly above the layer strip.

const MARGIN = 12;
const GAP = 10;
const items = []; // { el, corner: 'top-left'|'top-right'|'bottom-left'|'bottom-right', dragging }

export function makeDockable(el, defaultCorner, handleSelector) {
  el.style.position = 'fixed';
  const item = { el, corner: defaultCorner, dragging: false };
  items.push(item);

  const handle = handleSelector ? el.querySelector(handleSelector) : el;
  if (handle) bindDrag(item, handle);

  new ResizeObserver(() => { if (!item.dragging) layoutDocked(); }).observe(el);
  layoutDocked();
  return item;
}

function bindDrag(item, handle) {
  let offX = 0, offY = 0;
  handle.style.cursor = 'grab';

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = item.el.getBoundingClientRect();
    offX = e.clientX - r.left;
    offY = e.clientY - r.top;
    item.dragging = true;
    handle.setPointerCapture(e.pointerId);
    handle.style.cursor = 'grabbing';
  });

  handle.addEventListener('pointermove', (e) => {
    if (!item.dragging) return;
    item.el.style.right = '';
    item.el.style.bottom = '';
    item.el.style.left = (e.clientX - offX) + 'px';
    item.el.style.top = (e.clientY - offY) + 'px';
  });

  const drop = (e) => {
    if (!item.dragging) return;
    item.dragging = false;
    handle.style.cursor = 'grab';
    try { handle.releasePointerCapture(e.pointerId); } catch { /* ok */ }
    const r = item.el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    item.corner =
      (cy < window.innerHeight / 2 ? 'top' : 'bottom') + '-' +
      (cx < window.innerWidth / 2 ? 'left' : 'right');
    layoutDocked();
  };
  handle.addEventListener('pointerup', drop);
  handle.addEventListener('pointercancel', drop);
}

export function layoutDocked() {
  const stacks = {};
  for (const item of items) {
    if (item.dragging || item.el.classList.contains('hidden')) continue;
    (stacks[item.corner] ??= []).push(item);
  }
  for (const [corner, stack] of Object.entries(stacks)) {
    const [vSide, hSide] = corner.split('-');
    let offset = MARGIN;
    for (const item of stack) {
      const el = item.el;
      el.style.left = el.style.right = el.style.top = el.style.bottom = '';
      if (hSide === 'right') el.style.right = MARGIN + 'px';
      else el.style.left = MARGIN + 'px';
      if (vSide === 'bottom') el.style.bottom = offset + 'px';
      else el.style.top = offset + 'px';
      offset += el.getBoundingClientRect().height + GAP;
    }
  }
}

window.addEventListener('resize', layoutDocked);
