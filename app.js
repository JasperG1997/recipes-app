/* Week Plan app: reads the built week (weekly/<Monday>/plan.built.json) and the recipe library
   (library/app-library.json), and writes menu picks back to the repo. With a GitHub token it uses the private repo; without one it reads the
   files next to it (a local preview served from the project root) and keeps writes on this phone. */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const DAYS = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const LABEL = { kcal: "Energy", protein: "Protein", carbs: "Carbohydrate", sugars: "Sugars", fat: "Fat", satfat: "Saturates", fibre: "Fibre", salt: "Salt",
  calcium: "Calcium", iron: "Iron", magnesium: "Magnesium", potassium: "Potassium", zinc: "Zinc", selenium: "Selenium",
  vitA: "Vitamin A", vitC: "Vitamin C", vitD: "Vitamin D", folate: "Folate", B12: "Vitamin B12" };
const GROUPS = [["Energy and macros", ["kcal", "protein", "carbs", "sugars", "fat", "satfat", "fibre", "salt"]],
  ["Minerals", ["calcium", "iron", "magnesium", "potassium", "zinc", "selenium"]],
  ["Vitamins", ["vitA", "vitC", "vitD", "folate", "B12"]]];
const MICROS = ["calcium", "iron", "magnesium", "potassium", "zinc", "selenium", "vitA", "vitC", "vitD", "folate", "B12"];
let P, IX = {}, REF, LIMITS, WEEK, NEXT, OPTIONS = null, THISLOG = {}, PLAN_OPTION = null;

/* ---------- settings and storage ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
const CFG = Object.assign({ owner: "JasperG1997", repo: "recipes", token: "" }, store.get("cfg", {}));
const REMOTE = !!CFG.token;
const ROOT = new URL("../", location.href).href; // the project root, for the local preview

/* ---------- reading and writing repo files ---------- */
const api = path => `https://api.github.com/repos/${encodeURIComponent(CFG.owner)}/${encodeURIComponent(CFG.repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
const auth = (accept = "application/vnd.github+json") => ({ Authorization: `Bearer ${CFG.token}`, Accept: accept });
const b64 = s => { const u = new TextEncoder().encode(s); let bin = ""; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(bin); };
const unb64 = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), c => c.charCodeAt(0)));

// returns { data, sha } or null when the file doesn't exist. Always fresh: GitHub lets a browser reuse a reply for
// 60 s, which showed the old week after a rebuild; with no signal the service worker's last copy is used
async function readJSON(path) {
  if (REMOTE) {
    const r = await fetch(api(path) + "?ref=main", { headers: auth(), cache: "no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(r.status === 401 ? "GitHub didn't accept the token" : `GitHub error ${r.status}`);
    const j = await r.json();
    const text = j.content ? unb64(j.content) : await (await fetch(api(path) + "?ref=main", { headers: auth("application/vnd.github.raw+json"), cache: "no-store" })).text();
    return { data: JSON.parse(text), sha: j.sha };
  }
  const local = store.get("local:" + path, null); // writes in the local preview stay on this device
  if (local) return { data: local, sha: null };
  const r = await fetch(ROOT + path, { cache: "no-cache" });
  if (!r.ok) return null;
  return { data: await r.json(), sha: null };
}
// a text file (Markdown) from the repo, or null
async function readText(path) {
  if (REMOTE) {
    const r = await fetch(api(path) + "?ref=main", { headers: auth("application/vnd.github.raw+json"), cache: "no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub error ${r.status}`);
    return r.text();
  }
  const r = await fetch(ROOT + path.split("/").map(encodeURIComponent).join("/"), { cache: "no-cache" });
  return r.ok ? r.text() : null;
}
async function writeJSON(path, mutate, message) {
  if (!REMOTE) {
    const cur = await readJSON(path);
    store.set("local:" + path, mutate(cur ? cur.data : null));
    return;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await readJSON(path);
    const body = { message, branch: "main", content: b64(JSON.stringify(mutate(cur ? cur.data : null), null, 2) + "\n") };
    if (cur) body.sha = cur.sha;
    const r = await fetch(api(path), { method: "PUT", headers: Object.assign(auth(), { "Content-Type": "application/json" }), body: JSON.stringify(body) });
    if (r.ok) return;
    if (r.status !== 409 && r.status !== 422) throw new Error(`GitHub error ${r.status}`);
  }
  throw new Error("The file changed on GitHub; try again");
}
const imgCache = {};
async function imgURL(path) {
  if (!REMOTE) return ROOT + path;
  if (!imgCache[path]) imgCache[path] = fetch(api(path) + "?ref=main", { headers: auth("application/vnd.github.raw+json") })
    .then(r => { if (!r.ok) throw 0; return r.blob(); }).then(b => URL.createObjectURL(b));
  return imgCache[path];
}
function hydrateImages(root = document) {
  root.querySelectorAll("img[data-path]").forEach(im => {
    const p = im.dataset.path; im.removeAttribute("data-path");
    imgURL(p).then(u => { im.src = u; }).catch(() => { im.removeAttribute("src"); });
  });
}

/* ---------- saving: a queue so taps made with no signal are sent later ---------- */
let queue = store.get("queue", []);
const OPS = {
  pick: o => [`weekly/${o.week}/log.json`, d => { d = d || { week: o.week }; d.pick = o.menu; d.picked_at = o.at; if (o.layout) { d.layout = o.layout; d.names = o.names; d.menu_name = o.menu_name; } return d; }, `App: pick menu ${o.menu}`]};
