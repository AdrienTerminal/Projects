/* ==================================================================
   ÉDITEUR VISUEL v4

   - Badges d'action (icônes SVG, pas d'emoji) sur les éléments
     simples : images, liens, réseaux, tabs, pills.
   - Les pages de projet (tags, listes, stats, blocs, images, liens)
     s'éditent dans un panneau dédié, spacieux — plus d'entassement
     de badges sur des petits tags.
   - Couleurs conscientes du thème clair/sombre : personnaliser en
     sombre ne touche jamais le clair, et inversement. 10 palettes
     prêtes à l'emploi par thème.
   - Ctrl+Z restaure directement la valeur précédente, sans jamais
     recharger la page — sauf ajout/suppression de projet (protégé
     par confirmation à la place).

   ⚠️ Doit tourner sur http(s):// — pas en double-clic sur le fichier.
================================================================== */

const DRAFT_KEY = "portfolio_editor_draft_v4";

// ---------------------------------------------------------------
// Stockage du brouillon via IndexedDB plutôt que localStorage : la
// limite passe d'environ 5-10 Mo à plusieurs centaines de Mo (selon
// le navigateur et l'espace disque libre), ce qui règle le problème
// de fond pour des sites avec plusieurs images/vidéos plutôt que de
// se contenter d'avertir quand la limite est atteinte.
// ---------------------------------------------------------------
const IDB_NAME = "portfolio_editor_store";
const IDB_STORE = "drafts";
let idbPromise = null;

function openIDB(){
  if(idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    if(!window.indexedDB){ reject(new Error("IndexedDB indisponible")); return; }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}
async function idbSet(key, value){
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key){
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(key){
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
// Reprend un ancien brouillon resté dans localStorage (versions
// précédentes de l'éditeur) et le transfère vers IndexedDB une fois,
// pour ne rien perdre lors de cette mise à jour.
async function migrateLegacyLocalStorageDraft(){
  try{
    const legacy = localStorage.getItem(DRAFT_KEY);
    if(legacy){
      await idbSet(DRAFT_KEY, legacy);
      localStorage.removeItem(DRAFT_KEY);
    }
  }catch(err){ /* pas grave si ça échoue, ce n'est qu'une reprise best-effort */ }
}

const frame          = document.getElementById("siteFrame");
const btnDownload     = document.getElementById("btnDownload");
const btnReset         = document.getElementById("btnReset");
const btnUndo          = document.getElementById("btnUndo");
const btnAddProject    = document.getElementById("btnAddProject");
const saveStatus       = document.getElementById("saveStatus");
const fileInput        = document.getElementById("fileInput");
const toastEl          = document.getElementById("toast");

const colorInputs = {
  "--red":   document.getElementById("colorRed"),
  "--ink":   document.getElementById("colorInk"),
  "--yellow":document.getElementById("colorYellow"),
  "--paper": document.getElementById("colorPaper"),
};

let currentImageTarget = null;
let saveTimer = null;
let undoStack = [];
const MAX_UNDO = 60;

const TEXT_SELECTOR = [
  ".card__brand", ".role", ".about-bio",
  ".page__text p", ".page__list li", ".page__tags span",
  ".stat", ".occupation__label", ".occupation__info h3", ".occupation__info p",
  ".occupation__stat", ".stack-tag", ".itch-link",
  ".timeline__date", ".timeline__title", ".timeline__text",
].join(", ");

// ---------------------------------------------------------------
// Icônes — SVG monochromes, jamais d'emoji
// ---------------------------------------------------------------
const ICONS = {
  image:  `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="3" width="13" height="10" rx="1.2"/><circle cx="5.5" cy="6.8" r="1.1"/><path d="M2 11.5l3.2-3.2 2.6 2.6 2-2 3.2 3.2"/></svg>`,
  link:   `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.3 9.7l3.4-3.4M6 5.6 7.3 4.3a2.3 2.3 0 0 1 3.3 3.3L9.3 8.9M10 10.4l-1.3 1.3a2.3 2.3 0 0 1-3.3-3.3L6.7 7.1"/></svg>`,
  delete: `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  rename: `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M10.5 2.5l3 3-7.6 7.6H3v-2.9l7.5-7.7Z"/></svg>`,
  edit:   `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M10.5 2.5l3 3-7.6 7.6H3v-2.9l7.5-7.7Z"/></svg>`,
};

function toast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add("is-visible");
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove("is-visible"), 2600);
}

// ---------------------------------------------------------------
// Undo
// ---------------------------------------------------------------
function recordUndo(fn){
  undoStack.push(fn);
  if(undoStack.length > MAX_UNDO) undoStack.shift();
  btnUndo.disabled = false;
}
function undo(){
  const fn = undoStack.pop();
  if(!fn){ toast("Rien à annuler"); return; }
  fn();
  btnUndo.disabled = undoStack.length === 0;
  saveDraft();
  toast("Annulé");
}
btnUndo.addEventListener("click", undo);
btnUndo.disabled = true;
document.addEventListener("keydown", (e) => {
  if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z"){ e.preventDefault(); undo(); }
});

// ---------------------------------------------------------------
// Popovers (aide + palettes) — se ferment au clic dehors, MÊME si
// ce clic a lieu à l'intérieur de l'iframe, et via un bouton ✕ direct.
// ---------------------------------------------------------------
const btnHelp = document.getElementById("btnHelp");
const helpPopover = document.getElementById("helpPopover");
const helpClose = document.getElementById("helpClose");

function toggleHelp(){ helpPopover.hidden = !helpPopover.hidden; }
function closeHelp(){ helpPopover.hidden = true; }
btnHelp.addEventListener("click", (e) => { e.stopPropagation(); toggleHelp(); });
helpClose.addEventListener("click", closeHelp);

const btnPalettes = document.getElementById("btnPalettes");
const palettePopover = document.getElementById("palettePopover");
const paletteGrid = document.getElementById("paletteGrid");
const paletteContext = document.getElementById("paletteContext");
const paletteClose = document.getElementById("paletteClose");

function togglePalettes(){
  palettePopover.hidden = !palettePopover.hidden;
  if(!palettePopover.hidden) buildPalettePopover();
}
function closePalettes(){ palettePopover.hidden = true; }
btnPalettes.addEventListener("click", (e) => { e.stopPropagation(); togglePalettes(); });
paletteClose.addEventListener("click", closePalettes);

document.addEventListener("click", (e) => {
  if(!helpPopover.hidden && !helpPopover.contains(e.target) && e.target !== btnHelp) closeHelp();
  if(!palettePopover.hidden && !palettePopover.contains(e.target) && !btnPalettes.contains(e.target)) closePalettes();
});

// ---------------------------------------------------------------
// Couleurs — conscientes du thème clair/sombre du site. Chaque
// thème a son propre jeu de 4 variables, appliqué via une règle CSS
// scopée (jamais de style inline qui écraserait l'autre thème).
// ---------------------------------------------------------------
let colorOverrides = { light:{}, dark:{} };

function currentTheme(doc){
  return doc && doc.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function applyColorsToFrame(){
  const doc = frame.contentDocument;
  if(!doc) return;
  const theme = currentTheme(doc);
  Object.entries(colorInputs).forEach(([varName, input]) => {
    colorOverrides[theme][varName] = input.value;
  });
  renderColorOverrideStyle(doc);
}

function renderColorOverrideStyle(doc){
  let styleEl = doc.getElementById("editor-color-override");
  if(!styleEl){
    styleEl = doc.createElement("style");
    styleEl.id = "editor-color-override";
    doc.head.appendChild(styleEl);
  }
  const lightVars = Object.entries(colorOverrides.light).map(([k,v]) => `${k}:${v};`).join("");
  const darkVars  = Object.entries(colorOverrides.dark).map(([k,v]) => `${k}:${v};`).join("");
  styleEl.textContent =
    (lightVars ? `html:not([data-theme="dark"]){ ${lightVars} }\n` : "") +
    (darkVars  ? `html[data-theme="dark"]{ ${darkVars} }` : "");
}

function syncColorInputsFromFrame(doc){
  const theme = currentTheme(doc);
  const computed = doc.defaultView.getComputedStyle(doc.documentElement);
  Object.entries(colorInputs).forEach(([varName, input]) => {
    const stored = colorOverrides[theme][varName];
    if(stored){ input.value = stored; return; }
    const val = computed.getPropertyValue(varName).trim();
    if(/^#[0-9a-f]{6}$/i.test(val)) input.value = val;
  });
}

Object.values(colorInputs).forEach(input => {
  input.addEventListener("input", () => { applyColorsToFrame(); scheduleSave(); });
});

// Regarde si le site bascule de thème (clic sur le switch à l'intérieur
// de l'iframe) pour re-synchroniser pastilles + liste de palettes.
function watchThemeChanges(doc){
  if(doc._themeObserverBound) return;
  doc._themeObserverBound = true;
  const observer = new MutationObserver(() => {
    syncColorInputsFromFrame(doc);
    if(!palettePopover.hidden) buildPalettePopover();
  });
  observer.observe(doc.documentElement, { attributes:true, attributeFilter:["data-theme"] });
}

// ---------------------------------------------------------------
// Palettes prêtes à l'emploi — 10 en clair, 10 en sombre, choisies
// en couleurs complémentaires avec assez de contraste texte/fond.
// ---------------------------------------------------------------
const LIGHT_PALETTES = [
  { name:"Corail & Nuit",   red:"#e4483f", ink:"#1b2a4a", yellow:"#f2c94c", paper:"#f2e9d8" },
  { name:"Émeraude Chaude", red:"#e07a3f", ink:"#123524", yellow:"#d4a24c", paper:"#eef2e6" },
  { name:"Violet Doux",     red:"#8b5cf6", ink:"#1e1b3a", yellow:"#f2c94c", paper:"#f3efff" },
  { name:"Corail Estival",  red:"#ff6b4a", ink:"#2b1b17", yellow:"#ffb84d", paper:"#fff3e8" },
  { name:"Bleu Glacier",    red:"#3b82f6", ink:"#0f2942", yellow:"#e8965a", paper:"#eaf3fa" },
  { name:"Rose Poudré",     red:"#d1495b", ink:"#2e2532", yellow:"#e8b4bc", paper:"#faf1ee" },
  { name:"Forêt Automne",   red:"#c1440e", ink:"#22331b", yellow:"#e0a458", paper:"#f2ede1" },
  { name:"Terracotta",      red:"#c1502e", ink:"#3d2b1f", yellow:"#dba159", paper:"#f5e9d9" },
  { name:"Menthe Fraîche",  red:"#ef6461", ink:"#16302b", yellow:"#e4b363", paper:"#eef7f2" },
  { name:"Prune & Or",      red:"#a44a3f", ink:"#2f1e2e", yellow:"#d4af37", paper:"#f4ece6" },
];

const DARK_PALETTES = [
  { name:"Corail & Nuit",   red:"#ff6259", ink:"#f0eee6", yellow:"#ffd166", paper:"#12141c" },
  { name:"Émeraude Sombre", red:"#4fd1a5", ink:"#eaf5ee", yellow:"#e8c468", paper:"#0f1a15" },
  { name:"Violet Cyber",    red:"#a78bfa", ink:"#f1edff", yellow:"#fbbf24", paper:"#161226" },
  { name:"Braise",          red:"#ff7a59", ink:"#fbe9e0", yellow:"#ffb454", paper:"#1a1210" },
  { name:"Glacier Nuit",    red:"#60a5fa", ink:"#e8f1fb", yellow:"#f0b45e", paper:"#0d1520" },
  { name:"Rose Nuit",       red:"#f472b6", ink:"#fbe8f0", yellow:"#f3d17a", paper:"#1c1218" },
  { name:"Automne Sombre",  red:"#e8874a", ink:"#f2e9db", yellow:"#e0b464", paper:"#191410" },
  { name:"Terracotta Nuit", red:"#e0784f", ink:"#f5e6d8", yellow:"#e4b56a", paper:"#1b1410" },
  { name:"Menthe Nuit",     red:"#ef8477", ink:"#e3f5ec", yellow:"#e8c26e", paper:"#0e1815" },
  { name:"Prune & Or Nuit", red:"#d17a6a", ink:"#f2e6ec", yellow:"#e8c458", paper:"#1a1420" },
];

function buildPalettePopover(){
  const doc = frame.contentDocument;
  const theme = currentTheme(doc);
  const list = theme === "dark" ? DARK_PALETTES : LIGHT_PALETTES;
  paletteContext.textContent = "Palettes — " + (theme === "dark" ? "sombre" : "clair");
  paletteGrid.innerHTML = "";
  list.forEach(p => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-swatch";
    btn.innerHTML = `
      <span class="palette-swatch__preview">
        <span style="background:${p.paper}"></span><span style="background:${p.ink}"></span><span style="background:${p.red}"></span><span style="background:${p.yellow}"></span>
      </span>
      <span class="palette-swatch__name">${p.name}</span>
    `;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      colorInputs["--red"].value = p.red;
      colorInputs["--ink"].value = p.ink;
      colorInputs["--yellow"].value = p.yellow;
      colorInputs["--paper"].value = p.paper;
      applyColorsToFrame();
      scheduleSave();
      closePalettes();
      toast(`Palette "${p.name}" appliquée`);
    });
    paletteGrid.appendChild(btn);
  });
}

