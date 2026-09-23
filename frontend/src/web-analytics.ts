const beaconSource = 'https://static.cloudflareinsights.com/beacon.min.js';
const hasBeacon = () => Boolean(document.querySelector(`script[data-cf-beacon], script[src^="${beaconSource}"]`));
let started = false;

export async function startWebAnalytics() {
  if (started || hasBeacon()) return;
  started = true;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/api/site-config/', {
      credentials: 'omit', cache: 'no-store', signal: controller.signal
    });
    if (!response.ok) return;
    const config: { cloudflareWebAnalyticsToken?: unknown } | null = await response.json();
    const token = config?.cloudflareWebAnalyticsToken;
    // 自动注入或构建注入的脚本可能先到达；同一个页面只能安装一次。
    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/i.test(token) || hasBeacon()) return;
    const script = document.createElement('script');
    script.type = 'module';
    script.src = beaconSource;
    script.dataset.cfBeacon = JSON.stringify({ token });
    document.head.append(script);
  } catch {
    // 统计服务或配置读取失败不能阻止页面展示，也不重试干扰访客网络。
  } finally {
    window.clearTimeout(timeout);
  }
}