function enqueue(op) { queue.push(op); store.set("queue", queue); flush(); }
let flushing = false;
async function flush() {
  if (flushing || !queue.length) return syncLine();
  flushing = true;
  try {
    while (queue.length) {
      const [path, mutate, msg] = OPS[queue[0].type](queue[0]);
      await writeJSON(path, mutate, msg);
      queue.shift(); store.set("queue", queue);
    }
  } catch (e) { console.warn(e); }
  flushing = false; syncLine();
}
window.addEventListener("online", flush);
// Sync: send anything waiting, then load the latest plan, menus and library from GitHub
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-syncnow]"); if (!b) return;
  b.disabled = true; b.textContent = "Syncing…";
  await flush();
  location.reload();
});
function syncLine() {
  document.querySelectorAll("[data-sync]").forEach(el => {
    el.classList.toggle("warn", !REMOTE || queue.length > 0);
    const at = store.get("lastSync", null);
    el.textContent = !REMOTE ? "Local preview: changes stay on this device" : queue.length ? `${queue.length} change${queue.length > 1 ? "s" : ""} waiting for signal`
      : at ? `Last synced ${new Date(at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "Saved to GitHub";
  });
}

/* ---------- dates ---------- */
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function mondayOf(d) { const x = new Date(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; }
function addDays(s, n) { const x = new Date(s + "T12:00:00"); x.setDate(x.getDate() + n); return iso(x); }
const todayKey = () => KEYS[new Date().getDay()];
const longDate = s => new Date(s + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
const shortDate = s => new Date(s + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/* ---------- shared pieces (as on the plan page) ---------- */
function fmt(v, unit) { const d = v < 10 && unit !== "kcal" ? 1 : 0; return (+v).toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: 0 }) + (unit === "kcal" ? " kcal" : " " + unit); }
function stars(n, note) {
  n = n || 0;
  return `<span class="stars" title="${esc(note || "")}" aria-label="Technique ${n} out of 5">${"★".repeat(n)}<span class="off">${"★".repeat(5 - n)}</span><small>technique ${n}/5</small></span>`;
}
function donut(t, size = 92) {
  const p = t[IX.protein] * 4, c = t[IX.carbs] * 4, f = t[IX.fat] * 9, sum = p + c + f || 1;
  const r = 36, C = 2 * Math.PI * r, gap = 2.2; let off = 0;
  const seg = (v, col, name, g) => { const len = Math.max(0, v / sum * C - gap); const s = `<circle r="${r}" cx="46" cy="46" fill="none" stroke="var(${col})" stroke-width="14" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 46 46)"><title>${name}: ${Math.round(g)} g, ${Math.round(v / sum * 100)}% of energy</title></circle>`; off += v / sum * C; return s; };
  return `<svg viewBox="0 0 92 92" width="${size}" height="${size}" role="img" aria-label="Energy split: protein ${Math.round(p / sum * 100)}%, carbs ${Math.round(c / sum * 100)}%, fat ${Math.round(f / sum * 100)}%">
    ${seg(p, "--p", "Protein", t[IX.protein])}${seg(c, "--c", "Carbs", t[IX.carbs])}${seg(f, "--f", "Fat", t[IX.fat])}
    <text x="46" y="44" text-anchor="middle" font-family="var(--display)" font-size="17" fill="var(--ink)">${Math.round(t[IX.kcal])}</text>
    <text x="46" y="58" text-anchor="middle" font-family="var(--mono)" font-size="9" fill="var(--muted)">kcal</text></svg>`;
}
function macroBlock(t) {
  return `<div class="macro">${donut(t)}<ul class="legend">
    <li><i style="background:var(--p)"></i>Protein<span class="v">${Math.round(t[IX.protein])} g</span></li>
    <li><i style="background:var(--c)"></i>Carbs<span class="v">${Math.round(t[IX.carbs])} g</span></li>
    <li><i style="background:var(--f)"></i>Fat<span class="v">${Math.round(t[IX.fat])} g</span></li>
    <li><i style="background:var(--track)"></i>Fibre<span class="v">${Math.round(t[IX.fibre])} g</span></li></ul></div>`;
}
// how a day's nutrient is doing, as a colour: green when met (or a limit kept to), red when below or over a limit
function level(pc, lim) {
  const p = Math.round(pc);
  return (lim ? p <= 100 : p >= 100) ? "ok" : "bad";
}
// the vitamins and minerals something gives most of. Only a whole day is judged against the daily reference;
// one recipe or ingredient is never "below", so its chips are always green
function highlights(t, k = 3, judge = false) {
  const top = MICROS.map(m => [m, t[IX[m]] / REF[m] * 100]).sort((a, b) => b[1] - a[1]).slice(0, k).filter(x => x[1] >= 5);
  return top.length ? `<div class="chips">${top.map(([m, pc]) => `<span class="chip ${judge ? level(pc) : "ok"}">${LABEL[m]} <b>${Math.round(pc)}%</b></span>`).join("")}</div>` : "";
}
function changeHTML(text, c, was) {
  const t = esc(text), w = esc(was);
  if (c === "new") return `<span class="new">${t}</span>`;
  if (c === "swap") return `${w ? `<del>${w}</del> ` : ""}<ins>${t}</ins>`;
  if (c === "cut") return `<del>${w}</del>`;
  return t;
}
const photo = x => `weekly/${WEEK}/img/${x.img}`;
function workoutTable(w) {
  return `${w.note ? `<p class="note">${esc(w.note)}</p>` : ""}<table>${w.items.map(([e, s]) => `<tr><td>${esc(e)}</td><td>${esc(s)}</td></tr>`).join("")}</table>`;
}

/* ---------- recipes: overview, then a page per day, swiped left and right ---------- */
function overview() {
  const dinners = P.days.filter(d => d.dinner);
  return `<section class="page" id="sec-overview" data-day="overview"><div class="inner">
    <div class="eyebrow">${PLAN_OPTION ? esc(optionName(PLAN_OPTION)) : "This week"}</div><h1>Week of ${esc(longDate(P.week))}</h1>
    ${P.intro ? `<p class="lede">${esc(P.intro)}</p>` : ""}
    <div id="picks"></div>
    <div class="cards" style="margin-top:18px">${dinners.map(d => {
      const x = d.dinner;
      return `<article class="card">
        <div class="ph"><img data-path="${esc(photo(x))}" alt="${esc(x.name)}"><span class="badge">${DAYS[d.day]}</span></div>
        <div class="cb"><h4><a href="#sec-${d.day}">${esc(x.name)}</a></h4>
          ${stars(x.stars, x.star_note)}
          <div class="stat"><span><b>${x.total_min} min</b> total</span></div>
          <details class="ing"><summary>${x.items.filter(i => i.c !== "cut").length} ingredients${x.from ? "" : x.cook ? `, cooked for ${x.cook.portions}` : ", for 1"}</summary>
            <ul class="qty">${x.items.filter(i => i.c !== "cut").map(i => `<li>${i.left ? `<b>${esc(i.t)}</b>` : changeHTML(i.t, i.c, i.w)}</li>`).join("")}</ul></details>
        </div></article>`;
    }).join("")}</div><div class="syncbar" style="margin-top:24px"><span class="sync" data-sync></span><button class="btn" type="button" data-syncnow>Sync</button></div></div></section>`;
}
function ingList(items) {
  return `<ul class="ings">${items.map(i => {
    if (i.c === "cut" || !i.n) return `<li class="cutrow">${changeHTML(i.t, i.c, i.w)}</li>`;
    const n = i.n;
    return `<li><details><summary><span>${changeHTML(i.t, i.c, i.w)}</span><span class="k">${Math.round(n[IX.kcal])} kcal</span></summary>
      <div class="more"><span class="num">${i.g} g · protein ${fmt(n[IX.protein], "g")} · carbs ${fmt(n[IX.carbs], "g")} · fat ${fmt(n[IX.fat], "g")} · fibre ${fmt(n[IX.fibre], "g")} · salt ${fmt(n[IX.salt], "g")}</span>${highlights(n)}</div></details></li>`;
  }).join("")}</ul>`;
}
// every nutrient against the day's reference, two short lines each so it fits a phone: name, amount and
// verdict, then the bar
function nutrientTable(t, d) {
  const rows = GROUPS.map(([g, keys]) => `<h3 class="ngrp">${g}</h3>` + keys.map(k => {
    const v = t[IX[k]], ref = d.target && d.target[k] ? d.target[k] : REF[k], pc = v / ref * 100, lim = LIMITS.includes(k);
    const ok = lim ? Math.round(pc) <= 100 : Math.round(pc) >= 100; // judged on the percentage shown
    const lab = lim ? (ok ? "within limit" : "over limit") : (ok ? "met" : "below");
    return `<div class="nrow"><span class="nm">${LABEL[k]}${lim ? ' <span class="foot">(limit)</span>' : ""}</span>
      <span class="amt">${fmt(v, P.units[IX[k]])} / ${fmt(ref, P.units[IX[k]])}</span>
      <div class="bar" title="${Math.round(pc)}% of reference"><i class="${level(pc, lim)}" style="width:${Math.min(pc, 200) / 2}%"></i><span class="mark"></span></div>
      <span class="pill ${level(pc, lim)}">${Math.round(pc)}% ${lab}</span></div>`;
  }).join("")).join("");
  return `<div class="ntable">${rows}</div>
    <p class="foot">The line marks 100% of the daily reference; bars stop at 200%. Green means met, or a limit kept to; red means below, or over a limit. Figures are estimates from typical food values.</p>`;
}
// the whole day at a glance: macros and micros for the day, and one line per meal
function dayBreakdown(d) {
  const t = d.total, tg = d.target || {};
  const vs = (k, unit) => `<b>${Math.round(t[IX[k]]).toLocaleString("en-GB")}</b>${tg[k] ? ` / ${Number(tg[k]).toLocaleString("en-GB")}` : ""} ${unit}`;
  const meals = [["Breakfast", d.breakfast], ["Lunch", d.lunch], ["Dinner", d.dinner], ["Snacks", d.snacks]].filter(([, m]) => m);
  const wt = g => g >= 1 ? `${Math.round(g).toLocaleString("en-GB")} g` : g > 0 ? "<1 g" : "";
  // each item with its weight; dinner is one line, its ingredients are in the cook below
  const items = (l, m) => l === "Dinner"
    ? `<li><span>${esc(m.name)}</span><span class="g">${wt(m.items.reduce((s, i) => s + (i.c === "cut" ? 0 : i.g || 0), 0))}</span></li>`
    : m.items.filter(i => i.c !== "cut").map(i => `<li><span>${esc(i.t)}</span><span class="g">${wt(i.g)}</span></li>`).join("");
  return `<div class="panel daysum">
    <div class="stat">${vs("kcal", "kcal")}<span>${vs("protein", "g protein")}</span></div>
    ${macroBlock(t)}${highlights(t, 4, true)}
    <div class="meals">${meals.map(([l, m]) => `<section><div class="row"><span class="eyebrow">${l}</span><span class="mname">${esc(l === "Dinner" ? "" : m.name)}</span></div><ul class="mitems">${items(l, m)}</ul></section>`).join("")}${d.dinner ? "" : `<section><div class="row"><span class="eyebrow">Dinner</span><span class="mname">Free evening</span></div></section>`}</div>
    <details class="nut"><summary><h3 style="margin:0">All nutrients</h3></summary>${nutrientTable(t, d)}</details></div>`;
}
// the cook: small photo, technique, larder job, ingredients, method
function cookSection(d) {
  const x = d.dinner;
  const steps = (x.steps || []).filter(s => s.c !== "cut").concat(x.finish ? [{ t: x.finish, c: "" }] : []);
  return `<div class="panel cook">
    <div class="cookhead"><img data-path="${esc(photo(x))}" alt="${esc(x.name)}"><div><div class="eyebrow">Dinner · ${x.total_min} min</div><h3 class="dname">${esc(x.name)}</h3>${stars(x.stars, x.star_note)}</div></div>
    ${d.larder ? `<div class="larder"><b>Larder job:</b> ${esc(d.larder)}</div>` : ""}
    ${x.serves_note ? `<p class="foot" style="margin:0">${esc(x.serves_note)}</p>` : ""}
    <div><h3>Ingredients</h3><ul class="qty">${x.items.filter(i => i.c !== "cut").map(i => `<li>${i.left ? `<b>${esc(i.t)}</b> <span class="foot">(left over)</span>` : changeHTML(i.t, i.c, i.w)}</li>`).join("")}</ul></div>
    <div><h3>Method</h3><ol class="steps">${steps.map(s => `<li><span>${s.c === "swap" ? `<ins>${esc(s.t)}</ins>` : s.c === "new" ? `<span class="new">${esc(s.t)}</span>` : esc(s.t)}</span></li>`).join("")}</ol></div>
  </div>`;
}
function daySection(d) {
  return `<section class="page" id="sec-${d.day}" data-day="${d.day}"><div class="inner">
    <div class="day-title"><h2>${DAYS[d.day]}</h2><span class="eyebrow">${esc(shortDate(d.date))}</span></div>
    <div class="stack">${dayBreakdown(d)}
      ${d.fact ? `<p class="fact"><b>Food fact</b><span>${esc(d.fact)}</span></p>` : ""}
      ${d.dinner ? cookSection(d) : d.larder ? `<div class="larder"><b>Larder job:</b> ${esc(d.larder)}</div>` : ""}
    </div></div></section>`;
}
function renderRecipes() {
  const ids = [["overview", "Overview"]].concat(P.days.map(d => [d.day, DAYS[d.day].slice(0, 3)]));
  $("#dayPills").innerHTML = ids.map(([id, l]) => `<a href="#sec-${id}" data-pill="${id}">${l}</a>`).join("");
  $("#recipes").innerHTML = overview() + P.days.map(daySection).join("");
  renderPicks();
  hydrateImages($("#recipes"));
  markPill();
}
// the pager: one page per day; the pill for the page in view lights up
const pager = $("#recipes");
let pageAt = 0, pendingDay = null;
function goTo(id, smooth = true) {
  const el = $("#sec-" + id); if (!el) return;
  if (!pager.clientWidth) { pendingDay = id; return; } // Recipes is hidden: go there when it's shown
  pager.scrollTo({ left: el.offsetLeft, behavior: smooth ? "smooth" : "auto" });
}
function markPill() {
  const pages = pager.querySelectorAll(".page"); if (!pages.length || !pager.clientWidth) return;
  pageAt = Math.min(pages.length - 1, Math.round(pager.scrollLeft / pager.clientWidth));
  const id = pages[pageAt].dataset.day; if (id === markPill.cur) return;
  markPill.cur = id;
  const pills = $("#dayPills");
  pills.querySelectorAll("a").forEach(a => a.setAttribute("aria-current", a.dataset.pill === id));
  const a = pills.querySelector(`[data-pill="${id}"]`);
  // instant: a second smooth scroll would cancel the pager's in Chrome
  if (a) pills.scrollLeft = a.offsetLeft - pills.clientWidth / 2 + a.clientWidth / 2;
}
pager.addEventListener("scroll", markPill, { passive: true });
window.addEventListener("resize", () => { if (pager.clientWidth) pager.scrollLeft = pageAt * pager.clientWidth; });

/* ---------- picking a week's menu: this week's again, or next week's once its menus are out ---------- */
function renderPicks() {
  const el = $("#picks"); if (!el) return;
  let h = "";
  // a pick the built plan doesn't match yet: the rebuilding strip sits under the day pills, on every page
  const lay = THISLOG.layout;
  const rebuilding = (lay && P.days.some(d => d.dinner && lay[d.day] && lay[d.day] !== d.dinner.recipe)) || editPending();
  $("#rbSlot").innerHTML = rebuilding ? `<div class="rebuild" role="status" aria-live="polite"><span class="spin" aria-hidden="true"></span>
      <div class="rbtext"><div class="row"><b>${editPending() ? "Rebuilding with your workout change" : `Rebuilding ${esc(optionName(THISLOG.pick))}`}</b><span class="mono" id="rbLeft"></span></div>
        <div class="pbar"><i id="rbBar"></i></div>
        <button class="btn" type="button" id="rbRefresh" onclick="location.reload()" hidden style="margin-top:8px">Refresh</button></div></div>` : "";
  if (!rebuilding && P.quick_rebuild)
    h += `<p class="notice" style="margin:14px 0 0"><b>Quick rebuild.</b> Portions, snacks and the shopping list were worked out automatically from your pick. Ask Claude to rebuild the week for the Chef's full version.</p>`;
  h += `<div class="row" style="margin-top:14px;justify-content:flex-start"><button class="btn" type="button" data-openpicks="${WEEK}">Change this week's pick</button>`;
  if (OPTIONS) h += `<button class="btn primary" type="button" data-openpicks="${esc(OPTIONS.week)}">${OPTIONS._log.pick ? `Next week: ${esc(optionName(OPTIONS._log.pick))}` : "Pick next week's menu"}</button>`;
  el.innerHTML = h + `</div>`;
  if ($("#rbBar")) watchRebuild();
}
// the rebuild on GitHub: the job is picked up, the script runs and the new plan is saved (about 17 s from the
// tap in the first real runs). The bar runs on a 40 s estimate; every 5 s the app checks for the new plan and
// reloads when it has it.
const RB_EST = 40;
// a workout edit the built plan hasn't caught up with yet
const editPending = (plan = P) => !!THISLOG.edited_at && Date.parse(THISLOG.edited_at) > (Date.parse((plan.quick_rebuild || {}).at) || 0);
let rbTimer = null;
function watchRebuild() {
  clearInterval(rbTimer);
  const t0 = Math.max(Date.parse(THISLOG.picked_at) || 0, Date.parse(THISLOG.edited_at) || 0) || Date.now();
  let lastCheck = 0, done = false;
  const tick = async () => {
    const bar = $("#rbBar"); if (!bar || done) return clearInterval(rbTimer);
    const s = (Date.now() - t0) / 1000, left = RB_EST - s;
    bar.style.width = `${Math.min(95, Math.max(3, s / RB_EST * 100))}%`;
    $("#rbLeft").textContent = left > 60 ? `about ${Math.ceil(left / 60)} min left` : left > 5 ? `about ${Math.ceil(left / 5) * 5} s left` : s < 300 ? "almost there" : "taking longer than usual";
    $("#rbRefresh").hidden = s < 300;
    if (Date.now() - lastCheck < 5000) return;
    lastCheck = Date.now();
    try {
      const r = await readJSON(`weekly/${WEEK}/plan.built.json`);
      const lay = THISLOG.layout || {};
      if (r && r.data.days.every(d => !lay[d.day] || (d.dinner || {}).recipe === lay[d.day]) && !editPending(r.data)) {
        done = true; clearInterval(rbTimer);
        bar.style.width = "100%"; $("#rbLeft").textContent = "done";
        setTimeout(() => location.reload(), 700);
      }
    } catch (e) {}
  };
  tick(); rbTimer = setInterval(tick, 1000);
}
const PICKS = {}; // by week: the menus on show (the originals, or a reroll of all three) and the pick so far
const REROLL = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/></svg>`;
const sameDinners = (m, layout) => !!layout && m.dinners.every(d => layout[d.day] === d.recipe);
async function openPicks(week) {
  let st = PICKS[week];
  if (!st) {
    const [o, l] = await Promise.all([readJSON(`weekly/${week}/options.json`).catch(() => null), readJSON(`weekly/${week}/log.json`).catch(() => null)]);
    if (!o) return toast("No menus are saved for that week");
    const log = l ? l.data : {};
    // the menu the built plan came from, for this week
    const inPlan = week === WEEK && P ? (o.data.menus.find(m => m.dinners.every(d => (P.days.find(x => x.day === d.day) || {}).dinner?.recipe === d.recipe)) || {}).id : null;
    st = PICKS[week] = { week, opts: o.data, log, inPlan, round: 0, menus: o.data.menus };
    // a locked pick from an earlier reroll comes back as its own card
    if (log.layout && !o.data.menus.some(m => sameDinners(m, log.layout)))
      st.menus = [{ id: log.pick, locked: true,
        dinners: Object.keys(log.layout).map(day => ({ day, recipe: log.layout[day], name: (log.names || {})[day] || log.layout[day] })) }].concat(o.data.menus);
    st.sel = log.pick && st.menus.some(m => m.id === log.pick) ? log.pick : inPlan || null;
  }
  loadLibrary();
  drawPicks(st); openSub("picks");
}
const secondName = n => `${n}, second night`;
// menus are just Option A, B and C (a reroll's ids carry the round: A1, B1, C1)
const optionName = id => `Option ${String(id || "").slice(0, 1)}`;
// three fresh menus from the bench and the original dishes: each night keeps its slot (quick Monday, showpiece
// Wednesday, weeknights), no dish twice, and none of the dishes showing now unless the pool runs dry
function rerollAll(st) {
  const slots = st.opts.slots || { mon: "quick", tue: "weeknight", wed: "showpiece", thu: "weeknight" };
  const seen = new Set(), all = [];
  for (const b of (st.opts.bench || []).concat(st.opts.menus.flatMap(m => m.dinners.filter(d => !d.from).map(d => ({ recipe: d.recipe, name: d.name, slot: d.slot || slots[d.day], min: d.min })))))
    if (!seen.has(b.recipe)) { seen.add(b.recipe); all.push(b); }
  const shuffled = all.map(b => [Math.random(), b]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const showing = new Set(st.menus.flatMap(m => m.dinners.map(d => d.recipe))), used = new Set();
  const take = slot => shuffled.find(b => b.slot === slot && !used.has(b.recipe) && !showing.has(b.recipe))
    || shuffled.find(b => b.slot === slot && !used.has(b.recipe));
  st.round++;
  st.menus = ["A", "B", "C"].map(letter => {
    const dinners = [];
    for (const day of Object.keys(slots)) {
      if (slots[day] === "second night") { // Tuesday's big cook, made new on Thursday
        const t = dinners.find(d => d.day === "tue"); if (t) dinners.push({ day, slot: slots[day], recipe: t.recipe, name: secondName(t.name), from: "tue" });
        continue;
      }
      const b = take(slots[day]); if (!b) continue;
      used.add(b.recipe); dinners.push({ day, slot: slots[day], recipe: b.recipe, name: b.name, min: b.min });
    }
    return { id: `${letter}${st.round}`, dinners, rerolled: true };
  });
  st.sel = null;
}
function drawPicks(st) {
  const isThis = st.week === WEEK, label = m => optionName(m.id);
  $("#picksBody").innerHTML = `<div class="stack" style="padding:calc(6px + env(safe-area-inset-top, 0px)) 0 28px" data-week="${esc(st.week)}">
    <div><button class="btn" type="button" data-back>← Back</button></div>
    <div><div class="eyebrow">Week of ${esc(shortDate(st.week))}</div><h1>${isThis ? "This week's pick" : "Next week's pick"}</h1>
      <p class="lede" style="font-size:14px">Choose a menu, or reroll all three for a fresh set. Tap a dinner to see its recipe.</p></div>
    <div class="row" style="justify-content:flex-start"><button type="button" class="btn" data-rerollall>${REROLL} Reroll all three</button>
      ${st.round ? `<button type="button" class="btn" data-original>Back to the original three</button>` : ""}</div>
    <div class="pickcards">${st.menus.map(m => `<article class="pickcard" aria-current="${st.sel === m.id}">
      <div class="row"><b style="font:400 18px/1.25 var(--display)">${esc(label(m))}</b>${m.stars ? stars(m.stars) : ""}</div>
      ${st.inPlan === m.id ? `<span class="eyebrow" style="color:var(--accent-ink)">In your plan now</span>` : m.locked ? `<span class="eyebrow" style="color:var(--accent-ink)">Your locked pick</span>` : ""}
      ${m.dinners.map(d => `<div class="prow"><span class="d">${DAYS[d.day].slice(0, 3)}</span>
        <button type="button" class="nmb" data-rid="${esc(d.recipe)}">${esc(d.name)}${d.from ? `<span class="sw">Tuesday's cook, made new</span>` : ""}</button><span></span></div>`).join("")}
      <button type="button" class="btn choose${st.sel === m.id ? " primary" : ""}" data-choose="${esc(m.id)}">${st.sel === m.id ? "Chosen" : "Choose this menu"}</button></article>`).join("")}</div>
    <button type="button" class="btn primary big" data-lock ${st.sel ? "" : "disabled"}>${st.sel ? `Lock in ${esc(label(st.menus.find(m => m.id === st.sel)))}` : "Choose a menu first"}</button>
    <p class="foot" style="margin:0">Locking in rebuilds the ${isThis ? "week's days" : "week's plan"} and shopping list automatically, in a minute or two.</p></div>`;
}
$("#picksBody").addEventListener("click", e => {
  const st = PICKS[($("[data-week]", $("#picksBody")) || {}).dataset?.week]; if (!st) return;
  if (e.target.closest("[data-back]")) return history.back();
  const r = e.target.closest("[data-rid]"); if (r) return openRecipe(r.dataset.rid);
  if (e.target.closest("[data-rerollall]")) { rerollAll(st); window.scrollTo(0, 0); return drawPicks(st); }
  if (e.target.closest("[data-original]")) { st.round = 0; st.menus = st.opts.menus; st.sel = st.inPlan || null; return drawPicks(st); }
  const c = e.target.closest("[data-choose]"); if (c) { st.sel = c.dataset.choose; return drawPicks(st); }
  if (e.target.closest("[data-lock]") && st.sel) {
    const m = st.menus.find(x => x.id === st.sel);
    const layout = Object.fromEntries(m.dinners.map(d => [d.day, d.recipe])), names = Object.fromEntries(m.dinners.map(d => [d.day, d.name]));
    enqueue({ type: "pick", week: st.week, menu: st.sel, menu_name: optionName(st.sel), layout, names, at: new Date().toISOString() });
    st.log = Object.assign({}, st.log, { pick: st.sel, menu_name: optionName(st.sel), layout, names, picked_at: new Date().toISOString() });
    if (st.week === WEEK) THISLOG = st.log;
    if (OPTIONS && st.week === OPTIONS.week) OPTIONS._log = st.log;
    if (P) renderPicks();
    toast(`${optionName(st.sel)} locked in`); history.back();
  }
});
document.addEventListener("click", e => { const b = e.target.closest("[data-openpicks]"); if (b) openPicks(b.dataset.openpicks); });

/* ---------- workout view ---------- */
// the eater calls the push sessions skills days, without "+ compression"
const sessionName = s => String(s).replace(/\bPush\b/g, "Skills day").replace(/\s*\+\s*compression/i, "");
function renderWorkout() {
  const tk = todayKey();
  const inWeek = P && iso(new Date()) >= P.week && iso(new Date()) <= addDays(P.week, 6);
  $("#woEyebrow").textContent = P ? `Week of ${shortDate(P.week)}` : "Training";
  $("#workout").innerHTML = P ? P.days.map(d => {
    const w = P.workouts[d.workout]; if (!w) return "";
    const isToday = inWeek && d.day === tk;
    return `<details class="wday"${isToday ? " open" : ""}><summary><span class="tag${isToday ? " today-tag" : ""}">${DAYS[d.day]}${isToday ? " · today" : ""}</span>
      <svg class="chev" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      <span class="nm">${esc(sessionName(w.name))}</span></summary><div class="wo">${workoutTable(w)}
      <div class="woedit"><label class="field" style="margin:0">Session<select data-wsel="${d.day}">${Object.entries(P.workouts).map(([k, x]) => `<option value="${esc(k)}"${k === d.workout ? " selected" : ""}>${esc(sessionName(x.name))}</option>`).join("")}</select></label>
        <button type="button" class="btn" data-wedit="${esc(d.workout)}">Edit sets</button></div>
      <div class="wsets" hidden><textarea rows="${w.items.length + 1}" data-wrows="${esc(d.workout)}">${esc(w.items.map(([e, s]) => `${e} | ${s}`).join("\n"))}</textarea>
        <p class="foot">One exercise a line: name | sets × reps.</p><button type="button" class="btn primary" data-wsave="${esc(d.workout)}">Save sets</button></div></div></details>`;
  }).join("") + (editPending() ? `<p class="notice">Rebuilding the week with your change: the day's target, dinner, snacks and shopping list follow in about a minute.</p>` : "") : "";
}
OPS.workout = o => [`weekly/${o.week}/log.json`, d => {
  d = d || { week: o.week };
  if (o.day) d.workouts = Object.assign(d.workouts || {}, { [o.day]: o.key });
  if (o.rows) d.workout_items = Object.assign(d.workout_items || {}, { [o.key]: o.rows });
  d.edited_at = o.at; return d;
}, `App: workout ${o.day ? `${o.day} ${o.key}` : `sets for ${o.key}`}`];
function workoutEdit(op) {
  op.at = new Date().toISOString(); op.week = WEEK;
  enqueue(Object.assign({ type: "workout" }, op));
  THISLOG = Object.assign({}, THISLOG, { edited_at: op.at });
  renderWorkout(); renderPicks();
  toast("Saved: the week rebuilds in about a minute");
}
$("#workout").addEventListener("change", e => {
  const s = e.target.closest("[data-wsel]"); if (!s) return;
  const d = P.days.find(x => x.day === s.dataset.wsel); d.workout = s.value;
  workoutEdit({ day: d.day, key: s.value });
});
$("#workout").addEventListener("click", e => {
  const b = e.target.closest("[data-wedit]"); if (b) { const box = b.closest(".wo").querySelector(".wsets"); box.hidden = !box.hidden; return; }
  const sv = e.target.closest("[data-wsave]"); if (!sv) return;
  const key = sv.dataset.wsave, rows = sv.parentElement.querySelector("textarea").value.split("\n").map(l => l.split("|").map(x => x.trim())).filter(r => r[0]).map(r => [r[0], r[1] || ""]);
  P.workouts[key].items = rows;
  workoutEdit({ key, rows });
});

