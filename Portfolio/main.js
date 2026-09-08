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
   0) SONS — petit moteur de sound design (Web Audio), sans fichiers
      externes. Chaque son est construit en couches, comme en prod :
        · une TRANSITOIRE (clic bruité très court) qui donne l'attaque
        · un CORPS tonal (sinus filtré) qui donne la matière
        · un peu de BRUIT filtré qui donne la texture/l'air
        · une REVERB courte partagée qui donne l'espace
      C'est ce qui distingue un son "bip d'oscillateur" d'un son
      d'interface moderne : rien n'est un oscillateur nu.
================================================================== */
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let actx = null;
let audioBus = null;
let reverbSend = null;

function getAudioContext(){
  if(!actx) actx = new AudioCtx();
  if(actx.state === "suspended") actx.resume();
  return actx;
}

function makeSoftCurve(amount = 1.3){
  const n = 1024;
  const curve = new Float32Array(n);
  for(let i = 0; i < n; i++){
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

/* Réverb douce et sombre : donne l'impression d'un instrument dans une
   pièce, pas d'un son collé à l'oreille. */
function makeImpulseResponse(c, duration = 0.9, decay = 2.6){
  const rate = c.sampleRate;
  const len = Math.max(1, Math.floor(rate * duration));
  const impulse = c.createBuffer(2, len, rate);
  for(let ch = 0; ch < 2; ch++){
    const data = impulse.getChannelData(ch);
    let last = 0;
    for(let i = 0; i < len; i++){
      const t = i / len;
      last = (last + (Math.random() * 2 - 1) * 0.3) / 1.3; // bruit lissé = queue douce
      data[i] = last * Math.pow(1 - t, decay);
    }
  }
  return impulse;
}

/* Bus master. Le passe-bas est haut (7 kHz) : avec des sinus purs il
   n'y a aucun harmonique parasite à filtrer, contrairement au bruit. */
function getBus(){
  const c = getAudioContext();
  if(audioBus) return { c, bus:audioBus, send:reverbSend };

  const round = c.createBiquadFilter();
  round.type = "lowpass";
  round.frequency.value = 7000;
  round.Q.value = 0.5;

  const shaper = c.createWaveShaper();
  shaper.curve = makeSoftCurve(1.3);
  shaper.oversample = "2x";

  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 30;
  comp.ratio.value = 3;
  comp.attack.value = 0.006;
  comp.release.value = 0.25;

  const master = c.createGain();
  master.gain.value = 1.0;

  round.connect(shaper).connect(comp).connect(master).connect(c.destination);

  const conv = c.createConvolver();
  conv.buffer = makeImpulseResponse(c);
  const wetLP = c.createBiquadFilter();
  wetLP.type = "lowpass";
  wetLP.frequency.value = 2600;
  const wet = c.createGain();
  wet.gain.value = 0.5;
  const send = c.createGain();
  send.gain.value = 1;
  send.connect(conv).connect(wetLP).connect(wet).connect(comp);

  audioBus = round;
  reverbSend = send;
  return { c, bus:round, send };
}

/* ------------------------------------------------------------------
   MAILLET — synthèse additive, façon bambou / marimba / kalimba.

   Chaque partiel est un SINUS PUR (aucun bruit : c'est ce qui rend le
   son clean plutôt que grésillant), à une fréquence inharmonique, et
   surtout : plus un partiel est aigu, plus vite il s'éteint. C'est
   exactement ce que fait un objet en bois — et c'est ce qui donne la
   chaleur, parce que le son devient de plus en plus rond en mourant.
------------------------------------------------------------------ */
function mallet(c, bus, send, {
  t0,
  root = 330,
  ratios = [1, 2.76, 5.40],   // modes d'une barre/tube de bois
  gains  = [1, 0.30, 0.11],
  decays = [0.45, 0.20, 0.10],// les aigus meurent en premier = chaleur
  attack = 0.004,
  gain = 0.11,
  reverb = 0.30,
  detune = 0,
}){
  ratios.forEach((r, i) => {
    const osc = c.createOscillator();
    osc.type = "sine";
    // micro-désaccord : deux frappes ne sont jamais identiques
    osc.detune.value = detune + (Math.random() * 8 - 4);
    osc.frequency.value = root * r;

    const g = c.createGain();
    const peak = gain * (gains[i] !== undefined ? gains[i] : 0.1);
    const dec  = decays[i] !== undefined ? decays[i] : 0.12;
    // attaque courte mais pas instantanée : une attaque à zéro produit
    // un "clic" numérique, ce qui casse tout le côté doux
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + dec);

    osc.connect(g);
    g.connect(bus);
    if(reverb > 0){
      const rs = c.createGain();
      rs.gain.value = reverb;
      g.connect(rs).connect(send);
    }
    osc.start(t0);
    osc.stop(t0 + attack + dec + 0.05);
  });
}

const lastPlayed = Object.create(null);
function throttled(name, minGap, fn){
  const now = performance.now();
  if(lastPlayed[name] && now - lastPlayed[name] < minGap) return;
  lastPlayed[name] = now;
  fn();
}
function vary(base, pct = 0.012){
  return base * (1 + (Math.random() * 2 - 1) * pct);
}

/* Gamme pentatonique : toutes les notes sonnent bien ensemble, donc
   deux clics rapprochés ne créent jamais de dissonance. */
const NOTES = { do:261.6, re:293.7, mi:329.6, sol:392.0, la:440.0, do2:523.3, re2:587.3, mi2:659.3 };

const sfx = {
  /* Onglet : une note de bambou, ronde et courte. */
  tab(){
    throttled("tab", 50, () => {
      try{
        const { c, bus, send } = getBus();
        mallet(c, bus, send, {
          t0:c.currentTime, root:vary(NOTES.sol),
          ratios:[1, 2.76, 5.4], gains:[1, 0.26, 0.09], decays:[0.34, 0.15, 0.07],
          attack:0.004, gain:0.12, reverb:0.28,
        });
      }catch(err){ /* audio indisponible */ }
    });
  },

  /* Sélection : même bois, une quinte au-dessus, un peu plus chantant. */
  select(){
    throttled("select", 50, () => {
      try{
        const { c, bus, send } = getBus();
        mallet(c, bus, send, {
          t0:c.currentTime, root:vary(NOTES.re2),
          ratios:[1, 2.72, 5.3], gains:[1, 0.24, 0.08], decays:[0.42, 0.18, 0.08],
          attack:0.0035, gain:0.115, reverb:0.34,
        });
      }catch(err){ /* audio indisponible */ }
    });
  },

  /* Ouverture : deux notes qui montent. Le mouvement vient de
     l'intervalle, pas d'un balayage de fréquence — c'est musical et
     ça reste propre. */
  open(){
    throttled("open", 70, () => {
      try{
        const { c, bus, send } = getBus();
        const t = c.currentTime;
        mallet(c, bus, send, {
          t0:t, root:vary(NOTES.do), ratios:[1, 2.8, 5.5], gains:[1, 0.22, 0.08],
          decays:[0.5, 0.2, 0.09], attack:0.005, gain:0.11, reverb:0.34,
        });
        mallet(c, bus, send, {
          t0:t + 0.075, root:vary(NOTES.sol), ratios:[1, 2.76, 5.4], gains:[1, 0.24, 0.08],
          decays:[0.55, 0.22, 0.1], attack:0.004, gain:0.10, reverb:0.38,
        });
      }catch(err){ /* audio indisponible */ }
    });
  },

  /* Fermeture : les deux mêmes notes, en descendant. */
  close(){
    throttled("close", 70, () => {
      try{
        const { c, bus, send } = getBus();
        const t = c.currentTime;
        mallet(c, bus, send, {
          t0:t, root:vary(NOTES.sol), ratios:[1, 2.76, 5.4], gains:[1, 0.24, 0.08],
          decays:[0.4, 0.17, 0.08], attack:0.004, gain:0.10, reverb:0.30,
        });
        mallet(c, bus, send, {
          t0:t + 0.075, root:vary(NOTES.do), ratios:[1, 2.8, 5.5], gains:[1, 0.2, 0.07],
          decays:[0.5, 0.2, 0.09], attack:0.005, gain:0.105, reverb:0.34,
        });
      }catch(err){ /* audio indisponible */ }
    });
  },

  /* Défilement : petite goutte de bois, très douce. Volontairement
     discrète : elle se répète beaucoup pendant un glissement. */
  scroll(){
    throttled("scroll", 60, () => {
      try{
        const { c, bus, send } = getBus();
        mallet(c, bus, send, {
          t0:c.currentTime, root:vary(NOTES.mi2),
          ratios:[1, 2.7], gains:[1, 0.16], decays:[0.13, 0.06],
          attack:0.003, gain:0.05, reverb:0.22,
        });
      }catch(err){ /* audio indisponible */ }
    });
  },

  /* Photo décrochée : deux notes très proches, comme deux tubes de
     bambou qui se touchent — plus doux qu'un simple clic. */
  photo(){
    throttled("photo", 70, () => {
      try{
        const { c, bus, send } = getBus();
        const t = c.currentTime;
        mallet(c, bus, send, {
          t0:t, root:vary(NOTES.la), ratios:[1, 2.74, 5.35], gains:[1, 0.2, 0.07],
          decays:[0.3, 0.13, 0.06], attack:0.003, gain:0.09, reverb:0.30,
        });
        mallet(c, bus, send, {
          t0:t + 0.045, root:vary(NOTES.mi), ratios:[1, 2.8, 5.5], gains:[1, 0.22, 0.08],
          decays:[0.5, 0.2, 0.09], attack:0.005, gain:0.10, reverb:0.36,
        });
      }catch(err){ /* audio indisponible */ }
    });
  },
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
// les pages. Un petit son marque chaque changement de page pendant le glissement.
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
    }
  };

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
});


