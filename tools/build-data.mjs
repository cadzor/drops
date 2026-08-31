/**
 * Fetches every boss drop table from the OSRS Wiki plus live GE prices, and writes
 * them to /data as static JSON for the site to load same-origin.
 *
 * Runs in GitHub Actions, not in the browser — which is the point. It can set the
 * descriptive User-Agent the wiki asks for, and it turns one scrape per page view
 * into one scrape per scheduled build.
 *
 *   node tools/build-data.mjs
 *
 * Set UA below to something identifying you before the first run.
 */
import { DOMParser } from "linkedom";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const UA = process.env.WIKI_UA
  || "osrs-loot-variance build script - https://github.com/YOUR-USERNAME/YOUR-REPO";

const WIKI = "https://oldschool.runescape.wiki/api.php";
const PRICES = "https://prices.runescape.wiki/api/v1/osrs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data");
const DELAY_MS = 250;                       // be gentle: ~4 requests/second

const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

let calls = 0;
async function jget(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      if (calls++) await sleep(DELAY_MS);
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries) throw e;
      await sleep(1500 * i);
    }
  }
}

/* ---------- parsing (mirrors nothing in the browser: all of it happens here) ---------- */

export function parseRarity(text, sortValue) {
  const t = (text || "").trim();
  if (/^always/i.test(t)) return { p: 1, rolls: 1 };
  let m = t.match(/^(\d+)\s*[×x]\s*1\s*\/\s*([\d,.]+)/i);
  if (m) return { p: 1 / parseFloat(m[2].replace(/,/g, "")), rolls: parseInt(m[1]) };
  m = t.match(/([\d,.]+)\s*\/\s*([\d,.]+)/);
  if (m) {
    const num = parseFloat(m[1].replace(/,/g, "")), den = parseFloat(m[2].replace(/,/g, ""));
    if (den > 0) return { p: num / den, rolls: 1 };
  }
  const sv = parseFloat(sortValue);
  if (isFinite(sv) && sv > 0 && sv <= 1) return { p: sv, rolls: 1 };
  return { p: null, rolls: 1 };                       // Common / Uncommon / Varies
}

