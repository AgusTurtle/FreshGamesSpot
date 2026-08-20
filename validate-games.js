// One-off maintenance script: checks that every game's source URL actually
// resolves (HTTP 200, non-empty HTML) before we trust it enough to list on
// the site. Not wired into serve.js -- run manually, review the report,
// then delete the flagged entries from assets/games.json by hand.
const fs = require("fs");
const path = require("path");

const gamesPath = path.join(__dirname, "assets", "games.json");
const games = JSON.parse(fs.readFileSync(gamesPath, "utf8").replace(/^﻿/, ""));

const CONCURRENCY = 24;
const TIMEOUT_MS = 12000;

async function checkOne(game){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(game.url, { signal: controller.signal, redirect: "follow" });
    const text = await res.text();
    clearTimeout(timer);
    if (!res.ok){
      return { id: game.id, title: game.title, status: res.status, reason: "http_" + res.status };
    }
    if (text.length < 200 || !/<html|<HTML/.test(text)){
      return { id: game.id, title: game.title, status: res.status, reason: "empty_or_non_html" };
    }
    return null;
  } catch (e){
    clearTimeout(timer);
    return { id: game.id, title: game.title, status: 0, reason: e.name === "AbortError" ? "timeout" : "fetch_error:" + e.message };
  }
}

async function run(){
  const broken = [];
  let idx = 0;
  let done = 0;
  async function worker(){
    while (idx < games.length){
      const i = idx++;
      const result = await checkOne(games[i]);
      done++;
      if (result) broken.push(result);
      if (done % 200 === 0) console.error(`checked ${done}/${games.length}...`);
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, worker));
  console.log(JSON.stringify(broken, null, 2));
  console.error(`\nDone. ${broken.length} broken out of ${games.length}.`);
}

run();
