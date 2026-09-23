import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();
const router = express.Router();

app.use(cors());
app.use(express.json());

const BASE_URL = "https://animesalt.me";

// ==========================================
// Multi-Tier In-Memory & Upstash Redis Cache
// Saves 99%+ of outbound requests to proxies/upstream
// ==========================================
interface CacheEntry {
  data: any;
  expiry: number;
}

const memoryCache = new Map<string, CacheEntry>();

async function getCachedAsync<T>(key: string): Promise<T | null> {
  // 1. Check local in-memory cache (0ms)
  const entry = memoryCache.get(key);
  if (entry) {
    if (Date.now() <= entry.expiry) {
      return entry.data as T;
    }
    memoryCache.delete(key);
  }

  // 2. Check Upstash Redis Serverless REST API (<15ms)
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (redisUrl && redisToken) {
    try {
      const res = await fetch(`${redisUrl.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${redisToken}` },
      });
      if (res.ok) {
        const json = await res.json() as any;
        if (json.result) {
          const parsed = typeof json.result === "string" ? JSON.parse(json.result) : json.result;
          memoryCache.set(key, { data: parsed, expiry: Date.now() + 300000 });
          return parsed as T;
        }
      }
    } catch (err) {
      console.warn("Upstash Redis get error:", err);
    }
  }

  return null;
}

async function setCacheAsync(key: string, data: any, ttlSeconds: number = 86400) {
  // 1. Store in local in-memory cache
  if (memoryCache.size > 1000) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey) memoryCache.delete(oldestKey);
  }
  memoryCache.set(key, {
    data,
    expiry: Date.now() + ttlSeconds * 1000,
  });

  // 2. Persist to Upstash Redis (if configured)
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (redisUrl && redisToken) {
    try {
      const serialized = JSON.stringify(data);
      await fetch(`${redisUrl.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}?EX=${ttlSeconds}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${redisToken}`,
          "Content-Type": "application/json",
        },
        body: serialized,
      });
    } catch (err) {
      console.warn("Upstash Redis set error:", err);
    }
  }
}

function sendCachedResponse(res: express.Response, data: any, ttlSeconds: number = 86400) {
  res.setHeader("Cache-Control", `public, max-age=${Math.min(300, ttlSeconds)}, s-maxage=${ttlSeconds}, stale-while-revalidate=600`);
  res.setHeader("X-Cache-Status", "HIT");
  res.json(data);
}

// Modern Chrome 133 client headers to bypass Cloudflare Bot Management & WAF
const CHROME_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
  "Cache-Control": "max-age=0",
  "Referer": "https://animesalt.me/",
  "Connection": "keep-alive",
  "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "same-origin",
  "sec-fetch-user": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const MINIMAL_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://animesalt.me/",
  "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
  "sec-ch-ua-platform": '"Windows"',
};

const AJAX_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "X-Requested-With": "XMLHttpRequest",
  "Referer": "https://animesalt.me/",
  "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: CHROME_HEADERS,
  decompress: true,
  maxRedirects: 5,
});

const ajaxClient = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: AJAX_HEADERS,
  decompress: true,
  maxRedirects: 5,
});

interface FetchPageOptions {
  isAjax?: boolean;
  params?: Record<string, any>;
  timeoutMs?: number;
}

const DEFAULT_FLARESOLVERR_URL = "https://flaresolverr-latest-yyn1.onrender.com";

function getFlareSolverrUrl(): string | null {
  const envCandidates = [
    process.env.FLARESOLVERR_URL,
    process.env.FLARE_SOLVERR_URL,
    process.env.FLARESOLVERR,
    process.env.FLARESOLVER_URL,
    process.env.FLARE_SOLVER_URL,
    process.env.FLARE_URL,
    process.env.FLARESOLVER,
  ];

  for (const candidate of envCandidates) {
    if (candidate && candidate.trim()) {
      const clean = candidate.trim().replace(/\/+$/, "");
      if (!clean.includes("vercel.app") && !clean.includes("animesalt-api")) {
        return clean;
      }
    }
  }

  return DEFAULT_FLARESOLVERR_URL;
}

/**
 * Builds the appropriate target URL for various proxy gateways (Cloudflare Worker, ScraperAPI, etc.)
 */
function buildProxyUrl(gateway: string, targetUrl: string): string {
  const cleanGateway = gateway.trim().replace(/\/+$/, "");
  if (cleanGateway.includes("%s")) {
    return cleanGateway.replace("%s", encodeURIComponent(targetUrl));
  }
  if (cleanGateway.includes("url=")) {
    const separator = cleanGateway.includes("?") ? "&" : "?";
    return `${cleanGateway}${separator}url=${encodeURIComponent(targetUrl)}`;
  }
  if (cleanGateway.endsWith("=")) {
    return `${cleanGateway}${encodeURIComponent(targetUrl)}`;
  }
  try {
    const parsed = new URL(targetUrl);
    return `${cleanGateway}${parsed.pathname}${parsed.search}`;
  } catch {
    const pathAndQuery = targetUrl.replace(/^https?:\/\/[^/]+/, "");
    return `${cleanGateway}${pathAndQuery.startsWith("/") ? "" : "/"}${pathAndQuery}`;
  }
}

/**
 * Resilient page fetcher utilizing Node native fetch (Undici TLS engine)
 * with multi-profile header fallback and automatic Axios backup.
 */
