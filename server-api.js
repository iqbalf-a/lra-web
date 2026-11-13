import { existsSync } from "node:fs";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";

// Session adalah 24 hex digit pertama dari sha256 profile + path result (lihat cacheKey di
// lra-web-cache.js), jadi nilainya sudah dibatasi bentuknya. Polanya diperiksa di sini
// karena session datang dari query string dan langsung dipakai sebagai nama berkas: tanpa guard,
// `session=../../../../etc/foo` akan membaca berkas di luar folder cache.
const SESSION_KEY = /^[0-9a-f]{24}$/;
const CACHE_DIR = new URL("./.loadrunner-cache/", import.meta.url);

// Cache hanya boleh dibaca pemiliknya; admin boleh membaca semua. Satu cache bisa dimiliki beberapa
// profile (ZIP identik yang diupload orang berbeda). Metadata lama memakai field `profile` tunggal.
const ownersOf = (metadata) => metadata.owners ?? (metadata.profile != null ? [metadata.profile] : []);

export async function loadSessionMetadata(session, profile) {
  if (!SESSION_KEY.test(session ?? "")) throw new Error("Parameter session tidak valid.");
  let metadata;
  try {
    metadata = JSON.parse(await readFile(new URL(`${session}.json`, CACHE_DIR), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Cache result sudah tidak ada (mungkin dihapus admin). Klik Load lagi.");
    throw error;
  }
  if (profile !== "admin" && !ownersOf(metadata).includes(profile)) throw new Error("Session ini milik profile lain.");
  return metadata;
}

// Session wajib ada untuk semua endpoint dashboard/tabel, jadi pesan errornya dibedakan dari
// session yang salah bentuk.
export async function requireSession(url, profile) {
  const session = url.searchParams.get("session");
  if (!session) throw new Error("Parameter session wajib diisi.");
  return loadSessionMetadata(session, profile);
}

const sizeOf = (file) => stat(new URL(file, CACHE_DIR)).then((info) => info.size, () => 0);

// Daftar cache result semua profile, untuk panel admin.
export async function listCaches() {
  const names = await readdir(CACHE_DIR).catch(() => []);
  const keys = names.filter((name) => /^[0-9a-f]{24}\.json$/.test(name)).map((name) => name.slice(0, -5));
  const caches = await Promise.all(keys.map(async (key) => {
    const info = await stat(new URL(`${key}.json`, CACHE_DIR));
    const metadata = JSON.parse(await readFile(new URL(`${key}.json`, CACHE_DIR), "utf8"));
    const sizes = await Promise.all([`${key}.json`, `${key}.duckdb`, `${key}.duckdb.wal`].map(sizeOf));
    return {
      key,
      owners: ownersOf(metadata),
      label: metadata.label ?? metadata.result?.resultDir ?? "",
      bytes: sizes.reduce((sum, size) => sum + size, 0),
      modified: info.mtimeMs,
    };
  }));
  return caches.sort((a, b) => b.modified - a.modified);
}

// Antrean agar dua upload ZIP identik yang selesai bersamaan tidak saling menimpa daftar owners.
let ownerQueue = Promise.resolve();

// Tambahkan profile ke pemilik cache yang sudah ada. Mengembalikan metadata, atau null kalau cache
// (json + duckdb) belum ada sehingga pemanggil harus ingest.
export function addOwner(key, profile) {
  const task = ownerQueue.then(async () => {
    if (!SESSION_KEY.test(key) || !existsSync(new URL(`${key}.duckdb`, CACHE_DIR))) return null;
    const file = new URL(`${key}.json`, CACHE_DIR);
    let metadata;
    try {
      metadata = JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
    const owners = ownersOf(metadata);
    if (!owners.includes(profile)) {
      metadata.owners = [...owners, profile];
      delete metadata.profile;
      await writeFile(file, JSON.stringify(metadata), "utf8");
    }
    return metadata;
  });
  ownerQueue = task.catch(() => {});
  return task;
}

// .duckdb dihapus dulu: kalau file itu masih terkunci (Windows) error-nya naik dan metadata tetap
// ada, jadi cache tidak setengah terhapus.
export async function deleteCache(key) {
  if (!SESSION_KEY.test(key ?? "")) throw new Error("Parameter session tidak valid.");
  for (const name of [`${key}.duckdb`, `${key}.duckdb.wal`, `${key}.json`]) {
    await rm(new URL(name, CACHE_DIR), { force: true });
  }
}

export function parseExtraNames(url) {
  const raw = url.searchParams.get("extraNames");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

// Filter Include/Exclude panel TPS/RPS: pola dipisah koma. null kalau kedua parameter tidak dikirim,
// supaya pemanggil lain tetap memakai filter prefix bawaan.
// Normalize filter: accept {include: "str", exclude: "str"} or {include: [...], exclude: [...]}
export function normalizeNameFilter(filter) {
  if (!filter) return null;
  const toArray = (val) => {
    if (!val) return [];
    if (Array.isArray(val)) return val.filter((v) => typeof v === "string");
    return String(val).split(",").map((v) => v.trim()).filter(Boolean);
  };
  return { include: toArray(filter.include), exclude: toArray(filter.exclude) };
}

export function parseNameFilter(url) {
  if (url.searchParams.has("names")) {
    try {
      const names = JSON.parse(url.searchParams.get("names"));
      if (Array.isArray(names)) return { include: [], exclude: [], names: names.filter((name) => typeof name === "string") };
    } catch {
      // Parameter rusak: lanjut ke filter include/exclude di bawah.
    }
  }
  if (!url.searchParams.has("include") && !url.searchParams.has("exclude")) return null;
  const list = (name) => (url.searchParams.get(name) ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return { include: list("include"), exclude: list("exclude") };
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}
