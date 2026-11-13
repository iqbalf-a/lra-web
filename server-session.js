import { readFile, writeFile } from "node:fs/promises";
import { deleteCache, listCaches, sendJson } from "./server-api.js";

// Profile cuma label pemakai (bukan autentikasi): cookie bisa dipalsukan, dan "admin" tidak
// pakai password. Cukup untuk alat internal; upgrade ke login sungguhan kalau server dibuka ke jaringan.
const PROFILES_FILE = new URL("./profiles.json", import.meta.url);
const COOKIE = "lra-profile";
const NAME_PATTERN = /^[a-z0-9_-]{2,32}$/;

async function listProfiles() {
  try {
    return JSON.parse(await readFile(PROFILES_FILE, "utf8"));
  } catch {
    return [];
  }
}

const saveProfiles = (profiles) => writeFile(PROFILES_FILE, `${JSON.stringify(profiles, null, 2)}\n`, "utf8");

// "admin" selalu valid dan tidak disimpan di berkas.
async function profileExists(name) {
  return name === "admin" || (await listProfiles()).includes(name);
}

function profileFromCookie(req) {
  const match = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function setCookie(res, value, extra = "") {
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict${extra}`);
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

// Menangani /api/session, /api/profiles, dan menolak (401) semua /api/* lain tanpa profile aktif.
// Mengembalikan true kalau respons sudah dikirim; false berarti request boleh diteruskan.
export async function handleSessionApi(req, res, url) {
  const path = url.pathname;
  if (!path.startsWith("/api/")) return false;
  const method = req.method ?? "GET";
  const profile = profileFromCookie(req);
  req.profile = profile;

  if (path === "/api/session") {
    if (method === "GET") {
      sendJson(res, 200, { profile: profile && (await profileExists(profile)) ? profile : null });
    } else if (method === "POST") {
      const name = String((await readJsonBody(req)).profile ?? "").trim();
      if (!name) sendJson(res, 400, { error: "Field 'profile' wajib diisi." });
      else if (!(await profileExists(name))) sendJson(res, 404, { error: `Profile "${name}" tidak ditemukan.` });
      else { setCookie(res, name); sendJson(res, 200, { profile: name }); }
    } else if (method === "DELETE") {
      setCookie(res, "", "; Max-Age=0");
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 405, { error: "Method tidak diizinkan." });
    }
    return true;
  }

  if (path === "/api/profiles" || path.startsWith("/api/profiles/")) {
    if (method === "GET" && path === "/api/profiles") {
      sendJson(res, 200, { profiles: await listProfiles() });
      return true;
    }
    if (profile !== "admin") { sendJson(res, 403, { error: "Hanya admin yang boleh mengelola profile." }); return true; }
    const profiles = await listProfiles();
    if (method === "POST" && path === "/api/profiles") {
      const name = String((await readJsonBody(req)).name ?? "").trim().toLowerCase();
      if (!NAME_PATTERN.test(name)) sendJson(res, 400, { error: "Nama profile: 2-32 karakter, huruf kecil/angka/-/_." });
      else if (name === "admin") sendJson(res, 400, { error: "Nama 'admin' sudah dipakai sistem." });
      else if (profiles.includes(name)) sendJson(res, 409, { error: `Profile "${name}" sudah ada.` });
      else { await saveProfiles([...profiles, name].sort()); sendJson(res, 201, { profile: name }); }
    } else if (method === "DELETE") {
      const name = decodeURIComponent(path.slice("/api/profiles/".length));
      if (!profiles.includes(name)) sendJson(res, 404, { error: `Profile "${name}" tidak ditemukan.` });
      else { await saveProfiles(profiles.filter((p) => p !== name)); sendJson(res, 200, { ok: true }); }
    } else {
      sendJson(res, 405, { error: "Method tidak diizinkan." });
    }
    return true;
  }

  if (path === "/api/admin/caches" || path.startsWith("/api/admin/caches/")) {
    if (profile !== "admin") { sendJson(res, 403, { error: "Hanya admin yang boleh mengelola cache." }); return true; }
    if (method === "GET" && path === "/api/admin/caches") {
      sendJson(res, 200, { caches: await listCaches() });
    } else if (method === "DELETE" && path !== "/api/admin/caches") {
      try {
        await deleteCache(path.slice("/api/admin/caches/".length));
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    } else {
      sendJson(res, 405, { error: "Method tidak diizinkan." });
    }
    return true;
  }

  if (!profile) {
    sendJson(res, 401, { error: "Belum ada profile aktif. Pilih profile untuk melanjutkan." });
    return true;
  }
  return false;
}
