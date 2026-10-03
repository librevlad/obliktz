-- Схема 24: документи служби, складені в програмі.
--
-- Відомість залишкової вартості (Додаток 1 до Методики, постанова КМУ № 759) і
-- акт якісного (технічного) стану — папери, які служба складає сама. Залишків,
-- цін і проведених документів вони не рухають: посилаються на майно з обліку й
-- тримають копію його реквізитів на день складання, тож лежать окремо від
-- `document`. Реквізити, рядки, параметри й результат розрахунку — у `body`
-- (JSON): склад рядка відомості й акта різний, а читає їх лише програма.

CREATE TABLE app_paper (
  id       TEXT PRIMARY KEY,
  kind     TEXT NOT NULL CHECK (kind IN ('valuation', 'tech_act')),
  pos      INTEGER NOT NULL,
  number   TEXT,
  doc_date TEXT,
  state    TEXT NOT NULL CHECK (state IN ('чернетка', 'підготовлено', 'затверджено', 'скасовано')),
  version  INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created  TEXT,
  changed  TEXT,
  body     TEXT NOT NULL
) STRICT;

CREATE INDEX ix_app_paper_kind ON app_paper(kind, pos);

-- Затверджена версія документа — знімок, яким його затвердили. Виправлення
-- затвердженого документа — наступна версія з причиною; попередні лишаються.
CREATE TABLE app_paper_version (
  paper_id TEXT NOT NULL REFERENCES app_paper(id) ON DELETE CASCADE,
  version  INTEGER NOT NULL CHECK (version >= 1),
  saved_at TEXT NOT NULL,
  reason   TEXT,
  body     TEXT NOT NULL,
  PRIMARY KEY (paper_id, version)
) STRICT;

-- Незмінність — на рівні бази: затверджену версію не переписати ні програмою,
-- ні стороннім редактором.
CREATE TRIGGER trg_app_paper_version_frozen BEFORE UPDATE ON app_paper_version
BEGIN
  SELECT RAISE(ABORT, 'Затверджену версію документа змінити не можна');
END;