// ---------------------------------------------------------------
// Chargement fiable de l'iframe (vraie navigation vers un Blob avec
// <base> explicite) + filet de sécurité si la page semble cassée.
// ---------------------------------------------------------------
function loadHtmlIntoFrame(html, callback){
  let finalHtml = /^\s*<!doctype/i.test(html) ? html : "<!DOCTYPE html>\n" + html;
  const baseUrl = new URL("../index.html", window.location.href).href;
  finalHtml = finalHtml.replace(/<base[^>]*>/gi, "");
  finalHtml = finalHtml.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n<base href="${baseUrl}">`);

  const blob = new Blob([finalHtml], { type: "text/html" });
  const url = URL.createObjectURL(blob);

  function onLoad(){
    frame.removeEventListener("load", onLoad);
    URL.revokeObjectURL(url);

    const doc = frame.contentDocument;
    const looksValid = doc && doc.querySelector(".card__topbar") && doc.querySelector(".card__body") && doc.querySelector(".pill-row");
    if(!looksValid){
      toast("⚠ La page semblait cassée après ce changement — annulé automatiquement");
      idbGet(DRAFT_KEY).then((lastGood) => {
        if(lastGood && lastGood !== finalHtml){
          loadHtmlIntoFrame(lastGood, callback);
        }else{
          frame.addEventListener("load", callback, { once: true });
          frame.src = "../index.html?_=" + Date.now();
        }
      }).catch(() => {
        frame.addEventListener("load", callback, { once: true });
        frame.src = "../index.html?_=" + Date.now();
      });
      return;
    }
    callback();
  }
  frame.addEventListener("load", onLoad, { once: true });
  frame.src = url;
}

// ---------------------------------------------------------------
// Chargement initial
// ---------------------------------------------------------------
frame.addEventListener("load", onFirstLoad, { once: true });

async function onFirstLoad(){
  await migrateLegacyLocalStorageDraft();
  let draft = null;
  try{ draft = await idbGet(DRAFT_KEY); }catch(err){ /* stockage indisponible : on repart du site tel quel */ }
  if(draft){
    loadHtmlIntoFrame(draft, () => { toast("Brouillon précédent restauré"); injectEditing(); });
  }else{
    injectEditing();
  }
}

// ---------------------------------------------------------------
// Injection des capacités d'édition
// ---------------------------------------------------------------
function injectEditing(){
  const doc = frame.contentDocument;
  if(!doc) return;

  try{
    injectEditingInner(doc);
  }catch(err){
    console.error("injectEditing() a rencontré une erreur :", err);
    toast("⚠ Un problème est survenu pendant le branchement de l'éditeur — regarde la console (F12) si des contrôles ne répondent plus");
  }
}

function injectEditingInner(doc){
  syncColorInputsFromFrame(doc);
  renderColorOverrideStyle(doc);
  watchThemeChanges(doc);

  if(!doc.getElementById("editor-injected-style")){
    const style = doc.createElement("style");
    style.id = "editor-injected-style";
    style.textContent = `
      ${TEXT_SELECTOR}{
        outline:2px dashed transparent; outline-offset:2px; cursor:text;
        transition:outline-color .15s ease, background-color .15s ease;
      }
      ${TEXT_SELECTOR}:hover{ outline-color:#5B8DEF; background-color:rgba(91,141,239,.07); }
      ${TEXT_SELECTOR}:focus{ outline-color:#4CAF6D; background-color:rgba(76,175,109,.08); }

      .editor-badges{
        position:absolute; top:6px; right:6px; z-index:40;
        display:flex; gap:4px;
        opacity:0; transition:opacity .15s ease;
      }
      :hover > .editor-badges{ opacity:1; }
      .editor-badge{
        width:22px; height:22px; border-radius:50%;
        background:rgba(20,20,24,.82); border:1.5px solid #5B8DEF;
        color:#fff; display:flex; align-items:center; justify-content:center;
        cursor:pointer; padding:0;
      }
      .editor-badge:hover{ background:#5B8DEF; }
      .editor-badge--danger{ border-color:#E4483F; }
      .editor-badge--danger:hover{ background:#E4483F; }
      .editor-img-wrap{ position:relative; width:100%; height:100%; }
      .editor-add-tag{
        font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:700;
        color:#5B8DEF; background:transparent; border:1.5px dashed #5B8DEF;
        border-radius:100px; padding:3px 9px; cursor:pointer; opacity:.7;
      }
      .editor-add-tag:hover{ opacity:1; background:rgba(91,141,239,.12); }
      .editor-timeline-insert{
        position:relative; z-index:10;
        flex:0 0 auto; align-self:center;
        width:26px; height:26px; border-radius:50%;
        display:flex; align-items:center; justify-content:center;
        font-family:'JetBrains Mono',monospace; font-size:16px; font-weight:700; line-height:1;
        color:#5B8DEF; background:#fff; border:2px solid #5B8DEF;
        box-shadow:0 2px 6px rgba(91,141,239,.35);
        cursor:pointer; opacity:.7; padding:0;
        transition:opacity .15s ease, transform .15s ease, background .15s ease, color .15s ease;
      }
      .editor-timeline-insert:hover{ opacity:1; background:#5B8DEF; color:#fff; transform:scale(1.18); }
    `;
    doc.head.appendChild(style);
  }

  doc.querySelectorAll(TEXT_SELECTOR).forEach(wireTextElement);

  // About me : le stack technique garde son "+ tag" simple, comme avant
  doc.querySelectorAll(".stack-row").forEach(row => addTagButton(row));

  // Frise chronologique : chaque étape est câblée (texte, photo, badge
  // de suppression sur la carte) et de petits "+" permettent d'insérer
  // une nouvelle étape n'importe où — pas seulement à la fin.
  doc.querySelectorAll(".timeline__scroll").forEach(scroll => {
    scroll.querySelectorAll(".timeline__node").forEach(node => wireTimelineNode(node, scroll));
    renderTimelineInsertPoints(scroll);
  });

  // Images
  const avatarImg = doc.querySelector(".avatar");
  if(avatarImg) addBadges(doc.querySelector(".avatar-frame") || avatarImg, [
    { icon:"image", title:"Changer la photo", onClick:() => openImagePicker(avatarImg) },
  ]);
  doc.querySelectorAll(".page__img").forEach(img => {
    const wrap = wrapImageForBadge(img);
    addBadges(wrap, [{ icon:"image", title:"Changer l'image", onClick:() => openImagePicker(img) }]);
  });
  doc.querySelectorAll(".occupation").forEach(occ => {
    addBadges(occ, [{ icon:"image", title:"Changer l'image de fond", onClick:() => openImagePicker(occ) }]);
  });

  // itch-link : lien seulement — suppression et tags gérés dans le
  // panneau de projet désormais
  doc.querySelectorAll(".itch-link").forEach(a => {
    addBadges(a, [{ icon:"link", title:"Changer l'URL", onClick:() => editLink(a) }]);
  });

  // boutons réseau social insérés dans une passion (Letterboxd dans
  // Cinéma, Spotify dans Musique...) : lien modifiable comme les autres.
  // Le bouton Photo partage la même classe pour le style mais c'est un
  // <button> qui ouvre le tableau en liège, pas un <a> — exclu ici.
  doc.querySelectorAll("a.occupation__social").forEach(a => {
    addBadges(a, [{ icon:"link", title:"Changer l'URL", onClick:() => editLink(a) }]);
  });

  // ---- Tableau photo : photos existantes éditables, bouton d'ajout.
  // Le positionnement est entièrement délégué à relayoutCorkboard()
  // (définie dans main.js) qui recalcule une vraie grille adaptée au
  // nombre de photos à chaque ajout/suppression — jamais de chevauchement,
  // même avec beaucoup de photos.
  function relayoutCork(){
    const fn = doc.defaultView && doc.defaultView.relayoutCorkboard;
    if(typeof fn === "function") fn();
  }
  function wireCorkpin(pin){
    const img = pin.querySelector("img");
    addBadges(pin, [
      { icon:"image", title:"Changer la photo", onClick:() => openImagePicker(img) },
      { icon:"delete", title:"Supprimer cette photo", danger:true, onClick:() => { removeSimple(pin); relayoutCork(); } },
    ]);
  }
  const corkboardPinsEl = doc.getElementById("corkboardPins");
  if(corkboardPinsEl){
    corkboardPinsEl.querySelectorAll(".corkpin").forEach(wireCorkpin);
    const surface = doc.querySelector(".corkboard__surface");
    if(surface && !surface.querySelector(".editor-add-photo")){
      const addBtn = doc.createElement("button");
      addBtn.type = "button";
      addBtn.className = "editor-add-photo";
      addBtn.textContent = "+ Ajouter une photo";
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const pin = doc.createElement("button");
        pin.type = "button"; pin.className = "corkpin";
        const nail = doc.createElement("span"); nail.className = "corkpin__nail";
        const frame = doc.createElement("span"); frame.className = "corkpin__frame";
        const img = doc.createElement("img");
        img.src = "https://placehold.co/300x300/2a2a2a/888888?text=%F0%9F%93%B7"; img.alt = "";
        frame.appendChild(img);
        pin.appendChild(nail); pin.appendChild(frame);
        corkboardPinsEl.appendChild(pin);
        wireCorkpin(pin);
        pin.addEventListener("click", (e2) => {
          if(e2.target.closest(".editor-badges")) return;
          const openFn = doc.defaultView && doc.defaultView.openCorkViewer;
          if(typeof openFn === "function") openFn(img.src);
        });
        relayoutCork();
        recordUndo(() => { pin.remove(); relayoutCork(); });
        saveDraft();
      });
      surface.appendChild(addBtn);
    }
  }

  const resumeBtn = doc.querySelector(".resume-btn");
  if(resumeBtn) addBadges(resumeBtn, [{ icon:"link", title:"Changer l'URL", onClick:() => editLink(resumeBtn) }]);

  doc.querySelectorAll(".socials li").forEach(li => {
    addBadges(li, [{ icon:"delete", title:"Retirer ce réseau", danger:true, onClick:() => removeSimple(li) }]);
  });
  doc.querySelectorAll(".socials a").forEach(a => {
    if(a._socialWired) return;
    a._socialWired = true;
    a.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); editLink(a); });
  });

  // Stack technique (About me) : suppression seulement, texte déjà éditable
  doc.querySelectorAll(".stack-tag").forEach(tag => {
    addBadges(tag, [{ icon:"delete", title:"Supprimer ce tag", danger:true, onClick:() => removeSimple(tag) }]);
  });

  // Tabs : renommer seulement
  doc.querySelectorAll(".tab").forEach(tab => {
    addBadges(tab, [{ icon:"rename", title:"Renommer", onClick:() => renameSimple(tab) }]);
  });

  // Sous-onglets About Me (Moi / Mes passions) : renommer seulement,
  // en préservant les deux langues (contrairement aux onglets
  // principaux Projects/About me, ceux-ci sont bilingues)
  doc.querySelectorAll(".about-tab").forEach(tab => {
    addBadges(tab, [{ icon:"rename", title:"Renommer", onClick:() => renameBilingualTab(tab) }]);
  });

  // Pills : ouvre le panneau complet du projet (plus un simple prompt)
  doc.querySelectorAll(".pill").forEach(pill => {
    addBadges(pill, [
      { icon:"edit", title:"Éditer ce projet en détail", onClick:() => openProjectEditor(pill.dataset.project) },
      { icon:"delete", title:"Supprimer ce projet", danger:true, onClick:() => removeProject(pill.dataset.project) },
    ]);
  });

  // Ferme les popovers si on clique dans l'iframe (sinon ils restent
  // ouverts au-dessus pendant qu'on édite, gênant)
  if(!doc._closesPopovers){
    doc._closesPopovers = true;
    doc.addEventListener("click", () => { closeHelp(); closePalettes(); }, true);
  }
}

// <img> ne peut pas avoir d'enfants : on l'enveloppe pour positionner un badge
function wrapImageForBadge(img){
  if(img.parentElement && img.parentElement.classList.contains("editor-img-wrap")) return img.parentElement;
  const doc = img.ownerDocument;
  const wrap = doc.createElement("div");
  wrap.className = "editor-img-wrap";
  img.parentNode.insertBefore(wrap, img);
  wrap.appendChild(img);
  return wrap;
}

// Badge d'action générique — des <span>, jamais des <button> : ces
// badges finissent parfois à l'intérieur d'un <button> ou d'un <a>
// (pill, tab, itch-link...) et un bouton imbriqué dans un bouton est
// du HTML invalide, ce que le navigateur "corrige" en cassant la
// page au rechargement. Un <span> avec juste un clic JS reste
// valide partout, sans ce risque.
function addBadges(hostEl, actions){
  if(hostEl.querySelector(":scope > .editor-badges")) return;
  const doc = hostEl.ownerDocument;
  // Ne force "relative" que si l'élément n'est pas déjà positionné —
  // sinon on écrase un position:absolute existant (c'était le bug de
  // la croix mal placée sur les étapes de la frise en bas de ligne).
  const currentPosition = doc.defaultView.getComputedStyle(hostEl).position;
  if(currentPosition === "static") hostEl.style.position = "relative";
  const wrap = doc.createElement("span");
  wrap.className = "editor-badges";
  wrap.setAttribute("contenteditable", "false");
  actions.forEach(a => {
    const btn = doc.createElement("span");
    btn.className = "editor-badge" + (a.danger ? " editor-badge--danger" : "");
    btn.innerHTML = ICONS[a.icon] || "";
    btn.title = a.title;
    btn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); a.onClick(); });
    wrap.appendChild(btn);
  });
  hostEl.appendChild(wrap);
}

// ---------------------------------------------------------------
// Texte — toujours éditable au clic, undo au blur si modifié
// ---------------------------------------------------------------
function wireTextElement(el){
  if(el._wired) return;
  el._wired = true;
  el.setAttribute("contenteditable", "true");
  const doc = el.ownerDocument;
  let before = null;
  // Un clic pour positionner le curseur dans le texte ne doit jamais
  // déclencher AUSSI le comportement du parent (ex : les "occupations"
  // de Mes passions sont des <button> qui changent d'état actif au
  // clic — sans ça, cliquer pour éditer le texte coupait le focus en
  // relançant l'animation d'agrandissement au même moment).
  el.addEventListener("click", (e) => { e.stopPropagation(); });
  el.addEventListener("mousedown", (e) => { e.stopPropagation(); });
  el.addEventListener("focus", () => { before = el.innerHTML; });
  el.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || doc.defaultView.clipboardData).getData("text/plain");
    doc.execCommand("insertText", false, text);
  });
  el.addEventListener("input", scheduleSave);
  el.addEventListener("blur", () => {
    if(before !== null && before !== el.innerHTML){
      const prevHtml = before;
      recordUndo(() => { el.innerHTML = prevHtml; syncLangAttribute(el); });
    }
    syncLangAttribute(el);
    saveDraft();
  });
}

function syncLangAttribute(el){
  if(el.dataset.fr === undefined || el.dataset.en === undefined) return;
  const doc = el.ownerDocument;
  const lang = doc.documentElement.lang === "en" ? "en" : "fr";
  el.dataset[lang] = el.innerHTML;
}

function renameSimple(el){
  const prev = el.textContent.trim();
  const next = prompt("Nouveau texte :", prev);
  if(next === null || next.trim() === "") return;
  el.textContent = next.trim();
  recordUndo(() => { el.textContent = prev; });
  saveDraft();
  toast("Renommé");
}

// Comme renameSimple, mais pour un bouton dont le texte est porté par un
// <span data-fr data-en> à l'intérieur — on édite ce span et seulement
// la langue actuellement active, pour ne jamais perdre l'autre langue.
function renameBilingualTab(tab){
  const span = tab.querySelector("span[data-fr]") || tab;
  const prev = span.textContent.trim();
  const next = prompt("Nouveau texte :", prev);
  if(next === null || next.trim() === "") return;
  const doc = tab.ownerDocument;
  const lang = doc.documentElement.lang === "en" ? "en" : "fr";
  span.textContent = next.trim();
  span.dataset[lang] = next.trim();
  recordUndo(() => { span.textContent = prev; span.dataset[lang] = prev; });
  saveDraft();
  toast("Renommé");
}

function editLink(el){
  const prev = el.getAttribute("href") || "";
  const next = prompt("Nouvelle URL :", prev);
  if(next === null || next.trim() === "") return;
  el.setAttribute("href", next.trim());
  recordUndo(() => el.setAttribute("href", prev));
  saveDraft();
  toast("Lien mis à jour");
}

function removeSimple(el){
  const parent = el.parentNode;
  const nextSibling = el.nextSibling;
  el.remove();
  recordUndo(() => parent.insertBefore(el, nextSibling));
  saveDraft();
  toast("Supprimé");
}

// ---------------------------------------------------------------
// Upload d'image → redimensionnement → data URL, avec undo
// ---------------------------------------------------------------
function openImagePicker(target){
  currentImageTarget = target;
  peImageTargetBlock = null;
  fileInput.value = "";
  fileInput.click();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if(!file || !currentImageTarget) return;
  const target = currentImageTarget;
  const isImg = target.tagName === "IMG";
  const prevValue = isImg ? target.src : target.style.backgroundImage;
  const isGif = file.type === "image/gif";

  const finish = (dataUrl) => {
    if(isImg) target.src = dataUrl; else target.style.backgroundImage = `url('${dataUrl}')`;
    recordUndo(() => { if(isImg) target.src = prevValue; else target.style.backgroundImage = prevValue; });
    saveDraft();
    toast(isGif ? "GIF mis à jour (animation conservée)" : "Image mise à jour");
  };

  const reader = new FileReader();
  if(isGif){
    // Un canvas ne capture qu'une image fixe : pour un GIF, on garde
    // le fichier tel quel afin de préserver l'animation.
    reader.onload = (e) => finish(e.target.result);
    reader.readAsDataURL(file);
    return;
  }

  const img = new Image();
  reader.onload = (e) => {
    img.onload = () => {
      const MAX = 640;
      let { width, height } = img;
      if(width > MAX || height > MAX){
        const ratio = Math.min(MAX / width, MAX / height);
        width = Math.round(width * ratio); height = Math.round(height * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      finish(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
});

// ---------------------------------------------------------------
// "+ tag" simple, gardé pour le stack technique d'About me
// ---------------------------------------------------------------
function addTagButton(row){
  if(row.querySelector(".editor-add-tag")) return;
  const doc = row.ownerDocument;
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "editor-add-tag";
  btn.textContent = "+ tag";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const span = doc.createElement("span");
    span.className = "stack-tag";
    span.textContent = "Nouveau";
    span.dataset.fr = "Nouveau"; span.dataset.en = "New";
    row.insertBefore(span, btn);
    wireTextElement(span);
    addBadges(span, [{ icon:"delete", title:"Supprimer ce tag", danger:true, onClick:() => removeSimple(span) }]);
    span.focus();
    const range = doc.createRange(); range.selectNodeContents(span);
    const sel = doc.defaultView.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    recordUndo(() => span.remove());
    saveDraft();
  });
  row.appendChild(btn);
}

// Frise chronologique : bouton "+ Ajouter une étape", toujours inséré
// juste avant l'étape finale d'appel à recrutement (qui reste la dernière).
// Recalcule l'alternance haut/bas de toutes les étapes après un ajout
// ou une suppression, pour que ça reste cohérent quoi qu'il arrive.
function updateTimelineAlternation(scroll){
  [...scroll.querySelectorAll(".timeline__node")].forEach((node, i) => {
    node.classList.remove("timeline__node--up", "timeline__node--down");
    node.classList.add(i % 2 === 0 ? "timeline__node--up" : "timeline__node--down");
  });
}

// Construit une nouvelle étape "vide", prête à être insérée n'importe où.
function buildTimelineNode(doc){
  const node = doc.createElement("div");
  node.className = "timeline__node";

  const dot = doc.createElement("span");
  dot.className = "timeline__dot";

  const card = doc.createElement("div");
  card.className = "timeline__card";

  const photoFrame = doc.createElement("div");
  photoFrame.className = "timeline__photo-frame";
  const img = doc.createElement("img");
  img.className = "timeline__photo";
  img.src = "https://placehold.co/160x160/1B2A4A/F7F3EC?text=%F0%9F%93%B7";
  img.alt = "";
  photoFrame.appendChild(img);

  const date = doc.createElement("span");
  date.className = "timeline__date";
  date.textContent = "Année"; date.dataset.fr = "Année"; date.dataset.en = "Year";
  const title = doc.createElement("h4");
  title.className = "timeline__title";
  title.textContent = "Nouvelle étape"; title.dataset.fr = "Nouvelle étape"; title.dataset.en = "New milestone";

  card.appendChild(photoFrame); card.appendChild(date); card.appendChild(title);
  node.appendChild(dot); node.appendChild(card);
  return node;
}

// Câble une étape : texte éditable, badge photo, et badge de suppression
// posé sur la CARTE elle-même (jamais sur le nœud entier, dont la
// hauteur couvre aussi le point de la ligne — c'était ça qui décalait
// la croix selon que l'étape soit en haut ou en bas).
function wireTimelineNode(node, scroll){
  node.querySelectorAll(TEXT_SELECTOR).forEach(wireTextElement);
  const img = node.querySelector(".timeline__photo");
  if(img){
    const wrap = wrapImageForBadge(img);
    addBadges(wrap, [{ icon:"image", title:"Changer la photo", onClick:() => openImagePicker(img) }]);
  }
  if(!node.classList.contains("timeline__node--cta")){
    const card = node.querySelector(".timeline__card");
    addBadges(card, [{ icon:"delete", title:"Supprimer cette étape", danger:true, onClick:() => {
      node.remove();
      updateTimelineAlternation(scroll);
      renderTimelineInsertPoints(scroll);
      saveDraft();
    } }]);
  }
}

// Petits "+" entre chaque étape (et avant la toute première) pour
// insérer une nouvelle étape n'importe où dans la frise — pas
// seulement à la fin avec un gros bouton.
function renderTimelineInsertPoints(scroll){
  scroll.querySelectorAll(".editor-timeline-insert").forEach(el => el.remove());
  const doc = scroll.ownerDocument;
  [...scroll.querySelectorAll(".timeline__node")].forEach(beforeNode => {
    const marker = doc.createElement("button");
    marker.type = "button";
    marker.className = "editor-timeline-insert";
    marker.title = "Insérer une étape ici";
    marker.textContent = "+";
    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      const newNode = buildTimelineNode(doc);
      scroll.insertBefore(newNode, beforeNode);
      updateTimelineAlternation(scroll);
      wireTimelineNode(newNode, scroll);
      renderTimelineInsertPoints(scroll);
      newNode.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" });
      recordUndo(() => { newNode.remove(); updateTimelineAlternation(scroll); renderTimelineInsertPoints(scroll); });
      saveDraft();
    });
    scroll.insertBefore(marker, beforeNode);
  });
}

/* ==================================================================
   PANNEAU D'ÉDITION DE PROJET — un canevas quadrillé par page, une
   palette de modules à glisser dessus, des onglets pour naviguer
   entre les pages. On lit l'état actuel depuis le DOM à l'ouverture,
   on travaille sur une copie JS, et "Appliquer" réécrit le tiroir du
   projet en une fois.
================================================================== */
const projectEditor   = document.getElementById("projectEditor");
const editorStage       = document.querySelector(".editor-stage");
const peCloseBtn        = document.getElementById("peCloseBtn");
const pePageTabs         = document.getElementById("pePageTabs");
const pePalette           = document.getElementById("pePalette");
const peCanvas              = document.getElementById("peCanvas");
const peApply                 = document.getElementById("peApply");
const peProjectLabel            = document.getElementById("peProjectLabel");
peProjectLabel.addEventListener("input", () => liveUpdateSite());

let peState = null;        // { projectId, pillLabel, activePage, pages:[{imgSrc, imgSize, blocks:[...]}] }
let peCurrentPillEl = null;

const BLOCK_DEFS = {
  title:  { label:"Titre",        make:() => ({ type:"title", fr:"Titre", en:"Title" }) },
  text:   { label:"Texte",        make:() => ({ type:"text", style:"normal", fr:"Lorem ipsum dolor sit amet.", en:"Lorem ipsum dolor sit amet." }) },
  tags:   { label:"Tags",         make:() => ({ type:"tags", items:[{fr:"Tag", en:"Tag"}] }) },
  list:   { label:"Liste",        make:() => ({ type:"list", items:[{fr:"Élément", en:"Item"}] }) },
  stats:  { label:"Statistiques", make:() => ({ type:"stats", items:[{number:"0", fr:"métrique", en:"metric"}] }) },
  link:   { label:"Lien",         make:() => ({ type:"link", href:"#", fr:"Voir sur itch.io ↗", en:"View on itch.io ↗" }) },
  image:  { label:"Image",        make:() => ({ type:"image", src:"", imgSize:"normal", objectPosition:"50% 50%" }) },
  video:  { label:"Vidéo",        make:() => ({ type:"video", category:"video", mode:"youtube", src:"", youtubeId:"", itchUrl:"", imgSize:"twothirds", objectPosition:"50% 50%" }) },
  game:   { label:"Jeu itch.io",  make:() => ({ type:"video", category:"game", mode:"itch", src:"", youtubeId:"", itchUrl:"", imgSize:"twothirds", objectPosition:"50% 50%" }) },
};

// ---- Lecture du DOM vers l'état JS du panneau ----
function readAccent(el){
  const v = el.style.getPropertyValue("--accent-color");
  return v ? v.trim() : null;
}

function extractYouTubeId(url){
  const m = String(url || "").match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{6,})/);
  return m ? m[1] : "";
}

// itch.io fournit un code d'embed complet ("<iframe src='...'>...") depuis
// les réglages du jeu ("intégrer sur d'autres sites") — on accepte aussi
// bien ce code complet qu'une simple URL collée directement.
function extractEmbedUrl(input){
  const raw = String(input || "").trim();
  const m = raw.match(/src=["']([^"']+)["']/);
  return m ? m[1] : raw;
}

function readProjectState(projectId){
  const doc = frame.contentDocument;
  const pill = doc.querySelector(`.pill[data-project="${projectId}"]`);
  const drawer = doc.querySelector(`.project-drawer[data-drawer="${projectId}"]`);
  const lang = doc.documentElement.lang === "en" ? "en" : "fr";
  const ALIGN_FROM_CSS = { "flex-start":"top", "center":"center", "flex-end":"bottom" };
  const pages = [...drawer.querySelectorAll(".page")].map(page => {
    const heroImg = page.querySelector(".page__img");
    const heroVideo = page.querySelector(".page__hero-media");
    const textEl = page.querySelector(".page__text");
    const textAlign = ALIGN_FROM_CSS[textEl.style.justifyContent] || "top";
    const cols = page.style.gridTemplateColumns || "";
    const imgSize = detectImgSize(cols);
    const blocks = [];
    if(heroImg){
      blocks.push({ type:"image", src:heroImg.src, imgSize, objectPosition:heroImg.style.objectPosition || "50% 50%" });
    }else if(heroVideo){
      const v = heroVideo.querySelector("video");
      const ifr = heroVideo.querySelector("iframe");
      if(v){
        blocks.push({ type:"video", category:"video", mode:"upload", src:v.src, youtubeId:"", itchUrl:"", imgSize, objectPosition:v.style.objectPosition || "50% 50%" });
      }else if(ifr){
        const embedMode = heroVideo.dataset.embedMode === "itch" ? "itch" : "youtube";
        blocks.push(embedMode === "itch"
          ? { type:"video", category:"game", mode:"itch", src:"", youtubeId:"", itchUrl:ifr.src, imgSize }
          : { type:"video", category:"video", mode:"youtube", src:"", youtubeId:extractYouTubeId(ifr.src), itchUrl:"", imgSize });
      }
    }
    [...textEl.children].forEach(child => {
      if(child.classList.contains("editor-badges")) return;
      if(child.tagName === "H3"){
        blocks.push({ type:"title", fr:child.dataset.fr || child.textContent, en:child.dataset.en || child.textContent, accentColor:readAccent(child) });
      }else if(child.classList.contains("page__pitch")){
        blocks.push({ type:"text", style:"accent", fr:child.dataset.fr || child.innerHTML, en:child.dataset.en || child.innerHTML, accentColor:readAccent(child) });
      }else if(child.classList.contains("page__meta")){
        blocks.push({ type:"text", style:"discret", fr:child.dataset.fr || child.textContent, en:child.dataset.en || child.textContent });
      }else if(child.classList.contains("page__tags")){
        blocks.push({ type:"tags", accentColor:readAccent(child), items:[...child.children].filter(c=>!c.classList.contains("editor-badges")).map(s => ({ fr:s.dataset.fr || s.textContent, en:s.dataset.en || s.textContent })) });
      }else if(child.classList.contains("page__list")){
        blocks.push({ type:"list", accentColor:readAccent(child), items:[...child.children].map(li => ({ fr:(li.dataset.fr || li.textContent).replace(/<\/?strong>/g,""), en:(li.dataset.en || li.textContent).replace(/<\/?strong>/g,"") })) });
      }else if(child.classList.contains("page__stats")){
        blocks.push({ type:"stats", accentColor:readAccent(child), items:[...child.children].map(s => ({ number:s.querySelector("strong")?.textContent || "", fr:s.querySelector("span")?.dataset.fr || s.querySelector("span")?.textContent || "", en:s.querySelector("span")?.dataset.en || s.querySelector("span")?.textContent || "" })) });
      }else if(child.classList.contains("itch-link")){
        blocks.push({ type:"link", href:child.getAttribute("href") || "#", fr:child.dataset.fr || child.textContent, en:child.dataset.en || child.textContent, accentColor:readAccent(child) });
      }else if(child.classList.contains("page__photo")){
        blocks.push({ type:"image", src:child.src, imgSize:"normal", objectPosition:child.style.objectPosition || "50% 50%" });
      }else if(child.classList.contains("page__video")){
        const v = child.querySelector("video");
        blocks.push({ type:"video", category:"video", mode:"upload", src: v ? v.src : "", youtubeId:"", itchUrl:"", objectPosition: v ? (v.style.objectPosition || "50% 50%") : "50% 50%" });
      }else if(child.classList.contains("page__video-embed")){
        const ifr = child.querySelector("iframe");
        const src = ifr ? ifr.src : "";
        const embedMode = child.dataset.embedMode === "itch" ? "itch" : "youtube";
        blocks.push(embedMode === "itch"
          ? { type:"video", category:"game", mode:"itch", src:"", youtubeId:"", itchUrl:src }
          : { type:"video", category:"video", mode:"youtube", src:"", youtubeId: extractYouTubeId(src), itchUrl:"" });
      }else if(child.tagName === "P"){
        blocks.push({ type:"text", style:"normal", fr:child.dataset.fr || child.innerHTML, en:child.dataset.en || child.innerHTML });
      }
    });
    return { textAlign, blocks };
  });
  return { projectId, pillLabel: pill.textContent.trim(), activePage: 0, lang, pages };
}

// ---- Construction d'éléments DOM depuis l'état (jamais de HTML texte : pas de risque d'échappement) ----
const IMG_SIZE_COLUMNS = {
  small:"1fr 220px", normal:"1fr 320px", large:"1fr 420px",
  half:"1fr 1fr", twothirds:"1fr 2fr", full:"1fr",
};
function detectImgSize(cols){
  for(const [key, val] of Object.entries(IMG_SIZE_COLUMNS)){
    if(cols === val) return key;
  }
  return "normal";
}

function applyAccent(el, block){
  if(block.accentColor){
    el.dataset.accent = "1";
    el.style.setProperty("--accent-color", block.accentColor);
  }
}

function buildPageElement(doc, pageData){
  const page = doc.createElement("div");
  page.className = "page";

  const textWrap = doc.createElement("div");
  textWrap.className = "page__text";
  const ALIGN_TO_CSS = { top:"flex-start", center:"center", bottom:"flex-end" };
  textWrap.style.justifyContent = ALIGN_TO_CSS[pageData.textAlign] || "flex-start";

  // Affiche toujours le texte dans la langue ACTUELLEMENT active sur le
  // document cible (site réel ou copie en mémoire) — data-fr/data-en
  // restent tous les deux posés pour que le switch FR/EN du site
  // continue de fonctionner normalement ensuite.
  const lang = doc.documentElement.lang === "en" ? "en" : "fr";
  const pick = (obj) => (obj[lang] !== undefined && obj[lang] !== "" ? obj[lang] : obj.fr);

  let hero = null; // le premier bloc "image" OU "vidéo" rencontré devient le média principal (colonne fixe)

  pageData.blocks.forEach(b => {
    let el = null;
    if(b.type === "title"){ el = doc.createElement("h3"); el.textContent = pick(b); el.dataset.fr = b.fr; el.dataset.en = b.en; applyAccent(el, b); }
    else if(b.type === "text"){
      el = doc.createElement("p");
      if(b.style === "accent") el.className = "page__pitch";
      else if(b.style === "discret") el.className = "page__meta";
      if(b.style === "discret") el.textContent = pick(b); else el.innerHTML = pick(b);
      el.dataset.fr = b.fr; el.dataset.en = b.en;
      if(b.style === "accent") applyAccent(el, b);
    }
    else if(b.type === "tags"){
      el = doc.createElement("p"); el.className = "page__tags";
      b.items.forEach(t => { const s = doc.createElement("span"); s.textContent = pick(t); s.dataset.fr = t.fr; s.dataset.en = t.en; el.appendChild(s); });
      applyAccent(el, b);
    }
    else if(b.type === "list"){
      el = doc.createElement("ul"); el.className = "page__list";
      b.items.forEach(li => { const l = doc.createElement("li"); l.textContent = pick(li); l.dataset.fr = li.fr; l.dataset.en = li.en; el.appendChild(l); });
      applyAccent(el, b);
    }
    else if(b.type === "stats"){
      el = doc.createElement("div"); el.className = "page__stats";
      b.items.forEach(s => {
        const d = doc.createElement("div"); d.className = "stat";
        const strong = doc.createElement("strong"); strong.textContent = s.number;
        const span = doc.createElement("span"); span.textContent = pick(s); span.dataset.fr = s.fr; span.dataset.en = s.en;
        d.appendChild(strong); d.appendChild(span); el.appendChild(d);
      });
      applyAccent(el, b);
    }
    else if(b.type === "link"){
      el = doc.createElement("a"); el.className = "itch-link"; el.href = b.href || "#";
      el.textContent = pick(b); el.dataset.fr = b.fr; el.dataset.en = b.en;
      applyAccent(el, b);
    }
    else if(b.type === "image"){
      if(!hero){
        hero = b; // traité après la boucle : devient le média principal, hors du flux
      }else if(b.src){
        el = doc.createElement("img"); el.className = "page__photo"; el.src = b.src; el.alt = "";
        el.style.objectPosition = b.objectPosition || "50% 50%";
      }
    }
    else if(b.type === "video"){
      const hasContent = (b.mode === "youtube" && b.youtubeId) || (b.mode === "upload" && b.src) || (b.mode === "itch" && b.itchUrl);
      if(!hero && hasContent){
        hero = b;
      }else if(b.mode === "youtube" && b.youtubeId){
        el = doc.createElement("div"); el.className = "page__video-embed"; el.dataset.embedMode = "youtube";
        const ifr = doc.createElement("iframe");
        ifr.src = `https://www.youtube.com/embed/${b.youtubeId}`;
        ifr.title = "Vidéo YouTube";
        ifr.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
        ifr.allowFullscreen = true;
        el.appendChild(ifr);
      }else if(b.mode === "itch" && b.itchUrl){
        el = doc.createElement("div"); el.className = "page__video-embed"; el.dataset.embedMode = "itch";
        const ifr = doc.createElement("iframe");
        ifr.src = b.itchUrl;
        ifr.title = "Jeu itch.io";
        ifr.allow = "autoplay; fullscreen; gamepad";
        ifr.allowFullscreen = true;
        el.appendChild(ifr);
      }else if(b.mode === "upload" && b.src){
        el = doc.createElement("div"); el.className = "page__video";
        const v = doc.createElement("video");
        v.src = b.src; v.controls = true;
        v.style.objectPosition = b.objectPosition || "50% 50%";
        el.appendChild(v);
      }
    }
    if(el) textWrap.appendChild(el);
  });

  const hasOtherContent = textWrap.children.length > 0;
  if(hasOtherContent) page.appendChild(textWrap);

  if(!hero){
    // aucune image ni vidéo : le texte occupe toute la largeur, pas de
    // colonne fixe imposée pour rien.
    page.style.gridTemplateColumns = "1fr";
  }else if(hero.type === "image"){
    if(hero.imgSize && hero.imgSize !== "normal") page.style.gridTemplateColumns = IMG_SIZE_COLUMNS[hero.imgSize];
    const img = doc.createElement("img");
    img.className = "page__img";
    img.src = hero.src || "https://placehold.co/460x300/1B2A4A/F7F3EC?text=Image";
    img.alt = "";
    img.style.objectPosition = hero.objectPosition || "50% 50%";
    page.appendChild(img);
  }else if(hero.type === "video"){
    if(hero.imgSize && hero.imgSize !== "normal") page.style.gridTemplateColumns = IMG_SIZE_COLUMNS[hero.imgSize];
    // pleine largeur ET seul contenu de la page : occupe vraiment toute
    // la page (pas de plafond de hauteur, puisqu'il n'y a rien d'autre
    // avec qui partager l'espace).
    const capped = hero.imgSize === "full" && hasOtherContent;
    const wrap = doc.createElement("div");
    wrap.className = "page__hero-media" + (capped ? " page__hero-media--capped" : "");
    if(hero.mode === "youtube"){
      wrap.dataset.embedMode = "youtube";
      const ifr = doc.createElement("iframe");
      ifr.src = `https://www.youtube.com/embed/${hero.youtubeId}`;
      ifr.title = "Vidéo YouTube";
      ifr.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
      ifr.allowFullscreen = true;
      wrap.appendChild(ifr);
    }else if(hero.mode === "itch"){
      wrap.dataset.embedMode = "itch";
      const ifr = doc.createElement("iframe");
      ifr.src = hero.itchUrl;
      ifr.title = "Jeu itch.io";
      ifr.allow = "autoplay; fullscreen; gamepad";
      ifr.allowFullscreen = true;
      wrap.appendChild(ifr);
    }else{
      const v = doc.createElement("video");
      v.src = hero.src; v.controls = true;
      v.style.objectPosition = hero.objectPosition || "50% 50%";
      wrap.appendChild(v);
    }
    page.appendChild(wrap);
  }

  return page;
}

// ---- Ouverture / fermeture ----
let peOriginalHtml = null;
let peOriginalLabel = null;

function openProjectEditor(projectId){
  peState = readProjectState(projectId);
  peCurrentPillEl = frame.contentDocument.querySelector(`.pill[data-project="${projectId}"]`);

  const drawer = frame.contentDocument.querySelector(`.project-drawer[data-drawer="${projectId}"]`);
  peOriginalHtml = drawer.querySelector(".drawer__scroll").innerHTML;
  peOriginalLabel = peCurrentPillEl.textContent;

  peProjectLabel.value = peState.pillLabel;
  renderPanel();
  projectEditor.hidden = false;
  editorStage.classList.add("has-panel");
  syncSiteNavigation();
}

// discard=true : referme SANS garder les modifs (retour à l'état d'avant ouverture)
// discard=false : referme en gardant l'état actuel, déjà affiché en direct sur le site
function closeProjectEditor(discard){
  if(discard && peOriginalHtml !== null && peState){
    const doc = frame.contentDocument;
    const drawer = doc.querySelector(`.project-drawer[data-drawer="${peState.projectId}"]`);
    if(drawer){
      drawer.querySelector(".drawer__scroll").innerHTML = peOriginalHtml;
      if(peCurrentPillEl) peCurrentPillEl.textContent = peOriginalLabel;
      injectEditing();
    }
  }
  projectEditor.hidden = true;
  editorStage.classList.remove("has-panel");
  peState = null;
  peOriginalHtml = null;
  peOriginalLabel = null;
}
peCloseBtn.addEventListener("click", () => closeProjectEditor(true));
document.addEventListener("keydown", (e) => {
  if(e.key === "Escape" && !projectEditor.hidden) closeProjectEditor(true);
});

// ---- Rendu global ----
function renderPanel(){
  updateLangBadge();
  renderPageTabs();
  renderPalette();
  renderCanvas();
}

// ---- Bandeau langue : indique et permet de changer la langue éditée ----
const peLangBadge = document.getElementById("peLangBadge");

function updateLangBadge(){
  if(!peState) return;
  peLangBadge.textContent = peState.lang === "en" ? "EN" : "FR";
}

peLangBadge.addEventListener("click", () => {
  if(!peState) return;
  const doc = frame.contentDocument;
  const targetLang = peState.lang === "en" ? "fr" : "en";
  const langBtn = doc.querySelector(`.lang-switch__btn[data-lang="${targetLang}"]`);
  if(langBtn) langBtn.click();

  // laisse le site basculer, puis relit le projet dans sa nouvelle langue
  // (les deux langues sont déjà conservées dans le DOM, rien n'est perdu)
  setTimeout(() => {
    const keepPage = peState.activePage;
    const projectId = peState.projectId;
    peState = readProjectState(projectId);
    peState.activePage = Math.min(keepPage, peState.pages.length - 1);
    renderPanel();
    toast(targetLang === "en" ? "Édition basculée en anglais" : "Édition basculée en français");
  }, 60);
});

// ---- Aide propre au panneau (tutoriels regroupés ici, hors du canevas) ----
const peHelpBtn = document.getElementById("peHelpBtn");
const peHelpPopover = document.getElementById("peHelpPopover");
peHelpBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  peHelpPopover.hidden = !peHelpPopover.hidden;
});
document.addEventListener("click", (e) => {
  if(!peHelpPopover.hidden && !peHelpPopover.contains(e.target) && e.target !== peHelpBtn){
    peHelpPopover.hidden = true;
  }
});

