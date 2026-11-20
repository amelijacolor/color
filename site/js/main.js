/* All content comes from content.json (edited through the private admin panel). */
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function loadContent() {
  try {
    const r = await fetch(`content.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error("content");
    return await r.json();
  } catch (_) {
    return { about: "", about_image: "", links: { email: "", instagram: "" }, before_after: [], projects: [] };
  }
}
const CONTENT = await loadContent();
const PROJECTS = CONTENT.projects || [];
const BEFORE_AFTER = CONTENT.before_after || [];
const LINKS = CONTENT.links || {};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ==========================================================================
   Film grain — pre-baked single noise tile shifted on GPU (zero CPU loop)
   ========================================================================== */
function initGrain() {
  const el = $("#grain");
  if (!el) return;
  const size = 180;
  const tile = document.createElement("canvas");
  tile.width = tile.height = size;
  const tctx = tile.getContext("2d");
  const img = tctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const light = Math.random() < 0.5;
    d[i] = d[i + 1] = d[i + 2] = light ? 245 : 10;
    d[i + 3] = (Math.random() * 190) | 0;
  }
  tctx.putImageData(img, 0, 0);
  el.style.backgroundImage = `url(${tile.toDataURL("image/png")})`;
}

/* ==========================================================================
   Scroll reveal
   ========================================================================== */
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
  });
}, { threshold: 0.12 });

function armReveals(root) {
  $$(".reveal:not(.is-in), .reveal-wipe:not(.is-in)", root).forEach((el) => io.observe(el));
}

/* ==========================================================================
   Loop media: shows chosen cover image at rest; plays real <video> on hover & project pages
   ========================================================================== */
function loopMedia({ src, poster, variant = 0, playing = false, alt = "" }) {
  return `
    <div class="loop-media v${variant % 4} ${playing ? "" : "is-paused"}" data-src="${esc(src)}">
      <img class="loop-media-still" src="${esc(poster)}" alt="${esc(alt)}" loading="lazy" decoding="async" />
      <video class="loop-media-video" ${playing ? "autoplay" : ""} muted loop playsinline preload="${playing ? "auto" : "metadata"}" poster="${esc(poster)}"></video>
    </div>`;
}

function attachVideo(box, autoplay = false) {
  const video = $("video", box);
  if (!video || !box.dataset.src) return video;
  if (!video.dataset.loaded) {
    video.dataset.loaded = "1";
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    const markReady = () => {
      if (video.videoWidth > 0) {
        box.classList.add("has-video");
        if (!box.classList.contains("is-paused")) video.play().catch(() => {});
      }
    };
    video.addEventListener("loadeddata", markReady);
    video.addEventListener("canplay", markReady);
    video.addEventListener("playing", () => box.classList.add("has-video"));
    video.src = box.dataset.src;
  }
  if (autoplay) {
    video.preload = "auto";
    video.play().catch(() => {});
  }
  return video;
}

function wireMedia(root) {
  $$(".loop-media", root).forEach((box) => {
    const shouldPlay = !box.classList.contains("is-paused");
    if (shouldPlay) attachVideo(box, true);
  });
}

function warmPortfolioVideos() {
  const grid = $("#pf-grid");
  if (!grid) return;
  $$(".loop-media", grid).forEach((box) => attachVideo(box, false));
}

function setPlaying(box, on) {
  if (!box) return;
  box.classList.toggle("is-paused", !on);
  if (on) {
    const video = attachVideo(box, true);
    if (video) {
      if (video.readyState >= 2 && video.videoWidth > 0) box.classList.add("has-video");
      video.play().catch(() => {});
    }
  } else {
    const video = $("video", box);
    if (video) video.pause();
  }
}

function laurelIcon() {
  // two mirrored branches of leaves along an arc
  let g = "";
  for (let k = 0; k < 7; k++) {
    const a = 100 + k * 25;                       // degrees, y-down: 90 = bottom, 180 = left, 270 = top
    const rad = (a * Math.PI) / 180;
    const x = 18 + 12.5 * Math.cos(rad);
    const y = 19 + 12.5 * Math.sin(rad);
    const rot = a - 25;
    g += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="1.9" ry="4" transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})" fill="currentColor"/>`;
    const xr = 36 - x;
    g += `<ellipse cx="${xr.toFixed(1)}" cy="${y.toFixed(1)}" rx="1.9" ry="4" transform="rotate(${-rot} ${xr.toFixed(1)} ${y.toFixed(1)})" fill="currentColor"/>`;
  }
  return `<svg viewBox="0 0 36 36" fill="none" aria-hidden="true">${g}</svg>`;
}

const laurelRow = (l) => {
  const details = [l.distinction, l.year].filter(Boolean).join(" ");
  const qual = l.qualifying ? ` · ${l.qualifying}` : "";
  return `<div class="laurel">${laurelIcon()}<span>${esc(l.festival)}${details ? ` — ${esc(details)}` : ""}${esc(qual)}</span></div>`;
};

function festivalSummary(p) {
  const list = p.laurels || [];
  const won = Math.max(Number(p.festivals_won) || 0, list.filter((l) => l.won).length);
  const total = list.length;
  if (!won && !total) return "";
  const parts = [];
  if (won) parts.push(`${won} ${won === 1 ? "festival win" : "festival wins"}`);
  if (total && total !== won) parts.push(`${total} ${total === 1 ? "festival" : "festivals"}`);
  return parts.join(" · ");
}

/* ==========================================================================
   Home: hero reel (cross-fades through Opening Reel images & rolls film titles)
   ========================================================================== */
function initHero() {
  const frame = $("#hero-frame");
  const now = $("#hero-now");
  const slides = (CONTENT.hero_slides && CONTENT.hero_slides.length)
    ? CONTENT.hero_slides
    : PROJECTS.map((p) => ({ image: p.poster, label: p.title }));
  if (!slides.length) return;

  const isAutoFilename = (s) => /^(IMG|Still|DSC|Screenshot|Frame|PXL|CleanShot)\b/i.test(String(s || "").trim());
  const filmNames = PROJECTS.map((p) => p.title).filter(Boolean);

  frame.innerHTML = slides.map((s, idx) =>
    `<img src="${esc(s.image)}" alt="${esc(filmNames[idx % Math.max(1, filmNames.length)] || "Ameli Mor")}" decoding="async" />`
  ).join("");
  const imgs = $$("img", frame);
  let i = 0;
  let nameIdx = 0;

  const getLabel = (n) => {
    const custom = slides[n] && slides[n].label && !isAutoFilename(slides[n].label) ? slides[n].label : "";
    if (custom) return `${String(n + 1).padStart(2, "0")} — ${custom}`;
    if (filmNames.length) {
      const k = nameIdx % filmNames.length;
      return `${String(k + 1).padStart(2, "0")} — ${filmNames[k]}`;
    }
    return String(n + 1).padStart(2, "0");
  };

  const show = (n, immediate = false) => {
    imgs.forEach((im, k) => im.classList.toggle("is-on", k === n));
    const label = getLabel(n);
    if (immediate) {
      now.textContent = label;
      return;
    }
    now.classList.add("is-swapping");
    setTimeout(() => {
      now.textContent = label;
      now.classList.remove("is-swapping");
    }, 220);
  };
  show(0, true);
  if (imgs.length > 1 || filmNames.length > 1) {
    setInterval(() => {
      if ($("#view-home").hidden || document.hidden) return;
      i = (i + 1) % imgs.length;
      nameIdx = (nameIdx + 1) % Math.max(1, filmNames.length);
      show(i);
    }, 2600);
  }

  // Smooth mouse & scroll counter-parallax (only runs while hero is in view)
  const hero = $(".hero");
  if (!hero || matchMedia("(prefers-reduced-motion: reduce)").matches || !matchMedia("(hover: hover)").matches) return;
  let tx = 0, ty = 0, cx = 0, cy = 0;
  let running = false;

  const wake = () => {
    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  };

  addEventListener("mousemove", (e) => {
    if ($("#view-home").hidden || scrollY > innerHeight) return;
    tx = (e.clientX / innerWidth - 0.5) * 2;
    ty = (e.clientY / innerHeight - 0.5) * 2;
    wake();
  }, { passive: true });

  addEventListener("scroll", () => {
    if ($("#view-home").hidden || scrollY > innerHeight + 40) return;
    hero.style.setProperty("--sy", Math.min(scrollY, innerHeight).toFixed(0));
  }, { passive: true });

  const tick = () => {
    if ($("#view-home").hidden || scrollY > innerHeight) {
      running = false;
      return;
    }
    cx += (tx - cx) * 0.07;
    cy += (ty - cy) * 0.07;
    hero.style.setProperty("--mx", cx.toFixed(3));
    hero.style.setProperty("--my", cy.toFixed(3));
    if (Math.abs(tx - cx) > 0.002 || Math.abs(ty - cy) > 0.002) {
      requestAnimationFrame(tick);
    } else {
      running = false;
    }
  };
}

/* ==========================================================================
   Home: before / after
   ========================================================================== */
function initCompare() {
  const root = $("#compare");
  const range = $("#cmp-range");
  const before = $("#cmp-before");
  const after = $("#cmp-after");
  const tabs = $("#cmp-tabs");
  const count = $("#cmp-count");
  let active = 0;

  const setPos = (v) => { root.style.setProperty("--pos", `${v}%`); range.value = v; };

  function select(n) {
    active = n;
    const s = BEFORE_AFTER[n];
    before.src = s.before; before.alt = `${s.title} — log`;
    after.src = s.after; after.alt = `${s.title} — graded`;
    count.textContent = `${String(n + 1).padStart(2, "0")} / ${String(BEFORE_AFTER.length).padStart(2, "0")}`;
    $$(".compare-tab", tabs).forEach((t, k) => t.classList.toggle("is-active", k === n));
    setPos(50);
  }

  tabs.style.setProperty("--cols", String(BEFORE_AFTER.length));
  tabs.innerHTML = BEFORE_AFTER.map((s, k) =>
    `<button class="compare-tab" data-k="${k}" title="${esc(s.title)}"><strong>${esc(s.title)}</strong><span>${esc(s.camera)}</span></button>`
  ).join("");
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest(".compare-tab");
    if (b) select(Number(b.dataset.k));
  });
  range.addEventListener("input", (e) => setPos(e.target.value));
  select(0);
}

