const CARD = "border border-(--line) rounded-[3px] bg-(--surface-raised) text-(--text) cursor-pointer";
const INPUT = "h-8 flex-1 px-2.5 border border-(--line) rounded-[3px] bg-(--surface-raised) text-(--text) text-[12.5px]";
const MONO = 'style="font-family: var(--font-mono);"';

async function api(path, init) {
  const response = await fetch(path, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const formatSize = (bytes) => (bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(2)} GB` : `${(bytes / 2 ** 20).toFixed(1)} MB`);
const esc = (text) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

let overlay = null;

async function render(admin, done) {
  const { profiles } = await api("/api/profiles");
  const caches = admin ? (await api("/api/admin/caches")).caches : [];
  const totalBytes = caches.reduce((sum, c) => sum + c.bytes, 0);
  const showError = (message) => {
    const el = overlay.querySelector("[data-error]");
    el.textContent = message;
    el.hidden = false;
  };
  const guard = (fn) => async (...args) => { try { await fn(...args); } catch (e) { showError(e.message); } };

  overlay.innerHTML = `
    <div class="min-h-full flex items-center justify-center p-4">
      <div class="w-full max-w-120">
        <div class="mb-6 text-center">
          <div class="text-[22px] font-bold tracking-tight">lra web</div>
          <div class="mt-1 text-[11px] text-(--chart-text)" ${MONO}>${admin ? "Admin - kelola profile" : "Pilih profile"}</div>
        </div>
        ${admin ? `
          <div class="mb-4 space-y-1.5">${profiles.map((p) => `
            <div class="flex items-center justify-between ${CARD} px-3 py-1.5 cursor-default">
              <span class="text-[12.5px]" ${MONO}>${esc(p)}</span>
              <button data-del="${esc(p)}" class="text-[11px] text-(--chart-text) hover:text-(--danger) cursor-pointer">Hapus</button>
            </div>`).join("") || `<p class="text-center text-[12px] text-(--chart-text)">Belum ada profile.</p>`}</div>
          <div class="flex gap-2">
            <input data-new placeholder="nama profile baru" spellcheck="false" class="${INPUT}">
            <button data-add class="h-8 px-3 ${CARD} text-[12px] font-medium">Tambah</button>
          </div>
          <div class="mt-6 border-t border-(--line) pt-4">
            <div class="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-[0.08em] text-(--chart-text)" ${MONO}>
              <span>Cache result - ${caches.length} item, ${formatSize(totalBytes)}</span>
              ${caches.length ? `<button data-del-all class="uppercase hover:text-(--danger) cursor-pointer">Hapus semua</button>` : ""}
            </div>
            <div class="space-y-1.5">${caches.map((c) => `
              <div class="flex items-center justify-between gap-3 ${CARD} px-3 py-1.5 cursor-default">
                <div class="min-w-0 text-[11.5px]" ${MONO}>
                  <div class="truncate" title="${esc(c.label)}">${esc(c.label) || c.key}</div>
                  <div class="text-(--chart-text)">${esc(c.owners.join(", ") || "(tanpa owner)")} - ${formatSize(c.bytes)} - ${new Date(c.modified).toLocaleString("id-ID")}</div>
                </div>
                <button data-del-cache="${c.key}" class="shrink-0 text-[11px] text-(--chart-text) hover:text-(--danger) cursor-pointer">Hapus</button>
              </div>`).join("") || `<p class="text-center text-[12px] text-(--chart-text)">Cache kosong.</p>`}</div>
          </div>
          <div class="mt-5 text-center"><button data-back class="text-[11px] text-(--chart-text) hover:text-(--text) cursor-pointer" ${MONO}>Lanjut sebagai user biasa</button></div>
        ` : `
          <div class="mb-6 grid grid-cols-3 gap-3">${profiles.map((p) => `
            <button data-pick="${esc(p)}" class="${CARD} px-3 py-3.5 text-[12.5px] hover:border-(--signal)" ${MONO}>${esc(p)}</button>`).join("")}</div>
          <div class="border-t border-(--line) pt-4">
            <div class="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-(--chart-text)" ${MONO}>Admin</div>
            <div class="flex gap-2">
              <input data-admin placeholder="ketik admin lalu Enter" spellcheck="false" class="${INPUT}">
              <button data-admin-go class="h-8 px-3 ${CARD} text-[12px] font-medium">Masuk</button>
            </div>
          </div>
        `}
        <p data-error hidden class="mt-3 text-[11.5px] text-(--danger)"></p>
      </div>
    </div>`;

  const on = (selector, event, fn) => overlay.querySelector(selector)?.addEventListener(event, guard(fn));
  const onEnter = (selector, fn) => on(selector, "keydown", (e) => e.key === "Enter" && fn());

  overlay.querySelectorAll("[data-pick]").forEach((btn) => btn.addEventListener("click", guard(async () => {
    const { profile } = await post("/api/session", { profile: btn.dataset.pick });
    overlay.hidden = true;
    done(profile);
  })));
  overlay.querySelectorAll("[data-del]").forEach((btn) => btn.addEventListener("click", guard(async () => {
    await api(`/api/profiles/${encodeURIComponent(btn.dataset.del)}`, { method: "DELETE" });
    await render(true, done);
  })));

  const deleteCaches = async (keys) => {
    for (const key of keys) await api(`/api/admin/caches/${key}`, { method: "DELETE" });
    await render(true, done);
  };
  overlay.querySelectorAll("[data-del-cache]").forEach((btn) => btn.addEventListener("click", guard(async () => {
    const cache = caches.find((c) => c.key === btn.dataset.delCache);
    const owners = cache?.owners.join(", ") || "(tanpa owner)";
    if (confirm(`Hapus cache "${cache?.label || btn.dataset.delCache}"? Ini juga menghapus untuk semua pemiliknya: ${owners}.`)) await deleteCaches([btn.dataset.delCache]);
  })));
  on("[data-del-all]", "click", async () => {
    if (confirm(`Hapus semua ${caches.length} cache (${formatSize(totalBytes)})? Semua user harus upload/Load ulang result-nya.`)) await deleteCaches(caches.map((c) => c.key));
  });

  const addProfile = async () => {
    await post("/api/profiles", { name: overlay.querySelector("[data-new]").value });
    await render(true, done);
  };
  on("[data-add]", "click", addProfile);
  onEnter("[data-new]", addProfile);

  const enterAdmin = async () => {
    if (overlay.querySelector("[data-admin]").value.trim().toLowerCase() !== "admin") throw new Error("Hanya 'admin' yang diterima di sini.");
    await post("/api/session", { profile: "admin" });
    await render(true, done);
  };
  on("[data-admin-go]", "click", enterAdmin);
  onEnter("[data-admin]", enterAdmin);

  on("[data-back]", "click", async () => {
    await api("/api/session", { method: "DELETE" });
    await render(false, done);
  });
}

// Resolve dengan nama profile begitu user memilih salah satu.
export function showProfilePicker() {
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-300 overflow-y-auto bg-(--surface) text-(--text)";
    document.body.appendChild(overlay);
  }
  overlay.hidden = false;
  return new Promise((resolve) => { render(false, resolve); });
}

export async function currentProfile() {
  try {
    return (await api("/api/session")).profile;
  } catch {
    return null;
  }
}

export const signOut = () => api("/api/session", { method: "DELETE" });
