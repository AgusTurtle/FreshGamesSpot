const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

// ---------- Accounts (persisted, same volume/ephemeral caveat as votes above) ----------
// (deploy marker: volume-persistence check)
// No real session/cookie layer -- the client re-sends { email, passwordHash }
// on every account request (passwordHash computed client-side via
// SubtleCrypto, plaintext password never leaves the browser) and this
// checks it against the stored hash each time, closer in spirit to HTTP
// Basic auth than a token session. Good enough for a game portal's
// favorites list, not a substitute for a real auth provider.
const ACCOUNTS_PATH = path.join(DATA_DIR, "accounts.json");
function loadAccounts(){
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e){}
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8").replace(/^﻿/, "")); }
  catch (e){ return {}; }
}
let accounts = loadAccounts();
function saveAccounts(){
  try { fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts)); }
  catch (e){ console.error("Could not persist accounts:", e.message); }
}
// Password accounts and OAuth accounts (Google, later maybe Discord/Steam)
// share the same accounts.json entry shape, just with only one of
// passwordHash/oauthToken ever populated -- checkAuth accepts whichever
// credential the client actually has for that account.
function checkAuth(email, passwordHash, oauthToken){
  const acct = accounts[email];
  if (!acct) return null;
  if (passwordHash && acct.passwordHash) return acct.passwordHash === passwordHash ? acct : false;
  if (oauthToken && acct.oauthToken) return acct.oauthToken === oauthToken ? acct : false;
  return false;
}

// Calendar-day visit streak (UTC) -- called once per successful auth
// (register, login, session-resume, Google) so it advances at most once
// per real day regardless of how many requests that day makes. Same day
// as last visit: untouched. Exactly the next day: streak continues.
// Any bigger gap (or first-ever visit): streak resets to 1.
function todayUTC(){
  return new Date().toISOString().slice(0, 10);
}
function touchStreak(acct){
  const today = todayUTC();
  if (acct.lastVisitDate === today) return;
  if (acct.lastVisitDate){
    const prev = new Date(acct.lastVisitDate + "T00:00:00Z");
    const diffDays = Math.round((new Date(today + "T00:00:00Z") - prev) / 86400000);
    acct.streak = diffDays === 1 ? (acct.streak || 0) + 1 : 1;
  } else {
    acct.streak = 1;
  }
  acct.lastVisitDate = today;
  acct.bestStreak = Math.max(acct.bestStreak || 0, acct.streak);
}