async function fetchPage(path: string, options: FetchPageOptions = {}): Promise<string> {
  const isAjax = !!options.isAjax;
  let fullUrl = path.startsWith("http") ? path : `${BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;

  if (options.params && Object.keys(options.params).length > 0) {
    const urlObj = new URL(fullUrl);
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== null && v !== "") {
        urlObj.searchParams.set(k, String(v));
      }
    }
    fullUrl = urlObj.toString();
  }

  // -1. FlareSolverr: Real Chromium browser bypass
  const FLARESOLVERR_URL = getFlareSolverrUrl();
  if (FLARESOLVERR_URL) {
    try {
      const solverController = new AbortController();
      const solverTimer = setTimeout(() => solverController.abort(), 60000);
      const solverResp = await fetch(`${FLARESOLVERR_URL.replace(/\/$/, "")}/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cmd: "request.get",
          url: fullUrl,
          maxTimeout: 55000,
        }),
        signal: solverController.signal,
      });
      clearTimeout(solverTimer);
      if (solverResp.ok) {
        const solverJson = await solverResp.json() as any;
        if (solverJson.status === "ok" && solverJson.solution?.response) {
          const solverText: string = solverJson.solution.response;
          if (!solverText.includes("Just a moment...") && !solverText.includes("cf-browser-verification")) {
            return solverText;
          }
          console.warn("FlareSolverr returned a Cloudflare challenge page:", fullUrl);
        }
      }
    } catch (solverErr: any) {
      console.warn(`FlareSolverr failed (${solverErr.message}), falling through to Worker proxy.`);
    }
  }

  // 0. Cloudflare Worker proxy / scraper gateway
  const proxyGateway = process.env.PROXY_URL || process.env.SCRAPER_PROXY || "";

  if (proxyGateway) {
    try {
      const proxiedUrl = buildProxyUrl(proxyGateway, fullUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);

      const proxyResp = await fetch(proxiedUrl, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (proxyResp.ok) {
        const text = await proxyResp.text();
        if (!text.includes("Just a moment...") && !text.includes("cf-browser-verification") && !text.includes("Checking your browser")) {
          return text;
        }
        console.warn(`Proxy gateway (${proxyGateway}) returned Cloudflare challenge on: ${proxiedUrl}`);
        if (process.env.NODE_ENV === "production") {
          throw new Error(`Proxy gateway is being challenged by Cloudflare. Please update your Worker script.`);
        }
      } else if (proxyResp.status === 404) {
        const notFoundErr: any = new Error("Page not found (404)");
        notFoundErr.status = 404;
        throw notFoundErr;
      } else {
        console.warn(`Proxy gateway returned status ${proxyResp.status} on: ${proxiedUrl}`);
      }
    } catch (proxyErr: any) {
      if (proxyErr.status === 404 || proxyErr.message.includes("Please update your Worker script")) throw proxyErr;
      console.warn(`Proxy gateway request failed (${proxyErr.message}) on: ${proxyGateway}`);
    }
  }

  const timeoutMs = options.timeoutMs || 14000;

  const headerProfiles = isAjax
    ? [AJAX_HEADERS]
    : [CHROME_HEADERS, MINIMAL_HEADERS];

  let lastStatus = 0;
  let lastBodySnippet = "";

  for (const headers of headerProfiles) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const resp = await fetch(fullUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);

      lastStatus = resp.status;

      if (resp.ok) {
        const text = await resp.text();
        if (!text.includes("Just a moment...") && !text.includes("cf-browser-verification")) {
          return text;
        }
        console.warn(`Direct fetch hit Cloudflare challenge on: ${fullUrl}`);
      } else if (resp.status === 404) {
        const notFoundErr: any = new Error("Page not found (404)");
        notFoundErr.status = 404;
        throw notFoundErr;
      } else {
        const text = await resp.text().catch(() => "");
        lastBodySnippet = text.slice(0, 160).replace(/\s+/g, " ").trim();
        console.warn(`Native fetch returned status ${resp.status} on: ${fullUrl}`);
      }
    } catch (err: any) {
      if (err.status === 404) throw err;
      console.warn(`Native fetch error (${err.message}) on: ${fullUrl}`);
    }
  }

  try {
    const axiosClient = isAjax ? ajaxClient : client;
    const axiosResp = await axiosClient.get(fullUrl, {
      timeout: timeoutMs,
      decompress: true,
      maxRedirects: 5,
    });
    if (typeof axiosResp.data === "string") {
      return axiosResp.data;
    }
    return JSON.stringify(axiosResp.data);
  } catch (axiosErr: any) {
    if (axiosErr.response?.status === 404) {
      const notFoundErr: any = new Error("Page not found (404)");
      notFoundErr.status = 404;
      throw notFoundErr;
    }
    const status = axiosErr.response?.status || lastStatus;
    const details = axiosErr.response?.data
      ? String(axiosErr.response.data).slice(0, 160).replace(/\s+/g, " ").trim()
      : (lastBodySnippet || axiosErr.message);

    throw new Error(`Upstream AnimeSalt HTTP ${status}: ${details}`);
  }
}

