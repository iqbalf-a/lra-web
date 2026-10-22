import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openLoadRunnerCache, queryDashboard, queryTransactions, queryTpsSummary, queryResponseTimeSeries, queryTpsSeries, queryTpsDetailSummary, queryTpsDetailSeries, queryTpsOverall } from "./lra-web-cache.js";
import { queryErrors } from "./lra-web-errors.js";
import { startProgress, readProgress } from "./progress.js";
import { loadSessionMetadata, requireSession, parseExtraNames, normalizeNameFilter, parseNameFilter, sendJson } from "./server-api.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(__dirname, "dist");
const PORT = 8787;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

async function serveStatic(res, urlPath) {
  const safePath = urlPath === "/" ? "index.html" : urlPath;
  let filePath = resolve(join(DIST, safePath));
  if (!filePath.startsWith(DIST + sep)) filePath = join(DIST, "index.html");
  if (!existsSync(filePath)) filePath = join(DIST, "index.html");
  try {
    const data = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[extname(filePath)] ?? "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  try {
    if (path === "/api/progress") {
      sendJson(res, 200, readProgress(url.searchParams.get("token") ?? ""));

    } else if (path === "/api/load") {
      const progress = startProgress(url.searchParams.get("progress") ?? "");
      const resultPath = url.searchParams.get("path");
      if (!resultPath) { sendJson(res, 400, { error: "Parameter path wajib diisi." }); return; }
      try {
        const cached = await openLoadRunnerCache(resultPath, { progress });
        progress.done();
        sendJson(res, 200, { session: cached.key, result: cached.result, cache: { rowCount: cached.rowCount } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        progress.fail(message);
        sendJson(res, 500, { error: message });
      }

    } else if (path === "/api/dashboard") {
      const cached = await requireSession(url);
      sendJson(res, 200, await queryDashboard(cached,
        Number(url.searchParams.get("start")),
        Number(url.searchParams.get("end")),
        Number(url.searchParams.get("granularity")),
        {
          maxSeriesPerGraph: Number(url.searchParams.get("maxSeries")) || undefined,
          focusGraphType: url.searchParams.get("focusGraphType") || undefined,
          focusMeasurementId: Number(url.searchParams.get("focusMeasurementId")),
        }
      ));

    } else if (path === "/api/transactions") {
      let session, start, end, limit, offset, namePrefix, nameFilter, order, cached;
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = body ? JSON.parse(body) : {};
        session = parsed.session; start = parsed.start; end = parsed.end;
        limit = parsed.limit; offset = parsed.offset; namePrefix = parsed.namePrefix;
        nameFilter = normalizeNameFilter(parsed.nameFilter); order = parsed.order;
        if (!session) throw new Error("Parameter session wajib diisi.");
        cached = await loadSessionMetadata(session);
      } else {
        cached = await requireSession(url);
        start = url.searchParams.get("start"); end = url.searchParams.get("end");
        limit = url.searchParams.get("limit"); offset = url.searchParams.get("offset");
        namePrefix = url.searchParams.get("namePrefix");
        nameFilter = parseNameFilter(url); order = url.searchParams.get("order");
      }
      sendJson(res, 200, await queryTransactions(cached,
        Number(start), Number(end), Number(limit), Number(offset),
        namePrefix || "", nameFilter, order || "name"
      ));

    } else if (path === "/api/tps-summary") {
      const cached = await requireSession(url);
      sendJson(res, 200, await queryTpsSummary(cached,
        Number(url.searchParams.get("start")),
        Number(url.searchParams.get("end")),
        Number(url.searchParams.get("granularity")),
        Number(url.searchParams.get("limit")),
        Number(url.searchParams.get("offset")),
        url.searchParams.get("namePrefix") || "",
        parseNameFilter(url)
      ));

    } else if (path === "/api/tps-detail-summary") {
      const cached = await requireSession(url);
      sendJson(res, 200, await queryTpsDetailSummary(cached,
        Number(url.searchParams.get("start")),
        Number(url.searchParams.get("end")),
        Number(url.searchParams.get("granularity")),
        url.searchParams.get("namePrefix") || "BP",
        parseNameFilter(url)
      ));

    } else if (path === "/api/tps-detail-series") {
      const cached = await requireSession(url);
      sendJson(res, 200, await queryTpsDetailSeries(cached,
        Number(url.searchParams.get("start")),
        Number(url.searchParams.get("end")),
        Number(url.searchParams.get("granularity")),
        {
          maxSeries: Number(url.searchParams.get("maxSeries")) || undefined,
          namePrefix: url.searchParams.get("namePrefix") || "BP",
          extraNames: parseExtraNames(url),
          nameFilter: parseNameFilter(url),
        }
      ));

    } else if (path === "/api/tps-overall") {
      const cached = await requireSession(url);
      sendJson(res, 200, await queryTpsOverall(cached,
        Number(url.searchParams.get("start")),
        Number(url.searchParams.get("end")),
        Number(url.searchParams.get("granularity")),
        url.searchParams.get("namePrefix") || "BP",
        parseNameFilter(url)
      ));

    } else if (path === "/api/response-time-series") {
      const cached = await requireSession(url);
      sendJson(res, 200, await queryResponseTimeSeries(cached,
        Number(url.searchParams.get("start")),
        Number(url.searchParams.get("end")),
        Number(url.searchParams.get("granularity")),
        {
          maxSeries: Number(url.searchParams.get("maxSeries")) || undefined,
          namePrefix: url.searchParams.get("namePrefix") || "",
          extraNames: parseExtraNames(url),
          nameFilter: parseNameFilter(url),
        }
      ));

    } else if (path === "/api/errors") {
      const progress = startProgress(url.searchParams.get("progress") ?? "");
      try {
        const session = url.searchParams.get("session");
        const cached = session ? await loadSessionMetadata(session) : null;
        const optionalNumber = (name) => {
          const raw = url.searchParams.get(name);
          return raw === null || raw === "" ? undefined : Number(raw);
        };
        const payload = await queryErrors(cached, {
          start: optionalNumber("start"),
          end: optionalNumber("end"),
          granularity: optionalNumber("granularity"),
          scriptId: optionalNumber("script"),
          errorCode: optionalNumber("code"),
          message: url.searchParams.get("message") || "",
          dbPath: url.searchParams.get("dbPath") || "",
          progress,
        });
        progress.done();
        sendJson(res, 200, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        progress.fail(message);
        sendJson(res, 500, { error: message });
      }

    } else if (path === "/api/tps-series") {
      const cached = await requireSession(url);
      sendJson(res, 200, await queryTpsSeries(cached,
        Number(url.searchParams.get("start")),
        Number(url.searchParams.get("end")),
        Number(url.searchParams.get("granularity")),
        {
          maxSeries: Number(url.searchParams.get("maxSeries")) || undefined,
          namePrefix: url.searchParams.get("namePrefix") || "",
          extraNames: parseExtraNames(url),
          nameFilter: parseNameFilter(url),
        }
      ));

    } else {
      await serveStatic(res, path);
    }
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Server berjalan di http://127.0.0.1:${PORT}`);
});
