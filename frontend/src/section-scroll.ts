type Direction = -1 | 1;
type Options = { step: (direction: Direction) => boolean; blocked?: () => boolean };

// 跨首页、阵营和游戏保留同一次滚轮手势，避免惯性在组件重新挂载后再翻一屏。
let wheelTime = 0, wheelDirection = 0, wheelDistance = 0, wheelConsumed = false;
const editable = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"]';

function canScroll(target: Element, root: HTMLElement, direction: Direction) {
  for (let node: Element | null = target; node && root.contains(node); node = node.parentElement) {
    if (!(node instanceof HTMLElement) || !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) continue;
    if (direction < 0 ? node.scrollTop > 1 : node.scrollHeight - node.clientHeight - node.scrollTop > 1) return true;
  }
  return false;
}

export function bindSectionScroll(root: HTMLElement, { step, blocked = () => false }: Options) {
  const controller = new AbortController();
  const signal = controller.signal;
  let touch: { id: number; x: number; y: number; target: Element; claimed: boolean } | null = null;
  let suppressClickUntil = 0;
  const unavailable = (target: Element) => blocked() || !!document.querySelector('dialog[open]') || !!target.closest(editable);
  const prevent = (event: Event) => { if (event.cancelable) event.preventDefault(); };

  root.addEventListener('wheel', event => {
    const target = event.target as Element;
    if (event.ctrlKey || event.metaKey || event.shiftKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const direction: Direction = event.deltaY > 0 ? 1 : -1;
    const now = performance.now();
    if (now - wheelTime > 180 || direction !== wheelDirection) { wheelDistance = 0; wheelConsumed = false; }
    wheelTime = now; wheelDirection = direction;
    if (unavailable(target)) { wheelDistance = 0; return; }
    // 一次从列表内部开始的滚动只滚列表；到边界后用下一次手势切屏。
    if (canScroll(target, root, direction)) { wheelDistance = 0; wheelConsumed = true; return; }
    prevent(event);
    if (wheelConsumed) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1;
    wheelDistance += Math.abs(event.deltaY) * unit;
    if (wheelDistance >= 48 && step(direction)) { wheelConsumed = true; wheelDistance = 0; }
  }, { passive: false, signal });

  root.addEventListener('touchstart', event => {
    const target = event.target as Element;
    touch = null;
    if (event.touches.length !== 1 || unavailable(target)) return;
    const point = event.touches[0];
    touch = { id: point.identifier, x: point.clientX, y: point.clientY, target, claimed: false };
  }, { passive: true, signal });
  root.addEventListener('touchmove', event => {
    if (!touch) return;
    if (event.touches.length !== 1 || unavailable(touch.target)) { touch = null; return; }
    const point = Array.from(event.touches).find(point => point.identifier === touch!.id);
    if (!point) { touch = null; return; }
    const dx = point.clientX - touch.x, dy = touch.y - point.clientY;
    if (!touch.claimed) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      if (Math.abs(dx) >= Math.abs(dy) || canScroll(touch.target, root, dy > 0 ? 1 : -1)) { touch = null; return; }
      touch.claimed = true;
    }
    // 必须在首个纵向 move 接管手势，等到 touchend 时浏览器可能已取消事件流。
    prevent(event);
    suppressClickUntil = performance.now() + 400;
    if (Math.abs(dy) >= 56) {
      step(dy > 0 ? 1 : -1);
      touch = null;
    }
  }, { passive: false, signal });
  for (const name of ['touchend', 'touchcancel'] as const) root.addEventListener(name, () => { touch = null; }, { signal });
  root.addEventListener('click', event => {
    if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true, signal });
  return () => { touch = null; controller.abort(); };
}