// Helper to extract anime list from HTML (category/search/archive pages)
function extractAnimeList(html: string) {
  const $ = cheerio.load(html);
  const results: any[] = [];

  $("article.post, article.tv, .result-item article, .items article, article").each((_, el) => {
    const linkEl = $(el).find("a.lnk-blk").first();
    let url = linkEl.attr("href") || $(el).find("a").first().attr("href") || "";

    const slugMatch = url.match(/\/(tv|series|movies)\/([^/]+)\/?$/);
    const id = slugMatch ? slugMatch[2] : url.replace(/.*\//, "").replace(/\/$/, "");

    if (!id || id.includes("page") || id === "feed" || id === "tv" || id === "movies") return;

    const title = $(el).find("h2.entry-title, h3.entry-title, .entry-title").text().trim() ||
                  $(el).find("img").attr("alt")?.replace(/^Image\s+/i, "").trim() || "";

    let image = $(el).find("img").attr("data-src") || $(el).find("img").attr("src") || $(el).find("img").attr("data-lazy-src") || "";
    if (image && image.startsWith("//")) image = "https:" + image;

    const rawType = slugMatch ? slugMatch[1] : null;
    const type = rawType === "tv" ? "series" : rawType;
    const quality = $(el).find(".post-ql, .quality, .ql").text().trim() || null;
    const year = $(el).find(".year, .date, .time").text().trim() || null;

    if (!results.find(r => r.id === id)) {
      results.push({
        id,
        title,
        image,
        type,
        quality,
        year,
        url: url || null,
      });
    }
  });

  return results;
}

// Helper: Extract items from popular charts (Most-Watched Series & Films)
function extractPopularItems(html: string, targetType?: string) {
  const $ = cheerio.load(html);
  const results: any[] = [];

  $(".chart-item").each((_, el) => {
    const rankText = $(el).find(".chart-number").text().trim();
    const rank = parseInt(rankText, 10) || null;

    const linkEl = $(el).find("a.chart-poster, a").first();
    const url = linkEl.attr("href") || "";

    const slugMatch = url.match(/\/(tv|series|movies)\/([^/]+)\/?$/);
    const id = slugMatch ? slugMatch[2] : "";
    if (!id) return;

    const rawType = slugMatch ? slugMatch[1] : null;
    const type = rawType === "tv" ? "series" : rawType;
    if (targetType && type && type !== targetType) return;

    const title = $(el).find(".chart-title").text().trim() ||
                  $(el).find("img").attr("alt")?.replace(/^Image\s+/i, "").trim() || "";

    let image = $(el).find("img").attr("data-src") || $(el).find("img").attr("src") || "";
    if (image && image.startsWith("//")) image = "https:" + image;

    const genre = $(el).find(".chart-genre").text().trim() || null;

    if (!results.find(r => r.id === id)) {
      results.push({
        rank,
        id,
        title,
        image,
        type,
        genre,
        url: url || null,
      });
    }
  });

  return results;
}

// Helper: Parse episodes from page HTML (supports .ep-tile buttons & legacy a[href*='/episode/'])
function parseEpisodesFromPage(htmlContent: string, defaultSeasonNum: number = 1) {
  const $ = cheerio.load(htmlContent);
  const eps: any[] = [];

  $(".ep-tile").each((_, el) => {
    const slug = $(el).attr("data-slug") || "";
    const epName = $(el).text().trim() || $(el).attr("data-name") || "";
    const numMatch = epName.match(/(\d+)/) || slug.match(/ep-(\d+)/);
    const epNum = numMatch ? parseInt(numMatch[1], 10) : 0;

    const onclick = $(el).attr("onclick") || "";
    let servers: any[] = [];

    const jsonMatch = onclick.match(/triggerEpisode\s*\(\s*(\[.*?\])\s*,\s*["']/s);
    if (jsonMatch && jsonMatch[1]) {
      try {
        const jsonStr = jsonMatch[1].replace(/\\([\\"'/])/g, "$1");
        servers = JSON.parse(jsonStr);
      } catch {
        const urls = Array.from(onclick.matchAll(/"url"\s*:\s*"([^"]+)"/g)).map(m => m[1].replace(/\\/g, ""));
        servers = urls.map(u => ({ url: u }));
      }
    }

    if (epNum > 0 || slug) {
      eps.push({
        num: epNum,
        season: defaultSeasonNum,
        title: epName,
        slug: slug || `ep-${epNum}`,
        servers,
      });
    }
  });

  if (eps.length === 0) {
    $("a[href*='/episode/']").each((_, a) => {
      const href = $(a).attr("href") || "";
      const m = href.match(/\/episode\/([^/]+)\/?$/);
      const epSlug = m ? m[1] : "";
      if (!epSlug) return;

      const sxe = epSlug.match(/(\d+)x(\d+)$/);
      const sNum = sxe ? parseInt(sxe[1], 10) : defaultSeasonNum;
      const epNum = sxe ? parseInt(sxe[2], 10) : 0;
      if (epNum === 0) return;

      const title = $(a).closest("li, article, .item, div").find(".entry-title, .title").text().trim() ||
                    $(a).text().trim().replace(/^\d+\s*/, "").replace(/\s*View\s*$/i, "").trim() ||
                    `Episode ${epNum}`;

      if (!eps.find(e => e.slug === epSlug)) {
        eps.push({
          num: epNum,
          season: sNum,
          title,
          slug: epSlug,
          url: href,
        });
      }
    });
  }

  return eps;
}

// Helper: Fetch episodes for a series
async function getEpisodesData(seriesSlug: string, requestedSeason?: number | "all") {
  let data: string;
  try {
    data = await fetchPage(`/tv/${seriesSlug}/`);
  } catch {
    try {
      data = await fetchPage(`/series/${seriesSlug}/`);
    } catch {
      data = await fetchPage(`/movies/${seriesSlug}/`);
    }
  }

  const $ = cheerio.load(data);

  const postId = $(".season-btn[data-post]").attr("data-post") ||
                 $("body").attr("class")?.match(/postid-(\d+)/)?.[1] ||
                 $(".bookmark-button, [data-post]").attr("data-post") ||
                 $("[data-id]").attr("data-id") || null;

  const seasons: { num: number; title: string; episodeCount?: number }[] = [];
  $(".season-btn, .sel-temp, .aa-stn li").each((_, el) => {
    const sNum = parseInt($(el).attr("data-season") || "0", 10);
    const sTitle = $(el).text().trim();
    const countMatch = sTitle.match(/\((\d+)\)/);
    const episodeCount = countMatch ? parseInt(countMatch[1], 10) : undefined;
    if (sNum > 0 && !seasons.find(s => s.num === sNum)) {
      seasons.push({ num: sNum, title: sTitle, episodeCount });
    }
  });

  let episodes: any[] = [];

  if (typeof requestedSeason === "number" && requestedSeason > 0 && postId) {
    try {
      const respHtml = await fetchPage(`/wp-admin/admin-ajax.php?action=action_select_season&season=${requestedSeason}&post=${postId}`, { isAjax: true });
      episodes = parseEpisodesFromPage(respHtml, requestedSeason);
    } catch (err: any) {
      console.warn(`AJAX fetch failed for season ${requestedSeason}:`, err.message);
    }
  } else if (postId && seasons.length > 1) {
    const seasonRequests = seasons.map(async (s) => {
      try {
        const respHtml = await fetchPage(`/wp-admin/admin-ajax.php?action=action_select_season&season=${s.num}&post=${postId}`, { isAjax: true });
        return parseEpisodesFromPage(respHtml, s.num);
      } catch (err: any) {
        console.warn(`AJAX fetch failed for season ${s.num}:`, err.message);
        return [];
      }
    });

    const allSeasonEpisodes = await Promise.all(seasonRequests);
    episodes = allSeasonEpisodes.flat();
  } else {
    episodes = parseEpisodesFromPage(data, 1);
  }

  const uniqueMap = new Map<string, any>();
  for (const ep of episodes) {
    if (!uniqueMap.has(ep.slug)) {
      uniqueMap.set(ep.slug, ep);
    }
  }
  episodes = Array.from(uniqueMap.values());
  episodes.sort((a, b) => a.season - b.season || a.num - b.num);

  return { postId, seasons, episodes, rawHtml: data };
}

// ==========================================
// 0. Health & Diagnostics
router.get("/health", async (_req, res) => {
  const t0 = performance.now();
  let upstreamOnline = false;
  let upstreamLatency = 0;
  let upstreamError: string | null = null;
  try {
    const html = await fetchPage("/", { timeoutMs: 8000 });
    upstreamOnline = typeof html === "string" && (html.includes("animesalt") || html.includes("<html"));
    upstreamLatency = Math.round(performance.now() - t0);
  } catch (err: any) {
    upstreamOnline = false;
    upstreamError = err.message;
  }

  res.json({
    success: upstreamOnline,
    status: upstreamOnline ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    upstream: {
      source: BASE_URL,
      online: upstreamOnline,
      latencyMs: upstreamLatency,
      error: upstreamError,
    },
    version: "2.2.0",
    endpointsCount: 13,
  });
});

// Diagnostic / Debug endpoint for inspecting upstream connectivity & Cloudflare status
router.get("/debug", async (_req, res) => {
  const proxyGateway = process.env.PROXY_URL || process.env.SCRAPER_PROXY || "";
  const flareSolverrUrl = getFlareSolverrUrl();
  const redisConfigured = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

  const result: any = {
    timestamp: new Date().toISOString(),
    vercelRegion: process.env.VERCEL_REGION || "local",
    nodeVersion: process.version,
    target: BASE_URL,
    upstashRedisConfigured: redisConfigured,
    configuredProxyUrl: proxyGateway || null,
    configuredFlareSolverrUrl: flareSolverrUrl || null,
    inMemoryCacheEntriesCount: memoryCache.size,
  };

  if (flareSolverrUrl) {
    try {
      const ft0 = performance.now();
      const solverResp = await fetch(`${flareSolverrUrl.replace(/\/+$/, "")}/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cmd: "request.get",
          url: `${BASE_URL}/`,
          maxTimeout: 30000,
        }),
      });
      const fDuration = Math.round(performance.now() - ft0);
      const solverJson = await solverResp.json() as any;
      result.flareSolverrDiagnostic = {
        status: solverResp.status,
        durationMs: fDuration,
        solutionStatus: solverJson.status,
        isChallenge: solverJson.solution?.response ? solverJson.solution.response.includes("Just a moment...") : true,
        preview: solverJson.solution?.response ? solverJson.solution.response.slice(0, 150).replace(/\s+/g, " ").trim() : solverJson.message,
      };
    } catch (fErr: any) {
      result.flareSolverrDiagnostic = { error: fErr.message };
    }
  }

  if (proxyGateway) {
    try {
      const testUrl = buildProxyUrl(proxyGateway, `${BASE_URL}/`);
      const pt0 = performance.now();
      const pResp = await fetch(testUrl);
      const pText = await pResp.text();
      result.proxyDiagnostic = {
        requestedUrl: testUrl,
        status: pResp.status,
        latencyMs: Math.round(performance.now() - pt0),
        isOk: pResp.ok,
        isHtml: pText.includes("<html") || pText.includes("<article"),
        isChallenge: pText.includes("Just a moment...") || pText.includes("cf-browser-verification"),
        preview: pText.slice(0, 250).replace(/\s+/g, " ").trim(),
      };
    } catch (pErr: any) {
      result.proxyDiagnostic = { error: pErr.message };
    }
  }

  try {
    const t0 = performance.now();
    const resp = await fetch(`${BASE_URL}/`, {
      headers: CHROME_HEADERS,
      redirect: "follow",
    });
    result.directUpstream = {
      status: resp.status,
      latencyMs: Math.round(performance.now() - t0),
      isChallenge: (await resp.text()).includes("Just a moment..."),
    };
  } catch (err: any) {
    result.directUpstream = { error: err.message };
  }

  res.json(result);
});

// 1. Search with pagination
router.get("/search", async (req, res) => {
  const keyword = req.query.keyword as string;
  const page = parseInt(req.query.page as string || "1", 10);
  if (!keyword) return res.status(400).json({ success: false, error: "Keyword required" });

  const cacheKey = `search_${keyword.toLowerCase()}_p${page}`;
  const cached = await getCachedAsync(cacheKey);
  if (cached) return sendCachedResponse(res, cached, 600);

  try {
    const searchUrl = page > 1 ? `/?s=${encodeURIComponent(keyword)}&paged=${page}` : "/";
    const data = await fetchPage(searchUrl, { params: page === 1 ? { s: keyword } : {} });
    const results = extractAnimeList(data);
    const payload = { success: true, page, data: results };
    await setCacheAsync(cacheKey, payload, 600);
    sendCachedResponse(res, payload, 600);
  } catch (e: any) {
    if (e.status === 404 || e.response?.status === 404) {
      return res.json({ success: true, page, data: [] });
    }
    console.error("Search error:", e.message);
    res.status(500).json({ success: false, error: "Failed to scrape search results", details: e.message });
  }
});

// 2. Latest Episodes
router.get("/latest-episodes", async (_req, res) => {
  const cacheKey = "latest_episodes";
  const cached = await getCachedAsync(cacheKey);
  if (cached) return sendCachedResponse(res, cached, 300);

  try {
    const data = await fetchPage("/");
    const $ = cheerio.load(data);
    let results = extractAnimeList(data);

    if (results.length === 0) {
      $("section.widget_list_episodes article.post, .widget_list_episodes article, article.post").each((_, el) => {
        const linkEl = $(el).find("a.lnk-blk").first();
        let url = linkEl.attr("href") || $(el).find("a[href*='/tv/'], a[href*='/series/'], a[href*='/movies/'], a[href*='/episode/']").first().attr("href") || "";
        const slugMatch = url.match(/\/(tv|series|movies|episode)\/([^/]+)\/?$/);
        const id = slugMatch ? slugMatch[2] : "";
        if (!id) return;

        const title = $(el).find("h2.entry-title, h3, .entry-title").text().trim() ||
                      $(el).find("img").attr("alt")?.replace(/^Image\s+/i, "").trim() || "";
        let image = $(el).find("img").attr("data-src") || $(el).find("img").attr("src") || "";
        if (image && image.startsWith("//")) image = "https:" + image;

        if (!results.find(r => r.id === id)) {
          const rawType = slugMatch?.[1] || null;
          const type = rawType === "tv" ? "series" : rawType;
          results.push({
            id,
            title,
            image,
            type,
            url: url || null,
          });
        }
      });
    }

    const payload = { success: true, data: results };
    await setCacheAsync(cacheKey, payload, 300);
    sendCachedResponse(res, payload, 300);
  } catch (e: any) {
    console.error("Latest eps error:", e.message);
    res.status(500).json({ success: false, error: "Failed to scrape latest episodes", details: e.message });
  }
});

// 3. Popular Anime / Charts (Most-Watched Series & Films)
router.get("/popular", async (req, res) => {
  const type = req.query.type as string;
  const cacheKey = `popular_${type || "all"}`;
  const cached = await getCachedAsync(cacheKey);
  if (cached) return sendCachedResponse(res, cached, 900);

  try {
    let data: string;
    try {
      data = await fetchPage("/type/popular/");
    } catch {
      data = await fetchPage("/");
    }
    let results = extractPopularItems(data, type);

    if (results.length === 0) {
      results = extractAnimeList(data);
    }

    const payload = { success: true, data: results };
    await setCacheAsync(cacheKey, payload, 900);
    sendCachedResponse(res, payload, 900);
  } catch (e: any) {
    console.error("Popular error:", e.message);
    res.status(500).json({ success: false, error: "Failed to scrape popular anime", details: e.message });
  }
});

// 4. Completed Anime with pagination
router.get("/completed", async (req, res) => {
  const page = parseInt(req.query.page as string || "1", 10);
  const cacheKey = `completed_p${page}`;
  const cached = await getCachedAsync(cacheKey);
  if (cached) return sendCachedResponse(res, cached, 900);

  try {
    let data: string;
    try {
      const path = page > 1 ? `/type/completed/page/${page}/` : "/type/completed/";
      data = await fetchPage(path);
    } catch {
      const fallbackPath = page > 1 ? `/category/status/completed/page/${page}/` : "/category/status/completed/";
      data = await fetchPage(fallbackPath);
    }
    const results = extractAnimeList(data);
    const payload = { success: true, page, data: results };
    await setCacheAsync(cacheKey, payload, 900);
    sendCachedResponse(res, payload, 900);
  } catch (e: any) {
    if (e.status === 404 || e.response?.status === 404) {
      return res.json({ success: true, page, data: [] });
    }
    console.error("Completed error:", e.message);
    res.status(500).json({ success: false, error: "Failed to scrape completed anime", details: e.message });
  }
});

// 5. Ongoing Anime with pagination
router.get("/ongoing", async (req, res) => {
  const page = parseInt(req.query.page as string || "1", 10);
  const cacheKey = `ongoing_p${page}`;
  const cached = await getCachedAsync(cacheKey);
  if (cached) return sendCachedResponse(res, cached, 600);

  try {
    let data: string;
    try {
      const path = page > 1 ? `/type/ongoing/page/${page}/` : "/type/ongoing/";
      data = await fetchPage(path);
    } catch {
      const fallbackPath = page > 1 ? `/category/status/ongoing/page/${page}/` : "/category/status/ongoing/";
      data = await fetchPage(fallbackPath);
    }
    const results = extractAnimeList(data);
    const payload = { success: true, page, data: results };
    await setCacheAsync(cacheKey, payload, 600);
    sendCachedResponse(res, payload, 600);
  } catch (e: any) {
    if (e.status === 404 || e.response?.status === 404) {
      return res.json({ success: true, page, data: [] });
    }
    console.error("Ongoing error:", e.message);
    res.status(500).json({ success: false, error: "Failed to scrape ongoing anime", details: e.message });
  }
});

// 6. Type filter (anime / cartoon) with subtype (series / movies) & pagination
router.get("/type/:type", async (req, res) => {
  const { type } = req.params;
  const subtype = (req.query.subtype as string) || "series";
  const page = parseInt(req.query.page as string || "1", 10);

  const cacheKey = `type_${type}_${subtype}_p${page}`;
  const cached = await getCachedAsync(cacheKey);
  if (cached) return sendCachedResponse(res, cached, 900);

  try {
    let data: string;
    try {
      const path = page > 1 ? `/type/${type}/page/${page}/` : `/type/${type}/`;
      data = await fetchPage(path, { params: { type: subtype } });
    } catch {
      const fallbackPath = page > 1 ? `/category/type/${type}/page/${page}/` : `/category/type/${type}/`;
      data = await fetchPage(fallbackPath, { params: { type: subtype } });
    }
    const results = extractAnimeList(data);
    const payload = { success: true, page, type, subtype, data: results };
    await setCacheAsync(cacheKey, payload, 900);
    sendCachedResponse(res, payload, 900);
  } catch (e: any) {
    if (e.status === 404 || e.response?.status === 404) {
      return res.json({ success: true, page, type, subtype, data: [] });
    }
    console.error("Type error:", e.message);
    res.status(500).json({ success: false, error: `Failed to scrape type ${type}`, details: e.message });
  }
});

// 7. Genre filter with pagination
router.get("/genre/:category", async (req, res) => {
  const { category } = req.params;
  const page = parseInt(req.query.page as string || "1", 10);

  const cacheKey = `genre_${category}_p${page}`;
  const cached = await getCachedAsync(cacheKey);
  if (cached) return sendCachedResponse(res, cached, 900);

  try {
    let data: string;
    try {
      const path = page > 1 ? `/genre/${category}/page/${page}/` : `/genre/${category}/`;
      data = await fetchPage(path);
    } catch {
      const fallbackPath = page > 1 ? `/category/genre/${category}/page/${page}/` : `/category/genre/${category}/`;
      data = await fetchPage(fallbackPath);
    }
    const results = extractAnimeList(data);
    const payload = { success: true, page, genre: category, data: results };
    await setCacheAsync(cacheKey, payload, 900);
    sendCachedResponse(res, payload, 900);
  } catch (e: any) {
    if (e.status === 404 || e.response?.status === 404) {
      return res.json({ success: true, page, genre: category, data: [] });
    }
    console.error("Genre error:", e.message);
    res.status(500).json({ success: false, error: `Failed to scrape genre ${category}`, details: e.message });
  }
});

// 8. Anime Details / Info
router.get("/info", async (req, res) => {
  const animeId = req.query.id as string;
  if (!animeId) return res.status(400).json({ success: false, error: "Anime ID (slug) is required" });

  const cacheKey = `info_${animeId}`;
  const cached = await getCachedAsync(cacheKey);
  if (cached) return sendCachedResponse(res, cached, 86400);

  try {
    let data: string;
    let type = "series";

    try {
      data = await fetchPage(`/tv/${animeId}/`);
    } catch (tvErr: any) {
      try {
        data = await fetchPage(`/series/${animeId}/`);
      } catch (seriesErr: any) {
        data = await fetchPage(`/movies/${animeId}/`);
        type = "movies";
      }
    }

    const $ = cheerio.load(data);

    const title = $("h1.entry-title, .hero-title, .sheader .data h1, h1").first().text().trim();
    let poster = $(".hero-poster-mini, .sheader .poster img, .post-thumbnail img, img.wp-post-image, .poster img, img")
                 .first().attr("src") || $(".hero-poster-mini, img").first().attr("data-src") || "";
    if (poster && poster.startsWith("//")) poster = "https:" + poster;

    const description = $("#overview-text p, #overview-text, .overview, .synopsis, .sinopsis, .entry-content p, .wp-content p")
                          .first().text().trim();

    const genres: string[] = [];
    $('a[href*="/genre/"], a[href*="/category/genre/"]').each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) genres.push(g);
    });

    const languages: string[] = [];
    $('a[href*="/audio/"], a[href*="/category/language/"]').each((_, el) => {
      const l = $(el).text().trim();
      if (l && !languages.includes(l)) languages.push(l);
    });

    const info: Record<string, string> = {};
    $(".custom_fields, .spe, .extra, .metainfo, .info-content, .anime-meta-item").find("span, li, p, div").each((_, el) => {
      const text = $(el).text();
      const parts = text.split(":");
      if (parts.length >= 2) {
        const key = parts[0].trim().toLowerCase().replace(/[^a-z0-9]/g, "_");
        const val = parts.slice(1).join(":").trim();
        if (key && val) info[key] = val;
      }
    });

    let seasons: { num: number; title: string; episodeCount?: number }[] = [];
    let totalEpisodes = 0;

    if (type === "series") {
      try {
        const epData = await getEpisodesData(animeId);
        seasons = epData.seasons;
        const sumCounts = seasons.reduce((sum, s) => sum + (s.episodeCount || 0), 0);
        totalEpisodes = sumCounts > 0 ? sumCounts : epData.episodes.length;
      } catch (epErr) {
        console.warn("Could not fetch episodes for info:", epErr);
      }
    } else {
      totalEpisodes = 1;
    }

    const related: any[] = [];
    $(".srelacionados article, .releated article, .related article, article").each((_, el) => {
      const url = $(el).find("a.lnk-blk").attr("href") || $(el).find("a").first().attr("href") || "";
      const slugMatch = url.match(/\/(tv|series|movies)\/([^/]+)\/?$/);
      const relId = slugMatch ? slugMatch[2] : "";
      if (!relId || relId === animeId) return;

      const relTitle = $(el).find("h2.entry-title, .entry-title").text().trim() ||
                       $(el).find("img").attr("alt")?.replace(/^Image\s+/i, "").trim() || "";
      let relImage = $(el).find("img").attr("src") || $(el).find("img").attr("data-src") || "";
      if (relImage && relImage.startsWith("//")) relImage = "https:" + relImage;

      if (!related.find(r => r.id === relId)) {
        related.push({ id: relId, title: relTitle, image: relImage });
      }
    });

    const payload = {
      success: true,
      data: {
        id: animeId,
        title,
        poster,
        description,
        type,
        totalEpisodes,
        seasons,
        related,
        ...info,
      },
    };
    await setCacheAsync(cacheKey, payload, 86400); // 24 hours
    sendCachedResponse(res, payload, 86400);
  } catch (e: any) {
    console.error("Info error:", e.message);
    res.status(500).json({ success: false, error: "Failed to scrape anime details", details: e.message });
  }
});

// 9. Episodes List with optional season filter (?season=2 or default all seasons)
router.get("/episodes/:animeId", async (req, res) => {
  const { animeId } = req.params;
  const seasonParam = req.query.season as string;
  const requestedSeason = seasonParam ? parseInt(seasonParam, 10) : undefined;

  const cacheKey = `episodes_${animeId}_s${requestedSeason || 'all'}`;
  const cached = await getCachedAsync(cacheKey);
  if (cached) return sendCachedResponse(res, cached, 86400);

  try {
    const { episodes, seasons } = await getEpisodesData(animeId, requestedSeason);
    const formattedEpisodes = episodes.map(e => ({
      num: e.num,
      season: e.season,
      title: e.title,
      slug: e.slug,
      url: e.url,
      servers: e.servers || [],
    }));

    const payload = {
      success: true,
      data: {
        animeId,
        currentSeason: requestedSeason || "all",
        seasons,
        totalEpisodes: formattedEpisodes.length,
        episodes: formattedEpisodes,
      },
    };
    await setCacheAsync(cacheKey, payload, 86400); // 24 hours
    sendCachedResponse(res, payload, 86400);
  } catch (e: any) {
    console.error("Episodes error:", e.message);
    res.status(500).json({ success: false, error: "Failed to scrape episodes", details: e.message });
  }
});

// 10. Video Servers for an episode
router.get("/servers", async (req, res) => {
  const { ep: epSlug, id: animeId } = req.query as { id?: string; ep: string };
  if (!epSlug) return res.status(400).json({ success: false, error: "Episode slug (ep) is required" });

  const cacheKey = `servers_${animeId || 'none'}_${epSlug}`;
  const cached = await getCachedAsync(cacheKey);
  if (cached) return sendCachedResponse(res, cached, 86400);

  try {
    let servers: any[] = [];
    const targetAnimeId = animeId || epSlug.replace(/-(?:(\d+)x)?\d+$/, "").replace(/-ep-\d+$/, "");

    if (targetAnimeId) {
      try {
        const { episodes } = await getEpisodesData(targetAnimeId);
        const epNumMatch = epSlug.match(/(?:(\d+)x)?(\d+)$/) || epSlug.match(/ep-(\d+)/);
        const epNum = epNumMatch ? parseInt(epNumMatch[2] || epNumMatch[1], 10) : null;

        const matchedEp = episodes.find(e =>
          e.slug === epSlug ||
          e.slug === `ep-${epSlug}` ||
          String(e.num) === epSlug ||
          (epNum !== null && e.num === epNum)
        );

        if (matchedEp && matchedEp.servers && matchedEp.servers.length > 0) {
          servers = matchedEp.servers.map((s: any, idx: number) => ({
            index: idx,
            serverName: s.name ? `${s.name} - ${s.lang || 'Default'}` : `Server ${idx + 1}`,
            embedUrl: s.url || null,
            language: s.lang || "Default",
            isMultiLang: false,
          }));
        }
      } catch (err) {
        console.warn("Could not get servers from anime page:", err);
      }
    }

    if (servers.length === 0) {
      let data = "";
      try {
        data = await fetchPage(`/episode/${epSlug}/`);
      } catch {
        if (targetAnimeId) {
          data = await fetchPage(`/tv/${targetAnimeId}/`);
        }
      }

      if (data) {
        const $ = cheerio.load(data);
        $(".server-btn").each((index, el) => {
          const serverNameHeader = $(el).find(".server-name").text().trim() || `SERVER ${index + 1}`;
          const serverInfo = $(el).find(".server-info").text().trim();
          const fullName = serverInfo ? `${serverNameHeader} - ${serverInfo}` : serverNameHeader;

          const videoContainer = $(`#options-${index}`).length ? $(`#options-${index}`) : $(".video.aa-tb").eq(index);
          const iframe = videoContainer.find("iframe");
          const embedUrl = iframe.attr("src") || iframe.attr("data-src") || "";

          servers.push({
            index,
            serverName: fullName,
            embedUrl: embedUrl || null,
            isMultiLang: false,
          });
        });

        if (servers.length === 0) {
          $("iframe").each((i, el) => {
            const src = $(el).attr("src") || $(el).attr("data-src") || "";
            if (src && !src.includes("google") && !src.includes("facebook") && !src.includes("ad")) {
              servers.push({
                index: i,
                serverName: `Server ${i + 1}`,
                embedUrl: src,
                isMultiLang: false,
              });
            }
          });
        }
      }
    }

    const payload = { success: true, data: servers };
    await setCacheAsync(cacheKey, payload, 86400); // 24 hours
    sendCachedResponse(res, payload, 86400);
  } catch (e: any) {
    console.error("Servers error:", e.message);
    res.status(500).json({ success: false, error: "Failed to scrape servers", details: e.message });
  }
});

// 11. Stream / Embed URL extractor
router.get("/stream", async (req, res) => {
  const { ep: epSlug, id: animeId, server: serverParam, lang } = req.query as {
    id?: string;
    ep: string;
    server?: string;
    lang?: string;
  };

  if (!epSlug) return res.status(400).json({ success: false, error: "Episode slug (ep) is required" });

  const cacheKey = `stream_${animeId || 'none'}_${epSlug}_s${serverParam || 0}_l${lang || 'default'}`;
  const cached = await getCachedAsync(cacheKey);
  if (cached) return sendCachedResponse(res, cached, 86400);

  try {
    let embedUrl: string | null = null;
    let selectedLanguage: string | null = lang || null;
    const serverIndex = parseInt(serverParam || "0", 10);

    const targetAnimeId = animeId || epSlug.replace(/-(?:(\d+)x)?\d+$/, "").replace(/-ep-\d+$/, "");

    if (targetAnimeId) {
      try {
        const { episodes } = await getEpisodesData(targetAnimeId);
        const epNumMatch = epSlug.match(/(?:(\d+)x)?(\d+)$/) || epSlug.match(/ep-(\d+)/);
        const epNum = epNumMatch ? parseInt(epNumMatch[2] || epNumMatch[1], 10) : null;

        const matchedEp = episodes.find(e =>
          e.slug === epSlug ||
          e.slug === `ep-${epSlug}` ||
          String(e.num) === epSlug ||
          (epNum !== null && e.num === epNum)
        );

        if (matchedEp && matchedEp.servers && matchedEp.servers.length > 0) {
          const s = matchedEp.servers[serverIndex] || matchedEp.servers[0];
          embedUrl = s.url || null;
          selectedLanguage = s.lang || null;
        }
      } catch (err) {
        console.warn("Could not parse stream from anime page:", err);
      }
    }

    if (!embedUrl) {
      let data = "";
      try {
        data = await fetchPage(`/episode/${epSlug}/`);
      } catch {
        if (targetAnimeId) {
          data = await fetchPage(`/tv/${targetAnimeId}/`);
        }
      }

      if (data) {
        const $ = cheerio.load(data);
        const videoContainer = $(`#options-${serverIndex}`).length ? $(`#options-${serverIndex}`) : $(".video.aa-tb").eq(serverIndex);
        const iframe = videoContainer.find("iframe").length ? videoContainer.find("iframe") : $("iframe").eq(serverIndex);

        embedUrl = iframe.attr("src") || iframe.attr("data-src") || null;
      }
    }

    if (embedUrl && embedUrl.startsWith("//")) {
      embedUrl = "https:" + embedUrl;
    }

    const payload = {
      success: true,
      data: {
        embedUrl,
        serverIndex,
        selectedLanguage,
        isIframe: true,
        referer: `${BASE_URL}/`,
      },
    };
    await setCacheAsync(cacheKey, payload, 86400); // 24 hours
    sendCachedResponse(res, payload, 86400);
  } catch (e: any) {
    console.error("Stream error:", e.message);
    res.status(500).json({ success: false, error: "Failed to scrape stream", details: e.message });
  }
});

// Register router on both /api (standard external URL) and / (Vercel serverless function root)
app.use("/api", router);
app.use("/", router);

export default app;
