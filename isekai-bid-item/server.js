// ========================= GUILD BID SYSTEM (FULL MERGED + CSV ADMIN MENU) =========================
// ✅ Deadline pakai 1 input date picker (datetime-local) seperti gambar
// ✅ Semua logika waktu "FLAT UTC+7/WIB" (bukan local timezone)
// ✅ Disimpan ke server sebagai ISO UTC berakhiran "Z" (stabil & sama seperti skrip lama)
// ✅ Dashboard sections bisa minimize: Member Points / Items - Highest Bid / Final Results
// ✅ (ADDED BACK) Admin menu Import/Export CSV (Google Sheet CSV + Export snapshot)
// ==================================================================================================

const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");
const db = require("./db");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; // ganti via ENV

// ===================== (ADDED) Default CSV URLs =====================
const DEFAULT_MEMBERS_CSV_URL =
  process.env.MEMBERS_CSV_URL ||
  "https://docs.google.com/spreadsheets/d/17EytQeecsHLA7XfwVZyNsyN7k1S9lmkWxDVyS3lGOO8/export?format=csv&gid=0";

const DEFAULT_ITEMS_CSV_URL =
  process.env.ITEMS_CSV_URL ||
  "https://docs.google.com/spreadsheets/d/17EytQeecsHLA7XfwVZyNsyN7k1S9lmkWxDVyS3lGOO8/export?format=csv&gid=1041003630";

// (optional) fallback fetch untuk Node < 18 (tidak mengganggu kalau Node 18+)
let _fetch = global.fetch;
if (!_fetch) {
  try {
    _fetch = require("node-fetch");
  } catch (e) {
    _fetch = null;
  }
}

// ====================== Session helpers ======================
function createSession(member_id, hours = 72) {
  const token = crypto.randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO sessions(token, member_id, expires_at) VALUES(?, ?, ?)").run(
    token,
    member_id,
    expires
  );
  return token;
}

function getSession(req) {
  const token = req.cookies?.sid;
  if (!token) return null;
  return (
    db
      .prepare("SELECT * FROM sessions WHERE token=? AND expires_at > datetime('now')")
      .get(token) || null
  );
}

function requireLogin(req, res, next) {
  const s = getSession(req);
  if (!s) return res.redirect("/login");
  req.session = s;
  next();
}

function requireLoginApi(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "Belum login." });
  req.session = s;
  next();
}

// ====================== Admin auth ======================
function isAdmin(req) {
  return req.cookies?.admin === "1";
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: "Admin only." });
  next();
}

// ====================== Points helpers ======================
function getHeldByMember(memberId) {
  return db
    .prepare("SELECT COALESCE(SUM(amount),0) AS held FROM holds WHERE member_id=?")
    .get(memberId).held;
}
function getAvailablePoints(memberId) {
  const total = db.prepare("SELECT points_total FROM members WHERE id=?").get(memberId)
    .points_total;
  return total - getHeldByMember(memberId);
}
function getCurrentHold(itemId) {
  return db.prepare("SELECT * FROM holds WHERE item_id=?").get(itemId);
}

// ====================== Settings helpers (robust) ======================
function getSetting(key) {
  return db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value || "";
}
function setSetting(key, value) {
  const exist = db.prepare("SELECT 1 FROM settings WHERE key=?").get(key);
  if (exist) db.prepare("UPDATE settings SET value=? WHERE key=?").run(value, key);
  else db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(key, value);
}

// init default key
(function bootstrap() {
  // (ADDED) init import urls
  if (!getSetting("members_csv_url")) setSetting("members_csv_url", DEFAULT_MEMBERS_CSV_URL);
  if (!getSetting("items_csv_url")) setSetting("items_csv_url", DEFAULT_ITEMS_CSV_URL);

  if (db.prepare("SELECT 1 FROM settings WHERE key='bid_deadline_utc'").get() == null) {
    setSetting("bid_deadline_utc", "");
  }
})();