// ---- Onglets de pages ----
function renderPageTabs(){
  pePageTabs.innerHTML = "";
  peState.pages.forEach((page, i) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "pe-page-tab" + (i === peState.activePage ? " is-active" : "");
    const label = document.createElement("span");
    label.textContent = "Page " + (i + 1);
    tab.appendChild(label);
    if(peState.pages.length > 1){
      const close = document.createElement("span");
      close.className = "pe-page-tab__close";
      close.textContent = "✕";
      close.title = "Supprimer cette page";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        peState.pages.splice(i, 1);
        if(peState.activePage >= peState.pages.length) peState.activePage = peState.pages.length - 1;
        renderPanel();
        syncSiteNavigation();
      });
      tab.appendChild(close);
    }
    tab.addEventListener("click", () => { peState.activePage = i; renderPanel(); syncSiteNavigation(); });
    pePageTabs.appendChild(tab);
  });

  const addTab = document.createElement("button");
  addTab.type = "button";
  addTab.className = "pe-page-tab pe-page-tab--add";
  addTab.textContent = "+ Page";
  addTab.title = "Ajouter une page";
  addTab.addEventListener("click", () => {
    peState.pages.push({ textAlign:"top", blocks:[BLOCK_DEFS.image.make(), BLOCK_DEFS.title.make(), BLOCK_DEFS.text.make()] });
    peState.activePage = peState.pages.length - 1;
    renderPanel();
    syncSiteNavigation();
  });
  pePageTabs.appendChild(addTab);
}

