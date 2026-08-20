const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = process.env.PORT || 8080;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function loadGames(){
  const raw = fs.readFileSync(path.join(root, "assets", "games.json"), "utf8").replace(/^﻿/, "");
  return JSON.parse(raw);
}

// Strategy: allow the game's own hosting infra + the loader SDKs some
// publisher networks legitimately need to boot the game at all, but
// deliberately never list known ad-exchange/ad-SDK domains anywhere in
// script-src -- CSP has no "block except" syntax, so the only real
// lever is what's absent from the allow-list. A too-narrow allow-list
// (single host only) breaks games whose bootstrap loader lives on a
// third-party domain (observed: yyggames.com, babygames.com,
// api.gamemonetize.com's sdk.js), so those stay allowed; the confirmed
// ad-delivery domains (Google IMA/AdSense, Amazon, Criteo, Taboola,
// Outbrain, MGID, PropellerAds, etc.) stay out on purpose.
const GAME_ALLOWED_HOSTS = [
  "https://html5.gamemonetize.co",
  "https://gamemonetize.co",
  "https://*.gamemonetize.games",
  "https://api.gamemonetize.com",
  "https://gamemonetize.com",
  "https://*.yyggames.com",
  "https://*.babygames.com",
  "https://*.unity3d.com",
].join(" ");

const CDN_HOSTS = [
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://cdn.jsdelivr.net",
  "https://cdnjs.cloudflare.com",
  "https://unpkg.com",
  "https://code.jquery.com",
  "https://ajax.googleapis.com",
].join(" ");

const GAME_CSP = [
  `default-src 'self' ${GAME_ALLOWED_HOSTS} https: data: blob:`,
  `script-src 'self' ${GAME_ALLOWED_HOSTS} ${CDN_HOSTS} 'unsafe-inline' 'unsafe-eval' data: blob:`,
  `frame-src 'self' ${GAME_ALLOWED_HOSTS}`,
  `style-src 'self' https: 'unsafe-inline'`,
  `object-src 'none'`,
].join("; ");

function findGame(id){
  const games = loadGames();
  return games.find(g => g.id === id);
}

// The site only ever has one game open in the player at a time, so this
// is a reliable fallback for orphaned asset requests that arrive with no
// way to identify which game they belong to (see proxyAsset()).
let lastPlayedId = null;

function proxyGame(id, res){
  let game;
  try { game = findGame(id); }
  catch (e){
    res.writeHead(500); res.end("Could not read games.json"); return;
  }
  if (!game){
    res.writeHead(404); res.end("Game not found"); return;
  }
  lastPlayedId = id;

  https.get(game.url, (upstream) => {
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location){
      // follow one redirect (some game URLs redirect to a trailing-slash path)
      https.get(upstream.headers.location, (r2) => pipeGameHtml(r2, game, res)).on("error", () => {
        res.writeHead(502); res.end("Upstream redirect failed");
      });
      return;
    }
    pipeGameHtml(upstream, game, res);
  }).on("error", () => {
    res.writeHead(502); res.end("Could not reach game server");
  });
}

// Every relative asset the game document requests (scripts, css, images,
// wasm, json) is proxied through here too, same-origin to our own server.
// This isn't just tidiness: ES module scripts (<script type="module">,
// common in Construct3 exports) are fetched by the browser in CORS mode
// even when nothing in the page asks for CORS, and html5.gamemonetize.co
// sends no Access-Control-Allow-Origin header -- so under a plain
// cross-origin <base href>, those specific requests silently fail and
// the game never boots (black screen, no console-visible cause beyond a
// CORS error). Proxying the asset itself makes the request same-origin,
// which sidesteps CORS entirely.
function proxyAsset(id, assetPath, search, res, refererId){
  let game;
  try { game = findGame(id); }
  catch (e){
    res.writeHead(500); res.end(); return;
  }
  if (!game){
    // /play/<id>/<rest> is matched greedily, so a request whose real path
    // has no id segment at all (see the Worker path-resolution note above)
    // parses its first path segment as if it were the id. When that
    // "id" doesn't exist, retry once treating it as part of the asset
    // path instead -- prefer the Referer's id, falling back to whichever
    // game was most recently opened (see lastPlayedId).
    const recoveredId = (refererId && findGame(refererId)) ? refererId
      : (lastPlayedId && findGame(lastPlayedId)) ? lastPlayedId
      : null;
    if (recoveredId){
      proxyAsset(recoveredId, id + "/" + assetPath, search, res);
      return;
    }
    res.writeHead(404); res.end(); return;
  }

  let target;
  try {
    target = new URL(assetPath + (search || ""), game.url).href;
  } catch (e){
    res.writeHead(400); res.end(); return;
  }

  fetchAndPipe(target, res, 0);
}