// ====================== Deadline helpers ======================
function getDeadlineUtc() {
  return getSetting("bid_deadline_utc") || "";
}
function getDeadlineIsoOrNull() {
  const v = getDeadlineUtc();
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}
function isBidClosedByDeadline() {
  const v = getDeadlineUtc();
  if (!v) return false;

  let t = Date.parse(v);

  // fallback ISO tanpa timezone -> paksa Z
  if (Number.isNaN(t)) {
    const looksIsoNoTz =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) &&
      !(/[zZ]|[+\-]\d{2}:\d{2}$/.test(v));
    if (looksIsoNoTz) t = Date.parse(v + "Z");
  }

  if (Number.isNaN(t)) return false;
  return Date.now() >= t;
}

// ====================== Auto finalize after deadline ======================
function autoFinalizeAllIfDeadlinePassed() {
  if (!isBidClosedByDeadline()) return { ran: false, finalized: 0 };

  const deadlineIso = getDeadlineIsoOrNull() || new Date().toISOString();

  const rows = db.prepare(`
    SELECT i.id AS item_id, i.name AS item_name,
           h.member_id AS winner_member_id, h.amount AS amount
    FROM items i
    JOIN holds h ON h.item_id = i.id
    LEFT JOIN finals f ON f.item_id = i.id
    WHERE i.status = 'OPEN' AND f.item_id IS NULL
    ORDER BY i.created_at DESC
  `).all();

  const tx = db.transaction(() => {
    for (const r of rows) {
      db.prepare(`UPDATE items SET status='CLOSED' WHERE id=?`).run(r.item_id);
      db.prepare(`UPDATE members SET points_total = points_total - ? WHERE id=?`).run(
        r.amount,
        r.winner_member_id
      );
      db.prepare(`
        INSERT INTO finals(item_id, winner_member_id, amount, finalized_at)
        VALUES(?, ?, ?, ?)
      `).run(r.item_id, r.winner_member_id, r.amount, deadlineIso);
      db.prepare(`DELETE FROM holds WHERE item_id=?`).run(r.item_id);
    }

    // tutup semua item OPEN yang tersisa (yang tidak punya hold)
    db.prepare(`UPDATE items SET status='CLOSED' WHERE status='OPEN'`).run();
  });

  tx();
  return { ran: true, finalized: rows.length };
}

// ====================== (ADDED) CSV helpers ======================
async function fetchText(url) {
  const f = _fetch || global.fetch;
  if (!f) throw new Error("fetch tidak tersedia. Pakai Node 18+ atau install node-fetch.");
  const r = await f(url, { redirect: "follow" });
  if (!r.ok) throw new Error("Fetch gagal (" + r.status + ")");
  return await r.text();
}

// CSV parser sederhana (quoted)
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === ",") {
      row.push(cur.trim());
      cur = "";
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cur.trim());
      cur = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
      continue;
    }
    cur += ch;
  }
  if (cur.length || row.length) {
    row.push(cur.trim());
    if (row.some((v) => v !== "")) rows.push(row);
  }
  return rows;
}

function toHeaderMap(headerRow) {
  const map = {};
  headerRow.forEach((h, idx) => {
    const key = String(h || "").toLowerCase().trim();
    if (key) map[key] = idx;
  });
  return map;
}

function pick(row, map, keys) {
  for (const k of keys) {
    const idx = map[k];
    if (idx != null) return String(row[idx] ?? "").trim();
  }
  return "";
}

function pickByIndex(row, idx, fallback = "") {
  if (!row || idx < 0) return fallback;
  const v = row[idx];
  return String(v ?? fallback).trim();
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ====================== API base ======================
app.get("/api/members", (req, res) => {
  res.json(db.prepare("SELECT id, nickname, points_total FROM members ORDER BY nickname").all());
});

app.get("/api/items", (req, res) => {
  res.json(db.prepare("SELECT id, name, status FROM items ORDER BY created_at DESC").all());
});

app.get("/api/me", (req, res) => {
  const s = getSession(req);
  if (!s) return res.json({ logged_in: false });

  try {
    autoFinalizeAllIfDeadlinePassed();
  } catch (e) { }

  const m = db.prepare("SELECT id, nickname, points_total FROM members WHERE id=?").get(s.member_id);
  if (!m) return res.json({ logged_in: false });

  const held = getHeldByMember(m.id);
  res.json({
    logged_in: true,
    is_admin: isAdmin(req),
    bid_closed: isBidClosedByDeadline(),
    bid_deadline_utc: getDeadlineUtc() || "",
    member: {
      id: m.id,
      nickname: m.nickname,
      points_total: m.points_total,
      held_points: held,
      available_points: m.points_total - held,
    },
  });
});

// ====================== Login / Logout ======================
app.post("/api/login", (req, res) => {
  const { nickname } = req.body;
  if (!nickname) return res.status(400).json({ error: "Nickname wajib." });

  const member = db.prepare("SELECT * FROM members WHERE nickname=?").get(nickname);
  if (!member) return res.status(404).json({ error: "Member tidak ditemukan." });

  const token = createSession(member.id, 72);
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax" });
  res.clearCookie("admin");
  res.json({ ok: true });
});

app.post("/api/admin/login", requireLoginApi, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password admin wajib." });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Password admin salah." });

  res.cookie("admin", "1", { httpOnly: true, sameSite: "lax" });
  res.json({ ok: true, message: "Admin mode aktif." });
});

