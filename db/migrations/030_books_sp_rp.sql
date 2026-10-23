-- Схема 30: книги обліку сухпаю («СП») і реторт-пакетів («РП») поруч із ТЗ і ОП.
--
-- Перелік книг — обмеження групи номенклатури; групи СП і РП — свої id за групами ОП (901–904).
-- Вид рядка звіту 1/прод у позиції сухпаю (колонка «тип» книги СП: ПНСП, ДПНП, іноземні добові…)
-- — поле позиції. Стан «роздрукувати» (акт складено, ще не надруковано) — перед «на підписі», для
-- всіх книг. Поля рядка документа, яких немає в рядку застосунку («придатний до» приходу, квартал
-- звіту 1/прод рядка списання), — окрема таблиця з ключем (документ, код, примітка): за цим ключем
-- книга зводить рядки однієї позиції, і партії, на які рядок розкладено в базі, її не розбивають.
-- `q1prod_fixed` — квартал узято з книги чи вписано людиною, програма його не перераховує.
-- Перебудова таблиць — з вимкненими зовнішніми ключами (так велить SQLite для зміни обмежень;
-- PRAGMA діє лише поза транзакцією), ключі перевіряє тест (PRAGMA foreign_key_check).

PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE nomen_group_new (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  book TEXT NOT NULL DEFAULT 'ТЗ' CHECK (book IN ('ТЗ','ОП','СП','РП'))
) STRICT;
INSERT INTO nomen_group_new(id, code, name, sort, book) SELECT id, code, name, sort, book FROM nomen_group;
DROP TABLE nomen_group;
ALTER TABLE nomen_group_new RENAME TO nomen_group;

INSERT OR IGNORE INTO nomen_group(id, code, name, sort, book) VALUES
  (905, 'СП.1', 'Сухі пайки', 905, 'СП'),
  (906, 'СП.2', 'Продукти (ПК)', 906, 'СП'),
  (907, 'СП.3', 'Тара', 907, 'СП'),
  (908, 'СП.4', 'Тютюнові вироби', 908, 'СП'),
  (909, 'РП.1', 'Реторт-пакети', 909, 'РП');

ALTER TABLE nomen ADD COLUMN prod1_kind TEXT;

CREATE TABLE document_fes_new (
  document_id INTEGER PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('немає витяга','роздрукувати','на підписі','їде на ФЕС','проведено','переробка')),
  changed_on TEXT,
  register TEXT,
  fes_ref TEXT,
  note TEXT
) STRICT;
INSERT INTO document_fes_new(document_id, status, changed_on, register, fes_ref, note)
  SELECT document_id, status, changed_on, register, fes_ref, note FROM document_fes;
DROP TABLE document_fes;
ALTER TABLE document_fes_new RENAME TO document_fes;

CREATE TABLE doc_line_extra (
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  best_before TEXT,
  q1prod TEXT,
  q1prod_fixed INTEGER NOT NULL DEFAULT 0 CHECK (q1prod_fixed IN (0,1)),
  PRIMARY KEY (document_id, code, note)
) STRICT;

COMMIT;
PRAGMA foreign_keys = ON;