// Ouvre le bon projet sur le vrai site s'il ne l'est pas déjà, puis
// scrolle son tiroir jusqu'à la page actuellement éditée dans le panneau.
function syncSiteNavigation(){
  if(!peState) return;
  const doc = frame.contentDocument;
  const pill = doc.querySelector(`.pill[data-project="${peState.projectId}"]`);
  const alreadyOpen = pill && pill.classList.contains("is-active");
  if(pill && !alreadyOpen) pill.click();

  const goToPage = () => {
    const drawer = doc.querySelector(`.project-drawer[data-drawer="${peState.projectId}"]`);
    const scrollWrap = drawer?.querySelector(".drawer__scroll");
    if(scrollWrap){
      scrollWrap.scrollTo({ left: peState.activePage * scrollWrap.clientWidth, behavior: alreadyOpen ? "smooth" : "auto" });
    }
  };
  if(alreadyOpen) goToPage(); else setTimeout(goToPage, 420);
}

// ---- Palette de modules à glisser ----
const PALETTE_ICONS = {
  title:  `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 4v12M15 4v12M5 10h10"/></svg>`,
  text:   `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 5h14M3 10h14M3 15h9"/></svg>`,
  tags:   `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M10 3h6v6l-8 8-6-6 8-8Z"/><circle cx="13.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>`,
  list:   `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="4" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="15" r="1" fill="currentColor" stroke="none"/><path d="M8 5h9M8 10h9M8 15h9"/></svg>`,
  stats:  `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16V9M10 16V4M16 16v-6"/></svg>`,
  link:   `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8.5 11.5l3-3M8 6.5l1.5-1.5a2.7 2.7 0 0 1 3.8 3.8L11.8 10M12 13.5 10.5 15a2.7 2.7 0 0 1-3.8-3.8L8 9.7"/></svg>`,
  image:  `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2.5" y="4" width="15" height="12" rx="1.5"/><circle cx="7" cy="8.5" r="1.3"/><path d="M3 14l4-4 3 3 2.5-2.5L17 14"/></svg>`,
  video:  `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2.5" y="4.5" width="15" height="11" rx="1.5"/><path d="M8.5 8l4 2-4 2V8Z" fill="currentColor" stroke="none"/></svg>`,
  game:   `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7h8a4 4 0 0 1 4 4.8 2 2 0 0 1-3.4 1.6L13 11.8H7l-1.6 1.6A2 2 0 0 1 2 11.8 4 4 0 0 1 6 7Z"/><path d="M6.2 9.5v2M5.2 10.5h2"/><circle cx="14.5" cy="9.5" r=".6" fill="currentColor" stroke="none"/><circle cx="16" cy="11" r=".6" fill="currentColor" stroke="none"/></svg>`,
};