app.post("/api/admin/logout", requireLoginApi, (req, res) => {
  res.clearCookie("admin");
  res.json({ ok: true, message: "Admin mode nonaktif." });
});

app.post("/api/logout", (req, res) => {
  const token = req.cookies?.sid;
  if (token) db.prepare("DELETE FROM sessions WHERE token=?").run(token);
  res.clearCookie("sid");
  res.clearCookie("admin");
  res.json({ ok: true });
});

// ====================== Dashboard ======================
app.get("/api/dashboard", requireLoginApi, (req, res) => {
  try {
    autoFinalizeAllIfDeadlinePassed();
  } catch (e) { }

  const members = db.prepare(`
    SELECT m.id, m.nickname, m.points_total,
      COALESCE((SELECT SUM(h.amount) FROM holds h WHERE h.member_id = m.id), 0) AS held_points
    FROM members m
    ORDER BY m.nickname
  `).all();

  const items = db.prepare(`
    SELECT i.id, i.name, i.status,
      h.amount AS highest_amount,
      mm.nickname AS highest_nickname,
      (SELECT MAX(b.created_at) FROM bids b WHERE b.item_id = i.id) AS highest_time
    FROM items i
    LEFT JOIN holds h ON h.item_id = i.id
    LEFT JOIN members mm ON mm.id = h.member_id
    ORDER BY i.created_at DESC
  `).all();

  const finals = db.prepare(`
    SELECT i.name AS item_name, m.nickname AS winner, f.amount, f.finalized_at
    FROM finals f
    JOIN items i ON i.id = f.item_id
    JOIN members m ON m.id = f.winner_member_id
    ORDER BY f.finalized_at DESC
  `).all();

  res.json({
    bid_closed: isBidClosedByDeadline(),
    bid_deadline_utc: getDeadlineUtc() || "",
    members: members.map((x) => ({ ...x, available_points: x.points_total - x.held_points })),
    items,
    finals,
  });
});

// ====================== Bid ======================
app.post("/api/bid", requireLoginApi, (req, res) => {
  try {
    autoFinalizeAllIfDeadlinePassed();
  } catch (e) { }

  if (isBidClosedByDeadline()) {
    return res.status(403).json({ error: "Bid sudah ditutup karena melewati deadline." });
  }

  const { itemName, amount } = req.body;
  if (!itemName || !Number.isInteger(amount))
    return res.status(400).json({ error: "itemName dan amount (integer) wajib." });
  if (amount < 1) return res.status(400).json({ error: "Bid minimal 1." });

  const member = db.prepare("SELECT * FROM members WHERE id=?").get(req.session.member_id);
  const item = db.prepare("SELECT * FROM items WHERE name=?").get(itemName);

  if (!member) return res.status(404).json({ error: "Member tidak ditemukan." });
  if (!item) return res.status(404).json({ error: "Item tidak ditemukan." });
  if (item.status !== "OPEN") return res.status(400).json({ error: "Lelang item sudah ditutup." });

  const finalized = db.prepare("SELECT 1 FROM finals WHERE item_id=?").get(item.id);
  if (finalized) return res.status(400).json({ error: "Item sudah finalized." });

  const currentHold = getCurrentHold(item.id);
  const currentHighest = currentHold ? currentHold.amount : 0;
  if (amount <= currentHighest)
    return res.status(400).json({ error: "Bid harus lebih tinggi dari " + currentHighest + "." });

  const available = getAvailablePoints(member.id);
  if (amount > available)
    return res.status(400).json({ error: "Poin tidak cukup. Available kamu: " + available + "." });

  const tx = db.transaction(() => {
    db.prepare("INSERT INTO bids(item_id, member_id, amount) VALUES(?, ?, ?)").run(
      item.id,
      member.id,
      amount
    );
    if (currentHold) db.prepare("DELETE FROM holds WHERE item_id=?").run(item.id);
    db.prepare("INSERT INTO holds(item_id, member_id, amount) VALUES(?, ?, ?)").run(
      item.id,
      member.id,
      amount
    );
  });

  try {
    tx();
  } catch (e) {
    return res.status(500).json({ error: "Gagal proses bid.", detail: String(e.message || e) });
  }

  res.json({ ok: true, message: "Bid diterima. Kamu jadi pemenang sementara." });
});