export function parseQuantity(text) {
  const t = (text || "1").replace(/\(noted\)/ig, "").trim();
  const parts = t.split(/[;/]/).map(s => s.trim()).filter(Boolean);
  const vals = [];
  for (const part of parts) {
    const cleaned = part.replace(/(\d),(\d{3})\b/g, "$1$2");     // thousands separators only
    const nums = (cleaned.match(/\d+(\.\d+)?/g) || []).map(Number);
    if (!nums.length) continue;
    vals.push(/[–—-]/.test(cleaned) && nums.length >= 2
      ? (Math.min(...nums) + Math.max(...nums)) / 2               // "3–4" is a range
      : nums.reduce((a, b) => a + b, 0) / nums.length);
  }
  if (!vals.length) return 1;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function parseDrops(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(".navbox, sup.reference").forEach(n => n.remove());

  const tables = [...doc.querySelectorAll("table")].filter(tb => {
    const heads = [...tb.querySelectorAll("th")].map(h => h.textContent.trim().toLowerCase());
    return heads.includes("rarity") && (heads.includes("item") || heads.some(h => h.startsWith("quantity")));
  });

  const out = [];
  for (const tb of tables) {
    const headRow = [...tb.querySelectorAll("tr")].find(r => r.querySelector("th"));
    if (!headRow) continue;
    const heads = [...headRow.querySelectorAll("th")].map(h => h.textContent.trim().toLowerCase());
    const iItem = heads.findIndex(h => h === "item");
    const iQty  = heads.findIndex(h => h.startsWith("quantity"));
    const iRar  = heads.findIndex(h => h.startsWith("rarity"));
    const iAlch = heads.findIndex(h => h.includes("alch"));
    if (iRar < 0) continue;

    let section = "Drops", el = tb;
    while ((el = el.previousElementSibling || el.parentElement)) {
      if (!el) break;
      if (/^H[2-4]$/i.test(el.tagName || "")) {
        section = el.textContent.replace(/\[.*?\]/g, "").trim() || "Drops";
        break;
      }
    }

    for (const tr of tb.querySelectorAll("tr")) {
      let tds = [...tr.children].filter(c => c.tagName === "TD");
      if (tds.length < 3) continue;
      while (tds.length > heads.length && tds[0].querySelector("img") && !tds[0].textContent.trim()) tds = tds.slice(1);
      const cell = i => (i >= 0 && i < tds.length) ? tds[i] : null;
      const itemCell = cell(iItem >= 0 ? iItem : 0);
      const rarCell = cell(iRar);
      if (!itemCell || !rarCell) continue;

      const link = itemCell.querySelector("a[title]");
      const name = (link ? link.getAttribute("title") : itemCell.textContent).trim();
      if (!name || /^nothing$/i.test(name)) continue;

      const { p, rolls } = parseRarity(rarCell.textContent, rarCell.getAttribute("data-sort-value"));
      const alchCell = iAlch >= 0 ? cell(iAlch) : null;

      out.push({
        name, section,
        qty: Math.round(parseQuantity(cell(iQty)?.textContent || "1") * 100) / 100,
        p: p == null ? null : Number(p.toPrecision(8)),
        rolls,
        alch: alchCell && /\d/.test(alchCell.textContent) ? Math.round(parseQuantity(alchCell.textContent)) : 0,
        rarityText: rarCell.textContent.trim().replace(/\s+/g, " ").slice(0, 40),
      });
    }
  }

  const seen = new Map();
  for (const d of out) {
    const k = `${d.name}|${d.section}|${d.rarityText}`;
    if (!seen.has(k)) seen.set(k, d);
  }
  return [...seen.values()];
}

/* ---------- sources ---------- */

async function bossTitles() {
  const names = new Set();
  for (const cat of ["Category:Bosses", "Category:Boss monsters"]) {
    let cont = "";
    for (let page = 0; page < 5; page++) {
      const j = await jget(`${WIKI}?action=query&list=categorymembers&cmtitle=${encodeURIComponent(cat)}&cmlimit=500&cmtype=page&format=json&formatversion=2${cont}`);
      (j.query?.categorymembers || []).forEach(m => names.add(m.title));
      if (!j.continue) break;
      cont = "&cmcontinue=" + encodeURIComponent(j.continue.cmcontinue);
    }
  }
  return [...names].filter(n => !n.includes(":")).sort((a, b) => a.localeCompare(b));
}

async function priceMap() {
  const [mapping, latest] = await Promise.all([jget(PRICES + "/mapping"), jget(PRICES + "/latest")]);
  const byId = {};
  for (const [id, v] of Object.entries(latest.data || {})) {
    byId[id] = v.high && v.low ? Math.round((v.high + v.low) / 2) : (v.high || v.low || 0);
  }
  const byName = {};
  for (const m of mapping) byName[m.name.toLowerCase()] = byId[m.id] || 0;
  return byName;
}

/* ---------- main ---------- */

const argOnly = process.argv.slice(2).filter(a => !a.startsWith("-"));

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
  console.log("User-Agent:", UA);
  if (UA.includes("YOUR-USERNAME")) console.warn("!! Set WIKI_UA to something that identifies you before running this for real.");

  await mkdir(join(OUT, "drops"), { recursive: true });

  console.log("Fetching prices…");
  const prices = await priceMap();
  console.log(`  ${Object.keys(prices).length} priced items`);

  const titles = argOnly.length ? argOnly : await bossTitles();
  console.log(`Fetching ${titles.length} boss pages…`);

  const index = [], failures = [];
  for (const [i, title] of titles.entries()) {
    try {
      const j = await jget(`${WIKI}?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json&formatversion=2`);
      const html = j.parse?.text;
      if (!html) throw new Error("no page text");
      const drops = parseDrops(html).map(d => ({ ...d, price: prices[d.name.toLowerCase()] ?? 0 }));
      if (!drops.length) { failures.push(`${title} (no drop table)`); continue; }

      const s = slug(title);
      await writeFile(join(OUT, "drops", s + ".json"),
        JSON.stringify({ name: title, generated: new Date().toISOString(), drops }));
      index.push({ name: title, slug: s, lines: drops.length });
      if (i % 20 === 0) console.log(`  ${i + 1}/${titles.length} …`);
    } catch (e) {
      failures.push(`${title} (${e.message})`);
    }
  }

  await writeFile(join(OUT, "bosses.json"),
    JSON.stringify({ generated: new Date().toISOString(), bosses: index }, null, 0));

  console.log(`\nWrote ${index.length} bosses to data/`);
  if (failures.length) {
    console.log(`Skipped ${failures.length}:`);
    failures.slice(0, 40).forEach(f => console.log("  - " + f));
  }
}

if (isDirect) main().catch(e => { console.error(e); process.exit(1); });