function renderPalette(){
  pePalette.innerHTML = "";
  Object.entries(BLOCK_DEFS).forEach(([key, def]) => {
    const chip = document.createElement("div");
    chip.className = "pe-palette-chip";
    chip.dataset.type = key;
    chip.draggable = true;
    chip.title = "Glisse-moi sur le canevas, ou clique pour ajouter directement";
    chip.innerHTML = `${PALETTE_ICONS[key] || ""}<span>+ ${def.label}</span>`;
    chip.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("text/pe-new-block", key);
    });
    chip.addEventListener("click", () => {
      peState.pages[peState.activePage].blocks.push(def.make());
      renderPanel();
      scrollToLastBlock();
    });
    pePalette.appendChild(chip);
  });
}

// Scrolle le canevas jusqu'à la dernière tuile (le module qu'on vient
// d'ajouter est toujours poussé en fin de liste) — sinon on ne voit
// pas qu'il a bien été ajouté et il faut chercher en bas soi-même.
function scrollToLastBlock(){
  requestAnimationFrame(() => {
    const tiles = peCanvas.querySelectorAll(".pe-block");
    const last = tiles[tiles.length - 1];
    if(!last) return;
    last.scrollIntoView({ behavior:"smooth", block:"center" });
    last.classList.add("is-just-added");
    setTimeout(() => last.classList.remove("is-just-added"), 900);
  });
}

// ---- Canevas de la page active ----
let peImageTargetBlock = null;
let peVideoTargetBlock = null;
const videoInput = document.getElementById("videoInput");

videoInput.addEventListener("change", () => {
  if(!peVideoTargetBlock) return;
  const file = videoInput.files[0];
  if(!file) return;
  const MAX_MB = 15;
  if(file.size > MAX_MB * 1024 * 1024){
    toast(`Vidéo trop lourde (${(file.size/1024/1024).toFixed(1)} Mo) — ${MAX_MB} Mo max conseillé`);
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    peVideoTargetBlock.src = e.target.result;
    peVideoTargetBlock = null;
    renderPanel();
    toast("Vidéo ajoutée");
  };
  reader.readAsDataURL(file);
});

