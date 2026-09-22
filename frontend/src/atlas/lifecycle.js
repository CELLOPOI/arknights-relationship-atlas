// 每次挂载独立拥有资源；销毁后排队中的回调也不能再更新旧 DOM。
export function createLifecycle() {
  const controller = new AbortController();
  const cleanups = new Set(), timers = new Set(), frames = new Set(), animations = new Set();
  let disposed = false;
  const own = cleanup => { if (disposed) cleanup(); else cleanups.add(cleanup); return cleanup; };
  const scope = {
    get disposed() { return disposed; },
    signal: controller.signal,
    own,
    listen(target, type, listener, options = undefined) {
      if (!target || disposed) return;
      const guarded = event => { if (!disposed) listener(event); };
      target.addEventListener(type, guarded, options);
      own(() => target.removeEventListener(type, guarded, options));
    },
    handler(target, name, callback) {
      if (disposed) return;
      const previous = target[name];
      const guarded = event => { if (!disposed) return callback(event); };
      target[name] = guarded;
      own(() => { if (target[name] === guarded) target[name] = previous; });
    },
    timeout(callback, delay) {
      if (disposed) return 0;
      const id = setTimeout(() => { timers.delete(id); if (!disposed) callback(); }, delay);
      timers.add(id); return id;
    },
    clearTimeout(id) { clearTimeout(id); timers.delete(id); },
    frame(callback) {
      if (disposed) return 0;
      const id = requestAnimationFrame(time => { frames.delete(id); if (!disposed) callback(time); });
      frames.add(id); return id;
    },
    cancelFrame(id) { cancelAnimationFrame(id); frames.delete(id); },
    observe(Observer, target, callback) {
      const observer = new Observer((...args) => { if (!disposed) callback(...args); });
      own(() => observer.disconnect());
      if (!disposed) observer.observe(target);
      return observer;
    },
    animate(target, keyframes, options) {
      if (disposed) return null;
      const animation = target.animate(keyframes, options);
      animations.add(animation);
      const forget = () => animations.delete(animation);
      animation.addEventListener('finish', forget, { once: true });
      animation.addEventListener('cancel', forget, { once: true });
      return animation;
    },
    async json(url) {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const data = await response.json();
      controller.signal.throwIfAborted();
      return data;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      timers.forEach(clearTimeout); timers.clear();
      frames.forEach(cancelAnimationFrame); frames.clear();
      animations.forEach(animation => { animation.onfinish = null; animation.cancel(); }); animations.clear();
      [...cleanups].reverse().forEach(cleanup => cleanup()); cleanups.clear();
    },
  };
  return scope;
}
