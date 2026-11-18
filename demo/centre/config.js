/* Demo copy of the client in /js/centre-config.js. The backend address is set by shim.js. */
/* Tiny client for the public pages (no library needed). */
window.ART_API = (function () {
  var c = window.ART_CENTRE;
  var ready = !!(c.url && c.key);
  function post(path, body) {
    return fetch(c.url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: c.key, Authorization: "Bearer " + c.key },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      if (r.status === 204) return null;
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) { var e = new Error((j && (j.message || j.error)) || "Something went wrong."); e.status = r.status; e.code = j && j.code; throw e; }
        return j;
      });
    });
  }
  return {
    ready: ready,
    rpc: function (name, args) { return post("/rest/v1/rpc/" + name, args); },
    fn: function (name, body) { return post("/functions/v1/" + name, body); },
    // artwork lives in a public storage bucket; full URLs pass straight through
    artwork: function (path) {
      if (!path) return "";
      return /^https?:\/\//.test(path) ? path : c.url + "/storage/v1/object/public/artwork/" + path;
    },
    // Replaces the built-in headline numbers on a page (elements marked data-stat="...")
    // with the latest ones a manager entered. If none were entered, or the backend
    // isn't connected, the built-in numbers simply stay.
    applySiteStats: function () {
      if (!ready) return;
      var els = document.querySelectorAll("[data-stat]"); if (!els.length) return;
      var fmt = function (v) { return v >= 1e6 ? (Math.floor(v / 1e5) / 10).toString() + "M+" : v >= 1e3 ? Math.floor(v / 1e3) + "K+" : String(v); };
      post("/rest/v1/rpc/site_stats", {}).then(function (s) {
        if (!s) return;
        Array.prototype.forEach.call(els, function (el) { var v = s[el.getAttribute("data-stat")]; if (typeof v === "number" && v > 0) el.textContent = fmt(v); });
      }).catch(function () {});
    },
    // Only show the visitor messages we wrote ourselves (validation errors).
    friendly: function (e, fallback) { return e && e.code === "22023" && e.message ? e.message : fallback; },
  };
})();