// ====================== ADMIN: deadline set/clear ======================
// ⚠️ Referensi dari skrip lama: server hanya mau ISO yang valid.
// Kita simpan normalisasi toISOString() (pasti berakhiran Z).
app.post("/api/admin/set-deadline", requireLoginApi, requireAdmin, (req, res) => {
  const { deadline_utc } = req.body;
  if (typeof deadline_utc !== "string")
    return res.status(400).json({ error: "deadline_utc wajib string ISO." });

  const v = deadline_utc.trim();

  if (v !== "") {
    const t = Date.parse(v);
    if (Number.isNaN(t)) return res.status(400).json({ error: "deadline_utc tidak valid (ISO)." });

    const normalized = new Date(t).toISOString(); // ✅ pasti ...Z
    setSetting("bid_deadline_utc", normalized);
    return res.json({ ok: true, message: "Deadline disimpan." });
  }

  setSetting("bid_deadline_utc", "");
  res.json({ ok: true, message: "Deadline dikosongkan." });
});

// ====================== ADMIN: add / delete member & item ======================
app.post("/api/admin/add-member", requireLoginApi, requireAdmin, (req, res) => {
  const { nickname, points_total = 0 } = req.body;
  if (!nickname || typeof nickname !== "string")
    return res.status(400).json({ error: "nickname wajib (string)." });

  const clean = nickname.trim();
  if (clean.length < 2) return res.status(400).json({ error: "nickname terlalu pendek." });
  if (!Number.isInteger(points_total) || points_total < 0)
    return res.status(400).json({ error: "points_total harus integer >= 0." });

  try {
    db.prepare("INSERT INTO members(nickname, points_total) VALUES(?, ?)").run(clean, points_total);
  } catch (e) {
    return res.status(400).json({
      error: "Gagal menambah member (mungkin nickname sudah ada).",
      detail: String(e.message || e),
    });
  }
  res.json({ ok: true, message: "Member " + clean + " ditambahkan." });
});

app.post("/api/admin/delete-member", requireLoginApi, requireAdmin, (req, res) => {
  const { nickname } = req.body;
  if (!nickname) return res.status(400).json({ error: "nickname wajib." });

  const m = db.prepare("SELECT * FROM members WHERE nickname=?").get(nickname);
  if (!m) return res.status(404).json({ error: "Member tidak ditemukan." });

  const hasHold = db.prepare("SELECT 1 FROM holds WHERE member_id=?").get(m.id);
  const hasBid = db.prepare("SELECT 1 FROM bids WHERE member_id=?").get(m.id);
  const hasFinal = db.prepare("SELECT 1 FROM finals WHERE winner_member_id=?").get(m.id);

  if (hasHold || hasBid || hasFinal) {
    return res.status(400).json({ error: "Tidak bisa hapus member: sudah punya bid/hold/final." });
  }

  db.prepare("DELETE FROM members WHERE id=?").run(m.id);
  res.json({ ok: true, message: "Member " + nickname + " dihapus." });
});