function fetchAndPipe(url, res, redirectCount){
  https.get(url, (upstream) => {
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location && redirectCount < 5){
      const next = new URL(upstream.headers.location, url).href;
      upstream.resume();
      fetchAndPipe(next, res, redirectCount + 1);
      return;
    }
    const headers = {};
    if (upstream.headers["content-type"]) headers["Content-Type"] = upstream.headers["content-type"];
    if (upstream.headers["content-length"]) headers["Content-Length"] = upstream.headers["content-length"];
    res.writeHead(upstream.statusCode || 200, headers);
    upstream.pipe(res);
  }).on("error", () => {
    res.writeHead(502); res.end();
  });
}

// GameMonetize's own Construct3 export template wires up a "preload ad"
// slot via this exact IIFE (it injects sdk_preload.js, which renders the
// "You can skip this in N secs" placeholder even when the ad creative
// itself is CSP-blocked -- the empty slot + skip timer are first-party
// UI, not the blocked ad, so CSP alone can't remove them). Stripping the
// snippet stops the slot from ever being created.
const AD_SNIPPET_PATTERNS = [
  /<script>[^<]*gamemonetize-preload-api[\s\S]*?<\/script>/gi,
  /<script[^>]*sdk_preload\.js[^>]*><\/script>/gi,
];

function stripAdSnippets(html){
  return AD_SNIPPET_PATTERNS.reduce((h, re) => h.replace(re, ""), html);
}

function pipeGameHtml(upstream, game, res){
  const chunks = [];
  upstream.on("data", (c) => chunks.push(c));
  upstream.on("end", () => {
    let html = Buffer.concat(chunks).toString("utf8");
    html = stripAdSnippets(html);
    // Point relative asset URLs at our own asset-proxy route (same-origin)
    // rather than the real game host directly -- see proxyAsset() for why.
    const baseTag = `<base href="/play/${encodeURIComponent(game.id)}/">`;
    if (/<head[^>]*>/i.test(html)){
      html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
    } else {
      html = baseTag + html;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": GAME_CSP,
    });
    res.end(html);
  });
}

http.createServer((req, res) => {
  const queryIdx = req.url.indexOf("?");
  const rawPath = queryIdx === -1 ? req.url : req.url.slice(0, queryIdx);
  const search = queryIdx === -1 ? "" : req.url.slice(queryIdx);
  const urlPath = decodeURIComponent(rawPath);

  const playRootMatch = urlPath.match(/^\/play\/([^/]+)\/?$/);
  if (playRootMatch){
    proxyGame(playRootMatch[1], res);
    return;
  }

  const playAssetMatch = rawPath.match(/^\/play\/([^/]+)\/(.+)$/);
  if (playAssetMatch){
    // Some game runtimes (seen in Construct3 exports) spawn Web Workers
    // with a relative path resolved as if the document lived one folder
    // shallower than it actually does, so the request lands at
    // /play/scripts/foo.js -- the game id falls off entirely and this
    // regex misparses "scripts" as the id. proxyAsset() recovers via the
    // Referer (the real /play/<id>/... page) when the parsed id is bogus.
    const referer = req.headers.referer || "";
    const refMatch = referer.match(/\/play\/([^/]+)\//);
    proxyAsset(decodeURIComponent(playAssetMatch[1]), playAssetMatch[2], search, res, refMatch && decodeURIComponent(refMatch[1]));
    return;
  }

  let filePath = urlPath;
  if (filePath === "/") filePath = "/index.html";
  const full = path.join(root, filePath);
  fs.readFile(full, (err, data) => {
    if (err){
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(full);
    // index.html has no version query string of its own, so it must
    // always be revalidated -- otherwise Cloudflare/browsers can keep
    // serving an old page that still points at old, now-purged asset
    // URLs. CSS/JS are safe to cache hard since bumping "?v=" busts them.
    const cacheControl = filePath === "/index.html"
      ? "no-cache"
      : (ext === ".css" || ext === ".js") ? "public, max-age=31536000, immutable" : "public, max-age=3600";
    res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream", "Cache-Control": cacheControl });
    res.end(data);
  });
}).listen(port, () => console.log("Serving on http://localhost:" + port));
