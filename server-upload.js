import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { startProgress } from "./progress.js";
import { addOwner, sendJson } from "./server-api.js";
import { extractResultZip } from "./server-unzip.js";

const UPLOAD_DIR = fileURLToPath(new URL("./.loadrunner-uploads/", import.meta.url));
const MAX_UPLOAD_BYTES = Number(process.env.LR_MAX_UPLOAD_BYTES) || 8 * 2 ** 30;
const MAX_EXTRACT_BYTES = Number(process.env.LR_MAX_EXTRACT_BYTES) || 24 * 2 ** 30;

// Ingest DuckDB berat; antre satu per satu. inflight membuat ZIP identik yang datang bersamaan
// hanya di-ingest sekali.
let ingestQueue = Promise.resolve();
const inflight = new Map();

// openLoadRunnerCache melapor 0..100 untuk dirinya sendiri; dipetakan ke sisa rentang progres upload.
function scaled(progress, from, to) {
  const map = (value) => from + (to - from) * (value / 100);
  return {
    phase: (label, a, b) => progress.phase(label, map(a), map(b)),
    set: (fraction) => progress.set(fraction),
  };
}

async function ingestZip({ key, sha, zipPath, label, profile, progress }) {
  const { openLoadRunnerCache } = await import("./lra-web-cache.js");
  const dir = `${UPLOAD_DIR}x-${key}`;
  try {
    progress.phase("Mengekstrak ZIP...", 25, 35);
    await extractResultZip(zipPath, dir, { maxBytes: MAX_EXTRACT_BYTES, onProgress: (fraction) => progress.set(fraction) });
    return await openLoadRunnerCache(dir, { progress: scaled(progress, 35, 100), key, fingerprint: sha, label, profile });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function handleUpload(req, res, url) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method tidak diizinkan." });
  const total = Number(req.headers["content-length"]) || 0;
  if (total > MAX_UPLOAD_BYTES) {
    res.setHeader("Connection", "close");
    return sendJson(res, 413, { error: `Ukuran ZIP melebihi batas ${(MAX_UPLOAD_BYTES / 2 ** 30).toFixed(1)} GB.` });
  }

  const label = basename(url.searchParams.get("name") || "result.zip").replace(/[\u0000-\u001f]/g, "").slice(0, 200) || "result.zip";
  const progress = startProgress(url.searchParams.get("progress") ?? "");
  const zipPath = `${UPLOAD_DIR}tmp-${randomUUID()}.zip`;
  try {
    await mkdir(UPLOAD_DIR, { recursive: true });
    const hash = createHash("sha256");
    let received = 0;
    progress.phase("Mengunggah ZIP...", 0, 25);
    await pipeline(
      req,
      new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > MAX_UPLOAD_BYTES) return callback(new Error("Ukuran ZIP melebihi batas upload."));
          hash.update(chunk);
          if (total) progress.set(received / total);
          callback(null, chunk);
        },
      }),
      createWriteStream(zipPath),
    );
    if (!received) throw new Error("Body upload kosong.");

    const sha = hash.digest("hex");
    const key = sha.slice(0, 24);
    let metadata = await addOwner(key, req.profile);
    if (!metadata) {
      let job = inflight.get(key);
      if (!job) {
        job = ingestQueue.then(() => ingestZip({ key, sha, zipPath, label, profile: req.profile, progress }));
        ingestQueue = job.catch(() => {});
        inflight.set(key, job);
        job.then(() => inflight.delete(key), () => inflight.delete(key));
      } else {
        progress.phase("Menunggu ZIP identik yang sedang diproses...", 25, 99);
      }
      metadata = await job;
      // Peminta yang bukan pembuat job (ZIP identik bersamaan) ditambahkan sebagai owner.
      metadata = (await addOwner(key, req.profile)) ?? metadata;
    }
    progress.done();
    sendJson(res, 200, { session: key, result: metadata.result, cache: { rowCount: metadata.rowCount } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progress.fail(message);
    if (!res.headersSent) sendJson(res, 500, { error: message });
  } finally {
    await rm(zipPath, { force: true });
  }
}
