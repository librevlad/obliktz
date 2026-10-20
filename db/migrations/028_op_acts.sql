-- Схема 28: акти списання посуду, серветок і миючих засобів за нормами наказу МОУ №390.
--
-- Акт — документ вибуття; його дані лежать поруч, 1:1 (`act`): вид акта (`kind`, перевіряє
-- програма — новий вид, як-от акти сухпаю, не потребує перебудови таблиці), серія номерів,
-- пункт харчування, період і знімок добових видач (д/д) за період; `off_norm` — кількість
-- акта не за нормою (акт прийшов з книги, складений руками). Папери пакета — номери й дати
-- (`act_paper`), підписанти — знімком, яким акт склали (`act_signer`), норма на д/д, якою
-- рахувалася позиція (`act_item`).
-- Пункт харчування — колонка аркуша «Пункти харчування» Добовки (`food_point`): з якого
-- підрозділу списується майно, як назвати їдальню в накладній і пункт у звірці. Д/д пункту за
-- день — `ration_day`; номер витягу й джерело дня (файл Добовки чи «вручну») — `ration_date`,
-- один на частину. `ext_id` — ідентифікатор, під яким пункт знає сторінка.
-- `nomen.per_ration` («дободач» книги ОП) відтепер — норма на одну добову видачу: кількість
-- одиниці позиції (набір — 1 к-т, серветки паперові — 3 шт, рідкий миючий засіб для ручного
-- миття з одноразовим посудом — 0,0016 кг). До цієї схеми поле зберігалось, редагувалось,
-- вивантажувалось і показувалось (за міграцією 026 — «скільки добових видач покриває одиниця»,
-- величина обернена до нової), у розрахунках не брало участі.
--
-- Тіло — між BEGIN і COMMIT: оновлення, що зірвалося посередині, лишає схему 27.

BEGIN;

CREATE TABLE food_point (
  id             INTEGER PRIMARY KEY,
  ext_id         TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL UNIQUE,
  subdivision_id INTEGER NOT NULL REFERENCES subdivision(id),
  hall           TEXT,
  title          TEXT,
  closed_at      TEXT
) STRICT;

CREATE TABLE ration_day (
  point_id INTEGER NOT NULL REFERENCES food_point(id) ON DELETE CASCADE,
  on_date  TEXT NOT NULL,
  rations  INTEGER NOT NULL CHECK (rations >= 0),
  PRIMARY KEY (point_id, on_date)
) STRICT;

CREATE TABLE ration_date (
  on_date  TEXT PRIMARY KEY,
  order_no TEXT,
  source   TEXT
) STRICT;

CREATE TABLE act (
  document_id INTEGER PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  series      TEXT NOT NULL,
  point_id    INTEGER REFERENCES food_point(id),
  period_from TEXT NOT NULL,
  period_to   TEXT NOT NULL,
  rations     INTEGER NOT NULL DEFAULT 0 CHECK (rations >= 0),
  off_norm    INTEGER NOT NULL DEFAULT 0 CHECK (off_norm IN (0, 1)),
  note        TEXT,
  CHECK (period_from <= period_to)
) STRICT;

CREATE INDEX ix_act_point ON act(point_id, period_to);

CREATE TABLE act_paper (
  document_id INTEGER NOT NULL REFERENCES act(document_id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  number      TEXT,
  doc_date    TEXT,
  PRIMARY KEY (document_id, role)
) STRICT;

CREATE TABLE act_signer (
  document_id INTEGER NOT NULL REFERENCES act(document_id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  position    TEXT,
  rank        TEXT,
  name        TEXT,
  PRIMARY KEY (document_id, role, sort)
) STRICT;

-- norm і nomen.per_ration — REAL: читати як Decimal(str(x)).
CREATE TABLE act_item (
  document_id INTEGER NOT NULL REFERENCES act(document_id) ON DELETE CASCADE,
  nomen_id    INTEGER NOT NULL REFERENCES nomen(id),
  norm        REAL,
  PRIMARY KEY (document_id, nomen_id)
) STRICT;

COMMIT;