const ALIGN_ICONS = {
  top:    `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2 2.5h12"/><path d="M4 6.5h8M4 9.5h5"/></svg>`,
  center: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6.5h8M4 9.5h5"/></svg>`,
  bottom: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6.5h8M4 9.5h5"/><path d="M2 13.5h12"/></svg>`,
};

function renderCanvas(){
  const page = peState.pages[peState.activePage];
  peCanvas.innerHTML = "";

  const alignRow = document.createElement("div");
  alignRow.className = "pe-align-row";
  [["top","Aligner en haut"], ["center","Centrer"], ["bottom","Aligner en bas"]].forEach(([key, title]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pe-align-btn" + ((page.textAlign || "top") === key ? " is-active" : "");
    b.title = title;
    b.innerHTML = ALIGN_ICONS[key];
    b.addEventListener("click", () => { page.textAlign = key; liveUpdateSite(); renderCanvas(); });
    alignRow.appendChild(b);
  });
  peCanvas.appendChild(alignRow);

  if(page.blocks.length === 0){
    const empty = document.createElement("div");
    empty.className = "pe-canvas__empty";
    empty.textContent = "Cette page est vide — glisse un module de la palette ci-dessus pour commencer.";
    peCanvas.appendChild(empty);
  }

  page.blocks.forEach((block, blockIndex) => {
    peCanvas.appendChild(renderBlock(page, block, blockIndex));
  });

  liveUpdateSite();
}

// Câblés UNE SEULE FOIS (pas à chaque rendu du canevas — c'était le
// bug qui faisait apparaître des dizaines de modules d'un coup en
// glisser-déposer : les écouteurs s'accumulaient à chaque appel de
// renderCanvas() sans jamais être retirés, un seul dépôt en déclenchait
// alors autant que de rendus déjà effectués).
peCanvas.addEventListener("dragover", (e) => {
  if(e.dataTransfer.types.includes("text/pe-new-block")){ e.preventDefault(); peCanvas.classList.add("is-drop-ready"); }
});
peCanvas.addEventListener("dragleave", (e) => {
  if(e.target === peCanvas) peCanvas.classList.remove("is-drop-ready");
});
peCanvas.addEventListener("drop", (e) => {
  const key = e.dataTransfer.getData("text/pe-new-block");
  peCanvas.classList.remove("is-drop-ready");
  if(key && BLOCK_DEFS[key] && peState){
    e.preventDefault();
    const page = peState.pages[peState.activePage];
    page.blocks.push(BLOCK_DEFS[key].make());
    renderPanel();
    scrollToLastBlock();
  }
});

// ---- Mise à jour en direct SUR LE VRAI SITE : chaque page éditée est
// reconstruite et remplacée à sa place dans le vrai tiroir, pendant
// qu'on édite — sans jamais recharger la page ni casser le scroll.
// Rien n'est définitif : si on ferme sans "Appliquer", tout revient
// à l'état d'avant ouverture du panneau (voir closeProjectEditor).
function liveUpdateSite(){
  if(!peState) return;
  const doc = frame.contentDocument;
  const drawer = doc.querySelector(`.project-drawer[data-drawer="${peState.projectId}"]`);
  if(!drawer) return;
  const scrollWrap = drawer.querySelector(".drawer__scroll");
  const existingPages = [...scrollWrap.children];

  peState.pages.forEach((pageData, i) => {
    const freshPage = buildPageElement(doc, pageData);
    if(existingPages[i]){
      scrollWrap.replaceChild(freshPage, existingPages[i]);
    }else{
      scrollWrap.appendChild(freshPage);
    }
  });
  // des pages ont pu être supprimées : retirer les excédents
  while(scrollWrap.children.length > peState.pages.length){
    scrollWrap.removeChild(scrollWrap.lastChild);
  }

  const newLabel = peProjectLabel.value.trim();
  if(newLabel && peCurrentPillEl) peCurrentPillEl.textContent = newLabel;

  injectEditing();
}

// Glisser-déposer "à la souris" : en maintenant la poignée, un vrai
// clone du bloc ("ghost") flotte et suit le curseur, pendant que
// l'original (invisible mais gardant sa place) se déplace dans la
// liste — les autres blocs glissent alors fluidement pour lui faire
// de la place (technique FLIP : on capture leur position avant/après
// et on anime la différence). Le canevas défile tout seul si on
// approche du haut ou du bas pendant le maintien. Clic droit pendant
// le maintien = annuler et tout remettre à sa place ; relâcher = valider.
function wireDragReorder(handleEl, containerEl, page){
  let dragging = false;
  let ghost = null;
  let offsetX = 0, offsetY = 0;
  let lastClientX = 0, lastClientY = 0;
  let originalParent = null;
  let originalNextSibling = null;
  let originalBlocksSnapshot = null;
  let rafId = null;

  function scrollParent(){ return containerEl.closest(".project-editor__body"); }

  function siblingBlocks(){
    return [...containerEl.parentElement.children].filter(el => el.classList.contains("pe-block") && el !== containerEl);
  }

  function capturePositions(){
    const map = new Map();
    siblingBlocks().forEach(el => map.set(el, el.getBoundingClientRect()));
    return map;
  }

  function playFlip(before){
    const after = capturePositions();
    after.forEach((afterRect, el) => {
      const beforeRect = before.get(el);
      if(!beforeRect) return;
      const dx = beforeRect.left - afterRect.left;
      const dy = beforeRect.top - afterRect.top;
      if(Math.abs(dx) > .5 || Math.abs(dy) > .5){
        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.getBoundingClientRect(); // force le reflow avant de relâcher la transition
        requestAnimationFrame(() => {
          el.style.transition = "transform .24s cubic-bezier(.2,.8,.3,1)";
          el.style.transform = "";
        });
      }
    });
  }

  function reorderIfNeeded(clientY){
    const parent = containerEl.parentElement;
    const others = siblingBlocks();
    let target = null;
    for(const el of others){
      const rect = el.getBoundingClientRect();
      if(clientY < rect.top + rect.height / 2){ target = el; break; }
    }
    if(containerEl.nextElementSibling === target) return;
    const before = capturePositions();
    if(target) parent.insertBefore(containerEl, target);
    else parent.appendChild(containerEl);
    playFlip(before);
  }

  function handleAutoScroll(clientY){
    const scrollEl = scrollParent();
    if(!scrollEl) return;
    const rect = scrollEl.getBoundingClientRect();
    const margin = 70;
    let speed = 0;
    if(clientY < rect.top + margin) speed = -Math.ceil((rect.top + margin - clientY) / 2.5);
    else if(clientY > rect.bottom - margin) speed = Math.ceil((clientY - (rect.bottom - margin)) / 2.5);
    if(speed) scrollEl.scrollTop += speed;
  }

  function tick(){
    if(!dragging){ rafId = null; return; }
    handleAutoScroll(lastClientY);
    reorderIfNeeded(lastClientY);
    rafId = requestAnimationFrame(tick);
  }

  function onMouseMove(e){
    if(!dragging) return;
    lastClientX = e.clientX; lastClientY = e.clientY;
    if(ghost){
      ghost.style.left = (e.clientX - offsetX) + "px";
      ghost.style.top = (e.clientY - offsetY) + "px";
    }
  }

  function syncArrayFromDom(){
    const parent = containerEl.parentElement;
    const ordered = [...parent.children].filter(el => el.classList.contains("pe-block"));
    const newOrder = ordered.map(el => el._peBlockRef).filter(Boolean);
    if(newOrder.length === page.blocks.length) page.blocks = newOrder;
  }

  function cleanup(){
    if(rafId){ cancelAnimationFrame(rafId); rafId = null; }
    if(ghost){ ghost.remove(); ghost = null; }
    containerEl.classList.remove("is-dragging");
    containerEl.style.visibility = "";
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("contextmenu", onRightClick);
    document.body.style.userSelect = "";
  }

  function endDrag(cancel){
    if(!dragging) return;
    dragging = false;

    if(cancel){
      const before = capturePositions();
      if(originalNextSibling && originalNextSibling.parentElement === originalParent){
        originalParent.insertBefore(containerEl, originalNextSibling);
      }else{
        originalParent.appendChild(containerEl);
      }
      playFlip(before);
      page.blocks = originalBlocksSnapshot;
      cleanup();
      liveUpdateSite();
      toast("Déplacement annulé");
    }else{
      cleanup();
      syncArrayFromDom();
      liveUpdateSite();
      saveDraft();
      renderCanvas();
    }
  }

  function onMouseUp(){ endDrag(false); }
  function onRightClick(e){ e.preventDefault(); e.stopPropagation(); endDrag(true); }

  handleEl.addEventListener("mousedown", (e) => {
    if(e.button !== 0) return; // clic gauche uniquement
    e.preventDefault();
    dragging = true;
    originalParent = containerEl.parentElement;
    originalNextSibling = containerEl.nextSibling;
    originalBlocksSnapshot = [...page.blocks];
    lastClientX = e.clientX; lastClientY = e.clientY;

    const rect = containerEl.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;

    ghost = containerEl.cloneNode(true);
    ghost.classList.add("pe-block--ghost");
    ghost.style.width = rect.width + "px";
    ghost.style.left = rect.left + "px";
    ghost.style.top = rect.top + "px";
    document.body.appendChild(ghost);

    containerEl.classList.add("is-dragging");
    containerEl.style.visibility = "hidden"; // garde sa place dans la liste, mais invisible : le ghost flotte à sa place visuelle
    document.body.style.userSelect = "none";

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("contextmenu", onRightClick);
    rafId = requestAnimationFrame(tick);
  });
  // clic droit direct sur la poignée sans avoir bougé : pas d'action
  // (seul un clic droit PENDANT un maintien-glisser annule)
  handleEl.addEventListener("contextmenu", (e) => { if(!dragging) e.preventDefault(); });
}

function peIconBtn(label, title, disabled, onClick, danger){
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pe-icon" + (danger ? " pe-icon--danger" : "");
  b.textContent = label;
  b.title = title;
  b.disabled = !!disabled;
  if(!disabled) b.addEventListener("click", onClick);
  return b;
}

const ACCENT_SUPPORTED = ["title", "text", "tags", "list", "stats", "link"];

const ACCENT_PRESETS = ["#E4483F", "#F2C94C", "#4CAF6D", "#5B8DEF", "#9C5FE0", "#2AA198", "#D1495B", "#1B2A4A"];

function renderAccentControl(block){
  const wrap = document.createElement("div");
  wrap.className = "pe-accent-control";

  const swatch = document.createElement("label");
  swatch.className = "pe-accent-swatch" + (block.accentColor ? " has-custom" : "");
  if(block.accentColor) swatch.style.setProperty("--custom-accent", block.accentColor);
  swatch.title = "Couleur personnalisée (roue chromatique)";

  const input = document.createElement("input");
  input.type = "color";
  input.value = block.accentColor || "#5B8DEF";
  // "change" (pas "input") : ne se déclenche qu'une fois la sélection
  // validée, donc on ne reconstruit rien pendant que la roue est ouverte
  // — c'est ce qui empêchait de naviguer dedans avant.
  input.addEventListener("change", () => {
    block.accentColor = input.value;
    swatch.classList.add("has-custom");
    swatch.style.setProperty("--custom-accent", input.value);
    clearBtn.hidden = false;
    liveUpdateSite();
  });
  swatch.appendChild(input);
  wrap.appendChild(swatch);

  const presets = document.createElement("div");
  presets.className = "pe-accent-presets";
  ACCENT_PRESETS.forEach(c => {
    const dot = document.createElement("button");
    dot.type = "button"; dot.className = "pe-accent-preset"; dot.style.background = c;
    dot.title = c;
    dot.addEventListener("click", () => {
      block.accentColor = c;
      input.value = c;
      swatch.classList.add("has-custom");
      swatch.style.setProperty("--custom-accent", c);
      clearBtn.hidden = false;
      liveUpdateSite();
    });
    presets.appendChild(dot);
  });
  wrap.appendChild(presets);

  const clearBtn = document.createElement("button");
  clearBtn.type = "button"; clearBtn.className = "pe-accent-clear"; clearBtn.textContent = "défaut";
  clearBtn.title = "Revenir à la couleur par défaut";
  clearBtn.hidden = !block.accentColor;
  clearBtn.addEventListener("click", () => {
    block.accentColor = null;
    swatch.classList.remove("has-custom");
    clearBtn.hidden = true;
    liveUpdateSite();
  });
  wrap.appendChild(clearBtn);

  return wrap;
}