// Missions: one-time achievements that award points. Completing one is
// permanent -- acct.completedMissions (a list of ids) is only ever added
// to, so e.g. unstarring games back below a threshold never takes points
// away. check() reads whatever the account already tracks; nothing here
// needs its own separate counter beyond gamePlays (bumped by
// /api/account/play, called once per game session start).
//
// Can't see inside a game's own canvas (these are third-party iframes
// with no shared postMessage protocol), so "reach 300 points in X" isn't
// something the server can ever verify -- the closest honest equivalent
// is play-count. Rather than a fixed list that runs out, each game gets
// an escalating ladder of tiers (MISSION_TIERS); accountPayload only
// ever surfaces the next not-yet-done tier per game, so completing one
// immediately reveals a harder one for the same game instead of the
// list going stale.
const MISSION_GAMES = [
  { gameId: "ext-crossy-road", title: "Crossy Road" },
  { gameId: "ext-shellshockers", title: "Shell Shockers" },
  { gameId: "ext-8-ball-pool", title: "8 Ball Pool" },
  { gameId: "gd-rooftop-snipers", title: "Rooftop Snipers" },
  { gameId: "ext-bloxd-io", title: "Bloxd.io" },
  { gameId: "ext-suika-game", title: "Suika Game" },
  { gameId: "ext-krunker", title: "Krunker.io" },
  { gameId: "ext-bonk", title: "Bonk.io" },
];
const MISSION_TIERS = [
  { count: 1, points: 10 },
  { count: 5, points: 25 },
  { count: 15, points: 40 },
  { count: 30, points: 65 },
  { count: 60, points: 100 },
  { count: 100, points: 150 },
  { count: 200, points: 250 },
];
const MISSIONS = [];
for (const g of MISSION_GAMES){
  MISSION_TIERS.forEach((tier) => {
    MISSIONS.push({
      id: `play_${g.gameId}_${tier.count}`,
      gameId: g.gameId,
      count: tier.count,
      points: tier.points,
      label: tier.count === 1 ? `Jugá a ${g.title}` : `Jugá ${tier.count} veces a ${g.title}`,
      check: (a) => ((a.gamePlays || {})[g.gameId] || 0) >= tier.count,
    });
  });
}
function recomputeMissions(acct){
  if (!acct.completedMissions) acct.completedMissions = [];
  for (const m of MISSIONS){
    if (!acct.completedMissions.includes(m.id) && m.check(acct)){
      acct.completedMissions.push(m.id);
      acct.points = (acct.points || 0) + m.points;
    }
  }
}
// The one row per game that's actually worth showing right now: the
// next tier not yet completed, or (once every tier is cleared) the last
// one, marked done. `acct` may be null for a logged-out visitor -- same
// shape, just nothing completed and zero plays.
function currentMissionRows(acct){
  const completed = new Set((acct && acct.completedMissions) || []);
  return MISSION_GAMES.map((g) => {
    const tiers = MISSIONS.filter((m) => m.gameId === g.gameId);
    const next = tiers.find((m) => !completed.has(m.id));
    const current = next || tiers[tiers.length - 1];
    const plays = (acct && acct.gamePlays && acct.gamePlays[g.gameId]) || 0;
    return {
      id: current.id,
      gameId: g.gameId,
      label: current.label,
      points: current.points,
      done: completed.has(current.id),
      progress: Math.min(plays, current.count),
      target: current.count,
    };
  });
}

function accountPayload(acct, extra){
  recomputeMissions(acct);
  return Object.assign({
    username: acct.username || null,
    avatar: acct.avatar || null,
    favorites: acct.favorites,
    createdAt: acct.createdAt || null,
    streak: acct.streak || 1,
    bestStreak: acct.bestStreak || 1,
    points: acct.points || 0,
    missions: currentMissionRows(acct),
  }, extra || {});
}

function httpsGetJson(url){
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e){ reject(e); }
      });
    }).on("error", reject);
  });
}

// Google's ID token (the "credential" the client gets back from Google
// Identity Services) is a signed JWT -- rather than verifying the
// signature ourselves, we hand it to Google's own tokeninfo endpoint and
// let them do it; a valid response with our own client ID in `aud` and
// `email_verified: "true"` is as trustworthy as checking the signature
// locally, without needing a JWT library.
const GOOGLE_CLIENT_ID = "120779948196-6o78huetsa3rjposubl20nuu36qsbv4d.apps.googleusercontent.com";
async function verifyGoogleCredential(credential){
  let res;
  try { res = await httpsGetJson("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential)); }
  catch (e){ return null; }
  const body = res.body || {};
  if (res.status !== 200 || body.aud !== GOOGLE_CLIENT_ID || body.email_verified !== "true" || !body.email) return null;
  return body.email;
}

// Discord doesn't have a client-side one-tap SDK like Google's -- it's a
// classic redirect-based OAuth2 authorization-code flow: our button sends
// the browser to Discord's /authorize page, Discord redirects back to our
// own /api/auth/discord/callback with a `code`, and the server (the only
// place that ever sees DISCORD_CLIENT_SECRET) exchanges that code for an
// access token and then fetches the user's identity with it.
// Unlike GOOGLE_CLIENT_ID above (safe to ship in client-side code -- it
// identifies the app, not a secret), DISCORD_CLIENT_SECRET can mint tokens
// on the app's behalf, and this repo is public. Both live only as Railway
// environment variables, never committed -- see README/deploy notes.
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI = "https://freshgamespot.net/api/auth/discord/callback";

// Short-lived `state` values, checked on callback so a link to our own
// callback URL can't be replayed to log a victim into an attacker-chosen
// Discord account (a CSRF on the login itself).
const discordStates = new Map(); // state -> expiry ms
function makeDiscordState(){
  const state = crypto.randomBytes(16).toString("hex");
  discordStates.set(state, Date.now() + 5 * 60 * 1000);
  return state;
}
function consumeDiscordState(state){
  const exp = discordStates.get(state);
  if (state) discordStates.delete(state);
  return typeof state === "string" && !!exp && exp > Date.now();
}

function httpsPostForm(urlStr, formObj){
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(formObj).toString();
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e){ reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpsGetJsonAuth(urlStr, token){
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { Authorization: "Bearer " + token },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e){ reject(e); }
      });
    }).on("error", reject);
  });
}

