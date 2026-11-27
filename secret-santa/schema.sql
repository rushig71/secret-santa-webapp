CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  drawn_id INTEGER
);
CREATE TABLE IF NOT EXISTS exclusions (
  giver INTEGER NOT NULL, receiver INTEGER NOT NULL,
  PRIMARY KEY (giver, receiver)
);
-- One row per answered question. "q" is the question's position in QUESTIONS (src/index.js), starting at 0.
CREATE TABLE IF NOT EXISTS answers (
  member_id INTEGER NOT NULL,
  q INTEGER NOT NULL,
  answer TEXT NOT NULL,
  PRIMARY KEY (member_id, q)
);
