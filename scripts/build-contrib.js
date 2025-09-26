// scripts/build-contrib.js
// Merges GitHub + GitLab contributions for the last 365 days, outputs public/contrib.svg

import fs from "node:fs";
import path from "node:path";

// --- Config (env) ---
const GH_USERNAME = process.env.GH_USERNAME; 
const GH_TOKEN = process.env.GH_PAT || process.env.GITHUB_TOKEN || "";
const GITLAB_USERNAME = process.env.GITLAB_USERNAME; 

if (!GH_USERNAME || !GITLAB_USERNAME) {
  console.error("Missing GH_USERNAME or GITLAB_USERNAME env vars.");
  process.exit(1);
}

if (!GH_TOKEN) {
  console.error("Missing GitHub token (GH_PAT / GITHUB_TOKEN). Aborting to avoid 403.");
  process.exit(1);
}

const today = new Date();
const fromDate = new Date(today);
fromDate.setDate(today.getDate() - 364);

const iso = (d) => d.toISOString().slice(0, 10);

// --- Fetch GitHub (public contributions) via GraphQL ---
async function fetchGitHubCalendar(username) {
  const body = {
    query: `
      query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            contributionCalendar {
              weeks {
                contributionDays {
                  date
                  contributionCount
                }
              }
            }
          }
        }
      }
    `,
    variables: {
      login: username,
      from: fromDate.toISOString(),
      to: today.toISOString()
    }
  };

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {})
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub GraphQL error: ${res.status} ${text}`);
  }

  const json = await res.json();
  const weeks = json?.data?.user?.contributionsCollection?.contributionCalendar?.weeks || [];
  const out = {};
  for (const w of weeks) {
    for (const d of w.contributionDays) {
      out[d.date] = (out[d.date] || 0) + (d.contributionCount || 0);
    }
  }
  return out;
}

// --- Fetch GitLab calendar (JSON map: "YYYY-MM-DD": count)
async function fetchGitLabCalendar(username) {
  // GitLab exposes calendar JSON at /users/:username/calendar.json
  // (covers ~1 year window)
  const url = `https://gitlab.com/users/${encodeURIComponent(username)}/calendar.json`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab calendar error: ${res.status} ${text}`);
  }
  const json = await res.json(); // { "2025-01-01": 3, ... }
  return json || {};
}

// --- Build date list (ensure every day exists)
function dateRangeMap(from, to) {
  const map = {};
  const d = new Date(from);
  while (d <= to) {
    map[iso(d)] = 0;
    d.setDate(d.getDate() + 1);
  }
  return map;
}

// --- Merge & scale ---
function mergeCalendars(base, gh, gl) {
  for (const [date, cnt] of Object.entries(gh)) {
    if (base[date] !== undefined) base[date] += cnt;
  }
  for (const [date, cnt] of Object.entries(gl)) {
    if (base[date] !== undefined) base[date] += cnt;
  }
  return base;
}

function computeLevels(values) {
  // Simple dynamic bucketization (0..4) based on quantiles
  const arr = Object.values(values).sort((a, b) => a - b);
  const q = (p) => arr[Math.floor((arr.length - 1) * p)];
  const q1 = q(0.25), q2 = q(0.5), q3 = q(0.75);
  const levels = {};
  for (const [k, v] of Object.entries(values)) {
    let lvl = 0;
    if (v > 0 && v <= q1) lvl = 1;
    if (v > q1 && v <= q2) lvl = 2;
    if (v > q2 && v <= q3) lvl = 3;
    if (v > q3) lvl = 4;
    levels[k] = lvl;
  }
  return levels;
}

// --- Render SVG (GitHub-like grid) ---
function renderSVG(levels) {
  // Colors (light -> dark)
  const palette = ["#ebedf0", "#c6e48b", "#7bc96f", "#239a3b", "#196127"];

  // Arrange by weeks (columns) starting on Sunday
  const start = new Date(fromDate);
  // Shift back to nearest previous Sunday
  const weekday = start.getUTCDay(); // 0 Sun
  start.setDate(start.getDate() - weekday);

  const end = new Date(today);
  // Shift forward to Saturday for full column
  const endShift = 6 - end.getUTCDay();
  end.setDate(end.getDate() + endShift);

  // cell size & gaps
  const cell = 10, gap = 2;
  const weeks = Math.ceil((end - start) / (1000 * 60 * 60 * 24 * 7)) + 1;
  const width = weeks * (cell + gap) + gap;
  const height = 7 * (cell + gap) + gap;

  let rects = "";
  let cursor = new Date(start);
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const key = iso(cursor);
      const lvl = levels[key] ?? 0;
      const x = gap + w * (cell + gap);
      const y = gap + d * (cell + gap);
      const fill = palette[lvl];
      rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${fill}">
        <title>${key}: ${lvl}</title>
      </rect>`;
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Combined contributions">
  <title>Combined GitHub + GitLab Contributions (last 365 days)</title>
  <rect width="100%" height="100%" fill="#fff"/>
  ${rects}
</svg>`;
}

(async () => {
  try {
    const base = dateRangeMap(fromDate, today);
    const [gh, gl] = await Promise.all([
      fetchGitHubCalendar(GH_USERNAME),
      fetchGitLabCalendar(GITLAB_USERNAME)
    ]);

    const merged = mergeCalendars(base, gh, gl);
    const levels = computeLevels(merged);
    const svg = renderSVG(levels);

    const outPath = path.join(process.cwd(), "public", "contrib.svg");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, svg, "utf8");
    console.log(`Wrote ${outPath}`);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();