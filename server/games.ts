import axios from "axios";

// Finds games/DLC that are currently free on the Steam store (100% discount or free to keep)

const CACHE_TTL_MS = 30 * 60_000;
let cache: { at: number; items: FreeGame[] } | null = null;

export type FreeGame = {
  appId: number;
  title: string;
  image: string;
  discount: string | null;
  url: string;
};

function decodeHtml(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export async function findFreePromotions(): Promise<FreeGame[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.items;

  const response = await axios.get("https://store.steampowered.com/search/results/", {
    params: { query: "", start: 0, count: 100, maxprice: "free", specials: 1, infinite: 1, cc: "us", l: "english" },
    timeout: 20000
  });
  const html: string = response.data?.results_html || "";

  const items: FreeGame[] = [];
  const rowRe = /<a href="([^"]+)"[^>]*data-ds-appid="(\d+)"[\s\S]*?<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html))) {
    const row = match[0];
    const title = row.match(/<span class="title">([\s\S]*?)<\/span>/)?.[1] || `App ${match[2]}`;
    const image = row.match(/<img src="([^"]+)"/)?.[1] || "";
    const discount = row.match(/class="discount_pct">([^<]+)</)?.[1] || null;
    items.push({
      appId: Number(match[2]),
      title: decodeHtml(title.trim()),
      image,
      discount,
      url: match[1].split("?")[0]
    });
  }

  cache = { at: Date.now(), items };
  return items;
}
