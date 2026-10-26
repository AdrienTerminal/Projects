/* ==================================================================
   PORTFOLIO COLIN VIALLE — logique du site
   Même moteur de contenu que le site principal (mêmes blocs, même
   système d'édition), mais une mise en scène différente : sélection
   de projet en tuiles (façon écran de sélection) plutôt qu'une rangée
   de pilules + tiroir, navigation de page par chips plutôt que barre
   de défilement, et une seule section "Mes passions" en grille qui se
   détache en fiche agrandie au clic plutôt que des panneaux diagonaux.
================================================================== */

/* ==================================================================
   -1) ÉCRAN DE CHARGEMENT — masqué dès que la page est prête (chargée),
   avec un petit délai minimum pour éviter un flash, et un filet de
   sécurité pour ne jamais bloquer plus de quelques secondes.
================================================================== */
(function(){
  const loader = document.getElementById("siteLoader");
  if(!loader) return;
  let hidden = false;
  function hideLoader(){
    if(hidden) return;
    hidden = true;
    loader.classList.add("is-hidden");
  }
  if(document.readyState === "complete"){
    setTimeout(hideLoader, 250);
  }else{
    window.addEventListener("load", () => setTimeout(hideLoader, 250));
  }
  setTimeout(hideLoader, 4000); // filet de sécurité
})();

/* ==================================================================
   0) SONS — désactivés (aucun effet sonore). sfx reste défini en
      no-op pour ne rien casser aux endroits qui l'appellent.
================================================================== */
const sfx = {
  tab(){},
  select(){},
  open(){},
  close(){},
  scroll(){},
  photo(){},
};


/* ==================================================================
   1) ONGLETS "Projects" / "About me"
================================================================== */
const cardEl = document.getElementById("card");
const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel-view");

let aboutPeekPlayed = false;

tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    if(tab.classList.contains("is-active")) return;
    tabs.forEach(t => t.classList.remove("is-active"));
    panels.forEach(p => p.classList.remove("is-active"));
    tab.classList.add("is-active");
    document.querySelector(`.panel-view[data-panel="${tab.dataset.tab}"]`).classList.add("is-active");
    cardEl.classList.toggle("is-about", tab.dataset.tab === "about");
    sfx.tab();
  });
});


/* ==================================================================
   2) PROJETS — même machine d'état anti-spam qu'avant : pendant
      qu'une transition tourne, un clic ne fait que mettre à jour
      "la dernière destination demandée", traitée dès la fin de
      l'animation en cours. Ouverture et fermeture utilisent le même
      fondu doux (scale + opacity, défini en CSS) dans les deux sens.
================================================================== */
const TRANSITION_MS = 420; // doit correspondre à la transition CSS de .project-drawer

const pills   = document.querySelectorAll(".pill");
const drawers = document.querySelectorAll(".project-drawer");
const stageFrame = document.getElementById("projectsStage");

let openId = null;
let isAnimating = false;
let pendingId = undefined;

function setPillActive(id){
  pills.forEach(p => p.classList.toggle("is-active", p.dataset.project === id));
}

function resetDrawerScroll(id){
  const drawer = document.querySelector(`.project-drawer[data-drawer="${id}"]`);
  drawer?._scrollApi?.reset();
}

function hideAllDrawers(){
  drawers.forEach(d => d.classList.remove("is-open"));
  stageFrame.classList.remove("has-open");
}

function openDrawer(id){
  resetDrawerScroll(id);
  stageFrame.classList.add("has-open");
  document.querySelector(`.project-drawer[data-drawer="${id}"]`)?.classList.add("is-open");
}

function runTransition(nextId){
  isAnimating = true;
  const needsClose = openId !== null;

  if(needsClose){
    hideAllDrawers();
    window.setTimeout(() => {
      openId = null;
      setPillActive(null);
      resolveTransition(nextId);
    }, TRANSITION_MS);
  }else{
    resolveTransition(nextId);
  }
}

function resolveTransition(nextId){
  if(pendingId !== undefined){
    const target = pendingId;
    pendingId = undefined;
    isAnimating = false;
    goTo(target);
    return;
  }
  if(nextId === null){
    isAnimating = false;
    return;
  }
  openId = nextId;
  setPillActive(nextId);
  openDrawer(nextId);
  sfx.open();
  window.setTimeout(() => { isAnimating = false; }, TRANSITION_MS);
}

