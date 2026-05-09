#!/usr/bin/env node
/*
 * update-readme.js
 *
 * Regenerates every data-driven block in README.md from:
 *   - LISTS/stats.txt        (source counts, totals)
 *   - LISTS/master_oui.db    (source/registry/device-type breakdowns via SQL)
 *   - .github/oui-history.csv (append-only running log for the growth chart)
 *
 * Replaces:
 *   - Inline counts in capsule-render header URL, typing-SVG URL, OUI badge URL
 *   - Block sections wrapped in <!-- AUTO:NAME --> ... <!-- /AUTO:NAME -->
 *
 * Run automatically by .github/workflows/update-database.yml after merge.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const README_PATH = path.join(ROOT, 'README.md');
const STATS_PATH = path.join(ROOT, 'LISTS', 'stats.txt');
const DB_PATH = path.join(ROOT, 'LISTS', 'master_oui.db');
const HISTORY_PATH = path.join(ROOT, '.github', 'oui-history.csv');

const fmt = (n) => Number(n).toLocaleString('en-US');
const urlEnc = (s) => String(s).replace(/,/g, '%2C');

function parseStats(txt) {
  const grab = (re) => {
    const m = txt.match(re);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  };
  return {
    total: grab(/Unique OUIs:\s+([\d,]+)/),
    merged: grab(/Merged Entries:\s+([\d,]+)/),
    ieeeTotal: grab(/IEEE Total:\s+([\d,]+)/),
    mal: grab(/MA-L \(Large\/OUI\):\s+([\d,]+)/),
    mam: grab(/MA-M \(Medium\):\s+([\d,]+)/),
    mas: grab(/MA-S \(Small\):\s+([\d,]+)/),
    iab: grab(/IAB \(Individual\):\s+([\d,]+)/),
    cid: grab(/CID \(Company ID\):\s+([\d,]+)/),
    wireshark: grab(/Wireshark:\s+([\d,]+)/),
    nmap: grab(/Nmap:\s+([\d,]+)/),
    hdm: grab(/Mac-Tracker:\s+([\d,]+)/),
  };
}

function queryDb(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const sourcesPie = db
    .prepare(`SELECT sources, COUNT(*) AS n FROM oui_registry GROUP BY sources ORDER BY n DESC`)
    .all();
  const devices = db
    .prepare(
      `SELECT device_type, COUNT(*) AS n FROM oui_registry
       WHERE device_type IS NOT NULL AND device_type != ''
       GROUP BY device_type ORDER BY n DESC`
    )
    .all();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM oui_registry`).get().n;
  const unclassified = total - devices.reduce((a, r) => a + r.n, 0);
  db.close();
  return { sourcesPie, devices, unclassified };
}

function updateHistory(date, s) {
  let rows = [];
  if (fs.existsSync(HISTORY_PATH)) {
    rows = fs
      .readFileSync(HISTORY_PATH, 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map((line) => line.split(','));
  }
  rows = rows.filter(([d]) => d !== date);
  rows.push([date, s.total, s.ieeeTotal, s.wireshark, s.nmap, s.hdm]);
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  const out = ['date,total,ieee,wireshark,nmap,hdm', ...rows.map((r) => r.join(','))].join('\n') + '\n';
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, out);
  return rows;
}

function buildGrowthChart(history) {
  const lastN = history.slice(-6);
  const dates = lastN.map((r) => `"${r[0]}"`).join(', ');
  const values = lastN.map((r) => r[1]).join(', ');
  const nums = lastN.map((r) => parseInt(r[1], 10));
  const yMin = Math.floor(Math.min(...nums) / 100) * 100 - 100;
  const yMax = Math.ceil(Math.max(...nums) / 100) * 100 + 100;
  const span = lastN.length;
  const totalDelta = nums[nums.length - 1] - nums[0];
  const weeksSpan =
    Math.round(
      (new Date(lastN[lastN.length - 1][0]) - new Date(lastN[0][0])) / (7 * 86400000)
    ) || 1;
  const monthlyAvg = Math.round((totalDelta / weeksSpan) * 4.33);

  return `\`\`\`mermaid
%%{init: {'theme':'dark', 'themeVariables': {'xyChart': {'backgroundColor':'#00000000','plotColorPalette':'#1E40AF','titleColor':'#1E40AF','xAxisLabelColor':'#ffffff','yAxisLabelColor':'#ffffff'}}}}%%
xychart-beta
    title "OUI Count Growth (Last ${span} Auto-Updates)"
    x-axis [${dates}]
    y-axis "Total OUIs" ${yMin} --> ${yMax}
    bar [${values}]
    line [${values}]
\`\`\`

**+${fmt(totalDelta)} OUIs in ~${weeksSpan} weeks** · IEEE assigns roughly **${fmt(monthlyAvg)} new vendors/month** · Next refresh: **first of next month**`;
}

function buildSourcesPie(rows) {
  const top = rows.slice(0, 6).map((r) => `    "${r.sources}" : ${r.n}`);
  const totalAll = rows.reduce((a, r) => a + r.n, 0);
  const allThreeRow = rows.find((r) => r.sources.includes('IEEE') && r.sources.includes('Wireshark') && r.sources.includes('Nmap') && r.sources.split('+').length === 3);
  const allThree = allThreeRow ? allThreeRow.n : 0;
  const allThreePct = totalAll ? Math.round((allThree / totalAll) * 100) : 0;
  const labelMap = {
    'IEEE+Wireshark+Nmap': 'All 3 (IEEE+Wireshark+Nmap)',
    'IEEE': 'IEEE only',
    'Wireshark': 'Wireshark only',
    'Nmap': 'Nmap only',
  };
  const lines = rows.slice(0, 6).map((r) => {
    const label = labelMap[r.sources] || r.sources;
    return `    "${label}" : ${r.n}`;
  });
  return `\`\`\`mermaid
%%{init: {'theme':'dark', 'themeVariables': {'pie1':'#1E40AF','pie2':'#3B82F6','pie3':'#60A5FA','pie4':'#93C5FD','pie5':'#FFD700','pie6':'#1E3A8A','pieTitleTextSize':'18px','pieLegendTextSize':'14px'}}}%%
pie showData
    title Where Each OUI Comes From
${lines.join('\n')}
\`\`\`

**${fmt(allThree)} OUIs (${allThreePct}%)** are confirmed by all three primary sources. The remaining single-source entries
fill gaps that *no individual database* would catch on its own. That's the point.`;
}

function buildSourceRoster(s) {
  return `| SOURCE | ENTRIES | LICENSE | URL |
|:-------|:-------:|:-------:|:----|
| ![IEEE](https://img.shields.io/badge/IEEE-Official-1E40AF?style=flat-square) | \`${fmt(s.ieeeTotal)}\` | Public Domain | [standards-oui.ieee.org](https://standards-oui.ieee.org/) |
| ![Wireshark](https://img.shields.io/badge/Wireshark-Community-1679A7?style=flat-square&logo=wireshark&logoColor=white) | \`${fmt(s.wireshark)}\` | GPLv2 | [wireshark.org](https://www.wireshark.org/download/automated/data/manuf.gz) |
| ![Nmap](https://img.shields.io/badge/Nmap-Community-7B68EE?style=flat-square&logo=nmap&logoColor=white) | \`${fmt(s.nmap)}\` | GPLv2 (mod.) | [nmap-mac-prefixes](https://github.com/nmap/nmap/raw/master/nmap-mac-prefixes) |
| ![HDM](https://img.shields.io/badge/HDM%20Mac--Tracker-Historical-FFD700?style=flat-square) | \`${fmt(s.hdm)}\` | MIT | [hdm/mac-tracker](https://github.com/hdm/mac-tracker) |`;
}

function buildIeeePie(s) {
  return `\`\`\`mermaid
%%{init: {'theme':'dark', 'themeVariables': {'pie1':'#1E40AF','pie2':'#3B82F6','pie3':'#60A5FA','pie4':'#93C5FD','pie5':'#FFD700','pieTitleTextSize':'18px','pieLegendTextSize':'14px'}}}%%
pie showData
    title IEEE Registry Distribution (${fmt(s.ieeeTotal)} entries)
    "MA-L (Large, ~16M each)" : ${s.mal}
    "MA-S (Small, ~4K each)" : ${s.mas}
    "MA-M (Medium, ~1M each)" : ${s.mam}
    "IAB (Individual Block)" : ${s.iab}
    "CID (Company ID)" : ${s.cid}
\`\`\``;
}

function buildIeeeTable(s) {
  return `| REGISTRY | ENTRIES | BLOCK SIZE | TYPICAL USE |
|:--------:|:-------:|:----------:|:------------|
| **MA-L** | \`${fmt(s.mal)}\` | 24-bit (~16M MACs) | Large-scale manufacturers |
| **MA-S** | \`${fmt(s.mas)}\`  | 36-bit (~4K MACs) | IoT, niche hardware |
| **MA-M** | \`${fmt(s.mam)}\`  | 28-bit (~1M MACs) | Mid-volume vendors |
| **IAB**  | \`${fmt(s.iab)}\`  | Individual | Legacy individual blocks |
| **CID**  | \`${fmt(s.cid)}\`    | Company-only ID | Non-MAC company markers |`;
}

function buildDeviceCaveat(total, classified, unclassified) {
  const pct = total ? ((classified / total) * 100).toFixed(1) : '0';
  return `> ⚠ IEEE doesn't expose device category. Our classifier is a heuristic on company name +
> known-vendor lookups, so **only ${fmt(classified)} of ${fmt(total)} OUIs** (${pct}%) get a category. The
> remaining ${fmt(unclassified)} stay \`Unclassified\` rather than guessed.`;
}

function buildDevicePie(devices, total, classified) {
  const top = devices.slice(0, 11);
  const rest = devices.slice(11);
  const restCount = rest.reduce((a, r) => a + r.n, 0);
  const lines = top.map((r) => `    "${r.device_type}" : ${r.n}`);
  if (restCount > 0) {
    lines.push(`    "Other (${rest.length} cats)" : ${restCount}`);
  }
  return `\`\`\`mermaid
%%{init: {'theme':'dark', 'themeVariables': {'pie1':'#1E40AF','pie2':'#3B82F6','pie3':'#60A5FA','pie4':'#93C5FD','pie5':'#FFD700','pie6':'#1E3A8A','pie7':'#00D4FF','pie8':'#9FEF00','pie9':'#FF00FF','pie10':'#8B5CF6','pie11':'#FF6B6B','pie12':'#00FF88','pieTitleTextSize':'16px','pieLegendTextSize':'12px'}}}%%
pie showData
    title Classified Device Types (${fmt(classified)} of ${fmt(total)})
${lines.join('\n')}
\`\`\``;
}

function buildDeviceTable(devices) {
  // 2-column layout, alphabetized within rows by count-desc filling
  const rows = [];
  const half = Math.ceil(devices.length / 2);
  const left = devices.slice(0, half);
  const right = devices.slice(half);
  rows.push('| CATEGORY | COUNT | CATEGORY | COUNT |');
  rows.push('|:---------|:-----:|:---------|:-----:|');
  for (let i = 0; i < half; i++) {
    const l = left[i];
    const r = right[i];
    const lCell = l ? `${l.device_type.padEnd(12)} | \`${fmt(l.n)}\`` : '              | ';
    const rCell = r ? `${r.device_type.padEnd(12)} | \`${fmt(r.n)}\`` : '              | ';
    rows.push(`| ${lCell} | ${rCell} |`);
  }
  return rows.join('\n');
}

function buildStatsTable(s, deviceCount) {
  // Rolling delta from history (will be filled after history append)
  return `| METRIC | COUNT | NOTES |
|:------:|:-----:|:-----:|
| **Total Unique OUIs** | \`${fmt(s.total)}\` | Deduplicated across 4 sources |
| **Cross-Validated** | \`${fmt(s.merged)}\` | Same OUI from multiple sources |
| **IEEE Registry Total** | \`${fmt(s.ieeeTotal)}\` | MA-L + MA-M + MA-S + IAB + CID |
| **Device Categories** | \`${deviceCount}\` | Auto-classified |
| **File Formats** | \`10\` | TXT to SQLite |
| **Monthly New OUIs** | \`~${MONTHLY_AVG_PLACEHOLDER}\` | IEEE assignments |`;
}

function buildWhatIsThis(s) {
  return `\`\`\`bash
ringmast4r@github:~$ cat oui-master-db.txt

  PURPOSE:        MAC address vendor lookup, the comprehensive way
  SCOPE:          Every IEEE registry + Wireshark + Nmap + HDM Mac-Tracker
  COVERAGE:       ${fmt(s.total)} unique OUIs, ${fmt(s.merged)} cross-validated entries
  FORMATS:        TXT, CSV, TSV, JSON, JSON-min, XML, SQLite, SQL, Kismet, Kismet.gz
  UPDATES:        First of every month via GitHub Actions
  USE CASES:      Wardriving | Network forensics | IoT discovery | Threat intel

  STATUS:         [ LIVE & AUTO-UPDATING ]
\`\`\``;
}

function buildFooter(today, total) {
  return `**Last updated:** \`${today}\` · **Total OUIs:** \`${fmt(total)}\` · **Maintained by** [@Ringmast4r](https://github.com/Ringmast4r)`;
}

function replaceBlock(readme, name, content) {
  const re = new RegExp(`<!-- AUTO:${name} -->[\\s\\S]*?<!-- /AUTO:${name} -->`);
  if (!re.test(readme)) {
    console.warn(`[warn] marker AUTO:${name} not found in README — skipping`);
    return readme;
  }
  return readme.replace(re, `<!-- AUTO:${name} -->\n${content}\n<!-- /AUTO:${name} -->`);
}

// Need to pre-compute monthly average for stats table — refactor placeholder
let MONTHLY_AVG_PLACEHOLDER = '365';

function main() {
  const today = new Date().toISOString().slice(0, 10);

  const stats = parseStats(fs.readFileSync(STATS_PATH, 'utf8'));
  const { sourcesPie, devices, unclassified } = queryDb(DB_PATH);
  const classified = stats.total - unclassified;

  const history = updateHistory(today, stats);
  const lastN = history.slice(-6);
  const totalDelta =
    lastN.length >= 2
      ? parseInt(lastN[lastN.length - 1][1], 10) - parseInt(lastN[0][1], 10)
      : 0;
  const weeksSpan = Math.max(
    1,
    Math.round(
      (new Date(lastN[lastN.length - 1][0]) - new Date(lastN[0][0])) / (7 * 86400000)
    )
  );
  MONTHLY_AVG_PLACEHOLDER = String(Math.round((totalDelta / weeksSpan) * 4.33) || 365);

  let readme = fs.readFileSync(README_PATH, 'utf8');

  // --- Inline replacements (URLs / badges) ---
  const totalFmt = fmt(stats.total);
  const totalEnc = urlEnc(totalFmt);

  // Capsule header desc=NN,NNN%20vendors
  readme = readme.replace(
    /(desc=)[\d,]+(%20vendors)/,
    `$1${totalFmt}$2`
  );
  // Typing SVG line: 88%2C577+OUIs
  readme = readme.replace(
    /([\d%2C]+)(\+OUIs%E2%80%94monthly|\+OUIs\+%E2%80%94|%2B[Oo][Uu][Ii][Ss])/,
    (m) => m // no-op fallback; precise match below
  );
  readme = readme.replace(
    /(lines=[^"]*?;)([\d%2C]+)(\+OUIs)/,
    `$1${totalEnc}$3`
  );
  // OUI badge: OUIs-NN%2CNNN-1E40AF
  readme = readme.replace(
    /(OUIs-)[\d%2C]+(-1E40AF)/,
    `$1${totalEnc}$2`
  );

  // --- Block replacements ---
  readme = replaceBlock(readme, 'WHAT_IS_THIS', buildWhatIsThis(stats));
  readme = replaceBlock(
    readme,
    'STATS_TABLE',
    buildStatsTable(stats, devices.length)
  );
  readme = replaceBlock(readme, 'GROWTH_CHART', buildGrowthChart(history));
  readme = replaceBlock(readme, 'SOURCES_PIE', buildSourcesPie(sourcesPie));
  readme = replaceBlock(readme, 'SOURCE_ROSTER', buildSourceRoster(stats));
  readme = replaceBlock(readme, 'IEEE_PIE', buildIeeePie(stats));
  readme = replaceBlock(readme, 'IEEE_TABLE', buildIeeeTable(stats));
  readme = replaceBlock(
    readme,
    'DEVICE_CAVEAT',
    buildDeviceCaveat(stats.total, classified, unclassified)
  );
  readme = replaceBlock(
    readme,
    'DEVICE_PIE',
    buildDevicePie(devices, stats.total, classified)
  );
  readme = replaceBlock(readme, 'DEVICE_TABLE', buildDeviceTable(devices));
  readme = replaceBlock(readme, 'FOOTER', buildFooter(today, stats.total));

  fs.writeFileSync(README_PATH, readme);
  console.log(`[update-readme] OK — total=${fmt(stats.total)} on ${today}`);
}

main();
