import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

// Hanya file yang dibaca loadLoadRunnerResult() untuk ingest dashboard yang diekstrak. offline.dat
// sengaja dilewati (ratusan MB, hanya dipakai ringkasan CLI). graph_N.dat di akar result juga
// diambil: sebagian result menaruh satu graph di sebelah sum_data (lihat resolveGraphFile).
const WHITELIST = [
  { test: /^[^/]+\.lrr$/i, canonical: (name) => name },
  { test: /^RunInfo\.ini$/i, canonical: () => "RunInfo.ini" },
  { test: /^RawData\.map$/i, canonical: () => "RawData.map" },
  { test: /^offl_\d+\.def$/i, canonical: (name) => name.toLowerCase() },
  { test: /^graph_\d+\.dat$/i, canonical: (name) => name.toLowerCase() },
  { test: /^sum_data\/sum_dat\.ini$/i, canonical: () => "sum_data/sum_dat.ini" },
  { test: /^sum_data\/graph_\d+\.dat$/i, canonical: (name) => `sum_data/${path.posix.basename(name).toLowerCase()}` },
];

// Nama tujuan selalu berasal dari WHITELIST (bukan dari nama di ZIP), jadi zip-slip tidak mungkin;
// entri dengan "..", path absolut, atau drive letter tetap dibuang di sini.
function normalizeEntryName(raw) {
  const name = String(raw).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!name || name.endsWith("/")) return null;
  if (name.startsWith("/") || /^[a-z]:/i.test(name)) return null;
  if (name.split("/").some((segment) => segment === "..")) return null;
  return name;
}

// Root result bisa di mana saja di dalam ZIP; dicari dari .lrr (fallback RunInfo.ini) yang terdangkal.
function detectRoot(names) {
  const candidates = names.filter((name) => /\.lrr$/i.test(name) || /(^|\/)RunInfo\.ini$/i.test(name));
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    if (depth !== 0) return depth;
    const lrr = Number(/\.lrr$/i.test(b)) - Number(/\.lrr$/i.test(a));
    return lrr !== 0 ? lrr : a.localeCompare(b);
  });
  const dir = path.posix.dirname(candidates[0]);
  return dir === "." ? "" : `${dir}/`;
}

const openZip = (zipPath) => new Promise((resolve, reject) => {
  yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (error, zipfile) => (error ? reject(error) : resolve(zipfile)));
});

const readAllEntries = (zipfile) => new Promise((resolve, reject) => {
  const entries = [];
  zipfile.on("entry", (entry) => { entries.push(entry); zipfile.readEntry(); });
  zipfile.on("end", () => resolve(entries));
  zipfile.on("error", reject);
  zipfile.readEntry();
});

const openEntryStream = (zipfile, entry) => new Promise((resolve, reject) => {
  zipfile.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream)));
});

// Ekstrak file raw result dari ZIP ke targetDir, struktur diratakan ke root result.
export async function extractResultZip(zipPath, targetDir, { maxBytes = Number.MAX_SAFE_INTEGER, onProgress } = {}) {
  const zipfile = await openZip(zipPath);
  try {
    const normalized = (await readAllEntries(zipfile))
      .map((entry) => ({ entry, name: normalizeEntryName(entry.fileName) }))
      .filter((item) => item.name !== null);

    const root = detectRoot(normalized.map((item) => item.name));
    if (root === null) throw new Error("ZIP tidak berisi raw result LoadRunner (file .lrr atau RunInfo.ini tidak ditemukan).");

    const selected = [];
    for (const { entry, name } of normalized) {
      if (!name.startsWith(root)) continue;
      const relative = name.slice(root.length);
      const rule = WHITELIST.find((item) => item.test.test(relative));
      if (rule) selected.push({ entry, canonical: rule.canonical(relative) });
    }
    if (!selected.length) throw new Error("ZIP tidak memuat file result yang dibutuhkan (sum_data, RunInfo.ini, dll).");

    await mkdir(path.join(targetDir, "sum_data"), { recursive: true });
    let bytes = 0;
    for (const [index, { entry, canonical }] of selected.entries()) {
      bytes += Number(entry.uncompressedSize) || 0;
      if (bytes > maxBytes) throw new Error(`Isi ZIP melebihi batas ekstraksi (${maxBytes} byte).`);
      await pipeline(await openEntryStream(zipfile, entry), createWriteStream(path.join(targetDir, ...canonical.split("/"))));
      onProgress?.((index + 1) / selected.length);
    }
    return { fileCount: selected.length, bytes };
  } finally {
    zipfile.close();
  }
}