/* ==========================================================================
   Portfolio page
   ========================================================================== */
function initPortfolio() {
  const grid = $("#pf-grid");
  const countEl = $("#pf-count");
  if (countEl) {
    countEl.textContent = `${PROJECTS.length} ${PROJECTS.length === 1 ? "film" : "films"} · hover to play`;
  }
  grid.innerHTML = PROJECTS.map((p, i) => {
    const festSum = festivalSummary(p);
    return `
    <a class="pf-card reveal" href="#/project/${esc(p.slug)}" data-slug="${esc(p.slug)}" data-title="${esc(p.title)}">
      <div class="pf-media">
        ${loopMedia({ src: p.preview, poster: p.poster, variant: i, alt: p.title })}
      </div>
      <div class="pf-meta">
        <div class="pf-row"><span class="pf-name">${esc(p.title)}</span><span class="pf-format">${esc(p.format)}</span></div>
        <div class="pf-camera">${esc(p.camera)}</div>
        ${festSum ? `<div class="pf-fest-count">${esc(festSum)}</div>` : ""}
        ${(p.laurels || []).length ? `<div class="pf-laurels">${p.laurels.map(laurelRow).join("")}</div>` : ""}
      </div>
    </a>`;
  }).join("");

  wireMedia(grid);

  $$(".pf-card", grid).forEach((card) => {
    const box = $(".loop-media", card);
    const on = () => setPlaying(box, true);
    const off = () => setPlaying(box, false);
    card.addEventListener("mouseenter", on);
    card.addEventListener("mouseleave", off);
    card.addEventListener("focus", on);
    card.addEventListener("blur", off);
  });
}