/* ---------- shopping ---------- */
let ticks = {};
function renderShop() {
  ticks = store.get("ticks:" + WEEK, {});
  $("#shopEyebrow").textContent = `Week of ${shortDate(P.week)}`;
  // one panel; each shop section split from the next by a gap and a rule
  $("#shop").innerHTML = `<div class="panel shop">${P.shopping.map((a, ai) => `<section class="aisle"><h3>${esc(a.aisle)}</h3><ul>${a.items.map((it, ii) => {
    const id = `s-${ai}-${ii}`;
    return `<li><label for="${id}"><input type="checkbox" id="${id}" ${ticks[id] ? "checked" : ""}><span>${esc(it)}</span></label></li>`;
  }).join("")}</ul></section>`).join("")}</div><p class="foot">Ticks are kept on this phone, so the list works with no signal.</p>`;
}
// the larder log (library/larder_log.json), for Choices' "This week's leftovers"
let LARDER = null;
async function loadLarder() {
  const r = await readJSON("library/larder_log.json").catch(() => null);
  LARDER = r ? r.data : { entries: {} };
}
$("#shop").addEventListener("change", e => { if (e.target.matches("input")) { ticks[e.target.id] = e.target.checked; store.set("ticks:" + WEEK, ticks); } });
$("#copyAll").addEventListener("click", () => {
  if (!P) return;
  const text = P.shopping.filter(a => !/meal deal/i.test(a.aisle)).flatMap(a => a.items).join("\n");
  try { navigator.clipboard.writeText(text).then(() => toast("List copied"), () => toast("Copy wasn't allowed here")); } catch (e) { toast("Copy wasn't allowed here"); }
});

