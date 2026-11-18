/* A.R.T Control Centre — Home, Fans, QR drops, Team.
   The database decides who can see and change what; this app only reflects it.
   All data goes through the database functions in ControlCentre/supabase/migrations. */
(function () {
  "use strict";
  const cfg = window.ART_CENTRE || {};
  const DEV = cfg.key === "dev"; // local test mode: demo data, pick-a-user login
  const $ = (s, r = document) => r.querySelector(s);
  const screen = (id) => ["setup", "login", "denied", "app"].forEach((v) => $("#" + v).classList.toggle("hide", v !== id));

  // ---------- tiny DOM helper (text is always set as text, never as HTML)
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
    kids.flat(Infinity).forEach((c) => { if (c != null && c !== false) el.append(c.nodeType ? c : String(c)); });
    return el;
  }
  const nf = (n) => Number(n || 0).toLocaleString("en-NZ");
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "");
  const sourceLabel = (s) => !s ? "" : s === "website" ? "Website" : s.startsWith("drop:") ? "QR · " + s.slice(5) : s.startsWith("notify:") ? "“Tell me when it's out” · " + s.slice(7) : s.startsWith("import") ? "Imported" : s;

  let toastTimer;
  function toast(msg, isErr) {
    const t = $("#toast"); t.textContent = msg; t.className = "toast on" + (isErr ? " toast--err" : "");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = "toast"), isErr ? 6000 : 3000);
  }
  // Messages we wrote ourselves (validation / permission) are safe to show as-is.
  const friendly = (e) => (e && (e.code === "22023" || e.code === "42501") && e.message) || "Something went wrong. Please try again.";

  // ---------- light / dark
  // "auto" follows the device; "light" and "dark" are the person's own choice, kept on
  // this device only. index.html applies the saved choice before the page first draws.
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const themeChoice = () => { try { const t = localStorage.getItem("art_theme"); return t === "dark" || t === "light" ? t : "auto"; } catch (_) { return "auto"; } };
  const isDark = () => { const t = themeChoice(); return t === "dark" || (t === "auto" && darkQuery.matches); };
  function applyTheme() {
    const t = themeChoice();
    if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
    document.querySelectorAll("[data-theme-choice]").forEach((b) => { const on = b.dataset.themeChoice === t; b.classList.toggle("seg--on", on); b.setAttribute("aria-pressed", String(on)); });
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute("content", isDark() ? "#0e0b10" : "#17121a");
  }
  document.querySelectorAll("[data-theme-choice]").forEach((b) => b.addEventListener("click", () => {
    try { if (b.dataset.themeChoice === "auto") localStorage.removeItem("art_theme"); else localStorage.setItem("art_theme", b.dataset.themeChoice); } catch (_) { /* private browsing: the choice lasts until the page closes */ }
    if (b.dataset.themeChoice === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", b.dataset.themeChoice);
    applyTheme();
  }));
  darkQuery.addEventListener("change", applyTheme);
  applyTheme();

  if (!cfg.url || !cfg.key) { screen("setup"); return; }

  // ---------- session + API
  let token = "", me = null, sb = null;

  async function call(path, opts) {
    const r = await fetch(cfg.url + path, {
      method: "POST", ...opts,
      headers: { apikey: cfg.key, Authorization: "Bearer " + token, ...(opts.headers || {}) },
    });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error((j && (j.message || j.error)) || "Request failed"); e.code = j && j.code; e.status = r.status; throw e; }
    return j;
  }
  const rpc = (name, args) => call("/rest/v1/rpc/" + name, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(args || {}) });
  async function upload(bucket, dropId, file) {
    const safe = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "") || "file";
    const path = dropId + "/" + Date.now() + "-" + safe;
    await call("/storage/v1/object/" + bucket + "/" + path, {
      headers: { "Content-Type": file.type || "application/octet-stream", "x-upsert": "true" }, body: file,
    });
    return path;
  }

  // ---------- login
  async function signedIn(newToken) {
    token = newToken;
    if (!token) { me = null; screen("login"); return; }
    let rows;
    try { rows = await rpc("centre_me"); } catch (_) { rows = null; }
    if (!rows || !rows[0]) { screen("denied"); return; }
    me = rows[0]; me.manager = me.role === "manager";
    $("#whoName").textContent = me.display_name || me.email;
    $("#whoInitials").textContent = (me.display_name || me.email).split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
    $("#newMenu").classList.toggle("hide", !me.manager); // only managers can add things
    $("#whoRole").textContent = me.manager ? "Manager" : "Artist";
    // artists see confirmed shows, not the booking pipeline, so the menu says so
    $('.nav__item[data-tab="bookings"] .nav__label').textContent = me.manager ? "Bookings" : "Shows";
    // contacts (names, emails, phone numbers) are for managers only
    $('.nav__item[data-tab="contacts"]').classList.toggle("hide", !me.manager);
    refreshBadges();
    screen("app");
    if (/access_token|code=/.test(location.hash + location.search)) history.replaceState(null, "", location.pathname);
    route();
  }

  if (DEV) {
    $("#loginReal").classList.add("hide"); $("#loginDev").classList.remove("hide");
    fetch(cfg.url + "/dev/users").then((r) => r.json()).then((users) => {
      users.forEach((u) => $("#devUsers").append(h("button", {
        class: "btn " + (u.role === "manager" ? "btn--grad" : "btn--soft"), type: "button",
        onclick: () => { sessionStorage.setItem("art_dev_user", u.id); signedIn("dev-user:" + u.id); },
      }, "Log in as " + u.label)));
    }).catch(() => { $("#loginNote").textContent = "The test backend isn't running."; $("#loginNote").className = "note note--err"; });
    const saved = sessionStorage.getItem("art_dev_user");
    signedIn(saved ? "dev-user:" + saved : "");
  } else {
    if (!window.supabase) { screen("setup"); return; }
    sb = window.supabase.createClient(cfg.url, cfg.key);
    $("#loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("#loginBtn"), out = $("#loginNote"), email = $("#email").value.trim();
      if (!email) return;
      btn.disabled = true; out.className = "note"; out.textContent = "Sending…";
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      btn.disabled = false;
      // Same message whether or not the email is on the team, so the form can't be used to find out who is.
      if (error && error.status === 429) { out.className = "note note--err"; out.textContent = "Too many tries. Wait a minute and try again."; }
      else { out.className = "note note--ok"; out.textContent = "If that email is on the team, a login link is on its way. Check your inbox."; }
    });
    sb.auth.onAuthStateChange((_e, session) => setTimeout(() => signedIn(session ? session.access_token : ""), 0));
  }
  document.querySelectorAll("[data-logout]").forEach((b) => b.addEventListener("click", async () => {
    if (DEV) { sessionStorage.removeItem("art_dev_user"); signedIn(""); } else await sb.auth.signOut();
  }));

  // ---------- dialog
  const dlg = $("#dialog");
  function openDialog(...kids) { const b = $("#dialogBody"); b.textContent = ""; b.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); dlg.showModal(); }
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  const field = (label, input, hint) => h("div", { class: "field" }, h("label", { for: input.id }, label), input, hint && h("div", { class: "hint" }, hint));
  function confirmBox(title, text, actionLabel, onYes) {
    openDialog(h("h2", null, title), h("p", { class: "muted" }, text),
      h("div", { class: "form__actions", style: "margin-top:20px" },
        h("button", { class: "btn btn--danger", type: "button", onclick: async () => { dlg.close(); await onYes(); } }, actionLabel),
        h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Cancel")));
  }

  // ---------- menu
  // On phones the menu slides in from the left; on wider screens it is always there.
  const shell = $("#app"), menuBtn = $("#menuBtn"), scrim = $("#scrim");
  function closeMenu() { shell.classList.remove("menu-open"); scrim.hidden = true; menuBtn.setAttribute("aria-expanded", "false"); menuBtn.setAttribute("aria-label", "Open menu"); }
  function openMenu() { shell.classList.add("menu-open"); scrim.hidden = false; menuBtn.setAttribute("aria-expanded", "true"); menuBtn.setAttribute("aria-label", "Close menu"); const first = $(".nav__item"); if (first) first.focus(); }
  menuBtn.addEventListener("click", () => (shell.classList.contains("menu-open") ? closeMenu() : openMenu()));
  scrim.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && shell.classList.contains("menu-open")) { closeMenu(); menuBtn.focus(); } });
  // The small menus in the top bar (New, alerts, account): one open at a time,
  // closed by clicking elsewhere, choosing something, or pressing Escape.
  function closePops(except) {
    document.querySelectorAll(".menu").forEach((mn) => {
      if (mn === except) return;
      mn.querySelector(".pop").hidden = true; mn.querySelector("button").setAttribute("aria-expanded", "false");
    });
  }
  document.querySelectorAll(".menu").forEach((mn) => {
    const btn = mn.querySelector("button"), pop = mn.querySelector(".pop");
    btn.addEventListener("click", (e) => { e.stopPropagation(); const open = pop.hidden; closePops(mn); pop.hidden = !open; btn.setAttribute("aria-expanded", String(open)); });
    pop.addEventListener("click", (e) => { if (e.target.closest(".pop__item")) closePops(); });
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) closePops(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePops(); });

  // The count beside Bookings, and the alerts behind the bell: enquiries the manager
  // hasn't opened, and the signed-in person's own overdue or soon-due tasks.
  let badgeRun = 0;
  async function refreshBadges() {
    const badge = $("#badgeBookings"); if (!badge || !me) return;
    const run = ++badgeRun;
    let unseen = 0, tasks = [];
    try { if (me.manager) unseen = (await rpc("bookings_list")).unseen; } catch (_) { /* leave at 0 */ }
    try { tasks = await rpc("release_my_tasks"); } catch (_) { /* leave empty */ }
    if (run !== badgeRun) return; // a newer check has started
    badge.hidden = !unseen; badge.textContent = unseen ? String(unseen) : "";
    if (unseen) badge.setAttribute("aria-label", unseen + (unseen === 1 ? " new enquiry" : " new enquiries")); else badge.removeAttribute("aria-label");

    const soon = new Date(); soon.setDate(soon.getDate() + 3);
    const due = (t) => t.due_date && new Date(t.due_date + "T00:00:00") <= soon;
    const overdue = tasks.filter((t) => t.overdue), coming = tasks.filter((t) => !t.overdue && due(t));
    const row = (href, title, sub) => h("a", { class: "pop__item", href }, h("span", { class: "alert__text" }, h("b", null, title), h("span", null, sub)));
    const rows = [];
    if (unseen) rows.push(row("#bookings", unseen === 1 ? "1 new booking enquiry" : unseen + " new booking enquiries", "Waiting for a reply"));
    overdue.slice(0, 4).forEach((t) => rows.push(row("#release/" + t.release_id, t.title, "Overdue · " + t.release_title)));
    coming.slice(0, 4).forEach((t) => rows.push(row("#release/" + t.release_id, t.title, "Due in the next 3 days · " + t.release_title)));
    const pop = $("#bellPop"); pop.textContent = "";
    pop.append(h("div", { class: "pop__head" }, "Alerts"), ...(rows.length ? rows : [h("div", { class: "pop__empty" }, "Nothing needs you right now.")]));
    const count = (unseen ? 1 : 0) + overdue.length + coming.length;
    $("#bellDot").hidden = !count;
    $("#bellBtn").setAttribute("aria-label", count ? `Alerts: ${count} need attention` : "Alerts: nothing new");
  }

  // ---------- search (top bar)
  const sInput = $("#searchInput"), sBox = $("#searchResults");
  const KIND = { fan: "Fan", booking: "Booking", contact: "Contact", release: "Release", drop: "QR drop", link: "Smart link", mail: "Email" };
  let sTimer, sRun = 0, sActive = -1;
  const sOptions = () => [...sBox.querySelectorAll(".pop__item")];
  function sClose() { sBox.hidden = true; sInput.setAttribute("aria-expanded", "false"); sInput.removeAttribute("aria-activedescendant"); sActive = -1; }
  function sGo(r) {
    sInput.value = ""; sClose(); sInput.blur();
    location.hash = "#" + { fan: "fan", booking: "booking", contact: "contact", release: "release", drop: "drop", link: "link", mail: "mail" }[r.kind] + "/" + r.id;
  }
  function sMark(i) {
    const opts = sOptions(); if (!opts.length) return;
    sActive = (i + opts.length) % opts.length;
    opts.forEach((o, k) => { o.classList.toggle("is-active", k === sActive); o.setAttribute("aria-selected", String(k === sActive)); });
    sInput.setAttribute("aria-activedescendant", opts[sActive].id); opts[sActive].scrollIntoView({ block: "nearest" });
  }
  async function sRunSearch() {
    const q = sInput.value.trim(), run = ++sRun;
    if (q.length < 2) { sClose(); return; }
    let rows; try { rows = await rpc("centre_search", { p_q: q }); } catch (_) { rows = null; }
    if (run !== sRun) return; // the person has typed more since
    sBox.textContent = ""; sActive = -1;
    if (!rows) sBox.append(h("div", { class: "pop__empty" }, "Search isn't available right now."));
    else if (!rows.length) sBox.append(h("div", { class: "pop__empty" }, `Nothing found for “${q}”.`));
    else rows.forEach((r, i) => sBox.append(h("button", { class: "pop__item result", type: "button", role: "option", id: "sr-" + i, "aria-selected": "false", onclick: () => sGo(r) },
      h("span", { class: "result__kind" }, KIND[r.kind] || r.kind), h("span", { class: "result__text" }, h("b", null, r.title), r.sub ? h("span", null, r.sub) : null))));
    sBox.hidden = false; sInput.setAttribute("aria-expanded", "true");
  }
  sInput.addEventListener("input", () => { clearTimeout(sTimer); sTimer = setTimeout(sRunSearch, 200); });
  sInput.addEventListener("focus", () => { if (sInput.value.trim().length >= 2) sRunSearch(); });
  sInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sMark(sActive + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sMark(sActive - 1); }
    else if (e.key === "Enter") { const o = sOptions()[sActive < 0 ? 0 : sActive]; if (o) { e.preventDefault(); o.click(); } }
    else if (e.key === "Escape") { if (sBox.hidden) sInput.blur(); else { e.stopPropagation(); sClose(); } }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#search")) sClose(); });
  // press "/" anywhere (when not already typing) to jump to search
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || dlg.open) return;
    const t = e.target; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    e.preventDefault(); sInput.focus();
  });

  // ---------- routing
  const view = $("#view");
  function route() {
    if (!me) return;
    if (dlg.open) dlg.close();
    const [name, arg] = (location.hash.replace(/^#/, "") || "home").split("/");
    const tab = name === "fan" ? "fans" : name === "contact" ? "contacts" : name === "drop" ? "drops" : name === "mail" ? "email" : name === "link" ? "links" : name === "release" ? "releases" : name === "booking" ? "bookings" : name;
    document.querySelectorAll(".nav__item").forEach((t) => t.dataset.tab === tab ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current"));
    const current = $('.nav__item[aria-current="page"] .nav__label');
    $("#mobileTitle").textContent = current ? current.textContent : "Home";
    closeMenu();
    closePops();
    refreshBadges();
    const pages = { home: homeView, fans: fansView, fan: fanView, drops: dropsView, drop: dropView, email: emailView, mail: mailView, radar: radarView, links: linksView, link: linkView, releases: releasesView, release: releaseView, site: siteView, bookings: bookingsView, booking: bookingView, calendar: calendarView, contacts: contactsView, contact: contactView, press: pressView, stats: statsView, team: teamView };
    routeName = pages[name] ? name : "home"; routeArg = arg || "";
    view.textContent = "";
    view.append(h("div", { class: "page" }, h("p", { class: "muted" }, "Loading…")));
    (pages[name] || homeView)(arg).then(() => {
      if (arg !== "new" || name !== tab) return;
      history.replaceState(null, "", "#" + name);
      const add = view.querySelector(".head__actions button.btn--ink");
      if (add && me.manager) add.click();
    }).catch((e) => { view.textContent = ""; view.append(h("div", { class: "page" }, h("div", { class: "panel" }, h("p", null, friendly(e))))); });
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);
  // ================================================================ PAGE FRAME
  // Every screen is drawn inside the same frame, like a CRM:
  //   a header band (where you are, what this screen is for, its main buttons, key numbers)
  //   then the screen itself, with an optional context column down the right.
  // Screens just call head(...) and show(...) as before; the frame is added around them,
  // so a screen that redraws itself keeps its band, numbers and context column.
  let routeName = "home", routeArg = "";
  const MODULES = {
    home:      { title: "Home" },
    calendar:  { title: "Calendar", sub: "Release days, release tasks and confirmed shows in one place." },
    releases:  { title: "Releases", sub: "Plan each drop with a dated checklist, so nothing is left to the night before." },
    bookings:  { title: "Bookings", sub: "Every enquiry from first message to show day, with fees and notes in one place.", artistTitle: "Shows", artistSub: "The shows that are locked in, with dates, venues and set times." },
    contacts:  { title: "Contacts", sub: "The promoters, press, radio and venue people you deal with, and your history with each." },
    press:     { title: "Press kit", sub: "The public press page, plus riders shared privately with the promoters you choose." },
    fans:      { title: "Fans", sub: "Everyone on the list: how they joined, where they are and what they've listened to." },
    drops:     { title: "QR drops", sub: "Give fans an early listen in exchange for their email, and see which poster or show brought them in." },
    email:     { title: "Email", sub: "Write to the whole list or one audience, and see how each email landed." },
    links:     { title: "Smart links", sub: "One link per release that sends each fan to their own music service, and counts the clicks." },
    stats:     { title: "Stats", sub: "How the list is growing, the public numbers, and where the fans are." },
    radar:     { title: "Reel Radar", sub: "Which reels are breaking out for the artists you watch, and what they have in common." },
    site:      { title: "Website", sub: "The events and news on artmusic.co.nz. Changes go live about a minute after you publish." },
    team:      { title: "Team", sub: "Who can get in, what they can do, and the reminders the centre sends." },
  };
  const PARENT = { fan: "fans", contact: "contacts", drop: "drops", mail: "email", link: "links", release: "releases", booking: "bookings" };
  const moduleOf = (name) => PARENT[name] || (MODULES[name] ? name : "home");
  const moduleInfo = (key) => { const m = MODULES[key] || MODULES.home; return me && !me.manager && m.artistTitle ? { title: m.artistTitle, sub: m.artistSub } : m; };
  const groupOf = (key) => { const item = $('.nav__item[data-tab="' + key + '"]'); let el = item && item.previousElementSibling; while (el && !el.classList.contains("side__group")) el = el.previousElementSibling; return el ? el.textContent : ""; };

  // The header band. On a module's own screen it shows the module's name and purpose;
  // on a record inside it (one fan, one booking) it shows the record's name and a way back.
  function head(title, ...actions) {
    const key = moduleOf(routeName), info = moduleInfo(key), inside = !!PARENT[routeName], group = groupOf(key);
    const crumb = h("nav", { class: "ph__crumb", "aria-label": "You are here" },
      group && h("span", null, group), group && h("span", { class: "ph__sep", "aria-hidden": "true" }, "/"),
      inside ? [h("a", { href: "#" + key }, info.title), h("span", { class: "ph__sep", "aria-hidden": "true" }, "/"), h("span", { "aria-current": "page" }, title)]
             : h("span", { "aria-current": "page" }, info.title));
    return h("header", { class: "ph" }, h("div", { class: "ph__in" },
      key === "home" && !inside ? null : crumb,
      h("div", { class: "ph__row" },
        inside ? h("span", { class: "thumb thumb--lg", "aria-hidden": "true" }, (String(title || "?").trim()[0] || "?").toUpperCase()) : null,
        h("div", { class: "ph__text" }, h("h1", null, title), !inside && (key === "home" || info.sub) ? h("p", { class: "ph__sub" }, key === "home"
          ? new Date().toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" }) + " · " + (me.manager ? "You're a manager, so you can change everything." : "You're on the team: you can see everything and tick off your tasks.")
          : info.sub) : null),
        h("div", { class: "head__actions ph__actions" }, ...actions))));
  }

  // One key number in the band.  { label, value, sub, tone: "good"|"bad", href, progress: 0..1, spark: [numbers] }
  function kpi(k) {
    const body = [h("div", { class: "kpi__label" }, k.label), h("div", { class: "kpi__value" + (String(k.value).length > 11 ? " kpi__value--long" : ""), title: String(k.value).length > 11 ? String(k.value) : null }, k.value),
      k.progress != null ? h("div", { class: "kpi__bar", "aria-hidden": "true" }, h("span", { style: `width:${Math.round(Math.max(0, Math.min(1, k.progress)) * 100)}%` })) : null,
      k.sub ? h("div", { class: "kpi__sub" + (k.tone ? " kpi__sub--" + k.tone : "") }, k.sub) : null];
    return k.href ? h("a", { class: "kpi kpi--link", href: k.href }, body) : h("div", { class: "kpi" }, body);
  }
  const kpiStrip = (list) => h("div", { class: "kpis", role: "group", "aria-label": "Key numbers" }, list.filter(Boolean).map(kpi));
  const railCard = (title, ...kids) => h("section", { class: "panel rail__card" }, h("h2", null, title), ...kids);
  const steps = (list) => h("ol", { class: "steps" }, list.map(([t, d]) => h("li", null, h("b", null, t), d ? h("span", null, d) : null)));
  const miniBars = (rows, href) => { const top = Math.max(1, ...rows.map((r) => r.value)); return h("div", { class: "minibars" }, rows.map((r) => h(href ? "a" : "div", { class: "minibar", href: href || null },
    h("span", { class: "minibar__label" }, r.label), h("span", { class: "minibar__track", "aria-hidden": "true" }, h("span", { style: `width:${Math.max(4, Math.round((r.value / top) * 100))}%` })), h("b", null, r.text || nf(r.value))))); };
  const tips = (list) => h("ul", { class: "tips" }, list.map((t) => h("li", null, t)));

  // Read-only lookups are often asked for twice in a moment (once by the screen, once by
  // its frame). Remember each answer briefly so the second ask costs nothing.
  const recent = new Map();
  function peek(name, args) {
    const k = name + JSON.stringify(args || {}), hit = recent.get(k);
    if (hit && Date.now() - hit.at < 2500) return hit.p;
    const p = rpc(name, args); recent.set(k, { at: Date.now(), p }); p.catch(() => recent.delete(k));
    return p;
  }
  const sum = (rows, f) => rows.reduce((s, r) => s + (Number(f(r)) || 0), 0);
  const plural = (n, one, many) => `${nf(n)} ${n === 1 ? one : many || one + "s"}`;

  // What each module's frame adds: key numbers for the band, and cards for the context column.
  const FRAME = {
    async home() {
      const [rel, ov] = await Promise.all([peek("releases_list"), peek("stats_overview", { p_days: 30 })]);
      const next = rel.filter((r) => r.days_away != null && r.days_away >= 0).sort((a, b) => a.days_away - b.days_away)[0];
      const grown = ov.tiles.new_fans[0], series = ov.fans_by_day.map((p) => p.n);
      const lead = h("div", { class: "hero" },
        next ? h("a", { class: "hero__card hero__card--release", href: "#release/" + next.id },
            h("div", { class: "hero__eyebrow" }, "Next release"),
            h("div", { class: "hero__title" }, next.title),
            h("div", { class: "hero__meta" }, fmtDay(next.release_date) + " · " + countdown(next.days_away)),
            h("div", { class: "hero__bar", "aria-hidden": "true" }, h("span", { style: `width:${next.tasks ? Math.round((next.done / next.tasks) * 100) : 0}%` })),
            h("div", { class: "hero__foot" }, `${next.done} of ${next.tasks} tasks done` + (next.overdue ? ` · ${next.overdue} overdue` : "") + (next.next_task ? ` · next: ${next.next_task.title}` : "")))
          : h("a", { class: "hero__card hero__card--release", href: me.manager ? "#releases/new" : "#releases" },
            h("div", { class: "hero__eyebrow" }, "Next release"), h("div", { class: "hero__title" }, "Nothing planned yet"),
            h("div", { class: "hero__meta" }, me.manager ? "Plan the next drop to get a dated checklist." : "The manager hasn't planned the next drop yet.")),
        h("a", { class: "hero__card", href: "#stats" },
          h("div", { class: "hero__eyebrow" }, "List growth · last 30 days"),
          h("div", { class: "hero__title" }, (grown > 0 ? "+" : "") + nf(grown) + " " + (grown === 1 ? "fan" : "fans")),
          h("div", { class: "hero__meta" }, `${nf(ov.tiles.fans_total)} subscribed now`),
          heroSpark(series)));
      return { lead };
    },
    async releases() {
      const [list, mine] = await Promise.all([peek("releases_list"), peek("release_my_tasks")]);
      const ahead = list.filter((r) => r.days_away == null || r.days_away >= 0), next = ahead.filter((r) => r.days_away != null).sort((a, b) => a.days_away - b.days_away)[0];
      const tasks = sum(list, (r) => r.tasks), done = sum(list, (r) => r.done), overdue = sum(list, (r) => r.overdue);
      return {
        kpis: [
          { label: "Planned", value: nf(ahead.length), sub: list.length - ahead.length ? plural(list.length - ahead.length, "already out", "already out") : "release plans" },
          { label: "Next release", value: next ? (next.days_away === 0 ? "Today" : next.days_away + (next.days_away === 1 ? " day" : " days")) : "–", sub: next ? next.title : "No date set", href: next ? "#release/" + next.id : null },
          { label: "Tasks done", value: tasks ? Math.round((done / tasks) * 100) + "%" : "–", sub: `${nf(done)} of ${nf(tasks)}`, progress: tasks ? done / tasks : 0 },
          { label: "Overdue", value: nf(overdue), sub: overdue ? "need attention" : "nothing late", tone: overdue ? "bad" : "good" },
        ],
        rail: [
          railCard("Your tasks", mine.length ? mine.slice(0, 6).map((t) => h("a", { class: "railrow", href: "#release/" + t.release_id }, h("b", null, t.title),
            h("span", { class: t.overdue ? "railrow__bad" : "" }, (t.overdue ? "Overdue · " : "") + (t.due_date ? fmtDay(t.due_date) : "No date") + " · " + t.release_title))) : h("p", { class: "muted" }, "Nothing assigned to you right now.")),
          railCard("How a release plan works", steps([["Add the release", "Give it a date and it gets a 15-step checklist, dated back from release day."], ["Share out the tasks", "Each task has an owner and a due date."],
            ["Tick them off", "Anyone on the team can tick a task. Overdue ones show up in alerts."], ["Release day", "One button switches the smart link on, releases the QR drop and queues the email."]])),
        ],
      };
    },
    async calendar() {
      const today = new Date(), iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      const to = new Date(today); to.setDate(to.getDate() + 30);
      const items = await peek("calendar_items", { p_from: iso(today), p_to: iso(to) });
      const count = (k) => items.filter((i) => i.kind === k && !i.done).length;
      return { kpis: [
        { label: "Next 30 days", value: nf(items.filter((i) => !i.done).length), sub: "things coming up" },
        { label: "Release days", value: nf(count("release")), sub: "in the next 30 days" },
        { label: "Shows", value: nf(count("show")), sub: "confirmed" },
        { label: "Tasks due", value: nf(count("task")), sub: "still open" },
      ], rail: [railCard("Coming up next", items.filter((i) => !i.done).slice(0, 8).map((i) => h("a", { class: "railrow", href: i.kind === "show" ? (me.manager ? "#booking/" + i.id : "#bookings") : "#release/" + i.id },
        h("b", null, i.title), h("span", null, fmtDay(i.date) + " · " + (i.kind === "release" ? "Release day" : i.kind === "show" ? "Show" : "Task")))), !items.some((i) => !i.done) && h("p", { class: "muted" }, "Nothing in the next 30 days."))] };
    },
    async bookings() {
      if (!me.manager) {
        const shows = await peek("shows_list"), up = shows.filter((s) => s.status === "confirmed" && (s.days_away == null || s.days_away >= 0)), next = up[0];
        return { kpis: [
          { label: "Coming up", value: nf(up.length), sub: "confirmed shows" },
          { label: "Next show", value: next && next.days_away != null ? (next.days_away === 0 ? "Today" : next.days_away + (next.days_away === 1 ? " day" : " days")) : "–", sub: next ? next.event_name : "Nothing confirmed" },
          { label: "Played", value: nf(shows.filter((s) => s.status === "played").length), sub: "so far" },
        ] };
      }
      const rows = (await peek("bookings_list")).rows, of = (s) => rows.filter((b) => b.status === s);
      const fee = (list) => sum(list, (b) => b.fee), won = of("confirmed").length + of("played").length, closed = won + of("declined").length;
      return { kpis: [
        { label: "New enquiries", value: nf(of("enquiry").length), sub: of("enquiry").filter((b) => b.unseen).length ? plural(of("enquiry").filter((b) => b.unseen).length, "not opened yet", "not opened yet") : "all opened", tone: of("enquiry").some((b) => b.unseen) ? "bad" : null },
        { label: "Quoted", value: nf(of("quoted").length), sub: fee(of("quoted")) ? money(fee(of("quoted"))) + " out for reply" : "waiting on a reply" },
        { label: "Confirmed", value: money(fee(of("confirmed"))) || "$0", sub: plural(of("confirmed").length, "show") + " locked in" },
        { label: "Played", value: nf(of("played").length), sub: fee(of("played")) ? money(fee(of("played"))) + " earned" : "shows done" },
        { label: "Win rate", value: closed ? Math.round((won / closed) * 100) + "%" : "–", sub: closed ? `${won} of ${closed} decided` : "no decisions yet", progress: closed ? won / closed : 0 },
      ], rail: bookingsState.view === "board" ? [] : [
        railCard("The pipeline", miniBars(STAGES.map(([k, label]) => ({ label, value: of(k).length })))),
        railCard("Next confirmed shows", of("confirmed").filter((b) => b.days_away == null || b.days_away >= 0).sort((a, b) => (a.days_away ?? 9999) - (b.days_away ?? 9999)).slice(0, 4).map((b) => h("a", { class: "railrow", href: "#booking/" + b.id }, h("b", null, b.event_name),
          h("span", null, [b.event_date ? fmtDay(b.event_date) : "No date", b.city].filter(Boolean).join(" · ")))), !of("confirmed").length && h("p", { class: "muted" }, "Nothing confirmed yet.")),
        railCard("Good to know", tips(["The booking form on the website drops enquiries straight in here.", "Artists only ever see confirmed shows, never fees or contacts.", "Switch to Board to drag bookings between stages."])),
      ] };
    },
    async contacts() {
      if (!me.manager) return {};
      const rows = await peek("contacts_list", { p_search: "", p_kind: null }), n = (k) => rows.filter((c) => c.kind === k).length;
      const kinds = CONTACT_KINDS.map(([k, label]) => ({ label, value: n(k) })).filter((r) => r.value);
      return {
        kpis: [
          { label: "Contacts", value: nf(rows.length), sub: "in the address book" },
          { label: "Promoters", value: nf(n("promoter")), sub: "people who book shows" },
          { label: "Press and radio", value: nf(n("press") + n("radio")), sub: "for release coverage" },
          { label: "Linked to bookings", value: nf(rows.filter((c) => Number(c.bookings) > 0).length), sub: "have worked with you" },
        ],
        rail: [
          kinds.length ? railCard("By kind", miniBars(kinds)) : null,
          railCard("Getting the most from contacts", tips(["Open a booking and save its contact with one click, so the history stays together.", "Add a note after every call or email. It's the first thing you'll want next time.", "Only managers can see contacts. Fans are kept separately."])),
        ],
      };
    },
    async press() {
      const [docs, links] = await Promise.all([peek("press_docs_list"), peek("press_links_list")]);
      const live = links.filter((l) => l.state === "on"), opens = sum(links, (l) => l.opens), last = links.map((l) => l.last_opened_at).filter(Boolean).sort().pop();
      return { kpis: [
        { label: "Private documents", value: nf(docs.length), sub: docs.length ? "riders and files" : "none uploaded yet" },
        { label: "Promoter links", value: nf(live.length), sub: `working now, of ${nf(links.length)} made` },
        { label: "Times opened", value: nf(opens), sub: "across all links" },
        { label: "Last opened", value: last ? ago(last) : "–", sub: last ? fmtDate(last) : "no link opened yet" },
      ], rail: [
        railCard("How promoter links work", steps([["Upload the rider", "Private documents never show on the public page."], ["Make a link per promoter", "Each one opens the press page with the documents unlocked."], ["See who opened it", "Every link counts its opens. Switch one off any time."]])),
        railCard("On the public page", tips(["Bio, headline numbers and awards", "Press photos and logos to download", "Recent coverage, from the Website news list"])),
      ] };
    },
    async fans() {
      const [ov, towns] = await Promise.all([peek("stats_overview", { p_days: 30 }), peek("fans_by_city")]);
      const t = ov.tiles, diff = t.new_fans[0] - t.new_fans[1], by = (k) => sum(ov.new_by_week, (w) => w[k]);
      const top = towns.cities[0], joined = [{ label: "Website", value: by("website") }, { label: "QR drops", value: by("qr") }, { label: "Imported", value: by("import") }].filter((r) => r.value);
      return {
        kpis: [
          { label: "Subscribed", value: nf(t.fans_total), sub: "can be emailed" },
          { label: "New in 30 days", value: nf(t.new_fans[0]), sub: diff === 0 ? "same as the 30 days before" : `${nf(Math.abs(diff))} ${diff > 0 ? "more" : "fewer"} than the 30 days before`, tone: diff > 0 ? "good" : diff < 0 ? "bad" : null },
          { label: "From QR drops", value: nf(t.qr_signups[0]), sub: "signups in 30 days" },
          { label: "Unsubscribed", value: nf(t.unsubscribes[0]), sub: "in 30 days", tone: t.unsubscribes[0] > t.unsubscribes[1] ? "bad" : null },
          { label: "Biggest town", value: top ? top.city : "–", sub: top ? plural(top.fans, "fan") : "no towns given yet", href: "#stats" },
        ],
        rail: [
          towns.cities.length ? railCard("Where they are", miniBars(towns.cities.slice(0, 6).map((c) => ({ label: c.city, value: c.fans }))), h("p", { class: "hint" }, `${nf(towns.unplaced)} fans haven't given a town.`)) : null,
          joined.length ? railCard("How they joined, last 30 days", miniBars(joined)) : null,
          railCard("Good to know", tips(["Click any fan to see everything about them.", "Tags and saved audiences let you email just the right people.", "Only subscribed fans are ever emailed."])),
        ],
      };
    },
    async drops() {
      const list = await peek("drops_list"), signups = sum(list, (d) => d.signups), listeners = sum(list, (d) => d.listeners);
      return {
        kpis: [
          { label: "Live now", value: nf(list.filter((d) => d.status === "live").length), sub: `of ${plural(list.length, "drop")}` },
          { label: "Signups", value: nf(signups), sub: "emails collected" },
          { label: "Listened", value: signups ? Math.round((listeners / signups) * 100) + "%" : "–", sub: `${nf(listeners)} of ${nf(signups)} pressed play`, progress: signups ? listeners / signups : 0 },
          { label: "Plays", value: nf(sum(list, (d) => d.plays)), sub: "early listens" },
          { label: "QR codes", value: nf(sum(list, (d) => d.placements)), sub: "out in the world" },
        ],
        rail: [railCard("How a QR drop works", steps([["Upload the track", "It's stored privately. Fans can only stream it from their own link."], ["Make a QR code per place", "One for each poster or show, so you can see which worked."],
          ["Go live", "A scan collects an email and sends a personal listening link."], ["Mark it released", "Every link then points to the released single."]]))],
      };
    },
    async email() {
      const [list, audience] = await Promise.all([peek("campaigns_list"), peek("segment_count", { p_segment: {} })]);
      const sent = list.filter((c) => c.kind === "broadcast" && c.status === "sent"), delivered = sum(list, (c) => c.sent), opened = sum(list, (c) => c.opened), clicked = sum(list, (c) => c.clicked);
      return {
        kpis: [
          { label: "Audience", value: nf(audience), sub: "subscribed fans" },
          { label: "Emails sent", value: nf(sent.length), sub: list.filter((c) => c.status === "draft").length ? plural(list.filter((c) => c.status === "draft").length, "draft") + " waiting" : "to the list" },
          { label: "Delivered", value: nf(delivered), sub: "messages in inboxes" },
          { label: "Open rate", value: delivered ? Math.round((opened / delivered) * 100) + "%" : "–", sub: "an estimate", progress: delivered ? opened / delivered : 0 },
          { label: "Click rate", value: delivered ? Math.round((clicked / delivered) * 100) + "%" : "–", sub: "tapped a link", progress: delivered ? clicked / delivered : 0 },
        ],
        rail: [railCard("Good to know", tips(["Write {{first_name}} and each fan sees their own name.", "A.R.T's details and an unsubscribe link are added to every email automatically.", "Send yourself a test first. Sent emails can't be changed.", "Only subscribed fans are ever emailed."]))],
      };
    },
    async links() {
      const list = await peek("smart_links_list"), views = sum(list, (l) => l.views), clicks = sum(list, (l) => l.clicks);
      const best = list.filter((l) => l.views > 0).sort((a, b) => b.clicks - a.clicks)[0];
      return {
        kpis: [
          { label: "Switched on", value: nf(list.filter((l) => l.is_live).length), sub: `of ${plural(list.length, "link")}` },
          { label: "Visits", value: nf(views), sub: "people who opened a link" },
          { label: "Clicks through", value: nf(clicks), sub: "went on to a service" },
          { label: "Click rate", value: views ? Math.round((clicks / views) * 100) + "%" : "–", sub: "of visits", progress: views ? clicks / views : 0 },
          { label: "Most clicked", value: best ? best.title : "–", sub: best ? plural(best.clicks, "click") : "no visits yet", href: best ? "#link/" + best.id : null },
        ],
        rail: [railCard("Where to share a link", tips(["Use “Copy for Instagram” and the other tagged copies, so you can see which channel sends people.", "Put the link in every bio on release day.", "Before release day, switch on “tell me when it's out” to collect emails."]))],
      };
    },
    async radar() {
      const [accounts, pat] = await Promise.all([peek("radar_accounts_list"), peek("radar_patterns", { p_account_id: null, p_days: 90 })]);
      const last = accounts.map((a) => a.last_checked_at).filter(Boolean).sort().pop();
      return { kpis: [
        { label: "Artists watched", value: nf(accounts.length), sub: accounts.some((a) => a.last_error) ? "one or more couldn't be fetched" : "on the watchlist", tone: accounts.some((a) => a.last_error) ? "bad" : null },
        { label: "Reels tracked", value: nf(sum(accounts, (a) => a.reels)), sub: "in total" },
        { label: "Breakouts", value: nf(pat.breakouts), sub: `of ${nf(pat.reels)} reels in 90 days`, progress: pat.reels ? pat.breakouts / pat.reels : 0 },
        { label: "Posting pace", value: pat.per_week != null ? String(pat.per_week) : "–", sub: "reels a week per artist" },
        { label: "Last checked", value: last ? ago(last) : "–", sub: last ? fmtDate(last) : "not checked yet" },
      ] };
    },
    async site() {
      return { rail: [
        railCard("How publishing works", steps([["Change events or news", "Edit, add or reorder. Nothing is public yet."], ["Publish", "One button sends every change to the live site."], ["Wait a minute", "The site rebuilds itself. Refresh artmusic.co.nz to see it."]])),
        railCard("Good to know", tips(["Past events drop off the site by themselves.", "News items also feed the “recent coverage” on the press page.", "Only managers can publish. Artists can look."])),
      ] };
    },
    async team() {
      const d = await peek("team_list"), mgr = d.members.filter((m) => m.role === "manager").length;
      return {
        kpis: [
          { label: "People with access", value: nf(d.members.length), sub: "can log in" },
          { label: "Managers", value: nf(mgr), sub: "can change everything" },
          { label: "Artists", value: nf(d.members.length - mgr), sub: "can view and tick tasks" },
          { label: "Invites waiting", value: nf((d.invites || []).length), sub: (d.invites || []).length ? "haven't logged in yet" : "nobody pending" },
        ],
        rail: [railCard("What each role can do", h("div", { class: "roles" },
          h("div", null, h("b", null, "Manager"), h("span", null, "Sees and changes everything: fans, email, bookings, fees, contacts and the team.")),
          h("div", null, h("b", null, "Artist"), h("span", null, "Sees fans, releases, stats and confirmed shows. Can tick off tasks. Never sees fees, contacts or enquiries."))))],
      };
    },
  };

  function heroSpark(values) {
    if (!values || values.length < 2) return null;
    const W = 320, H = 56, lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const x = (i) => (i / (values.length - 1)) * W, y = (v) => H - 4 - ((v - lo) / span) * (H - 10);
    const line = values.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
    return sv("svg", { class: "hero__spark", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" },
      sv("path", { d: `${line} L ${W} ${H} L 0 ${H} Z`, class: "hero__sparkfill" }), sv("path", { d: line, class: "hero__sparkline" }));
  }

  // Lays a screen out inside the frame, then fills in the frame's numbers and context column.
  let frameRun = 0;
  function show(...kids) {
    const all = kids.flat(Infinity).filter((k) => k != null && k !== false), isEl = (k) => k && k.nodeType === 1;
    const band = all.find((k) => isEl(k) && k.classList.contains("ph"));
    view.textContent = "";
    if (!band) { view.append(h("div", { class: "page" }, all)); return; }
    // the old "← All drops" link is replaced by the breadcrumb in the band
    let rest = all.filter((k) => k !== band && !(isEl(k) && k.classList.contains("back")));
    // a row of number tiles straight after the head becomes the band's key numbers
    // a record's status panel (its tag, one line about it, and its buttons) belongs in the band:
    // the tag and line go under the title, the buttons beside it
    if (isEl(rest[0]) && rest[0].classList.contains("panel") && rest[0].firstElementChild && rest[0].firstElementChild.classList.contains("statusbar")) {
      const panel = rest[0], bar = panel.firstElementChild, status = h("div", { class: "ph__status" });
      [...bar.children].forEach((part) => {
        if (part.classList.contains("form__actions")) band.querySelector(".head__actions").prepend(...part.childNodes);
        else if (part.tagName === "P") status.append(part);
        else status.append(...part.childNodes);
      });
      status.querySelectorAll("p").forEach((p) => p.removeAttribute("style"));
      band.querySelector(".ph__text").append(status);
      bar.remove();
      if (!panel.childElementCount) rest.shift();
    }
    // a row of section tabs straight after the head sits along the bottom of the band
    let tabs = null;
    if (isEl(rest[0]) && rest[0].classList.contains("segs")) { tabs = rest.shift(); tabs.classList.add("ph__tabs"); band.firstChild.append(tabs); }
    const addKpis = (el) => (tabs ? tabs.before(el) : band.firstChild.append(el));
    const at = rest.slice(0, 3).findIndex((k) => isEl(k) && (k.classList.contains("kpis") || k.classList.contains("tiles")));
    if (at > -1) { const t = rest.splice(at, 1)[0]; if (t.classList.contains("tiles")) t.classList.add("kpis--tiles"); addKpis(t); }
    const key = moduleOf(routeName), listScreen = !PARENT[routeName];
    const main = h("div", { class: "page__main" }, rest), rail = h("aside", { class: "rail", "aria-label": "More about this screen", hidden: true });
    const page = h("div", { class: "page page--" + key + (listScreen ? " page--list" : " page--record") }, h("div", { class: "cols" }, main, rail));
    view.append(band, page);

    const fill = listScreen && FRAME[key];
    if (key === "stats") return;
    if (!fill) return;
    const run = ++frameRun;
    // hold the band's height steady while the numbers load
    if (!band.querySelector(".kpis, .tiles") && key !== "home") addKpis(h("div", { class: "kpis kpis--loading", "aria-hidden": "true" }, [0, 1, 2, 3].map(() => h("div", { class: "kpi" }, h("div", { class: "kpi__label" }, " "), h("div", { class: "kpi__value" }, " "), h("div", { class: "kpi__sub" }, " ")))));
    fill().then((f) => {
      if (run !== frameRun || !band.isConnected) return;
      const holder = band.querySelector(".kpis--loading");
      if (f.kpis && f.kpis.length) { const strip = kpiStrip(f.kpis); const old = band.querySelector(".kpis"); if (old) old.replaceWith(strip); else addKpis(strip); }
      else if (holder) holder.remove();
      if (f.lead) main.prepend(f.lead);
      const cards = (f.rail || []).filter(Boolean);
      if (cards.length) { rail.append(...cards); rail.hidden = false; page.classList.add("page--rail"); }
    }).catch(() => { const holder = band.querySelector(".kpis--loading"); if (holder) holder.remove(); });
  }
  // A full-width list, the way a CRM shows records: one row each, the whole row opens it.
  const opens = (href) => ({ class: "click", tabindex: "0", onclick: () => (location.hash = href), onkeydown: (e) => { if (e.key === "Enter") location.hash = href; } });
  const listTable = (cols, rows) => h("div", { class: "tablewrap" }, h("table", { class: "list" },
    h("thead", null, h("tr", null, cols.map((c) => Array.isArray(c) ? h("th", { class: "num" }, c[0]) : h("th", null, c)))), h("tbody", null, rows)));
  const numCell = (v) => h("td", { class: "num" }, v);
  const nameCell = (title, sub) => h("td", null, h("div", { class: "cellmain" },
    h("span", { class: "thumb", "aria-hidden": "true" }, (String(title || "?").trim()[0] || "?").toUpperCase()),
    h("div", { class: "cellmain__text" }, h("div", { class: "strong" }, title), sub ? h("div", { class: "muted" }, sub) : null)));
  const meter = (done, total, label) => h("div", { class: "meter" },
    h("div", { class: "progress", role: "img", "aria-label": label }, h("span", { style: `width:${total ? Math.round((done / total) * 100) : 0}%` })), h("span", { class: "muted" }, label));
  const emptyState = (title, text, action) => h("div", { class: "panel estate" }, h("div", { class: "estate__mark", "aria-hidden": "true" }), h("h2", null, title), h("p", null, text), action || null);
  const tile = (num, cap) => h("div", { class: "tile" }, h("div", { class: "tile__num" }, nf(num)), h("div", { class: "tile__cap" }, cap));

  // ================================================================ HOME
  // "3 hours ago", "Yesterday", then a plain date
  function ago(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 2) return "Just now";
    if (mins < 60) return mins + " minutes ago";
    if (mins < 24 * 60) { const hrs = Math.round(mins / 60); return hrs === 1 ? "1 hour ago" : hrs + " hours ago"; }
    if (mins < 48 * 60) return "Yesterday";
    return fmtDate(iso);
  }
  // One line of the activity feed: [what happened, extra detail, where it links to]
  function activityLine(i) {
    const fans = (n) => (n === 1 ? "1 fan" : nf(n) + " fans");
    if (i.kind === "fans") return [i.n === 1 ? "1 new fan" : nf(i.n) + " new fans", "Joined via " + (sourceLabel(i.source) || "an unknown route"), "#fans"];
    if (i.kind === "unsubscribed") return [fans(i.n) + " unsubscribed", "They won't get any more emails", "#fans"];
    if (i.kind === "email") return ["Email sent: “" + (i.subject || "(no subject)") + "”", "To " + fans(i.n), "#mail/" + i.id];
    if (i.kind === "task") return [(i.who || "Someone") + " ticked off “" + i.title + "”", i.release, "#release/" + i.release_id];
    if (i.kind === "enquiry") return ["New booking enquiry: " + i.event, [i.from, i.city].filter(Boolean).join(" · "), "#booking/" + i.id];
    if (i.kind === "confirmed") return ["Show confirmed: " + i.event, i.city || "", "#booking/" + i.id];
    return null;
  }

  async function homeView() {
    const [d, mine, shows, bk, feed, hidden] = await Promise.all([rpc("centre_home"), rpc("release_my_tasks"), rpc("shows_list"), me.manager ? rpc("bookings_list") : { unseen: 0 }, rpc("centre_activity", { p_days: 14 }).catch(() => []), rpc("home_prefs_get").catch(() => [])]);
    // Each person picks which panels their own Home shows. Keep in step with private.home_panels().
    const PANELS = [["numbers", "Headline numbers", "Fans on the list, new this week, QR signups and plays"], ["shows", "Next shows", "The next confirmed shows"],
      ["tasks", "Your tasks", "Release tasks assigned to you"], ["activity", "What's been happening", "New fans, sent emails and ticked-off tasks"],
      ["fans", "Newest fans", "The latest people to join the list"], ["website", "Website", "Shortcuts to the site and its editor"]];
    const on = (key) => !hidden.includes(key);
    const choosePanels = () => {
      const boxes = PANELS.map(([key, label, what]) => { const box = h("input", { type: "checkbox", id: "hp-" + key, checked: on(key) });
        return [key, box, h("label", { class: "check", for: box.id, style: "margin-bottom:12px" }, box, h("span", null, h("b", null, label), h("br"), h("span", { class: "muted" }, what)))]; });
      const save = async () => {
        try { await rpc("home_prefs_save", { p_hidden: boxes.filter(([, box]) => !box.checked).map(([key]) => key) }); dlg.close(); toast("Home updated"); homeView(); }
        catch (e) { toast(friendly(e), true); }
      };
      openDialog(h("h2", null, "Choose your Home panels"),
        h("p", { class: "muted", style: "margin:-8px 0 16px" }, "This only changes your own Home. Everyone else keeps theirs."),
        boxes.map((b) => b[2]),
        h("div", { class: "form__actions", style: "margin-top:8px" }, h("button", { class: "btn btn--grad", type: "button", onclick: save }, "Save"), h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Cancel")));
    };
    const upcoming = shows.filter((s) => s.status === "confirmed" && (s.days_away == null || s.days_away >= 0)).slice(0, 3);
    const tick = async (t, box) => { try { await rpc("release_task_toggle", { p_id: t.id, p_done: true }); toast("Done"); homeView(); } catch (e) { box.checked = false; toast(friendly(e), true); } };
    const panel = (key, title, link, ...kids) => on(key) && h("section", { class: "panel" }, h("div", { class: "panel__head" }, h("h2", null, title), link), ...kids);
    const more = (href, text) => h("a", { class: "panel__more", href }, text);
    const shortcut = (href, title, what) => h("a", { class: "shortcut", href }, h("b", null, title), h("span", null, what));
    show(
      head("Kia ora" + (me.display_name ? ", " + me.display_name : ""), h("button", { class: "btn btn--soft btn--sm", type: "button", onclick: choosePanels }, "Choose panels")),
      on("numbers") && kpiStrip([
        { label: "Fans on the list", value: nf(d.fans), sub: "subscribed", href: "#fans" },
        { label: "New this week", value: nf(d.fans_week), sub: d.fans_week ? "joined in the last 7 days" : "nobody new yet", tone: d.fans_week ? "good" : null, href: "#fans" },
        { label: "QR signups", value: nf(d.qr_signups), sub: plural(d.drops_live, "drop") + " live", href: "#drops" },
        { label: "Early listens", value: nf(d.plays), sub: "plays of unreleased tracks", href: "#drops" },
        me.manager ? { label: "Enquiries to open", value: nf(bk.unseen), sub: bk.unseen ? "waiting for a reply" : "all caught up", tone: bk.unseen ? "bad" : "good", href: "#bookings" }
                   : { label: "Your open tasks", value: nf(mine.length), sub: mine.some((t) => t.overdue) ? "some are overdue" : "on track", tone: mine.some((t) => t.overdue) ? "bad" : null, href: "#releases" },
      ]),
      PANELS.every(([key]) => !on(key)) && h("div", { class: "panel empty" }, "You've hidden every panel. Use “Choose panels” to bring some back."),
      h("div", { class: "dash" },
        h("div", { class: "dash__col" },
          panel("tasks", "Your tasks", more("#releases", "All releases"), mine.length ? mine.map((t) => {
            const box = h("input", { type: "checkbox", id: "mine-" + t.id });
            box.addEventListener("change", () => tick(t, box));
            return h("div", { class: "task" }, box, h("label", { for: box.id, class: "task__title" }, t.title),
              h("div", { class: "task__meta" }, t.overdue && h("span", { class: "tag tag--unsubscribed" }, "overdue"),
                h("span", null, t.due_date ? new Date(t.due_date + "T00:00:00").toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" }) : "No date"),
                h("a", { href: "#release/" + t.release_id }, t.release_title)));
          }) : h("p", { class: "muted" }, "Nothing assigned to you right now. Tasks from release plans show up here.")),
          panel("activity", "What's been happening", null,
            feed.length ? feed.slice(0, 12).map((i) => { const l = activityLine(i); return l && h("a", { class: "row row--link", href: l[2] },
              h("div", { class: "row__main" }, h("div", { class: "strong" }, l[0]), l[1] ? h("div", { class: "muted" }, l[1]) : null),
              h("div", { class: "row__side muted" }, ago(i.at))); })
              : h("p", { class: "muted" }, "Nothing in the last two weeks. New fans, sent emails and ticked-off tasks will show up here."),
            feed.length ? h("p", { class: "hint", style: "margin-top:10px" }, "The last two weeks." + (me.manager ? "" : " Bookings are handled by the manager, so they aren't listed here.")) : null)),
        h("div", { class: "dash__col" },
          panel("shows", "Next shows", more("#calendar", "Calendar"), upcoming.length ? upcoming.map(showRow) : h("p", { class: "muted" }, "No confirmed shows coming up.")),
          panel("fans", "Newest fans", more("#fans", "All fans"),
            d.latest.length ? d.latest.map((f) => h("div", { class: "row" },
              h("div", { class: "row__main" }, h("div", { class: "strong" }, f.first_name || f.email), h("div", { class: "muted" }, [f.first_name ? f.email : "", f.city].filter(Boolean).join(" · "))),
              h("div", { class: "row__side muted" }, sourceLabel(f.consent_source) + " · " + fmtDate(f.created_at))))
              : h("p", { class: "muted" }, "No fans yet. They'll appear here as people sign up.")),
          panel("website", "Shortcuts", null, h("div", { class: "shortcuts" },
            me.manager && shortcut("#email", "Write an email", "To the whole list or one audience"),
            me.manager && shortcut("#releases/new", "Plan a release", "Get a dated checklist"),
            me.manager && shortcut("#drops/new", "New QR drop", "Early listen for an email"),
            shortcut("#site", me.manager ? "Edit the website" : "Website", "Events and news"),
            shortcut("#stats", "See the stats", "Growth and the fan map"),
            h("a", { class: "shortcut", href: "../../", target: "_blank", rel: "noopener" }, h("b", null, "View the site"), h("span", null, "artmusic.co.nz")))))));
  }

  // ================================================================ FANS
  const fanState = { search: "", status: "", tag: "", page: 0 };
  const chip = (t, onRemove) => h("span", { class: "chip" }, t, onRemove && h("button", { class: "chip__x", type: "button", "aria-label": "Remove the tag " + t, onclick: onRemove }, "×"));
  const PAGE = 50;
  async function fansView() {
    const search = h("input", { id: "fanSearch", type: "search", placeholder: "Search email, name or town", value: fanState.search, "aria-label": "Search fans" });
    const status = h("select", { id: "fanStatus", "aria-label": "Filter by status" },
      [["", "Everyone"], ["subscribed", "Subscribed"], ["unsubscribed", "Unsubscribed"], ["bounced", "Bounced"]].map(([v, t]) => h("option", { value: v }, t)));
    status.value = fanState.status;
    const tags = await rpc("tags_list");
    if (fanState.tag && !tags.some((t) => t.tag === fanState.tag)) fanState.tag = "";
    const tagSel = h("select", { id: "fanTag", "aria-label": "Filter by tag" }, h("option", { value: "" }, "Any tag"), tags.map((t) => h("option", { value: t.tag }, `${t.tag} (${nf(t.fans)})`)));
    tagSel.value = fanState.tag;
    tagSel.addEventListener("change", () => { fanState.tag = tagSel.value; fanState.page = 0; load(); });
    const list = h("div");
    let timer;
    search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { fanState.search = search.value; fanState.page = 0; load(); }, 250); });
    status.addEventListener("change", () => { fanState.status = status.value; fanState.page = 0; load(); });

    async function load() {
      const d = await rpc("fans_list", { p_search: fanState.search, p_status: fanState.status, p_tag: fanState.tag || null, p_limit: PAGE, p_offset: fanState.page * PAGE });
      list.textContent = "";
      if (!d.rows.length) { list.append(h("div", { class: "tablewrap" }, h("div", { class: "empty" }, fanState.search || fanState.status || fanState.tag ? "Nobody matches that search." : "No fans yet."))); return; }
      list.append(
        h("div", { class: "tablewrap" }, h("table", null,
          h("thead", null, h("tr", null, ["Email", "Name", "Town", "Tags", "Joined via", "Joined", "Status"].map((t) => h("th", null, t)))),
          h("tbody", null, d.rows.map((f) => h("tr", { class: "click", onclick: (e) => { if (!e.target.closest("a")) location.hash = "#fan/" + f.id; } },
            h("td", { class: "strong" }, h("a", { class: "plainlink", href: "#fan/" + f.id }, f.email)), h("td", null, f.first_name || ""), h("td", null, f.city || ""),
            h("td", null, h("div", { class: "chips" }, (f.tags || []).map((t) => chip(t)))),
            h("td", null, sourceLabel(f.consent_source)), h("td", null, fmtDate(f.created_at)),
            h("td", null, h("span", { class: "tag tag--" + f.status }, f.status))))))),
        h("div", { class: "pager" },
          h("span", { class: "muted" }, `${nf(fanState.page * PAGE + 1)}–${nf(fanState.page * PAGE + d.rows.length)} of ${nf(d.total)}`),
          h("div", { class: "form__actions" },
            h("button", { class: "btn btn--soft btn--sm", disabled: fanState.page === 0, onclick: () => { fanState.page--; load(); } }, "Previous"),
            h("button", { class: "btn btn--soft btn--sm", disabled: (fanState.page + 1) * PAGE >= d.total, onclick: () => { fanState.page++; load(); } }, "Next"))));
    }

    show(
      head("Fans", me.manager && [
        h("button", { class: "btn btn--ink btn--sm", onclick: () => addFans(load) }, "Add or import"),
        h("button", { class: "btn btn--soft btn--sm", onclick: exportFans }, "Export"),
      ]),
      h("div", { class: "toolbar toolbar--fans" }, search, status, tagSel), list);
    await load();
  }

  // One fan: how they joined, what they agreed to, and everything they've done since.
  const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const mailStatus = (m) => m.clicked_at ? ["Clicked", "tag--live"] : m.opened_at ? ["Opened", "tag--released"] : m.status === "bounced" ? ["Bounced", "tag--bounced"] : m.status === "complained" ? ["Marked as spam", "tag--complained"]
    : m.status === "failed" ? ["Not sent", "tag--bounced"] : m.status === "queued" ? ["Waiting to send", ""] : ["Sent", ""];
  async function fanView(id) {
    const [data, allTags] = await Promise.all([rpc("fan_get", { p_id: id }), rpc("tags_list")]);
    if (!data) { show(h("a", { class: "back", href: "#fans" }, "← All fans"), h("div", { class: "panel" }, "That fan is no longer on the list.")); return; }
    const f = data.fan, ro = !me.manager, reload = () => fanView(id);
    const newTag = h("input", { id: "fTag", type: "text", maxlength: "40", placeholder: "e.g. street team", "aria-label": "New tag", list: "fTagList", autocomplete: "off" });
    const addTag = async () => { try { await rpc("fan_tag_add", { p_fan_id: id, p_tag: newTag.value }); toast("Tag added"); reload(); } catch (e) { toast(friendly(e), true); } };
    const dropTag = async (t) => { try { await rpc("fan_tag_remove", { p_fan_id: id, p_tag: t }); toast("Tag removed"); reload(); } catch (e) { toast(friendly(e), true); } };
    newTag.addEventListener("keydown", (e) => { if (e.key === "Enter") addTag(); });
    const name = h("input", { id: "fName", type: "text", value: f.first_name || "", maxlength: "80", disabled: ro });
    const city = h("input", { id: "fCity", type: "text", value: f.city || "", maxlength: "80", disabled: ro });
    const notes = h("textarea", { id: "fNotes", maxlength: "2000", disabled: ro, placeholder: ro ? "" : "Anything worth remembering about this fan." }); notes.value = f.notes || "";
    const st = h("select", { id: "fStatus", disabled: ro }, ["subscribed", "unsubscribed", "bounced", "complained"].map((s) => h("option", { value: s }, s[0].toUpperCase() + s.slice(1))));
    st.value = f.status === "pending" ? "subscribed" : f.status;
    const save = async () => {
      try { await rpc("fan_update", { p_id: id, p_first_name: name.value, p_city: city.value, p_notes: notes.value, p_status: st.value }); toast("Saved"); reload(); }
      catch (e) { toast(friendly(e), true); }
    };
    const plays = data.listens.reduce((s, l) => s + l.play_count, 0), sent = data.emails.filter((m) => m.sent_at), opened = sent.filter((m) => m.opened_at);
    const line = (main, sub, side) => h("div", { class: "row" }, h("div", { class: "row__main" }, h("div", { class: "strong" }, main), sub ? h("div", { class: "muted" }, sub) : null), side ? h("div", { class: "row__side" }, side) : null);

    show(h("a", { class: "back", href: "#fans" }, "← All fans"), head(f.first_name || f.email),
      h("section", { class: "panel" }, h("div", { class: "statusbar" },
        h("div", null, h("span", { class: "tag tag--" + f.status }, f.status),
          h("p", { class: "muted", style: "margin-top:8px;overflow-wrap:anywhere" }, [f.first_name ? f.email : "", [f.city, f.country].filter(Boolean).join(", "), "Joined " + fmtDate(f.created_at) + " via " + (sourceLabel(f.consent_source) || "unknown")].filter(Boolean).join(" · "))),
        f.status === "subscribed" ? null : h("p", { class: "muted" }, f.status === "unsubscribed" ? "They unsubscribed" + (f.unsubscribed_at ? " on " + fmtDate(f.unsubscribed_at) : "") + ", so they get no emails." : "This address gets no emails."))),
      h("div", { class: "tiles" }, tile(data.drops.length, "QR drops scanned"), tile(plays, "Early listens played"), tile(sent.length, "Emails received"), tile(opened.length, "Emails opened")),
      h("div", { class: "compose" },
        h("div", null,
          h("section", { class: "panel" }, h("h2", null, "Details"),
            h("div", { class: "grid2" }, field("First name", name), field("Town or city", city)),
            field("Status", st, "Only subscribed fans receive emails."), field("Notes", notes, ro ? null : "Only the team sees these."),
            !ro && h("div", { class: "form__actions" }, h("button", { class: "btn btn--grad", type: "button", onclick: save }, "Save changes"),
              h("button", { class: "btn btn--danger btn--sm", type: "button", style: "margin-left:auto",
                onclick: () => confirmBox("Delete this fan?", `${f.email} and their history will be removed for good. Use this for privacy requests; to just stop emails, set them to Unsubscribed.`, "Delete for good",
                  async () => { try { await rpc("fan_delete", { p_id: id }); toast("Deleted"); location.hash = "#fans"; } catch (e) { toast(friendly(e), true); } }) }, "Delete"))),
          h("section", { class: "panel" }, h("h2", null, "Consent record"),
            line("When they agreed", f.consent_at ? fmtWhen(f.consent_at) : "Not recorded"),
            line("Where", sourceLabel(f.consent_source) || "Not recorded"),
            line("What they agreed to", f.consent_text ? "“" + f.consent_text + "”" : "Not recorded"),
            line("Email confirmed", f.confirmed_at ? "Yes, they opened a link we emailed on " + fmtDate(f.confirmed_at) : "Not yet. This happens the first time they open an early-listen link."),
            h("p", { class: "hint", style: "margin-top:10px" }, "Kept as proof that this person asked to hear from A.R.T."))),
        h("div", null,
          h("section", { class: "panel" }, h("h2", null, "Tags"),
            data.tags.length ? h("div", { class: "chips" }, data.tags.map((t) => chip(t, ro ? null : () => dropTag(t)))) : h("p", { class: "muted" }, "No tags yet."),
            !ro && [h("div", { class: "addrow" }, newTag, h("button", { class: "btn btn--ink", type: "button", onclick: addTag }, "Add tag")),
              h("datalist", { id: "fTagList" }, allTags.filter((t) => !data.tags.includes(t.tag)).map((t) => h("option", { value: t.tag }))),
              h("p", { class: "hint" }, "Tags group fans however you like. You can email everyone with a tag from the Email screen.")]),
          h("section", { class: "panel" }, h("h2", null, "QR drops scanned"),
            data.drops.length ? data.drops.map((d) => line(h("a", { href: "#drop/" + d.drop_id }, d.title), [d.placement, d.city].filter(Boolean).join(" · "), h("span", { class: "muted" }, fmtDate(d.created_at))))
              : h("p", { class: "muted" }, "None yet.")),
          data.waiting_for && data.waiting_for.length ? h("section", { class: "panel" }, h("h2", null, "Asked to be told about"),
            data.waiting_for.map((x) => line(h("a", { href: "#link/" + x.link_id }, x.title), x.is_live ? "It's out, and they've been told" : "Waiting for release", h("span", { class: "muted" }, fmtDate(x.created_at))))) : null,
          h("section", { class: "panel" }, h("h2", null, "Early listens"),
            data.listens.length ? data.listens.map((l) => line(l.title, l.play_count ? `Played ${l.play_count} of ${l.max_plays} · last on ${fmtDate(l.last_played_at)}` : "Link sent, not played yet"))
              : h("p", { class: "muted" }, "No early-listen links yet.")),
          h("section", { class: "panel" }, h("h2", null, "Emails"),
            data.emails.length ? data.emails.map((m) => { const [label, cls] = mailStatus(m);
              return line(m.subject || "(no subject)", (kindLabel[m.kind] || "Email") + " · " + fmtDate(m.sent_at || m.created_at), h("span", { class: "tag " + cls }, label)); })
              : h("p", { class: "muted" }, "No emails sent to this fan yet.")))));
  }

  // Accepts pasted emails or a CSV with a header row containing "email".
  function parsePeople(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const split = (l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    const first = split(lines[0]).map((c) => c.toLowerCase());
    const hasHeader = first.some((c) => c.includes("email"));
    const col = (names) => first.findIndex((c) => names.some((n) => c.includes(n)));
    const iE = hasHeader ? col(["email"]) : -1, iN = hasHeader ? col(["first", "name"]) : -1, iC = hasHeader ? col(["city", "town"]) : -1;
    return (hasHeader ? lines.slice(1) : lines).map((l) => {
      const c = split(l);
      if (hasHeader) return { email: c[iE] || "", first_name: iN >= 0 ? c[iN] : "", city: iC >= 0 ? c[iC] : "" };
      const e = c.findIndex((x) => x.includes("@"));
      return { email: e >= 0 ? c[e] : c[0], first_name: "", city: "" };
    });
  }
  function addFans(reload) {
    const box = h("textarea", { id: "impText", placeholder: "mele@example.com\nsione@example.com" });
    const file = h("input", { id: "impFile", type: "file", accept: ".csv,text/csv,text/plain" });
    file.addEventListener("change", async () => { if (file.files[0]) box.value = await file.files[0].text(); });
    const agree = h("input", { id: "impAgree", type: "checkbox" });
    const out = h("div", { class: "note", role: "status" });
    const go = async (e) => {
      const people = parsePeople(box.value);
      if (!people.length) { out.className = "note note--err"; out.textContent = "Paste at least one email, or choose a file."; return; }
      if (!agree.checked) { out.className = "note note--err"; out.textContent = "Tick the box to confirm they agreed."; return; }
      e.target.disabled = true; out.className = "note"; out.textContent = "Adding…";
      try {
        const r = await rpc("fans_import", { p_rows: people, p_source: "import", p_consent_text: "Team confirmed these people agreed to receive A.R.T emails (added by " + me.email + ")" });
        dlg.close(); toast(`${nf(r.added)} added · ${nf(r.already_listed)} already on the list · ${nf(r.invalid)} not valid`); reload();
      } catch (err) { e.target.disabled = false; out.className = "note note--err"; out.textContent = friendly(err); }
    };
    openDialog(h("h2", null, "Add or import fans"),
      field("Emails, one per line", box, "Or a spreadsheet saved as CSV with columns like email, first name, city."),
      field("Or choose a CSV file", file),
      h("label", { class: "check", for: "impAgree" }, agree, h("span", null, "These people agreed to get emails from A.R.T. (Anyone who has unsubscribed stays unsubscribed.)")),
      out,
      h("div", { class: "form__actions" },
        h("button", { class: "btn btn--grad", type: "button", onclick: go }, "Add to the list"),
        h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Cancel")));
  }
  async function exportFans() {
    try {
      const d = await rpc("fans_list", { p_search: fanState.search, p_status: fanState.status, p_tag: fanState.tag || null, p_limit: 5000, p_offset: 0 });
      const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
      const csv = ["email,first_name,city,status,joined_via,joined,tags"].concat(d.rows.map((f) =>
        [f.email, f.first_name, f.city, f.status, f.consent_source, (f.created_at || "").slice(0, 10), (f.tags || []).join("; ")].map(q).join(","))).join("\r\n");
      download(new Blob(["﻿" + csv], { type: "text/csv" }), "art-fans-" + new Date().toISOString().slice(0, 10) + ".csv");
      toast(`Exported ${nf(d.rows.length)} fans`);
    } catch (e) { toast(friendly(e), true); }
  }
  function download(blob, name) {
    const a = h("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ================================================================ DROPS
  async function dropsView() {
    const drops = await rpc("drops_list");
    const create = () => {
      const title = h("input", { id: "newTitle", type: "text", maxlength: "120", placeholder: "Song title" });
      const out = h("div", { class: "note note--err", role: "status" });
      const go = async () => {
        try { const id = await rpc("drop_save", { p_id: null, p_title: title.value }); dlg.close(); location.hash = "#drop/" + id; }
        catch (e) { out.textContent = friendly(e); }
      };
      title.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      openDialog(h("h2", null, "New QR drop"), field("Which song is it for?", title, "You'll add the track, artwork and QR codes next. Nothing is public until you go live."), out,
        h("div", { class: "form__actions" }, h("button", { class: "btn btn--grad", type: "button", onclick: go }, "Create"),
          h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Cancel")));
      title.focus();
    };
    show(head("QR drops", me.manager && h("button", { class: "btn btn--ink btn--sm", onclick: create }, "New drop")),
      drops.length ? listTable(["Drop", "Status", ["Signups"], ["Listened"], ["Listen rate"], ["Plays"], ["QR codes"]], drops.map((d) => h("tr", opens("#drop/" + d.id),
        nameCell(d.title, d.release_at ? "Release " + fmtDate(d.release_at) : "No release date yet"),
        h("td", null, h("span", { class: "tag tag--" + d.status }, d.status)),
        numCell(nf(d.signups)), numCell(nf(d.listeners)), numCell(pct(d.listeners, d.signups)), numCell(nf(d.plays)), numCell(nf(d.placements)))))
        : emptyState("No drops yet", "A drop gives fans an early listen of an unreleased single in exchange for their email.",
            me.manager && h("button", { class: "btn btn--grad", type: "button", onclick: create }, "Make the first drop")));
  }

  const toLocal = (iso) => { if (!iso) return ""; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const dropUrl = (code) => new URL("../../drop/?c=" + code, location.href).href;

  function drawQr(canvas, text, px) {
    const qr = window.qrcode(0, "M"); qr.addData(text); qr.make();
    const n = qr.getModuleCount(), quiet = 4, cell = Math.floor(px / (n + quiet * 2)), size = cell * (n + quiet * 2);
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size, size); ctx.fillStyle = "#000";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
  }

  async function dropView(id) {
    const data = await rpc("drop_get", { p_id: id });
    if (!data) { show(h("a", { class: "back", href: "#drops" }, "← All drops"), h("div", { class: "panel" }, "That drop no longer exists.")); return; }
    const d = data.drop, ro = !me.manager;
    const reload = () => dropView(id);

    const f = {
      title: h("input", { id: "dTitle", type: "text", value: d.title, maxlength: "120", disabled: ro }),
      release: h("input", { id: "dRelease", type: "datetime-local", value: toLocal(d.release_at), disabled: ro }),
      plays: h("input", { id: "dPlays", type: "number", min: "1", max: "100", value: d.max_plays, disabled: ro }),
      subject: h("input", { id: "dSubject", type: "text", value: d.email_subject || "", maxlength: "200", placeholder: "Your early listen: " + d.title, disabled: ro }),
      body: h("textarea", { id: "dBody", maxlength: "10000", disabled: ro, placeholder: "Thanks for scanning! Here's your private link to hear it first." }),
      released: h("input", { id: "dReleased", type: "url", value: d.released_url || "", placeholder: "https://…", disabled: ro }),
    };
    f.body.value = d.email_body || "";
    let artwork = d.artwork_path, audio = d.audio_path;

    const save = async (quiet) => {
      await rpc("drop_save", {
        p_id: id, p_title: f.title.value, p_slug: d.slug,
        p_release_at: f.release.value ? new Date(f.release.value).toISOString() : null,
        p_released_url: f.released.value, p_max_plays: Number(f.plays.value) || 5,
        p_email_subject: f.subject.value, p_email_body: f.body.value, p_artwork_path: artwork, p_audio_path: audio,
      });
      if (!quiet) toast("Saved");
    };
    const trySave = async () => { try { await save(); reload(); } catch (e) { toast(friendly(e), true); } };
    const setStatus = async (s, msg) => {
      try { await save(true); await rpc("drop_set_status", { p_id: id, p_status: s }); toast(msg); reload(); } catch (e) { toast(friendly(e), true); }
    };

    // status actions
    const acts = [];
    if (!ro) {
      if (d.status === "draft") acts.push(h("button", { class: "btn btn--grad", onclick: () => setStatus("live", "Live: QR codes now work") }, "Go live"));
      if (d.status === "live") acts.push(
        h("button", { class: "btn btn--ink", onclick: () => setStatus("released", "Marked as released") }, "Mark as released"),
        h("button", { class: "btn btn--soft", onclick: () => setStatus("draft", "Paused: QR codes are switched off") }, "Pause"));
      if (d.status === "released") acts.push(h("button", { class: "btn btn--soft", onclick: () => setStatus("archived", "Archived") }, "Archive"));
      if (d.status === "archived") acts.push(h("button", { class: "btn btn--soft", onclick: () => setStatus("draft", "Back to draft") }, "Back to draft"));
    }
    const statusText = { draft: "Not public yet. QR codes show “not available” until you go live.", live: "Live. Scanning a QR code collects an email and sends the early-listen link.",
      released: "Released. Early-listen links and QR codes now point to the released single.", archived: "Archived. QR codes show “not available”." }[d.status];

    // uploads
    const fileRow = (label, bucket, current, accept, onDone, hint) => {
      const input = h("input", { id: "up-" + bucket, type: "file", accept, disabled: ro });
      const stat = h("div", { class: "hint" }, current ? "Uploaded ✓" : hint);
      const thumb = bucket === "artwork" && current ? h("img", { src: window.ART_API.artwork(current), alt: "" }) : h("div", { class: "ph" });
      input.addEventListener("change", async () => {
        const file = input.files[0]; if (!file) return;
        stat.textContent = "Uploading…";
        try { const path = await upload(bucket, id, file); onDone(path); await save(true); toast(label + " uploaded"); reload(); }
        catch (e) { stat.textContent = e.status === 413 ? "That file is too big." : "Upload failed. Try again."; }
      });
      return h("div", { class: "field" }, h("label", { for: input.id }, label), h("div", { class: "filebox" }, bucket === "artwork" ? thumb : null, h("div", null, input, stat)));
    };

    // QR codes
    const qrRow = (p) => {
      const url = dropUrl(p.code), canvas = h("canvas", { role: "img", "aria-label": "QR code for " + p.label });
      drawQr(canvas, url, 264);
      const png = () => { const big = document.createElement("canvas"); drawQr(big, url, 1200); big.toBlob((b) => download(b, `art-${d.slug}-${p.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`)); };
      return h("div", { class: "qr" }, canvas, h("div", null,
        h("div", { class: "strong" }, p.label), h("div", { class: "muted" }, nf(p.signups) + (p.signups === 1 ? " signup" : " signups")),
        h("div", { class: "qr__link" }, url),
        h("div", { class: "qr__actions" },
          h("button", { class: "btn btn--ink btn--sm", onclick: png }, "Download for print"),
          h("button", { class: "btn btn--soft btn--sm", onclick: async () => { try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch (_) { toast("Couldn't copy. Select the link above instead.", true); } } }, "Copy link"),
          h("a", { class: "btn btn--soft btn--sm", href: url, target: "_blank", rel: "noopener" }, "Preview"),
          !ro && h("button", { class: "btn btn--danger btn--sm", onclick: () => confirmBox("Delete this QR code?", `“${p.label}” will stop working anywhere it has been printed. Its ${nf(p.signups)} signups stay on the fan list.`, "Delete QR code",
            async () => { try { await rpc("placement_delete", { p_id: p.id }); toast("Deleted"); reload(); } catch (e) { toast(friendly(e), true); } }) }, "Delete"))));
    };
    const newLabel = h("input", { id: "newPlace", type: "text", maxlength: "80", placeholder: "Where will it go? e.g. Wellington poster", "aria-label": "Where the new QR code will go" });
    const addPlace = async () => { try { await rpc("placement_add", { p_drop_id: id, p_label: newLabel.value }); toast("QR code added"); reload(); } catch (e) { toast(friendly(e), true); } };
    newLabel.addEventListener("keydown", (e) => { if (e.key === "Enter") addPlace(); });

    show(
      h("a", { class: "back", href: "#drops" }, "← All drops"),
      head(d.title),
      h("section", { class: "panel" }, h("div", { class: "statusbar" },
        h("div", null, h("span", { class: "tag tag--" + d.status }, d.status), h("p", { class: "muted", style: "margin-top:8px" }, statusText)),
        h("div", { class: "form__actions" }, acts))),
      h("div", { class: "tiles" }, tile(data.signups, "Signups"), tile(data.listeners, "Fans who listened"), tile(data.plays, "Total plays"), tile(data.placements.length, "QR codes")),
      h("section", { class: "panel" }, h("h2", null, "QR codes"),
        h("p", { class: "muted", style: "margin:-6px 0 6px" }, "Make one per place you'll put it, so you can see which poster or show brought people in."),
        data.placements.length ? data.placements.map(qrRow) : h("p", { class: "muted", style: "padding:10px 0" }, "No QR codes yet."),
        !ro && h("div", { class: "addrow" }, newLabel, h("button", { class: "btn btn--ink", onclick: addPlace }, "Add QR code"))),
      h("section", { class: "panel" }, h("h2", null, "The track"),
        fileRow("Unreleased track", "previews", audio, "audio/*", (p) => (audio = p), "MP3 or WAV. Stored privately; fans can only stream it from their personal link."),
        fileRow("Artwork", "artwork", artwork, "image/*", (p) => (artwork = p), "Square image, shown on the signup and listening pages."),
        h("div", { class: "grid2" },
          field("Release date and time", f.release, "Early-listen links stop working at this moment."),
          field("Plays per fan", f.plays, "How many times each fan can play it."))),
      h("section", { class: "panel" }, h("h2", null, "The email fans get"),
        field("Song title", f.title), field("Subject line", f.subject),
        field("Message", f.body, "Their personal listening link and an unsubscribe link are added automatically."),
        field("Released link", f.released, "Where everyone is sent once it's out (Spotify or a smart link). Needed before you mark it released."),
        !ro && h("div", { class: "form__actions" }, h("button", { class: "btn btn--grad", onclick: trySave }, "Save changes"))));
  }

  // ================================================================ EMAIL
  // Nudges the sender to work through the queue now, rather than waiting for its schedule.
  const kickSender = () => call("/functions/v1/send-queued", { headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
  const pct = (n, of) => (of ? Math.round((n / of) * 100) + "%" : "–");
  const kindLabel = { broadcast: "Email", drop_auto: "Automatic · QR drop", drop_release: "Automatic · it's out now", link_release: "Automatic · it's out now", welcome: "Automatic · welcome" };
  const AUTOS = {
    welcome: ["Welcome email", "Goes to a new fan the first time they join through the website.", "{{first_name}} becomes the fan's name."],
    release: ["“It's out now” email", "Goes to everyone who scanned a QR drop, at the moment you mark that drop as released.", "{{first_name}} becomes the fan's name, {{title}} the song, and {{link}} the released link. A “Listen now” button is added too."],
    enquiry_reply: ["Booking enquiry confirmation", "Goes to a promoter straight after they send an enquiry, so they know it arrived.", "{{first_name}} becomes their first name and {{event_name}} their event."],
  };
  function editAutomation(a, reload) {
    const [name, when, words] = AUTOS[a.key];
    const on = h("input", { id: "auOn", type: "checkbox", checked: a.enabled });
    const subject = h("input", { id: "auSubject", type: "text", maxlength: "200", value: a.subject });
    const body = h("textarea", { id: "auBody", maxlength: "10000", style: "min-height:200px" }); body.value = a.body;
    const out = h("div", { class: "note note--err", role: "status" });
    const save = async () => {
      try { await rpc("automation_save", { p_key: a.key, p_enabled: on.checked, p_subject: subject.value, p_body: body.value }); dlg.close(); toast(on.checked ? "Saved. This email is switched on." : "Saved. This email is switched off."); reload(); }
      catch (e) { out.textContent = friendly(e); }
    };
    openDialog(h("h2", null, name), h("p", { class: "muted", style: "margin:-8px 0 16px" }, when),
      field("Subject line", subject), field("Message", body, words + " The A.R.T details are added at the bottom automatically."),
      h("label", { class: "check", for: "auOn" }, on, h("span", null, "Switched on. Untick to stop this email being sent.")), out,
      h("div", { class: "form__actions", style: "margin-top:16px" }, h("button", { class: "btn btn--grad", type: "button", onclick: save }, "Save"), h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Cancel")));
  }

  async function emailView() {
    const [list, autos] = await Promise.all([rpc("campaigns_list"), rpc("automations_list")]);
    const create = async () => { try { location.hash = "#mail/" + (await rpc("campaign_save", { p_id: null, p_subject: "", p_body: "" })); } catch (e) { toast(friendly(e), true); } };
    show(head("Email", me.manager && h("button", { class: "btn btn--ink btn--sm", onclick: create }, "New email")),
      list.length ? h("div", { class: "tablewrap" }, h("table", null,
        h("thead", null, h("tr", null, h("th", null, "Email"), h("th", null, "Status"), h("th", { class: "num" }, "Sent to"), h("th", { class: "num" }, "Opened"), h("th", { class: "num" }, "Clicked"), h("th", { class: "num" }, "Failed"))),
        h("tbody", null, list.map((c) => {
          const open = c.kind === "broadcast";
          return h("tr", { class: open ? "click" : "", tabindex: open ? "0" : null,
            onclick: open ? () => (location.hash = "#mail/" + c.id) : null,
            onkeydown: open ? (e) => { if (e.key === "Enter") location.hash = "#mail/" + c.id; } : null },
            h("td", null, h("div", { class: "strong" }, c.subject || "(no subject yet)"),
              h("div", { class: "muted" }, kindLabel[c.kind] + (c.drop_title ? " · " + c.drop_title : "") + " · " + fmtDate(c.sent_at || c.created_at))),
            h("td", null, h("span", { class: "tag tag--" + (c.status === "sent" ? "released" : c.status === "sending" ? "live" : "draft") }, c.kind === "broadcast" ? c.status : "on")),
            h("td", { class: "num" }, nf(c.sent)), h("td", { class: "num" }, pct(c.opened, c.sent)), h("td", { class: "num" }, pct(c.clicked, c.sent)), h("td", { class: "num" }, nf(c.failed)));
        }))))
        : emptyState("No emails yet", "Write one to tell the list about new music or a show.", me.manager && h("button", { class: "btn btn--grad", type: "button", onclick: create }, "Write the first email")),
      h("p", { class: "hint", style: "margin:14px 0 22px" }, "Opened and clicked numbers come from the email service once it's connected. Opens are an estimate: some mail apps hide them."),
      h("section", { class: "panel" }, h("h2", null, "Automatic emails"),
        h("p", { class: "muted", style: "margin:-6px 0 8px" }, "Emails the centre sends by itself. Each one only goes out while it's switched on." + (me.manager ? " Read the wording before you switch one on." : "")),
        autos.map((a) => h("div", { class: "row" },
          h("div", { class: "row__main" }, h("div", { class: "strong" }, AUTOS[a.key][0]), h("div", { class: "muted" }, AUTOS[a.key][1] + (a.sent ? ` ${nf(a.sent)} sent so far.` : ""))),
          h("div", { class: "row__side" }, h("span", { class: "tag " + (a.enabled ? "tag--live" : "") }, a.enabled ? "on" : "off"),
            me.manager && h("button", { class: "btn btn--soft btn--sm", "aria-label": "Edit the " + AUTOS[a.key][0], onclick: () => editAutomation(a, emailView) }, "Edit")))),
        h("p", { class: "hint", style: "margin-top:10px" }, "The early-listen email for each QR drop is set on the drop itself.")));
  }

  async function mailView(id) {
    const [c, drops, tags, audiences] = await Promise.all([rpc("campaign_get", { p_id: id }), rpc("drops_list"), rpc("tags_list"), rpc("audiences_list")]);
    if (!c) { show(h("a", { class: "back", href: "#email" }, "← All emails"), h("div", { class: "panel" }, "That email no longer exists.")); return; }
    const draft = c.status === "draft", ro = !me.manager || !draft;
    const seg = c.segment || {};

    if (!draft) {
      show(h("a", { class: "back", href: "#email" }, "← All emails"), head(c.subject),
        h("div", { class: "tiles" }, tile(c.recipients, "Fans it went to"), tile(c.sent, "Sent"), tile(c.opened, "Opened"), tile(c.clicked, "Clicked")),
        h("section", { class: "panel" }, h("h2", null, c.status === "sending" ? "Sending now…" : "Sent " + fmtDate(c.sent_at)),
          c.failed ? h("p", { class: "muted", style: "margin-bottom:14px" }, nf(c.failed) + " could not be delivered (bounced, or unsubscribed just before sending).") : null,
          h("div", { class: "preview" }, previewBody(c.body, "Mele"))));
      if (c.status === "sending") setTimeout(() => { if (location.hash === "#mail/" + id) mailView(id).catch(() => null); }, 2500);
      return;
    }

    const subject = h("input", { id: "mSubject", type: "text", value: c.subject, maxlength: "200", disabled: ro, placeholder: "New single out Thursday" });
    const body = h("textarea", { id: "mBody", maxlength: "20000", disabled: ro, style: "min-height:220px", placeholder: "Kia ora {{first_name}},\n\nWe've got something new for you…" });
    body.value = c.body;
    // Who gets it: any mix of filters. Leave them all blank for everyone.
    const city = h("input", { id: "mCity", type: "text", value: seg.city || "", maxlength: "80", placeholder: "Any town", disabled: ro });
    const drop = h("select", { id: "mDrop", disabled: ro }, h("option", { value: "" }, "Doesn't matter"), drops.map((d) => h("option", { value: d.id }, d.title)));
    drop.value = seg.drop_id || "";
    const tagNames = tags.map((t) => t.tag); if (seg.tag && !tagNames.includes(seg.tag)) tagNames.push(seg.tag);
    const tag = h("select", { id: "mTag", disabled: ro }, h("option", { value: "" }, "Doesn't matter"), tagNames.map((t) => h("option", { value: t }, t)));
    tag.value = seg.tag || "";
    const scanOpts = [2, 3, 5]; if (seg.min_drops && !scanOpts.includes(seg.min_drops)) scanOpts.push(seg.min_drops);
    const minDrops = h("select", { id: "mScans", disabled: ro }, h("option", { value: "" }, "Doesn't matter"), scanOpts.sort((a, b) => a - b).map((n) => h("option", { value: n }, n === 1 ? "At least 1 QR drop" : `${n} or more QR drops`)));
    minDrops.value = seg.min_drops || "";
    const saved = h("select", { id: "mSaved", disabled: ro }, h("option", { value: "" }, "Choose…"), audiences.map((a) => h("option", { value: a.id }, `${a.name} (${nf(a.fans)})`)));
    const count = h("p", { class: "strong", role: "status", style: "margin-top:12px" });
    const preview = h("div", { class: "preview" });
    let audience = 0;

    const segment = () => {
      const s = {};
      if (city.value.trim()) s.city = city.value.trim();
      if (drop.value) s.drop_id = drop.value;
      if (tag.value) s.tag = tag.value;
      if (minDrops.value) s.min_drops = Number(minDrops.value);
      return s;
    };
    const fill = (s) => { city.value = s.city || ""; drop.value = s.drop_id || ""; if (drop.value !== (s.drop_id || "")) drop.value = ""; tag.value = s.tag || ""; minDrops.value = s.min_drops || ""; };
    saved.addEventListener("change", () => { const a = audiences.find((x) => x.id === saved.value); if (a) fill(a.segment); delBtn.classList.toggle("hide", !a); refresh(); });
    const saveAudience = () => {
      if (!Object.keys(segment()).length) { toast("Choose at least one filter first. “Everyone” doesn't need saving.", true); return; }
      const nameIn = h("input", { id: "audName", type: "text", maxlength: "80", placeholder: "e.g. Wellington superfans" });
      const out = h("div", { class: "note note--err", role: "status" });
      const go = async () => { try { await save(); await rpc("audience_save", { p_id: null, p_name: nameIn.value, p_segment: segment() }); dlg.close(); toast("Audience saved"); mailView(id); } catch (e) { out.textContent = friendly(e); } };
      nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      openDialog(h("h2", null, "Save this audience"), field("Name", nameIn, "It keeps the filters, not a fixed list, so new fans who match are included next time."), out,
        h("div", { class: "form__actions" }, h("button", { class: "btn btn--grad", type: "button", onclick: go }, "Save audience"), h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Cancel")));
      nameIn.focus();
    };
    const delBtn = h("button", { class: "btn btn--danger btn--sm hide", type: "button", onclick: () => { const a = audiences.find((x) => x.id === saved.value); if (!a) return;
      confirmBox(`Delete the saved audience “${a.name}”?`, "No fans are removed. Emails already written keep their own filters.", "Delete audience",
        async () => { try { await save(); await rpc("audience_delete", { p_id: a.id }); toast("Audience deleted"); mailView(id); } catch (e) { toast(friendly(e), true); } }); } }, "Delete saved audience");
    const refresh = async () => {
      preview.textContent = ""; preview.append(h("div", { class: "preview__subject" }, subject.value || "(no subject yet)"), previewBody(body.value, "Mele"));
      try { audience = await rpc("segment_count", { p_segment: segment() }); count.textContent = audience === 1 ? "This will go to 1 fan." : `This will go to ${nf(audience)} fans.`; }
      catch (_) { count.textContent = ""; }
    };
    let t; const soon = () => { clearTimeout(t); t = setTimeout(refresh, 250); };
    [subject, body].forEach((el) => el.addEventListener("input", soon));
    city.addEventListener("input", () => { saved.value = ""; delBtn.classList.add("hide"); soon(); });
    [drop, tag, minDrops].forEach((el) => el.addEventListener("change", () => { saved.value = ""; delBtn.classList.add("hide"); refresh(); }));

    const save = () => rpc("campaign_save", { p_id: id, p_subject: subject.value, p_body: body.value, p_segment: segment() });
    const doSave = async () => { try { await save(); toast("Draft saved"); } catch (e) { toast(friendly(e), true); } };
    const doTest = async () => {
      if (needsContent()) return;
      try { await save(); const to = await rpc("campaign_test", { p_id: id }); await kickSender(); toast("Test sent to " + to); }
      catch (e) { toast(friendly(e), true); }
    };
    const needsContent = () => { if (subject.value.trim() && body.value.trim()) return false; toast("Add a subject and a message first.", true); return true; };
    const doSend = async () => {
      if (needsContent()) return;
      try { await save(); await refresh(); } catch (e) { toast(friendly(e), true); return; }
      if (!audience) { toast("Nobody on the list matches that audience.", true); return; }
      openDialog(h("h2", null, `Send to ${nf(audience)} ${audience === 1 ? "fan" : "fans"}?`),
        h("p", { class: "muted" }, `“${subject.value}” will be emailed straight away. This can't be undone or edited afterwards.`),
        h("div", { class: "form__actions", style: "margin-top:20px" },
          h("button", { class: "btn btn--grad", type: "button", onclick: async (e) => {
            e.target.disabled = true;
            try { const n = await rpc("campaign_send", { p_id: id }); dlg.close(); kickSender(); toast(`Sending to ${nf(n)} ${n === 1 ? "fan" : "fans"}`); mailView(id); }
            catch (err) { dlg.close(); toast(friendly(err), true); }
          } }, "Send now"),
          h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Not yet")));
    };
    const doDelete = () => confirmBox("Delete this draft?", "It hasn't been sent to anyone.", "Delete draft",
      async () => { try { await rpc("campaign_delete", { p_id: id }); toast("Draft deleted"); location.hash = "#email"; } catch (e) { toast(friendly(e), true); } });

    show(h("a", { class: "back", href: "#email" }, "← All emails"), head(c.subject || "New email"),
      h("div", { class: "compose" },
        h("div", null,
          h("section", { class: "panel" }, h("h2", null, "Message"),
            field("Subject line", subject),
            field("Message", body, "Write it like a normal email. {{first_name}} becomes each fan's name. The A.R.T details and an unsubscribe link are added at the bottom automatically.")),
          h("section", { class: "panel" }, h("h2", null, "Who gets it"),
            audiences.length ? field("Use a saved audience", saved) : null,
            h("div", { class: "grid2" }, field("Town or city contains", city), field("Has the tag", tag), field("Scanned the QR drop", drop), field("Has scanned", minDrops)),
            count,
            h("p", { class: "hint" }, "Leave all four as they are to email everyone. Fans must match every filter you set. Only subscribed fans are ever emailed."),
            !ro && h("div", { class: "form__actions", style: "margin-top:12px" }, h("button", { class: "btn btn--soft btn--sm", type: "button", onclick: saveAudience }, "Save as an audience"), delBtn))),
        h("div", null, h("section", { class: "panel" }, h("h2", null, "Preview"), preview,
          h("p", { class: "hint" }, "Shown as a fan called Mele would see it.")))),
      !ro && h("div", { class: "sendbar" },
        h("button", { class: "btn btn--grad", onclick: doSend }, "Send…"),
        h("button", { class: "btn btn--soft", onclick: doTest }, "Send a test to me"),
        h("button", { class: "btn btn--soft", onclick: doSave }, "Save draft"),
        h("button", { class: "btn btn--danger btn--sm", style: "margin-left:auto", onclick: doDelete }, "Delete draft")));
    await refresh();
  }

  function previewBody(text, name) {
    const merged = String(text || "").replace(/\{\{\s*first_name\s*\}\}/gi, name);
    const wrap = h("div", { class: "preview__body" });
    (merged.trim() ? merged.trim().split(/\n{2,}/) : ["(your message will appear here)"]).forEach((p) => {
      const el = h("p"); p.split("\n").forEach((line, i) => { if (i) el.append(h("br")); el.append(line); }); wrap.append(el);
    });
    wrap.append(h("p", { class: "preview__foot" }, "A.R.T · IKON Music, Wellington, Aotearoa New Zealand · Unsubscribe"));
    return wrap;
  }

  // ================================================================ REEL RADAR
  const radarState = { account: "", days: 90, sort: "breakout" };
  // Keep in step with ControlCentre/supabase/functions/_shared/themes.js
  const THEME_LABELS = { live: "Live performance", studio: "Studio", bts: "Behind the scenes", singing: "Singing clip", release: "New music",
    story: "Personal story", humour: "Humour", fans: "Fans & community", promo: "Merch & tickets", other: "Unclear" };
  const short = (n) => n == null ? "hidden" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K" : String(n);
  const DAYS = ["", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
  const times = (m) => (m == null ? "" : Number(m).toFixed(1).replace(/\.0$/, "") + "×");

  // Turns the pattern numbers into plain sentences. A group needs a few reels before
  // it's worth mentioning, otherwise one lucky reel would look like a rule.
  function patternLines(p) {
    const out = [], MIN = 3;
    const best = (rows) => rows.filter((r) => r.reels >= MIN).sort((a, b) => b.avg_multiple - a.avg_multiple);
    const d = best(p.by_day), t = best(p.by_time), c = best(p.by_caption);
    if (d.length > 1 && d[0].avg_multiple >= d[d.length - 1].avg_multiple * 1.2)
      out.push(["Best day", `${DAYS[d[0].dow]} do best (${times(d[0].avg_multiple)} usual views across ${d[0].reels} reels); ${DAYS[d[d.length - 1].dow]} do worst (${times(d[d.length - 1].avg_multiple)}).`]);
    if (t.length > 1 && t[0].avg_multiple >= t[t.length - 1].avg_multiple * 1.15)
      out.push(["Best time", `Reels posted in the ${t[0].band} (NZ time) average ${times(t[0].avg_multiple)} usual views, against ${times(t[t.length - 1].avg_multiple)} in the ${t[t.length - 1].band}.`]);
    if (c.length > 1 && c[0].avg_multiple >= c[c.length - 1].avg_multiple * 1.15) {
      const what = { short: "Short captions (under 80 characters)", medium: "Medium captions (a sentence or two)", long: "Long captions (a story)" };
      out.push(["Captions", `${what[c[0].bucket]} do best at ${times(c[0].avg_multiple)}; ${what[c[c.length - 1].bucket].toLowerCase()} do worst at ${times(c[c.length - 1].avg_multiple)}.`]);
    }
    const tags = p.hashtags.filter((x) => x.uses >= MIN && x.avg_multiple >= 1.1).slice(0, 4);
    if (tags.length) out.push(["Hashtags", "Tags on better-than-usual reels: " + tags.map((x) => `#${x.tag} (${times(x.avg_multiple)}, ${x.uses} reels)`).join(", ") + "."]);
    out.push(["Pace", `About ${p.per_week} reels a week per account. ${p.breakouts} of ${p.reels} reels were breakouts (at least 2× the account's usual views).`]);
    return out;
  }

  async function radarView() {
    const accounts = await rpc("radar_accounts_list");
    const acct = h("select", { id: "rAcct", "aria-label": "Which account" }, h("option", { value: "" }, "All accounts"), accounts.map((a) => h("option", { value: a.id }, "@" + a.username)));
    acct.value = accounts.some((a) => a.id === radarState.account) ? radarState.account : (radarState.account = "");
    const days = h("select", { id: "rDays", "aria-label": "Time period" }, [[30, "Last 30 days"], [90, "Last 90 days"], [365, "Last 12 months"]].map(([v, t]) => h("option", { value: v }, t)));
    days.value = radarState.days;
    const sort = h("select", { id: "rSort", "aria-label": "Sort by" }, [["breakout", "Biggest breakouts"], ["views", "Most views"], ["recent", "Newest"]].map(([v, t]) => h("option", { value: v }, t)));
    sort.value = radarState.sort;
    const results = h("div"), patterns = h("div");

    async function load() {
      const args = { p_account_id: radarState.account || null, p_days: Number(radarState.days) };
      const [reels, pat, th] = await Promise.all([rpc("radar_reels", { ...args, p_sort: radarState.sort, p_limit: 30 }), rpc("radar_patterns", args), rpc("radar_theme_stats", args)]);
      patterns.textContent = ""; results.textContent = "";
      if (reels.length && (th.themes.length || th.waiting)) {
        // "Unclear" reels are counted but not ranked: they say nothing about what works.
        // Themes with fewer than 3 reels go last and are dimmed: one reel isn't a pattern.
        const named = th.themes.filter((t) => t.theme !== "other"), unclear = th.themes.find((t) => t.theme === "other");
        const ranked = named.filter((t) => t.reels >= 3).concat(named.filter((t) => t.reels < 3).map((t) => ({ ...t, thin: true })));
        const top = Math.max(1, ...ranked.map((t) => Number(t.typical_multiple)));
        patterns.append(h("section", { class: "panel" }, h("h2", null, "Which kinds of reel do best"),
          ranked.length ? h("div", { class: "themes" }, ranked.map((t) => h("div", { class: "theme" + (t.thin ? " theme--thin" : "") },
            h("div", { class: "theme__name" }, THEME_LABELS[t.theme] || t.theme),
            h("div", { class: "theme__bar", "aria-hidden": "true" }, h("span", { style: `width:${Math.max(4, Math.round((t.typical_multiple / top) * 100))}%` })),
            h("div", { class: "theme__num" }, h("b", null, times(t.typical_multiple)), ` · ${nf(t.reels)} ${t.reels === 1 ? "reel" : "reels"}` + (t.thin ? " · too few to judge" : "") + (t.breakouts ? ` · ${nf(t.breakouts)} ${t.breakouts === 1 ? "breakout" : "breakouts"}` : "")))))
            : h("p", { class: "muted" }, "No reels have been given a theme yet."),
          h("p", { class: "hint", style: "margin-top:12px" },
            "The number is how a typical reel of that kind does against the account's usual views (1× is normal). Themes are chosen by AI from the caption only; it can't see the video. "
            + (unclear ? `${nf(unclear.reels)} ${unclear.reels === 1 ? "reel was" : "reels were"} too vague to label. ` : "")
            + (th.waiting ? `${nf(th.waiting)} more ${th.waiting === 1 ? "is" : "are"} waiting to be labelled. ` : "")
            + "Treat a theme with only a few reels as a hint, not a finding.")));
      }
      if (!reels.length) { results.append(h("div", { class: "panel empty" }, accounts.length ? "No reels in this period yet. Press “Check now” to fetch them." : "Add an artist to the watchlist to get started.")); return; }
      patterns.append(h("section", { class: "panel" }, h("h2", null, "What the better reels have in common"),
        pat.reels < 8 ? h("p", { class: "muted" }, "Not enough reels yet to see patterns. They'll appear after a few more are tracked.")
          : patternLines(pat).map(([k, v]) => h("div", { class: "row" }, h("div", { class: "row__main" }, h("div", { class: "label2" }, k), h("div", null, v)))),
        h("p", { class: "hint", style: "margin-top:12px" }, "These are tendencies in the numbers, not rules. Views include paid (boosted) views, so a promoted reel can look like a hit.")));
      results.append(h("div", { class: "reels" }, reels.map((r) => h("article", { class: "reel" },
        h("div", { class: "reel__top" },
          h("span", { class: "strong" }, "@" + r.username), h("span", { class: "muted" }, fmtDate(r.posted_at)),
          r.multiple != null && h("span", { class: "tag " + (r.multiple >= 2 ? "tag--live" : r.multiple >= 1 ? "tag--released" : "") }, times(r.multiple) + " usual")),
        h("p", { class: "reel__cap" }, r.caption || "(no caption)"),
        r.theme && r.theme !== "other" && h("div", null, h("span", { class: "tag" }, THEME_LABELS[r.theme] || r.theme)),
        h("div", { class: "reel__stats" },
          h("div", null, h("b", null, short(r.views)), "views"), h("div", null, h("b", null, short(r.likes)), "likes"), h("div", null, h("b", null, short(r.comments)), "comments"),
          r.permalink && h("a", { class: "btn btn--soft btn--sm", href: r.permalink, target: "_blank", rel: "noopener", "aria-label": `Open @${r.username}'s reel from ${fmtDate(r.posted_at)} on Instagram` }, "Open reel"))))));
    }
    acct.addEventListener("change", () => { radarState.account = acct.value; load(); });
    days.addEventListener("change", () => { radarState.days = days.value; load(); });
    sort.addEventListener("change", () => { radarState.sort = sort.value; load(); });

    const name = h("input", { id: "rNew", type: "text", maxlength: "80", placeholder: "Instagram username, e.g. @artistname", "aria-label": "Instagram username to add" });
    const add = async () => { try { await rpc("radar_account_add", { p_username: name.value }); toast("Added. Fetching their reels…"); await check(true); } catch (e) { toast(friendly(e), true); } };
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    const check = async (quiet) => {
      try { const r = await call("/functions/v1/radar-refresh", { headers: { "Content-Type": "application/json" }, body: "{}" }); if (!quiet) toast(`Checked ${nf(r.checked)} ${r.checked === 1 ? "account" : "accounts"}`); }
      catch (e) { toast(e.status === 503 ? "Instagram isn't connected yet." : "Couldn't reach Instagram. Try again shortly.", true); }
      radarView();
    };

    show(head("Reel Radar", h("button", { class: "btn btn--soft btn--sm", onclick: () => check(false) }, "Check now")),
      DEV && h("div", { class: "banner" }, h("b", null, "Test mode. "), "These reels and numbers are invented so you can try the screen. Real figures appear once A.R.T's Instagram is connected."),
      h("section", { class: "panel" }, h("h2", null, "Watchlist"),
        accounts.length ? accounts.map((a) => h("div", { class: "row" },
          h("div", { class: "row__main" }, h("div", { class: "strong" }, "@" + a.username + (a.display_name ? " · " + a.display_name : "")),
            h("div", { class: "muted" }, a.last_error ? "Couldn't fetch: " + a.last_error
              : a.last_checked_at ? `${short(a.followers)} followers · ${nf(a.reels)} reels tracked · usually ${short(a.typical_views == null ? null : Math.round(a.typical_views))} views a reel` : "Not checked yet")),
          h("div", { class: "row__side" }, me.manager && h("button", { class: "btn btn--soft btn--sm", "aria-label": "Remove @" + a.username,
            onclick: () => confirmBox(`Stop watching @${a.username}?`, "Their tracked reels and history will be removed from the radar.", "Remove",
              async () => { try { await rpc("radar_account_remove", { p_id: a.id }); toast("Removed"); radarView(); } catch (e) { toast(friendly(e), true); } }) }, "Remove"))))
          : h("p", { class: "muted" }, "Nobody on the watchlist yet."),
        me.manager && h("div", { class: "addrow" }, name, h("button", { class: "btn btn--ink", onclick: add }, "Add to watchlist")),
        h("p", { class: "hint", style: "margin-top:10px" }, "Works for professional (business or creator) accounts. Add A.R.T's own account too, to compare.")),
      h("div", { class: "toolbar toolbar--3" }, acct, days, sort),
      patterns, results);
    await load();
  }

  // ================================================================ BOOKINGS
  const STAGES = [["enquiry", "New enquiries"], ["quoted", "Quoted"], ["confirmed", "Confirmed"], ["played", "Played"], ["declined", "Declined"]];
  const money = (n) => (n == null ? "" : "$" + Number(n).toLocaleString("en-NZ", { maximumFractionDigits: 0 }));
  const showRow = (s) => h("div", { class: "row" },
    h("div", { class: "row__main" }, h("div", { class: "strong" }, s.event_name), h("div", { class: "muted" }, [s.venue, s.city].filter(Boolean).join(", ") || "Venue to be confirmed")),
    h("div", { class: "row__side muted", style: "text-align:right" }, h("div", null, h("div", { class: "strong", style: "color:var(--ink)" }, fmtDay(s.event_date)), s.set_time ? h("div", null, s.set_time) : null)));

  const bookingsState = { view: (() => { try { return localStorage.getItem("art_bookings_view") === "board" ? "board" : "list"; } catch (_) { return "list"; } })() };
  async function bookingsView() {
    if (!me.manager) {
      // Artists see the shows that are locked in, not the pipeline or the money.
      const shows = await rpc("shows_list");
      const up = shows.filter((s) => s.status === "confirmed" && (s.days_away == null || s.days_away >= 0)), past = shows.filter((s) => !up.includes(s)).reverse();
      show(head("Shows"),
        h("section", { class: "panel" }, h("h2", null, "Coming up"), up.length ? up.map(showRow) : h("p", { class: "muted" }, "No confirmed shows yet.")),
        past.length ? h("section", { class: "panel" }, h("h2", null, "Played"), past.map(showRow)) : null,
        h("p", { class: "muted" }, "Enquiries and fees are handled by the manager."));
      return;
    }
    const data = await rpc("bookings_list");
    const create = () => {
      const ev = h("input", { id: "nbEvent", type: "text", maxlength: "160" }), who = h("input", { id: "nbWho", type: "text", maxlength: "120" });
      const out = h("div", { class: "note note--err", role: "status" });
      const go = async () => { try { const id = await rpc("booking_save", { p_id: null, p_fields: { event_name: ev.value, contact_name: who.value } }); dlg.close(); location.hash = "#booking/" + id; } catch (e) { out.textContent = friendly(e); } };
      openDialog(h("h2", null, "Add a booking"), field("Event", ev), field("Contact name", who, "For enquiries that came by phone, email or in person."), out,
        h("div", { class: "form__actions" }, h("button", { class: "btn btn--grad", type: "button", onclick: go }, "Add"), h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Cancel")));
      ev.focus();
    };
    const card = (b) => h("a", { class: "dropcard" + (b.unseen ? " dropcard--new" : ""), href: "#booking/" + b.id },
      h("div", { class: "reel__top" }, b.unseen && h("span", { class: "tag tag--live" }, "new"),
        h("span", { class: "muted" }, b.event_date ? fmtDay(b.event_date) + (b.days_away != null && b.days_away >= 0 ? ` · in ${b.days_away} days` : "") : (b.date_notes || "No date yet")),
        b.fee != null && h("span", { class: "tag", style: "margin-left:auto" }, money(b.fee))),
      h("h3", null, b.event_name),
      h("div", { class: "muted" }, [[b.venue, b.city].filter(Boolean).join(", "), b.organisation || b.contact_name].filter(Boolean).join(" · ")));
    // The board: one column per stage. Drag a card with a mouse, or use its "Move to"
    // menu, which works the same with a keyboard or a finger.
    const stageName = (s) => (STAGES.find((x) => x[0] === s) || ["", s])[1];
    const moveTo = async (b, stage) => {
      if (!stage || stage === b.status) return;
      try { await rpc("booking_set_status", { p_id: b.id, p_status: stage }); toast(`“${b.event_name}” moved to ${stageName(stage)}`); bookingsView(); }
      catch (e) { toast(friendly(e), true); bookingsView(); }
    };
    const boardCard = (b) => {
      const sel = h("select", { class: "select--sm kcard__move", "aria-label": `Move “${b.event_name}” to another stage` },
        h("option", { value: "" }, "Move to…"), STAGES.filter(([k]) => k !== b.status).map(([k, label]) => h("option", { value: k }, label)));
      sel.addEventListener("change", () => moveTo(b, sel.value));
      const el = h("article", { class: "kcard" + (b.unseen ? " kcard--new" : ""), draggable: "true" },
        h("div", { class: "kcard__top" }, b.unseen && h("span", { class: "tag tag--live" }, "new"),
          h("span", { class: "muted" }, b.event_date ? fmtDay(b.event_date) : (b.date_notes || "No date yet")),
          b.fee != null && h("span", { class: "tag", style: "margin-left:auto" }, money(b.fee))),
        h("a", { class: "kcard__title", href: "#booking/" + b.id, draggable: "false" }, b.event_name),
        h("div", { class: "muted" }, [b.city, b.organisation || b.contact_name].filter(Boolean).join(" · ")),
        sel);
      el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", b.id); e.dataTransfer.effectAllowed = "move"; el.classList.add("is-dragging"); });
      el.addEventListener("dragend", () => el.classList.remove("is-dragging"));
      return el;
    };
    const board = () => h("div", { class: "board", role: "group", "aria-label": "Bookings by stage" }, STAGES.map(([key, label]) => {
      const rows = data.rows.filter((b) => b.status === key);
      const total = key === "confirmed" ? rows.reduce((s, b) => s + (Number(b.fee) || 0), 0) : 0;
      const col = h("section", { class: "board__col", "aria-label": label },
        h("div", { class: "board__head" }, h("h2", null, label), h("span", { class: "muted" }, rows.length + (total ? " · " + money(total) : ""))),
        rows.length ? rows.map(boardCard) : h("p", { class: "muted board__empty" }, "Nothing here."));
      col.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; col.classList.add("is-over"); });
      col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("is-over"); });
      col.addEventListener("drop", (e) => { e.preventDefault(); col.classList.remove("is-over");
        const b = data.rows.find((x) => x.id === e.dataTransfer.getData("text/plain")); if (b) moveTo(b, key); });
      return col;
    }));
    const viewBtn = (v, label) => h("button", { class: "seg" + (bookingsState.view === v ? " seg--on" : ""), type: "button", "aria-pressed": String(bookingsState.view === v),
      onclick: () => { bookingsState.view = v; try { localStorage.setItem("art_bookings_view", v); } catch (_) { /* fine: it just won't be remembered */ } bookingsView(); } }, label);
    const views = h("div", { class: "segs", role: "group", "aria-label": "How to show bookings" }, viewBtn("list", "List"), viewBtn("board", "Board"));

    // The list: every booking in one table, narrowed by stage.
    const stageTag = { enquiry: "tag--live", quoted: "", confirmed: "tag--released", played: "", declined: "tag--archived" };
    const stage = bookingsState.stage || "";
    const shown = data.rows.filter((b) => !stage || b.status === stage).sort((a, b) => STAGES.findIndex((s) => s[0] === a.status) - STAGES.findIndex((s) => s[0] === b.status));
    const stageBtn = (key, label, n) => h("button", { class: "seg" + (stage === key ? " seg--on" : ""), type: "button", "aria-pressed": String(stage === key),
      onclick: () => { bookingsState.stage = key; bookingsView(); } }, label, h("span", { class: "seg__n" }, String(n)));
    const stageBar = h("div", { class: "segs segs--wrap", role: "group", "aria-label": "Show one stage" }, stageBtn("", "All", data.rows.length),
      STAGES.map(([key, label]) => stageBtn(key, label, data.rows.filter((b) => b.status === key).length)));
    const groups = [shown.length ? listTable(["Event", "Stage", "Date", "Who", ["Fee"], "Came in"], shown.map((b) => h("tr", opens("#booking/" + b.id),
        nameCell(b.event_name, [b.venue, b.city].filter(Boolean).join(", ") || "No venue yet"),
        h("td", null, h("span", { class: "tag " + (stageTag[b.status] || "") }, stageName(b.status)), b.unseen && h("span", { class: "tag tag--live", style: "margin-left:6px" }, "new")),
        h("td", null, h("div", null, b.event_date ? fmtDay(b.event_date) : (b.date_notes || "No date yet")), b.event_date && b.days_away != null && b.days_away >= 0 ? h("div", { class: "muted" }, b.days_away === 0 ? "Today" : `in ${b.days_away} days`) : null),
        h("td", null, h("div", null, b.contact_name || "–"), b.organisation ? h("div", { class: "muted" }, b.organisation) : null),
        numCell(b.fee != null ? money(b.fee) : h("span", { class: "muted" }, "–")),
        h("td", null, h("span", { class: "muted" }, ago(b.created_at) + (b.source === "website" ? " · booking form" : ""))))))
      : emptyState(stage ? "Nothing at this stage" : "No bookings yet", stage ? "Pick another stage, or “All” to see everything." : "Enquiries from the booking form land here. You can also add one that came by phone or email.",
          !stage && h("button", { class: "btn btn--grad", type: "button", onclick: create }, "Add a booking"))];
    show(head("Bookings", h("a", { class: "btn btn--soft btn--sm", href: "../../book/", target: "_blank", rel: "noopener" }, "View booking form"), h("button", { class: "btn btn--ink btn--sm", onclick: create }, "Add a booking")),
      h("div", { class: "viewbar" }, bookingsState.view === "board" ? h("span") : stageBar, views),
      bookingsState.view === "board" ? [board(), h("p", { class: "hint", style: "margin-top:12px" }, "Drag a card to another column, or use its “Move to” menu. Confirming a booking needs an event date.")] : groups);
  }

  async function bookingView(id) {
    if (!me.manager) { location.hash = "#bookings"; return; }
    const data = await rpc("booking_get", { p_id: id });
    if (!data) { show(h("a", { class: "back", href: "#bookings" }, "← All bookings"), h("div", { class: "panel" }, "That booking no longer exists.")); return; }
    const b = data.booking, reload = () => bookingView(id);
    const inp = (k, type, extra) => { const el = h("input", { id: "bk-" + k, type: type || "text", value: b[k] == null ? "" : b[k], ...(extra || {}) }); return el; };
    const f = {
      event_name: inp("event_name"), event_type: inp("event_type"), event_date: inp("event_date", "date"), date_notes: inp("date_notes"),
      venue: inp("venue"), city: inp("city"), audience: inp("audience"), budget: inp("budget"),
      contact_name: inp("contact_name"), organisation: inp("organisation"), contact_email: inp("contact_email", "email"), contact_phone: inp("contact_phone", "tel"),
      fee: inp("fee", "text", { inputmode: "decimal", placeholder: "e.g. 4500" }), set_time: inp("set_time", "text", { placeholder: "e.g. 8:30pm, 45 minutes" }),
      message: h("textarea", { id: "bk-message", style: "min-height:120px" }),
    };
    f.message.value = b.message || "";
    const values = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
    const save = async (quiet) => { await rpc("booking_save", { p_id: id, p_fields: values() }); if (!quiet) toast("Saved"); };
    const trySave = async () => { try { await save(); reload(); } catch (e) { toast(friendly(e), true); } };
    const move = async (s, msg) => { try { await save(true); await rpc("booking_set_status", { p_id: id, p_status: s }); toast(msg); reload(); } catch (e) { toast(friendly(e), true); } };
    const next = { enquiry: [["quoted", "Mark as quoted"]], quoted: [["confirmed", "Mark as confirmed"]], confirmed: [["played", "Mark as played"]], played: [], declined: [["enquiry", "Reopen"]] }[b.status];
    const note = h("textarea", { id: "bkNote", style: "min-height:70px", placeholder: "Add a note: a call, what was agreed, what's next…", "aria-label": "New note" });
    const addNote = async () => { try { await rpc("booking_note_add", { p_id: id, p_body: note.value }); toast("Note added"); reload(); } catch (e) { toast(friendly(e), true); } };
    const subject = encodeURIComponent("Re: " + b.event_name + " — A.R.T booking");
    // Puts a confirmed show on the public website's events list, through the website
    // editor's backend. Only the public details go: never the fee, contact or notes.
    const sameEvent = (a, c) => String(a || "").trim().toLowerCase().replace(/\s+/g, " ") === String(c || "").trim().toLowerCase().replace(/\s+/g, " ");
    const toWebsite = async () => {
      if (!cfg.editor) { toast("The website editor isn't connected.", true); return; }
      let events;
      try { await save(true); events = (await editorCall("/api/load", { type: "events" })).events || []; } catch (e) { toast(e.status ? siteErr(e) : friendly(e), true); return; }
      if (events.some((ev) => sameEvent(ev.name, f.event_name.value))) {
        openDialog(h("h2", null, "Already on the website"), h("p", { class: "muted" }, `There's already an event called “${f.event_name.value.trim()}” on the website's events list, so nothing was added. You can change it in the Website tab.`),
          h("div", { class: "form__actions", style: "margin-top:20px" }, h("a", { class: "btn btn--ink", href: "#site" }, "Open the Website tab"), h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Close")));
        return;
      }
      const when = f.event_date.value ? day(f.event_date.value).toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "";
      const name = h("input", { id: "wsName", type: "text", value: f.event_name.value.trim(), maxlength: "160" });
      const date = h("input", { id: "wsDate", type: "text", value: when, maxlength: "80" });
      const venue = h("input", { id: "wsVenue", type: "text", value: [f.venue.value.trim(), f.city.value.trim()].filter(Boolean).join(", "), maxlength: "200" });
      const out = h("div", { class: "note note--err", role: "status" });
      const go = async (e) => {
        if (!name.value.trim()) { out.textContent = "Give the event a name."; return; }
        e.target.disabled = true;
        try {
          // load again right before saving, so nothing published in the meantime is lost
          const latest = (await editorCall("/api/load", { type: "events" })).events || [];
          if (latest.some((ev) => sameEvent(ev.name, name.value))) { out.textContent = "An event with that name is already on the website."; e.target.disabled = false; return; }
          const item = { name: name.value.trim(), eyebrow: "Upcoming", date_display: date.value.trim(), venue: venue.value.trim(), lineup: "", poster: "", poster_alt: "", tickets_url: "" };
          await editorCall("/api/save", { type: "events", data: { events: [item].concat(latest) } });
          // keep the Website tab in step: add it to an unsaved draft, or reload a clean copy
          if (siteState.dirty.events && siteState.data.events) siteState.data.events.unshift({ ...item }); else siteState.data.events = null;
          await rpc("booking_note_add", { p_id: id, p_body: "Added to the website's events list" }).catch(() => null);
          dlg.close(); toast("Added. It will be on the website in about a minute."); reload();
        } catch (err) { e.target.disabled = false; out.textContent = err.status ? siteErr(err) : friendly(err); }
      };
      openDialog(h("h2", null, "Add this show to the website"),
        h("p", { class: "muted", style: "margin:-8px 0 16px" }, "This is what the public will see. The fee, the contact and your notes are never published."),
        field("Event name", name), field("Date, as shown", date, "Write it however you'd like it to read."), field("Venue and city", venue), out,
        h("p", { class: "hint" }, "It goes to the top of the events list and is published straight away. Add a poster, lineup or ticket link afterwards in the Website tab."),
        h("div", { class: "form__actions", style: "margin-top:16px" }, h("button", { class: "btn btn--grad", type: "button", onclick: go }, "Publish to the website"), h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Cancel")));
    };
    const toContacts = async () => { try { await save(true); const cid = await rpc("contact_from_booking", { p_booking_id: id }); toast("Saved to contacts"); location.hash = "#contact/" + cid; } catch (e) { toast(friendly(e), true); } };

    show(h("a", { class: "back", href: "#bookings" }, "← All bookings"), head(b.event_name),
      h("section", { class: "panel" }, h("div", { class: "statusbar" },
        h("div", null, h("span", { class: "tag tag--" + (b.status === "confirmed" ? "live" : b.status === "played" ? "released" : b.status === "declined" ? "archived" : "") }, b.status),
          h("p", { class: "muted", style: "margin-top:8px" }, (b.source === "website" ? "Came in through the website" : "Added by hand") + " on " + fmtDate(b.created_at)
            + (b.event_date ? " · event " + fmtDay(b.event_date) + (data.days_away >= 0 ? `, in ${data.days_away} days` : "") : ""))),
        h("div", { class: "form__actions" },
          next.map(([s, label]) => h("button", { class: "btn btn--grad", onclick: () => move(s, "Moved to " + s) }, label)),
          b.status === "confirmed" && h("button", { class: "btn btn--soft", type: "button", onclick: toWebsite }, "Add to the website"),
          b.contact_email && h("a", { class: "btn btn--soft", href: `mailto:${b.contact_email}?subject=${subject}` }, "Reply by email"),
          b.status !== "declined" && b.status !== "played" && h("button", { class: "btn btn--soft", onclick: () => move("declined", "Marked as declined") }, "Decline")))),
      kpiStrip([
        { label: "Stage", value: b.status === "enquiry" ? "New enquiry" : b.status, sub: (b.source === "website" ? "from the booking form" : "added by hand") },
        { label: "Event date", value: b.event_date ? fmtDay(b.event_date) : "Not set", sub: b.event_date ? (data.days_away > 0 ? `in ${data.days_away} days` : data.days_away === 0 ? "today" : "in the past") : (b.date_notes || "no date yet") },
        { label: "Agreed fee", value: b.fee != null ? money(b.fee) : "–", sub: b.budget ? "their budget: " + b.budget : "no budget given" },
        { label: "Where", value: b.city || "–", sub: b.venue || "no venue yet" },
        { label: "Notes", value: nf(data.notes.length), sub: data.notes.length ? "last " + ago(data.notes[0].created_at).toLowerCase() : "none yet" },
      ]),
      h("div", { class: "compose" },
        h("div", null,
          h("section", { class: "panel" }, h("h2", null, "The event"),
            field("Event", f.event_name),
            h("div", { class: "grid2" }, field("Date", f.event_date), field("About the date", f.date_notes), field("Venue", f.venue), field("Town or city", f.city), field("Type", f.event_type), field("Audience", f.audience)),
            field("Their message", f.message)),
          h("section", { class: "panel" }, h("h2", null, "Contact"),
            h("div", { class: "grid2" }, field("Name", f.contact_name), field("Organisation", f.organisation), field("Email", f.contact_email), field("Phone", f.contact_phone)),
            data.contact ? h("p", { class: "muted" }, "In your contacts as ", h("a", { href: "#contact/" + data.contact.id }, data.contact.name), ". Their page shows every booking and note.")
              : h("div", { class: "form__actions" }, h("button", { class: "btn btn--soft btn--sm", type: "button", onclick: toContacts }, "Save to contacts"),
                  h("span", { class: "hint", style: "margin:0" }, "Keeps this person in your address book and links this booking to them.")))),
        h("div", null,
          h("section", { class: "panel" }, h("h2", null, "The deal"),
            field("Their budget", f.budget, "As they wrote it."), field("Agreed fee (NZ$)", f.fee, "Only managers can see this."), field("Set time", f.set_time, "Artists see this once the show is confirmed.")),
          h("section", { class: "panel" }, h("h2", null, "Notes"), note,
            h("div", { class: "form__actions", style: "margin:10px 0 6px" }, h("button", { class: "btn btn--ink btn--sm", onclick: addNote }, "Add note")),
            data.notes.map((n) => h("div", { class: "row" }, h("div", { class: "row__main" }, h("div", { style: "white-space:pre-wrap" }, n.body), h("div", { class: "muted" }, n.author + " · " + fmtDate(n.created_at)))))))),
      h("div", { class: "sendbar" }, h("button", { class: "btn btn--grad", onclick: trySave }, "Save changes"),
        h("button", { class: "btn btn--danger btn--sm", style: "margin-left:auto", onclick: () => confirmBox("Delete this booking?", "The enquiry, its notes and history will be removed for good. To keep a record, use Decline instead.", "Delete for good",
          async () => { try { await rpc("booking_delete", { p_id: id }); toast("Deleted"); location.hash = "#bookings"; } catch (e) { toast(friendly(e), true); } }) }, "Delete")));
  }

  // ================================================================ CALENDAR
  // Release days, release tasks and confirmed shows in one place. A month grid on wide
  // screens; on a phone the same items as a day-by-day list.
  const calState = { y: new Date().getFullYear(), m: new Date().getMonth() };
  const isoDay = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const CAL_KINDS = { release: ["Release day", "cal--release"], show: ["Show", "cal--show"], task: ["Task", "cal--task"] };
  const calHref = (i) => (i.kind === "show" ? (me.manager ? "#booking/" + i.id : "#bookings") : "#release/" + i.id);

  async function calendarView() {
    const first = new Date(calState.y, calState.m, 1), last = new Date(calState.y, calState.m + 1, 0);
    // the grid runs Monday to Sunday and includes the days either side that share a week
    const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
    const end = new Date(last); end.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7)));
    const items = await rpc("calendar_items", { p_from: isoDay(start), p_to: isoDay(end) });
    const byDay = {}; items.forEach((i) => (byDay[i.date] = byDay[i.date] || []).push(i));
    const today = isoDay(new Date()), monthName = first.toLocaleDateString("en-NZ", { month: "long", year: "numeric" });
    const go = (delta) => { const d = new Date(calState.y, calState.m + delta, 1); calState.y = d.getFullYear(); calState.m = d.getMonth(); calendarView(); };
    const chip = (i) => h("a", { class: "cal__item " + CAL_KINDS[i.kind][1] + (i.done ? " cal--done" : ""), href: calHref(i), title: CAL_KINDS[i.kind][0] + ": " + i.title + (i.sub ? " (" + i.sub + ")" : "") },
      h("span", { class: "cal__kind" }, i.kind === "task" ? (i.done ? "✓" : "○") : i.kind === "show" ? "Show" : "Out"), " ", i.title);

    const cells = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = isoDay(d), list = byDay[key] || [], other = d.getMonth() !== calState.m;
      cells.push(h("div", { class: "cal__day" + (other ? " cal__day--other" : "") + (key === today ? " cal__day--today" : "") },
        h("div", { class: "cal__num" }, String(d.getDate())),
        list.slice(0, 3).map(chip), list.length > 3 ? h("div", { class: "cal__more" }, `+${list.length - 3} more`) : null));
    }
    const inMonth = items.filter((i) => i.date >= isoDay(first) && i.date <= isoDay(last));
    const days = [...new Set(inMonth.map((i) => i.date))];
    const agenda = days.length ? days.map((dkey) => h("div", { class: "agenda__day" + (dkey === today ? " agenda__day--today" : "") },
      h("div", { class: "agenda__date" }, day(dkey).toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" }) + (dkey === today ? " · today" : "")),
      byDay[dkey].map((i) => h("a", { class: "row row--link", href: calHref(i) },
        h("div", { class: "row__main" }, h("div", { class: "strong" + (i.done ? " cal--struck" : "") }, i.title), i.sub ? h("div", { class: "muted" }, i.sub) : null),
        h("div", { class: "row__side" }, h("span", { class: "tag " + (i.kind === "release" ? "tag--live" : i.kind === "show" ? "tag--released" : "") }, i.kind === "task" ? (i.done ? "task · done" : "task") : CAL_KINDS[i.kind][0]))))))
      : h("p", { class: "muted" }, "Nothing dated in " + monthName + ".");

    show(head("Calendar",
        h("button", { class: "btn btn--soft btn--sm", type: "button", onclick: () => go(-1), "aria-label": "Previous month" }, "← Earlier"),
        h("button", { class: "btn btn--soft btn--sm", type: "button", onclick: () => { const n = new Date(); calState.y = n.getFullYear(); calState.m = n.getMonth(); calendarView(); } }, "This month"),
        h("button", { class: "btn btn--soft btn--sm", type: "button", onclick: () => go(1), "aria-label": "Next month" }, "Later →")),
      h("h2", { class: "cal__title", "aria-live": "polite" }, monthName),
      h("div", { class: "viz-legend" }, h("span", null, h("span", { class: "viz-swatch cal--release" }), "Release day"), h("span", null, h("span", { class: "viz-swatch cal--show" }), "Confirmed show"), h("span", null, h("span", { class: "viz-swatch cal--task" }), "Release task")),
      h("div", { class: "cal", role: "group", "aria-label": "Month grid. The same items are listed day by day below." }, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => h("div", { class: "cal__dow" }, d)), cells),
      h("section", { class: "panel agenda" }, h("h2", null, "Day by day"), agenda),
      h("p", { class: "hint" }, "Release days and tasks come from Releases; shows are the confirmed bookings." + (me.manager ? " Enquiries and quotes stay in Bookings until they're confirmed." : "")));
  }

  // ================================================================ CONTACTS (managers only)
  const CONTACT_KINDS = [["promoter", "Promoter"], ["press", "Press"], ["radio", "Radio"], ["venue", "Venue"], ["label", "Label or distributor"], ["other", "Other"]];
  const contactKind = (k) => (CONTACT_KINDS.find((x) => x[0] === k) || ["", "Other"])[1];
  const contactState = { search: "", kind: "" };
  const managersOnly = (title) => show(head(title), h("div", { class: "panel" }, "Contacts are kept by the manager."));

  async function contactsView() {
    if (!me.manager) { managersOnly("Contacts"); return; }
    const search = h("input", { id: "ctSearch", type: "search", placeholder: "Search name, organisation, email or town", value: contactState.search, "aria-label": "Search contacts" });
    const kind = h("select", { id: "ctKind", "aria-label": "Filter by kind" }, h("option", { value: "" }, "Every kind"), CONTACT_KINDS.map(([v, t]) => h("option", { value: v }, t)));
    kind.value = contactState.kind;
    const list = h("div");
    async function load() {
      const rows = await rpc("contacts_list", { p_search: contactState.search, p_kind: contactState.kind || null });
      list.textContent = "";
      if (!rows.length) { list.append(h("div", { class: "panel empty" }, contactState.search || contactState.kind ? "Nobody matches that search." : "No contacts yet. Add the promoters, press, radio and venue people you deal with, or save one straight from a booking.")); return; }
      list.append(h("div", { class: "tablewrap" }, h("table", null,
        h("thead", null, h("tr", null, ["Name", "Organisation", "Kind", "Town", "Email"].map((t) => h("th", null, t)), h("th", { class: "num" }, "Bookings"))),
        h("tbody", null, rows.map((c) => h("tr", { class: "click", onclick: (e) => { if (!e.target.closest("a")) location.hash = "#contact/" + c.id; } },
          h("td", { class: "strong" }, h("a", { class: "plainlink", href: "#contact/" + c.id }, c.name)), h("td", null, c.organisation || ""),
          h("td", null, h("span", { class: "tag" }, contactKind(c.kind))), h("td", null, c.city || ""), h("td", null, c.email || ""), h("td", { class: "num" }, nf(c.bookings))))))));
    }
    let timer;
    search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { contactState.search = search.value; load(); }, 250); });
    kind.addEventListener("change", () => { contactState.kind = kind.value; load(); });
    const create = () => {
      const name = h("input", { id: "ncName", type: "text", maxlength: "120" }), org = h("input", { id: "ncOrg", type: "text", maxlength: "160" });
      const k = h("select", { id: "ncKind" }, CONTACT_KINDS.map(([v, t]) => h("option", { value: v }, t)));
      const out = h("div", { class: "note note--err", role: "status" });
      const go = async () => { try { const id = await rpc("contact_save", { p_id: null, p_fields: { name: name.value, organisation: org.value, kind: k.value } }); dlg.close(); location.hash = "#contact/" + id; } catch (e) { out.textContent = friendly(e); } };
      openDialog(h("h2", null, "Add a contact"), field("Name", name), field("Organisation", org, "Their company, publication, station or venue."), field("Kind", k), out,
        h("div", { class: "form__actions" }, h("button", { class: "btn btn--grad", type: "button", onclick: go }, "Add"), h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Cancel")));
      name.focus();
    };
    show(head("Contacts", h("button", { class: "btn btn--ink btn--sm", onclick: create }, "Add a contact")),
      h("div", { class: "toolbar" }, search, kind), list,
      h("p", { class: "hint", style: "margin-top:14px" }, "Only managers can see contacts. Fans are kept separately, in Fans."));
    await load();
  }

  async function contactView(id) {
    if (!me.manager) { managersOnly("Contacts"); return; }
    const data = await rpc("contact_get", { p_id: id });
    if (!data) { show(h("a", { class: "back", href: "#contacts" }, "← All contacts"), h("div", { class: "panel" }, "That contact no longer exists.")); return; }
    const c = data.contact, reload = () => contactView(id);
    const inp = (k, type, extra) => h("input", { id: "ct-" + k, type: type || "text", value: c[k] == null ? "" : c[k], ...(extra || {}) });
    const f = { name: inp("name"), organisation: inp("organisation"), job_title: inp("job_title", "text", { placeholder: "e.g. Music editor, Booker" }), email: inp("email", "email"),
      phone: inp("phone", "tel"), city: inp("city"), website: inp("website", "url", { placeholder: "https://…" }),
      kind: h("select", { id: "ct-kind" }, CONTACT_KINDS.map(([v, t]) => h("option", { value: v }, t))) };
    f.kind.value = c.kind;
    const save = async () => { try { await rpc("contact_save", { p_id: id, p_fields: Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])) }); toast("Saved"); reload(); } catch (e) { toast(friendly(e), true); } };
    const note = h("textarea", { id: "ctNote", style: "min-height:70px", placeholder: "Add a note: a call, what you sent them, what they said…", "aria-label": "New note" });
    const addNote = async () => { try { await rpc("contact_note_add", { p_id: id, p_body: note.value }); toast("Note added"); reload(); } catch (e) { toast(friendly(e), true); } };
    const stageTag = (s) => h("span", { class: "tag tag--" + (s === "confirmed" ? "live" : s === "played" ? "released" : s === "declined" ? "archived" : "") }, s);

    show(h("a", { class: "back", href: "#contacts" }, "← All contacts"), head(c.name),
      h("section", { class: "panel" }, h("div", { class: "statusbar" },
        h("div", null, h("span", { class: "tag" }, contactKind(c.kind)),
          h("p", { class: "muted", style: "margin-top:8px" }, [c.job_title, c.organisation, c.city].filter(Boolean).join(" · ") || "Added " + fmtDate(c.created_at))),
        h("div", { class: "form__actions" },
          c.email && h("a", { class: "btn btn--soft", href: "mailto:" + c.email }, "Email"),
          c.phone && h("a", { class: "btn btn--soft", href: "tel:" + c.phone.replace(/[^\d+]/g, "") }, "Call")))),
      kpiStrip([
        { label: "Kind", value: contactKind(c.kind), sub: c.organisation || "no organisation" },
        { label: "Bookings", value: nf(data.bookings.length), sub: data.bookings.length ? "linked to them" : "none linked yet" },
        { label: "Notes", value: nf(data.notes.length), sub: data.notes.length ? "last " + ago(data.notes[0].created_at).toLowerCase() : "none yet" },
        { label: "In contacts since", value: fmtDate(c.created_at), sub: c.city || "no town given" },
      ]),
      h("div", { class: "compose" },
        h("div", null,
          h("section", { class: "panel" }, h("h2", null, "Details"),
            h("div", { class: "grid2" }, field("Name", f.name), field("Kind", f.kind), field("Organisation", f.organisation), field("Role", f.job_title),
              field("Email", f.email), field("Phone", f.phone), field("Town or city", f.city), field("Website", f.website)),
            h("div", { class: "form__actions" }, h("button", { class: "btn btn--grad", type: "button", onclick: save }, "Save changes"),
              h("button", { class: "btn btn--danger btn--sm", type: "button", style: "margin-left:auto", onclick: () => confirmBox("Delete this contact?", "Their details and notes will be removed for good. Their bookings stay in Bookings.", "Delete for good",
                async () => { try { await rpc("contact_delete", { p_id: id }); toast("Deleted"); location.hash = "#contacts"; } catch (e) { toast(friendly(e), true); } }) }, "Delete"))),
          h("section", { class: "panel" }, h("h2", null, "Bookings"),
            data.bookings.length ? data.bookings.map((b) => h("div", { class: "row" },
              h("div", { class: "row__main" }, h("a", { href: "#booking/" + b.id }, b.event_name), h("div", { class: "muted" }, [b.event_date ? fmtDay(b.event_date) : "No date yet", b.city].filter(Boolean).join(" · "))),
              h("div", { class: "row__side" }, stageTag(b.status))))
              : h("p", { class: "muted" }, "No bookings linked yet. Open a booking and use “Save to contacts” to link it here."))),
        h("div", null,
          h("section", { class: "panel" }, h("h2", null, "Notes"), note,
            h("div", { class: "form__actions", style: "margin:10px 0 6px" }, h("button", { class: "btn btn--ink btn--sm", type: "button", onclick: addNote }, "Add note")),
            data.notes.length ? data.notes.map((n) => h("div", { class: "row" }, h("div", { class: "row__main" }, h("div", { style: "white-space:pre-wrap" }, n.body), h("div", { class: "muted" }, n.author + " · " + fmtDate(n.created_at)))))
              : h("p", { class: "muted" }, "No notes yet. Notes build into a history of your dealings with this person.")))));
  }

  // ================================================================ STATS
  const SVGNS = "http://www.w3.org/2000/svg";
  const sv = (tag, attrs, ...kids) => { const el = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v); kids.flat().forEach((c) => c != null && el.append(c.nodeType ? c : String(c))); return el; };
  const compact = (n) => n == null ? "–" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M" : n >= 1e4 ? Math.round(n / 1e3) + "K" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : nf(n);
  const shortDay = (s) => day(s).toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
  // A y-axis that ends on a round number, with 3 or 4 steps.
  function niceScale(max) {
    if (max <= 0) return { top: 4, step: 1 };
    const rough = max / 4, mag = Math.pow(10, Math.floor(Math.log10(rough))), n = rough / mag;
    const step = Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag);
    return { top: Math.ceil(max / step) * step, step };
  }
  // Draws into `box` at its real pixel width, and again whenever that width changes,
  // so text stays a readable size on a phone.
  function responsive(box, draw) {
    let last = 0;
    const run = () => { const w = box.clientWidth; if (w && w !== last) { last = w; draw(w); } };
    // Draw as soon as the box is on the page (it has no width before that), and again on
    // any size change. The timers cover browsers that hold back resize notices for a
    // tab that isn't being painted.
    new ResizeObserver(run).observe(box); window.addEventListener("resize", run);
    run(); setTimeout(run, 0); setTimeout(run, 300);
  }
  function tooltipFor(box) {
    const tip = h("div", { class: "viz-tip", role: "status" }); box.append(tip);
    return {
      show(x, y, ...kids) { tip.textContent = ""; tip.append(...kids.flat()); tip.style.display = "block";
        const w = tip.offsetWidth, max = box.clientWidth; tip.style.left = Math.max(0, Math.min(max - w, x - w / 2)) + "px"; tip.style.top = Math.max(0, y - tip.offsetHeight - 12) + "px"; },
      hide() { tip.style.display = "none"; },
    };
  }
  const tableView = (headers, rows) => h("details", { class: "viz-table" }, h("summary", null, "Show as a table"),
    h("div", { class: "tablewrap" }, h("table", null, h("thead", null, h("tr", null, headers.map((t, i) => h("th", { class: i ? "num" : "" }, t)))),
      h("tbody", null, rows.map((r) => h("tr", null, r.map((c, i) => h("td", { class: i ? "num" : "" }, c))))))));

  // One series over time: a line with a light wash under it.
  function lineChart(points, label) {
    const box = h("div", { class: "viz", role: "img", "aria-label": `${label}: ${nf(points[0].n)} on ${shortDay(points[0].d)}, ${nf(points[points.length - 1].n)} on ${shortDay(points[points.length - 1].d)}` });
    responsive(box, (W) => {
      box.textContent = "";
      const H = 240, m = { l: 44, r: 54, t: 14, b: 28 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
      const { top, step } = niceScale(Math.max(...points.map((p) => p.n)));
      const x = (i) => m.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw), y = (v) => m.t + ih - (v / top) * ih;
      const svg = sv("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
      for (let v = 0; v <= top; v += step) svg.append(sv("line", { x1: m.l, x2: m.l + iw, y1: y(v), y2: y(v), class: v === 0 ? "viz-axis" : "viz-grid" }), sv("text", { x: m.l - 8, y: y(v) + 4, class: "viz-tick", "text-anchor": "end" }, compact(v)));
      const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(iw / 90))));
      points.forEach((p, i) => { if (i % every === 0 && i < points.length - every / 2) svg.append(sv("text", { x: x(i), y: H - 8, class: "viz-tick", "text-anchor": i === 0 ? "start" : "middle" }, shortDay(p.d))); });
      const path = points.map((p, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p.n).toFixed(1)).join(" ");
      svg.append(sv("path", { d: `${path} L ${x(points.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`, class: "viz-area" }), sv("path", { d: path, class: "viz-line" }));
      const lastP = points[points.length - 1];
      svg.append(sv("circle", { cx: x(points.length - 1), cy: y(lastP.n), r: 5, class: "viz-dot" }), sv("text", { x: x(points.length - 1) + 10, y: y(lastP.n) + 4, class: "viz-endlabel" }, compact(lastP.n)));
      const cross = sv("line", { y1: m.t, y2: m.t + ih, class: "viz-cross", visibility: "hidden" }), hot = sv("circle", { r: 5, class: "viz-dot", visibility: "hidden" });
      svg.append(cross, hot); box.append(svg);
      const tip = tooltipFor(box);
      const move = (e) => {
        const r = svg.getBoundingClientRect(), px = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
        const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - m.l) / iw) * (points.length - 1)))), p = points[i];
        cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
        hot.setAttribute("cx", x(i)); hot.setAttribute("cy", y(p.n)); hot.setAttribute("visibility", "visible");
        tip.show(x(i), y(p.n), h("b", null, nf(p.n)), " " + label.toLowerCase(), h("div", { class: "viz-tip__sub" }, fmtDay(p.d)));
      };
      const out = () => { cross.setAttribute("visibility", "hidden"); hot.setAttribute("visibility", "hidden"); tip.hide(); };
      svg.addEventListener("mousemove", move); svg.addEventListener("touchstart", move, { passive: true }); svg.addEventListener("touchmove", move, { passive: true }); svg.addEventListener("mouseleave", out);
    });
    return box;
  }

  // Parts of a whole per period: stacked columns. Colours are fixed per series (they
  // were checked for colour-blind separation), never reassigned by rank.
  const SERIES = [["website", "Website", "#2a78d6"], ["qr", "QR drops", "#eb6834"], ["import", "Imported", "#1baf7a"]];
  function stackedColumns(weeks) {
    const box = h("div", { class: "viz", role: "img", "aria-label": "New fans each week, by how they joined. Use the table below for exact numbers." });
    responsive(box, (W) => {
      box.textContent = "";
      const H = 240, m = { l: 44, r: 12, t: 14, b: 28 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
      const total = (w) => SERIES.reduce((s, [k]) => s + w[k], 0), { top, step } = niceScale(Math.max(1, ...weeks.map(total)));
      const band = iw / weeks.length, bw = Math.max(3, Math.min(24, band - 4)), y = (v) => m.t + ih - (v / top) * ih;
      const svg = sv("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
      for (let v = 0; v <= top; v += step) svg.append(sv("line", { x1: m.l, x2: m.l + iw, y1: y(v), y2: y(v), class: v === 0 ? "viz-axis" : "viz-grid" }), sv("text", { x: m.l - 8, y: y(v) + 4, class: "viz-tick", "text-anchor": "end" }, compact(v)));
      const every = Math.max(1, Math.ceil(weeks.length / Math.max(2, Math.floor(iw / 80))));
      const tip = tooltipFor(box);
      weeks.forEach((w, i) => {
        const cx = m.l + band * i + band / 2, x0 = cx - bw / 2; let base = 0;
        const parts = SERIES.filter(([k]) => w[k] > 0), g = sv("g", { class: "viz-col" });
        parts.forEach(([k, , color], pi) => {
          const y1 = y(base), y0 = y(base + w[k]); base += w[k];
          // 2px gap between segments; only the top segment gets rounded corners
          const hgt = Math.max(1, y1 - y0 - (pi < parts.length - 1 ? 2 : 0)), topY = y1 - hgt, r = pi === parts.length - 1 ? Math.min(4, bw / 2, hgt) : 0;
          g.append(sv("path", { fill: color, d: `M${x0} ${y1} V${topY + r} Q${x0} ${topY} ${x0 + r} ${topY} H${x0 + bw - r} Q${x0 + bw} ${topY} ${x0 + bw} ${topY + r} V${y1} Z` }));
        });
        // a full-height, full-band hit area so thin or empty columns are still easy to point at
        const hit = sv("rect", { x: m.l + band * i, y: m.t, width: band, height: ih, fill: "transparent" });
        const showTip = () => { g.classList.add("is-hot"); tip.show(cx, y(total(w)), h("b", null, "Week of " + shortDay(w.w)),
          SERIES.map(([k, name, color]) => h("div", { class: "viz-tip__row" }, h("span", { class: "viz-swatch", style: "background:" + color }), name, h("b", null, nf(w[k])))),
          h("div", { class: "viz-tip__row viz-tip__total" }, "Total", h("b", null, nf(total(w))))); };
        hit.addEventListener("mouseenter", showTip); hit.addEventListener("touchstart", showTip, { passive: true });
        hit.addEventListener("mouseleave", () => { g.classList.remove("is-hot"); tip.hide(); });
        svg.append(g, hit);
        if (i % every === 0) svg.append(sv("text", { x: cx, y: H - 8, class: "viz-tick", "text-anchor": "middle" }, shortDay(w.w)));
      });
      box.append(svg);
    });
    return box;
  }
  function sparkline(points) {
    if (points.length < 2) return null;
    const W = 120, H = 32, vs = points.map((p) => p.v), lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
    const x = (i) => 3 + (i / (points.length - 1)) * (W - 6), y = (v) => H - 4 - ((v - lo) / span) * (H - 8);
    return sv("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "viz-spark", "aria-hidden": "true" },
      sv("path", { d: points.map((p, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p.v).toFixed(1)).join(" "), class: "viz-sparkline" }),
      sv("circle", { cx: x(points.length - 1), cy: y(vs[vs.length - 1]), r: 3, class: "viz-sparkdot" }));
  }
  // Up-is-good unless told otherwise; the arrow and words carry the meaning, not colour alone.
  function delta(now, before, upIsGood = true, since = "") {
    if (before == null || (now === 0 && before === 0)) return h("span", { class: "delta" }, "No earlier period to compare");
    const diff = now - before, up = diff > 0, good = diff === 0 ? null : up === upIsGood;
    return h("span", { class: "delta" + (good == null ? "" : good ? " delta--good" : " delta--bad") }, diff === 0 ? "No change" : `${up ? "▲" : "▼"} ${nf(Math.abs(diff))} ${since ? (up ? "up " : "down ") + since : (up ? "more" : "fewer") + " than the period before"}`);
  }

  const METRICS = [
    ["youtube_views", "YouTube views", "On the homepage · fetched automatically once connected"],
    ["streams_total", "Total streams, all services", "On the homepage · typed in"],
    ["social_followers", "Social followers (FB + IG + TikTok)", "On the homepage · typed in"],
    ["spotify_monthly_listeners", "Spotify monthly listeners", "Typed in"],
    ["spotify_followers", "Spotify followers", "Fetched automatically once connected"],
    ["youtube_subscribers", "YouTube subscribers", "Fetched automatically once connected"],
    ["instagram_followers", "Instagram followers", "Typed in"], ["tiktok_followers", "TikTok followers", "Typed in"], ["facebook_followers", "Facebook followers", "Typed in"],
  ];
  const statsState = { tab: "overview", days: 90 };

  async function statsView() {
    const seg = (t, label) => h("button", { class: "seg" + (statsState.tab === t ? " seg--on" : ""), "aria-pressed": String(statsState.tab === t), onclick: () => { statsState.tab = t; statsView(); } }, label);
    const tabs = h("div", { class: "segs", role: "group", "aria-label": "Which stats" }, seg("overview", "Overview"), seg("public", "Public numbers"), seg("map", "Fan map"));
    if (statsState.tab === "public") return publicNumbers(tabs);
    if (statsState.tab === "map") return fanMap(tabs);

    const d = await rpc("stats_overview", { p_days: statsState.days });
    const period = h("select", { id: "stDays", class: "select--sm", "aria-label": "Time period" }, [[30, "Last 30 days"], [90, "Last 90 days"], [365, "Last 12 months"]].map(([v, t]) => h("option", { value: v }, t)));
    period.value = statsState.days; period.addEventListener("change", () => { statsState.days = Number(period.value); statsView(); });
    const t = d.tiles, statTile = (label, pair, upIsGood) => h("div", { class: "tile" }, h("div", { class: "tile__cap" }, label), h("div", { class: "tile__num" }, nf(pair[0])), delta(pair[0], pair[1], upIsGood));
    const anyNew = d.new_by_week.some((w) => w.website + w.qr + w.import > 0);
    show(head("Stats", period), tabs,
      DEV && h("div", { class: "banner" }, h("b", null, "Test mode. "), "These numbers come from invented demo data."),
      h("div", { class: "tiles tiles--5" },
        h("div", { class: "tile" }, h("div", { class: "tile__cap" }, "Fans on the list"), h("div", { class: "tile__num" }, nf(t.fans_total)), h("span", { class: "delta" }, "Subscribed right now")),
        statTile("New fans", t.new_fans), statTile("QR signups", t.qr_signups), statTile("Smart link clicks", t.link_clicks), statTile("Unsubscribes", t.unsubscribes, false)),
      h("section", { class: "panel" }, h("h2", null, "Fans who have joined the list"),
        h("p", { class: "muted", style: "margin:-8px 0 12px" }, `Everyone who had signed up by each day, ${shortDay(d.from)} to ${shortDay(d.to)}. It includes people who later unsubscribed.`),
        lineChart(d.fans_by_day, "Fans joined"),
        tableView(["Day", "Fans joined so far"], d.fans_by_day.filter((_, i, a) => i % Math.ceil(a.length / 15) === 0 || i === a.length - 1).map((p) => [fmtDay(p.d), nf(p.n)]))),
      h("section", { class: "panel" }, h("h2", null, "New fans each week, by how they joined"),
        h("div", { class: "viz-legend" }, SERIES.map(([, name, color]) => h("span", null, h("span", { class: "viz-swatch", style: "background:" + color }), name))),
        anyNew ? stackedColumns(d.new_by_week) : h("p", { class: "muted", style: "padding:24px 0" }, "Nobody joined in this period."),
        tableView(["Week of", "Website", "QR drops", "Imported", "Total"], d.new_by_week.map((w) => [shortDay(w.w), nf(w.website), nf(w.qr), nf(w.import), nf(w.website + w.qr + w.import)]))));
  }

  async function publicNumbers(tabs) {
    const m = await rpc("stats_metrics");
    const metric = h("select", { id: "spMetric" }, METRICS.map(([k, name]) => h("option", { value: k }, name)));
    const value = h("input", { id: "spValue", type: "text", inputmode: "numeric", placeholder: "e.g. 5,200,000" });
    const when = h("input", { id: "spDate", type: "date" });
    const save = async () => {
      const n = Number(value.value.replace(/[,\s]/g, ""));
      if (!value.value.trim() || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) { toast("Enter a whole number, like 5200000.", true); return; }
      try { await rpc("stat_point_save", { p_metric: metric.value, p_value: n, p_date: when.value || null }); toast("Saved"); statsView(); } catch (e) { toast(friendly(e), true); }
    };
    show(head("Stats"), tabs,
      DEV && h("div", { class: "banner" }, h("b", null, "Test mode. "), "These figures are invented."),
      h("div", { class: "metrics" }, METRICS.map(([k, name, how]) => {
        const info = m[k], latest = info && info.latest;
        return h("div", { class: "tile" }, h("div", { class: "tile__cap" }, name),
          h("div", { class: "metric__row" }, h("div", { class: "tile__num" }, latest ? compact(latest.value) : "–"), info ? sparkline(info.points) : null),
          latest ? [h("div", { class: "muted", style: "font-size:13px" }, `${nf(latest.value)} on ${fmtDay(latest.taken_on)}`),
            info.before ? delta(latest.value, info.before.value, true, "since " + shortDay(info.before.taken_on)) : h("span", { class: "delta" }, "No earlier figure to compare")]
            : h("span", { class: "delta" }, "Not entered yet"),
          h("div", { class: "hint" }, how));
      })),
      me.manager && h("section", { class: "panel" }, h("h2", null, "Enter a number"),
        h("p", { class: "muted", style: "margin:-8px 0 12px" }, "Type the current figure from each service's own stats page. Entering one a month is enough to build up the trend. The three marked “on the homepage” update the public site."),
        h("div", { class: "grid3" }, field("Which number", metric), field("Value", value), field("As of", when, "Leave blank for today.")),
        h("div", { class: "form__actions" }, h("button", { class: "btn btn--ink", onclick: save }, "Save"))));
  }

  // Approximate centres of towns and cities, for placing dots. Anything not listed
  // still appears in the table beside the map.
  const PLACES = { wellington: [-41.29, 174.78], porirua: [-41.13, 174.84], "lower hutt": [-41.21, 174.9], "upper hutt": [-41.12, 175.07], kapiti: [-40.9, 175.0], paraparaumu: [-40.91, 175.0],
    auckland: [-36.85, 174.76], manukau: [-36.99, 174.88], "south auckland": [-37.0, 174.87], "west auckland": [-36.88, 174.63], "north shore": [-36.8, 174.75], otara: [-36.96, 174.87], mangere: [-36.97, 174.8],
    hamilton: [-37.79, 175.28], tauranga: [-37.69, 176.17], "mount maunganui": [-37.64, 176.19], rotorua: [-38.14, 176.25], taupo: [-38.69, 176.07], whangarei: [-35.73, 174.32], gisborne: [-38.66, 178.02],
    napier: [-39.49, 176.92], hastings: [-39.64, 176.84], "new plymouth": [-39.06, 174.08], whanganui: [-39.93, 175.05], "palmerston north": [-40.35, 175.61], levin: [-40.62, 175.28], masterton: [-40.95, 175.66],
    nelson: [-41.27, 173.28], blenheim: [-41.51, 173.95], christchurch: [-43.53, 172.64], timaru: [-44.4, 171.25], dunedin: [-45.87, 170.5], queenstown: [-45.03, 168.66], invercargill: [-46.41, 168.35], tokoroa: [-38.22, 175.87],
    sydney: [-33.87, 151.21], melbourne: [-37.81, 144.96], brisbane: [-27.47, 153.03], "gold coast": [-28.02, 153.4], perth: [-31.95, 115.86],
    apia: [-13.83, -171.77], "nuku'alofa": [-21.14, -175.2], nukualofa: [-21.14, -175.2], suva: [-18.14, 178.44], honolulu: [21.31, -157.86], "los angeles": [34.05, -118.24] };
  let leafletLoading = null;
  const loadLeaflet = () => leafletLoading || (leafletLoading = new Promise((resolve, reject) => {
    if (window.L) return resolve();
    document.head.append(h("link", { rel: "stylesheet", href: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" }));
    const s = h("script", { src: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" }); s.onload = resolve; s.onerror = () => { leafletLoading = null; reject(new Error("map")); };
    document.head.append(s);
  }));

  async function fanMap(tabs) {
    const d = await rpc("fans_by_city");
    const placed = d.cities.filter((c) => PLACES[c.key]), missing = d.cities.filter((c) => !PLACES[c.key]);
    const mapBox = h("div", { class: "fanmap", role: "img", "aria-label": "Map of fans by town. The same numbers are in the table below." });
    show(head("Stats"), tabs,
      DEV && h("div", { class: "banner" }, h("b", null, "Test mode. "), "These fans are invented."),
      h("section", { class: "panel" }, h("h2", null, "Where the fans are"),
        h("p", { class: "muted", style: "margin:-8px 0 12px" }, `${nf(d.placed)} subscribed fans gave a town. ${nf(d.unplaced)} didn't, so they aren't counted here. Bigger dots mean more fans.`),
        d.cities.length ? mapBox : h("p", { class: "muted" }, "No fans have given a town yet. The QR signup page asks for one."),
        missing.length ? h("p", { class: "hint", style: "margin-top:10px" }, "Not on the map (town not recognised): " + missing.slice(0, 12).map((c) => `${c.city} (${nf(c.fans)})`).join(", ") + (missing.length > 12 ? "…" : "") + ". They're still in the table.") : null),
      d.cities.length ? h("section", { class: "panel" }, h("h2", null, "Towns, by number of fans"),
        h("div", { class: "tablewrap" }, h("table", null, h("thead", null, h("tr", null, h("th", null, "Town"), h("th", { class: "num" }, "Fans"), h("th", { class: "num" }, "From QR drops"), h("th", { class: "num" }, "Share"))),
          h("tbody", null, d.cities.map((c) => h("tr", null, h("td", { class: "strong" }, c.city), h("td", { class: "num" }, nf(c.fans)), h("td", { class: "num" }, nf(c.qr_signups)), h("td", { class: "num" }, pct(c.fans, d.placed)))))))) : null);
    if (!placed.length) { if (d.cities.length) mapBox.replaceWith(h("p", { class: "muted" }, "None of these towns could be placed on the map. See the table below.")); return; }
    try {
      await loadLeaflet();
      const map = window.L.map(mapBox, { scrollWheelZoom: false, attributionControl: true });
      window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 12, attribution: "© OpenStreetMap contributors" }).addTo(map);
      const top = Math.max(...placed.map((c) => c.fans));
      const marks = placed.map((c) => window.L.circleMarker(PLACES[c.key], { radius: 7 + 20 * Math.sqrt(c.fans / top), color: "#fff", weight: 2, fillColor: "#e8367d", fillOpacity: 0.75 })
        .bindTooltip(`<b>${c.city.replace(/[<&]/g, "")}</b><br>${nf(c.fans)} ${c.fans === 1 ? "fan" : "fans"}` + (c.qr_signups ? ` · ${nf(c.qr_signups)} from QR drops` : "")).addTo(map));
      map.fitBounds(window.L.featureGroup(marks).getBounds().pad(0.25), { maxZoom: 8 });
    } catch (_) { mapBox.replaceWith(h("p", { class: "muted" }, "The map couldn't load (it needs an internet connection). The table below has the same numbers.")); }
  }

  // ================================================================ PRESS KIT
  async function pressView() {
    const [docs, links] = await Promise.all([rpc("press_docs_list"), rpc("press_links_list")]);
    const pageUrl = new URL("../../press/", location.href).href, ro = !me.manager;
    const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); toast(msg || "Copied"); } catch (_) { toast("Couldn't copy. Select the text instead.", true); } };

    const title = h("input", { id: "pdTitle", type: "text", maxlength: "120", placeholder: "e.g. Technical rider" });
    const file = h("input", { id: "pdFile", type: "file", accept: ".pdf,application/pdf,image/*" });
    const addDoc = async (e) => {
      if (!title.value.trim()) { toast("Give the document a name first.", true); return; }
      if (!file.files[0]) { toast("Choose a file to upload.", true); return; }
      e.target.disabled = true;
      try { const path = await upload("press", "docs", file.files[0]); await rpc("press_doc_save", { p_id: null, p_title: title.value, p_path: path }); toast("Document added"); pressView(); }
      catch (err) { e.target.disabled = false; toast(err.status === 413 ? "That file is too big." : friendly(err), true); }
    };

    const label = h("input", { id: "plLabel", type: "text", maxlength: "120", placeholder: "Who is it for? e.g. Summer Sounds, Tane" });
    const days = h("select", { id: "plDays", "aria-label": "How long the link works" }, [[14, "Works for 2 weeks"], [60, "Works for 2 months"], [180, "Works for 6 months"]].map(([v, t]) => h("option", { value: v }, t)));
    days.value = "60";
    const makeLink = async () => {
      try {
        const secret = await rpc("press_link_create", { p_label: label.value, p_days: Number(days.value) });
        const url = pageUrl + "#" + secret;
        // The secret can't be looked up again later, so show it now with a clear way to copy it.
        openDialog(h("h2", null, "Promoter link ready"),
          h("p", { class: "muted" }, "Send this to the promoter. It's shown once only: if you lose it, switch this one off and make another."),
          h("div", { id: "newPromoterLink", class: "qr__link", style: "background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px;margin:14px 0;font-size:13.5px" }, url),
          h("div", { class: "form__actions" }, h("button", { class: "btn btn--grad", type: "button", onclick: () => copy(url, "Link copied") }, "Copy link"),
            h("button", { class: "btn btn--soft", type: "button", onclick: () => { dlg.close(); pressView(); } }, "Done")));
      } catch (e) { toast(friendly(e), true); }
    };

    show(head("Press kit", h("a", { class: "btn btn--soft btn--sm", href: pageUrl, target: "_blank", rel: "noopener" }, "View press page"),
        h("button", { class: "btn btn--ink btn--sm", onclick: () => copy(pageUrl, "Press page link copied") }, "Copy page link")),
      h("section", { class: "panel" }, h("h2", null, "The public page"),
        h("p", { class: "muted" }, "Anyone can see the bio, numbers, awards, press photos, logos and recent coverage. Coverage comes from the News list in the Website tab, so it stays current. The bio, photos and numbers are part of the site itself and are changed by whoever maintains it.")),
      h("section", { class: "panel" }, h("h2", null, "Private documents"),
        h("p", { class: "muted", style: "margin:-6px 0 8px" }, "Riders and anything else that's only for promoters you choose. They never appear on the public page."),
        docs.length ? docs.map((d) => h("div", { class: "row" },
          h("div", { class: "row__main" }, h("div", { class: "strong" }, d.title), h("div", { class: "muted" }, "Added " + fmtDate(d.created_at))),
          h("div", { class: "row__side" }, !ro && h("button", { class: "btn btn--danger btn--sm", "aria-label": "Remove " + d.title,
            onclick: () => confirmBox(`Remove “${d.title}”?`, "Promoters with a link will no longer see it.", "Remove", async () => { try { await rpc("press_doc_delete", { p_id: d.id }); toast("Removed"); pressView(); } catch (e) { toast(friendly(e), true); } }) }, "Remove"))))
          : h("p", { class: "muted" }, "No private documents yet."),
        !ro && h("div", { class: "grid2", style: "margin-top:16px" }, field("Document name", title), field("File (PDF)", file)),
        !ro && h("div", { class: "form__actions" }, h("button", { class: "btn btn--ink", onclick: addDoc }, "Add document"))),
      h("section", { class: "panel" }, h("h2", null, "Promoter links"),
        h("p", { class: "muted", style: "margin:-6px 0 8px" }, "A promoter link opens the press page with the private documents unlocked. Make one per promoter so you can see who has opened theirs and switch any of them off."),
        links.length ? links.map((l) => h("div", { class: "row" },
          h("div", { class: "row__main" }, h("div", { class: "strong" }, l.label),
            h("div", { class: "muted" }, (l.opens ? `Opened ${nf(l.opens)} ${l.opens === 1 ? "time" : "times"}, last ${fmtDate(l.last_opened_at)}` : "Not opened yet")
              + (l.state === "on" ? " · works until " + fmtDate(l.expires_at) : ""))),
          h("div", { class: "row__side" }, h("span", { class: "tag " + (l.state === "on" ? "tag--released" : "tag--archived") }, l.state),
            !ro && l.state === "on" && h("button", { class: "btn btn--soft btn--sm", "aria-label": "Switch off the link for " + l.label,
              onclick: () => confirmBox("Switch this link off?", `“${l.label}” will stop working straight away. This can't be undone; you'd make a new link.`, "Switch off",
                async () => { try { await rpc("press_link_revoke", { p_id: l.id }); toast("Link switched off"); pressView(); } catch (e) { toast(friendly(e), true); } }) }, "Switch off"))))
          : h("p", { class: "muted" }, "No promoter links yet."),
        !ro && h("div", { class: "addrow addrow--3" }, label, days, h("button", { class: "btn btn--ink", onclick: makeLink }, "Make link")),
        !ro && !docs.length && h("p", { class: "hint", style: "margin-top:10px" }, "Add a private document first, or the link will have nothing to unlock.")));
  }

  // ================================================================ WEBSITE (events & news)
  // Saves go through the website editor's backend, which holds the key to the site's
  // repo. It accepts a manager's Control Centre login, so there is no separate password.
  const SITE_FIELDS = {
    events: [
      { k: "name", label: "Event name" },
      { k: "eyebrow", label: "Tag above the name", hint: "e.g. Upcoming · Friday" },
      { k: "date_display", label: "Date, as shown", hint: "e.g. 19–20 February 2027" },
      { k: "venue", label: "Venue and city" },
      { k: "lineup", label: "Lineup or description", type: "textarea" },
      { k: "poster", label: "Poster image", type: "image" },
      { k: "poster_alt", label: "Poster description", hint: "Read aloud to people using a screen reader." },
      { k: "tickets_url", label: "Ticket link", hint: "Leave blank to show “Tickets on sale soon”." },
    ],
    news: [
      { k: "label", label: "Tag", hint: "e.g. 2026 · Awards" },
      { k: "headline", label: "Headline" },
      { k: "summary", label: "One-line summary", type: "textarea" },
      { k: "source", label: "Source name", hint: "e.g. RNZ, Rolling Stone" },
      { k: "link", label: "Article link" },
      { k: "image", label: "Image", type: "image" },
      { k: "image_alt", label: "Image description", hint: "Read aloud to people using a screen reader." },
    ],
  };
  const siteState = { tab: "events", data: { events: null, news: null }, dirty: { events: false, news: false } };
  async function editorCall(path, body) {
    const r = await fetch(cfg.editor + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || "Request failed"); e.status = r.status; throw e; }
    return j;
  }
  // Shrinks a photo in the browser before upload, so pages stay fast.
  function downscale(file, max = 1400) {
    return new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => { const img = new Image(); img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement("canvas");
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); resolve(c.toDataURL("image/jpeg", 0.85));
      }; img.onerror = reject; img.src = rd.result; };
      rd.onerror = reject; rd.readAsDataURL(file);
    });
  }
  const siteImg = (v) => !v ? "" : /^https?:\/\//.test(v) ? v : new URL("../../" + v, location.href).href;
  const siteErr = (e) => e.status === 401 ? "Only a manager can change the website." : (e.message && e.message.length < 140 ? e.message : "Something went wrong. Please try again.");

  async function siteView() {
    if (!cfg.editor) { show(head("Website"), h("div", { class: "panel" }, "The website editor isn't connected.")); return; }
    // Drafts belong to whoever made them: start clean if a different person has logged in.
    if (siteState.user !== me.user_id) { siteState.user = me.user_id; siteState.data = { events: null, news: null }; siteState.dirty = { events: false, news: false }; }
    const type = siteState.tab, ro = !me.manager;
    if (!siteState.data[type]) {
      if (ro) {
        // Artists can't use the editor backend, so show them what's published.
        const file = type === "events" ? "art-events.json" : "art-news.json";
        siteState.data[type] = (await fetch(new URL("../../data/" + file, location.href), { cache: "no-store" }).then((r) => r.json()))[type] || [];
      } else siteState.data[type] = (await editorCall("/api/load", { type }))[type] || [];
    }
    const items = siteState.data[type], noun = type === "events" ? "event" : "article";
    const redraw = () => siteView();
    const touch = () => { siteState.dirty[type] = true; status.textContent = "Unsaved changes"; status.className = "savebar__status"; };
    const status = h("span", { class: "savebar__status", role: "status" }, siteState.dirty[type] ? "Unsaved changes" : "");

    const fieldRow = (item, f, i) => {
      const id = `site-${type}-${i}-${f.k}`;
      if (f.type === "image") {
        const file = h("input", { id, type: "file", accept: "image/*", disabled: ro });
        const stat = h("div", { class: "hint" }, item[f.k] ? "" : "No image yet.");
        const thumb = item[f.k] ? h("img", { src: siteImg(item[f.k]), alt: "" }) : h("div", { class: "ph" });
        file.addEventListener("change", async () => {
          if (!file.files[0]) return; stat.textContent = "Uploading…";
          try { const j = await editorCall("/api/upload", { filename: (file.files[0].name.replace(/\.[^.]+$/, "") || "image") + ".jpg", dataBase64: await downscale(file.files[0]) }); item[f.k] = j.path; touch(); redraw(); }
          catch (e) { stat.textContent = siteErr(e); }
        });
        return h("div", { class: "field" }, h("label", { for: id }, f.label), h("div", { class: "filebox filebox--wide" }, thumb, h("div", null, file, stat)));
      }
      const input = f.type === "textarea" ? h("textarea", { id, disabled: ro, style: "min-height:80px" }) : h("input", { id, type: "text", disabled: ro });
      input.value = item[f.k] || "";
      input.addEventListener("input", () => { item[f.k] = input.value; touch(); });
      return field(f.label, input, f.hint);
    };
    const card = (item, i) => h("section", { class: "panel" },
      h("div", { class: "statusbar", style: "margin-bottom:14px" },
        h("h2", { style: "margin:0" }, item.name || item.headline || `New ${noun}`),
        !ro && h("div", { class: "form__actions" },
          h("button", { class: "btn btn--soft btn--sm", disabled: i === 0, "aria-label": "Move up", onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; touch(); redraw(); } }, "↑"),
          h("button", { class: "btn btn--soft btn--sm", disabled: i === items.length - 1, "aria-label": "Move down", onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; touch(); redraw(); } }, "↓"),
          h("button", { class: "btn btn--danger btn--sm", onclick: () => confirmBox(`Remove this ${noun}?`, "It comes off the website when you publish.", "Remove", async () => { items.splice(i, 1); touch(); redraw(); }) }, "Remove"))),
      SITE_FIELDS[type].map((f) => fieldRow(item, f, i)));

    // auto-fill: a poster for events, an article link for news
    let assist = null;
    if (!ro && type === "events") {
      const file = h("input", { id: "assistPoster", type: "file", accept: "image/*" });
      const note = h("div", { class: "hint" }, "Uploads the poster and fills in what it can read. Check everything before publishing.");
      file.addEventListener("change", async () => {
        if (!file.files[0]) return; note.textContent = "Reading the poster…";
        try { const j = await editorCall("/api/parse-poster", { filename: file.files[0].name, dataBase64: await downscale(file.files[0]) }); const ai = j._ai; delete j._ai; items.unshift(j); touch(); redraw(); toast(ai ? "Poster added. Check the details." : "Poster added. Fill in the details."); }
        catch (e) { note.textContent = siteErr(e); }
      });
      assist = h("section", { class: "panel panel--assist" }, h("h2", null, "Add an event from its poster"), file, note);
    } else if (!ro) {
      const link = h("input", { id: "assistLink", type: "url", placeholder: "Paste the article link", "aria-label": "Article link" });
      const note = h("div", { class: "hint" }, "Fills in the headline, summary, source and image from the page. Check everything before publishing.");
      const go = async () => {
        if (!link.value.trim()) return; note.textContent = "Reading the article…";
        try { const j = await editorCall("/api/parse-url", { url: link.value.trim() }); items.unshift({ label: j.label || "", headline: j.headline || "", summary: j.summary || "", source: j.source || "", link: j.link || "", image: j.image || "", image_alt: j.image_alt || "" }); touch(); redraw(); toast("Article added. Check the details."); }
        catch (e) { note.textContent = siteErr(e); }
      };
      link.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      assist = h("section", { class: "panel panel--assist" }, h("h2", null, "Add news from a link"), h("div", { class: "addrow", style: "margin-top:0" }, link, h("button", { class: "btn btn--ink", onclick: go }, "Fill in")), note);
    }

    const publish = async (e) => {
      e.target.disabled = true; status.textContent = "Publishing…";
      try { await editorCall("/api/save", { type, data: { [type]: items } }); siteState.dirty[type] = false; status.textContent = "Published. Live on the site in about a minute."; status.className = "savebar__status savebar__status--ok"; }
      catch (err) { status.textContent = siteErr(err); status.className = "savebar__status savebar__status--err"; }
      e.target.disabled = false;
    };
    const tabBtn = (t, label) => h("button", { class: "seg" + (type === t ? " seg--on" : ""), "aria-pressed": String(type === t), onclick: () => { siteState.tab = t; redraw(); } }, label + (siteState.dirty[t] ? " •" : ""));

    show(head("Website", h("a", { class: "btn btn--soft btn--sm", href: "../../", target: "_blank", rel: "noopener" }, "View the site")),
      h("div", { class: "segs", role: "group", "aria-label": "What to edit" }, tabBtn("events", "Events"), tabBtn("news", "News")),
      ro && h("p", { class: "muted", style: "margin-bottom:14px" }, "This is what's on the website now. The manager makes changes."),
      assist,
      items.length ? items.map(card) : h("div", { class: "panel empty" }, `No ${type} on the website yet.`),
      !ro && h("button", { class: "addbtn", onclick: () => { items.unshift({}); touch(); redraw(); window.scrollTo(0, 0); } }, `+ Add a blank ${noun}`),
      !ro && h("div", { class: "sendbar" }, h("button", { class: "btn btn--grad", onclick: publish }, "Save and publish"), status));
  }
  window.addEventListener("beforeunload", (e) => { if (siteState.dirty.events || siteState.dirty.news) { e.preventDefault(); e.returnValue = ""; } });

  // ================================================================ RELEASES
  const KINDS = [["single", "Single"], ["ep", "EP"], ["album", "Album"], ["video", "Music video"], ["other", "Other"]];
  // Dates from the database are plain days ("2026-12-03"), so build them in local time to avoid a day's slip.
  const day = (s) => { if (!s) return null; const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtDay = (s) => (s ? day(s).toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" }) : "No date");
  const countdown = (n) => n == null ? "No release date yet" : n > 1 ? `${n} days to go` : n === 1 ? "Tomorrow" : n === 0 ? "Release day" : n === -1 ? "Released yesterday" : `Released ${-n} days ago`;

  async function releasesView() {
    const list = await rpc("releases_list");
    const create = () => {
      const title = h("input", { id: "relTitle", type: "text", maxlength: "120", placeholder: "Song or release title" });
      const date = h("input", { id: "relDate", type: "date" });
      const kind = h("select", { id: "relKind" }, KINDS.map(([v, t]) => h("option", { value: v }, t)));
      const tpl = h("input", { id: "relTpl", type: "checkbox", checked: true });
      const out = h("div", { class: "note note--err", role: "status" });
      const go = async () => {
        try { const id = await rpc("release_save", { p_id: null, p_title: title.value, p_kind: kind.value, p_release_date: date.value || null, p_use_template: tpl.checked }); dlg.close(); location.hash = "#release/" + id; }
        catch (e) { out.textContent = friendly(e); }
      };
      openDialog(h("h2", null, "New release"), field("Title", title),
        h("div", { class: "grid2" }, field("Release date", date, "First Thursdays, usually."), field("Type", kind)),
        h("label", { class: "check", for: "relTpl" }, tpl, h("span", null, "Start with the usual checklist (15 tasks, dated back from release day). You can change any of it.")),
        out, h("div", { class: "form__actions", style: "margin-top:16px" }, h("button", { class: "btn btn--grad", type: "button", onclick: go }, "Create"), h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Cancel")));
      title.focus();
    };
    show(head("Releases", me.manager && h("button", { class: "btn btn--ink btn--sm", onclick: create }, "New release")),
      list.length ? listTable(["Release", "Release day", "Checklist", "Next task", ["Overdue"]], list.map((r) => h("tr", opens("#release/" + r.id),
        nameCell(r.title, (KINDS.find((k) => k[0] === r.kind) || ["", ""])[1]),
        h("td", null, h("div", { class: "strong" }, r.release_date ? fmtDay(r.release_date) : "No date yet"),
          h("span", { class: "tag " + (r.days_away != null && r.days_away >= 0 ? "tag--live" : "") }, countdown(r.days_away))),
        h("td", null, r.tasks ? meter(r.done, r.tasks, `${r.done} of ${r.tasks} done`) : h("span", { class: "muted" }, "No tasks yet")),
        h("td", null, r.next_task ? [h("div", null, r.next_task.title), r.next_task.due_date ? h("div", { class: "muted" }, "Due " + fmtDay(r.next_task.due_date)) : null] : h("span", { class: "muted" }, r.tasks ? "All done" : "–")),
        numCell(r.overdue > 0 ? h("span", { class: "tag tag--unsubscribed" }, String(r.overdue)) : "0"))))
        : emptyState("No releases planned yet", "Add one to get a dated checklist for the drop, counted back from release day.",
            me.manager && h("button", { class: "btn btn--grad", type: "button", onclick: create }, "Plan the first release")));
  }

  async function releaseView(id) {
    const [data, team, drops, links] = await Promise.all([rpc("release_get", { p_id: id }), rpc("team_list"), rpc("drops_list"), rpc("smart_links_list")]);
    if (!data) { show(h("a", { class: "back", href: "#releases" }, "← All releases"), h("div", { class: "panel" }, "That release no longer exists.")); return; }
    const r = data.release, ro = !me.manager, reload = () => releaseView(id);
    const done = data.tasks.filter((t) => t.done).length;

    const editTask = (t) => {
      const title = h("input", { id: "tTitle", type: "text", value: t ? t.title : "", maxlength: "200" });
      const due = h("input", { id: "tDue", type: "date", value: t && t.due_date ? t.due_date : "" });
      const owner = h("select", { id: "tOwner" }, h("option", { value: "" }, "Nobody yet"), team.members.map((m) => h("option", { value: m.user_id }, m.display_name || m.email)));
      owner.value = (t && t.owner_id) || "";
      const out = h("div", { class: "note note--err", role: "status" });
      const save = async () => {
        try { await rpc("release_task_save", { p_id: t ? t.id : null, p_release_id: id, p_title: title.value, p_due_date: due.value || null, p_owner_id: owner.value || null }); dlg.close(); toast("Saved"); reload(); }
        catch (e) { out.textContent = friendly(e); }
      };
      openDialog(h("h2", null, t ? "Edit task" : "Add a task"), field("Task", title), h("div", { class: "grid2" }, field("Due", due), field("Who", owner)), out,
        h("div", { class: "form__actions" }, h("button", { class: "btn btn--grad", type: "button", onclick: save }, "Save"), h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Cancel"),
          t && h("button", { class: "btn btn--danger btn--sm", type: "button", style: "margin-left:auto",
            onclick: async () => { try { await rpc("release_task_delete", { p_id: t.id }); dlg.close(); toast("Task deleted"); reload(); } catch (e) { toast(friendly(e), true); } } }, "Delete")));
      title.focus();
    };
    const taskRow = (t) => {
      const box = h("input", { type: "checkbox", id: "task-" + t.id, checked: t.done });
      box.addEventListener("change", async () => {
        try { await rpc("release_task_toggle", { p_id: t.id, p_done: box.checked }); reload(); } catch (e) { box.checked = t.done; toast(friendly(e), true); }
      });
      return h("div", { class: "task" + (t.done ? " task--done" : "") },
        box, h("label", { for: box.id, class: "task__title" }, t.title),
        h("div", { class: "task__meta" },
          t.overdue && h("span", { class: "tag tag--unsubscribed" }, "overdue"),
          h("span", null, fmtDay(t.due_date)), h("span", null, t.owner_name || "Unassigned"),
          !ro && h("button", { class: "btn btn--soft btn--sm", "aria-label": "Edit task: " + t.title, onclick: () => editTask(t) }, "Edit")));
    };
    const group = (label, items) => items.length ? [h("div", { class: "label2", style: "margin:18px 0 6px" }, `${label} (${items.length})`), items.map(taskRow)] : null;
    const open = data.tasks.filter((t) => !t.done);

    const f = {
      title: h("input", { id: "rTitle", type: "text", value: r.title, maxlength: "120", disabled: ro }),
      date: h("input", { id: "rDate", type: "date", value: r.release_date || "", disabled: ro }),
      kind: h("select", { id: "rKind", disabled: ro }, KINDS.map(([v, t]) => h("option", { value: v }, t))),
      notes: h("textarea", { id: "rNotes", maxlength: "5000", disabled: ro, placeholder: "Anything the team should know about this release." }),
      drop: h("select", { id: "rDrop", disabled: ro }, h("option", { value: "" }, "None"), drops.map((d) => h("option", { value: d.id }, d.title))),
      link: h("select", { id: "rLink", disabled: ro }, h("option", { value: "" }, "None"), links.map((l) => h("option", { value: l.id }, l.title))),
    };
    f.kind.value = r.kind; f.notes.value = r.notes || ""; f.drop.value = r.drop_id || ""; f.link.value = r.smart_link_id || "";
    const save = async () => {
      try {
        const moved = r.release_date && f.date.value && r.release_date !== f.date.value && open.length;
        await rpc("release_save", { p_id: id, p_title: f.title.value, p_kind: f.kind.value, p_release_date: f.date.value || null, p_notes: f.notes.value, p_drop_id: f.drop.value || null, p_smart_link_id: f.link.value || null });
        toast(moved ? "Saved. Unfinished tasks moved with the new date." : "Saved"); reload();
      } catch (e) { toast(friendly(e), true); }
    };

    // One confirmed action for release day: says what it will do, then does all of it.
    const releaseDay = async () => {
      let p; try { p = await rpc("release_day_preview", { p_id: id }); } catch (e) { toast(friendly(e), true); return; }
      const will = [], already = [];
      if (p.link) (p.link.will_switch_on ? will : p.link.is_live ? already : []).push(p.link.will_switch_on ? `Switch on the smart link “${p.link.title}”, so anyone with the link can use it.` : "The smart link is already on.");
      if (p.drop) {
        if (p.drop.will_release) will.push(`Mark the QR drop “${p.drop.title}” as released. Early-listen links and QR codes will send people to the released song instead.`);
        else if (p.drop.status === "released") already.push("The QR drop is already marked as released.");
        else already.push(`The QR drop is ${p.drop.status}, not live, so it will be left as it is.`);
        if (p.drop.already_emailed) already.push("The “it's out now” email has already gone to the fans who scanned it.");
        else if ((p.drop.will_release || p.drop.status === "released") && !p.drop.fans) already.push("Nobody subscribed has scanned the QR drop, so there's nobody to email.");
      }
      if (p.link && p.link.waiting) will.push(`Email the ${p.link.waiting === 1 ? "1 fan" : nf(p.link.waiting) + " fans"} who asked to be told when it's out. (Anyone who also scanned the QR drop gets one email, not two.)`);
      const canEmail = p.drop && p.drop.can_email;
      const send = h("input", { id: "rdSend", type: "checkbox", checked: true });
      if (p.tasks && (will.length || canEmail)) will.push(p.tasks === 1 ? "Tick off the matching release-day task on the checklist." : "Tick off the matching release-day tasks on the checklist.");
      const early = p.days_away != null && p.days_away > 0;
      const blocked = p.problems.length > 0, nothing = !blocked && !will.length && !canEmail;
      const out = h("div", { class: "note note--err", role: "status" });
      const go = async (e) => {
        e.target.disabled = true;
        try {
          const res = await rpc("release_day_run", { p_id: id, p_send_email: canEmail ? send.checked : false });
          if (res.emails) kickSender();
          dlg.close();
          toast([res.link_switched_on && "Smart link on", res.drop_released && "Drop released", res.emails && `${nf(res.emails)} ${res.emails === 1 ? "email" : "emails"} sending`].filter(Boolean).join(" · ") || "Done");
          reload();
        } catch (err) { e.target.disabled = false; out.textContent = friendly(err); }
      };
      openDialog(h("h2", null, "Release day for “" + p.title + "”"),
        blocked ? [h("p", { class: "muted" }, "A couple of things need sorting out first:"), h("ul", { class: "steps steps--warn" }, p.problems.map((t) => h("li", null, t)))]
          : nothing ? h("p", { class: "muted" }, "Everything for release day has already been done.")
          : [h("p", { class: "muted" }, "This will do the following, straight away:"),
              h("ul", { class: "steps" }, will.map((t) => h("li", null, t)),
                canEmail && h("li", { class: "steps__opt" }, h("label", { class: "check", for: "rdSend" }, send, h("span", null, `Email the ${p.drop.fans === 1 ? "1 fan" : nf(p.drop.fans) + " fans"} who scanned the QR drop: “${p.email_subject}”.`))))],
        already.length && !blocked ? h("p", { class: "hint", style: "margin-top:12px" }, already.join(" ")) : null,
        early && !blocked && !nothing ? h("div", { class: "banner", style: "margin:14px 0 0" }, h("b", null, `Release day is still ${p.days_away === 1 ? "tomorrow" : p.days_away + " days away"}. `), "Doing this now makes the song public early.") : null,
        canEmail && !blocked ? h("p", { class: "hint", style: "margin-top:12px" }, "You can read or change the email's wording under Email, in “Automatic emails”. Once sent it can't be taken back.") : null,
        out,
        h("div", { class: "form__actions", style: "margin-top:20px" },
          !blocked && !nothing && h("button", { class: "btn btn--grad", type: "button", onclick: go }, "Do it now"),
          h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, blocked || nothing ? "Close" : "Not yet")));
    };

    // A first draft of the release email and three captions, written by AI from this
    // release's details. Nothing is sent or posted: the manager edits, copies, or
    // turns the email into a draft.
    const draftCopy = async (e) => {
      const btn = e.target; btn.disabled = true; btn.textContent = "Writing…";
      let d;
      try { d = await call("/functions/v1/release-draft", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ release_id: id }) }); }
      catch (err) { toast(err.status === 503 && /connected/.test(err.message) ? "AI drafting isn't connected yet." : err.status === 403 ? "Only a manager can do that." : (err.message && err.message.length < 120 ? err.message : "The draft couldn't be written. Try again."), true); return; }
      finally { btn.disabled = false; btn.textContent = "Draft email and captions"; }
      const copy = async (el) => { try { await navigator.clipboard.writeText(el.value); toast("Copied"); } catch (_) { el.focus(); el.select(); toast("Couldn't copy. It's selected, so press Ctrl+C.", true); } };
      const subject = h("input", { id: "dfSubject", type: "text", maxlength: "200", value: d.email_subject });
      const body = h("textarea", { id: "dfBody", maxlength: "20000", style: "min-height:200px" }); body.value = d.email_body;
      const caps = [["caption_teaser", "Caption: teaser, a few days before"], ["caption_release_day", "Caption: release day"], ["caption_story", "Caption: the story behind it"]].map(([k, label]) => {
        const ta = h("textarea", { id: "df-" + k, maxlength: "2200", style: "min-height:90px" }); ta.value = d[k] || "";
        return h("div", { class: "field" }, h("label", { for: ta.id }, label), ta, h("div", { class: "form__actions" }, h("button", { class: "btn btn--soft btn--sm", type: "button", onclick: () => copy(ta) }, "Copy caption")));
      });
      const toEmail = async () => {
        try { const mid = await rpc("campaign_save", { p_id: null, p_subject: subject.value, p_body: body.value, p_segment: {} }); dlg.close(); toast("Saved as an email draft. Check it before sending."); location.hash = "#mail/" + mid; }
        catch (err) { toast(friendly(err), true); }
      };
      openDialog(h("h2", null, "A first draft"),
        h("div", { class: "banner" }, DEV ? [h("b", null, "Test mode. "), "This is set wording, not real AI writing. Live, it's written from the release's title, date and notes."]
          : [h("b", null, "Written by AI as a starting point. "), "Check every fact and make it sound like A.R.T before using it. Nothing has been sent or posted."]),
        field("Email subject", subject), field("Email message", body, "{{first_name}} becomes each fan's name when it's sent."),
        h("div", { class: "form__actions", style: "margin-bottom:18px" }, h("button", { class: "btn btn--grad btn--sm", type: "button", onclick: toEmail }, "Save as an email draft"),
          h("button", { class: "btn btn--soft btn--sm", type: "button", onclick: () => copy(body) }, "Copy message")),
        caps,
        h("div", { class: "form__actions", style: "margin-top:8px" }, h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Close")));
    };

    show(h("a", { class: "back", href: "#releases" }, "← All releases"),
      head(r.title, !ro && [(data.drop || data.smart_link) && h("button", { class: "btn btn--grad btn--sm", onclick: releaseDay }, "Release day…"), h("button", { class: "btn btn--ink btn--sm", onclick: () => editTask(null) }, "Add task")]),
      h("section", { class: "panel" }, h("div", { class: "statusbar" },
        h("div", null, h("span", { class: "tag " + (data.days_away != null && data.days_away >= 0 ? "tag--live" : "") }, countdown(data.days_away)),
          h("p", { class: "muted", style: "margin-top:8px" }, (r.release_date ? fmtDay(r.release_date) + " · " : "") + `${done} of ${data.tasks.length} tasks done`)),
      )),
      kpiStrip([
        { label: "Release day", value: data.days_away == null ? "–" : data.days_away < 0 ? "Out" : data.days_away === 0 ? "Today" : data.days_away + (data.days_away === 1 ? " day" : " days"), sub: r.release_date ? fmtDay(r.release_date) : "No date set" },
        { label: "Checklist", value: data.tasks.length ? Math.round((done / data.tasks.length) * 100) + "%" : "–", sub: `${done} of ${data.tasks.length} done`, progress: data.tasks.length ? done / data.tasks.length : 0 },
        { label: "Still to do", value: nf(open.length), sub: open.length ? "open tasks" : "nothing left" },
        { label: "Overdue", value: nf(open.filter((t) => t.overdue).length), sub: open.some((t) => t.overdue) ? "need attention" : "nothing late", tone: open.some((t) => t.overdue) ? "bad" : "good" },
        { label: "QR drop", value: data.drop ? data.drop.status : "None", sub: data.drop ? "open the drop" : "not linked", href: data.drop ? "#drop/" + data.drop.id : null },
        { label: "Smart link", value: data.smart_link ? (data.smart_link.is_live ? "On" : "Off") : "None", sub: data.smart_link ? "open the link" : "not linked", href: data.smart_link ? "#link/" + data.smart_link.id : null },
      ]),
      h("section", { class: "panel" }, h("h2", null, "Checklist"),
        data.tasks.length ? [group("Overdue", open.filter((t) => t.overdue)), group("To do", open.filter((t) => !t.overdue)), group("Done", data.tasks.filter((t) => t.done))]
          : h("p", { class: "muted" }, "No tasks yet." + (ro ? "" : " Use “Add task” to start the list.")),
        h("p", { class: "hint", style: "margin-top:14px" }, "Anyone on the team can tick a task off. Managers set the dates and who's doing what.")),
      h("section", { class: "panel" }, h("h2", null, "Release details"),
        field("Title", f.title),
        h("div", { class: "grid2" }, field("Release date", f.date, "Changing this moves every unfinished task by the same number of days."), field("Type", f.kind)),
        h("div", { class: "grid2" }, field("QR drop for early listens", f.drop), field("Smart link", f.link)),
        field("Notes", f.notes, ro ? null : "What the song is about, who's on it, why it matters. The AI draft below is written from these, so save them first."),
        !ro && h("div", { class: "form__actions" }, h("button", { class: "btn btn--grad", onclick: save }, "Save changes"),
          h("button", { class: "btn btn--soft", type: "button", onclick: draftCopy }, "Draft email and captions"),
          h("button", { class: "btn btn--danger btn--sm", style: "margin-left:auto", onclick: () => confirmBox("Delete this release plan?", "The checklist will be deleted. The QR drop and smart link are not affected.", "Delete plan",
            async () => { try { await rpc("release_delete", { p_id: id }); toast("Deleted"); location.hash = "#releases"; } catch (e) { toast(friendly(e), true); } }) }, "Delete plan"))));
  }

  // ================================================================ SMART LINKS
  // Keep in step with private.platform_keys() in the database and go/index.html.
  const PLATFORMS = [["spotify", "Spotify"], ["apple", "Apple Music"], ["youtube_music", "YouTube Music"], ["youtube", "YouTube"], ["amazon", "Amazon Music"],
    ["tidal", "TIDAL"], ["deezer", "Deezer"], ["soundcloud", "SoundCloud"], ["bandcamp", "Bandcamp"], ["tiktok", "TikTok"]];
  const platformName = (k) => (PLATFORMS.find((p) => p[0] === k) || [k, k])[1];
  const goUrl = (slug, src) => new URL("../../go/?s=" + slug + (src ? "&src=" + src : ""), location.href).href;

  async function linksView() {
    const links = await rpc("smart_links_list");
    const create = () => {
      const title = h("input", { id: "newLink", type: "text", maxlength: "120", placeholder: "Song or release title" });
      const out = h("div", { class: "note note--err", role: "status" });
      const go = async () => { try { const id = await rpc("smart_link_save", { p_id: null, p_title: title.value }); dlg.close(); location.hash = "#link/" + id; } catch (e) { out.textContent = friendly(e); } };
      title.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      openDialog(h("h2", null, "New smart link"), field("What's it for?", title, "One link that shows every place to listen. Nothing is public until you switch it on."), out,
        h("div", { class: "form__actions" }, h("button", { class: "btn btn--grad", type: "button", onclick: go }, "Create"), h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Cancel")));
      title.focus();
    };
    show(head("Smart links", me.manager && h("button", { class: "btn btn--ink btn--sm", onclick: create }, "New link")),
      links.length ? listTable(["Link", "Status", ["Visits"], ["Clicks"], ["Click rate"], ["Services"]], links.map((l) => h("tr", opens("#link/" + l.id),
        nameCell(l.title, "/go/?s=" + l.slug),
        h("td", null, h("span", { class: "tag " + (l.is_live ? "tag--live" : "") }, l.is_live ? "on" : "off")),
        numCell(nf(l.views)), numCell(nf(l.clicks)), numCell(pct(l.clicks, l.views)), numCell(nf(l.platform_count)))))
        : emptyState("No smart links yet", "Make one per release and share it everywhere, so fans can pick their own music service.",
            me.manager && h("button", { class: "btn btn--grad", type: "button", onclick: create }, "Make the first link")));
  }

  async function linkView(id) {
    const data = await rpc("smart_link_get", { p_id: id });
    if (!data) { show(h("a", { class: "back", href: "#links" }, "← All links"), h("div", { class: "panel" }, "That link no longer exists.")); return; }
    const l = data.link, ro = !me.manager, reload = () => linkView(id);
    const title = h("input", { id: "lTitle", type: "text", value: l.title, maxlength: "120", disabled: ro });
    const subtitle = h("input", { id: "lSub", type: "text", value: l.subtitle || "", maxlength: "120", placeholder: "New single · out now", disabled: ro });
    const slug = h("input", { id: "lSlug", type: "text", value: l.slug, maxlength: "80", disabled: ro });
    let artwork = l.artwork_path;
    const urls = {};
    const current = Object.fromEntries((l.platforms || []).map((p) => [p.key, p.url]));
    const rows = PLATFORMS.map(([k, name]) => {
      urls[k] = h("input", { id: "pf-" + k, type: "url", value: current[k] || "", placeholder: "https://…", disabled: ro, inputmode: "url" });
      return field(name, urls[k]);
    });
    // saved order: platforms already on the link keep their order, new ones follow the list above
    const collect = () => {
      const order = (l.platforms || []).map((p) => p.key).concat(PLATFORMS.map((p) => p[0]).filter((k) => !(k in current)));
      return order.map((k) => ({ key: k, url: urls[k].value.trim() })).filter((p) => p.url);
    };
    const save = async (quiet) => {
      await rpc("smart_link_save", { p_id: id, p_title: title.value, p_slug: slug.value, p_subtitle: subtitle.value, p_artwork_path: artwork, p_platforms: collect() });
      if (!quiet) toast("Saved");
    };
    const trySave = async () => { try { await save(); reload(); } catch (e) { toast(friendly(e), true); } };
    const waiting = data.notified ? 0 : data.notify_count;
    const doLive = async (on) => { try { await save(true); await rpc("smart_link_set_status", { p_id: id, p_live: on }); if (on && waiting) kickSender(); toast(on ? (waiting ? `Link is on. Telling ${nf(waiting)} ${waiting === 1 ? "fan" : "fans"}.` : "Link is on") : "Link is off"); reload(); } catch (e) { toast(friendly(e), true); } };
    // switching on also emails the people who asked, so say so first
    const setLive = (on) => {
      if (!on || !waiting) return doLive(on);
      openDialog(h("h2", null, "Switch on and tell " + (waiting === 1 ? "1 fan" : nf(waiting) + " fans") + "?"),
        h("p", { class: "muted" }, `${waiting === 1 ? "1 person" : nf(waiting) + " people"} asked to be told when “${l.title}” is out. Switching the link on emails them the “it's out now” email straight away. It can't be taken back.`),
        h("div", { class: "form__actions", style: "margin-top:20px" }, h("button", { class: "btn btn--grad", type: "button", onclick: () => { dlg.close(); doLive(true); } }, "Switch on and email them"),
          h("button", { class: "btn btn--soft", type: "button", onclick: () => dlg.close() }, "Not yet")));
    };
    const setNotify = async (on) => { try { await rpc("smart_link_set_notify", { p_id: id, p_on: on }); toast(on ? "The coming-soon page is on" : "The coming-soon page is off"); reload(); } catch (e) { toast(friendly(e), true); } };

    const url = goUrl(l.slug), canvas = h("canvas", { role: "img", "aria-label": "QR code for this link" });
    drawQr(canvas, url, 264);
    const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast("Link copied"); } catch (_) { toast("Couldn't copy. Select the link instead.", true); } };
    const art = h("input", { id: "lArt", type: "file", accept: "image/*", disabled: ro });
    const artStat = h("div", { class: "hint" }, artwork ? "Uploaded ✓" : "Square image, usually the cover art.");
    art.addEventListener("change", async () => {
      if (!art.files[0]) return; artStat.textContent = "Uploading…";
      try { artwork = await upload("artwork", "links/" + id, art.files[0]); await save(true); toast("Artwork uploaded"); reload(); } catch (e) { artStat.textContent = "Upload failed. Try again."; }
    });
    const maxClicks = Math.max(1, ...data.by_platform.map((p) => p.clicks));

    show(h("a", { class: "back", href: "#links" }, "← All links"), head(l.title),
      h("section", { class: "panel" }, h("div", { class: "statusbar" },
        h("div", null, h("span", { class: "tag " + (l.is_live ? "tag--live" : "") }, l.is_live ? "on" : "off"),
          h("p", { class: "muted", style: "margin-top:8px" }, l.is_live ? "Anyone with the link can use it." : "Switched off. Visitors see a general “listen to A.R.T” page instead.")),
        !ro && h("div", { class: "form__actions" }, l.is_live
          ? h("button", { class: "btn btn--soft", onclick: () => setLive(false) }, "Switch off")
          : h("button", { class: "btn btn--grad", onclick: () => setLive(true) }, "Switch on")))),
      (!l.is_live || data.notify_count > 0) && h("section", { class: "panel" }, h("h2", null, "Before it's out: “Tell me when it's out”"),
        h("p", { class: "muted", style: "margin:-6px 0 12px" }, l.is_live
          ? `${nf(data.notify_count)} ${data.notify_count === 1 ? "fan" : "fans"} asked to be told` + (data.notified ? " and were emailed when the link was switched on." : ".")
          : l.notify_on ? "While this link is off, visitors see a coming-soon page where they can leave their email. They join the fan list and are emailed the moment you switch the link on."
          : "While this link is off, visitors just see a general “listen to A.R.T” page. Turn this on to collect emails from people who want to hear it first."),
        !l.is_live && h("div", { class: "statusbar" },
          h("div", null, h("span", { class: "tag " + (l.notify_on ? "tag--live" : "") }, l.notify_on ? "collecting emails" : "off"),
            h("span", { class: "strong", style: "margin-left:12px" }, `${nf(data.notify_count)} waiting`)),
          !ro && h("div", { class: "form__actions" }, l.notify_on
            ? h("button", { class: "btn btn--soft btn--sm", type: "button", onclick: () => setNotify(false) }, "Stop collecting")
            : h("button", { class: "btn btn--ink btn--sm", type: "button", onclick: () => setNotify(true) }, "Start collecting emails")))),
      h("div", { class: "tiles" }, tile(data.views, "Visits"), tile(data.clicks, "Clicks through"),
        h("div", { class: "tile" }, h("div", { class: "tile__num" }, pct(data.clicks, data.views)), h("div", { class: "tile__cap" }, "Click rate")), tile((l.platforms || []).length, "Services")),
      h("section", { class: "panel" }, h("h2", null, "Share it"),
        h("div", { class: "qr" }, canvas, h("div", null,
          h("div", { class: "qr__link" }, url),
          h("div", { class: "qr__actions" },
            h("button", { class: "btn btn--ink btn--sm", onclick: () => copy(url) }, "Copy link"),
            h("a", { class: "btn btn--soft btn--sm", href: url, target: "_blank", rel: "noopener" }, "Preview"),
            h("button", { class: "btn btn--soft btn--sm", onclick: () => { const big = document.createElement("canvas"); drawQr(big, url, 1200); big.toBlob((b) => download(b, `art-link-${l.slug}.png`)); } }, "Download QR")),
          h("p", { class: "hint", style: "margin-top:12px" }, "To see where visitors come from, share a tagged copy in each place:"),
          h("div", { class: "qr__actions", style: "margin-top:8px" }, ["instagram", "tiktok", "facebook", "email"].map((s) =>
            h("button", { class: "btn btn--soft btn--sm", onclick: () => copy(goUrl(l.slug, s)) }, "Copy for " + s[0].toUpperCase() + s.slice(1))))))),
      (data.by_platform.length || data.by_source.length) ? h("section", { class: "panel" }, h("h2", null, "Where fans choose to listen"),
        data.by_platform.length ? h("div", { class: "themes" }, data.by_platform.map((p) => h("div", { class: "theme" },
          h("div", { class: "theme__name" }, platformName(p.platform)),
          h("div", { class: "theme__bar", "aria-hidden": "true" }, h("span", { style: `width:${Math.max(4, Math.round((p.clicks / maxClicks) * 100))}%` })),
          h("div", { class: "theme__num" }, h("b", null, nf(p.clicks)), p.clicks === 1 ? " click" : " clicks"))))
          : h("p", { class: "muted" }, "No clicks yet."),
        data.by_source.length ? h("div", { style: "margin-top:18px" }, h("div", { class: "label2" }, "Where visitors came from"),
          data.by_source.map((s) => h("div", { class: "row" }, h("div", { class: "row__main strong" }, s.src === "direct" ? "Untagged link" : s.src[0].toUpperCase() + s.src.slice(1)),
            h("div", { class: "row__side muted" }, `${nf(s.views)} ${s.views === 1 ? "visit" : "visits"} · ${nf(s.clicks)} ${s.clicks === 1 ? "click" : "clicks"}`)))) : null) : null,
      h("section", { class: "panel" }, h("h2", null, "The page"),
        h("div", { class: "grid2" }, field("Title", title), field("Line above the title", subtitle)),
        field("Link name", slug, "The end of the address. Changing it breaks copies of the link you've already shared."),
        h("div", { class: "field" }, h("label", { for: "lArt" }, "Artwork"), h("div", { class: "filebox" },
          artwork ? h("img", { src: window.ART_API.artwork(artwork), alt: "" }) : h("div", { class: "ph" }), h("div", null, art, artStat)))),
      h("section", { class: "panel" }, h("h2", null, "Where to listen"),
        h("p", { class: "muted", style: "margin:-6px 0 14px" }, "Paste the release's link on each service. Leave any you don't use blank. Spotify is shown first."),
        h("div", { class: "grid2" }, rows),
        !ro && h("div", { class: "form__actions" },
          h("button", { class: "btn btn--grad", onclick: trySave }, "Save changes"),
          h("button", { class: "btn btn--danger btn--sm", style: "margin-left:auto", onclick: () => confirmBox("Delete this link?", "Every copy of the link you've shared will stop working, and its visit history will be lost.", "Delete link",
            async () => { try { await rpc("smart_link_delete", { p_id: id }); toast("Deleted"); location.hash = "#links"; } catch (e) { toast(friendly(e), true); } }) }, "Delete link"))));
  }

  // ================================================================ TEAM
  async function teamView() {
    const [d, rem] = await Promise.all([rpc("team_list"), rpc("reminder_settings_get")]);
    const remTasks = h("input", { id: "remTasks", type: "checkbox", checked: rem.tasks_on, disabled: !me.manager });
    const remEnq = h("input", { id: "remEnq", type: "checkbox", checked: rem.enquiries_on, disabled: !me.manager });
    const remDays = h("select", { id: "remDays", class: "select--sm", disabled: !me.manager, "aria-label": "Days to wait before reminding about an enquiry" },
      [1, 2, 3, 5, 7, 14].concat([1, 2, 3, 5, 7, 14].includes(rem.enquiry_days) ? [] : [rem.enquiry_days]).sort((a, b) => a - b).map((n) => h("option", { value: n }, n === 1 ? "1 day" : n + " days")));
    remDays.value = rem.enquiry_days;
    const saveRem = async () => { try { await rpc("reminder_settings_save", { p_tasks_on: remTasks.checked, p_enquiries_on: remEnq.checked, p_enquiry_days: Number(remDays.value) }); toast("Reminder settings saved"); } catch (e) { toast(friendly(e), true); } };
    const runRem = async (e) => {
      e.target.disabled = true;
      try { const r = await rpc("reminders_run"); const n = r.task_emails + r.enquiry_emails; await kickSender(); toast(n ? `${n} reminder ${n === 1 ? "email" : "emails"} sent` : "Nothing needs a reminder right now"); }
      catch (err) { toast(friendly(err), true); }
      e.target.disabled = false;
    };
    const person = (m, sub, extra) => h("div", { class: "row" },
      h("div", { class: "row__main" }, h("div", { class: "strong" }, m.display_name || m.email), h("div", { class: "muted" }, sub)),
      h("div", { class: "row__side" }, h("span", { class: "tag" + (m.role === "manager" ? " tag--manager" : "") }, m.role), extra));
    const email = h("input", { id: "invEmail", type: "email", required: true }), name = h("input", { id: "invName", type: "text", maxlength: "80" });
    const role = h("select", { id: "invRole" }, h("option", { value: "artist" }, "Artist (can view)"), h("option", { value: "manager" }, "Manager (can change everything)"));
    const invite = async () => {
      try { await rpc("invite_add", { p_email: email.value, p_name: name.value, p_role: role.value }); toast("Invited. Tell them to log in here with that email."); teamView(); }
      catch (e) { toast(friendly(e), true); }
    };
    // Managers can change anyone's role or remove them. The database refuses to leave the team without a manager.
    const controls = (m) => {
      if (!me.manager) return null;
      const sel = h("select", { class: "select--sm", "aria-label": "Role for " + (m.display_name || m.email) },
        h("option", { value: "artist" }, "Artist"), h("option", { value: "manager" }, "Manager"));
      sel.value = m.role;
      sel.addEventListener("change", async () => {
        try { await rpc("member_set_role", { p_user_id: m.user_id, p_role: sel.value }); toast("Role updated"); if (m.user_id === me.user_id) location.reload(); else teamView(); }
        catch (e) { sel.value = m.role; toast(friendly(e), true); }
      });
      const remove = h("button", { class: "btn btn--danger btn--sm", "aria-label": "Remove " + (m.display_name || m.email),
        onclick: () => confirmBox(`Remove ${m.display_name || m.email}?`, "They'll lose access straight away. You can invite them again later.", "Remove",
          async () => { try { await rpc("member_remove", { p_user_id: m.user_id }); toast("Removed"); if (m.user_id === me.user_id) location.reload(); else teamView(); } catch (e) { toast(friendly(e), true); } }) }, "Remove");
      return [sel, remove];
    };
    const member = (m) => h("div", { class: "row" },
      h("div", { class: "row__main" }, h("div", { class: "strong" }, (m.display_name || m.email) + (m.user_id === me.user_id ? " (you)" : "")), h("div", { class: "muted" }, m.display_name ? m.email : "")),
      h("div", { class: "row__side" }, me.manager ? controls(m) : h("span", { class: "tag" + (m.role === "manager" ? " tag--manager" : "") }, m.role)));
    show(head("Team"),
      h("section", { class: "panel" }, h("h2", null, "Who has access"), d.members.map(member),
        h("p", { class: "hint", style: "margin-top:10px" }, "Managers can change everything, send email and manage the team. Artists can see everything but not change it.")),
      h("section", { class: "panel" }, h("h2", null, "Reminders by email"),
        h("p", { class: "muted", style: "margin:-6px 0 12px" }, "Sent once a day, and never twice about the same thing."),
        h("label", { class: "check", for: "remTasks", style: "margin-bottom:12px" }, remTasks, h("span", null, h("b", null, "Overdue tasks. "), "Whoever a release task is assigned to gets an email when it goes past its date.")),
        h("label", { class: "check", for: "remEnq" }, remEnq, h("span", null, h("b", null, "Waiting enquiries. "), "Managers get an email when a booking enquiry has had no reply.")),
        h("div", { class: "form__actions", style: "margin:10px 0 0 30px" }, h("span", { class: "muted" }, "Remind after"), remDays),
        me.manager ? h("div", { class: "form__actions", style: "margin-top:16px" },
          h("button", { class: "btn btn--ink btn--sm", type: "button", onclick: saveRem }, "Save reminder settings"),
          h("button", { class: "btn btn--soft btn--sm", type: "button", onclick: runRem }, "Send reminders now"))
          : h("p", { class: "hint", style: "margin-top:12px" }, "The manager sets these.")),
      me.manager && h("section", { class: "panel" }, h("h2", null, "Invites"),
        h("p", { class: "muted", style: "margin:-6px 0 8px" }, "Invited people log in with their email. Nobody else can get in."),
        d.invites.length ? d.invites.map((i) => person(i, (i.display_name ? i.email + " · " : "") + "hasn't logged in yet",
          h("button", { class: "btn btn--soft btn--sm", "aria-label": "Cancel invite for " + i.email,
            onclick: async () => { try { await rpc("invite_cancel", { p_email: i.email }); toast("Invite cancelled"); teamView(); } catch (e) { toast(friendly(e), true); } } }, "Cancel")))
          : h("p", { class: "muted" }, "No invites waiting."),
        h("div", { class: "grid2", style: "margin-top:18px" }, field("Email", email), field("Name", name)),
        field("Role", role),
        h("div", { class: "form__actions" }, h("button", { class: "btn btn--ink", onclick: invite }, "Send invite"))));
  }
})();