function goTo(nextId){
  if(isAnimating){
    pendingId = nextId;
    return;
  }
  if(nextId === openId) return;
  runTransition(nextId);
}

pills.forEach(pill => {
  pill.addEventListener("click", () => {
    const id = pill.dataset.project;
    const somethingWasOpen = openId !== null || pendingId !== undefined;
    if(id === openId){
      sfx.close();
      goTo(null);
    }else{
      if(somethingWasOpen) sfx.close();
      goTo(id);
    }
  });
});

// Le premier projet est ouvert dès le chargement — direct, sans
// animation ni son, comme un état initial plutôt qu'une transition.
if(pills.length){
  const firstId = pills[0].dataset.project;
  openId = firstId;
  setPillActive(firstId);
  openDrawer(firstId);
}

// Chaque tiroir gère sa propre barre : clic pour sauter, glisser pour lerp entre
// les pages.
drawers.forEach(drawer => {
  const scrollWrap = drawer.querySelector(".drawer__scroll");
  const track       = drawer.querySelector(".scrollbar-track");
  const thumb       = drawer.querySelector(".scrollbar-thumb");
  const pageCount   = drawer.querySelectorAll(".page").length;

  let target = 0;
  let current = 0;
  let rafId = null;
  let dragging = false;
  let lastPageIndex = 0;

  function maxScroll(){ return scrollWrap.scrollWidth - scrollWrap.clientWidth; }

  function applyThumb(ratio){
    const thumbWidth = Math.max(18, (scrollWrap.clientWidth / scrollWrap.scrollWidth) * 100);
    thumb.style.width = thumbWidth + "%";
    thumb.style.left = ratio * (100 - thumbWidth) + "%";
  }

  function tick(){
    current += (target - current) * 0.18;
    if(Math.abs(target - current) < 0.001){ current = target; }
    scrollWrap.scrollLeft = current * maxScroll();
    applyThumb(current);

    if(pageCount > 1){
      const idx = Math.round(current * (pageCount - 1));
      if(idx !== lastPageIndex){
        lastPageIndex = idx;
        sfx.scroll();
        renderPageNav();
      }
    }

    if(current !== target){
      rafId = requestAnimationFrame(tick);
    }else{
      rafId = null;
    }
  }

  function goToRatio(ratio){
    target = Math.min(1, Math.max(0, ratio));
    if(!rafId) rafId = requestAnimationFrame(tick);
  }

  drawer._scrollApi = {
    reset(){
      target = 0; current = 0; lastPageIndex = 0;
      scrollWrap.scrollLeft = 0;
      applyThumb(0);
      renderPageNav();
    }
  };

  // Navigation par chips (façon indicateurs de manche) : remplace la
  // barre de défilement classique du site principal — construite une
  // fois, à partir du nombre de pages réel de CE tiroir.
  // Idempotent : si ce script tourne une 2e fois sur un DOM déjà
  // initialisé (ex. reloadFromCurrentState() de l'éditeur, qui recharge
  // un snapshot du DOM courant), on retire l'ancien bloc avant d'en
  // reconstruire un, pour ne jamais en empiler deux.
  drawer.querySelectorAll(":scope > .page-nav").forEach(el => el.remove());
  let pageNav = null;
  let dots = [];
  if(pageCount > 1){
    pageNav = document.createElement("div");
    pageNav.className = "page-nav";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "page-nav__btn";
    prevBtn.setAttribute("aria-label", "Page précédente");
    prevBtn.textContent = "‹";

    const dotsWrap = document.createElement("div");
    dotsWrap.className = "page-nav__dots";
    for(let i = 0; i < pageCount; i++){
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "page-nav__dot";
      dot.setAttribute("aria-label", `Page ${i + 1}`);
      dot.addEventListener("click", () => goToRatio(i / (pageCount - 1)));
      dotsWrap.appendChild(dot);
      dots.push(dot);
    }

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "page-nav__btn";
    nextBtn.setAttribute("aria-label", "Page suivante");
    nextBtn.textContent = "›";

    prevBtn.addEventListener("click", () => goToRatio(Math.max(0, lastPageIndex - 1) / (pageCount - 1)));
    nextBtn.addEventListener("click", () => goToRatio(Math.min(pageCount - 1, lastPageIndex + 1) / (pageCount - 1)));

    pageNav.append(prevBtn, dotsWrap, nextBtn);
    track.insertAdjacentElement("afterend", pageNav);
  }

  function renderPageNav(){
    if(!dots.length) return;
    const idx = Math.round(current * (pageCount - 1));
    dots.forEach((d, i) => d.classList.toggle("is-active", i === idx));
  }

  track.addEventListener("click", (e) => {
    if(e.target === thumb) return;
    const rect = track.getBoundingClientRect();
    goToRatio((e.clientX - rect.left) / rect.width);
  });

  thumb.addEventListener("pointerdown", (e) => {
    dragging = true;
    thumb.classList.add("is-dragging");
    thumb.setPointerCapture(e.pointerId);
  });
  thumb.addEventListener("pointermove", (e) => {
    if(!dragging) return;
    const rect = track.getBoundingClientRect();
    goToRatio((e.clientX - rect.left) / rect.width);
  });
  function stopDrag(){ dragging = false; thumb.classList.remove("is-dragging"); }
  thumb.addEventListener("pointerup", stopDrag);
  thumb.addEventListener("pointercancel", stopDrag);

  window.addEventListener("resize", () => applyThumb(current));
  applyThumb(0);
  renderPageNav();
});