function blockVisualType(block){
  // un bloc "video" catégorie "game" s'affiche comme un module à part
  if(block.type !== "video") return block.type;
  return (block.category || (block.mode === "itch" ? "game" : "video"));
}

function renderBlock(page, block, blockIndex){
  const doc = document;
  const wrap = doc.createElement("div");
  wrap.className = "pe-block";
  wrap.dataset.blockType = blockVisualType(block);
  wrap._peBlockRef = block;

  const head = doc.createElement("div");
  head.className = "pe-block__head";
  const headLeft = doc.createElement("div");
  headLeft.className = "pe-block__head-left";
  const handle = doc.createElement("span");
  handle.className = "pe-drag-handle";
  handle.textContent = "⠿";
  handle.title = "Maintenir pour déplacer (clic droit pendant le déplacement = annuler)";
  const label = doc.createElement("span");
  label.className = "pe-block__label";
  label.textContent = BLOCK_DEFS[blockVisualType(block)]?.label || block.type;
  headLeft.appendChild(handle); headLeft.appendChild(label);
  if(ACCENT_SUPPORTED.includes(block.type)) headLeft.appendChild(renderAccentControl(block));

  const actions = doc.createElement("div");
  actions.className = "pe-page__actions";
  actions.appendChild(peIconBtn("✕", "Supprimer ce bloc", false, () => { page.blocks.splice(blockIndex, 1); renderPanel(); }, true));
  head.appendChild(headLeft); head.appendChild(actions);
  wrap.appendChild(head);

  wireDragReorder(handle, wrap, page);

  wrap.appendChild(renderBlockBody(block));
  return wrap;
}

const RICH_COLORS = ["#1B2A4A", "#E4483F", "#4CAF6D", "#5B8DEF", "#D4A017"];

function renderRichTextEditor(block){
  const doc = document;
  const wrap = doc.createElement("div");

  const toolbar = doc.createElement("div");
  toolbar.className = "pe-richtoolbar";

  const boldBtn = doc.createElement("button");
  boldBtn.type = "button"; boldBtn.className = "pe-rt-btn"; boldBtn.innerHTML = "<strong>G</strong>";
  boldBtn.title = "Mettre en gras le texte sélectionné";
  toolbar.appendChild(boldBtn);

  const colorsWrap = doc.createElement("div");
  colorsWrap.className = "pe-rt-colors";
  RICH_COLORS.forEach(c => {
    const dot = doc.createElement("button");
    dot.type = "button"; dot.className = "pe-rt-color"; dot.style.background = c;
    dot.title = "Colorer le texte sélectionné";
    dot.addEventListener("mousedown", (e) => e.preventDefault()); // ne pas perdre la sélection en cours
    dot.addEventListener("click", () => {
      editable.focus();
      doc.execCommand("foreColor", false, c);
      setText(block, editable.innerHTML);
      liveUpdateSite();
    });
    colorsWrap.appendChild(dot);
  });
  toolbar.appendChild(colorsWrap);
  wrap.appendChild(toolbar);

  const editable = doc.createElement("div");
  editable.className = "pe-richtext";
  editable.contentEditable = "true";
  editable.innerHTML = getText(block);
  editable.addEventListener("input", () => {
    setText(block, editable.innerHTML);
    liveUpdateSite();
  });
  wrap.appendChild(editable);

  boldBtn.addEventListener("mousedown", (e) => e.preventDefault());
  boldBtn.addEventListener("click", () => {
    editable.focus();
    doc.execCommand("bold");
    setText(block, editable.innerHTML);
    liveUpdateSite();
  });

  return wrap;
}

const REFRAME_POINTS = [
  ["0% 0%","↖"], ["50% 0%","↑"], ["100% 0%","↗"],
  ["0% 50%","←"], ["50% 50%","•"], ["100% 50%","→"],
  ["0% 100%","↙"], ["50% 100%","↓"], ["100% 100%","↘"],
];

function renderReframeControl(block, previewEl){
  const doc = document;
  const wrap = doc.createElement("div");
  wrap.className = "pe-reframe";
  const grid = doc.createElement("div");
  grid.className = "pe-reframe-grid";
  REFRAME_POINTS.forEach(([pos, icon]) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "pe-reframe-dot" + ((block.objectPosition || "50% 50%") === pos ? " is-active" : "");
    b.textContent = icon;
    b.title = "Centrer le cadrage ici";
    b.addEventListener("click", () => {
      block.objectPosition = pos;
      if(previewEl) previewEl.style.objectPosition = pos;
      grid.querySelectorAll(".pe-reframe-dot").forEach(d => d.classList.remove("is-active"));
      b.classList.add("is-active");
      liveUpdateSite();
    });
    grid.appendChild(b);
  });
  wrap.appendChild(grid);
  return wrap;
}

// Le panneau édite toujours la langue actuellement affichée sur le
// site (peState.lang) — jamais figée sur le français. L'autre langue
// est préservée à côté, prête à être éditée si on bascule le switch.
function activeLang(){ return peState ? peState.lang : "fr"; }
function getText(obj){ const l = activeLang(); return obj[l] !== undefined ? obj[l] : (obj.fr || ""); }
function setText(obj, value){
  const l = activeLang();
  obj[l] = value;
  const other = l === "fr" ? "en" : "fr";
  if(obj[other] === undefined || obj[other] === "") obj[other] = value;
}

function renderBlockBody(block){
  const doc = document;
  const body = doc.createElement("div");

  if(block.type === "title"){
    const input = doc.createElement("input");
    input.className = "pe-input"; input.type = "text"; input.value = getText(block);
    input.addEventListener("input", () => { setText(block, input.value); liveUpdateSite(); });
    body.appendChild(input);
    return body;
  }

  if(block.type === "text"){
    const styleRow = doc.createElement("div");
    styleRow.className = "pe-text-style-row";
    [["normal","Normal"], ["accent","Accroche"], ["discret","Discret"]].forEach(([key, label]) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "pe-video-mode-btn" + ((block.style || "normal") === key ? " is-active" : "");
      b.textContent = label;
      b.title = key === "accent" ? "Gros, en couleur — pour une phrase d'accroche" : key === "discret" ? "Petit, discret — pour une ligne d'info (équipe, durée...)" : "Paragraphe normal";
      b.addEventListener("click", () => { block.style = key; renderPanel(); });
      styleRow.appendChild(b);
    });
    body.appendChild(styleRow);
    body.appendChild(renderRichTextEditor(block));
    return body;
  }

  if(block.type === "image"){
    const thumb = doc.createElement("img");
    thumb.className = "pe-image-preview";
    thumb.src = block.src || "https://placehold.co/300x150/9C5FE0/F7F3EC?text=Image";
    thumb.style.objectFit = "cover";
    thumb.style.objectPosition = block.objectPosition || "50% 50%";
    body.appendChild(thumb);

    const actions = doc.createElement("div");
    actions.className = "pe-image-actions";

    const changeBtn = doc.createElement("button");
    changeBtn.type = "button"; changeBtn.className = "tbtn"; changeBtn.textContent = block.src ? "Changer l'image" : "Choisir une image";
    changeBtn.addEventListener("click", () => {
      currentImageTarget = null;
      peImageTargetBlock = block;
      fileInput.value = "";
      fileInput.click();
    });
    actions.appendChild(changeBtn);

    const sizeGroup = doc.createElement("div");
    sizeGroup.className = "pe-size-group";
    [["small","Petit"], ["normal","Normal"], ["large","Grand"]].forEach(([key, label]) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "pe-size-btn" + ((block.imgSize || "normal") === key ? " is-active" : "");
      b.textContent = label;
      b.addEventListener("click", () => { block.imgSize = key; renderPanel(); });
      sizeGroup.appendChild(b);
    });
    actions.appendChild(sizeGroup);
    body.appendChild(actions);
    body.appendChild(renderReframeControl(block, thumb));
    return body;
  }

  if(block.type === "video"){
    const category = block.category || (block.mode === "itch" ? "game" : "video");
    const availableModes = category === "game"
      ? [["itch","Jeu itch.io"]]
      : [["youtube","Lien YouTube"], ["upload","Fichier MP4"]];

    if(availableModes.length > 1){
      const modes = doc.createElement("div");
      modes.className = "pe-video-modes";
      availableModes.forEach(([m, label]) => {
        const b = doc.createElement("button");
        b.type = "button"; b.className = "pe-video-mode-btn" + (block.mode === m ? " is-active" : "");
        b.textContent = label;
        b.addEventListener("click", () => { block.mode = m; renderPanel(); });
        modes.appendChild(b);
      });
      body.appendChild(modes);
    }

    const sizeGroup = doc.createElement("div");
    sizeGroup.className = "pe-size-group";
    [["half","1/2"], ["twothirds","2/3"], ["full","Pleine largeur"]].forEach(([key, label]) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "pe-size-btn" + ((block.imgSize || "twothirds") === key ? " is-active" : "");
      b.textContent = label;
      b.addEventListener("click", () => { block.imgSize = key; liveUpdateSite(); renderPanel(); });
      sizeGroup.appendChild(b);
    });
    body.appendChild(sizeGroup);

    if(block.mode === "youtube"){
      const urlInput = doc.createElement("input");
      urlInput.className = "pe-input"; urlInput.type = "text";
      urlInput.placeholder = "https://www.youtube.com/watch?v=...";
      if(block.youtubeId) urlInput.value = `https://youtu.be/${block.youtubeId}`;
      urlInput.addEventListener("input", () => { block.youtubeId = extractYouTubeId(urlInput.value); liveUpdateSite(); });
      body.appendChild(urlInput);
      if(block.youtubeId){
        const preview = doc.createElement("img");
        preview.className = "pe-video-preview";
        preview.src = `https://img.youtube.com/vi/${block.youtubeId}/mqdefault.jpg`;
        preview.alt = "Aperçu YouTube";
        body.appendChild(preview);
      }
    }else if(block.mode === "itch"){
      const urlInput = doc.createElement("input");
      urlInput.className = "pe-input"; urlInput.type = "text";
      urlInput.placeholder = "Colle ici le code d'embed itch.io, ou juste son URL";
      urlInput.value = block.itchUrl || "";
      urlInput.addEventListener("input", () => { block.itchUrl = extractEmbedUrl(urlInput.value); liveUpdateSite(); });
      body.appendChild(urlInput);
      if(block.itchUrl){
        const preview = doc.createElement("div");
        preview.className = "pe-video-preview pe-video-preview--itch";
        const ifr = doc.createElement("iframe");
        ifr.src = block.itchUrl;
        preview.appendChild(ifr);
        body.appendChild(preview);
      }
    }else{
      if(block.src){
        const preview = doc.createElement("div");
        preview.className = "pe-video-preview";
        const v = doc.createElement("video");
        v.src = block.src; v.controls = true;
        v.style.objectFit = "cover"; v.style.objectPosition = block.objectPosition || "50% 50%";
        preview.appendChild(v);
        body.appendChild(preview);
        body.appendChild(renderReframeControl(block, v));
      }
      const uploadBtn = doc.createElement("button");
      uploadBtn.type = "button"; uploadBtn.className = "tbtn"; uploadBtn.textContent = block.src ? "Changer la vidéo" : "Choisir un MP4";
      uploadBtn.addEventListener("click", () => {
        peVideoTargetBlock = block;
        videoInput.value = "";
        videoInput.click();
      });
      body.appendChild(uploadBtn);
    }
    return body;
  }

  if(block.type === "link"){
    const labelInput = doc.createElement("input");
    labelInput.className = "pe-input"; labelInput.type = "text"; labelInput.value = getText(block);
    labelInput.placeholder = "Texte du bouton";
    labelInput.addEventListener("input", () => { setText(block, labelInput.value); liveUpdateSite(); });
    const hrefInput = doc.createElement("input");
    hrefInput.className = "pe-input"; hrefInput.type = "text"; hrefInput.value = block.href;
    hrefInput.placeholder = "https://...";
    hrefInput.addEventListener("input", () => { block.href = hrefInput.value; liveUpdateSite(); });
    body.appendChild(labelInput); body.appendChild(hrefInput);
    return body;
  }

  if(block.type === "tags"){
    const editor = doc.createElement("div");
    editor.className = "pe-tag-editor";
    function renderTags(){
      editor.innerHTML = "";
      block.items.forEach((t, i) => {
        const chip = doc.createElement("span");
        chip.className = "pe-tag";
        chip.appendChild(doc.createTextNode(getText(t) + " "));
        const x = doc.createElement("button");
        x.type = "button"; x.textContent = "✕";
        x.addEventListener("click", () => { block.items.splice(i, 1); renderTags(); liveUpdateSite(); });
        chip.appendChild(x);
        editor.appendChild(chip);
      });
      const input = doc.createElement("input");
      input.className = "pe-tag-input"; input.placeholder = "+ tag, Entrée";
      input.addEventListener("keydown", (e) => {
        if(e.key === "Enter" && input.value.trim()){
          block.items.push({ fr:input.value.trim(), en:input.value.trim() });
          renderTags();
          liveUpdateSite();
        }
      });
      editor.appendChild(input);
    }
    renderTags();
    body.appendChild(editor);
    return body;
  }

  if(block.type === "list"){
    const editor = doc.createElement("div");
    function renderItems(){
      editor.innerHTML = "";
      block.items.forEach((li, i) => {
        const row = doc.createElement("div"); row.className = "pe-list-item";
        const input = doc.createElement("input"); input.className = "pe-input"; input.type = "text"; input.value = getText(li);
        input.addEventListener("input", () => { setText(li, input.value); liveUpdateSite(); });
        row.appendChild(input);
        row.appendChild(peIconBtn("✕", "Retirer", false, () => { block.items.splice(i, 1); renderItems(); liveUpdateSite(); }, true));
        editor.appendChild(row);
      });
      const addBtn = doc.createElement("button");
      addBtn.type = "button"; addBtn.className = "pe-add-small"; addBtn.textContent = "+ ligne";
      addBtn.addEventListener("click", () => { block.items.push({ fr:"Nouvel élément", en:"New item" }); renderItems(); liveUpdateSite(); });
      editor.appendChild(addBtn);
    }
    renderItems();
    body.appendChild(editor);
    return body;
  }

  if(block.type === "stats"){
    const editor = doc.createElement("div");
    function renderStats(){
      editor.innerHTML = "";
      block.items.forEach((s, i) => {
        const row = doc.createElement("div"); row.className = "pe-stat-item";
        const num = doc.createElement("input"); num.className = "pe-input"; num.type = "text"; num.value = s.number; num.placeholder = "1.2K";
        num.addEventListener("input", () => { s.number = num.value; liveUpdateSite(); });
        const lbl = doc.createElement("input"); lbl.className = "pe-input"; lbl.type = "text"; lbl.value = getText(s); lbl.placeholder = "libellé";
        lbl.addEventListener("input", () => { setText(s, lbl.value); liveUpdateSite(); });
        row.appendChild(num); row.appendChild(lbl);
        row.appendChild(peIconBtn("✕", "Retirer", false, () => { block.items.splice(i, 1); renderStats(); liveUpdateSite(); }, true));
        editor.appendChild(row);
      });
      const addBtn = doc.createElement("button");
      addBtn.type = "button"; addBtn.className = "pe-add-small"; addBtn.textContent = "+ statistique";
      addBtn.addEventListener("click", () => { block.items.push({ number:"0", fr:"métrique", en:"metric" }); renderStats(); liveUpdateSite(); });
      editor.appendChild(addBtn);
    }
    renderStats();
    body.appendChild(editor);
    return body;
  }

  return body;
}

