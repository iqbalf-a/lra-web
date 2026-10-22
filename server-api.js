import { readFile } from "node:fs/promises";

// Session adalah 24 hex digit pertama dari sha256 path result (lihat cacheKey di
// lra-web-cache.js), jadi nilainya sudah dibatasi bentuknya. Polanya diperiksa di sini
// karena session datang dari query string dan langsung dipakai sebagai nama berkas: tanpa guard,
// `session=../../../../etc/foo` akan membaca berkas di luar folder cache.
const SESSION_KEY = /^[0-9a-f]{24}$/;

export async function loadSessionMetadata(session) {
  if (!SESSION_KEY.test(session ?? "")) throw new Error("Parameter session tidak valid.");
  return JSON.parse(await readFile(new URL(`./.loadrunner-cache/${session}.json`, import.meta.url), "utf8"));
}

// Session wajib ada untuk semua endpoint dashboard/tabel, jadi pesan errornya dibedakan dari
// session yang salah bentuk.
export async function requireSession(url) {
  const session = url.searchParams.get("session");
  if (!session) throw new Error("Parameter session wajib diisi.");
  return loadSessionMetadata(session);
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
