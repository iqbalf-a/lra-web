import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { startProgress, readProgress } from "./progress.js";
import { loadSessionMetadata, requireSession, parseExtraNames, normalizeNameFilter, parseNameFilter, sendJson } from "./server-api.js";

// @duckdb/node-api adalah native addon — esbuild crash kalau di-import secara statis saat
// memuat vite.config.js. Modul ini di-import secara lazy pada request pertama ke dev server,
// sehingga `npm run build` (yang tidak memakai configureServer) bisa jalan tanpa masalah.
let lraCache, lraErrors;
async function getCache() { return lraCache ??= await import("./lra-web-cache.js"); }
async function getErrors() { return lraErrors ??= await import("./lra-web-errors.js"); }

export default defineConfig({
  plugins: [
    tailwindcss(),
    {
      name: "loadrunner-api",
      configureServer(server) {
        server.middlewares.use("/api/progress", (req, res) => {
          const url = new URL(req.url ?? "", "http://127.0.0.1");
          sendJson(res, 200, readProgress(url.searchParams.get("token") ?? ""));
        });
        server.middlewares.use("/api/load", async (req, res) => {
          const url = new URL(req.url ?? "", "http://127.0.0.1");
          const progress = startProgress(url.searchParams.get("progress") ?? "");
          try {
            const resultPath = url.searchParams.get("path");
            if (!resultPath) {
              sendJson(res, 400, { error: "Parameter path wajib diisi." });
              return;
            }
            const { openLoadRunnerCache } = await getCache();
            const cached = await openLoadRunnerCache(resultPath, { progress });
            progress.done();
            sendJson(res, 200, {
              session: cached.key,
              result: cached.result,
              cache: { rowCount: cached.rowCount },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            progress.fail(message);
            sendJson(res, 500, { error: message });
          }
        });
        server.middlewares.use("/api/dashboard", async (req, res) => {
          try {
            const url = new URL(req.url ?? "", "http://127.0.0.1");
            const { queryDashboard } = await getCache();
            const cached = await requireSession(url);
            sendJson(res, 200, await queryDashboard(cached, Number(url.searchParams.get("start")), Number(url.searchParams.get("end")), Number(url.searchParams.get("granularity")), {
              maxSeriesPerGraph: Number(url.searchParams.get("maxSeries")) || undefined,
              focusGraphType: url.searchParams.get("focusGraphType") || undefined,
              focusMeasurementId: Number(url.searchParams.get("focusMeasurementId")),
            }));
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        });
        server.middlewares.use("/api/transactions", async (req, res) => {
          try {
            const { queryTransactions } = await getCache();
            // Support both GET (query params) and POST (JSON body)
            let session, start, end, limit, offset, namePrefix, nameFilter, order;
            let cached;
            if (req.method === "POST") {
              let body = "";
              for await (const chunk of req) body += chunk;
              const parsed = body ? JSON.parse(body) : {};
              session = parsed.session;
              start = parsed.start;
              end = parsed.end;
              limit = parsed.limit;
              offset = parsed.offset;
              namePrefix = parsed.namePrefix;
              nameFilter = normalizeNameFilter(parsed.nameFilter);
              order = parsed.order;
              if (!session) throw new Error("Parameter session wajib diisi.");
              cached = await loadSessionMetadata(session);
            } else {
              const url = new URL(req.url ?? "", "http://127.0.0.1");
              cached = await requireSession(url);
              start = url.searchParams.get("start");
              end = url.searchParams.get("end");
              limit = url.searchParams.get("limit");
              offset = url.searchParams.get("offset");
              namePrefix = url.searchParams.get("namePrefix");
              nameFilter = parseNameFilter(url);
              order = url.searchParams.get("order");
            }
            sendJson(res, 200, await queryTransactions(cached, Number(start), Number(end), Number(limit), Number(offset), namePrefix || "", nameFilter, order || "name"));
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        });
        server.middlewares.use("/api/tps-summary", async (req, res) => {
          try {
            const url = new URL(req.url ?? "", "http://127.0.0.1");
            const { queryTpsSummary } = await getCache();
            const cached = await requireSession(url);
            sendJson(res, 200, await queryTpsSummary(cached, Number(url.searchParams.get("start")), Number(url.searchParams.get("end")), Number(url.searchParams.get("granularity")), Number(url.searchParams.get("limit")), Number(url.searchParams.get("offset")), url.searchParams.get("namePrefix") || "", parseNameFilter(url)));
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        });
        server.middlewares.use("/api/tps-detail-summary", async (req, res) => {
          try {
            const url = new URL(req.url ?? "", "http://127.0.0.1");
            const { queryTpsDetailSummary } = await getCache();
            const cached = await requireSession(url);
            sendJson(res, 200, await queryTpsDetailSummary(cached, Number(url.searchParams.get("start")), Number(url.searchParams.get("end")), Number(url.searchParams.get("granularity")), url.searchParams.get("namePrefix") || "BP", parseNameFilter(url)));
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        });
        server.middlewares.use("/api/tps-detail-series", async (req, res) => {
          try {
            const url = new URL(req.url ?? "", "http://127.0.0.1");
            const { queryTpsDetailSeries } = await getCache();
            const cached = await requireSession(url);
            sendJson(res, 200, await queryTpsDetailSeries(cached, Number(url.searchParams.get("start")), Number(url.searchParams.get("end")), Number(url.searchParams.get("granularity")), {
              maxSeries: Number(url.searchParams.get("maxSeries")) || undefined,
              namePrefix: url.searchParams.get("namePrefix") || "BP",
              extraNames: parseExtraNames(url),
              nameFilter: parseNameFilter(url),
            }));
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        });
        server.middlewares.use("/api/tps-overall", async (req, res) => {
          try {
            const url = new URL(req.url ?? "", "http://127.0.0.1");
            const { queryTpsOverall } = await getCache();
            const cached = await requireSession(url);
            sendJson(res, 200, await queryTpsOverall(cached, Number(url.searchParams.get("start")), Number(url.searchParams.get("end")), Number(url.searchParams.get("granularity")), url.searchParams.get("namePrefix") || "BP", parseNameFilter(url)));
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        });
        server.middlewares.use("/api/response-time-series", async (req, res) => {
          try {
            const url = new URL(req.url ?? "", "http://127.0.0.1");
            const { queryResponseTimeSeries } = await getCache();
            const cached = await requireSession(url);
            sendJson(res, 200, await queryResponseTimeSeries(cached, Number(url.searchParams.get("start")), Number(url.searchParams.get("end")), Number(url.searchParams.get("granularity")), {
              maxSeries: Number(url.searchParams.get("maxSeries")) || undefined,
              namePrefix: url.searchParams.get("namePrefix") || "",
              extraNames: parseExtraNames(url),
              nameFilter: parseNameFilter(url),
            }));
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        });
        server.middlewares.use("/api/errors", async (req, res) => {
          const url = new URL(req.url ?? "", "http://127.0.0.1");
          const progress = startProgress(url.searchParams.get("progress") ?? "");
          try {
            const { queryErrors } = await getErrors();
            // Session opsional di endpoint ini: panel Errors bisa jalan hanya dari path SqliteDb.db.
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
        });
        server.middlewares.use("/api/tps-series", async (req, res) => {
          try {
            const url = new URL(req.url ?? "", "http://127.0.0.1");
            const { queryTpsSeries } = await getCache();
            const cached = await requireSession(url);
            sendJson(res, 200, await queryTpsSeries(cached, Number(url.searchParams.get("start")), Number(url.searchParams.get("end")), Number(url.searchParams.get("granularity")), {
              maxSeries: Number(url.searchParams.get("maxSeries")) || undefined,
              namePrefix: url.searchParams.get("namePrefix") || "",
              extraNames: parseExtraNames(url),
              nameFilter: parseNameFilter(url),
            }));
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 8787,
    // Runtime cache, bukan source — watch file .wal yang dikunci DuckDB bikin crash EBUSY di Windows.
    watch: {
      ignored: ["**/.loadrunner-cache/**"],
    },
  },
  build: {
    rollupOptions: {
      input: {
        app: "index.html",
      },
    },
  },
});
