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
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function loadGames(){
  const raw = fs.readFileSync(path.join(root, "assets", "games.json"), "utf8").replace(/^﻿/, "");
  return JSON.parse(raw);
}

// ---------- Votes (persisted) ----------
// Railway injects RAILWAY_VOLUME_MOUNT_PATH when a volume is attached to
// the service; without one this falls back to a local "data" folder, which
// works for local dev but gets wiped on every redeploy in production since
// Railway's default filesystem is ephemeral. A volume is required for the
// counts to actually survive across deploys.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(root, "data");
const VOTES_PATH = path.join(DATA_DIR, "votes.json");

function loadVotes(){
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e){}
  try { return JSON.parse(fs.readFileSync(VOTES_PATH, "utf8").replace(/^﻿/, "")); }
  catch (e){ return {}; }
}
let votes = loadVotes();
function saveVotes(){
  try { fs.writeFileSync(VOTES_PATH, JSON.stringify(votes)); }
  catch (e){ console.error("Could not persist votes:", e.message); }
}
function applyVoteDelta(gameId, prevVote, newVote){
  if (!votes[gameId]) votes[gameId] = { up: 0, down: 0 };
  const v = votes[gameId];
  if (prevVote === "up") v.up = Math.max(0, v.up - 1);
  if (prevVote === "down") v.down = Math.max(0, v.down - 1);
  if (newVote === "up") v.up += 1;
  if (newVote === "down") v.down += 1;
  return v;
}

// ---------- Live player presence (in-memory only, resets on restart --
// this is genuinely live/transient data, so it doesn't need a volume) ----------
const PRESENCE_TTL_MS = 25000;
const presence = new Map(); // gameId -> Map(sessionId -> lastSeen ms)

function touchPresence(gameId, sessionId){
  let m = presence.get(gameId);
  if (!m){ m = new Map(); presence.set(gameId, m); }
  m.set(sessionId, Date.now());
}
// Called when a player explicitly closes the game (or the tab/page unloads),
// so the count drops right away instead of waiting out the full TTL.
function removePresence(gameId, sessionId){
  const m = presence.get(gameId);
  if (m) m.delete(sessionId);
}
function purgePresence(m){
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const [sid, ts] of m) if (ts < cutoff) m.delete(sid);
}
function liveCountFor(gameId){
  const m = presence.get(gameId);
  if (!m) return 0;
  purgePresence(m);
  return m.size;
}
function allLiveCounts(){
  const out = {};
  for (const [gameId, m] of presence){
    purgePresence(m);
    if (m.size > 0) out[gameId] = m.size;
  }
  return out;
}

