(function(){
  "use strict";

  const PAGE_SIZE = 24;
  const RAIL_SIZE = 14;
  const FAV_KEY = "omg_favorites";
  const RECENT_KEY = "omg_recent";
  const VOTES_KEY = "omg_votes";
  const POPULAR_CAT = "Populares";

  let GAMES = [];
  let filtered = [];
  let visibleCount = PAGE_SIZE;
  let activeCategory = "Todos";
  let searchTerm = "";

  const el = {
    grid: document.getElementById("gameGrid"),
    gridSection: document.getElementById("gridSection"),
    homeSections: document.getElementById("homeSections"),
    catNav: document.getElementById("catNav"),
    searchInput: document.getElementById("searchInput"),
    clearSearch: document.getElementById("clearSearch"),
    sectionTitle: document.getElementById("sectionTitle"),
    resultCount: document.getElementById("resultCount"),
    emptyState: document.getElementById("emptyState"),
    loadMoreBtn: document.getElementById("loadMoreBtn"),
    continueSection: document.getElementById("continueSection"),
    continueRow: document.getElementById("continueRow"),
    favToggleNav: document.getElementById("favToggleNav"),
    overlay: document.getElementById("playerOverlay"),
    playerFrame: document.getElementById("playerFrame"),
    playerTitle: document.getElementById("playerTitle"),
    playerDescription: document.getElementById("playerDescription"),
    playerTags: document.getElementById("playerTags"),
    playerLoading: document.getElementById("playerLoading"),
    playerBack: document.getElementById("playerBack"),
    playerClose: document.getElementById("playerClose"),
    playerFullscreen: document.getElementById("playerFullscreen"),
    playerFav: document.getElementById("playerFav"),
  };

  /* ---------- storage helpers ---------- */
  function getFavorites(){
    try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; }
    catch(e){ return []; }
  }
  function setFavorites(list){
    localStorage.setItem(FAV_KEY, JSON.stringify(list));
  }
  function isFavorite(id){
    return getFavorites().includes(id);
  }
  function toggleFavorite(id){
    let favs = getFavorites();
    if (favs.includes(id)) favs = favs.filter(f => f !== id);
    else favs.push(id);
    setFavorites(favs);
    return favs.includes(id);
  }
  function getRecent(){
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
    catch(e){ return []; }
  }
  function getVotes(){
    try { return JSON.parse(localStorage.getItem(VOTES_KEY)) || {}; }
    catch(e){ return {}; }
  }
  function getVote(id){
    return getVotes()[id] || null;
  }
  function toggleVote(id, dir){
    const votes = getVotes();
    votes[id] = votes[id] === dir ? null : dir;
    localStorage.setItem(VOTES_KEY, JSON.stringify(votes));
    return votes[id];
  }
  function pushRecent(id){
    let recent = getRecent().filter(r => r !== id);
    recent.unshift(id);
    recent = recent.slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  }

  /* ---------- data ---------- */
  function findGame(id){
    return GAMES.find(g => g.id === id);
  }

  function buildCategories(){
    const counts = {};
    GAMES.forEach(g => { counts[g.category] = (counts[g.category]||0) + 1; });
    const cats = Object.keys(counts).sort((a,b) => counts[b]-counts[a]);
    const frag = document.createDocumentFragment();

    const popularCount = GAMES.filter(g => g.popularity > 0).length;
    if (popularCount > 0){
      frag.appendChild(makePill(POPULAR_CAT, popularCount, false, "🔥 Populares"));
    }

    const allPill = makePill("Todos", GAMES.length, true);
    frag.appendChild(allPill);

    cats.forEach(c => frag.appendChild(makePill(c, counts[c], false)));
    el.catNav.appendChild(frag);
  }

  function makePill(name, count, active, label){
    const btn = document.createElement("button");
    btn.className = "cat-pill" + (active ? " active" : "");
    btn.textContent = `${label || name} (${count})`;
    btn.dataset.cat = name;
    btn.addEventListener("click", () => selectCategory(name));
    return btn;
  }

  function selectCategory(name){
    activeCategory = name;
    document.querySelectorAll(".cat-pill").forEach(p => {
      p.classList.toggle("active", p.dataset.cat === name);
    });
    el.sectionTitle.textContent = name === "Todos" ? "Todos los juegos"
      : name === POPULAR_CAT ? "🔥 Populares"
      : name;
    updateView();
    window.scrollTo({top:0, behavior:"smooth"});
  }

  function isHomeView(){
    return activeCategory === "Todos" && !searchTerm;
  }

  function updateView(){
    if (isHomeView()){
      el.gridSection.hidden = true;
      el.homeSections.hidden = false;
      renderHomeSections();
    } else {
      el.homeSections.hidden = true;
      el.gridSection.hidden = false;
      applyFilters();
    }
    renderContinue();
  }

  function applyFilters(){
    visibleCount = PAGE_SIZE;
    let list = GAMES;
    if (activeCategory === POPULAR_CAT){
      list = list.filter(g => g.popularity > 0);
    } else if (activeCategory !== "Todos"){
      list = list.filter(g => g.category === activeCategory);
    }
    if (searchTerm){
      const q = searchTerm.toLowerCase();
      list = list.filter(g =>
        g.title.toLowerCase().includes(q) ||
        (g.tags && g.tags.toLowerCase().includes(q))
      );
    }
    filtered = list;
    render();
  }

  /* ---------- rendering ---------- */
  function makeCard(game, small){
    const card = document.createElement("div");
    card.className = "game-card";
    card.dataset.id = game.id;

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "game-thumb-wrap";

    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = game.thumb;
    img.alt = game.title;
    img.onerror = () => {
      img.onerror = null;
      thumbWrap.classList.add("thumb-fallback");
      img.remove();
      const label = document.createElement("span");
      label.className = "thumb-fallback-label";
      label.textContent = game.title;
      thumbWrap.prepend(label);
    };
    thumbWrap.appendChild(img);

    const playBadge = document.createElement("div");
    playBadge.className = "play-badge";
    playBadge.innerHTML = "<span>▶</span>";
    thumbWrap.appendChild(playBadge);

    const favBtn = document.createElement("button");
    favBtn.className = "fav-star" + (isFavorite(game.id) ? " active" : "");
    favBtn.textContent = "★";
    favBtn.title = "Favorito";
    favBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const active = toggleFavorite(game.id);
      favBtn.classList.toggle("active", active);
    });
    thumbWrap.appendChild(favBtn);

    card.appendChild(thumbWrap);

    const info = document.createElement("div");
    info.className = "game-info";
    const title = document.createElement("p");
    title.className = "game-title";
    title.textContent = game.title;
    const cat = document.createElement("p");
    cat.className = "game-cat";
    cat.textContent = game.category;
    info.appendChild(title);
    info.appendChild(cat);
    card.appendChild(info);

    card.appendChild(makeVoteRow(game.id));

    card.addEventListener("click", () => openGame(game.id));
    return card;
  }

  function makeVoteRow(gameId){
    const row = document.createElement("div");
    row.className = "card-votes";

    const upBtn = document.createElement("button");
    upBtn.className = "vote-btn up";
    upBtn.innerHTML = '<span class="vote-icon">👍</span><span class="vote-count"></span>';

    const downBtn = document.createElement("button");
    downBtn.className = "vote-btn down";
    downBtn.innerHTML = '<span class="vote-icon">👎</span><span class="vote-count"></span>';

    function refresh(){
      const v = getVote(gameId);
      upBtn.classList.toggle("active", v === "up");
      upBtn.querySelector(".vote-count").textContent = v === "up" ? "1" : "0";
      downBtn.classList.toggle("active", v === "down");
      downBtn.querySelector(".vote-count").textContent = v === "down" ? "1" : "0";
    }

    upBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleVote(gameId, "up"); refresh(); });
    downBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleVote(gameId, "down"); refresh(); });

    refresh();
    row.appendChild(upBtn);
    row.appendChild(downBtn);
    return row;
  }

  function render(){
    el.grid.innerHTML = "";
    const slice = filtered.slice(0, visibleCount);

    if (filtered.length === 0){
      el.emptyState.hidden = false;
      el.loadMoreBtn.hidden = true;
      el.resultCount.textContent = "";
      return;
    }
    el.emptyState.hidden = true;

    const frag = document.createDocumentFragment();
    slice.forEach(g => frag.appendChild(makeCard(g)));
    el.grid.appendChild(frag);

    el.resultCount.textContent = `${filtered.length} juego${filtered.length===1?"":"s"}`;
    el.loadMoreBtn.hidden = visibleCount >= filtered.length;

    renderContinue();
  }

  function renderContinue(){
    if (searchTerm || activeCategory !== "Todos"){
      el.continueSection.hidden = true;
      return;
    }
    const recentIds = getRecent();
    const recentGames = recentIds.map(findGame).filter(Boolean);
    if (recentGames.length === 0){
      el.continueSection.hidden = true;
      return;
    }
    el.continueSection.hidden = false;
    el.continueRow.innerHTML = "";
    const frag = document.createDocumentFragment();
    recentGames.forEach(g => frag.appendChild(makeCard(g)));
    el.continueRow.appendChild(frag);
  }

  function makeRail(label, catName, games){
    const section = document.createElement("section");
    section.className = "rail";

    const header = document.createElement("div");
    header.className = "rail-header";

    const h2 = document.createElement("h2");
    h2.className = "rail-title";
    h2.textContent = `${label} (${games.length})`;
    header.appendChild(h2);

    const more = document.createElement("button");
    more.className = "rail-more";
    more.textContent = "Ver todos →";
    more.addEventListener("click", () => selectCategory(catName));
    header.appendChild(more);

    section.appendChild(header);

    const row = document.createElement("div");
    row.className = "rail-row";
    games.slice(0, RAIL_SIZE).forEach(g => row.appendChild(makeCard(g)));
    section.appendChild(row);

    return section;
  }

  function renderHomeSections(){
    el.homeSections.innerHTML = "";
    const frag = document.createDocumentFragment();

    const popular = GAMES.filter(g => g.popularity > 0);
    if (popular.length){
      frag.appendChild(makeRail("🔥 Populares", POPULAR_CAT, popular));
    }

    const counts = {};
    GAMES.forEach(g => { counts[g.category] = (counts[g.category]||0) + 1; });
    const cats = Object.keys(counts).sort((a,b) => counts[b]-counts[a]);
    cats.forEach(cat => {
      frag.appendChild(makeRail(cat, cat, GAMES.filter(g => g.category === cat)));
    });

    el.homeSections.appendChild(frag);
  }

  function renderFavoritesView(){
    activeCategory = "Todos";
    searchTerm = "";
    el.searchInput.value = "";
    el.clearSearch.hidden = true;
    document.querySelectorAll(".cat-pill").forEach(p => p.classList.remove("active"));
    el.sectionTitle.textContent = "Mis favoritos";
    visibleCount = PAGE_SIZE;
    const favIds = getFavorites();
    filtered = favIds.map(findGame).filter(Boolean).reverse();
    el.homeSections.hidden = true;
    el.gridSection.hidden = false;
    render();
    el.continueSection.hidden = true;
  }

  /* ---------- player ---------- */
  function openGame(id){
    const game = findGame(id);
    if (!game) return;
    pushRecent(id);

    el.playerTitle.textContent = game.title;
    el.playerDescription.textContent = game.description || "";
    el.playerTags.innerHTML = "";
    (game.tags || "").split(",").map(t => t.trim()).filter(Boolean).slice(0,8).forEach(t => {
      const span = document.createElement("span");
      span.textContent = t;
      el.playerTags.appendChild(span);
    });

    el.playerFav.classList.toggle("active", isFavorite(id));
    el.playerFav.dataset.id = id;

    el.playerLoading.style.display = "flex";
    el.playerFrame.src = "/play/" + encodeURIComponent(game.id);
    el.playerFrame.onload = () => { el.playerLoading.style.display = "none"; };

    el.overlay.hidden = false;
    document.body.style.overflow = "hidden";
    location.hash = "juego/" + id;
  }

  function closeGame(){
    el.overlay.hidden = true;
    el.playerFrame.src = "about:blank";
    document.body.style.overflow = "";
    if (location.hash.startsWith("#juego/")) history.replaceState(null, "", "#/");
    renderContinue();
  }

  /* ---------- events ---------- */
  el.searchInput.addEventListener("input", (e) => {
    searchTerm = e.target.value.trim();
    el.clearSearch.hidden = searchTerm.length === 0;
    updateView();
  });
  el.clearSearch.addEventListener("click", () => {
    el.searchInput.value = "";
    searchTerm = "";
    el.clearSearch.hidden = true;
    updateView();
    el.searchInput.focus();
  });

  el.loadMoreBtn.addEventListener("click", () => {
    visibleCount += PAGE_SIZE;
    render();
  });

  el.favToggleNav.addEventListener("click", renderFavoritesView);

  el.playerBack.addEventListener("click", closeGame);
  el.playerClose.addEventListener("click", closeGame);
  el.playerFullscreen.addEventListener("click", () => {
    if (el.playerFrame.requestFullscreen) el.playerFrame.requestFullscreen();
  });
  el.playerFav.addEventListener("click", () => {
    const id = el.playerFav.dataset.id;
    const active = toggleFavorite(id);
    el.playerFav.classList.toggle("active", active);
    const card = document.querySelector(`.game-card[data-id="${id}"] .fav-star`);
    if (card) card.classList.toggle("active", active);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.overlay.hidden) closeGame();
  });

  document.querySelector(".logo").addEventListener("click", (e) => {
    e.preventDefault();
    closeGame();
    el.searchInput.value = "";
    searchTerm = "";
    el.clearSearch.hidden = true;
    selectCategory("Todos");
  });

  /* ---------- init ---------- */
  fetch("assets/games.json")
    .then(r => r.json())
    .then(data => {
      GAMES = data;
      filtered = GAMES;
      buildCategories();
      updateView();
    })
    .catch(err => {
      el.grid.innerHTML = "<p style='color:#9aa0c0'>No se pudieron cargar los juegos. Revisá tu conexión e intentá de nuevo.</p>";
      console.error(err);
    });

})();
