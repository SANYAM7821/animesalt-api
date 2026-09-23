/**
 * AnimeSalt Edge Reverse Proxy — v2.1
 *
 * Deploy this script to a Cloudflare Worker (Workers & Pages → Create Worker).
 * This Worker runs inside Cloudflare's own edge network, so outbound subrequests
 * to animesalt.me (also behind Cloudflare) are treated as trusted internal traffic
 * and bypass Super Bot Fight Mode.
 */
export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);

    // --- Target URL Resolution (3 modes) ---

    // Mode 1: Query parameter — ?url=https://animesalt.me/tv/jojos-bizarre-adventure-season-3/
    let target = url.searchParams.get("url");

    // Mode 2: Path-encoded URL — /https://animesalt.me/tv/jojos-bizarre-adventure-season-3/
    if (!target && url.pathname.startsWith("/http")) {
      target = decodeURIComponent(url.pathname.slice(1)) + url.search;
    }

    // Mode 3: Reverse proxy — /tv/jojos-bizarre-adventure-season-3/ (default, appended to BASE)
    if (!target) {
      target = "https://animesalt.me" + url.pathname + url.search;
    }

    // Validate target is animesalt (animesalt.me or animesalt.cx) to prevent open-proxy abuse
    try {
      const targetUrl = new URL(target);
      if (!targetUrl.hostname.includes("animesalt.")) {
        return new Response("Forbidden: only animesalt targets are allowed", { status: 403 });
      }
    } catch {
      return new Response("Bad Request: invalid target URL", { status: 400 });
    }

    try {
      // Determine if this is an AJAX/XHR request (admin-ajax.php)
      const isAjax = target.includes("admin-ajax.php");

      const response = await fetch(target, {
        method: request.method,

        // Hardcoded browser-like headers — never leak the Worker/Vercel origin
        headers: isAjax
          ? {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
              "Accept": "*/*",
              "Accept-Language": "en-US,en;q=0.9",
              "X-Requested-With": "XMLHttpRequest",
              "Referer": "https://animesalt.me/",
              "Origin": "https://animesalt.me",
              "sec-fetch-dest": "empty",
              "sec-fetch-mode": "cors",
              "sec-fetch-site": "same-origin",
            }
          : {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
              "Cache-Control": "no-cache",
              "Pragma": "no-cache",
              "Referer": "https://www.google.com/search?q=animesalt",
              "sec-fetch-dest": "document",
              "sec-fetch-mode": "navigate",
              "sec-fetch-site": "cross-site",
              "sec-fetch-user": "?1",
              "Upgrade-Insecure-Requests": "1",
            },

        cf: {
          scrapeShield: false,
          cacheTtl: 0,
          cacheEverything: false,
        },
      });

      // Build clean response headers
      const responseHeaders = new Headers();
      responseHeaders.set("Content-Type", response.headers.get("Content-Type") || "text/html; charset=utf-8");
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      responseHeaders.set("Access-Control-Allow-Headers", "*");

      // Forward encoding header so clients decompress correctly
      const encoding = response.headers.get("Content-Encoding");
      if (encoding) responseHeaders.set("Content-Encoding", encoding);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Worker proxy error", message: err.message }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  },
};
