-- Схема 27: закупівлі цілком — кошти року, справи закупівель і документи до них.
--
-- Рядок коштів — те, що виділили (фонд, КПКВ, КЕКВ і код видатків; для субвенції — громада,
-- угода, рішення й строки); рух рядка — затверджено, зміни, профінансовано, повернуто.
-- Закупівля бере гроші з рядків коштів, має версії пакета (подану версію не правлять —
-- перевіряє сервер) з позиціями й пропозиціями цін. Документи закупівлі — договори, ВН,
-- рахунки, довіреності, оплати й акти введення в експлуатацію з рядками, частками між
-- рядками коштів і зв'язком з актами приймання обліку. Ідентифікатори записів дає сторінка
-- (текст); гроші — цілі копійки, кількість — тисячні. Файл може лежати в теці з
-- налаштувань: у нього ключ теки й відбиток вмісту, за яким його знаходять після
-- перекладки тек.
--
-- Тіло — між BEGIN і COMMIT: якщо оновлення зірветься посередині, база лишиться зі схемою 26,
-- а не з половиною таблиць.

BEGIN;

CREATE TABLE fund_line (
  id            TEXT PRIMARY KEY,
  pos           INTEGER NOT NULL,
  year          INTEGER NOT NULL CHECK (year BETWEEN 1950 AND 2100),
  label         TEXT NOT NULL,
  fund          TEXT NOT NULL,
  kpkv          TEXT,
  kekv          TEXT,
  exp_code      TEXT,
  community     TEXT,
  purpose       TEXT,
  agree_no      TEXT,
  agree_date    TEXT,
  decision_no   TEXT,
  decision_date TEXT,
  return_by     TEXT,
  report_by     TEXT,
  missing       TEXT,
  note          TEXT,
  UNIQUE (year, label)
) STRICT;

CREATE TABLE fund_move (
  id         TEXT PRIMARY KEY,
  line_id    TEXT NOT NULL REFERENCES fund_line(id) ON DELETE CASCADE,
  pos        INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('затверджено', 'зміна', 'профінансовано', 'повернуто')),
  move_date  TEXT,
  amount_kop INTEGER NOT NULL,
  basis      TEXT,
  note       TEXT
) STRICT;
CREATE INDEX ix_fund_move_line ON fund_move(line_id);

CREATE TABLE purchase (
  id        TEXT PRIMARY KEY,
  pos       INTEGER NOT NULL,
  year      INTEGER NOT NULL CHECK (year BETWEEN 1950 AND 2100),
  title     TEXT NOT NULL,
  what      TEXT,
  person_id INTEGER REFERENCES person(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES purchase(id) ON DELETE SET NULL,
  source_id TEXT REFERENCES purchase(id) ON DELETE SET NULL,
  closed    TEXT NOT NULL DEFAULT '' CHECK (closed IN ('', 'завершено', 'скасовано')),
  folder    TEXT,
  missing   TEXT,
  note      TEXT,
  UNIQUE (year, title)
) STRICT;

CREATE TABLE purchase_fund (
  purchase_id TEXT NOT NULL REFERENCES purchase(id) ON DELETE CASCADE,
  line_id     TEXT NOT NULL REFERENCES fund_line(id),
  amount_kop  INTEGER NOT NULL CHECK (amount_kop >= 0),
  PRIMARY KEY (purchase_id, line_id)
) STRICT;

CREATE TABLE purchase_version (
  id          TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchase(id) ON DELETE CASCADE,
  pos         INTEGER NOT NULL,
  label       TEXT NOT NULL,
  reason      TEXT,
  signed_on   TEXT,
  sent_no     TEXT,
  sent_on     TEXT,
  answer      TEXT NOT NULL DEFAULT '' CHECK (answer IN ('', 'погоджено', 'не погоджено')),
  answer_no   TEXT,
  answer_on   TEXT,
  answer_note TEXT,
  handed_on   TEXT,
  signers     TEXT,
  missing     TEXT,
  UNIQUE (purchase_id, label)
) STRICT;

CREATE TABLE purchase_position (
  id         TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES purchase_version(id) ON DELETE CASCADE,
  pos        INTEGER NOT NULL,
  name       TEXT NOT NULL,
  specs      TEXT,
  uom        TEXT,
  qty_milli  INTEGER NOT NULL CHECK (qty_milli >= 0),
  price_rule TEXT NOT NULL CHECK (price_rule IN ('середня', 'КП', 'вручну')),
  price_kop  INTEGER NOT NULL CHECK (price_kop >= 0),
  kekv       TEXT,
  exp_code   TEXT,
  dk_code    TEXT,
  line_id    TEXT REFERENCES fund_line(id),
  nomen_code TEXT,
  note       TEXT
) STRICT;
CREATE INDEX ix_purchase_position_version ON purchase_position(version_id);

CREATE TABLE purchase_offer (
  id          TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES purchase_position(id) ON DELETE CASCADE,
  pos         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('посилання', 'КП')),
  seller      TEXT,
  url         TEXT,
  price_kop   INTEGER CHECK (price_kop IS NULL OR price_kop >= 0),
  checked_on  TEXT,
  offer_no    TEXT,
  offer_date  TEXT,
  note        TEXT
) STRICT;
CREATE INDEX ix_purchase_offer_position ON purchase_offer(position_id);