/* ---------- recipes clicks: pills, overview links ---------- */
$("#dayPills").addEventListener("click", e => {
  const a = e.target.closest("a[data-pill]"); if (!a) return; e.preventDefault();
  goTo(a.dataset.pill);
});
$("#recipes").addEventListener("click", e => {
  const a = e.target.closest('a[href^="#sec-"]');
  if (a) { e.preventDefault(); goTo(a.getAttribute("href").slice(5)); }
});

/* ---------- library: every recipe, loaded the first time the tab opens ---------- */
let LIB = null, libCourse = "All", libLoading = null;
const DIETS = ["vegetarian", "vegan", "pescatarian", "gluten-free", "dairy-free"], dietOn = new Set();
function loadLibrary() {
  if (!libLoading) libLoading = readJSON("library/app-library.json").then(r => {
    if (!r) throw new Error("The library isn't in the repo yet. Ask Claude to build it.");
    LIB = r.data;
    if (!REF) REF = LIB.reference; // the plan's fields and reference, when there's no plan loaded
    if (!Object.keys(IX).length) LIB.fields.forEach((f, i) => IX[f] = i);
    $("#libCount").textContent = `${LIB.recipes.length} recipes`;
    $("#libCourses").innerHTML = ["All"].concat(LIB.courses.filter(c => c !== "Larder")).map(c => `<button type="button" data-course="${esc(c)}" aria-pressed="${c === libCourse}">${esc(c)}</button>`).join("");
    $("#libDiets").innerHTML = DIETS.map(d => `<button type="button" data-diet="${d}" aria-pressed="${dietOn.has(d)}">${d}</button>`).join("");
    renderLibList();
  }).catch(e => { libLoading = null; $("#libRows").innerHTML = `<li class="lede err" style="padding:16px 0">${esc(e.message || e)}</li>`; });
  return libLoading;
}
function libMeta(x) {
  const n = x.n;
  return [x.course, x.cuisine, x.time, x.scale, n.length ? `${Math.round(n[IX.kcal])} kcal · ${Math.round(n[IX.protein])} g protein` : ""].filter(Boolean).join(" · ");
}
function renderLibList() {
  if (!LIB) return;
  const words = $("#libSearch").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = LIB.recipes.filter(x => x.course !== "Larder" && (libCourse === "All" || x.course === libCourse) && [...dietOn].every(d => (x.diet || []).includes(d)) &&
    words.every(w => `${x.name} ${x.course} ${x.cuisine} ${x.time} ${x.ings.map(i => i[0]).join(" ")}`.toLowerCase().includes(w)));
  // recipes named for the search come before ones that only use it
  if (words.length) hits.sort((a, b) => words.some(w => b.name.toLowerCase().includes(w)) - words.some(w => a.name.toLowerCase().includes(w)));
  let html = "", last = null;
  for (const x of hits) {
    if (libCourse === "All" && !words.length && x.course !== last) { html += `<li class="grp">${esc(x.course)}</li>`; last = x.course; }
    html += `<li><button type="button" data-rid="${esc(x.id)}"><span class="nm">${esc(x.name)}</span><span class="mt">${esc(libMeta(x))}</span></button></li>`;
  }
  $("#libRows").innerHTML = html || `<li class="lede" style="padding:16px 0">No recipes match.</li>`;
}
// one recipe, opened from the Library, Choices or a menu
async function openRecipe(id) {
  await loadLibrary();
  const x = LIB && LIB.recipes.find(r => r.id === id); if (!x) return toast("That recipe isn't in the library");
  const steps = x.steps.filter(s => s[1] !== "cut").concat(x.finish ? [[x.finish, "", ""]] : []);
  $("#detailBody").innerHTML = `<div class="stack" style="padding:calc(6px + env(safe-area-inset-top, 0px)) 0 28px">
    <div><button class="btn" type="button" data-back>← Back</button></div>
    ${x.img ? `<img class="libhero" data-path="library/img/${esc(x.id)}.jpg" alt="${esc(x.name)}">` : ""}
    <div><div class="eyebrow">${esc([x.course, x.time, x.scale].filter(Boolean).join(" · "))}</div><h1>${esc(x.name)}</h1>${x.serves ? `<p class="lede">${esc(x.serves)}</p>` : ""}</div>
    ${(x.diet || []).length || (x.allergens || []).length ? `<div class="chips">${[x.cuisine].concat(x.diet || []).filter(Boolean).map(d => `<span class="chip ok">${esc(d)}</span>`).join("")}</div>
      ${(x.allergens || []).length ? `<p class="foot" style="margin:0">Contains: ${esc(x.allergens.join(", "))}. Tagged by script, so check the labels.</p>` : ""}` : ""}
    ${x.n.length ? `<div class="panel daysum"><h3 style="margin:0">${esc(x.basis || "Per portion")}</h3>${macroBlock(x.n)}${highlights(x.n, 4)}</div>` : ""}
    <div class="panel"><h3>Ingredients</h3><ul class="qty">${x.ings.filter(i => i[1] !== "cut").map(i => `<li>${changeHTML(i[0], i[1], i[2])}</li>`).join("")}</ul></div>
    <div class="panel"><h3>Method</h3><ol class="steps">${steps.map(s => `<li><span>${s[1] === "swap" ? `<ins>${esc(s[0])}</ins>` : s[1] === "new" ? `<span class="new">${esc(s[0])}</span>` : esc(s[0])}</span></li>`).join("")}</ol></div>
    ${x.url ? `<p class="foot">Original: <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.source || "source recipe")}</a></p>` : ""}</div>`;
  hydrateImages($("#detailBody"));
  openSub("detail");
}
$("#libSearch").addEventListener("input", renderLibList);
$("#libCourses").addEventListener("click", e => {
  const b = e.target.closest("[data-course]"); if (!b) return;
  libCourse = b.dataset.course;
  $("#libCourses").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b));
  renderLibList();
});
$("#libDiets").addEventListener("click", e => {
  const b = e.target.closest("[data-diet]"); if (!b) return;
  dietOn.has(b.dataset.diet) ? dietOn.delete(b.dataset.diet) : dietOn.add(b.dataset.diet);
  b.setAttribute("aria-pressed", dietOn.has(b.dataset.diet)); renderLibList();
});
$("#libRows").addEventListener("click", e => { const b = e.target.closest("[data-rid]"); if (b) openRecipe(b.dataset.rid); });
$("#detailBody").addEventListener("click", e => { if (e.target.closest("[data-back]")) history.back(); });

/* ---------- choices: what are you in the mood for? ten recipes that fit best ---------- */
const MEAT = /chicken|beef|lamb|pork|bacon|sausage|chorizo|\bham\b|turkey|mince|steak|duck|gammon|pancetta|lardon|nduja|oxtail|venison|black pudding|\bfish\b(?! sauce)|salmon|prawn|anchov|\bcod\b|haddock|mackerel|tuna|mussel|squid|sea bass|crab|scallop/;
const minsOf = x => { const t = x.time || "", h = /(\d+)\s*h/.exec(t), m = /(\d+)\s*m/.exec(t); return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0) || null; };
const hay = x => x._hay || (x._hay = `${x.name} ${x.tags.join(" ")} ${x.desc} ${x.ings.map(i => i[0]).join(" ")}`.toLowerCase());
const head = x => x._head || (x._head = `${x.name} ${x.tags.join(" ")}`.toLowerCase());
const kw = (...w) => x => w.some(k => hay(x).includes(k));
const MOODS = [
  ["quick", "Quick", x => { const m = minsOf(x); return !!m && m <= 30; }],
  ["comfort", "Comforting", kw("stew", "braise", "pie", "roast", "slow", "casserole", "ragu", "ragù", "mash", "gratin", "hotpot", "curry", "dumpling")],
  ["light", "Light and fresh", x => (x.n.length && x.n[IX.kcal] < 450) || kw("salad", "ceviche", "cucumber", "citrus", "slaw")(x)],
  ["protein", "High protein", x => x.n.length && x.n[IX.protein] >= 35],
  ["spicy", "Spicy", kw("chilli", "chili", "harissa", "nduja", "jalapeño", "jalapeno", "gochujang", "sriracha", "cayenne", "scotch bonnet", "chipotle", "hot sauce")],
  ["show", "Showpiece", x => { const m = minsOf(x); return (!!m && m >= 120) || kw("confit", "wellington", "terrine", "sous vide", "sous-vide")(x); }],
  ["indian", "Indian", kw("indian", "curry", "masala", "tikka", "garam", "tandoori", "dal", "biryani", "paneer", "korma")],
  ["italian", "Italian", kw("italian", "pasta", "risotto", "parmesan", "pancetta", "gnocchi", "polenta", "pesto", "lasagne", "cacciator", "ragu", "ragù")],
  ["asian", "East Asian", kw("japanese", "chinese", "korean", "thai", "vietnamese", "miso", "gochujang", "noodle", "teriyaki", "fish sauce", "lemongrass", "sichuan", "bulgogi", "soy sauce")],
  ["mideast", "Middle Eastern", kw("middle eastern", "moroccan", "lebanese", "turkish", "persian", "harissa", "za'atar", "zaatar", "sumac", "tahini", "pomegranate", "tagine", "shawarma", "kebab", "ras el hanout", "chermoula")],
  ["mexican", "Mexican", kw("mexican", "taco", "tortilla", "chipotle", "adobo", "enchilada", "quesadilla", "jalapeño", "jalapeno", "barbacoa")],
  ["french", "French", kw("french", "bourguignon", "coq au vin", "provençal", "provencal", "tarragon", "dijon", "chasseur", "confit", "boulangère", "boulangere")],
  ["british", "British", kw("british", "scottish", "english", "pie", "gravy", "crumble", "stovies", "hotpot", " ale")],
  ["chicken", "Chicken", kw("chicken")],
  ["beef", "Beef", kw("beef", "steak", "oxtail", "short rib", "ox cheek")],
  ["lamb", "Lamb", kw("lamb")],
  ["pork", "Pork", kw("pork", "bacon", "sausage", "chorizo", "gammon", "pancetta")],
  ["fish", "Fish", x => /\bfish\b(?! sauce)|salmon|prawn|\bcod\b|haddock|mackerel|tuna|mussel|squid|sea bass|crab|scallop/.test(hay(x))],
  ["veggie", "Veggie", x => !MEAT.test(hay(x))],
  ["sweet", "Something sweet", x => x.course === "Dessert" || x.course === "Baking"]
];
const moodOn = new Set();
let choiceList = [], choiceShown = 0;
$("#moods").innerHTML = MOODS.map(([id, label]) => `<button type="button" data-mood="${id}" aria-pressed="false">${label}</button>`).join("");
$("#moods").addEventListener("click", e => {
  const b = e.target.closest("[data-mood]"); if (!b) return;
  moodOn.has(b.dataset.mood) ? moodOn.delete(b.dataset.mood) : moodOn.add(b.dataset.mood);
  b.setAttribute("aria-pressed", moodOn.has(b.dataset.mood));
});
async function findChoices() {
  const sel = MOODS.filter(m => moodOn.has(m[0]));
  const words = $("#moodSearch").value.toLowerCase().split(/[\s,]+/).filter(w => w.length > 1);
  if (!sel.length && !words.length) return toast("Tap a mood or type what you fancy");
  await loadLibrary(); if (!LIB) return;
  // each mood met is worth 10; a typed word counts most in the name, then the tags, then the rest
  choiceList = LIB.recipes.filter(x => x.course !== "Larder").map(x => {
    let s = 0; const why = [];
    for (const [, label, test] of sel) if (test(x)) { s += 10; why.push(label); }
    for (const w of words) {
      const pts = x.name.toLowerCase().includes(w) ? 8 : head(x).includes(w) ? 5 : hay(x).includes(w) ? 3 : 0;
      if (pts) { s += pts; why.push(`"${w}"`); }
    }
    return { x, s, why, r: Math.random() }; // r: a fresh mix among equal fits each time
  }).filter(c => c.s > 0).sort((a, b) => b.s - a.s || a.r - b.r);
  choiceShown = 0; $("#choiceRows").innerHTML = "";
  moreChoices();
}
function moreChoices() {
  const next = choiceList.slice(choiceShown, choiceShown + 10);
  if (!choiceShown) $("#choiceRows").innerHTML = choiceList.length ? `<li class="grp">Best ${Math.min(10, choiceList.length)} of ${choiceList.length} matches</li>` : `<li class="lede" style="padding:12px 0">Nothing fits all of that. Try fewer moods.</li>`;
  $("#choiceRows").insertAdjacentHTML("beforeend", next.map(c => `<li><button type="button" data-rid="${esc(c.x.id)}"><span class="nm">${esc(c.x.name)}</span><span class="mt">${esc(libMeta(c.x))}</span><span class="why">${esc(c.why.join(" · "))}</span></button></li>`).join(""));
  choiceShown += next.length;
  $("#nextTen").hidden = choiceShown >= choiceList.length;
}
$("#findTen").addEventListener("click", findChoices);
$("#moodSearch").addEventListener("keydown", e => { if (e.key === "Enter") findChoices(); });
$("#nextTen").addEventListener("click", moreChoices);
$("#choiceRows").addEventListener("click", e => { const b = e.target.closest("[data-rid]"); if (b) openRecipe(b.dataset.rid); });

