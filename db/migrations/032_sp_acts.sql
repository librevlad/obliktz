-- Схема 32: акти сухпаю на ядрі актів схеми 28 — другий вид акта («sp», серія СП).
--
-- Акт сухпаю складають за рапортом підрозділу: дні рапорту й особи на сухпаї кожного дня (Добовка, аркуш «Сухпай»,
-- або вписані людиною) лягають в акт знімком (`act_day`), як підписанти й папери; з них акт рахує пайки, підігрівачі
-- й воду, а «1прод» — квартали днів. `act.party` — кому видано за актом: підрозділ одержувача, як його пишуть
-- накладна й роздавальна відомість пакета («4 роти 2 батальйону»). Підрозділ, як у Добовці («2 БАТ 4 рота»), —
-- примітка рядків документа акта (її несе книга «Облік СП»). `act_item.role` — чим є рядок акта сухпаю: «пайок»,
-- «підігрівач», «вода», «інше» (з ним вікно акта знає, що обрала людина); у рядка пайка — ще його людино-дні
-- (`people_days`: різні пайки за одним рапортом ділять людино-дні рапорту) і позначка «з підігрівачем» (`heater`).
-- Акт ОП/МЗ днів, одержувача й ролей рядків не має.
--
-- Тіло — між BEGIN і COMMIT: оновлення, що зірвалося посередині, лишає схему 31.

BEGIN;

ALTER TABLE act ADD COLUMN party TEXT;
ALTER TABLE act_item ADD COLUMN role TEXT CHECK (role IS NULL OR role IN ('пайок', 'підігрівач', 'вода', 'інше'));
ALTER TABLE act_item ADD COLUMN people_days INTEGER CHECK (people_days IS NULL OR people_days > 0);
ALTER TABLE act_item ADD COLUMN heater INTEGER CHECK (heater IS NULL OR heater IN (0, 1));

CREATE TABLE act_day (
  document_id INTEGER NOT NULL REFERENCES act(document_id) ON DELETE CASCADE,
  on_date     TEXT NOT NULL,
  persons     INTEGER NOT NULL CHECK (persons > 0),
  PRIMARY KEY (document_id, on_date)
) STRICT;

COMMIT;
