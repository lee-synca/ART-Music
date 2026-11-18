/* A.R.T Control Centre — clickable demo.
   This copy has no server behind it. Everything the app would normally ask the backend
   is answered inside this page, from a small demo database that lives in the browser's
   memory (see backend.js). All the people and numbers are invented, nothing is sent
   anywhere, and it all resets when the page is reloaded.

   This file must load before the app: it points the app at a made-up address and
   catches every request to it. */
(function () {
  var API = "https://demo.invalid";
  window.ART_CENTRE = { url: API, key: "dev", editor: API };
  window.ART_DEMO = { api: API };

  // backend.js hands over the function that answers requests once the database is ready
  var ready = new Promise(function (resolve, reject) { window.ART_DEMO.ready = resolve; window.ART_DEMO.failed = reject; });
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf(API) !== 0) return realFetch(input, init);
    return ready.then(function (answer) { return answer(url.slice(API.length), init || {}); });
  };

  var say = function (text) {
    var t = document.getElementById("toast");
    if (!t) return alert(text);
    t.textContent = text; t.className = "toast on";
    clearTimeout(say.timer); say.timer = setTimeout(function () { t.className = "toast"; }, 4200);
  };
  window.ART_DEMO.say = say;

  // Links to pages that only exist once the centre is live (the public booking form,
  // press page, smart links, QR landing pages, the test inbox) explain themselves
  // instead of leading to a missing page.
  var LATER = /^\/(book|press|go|drop|listen|fans|unsubscribe)\//;
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    var u; try { u = new URL(a.href, location.href); } catch (_) { return; }
    if (u.origin + "" === API || (u.origin === location.origin && LATER.test(u.pathname))) {
      e.preventDefault();
      say("That page isn't part of this demo. It opens for real once the centre is switched on.");
    }
  }, true);

  document.addEventListener("DOMContentLoaded", function () {
    var bar = document.createElement("div");
    bar.className = "demobar";
    bar.innerHTML = "<b>Demo</b><span>Every person and number here is invented. Change anything you like: nothing is sent, and it all resets when you reload.</span>";
    document.body.prepend(bar);
    var veil = document.createElement("div");
    veil.className = "demoveil"; veil.id = "demoVeil";
    veil.innerHTML = "<div><div class='demoveil__spin'></div><p>Loading the demo…</p><small>First time takes a few seconds.</small></div>";
    document.body.append(veil);
    ready.then(function () { veil.remove(); }, function (err) {
      veil.innerHTML = "<div><p>The demo couldn't start in this browser.</p><small>Try a current version of Chrome, Safari, Edge or Firefox.</small></div>";
      if (window.console) console.error(err);
    });
  });
})();
