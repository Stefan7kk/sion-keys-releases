CREATE TABLE IF NOT EXISTS lyric_references (
  recording TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language <> 'auto'),
  lyrics_digest TEXT NOT NULL CHECK (length(lyrics_digest) = 64),
  text TEXT NOT NULL,
  provenance TEXT NOT NULL,
  PRIMARY KEY (recording, language)
);
