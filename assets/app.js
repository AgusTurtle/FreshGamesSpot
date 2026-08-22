(function(){
  "use strict";

  const PAGE_SIZE = 24;
  const FAV_KEY = "omg_favorites";
  const VOTES_KEY = "omg_votes";
  const VISITOR_KEY = "omg_visitor_id";
  const POPULAR_CAT = "Populares";
  const HEARTBEAT_MS = 12000;
  const LIVE_POLL_MS = 15000;

  // Identifies this browser across visits so the server can let someone
  // change or remove their own like/dislike instead of just piling up
  // votes -- not tied to any account, just a random id kept in localStorage.
  function getVisitorId(){
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id){
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  }
  // Identifies this specific open tab for the "currently playing" presence
  // count -- deliberately NOT persisted, so two tabs of the same visitor
  // both count as separate live players, matching what a viewer would expect.
  const SESSION_ID = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

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
  let showingFavorites = false;
  let SERVER_VOTES = {}; // { [gameId]: { up, down } } -- shared counts from the server
  let heartbeatTimer = null;
  let liveCountsTimer = null;
  let currentOpenGameId = null;

  const el = {
    grid: document.getElementById("gameGrid"),
    gridSection: document.getElementById("gridSection"),
    catNav: document.getElementById("catNav"),
    searchInput: document.getElementById("searchInput"),
    clearSearch: document.getElementById("clearSearch"),
    sectionTitle: document.getElementById("sectionTitle"),
    resultCount: document.getElementById("resultCount"),
    emptyState: document.getElementById("emptyState"),
    scrollSentinel: document.getElementById("scrollSentinel"),
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
    playerLiveCount: document.getElementById("playerLiveCount"),
    playerLiveCountText: document.getElementById("playerLiveCountText"),
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
  function getVotes(){
    try { return JSON.parse(localStorage.getItem(VOTES_KEY)) || {}; }
    catch(e){ return {}; }
  }
  function getVote(id){
    return getVotes()[id] || null;
  }
  // Only remembers *this visitor's own* choice locally (for the pressed
  // button state) -- the actual up/down totals now live server-side in
  // SERVER_VOTES so everyone's likes accumulate together.
  function setLocalVote(id, dir){
    const votes = getVotes();
    if (dir) votes[id] = dir; else delete votes[id];
    localStorage.setItem(VOTES_KEY, JSON.stringify(votes));
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
  // A splash of color per category instead of one flat tone -- purely
  // decorative (icon-only), so it doesn't affect the active/selected state.
  const CATEGORY_COLORS = {
    "Puzzles": "#38d9ff", "Racing": "#ff8a3d", "Arcade": "#a78bfa", "Multiplayer": "#22c55e",
    "Sports": "#facc15", "Cooking": "#fb923c", "Soccer": "#4ade80", "3D": "#f472b6",
    "2 Player": "#38bdf8", "Boys": "#60a5fa", "Clicker": "#fbbf24", "Girls": "#ff3d81",
    "Action": "#f87171", "Shooting": "#fb7185", "Adventure": "#34d399", "Hypercasual": "#c084fc",
    "Fighting": "#f97316", ".IO": "#2dd4bf",
  };

  function iconSvg(id, className){
    return `<svg class="icon${className ? " " + className : ""}" width="24" height="24" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  }

  function buildCategories(){
    const counts = {};
    GAMES.forEach(g => { counts[g.category] = (counts[g.category]||0) + 1; });
    const cats = Object.keys(counts).sort((a,b) => counts[b]-counts[a]);
    const frag = document.createDocumentFragment();

    frag.appendChild(makePill("Todos", GAMES.length, true, "Home", "home"));

    const popularCount = GAMES.filter(g => g.popularity > 0).length;
    if (popularCount > 0){
      frag.appendChild(makePill(POPULAR_CAT, popularCount, false, "Popular", "flame"));
    }

    cats.forEach(c => frag.appendChild(makePill(c, counts[c], false, c, CATEGORY_ICONS[c] || "dice", CATEGORY_COLORS[c])));
    el.catNav.appendChild(frag);
  }

  function makePill(name, count, active, label, icon, color){
    const btn = document.createElement("button");
    btn.className = "cat-pill" + (active ? " active" : "");
    btn.dataset.cat = name;
    btn.innerHTML = `${iconSvg(icon || "dice", "cat-pill-icon")}<span class="cat-pill-label">${label || name}</span><span class="cat-pill-count">${count}</span>`;
    if (color) btn.querySelector(".cat-pill-icon").style.color = color;
    btn.addEventListener("click", () => selectCategory(name));
    return btn;
  }

  function selectCategory(name){
    activeCategory = name;
    showingFavorites = false;
    document.querySelectorAll(".cat-pill").forEach(p => {
      p.classList.toggle("active", p.dataset.cat === name);
    });
    el.sectionTitle.textContent = name === "Todos" ? "Todos los juegos" : name === POPULAR_CAT ? "Popular" : name;
    updateView();
    window.scrollTo({top:0, behavior:"smooth"});
  }

  function updateView(){
    applyFilters();
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
  function isHomeView(){
    return activeCategory === "Todos" && !searchTerm && !showingFavorites;
  }

  // All home tiles render at the same uniform size -- a dense wall of
  // cover art (Ubisoft-Connect-library style), not a mixed mosaic.
  function tileSizeClass(){
    return "";
  }

  function makeCard(game, opts){
    const collage = !!(opts && opts.collage);
    const card = document.createElement("div");
    card.className = "game-card" + (collage ? " " + [tileSizeClass(game)].filter(Boolean).join(" ") : "");
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

    // Hover preview: swap the static thumbnail for a short looping gameplay
    // clip while the pointer is over the tile. The <video> stays out of the
    // DOM's initial network activity (preload="none") until hover actually
    // requests it, so idle browsing the grid costs nothing extra.
    if (game.preview){
      const video = document.createElement("video");
      video.className = "thumb-preview";
      video.src = game.preview;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "none";
      thumbWrap.appendChild(video);
      let hoverTimer = null;
      thumbWrap.addEventListener("pointerenter", () => {
        hoverTimer = setTimeout(() => {
          video.currentTime = 0;
          video.play().catch(() => {});
          thumbWrap.classList.add("show-preview");
        }, 150);
      });
      thumbWrap.addEventListener("pointerleave", () => {
        clearTimeout(hoverTimer);
        thumbWrap.classList.remove("show-preview");
        video.pause();
      });
    }

    const playBadge = document.createElement("div");
    playBadge.className = "play-badge";
    playBadge.innerHTML = `<span>${iconSvg("play")}</span>`;
    thumbWrap.appendChild(playBadge);

    if (collage){
      const idBadge = document.createElement("span");
      idBadge.className = "tile-badge";
      idBadge.textContent = "FreshGamesPot";
      thumbWrap.appendChild(idBadge);
    } else if (game.popularity > 0){
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
      if (active){
        favBtn.classList.remove("pop");
        void favBtn.offsetWidth; // restart the animation on repeat clicks
        favBtn.classList.add("pop");
      }
    });
    thumbWrap.appendChild(favBtn);

    card.appendChild(thumbWrap);

    // The dense home collage (poki.com/es style) shows thumbnails only --
    // title/category/votes only make sense once you're browsing a specific
    // category or search results, where there's room and a reason to compare.
    if (!collage){
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
    }

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
      const counts = SERVER_VOTES[gameId] || { up: 0, down: 0 };
      upBtn.classList.toggle("active", v === "up");
      upBtn.setAttribute("aria-pressed", String(v === "up"));
      upBtn.querySelector(".vote-count").textContent = String(counts.up || 0);
      downBtn.classList.toggle("active", v === "down");
      downBtn.setAttribute("aria-pressed", String(v === "down"));
      downBtn.querySelector(".vote-count").textContent = String(counts.down || 0);
    }

    function castVote(dir){
      const prevVote = getVote(gameId);
      const newVote = prevVote === dir ? null : dir;
      setLocalVote(gameId, newVote);
      // Optimistic update so the click feels instant; syncVote() below
      // reconciles with the server's authoritative counts right after.
      const counts = SERVER_VOTES[gameId] || (SERVER_VOTES[gameId] = { up: 0, down: 0 });
      if (prevVote === "up") counts.up = Math.max(0, counts.up - 1);
      if (prevVote === "down") counts.down = Math.max(0, counts.down - 1);
      if (newVote === "up") counts.up += 1;
      if (newVote === "down") counts.down += 1;
      refresh();
      syncVote(gameId, prevVote, newVote, refresh);
    }

    upBtn.addEventListener("click", (e) => { e.stopPropagation(); castVote("up"); });
    downBtn.addEventListener("click", (e) => { e.stopPropagation(); castVote("down"); });

    refresh();
    row.appendChild(upBtn);
    row.appendChild(downBtn);
    row.appendChild(makeLiveBadge(gameId));
    return row;
  }

  function syncVote(gameId, prevVote, newVote, onSynced){
    fetch("/api/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId, prevVote, newVote }),
    })
      .then(r => r.ok ? r.json() : Promise.reject(new Error("vote failed")))
      .then(counts => { SERVER_VOTES[gameId] = counts; onSynced(); })
      .catch(err => console.error("Could not save vote:", err));
  }

  /* ---------- live "playing now" presence ---------- */
  function refreshLiveBadges(){
    fetch("/api/live-counts")
      .then(r => r.ok ? r.json() : Promise.reject(new Error("live-counts failed")))
      .then(counts => {
        document.querySelectorAll("[data-live-id]").forEach(el => {
          const n = counts[el.dataset.liveId] || 0;
          el.classList.toggle("has-players", n > 0);
          el.setAttribute("aria-label", n === 1 ? "1 persona jugando ahora" : `${n} personas jugando ahora`);
          el.querySelector(".card-live-count").textContent = String(n);
        });
      })
      .catch(() => {});
  }

  // A little person icon + live count, sitting in the same row as the
  // like/dislike buttons -- shows "0" until the first live-counts poll
  // resolves rather than popping in, since PAGE_SIZE cards render at once.
  function makeLiveBadge(gameId){
    const badge = document.createElement("span");
    badge.className = "card-live";
    badge.dataset.liveId = gameId;
    badge.setAttribute("aria-label", "0 personas jugando ahora");
    badge.innerHTML = `${iconSvg("user", "card-live-icon")}<span class="card-live-count">0</span>`;
    return badge;
  }

  function sendHeartbeat(gameId){
    fetch("/api/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId, sessionId: SESSION_ID }),
    })
      .then(r => r.ok ? r.json() : Promise.reject(new Error("heartbeat failed")))
      .then(({ count }) => {
        if (gameId !== currentOpenGameId) return;
        el.playerLiveCount.hidden = count <= 0;
        el.playerLiveCountText.textContent = count === 1 ? "1 jugando ahora" : `${count} jugando ahora`;
      })
      .catch(() => {});
  }

  function startHeartbeat(gameId){
    stopHeartbeat();
    sendHeartbeat(gameId);
    heartbeatTimer = setInterval(() => sendHeartbeat(gameId), HEARTBEAT_MS);
  }

  // Drops this session from the live count immediately instead of waiting
  // for the server's TTL to expire it. sendBeacon is used because this also
  // runs from pagehide, where a regular fetch can get cancelled mid-flight
  // as the tab closes.
  function sendLeaveBeacon(gameId){
    const payload = JSON.stringify({ gameId, sessionId: SESSION_ID });
    if (navigator.sendBeacon){
      navigator.sendBeacon("/api/leave", new Blob([payload], { type: "application/json" }));
    } else {
      fetch("/api/leave", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true }).catch(() => {});
    }
  }

  function stopHeartbeat(){
    if (heartbeatTimer){ clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (currentOpenGameId) sendLeaveBeacon(currentOpenGameId);
    el.playerLiveCount.hidden = true;
  }

  window.addEventListener("pagehide", () => {
    if (currentOpenGameId) sendLeaveBeacon(currentOpenGameId);
  });

  // Placeholder cards shown while games.json (~2.9MB) is in flight. They
  // mirror the real card's box so swapping in real content causes no shift.
  function renderSkeleton(count){
    el.grid.innerHTML = "";
    el.emptyState.hidden = true;
    el.resultCount.textContent = "Cargando juegos…";
    // Matches the collage layout since the app always boots into home view
    // -- a uniform-card skeleton would otherwise visibly jump into the
    // mixed-size mosaic the instant games.json resolves.
    el.grid.classList.add("collage");
    const tileCycle = ["", "", "", "tile-wide", "", "", "tile-big", "", "", "tile-wide"];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++){
      const sk = document.createElement("div");
      sk.className = ("game-card skeleton-card " + tileCycle[i % tileCycle.length]).trim();
      sk.setAttribute("aria-hidden", "true");
      sk.innerHTML = '<div class="skeleton-thumb"></div>';
      frag.appendChild(sk);
    }
    el.grid.appendChild(frag);
  }

  function render(){
    el.grid.innerHTML = "";

    if (filtered.length === 0){
      el.emptyState.hidden = false;
      el.resultCount.textContent = "";
      return;
    }
    el.emptyState.hidden = true;

    const collage = isHomeView();
    el.grid.classList.toggle("collage", collage);
    const slice = filtered.slice(0, visibleCount);
    const frag = document.createDocumentFragment();
    slice.forEach(g => frag.appendChild(makeCard(g, { collage })));
    el.grid.appendChild(frag);

    el.resultCount.textContent = `${filtered.length} juego${filtered.length===1?"":"s"}`;
  }

  // Infinite scroll: appends just the next page instead of re-rendering
  // everything render() already built, so scrolling through a long list
  // doesn't keep recreating cards that are already on screen.
  function appendMoreCards(){
    if (visibleCount >= filtered.length) return;
    const collage = isHomeView();
    const prevCount = visibleCount;
    visibleCount = Math.min(visibleCount + PAGE_SIZE, filtered.length);
    const slice = filtered.slice(prevCount, visibleCount);
    const frag = document.createDocumentFragment();
    slice.forEach(g => frag.appendChild(makeCard(g, { collage })));
    el.grid.appendChild(frag);
  }

  // Re-observing after every append forces a fresh intersection check --
  // without it, IntersectionObserver only fires on true/false transitions,
  // so if the sentinel is still on-screen after one page loads (short
  // result lists, tall viewports) it would silently never fire again even
  // though there's more to load and the user hasn't scrolled away.
  const scrollObserver = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) return;
    appendMoreCards();
    scrollObserver.unobserve(el.scrollSentinel);
    scrollObserver.observe(el.scrollSentinel);
  }, { rootMargin: "800px" });
  scrollObserver.observe(el.scrollSentinel);

  function renderFavoritesView(){
    activeCategory = "Todos";
    searchTerm = "";
    showingFavorites = true;
    el.searchInput.value = "";
    el.clearSearch.hidden = true;
    document.querySelectorAll(".cat-pill").forEach(p => p.classList.remove("active"));
    el.sectionTitle.textContent = "Mis favoritos";
    visibleCount = PAGE_SIZE;
    const favIds = getFavorites();
    filtered = favIds.map(findGame).filter(Boolean).reverse();
    render();
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

    currentOpenGameId = id;
    startHeartbeat(id);
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
    stopHeartbeat();
    currentOpenGameId = null;
    if (location.hash.startsWith("#juego/")) history.replaceState(null, "", "#/");
    if (wasOpen && lastFocusedEl && document.contains(lastFocusedEl)){
      lastFocusedEl.focus();
    }
    lastFocusedEl = null;
  }

  /* ---------- events ---------- */
  el.searchInput.addEventListener("input", (e) => {
    searchTerm = e.target.value.trim();
    showingFavorites = false;
    el.clearSearch.hidden = searchTerm.length === 0;
    updateView();
  });
  el.clearSearch.addEventListener("click", () => {
    el.searchInput.value = "";
    searchTerm = "";
    showingFavorites = false;
    el.clearSearch.hidden = true;
    updateView();
    el.searchInput.focus();
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

  /* ---------- init ---------- */
  renderSkeleton(PAGE_SIZE);
  getVisitorId();

  Promise.all([
    fetch("assets/games.json").then(r => r.json()),
    fetch("/api/votes").then(r => r.ok ? r.json() : {}).catch(() => ({})),
  ])
    .then(([data, votes]) => {
      // Stable sort so the most popular games lead every list -- home,
      // categories, and search results alike -- instead of catalog order.
      GAMES = data.slice().sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      filtered = GAMES;
      SERVER_VOTES = votes || {};
      buildCategories();
      updateView();
      document.getElementById("heroGameCount").textContent = `${GAMES.length}`;
      refreshLiveBadges();
      liveCountsTimer = setInterval(refreshLiveBadges, LIVE_POLL_MS);
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
