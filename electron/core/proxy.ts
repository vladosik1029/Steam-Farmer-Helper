import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpError } from "./security.ts";

export function normalizeProxy(proxy: unknown): string | undefined {
  if (!proxy || typeof proxy !== "string" || !proxy.trim()) return undefined;
  const trimmed = proxy.trim();
  if (!/^(https?|socks[45]?h?):\/\//i.test(trimmed)) {
    throw new HttpError(400, "Proxy must start with http://, https:// or socks5://");
  }
  return trimmed;
}

function isSocks(proxy: string) {
  return proxy.toLowerCase().startsWith("socks");
}

export function getProxyAgent(proxyUrl: string) {
  return isSocks(proxyUrl) ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
}

// steam-user / steam-session take proxies as options
export function proxyOptions(proxy?: string): Record<string, string> {
  if (!proxy) return {};
  return isSocks(proxy) ? { socksProxy: proxy } : { httpProxy: proxy };
}

// Axios options for a request through an optional proxy
export function axiosProxy(proxy?: string): Record<string, unknown> {
  if (!proxy) return {};
  return { httpsAgent: getProxyAgent(proxy), proxy: false };
}
