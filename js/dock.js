// Draggable floating panels. Drag a panel by its grip and release:
// - dropped NEAR a screen corner, it docks there; panels sharing a corner
//   stack vertically (registration order = closeness to the corner edge),
//   which is how the layer settings panel sits directly above the layer strip
// - dropped anywhere else, it floats exactly where you left it (clamped back
//   into the viewport on window resize)

const MARGIN = 12;
const GAP = 10;
const DOCK_RADIUS = 160; // px from a corner that still counts as "near"
const items = []; // { el, corner: 'top-left'|...|null, floating: {left,top}|null, dragging }

export function makeDockable(el, defaultCorner, handleSelector) {
  el.style.position = 'fixed';
  const item = { el, corner: defaultCorner, floating: null, dragging: false };
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
    // near a corner -> dock (and stack); anywhere else -> float right here
    const nearX = Math.min(r.left, window.innerWidth - r.right);
    const nearY = Math.min(r.top, window.innerHeight - r.bottom);
    if (nearX < DOCK_RADIUS && nearY < DOCK_RADIUS) {
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      item.corner =
        (cy < window.innerHeight / 2 ? 'top' : 'bottom') + '-' +
        (cx < window.innerWidth / 2 ? 'left' : 'right');
      item.floating = null;
    } else {
      item.corner = null;
      item.floating = { left: r.left, top: r.top };
    }
    layoutDocked();
  };
  handle.addEventListener('pointerup', drop);
  handle.addEventListener('pointercancel', drop);
}

export function layoutDocked() {
  const stacks = {};
  for (const item of items) {
    if (item.dragging || item.el.classList.contains('hidden')) continue;
    if (item.floating) {
      // keep free-floating panels where the user left them, on-screen
      const el = item.el;
      const r = el.getBoundingClientRect();
      const left = Math.max(0, Math.min(item.floating.left, window.innerWidth - r.width));
      const top = Math.max(0, Math.min(item.floating.top, window.innerHeight - r.height));
      el.style.right = el.style.bottom = '';
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      continue;
    }
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
