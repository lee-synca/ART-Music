// A.R.T Control Centre — clickable demo: the stand-in backend, running in the page.
//
// It loads a snapshot of the demo database (invented fans, bookings, releases…) into an
// in-memory Postgres and answers the app's requests from it, the same way
// ControlCentre/dev/server.mjs does on a developer's machine. Nothing leaves the browser.
import { PGlite } from "./vendor/pglite/index.js";
import { citext } from "./vendor/pglite/contrib/citext.js";
import { keywordTheme } from "./themes.js";
import { cannedDraft } from "./drafts.js";

const MANAGER = "00000000-0000-4000-8000-000000000001", ARTIST = "00000000-0000-4000-8000-000000000002";

try {
  const [snapshot, meta] = await Promise.all([
    fetch(new URL("./demo-data.tar.gz", import.meta.url)).then((r) => { if (!r.ok) throw new Error("snapshot " + r.status); return r.blob(); }),
    fetch(new URL("./demo-meta.json", import.meta.url)).then((r) => r.json()),
  ]);
  const db = await PGlite.create({ loadDataDir: snapshot, extensions: { citext } });
  const shapes = new Map(Object.entries(meta.shapes));

  // one query at a time (a single in-memory connection)
  let chain = Promise.resolve();
  const queue = (fn) => (chain = chain.then(fn, fn));
  const as = (role, sql, params = [], uid = "") => queue(async () => {
    await db.exec("begin");
    try {
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      await db.exec(`set local role ${role}`);
      const r = await db.query(sql, params);
      await db.exec("commit");
      return { rows: r.rows };
    } catch (e) {
      await db.exec("rollback");
      return { error: { message: e.message, code: e.code } };
    }
  });

  const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body ?? null), { status, headers: { "Content-Type": "application/json" } });
  const header = (init, name) => { const hd = init.headers || {}; return (hd instanceof Headers ? hd.get(name) : hd[name] || hd[name.toLowerCase()]) || ""; };
  const userOf = (init) => { const m = /^Bearer dev-user:([0-9a-f-]{36})$/.exec(header(init, "Authorization")); return m ? m[1] : ""; };
  const bodyOf = (init) => { try { return typeof init.body === "string" ? JSON.parse(init.body || "{}") : {}; } catch { return {}; } };
  const isManager = async (uid) => { const r = uid ? await as("authenticated", "select private.is_manager() as ok", [], uid) : null; return !!(r && !r.error && r.rows[0].ok); };

  // uploaded files stay in this page's memory
  const files = new Map(); // "bucket/path" -> object URL
  const keep = (key, blob) => { const u = URL.createObjectURL(blob); files.set(key, u); return u; };
  const realArtwork = window.ART_API.artwork;
  window.ART_API.artwork = (path) => (path && files.get("artwork/" + path)) || (path && !/^https?:/.test(path) ? "" : realArtwork(path));

  // the website's events and news: read from the real site, edits stay in this page
  const siteContent = {};
  const loadSite = async (type) => {
    if (!siteContent[type]) {
      const file = type === "events" ? "art-events.json" : "art-news.json";
      try { siteContent[type] = (await fetch(new URL("../../data/" + file, location.href)).then((r) => r.json()))[type] || []; } catch { siteContent[type] = []; }
    }
    return siteContent[type];
  };

  // Reel Radar: there is no Instagram here, so reels are invented, repeatably per username
  const CAPTIONS = [
    ["Studio day. Something new is cooking #newmusic #islandreggae", 1], ["Soundcheck", 0.8], ["On the road again", 0.9], ["Sunday jam with the family #polytok", 1.1],
    ["POV: your aunty hears the new single for the very first time and will not stop dancing #newmusic #polytok", 1.6],
    ["We wrote this one on the porch at nana's house. Full story in the comments, it means a lot to us #islandreggae", 1.4],
    ["Rehearsal clips", 0.8], ["Thank you for last night. What a crowd #liveshow", 1.2],
    ["Harmonies only, no music. Which part are you singing? #acapella #islandreggae", 1.7],
    ["New merch just landed", 0.7], ["Behind the scenes of the video shoot #bts #newmusic", 1.2],
  ];
  function demoMedia(username, runs) {
    let seed = [...username].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const base = 8000 + Math.floor(rnd() * 240000);
    return Array.from({ length: 26 }, (_, i) => {
      const [caption, lift] = CAPTIONS[Math.floor(rnd() * CAPTIONS.length)];
      const evening = rnd() < 0.55;
      const posted = new Date(Date.now() - (2 + i * 3.4 + rnd() * 2) * 864e5);
      posted.setUTCHours(evening ? 5 + Math.floor(rnd() * 3) : 19 + Math.floor(rnd() * 5), Math.floor(rnd() * 60), 0, 0);
      const spike = rnd() < 0.1 ? 3 + rnd() * 6 : 1;
      const views = Math.round(base * (0.55 + rnd() * 0.9) * lift * (evening ? 1.25 : 1) * spike * (1 + runs * 0.02));
      return { id: `demo-${username}-${i}`, media_product_type: "REELS", permalink: `https://www.instagram.com/${username}/`, caption, timestamp: posted.toISOString(),
        view_count: views, like_count: Math.round(views * (0.04 + rnd() * 0.05)), comments_count: Math.round(views * (0.001 + rnd() * 0.003)) };
    });
  }
  let radarRuns = 1;
  async function refreshRadar() {
    const due = (await as("service_role", "select public.radar_due(40, 0) as d")).rows[0].d;
    for (const a of due) {
      const media = demoMedia(a.username, radarRuns);
      const name = a.username.replace(/[._]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      await as("service_role", "select public.radar_ingest($1, $2, $3)", [a.id, JSON.stringify({ name, followers_count: Math.round(media[0].view_count * 2.5) }), JSON.stringify(media)]);
    }
    const unthemed = (await as("service_role", "select public.radar_theme_due(200) as d")).rows[0].d;
    if (unthemed.length) await as("service_role", "select public.radar_theme_set($1)", [JSON.stringify(unthemed.map((r) => ({ id: r.id, theme: keywordTheme(r.caption) })))]);
    radarRuns++;
    return due.length;
  }

  // "Sends" queued emails: marks them as sent. No email goes anywhere.
  async function deliverQueued() {
    let n = 0;
    for (;;) {
      const r = await as("service_role", "select public.email_next_batch(100) as b");
      const batch = (r.rows && r.rows[0].b) || [];
      if (!batch.length) break;
      for (const msg of batch) { n++; await as("service_role", "select public.email_mark($1, true, $2, null)", [msg.id, "demo-" + Date.now() + "-" + n]); }
    }
    return n;
  }

  async function answer(path, init) {
    const url = new URL(path, "http://x"), method = (init.method || "GET").toUpperCase(), uid = userOf(init);

    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (rpc && method === "POST") {
      const shape = shapes.get(rpc[1]);
      if (!shape) return json(404, { message: "Could not find the function" });
      const args = bodyOf(init), keys = Object.keys(args).filter((k) => /^p_[a-z_]+$/.test(k));
      const sql = `select * from public.${rpc[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
      const vals = keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
      const r = await as(uid ? "authenticated" : "anon", sql, vals, uid);
      if (r.error) return json(400, r.error);
      if (shape === "void") return json(204);
      if (shape === "scalar") return json(200, Object.values(r.rows[0] || {})[0] ?? null);
      return json(200, r.rows);
    }

    if (url.pathname === "/dev/users") return json(200, [{ id: MANAGER, label: "Demo Manager", role: "manager" }, { id: ARTIST, label: "Demo Artist", role: "artist" }]);

    const up = url.pathname.match(/^\/storage\/v1\/object\/(artwork|previews|press)\/(.+)$/);
    if (up && method === "POST") {
      if (!(await isManager(uid))) return json(403, { message: "Only a manager can upload files." });
      const key = `${up[1]}/${decodeURIComponent(up[2])}`;
      if (init.body instanceof Blob) keep(key, init.body);
      return json(200, { Key: key });
    }

    if (url.pathname === "/functions/v1/radar-refresh" && method === "POST") {
      const who = uid ? await as("authenticated", "select count(*)::int as n from public.centre_me()", [], uid) : null;
      if (!who || who.error || !who.rows[0].n) return json(403, { error: "Team members only." });
      return json(200, { checked: await refreshRadar(), failed: 0 });
    }

    if (url.pathname === "/functions/v1/release-draft" && method === "POST") {
      if (!(await isManager(uid))) return json(403, { error: "Only a manager can do that." });
      const { release_id } = bodyOf(init);
      const r = /^[0-9a-f-]{36}$/i.test(String(release_id || "")) ? await as("authenticated", "select public.release_get($1) as r", [release_id], uid) : null;
      const found = r && !r.error && r.rows[0].r;
      if (!found) return json(404, { error: "That release no longer exists." });
      let link = null;
      if (found.smart_link) {
        const sl = await as("authenticated", "select public.smart_link_get($1) as l", [found.smart_link.id], uid);
        if (!sl.error && sl.rows[0].l) link = `https://artmusic.co.nz/go/?s=${sl.rows[0].l.link.slug}`;
      }
      return json(200, cannedDraft({ ...found.release, link }));
    }

    if (url.pathname === "/functions/v1/send-queued" && method === "POST") return json(200, { sent: await deliverQueued(), failed: 0 });

    const api = url.pathname.match(/^\/api\/(load|save|upload|parse-url|parse-poster)$/);
    if (api && method === "POST") {
      if (!(await isManager(uid))) return json(401, { error: "Not logged in" });
      const body = bodyOf(init);
      const picture = (filename, dataBase64) => {
        const raw = atob(String(dataBase64 || "").replace(/^data:[^;]+;base64,/, "")), bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        return keep("site/" + Date.now().toString(36) + "-" + String(filename || "image.jpg"), new Blob([bytes], { type: "image/jpeg" }));
      };
      if (api[1] === "load" || api[1] === "save") {
        if (body.type !== "events" && body.type !== "news") return json(400, { error: "Unknown content type" });
        if (api[1] === "load") return json(200, { [body.type]: await loadSite(body.type) });
        siteContent[body.type] = (body.data && body.data[body.type]) || [];
        return json(200, { ok: true });
      }
      if (api[1] === "upload") return json(200, { path: picture(body.filename, body.dataBase64) });
      if (api[1] === "parse-url") {
        let host = "example.test";
        try { host = new URL(/^https?:/i.test(body.url) ? body.url : "https://" + body.url).hostname.replace(/^www\./, ""); } catch { return json(400, { error: "Paste a link first" }); }
        return json(200, { label: "News", headline: "Demo headline from " + host, summary: "In the demo the article isn't really read. Live, this is filled in from the page.", source: host, link: body.url, image: "", image_alt: "" });
      }
      return json(200, { poster: picture(body.filename, body.dataBase64), poster_alt: "Event poster", eyebrow: "Upcoming", name: "", date_display: "", venue: "", lineup: "", tickets_url: "", _ai: false });
    }

    if (/^\/functions\/v1\/(listen-play|press-file)$/.test(url.pathname)) return json(403, { error: "That isn't part of the demo." });
    return json(404, { message: "Not found" });
  }

  window.ART_DEMO.ready(answer);
} catch (err) {
  window.ART_DEMO.failed(err);
}
