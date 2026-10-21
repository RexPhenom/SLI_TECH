// Hadiboo admin. Login is verified by Supabase Auth; every read/write is enforced by Row Level Security
// in the database (supabase/schema.sql) — hiding or editing this page's code cannot grant access.
(function () {
  "use strict";
  // Clickjacking defence: never run inside someone else's frame
  if (window.top !== window.self) { document.body.textContent = ""; return; }
  const cfg = window.HADIBOO_SB || {};
  const app = document.getElementById("app");
  const DAY = 864e5, IDLE_MS = 30 * 60 * 1000;
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? "" : v);
    }
    kids.flat().forEach((c) => c != null && n.append(c.nodeType ? c : document.createTextNode(String(c))));
    return n;
  };
  const mount = (...kids) => { app.replaceChildren(...kids); };
  const fmt = (d) => d ? new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "";
  const say = (box, text, kind) => { box.className = "msg " + (kind || ""); box.textContent = text; };

  if (!cfg.url || !cfg.anonKey || !window.supabase) {
    mount(el("div", { class: "login" }, el("div", { class: "login-card" },
      el("h1", { text: "Admin not connected yet" }),
      el("p", { class: "sub", text: "Add your Supabase URL and anon key to js/supabase-config.js, run supabase/schema.sql, then reload. See docs/ADMIN.md." }))));
    return;
  }
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" } });

  /* ---------- helpers ---------- */
  let idleTimer;
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => signOut("Signed out after 30 minutes of inactivity."), IDLE_MS); };
  ["click", "keydown", "pointerdown"].forEach((ev) => document.addEventListener(ev, () => { if (session) armIdle(); }, { passive: true }));
  let session = null;

  async function signOut(note) {
    clearTimeout(idleTimer); session = null;
    await sb.auth.signOut();
    showLogin(note);
  }

  /* ---------- login ---------- */
  let fails = 0, lockedUntil = 0;
  function showLogin(note) {
    const msg = el("div", { class: "msg", role: "alert" });
    if (note) say(msg, note, "ok");
    const email = el("input", { class: "field", type: "email", id: "em", autocomplete: "username", required: true, maxlength: "254" });
    const pw = el("input", { class: "field", type: "password", id: "pw", autocomplete: "current-password", required: true, maxlength: "200" });
    const toggle = el("button", { type: "button", "aria-label": "Show password", onclick: () => { const s = pw.type === "password"; pw.type = s ? "text" : "password"; toggle.textContent = s ? "Hide" : "Show"; } , text: "Show" });
    const go = el("button", { class: "btn btn--primary", type: "submit", text: "Sign in", style: false });
    const form = el("form", { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      if (Date.now() < lockedUntil) return say(msg, "Too many attempts. Please wait a minute and try again.", "err");
      if (!email.value.trim() || !pw.value) return say(msg, "Enter your email and password.", "err");
      go.disabled = true; say(msg, "Signing in…");
      const { error } = await sb.auth.signInWithPassword({ email: email.value.trim().toLowerCase(), password: pw.value });
      pw.value = "";
      if (error) {
        fails++; if (fails >= 5) { lockedUntil = Date.now() + 60000; fails = 0; }
        go.disabled = false; return say(msg, "Incorrect email or password.", "err");   // same message for every failure
      }
      fails = 0; boot();
    } },
      el("label", { for: "em", text: "Email" }), email,
      el("label", { for: "pw", text: "Password" }), el("div", { class: "pw" }, pw, toggle),
      el("div", { class: "btn-row" }, go), msg,
      el("button", { class: "linklike", type: "button", text: "Forgot password?", onclick: async () => {
        const v = email.value.trim().toLowerCase(); if (!v) return say(msg, "Type your email above first.", "err");
        await sb.auth.resetPasswordForEmail(v, { redirectTo: location.origin + location.pathname });
        say(msg, "If that email belongs to an admin, a reset link is on its way.", "ok");
      } }));
    mount(el("div", { class: "login" }, el("div", { class: "login-card" },
      el("img", { src: "../assets/logo-full.png", alt: "Hadiboo" }),
      el("h1", { text: "Admin sign in" }), el("p", { class: "sub", text: "Authorised administrators only." }), form)));
    email.focus();
  }

  function showSetPassword() {
    const msg = el("div", { class: "msg", role: "alert" });
    const p1 = el("input", { class: "field", type: "password", autocomplete: "new-password", minlength: "12", maxlength: "200", id: "np" });
    const p2 = el("input", { class: "field", type: "password", autocomplete: "new-password", id: "np2", maxlength: "200" });
    const form = el("form", { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      if (p1.value.length < 12) return say(msg, "Use at least 12 characters.", "err");
      if (p1.value !== p2.value) return say(msg, "Passwords don't match.", "err");
      const { error } = await sb.auth.updateUser({ password: p1.value });
      if (error) return say(msg, "Couldn't update password: " + error.message, "err");
      history.replaceState(null, "", location.pathname); boot();
    } }, el("label", { for: "np", text: "New password (12+ characters)" }), p1, el("label", { for: "np2", text: "Repeat new password" }), p2,
      el("div", { class: "btn-row" }, el("button", { class: "btn btn--primary", type: "submit", text: "Save new password" })), msg);
    mount(el("div", { class: "login" }, el("div", { class: "login-card" }, el("h1", { text: "Set a new password" }), form)));
  }

  /* ---------- boot: verify session + admin allowlist ---------- */
  async function boot() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return showLogin();
    const { data: ok, error } = await sb.rpc("hadiboo_is_admin");
    if (error || ok !== true) {
      await sb.auth.signOut();
      return showLogin("That account is not authorised for admin access.");
    }
    session = data.session; armIdle();
    sb.rpc("hadiboo_purge_expired_jobs").then(() => {});
    shell("dashboard");
  }
  sb.auth.onAuthStateChange((ev) => { if (ev === "PASSWORD_RECOVERY") showSetPassword(); if (ev === "SIGNED_OUT" && session) { session = null; showLogin(); } });

  /* ---------- shell ---------- */
  const TABS = [["dashboard", "Dashboard"], ["jobs", "Jobs"], ["enquiries", "Enquiries"], ["gallery", "Gallery"], ["testimonials", "Testimonials"], ["settings", "Site settings"], ["admins", "Admins"]];
  function shell(tab) {
    const content = el("main", { class: "main", id: "content" });
    const nav = el("nav", { "aria-label": "Admin" }, TABS.map(([k, t]) => el("button", { type: "button", "aria-current": String(k === tab), text: t, onclick: () => shell(k) })));
    mount(el("div", { class: "shell" },
      el("aside", { class: "side" }, el("img", { src: "../assets/logo-full.png", alt: "Hadiboo" }), nav,
        el("div", { class: "who" }, session.user.email, el("br"), el("button", { class: "btn btn--outline-light btn--sm", type: "button", text: "Sign out", onclick: () => signOut() }))),
      content));
    ({ dashboard, jobs, enquiries, gallery, testimonials, settings, admins })[tab](content);
  }
  const fail = (box, error) => { box.append(el("p", { class: "msg err", text: "Something went wrong: " + (error && error.message || "unknown error") })); };
  const count = async (table, f) => { let q = sb.from(table).select("*", { count: "exact", head: true }); if (f) q = f(q); const { count: c } = await q; return c ?? 0; };

  /* ---------- dashboard ---------- */
  async function dashboard(box) {
    box.append(el("h1", { text: "Dashboard" }));
    const [j, e, t, a, g] = await Promise.all([
      count("hadiboo_jobs", (q) => q.gt("expires_at", new Date().toISOString()).eq("hidden", false)),
      count("hadiboo_enquiries", (q) => q.eq("status", "new")), count("hadiboo_testimonials", (q) => q.eq("approved", false)), count("hadiboo_admins"), count("hadiboo_gallery")]);
    const s = (n, l) => el("div", { class: "stat" }, el("b", { text: n }), el("span", { text: l }));
    box.append(el("div", { class: "stats" }, s(j, "Live jobs"), s(e, "New enquiries"), s(t, "Testimonials to approve"), s(a, "Admins"), s(g, "Gallery photos")),
      el("div", { class: "panel" }, el("h2", { text: "Quick guide" }), el("p", { text: "Jobs you add here are removed automatically 6 days after they are added. New enquiries from the website and the WhatsApp button land in Enquiries. Contact details and the site-wide announcement banner are under Site settings." })));
  }

  /* ---------- jobs ---------- */
  async function jobs(box) {
    box.append(el("h1", { text: "Jobs" }));
    const msg = el("div", { class: "msg", role: "status" });
    const f = {}; const field = (k, label, attrs = {}, full) => { f[k] = el(attrs.tag === "textarea" ? "textarea" : "input", { class: "field", id: "j" + k, maxlength: attrs.max || "160", ...attrs.a }); return el("div", { class: full ? "full" : "" }, el("label", { for: "j" + k, text: label }), f[k]); };
    const form = el("form", { class: "panel", novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      const url = f.url.value.trim();
      if (!f.title.value.trim()) return say(msg, "Job title is required.", "err");
      if (!/^https:\/\/[^\s]+$/i.test(url)) return say(msg, "The apply link must start with https://", "err");
      const { error } = await sb.from("hadiboo_jobs").insert({ title: f.title.value.trim(), organization: f.org.value.trim() || null, location: f.loc.value.trim() || null, type: f.type.value.trim() || null, summary: f.sum.value.trim() || null, url, closing: f.closing.value.trim() || null, source: f.source.value.trim() || "Hadiboo" });
      if (error) return say(msg, error.message, "err");
      form.reset(); say(msg, "Job added — it will disappear automatically in 6 days.", "ok"); list();
    } }, el("h2", { text: "Add a job" }),
      el("div", { class: "fgrid" }, field("title", "Job title *"), field("org", "Organisation"), field("loc", "Location"), field("type", "Type (Full-time, Internship…)", { max: "40" }),
        field("url", "Apply link (https://) *", { max: "1000", a: { type: "url", placeholder: "https://" } }, true),
        field("sum", "Short summary", { tag: "textarea", max: "600", a: { rows: "3" } }, true), field("closing", "Employer deadline (optional)", { max: "60" }), field("source", "Source (e.g. Jooble, LinkedIn)", { max: "60" })),
      el("div", { class: "btn-row" }, el("button", { class: "btn btn--primary", type: "submit", text: "Add job" })), msg);
    const holder = el("div", { class: "rows" });
    box.append(form, el("div", { class: "panel" }, el("h2", { text: "All jobs" }), el("div", { class: "btn-row" }, el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Delete expired now", onclick: async () => { await sb.rpc("hadiboo_purge_expired_jobs"); list(); } })), holder));
    async function list() {
      holder.replaceChildren();
      const { data, error } = await sb.from("hadiboo_jobs").select("*").order("added_at", { ascending: false }).limit(200);
      if (error) return fail(holder, error);
      if (!data.length) return holder.append(el("p", { text: "No jobs yet." }));
      data.forEach((j) => {
        const expired = new Date(j.expires_at) <= new Date();
        holder.append(el("div", { class: "row-item" }, el("div", {},
          el("h3", { text: j.title }), el("div", { class: "meta" }, [j.organization, j.location, j.type].filter(Boolean).join(" · ")),
          el("div", { class: "meta" }, `Added ${fmt(j.added_at)} · ${expired ? "EXPIRED" : "expires " + fmt(j.expires_at)}${j.hidden ? " · HIDDEN" : ""}`)),
          el("div", { class: "acts" },
            el("button", { class: "btn btn--ghost btn--sm", type: "button", text: j.hidden ? "Show" : "Hide", onclick: async () => { await sb.from("hadiboo_jobs").update({ hidden: !j.hidden }).eq("id", j.id); list(); } }),
            el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Renew 6 days", onclick: async () => { await sb.from("hadiboo_jobs").update({ expires_at: new Date(Date.now() + 6 * DAY).toISOString() }).eq("id", j.id); list(); } }),
            el("button", { class: "btn btn--danger btn--sm", type: "button", text: "Delete", onclick: async () => { if (confirm("Delete this job?")) { await sb.from("hadiboo_jobs").delete().eq("id", j.id); list(); } } }))));
      });
    }
    list();
  }

  /* ---------- enquiries ---------- */
  const csvCell = (v) => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  async function enquiries(box) {
    box.append(el("h1", { text: "Enquiries" }));
    const holder = el("div", { class: "rows" }); let rows = [];
    box.append(el("div", { class: "panel" }, el("div", { class: "btn-row" }, el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Export CSV", onclick: () => {
      const csv = ["Date,Name,Organisation,Topic,Channel,Status,Message"].concat(rows.map((r) => [r.created_at, r.name, r.org, r.topic, r.channel, r.status, r.message].map(csvCell).join(","))).join("\n");
      const a = el("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "hadiboo-enquiries.csv" }); document.body.append(a); a.click(); a.remove();
    } })), holder));
    async function list() {
      holder.replaceChildren();
      const { data, error } = await sb.from("hadiboo_enquiries").select("*").order("created_at", { ascending: false }).limit(300);
      if (error) return fail(holder, error); rows = data;
      if (!data.length) return holder.append(el("p", { text: "No enquiries yet." }));
      data.forEach((r) => {
        const sel = el("select", { class: "field sm", "aria-label": "Status", onchange: async () => { await sb.from("hadiboo_enquiries").update({ status: sel.value }).eq("id", r.id); } },
          ["new", "contacted", "closed"].map((s) => el("option", { value: s, text: s, selected: s === r.status })));
        holder.append(el("div", { class: "row-item" }, el("div", {},
          el("h3", { text: r.name + (r.org ? " — " + r.org : "") }), el("div", { class: "meta" }, `${fmt(r.created_at)} · ${r.channel} · ${r.topic || "General"}`), r.message ? el("p", { text: r.message }) : null),
          el("div", { class: "acts" }, sel, el("button", { class: "btn btn--danger btn--sm", type: "button", text: "Delete", onclick: async () => { if (confirm("Delete this enquiry?")) { await sb.from("hadiboo_enquiries").delete().eq("id", r.id); list(); } } }))));
      });
    }
    list();
  }


  /* ---------- gallery ---------- */
  const BUCKET = "hadiboo-gallery";
  const pubUrl = (p) => cfg.url.replace(/\/$/, "") + "/storage/v1/object/public/" + BUCKET + "/" + encodeURI(p);
  async function prepareImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Please choose a JPG, PNG or WebP image.");
    if (file.size > 20 * 1024 * 1024) throw new Error("That image is too large (max 20 MB).");
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
    // Re-encoding strips EXIF (e.g. GPS location) and shrinks the file
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
    if (!blob) throw new Error("Couldn't process that image.");
    if (blob.size > 5 * 1024 * 1024) throw new Error("Image is still over 5 MB after compression. Try a smaller photo.");
    return blob;
  }
  async function gallery(box) {
    box.append(el("h1", { text: "Gallery" }));
    const msg = el("div", { class: "msg", role: "status" });
    const file = el("input", { class: "field", type: "file", id: "gf", accept: "image/jpeg,image/png,image/webp" });
    const title = el("input", { class: "field", id: "gt", maxlength: "120" }), cap = el("textarea", { class: "field", id: "gc", maxlength: "500", rows: "2" });
    const cat = el("input", { class: "field", id: "gk", maxlength: "40", list: "gcats", placeholder: "e.g. Training" });
    const dl = el("datalist", { id: "gcats" }, ["Training", "Speaking", "Career Clinic", "Community", "Events"].map((c) => el("option", { value: c })));
    const prev = el("img", { class: "gprevimg", alt: "", hidden: true });
    file.addEventListener("change", () => { const f = file.files[0]; if (!f) { prev.hidden = true; return; } prev.src = URL.createObjectURL(f); prev.hidden = false; if (!title.value) title.value = f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").slice(0, 120); });
    const btn = el("button", { class: "btn btn--primary", type: "submit", text: "Upload & publish" });
    const form = el("form", { class: "panel", novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      const f = file.files[0]; if (!f) return say(msg, "Choose a photo first.", "err"); if (!title.value.trim()) return say(msg, "Give the photo a title.", "err");
      btn.disabled = true; say(msg, "Preparing photo…");
      let path;
      try {
        const blob = await prepareImage(f);
        path = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)) + ".jpg";
        say(msg, "Uploading…");
        const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
        if (up.error) throw up.error;
        const ins = await sb.from("hadiboo_gallery").insert({ title: title.value.trim(), caption: cap.value.trim() || null, category: cat.value.trim() || null, image_path: path });
        if (ins.error) { await sb.storage.from(BUCKET).remove([path]); throw ins.error; }
        form.reset(); prev.hidden = true; say(msg, "Published — it's now live on the Gallery page.", "ok"); list();
      } catch (er) { say(msg, er.message || "Upload failed.", "err"); }
      btn.disabled = false;
    } }, el("h2", { text: "Add a photo" }), el("p", { text: "JPG, PNG or WebP. Photos are resized automatically and hidden location data is removed." }),
      el("label", { for: "gf", text: "Photo *" }), file, prev,
      el("label", { for: "gt", text: "Title *" }), title, el("label", { for: "gc", text: "Caption (optional)" }), cap,
      el("label", { for: "gk", text: "Category (optional)" }), cat, dl,
      el("div", { class: "btn-row" }, btn), msg);
    const holder = el("div", { class: "rows" });
    box.append(form, el("div", { class: "panel" }, el("h2", { text: "All photos" }), holder));
    async function list() {
      holder.replaceChildren();
      const { data, error } = await sb.from("hadiboo_gallery").select("*").order("created_at", { ascending: false }).limit(300);
      if (error) return fail(holder, error);
      if (!data.length) return holder.append(el("p", { text: "No photos yet." }));
      data.forEach((g) => {
        const view = () => {
          const row = el("div", { class: "row-item gal" }, el("img", { class: "thumb", src: pubUrl(g.image_path), alt: g.title, loading: "lazy" }),
            el("div", {}, el("h3", { text: g.title }), el("div", { class: "meta", text: [g.category, fmt(g.created_at), g.published ? "Visible" : "HIDDEN"].filter(Boolean).join(" · ") }), g.caption ? el("p", { text: g.caption }) : null),
            el("div", { class: "acts" },
              el("button", { class: "btn btn--ghost btn--sm", type: "button", text: g.published ? "Hide" : "Show", onclick: async () => { await sb.from("hadiboo_gallery").update({ published: !g.published }).eq("id", g.id); list(); } }),
              el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Edit", onclick: () => row.replaceWith(edit()) }),
              el("button", { class: "btn btn--danger btn--sm", type: "button", text: "Delete", onclick: async () => {
                if (!confirm("Delete this photo permanently?")) return;
                await sb.storage.from(BUCKET).remove([g.image_path]); await sb.from("hadiboo_gallery").delete().eq("id", g.id); list(); } })));
          return row;
        };
        const edit = () => {
          const t = el("input", { class: "field", value: g.title, maxlength: "120", "aria-label": "Title" }), c = el("textarea", { class: "field", maxlength: "500", rows: "2", "aria-label": "Caption" }), k = el("input", { class: "field", value: g.category || "", maxlength: "40", "aria-label": "Category", list: "gcats" });
          c.value = g.caption || "";
          const row = el("div", { class: "row-item gal" }, el("img", { class: "thumb", src: pubUrl(g.image_path), alt: g.title }),
            el("div", {}, t, c, k), el("div", { class: "acts" },
              el("button", { class: "btn btn--primary btn--sm", type: "button", text: "Save", onclick: async () => {
                if (!t.value.trim()) return; const { error: er } = await sb.from("hadiboo_gallery").update({ title: t.value.trim(), caption: c.value.trim() || null, category: k.value.trim() || null }).eq("id", g.id);
                if (er) alert(er.message); list(); } }),
              el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Cancel", onclick: () => row.replaceWith(view()) })));
          return row;
        };
        holder.append(view());
      });
    }
    list();
  }

  /* ---------- testimonials ---------- */
  async function testimonials(box) {
    box.append(el("h1", { text: "Testimonials" }));
    const msg = el("div", { class: "msg", role: "status" });
    const n = el("input", { class: "field", id: "tn", maxlength: "120" }), r = el("input", { class: "field", id: "tr", maxlength: "160" }), q = el("textarea", { class: "field", id: "tq", maxlength: "800", rows: "3" });
    const ap = el("input", { type: "checkbox", id: "ta", checked: true });
    const form = el("form", { class: "panel", novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); if (!n.value.trim() || q.value.trim().length < 5) return say(msg, "Name and a quote are required.", "err");
      const { error } = await sb.from("hadiboo_testimonials").insert({ name: n.value.trim(), role: r.value.trim() || null, quote: q.value.trim(), approved: ap.checked });
      if (error) return say(msg, error.message, "err"); form.reset(); ap.checked = true; say(msg, "Saved.", "ok"); list();
    } }, el("h2", { text: "Add a testimonial" }), el("p", { text: "Only add real testimonials, with the person's permission." }),
      el("label", { for: "tn", text: "Name *" }), n, el("label", { for: "tr", text: "Role / organisation" }), r, el("label", { for: "tq", text: "Quote *" }), q,
      el("label", { class: "chk", for: "ta" }, ap, "Show on website"), el("div", { class: "btn-row" }, el("button", { class: "btn btn--primary", type: "submit", text: "Save" })), msg);
    const holder = el("div", { class: "rows" }); box.append(form, el("div", { class: "panel" }, el("h2", { text: "All testimonials" }), holder));
    async function list() {
      holder.replaceChildren(); const { data, error } = await sb.from("hadiboo_testimonials").select("*").order("created_at", { ascending: false });
      if (error) return fail(holder, error); if (!data.length) return holder.append(el("p", { text: "None yet." }));
      data.forEach((t) => holder.append(el("div", { class: "row-item" }, el("div", {}, el("h3", { text: t.name + (t.role ? " · " + t.role : "") }), el("p", { text: "“" + t.quote + "”" }), el("div", { class: "meta", text: t.approved ? "Visible on site" : "Hidden" })),
        el("div", { class: "acts" }, el("button", { class: "btn btn--ghost btn--sm", type: "button", text: t.approved ? "Hide" : "Approve", onclick: async () => { await sb.from("hadiboo_testimonials").update({ approved: !t.approved }).eq("id", t.id); list(); } }),
          el("button", { class: "btn btn--danger btn--sm", type: "button", text: "Delete", onclick: async () => { if (confirm("Delete?")) { await sb.from("hadiboo_testimonials").delete().eq("id", t.id); list(); } } })))));
    }
    list();
  }

  /* ---------- site settings ---------- */
  async function settings(box) {
    box.append(el("h1", { text: "Site settings" }));
    const { data, error } = await sb.from("hadiboo_settings").select("*"); if (error) return fail(box, error);
    const get = (k) => (data.find((x) => x.key === k) || {}).value || {};
    const c = get("contact"), a = get("announcement"), msg = el("div", { class: "msg", role: "status" });
    const inp = (id, v, a2 = {}) => el("input", { class: "field", id, value: v || "", maxlength: "300", ...a2 });
    const phone = inp("sp", c.phone, { maxlength: "30" }), wa = inp("sw", c.whatsapp, { inputmode: "numeric", maxlength: "15", placeholder: "2349028391111" }), em = inp("se", c.email, { type: "email" }), li = inp("sl", c.linkedin, { type: "url" });
    const on = el("input", { type: "checkbox", id: "sa", checked: !!a.enabled }), tx = inp("st", a.text, { maxlength: "300" });
    box.append(el("form", { class: "panel", novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      if (!/^\d{8,15}$/.test(wa.value.trim())) return say(msg, "WhatsApp number must be digits only with country code, e.g. 2349028391111.", "err");
      if (em.value.trim() && !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(em.value.trim())) return say(msg, "That email doesn't look right.", "err");
      if (li.value.trim() && !/^https:\/\//.test(li.value.trim())) return say(msg, "LinkedIn link must start with https://", "err");
      const rows = [{ key: "contact", value: { phone: phone.value.trim(), whatsapp: wa.value.trim(), email: em.value.trim(), linkedin: li.value.trim() } }, { key: "announcement", value: { enabled: on.checked, text: tx.value.trim() } }];
      const { error: er } = await sb.from("hadiboo_settings").upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })));
      say(msg, er ? er.message : "Saved. Changes show on the website straight away.", er ? "err" : "ok");
    } }, el("h2", { text: "Contact details" }),
      el("label", { for: "sp", text: "Phone (shown on site)" }), phone, el("label", { for: "sw", text: "WhatsApp number (digits only, with country code)" }), wa,
      el("label", { for: "se", text: "Business email (optional)" }), em, el("label", { for: "sl", text: "LinkedIn link" }), li,
      el("h2", { text: "Announcement banner" }), el("label", { class: "chk", for: "sa" }, on, "Show banner at the top of every page"), el("label", { for: "st", text: "Banner text" }), tx,
      el("div", { class: "btn-row" }, el("button", { class: "btn btn--primary", type: "submit", text: "Save settings" })), msg));
  }

  /* ---------- admins ---------- */
  async function admins(box) {
    box.append(el("h1", { text: "Admins" }));
    const msg = el("div", { class: "msg", role: "status" }), em = el("input", { class: "field", type: "email", id: "ae", maxlength: "254" });
    const holder = el("div", { class: "rows" });
    box.append(el("form", { class: "panel", novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); const v = em.value.trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return say(msg, "Enter a valid email.", "err");
      const { error } = await sb.from("hadiboo_admins").insert({ email: v }); if (error) return say(msg, error.message, "err");
      em.value = ""; say(msg, "Added. Now create their login in Supabase → Authentication → Users → Add user (tick Auto Confirm).", "ok"); list();
    } }, el("h2", { text: "Add an admin" }), el("p", { text: "Adding an email here only allows it. The person also needs a login created in Supabase Authentication." }),
      el("label", { for: "ae", text: "Email" }), em, el("div", { class: "btn-row" }, el("button", { class: "btn btn--primary", type: "submit", text: "Allow this email" })), msg),
      el("div", { class: "panel" }, el("h2", { text: "Current admins" }), holder),
      el("div", { class: "panel" }, el("h2", { text: "Your account" }), el("div", { class: "btn-row" }, el("button", { class: "btn btn--ghost", type: "button", text: "Email me a password-reset link", onclick: async () => { await sb.auth.resetPasswordForEmail(session.user.email, { redirectTo: location.origin + location.pathname }); alert("Reset link sent to " + session.user.email); } }),
        el("button", { class: "btn btn--ghost", type: "button", text: "Sign out on all devices", onclick: async () => { await sb.auth.signOut({ scope: "global" }); session = null; showLogin("Signed out everywhere."); } }))));
    async function list() {
      holder.replaceChildren(); const { data, error } = await sb.from("hadiboo_admins").select("*").order("added_at"); if (error) return fail(holder, error);
      data.forEach((x) => holder.append(el("div", { class: "row-item" }, el("div", {}, el("h3", { text: x.email }), el("div", { class: "meta", text: "Added " + fmt(x.added_at) })),
        el("div", { class: "acts" }, el("button", { class: "btn btn--danger btn--sm", type: "button", text: "Remove", onclick: async () => { if (!confirm("Remove " + x.email + "?")) return; const { error: er } = await sb.from("hadiboo_admins").delete().eq("email", x.email); if (er) alert(er.message); list(); } })))));
    }
    list();
  }

  boot();
})();