/* ==========================================================================
   Project page (all clips loop at once)
   ========================================================================== */
function renderProject(slug) {
  const i = PROJECTS.findIndex((p) => p.slug === slug);
  if (i < 0) return false;
  const p = PROJECTS[i];
  const next = PROJECTS[(i + 1) % PROJECTS.length];
  const desc = esc(`${p.format} shot on ${p.camera}.`);
  const festSum = festivalSummary(p);

  $("#view-project").innerHTML = `
    <section class="pj-hero">
      ${loopMedia({ src: p.preview, poster: p.poster, variant: 0, playing: true, alt: p.title })}
      <div class="pj-hero-copy">
        <h1 class="pj-title">${esc(p.title)}</h1>
        <div class="pj-hero-side">${esc(p.format)}<br />${esc(p.camera)}</div>
      </div>
    </section>

    <section class="pj-info theme-light">
      <div class="pj-info-inner">
        <h2 class="pj-info-title reveal">${esc(p.format)}.</h2>
        <dl class="pj-credits reveal">
          <div><dt>Role</dt><dd>${esc((p.roles || []).join(" · "))}</dd></div>
          <div><dt>Format</dt><dd>${esc(p.format)}</dd></div>
          <div><dt>Camera</dt><dd>${esc(p.camera)}</dd></div>
          ${festSum ? `<div><dt>Festivals</dt><dd>${esc(festSum)}</dd></div>` : ""}
        </dl>
        <p class="pj-copy reveal">${desc}</p>
        ${p.notes ? `<p class="pj-copy reveal">${esc(p.notes)}</p>` : ""}
        ${p.laurels.length ? `<div class="pj-laurels reveal">${p.laurels.map(laurelRow).join("")}</div>` : ""}
      </div>
    </section>

    <div class="pj-clips-head reveal">
      <span class="eyebrow">Selected clips</span>
      <span class="eyebrow dim">Looping</span>
    </div>
    <section class="pj-grid">
      ${p.clips.map((c, k) => `<div class="pj-clip">${loopMedia({ src: c, poster: p.poster, variant: k + 1, playing: true, alt: `${p.title} clip ${k + 1}` })}</div>`).join("")}
    </section>

    <a class="pj-next" href="#/project/${esc(next.slug)}" data-title="${esc(next.title)}">
      <span class="eyebrow dim">Next up</span>
      <div class="pj-next-title">${esc(next.title)}</div>
    </a>`;

  wireMedia($("#view-project"));
  return true;
}

