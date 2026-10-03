-- Схема бази обліку ТЗ ПС.
--
-- Один файл замість міграцій 001–023: до першого випуску програми їх злито
-- (29.09.2026). База зі схемою 23 цей файл пропускає, нова база починається з
-- нього, а базу зі схемою 1–22 програма не оновлює й каже про це. Далі схема
-- змінюється лише новим файлом із наступним номером, виданий файл не правлять;
-- яка версія програми яку схему принесла — у `docs/версії.md`.
--
-- Кількість у таблицях обліку — у тисячних одиниці (`qty_milli`), гроші — у
-- копійках (`price_kop`), дати — текстом ISO (РРРР-ММ-ДД). Правила над даними
-- (вид обліку за кодом ФЕС, майно батальйону за його їдальнею) — у `db/rules/`.

-- ------------------------------------------------------------------ службове
CREATE TABLE schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
) STRICT;

-- ----------------------------------------------------------------- довідники
-- `ext_id` — ідентифікатор, під яким запис знає програма: у записів, заведених
-- у ній, він свій і не змінюється між запусками, тож посилання на них (МВО,
-- підписанти описів) переживають перезапуск.
CREATE TABLE uom (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE nomen_group (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Номенклатура служби. `fes_code` — номер позиції у ФЕС: інвентарний (десять
-- цифр, клас рахунку 10 чи 11) або номенклатурний номер запасів; за ним
-- виставляється `is_fixed_asset` (db/rules/asset_class.sql). `old_code` — коди
-- з «Облік ТЗ 3.0», згорнуті в цю позицію. Позиція, заведена в програмі, має
-- `source` = 'program' і ціну з картки `app_price_kop`: партій у неї ще немає.
CREATE TABLE nomen (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  group_id INTEGER NOT NULL REFERENCES nomen_group(id),
  uom_id INTEGER NOT NULL REFERENCES uom(id),
  fes_code TEXT,
  old_code TEXT,
  tracking TEXT NOT NULL DEFAULT 'qty' CHECK (tracking IN ('qty','instance')),
  is_fixed_asset INTEGER NOT NULL DEFAULT 0 CHECK (is_fixed_asset IN (0,1)),
  note TEXT,
  archived_at TEXT,
  app_price_kop INTEGER,
  source TEXT NOT NULL DEFAULT 'seed'
) STRICT;

CREATE TABLE subdivision_kind (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Дерево підрозділів частини (`parent_id`), разом зі складом.
CREATE TABLE subdivision (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  short_name TEXT,
  kind_id INTEGER NOT NULL REFERENCES subdivision_kind(id),
  parent_id INTEGER REFERENCES subdivision(id),
  sort INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  note TEXT,
  ext_id TEXT
) STRICT;

CREATE INDEX ix_subdivision_parent ON subdivision(parent_id);
CREATE UNIQUE INDEX ux_subdivision_ext ON subdivision(ext_id) WHERE ext_id IS NOT NULL;

-- Інші назви підрозділу в джерелах — місця у ФЕС, колонки журналів 3.0, — щоб
-- зіставляти їх із деревом.
CREATE TABLE subdivision_alias (
  id INTEGER PRIMARY KEY,
  subdivision_id INTEGER NOT NULL REFERENCES subdivision(id),
  name TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT
) STRICT;

CREATE INDEX ix_alias_sub ON subdivision_alias(subdivision_id);

-- Предки й нащадки кожного вузла дерева; вузол сам собі предок на глибині 0.
CREATE VIEW subdivision_tree AS
WITH RECURSIVE t(ancestor_id, descendant_id, depth) AS (
  SELECT id, id, 0 FROM subdivision
  UNION ALL
  SELECT t.ancestor_id, s.id, t.depth + 1
  FROM t JOIN subdivision s ON s.parent_id = t.descendant_id
)
SELECT * FROM t;

-- Місця зберігання: де фізично лежить майно, окремо від того, за ким воно числиться.
CREATE TABLE place_kind (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE place (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind_id INTEGER NOT NULL REFERENCES place_kind(id),
  subdivision_id INTEGER REFERENCES subdivision(id),
  landmark TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
) STRICT;

-- Контрагенти: хто передає майно частині або приймає його від неї.
CREATE TABLE counterparty_kind (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE counterparty (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind_id INTEGER NOT NULL REFERENCES counterparty_kind(id),
  code TEXT,
  note TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
) STRICT;

-- ---------------------------------------------------------------------- люди
-- Ім'я розкладено на частини: у бланку потрібні обидва написи — «Ім'я
-- ПРІЗВИЩЕ» у підписі й «ПРІЗВИЩЕ І. П.» у складі комісії. Якщо відомі лише
-- ініціали, в ім'я й по батькові пишеться по одній літері. `app_note` —
-- примітка з програми.
CREATE TABLE person (
  id INTEGER PRIMARY KEY,
  rank TEXT,
  full_name TEXT NOT NULL,
  position TEXT,
  subdivision_id INTEGER REFERENCES subdivision(id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  surname TEXT,
  given_name TEXT,
  patronymic TEXT,
  ext_id TEXT,
  app_note TEXT
) STRICT;

CREATE UNIQUE INDEX ux_person_ext ON person(ext_id) WHERE ext_id IS NOT NULL;

-- Звання й посада змінюються, а торішній опис має показувати того, хто тоді
-- підписував, і тим званням, яке тоді було, — тож вони живуть окремими
-- записами з датою, а не одним полем.
CREATE TABLE person_history (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  on_date TEXT NOT NULL,
  rank TEXT,
  position TEXT,
  basis TEXT,
  UNIQUE (person_id, on_date)
) STRICT;

-- Посадовці частини, що підписують документи служби: командир затверджує акт
-- інвентаризації, начальник логістики з ним ознайомлюється, начальник служби
-- перевіряє описи, бухгалтер вносить облікові дані. Строк дії — як у
-- матеріально відповідальних: хто змінився — закривають дату й додають рядок.
CREATE TABLE official (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('командир', 'начальник логістики', 'начальник служби',
                                     'бухгалтер', 'начальник ФЕС')),
  person_id INTEGER NOT NULL REFERENCES person(id),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  note TEXT,
  ext_id TEXT,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
) STRICT;

CREATE INDEX ix_official_role ON official(role, valid_from);
CREATE UNIQUE INDEX ux_official_ext ON official(ext_id) WHERE ext_id IS NOT NULL;

-- Матеріально відповідальна особа підрозділу. Інвентаризаційний опис підписує
-- не підрозділ, а людина: командир ВМТЗ, позаштатний начальник складу. Посада
-- й людина змінюються, а торішній опис має лишитися правдою — тому строк дії.
CREATE TABLE responsible (
  id INTEGER PRIMARY KEY,
  subdivision_id INTEGER NOT NULL REFERENCES subdivision(id),
  person_id INTEGER NOT NULL REFERENCES person(id),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  note TEXT,
  ext_id TEXT,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
) STRICT;

CREATE INDEX ix_responsible_sub ON responsible(subdivision_id, valid_from);
CREATE UNIQUE INDEX ux_responsible_ext ON responsible(ext_id) WHERE ext_id IS NOT NULL;

-- Двоє відповідальних за один підрозділ на одну дату означають, що опис нема
-- кому підписати однозначно.
CREATE TRIGGER trg_responsible_no_overlap_ins BEFORE INSERT ON responsible
BEGIN
  SELECT RAISE(ABORT, 'Матеріально відповідальний перекривається з наявним за строком')
  WHERE EXISTS (
    SELECT 1 FROM responsible r
    WHERE r.subdivision_id = NEW.subdivision_id
      AND r.valid_from < COALESCE(NEW.valid_to, '9999-12-31')
      AND COALESCE(r.valid_to, '9999-12-31') > NEW.valid_from);
END;

CREATE TRIGGER trg_responsible_no_overlap_upd BEFORE UPDATE ON responsible
BEGIN
  SELECT RAISE(ABORT, 'Матеріально відповідальний перекривається з наявним за строком')
  WHERE EXISTS (
    SELECT 1 FROM responsible r
    WHERE r.id <> NEW.id
      AND r.subdivision_id = NEW.subdivision_id
      AND r.valid_from < COALESCE(NEW.valid_to, '9999-12-31')
      AND COALESCE(r.valid_to, '9999-12-31') > NEW.valid_from);
END;

-- Командир (начальник) підрозділу.
--
-- Наказ про інвентаризацію вимагає, щоб опис, крім комісії й матеріально
-- відповідальної особи, підписав командир (начальник) підрозділу, де її
-- проводили. Людина на посаді змінюється, а торішній опис має лишитися
-- правдою — тому строк дії, як у матеріально відповідальної особи. Командир
-- вищого підрозділу підписує й за підлеглі, де свого не призначено: це рішення
-- програми, у базі — лише самі призначення.
CREATE TABLE commander (
  id INTEGER PRIMARY KEY,
  subdivision_id INTEGER NOT NULL REFERENCES subdivision(id),
  person_id INTEGER NOT NULL REFERENCES person(id),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  note TEXT,
  ext_id TEXT,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
) STRICT;

CREATE INDEX ix_commander_sub ON commander(subdivision_id, valid_from);
CREATE UNIQUE INDEX ux_commander_ext ON commander(ext_id) WHERE ext_id IS NOT NULL;

-- Двоє командирів одного підрозділу на одну дату означають, що опис нема кому
-- підписати однозначно.
CREATE TRIGGER trg_commander_no_overlap_ins BEFORE INSERT ON commander
BEGIN
  SELECT RAISE(ABORT, 'Командир підрозділу перекривається з наявним за строком')
  WHERE EXISTS (
    SELECT 1 FROM commander r
    WHERE r.subdivision_id = NEW.subdivision_id
      AND r.valid_from < COALESCE(NEW.valid_to, '9999-12-31')
      AND COALESCE(r.valid_to, '9999-12-31') > NEW.valid_from);
END;

CREATE TRIGGER trg_commander_no_overlap_upd BEFORE UPDATE ON commander
BEGIN
  SELECT RAISE(ABORT, 'Командир підрозділу перекривається з наявним за строком')
  WHERE EXISTS (
    SELECT 1 FROM commander r
    WHERE r.id <> NEW.id
      AND r.subdivision_id = NEW.subdivision_id
      AND r.valid_from < COALESCE(NEW.valid_to, '9999-12-31')
      AND COALESCE(r.valid_to, '9999-12-31') > NEW.valid_from);
END;

-- Дислокація частини: де складаються документи. У накладній це «місце
-- складання», і воно змінюється разом із частиною. Діє від дати до наступного
-- запису, як і посадовці.
CREATE TABLE unit_location (
  id INTEGER PRIMARY KEY,
  valid_from TEXT NOT NULL UNIQUE,
  place TEXT NOT NULL,
  note TEXT,                                -- звідки відомо: наказ, накладна
  ext_id TEXT
) STRICT;

CREATE UNIQUE INDEX ux_location_ext ON unit_location(ext_id) WHERE ext_id IS NOT NULL;

-- ---------------------------------------------------------------- примірники
-- Примірник — фізична одиниця позиції з інвентарним чи заводським номером.
-- `nomen.tracking` = 'instance' робить його обов'язковим у кожному русі; на
-- решті позицій примірник можна назвати в рядку документа, коли він відомий, —
-- щоб не губилося, яка саме кухня поїхала в батальйон.
CREATE TABLE instance (
  id INTEGER PRIMARY KEY,
  nomen_id INTEGER NOT NULL REFERENCES nomen(id),
  inv_no TEXT,
  serial_no TEXT,
  chassis_no TEXT,
  made_year INTEGER,
  note TEXT
) STRICT;

CREATE UNIQUE INDEX ux_instance_serial ON instance(nomen_id, serial_no)
  WHERE serial_no IS NOT NULL;
CREATE UNIQUE INDEX ux_instance_inv ON instance(inv_no) WHERE inv_no IS NOT NULL;
CREATE INDEX ix_instance_nomen ON instance(nomen_id);

-- Те саме, що ux_instance_inv: індекс з'явився вдруге окремою зміною схеми, і
-- робочі бази мають обидва.
CREATE UNIQUE INDEX ux_instance_inv_no ON instance(inv_no) WHERE inv_no IS NOT NULL;

-- Категорія стану примірника (1–5) на дату.
CREATE TABLE instance_condition (
  id INTEGER PRIMARY KEY,
  instance_id INTEGER NOT NULL REFERENCES instance(id),
  on_date TEXT NOT NULL,
  condition_cat INTEGER NOT NULL CHECK (condition_cat BETWEEN 1 AND 5),
  document_id INTEGER,
  note TEXT
) STRICT;

CREATE INDEX ix_cond_instance ON instance_condition(instance_id, on_date);

-- Закріплення примірника за підрозділом. Поки на одиницю не нанесено
-- інвентарний номер, документи не кажуть, який саме термос поїхав у батальйон,
-- тому місце примірника фіксується окремо: «стільки номерів видано туди-то
-- станом на дату». Коли номер пишуть у накладній, місце визначають документи.
-- Номери власні, не з ФЕС: там один інвентарний номер накриває до десяти
-- різних активів.
CREATE TABLE instance_assignment (
  id INTEGER PRIMARY KEY,
  instance_id INTEGER NOT NULL REFERENCES instance(id),
  subdivision_id INTEGER NOT NULL REFERENCES subdivision(id),
  on_date TEXT NOT NULL,
  document_id INTEGER REFERENCES document(id),
  note TEXT
) STRICT;

CREATE INDEX ix_instance_assignment_instance ON instance_assignment(instance_id);
CREATE INDEX ix_instance_assignment_sub ON instance_assignment(subdivision_id, on_date);

-- ----------------------------------------------------------------- документи
-- Вид документа. `affects_stock` = 0 — папір, що залишків не рухає, як-от
-- рапорт про знищення: майно числиться, доки його не списано.
CREATE TABLE doc_kind (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  affects_stock INTEGER NOT NULL DEFAULT 1 CHECK (affects_stock IN (0,1)),
  number_template TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
) STRICT;

-- Документ. Внесене в програмі лягає в ті самі таблиці, що й облік із паперів:
-- інакше перевірки цілісності, звіти й бланки бачили б лише половину обліку.
-- Звідки документ, каже `source` ('seed' — перенос, 'program' — програма);
-- `paper` — вид самого паперу (накладна, атестат, витяг із наказу).
CREATE TABLE document (
  id INTEGER PRIMARY KEY,
  kind_id INTEGER NOT NULL REFERENCES doc_kind(id),
  number TEXT NOT NULL,
  doc_date TEXT NOT NULL,
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  counterparty_id INTEGER REFERENCES counterparty(id),
  from_subdivision_id INTEGER REFERENCES subdivision(id),
  to_subdivision_id INTEGER REFERENCES subdivision(id),
  person_id INTEGER REFERENCES person(id),
  note TEXT,
  source TEXT NOT NULL DEFAULT 'seed',
  paper TEXT
) STRICT;

CREATE INDEX ix_doc_date ON document(doc_date);
CREATE INDEX ix_doc_number ON document(kind_id, number, doc_date);
CREATE INDEX ix_document_source ON document(source);

-- Рядок документа. `source_line_id` — партія: рядок надходження, з якого
-- береться майно; у рядка самого надходження він порожній.
CREATE TABLE document_line (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  nomen_id INTEGER NOT NULL REFERENCES nomen(id),
  instance_id INTEGER REFERENCES instance(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  source_line_id INTEGER REFERENCES document_line(id),
  price_kop INTEGER,
  from_place_id INTEGER REFERENCES place(id),
  to_place_id INTEGER REFERENCES place(id),
  note TEXT,
  UNIQUE (document_id, line_no)
) STRICT;

CREATE INDEX ix_line_doc ON document_line(document_id);
CREATE INDEX ix_line_nomen ON document_line(nomen_id);
CREATE INDEX ix_line_instance ON document_line(instance_id) WHERE instance_id IS NOT NULL;
CREATE INDEX ix_line_source ON document_line(source_line_id) WHERE source_line_id IS NOT NULL;

-- Правила рядка, що не виражаються декларативно; повідомлення бачить оператор.
-- Примірник обов'язковий лише в документах, що рухають залишки: архів
-- 2022–2025 вівся кількісно, і вигадувати примірники заднім числом не можна.
-- Примірник — завжди одна одиниця своєї номенклатури, партія — тієї самої
-- номенклатури, документ руху має хоч одну сторону, а видача вказує партію.
CREATE TRIGGER trg_line_rules_ins BEFORE INSERT ON document_line
BEGIN
  SELECT RAISE(ABORT, 'Для цієї позиції ведеться пооб''єктний облік: потрібен екземпляр')
  WHERE NEW.instance_id IS NULL
    AND (SELECT tracking FROM nomen WHERE id = NEW.nomen_id) = 'instance'
    AND (SELECT k.affects_stock FROM document d JOIN doc_kind k ON k.id = d.kind_id
         WHERE d.id = NEW.document_id) = 1;


  SELECT RAISE(ABORT, 'Екземпляр — це одна одиниця')
  WHERE NEW.instance_id IS NOT NULL AND NEW.qty_milli <> 1000;

  SELECT RAISE(ABORT, 'Екземпляр іншої номенклатури')
  WHERE NEW.instance_id IS NOT NULL
    AND (SELECT nomen_id FROM instance WHERE id = NEW.instance_id) <> NEW.nomen_id;

  SELECT RAISE(ABORT, 'Партія іншої номенклатури')
  WHERE NEW.source_line_id IS NOT NULL
    AND (SELECT nomen_id FROM document_line WHERE id = NEW.source_line_id) <> NEW.nomen_id;

  SELECT RAISE(ABORT, 'Документ впливає на залишки, але не має жодної сторони')
  WHERE (SELECT k.affects_stock FROM document d JOIN doc_kind k ON k.id = d.kind_id
         WHERE d.id = NEW.document_id) = 1
    AND (SELECT d.from_subdivision_id IS NULL AND d.to_subdivision_id IS NULL
         FROM document d WHERE d.id = NEW.document_id) = 1;

  SELECT RAISE(ABORT, 'Вкажіть партію, з якої списується майно')
  WHERE NEW.source_line_id IS NULL
    AND (SELECT k.affects_stock FROM document d JOIN doc_kind k ON k.id = d.kind_id
         WHERE d.id = NEW.document_id) = 1
    AND (SELECT d.from_subdivision_id IS NOT NULL
         FROM document d WHERE d.id = NEW.document_id) = 1;
END;

CREATE TRIGGER trg_line_rules_upd BEFORE UPDATE ON document_line
BEGIN
  SELECT RAISE(ABORT, 'Для цієї позиції ведеться пооб''єктний облік: потрібен екземпляр')
  WHERE NEW.instance_id IS NULL
    AND (SELECT tracking FROM nomen WHERE id = NEW.nomen_id) = 'instance'
    AND (SELECT k.affects_stock FROM document d JOIN doc_kind k ON k.id = d.kind_id
         WHERE d.id = NEW.document_id) = 1;


  SELECT RAISE(ABORT, 'Екземпляр — це одна одиниця')
  WHERE NEW.instance_id IS NOT NULL AND NEW.qty_milli <> 1000;

  SELECT RAISE(ABORT, 'Екземпляр іншої номенклатури')
  WHERE NEW.instance_id IS NOT NULL
    AND (SELECT nomen_id FROM instance WHERE id = NEW.instance_id) <> NEW.nomen_id;

  SELECT RAISE(ABORT, 'Партія іншої номенклатури')
  WHERE NEW.source_line_id IS NOT NULL
    AND (SELECT nomen_id FROM document_line WHERE id = NEW.source_line_id) <> NEW.nomen_id;

  SELECT RAISE(ABORT, 'Документ впливає на залишки, але не має жодної сторони')
  WHERE (SELECT k.affects_stock FROM document d JOIN doc_kind k ON k.id = d.kind_id
         WHERE d.id = NEW.document_id) = 1
    AND (SELECT d.from_subdivision_id IS NULL AND d.to_subdivision_id IS NULL
         FROM document d WHERE d.id = NEW.document_id) = 1;

  SELECT RAISE(ABORT, 'Вкажіть партію, з якої списується майно')
  WHERE NEW.source_line_id IS NULL
    AND (SELECT k.affects_stock FROM document d JOIN doc_kind k ON k.id = d.kind_id
         WHERE d.id = NEW.document_id) = 1
    AND (SELECT d.from_subdivision_id IS NOT NULL
         FROM document d WHERE d.id = NEW.document_id) = 1;
END;

-- Зв'язки документів: підстава, а також рапорт про знищення — документ, яким
-- знищене списано.
CREATE TABLE doc_link_kind (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL
) STRICT;

CREATE TABLE document_link (
  id INTEGER PRIMARY KEY,
  from_document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  to_document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  kind_id INTEGER NOT NULL REFERENCES doc_link_kind(id),
  note TEXT,
  UNIQUE (from_document_id, to_document_id, kind_id),
  CHECK (from_document_id <> to_document_id)
) STRICT;

-- Скани документа: файл лежить у теці даних, тут — лише відносний шлях.
CREATE TABLE attachment (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  rel_path TEXT NOT NULL CHECK (
    rel_path NOT LIKE '_:%' AND rel_path NOT LIKE '/%' AND rel_path NOT LIKE '\%'),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

-- Рапорт про знищення і акт списання — порядково.
--
-- Рапорт включають до єдиного акта списання ще до того, як акт проведено:
-- тоді відомий лише номер акта. Проведений акт — сам документ (act_id). Рядки
-- одного рапорту можуть піти до різних актів, тому номер і акт стоять на рядку
-- рапорту. Зв'язок рапорту з актом (document_link, «списання за рапортом»)
-- лишається підсумком для звітів; рапорт зі зв'язком, але без жодного такого
-- рядка, закрито актом цілком — так зв'язано рапорти з паперових журналів.
CREATE TABLE report_line_act (
  line_id INTEGER PRIMARY KEY REFERENCES document_line(id) ON DELETE CASCADE,
  act_no TEXT NOT NULL,
  act_id INTEGER REFERENCES document(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX ix_report_line_act_act ON report_line_act(act_id) WHERE act_id IS NOT NULL;

-- Рапорт про знищення називає й те, чого облік програми не веде: продукти,
-- запаси служби, майно інших служб. Доповідь про втрати (таблиця діловода)
-- рахує втрату рапортом цілком, тож такі рядки лежать при документі рапорту —
-- окремо від рядків техзасобів: позиції довідника в них немає, залишків вони
-- не рухають, ціна — з рапорту чи справи, коли є. Списують їх не актом
-- програми, а документом, названим на самому рядку.
CREATE TABLE report_other (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  uom TEXT,
  -- Ціна за одиницю в гривнях × 10000: у справах ЄАС ціна буває з чотирма
  -- знаками, і сума рапорту має зійтися до копійки. NULL — рапорт без ціни.
  price_x10000 INTEGER CHECK (price_x10000 IS NULL OR price_x10000 >= 0),
  off_no TEXT,
  off_date TEXT,
  note TEXT,
  UNIQUE (document_id, line_no)
) STRICT;

CREATE INDEX ix_report_other_doc ON report_other(document_id);

-- Ціна рядка техзасобів за документом (справа ЄАС, відомість) замість ціни
-- партії — коли довідка має зійтися з затвердженою сумою. Рядок без такого
-- запису оцінюється партією, як і раніше.
CREATE TABLE report_line_price (
  line_id INTEGER PRIMARY KEY REFERENCES document_line(id) ON DELETE CASCADE,
  price_x10000 INTEGER NOT NULL CHECK (price_x10000 >= 0)
) STRICT;

-- Проводки: кожен рядок документа, що рухає залишки, — мінус у відправника й
-- плюс в одержувача. Залишок на дату — сума sign × qty_milli до неї.
CREATE VIEW posting AS
SELECT l.id AS line_id, d.id AS document_id, d.doc_date, d.kind_id,
       l.nomen_id, l.instance_id, COALESCE(l.source_line_id, l.id) AS batch_line_id,
       d.from_subdivision_id AS subdivision_id, l.from_place_id AS place_id,
       d.to_subdivision_id AS counter_subdivision_id, d.counterparty_id,
       -1 AS sign, l.qty_milli
FROM document_line l
JOIN document d ON d.id = l.document_id
JOIN doc_kind k ON k.id = d.kind_id
WHERE k.affects_stock = 1 AND d.from_subdivision_id IS NOT NULL
UNION ALL
SELECT l.id, d.id, d.doc_date, d.kind_id,
       l.nomen_id, l.instance_id, COALESCE(l.source_line_id, l.id),
       d.to_subdivision_id, l.to_place_id,
       d.from_subdivision_id, d.counterparty_id,
       +1, l.qty_milli
FROM document_line l
JOIN document d ON d.id = l.document_id
JOIN doc_kind k ON k.id = d.kind_id
WHERE k.affects_stock = 1 AND d.to_subdivision_id IS NOT NULL;

-- Партії: рядки надходжень ззовні — одержувач є, відправника немає.
CREATE VIEW batch AS
SELECT l.id AS batch_line_id, d.id AS document_id, d.doc_date, d.number,
       d.counterparty_id, l.nomen_id, l.instance_id,
       l.qty_milli AS in_qty_milli, l.price_kop
FROM document_line l
JOIN document d ON d.id = l.document_id
JOIN doc_kind k ON k.id = d.kind_id
WHERE k.affects_stock = 1
  AND d.to_subdivision_id IS NOT NULL
  AND d.from_subdivision_id IS NULL;

-- Знищене, ще не списане: рядок рапорту без проведеного акта. Рапорт, у якого
-- рядки названо поіменно, закривається порядково; решта — цілим документом.
CREATE VIEW destroyed_open AS
SELECT l.id AS line_id, d.id AS document_id, d.doc_date, d.number,
       d.from_subdivision_id AS subdivision_id,
       l.nomen_id, l.instance_id, l.qty_milli
FROM document_line l
JOIN document d ON d.id = l.document_id
JOIN doc_kind k ON k.id = d.kind_id
WHERE k.code = 'report_destroyed'
  AND CASE
    WHEN EXISTS (SELECT 1 FROM report_line_act ra
                   JOIN document_line l2 ON l2.id = ra.line_id
                  WHERE l2.document_id = d.id)
    THEN NOT EXISTS (
      SELECT 1 FROM report_line_act ra
      JOIN document a ON a.id = ra.act_id
      JOIN doc_kind ak ON ak.id = a.kind_id
      WHERE ra.line_id = l.id AND ak.affects_stock = 1)
    ELSE NOT EXISTS (
      SELECT 1 FROM document_link dl
      JOIN document a ON a.id = dl.to_document_id
      JOIN doc_kind ak ON ak.id = a.kind_id
      WHERE dl.from_document_id = d.id AND ak.affects_stock = 1)
  END;

-- Остання ціна позиції — одна: з найпізнішої партії, а на одну дату — з
-- останнього рядка. Інакше приєднання до подання множило б рядки.
CREATE VIEW nomen_last_price AS
SELECT b.nomen_id, b.price_kop, b.doc_date
FROM batch b
WHERE b.batch_line_id = (
  SELECT b2.batch_line_id FROM batch b2
  WHERE b2.nomen_id = b.nomen_id
  ORDER BY b2.doc_date DESC, b2.batch_line_id DESC
  LIMIT 1);

-- ------------------------------------------------------------ табель і норми
-- Табельні форми (21/Прод, 2/Прод, 3/Прод), їхні рядки й прив'язка позицій служби до рядків.
CREATE TABLE report_form (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL
) STRICT;

CREATE TABLE report_line (
  id INTEGER PRIMARY KEY,
  form_id INTEGER NOT NULL REFERENCES report_form(id),
  code TEXT,
  name TEXT NOT NULL,
  section TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (form_id, name)
) STRICT;

CREATE TABLE nomen_report_line (
  nomen_id INTEGER NOT NULL REFERENCES nomen(id),
  report_line_id INTEGER NOT NULL REFERENCES report_line(id),
  PRIMARY KEY (nomen_id, report_line_id)
) STRICT;

-- Норма висить або на коді, або на рядку форми — рівно на одному з двох. Штат
-- приходить формою 21/Прод, а її перелік табельний: «Кухні причіпні
-- КП-130(130М)» — один рядок, тоді як у службі це тридцять чотири коди.
-- `basis` — підстава норми текстом.
CREATE TABLE norm (
  id INTEGER PRIMARY KEY,
  subdivision_id INTEGER NOT NULL REFERENCES subdivision(id),
  nomen_id INTEGER REFERENCES nomen(id),
  report_line_id INTEGER REFERENCES report_line(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli >= 0),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  basis_document_id INTEGER REFERENCES document(id),
  note TEXT,
  ext_id TEXT,
  basis TEXT,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK ((nomen_id IS NULL) <> (report_line_id IS NULL))
) STRICT;

CREATE INDEX ix_norm_lookup ON norm(nomen_id, subdivision_id);
CREATE INDEX ix_norm_line ON norm(report_line_id, subdivision_id);
CREATE UNIQUE INDEX ux_norm_ext ON norm(ext_id) WHERE ext_id IS NOT NULL;

-- Дві норми на одну пару з перетином строків подвоїли б згортку по дереву.
-- Порівняння через IS, а не =: одне з двох полів ключа завжди NULL.
CREATE TRIGGER trg_norm_no_overlap_ins BEFORE INSERT ON norm
BEGIN
  SELECT RAISE(ABORT, 'Норма перекривається з наявною за строком дії')
  WHERE EXISTS (
    SELECT 1 FROM norm n
    WHERE n.subdivision_id = NEW.subdivision_id
      AND n.nomen_id IS NEW.nomen_id
      AND n.report_line_id IS NEW.report_line_id
      AND n.valid_from < COALESCE(NEW.valid_to, '9999-12-31')
      AND COALESCE(n.valid_to, '9999-12-31') > NEW.valid_from);
END;

CREATE TRIGGER trg_norm_no_overlap_upd BEFORE UPDATE ON norm
BEGIN
  SELECT RAISE(ABORT, 'Норма перекривається з наявною за строком дії')
  WHERE EXISTS (
    SELECT 1 FROM norm n
    WHERE n.id <> NEW.id
      AND n.subdivision_id = NEW.subdivision_id
      AND n.nomen_id IS NEW.nomen_id
      AND n.report_line_id IS NEW.report_line_id
      AND n.valid_from < COALESCE(NEW.valid_to, '9999-12-31')
      AND COALESCE(n.valid_to, '9999-12-31') > NEW.valid_from);
END;

-- --------------------------------------------------------------------- аудит
-- Аудит на рівні бази, а не застосунку: обійти його не можна навіть стороннім
-- редактором. Саме це робить безпечним режим «правити можна все». Хто вносив —
-- `settings.actor`.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('I','U','D')),
  old_json TEXT,
  new_json TEXT,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  actor TEXT
) STRICT;

CREATE INDEX ix_audit_row ON audit_log(table_name, row_id, changed_at);

CREATE TRIGGER trg_audit_document_ins AFTER INSERT ON document
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, new_json, actor)
  VALUES ('document', NEW.id, 'I',
          json_object('kind_id', NEW.kind_id, 'number', NEW.number,
                      'doc_date', NEW.doc_date, 'from_subdivision_id', NEW.from_subdivision_id,
                      'to_subdivision_id', NEW.to_subdivision_id, 'counterparty_id', NEW.counterparty_id,
                      'note', NEW.note),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_document_upd AFTER UPDATE ON document
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, old_json, new_json, actor)
  VALUES ('document', NEW.id, 'U',
          json_object('kind_id', OLD.kind_id, 'number', OLD.number,
                      'doc_date', OLD.doc_date, 'from_subdivision_id', OLD.from_subdivision_id,
                      'to_subdivision_id', OLD.to_subdivision_id, 'counterparty_id', OLD.counterparty_id,
                      'note', OLD.note),
          json_object('kind_id', NEW.kind_id, 'number', NEW.number,
                      'doc_date', NEW.doc_date, 'from_subdivision_id', NEW.from_subdivision_id,
                      'to_subdivision_id', NEW.to_subdivision_id, 'counterparty_id', NEW.counterparty_id,
                      'note', NEW.note),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_document_del AFTER DELETE ON document
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, old_json, actor)
  VALUES ('document', OLD.id, 'D',
          json_object('kind_id', OLD.kind_id, 'number', OLD.number,
                      'doc_date', OLD.doc_date),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_document_line_ins AFTER INSERT ON document_line
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, new_json, actor)
  VALUES ('document_line', NEW.id, 'I',
          json_object('document_id', NEW.document_id, 'line_no', NEW.line_no,
                      'nomen_id', NEW.nomen_id, 'instance_id', NEW.instance_id,
                      'qty_milli', NEW.qty_milli, 'source_line_id', NEW.source_line_id,
                      'price_kop', NEW.price_kop),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_document_line_upd AFTER UPDATE ON document_line
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, old_json, new_json, actor)
  VALUES ('document_line', NEW.id, 'U',
          json_object('document_id', OLD.document_id, 'line_no', OLD.line_no,
                      'nomen_id', OLD.nomen_id, 'instance_id', OLD.instance_id,
                      'qty_milli', OLD.qty_milli, 'source_line_id', OLD.source_line_id,
                      'price_kop', OLD.price_kop),
          json_object('document_id', NEW.document_id, 'line_no', NEW.line_no,
                      'nomen_id', NEW.nomen_id, 'instance_id', NEW.instance_id,
                      'qty_milli', NEW.qty_milli, 'source_line_id', NEW.source_line_id,
                      'price_kop', NEW.price_kop),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_document_line_del AFTER DELETE ON document_line
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, old_json, actor)
  VALUES ('document_line', OLD.id, 'D',
          json_object('document_id', OLD.document_id, 'line_no', OLD.line_no,
                      'nomen_id', OLD.nomen_id),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_norm_ins AFTER INSERT ON norm
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, new_json, actor)
  VALUES ('norm', NEW.id, 'I',
          json_object('subdivision_id', NEW.subdivision_id, 'nomen_id', NEW.nomen_id,
                      'report_line_id', NEW.report_line_id, 'qty_milli', NEW.qty_milli,
                      'valid_from', NEW.valid_from, 'valid_to', NEW.valid_to),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_norm_upd AFTER UPDATE ON norm
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, old_json, new_json, actor)
  VALUES ('norm', NEW.id, 'U',
          json_object('subdivision_id', OLD.subdivision_id, 'nomen_id', OLD.nomen_id,
                      'report_line_id', OLD.report_line_id, 'qty_milli', OLD.qty_milli,
                      'valid_from', OLD.valid_from, 'valid_to', OLD.valid_to),
          json_object('subdivision_id', NEW.subdivision_id, 'nomen_id', NEW.nomen_id,
                      'report_line_id', NEW.report_line_id, 'qty_milli', NEW.qty_milli,
                      'valid_from', NEW.valid_from, 'valid_to', NEW.valid_to),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_norm_del AFTER DELETE ON norm
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, old_json, actor)
  VALUES ('norm', OLD.id, 'D',
          json_object('subdivision_id', OLD.subdivision_id, 'nomen_id', OLD.nomen_id,
                      'report_line_id', OLD.report_line_id),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_nomen_ins AFTER INSERT ON nomen
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, new_json, actor)
  VALUES ('nomen', NEW.id, 'I',
          json_object('code', NEW.code, 'name', NEW.name,
                      'group_id', NEW.group_id, 'uom_id', NEW.uom_id,
                      'tracking', NEW.tracking),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_nomen_upd AFTER UPDATE ON nomen
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, old_json, new_json, actor)
  VALUES ('nomen', NEW.id, 'U',
          json_object('code', OLD.code, 'name', OLD.name,
                      'group_id', OLD.group_id, 'uom_id', OLD.uom_id,
                      'tracking', OLD.tracking),
          json_object('code', NEW.code, 'name', NEW.name,
                      'group_id', NEW.group_id, 'uom_id', NEW.uom_id,
                      'tracking', NEW.tracking),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_nomen_del AFTER DELETE ON nomen
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, old_json, actor)
  VALUES ('nomen', OLD.id, 'D',
          json_object('code', OLD.code, 'name', OLD.name,
                      'group_id', OLD.group_id),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_subdivision_ins AFTER INSERT ON subdivision
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, new_json, actor)
  VALUES ('subdivision', NEW.id, 'I',
          json_object('name', NEW.name, 'parent_id', NEW.parent_id,
                      'kind_id', NEW.kind_id, 'is_active', NEW.is_active),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_subdivision_upd AFTER UPDATE ON subdivision
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, old_json, new_json, actor)
  VALUES ('subdivision', NEW.id, 'U',
          json_object('name', OLD.name, 'parent_id', OLD.parent_id,
                      'kind_id', OLD.kind_id, 'is_active', OLD.is_active),
          json_object('name', NEW.name, 'parent_id', NEW.parent_id,
                      'kind_id', NEW.kind_id, 'is_active', NEW.is_active),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_subdivision_del AFTER DELETE ON subdivision
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, old_json, actor)
  VALUES ('subdivision', OLD.id, 'D',
          json_object('name', OLD.name, 'parent_id', OLD.parent_id,
                      'kind_id', OLD.kind_id),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_instance_ins AFTER INSERT ON instance
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, new_json, actor)
  VALUES ('instance', NEW.id, 'I',
          json_object('nomen_id', NEW.nomen_id, 'inv_no', NEW.inv_no,
                      'serial_no', NEW.serial_no, 'chassis_no', NEW.chassis_no),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_instance_upd AFTER UPDATE ON instance
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, old_json, new_json, actor)
  VALUES ('instance', NEW.id, 'U',
          json_object('nomen_id', OLD.nomen_id, 'inv_no', OLD.inv_no,
                      'serial_no', OLD.serial_no, 'chassis_no', OLD.chassis_no),
          json_object('nomen_id', NEW.nomen_id, 'inv_no', NEW.inv_no,
                      'serial_no', NEW.serial_no, 'chassis_no', NEW.chassis_no),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

CREATE TRIGGER trg_audit_instance_del AFTER DELETE ON instance
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, old_json, actor)
  VALUES ('instance', OLD.id, 'D',
          json_object('nomen_id', OLD.nomen_id, 'inv_no', OLD.inv_no,
                      'serial_no', OLD.serial_no),
          (SELECT value FROM settings WHERE key = 'actor'));
END;

-- -------------------------------------------------------------------- звірки
-- Звірка обліку з підрозділом. Раз на місяць служба звіряє облік із кожним
-- підрозділом, що тримає майно: складає узагальнюючу відомість (Додаток 1 до
-- Інструкції з обліку військового майна, п. 7 розд. ІІ), обидві сторони її
-- підписують, а результат записують у журнал результатів звірки (Додаток 9).
-- Графи журналу — поля шапки відомості.
CREATE TABLE reconciliation (
  id INTEGER PRIMARY KEY,
  subdivision_id INTEGER NOT NULL REFERENCES subdivision(id),
  number TEXT,
  doc_date TEXT NOT NULL,
  period_from TEXT,
  period_to TEXT NOT NULL,
  unit_title TEXT,
  signer_position TEXT,
  signer_name TEXT,
  chief_position TEXT,
  chief_name TEXT,
  result TEXT,
  decision TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'підписано' CHECK (status IN ('складено', 'підписано')),
  source TEXT,
  CHECK (period_from IS NULL OR period_from <= period_to)
) STRICT;

CREATE INDEX ix_reconciliation_sub ON reconciliation(subdivision_id, period_to);

-- Рядок відомості — партія позиції, бо різні партії коштують по-різному, і три
-- кількості: за фінансовим обліком, за обліком служби, фактично. Назва й
-- одиниця — як у підписаній відомості. Відомість — знімок: пізніші виправлення
-- документів її не перераховують.
CREATE TABLE reconciliation_line (
  id INTEGER PRIMARY KEY,
  reconciliation_id INTEGER NOT NULL REFERENCES reconciliation(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  nomen_id INTEGER REFERENCES nomen(id),
  name TEXT NOT NULL,
  uom TEXT,
  price_kop INTEGER,
  fin_qty_milli INTEGER,
  acc_qty_milli INTEGER,
  fact_qty_milli INTEGER,
  note TEXT,
  UNIQUE (reconciliation_id, line_no)
) STRICT;

-- ------------------------------------------------------------ інвентаризації
-- Інвентаризація — окрема подія: свій наказ, своя комісія, свої дати. Описи
-- складаються з обліку на дату, тож тут лише шапка й склад комісії. Хто
-- затвердив акт і хто підписав описи — факт саме цієї інвентаризації з її
-- паперів; посадовці з довідника на дату — лише підказка. Позапланова
-- інвентаризація буває не всієї частини: охоплення — переліком підрозділів.
CREATE TABLE inventory (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('щорічна', 'позапланова', 'чергова')),
  as_of TEXT NOT NULL,
  started TEXT,
  finished TEXT,
  order_no TEXT,
  order_date TEXT,
  prev_date TEXT,
  scope TEXT,                               -- підрозділи через «|»; NULL — уся частина
  note TEXT,                                -- привід, зміни складу комісії
  commander_id INTEGER REFERENCES person(id),    -- затвердив акт
  logistics_id INTEGER REFERENCES person(id),    -- з актом ознайомлений
  chief_id INTEGER REFERENCES person(id),        -- дані в описах перевірив
  accountant_id INTEGER REFERENCES person(id),   -- облікові дані вніс
  result TEXT,
  source TEXT,
  CHECK (started IS NULL OR started <= finished OR finished IS NULL)
) STRICT;

CREATE TABLE inventory_member (
  id INTEGER PRIMARY KEY,
  inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('голова', 'член')),
  line_no INTEGER NOT NULL,
  person_id INTEGER NOT NULL REFERENCES person(id),
  UNIQUE (inventory_id, line_no)
) STRICT;

-- Хто підписав опис як матеріально відповідальна особа — теж факт цієї
-- інвентаризації: довідник МВО на дату його лише підказує.
CREATE TABLE inventory_mvo (
  inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  subdivision_id INTEGER NOT NULL REFERENCES subdivision(id),
  person_id INTEGER NOT NULL REFERENCES person(id),
  PRIMARY KEY (inventory_id, subdivision_id)
) STRICT;

-- Папери інвентаризації: наказ і зміни до нього, підписані описи, акт, рапорт
-- про завершення, фото сторінок. Як і скани документів — у теці даних.
CREATE TABLE inventory_file (
  id INTEGER PRIMARY KEY,
  inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'інше'
    CHECK (kind IN ('наказ', 'акт', 'опис', 'рапорт', 'фото', 'інше')),
  file_name TEXT NOT NULL,
  mime TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  rel_path TEXT NOT NULL CHECK (
    rel_path NOT LIKE '_:%' AND rel_path NOT LIKE '/%' AND rel_path NOT LIKE '\%'),
  source TEXT,
  note TEXT,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (inventory_id, rel_path)
) STRICT;

-- ------------------------------------------------------------- файли позицій
-- Фото й документи до позиції або окремої одиниці: шильдик, паспорт, формуляр,
-- фото стану, інструкція. Одиниця — за заводським (або інвентарним) номером:
-- саме його видно на шильдику.
CREATE TABLE nomen_file (
  id INTEGER PRIMARY KEY,
  nomen_id INTEGER NOT NULL REFERENCES nomen(id),
  unit_no TEXT,
  kind TEXT NOT NULL DEFAULT 'фото'
    CHECK (kind IN ('шильдик', 'фото', 'паспорт', 'формуляр', 'інструкція', 'акт', 'інше')),
  file_name TEXT NOT NULL,
  mime TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  rel_path TEXT NOT NULL CHECK (
    rel_path NOT LIKE '_:%' AND rel_path NOT LIKE '/%' AND rel_path NOT LIKE '\%'),
  source TEXT,
  note TEXT,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

-- Один файл можна підшити до кількох одиниць, але до однієї одиниці — лише раз.
CREATE UNIQUE INDEX ux_nomen_file ON nomen_file(nomen_id, COALESCE(unit_no, ''), rel_path);
CREATE INDEX ix_nomen_file ON nomen_file(nomen_id, unit_no);

-- -------------------------------------------------------- внесене в програмі
-- Решта внесеного в програмі — знищене майно, заміни в штаті, звірки,
-- інвентаризації, підшиті файли, налаштування — у таблицях `app_*`. Вони
-- повторюють те, чим оперує застосунок, але полями, а не текстом у файлі; поля,
-- яких схема ще не знає, лежать JSON-ом в `extra` і не губляться.
CREATE TABLE app_destroyed (
  id          TEXT PRIMARY KEY,
  pos         INTEGER NOT NULL,
  event_date  TEXT NOT NULL,
  subdivision TEXT NOT NULL,
  code        TEXT NOT NULL,
  qty_milli   INTEGER,
  report_no   TEXT,
  report_date TEXT,
  act_no      TEXT,
  status      TEXT,
  note        TEXT,
  extra       TEXT
) STRICT;

CREATE TABLE app_subst (
  id      TEXT PRIMARY KEY,
  pos     INTEGER NOT NULL,
  form    TEXT NOT NULL,
  src     TEXT NOT NULL,
  targets TEXT NOT NULL,                 -- перелік позицій, які закриває заміна
  extra   TEXT
) STRICT;

CREATE TABLE app_recon (
  id           TEXT PRIMARY KEY,
  pos          INTEGER NOT NULL,
  subdivision  TEXT NOT NULL,
  number       TEXT,
  doc_date     TEXT,
  period_from  TEXT,
  period_to    TEXT,
  unit_title   TEXT,
  signer_pos   TEXT,
  signer_name  TEXT,
  chief_pos    TEXT,
  chief_name   TEXT,
  result       TEXT,
  decision     TEXT,
  note         TEXT,
  status       TEXT,
  created      TEXT,
  extra        TEXT
) STRICT;

CREATE TABLE app_recon_line (
  recon_id  TEXT NOT NULL REFERENCES app_recon(id) ON DELETE CASCADE,
  pos       INTEGER NOT NULL,
  code      TEXT,
  name      TEXT,
  uom       TEXT,
  price     REAL,
  fin_milli INTEGER,
  acc_milli INTEGER,
  fact_milli INTEGER,
  note      TEXT,
  extra     TEXT,
  PRIMARY KEY (recon_id, pos)
) STRICT;

CREATE TABLE app_inventory (
  id         TEXT PRIMARY KEY,
  pos        INTEGER NOT NULL,
  kind       TEXT,
  inv_date   TEXT,
  start_date TEXT,
  end_date   TEXT,
  order_no   TEXT,
  order_date TEXT,
  prev_date  TEXT,
  head_id    TEXT,
  members    TEXT,                        -- перелік ідентифікаторів людей
  status     TEXT,
  created    TEXT,
  extra      TEXT
) STRICT;

-- Розріджені частини опису: підписанти, МВО, місце, фактична наявність,
-- примітки — по підрозділах і кодах. Ключ каже, до чого саме запис.
CREATE TABLE app_inventory_cell (
  inventory_id TEXT NOT NULL REFERENCES app_inventory(id) ON DELETE CASCADE,
  part         TEXT NOT NULL,             -- sign | mvo | where | fact | note | accFixed | accStock | findings
  key          TEXT NOT NULL,
  value        TEXT,
  PRIMARY KEY (inventory_id, part, key)
) STRICT;

CREATE TABLE app_file (
  pos       INTEGER PRIMARY KEY,
  id        TEXT,
  target    TEXT NOT NULL,                -- «дата|номер», «item|код», «recon|id», «st|id»
  doc_date  TEXT,
  doc_no    TEXT,
  file_name TEXT NOT NULL,
  rel_path  TEXT NOT NULL,
  mime      TEXT,
  size_bytes INTEGER,
  extra     TEXT
) STRICT;

-- Реквізити частини, оформлення, чернетки, акти до рапортів і пам'ять про те,
-- які записи довідників прийшли з бази.
CREATE TABLE app_setting (
  key   TEXT PRIMARY KEY,
  value TEXT
) STRICT;

-- Журнал змін.
CREATE TABLE app_log (
  id    INTEGER PRIMARY KEY,
  at    TEXT NOT NULL,
  what  TEXT NOT NULL,
  key   TEXT,
  text  TEXT
) STRICT;

CREATE INDEX ix_app_log_key ON app_log(key);