/* ==================================================================
   3) ABOUT ME — panneaux diagonaux, un seul zoomé à la fois.
      Pas de texte d'instruction : au premier passage sur l'onglet,
      une petite vague fait "peeker" chaque panneau tour à tour pour
      suggérer l'interaction sans l'écrire.
================================================================== */
const occupations = document.querySelectorAll(".occupation");

// Nombre de colonnes figé sur le nombre réel de tuiles (voir le
// commentaire sur .occupations dans style.css) : quel que soit le
// nombre de passions, elles remplissent tout l'écran disponible.
if(occupations.length && occupations[0].parentElement){
  occupations[0].parentElement.style.setProperty("--passion-count", occupations.length);
}

// Anime la tuile elle-même entre sa place dans la grille et la fiche
// agrandie au centre (technique FLIP : First / Last / Invert / Play),
// plutôt qu'un simple fondu sur un état qui a déjà "téléporté" —
// movement réellement perçu entre les deux tailles/positions.
function flipOccupation(occ, activate){
  const startRect = occ.getBoundingClientRect();
  if(activate) occ.classList.add("is-active");
  else occ.classList.remove("is-active");
  const endRect = occ.getBoundingClientRect();
  const dx = startRect.left - endRect.left;
  const dy = startRect.top - endRect.top;
  const sx = startRect.width / endRect.width;
  const sy = startRect.height / endRect.height;
  if(window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  occ.animate([
    { transform:`translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
    { transform:"none" },
  ], { duration:360, easing:"cubic-bezier(.22,.61,.36,1)" });
}

occupations.forEach(occ => {
  occ.addEventListener("click", (e) => {
    // ne jamais changer quelle passion est active si le clic vient
    // d'un texte en cours d'édition (éditeur visuel) — sinon cliquer
    // pour positionner le curseur relance aussi l'animation et coupe
    // le focus au même moment.
    if(e.target.closest('[contenteditable="true"]')) return;
    if(occ.classList.contains("is-active")) return;
    occupations.forEach(o => { if(o.classList.contains("is-active")) flipOccupation(o, false); });
    flipOccupation(occ, true);
    sfx.select();
  });
  // ce n'est plus un <button> natif (pour permettre l'édition de texte
  // à l'intérieur sans que le navigateur ne vole le focus) : on
  // rajoute donc l'accessibilité clavier à la main.
  occ.addEventListener("keydown", (e) => {
    if(e.target.closest('[contenteditable="true"], input, textarea')) return;
    if(e.key === "Enter" || e.key === " "){
      e.preventDefault();
      occ.click();
    }
  });
});

function playAboutPeekSequence(){
  const inactiveOnes = [...occupations].filter(o => !o.classList.contains("is-active"));
  let i = 0;
  function step(){
    if(i > 0) inactiveOnes[i - 1].classList.remove("is-peeking");
    if(i >= inactiveOnes.length) return;
    inactiveOnes[i].classList.add("is-peeking");
    i++;
    window.setTimeout(step, 280);
  }
  step();
}

/* ---- "Moi" / "Mes passions" — grandissent au clic, exactement
   comme les cartes passions plus bas (même logique, même familiarité). */
const aboutTabs = document.querySelectorAll(".about-tab");

aboutTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    if(tab.classList.contains("is-active")) return;
    const target = tab.dataset.aboutTab;
    aboutTabs.forEach(t => t.classList.toggle("is-active", t === tab));
    sfx.tab();

    if(target === "passions" && !aboutPeekPlayed){
      aboutPeekPlayed = true;
      window.setTimeout(playAboutPeekSequence, 400);
    }
  });
  tab.addEventListener("keydown", (e) => {
    // ne jamais intercepter Espace/Entrée si on est en train de taper
    // du texte à l'intérieur (édition en direct) — sinon impossible
    // de taper un espace dans un texte de la frise, par exemple.
    if(e.target.closest("[contenteditable='true'], input, textarea")) return;
    if(e.key === "Enter" || e.key === " "){
      e.preventDefault();
      tab.click();
    }
  });
});

/* ---- Fiche "passion" agrandie : un clic en dehors d'une tuile (sur
   le fond assombri) la referme, comme une fenêtre modale. ---- */
const occupationsGrid = document.getElementById("occupations");
if(occupationsGrid){
  occupationsGrid.addEventListener("click", (e) => {
    if(e.target !== occupationsGrid) return;
    const active = occupationsGrid.querySelector(".occupation.is-active");
    if(active) flipOccupation(active, false);
  });
}


/* ==================================================================
   4) SWITCH DE LANGUE — bascule le texte des éléments porteurs
      d'attributs data-fr / data-en. Pour rendre une de tes propres
      phrases bilingue (ex : dans les pages projets), ajoute
      simplement data-fr="..." data-en="..." sur l'élément.
================================================================== */
const langButtons = document.querySelectorAll(".lang-switch__btn");
const i18nEls = document.querySelectorAll("[data-fr][data-en]");

langButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    if(btn.classList.contains("is-active")) return;
    const lang = btn.dataset.lang;
    langButtons.forEach(b => b.classList.toggle("is-active", b === btn));
    i18nEls.forEach(el => { el.innerHTML = el.dataset[lang]; });
    document.documentElement.lang = lang;
    sfx.tab();
  });
});


/* ==================================================================
   5) SWITCH CLAIR / SOMBRE — mémorisé d'une visite à l'autre
================================================================== */
const THEME_KEY = "colin_portfolio_theme";
const themeButtons = document.querySelectorAll(".theme-switch__btn");

function applyTheme(theme){
  document.documentElement.setAttribute("data-theme", theme);
  themeButtons.forEach(b => b.classList.toggle("is-active", b.dataset.theme === theme));
}

const savedTheme = localStorage.getItem(THEME_KEY);
if(savedTheme) applyTheme(savedTheme);

themeButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    if(btn.classList.contains("is-active")) return;
    const theme = btn.dataset.theme;
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
    sfx.tab();
  });
});


/* ==================================================================
   6) TABLEAU PHOTO — overlay en liège, ouvert depuis la passion Photo.
      Clic sur une photo punaisée -> vue rapprochée avec inclinaison
      3D et reflet qui suivent la souris (simule un tirage physique).
================================================================== */
const corkboard        = document.getElementById("corkboard");
const corkboardPins    = document.getElementById("corkboardPins");
const corkboardClose   = document.getElementById("corkboardClose");
const openCorkboardBtns = document.querySelectorAll(".corkboard-trigger");

const corkViewer      = document.getElementById("corkboardViewer");
const corkViewerPhoto = document.getElementById("viewerPhoto");
const corkViewerImg   = document.getElementById("viewerImg");

function openCorkboard(){
  if(!corkboard) return;
  corkboard.hidden = false;
  requestAnimationFrame(() => corkboard.classList.add("is-open"));
  sfx.open();
}
function closeCorkboard(){
  if(!corkboard || corkboard.hidden) return;
  closeCorkViewer();
  corkboard.classList.remove("is-open");
  window.setTimeout(() => { corkboard.hidden = true; }, 400);
  sfx.close();
}
openCorkboardBtns.forEach(btn => btn.addEventListener("click", openCorkboard));
if(corkboardClose) corkboardClose.addEventListener("click", closeCorkboard);

function openCorkViewer(imgSrc){
  if(!corkViewer) return;
  corkViewerImg.src = imgSrc;
  corkViewer.hidden = false;
  requestAnimationFrame(() => corkViewer.classList.add("is-open"));
  sfx.photo();
}
function closeCorkViewer(){
  if(!corkViewer || corkViewer.hidden) return;
  corkViewer.classList.remove("is-open");
  corkViewerPhoto.style.transform = "";
  window.setTimeout(() => { corkViewer.hidden = true; }, 300);
}
// clic sur le fond sombre (pas sur la photo elle-même) -> referme,
// seule façon de sortir de la vue rapprochée (pas de croix)
if(corkViewer){
  corkViewer.addEventListener("click", (e) => {
    if(e.target === corkViewer) closeCorkViewer();
  });
}

// Dispose toutes les photos en grille, en fonction de leur nombre
// actuel — s'adapte automatiquement (plus de photos = grille plus
// dense), donc ne se chevauchent jamais, contrairement à l'ancien
// système de positions préréglées qui finissait par se répéter.
// Rendue globale (pas de "const"/"let" au top-level bloquant l'accès)
// pour que l'éditeur puisse la rappeler après un ajout/suppression.
function relayoutCorkboard(){
  const container = document.getElementById("corkboardPins");
  if(!container) return;
  const pins = [...container.querySelectorAll(".corkpin")];
  const n = pins.length;
  if(n === 0) return;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.4)));
  const rows = Math.ceil(n / cols);
  const rotations = [-6, 4, -3, 5, -5, 3, -4, 6, -2, 2, -7, 7];
  const cellW = 100 / cols;
  const cellH = 100 / rows;
  pins.forEach((pin, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    // léger décalage déterministe (pas aléatoire à chaque appel, donc
    // stable) borné à l'intérieur de sa propre cellule
    const jx = (((i * 37) % 100) / 100 - 0.5) * cellW * 0.35;
    const jy = (((i * 53) % 100) / 100 - 0.5) * cellH * 0.35;
    const x = Math.max(9, Math.min(91, col * cellW + cellW / 2 + jx));
    const y = Math.max(10, Math.min(90, row * cellH + cellH / 2 + jy));
    pin.style.setProperty("--x", x + "%");
    pin.style.setProperty("--y", y + "%");
    pin.style.setProperty("--rot", rotations[i % rotations.length] + "deg");
  });
}
window.relayoutCorkboard = relayoutCorkboard;

function wireCorkpin(pin){
  pin.addEventListener("click", () => {
    const img = pin.querySelector("img");
    if(img) openCorkViewer(img.src);
  });
}
document.querySelectorAll(".corkpin").forEach(wireCorkpin);
relayoutCorkboard();

// Inclinaison 3D + reflet qui suivent la position de la souris sur la
// photo agrandie : simule le grain et les reflets d'un vrai tirage
// qu'on incline légèrement dans la main pour mieux le voir.
if(corkViewerPhoto){
  corkViewerPhoto.addEventListener("mousemove", (e) => {
    const rect = corkViewerPhoto.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const rotateY = (px - 0.5) * 16;
    const rotateX = (0.5 - py) * 16;
    corkViewerPhoto.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    corkViewerPhoto.style.setProperty("--glare-x", (px * 100) + "%");
    corkViewerPhoto.style.setProperty("--glare-y", (py * 100) + "%");
  });
  corkViewerPhoto.addEventListener("mouseleave", () => {
    corkViewerPhoto.style.transform = "perspective(800px) rotateX(0deg) rotateY(0deg)";
  });
}

// Échap : referme d'abord la vue rapprochée si elle est ouverte,
// sinon le tableau lui-même — jamais les deux d'un coup.
document.addEventListener("keydown", (e) => {
  if(e.key !== "Escape") return;
  if(corkViewer && !corkViewer.hidden){ closeCorkViewer(); return; }
  if(corkboard && !corkboard.hidden){ closeCorkboard(); return; }
  const activeOcc = document.querySelector(".occupation.is-active");
  if(activeOcc && occupations.length > 1) flipOccupation(activeOcc, false);
});
