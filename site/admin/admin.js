(() => {
  "use strict";
  const app = document.getElementById("app");
  const MAX_CLIPS = 8;
  const GH_MAX_UPLOAD = 24 * 1024 * 1024; // ~24 MB safe limit for GitHub Contents REST API

  let mode = "local"; // "local" (admin.py on 127.0.0.1:8091) | "github" (live on custom URL / GitHub Pages)
  let csrf = null;
  let gh = null; // { owner, repo, branch, token, contentSha }
  let content = null;
  let messages = [];
  let backups = [];
  let gitInfo = null;
  let tab = "films";
  let dirty = false;
  const open = new Set();
  const blobPreviews = new Map(); // path -> objectURL for immediate preview before Pages rebuilds

  /* ---------------------------------------------------------------- helpers */
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
    kids.flat(Infinity).forEach((c) => {
      if (c == null || c === false) return;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return el;
  };

  const slugify = (s) =>
    String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "film";

  const mediaSrc = (path) => {
    if (!path) return "";
    if (blobPreviews.has(path)) return blobPreviews.get(path);
    return mode === "local" ? "/media/" + path : "../" + path;
  };

  const siteUrl = () => (mode === "local" ? "http://127.0.0.1:8090" : "../");

  function toast(msg, isErr = false) {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const t = h("div", { class: "toast" + (isErr ? " err" : "") }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), isErr ? 6500 : 3200);
  }

  function markDirty() {
    dirty = true;
    const el = document.getElementById("dirty");
    if (el) { el.textContent = "Unsaved changes"; el.classList.add("on"); }
  }
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  function getFestivalStats(p) {
    const list = (p.laurels || []).filter((l) => l && (l.festival || l.distinction));
    const checkedWins = list.filter((l) => l.won).length;
    const wins = Math.max(Number(p.festivals_won) || 0, checkedWins);
    return { total: list.length, wins, checkedWins };
  }

  function festivalPill(p) {
    const { total, wins } = getFestivalStats(p);
    if (wins > 0 && total > wins) return h("span", { class: "pill won" }, `${wins} ${wins === 1 ? "win" : "wins"} · ${total} festivals`);
    if (wins > 0) return h("span", { class: "pill won" }, `${wins} festival ${wins === 1 ? "win" : "wins"}`);
    if (total > 0) return h("span", { class: "pill" }, `${total} ${total === 1 ? "festival" : "festivals"}`);
    return h("span", { class: "pill dim" }, "No festivals");
  }

  /* ------------------------------------------------------------ Local API */
  async function localApi(path, method = "GET", body) {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf || "" },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { await boot(); throw new Error("Please sign in again"); }
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    return data;
  }

  function localUpload(file, kind, slug, purpose, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const q = new URLSearchParams({ kind, slug, purpose, name: file.name });
      xhr.open("POST", `/api/upload?${q}`);
      xhr.setRequestHeader("X-CSRF-Token", csrf || "");
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (_) {}
        xhr.status === 200 ? resolve(data.path) : reject(new Error(data.error || "Upload failed"));
      };
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.send(file);
    });
  }

  /* ----------------------------------------------------------- GitHub API */
  const GH_STORAGE_KEY = "ameli_gh_session_v1";

  function loadStoredGh() {
    try {
      const s = sessionStorage.getItem(GH_STORAGE_KEY) || localStorage.getItem(GH_STORAGE_KEY);
      return s ? JSON.parse(s) : null;
    } catch (_) { return null; }
  }

  function saveStoredGh(cfg, remember) {
    sessionStorage.removeItem(GH_STORAGE_KEY);
    localStorage.removeItem(GH_STORAGE_KEY);
    if (!cfg) return;
    const raw = JSON.stringify({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, token: cfg.token });
    (remember ? localStorage : sessionStorage).setItem(GH_STORAGE_KEY, raw);
  }

  async function ghReq(endpoint, method = "GET", body) {
    const res = await fetch(`https://api.github.com${endpoint}`, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${gh.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      throw new Error(data.message || "GitHub token invalid or missing Contents read/write permission for this repo");
    }
    if (!res.ok) {
      const err = new Error(data.message || `GitHub error (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function base64ToUtf8(b64) {
    const bin = atob(b64.replace(/\n/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(new Error("Could not read file"));
      r.readAsDataURL(file);
    });
  }

  async function ghLoadContent() {
    const file = await ghReq(`/repos/${gh.owner}/${gh.repo}/contents/site/content.json?ref=${encodeURIComponent(gh.branch)}&_=${Date.now()}`);
    gh.contentSha = file.sha;
    return JSON.parse(base64ToUtf8(file.content));
  }

  async function ghSaveContent(data, message = "Update portfolio content") {
    const encoded = utf8ToBase64(JSON.stringify(data, null, 2) + "\n");
    const putWithSha = async (sha) => {
      const res = await ghReq(`/repos/${gh.owner}/${gh.repo}/contents/site/content.json`, "PUT", {
        message,
        branch: gh.branch,
        sha,
        content: encoded,
      });
      gh.contentSha = res.content.sha;
    };

    try {
      const sha = gh.contentSha || (await ghReq(`/repos/${gh.owner}/${gh.repo}/contents/site/content.json?ref=${encodeURIComponent(gh.branch)}&_=${Date.now()}`)).sha;
      await putWithSha(sha);
    } catch (err) {
      if (err && err.status === 409) {
        const fresh = await ghReq(`/repos/${gh.owner}/${gh.repo}/contents/site/content.json?ref=${encodeURIComponent(gh.branch)}&_=${Date.now()}`);
        await putWithSha(fresh.sha);
      } else {
        throw err;
      }
    }
  }

  async function ghUploadFile(file, kind, slug, purpose, onProgress) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const imgExts = ["png", "jpg", "jpeg", "webp"];
    const vidExts = ["mp4", "webm"];
    const folder = kind === "image" && imgExts.includes(ext) ? "images" : kind === "video" && vidExts.includes(ext) ? "videos" : null;
    if (!folder) throw new Error("Unsupported file. Images: PNG, JPG, WEBP. Videos: MP4 or WEBM.");
    if (file.size > GH_MAX_UPLOAD) {
      throw new Error("File is over 24 MB. For large videos, run start.command on your Mac and push with git.");
    }
    onProgress(0.25);
    const b64 = await fileToBase64(file);
    onProgress(0.55);
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
    const safeSlug = slugify(slug);
    const name = `${safeSlug}-${purpose}-${rand}.${ext}`;
    const repoPath = `site/assets/${folder}/${name}`;
    await ghReq(`/repos/${gh.owner}/${gh.repo}/contents/${repoPath}`, "PUT", {
      message: `Upload ${name}`,
      branch: gh.branch,
      content: b64,
    });
    onProgress(1);
    const relPath = `assets/${folder}/${name}`;
    blobPreviews.set(relPath, URL.createObjectURL(file));
    return relPath;
  }

  async function ghLoadHistory() {
    const commits = await ghReq(`/repos/${gh.owner}/${gh.repo}/commits?path=site/content.json&sha=${encodeURIComponent(gh.branch)}&per_page=20`);
    return commits.map((c) => ({
      sha: c.sha,
      date: c.commit.author.date,
      message: c.commit.message,
    }));
  }

  async function ghRestoreCommit(sha) {
    const file = await ghReq(`/repos/${gh.owner}/${gh.repo}/contents/site/content.json?ref=${encodeURIComponent(sha)}`);
    const restored = JSON.parse(base64ToUtf8(file.content));
    await ghSaveContent(restored, `Restore content from ${sha.slice(0, 7)}`);
    return restored;
  }

  function validateLocal(data) {
    if (!data.links || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.links.email || "").trim())) {
      throw new Error("Please enter a valid contact email under About & Contact.");
    }
    if (!data.before_after || !data.before_after.length) throw new Error("Add at least 1 Before & After pair.");
    data.before_after.forEach((b, i) => {
      if (!b.title || !b.before || !b.after) throw new Error(`Before & After #${i + 1} needs a title, Log image, and Graded image.`);
      b.roles = (b.roles || []).map((r) => String(r || "").trim()).filter(Boolean).slice(0, 4);
      if (!b.roles.length) b.roles = ["Colorist"];
    });
    if (!data.projects || !data.projects.length) throw new Error("Add at least 1 film.");
    data.hero_slides = (data.hero_slides || [])
      .filter((s) => s && String(s.image || "").trim())
      .map((s) => ({ image: String(s.image).trim(), label: String(s.label || "").trim() }));
    data.projects.forEach((p, i) => {
      if (!p.title) throw new Error(`Film #${i + 1} needs a title.`);
      if (!p.poster) throw new Error(`Film “${p.title}” needs a cover image before saving.`);
      p.festivals_won = Math.max(0, Math.min(99, parseInt(p.festivals_won, 10) || 0));
      p.laurels = (p.laurels || [])
        .filter((l) => l && String(l.festival || "").trim())
        .map((l) => ({
          festival: String(l.festival || "").trim(),
          distinction: String(l.distinction || "").trim(),
          year: String(l.year || "").trim(),
          qualifying: String(l.qualifying || "").trim(),
          won: Boolean(l.won),
        }));
      p.clips = (p.clips || []).filter((c) => String(c || "").trim());
    });
  }

  /* ----------------------------------------------------------------- inputs */
  function textField(label, obj, key, opts = {}) {
    const input = opts.multiline
      ? h("textarea", { rows: opts.rows || 4, placeholder: opts.placeholder || "" })
      : h("input", { type: opts.type || "text", placeholder: opts.placeholder || "", autocomplete: "off" });
    input.value = obj[key] || "";
    input.addEventListener("input", () => { obj[key] = input.value; markDirty(); opts.onInput && opts.onInput(); });
    return h("label", { class: "f" }, h("span", {}, label), input, opts.hint ? h("div", { class: "hint" }, opts.hint) : null);
  }

  function mediaField({ label, kind, getValue, setValue, slug, purpose, onRemove }) {
    const wrap = h("div", { class: "media" });
    const render = () => {
      wrap.innerHTML = "";
      const value = getValue();
      const url = mediaSrc(value);
      let preview;
      if (value && kind === "image") {
        preview = h("img", { class: "thumb", src: url, alt: "" });
        preview.addEventListener("error", () => preview.replaceWith(h("div", { class: "vid" }, "missing")));
      } else if (value && kind === "video") {
        preview = h("video", { src: url, preload: "metadata", muted: true, controls: true });
        preview.addEventListener("error", () => preview.replaceWith(h("div", { class: "vid" }, "not uploaded yet")));
      } else {
        preview = h("div", { class: "vid" }, "no file");
      }
      const prog = h("div", { class: "prog", hidden: true }, h("i"));
      const input = h("input", { type: "file", hidden: true, accept: kind === "image" ? "image/png,image/jpeg,image/webp" : "video/mp4,video/webm" });
      const status = h("div", { class: "hint", hidden: true });
      input.addEventListener("change", async () => {
        const file = input.files[0];
        if (!file) return;
        prog.hidden = false; status.hidden = true;
        try {
          const uploader = mode === "local" ? localUpload : ghUploadFile;
          const path = await uploader(file, kind, slug(), purpose, (p) => (prog.firstChild.style.width = Math.round(p * 100) + "%"));
          setValue(path);
          markDirty();
          toast(mode === "github" ? "Uploaded to GitHub — press Save & Publish" : "Uploaded — remember to press Save");
          render();
        } catch (e) {
          prog.hidden = true; status.hidden = false; status.textContent = e.message;
          toast(e.message, true);
        }
      });
      wrap.append(
        preview,
        h("div", { class: "media-info" },
          h("div", { class: "media-kind" }, label),
          h("div", { class: "media-name", title: value }, value ? value.split("/").pop() : "Nothing uploaded"),
          prog, status),
        h("button", { class: "btn ghost small", type: "button", onclick: () => input.click() }, value ? "Replace" : "Upload"),
        onRemove ? h("button", { class: "btn danger small", type: "button", onclick: onRemove }, "Remove") : null,
        input
      );
    };
    render();
    return wrap;
  }

  /* ---------------------------------------------------------------- screens */
  function localAuthScreen(setup, error = "") {
    const pw = h("input", { type: "password", placeholder: setup ? "Choose a password (10+ characters)" : "Password", autocomplete: setup ? "new-password" : "current-password", autofocus: true });
    const pw2 = setup ? h("input", { type: "password", placeholder: "Repeat password", autocomplete: "new-password", style: "margin-top:10px" }) : null;
    const err = h("div", { class: "err" }, error);
    const submit = async (e) => {
      e.preventDefault();
      err.textContent = "";
      if (setup && pw.value !== pw2.value) { err.textContent = "Passwords don't match"; return; }
      try {
        const r = await localApi(setup ? "/api/setup" : "/api/login", "POST", { password: pw.value });
        csrf = r.csrf;
        await load();
      } catch (ex) { err.textContent = ex.message; }
    };
    app.innerHTML = "";
    app.append(h("div", { class: "auth" },
      h("form", { class: "auth-card", onsubmit: submit },
        h("h1", {}, setup ? "Create your admin password" : "Sign in"),
        h("p", {}, setup
          ? "This local admin runs only on your Mac. Choose a strong password (10+ characters)."
          : "Ameli Mor — local site admin"),
        pw, pw2,
        h("div", { style: "margin-top:16px" }, h("button", { class: "btn", type: "submit" }, setup ? "Create password" : "Sign in")),
        err)));
  }

  function githubAuthScreen(error = "") {
    const savedMeta = (() => {
      try { return JSON.parse(localStorage.getItem("ameli_gh_meta_v1") || "{}"); } catch (_) { return {}; }
    })();
    const ownerIn = h("input", { type: "text", placeholder: "amelijacolor", value: savedMeta.owner || "amelijacolor", autocomplete: "username" });
    const repoIn = h("input", { type: "text", placeholder: "color", value: savedMeta.repo || "color" });
    const branchIn = h("input", { type: "text", placeholder: "main", value: savedMeta.branch || "main" });
    const tokenIn = h("input", { type: "password", placeholder: "github_pat_… (Fine-grained token)", autocomplete: "current-password" });
    const rememberIn = h("input", { type: "checkbox" });
    const err = h("div", { class: "err" }, error);
    const submitBtn = h("button", { class: "btn", type: "submit" }, "Sign in with GitHub");

    const submit = async (e) => {
      e.preventDefault();
      err.textContent = "";
      const owner = ownerIn.value.trim();
      const repo = repoIn.value.trim();
      const branch = branchIn.value.trim() || "main";
      const token = tokenIn.value.trim();
      if (!owner || !repo || !token) {
        err.textContent = "Please enter your GitHub username, repository name, and token.";
        return;
      }
      submitBtn.disabled = true; submitBtn.textContent = "Connecting…";
      gh = { owner, repo, branch, token };
      try {
        content = await ghLoadContent();
        localStorage.setItem("ameli_gh_meta_v1", JSON.stringify({ owner, repo, branch }));
        saveStoredGh(gh, rememberIn.checked);
        normalizeContent();
        shell();
      } catch (ex) {
        gh = null;
        err.textContent = ex.message;
        submitBtn.disabled = false; submitBtn.textContent = "Sign in with GitHub";
      }
    };

    app.innerHTML = "";
    app.append(h("div", { class: "auth" },
      h("form", { class: "auth-card", onsubmit: submit },
        h("h1", {}, "Ameli Mor — Site Admin"),
        h("p", {}, "Sign in with your private GitHub token to edit your live website directly from your custom URL. Nothing is ever stored on any third-party server."),
        h("div", { class: "row" },
          h("label", { class: "f" }, h("span", {}, "GitHub Username"), ownerIn),
          h("label", { class: "f" }, h("span", {}, "Repository Name"), repoIn)),
        h("div", { class: "row" },
          h("label", { class: "f" }, h("span", {}, "Branch"), branchIn),
          h("label", { class: "f" }, h("span", {}, "Private Token"), tokenIn)),
        h("label", { class: "check-row" }, rememberIn, "Remember token on this browser (personal device only)"),
        h("div", { style: "margin-top:16px" }, submitBtn),
        err,
        h("details", { class: "auth-guide" },
          h("summary", {}, "How to create your private GitHub token (takes 1 minute)"),
          h("ol", {},
            h("li", {}, "On GitHub, open ", h("strong", {}, "Settings → Developer settings → Personal access tokens → Fine-grained tokens"), "."),
            h("li", {}, "Click ", h("strong", {}, "Generate new token"), " and under ", h("strong", {}, "Repository access"), " choose ", h("code", {}, "Only select repositories"), " → pick your website repo."),
            h("li", {}, "Under ", h("strong", {}, "Permissions → Repository permissions"), ", set ", h("code", {}, "Contents"), " to ", h("code", {}, "Read and write"), "."),
            h("li", {}, "Generate the token, copy it, and paste it above. You can revoke it on GitHub anytime."))))));
  }

  function shell() {
    const unread = messages.filter((m) => !m.read).length;
    const navBtn = (id, label, badge) =>
      h("button", { class: "nav-btn" + (tab === id ? " is-active" : ""), onclick: () => switchTab(id) },
        label, badge ? h("span", { class: "badge" }, badge) : null);

    const titles = {
      films: "Films",
      hero: "Opening Reel",
      ba: "Before & After",
      about: "About & Contact",
      messages: "Messages",
      backups: mode === "github" ? "Version History" : "Backups",
      publish: "GitHub & Custom URL",
      account: "Account",
    };
    const canSave = ["films", "hero", "ba", "about"].includes(tab);

    app.innerHTML = "";
    app.append(h("div", { class: "shell" },
      h("aside", { class: "side" },
        h("div", { class: "brand" }, "Ameli Mor", h("small", {}, mode === "github" ? `Live · ${gh.owner}/${gh.repo}` : "Local site admin")),
        navBtn("films", "Films"),
        navBtn("hero", "Opening Reel"),
        navBtn("ba", "Before & After"),
        navBtn("about", "About & Contact"),
        mode === "local" ? navBtn("messages", "Messages", unread || null) : null,
        navBtn("backups", mode === "github" ? "History" : "Backups"),
        mode === "local" ? navBtn("publish", "Publish to GitHub") : null,
        h("div", { class: "side-foot" },
          h("a", { class: "nav-btn", href: siteUrl(), target: "_blank", rel: "noopener" }, "View site ↗"),
          mode === "local" ? navBtn("account", "Account") : null,
          h("button", { class: "nav-btn", onclick: signOut }, "Sign out"))),
      h("main", { class: "main" },
        h("div", { class: "topbar" },
          h("h2", {}, titles[tab]),
          canSave ? h("div", { class: "top-actions" },
            h("span", { id: "dirty", class: "dirty" + (dirty ? " on" : "") }, dirty ? "Unsaved changes" : "All changes saved"),
            h("button", { class: "btn", id: "save", onclick: save }, mode === "github" ? "Save & Publish" : "Save")) : null),
        h("div", { id: "panel" }))));
    renderPanel();
  }

  function renderPanel() {
    const panel = document.getElementById("panel");
    panel.innerHTML = "";
    ({
      films: filmsPanel,
      hero: heroPanel,
      ba: baPanel,
      about: aboutPanel,
      messages: messagesPanel,
      backups: backupsPanel,
      publish: publishPanel,
      account: accountPanel,
    })[tab](panel);
  }

  /* ------------------------------------------------------------------ films */
  function filmsPanel(panel) {
    const title = h("input", { type: "text", placeholder: "New film title…" });
    const add = () => {
      const t = title.value.trim();
      if (!t) return;
      let slug = slugify(t), n = 2;
      while (content.projects.some((p) => p.slug === slug)) slug = `${slugify(t)}-${n++}`;
      content.projects.unshift({
        slug, title: t, format: "Short Film", camera: "", roles: [],
        poster: "", preview: "", notes: "", festivals_won: 0, laurels: [], clips: [],
      });
      open.add(slug);
      markDirty();
      renderPanel();
    };
    title.addEventListener("keydown", (e) => e.key === "Enter" && add());
    panel.append(
      h("div", { class: "add-row" }, title, h("button", { class: "btn", onclick: add }, "Add film")),
      h("p", { class: "hint", style: "margin:-8px 0 20px" }, "Click any film to edit details, upload clips, or add which festivals it won."));

    if (!content.projects.length) panel.append(h("div", { class: "empty" }, "No films yet."));
    content.projects.forEach((p, i) => panel.append(filmCard(p, i)));
  }

  function filmCard(p, i) {
    const isOpen = open.has(p.slug);
    const head = h("div", { class: "card-head", onclick: () => { isOpen ? open.delete(p.slug) : open.add(p.slug); renderPanel(); } },
      p.poster ? h("img", { class: "thumb", src: mediaSrc(p.poster), alt: "" }) : h("div", { class: "vid thumb" }, "no cover"),
      h("div", {}, h("div", { class: "card-title" }, p.title || "Untitled"), h("div", { class: "card-sub" }, [p.format, p.camera].filter(Boolean).join(" · "))),
      h("div", { class: "card-spacer" }),
      festivalPill(p),
      h("span", { class: "card-sub", style: "margin-left:8px" }, isOpen ? "Close" : "Edit"));
    const card = h("div", { class: "card" }, head);
    if (!isOpen) return card;

    const body = h("div", { class: "card-body" });
    const rolesInput = h("input", { type: "text", placeholder: "Cinematography, Colour Grading" });
    rolesInput.value = (p.roles || []).join(", ");
    rolesInput.addEventListener("input", () => {
      p.roles = rolesInput.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);
      markDirty();
    });

    body.append(
      h("div", { class: "section" },
        h("div", { class: "row" },
          textField("Title", p, "title"),
          textField("Format", p, "format", { placeholder: "Short Film, Music Video, Kodak Commercial…" })),
        h("div", { class: "row" },
          textField("Camera / stock", p, "camera", { placeholder: "Arri Alexa Mini" }),
          h("label", { class: "f" }, h("span", {}, "Your role (comma separated)"), rolesInput,
            h("div", { class: "hint" }, 'Use "Cinematographer" and/or "Colorist" to match the Portfolio filters.'))),
        textField("Notes (shown on the film's page)", p, "notes", { multiline: true, rows: 4, placeholder: "A few lines about the project and your grade…" })),

      laurelsSection(p),

      h("div", { class: "section" }, h("h3", {}, "Images & video"),
        mediaField({ label: "Cover image (home reel + portfolio)", kind: "image", getValue: () => p.poster, setValue: (v) => { p.poster = v; renderPanel(); }, slug: () => p.slug, purpose: "cover" }),
        mediaField({ label: "Hover preview video (portfolio page)", kind: "video", getValue: () => p.preview, setValue: (v) => (p.preview = v), slug: () => p.slug, purpose: "preview" })),

      clipsSection(p),

      h("div", { class: "card-tools" },
        h("button", { class: "btn ghost small", disabled: i === 0, onclick: () => move(i, -1) }, "↑ Move up"),
        h("button", { class: "btn ghost small", disabled: i === content.projects.length - 1, onclick: () => move(i, 1) }, "↓ Move down"),
        h("span", { class: "card-spacer" }),
        h("button", { class: "btn danger small", onclick: () => {
          if (confirm(`Delete “${p.title}”? (You can restore it later from History/Backups.)`)) {
            content.projects.splice(i, 1); markDirty(); renderPanel();
          }
        } }, "Delete film")));
    card.append(body);
    return card;
  }

  function laurelsSection(p) {
    p.laurels = p.laurels || [];
    const stats = getFestivalStats(p);

    const wonInput = h("input", { type: "number", min: "0", max: "99", value: String(stats.wins) });
    wonInput.addEventListener("input", () => {
      p.festivals_won = Math.max(0, Math.min(99, parseInt(wonInput.value, 10) || 0));
      markDirty();
    });

    const sec = h("div", { class: "section" },
      h("h3", {}, "Festivals & Awards"),
      h("div", { class: "fest-summary" },
        h("div", {},
          h("div", { style: "font-weight:600; font-size:0.92rem" },
            stats.total === 0 && stats.wins === 0
              ? "No festivals recorded yet"
              : `${stats.wins} ${stats.wins === 1 ? "festival won" : "festivals won"} · ${stats.total} ${stats.total === 1 ? "festival listed" : "festivals listed"}`),
          h("div", { class: "hint", style: "margin-top:2px" }, "Set how many festivals this film won and list each festival below.")),
        h("div", { class: "fest-count-wrap" },
          h("span", { class: "lbl", style: "margin:0" }, "Festivals won"),
          wonInput)));

    p.laurels.forEach((l, k) => {
      const mk = (key, ph, listId) => {
        const inp = h("input", { type: "text", placeholder: ph, list: listId || false });
        inp.value = l[key] || "";
        inp.addEventListener("input", () => { l[key] = inp.value; markDirty(); });
        return inp;
      };
      const wonBox = h("input", { type: "checkbox", checked: Boolean(l.won) });
      wonBox.addEventListener("change", () => {
        l.won = wonBox.checked;
        const checkedCount = p.laurels.filter((x) => x.won).length;
        p.festivals_won = checkedCount;
        markDirty();
        renderPanel();
      });

      sec.append(h("div", { class: "row-fest" },
        mk("festival", "Festival name"),
        mk("distinction", "Winner / Official Selection…", "distinction-list"),
        mk("year", "2026"),
        mk("qualifying", "BIFA / BAFTA (optional)"),
        h("label", { class: "won-check", title: "Tick if the film won an award here" }, wonBox, "Won"),
        h("button", { class: "btn danger small", type: "button", onclick: () => {
          p.laurels.splice(k, 1);
          const checkedCount = p.laurels.filter((x) => x.won).length;
          if ((Number(p.festivals_won) || 0) > checkedCount && checkedCount >= 0) p.festivals_won = checkedCount;
          markDirty();
          renderPanel();
        } }, "Remove")));
    });

    sec.append(h("button", { class: "btn ghost small", type: "button", onclick: () => {
      p.laurels.push({ festival: "", distinction: "Official Selection", year: String(new Date().getFullYear()), qualifying: "", won: false });
      markDirty();
      renderPanel();
    } }, "+ Add festival"));
    return sec;
  }

  function clipsSection(p) {
    p.clips = p.clips || [];
    const sec = h("div", { class: "section" }, h("h3", {}, `Clips on the film's page (${p.clips.length}/${MAX_CLIPS}) — all loop together`));
    p.clips.forEach((_, k) => sec.append(mediaField({
      label: `Clip ${k + 1}`, kind: "video",
      getValue: () => p.clips[k], setValue: (v) => (p.clips[k] = v),
      slug: () => p.slug, purpose: "clip",
      onRemove: () => { p.clips.splice(k, 1); markDirty(); renderPanel(); },
    })));
    sec.append(h("button", { class: "btn ghost small", disabled: p.clips.length >= MAX_CLIPS, onclick: () => { p.clips.push(""); markDirty(); renderPanel(); } }, "+ Add clip"));
    return sec;
  }

  function move(i, d) {
    const a = content.projects;
    [a[i], a[i + d]] = [a[i + d], a[i]];
    markDirty(); renderPanel();
  }

  /* ----------------------------------------------------------- opening reel */
  function heroPanel(panel) {
    content.hero_slides = content.hero_slides || [];
    const slides = content.hero_slides;

    const uploadInput = h("input", { type: "file", hidden: true, multiple: true, accept: "image/png,image/jpeg,image/webp" });
    uploadInput.addEventListener("change", async () => {
      const files = Array.from(uploadInput.files || []);
      if (!files.length) return;
      const uploader = mode === "local" ? localUpload : ghUploadFile;
      for (const file of files) {
        if (slides.length >= 30) { toast("Maximum 30 opening reel images", true); break; }
        try {
          const path = await uploader(file, "image", "hero", "reel", () => {});
          slides.push({ image: path, label: "" });
          markDirty();
        } catch (e) {
          toast(e.message, true);
        }
      }
      toast("Added to Opening Reel — press Save");
      renderPanel();
    });

    const addFromAll = () => {
      const existing = new Set(slides.map((s) => s.image));
      content.projects.forEach((p) => {
        if (p.poster && !existing.has(p.poster) && slides.length < 30) {
          slides.push({ image: p.poster, label: p.title || "" });
          existing.add(p.poster);
        }
      });
      markDirty();
      renderPanel();
    };

    panel.append(
      h("p", { class: "hint", style: "margin-bottom:16px" },
        "Pick which pictures roll inside the opening square on your home page, upload custom images, and drag their order with ↑ ↓. If left empty, it automatically rolls through all your film covers."),
      h("div", { class: "card-tools", style: "margin:0 0 22px" },
        h("button", { class: "btn", type: "button", onclick: () => uploadInput.click() }, "+ Upload picture(s)"),
        h("button", { class: "btn ghost", type: "button", onclick: addFromAll }, "Add all film covers"),
        slides.length ? h("button", { class: "btn danger", type: "button", onclick: () => {
          if (confirm("Clear custom Opening Reel list? (Home page will default back to all film covers.)")) {
            content.hero_slides = [];
            markDirty();
            renderPanel();
          }
        } }, "Reset to auto") : null,
        uploadInput));

    // Quick-pick strip of existing film covers
    const filmsWithCovers = content.projects.filter((p) => p.poster);
    if (filmsWithCovers.length) {
      const activeSet = new Set(slides.map((s) => s.image));
      panel.append(
        h("div", { class: "section", style: "margin-top:0; margin-bottom:24px" },
          h("h3", {}, "Quick-pick from your films (click to add or remove)"),
          h("div", { class: "pick-grid" }, filmsWithCovers.map((p) => {
            const on = activeSet.has(p.poster);
            return h("button", {
              type: "button",
              class: "pick-chip" + (on ? " is-on" : ""),
              onclick: () => {
                const idx = slides.findIndex((s) => s.image === p.poster);
                if (idx >= 0) slides.splice(idx, 1);
                else if (slides.length < 30) slides.push({ image: p.poster, label: p.title || "" });
                markDirty();
                renderPanel();
              },
            },
            h("img", { src: mediaSrc(p.poster), alt: "" }),
            h("span", {}, (on ? "✓ " : "+ ") + p.title));
          }))));
    }

    if (!slides.length) {
      panel.append(h("div", { class: "empty" }, "Currently using automatic mode (all film covers). Click any film above or upload pictures to build your custom rolling list."));
      return;
    }

    panel.append(h("div", { class: "section", style: "margin-top:0" },
      h("h3", {}, `Rolling sequence (${slides.length} ${slides.length === 1 ? "picture" : "pictures"})`)));

    slides.forEach((s, i) => {
      const moveSlide = (d) => {
        [slides[i], slides[i + d]] = [slides[i + d], slides[i]];
        markDirty();
        renderPanel();
      };
      panel.append(h("div", { class: "card" }, h("div", { class: "card-body", style: "border:0; padding-top:16px" },
        mediaField({
          label: `Slide ${String(i + 1).padStart(2, "0")}`,
          kind: "image",
          getValue: () => s.image,
          setValue: (v) => { s.image = v; renderPanel(); },
          slug: () => "hero",
          purpose: "reel",
        }),
        textField("Caption (shown bottom-right, optional)", s, "label", { placeholder: "e.g. Touch Grass" }),
        h("div", { class: "card-tools", style: "margin-top:6px" },
          h("button", { class: "btn ghost small", type: "button", disabled: i === 0, onclick: () => moveSlide(-1) }, "↑ Move up"),
          h("button", { class: "btn ghost small", type: "button", disabled: i === slides.length - 1, onclick: () => moveSlide(1) }, "↓ Move down"),
          h("span", { class: "card-spacer" }),
          h("button", { class: "btn danger small", type: "button", onclick: () => { slides.splice(i, 1); markDirty(); renderPanel(); } }, "Remove")))));
    });
  }

  /* ----------------------------------------------------------- before/after */
  function baHasRole(b, kind) {
    const joined = (b.roles || []).join(" ");
    return kind === "cine" ? /cinematograph|\bdop\b|\bdp\b/i.test(joined) : /colou?r|grad/i.test(joined);
  }

  function baPanel(panel) {
    panel.append(h("p", { class: "hint", style: "margin-bottom:20px" },
      "Pick 1–6 films. Upload the flat Log frame and the final graded frame — same crop and size, so the slider lines up perfectly. Choose which role symbols (camera / DaVinci) appear under each title."));
    content.before_after.forEach((b, i) => {
      const slug = () => slugify(b.title || "grade");
      if (!Array.isArray(b.roles) || !b.roles.length) b.roles = ["Colorist"];
      const hasCine = baHasRole(b, "cine");
      const hasColor = baHasRole(b, "color");

      const updateRoles = (nextCine, nextColor) => {
        const next = [];
        if (nextCine) next.push("Cinematography");
        if (nextColor) next.push("Colorist");
        b.roles = next.length ? next : ["Colorist"];
        markDirty();
        renderPanel();
      };

      const cineBox = h("input", { type: "checkbox", checked: hasCine });
      cineBox.addEventListener("change", () => updateRoles(cineBox.checked, hasColor));
      const colorBox = h("input", { type: "checkbox", checked: hasColor });
      colorBox.addEventListener("change", () => updateRoles(hasCine, colorBox.checked));

      panel.append(h("div", { class: "card" }, h("div", { class: "card-body", style: "border:0; padding-top:16px" },
        h("div", { class: "row" }, textField("Film title", b, "title"), textField("Camera (internal note, optional)", b, "camera")),
        h("div", {},
          h("span", { class: "lbl" }, "Role symbols shown under title"),
          h("div", { class: "role-checks" },
            h("label", { class: "role-chip" + (hasCine ? " is-on" : "") }, cineBox, "Cinematography (Camera symbol)"),
            h("label", { class: "role-chip" + (hasColor ? " is-on" : "") }, colorBox, "Colour Grading (DaVinci symbol)"))),
        mediaField({ label: "Before — Log image", kind: "image", getValue: () => b.before, setValue: (v) => (b.before = v), slug, purpose: "log" }),
        mediaField({ label: "After — graded image", kind: "image", getValue: () => b.after, setValue: (v) => (b.after = v), slug, purpose: "graded" }),
        h("div", { class: "card-tools", style: "margin-top:6px" },
          h("button", { class: "btn danger small", disabled: content.before_after.length <= 1, onclick: () => { content.before_after.splice(i, 1); markDirty(); renderPanel(); } }, "Remove")))));
    });
    panel.append(h("button", { class: "btn ghost", disabled: content.before_after.length >= 6, onclick: () => { content.before_after.push({ title: "", camera: "", roles: ["Colorist"], before: "", after: "" }); markDirty(); renderPanel(); } }, "+ Add before/after"));
  }

  /* ------------------------------------------------------------------ about */
  function aboutPanel(panel) {
    panel.append(
      mediaField({
        label: "About section photo (shown beside your bio)",
        kind: "image",
        getValue: () => content.about_image || "assets/images/lucifer.png",
        setValue: (v) => { content.about_image = v; },
        slug: () => "about",
        purpose: "portrait",
      }),
      textField("About text", content, "about", { multiline: true, rows: 9 }),
      h("div", { class: "row" },
        textField("Contact email (messages from the website are sent here)", content.links, "email", { type: "email" }),
        textField("Instagram link", content.links, "instagram", { placeholder: "https://www.instagram.com/…" })));
  }

  /* --------------------------------------------------------------- messages */
  async function loadMessages() { messages = (await localApi("/api/messages")).messages || []; }
  function messagesPanel(panel) {
    const list = [...messages].reverse();
    if (!list.length) return panel.append(h("div", { class: "empty" }, "No local messages yet. When hosted on GitHub Pages, messages from the contact form go directly to your email inbox."));
    list.forEach((m) => panel.append(h("div", { class: "msg" + (m.read ? "" : " unread") },
      h("div", { class: "msg-top" }, h("div", { class: "msg-from" }, `${m.name} · `, h("a", { href: "mailto:" + m.email }, m.email)), h("div", { class: "msg-date" }, new Date(m.received_at).toLocaleString())),
      h("div", { class: "msg-body" }, m.message),
      h("div", { class: "msg-actions" },
        h("a", { class: "btn small", href: `mailto:${m.email}?subject=${encodeURIComponent("Re: your project enquiry")}` }, "Reply"),
        m.read ? null : h("button", { class: "btn ghost small", onclick: async () => { messages = (await localApi("/api/messages", "POST", { action: "read", received_at: m.received_at })).messages; shell(); } }, "Mark read"),
        h("button", { class: "btn danger small", onclick: async () => { if (confirm("Delete this message?")) { messages = (await localApi("/api/messages", "POST", { action: "delete", received_at: m.received_at })).messages; shell(); } } }, "Delete")))));
  }

  /* ---------------------------------------------------------------- backups */
  async function loadBackups() {
    backups = mode === "local" ? ((await localApi("/api/backups")).backups || []) : await ghLoadHistory();
  }
  function backupsPanel(panel) {
    if (mode === "github") {
      panel.append(h("p", { class: "hint", style: "margin-bottom:20px" }, "Every Save & Publish creates a GitHub commit. You can restore any earlier version below."));
      if (!backups.length) return panel.append(h("div", { class: "empty" }, "No commit history found yet."));
      backups.forEach((b) => {
        panel.append(h("div", { class: "card" }, h("div", { class: "card-head", style: "cursor:default" },
          h("div", {}, h("div", { class: "card-title" }, new Date(b.date).toLocaleString()), h("div", { class: "card-sub" }, `${b.sha.slice(0, 7)} · ${b.message}`)),
          h("div", { class: "card-spacer" }),
          h("button", { class: "btn ghost small", onclick: async () => {
            if (!confirm("Restore this version and publish it live?")) return;
            try { content = await ghRestoreCommit(b.sha); normalizeContent(); dirty = false; await loadBackups(); toast("Restored & published"); shell(); } catch (e) { toast(e.message, true); }
          } }, "Restore"))));
      });
      return;
    }

    panel.append(h("p", { class: "hint", style: "margin-bottom:20px" }, "Every Save keeps a local copy of the previous version. Restoring one is itself undoable."));
    if (!backups.length) return panel.append(h("div", { class: "empty" }, "No backups yet — they appear after your first save."));
    backups.forEach((name) => {
      const m = name.match(/content-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
      const label = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).toLocaleString() : name;
      panel.append(h("div", { class: "card" }, h("div", { class: "card-head", style: "cursor:default" },
        h("div", {}, h("div", { class: "card-title" }, label)),
        h("div", { class: "card-spacer" }),
        h("button", { class: "btn ghost small", onclick: async () => {
          if (!confirm("Restore this version? Your current version is backed up first.")) return;
          try { content = (await localApi("/api/restore", "POST", { name })).content; normalizeContent(); dirty = false; await loadBackups(); toast("Restored"); shell(); } catch (e) { toast(e.message, true); }
        } }, "Restore"))));
    });
  }

  /* ---------------------------------------------------------------- publish */
  async function loadGitStatus() {
    try { gitInfo = await localApi("/api/git-status"); } catch (_) { gitInfo = null; }
  }
  function publishPanel(panel) {
    panel.append(
      h("div", { class: "info-box" },
        h("h3", {}, "Accessing Admin on Your Live Custom URL"),
        h("p", {}, "Once this project is pushed to GitHub and connected to your custom domain (e.g. ", h("code", {}, "https://amelimor.com"), "), simply go to:"),
        h("div", { class: "pre" }, "https://your-custom-domain.com/admin/"),
        h("p", { style: "margin-top:10px" }, "It will automatically ask for your private GitHub Fine-Grained Token (scoped to this repo only). Without your token, no one else can edit anything.")),

      h("div", { class: "info-box" },
        h("h3", {}, "One-Time GitHub Pages + Custom Domain Setup"),
        h("ol", {},
          h("li", {}, "Push this folder to a GitHub repository (private or public). ", h("code", {}, ".gitignore"), " keeps ", h("code", {}, "private/"), " off GitHub."),
          h("li", {}, "In GitHub, open ", h("strong", {}, "Settings → Pages → Build and deployment"), " and set ", h("strong", {}, "Source"), " to ", h("code", {}, "GitHub Actions"), "."),
          h("li", {}, "Enter your custom domain under ", h("strong", {}, "Custom domain"), " and turn on ", h("strong", {}, "Enforce HTTPS"), "."),
          h("li", {}, "GitHub Actions (", h("code", {}, ".github/workflows/deploy.yml"), ") publishes ONLY the ", h("code", {}, "site/"), " folder automatically on every push."))));

    if (gitInfo) {
      const pubBtn = h("button", { class: "btn", disabled: !gitInfo.has_remote || dirty, onclick: async () => {
        pubBtn.disabled = true; pubBtn.textContent = "Publishing…";
        try {
          const r = await localApi("/api/publish", "POST", {});
          toast(r.message || "Published to GitHub ✓");
          await loadGitStatus();
          renderPanel();
        } catch (e) {
          toast(e.message, true);
          pubBtn.disabled = false; pubBtn.textContent = "Push site/ to GitHub";
        }
      } }, "Push site/ to GitHub");

      panel.append(h("div", { class: "info-box" },
        h("h3", {}, "Local Git Status"),
        h("p", {}, gitInfo.has_remote
          ? `Connected remote: ${gitInfo.remote} (branch: ${gitInfo.branch})`
          : "No git remote configured yet in this folder. Once you run git remote add origin <your-repo-url>, you can push straight from here."),
        gitInfo.changes ? h("div", { class: "pre" }, gitInfo.changes) : h("p", { class: "hint" }, "No unpublished changes in site/."),
        dirty ? h("p", { class: "hint", style: "color:#ffd479" }, "Click Save first before pushing to GitHub.") : null,
        h("div", { style: "margin-top:14px" }, pubBtn)));
    }
  }

  /* ---------------------------------------------------------------- account */
  function accountPanel(panel) {
    const cur = h("input", { type: "password", autocomplete: "current-password" });
    const nw = h("input", { type: "password", autocomplete: "new-password" });
    panel.append(h("div", { style: "max-width:420px" },
      h("label", { class: "f" }, h("span", {}, "Current password"), cur),
      h("label", { class: "f" }, h("span", {}, "New password (10+ characters)"), nw),
      h("button", { class: "btn", onclick: async () => {
        try { await localApi("/api/password", "POST", { current: cur.value, new: nw.value }); cur.value = nw.value = ""; toast("Password changed"); } catch (e) { toast(e.message, true); }
      } }, "Change password")));
  }

  /* ---------------------------------------------------------------- actions */
  function normalizeContent() {
    content.about_image = content.about_image || "";
    content.links = content.links || { email: "", instagram: "" };
    content.hero_slides = (content.hero_slides || []).filter((s) => s && s.image);
    content.projects = (content.projects || []).map((p) => ({
      festivals_won: 0,
      laurels: [],
      clips: [],
      roles: [],
      ...p,
    }));
    content.before_after = (content.before_after || []).map((b) => ({
      roles: ["Colorist"],
      ...b,
    }));
  }

  async function switchTab(id) {
    tab = id;
    try {
      if (id === "messages" && mode === "local") await loadMessages();
      if (id === "backups") await loadBackups();
      if (id === "publish" && mode === "local") await loadGitStatus();
    } catch (e) { toast(e.message, true); }
    shell();
  }

  async function save() {
    const btn = document.getElementById("save");
    btn.disabled = true; btn.textContent = mode === "github" ? "Publishing…" : "Saving…";
    try {
      validateLocal(content);
      if (mode === "local") {
        const r = await localApi("/api/content", "POST", content);
        content = r.content;
        normalizeContent();
        dirty = false;
        toast("Saved ✓ Preview updated");
      } else {
        await ghSaveContent(content);
        dirty = false;
        toast("Published to GitHub ✓ Live site updates in ~30–60s");
      }
      shell();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false; btn.textContent = mode === "github" ? "Save & Publish" : "Save";
    }
  }

  async function signOut() {
    if (dirty && !confirm("You have unsaved changes. Sign out anyway?")) return;
    dirty = false;
    if (mode === "local") {
      try { await localApi("/api/logout", "POST", {}); } catch (_) {}
      csrf = null; content = null;
      await boot();
    } else {
      saveStoredGh(null, false);
      gh = null; content = null;
      githubAuthScreen();
    }
  }

  async function load() {
    content = await localApi("/api/content");
    normalizeContent();
    try { await loadMessages(); } catch (_) {}
    shell();
  }

  async function boot() {
    try {
      const r = await fetch("/api/state", { credentials: "same-origin" });
      if (r.ok) {
        const s = await r.json();
        if (typeof s.setup_needed === "boolean") {
          mode = "local";
          csrf = s.csrf;
          if (s.setup_needed) return localAuthScreen(true);
          if (!s.authed) return localAuthScreen(false);
          return await load();
        }
      }
    } catch (_) {}

    // Live static / GitHub Pages mode (custom URL + /admin/)
    mode = "github";
    const stored = loadStoredGh();
    if (stored && stored.owner && stored.repo && stored.token) {
      gh = stored;
      try {
        content = await ghLoadContent();
        normalizeContent();
        return shell();
      } catch (e) {
        saveStoredGh(null, false);
        gh = null;
        return githubAuthScreen("Saved GitHub session expired or failed: " + e.message);
      }
    }
    githubAuthScreen();
  }

  boot();
})();
