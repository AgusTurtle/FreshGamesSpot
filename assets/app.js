(function(){
  "use strict";

  const PAGE_SIZE = 24;
  const FAV_KEY = "omg_favorites";
  const RECENT_KEY = "omg_recent";
  const VOTES_KEY = "omg_votes";
  const POPULAR_CAT = "Populares";

  // Game titles/tags/categories all come from the source catalog in
  // English, but people search in Spanish -- "futbol" should find
  // "Soccer" games. Maps a normalized (lowercase, accent-stripped)
  // Spanish term to the English keywords worth searching for too.
  const SEARCH_SYNONYMS = {
    futbol: ["soccer","football"], balompie: ["soccer","football"],
    basket: ["basketball"], basquet: ["basketball"], baloncesto: ["basketball"],
    carros: ["car","racing","driving"], autos: ["car","racing","driving"], coches: ["car","racing","driving"],
    carreras: ["racing","race"], correr: ["run","racing"],
    disparos: ["shooting","shoot","gun"], tiros: ["shooting","shoot"], disparar: ["shoot","shooting"],
    pelea: ["fighting","fight"], peleas: ["fighting","fight"], lucha: ["fighting","fight","wrestling"], luchas: ["fighting","fight"],
    cocina: ["cooking","cook"], cocinar: ["cooking","cook"], cocinera: ["cooking"],
    vestir: ["dress up","dress"], moda: ["dress up","fashion"], disfraces: ["dress up"], maquillaje: ["makeup"],
    rompecabezas: ["puzzle"], puzles: ["puzzle"],
    aventura: ["adventure"], aventuras: ["adventure"],
    deportes: ["sports","sport"], deporte: ["sports","sport"],
    multijugador: ["multiplayer"], multijugadores: ["multiplayer"],
    ninos: ["boys"], chicos: ["boys"], nenes: ["boys"],
    chicas: ["girls"], ninas: ["girls"], nenas: ["girls"],
    accion: ["action"],
    bicicleta: ["bike","bicycle"], bicicletas: ["bike","bicycle"],
    moto: ["moto","motorcycle","bike"], motos: ["moto","motorcycle","bike"],
    zombi: ["zombie"], zombis: ["zombie"],
    guerra: ["war"], boxeo: ["boxing"], tenis: ["tennis"],
    voleibol: ["volleyball"], volei: ["volleyball"],
    billar: ["billiard","pool"], ajedrez: ["chess"], damas: ["checkers"],
    construir: ["build","construction"], granja: ["farm"], simulador: ["simulator"],
    laberinto: ["maze"], escape: ["escape"], terror: ["horror"], futbolin: ["foosball"],
    pesca: ["fishing"], bebe: ["baby"], bebes: ["baby"], mascotas: ["pet"], animales: ["animal"],
  };

  function stripAccents(s){
    return s.normalize("NFD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "");
  }

  const SYNONYM_KEYS = Object.keys(SEARCH_SYNONYMS);

  function expandSearchTerms(raw){
    const q = stripAccents(raw.toLowerCase().trim());
    const terms = new Set([q]);
    // Prefix match against the synonym dictionary so results build up
    // progressively while typing toward a theme word ("f" -> "fu" -> "fut"
    // -> "futbol" all pull in soccer/football games, not just the exact
    // full word).
    const addPrefixSynonyms = (word) => {
      if (!word) return;
      SYNONYM_KEYS.forEach(key => {
        if (key.startsWith(word)) SEARCH_SYNONYMS[key].forEach(t => terms.add(stripAccents(t)));
      });
    };
    addPrefixSynonyms(q);
    q.split(/\s+/).forEach(addPrefixSynonyms);
    return [...terms].filter(Boolean);
  }

  let GAMES = [];
  let filtered = [];
  let visibleCount = PAGE_SIZE;
  let activeCategory = "Todos";
  let searchTerm = "";

  const el = {
    grid: document.getElementById("gameGrid"),
    gridSection: document.getElementById("gridSection"),
    catNav: document.getElementById("catNav"),
    sidebar: document.getElementById("sidebar"),
    sidebarToggle: document.getElementById("sidebarToggle"),
    sidebarScrim: document.getElementById("sidebarScrim"),
    mobileMenuBtn: document.getElementById("mobileMenuBtn"),
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

  // Ids of <symbol> elements in the Lucide sprite at the top of index.html.
  const CATEGORY_ICONS = {
    "Puzzles": "puzzle", "Racing": "car", "Arcade": "joystick", "Multiplayer": "users",
    "Sports": "trophy", "Cooking": "chef", "Soccer": "goal", "3D": "box",
    "2 Player": "gamepad", "Boys": "user", "Clicker": "click", "Girls": "sparkles",
    "Action": "zap", "Shooting": "crosshair", "Adventure": "map", "Hypercasual": "rocket",
    "Fighting": "swords", ".IO": "globe",
  };

  function iconSvg(id, className){
    return `<svg class="icon${className ? " " + className : ""}" width="24" height="24" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  }

  function buildCategories(){
    const counts = {};
    GAMES.forEach(g => { counts[g.category] = (counts[g.category]||0) + 1; });
    const cats = Object.keys(counts).sort((a,b) => counts[b]-counts[a]);
    const frag = document.createDocumentFragment();

    frag.appendChild(makePill("Todos", GAMES.length, true, "Inicio", "home"));

    const popularCount = GAMES.filter(g => g.popularity > 0).length;
    if (popularCount > 0){
      frag.appendChild(makePill(POPULAR_CAT, popularCount, false, "Populares", "flame"));
    }

    const label = document.createElement("div");
    label.className = "side-nav-group-label";
    label.textContent = "Categorías";
    frag.appendChild(label);

    cats.forEach(c => frag.appendChild(makePill(c, counts[c], false, c, CATEGORY_ICONS[c] || "dice")));
    el.catNav.appendChild(frag);
  }

  function makePill(name, count, active, label, icon){
    const btn = document.createElement("button");
    btn.className = "cat-pill" + (active ? " active" : "");
    btn.dataset.cat = name;
    btn.innerHTML = `${iconSvg(icon || "dice", "cat-pill-icon")}<span class="cat-pill-label">${label || name}</span><span class="cat-pill-count">${count}</span>`;
    btn.addEventListener("click", () => selectCategory(name));
    return btn;
  }

  function selectCategory(name){
    activeCategory = name;
    document.querySelectorAll(".cat-pill").forEach(p => {
      p.classList.toggle("active", p.dataset.cat === name);
    });
    el.sectionTitle.textContent = name === "Todos" ? "Todos los juegos" : name;
    closeSidebarMobile();
    updateView();
    window.scrollTo({top:0, behavior:"smooth"});
  }

  function updateView(){
    applyFilters();
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
      const terms = expandSearchTerms(searchTerm);
      list = list.filter(g => {
        const haystack = stripAccents(`${g.title} ${g.tags||""} ${g.category}`.toLowerCase());
        return terms.some(t => haystack.includes(t));
      });
    }
    filtered = list;
    render();
  }

  /* ---------- rendering ---------- */
  function makeCard(game, small){
    const card = document.createElement("div");
    card.className = "game-card";
    card.dataset.id = game.id;
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    card.setAttribute("aria-label", `Jugar ${game.title}`);

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "game-thumb-wrap";

    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
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
    playBadge.innerHTML = `<span>${iconSvg("play")}</span>`;
    thumbWrap.appendChild(playBadge);

    if (game.popularity > 0){
      const ribbon = document.createElement("span");
      ribbon.className = "ribbon-badge";
      ribbon.innerHTML = `${iconSvg("flame")}POPULAR`;
      thumbWrap.appendChild(ribbon);
    }

    const favBtn = document.createElement("button");
    favBtn.className = "fav-star" + (isFavorite(game.id) ? " active" : "");
    favBtn.innerHTML = iconSvg("star");
    const syncFavBtn = (active) => {
      favBtn.setAttribute("aria-pressed", String(active));
      favBtn.setAttribute("aria-label", active
        ? `Quitar ${game.title} de favoritos`
        : `Agregar ${game.title} a favoritos`);
    };
    syncFavBtn(isFavorite(game.id));
    favBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const active = toggleFavorite(game.id);
      favBtn.classList.toggle("active", active);
      syncFavBtn(active);
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
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " "){
        e.preventDefault();
        openGame(game.id);
      }
    });
    return card;
  }

  function makeVoteRow(gameId){
    const row = document.createElement("div");
    row.className = "card-votes";

    const upBtn = document.createElement("button");
    upBtn.className = "vote-btn up";
    upBtn.setAttribute("aria-label", "Me gusta");
    upBtn.innerHTML = `${iconSvg("thumb-up", "vote-icon")}<span class="vote-count"></span>`;

    const downBtn = document.createElement("button");
    downBtn.className = "vote-btn down";
    downBtn.setAttribute("aria-label", "No me gusta");
    downBtn.innerHTML = `${iconSvg("thumb-down", "vote-icon")}<span class="vote-count"></span>`;

    function refresh(){
      const v = getVote(gameId);
      upBtn.classList.toggle("active", v === "up");
      upBtn.setAttribute("aria-pressed", String(v === "up"));
      upBtn.querySelector(".vote-count").textContent = v === "up" ? "1" : "0";
      downBtn.classList.toggle("active", v === "down");
      downBtn.setAttribute("aria-pressed", String(v === "down"));
      downBtn.querySelector(".vote-count").textContent = v === "down" ? "1" : "0";
    }

    upBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleVote(gameId, "up"); refresh(); });
    downBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleVote(gameId, "down"); refresh(); });

    refresh();
    row.appendChild(upBtn);
    row.appendChild(downBtn);
    return row;
  }

  // Placeholder cards shown while games.json (~2.9MB) is in flight. They
  // mirror the real card's box so swapping in real content causes no shift.
  function renderSkeleton(count){
    el.grid.innerHTML = "";
    el.emptyState.hidden = true;
    el.loadMoreBtn.hidden = true;
    el.resultCount.textContent = "Cargando juegos…";
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++){
      const sk = document.createElement("div");
      sk.className = "game-card skeleton-card";
      sk.setAttribute("aria-hidden", "true");
      sk.innerHTML =
        '<div class="skeleton-thumb"></div>' +
        '<div class="game-info">' +
          '<div class="skeleton-line skeleton-line-title"></div>' +
          '<div class="skeleton-line skeleton-line-sub"></div>' +
        '</div>';
      frag.appendChild(sk);
    }
    el.grid.appendChild(frag);
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
    render();
    el.continueSection.hidden = true;
  }

  /* ---------- player ---------- */
  // Element that had focus before the overlay opened, so closing can put the
  // keyboard user back where they were instead of at the top of the document.
  let lastFocusedEl = null;

  const FOCUSABLE_SEL = 'button:not([disabled]), a[href], iframe, [tabindex]:not([tabindex="-1"])';

  function overlayFocusables(){
    return [...el.overlay.querySelectorAll(FOCUSABLE_SEL)];
  }

  function trapOverlayTab(e){
    const items = overlayFocusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first){
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last){
      e.preventDefault();
      first.focus();
    }
  }

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

    syncPlayerFav(isFavorite(id));
    el.playerFav.dataset.id = id;

    el.playerLoading.style.display = "flex";
    el.playerFrame.src = "/play/" + encodeURIComponent(game.id);
    el.playerFrame.onload = () => { el.playerLoading.style.display = "none"; };

    lastFocusedEl = document.activeElement;
    el.overlay.hidden = false;
    document.body.style.overflow = "hidden";
    location.hash = "juego/" + id;
    el.playerBack.focus();
  }

  function syncPlayerFav(active){
    el.playerFav.classList.toggle("active", active);
    el.playerFav.setAttribute("aria-pressed", String(active));
    el.playerFav.setAttribute("aria-label", active ? "Quitar de favoritos" : "Agregar a favoritos");
  }

  function closeGame(){
    const wasOpen = !el.overlay.hidden;
    el.overlay.hidden = true;
    el.playerFrame.src = "about:blank";
    document.body.style.overflow = "";
    if (location.hash.startsWith("#juego/")) history.replaceState(null, "", "#/");
    renderContinue();
    // renderContinue() can replace the card that was focused, so only restore
    // focus to it if it is still in the document.
    if (wasOpen && lastFocusedEl && document.contains(lastFocusedEl)){
      lastFocusedEl.focus();
    }
    lastFocusedEl = null;
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
    syncPlayerFav(active);
    const star = document.querySelector(`.game-card[data-id="${id}"] .fav-star`);
    if (star){
      const title = (findGame(id) || {}).title || "";
      star.classList.toggle("active", active);
      star.setAttribute("aria-pressed", String(active));
      star.setAttribute("aria-label", active
        ? `Quitar ${title} de favoritos`
        : `Agregar ${title} a favoritos`);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (el.overlay.hidden) return;
    if (e.key === "Escape") closeGame();
    else if (e.key === "Tab") trapOverlayTab(e);
  });

  document.querySelector(".logo").addEventListener("click", (e) => {
    e.preventDefault();
    closeGame();
    el.searchInput.value = "";
    searchTerm = "";
    el.clearSearch.hidden = true;
    selectCategory("Todos");
  });

  /* ---------- sidebar ---------- */
  function closeSidebarMobile(){
    el.sidebar.classList.remove("open");
    el.sidebarScrim.hidden = true;
  }
  el.sidebarToggle.addEventListener("click", () => {
    el.sidebar.classList.toggle("collapsed");
  });
  el.mobileMenuBtn.addEventListener("click", () => {
    el.sidebar.classList.add("open");
    el.sidebarScrim.hidden = false;
  });
  el.sidebarScrim.addEventListener("click", closeSidebarMobile);

  /* ---------- init ---------- */
  renderSkeleton(PAGE_SIZE);

  fetch("assets/games.json")
    .then(r => r.json())
    .then(data => {
      GAMES = data;
      filtered = GAMES;
      buildCategories();
      updateView();
      document.getElementById("heroGameCount").textContent = `${GAMES.length}`;
    })
    .catch(err => {
      el.grid.innerHTML = "";
      el.resultCount.textContent = "";
      el.emptyState.hidden = false;
      el.emptyState.querySelector("p").textContent =
        "No se pudieron cargar los juegos. Revisá tu conexión e intentá de nuevo.";
      console.error(err);
    });

})();