/* ---------- Markdown, for the Setup pages (profile, overview, guide, backlog): headings, lists, tables, bold, links ---------- */
const mdInline = s => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
const LISTRE = /^(\s*)([-*]|\d+\.)\s+(.*)/;
function md(text) {
  const lines = String(text).replace(/\r/g, "").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  let h = "", i = 0;
  while (i < lines.length) {
    const l = lines[i], m = /^(#{1,4})\s+(.*)/.exec(l);
    if (!l.trim()) { i++; continue; }
    if (m) { const n = Math.min(m[1].length + 1, 4); h += `<h${n}>${mdInline(m[2])}</h${n}>`; i++; continue; }
    if (/^\s*\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      h += `<div class="scroll"><table>${rows.filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map((r, k) => `<tr>${cells(r).map(c => k ? `<td>${mdInline(c)}</td>` : `<th>${mdInline(c)}</th>`).join("")}</tr>`).join("")}</table></div>`;
      continue;
    }
    if (LISTRE.test(l)) { // a list, nested by indent; indented lines without a marker carry on the item before
      const open = []; let out = "";
      while (i < lines.length && (LISTRE.test(lines[i]) || (open.length && /^\s{2,}\S/.test(lines[i])))) {
        const mm = LISTRE.exec(lines[i]), L = lines[i++];
        if (!mm) { out += " " + mdInline(L.trim()); continue; }
        const ind = mm[1].length, tag = /\d/.test(mm[2]) ? "ol" : "ul";
        if (!open.length || ind > open[open.length - 1][0]) { out += `<${tag}><li>`; open.push([ind, tag]); }
        else { while (open.length > 1 && ind < open[open.length - 1][0]) out += `</li></${open.pop()[1]}>`; out += "</li><li>"; }
        out += mdInline(mm[3]);
      }
      while (open.length) out += `</li></${open.pop()[1]}>`;
      h += out; continue;
    }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++].trim());
    h += `<p>${mdInline(para.join(" "))}</p>`;
  }
  return h;
}

/* ---------- Train > Setup: the eater's rules, Cooking for, the dated overview, the guide, skills, nutrients and
   improvements. Which repo file each page shows is in docs/app-pages.json, so a new overview needs no app change ---------- */
let PAGES = null, setupAt = store.get("setupPage", "considerations");
async function openSetup() {
  if (!PAGES) {
    const r = await readJSON("docs/app-pages.json").catch(() => null);
    if (!r) { $("#setupBody").innerHTML = `<p class="lede">The Setup pages aren't in the repo yet.</p>`; return; }
    PAGES = r.data.pages;
  }
  if (!PAGES.some(p => p.id === setupAt)) setupAt = PAGES[0].id;
  $("#setupPages").innerHTML = PAGES.map(p => `<button type="button" data-page="${esc(p.id)}" aria-pressed="${p.id === setupAt}">${esc(p.title)}</button>`).join("");
  const pg = PAGES.find(p => p.id === setupAt), body = $("#setupBody");
  body.innerHTML = `<p class="lede">Loading…</p>`;
  try {
    let h = "";
    if (pg.setup) h += await setupControls();
    if (pg.nutrients) h += nutrientTargets();
    if (pg.skills) h += (await Promise.all(pg.skills.map(async id => {
      const t = await readText(`.claude/skills/${id}/SKILL.md`), d = /description:\s*(.*)/.exec(t || "");
      return `<div class="panel" style="margin-bottom:10px"><h3>${esc(id)}</h3><p style="margin:0">${esc(d ? d[1] : "")}</p></div>`;
    }))).join("");
    if (pg.path) { const t = await readText(pg.path); h += t ? md(t) : `<p class="lede">${esc(pg.path)} isn't in the repo.</p>`; }
    if (pg.id !== setupAt) return; // another page was tapped meanwhile
    body.innerHTML = (pg.note ? `<p class="lede" style="font-size:14px">${esc(pg.note)}</p>` : "") + h;
  } catch (e) { body.innerHTML = `<p class="lede err">${esc(e.message || e)}</p>`; }
}
$("#setupPages").addEventListener("click", e => {
  const b = e.target.closest("[data-page]"); if (!b) return;
  setupAt = b.dataset.page; store.set("setupPage", setupAt); openSetup();
});
// setup.json: what the scripts read about the kitchen (Cooking for), set here by hand
let SETUP = null;
async function setupControls() {
  const r = await readJSON("setup.json").catch(() => null);
  SETUP = r ? r.data : { cooking_for: 1 };
  return `<div class="panel setrow"><div><h3 style="margin:0">Cooking for</h3><p class="foot" style="margin:2px 0 0">Recipes and the shopping list are scaled to this.</p></div>
    <div class="stepper"><button type="button" class="btn" data-cookfor="-1" aria-label="One fewer">−</button><b id="cookFor">${SETUP.cooking_for || 1}</b><button type="button" class="btn" data-cookfor="1" aria-label="One more">+</button></div></div>`;
}
$("#setupBody").addEventListener("click", e => {
  const b = e.target.closest("[data-cookfor]"); if (!b || !SETUP) return;
  const n = Math.max(1, Math.min(8, (SETUP.cooking_for || 1) + +b.dataset.cookfor));
  if (n === SETUP.cooking_for) return;
  SETUP.cooking_for = n; $("#cookFor").textContent = n;
  enqueue({ type: "setup", key: "cooking_for", value: n });
  toast(`Cooking for ${n}`);
});
OPS.setup = o => ["setup.json", d => Object.assign(d || {}, { [o.key]: o.value }), `App: ${o.key.replace("_", " ")} ${o.value}`];
// the day's targets, from the plan's reference (library/nutrients.json)
function nutrientTargets() {
  if (!REF) return `<p class="lede">Load a plan to see the targets.</p>`;
  const bw = REF.by_workout || {}, lim = REF.limits || [];
  const rows = GROUPS.map(([g, keys]) => `<tr><th colspan="2">${g}</th></tr>` + keys.filter(k => REF[k] != null).map(k => {
    const u = P ? P.units[IX[k]] : "";
    return `<tr><td>${LABEL[k]}${lim.includes(k) ? ' <span class="foot">(limit)</span>' : ""}</td><td>${fmt(REF[k], u)}${Object.entries(bw).filter(([, t]) => t[k]).map(([w, t]) => `<br><span class="foot">${esc(w)}: ${fmt(t[k], u)}</span>`).join("")}</td></tr>`;
  }).join("")).join("");
  return `<div class="panel"><h3>Daily targets</h3><div class="scroll"><table class="tgt">${rows}</table></div>${REF.note ? `<p class="foot">${esc(REF.note)}</p>` : ""}</div>`;
}

/* ---------- Train > Engine: how the parts fit, and who runs each one ---------- */
const ENGINE = [
  ["Scouts", "ai", "Find real recipes in any language, from five-star chefs and books; translated, metric, original link kept."],
  ["Discover", "you", "You swipe: right keep, left skip. Up to 1,000 cards wait in the queue."],
  ["Library + Chef", "ai", "Keeps are filed; the Chef writes each one's revision with techniques from the books and the technique bank."],
  ["Weekly pick", "you", "Three menus, scaled to Cooking for. You lock one in; a free script rebuilds the week on GitHub."],
  ["Shopping + larder jobs", "script", "The list by aisle and by pack; spare food becomes larder jobs."],
  ["End-of-week wrap-up", "script", "The last cook day turns what's left into jobs that keep over the weekend."]];
const LOOPS = ["Your swipes steer the Scouts.", "Discover queue under 50: Claude Code suggests a Scout session.", "Each week: three new menus.",
  "Leftovers go to the larder through the wrap-up.", "The larder feeds the Chef."];
function renderEngine() {
  const who = { ai: "Claude Code (AI)", you: "You, in the app", script: "Free script" };
  $("#engine").innerHTML = `<div class="engine">${ENGINE.map(([n, w, t], k) => `${k ? `<div class="arrow" aria-hidden="true">↓</div>` : ""}
    <div class="panel estep ${w}"><div class="row"><b>${esc(n)}</b><span class="who">${who[w]}</span></div><p>${esc(t)}</p></div>`).join("")}</div>
    <div class="panel" style="margin-top:16px"><h3>Loops</h3><ul class="loops">${LOOPS.map(l => `<li>${esc(l)}</li>`).join("")}</ul>
    <p class="foot">All AI work happens in Claude Code on the subscription; the app and GitHub run free scripts only.</p></div>`;
}

/* ---------- Discover: the Scouts' finds as cards; right keeps, left skips. Swipes are saved together a few seconds
   after the last one (one commit, not one per card); add_keeps.py files the keeps in a Claude Code session ---------- */
