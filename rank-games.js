const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "assets", "games.json");
const games = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));

function popularityScore(tags){
  const t = (tags || "").toLowerCase();
  let score = 0;
  if (t.includes("hot")) score += 3;
  if (t.includes("best games")) score += 3;
  if (t.includes("best") && !t.includes("best games")) score += 2;
  if (t.includes("trending")) score += 3;
  if (t.includes("popular")) score += 3;
  if (t.includes("top")) score += 1;
  if (t.includes("editors")) score += 2;
  if (t.includes("exclusive")) score += 1;
  return score;
}

games.forEach(g => { g.popularity = popularityScore(g.tags); });

// stable sort: ties keep original relative order
const ranked = games
  .map((g, i) => ({ g, i }))
  .sort((a, b) => (b.g.popularity - a.g.popularity) || (a.i - b.i))
  .map(x => x.g);

const popularCount = ranked.filter(g => g.popularity > 0).length;
console.log("Games with popularity signal:", popularCount, "/", ranked.length);

fs.writeFileSync(file, JSON.stringify(ranked, null, 2), "utf8");
console.log("Saved re-ranked games.json");
