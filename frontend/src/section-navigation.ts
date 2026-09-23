export type SectionDirection = -1 | 1;
export type SectionName = 'home' | 'relations' | 'game' | 'preferences' | 'sources';
export const sectionOrder: SectionName[] = ['home', 'relations', 'game', 'preferences', 'sources'];
export function sectionFor(url: URL): SectionName {
  if (/^\/sources\/?$/.test(url.pathname)) return 'sources';
  if (/^\/preferences\/?$/.test(url.pathname)) return 'preferences';
  if (/^\/game\/?$/.test(url.pathname)) return 'game';
  return url.hash === '#home' || (!url.hash && !url.searchParams.has('person') && !url.searchParams.has('faction')) ? 'home' : 'relations';
}
export const directionBetween = (from: SectionName, to: SectionName): SectionDirection => sectionOrder.indexOf(to) < sectionOrder.indexOf(from) ? -1 : 1;
export const sectionDuration = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 600;
let transition: ViewTransition | undefined;
let fallback: Animation | undefined;
let transitionId = 0;

export const sectionTransitioning = () => document.documentElement.dataset.sectionTransitioning === 'true' || document.documentElement.dataset.sectionLoading === 'true';

export function navigateSection(href: string, direction: SectionDirection) {
  const event = new CustomEvent('atlas:section-navigation', { cancelable: true, detail: { href, direction } });
  if (document.dispatchEvent(event)) location.assign(href);
}

// 跨入口仍销毁旧 Vue 应用，快照只用于转场，不让图谱监听进入游戏。
export async function transitionSection(update: () => Promise<void>, direction: SectionDirection) {
  const id = ++transitionId;
  transition?.skipTransition(); fallback?.cancel();
  const html = document.documentElement;
  html.dataset.sectionDirection = direction > 0 ? 'forward' : 'backward';
  html.dataset.sectionTransitioning = 'true';
  const duration = sectionDuration();
  try {
    if (duration && document.startViewTransition) {
      transition = document.startViewTransition(update);
      await transition.updateCallbackDone;
      await transition.finished;
    } else {
      await update();
      if (duration) {
        fallback = document.getElementById('app')!.animate([
          { transform: `translateY(${direction * 48}px)`, opacity: .4 },
          { transform: 'translateY(0)', opacity: 1 },
        ], { duration, easing: 'cubic-bezier(.22, .61, .36, 1)' });
        await fallback.finished.catch(() => {});
      }
    }
  } finally {
    if (id === transitionId) {
      transition = undefined; fallback = undefined;
      delete html.dataset.sectionTransitioning;
      delete html.dataset.sectionDirection;
    }
  }
}