app.post("/api/admin/set-points", requireLoginApi, requireAdmin, (req, res) => {
  const { nickname, points_total } = req.body;
  if (!nickname || !Number.isInteger(points_total) || points_total < 0) {
    return res.status(400).json({ error: "nickname dan points_total (integer >= 0) wajib." });
  }

  const m = db.prepare("SELECT * FROM members WHERE nickname=?").get(nickname);
  if (!m) return res.status(404).json({ error: "Member tidak ditemukan." });

  const held = getHeldByMember(m.id);
  if (points_total < held)
    return res.status(400).json({ error: "Tidak bisa set poin < held (" + held + ")." });

  db.prepare("UPDATE members SET points_total=? WHERE id=?").run(points_total, m.id);
  res.json({ ok: true, message: "Poin " + nickname + " di-set menjadi " + points_total + "." });
});

app.post("/api/admin/add-item", requireLoginApi, requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== "string") return res.status(400).json({ error: "name wajib (string)." });

  const clean = name.trim();
  if (clean.length < 2) return res.status(400).json({ error: "nama item terlalu pendek." });

  try {
    db.prepare("INSERT INTO items(name, status) VALUES(?, 'OPEN')").run(clean);
  } catch (e) {
    return res.status(400).json({
      error: "Gagal menambah item (mungkin item sudah ada).",
      detail: String(e.message || e),
    });
  }
  res.json({ ok: true, message: "Item " + clean + " ditambahkan (OPEN)." });
});

app.post("/api/admin/delete-item", requireLoginApi, requireAdmin, (req, res) => {
  const { itemName } = req.body;
  if (!itemName) return res.status(400).json({ error: "itemName wajib." });

  const item = db.prepare("SELECT * FROM items WHERE name=?").get(itemName);
  if (!item) return res.status(404).json({ error: "Item tidak ditemukan." });

  const hasHold = db.prepare("SELECT 1 FROM holds WHERE item_id=?").get(item.id);
  const hasBid = db.prepare("SELECT 1 FROM bids WHERE item_id=?").get(item.id);
  const hasFinal = db.prepare("SELECT 1 FROM finals WHERE item_id=?").get(item.id);

  if (hasHold || hasBid || hasFinal) {
    return res.status(400).json({ error: "Tidak bisa hapus item: sudah punya bid/hold/final." });
  }

  db.prepare("DELETE FROM items WHERE id=?").run(item.id);
  res.json({ ok: true, message: "Item " + itemName + " dihapus." });
});

app.post("/api/admin/delete-all-items", requireLoginApi, requireAdmin, (req, res) => {
  const confirm = req.query?.confirm;
  if (confirm !== "YES") {
    return res.status(400).json({ error: "Tambahkan ?confirm=YES untuk menghapus SEMUA items/bids/holds/finals." });
  }

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM holds").run();
    db.prepare("DELETE FROM bids").run();
    db.prepare("DELETE FROM finals").run();
    db.prepare("DELETE FROM items").run();
  });

  try { tx(); }
  catch (e) { return res.status(500).json({ error: "Gagal delete all items.", detail: String(e.message || e) }); }

  res.json({ ok: true, message: "Semua items + bids + holds + finals sudah dihapus." });
});

app.post("/api/admin/finalize", requireLoginApi, requireAdmin, (req, res) => {
  const { itemName } = req.body;
  if (!itemName) return res.status(400).json({ error: "itemName wajib." });

  if (isBidClosedByDeadline()) {
    return res.status(400).json({ error: "Deadline sudah lewat. Finalize berjalan otomatis." });
  }

  const item = db.prepare("SELECT * FROM items WHERE name=?").get(itemName);
  if (!item) return res.status(404).json({ error: "Item tidak ditemukan." });

  const already = db.prepare("SELECT 1 FROM finals WHERE item_id=?").get(item.id);
  if (already) return res.status(400).json({ error: "Item sudah finalized." });

  const hold = db.prepare("SELECT * FROM holds WHERE item_id=?").get(item.id);
  if (!hold) return res.status(400).json({ error: "Belum ada pemenang sementara untuk item ini." });

  const deadlineIso = getDeadlineIsoOrNull() || new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare("UPDATE items SET status='CLOSED' WHERE id=?").run(item.id);
    db.prepare("UPDATE members SET points_total = points_total - ? WHERE id=?").run(
      hold.amount,
      hold.member_id
    );
    db.prepare(`
      INSERT INTO finals(item_id, winner_member_id, amount, finalized_at)
      VALUES(?, ?, ?, ?)
    `).run(item.id, hold.member_id, hold.amount, deadlineIso);
    db.prepare("DELETE FROM holds WHERE item_id=?").run(item.id);
  });

  try { tx(); }
  catch (e) { return res.status(500).json({ error: "Gagal finalize.", detail: String(e.message || e) }); }

  res.json({ ok: true, message: "Finalize berhasil. Hasil tersimpan di tabel finals." });
});

