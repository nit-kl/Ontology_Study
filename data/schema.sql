-- 空調の測定と、朝の指令に使う状況データ。
-- 機器・ゾーン・ポイントの意味と、指令のしきい値は ontology/cp-retail.ttl にある。
-- 結合は次の文字列一致。
--   store_code = cpr:storeCode
--   point_code = brick:hasTimeseriesId
--   equipment_code = cpr:equipmentCode

PRAGMA foreign_keys = ON;

CREATE TABLE demo_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE point_reading (
  id          INTEGER PRIMARY KEY,
  store_code  TEXT NOT NULL,
  point_code  TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  value_num   REAL NOT NULL,
  UNIQUE (store_code, point_code, recorded_at)
);

CREATE INDEX idx_point_latest
  ON point_reading (store_code, point_code, recorded_at);

CREATE TABLE footfall (
  id            INTEGER PRIMARY KEY,
  store_code    TEXT NOT NULL,
  recorded_at   TEXT NOT NULL,
  people_count  INTEGER NOT NULL,
  UNIQUE (store_code, recorded_at)
);

CREATE TABLE door_interval (
  id           INTEGER PRIMARY KEY,
  store_code   TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  open_ratio   REAL NOT NULL,
  UNIQUE (store_code, recorded_at)
);

CREATE TABLE weather_forecast (
  id              INTEGER PRIMARY KEY,
  store_code      TEXT NOT NULL,
  issued_at       TEXT NOT NULL,
  target_at       TEXT NOT NULL,
  outside_temp_c  REAL NOT NULL,
  UNIQUE (store_code, issued_at, target_at)
);

CREATE TABLE equipment_mode (
  id              INTEGER PRIMARY KEY,
  store_code      TEXT NOT NULL,
  equipment_code  TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  mode_code       TEXT NOT NULL,
  UNIQUE (store_code, equipment_code, recorded_at)
);