/* ==========================================================================
   Router + the single page transition (fade through black)
   ========================================================================== */
const fade = $("#fade");
let busy = false;

function applyRoute() {
  const hash = location.hash || "#/";
  const home = $("#view-home"), pf = $("#view-portfolio"), pj = $("#view-project");
  home.hidden = pf.hidden = pj.hidden = true;
  $$("[data-nav]").forEach((a) => a.classList.remove("is-current"));
  $$("#pf-grid .loop-media").forEach((b) => setPlaying(b, false));

  let target = null;
  if (hash.startsWith("#/project/") && renderProject(hash.slice(10))) {
    pj.hidden = false;
    $('[data-nav="portfolio"]').classList.add("is-current");
  } else if (hash === "#/portfolio") {
    pf.hidden = false;
    warmPortfolioVideos();
    $('[data-nav="portfolio"]').classList.add("is-current");
  } else {
    home.hidden = false;
    if (hash === "#/about") {
      target = $("#about");
      $('[data-nav="about"]').classList.add("is-current");
    }
  }

  const view = [home, pf, pj].find((v) => !v.hidden);
  armReveals(view);
  armReveals($("#contact"));
  if (target) target.scrollIntoView({ behavior: "instant" });
  else window.scrollTo({ top: 0, behavior: "instant" });
}

function go(hash) {
  if (busy || (location.hash || "#/") === hash) return;
  busy = true;
  fade.classList.add("on");
  setTimeout(() => {
    location.hash = hash;          // triggers applyRoute via hashchange
    setTimeout(() => { fade.classList.remove("on"); busy = false; }, 80);
  }, 460);
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a) return;
  const href = a.getAttribute("href");
  if (href.startsWith("#/")) {
    e.preventDefault();
    go(href);
  } else if (href === "#contact" ) {
    e.preventDefault();
    $("#contact").scrollIntoView({ behavior: "smooth" });
  } else if (href === "#top") {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
});

/* ==========================================================================
   Contact form (submit directly from the website)
   ========================================================================== */