app.get("/api/admin/bids", requireLoginApi, requireAdmin, (req, res) => {
  const { itemName, limit = 50 } = req.query;
  if (!itemName) return res.status(400).json({ error: "itemName wajib." });

  const item = db.prepare("SELECT * FROM items WHERE name=?").get(itemName);
  if (!item) return res.status(404).json({ error: "Item tidak ditemukan." });

  const rows = db
    .prepare(
      `
    SELECT b.created_at, m.nickname, b.amount
    FROM bids b
    JOIN members m ON m.id = b.member_id
    WHERE b.item_id = ?
    ORDER BY b.created_at DESC
    LIMIT ?
  `
    )
    .all(item.id, Math.min(parseInt(limit, 10) || 50, 200));

  res.json({ ok: true, item: item.name, bids: rows });
});

// ===================== (ADDED BACK) ADMIN: Import URLs + Import 1 klik =====================
app.get("/api/admin/import-urls", requireLoginApi, requireAdmin, (req, res) => {
  res.json({
    members_csv_url: getSetting("members_csv_url") || DEFAULT_MEMBERS_CSV_URL,
    items_csv_url: getSetting("items_csv_url") || DEFAULT_ITEMS_CSV_URL,
  });
});

app.post("/api/admin/set-import-urls", requireLoginApi, requireAdmin, (req, res) => {
  const { members_csv_url, items_csv_url } = req.body;
  if (typeof members_csv_url !== "string" || typeof items_csv_url !== "string") {
    return res.status(400).json({ error: "members_csv_url dan items_csv_url wajib string." });
  }
  setSetting("members_csv_url", members_csv_url.trim());
  setSetting("items_csv_url", items_csv_url.trim());
  res.json({ ok: true, message: "Import URLs tersimpan." });
});

// Import members robust + tidak menghapus data lama kalau parse=0
app.post("/api/admin/import-members", requireLoginApi, requireAdmin, async (req, res) => {
  const url = getSetting("members_csv_url") || DEFAULT_MEMBERS_CSV_URL;
  if (!url) return res.status(400).json({ error: "URL members CSV belum diset." });

  try {
    const csv = await fetchText(url);
    const rows = parseCsv(csv);
    if (rows.length < 2) return res.status(400).json({ error: "CSV members kosong / format salah." });

    const header = toHeaderMap(rows[0]);

    const parsed = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];

      let nickname = pick(r, header, ["nickname", "nick", "name", "member", "nama"]);
      let ptsStr = pick(r, header, ["total point", "total_point", "points_total", "point", "points", "poin"]);

      if (!nickname) nickname = pickByIndex(r, 0, "");
      if (!ptsStr) ptsStr = pickByIndex(r, 1, "0");

      const low = (nickname || "").toLowerCase();
      if (!nickname) continue;
      if (low.includes("nickname") || low.includes("nick") || low.includes("member") || low.includes("nama")) continue;

      const pts = Math.max(0, parseInt(String(ptsStr).replace(/[^\d-]/g, ""), 10) || 0);
      parsed.push({ nickname: nickname.trim(), points_total: pts });
    }

    if (parsed.length === 0) {
      return res.status(400).json({
        error: "Import members gagal: tidak ada baris nickname yang terbaca. Cek header/kolom di sheet members.",
      });
    }

    const tx = db.transaction(() => {
      // reset bidding agar aman
      db.prepare("DELETE FROM holds").run();
      db.prepare("DELETE FROM bids").run();
      db.prepare("DELETE FROM finals").run();

      db.prepare("DELETE FROM members").run();

      const ins = db.prepare("INSERT INTO members(nickname, points_total) VALUES(?, ?)");
      for (const x of parsed) ins.run(x.nickname, x.points_total);
    });

    tx();
    res.json({ ok: true, message: "Import members berhasil (" + parsed.length + " rows) + reset bidding." });
  } catch (e) {
    res.status(500).json({ error: "Import members gagal.", detail: String(e.message || e) });
  }
});

