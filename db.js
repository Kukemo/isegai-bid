const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

// Railway writable directory
const DATA_DIR = "/data";

// buat folder jika belum ada
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const dbPath = path.join(DATA_DIR, "guild.db");

console.log("SQLite path:", dbPath);

const db = new Database(dbPath);

// optimasi sqlite
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// =======================
// SCHEMA
// =======================

db.exec(`
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL UNIQUE,
  points_total INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS holds (
  item_id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS finals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL UNIQUE,
  winner_member_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  finalized_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings(key,value)
VALUES ('bid_deadline_utc','');
`);

// seed optional
const seedMember = db.prepare(
  "INSERT OR IGNORE INTO members(nickname, points_total) VALUES(?, ?)"
);

["Lucier"].forEach((n, i) => seedMember.run(n, 160 + i * 20));

module.exports = db;