let DQ = null, dLoading = null, SWIPED = {}, dPending = store.get("dPending", {}), dHist = [], dTimer = null;
OPS.swipes = o => ["library/discover/swipes.json", d => {
  d = d || {};
  for (const [id, v] of Object.entries(o.batch)) { if (v) d[id] = v; else delete d[id]; } // null: an undo
  return d;
}, `App: ${Object.keys(o.batch).length} Discover swipe${Object.keys(o.batch).length > 1 ? "s" : ""}`];
function saveSwipes() {
  clearTimeout(dTimer);
  if (!Object.keys(dPending).length) return;
  enqueue({ type: "swipes", batch: dPending });
  for (const [id, v] of Object.entries(dPending)) { if (v) SWIPED[id] = v; else delete SWIPED[id]; }
  dPending = {}; store.set("dPending", dPending);
}
document.addEventListener("visibilitychange", () => { if (document.hidden) saveSwipes(); });
function loadDiscover() {
  if (!dLoading) dLoading = Promise.all([readJSON("library/discover/queue.json"), readJSON("library/discover/swipes.json")])
    .then(([q, s]) => { DQ = q ? q.data : { items: [] }; SWIPED = s ? s.data : {}; drawDiscover(); })
    .catch(e => { dLoading = null; $("#discover").innerHTML = `<p class="lede err">${esc(e.message || e)}</p>`; });
  return dLoading;
}
function renderDiscover() {
  if (DQ) return drawDiscover();
  $("#discover").innerHTML = `<p class="lede">Loading the queue…</p>`; loadDiscover();
}
const swiped = id => id in dPending ? dPending[id] : SWIPED[id];
const waitingCards = () => DQ.items.filter(x => !swiped(x.id));
function drawDiscover() {
  const left = waitingCards(), x = left[0];
  $("#discEyebrow").textContent = `${left.length.toLocaleString("en-GB")} of ${(DQ.max || 1000).toLocaleString("en-GB")} waiting`;
  const low = left.length < 50 ? `<p class="notice" style="margin:14px 0 0">${left.length ? "Under 50 left." : "The queue is empty."} Ask Claude Code for a Scout run ("find recipes") to top it up.</p>` : "";
  const btns = `<div class="dbtns"><button type="button" class="dbtn skip" data-swipe="skip" aria-label="Skip"${x ? "" : " disabled"}>✕</button>
    <button type="button" class="btn" data-undo${dHist.length ? "" : " disabled"}>Undo</button>
    <button type="button" class="dbtn keep" data-swipe="keep" aria-label="Keep"${x ? "" : " disabled"}>♥</button></div>`;
  $("#discover").innerHTML = (x ? `<div class="deck">${cardHTML(x)}</div>` : "") + btns + low + `<p class="sync" data-sync style="margin-top:12px"></p>`;
  syncLine();
}
function cardHTML(x) {
  const meta = [x.course, x.min ? `${x.min} min` : "", x.kcal ? `${x.kcal} kcal` : "", x.protein ? `${x.protein} g protein` : ""].filter(Boolean).join(" · ");
  return `<article class="dcard" data-id="${esc(x.id)}">
    <div class="dph"><img src="${esc(x.img)}" alt="${esc(x.name)}" referrerpolicy="no-referrer" draggable="false" onerror="this.remove()">
      <span class="stamp keep">Keep</span><span class="stamp skip">Skip</span></div>
    <div class="dbody"><h2>${esc(x.name)}</h2>
      <div class="mt">${esc([x.chef, x.site].filter(Boolean).join(" · "))}</div>
      ${x.stars ? stars(x.stars) : ""}
      <div class="mt">${esc(meta)}</div>
      ${x.why ? `<p>${esc(x.why)}</p>` : ""}
      ${x.ings && x.ings.length ? `<details class="ing"><summary>${x.ings.length} ingredients</summary><ul class="qty">${x.ings.map(i => `<li>${esc(i)}</li>`).join("")}</ul></details>` : ""}
      <a href="${esc(x.url)}" target="_blank" rel="noopener" class="foot">Open the original${x.lang && x.lang !== "en" ? ` (${esc(x.lang)})` : ""}</a></div></article>`;
}
function decide(v) {
  const x = DQ && waitingCards()[0]; if (!x) return;
  const card = $(".dcard"), go = () => {
    dPending[x.id] = { d: v, at: new Date().toISOString(), name: x.name, url: x.url };
    store.set("dPending", dPending); dHist.push(x.id);
    clearTimeout(dTimer); dTimer = setTimeout(saveSwipes, 4000);
    drawDiscover();
  };
  if (!card || matchMedia("(prefers-reduced-motion: reduce)").matches) return go();
  card.style.transition = "transform .22s ease-in, opacity .22s"; card.style.opacity = "0";
  card.style.transform = `translateX(${v === "keep" ? 120 : -120}%) rotate(${v === "keep" ? 14 : -14}deg)`;
  setTimeout(go, 200);
}
function undoSwipe() {
  const id = dHist.pop(); if (!id) return;
  if (id in dPending && dPending[id]) delete dPending[id];
  else { dPending[id] = null; clearTimeout(dTimer); dTimer = setTimeout(saveSwipes, 4000); } // already saved: take it back out
  store.set("dPending", dPending);
  if (DQ) { const k = DQ.items.findIndex(x => x.id === id); if (k > 0) DQ.items.unshift(DQ.items.splice(k, 1)[0]); }
  drawDiscover();
}
$("#discover").addEventListener("click", e => {
  const b = e.target.closest("[data-swipe]"); if (b) return decide(b.dataset.swipe);
  if (e.target.closest("[data-undo]")) undoSwipe();
});
document.addEventListener("keydown", e => {
  if (current !== "discover" || e.target.matches("input, textarea")) return;
  if (e.key === "ArrowRight") decide("keep"); else if (e.key === "ArrowLeft") decide("skip");
});
// dragging the card: it follows the finger and tilts; past a third of its width it goes that way
let drag = null;
$("#discover").addEventListener("pointerdown", e => {
  const card = e.target.closest(".dcard"); if (!card || e.target.closest("a, summary, details[open] ul")) return;
  drag = { card, x0: e.clientX, y0: e.clientY, dx: 0, on: false, id: e.pointerId };
});
$("#discover").addEventListener("pointermove", e => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (!drag.on) { if (Math.abs(dx) < 8 || Math.abs(dy) > Math.abs(dx)) { if (Math.abs(dy) > 12) drag = null; return; } drag.on = true; drag.card.setPointerCapture(e.pointerId); }
  drag.dx = dx;
  drag.card.style.transition = "none";
  drag.card.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
  drag.card.style.setProperty("--keep", Math.max(0, Math.min(1, dx / 90)));
  drag.card.style.setProperty("--skip", Math.max(0, Math.min(1, -dx / 90)));
});
const endDrag = e => {
  if (!drag || e.pointerId !== drag.id) return;
  const { card, dx, on } = drag; drag = null; if (!on) return;
  if (Math.abs(dx) > card.clientWidth / 3) return decide(dx > 0 ? "keep" : "skip");
  card.style.transition = "transform .2s"; card.style.transform = "";
  card.style.setProperty("--keep", 0); card.style.setProperty("--skip", 0);
};
$("#discover").addEventListener("pointerup", endDrag);
$("#discover").addEventListener("pointercancel", endDrag);

/* ---------- Train > Progressions: the skill ladders (library/progressions.json), where the eater is on each
   (log/progressions.json), and a tip for every step ---------- */
let PROG = null, PROGAT = null;
async function renderProgress() {
  if (!PROG) {
    $("#progress").innerHTML = `<p class="lede">Loading…</p>`;
    const [l, at] = await Promise.all([readJSON("library/progressions.json").catch(() => null), readJSON("log/progressions.json").catch(() => null)]);
    if (!l) { $("#progress").innerHTML = soon("Progressions", "The ladders aren't in the repo yet."); return; }
    PROG = l.data.ladders; PROGAT = at ? at.data.current || {} : {};
  }
  $("#progress").innerHTML = `<p class="lede" style="font-size:14px;margin:0">Tap a step to mark where you are; earlier steps count as done. Tap Tip for the cue that matters.</p>` +
    PROG.map(L => {
      const cur = PROGAT[L.id] ?? 0;
      return `<details class="panel ladder"${L.id === PROG.openId ? " open" : ""}><summary><b>${esc(L.name)}</b><span class="eyebrow">${esc(L.steps[cur] ? L.steps[cur].name : "")}</span></summary>
        <ol class="ladsteps">${L.steps.map((s, i) => `<li class="${i < cur ? "done" : i === cur ? "cur" : ""}">
          <button type="button" class="stepbtn" data-lad="${esc(L.id)}" data-step="${i}"><span class="dot">${i < cur ? "✓" : i + 1}</span><span>${esc(s.name)}</span></button>
          <button type="button" class="btn tipbtn" data-tip>Tip</button><p class="tip" hidden>${esc(s.tip)}</p></li>`).join("")}</ol></details>`;
    }).join("");
}
OPS.prog = o => ["log/progressions.json", d => { d = d || { current: {} }; d.current = Object.assign(d.current || {}, { [o.lad]: o.step }); return d; }, `App: ${o.lad} at step ${o.step + 1}`];
$("#progress").addEventListener("click", e => {
  const t = e.target.closest("[data-tip]"); if (t) { const p = t.nextElementSibling; p.hidden = !p.hidden; return; }
  const b = e.target.closest("[data-lad]"); if (!b) return;
  const lad = b.dataset.lad, step = +b.dataset.step;
  PROGAT[lad] = step; PROG.openId = lad;
  enqueue({ type: "prog", lad, step });
  renderProgress();
});

/* ---------- Train > Stats and goals: set by hand, not tracked. Saved to setup.json; the energy and protein goals
   become the plan's targets, and the week is rebuilt on GitHub ---------- */
async function renderStats() {
  const r = await readJSON("setup.json").catch(() => null);
  SETUP = r ? r.data : { cooking_for: 1 };
  const st = SETUP.stats || {}, g = SETUP.goals || {}, w = g.weight_kg || ["", ""], sp = ((g.by_workout || {}).sprints || {}).kcal || "";
  const f = (name, label, v, unit) => `<label class="field">${label}<span class="unit"><input name="${name}" inputmode="decimal" value="${esc(v ?? "")}">${unit ? `<i>${unit}</i>` : ""}</span></label>`;
  $("#stats").innerHTML = `<form id="statsForm" class="stack" style="gap:14px">
    <div class="panel"><h3>Stats</h3><div class="grid3">${f("height_cm", "Height", st.height_cm, "cm")}${f("weight_kg", "Weight", st.weight_kg, "kg")}${f("age", "Age", st.age, "")}</div></div>
    <div class="panel"><h3>Goals</h3><div class="grid3">${f("w_lo", "Weight from", w[0], "kg")}${f("w_hi", "to", w[1], "kg")}<span></span>
      ${f("kcal", "Energy a day", g.kcal, "kcal")}${f("protein", "Protein a day", g.protein, "g")}${f("sprint", "Sprint day", sp, "kcal")}</div>
      <label class="field">Other goals, one a line<textarea name="other" rows="3">${esc((g.other || []).join("\n"))}</textarea></label></div>
    <button class="btn primary big" type="submit">Save</button>
    <p class="foot" style="margin:0">Set by hand, not tracked. Saving new targets rebuilds this week's plan on GitHub in about a minute.</p></form>`;
}
OPS.goals = o => ["setup.json", d => Object.assign(d || {}, { stats: o.stats, goals: o.goals }), "App: stats and goals"];
$("#stats").addEventListener("submit", e => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.target)), num = x => x === "" || x == null ? null : +x;
  const stats = { height_cm: num(v.height_cm), weight_kg: num(v.weight_kg), age: num(v.age) };
  const goals = Object.assign({}, SETUP.goals, { weight_kg: [num(v.w_lo), num(v.w_hi)], kcal: num(v.kcal), protein: num(v.protein),
    by_workout: Object.assign({}, (SETUP.goals || {}).by_workout, { sprints: { kcal: num(v.sprint) } }),
    other: v.other.split("\n").map(s => s.trim()).filter(Boolean) });
  SETUP.stats = stats; SETUP.goals = goals;
  enqueue({ type: "goals", stats, goals });
  toast("Saved");
});

