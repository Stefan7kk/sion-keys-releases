CREATE TABLE IF NOT EXISTS contributions (
  video TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('analysis', 'lyrics')),
  revision TEXT NOT NULL,
  digest TEXT NOT NULL,
  body TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (video, kind, revision, digest)
);
CREATE INDEX IF NOT EXISTS public_library ON contributions (video, kind, revision, created_at DESC) WHERE published = 1;
CREATE INDEX IF NOT EXISTS pending_library ON contributions (created_at) WHERE published = 0;
