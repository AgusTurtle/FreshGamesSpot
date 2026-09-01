(function(){
  "use strict";

  const PAGE_SIZE = 24;
  const FAV_KEY = "omg_favorites";
  const VOTES_KEY = "omg_votes";
  const SESSION_KEY = "omg_session";
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
    loginNavBtn: document.getElementById("loginNavBtn"),
    loginGoogleBtn: document.getElementById("loginGoogleBtn"),
    loginOverlay: document.getElementById("loginOverlay"),
    loginClose: document.getElementById("loginClose"),
    loginProviders: document.getElementById("loginProviders"),
    loginForm: document.getElementById("loginForm"),
    loginEmail: document.getElementById("loginEmail"),
    loginPassword: document.getElementById("loginPassword"),
    loginError: document.getElementById("loginError"),
    loginContinue: document.getElementById("loginContinue"),
    usernameForm: document.getElementById("usernameForm"),
    usernameInput: document.getElementById("usernameInput"),
    usernameShuffle: document.getElementById("usernameShuffle"),
    usernameError: document.getElementById("usernameError"),
    usernameContinue: document.getElementById("usernameContinue"),
    userMenu: document.getElementById("userMenu"),
    userMenuBtn: document.getElementById("userMenuBtn"),
    userMenuDropdown: document.getElementById("userMenuDropdown"),
    userAvatar: document.getElementById("userAvatar"),
    userEmailLabel: document.getElementById("userEmailLabel"),
    logoutBtn: document.getElementById("logoutBtn"),
    avatarFileInput: document.getElementById("avatarFileInput"),
    viewProfileBtn: document.getElementById("viewProfileBtn"),
    profileOverlay: document.getElementById("profileOverlay"),
    profileClose: document.getElementById("profileClose"),
    profileAvatarBtn: document.getElementById("profileAvatarBtn"),
    profileChangeAvatarLink: document.getElementById("profileChangeAvatarLink"),
    profileRemoveAvatarLink: document.getElementById("profileRemoveAvatarLink"),
    profileUsername: document.getElementById("profileUsername"),
    profileEditUsernameBtn: document.getElementById("profileEditUsernameBtn"),
    profileUsernameForm: document.getElementById("profileUsernameForm"),
    profileUsernameInput: document.getElementById("profileUsernameInput"),
    profileUsernameCancel: document.getElementById("profileUsernameCancel"),
    profileDays: document.getElementById("profileDays"),
    profileFavCount: document.getElementById("profileFavCount"),
    profileStreak: document.getElementById("profileStreak"),
    profileBestStreak: document.getElementById("profileBestStreak"),
    profileFavGrid: document.getElementById("profileFavGrid"),
    profileFavEmpty: document.getElementById("profileFavEmpty"),
  };

  /* ---------- account helpers ----------
     Real server-side accounts (see /api/account/* in serve.js), persisted
     to a JSON file the same way vote totals already were. No session/
     cookie layer -- the client keeps { email, passwordHash } in
     localStorage as its "session" and resends both on every account
     request; the server checks the hash against what it stored each
     time. Plaintext password never leaves the browser (hashed via
     SubtleCrypto first). Favorites become server-synced once logged in,
     so they follow the account across devices/browsers instead of
     staying stuck to one machine. */
  async function hashPassword(pw){
    const bytes = new TextEncoder().encode(pw);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  function getSession(){
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); }
    catch(e){ return null; }
  }
  // session is { email, passwordHash, username } for email+password
  // accounts, or { email, oauthToken, username } for Google (and later
  // Discord/Steam) accounts -- username is whatever the account chose to
  // display instead of its email, null until they set one.
  function setSession(session){
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
  function setSessionUsername(username){
    const session = getSession();
    if (!session) return;
    session.username = username;
    setSession(session);
  }
  function setSessionAvatar(avatar){
    const session = getSession();
    if (!session) return;
    session.avatar = avatar;
    setSession(session);
  }
  function clearSession(){
    localStorage.removeItem(SESSION_KEY);
  }
  // Same email+password form both registers (first time the server sees
  // that email) and logs in (email already on file) -- one flow instead
  // of a separate signup screen, matching what the login modal's single
  // button implies. Resolves the server's copy of favorites so the
  // caller can adopt it as the new source of truth.
  async function loginOrRegister(email, password){
    const passwordHash = await hashPassword(password);
    let res;
    try {
      res = await fetch("/api/account/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, passwordHash }),
      });
    } catch (e){
      return { ok:false, error:"No se pudo conectar con el servidor. Probá de nuevo." };
    }
    if (res.status === 401){
      const data = await res.json().catch(() => ({}));
      return { ok:false, error: data.error || "Contraseña incorrecta." };
    }
    if (!res.ok) return { ok:false, error:"Algo salió mal. Probá de nuevo." };
    const data = await res.json();
    setSession({ email, passwordHash, username: data.username || null, avatar: data.avatar || null });
    return { ok:true, favorites: data.favorites || [], username: data.username || null };
  }
  // Google Identity Services hands us a signed ID token ("credential") --
  // the server verifies it against Google directly (see
  // verifyGoogleCredential in serve.js) and, only once that checks out,
  // creates/logs into the account and mints an opaque session token tied
  // to it (nothing Google-specific leaks into how the rest of the app
  // treats the session).
  async function loginWithGoogleCredential(credential){
    let res;
    try {
      res = await fetch("/api/account/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });
    } catch (e){
      return { ok:false, error:"No se pudo conectar con el servidor. Probá de nuevo." };
    }
    if (!res.ok){
      const data = await res.json().catch(() => ({}));
      return { ok:false, error: data.error || "No se pudo iniciar sesión con Google." };
    }
    const data = await res.json();
    setSession({ email: data.email, oauthToken: data.oauthToken, username: data.username || null, avatar: data.avatar || null });
    return { ok:true, favorites: data.favorites || [], username: data.username || null };
  }
  async function saveUsername(username){
    const session = getSession();
    if (!session) return { ok:false, error:"Sesión perdida, volvé a iniciar sesión." };
    let res;
    try {
      res = await fetch("/api/account/username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: session.email, passwordHash: session.passwordHash, oauthToken: session.oauthToken, username }),
      });
    } catch (e){
      return { ok:false, error:"No se pudo conectar con el servidor. Probá de nuevo." };
    }
    if (!res.ok) return { ok:false, error:"Ese nombre no es válido (mínimo 2 caracteres)." };
    const data = await res.json();
    setSessionUsername(data.username);
    return { ok:true, username: data.username };
  }
  // avatar is a data: URI (already downscaled to a small square client-
  // side, see pickAndResizeAvatar) or null to reset to the default site
  // icon. Stored straight in accounts.json -- no image host in this
  // stack to upload to.
  async function saveAvatar(avatar){
    const session = getSession();
    if (!session) return { ok:false, error:"Sesión perdida, volvé a iniciar sesión." };
    let res;
    try {
      res = await fetch("/api/account/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: session.email, passwordHash: session.passwordHash, oauthToken: session.oauthToken, avatar }),
      });
    } catch (e){
      return { ok:false, error:"No se pudo conectar con el servidor. Probá de nuevo." };
    }
    if (!res.ok) return { ok:false, error:"No se pudo guardar la foto." };
    setSessionAvatar(avatar);
    return { ok:true };
  }
  // Downscales to a small square JPEG before it ever leaves the browser --
  // keeps the upload small and accounts.json from growing unbounded (the
  // server also caps the request body size as a hard backstop).
  function pickAndResizeAvatar(file){
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("read failed"));
      reader.onload = () => { img.onerror = () => reject(new Error("decode failed")); img.onload = () => {
        const SIZE = 160;
        const canvas = document.createElement("canvas");
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext("2d");
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      }; img.src = reader.result; };
      reader.readAsDataURL(file);
    });
  }
  // Fire-and-forget push of the current favorites list to the account,
  // called after every toggle while logged in. Best-effort: a failed
  // sync (offline, server hiccup) just leaves the account's copy stale
  // until the next successful toggle or login, same tradeoff the vote
  // counters already accept.
  function syncFavoritesToServer(){
    const session = getSession();
    if (!session) return;
    fetch("/api/account/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: session.email, passwordHash: session.passwordHash, oauthToken: session.oauthToken, favorites: getFavorites() }),
    }).catch(() => {});
  }

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
    syncFavoritesToServer();
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
  function tileSizeClass(game){
    // tile-wide (2x1) packs perfectly with grid-auto-flow:dense -- no gaps.
    // tile-big (2x2) can leave unfillable holes depending on placement
    // order, so it's not used here.
    if ((game.popularity || 0) >= 4) return "tile-wide";
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

    const thumbWatermark = document.createElement("div");
    thumbWatermark.className = "thumb-watermark";
    thumbWatermark.setAttribute("aria-hidden", "true");
    thumbWatermark.innerHTML = `<svg class="icon" width="12" height="12" aria-hidden="true"><use href="#i-logo"/></svg><span>FreshGames<strong>Pot</strong></span>`;
    thumbWrap.appendChild(thumbWatermark);

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
    // Full third-party platforms (their own login, ads, dozens of asset
    // domains) can't realistically be proxied through our CSP-restricted
    // /play/<id> pipeline built for single-file game embeds -- load those
    // straight from their own origin instead, under their own CSP/rules.
    el.playerFrame.src = game.directEmbed ? game.url : "/play/" + encodeURIComponent(game.id);
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

  const DEFAULT_AVATAR_HTML = `<svg class="icon" width="16" height="16" aria-hidden="true"><use href="#i-logo"/></svg>`;
  function syncSessionUI(){
    const session = getSession();
    const loggedIn = !!session;
    el.loginNavBtn.hidden = loggedIn;
    el.userMenu.hidden = !loggedIn;
    if (loggedIn){
      const label = session.username || session.email;
      el.userEmailLabel.textContent = label;
      el.userAvatar.innerHTML = session.avatar
        ? `<img src="${session.avatar}" alt="">`
        : DEFAULT_AVATAR_HTML;
    }
  }
  syncSessionUI();
  // A session saved from a previous visit only proves this browser once
  // knew the right password -- it doesn't carry today's favorites if the
  // account was used on another device meanwhile. Re-auth silently on
  // load (same endpoint login uses) to pull the server's current list.
  (async () => {
    const session = getSession();
    if (!session) return;
    let res;
    try {
      res = await fetch("/api/account/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: session.email, passwordHash: session.passwordHash, oauthToken: session.oauthToken }),
      });
    } catch (e){ return; }
    if (!res.ok){ clearSession(); syncSessionUI(); return; }
    const data = await res.json();
    setFavorites(data.favorites || []);
    // Also pick up a username/avatar set from another device since this
    // session was last saved here.
    setSessionUsername(data.username || null);
    setSessionAvatar(data.avatar || null);
    syncSessionUI();
    updateView();
  })();

  function openLoginModal(){
    el.loginError.hidden = true;
    el.loginForm.reset();
    el.loginForm.hidden = false;
    el.loginProviders.hidden = false;
    el.usernameForm.hidden = true;
    el.loginOverlay.hidden = false;
    el.loginEmail.focus();
  }
  el.loginNavBtn.addEventListener("click", openLoginModal);

  // Shared tail end of every successful login/register (password or
  // Google): adopt the account's favorites, and if it has no username
  // yet, block on setting one before the modal closes -- new accounts
  // via Google in particular have never had the user type anything.
  function finishLogin(favorites, username){
    syncSessionUI();
    setFavorites(favorites);
    updateView();
    if (username){
      el.loginOverlay.hidden = true;
    } else {
      el.loginProviders.hidden = true;
      el.loginForm.hidden = true;
      el.usernameForm.hidden = false;
      el.usernameError.hidden = true;
      el.usernameInput.value = "";
      validateUsername();
      el.usernameInput.focus();
    }
  }

  // Google Identity Services' real button has to receive the actual click
  // for the sign-in popup to be allowed -- forwarding a synthetic
  // .click() to it from our own button isn't a trusted user gesture and
  // gets popup-blocked. So Google's real button renders invisibly right
  // on top of our styled one (see #googleBtnContainer in index.html) and
  // just eats the real click; loginGoogleBtn itself has no click handler.
  const GOOGLE_CLIENT_ID = "120779948196-6o78huetsa3rjposubl20nuu36qsbv4d.apps.googleusercontent.com";
  async function handleGoogleCredentialResponse(response){
    const result = await loginWithGoogleCredential(response.credential);
    if (!result.ok){
      el.loginError.textContent = result.error;
      el.loginError.hidden = false;
      return;
    }
    finishLogin(result.favorites, result.username);
  }
  function initGoogleSignIn(){
    if (!window.google || !google.accounts || !google.accounts.id) { setTimeout(initGoogleSignIn, 300); return; }
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredentialResponse });
    google.accounts.id.renderButton(document.getElementById("googleBtnContainer"), {
      type: "standard",
      width: el.loginGoogleBtn.offsetWidth || 360,
    });
  }
  initGoogleSignIn();
  el.loginClose.addEventListener("click", () => {
    el.loginOverlay.hidden = true;
  });
  el.loginOverlay.addEventListener("click", (e) => {
    if (e.target === el.loginOverlay) el.loginOverlay.hidden = true;
  });
  el.loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = el.loginEmail.value.trim();
    const password = el.loginPassword.value;
    if (!email || password.length < 4){
      el.loginError.textContent = "Ingresá un email y una contraseña de al menos 4 caracteres.";
      el.loginError.hidden = false;
      return;
    }
    el.loginContinue.disabled = true;
    const result = await loginOrRegister(email, password);
    el.loginContinue.disabled = false;
    if (!result.ok){
      el.loginError.textContent = result.error;
      el.loginError.hidden = false;
      return;
    }
    // The account's server-side favorites become the new local list --
    // whatever was starred anonymously in this browser before logging in
    // is not merged in, to avoid surprising someone who logs into an
    // existing account with a different favorites history.
    finishLogin(result.favorites, result.username);
  });

  // ---- Username step (shown once, after first login with none set) ----
  const USERNAME_RE = /^[a-zA-Z0-9._]{6,20}$/;
  const NAME_WORDS = ["Turbo", "Pixel", "Rapid", "Nova", "Shadow", "Blaze", "Cosmic", "Retro", "Wild", "Lucky"];
  function validateUsername(){
    const value = el.usernameInput.value.trim();
    const lengthOk = value.length >= 6 && value.length <= 20;
    const charsOk = value.length === 0 || /^[a-zA-Z0-9._]+$/.test(value);
    document.getElementById("ruleLength").dataset.ok = String(lengthOk);
    document.getElementById("ruleChars").dataset.ok = String(charsOk);
    const valid = USERNAME_RE.test(value);
    el.usernameContinue.disabled = !valid;
    return valid;
  }
  el.usernameInput.addEventListener("input", validateUsername);
  el.usernameShuffle.addEventListener("click", () => {
    const word = NAME_WORDS[Math.floor(Math.random() * NAME_WORDS.length)];
    el.usernameInput.value = word + Math.floor(1000 + Math.random() * 9000);
    validateUsername();
  });
  el.usernameForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateUsername()) return;
    el.usernameContinue.disabled = true;
    const result = await saveUsername(el.usernameInput.value.trim());
    el.usernameContinue.disabled = false;
    if (!result.ok){
      el.usernameError.textContent = result.error;
      el.usernameError.hidden = false;
      return;
    }
    syncSessionUI();
    el.loginOverlay.hidden = true;
  });

  el.userMenuBtn.addEventListener("click", () => {
    el.userMenuDropdown.hidden = !el.userMenuDropdown.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!el.userMenu.contains(e.target)) el.userMenuDropdown.hidden = true;
  });
  el.logoutBtn.addEventListener("click", () => {
    clearSession();
    el.userMenuDropdown.hidden = true;
    syncSessionUI();
  });

  el.avatarFileInput.addEventListener("change", async () => {
    const file = el.avatarFileInput.files[0];
    el.avatarFileInput.value = "";
    if (!file) return;
    let dataUri;
    try { dataUri = await pickAndResizeAvatar(file); }
    catch (e){ return; }
    const result = await saveAvatar(dataUri);
    if (result.ok){
      syncSessionUI();
      renderProfileAvatar();
    }
  });

  /* ---------- profile page ---------- */
  function renderProfileAvatar(){
    const session = getSession();
    const hasAvatar = !!(session && session.avatar);
    el.profileAvatarBtn.innerHTML = hasAvatar
      ? `<img src="${session.avatar}" alt="">`
      : DEFAULT_AVATAR_HTML.replace('width="16" height="16"', 'width="40" height="40"');
    el.profileRemoveAvatarLink.hidden = !hasAvatar;
  }
  function daysSince(ts){
    if (!ts) return 0;
    // Calendar-day difference (UTC), matching how the streak counts days,
    // so "Miembro por" and "Racha" never contradict each other (e.g. a
    // 24h-elapsed count could show "0 días" while the streak already
    // ticked to 2 just by crossing midnight).
    const created = new Date(ts);
    const createdDay = Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate());
    const now = new Date();
    const todayDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Math.max(0, Math.round((todayDay - createdDay) / 86400000));
  }
  function plural(n, one, many){ return n === 1 ? `1 ${one}` : `${n} ${many}`; }
  async function openProfile(){
    el.userMenuDropdown.hidden = true;
    const session = getSession();
    if (!session) return;
    // Re-auth pulls fresh stats (streak advances server-side at most once
    // per day, and could differ from what this session cached on login).
    let res;
    try {
      res = await fetch("/api/account/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: session.email, passwordHash: session.passwordHash, oauthToken: session.oauthToken }),
      });
    } catch (e){ return; }
    if (!res.ok) return;
    const data = await res.json();
    setSession({ ...session, username: data.username, avatar: data.avatar });
    syncSessionUI();

    el.profileUsername.textContent = data.username || session.email;
    renderProfileAvatar();
    el.profileDays.textContent = plural(daysSince(data.createdAt), "día", "días");
    el.profileFavCount.textContent = String(data.favorites.length);
    el.profileStreak.textContent = plural(data.streak || 1, "día", "días");
    el.profileBestStreak.textContent = plural(data.bestStreak || 1, "día", "días");

    el.profileFavGrid.innerHTML = "";
    const favGames = data.favorites.map(findGame).filter(Boolean);
    el.profileFavEmpty.hidden = favGames.length > 0;
    // Small thumbnail-only cards, same as the home collage -- no
    // title/category/votes footer needed in this compact list.
    favGames.forEach(g => el.profileFavGrid.appendChild(makeCard(g, { collage: true })));

    el.profileUsernameForm.hidden = true;
    el.profileOverlay.hidden = false;
  }
  el.viewProfileBtn.addEventListener("click", openProfile);
  el.profileClose.addEventListener("click", () => { el.profileOverlay.hidden = true; });
  el.profileOverlay.addEventListener("click", (e) => {
    if (e.target === el.profileOverlay) el.profileOverlay.hidden = true;
  });
  el.profileAvatarBtn.addEventListener("click", () => el.avatarFileInput.click());
  el.profileChangeAvatarLink.addEventListener("click", () => el.avatarFileInput.click());
  el.profileRemoveAvatarLink.addEventListener("click", async () => {
    const result = await saveAvatar(null);
    if (result.ok){
      syncSessionUI();
      renderProfileAvatar();
    }
  });

  function validateProfileUsername(){
    const value = el.profileUsernameInput.value.trim();
    const lengthOk = value.length >= 6 && value.length <= 20;
    const charsOk = value.length === 0 || /^[a-zA-Z0-9._]+$/.test(value);
    el.profileUsernameForm.querySelector("#profileRuleLength").dataset.ok = String(lengthOk);
    el.profileUsernameForm.querySelector("#profileRuleChars").dataset.ok = String(charsOk);
    const valid = /^[a-zA-Z0-9._]{6,20}$/.test(value);
    el.profileUsernameForm.querySelector('button[type="submit"]').disabled = !valid;
    return valid;
  }
  el.profileUsernameInput.addEventListener("input", validateProfileUsername);
  el.profileEditUsernameBtn.addEventListener("click", () => {
    el.profileUsernameInput.value = el.profileUsername.textContent;
    validateProfileUsername();
    el.profileUsernameForm.hidden = false;
    el.profileUsernameInput.focus();
  });
  el.profileUsernameCancel.addEventListener("click", () => {
    el.profileUsernameForm.hidden = true;
  });
  el.profileUsernameForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateProfileUsername()) return;
    const result = await saveUsername(el.profileUsernameInput.value.trim());
    if (!result.ok) return;
    el.profileUsername.textContent = result.username;
    syncSessionUI();
    el.profileUsernameForm.hidden = true;
  });

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
      // Shuffle on every load so the grid isn't the same order every visit.
      GAMES = data.slice();
      for (let i = GAMES.length - 1; i > 0; i--){
        const j = Math.floor(Math.random() * (i + 1));
        [GAMES[i], GAMES[j]] = [GAMES[j], GAMES[i]];
      }
      filtered = GAMES;
      SERVER_VOTES = votes || {};
      buildCategories();
      // Support a shareable ?q=<term> deep link into search (matches the
      // SearchAction declared in the page's JSON-LD) -- pre-fill the box
      // and filter immediately instead of leaving it as a dead promise.
      const qParam = new URLSearchParams(location.search).get("q");
      if (qParam){
        searchTerm = qParam.trim();
        el.searchInput.value = searchTerm;
        el.clearSearch.hidden = searchTerm.length === 0;
      }
      updateView();
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