function initContact() {
  const form = $("#contact-form");
  const status = $("#form-status");
  const btn = $("#send-btn");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.className = "form-status";
    status.textContent = "";

    let valid = true;
    $$(".field", form).forEach((f) => {
      const input = $("input, textarea", f);
      const val = input.value.trim();
      const ok = Boolean(val) && (input.type !== "email" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val));
      f.classList.toggle("invalid", !ok);
      if (!ok) valid = false;
    });

    if (!valid) {
      status.classList.add("err");
      status.textContent = "Please enter your name, a valid email, and a message.";
      return;
    }

    const data = Object.fromEntries(new FormData(form).entries());
    if (data._honey) return;

    const btnLabel = $("span", btn);
    btn.disabled = true;
    if (btnLabel) btnLabel.textContent = "Sending…";

    try {
      let sent = false;
      try {
        const localRes = await fetch("/api/contact", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            to: LINKS.email,
            name: data.name.trim(),
            email: data.email.trim(),
            message: data.message.trim()
          })
        });
        if (localRes.ok) sent = true;
      } catch (_) {}

      if (!sent) {
        const res = await fetch(`https://formsubmit.co/ajax/${LINKS.email}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            name: data.name.trim(),
            email: data.email.trim(),
            message: data.message.trim(),
            _subject: `Project enquiry from ${data.name.trim()}`,
            _replyto: data.email.trim(),
            _captcha: "false"
          })
        });
        if (!res.ok) throw new Error("send failed");
      }

      form.reset();
      status.classList.add("ok");
      status.textContent = "Thank you — your message has been sent.";
    } catch (_) {
      status.classList.add("err");
      status.innerHTML = `Couldn’t send right now — please email <a href="mailto:${esc(LINKS.email)}" class="link">${esc(LINKS.email)}</a>.`;
    } finally {
      btn.disabled = false;
      if (btnLabel) btnLabel.textContent = "Send message";
    }
  });

  $$(".field input, .field textarea", form).forEach((el) =>
    el.addEventListener("input", () => el.closest(".field").classList.remove("invalid"))
  );
}

/* ==========================================================================
   Static copy driven by content.json
   ========================================================================== */
function applyContent() {
  const about = $("#about-body");
  if (about && CONTENT.about) about.textContent = CONTENT.about;
  const aboutImg = $("#about-img");
  if (aboutImg && CONTENT.about_image) aboutImg.src = CONTENT.about_image;
  $$("[data-email]").forEach((el) => {
    if (!LINKS.email) return;
    el.href = `mailto:${LINKS.email}`;
    if (el.dataset.email === "text") el.textContent = LINKS.email;
  });
  $$("[data-instagram]").forEach((el) => { if (LINKS.instagram) el.href = LINKS.instagram; });
}

/* ==========================================================================
   Single-body liquid cursor with true 2D vector inertia (smooth turns & reversals)
   ========================================================================== */
function initCursor() {
  const main = $("#cursor-main");
  const textWrap = $("#cursor-text");
  const kicker = $("#cursor-kicker");
  if (!main || !textWrap || !kicker) return;
  if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;

  document.body.classList.add("has-cursor");

  let tx = -200, ty = -200;
  let cx = -200, cy = -200;
  // Smoothed 2D liquid momentum vector — passes naturally through (0, 0) on reversals
  // so direction changes slosh smoothly instead of spinning or snapping.
  let svx = 0, svy = 0;
  let angle = 0;
  let wobble = 0;
  let wobbleVel = 0;
  let started = false;
  let running = false;
  let currentBlock = null;
  let scrollPending = false;

  const wake = () => {
    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  };

  const updateState = (target) => {
    if (!target || !target.closest) return;
    if (target.closest('input[type="text"], input[type="email"], textarea')) {
      main.classList.add("is-hidden");
      textWrap.classList.add("is-hidden");
      main.classList.remove("is-view", "is-link");
      textWrap.classList.remove("is-visible");
      currentBlock = null;
      return;
    }
    main.classList.remove("is-hidden");
    textWrap.classList.remove("is-hidden");

    const block = target.closest(".pf-card, .pj-next");
    const cmp = target.closest("#compare");

    if (block) {
      if (block !== currentBlock) {
        currentBlock = block;
        wobbleVel += 0.14;
        wake();
      }
      main.classList.add("is-view");
      main.classList.remove("is-link");
      textWrap.classList.add("is-visible");
      kicker.textContent = "View";
    } else if (cmp) {
      if (cmp !== currentBlock) {
        currentBlock = cmp;
        wobbleVel += 0.12;
        wake();
      }
      main.classList.add("is-view");
      main.classList.remove("is-link");
      textWrap.classList.add("is-visible");
      kicker.textContent = "Drag";
    } else if (target.closest("a, button")) {
      currentBlock = null;
      main.classList.remove("is-view");
      main.classList.add("is-link");
      textWrap.classList.remove("is-visible");
      kicker.textContent = "";
    } else {
      currentBlock = null;
      main.classList.remove("is-view", "is-link");
      textWrap.classList.remove("is-visible");
      kicker.textContent = "";
    }
  };

  addEventListener("mousemove", (e) => {
    tx = e.clientX;
    ty = e.clientY;
    if (!started) {
      cx = tx;
      cy = ty;
      started = true;
      main.classList.add("is-visible");
    }
    updateState(e.target);
    wake();
  }, { passive: true });

  // Only check element under pointer on scroll (throttled) and route change — never inside 60fps rAF
  const syncAtPointer = () => {
    if (!started || tx < 0 || ty < 0) return;
    updateState(document.elementFromPoint(tx, ty));
  };
  addEventListener("scroll", () => {
    if (scrollPending) return;
    scrollPending = true;
    setTimeout(() => { scrollPending = false; syncAtPointer(); }, 120);
  }, { passive: true });
  addEventListener("hashchange", () => setTimeout(syncAtPointer, 60));

  document.addEventListener("mouseleave", () => {
    main.classList.remove("is-visible");
    textWrap.classList.remove("is-visible");
  });
  document.addEventListener("mouseenter", () => {
    if (started) main.classList.add("is-visible");
  });

  const tick = (now) => {
    const isBig = main.classList.contains("is-view");

    const followRate = isBig ? 0.13 : 0.16;
    const vx = (tx - cx) * followRate;
    const vy = (ty - cy) * followRate;
    cx += vx;
    cy += vy;

    const vecLerp = isBig ? 0.11 : 0.16;
    svx += (vx - svx) * vecLerp;
    svy += (vy - svy) * vecLerp;

    const vecSpeed = Math.hypot(svx, svy);
    if (vecSpeed > 0.15) {
      angle = Math.atan2(svy, svx);
    }

    wobbleVel += -wobble * 0.11;
    wobbleVel *= 0.84;
    wobble += wobbleVel;

    const maxRef = isBig ? 14 : 11;
    const norm = Math.min(1, vecSpeed / maxRef);
    const maxStretch = isBig ? 0.34 : 0.52;
    const stretch = Math.pow(norm, 1.35) * maxStretch;
    const squash = stretch * 0.46;

    const sx = Math.max(0.84, 1 + stretch + wobble * 0.25);
    const sy = Math.max(0.68, 1 - squash - wobble * 0.22);

    const slosh = Math.sin(now * 0.008) * norm * 3.5;
    const tail = norm * (isBig ? 9 : 13);
    const r1 = 50 + tail + slosh;
    const r2 = 50 - tail * 0.35 - slosh;
    const r3 = 50 - tail * 0.35 + slosh;
    const r4 = 50 + tail - slosh;
    main.style.borderRadius = `${r1.toFixed(1)}% ${r2.toFixed(1)}% ${r3.toFixed(1)}% ${r4.toFixed(1)}% / ${(50 - slosh * 0.6).toFixed(1)}% ${(50 + slosh * 0.6).toFixed(1)}% ${(50 - slosh * 0.6).toFixed(1)}% ${(50 + slosh * 0.6).toFixed(1)}%`;

    main.style.transform =
      `translate3d(${cx}px, ${cy}px, 0) translate(-50%, -50%) rotate(${angle.toFixed(3)}rad) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;

    textWrap.style.transform =
      `translate3d(${cx}px, ${cy}px, 0) translate(-50%, -50%)`;

    const settled =
      Math.hypot(tx - cx, ty - cy) < 0.2 &&
      vecSpeed < 0.05 &&
      Math.abs(wobble) < 0.004 &&
      Math.abs(wobbleVel) < 0.004;

    if (settled) {
      running = false;
    } else {
      requestAnimationFrame(tick);
    }
  };
}

/* ==========================================================================
   Boot
   ========================================================================== */
applyContent();
initGrain();
initCursor();
if ((CONTENT.hero_slides && CONTENT.hero_slides.length) || PROJECTS.length) initHero();
if (BEFORE_AFTER.length) initCompare();
initPortfolio();
initContact();
addEventListener("hashchange", applyRoute);
applyRoute();
