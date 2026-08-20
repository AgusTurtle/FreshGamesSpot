// Finds games whose top-level HTML embeds the real game via a nested
// <iframe src="https://some-other-domain/..."> pointing at a host our CSP's
// frame-src doesn't allow -- the browser silently (from our POV) blocks that
// frame and the player shows Chrome's "This content is blocked" placeholder,
// even though the top HTML itself fetched fine (so validate-games.js doesn't
// catch it). Reports every game where that nested host isn't already an
// allowed one, and tallies which external hosts show up most so we can
// decide whether to allowlist them or drop the games.
const fs = require("fs");
const path = require("path");

const gamesPath = path.join(__dirname, "assets", "games.json");
const games = JSON.parse(fs.readFileSync(gamesPath, "utf8").replace(/^﻿/, ""));

const ALLOWED_HOST_SUFFIXES = [
  "html5.gamemonetize.co", "gamemonetize.co", "gamemonetize.games",
  "api.gamemonetize.com", "gamemonetize.com", "yyggames.com",
  "babygames.com", "unity3d.com", "gamedistribution.com",
];

function isAllowedHost(host){
  return ALLOWED_HOST_SUFFIXES.some(suf => host === suf || host.endsWith("." + suf));
}

const CONCURRENCY = 24;
const TIMEOUT_MS = 12000;
const IFRAME_SRC_RE = /<iframe[^>]+src=["']([^"']+)["']/gi;

async function checkOne(game){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(game.url, { signal: controller.signal, redirect: "follow" });
    const text = await res.text();
    clearTimeout(timer);
    if (!res.ok) return null; // already caught by validate-games.js
    let m;
    while ((m = IFRAME_SRC_RE.exec(text))){
      let host;
      try { host = new URL(m[1], game.url).hostname; } catch (e){ continue; }
      if (!isAllowedHost(host)){
        return { id: game.id, title: game.title, blockedHost: host };
      }
    }
    return null;
  } catch (e){
    clearTimeout(timer);
    return null; // network errors already caught by validate-games.js
  }
}

async function run(){
  const flagged = [];
  let idx = 0;
  let done = 0;
  async function worker(){
    while (idx < games.length){
      const i = idx++;
      const result = await checkOne(games[i]);
      done++;
      if (result) flagged.push(result);
      if (done % 300 === 0) console.error(`checked ${done}/${games.length}...`);
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, worker));
  console.log(JSON.stringify(flagged, null, 2));
  const tally = {};
  flagged.forEach(f => { tally[f.blockedHost] = (tally[f.blockedHost]||0) + 1; });
  console.error("\nHost tally:", JSON.stringify(tally, null, 2));
  console.error(`Done. ${flagged.length} games embed a non-allowed iframe host out of ${games.length}.`);
}

run();