/* ---------- Repertoire > Events: cooking for friends. The app saves the brief (events/<id>/event.json); a free
   GitHub Action builds the menu from the library, scaled, with its own shopping list and countdown
   (event.built.json). Claude Code's plan-event skill refines it ---------- */
let EVX = null;
OPS.event = o => [`events/${o.id}/event.json`, d => Object.assign(d || {}, o.data), `App: event ${o.id}`];
OPS.eventIndex = o => ["events/index.json", d => {
  d = d || { events: [] };
  d.events = d.events.filter(e => e.id !== o.entry.id).concat([o.entry]).sort((a, b) => a.date.localeCompare(b.date));
  return d;
}, `App: event list (${o.entry.id})`];
async function renderEvents() {
  const r = await readJSON("events/index.json").catch(() => null);
  EVX = r ? r.data.events : [];
  const today = iso(new Date());
  const up = EVX.filter(e => e.date >= today), past = EVX.filter(e => e.date < today).reverse();
  const row = e => `<li><button type="button" data-event="${esc(e.id)}"><span class="nm">${esc(e.occasion)}</span><span class="mt">${esc(longDate(e.date))} · ${e.headcount} people · ${esc(e.formality)}</span></button></li>`;
  $("#events").innerHTML = `<p class="lede" style="font-size:14px;margin:0">A menu from the library for the occasion, scaled to everyone, with its own shopping list and a countdown.</p>
    <details class="panel" style="margin-top:12px"${EVX.length ? "" : " open"}><summary><b>New event</b></summary>
      <form id="eventForm" style="margin-top:10px">
        <label class="field">Occasion<input name="occasion" required placeholder="Friends for dinner"></label>
        <div class="grid3"><label class="field">Date<input name="date" type="date" required value="${addDays(today, 7)}"></label>
          <label class="field">Serve at<input name="time" type="time" value="19:30"></label>
          <label class="field">People<input name="headcount" type="number" min="1" max="30" value="6"></label></div>
        <label class="field">Formality<select name="formality"><option value="casual">Casual: sharing dishes</option><option value="smart" selected>Smart</option><option value="formal">Formal: more technique</option></select></label>
        <div class="field">Courses<div class="chips">${["Starter", "Main", "Side", "Dessert"].map(c => `<label class="chk"><input type="checkbox" name="courses" value="${c}" checked> ${c}</label>`).join("")}</div></div>
        <button class="btn primary big" type="submit">Plan the menu</button></form></details>
    ${up.length ? `<h3 style="margin-top:18px">Coming up</h3><ul class="librows">${up.map(row).join("")}</ul>` : ""}
    ${past.length ? `<h3 style="margin-top:18px">Past</h3><ul class="librows">${past.map(row).join("")}</ul>` : ""}`;
}
$("#events").addEventListener("submit", e => {
  e.preventDefault();
  const f = new FormData(e.target), v = Object.fromEntries(f);
  const id = `${v.date}-${v.occasion.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "event"}`;
  const data = { id, occasion: v.occasion, date: v.date, time: v.time, headcount: +v.headcount, formality: v.formality,
    courses: f.getAll("courses"), seed: 0, saved_at: new Date().toISOString() };
  enqueue({ type: "event", id, data });
  enqueue({ type: "eventIndex", entry: { id, occasion: data.occasion, date: data.date, headcount: data.headcount, formality: data.formality } });
  openEvent(id, data);
});
$("#events").addEventListener("click", e => { const b = e.target.closest("[data-event]"); if (b) openEvent(b.dataset.event); });
let evTimer = null;
async function openEvent(id, fresh) {
  clearInterval(evTimer);
  const [ev, built] = fresh ? [{ data: fresh }, null] : await Promise.all([readJSON(`events/${id}/event.json`).catch(() => null), readJSON(`events/${id}/event.built.json`).catch(() => null)]);
  if (!ev) return toast("That event isn't in the repo");
  drawEvent(ev.data, built && built.data);
  if (!stack.includes("event") && current !== "event") openSub("event");
  // the menu is built on GitHub in about a minute: check every 5 s until it's in
  if (!built || Date.parse(built.data.built_at) < Date.parse(ev.data.saved_at || 0)) evTimer = setInterval(async () => {
    if (current !== "event") return clearInterval(evTimer);
    const b = await readJSON(`events/${id}/event.built.json`).catch(() => null);
    if (b && Date.parse(b.data.built_at) >= Date.parse(ev.data.saved_at || 0)) { clearInterval(evTimer); drawEvent(ev.data, b.data); }
  }, 5000);
}
function drawEvent(ev, b) {
  const when = s => {
    const t = new Date(s), days = Math.round((new Date(iso(t) + "T12:00:00") - new Date(iso(new Date()) + "T12:00:00")) / 864e5);
    return `${days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : t.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  };
  $("#eventBody").innerHTML = `<div class="stack" style="padding:calc(6px + env(safe-area-inset-top, 0px)) 0 28px" data-evid="${esc(ev.id)}">
    <div><button class="btn" type="button" data-back>← Back</button></div>
    <div><div class="eyebrow">${esc(longDate(ev.date))} · ${esc(ev.time || "")} · ${ev.headcount} people · ${esc(ev.formality)}</div><h1>${esc(ev.occasion)}</h1></div>
    ${!b || Date.parse(b.built_at) < Date.parse(ev.saved_at || 0) ? `<div class="rebuild"><span class="spin" aria-hidden="true"></span><div class="rbtext"><b>Building the menu</b><div class="foot" style="margin:2px 0 0">On GitHub, in about a minute${REMOTE ? "" : " (the local preview can't build it: run build_event.py)"}.</div></div></div>` : `
    ${b.gaps && b.gaps.length ? `<p class="notice">Nothing in the library fits the ${esc(b.gaps.join(" and ").toLowerCase())}. Ask Claude Code to plan the event: it sends the Scouts.</p>` : ""}
    <div class="panel"><h3>Menu</h3><div class="evmenu">${b.dishes.map(d => `<div class="evdish"><span class="eyebrow">${esc(d.course)}</span>
      <button type="button" class="nmb" data-rid="${esc(d.recipe)}">${esc(d.name)}</button><span class="foot">${esc(d.cuisine || "")} · cooked for ${d.cooked_for} (the recipe serves ${d.serves})${d.make_ahead ? " · make ahead" : ""}</span>
      <details class="ing"><summary>Ingredients for ${d.cooked_for}</summary><ul class="qty">${d.ings.map(i => `<li>${changeHTML(i[0], i[1], i[2])}</li>`).join("")}</ul></details></div>`).join("")}</div>
      <button type="button" class="btn" data-another style="margin-top:12px">${REROLL} Another menu</button></div>
    <div class="panel"><h3>Countdown</h3><ol class="countdown">${b.timeline.map(t => `<li class="${t.at < new Date().toISOString().slice(0, 16) ? "past" : ""}"><span class="mono">${esc(when(t.at))}</span><span>${esc(t.what)}</span></li>`).join("")}</ol></div>
    <div class="panel shop">${b.shopping.map(a => `<section class="aisle"><h3>${esc(a.aisle)}</h3><ul>${a.items.map(x => `<li>${esc(x)}</li>`).join("")}</ul></section>`).join("")}</div>
    <p class="foot" style="margin:0">The event's shopping is its own list, apart from the weekly shop.</p>`}</div>`;
}
$("#eventBody").addEventListener("click", e => {
  if (e.target.closest("[data-back]")) return history.back();
  const r = e.target.closest("[data-rid]"); if (r) return openRecipe(r.dataset.rid);
  if (e.target.closest("[data-another]")) {
    const id = $("[data-evid]", $("#eventBody")).dataset.evid;
    readJSON(`events/${id}/event.json`).then(r => {
      const data = Object.assign({}, r.data, { seed: (r.data.seed || 0) + 1, menu: {}, saved_at: new Date().toISOString() });
      enqueue({ type: "event", id, data }); openEvent(id, data); toast("A new menu is on its way");
    });
  }
});

/* ---------- Repertoire > Choices: feed in what needs using up. Typed words are matched to library recipes and
   larder jobs here, by script; photos are saved to the repo for the next Claude Code session to look at ---------- */
let LARDERJOBS = null;
async function useUp() {
  const words = $("#surplus").value.toLowerCase().split(/[\n,;]+|\s+and\s+/).map(w => w.replace(/^\s*[\d.½¼¾]+\s*(g|kg|ml|x)?\s*/, "").trim()).filter(w => w.length > 2);
  if (!words.length) return toast("Type what needs using up");
  await loadLibrary(); if (!LIB) return;
  if (!LARDERJOBS) LARDERJOBS = ((await readJSON("library/larder.json").catch(() => null)) || { data: { jobs: [] } }).data.jobs;
  // "half a bunch of parsley" is looked for as parsley when the whole phrase isn't there
  const stem = w => w.replace(/^(half|a|an|some|spare|leftover|the) .*?of\s+/, "").replace(/(es|s)$/, "");
  const hits = LIB.recipes.map(x => {
    const used = words.filter(w => hay(x).includes(stem(w)));
    return { x, used, s: used.length * 10 - (x.course === "Larder" ? 0 : 1) + Math.random() };
  }).filter(c => c.used.length).sort((a, b) => b.s - a.s).slice(0, 10);
  const jobs = LARDERJOBS.map(j => ({ j, used: words.filter(w => j.uses.some(u => u.replace(/-/g, " ").includes(stem(w)) || stem(w).includes(u.replace(/-/g, " ")))) }))
    .filter(c => c.used.length).sort((a, b) => b.used.length - a.used.length).slice(0, 4);
  $("#surplusRows").innerHTML = (hits.length ? `<li class="grp">Recipes that use it</li>` + hits.map(c => `<li><button type="button" data-rid="${esc(c.x.id)}"><span class="nm">${esc(c.x.name)}</span><span class="mt">${esc(libMeta(c.x))}</span><span class="why">uses ${esc(c.used.join(", "))}</span></button></li>`).join("") : `<li class="lede" style="padding:8px 0">No recipe in the library uses that.</li>`)
    + (jobs.length ? `<li class="grp">Larder jobs</li>` + jobs.map(c => `<li>${c.j.recipe ? `<button type="button" data-rid="${esc(c.j.recipe)}">` : `<div class="ljob">`}<span class="nm">${esc(c.j.name)}</span><span class="mt">${esc(c.j.family)} · ${c.j.min} min · keeps ${c.j.keeps_days} days</span><span class="why">uses ${esc(c.used.join(", "))}</span>${c.j.how ? `<span class="foot">${esc(c.j.how)}</span>` : ""}${c.j.recipe ? "</button>" : "</div>"}</li>`).join("") : "");
}
$("#useUp").addEventListener("click", useUp);
$("#fillLeft").addEventListener("click", async () => {
  const L = (P && P.leftovers) || { spare: [], cooked: [] };
  if (!LARDER) await loadLarder();
  const inLarder = LARDER ? Object.values(LARDER.entries).filter(e => !e.status && e.made <= iso(new Date())).map(e => e.name) : [];
  $("#surplus").value = L.cooked.map(x => x.name).concat(L.spare.map(x => x.name.split(",")[0]), inLarder).join(", ");
  if (!$("#surplus").value) toast("Nothing left over this week");
});
$("#surplusRows").addEventListener("click", e => { const b = e.target.closest("[data-rid]"); if (b) openRecipe(b.dataset.rid); });
// photos: shrunk on the phone to 1280 px, then saved with the note to inbox/surplus/ in the repo
const shrink = file => new Promise((ok, no) => {
  const img = new Image(); img.onerror = no;
  img.onload = () => { const k = Math.min(1, 1280 / Math.max(img.width, img.height)), c = document.createElement("canvas");
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    ok(c.toDataURL("image/jpeg", 0.8).split(",")[1]); URL.revokeObjectURL(img.src); };
  img.src = URL.createObjectURL(file);
});
$("#saveSurplus").addEventListener("click", async () => {
  const text = $("#surplus").value.trim(), files = [...$("#surplusPhotos").files];
  if (!text && !files.length) return toast("Type what you have, or add photos");
  if (!REMOTE) return toast("The local preview can't save photos: connect GitHub in settings");
  const b = $("#saveSurplus"); b.disabled = true; b.textContent = "Saving…";
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-"), photos = [];
    for (const [i, f] of files.entries()) {
      const path = `inbox/surplus/${stamp}-${i + 1}.jpg`;
      const r = await fetch(api(path), { method: "PUT", headers: Object.assign(auth(), { "Content-Type": "application/json" }), body: JSON.stringify({ message: "App: surplus photo", branch: "main", content: await shrink(f) }) });
      if (!r.ok) throw new Error(`GitHub error ${r.status}`);
      photos.push(path);
    }
    enqueue({ type: "surplus", note: { at: new Date().toISOString(), text, photos, status: "new" } });
    $("#surplusPhotos").value = ""; toast("Saved for Claude Code");
  } catch (e) { toast(String(e.message || e)); }
  b.disabled = false; b.textContent = "Save for Claude Code";
});
OPS.surplus = o => ["inbox/surplus.json", d => { d = d || { notes: [] }; d.notes.push(o.note); return d; }, "App: surplus note"];

/* ---------- Repertoire > Larder library: the larder's job bank in its four families (library/larder.json), each
   job with what it uses up and how long it keeps, and the long projects ---------- */
let LJ = null;
async function renderLarderLib() {
  if (!LJ) {
    $("#larderLib").innerHTML = `<p class="lede">Loading…</p>`;
    const r = await readJSON("library/larder.json").catch(() => null);
    if (!r) { $("#larderLib").innerHTML = `<p class="lede">The larder bank isn't in the repo yet.</p>`; return; }
    LJ = r.data;
  }
  const keeps = d => d >= 60 ? `${Math.round(d / 30)} months` : d >= 14 ? `${Math.round(d / 7)} weeks` : `${d} days`;
  const job = j => `<li>${j.recipe ? `<button type="button" data-rid="${esc(j.recipe)}">` : `<div class="ljob">`}<span class="nm">${esc(j.name)}</span>
    <span class="mt">${esc(j.kind)} · ${j.min} min · keeps ${keeps(j.keeps_days)}</span>${j.uses.length ? `<span class="why">uses ${esc(j.uses.map(u => u.replace(/-/g, " ")).join(", "))}</span>` : ""}
    ${j.how ? `<span class="foot">${esc(j.how)}</span>` : ""}${j.recipe ? "</button>" : "</div>"}</li>`;
  const fams = LJ.families.map(f => `<h3 style="margin-top:14px">${esc(f)}</h3><ul class="librows">${LJ.jobs.filter(j => j.family === f).map(job).join("")}</ul>`).join("");
  const projects = (LJ.projects || []).map(p => `<li><div class="ljob"><span class="nm">${esc(p.name)}</span><span class="mt">${esc(p.months)} months · ${esc(p.status)}</span><span class="foot">${esc(p.note)}</span></div></li>`).join("");
  $("#larderLib").innerHTML = fams + (projects ? `<h3 style="margin-top:14px">Long projects</h3><ul class="librows">${projects}</ul>` : "");
}
$("#larderLib").addEventListener("click", e => { const b = e.target.closest("[data-rid]"); if (b) openRecipe(b.dataset.rid); });