app.post("/api/admin/import-items", requireLoginApi, requireAdmin, async (req, res) => {
  const url = getSetting("items_csv_url") || DEFAULT_ITEMS_CSV_URL;
  if (!url) return res.status(400).json({ error: "URL items CSV belum diset." });

  try {
    const csv = await fetchText(url);
    const rows = parseCsv(csv);
    if (rows.length < 2) return res.status(400).json({ error: "CSV items kosong / format salah." });

    const header = toHeaderMap(rows[0]);

    const parsed = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      let name = pick(r, header, ["list item for bid", "item", "name", "nama", "items"]);
      if (!name) name = pickByIndex(r, 0, "");
      if (!name) continue;
      parsed.push(name.trim());
    }

    if (parsed.length === 0) return res.status(400).json({ error: "Import items gagal: tidak ada item yang terbaca." });

    const tx = db.transaction(() => {
      db.prepare("DELETE FROM holds").run();
      db.prepare("DELETE FROM bids").run();
      db.prepare("DELETE FROM finals").run();

      db.prepare("DELETE FROM items").run();

      const ins = db.prepare("INSERT INTO items(name, status) VALUES(?, 'OPEN')");
      for (const n of parsed) ins.run(n);
    });

    tx();
    res.json({ ok: true, message: "Import items berhasil (" + parsed.length + " rows) + reset bidding." });
  } catch (e) {
    res.status(500).json({ error: "Import items gagal.", detail: String(e.message || e) });
  }
});

// ===================== (ADDED BACK) ADMIN: Export CSV =====================
app.get("/api/admin/export-bids.csv", requireLoginApi, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT i.name AS item, m.nickname AS nickname, b.amount AS bid, b.created_at AS time_utc
    FROM bids b
    JOIN items i ON i.id = b.item_id
    JOIN members m ON m.id = b.member_id
    ORDER BY b.created_at ASC
  `).all();

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="bid_log.csv"');
  res.write("Item,Nickname,Bid,Time(UTC)\n");
  for (const r of rows) {
    res.write([r.item, r.nickname, r.bid, r.time_utc].map(csvEscape).join(",") + "\n");
  }
  res.end();
});

app.get("/api/admin/export-finals.csv", requireLoginApi, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT i.name AS item, m.nickname AS winner, f.amount AS bid
    FROM finals f
    JOIN items i ON i.id = f.item_id
    JOIN members m ON m.id = f.winner_member_id
    ORDER BY f.finalized_at ASC
  `).all();

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="final_results.csv"');
  res.write("Item,Winner,Bid,SettleTime(UTC)\n");
  for (const r of rows) {
    res.write([r.item, r.winner, r.bid, r.time_utc].map(csvEscape).join(",") + "\n");
  }
  res.end();
});

app.get("/api/admin/export-members.csv", requireLoginApi, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT m.nickname, m.points_total,
      COALESCE((SELECT SUM(h.amount) FROM holds h WHERE h.member_id=m.id),0) AS held_points
    FROM members m
    ORDER BY m.nickname ASC
  `).all();

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="members_snapshot.csv"');
  res.write("Nickname,TotalPoint,HeldPoint,Available\n");
  for (const r of rows) {
    const avail = (r.points_total || 0) - (r.held_points || 0);
    res.write([r.nickname, r.points_total, r.held_points, avail].map(csvEscape).join(",") + "\n");
  }
  res.end();
});

// ====================== Pages (served from public/) ======================
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ====================== (REMOVED) Old inline HTML was here ======================
// HTML, CSS, and JS now live in public/ folder:
//   public/index.html   – main dashboard page
//   public/login.html   – login page
//   public/style.css    – shared stylesheet
//   public/app.js       – shared frontend JavaScript
// ================================================================================

// ====================== Start server ======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port", PORT));
