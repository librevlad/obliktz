-- Майно батальйону — за його їдальнею.
--
-- У батальйону власного майна не буває: воно числиться за їдальнею й ВМТЗ — так
-- його тримає й ФЕС, місця «сам батальйон» у неї немає. Документи, закріплення
-- примірників і матеріальна відповідальність переходять з батальйону на його
-- дочірній вузол «… · їдальня»; штат (норми) лишається за батальйоном — це його
-- табель.
--
-- Це правило, а не зміна схеми: перенос із 3.0 (build/migrate_to_db.py) виконує
-- його після наповнення.
CREATE TEMP TABLE hall AS
  SELECT b.id AS bat, h.id AS hall
    FROM subdivision b JOIN subdivision h ON h.parent_id = b.id
   WHERE h.name LIKE '% · їдальня' OR h.name LIKE '% · Їдальня';

UPDATE document
   SET to_subdivision_id = (SELECT hall FROM hall WHERE bat = document.to_subdivision_id)
 WHERE to_subdivision_id IN (SELECT bat FROM hall);
UPDATE document
   SET from_subdivision_id = (SELECT hall FROM hall WHERE bat = document.from_subdivision_id)
 WHERE from_subdivision_id IN (SELECT bat FROM hall);
UPDATE instance_assignment
   SET subdivision_id = (SELECT hall FROM hall WHERE bat = instance_assignment.subdivision_id)
 WHERE subdivision_id IN (SELECT bat FROM hall);

-- МВО батальйону відповідав за це майно — відповідає й далі, уже як МВО їдальні.
INSERT INTO responsible(subdivision_id, person_id, valid_from, valid_to, note)
  SELECT h.hall, r.person_id, r.valid_from, r.valid_to,
         COALESCE(r.note || '; ', '') || 'відповідає й за майно батальйону, перенесене на їдальню'
    FROM responsible r JOIN hall h ON h.bat = r.subdivision_id
   WHERE NOT EXISTS (SELECT 1 FROM responsible x WHERE x.subdivision_id = h.hall);

DROP TABLE hall;