// Exchanges the callback `code` for the user's email, the same way
// verifyGoogleCredential resolves a Google credential to an email.
// Returns null on any failure (bad code, no verified email, network error).
async function resolveDiscordCode(code){
  let tokenRes;
  try {
    tokenRes = await httpsPostForm("https://discord.com/api/oauth2/token", {
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: DISCORD_REDIRECT_URI,
    });
  } catch (e){ return null; }
  const accessToken = tokenRes.body && tokenRes.body.access_token;
  if (tokenRes.status !== 200 || !accessToken) return null;

  let userRes;
  try { userRes = await httpsGetJsonAuth("https://discord.com/api/users/@me", accessToken); }
  catch (e){ return null; }
  const user = userRes.body || {};
  if (userRes.status !== 200 || !user.email || !user.verified) return null;
  return user.email;
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
    // Custom self-hosted wrapper pages (Getaway Shootout, Temple of Boom)
    // point game.url at our own /assets/*.html wrapper, not the real
    // upstream game -- assetBase lets those wrappers reference their
    // upstream's Build/ assets by relative path (routed same-origin
    // through this proxy, sidestepping a non-CORS upstream) without
    // resolving against the wrapper's own freshgamespot.net location.
    target = new URL(assetPath + (search || ""), game.assetBase || game.url).href;
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

  if (urlPath === "/api/account/auth" && req.method === "POST"){
    readJsonBody(req, 2048, (err, body) => {
      if (err){ res.writeHead(400); res.end(); return; }
      const { email, passwordHash, oauthToken } = body || {};
      if (typeof email !== "string" || !email.includes("@")){
        res.writeHead(400); res.end(); return;
      }
      // oauthToken re-auth (resuming a Google session on page load) never
      // auto-creates -- only the verified /api/account/google flow may
      // create an oauth-linked account, or anyone could invent a token
      // and claim someone else's email.
      if (typeof oauthToken === "string"){
        const acct = checkAuth(email, undefined, oauthToken);
        if (!acct){ res.writeHead(401); res.end(); return; }
        touchStreak(acct);
        recomputeMissions(acct);
        saveAccounts();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(accountPayload(acct)));
        return;
      }
      if (typeof passwordHash !== "string" || passwordHash.length !== 64){
        res.writeHead(400); res.end(); return;
      }
      const existing = checkAuth(email, passwordHash);
      if (existing === false){
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Contraseña incorrecta." }));
        return;
      }
      if (existing === null){
        accounts[email] = { passwordHash, favorites: [], createdAt: Date.now() };
      }
      touchStreak(accounts[email]);
      recomputeMissions(accounts[email]);
      saveAccounts();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(accountPayload(accounts[email])));
    });
    return;
  }

  if (urlPath === "/api/account/username" && req.method === "POST"){
    readJsonBody(req, 2048, (err, body) => {
      if (err){ res.writeHead(400); res.end(); return; }
      const { email, passwordHash, oauthToken, username } = body || {};
      if (typeof email !== "string" || typeof username !== "string"){
        res.writeHead(400); res.end(); return;
      }
      const clean = username.trim();
      // Same 6-20 chars, letters/numbers/./_ rule the client checks live --
      // re-checked here since the client's validation is just UX, not security.
      if (!/^[a-zA-Z0-9._]{6,20}$/.test(clean)){ res.writeHead(400); res.end(); return; }
      if (!checkAuth(email, passwordHash, oauthToken)){ res.writeHead(401); res.end(); return; }
      accounts[email].username = clean;
      saveAccounts();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, username: clean }));
    });
    return;
  }

  if (urlPath === "/api/account/avatar" && req.method === "POST"){
    // Custom avatars are stored as data: URIs straight in accounts.json --
    // no image host/CDN in this stack to upload to, and the client
    // already downscales to a small square canvas before sending, so a
    // data URI stays well under this limit. avatar: null resets to the
    // default site-icon avatar.
    readJsonBody(req, 400000, (err, body) => {
      if (err){ res.writeHead(400); res.end(); return; }
      const { email, passwordHash, oauthToken, avatar } = body || {};
      if (typeof email !== "string"){ res.writeHead(400); res.end(); return; }
      if (avatar !== null && (typeof avatar !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(avatar))){
        res.writeHead(400); res.end(); return;
      }
      if (!checkAuth(email, passwordHash, oauthToken)){ res.writeHead(401); res.end(); return; }
      accounts[email].avatar = avatar;
      saveAccounts();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (urlPath === "/api/account/google" && req.method === "POST"){
    readJsonBody(req, 4096, async (err, body) => {
      if (err){ res.writeHead(400); res.end(); return; }
      const { credential } = body || {};
      if (typeof credential !== "string"){ res.writeHead(400); res.end(); return; }
      const email = await verifyGoogleCredential(credential);
      if (!email){
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "No se pudo verificar la cuenta de Google." }));
        return;
      }
      const oauthToken = crypto.randomBytes(24).toString("hex");
      if (!accounts[email]) accounts[email] = { favorites: [], createdAt: Date.now() };
      accounts[email].oauthToken = oauthToken;
      touchStreak(accounts[email]);
      recomputeMissions(accounts[email]);
      saveAccounts();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(accountPayload(accounts[email], { email, oauthToken })));
    });
    return;
  }

  // Step 1 of the Discord OAuth2 redirect flow: send the browser to
  // Discord's own consent screen. This is a plain link (GET, no CSP/CORS
  // issue like a popup would have), not a fetch() call from app.js.
  if (urlPath === "/api/auth/discord/start" && req.method === "GET"){
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET){
      res.writeHead(302, { Location: "/?discordError=1" });
      res.end();
      return;
    }
    const state = makeDiscordState();
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: DISCORD_REDIRECT_URI,
      response_type: "code",
      scope: "identify email",
      state,
    });
    res.writeHead(302, { Location: "https://discord.com/api/oauth2/authorize?" + params.toString() });
    res.end();
    return;
  }

  // Step 2: Discord redirects the browser back here with a `code`. We
  // exchange it server-side (the only place holding the client secret),
  // then hand the resulting oauthToken back to the page via a query
  // param -- app.js picks it up on load, stores the session, and cleans
  // the URL. Same end state as the Google flow, just reached by a
  // redirect round-trip instead of a JS callback.
  if (urlPath === "/api/auth/discord/callback" && req.method === "GET"){
    (async () => {
      const q = new URLSearchParams(search);
      const code = q.get("code");
      const state = q.get("state");
      if (!code || !consumeDiscordState(state)){
        res.writeHead(302, { Location: "/?discordError=1" });
        res.end();
        return;
      }
      const email = await resolveDiscordCode(code);
      if (!email){
        res.writeHead(302, { Location: "/?discordError=1" });
        res.end();
        return;
      }
      const oauthToken = crypto.randomBytes(24).toString("hex");
      if (!accounts[email]) accounts[email] = { favorites: [], createdAt: Date.now() };
      accounts[email].oauthToken = oauthToken;
      touchStreak(accounts[email]);
      saveAccounts();
      const redirectParams = new URLSearchParams({ discordToken: oauthToken, discordEmail: email });
      res.writeHead(302, { Location: "/?" + redirectParams.toString() });
      res.end();
    })();
    return;
  }

  if (urlPath === "/api/account/favorites" && req.method === "POST"){
    readJsonBody(req, 8192, (err, body) => {
      if (err){ res.writeHead(400); res.end(); return; }
      const { email, passwordHash, oauthToken, favorites } = body || {};
      if (typeof email !== "string" || !Array.isArray(favorites)){
        res.writeHead(400); res.end(); return;
      }
      if (!checkAuth(email, passwordHash, oauthToken)){
        res.writeHead(401); res.end(); return;
      }
      accounts[email].favorites = favorites.filter(f => typeof f === "string").slice(0, 500);
      recomputeMissions(accounts[email]);
      saveAccounts();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Called once when a logged-in player actually opens a game (not on
  // every heartbeat) -- feeds the play-count/distinct-games missions
  // above. Silently ignored for anonymous play, same as favorites.
  if (urlPath === "/api/account/play" && req.method === "POST"){
    readJsonBody(req, 2048, (err, body) => {
      if (err){ res.writeHead(400); res.end(); return; }
      const { email, passwordHash, oauthToken, gameId } = body || {};
      if (typeof email !== "string" || typeof gameId !== "string"){
        res.writeHead(400); res.end(); return;
      }
      if (!checkAuth(email, passwordHash, oauthToken)){
        res.writeHead(401); res.end(); return;
      }
      const acct = accounts[email];
      if (!acct.playedGames) acct.playedGames = [];
      if (!acct.playedGames.includes(gameId)) acct.playedGames.push(gameId);
      acct.totalPlays = (acct.totalPlays || 0) + 1;
      if (!acct.gamePlays) acct.gamePlays = {};
      acct.gamePlays[gameId] = (acct.gamePlays[gameId] || 0) + 1;
      recomputeMissions(acct);
      saveAccounts();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(accountPayload(acct)));
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

  // Public ranking -- ?by=points sorts by mission points (ties broken by
  // bestStreak); anything else (the default) sorts by bestStreak (ties
  // broken by the current streak). Only ever exposes username, avatar and
  // the relevant numbers -- never an email, and accounts that never set a
  // username (so have nothing safe/identifying to show) are excluded
  // rather than leaking their address.
  if (urlPath === "/api/leaderboard" && req.method === "GET"){
    const by = new URLSearchParams(search).get("by") === "points" ? "points" : "streak";
    const rows = Object.values(accounts)
      .filter((acct) => acct.username)
      .map((acct) => {
        recomputeMissions(acct);
        return {
          username: acct.username,
          avatar: acct.avatar || null,
          streak: acct.streak || 1,
          bestStreak: acct.bestStreak || 1,
          points: acct.points || 0,
        };
      })
      .sort(by === "points"
        ? (a, b) => (b.points - a.points) || (b.bestStreak - a.bestStreak)
        : (a, b) => (b.bestStreak - a.bestStreak) || (b.streak - a.streak))
      .slice(0, 20);
    saveAccounts();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(rows));
    return;
  }

  // The tier-1 row for every game (no account, so nothing's completed
  // yet) -- lets the Misiones overlay show what's available to a
  // logged-out visitor too, instead of only working once signed in.
  if (urlPath === "/api/missions" && req.method === "GET"){
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(currentMissionRows(null)));
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