function readJsonBody(req, maxBytes, cb){
  let size = 0;
  const chunks = [];
  let done = false;
  req.on("data", (c) => {
    if (done) return;
    size += c.length;
    if (size > maxBytes){ done = true; req.destroy(); cb(new Error("Body too large")); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (done) return;
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
    catch (e){ cb(e); }
  });
  req.on("error", (e) => { if (!done){ done = true; cb(e); } });
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
  // GameDistribution: the wrapper page at html5.gamedistribution.com/<id>/
  // only loads the real game after their ad SDK (html5.api.gamedistribution.com)
  // fires a "game start" event, so games sourced here are stored in
  // games.json pointing straight at the actual asset path (see resolveGameDistributionUrl)
  // instead of the wrapper -- same host, no ad SDK ever gets a chance to load.
  "https://html5.gamedistribution.com",
  // Getaway Shootout isn't distributed through GameMonetize or
  // GameDistribution's open catalogs (it's a Poki/CrazyGames exclusive).
  // This GitHub Pages mirror serves the bare Unity WebGL build (the
  // twoplayergames.org mirror worked too but bakes its own logo into the
  // build's compiled assets, not something a proxy can strip) -- no ad
  // SDK in the HTML, verified with no failed/ad-related requests on load.
  "https://mi-go45.github.io",
  // Open-source games that became famous as GitHub projects themselves,
  // self-hosted straight from their own GitHub Pages demo (MIT/BSD
  // licensed) -- the author's own demo page embeds AdSense, but our CSP
  // never allow-lists googlesyndication/doubleclick, so that script just
  // fails to load through our proxy instead of showing ads.
  "https://gabrielecirulli.github.io",
  "https://wayou.github.io",
  // Moto X3M's GameMonetize wrapper nests the actual game in an <iframe>
  // pointing at this Chinese game CDN (their own upstream source for this
  // title) -- without it allow-listed the nested frame was silently
  // CSP-blocked, leaving a blank page.
  "https://*.4399.com",
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
function proxyAsset(id, assetPath, search, res, refererId, range){
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
      proxyAsset(recoveredId, id + "/" + assetPath, search, res, undefined, range);
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

  fetchAndPipe(target, res, 0, range);
}

// Some engines (seen on Construct3's audio worker) fetch their own asset
// files with a Range header for streaming/seeking and choke on getting back
// a full 200 response instead of the 206 Partial Content they asked for --
// forwarding Range through, and passing the upstream's 206/Content-Range
// back, keeps that contract intact instead of always serving the whole file.
function fetchAndPipe(url, res, redirectCount, range){
  const parsedUrl = new URL(url);
  const headers = {};
  if (range) headers.Range = range;
  https.get(parsedUrl, { headers }, (upstream) => {
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location && redirectCount < 5){
      const next = new URL(upstream.headers.location, url).href;
      upstream.resume();
      fetchAndPipe(next, res, redirectCount + 1, range);
      return;
    }
    const outHeaders = {};
    if (upstream.headers["content-type"]) outHeaders["Content-Type"] = upstream.headers["content-type"];
    if (upstream.headers["content-length"]) outHeaders["Content-Length"] = upstream.headers["content-length"];
    if (upstream.headers["content-range"]) outHeaders["Content-Range"] = upstream.headers["content-range"];
    if (upstream.headers["accept-ranges"]) outHeaders["Accept-Ranges"] = upstream.headers["accept-ranges"];
    // Range responses are per-request slices of the file -- letting
    // Cloudflare/browsers cache them under the plain asset URL (no Vary on
    // Range) is exactly how a 200-vs-206 mismatch like this one happens
    // again later, serving a stale/wrong slice to a different range ask.
    outHeaders["Cache-Control"] = "no-store";
    // Unity WebGL builds (seen in GameDistribution-sourced games) serve
    // their data/wasm files gzip-encoded and rely on the browser to
    // decompress via this header -- without forwarding it the piped bytes
    // decode as garbage.
    if (upstream.headers["content-encoding"]) outHeaders["Content-Encoding"] = upstream.headers["content-encoding"];
    res.writeHead(upstream.statusCode || 200, outHeaders);
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
      // Same reasoning as the asset proxy: a broken embed URL fixed at the
      // origin should never keep getting served stale from an edge/browser
      // cache -- this exact thing already happened once with Level Devil.
      "Cache-Control": "no-store",
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
    proxyAsset(decodeURIComponent(playAssetMatch[1]), playAssetMatch[2], search, res, refMatch && decodeURIComponent(refMatch[1]), req.headers.range);
    return;
  }

  if (urlPath === "/api/votes" && req.method === "GET"){
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(votes));
    return;
  }

  if (urlPath === "/api/vote" && req.method === "POST"){
    readJsonBody(req, 2048, (err, body) => {
      if (err){ res.writeHead(400); res.end(); return; }
      const { gameId, prevVote, newVote } = body || {};
      const validVote = (v) => v === null || v === "up" || v === "down";
      if (typeof gameId !== "string" || !findGame(gameId) || !validVote(prevVote) || !validVote(newVote)){
        res.writeHead(400); res.end(); return;
      }
      const updated = applyVoteDelta(gameId, prevVote, newVote);
      saveVotes();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(updated));
    });
    return;
  }

  if (urlPath === "/api/heartbeat" && req.method === "POST"){
    readJsonBody(req, 512, (err, body) => {
      if (err){ res.writeHead(400); res.end(); return; }
      const { gameId, sessionId } = body || {};
      if (typeof gameId !== "string" || typeof sessionId !== "string" || !findGame(gameId)){
        res.writeHead(400); res.end(); return;
      }
      touchPresence(gameId, sessionId);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ count: liveCountFor(gameId) }));
    });
    return;
  }

  if (urlPath === "/api/leave" && req.method === "POST"){
    // sendBeacon (used on tab close) posts a Blob with no guarantee the
    // browser sets a JSON content-type, but the body itself is still the
    // same JSON string, so parsing doesn't need to branch on it.
    readJsonBody(req, 512, (err, body) => {
      if (err){ res.writeHead(400); res.end(); return; }
      const { gameId, sessionId } = body || {};
      if (typeof gameId !== "string" || typeof sessionId !== "string"){
        res.writeHead(400); res.end(); return;
      }
      removePresence(gameId, sessionId);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ count: liveCountFor(gameId) }));
    });
    return;
  }

  if (urlPath === "/api/live-counts" && req.method === "GET"){
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(allLiveCounts()));
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
    // games.json changes independently of any deploy (games get added or
    // removed), so it gets a short cache instead of the old 1-hour one
    // that made removals take up to an hour to show up for visitors.
    const cacheControl = filePath === "/index.html"
      ? "no-cache"
      : (ext === ".css" || ext === ".js") ? "public, max-age=31536000, immutable"
      : filePath === "/assets/games.json" ? "public, max-age=60"
      : "public, max-age=3600";
    res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream", "Cache-Control": cacheControl });
    res.end(data);
  });
}).listen(port, () => console.log("Serving on http://localhost:" + port));