/* ---------- parts still to come (each lands in its own update) ---------- */
const soon = (title, text) => `<div class="panel"><h3>${esc(title)}</h3><p class="lede" style="margin:0">${esc(text)}</p></div>`;

/* ---------- views: five tabs (two with sub-tabs along the top), plus screens opened from them (the phone's back
   button closes those) ---------- */
const TABS = ["train", "discover", "recipes", "shop", "repertoire"], SUBS = ["picks", "detail", "event"];
const OLDVIEW = { workout: ["train", "workout"], choices: ["repertoire", "choices"], library: ["repertoire", "library"] };
const SUBTAB = Object.assign({ train: "workout", repertoire: "choices" }, store.get("subtab", {}));
function showSub(tab, sub) {
  SUBTAB[tab] = sub; store.set("subtab", SUBTAB);
  document.querySelectorAll(`[data-subtabs="${tab}"] [data-sub]`).forEach(b => b.setAttribute("aria-pressed", b.dataset.sub === sub));
  document.querySelectorAll(`[data-pane^="${tab}:"]`).forEach(p => p.hidden = p.dataset.pane !== `${tab}:${sub}`);
  if (tab === "repertoire" && (sub === "library" || sub === "choices")) loadLibrary();
  if (tab === "repertoire" && sub === "larder") renderLarderLib();
  if (tab === "repertoire" && sub === "events") renderEvents();
  if (tab === "train" && sub === "setup") openSetup();
  if (tab === "train" && sub === "engine") renderEngine();
  if (tab === "train" && sub === "progress") renderProgress();
  if (tab === "train" && sub === "stats") renderStats();
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-subtabs] [data-sub]"); if (!b) return;
  showSub(b.closest("[data-subtabs]").dataset.subtabs, b.dataset.sub); window.scrollTo(0, 0);
});
let current = "recipes";
const scrollAt = {}, stack = [];
function showView(v) {
  if (current === "discover" && v !== "discover") saveSwipes();
  if (OLDVIEW[v]) { SUBTAB[OLDVIEW[v][0]] = OLDVIEW[v][1]; v = OLDVIEW[v][0]; }
  if (!TABS.includes(v) && !SUBS.includes(v)) v = "recipes";
  scrollAt[current] = window.scrollY;
  current = v;
  const tab = SUBS.includes(v) ? stack.slice().reverse().find(x => TABS.includes(x)) || "recipes" : v;
  document.querySelectorAll(".view").forEach(s => s.hidden = s.id !== "view-" + v);
  document.querySelectorAll(".tabbar button").forEach(b => b.setAttribute("aria-selected", b.dataset.view === tab));
  window.scrollTo(0, scrollAt[v] || 0);
  if (TABS.includes(v)) store.set("view", v);
  if (SUBTAB[v]) showSub(v, SUBTAB[v]);
  if (v === "discover") renderDiscover();
  if (v === "recipes") {
    if (pendingDay) { const d = pendingDay; pendingDay = null; goTo(d, false); }
    else if (pager.clientWidth) pager.scrollLeft = pageAt * pager.clientWidth;
    markPill();
  }
}
document.querySelector(".tabbar").addEventListener("click", e => { const b = e.target.closest("[data-view]"); if (b) { stack.length = 0; showView(b.dataset.view); } });
function openSub(v) { stack.push(current); scrollAt[v] = 0; showView(v); history.pushState({ sub: v }, ""); }
window.addEventListener("popstate", () => { if (SUBS.includes(current)) showView(stack.pop() || "recipes"); });

/* ---------- settings ---------- */
document.addEventListener("click", e => { if (e.target.closest("[data-settings]")) openSettings(); });
function openSettings() {
  const f = $("#settingsForm");
  f.owner.value = CFG.owner; f.repo.value = CFG.repo; f.token.value = CFG.token;
  $("#settingsStatus").textContent = REMOTE ? "Connected to GitHub." : "Not connected: showing the local preview.";
  $("#settings").showModal();
}
$("#settings").addEventListener("close", () => {
  if ($("#settings").returnValue !== "save") return;
  const f = $("#settingsForm");
  store.set("cfg", { owner: f.owner.value.trim(), repo: f.repo.value.trim(), token: f.token.value.trim() });
  location.reload();
});
let tt; function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 2200); }
/* ---------- start: find this week's plan ---------- */
async function findWeek() {
  const asked = new URLSearchParams(location.search).get("week");
  if (asked) { const r = await readJSON(`weekly/${asked}/plan.built.json`); return r ? [asked, r.data] : null; }
  const mon = iso(mondayOf(new Date()));
  // this week first; at the weekend next week's may be ready; else the latest of the last few weeks
  const tries = [mon].concat(new Date().getDay() % 6 === 0 ? [addDays(mon, 7)] : [], [-7, -14, -21].map(n => addDays(mon, n)));
  for (const w of tries) { const r = await readJSON(`weekly/${w}/plan.built.json`); if (r) return [w, r.data]; }
  return null;
}
// GitHub answers 404 for a private repo the token can't see, so check access first to say what's wrong
async function checkRepo() {
  const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(CFG.owner)}/${encodeURIComponent(CFG.repo)}`, { headers: auth(), cache: "no-store" });
  if (r.status === 401) {
    // only the non-secret prefix and the length, to spot a cut-off or wrong paste
    const t = CFG.token, shape = /^github_pat_/.test(t) ? "starts with github_pat_" : /^gh[pousr]_/.test(t) ? `starts with ${t.slice(0, 4)}` : "doesn't start with github_pat_";
    throw new Error(`GitHub didn't accept the token. The saved one ${shape} and is ${t.length} characters long (a fine-grained token is about 93). Copy it again with GitHub's copy button and paste it in settings.`);
  }
  if (r.status === 404) throw new Error(`The token can't see ${CFG.owner}/${CFG.repo}. On GitHub, edit the token: Repository access must include "${CFG.repo}", and Contents must be "Read and write".`);
  if (!r.ok) throw new Error(`GitHub error ${r.status}`);
}
async function start() {
  try {
    if (REMOTE) await checkRepo();
    const found = await findWeek();
    if (!found) {
      $("#recipes").innerHTML = `<div class="panel" style="margin-top:24px"><h2 style="font-size:24px">No plan found</h2><p class="lede" style="margin-top:6px">${REMOTE ? `Connected to ${esc(CFG.owner)}/${esc(CFG.repo)}, but there's no built plan for this week yet. Ask Claude to build the week's plan.` : "Not connected yet: open settings, paste your GitHub token and tap Save."}</p><button class="btn primary" type="button" data-settings style="margin-top:12px">Settings</button></div>`;
    } else {
      [WEEK, P] = found;
      P.fields.forEach((f, i) => IX[f] = i); REF = P.reference; LIMITS = REF.limits || [];
      NEXT = addDays(WEEK, 7);
      const [opts, nextLog, thisLog, thisOpts] = await Promise.all([
        readJSON(`weekly/${NEXT}/options.json`).catch(() => null),
        readJSON(`weekly/${NEXT}/log.json`).catch(() => null),
        readJSON(`weekly/${WEEK}/log.json`).catch(() => null),
        readJSON(`weekly/${WEEK}/options.json`).catch(() => null)]);
      THISLOG = thisLog ? thisLog.data : {};
      // which option the built plan is: the menu whose dinners it has, else the pick it was rebuilt from
      const built = Object.fromEntries(P.days.filter(d => d.dinner).map(d => [d.day, d.dinner.recipe]));
      PLAN_OPTION = ((thisOpts ? thisOpts.data.menus : []).find(m => sameDinners(m, built)) || {}).id
        || (THISLOG.layout && Object.keys(built).every(k => THISLOG.layout[k] === built[k]) ? THISLOG.pick : null);
      OPTIONS = opts ? Object.assign(opts.data, { _log: nextLog ? nextLog.data : {} }) : null;
      if (REMOTE) store.set("lastSync", new Date().toISOString());
      renderRecipes(); renderShop();
    }
    renderWorkout();
  } catch (e) {
    console.error(e);
    $("#recipes").innerHTML = `<div class="panel" style="margin-top:24px"><h2 style="font-size:24px">Couldn't load the plan</h2><p class="lede err" style="margin-top:6px">${esc(e.message || e)}</p><button class="btn primary" type="button" data-settings style="margin-top:12px">Settings</button></div>`;
    renderWorkout();
  }
  if (P) { // open on today's page during the plan week
    const tk = todayKey(), t = iso(new Date()), inWeek = t >= WEEK && t <= addDays(WEEK, 6);
    if (inWeek && P.days.some(d => d.day === tk)) pendingDay = tk;
  }
  showView(store.get("view", "recipes"));
  saveSwipes(); // any left from last time
  flush();
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
start();