// upload d'image ciblé sur une page ou un bloc Photo du panneau
// (distinct de l'upload "rapide" sur le site en direct — même logique
// de redimensionnement)
fileInput.addEventListener("change", () => {
  if(!peImageTargetBlock) return;
  const file = fileInput.files[0];
  if(!file) return;
  const isGif = file.type === "image/gif";
  const reader = new FileReader();

  const finish = (dataUrl) => {
    peImageTargetBlock.src = dataUrl;
    renderPanel();
    peImageTargetBlock = null;
    if(isGif) toast("GIF ajouté (animation conservée)");
  };

  if(isGif){
    reader.onload = (e) => finish(e.target.result);
    reader.readAsDataURL(file);
    return;
  }

  const img = new Image();
  reader.onload = (e) => {
    img.onload = () => {
      const MAX = 640;
      let { width, height } = img;
      if(width > MAX || height > MAX){
        const ratio = Math.min(MAX / width, MAX / height);
        width = Math.round(width * ratio); height = Math.round(height * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      finish(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
});

peApply.addEventListener("click", () => {
  const prevHtml = peOriginalHtml;
  const prevLabel = peOriginalLabel;
  const drawerId = peState.projectId;

  recordUndo(() => {
    const doc = frame.contentDocument;
    const drawer = doc.querySelector(`.project-drawer[data-drawer="${drawerId}"]`);
    if(drawer) drawer.querySelector(".drawer__scroll").innerHTML = prevHtml;
    const pill = doc.querySelector(`.pill[data-project="${drawerId}"]`);
    if(pill) pill.textContent = prevLabel;
    injectEditing();
  });

  saveDraft();
  closeProjectEditor(false); // false : on garde l'état actuel, déjà en direct sur le site
  toast("Projet mis à jour");
});

/* ==================================================================
   AJOUT / SUPPRESSION DE PROJETS — seul cas qui recharge la page
   (nécessaire pour que main.js reconnaisse les nouveaux éléments).
   Non couvert par Ctrl+Z ; la suppression demande confirmation.
================================================================== */
function nextProjectId(doc){
  const ids = [...doc.querySelectorAll(".project-drawer")].map(d => d.dataset.drawer);
  let n = 1;
  while(ids.includes("p" + n)) n++;
  return "p" + n;
}

function defaultProjectPages(){
  return [
    { textAlign:"top", blocks:[
      { type:"image", src:"https://placehold.co/460x300/1B2A4A/F7F3EC?text=Overview", imgSize:"normal" },
      { type:"text", style:"accent", fr:"Résumé en une phrase.", en:"One-sentence summary." },
      BLOCK_DEFS.title.make(), BLOCK_DEFS.tags.make(), BLOCK_DEFS.text.make(), BLOCK_DEFS.link.make(),
    ]},
    { textAlign:"top", blocks:[
      { type:"image", src:"https://placehold.co/460x300/E4483F/1B2A4A?text=Features", imgSize:"normal" },
      { type:"title", fr:"Fonctionnalités clés", en:"Key Features" }, BLOCK_DEFS.list.make(), BLOCK_DEFS.link.make(),
    ]},
    { textAlign:"top", blocks:[
      { type:"image", src:"https://placehold.co/460x300/F2C94C/1B2A4A?text=Role", imgSize:"normal" },
      { type:"title", fr:"Mon rôle", en:"My Role" },
      { type:"text", style:"discret", fr:"Équipe · durée", en:"Team · duration" },
      BLOCK_DEFS.list.make(), BLOCK_DEFS.link.make(),
    ]},
    { textAlign:"top", blocks:[
      { type:"image", src:"https://placehold.co/460x300/1B2A4A/F7F3EC?text=Results", imgSize:"normal" },
      { type:"title", fr:"Résultats", en:"Results" }, BLOCK_DEFS.stats.make(), BLOCK_DEFS.text.make(),
    ]},
  ];
}

btnAddProject.addEventListener("click", () => {
  const doc = frame.contentDocument;
  const id = nextProjectId(doc);
  const pillRow = doc.querySelector(".pill-row");
  const stage = doc.getElementById("projectsStage");

  const pill = doc.createElement("button");
  pill.className = "pill";
  pill.dataset.project = id;
  pill.textContent = "Nouveau projet";
  pillRow.appendChild(pill);

  const drawer = doc.createElement("div");
  drawer.className = "project-drawer";
  drawer.dataset.drawer = id;
  const scrollWrap = doc.createElement("div");
  scrollWrap.className = "drawer__scroll";
  defaultProjectPages().forEach(p => scrollWrap.appendChild(buildPageElement(doc, p)));
  drawer.appendChild(scrollWrap);

  const track = doc.createElement("div");
  track.className = "scrollbar-track";
  const thumb = doc.createElement("div");
  thumb.className = "scrollbar-thumb";
  track.appendChild(thumb);
  drawer.appendChild(track);

  stage.appendChild(drawer);

  reloadFromCurrentState(() => toast("Nouveau projet ajouté — clique sur son icône ✎ pour le remplir"));
});

function removeProject(id){
  if(!confirm("Supprimer ce projet et toutes ses pages ? Cette action n'est pas annulable avec Ctrl+Z.")) return;
  const doc = frame.contentDocument;
  doc.querySelector(`.pill[data-project="${id}"]`)?.remove();
  doc.querySelector(`.project-drawer[data-drawer="${id}"]`)?.remove();
  reloadFromCurrentState(() => toast("Projet supprimé"));
}

function reloadFromCurrentState(afterCallback){
  const doc = frame.contentDocument;
  const html = doc.documentElement.outerHTML;
  loadHtmlIntoFrame(html, () => {
    injectEditing();
    saveDraft();
    afterCallback && afterCallback();
  });
}

// ---------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------
function scheduleSave(){
  saveStatus.textContent = "Sauvegarde…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, 500);
}
function formatSize(bytes){
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? mb.toFixed(1) + " Mo" : Math.round(bytes / 1024) + " Ko";
}

async function saveDraft(){
  const doc = frame.contentDocument;
  const html = doc.documentElement.outerHTML;
  const sizeBytes = new Blob([html]).size;
  try{
    await idbSet(DRAFT_KEY, html);
    saveStatus.classList.remove("is-warning", "is-error");
    saveStatus.title = "";
    if(sizeBytes > 30 * 1024 * 1024){
      saveStatus.classList.add("is-warning");
      saveStatus.textContent = `Brouillon à jour (${formatSize(sizeBytes)})`;
      saveStatus.title = "Le brouillon devient très volumineux. Pense à télécharger le site de temps en temps pour ne rien risquer.";
    }else{
      saveStatus.textContent = "Brouillon à jour";
    }
  }catch(err){
    saveStatus.classList.add("is-error");
    saveStatus.textContent = "⚠ Sauvegarde auto impossible";
    saveStatus.title = "Le stockage local du navigateur est indisponible ou plein (navigation privée, espace disque épuisé...). Tes DERNIÈRES modifications ne sont plus sauvegardées automatiquement. Clique sur \"Télécharger le site\" maintenant pour ne rien perdre.";
    toast("⚠ Sauvegarde automatique impossible — télécharge le site maintenant pour ne rien perdre.");
  }
}

// ---------------------------------------------------------------
// Téléchargement — nettoyage complet des artefacts de l'éditeur
// ---------------------------------------------------------------
btnDownload.addEventListener("click", () => {
  const doc = frame.contentDocument;
  const clone = doc.documentElement.cloneNode(true);

  clone.querySelectorAll("[contenteditable]").forEach(el => el.removeAttribute("contenteditable"));
  clone.querySelectorAll(".editor-add-tag, .editor-badges, .editor-add-photo").forEach(el => el.remove());
  clone.querySelectorAll(".editor-img-wrap").forEach(wrap => wrap.replaceWith(...wrap.childNodes));
  clone.querySelector("#editor-injected-style")?.remove();
  clone.querySelector("#editor-color-override")?.remove();
  clone.querySelector("base[href]")?.remove();

  // toujours repartir avec le tableau photo (et sa vue rapprochée) fermés,
  // même s'ils étaient ouverts au moment du téléchargement
  const clonedCorkboard = clone.querySelector("#corkboard");
  if(clonedCorkboard){ clonedCorkboard.hidden = true; clonedCorkboard.classList.remove("is-open"); }
  const clonedViewer = clone.querySelector("#corkboardViewer");
  if(clonedViewer){ clonedViewer.hidden = true; clonedViewer.classList.remove("is-open"); }

  const html = "<!DOCTYPE html>\n" + clone.outerHTML;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "index.html";
  a.click();
  URL.revokeObjectURL(url);
  toast("Téléchargé — remplace ton index.html sur GitHub avec ce fichier");
});

// ---------------------------------------------------------------
// Repartir de zéro
// ---------------------------------------------------------------
btnReset.addEventListener("click", () => {
  if(!confirm("Effacer toutes les modifications en cours et repartir du site actuel ?")) return;
  idbDelete(DRAFT_KEY).catch(() => {});
  undoStack = [];
  btnUndo.disabled = true;
  colorOverrides = { light:{}, dark:{} };
  frame.addEventListener("load", () => { injectEditing(); toast("Repartie de zéro"); }, { once: true });
  frame.src = "../index.html?_=" + Date.now();
});
