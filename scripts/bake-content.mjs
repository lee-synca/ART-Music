// Build-time render of the News and Events sections into static HTML.
//
// The team edits data/art-news.json and data/art-events.json (via the admin
// editor). Those sections used to render client-side only, which meant non-JS
// crawlers — including AI answer engines (GPTBot, ClaudeBot, PerplexityBot) —
// saw two empty sections and missed the press coverage + live shows.
//
// This bakes the same card HTML that js/content.js produces directly into
// index.html between markers, so the content is in the raw HTML. js/content.js
// still runs as a fallback when the static content is absent.
//
// Run: node scripts/bake-content.mjs   (also runs in .github/workflows/bake-content.yml)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(root, "index.html");

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s) => esc(s).replace(/"/g, "&quot;");
const url = (s) => {
  s = String(s == null ? "" : s).trim();
  if (!s || s.charAt(0) === "#" || /^(https?:|mailto:|tel:)/i.test(s)) return s;
  return "https://" + s.replace(/^\/+/, "");
};

function eventCard(ev) {
  const ticket = ev.tickets_url && ev.tickets_url.trim()
    ? `<a class="btn btn--ink" href="${attr(url(ev.tickets_url))}" target="_blank" rel="noopener">Tickets</a>`
    : `<span class="btn btn--ink event__soon" aria-disabled="true">Tickets on sale soon</span>`;
  return `<div class="card event">` +
      `<a class="event__poster" href="${attr(ev.poster)}" target="_blank" rel="noopener" aria-label="View the ${attr(ev.name)} poster">` +
        `<img src="${attr(ev.poster)}" alt="${attr(ev.poster_alt)}">` +
      `</a>` +
      `<div class="event__body">` +
        `<div class="label label--coral">${esc(ev.eyebrow || "Upcoming")}</div>` +
        `<h3 class="event__name">${esc(ev.name)}</h3>` +
        `<div class="event__date">${esc(ev.date_display)}</div>` +
        `<div class="event__venue">${esc(ev.venue)}</div>` +
        (ev.lineup ? `<p class="event__lineup">${esc(ev.lineup)}</p>` : "") +
        `<div class="event__actions">${ticket}` +
          `<a class="btn btn--soft" href="#connect">Get show alerts</a>` +
        `</div>` +
      `</div>` +
    `</div>`;
}

function newsCard(n) {
  return `<article class="card news-card">` +
      `<img class="news-card__img" src="${attr(n.image)}" alt="${attr(n.image_alt)}">` +
      `<div class="news-card__body">` +
        `<div class="label label--coral">${esc(n.label)}</div>` +
        `<h3>${esc(n.headline)}</h3>` +
        (n.summary ? `<p>${esc(n.summary)}</p>` : "") +
        `<a class="news-card__link" href="${attr(url(n.link))}" target="_blank" rel="noopener">Read on ${esc(n.source)} &rarr;</a>` +
      `</div>` +
    `</article>`;
}

function readItems(file, key) {
  try {
    const data = JSON.parse(readFileSync(join(root, "data", file), "utf8"));
    return Array.isArray(data[key]) ? data[key] : [];
  } catch { return []; }
}

// Ensure the container has the marker pair, then replace what's between them.
function bake(html, containerId, name, cardsHtml) {
  const open = `<!-- AUTO:${name} -->`;
  const close = `<!-- /AUTO:${name} -->`;
  if (!html.includes(open)) {
    // First run: inject empty markers inside the (empty) container div.
    const emptyDiv = new RegExp(`(id="${containerId}">)(</div>)`);
    html = html.replace(emptyDiv, `$1${open}${close}$2`);
  }
  const between = new RegExp(`${open}[\\s\\S]*?${close.replace("/", "\\/")}`);
  return html.replace(between, `${open}\n          ${cardsHtml}\n          ${close}`);
}

let html = readFileSync(INDEX, "utf8");
const events = readItems("art-events.json", "events");
const news = readItems("art-news.json", "news");

html = bake(html, "events-list", "EVENTS", events.map(eventCard).join("\n          "));
html = bake(html, "news-grid", "NEWS", news.map(newsCard).join("\n          "));

writeFileSync(INDEX, html);
console.log(`Baked ${news.length} news item(s) and ${events.length} event(s) into index.html.`);