/* ==================================================================
   3) ABOUT ME — panneaux diagonaux, un seul zoomé à la fois.
      Pas de texte d'instruction : au premier passage sur l'onglet,
      une petite vague fait "peeker" chaque panneau tour à tour pour
      suggérer l'interaction sans l'écrire.
================================================================== */
const occupations = document.querySelectorAll(".occupation");

occupations.forEach(occ => {
  occ.addEventListener("click", (e) => {
    // ne jamais changer quelle passion est active si le clic vient
    // d'un texte en cours d'édition (éditeur visuel) — sinon cliquer
    // pour positionner le curseur relance aussi l'animation et coupe
    // le focus au même moment.
    if(e.target.closest('[contenteditable="true"]')) return;
    if(occ.classList.contains("is-active")) return;
    occupations.forEach(o => o.classList.remove("is-active"));
    occ.classList.add("is-active");
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

/* ---- Navigation de la frise (flèches gauche/droite) --------------
   stopPropagation pour ne jamais interférer avec le clic du panneau
   "Moi" qui l'entoure. */
document.querySelectorAll(".timeline__nav").forEach(btn => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const timeline = btn.closest(".about-tab__content")?.querySelector(".timeline");
    if(!timeline) return;
    const amount = timeline.clientWidth * 0.7;
    timeline.scrollBy({ left: btn.classList.contains("timeline__nav--prev") ? -amount : amount, behavior:"smooth" });
  });
});


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
const THEME_KEY = "portfolio_theme";
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
  if(corkboard && !corkboard.hidden){ closeCorkboard(); }
});
