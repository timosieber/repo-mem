-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claude_session_id TEXT UNIQUE NOT NULL,
  user TEXT NOT NULL,
  project TEXT NOT NULL,
  user_prompt TEXT,
  started_at TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL,
  completed_at TEXT,
  completed_at_epoch INTEGER,
  status TEXT CHECK(status IN ('active', 'completed', 'failed')) DEFAULT 'active'
);

-- Observations
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  user TEXT NOT NULL,
  project TEXT NOT NULL,
  text TEXT NOT NULL,
  type TEXT CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
  title TEXT,
  subtitle TEXT,
  facts TEXT,
  narrative TEXT,
  concepts TEXT,
  files_read TEXT,
  files_modified TEXT,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);

-- Session Summaries
CREATE TABLE IF NOT EXISTS session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  user TEXT NOT NULL,
  project TEXT NOT NULL,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  files_read TEXT,
  files_edited TEXT,
  notes TEXT,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);

-- FTS5 Volltextsuche
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, subtitle, narrative, text, facts, concepts,
  content=observations, content_rowid=id
);

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  request, investigated, learned, completed, next_steps, notes,
  content=session_summaries, content_rowid=id
);

-- Triggers fuer FTS Sync
CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
END;

CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON session_summaries BEGIN
  INSERT INTO summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
END;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_obs_user ON observations(user);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_epoch ON observations(created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user);
CREATE INDEX IF NOT EXISTS idx_summaries_user ON session_summaries(user);

-- Learning Loop: Usage tracking
CREATE TABLE IF NOT EXISTS observation_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER NOT NULL,
  observation_user TEXT NOT NULL,
  session_id TEXT,
  user TEXT NOT NULL,
  action TEXT CHECK(action IN ('viewed', 'contributed', 'rated_helpful', 'rated_unhelpful')) DEFAULT 'viewed',
  comment TEXT,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_obs ON observation_usage(observation_id, observation_user);
CREATE INDEX IF NOT EXISTS idx_usage_session ON observation_usage(session_id);

-- Learning Loop Phase 2: Pattern clustering
CREATE TABLE IF NOT EXISTS patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  centroid BLOB,
  member_count INTEGER DEFAULT 0,
  recommended_agent_type TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  merged_into_id INTEGER
);

CREATE TABLE IF NOT EXISTS pattern_members (
  pattern_id INTEGER NOT NULL,
  observation_id INTEGER NOT NULL,
  observation_user TEXT NOT NULL,
  similarity REAL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (pattern_id, observation_id, observation_user)
);

CREATE INDEX IF NOT EXISTS idx_pattern_members_obs ON pattern_members(observation_id, observation_user);
CREATE INDEX IF NOT EXISTS idx_patterns_active ON patterns(id) WHERE merged_into_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_patterns_category ON patterns(category);