CREATE TABLE pur_doc (
  id              TEXT PRIMARY KEY,
  pos             INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('договір', 'ВН', 'рахунок', 'довіреність', 'оплата',
                                                'акт введення', 'інше')),
  number          TEXT,
  doc_date        TEXT,
  purchase_id     TEXT REFERENCES purchase(id) ON DELETE SET NULL,
  parent_id       TEXT REFERENCES pur_doc(id) ON DELETE SET NULL,
  counterparty_id INTEGER REFERENCES counterparty(id),
  person_id       INTEGER REFERENCES person(id) ON DELETE SET NULL,
  amount_kop      INTEGER,
  vat_kop         INTEGER,
  deliver_by      TEXT,
  valid_to        TEXT,
  used_on         TEXT,
  returned_on     TEXT,
  pay_on          TEXT,
  procedure_no    TEXT,
  state           TEXT NOT NULL DEFAULT '' CHECK (state IN ('', 'чернетка', 'підготовлено', 'затверджено')),
  fes_status      TEXT NOT NULL DEFAULT '' CHECK (fes_status IN ('', 'немає витяга', 'на підписі', 'їде на ФЕС',
                                                                 'проведено', 'переробка')),
  fes_on          TEXT,
  fes_register    TEXT,
  fes_ref         TEXT,
  extra           TEXT,
  missing         TEXT,
  note            TEXT
) STRICT;
CREATE INDEX ix_pur_doc_purchase ON pur_doc(purchase_id);
CREATE INDEX ix_pur_doc_parent ON pur_doc(parent_id);

CREATE TABLE pur_doc_line (
  id         TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL REFERENCES pur_doc(id) ON DELETE CASCADE,
  pos        INTEGER NOT NULL,
  name       TEXT NOT NULL,
  nomen_code TEXT,
  uom        TEXT,
  qty_milli  INTEGER NOT NULL,
  price_kop  INTEGER NOT NULL,
  fes_no     TEXT,
  made_year  TEXT,
  passport   TEXT,
  life       TEXT
) STRICT;
CREATE INDEX ix_pur_doc_line_doc ON pur_doc_line(doc_id);

CREATE TABLE pur_doc_fund (
  doc_id     TEXT NOT NULL REFERENCES pur_doc(id) ON DELETE CASCADE,
  line_id    TEXT NOT NULL REFERENCES fund_line(id),
  amount_kop INTEGER NOT NULL,
  PRIMARY KEY (doc_id, line_id)
) STRICT;

CREATE TABLE pur_doc_receipt (
  doc_id      TEXT NOT NULL REFERENCES pur_doc(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  PRIMARY KEY (doc_id, document_id)
) STRICT;
CREATE INDEX ix_pur_doc_receipt_document ON pur_doc_receipt(document_id);

-- Файл у теці з налаштувань: ключ теки (порожньо — «Дані обліку/скани») і відбиток вмісту.
ALTER TABLE app_file ADD COLUMN folder TEXT;
ALTER TABLE app_file ADD COLUMN sha256 TEXT;

COMMIT;
