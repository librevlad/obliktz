/* Облік ТЗ ПС — десктоп-застосунок над даними «Облік ТЗ 4.0».
 *
 * Розрахункове ядро повторює модель книги: три журнали документів зводяться
 * в один нормалізований реєстр проводок (одна сторона операції = один рядок),
 * а будь-який залишок — це сума проводок по коду й підрозділу до заданої дати.
 * Нічого не зберігається як «поточний залишок», тому цифри завжди відповідають
 * документам. Знищене майно числиться в обліку, доки не проведено акт списання.
 */
(() => {
  'use strict';

  const D = window.OBLIK_DATA;
  const LS = 'oblik-tz-ps-v1';

  // ------------------------------------------------------------------ утиліти
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtDate = (iso) => (iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '—');
  const fmtNum = (n, dash = '—') => (n === 0 || n == null ? dash : String(+(+n).toFixed(3)));
  const fmtMoney = (n) => (+n || 0).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Місцева дата, не UTC: з 00:00 до 03:00 за Києвом UTC-дата ще вчорашня, і
  // сьогоднішній документ програма вважала б датованим майбутнім.
  const today = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  };
  /** Рік дати поза межами обліку (1950–2100) — недописаний чи з зайвою цифрою; інакше 0. */
  const dateYearOdd = (iso) => {
    const y = +String(iso || '').slice(0, String(iso || '').indexOf('-', 1));
    return y >= 1950 && y <= 2100 ? 0 : y || 0;
  };
  const uid = () => 'u' + Math.random().toString(36).slice(2, 9);
  /** Українська множина: 1 позиція, 2 позиції, 5 позицій. */
  const plural = (n, one, few, many) => {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  };
  const cnt = (n, one, few, many) => n + ' ' + plural(n, one, few, many);
  /** Пошук однаковий на всіх екранах: без регістру, з однаковими апострофами
   *  («кип'ят» знаходить «Кип’ятильник»), і мають знайтися всі слова запиту
   *  («кухня 130» — кухню КП-130). */
  const normQ = (x) => String(x ?? '').toLowerCase().replace(/[’ʼ`´]/g, "'");
  const qWords = (q) => normQ(q).split(/\s+/).filter(Boolean);
  const hitAll = (words, ...fields) => {
    const hay = normQ(fields.join(' '));
    return words.every((w) => hay.includes(w));
  };
  /** Одиниці виміру, у яких кількість буває дробовою: кілограми, літри, метри.
   *  Штуки й комплекти — лише цілі: крок поля кількості в рядку документа. */
  const FRACTIONAL_UNITS = new Set(['кг', 'г', 'т', 'л', 'мл', 'м', 'см', 'мм', 'км', 'м2', 'м²', 'м3', 'м³', 'пог. м', 'пог.м']);
  const fractionalUnit = (it) => !!it && FRACTIONAL_UNITS.has(String(it.unit || '').trim().toLowerCase());
  // Інвентарний номер з бирки: «10201/057».
  const invQuery = (q) => { const m = String(q).trim().match(/^(\d{4,6})\s*\/\s*(\d{1,4})$/); return m ? [m[1], +m[2]] : null; };

  // База не читається (пошкоджений файл): data.js не завантажився, і D немає.
  // Замість помилки в консолі — екран із поясненням і копіями для відновлення.
  if (!D) { dataBroken(); return; }

  // --------------------------------------------------------------- модель даних
  // Номенклатура — з бази цілком: і те, що прийшло з паперів служби, і те, що
  // завели в програмі (`own` — щоб картка дозволяла правити саме своє).
  const items = D.items.map((r) => ({
    code: r[0], name: r[1], group: r[2], unit: r[3], price: r[4],
    cat: r[5], serial: r[6], chassis: r[7], year: r[8], nonrev: r[9], own: !!r[10], fes: r[11] || '',
    note: r[12] || '', old: r[13] || '', archived: r[14] || '', perRation: r[15] ?? null,
  }));
  const itemBy = new Map(items.map((i) => [i.code, i]));
  const groupName = new Map(D.groups);

  // КНИГИ ОБЛІКУ: ПОЧАТОК
  /** Дві книги обліку: ТЗ (техзасоби, обладнання, багаторазовий посуд) і ОП (посуд одноразового
   *  використання, миючі засоби, серветки). Позиція належить книзі своєї групи; «Номенклатура»,
   *  «Документи» й книги № 47/14 показують книгу `state.book`. */
  const BOOK_OF_GROUP = new Map((D.groups || []).map((g) => [g[0], g[2] || 'ТЗ']));
  const bookOfItem = (it) => (it && BOOK_OF_GROUP.get(it.group)) || 'ТЗ';
  const bookOf = (code) => bookOfItem(itemBy.get(String(code)));
  /** Чернетки документів — свої в кожної книги: прихід ТЗ і прихід посуду не змішуються. */
  const slotOf = (kind, book) => (book === 'ОП' ? kind + '@ОП' : kind);
  // КНИГИ ОБЛІКУ: КІНЕЦЬ

  // 2/ПРОД: ПОЧАТОК
  /** Вид контрагента за назвою — пропозиція, яку людина підтверджує: від нього залежить
   *  графа 2/прод приходу (військова частина — гр.14, постачальник — гр.12). */
  function partyGuess(name) {
    const s = String(name || '').trim();
    if (/(^|[\s/])А\d{4}\b/.test(s) || /^в\/ч/i.test(s)) return 'військова частина';
    if (/^(ТОВ|ФОП|ПП|ПрАТ|АТ)[\s"«]/.test(s)) return 'постачальник';
    if (/^(БО|БФ|ГО|МБФ)[\s"«]/.test(s)) return 'фонд';
    return 'інше';
  }
  /** Прив'язки кодів до рядків 2/Прод: з бази (D.form2Map) і правки сторінки поверх. */
  function form2MapNow() {
    const out = new Map();
    for (const [code, row, factor, checked, checkedOn, skip] of D.form2Map || []) {
      out.set(String(code), { code: String(code), row, factor: factor || 1, checked: checked || null,
        checkedOn: checkedOn || null, skip: skip || null });
    }
    for (const [code, e] of Object.entries(store.form2Map || {})) {
      if (e.row == null && !e.skip) { out.delete(code); continue; }
      out.set(code, Object.assign({ code }, e));
    }
    return [...out.values()];
  }
  // 2/ПРОД: КІНЕЦЬ
  const tzItems = () => items.filter((i) => bookOfItem(i) === 'ТЗ');
  /** Де документ у ФЕС. Перелік — книги ОП; той самий у документів закупівель. */
  const FES_STATUSES = ['немає витяга', 'на підписі', 'їде на ФЕС', 'проведено', 'переробка'];

  /** Вид обліку позиції: необоротний актив (субрахунки 10/11 — основні засоби
   *  й інші необоротні матеріальні активи) чи запаси (15/18). Вирішує
   *  фінансовий орган: де в базі є бухгалтерський номер ФЕС, ознаку взято з
   *  нього; де його немає — вона з паперів служби й потребує підтвердження. */
  const ASSET = {
    na: ['НА', 'необоротний актив', 'необоротні активи (субрахунки 10/11)'],
    stock: ['запаси', 'запаси', 'запаси (субрахунки 15/18)'],
  };
  const assetOf = (i) => (i.nonrev ? 'na' : 'stock');
  const assetSure = (i) => !!i.fes;
  const assetTag = (i) => `<span class="tag tag--${assetOf(i)}${assetSure(i) ? '' : ' tag--unsure'}" title="${
    ASSET[assetOf(i)][2]}${assetSure(i) ? `, ФЕС № ${esc(i.fes)}` : ', не підтверджено ФЕС'}">${
    ASSET[assetOf(i)][0]}</span>`;

  // Закритий підрозділ (скажімо, батальйон після переформування) лишається в історії,
  // журналах і картках, але для нових документів і призначень його не обирають.
  //
  // Структура частини змінюється: підрозділи створюють, закривають, перейменовують.
  // Тому дерево не застигле — воно збирається з довідника (база + внесене в
  // програмі) щоразу наново, а глибина, порядок обходу й шлях до кореня
  // рахуються тут, а не зберігаються.
  const SUB_KINDS = ['бригада', 'батальйон', 'рота', 'взвод/відділення', 'склад', 'служба'];
  const baseSub = (r) => ({ id: r[8], name: r[0], parent: r[1], type: r[2],
    active: r[6] !== false, note: r[7] || '' });
  const baseOrder = new Map(D.subs.map((r, i) => [r[0], i]));
  /** Скільки записів бази, яких програма не показує (інші назви з паперів, люди,
   *  місця), тримають підрозділ — його база не видалить. */
  const baseRefs = new Map(D.subs.map((r) => [r[0], +r[9] || 0]));
  const baseUsed = new Map(D.subs.map((r) => [r[0], !!r[5]]));
  const subs = [];
  const subBy = new Map();
  /** Перезібрати дерево з записів довідника. `mine` — назви, згадані у внесених
   *  даних: підрозділ, доданий у програмі, вважається задіяним, щойно на нього
   *  склали перший документ. */
  function rebuildSubs(recs, mine = null) {
    const byName = new Map();
    const list = [];
    for (const r of (recs || [])) {
      const name = String(r.name || '').trim();
      if (!name || byName.has(name)) continue;
      const s = Object.assign({}, r, { name, parent: String(r.parent || '').trim(),
        type: r.type || 'підрозділ', active: r.active !== false, note: r.note || '',
        depth: 0, order: 0, path: [name] });
      byName.set(name, s);
      list.push(s);
    }
    const kids = new Map();
    const roots = [];
    for (const s of list) {
      if (s.parent === s.name || !byName.has(s.parent)) s.parent = '';
      if (!s.parent) { roots.push(s); continue; }
      if (!kids.has(s.parent)) kids.set(s.parent, []);
      kids.get(s.parent).push(s);
    }
    // Базові вузли лишаються в порядку бази, дописані в програмі — за назвою
    // після них: так дерево не переставляється від жодної правки.
    const rank = (s) => (baseOrder.has(s.name) ? baseOrder.get(s.name) : 1e6);
    const cmp = (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'uk');
    const out = [];
    const seen = new Set();
    const walk = (s, depth, path) => {
      if (seen.has(s.name)) return;              // захист від кільця в батьках
      seen.add(s.name);
      s.depth = depth;
      s.path = path.concat([s.name]);
      s.order = out.length;
      out.push(s);
      (kids.get(s.name) || []).sort(cmp).forEach((k) => walk(k, depth + 1, s.path));
    };
    roots.sort(cmp).forEach((s) => walk(s, 0, []));
    for (const s of list) if (!seen.has(s.name)) { s.parent = ''; walk(s, 0, []); }
    for (const s of out) s.used = !!baseUsed.get(s.name) || !!(mine && mine.has(s.name));
    subs.length = 0;
    subs.push(...out);
    subBy.clear();
    for (const s of out) subBy.set(s.name, s);
    return subs;
  }
  rebuildSubs(D.subs.map(baseSub));
  /** Корінь дерева — бригада: звідси рахується «уся бригада» в зведеннях. */
  const rootName = () => (subs[0] || {}).name || (D.subs[0] || [''])[0];
  /** Підрозділи для вибору: чинні, а закритий — лише якщо він уже обраний
   *  (виправлення старого документа) або якщо вносять історію: старі документи
   *  йшли на батальйони, яких сьогодні вже немає. */
  const pickableSubs = (sel) => subs.filter((s) => s.active || s.name === sel || histOn());
  const inSubtree = (node, sub) => (subBy.get(sub)?.path || []).includes(node);

  // Штат із бази: норма стоїть на табельному рядку форми, а не на коді служби —
  // «кухні причіпні КП-130(130М)» це один рядок штату й кілька кодів в
  // обліку. Тому наявність під норму збирається за переліком кодів рядка.
  const baseNorm = (r) => ({ id: r[9], form: r[0] || '', line: r[1] || '', sub: r[2],
    qty: r[3], from: r[4] || '', to: r[5] || '', codes: r[6] || [], basis: r[7] || '',
    code: r[8] || '', ...(r[10] ? { note: r[10] } : {}) });
  /** Норми, чинні на дату: і табельні, і на код служби — один перелік із бази. */
  const staffAt = (date) => normsInit().filter((n) => n.line && openOn(n, date));
  // Табельні позиції форм із кодами служби — і ті, під які штату немає: заміною
  // можуть іти й вони (польові печі за переносні кухні).
  const reportLines = (D.lines || []).map((r) => ({ form: r[0], line: r[1], section: r[2], codes: r[3] || [] }));
  const lineCodes = new Map(reportLines.map((l) => [l.form + '|' + l.line, l.codes]));
  /** Табельні форми, за якими є штат (21/Прод, 3/Прод). І перевірка, і
   *  перелік беруться з норм на льоту, бо норми правляться в програмі;
   *  перелік потрібен «Замінам у штаті» — без ітератора та сторінка падала. */
  // Табелі до штату є штатними формами й без жодної норми: інакше в базі без штату
  // рядків табеля не було б де показати, і перший штат не було б куди вписати.
  const STAFF_FORMS = ['21/Прод', '3/Прод'].filter((f) => reportLines.some((l) => l.form === f));
  const staffForms = {
    has: (form) => STAFF_FORMS.includes(form) || normsInit().some((n) => n.line && n.form === form),
    [Symbol.iterator]: () => new Set(STAFF_FORMS.concat(normsInit().filter((n) => n.line).map((n) => n.form)))[Symbol.iterator](),
  };

  // Інвентарні номери: у базі по одному на одиницю, сюди приходять діапазонами.
  const inventory = (D.inventory || []).map((r) => ({
    code: r[0], sub: r[1], from: r[2], to: r[3],
  }));
  const invNo = (code, seq) => code + '/' + String(seq).padStart(3, '0');
  // Скани первинних документів із бази — за записом документа: папери з
  // однаковими датою й номером (акт приймання на два підрозділи, кілька «б/н»
  // того самого дня) мають кожен свої скани.
  const scans = new Map();
  const docScans = new Map();
  for (const r of (D.scans || [])) {
    const f = { file: r[2], path: r[3], mime: r[4], size: r[5] };
    if (r[6]) {
      if (!docScans.has(r[6])) docScans.set(r[6], []);
      docScans.get(r[6]).push(f);
      continue;
    }
    const k = r[0] + '|' + String(r[1]).trim();
    if (!scans.has(k)) scans.set(k, []);
    scans.get(k).push(f);
  }
  // Фото й документи до майна з бази: до позиції («item|код») або до окремої
  // одиниці за заводським номером («unit|код|зав.№») — шильдики, паспорти.
  for (const r of (D.nomenFiles || [])) {
    const k = r[1] ? `unit|${r[0]}|${r[1]}` : `item|${r[0]}`;
    if (!scans.has(k)) scans.set(k, []);
    scans.get(k).push({ file: r[2], path: r[3], mime: r[4], size: r[5], kind: r[6] });
  }
  /** Після виправлення дати, номера чи сторін скани йдуть за документом: у
   *  базі вони прив'язані до запису, а підшиті тут — до ключа документа. Давні,
   *  підшиті до «дата|номер», переходять лише тоді, коли інших документів із цими
   *  датою й номером немає: чиїми вони були, інакше не вгадати. */
  function rekeyScans(oldKey, newKey) {
    if (oldKey === newKey) return;
    const [, d, no] = oldKey.split('|');
    const [, nd, nno] = newKey.split('|');
    const legacy = d + '|' + no;
    const shared = docs.some((r) => r.d === d && String(r.no).trim() === no
      && keyOfRow(r) !== oldKey && keyOfRow(r) !== newKey);
    for (const x of (store.scans || [])) {
      if (x.key === oldKey || (x.key === legacy && !shared)) Object.assign(x, { key: newKey, date: nd, no: nno });
    }
  }
  /** Id записів бази за ключем документа (близнюки з однаковою шапкою — один
   *  документ застосунку, кілька записів). Перелік будується раз на `docs`. */
  let docIdCache = { docs: null, map: new Map() };
  function idsOfDoc(key) {
    if (docIdCache.docs !== docs) {
      const map = new Map();
      for (const r of docs) {
        if (!r.id) continue;
        const k = keyOfRow(r);
        if (!map.has(k)) map.set(k, new Set());
        map.get(k).add(r.id);
      }
      docIdCache = { docs, map };
    }
    return [...(docIdCache.map.get(key) || [])];
  }
  const DOC_FILE_KEY = /^(in|mv|wr)\|(\d{4}-\d{2}-\d{2})\|([^|]*)\|/;
  /** Скани документа: з бази й підшиті в програмі (вони — у внесених даних). */
  const scansOf = (r) => filesOf(keyOfRow(r));

  const instances = (D.instances || []).map((r) => ({
    code: r[0], inv: r[1], serial: r[2], chassis: r[3], year: r[4],
    cat: r[5], holder: r[6], note: r[7], id: r[8] || 0,
  }));
  const unitBy = new Map(instances.filter((u) => u.id).map((u) => [String(u.id), u]));
  /** Категорія одиниці на дату — з історії станів: торішня накладна друкується
   *  з тією категорією, що була тоді. Раніше за перший запис — невідома. */
  const unitCats = new Map();
  for (const r of (D.unitCats || [])) {
    if (!unitCats.has(String(r[0]))) unitCats.set(String(r[0]), []);
    unitCats.get(String(r[0])).push([r[1], r[2]]);
  }
  const catAt = (u, date) => (unitCats.get(String(u.id)) || []).reduce((c, [d, x]) => (d <= date ? x : c), '') || '';
  /** Примітка самого документа з бази: яка первинка є в службі («Оригінал»,
   *  «Копія»), звідки залишки. Одна на документ, окремо від приміток рядків. */
  const docNotes = new Map((D.docNotes || []).map((r) => [r[0], r[1]]));
  /** «зав. № …» — як одиницю називають у накладній. Без заводського номера
   *  лишається шасі, без нього — інвентарний номер із бирки. */
  const unitLabel = (u) => (!u ? '' : u.serial ? `зав. № ${u.serial}`
    : u.chassis ? `шасі № ${u.chassis}` : u.inv ? `бирка ${u.inv}` : '');

  // ------------------------------------------------------- користувацькі дані
  // У десктоп-режимі стан лежить у файлі поруч із програмою (його видно, можна
  // покласти в резервну копію). У браузері — у localStorage цього ж комп'ютера.
  const store = { norms: [], docs: { incoming: [], movement: [], writeoffs: [] }, destroyed: [], items: [],
                  recon: [], subst: [], scans: [], units: [], ui: {} };
  let native = false;
  /** Файл стану є, але прочитати його не вдалося. Тоді програма нічого не
   *  записує, доки дані не відновлять із копії: інакше перше ж збереження
   *  затерло б пошкоджений файл порожнім станом. */
  let stateBroken = null;
  /** Версія файла стану, з якою працює це вікно; сервер не прийме запис, якщо
   *  файл тим часом змінило інше вікно. */
  let stateVersion = null;
  let stateConflict = false;
  /** Хто працює в цьому вікні: ім'я для журналу змін, з іншого ПК (remote) чи на
   *  основному; основному ПК — ще й налаштування роботи в мережі (net). */
  let me = { name: '', remote: false, net: null };
  async function meLoad() {
    try {
      const r = await fetch('api/me', { cache: 'no-store' });
      if (r.ok) me = Object.assign({ name: '', remote: false, net: null }, await r.json());
    } catch (e) { /* не десктоп-режим */ }
    try {
      const r = await fetch('api/version', { cache: 'no-store' });
      if (r.ok) sync.last = await r.json();
    } catch (e) { /* ignore */ }
  }

  async function loadState() {
    try {
      const r = await fetch('api/state', { cache: 'no-store' });
      if (r.ok) {
        stateVersion = r.headers.get('X-State-Version');
        const j = await r.json();
        if (j && typeof j === 'object') { Object.assign(store, j); native = true; await meLoad(); return; }
      } else if (r.status === 401) {
        // Перепустка з іншого ПК більше не діє (новий код доступу): сторінка входу.
        location.reload();
        await new Promise(() => {});
      } else if (r.status === 500) {
        native = true;
        stateBroken = (await r.text()) || 'файл стану не читається';
        return;
      }
    } catch (e) { /* не десктоп-режим — працюємо через localStorage */ }
    try { Object.assign(store, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------ збереження
  /** Серія правок дає один запис (затримка 300 мс). Запис, що не вдався
   *  (сервер програми зупинився, диск повний, файл зайнятий), не мовчить:
   *  зверху з'являється червона смуга, програма повторює спробу, а закрити
   *  вікно з незбереженими змінами не дасть попередження браузера. Записи йдуть
   *  по черзі — старіший стан не може лягти поверх новішого. */
  const saving = { timer: null, retry: null, dirty: false, failed: false, busy: null, again: false };

  /** backup=true — перед незворотною дією: сервер зробить копію попереднього
   *  стану незалежно від того, коли була остання. */
  function save(now = false, backup = false) {
    saving.dirty = true;
    if (backup) saving.backup = true;
    clearTimeout(saving.timer);
    saving.timer = setTimeout(flush, now || backup ? 0 : 300);
  }
  /** Запис одразу, а слово про нього — лише після того, як його прийнято. */
  async function saveThen(text) {
    save(true);
    if (await flush() === true) toast(text);
  }

  /** Id документів, які щойно лягли в базу. Без них виправлення щойно проведеного
   *  документа переписувало б його наново: запис у базі зникав і з'являвся інший,
   *  а видачі з його партій переходили на чужу партію. */
  function adoptIds(ids) {
    const KIND_OF_JOURNAL = { incoming: 'in', movement: 'mv', writeoffs: 'wr' };
    const want = new Map(ids.map((x) => [x.slice(0, 5).join('\u0000'), x[5]]));
    let hit = false;
    for (const [journal, kind] of Object.entries(KIND_OF_JOURNAL)) {
      for (const r of (store.docs || {})[journal] || []) {
        if (rowId(kind, r)) continue;
        const key = [journal, r[0], String(r[2]).trim(), r[3] || '', r[4] || ''].join('\u0000');
        const id = want.get(key);
        if (!id) continue;
        while (r.length < TAIL_AT[kind] + 1) r.push('');
        r[TAIL_AT[kind] + 1] = id;
        r[TAIL_AT[kind] + 2] = r[TAIL_AT[kind] + 2] || 'program';
        hit = true;
      }
    }
    if (hit) { docs = buildDocs(); allocateLots(); }
  }

  /** Id щойно заведених одиниць реєстру: одиниця стає записом бази, і далі її
   *  можна назвати в приході, а повторний запис не заведе її вдруге. */
  function adoptUnits(map) {
    let hit = false;
    for (const [tmp, id] of Object.entries(map)) {
      const real = String(id);
      if (!id || tmp === real) continue;
      for (const r of store.units || []) if (String(r.id) === tmp) r.id = real;
      const u = unitBy.get(tmp);
      if (u) { u.id = real; unitBy.delete(tmp); unitBy.set(real, u); }
      if (unitCats.has(tmp)) { unitCats.set(real, unitCats.get(tmp)); unitCats.delete(tmp); }
      for (const [journal, kind] of [['incoming', 'in'], ['movement', 'mv'], ['writeoffs', 'wr']]) {
        for (const r of (store.docs || {})[journal] || []) {
          if (String(rowUnit(kind, r)) === tmp) r[TAIL_AT[kind] + 3] = +real;
        }
      }
      for (const x of store.destroyed || []) if (String(x.unit || '') === tmp) x.unit = real;
      if (state.unitEdit && String(state.unitEdit.id) === tmp) state.unitEdit.id = real;
      hit = true;
    }
    if (hit) { unitCache.key = null; docs = buildDocs(); allocateLots(); }
  }

  /** Id щойно записаних рапортів: запис про знищення стає рядком документа
   *  бази, і виправлення рапорту правитиме той самий документ, а скан,
   *  підшитий до ще не записаного рапорту, переходить під ключ документа. */
  function adoptReports(map) {
    let hit = false;
    for (const x of store.destroyed || []) {
      const got = map[String(x.id)];
      if (!Array.isArray(got)) continue;
      const was = reportKey(x);
      x.docId = got[0];
      if (got[2] === 'other') x.otherId = got[1]; else x.lineId = got[1];
      const now = reportKey(x);
      for (const f of store.scans || []) if (f.key === was && was !== now) f.key = now;
      hit = true;
    }
    if (hit) dzCache = null;
  }

  /** Рядок вибуття старого вигляду — без поля «кому» (код п'ятим полем) — у
   *  вигляді решти журналів: одержувач порожній. */
  const wrRow = (r) => (Array.isArray(r) && r.length > 5 && typeof r[5] === 'number'
    ? r.slice(0, 4).concat([''], r.slice(4)) : r);

  /** Стан попередніх версій — у теперішньому вигляді. Номери актів до рапортів
   *  і виправлення рапортів із бази тепер лежать у самих рапортах: окремих мап
   *  більше немає (їх уже розклала база). */
  function normalizeStore() {
    store.docs = store.docs || { incoming: [], movement: [], writeoffs: [] };
    store.docs.writeoffs = (store.docs.writeoffs || []).map(wrRow);
    if (!Array.isArray(store.destroyed)) store.destroyed = [];
    delete store.dzActs;
    delete store.reportFix;
  }

  /** Копія зроблена теперішньою версією: рядки документів і записи про
   *  знищення несуть походження. Старі копії тримали лише внесене в програмі. */
  function copyHasOrigin(j) {
    // Походження має бути записане в самому рядку: rowOrigin підставляє
    // 'program' там, де поля немає, і копія старого формату виглядала повною —
    // імпорт затирав документи з паперових журналів.
    const KINDS = { incoming: 'in', movement: 'mv', writeoffs: 'wr' };
    return Object.entries(KINDS).some(([jn, k]) => (j.docs[jn] || []).some((r) => {
      const row = jn === 'writeoffs' ? wrRow(r) : r;
      const o = Array.isArray(row) ? row[TAIL_AT[k] + 2] : '';
      return o === 'seed' || o === 'program';
    })) || (Array.isArray(j.destroyed) && j.destroyed.some((x) => x && x.origin));
  }

  function saveBar(text) {
    let bar = $('#save-bar');
    if (!text) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'save-bar';
      bar.className = 'save-bar';
      document.body.appendChild(bar);
    }
    bar.textContent = text;
  }

  async function flush() {
    clearTimeout(saving.timer);
    if (sync.leaving) return false;          // вікно саме оновлюється: правки відкладено
    if (saving.busy) { saving.again = true; return saving.busy; }
    if (!saving.dirty) return true;
    if (stateBroken) {
      saveBar('Зміни не записуються: файл даних пошкоджено. Відновіть дані з копії: ⚙ → «Автоматичні копії…».');
      return false;
    }
    if (stateConflict) return false;
    saving.dirty = false;
    // Порожня картка людини («+ Нова людина», і пішли далі) — не запис
    // довідника: у базу вона не йде, якщо її не заповнили й ніде не згадано.
    if (Array.isArray(store.people)) {
      store.people = store.people.filter((p) => p.id === state.personId || !blankPerson(p) || personUses(p.id));
    }
    // Змінилися лише налаштування цього вікна (чернетка, оформлення) — вони пишуться
    // окремо: без звірки з чужими записами, і інші вікна через них не оновлюються.
    const shared = native ? syncShared() : '';
    const uiOnly = native && sync.base !== null && shared === sync.base && !saving.backup && !saving.papers;
    const body = uiOnly ? '' : JSON.stringify(store);
    saving.busy = (async () => {
      if (!native) {
        try { localStorage.setItem(LS, body); return true; } catch (e) { return 'у браузері забракло місця для даних'; }
      }
      if (uiOnly) return syncPutUi();
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (stateVersion) headers['X-State-Version'] = stateVersion;
        const backup = saving.backup;
        // Прохання про копію перед записом знімається одразу: сервер робить її
        // сам, а повторне прохання без змін у базі копії не плодить. Не пройшов
        // запис — прохання повертається на наступну спробу, інакше видалення
        // повторилося б уже без копії. Прохання, що надійшло під час запису
        // (видалили ще щось), лишається на свою чергу.
        saving.backup = false;
        // Відновлення з файла несе документи служби такими, якими вони були в копії: сервер
        // замінює їх разом із затвердженими версіями, а не звіряє з теперішніми.
        const papers = saving.papers;
        saving.papers = false;
        const query = [backup ? 'backup=1' : '', papers ? 'papers=replace' : ''].filter(Boolean).join('&');
        let res;
        try {
          const r = await fetch('api/state' + (query ? `?${query}` : ''), { method: 'PUT', headers, body });
          if (r.status === 409) res = 'conflict';
          else if (r.status === 401) res = 'login';
          else if (r.status === 422) res = { refused: (await r.text()) || 'база не прийняла запис' };
          else if (!r.ok) res = (await r.text()) || `помилка ${r.status}`;
          else {
            const j = await r.json().catch(() => ({}));
            if (j.version) stateVersion = j.version;
            sync.base = shared;
            if (Array.isArray(j.ids)) adoptIds(j.ids);
            if (j.units && typeof j.units === 'object') adoptUnits(j.units);
            if (j.reports && typeof j.reports === 'object') adoptReports(j.reports);
            // Id, які щойно дала база, — теж її стан: інакше наступне злиття вважало б
            // їх правками вікна. Правки, внесені поки йшов запис, лишаються правками.
            if (!saving.dirty) sync.base = syncShared();
            syncTriesSet(0);
            res = true;
          }
        } catch (e) {
          res = 'програма не відповідає';
        }
        if (res !== true && backup) saving.backup = true;
        if (res !== true && papers) saving.papers = true;
        return res;
      } catch (e) {
        return 'програма не відповідає';
      }
    })();
    const res = await saving.busy;
    saving.busy = null;
    if (res && res.refused) {
      // База не прийняла запис через дані (строки, що перекриваються, дві записи
      // на ту саму дату). Повтор нічого не змінить: кажемо, що виправити, а все
      // внесене запишеться разом із наступною правкою.
      saving.dirty = true;
      saving.failed = true;
      saveBar(`Зміни НЕ записано: ${res.refused}. Виправте це — усе внесене запишеться з наступною зміною.`);
      return false;
    }
    if (res === 'conflict' || res === 'login') {
      // Інше вікно (чи інша людина) вже записало свіжіші дані: наш запис їх затер би.
      // Вікно бере свіжі дані й накладає на них лише свої правки. Не вийшло й утретє —
      // далі не пише нічого, лише каже, що робити.
      saving.dirty = true;
      if (syncLeave(res)) return false;
      if (res === 'login') {
        saving.failed = true;
        saveBar('Зміни НЕ записано: потрібно ввійти знову. Оновіть сторінку (F5) і впишіть ім’я та код доступу.');
        return false;
      }
      stateConflict = true;
      saveBar('Дані змінено в іншому вікні програми. Це вікно більше не зберігає зміни. '
        + 'Закрийте його або перезавантажте (F5).');
      return false;
    }
    if (res === true) {
      if (saving.failed) toast('Зміни збережено.');
      saving.failed = false;
      saveBar('');
    } else {
      saving.dirty = true;
      saving.failed = true;
      saveBar(me.remote
        ? `Зміни НЕ записано (${res}). Програма повторює спробу кожні 5 секунд. Не закривайте вікно: `
          + 'перевірте, що основний ПК увімкнений і програма на ньому відкрита.'
        : `Зміни НЕ записано у файл (${res}). Програма повторює спробу кожні 5 секунд. `
          + 'Не закривайте вікно. Якщо смуга не зникає — ⚙ → «Зберегти копію бази…»: незаписане програма '
          + 'збереже окремим файлом.');
      clearTimeout(saving.retry);
      saving.retry = setTimeout(flush, 5000);
    }
    if (saving.again) { saving.again = false; if (saving.dirty) return flush(); }
    return res === true;
  }

  // ------------------------------------------------ робота кількох людей
  /* Програма й база — на основному ПК; інші люди працюють з неї в браузері по мережі.
     Вікно записує стан обліку цілком, тож запис вікна, яке не бачило чужих змін, затер
     би їх. Тому вікно пам'ятає, з якими даними почало (sync.base), і коли сервер каже
     «тим часом записав хтось інший», бере свіжі дані, накладає на них лише свої правки
     й записує знову. Зливаються записи: документ, людина, позиція, скан. Той самий
     запис правили обоє — лишається правка того, хто записав пізніше, і він бачить про
     це слово. Вікно, у якому нічого не вносять, саме підтягує чужі зміни. */

  // ЗЛИТТЯ: ПОЧАТОК — чисті функції без стану вікна (їх перевіряють окремо).
  /** Розділи самого вікна: налаштування людини й разове прохання видати номери. */
  const SYNC_OWN = new Set(['ui', 'invIssue']);
  /** Ключ запису там, де записи без id. Журнал змін і переміщення номерів лише
   *  доповнюються — запис сам собі ключ. */
  const SYNC_KEYS = {
    items: (r) => String(r.code),
    scans: (r) => `${r.key}|${r.path}`,
    ownLines: (r) => `${r.form}|${String(r.name || '').trim()}`,
    log: (r) => JSON.stringify(r),
    invMoves: (r) => JSON.stringify(r),
  };
  /** Документ — усі його рядки разом: за id документа бази (поле за хвостом рядка,
   *  TAIL_AT + 1), а в ще не записаного — за датою, номером і маршрутом. */
  const syncDocKey = (r) => (r[10] ? `id:${r[10]}`
    : `k:${[r[0], String(r[2]).trim(), r[3] || '', r[4] || ''].join('|')}`);
  const syncPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const syncSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const syncKeyBy = (by) => (by === 'docs' ? syncDocKey : by === 'id' ? (r) => String(r.id) : SYNC_KEYS[by]);

  /** Як ключувати перелік: 'docs', назва розділу, 'id' або '' — перелік береться цілком. */
  function syncBy(path, list) {
    if (path.length === 2 && path[0] === 'docs') return 'docs';
    if (path.length === 1 && SYNC_KEYS[path[0]]) return path[0];
    if (list.length && list.every((r) => syncPlain(r) && r.id != null && r.id !== '')) return 'id';
    return '';
  }
  function syncGroup(list, key) {
    const out = new Map();
    for (const r of list) {
      const k = key(r);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(r);
    }
    return out;
  }

  /** Правки вікна: що змінилося від даних, з якими воно почало (base), до теперішніх. */
  function syncDiff(base, cur, path = []) {
    const ops = [];
    const keys = new Set(Object.keys(base || {}).concat(Object.keys(cur || {})));
    for (const k of keys) {
      const b = (base || {})[k], c = (cur || {})[k], p = path.concat([k]);
      if (syncSame(b, c)) continue;
      if (!path.length && SYNC_OWN.has(k)) { ops.push({ p, own: 1, now: c }); continue; }
      if ((syncPlain(b) || b === undefined) && (syncPlain(c) || c === undefined)) {
        ops.push(...syncDiff(b, c, p));
        continue;
      }
      const by = (Array.isArray(b) || b === undefined) && (Array.isArray(c) || c === undefined)
        ? syncBy(p, (b || []).concat(c || [])) : '';
      if (by) {
        const key = syncKeyBy(by);
        const gb = syncGroup(b || [], key), gc = syncGroup(c || [], key);
        for (const id of new Set([...gb.keys(), ...gc.keys()])) {
          const was = gb.get(id) || null, now = gc.get(id) || null;
          if (!syncSame(was, now)) ops.push({ p, by, id, was, now });
        }
        continue;
      }
      ops.push({ p, was: b, now: c });
    }
    return ops;
  }

  /** Накласти правки вікна на свіжі дані. Повертає правки, де той самий запис тим часом
   *  змінив хтось інший (лишається правка вікна). */
  function syncApply(theirs, ops) {
    const clashes = [];
    for (const op of ops) {
      let at = theirs;
      for (const k of op.p.slice(0, -1)) {
        if (!syncPlain(at[k])) {
          if (op.now === undefined || op.now === null) { at = null; break; }
          at[k] = {};
        }
        at = at[k];
      }
      if (!at) continue;
      const k = op.p[op.p.length - 1];
      if (op.own) {
        if (op.now === undefined) delete at[k]; else at[k] = op.now;
        continue;
      }
      if (op.by) {
        const key = syncKeyBy(op.by);
        if (!Array.isArray(at[k])) at[k] = [];
        const list = at[k];
        const idx = [];
        list.forEach((r, i) => { if (key(r) === op.id) idx.push(i); });
        const have = idx.length ? idx.map((i) => list[i]) : null;
        if (!syncSame(have, op.was) && !syncSame(have, op.now)) clashes.push(op);
        const pos = idx.length ? idx[0] : list.length;
        for (let i = idx.length - 1; i >= 0; i--) list.splice(idx[i], 1);
        if (op.now) list.splice(pos, 0, ...op.now);
        continue;
      }
      if (!syncSame(at[k], op.was) && !syncSame(at[k], op.now)) clashes.push(op);
      if (op.now === undefined) delete at[k]; else at[k] = op.now;
    }
    return clashes;
  }
  // ЗЛИТТЯ: КІНЕЦЬ

  /** base — спільні дані (без налаштувань вікна) такими, якими їх востаннє бачила база;
   *  leaving — вікно саме перезавантажується; last — хто й коли записав останнім. */
  const sync = { base: null, leaving: false, touched: Date.now(), last: null, note: '' };
  const SYNC_PACK = 'oblik.sync', SYNC_TRIES = 'oblik.sync.tries';
  /** Спільні дані вікна одним рядком: без налаштувань вікна й без порожніх розділів — база
   *  порожніх розділів не віддає, а сторінка заводить їх, щойно до них дійшла. */
  function syncShared() {
    const out = {};
    for (const [k, v] of Object.entries(store)) {
      if (k === 'ui' || v === undefined || (Array.isArray(v) ? !v.length : syncPlain(v) && !Object.keys(v).length)) continue;
      out[k] = v;
    }
    return JSON.stringify(out);
  }
  function syncTriesGet() {
    try { return +(sessionStorage.getItem(SYNC_TRIES) || 0); } catch (e) { return 99; }
  }
  function syncTriesSet(n) {
    try { if (n) sessionStorage.setItem(SYNC_TRIES, String(n)); else sessionStorage.removeItem(SYNC_TRIES); } catch (e) { /* ignore */ }
  }
  /** Що з екрана повернути після оновлення: розділ, відкрита картка, фільтри, прокрутка.
   *  Форми й чернетки сюди не йдуть — чернетки й так лежать у налаштуваннях вікна. */
  const SYNC_VIEW = ['view', 'asOf', 'q', 'group', 'sub', 'onlyShort', 'onlyMine', 'noScan', 'assetF', 'subAsset',
    'subHolder', 'subFilterFor', 'stId', 'stSub', 'mtzMonth', 'peopleTab', 'personId', 'movesKindF', 'staffForm',
    'movesFrom', 'movesTo', 'movesLimit', 'itemCode', 'reconDate', 'reconId', 'j14sub', 'j14page', 'j47code',
    'moveKind', 'docKey', 'docBack', 'subName', 'paperId', 'paperVer', 'staffAll', 'normTerms', 'purCut', 'purFold',
    'paperHist', 'staffOpen', 'sort', 'tf'];
  function syncView() {
    const v = {};
    for (const k of SYNC_VIEW) {
      if (!(k in state)) continue;
      try { v[k] = JSON.parse(JSON.stringify(state[k] === undefined ? null : state[k])); } catch (e) { /* ignore */ }
    }
    const sc = $('#scroll'), tb = sc && sc.querySelector('.card--fill');
    return { state: v, scroll: { page: sc ? sc.scrollTop : 0, table: tb ? tb.scrollTop : 0 } };
  }
  const SYNC_PART = { docs: 'документи', people: 'люди', items: 'номенклатура', destroyed: 'знищене', scans: 'скани',
    recon: 'звірки', inventories: 'інвентаризації', mtz: 'відомість МТЗ', subs: 'підрозділи', norms: 'штат',
    units: 'одиниці', papers: 'документи служби', mvo: 'посадові особи', cmdrs: 'посадові особи',
    officials: 'посадові особи', locations: 'дислокація', unit: 'реквізити', subst: 'заміни',
    ownLines: 'форма 21/Прод', lineCodes: 'форма 21/Прод', docFes: 'статус ФЕС', docMeta: 'поля документів',
    form2Map: 'прив’язки 2/Прод', form2Own: 'рядки 2/Прод', form2Cells: '2/прод', form2Notes: 'записки 2/прод',
    parties: 'контрагенти', fesMap: 'звірка з ФЕС', fesPlaces: 'звірка з ФЕС' };
  /** «(Міша, 10:42)» — ім'я не відмінюється, тож стоїть у дужках. */
  const syncWho = (x) => { const t = [x && x.who, x && x.at].filter(Boolean).join(', '); return t ? ` (${t})` : ''; };

  async function syncPutUi() {
    try {
      const r = await fetch('api/ui', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(store.ui || {}) });
      if (r.status === 401) return 'login';
      return r.ok ? true : ((await r.text()) || `помилка ${r.status}`);
    } catch (e) {
      return 'програма не відповідає';
    }
  }

  /** Запис не прийнято: тим часом записав хтось інший (або треба ввійти знову). Правки
   *  вікна відкладаються, сторінка бере свіжі дані й накладає правки на них. */
  function syncLeave(reason) {
    const tries = syncTriesGet();
    if (sync.base === null || tries >= 3) return false;
    clearTimeout(draftTimer);
    keepDrafts();
    const ops = syncDiff(JSON.parse(sync.base), JSON.parse(syncShared()));
    ops.push({ p: ['ui'], own: 1, now: store.ui });
    try {
      sessionStorage.setItem(SYNC_PACK, JSON.stringify({ ops, view: syncView(), reason }));
      sessionStorage.setItem(SYNC_TRIES, String(tries + 1));
    } catch (e) {
      return false;
    }
    sync.leaving = true;
    clearTimeout(saving.timer);
    clearTimeout(saving.retry);
    saveBar(reason === 'login' ? 'Потрібно ввійти знову. Внесене не загубиться.'
      : 'Тим часом зміни записала інша людина. Програма поєднує їх із вашими…');
    location.reload();
    return true;
  }

  /** У вікні нічого не вносять, а хтось записав зміни — вікно підтягує їх. */
  function syncFresh(info) {
    try {
      sessionStorage.setItem(SYNC_PACK, JSON.stringify({ ops: [], view: syncView(), reason: 'fresh',
        who: info.who || '', at: info.at || '' }));
    } catch (e) {
      return;
    }
    sync.leaving = true;
    location.reload();
  }

  /** Відкладене перед оновленням — одразу після читання даних: налаштування вікна
   *  мають бути на місці до того, як із них підніматимуться чернетки. */
  function syncTake() {
    let pack = null;
    try {
      pack = JSON.parse(sessionStorage.getItem(SYNC_PACK) || 'null');
      sessionStorage.removeItem(SYNC_PACK);
    } catch (e) {
      pack = null;
    }
    if (!pack || !native || stateBroken) return null;
    const ui = (pack.ops || []).find((op) => op.own && op.p[0] === 'ui');
    if (ui && syncPlain(ui.now)) store.ui = ui.now;
    return pack;
  }

  /** Після того, як вікно розклало свіжі дані (люди, позиції, норми): це й є дані бази,
   *  з якими вікно почало. Відкладені правки лягають поверх і записуються. */
  function syncStart(pack) {
    if (!native || stateBroken) return;
    sync.base = syncShared();
    if (!pack) return;
    const ops = (pack.ops || []).filter((op) => !(op.own && op.p[0] === 'ui'));
    const clashes = syncApply(store, ops);
    if (ops.length) {
      mergeOwnItems();
      rebuildSubs(store.subs, subMentions());
      save(true);
    }
    const v = pack.view || {};
    for (const k of SYNC_VIEW) if (v.state && k in v.state) state[k] = v.state[k];
    if (v.scroll) { scrollMemo.set(screenKey(), v.scroll); state.restoreScroll = true; }
    if (pack.reason === 'fresh') {
      sync.note = `Оновлено: дані змінено в іншому вікні${syncWho(pack)}.`;
    } else if (ops.length) {
      const parts = [...new Set(clashes.map((op) => SYNC_PART[op.p[0]] || 'інше'))];
      sync.note = (pack.reason === 'login' ? 'Ви знову ввійшли — внесене записано.'
        : `Ваші зміни записано разом зі змінами, внесеними одночасно в іншому вікні${syncWho(sync.last)}.`)
        + (parts.length ? ` Той самий запис правили обоє (${parts.join(', ')}) — лишилася ваша правка.` : '');
    }
    sync.fresh = pack.reason === 'fresh';
  }

  /** Вікно вільне: людина нічого не набирає й не тримає відкритою форму чи вікно. */
  function syncIdle() {
    if (Date.now() - sync.touched < 5000) return false;
    if (saving.dirty || saving.busy || saving.failed) return false;
    const a = document.activeElement;
    if (a && a !== document.body && a.matches('input, textarea, select, [contenteditable="true"]')
      && !a.matches('#q, #as-of')) return false;
    if ($('#modal') || $('#palette') || formOpen()) return false;
    const pick = $('#pick-pop');
    if (pick && pick.style.display !== 'none' && pick.innerHTML) return false;
    for (const k of ['viewer', 'editingReport', 'newItem', 'assign', 'subNew', 'subRen', 'unitEdit', 'invMove', 'imp']) {
      if (state[k]) return false;
    }
    if (state.ownLineOpen) return false;
    return !String(window.getSelection ? window.getSelection() : '');
  }

  /** Раз на кілька секунд: чи не записав хтось інший. */
  function syncWatch() {
    if (!native || stateBroken) return;
    const touch = () => { sync.touched = Date.now(); };
    for (const ev of ['keydown', 'pointerdown', 'wheel']) document.addEventListener(ev, touch, { capture: true, passive: true });
    const tick = async () => {
      if (sync.leaving || stateConflict || document.hidden) return;
      const mine = stateVersion;
      let j = null;
      try {
        const r = await fetch('api/version', { cache: 'no-store' });
        if (r.ok) j = await r.json();
      } catch (e) {
        return;
      }
      if (!j || !j.version || !mine || mine !== stateVersion || j.version === stateVersion) return;
      if (saving.dirty || saving.busy) return;          // власний запис і так зіллється з чужим
      if (syncIdle()) syncFresh(j);
    };
    setInterval(tick, 4000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  }

  // ------------------------------------------------ чернетки документів
  /** Незавершений документ переживає і перемикання виду («Прихід» ↔
   *  «Переміщення»), і закрите вікно: чернетка кожного виду лежить окремо й
   *  зберігається разом з іншими даними. Документ, який саме виправляють, не
   *  зберігається — його оригінал і так в обліку. */
  /** `head.auto` — шапку підставила програма (номер, дата й маршрут наступного
   *  документа після проведення). Поки людина нічого не вписала, така форма не
   *  «незавершений документ»: після внесення пачки їх набиралося по одному на
   *  кожен вид, і «Потребує уваги» рахувало їх як недороблену роботу. */
  const hasContent = (d) => !!d && (d.lines.some((l) => l.code || String(l.name || '').trim() || String(l.qty || '').trim())
    || (!d.head.auto && (!!String(d.head.no || '').trim()
      || (d.kind === 'in' && !!String(d.head.from || '').trim())
      || !!String(d.head.basis || '').trim() || !!String(d.head.note || '').trim())));

  function keepDrafts() {
    if (state.editing) return;
    const all = Object.assign({}, state.drafts || {});
    if (state.draft) {
      if (hasContent(state.draft)) all[state.draft.kind] = state.draft;
      else delete all[state.draft.kind];
    }
    const keep = {};
    for (const [k, v] of Object.entries(all)) if (hasContent(v)) keep[k] = v;
    // Порівнюємо з тим, що вже записано, а не з живим об'єктом: чернетку правлять
    // на місці, і порівняння з нею самою ніколи не бачило б змін.
    const next = JSON.stringify(keep);
    if (next !== draftsSaved) {
      draftsSaved = next;
      store.ui.drafts = JSON.parse(next);
      save();
    }
  }
  let draftsSaved = '{}';
  let draftTimer = null;
  const keepDraftsSoon = () => { clearTimeout(draftTimer); draftTimer = setTimeout(keepDrafts, 500); };

  // --------------------------------------------------- нормалізований реєстр
  /** Одна сторона однієї операції. sg: +1 надходження, −1 вибуття. */
  function buildLedger() {
    const led = [];
    const push = (d, t, no, code, sub, cnt, sg, q, src, note) => {
      if (!sub || !code) return;
      led.push({ d, t, no, code, sub, cnt, sg, q: +q || 0, src, note: note || '' });
    };
    for (const r of store.docs.incoming)
      push(r[0], r[1], r[2], r[5], r[4], r[3], 1, r[6], 'in', r[7]);
    for (const r of store.docs.movement) {
      push(r[0], r[1], r[2], r[5], r[3], r[4], -1, r[6], 'mv', r[7]);
      push(r[0], r[1], r[2], r[5], r[4], r[3], 1, r[6], 'mv', r[7]);
    }
    // Вибуття: списання або передача в іншу частину (актом ПП) — з балансу
    // майно йде однаково; одержувач поза частиною — `cnt`.
    for (const r of store.docs.writeoffs)
      push(r[0], r[1], r[2], r[5], r[3], r[4] || '', -1, r[6], 'wr', r[7]);
    led.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    return led;
  }

  let ledger = [];

  /** Службовий хвіст рядка журналу: дата партії, id документа в базі,
   *  походження, а в рядка про одиницю із заводським номером — ще її id. Усі три
   *  журнали одного вигляду: [дата, папір, номер, від кого, кому, код, к-сть,
   *  примітка, ціна, …хвіст]; у вибутті «кому» — одержувач поза частиною. */
  const TAIL_AT = { in: 9, mv: 9, wr: 9 };
  const rowId = (kind, r) => r[TAIL_AT[kind] + 1] || 0;
  const rowOrigin = (kind, r) => r[TAIL_AT[kind] + 2] || 'program';
  const rowUnit = (kind, r) => r[TAIL_AT[kind] + 3] || '';
  /** Документні рядки (не проводки) — для журналів і стрічки операцій. */
  function buildDocs() {
    const out = [];
    // Усі документи — з паперових журналів служби й внесені тут — рівні: кожен
    // можна виправити чи видалити. `mine` — лише походження (внесено в
    // програмі): за ним є фільтр у стрічці й нагадування про скани паперу.
    // Останнє поле паперу — ціна з документа (0, якщо в папері її не було);
    // далі службовий хвіст: дата партії (з нею звірка знає, яка саме партія
    // поїхала), id документа в базі (виправлення знаходить свій запис) і походження.
    const inMv = (kind) => (r) => ({ d: r[0], t: r[1], no: r[2], from: r[3], to: r[4], code: r[5],
      q: r[6], kind, note: r[7], price: +r[8] || 0, lot: r[9] || '', id: rowId(kind, r),
      unit: rowUnit(kind, r), mine: rowOrigin(kind, r) !== 'seed' });
    for (const r of store.docs.incoming) out.push(inMv('in')(r));
    for (const r of store.docs.movement) out.push(inMv('mv')(r));
    for (const r of store.docs.writeoffs) out.push(inMv('wr')(r));
    out.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
    return out;
  }
  let docs = [];

  const state = {
    view: 'dash',
    book: 'ТЗ',
    subBook: 'ТЗ',
    asOf: today(),
    q: '',
    group: '',
    sub: '',
    onlyShort: false,
    onlyMine: false,
    noScan: false,
    assetF: '',
    subAsset: '',
    subHolder: '',
    subFilterFor: null,
    stId: null,
    stSub: '',
    mtzMonth: null,
    peopleTab: 'people',
    personId: null,
    assign: null,
    viewer: null,
    movesKindF: '',
    staffForm: '21/Прод',
    substDraft: { from: '', to: [] },
    movesFrom: '',
    movesTo: '',
    newItem: null,
    movesLimit: 200,
    editing: null,
    flash: null,
    draft: null,
    itemCode: null,
    reconDate: today(),
    reconId: null,
    j14sub: 'склад',
    j14page: 1,
    j47code: null,
    moveKind: 'mv',
    accent: store.ui.accent || '#3f5233',
    density: store.ui.density || 'dense',
  };

  // --------------------------------------------------------------- залишки
  /** Кеш зрізу на дату: "код|підрозділ" -> кількість. */
  let balCache = { key: null, map: null, byCode: null, bySub: null };
  function balances() {
    if (balCache.key === state.asOf) return balCache;
    const map = new Map(), byCode = new Map(), bySub = new Map();
    for (const e of ledger) {
      if (e.d > state.asOf) continue;
      const k = e.code + '|' + e.sub, v = e.sg * e.q;
      map.set(k, (map.get(k) || 0) + v);
      byCode.set(e.code, (byCode.get(e.code) || 0) + v);
      bySub.set(e.sub, (bySub.get(e.sub) || 0) + v);
    }
    balCache = { key: state.asOf, map, byCode, bySub };
    return balCache;
  }
  const balOf = (code, sub) => balances().map.get(code + '|' + sub) || 0;
  const balCode = (code) => balances().byCode.get(code) || 0;

  /** Знищене, ще не списане: числиться в обліку, але фактично відсутнє.
   *
   *  Рапорт про знищення — документ бази, як і рапорти з паперових журналів:
   *  тут він записами по рядку (store.destroyed) — дата події, підрозділ,
   *  позиція, кількість, номер і дата рапорту, обставини, номер акта списання.
   *  Рапорти з паперів і внесені тут правляться однаково; походження (`origin`)
   *  важить лише для ⚙ → «Видалити рапорти про знищення, внесені в програмі…».
   */
  /** Статус запису не зберігається, а виводиться з документів: проведено акт
   *  списання з номером, указаним у записі, — «списано»; акт видалили — запис
   *  знову чекає, і майно знову рахується знищеним, не списаним. Раніше статус
   *  так і лишався «включено до акта»: акт зменшував залишок, а знищене
   *  віднімалося з нього вдруге, і фактична наявність ішла в мінус.
   *
   *  Рядок акта списує стільки, скільки в ньому стоїть: записи, закриті ним,
   *  беруть із цієї кількості за чергою подій. Що не вмістилося, лишається
   *  знищеним, не списаним, окремим рядком реєстру. Інакше акт на 3 із 5
   *  знищених закривав би всі п'ять, і наявність була б на дві більшою. */
  let dzCache = null;
  function allDestroyed() {
    if (dzCache) return dzCache;
    const room = new Map();                  // «акт|код» → ще не використана кількість
    const taken = new Set();                 // одиниці, уже закриті своїм рядком акта
    let seq = 0;                             // черга закриття: за нею акт віддає партії
    const cover = (w, r, want) => {
      const act = keyOfRow(w);
      const k = act + '|' + r.code;
      if (!room.has(k)) {
        room.set(k, docs.reduce((a, x) => (x.kind === 'wr' && x.code === r.code && keyOfRow(x) === act
          ? a + (+x.q || 0) : a), 0));
      }
      if (r.unit) {
        if (taken.has(act + '|' + r.unit) || room.get(k) < want) return 0;
        taken.add(act + '|' + r.unit);
      }
      const got = Math.min(room.get(k), want);
      room.set(k, round3(room.get(k) - got));
      // Чим і скільки закрито — для вартості втрат: списане оцінюють партії акта.
      if (got > 0) (r.closed = r.closed || []).push({ act, q: got, seq: seq++ });
      return got;
    };
    // Рапорт, зв'язаний з актом за записом бази, — першим: номер, дата й вид
    // паперу — з самого акта (номер могли виправити). Акт видалили — запис
    // знову чекає акта з тим самим номером; позицію з акта прибрали — запис
    // лише «включено до акта».
    const list = (store.destroyed || []).map((r) => {
      // Інше майно акта програми не має: списане тим документом, що на рядку.
      if (r.other) {
        return Object.assign({}, r, { closed: null, actId: 0, act: '', actDate: r.offDate || '', actType: '',
          status: r.offDate ? 'списано' : 'рапорт подано' });
      }
      const doc = r.actId ? docs.find((x) => x.id === r.actId && x.kind === 'wr') : null;
      if (doc) return Object.assign({}, r, { closed: null, act: doc.no, actDate: doc.d, actType: doc.t || '', status: 'включено до акта' });
      return Object.assign({}, r, { closed: null, actId: 0, actDate: '', status: r.act ? 'включено до акта' : 'рапорт подано' });
    });
    const got = new Map();
    const order = list.map((r, i) => [r, i]).sort(([a, i], [b, j]) => ((b.actId ? 1 : 0) - (a.actId ? 1 : 0))
      || ((b.unit ? 1 : 0) - (a.unit ? 1 : 0)) || (a.date < b.date ? -1 : a.date > b.date ? 1 : i - j));
    for (const [r] of order) {
      if (r.other) continue;
      let need = +r.qty || 0, q = 0, last = null;
      for (const w of writeoffsFor(r)) {
        const g = cover(w, r, need);
        if (g > 0) { q = round3(q + g); need = round3(need - g); last = w; }
        if (need <= 0) break;
      }
      if (last) got.set(r, { w: last, q });
    }
    dzCache = list.flatMap((r) => {
      const g = got.get(r);
      if (!g || g.q <= 0) return [r];
      const done = Object.assign({}, r, { status: 'списано', actDate: g.w.d, actType: g.w.t || r.actType || '' });
      const rest = round3((+r.qty || 0) - g.q);
      if (rest <= 0) return [done];
      return [Object.assign(done, { qty: g.q, id: r.id + '~w', part: true, whole: +r.qty || 0 }),
        Object.assign({}, r, { qty: rest, status: 'включено до акта', part: true, whole: +r.qty || 0, closed: null })];
    });
    return dzCache;
  }
  /** Знищене, не списане на дату: подія вже сталася, а акта на цю дату ще не
   *  було. На кінець року майно, списане вже в наступному, ще знищене й не списане. */
  const openAt = (r, asOf) => r.date <= asOf
    && !(r.status === 'списано' && (!r.actDate || r.actDate <= asOf));

  function destroyedOf(code, sub) {
    return allDestroyed().reduce((s, r) => (
      r.code === code && (!sub || r.sub === sub) && openAt(r, state.asOf)
        ? s + (+r.qty || 0) : s), 0);
  }
  // Підсумок теж рахується на звітну дату: поки в обліку ще нічого знищеного
  // не значилося, плитка мусить показувати нуль, а не те, що станеться пізніше.
  const destroyedTotal = () => allDestroyed().reduce(
    (s, r) => (!r.other && openAt(r, state.asOf) ? s + (+r.qty || 0) : s), 0);

  // ------------------------------------------------ вартість втрат
  /** Вартість знищеного — за ціною партії, а не за ціною довідника: так само
   *  рахує акт і звірка, тож довідка про втрати сходиться з бухгалтерією.
   *  Списане — за партіями, які взяв акт, у черзі закриття записів; не списане
   *  — від найдавнішої партії підрозділу на дату події, спільно для записів
   *  однієї позиції в підрозділі (так його потім і спише акт); знищена одиниця
   *  з номером — за своєю партією. Партій на дату немає (рапорт не на той
   *  підрозділ) — ціни немає, і це видно, а не вигадана ціна.
   *  Повертає id запису → {qty (оцінено), sum, price, missing (без ціни)}. */
  const lossCache = { dz: null, docs: null, n: -1, map: null };
  function lossValues() {
    const list = allDestroyed();
    if (lossCache.dz === list && lossCache.docs === docs && lossCache.n === ledger.length
      && lossCache.asOf === state.asOf) return lossCache.map;
    const map = new Map();
    const val = (r) => map.get(r.id) || map.set(r.id, { qty: 0, sum: 0, price: null, missing: 0 }).get(r.id);
    for (const r of list) val(r);
    const add = (r, q, price) => { const v = val(r); v.qty = round3(v.qty + q); v.sum += q * price; };
    // Ціна за документом (рапорт, справа ЄАС, відомість) — замість партії: і в
    // рядка техзасобів, і в іншого майна, яке партій не має. Інше майно без
    // ціни — без ціни, як рядок без партії: видно, а не вигадано.
    const fixed = (r) => r.price != null && String(r.price).trim() !== '';
    for (const r of list) {
      if (fixed(r)) { add(r, +r.qty || 0, +r.price || 0); Object.assign(val(r), { doc: true, docPrice: +r.price || 0 }); }
      else if (r.other) val(r).missing = round3(+r.qty || 0);
    }
    // Списане: партії акта — рядки цієї позиції в документі, спершу свого виду
    // (одиниця — свій рядок, кількість — рядки без номера), далі будь-які.
    const pieces = [];
    for (const r of list) if (r.status === 'списано' && !fixed(r)) for (const p of r.closed || []) pieces.push({ r, act: p.act, q: p.q, seq: p.seq });
    pieces.sort((a, b) => a.seq - b.seq);
    const pool = new Map();                  // «акт|код» → [{price, q, unit}]
    const partsOf = (code, act) => docs.filter((x) => x.kind === 'wr' && x.code === code && keyOfRow(x) === act)
      .flatMap((x) => rowParts(x).map((p) => ({ price: +p.price || 0, q: +p.q || 0, unit: String(x.unit || '') })));
    for (const { r, act, q } of pieces) {
      const k = act + '|' + r.code;
      if (!pool.has(k)) pool.set(k, partsOf(r.code, act));
      const own = String(r.unit || '');
      let need = q;
      for (const mine of [true, false]) {
        for (const p of pool.get(k)) {
          if (need <= 1e-9) break;
          if ((p.unit === own) !== mine || p.q <= 1e-9) continue;
          const t = Math.min(need, p.q);
          p.q -= t; need = round3(need - t);
          add(r, t, p.price);
        }
      }
      if (need > 1e-9) val(r).missing = round3(val(r).missing + need);
    }
    // Не списане: від найдавнішої партії на дату події; записи однієї позиції в
    // підрозділі беруть партії по черзі подій, як їх потім забере акт. Немає
    // партій на дату події — беруться партії на звітну дату: рапорт пишуть на
    // нову назву підрозділу, а майно на день події ще числилось за старою й
    // перейшло на нову пізніше, рапортом про передачу (партії ті самі).
    const open = list.filter((r) => r.status !== 'списано' && !r.other && !fixed(r))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const used = new Map();                  // «підрозділ|код» → Map(партія → взято)
    for (const r of open) {
      const key = r.sub + '|' + r.code;
      const u = used.get(key) || used.set(key, new Map()).get(key);
      const it = itemBy.get(r.code) || {};
      const came = r.unit ? unitArrival(r.unit, r.date, null) : null;
      const ownPrice = came ? +came.price || +it.basePrice || +it.price || 0 : null;
      let need = +r.qty || 0;
      for (const when of state.asOf > r.date ? [r.date, state.asOf] : [r.date]) {
        if (need <= 1e-9) break;
        const lots = (lotsAt(when).get(key) || []).slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
        const order = came ? lots.filter((l) => Math.abs(l.price - ownPrice) < 0.005)
          .concat(lots.filter((l) => Math.abs(l.price - ownPrice) >= 0.005)) : lots;
        for (const l of order) {
          if (need <= 1e-9) break;
          const lk = l.d + '|' + l.price;
          const free = Math.max(0, l.q - (u.get(lk) || 0));
          const t = Math.min(need, free);
          if (t <= 1e-9) continue;
          u.set(lk, (u.get(lk) || 0) + t);
          need = round3(need - t);
          add(r, t, +l.price || 0);
        }
      }
      if (need > 1e-9) val(r).missing = round3(val(r).missing + need);
    }
    // Ціна за документом лишається такою, як у документі (до чотирьох знаків).
    for (const v of map.values()) { v.sum = round2(v.sum); v.price = v.doc ? v.docPrice : v.qty ? round2(v.sum / v.qty) : null; }
    Object.assign(lossCache, { dz: list, docs, n: ledger.length, asOf: state.asOf, map });
    return map;
  }

  /** Підсумок втрат за переліком записів: «втрачено» — за датою події,
   *  «списано» — за датою акта; зрізи «усього станом на дату», «у поточному
   *  році» й, коли задано, «за період» (не пізніше звітної дати). Залишок до
   *  списання має сенс лише в зрізі «усього»: списане цього року бувало
   *  втрачене торік. missing — одиниць без ціни серед втраченого. */
  function lossSummary(rows, asOf, period = null) {
    const vals = lossValues();
    const cap = (d) => (d && d < asOf ? d : asOf);
    const slices = [['total', '', asOf], ['year', asOf.slice(0, 4) + '-01-01', asOf]]
      .concat(period ? [['period', period[0] || '', cap(period[1])]] : []);
    const out = {};
    for (const [name, from, to] of slices) {
      const s = { lostQ: 0, lostSum: 0, offQ: 0, offSum: 0, leftQ: null, leftSum: null, missing: 0,
        otherLost: 0, otherOff: 0 };
      for (const r of rows) {
        const v = vals.get(r.id) || { sum: 0, missing: 0 };
        // Одиниці — лише техзасоби: інше майно (кг, партії, комплекти) рахується сумою.
        const q = r.other ? 0 : +r.qty || 0;
        if (r.date >= from && r.date <= to) {
          s.lostQ = round3(s.lostQ + q); s.lostSum += v.sum; s.missing = round3(s.missing + v.missing);
          if (r.other) s.otherLost += v.sum;
        }
        if (r.status === 'списано' && r.actDate && r.actDate >= from && r.actDate <= to) {
          s.offQ = round3(s.offQ + q); s.offSum += v.sum;
          if (r.other) s.otherOff += v.sum;
        }
      }
      s.lostSum = round2(s.lostSum); s.offSum = round2(s.offSum);
      s.otherLost = round2(s.otherLost); s.otherOff = round2(s.otherOff);
      if (name === 'total') { s.leftQ = round3(s.lostQ - s.offQ); s.leftSum = round2(s.lostSum - s.offSum); }
      out[name] = s;
    }
    return out;
  }

  // ------------------------------------------------------------ штатна потреба
  /** Норми, задані в програмі, — зі строком дії. Штат міняється наказом, а
   *  торішній розрахунок некомплекту мусить лишитися таким, яким був: тому
   *  запис не перезаписується, а закривається датою, і поряд стає новий.
   *  Норма стоїть або на коді служби (`code`), або на табельній позиції форми
   *  (`form` + `line`) — тоді вона заміщає рядок табеля з бази.
   *  Ранні версії тримали норми мапою «підрозділ|код → кількість» без дат —
   *  вони переїжджають у записи, чинні від початку обліку. */
  const normsReady = new WeakSet();
  function normsInit() {
    if (normsReady.has(store)) return store.norms;
    normsReady.add(store);
    store.norms = (D.norms || []).map(baseNorm);
    return store.norms;
  }
  /** Норми, чинні на дату: строк «по» — перший день, коли норма вже не діє. */
  const normList = (date) => normsInit().filter((n) => openOn(n, date));
  const normOwn = (sub, code, date = state.asOf) => normList(date)
    .reduce((a, n) => (n.sub === sub && n.code === String(code) ? a + (+n.qty || 0) : a), 0);
  function normRollup(sub, code, date = state.asOf) {
    // Коди — рядки (текстове поле бази). Порівняння числа з рядком завжди
    // хибне, і «штат сум.» та «наявно» в таблиці норм показували нуль.
    return normList(date).reduce((a, n) => (n.code === String(code)
      && inSubtree(sub, n.sub) ? a + (+n.qty || 0) : a), 0);
  }
  /** Записати норму на дату. До цієї дати лишається те, що діяло раніше, з неї
   *  — нове: так само, як зі званнями людей. Перша норма позиції строку не має
   *  — вона діє від початку обліку, поки її не змінять. */
  function normSet(where, qty, date, dated = false, quiet = false) {
    normsInit();
    const same = (n) => n.sub === where.sub && (where.code ? n.code === where.code
      : n.form === where.form && n.line === where.line);
    const v = Math.max(0, +qty || 0);
    const cur = store.norms.filter(same).find((n) => openOn(n, date));
    // Штат — підстава некомплекту у звітах: кожна зміна лишає слід у журналі.
    const was = cur ? +cur.qty || 0 : 0;
    if (!quiet && Math.abs(was - v) > 1e-9) {
      const what = where.code ? `${where.code} «${cleanName((itemBy.get(where.code) || {}).name || '')}»`
        : `«${where.line}» (${where.form})`;
      logChange('штат змінено', `norm|${where.sub}|${where.code || where.form + '|' + where.line}`,
        `${what}, ${where.sub}: ${fmtNum(was, '0')} → ${fmtNum(v, '0')} з ${fmtDate(date)}`);
    }
    normApply(same, where, v, cur, date, dated);
  }
  function normApply(same, where, v, cur, date, dated) {
    const codes = where.code ? [] : (lineCodes.get(where.form + '|' + where.line) || []);
    const make = (from, to) => Object.assign({ id: uid() }, where,
      { qty: v, from, to, basis: '', codes });
    if (cur && (cur.from || '') === date) {
      if (v) cur.qty = v; else store.norms = store.norms.filter((n) => n !== cur);
      return;
    }
    if (!cur) {
      // Пізніша норма тієї самої позиції вже є — нова діє до її початку, а не
      // безстроково: інакше строки перекрились би, і база відхилила б запис.
      const later = store.norms.filter(same).filter((n) => (n.from || '') > date)
        .sort((a, b) => (a.from < b.from ? -1 : 1))[0];
      if (v) store.norms.push(make(dated || store.norms.some(same) ? date : '', later ? later.from : ''));
      return;
    }
    const end = cur.to || '';
    cur.to = date;                              // попередній строк закінчується цією датою
    if (v) store.norms.push(make(date, end));
  }
  const normById = (id) => normsInit().find((n) => n.id === id) || null;
  /** Коди служби рядка табеля: з них складається наявність під його штат.
   *  Рядок без кодів («Вагове обладнання») інакше не мав наявності взагалі. */
  function lineCodesSet(key, codes) {
    const i = key.indexOf('|');
    const form = key.slice(0, i), line = key.slice(i + 1);
    lineCodes.set(key, codes);
    const rl = reportLines.find((l) => l.form === form && l.line === line);
    if (rl) rl.codes = codes.slice();
    for (const n of normsInit()) if (n.form === form && n.line === line) n.codes = codes.slice();
    store.lineCodes = store.lineCodes || {};
    store.lineCodes[key] = codes.slice();
    logChange('коди рядка змінено', 'line|' + key, `«${line}» (${form}): ${codes.join(', ') || 'без кодів'}`);
    save(true, true);
    render();
  }
  function haveRollup(sub, code) {
    let total = 0;
    for (const [k, v] of balances().map) {
      const i = k.indexOf('|');
      if (k.slice(0, i) === String(code) && inSubtree(sub, k.slice(i + 1))) total += v;
    }
    return total;
  }
  const hasNorms = () => normsInit().some((n) => n.code && +n.qty > 0);
  /** Чи входить код у форму 21/Прод: прив'язаний до якогось її рядка. */
  const inForm21 = (code) => reportLines.some((l) => l.form === '21/Прод'
    && (lineCodes.get(l.form + '|' + l.line) || l.codes).includes(String(code)));

  // ------------------------------------------------------------------ рендер
  const app = {
    dash: renderDash, nomen: renderNomen, subs: renderSubs, supply: renderSupply,
    inv: renderInventory,
    item: renderItem, doc: renderDoc, moves: renderMoves, j14: renderJ14, j47: renderJ47,
    destroyed: renderDestroyed, recon: renderRecon, subst: renderSubst,
    stocktake: renderStocktake, people: renderPeople, sub: renderSubCard, mtz: renderMtz,
    purch: renderPurchases, val: () => renderPapers('valuation'), yats: () => renderPapers('tech_act'),
    settings: renderSettings, form2: renderForm2,
  };

  // Пункти згруповані за тим, навіщо людина сюди заходить: облік ведуть,
  // контроль проходять, довідник людей ведуть окремо, журнали друкують. Сам
  // перелік не змінився — змінився спосіб його читати.
  /** Стан розділів, що мають і перелік, і картку в одному екрані: пункт меню
   *  завжди відкриває перелік. */
  const NAV_ROOT = {
    destroyed: { dzFocus: null },
    recon: { reconId: null },
    stocktake: { stId: null, stSub: '' },
    people: { personId: null, assign: null },
    mtz: { mtzMonth: null },
    val: { paperId: null, paperVer: 0, paperBad: null },
    yats: { paperId: null, paperVer: 0, paperBad: null },
  };
  // Дванадцять пунктів у чотирьох групах (було чотирнадцять): заміни в штаті —
  // вкладка «Штату і потреби», обидва журнали — один пункт зі своїм перемикачем.
  // Пункт підсвічується й на екранах, що живуть під ним (views).
  const NAV = [
    { id: 'dash', ico: '▤', label: 'Зведення' },
    { group: 'облік' },
    { id: 'moves', book: 'ТЗ', ico: '⇄', label: 'Документи', badge: () => docCount(docs.filter((r) => bookOf(r.code) === 'ТЗ')) },
    { id: 'nomen', book: 'ТЗ', ico: '≡', label: 'Номенклатура', badge: () => tzItems().length },
    { id: 'subs', ico: '⊞', label: 'Підрозділи', badge: () => subs.filter((s) => s.used).length },
    { id: 'inv', ico: '№', label: 'Інвентарні номери',
      badge: () => inventory.reduce((a, r) => a + r.to - r.from + 1, 0) || '' },
    { group: 'посуд і миючі' },
    { id: 'nomen', book: 'ОП', ico: '◌', label: 'Позиції й залишки',
      badge: () => items.filter((i) => bookOfItem(i) === 'ОП' && !i.archived).length || '' },
    { id: 'moves', book: 'ОП', ico: '⇆', label: 'Документи',
      badge: () => docCount(docs.filter((r) => bookOf(r.code) === 'ОП')) || '' },
    { id: 'j47', book: 'ОП', ico: '▦', label: 'Книги 47 і 14', views: ['j14'] },
    { group: 'контроль' },
    { id: 'destroyed', ico: '⚠', label: 'Знищене майно', badge: () => allDestroyed().filter((x) => x.status !== 'списано').length || '' },
    { id: 'recon', ico: '✓', label: 'Звірки з підрозділами', badge: () => reconDue() || '' },
    { id: 'stocktake', ico: '☑', label: 'Інвентаризація', badge: () => (store.inventories || [])
      .filter((x) => x.status !== 'завершено').length || '' },
    { id: 'mtz', ico: '₴', label: 'Відомість МТЗ', badge: () => mtzTodo() || '' },
    { id: 'purch', ico: '⊕', label: 'Закупівлі' },
    { id: 'supply', ico: '∑', label: 'Штат і потреба', views: ['subst'] },
    { group: 'звіти' },
    { id: 'form2', ico: '◫', label: '2/Прод', badge: () => form2MapNow().filter((m) => m.row && !m.checked).length || '' },
    { group: 'оцінка' },
    { id: 'val', ico: '◔', label: 'Залишкова вартість', badge: () => papers().filter((p) => p.kind === 'valuation'
      && (p.state === 'чернетка' || p.state === 'підготовлено')).length || '' },
    { id: 'yats', ico: '⚒', label: 'Акти ЯТС', badge: () => papers().filter((p) => p.kind === 'tech_act'
      && (p.state === 'чернетка' || p.state === 'підготовлено')).length || '' },
    { group: 'люди' },
    { id: 'people', ico: '☺', label: 'Люди й МВО' },
    { group: 'журнали' },
    { id: 'j47', book: 'ТЗ', ico: '▥', label: 'Журнали № 47 і № 14', views: ['j14'] },
    { sep: true },
  ];
  /** Перемикач між потребою й замінами: один пункт меню на два екрани. */
  const staffSeg = (cur) => `<div class="seg"><button type="button" data-nav="supply"${cur === 'supply' ? ' class="is-on"' : ''}>Потреба</button>
      <button type="button" data-nav="subst"${cur === 'subst' ? ' class="is-on"' : ''}>Заміни${
    (store.subst || []).length ? ' · ' + (store.subst || []).length : ''}</button></div>`;
  /** Так само журнали: № 47 — за позицією, № 14 — за підрозділом; поруч — книги за рік. */
  const journalSeg = (cur) => `<div class="seg"><button type="button" data-nav="j47"${cur === 'j47' ? ' class="is-on"' : ''}>№ 47 · позиція</button>
      <button type="button" data-nav="j14"${cur === 'j14' ? ' class="is-on"' : ''}>№ 14 · підрозділ</button></div>
    <button class="btn" data-act="journals-open" title="Паперові книги за рік томами (№ 47 служби й № 14 кожного підрозділу) і електронні книги поточного року — в Excel">Книги за рік…</button>`;

  /** Книги обліку за рік — паперові томи (№ 47 служби й № 14 кожному підрозділу з майном,
   *  розворотами, з титулом, змістом і перенесенням залишків з минулорічної книги) і
   *  електронні книги поточного року з формулами; лягають у «вивантаження/Книги обліку/<рік>».
   *  Складає сервер із бази (reports/journals). */
  function journalsDialog() {
    if (!native) { toast('Книги за рік складаються в програмі на комп’ютері.', true); return; }
    const years = [...new Set(docs.map((r) => String(r.d).slice(0, 4)))].sort();
    const cur = today().slice(0, 4);
    const last = years.filter((y) => y < cur).pop() || years[years.length - 1] || cur;
    modalOpen('Книги обліку за рік', `<div class="pad" style="padding-top:14px">
      <div class="field"><label>Паперові книги за рік</label>
        <select data-jr="year">${years.map((y) => `<option value="${esc(y)}"${y === last ? ' selected' : ''}>${esc(y)}</option>`).join('')}</select></div>
      <label class="chip" style="margin-top:10px;display:flex"><input type="checkbox" data-jr="paper" checked>
        паперові томи: книга № 47 служби й книга № 14 кожного підрозділу з майном</label>
      <label class="chip" style="display:flex"><input type="checkbox" data-jr="electronic" checked>
        електронні книги ${esc(cur)} року з формулами — для подальшого ведення</label>
      <label class="chip" style="display:flex"><input type="checkbox" data-jr="pdf"> і PDF паперових томів (через Excel; кілька хвилин)</label>
      <div class="callout" style="margin-top:12px">Том року починається перенесенням залишків із посиланням на сторінки
        минулорічної книги, тому роки складають по черзі. Книги лягають у «вивантаження/Книги обліку/&lt;рік&gt;».</div>
      <div style="margin-top:14px"><button class="btn btn--primary" data-act="journals-make">Скласти книги</button></div></div>`);
  }
  function journalsMake() {
    const g = (k) => $(`#modal [data-jr="${k}"]`);
    const spec = { kind: 'journals', year: g('year') ? g('year').value : '', paper: !!(g('paper') && g('paper').checked),
      electronic: !!(g('electronic') && g('electronic').checked), pdf: !!(g('pdf') && g('pdf').checked),
      as_of: state.asOf, unit: unitInfo().legalName.replace(/^Військова частина\s*/i, ''), file: 'Книги обліку',
      book: state.book };
    if (!spec.paper && !spec.electronic) { toast('Оберіть, що складати.', true); return null; }
    modalClose();
    toast('Складаю книги обліку…');
    return toExcel(spec);
  }

  /** Підпис під звітною датою: одна настройка міняє сенс усієї програми, тож
   *  видно завжди, у якому стані людина зараз — у сьогоднішньому чи минулому. */
  function renderAsOf() {
    const box = $('#as-of-mode');
    if (!box) return;
    const past = state.asOf !== today();
    box.className = 'side__mode' + (past ? ' is-past' : '');
    box.innerHTML = past
      ? `стан на ${esc(fmtDate(state.asOf))}<button type="button" data-act="asof-today">сьогодні</button>`
      : 'стан на сьогодні';
    const el = $('#as-of');
    if (el && el.value !== state.asOf) el.value = state.asOf;
  }

  function renderNav() {
    $('#nav').innerHTML = NAV.map((n) => n.sep
      ? '<div class="nav__sep"></div>'
      : n.group
        ? `<div class="nav__group">${esc(n.group)}</div>`
        : `<button class="nav__item${(state.view === n.id || (n.views || []).includes(state.view))
          && (!n.book || n.book === state.book) ? ' is-active' : ''}" data-nav="${n.id}"${n.book ? ` data-book="${n.book}"` : ''}>
           <span class="nav__ico">${n.ico}</span>
           <span class="nav__label">${esc(n.label)}</span>
           <span class="nav__badge">${n.badge ? esc(n.badge()) : ''}</span>
         </button>`).join('');
  }

  /** Рядок під назвою сторінки: що показано й на яку дату. Без інструкцій —
   *  що можна зробити, кажуть кнопки. Дати й підрозділ — зі стану. */
  const SUB_TEXT = {
    dash: () => `Стан обліку на ${fmtDate(state.asOf)}`,
    nomen: () => `Залишки на ${fmtDate(state.asOf)} ${state.sub ? `по «${state.sub}»` : 'по всій бригаді'}`,
    subs: () => 'Дерево частини',
    supply: () => `Норма за табелем і наявність на ${fmtDate(state.asOf)}`,
    inv: () => 'Номери одиниць по підрозділах',
    item: () => 'Картка позиції',
    doc: () => '',
    moves: () => 'Первинні документи за весь період',
    form2: () => `Бланк А2788 за ${f2Year()} рік: рух з документів обох книг, зданий звіт і записки`,
    recon: () => (state.reconId
      ? 'Звірка за Додатком 1/9'
      : 'Щомісячні відомості звірки за Додатком 1/9'),
    stocktake: () => 'Наказ, комісія, описи по МВО й акт за формами наказу Мінфіну № 572',
    destroyed: () => 'Рапорти про знищення й акти списання',
    mtz: () => `Закуплене й отримане за ${mtzSpan(mtzMonth())}, станом на ${fmtDate(mtzAsOf(mtzMonth()))}`,
    purch: () => 'Надходження ззовні за документами; це не підтверджені оплати',
    val: () => (state.paperId ? 'Додаток 1 до Методики визначення залишкової вартості (постанова КМУ № 759)'
      : 'Відомості за Додатком 1 до Методики (постанова КМУ № 759)'),
    yats: () => (state.paperId ? 'Додаток 1 до Порядку списання військового майна' : 'Акти якісного (технічного) стану'),
    subst: () => 'Позиції, які зараховуються за табельні при розрахунку некомплекту',
    people: () => ({ resp: `МВО, командири й посадовці на ${fmtDate(state.asOf)}`, loc: 'Місце складання документів за датами',
      unit: 'Реквізити для шапок документів' }[state.peopleTab] || 'Звання й посади зі строками дії'),
    j47: () => '',
    j14: () => '',
    sub: () => `Картка підрозділу на ${fmtDate(state.asOf)}`,
    settings: () => (me.remote ? `Вхід з іншого ПК: ${me.name}` : 'Оформлення, мережа, копії й перевірка бази'),
  };
  const subtitle = () => { const f = SUB_TEXT[state.view]; return f ? f() : ''; };

  function head(crumb, title, extra = '') {
    const past = state.asOf !== today();
    document.body.classList.toggle('asof-past', past);
    if (past) {
      extra = `<button type="button" class="chip chip--btn asof-chip" data-act="asof-today"
        title="Повернутися на сьогодні">станом на ${fmtDate(state.asOf)} · сьогодні ↺</button>` + extra;
    }
    return `<div class="head__row">
      <div class="head__titles">
        <div class="crumb">${esc(crumb)}</div>
        <div class="title">${esc(title)}</div>
        ${subtitle() ? `<div class="subtitle">${esc(subtitle())}</div>` : ''}
      </div>${extra}
      <!-- Реквізити для роздруку: на папері немає ні сайдбара, ні звітної дати. -->
      <div class="head__stamp">${esc(unitInfo().legalName)}
        · станом на ${fmtDate(state.asOf)}</div>
    </div>`;
  }

  const searchBox = (ph = 'Пошук: назва, код, зав. №') => `
    <div class="search"><span>⌕</span>
      <input id="q" type="search" placeholder="${esc(ph)}" value="${esc(state.q)}">
    </div>`;

  const actionsExcel = '<button class="btn" data-act="export">В Excel</button>';
  /** Кнопка дії в рядку реєстру — словом, не значком: «✓» читалося як «готово»,
   *  «⇥» не означало нічого (консиліум 01.10.2026). Значок лишається попереду
   *  слова там, де він підказує суть (✎, ✕, 📎). attrs — рядок атрибутів, за
   *  якими обробник знаходить запис (data-id, data-doc…). */
  const rowBtn = (act, label, attrs = '', o = {}) => `<button type="button" class="ico-btn${o.bad ? ' ico-btn--bad' : ''}${
    o.main ? ' ico-btn--main' : ''}${o.cls ? ' ' + o.cls : ''}" data-act="${act}"${attrs ? ' ' + attrs : ''}${
    o.title ? ` title="${esc(o.title)}"` : ''}${o.off ? ' disabled' : ''}>${label}</button>`;
  const actions = actionsExcel + '<button class="btn btn--primary" data-act="new">+ Новий документ</button>';

  /** Екран — це вигляд плюс те, що в ньому відкрито. Перемальовування того
   *  самого екрана (додали рядок у накладну, змінили норму) лишає прокрутку на
   *  місці; перехід на інший екран починається згори. */
  let lastScreen = '';
  const scrollMemo = new Map();
  const screenKey = () => state.view + '|' + state.book + '|' + (state.view === 'item' ? state.itemCode
    : state.view === 'doc' ? state.docKey : state.view === 'recon' ? (state.reconId || '')
      : state.view === 'stocktake' ? `${state.stId || ''}|${state.stSub || ''}`
        : state.view === 'people' ? `${state.peopleTab || ''}` : state.view === 'sub' ? (state.subName || '')
          : state.view === 'val' || state.view === 'yats' ? `${state.paperId || ''}|${state.paperVer || ''}` : '');

  function render() {
    $('#gear').classList.toggle('is-on', state.view === 'settings');
    pickClose();
    comboClose();
    renderNav();
    renderAsOf();
    const v = app[state.view] || renderDash;
    const out = v();
    $('#head').innerHTML = out.head;
    const sc = $('#scroll');
    const key = screenKey();
    // Прокрутка — і сторінки, і великої таблиці всередині неї (у «Рух і
    // операції» гортається саме таблиця). Той самий екран після правки
    // лишається там, де був; повернення «назад» — туди, звідки пішли.
    if (lastScreen) {
      const tb = sc.querySelector('.card--fill');
      scrollMemo.set(lastScreen, { page: sc.scrollTop, table: tb ? tb.scrollTop : 0 });
    }
    const back = key === lastScreen || state.restoreScroll ? scrollMemo.get(key) : null;
    state.restoreScroll = false;
    lastScreen = key;
    // Екрани «панель + одна велика таблиця» віддають таблиці решту висоти,
    // щоб шапка колонок лишалася перед очима на всіх сотнях рядків.
    sc.className = 'scroll' + (out.fill ? ' scroll--fill' : '');
    sc.innerHTML = out.body;
    // Клац по рядку кудись веде — отже, і Enter має вести: рядок фокусується.
    sc.querySelectorAll('.tbl__row[data-open], .tbl__row[data-sub], .tbl__row[data-code],'
      + ' .tbl__row[data-item], .tbl__row[data-act]').forEach((r) => { r.tabIndex = 0; });
    sc.scrollTop = back ? back.page : 0;
    const tb = sc.querySelector('.card--fill');
    if (tb && back) tb.scrollTop = back.table;
    bindBody();
    keepDraftsSoon();
    if (state.viewer) viewerRender();
  }

  // ------------------------------------------------------------------ Зведення
  /** Щоденна робота служби — п'ять дій, з яких складається облік. Картка
   *  відповідає на «що мені зараз робити?», а не лише «що не так»; її можна
   *  прибрати, а повернути — знаком «?» унизу бічної панелі. */
  // Плитка названа дією, яку людина зробить, а не подією: кнопку читають як команду.
  const INTRO = [
    ['Оприбуткувати надходження', 'акт приймання, наряд або накладна постачальника', 'doc-new', 'in'],
    ['Видати в підрозділ', 'накладна на переміщення', 'doc-new', 'mv'],
    ['Скласти звірки за місяць', 'відомості звірки з підрозділами', 'nav', 'recon'],
    ['Подати відомість МТЗ', 'за минулий місяць, до строку подання', 'nav', 'mtz'],
    ['Внести рапорт про знищення', 'потім знищене списують актом із «Знищеного майна»', 'doc-new', 'dz'],
    ['Провести інвентаризацію', 'щорічна в грудні: наказ, описи по МВО, акт', 'nav', 'stocktake'],
    ['Оновити людей і МВО', 'звання, посади, призначення', 'nav', 'people'],
  ];
  /** Порожня база (дистрибутив без даних): замість «З чого почати» — кроки
   *  першого запуску по порядку, кожен веде туди, де це робиться. Картка
   *  зникає з першим проведеним документом; повернути — «?» унизу зліва. */
  const FIRST_RUN = [
    ['1. Реквізити частини', 'назва юридичної особи, ЄДРПОУ, назва служби', 'first-unit', ''],
    ['2. Підрозділи', 'батальйони з їдальнями й ВМТЗ, роти, склад', 'nav', 'subs'],
    ['3. Номенклатура', 'перевірити каталог і додати свої позиції', 'nav', 'nomen'],
    ['4. Люди й МВО', 'військовослужбовці, МВО кожного підрозділу з майном, посадовці для підписів', 'nav', 'people'],
    ['5. Залишки на дату початку', 'прихід типу «Перенос залишків» на кожного утримувача', 'doc-new', 'in'],
    ['6. Історія з Excel', 'підрозділи, позиції й документи за минулі роки одним файлом', 'imp-open', ''],
    ['7. Штат', 'норми табеля 21/Прод по підрозділах', 'nav', 'supply'],
  ];
  const freshBase = () => !docs.length;
  function firstRunCard() {
    if (store.ui.hideIntro) return '';
    return `<div class="card intro" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Перший запуск: з чого почати</div>
        <div class="panel__spacer"></div>
        <span class="panel__count">база порожня</span>
        <button type="button" class="ico-btn" data-act="intro-hide" title="Прибрати картку">✕</button></div>
      <div class="intro__grid">${FIRST_RUN.map(([t, d, act, v]) => `
        <button type="button" class="intro__item" ${act === 'nav'
          ? `data-nav="${esc(v)}"` : `data-act="${act}" data-v="${esc(v)}"`}>
          <b>${esc(t)}</b><span>${esc(d)}</span></button>`).join('')}</div>
      <div class="pad intro__keys">Докладно: «Інструкція користувача» в теці програми.</div>
    </div>`;
  }
  function introCard() {
    if (store.ui.hideIntro) return '';
    return `<div class="card intro" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">З чого почати</div>
        <div class="panel__spacer"></div>
        <button type="button" class="ico-btn" data-act="intro-hide" title="Прибрати картку">✕</button></div>
      <div class="intro__grid">${INTRO.map(([t, d, act, v]) => `
        <button type="button" class="intro__item" ${act === 'nav'
          ? `data-nav="${esc(v)}"` : `data-act="${act}" data-v="${esc(v)}"`}>
          <b>${esc(t)}</b><span>${esc(d)}</span></button>`).join('')}</div>
      <div class="pad intro__keys"><b>Ctrl+K</b> пошук · <b>Ctrl+Enter</b> провести документ ·
        <b>↑↓</b> і <b>Enter</b> відкрити рядок таблиці</div>
    </div>`;
  }

  function renderDash() {
    const b = balances();
    const total = [...b.byCode.values()].reduce((s, v) => s + v, 0);
    const positions = tzItems().filter((i) => balCode(i.code) !== 0).length;
    const activeSubs = [...b.bySub.entries()].filter(([, v]) => v !== 0).length;
    const destroyed = destroyedTotal();
    const cls = { na: { n: 0, q: 0 }, stock: { n: 0, q: 0 } };
    let unsure = 0;
    for (const i of tzItems()) {
      const q = balCode(i.code);
      if (q <= 1e-9) continue;
      cls[assetOf(i)].n++; cls[assetOf(i)].q += q;
      if (!assetSure(i)) unsure++;
    }

    const byGroup = new Map();
    for (const i of tzItems()) {
      const cur = byGroup.get(i.group) || { n: 0, q: 0 };
      cur.n++; cur.q += balCode(i.code);
      byGroup.set(i.group, cur);
    }
    const groupRows = [...byGroup.entries()]
      .filter(([, v]) => v.q > 0)
      .sort((a, b2) => b2[1].q - a[1].q)
      .map(([g, v]) => `<div class="tbl__row tbl__row--plain">
          <div class="c-code">${esc(g)}</div>
          <div class="c-name"><b>${esc(groupName.get(g) || g)}</b></div>
          <div class="c-num c-num--dim">${v.n}</div>
          <div class="c-num">${fmtNum(v.q)}</div>
        </div>`).join('');

    const topSubs = [...b.bySub.entries()].filter(([, v]) => v > 0)
      .sort((a, b2) => b2[1] - a[1]).slice(0, 10)
      .map(([s, v]) => `<div class="tbl__row" data-sub="${esc(s)}">
          <div class="c-name"><b>${esc(s)}</b><small>${esc(subBy.get(s)?.type || '')}</small></div>
          <div class="c-num">${fmtNum(v)}</div>
        </div>`).join('');

    const recent = docRows(docs.slice(0, 12));

    return {
      head: head('облік / технічні засоби продовольчої служби', 'Зведення', actions),
      body: `
      ${freshBase() ? firstRunCard() : introCard()}
      ${attentionCard()}
      <div class="tiles">
        <div class="tile"><div class="tile__label">Усього на обліку</div>
          <div class="tile__value">${fmtNum(total, '0')} <small>од.</small></div>
          <div class="tile__hint">${cnt(positions, 'позиція', 'позиції', 'позицій')} номенклатури
            в ${cnt(activeSubs, 'підрозділі', 'підрозділах', 'підрозділах')}</div></div>
        <div class="tile"><div class="tile__label">Знищене, не списане</div>
          <div class="tile__value ${destroyed ? 'num-bad' : ''}">${fmtNum(destroyed, '0')} <small>од.</small></div>
          <div class="tile__hint">${destroyed ? 'числиться в обліку до акта списання' : 'записів немає'}</div></div>
        <div class="tile"><div class="tile__label">Документів у журналах</div>
          <div class="tile__value">${docCount(docs)} <small>/ ${docs.length} рядк.</small></div>
          <div class="tile__hint">${period()[0] ? `${fmtDate(period()[0])} – ${fmtDate(period()[1])}`
            : 'журнали порожні'}</div></div>
        <div class="tile" title="Субрахунки 10/11 і 15/18 за ФЕС">
          <div class="tile__label">Необоротні активи · запаси</div>
          <div class="tile__value">${fmtNum(cls.na.q, '0')} <small>/ ${fmtNum(cls.stock.q, '0')} од.</small></div>
          <div class="tile__hint">${fmtNum(cls.na.n, '0')} і ${cnt(cls.stock.n, 'позиція', 'позиції', 'позицій')}${unsure
            ? `, без підтвердження ФЕС ${fmtNum(unsure, '0')}` : ''}</div></div>
      </div>

      <div class="grid-2">
        <div class="card"><div class="card__head"><div class="card__title">Наявність за групами</div></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:auto">
            <div class="tbl__head">
              <div class="tbl__h c-code">група</div><div class="tbl__h c-name">найменування</div>
              <div class="tbl__h c-num">позицій</div><div class="tbl__h c-num">наявно</div>
            </div>${groupRows}</div></div></div>

        <div class="card"><div class="card__head"><div class="card__title">Найбільші утримувачі</div></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:auto">
            <div class="tbl__head">
              <div class="tbl__h c-name">підрозділ</div><div class="tbl__h c-num">наявно</div>
            </div>${topSubs}</div></div></div>
      </div>

      <div class="card" style="margin-top:12px">
        <div class="card__head"><div class="card__title">Останні операції</div>
          <div class="panel__spacer"></div>
          <button class="btn btn--ghost" data-nav="moves">Усі документи →</button></div>
        <div class="card--scroll"><div class="tbl" style="--tbl-min:1000px;--acts:230px">
          <div class="tbl__head">
            <div class="tbl__h c-date">дата</div><div class="tbl__h c-tag">документ</div><div class="tbl__h c-status">стан</div>
            <div class="tbl__h c-code">№</div><div class="tbl__h c-name">найменування</div>
            <div class="tbl__h c-txt">маршрут</div><div class="tbl__h c-num">к-сть</div><div class="tbl__h c-acts"></div>
          </div>${recent}</div></div></div>`,
    };
  }

  const KIND_TAG = { in: ['tag--in', 'прихід'], mv: ['tag--mv', 'перем.'], wr: ['tag--out', 'вибуття'] };

  /** Документ — це не рядок, а всі рядки одного паперу: вид, дата й номер.
   *  Накладна на три найменування — один документ, не три. */
  const docKey = (kind, d, no, from, to) => [kind, d, String(no).trim(),
    String(from ?? '').trim(), String(to ?? '').trim()].join('|');
  const keyOfRow = (r) => docKey(r.kind, r.d, r.no, r.from, r.to);
  /** Ключ документа за проводкою: у проводці свій бік — `sub`, другий — `cnt`. */
  const ledgerKey = (e) => (e.src === 'wr' ? docKey('wr', e.d, e.no, e.sub, e.cnt)
    : e.src === 'in' ? docKey('in', e.d, e.no, e.cnt, e.sub)
      : e.sg < 0 ? docKey('mv', e.d, e.no, e.sub, e.cnt) : docKey('mv', e.d, e.no, e.cnt, e.sub));
  const docCount = (list) => new Set(list.map(keyOfRow)).size;

  /** Стан документа одним словом — щоб читався за півсекунди, а не вгадувався
   *  з набору доступних кнопок. Два стани документа й два стани форми: усі
   *  проведені документи — і з паперових журналів, і внесені тут — рівні. */
  const DOC_STATUS = {
    draft: ['ЧЕРНЕТКА', 'Ще не проведено'],
    editing: ['ВИПРАВЛЕННЯ', 'Виправлення проведеного документа'],
    posted: ['ПРОВЕДЕНО', 'Документ проведено'],
    fixed: ['ВИПРАВЛЕНО', 'Документ виправлено після проведення'],
  };
  let fixedCache = { log: null, n: -1, last: null, set: new Set() };
  /** Ключі документів, які правили після проведення — з журналу змін. */
  function fixedKeys() {
    const log = store.log || [];
    const last = log[log.length - 1] || null;
    if (fixedCache.log !== log || fixedCache.n !== log.length || fixedCache.last !== last) {
      fixedCache = { log, n: log.length, last,
        set: new Set(log.filter((x) => x.what === 'виправлено').map((x) => x.key)) };
    }
    return fixedCache.set;
  }
  const docStatus = (r) => (fixedKeys().has(keyOfRow(r)) ? 'fixed' : 'posted');
  const statusTag = (code, big = false) => `<span class="status status--${code}${big ? ' status--big' : ''}"
      title="${esc(DOC_STATUS[code][1])}">${DOC_STATUS[code][0]}</span>`;
  /** Стан словами для реквізитів картки: що це й коли востаннє мінялося. */
  function statusText(r) {
    const code = docStatus(r);
    if (code === 'fixed') {
      const key = keyOfRow(r);
      const last = logOf((x) => x.what === 'виправлено' && x.key === key)[0];
      return `Виправлено ${last ? fmtStamp(last.t) : '—'}`;
    }
    return 'Проведено';
  }
  /** Хронологія для книг обліку: дата, потім прихід → переміщення → списання,
   *  потім порядок документів. Інакше в межах дня видача стояла раніше приходу
   *  і залишок у книзі на мить ставав мінусовим. */
  const JOURNAL_ORDER = { in: 0, mv: 1, wr: 2 };
  const chrono = (list) => list.map((r, i) => [r, i])
    .sort((a, b) => (a[0].d < b[0].d ? -1 : a[0].d > b[0].d ? 1
      : (JOURNAL_ORDER[a[0].kind] - JOURNAL_ORDER[b[0].kind]) || (a[1] - b[1])))
    .map(([r]) => r);

  /** compact=true — на картці засобу найменування вже в шапці, тож його не дублюємо. */
  /** Скріпка біля номера документа, якщо до нього підшито скан.
   *  У зібраному HTML без програми файлів немає — тоді це просто позначка. */
  function scanMark(r) {
    const list = scansOf(r);
    if (!list.length) return '';
    const title = list.map((x) => x.file).join(', ');
    if (!native) return ` <span class="scan" title="${esc(title)}">&#128206;</span>`;
    // Натискання на скріпку — перегляд у програмі, а не нове вікно браузера.
    return ` <span class="scan" data-vw="0" data-vw-key="${esc(keyOfRow(r))}"
      title="Переглянути: ${esc(title)}">&#128206;${list.length > 1 ? list.length : ''}</span>`;
  }

  function docRow(r, compact = false) {
    const it = itemBy.get(r.code);
    const [cls, lbl] = KIND_TAG[r.kind];
    const route = r.kind === 'wr' ? `${r.from} → ${r.to || 'списано'}` : `${r.from} → ${r.to}`;
    const name = it ? it.name : 'код ' + r.code;
    const key = esc(keyOfRow(r));
    // Рядок про одиницю із заводським номером — з номером: дві кухні в одній
    // накладній інакше виглядають як два однакові рядки.
    const unit = r.unit ? unitLabel(unitBy.get(String(r.unit))) : '';
    // Рядок руху — це рядок документа, тож клац по ньому відкриває документ.
    // Картка засобу — клац по найменуванню.
    return `<div class="tbl__row" data-open="${key}" title="${esc(name)}">
      <div class="c-date">${fmtDate(r.d)}</div>
      <div class="c-tag"><span class="tag ${cls}">${lbl}</span></div>
      <div class="c-status">${statusTag(docStatus(r))}${(fesOf(r.id) || {}).status
        ? `<small class="fes-mini" title="Статус у ФЕС">${esc(fesOf(r.id).status)}</small>` : ''}</div>
      <div class="c-code" title="${esc(r.no)}">${esc(r.no)}${scanMark(r)}</div>
      ${compact ? '' : `<div class="c-name"><b class="lnk" data-code="${esc(r.code)}" title="Відкрити картку позиції">${esc(name)}</b><small>${r.code}${unit ? ' · ' + esc(unit) : ''}</small></div>`}
      <div class="c-txt">${esc(route)}${compact && unit ? `<small>${esc(unit)}</small>` : ''}</div>
      <div class="c-num">${fmtNum(r.q)}</div>
      ${compact ? '' : `<div class="c-acts">
        ${rowBtn('doc-print', 'В Excel', `data-doc="${key}"`, { title: 'Документ на бланку в Excel' })}
        ${rowBtn('doc-edit', '✎ Виправити', `data-doc="${key}"`, { title: 'Виправити документ' })}
        ${rowBtn('doc-del', '✕ Видалити', `data-doc="${key}"`, { bad: true, title: 'Видалити документ' })}
      </div>`}
    </div>`;
  }
  /** Array.map передає індекс другим аргументом — без обгортки кожен рядок,
   *  крім першого, втрачав колонку найменування (compact = індекс). */
  const docRows = (list, compact = false) => list.map((r) => docRow(r, compact)).join('');

  // -------------------------------------------------------------- Номенклатура
  /** Коди служби, чиї табельні позиції мають некомплект на звітну дату.
   *  Без цього «лише некомплект» бачив тільки норми на коди, а їх зазвичай
   *  немає — і список виходив порожнім за реального некомплекту в штаті. */
  function shortByStaff() {
    if (shortCache.key === state.asOf + '|' + ledger.length) return shortCache.set;
    const set = new Set();
    for (const g of staffRows(state.asOf)) if (g.short > 0) g.codes.forEach((c) => set.add(c));
    shortCache.key = state.asOf + '|' + ledger.length;
    shortCache.set = set;
    return set;
  }
  const shortCache = { key: null, set: new Set() };

  // Заводські номери й шасі примірників — теж предмет пошуку: писар шукає за
  // тим, що вибито на табличці.
  const serialsOf = new Map();
  for (const x of instances) {
    const t = [x.serial, x.chassis, x.inv].filter(Boolean).join(' ');
    if (t) serialsOf.set(x.code, (serialsOf.get(x.code) || '') + ' ' + t);
  }

  function filteredItems(opts = {}) {
    const words = qWords(state.q);
    const inv = invQuery(state.q);
    const book = opts.book || state.book;
    return items.filter((i) => {
      if (bookOfItem(i) !== book) return false;
      if (state.group && i.group !== state.group) return false;
      if (state.assetF === 'na' && !i.nonrev) return false;
      if (state.assetF === 'stock' && i.nonrev) return false;
      if (state.assetF === 'unsure' && assetSure(i)) return false;
      if (inv) { if (i.code !== inv[0]) return false; }
      else if (words.length && !hitAll(words, i.name, i.code, i.serial || '', i.chassis || '',
        serialsOf.get(i.code) || '', i.old || '', i.fes || '', i.note || '')) return false;
      // Підрозділ — із підлеглими: у батальйону власний залишок нуль, усе
      // числиться за його взводами, і фільтр показував «Нічого не знайдено».
      if (state.sub && !opts.keepEmpty && !haveRollup(state.sub, i.code) && !normOwn(state.sub, i.code)) return false;
      if (state.onlyShort && shortByStaff().has(i.code)) return true;
      if (state.onlyShort) {
        const need = state.sub ? normRollup(state.sub, i.code) : normRollup(rootName(), i.code);
        const have = state.sub ? haveRollup(state.sub, i.code) : balCode(i.code);
        if (need - have <= 0) return false;
      }
      return true;
    });
  }

  function filterBar(count, extra = '') {
    const tz = state.book === 'ТЗ';
    const groups = D.groups.filter(([g, , book]) => (book || 'ТЗ') === state.book && items.some((i) => i.group === g));
    return `<div class="panel">
      <label class="chip${state.group ? ' is-on' : ''}">
        <span class="chip__label">група</span>
        <select id="f-group"><option value="">${tz ? 'Усі 21.xx' : 'Усі групи'}</option>
          ${groups.map(([g, l]) => `<option value="${g}"${state.group === g ? ' selected' : ''}>${tz ? g + ' · ' : ''}${esc(l)}</option>`).join('')}
        </select></label>
      ${tz ? `<label class="chip${state.assetF ? ' is-on' : ''}"
        title="Вид обліку за ФЕС">
        <span class="chip__label">облік</span>
        <select id="f-asset"><option value="">усе майно</option>
          <option value="na"${state.assetF === 'na' ? ' selected' : ''}>необоротні активи</option>
          <option value="stock"${state.assetF === 'stock' ? ' selected' : ''}>запаси</option>
          <option value="unsure"${state.assetF === 'unsure' ? ' selected' : ''}>не підтверджено ФЕС</option>
        </select></label>` : ''}
      <label class="chip${state.sub ? ' is-on' : ''}">
        <span class="chip__label">підрозділ</span>
        <select id="f-sub"><option value="">Уся бригада</option>
          ${subs.filter((s) => s.used).map((s) => `<option value="${esc(s.name)}"${state.sub === s.name ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select></label>
      ${tz ? `<button class="chip${state.onlyShort ? ' is-on' : ''}" data-act="short">
        <span class="chip__label">стан</span>
        <span class="chip__value">${state.onlyShort ? 'Некомплект > 0' : 'Усі позиції'}</span>
      </button>` : ''}
      ${extra}
      <div class="panel__spacer"></div>
      <div class="panel__count">${count}</div>
    </div>`;
  }

  function renderNomen() {
    const list = filteredItems();
    const scope = state.sub || rootName();
    const groups = [...new Set(list.map((i) => i.group))].sort();
    // Колонки, які нема чим заповнити, не показуємо: сотні рядків прочерків
    // з'їдали 250px ширини й виштовхували «некомплект» за екран.
    const tz = state.book === 'ТЗ';
    const showNorm = tz && hasNorms();
    const showDestr = tz && destroyedTotal() > 0;
    // 254px фіксованих колонок + 300px мінімум на найменування, далі по колонках.
    const width = 554 + (showNorm ? 211 : 0) + (showDestr ? 158 : 0);
    let rows = '';
    const calc = (i) => {
      const have = state.sub ? balOf(i.code, state.sub) : balCode(i.code);
      const need = state.sub ? normRollup(state.sub, i.code) : normRollup(scope, i.code);
      const destr = destroyedOf(i.code, state.sub || null);
      const fact = have - destr;
      return { i, have, need, destr, fact, short: Math.max(0, need - fact), pct: need ? Math.min(1, fact / need) : 0 };
    };
    const tot = { have: 0, destr: 0, fact: 0, short: 0 };
    const data = list.map(calc);
    for (const x of data) { tot.have += x.have; tot.destr += x.destr; tot.fact += x.fact; tot.short += x.short; }
    // Відсортовано за колонкою — один суцільний перелік без поділу на групи.
    const sorted = sortOf('nomen');
    const blocks = sorted
      ? [[null, sortRows('nomen', data, { code: (x) => x.i.code, name: (x) => x.i.name, have: (x) => x.have,
          destr: (x) => x.destr, fact: (x) => x.fact, short: (x) => x.short })]]
      : groups.map((g) => [g, data.filter((x) => x.i.group === g)]);
    for (const [g, inG] of blocks) {
      if (g) {
        rows += `<div class="tbl__group"><b>${esc(groupName.get(g) || g)}</b><span>${esc(g)}</span>
          <div class="panel__spacer"></div><span>${cnt(inG.length, 'позиція', 'позиції', 'позицій')}</span></div>`;
      }
      for (const { i, have, need, destr, fact, short, pct } of inG) {
        const serialTag = i.serial || i.chassis
          ? `<span class="tag tag--ser" title="Пооб’єктний облік">№ ${esc(i.serial || i.chassis)}</span>` : '';
        rows += `<div class="tbl__row" data-item="${i.code}" title="${esc(i.name)}">
          <div class="c-code">${i.code}</div>
          <div class="c-name"><b>${esc(i.name)}</b>${serialTag}${i.own
            ? '<span class="tag tag--mine" title="Позицію заведено в програмі">моє</span>' : ''}</div>
          <div class="c-unit">${esc(i.unit)}</div>
          ${showNorm ? `<div class="c-num c-num--dim">${need ? fmtNum(need) : '—'}</div>` : ''}
          <div class="c-num c-num--wide">${fmtNum(have)}</div>
          ${showDestr ? `<div class="c-num ${destr ? 'num-bad' : 'c-num--dim'}">${destr ? fmtNum(destr) : '—'}</div>
          <div class="c-num c-num--wide">${fmtNum(fact)}</div>` : ''}
          ${showNorm ? `<div class="c-num c-num--wide ${short ? 'num-bad' : 'c-num--dim'}">${short ? fmtNum(short) : '—'}</div>
          <div class="bar${short ? '' : ' bar--ok'}">
            <i style="width:${need ? Math.round(pct * 100) : 0}%"></i></div>` : ''}
        </div>`;
      }
    }
    const form = itemForm();
    // У книзі ОП до першої позиції чи перенесення старої книги позицій немає зовсім — фільтри тут ні до чого.
    const bookEmpty = !tz && !items.some((i) => bookOfItem(i) === 'ОП');
    const empty = bookEmpty ? emptyBlock('◌', 'Позицій посуду й миючих ще немає',
      'Заведіть позицію або перенесіть стару книгу «Облік ОП».',
      '<button class="btn btn--primary" data-act="item-new">+ Нова позиція</button>'
      + (native ? '<button class="btn" data-act="op-legacy">Перенести стару книгу…</button>' : ''))
      : !list.length ? emptyBlock('⌕', 'Нічого не знайдено',
        'Змініть пошуковий запит або скиньте фільтри.',
        '<button class="btn btn--primary" data-act="reset">Скинути фільтри</button>') : '';

    return {
      fill: true,
      head: head(`${tz ? 'облік' : 'посуд і миючі'} / ${state.sub ? state.sub : 'уся бригада'}`,
        tz ? 'Номенклатура за розділами 21/Прод' : 'Посуд, миючі засоби й серветки',
        searchBox() + '<button class="btn" data-act="item-new">+ Нова позиція</button>'
        + (tz ? '' : '<button class="btn" data-act="op-request">Заявка на 30 днів…</button>'
          + (native ? '<button class="btn" data-act="op-fes">Звірка з ФЕС…</button>' : '')) + actions),
      body: form + filterBar(`${cnt(list.length, 'позиція', 'позиції', 'позицій')}
        · ${cnt(groups.length, 'група', 'групи', 'груп')}`) + (empty || `
        <div class="card card--scroll card--fill"><div class="tbl" style="--tbl-min:${width}px">
          <div class="tbl__head">
            ${sortHead('nomen', 'code', 'код', 'c-code')}
            ${sortHead('nomen', 'name', 'найменування, марка', 'c-name')}
            <div class="tbl__h c-unit">од.</div>
            ${showNorm ? '<div class="tbl__h c-num">штат</div>' : ''}
            ${sortHead('nomen', 'have', 'наявно', 'c-num c-num--wide')}
            ${showDestr ? `${sortHead('nomen', 'destr', 'знищ.', 'c-num')}
            ${sortHead('nomen', 'fact', 'фактично', 'c-num c-num--wide')}` : ''}
            ${showNorm ? `${sortHead('nomen', 'short', 'некомпл.', 'c-num c-num--wide')}
            <div class="tbl__h" style="width:53px"></div>` : ''}
          </div>${rows}
          <div class="tbl__row tbl__row--plain tbl__row--total">
            <div class="c-code"></div><div class="c-name"><b>Разом: ${cnt(list.length, 'позиція', 'позиції', 'позицій')}</b></div>
            <div class="c-unit"></div>${showNorm ? '<div class="c-num"></div>' : ''}
            <div class="c-num c-num--wide">${fmtNum(tot.have, '0')}</div>
            ${showDestr ? `<div class="c-num">${fmtNum(tot.destr, '—')}</div><div class="c-num c-num--wide">${fmtNum(tot.fact, '0')}</div>` : ''}
            ${showNorm ? `<div class="c-num c-num--wide">${fmtNum(tot.short, '—')}</div><div style="width:53px"></div>` : ''}
          </div></div></div>`),
    };
  }

  // --------------------------------------------------------------- Підрозділи
  function renderSubs() {
    peopleInit();
    const b = balances();
    // Глибокі вузли без руху з перенесеного довідника (взводи, відділення) перелік не засмічують;
    // підрозділ, заведений у програмі, видно завжди — інакше щойно створену їдальню батальйону
    // не було де знайти, щоб виправити чи видалити.
    const made = (sb) => !/^b\d+$/.test(String(sb.id || ''));
    const data = subs.filter((sb) => sb.used || sb.depth <= 1 || made(sb)).map((sb) => ({ s: sb,
      own: b.bySub.get(sb.name) || 0,
      roll: [...b.bySub.entries()].reduce((acc, [n, v]) => (inSubtree(sb.name, n) ? acc + v : acc), 0),
      kinds: tzItems().filter((i) => balOf(i.code, sb.name) !== 0).length }));
    const spec = {
      id: 'subs', rows: data, placeholder: 'Пошук: підрозділ',
      search: (x) => [x.s.name, x.s.type || '', x.s.note || ''],
      filters: [
        { type: 'seg', key: 'act', options: [['', 'усі'], ['open', 'чинні'], ['closed', 'закриті']],
          test: (x, v) => (v === 'open') === !!x.s.active },
        { type: 'toggle', key: 'has', label: 'з майном', test: (x) => Math.abs(x.roll) > 1e-9 },
      ],
      columns: [{ key: 'sub', sort: (x) => x.s.name }, { key: 'kinds', sort: (x) => x.kinds },
        { key: 'own', sort: (x) => x.own }, { key: 'roll', sort: (x) => x.roll }],
      count: (shown, all) => (shown.length === all.length
        ? `${cnt(all.length, 'підрозділ', 'підрозділи', 'підрозділів')}, закритих ${all.filter((x) => !x.s.active).length}`
        : `${shown.length} із ${all.length}`),
    };
    const shown = regRows(spec);
    const sorted = sortOf('subs');
    const rows = shown.map(({ s: sb, own, roll, kinds }) => `<div class="tbl__row${sb.active ? '' : ' tbl__row--closed'}${
        state.subEdit && state.subEdit === sb.id ? ' is-sel' : ''}" data-sub="${esc(sb.name)}"
        title="${esc(sb.name)}${sb.active ? '' : '\n' + esc(sb.note)}">
        <div class="c-name" style="padding-left:${sorted ? 7 : 7 + sb.depth * 16}px">
          <b>${esc(sb.name)}</b><small>${esc([sb.type, sb.active ? '' : 'закритий', sb.used ? '' : 'без руху'].filter(Boolean).join(', '))}</small></div>
        <div class="c-num c-num--dim">${kinds || '—'}</div>
        <div class="c-num">${fmtNum(own)}</div>
        <div class="c-num c-num--xwide">${fmtNum(roll)}</div>
        <div class="c-acts">${rowBtn('sd-edit', '✎ Виправити', `data-id="${esc(sb.id || '')}"`, { title: 'Змінити запис довідника' })}</div>
      </div>`).join('') || '<div class="tbl__row tbl__row--plain"><div class="c-txt">За цими фільтрами підрозділів немає.</div></div>';
    const totalRow = shown.length ? `<div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-name"><b>Разом</b></div>
        <div class="c-num"></div><div class="c-num">${fmtNum(shown.reduce((a, x) => a + x.own, 0), '0')}</div>
        <div class="c-num c-num--xwide"></div><div class="c-acts"></div></div>` : '';

    return {
      fill: true,
      head: head('облік / структура', 'Підрозділи та розподіл майна',
        '<button class="btn btn--primary" data-act="sd-new">+ Підрозділ</button>' + actions),
      body: `${flashBlock()}${subDirCard()}${regPanel(spec, shown)}
        <div class="card card--scroll card--fill"><div class="tbl" style="--tbl-min:760px;--acts:110px">
          <div class="tbl__head">
            ${sortHead('subs', 'sub', 'підрозділ', 'c-name')}
            ${sortHead('subs', 'kinds', 'позицій', 'c-num')}
            ${sortHead('subs', 'own', 'власний залишок', 'c-num')}
            ${sortHead('subs', 'roll', 'з підлеглими', 'c-num c-num--xwide')}
            <div class="tbl__h c-acts"></div>
          </div>${rows}${totalRow}</div></div>`,
    };
  }

  // ------------------------------------------------- довідник підрозділів
  /** Структура частини живе в довіднику: базове дерево прийшло з бази, а зміни
   *  служби вносять тут. Перейменування зроблено так, як його робить служба:
   *  стара назва не міняється — за нею лишилися документи, — а закривається з
   *  приміткою, поряд стає новий вузол, і майно переходить накладною. Так само
   *  проходить і переформування батальйону. */
  const subById = (id) => (store.subs || []).find((x) => x.id === id) || null;

  function subsChanged(backup = true) {
    rebuildSubs(store.subs, subMentions());
    save(true, backup);
    render();
  }

  /** Перелік для поля «підпорядкований»: без себе й без власного піддерева —
   *  інакше гілка від'єдналася б від дерева. */
  function parentOptions(sel, skip = '') {
    return '<option value="">— без підпорядкування —</option>' + subs
      .filter((x) => x.name !== skip && !(skip && inSubtree(skip, x.name)))
      .map((x) => `<option value="${esc(x.name)}"${x.name === sel ? ' selected' : ''}>${
        '  '.repeat(x.depth)}${esc(x.name)}${x.active ? '' : ' · закритий'}</option>`).join('');
  }
  const kindOptions = (sel) => SUB_KINDS.concat(SUB_KINDS.includes(sel) || !sel ? [] : [sel])
    .map((k) => `<option value="${esc(k)}"${k === sel ? ' selected' : ''}>${esc(k)}</option>`).join('');

  function subDirCard() {
    if (state.subNew) return subNewCard();
    if (state.subRen) return subRenCard();
    const r = subById(state.subEdit);
    return r ? subEditCard(r) : '';
  }

  function subEditCard(r) {
    const uses = subUses(r.name);
    const held = balSub(r.name);
    return `<div class="card form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">${esc(r.name)}</div>
        <div class="panel__spacer"></div>
        <button class="btn" data-act="sd-cancel">Закрити</button></div>
      <div class="form__grid">
        <div class="field"><label>Назва</label>
          <input data-sd="name" data-id="${esc(r.id)}" value="${esc(r.name)}"${uses ? ' readonly' : ''} autocomplete="off">
          ${uses ? '<div class="field__hint">назву змінюють кнопками «Виправити назву» чи «Перейменувати»</div>' : ''}</div>
        <div class="field"><label>Підпорядкований</label>
          <select data-sd="parent" data-id="${esc(r.id)}">${parentOptions(r.parent, r.name)}</select></div>
        <div class="field"><label>Вид</label>
          <select data-sd="type" data-id="${esc(r.id)}">${kindOptions(r.type)}</select></div>
        <div class="field"><label>Примітка</label>
          <input data-sd="note" data-id="${esc(r.id)}" value="${esc(r.note || '')}" placeholder="наказ №, дата, куди передано майно"></div>
      </div>
      <div class="card__foot">
        ${uses ? `<button class="btn" data-act="sd-fix" data-id="${esc(r.id)}"
          title="Той самий підрозділ під правильною назвою, без накладної">Виправити назву…</button>` : ''}
        <button class="btn btn--primary" data-act="sd-ren" data-id="${esc(r.id)}"
          title="Новий підрозділ замість цього; майно переходить накладною">Перейменувати…</button>
        <button class="btn" data-act="sd-toggle" data-id="${esc(r.id)}">${
          r.active === false ? 'Відкрити знову' : 'Закрити підрозділ'}</button>
        <button class="btn btn--danger" data-act="sd-del" data-id="${esc(r.id)}"${uses ? ' disabled' : ''}>Видалити</button>
        <div class="panel__spacer"></div>
        <span class="panel__count">${uses ? cnt(uses, 'згадка', 'згадки', 'згадок') + ' в обліку' : 'в обліку не згадується'}${
          held ? ` · числиться ${fmtNum(held)} од.` : ''}</span>
      </div></div>`;
  }

  function subNewCard() {
    const n = state.subNew;
    return `<div class="card form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Новий підрозділ</div>
        <div class="panel__spacer"></div>
        <button class="btn" data-act="sd-cancel">Скасувати</button></div>
      <div class="form__grid">
        <div class="field"><label>Назва</label>
          <input data-sn="name" id="sd-name" value="${esc(n.name)}" placeholder="3 б БпС · ВМТЗ" autocomplete="off">
          <div class="field__hint">як її пишуть у накладних і описах; їдальня чи ВМТЗ батальйону — з його назвою: «3 б БпС їдальня», знак «·» програма поставить сама</div></div>
        <div class="field"><label>Підпорядкований</label>
          <select data-sn="parent">${parentOptions(n.parent)}</select></div>
        <div class="field"><label>Вид</label><select data-sn="type">${kindOptions(n.type)}</select></div>
        <div class="field"><label>Примітка</label>
          <input data-sn="note" value="${esc(n.note)}" placeholder="наказ №, дата"></div>
      </div>
      <div class="card__foot"><button class="btn btn--primary" data-act="sd-add">Додати в довідник</button>
        </div>
    </div>`;
  }

  function subRenCard() {
    const r = subById(state.subRen.id);
    if (!r) return '';
    if (state.subRen.fix) {
      return `<div class="card form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Виправити назву «${esc(r.name)}»</div>
        <div class="panel__spacer"></div>
        <button class="btn" data-act="sd-cancel">Скасувати</button></div>
      <div class="pad" style="padding-bottom:0"><div class="panel__note">Той самий підрозділ під правильною назвою:
        документи, рапорти, звірки, описи, норми й МВО перейдуть на неї, накладної не буде. Стара назва
        лишиться в базі іншою назвою підрозділу. Якщо майно передають новому підрозділу — «Перейменувати».</div></div>
      <div class="form__grid">
        <div class="field"><label>Правильна назва</label>
          <input data-sr="name" id="sd-newname" value="${esc(state.subRen.name || r.name)}" autocomplete="off"></div>
        <div class="field"><label>Підстава</label>
          <input data-sr="basis" value="${esc(state.subRen.basis)}" placeholder="наказ №, дата або «помилка в назві»"></div>
      </div>
      <div class="card__foot"><button class="btn btn--primary" data-act="sd-fix-go">Виправити назву</button></div>
    </div>`;
    }
    const held = balSub(r.name);
    return `<div class="card form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Перейменувати «${esc(r.name)}»</div>
        <div class="panel__spacer"></div>
        <button class="btn" data-act="sd-cancel">Скасувати</button></div>
      ${held ? `<div class="pad" style="padding-bottom:0"><div class="panel__note">За «${esc(r.name)}» числиться ${fmtNum(held)} од.
        Після перейменування майно треба передати накладною.</div></div>` : ''}
      <div class="form__grid">
        <div class="field"><label>Нова назва</label>
          <input data-sr="name" id="sd-newname" value="${esc(state.subRen.name)}" placeholder="2 б ТрО" autocomplete="off"></div>
        <div class="field"><label>З дати</label>
          <input data-sr="date" type="date" value="${esc(state.subRen.date)}"></div>
        <div class="field"><label>Підстава</label>
          <input data-sr="basis" value="${esc(state.subRen.basis)}" placeholder="наказ №, дата"></div>
      </div>
      <div class="card__foot"><button class="btn btn--primary" data-act="sd-ren-go">Перейменувати</button>
        <div class="panel__spacer"></div>
        <span class="panel__count">Стара назва лишиться в довіднику як закрита.</span></div>
    </div>`;
  }

  /** Власний залишок підрозділу на звітну дату (без підлеглих). */
  function balSub(name) {
    let total = 0;
    for (const [k, v] of balances().map) if (k.slice(k.indexOf('|') + 1) === name) total += v;
    return round3(total);
  }

  function subAdd() {
    const n = state.subNew || {};
    let name = String(n.name || '').trim();
    // Підрозділ батальйону зветься «3 б ТрО · їдальня»: за цим закінченням програма впізнає
    // їдальню й ВМТЗ батальйону. Знака «·» на клавіатурі немає — між назвою вищого підрозділу
    // й рештою його ставить програма, хоч би що там набрали: пробіл, дефіс чи крапку.
    const up = String(n.parent || '').trim();
    if (up && name.toLowerCase().startsWith(up.toLowerCase())) {
      const m = name.slice(up.length).match(/^\s*[-–—.·,:]?\s+(\S.*)$/) || name.slice(up.length).match(/^\s*[-–—.·,:]\s*(\S.*)$/);
      if (m) name = `${up} · ${m[1]}`;
    }
    if (!name) { toast('Впишіть назву підрозділу.', true); return; }
    if (subBy.has(name)) { toast(`Підрозділ «${name}» уже є в довіднику.`, true); return; }
    const rec = { id: uid(), name, parent: String(n.parent || '').trim(), type: n.type || 'рота',
      active: true, note: String(n.note || '').trim() };
    store.subs = (store.subs || []).concat([rec]);
    logChange('підрозділ додано', 'sub|' + name, `«${name}»${rec.parent ? ', у складі «' + rec.parent + '»' : ''}`);
    state.subNew = null;
    state.subEdit = rec.id;
    subsChanged();
    toast(`Підрозділ «${name}» додано в довідник.`);
  }

  function subToggle(id) {
    const r = subById(id);
    if (!r) return;
    if (r.active === false) {
      r.active = true;
      logChange('підрозділ відкрито', 'sub|' + r.name, `«${r.name}» знову чинний`);
      subsChanged();
      toast(`Підрозділ «${r.name}» відкрито знову.`);
      return;
    }
    const held = balSub(r.name);
    if (!confirm(`Закрити підрозділ «${r.name}»?\n\n`
      + (held ? `За ним числиться ${fmtNum(held)} од. майна, яке треба передати накладною.\n\n` : '')
      + 'Документи й звірки лишаться в історії, але нових на нього не складатимуть.')) return;
    r.active = false;
    if (!String(r.note || '').trim()) r.note = `закритий з ${fmtDate(state.asOf || today())}`;
    logChange('підрозділ закрито', 'sub|' + r.name, `«${r.name}»${held ? `, числилося ${fmtNum(held)} од.` : ''}`);
    subsChanged();
  }

  function subDelete(id) {
    const r = subById(id);
    if (!r) return;
    const uses = subUses(r.name);
    if (uses) {
      alert(`Підрозділ «${r.name}» не можна видалити: є ${cnt(uses, 'запис', 'записи', 'записів')} в обліку. `
        + 'Закрийте його замість видалення.');
      return;
    }
    if (!confirm(`Видалити «${r.name}» з довідника підрозділів?`)) return;
    store.subs = store.subs.filter((x) => x.id !== r.id);
    logChange('підрозділ видалено', 'sub|' + r.name, `«${r.name}»`);
    state.subEdit = null;
    subsChanged();
    toast(`Підрозділ «${r.name}» видалено з довідника.`);
  }

  function subRename() {
    const r = subById(state.subRen && state.subRen.id);
    if (!r) return;
    const name = String(state.subRen.name || '').trim();
    const basis = String(state.subRen.basis || '').trim();
    const date = state.subRen.date || today();
    if (!name) { toast('Впишіть нову назву.', true); return; }
    if (subBy.has(name)) { toast(`Підрозділ «${name}» уже є в довіднику.`, true); return; }
    const old = r.name;
    const rec = { id: uid(), name, parent: r.parent, type: r.type, active: true,
      note: `утворений замість «${old}»${basis ? ' — ' + basis : ''} (${fmtDate(date)})` };
    const at = store.subs.indexOf(r);
    store.subs.splice(at < 0 ? store.subs.length : at, 0, rec);
    r.active = false;
    r.parent = name;                             // закритий вузол — усередині свого наступника
    r.note = (String(r.note || '').trim() ? String(r.note).replace(/[;\s]+$/, '') + '; ' : '')
      + `перейменовано на «${name}»${basis ? ' — ' + basis : ''} з ${fmtDate(date)}`;
    // МВО й норми йдуть за підрозділом: людина та сама, штат той самий — просто
    // тепер за новою назвою. Строк за старою закривається наступним днем: МВО
    // мусить лишитися на самій накладній, якою він здає майно.
    const moved = subCarryOver(old, name, date, basis);
    logChange('підрозділ перейменовано', 'sub|' + old,
      `«${old}» → «${name}»${basis ? ', ' + basis : ''} з ${fmtDate(date)}`
      + (moved.mvo ? `; МВО перенесено (${moved.mvo})` : '') + (moved.norms ? `; норм перенесено ${moved.norms}` : ''));
    state.subRen = null;
    state.subEdit = null;
    subsChanged();
    subTransfer(old, name, date, moved);
  }

  /** Виправити назву на місці: той самий підрозділ (помилка в назві чи нова
   *  назва без передачі майна). Документи, рапорти, звірки, описи, норми й МВО
   *  переходять на нову назву; у базі це той самий запис, а стара назва лягає
   *  в інші назви підрозділу — за нею його знайдуть у старих паперах. */
  function subFixName() {
    const r = subById(state.subRen && state.subRen.id);
    if (!r) return;
    const name = String(($('#sd-newname') || {}).value ?? state.subRen.name ?? '').trim();
    const basis = String(state.subRen.basis || '').trim();
    const old = r.name;
    if (!name) { toast('Впишіть правильну назву.', true); return; }
    if (name === old) { toast('Назва та сама.', true); return; }
    if (name.includes('|')) { toast('У назві підрозділу не ставте «|»: за назвою програма знаходить документи.', true); return; }
    if (subBy.has(name)) { toast(`Підрозділ «${name}» уже є в довіднику.`, true); return; }
    if (!confirm(`Виправити назву «${old}» на «${name}»?\n\nДокументи, рапорти, звірки, описи, норми й МВО `
      + 'цього підрозділу будуть під новою назвою. Накладної на передачу майна не буде: це той самий підрозділ.')) return;
    renameEverywhere(old, name);
    logChange('назву підрозділу виправлено', 'sub|' + name, `«${old}» → «${name}»${basis ? ', ' + basis : ''}`);
    state.subRen = null;
    state.subEdit = r.id;
    save(true, true);
    refresh();
    toast(`Назву виправлено: «${name}».`);
  }

  /** Нова назва підрозділу скрізь, де застосунок тримає його за назвою: у
   *  рядках документів, рапортах, звірках, описах, нормах, МВО, ключах сканів і
   *  в тому, що прийшло з бази до перезапуску. */
  function renameEverywhere(old, name) {
    const sw = (x) => (x === old ? name : x);
    for (const s of store.subs || []) { s.name = sw(s.name); s.parent = sw(s.parent); }
    // У приході відправник — постачальник, а не підрозділ.
    for (const r of store.docs.incoming) r[4] = sw(r[4]);
    for (const r of store.docs.movement) { r[3] = sw(r[3]); r[4] = sw(r[4]); }
    for (const r of store.docs.writeoffs) r[3] = sw(r[3]);
    for (const x of store.destroyed || []) x.sub = sw(x.sub);
    for (const r of allRecon()) r.sub = sw(r.sub);
    const moveKey = (o) => {
      if (o && Object.prototype.hasOwnProperty.call(o, old)) { o[name] = o[old]; delete o[old]; }
    };
    for (const inv of allInv()) {
      moveKey(inv.mvo);
      moveKey(inv.where);
      moveKey(inv.cmdr);
      moveKey(inv.plan);
      // «фактично» й примітки описів — за ключем «підрозділ|код|ціна».
      for (const o of [inv.fact, inv.note]) {
        if (!o) continue;
        for (const k of Object.keys(o)) {
          if (k.startsWith(old + '|')) { o[name + k.slice(old.length)] = o[k]; delete o[k]; }
        }
      }
      if (Array.isArray(inv.scope)) inv.scope = inv.scope.map(sw);
      if (inv.frozen) { inv.frozen.subs = (inv.frozen.subs || []).map(sw); moveKey(inv.frozen.lines); }
    }
    for (const r of store.mvo || []) r.sub = sw(r.sub);
    for (const r of store.cmdrs || []) r.sub = sw(r.sub);
    for (const n of normsInit()) n.sub = sw(n.sub);
    // Скани документів, де підрозділ у маршруті: ключ документа несе назву.
    const docKeyOf = (k) => {
      const p = String(k).split('|');
      if (!/^(in|mv|wr)$/.test(p[0]) || (p[3] !== old && p[4] !== old)) return k;
      p[3] = sw(p[3]); p[4] = sw(p[4]);
      return p.join('|');
    };
    for (const x of store.scans || []) x.key = docKeyOf(x.key);
    // Позначка «виправлено» в документах тримається на ключі з журналу змін.
    for (const x of store.log || []) if (x.key) x.key = docKeyOf(x.key);
    for (const r of inventory) r.sub = sw(r.sub);
    for (const u of instances) u.holder = sw(u.holder);
    for (const m of [subTitles, responsible, baseOrder, baseUsed, baseRefs]) {
      if (m.has(old)) { m.set(name, m.get(old)); m.delete(old); }
    }
    if (state.sub === old) state.sub = name;
    if (state.subName === old) state.subName = name;
    if (state.docKey) state.docKey = docKeyOf(state.docKey);
    dzCache = null;
  }

  /** Наступний день: строки МВО закінчуються днем, що вже не входить у строк. */
  function dayAfter(d) {
    const [y, m, day] = String(d).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, day) + 864e5).toISOString().slice(0, 10);
  }

  /** Перенести на нову назву те, що прив'язане до підрозділу, а не до паперів:
   *  чинного МВО й норми, задані в програмі. Повертає, скільки чого перенесено. */
  function subCarryOver(old, name, date, basis) {
    peopleInit();
    const out = { mvo: '', norms: 0 };
    for (const list of [store.mvo, store.cmdrs]) {
      for (const r of (list || []).filter((x) => x.sub === old && openOn(x, date))) {
        r.to = dayAfter(date);
        r.note = (String(r.note || '').trim() ? r.note.replace(/[;\s]+$/, '') + '; ' : '')
          + `підрозділ перейменовано на «${name}» з ${fmtDate(date)}`;
        list.push({ id: uid(), sub: name, person: r.person, from: date, to: '',
          note: `та сама особа за новою назвою підрозділу${basis ? ' — ' + basis : ''}` });
        if (list !== store.mvo) continue;
        const p = personBy(r.person);
        out.mvo = out.mvo ? `${out.mvo}, ${pFull(p)}` : pFull(p);
      }
    }
    for (const n of normList(date).filter((x) => x.sub === old)) {
      out.norms += 1;
      // Норма, що саме з цієї дати й почалась, переходить на нову назву цілком:
      // строк «з 18.03 по 18.03» база не прийняла б, і перейменування не записалось би.
      if ((n.from || '') === date) { n.sub = name; if (basis && !n.basis) n.basis = basis; continue; }
      const end = n.to || '';
      n.to = date;
      store.norms.push(Object.assign({}, n, { id: uid(), sub: name, from: date, to: end,
        basis: basis || n.basis || '' }));
    }
    return out;
  }

  /** Після перейменування — готова чернетка накладної на все, що лишилося за
   *  старою назвою: інакше майно «зависає» на закритому підрозділі. */
  /** Рядки накладної «усе майно підрозділу» для перейменування й передачі
   *  закритого: одиниці із заводськими номерами — своїми рядками, решта —
   *  кількістю. Знищене за рапортами лишається, де було: його закриває акт
   *  списання того підрозділу, а не передача (інакше рапорт уже не закрити). */
  function transferLines(from, date) {
    const lines = [];
    let kept = 0;
    const gone = destroyedUnitsAt(from, date);
    for (const it of tzItems()) {
      const units = unitsAt(it.code, from, date);
      for (const u of units) {
        if (gone.has(String(u.id))) { kept += 1; continue; }
        lines.push({ code: it.code, qty: '1', price: String(u.price), note: '', lot: u.d, unit: String(u.id) });
      }
      const dq = round3(destroyedAt(it.code, from, date) - units.filter((u) => gone.has(String(u.id))).length);
      const q = round3(bulkAt(it.code, from, date) - dq);
      kept = round3(kept + Math.max(0, dq));
      if (q > 1e-9) lines.push({ code: it.code, qty: String(q), price: '', note: '', lot: '', unit: '' });
    }
    return { lines, kept };
  }

  /** Незавершена накладна в чернетці — не губимо її мовчки. */
  function mayReplaceMvDraft() {
    const mine = (state.drafts || {}).mv;
    return !(mine && hasContent(mine))
      || confirm(`Замінити незавершену чернетку накладної?

Написане в ній буде втрачено.`);
  }

  function subTransfer(from, to, date, moved = { mvo: '', norms: 0 }) {
    const { lines, kept } = transferLines(from, date);
    const what = cnt(lines.length, 'позиція', 'позиції', 'позицій');
    const tail = (moved.mvo ? ` МВО за новою назвою — ${moved.mvo}.` : '')
      + (moved.norms ? ` Норми (${moved.norms}) перенесено з ${fmtDate(date)}.` : '');
    if (!lines.length) {
      state.flash = `«${from}» перейменовано на «${to}». Майна за старою назвою немає.${tail}`;
      render();
      return;
    }
    if (!confirm(`За «${from}» на ${fmtDate(date)} числиться ${what}.\n\nСкласти накладну на передачу «${to}»?`)) {
      state.flash = `«${from}» перейменовано на «${to}». За старою назвою лишилося ${what}. `
        + `Передайте майно накладною в розділі «Документи».${tail}`;
      render();
      return;
    }
    if (!leaveEditing()) return;
    stashDraft();
    if (!mayReplaceMvDraft()) return;
    state.drafts = state.drafts || {};
    delete state.drafts.mv;
    state.editing = null;
    state.moveKind = 'mv';
    state.draft = { kind: 'mv', lines: lines.concat([emptyLine()]),
      head: { type: 'Накладна', no: suggestMvNo(), date, from, to,
        basis: `перейменування «${from}» на «${to}» з ${fmtDate(date)}`,
        report: '', reportDate: '', act: '', note: '' } };
    state.flash = `Чернетка накладної з «${from}» на «${to}»: ${what}. Перевірте номер і дату та проведіть.${tail}`
      + (kept ? ` Знищене за рапортами (${fmtNum(kept)} од.) лишилось за «${from}» до акта списання.` : '');
    go('moves', { q: '', formOpen: true });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
  }

  /** Закритий підрозділ, за яким ще числиться майно: накладна на все, що
   *  лишилося, з ним як відправником — одержувача людина обирає у формі.
   *  Без цього майно «зависало»: закритого немає серед відправників, а
   *  «Передати майно» на Зведенні вело в картку без жодної накладної. */
  function subHandOver(from) {
    const date = today();
    const { lines, kept } = transferLines(from, date);
    if (!lines.length) {
      toast(kept ? `За «${from}» лишилось лише знищене за рапортами (${fmtNum(kept)} од.) — його закриває акт списання.`
        : `За «${from}» на ${fmtDate(date)} майна не числиться.`);
      return;
    }
    if (!leaveEditing()) return;
    stashDraft();
    if (!mayReplaceMvDraft()) return;
    state.drafts = state.drafts || {};
    delete state.drafts.mv;
    state.editing = null;
    state.moveKind = 'mv';
    const sb = subBy.get(from);
    state.draft = { kind: 'mv', lines: lines.concat([emptyLine()]),
      head: { type: 'Накладна', no: suggestMvNo(), date, from, to: (sb && sb.parent) || '',
        basis: `передача майна закритого підрозділу «${from}»`,
        report: '', reportDate: '', act: '', note: '' } };
    state.flash = `Чернетка накладної із закритого «${from}»: ${cnt(lines.length, 'позиція', 'позиції', 'позицій')}. `
      + 'Оберіть одержувача, перевірте номер і дату та проведіть.';
    go('moves', { q: '', formOpen: true });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
  }

  /** Строки норм, заданих у програмі: з якої дати діє, по яку, чим підтверджено.
   *  Норма на код служби й норма на табельну позицію — в одному переліку: і те,
   *  і те задають у програмі, і те, і те має строк. */
  function normTermsCard(scope) {
    const list = normsInit().filter((n) => n.sub === scope || inSubtree(scope, n.sub)).slice()
      .sort((a, b) => String(a.sub).localeCompare(String(b.sub), 'uk')
        || String(a.code || a.line).localeCompare(String(b.code || b.line), 'uk')
        || String(a.from || '').localeCompare(String(b.from || '')));
    if (!list.length) {
      return `<div class="panel"><div class="panel__note">Норм, заданих у програмі, для «${esc(scope)}»
        ще немає. Впишіть штат у колонці «штат власний».</div></div>`;
    }
    const rows = list.map((n) => {
      const it = n.code ? itemBy.get(n.code) : null;
      const what = n.code ? `${n.code} · ${it ? cleanName(it.name) : 'позиція'}` : `${n.line}`;
      return `<div class="tbl__row tbl__row--plain${openOn(n, state.asOf) ? '' : ' tbl__row--closed'}">
        <div class="c-name"><b>${esc(what)}</b><small>${esc(n.sub)}${n.code ? '' : ' · табельна позиція ' + esc(n.form)}</small>${
          n.note ? `<small title="${esc(n.note)}">${esc(n.note)}</small>` : ''}</div>
        <div class="c-num c-num--input"><input class="rc-in" data-nm="${esc(n.id)}" data-k="qty"
          value="${esc(String(n.qty))}" inputmode="decimal" aria-label="кількість за штатом"></div>
        <div class="c-date" style="width:150px"><input class="rc-in" type="date" data-nm="${esc(n.id)}" data-k="from"
          value="${esc(n.from || '')}"></div>
        <div class="c-date" style="width:150px"><input class="rc-in" type="date" data-nm="${esc(n.id)}" data-k="to"
          value="${esc(n.to || '')}"></div>
        <div class="c-txt"><input class="rc-in rc-in--wide" data-nm="${esc(n.id)}" data-k="basis"
          value="${esc(n.basis || '')}" placeholder="наказ №, дата"></div>
        <div class="c-acts">${rowBtn('nm-del', '✕ Видалити', `data-id="${esc(n.id)}"`, { bad: true, title: 'Видалити норму' })}</div>
      </div>`;
    }).join('');
    return `<div class="panel"><div class="panel__note">Якщо штат змінився, не правте стару норму, а впишіть нову кількість на звітну дату.</div>
        <div class="panel__count">${cnt(list.length, 'норма', 'норми', 'норм')} · чинних на ${fmtDate(state.asOf)}:
          ${list.filter((n) => openOn(n, state.asOf)).length}</div></div>
      <div class="card card--scroll" style="margin-bottom:14px"><div class="tbl" style="--tbl-min:900px;--acts:110px">
        <div class="tbl__head"><div class="tbl__h c-name">позиція · підрозділ</div>
          <div class="tbl__h c-num c-num--input">штат</div>
          <div class="tbl__h c-date" style="width:150px">з дати</div>
          <div class="tbl__h c-date" style="width:150px">по дату</div>
          <div class="tbl__h c-txt">підстава</div><div class="tbl__h c-acts"></div></div>
        ${rows}</div></div>`;
  }

  function subsAction(what, d) {
    // Довідники мусять бути злиті з базою до першої правки: інакше наступне
    // злиття перетерло б щойно змінений запис своїм базовим.
    peopleInit();
    switch (what) {
      case 'sd-new':
        state.subEdit = null;
        state.subRen = null;
        state.subNew = { name: '', parent: state.sub || rootName(), type: 'рота', note: '' };
        render();
        $('#sd-name')?.focus();
        return null;
      case 'sd-edit':
        state.subNew = null;
        state.subRen = null;
        state.subEdit = state.subEdit === d.id ? null : d.id;
        render();
        return null;
      case 'sd-open': {
        const r = (store.subs || []).find((x) => x.name === d.sub);
        state.subNew = null;
        state.subRen = null;
        state.subEdit = r ? r.id : null;
        return go('subs');
      }
      case 'sd-cancel':
        state.subNew = null;
        state.subRen = null;
        state.subEdit = null;
        return render();
      case 'sd-add': return subAdd();
      case 'sd-toggle': return subToggle(d.id);
      case 'sd-del': return subDelete(d.id);
      case 'sd-ren': {
        if (!subById(d.id)) return null;
        state.subEdit = null;
        state.subRen = { id: d.id, name: '', basis: '', date: state.asOf || today() };
        render();
        $('#sd-newname')?.focus();
        return null;
      }
      case 'sd-ren-go': return subRename();
      case 'sd-fix': {
        if (!subById(d.id)) return null;
        state.subEdit = null;
        state.subRen = { id: d.id, name: '', basis: '', date: today(), fix: true };
        render();
        $('#sd-newname')?.focus();
        return null;
      }
      case 'sd-fix-go': return subFixName();
      case 'nm-del': {
        const n = normById(d.id);
        if (!n) return null;
        // Норма — частина штату з табеля: зникає й зі звітів минулих дат. Штат,
        // що змінився, закривають датою, а не видаляють.
        const it = n.code ? itemBy.get(n.code) : null;
        const what = n.code ? `${n.code} «${it ? cleanName(it.name) : 'позиція'}»` : `«${n.line}» (${n.form})`;
        const term = `${n.from ? 'з ' + fmtDate(n.from) : 'від початку обліку'}${n.to ? ' по ' + fmtDate(n.to) : ''}`;
        if (!confirm(`Видалити норму ${what} для «${n.sub}»: ${fmtNum(n.qty)}, ${term}?\n\n`
          + 'Штат зникне й із розрахунків минулих дат. Якщо штат змінився — закрийте норму датою «по».')) return null;
        store.norms = store.norms.filter((x) => x.id !== n.id);
        logChange('норму видалено', 'norm|' + n.id, `${what}, ${n.sub}: ${fmtNum(n.qty)}, ${term}`);
        save(true, true);
        return render();
      }
      case 'nm-terms':
        state.normTerms = !state.normTerms;
        return render();
      default: return null;
    }
  }

  // ---------------------------------------------------- Штат / наявність / потреба
  /** Штат за табелем — таблиця, зведена з норм бази.
   *
   *  Норма стоїть на табельному рядку форми, а не на коді служби: «кухні
   *  причіпні КП-130(130М)» — один рядок штату й кілька кодів в обліку. Тому
   *  наявність під рядок збирається з усіх його кодів, а не з одного.
   */
  /** Табельні позиції: штат, наявність, знищене, некомплект — у межах
   *  підрозділу з підлеглими (порожній scope — уся бригада). Позиції без штату,
   *  але з майном теж у переліку (qty = 0): вони можуть іти за заміну. */
  function staffRows(date, scope = '', every = false) {
    const inScope = (sub) => !scope || inSubtree(scope, sub);
    const byLine = new Map();
    for (const n of staffAt(date)) {
      if (!inScope(n.sub)) continue;
      const key = n.form + '|' + n.line;
      if (!byLine.has(key)) byLine.set(key, { ...n, qty: 0, subs: [], codes: lineCodes.get(key) || n.codes || [] });
      const g = byLine.get(key);
      g.qty += n.qty;
      g.subs.push([n.sub, n.qty]);
    }
    // Норма на код служби — теж потреба рядка, до якого код прив'язано: так само, як наявність
    // рядка складається з його кодів (так рахує й форма 21/Прод). Табельна норма підрозділу на
    // рядок головніша: норми того самого підрозділу на коди цього рядка тоді не рахуються.
    const tabular = new Set(staffAt(date).map((n) => n.form + '|' + n.line + '|' + n.sub));
    for (const n of normList(date)) {
      if (!n.code || !(+n.qty > 0) || !inScope(n.sub)) continue;
      for (const l of reportLines) {
        const key = l.form + '|' + l.line;
        const codes = lineCodes.get(key) || l.codes;
        if (!staffForms.has(l.form) || !codes.includes(n.code) || tabular.has(key + '|' + n.sub)) continue;
        if (!byLine.has(key)) byLine.set(key, { form: l.form, line: l.line, qty: 0, subs: [], codes, basis: '' });
        const g = byLine.get(key);
        g.qty += +n.qty;
        let s = g.subs.find((x) => x[0] === n.sub && x[2]);
        if (!s) { s = [n.sub, 0, []]; g.subs.push(s); }
        s[1] += +n.qty;
        if (!s[2].includes(n.code)) s[2].push(n.code);
      }
    }
    for (const l of reportLines) {
      const key = l.form + '|' + l.line;
      if (!byLine.has(key) && staffForms.has(l.form)) {
        byLine.set(key, { form: l.form, line: l.line, qty: 0, subs: [], codes: l.codes, basis: '' });
      }
    }
    // Замінник-позиція, якої в табелі форми немає: окремий рядок без штату.
    for (const r of (store.subst || [])) {
      if (!isItemRef(r.from) || !staffForms.has(r.form)) continue;
      const code = r.from.slice(1);
      if (reportLines.some((l) => l.form === r.form && l.codes.includes(code))) continue;
      const key = r.form + '|' + r.from;
      if (!byLine.has(key)) {
        byLine.set(key, { form: r.form, line: substName(r.from), ref: r.from, qty: 0, subs: [], codes: [code], basis: '' });
      }
    }
    const byCode = new Map();
    for (const [k, v] of balances().map) {
      const i = k.indexOf('|');
      if (!inScope(k.slice(i + 1))) continue;
      const code = k.slice(0, i);
      byCode.set(code, (byCode.get(code) || 0) + v);
    }
    const gone = new Map();
    for (const r of allDestroyed()) {
      if (inScope(r.sub) && openAt(r, state.asOf)) gone.set(r.code, (gone.get(r.code) || 0) + (+r.qty || 0));
    }
    return [...byLine.values()]
      .map((g) => {
        const have = g.codes.reduce((acc, cc) => acc + (byCode.get(cc) || 0), 0);
        const destr = g.codes.reduce((acc, cc) => acc + (gone.get(cc) || 0), 0);
        const fact = have - destr;
        return { ...g, have, destr, fact, staffed: g.qty > 0, short: Math.max(0, g.qty - fact),
          over: Math.max(0, fact - g.qty), pct: g.qty ? fact / g.qty : null };
      })
      .filter((g) => every || g.qty > 0 || g.fact > 0)
      .sort((x, y) => x.form.localeCompare(y.form) || x.line.localeCompare(y.line));
  }

  // ------------------------------------------------ заміни табельних позицій
  /** Замінником може бути й окрема позиція номенклатури, якої в табелі форми
   *  немає зовсім, — єврокуб за цистерну ЦВ-4. У правилі вона записана як
   *  «#код», у таблицях — назвою й кодом. */
  const isItemRef = (x) => String(x || '').startsWith('#');
  function substName(x) {
    if (!isItemRef(x)) return x;
    const code = String(x).slice(1), it = itemBy.get(code);
    return `${it ? cleanName(it.name) : 'позиція'} · код ${code}`;
  }
  const substIndex = (rows) => {
    const by = new Map();
    for (const g of rows) { by.set(g.line, g); if (g.ref) by.set(g.ref, g); }
    return by;
  };
  /** Рядок-джерело правила. Код, який тим часом прив'язали до рядка форми,
   *  замінює вже як рядок: інакше його наявність рахувалася б двічі. */
  function substSource(r, rows, by) {
    const g = by.get(r.from);
    if (g || !isItemRef(r.from)) return g || null;
    const code = r.from.slice(1);
    return rows.find((x) => !x.ref && (x.codes || []).includes(code)) || null;
  }
  /** Правило заміни: позиція `from` понад свій власний штат закриває некомплект
   *  позицій `to` — у тому порядку, як їх перелічено. Правила застосовуються
   *  одне за одним у порядку списку; надлишок, уже відданий одним правилом,
   *  іншим не дістається. Власний штат позиції-замінника завжди першочерговий. */
  function applySubst(rows, form) {
    const by = substIndex(rows);
    for (const g of rows) Object.assign(g, { subIn: 0, subFrom: [], subOut: 0, subTo: [] });
    for (const r of (store.subst || []).filter((x) => x.form === form)) {
      const src = substSource(r, rows, by);
      if (!src) continue;
      for (const t of r.to) {
        const dst = by.get(t);
        const spare = Math.max(0, src.fact - src.qty - src.subOut);
        if (!dst || dst === src || spare <= 0) continue;
        const take = Math.min(spare, Math.max(0, dst.qty - dst.fact - dst.subIn));
        if (take <= 0) continue;
        dst.subIn += take;
        dst.subFrom.push([src.line, take]);
        src.subOut += take;
        src.subTo.push([dst.line, take]);
      }
    }
    for (const g of rows) {
      g.shortS = Math.max(0, g.qty - g.fact - g.subIn);
      g.overS = Math.max(0, g.fact - g.qty - g.subOut);
      // Відданий на заміну надлишок у позиції-замінника вже не рахується.
      g.pctS = g.qty ? (g.fact - g.subOut + g.subIn) / g.qty : null;
    }
    return rows;
  }

  /** Укомплектованість переліку: частка штату, закрита наявністю (надлишок однієї
   *  позиції не закриває некомплект іншої — хіба що за правилом заміни). */
  function coverage(rows, withSubst) {
    let need = 0, got = 0;
    for (const g of rows) {
      if (!g.qty) continue;
      need += g.qty;
      got += Math.min(g.qty, Math.max(0, g.fact) + (withSubst ? g.subIn || 0 : 0));
    }
    return need ? got / need : null;
  }
  /** Коротке ім'я позиції для підписів «за рахунок: КП-130 – 12»: марка, якщо
   *  вона є в назві, інакше назва повністю («Пічі польові переносні»). */
  const shortName = (line) => {
    const m = String(line).match(/[A-ZА-ЯІЇЄҐ]{2,}[A-ZА-ЯІЇЄҐ]*-?\s?\d+(?:[.,]\d+)?/);
    return m ? m[0] : line;
  };

  function staffBlock() {
    // «Усі позиції форми» — і ті, під які ще немає ні штату, ні кодів: інакше
    // штат на такий рядок табеля не було де вписати.
    const rows = staffRows(state.asOf, state.sub, !!state.staffAll);
    if (!rows.length) {
      // Перший штат вписують у рядок табеля, а рядків без штату й без майна перелік не показує:
      // без цієї кнопки нова служба не мала де почати.
      return `<div class="panel" data-staff-empty><div class="panel__note">
        Штату на ${fmtDate(state.asOf)} у базі немає.${state.staffAll ? ' Табельних форм теж.' : ' Щоб вписати його, відкрийте всі позиції форми.'}</div>
        ${state.staffAll ? '' : `<div class="panel__spacer"></div>
        <button type="button" class="btn btn--primary" data-act="staff-all">Усі позиції форми</button>`}</div>`;
    }
    const byForm = new Map();
    for (const g of rows) byForm.set(g.form, (byForm.get(g.form) || 0) + g.qty);
    // Дві форми описують той самий табель різними рядками: «термос ТВН-12» у
    // 21/Прод і «ТВН-12» у 3/Прод. Разом у списку вони виглядали як дублікати,
    // тож показуємо одну форму, а між ними — перемикач.
    const forms = [...byForm.keys()].sort();
    if (!forms.includes(state.staffForm)) state.staffForm = forms.includes('21/Прод') ? '21/Прод' : forms[0];
    const all = applySubst(rows.filter((g) => g.form === state.staffForm), state.staffForm);
    const rules = (store.subst || []).filter((x) => x.form === state.staffForm);
    const withS = !!(rules.length && store.ui.withSubst);
    // За табелем — лише позиції зі штатом; із замінами — ще й ті, що віддали надлишок.
    const list = sortRows('staff', all.filter((g) => state.staffAll || g.staffed || (withS && g.subOut)), {
      line: (g) => g.line, qty: (g) => g.qty, have: (g) => g.have,
      short: (g) => (withS ? g.shortS : g.short), over: (g) => (withS ? g.overS : g.over),
      pct: (g) => { const p = withS ? g.pctS : g.pct; return p == null ? -1 : p; } });
    const showDestr = list.some((g) => g.destr);
    const cols = 7 + (showDestr ? 1 : 0) + (withS ? 1 : 0);
    const body = list.map((g) => {
      const pct = withS ? g.pctS : g.pct;
      const short = withS ? g.shortS : g.short;
      const over = withS ? g.overS : g.over;
      const cls = pct == null ? 'c-num--dim' : pct >= 1 ? 'num-ok' : pct >= 0.5 ? 'num-warn' : 'num-bad';
      const where = g.subs.map(([sb, q]) => sb + ' ' + fmtNum(q)).join(' · ');
      const from = g.subFrom.map(([l, q]) => `${shortName(l)} – ${fmtNum(q)}`).join('; ');
      const to = g.subTo.map(([l, q]) => `${shortName(l)} – ${fmtNum(q)}`).join('; ');
      const key = g.form + '|' + g.line;
      const open = state.staffOpen === key;
      return `<div class="tbl__row${open ? ' is-sel' : ''}" data-act="staff-open" data-line="${esc(key)}"
          title="${esc(where)}${g.basis ? '&#10;' + esc(g.basis) : ''}">
        <div class="c-name"><b>${open ? '▾ ' : ''}${esc(g.line)}</b><small>${g.staffed
          ? cnt(g.subs.length, 'підрозділ', 'підрозділи', 'підрозділів') : 'без штату'}${
          withS && to ? ` · за заміну віддано: ${esc(to)}` : ''}</small></div>
        <div class="c-num">${g.staffed ? fmtNum(g.qty) : '—'}</div>
        <div class="c-num c-num--wide">${fmtNum(g.have)}</div>
        ${showDestr ? `<div class="c-num ${g.destr ? 'num-bad' : 'c-num--dim'}">${g.destr ? fmtNum(g.destr) : '—'}</div>` : ''}
        ${withS ? `<div class="c-num c-num--wide ${g.subIn ? 'num-ok' : 'c-num--dim'}" title="${esc(from)}">${g.subIn ? '+' + fmtNum(g.subIn) : '—'}</div>` : ''}
        <div class="c-num ${short ? 'num-bad' : 'c-num--dim'}">${short ? fmtNum(short) : '—'}</div>
        <div class="c-num ${over ? 'num-warn' : 'c-num--dim'}">${over ? fmtNum(over) : '—'}</div>
        <div class="c-num ${cls}">${pct == null ? '—' : Math.round(pct * 100) + '%'}</div>
        <div class="c-num c-num--dim">${g.codes.length || '—'}</div>
      </div>${open ? staffDetail(g, cols) : ''}`;
    }).join('');
    const sumOf = (f) => list.reduce((a, g) => a + (f(g) || 0), 0);
    const totalRow = `<div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-name"><b>Разом</b></div>
      <div class="c-num">${fmtNum(sumOf((g) => (g.staffed ? g.qty : 0)), '0')}</div>
      <div class="c-num c-num--wide">${fmtNum(sumOf((g) => g.have), '0')}</div>
      ${showDestr ? `<div class="c-num">${fmtNum(sumOf((g) => g.destr))}</div>` : ''}
      ${withS ? `<div class="c-num c-num--wide">${fmtNum(sumOf((g) => g.subIn))}</div>` : ''}
      <div class="c-num">${fmtNum(sumOf((g) => (withS ? g.shortS : g.short)))}</div>
      <div class="c-num">${fmtNum(sumOf((g) => (withS ? g.overS : g.over)))}</div>
      <div class="c-num"></div><div class="c-num"></div></div>`;
    const cov = coverage(all, false), covS = coverage(all, true);
    const modeSeg = rules.length
      ? `<div class="seg" title="Розрахунок укомплектованості">
          <button type="button" data-act="ws" data-v="0"${withS ? '' : ' class="is-on"'}>за табелем</button>
          <button type="button" data-act="ws" data-v="1"${withS ? ' class="is-on"' : ''}>з урахуванням замін</button></div>`
      : '<button type="button" class="chip chip--btn" data-nav="subst">Задати заміни →</button>';
    const seg = forms.length > 1 ? `<div class="seg">${forms.map((f) =>
      `<button type="button" data-act="sf" data-v="${esc(f)}"${f === state.staffForm ? ' class="is-on"' : ''}>форма ${esc(f)}</button>`)
      .join('')}</div>` : '';
    return `<div class="panel">${seg}${modeSeg}<div class="panel__spacer"></div>
        <div class="panel__count">${cnt(list.filter((g) => g.staffed).length, 'позиція', 'позиції', 'позицій')} · за штатом ${fmtNum(byForm.get(state.staffForm))}
          · укомплектовано ${cov == null ? '—' : Math.round(cov * 100) + '%'}${rules.length && covS !== cov
            ? `, із замінами <b class="num-ok">${Math.round(covS * 100)}%</b>` : ''}</div>
        <button type="button" class="chip chip--btn${state.staffAll ? ' is-on' : ''}" data-act="staff-all"
          title="Показати й позиції форми без штату та без кодів служби">${state.staffAll ? '✓ ' : ''}усі позиції форми</button>
        <button type="button" class="btn btn--sm" data-act="ol-open"
          title="Рядок для майна, якому в бланку рядка немає: стане у вільний рядок свого розділу">+ Власний рядок</button>
        <div style="flex-basis:100%;height:0"></div><div class="panel__spacer"></div>
        <button type="button" class="btn" data-act="short-xls" title="Некомплект по підрозділах в Excel">Заявка на некомплект</button>
        <button type="button" class="btn" data-act="form21-xls" title="Форма 21/Прод у бланку вищого штабу на звітну дату">Форма 21/Прод</button>
        <button type="button" class="btn" data-act="form21-set"
          title="Зведена за частину, управління (усе поза батальйонами) і кожен батальйон: книга з аркушами, окремі файли й розшифровка до форми в одній теці">21/Прод: комплект</button>
      </div>${ownLineCard()}${list.length ? '' : `<div class="panel" data-staff-none><div class="panel__note">
        Штату за формою ${esc(state.staffForm)} на ${fmtDate(state.asOf)} немає. Потребу вписують у рядок табеля: відкрийте
        всі позиції форми, розгорніть рядок і додайте підрозділ у штат. Норма на код у колонці «штат власний» нижче теж
        іде в рядок, до якого код прив’язано.</div><div class="panel__spacer"></div>
        <button type="button" class="btn btn--primary" data-act="staff-all">Усі позиції форми</button></div>`}
      <div class="card card--scroll"${list.length ? '' : ' hidden'}><div class="tbl" style="--tbl-min:820px">
        <div class="tbl__head">
          ${sortHead('staff', 'line', 'табельна позиція', 'c-name')}
          ${sortHead('staff', 'qty', 'штат', 'c-num')}
          ${sortHead('staff', 'have', 'наявно', 'c-num c-num--wide')}
          ${showDestr ? '<div class="tbl__h c-num">знищ.</div>' : ''}
          ${withS ? '<div class="tbl__h c-num c-num--wide">по заміні</div>' : ''}
          ${sortHead('staff', 'short', 'некомплект', 'c-num')}
          ${sortHead('staff', 'over', 'понад штат', 'c-num')}
          ${sortHead('staff', 'pct', '%', 'c-num')}
          <div class="tbl__h c-num">кодів</div>
        </div>${body}${totalRow}</div></div>`;
  }

  /** Де саме бракує: штат і наявність по кожному підрозділу, що має цю позицію
   *  за штатом, і коди служби, з яких складається наявність. */
  /** Власний рядок форми — для майна, якому в бланку вищого штабу рядка немає (автоклави):
   *  так частина й робила в паперовій формі. Рядок стає останнім у своєму розділі, у бланку —
   *  у вільний рядок розділу; коди прив'язують «+ код служби», як до будь-якого рядка. */
  const ownLineKey = (x) => x.form + '|' + x.name;
  const isOwnLine = (key) => (store.ownLines || []).some((x) => ownLineKey(x) === key);
  function formSections(form) {
    return reportLines.filter((l) => l.form === form && !l.section).map((l) => l.line.replace(/:\s*$/, '').trim());
  }
  function ownLineCard() {
    if (!state.ownLineOpen) return '';
    const sections = formSections(state.staffForm);
    const pick = sections.includes('Інше майно') ? 'Інше майно' : sections[sections.length - 1];
    return `<div class="card form" style="margin-bottom:12px" data-own-line>
      <div class="card__head"><div class="card__title">Власний рядок форми ${esc(state.staffForm)}</div>
        <div class="panel__spacer"></div><button type="button" class="btn" data-act="ol-cancel">Скасувати</button></div>
      <div class="form__grid">
        <div class="field"><label for="ol-section">Розділ</label><select id="ol-section" data-ol="section">${sections.map((s) =>
          `<option value="${esc(s)}"${s === pick ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
        <div class="field field--span2"><label for="ol-name">Назва рядка</label><input id="ol-name" data-ol="name"
          placeholder="наприклад, Автоклави" autocomplete="off"></div>
      </div>
      <div class="card__foot"><button type="button" class="btn btn--primary" data-act="ol-add">Додати рядок</button></div></div>`;
  }
  function ownLineAdd() {
    const form = state.staffForm;
    const section = ($('[data-ol="section"]') || {}).value || '';
    const name = String(($('[data-ol="name"]') || {}).value || '').replace(/\s+/g, ' ').trim();
    if (!name) { toast('Впишіть назву рядка.', true); return; }
    const same = (a) => a.replace(/[’ʼ‘]/g, "'").replace(/\s+/g, ' ').trim().replace(/:$/, '').toLowerCase();
    const twin = reportLines.find((l) => l.form === form && same(l.line) === same(name));
    if (twin) { toast(`Рядок «${twin.line}» у формі ${form} уже є: прив’яжіть коди до нього.`, true); return; }
    if (!formSections(form).includes(section)) { toast('Оберіть розділ форми.', true); return; }
    store.ownLines = (store.ownLines || []).concat([{ form, section, name }]);
    // У переліку — одразу після останнього рядка свого розділу, як і в базі.
    const after = reportLines.reduce((at, l, i) => (l.form === form && l.section === section && !/^Всього/.test(l.line) ? i : at), -1);
    reportLines.splice(after >= 0 ? after + 1 : reportLines.length, 0, { form, line: name, section, codes: [] });
    lineCodes.set(form + '|' + name, []);
    logChange('рядок форми додано', 'line|' + form + '|' + name, `«${name}» у розділі «${section}» (${form})`);
    state.ownLineOpen = false;
    state.staffAll = true;
    state.staffOpen = form + '|' + name;
    save(true, true);
    render();
  }
  function ownLineDelete(key) {
    const i = key.indexOf('|');
    const form = key.slice(0, i), name = key.slice(i + 1);
    if ((lineCodes.get(key) || []).length || normsInit().some((n) => n.form === form && n.line === name)) {
      toast('До рядка прив’язано коди чи штат: спершу відв’яжіть їх.', true);
      return;
    }
    if (!confirm(`Видалити власний рядок «${name}» з форми ${form}?`)) return;
    store.ownLines = (store.ownLines || []).filter((x) => ownLineKey(x) !== key);
    const at = reportLines.findIndex((l) => l.form === form && l.line === name);
    if (at >= 0) reportLines.splice(at, 1);
    lineCodes.delete(key);
    if (store.lineCodes) delete store.lineCodes[key];
    logChange('рядок форми видалено', 'line|' + key, `«${name}» (${form})`);
    if (state.staffOpen === key) state.staffOpen = null;
    save(true, true);
    render();
  }

  function staffDetail(g, cols) {
    const date = state.asOf;
    const key = g.form + '|' + g.line;
    const subsRows = g.subs.map(([sb, q, byCodes]) => {
      const have = round3((g.codes || []).reduce((a, c) => a + haveRollup(sb, c), 0)
        - (g.codes || []).reduce((a, c) => a + destroyedIn(c, sb), 0));
      const short = Math.max(0, round3(q - have));
      // Штат, що прийшов із норм на коди, правлять там само — у «штат власний» переліку під таблицею.
      const qty = byCodes ? `<span title="Норма на код: змінюється в колонці «штат власний» переліку під таблицею">штат ${
        fmtNum(q, '0')} <small>норма на код ${esc(byCodes.join(', '))}</small></span>`
        : `<span>штат <input class="rc-in" style="width:64px" data-snorm="${esc(key + '|' + sb)}" value="${esc(String(q))}"
          inputmode="decimal" aria-label="штат «${esc(g.line)}» у «${esc(sb)}»"></span>`;
      return `<div class="st-detail__row${short ? ' num-bad' : ''}"><span class="lnk" data-sub="${esc(sb)}">${esc(sb)}</span>
        ${qty}<span>наявно ${fmtNum(have, '0')}</span><span>${short ? 'бракує ' + fmtNum(short) : 'укомплектовано'}</span></div>`;
    }).join('');
    // Штат міняється наказом: у програмі його правлять тут, на звітну дату.
    // Базовий табель лишається за минулими датами, а свої записи видно в
    // «Строки норм» унизу екрана.
    const free = pickableSubs('').filter((x) => !g.subs.some(([sb, , byCodes]) => sb === x.name && !byCodes)
      && (!state.sub || inSubtree(state.sub, x.name)) && x.type !== 'бригада');
    const addSub = `<div class="st-detail__row"><span>додати підрозділ у штат:</span>
      <span><select class="rc-in rc-in--wide" data-nmadd="${esc(key)}"><option value="">— оберіть —</option>
        ${free.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('')}</select></span>
      <span>норма стане чинною з ${fmtDate(date)}</span><span></span></div>`;
    const own = normsInit().filter((n) => n.form === g.form && n.line === g.line)
      .sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
    const ownRows = own.length ? `<div class="st-detail__head" style="margin-top:6px">Задано в програмі:</div>`
      + own.map((n) => `<div class="st-detail__row"><span>${esc(n.sub)}</span>
        <span>${fmtNum(n.qty)}</span><span>${n.from ? 'з ' + fmtDate(n.from) : 'від початку'}${
          n.to ? ' по ' + fmtDate(n.to) : ''}</span>
        <span>${esc(n.basis || '')} ${rowBtn('nm-del', '✕ видалити', `data-id="${esc(n.id)}"`, { bad: true, title: 'Видалити цю норму' })}</span></div>`).join('') : '';
    const scope = state.sub;
    const codesRows = (g.codes || []).map((c) => {
      const it = itemBy.get(c);
      const q = scope ? haveRollup(scope, c) : balCode(c);
      return q ? `<span class="lnk" data-code="${esc(c)}">${esc(c)} ${esc(it ? cleanName(it.name) : '')} — ${fmtNum(q)}</span>` : '';
    }).filter(Boolean).join(' · ');
    return `<div class="st-detail" style="--cols:${cols}">
      <div class="st-detail__head">Штат по підрозділах (станом на ${fmtDate(date)}):</div>
      ${subsRows || '<div class="st-detail__row">Штату за підрозділами немає.</div>'}
      <div class="st-detail__head" style="margin-top:6px">Наявність складається з кодів:</div>
      <div class="st-detail__codes">${codesRows || 'жодного на обліку'}</div>
      ${g.ref ? '' : `<div class="st-detail__row"><span>коди служби рядка:</span>
        <span class="st-detail__codes">${(g.codes || []).map((c) => `${esc(c)}<button type="button" class="ico-btn ico-btn--bad"
          data-act="lc-del" data-line="${esc(key)}" data-code="${esc(c)}" title="Відв’язати код від рядка">✕</button>`).join(' ') || '—'}</span>
        <span><select class="rc-in rc-in--wide" data-lcadd="${esc(key)}"><option value="">+ код служби</option>${items
          .filter((it) => !(g.codes || []).includes(it.code)).map((it) =>
            `<option value="${esc(it.code)}">${esc(it.code)} ${esc(cleanName(it.name))}</option>`).join('')}</select></span>
        <span></span></div>`}
      ${g.ref ? '' : addSub}${ownRows}
      ${g.staffed && !g.ref ? `<div class="st-detail__acts"><button type="button" class="btn btn--sm" data-act="sb-for"
        data-line="${esc(g.line)}" title="Додати правило заміни">⇆ Чим замінити…</button></div>` : ''}${
      isOwnLine(key) && !(g.codes || []).length && !g.staffed ? `<div class="st-detail__acts">${rowBtn('ol-del', '✕ Видалити рядок',
        `data-line="${esc(key)}"`, { bad: true, title: 'Власний рядок без кодів і штату' })}</div>` : ''}</div>`;
  }


  /** Інвентарні номери діапазонами — так їх і наносять, пачкою на підрозділ.
   *  Номери свої, не з ФЕС: у 1С один інвентарний номер накриває кілька
   *  різних активів. Спільний для екрана, відомості й Excel. */
  function inventorySpec() {
    const words = qWords(state.q);
    const q = invQuery(state.q);
    const named = new Map(instances.filter((i) => i.inv).map((i) => [i.inv, i]));
    const nameOf = (r) => (itemBy.get(r.code) || {}).name || r.code;
    const units = (r) => r.to - r.from + 1;
    const serialsIn = (r) => {
      const out = [];
      for (let k = r.from; k <= r.to && out.length < 4; k++) {
        const x = named.get(invNo(r.code, k));
        if (x) out.push(`${invNo(r.code, k)}: зав. № ${x.serial || x.chassis}`);
      }
      return out;
    };
    // Номер із бирки «10201/057» — у який діапазон він потрапляє.
    const rows = inventory.filter((r) => {
      if (q) return r.code === q[0] && r.from <= q[1] && q[1] <= r.to;
      return !words.length || hitAll(words, r.code, nameOf(r), r.sub, serialsOf.get(r.code) || '');
    });
    const holders = subs.filter((sb) => sb.type !== 'бригада' && inventory.some((r) => inSubtree(sb.name, r.sub)));
    return {
      id: 'inv', rows, headSearch: true, allCount: inventory.length, minWidth: '860px',
      filters: [
        { type: 'select', key: 'sub', label: 'підрозділ', all: 'усі', options: holders.map((sb) => [sb.name, sb.name]),
          test: (r, v) => inSubtree(v, r.sub) },
        { type: 'seg', key: 'asset', options: [['', 'усе майно'], ['na', 'необоротні активи'], ['stock', 'запаси']],
          test: (r, v) => assetOf(itemBy.get(r.code) || {}) === v },
        { type: 'toggle', key: 'serial', label: 'із заводськими номерами', test: (r) => serialsIn(r).length > 0 },
      ],
      columns: [
        { key: 'code', label: 'код', cls: 'c-code', first: 1, sort: (r) => r.code, cell: (r) => esc(r.code) },
        { key: 'name', label: 'позиція', cls: 'c-name', first: 1, sort: nameOf,
          cell: (r) => { const m = serialsIn(r); return `<b>${esc(nameOf(r))}</b>${m.length ? `<small>${esc(m.join('; '))}</small>` : ''}`; } },
        { key: 'sub', label: 'підрозділ', cls: 'c-txt', style: 'flex:0 1 220px', first: 1, sort: (r) => r.sub, cell: (r) => esc(r.sub) },
        { key: 'range', label: 'номери', cls: 'c-code', style: 'width:210px;white-space:nowrap', first: 1, sort: (r) => `${r.code}/${String(r.from).padStart(5, '0')}`,
          cell: (r) => `<b>${invNo(r.code, r.from)}</b>${units(r) > 1 ? ` – ${invNo(r.code, r.to)}` : ''}` },
        { key: 'units', label: 'одиниць', cls: 'c-num', sort: units, cell: (r) => String(units(r)) },
        { key: 'acts', label: '', cls: 'c-acts', cell: (r) => `<button type="button" class="ico-btn" data-act="inv-move"
          data-code="${esc(r.code)}" data-v="${r.from}|${r.to}|${esc(r.sub)}" title="Перенести номери в інший підрозділ">⇄</button>` },
      ],
      row: (r) => ({ attrs: `data-code="${esc(r.code)}"`, title: nameOf(r) }),
      total: (shown) => ({ name: '<b>Разом</b>', units: fmtNum(shown.reduce((a, r) => a + units(r), 0), '0') }),
      count: (shown) => `${cnt(shown.reduce((a, r) => a + units(r), 0), 'номер', 'номери', 'номерів')}, ${
        cnt(shown.length, 'діапазон', 'діапазони', 'діапазонів')}`,
      empty: 'Інвентарних номерів ще немає.',
      emptyFiltered: 'За цими фільтрами номерів немає.',
    };
  }

  function renderInventory() {
    const reg = registry(inventorySpec());
    const off = invMismatch();
    const nameOf = (c) => cleanName((itemBy.get(c) || {}).name || c);
    const warn = off.length ? `<div class="flash flash--warn">Номери не там, де майно: накладна кількістю номерів не
      називає, тож після неї номери лишаються у відправника. Перенесіть їх кнопкою ⇄ у рядку діапазону.
      <br>${off.slice(0, 6).map((x) => `${esc(x.code)} ${esc(nameOf(x.code))}, «${esc(x.sub)}»: номерів ${x.n}, числиться ${fmtNum(x.q, '0')}`)
        .join('; ')}${off.length > 6 ? ` і ще ${off.length - 6}` : ''}</div>` : '';
    const need = invShortage();
    const issue = need.length ? `<div class="flash flash--warn" data-inv-need>Без інвентарного номера ${
      cnt(need.reduce((a, r) => a + r.to - r.from + 1, 0), 'одиниця', 'одиниці', 'одиниць')} у ${
      cnt(new Set(need.map((r) => r.code)).size, 'позиції', 'позиціях', 'позиціях')}.
      <button class="btn btn--sm" data-act="inv-issue">Видати номери…</button></div>` : '';
    return {
      fill: true,
      head: head('облік / пооб’єктний', 'Інвентарні номери',
        searchBox('Пошук: код, назва, підрозділ, зав. № або номер 10201/057')
        + '<button class="btn" data-act="print">В Excel</button>'),
      body: `${warn}${issue}${invMoveCard()}${reg.panel}<div class="card card--scroll card--fill">${reg.table}</div>`,
    };
  }

  /** Одиниці на обліку, яким інвентарний номер ще не видано, — план видачі [{code, sub, from, to}].
   *  Номер — на цілу одиницю; нумерація позиції продовжується з останнього виданого. Позиція,
   *  чиї номери стоять не там, де майно, дістає лише те, чого бракує разом: решту переносять ⇄. */
  function invShortage(t = today()) {
    const nums = new Map(), last = new Map(), issued = new Map(), bal = new Map();
    for (const r of inventory) {
      const n = r.to - r.from + 1;
      nums.set(r.code + '|' + r.sub, (nums.get(r.code + '|' + r.sub) || 0) + n);
      issued.set(r.code, (issued.get(r.code) || 0) + n);
      last.set(r.code, Math.max(last.get(r.code) || 0, r.to));
    }
    for (const e of ledger) {
      if (e.d > t) break;
      bal.set(e.code + '|' + e.sub, (bal.get(e.code + '|' + e.sub) || 0) + e.sg * e.q);
    }
    const byCode = new Map();
    for (const [k, q] of bal) {
      const units = Math.floor(round3(q) + 1e-9);
      if (units <= 0) continue;
      const i = k.indexOf('|');
      const code = k.slice(0, i);
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push({ sub: k.slice(i + 1), units, n: nums.get(k) || 0 });
    }
    const order = new Map(subs.map((sb, i) => [sb.name, i]));
    const at = (name) => (order.has(name) ? order.get(name) : 1e9);
    const out = [];
    for (const code of [...byCode.keys()].sort((a, b) => a.localeCompare(b, 'uk', { numeric: true }))) {
      const rows = byCode.get(code).sort((a, b) => at(a.sub) - at(b.sub) || a.sub.localeCompare(b.sub, 'uk'));
      let left = rows.reduce((a, r) => a + r.units, 0) - (issued.get(code) || 0);
      let seq = last.get(code) || 0;
      for (const r of rows) {
        const take = Math.min(left, r.units - r.n);
        if (take <= 0) continue;
        out.push({ code, sub: r.sub, from: seq + 1, to: seq + take });
        seq += take;
        left -= take;
      }
    }
    return out;
  }

  function invIssueOpen() {
    const need = invShortage();
    if (!need.length) { toast('Усі одиниці мають інвентарні номери.'); return; }
    const n = need.reduce((a, r) => a + r.to - r.from + 1, 0);
    const rows = need.map((r) => `<div class="tbl__row tbl__row--plain"><div class="c-code">${esc(r.code)}</div>
      <div class="c-name"><b>${esc(cleanName((itemBy.get(r.code) || {}).name || r.code))}</b></div>
      <div class="c-txt" style="flex:0 1 220px">${esc(r.sub)}</div>
      <div class="c-code" style="width:210px;white-space:nowrap"><b>${invNo(r.code, r.from)}</b>${
        r.to > r.from ? ` – ${invNo(r.code, r.to)}` : ''}</div>
      <div class="c-num">${r.to - r.from + 1}</div></div>`).join('');
    modalOpen('Видати інвентарні номери', `<div class="panel"><div class="panel__note">Номер дістає кожна одиниця на обліку,
        яка його ще не має: ${cnt(n, 'номер', 'номери', 'номерів')}. Нумерація позиції продовжується з останнього виданого.
        Після видачі сформуйте відомість кнопкою «В Excel» і нанесіть номери на майно.</div>
        <div class="panel__spacer"></div><button class="btn btn--primary" data-act="inv-issue-go">Видати ${esc(String(n))}</button></div>
      <div class="tbl" style="--tbl-min:auto"><div class="tbl__head"><div class="tbl__h c-code">код</div><div class="tbl__h c-name">позиція</div>
        <div class="tbl__h c-txt" style="flex:0 1 220px">підрозділ</div><div class="tbl__h c-code" style="width:210px">номери</div>
        <div class="tbl__h c-num">одиниць</div></div>${rows}</div>`);
  }

  /** Видача: діапазони лягають на екран одразу, а в базу — переліком «код, підрозділ, з/по»;
   *  база заводить одиниці реєстру й призначає їм підрозділ. */
  function invIssueGo() {
    const need = invShortage();
    if (!need.length) { modalClose(); return; }
    const date = today();
    for (const r of need) invApplyMove(r.code, r.from, r.to, r.sub);
    store.invIssue = (store.invIssue || []).concat(need.map((r) => ({ code: r.code, sub: r.sub, from: r.from, to: r.to, date })));
    const n = need.reduce((a, r) => a + r.to - r.from + 1, 0);
    logChange('номери видано', 'inv|issue', `${cnt(n, 'номер', 'номери', 'номерів')}: `
      + need.slice(0, 12).map((r) => `${invNo(r.code, r.from)}${r.to > r.from ? ' – ' + invNo(r.code, r.to) : ''} «${r.sub}»`).join('; ')
      + (need.length > 12 ? ` і ще ${need.length - 12}` : ''));
    modalClose();
    save(true, true);
    render();
    toast(`Видано ${cnt(n, 'номер', 'номери', 'номерів')}.`);
  }

  /** Де інвентарних номерів позиції не стільки, скільки там числиться одиниць:
   *  [{code, sub, n, q}]. Лише позиції, яким номери видано. */
  function invMismatch() {
    const numbered = new Set(inventory.map((r) => r.code));
    if (!numbered.size) return [];
    const nums = new Map(), bal = new Map();
    for (const r of inventory) nums.set(r.code + '|' + r.sub, (nums.get(r.code + '|' + r.sub) || 0) + r.to - r.from + 1);
    const t = today();
    for (const e of ledger) {
      if (e.d > t) break;
      if (numbered.has(e.code)) bal.set(e.code + '|' + e.sub, (bal.get(e.code + '|' + e.sub) || 0) + e.sg * e.q);
    }
    const out = [];
    for (const k of new Set([...nums.keys(), ...bal.keys()])) {
      const n = nums.get(k) || 0, q = round3(bal.get(k) || 0);
      if (Math.abs(n - q) < 1e-9) continue;
      // Нові одиниці ще без номера — не розбіжність, а «номер ще не видано».
      if (n < q && ![...nums.keys()].some((x) => x.startsWith(k.slice(0, k.indexOf('|') + 1)) && (nums.get(x) || 0) > round3(bal.get(x) || 0))) continue;
      const i = k.indexOf('|');
      out.push({ code: k.slice(0, i), sub: k.slice(i + 1), n, q });
    }
    return out.sort((a, b) => a.code.localeCompare(b.code, 'uk', { numeric: true }) || a.sub.localeCompare(b.sub, 'uk'));
  }

  /** Перенести інвентарні номери в інший підрозділ: слідом за майном, яке
   *  пішло накладною кількістю. Номери — ті, що на бирках. */
  function invMoveCard() {
    const m = state.invMove;
    if (!m) return '';
    const opts = pickableSubs(m.sub).filter((x) => x.type !== 'бригада' && x.name !== m.was)
      .map((x) => `<option value="${esc(x.name)}"${x.name === m.sub ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    return `<div class="card form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Перенести номери ${esc(invNo(m.code, m.lo))} – ${esc(invNo(m.code, m.hi))}
        з «${esc(m.was)}»</div><div class="panel__spacer"></div>
        <button class="btn" data-act="inv-cancel">Скасувати</button></div>
      <div class="form__grid">
        <div class="field"><label>З номера</label><input data-im="from" inputmode="numeric" value="${esc(String(m.from))}"></div>
        <div class="field"><label>По номер</label><input data-im="to" inputmode="numeric" value="${esc(String(m.to))}"></div>
        <div class="field"><label>Куди</label><select data-im="sub"><option value="">— оберіть —</option>${opts}</select></div>
        <div class="field"><label>З дати</label><input type="date" data-im="date" value="${esc(m.date)}"></div>
        <div class="field field--span2"><label>Підстава</label><input data-im="note" value="${esc(m.note || '')}"
          placeholder="накладна №, дата"></div>
      </div>
      <div class="card__foot"><button class="btn btn--primary" data-act="inv-go">Перенести</button></div></div>`;
  }

  function invMoveGo() {
    const m = state.invMove;
    if (!m) return;
    document.querySelectorAll('[data-im]').forEach((el) => { m[el.dataset.im] = el.value.trim(); });
    const from = parseInt(m.from, 10), to = parseInt(m.to, 10);
    if (!(from >= m.lo && to <= m.hi && from <= to)) { toast(`Номери мають бути в межах ${m.lo}–${m.hi}.`, true); return; }
    if (!m.sub) { toast('Оберіть, куди перенести номери.', true); return; }
    const n = to - from + 1;
    if (!confirm(`Перенести ${cnt(n, 'номер', 'номери', 'номерів')} ${invNo(m.code, from)}${n > 1 ? ' – ' + invNo(m.code, to) : ''} `
      + `з «${m.was}» до «${m.sub}»?`)) return;
    invApplyMove(m.code, from, to, m.sub);
    store.invMoves = (store.invMoves || []).concat([{ code: m.code, from, to, sub: m.sub, date: m.date || today(), note: m.note || '' }]);
    logChange('номери перенесено', 'inv|' + m.code, `${invNo(m.code, from)}${n > 1 ? ' – ' + invNo(m.code, to) : ''}: `
      + `«${m.was}» → «${m.sub}»${m.note ? ', ' + m.note : ''}`);
    state.invMove = null;
    save(true, true);
    render();
  }

  /** Діапазони номерів після перенесення: вирізати з колишнього місця, додати
   *  в нове, сусідні діапазони того самого підрозділу злити. */
  function invApplyMove(code, from, to, sub) {
    const out = [];
    for (const r of inventory) {
      if (r.code !== code || r.to < from || r.from > to) { out.push(r); continue; }
      if (r.from < from) out.push({ code, sub: r.sub, from: r.from, to: from - 1 });
      if (r.to > to) out.push({ code, sub: r.sub, from: to + 1, to: r.to });
    }
    out.push({ code, sub, from, to });
    out.sort((a, b) => a.code.localeCompare(b.code, 'uk', { numeric: true }) || a.from - b.from);
    const merged = [];
    for (const r of out) {
      const last = merged[merged.length - 1];
      if (last && last.code === r.code && last.sub === r.sub && last.to + 1 === r.from) last.to = r.to;
      else merged.push(Object.assign({}, r));
    }
    inventory.length = 0;
    inventory.push(...merged);
  }

  /** Знищене, не списане, у підрозділі з підлеглими (без підрозділу — у бригаді). */
  function destroyedIn(code, scope) {
    return allDestroyed().reduce((a, r) => (r.code === code && (!scope || inSubtree(scope, r.sub))
      && openAt(r, state.asOf) ? a + (+r.qty || 0) : a), 0);
  }

  function renderSupply() {
    const scope = state.sub || rootName();
    // Для норм потрібні й позиції, яких у підрозділі ще немає: «норма 2, наявно 0»
    // — найтиповіший випадок, і ховати такий рядок не можна.
    const list = filteredItems({ keepEmpty: true, book: 'ТЗ' });
    const showDestr = destroyedTotal() > 0;
    const rows = list.map((i) => {
      const own = normOwn(scope, i.code);
      const need = normRollup(scope, i.code);
      const have = haveRollup(scope, i.code);
      const destr = destroyedIn(i.code, state.sub);
      const fact = have - destr;
      const short = Math.max(0, need - fact);
      const over = Math.max(0, fact - need);
      const pct = need ? fact / need : null;
      const cls = pct == null ? 'c-num--dim' : pct >= 1 ? 'num-ok' : pct >= 0.5 ? 'num-warn' : 'num-bad';
      return `<div class="tbl__row" data-item="${i.code}" title="${esc(i.name)}">
        <div class="c-code">${i.code}</div>
        <div class="c-name"><b>${esc(i.name)}</b></div>
        <div class="c-unit">${esc(i.unit)}</div>
        <div class="c-num c-num--input">
          <input class="norm" data-norm="${i.code}" value="${own || ''}" placeholder="—"
            inputmode="decimal" aria-label="штат власний, ${esc(i.name)}"></div>
        <div class="c-num c-num--dim">${fmtNum(need)}</div>
        <div class="c-num c-num--wide">${fmtNum(have)}</div>
        ${showDestr ? `<div class="c-num ${destr ? 'num-bad' : 'c-num--dim'}">${destr ? fmtNum(destr) : '—'}</div>
        <div class="c-num c-num--wide">${fmtNum(fact)}</div>` : ''}
        <div class="c-num c-num--wide ${short ? 'num-bad' : 'c-num--dim'}">${short ? fmtNum(short) : '—'}</div>
        <div class="c-num ${over ? 'num-warn' : 'c-num--dim'}">${over ? fmtNum(over) : '—'}</div>
        <div class="c-num c-num--pct ${cls}">${pct == null ? '—' : Math.round(pct * 100) + '%'}</div>
      </div>`;
    }).join('');

    return {
      fill: true,
      head: head(`штат / ${esc(scope)}`, 'Штат і потреба',
        staffSeg('supply') + searchBox() + actions),
      body: `${filterBar(cnt(list.length, 'позиція', 'позиції', 'позицій'))}${staffBlock()}
        <div class="panel" style="margin-top:14px"><div class="panel__note">
          Нова норма в колонці «штат власний» діє для «${esc(scope)}» з ${fmtDate(state.asOf)}. Норма на код,
          прив’язаний до рядка форми, іде в потребу цього рядка.</div>
          <button class="btn" data-act="nm-terms">${state.normTerms ? 'Сховати строки' : 'Строки норм…'}</button>
          <button class="btn" data-act="norms-demo">Заповнити за наявністю</button>
          <button class="btn btn--danger" data-act="norms-clear">Очистити норми на коди</button></div>
        ${state.normTerms ? normTermsCard(scope) : ''}
        <div class="card card--scroll card--fill"><div class="tbl" style="--tbl-min:${950 + (showDestr ? 158 : 0)}px">
          <div class="tbl__head">
            <div class="tbl__h c-code">код</div>
            <div class="tbl__h c-name">найменування</div>
            <div class="tbl__h c-unit">од.</div>
            <div class="tbl__h c-num c-num--input">штат<br>власний</div>
            <div class="tbl__h c-num">штат<br>сум.</div>
            <div class="tbl__h c-num c-num--wide">наявно</div>
            ${showDestr ? `<div class="tbl__h c-num">знищ.</div>
            <div class="tbl__h c-num c-num--wide">фактично</div>` : ''}
            <div class="tbl__h c-num c-num--wide">некомпл.</div>
            <div class="tbl__h c-num">надлишок</div>
            <div class="tbl__h c-num c-num--pct">забезп.</div>
          </div>${rows}</div></div>`,
    };
  }


  // -------------------------------------------------------------- Картка засобу
  function renderItem() {
    const i = itemBy.get(state.itemCode) || items[0];
    if (!i) return renderNomen();
    const rows = subs.filter((s) => balOf(i.code, s.name) !== 0)
      .map((s) => `<div class="tbl__row" data-sub="${esc(s.name)}" title="${esc(s.name)}">
        <div class="c-name"><b>${esc(s.name)}</b><small>${esc(s.type)}</small></div>
        <div class="c-num c-num--dim">${fmtNum(normOwn(s.name, i.code))}</div>
        <div class="c-num">${fmtNum(balOf(i.code, s.name))}</div>
      </div>`).join('');
    const itemDocs = docs.filter((r) => r.code === i.code);
    const moves = docRows(itemDocs.slice(0, 40), true) + (itemDocs.length > 40 ? `
      <div class="tbl__more"><span class="panel__count">показано 40 останніх із ${itemDocs.length}</span>
        <button type="button" class="btn" data-act="open-j47">Показати всі в Журналі № 47</button></div>` : '');
    const total = balCode(i.code);
    const destr = destroyedOf(i.code, null);
    // Вартість — за партіями, а не «залишок × остання ціна»: одиниця давнього
    // приходу коштує 1 250,00, а не 980,00, за які приходили пізніші.
    let value = 0;
    const prices = new Set();
    for (const [k, arr] of lotsAt(state.asOf)) {
      if (k.slice(k.indexOf('|') + 1) !== i.code) continue;
      for (const l of arr) { value += l.q * l.price; if (Math.abs(l.q) > 1e-9) prices.add(l.price); }
    }

    const op = bookOfItem(i) === 'ОП';
    const spec = op ? [
      ['Код номенклатури', i.code, true],
      ['Група', groupName.get(i.group) || i.group],
      ['Одиниця виміру', i.unit],
      ['Ціна', fmtMoney(i.price) + ' грн', true],
      ['Дободач', i.perRation != null && i.perRation !== '' ? fmtNum(i.perRation) : '—', true],
    ].concat(i.note ? [['Примітка', i.note]] : [])
      .concat(i.archived ? [['В архіві', `з ${fmtDate(i.archived)}: у нових приходах не пропонується`]] : [])
      .map(([k, v, mono]) => `<div><div class="spec__k">${esc(k)}</div>
        <div class="spec__v${mono ? ' spec__v--mono' : ''}">${esc(v)}</div></div>`).join('') : [
      ['Код номенклатури', i.code, true],
      ['Група', `${i.group} · ${groupName.get(i.group) || ''}`],
      ['Одиниця виміру', i.unit],
      ...(codePrices(i.code).length > 1 ? [
        ['Ціни партій на дату', lotPricesText(i.code, null, true) ? lotPricesText(i.code, null, true) + ' грн' : '—', true],
        ['Ціна за останнім приходом', fmtMoney(i.price) + ' грн', true],
      ] : [['Ціна', fmtMoney(i.price) + ' грн', true]]),
      ['Категорія стану', unitCatsText(i.code) || '—', true],
      ['Заводський номер', i.serial || '—', true],
      ['Номер шасі', i.chassis || '—', true],
      ['Рік випуску', i.year || '—', true],
      ['Вид обліку', ASSET[assetOf(i)][2]],
      ['Облік у ФЕС', i.fes ? `${i.nonrev ? 'інвентарний' : 'номенклатурний'} № ${i.fes}`
        : 'не підтверджено, звірте з бухгалтерією', !!i.fes],
      ['Спосіб обліку', i.serial || i.chassis ? "пооб'єктний" : 'кількісний'],
    ].concat(i.old ? [['Старі коди (облік 3.0)', i.old, true]] : [])
      .concat(i.note ? [['Примітка', i.note]] : [])
      .concat(i.archived ? [['В архіві', `з ${fmtDate(i.archived)}: у нових приходах не пропонується`]] : [])
      .map(([k, v, mono]) => `<div><div class="spec__k">${esc(k)}</div>
        <div class="spec__v${mono ? ' spec__v--mono' : ''}">${esc(v)}</div></div>`).join('');

    return {
      head: head(op ? `посуд і миючі / ${groupName.get(i.group) || i.group}` : `номенклатура / ${i.group}`, i.name, `
        <button class="btn" data-act="back">← Назад</button>
        <button class="btn" data-act="item-edit" title="${i.own ? 'Позицію заведено в програмі'
          : 'Код позиції не змінюється'}">Виправити позицію</button>${i.own ? `
        <button class="btn btn--danger" data-act="item-del">Видалити позицію</button>` : ''}
        <button class="btn" data-act="open-j47">Журнал № 47</button>
        <button class="btn btn--primary" data-act="new">+ Новий документ</button>`),
      body: `
      <div class="tiles">
        <div class="tile"><div class="tile__label">Обліковий залишок</div>
          <div class="tile__value">${fmtNum(total, '0')} <small>${esc(i.unit)}</small></div>
          <div class="tile__hint">на ${fmtDate(state.asOf)}</div></div>
        <div class="tile"><div class="tile__label">Знищене, не списане</div>
          <div class="tile__value ${destr ? 'num-bad' : ''}">${fmtNum(destr, '0')}</div>
          <div class="tile__hint">фактично: ${fmtNum(total - destr, '0')}</div></div>
        <div class="tile"><div class="tile__label">Балансова вартість</div>
          <div class="tile__value">${fmtMoney(value)} <small>грн</small></div>
          <div class="tile__hint">${prices.size > 1 ? `${cnt(prices.size, 'партія', 'партії', 'партій')} за різними цінами`
            : `${fmtMoney(prices.size ? [...prices][0] : i.price)} грн за одиницю`}</div></div>
        <div class="tile"><div class="tile__label">Операцій у журналах</div>
          <div class="tile__value">${docs.filter((r) => r.code === i.code).length}</div>
          <div class="tile__hint">останню проведено ${fmtDate((docs.find((r) => r.code === i.code) || {}).d)}</div></div>
      </div>

      <div class="card" style="margin-bottom:12px">
        <div class="card__head"><div class="card__title">Реквізити</div></div>
        <div style="padding:18px"><div class="spec">${spec}</div></div>
      </div>
      ${form2ItemCard(i)}
      ${filesCard('item|' + i.code, 'Фото й документи позиції', 'фото зразка, паспорт, інструкція')}
      ${op ? '' : unitsCard(i)}
      ${docScansCard(i.code)}

      <div class="grid-2">
        <div class="card"><div class="card__head"><div class="card__title">Розподіл по підрозділах</div></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:auto">
            <div class="tbl__head"><div class="tbl__h c-name">підрозділ</div>
              <div class="tbl__h c-num">штат</div><div class="tbl__h c-num">наявно</div></div>
            ${rows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Залишків немає</div></div>'}
          </div></div></div>
        <div class="card"><div class="card__head"><div class="card__title">Рух позиції</div>
            <div class="panel__spacer"></div>
            <span class="panel__count">${cnt(itemDocs.length, 'запис', 'записи', 'записів')}</span></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:560px">
            <div class="tbl__head"><div class="tbl__h c-date">дата</div>
              <div class="tbl__h c-tag">документ</div><div class="tbl__h c-status">стан</div>
              <div class="tbl__h c-code">№</div>
              <div class="tbl__h c-txt">маршрут</div><div class="tbl__h c-num">к-сть</div></div>
            ${moves || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Операцій немає</div></div>'}
          </div></div></div>
      </div>`,
    };
  }

  /** Скани первинних документів, у яких є ця позиція: прихід, накладні, акти.
   *  Паспорт позиції — це й її документи надходження, тож вони видні з картки. */
  function docScansCard(code) {
    const seen = new Set();
    const out = [];
    for (const r of chrono(docs.filter((x) => x.code === code))) {
      const k = keyOfRow(r);
      if (seen.has(k)) continue;
      seen.add(k);
      const list = filesOf(k);
      if (list.length) out.push({ r, k, list });
    }
    if (!out.length) return '';
    // Під одним документом буває кілька файлів (сторінки, накладна й акт) —
    // плитку називає сам файл, документ і маршрут ідуть підписом.
    const tiles = out.map(({ r, k, list }) => {
      const doc = `${r.t || KIND_NAME[r.kind]} ${numNo(r.no)} від ${fmtDate(r.d)}`;
      const route = r.kind === 'wr' && !r.to ? r.from : `${r.from} → ${r.to}`;
      return list.map((f, i) => `<div class="file" data-vw="${i}" data-vw-key="${esc(k)}"
        title="${esc(f.file)}&#10;${esc(doc)} · ${esc(route)}">
        ${native && IMG_EXT.test(f.path) ? `<img class="file__thumb" src="${fileUrl(f.path)}?w=320" loading="lazy" alt="">`
          : `<span class="file__ico">${fileIcon(f.path)}</span>`}
        <span class="file__name">${esc(f.file)}</span>
        <span class="file__meta">${esc(doc)} · ${esc(route)}</span></div>`).join('');
    }).join('');
    return `<div class="card files" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Скани документів із цією позицією</div><div class="panel__spacer"></div>
        <span class="panel__count">${cnt(out.length, 'документ', 'документи', 'документів')} зі сканами</span></div>
      <div class="files__grid">${tiles}</div></div>`;
  }

  /** Окремі одиниці позиції із заводськими номерами: кухні, причепи, цистерни.
   *  До кожної — свої фото (шильдик, стан), бо зав. № і стан у кожної свій. */
  function unitsCard(i) {
    const list = instances.filter((x) => x.code === i.code);
    const ed = state.unitEdit && state.unitEdit.code === i.code ? state.unitEdit : null;
    // Першу одиницю позиції теж заводять тут: без кнопки на порожній картці нова служба
    // не мала чим завести кухню чи причіп із заводським номером.
    if (!list.length && !ed) {
      return i.archived ? '' : `<div class="card" style="margin-bottom:12px" data-units-empty>
      <div class="card__head"><div class="card__title">Одиниці із заводськими номерами</div>
        <span class="panel__count">немає</span><div class="panel__spacer"></div>
        <button type="button" class="btn btn--sm" data-act="un-new" data-code="${esc(i.code)}"
          title="Кухня, причіп, цистерна: завести одиницю з номером, потім назвати її в приході">+ Одиниця</button></div></div>`;
    }
    const form = (x) => `<div class="tbl__row tbl__row--plain unit-form">
        <div class="c-code" style="width:110px">${esc(x.inv || '—')}</div>
        <div class="c-code" style="width:150px"><input class="rc-in rc-in--wide" data-ue="serial" value="${esc(ed.serial)}"
          placeholder="зав. №" autocomplete="off"></div>
        <div class="c-code" style="width:110px"><input class="rc-in rc-in--wide" data-ue="chassis" value="${esc(ed.chassis)}"
          placeholder="шасі" autocomplete="off"></div>
        <div class="c-num"><input class="rc-in" data-ue="year" value="${esc(ed.year || '')}" inputmode="numeric" placeholder="рік"></div>
        <div class="c-num"><select class="rc-in" data-ue="cat" title="Категорія стану">
          <option value="">—</option>${[1, 2, 3, 4, 5].map((c) => `<option${String(ed.cat) === String(c) ? ' selected' : ''}>${c}</option>`).join('')}
          </select></div>
        <div class="c-txt"><input class="rc-in" type="date" data-ue="catDate" value="${esc(ed.catDate || '')}"
          title="З якої дати ця категорія (акт технічного стану)">
          <input class="rc-in rc-in--wide" data-ue="note" value="${esc(ed.note || '')}" placeholder="примітка: паспорт, формуляр, стан"></div>
        <div class="c-acts" style="flex-basis:240px">
          <button type="button" class="btn btn--sm btn--primary" data-act="un-save">Зберегти</button>
          <button type="button" class="btn btn--sm" data-act="un-cancel">Скасувати</button></div>
      </div>`;
    const rows = list.map((x) => {
      if (ed && String(ed.id) === String(x.id)) return form(x);
      const id = x.serial || x.chassis || x.inv;
      const key = `unit|${i.code}|${id}`;
      const files = filesOf(key);
      const cat = catAt(x, state.asOf);
      return `<div class="tbl__row tbl__row--plain">
        <div class="c-code" style="width:110px">${esc(x.inv || '—')}</div>
        <div class="c-code" style="width:150px"><b>${esc(x.serial || '—')}</b></div>
        <div class="c-code" style="width:110px">${esc(x.chassis || '—')}</div>
        <div class="c-num">${x.year || '—'}</div>
        <div class="c-num" title="Категорія стану на ${fmtDate(state.asOf)}">${cat || '—'}</div>
        <div class="c-txt">${esc((x.id ? unitHolderAt(x.id, state.asOf, null) : '') || x.holder || 'ніде не числиться')}<small>${esc(x.note || '')}</small></div>
        <div class="c-acts" style="flex-basis:240px">${files.length
          ? `<button type="button" class="btn btn--sm" data-vw="0" data-vw-key="${esc(key)}" title="Переглянути фото й файли">📷 ${files.length}</button>` : ''}
          ${native ? `<button type="button" class="btn btn--sm" data-act="file-add" data-key="${esc(key)}"
            title="Фото шильдика, стану, формуляр одиниці">+ Фото</button>` : ''}
          ${x.id ? rowBtn('un-edit', '✎ Виправити', `data-id="${esc(x.id)}"`, { title: 'Виправити номер, шасі, рік, категорію стану' }) : ''}</div>
      </div>`;
    }).join('') + (ed && ed.isNew ? form({ inv: '' }) : '');
    return `<div class="card" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Одиниці із заводськими номерами</div>
        <div class="panel__spacer"></div>
        <button type="button" class="btn btn--sm" data-act="un-new" data-code="${esc(i.code)}"
          title="Завести одиницю з номером: потім її можна назвати в приході">+ Одиниця</button></div>
      <div class="card--scroll"><div class="tbl" style="--tbl-min:980px">
        <div class="tbl__head"><div class="tbl__h c-code" style="width:110px" title="Власний номер служби на одиниці">бирка</div>
          <div class="tbl__h c-code" style="width:150px">зав. №</div><div class="tbl__h c-code" style="width:110px">шасі</div>
          <div class="tbl__h c-num">рік</div><div class="tbl__h c-num">кат.</div>
          <div class="tbl__h c-txt">де числиться · примітка</div>
          <div class="tbl__h c-acts" style="flex-basis:240px"></div></div>
        ${rows}</div></div></div>`;
  }

  /** Категорія стану позиції — з одиниць на звітну дату: «2» або «1 — 2 од.; 2 — 3 од.». */
  function unitCatsText(code) {
    const by = new Map();
    for (const u of instances) {
      if (u.code !== code) continue;
      const c = catAt(u, state.asOf);
      if (c) by.set(c, (by.get(c) || 0) + 1);
    }
    if (!by.size) return '';
    if (by.size === 1) return String([...by.keys()][0]);
    return [...by].sort((a, b) => a[0] - b[0]).map(([c, n]) => `${c} — ${n} од.`).join('; ');
  }

  /** Правка одиниці реєстру й нова одиниця: номер, шасі, рік, категорія стану
   *  з датою, примітка. Пишеться в базу разом з усім станом. */
  function unitEditOpen(id, code) {
    const u = id ? unitBy.get(String(id)) : null;
    if (id && !u) return;
    state.unitEdit = u ? { id: String(u.id), code: u.code, serial: u.serial || '', chassis: u.chassis || '',
      year: u.year || '', cat: catAt(u, state.asOf) || '', catDate: state.asOf, note: u.note || '', isNew: false }
      : { id: uid(), code, serial: '', chassis: '', year: '', cat: '', catDate: state.asOf, note: '', isNew: true };
    render();
    $('.unit-form [data-ue="serial"]')?.focus();
  }

  function unitEditSave() {
    const e = state.unitEdit;
    if (!e) return;
    document.querySelectorAll('.unit-form [data-ue]').forEach((el) => { e[el.dataset.ue] = el.value.trim(); });
    const it = itemBy.get(e.code) || {};
    const bad = [];
    if (!e.serial && !e.chassis) bad.push('Вкажіть заводський номер або номер шасі: без номера одиницю не впізнати.');
    const twin = instances.find((x) => x.code === e.code && String(x.id) !== String(e.id)
      && ((e.serial && x.serial === e.serial) || (!e.serial && e.chassis && x.chassis === e.chassis)));
    if (twin) bad.push(`У «${cleanName(it.name || e.code)}» уже є одиниця ${unitLabel(twin)}.`);
    if (e.year && !(/^\d{4}$/.test(e.year) && +e.year >= 1940 && +e.year <= +today().slice(0, 4))) {
      bad.push('Рік випуску — чотири цифри, не пізніше за цей рік.');
    }
    if (e.cat && !e.catDate) bad.push('Вкажіть, з якої дати ця категорія стану.');
    if (bad.length) { alert(bad.join('\n')); return; }
    let u = unitBy.get(String(e.id));
    const before = u ? `${unitLabel(u)}${u.chassis && u.serial ? ', шасі ' + u.chassis : ''}${u.year ? ', ' + u.year : ''}` : '';
    if (!u) {
      u = { code: e.code, inv: '', serial: '', chassis: '', year: 0, cat: 0, holder: '', note: '', id: String(e.id) };
      instances.push(u);
      unitBy.set(String(e.id), u);
      if (!unitsOf.has(e.code)) unitsOf.set(e.code, []);
      unitsOf.get(e.code).push(u);
    }
    // Заводський номер виправили — фото й паспорт одиниці йдуть за ним.
    const oldKey = `unit|${e.code}|${u.serial || u.chassis || u.inv}`;
    Object.assign(u, { serial: e.serial, chassis: e.chassis, year: +e.year || 0, note: e.note });
    const newKey = `unit|${e.code}|${u.serial || u.chassis || u.inv}`;
    if (oldKey !== newKey) {
      if (scans.has(oldKey)) { scans.set(newKey, (scans.get(newKey) || []).concat(scans.get(oldKey))); scans.delete(oldKey); }
      for (const x of store.scans || []) if (x.key === oldKey) x.key = newKey;
    }
    const catNow = catAt(u, e.catDate || state.asOf);
    const catChanged = e.cat && String(e.cat) !== String(catNow);
    if (catChanged) {
      const h = (unitCats.get(String(u.id)) || []).filter(([d]) => d !== e.catDate);
      h.push([e.catDate, +e.cat]);
      h.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      unitCats.set(String(u.id), h);
    }
    store.units = (store.units || []).filter((r) => String(r.id) !== String(e.id));
    store.units.push({ id: String(e.id), code: e.code, serial: e.serial, chassis: e.chassis, year: e.year,
      note: e.note, ...(catChanged ? { cat: +e.cat, catDate: e.catDate } : {}) });
    logChange(e.isNew ? 'одиницю заведено' : 'одиницю виправлено', 'unit|' + e.code,
      `${cleanName(it.name || e.code)}: ${e.isNew ? '' : before + ' → '}${unitLabel(u)}${u.chassis && u.serial ? ', шасі ' + u.chassis : ''}`
      + `${u.year ? ', ' + u.year : ''}${catChanged ? `, категорія ${e.cat} з ${fmtDate(e.catDate)}` : ''}`);
    state.unitEdit = null;
    unitCache.key = null;
    save(true, true);
    render();
    toast(e.isNew ? `Одиницю ${unitLabel(u)} заведено. Її можна назвати в приході.` : `Одиницю ${unitLabel(u)} виправлено.`);
  }

  // ------------------------------------------------------------- скани
  /** Кнопки-посилання на скани; підшиті в програмі мають ✕ — відв'язати. */
  function scanButtons(list) {
    return list.map((x) => (native
      ? `<a class="btn" href="${fileUrl(x.path)}" target="_blank" rel="noopener" title="Відкрити скан">&#128206; ${esc(x.file)}</a>${
        x.mine ? rowBtn('scan-del', '✕ Відв’язати', `data-path="${esc(x.path)}"`, { bad: true, title: 'Відв’язати скан від документа; файл лишиться в теці' }) : ''}`
      : `<span class="btn" title="Скан відкривається в програмі на комп’ютері">&#128206; ${esc(x.file)}</span>`)).join('');
  }

  /** До чого підшивається файл, перетягнутий на поточний екран: документ,
   *  відомість звірки, позиція номенклатури чи інвентаризація. */
  function scanTarget() {
    if (state.view === 'doc' && state.docKey) return fileTarget(state.docKey);
    if (state.view === 'recon' && state.reconId) return fileTarget('recon|' + state.reconId);
    if (PAPER_OF_VIEW[state.view] && state.paperId && !state.paperVer) return fileTarget('paper|' + state.paperId);
    if (state.view === 'item' && state.itemCode) return fileTarget('item|' + state.itemCode);
    if (state.view === 'stocktake' && state.stId && !state.stSub) return fileTarget('st|' + state.stId);
    return null;
  }

  /** Підшити файли (обрані у вікні чи перетягнуті) до документа. Файл
   *  зберігається в теці даних, а в обліку лишається посилання на нього. */
  async function attachScan(t, files) {
    if (!native) { alert('Підшивати скани можна в програмі на комп’ютері.'); return; }
    if (!files) {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = true;
      inp.accept = '.pdf,.jpg,.jpeg,.png,.gif,.bmp,.tif,.tiff,.webp,.heic,.doc,.docx,.xls,.xlsx,.odt,.ods,'
        + '.rtf,.txt,.csv,.zip,.rar,.7z,.p7s,.asice,.asics,.sig';
      inp.addEventListener('change', () => attachScan(t, [...(inp.files || [])]));
      inp.click();
      return;
    }
    let ok = 0;
    for (const f of files) {
      if (f.size > 40 * 1024 * 1024) { toast(`«${f.name}» не підшито: файл більший за 40 МБ.`, true); continue; }
      try {
        const r = await fetch('api/scan', {
          method: 'POST', body: f,
          headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name),
                     'X-Doc-Date': t.date || '', 'X-Doc-No': encodeURIComponent(t.no || ''),
                     'X-Doc-Label': encodeURIComponent(t.label || ''),
                     'X-Folder': encodeURIComponent(t.folder || '') },
        });
        const text = await r.text();
        let j = {};
        try { j = JSON.parse(text); } catch (e) { /* відповідь — текст помилки */ }
        if (!r.ok || !j.ok) throw new Error(j.error || text || `помилка ${r.status}`);
        store.scans = store.scans || [];
        store.scans.push({ key: t.key, date: t.date, no: t.no, file: j.file, path: j.path,
                           mime: f.type || '', size: f.size, added: today() });
        ok++;
      } catch (e) {
        toast(`«${f.name}» не підшито: ${e.message || e}`, true);
      }
    }
    if (ok) {
      logChange('файл підшито', t.key, store.scans.slice(-ok).map((x) => x.file).join('; '));
      save(true);
      toast(`Підшито ${cnt(ok, 'файл', 'файли', 'файлів')}.`);
      render();
    }
  }

  function unlinkScan(path) {
    const x = (store.scans || []).find((y) => y.path === path);
    if (!x) return;
    if (!confirm(`Відв'язати файл «${x.file}»? Сам файл лишиться в теці «Дані обліку/скани».`)) return;
    store.scans = store.scans.filter((y) => y.path !== path);
    logChange('файл відв’язано', x.key, x.file);
    save(true, true);
    render();
    viewerRender();
  }

  /** Файл, перетягнутий на картку документа чи відомості, підшивається одразу. */
  function bindScanDrop() {
    const sc = $('#scroll');
    if (!sc || sc.dataset.drop || !native) return;
    sc.dataset.drop = '1';
    sc.addEventListener('dragover', (e) => {
      if (!scanTarget() || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      sc.classList.add('is-drop');
    });
    sc.addEventListener('dragleave', (e) => { if (e.target === sc) sc.classList.remove('is-drop'); });
    sc.addEventListener('drop', (e) => {
      sc.classList.remove('is-drop');
      const t = scanTarget();
      if (!t || !e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      attachScan(t, [...e.dataTransfer.files]);
    });
  }

  // ------------------------------------------------------------- Документ
  const KIND_NAME = { in: 'Прихід', mv: 'Переміщення', wr: 'Списання' };
  /** Вид операції документа: вибуття з одержувачем поза частиною — передача
   *  (акт ПП в іншу частину), без нього — списання. З балансу йде однаково. */
  const kindName = (r) => (r.kind === 'wr' && r.to ? 'Передача' : KIND_NAME[r.kind]);
  /** «Накладна №17»: після «№» номер точно як у документі. Номер «ТЗ №17» —
   *  помилка самого паперу, але проведений документ так і пишемо: «№ТЗ №17». */
  const numNo = (no) => `№${no ?? ''}`;
  const basisOf = (n) => (String(n || '').match(/підстава: ([^;]+)/) || [])[1] || '';
  const cleanNote = (n) => String(n || '').replace(/(^|; )підстава: [^;]+(; )?/, '$1').replace(/^; /, '');
  /** Номери документів порівнюються без регістру й крайніх пробілів. */
  const normNo = (x) => String(x ?? '').trim().toLowerCase();

  /** Ціна рядка — та, що стоїть у документі; якщо в папері її не було —
   *  облікова ціна довідника. Проведений документ друкується з власною ціною. */
  const priceOfRow = (r) => +r.price || +(itemBy.get(r.code) || {}).price || 0;

  /** Облікова ціна позиції — з останнього приходу з ціною, а без нього та, що
   *  в довіднику бази. Балансова вартість нової позиції з'являється, щойно її
   *  оприбуткували з ціною. */
  function applyPrices() {
    const last = new Map();
    for (const r of docs) {                  // docs ідуть від нових до старих
      if (r.kind === 'in' && +r.price > 0 && !last.has(r.code)) last.set(r.code, +r.price);
    }
    for (const i of items) {
      if (i.basePrice === undefined) i.basePrice = i.price;
      i.price = last.has(i.code) ? last.get(i.code) : i.basePrice;
    }
  }

  // ------------------------------------------------- інша ціна — інший код
  /** Позиція несе одну ціну: майно за іншою ціною — інша позиція зі своїм кодом,
   *  як у книзі служби. Тут — ціни, за якими код оприбутковано, від меншої, без
   *  документа, який саме виправляють. Кілька цін лишилося в кодів, оприбуткованих
   *  до цього правила: такі беруть приходи лише за своїми цінами. */
  function codePrices(code, skipKey = null) {
    const out = new Set();
    for (const r of docs) {
      if (r.kind !== 'in' || r.code !== code || !(+r.price > 0)) continue;
      if (skipKey && keyOfRow(r) === skipKey) continue;
      out.add(Math.round(+r.price * 100) / 100);
    }
    return [...out].sort((a, b) => a - b);
  }

  /** Ціни коду, коли рядок приходу несе іншу; своя чи порожня — null. Ціна, з якою
   *  код уже стоїть у документі, що виправляється, лишається йому; а код, якого
   *  більше ніде не приходували, бере ціну цього документа. */
  function priceClash(ln, skipKey = null) {
    const p = +ln.price || 0;
    if (!ln.code || !(p > 0)) return null;
    const near = (list) => list.some((x) => Math.abs(x - p) < 0.005);
    const others = codePrices(ln.code, skipKey);
    if (!others.length || near(others)) return null;
    const all = skipKey ? codePrices(ln.code) : others;
    return near(all) ? null : all;
  }

  /** Ціни, яких прихід додав би кодові понад одну: те саме правило, що й у базі.
   *  `asked` — ціни коду в документі, `skipKey` — документ, який виправляють
   *  (його попередні ціни кодові вже належать). Порожньо — прихід проходить. */
  function newPrices(code, asked, skipKey = null) {
    const near = (list, p) => list.some((x) => Math.abs(x - p) < 0.005);
    const before = codePrices(code), others = skipKey ? codePrices(code, skipKey) : before;
    const after = others.concat(asked.filter((p) => !near(others, p)));
    return after.length > 1 ? asked.filter((p) => !near(before, p)) : [];
  }

  /** Виправлена ціна коду — в усіх його рядках: у приходах і в накладних та актах,
   *  що назвали партію за цією ціною. Партії ті самі, документи ті самі. Повертає
   *  ключі документів, яких торкнулася зміна. */
  function repriceRows(code, was, now, journals = ['incoming', 'movement', 'writeoffs']) {
    const KIND = { incoming: 'in', movement: 'mv', writeoffs: 'wr' };
    const hit = new Set();
    for (const j of journals) {
      for (const r of store.docs[j] || []) {
        if (String(r[5]) !== String(code) || !(+r[8] > 0) || Math.abs(+r[8] - was) >= 0.005) continue;
        r[8] = now;
        hit.add(docKey(KIND[j], r[0], r[2], r[3], r[4]));
      }
    }
    return [...hit];
  }

  /** Коди, яким виправлення приходу змінило ціну: [[код, була, стала]]. Ціна коду
   *  змінилася, коли інших приходів із ціною в нього немає, а в цьому документі
   *  він і був, і лишився з однією ціною. */
  function priceFixes(oldRows, lines, editedKey) {
    const out = [];
    const one = (list) => {
      const s = [...new Set(list.filter((p) => p > 0).map((p) => p.toFixed(2)))];
      return s.length === 1 ? +s[0] : null;
    };
    for (const code of new Set(oldRows.map((r) => String(r[5])))) {
      const was = one(oldRows.filter((r) => String(r[5]) === code).map((r) => +r[8] || 0));
      const now = one(lines.filter((ln) => ln.code === code).map((ln) => linePrice(ln, 'in')));
      if (was == null || now == null || Math.abs(was - now) < 0.005) continue;
      if (codePrices(code, editedKey).length) continue;
      out.push([code, was, now]);
    }
    return out;
  }

  /** Код для нової позиції тієї самої назви: найближчий вільний після зразка —
   *  у книзі служби такі позиції стоять поруч (10404, 10405). Зайнятий і той, що
   *  колись був кодом книги (старі коди карток). */
  function freeCodeAfter(code) {
    const n = +code;
    if (!Number.isInteger(n) || n <= 0) return nextCode();
    const taken = new Set(items.map((i) => i.code));
    for (const i of items) for (const o of String(i.old || '').split(/[\s,;]+/)) if (o) taken.add(o);
    for (let c = n + 1; c < n + 1000; c++) if (!taken.has(String(c))) return String(c);
    return nextCode();
  }

  /** Акт списання, яким закрито запис про знищення: номер акта з запису,
   *  той самий підрозділ, та сама позиція і дата акта не раніша за подію —
   *  номери актів із року в рік повторюються, і торішній акт №1 не списує
   *  того, що знищено цього року. З кількох таких — найближчий після події.
   *  Рапорт, закритий актом у базі, знаходить свій акт за записом. */
  function writeoffsFor(r) {
    // Знищена одиниця із заводським номером списана лише рядком саме з нею.
    const fits = (x) => x.kind === 'wr' && x.code === r.code && (!r.unit || String(x.unit || '') === String(r.unit));
    if (r.actId) {
      const w = docs.find((x) => x.id === r.actId && fits(x));
      return w ? [w] : [];
    }
    return r.act ? actDocsOf(r, fits) : [];
  }
  const writeoffFor = (r) => writeoffsFor(r)[0] || null;
  /** Акти з номером запису в тому самому підрозділі, не раніші за подію, — по
   *  рядку на документ, від ранішого. Акт, проведений двома частинами, — два
   *  документи з одним номером, і списують вони разом. Підрозділ акта — той, від
   *  якого його склали з запису (actSub), коли майно вже передали звідти, де
   *  його знищили; інакше підрозділ запису. */
  function actDocsOf(r, fits = (x) => x.kind === 'wr') {
    const a = normNo(r.act);
    const from = r.actSub || r.sub;
    const seen = new Set();
    const out = [];
    for (const x of docs) {
      if (!fits(x) || x.from !== from || normNo(x.no) !== a || x.d < r.date) continue;
      const k = keyOfRow(x);
      if (!seen.has(k)) { seen.add(k); out.push(x); }
    }
    return out.sort((p, q) => (p.d < q.d ? -1 : p.d > q.d ? 1 : 0));
  }

  /** Чим списано знищене: «витяг із наказу №15», «акт №3». Вид паперу
   *  знає лише база; для внесеного тут — це акт списання. */
  const actLabel = (r) => (r.act ? `${(r.actType || 'акт').toLowerCase()} ${numNo(r.act)}` : '');

  /** Документ акта для запису про знищення — щоб номер акта відкривав сам акт,
   *  навіть коли цієї позиції в ньому немає. Чужий акт із тим самим номером
   *  (інший підрозділ, раніша дата) не відкривається. */
  function actDocKey(r) {
    const w = r.actId ? docs.find((x) => x.id === r.actId) : r.act ? writeoffFor(r) || actDocsOf(r)[0] : null;
    return w ? keyOfRow(w) : '';
  }

  function openDoc(key) {
    if (!docs.some((r) => keyOfRow(r) === key)) return;
    if (state.view !== 'doc') state.docBack = state.view;
    state.docKey = key;
    go('doc');
  }

  /** Картка одного документа: шапка, усі його рядки, скан і дії з ним. Сюди
   *  ведуть клацання по рядках руху — з картки засобу, зі стрічки операцій, із
   *  журналів 47 і 14; сюди ж відкривається щойно проведений документ. */
  const fesOf = (docId) => (docId ? (store.docFes || {})[String(docId)] || null : null);
  /** Правка статусу ФЕС документа; дата — коли змінився сам статус. */
  function fesSet(docId, patch) {
    store.docFes = store.docFes || {};
    const key = String(docId);
    const was = store.docFes[key] || { status: '', date: '', register: '', ref: '', note: '' };
    const cur = Object.assign({}, was, patch);
    if ('status' in patch && patch.status !== was.status) cur.date = patch.status ? today() : '';
    if (!cur.status) delete store.docFes[key];
    else store.docFes[key] = cur;
    logChange('статус ФЕС', 'fes|' + key, cur.status || 'статус знято');
    save();
  }
  /** Картка «ФЕС» документа: статус, реєстр, витяг. У ще не записаного документа id немає. */
  function fesCard(r0) {
    if (!r0.id) {
      return `<div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">ФЕС</div>
        <div class="panel__spacer"></div><span class="panel__count">статус — після запису документа</span></div></div>`;
    }
    const f = fesOf(r0.id) || {};
    return `<div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">ФЕС</div>
        <div class="panel__spacer"></div>${f.date ? `<span class="panel__count">статус з ${fmtDate(f.date)}</span>` : ''}</div>
      <div class="panel fes-panel">
        <label class="chip${f.status ? ' is-on' : ''}"><span class="chip__label">статус</span>
          <select data-fes="status" data-doc="${r0.id}"><option value="">—</option>${FES_STATUSES.map((st) =>
            `<option${f.status === st ? ' selected' : ''}>${esc(st)}</option>`).join('')}</select></label>
        <label class="chip"><span class="chip__label">реєстр</span>
          <input data-fes="register" data-doc="${r0.id}" value="${esc(f.register || '')}" placeholder="номер і дата реєстру"></label>
        <label class="chip"><span class="chip__label">витяг</span>
          <input data-fes="ref" data-doc="${r0.id}" value="${esc(f.ref || '')}" placeholder="номер витягу чи проводки"></label>
      </div></div>`;
  }

  function renderDoc() {
    const rows = docs.filter((r) => keyOfRow(r) === state.docKey);
    if (!rows.length) { state.view = 'moves'; renderNav(); return renderMoves(); }
    const r0 = rows[0];
    const [cls, lbl] = KIND_TAG[r0.kind];
    const key = esc(state.docKey);
    const basis = basisOf(r0.note);
    let qty = 0, sum = 0, n = 0;
    // Рядок, що зачепив дві партії, показується двома рядками — з ціною кожної:
    // так його прийме й ФЕС.
    const lines = rows.flatMap((r) => rowParts(r).map((p) => ({ r, p }))).map(({ r, p }) => {
      const it = itemBy.get(r.code) || {};
      qty += p.q; sum += p.price * p.q;
      const note = cleanNote(r.note);
      const u = r.unit ? unitBy.get(String(r.unit)) : null;
      const pt = p.d ? `Партія від ${fmtDate(p.d)}` : 'Облікова ціна довідника';
      return `<div class="tbl__row" data-code="${esc(r.code)}" title="${esc(it.name || r.code)}">
        <div class="c-num c-num--dim" style="width:44px">${++n}</div>
        <div class="c-code">${esc(r.code)}</div>
        <div class="c-name"><b>${esc(it.name || 'код ' + r.code)}</b>${
          u ? `<small>${esc(unitLabel(u))}</small>` : ''}</div>
        <div class="c-unit">${esc(it.unit || '')}</div>
        <div class="c-num">${fmtNum(p.q)}</div>
        <div class="c-num c-num--wide${p.d ? '' : ' c-num--dim'}" title="${pt}">${p.price ? fmtMoney(p.price) : '—'}</div>
        <div class="c-num c-num--xwide${p.d ? '' : ' c-num--dim'}" title="${pt}">${p.price ? fmtMoney(p.price * p.q) : '—'}</div>
        <div class="c-txt" title="${esc(note)}">${esc(note)}</div>
      </div>`;
    }).join('');

    const fileKey = state.docKey;
    const sc = filesOf(fileKey);

    const party = { in: ['Постачальник', 'Одержувач'], mv: ['Відправник', 'Одержувач'], wr: ['Підрозділ', 'Кому передано'] }[r0.kind];
    const froms = [...new Set(rows.map((r) => r.from))].join(', ');
    const spec = [
      ['Вид операції', kindName(r0)],
      ['Документ', r0.t || '—'],
      ['Номер', r0.no, true],
      ['Дата', fmtDate(r0.d), true],
      [party[0], froms || '—'],
    ].concat(r0.kind === 'wr' && !r0.to ? [] : [[party[1], r0.to || '—']]).concat([
      ['Підстава', basis || '—'],
      ['Стан', statusText(r0)],
    ]).concat(docNotes.get(r0.id) ? [['Примітка документа', docNotes.get(r0.id)]] : [])
      .map(([k, v, mono]) => `<div><div class="spec__k">${esc(k)}</div>
        <div class="spec__v${mono ? ' spec__v--mono' : ''}">${esc(v)}</div></div>`).join('');

    // Записи про знищення саме цього акта: той самий підрозділ, акт не раніший
    // за подію (тезка з іншого підрозділу чи торішній акт — чужі). Включене до
    // акта, але ним не списане, теж тут — щоб розбіжність було видно.
    const closes = r0.kind === 'wr' ? allDestroyed().filter((x) => (x.actId ? actDocKey(x) === state.docKey
      : x.act && actDocsOf(x).some((w) => keyOfRow(w) === state.docKey))) : [];
    const notDone = closes.filter((x) => x.status !== 'списано').length;
    const closesBlock = closes.length ? `
      <div class="card" style="margin-top:12px">
        <div class="card__head"><div class="card__title">Знищене майно за цим актом</div>
          <div class="panel__spacer"></div>
          <span class="panel__count">${cnt(closes.length, 'запис', 'записи', 'записів')}${
            notDone ? ` · не списано ${notDone}` : ''}</span></div>
        <div class="card--scroll"><div class="tbl" style="--tbl-min:860px">
          <div class="tbl__head"><div class="tbl__h c-date">дата події</div>
            <div class="tbl__h c-txt">підрозділ</div><div class="tbl__h c-code">код</div>
            <div class="tbl__h c-name">найменування</div><div class="tbl__h c-num">к-сть</div>
            <div class="tbl__h c-code">рапорт №</div><div class="tbl__h c-tag">стан</div></div>
          ${closes.map((x) => `<div class="tbl__row" data-code="${esc(x.code)}">
            <div class="c-date">${fmtDate(x.date)}</div><div class="c-txt">${esc(x.sub)}</div>
            <div class="c-code">${esc(x.code)}</div>
            <div class="c-name"><b>${esc((itemBy.get(x.code) || {}).name || '')}</b>${
              x.unit ? `<small>${esc(unitLabel(unitBy.get(String(x.unit))))}</small>` : ''}</div>
            <div class="c-num">${fmtNum(x.qty)}</div><div class="c-code">${esc(x.report || '—')}</div>
            <div class="c-tag">${x.status === 'списано' ? '<span class="tag tag--in">списано</span>'
              : '<span class="tag tag--out" title="Цієї кількості акт не списує: позиції чи кількості в ньому немає">не списано</span>'}</div>
          </div>`).join('')}</div></div></div>` : '';

    const priceHint = 'за цінами партій';
    return {
      head: head(`рух і операції / ${kindName(r0).toLowerCase()}`,
        `${r0.t || KIND_NAME[r0.kind]} ${numNo(r0.no)} від ${fmtDate(r0.d)}`, `
        ${statusTag(docStatus(r0), true)}
        <button class="btn" data-act="doc-back">← Назад</button>
        <button class="btn" data-act="doc-print" data-doc="${key}">В Excel</button>${r0.kind === 'mv' ? `
        <button class="btn" data-act="doc-based" data-v="return" data-doc="${key}"
          title="Зворотна накладна: ${esc(r0.to)} → ${esc(r0.from)}">↩ Повернути</button>` : ''}
        <button class="btn" data-act="doc-based" data-v="copy" data-doc="${key}" title="Новий документ із тими самими рядками">Копія</button>
        <button class="btn" data-act="doc-edit" data-doc="${key}">Виправити</button>
        <button class="btn btn--danger" data-act="doc-del" data-doc="${key}">Видалити</button>`),
      body: `${flashBlock()}
      <div class="tiles">
        <div class="tile"><div class="tile__label">Вид</div>
          <div class="tile__value"><span class="tag ${cls}">${esc(kindName(r0).toLowerCase())}</span></div>
          <div class="tile__hint">${esc(r0.kind === 'wr' && !r0.to ? froms : froms + ' → ' + r0.to)}</div></div>
        <div class="tile"><div class="tile__label">Найменувань</div>
          <div class="tile__value">${rows.length}</div>
          <div class="tile__hint">${fmtNum(qty, '0')} од. разом</div></div>
        <div class="tile"><div class="tile__label">Сума</div>
          <div class="tile__value">${fmtMoney(sum)} <small>грн</small></div>
          <div class="tile__hint">${priceHint}</div></div>
        <div class="tile${native ? ' tile--drop' : ''}"${sc.length ? ` data-vw="0" data-vw-key="${esc(fileKey)}"
            title="Переглянути файли"` : ''}><div class="tile__label">Скан і файли</div>
          <div class="tile__value">${sc.length || '—'}</div>
          <div class="tile__hint">${sc.length ? 'підшито'
            : native ? '<button class="btn btn--sm" data-act="scan-add">+ Підшити скан</button>' : 'не підшито'}</div></div>
      </div>
      <div class="card" style="margin-bottom:12px">
        <div class="card__head"><div class="card__title">Реквізити</div></div>
        <div style="padding:18px"><div class="spec">${spec}</div></div></div>
      ${fesCard(r0)}
      ${filesCard(fileKey, 'Скани й файли документа', 'скан, фото, лист, електронний документ')}
      <div class="card"><div class="card__head"><div class="card__title">Найменування в документі</div></div>
        <div class="card--scroll"><div class="tbl" style="--tbl-min:900px">
          <div class="tbl__head">
            <div class="tbl__h c-num" style="width:44px">№</div><div class="tbl__h c-code">код</div>
            <div class="tbl__h c-name">найменування</div><div class="tbl__h c-unit">од.</div>
            <div class="tbl__h c-num">к-сть</div><div class="tbl__h c-num c-num--wide">ціна, грн</div>
            <div class="tbl__h c-num c-num--xwide">сума, грн</div><div class="tbl__h c-txt">примітка</div>
          </div>${lines}
          <div class="tbl__row tbl__row--plain tbl__row--total">
            <div class="c-num" style="width:44px"></div><div class="c-code"></div>
            <div class="c-name"><b>Разом</b></div><div class="c-unit"></div>
            <div class="c-num">${fmtNum(qty, '0')}</div><div class="c-num c-num--wide"></div>
            <div class="c-num c-num--xwide">${fmtMoney(sum)}</div><div class="c-txt"></div>
          </div>
        </div></div></div>
      ${closesBlock}
      ${historyCard([state.docKey])}`,
    };
  }

  /** Повідомлення про щойно проведений документ. Показується один раз —
   *  далі воно лише заважало б. */
  /** Повідомлення — рядок або { text, btn: { label, act, v?, id? } | { label, nav } }:
   *  із кнопкою наступного кроку, коли він один і очевидний («Провести акт №N»). */
  function flashBlock() {
    if (!state.flash) return '';
    const f = typeof state.flash === 'string' ? { text: state.flash } : state.flash;
    state.flash = null;
    const b = f.btn;
    const btn = b ? `<span><button type="button" class="btn btn--sm btn--primary" ${b.nav
      ? `data-nav="${esc(b.nav)}"` : `data-act="${esc(b.act)}"${b.v != null ? ` data-v="${esc(b.v)}"` : ''}${
        b.id != null ? ` data-id="${esc(b.id)}"` : ''}`}>${esc(b.label)}</button></span>` : '';
    return `<div class="flash${btn ? ' flash--acts' : ''}">${btn ? `<span>${esc(f.text)}</span>${btn}` : esc(f.text)}</div>`;
  }

  // ---------------------------------------------------------------- Документи
  const MOVE_KINDS = [
    ['in', 'Прихід', 'Акт приймання'],
    ['mv', 'Переміщення', 'Накладна'],
    ['wr', 'Вибуття', 'Акт списання'],
    ['dz', 'Знищення', 'Рапорт'],
  ];
  /** Види паперів, що трапляються в журналах служби: вид операції — одне,
   *  а папір — інше (атестат і накладна теж приходять, витяг із наказу теж списує). */
  const DOC_TYPES = {
    in: ['Акт приймання', 'Атестат', 'Накладна', 'Наряд', 'Перенос залишків'],
    mv: ['Накладна', 'Рапорт', 'Наряд'],
    wr: ['Акт списання', 'Акт ПП', 'Акт ПП ОЗ', 'Акт передачі', 'Витяг із наказу', 'Наказ', 'Накладна'],
    dz: ['Рапорт'],
  };

  /** Номер нової накладної — наступний після найбільшого «ТЗ №N»: служба
   *  нумерує накладні наскрізно, не з початку року («ТЗ №17» → «ТЗ №18»). */
  function suggestMvNo() {
    let max = 0;
    for (const r of docs) {
      if (r.kind !== 'mv') continue;
      const m = String(r.no).trim().match(/^ТЗ\s*№\s*(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max ? `ТЗ №${max + 1}` : '';
  }

  /** Рядки стрічки з урахуванням усіх фільтрів — ті самі й на екрані, і у
   *  вивантаженні в Excel. Пошук іде й за підрозділом чи постачальником:
   *  «2 б ТрО» знаходить усе, що туди видавали. */
  function movesFound() {
    const words = qWords(state.q);
    return docs.filter((r) => {
      if (bookOf(r.code) !== state.book) return false;
      if (state.movesFes) {
        const st = (fesOf(r.id) || {}).status || '';
        if (state.movesFes === '-' ? st : st !== state.movesFes) return false;
      }
      if (state.onlyMine && !r.mine) return false;
      if (state.noScan && scansOf(r).length) return false;
      if (state.movesKindF && r.kind !== state.movesKindF) return false;
      if (state.movesFrom && r.d < state.movesFrom) return false;
      if (state.movesTo && r.d > state.movesTo) return false;
      // Підрозділ — з підлеглими: «2 б ТрО» показує й видачі в «2 б ТрО · 4 СР».
      if (state.sub && !inSubtree(state.sub, r.from) && !inSubtree(state.sub, r.to)) return false;
      if (!words.length) return true;
      return hitAll(words, ...docWords(r));
    });
  }
  /** За чим документ шукається: номер, позиція, сторони, вид паперу, а ще
   *  заводський номер одиниці, підстава й примітки рядка та самого документа —
   *  накладну часто пам'ятають саме за кухнею чи за наказом. */
  function docWords(r) {
    const it = itemBy.get(r.code);
    const u = r.unit ? unitBy.get(String(r.unit)) : null;
    return [r.no, r.code, it ? it.name : '', r.from || '', r.to || '', r.t || '', r.note || '',
      u ? [u.serial, u.chassis, u.inv].filter(Boolean).join(' ') : '', docNotes.get(r.id) || ''];
  }

  /** Стрічка документів у порядку, який обрано клацом по заголовку колонки;
   *  без нього — від найновіших. Екран і Excel ідуть одним порядком. */
  const movesSorted = () => sortRows('moves', movesFound(), {
    date: (r) => r.d, kind: (r) => kindName(r), status: (r) => DOC_STATUS[docStatus(r)][0],
    no: (r) => String(r.no), name: (r) => (itemBy.get(r.code) || {}).name || '', route: (r) => `${r.from} ${r.to}`,
    q: (r) => +r.q || 0 });

  function renderMoves() {
    const found = movesSorted();
    const filtered = state.onlyMine || state.noScan || state.movesKindF || state.movesFrom || state.movesTo
      || state.sub || state.q.trim() || state.movesFes;
    const bookDocs = docs.filter((r) => bookOf(r.code) === state.book);
    // Показуємо порціями: сотні рядків одразу гальмують, а обрізати мовчки
    // не можна — старіші документи ставали недосяжними інакше як пошуком.
    const limit = state.movesLimit || 200;
    const shown = found.slice(0, limit);
    const rest = found.length - shown.length;
    const op = state.book === 'ОП';
    // Порожня книга — не те саме, що фільтри, які нічого не лишили.
    const empty = found.length ? '' : bookDocs.length
      ? emptyBlock('⌕', 'Нічого не знайдено', 'Змініть пошуковий запит або скиньте фільтри.',
        '<button class="btn btn--primary" data-act="reset">Скинути фільтри</button>')
      : emptyBlock('⇆', op ? 'Документів посуду й миючих ще немає' : 'Документів ще немає',
        op ? 'Внесіть прихід або перенесіть стару книгу «Облік ОП».' : 'Внесіть перший прихід.',
        (formOpen() ? '' : '<button class="btn btn--primary" data-act="doc-new">+ Новий документ</button>')
        + (op && native ? '<button class="btn" data-act="op-legacy">Перенести стару книгу…</button>' : ''));

    return {
      head: head(op ? 'посуд і миючі / документи' : 'облік / первинні документи', 'Документи',
        // Своя кнопка нового документа, а не спільна: вона ховається, поки
        // форма відкрита, — інакше в шапці стояли дві однакові.
        searchBox('Пошук: номер, код, найменування, підрозділ, зав. №, примітка') + actionsExcel
        + (formOpen() ? '' : '<button class="btn btn--primary" data-act="doc-new">+ Новий документ</button>')),
      body: `
      ${flashBlock()}
      ${formOpen() ? moveForm() : draftsBar()}
      <div class="panel" style="margin-top:12px">
        <!-- Кнопка навмисно не всередині <label>: делегований обробник пропускає
             кліки по мітках, і перемикач у мітці просто не спрацьовував. -->
        <div class="seg" title="Вид документа">${[['', 'усі'], ['in', 'прихід'], ['mv', 'переміщення'], ['wr', 'вибуття']]
          .map(([k, l]) => `<button type="button" data-act="mk" data-v="${k}"${state.movesKindF === k ? ' class="is-on"' : ''}>${l}</button>`).join('')}</div>
        <label class="chip${state.sub ? ' is-on' : ''}"><span class="chip__label">підрозділ</span>
          <select id="f-sub"><option value="">усі</option>
            ${subs.filter((s) => s.used).map((s) => `<option value="${esc(s.name)}"${state.sub === s.name ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select></label>
        <label class="chip${state.movesFrom || state.movesTo ? ' is-on' : ''}">
          <span class="chip__label">дата з</span><input id="mf-from" type="date" value="${esc(state.movesFrom)}">
          <span class="chip__label">по</span><input id="mf-to" type="date" value="${esc(state.movesTo)}"></label>
        <button type="button" class="chip chip--btn${state.onlyMine ? ' is-on' : ''}"
          data-act="only-mine">${state.onlyMine ? '✓ ' : ''}внесені в програмі</button>
        <button type="button" class="chip chip--btn${state.noScan ? ' is-on' : ''}" data-act="no-scan"
          title="Документи без підшитого скану">${state.noScan ? '✓ ' : ''}без скану</button>
        <label class="chip${state.movesFes ? ' is-on' : ''}"><span class="chip__label">ФЕС</span>
          <select id="f-fes"><option value="">усі</option>${FES_STATUSES.map((st) =>
            `<option${state.movesFes === st ? ' selected' : ''}>${esc(st)}</option>`).join('')}
            <option value="-"${state.movesFes === '-' ? ' selected' : ''}>без статусу</option></select></label>
        ${filtered ? '<button type="button" class="chip chip--btn" data-act="reset">Скинути фільтри</button>' : ''}
        <div class="panel__spacer"></div>
        <div class="panel__count">${filtered ? `${docCount(found)} із ${docCount(bookDocs)}`
          : cnt(docCount(bookDocs), 'документ', 'документи', 'документів')}</div>
      </div>
      ${empty || `<div class="card card--scroll card--fill"><div class="tbl" style="--tbl-min:980px;--acts:230px">
        <div class="tbl__head">
          ${sortHead('moves', 'date', 'дата', 'c-date')}${sortHead('moves', 'kind', 'вид', 'c-tag')}${sortHead('moves', 'status', 'стан', 'c-status')}
          ${sortHead('moves', 'no', '№', 'c-code')}${sortHead('moves', 'name', 'найменування', 'c-name')}
          ${sortHead('moves', 'route', 'маршрут', 'c-txt')}${sortHead('moves', 'q', 'к-сть', 'c-num')}
          <div class="tbl__h c-acts"></div>
        </div>${docRows(shown)}${rest > 0 ? `
        <div class="tbl__more">
          <button type="button" class="btn" data-act="more">Показати ще ${Math.min(rest, 200)}</button>
          <span class="panel__count">показано ${shown.length} із ${found.length} рядків</span>
        </div>` : ''}</div></div>`}`,
      fill: true,
    };
  }

  /** Наявність у підрозділі на дату документа, а не на звітну дату.
   *  Видача 10 травня спирається на те, що було 10 травня. */
  /** Знищене, ще не списане, у підрозділі на дату — його вдруге «знищити» не можна. */
  function destroyedAt(code, sub, date) {
    return allDestroyed().reduce((a, r) => (r.code === code && r.sub === sub && openAt(r, date) && !inEditedReport(r)
      ? a + (+r.qty || 0) : a), 0);
  }
  /** Запис рапорту, який саме виправляють: його кількості знову вільні, як і
   *  рядки документа, що виправляється. */
  function inEditedReport(r) {
    const e = state.editingReport;
    if (!e) return false;
    return e.docId ? r.docId === e.docId : e.ids.includes(String(r.id).replace(/~w$/, ''));
  }
  /** Одиниці із заводськими номерами, названі в рапортах і ще не списані. */
  function destroyedUnitsAt(sub, date) {
    return new Set(allDestroyed().filter((r) => r.unit && r.sub === sub && openAt(r, date) && !inEditedReport(r))
      .map((r) => String(r.unit)));
  }

  /** Де позиція числиться на дату — підказка, коли її списують не звідти:
   *  рапорт про знищення часто пишуть за підрозділом, де річ стояла фізично,
   *  а в обліку вона ще на складі. */
  /** Кому вже передавали майно поза частину, а за ними — ті, від кого воно
   *  приходило: частини, з якими служба обмінюється майном, ті самі. */
  function recipients() {
    const seen = new Map();
    for (const r of docs) {
      if (r.kind !== 'wr' || !r.to) continue;
      seen.set(r.to, (seen.get(r.to) || 0) + 1);
    }
    const out = [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'uk')).map(([x]) => x);
    for (const x of senders()) if (!seen.has(x)) out.push(x);
    return out;
  }

  /** Постачальники, від яких уже приходило майно: у прихідному документі їх
   *  вписують руками, і з року в рік це ті самі назви. */
  function senders() {
    const seen = new Map();
    for (const r of docs) {
      if (r.kind !== 'in' || !r.from) continue;
      const key = r.from.trim();
      if (key) seen.set(key, (seen.get(key) || 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'uk')).map(([x]) => x);
  }

  /** Період обліку — за тим, що є в журналах насправді: база може прийти без
   *  жодного документа (облік починають із нуля), і тоді межі дає внесене. */
  function period() {
    const base = D.meta.period || [];
    let lo = base[0] || '', hi = base[1] || '';
    for (const r of docs) {
      if (!r.d) continue;
      if (!lo || r.d < lo) lo = r.d;
      if (!hi || r.d > hi) hi = r.d;
    }
    return [lo, hi];
  }

  /** Найраніша дата документа: початок обліку, а не перший документ бази —
   *  старий папір між ними вносять у режимі історії. */
  const firstDay = () => [unitInfo().opening, period()[0]].filter(Boolean).sort()[0] || '';

  function holdersAt(code, date, skip) {
    const m = new Map();
    for (const e of ledger) {
      if (e.d > date) break;
      if (e.code !== code) continue;
      if (state.editing && ledgerKey(e) === state.editing) continue;
      m.set(e.sub, (m.get(e.sub) || 0) + e.sg * e.q);
    }
    return [...m].filter(([sub, q]) => q > 1e-9 && sub !== skip).sort((a, b) => b[1] - a[1]);
  }

  function availableAt(code, sub, date) {
    let v = 0;
    for (const e of ledger) {
      if (e.d > date) break;
      if (state.editing && ledgerKey(e) === state.editing) continue;
      if (e.code === code && e.sub === sub) v += e.sg * e.q;
    }
    return v;
  }

  /** Чернетка документа живе в стані: форма перемальовується разом із виглядом,
   *  і без цього кожен доданий рядок зникав би на наступному ж перемальовуванні. */
  function draft() {
    const k = state.moveKind;
    const stash = state.drafts || (state.drafts = {});
    // Перемкнули вид документа чи книгу — поточна чернетка відкладається, а не пропадає.
    if (state.draft && (state.draft.kind !== k || (state.draft.book || 'ТЗ') !== state.book)) {
      if (hasContent(state.draft)) stash[slotOf(state.draft.kind, state.draft.book || 'ТЗ')] = state.draft;
      state.draft = null;
    }
    if (!state.draft) {
      const slot = slotOf(k, state.book);
      state.draft = stash[slot] || {
        kind: k,
        book: state.book,
        head: {
          no: '', date: today(), from: k === 'in' ? '' : 'склад',
          to: '', basis: '', report: '', reportDate: '', act: '', note: '',
        },
        lines: [{ code: '', qty: '', price: '', note: '', lot: '' }],
      };
      delete stash[slot];
    }
    return state.draft;
  }

  /** Підказка під найменуванням: одиниця й наявність у відправника на дату
   *  документа. Вона оновлюється на місці — раніше заради неї перемальовувалась
   *  уся форма, і фокус зникав посеред введення дати чи кількості. */
  function lineHint(ln, n, sender, date) {
    const it = itemBy.get(ln.code);
    if (!it) return { html: '', bad: false };
    if (!sender) {
      // Прихід за ціною, якої код не має, — це вже інша позиція: її можна завести звідси.
      const clash = state.moveKind === 'in' ? priceClash(ln, state.editing) : null;
      if (!clash) return { html: `<span class="lines__unit">${esc(it.unit)}</span>`, bad: false };
      return {
        bad: false, price: true,
        html: `<button type="button" class="lines__avail lines__avail--code" data-act="line-code" data-i="${n}"
        title="Код ${esc(it.code)} оприбутковано за ${esc(clash.map(fmtMoney).join('; '))} грн">новий код</button>`,
      };
    }
    const have = lineHave(ln, sender, date);
    const bad = (+ln.qty || 0) > have;
    const at = byLot() && ln.lot ? ` за ${fmtMoney(+ln.price || 0)} грн` : '';
    return {
      bad,
      html: `<button type="button" class="lines__avail${bad ? ' is-bad' : ''}" data-act="line-all" data-i="${n}"
        title="${have > 0 ? 'Узяти всі: ' : ''}${fmtNum(have, '0')} ${esc(it.unit)}${at} у «${esc(sender)}» на ${fmtDate(date)}"
        ${have > 0 ? '' : 'disabled'}>з ${fmtNum(have, '0')} ${esc(it.unit)}</button>`,
    };
  }

  /** Підсумок під формою оновлюється на місці: перемальовувати форму на кожну
   *  цифру не можна — з неї злетить фокус. */
  function refreshSummary() {
    const box = $('.doc-sum');
    if (!box) return;
    const d = draft();
    const form = $('#doc-form');
    const g = (n) => (form?.querySelector(`[name="${n}"]`)?.value ?? '').trim();
    const h = Object.assign({}, d.head, { no: g('no'), date: g('date') || d.head.date,
      from: g('from'), to: g('to') });
    const tmp = document.createElement('div');
    tmp.innerHTML = docSummary(d, h, state.moveKind);
    const next = tmp.firstElementChild;
    if (next) box.replaceWith(next);
  }

  function refreshLineHints() {
    const form = $('#doc-form');
    if (!form) return;
    refreshSummary();
    const d = draft();
    const sender = state.moveKind === 'in' ? '' : d.head.from;
    form.querySelectorAll('.lines__row').forEach((row) => {
      const n = +row.dataset.line, ln = d.lines[n];
      if (!ln) return;
      const { html, bad, price } = lineHint(ln, n, sender, d.head.date);
      row.querySelector('[data-ln="qty"]')?.classList.toggle('is-bad', bad);
      row.querySelector('[data-ln="price"]')?.classList.toggle('is-bad', !!price);
      const av = row.querySelector('.lines__av');
      if (!av) return;
      // Кнопку «з N» оновлюємо на місці, а не замінюємо: заміна між натисканням
      // і відпусканням миші (поле кількості якраз втрачає фокус) з'їдала клац.
      const cur = av.querySelector('.lines__avail');
      const tmp = document.createElement('span');
      tmp.innerHTML = html;
      const next = tmp.querySelector('.lines__avail');
      if (cur && next) {
        cur.textContent = next.textContent;
        cur.title = next.title;
        cur.disabled = next.disabled;
        cur.classList.toggle('is-bad', bad);
      } else if (av.innerHTML !== html) {
        av.innerHTML = html;
      }
    });
  }

  // ------------------------------------------------ підбір найменування в рядок
  /** Найменування в рядок обирають пошуком за назвою чи кодом. У переліку —
   *  лише те, що є у відправника на дату документа, і поруч скільки саме;
   *  для приходу — увесь довідник і кнопка нової позиції. Вибране ставиться в
   *  рядок, курсор — у кількість, а в кінці завжди є порожній рядок для
   *  наступного найменування. */
  const pickLabel = (it) => (it ? it.code + ' · ' + it.name : '');
  /** Накладна й акт списання беруть майно з партії: рядок — позиція й ціна партії.
   *  Одна позиція може стояти кількома рядками, якщо партії чи одиниці різні. */
  const byLot = (k = state.moveKind) => k === 'mv' || k === 'wr';
  /** Одиницю із заводським номером називають і в накладній, і в акті, і в
   *  рапорті про знищення: у папері знищену кухню пишуть її номером. */
  const byUnit = (k = state.moveKind) => byLot(k) || k === 'dz';
  /** Ціна рядка в документі: у приході — своя, а порожня означає облікову ціну
   *  довідника (так написано в бланку); у накладній і акті — ціна названої партії. */
  const linePrice = (ln, k = state.moveKind) => (k === 'in'
    ? +ln.price || +(itemBy.get(ln.code) || {}).price || 0
    : (byLot(k) && ln.lot ? +ln.price || 0 : 0));
  /** Чим рядок відрізняється від сусідніх: позицією, ціною (приходу чи партії) й
   *  одиницею із заводським номером. Однакові — це той самий рядок документа. */
  const lineSpot = (ln, k = state.moveKind) => JSON.stringify([ln.code,
    k === 'in' || (byLot(k) && ln.lot) ? (+ln.price || 0).toFixed(2) : '', String(ln.unit || '')]);
  /** Повний ключ рядка: те саме плюс примітка. Дві кухні з різними примітками —
   *  законні окремі рядки паперу, а два однакових рядки — повтор. */
  const lineKeyOf = (ln, k = state.moveKind) => lineSpot(ln, k) + JSON.stringify(String(ln.note || '').trim());
  const lineLabel = (ln) => {
    const it = itemBy.get(ln && ln.code);
    if (!it) return '';
    const u = ln.unit ? unitBy.get(String(ln.unit)) : null;
    return pickLabel(it) + (u ? ` · ${unitLabel(u)}` : '')
      + (byLot() && ln.lot ? ` · ${fmtMoney(+ln.price || 0)} грн` : '');
  };
  /** Скільки можна взяти в рядок: одиниця із заводським номером — одна, названа
   *  партія — її залишок у відправника без одиниць, інакше — усе, що числиться
   *  за позицією, теж без одиниць: їх видають рядком із номером. */
  function lineHave(ln, sender, date) {
    if (!sender) return 0;
    const dz = state.moveKind === 'dz';
    if (byUnit() && ln.unit) {
      if (unitHolderAt(ln.unit, date) !== sender) return 0;
      return dz && destroyedUnitsAt(sender, date).has(String(ln.unit)) ? 0 : 1;
    }
    const units = byUnit() ? unitsAt(ln.code, sender, date) : [];
    if (byLot() && ln.lot) {
      const price = +ln.price || 0;
      const l = lotChoices(ln.code, sender, date).find((x) => Math.abs(x.price - price) < 0.005);
      return l ? round3(l.q - units.filter((u) => Math.abs(u.price - price) < 0.005).length) : 0;
    }
    // Рапорт: без одиниць із номерами й без знищеного кількістю — одиниці, уже
    // названі в рапортах, з одиниць і так вийшли.
    const gone = dz ? destroyedAt(ln.code, sender, date)
      - units.filter((u) => destroyedUnitsAt(sender, date).has(String(u.id))).length : 0;
    return round3(availableAt(ln.code, sender, date) - units.length - gone);
  }
  const pick = { i: -1, input: null, opts: [], active: 0 };
  const PICK_MAX = 100;
  const emptyLine = () => ({ code: '', qty: '', price: '', note: '', lot: '', unit: '' });

  /** Залишки підрозділу на дату одним проходом: код → кількість. Документ, який
   *  саме виправляють, не рахується — його кількості знову доступні. */
  function stockAt(sub, date) {
    const m = new Map();
    for (const e of ledger) {
      if (e.d > date) break;
      if (e.sub !== sub) continue;
      if (state.editing && ledgerKey(e) === state.editing) continue;
      m.set(e.code, (m.get(e.code) || 0) + e.sg * e.q);
    }
    return m;
  }

  function pickOptions(i, query) {
    const d = draft(), h = d.head, k = state.moveKind;
    const toks = query.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (it) => {
      const hay = (it.code + ' ' + it.name + ' ' + (it.old || '')).toLowerCase();
      return toks.every((t) => hay.includes(t));
    };
    const where = k === 'in' ? (h.to || 'склад') : h.from;
    const st = where ? stockAt(where, h.date || today()) : new Map();
    if (k === 'dz' && where) {
      for (const [code, q] of st) st.set(code, q - destroyedAt(code, where, h.date || today()));
    }
    // Позицію в архіві нових приходів не пропонуємо; видати чи списати те, що
    // ще числиться, можна й з архівної.
    const book = d.book || state.book;
    const pool = (k === 'in' ? items.filter((it) => !it.archived) : items.filter((it) => (st.get(it.code) || 0) > 1e-9))
      .filter((it) => bookOfItem(it) === book);
    // Прихід: та сама позиція буває в акті двічі за різними цінами, тож там
    // позначаємо лише «уже є», а рядок стає окремим.
    const lineOf = new Map();
    d.lines.forEach((ln, n) => { if (ln.code && n !== i) lineOf.set(k === 'in' ? ln.code : lineSpot(ln), n); });
    const used = (ln) => { const n = lineOf.get(k === 'in' ? ln.code : lineSpot(ln)); return n === undefined ? -1 : n; };
    const date = h.date || today();
    // Рапорт: одиниця, уже названа в іншому рапорті, удруге не знищується.
    const gone = k === 'dz' && where ? destroyedUnitsAt(where, date) : new Set();
    const list = [];
    for (const it of pool.filter(match)) {
      // Прихід одиниці з номером, заведеної в реєстрі, яка на дату ніде не
      // числиться: окремий рядок із її номером, одна штука.
      if (k === 'in') {
        for (const u of unitsOf.get(it.code) || []) {
          if (!/^\d+$/.test(String(u.id)) || unitHolderAt(u.id, date)) continue;
          const at = d.lines.findIndex((ln, n) => n !== i && String(ln.unit || '') === String(u.id));
          list.push({ it, qty: 1, unit: { id: u.id, label: unitLabel(u) }, lot: null, line: at });
        }
      }
      // Кожна одиниця із заводським номером — окремий пункт (у накладній, акті й
      // рапорті), а в накладній і акті ще й кожна ціна партії.
      const units = (byUnit() && where && book !== 'ОП' ? unitsAt(it.code, where, date) : [])
        .filter((u) => !gone.has(String(u.id)));
      const lots = byLot() && where && book !== 'ОП' ? lotChoices(it.code, where, date) : [];
      for (const u of units) {
        const lot = byLot() ? { d: u.d, price: u.price } : null;
        list.push({ it, qty: 1, unit: u, lot,
                    line: used({ code: it.code, lot: lot ? lot.d : '', price: lot ? lot.price : '', unit: u.id }) });
      }
      if (!lots.length) {
        // Кількістю — без одиниць із номерами: їх обирають рядком із номером.
        const bulk = round3((st.get(it.code) || 0) - units.length);
        if (k === 'in' || bulk > 1e-9) {
          list.push({ it, qty: k === 'in' ? st.get(it.code) || 0 : bulk, lot: null, line: used({ code: it.code }) });
        }
        continue;
      }
      for (const l of lots) {
        const q = round3(l.q - units.filter((u) => Math.abs(u.price - l.price) < 0.005).length);
        if (q <= 1e-9) continue;              // ця партія вся в одиницях із номерами
        list.push({ it, qty: q, lot: { d: l.d, price: l.price },
                    line: used({ code: it.code, lot: l.d, price: l.price }) });
      }
    }
    return { where, pool: pool.length, toks, list };
  }

  /** Чого немає у відправника — підказка, де воно є. Інакше пошук просто німий:
   *  людина не знає, чи позиції немає в довіднику, чи вона в іншому підрозділі —
   *  а це звичайна річ у рапортах про знищення, де річ стоїть у підрозділі, а в
   *  обліку числиться на складі. */
  function elsewhereHint(query, where, date) {
    const base = `У «${esc(where)}» на ${fmtDate(date)} такого немає`;
    const toks = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length) return base + '. Перевірте відправника й дату документа.';
    const book = (state.draft && state.draft.book) || state.book;
    const hit = items.filter((it) => bookOfItem(it) === book
      && toks.every((t) => (it.code + ' ' + it.name).toLowerCase().includes(t))).slice(0, 3);
    if (!hit.length) return base + ', і в довіднику теж. Перевірте запит.';
    const parts = hit.map((it) => {
      const at = holdersAt(it.code, date, where).slice(0, 3);
      return `«${esc(cleanName(it.name))}» — ${at.length
        ? at.map(([sub, q]) => `${esc(sub)} ${fmtNum(q)}`).join(', ') : 'ніде не числиться'}`;
    });
    return `${base}. На цю дату: ${parts.join('; ')}. Спершу проведіть переміщення звідти.`;
  }

  /** Підсвітка знайдених шматків назви. Екранування йде посимвольно, тож
   *  пошук «quot» не розірве сутність у назві з лапками. */
  function hl(text, toks) {
    const src = String(text), low = src.toLowerCase();
    const on = new Array(src.length).fill(false);
    for (const t of toks) {
      for (let p = low.indexOf(t); p >= 0; p = low.indexOf(t, p + t.length)) {
        for (let j = p; j < p + t.length; j++) on[j] = true;
      }
    }
    let out = '', open = false;
    for (let j = 0; j < src.length; j++) {
      if (on[j] !== open) { out += on[j] ? '<mark>' : '</mark>'; open = on[j]; }
      out += esc(src[j]);
    }
    return out + (open ? '</mark>' : '');
  }

  function pickPop() {
    let el = $('#pick-pop');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pick-pop';
      el.className = 'pick';
      el.setAttribute('role', 'listbox');
      // mousedown, а не click: інакше поле встигає втратити фокус і закрити
      // перелік раніше, ніж вибір зарахується.
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const o = e.target.closest('[data-opt],[data-opt-new]');
        if (!o) return;
        if (o.dataset.optNew) { pickNewItem(); return; }
        const [d, price] = (o.dataset.lot || '').split('|');
        pickChoose(o.dataset.opt, d ? { d, price: +price || 0 } : null,
                   o.dataset.unit ? { id: o.dataset.unit } : null);
      });
      document.body.appendChild(el);
    }
    return el;
  }

  function pickOpen(input) {
    pick.i = +input.dataset.pick;
    pick.input = input;
    pick.active = 0;
    pickRender();
  }

  function pickClose() {
    const el = $('#pick-pop');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    pick.input = null;
    pick.i = -1;
  }

  const pickRestore = (inp) => {
    const ln = draft().lines[+inp.dataset.pick];
    inp.value = lineLabel(ln);
  };

  function pickRender() {
    const inp = pick.input;
    if (!inp || !inp.isConnected) { pickClose(); return; }
    const d = draft(), k = state.moveKind;
    const query = inp.value.trim();
    const { where, pool, toks, list } = pickOptions(pick.i, query);
    pick.opts = list.slice(0, PICK_MAX);
    pick.active = Math.max(0, Math.min(pick.active, pick.opts.length - 1));
    const title = k === 'in'
      ? `Довідник: ${cnt(pool, 'позиція', 'позиції', 'позицій')} · залишок у «${esc(where)}»`
      : where ? `У «${esc(where)}» на ${fmtDate(d.head.date || today())} є ${cnt(pool, 'позиція', 'позиції', 'позицій')}`
        : 'Спершу оберіть, від кого відпускається майно';
    const rows = pick.opts.map((o, n) => `<div class="pick__opt${n === pick.active ? ' is-active' : ''}${
      o.line >= 0 ? ' is-used' : ''}" data-opt="${esc(o.it.code)}"${
      o.lot ? ` data-lot="${esc(o.lot.d + '|' + o.lot.price)}"` : ''}${
      o.unit ? ` data-unit="${esc(o.unit.id)}"` : ''} role="option">
        <span class="pick__code">${esc(o.it.code)}</span>
        <span class="pick__name">${hl(o.it.name, toks)}${o.unit ? ` · <b>${esc(o.unit.label)}</b>` : ''}</span>
        <span class="pick__qty">${o.line >= 0 ? `у рядку ${o.line + 1}`
          : k === 'in' && !o.qty ? '' : fmtNum(o.qty, '0') + ' ' + esc(o.it.unit)}${
          o.lot && o.line < 0 ? ` · ${fmtMoney(o.lot.price)} грн` : ''}</span>
      </div>`).join('');
    const empty = list.length ? '' : `<div class="pick__empty">${k === 'in' ? 'У довіднику такого немає.'
      : where ? elsewhereHint(query, where, d.head.date || today()) : ''}</div>`;
    const more = list.length > PICK_MAX
      ? `<div class="pick__empty">ще ${list.length - PICK_MAX} — уточніть пошук</div>` : '';
    const add = k === 'in' ? `<div class="pick__opt pick__opt--new" data-opt-new="1">+ Нова позиція${
      query ? ` «${esc(query)}»` : ''}</div>` : '';
    const pop = pickPop();
    pop.innerHTML = `<div class="pick__head">${title}${query ? ` · знайдено ${list.length}` : ''}</div>
      <div class="pick__list">${rows}${empty}${more}</div>${add}`;
    // Під полем, а коли внизу тісно — над ним. Позиція фіксована, тож картка
    // форми з overflow:hidden перелік не обрізає.
    const r = inp.getBoundingClientRect();
    const w = Math.min(Math.max(r.width, 560), window.innerWidth - 16);
    const below = window.innerHeight - r.bottom - 10, above = r.top - 10;
    const up = below < 260 && above > below;
    pop.style.display = 'flex';
    pop.style.width = w + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    pop.style.maxHeight = Math.max(160, Math.min(440, up ? above : below)) + 'px';
    pop.style.top = up ? '' : (r.bottom + 3) + 'px';
    pop.style.bottom = up ? (window.innerHeight - r.top + 3) + 'px' : '';
    pop.querySelector('.pick__opt.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  function pickKey(e) {
    const inp = e.target;
    const open = pick.input === inp;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { pickOpen(inp); return; }
      const n = pick.opts.length;
      if (!n) return;
      pick.active = (pick.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      pickRender();
    } else if (e.key === 'Enter') {
      if (e.ctrlKey || e.metaKey) return;            // Ctrl+Enter — провести документ
      e.preventDefault();
      const o = pick.opts[pick.active];
      if (open && o) pickChoose(o.it.code, o.lot, o.unit);
      else if (!open) pickOpen(inp);
    } else if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      pickRestore(inp);
      pickClose();
    } else if (e.key === 'Tab' && !e.shiftKey && open && inp.value.trim() && pick.opts[pick.active]) {
      // Tab із набраним пошуком бере підсвічений рядок, як Enter.
      e.preventDefault();
      const o = pick.opts[pick.active];
      pickChoose(o.it.code, o.lot, o.unit);
    }
  }

  function pickChoose(code, lot = null, unit = null) {
    const i = pick.i;
    const d = draft();
    pickClose();
    if (i < 0 || !d.lines[i]) return;
    const want = { code, lot: lot ? lot.d : '', price: lot ? String(lot.price) : '',
                   unit: unit ? String(unit.id) : '' };
    // Та сама партія (чи та сама одиниця) двічі — це той самий рядок: ведемо до
    // нього. У приході та сама позиція вдруге — окремий рядок паперу зі своєю
    // приміткою; за іншою ціною це вже інша позиція з іншим кодом.
    const inUnit = state.moveKind === 'in' && want.unit;
    const dup = byLot() || (byUnit() && want.unit)
      ? d.lines.findIndex((ln, n) => n !== i && ln.code && lineSpot(ln) === lineSpot(want))
      : inUnit ? d.lines.findIndex((ln, n) => n !== i && String(ln.unit || '') === want.unit) : -1;
    if (dup >= 0) {
      render();
      const q = $(`#doc-form [data-ln="qty"][data-i="${dup}"]`);
      if (q) { q.focus(); q.select(); }
      const u = want.unit ? unitBy.get(want.unit) : null;
      toast(`«${(itemBy.get(code) || {}).name || code}»${u ? `, ${unitLabel(u)},` : ''}`
        + `${want.lot && !u ? ` за ${fmtMoney(+want.price)} грн` : ''} уже є в рядку ${dup + 1}.`);
      return;
    }
    const twice = state.moveKind === 'in' && !inUnit && d.lines.some((ln, n) => n !== i && ln.code === code);
    d.lines[i].code = code;
    if (byLot()) {
      d.lines[i].lot = want.lot;
      d.lines[i].price = want.price;
    }
    if (byUnit() || state.moveKind === 'in') {
      d.lines[i].unit = want.unit;
      if (want.unit) d.lines[i].qty = '1';    // одиниця із заводським номером — одна
    }
    if (i === d.lines.length - 1) d.lines.push(emptyLine());
    render();
    const q = $(`#doc-form [data-ln="qty"][data-i="${i}"]`);
    if (q) { q.focus(); q.select(); }
    if (twice) toast(`«${(itemBy.get(code) || {}).name || code}» уже є в документі. Для іншої ціни заведіть новий код.`);
  }

  /** Прийшло те, чого в довіднику ще немає: заводимо позицію, не гублячи
   *  накладну, — після збереження вона сама стане в цей рядок. */
  function pickNewItem() {
    const i = pick.i;
    const typed = pick.input ? pick.input.value.trim() : '';
    pickClose();
    state.newItem = { code: nextCode(), name: typed, unit: 'шт', group: '21.18', price: '',
                      nonrev: false, forLine: i };
    go('nomen');
    $('#item-form [name="name"]')?.focus();
  }

  /** Прийшло те саме майно за іншою ціною: йому заводиться своя позиція — з тією
   *  самою назвою, одиницею, розділом і номером ФЕС, сусіднім вільним кодом і ціною
   *  рядка. Після збереження вона стає в цей рядок. */
  function newCodeForLine(i) {
    const ln = draft().lines[i];
    const it = ln ? itemBy.get(ln.code) : null;
    if (!it) return;
    pickClose();
    state.newItem = { code: freeCodeAfter(it.code), name: it.name, unit: it.unit, group: it.group,
                      price: String(ln.price ?? ''), nonrev: !!it.nonrev, fes: it.fes || '',
                      forLine: i, like: it.code };
    go('nomen');
    $('#item-form [name="code"]')?.select();
  }

  /** Нова позиція тієї самої назви стає в ті самі рядки табеля, що й зразок:
   *  наявність під штат рядка складається з усіх його кодів. */
  function followLines(code, like) {
    for (const l of reportLines) {
      if (!l.codes.includes(like) || l.codes.includes(code)) continue;
      const key = l.form + '|' + l.line;
      const codes = l.codes.concat([code]).sort();
      lineCodes.set(key, codes);
      l.codes = codes.slice();
      for (const n of normsInit()) if (n.form === l.form && n.line === l.line) n.codes = codes.slice();
      store.lineCodes = store.lineCodes || {};
      store.lineCodes[key] = codes.slice();
    }
  }

  /** Чи показувати форму документа. Вона відкрита, коли документ саме
   *  складають або виправляють; в інший час на екрані журнал, а не бланк. */
  function formOpen() {
    return !!(state.editing || state.formOpen);
  }

  /** Коли форма закрита: рядок про незавершені документи, щоб чернетка не
   *  загубилася, і кнопка почати новий. */
  function draftsBar() {
    const open = Object.entries(state.drafts || {}).filter(([, v]) => hasContent(v));
    if (state.draft && hasContent(state.draft) && !open.some(([k]) => k === state.draft.kind)) {
      open.push([state.draft.kind, state.draft]);
    }
    if (!open.length) return '';
    const what = open.map(([k, v]) => `${KIND_NAME[k] || 'Рапорт'}${v.head.no ? ' ' + numNo(v.head.no) : ''}`
      + (v.head.date ? ` від ${fmtDate(v.head.date)}` : '')).join('; ');
    return `<div class="flash flash--warn" style="margin-bottom:12px">
      <span>${statusTag('draft')} <b>${cnt(open.length, 'незавершений документ', 'незавершені документи',
        'незавершених документів')}</b> у формі: ${esc(what)}.</span>
      <span><button class="btn btn--sm btn--primary" data-act="doc-new" data-v="${esc(open[0][0])}">Дописати</button></span>
    </div>`;
  }

  function moveForm() {
    const k = state.moveKind;
    const isDz = k === 'dz';
    const d = draft();
    const h = d.head;
    // Усі чинні підрозділи, а не лише ті, що вже мали рух: інакше першу видачу
    // в їдальню внести було неможливо — її просто не було в переліку.
    const opts = (sel) => pickableSubs(sel)
      .map((s) => `<option value="${esc(s.name)}"${sel === s.name ? ' selected' : ''}>${esc(s.name)}${
        s.active ? '' : ' · закритий'}</option>`).join('');
    const kindLabel = MOVE_KINDS.find((m) => m[0] === k);
    const sender = k === 'in' ? '' : h.from;
    // Нова накладна одразу з наступним номером; порожнє поле — теж він.
    const no = h.no || (k === 'mv' && !state.editing ? suggestMvNo() : '');

    // Інше майно: назвою, кількістю з одиницею, ціною за рапортом (або без) і
    // документом списання — під рядком, бо акта програми воно не має.
    const otherRow = (ln, n) => `<div class="lines__row lines__row--other" data-line="${n}">
        <div class="lines__no">${n + 1}</div>
        <div class="lines__pick">
          <input data-ln="name" data-i="${n}" value="${esc(ln.name || '')}" placeholder="інше майно: продукти, запаси, майно іншої служби"
            aria-label="інше майно, рядок ${n + 1}" title="Майно, обліку якого програма не веде: у рапорті — назвою, кількістю й ціною">
        </div>
        <div class="lines__qty">
          <input data-ln="qty" data-i="${n}" type="number" min="0" step="any" value="${esc(ln.qty)}" placeholder="к-сть"
            aria-label="кількість, рядок ${n + 1}">
          <input data-ln="uom" data-i="${n}" class="lines__uom" value="${esc(ln.uom || '')}" placeholder="од." aria-label="одиниця, рядок ${n + 1}"></div>
        <div class="lines__price">
          <input data-ln="price" data-i="${n}" type="number" min="0" step="0.0001" value="${esc(ln.price ?? '')}" placeholder="ціна"
            title="Ціна за рапортом чи справою; порожньо — без ціни" aria-label="ціна, рядок ${n + 1}"></div>
        <div class="lines__note">
          <input data-ln="note" data-i="${n}" value="${esc(ln.note || '')}" placeholder="примітка до рядка"></div>
        <button type="button" class="lines__del" data-act="line-del" data-i="${n}"
          title="Видалити рядок"${d.lines.length > 1 ? '' : ' disabled'}>✕</button>
        <div class="lines__off"><span class="lines__off-l">списано</span>
          <input data-ln="offNo" data-i="${n}" value="${esc(ln.offNo || '')}" placeholder="документ №" title="Документ, яким списано це майно"
            aria-label="документ списання, рядок ${n + 1}">
          <input data-ln="offDate" data-i="${n}" type="date" value="${esc(ln.offDate || '')}" max="${today()}" title="Дата списання"
            aria-label="дата списання, рядок ${n + 1}"></div>
      </div>`;
    const lineRow = (ln, n) => {
      if (ln.other) return otherRow(ln, n);
      const { html: hint, bad, price: badPrice } = lineHint(ln, n, sender, h.date);
      const it = itemBy.get(ln.code);
      return `<div class="lines__row" data-line="${n}">
        <div class="lines__no">${n + 1}</div>
        <div class="lines__pick">
          <input data-pick="${n}" value="${esc(lineLabel(ln))}" autocomplete="off" spellcheck="false"
            placeholder="${k === 'in' ? 'назва або код з довідника' : 'назва або код'}"
            aria-label="найменування, рядок ${n + 1}" title="${esc(lineLabel(ln))}">
        </div>
        <div class="lines__qty">
          <input data-ln="qty" data-i="${n}" type="number" min="0" step="${fractionalUnit(it) ? 'any' : '1'}" value="${esc(ln.qty)}"
            class="${bad ? 'is-bad' : ''}" placeholder="к-сть" aria-label="кількість, рядок ${n + 1}"${
            ln.unit ? ' max="1" readonly title="Одиниця із заводським номером — одна"' : ''}>
          <span class="lines__av">${hint}</span></div>
        ${k === 'in' ? `<div class="lines__price">
          <input data-ln="price" data-i="${n}" type="number" min="0" step="0.01" value="${esc(ln.price)}"
            class="${badPrice ? 'is-bad' : ''}" placeholder="${it && it.price ? fmtMoney(it.price) : 'ціна'}"
            title="Якщо порожньо, ціна з довідника" aria-label="ціна, рядок ${n + 1}"></div>` : isDz ? `<div class="lines__price">
          <input data-ln="price" data-i="${n}" type="number" min="0" step="0.0001" value="${esc(ln.price ?? '')}"
            placeholder="за партією" title="Ціна за документом (справа ЄАС, відомість); порожньо — ціна партії"
            aria-label="ціна за документом, рядок ${n + 1}"></div>` : ''}
        <div class="lines__note">
          <input data-ln="note" data-i="${n}" value="${esc(ln.note)}" placeholder="примітка до рядка"></div>
        <button type="button" class="lines__del" data-act="line-del" data-i="${n}"
          title="Видалити рядок"${d.lines.length > 1 ? '' : ' disabled'}>✕</button>
      </div>`;
    };

    return `<form class="card form" id="doc-form">
      <div class="card__head">
        <div class="card__title">${state.editing ? esc(docTitleOf(state.editing))
          : isDz && state.editingReport ? `Рапорт ${esc(numNo(state.editingReport.no))}`
          : d.src && d.src.kind === 'dz' && k === 'wr' ? `Чернетка акта списання ${esc(numNo(no || '—'))}` : 'Новий документ'}
          ${statusTag(state.editing || (isDz && state.editingReport) ? 'editing' : 'draft')}</div>
        <!-- Перемикач стоїть у формі, а не над списком: він задає ВИД документа,
             що вноситься, і ніколи не фільтрував стрічку під ним. -->
        <!-- Чернетка з запису «Знищене майно» — акт, і тільки акт: перемикач виду тут
             підмінив би готовий акт порожнім бланком. -->
        <div class="seg"${d.src && d.src.kind === 'dz' ? ' title="Вид документа визначено записом «Знищене майно»"' : ''}>${MOVE_KINDS
      .filter(([kk]) => kk !== 'dz' || (d.book || 'ТЗ') === 'ТЗ').map(([kk, l]) =>
      `<button type="button" data-kind="${kk}"${state.moveKind === kk ? ' class="is-on"' : ''}${
        d.src && d.src.kind === 'dz' && kk !== k ? ' disabled' : ''}>${l}</button>`).join('')}</div>
        <button type="button" class="chip chip--btn${histOn() ? ' is-on' : ''}" data-act="hist"
          title="Для внесення документів заднім числом">
          <span class="chip__label">режим</span>
          <span class="chip__value">${histOn() ? 'вношу історію' : 'поточна робота'}</span></button>
        <div class="panel__spacer"></div>
        <span class="panel__count">форма: ${esc(kindLabel[2])}</span>
      </div>
      ${d.src && d.src.kind === 'dz' && k === 'wr' && !state.editing ? `<div class="pad" style="padding-top:14px;padding-bottom:0">
        <div class="callout">Чернетку підготовлено із запису «Знищене майно»: рапорт ${esc(numNo(d.src.report || '—'))}${
          d.src.reportDate ? ' від ' + fmtDate(d.src.reportDate) : ''}, «${esc(d.src.sub)}», ${fmtNum(d.src.qty)} од.
          (${cnt(d.src.n, 'запис', 'записи', 'записів')}).
          <button type="button" class="btn btn--sm" data-act="dz-open" data-v="${esc(d.src.report || '')}">Відкрити запис</button>${
            d.src.moved && d.src.moved.stayed ? `<br>Майно за записом числилося за «${esc(d.src.moved.was)}»: ${esc(d.src.moved.why)}.
            Акт лишено від цього підрозділу — перевірте підрозділ і залишок перед проведенням.`
            : d.src.moved ? `<br>Майно за записом числилося за «${esc(d.src.moved.was)}» (${esc(d.src.moved.why)}), тому акт складено від
            «${esc(d.src.moved.to)}», де воно числиться зараз. Підрозділ можна змінити.` : ''}</div></div>` : ''}
      <div class="form__grid">
        <div class="field"><label>Тип документа</label>
          <input name="type" list="dl-doc-type" value="${esc(h.type || kindLabel[2])}" required>
          <datalist id="dl-doc-type">${(DOC_TYPES[k] || []).map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>
        <div class="field"><label>${{ wr: 'Номер акта', dz: 'Номер рапорту' }[k] || 'Номер документа'} <span class="req">*</span></label>
          <input name="no" value="${esc(no)}" placeholder="${{ wr: 'АКТ-2026-001', dz: 'Р-000' }[k] || 'ТЗ2026-001'}" required autocomplete="off"></div>
        <div class="field"><label>${isDz ? 'Дата події' : 'Дата документа'} <span class="req">*</span></label>
          <input name="date" type="date" value="${esc(h.date)}"${firstDay() ? ` min="${firstDay()}"
            title="Не раніше за початок обліку, ${fmtDate(firstDay())}: він стоїть у реквізитах частини («Люди й МВО → Частина»)"` : ''}
            max="${today()}" required></div>
        ${k === 'in' ? `
          <div class="field"><label>Постачальник <span class="req">*</span></label>
            <input name="from" list="dl-cnt" value="${esc(h.from)}" placeholder="в/ч, організація, ТОВ" required>
            <datalist id="dl-cnt">${senders().map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>
          <div class="field"><label>Одержувач</label>
            <select name="to">${opts(h.to || 'склад')}</select></div>`
        : k === 'mv' ? `
          <div class="field"><label>Від кого <span class="req">*</span></label><select name="from">${opts(h.from || 'склад')}</select></div>
          <div class="field"><label>Кому <span class="req">*</span></label><select name="to">
            <!-- Без порожнього пункту браузер мовчки ставив першого в переліку —
                 корінь дерева, і накладна йшла на всю частину, якщо не придивитись. -->
            <option value=""${h.to ? '' : ' selected'}>— оберіть одержувача —</option>${opts(h.to)}</select></div>`
          : `
          <div class="field"><label>Підрозділ <span class="req">*</span></label><select name="from">${opts(h.from || 'склад')}</select></div>
          ${k === 'wr' ? `<div class="field"><label>Кому передано</label>
            <input name="to" list="dl-rcpt" value="${esc(h.to || '')}" placeholder="в/ч, якщо передано в іншу частину" autocomplete="off"
              title="Акт ПП в іншу частину: з балансу майно йде так само, як за актом списання">
            <datalist id="dl-rcpt">${recipients().map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>` : ''}
          ${isDz ? `
          <div class="field"><label>Дата рапорту</label><input name="reportDate" type="date" value="${esc(h.reportDate)}" max="${today()}"></div>
          <div class="field"><label>Єдиний акт списання</label>
            <input name="act" value="${esc(h.act)}" placeholder="номер акта, якщо є"></div>`
            : ''}`}
        <div class="field field--span2"><label>Підстава</label>
          <input name="basis" value="${esc(h.basis)}" placeholder="наказ, рознарядка, рапорт"></div>
        <div class="field field--span2"><label>${isDz ? 'Обставини' : 'Примітка'}</label>
          <textarea name="note" placeholder="${isDz ? 'обставини знищення' : 'необов’язково'}">${esc(h.note)}</textarea></div>
      </div>

      <div class="lines">
        <div class="lines__head">
          <div class="lines__no">№</div>
          <div class="lines__pick">найменування</div>
          <div class="lines__qty">кількість</div>
          ${k === 'in' ? '<div class="lines__price">ціна, грн</div>'
          : isDz ? '<div class="lines__price" title="Ціна за документом (справа ЄАС, відомість); порожньо — ціна партії">ціна за док.</div>' : ''}
          <div class="lines__note">примітка</div>
          <div class="lines__del"></div>
        </div>
        ${d.lines.map(lineRow).join('')}
        <div class="lines__foot">
          <button type="button" class="btn" data-act="line-add">+ Додати найменування</button>${isDz ? `
          <button type="button" class="btn" data-act="line-other"
            title="Продукти, запаси, майно інших служб: у рапорті є, в обліку програми немає">+ Інше майно</button>` : ''}${k === 'in' ? '' : `
          <button type="button" class="btn" data-act="lines-all"
            title="Заповнити рядки залишками на дату документа">${k === 'mv' ? 'Усе майно відправника' : 'Усе майно підрозділу'}</button>`}
          <span class="panel__count">${cnt(d.lines.filter((x) => x.code || (x.other && String(x.name || '').trim())).length, 'найменування', 'найменування', 'найменувань')} у документі</span>
        </div>
      </div>

      ${isDz || (k === 'wr' && !(d.src && d.src.kind === 'dz')) ? `<div class="pad" style="padding-top:14px">
        <div class="callout">${isDz
        ? `Знищене майно <b>продовжує числитися</b> в обліковому залишку, доки не проведено
           акт списання. Акт складається в розділі «Знищене майно» кнопкою «Списати актом…».`
        : `Знищене майно списують із розділу <span class="lnk" data-nav="destroyed">«Знищене майно»</span>:
           там рапорт і кнопка «Списати актом…», яка готує акт сама.`}</div>
      </div>` : ''}
      ${docSummary(d, h, k)}
      <div class="card__foot">
        <button class="btn btn--primary" type="submit" title="Ctrl+Enter">${state.editing || (isDz && state.editingReport)
          ? 'Зберегти виправлення' : isDz ? 'Внести рапорт' : 'Провести документ'}</button>
        ${state.editing || isDz || (d.src && d.src.kind === 'dz') ? '' : `<button class="btn" type="button" data-act="post-next"
          title="Провести цей документ і відкрити бланк наступного (Ctrl+Shift+Enter)">Провести і ввести наступний</button>`}
        ${state.editing || (isDz && state.editingReport) ? '<button class="btn" type="button" data-act="edit-cancel">Скасувати виправлення</button>'
        : `<button class="btn" type="button" data-act="doc-later" title="Чернетка лишиться в програмі до наступного разу">Зберегти чернетку</button>
           <button class="btn" type="button" data-act="draft-clear">Очистити форму</button>`}
        <div class="panel__spacer"></div>
        <span class="panel__count" id="form-msg"></span>
      </div>
    </form>`;
  }

  /** Що саме буде проведено — коротко, перед самою кнопкою.
   *
   *  Проведення міняє залишки: після нього наявність у відправника меншає, а в
   *  одержувача більшає. Людина має бачити це до натискання, а не дізнаватися
   *  з повідомлення після.
   */
  function docSummary(d, h, k) {
    const lines = d.lines.filter((x) => (x.other ? String(x.name || '').trim() : x.code) && +x.qty > 0);
    if (!lines.length) {
      return `<div class="doc-sum doc-sum--empty">Додайте найменування з кількістю.</div>`;
    }
    const units = lines.reduce((a, x) => a + (x.other ? 0 : +x.qty || 0), 0);
    const others = lines.filter((x) => x.other);
    const otherSum = others.reduce((a, x) => a + (String(x.price ?? '').trim() !== '' ? (+x.qty || 0) * (+x.price || 0) : 0), 0);
    const otherText = others.length ? `, інше майно: ${cnt(others.length, 'рядок', 'рядки', 'рядків')}${
      otherSum ? ` на ${fmtMoney(round2(otherSum))} грн` : ''}` : '';
    const route = k === 'in' ? `від «${h.from || '—'}» до «${h.to || 'склад'}»`
      : k === 'wr' ? (h.to ? `з «${h.from || '—'}» до «${h.to}»` : `списання з «${h.from || '—'}»`)
        : k === 'dz' ? `знищене в «${h.from || '—'}»`
          : `з «${h.from || '—'}» до «${h.to || '—'}»`;
    // Виправлення: різниця проти проведеного — та сама, що піде в журнал змін,
    // тільки видно її ДО збереження.
    let diff = '';
    if (state.editing) {
      const o = storeRowsOf(state.editing);
      const ch = editChanges(k, h, lines, o.idx.map((i) => o.arr[i]));
      diff = ch.length ? `<div class="doc-sum__diff"><b>Що зміниться:</b> ${esc(ch.join('; '))}.</div>`
        : '<div class="doc-sum__diff">Проти проведеного нічого не змінено.</div>';
    }
    return `<div class="doc-sum">
      <b>${esc(kindName({ kind: k, to: k === 'wr' ? h.to : '' }) || 'Рапорт')} ${esc(h.no ? numNo(h.no) : '№—')}</b> від ${fmtDate(h.date || today())}
      · ${esc(route)} · ${cnt(lines.length, 'найменування', 'найменування', 'найменувань')},
      ${fmtNum(units)} од.${otherText}${diff}
    </div>`;
  }

  /** Що саме міняє виправлення проти проведеного: дата, номер, сторони,
   *  кількості по кожному найменуванню. Той самий перелік іде і в підсумок
   *  форми, і в журнал змін. */
  function editChanges(k, h, lines, oldRows) {
    const nameOf = (code) => { const it = itemBy.get(code); return it ? cleanName(it.name) : code; };
    const ci = 5, qi = 6, pi = 8, ni = 7;
    const oq = new Map(), nq = new Map();
    for (const r of oldRows) oq.set(r[ci], round3((oq.get(r[ci]) || 0) + (+r[qi] || 0)));
    for (const ln of lines) nq.set(ln.code, round3((nq.get(ln.code) || 0) + (+ln.qty || 0)));
    const o = oldRows[0] || [];
    const ch = [];
    if (o[0] && o[0] !== h.date) ch.push(`дата ${fmtDate(o[0])} → ${fmtDate(h.date)}`);
    if (o[2] != null && String(o[2]).trim() !== h.no) ch.push(`номер ${o[2]} → ${h.no}`);
    if (o[1] != null && h.type && String(o[1]) !== String(h.type)) ch.push(`вид паперу ${o[1]} → ${h.type}`);
    if (o[3] != null && o[3] !== h.from) ch.push(`від кого ${o[3]} → ${h.from}`);
    if (o[4] != null && o[4] !== (h.to || (k === 'in' ? 'склад' : ''))) ch.push(`кому ${o[4] || '—'} → ${h.to || '—'}`);
    for (const c of new Set([...oq.keys(), ...nq.keys()])) {
      const a = oq.get(c) || 0, b = nq.get(c) || 0;
      if (Math.abs(a - b) > 1e-9) ch.push(`${nameOf(c)}: ${fmtNum(a, '0')} → ${fmtNum(b, '0')}`);
    }
    // Та сама кількість, але за іншою ціною — теж зміна: у приході це ціна
    // документа, у накладній і акті — партія, з якої пішло майно.
    const byPrice = (pairs) => {
      const m = new Map();
      for (const [p, q] of pairs) { const key = (+p || 0).toFixed(2); m.set(key, round3((m.get(key) || 0) + q)); }
      return m;
    };
    const text = (m) => [...m].map(([p, q]) => `${fmtNum(q, '0')} × ${fmtMoney(+p)}`).join(', ');
    for (const c of new Set([...oq.keys(), ...nq.keys()])) {
      const mine = lines.filter((ln) => ln.code === c);
      if (Math.abs((oq.get(c) || 0) - (nq.get(c) || 0)) > 1e-9 || !mine.length) continue;
      if (k !== 'in' && mine.some((ln) => !ln.lot)) continue;
      const was = byPrice(oldRows.filter((r) => r[ci] === c).map((r) => [+r[pi] || 0, +r[qi] || 0]));
      const now = byPrice(mine.map((ln) => [linePrice(ln, k), +ln.qty || 0]));
      const same = was.size === now.size && [...was].every(([p, q]) => Math.abs((now.get(p) || 0) - q) < 1e-9);
      if (!same) ch.push(`${nameOf(c)}: ${text(was)} → ${text(now)} грн`);
    }
    // Одиниці із заводськими номерами: видно, яка саме кухня пішла з документа.
    const names = (arr) => arr.map((id) => unitLabel(unitBy.get(id))).filter(Boolean).join(', ');
    const wasU = new Set(oldRows.map((r) => String(rowUnit(k, r) || '')).filter(Boolean));
    const nowU = new Set(lines.filter((ln) => ln.unit).map((ln) => String(ln.unit)));
    const gone = [...wasU].filter((x) => !nowU.has(x)), came = [...nowU].filter((x) => !wasU.has(x));
    if (gone.length) ch.push(`без ${names(gone)}`);
    if (came.length) ch.push(`додано ${names(came)}`);
    // Примітки й підстава — окремим рядком: із них у бланку складається графа.
    // Порівнюються самі тексти, а не кількість рядків: інакше кожна зміна
    // кількості читалася б ще й як зміна приміток.
    const texts = (arr) => [...new Set(arr.filter(Boolean))].sort().join(' | ');
    const oldNotes = texts(oldRows.map((r) => String(r[ni] || '')));
    const newNotes = texts(lines.map((ln) => composeNote(h, ln)));
    if (oldRows.length && oldNotes !== newNotes) ch.push('примітки або підстава');
    return ch;
  }

  // ------------------------------------------------------------- партії
  /** Партії, що лежать у підрозділах: "підрозділ|код" → [{d, price, q}], від
   *  давніх до нових.
   *
   *  Рядок із бази несе свою партію — база розклала рухи від найдавнішої, а
   *  примірник із номером — його власною партією. Рядок, внесений у програмі,
   *  партії не має: для нього береться найдавніша з тих, що є у відправника, як
   *  і в базі. Ціна партії — та, що у ФЕС: одиниця давнього приходу йде по
   *  1 250,00, а не за останньою ціною довідника 980,00.
   *
   *  attach=true ще й записує кожному рядку, які партії він забрав (`r.alloc`):
   *  з цього накладна друкує ціни, а не ціну довідника.
   */
  const KIND_ORDER = { in: 0, mv: 1, wr: 2 };
  function simulateLots(upto, attach, skipKey = null) {
    const lots = new Map();
    const bag = (k) => { let a = lots.get(k); if (!a) { a = []; lots.set(k, a); } return a; };
    const put = (k, d, price, q) => {
      const a = bag(k);
      const same = a.find((x) => x.d === d && Math.abs(x.price - price) < 0.005);
      if (same) { same.q += q; return; }
      a.push({ d, price, q });
      a.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));
    };
    // Одиниця із заводським номером лежить у своїй партії й тримає в ній місце:
    // рядок без номера бере спершу вільне, як і база, а одиниця йде саме зі
    // своєї партії. Інакше видача кількістю забирала партію кухні з номером, і
    // до перезапуску ціни в накладній розходилися з тими, що записала база.
    const held = new Map();                  // одиниця → { k, d, price }
    const sameLot = (x, d, price) => x.d === d && Math.abs(x.price - price) < 0.005;
    const reserved = (k, x) => {
      let n = 0;
      for (const u of held.values()) if (u.k === k && sameLot(x, u.d, u.price)) n++;
      return Math.min(n, x.q);
    };
    const take = (k, q, lot, fallback, unit) => {
      const a = bag(k), out = [];
      const from = (x, t) => {
        x.q -= t; q -= t;
        const p = out.find((o) => sameLot(o, x.d, x.price));
        if (p) p.q += t; else out.push({ d: x.d, price: x.price, q: t });
      };
      const u = unit ? held.get(unit) : null;
      if (unit) held.delete(unit);
      const own = u && u.k === k ? a.find((x) => x.q > 1e-9 && sameLot(x, u.d, u.price)) : null;
      if (own) from(own, Math.min(own.q, q));
      // Названа партія — першою, за нею партії тієї ж ціни (приходів за нею буває
      // кілька), далі від найдавнішої; спершу вільне від одиниць із номерами.
      const order = lot ? a.filter((x) => sameLot(x, lot.d, lot.price))
        .concat(a.filter((x) => !sameLot(x, lot.d, lot.price) && Math.abs(x.price - lot.price) < 0.005)) : [];
      for (const x of a) if (!order.includes(x)) order.push(x);
      for (const free of [true, false]) {
        for (const x of order) {
          if (q <= 1e-9) break;
          const t = Math.min(q, x.q - (free ? reserved(k, x) : 0));
          if (t > 1e-9) from(x, t);
        }
      }
      for (let i = a.length - 1; i >= 0; i--) if (a[i].q <= 1e-9) a.splice(i, 1);
      if (q > 1e-9) {
        // Віддали більше, ніж числилось: мінус лишається в підрозділі, як і в
        // залишку, — його треба бачити, а не губити.
        const d = lot ? lot.d : '', price = lot ? lot.price : fallback;
        put(k, d, price, -q);
        out.push({ d, price, q });
      }
      return out;
    };
    const seq = docs.filter((r) => (!upto || r.d <= upto) && (!skipKey || keyOfRow(r) !== skipKey))
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : KIND_ORDER[a.kind] - KIND_ORDER[b.kind]));
    for (const r of seq) {
      const q = +r.q || 0;
      if (!q) continue;
      const it = itemBy.get(r.code) || {};
      const fallback = +r.price || +it.basePrice || +it.price || 0;
      const lot = r.lot ? { d: r.lot, price: +r.price || fallback } : null;
      let parts;
      const unit = r.unit ? String(r.unit) : '';
      if (r.kind === 'in') {
        const l = lot || { d: r.d, price: fallback };
        put(r.to + '|' + r.code, l.d, l.price, q);
        parts = [{ d: l.d, price: l.price, q }];
        if (unit) held.set(unit, { k: r.to + '|' + r.code, d: l.d, price: l.price });
      } else {
        parts = take(r.from + '|' + r.code, q, lot, fallback, unit);
        if (r.kind === 'mv') for (const p of parts) put(r.to + '|' + r.code, p.d, p.price, p.q);
        if (unit && r.kind === 'mv' && parts[0]) held.set(unit, { k: r.to + '|' + r.code, d: parts[0].d, price: parts[0].price });
      }
      if (attach) r.alloc = parts;
    }
    return lots;
  }
  const lotCache = { key: null, lots: null };
  function lotsAt(date) {
    const key = date + '|' + docs.length + '|' + ledger.length;
    if (lotCache.key !== key) { lotCache.key = key; lotCache.lots = simulateLots(date, false); }
    return lotCache.lots;
  }
  function allocateLots() { lotCache.key = null; formLotCache.key = null; simulateLots('', true); }
  const formLotCache = { key: null, lots: null };
  /** Партії на дату для форми документа — без того документа, який саме
   *  виправляють: його кількості знову вільні, як і в залишку. */
  function lotsForForm(date) {
    const key = date + '|' + (state.editing || '') + '|' + docs.length + '|' + ledger.length;
    if (formLotCache.key !== key) {
      formLotCache.key = key;
      formLotCache.lots = simulateLots(date, false, state.editing || null);
    }
    return formLotCache.lots;
  }
  /** Ціни, за якими позиція лежить у підрозділі на дату: [{d, price, q}], по одній
   *  на ціну (дата — найдавнішого приходу за нею), від давніх до нових. */
  function lotChoices(code, sub, date) {
    const by = new Map();
    for (const l of lotsForForm(date).get(sub + '|' + code) || []) {
      if (l.q <= 1e-9) continue;
      const k = (+l.price || 0).toFixed(2);
      const p = by.get(k);
      if (p) p.q = round3(p.q + l.q); else by.set(k, { d: l.d, price: +l.price || 0, q: l.q });
    }
    return [...by.values()];
  }
  /** Частини рядка за партіями: [{d, price, q}]. */
  const rowParts = (r) => (r.alloc && r.alloc.length ? r.alloc
    : [{ d: '', price: priceOfRow(r), q: +r.q || 0 }]);

  /** Партії позиції на звітну дату за цінами: [{price, q, d}] від найдавнішої,
   *  і вартість разом. Позиція — це 3 × 1 250,00 і 2 × 980,00, а не
   *  «5 × остання ціна»: приходи були різні, і облік це пам'ятає. */
  function lotBreakdown(code, sub = null) {
    const by = new Map();
    let value = 0;
    for (const [k, arr] of lotsAt(state.asOf)) {
      const i = k.indexOf('|');
      if (k.slice(i + 1) !== code || (sub && k.slice(0, i) !== sub)) continue;
      for (const l of arr) {
        if (Math.abs(l.q) <= 1e-9) continue;
        const p = by.get(l.price) || { price: l.price, q: 0, d: l.d };
        p.q += l.q; if (l.d && (!p.d || l.d < p.d)) p.d = l.d;
        by.set(l.price, p); value += l.q * l.price;
      }
    }
    const parts = [...by.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : b.price - a.price));
    return { parts, value: round2(value) };
  }
  /** «3 × 1 250,00; 2 × 980,00» — порожньо, якщо ціна одна. */
  function lotPricesText(code, sub = null, always = false) {
    const { parts } = lotBreakdown(code, sub);
    if (!parts.length || (parts.length < 2 && !always)) return '';
    return parts.map((p) => `${fmtNum(p.q)} × ${fmtMoney(p.price)}`).join('; ');
  }

  // ------------------------------------------- одиниці із заводськими номерами
  /** Кухня, причіп, цистерна з номером ходить по документах окремим рядком: у
   *  накладній пишуть її заводський номер, і облік має знати, де саме ця кухня. Тут —
   *  рухи кожної одиниці за документами, від давніх до нових. */
  const unitsOf = new Map();
  for (const u of instances) {
    if (!u.id) continue;
    if (!unitsOf.has(u.code)) unitsOf.set(u.code, []);
    unitsOf.get(u.code).push(u);
  }
  const unitCache = { key: null, map: null };
  function unitMoves() {
    const key = docs.length + '|' + ledger.length;
    if (unitCache.key !== key) {
      const m = new Map();
      for (const r of docs) {
        if (!r.unit) continue;
        const k = String(r.unit);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      for (const arr of m.values()) {
        arr.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : KIND_ORDER[a.kind] - KIND_ORDER[b.kind]));
      }
      unitCache.key = key;
      unitCache.map = m;
    }
    return unitCache.map;
  }

  /** Де одиниця числиться на дату за документами. Документ, який саме
   *  виправляють, не рахується: його рядки знову вільні, як і в залишку. */
  function unitHolderAt(id, date, skipKey = state.editing) {
    const arr = unitMoves().get(String(id));
    if (!arr) { const u = unitBy.get(String(id)); return u ? u.holder : ''; }
    let holder = '';
    for (const r of arr) {
      if (r.d > date || (skipKey && keyOfRow(r) === skipKey)) continue;
      holder = r.kind === 'wr' ? '' : r.to;
    }
    return holder;
  }

  /** Яким документом одиниця прийшла туди, де вона зараз: із нього партія й ціна. */
  function unitArrival(id, date, skipKey = state.editing) {
    let last = null;
    for (const r of unitMoves().get(String(id)) || []) {
      if (r.d > date || r.kind === 'wr' || (skipKey && keyOfRow(r) === skipKey)) continue;
      last = r;
    }
    return last;
  }

  /** Одиниці позиції, що на дату числяться у відправника: [{id, label, d, price}]. */
  function unitsAt(code, sub, date) {
    if (!sub) return [];
    const out = [];
    for (const u of unitsOf.get(code) || []) {
      if (unitHolderAt(u.id, date) !== sub) continue;
      const r = unitArrival(u.id, date);
      if (!r) continue;                       // за документами одиниця нікуди не приходила
      out.push({ id: u.id, label: unitLabel(u), d: r.lot || r.d, price: +r.price || 0 });
    }
    return out;
  }

  /** Скільки позиції можна видати рядками без номера: усе, що числиться, без
   *  одиниць із заводськими номерами — вони йдуть своїми рядками. */
  function bulkAt(code, sender, date) {
    return round3(availableAt(code, sender, date) - unitsAt(code, sender, date).length);
  }

  // ------------------------------------------------ звірки з підрозділами
  /** Раз на місяць служба звіряє облік із кожним підрозділом, що тримає майно:
   *  узагальнююча відомість (Додаток 1 до Інструкції з обліку військового
   *  майна) — по кожній партії кількість за фінансовим обліком, за обліком
   *  служби й фактично, — підписи обох сторін і запис у журнал результатів
   *  звірки (Додаток 9). Підписані відомості з бази — лише для читання; ті, що
   *  складені тут, зберігаються разом з іншими внесеними даними. */
  const baseRecon = (D.recon || []).map((r) => ({
    id: 'db' + r[0], base: true, sub: r[1], no: r[2], date: r[3], from: r[4], to: r[5],
    title: r[6], signerPos: r[7], signerName: r[8], chiefPos: r[9], chiefName: r[10],
    result: r[11], decision: r[12], note: r[13], status: r[14], source: r[15],
    lines: (r[16] || []).map((l) => ({ code: l[0], name: l[1], uom: l[2], price: l[3],
      fin: l[4], acc: l[5], fact: l[6], note: l[7] })),
  }));
  const responsible = new Map((D.responsible || []).map((r) => [r[0], { name: r[1], pos: r[2] }]));
  const allRecon = () => baseRecon.concat(store.recon || []);
  const reconById = (id) => allRecon().find((r) => r.id === id);
  const reconOrder = (a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : a.date < b.date ? -1 : 1);
  const reconOf = (sub) => allRecon().filter((r) => r.sub === sub).sort(reconOrder);
  const round3 = (x) => Math.round(x * 1000) / 1000;
  const cleanName = (x) => String(x || '').replace(/[ ,]*\d{9,}\s*$/, '').trim();
  const numOrNull = (x) => (x === '' || x == null || !Number.isFinite(+x) ? null : +x);

  /** Підрозділ у родовому відмінку для шапки відомості. Як підрозділи частини
   *  названо в паперах, каже довідник (D.subTitles: шапка відомості й місце в
   *  описі); склад, батальйони, їхні взводи, їдальні й стрілецькі роти названо за
   *  правилами нижче. Решта лишається як є — у відомості цей рядок можна
   *  виправити, і наступна звірка візьме вже виправлений. */
  const subTitles = new Map((D.subTitles || []).map((r) => [r[0], { title: r[1] || '', where: r[2] || '' }]));
  const BAT_GEN = [[/^(\d+) б ТрО$/, '$1 батальйону територіальної оборони'],
    [/^(\d+) б БпС$/, '$1 батальйону безпілотних систем']];
  const UNIT_GEN = { 'ВМТЗ': 'взводу матеріального забезпечення',
    'ВБпАК': 'взводу безпілотних авіаційних комплексів', 'їдальня': 'їдальні' };
  const SUB_GEN = { 'склад': 'складу продовольчої служби' };
  function unitTitle(sub) {
    const own = (subTitles.get(sub) || {}).title;
    if (own) return own;
    const bat = (x) => { for (const [re, t] of BAT_GEN) if (re.test(x)) return x.replace(re, t); return null; };
    const [a, b] = String(sub).split(' · ');
    if (b) {
      const unit = /^\d+ СР$/.test(b) ? b.replace(/^(\d+) СР$/, '$1 стрілецької роти') : (UNIT_GEN[b] || b);
      return `${unit} ${bat(a) || a}`;
    }
    return bat(a) || SUB_GEN[a] || a;
  }

  /** Той самий день місяцем раніше: період звірки служби — з 25-го по 25-те. */
  function monthBefore(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 2, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(d, last));
    return t.toISOString().slice(0, 10);
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

  /** Рядки відомості з обліку: партії підрозділу на дату. Знищене, ще не
   *  списане, фактично відсутнє — воно віднімається від «фактично» й пояснюється
   *  в примітці (рапорт, акт), як того й вимагає графа 8. */
  function reconLines(sub, date) {
    const out = [];
    for (const [k, arr] of lotsAt(date)) {
      const i = k.indexOf('|');
      if (k.slice(0, i) !== sub) continue;
      const code = k.slice(i + 1);
      const byPrice = new Map();
      for (const l of arr) byPrice.set(l.price, (byPrice.get(l.price) || 0) + l.q);
      const it = itemBy.get(code) || {};
      for (const [price, q] of byPrice) {
        if (Math.abs(q) < 1e-9) continue;
        out.push({ code, name: cleanName(it.name || code), uom: it.unit || '', price,
                   fin: null, acc: round3(q), fact: round3(q), note: '' });
      }
    }
    out.sort((a, b) => a.code.localeCompare(b.code, 'uk', { numeric: true }) || b.price - a.price);
    const gone = allDestroyed().filter((x) => !x.other && x.sub === sub && openAt(x, date));
    for (const code of new Set(gone.map((x) => x.code))) {
      const recs = gone.filter((x) => x.code === code);
      const why = recs.map((x) => `знищено ${fmtNum(x.qty)} од. ${fmtDate(x.date)}`
        + `${x.report ? ', рапорт ' + numNo(x.report) : ''}${x.act ? ', акт ' + numNo(x.act) + ' не проведено' : ', акта немає'}`)
        .join('; ');
      const mine = out.filter((l) => l.code === code);
      const cut = (ln, q) => {
        const t = Math.min(q, Math.max(0, ln.fact));
        if (t > 0) { ln.fact = round3(ln.fact - t); ln.note = why; }
        return t;
      };
      // Знищена одиниця з номером — зі своєї партії; решта — від найдавнішої, як
      // її й спише акт без названої партії. Раніше знищене віднімалося від
      // найдорожчої: відомість і проведений потім акт розходилися в цінах, і
      // наступна звірка показувала нестачу однієї ціни й лишок іншої.
      let left = 0;
      for (const x of recs) {
        const came = x.unit ? unitArrival(x.unit, date, null) : null;
        const ln = came && mine.find((l) => Math.abs(l.price - (+came.price || 0)) < 0.005);
        left = round3(left + (+x.qty || 0) - (ln ? cut(ln, +x.qty || 0) : 0));
      }
      const lots = (lotsAt(date).get(sub + '|' + code) || []).slice()
        .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
      for (const l of lots) {
        if (left <= 1e-9) break;
        const ln = mine.find((x) => Math.abs(x.price - l.price) < 0.005);
        if (ln) left = round3(left - cut(ln, Math.min(left, Math.max(0, l.q))));
      }
      for (const ln of mine) if (left > 1e-9) left = round3(left - cut(ln, left));
    }
    return out;
  }

  const lineDiff = (l) => (l.fin != null && Math.abs(l.fin - l.acc) > 1e-9)
    || (l.fact != null && Math.abs(l.fact - l.acc) > 1e-9);
  function reconResult(r) {
    const diff = r.lines.filter(lineDiff);
    const noFes = r.lines.some((l) => l.fin == null);
    if (!diff.length) return noFes ? 'Розбіжностей з фактичною наявністю немає; з фінансовим обліком не звірено'
      : 'Розбіжностей немає';
    return diff.map((l) => `${l.name}${l.price ? ` (${fmtMoney(l.price)} грн)` : ''}: `
      + `${l.fin != null && Math.abs(l.fin - l.acc) > 1e-9 ? `за ФЕС ${fmtNum(l.fin, '0')}, ` : ''}`
      + `за обліком ${fmtNum(l.acc, '0')}, фактично ${fmtNum(l.fact, '0')}${l.note ? ' — ' + l.note : ''}`)
      .join('; ');
  }

  /** Стан звірки підрозділу: остання відомість і скільки днів минуло. */
  function reconStatus(sub) {
    const list = reconOf(sub);
    const last = list[list.length - 1] || null;
    const days = last ? daysBetween(last.to, today()) : null;
    let kind = 'due';
    if (last && last.status !== 'підписано') kind = 'draft';
    else if (last && days <= 31) kind = 'ok';
    return { last, days, kind };
  }

  /** Підрозділи, з якими звіряються: ті, що на дату тримають майно, і ті, з ким
   *  звірка вже була. Тип вузла не важить: ФЄС теж тримає майно (скажімо,
   *  єврокуб за накладною) і має МВО, а майно на самому вузлі бригади — помилка
   *  документа, яку краще бачити, ніж ховати. */
  function reconSubs(date) {
    const hold = new Map();
    for (const e of ledger) {
      if (e.d > date) break;
      const h = hold.get(e.sub) || { units: 0, codes: new Map() };
      h.units += e.sg * e.q;
      h.codes.set(e.code, (h.codes.get(e.code) || 0) + e.sg * e.q);
      hold.set(e.sub, h);
    }
    const withRecon = new Set(allRecon().map((r) => r.sub));
    return subs
      .map((sb) => {
        const h = hold.get(sb.name);
        const pos = h ? [...h.codes.values()].filter((v) => Math.abs(v) > 1e-9).length : 0;
        return { sub: sb.name, type: sb.type, pos, units: h ? round3(h.units) : 0 };
      })
      .filter((x) => x.pos || withRecon.has(x.sub));
  }
  const reconDue = () => reconSubs(today()).filter((x) => reconStatus(x.sub).kind !== 'ok').length;

  function nextReconNo() {
    const nums = allRecon().map((r) => parseInt(r.no, 10)).filter((n) => Number.isFinite(n));
    return String((nums.length ? Math.max(...nums) : 0) + 1);
  }

  function reconNew(sub, quiet = false) {
    const date = state.reconDate || today();
    const list = reconOf(sub);
    const prev = list[list.length - 1];
    const any = allRecon().slice().sort(reconOrder).pop();
    const resp = responsible.get(sub);
    const title = (prev && prev.title) || unitTitle(sub);
    // Хто підписує — з довідника «МВО й посадовці» на дату відомості: МВО
    // підрозділу й начальник служби. Звання й посада — ті, що були на цю дату.
    const posRank = (p) => { const at = personAt(p, date); return [at.pos, at.rank].filter(Boolean).join(', '); };
    const mvo = mvoAt(sub, date);
    const chief = officialAt('начальник служби', date);
    const r = {
      id: uid(), sub, no: nextReconNo(), date, to: date,
      from: prev && prev.to < date ? prev.to : monthBefore(date),
      title,
      signerPos: (mvo && posRank(mvo)) || (prev && prev.signerPos) || (resp && resp.pos)
        || `Командир ${title} ${unitGen()}`,
      signerName: (mvo && pSign(mvo)) || (prev && prev.signerName) || (resp && resp.name) || '',
      chiefPos: (chief && posRank(chief)) || (any && any.chiefPos)
        || `Начальник продовольчої служби ${unitGen()}`,
      chiefName: (chief && pSign(chief)) || (any && any.chiefName) || D.meta.chief || '',
      lines: likePrev(reconLines(sub, date), prev), result: '', decision: '', note: '',
      status: 'складено', created: today(),
    };
    store.recon = store.recon || [];
    store.recon.push(r);
    logChange('відомість складено', 'recon|' + r.id, `Відомість №${r.no} · ${sub} на ${fmtDate(date)}`);
    save();
    if (quiet) return r;
    state.flash = `Відомість №${r.no} для «${sub}» на ${fmtDate(date)} складено: `
      + `${cnt(r.lines.length, 'рядок', 'рядки', 'рядків')}. Внесіть дані ФЕС у графу «за фінансовим обліком» `
      + 'і перевірте «фактично».';
    go('recon', { reconId: r.id });
    return r;
  }

  /** Назви, одиниці й порядок рядків — як у попередній відомості цього
   *  підрозділу: її вже підписали, і «Кухня КП-130» не має щомісяця
   *  перетворюватися на «Кухня причіпна КП-130 без паспорта». */
  function likePrev(lines, prev) {
    if (!prev || !prev.lines.length) return lines;
    const at = new Map(), byCode = new Map();
    prev.lines.forEach((l, i) => {
      at.set(l.code + '|' + l.price, i);
      if (!byCode.has(l.code)) byCode.set(l.code, i);
    });
    const pos = (l) => {
      const exact = [...at.entries()].find(([k]) => {
        const [c, p] = [k.slice(0, k.lastIndexOf('|')), +k.slice(k.lastIndexOf('|') + 1)];
        return c === l.code && Math.abs(p - l.price) < 0.05;
      });
      return exact ? exact[1] : byCode.has(l.code) ? byCode.get(l.code) + 0.5 : Infinity;
    };
    for (const l of lines) {
      const i = pos(l);
      if (Number.isFinite(i)) {
        const was = prev.lines[Math.floor(i)];
        l.name = was.name || l.name;
        l.uom = was.uom || l.uom;
      }
      l._pos = i;
    }
    return lines.map((l, k) => [l, k]).sort((a, b) => (a[0]._pos - b[0]._pos) || (a[1] - b[1]))
      .map(([l]) => { delete l._pos; return l; });
  }

  function reconOpen(id) { go('recon', { reconId: id }); }

  /** Відомості для всіх підрозділів, з якими на цю дату ще не складено. */
  function reconAll() {
    const date = state.reconDate || today();
    const todo = reconSubs(date).filter((x) => x.pos
      && !reconOf(x.sub).some((r) => r.to === date));
    if (!todo.length) { toast(`На ${fmtDate(date)} відомості вже складено для всіх підрозділів.`); return; }
    if (!confirm(`Скласти відомості на ${fmtDate(date)} для ${cnt(todo.length, 'підрозділу', 'підрозділів', 'підрозділів')}?\n\n`
      + todo.map((x) => '  • ' + x.sub).join('\n'))) return;
    for (const x of todo) reconNew(x.sub, true);
    state.flash = `Складено ${cnt(todo.length, 'відомість', 'відомості', 'відомостей')} на ${fmtDate(date)}.`;
    render();
  }

  const current = () => (state.reconId ? reconById(state.reconId) : null);
  const editable = (r) => r && !r.base && r.status !== 'підписано';

  function reconFill(key) {
    const r = current();
    if (!editable(r)) return;
    if (key === 'fact') {
      const manual = r.lines.filter((l) => l.fact != null && Math.abs(l.fact - l.acc) > 1e-9).length;
      if (manual && !confirm(`У ${cnt(manual, 'рядку', 'рядках', 'рядках')} «фактично» відрізняється від обліку `
        + '(вписане вручну чи знищене без акта). Замінити на облік?')) return;
    }
    for (const l of r.lines) {
      if (key === 'fin' ? l.fin == null : true) l[key] = l.acc;
      if (key === 'fact') delete l.factSet;
    }
    save(); render();
  }

  /** Облік на дату відомості вже не такий, як у її рядках. */
  /** Підписана відомість, під якою облік уже інший: документ заднім числом у
   *  закритий період проведено з відома людини, але підписаний папір від
   *  цього не змінився — його треба переробити або знати, що він застарів. */
  const signedStale = (r) => !!r && r.status === 'підписано' && !r.base && reconStale(r);

  function reconStale(r) {
    if (!r || r.base) return false;
    const sig = (arr) => arr.filter((l) => !l.extra && !l.left).map((l) => l.code + '|' + l.price + '|' + l.acc).sort().join(';');
    return sig(reconLines(r.sub, r.to)) !== sig(r.lines);
  }

  /** Перескласти рядки з обліку, не гублячи того, що вже вписано руками. */
  function reconSync() {
    const r = current();
    if (!editable(r)) return;
    const was = new Map(r.lines.filter((l) => !l.extra).map((l) => [l.code + '|' + l.price, l]));
    const auto = (l) => /^знищено /.test(l.note || '');
    const fresh = reconLines(r.sub, r.to);
    const now = new Set(fresh.map((l) => l.code + '|' + l.price));
    // Рядки, дописані руками, і ті, що з обліку служби пішли, але вже мають
    // цифри ФЕС, «фактично» чи примітку, лишаються: інакше внесене зникало.
    const keep = r.lines.filter((l) => l.extra || (!now.has(l.code + '|' + l.price)
      && (l.fin != null || l.factSet || (l.note && !auto(l)))))
      .map((l) => (l.extra ? l : Object.assign(l, { acc: 0, left: true })));
    r.lines = likePrev(fresh, { lines: r.lines }).map((l) => {
      const old = was.get(l.code + '|' + l.price);
      if (!old) return l;
      // «Фактично», вписане руками, лишається. Підставлене з обліку (дорівнює
      // обліку чи зменшене на знищене) рахується заново: інакше після нових
      // документів відомість показувала б розбіжність, якої немає.
      const manual = old.factSet || (old.fact != null && Math.abs(old.fact - old.acc) > 1e-9 && !auto(old));
      return Object.assign(l, { fin: old.fin },
        manual ? { fact: old.fact, factSet: true } : {},
        old.note && !auto(old) ? { note: old.note } : {});
    }).concat(keep);
    save();
    toast('Рядки відомості оновлено з обліку, внесене вручну збережено.');
    render();
  }

  function reconAutoResult() {
    const r = current();
    if (!editable(r)) return;
    const auto = reconResult(r);
    if (r.result && r.result.trim() && r.result !== auto
      && !confirm('Замінити текст графи 5 переліком розбіжностей?')) return;
    r.result = auto;
    save(); render();
  }

  function reconSign(on) {
    const r = current();
    if (!r || r.base) return;
    if (on) {
      if (reconStale(r) && !confirm('Облік на дату відомості змінився після складання, цифри у відомості застаріли. '
        + 'Позначити підписаною як є?')) return;
      if (r.lines.some((l) => l.fin == null)
        && !confirm('Графа «за фінансовим обліком» заповнена не для всіх рядків. Позначити підписаною все одно?')) return;
      if (!r.result) r.result = reconResult(r);
      // Підпис після виправлення — та сама відомість: дата підпису лишається
      // тією, що була, якщо людина не вкаже іншу.
      let when = today();
      if (r.signedWas) {
        const got = prompt('Дата підпису відомості (РРРР-ММ-ДД):', r.signedWas);
        if (got == null) return;
        when = /^\d{4}-\d{2}-\d{2}$/.test(got.trim()) ? got.trim() : r.signedWas;
      }
      r.status = 'підписано';
      r.signed = when;
    } else {
      // Підписана відомість закриває період: зняти підпис — відкрити його знову.
      if (!confirm(`Зняти підпис з відомості №${r.no || '—'} «${r.sub}» на ${fmtDate(r.to)}?\n\n`
        + 'Документи до цієї дати знову проводитимуться без попередження про закритий період.')) return;
      r.status = 'складено';
      r.signedWas = r.signed || r.signedWas || '';
      r.signed = '';
    }
    logChange(on ? 'звірку підписано' : 'підпис знято', 'recon|' + r.id,
      `Відомість №${r.no || '—'} · ${r.sub} на ${fmtDate(r.to)}`);
    save();
    toast(on ? `Відомість №${r.no} позначено підписаною.`
      : `З відомості №${r.no} знято підпис.`);
    render();
  }

  function reconDelete() {
    const r = current();
    if (!r || r.base) return;
    if (r.status === 'підписано') {
      alert('Підписану відомість видалити не можна. Спершу зніміть підпис.');
      return;
    }
    if (!confirm(`Видалити відомість №${r.no} «${r.sub}» на ${fmtDate(r.to)}?`)) return;
    store.recon = store.recon.filter((x) => x.id !== r.id);
    state.reconId = null;
    logChange('відомість видалено', 'recon|' + r.id, `Відомість №${r.no || '—'} · ${r.sub} на ${fmtDate(r.to)}`);
    save(true, true);
    toast(`Відомість №${r.no} видалено.`);
    go('recon');
  }

  // ------------------------------------------------ вивантаження звірок
  const reconSpec = (r) => ({
    sub: r.sub, sheet: r.sub, no: r.no, date: r.date, from: r.from, to: r.to, title: r.title,
    lines: r.lines.map((l) => ({ name: l.name, uom: l.uom, price: l.price, fin: l.fin,
      acc: l.acc, fact: l.fact, note: l.note })),
    signer_pos: r.signerPos, signer_name: r.signerName, chief_pos: r.chiefPos, chief_name: r.chiefName,
    unit: unitCode(), legal_name: unitInfo().legalName,
  });
  function reconExcel(list, file) {
    list = list.filter(Boolean);
    if (!list.length) return;
    const one = list[0];
    return toExcel({ kind: 'recon', statements: list.map(reconSpec),
      file: file || `Узагальнююча відомість ${one.no ? '№' + one.no + ' ' : ''}${one.sub} на ${one.to}` });
  }
  function reconExcelDate() {
    const date = state.reconDate || today();
    // Аркуші — у порядку дерева підрозділів, як на екрані: склад, роти, батальйони.
    const order = new Map(subs.map((sb, i) => [sb.name, i]));
    const list = allRecon().filter((r) => r.to === date)
      .sort((a, b) => (order.get(a.sub) ?? 1e9) - (order.get(b.sub) ?? 1e9));
    if (!list.length) {
      toast(`На ${fmtDate(date)} відомостей ще не складено.`, true);
      return;
    }
    return reconExcel(list, `Узагальнюючі відомості на ${date} (${list.length})`);
  }
  function reconJournalExcel() {
    const rows = allRecon().slice().sort(reconOrder).map((r) => [
      r.date, [r.chiefPos, r.chiefName].filter(Boolean).join(' '), r.sub,
      [r.signerPos, r.signerName].filter(Boolean).join(' '), r.result || reconResult(r),
      r.decision || '', [r.no ? `відомість №${r.no}` : '',
        r.status === 'підписано' ? '' : 'не підписано', r.note].filter(Boolean).join('; ')]);
    if (!rows.length) { toast('Журнал звірок порожній.', true); return; }
    return toExcel({ kind: 'recon-journal', service: 'продовольча служба', unit: unitCode(), rows,
      file: `Журнал результатів звірки ${unitCode() || unitInfo().legalName}` });
  }

  // ------------------------------------------------ екран звірок
  const RECON_KIND = { ok: ['tag--in', 'звірено'], draft: ['tag--mv', 'не підписано'], due: ['tag--out', 'не звірено'] };

  function renderRecon() {
    if (state.reconId) {
      const r = current();
      if (r) return renderReconEdit(r);
      state.reconId = null;
    }
    const date = state.reconDate || today();
    const holders = reconSubs(date);
    const stOf = (x) => reconStatus(x.sub);
    const diffsOf = (x) => { const l = stOf(x).last; return l ? l.lines.filter(lineDiff).length : 0; };
    const due = holders.filter((x) => stOf(x).kind !== 'ok').length;
    const subReg = registry({
      id: 'recon', rows: holders, minWidth: '1000px', placeholder: 'Пошук: підрозділ',
      search: (x) => [x.sub, x.type || ''],
      filters: [
        { type: 'seg', key: 'kind', options: [['', 'усі'], ['due', 'не звірено'], ['draft', 'не підписано'], ['ok', 'звірено']],
          test: (x, v) => stOf(x).kind === v },
      ],
      columns: [
        { key: 'sub', label: 'підрозділ', cls: 'c-name', first: 1, sort: (x) => x.sub,
          cell: (x) => `<b>${esc(x.sub)}</b><small>${esc(x.type)}</small>` },
        { key: 'pos', label: 'позицій', cls: 'c-num', sort: (x) => x.pos, cell: (x) => String(x.pos) },
        { key: 'units', label: 'одиниць', cls: 'c-num', sort: (x) => x.units, cell: (x) => fmtNum(x.units, '0') },
        { key: 'days', label: 'остання звірка', cls: 'c-txt', style: 'flex:1.2 1 0',
          sort: (x) => (stOf(x).last ? stOf(x).days : 1e9),
          cell: (x) => { const t = stOf(x); return t.last ? `${t.last.no ? `№${esc(t.last.no)} ` : ''}на ${fmtDate(t.last.to)}, ${cnt(t.days, 'день', 'дні', 'днів')} тому` : 'не було'; } },
        { key: 'diffs', label: 'розбіжностей', cls: 'c-num', style: 'width:104px', sort: diffsOf,
          cellCls: (x) => (diffsOf(x) ? 'num-bad' : 'c-num--dim'), cell: (x) => String(diffsOf(x) || '—') },
        { key: 'kind', label: 'стан', cls: 'c-tag', style: 'width:120px', first: 1, sort: (x) => RECON_KIND[stOf(x).kind][1],
          cell: (x) => { const [cls, lbl] = RECON_KIND[stOf(x).kind]; return `<span class="tag ${cls}">${lbl}</span>`; } },
        { key: 'acts', label: '', cls: 'c-acts', style: 'flex-basis:190px', cell: (x) => {
          const last = stOf(x).last;
          const onDate = reconOf(x.sub).find((r) => r.to === date);
          return `${onDate ? `<button type="button" class="btn btn--sm" data-act="rc-open" data-id="${esc(onDate.id)}">Відкрити</button>`
            : x.pos ? `<button type="button" class="btn btn--sm btn--primary" data-act="rc-new" data-sub="${esc(x.sub)}">Скласти відомість</button>` : ''}${
            last ? `<button type="button" class="ico-btn" data-act="rc-xls" data-id="${esc(last.id)}" title="Остання відомість в Excel">⤓</button>` : ''}`;
        } },
      ],
      row: (x) => {
        const last = stOf(x).last;
        return { cls: stOf(x).kind === 'ok' ? '' : 'is-due', attrs: last ? `data-act="rc-open" data-id="${esc(last.id)}"` : '' };
      },
      count: (shown, all) => `${shown.length === all.length ? cnt(all.length, 'підрозділ', 'підрозділи', 'підрозділів')
        : `${shown.length} із ${all.length}`} · не звірено ${due}`,
      empty: 'На цю дату майно не числиться ні за одним підрозділом.',
    });

    const journalRows = allRecon().slice().sort(reconOrder).reverse();
    const signer = (r) => [r.signerPos, r.signerName].filter(Boolean).join(', ');
    const result = (r) => r.result || reconResult(r);
    const jSubs = [...new Set(journalRows.map((r) => r.sub))]
      .sort((a, b) => (subBy.get(a)?.order ?? 999) - (subBy.get(b)?.order ?? 999));
    const jReg = registry({
      id: 'rcj', rows: journalRows, minWidth: '1000px', panelCls: 'panel--inset', limit: REG_LIMIT,
      placeholder: 'Пошук: номер, підрозділ, підписант',
      search: (r) => [r.no || '', r.sub, signer(r), result(r)],
      filters: [
        { type: 'select', key: 'sub', label: 'підрозділ', all: 'усі', options: jSubs.map((x) => [x, x]), test: (r, v) => r.sub === v },
        { type: 'seg', key: 'st', options: [['', 'усі'], ['draft', 'не підписано'], ['signed', 'підписано']],
          test: (r, v) => (v === 'signed') === (r.status === 'підписано') },
        { type: 'period', key: 'd', label: 'дата', get: (r) => r.date },
      ],
      columns: [
        { key: 'date', label: 'дата', cls: 'c-date', sort: (r) => r.date || '', cell: (r) => fmtDate(r.date) },
        { key: 'no', label: '№', cls: 'c-code', style: 'width:60px', first: 1, sort: (r) => r.no || '', cell: (r) => esc(r.no || '—') },
        { key: 'sub', label: 'підрозділ', cls: 'c-txt', style: 'flex:0 1 190px', first: 1, sort: (r) => r.sub, cell: (r) => `<b>${esc(r.sub)}</b>` },
        { key: 'signer', label: 'з ким звірено', cls: 'c-txt', first: 1, sort: signer, cell: (r) => esc(signer(r)) },
        { key: 'result', label: 'результат', cls: 'c-txt', style: 'flex:1.4 1 0', first: 1, sort: result, cellTitle: result, cell: (r) => esc(result(r)) },
        { key: 'status', label: 'стан', cls: 'c-tag', style: 'width:120px', first: 1,
          title: 'Підписана відомість, під якою облік змінився (документ заднім числом), позначена: цифри в ній уже не ті',
          sort: (r) => `${r.status}|${signedStale(r) ? 0 : 1}`,
          cell: (r) => `<span class="tag ${r.status === 'підписано' ? 'tag--in' : 'tag--mv'}">${esc(r.status)}</span>${
            signedStale(r) ? '<small class="num-bad">облік змінився</small>' : ''}` },
      ],
      row: (r) => ({ attrs: `data-act="rc-open" data-id="${esc(r.id)}"` }),
      count: (shown, all) => (shown.length === all.length ? cnt(all.length, 'відомість', 'відомості', 'відомостей') : `${shown.length} із ${all.length}`),
      empty: 'Звірок ще не було.',
    });
    return {
      head: head('облік / контроль', 'Звірки з підрозділами', `
        <label class="chip is-on"><span class="chip__label">станом на</span>
          <input id="rc-date" type="date" value="${esc(date)}"></label>
        <button class="btn" data-act="rc-journal" title="Додаток 9 в Excel">Журнал звірок</button>
        <button class="btn" data-act="rc-all-xls">Відомості в Excel</button>
        <button class="btn btn--primary" data-act="rc-all">Скласти для всіх</button>`),
      body: `${flashBlock()}
      ${subReg.panel}
      <div class="card" style="margin-bottom:12px"><div class="card--scroll">${subReg.table}</div></div>
      <div class="card"><div class="card__head"><div class="card__title">Журнал результатів звірки</div></div>
        ${jReg.panel}<div class="card--scroll">${jReg.table}</div></div>`,
    };
  }

  function renderReconEdit(r) {
    const ro = !editable(r);
    const dis = ro ? ' disabled' : '';
    const fresh = !r.base ? reconLines(r.sub, r.to) : null;
    // Порядок рядків свій (як у минулій відомості), тож порівнюємо набір партій;
    // рядки, дописані руками (лише у ФЕС, лишки), в обліку служби й не мають бути.
    const sig = (arr) => arr.filter((l) => !l.extra && !l.left).map((l) => l.code + '|' + l.price + '|' + l.acc).sort().join(';');
    const changed = fresh && !ro && sig(fresh) !== sig(r.lines);
    const tot = (k) => r.lines.reduce((a, l) => a + (l[k] == null ? 0 : +l[k]), 0);
    const value = r.lines.reduce((a, l) => a + (+l.price || 0) * (+l.acc || 0), 0);
    const cell = (i, k, v) => `<input class="rc-in" data-rl="${i}" data-k="${k}" value="${esc(v == null ? '' : v)}"${dis}
      inputmode="decimal" autocomplete="off">`;
    const text = (i, k, v, ph) => `<input class="rc-in rc-in--wide" data-rl="${i}" data-k="${k}" value="${esc(v || '')}"${dis}
      placeholder="${esc(ph)}" autocomplete="off">`;
    const lines = r.lines.map((l, i) => `<div class="tbl__row tbl__row--plain${lineDiff(l) ? ' is-diff' : ''}" data-line="${i}">
        <div class="c-num c-num--dim" style="width:40px">${i + 1}</div>
        ${l.extra && !ro ? `<div class="c-name">${text(i, 'name', l.name, 'найменування як у ФЕС')}${text(i, 'code', l.code, 'код, якщо є')}</div>
        <div class="c-unit">${text(i, 'uom', l.uom, 'од.')}</div>
        <div class="c-num c-num--wide">${cell(i, 'price', l.price || '')}</div>`
        : `<div class="c-name"><b title="${esc(l.name)}">${esc(l.name)}</b><small>${esc([l.code || '', l.extra ? 'дописано' : '',
          l.left ? 'в обліку служби вже немає' : ''].filter(Boolean).join(' · '))}</small></div>
        <div class="c-unit">${esc(l.uom || '')}</div>
        <div class="c-num c-num--wide">${l.price ? fmtMoney(l.price) : '—'}</div>`}
        <div class="c-num c-num--input">${cell(i, 'fin', l.fin)}</div>
        <div class="c-num">${fmtNum(l.acc, '0')}</div>
        <div class="c-num c-num--input">${cell(i, 'fact', l.fact)}</div>
        <div class="c-txt rc-note">${ro ? esc(l.note || '') : `<input class="rc-in rc-in--wide" data-rl="${i}" data-k="note" value="${esc(l.note || '')}" placeholder="причина розбіжності, документи для списання">`}${
          (l.extra || l.left) && !ro ? rowBtn('rc-line-del', '✕ Прибрати', `data-i="${i}"`, { bad: true, title: 'Прибрати рядок із відомості' }) : ''}</div>
      </div>`).join('');
    const field = (k, label, v, span, type = 'text') => `<div class="field${span ? ' field--span2' : ''}"><label>${label}</label>
      <input data-rf="${k}" type="${type}" value="${esc(v || '')}"${dis}></div>`;
    // Графи 6 і 7 (рішення начальника, примітки) дописують і після підпису, і в
    // підписаних відомостях із бази: рішення приймають уже за підписаною.
    const area = (k, label, v, ph) => `<div class="field field--span2"><label>${label}</label>
      <textarea data-rf="${k}" placeholder="${esc(ph)}"${k === 'decision' || k === 'note' ? '' : dis}>${esc(v || '')}</textarea></div>`;
    return {
      head: head(`звірки / ${r.sub}`, `Узагальнююча відомість${r.no ? ' № ' + r.no : ''} · ${r.sub}`, `
        <button class="btn" data-act="rc-back">← До звірок</button>
        <button class="btn" data-act="rc-print">В Excel</button>${native ? `
        <button class="btn" data-act="scan-add" title="Додати скан підписаної відомості">+ Скан</button>` : ''}${r.base ? '' : r.status === 'підписано'
        ? '<button class="btn" data-act="rc-unsign">Зняти підпис</button>'
        : '<button class="btn btn--primary" data-act="rc-sign">Підписано ✓</button>'}${r.base || r.status === 'підписано' ? ''
        : '<button class="btn btn--danger" data-act="rc-del">Видалити</button>'}`),
      body: `${flashBlock()}
      ${r.base ? `<div class="flash flash--info">Підписана відомість із бази обліку${r.source ? ` (файл «${esc(r.source)}»)` : ''}. Лише для читання.</div>` : ''}
      ${signedStale(r) ? `<div class="flash flash--warn">Після підпису облік на ${fmtDate(r.to)} змінився (документ заднім числом): цифри у відомості вже не збігаються з обліком. Зніміть підпис і перескладіть або лишіть як є свідомо.</div>` : ''}
      ${filesOf('recon|' + r.id).length || r.status === 'підписано'
        ? filesCard('recon|' + r.id, 'Скан підписаної відомості', 'підшийте скан після підпису') : ''}
      ${changed ? `<div class="flash flash--warn">Облік «${esc(r.sub)}» на ${fmtDate(r.to)} не збігається з відомістю.
        <button class="btn btn--sm" data-act="rc-sync">Оновити з обліку</button></div>` : ''}
      ${reconDiffPanel(r)}
      <div class="tiles">
        <div class="tile"><div class="tile__label">Рядків</div><div class="tile__value">${r.lines.length}</div>
          <div class="tile__hint">партій на ${fmtDate(r.to)}</div></div>
        <div class="tile"><div class="tile__label">За обліком служби</div><div class="tile__value">${fmtNum(tot('acc'), '0')}</div>
          <div class="tile__hint">${fmtMoney(value)} грн</div></div>
        <div class="tile"><div class="tile__label">Фактично</div><div class="tile__value" id="rc-fact">${fmtNum(tot('fact'), '0')}</div>
          <div class="tile__hint">за ФЕС: <span id="rc-fin">${r.lines.some((l) => l.fin != null) ? fmtNum(tot('fin'), '0') : 'не заповнено'}</span></div></div>
        <div class="tile"><div class="tile__label">Розбіжностей</div>
          <div class="tile__value ${r.lines.some(lineDiff) ? 'num-bad' : ''}" id="rc-diff">${r.lines.filter(lineDiff).length}</div>
          <div class="tile__hint">${esc(r.status)}${r.signed ? ' ' + fmtDate(r.signed) : ''}</div></div>
      </div>
      <form class="card form" id="rc-form" style="margin-bottom:12px" onsubmit="return false">
        <div class="card__head"><div class="card__title">Шапка й підписи</div></div>
        <div class="form__grid">
          ${field('no', 'Номер відомості', r.no)}
          ${field('date', 'Дата складання', r.date, false, 'date')}
          ${field('from', 'Період з', r.from, false, 'date')}
          ${field('to', 'Період по', r.to, false, 'date')}
          ${field('title', 'Підрозділ у шапці (родовий відмінок)', r.title, true)}
          ${field('signerPos', 'З ким звіряємо: посада', r.signerPos, true)}
          ${field('signerName', 'Ім\u2019я ПРІЗВИЩЕ', r.signerName)}
          ${field('chiefPos', 'Хто звіряє: посада', r.chiefPos, true)}
          ${field('chiefName', 'Ім\u2019я ПРІЗВИЩЕ', r.chiefName)}
        </div>
      </form>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Військове майно</div>
          <div class="panel__spacer"></div>${ro ? '' : `
          <button class="btn btn--sm" data-act="rc-line-add" title="Позиція, що є у ФЕС чи фактично, але не в обліку служби">+ Рядок</button>
          <button class="btn btn--sm" data-act="rc-fin" title="Заповнити лише порожні клітинки">ФЕС = облік служби</button>
          <button class="btn btn--sm" data-act="rc-fact" title="Перезаписати всю графу">Фактично = облік</button>`}</div>
        <div class="card--scroll"><div class="tbl" style="--tbl-min:1100px">
          <div class="tbl__head">
            <div class="tbl__h c-num" style="width:40px">№</div><div class="tbl__h c-name">найменування</div>
            <div class="tbl__h c-unit">од.</div><div class="tbl__h c-num c-num--wide">ціна, грн</div>
            <div class="tbl__h c-num c-num--input">за фін. обліком</div><div class="tbl__h c-num">за обліком служби</div>
            <div class="tbl__h c-num c-num--input">фактично</div><div class="tbl__h c-txt rc-note">примітки</div>
          </div>${lines || '<div class="tbl__row tbl__row--plain"><div class="c-txt">На цю дату майно за підрозділом не числиться.</div></div>'}
        </div></div></div>
      <form class="card form" id="rc-form2" onsubmit="return false">
        <div class="card__head"><div class="card__title">Запис у журнал результатів звірки</div>
          <div class="panel__spacer"></div>${ro ? '' : '<button class="btn btn--sm" data-act="rc-result">Результати за розбіжностями</button>'}</div>
        <div class="form__grid">
          ${area('result', 'Результати проведеної звірки (графа 5)', r.result, reconResult(r))}
          ${area('decision', 'Рішення начальника (графа 6)', r.decision, 'заходи з усунення розбіжностей')}
          ${area('note', 'Примітки (графа 7)', r.note, '')}
        </div>
      </form>`,
    };
  }

  /** Поля відомості пишуться одразу, без перемальовування — інакше курсор
   *  злітав би на кожній цифрі. Підсумки й підсвітка оновлюються на місці. */
  function bindRecon() {
    const dateEl = $('#rc-date');
    if (dateEl) dateEl.addEventListener('change', () => { state.reconDate = dateEl.value || today(); render(); });
    const r = current();
    if (r && !editable(r)) {
      const keep = debounce(() => save(), 400);
      document.querySelectorAll('[data-rf="decision"], [data-rf="note"]').forEach((el) => {
        el.addEventListener('input', () => {
          r[el.dataset.rf] = el.value;
          // Відомість із бази: графи 6 і 7 ідуть у її ж запис.
          if (r.base) {
            store.reconBase = store.reconBase || {};
            store.reconBase[String(r.id).replace(/^db/, '')] = { decision: r.decision || '', note: r.note || '' };
          }
          keep();
        });
        el.addEventListener('change', () => logChange('відомість доповнено', 'recon|' + r.id,
          `Відомість №${r.no || '—'} · ${r.sub}: ${el.dataset.rf === 'decision' ? 'рішення начальника' : 'примітки'}`));
      });
      return;
    }
    if (!r) return;
    const touch = debounce(() => save(), 400);
    const totals = () => {
      const tot = (k) => r.lines.reduce((a, l) => a + (l[k] == null ? 0 : +l[k]), 0);
      const f = $('#rc-fact'); if (f) f.textContent = fmtNum(tot('fact'), '0');
      const fin = $('#rc-fin'); if (fin) fin.textContent = r.lines.some((l) => l.fin != null) ? fmtNum(tot('fin'), '0') : 'не заповнено';
      const dEl = $('#rc-diff');
      if (dEl) { const n = r.lines.filter(lineDiff).length; dEl.textContent = n; dEl.classList.toggle('num-bad', n > 0); }
    };
    document.querySelectorAll('[data-rf]').forEach((el) => {
      el.addEventListener('input', () => { r[el.dataset.rf] = el.value; touch(); });
      // Інша дата «станом на» — інший облік: перемальовуємо, щоб з'явилась
      // пропозиція оновити рядки.
      if (el.dataset.rf === 'to') el.addEventListener('change', () => { save(); render(); });
    });
    const cells = [...document.querySelectorAll('.rc-in')];
    cells.forEach((el) => {
      el.addEventListener('input', () => {
        const l = r.lines[+el.dataset.rl];
        const k = el.dataset.k;
        if (['note', 'name', 'code', 'uom'].includes(k)) l[k] = el.value;
        else if (k === 'price') l.price = numOrNull(el.value.replace(',', '.')) || 0;
        else l[k] = numOrNull(el.value.replace(',', '.'));
        if (el.dataset.k === 'fact') l.factSet = true;           // вписано руками — оновлення з обліку не чіпає
        el.closest('.tbl__row').classList.toggle('is-diff', lineDiff(l));
        totals();
        touch();
      });
      // Enter — та сама графа наступного рядка: відомість заповнюють стовпчиком.
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const next = cells.find((c) => c.dataset.k === el.dataset.k && +c.dataset.rl === +el.dataset.rl + 1);
        if (next) { next.focus(); next.select(); }
      });
    });
  }

  // ============================================================ ЛЮДИ Й ПОСАДОВЦІ
  /** Довідник «Військовослужбовці», як у ЗСУпрод: людина — ім'я частинами й
   *  історія звань і посад із датами. Документ на дату бере звання й посаду,
   *  чинні тоді, а не сьогодні: у торішньому описі лишається те, що було.
   *  «МВО й посадовці» — хто за який підрозділ відповідав і з якого по яке
   *  число, і посадовці частини, що підписують документи служби.
   *
   *  Початкові записи — з бази (з описів інвентаризації); далі довідник живе
   *  у внесених даних і правиться тут. */
  const ROLES = [
    ['командир', 'Командир військової частини', 'затверджує акт інвентаризації'],
    ['начальник логістики', 'Начальник логістики', 'ознайомлюється з актом'],
    ['начальник служби', 'Начальник продовольчої служби', 'перевіряє описи, підписує відомості'],
    ['бухгалтер', 'Бухгалтер ФЕС', 'вносить облікові дані в описи'],
    ['начальник ФЕС', 'Начальник ФЕС', ''],
  ];
  const roleName = (role) => (ROLES.find((r) => r[0] === role) || [role, role])[1];
  const RANKS = ['солдат', 'старший солдат', 'молодший сержант', 'сержант', 'старший сержант',
    'головний сержант', 'штаб-сержант', 'майстер-сержант', 'старший майстер-сержант',
    'головний майстер-сержант', 'молодший лейтенант', 'лейтенант', 'старший лейтенант', 'капітан',
    'майор', 'підполковник', 'полковник', 'бригадний генерал', 'працівник ЗСУ'];

  /** Довідники — люди, МВО, посадовці, дислокація, підрозділи — лежать у базі
   *  й правляться там само. Програма бере їх із витягу, який будується з живої
   *  бази при запуску, і туди ж повертає: поділу «база / моє» немає, тому й
   *  зливати нічого не треба. Ідентифікатор запису приходить із бази й не
   *  змінюється, тож посилання (МВО на людину, підписанти опису) переживають
   *  і перезапуск, і перезбірку. */
  const basePerson = (r) => ({
    id: r[0], surname: r[1] || '', name: r[2] || '', patr: r[3] || '', note: r[4] || '',
    hist: (r[5] || []).map((h) => ({ date: h[0] || '', rank: h[1] || '', pos: h[2] || '', basis: h[3] || '' })),
  });
  const baseMvo = (r) => ({ id: r[5], sub: r[0], person: r[1],
    from: r[2] || '', to: r[3] || '', note: r[4] || '' });
  const baseOfficial = (r) => ({ id: r[5], role: r[0], person: r[1],
    from: r[2] || '', to: r[3] || '', note: r[4] || '' });
  const baseLocation = (r) => ({ id: r[0], from: r[1] || '', place: r[2] || '', note: r[3] || '' });
  /** Реквізити частини для бланків: назва юридичної особи, ЄДРПОУ, повна назва
   *  служби й скільки днів дійсна накладна. Початкові — з бази, правлять їх у
   *  «Люди й МВО → Частина»: переїхала частина чи змінилася назва служби —
   *  міняють тут, а не в самому бланку Excel. */
  const UNIT_FIELDS = [
    ['legalName', 'Найменування юридичної особи', 'Військова частина А0000',
      'як у шапці бланка накладної'],
    ['edrpou', 'Код за ЄДРПОУ', '00000000', ''],
    ['serviceFull', 'Служба забезпечення', 'Продовольча служба тилу логістики',
      'повна назва, як у документах'],
    ['validDays', 'Накладна дійсна, днів', '1', 'скільки днів після дати операції'],
    ['opening', 'Початок обліку', '', 'документів із ранішою датою програма не приймає', 'date'],
  ];
  /** Умовне найменування частини («А0000») — з найменування юридичної особи в
   *  реквізитах; без нього — порожньо, і тексти обходяться без числа. */
  const unitCode = () => (String(unitInfo().legalName || '').match(/частина\s+(\S+)/i) || [])[1] || '';
  const unitGen = () => (unitCode() ? `військової частини ${unitCode()}` : 'військової частини');
  function unitInfo() {
    const base = {
      legalName: D.meta.legalName || 'Військова частина',
      edrpou: D.meta.edrpou || '',
      serviceFull: D.meta.serviceFull || D.meta.service || '',
      validDays: D.meta.validDays || 1,
      opening: D.meta.opening || '',
    };
    const mine = store.unit || {};
    const out = {};
    for (const [k] of UNIT_FIELDS) out[k] = String(mine[k] ?? '').trim() || base[k];
    out.validDays = Math.max(0, Math.min(365, Number(out.validDays) || 1));
    // Початок обліку — дата, і не в майбутньому: інша — та, що в базі.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.opening) || out.opening > today()) out.opening = base.opening;
    return out;
  }
  /** Шапка вивантажень: «Військова частина А0000 · продовольча служба». */
  const unitTop = () => `${unitInfo().legalName} · ${unitInfo().serviceFull}`;

  /** Скорочення служби, зрозумілі не всім одразу. Підказка на наведення — не
   *  підручник, але новій людині не треба питати, що таке МВО. */
  const GLOSSARY = {
    'МВО': 'матеріально відповідальна особа',
    'ВМТЗ': 'взвод матеріально-технічного забезпечення',
    'РМЗ': 'рота матеріального забезпечення',
    'РВП': 'ремонтно-відновлювальний підрозділ',
    'ФЕС': 'фінансово-економічна служба частини',
    'ФЄС': 'фінансово-економічна служба частини',
    'ТЗ': 'технічні засоби продовольчої служби',
    'зав. №': 'заводський номер',
    '21/Прод': 'табель до штату з нормою технічних засобів на підрозділ',
    '3/Прод': 'табель до штату з нормою для їдалень і кухонь',
    'б/н': 'без номера',
    'ППД': 'пункт постійної дислокації',
    'МТЗ': 'матеріально-технічні засоби',
    'КПКВ': 'код програмної класифікації видатків',
    'КЕКВ': 'код економічної класифікації видатків',
  };
  const hintFor = (text) => {
    const key = Object.keys(GLOSSARY).find((k) => String(text) === k
      // «ТЗ №17» — частина номера документа, а не скорочення.
      || new RegExp(`(^|[\\s(«·])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\s*№)([\\s)»,.·]|$)`).test(String(text)));
    return key ? `${key} — ${GLOSSARY[key]}` : '';
  };

  const peopleReady = new WeakSet();
  function peopleInit() {
    if (peopleReady.has(store)) return;
    peopleReady.add(store);
    // Робочі переліки — копія того, що в базі. Правки з них ідуть назад у базу
    // цілком, тому жодного «що з бази, а що моє» розрізняти не треба.
    store.people = (D.people || []).map(basePerson);
    store.mvo = (D.mvo || []).map(baseMvo);
    store.cmdrs = (D.cmdrs || []).map(baseMvo);
    store.officials = (D.officials || []).map(baseOfficial);
    store.locations = (D.locations || []).map(baseLocation);
    store.subs = (D.subs || []).map(baseSub);
    delete store.baseSeen;                 // пам'ять про злиття більше не потрібна
    delete store.baseSig;
    rebuildSubs(store.subs, subMentions());
  }

  /** Назви підрозділів, згаданих у внесених даних. Потрібні двічі: щоб знати,
   *  чи задіяний підрозділ, доданий у програмі, і щоб не дати видалити той, на
   *  якому щось висить. */
  function subMentions() {
    const set = new Set();
    const add = (x) => { const v = String(x || '').trim(); if (v) set.add(v); };
    const d = store.docs || {};
    for (const r of (d.incoming || [])) { add(r[3]); add(r[4]); }
    for (const r of (d.movement || [])) { add(r[3]); add(r[4]); }
    for (const r of (d.writeoffs || [])) add(r[3]);
    for (const r of (store.destroyed || [])) add(r.sub);
    for (const r of (store.recon || [])) add(r.sub);
    for (const r of (store.mvo || [])) add(r.sub);
    for (const r of (store.cmdrs || [])) add(r.sub);
    // Норми — через normsInit: до першого показу штату їх у store ще немає, і
    // підрозділ лише з нормою вважався б незадіяним.
    for (const r of normsInit()) add(r.sub);
    for (const x of (store.inventories || [])) for (const k of Object.keys(x.mvo || {})) add(k);
    return set;
  }

  /** Скільки разів підрозділ згадано в обліку — у базі й у внесеному. Нуль
   *  означає, що запис довідника можна виправити чи прибрати без наслідків. */
  function subUses(name) {
    if (!name) return 0;
    return (subMentions().has(name) ? 1 : 0)
      + ledger.filter((e) => e.sub === name || e.cnt === name).length
      + subs.filter((s) => s.parent === name).length
      + (D.norms || []).filter((r) => r[2] === name).length
      + inventory.filter((r) => r.sub === name).length
      + (store.recon || []).filter((r) => r.sub === name).length
      + (store.mvo || []).filter((r) => r.sub === name).length
      + (store.cmdrs || []).filter((r) => r.sub === name).length
      // Звірки й інвентаризації з бази теж: інакше видалення «проходило», а
      // база його відхиляла, і підрозділ повертався після перезапуску.
      + allRecon().filter((r) => r.base && r.sub === name).length
      + allInv().filter((x) => (x.mvo || {})[name] != null || (x.scope || []).includes(name)).length
      + (baseRefs.get(name) || 0);
  }
  /** Місце складання документів на дату: останній запис дислокації, не пізніший за неї. */
  function locationAt(date) {
    peopleInit();
    const list = (store.locations || []).filter((r) => r.place && (!r.from || !date || r.from <= date));
    return (lastFrom(list) || {}).place || '';
  }
  const personBy = (id) => (id && (store.people || []).find((p) => p.id === id)) || null;
  const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');
  /** Звання й посада на дату: останній запис історії, не пізніший за неї. */
  function personAt(p, date) {
    if (!p) return { rank: '', pos: '' };
    const hist = (p.hist || []).slice().sort(byDate);
    let cur = hist[0] || { rank: '', pos: '' };
    for (const h of hist) if (!h.date || !date || h.date <= date) cur = h;
    return { rank: cur.rank || '', pos: cur.pos || '' };
  }
  const isInitial = (s) => String(s || '').replace(/\./g, '').trim().length <= 1;
  const upper = (s) => String(s || '').trim().toUpperCase();
  /** Ім'я для підпису: «Тарас ПЕТРЕНКО»; якщо відомі лише ініціали — «ПЕТРЕНКО Т. Г.». */
  function pSign(p) {
    if (!p) return '';
    if (p.name && !isInitial(p.name)) return `${p.name.trim()} ${upper(p.surname)}`;
    const ini = (s) => (s && s.trim() ? s.trim()[0].toUpperCase() + '.' : '');
    return [upper(p.surname), [ini(p.name), ini(p.patr)].filter(Boolean).join(' ')].filter(Boolean).join(' ');
  }
  /** «ПЕТРЕНКО Т. Г.» — у складі комісії. */
  function pShort(p) {
    if (!p) return '';
    const ini = (s) => (s && s.trim() ? s.trim()[0].toUpperCase() + '.' : '');
    return [upper(p.surname), [ini(p.name), ini(p.patr)].filter(Boolean).join(' ')].filter(Boolean).join(' ');
  }
  /** Повністю: «ПЕТРЕНКО Тарас Григорович». */
  const pFull = (p) => (p ? [upper(p.surname), p.name, p.patr].filter((x) => x && String(x).trim())
    .map((x, i) => (i && isInitial(x) ? String(x).replace(/\.$/, '').trim() + '.' : String(x).trim())).join(' ') : '');
  /** Підписант для бланка: посада й звання на дату, ім'я у формі підпису. */
  function signer(p, date, short = false) {
    if (!p) return { pos: '', rank: '', name: '' };
    const at = personAt(p, date);
    return { pos: at.pos, rank: at.rank, name: short ? pShort(p) : pSign(p) };
  }
  const openOn = (r, date) => (!r.from || r.from <= date) && (!r.to || r.to > date);
  const lastFrom = (list) => list.slice().sort((a, b) => (a.from || '').localeCompare(b.from || '')).pop();
  function mvoAt(sub, date) {
    peopleInit();
    return personBy((lastFrom(store.mvo.filter((r) => r.sub === sub && openOn(r, date))) || {}).person);
  }
  function officialAt(role, date) {
    peopleInit();
    return personBy((lastFrom(store.officials.filter((r) => r.role === role && openOn(r, date))) || {}).person);
  }
  function cmdrAt(sub, date) {
    peopleInit();
    return personBy((lastFrom(store.cmdrs.filter((r) => r.sub === sub && openOn(r, date))) || {}).person);
  }
  /** Командир (начальник) підрозділу на дату: свій, а де свого не призначено — вищого
   *  підрозділу. Командир частини описів підрозділів не підписує. */
  function cmdrFor(sub, date, depth = 0) {
    const sb = subBy.get(sub);
    if (!sb || sb.type === 'бригада' || depth > 4) return null;
    return cmdrAt(sub, date) || (sb.parent ? cmdrFor(sb.parent, date, depth + 1) : null);
  }
  /** Призначення зі строком дії трьох видів: МВО підрозділу, командир підрозділу, посадовець
   *  частини. Запис той самий — різняться перелік і те, до чого його прив'язано. */
  const ASSIGN = {
    mvo: { list: () => store.mvo, set: (v) => { store.mvo = v; }, key: 'sub', tag: 'mvo|', name: (w) => `МВО «${w}»` },
    cmdr: { list: () => store.cmdrs, set: (v) => { store.cmdrs = v; }, key: 'sub', tag: 'cmdr|', name: (w) => `командир «${w}»` },
    role: { list: () => store.officials, set: (v) => { store.officials = v; }, key: 'role', tag: 'role|', name: (w) => roleName(w) },
  };
  const assignKind = (k) => (ASSIGN[k] ? k : 'mvo');
  const upFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  /** Хто підписує накладну за підрозділ: його МВО на дату, а в батальйону без
   *  власного — командир його ВМТЗ (майно батальйону числиться там), далі вгору
   *  по дереву до батальйону. Бригада й сторонні одержувачі МВО не мають. */
  function mvoFor(sub, date, depth = 0) {
    const sb = subBy.get(sub);
    if (!sb || sb.type === 'бригада' || depth > 4) return null;
    const own = mvoAt(sub, date);
    if (own) return own;
    const vmtz = subs.find((s) => s.parent === sub && / · ВМТЗ$/.test(s.name));
    const viaVmtz = vmtz && mvoAt(vmtz.name, date);
    return viaVmtz || (sb.parent ? mvoFor(sb.parent, date, depth + 1) : null);
  }
  /** Скільки разів людина згадана в призначеннях та інвентаризаціях. */
  function personUses(id) {
    // Інвентаризації з бази теж: людина, що підписала торішній опис, має
    // лишитися в довіднику, інакше база видалення відхиляла мовчки.
    const inv = allInv().filter((x) => x.head === id || (x.members || []).includes(id)
      || Object.values(x.sign || {}).includes(id) || Object.values(x.mvo || {}).includes(id)
      || Object.values(x.cmdr || {}).includes(id)
      || Object.values(x.plan || {}).some((p) => p && p.who === id)).length;
    return store.mvo.filter((r) => r.person === id).length + store.cmdrs.filter((r) => r.person === id).length
      + store.officials.filter((r) => r.person === id).length + inv;
  }
  const peopleSorted = () => store.people.slice().sort((a, b) =>
    upper(a.surname).localeCompare(upper(b.surname), 'uk') || String(a.name).localeCompare(String(b.name), 'uk'));
  /** Перелік людей для вибору: ПІБ і звання на дату. */
  function personOptions(sel, date, empty = '— оберіть —') {
    return `<option value="">${esc(empty)}</option>` + peopleSorted().map((p) => {
      const rank = personAt(p, date).rank;
      return `<option value="${esc(p.id)}"${p.id === sel ? ' selected' : ''}>${esc(pFull(p))}${rank ? ', ' + esc(rank) : ''}</option>`;
    }).join('');
  }

  function renderPeople() {
    peopleInit();
    const tab = state.peopleTab || 'people';
    const TABS = [['people', 'Військовослужбовці'], ['resp', 'МВО й посадовці'],
      ['loc', 'Дислокація'], ['unit', 'Частина']];
    const seg = `<div class="seg">${TABS
      .map(([k, l]) => `<button type="button" data-act="pp-tab" data-v="${k}"${tab === k ? ' class="is-on"' : ''}>${l}</button>`)
      .join('')}</div>`;
    return {
      head: head('довідники / люди', (TABS.find((t) => t[0] === tab) || TABS[0])[1], seg
        + (tab === 'people' ? searchBox('Пошук: прізвище, звання, посада')
          + '<button class="btn btn--primary" data-act="pp-new">+ Військовослужбовець</button>'
          : tab === 'loc' ? '<button class="btn btn--primary" data-act="loc-add">+ Нове місце</button>' : '')),
      body: `${flashBlock()}${tab === 'people' ? peopleBody() : tab === 'loc' ? locBody()
        : tab === 'unit' ? unitBody() : respBody()}`,
    };
  }

  /** Дислокація частини: де складаються документи. Накладна бере «місце
   *  складання» на свою дату, як і підписантів. */
  function locBody() {
    const list = (store.locations || []).slice().sort((a, b) => (b.from || '').localeCompare(a.from || ''));
    const cur = locationAt(state.asOf);
    const rows = list.map((r) => `<div class="tbl__row tbl__row--plain">
        <div class="c-date" style="width:160px"><input class="rc-in" type="date" data-loc="${esc(r.id)}" data-k="from" value="${esc(r.from)}"></div>
        <div class="c-txt" style="flex:0 0 280px"><input class="rc-in rc-in--wide" data-loc="${esc(r.id)}" data-k="place"
          value="${esc(r.place)}" placeholder="с. Іванівка"></div>
        <div class="c-txt"><input class="rc-in rc-in--wide" data-loc="${esc(r.id)}" data-k="note" value="${esc(r.note)}"
          placeholder="наказ №, дата"></div>
        <div class="c-acts">${rowBtn('loc-del', '✕ Видалити', `data-id="${esc(r.id)}"`, { bad: true, title: 'Видалити помилковий запис' })}</div>
      </div>`).join('');
    return `<div class="panel"><div class="panel__note">Місце складання документів на ${fmtDate(state.asOf)}:
        <b>${esc(cur || 'не вказано')}</b>. Після переїзду додайте новий запис.</div></div>
      <div class="card card--scroll"><div class="tbl" style="--tbl-min:780px;--acts:110px">
        <div class="tbl__head"><div class="tbl__h c-date" style="width:160px">з дати</div>
          <div class="tbl__h c-txt" style="flex:0 0 280px">місце складання</div>
          <div class="tbl__h c-txt">підстава</div><div class="tbl__h c-acts"></div></div>
        ${rows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Записів ще немає. Додайте перший кнопкою «+ Нове місце».</div></div>'}
      </div></div>`;
  }

  /** Реквізити частини — те з бланка накладної, що з часом змінюється. */
  function unitBody() {
    const cur = unitInfo();
    const fields = UNIT_FIELDS.map(([k, label, , hint, type]) => `<div class="field">
      <label>${esc(label)}</label>
      <input data-uf="${k}" value="${esc(cur[k])}" autocomplete="off"${type === 'date' ? ` type="date" max="${today()}"` : ''}>
      ${hint ? `<div class="field__hint">${esc(hint)}</div>` : ''}</div>`).join('');
    return `<div class="panel"><div class="panel__note">Очистіть поле, щоб повернути значення з бази.</div></div>
      <div class="card form"><div class="card__head"><div class="card__title">Реквізити частини</div></div>
        <div class="form__grid">${fields}</div>
        <div class="card__foot"><span class="panel__count">У шапці вивантажень: ${esc(unitTop())}</span></div>
      </div>`;
  }

  function locationAdd() {
    peopleInit();
    const from = state.asOf || today();
    const same = (store.locations || []).find((x) => x.from === from);
    if (same) {
      // Два місця з однієї дати база не приймає — ведемо до наявного.
      toast(`Місце з ${fmtDate(from)} уже є — змініть його або звітну дату.`, true);
      $(`[data-loc="${same.id}"][data-k="place"]`)?.focus();
      return;
    }
    const r = { id: uid(), from, place: '', note: '' };
    store.locations = (store.locations || []).concat([r]);
    save(true, true);
    render();
    $(`[data-loc="${r.id}"][data-k="place"]`)?.focus();
  }

  function locationDelete(id) {
    const r = (store.locations || []).find((x) => x.id === id);
    if (!r) return;
    if (!confirm(`Видалити запис «${r.place || 'без назви'}» з ${fmtDate(r.from)}? Документи на ці дати візьмуть попереднє місце.`)) return;
    store.locations = store.locations.filter((x) => x.id !== id);
    logChange('дислокацію видалено', 'loc|' + r.from, `${r.place} з ${fmtDate(r.from)}`);
    save(true, true);
    render();
  }

  function peopleBody() {
    const date = state.asOf;
    const words = qWords(state.q);
    const mvoOf = (id) => store.mvo.filter((r) => r.person === id && openOn(r, date));
    const cmdOf = (id) => store.cmdrs.filter((r) => r.person === id && openOn(r, date));
    const offOf = (id) => store.officials.filter((r) => r.person === id && openOn(r, date));
    const rolesOf = (id) => mvoOf(id).map((r) => 'МВО ' + r.sub).concat(cmdOf(id).map((r) => 'командир ' + r.sub),
      offOf(id).map((r) => roleName(r.role)));
    const list = peopleSorted().filter((p) => {
      const at = personAt(p, date);
      return !words.length || hitAll(words, pFull(p), at.rank, at.pos, p.note);
    });
    const reg = registry({
      id: 'pp', rows: list, headSearch: true, allCount: store.people.length, minWidth: '900px',
      filters: [
        { type: 'seg', key: 'role', options: [['', 'усі'], ['mvo', 'МВО'], ['cmdr', 'командири'], ['off', 'посадовці'],
          ['none', 'без призначень']],
          test: (p, v) => (v === 'mvo' ? mvoOf(p.id).length > 0 : v === 'cmdr' ? cmdOf(p.id).length > 0
            : v === 'off' ? offOf(p.id).length > 0 : !rolesOf(p.id).length) },
      ],
      columns: [
        { key: 'name', label: 'прізвище, ім’я, по батькові', cls: 'c-name', first: 1, sort: (p) => pFull(p),
          cell: (p) => `<b>${esc(pFull(p) || 'без прізвища')}</b>${p.note ? `<small>${esc(p.note)}</small>` : ''}` },
        { key: 'rank', label: 'звання', cls: 'c-txt', style: 'flex:0 0 160px', first: 1, sort: (p) => personAt(p, date).rank || '',
          cell: (p) => esc(personAt(p, date).rank || '—') },
        { key: 'pos', label: 'посада', cls: 'c-txt', first: 1, sort: (p) => personAt(p, date).pos || '',
          cell: (p) => esc(personAt(p, date).pos || '—') },
        { key: 'roles', label: 'відповідає за', cls: 'c-txt', style: 'flex:0 1 260px', first: 1, sort: (p) => rolesOf(p.id).join(', '),
          cell: (p) => esc(rolesOf(p.id).join(', ') || '—') },
      ],
      row: (p) => ({ cls: state.personId === p.id ? 'is-sel' : '', attrs: `data-act="pp-open" data-id="${esc(p.id)}"` }),
      count: (shown) => (shown.length === store.people.length ? cnt(shown.length, 'особа', 'особи', 'осіб')
        : `${shown.length} із ${store.people.length}`),
      empty: 'Військовослужбовців ще немає.',
      emptyFiltered: 'Нікого не знайдено.',
    });
    return `${state.personId ? personCard(personBy(state.personId)) : ''}${reg.panel}
      <div class="card card--scroll">${reg.table}</div>`;
  }

  function personCard(p) {
    if (!p) return '';
    const hist = (p.hist || []).map((h, i) => ({ h, i })).sort((a, b) => byDate(a.h, b.h));
    const rows = hist.map(({ h, i }) => `<div class="tbl__row tbl__row--plain">
        <div class="c-date" style="width:150px"><input class="rc-in" type="date" data-ph="${i}" data-k="date" value="${esc(h.date)}"></div>
        <div class="c-txt" style="flex:0 0 190px"><input class="rc-in rc-in--wide" list="rank-list" data-ph="${i}" data-k="rank"
          value="${esc(h.rank)}" placeholder="звання"></div>
        <div class="c-txt"><input class="rc-in rc-in--wide" data-ph="${i}" data-k="pos" value="${esc(h.pos)}" placeholder="посада"></div>
        <div class="c-txt" style="flex:0 1 220px"><input class="rc-in rc-in--wide" data-ph="${i}" data-k="basis"
          value="${esc(h.basis)}" placeholder="наказ №, дата"></div>
        <div class="c-acts">${rowBtn('ph-del', '✕ Видалити', `data-i="${i}"`, { bad: true, title: 'Видалити запис', off: p.hist.length <= 1 })}</div>
      </div>`).join('');
    const field = (k, label, ph) => `<div class="field"><label>${label}</label>
      <input data-pf="${k}" value="${esc(p[k] || '')}" placeholder="${esc(ph)}" autocomplete="off"></div>`;
    const resp = store.mvo.filter((r) => r.person === p.id)
      .map((r) => `МВО «${r.sub}» з ${fmtDate(r.from)}${r.to ? ' по ' + fmtDate(r.to) : ''}`)
      .concat(store.cmdrs.filter((r) => r.person === p.id)
        .map((r) => `командир «${r.sub}» з ${fmtDate(r.from)}${r.to ? ' по ' + fmtDate(r.to) : ''}`))
      .concat(store.officials.filter((r) => r.person === p.id)
        .map((r) => `${roleName(r.role)} з ${fmtDate(r.from)}${r.to ? ' по ' + fmtDate(r.to) : ''}`));
    return `<div class="card form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">${esc(pFull(p) || 'Новий військовослужбовець')}</div>
        <div class="panel__spacer"></div>
        <button class="btn" data-act="pp-close">Закрити</button>
        <button class="btn btn--danger" data-act="pp-del">Видалити</button></div>
      <div class="form__grid">
        ${field('surname', 'Прізвище', 'ПЕТРЕНКО')}${field('name', 'Ім’я', 'Тарас або Т.')}
        ${field('patr', 'По батькові', 'Григорович або Г.')}
        <div class="field"><label>Примітка</label><input data-pf="note" value="${esc(p.note || '')}"
          placeholder="напр. «переведений», «не служить»"></div>
      </div>
      <div class="pad" style="padding-top:4px"><div class="panel__note">Нове звання чи посаду додавайте окремим записом із датою наказу.</div></div>
      <div class="card--scroll"><div class="tbl" style="--tbl-min:820px;--acts:110px">
        <div class="tbl__head"><div class="tbl__h c-date" style="width:150px">з дати</div>
          <div class="tbl__h c-txt" style="flex:0 0 190px">звання</div><div class="tbl__h c-txt">посада</div>
          <div class="tbl__h c-txt" style="flex:0 1 220px">підстава</div><div class="tbl__h c-acts"></div></div>
        ${rows}</div></div>
      <div class="card__foot"><button class="btn" data-act="ph-add">+ Зміна звання чи посади</button>
        <div class="panel__spacer"></div>
        <span class="panel__count">${esc(resp.join('; ') || 'відповідальних призначень немає')}</span></div>
    </div>
    <datalist id="rank-list">${RANKS.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>`;
  }

  /** Людина без прізвища й імені (або з прочерком замість них). */
  const blankPerson = (p) => !p || (!String(p.surname || '').replace(/[—–\-\s.]/g, '')
    && !String(p.name || '').trim() && !String(p.patr || '').trim());
  function personNew() {
    peopleInit();
    const p = { id: uid(), surname: '', name: '', patr: '', note: '',
      hist: [{ date: today(), rank: '', pos: '', basis: '' }] };
    store.people.push(p);
    save();
    state.personId = p.id;
    state.q = '';
    render();
    $('[data-pf="surname"]')?.focus();
  }

  function personDelete() {
    const p = personBy(state.personId);
    if (!p) return;
    const n = personUses(p.id);
    if (n) {
      alert(`Не можна видалити «${pFull(p)}»: згадано в ${cnt(n, 'призначенні', 'призначеннях', 'призначеннях')} чи інвентаризаціях. `
        + 'Напишіть у примітці «не служить».');
      return;
    }
    if (!confirm(`Видалити «${pFull(p) || 'без прізвища'}» з довідника?`)) return;
    store.people = store.people.filter((x) => x.id !== p.id);
    state.personId = null;
    save(true, true);
    render();
  }

  function respBody() {
    const date = state.asOf;
    const holders = reconSubs(date).filter((x) => x.pos).map((x) => x.sub);
    const allSubs = [...new Set(holders.concat(store.mvo.map((r) => r.sub)))]
      .sort((a, b) => (subBy.get(a)?.order ?? 999) - (subBy.get(b)?.order ?? 999));
    const who = (r) => {
      const p = personBy(r.person);
      const at = personAt(p, date);
      return p ? `<b class="lnk" data-act="pp-open" data-id="${esc(p.id)}" title="Відкрити картку військовослужбовця">${esc(pSign(p))}</b>
        <small>${esc([at.rank, at.pos].filter(Boolean).join(', '))}</small>${
          r.note ? `<small title="Підстава призначення">${esc(r.note)}</small>` : ''}` : '<span class="num-bad">людину видалено</span>';
    };
    // Запис історії можна виправити (дату, людину, строк, підставу): пропущене
    // колись призначення чи помилкова дата — не привід видаляти все пізніше.
    const kindOf = (r) => (r.role ? 'role' : store.cmdrs.includes(r) ? 'cmdr' : 'mvo');
    const DEL = { mvo: 'mvo-del', cmdr: 'cmdr-del', role: 'off-del' };
    const edit = (r) => rowBtn('as-edit', '✎ Виправити', `data-id="${esc(r.id)}" data-v="${kindOf(r)}"`,
      { title: 'Виправити дату, людину, строк чи підставу' });
    const del = (r) => rowBtn(DEL[kindOf(r)], '✕ Видалити', `data-id="${esc(r.id)}"`, { bad: true, title: 'Видалити помилковий запис' });
    // Історія призначень — кілька слів на запис, тож і кнопки при них дрібніші.
    const histOf = (list, cur) => list.filter((r) => r !== cur).map((r) =>
      `<span title="${esc(r.note || '')}">${esc(pSign(personBy(r.person)) || '—')} ${fmtDate(r.from)}–${r.to ? fmtDate(r.to) : '…'}</span>`
      + ` <span class="acts__more">${edit(r)}${del(r)}</span>`).join('; ');
    const mvoData = allSubs.map((sub) => {
      const list = store.mvo.filter((r) => r.sub === sub).sort((x, y) => (y.from || '').localeCompare(x.from || ''));
      return { sub, list, cur: list.find((r) => openOn(r, date)), has: holders.includes(sub), sb: subBy.get(sub) };
    });
    const nameOfCur = (x) => (x.cur ? pSign(personBy(x.cur.person)) || '' : '');
    // Без майна МВО не потрібен: такий рядок — лише історія, а не справа до виконання.
    const mvoReg = registry({
      id: 'mvo', rows: mvoData, minWidth: '980px', panelCls: 'panel--inset', placeholder: 'Пошук: підрозділ, прізвище',
      search: (x) => [x.sub, nameOfCur(x)],
      filters: [
        { type: 'seg', key: 'st', options: [['', 'усі'], ['none', 'не призначено'], ['set', 'призначено']],
          test: (x, v) => (v === 'set' ? !!x.cur : !x.cur && x.has) },
        { type: 'toggle', key: 'has', label: 'з майном', test: (x) => x.has },
      ],
      columns: [
        { key: 'sub', label: 'підрозділ', cls: 'c-name', first: 1, sort: (x) => x.sb?.order ?? 999,
          cell: (x) => `<b>${esc(x.sub)}</b><small>${esc([x.sb?.type || '', x.sb && !x.sb.active ? 'закритий'
            : x.has ? '' : 'майна немає'].filter(Boolean).join(', '))}</small>` },
        { key: 'who', label: `МВО на ${fmtDate(date)}`, cls: 'c-txt', first: 1, sort: nameOfCur,
          cell: (x) => (x.cur ? who(x.cur) : x.has ? '<span class="num-bad">не призначено</span>' : '<span class="c-num--dim">—</span>') },
        { key: 'from', label: 'з дати', cls: 'c-date', sort: (x) => (x.cur ? x.cur.from || '' : ''), cell: (x) => (x.cur ? fmtDate(x.cur.from) : '—') },
        { key: 'hist', label: 'раніше', cls: 'c-txt', style: 'flex:0 1 300px', cell: (x) => `<small>${histOf(x.list, x.cur)}</small>` },
        { key: 'acts', label: '', cls: 'c-acts', cell: (x) => (x.cur ? `${edit(x.cur)}${rowBtn('mvo-end', 'Закрити', `data-id="${esc(x.cur.id)}"`,
          { title: 'Людина більше не відповідає: закрити призначення датою' })}${del(x.cur)}` : '') },
      ],
      acts: '250px',
      row: (x) => ({ cls: `tbl__row--plain${x.cur || !x.has ? '' : ' is-due'}` }),
      count: (shown, all) => `${shown.length === all.length ? cnt(all.length, 'підрозділ', 'підрозділи', 'підрозділів')
        : `${shown.length} із ${all.length}`} · без МВО ${all.filter((x) => !x.cur && x.has).length}`,
    });
    // Командири: підрозділи з майном, їхні вищі підрозділи (командир батальйону підписує й за
    // його їдальню та ВМТЗ, де свого не призначено) і ті, де призначення вже були.
    const above = holders.map((sub) => (subBy.get(sub) || {}).parent)
      .filter((p) => p && subBy.get(p) && subBy.get(p).type !== 'бригада');
    const cmdSubs = [...new Set(holders.concat(above, store.cmdrs.map((r) => r.sub)))]
      .sort((a, b) => (subBy.get(a)?.order ?? 999) - (subBy.get(b)?.order ?? 999));
    const cmdData = cmdSubs.map((sub) => {
      const list = store.cmdrs.filter((r) => r.sub === sub).sort((x, y) => (y.from || '').localeCompare(x.from || ''));
      const cur = list.find((r) => openOn(r, date));
      return { sub, list, cur, up: cur ? null : cmdrFor(sub, date), has: holders.includes(sub), sb: subBy.get(sub) };
    });
    const cmdName = (x) => (x.cur ? pSign(personBy(x.cur.person)) || '' : x.up ? pSign(x.up) : '');
    const cmdReg = registry({
      id: 'cmdr', rows: cmdData, minWidth: '980px', panelCls: 'panel--inset', placeholder: 'Пошук: підрозділ, прізвище',
      search: (x) => [x.sub, cmdName(x)],
      filters: [
        { type: 'seg', key: 'st', options: [['', 'усі'], ['none', 'не призначено'], ['set', 'призначено']],
          test: (x, v) => (v === 'set' ? !!(x.cur || x.up) : !x.cur && !x.up && x.has) },
        { type: 'toggle', key: 'has', label: 'з майном', test: (x) => x.has },
      ],
      columns: [
        { key: 'sub', label: 'підрозділ', cls: 'c-name', first: 1, sort: (x) => x.sb?.order ?? 999,
          cell: (x) => `<b>${esc(x.sub)}</b><small>${esc([x.sb?.type || '', x.sb && !x.sb.active ? 'закритий'
            : x.has ? '' : 'майна немає'].filter(Boolean).join(', '))}</small>` },
        { key: 'who', label: `командир на ${fmtDate(date)}`, cls: 'c-txt', first: 1, sort: cmdName,
          cell: (x) => (x.cur ? who(x.cur) : x.up ? `${esc(pSign(x.up))}<small>за вищим підрозділом</small>`
            : x.has ? '<span class="num-bad">не призначено</span>' : '<span class="c-num--dim">—</span>') },
        { key: 'from', label: 'з дати', cls: 'c-date', sort: (x) => (x.cur ? x.cur.from || '' : ''), cell: (x) => (x.cur ? fmtDate(x.cur.from) : '—') },
        { key: 'hist', label: 'раніше', cls: 'c-txt', style: 'flex:0 1 300px', cell: (x) => `<small>${histOf(x.list, x.cur)}</small>` },
        { key: 'acts', label: '', cls: 'c-acts', cell: (x) => (x.cur ? `${edit(x.cur)}${rowBtn('cmdr-end', 'Закрити', `data-id="${esc(x.cur.id)}"`,
          { title: 'Командир вибув: закрити призначення датою' })}${del(x.cur)}` : '') },
      ],
      acts: '250px',
      row: (x) => ({ cls: `tbl__row--plain${x.cur || x.up || !x.has ? '' : ' is-due'}` }),
      count: (shown, all) => `${shown.length === all.length ? cnt(all.length, 'підрозділ', 'підрозділи', 'підрозділів')
        : `${shown.length} із ${all.length}`} · без командира ${all.filter((x) => !x.cur && !x.up && x.has).length}`,
    });
    const roleRows = ROLES.map(([role, label, what]) => {
      const list = store.officials.filter((r) => r.role === role).sort((a, b) => (b.from || '').localeCompare(a.from || ''));
      const cur = list.find((r) => openOn(r, date));
      return `<div class="tbl__row tbl__row--plain${cur ? '' : ' is-due'}">
        <div class="c-name"><b>${esc(label)}</b><small>${esc(what)}</small></div>
        <div class="c-txt">${cur ? who(cur) : '<span class="num-bad">не призначено</span>'}</div>
        <div class="c-date">${cur ? fmtDate(cur.from) : '—'}</div>
        <div class="c-txt" style="flex:0 1 300px"><small>${histOf(list, cur)}</small></div>
        <div class="c-acts">${cur ? `${edit(cur)}${rowBtn('off-end', 'Закрити', `data-id="${esc(cur.id)}"`,
          { title: 'Посадовець вибув без наступника: закрити призначення датою' })}${del(cur)}` : ''}</div>
      </div>`;
    }).join('');
    const a = state.assign || {};
    const subOpts = pickableSubs(a.sub).filter((sb) => sb.type !== 'бригада').map((sb) =>
      `<option value="${esc(sb.name)}"${a.sub === sb.name ? ' selected' : ''}>${esc(sb.name)}</option>`).join('');
    const roleOpts = ROLES.map(([r, l]) => `<option value="${esc(r)}"${a.role === r ? ' selected' : ''}>${esc(l)}</option>`).join('');
    const tbl = (title, rows, first) => `<div class="card card--scroll" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">${title}</div></div>
      <div class="tbl" style="--tbl-min:980px;--acts:250px"><div class="tbl__head"><div class="tbl__h c-name">${first}</div>
        <div class="tbl__h c-txt">чинна особа на ${fmtDate(date)}</div><div class="tbl__h c-date">з дати</div>
        <div class="tbl__h c-txt" style="flex:0 1 300px">раніше</div><div class="tbl__h c-acts"></div></div>
        ${rows}</div></div>`;
    return `<div class="panel"><div class="panel__note">Нове призначення діє з указаної дати й тією самою датою
        завершує попереднє. Помилковий запис в історії можна виправити або видалити кнопками в рядку.</div></div>
      <div class="card form" style="margin-bottom:12px">
        <div class="card__head"><div class="card__title">${a.id ? 'Виправити запис' : 'Призначити'}</div>
          ${a.id ? '' : `<div class="seg" style="margin-left:12px">${[['mvo', 'МВО підрозділу'], ['cmdr', 'командира підрозділу'],
            ['role', 'посадовця']].map(([k, l]) =>
            `<button type="button" data-act="as-kind" data-v="${k}"${(a.kind || 'mvo') === k ? ' class="is-on"' : ''}>${l}</button>`).join('')}</div>`}</div>
        <div class="form__grid">
          ${(a.kind || 'mvo') !== 'role'
            ? `<div class="field"><label>Підрозділ</label><select data-as="sub"${a.id ? ' disabled' : ''}><option value="">— оберіть —</option>${subOpts}</select></div>`
            : `<div class="field"><label>Посада</label><select data-as="role"${a.id ? ' disabled' : ''}><option value="">— оберіть —</option>${roleOpts}</select></div>`}
          <div class="field"><label>Хто</label><select data-as="person">${personOptions(a.person, a.from || date)}</select></div>
          <div class="field"><label>З дати</label><input type="date" data-as="from" value="${esc(a.from || date)}"></div>
          ${a.id ? `<div class="field"><label>По дату</label><input type="date" data-as="to" value="${esc(a.to || '')}"
            title="Перший день, коли людина вже не відповідає; порожньо — чинне"></div>` : ''}
          <div class="field"><label>Підстава</label><input data-as="note" value="${esc(a.note || '')}" placeholder="наказ №, дата"></div>
        </div>
        <div class="card__foot"><button class="btn btn--primary" data-act="as-add">${a.id ? 'Зберегти запис' : 'Призначити'}</button>
          ${a.id ? '<button class="btn" data-act="as-cancel">Скасувати</button>' : ''}
          <span class="panel__count">${a.id ? 'Строк дії не може перекривати сусідні призначення'
            : 'Призначення з давнішою датою стане в історію на своє місце. Нову людину спершу додайте на вкладці «Військовослужбовці»'}</span></div>
      </div>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Матеріально відповідальні особи підрозділів</div></div>
        ${mvoReg.panel}<div class="card--scroll">${mvoReg.table}</div></div>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Командири (начальники) підрозділів</div></div>
        ${cmdReg.panel}<div class="card--scroll">${cmdReg.table}</div></div>
      ${tbl('Посадовці частини, що підписують документи служби', roleRows, 'посада')}`;
  }

  /** Нове призначення: попереднє відкрите закривається тією самою датою. */
  function assignAdd() {
    peopleInit();
    const a = state.assign || {};
    const kind = assignKind(a.kind);
    const K = ASSIGN[kind];
    const from = a.from || state.asOf;
    const what = a[K.key];
    if (!what || !a.person) { toast(K.key === 'sub' ? 'Оберіть підрозділ і людину.' : 'Оберіть посаду й людину.', true); return; }
    if (a.id) return assignFix(kind, a);
    const list = K.list().filter((r) => r[K.key] === what);
    if (list.some((r) => (r.from || '') === from)) {
      toast(`Призначення з ${fmtDate(from)} уже є. Виправте той запис кнопкою ✎.`, true);
      return;
    }
    // Пропущене колись призначення стає в історію на своє місце: діє до
    // наступного запису, а попередній закінчується його датою.
    const next = list.filter((r) => (r.from || '') > from).sort((x, y) => (x.from < y.from ? -1 : 1))[0];
    for (const r of list) if ((r.from || '') < from && (!r.to || r.to > from)) r.to = from;
    const rec = { id: uid(), person: a.person, from, to: next ? next.from : '', note: a.note || '', [K.key]: what };
    K.list().push(rec);
    logChange('призначено', K.tag + what,
      `${upFirst(K.name(what))}: ${pSign(personBy(rec.person))} з ${fmtDate(from)}${rec.note ? ' (' + rec.note + ')' : ''}`);
    save(true, true);
    state.assign = { kind };
    state.flash = `${upFirst(K.name(what))}: ${pSign(personBy(rec.person))} з ${fmtDate(from)}.`;
    render();
  }

  function assignEnd(id, kind = 'mvo') {
    const K = ASSIGN[assignKind(kind)];
    const arr = K.list();
    const r = arr.find((x) => x.id === id);
    if (!r) return;
    const what = K.key === 'sub' ? r.sub : roleName(r.role);
    const to = prompt(`Закрити призначення «${what}». З якої дати людина більше не відповідає? (РРРР-ММ-ДД)`, today());
    if (!to) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to) || (r.from && to <= r.from)) { toast('Дата має бути пізнішою за дату призначення.', true); return; }
    // Строк не може зайти на наступне призначення того самого підрозділу чи посади.
    const next = arr.filter((x) => x.id !== r.id && x[K.key] === r[K.key]
      && (x.from || '') > (r.from || '')).sort((a, b) => (a.from < b.from ? -1 : 1))[0];
    if (next && to > next.from) {
      toast(`З ${fmtDate(next.from)} «${what}» уже ${pSign(personBy(next.person))}. `
        + 'Закрийте не пізніше цієї дати.', true);
      return;
    }
    r.to = to;
    logChange('призначення закрито', K.tag + r[K.key], `${upFirst(K.name(r[K.key]))}: ${pSign(personBy(r.person))} по ${fmtDate(to)}`);
    save(true, true);
    render();
  }

  /** Виправлення запису призначення: людина, строк, підстава. Строк не має
   *  заходити на сусідні записи того самого підрозділу чи посади. */
  function assignFix(kind, a) {
    const K = ASSIGN[assignKind(kind)];
    const arr = K.list();
    const r = arr.find((x) => x.id === a.id);
    if (!r) { state.assign = { kind }; return render(); }
    const from = a.from || r.from || '';
    const to = a.to || '';
    if (to && to <= from) { toast('«По» має бути пізніше за «з».', true); return; }
    const hit = arr.find((x) => x.id !== r.id && x[K.key] === r[K.key]
      && (x.from || '') < (to || '9999') && from < (x.to || '9999'));
    if (hit) {
      toast(`Строк перекривається із записом ${pSign(personBy(hit.person))} з ${fmtDate(hit.from)}`
        + `${hit.to ? ' по ' + fmtDate(hit.to) : ''}. Спершу виправте той запис.`, true);
      return;
    }
    const before = `${pSign(personBy(r.person))} ${fmtDate(r.from)}–${r.to ? fmtDate(r.to) : '…'}${r.note ? ' (' + r.note + ')' : ''}`;
    Object.assign(r, { person: a.person, from, to, note: a.note || '' });
    logChange('призначення виправлено', K.tag + r[K.key],
      `${upFirst(K.name(r[K.key]))}: ${before} → ${pSign(personBy(r.person))} ${fmtDate(r.from)}–${r.to ? fmtDate(r.to) : '…'}${r.note ? ' (' + r.note + ')' : ''}`);
    state.assign = { kind };
    save(true, true);
    render();
  }

  function assignDelete(kind, id) {
    const K = ASSIGN[assignKind(kind)];
    const arr = K.list();
    const r = arr.find((x) => x.id === id);
    if (!r) return;
    if (!confirm(`Видалити запис «${upFirst(K.name(r[K.key]))}: ${pSign(personBy(r.person))}`
      + ` з ${fmtDate(r.from)}»?\n\nЯкщо змінилася людина, не видаляйте, а призначте нову.`)) return;
    // Нове призначення закрило попереднє своєю датою (assignAdd). Видалення
    // помилкового запису повертає попереднє: воно знову діє до наступного
    // запису, якщо такий є, інакше без кінця. Раніше підрозділ лишався без
    // чинного МВО, і це ніде не було видно.
    const same = (x) => x.id !== r.id && x[K.key] === r[K.key];
    const next = arr.filter((x) => same(x) && (x.from || '') > (r.from || '')).sort((a, b) => (a.from < b.from ? -1 : 1))[0];
    const back = arr.filter((x) => same(x) && x.to && x.to === r.from);
    for (const x of back) x.to = next ? next.from : '';
    K.set(arr.filter((x) => x.id !== id));
    logChange('призначення видалено', K.tag + r[K.key],
      `${upFirst(K.name(r[K.key]))}: ${pSign(personBy(r.person))} з ${fmtDate(r.from)}`
      + (back.length ? `; знову чинне: ${back.map((x) => pSign(personBy(x.person))).join(', ')}` : ''));
    save(true, true);
    render();
  }

  /** Поля довідників, що живуть не на екрані людей: запис підрозділу, строки
   *  норм і штат табельної позиції по підрозділах. */
  function bindDirs() {
    $('#scroll').querySelectorAll('[data-sd]').forEach((el) => el.addEventListener('change', () => {
      const r = subById(el.dataset.id);
      if (!r) return;
      const v = el.value.trim();
      if (el.dataset.sd === 'name') {
        if (!v || (v !== r.name && subBy.has(v))) {
          toast(v ? `Підрозділ «${v}» уже є в довіднику.` : 'Назва не може бути порожньою.', true);
          return render();
        }
        if (v !== r.name && subUses(r.name)) {
          toast('За підрозділом є записи в обліку. Змініть назву кнопкою «Виправити назву» чи «Перейменувати».', true);
          return render();
        }
      }
      // Дерево не має дат: нове підпорядкування підрозділу з документами змінює
      // й підсумки минулих дат (роллап, охоплення звірок та інвентаризацій).
      if (el.dataset.sd === 'parent' && v !== r.parent && subUses(r.name)
        && !confirm(`«${r.name}» переходить ${v ? `у «${v}»` : 'на верхній рівень'}.\n\n`
          + 'Зведення, штат і охоплення звірок та інвентаризацій за минулі дати теж рахуватимуться по-новому. Змінити?')) {
        return render();
      }
      if (el.dataset.sd === 'parent' && v !== r.parent) {
        logChange('підпорядкування змінено', 'sub|' + r.name, `«${r.name}»: ${r.parent ? '«' + r.parent + '»' : 'верхній рівень'} → ${v ? '«' + v + '»' : 'верхній рівень'}`);
      }
      r[el.dataset.sd] = v;
      return subsChanged(false);
    }));
    $('#scroll').querySelectorAll('[data-sn]').forEach((el) => el.addEventListener('change', () => {
      state.subNew = Object.assign({}, state.subNew, { [el.dataset.sn]: el.value.trim() });
    }));
    $('#scroll').querySelectorAll('[data-sr]').forEach((el) => el.addEventListener('change', () => {
      state.subRen = Object.assign({}, state.subRen, { [el.dataset.sr]: el.value.trim() });
    }));
    $('#scroll').querySelectorAll('[data-nm]').forEach((el) => el.addEventListener('change', () => {
      const n = normById(el.dataset.nm);
      if (!n) return;
      const k = el.dataset.k;
      if (k === 'from' || k === 'to') {
        // Строки перевіряються тут, а не базою: «по» пізніше за «з» і без
        // перекриття з іншими нормами тієї самої позиції підрозділу.
        const next = Object.assign({}, n, { [k]: el.value.trim() });
        const same = (x) => x.id !== n.id && x.sub === n.sub && (n.code ? x.code === n.code
          : x.form === n.form && x.line === n.line);
        const hit = normsInit().filter(same).find((x) => (x.from || '') < (next.to || '9999')
          && (next.from || '') < (x.to || '9999'));
        const bad = next.to && next.to <= (next.from || '')
          ? '«По» має бути пізніше за «з».'
          : hit ? `Строк перекривається з нормою ${fmtNum(hit.qty)} з ${fmtDate(hit.from) || 'початку'}`
            + `${hit.to ? ' по ' + fmtDate(hit.to) : ''} — спершу змініть її.` : '';
        if (bad) { toast(bad, true); el.value = n[k] || ''; return; }
      }
      const it = n.code ? itemBy.get(n.code) : null;
      const what = n.code ? `${n.code} «${it ? cleanName(it.name) : 'позиція'}»` : `«${n.line}» (${n.form})`;
      const before = k === 'qty' ? fmtNum(n.qty, '0') : k === 'basis' ? n.basis || '—' : fmtDate(n[k]) || '—';
      if (k === 'qty') {
        const v = Math.max(0, parseFloat(String(el.value).replace(',', '.')) || 0);
        // Нуль у строку норми — це видалення норми разом з історією: лише за згодою.
        if (!v && !confirm(`Штат 0: видалити норму ${what} для «${n.sub}»?\n\n`
          + 'Вона зникне й із розрахунків минулих дат. Якщо штат змінився — закрийте норму датою «по».')) {
          el.value = String(n.qty);
          return;
        }
        n.qty = v;
      } else n[k] = el.value.trim();
      if (!n.qty) store.norms = store.norms.filter((x) => x.id !== n.id);
      const after = !n.qty ? 'видалено' : k === 'qty' ? fmtNum(n.qty, '0') : k === 'basis' ? n.basis || '—' : fmtDate(n[k]) || '—';
      const label = { qty: 'штат', from: 'з', to: 'по', basis: 'підстава' }[k] || k;
      logChange(n.qty ? 'штат змінено' : 'норму видалено', 'norm|' + n.id, `${what}, ${n.sub}: ${label} ${before} → ${after}`);
      save(true, true);
      render();
    }));
    $('#scroll').querySelectorAll('[data-lcadd]').forEach((el) => el.addEventListener('change', () => {
      const key = el.dataset.lcadd, code = el.value;
      if (!code) return;
      const form = key.slice(0, key.indexOf('|'));
      const other = reportLines.find((l) => l.form === form && l.form + '|' + l.line !== key && l.codes.includes(code));
      if (other && !confirm(`Код ${code} уже в рядку «${other.line}» форми ${form}: наявність рахувалася б в обох.\n\n`
        + 'Прив’язати й сюди?')) { el.value = ''; return; }
      lineCodesSet(key, (lineCodes.get(key) || []).concat([code]).sort());
    }));
    $('#scroll').querySelectorAll('[data-nmadd]').forEach((el) => el.addEventListener('change', () => {
      const [form, line] = String(el.dataset.nmadd).split('|');
      if (!el.value) return;
      normSet({ sub: el.value, form, line }, 1, state.asOf, true);   // «чинна з …», як обіцяє підпис
      save(true, true);
      render();
    }));
    $('#scroll').querySelectorAll('[data-snorm]').forEach((el) => el.addEventListener('change', () => {
      const [form, line, sub] = String(el.dataset.snorm).split('|');
      const v = parseFloat(String(el.value).replace(',', '.'));
      normSet({ sub, form, line }, v > 0 ? v : 0, state.asOf);
      save(true, true);
      render();
    }));
  }

  function bindPeople() {
    if (state.view !== 'people') return;
    const p = personBy(state.personId);
    $('#scroll').querySelectorAll('[data-pf]').forEach((el) => el.addEventListener('change', () => {
      if (!p) return;
      let v = el.value.trim();
      if (el.dataset.pf === 'surname') v = v.toUpperCase();
      p[el.dataset.pf] = v;
      save();
      render();
    }));
    $('#scroll').querySelectorAll('[data-ph]').forEach((el) => el.addEventListener('change', () => {
      const h = p && p.hist[+el.dataset.ph];
      if (!h) return;
      h[el.dataset.k] = el.value.trim();
      save();
      render();
    }));
    $('#scroll').querySelectorAll('[data-as]').forEach((el) => el.addEventListener('change', () => {
      state.assign = Object.assign(state.assign || {}, { [el.dataset.as]: el.value });
      if (el.dataset.as === 'from') render();
    }));
    $('#scroll').querySelectorAll('[data-uf]').forEach((el) => el.addEventListener('change', () => {
      store.unit = Object.assign({}, store.unit, { [el.dataset.uf]: el.value.trim() });
      save();
      render();
    }));
    $('#scroll').querySelectorAll('[data-loc]').forEach((el) => el.addEventListener('change', () => {
      const r = (store.locations || []).find((x) => x.id === el.dataset.loc);
      if (!r) return;
      r[el.dataset.k] = el.value.trim();
      save();
      render();
    }));
  }

  // ============================================================ ВКЛАДЕННЯ
  /** Файли до чого завгодно: скани документів, фото шильдика кухні, наказ
   *  про інвентаризацію. Ключ — до чого підшито:
   *    ключ документа — документ, «recon|id» — відомість звірки, «item|код» —
   *    позиція номенклатури, «unit|код|зав.№» — окрема одиниця, «st|id» —
   *    інвентаризація. Файл лежить у «Дані обліку/скани», у стані — посилання. */
  const IMG_EXT = /\.(jpe?g|png|gif|bmp|webp)$/i;
  const PDF_EXT = /\.pdf$/i;
  const fileUrl = (path) => 'скани/' + String(path).split('/').map(encodeURIComponent).join('/');
  const fmtSize = (n) => (!n ? '' : n < 1024 ? n + ' Б' : n < 1048576 ? Math.round(n / 1024) + ' КБ'
    : (n / 1048576).toFixed(1).replace('.', ',') + ' МБ');
  const fileIcon = (path) => (PDF_EXT.test(path) ? 'PDF' : /\.(docx?|odt|rtf)$/i.test(path) ? 'DOC'
    : /\.(xlsx?|ods|csv)$/i.test(path) ? 'XLS' : /\.(zip|rar|7z)$/i.test(path) ? 'ZIP'
      : /\.(p7s|asice|asics|sig)$/i.test(path) ? 'КЕП' : IMG_EXT.test(path) ? 'IMG' : 'ФАЙЛ');
  /** Файли за ключем. Документ — «вид|дата|номер|від|кому»: скани з бази за
   *  записом документа, підшиті тут — за цим ключем, давні, підшиті до
   *  «дата|номер», — на кожному документі з цими датою й номером. */
  const filesOf = (key) => {
    // Рапорт із бази — за записом документа: скани, підшиті в базі.
    const rp = /^dz\|(\d+)$/.exec(key);
    if (rp) {
      return (docScans.get(+rp[1]) || []).concat((store.scans || []).filter((x) => x.key === key)
        .map((x) => ({ file: x.file, path: x.path, mime: x.mime, size: x.size, mine: true, added: x.added })));
    }
    const m = DOC_FILE_KEY.exec(key);
    const legacy = m ? m[2] + '|' + m[3] : null;
    const base = m ? idsOfDoc(key).flatMap((id) => docScans.get(id) || []).concat(scans.get(legacy) || [])
      : (scans.get(key) || []);
    return base.concat((store.scans || []).filter((x) => x.key === key || (legacy && x.key === legacy))
      .map((x) => ({ file: x.file, path: x.path, mime: x.mime, size: x.size, mine: true, added: x.added })));
  };

  /** Куди й під яким ім'ям покласти файл, підшитий до ключа. */
  function fileTarget(key) {
    const [kind, a, b] = String(key).split('|');
    if (kind === 'recon') {
      const r = reconById(a);
      return r ? { key, date: r.date, no: r.no || '', label: `відомість${r.no ? ' №' + r.no : ''} ${r.sub}` } : null;
    }
    if (kind === 'item') return { key, date: today(), no: '', label: a, folder: `майно/${a}` };
    if (kind === 'unit') return { key, date: today(), no: '', label: `${a} зав.№${b}`, folder: `майно/${a}` };
    if (kind === 'paper') {
      const p = paperById(a);
      return p ? { key, date: p.date || today(), no: p.no || '', label: PAPER[p.kind].one, folder: p.kind === 'valuation' ? 'відомості залишкової вартості' : 'акти ЯТС' } : null;
    }
    if (kind === 'st') {
      const inv = invById(a);
      return inv ? { key, date: today(), no: '', label: `інвентаризація ${inv.date}`,
        folder: `інвентаризації/${inv.date}` } : null;
    }
    if (kind === 'dz') {
      const r = allDestroyed().find((x) => reportKey(x) === key);
      return r ? { key, date: r.reportDate || r.date, no: r.report || '', label: `рапорт ${r.sub}`, folder: 'рапорти' } : null;
    }
    // Документ: «вид|дата|номер|від|кому».
    return DOC_FILE_KEY.test(key) ? { key, date: a, no: b } : null;
  }

  /** Картка «Файли»: мініатюри фото, значки решти, клац — перегляд. */
  function filesCard(key, title, hint) {
    const list = filesOf(key);
    const items = list.map((f, i) => `<div class="file" data-vw="${i}" data-vw-key="${esc(key)}" title="${esc(f.file)}${f.note ? '&#10;' + esc(f.note) : ''}">
        ${native && IMG_EXT.test(f.path) ? `<img class="file__thumb" src="${fileUrl(f.path)}?w=320" loading="lazy" alt="">`
          : `<span class="file__ico">${fileIcon(f.path)}</span>`}
        <span class="file__name">${esc(f.file)}</span>
        <span class="file__meta">${esc([f.kind, fmtSize(f.size), f.added ? fmtDate(f.added) : ''].filter(Boolean).join(' · '))}</span>
        ${f.mine ? `<button type="button" class="ico-btn ico-btn--bad file__del" data-act="scan-del" data-path="${esc(f.path)}"
          title="Відв’язати файл">✕</button>` : ''}
      </div>`).join('');
    return `<div class="card files" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">${esc(title)}</div><div class="panel__spacer"></div>
        <span class="panel__count">${list.length ? cnt(list.length, 'файл', 'файли', 'файлів') : esc(hint || '')}</span>
        ${native ? `<button class="btn" data-act="file-add" data-key="${esc(key)}">+ Додати файл</button>` : ''}</div>
      ${list.length ? `<div class="files__grid">${items}</div>`
        : `<div class="files__empty">${native ? 'Перетягніть сюди скан, фото чи документ або натисніть «+ Додати файл».'
          : 'Файли додаються в програмі на комп’ютері.'}</div>`}
    </div>`;
  }

  /** Перегляд файла поверх екрана: фото й PDF — тут же, решта — у своїй програмі. */
  function openViewer(key, idx) {
    if (!native) { toast('Файли переглядаються в програмі на комп’ютері.', true); return; }
    state.viewer = { key, idx: +idx || 0 };
    viewerRender();
  }
  function viewerClose() { state.viewer = null; viewerRender(); }
  function viewerRender() {
    let el = $('#viewer');
    const v = state.viewer;
    const list = v ? filesOf(v.key) : [];
    if (!v || !list.length) { if (el) el.remove(); state.viewer = null; return; }
    v.idx = Math.max(0, Math.min(v.idx, list.length - 1));
    const f = list[v.idx];
    const url = fileUrl(f.path);
    if (!el) {
      el = document.createElement('div');
      el.id = 'viewer';
      el.className = 'viewer';
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-vw-do]');
        if (e.target === el) return viewerClose();
        if (!b) return;
        const what = b.dataset.vwDo;
        if (what === 'close') viewerClose();
        else if (what === 'prev' || what === 'next') { state.viewer.idx += what === 'next' ? 1 : -1; viewerRender(); }
        else if (what === 'open' || what === 'reveal') fileOpen(filesOf(state.viewer.key)[state.viewer.idx], what === 'reveal');
      });
      document.body.appendChild(el);
    }
    const body = IMG_EXT.test(f.path) ? `<img src="${url}" alt="${esc(f.file)}">`
      : PDF_EXT.test(f.path) ? `<iframe src="${url}" title="${esc(f.file)}"></iframe>`
        : `<div class="viewer__none"><div class="file__ico file__ico--big">${fileIcon(f.path)}</div>
            <p>«${esc(f.file)}»${f.size ? ' · ' + fmtSize(f.size) : ''}</p>
            <p>Цей файл відкривається окремою програмою.</p>
            <button class="btn btn--primary" data-vw-do="open">Відкрити</button></div>`;
    el.innerHTML = `<div class="viewer__box">
      <div class="viewer__bar">
        <b class="viewer__name" title="${esc(f.file)}">${esc(f.file)}</b>
        <span class="viewer__count">${list.length > 1 ? `${v.idx + 1} із ${list.length}` : ''}</span>
        ${list.length > 1 ? '<button class="btn btn--sm" data-vw-do="prev" title="Попередній файл (←)">◀</button>'
          + '<button class="btn btn--sm" data-vw-do="next" title="Наступний файл (→)">▶</button>' : ''}
        <button class="btn btn--sm" data-vw-do="open" title="Відкрити програмою Windows">Відкрити окремо</button>
        ${me.remote ? '' : '<button class="btn btn--sm" data-vw-do="reveal">Показати в теці</button>'}
        <button class="btn btn--sm" data-vw-do="close" title="Закрити (Esc)">✕</button>
      </div>
      <div class="viewer__body">${body}</div></div>`;
  }
  async function fileOpen(f, reveal = false) {
    if (!f) return;
    // З іншого ПК файл відкриває браузер: програми Windows основного ПК тут ні до чого.
    if (me.remote) { window.open(fileUrl(f.path), '_blank'); return; }
    try {
      const r = await fetch(reveal ? 'api/reveal' : 'api/open', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: f.path }) });
      if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
    } catch (e) {
      toast(`Не вдалося відкрити «${f.file}»: ${e.message || e}`, true);
    }
  }

  // ============================================================ ІНВЕНТАРИЗАЦІЯ
  /** Інвентаризація — окрема подія: наказ, комісія, дати, описи й акт, скани.
   *  Описи складаються з обліку на дату — по кожному підрозділу, що тримає майно,
   *  окремо необоротні активи й запаси (форма наказу Мінфіну від 17.06.2015 №572).
   *  «Фактично» за замовчуванням — облік мінус знищене, ще не списане; комісія
   *  виправляє там, де порахувала інакше, і розбіжності йдуть в акт. */
  const ACC_FIXED = '1116 «Необоротні матеріальні активи спеціального призначення», 1016 «Інструменти, '
    + 'прилади, інвентар», 1113 «Малоцінні необоротні матеріальні активи», 1014 «Машини та обладнання»';
  // Субрахунок 1511 «Продукти харчування» — в описах продуктів, не техзасобів (власник, 01.10.2026).
  const ACC_STOCK = '1812 «Малоцінні та швидкозношувані предмети», 1516 «Тара»';
  const ST_KINDS = ['щорічна', 'позапланова', 'чергова'];
  const ST_GEN = { 'щорічна': 'щорічної', 'позапланова': 'позапланової', 'чергова': 'чергової' };
  const ST_FINDINGS = [
    '- оперативний облік у службі ведеться згідно з вимогами наказу Міністерства оборони України від 17.08.2017 № 440;',
    '- звірка облікових даних продовольчої служби тилу логістики зі складським та бухгалтерським обліком проводиться своєчасно;',
    '- фактична наявність військового майна відповідає даним бухгалтерського обліку та первинним документам;',
    '- збереження матеріальних цінностей служби забезпечено у відповідності з вимогами керівних документів щодо порядку їх зберігання.',
  ].join('\n');
  const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня',
    'вересня', 'жовтня', 'листопада', 'грудня'];
  const dayMonth = (iso) => (iso ? `${+iso.slice(8, 10)} ${MONTHS_GEN[+iso.slice(5, 7) - 1]}` : '___ ________');
  const dateWords = (iso) => (iso ? `${dayMonth(iso)} ${iso.slice(0, 4)} року` : '___ ________ 20__ року');
  const dateShort = (iso) => (iso ? `${dayMonth(iso)} ${iso.slice(0, 4)}р.` : '___ ________ 20__р.');
  const quoteDate = (iso) => (iso ? `«${+iso.slice(8, 10)}» ${MONTHS_GEN[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)} року`
    : '«___» ________ 20__ року');
  const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
  const round2 = (x) => Math.round(x * 100) / 100;

  // Хто затвердив і підписав, МВО описів — як записано в паперах самої
  // інвентаризації; чого там немає, підставить довідник на дату.
  const bIds = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, 'b' + v]));
  const baseInv = (D.inventories || []).map((x) => Object.assign({}, x, { base: true,
    head: x.head != null ? 'b' + x.head : '', members: (x.members || []).map((m) => 'b' + m),
    sign: bIds(x.sign), mvo: bIds(x.mvo), scope: x.scope || [], remark: x.note || '',
    where: {}, fact: {}, note: {}, status: 'завершено' }));
  // Папери інвентаризації з бази — у тому ж переліку файлів, що й підшиті в програмі.
  for (const x of baseInv) {
    for (const f of (x.files || [])) {
      const k = 'st|' + x.id;
      if (!scans.has(k)) scans.set(k, []);
      scans.get(k).push({ file: f[0], path: f[1], mime: f[2], size: f[3], kind: f[4], note: f[5] });
    }
  }
  /** «3 б ТрО» або «4 б ТрО, 2 б БпС і ще 9» — охоплення коротко. */
  const scopeShort = (sc) => (sc.length <= 3 ? sc.join(', ') : `${sc.slice(0, 2).join(', ')} і ще ${sc.length - 2}`);
  const inScope = (inv, sub) => !(inv.scope || []).length || inv.scope.some((t) => t === sub || inSubtree(t, sub));
  const allInv = () => baseInv.concat(store.inventories || []).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const invById = (id) => allInv().find((x) => x.id === id) || null;
  const stReadonly = (inv) => !inv || inv.base || inv.status === 'завершено';

  function stNew(from = null) {
    peopleInit();
    const t = today();
    const y = t.slice(0, 4);
    const date = t <= `${y}-12-25` ? `${y}-12-25` : t;
    // «На основі цієї» — саме цієї: склад комісії й тексти беруться з неї, а не з
    // останньої за датою.
    const prev = from && from.date < date ? from : allInv().filter((x) => x.date < date).pop();
    const inv = {
      id: uid(), kind: 'щорічна', date, start: `${y}-11-01` <= date ? `${y}-11-01` : date, end: date,
      orderNo: '', orderDate: '', prevDate: prev ? prev.date : '',
      head: prev ? prev.head || '' : '', members: prev ? (prev.members || []).slice() : [],
      sign: {}, mvo: {}, where: Object.assign({}, (prev && prev.where) || {}), fact: {}, note: {},
      accFixed: (prev && prev.accFixed) || ACC_FIXED, accStock: (prev && prev.accStock) || ACC_STOCK,
      findings: (prev && prev.findings) || ST_FINDINGS, status: 'чернетка', created: t,
    };
    store.inventories = store.inventories || [];
    store.inventories.push(inv);
    save();
    // Перша інвентаризація попередньої не має: про перенесений склад комісії їй казати нічого.
    state.flash = `Інвентаризацію станом на ${fmtDate(date)} заведено. ` + (prev
      ? `Склад комісії перенесено з попередньої (${fmtDate(prev.date)}). Перевірте склад і впишіть номер та дату наказу.`
      : 'Впишіть номер і дату наказу та склад комісії.');
    go('stocktake', { stId: inv.id, stSub: '' });
  }

  /** Підписанти: вказані в самій інвентаризації або посадовці з довідника на дату. */
  function stSigners(inv) {
    const pick = (k, role) => personBy((inv.sign || {})[k]) || officialAt(role, inv.date);
    return { chief: pick('chief', 'начальник служби'), buh: pick('buh', 'бухгалтер'),
      cmd: pick('cmd', 'командир'), nachlog: pick('nachlog', 'начальник логістики'),
      // Голову інвентаризаційної комісії частини називає наказ: довідник такої посади не веде.
      chair: personBy((inv.sign || {}).chair), fes: pick('fes', 'начальник ФЕС') };
  }
  const stMvo = (inv, sub) => personBy((inv.mvo || {})[sub]) || mvoAt(sub, inv.date);
  /** Командир підрозділу для опису: названий у самій інвентаризації або з довідника на дату. */
  const stCmdr = (inv, sub) => personBy((inv.cmdr || {})[sub]) || cmdrFor(sub, inv.date);
  /** «майор ПЕТРЕНКО Т. Г.» — член комісії в плані й протоколі. */
  const stMember = (p, date) => (p ? [personAt(p, date).rank, pShort(p)].filter(Boolean).join(' ') : '');
  const ST_SERVICE = 'продовольчої служби тилу логістики';

  /** Де зберігається майно — у тексті опису («та зберігаються: …»): правка в
   *  самому описі, місце з довідника (як і шапка відомості) або за правилами. */
  const WHERE_TOP = { 'склад': 'на продовольчому складі господарчого взводу роти матеріального забезпечення' };
  function stWhere(inv, sub) {
    if (inv.where && inv.where[sub]) return inv.where[sub];
    const [a, b] = String(sub).split(' · ');
    const place = (subTitles.get(sub) || {}).where
      || (b ? `в ${b === 'їдальня' ? 'їдальні' : b} ${a}` : (WHERE_TOP[a] || `в ${a}`));
    return `${place} ${unitGen()}`;
  }

  /** Рядки описів з обліку: партії підрозділу на дату, а одиниця із заводським номером чи
   *  номером шасі — своїм рядком на одну штуку: опис називає її номер, і комісія звіряє
   *  саме її. Знищене за рапортом віднімається спершу від названих у рапортах одиниць. */
  function stSource(sub, date, registry = false) {
    const out = [];
    const goneUnits = destroyedUnitsAt(sub, date);
    const placed = new Set();
    for (const l of reconLines(sub, date)) {
      const units = unitsAt(l.code, sub, date).filter((u) => Math.abs(u.price - l.price) < 0.005)
        .map((u) => unitBy.get(String(u.id))).filter((u) => u && (u.serial || u.chassis));
      // Одиниця, якої документи не називали: де вона, каже закріплення її інвентарного номера.
      if (registry) {
        for (const u of unitsOf.get(l.code) || []) {
          if (units.length + 1 > l.acc + 1e-9) break;
          if (!(u.serial || u.chassis) || placed.has(u.id) || unitMoves().has(String(u.id)) || invHolder(u) !== sub) continue;
          placed.add(u.id);
          units.push(u);
        }
      }
      if (!units.length || units.length > l.acc + 1e-9) { out.push(l); continue; }
      let gone = round3(l.acc - l.fact);
      const rows = units.map((u) => {
        const lost = gone > 1e-9 && goneUnits.has(String(u.id));
        if (lost) gone = round3(gone - 1);
        return { u, fact: lost ? 0 : 1 };
      });
      const bulk = round3(l.acc - units.length);
      const bulkGone = Math.min(bulk, Math.max(0, gone));
      gone = round3(gone - bulkGone);
      for (let i = rows.length - 1; i >= 0 && gone > 1e-9; i--) {
        if (rows[i].fact) { rows[i].fact = 0; gone = round3(gone - 1); }
      }
      for (const { u, fact } of rows) {
        out.push(Object.assign({}, l, { acc: 1, fact, note: fact ? '' : l.note, unit: String(u.id),
          serial: u.serial || '', chassis: u.chassis || '', year: u.year || '' }));
      }
      if (bulk > 1e-9) {
        out.push(Object.assign({}, l, { acc: bulk, fact: round3(bulk - bulkGone), note: bulkGone > 1e-9 ? l.note : '' }));
      }
    }
    return out;
  }

  /** За ким закріплено інвентарний номер одиниці («10109/012» — у діапазоні підрозділу). */
  function invHolder(u) {
    const seq = +String(u.inv || '').split('/')[1];
    if (!seq) return '';
    return (inventory.find((r) => r.code === u.code && r.from <= seq && seq <= r.to) || {}).sub || '';
  }

  /** Рядки описів підрозділу: партії на дату, «фактично» — з поправками комісії. Опис з бази
   *  (минулих років) складається лише з документів: закріплення номерів — нинішнє. */
  function stLines(inv, sub) {
    const src = inv.frozen ? (inv.frozen.lines || {})[sub] || [] : stSource(sub, inv.date, !inv.base);
    return src.map((l) => {
      const it = itemBy.get(l.code) || {};
      const key = `${sub}|${l.code}|${l.price}${l.unit ? '|u' + l.unit : ''}`;
      const fact = inv.fact && inv.fact[key] != null ? +inv.fact[key] : l.fact;
      const note = inv.note && inv.note[key] != null ? inv.note[key] : l.note;
      const one = l.unit ? l : it;                    // одиниця рядка або єдина одиниця позиції
      return { key, code: l.code, name: l.name, uom: l.uom, price: l.price, acc: l.acc, def: l.fact, fact, note,
        fixed: !!it.nonrev, unit: l.unit || '', fes: it.fes || '',
        serial: one.serial || '', chassis: one.chassis || '', year: one.year || '' };
    });
  }
  /** Заводський номер рядка, а без нього — номер шасі: графа «заводський» опису. */
  const stSerial = (l) => l.serial || (l.chassis ? 'шасі ' + l.chassis : '');
  const stSubs = (inv) => (inv.frozen ? (inv.frozen.subs || []).slice()
    : reconSubs(inv.date).filter((x) => x.pos).map((x) => x.sub).filter((sub) => inScope(inv, sub)));
  /** Інші місця плану — майно служби поза обліком програми (продукти, вода): назва, МВО й вид
   *  майна вписані руками. Рядок без назви місця ще порожній: у папери й підрахунки не йде. */
  const stPlaces = (inv) => (inv.places || []).filter((p) => String(p.place || '').trim());
  /** «запаси (продукти харчування)» → «запасів (продукти харчування)»: назва опису в реєстрі. */
  // Не \b: межа слова в JavaScript — лише для латиниці, після «запаси» вона не стає.
  const stKindsGen = (k) => String(k || '').trim().replace(/^запаси(?=\s|$)/i, 'запасів')
    .replace(/^необоротні активи(?=\s|$)/i, 'необоротних активів');
  /** Розбіжність, яку знайшла комісія: «фактично» не те, що дає облік мінус знищене.
   *  Знищене за рапортом, ще не списане, — не нестача: воно задокументоване й
   *  іде в акт окремим пунктом. */
  const stDiff = (l) => Math.abs(l.fact - l.def) > 1e-9;
  const stGone = (l) => l.def < l.acc - 1e-9;
  function stTotals(rows) {
    const t = { n: rows.length, accQty: 0, accSum: 0, factQty: 0, factSum: 0 };
    for (const l of rows) {
      t.accQty += l.acc; t.factQty += l.fact;
      t.accSum += round2(l.acc * l.price); t.factSum += round2(l.fact * l.price);
    }
    t.accQty = round3(t.accQty); t.factQty = round3(t.factQty);
    t.accSum = round2(t.accSum); t.factSum = round2(t.factSum);
    return t;
  }
  function stSummary(inv) {
    let lines = 0, diffs = 0, gone = 0, accSum = 0, short = 0, over = 0, goneSum = 0, descs = 0;
    const perSub = new Map();
    for (const sub of stSubs(inv)) {
      const ls = stLines(inv, sub);
      const d = ls.filter(stDiff);
      const g = ls.filter(stGone);
      lines += ls.length; diffs += d.length; gone += g.length;
      descs += (ls.some((l) => l.fixed) ? 1 : 0) + (ls.some((l) => !l.fixed) ? 1 : 0);
      for (const l of ls) {
        accSum += round2(l.acc * l.price);
        goneSum += round2((l.acc - l.def) * l.price);
        const x = round2((l.fact - l.def) * l.price);
        if (x < 0) short -= x; else over += x;
      }
      perSub.set(sub, { lines: ls, diffs: d, gone: g });
    }
    return { lines, diffs, gone, accSum: round2(accSum), short: round2(short), over: round2(over),
      goneSum: round2(goneSum), descs, perSub };
  }

  /** Текст результату для акта. Без розбіжностей — однією фразою, як у
   *  паперовому акті. Знищене за рапортами, ще не списане, — окремим пунктом:
   *  це не нестача, а втрата, на яку вже є документ і чекає акт списання. */
  function stResultText(inv, sum = stSummary(inv)) {
    const out = [];
    if (!sum.diffs) out.push('За результатами проведеної інвентаризації лишків та нестач не встановлено.');
    else {
      out.push(`За результатами проведеної інвентаризації встановлено${sum.short ? ` нестачу на суму ${fmtMoney(sum.short)} грн` : ''}`
        + `${sum.short && sum.over ? ' та' : ''}${sum.over ? ` лишки на суму ${fmtMoney(sum.over)} грн` : ''}:`);
      for (const [sub, x] of sum.perSub) {
        for (const l of x.diffs) {
          const d = round3(l.fact - l.def);
          out.push(`- ${sub}: ${l.name} — ${d < 0 ? 'нестача' : 'лишок'} ${fmtNum(Math.abs(d))} ${l.uom}`
            + ` на суму ${fmtMoney(Math.abs(d) * l.price)} грн${l.note && !stGone(l) ? ` (${l.note})` : ''};`);
        }
      }
    }
    if (sum.gone) {
      out.push(`Майно, знищене й не списане на дату інвентаризації (підстава — рапорти, акти списання не проведено), `
        + `на суму ${fmtMoney(sum.goneSum)} грн:`);
      for (const [sub, x] of sum.perSub) {
        for (const l of x.gone) {
          const q = round3(l.acc - l.def);
          out.push(`- ${sub}: ${l.name} — ${fmtNum(q)} ${l.uom} на суму ${fmtMoney(q * l.price)} грн`
            + `${l.note ? ` (${l.note})` : ''};`);
        }
      }
    }
    return out.join('\n');
  }

  function stAttachText(inv, sum = stSummary(inv)) {
    return ['- Інвентаризаційні описи запасів (продовольчої служби), які рахуються за військовою частиною та її підрозділами;',
      '- Інвентаризаційні описи необоротних активів (продовольчої служби), які рахуються за військовою частиною '
      + `та її підрозділами (разом ${cnt(sum.descs + stPlaces(inv).length, 'опис', 'описи', 'описів')}).`].join('\n');
  }

  /** Описи підрозділів: по опису необоротних активів і запасів на кожного, хто тримає майно. */
  function stDescriptions(inv, list) {
    const date = inv.date;
    const qW = (q) => lowerFirst(qtyWords(q));
    const nW = (n) => intWords(n, 'm');
    const descriptions = [];
    for (const sub of list) {
      const lines = stLines(inv, sub);
      const mvo = stMvo(inv, sub);
      for (const fixed of [true, false]) {
        const rows = lines.filter((l) => l.fixed === fixed);
        if (!rows.length) continue;
        const t = stTotals(rows);
        descriptions.push({
          sheet: `${fixed ? 'Необор.' : 'Запаси'} ${sub}`, type: fixed ? 'fixed' : 'stock', sub,
          title: `${fixed ? 'необоротних активів' : 'запасів'} ${ST_SERVICE} ${stWhere(inv, sub)}`,
          where: stWhere(inv, sub), mvo: signer(mvo, date),
          // Наказ про інвентаризацію: опис підписує й командир підрозділу, де її проводили.
          cmdr: signer(stCmdr(inv, sub), date),
          rows: rows.map((l) => ({ name: l.name, uom: l.uom, price: l.price, acc: l.acc, fact: l.fact,
            accSum: round2(l.acc * l.price), factSum: round2(l.fact * l.price), note: l.note,
            // Номер ФЕС: інвентарний у необоротних активів, номенклатурний у запасів.
            inv: fixed ? l.fes : '', nomen: fixed ? '' : l.fes,
            serial: fixed ? stSerial(l) : '', year: fixed && l.year ? String(l.year) : '' })),
          totals: t,
          words: { n: nW(t.n), factQty: qW(t.factQty), factSum: lowerFirst(moneyWords(t.factSum)),
            accQty: qW(t.accQty), accSum: lowerFirst(moneyWords(t.accSum)) },
        });
      }
    }
    return descriptions;
  }

  /** План проведення інвентаризації: де, у кого, які описи, коли й хто з підкомісії. */
  function stPlan(inv) {
    const date = inv.date;
    const who = stSigners(inv);
    const tail = ' ' + unitGen();
    const rows = stSubs(inv).map((sub) => {
      const ls = stLines(inv, sub);
      const p = (inv.plan || {})[sub] || {};
      const m = stMvo(inv, sub);
      const where = stWhere(inv, sub);
      return { place: `${sub}\n${where.endsWith(tail) ? where.slice(0, -tail.length) : where}`,
        mvo: m ? [personAt(m, date).rank, pSign(m)].filter(Boolean).join(' ') : '',
        kinds: [ls.some((l) => l.fixed) ? 'необоротні активи' : '', ls.some((l) => !l.fixed) ? 'запаси' : '']
          .filter(Boolean).join(', '),
        date: p.date || '', who: stMember(personBy(p.who), date), mark: p.done ? `проведено ${fmtDate(p.done)}` : '' };
    });
    // Інші місця — після підрозділів з майном, у тому порядку, як їх вписано.
    for (const p of stPlaces(inv)) {
      rows.push({ place: p.place.trim(), mvo: String(p.mvo || '').trim(), kinds: String(p.kinds || '').trim(), date: p.date || '',
        who: stMember(personBy(p.who), date), mark: p.done ? `проведено ${fmtDate(p.done)}` : '' });
    }
    return { agree: signer(who.chair, date), approve: signer(who.cmd, date), rows };
  }

  /** Протокол комісії (форма наказу Мінфіну №572): що встановлено в наявності й що робити з
   *  розбіжностями. Знищене за рапортом, ще не списане, — втрата до списання; те, що комісія
   *  порахувала інакше, — лишок або нестача. */
  function stProtocol(inv) {
    const date = inv.date;
    const t = { fixedQty: 0, fixedSum: 0, stockQty: 0, stockSum: 0 };
    const rows = [];
    for (const sub of stSubs(inv)) {
      const m = stMvo(inv, sub);
      const mvo = m ? pSign(m) : '';
      for (const l of stLines(inv, sub)) {
        const k = l.fixed ? 'fixed' : 'stock';
        t[k + 'Qty'] = round3(t[k + 'Qty'] + l.fact);
        t[k + 'Sum'] = round2(t[k + 'Sum'] + round2(l.fact * l.price));
        const name = l.name + (stSerial(l) ? `, зав. № ${stSerial(l)}` : '');
        if (stGone(l)) {
          const q = round3(l.def - l.acc);
          rows.push({ name, mvo, qty: q, sum: round2(q * l.price), reason: l.note || '', loss: true });
        }
        if (stDiff(l)) {
          const q = round3(l.fact - l.def);
          rows.push({ name, mvo, qty: q, sum: round2(q * l.price), reason: stGone(l) ? '' : l.note || '' });
        }
      }
    }
    return { approve: signer(stSigners(inv).cmd, date), date: inv.end || date, totals: t, rows };
  }

  /** Реєстр паперів, які підкомісія здає начальникові ФЕС: акт, кожен опис і протокол. */
  function stRegister(inv) {
    const date = inv.date;
    const closed = inv.end || date;
    const rows = [{ doc: 'Акт інвентаризації', date: closed, who: '' }];
    for (const d of stDescriptions(inv, stSubs(inv))) {
      rows.push({ doc: `Інвентаризаційний опис ${d.type === 'fixed' ? 'необоротних активів' : 'запасів'}`, date,
        who: [[d.mvo.rank, d.mvo.name].filter(Boolean).join(' '), d.sub].filter(Boolean).join(', ') });
    }
    for (const p of stPlaces(inv)) {
      rows.push({ doc: `Інвентаризаційний опис ${stKindsGen(p.kinds)}`.trim(), date,
        who: [String(p.mvo || '').trim(), p.place.trim()].filter(Boolean).join(', ') });
    }
    rows.push({ doc: 'Протокол інвентаризаційної комісії', date: closed, who: '' });
    return { fes: signer(stSigners(inv).fes, date), rows };
  }

  /** Строки, які ставить наказ про інвентаризацію: що подати, до якого числа й коли подано. */
  const ST_DUE = [['plan', 'План проведення командирові', 'подання плану інвентаризації'],
    ['fes', 'Акти з описами начальникові ФЕС', 'здачі актів з описами інвентаризації начальникові ФЕС'],
    ['act', 'Акт командирові на затвердження', 'подання акта інвентаризації на затвердження']];
  /** Стан строку на дату: виконано, скільки днів лишилось чи на скільки прострочено. */
  function stDueState(inv, k, t = today()) {
    const due = (inv.due || {})[k] || '';
    const sent = (inv.sent || {})[k] || '';
    if (sent) return { due, sent, kind: 'done', text: `виконано ${fmtDate(sent)}` };
    if (!due) return { due, sent, kind: '', text: '' };
    const left = daysBetween(t, due);
    if (left < 0) return { due, sent, left, kind: 'late', text: `прострочено на ${cnt(-left, 'день', 'дні', 'днів')}` };
    return { due, sent, left, kind: left <= 7 ? 'soon' : 'wait',
      text: left ? `лишилось ${cnt(left, 'день', 'дні', 'днів')}` : 'строк сьогодні' };
  }
  /** Найближчий строк, якого ще не виконано. */
  function stNextDue(inv, t = today()) {
    return ST_DUE.map(([k, , what]) => Object.assign({ k, what }, stDueState(inv, k, t)))
      .filter((x) => x.due && !x.sent).sort((a, b) => a.due.localeCompare(b.due))[0] || null;
  }
  /** Підрозділи, де день за планом минув, а відмітки «проведено» немає. */
  const stLate = (inv, t = today()) => stSubs(inv).filter((sub) => {
    const p = (inv.plan || {})[sub] || {};
    return !!p.date && p.date < t && !p.done;
  }).concat(stPlaces(inv).filter((p) => !!p.date && p.date < t && !p.done).map((p) => p.place.trim()));

  /** Хід інвентаризації на дату: у яких підрозділах її вже проведено. */
  function stProgress(inv, asOf = today()) {
    const sum = stSummary(inv);
    const late = new Set(stLate(inv, asOf));
    const t = { subs: 0, done: 0, late: late.size, descs: 0, doneDescs: 0, lines: 0, sum: 0, doneSum: 0, diffs: 0 };
    const rows = stSubs(inv).map((sub) => {
      const ls = (sum.perSub.get(sub) || { lines: [] }).lines;
      const p = (inv.plan || {})[sub] || {};
      const m = stMvo(inv, sub);
      const descs = (ls.some((l) => l.fixed) ? 1 : 0) + (ls.some((l) => !l.fixed) ? 1 : 0);
      const money = round2(ls.reduce((a, l) => a + round2(l.acc * l.price), 0));
      const done = p.done && p.done <= asOf ? p.done : '';
      const diffs = ls.filter(stDiff).length;
      t.subs += 1; t.descs += descs; t.lines += ls.length; t.sum = round2(t.sum + money); t.diffs += diffs;
      if (done) { t.done += 1; t.doneDescs += descs; t.doneSum = round2(t.doneSum + money); }
      return { sub, mvo: m ? [personAt(m, inv.date).rank, pSign(m)].filter(Boolean).join(' ') : '', descs, lines: ls.length,
        sum: money, plan: p.date || '', done, late: late.has(sub), diffs, who: stMember(personBy(p.who), inv.date) };
    });
    // Інші місця плану: опис один, рядків і сум за обліком програми немає.
    for (const p of stPlaces(inv)) {
      const name = p.place.trim();
      const done = p.done && p.done <= asOf ? p.done : '';
      t.subs += 1; t.descs += 1;
      if (done) { t.done += 1; t.doneDescs += 1; }
      rows.push({ sub: name, mvo: String(p.mvo || '').trim(), descs: 1, lines: null, sum: null, plan: p.date || '', done,
        late: late.has(name), diffs: 0, who: stMember(personBy(p.who), inv.date), other: true });
    }
    return { date: asOf, rows, totals: t, short: sum.short, over: sum.over, gone: sum.gone, goneSum: sum.goneSum };
  }

  /** Відомості про хід інвентаризації для доповіді: підсумок словами й рядок на підрозділ. */
  function stProgressPaper(inv) {
    const p = stProgress(inv);
    const t = p.totals;
    const places = stPlaces(inv).length;
    const lines = [
      `Підрозділів із майном — ${t.subs - places}${places ? `, інших місць — ${places}` : ''}, інвентаризацію проведено в ${t.done}, `
        + `лишилось — ${t.subs - t.done}.`,
      `Описів — ${t.descs}, складено — ${t.doneDescs}.`,
      `Майна за обліком на ${fmtMoney(t.sum)} грн, перевірено на ${fmtMoney(t.doneSum)} грн.`,
      t.diffs ? `Розбіжності: рядків — ${t.diffs}${p.short ? `, нестача на ${fmtMoney(p.short)} грн` : ''}${
        p.over ? `, лишки на ${fmtMoney(p.over)} грн` : ''}.` : 'Лишків та нестач не встановлено.',
    ];
    if (p.gone) lines.push(`Знищене за рапортами, не списане: рядків — ${p.gone}, на ${fmtMoney(p.goneSum)} грн.`);
    if (t.late) lines.push(`День за планом минув, інвентаризацію не проведено: ${p.rows.filter((r) => r.late).map((r) => r.sub).join(', ')}.`);
    return { date: p.date, lines, rows: p.rows, totals: t };
  }

  /** Спека книги Excel: описи обраних підрозділів і папери підкомісії — акт, план, протокол,
   *  реєстр. `blank` — робочі описи: облік надруковано, фактичну наявність вписує комісія.
   *  `progress` — відомості про хід на сьогодні. */
  function stSpec(inv, list, withAct, more = {}) {
    const date = inv.date;
    const who = stSigners(inv);
    const only = [more.plan && 'План', more.protocol && 'Протокол', more.register && 'Реєстр'].filter(Boolean);
    const name = more.blank ? 'Робочі описи' : !list.length && !withAct && only.length === 1 ? `${only[0]} інвентаризації`
      : 'Інвентаризація';
    return {
      kind: 'inventory', file: more.progress ? `Хід інвентаризації на ${today()}`
        : `${name} на ${date}${list.length === 1 ? ' — ' + list[0] : ''}`,
      unit: unitCode(), legal_name: unitInfo().legalName, edrpou: unitInfo().edrpou, date, start: inv.start, end: inv.end || date,
      orderDate: inv.orderDate, orderNo: inv.orderNo, orderItem: inv.orderItem || '',
      service: ST_SERVICE, place: locationAt(date), blank: !!more.blank,
      accFixed: inv.accFixed || ACC_FIXED, accStock: inv.accStock || ACC_STOCK,
      head: signer(personBy(inv.head), date, true),
      members: (inv.members || []).map((id) => signer(personBy(id), date, true)).filter((x) => x.name),
      chief: signer(who.chief, date), buh: signer(who.buh, date),
      descriptions: stDescriptions(inv, list), act: withAct ? stAct(inv) : null,
      plan: more.plan ? stPlan(inv) : null, protocol: more.protocol ? stProtocol(inv) : null,
      register: more.register ? stRegister(inv) : null, progress: more.progress ? stProgressPaper(inv) : null,
    };
  }

  function stAct(inv) {
    const date = inv.date;
    const who = stSigners(inv);
    const one = (p) => { const at = personAt(p, date); return [at.pos && at.pos + ',', at.rank, pShort(p)].filter(Boolean).join(' '); };
    const members = (inv.members || []).map(personBy).filter(Boolean);
    const sum = stSummary(inv);
    const kind = inv.kind || 'щорічна';
    return {
      approve: Object.assign(signer(who.cmd, date), { date: inv.end || date }),
      title: `${ST_GEN[kind] || kind} інвентаризації військового майна продовольчої служби тилу логістики `
        + `${unitGen()}${(inv.scope || []).length ? ` (${inv.scope.join(', ')})` : ''}`,
      intro: `${kind[0].toUpperCase() + kind.slice(1)} інвентаризація військового майна продовольчої служби тилу `
        + `логістики ${unitGen()} проведена станом на ${quoteDate(date)} у період з `
        + `${dayMonth(inv.start || date)} по ${dateWords(inv.end || date)} внутрішньою перевірочною комісією у складі:`,
      head: one(personBy(inv.head)), members: members.map(one).join(', '),
      basis: inv.orderNo || inv.orderDate ? `Підстава: наказ командира ${unitGen()} від `
        + `${dateWords(inv.orderDate)} №${inv.orderNo || '___'}${inv.orderItem ? ` (пункт ${inv.orderItem})` : ''}.` : '',
      prev: inv.prevDate ? `Попередня інвентаризація проводилась станом на ${dateShort(inv.prevDate)}` : '',
      asof: `Акт складений станом на ${dateShort(date)}`,
      findings: String(inv.findings || ST_FINDINGS).split('\n').filter((x) => x.trim()),
      result: stResultText(inv, sum),
      attachments: String(inv.attach || stAttachText(inv, sum)).split('\n').filter((x) => x.trim()),
      ack: [signer(who.nachlog, date), signer(who.chief, date)].filter((x) => x.name),
    };
  }

  async function stExcel(inv, list, withAct, more = {}) {
    const spec = stSpec(inv, list, withAct, more);
    if (!spec.descriptions.length && !spec.act && !spec.plan && !spec.protocol && !spec.register && !spec.progress) {
      toast('На цю дату в обраних підрозділах майна немає.', true);
      return;
    }
    const missing = list.filter((sub) => !stMvo(inv, sub));
    await toExcel(spec);
    if (missing.length) {
      toast(`Описи без підпису МВО: ${missing.join(', ')}. Призначте МВО в «Люди й МВО».`);
    }
  }

  function renderStocktake() {
    const inv = state.stId ? invById(state.stId) : null;
    if (state.stId && !inv) state.stId = null;
    return inv ? renderStocktakeCard(inv) : renderStocktakeList();
  }

  function renderStocktakeList() {
    const list = allInv().slice().reverse();
    const kinds = [...new Set(list.map((x) => x.kind).filter(Boolean))];
    const headOf = (x) => { const p = personBy(x.head); return p ? pShort(p) : ''; };
    const order = (x) => (x.orderNo || x.orderDate ? `№${x.orderNo || '—'} від ${fmtDate(x.orderDate)}` : '');
    const stOf = (x) => (x.status === 'завершено' ? 'завершено' : 'у роботі');
    const files = (x) => filesOf('st|' + x.id).length;
    const reg = registry({
      id: 'st', rows: list, minWidth: '900px', placeholder: 'Пошук: вид, наказ, голова комісії',
      search: (x) => [x.kind, order(x), headOf(x), (x.scope || []).join(' ')],
      filters: [
        { type: 'seg', key: 'state', options: [['', 'усі'], ['work', 'у роботі'], ['done', 'завершено']],
          test: (x, v) => (v === 'done') === (x.status === 'завершено') },
        ...(kinds.length > 1 ? [{ type: 'select', key: 'kind', label: 'вид', all: 'усі', options: kinds.map((k) => [k, k]),
          test: (x, v) => x.kind === v }] : []),
      ],
      columns: [
        { key: 'date', label: 'станом на', cls: 'c-date', sort: (x) => x.date || '', cell: (x) => fmtDate(x.date) },
        { key: 'kind', label: 'вид', cls: 'c-txt', style: 'flex:0 0 170px', first: 1, sort: (x) => x.kind || '',
          cell: (x) => `<b>${esc(x.kind)}</b>${(x.scope || []).length
            ? `<small title="${esc(x.scope.join(', '))}">${esc(scopeShort(x.scope))}</small>` : ''}` },
        { key: 'order', label: 'наказ', cls: 'c-txt', style: 'flex:0 1 220px', sort: (x) => x.orderDate || '',
          cell: (x) => (order(x) ? esc(order(x)) : '<span class="c-num--dim">не внесено</span>') },
        { key: 'head', label: 'голова комісії', cls: 'c-txt', first: 1, sort: headOf, cell: (x) => esc(headOf(x) || '—') },
        { key: 'files', label: 'файлів', cls: 'c-num', sort: files, cell: (x) => String(files(x) || '—') },
        { key: 'status', label: 'стан', cls: 'c-tag', style: 'width:120px', first: 1, sort: stOf,
          cell: (x) => `<span class="tag ${x.status === 'завершено' ? 'tag--in' : 'tag--mv'}">${esc(stOf(x))}</span>` },
      ],
      row: (x) => ({ attrs: `data-act="st-open" data-id="${esc(x.id)}"` }),
      empty: 'Інвентаризацій ще немає.',
    });
    return {
      head: head('облік / контроль', 'Інвентаризація', '<button class="btn btn--primary" data-act="st-new">+ Нова інвентаризація</button>'),
      body: `${flashBlock()}${reg.panel}<div class="card card--scroll">${reg.table}</div>`,
    };
  }

  /** Що охоплює інвентаризація: уся частина або обрані підрозділи з підлеглими. */
  function stScopeField(inv, ro) {
    const sc = inv.scope || [];
    const label = sc.length ? sc.join(', ') : 'усю частину';
    if (ro) return `<div class="field field--span2"><label>Охоплює</label><div class="st-scope">${esc(label)}</div></div>`;
    const tops = subs.filter((x) => x.depth === 1 && (x.active || sc.includes(x.name))).map((x) => x.name);
    return `<div class="field field--span2"><label>Охоплює</label>
      <details class="st-scope"><summary>${esc(label)}</summary>
        <div class="st-scope__list">${tops.map((n) => `<label><input type="checkbox" data-stscope="${esc(n)}"${
          sc.includes(n) ? ' checked' : ''}> ${esc(n)}</label>`).join('')}</div>
        <div class="field__hint">разом із підлеглими підрозділами</div>
      </details></div>`;
  }

  function renderStocktakeCard(inv) {
    peopleInit();
    const ro = stReadonly(inv);
    const dis = ro ? ' disabled' : '';
    const sum = stSummary(inv);
    const who = stSigners(inv);
    const date = inv.date;
    if (state.stSub) return stPreview(inv, state.stSub, sum);
    const field = (k, label, type = 'text', v = inv[k]) => `<div class="field"><label>${label}</label>
      <input data-stf="${k}" type="${type}" value="${esc(v || '')}"${dis}></div>`;
    const pSel = (attr, sel, hint) => `<select ${attr}${dis}>${personOptions(sel, date, hint)}</select>`;
    const members = (inv.members || []).map((id, i) => `<div class="st-member">${pSel(`data-stm="${i}"`, id, '— оберіть —')}
      ${ro ? '' : rowBtn('st-mdel', '✕ Прибрати', `data-i="${i}"`, { bad: true, title: 'Прибрати з комісії' })}</div>`).join('');
    const sgn = (k, role, label) => {
      const own = (inv.sign || {})[k];
      const dflt = officialAt(role, date);
      return `<div class="field"><label>${label}</label>${pSel(`data-sts="${k}"`, own || '', dflt ? `за довідником: ${pSign(dflt)}` : '— не призначено —')}</div>`;
    };
    // Підписанти інвентаризації: ключ у картці, посада в довіднику, роль у паперах.
    const SIGNERS = [['chief', 'начальник служби', 'Дані в описах перевірив'], ['buh', 'бухгалтер', 'Облікові дані вніс (бухгалтер)'],
      ['cmd', 'командир', 'Затверджує акт'], ['nachlog', 'начальник логістики', 'З актом ознайомлений'],
      ['chair', '', 'План погоджує (голова комісії частини)'], ['fes', 'начальник ФЕС', 'Папери приймає (начальник ФЕС)']];
    // Комісія й посадовці згорнуті, щойно заповнені: до них повертаються рідко,
    // а план і описи — щодня (консиліум 01.10.2026: картка перевантажена).
    const teamOk = !!inv.head && (inv.members || []).length > 0
      && SIGNERS.every(([k, role]) => (inv.sign || {})[k] || (role && officialAt(role, date)));
    const teamHint = teamOk
      ? `голова ${pSign(personBy(inv.head)) || '—'} · ${cnt((inv.members || []).length, 'член', 'члени', 'членів')} · посадовців ${SIGNERS.length}`
      : 'ще не заповнено: голова, члени комісії, посадовці для підписів';
    const subRows = stSubs(inv).map((sub) => {
      const x = sum.perSub.get(sub) || { lines: [], diffs: [] };
      const fx = x.lines.filter((l) => l.fixed), st = x.lines.filter((l) => !l.fixed);
      const tf = stTotals(fx), ts = stTotals(st);
      const own = (inv.mvo || {})[sub];
      const m = stMvo(inv, sub);
      return `<div class="tbl__row tbl__row--plain${x.diffs.length ? ' is-diff' : ''}${m ? '' : ' is-due'}">
        <div class="c-name"><b class="lnk" data-act="st-sub" data-sub="${esc(sub)}" title="Відкрити описи">${esc(sub)}</b>
          <small>${esc(subBy.get(sub)?.type || '')}</small></div>
        <div class="c-txt" style="flex:1.1 1 0">${ro ? esc(m ? pSign(m) : 'МВО не призначено')
          : `<select data-stmvo="${esc(sub)}">${personOptions(own || '', date, m && !own ? `за довідником: ${pSign(m)}` : '— МВО не призначено —')}</select>`}</div>
        <div class="c-num">${fx.length ? `${fx.length} / ${fmtNum(tf.accQty, '0')}` : '—'}</div>
        <div class="c-num c-num--wide">${fx.length ? fmtMoney(tf.accSum) : '—'}</div>
        <div class="c-num">${st.length ? `${st.length} / ${fmtNum(ts.accQty, '0')}` : '—'}</div>
        <div class="c-num c-num--wide">${st.length ? fmtMoney(ts.accSum) : '—'}</div>
        <div class="c-num ${x.diffs.length ? 'num-bad' : x.gone.length ? 'num-warn' : 'c-num--dim'}"
          title="Розбіжності комісії${x.gone.length ? `. Знищене, не списане: ${x.gone.length} рядк.` : ''}">${x.diffs.length
          || (x.gone.length ? `зн. ${x.gone.length}` : '—')}</div>
        <div class="c-acts" style="flex-basis:170px">
          <button type="button" class="btn btn--sm" data-act="st-sub" data-sub="${esc(sub)}">Описи</button>
          <button type="button" class="ico-btn" data-act="st-xls-sub" data-sub="${esc(sub)}" title="Описи підрозділу в Excel">⤓</button></div>
      </div>`;
    }).join('');
    // План: дату, відповідального члена підкомісії й відмітку «проведено» на кожний підрозділ
    // вписують тут.
    const team = [inv.head].concat(inv.members || []).map(personBy).filter(Boolean);
    const late = new Set(stLate(inv));
    const dueRows = ST_DUE.map(([k, label]) => {
      const st = stDueState(inv, k);
      const cell = (attr, v) => (ro ? esc(v ? fmtDate(v) : '—')
        : `<input type="date" class="rc-in rc-in--wide" ${attr}="${k}" value="${esc(v)}" aria-label="${esc(label)}">`);
      return `<div class="tbl__row tbl__row--plain${st.kind === 'late' ? ' is-due' : ''}">
        <div class="c-name"><b>${esc(label)}</b></div>
        <div class="c-txt" style="flex:0 0 170px">${cell('data-std', st.due)}</div>
        <div class="c-txt" style="flex:0 0 170px">${cell('data-stx', st.sent)}</div>
        <div class="c-txt ${st.kind === 'late' ? 'num-bad' : st.kind === 'soon' ? 'num-warn' : ''}">${esc(st.text || '—')}</div>
      </div>`;
    }).join('');
    const planRows = stSubs(inv).map((sub) => {
      const x = sum.perSub.get(sub) || { lines: [] };
      const p = (inv.plan || {})[sub] || {};
      const kinds = [x.lines.some((l) => l.fixed) ? 'необоротні активи' : '', x.lines.some((l) => !l.fixed) ? 'запаси' : '']
        .filter(Boolean).join(', ');
      return `<div class="tbl__row tbl__row--plain${late.has(sub) ? ' is-due' : ''}">
        <div class="c-name"><b>${esc(sub)}</b><small>${esc(stMvo(inv, sub) ? pSign(stMvo(inv, sub)) : 'МВО не призначено')}</small></div>
        <div class="c-txt">${esc(kinds)}</div>
        <div class="c-txt" style="flex:0 0 170px">${ro ? esc(fmtDate(p.date) || '—')
          : `<input type="date" class="rc-in rc-in--wide" data-stpd="${esc(sub)}" value="${esc(p.date || '')}"
              min="${esc(inv.start || '')}" max="${esc(inv.end || '')}" aria-label="дата проведення, ${esc(sub)}">`}</div>
        <div class="c-txt" style="flex:1.2 1 0">${ro ? esc(stMember(personBy(p.who), date) || '—')
          : `<select data-stpw="${esc(sub)}" aria-label="відповідальний, ${esc(sub)}"><option value="">— не призначено —</option>${
            team.map((m) => `<option value="${esc(m.id)}"${m.id === p.who ? ' selected' : ''}>${esc(stMember(m, date))}</option>`).join('')}</select>`}</div>
        <div class="c-txt" style="flex:0 0 170px">${ro ? esc(p.done ? fmtDate(p.done) : '—')
          : `<input type="date" class="rc-in rc-in--wide" data-stpx="${esc(sub)}" value="${esc(p.done || '')}"
              min="${esc(inv.start || '')}" aria-label="проведено, ${esc(sub)}">`}</div>
      </div>`;
    }).join('');
    // Інші місця плану — вписані руками: назва, МВО й вид майна текстом, решта як у підрозділів.
    const placeRows = (inv.places || []).map((p) => {
      const pid = esc(p.id);
      const name = String(p.place || '').trim();
      const txt = (k, ph, label) => (ro ? esc(p[k] || '') : `<input class="rc-in rc-in--wide" data-stpl="${pid}" data-k="${k}"
            value="${esc(p[k] || '')}" placeholder="${ph}" aria-label="${label}, інше місце">`);
      return `<div class="tbl__row tbl__row--plain${name && late.has(name) ? ' is-due' : ''}">
        <div class="c-name st-place">${ro ? `<b>${esc(name)}</b><small>${esc(p.mvo || 'МВО не вказано')}</small>`
          : `${txt('place', 'місце зберігання', 'місце')}${txt('mvo', 'МВО: звання, ім’я ПРІЗВИЩЕ', 'МВО')}`}</div>
        <div class="c-txt">${txt('kinds', 'вид майна (описи)', 'вид майна')}</div>
        <div class="c-txt" style="flex:0 0 170px">${ro ? esc(fmtDate(p.date) || '—')
          : `<input type="date" class="rc-in rc-in--wide" data-stpl="${pid}" data-k="date" value="${esc(p.date || '')}"
              min="${esc(inv.start || '')}" max="${esc(inv.end || '')}" aria-label="дата проведення, ${esc(name || 'інше місце')}">`}</div>
        <div class="c-txt" style="flex:1.2 1 0">${ro ? esc(stMember(personBy(p.who), date) || '—')
          : `<select data-stpl="${pid}" data-k="who" aria-label="відповідальний, ${esc(name || 'інше місце')}"><option value="">— не призначено —</option>${
            team.map((m) => `<option value="${esc(m.id)}"${m.id === p.who ? ' selected' : ''}>${esc(stMember(m, date))}</option>`).join('')}</select>`}</div>
        <div class="c-txt st-place__last" style="flex:0 0 170px">${ro ? esc(p.done ? fmtDate(p.done) : '—')
          : `<input type="date" class="rc-in rc-in--wide" data-stpl="${pid}" data-k="done" value="${esc(p.done || '')}"
              min="${esc(inv.start || '')}" aria-label="проведено, ${esc(name || 'інше місце')}">
            ${rowBtn('st-pdel', '✕ Прибрати', `data-id="${pid}"`, { bad: true, title: 'Прибрати місце з плану' })}`}</div>
      </div>`;
    }).join('');
    return {
      head: head(`інвентаризація / ${fmtDate(date)}`, `${inv.kind[0].toUpperCase() + inv.kind.slice(1)} інвентаризація станом на ${fmtDate(date)}`, `
        <button class="btn" data-act="st-back">← До інвентаризацій</button>
        <button class="btn" data-act="st-xls-all" title="План, акт, протокол, реєстр і описи">В Excel: усі папери</button>${
        inv.base ? `<button class="btn btn--primary" data-act="st-new" data-id="${esc(inv.id)}">+ Нова на основі цієї</button>`
          : inv.status === 'завершено' ? '<button class="btn" data-act="st-reopen">Відкрити для правки</button>'
            : `<button class="btn btn--primary" data-act="st-finish">Завершити ✓</button>
               <button class="btn btn--danger" data-act="st-del" title="Інвентаризацію з планом і описами буде видалено">Видалити інвентаризацію</button>`}`),
      body: `${flashBlock()}
        ${inv.base ? `<div class="flash flash--info">Інвентаризація з бази обліку (${esc(inv.source || 'описи ' + fmtDate(date))}), лише
          для читання. Описи нижче складено з обліку програми на ${fmtDate(date)}.
          Паперові описи є серед файлів.${inv.remark ? `<br>${esc(inv.remark)}` : ''}</div>` : ''}
        ${inv.status === 'завершено' && !inv.base ? '<div class="flash flash--info">Інвентаризацію завершено. Щоб змінити дані, натисніть «Відкрити для правки».</div>' : ''}
        <div class="tiles">
          <div class="tile"><div class="tile__label">Описів</div><div class="tile__value">${sum.descs}</div>
            <div class="tile__hint">${cnt(stSubs(inv).length, 'підрозділ', 'підрозділи', 'підрозділів')} з майном</div></div>
          <div class="tile"><div class="tile__label">Рядків</div><div class="tile__value">${sum.lines}</div>
            <div class="tile__hint">${fmtMoney(sum.accSum)} грн за обліком</div></div>
          <div class="tile"><div class="tile__label">Розбіжності комісії</div>
            <div class="tile__value ${sum.diffs ? 'num-bad' : ''}">${sum.diffs || '—'}</div>
            <div class="tile__hint">${sum.diffs ? `нестача ${fmtMoney(sum.short)} грн, лишки ${fmtMoney(sum.over)} грн`
              : 'фактична наявність збігається з обліком'}</div></div>
          <div class="tile"><div class="tile__label">Знищене, не списане</div>
            <div class="tile__value ${sum.gone ? 'num-warn' : ''}">${sum.gone || '—'}</div>
            <div class="tile__hint">${sum.gone ? `${fmtMoney(sum.goneSum)} грн` : 'немає'}</div></div>
        </div>
        <div class="card form" style="margin-bottom:12px">
          <div class="card__head"><div class="card__title">Реквізити</div></div>
          <div class="form__grid">
            <div class="field"><label>Вид</label><select data-stf="kind"${dis}>${ST_KINDS.map((k) =>
              `<option${k === inv.kind ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
            ${field('date', 'Станом на', 'date')}${field('start', 'Розпочата', 'date')}${field('end', 'Закінчена', 'date')}
            ${field('orderNo', 'Наказ №')}${field('orderDate', 'Наказ від', 'date')}${field('orderItem', 'Пункт наказу')}
            ${field('prevDate', 'Попередня інвентаризація', 'date')}
            ${stScopeField(inv, ro)}
            <div class="field field--span2"><label>Субрахунки необоротних активів</label>
              <input data-stf="accFixed" value="${esc(inv.accFixed || ACC_FIXED)}"${dis}></div>
            <div class="field field--span2"><label>Субрахунки запасів</label>
              <input data-stf="accStock" value="${esc(inv.accStock || ACC_STOCK)}"${dis}></div>
          </div>
        </div>
        ${fold('Комісія й посадовці', teamHint, !teamOk, `<div class="grid-2" style="padding:0 6px 6px">
          <div class="form"><div class="card__head" style="border-bottom:0;padding-bottom:4px"><div class="card__title">Комісія</div></div>
            <div class="pad"><div class="field"><label>Голова комісії</label>${pSel('data-sth="1"', inv.head, '— оберіть —')}</div>
              <div class="field" style="margin-top:10px"><label>Члени комісії</label>${members || '<div class="panel__note">Членів ще не додано.</div>'}</div>
              ${ro ? '' : '<button class="btn btn--sm" data-act="st-madd" style="margin-top:8px">+ Член комісії</button>'}</div></div>
          <div class="form"><div class="card__head" style="border-bottom:0;padding-bottom:4px"><div class="card__title">Посадовці</div></div>
            <div class="form__grid" style="grid-template-columns:1fr;border-bottom:0;padding-top:0">
              ${SIGNERS.map(([k, role, label]) => sgn(k, role, label)).join('')}
            </div></div>
        </div>`)}
        ${filesCard('st|' + inv.id, 'Скани й документи інвентаризації', 'наказ, підписані описи, акт')}
        <div class="card" style="margin-bottom:12px">
          <div class="card__head"><div class="card__title">Строки за наказом</div></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:760px">
            <div class="tbl__head"><div class="tbl__h c-name">що</div>
              <div class="tbl__h c-txt" style="flex:0 0 170px">строк</div>
              <div class="tbl__h c-txt" style="flex:0 0 170px">виконано</div><div class="tbl__h c-txt">стан</div></div>
            ${dueRows}
          </div></div></div>
        <div class="card" style="margin-bottom:12px">
          <div class="card__head"><div class="card__title">План проведення</div>
            <div class="panel__spacer"></div><span class="panel__count" id="st-plan-count">${stPlanCount(inv)}</span>
            ${ro ? '' : '<button class="btn btn--sm" data-act="st-padd" title="Майно служби, якого програма не обліковує: продукти, вода на складах">+ Місце поза обліком</button>'}
            <button class="btn btn--sm" data-act="st-xls-plan">План в Excel</button>
            <button class="btn btn--sm" data-act="st-xls-progress">Хід в Excel</button></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:1000px">
            <div class="tbl__head"><div class="tbl__h c-name">підрозділ</div><div class="tbl__h c-txt">описи</div>
              <div class="tbl__h c-txt" style="flex:0 0 170px">дата проведення</div>
              <div class="tbl__h c-txt" style="flex:1.2 1 0" title="Відповідальний член підкомісії">відповідальний</div>
              <div class="tbl__h c-txt" style="flex:0 0 170px">проведено</div></div>
            ${planRows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">На цю дату майно не числиться за жодним підрозділом.</div></div>'}${placeRows}
          </div></div></div>
        <div class="card" style="margin-bottom:12px">
          <div class="card__head"><div class="card__title">Описи по матеріально відповідальних особах</div>
            <div class="panel__spacer"></div>
            <button class="btn btn--sm" data-act="st-xls-work" title="Облік надруковано, фактичну наявність вписує комісія">Робочі описи в Excel</button></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:1080px">
            <div class="tbl__head"><div class="tbl__h c-name">підрозділ</div><div class="tbl__h c-txt" style="flex:1.1 1 0">МВО</div>
              <div class="tbl__h c-num">необор.: ряд./од.</div><div class="tbl__h c-num c-num--wide">сума, грн</div>
              <div class="tbl__h c-num">запаси: ряд./од.</div><div class="tbl__h c-num c-num--wide">сума, грн</div>
              <div class="tbl__h c-num">розбіжн.</div><div class="tbl__h c-acts" style="flex-basis:170px"></div></div>
            ${subRows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">На цю дату майно не числиться за жодним підрозділом.</div></div>'}
          </div></div></div>
        <div class="card form">
          <div class="card__head"><div class="card__title">Акт інвентаризації</div>
            <div class="panel__spacer"></div><button class="btn btn--sm" data-act="st-xls-act">Акт в Excel</button>
            <button class="btn btn--sm" data-act="st-xls-prot">Протокол в Excel</button>
            <button class="btn btn--sm" data-act="st-xls-reg">Реєстр в Excel</button></div>
          <div class="form__grid">
            <div class="field field--span2"><label>За результатами встановлено</label>
              <textarea data-stf="findings" rows="5"${dis}>${esc(inv.findings || ST_FINDINGS)}</textarea></div>
            ${inv.base && inv.result ? `<div class="field field--span2"><label>Результат за паперовим актом</label>
              <textarea rows="${Math.min(10, 2 + String(inv.result).split('\n').length)}" disabled>${esc(inv.result)}</textarea></div>` : ''}
            <div class="field field--span2"><label>${inv.base ? 'Результат за описами з обліку програми' : 'Результат (формується з описів)'}</label>
              <textarea rows="${Math.min(10, 2 + sum.diffs)}" disabled>${esc(stResultText(inv, sum))}</textarea></div>
            <div class="field field--span2"><label>До акту додається</label>
              <textarea data-stf="attach" rows="3"${dis}>${esc(inv.attach || stAttachText(inv, sum))}</textarea></div>
          </div>
          ${(sum.diffs || sum.gone) && /відповідає даним/.test(inv.findings || ST_FINDINGS) ? `<div class="flash flash--warn" style="margin:0 16px 16px">
            ${sum.diffs ? 'Є розбіжності' : 'Є знищене, не списане майно'}, а в «встановлено» написано, що фактична наявність
            відповідає даним обліку. Виправте цей пункт.</div>` : ''}
        </div>`,
    };
  }

  /** Описи одного підрозділу: облік, фактично (комісія виправляє), інші відомості. */
  function stPreview(inv, sub, sum) {
    const ro = stReadonly(inv);
    const lines = stLines(inv, sub);
    const m = stMvo(inv, sub);
    const date = inv.date;
    const table = (fixed) => {
      const rows = lines.filter((l) => l.fixed === fixed);
      if (!rows.length) return '';
      const t = stTotals(rows);
      const body = rows.map((l, i) => `<div class="tbl__row tbl__row--plain${stDiff(l) ? ' is-diff' : stGone(l) ? ' is-gone' : ''}">
          <div class="c-num c-num--dim" style="width:40px">${i + 1}</div>
          <div class="c-name"><b class="lnk" data-code="${esc(l.code)}" title="Відкрити картку позиції">${esc(l.name)}</b>
            <small>${esc(l.code)}${l.fes ? ' · ФЕС ' + esc(l.fes) : ''}${l.serial ? ' · зав. № ' + esc(l.serial) : ''}${
              l.chassis ? ' · шасі № ' + esc(l.chassis) : ''}${l.year ? ' · ' + esc(l.year) + ' р.' : ''}</small></div>
          <div class="c-unit">${esc(l.uom)}</div>
          <div class="c-num c-num--wide">${l.price ? fmtMoney(l.price) : '—'}</div>
          <div class="c-num">${fmtNum(l.acc, '0')}</div>
          <div class="c-num c-num--input">${ro ? fmtNum(l.fact, '0')
            : `<input class="rc-in" data-stq="${esc(l.key)}" value="${esc(String(+l.fact.toFixed(3)))}" inputmode="decimal"
                title="Фактична кількість${l.def !== l.acc ? ' без знищеного' : ''}">`}</div>
          <div class="c-num c-num--xwide">${fmtMoney(l.fact * l.price)}</div>
          <div class="c-txt rc-note">${ro ? esc(l.note) : `<input class="rc-in rc-in--wide" data-stn="${esc(l.key)}" value="${esc(l.note)}"
              placeholder="інші відомості">`}</div>
        </div>`).join('');
      return `<div class="card" style="margin-bottom:12px">
        <div class="card__head"><div class="card__title">${fixed ? 'Опис необоротних активів' : 'Опис запасів'}</div>
          <div class="panel__spacer"></div><span class="panel__count">${cnt(rows.length, 'рядок', 'рядки', 'рядків')}
            · за обліком ${fmtNum(t.accQty, '0')} од. на ${fmtMoney(t.accSum)} грн
            · фактично ${fmtNum(t.factQty, '0')} од. на ${fmtMoney(t.factSum)} грн</span></div>
        <div class="card--scroll"><div class="tbl" style="--tbl-min:1000px">
          <div class="tbl__head"><div class="tbl__h c-num" style="width:40px">№</div><div class="tbl__h c-name">найменування</div>
            <div class="tbl__h c-unit">од.</div><div class="tbl__h c-num c-num--wide">ціна, грн</div>
            <div class="tbl__h c-num">за обліком</div><div class="tbl__h c-num c-num--input">фактично</div>
            <div class="tbl__h c-num c-num--xwide">сума фактично</div><div class="tbl__h c-txt">інші відомості</div></div>
          ${body}
          <div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-num" style="width:40px"></div>
            <div class="c-name"><b>Разом</b></div><div class="c-unit"></div><div class="c-num c-num--wide"></div>
            <div class="c-num">${fmtNum(t.accQty, '0')}</div><div class="c-num c-num--input">${fmtNum(t.factQty, '0')}</div>
            <div class="c-num c-num--xwide">${fmtMoney(t.factSum)}</div><div class="c-txt"></div></div>
        </div></div></div>`;
    };
    const subsList = stSubs(inv);
    const at = subsList.indexOf(sub);
    return {
      head: head(`інвентаризація / ${fmtDate(date)} / описи`, sub, `
        <button class="btn" data-act="st-sub" data-sub="">← До інвентаризації</button>
        <div class="seg"><button type="button" data-act="st-sub" data-sub="${esc(subsList[at - 1] || '')}"${at > 0 ? '' : ' disabled'}
            title="Попередній підрозділ">◀</button>
          <button type="button" data-act="st-sub" data-sub="${esc(subsList[at + 1] || '')}"${at >= 0 && at < subsList.length - 1 ? '' : ' disabled'}
            title="Наступний підрозділ">▶</button></div>
        <button class="btn btn--primary" data-act="st-xls-sub" data-sub="${esc(sub)}">Описи в Excel</button>`),
      body: `${flashBlock()}
        <div class="card form" style="margin-bottom:12px"><div class="form__grid">
          <div class="field"><label>Матеріально відповідальна особа</label>${ro ? `<input value="${esc(m ? pSign(m) : '—')}" disabled>`
            : `<select data-stmvo="${esc(sub)}">${personOptions((inv.mvo || {})[sub] || '', date,
              mvoAt(sub, date) && !(inv.mvo || {})[sub] ? `за довідником: ${pSign(mvoAt(sub, date))}` : '— МВО не призначено —')}</select>`}</div>
          <div class="field"><label>Посада й звання на ${fmtDate(date)}</label>
            <input value="${esc(m ? [personAt(m, date).pos, personAt(m, date).rank].filter(Boolean).join(', ') : '')}" disabled></div>
          <div class="field field--span2"><label>Місце зберігання</label>
            <input data-stw="${esc(sub)}" value="${esc(stWhere(inv, sub))}"${ro ? ' disabled' : ''}></div>
          <div class="field field--span2"><label>Командир (начальник) підрозділу</label>${ro
            ? `<input value="${esc(stCmdr(inv, sub) ? pSign(stCmdr(inv, sub)) : '—')}" disabled>`
            : `<select data-stcmdr="${esc(sub)}">${personOptions((inv.cmdr || {})[sub] || '', date,
              cmdrFor(sub, date) && !(inv.cmdr || {})[sub] ? `за довідником: ${pSign(cmdrFor(sub, date))}` : '— не вказано —')}</select>`}</div>
        </div></div>
        ${ro ? '' : `<div class="panel"><div class="panel__note">Графу «фактично» заповнено за обліком без знищеного, не списаного.</div></div>`}
        ${table(true)}${table(false)}
        ${lines.length ? '' : emptyBlock('∅', 'Майна немає', `На ${fmtDate(date)} за «${sub}» нічого не числиться.`)}`,
    };
  }

  function stUpdate(fn) {
    const inv = invById(state.stId);
    if (!inv || stReadonly(inv)) return null;
    fn(inv);
    inv.updated = today();
    save();
    return inv;
  }

  /** «проведено N з M» над планом: підрозділи з майном і названі інші місця. */
  function stPlanCount(inv) {
    const done = stSubs(inv).filter((sub) => ((inv.plan || {})[sub] || {}).done).length
      + stPlaces(inv).filter((p) => p.done).length;
    return `проведено ${done} з ${stSubs(inv).length + stPlaces(inv).length}`;
  }

  function bindStocktake() {
    if (state.view !== 'stocktake' || !state.stId) return;
    const sc = $('#scroll');
    sc.querySelectorAll('[data-stf]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => {
        const was = inv.date;
        inv[el.dataset.stf] = el.value;
        // «Розпочата» не пізніше, «закінчена» не раніше за «станом на»: типові
        // 01.11–25.12 при інвентаризації станом на 23.09 давали «закінчена 25.12».
        // Закінчена, яку не правили окремо (дорівнює попередній даті), іде за датою.
        if (el.dataset.stf === 'date' && inv.date) {
          if (!inv.end || inv.end === was || inv.end < inv.date) inv.end = inv.date;
          if (inv.start && inv.start > inv.date) inv.start = inv.date;
        }
      });
      if (el.tagName !== 'TEXTAREA') render();
    }));
    sc.querySelectorAll('[data-sth]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => { inv.head = el.value; }); render();
    }));
    sc.querySelectorAll('[data-stscope]').forEach((el) => el.addEventListener('change', () => {
      const open = el.closest('details');
      stUpdate((inv) => {
        const sub = el.dataset.stscope;
        inv.scope = (inv.scope || []).filter((x) => x !== sub).concat(el.checked ? [sub] : []);
      });
      render();
      if (open) $('#scroll details.st-scope')?.setAttribute('open', '');
    }));
    sc.querySelectorAll('[data-stm]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => { inv.members[+el.dataset.stm] = el.value; }); render();
    }));
    sc.querySelectorAll('[data-sts]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => { inv.sign = inv.sign || {}; if (el.value) inv.sign[el.dataset.sts] = el.value; else delete inv.sign[el.dataset.sts]; });
      render();
    }));
    sc.querySelectorAll('[data-stmvo]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => { inv.mvo = inv.mvo || {}; if (el.value) inv.mvo[el.dataset.stmvo] = el.value; else delete inv.mvo[el.dataset.stmvo]; });
      render();
    }));
    sc.querySelectorAll('[data-stw]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => { inv.where = inv.where || {}; inv.where[el.dataset.stw] = el.value.trim(); });
    }));
    // План: дата й відповідальний на підрозділ; порожній запис не зберігається.
    const planSet = (sub, k, v) => stUpdate((inv) => {
      const plan = Object.assign({}, inv.plan || {});
      const p = Object.assign({}, plan[sub] || {});
      if (v) p[k] = v; else delete p[k];
      if (Object.keys(p).length) plan[sub] = p; else delete plan[sub];
      inv.plan = plan;
    });
    sc.querySelectorAll('[data-stpd]').forEach((el) => el.addEventListener('change', () => { planSet(el.dataset.stpd, 'date', el.value); render(); }));
    sc.querySelectorAll('[data-stpw]').forEach((el) => el.addEventListener('change', () => planSet(el.dataset.stpw, 'who', el.value)));
    sc.querySelectorAll('[data-stpx]').forEach((el) => el.addEventListener('change', () => {
      if (el.value > today()) { toast('Відмітку «проведено» ставлять не раніше дня проведення.', true); el.value = ''; }
      planSet(el.dataset.stpx, 'done', el.value);
      render();
    }));
    // Строки наказу: строк і день, коли подано; порожній запис не зберігається.
    const dueSet = (part, k, v) => stUpdate((inv) => {
      const d = Object.assign({}, inv[part] || {});
      if (v) d[k] = v; else delete d[k];
      inv[part] = d;
    });
    sc.querySelectorAll('[data-std]').forEach((el) => el.addEventListener('change', () => { dueSet('due', el.dataset.std, el.value); render(); }));
    sc.querySelectorAll('[data-stx]').forEach((el) => el.addEventListener('change', () => { dueSet('sent', el.dataset.stx, el.value); render(); }));
    sc.querySelectorAll('[data-stcmdr]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => {
        const cmdr = Object.assign({}, inv.cmdr || {});
        if (el.value) cmdr[el.dataset.stcmdr] = el.value; else delete cmdr[el.dataset.stcmdr];
        inv.cmdr = cmdr;
      });
    }));
    sc.querySelectorAll('[data-stn]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => { inv.note = inv.note || {}; inv.note[el.dataset.stn] = el.value.trim(); });
    }));
    // Інші місця плану: кожне поле — своє; назва й МВО лишаються, як надруковано.
    sc.querySelectorAll('[data-stpl]').forEach((el) => el.addEventListener('change', () => {
      const k = el.dataset.k;
      if (k === 'done' && el.value > today()) { toast('Відмітку «проведено» ставлять не раніше дня проведення.', true); el.value = ''; }
      const inv = stUpdate((x) => {
        const p = (x.places || []).find((y) => y.id === el.dataset.stpl);
        if (p) p[k] = el.tagName === 'INPUT' && el.type !== 'date' ? el.value.trim() : el.value;
      });
      if (k === 'date' || k === 'done') render();
      // Назва місця вводиться підряд із МВО й видом майна: перемальовувати не можна
      // (пішов би фокус), а лічильник над планом змінюється — підставляється на місці.
      else if (inv) { const c = $('#st-plan-count'); if (c) c.textContent = stPlanCount(inv); }
    }));
    const cells = [...sc.querySelectorAll('[data-stq]')];
    cells.forEach((el, i) => {
      el.addEventListener('change', () => {
        const key = el.dataset.stq;
        const raw = String(el.value).replace(',', '.').trim();
        const v = raw === '' ? null : +raw;
        if (v != null && (!Number.isFinite(v) || v < 0)) { toast('Кількість має бути невід’ємним числом.', true); el.value = ''; return; }
        const next = cells[i + 1] && cells[i + 1].dataset.stq;
        const focusNext = el.dataset.enter === '1';
        stUpdate((inv) => {
          inv.fact = inv.fact || {};
          const line = stLines(inv, state.stSub).find((l) => l.key === key);
          if (v == null || (line && Math.abs(v - line.def) < 1e-9)) delete inv.fact[key]; else inv.fact[key] = v;
        });
        render();
        if (focusNext && next) { const n = $(`[data-stq="${CSS.escape(next)}"]`); if (n) { n.focus(); n.select(); } }
      });
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        el.dataset.enter = '1';
        el.blur();
        if (!el.isConnected) return;
        const n = cells[i + 1];
        if (n) { n.focus(); n.select(); }
      });
    });
  }

  function stocktakeAction(what, d) {
    const inv = invById(state.stId);
    switch (what) {
      case 'st-new': return stNew(d.id ? invById(d.id) : null);
      case 'st-open': return go('stocktake', { stId: d.id, stSub: '' });
      case 'st-back': return goBack('stocktake', { stId: null, stSub: '' });
      case 'st-sub': return go('stocktake', { stSub: d.sub || '' });
      case 'st-madd': stUpdate((x) => { x.members = (x.members || []).concat(['']); }); return render();
      case 'st-mdel': stUpdate((x) => { x.members.splice(+d.i, 1); }); return render();
      case 'st-padd': {
        // Нове місце бере вид майна й відповідального з попереднього: місця одного роду йдуть низкою.
        let id = '';
        stUpdate((x) => {
          const last = (x.places || []).slice(-1)[0] || {};
          id = uid();
          (x.places = x.places || []).push({ id, place: '', mvo: '', kinds: last.kinds || '', date: '', who: last.who || '', done: '' });
        });
        render();
        if (id) $(`[data-stpl="${CSS.escape(id)}"][data-k="place"]`)?.focus();
        return null;
      }
      case 'st-pdel': stUpdate((x) => { x.places = (x.places || []).filter((p) => p.id !== d.id); }); return render();
      case 'st-xls-sub': return inv && stExcel(inv, [d.sub], false);
      case 'st-xls-all': return inv && stExcel(inv, stSubs(inv), true, { plan: true, protocol: true, register: true });
      case 'st-xls-act': return inv && stExcel(inv, [], true);
      case 'st-xls-plan': return inv && stExcel(inv, [], false, { plan: true });
      case 'st-xls-prot': return inv && stExcel(inv, [], false, { protocol: true });
      case 'st-xls-reg': return inv && stExcel(inv, [], false, { register: true });
      case 'st-xls-work': return inv && stExcel(inv, stSubs(inv), false, { blank: true });
      case 'st-xls-progress': return inv && stExcel(inv, [], false, { progress: true });
      case 'st-finish': {
        if (!inv) return;
        // Інвентаризацію, заведену наперед (грудневу — у вересні), завершити
        // раніше її дати не можна: завершена закриває період до своєї дати, і
        // кожен новий документ до кінця року перепитував би про закритий період.
        if (inv.date > today()) {
          alert(`Інвентаризацію станом на ${fmtDate(inv.date)} можна завершити не раніше цієї дати.`);
          return;
        }
        const miss = [];
        if (!inv.orderNo || !inv.orderDate) miss.push('номер і дата наказу');
        if (inv.start && inv.end && inv.start > inv.end) miss.push('дати: «розпочата» пізніше за «закінчена»');
        if (!personBy(inv.head)) miss.push('голова комісії');
        if (!(inv.members || []).filter(personBy).length) miss.push('члени комісії');
        const noMvo = stSubs(inv).filter((sub) => !stMvo(inv, sub));
        if (noMvo.length) miss.push('МВО: ' + noMvo.join(', '));
        const noCmdr = stSubs(inv).filter((sub) => !stCmdr(inv, sub));
        if (noCmdr.length) miss.push('командири підрозділів: ' + noCmdr.join(', '));
        if (miss.length && !confirm(`Не заповнено: ${miss.join('; ')}. Усе одно завершити?`)) return;
        // Підписані описи — документ: завершена інвентаризація тримає їх такими,
        // якими їх підписали, навіть коли потім заднім числом внесуть документ.
        const frozen = { subs: stSubs(inv), lines: {} };
        for (const sub of frozen.subs) frozen.lines[sub] = stSource(sub, inv.date, !inv.base);
        // Дата першого завершення лишається: повторне після правки — це виправлення.
        stUpdate((x) => { x.status = 'завершено'; x.finished = x.finished || today(); x.frozen = frozen; });
        logChange('інвентаризацію завершено', 'st|' + inv.id, `${inv.kind} станом на ${fmtDate(inv.date)}`);
        save(true, true);
        state.flash = 'Інвентаризацію завершено. Підшийте скани підписаних описів і акта.';
        return render();
      }
      case 'st-reopen':
        if (!inv || inv.base) return;
        // Завершена інвентаризація закриває період; відкрита — знову рахує описи з
        // обліку, і те, що внесли заднім числом після завершення, потрапить у них.
        if (!confirm(`Відкрити для правки інвентаризацію станом на ${fmtDate(inv.date)}?\n\n`
          + 'Описи знову складатимуться з поточного обліку, а документи до цієї дати '
          + 'проводитимуться без попередження про закритий період.')) return;
        inv.status = 'чернетка';
        delete inv.frozen;
        logChange('інвентаризацію відкрито', 'st|' + inv.id, `${inv.kind} станом на ${fmtDate(inv.date)}`);
        save(true, true);
        return render();
      case 'st-del':
        if (!inv || inv.base || inv.status === 'завершено') return;
        if (!confirm(`Видалити інвентаризацію станом на ${fmtDate(inv.date)}?\n\nВнесену фактичну наявність буде видалено, `
          + 'скани залишаться в теці.')) return;
        store.inventories = store.inventories.filter((x) => x.id !== inv.id);
        logChange('інвентаризацію видалено', 'st|' + inv.id, `${inv.kind} станом на ${fmtDate(inv.date)}`);
        save(true, true);
        return go('stocktake', { stId: null, stSub: '' });
      default: return null;
    }
  }

  /** Числівник словами з родом одиниць: «двадцять два» номери, «двадцять дві» одиниці. */
  function intWords(n, g = 'm') {
    n = Math.floor(Math.abs(+n || 0));
    if (n === 0) return 'нуль';
    const parts = [];
    for (const [v, label, gg] of [[1e9, 'млрд.', 'm'], [1e6, 'млн.', 'm'], [1e3, 'тис.', 'f']]) {
      if (n >= v) { parts.push(words999(Math.floor(n / v), gg), label); n %= v; }
    }
    if (n) parts.push(words999(n, g));
    return parts.filter(Boolean).join(' ');
  }

  /** Дії довідника людей і вкладень (data-act з параметрами). */
  function peopleAction(what, d) {
    peopleInit();
    const p = personBy(state.personId);
    switch (what) {
      case 'pp-tab': state.peopleTab = d.v; state.personId = null; return render();
      case 'pp-new': return personNew();
      case 'pp-open':
        if (state.view !== 'people' || (state.peopleTab || 'people') !== 'people') {
          return go('people', { peopleTab: 'people', personId: d.id, q: '' });
        }
        state.personId = state.personId === d.id ? null : d.id;
        render();
        $('#scroll').scrollTop = 0;
        return null;
      case 'pp-close': state.personId = null; return render();
      case 'pp-del': return personDelete();
      case 'ph-add': {
        if (!p) return null;
        // Два записи історії на одну дату база не приймає: на сьогодні запис
        // уже є — правимо його, а не заводимо другий.
        if ((p.hist || []).some((h) => h.date === today())) {
          toast('Запис на сьогодні вже є — змініть звання чи посаду в ньому.', true);
          return null;
        }
        p.hist.push(Object.assign({}, personAt(p, today()), { date: today(), basis: '' }));
        save();
        return render();
      }
      case 'ph-del':
        if (!p || p.hist.length < 2) return null;
        if (!confirm('Видалити цей запис історії?\n\nДокументи на ту дату візьмуть попереднє звання й посаду.')) return null;
        p.hist.splice(+d.i, 1);
        save();
        return render();
      case 'as-kind': state.assign = { kind: d.v }; return render();
      case 'as-add': return assignAdd();
      case 'mvo-end': return assignEnd(d.id);
      case 'cmdr-end': return assignEnd(d.id, 'cmdr');
      case 'off-end': return assignEnd(d.id, 'role');
      case 'as-edit': {
        const kind = assignKind(d.v);
        const r = ASSIGN[kind].list().find((x) => x.id === d.id);
        if (!r) return null;
        state.assign = { kind, id: r.id, sub: r.sub, role: r.role, person: r.person, from: r.from || '', to: r.to || '', note: r.note || '' };
        render();
        $('#scroll')?.scrollTo({ top: 0 });
        return null;
      }
      case 'as-cancel': state.assign = { kind: (state.assign || {}).kind || 'mvo' }; return render();
      case 'mvo-del': return assignDelete('mvo', d.id);
      case 'cmdr-del': return assignDelete('cmdr', d.id);
      case 'off-del': return assignDelete('role', d.id);
      case 'loc-add': return locationAdd();
      case 'loc-del': return locationDelete(d.id);
      case 'file-add': {
        const t = fileTarget(d.key);
        if (t) attachScan(t);
        return null;
      }
      default: return null;
    }
  }

  // ============================================================ ЩО ПОТРЕБУЄ УВАГИ
  /** Перелік справ на Зведенні — від того, що ламає облік, до довідкового. Кожен
   *  пункт веде туди, де його закривають; порожній перелік — усе гаразд. */
  let attActs = [];
  /** Підшиті файли, яких немає в теці «скани»: запис у базі чи в стані є, а
   *  файл не скопіювали разом із текою даних. Перевіряє сервер програми —
   *  сторінка сама диск не бачить. Список живе до перезапуску вікна. */
  let missingFiles = null;
  /** Час останньої автоматичної копії — щоб видно було, чи вона взагалі є. */
  let lastBackup = '';
  /** «2026-09-12 19:35» від сервера — у вигляді документів: «12.09.2026 19:35». */
  const fmtStamp = (s) => (s ? fmtDate(String(s).slice(0, 10)) + String(s).slice(10) : '');
  async function checkFiles() {
    if (!native) return;
    const paths = new Set();
    for (const list of [...scans.values(), ...docScans.values()]) for (const f of list) if (f.path) paths.add(f.path);
    for (const f of (store.scans || [])) if (f.path) paths.add(f.path);
    try {
      const r = await fetch('api/scan-check', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [...paths] }) });
      const j = await r.json();
      missingFiles = j.missing || [];
      if (missingFiles.length) render();
    } catch (e) { missingFiles = null; }
    try {
      const list = await fetch('api/backups', { cache: 'no-store' }).then((r) => r.json());
      lastBackup = fmtStamp((list[0] || {}).time || '');
    } catch (e) { lastBackup = ''; }
  }

  function showMissingFiles() {
    const rows = (missingFiles || []).map((p) => `<div class="tbl__row tbl__row--plain">
        <div class="c-txt">${esc(p)}</div></div>`).join('');
    modalOpen('Підшиті файли, яких немає в теці',
      `<div class="panel"><div class="panel__note">Покладіть файли назад у «Дані обліку/скани» з тими самими іменами або підшийте наново.</div></div>
      <div class="tbl" style="--tbl-min:640px">${rows}</div>`);
  }

  /** Один номер на два документи того самого виду в різні дати — привід
   *  подивитися: служба могла почати нумерацію накладних з «1» наново. */
  function reusedNumbers() {
    const by = new Map();
    for (const r of docs) {
      const no = String(r.no).trim();
      if (!/\d/.test(no)) continue;                       // «Рапорт», «б/н» — не номер
      const k = r.kind + '|' + normNo(no);
      // Номер показуємо так, як він у папері, а не зведеним до малих літер.
      if (!by.has(k)) by.set(k, { kind: r.kind, no, dates: new Set() });
      by.get(k).dates.add(r.d);
    }
    return [...by.values()].filter((x) => x.dates.size > 1)
      .map((x) => ({ kind: x.kind, no: x.no, dates: [...x.dates].sort() }));
  }
  function attentionItems() {
    const t = today();
    const out = [];
    // У кожного пункту є не лише «що не так», а й що зараз зробити: людина
    // читає рядок і бачить наступний крок, а не стрілку в невідомість.
    const add = (lvl, n, text, fn, hint = '', act = '') => {
      if (n) out.push({ lvl, n, text, fn, hint, act });
    };
    const neg = [];
    for (const [k, v] of balances().map) {
      if (v < -1e-9) { const i = k.indexOf('|'); neg.push({ code: k.slice(0, i), sub: k.slice(i + 1), v }); }
    }
    add('bad', neg.length, `${plural(neg.length, 'мінусовий залишок', 'мінусові залишки', 'мінусових залишків')}`,
      () => go('item', { itemCode: neg[0].code }),
      neg.slice(0, 3).map((x) => `${(itemBy.get(x.code) || {}).name || x.code} у «${x.sub}» ${fmtNum(x.v)}`).join('; '),
      'Відкрити картку позиції');
    const draftsOpen = Object.entries(state.drafts || {}).filter(([, v]) => hasContent(v));
    if (state.draft && !state.editing && hasContent(state.draft)
      && !draftsOpen.some(([k]) => k === slotOf(state.draft.kind, state.draft.book || 'ТЗ'))) {
      draftsOpen.push([slotOf(state.draft.kind, state.draft.book || 'ТЗ'), state.draft]);
    }
    add('warn', draftsOpen.length, `${plural(draftsOpen.length, 'незавершений документ', 'незавершені документи',
      'незавершених документів')} у формі`, () => go('moves', { moveKind: draftsOpen[0][1].kind,
      book: draftsOpen[0][1].book || 'ТЗ', formOpen: true }),
      draftsOpen.map(([, v]) => `${KIND_NAME[v.kind] || 'рапорт'}${v.head.no ? ' ' + numNo(v.head.no) : ''}`).join(', '),
      'Дописати документ');
    const due = reconSubs(t).filter((x) => x.pos && reconStatus(x.sub).kind !== 'ok');
    const staleSigned = allRecon().filter(signedStale);
    add('warn', staleSigned.length, `${plural(staleSigned.length, 'підписана відомість звірки', 'підписані відомості звірки', 'підписаних відомостей звірки')}, під якими облік змінився заднім числом`,
      () => go('recon', { reconId: staleSigned.length === 1 ? staleSigned[0].id : null }),
      staleSigned.slice(0, 3).map((r) => `${r.sub} на ${fmtDate(r.to)}`).join(', '), 'Відкрити');
    add('warn', due.length, `${plural(due.length, 'підрозділ', 'підрозділи', 'підрозділів')} без звірки понад місяць або з непідписаною відомістю`, () => go('recon', { reconId: null }),
      due.slice(0, 4).map((x) => x.sub).join(', ') + (due.length > 4 ? '…' : ''),
      `Скласти звірки · ${due.length}`);
    // Два різні діла: запис без акта — скласти акт; запис зі складеним, але не проведеним
    // актом — провести його. Кожна кнопка веде на відібрані записи й підсвічує найдавніший.
    const byRep = (a, b) => ((a.reportDate || a.date) < (b.reportDate || b.date) ? -1 : 1);
    const stale = allDestroyed().filter((x) => x.status === 'рапорт подано' && openAt(x, t) && daysBetween(x.date, t) > 30).sort(byRep);
    add('warn', stale.length, `${plural(stale.length, 'запис', 'записи', 'записів')} знищеного без акта списання понад 30 днів`,
      () => { tfOf('dz').st = 'open'; go('destroyed', { q: '', dzFocus: stale[0].id }); },
      `найдавніший — ${fmtDate(stale[0] ? stale[0].date : t)}`,
      `Скласти акт списання · ${stale.length}`);
    const drafted = allDestroyed().filter((x) => x.status === 'включено до акта' && openAt(x, t)).sort(byRep);
    add('warn', drafted.length, `${plural(drafted.length, 'запис', 'записи', 'записів')} знищеного з актом, який ще не проведено`,
      () => { tfOf('dz').st = 'act'; go('destroyed', { q: '', dzFocus: drafted[0].id }); },
      [...new Set(drafted.map((x) => numNo(x.act)))].slice(0, 4).join(', '),
      `Провести акт · ${drafted.length}`);
    // Закритий підрозділ із майном: перейменували чи розформували, а майно
    // лишилося числитись — його треба передати накладною.
    const closedHeld = subs.filter((x) => !x.active && Math.abs(balSub(x.name)) > 1e-9);
    add('warn', closedHeld.length, `${plural(closedHeld.length, 'закритий підрозділ', 'закриті підрозділи',
      'закритих підрозділів')} із майном на обліку`, () => subHandOver(closedHeld[0].name),
      closedHeld.slice(0, 3).map((x) => `${x.name} — ${fmtNum(balSub(x.name))} од.`).join('; '),
      'Передати майно');
    const noMvo = reconSubs(t).filter((x) => x.pos && !mvoAt(x.sub, t));
    add('warn', noMvo.length, `${plural(noMvo.length, 'підрозділ', 'підрозділи', 'підрозділів')} з майном без МВО`,
      () => go('people', { peopleTab: 'resp', personId: null }), noMvo.slice(0, 4).map((x) => x.sub).join(', '),
      `Призначити МВО · ${noMvo.length}`);
    add('info', histOn() ? 1 : 0, 'увімкнено режим «вношу історію»',
      () => go('moves'), 'перемикач режиму в формі документа', 'Вимкнути режим');
    const inv = (store.inventories || []).filter((x) => x.status !== 'завершено');
    add('info', inv.length, plural(inv.length, 'інвентаризація не завершена', 'інвентаризації не завершені', 'інвентаризацій не завершено'), () => go('stocktake', { stId: inv[0].id, stSub: '' }),
      inv.map((x) => `станом на ${fmtDate(x.date)}`).join(', '), 'Продовжити опис');
    // Строки наказу про інвентаризацію: найближчий невиконаний — за місяць до нього.
    for (const x of inv) {
      const open = () => go('stocktake', { stId: x.id, stSub: '' });
      const due = stNextDue(x, t);
      if (due && due.left <= 30) {
        out.push({ lvl: due.kind === 'late' ? 'bad' : due.kind === 'soon' ? 'warn' : 'info', n: Math.abs(due.left) || '!',
          text: due.kind === 'late' ? `${plural(-due.left, 'день', 'дні', 'днів')} після строку ${due.what}, ${fmtDate(due.due)}`
            : due.left ? `${plural(due.left, 'день', 'дні', 'днів')} до строку ${due.what}, ${fmtDate(due.due)}`
              : `сьогодні строк ${due.what}`,
          fn: open, hint: '', act: 'Відкрити інвентаризацію' });
      }
      const late = stLate(x, t);
      add('warn', late.length, `${plural(late.length, 'підрозділ', 'підрозділи', 'підрозділів')} з простроченим днем інвентаризації за планом`,
        open, late.slice(0, 4).join(', ') + (late.length > 4 ? '…' : ''), 'Відкрити план');
    }
    // Відомість МТЗ: строк подання за минулий місяць і надходження, яким ще не вказано джерело.
    const mc = mtzCtl(t);
    if (mc) {
      const what = `подання відомості МТЗ за ${monthName(mc.ym)}`;
      out.push({ lvl: mc.kind === 'late' ? 'bad' : mc.kind === 'soon' ? 'warn' : 'info', n: Math.abs(mc.left) || '!',
        text: mc.kind === 'late' ? `${plural(-mc.left, 'день', 'дні', 'днів')} після строку ${what}, ${fmtDate(mc.due)}`
          : mc.left ? `${plural(mc.left, 'день', 'дні', 'днів')} до ${what}, ${fmtDate(mc.due)}` : `сьогодні строк ${what}`,
        fn: () => go('mtz', { mtzMonth: mc.ym }), hint: '', act: 'Відкрити відомість' });
    }
    const bare = mtzBare(t);
    add('warn', bare.length, `${plural(bare.length, 'надходження', 'надходження', 'надходжень')} без джерела для відомості МТЗ`,
      () => { tfOf('mtz').st = 'bare'; go('mtz', { mtzMonth: null }); },
      [...new Set(bare.map((x) => numNo(x.no)))].slice(0, 5).join(', '), `Вказати джерело · ${bare.length}`);
    const y = t.slice(0, 4);
    if (t >= `${y}-10-15` && !allInv().some((x) => x.date.startsWith(y) && x.kind === 'щорічна')) {
      add('info', 1, `щорічна інвентаризація ${y} року ще не заведена`, () => go('stocktake', { stId: null }),
        '', 'Завести інвентаризацію');
    }
    const mineNoScan = new Set(docs.filter((r) => r.mine && !scansOf(r).length).map(keyOfRow));
    add('info', mineNoScan.size, `${plural(mineNoScan.size, 'внесений документ', 'внесені документи', 'внесених документів')} без скану паперу`,
      () => go('moves', { noScan: true, onlyMine: true, movesLimit: 200 }), '',
      `Підшити скани · ${mineNoScan.size}`);
    add('bad', (missingFiles || []).length, `${plural((missingFiles || []).length, 'підшитий файл', 'підшиті файли',
      'підшитих файлів')} не знайдено в теці «скани»`, () => showMissingFiles(),
      (missingFiles || []).slice(0, 2).join('; '), 'Показати перелік');
    const off = invMismatch();
    add('info', off.length, `${plural(off.length, 'позиція', 'позиції', 'позицій')}: інвентарні номери не там, де майно`,
      () => go('inv', { q: off[0].code }), off.slice(0, 2).map((x) => `${x.code} «${x.sub}»: номерів ${x.n}, числиться ${fmtNum(x.q, '0')}`)
        .join('; '), 'Перенести номери');
    const reused = reusedNumbers();
    add('info', reused.length, `${plural(reused.length, 'номер', 'номери', 'номерів')} використано на кілька дат`,
      () => go('moves', { q: reused[0].no, movesLimit: 200 }),
      reused.slice(0, 3).map((x) => `${KIND_NAME[x.kind].toLowerCase()} ${numNo(x.no)}: ${x.dates.map(fmtDate).join(', ')}`).join('; '),
      'Переглянути документи');
    const short = staffRows(t).filter((g) => g.staffed && g.short > 0);
    add('info', short.length, `${plural(short.length, 'табельна позиція', 'табельні позиції', 'табельних позицій')} із некомплектом`, () => go('supply'),
      `разом ${fmtNum(short.reduce((a, g) => a + g.short, 0))} од.`, 'Відкрити штат');
    const unsure = tzItems().filter((i) => !assetSure(i) && balCode(i.code) > 1e-9);
    add('info', unsure.length, `${plural(unsure.length, 'позиція', 'позиції', 'позицій')} з непідтвердженим видом обліку`,
      () => go('nomen', { assetF: 'unsure', group: '', sub: '', q: '', onlyShort: false }),
      'уточніть у ФЕС, необоротний актив це чи запаси', 'Показати перелік');
    if (native && !me.remote && items.some((i) => bookOfItem(i) === 'ОП')) {
      // Книга «Облік ОП» — запасний шлях: коли програма недоступна, ведуть останнє вивантаження.
      const last = (D.meta || {}).opBookExport || '';
      const days = last ? daysBetween(last, t) : null;
      add('info', days == null || days >= 7 ? 1 : 0,
        days == null ? 'книгу «Облік ОП» ще не вивантажували'
          : `книгу «Облік ОП» не вивантажували ${cnt(days, 'день', 'дні', 'днів')}`,
        () => go('j47', { book: 'ОП' }), 'запасний шлях обліку посуду й миючих', 'Вивантажити');
    }
    const late = Object.values(store.docFes || {}).filter((f) => ['на підписі', 'їде на ФЕС'].includes(f.status)
      && f.date && daysBetween(f.date, t) > 14);
    add('info', late.length, `${plural(late.length, 'документ', 'документи', 'документів')} понад 14 днів «на підписі» чи «їде на ФЕС»`,
      () => go('moves', { movesFes: late[0] ? late[0].status : '' }), '', 'Показати');
    if (native && !me.remote) {
      // Автоматичні копії лежать на тому самому диску, що й база: втрата теки
      // чи диска забирає їх разом з обліком. Копію поза комп’ютером людина
      // робить сама — програма лише не дає про це забути.
      const last = store.ui.lastCopy || '';
      const days = last ? daysBetween(last, t) : null;
      add('info', days == null || days >= 30 ? 1 : 0,
        days == null ? 'копії бази поза комп’ютером ще не робили'
          : `копію бази поза комп’ютером не робили ${cnt(days, 'день', 'дні', 'днів')}`,
        () => copyAway(),
        'автоматичні копії лежать на тому самому диску, що й база',
        'Зберегти копію');
    }
    return out;
  }

  function attentionCard() {
    const list = attentionItems();
    attActs = list.map((x) => x.fn);
    if (!list.length) {
      return `<div class="card att-card att-card--ok" style="margin-bottom:12px"><div class="card__head">
        <div class="card__title">Потребує уваги</div><div class="panel__spacer"></div>
        <span class="panel__count">зауважень немає</span></div></div>`;
    }
    return `<div class="card att-card" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Потребує уваги</div></div>
      ${list.map((x, i) => `<div class="att att--${x.lvl}" data-act="att" data-i="${i}">
        <span class="att__n">${x.n}</span><span class="att__text">${esc(x.text)}${x.hint
          ? `<small>${esc(x.hint)}</small>` : ''}</span>
        <span class="att__go">${esc(x.act || 'Відкрити')} →</span></div>`).join('')}
    </div>`;
  }

  // ============================================================ КАРТКА ПІДРОЗДІЛУ
  /** Усе про підрозділ на одній сторінці: що числиться й на яку суму, штат і
   *  некомплект, остання звірка, МВО, документи, знищене. */
  function renderSubCard() {
    const sub = state.subName;
    const sb = subBy.get(sub);
    if (!sb) { state.view = 'subs'; renderNav(); return renderSubs(); }
    const date = state.asOf;
    const hasKids = subs.some((x) => x.parent === sub);
    if (state.subFilterFor !== sub) { state.subFilterFor = sub; state.subAsset = ''; state.subHolder = ''; }
    // Майно — за утримувачами. У батальйону власного майна зазвичай немає:
    // воно числиться за його їдальнею й ВМТЗ, тому картка показує і сам
    // підрозділ, і кожного підлеглого окремо. Вид обліку — необоротний актив
    // чи запаси — за ФЕС; фільтр лишає лише один вид або одного утримувача.
    const holders = subs.filter((x) => inSubtree(sub, x.name)).sort((a, b) => a.order - b.order);
    const held = new Map();                       // «утримувач|код» → рядок
    const all = { n: 0, q: 0, value: 0, na: 0, stock: 0, holders: new Set(), ownN: 0, ownQ: 0 };
    for (const [k, arr] of lotsAt(date)) {
      const i = k.indexOf('|');
      const s = k.slice(0, i), code = k.slice(i + 1);
      if (!inSubtree(sub, s)) continue;
      if (bookOf(code) !== (state.subBook || 'ТЗ')) continue;
      let q = 0, value = 0;
      for (const l of arr) { q += l.q; value += l.q * l.price; }
      if (Math.abs(q) <= 1e-9) continue;
      const it = itemBy.get(code) || {};
      all.n++; all.q += q; all.value += value; all[assetOf(it)] += q; all.holders.add(s);
      if (s === sub) { all.ownN++; all.ownQ += q; }
      if (state.subHolder && !inSubtree(state.subHolder, s)) continue;
      if (state.subAsset && assetOf(it) !== state.subAsset) continue;
      // Рядок — на партію: давній прихід за 1 250,00 і пізніший за 980,00
      // стоять окремо, як в Excel цієї картки й у відомості звірки.
      for (const l of arr) {
        if (Math.abs(l.q) <= 1e-9) continue;
        const key = s + '|' + code + '|' + l.price;
        const h = held.get(key) || { holder: s, code, name: it.name || code, unit: it.unit || '',
          asset: assetOf(it), price: l.price, q: 0, value: 0 };
        h.q += l.q; h.value += l.q * l.price;
        held.set(key, h);
      }
    }
    const getters = { code: (r) => r.code, name: (r) => r.name, asset: (r) => ASSET[r.asset][1],
      price: (r) => r.price, q: (r) => r.q, value: (r) => r.value };
    const byCode = (a, b) => a.code.localeCompare(b.code, 'uk', { numeric: true }) || b.price - a.price;
    const groups = holders
      .map((h) => ({ sub: h, rows: sortRows('sub', [...held.values()].filter((r) => r.holder === h.name).sort(byCode), getters) }))
      .filter((g) => g.rows.length);
    const rows = groups.flatMap((g) => g.rows);
    const tot = rows.reduce((a, r) => ({ q: a.q + r.q, value: a.value + r.value }), { q: 0, value: 0 });
    const filtered = !!(state.subAsset || state.subHolder);
    const staffR = staffRows(date, sub);
    const cov = coverage(staffR, false);
    const shortR = staffR.filter((g) => g.staffed && g.short > 0);
    const st = reconStatus(sub);
    const mvo = mvoAt(sub, date);
    const subDocs = docs.filter((r) => inSubtree(sub, r.from) || inSubtree(sub, r.to));
    const gone = allDestroyed().filter((x) => inSubtree(sub, x.sub) && openAt(x, date));
    // Одиниці із заводськими номерами — під назвою: опис і відомість закріплення
    // називають кожну кухню її номером, а не «3 к-т».
    const unitNote = (r) => {
      const us = unitsAt(r.code, r.holder, date).filter((u) => Math.abs(u.price - r.price) < 0.005);
      return us.length ? `<small>${esc(us.map((u) => u.label).join(', '))}</small>` : '';
    };
    const itemRow = (r) => `<div class="tbl__row" data-code="${esc(r.code)}" title="Відкрити картку позиції">
        <div class="c-code">${esc(r.code)}</div><div class="c-name"><b>${esc(r.name)}</b>${unitNote(r)}</div>
        <div class="c-tag">${assetTag(itemBy.get(r.code) || {})}</div>
        <div class="c-unit">${esc(r.unit)}</div>
        <div class="c-num c-num--wide">${fmtMoney(r.price)}</div>
        <div class="c-num c-num--wide">${fmtNum(r.q)}</div>
        <div class="c-num c-num--xwide">${fmtMoney(r.value)}</div></div>`;
    const groupHead = (g) => `<div class="tbl__group"><b class="lnk" data-sub="${esc(g.sub.name)}" title="Відкрити картку підрозділу">${esc(g.sub.name)}</b>
        <span>${esc(g.sub.type)}</span><div class="panel__spacer"></div>
        <span>${cnt(g.rows.length, 'позиція', 'позиції', 'позицій')} · ${fmtNum(g.rows.reduce((a, r) => a + r.q, 0), '0')} од. · ${fmtMoney(g.rows.reduce((a, r) => a + r.value, 0))} грн</span></div>`;
    const itemRows = groups.map((g) => (hasKids ? groupHead(g) : '') + g.rows.map(itemRow).join('')).join('');
    // У батальйону власного майна не буває — воно за їдальнею чи ВМТЗ. Якщо
    // документ виписано на сам батальйон, картка пропонує перенести майно
    // підрозділу; за замовчуванням — їдальні, як його тримає ФЕС.
    const hall = holders.find((h) => h.parent === sub && / · їдальня$/i.test(h.name)) || holders.find((h) => h.parent === sub);
    const ownDocs = docs.filter((r) => r.from === sub || r.to === sub);
    const rehold = hasKids && all.ownQ > 1e-9 && hall ? `<div class="callout" style="margin-bottom:12px">
        <b>Майно, виписане на «${esc(sub)}»:</b> ${cnt(all.ownN, 'позиція', 'позиції', 'позицій')}, ${fmtNum(all.ownQ, '0')} од.
        у ${cnt(docCount(ownDocs), 'документі', 'документах', 'документах')}. У батальйону власного майна не буває.
        <label class="chip" style="margin-left:8px"><span class="chip__label">перенести на</span>
          <select id="f-rehold">${holders.filter((h) => h.name !== sub).map((h) =>
            `<option value="${esc(h.name)}"${h.name === hall.name ? ' selected' : ''}>${esc(h.name)}</option>`).join('')}</select></label>
        <button type="button" class="btn btn--primary btn--sm" data-act="sub-rehold"
          title="Замінити батальйон у документах">Перенести</button></div>` : '';
    const kidMvo = !hasKids ? '' : holders.filter((h) => h.name !== sub && (all.holders.has(h.name) || mvoAt(h.name, date))).map((h) => {
      const m = mvoAt(h.name, date);
      return `<div><b class="lnk" data-sub="${esc(h.name)}" title="Відкрити картку підрозділу">${esc(h.name)}</b>: ${m
        ? `<b class="lnk" data-act="pp-open" data-id="${esc(m.id)}">${esc(pFull(m))}</b>${[personAt(m, date).rank, personAt(m, date).pos].filter(Boolean).map((x) => ', ' + esc(x)).join('')}`
        : '<span class="num-bad">МВО не призначено</span>'}</div>`;
    }).join('');
    return {
      head: head(`підрозділи / ${sb.type}`, sub, `
        <button class="btn" data-act="back">← Назад</button>
        <button class="btn" data-act="sd-open" data-sub="${esc(sub)}"
          title="Змінити запис у довіднику">✎ Довідник</button>
        <button class="btn" data-act="sub-nomen" title="Відкрити з фільтром цього підрозділу">Номенклатура</button>
        <button class="btn" data-act="sub-j14">Журнал № 14</button>
        <button class="btn" data-act="sub-xls">В Excel</button>
        ${!sb.active && Math.abs(balSub(sub)) > 1e-9
          ? `<button class="btn btn--primary" data-act="sub-handover" data-sub="${esc(sub)}"
              title="Накладна на все майно закритого підрозділу">Передати майно накладною</button>` : ''}
        ${!sb.active || (st.last && reconOf(sub).some((r) => r.to === today())) ? ''
          : `<button class="btn btn--primary" data-act="rc-new" data-sub="${esc(sub)}">Скласти відомість звірки</button>`}`),
      body: `${flashBlock()}
        ${sb.active ? '' : `<div class="callout" style="margin-bottom:12px"><b>Підрозділ закритий.</b> ${esc(sb.note)}</div>`}
        <div class="tiles">
          <div class="tile"><div class="tile__label">Позицій · одиниць</div><div class="tile__value">${all.n}
            <small>/ ${fmtNum(all.q, '0')}</small></div><div class="tile__hint">${hasKids ? 'з підлеглими, ' : ''}необоротні
            ${fmtNum(all.na, '0')}, запаси ${fmtNum(all.stock, '0')} од.</div></div>
          <div class="tile"><div class="tile__label">Вартість</div><div class="tile__value">${fmtMoney(all.value)} <small>грн</small></div>
            <div class="tile__hint">за цінами партій</div></div>
          <div class="tile"><div class="tile__label">Укомплектованість</div>
            <div class="tile__value ${cov == null ? '' : cov >= 1 ? 'num-ok' : cov >= 0.5 ? 'num-warn' : 'num-bad'}">${cov == null ? '—' : Math.round(cov * 100) + '%'}</div>
            <div class="tile__hint">${shortR.length ? `некомплект за ${cnt(shortR.length, 'позицією', 'позиціями', 'позиціями')}` : 'за штатом 21/Прод'}</div></div>
          <div class="tile"${st.last ? ` data-act="rc-open" data-id="${esc(st.last.id)}" style="cursor:pointer"` : ''}>
            <div class="tile__label">Остання звірка</div>
            <div class="tile__value ${st.kind === 'ok' ? '' : 'num-bad'}" style="font-size:18px">${st.last ? fmtDate(st.last.to) : 'не було'}</div>
            <div class="tile__hint">${st.last ? `№${esc(st.last.no || '—')} · ${esc(st.last.status)} · ${st.days} дн. тому` : 'складіть відомість'}</div></div>
        </div>
        <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Матеріально відповідальна особа</div>
            <div class="panel__spacer"></div><button class="btn btn--sm" data-act="sub-mvo">Змінити →</button></div>
          <div class="pad">${mvo ? `<b class="lnk" data-act="pp-open" data-id="${esc(mvo.id)}">${esc(pFull(mvo))}</b>${
            [personAt(mvo, date).rank, personAt(mvo, date).pos].filter(Boolean).map((x) => ', ' + esc(x)).join('')}`
            : !sb.active || !all.q ? '<span class="c-num--dim">Не призначено: майна немає.</span>'
              : hasKids && all.holders.size && !all.holders.has(sub)
                ? '<span class="c-num--dim">Не призначено: майно числиться за підлеглими підрозділами.</span>'
                : '<span class="num-bad">Не призначено.</span>'}</div>
          ${kidMvo ? `<div class="pad" style="padding-top:0"><div class="c-num--dim" style="margin-bottom:4px">МВО підлеглих підрозділів</div>${kidMvo}</div>` : ''}</div>
        ${shortR.length ? `<div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Некомплект за штатом</div>
            <div class="panel__spacer"></div><button class="btn btn--sm" data-nav="supply">Відкрити штат</button></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:700px">
            <div class="tbl__head"><div class="tbl__h c-name">табельна позиція</div><div class="tbl__h c-num">штат</div>
              <div class="tbl__h c-num">наявно</div><div class="tbl__h c-num">некомплект</div></div>
            ${shortR.map((g) => `<div class="tbl__row tbl__row--plain"><div class="c-name"><b>${esc(g.line)}</b><small>${esc(g.form)}</small></div>
              <div class="c-num">${fmtNum(g.qty)}</div><div class="c-num">${fmtNum(g.fact, '0')}</div>
              <div class="c-num num-bad">${fmtNum(g.short)}</div></div>`).join('')}
          </div></div></div>` : ''}
        ${rehold}
        <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Майно на ${fmtDate(date)}</div>
            <div class="panel__spacer"></div>
            <div class="seg">${[['ТЗ', 'Техзасоби'], ['ОП', 'Посуд і миючі']].map(([v, l]) =>
              `<button type="button" data-act="sub-book" data-v="${v}"${(state.subBook || 'ТЗ') === v ? ' class="is-on"' : ''}>${l}</button>`).join('')}</div>
            </div>
          <div class="panel sub-filter">
            ${(state.subBook || 'ТЗ') === 'ТЗ' ? `<div class="seg" title="Вид обліку за ФЕС">${[['', 'усе майно'], ['na', 'необоротні активи'], ['stock', 'запаси']]
              .map(([v, l]) => `<button type="button" data-act="sub-asset" data-v="${v}"${state.subAsset === v ? ' class="is-on"' : ''}>${l}</button>`).join('')}</div>` : ''}
            ${hasKids ? `<label class="chip${state.subHolder ? ' is-on' : ''}"><span class="chip__label">підрозділ</span>
              <select id="f-holder"><option value="">${esc(sub)} і всі підлеглі</option>${holders
                .filter((h) => h.name !== sub && [...all.holders].some((n) => inSubtree(h.name, n)))
                .map((h) => `<option value="${esc(h.name)}"${state.subHolder === h.name ? ' selected' : ''}>${'\u00a0\u00a0'.repeat(Math.max(0, h.depth - sb.depth - 1))}${esc(h.name)}</option>`).join('')}</select></label>` : ''}
            <div class="panel__spacer"></div>
            <span class="panel__count">${cnt(new Set(rows.map((r) => r.code)).size, 'позиція', 'позиції', 'позицій')} · ${fmtNum(tot.q, '0')} од.${filtered
              ? ' · <b class="lnk" data-act="sub-filter-reset">показати все</b>' : ''}</span>
          </div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:860px">
            <div class="tbl__head">${sortHead('sub', 'code', 'код', 'c-code')}${sortHead('sub', 'name', 'найменування', 'c-name')}
              ${sortHead('sub', 'asset', 'облік', 'c-tag')}<div class="tbl__h c-unit">од.</div>
              ${sortHead('sub', 'price', 'ціна партії, грн', 'c-num c-num--wide')}
              ${sortHead('sub', 'q', 'кількість', 'c-num c-num--wide')}${sortHead('sub', 'value', 'вартість, грн', 'c-num c-num--xwide')}</div>
            ${itemRows || `<div class="tbl__row tbl__row--plain"><div class="c-txt">${filtered ? 'За цим фільтром майна немає.' : 'Майна немає.'}</div></div>`}
            ${rows.length ? `<div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-code"></div><div class="c-name"><b>Разом${filtered ? ' за фільтром' : ''}</b></div>
              <div class="c-tag"></div><div class="c-unit"></div><div class="c-num c-num--wide"></div>
              <div class="c-num c-num--wide">${fmtNum(tot.q, '0')}</div><div class="c-num c-num--xwide">${fmtMoney(tot.value)}</div></div>` : ''}
          </div></div></div>
        ${gone.length ? `<div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Знищене, не списане</div>
            <div class="panel__spacer"></div><button class="btn btn--sm" data-nav="destroyed">Відкрити знищене майно</button></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:700px">
            ${gone.map((x) => `<div class="tbl__row" data-code="${esc(x.code)}"><div class="c-date">${fmtDate(x.date)}</div>
              <div class="c-name"><b>${esc((itemBy.get(x.code) || {}).name || x.code)}</b><small>${esc(x.sub)}</small></div>
              <div class="c-num">${fmtNum(x.qty)}</div><div class="c-code">${esc(x.report ? 'рапорт ' + numNo(x.report) : '')}</div></div>`).join('')}
          </div></div></div>` : ''}
        <div class="card"><div class="card__head"><div class="card__title">Документи</div><div class="panel__spacer"></div>
            <button class="btn btn--sm" data-act="sub-moves">Усі документи ${subDocs.length ? '(' + docCount(subDocs) + ')' : ''}</button></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:1000px;--acts:230px">
            <div class="tbl__head"><div class="tbl__h c-date">дата</div><div class="tbl__h c-tag">тип</div><div class="tbl__h c-status">стан</div>
              <div class="tbl__h c-code">№</div><div class="tbl__h c-name">найменування</div>
              <div class="tbl__h c-txt">маршрут</div><div class="tbl__h c-num">к-сть</div><div class="tbl__h c-acts"></div></div>
            ${docRows(subDocs.slice(0, 25)) || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Документів немає.</div></div>'}
          </div></div></div>`,
    };
  }

  /** Наявність підрозділу в Excel — як на картці: за утримувачами, з видом
   *  обліку й тими самими фільтрами (вид обліку, підлеглий підрозділ). */
  function subExcel() {
    const sub = state.subName;
    const date = state.asOf;
    const held = new Map();
    for (const [k, arr] of lotsAt(date)) {
      const i = k.indexOf('|');
      const s = k.slice(0, i), code = k.slice(i + 1);
      if (!inSubtree(sub, s)) continue;
      if (state.subHolder && !inSubtree(state.subHolder, s)) continue;
      const it = itemBy.get(code) || {};
      if (state.subAsset && assetOf(it) !== state.subAsset) continue;
      for (const l of arr) {
        const key = s + '|' + code + '|' + l.price;
        held.set(key, (held.get(key) || 0) + l.q);
      }
    }
    const order = (name) => (subBy.get(name) || {}).order ?? 1e9;
    const rows = [...held.entries()].filter(([, q]) => Math.abs(q) > 1e-9).map(([key, q]) => {
      const [s, code, price] = key.split('|');
      const it = itemBy.get(code) || {};
      const us = unitsAt(code, s, date).filter((u) => Math.abs(u.price - (+price || 0)) < 0.005);
      const name = (it.name || code) + (us.length ? ` (${us.map((u) => u.label).join(', ')})` : '');
      return [s, code, name, ASSET[assetOf(it)][1], it.unit || '', round3(q), +price || '', round2(q * (+price || 0))];
    }).sort((a, b) => order(a[0]) - order(b[0]) || String(a[1]).localeCompare(String(b[1]), 'uk', { numeric: true }));
    const who = state.subHolder || sub;
    const what = state.subAsset ? ASSET[state.subAsset][2] : 'технічних засобів';
    toExcel({ file: `Наявність ${who} на ${date}`, sheets: [{
      name: 'Наявність', orientation: 'landscape', top: [unitInfo().legalName, unitInfo().serviceFull],
      title: `Наявність ${what}: ${who}`, subtitle: `станом на ${fmtDate(date)}`,
      head: [['Підрозділ', 'Код', 'Найменування', 'Облік', 'Од.', 'Кількість', 'Ціна, грн', 'Сума, грн']],
      widths: [26, 9, 46, 12, 7, 11, 13, 15], rows, num: [5], money: [6, 7],
      total: ['', '', 'Разом', '', '', round3(rows.reduce((a, r) => a + r[5], 0)), '', round2(rows.reduce((a, r) => a + r[7], 0))],
    }] });
  }

  /** Майно, виписане на батальйон, переходить його підрозділу: у документах
   *  батальйон як сторона замінюється на підрозділ (їдальню), записи про
   *  знищення — так само. Це виправлення документів із записом у журнал змін
   *  по кожному: у батальйону власного майна не буває, воно завжди чиєсь. */
  function reholdToChild(sub, child) {
    if (!child || !subBy.get(child) || child === sub) return;
    const touched = new Map();                      // старий ключ → новий
    const fix = (kind, arr, fi, ti) => {
      for (const r of arr) {
        const from = String(r[fi] ?? '').trim(), to = ti == null ? '' : String(r[ti] ?? '').trim();
        if (from !== sub && to !== sub) continue;
        const oldKey = docKey(kind, r[0], r[2], from, to);
        if (from === sub) r[fi] = child;
        if (ti != null && to === sub) r[ti] = child;
        touched.set(oldKey, docKey(kind, r[0], r[2], r[fi], ti == null ? '' : r[ti]));
      }
    };
    fix('in', store.docs.incoming, 3, 4);
    fix('mv', store.docs.movement, 3, 4);
    fix('wr', store.docs.writeoffs, 3, null);             // «кому» у вибутті — не підрозділ
    let dz = 0;
    for (const x of (store.destroyed || [])) if (x.sub === sub) { x.sub = child; dz++; }
    if (!touched.size && !dz) { toast(`Документів, виписаних на «${sub}», немає.`); return; }
    for (const [oldKey, newKey] of touched) {
      const [k, d, no] = newKey.split('|');
      const text = `${KIND_NAME[k]} ${numNo(no)} від ${fmtDate(d)}: утримувач «${sub}» → «${child}»`;
      logChange('виправлено', newKey, text);
      if (oldKey !== newKey) logChange('виправлено', oldKey, `тепер ${text}`);
    }
    save(true, true);
    refresh();
    toast(`Майно «${sub}» перенесено на «${child}»: ${cnt(touched.size, 'документ', 'документи', 'документів')}`
      + (dz ? `, ${cnt(dz, 'запис про знищення', 'записи про знищення', 'записів про знищення')}` : '') + '.');
  }

  // ============================================================ ПОШУК ПО ВСЬОМУ
  /** Ctrl+K з будь-якого екрана: позиція (код, назва, зав. №, інв. № з бирки),
   *  документ (номер, дата, маршрут), підрозділ, людина, відомість звірки,
   *  інвентаризація. ↑↓ Enter — перейти, Esc — закрити. */
  const pal = { active: 0, found: [] };
  function paletteOpen() {
    if ($('#palette')) { $('#palette input').focus(); return; }
    const el = document.createElement('div');
    el.id = 'palette';
    el.className = 'palette';
    el.innerHTML = `<div class="palette__box"><div class="palette__in"><span>⌕</span>
        <input placeholder="Пошук: позиція, документ, рапорт, підрозділ, людина, інв. №, зав. №"
          autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
      <div class="palette__list"></div></div>`;
    el.addEventListener('mousedown', (e) => {
      if (e.target === el) { e.preventDefault(); paletteClose(); return; }
      const o = e.target.closest('[data-pi]');
      if (o) { e.preventDefault(); paletteGo(+o.dataset.pi); }
    });
    document.body.appendChild(el);
    const inp = el.querySelector('input');
    inp.addEventListener('input', () => { pal.active = 0; paletteRender(inp.value); });
    inp.addEventListener('keydown', (e) => {
      const n = pal.found.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (n) pal.active = (pal.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        paletteRender(inp.value, true);
      } else if (e.key === 'Enter') { e.preventDefault(); paletteGo(pal.active); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); paletteClose(); }
    });
    pal.active = 0;
    paletteRender('');
    inp.focus();
  }
  function paletteClose() { const el = $('#palette'); if (el) el.remove(); }
  /** Вага результату: спершу те, що збіглося точно, і лише потім згадки.
   *  0 — інвентарний номер, 1 — код позиції, 2 — номер документа,
   *  3 — назва підрозділу чи прізвище, 4 — початок назви, 5 — просто згадка. */
  const EXACT = { inv: 0, code: 1, docNo: 2, name: 3, starts: 4, rest: 5, tail: 6 };
  function paletteSearch(q) {
    const words = qWords(q);
    const out = [];
    const asked = String(q || '').trim().toLowerCase();
    const same = (x) => String(x || '').trim().toLowerCase() === asked;
    const starts = (x) => asked.length > 1 && String(x || '').trim().toLowerCase().startsWith(asked);
    if (!words.length) {
      // Порожній запит — що було нещодавно: останні документи.
      const seen = new Set();
      for (const r of docs) {
        const k = keyOfRow(r);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ type: 'документ', label: `${r.t || KIND_NAME[r.kind]} ${numNo(r.no)} від ${fmtDate(r.d)}`,
          meta: r.kind === 'wr' && !r.to ? r.from : `${r.from} → ${r.to}`, go: () => openDoc(k) });
        if (out.length >= 8) break;
      }
      return out;
    }
    const inv = invQuery(q);
    if (inv) {
      const it = itemBy.get(inv[0]);
      const range = inventory.find((r) => r.code === inv[0] && inv[1] >= r.from && inv[1] <= r.to);
      if (it) out.push({ rank: EXACT.inv, type: 'інв. номер', label: `${invNo(inv[0], inv[1])} · ${it.name}`,
        meta: range ? `за «${range.sub}»` : 'номер не видано', go: () => go('item', { itemCode: it.code }) });
    }
    let n = 0;
    for (const it of items) {
      if (!hitAll(words, it.code, it.name, it.serial || '', it.chassis || '', serialsOf.get(it.code) || '',
        it.old || '', it.fes || '')) continue;
      out.push({ rank: same(it.code) ? EXACT.code : same(it.serial) || same(it.chassis) ? EXACT.code
        : starts(it.code) || starts(it.name) ? EXACT.starts : EXACT.rest,
        type: 'позиція', label: `${it.code} · ${it.name}`, meta: `залишок ${fmtNum(balCode(it.code), '0')} ${it.unit || ''}`,
        go: () => go('item', { itemCode: it.code }) });
      if (++n >= 10) break;
    }
    n = 0;
    for (const sb of subs) {
      if (!hitAll(words, sb.name, sb.type, unitTitle(sb.name))) continue;
      out.push({ rank: same(sb.name) ? EXACT.name : starts(sb.name) ? EXACT.starts : EXACT.rest,
        type: 'підрозділ', label: sb.name, meta: sb.type, go: () => go('sub', { subName: sb.name }) });
      if (++n >= 6) break;
    }
    const seen = new Set();
    n = 0;
    // Документ шукається за всіма своїми рядками: заводський номер кухні
    // знаходить накладну, де ця кухня лише один із рядків.
    const docHay = new Map();
    for (const r of docs) {
      const k = keyOfRow(r);
      const extra = docWords(r).slice(1).join(' ');
      docHay.set(k, (docHay.get(k) || '') + ' ' + extra);
    }
    for (const r of docs) {
      const k = keyOfRow(r);
      if (seen.has(k)) continue;
      if (!hitAll(words, r.no, fmtDate(r.d), r.d, r.t || '', KIND_NAME[r.kind], docHay.get(k))) continue;
      seen.add(k);
      out.push({ rank: same(r.no) ? EXACT.docNo : starts(r.no) ? EXACT.starts : EXACT.rest,
        type: 'документ', label: `${r.t || KIND_NAME[r.kind]} ${numNo(r.no)} від ${fmtDate(r.d)}`,
        meta: r.kind === 'wr' && !r.to ? r.from : `${r.from} → ${r.to}`, go: () => openDoc(k) });
      if (++n >= 10) break;
    }
    n = 0;
    for (const p of store.people || []) {
      const at = personAt(p, state.asOf);
      if (!hitAll(words, pFull(p), at.rank, at.pos)) continue;
      out.push({ rank: same(p.surname) ? EXACT.name : starts(p.surname) ? EXACT.starts : EXACT.rest,
        type: 'людина', label: pFull(p), meta: [at.rank, at.pos].filter(Boolean).join(', '),
        go: () => go('people', { peopleTab: 'people', personId: p.id, q: '' }) });
      if (++n >= 6) break;
    }
    for (const r of allRecon()) {
      if (!hitAll(words, 'відомість звірка', r.no || '', r.sub, fmtDate(r.to))) continue;
      out.push({ rank: same(r.no) ? EXACT.docNo : EXACT.tail,
        type: 'звірка', label: `Відомість №${r.no || '—'} · ${r.sub}`, meta: `на ${fmtDate(r.to)} · ${r.status}`,
        go: () => reconOpen(r.id) });
      if (out.length > 60) break;
    }
    for (const x of allInv()) {
      if (!hitAll(words, 'інвентаризація', x.kind, fmtDate(x.date), x.orderNo || '')) continue;
      out.push({ rank: EXACT.tail, type: 'інвентаризація', label: `${x.kind} станом на ${fmtDate(x.date)}`,
        meta: x.base ? 'з бази' : x.status, go: () => go('stocktake', { stId: x.id, stSub: '' }) });
    }
    // Рапорти про знищення — за номером рапорту чи акта, підрозділом, обставинами
    // й заводським номером кухні: рапорт не документ руху, у стрічці його немає.
    const reports = new Map();
    for (const r of allDestroyed()) {
      const k = [r.report || '', r.sub, r.reportDate || r.date].join('|');
      const u = r.unit ? unitBy.get(String(r.unit)) : null;
      const x = reports.get(k) || { r, n: 0, hay: '' };
      x.n++;
      x.hay += ` ${r.act || ''} ${r.offNo || ''} ${r.note || ''} ${r.name || ''} ${(itemBy.get(r.code) || {}).name || ''} ${u ? u.serial || u.chassis || '' : ''}`;
      reports.set(k, x);
    }
    n = 0;
    for (const { r, n: lines, hay } of reports.values()) {
      if (!hitAll(words, 'рапорт знищення', r.report || '', r.sub, fmtDate(r.reportDate || r.date), hay)) continue;
      out.push({ rank: same(r.report) ? EXACT.docNo : EXACT.tail, type: 'рапорт',
        label: `Рапорт ${numNo(r.report || '—')} · ${r.sub}`, meta: `${fmtDate(r.reportDate || r.date)} · ${cnt(lines, 'рядок', 'рядки', 'рядків')}`,
        go: () => go('destroyed', { q: r.report || r.sub }) });
      if (++n >= 6) break;
    }
    // Сортування стабільне: усередині однакової ваги порядок лишається тим,
    // у якому збирали, — позиції за кодом, документи від найновіших.
    return out.sort((a, b) => (a.rank ?? EXACT.rest) - (b.rank ?? EXACT.rest)).slice(0, 60);
  }
  function paletteRender(q, keep = false) {
    const el = $('#palette');
    if (!el) return;
    if (!keep) pal.found = paletteSearch(q);
    const words = qWords(q);
    const list = el.querySelector('.palette__list');
    list.innerHTML = pal.found.length ? pal.found.map((o, i) => `<div class="palette__opt${i === pal.active ? ' is-active' : ''}" data-pi="${i}">
        <span class="palette__type">${esc(o.type)}</span><span class="palette__label">${hl(o.label, words)}</span>
        <span class="palette__meta">${esc(o.meta || '')}</span></div>`).join('')
      : `<div class="pick__empty">${q.trim() ? 'Нічого не знайдено.' : 'Введіть запит.'}</div>`;
    list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }
  function paletteGo(i) {
    const o = pal.found[i];
    if (!o) return;
    paletteClose();
    o.go();
  }

  // ============================================================ ДОКУМЕНТ НА ОСНОВІ
  /** «Повернути» — зворотна накладна тими самими рядками; «Копія» — той самий
   *  документ із сьогоднішньою датою й без номера. Незавершену чернетку того
   *  самого виду не затираємо без згоди. */
  function docBasedOn(key, mode) {
    const rows = docs.filter((r) => keyOfRow(r) === key);
    if (!rows.length || !leaveEditing()) return;
    const r0 = rows[0];
    const kind = r0.kind;
    // Зворотна накладна повертає ті самі партії й ті самі одиниці, що приїхали:
    // інакше повернення пішло б від найдавнішої партії одержувача.
    const back = mode === 'return';
    const at = new Map();
    const lines = [];
    for (const r of rows) {
      for (const p of (back ? rowParts(r) : [{ d: '', price: r.price, q: +r.q || 0 }])) {
        const ln = { code: r.code, qty: 0, note: '',
                     price: kind === 'in' ? (r.price ? String(r.price) : '')
                       : (back && p.d ? String(p.price) : ''),
                     lot: back && kind !== 'in' ? p.d || '' : '',
                     unit: back ? String(r.unit || '') : '' };
        const key = lineKeyOf(ln, kind);
        const have = at.get(key);
        if (have) { have.qty = round3(have.qty + p.q); continue; }
        ln.qty = p.q;
        at.set(key, ln);
        lines.push(ln);
      }
    }
    lines.forEach((ln) => { ln.qty = String(ln.qty); });
    stashDraft();
    state.drafts = state.drafts || {};
    const book = bookOf(r0.code);
    if (state.drafts[slotOf(kind, book)] && hasContent(state.drafts[slotOf(kind, book)])
      && !confirm(`Замінити незавершену чернетку «${KIND_NAME[kind]}»?\n\nНаписане в ній буде втрачено.`)) return;
    const head = mode === 'return'
      ? { type: r0.t || 'Накладна', no: '', date: today(), from: r0.to, to: r0.from,
          basis: `повернення за документом ${numNo(r0.no)} від ${fmtDate(r0.d)}`, report: '', reportDate: '', act: '', note: '' }
      : { type: r0.t || '', no: '', date: today(), from: r0.from, to: r0.to || '', basis: basisOf(r0.note),
          report: '', reportDate: '', act: '', note: '' };
    delete state.drafts[slotOf(kind, book)];
    state.editing = null;
    state.moveKind = kind;
    state.book = book;
    state.draft = { kind, book, head, lines: lines.concat([emptyLine()]) };
    state.flash = mode === 'return'
      ? `Зворотна накладна за документом ${numNo(r0.no)}: ${head.from} → ${head.to}, `
        + `${cnt(lines.length, 'найменування', 'найменування', 'найменувань')}. Перевірте кількості й впишіть номер.`
      : `Копія документа ${numNo(r0.no)}: ${cnt(lines.length, 'найменування', 'найменування', 'найменувань')}, дата сьогоднішня. Впишіть номер.`;
    go('moves', { q: '', formOpen: true });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
    $('#doc-form [name="no"]')?.focus();
  }

  /** «Усе майно відправника» — рядки з усім, що за ним числиться на дату документа. */
  function linesAll() {
    const dr = draft();
    const from = dr.head.from;
    const date = dr.head.date || today();
    if (!from) { toast('Оберіть відправника.', true); return; }
    const have = [];
    for (const it of items.filter((x) => bookOfItem(x) === (dr.book || 'ТЗ'))) {
      // Одиниці із заводськими номерами — своїми рядками, решта — кількістю.
      for (const u of (byLot() ? unitsAt(it.code, from, date) : [])) {
        have.push({ code: it.code, qty: '1', price: String(u.price), note: '', lot: u.d, unit: String(u.id) });
      }
      const q = (byLot() ? bulkAt(it.code, from, date) : availableAt(it.code, from, date))
        - (state.moveKind === 'dz' ? destroyedAt(it.code, from, date) : 0);
      if (q > 1e-9) have.push({ code: it.code, qty: String(round3(q)), price: '', note: '', lot: '', unit: '' });
    }
    if (!have.length) { toast(`За «${from}» на ${fmtDate(date)} нічого не числиться.`, true); return; }
    const filled = dr.lines.filter((l) => l.code || (l.other && String(l.name || '').trim()));
    if (filled.length && !confirm(`Замінити ${cnt(filled.length, 'рядок', 'рядки', 'рядків')} документа всім майном «${from}» `
      + `(${cnt(have.length, 'позиція', 'позиції', 'позицій')})?`)) return;
    dr.lines = have.concat([emptyLine()]);
    render();
    toast(`У документ внесено все, що числиться за «${from}» на ${fmtDate(date)}: ${cnt(have.length, 'позиція', 'позиції', 'позицій')}.`);
  }

  // ============================================================ РОЗБІЖНОСТІ ЗВІРКИ → ДОКУМЕНТИ
  /** Нестача понад знищене за рапортами й лишки з відомості — готовими чернетками. */
  function reconDiffs(r) {
    const defs = new Map(reconLines(r.sub, r.to).map((l) => [l.code + '|' + l.price, l.fact]));
    const short = [], over = [];
    for (const l of r.lines) {
      if (!l.code || l.fact == null) continue;
      const key = l.code + '|' + l.price;
      const base = defs.has(key) ? Math.min(defs.get(key), l.acc) : l.acc;
      if (l.fact < base - 1e-9) short.push({ code: l.code, qty: round3(base - l.fact), price: l.price, name: l.name });
      if (l.fact > l.acc + 1e-9) over.push({ code: l.code, qty: round3(l.fact - l.acc), price: l.price, name: l.name });
    }
    return { short, over };
  }
  function reconDiffPanel(r) {
    const { short, over } = reconDiffs(r);
    if (!short.length && !over.length) return '';
    const sum = (a) => a.reduce((s, x) => s + x.qty * (x.price || 0), 0);
    return `<div class="flash flash--warn" style="margin-bottom:12px"><span>Розбіжності за відомістю:
        ${short.length ? `нестача ${cnt(short.length, 'позиція', 'позиції', 'позицій')} на ${fmtMoney(sum(short))} грн` : ''}
        ${short.length && over.length ? ' · ' : ''}${over.length ? `лишки ${cnt(over.length, 'позиція', 'позиції', 'позицій')} на ${fmtMoney(sum(over))} грн` : ''}.
        Знищене за рапортами в нестачу не входить.</span>
      <span>${short.length ? '<button class="btn btn--sm" data-act="rc-doc" data-v="dz">Внести рапорт про знищення</button> '
        + '<button class="btn btn--sm" data-act="rc-doc" data-v="wr">Скласти акт списання</button>' : ''}
      ${over.length ? '<button class="btn btn--sm" data-act="rc-doc" data-v="in">Оприбуткувати лишки</button>' : ''}</span></div>`;
  }
  function reconToDoc(kind) {
    const r = reconById(state.reconId);
    if (!r || !leaveEditing()) return;
    const { short, over } = reconDiffs(r);
    const src = kind === 'in' ? over : short;
    if (!src.length) return;
    stashDraft();
    state.drafts = state.drafts || {};
    if (state.drafts[kind] && hasContent(state.drafts[kind])
      && !confirm('Замінити незавершену чернетку?\n\nНаписане в ній буде втрачено.')) return;
    const basis = `відомість звірки №${r.no || '—'} від ${fmtDate(r.date)}`;
    const head = { type: '', no: '', date: r.to, from: kind === 'in' ? `лишки за звіркою (${r.sub})` : r.sub,
      to: kind === 'in' ? r.sub : '', basis, report: '', reportDate: '', act: '',
      note: kind === 'in' ? 'лишки, виявлені під час звірки' : 'нестача, виявлена під час звірки' };
    delete state.drafts[kind];
    state.moveKind = kind;
    state.draft = { kind, head, lines: src.map((x) => {
      const ln = { code: x.code, qty: String(x.qty), note: '', lot: '', unit: '',
                   price: kind === 'in' && x.price ? String(x.price) : '' };
      if (kind === 'wr' && x.price) {
        // Ціна з відомості — це партія: списується саме вона, а не найдавніша.
        const lot = lotChoices(x.code, r.sub, r.to).find((l) => Math.abs(l.price - x.price) < 0.005);
        if (lot) { ln.lot = lot.d; ln.price = String(lot.price); }
      }
      return ln;
    }).concat([emptyLine()]) };
    state.flash = `Чернетку складено з відомості №${r.no || '—'} (${r.sub}): ${cnt(src.length, 'рядок', 'рядки', 'рядків')}. `
      + 'Перевірте кількості, впишіть номер і проведіть.';
    go('moves', { q: '', formOpen: true });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
  }

  // ============================================================ СОРТУВАННЯ
  /** Клац по заголовку — сортування за колонкою; вдруге — у зворотному порядку;
   *  утретє — як було. Назви й коди спершу за абеткою, числа — від більшого. */
  const sortOf = (view) => ((state.sort || {})[view]) || null;
  const SORT_TEXT = new Set(['code', 'name', 'line', 'sub', 'asset', 'kind', 'status', 'no', 'route']);
  function sortHead(view, key, label, cls = '') {
    const s = sortOf(view);
    const on = s && s.k === key;
    return `<div class="tbl__h ${cls} is-sortable${on ? ' is-sorted' : ''}" data-act="sort" data-view="${view}"
      data-k="${key}" title="Сортувати">${label}${on ? (s.dir > 0 ? ' ▲' : ' ▼') : ''}</div>`;
  }
  function sortToggle(view, key, firstDir) {
    state.sort = state.sort || {};
    const s = state.sort[view];
    const first = firstDir ? (+firstDir > 0 ? 1 : -1) : SORT_TEXT.has(key) ? 1 : -1;
    if (!s || s.k !== key) state.sort[view] = { k: key, dir: first };
    else if (s.dir === first) state.sort[view] = { k: key, dir: -first };
    else delete state.sort[view];
    regRefresh(view);
  }
  function sortRows(view, rows, getters) {
    const s = sortOf(view);
    if (!s || !getters[s.k]) return rows;
    const get = getters[s.k];
    return rows.slice().sort((a, b) => {
      const x = get(a), y = get(b);
      const c = typeof x === 'string' || typeof y === 'string'
        ? String(x ?? '').localeCompare(String(y ?? ''), 'uk', { numeric: true }) : (x ?? -Infinity) - (y ?? -Infinity);
      return c * s.dir;
    });
  }

  // ============================================================ РЕЄСТРИ
  /** Реєстр: пошук, фільтри-чипи, сортування за будь-якою колонкою, підсумок.
   *  Фільтри живуть у state.tf[id], сортування — у state.sort[id], тож екран
   *  і його Excel бачать той самий відбір.
   *
   *  spec: { id, rows, headSearch?, search?(r) → [поля], placeholder?, filters?,
   *          columns, row?(r) → {attrs, cls, title}, total?(shown) → {колонка: html},
   *          count?(shown, all) → html, empty?, emptyFiltered?, allCount?, minWidth?,
   *          limit?, panelCls?, acts? (ширина графи дій, напр. '150px') }
   *  Колонка: { key, label, cls, style?, sort?(r), first? (1 — спершу за
   *          зростанням), title?, cell(r) → html, cellCls?(r), cellTitle?(r) }
   *  Фільтр:  seg { key, options: [[значення, підпис]], test(r, v) }
   *          select { key, label, all, options, test(r, v) }
   *          toggle { key, label, title?, test(r) }
   *          period { key, label, get(r) } */
  const REG_LIMIT = 300;
  const regRedraw = new Map();              // реєстр у вікні → як його перемалювати
  const regHeadIds = new Set(['dz', 'inv', 'pp']);   // пошук цих реєстрів — у шапці сторінки
  const tfOf = (id) => { state.tf = state.tf || {}; return (state.tf[id] = state.tf[id] || {}); };
  function regRefresh(id) {
    const fn = regRedraw.get(id);
    return fn ? fn() : render();
  }
  const regQuery = (spec) => (spec.headSearch ? state.q || '' : tfOf(spec.id).q || '');
  function regActive(spec) {
    const f = tfOf(spec.id);
    return !!regQuery(spec).trim() || (spec.filters || []).some((x) => (x.type === 'period'
      ? f[x.key + 'From'] || f[x.key + 'To'] : f[x.key]));
  }
  function regRows(spec) {
    const f = tfOf(spec.id);
    const words = spec.search ? qWords(regQuery(spec)) : [];
    const out = spec.rows.filter((r) => {
      if (words.length && !hitAll(words, ...spec.search(r))) return false;
      for (const x of spec.filters || []) {
        if (x.type === 'period') {
          const d = String(x.get(r) || '').slice(0, 10);
          if (f[x.key + 'From'] && (!d || d < f[x.key + 'From'])) return false;
          if (f[x.key + 'To'] && (!d || d > f[x.key + 'To'])) return false;
        } else if (f[x.key] && !x.test(r, f[x.key])) return false;
      }
      return true;
    });
    const getters = {};
    for (const c of spec.columns) if (c.sort) getters[c.key] = c.sort;
    return sortRows(spec.id, out, getters);
  }
  function regPanel(spec, shown) {
    const f = tfOf(spec.id);
    const id = esc(spec.id);
    const act = (k, v) => `data-act="tf" data-id="${id}" data-k="${esc(k)}" data-v="${esc(v)}"`;
    const parts = [];
    if (spec.search && !spec.headSearch) {
      parts.push(`<div class="search search--panel"><span>⌕</span><input type="search" data-tf-q="${id}"
        value="${esc(f.q || '')}" placeholder="${esc(spec.placeholder || 'Пошук')}" autocomplete="off"></div>`);
    }
    for (const x of spec.filters || []) {
      const v = f[x.key] || '';
      if (x.type === 'seg') {
        parts.push(`<div class="seg"${x.title ? ` title="${esc(x.title)}"` : ''}>${x.options.map(([val, label]) =>
          `<button type="button" ${act(x.key, val)}${v === val ? ' class="is-on"' : ''}>${esc(label)}</button>`).join('')}</div>`);
      } else if (x.type === 'select') {
        parts.push(`<label class="chip${v ? ' is-on' : ''}"><span class="chip__label">${esc(x.label)}</span>
          <select data-tf="${id}" data-k="${esc(x.key)}"><option value="">${esc(x.all || 'усі')}</option>${x.options.map(([val, label]) =>
            `<option value="${esc(val)}"${v === val ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`);
      } else if (x.type === 'toggle') {
        parts.push(`<button type="button" class="chip chip--btn${v ? ' is-on' : ''}" ${act(x.key, v ? '' : '1')}${
          x.title ? ` title="${esc(x.title)}"` : ''}>${v ? '✓ ' : ''}${esc(x.label)}</button>`);
      } else if (x.type === 'period') {
        const a = f[x.key + 'From'] || '', b = f[x.key + 'To'] || '';
        parts.push(`<label class="chip${a || b ? ' is-on' : ''}"><span class="chip__label">${esc(x.label)} з</span>
          <input type="date" data-tf="${id}" data-k="${esc(x.key)}From" value="${esc(a)}">
          <span class="chip__label">по</span><input type="date" data-tf="${id}" data-k="${esc(x.key)}To" value="${esc(b)}"></label>`);
      }
    }
    if (regActive(spec)) parts.push(`<button type="button" class="chip chip--btn" data-act="tf-reset" data-id="${id}">Скинути фільтри</button>`);
    const total = spec.allCount ?? spec.rows.length;
    const count = spec.count ? spec.count(shown, spec.rows) : shown.length === total ? String(total) : `${shown.length} із ${total}`;
    return `<div class="panel${spec.panelCls ? ' ' + spec.panelCls : ''}">${parts.join('')}
      <div class="panel__spacer"></div><div class="panel__count">${count}</div></div>`;
  }
  function regTable(spec, shown) {
    const srt = sortOf(spec.id);
    const st = (c) => (c.style ? ` style="${c.style}"` : '');
    const headCell = (c) => {
      if (!c.sort) return `<div class="tbl__h ${c.cls || ''}"${st(c)}${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label || '')}</div>`;
      const on = srt && srt.k === c.key;
      return `<div class="tbl__h ${c.cls || ''} is-sortable${on ? ' is-sorted' : ''}"${st(c)} data-act="sort" data-view="${esc(spec.id)}"
        data-k="${esc(c.key)}" data-first="${c.first || -1}" title="${esc(c.title || 'Сортувати')}">${esc(c.label)}${on ? (srt.dir > 0 ? ' ▲' : ' ▼') : ''}</div>`;
    };
    const limit = spec.limit ? Math.max(spec.limit, tfOf(spec.id).limit || 0) : Infinity;
    const part = shown.slice(0, limit);
    const rows = part.map((r) => {
      const o = spec.row ? spec.row(r) : {};
      return `<div class="tbl__row${o.cls ? ' ' + o.cls : ''}"${o.attrs ? ' ' + o.attrs : ''}${o.title ? ` title="${esc(o.title)}"` : ''}>${
        spec.columns.map((c) => `<div class="${c.cls || ''}${c.cellCls ? ' ' + c.cellCls(r) : ''}"${st(c)}${
          c.cellTitle ? ` title="${esc(c.cellTitle(r))}"` : ''}>${c.cell(r)}</div>`).join('')}</div>`;
    }).join('');
    const more = shown.length > part.length ? `<div class="tbl__more">
        <button type="button" class="btn" data-act="tf-more" data-id="${esc(spec.id)}">Показати ще ${Math.min(shown.length - part.length, spec.limit)}</button>
        <span class="panel__count">показано ${part.length} із ${shown.length}</span></div>` : '';
    const hasAny = (spec.allCount ?? spec.rows.length) > 0;
    const empty = shown.length ? '' : `<div class="tbl__row tbl__row--plain"><div class="c-txt">${esc(hasAny
      ? spec.emptyFiltered || 'За цими фільтрами нічого немає.' : spec.empty || 'Записів немає.')}</div></div>`;
    const tot = spec.total && shown.length ? spec.total(shown) : null;
    const totalRow = tot ? `<div class="tbl__row tbl__row--plain tbl__row--total">${spec.columns.map((c) =>
      `<div class="${c.cls || ''}"${st(c)}>${tot[c.key] ?? ''}</div>`).join('')}</div>` : '';
    return `<div class="tbl" style="--tbl-min:${spec.minWidth || '900px'}${spec.acts ? `;--acts:${spec.acts}` : ''}"><div class="tbl__head">${
      spec.columns.map(headCell).join('')}</div>${rows}${empty}${more}${totalRow}</div>`;
  }
  /** Реєстр цілком: панель фільтрів і таблиця над тим самим відбором. */
  function registry(spec) {
    const shown = regRows(spec);
    return { shown, panel: regPanel(spec, shown), table: regTable(spec, shown) };
  }
  function regReset(id) {
    const f = tfOf(id);
    for (const k of Object.keys(f)) delete f[k];
    if (regHeadIds.has(id)) state.q = '';
  }
  /** Поля фільтрів живуть до наступного перемальовування — прив'язуємо щоразу. */
  function bindRegistry(root) {
    if (!root) return;
    root.querySelectorAll('select[data-tf], input[type="date"][data-tf]').forEach((el) => {
      el.addEventListener('change', () => {
        const fl = tfOf(el.dataset.tf);
        fl[el.dataset.k] = el.value;
        fl.limit = 0;
        regRefresh(el.dataset.tf);
      });
    });
    root.querySelectorAll('input[data-tf-q]').forEach((el) => {
      el.addEventListener('input', debounce(() => {
        const id = el.dataset.tfQ;
        const pos = el.selectionStart;
        const fl = tfOf(id);
        fl.q = el.value;
        fl.limit = 0;
        regRefresh(id);
        const again = document.querySelector(`input[data-tf-q="${id}"]`);
        if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      }, 200));
    });
  }

  // ============================================================ ВІДОМІСТЬ МТЗ
  /** Відомість закуплених (отриманих) матеріально-технічних засобів. Частина
   *  подає її вищому штабу щомісяця, наростаючим підсумком від січня; служба —
   *  свої рядки виконавцеві частини, у тій самій формі. Рядок відомості — рядок
   *  приходу ззовні за звітний рік. Джерела надходжень, КПКВ і КЕКВ у папері
   *  приходу немає, тому їх указують тут: store.mtz.rows за ключем
   *  «id документа|код». Майно, передане з іншої частини, і перенос залишків
   *  до відомості не входять. */
  const MTZ_SERVICE = 'Продовольча служба';
  const MTZ_GROUP = 'Обладнання продовольчої служби';
  // Групи й одиниці виміру — з методичних рекомендацій до відомості: інших назв не приймають.
  const MTZ_GROUPS = ['Автомобілі та мототехніка', 'Автомобільні запчастини', 'Автомобільні агрегати', 'Боєприпаси', 'БпАК',
    'БпЛА', 'Будівельні матеріали/інструменти', 'Витратні матеріали до оргтехніки', 'Генератори', 'Електроприлади',
    'Електротехнічні матеріали', 'Елементи живлення', 'Запасні частини до генераторів', 'Запчастини та комплектуючі',
    'Зарядні станції', 'Засоби гігієни', 'Засоби зв’язку', 'Засоби радіозв’язку', 'Засоби спостереження', 'Засоби ураження',
    'Ізоляційні матеріали', 'Канцелярія', 'Комплектуючі до БпЛА', 'Комплектуючі до НРК', 'Комплектуючі до ПЕОМ',
    'Комплектуючі до радіостанцій', 'Комплектуючі до РЕБ/РЕР', 'Комплектуючі РАО',
    'Майно служби інженерно-інфраструктурного забезпечення', 'Медичні інструменти', 'Медичні препарати',
    'Медичне обладнання', 'Мережеве обладнання', 'Навчальні засоби', 'Наземний роботизований комплекс',
    'Обладнання до БпЛА', 'Обладнання до НРК', 'Обладнання до автомобільної техніки', 'Обладнання до РАО',
    'Обладнання до РЕБ/РЕР', 'Обладнання продовольчої служби', 'Олива/масла', 'Оптичні прилади', 'Оргтехніка',
    'Охолоджуючі рідини', 'Паливо', 'Паркогаражне обладнання', 'ПЕОМ', 'Послуги', 'Пожежне майно', 'Радіостанції',
    'РЕБ/РЕР', 'Ремонт автомобільної техніки', 'Ремонт РЕБ/РЕР', 'Ремонт спеціальної техніки', 'Ретранслятори',
    'Речове майно', 'Серверне обладнання', 'Система супутникового зв’язку', 'Спеціальна техніка',
    'Спеціальне обладнання', 'Стрілецька зброя', 'Флеш накопичувачі', 'Харчування', 'Шини'];
  const MTZ_UNITS = ['Бухта', 'Каністра', 'Кілограм', 'Кілометрів', 'Комплекс', 'Комплект', 'Кубічних метрів', 'Літрів',
    'Метрів', 'Метрів квадратних', 'Метрів погонних', 'Мішок', 'Одиниць', 'Пара', 'Пакет', 'Пачка',
    'Пластикова пляшка ємкістю 1,5 літрів', 'Послуги', 'Рулон', 'Тон', 'Упаковка', 'Штук'];
  const MTZ_UNIT_OF = { 'шт': 'Штук', 'к-т': 'Комплект', 'компл': 'Комплект', 'пар': 'Пара', 'кг': 'Кілограм',
    'л': 'Літрів', 'м': 'Метрів' };
  const mtzUnitOf = (u) => MTZ_UNIT_OF[String(u || '').trim().toLowerCase().replace(/\.$/, '')] || '';
  const MTZ_SRC = [['БД', 'благодійна допомога'], ['ПДФО', 'податок на доходи фізичних осіб'], ['С', 'субвенція']];
  // Джерело фінансування з «Закупівель» і позначення відомості, яке йому відповідає; решта джерел у відомість не входить.
  const MTZ_SRC_OF_FUND = { 'Субвенція': 'С', 'Благодійна допомога': 'БД', '10% ПДФО': 'ПДФО' };
  const MTZ_KPKV = ['2101020/35', '2101150/12'];
  const MTZ_KEKV = ['2210', '2220', '2230', '2240', '2260', '3110'];
  const MTZ_IN_KIND = 'Отримано в натуральній формі';
  const MTZ_FORCE = { 'СТрО': 'Сил територіальної оборони Збройних Сил України' };
  const MONTHS_NOM = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень',
    'вересень', 'жовтень', 'листопад', 'грудень'];

  function mtzStore() {
    if (!store.mtz || typeof store.mtz !== 'object' || Array.isArray(store.mtz)) store.mtz = {};
    const m = store.mtz;
    if (!m.rows || typeof m.rows !== 'object') m.rows = {};
    if (!m.sent || typeof m.sent !== 'object') m.sent = {};
    return m;
  }
  const mtzDay = () => Math.min(28, Math.max(1, Math.round(+mtzStore().day) || 8));
  const mtzBelongs = () => { const v = mtzStore().belongs; return v == null ? 'СТрО' : String(v); };
  const monthAdd = (ym, n) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 7);
  const monthEnd = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);
  const monthName = (ym) => `${MONTHS_NOM[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
  /** «січень–вересень 2026 року»: відомість — наростаючим підсумком від січня. */
  const mtzSpan = (ym) => `${ym.slice(5, 7) === '01' ? '' : 'січень–'}${MONTHS_NOM[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)} року`;
  /** Станом на яку дату відомість за місяць і до якого числа її подають. */
  const mtzAsOf = (ym) => `${monthAdd(ym, 1)}-01`;
  const mtzDue = (ym) => `${monthAdd(ym, 1)}-${String(mtzDay()).padStart(2, '0')}`;
  /** Звітний місяць на дату: до числа подання — попередній, після нього — поточний. */
  const mtzMonthNow = (t = today()) => (+t.slice(8, 10) <= mtzDay() ? monthAdd(t.slice(0, 7), -1) : t.slice(0, 7));
  /** Місяць, який відкриває екран: неподана відомість за минулий місяць — і після строку теж. */
  const mtzMonth = () => state.mtzMonth || (mtzCtl() || {}).ym || mtzMonthNow();

  /** Прихід не з коштів, а з іншої частини чи за нарядом: до відомості не входить. */
  const mtzOutside = (r) => /^(в\/ч\s*)?[АA]\s?\d{4}$/i.test(String(r.from || '').trim())
    || /військова частина/i.test(String(r.from || '')) || ['Атестат', 'Накладна', 'Наряд'].includes(r.t);
  const mtzIn = (x) => MTZ_SRC.some(([k]) => k === x.src);
  /** Перенесення початкових залишків — не надходження: позначка буває у виді документа, а в
   *  перенесеній історії — і в полі «від кого» при звичайному «Акті приймання». */
  const mtzCarry = (r) => /перен[ео]с(ення)?\s+(початкових\s+)?залишк/i.test(`${r.t || ''}|${r.from || ''}`)
    || /^(початков\S*\s+залишк\S*|залишк\S*\s+на\s+початок.*)$/i.test(String(r.from || '').trim());

  /** Надходження ззовні за рік (до дати включно): рядок приходу — рядок відомості. */
  function mtzRows(year, until = `${year}-12-31`) {
    const saved = mtzStore().rows;
    const by = new Map();
    for (const r of docs) {
      if (r.kind !== 'in' || !r.id || mtzCarry(r) || r.d.slice(0, 4) !== year || r.d > until) continue;
      const key = `${r.id}|${r.code}`;
      const x = by.get(key);
      if (x) { x.q = round3(x.q + r.q); continue; }
      by.set(key, { key, doc: keyOfRow(r), d: r.d, no: r.no, from: r.from, t: r.t, id: r.id, code: r.code, q: r.q, price: r.price });
    }
    return [...by.values()].sort((a, b) => a.d.localeCompare(b.d) || a.id - b.id
      || String(a.code).localeCompare(String(b.code), 'uk', { numeric: true })).map((x) => {
      const a = saved[x.key] || {};
      const it = itemBy.get(x.code) || {};
      const auto = !a.src && mtzOutside(x);
      return Object.assign(x, { sum: round2(x.q * x.price), src: a.src || (auto ? '-' : ''), auto,
        kpkv: a.kpkv || '', kekv: a.kekv || '', group: a.group || MTZ_GROUP,
        name: a.name || cleanName(it.name || x.code), unit: a.unit || mtzUnitOf(it.unit), uom: it.unit || '',
        note: a.note || '', their: a.no || '', theirName: a.tname || '', diff: a.diff || '',
        parts: Array.isArray(a.parts) && a.parts.length > 1 });
    });
  }

  /** Назва проти типових недоліків відомості: великі літери, скорочення, лапки, пробіл перед одиницею. */
  function mtzNameIssues(name) {
    const s = String(name || '').trim();
    const out = [];
    if (/^[А-ЯІЇЄҐ'’ʼ]{4,}(?=\s|$)/.test(s) || /[А-ЯІЇЄҐ]{4,}\s+[А-ЯІЇЄҐ]{4,}/.test(s)) out.push('назва великими літерами');
    else if (/^[а-яіїєґa-z]/.test(s)) out.push('назва з малої літери');
    if (/[«»]/.test(s)) out.push('лапки «» замість “ ”');
    // Крапка після слова посеред назви — скорочення («нерж.сталь», «арт. 45»); наприкінці назви вона нічого не скорочує.
    if (/[а-яіїєґ]{2,}\.(?!\s*$)/i.test(s)) out.push('скорочення в назві');
    if (/\d(?:кВт|Вт|кг|мл|мм|см|л|м|г)(?![а-яіїєґa-z0-9])/i.test(s)) out.push('між числом і одиницею немає пробілу');
    if (s.split(/\s+/).length < 2) out.push('назва одним словом');
    return out;
  }
  /** Що в рядку не так: без цього виконавець частини поверне відомість. */
  function mtzIssues(x, seen = mtzStore().seen) {
    if (x.src === '-') return [];
    const out = [];
    if (!x.src) out.push('немає джерела');
    else {
      if (!x.kpkv) out.push('немає КПКВ');
      if (!/^\d{4}$/.test(x.kekv)) out.push(x.kekv ? 'КЕКВ не з чотирьох цифр' : 'немає КЕКВ');
    }
    if (!x.unit) out.push(`одиниці «${x.uom || '—'}» немає в переліку`);
    if (Math.abs(x.q - Math.round(x.q)) > 1e-9) out.push('кількість не ціла');
    if (!(x.price > 0)) out.push('немає ціни');
    if (x.parts) out.push('розділено на частки в «Закупівлях»: у відомість іде перша');
    out.push(...mtzNameIssues(x.name));
    if (x.diff) out.push(`у відомості частини ${x.diff}`);
    else if (seen && mtzIn(x) && !x.their && x.d <= (seen.until || '')) out.push('немає у відомості частини');
    return out;
  }

  /** Джерело фінансування позиції (розділ «Закупівлі») тримається позначення відомості: позначення
   *  змінили — джерело, що йому суперечить, знімається й далі виводиться з самого позначення. */
  function mtzFundFix(a) {
    if (a.fund && (a.src || '') !== (MTZ_SRC_OF_FUND[a.fund] || '-')) { delete a.fund; delete a.fundNote; }
    return a;
  }
  function mtzSet(key, field, v) {
    const rows = mtzStore().rows;
    const a = Object.assign({}, rows[key] || {});
    const val = typeof v === 'number' ? v : String(v ?? '').trim();
    if (val || val === 0) a[field] = val; else delete a[field];
    if (field === 'src') mtzFundFix(a);
    if (Object.keys(a).length) rows[key] = a; else delete rows[key];
  }
  /** Документ видалено або з нього прибрано позицію: її реквізити не мають дістатися іншому
   *  документу, який база запише під тим самим id. keep — коди, що лишились у документі. */
  function mtzForget(id, keep = null) {
    const rows = mtzStore().rows;
    for (const key of Object.keys(rows)) {
      const i = key.indexOf('|');
      if (key.slice(0, i) === String(id) && !(keep && keep.has(key.slice(i + 1)))) delete rows[key];
    }
  }

  /** Подання на дату: за який місяць, строк і скільки днів лишилось. null — подано або
   *  подавати нічого: надходжень за рік немає чи місяць давніший за перший, який веде програма. */
  function mtzCtl(t = today()) {
    const m = mtzStore();
    const ym = monthAdd(t.slice(0, 7), -1);
    if ((m.from && ym < m.from) || m.sent[ym]) return null;
    if (!mtzRows(ym.slice(0, 4), monthEnd(ym)).some((x) => x.src !== '-')) return null;
    const due = mtzDue(ym);
    const left = daysBetween(t, due);
    return { ym, due, left, kind: left < 0 ? 'late' : left <= 3 ? 'soon' : 'wait' };
  }
  /** Перший місяць, за яким програма стежить: той, чий строк подання ще не минув. */
  function mtzInit(t = today()) {
    const m = mtzStore();
    if (m.from) return false;
    m.from = mtzMonthNow(t);
    return true;
  }
  /** Надходження без джерела: за поточний рік, а до січневого строку — ще й за минулий, грудневий. */
  const mtzBare = (t = today()) => [...new Set([mtzMonthNow(t).slice(0, 4), t.slice(0, 4)])]
    .flatMap((y) => mtzRows(y)).filter((x) => !x.src);
  const mtzTodo = () => mtzBare().length;

  /** Слова назви для порівняння: малими літерами, без лапок і розділових знаків. */
  const mtzWords = (s) => new Set(String(s || '').toLowerCase().replace(/['’ʼ`"“”«»]/g, '')
    .split(/[^a-zа-яіїєґ0-9]+/i).filter((w) => w.length > 1));
  function mtzAlike(a, b) {
    const x = mtzWords(a), y = mtzWords(b);
    if (!x.size || !y.size) return 0;
    let n = 0;
    for (const w of x) if (y.has(w)) n++;
    return n / Math.max(x.size, y.size);
  }
  /** Рядки відомості частини до рядків програми: та сама кількість і ціна, до копійки;
   *  серед однакових — за назвою. Без жодного спільного слова в назві — не пара. */
  function mtzMatch(mine, theirs) {
    const cand = [];
    mine.forEach((a, i) => theirs.forEach((b, j) => {
      if (Math.abs(a.q - b.qty) > 1e-9 || Math.abs(a.price - b.price) > 0.006) return;
      const score = mtzAlike(a.name, b.name);
      if (score >= 0.2) cand.push([score, i, j]);
    }));
    cand.sort((p, q) => q[0] - p[0] || p[1] - q[1] || p[2] - q[2]);
    const usedA = new Set(), usedB = new Set(), pairs = [];
    for (const [, i, j] of cand) {
      if (usedA.has(i) || usedB.has(j)) continue;
      usedA.add(i); usedB.add(j); pairs.push([mine[i], theirs[j]]);
    }
    return { pairs, mine: mine.filter((_, i) => !usedA.has(i)), theirs: theirs.filter((_, j) => !usedB.has(j)) };
  }
  /** Звірка з відомістю частини: джерело, КПКВ і КЕКВ переходять у рядки, де їх ще немає;
   *  рядок запам'ятовує свій номер у відомості частини й те, чим вона від нього відрізняється. */
  function mtzApply(theirs, file, year, t = today()) {
    const m = mtzStore();
    const mine = mtzRows(year);
    const res = mtzMatch(mine, theirs);
    const extra = res.theirs.filter((b) => b.service === MTZ_SERVICE);
    // Жодної пари — це не та відомість (інша частина, інший рік): попередня звірка лишається як була.
    if (!res.pairs.length) return { total: theirs.length, pairs: 0, filled: 0, wrong: [], missing: [], extra };
    for (const x of mine) {
      const a = m.rows[x.key];
      if (!a) continue;
      delete a.no; delete a.diff; delete a.tname;
      if (!Object.keys(a).length) delete m.rows[x.key];
    }
    const money4 = (sum) => Number(sum).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    let filled = 0, until = '';
    const wrong = [];
    for (const [x, b] of res.pairs) {
      const a = Object.assign({}, m.rows[x.key] || {});
      const had = !!(a.src && a.kpkv && a.kekv);
      if (!a.src && mtzIn(b)) a.src = b.src;
      if (!a.kpkv && b.kpkv) a.kpkv = b.kpkv;
      if (!a.kekv && b.kekv) a.kekv = b.kekv;
      if (!a.note && b.note) a.note = b.note;
      if (!a.group && b.group !== MTZ_GROUP && MTZ_GROUPS.includes(b.group)) a.group = b.group;
      if (!a.unit && !x.unit && MTZ_UNITS.includes(b.unit)) a.unit = b.unit;
      a.no = b.no;
      // Назву з відомості частини рядок пам'ятає: у картці рядка її можна взяти замість своєї.
      if (b.name && b.name !== x.name) a.tname = b.name;
      const diff = [];
      if (b.service !== MTZ_SERVICE) diff.push(`служба «${b.service}»`);
      if (Math.abs(b.price - round2(b.price)) > 1e-9) diff.push(`ціна ${money4(b.price)}`);
      if (a.src && b.src && a.src !== b.src) diff.push(`джерело ${b.src}`);
      if (a.kpkv && b.kpkv && a.kpkv !== b.kpkv) diff.push(`КПКВ ${b.kpkv}`);
      if (a.kekv && b.kekv && a.kekv !== b.kekv) diff.push(`КЕКВ ${b.kekv}`);
      if (diff.length) { a.diff = diff.join(', '); wrong.push({ no: b.no, name: x.name, diff: a.diff }); }
      m.rows[x.key] = mtzFundFix(a);
      if (!had && a.src && a.kpkv && a.kekv) filled++;
      if (x.d > until) until = x.d;
    }
    m.seen = { date: t, file: String(file || ''), rows: theirs.length, until };
    wrong.sort((p, q) => (Number(p.no) || 0) - (Number(q.no) || 0));          // у звіті — як у файлі частини
    return { total: theirs.length, pairs: res.pairs.length, filled, wrong,
      missing: res.mine.filter((x) => x.src !== '-' && x.d <= until), extra };
  }

  function mtzReport(res, file) {
    const list = (title, rows, line) => (rows.length ? `<div class="panel"><div class="panel__note"><b>${esc(title)}</b>
      </div></div><div class="tbl" style="--tbl-min:auto">${rows.map((r) => `<div class="tbl__row tbl__row--plain">${line(r)}</div>`).join('')}</div>` : '');
    modalOpen(`Звірка з «${file}»`, `<div class="panel"><div class="panel__note">У файлі ${cnt(res.total, 'рядок', 'рядки', 'рядків')}.
        ${res.pairs ? `Збіглося ${esc(String(res.pairs))}, джерело, КПКВ і КЕКВ перенесено в ${esc(String(res.filled))}.`
    : 'Із надходженнями служби за цей рік не збігся жоден. Попередня звірка не змінилась.'}</div></div>
      ${list('У відомості частини записано інакше', res.wrong, (r) => `<div class="c-code">№ ${esc(r.no)}</div>
        <div class="c-name"><b>${esc(r.name)}</b></div><div class="c-txt num-bad">${esc(r.diff)}</div>`)}
      ${list('Немає у відомості частини', res.missing, (x) => `<div class="c-code">${esc(fmtDate(x.d))}</div>
        <div class="c-name"><b>${esc(x.name)}</b></div><div class="c-txt">${esc(numNo(x.no))}, ${fmtNum(x.q)} × ${fmtMoney(x.price)}</div>`)}
      ${list('Немає в програмі', res.extra, (b) => `<div class="c-code">№ ${esc(b.no)}</div>
        <div class="c-name"><b>${esc(b.name)}</b></div><div class="c-txt">${fmtNum(b.qty)} × ${fmtMoney(b.price)}, ${esc(b.src)}</div>`)}
      ${!res.pairs || res.wrong.length || res.missing.length || res.extra.length ? ''
    : '<div class="panel"><div class="panel__note">Розбіжностей немає.</div></div>'}`);
  }
  function mtzPick() {
    if (!native) { toast('Звірка з файлом є лише в програмі на комп’ютері.', true); return; }
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.xlsx';
    inp.addEventListener('change', () => { if (inp.files && inp.files[0]) mtzCompare(inp.files[0]); });
    inp.click();
  }
  async function mtzCompare(file) {
    let got;
    try {
      const r = await fetch('api/mtz-read', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
      got = await r.json();
    } catch (e) {
      toast('Файл не прочитано: ' + (e.message || e), true);
      return;
    }
    const res = mtzApply(got.rows || [], file.name, mtzMonth().slice(0, 4));
    if (res.pairs) {
      logChange('відомість МТЗ звірено', 'mtz', `Звірка з «${file.name}»: збіглося ${res.pairs}, заповнено ${res.filled}`);
      save();
      render();
    }
    mtzReport(res, file.name);
  }

  function mtzSpec(rows) {
    const issues = new Map(rows.map((x) => [x.key, mtzIssues(x)]));
    const inList = (list) => list.filter(mtzIn);
    const total = (list) => round2(inList(list).reduce((a, x) => a + x.sum, 0));
    const opts = (list, v, empty) => `<option value="">${esc(empty)}</option>` + list.map(([val, label]) =>
      `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(label)}</option>`).join('');
    const srcOptions = MTZ_SRC.map(([k]) => [k, k]).concat([['-', 'не входить']]);
    return {
      id: 'mtz', rows, minWidth: '1080px', limit: REG_LIMIT,
      placeholder: 'Пошук: назва, код, документ, постачальник',
      search: (x) => [x.code, x.name, x.no, x.from || '', x.src, x.kekv, x.note],
      filters: [
        { type: 'seg', key: 'st', options: [['', 'усі'], ['in', 'у відомість'], ['bare', 'без джерела'], ['out', 'не входять']],
          test: (x, v) => (v === 'in' ? mtzIn(x) : v === 'bare' ? !x.src : x.src === '-') },
        { type: 'toggle', key: 'bad', label: 'із зауваженнями', test: (x) => issues.get(x.key).length > 0 },
      ],
      columns: [
        // Колонки вміщаються в 1366 px: ціна стоїть під сумою, постачальник — під номером документа.
        { key: 'doc', label: 'документ', cls: 'c-name c-name--stack', style: 'flex:0 1 150px', first: 1, sort: (x) => `${x.d}|${x.no}`,
          cellTitle: (x) => `${x.t} ${numNo(x.no)} від ${fmtDate(x.d)}, ${x.from || '—'}`,
          cell: (x) => `<b class="lnk" data-open="${esc(x.doc)}">${esc(numNo(x.no))}</b><small>${fmtDate(x.d)}</small>
            <small style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.from || '—')}</small>` },
        { key: 'name', label: 'найменування', cls: 'c-name c-name--stack', style: 'flex:2 1 250px', first: 1, sort: (x) => x.name,
          cellTitle: (x) => x.name + (x.their ? `. У відомості частини № ${x.their}${
            x.theirName && x.theirName !== x.name ? `: ${x.theirName}` : ''}` : ''),
          cell: (x) => `<b>${esc(x.name)}</b><small>${esc([x.code, x.unit || x.uom, x.group !== MTZ_GROUP ? x.group : '', x.note]
            .filter(Boolean).join(' · '))}</small>` },
        { key: 'q', label: 'к-сть', cls: 'c-num', style: 'width:60px', sort: (x) => x.q, cell: (x) => fmtNum(x.q) },
        { key: 'sum', label: 'сума, грн', cls: 'c-num', style: 'width:108px', sort: (x) => x.sum, title: 'Сума й ціна за одиницю',
          cell: (x) => `${fmtMoney(x.sum)}<small>по ${fmtMoney(x.price)}</small>` },
        { key: 'src', label: 'джерело', cls: 'c-txt', style: 'flex:0 0 104px', first: 1, sort: (x) => x.src || '~',
          cellTitle: (x) => (x.parts ? 'Позицію розділено на частки: реквізити — у «Закупівлях»'
            : x.auto ? 'Від військової частини чи за нарядом' : (MTZ_SRC.find(([k]) => k === x.src) || [])[1] || ''),
          // Позиція з частками править реквізити в «Закупівлях»: тут — те, що стоїть у першій частці.
          cell: (x) => (x.parts ? esc(x.src === '-' ? 'не входить' : x.src || '—')
            : `<select data-mtz-src="${esc(x.key)}" aria-label="джерело надходжень">${opts(srcOptions, x.src, '—')}</select>`) },
        { key: 'kpkv', label: 'КПКВ', cls: 'c-txt', style: 'flex:0 0 112px', first: 1, sort: (x) => x.kpkv || '~',
          cell: (x) => (x.src === '-' ? '—' : x.parts ? esc(x.kpkv || '—') : `<select data-mtz-kpkv="${esc(x.key)}" aria-label="КПКВ">${
            opts(MTZ_KPKV.concat(x.kpkv && !MTZ_KPKV.includes(x.kpkv) ? [x.kpkv] : []).map((k) => [k, k]), x.kpkv, '—')}</select>`) },
        { key: 'kekv', label: 'КЕКВ', cls: 'c-txt', style: 'flex:0 0 80px', first: 1, sort: (x) => x.kekv || '~',
          cell: (x) => (x.src === '-' ? '—' : x.parts ? esc(x.kekv || '—') : `<input class="rc-in rc-in--wide" list="mtz-kekv" inputmode="numeric" maxlength="4"
            data-mtz-kekv="${esc(x.key)}" value="${esc(x.kekv)}" aria-label="КЕКВ">`) },
        { key: 'bad', label: 'зауваження', cls: 'c-txt', style: 'flex:1 1 120px', sort: (x) => issues.get(x.key).length,
          cellCls: (x) => (issues.get(x.key).length ? (x.src ? 'num-warn' : 'num-bad') : ''),
          cellTitle: (x) => issues.get(x.key).join('; '),
          cell: (x) => { const l = issues.get(x.key); return l.length ? `${esc(l[0])}${l.length > 1 ? ` <small>і ще ${l.length - 1}</small>` : ''}` : ''; } },
        { key: 'acts', label: '', cls: 'c-acts', style: 'flex-basis:92px', cell: (x) => rowBtn('mtz-edit', '✎ Виправити',
          `data-key="${esc(x.key)}"`, { title: 'Назва, одиниця виміру, група, примітка' }) },
      ],
      row: (x) => ({ cls: x.src ? '' : 'is-due' }),
      total: (shown) => ({ name: '<b>Разом у відомість</b>', q: fmtNum(round3(inList(shown).reduce((a, x) => a + x.q, 0)), '0'),
        sum: fmtMoney(total(shown)) }),
      count: (shown, all) => { const bare = all.filter((x) => !x.src).length;
        return `у відомість ${cnt(inList(all).length, 'рядок', 'рядки', 'рядків')} на ${fmtMoney(total(all))} грн`
          + (bare ? ` · без джерела ${bare}` : ''); },
      empty: 'Надходжень ззовні за цей рік немає.',
    };
  }

  function renderMtz() {
    const m = mtzStore();
    const ym = mtzMonth();
    const t = today();
    const rows = mtzRows(ym.slice(0, 4), monthEnd(ym));
    const reg = registry(mtzSpec(rows));
    const due = mtzDue(ym), sent = m.sent[ym] || '';
    const left = daysBetween(t, due);
    const st = sent ? { cls: '', text: `подано ${fmtDate(sent)}` }
      : t < mtzAsOf(ym) ? { cls: '', text: 'місяць ще триває' }
        : left < 0 ? { cls: 'num-bad', text: `прострочено на ${cnt(-left, 'день', 'дні', 'днів')}` }
          : { cls: left <= 3 ? 'num-warn' : '', text: left ? `лишилось ${cnt(left, 'день', 'дні', 'днів')}` : 'строк сьогодні' };
    const months = [];
    for (let k = t.slice(0, 7), i = 0; i < 14; i++, k = monthAdd(k, -1)) months.push(k);
    if (!months.includes(ym)) months.push(ym);
    return {
      fill: true,
      head: head('контроль / відомість МТЗ', 'Відомість МТЗ', `
        <button class="btn" data-act="mtz-file" title="Файл «МТЗ ${esc(unitCode() || 'А0000')}.xlsx» від виконавця частини">Звірити з відомістю частини</button>
        <button class="btn btn--primary" data-act="mtz-xls">В Excel</button>`),
      body: `${flashBlock()}
        <div class="card" style="margin-bottom:12px">
          <div class="card__head"><div class="card__title">Подання</div>
            <label class="chip"><span class="chip__label">звітний місяць</span>
              <select id="mtz-month">${months.map((k) => `<option value="${k}"${k === ym ? ' selected' : ''}>${esc(monthName(k))}</option>`).join('')}</select></label>
            <label class="chip"><span class="chip__label">строк до</span>
              <input type="number" min="1" max="28" class="rc-in" style="width:44px" data-mtz-day value="${mtzDay()}" aria-label="число місяця, до якого подають відомість">
              <span class="chip__label">числа</span></label>
            <label class="chip"><span class="chip__label">належність</span>
              <input class="rc-in" style="width:64px;text-align:left" data-mtz-belongs value="${esc(mtzBelongs())}" aria-label="належність частини"></label>
            <div class="panel__spacer"></div>
            <span class="panel__count"${m.seen ? ` title="${esc(m.seen.file)}"` : ''}>${m.seen
              ? `звірено з відомістю частини ${fmtDate(m.seen.date)}` : 'з відомістю частини не звіряли'}</span></div>
          <div class="tbl" style="--tbl-min:auto">
            <div class="tbl__row tbl__row--plain${st.cls === 'num-bad' ? ' is-due' : ''}">
              <div class="c-name"><b>За ${esc(mtzSpan(ym))}</b><small>станом на ${fmtDate(mtzAsOf(ym))}</small></div>
              <div class="c-txt" style="flex:0 0 150px">до ${fmtDate(due)}</div>
              <div class="c-txt" style="flex:0 0 200px">подано <input type="date" class="rc-in" style="width:136px"
                data-mtz-sent="${esc(ym)}" value="${esc(sent)}" aria-label="день, коли відомість подано"></div>
              <div class="c-txt ${st.cls}">${esc(st.text)}</div>
            </div></div></div>
        ${reg.panel}<div class="card card--scroll card--fill">${reg.table}</div>
        <datalist id="mtz-kekv">${MTZ_KEKV.map((k) => `<option value="${k}">`).join('')}</datalist>`,
    };
  }

  function bindMtz() {
    if (state.view !== 'mtz') return;
    const sc = $('#scroll');
    const year = mtzMonth().slice(0, 4);
    // Джерело й КПКВ у папері одні на весь прихід: рядки того самого документа, де їх ще немає, беруть те саме.
    const spread = (key, field, v) => {
      mtzSet(key, field, v);
      if (v && v !== '-') {
        const id = key.split('|')[0];
        for (const x of mtzRows(year)) if (String(x.id) === id && x.key !== key && !x[field]) mtzSet(x.key, field, v);
      }
      save();
      render();
    };
    sc.querySelectorAll('[data-mtz-src]').forEach((el) => el.addEventListener('change', () => spread(el.dataset.mtzSrc, 'src', el.value)));
    sc.querySelectorAll('[data-mtz-kpkv]').forEach((el) => el.addEventListener('change', () => spread(el.dataset.mtzKpkv, 'kpkv', el.value)));
    sc.querySelectorAll('[data-mtz-kekv]').forEach((el) => el.addEventListener('change', () => {
      mtzSet(el.dataset.mtzKekv, 'kekv', el.value.replace(/\D/g, ''));
      save();
      render();
    }));
    sc.querySelectorAll('[data-mtz-sent]').forEach((el) => el.addEventListener('change', () => {
      const ym = el.dataset.mtzSent;
      const sent = mtzStore().sent;
      if (el.value > today()) { toast('Відмітку «подано» ставлять не раніше дня подання.', true); el.value = sent[ym] || ''; return; }
      if (el.value) sent[ym] = el.value; else delete sent[ym];
      logChange(el.value ? 'відомість МТЗ подано' : 'відмітку про подання знято', `mtz|${ym}`,
        `Відомість МТЗ за ${monthName(ym)}${el.value ? `: подано ${fmtDate(el.value)}` : ''}`);
      save();
      render();
    }));
    $('#mtz-month')?.addEventListener('change', (e) => { state.mtzMonth = e.target.value; tfOf('mtz').limit = 0; render(); });
    sc.querySelector('[data-mtz-day]')?.addEventListener('change', (e) => {
      const v = Math.round(+e.target.value);
      if (v >= 1 && v <= 28) mtzStore().day = v; else delete mtzStore().day;
      save();
      render();
    });
    sc.querySelector('[data-mtz-belongs]')?.addEventListener('change', (e) => { mtzStore().belongs = e.target.value.trim(); save(); render(); });
  }

  function mtzEdit(key) {
    const x = mtzRows(mtzMonth().slice(0, 4)).find((r) => r.key === key);
    if (!x) return;
    const base = cleanName((itemBy.get(x.code) || {}).name || x.code);
    const opt = (list, v) => list.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('');
    const el = modalOpen(`${numNo(x.no)} від ${fmtDate(x.d)} · ${x.code}`, `<form id="mtz-form"><div class="form__grid">
        <div class="field field--span"><label>Найменування предмета закупівлі</label>
          <input name="name" value="${esc(x.name)}" autocomplete="off" required>
          <div class="field__hint">У довіднику: ${esc(base)}</div>
          ${x.theirName && x.theirName !== x.name ? `<div class="field__hint">У відомості частини: ${esc(x.theirName)}
            <button type="button" class="btn btn--sm" data-mtz-take="${esc(x.theirName)}">Взяти цю назву</button></div>` : ''}</div>
        <div class="field"><label>Одиниця виміру</label>
          <select name="unit"><option value="">— оберіть —</option>${opt(MTZ_UNITS, x.unit)}</select></div>
        <div class="field"><label>Група ОВТ, МТЗ</label><select name="group">${opt(MTZ_GROUPS, x.group)}</select></div>
        <div class="field field--span"><label>Примітка</label>
          <input name="note" value="${esc(x.note)}" list="mtz-notes" autocomplete="off">
          <datalist id="mtz-notes"><option value="${esc(MTZ_IN_KIND)}"></datalist></div>
      </div><div class="pad" style="padding-top:14px">
        <button class="btn btn--primary" type="submit">Зберегти</button>
        <button class="btn" type="button" data-md="close">Скасувати</button></div></form>`);
    el.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const name = String(f.get('name') || '').trim().replace(/\s+/g, ' ');
      mtzSet(key, 'name', name === base ? '' : name);
      mtzSet(key, 'unit', f.get('unit') === mtzUnitOf(x.uom) ? '' : f.get('unit'));
      mtzSet(key, 'group', f.get('group') === MTZ_GROUP ? '' : f.get('group'));
      mtzSet(key, 'note', String(f.get('note') || '').trim());
      save();
      modalClose();
      render();
    });
    const nameIn = el.querySelector('input[name="name"]');
    el.querySelector('[data-mtz-take]')?.addEventListener('click', (e) => { nameIn.value = e.currentTarget.dataset.mtzTake; nameIn.focus(); });
    nameIn.focus();
  }

  /** Відомість у формі вищого штабу: рядки служби за рік до звітного місяця включно. */
  function mtzExcel() {
    const ym = mtzMonth();
    const rows = mtzRows(ym.slice(0, 4), monthEnd(ym));
    const list = rows.filter(mtzIn);
    if (!list.length) { toast('У відомість нічого не входить: надходженням не вказано джерело.', true); return; }
    const asOf = mtzAsOf(ym);
    const code = unitCode();
    const chief = signer(officialAt('начальник служби', asOf), asOf);
    const force = MTZ_FORCE[mtzBelongs()];
    toExcel({ kind: 'mtz', file: `МТЗ ${code} ${MTZ_SERVICE} на ${asOf}`.replace(/\s+/g, ' '),
      title: ['ВІДОМІСТЬ', `закуплених (отриманих) матеріально-технічних засобів ${unitGen()}${force ? ' ' + force : ''} станом на ${fmtDate(asOf)} року`,
        `${MTZ_SERVICE}, за ${mtzSpan(ym)}`],
      rows: list.map((x) => [MTZ_SERVICE, x.group, x.name, x.unit, x.q, x.price, code, mtzBelongs(), x.kpkv, x.kekv, x.src, x.note]),
      total: `Всього за продовольчу службу ${unitGen()}:`,
      signs: [{ pos: `Начальник продовольчої служби ${unitGen()}`, rank: chief.rank, name: chief.name }] });
    const bare = rows.filter((x) => !x.src).length;
    const bad = list.filter((x) => mtzIssues(x).length).length;
    if (bare || bad) toast([bare ? `без джерела ${bare}, у відомість вони не потрапили` : '', bad ? `із зауваженнями ${bad}` : '']
      .filter(Boolean).join('; ').replace(/^./, (c) => c.toUpperCase()) + '.', true);
  }

  function mtzAction(act, d) {
    switch (act) {
      case 'mtz-xls': return mtzExcel();
      case 'mtz-file': return mtzPick();
      case 'mtz-edit': return mtzEdit(d.key);
      default: return null;
    }
  }
  /** Бюджетні реквізити лишаються лише за надходженнями, що є в обліку: після скидання
   *  внесеного чи відновлення з файла решта не має чекати документа з тим самим id. */
  function mtzPrune() {
    const kept = new Set(((store.docs || {}).incoming || []).map((r) => String(rowId('in', r) || '')));
    const rows = mtzStore().rows;
    for (const key of Object.keys(rows)) if (!kept.has(key.slice(0, key.indexOf('|')))) delete rows[key];
  }

  // ================================================================ ЗАКУПІВЛІ
  /** Надходження ззовні за довільний період із бюджетними реквізитами: що надійшло, на яку
   *  суму, за якими КПКВ і КЕКВ, за рахунок чого. Рядок — позиція документа надходження,
   *  той самий запис store.mtz.rows («id документа|код»), що й у відомості МТЗ: КПКВ і КЕКВ
   *  спільні. Тут до них додаються джерело фінансування (`fund`; для «Інше» — уточнення
   *  `fundNote`), код видатків (`exp`), примітка (`pnote`) і частки (`parts`) — коли позицію
   *  віднесено до кількох джерел: сума часток дорівнює сумі позиції. Це вартість за
   *  документами надходження, а не підтверджені оплати. */
  const PUR_FUNDS = ['Субвенція', '10% ПДФО', 'Забезпечення', 'Благодійна допомога', 'Інше'];
  const PUR_OTHER = 'Інше';
  // Старе позначення «ПДФО» відомості МТЗ не каже, який це ПДФО: так і показуємо, доки не уточнять.
  const PUR_PDFO = 'ПДФО — вид не уточнено';
  const PUR_FUND_OF_SRC = { 'С': 'Субвенція', 'БД': 'Благодійна допомога', 'ПДФО': PUR_PDFO };
  const PUR_NONE = '∅';                                  // значення фільтра «не вказано»
  const PUR_CUTS = [['fund', 'джерело'], ['kekv', 'КЕКВ'], ['kpkv', 'КПКВ'], ['exp', 'код видатків'], ['all', 'усе разом']];
  const PUR_CUT_FIELDS = { fund: ['fund'], kekv: ['kekv'], kpkv: ['kpkv'], exp: ['exp'], all: ['fund', 'kpkv', 'kekv', 'exp'] };
  const PUR_FIELD_NAME = { fund: 'Джерело', kpkv: 'КПКВ', kekv: 'КЕКВ', exp: 'Код видатків' };
  const purKop = (x) => Math.round((+x || 0) * 100);
  /** Сума рядка надходження в копійках: кількість у тисячних × ціна в копійках, округлення до копійки. */
  const purLineKop = (q, price) => Math.round(Math.round((+q || 0) * 1000) * Math.round((+price || 0) * 100) / 1000);
  const purCarry = mtzCarry;                             // перенос залишків — не надходження, як і у відомості МТЗ
  const purFundOf = (a) => (a && (a.fund || PUR_FUND_OF_SRC[a.src])) || '';

  /** Довідник джерел: початкові значення, додані в програмі й ті, що вже стоять у рядках. */
  function purFunds() {
    const m = mtzStore();
    const own = Array.isArray(m.funds) ? m.funds.map((s) => String(s || '').trim()).filter(Boolean) : [];
    const used = [];
    for (const a of Object.values(m.rows)) {
      if (a.fund) used.push(a.fund);
      for (const p of Array.isArray(a.parts) ? a.parts : []) if (p && p.fund) used.push(p.fund);
    }
    return [...new Set(PUR_FUNDS.slice(0, 2).concat([PUR_PDFO], PUR_FUNDS.slice(2), own, used))];
  }
  /** Частки позиції: дійсні, коли їх дві й більше і разом вони дають суму позиції до копійки. */
  function purParts(a, sum) {
    const list = a && Array.isArray(a.parts) ? a.parts.filter((p) => p && typeof p === 'object') : [];
    if (list.length < 2) return null;
    return list.reduce((s, p) => s + purKop(p.sum), 0) === purKop(sum) ? list : null;
  }

  /** Позиції надходжень ззовні, за потреби — у межах дат включно. Позиція з частками — рядок
   *  на кожну частку; з частками, що не дають її суми, — один рядок із позначкою. */
  function purRows(from = '', to = '') {
    const saved = mtzStore().rows;
    const by = new Map();
    for (const r of docs) {
      if (r.kind !== 'in' || !r.id || purCarry(r)) continue;
      if ((from && r.d < from) || (to && r.d > to)) continue;
      const key = `${r.id}|${r.code}`;
      const kop = purLineKop(r.q, r.price);
      const x = by.get(key);
      if (x) { x.q = round3(x.q + r.q); x.kop += kop; if (Math.abs(x.price - r.price) > 0.004) x.mixed = true; continue; }
      by.set(key, { key, doc: keyOfRow(r), d: r.d, no: r.no, from: r.from, t: r.t, id: r.id, code: r.code, q: r.q,
        price: r.price, kop, mixed: false });
    }
    const out = [];
    const sorted = [...by.values()].sort((a, b) => a.d.localeCompare(b.d) || a.id - b.id
      || String(a.code).localeCompare(String(b.code), 'uk', { numeric: true }));
    for (const x of sorted) {
      const a = saved[x.key] || {};
      const it = itemBy.get(x.code) || {};
      const total = x.kop / 100;
      const base = { key: x.key, doc: x.doc, d: x.d, no: x.no, from: x.from || '', t: x.t || '', id: x.id, code: x.code, q: x.q,
        price: x.mixed && x.q ? round2(total / x.q) : x.price, mixed: x.mixed, total, name: cleanName(it.name || x.code),
        uom: it.unit || '', note: a.pnote || '' };
      const parts = purParts(a, total);
      if (parts) {
        parts.forEach((p, i) => out.push(Object.assign({}, base, { rid: `${x.key}#${i}`, part: i + 1, of: parts.length,
          sum: purKop(p.sum) / 100, fund: p.fund || '', fundNote: p.fundNote || '', kpkv: p.kpkv || '', kekv: p.kekv || '',
          exp: p.exp || '' })));
      } else {
        out.push(Object.assign(base, { rid: x.key, part: 0, of: 0, sum: total, fund: purFundOf(a), fundNote: a.fundNote || '',
          kpkv: a.kpkv || '', kekv: a.kekv || '', exp: a.exp || '', badParts: Array.isArray(a.parts) && a.parts.length > 0 }));
      }
    }
    return out;
  }

  /** Реквізит позиції. Джерело веде за собою позначення відомості МТЗ: субвенція — «С», благодійна
   *  допомога — «БД», ПДФО — «ПДФО»; решта джерел у відомість МТЗ не входить. КПКВ, КЕКВ і код
   *  видатків пишуться як уведено: нулі попереду й розділювачі — частина коду. */
  function purSet(key, field, v) {
    const val = String(v ?? '').trim();
    if (field !== 'fund') return mtzSet(key, field, val);
    const fund = val === PUR_PDFO ? '' : val;
    mtzSet(key, 'fund', fund);
    if (fund !== PUR_OTHER) mtzSet(key, 'fundNote', '');
    return mtzSet(key, 'src', !val ? '' : val === PUR_PDFO ? 'ПДФО' : MTZ_SRC_OF_FUND[val] || '-');
  }
  /** Реквізит частки; перша частка — ще й реквізити самої позиції: їх бере відомість МТЗ. */
  function purSetPart(key, i, field, v) {
    const a = mtzStore().rows[key];
    const p = a && Array.isArray(a.parts) ? a.parts[i] : null;
    if (!p) return;
    const val = String(v ?? '').trim();
    if (val) p[field] = val; else delete p[field];
    if (field === 'fund' && val !== PUR_OTHER) delete p.fundNote;
    if (i === 0) purSet(key, field, val);
  }
  /** Зміна в рядку реєстру. Джерело й КПКВ у папері зазвичай одні на весь прихід: позиції того
   *  самого документа, де їх ще немає, беруть те саме — і далі правляться кожна окремо. */
  function purEdit(rid, field, v) {
    const [key, part] = String(rid).split('#');
    if (part != null) return purSetPart(key, +part, field, v);
    purSet(key, field, v);
    const val = String(v ?? '').trim();
    if (val && (field === 'fund' || field === 'kpkv')) {
      const id = key.split('|')[0];
      for (const x of purRows()) if (String(x.id) === id && x.key !== key && !x.part && !x.badParts && !x[field]) purSet(x.key, field, val);
    }
    return null;
  }
  /** Частки позиції цілком: одна частка — це звичайні реквізити позиції, без поділу. */
  function purSaveParts(key, parts, note) {
    const clean = parts.map((p) => {
      const o = { sum: purKop(p.sum) / 100 };
      for (const f of ['fund', 'fundNote', 'kpkv', 'kekv', 'exp']) { const s = String(p[f] ?? '').trim(); if (s) o[f] = s; }
      if (o.fund !== PUR_OTHER) delete o.fundNote;
      return o;
    });
    const first = clean[0] || {};
    // Джерело, якого не міняли, не чіпаємо: інакше зникла б позначка «не входить» відомості МТЗ.
    if ((first.fund || '') !== purFundOf(mtzStore().rows[key])) purSet(key, 'fund', first.fund || '');
    for (const f of ['kpkv', 'kekv', 'exp']) purSet(key, f, first[f] || '');
    mtzSet(key, 'fundNote', first.fund === PUR_OTHER ? first.fundNote || '' : '');
    mtzSet(key, 'pnote', note);
    const rows = mtzStore().rows;
    if (clean.length > 1) rows[key] = Object.assign({}, rows[key] || {}, { parts: clean });
    else if (rows[key]) { delete rows[key].parts; if (!Object.keys(rows[key]).length) delete rows[key]; }
  }

  /** Підсумок відбору: сума, позицій і документів. Кількість різного майна не складається. */
  function purTotal(rows) {
    return { sum: rows.reduce((s, x) => s + purKop(x.sum), 0) / 100, docs: new Set(rows.map((x) => x.id)).size,
      items: new Set(rows.map((x) => x.key)).size };
  }
  /** Групи відбору за полями (джерело, КЕКВ, КПКВ, код видатків або всі разом). */
  function purGroups(rows, fields) {
    const by = new Map();
    for (const x of rows) {
      const vals = fields.map((f) => x[f] || '');
      const k = vals.join('\u0001');
      const g = by.get(k) || { vals, kop: 0, docs: new Set(), items: new Set() };
      g.kop += purKop(x.sum); g.docs.add(x.id); g.items.add(x.key);
      by.set(k, g);
    }
    // Не вказане — наприкінці: спершу те, що вже віднесено.
    const ord = (v) => (v ? '0' + v : '1');
    return [...by.values()].map((g) => ({ vals: g.vals, sum: g.kop / 100, docs: g.docs.size, items: g.items.size }))
      .sort((a, b) => a.vals.map(ord).join('\u0001').localeCompare(b.vals.map(ord).join('\u0001'), 'uk', { numeric: true }));
  }
  /** Чого бракує рядку до повних бюджетних реквізитів. */
  function purIssues(x) {
    const out = [];
    if (x.badParts) out.push('частки не дають суми позиції');
    if (!x.fund) out.push('немає джерела');
    if (x.fund === PUR_OTHER && !x.fundNote) out.push('джерело «Інше» без уточнення');
    if (!x.kpkv) out.push('немає КПКВ');
    if (!x.kekv) out.push('немає КЕКВ');
    return out;
  }
  const purPeriodText = (from, to) => (from && to ? `з ${fmtDate(from)} по ${fmtDate(to)}` : from ? `з ${fmtDate(from)}`
    : to ? `по ${fmtDate(to)}` : 'за весь час');

  /** Книга Excel із того самого відбору, що на екрані: деталізація й підсумки за розрізами. */
  function purSheets(rows, period, filters = '') {
    const t = purTotal(rows);
    const top = [unitInfo().legalName, unitInfo().serviceFull].filter(Boolean);
    const lines = ['Вартість за документами надходження; це не підтверджені оплати.'].concat(filters ? [`Відбір: ${filters}`] : []);
    const detail = rows.map((x, i) => [i + 1, x.d, `${x.t} №${x.no}`.trim(), x.from, x.code,
      x.name + (x.part ? ` (частка ${x.part} з ${x.of})` : ''), x.uom, x.part > 1 ? '' : x.q, x.part > 1 ? '' : x.price, x.sum,
      x.kekv, x.kpkv, x.exp, x.fund + (x.fundNote ? `: ${x.fundNote}` : ''), x.note]);
    const sheets = [{
      name: 'Закупівлі', orientation: 'landscape', top, title: 'Надходження технічних засобів і майна',
      subtitle: purPeriodText(period.from, period.to), lines,
      head: [['№', 'Дата', 'Документ', 'Постачальник', 'Код', 'Найменування', 'Од.', 'Кількість', 'Ціна, грн', 'Сума, грн',
        'КЕКВ', 'КПКВ', 'Код видатків', 'Джерело', 'Примітка']],
      widths: [5, 11, 20, 24, 8, 40, 6, 10, 12, 14, 8, 13, 13, 22, 20], rows: detail, num: [7], money: [8, 9],
      total: ['', '', '', '', '', `Разом: документів ${t.docs}, позицій ${t.items}`, '', '', '', t.sum, '', '', '', '', ''],
    }];
    const cut = (name, fields) => {
      const groups = purGroups(rows, fields);
      sheets.push({ name, orientation: 'portrait', top, title: `Надходження: ${name.toLowerCase()}`,
        subtitle: purPeriodText(period.from, period.to), lines,
        head: [fields.map((f) => PUR_FIELD_NAME[f]).concat(['Документів', 'Позицій', 'Сума, грн'])],
        widths: fields.map((f) => (f === 'fund' ? 30 : 16)).concat([12, 10, 16]),
        rows: groups.map((g) => g.vals.map((v) => v || 'не вказано').concat([g.docs, g.items, g.sum])),
        num: [fields.length, fields.length + 1], money: [fields.length + 2],
        total: ['Разом'].concat(Array(fields.length - 1).fill(''), [t.docs, t.items, t.sum]) });
    };
    cut('Підсумок', PUR_CUT_FIELDS.all);
    cut('За джерелом', ['fund']);
    cut('За КЕКВ', ['kekv']);
    cut('За КПКВ', ['kpkv']);
    cut('За кодом видатків', ['exp']);
    return sheets;
  }

  function purSpec(rows) {
    const funds = purFunds();
    const opts = (list, v) => '<option value="">—</option>' + list.concat(v && !list.includes(v) ? [v] : [])
      .map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('');
    const uniq = (f) => [...new Set(rows.map((x) => x[f]).filter(Boolean))]
      .sort((a, b) => String(a).localeCompare(String(b), 'uk', { numeric: true }));
    const sel = (key, label) => ({ type: 'select', key, label, all: 'усі',
      options: uniq(key).map((v) => [v, v]).concat([[PUR_NONE, 'не вказано']]),
      test: (x, v) => (v === PUR_NONE ? !x[key] : x[key] === v) });
    const inp = (x, f, label, list, w) => `<input class="rc-in rc-in--wide" style="width:${w}px;text-align:left" list="${list}"
      data-pur="${f}" data-rid="${esc(x.rid)}" value="${esc(x[f])}" aria-label="${label}" autocomplete="off">`;
    return {
      id: 'pur', rows, minWidth: '1040px', limit: REG_LIMIT, acts: '92px',
      placeholder: 'Пошук: назва, код, документ, постачальник',
      search: (x) => [x.code, x.name, x.no, x.from, x.fund, x.fundNote, x.kpkv, x.kekv, x.exp, x.note],
      filters: [
        { type: 'period', key: 'd', label: 'надійшло', get: (x) => x.d },
        sel('fund', 'джерело'), sel('kpkv', 'КПКВ'), sel('kekv', 'КЕКВ'), sel('exp', 'код видатків'),
        { type: 'toggle', key: 'bare', label: 'без джерела чи кодів', title: 'Позиції, де не вказано джерело, КПКВ або КЕКВ',
          test: (x) => !x.fund || !x.kpkv || !x.kekv },
      ],
      columns: [
        { key: 'doc', label: 'документ', cls: 'c-name c-name--stack', style: 'flex:0 1 140px', first: 1, sort: (x) => `${x.d}|${x.no}`,
          cellTitle: (x) => `${x.t} ${numNo(x.no)} від ${fmtDate(x.d)}, ${x.from || '—'}`,
          cell: (x) => `<b class="lnk" data-open="${esc(x.doc)}">${esc(numNo(x.no))}</b><small>${fmtDate(x.d)}</small>
            <small style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.from || '—')}</small>` },
        { key: 'name', label: 'найменування', cls: 'c-name c-name--stack', style: 'flex:2 1 210px', first: 1, sort: (x) => x.name,
          cellTitle: (x) => [x.name, ...purIssues(x)].join('; '),
          cell: (x) => `<b>${esc(x.name)}</b><small>${esc([x.code, x.uom, x.part ? `частка ${x.part} з ${x.of}` : '',
            x.badParts ? 'частки не дають суми позиції' : '', x.fund === PUR_OTHER ? x.fundNote : '', x.note].filter(Boolean).join(' · '))}</small>` },
        { key: 'q', label: 'к-сть', cls: 'c-num', style: 'width:56px', sort: (x) => x.q, cell: (x) => (x.part > 1 ? '' : fmtNum(x.q)) },
        { key: 'sum', label: 'сума, грн', cls: 'c-num', style: 'width:104px', sort: (x) => x.sum, title: 'Сума й ціна за одиницю',
          cell: (x) => `${fmtMoney(x.sum)}<small>${x.part ? `із ${fmtMoney(x.total)}` : `по ${fmtMoney(x.price)}`}</small>` },
        { key: 'fund', label: 'джерело', cls: 'c-txt', style: 'flex:0 0 150px', first: 1, sort: (x) => x.fund || '~',
          cell: (x) => `<select data-pur="fund" data-rid="${esc(x.rid)}" aria-label="джерело фінансування" style="width:100%">${opts(funds, x.fund)}</select>` },
        { key: 'kpkv', label: 'КПКВ', cls: 'c-txt', style: 'flex:0 0 100px', first: 1, sort: (x) => x.kpkv || '~',
          cell: (x) => inp(x, 'kpkv', 'КПКВ', 'pur-kpkv', 88) },
        { key: 'kekv', label: 'КЕКВ', cls: 'c-txt', style: 'flex:0 0 62px', first: 1, sort: (x) => x.kekv || '~',
          cell: (x) => inp(x, 'kekv', 'КЕКВ', 'pur-kekv', 50) },
        { key: 'exp', label: 'код видатків', cls: 'c-txt', style: 'flex:0 0 96px', first: 1, sort: (x) => x.exp || '~',
          cell: (x) => inp(x, 'exp', 'код видатків', 'pur-exp', 84) },
        { key: 'acts', label: '', cls: 'c-acts', cell: (x) => rowBtn('pur-edit', '✎ Докладно',
          `data-key="${esc(x.key)}"`, { title: 'Уточнення джерела, примітка, поділ суми на частки' }) },
      ],
      row: (x) => ({ cls: x.badParts || !x.fund ? 'is-due' : '' }),
      total: (shown) => ({ name: '<b>Разом за відбором</b>', sum: fmtMoney(purTotal(shown).sum) }),
      count: (shown) => { const t = purTotal(shown);
        return `${cnt(t.items, 'позиція', 'позиції', 'позицій')} у ${cnt(t.docs, 'документі', 'документах', 'документах')} на ${fmtMoney(t.sum)} грн`; },
      empty: 'Надходжень ззовні ще немає.',
      emptyFiltered: 'За цим періодом і фільтрами надходжень немає.',
    };
  }
  /** Перший показ — поточний рік; далі період тримає те, що вибрала людина. */
  function purInit() {
    if (state.purInit) return;
    state.purInit = true;
    const f = tfOf('pur');
    if (!f.dFrom && !f.dTo) f.dFrom = `${today().slice(0, 4)}-01-01`;
  }
  /** Слова про відбір — у шапку книги Excel: за чим саме відібрано рядки. */
  function purFilterText() {
    const f = tfOf('pur');
    const v = (k, label) => (f[k] ? `${label} — ${f[k] === PUR_NONE ? 'не вказано' : f[k]}` : '');
    return [v('fund', 'джерело'), v('kpkv', 'КПКВ'), v('kekv', 'КЕКВ'), v('exp', 'код видатків'),
      f.bare ? 'без джерела чи кодів' : '', (f.q || '').trim() ? `пошук «${f.q.trim()}»` : ''].filter(Boolean).join('; ');
  }

  function renderPurchases() {
    purInit();
    const rows = purRows();
    const reg = registry(purSpec(rows));
    const cutKey = PUR_CUT_FIELDS[state.purCut] ? state.purCut : 'fund';
    const fields = PUR_CUT_FIELDS[cutKey];
    const groups = purGroups(reg.shown, fields);
    const used = (f, base = []) => [...new Set(base.concat(rows.map((x) => x[f]).filter(Boolean)))];
    const cutTable = `<div class="tbl" style="--tbl-min:auto"><div class="tbl__head">${fields.map((f) =>
      `<div class="tbl__h c-txt" style="flex:1 1 120px">${esc(PUR_FIELD_NAME[f].toLowerCase())}</div>`).join('')}
        <div class="tbl__h c-num" style="width:90px">документів</div><div class="tbl__h c-num" style="width:80px">позицій</div>
        <div class="tbl__h c-num" style="width:130px">сума, грн</div></div>${groups.map((g) => `<div class="tbl__row tbl__row--plain">${
      g.vals.map((v) => `<div class="c-txt${v ? '' : ' num-warn'}" style="flex:1 1 120px">${esc(v || 'не вказано')}</div>`).join('')}
        <div class="c-num" style="width:90px">${g.docs}</div><div class="c-num" style="width:80px">${g.items}</div>
        <div class="c-num" style="width:130px">${fmtMoney(g.sum)}</div></div>`).join('')}</div>`;
    const t = purTotal(reg.shown);
    return {
      fill: true,
      head: head('контроль / закупівлі', 'Закупівлі', '<button class="btn btn--primary" data-act="pur-xls">В Excel</button>'),
      body: `${flashBlock()}${reg.panel}
        <details class="fold card" style="margin-bottom:12px" data-pur-fold${state.purFold ? ' open' : ''}>
          <summary class="card__head"><div class="card__title">Підсумки відбору</div>
            <span class="fold__hint">${fmtMoney(t.sum)} грн · за джерелом, КЕКВ, КПКВ, кодом видатків</span></summary>
          ${state.purFold ? `<div class="panel"><div class="seg">${PUR_CUTS.map(([k, label]) =>
      `<button type="button" data-act="pur-cut" data-v="${k}"${k === cutKey ? ' class="is-on"' : ''}>${esc(label)}</button>`).join('')}</div></div>
          ${reg.shown.length ? cutTable : ''}` : ''}</details>
        <div class="card card--scroll card--fill">${reg.table}</div>
        <datalist id="pur-kpkv">${used('kpkv', MTZ_KPKV).map((k) => `<option value="${esc(k)}">`).join('')}</datalist>
        <datalist id="pur-kekv">${used('kekv', MTZ_KEKV).map((k) => `<option value="${esc(k)}">`).join('')}</datalist>
        <datalist id="pur-exp">${used('exp').map((k) => `<option value="${esc(k)}">`).join('')}</datalist>`,
    };
  }

  function bindPurchases() {
    if (state.view !== 'purch') return;
    const sc = $('#scroll');
    sc.querySelectorAll('[data-pur]').forEach((el) => el.addEventListener('change', () => {
      purEdit(el.dataset.rid, el.dataset.pur, el.value);
      save();
      // Табуляція вже перевела фокус у наступне поле: після перемальовування повертаємо його туди ж.
      const at = document.activeElement;
      const back = at && at.dataset && at.dataset.pur ? [at.dataset.pur, at.dataset.rid] : null;
      render();
      if (back) {
        const again = [...$('#scroll').querySelectorAll(`[data-pur="${back[0]}"]`)].find((x) => x.dataset.rid === back[1]);
        if (again) again.focus();
      }
    }));
    // Підсумки малюються лише розгорнутими: згорнута картка не тримає в сторінці прихованої таблиці.
    sc.querySelector('[data-pur-fold]')?.addEventListener('toggle', (e) => {
      if (!!state.purFold === e.target.open) return;
      state.purFold = e.target.open;
      render();
    });
  }

  /** Реквізити позиції цілком: джерело з уточненням, коди, примітка й поділ суми на частки. */
  function purDialog(key) {
    const rows = purRows().filter((x) => x.key === key);
    if (!rows.length) return;
    const x = rows[0];
    const a = mtzStore().rows[key] || {};
    // Частки, що вже не дають суми позиції (документ виправили), показуємо як є: людина їх і поправить.
    let parts = Array.isArray(a.parts) && a.parts.length > 1
      ? a.parts.map((p) => ({ sum: purKop(p.sum) / 100, fund: p.fund || '', fundNote: p.fundNote || '', kpkv: p.kpkv || '', kekv: p.kekv || '', exp: p.exp || '' }))
      : [{ sum: x.total, fund: x.fund, fundNote: x.fundNote, kpkv: x.kpkv, kekv: x.kekv, exp: x.exp }];
    const el = modalOpen(`${numNo(x.no)} від ${fmtDate(x.d)} · ${x.code}`, `<form id="pur-form">
      <div class="panel"><div class="panel__note"><b>${esc(x.name)}</b> — ${fmtNum(x.q)} ${esc(x.uom)} на ${fmtMoney(x.total)} грн</div></div>
      <div data-pur-parts></div>
      <div class="pad" style="padding-top:10px">
        <button class="btn btn--sm" type="button" data-pur-add title="Позицію оплачено з кількох джерел або за кількома кодами">+ Частка</button>
        <button class="btn btn--sm" type="button" data-pur-fund-new>Нове джерело…</button>
        <span class="panel__count" data-pur-sum></span></div>
      <div class="form__grid" style="padding-top:10px"><div class="field field--span"><label>Примітка</label>
        <input name="note" value="${esc(x.note)}" autocomplete="off"></div></div>
      <div class="pad" data-pur-msg hidden style="padding-top:10px;color:var(--bad)"></div>
      <div class="pad" style="padding-top:14px">
        <button class="btn btn--primary" type="submit">Зберегти</button>
        <button class="btn" type="button" data-md="close">Скасувати</button></div></form>`);
    const box = el.querySelector('[data-pur-parts]');
    const read = () => [...box.querySelectorAll('[data-part]')].map((row) => {
      const g = (n) => row.querySelector(`[name="${n}"]`);
      return { sum: parseFloat(String(g('sum').value).replace(',', '.')) || 0, fund: g('fund').value, fundNote: g('fundNote') ? g('fundNote').value : '',
        kpkv: g('kpkv').value, kekv: g('kekv').value, exp: g('exp').value };
    });
    const sumLine = () => {
      const got = parts.reduce((s, p) => s + purKop(p.sum), 0);
      const out = el.querySelector('[data-pur-sum]');
      out.textContent = parts.length > 1 ? `частки разом ${fmtMoney(got / 100)} із ${fmtMoney(x.total)} грн` : '';
      out.className = 'panel__count' + (parts.length > 1 && got !== purKop(x.total) ? ' num-bad' : '');
    };
    const draw = () => {
      const funds = purFunds();
      const many = parts.length > 1;
      box.innerHTML = parts.map((p, i) => `<div class="form__grid" data-part="${i}" style="padding-top:8px">
        ${many ? `<div class="field"><label>Частка ${i + 1}, грн</label>
          <input name="sum" type="number" step="0.01" min="0" value="${esc(p.sum)}"></div>` : `<input name="sum" type="hidden" value="${esc(p.sum)}">`}
        <div class="field"><label>Джерело</label><select name="fund"><option value="">—</option>${
          funds.concat(p.fund && !funds.includes(p.fund) ? [p.fund] : []).map((o) => `<option${o === p.fund ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></div>
        ${p.fund === PUR_OTHER ? `<div class="field"><label>Уточнення джерела</label>
          <input name="fundNote" value="${esc(p.fundNote)}" autocomplete="off"></div>` : ''}
        <div class="field"><label>КПКВ</label><input name="kpkv" list="pur-kpkv" value="${esc(p.kpkv)}" autocomplete="off"></div>
        <div class="field"><label>КЕКВ</label><input name="kekv" list="pur-kekv" value="${esc(p.kekv)}" autocomplete="off"></div>
        <div class="field"><label>Код видатків</label><input name="exp" list="pur-exp" value="${esc(p.exp)}" autocomplete="off"></div>
        ${many ? `<div class="field" style="align-self:end"><button class="btn btn--sm" type="button" data-pur-del="${i}">✕ Прибрати частку</button></div>` : ''}
      </div>`).join('');
      sumLine();
    };
    draw();
    box.addEventListener('change', (e) => { parts = read(); if (e.target.name === 'fund') draw(); else sumLine(); });
    box.addEventListener('input', (e) => { if (e.target.name === 'sum') { parts = read(); sumLine(); } });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pur-del]');
      if (!b) return;
      parts = read();
      parts.splice(+b.dataset.purDel, 1);
      // Лишилась одна частка — це знову вся позиція.
      if (parts.length === 1) parts[0].sum = x.total;
      draw();
    });
    el.querySelector('[data-pur-add]').addEventListener('click', () => {
      parts = read();
      const rest = (purKop(x.total) - parts.reduce((s, p) => s + purKop(p.sum), 0)) / 100;
      parts.push({ sum: Math.max(rest, 0), fund: '', fundNote: '', kpkv: '', kekv: '', exp: '' });
      draw();
    });
    el.querySelector('[data-pur-fund-new]').addEventListener('click', () => {
      const name = String(prompt('Назва джерела фінансування') || '').trim().replace(/\s+/g, ' ');
      if (!name) return;
      const m = mtzStore();
      if (!purFunds().includes(name)) m.funds = (Array.isArray(m.funds) ? m.funds : []).concat([name]);
      parts = read();
      draw();
    });
    el.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      parts = read();
      const bad = [];
      if (parts.length > 1) {
        parts.forEach((p, i) => { if (!(purKop(p.sum) > 0)) bad.push(`Частка ${i + 1}: не вказано суму.`); });
        const got = parts.reduce((s, p) => s + purKop(p.sum), 0);
        if (!bad.length && got !== purKop(x.total)) bad.push(`Сума часток ${fmtMoney(got / 100)} грн не дорівнює сумі позиції ${fmtMoney(x.total)} грн.`);
      }
      parts.forEach((p, i) => { if (p.fund === PUR_OTHER && !String(p.fundNote || '').trim()) {
        bad.push(`${parts.length > 1 ? `Частка ${i + 1}: д` : 'Д'}ля джерела «Інше» потрібне уточнення.`); } });
      const msg = el.querySelector('[data-pur-msg]');
      if (bad.length) { msg.hidden = false; msg.innerHTML = bad.map(esc).join('<br>'); return; }
      purSaveParts(key, parts, String(new FormData(e.target).get('note') || '').trim());
      modalClose();
      render();
      saveThen('Реквізити позиції збережено.');
    });
  }

  /** Те саме, що на екрані, — у книгу Excel: відбір з урахуванням пошуку, без обмеження видимих рядків. */
  function purExcel() {
    const shown = regRows(purSpec(purRows()));
    if (!shown.length) { toast('За цим періодом і фільтрами надходжень немає.', true); return; }
    const f = tfOf('pur');
    const period = { from: f.dFrom || '', to: f.dTo || '' };
    toExcel({ file: `Закупівлі ${purPeriodText(period.from, period.to)}`, sheets: purSheets(shown, period, purFilterText()) });
  }

  function purAction(act, d) {
    switch (act) {
      case 'pur-xls': return purExcel();
      case 'pur-edit': return purDialog(d.key);
      case 'pur-cut': state.purCut = d.v; state.purFold = true; return render();
      default: return null;
    }
  }

  // ============================================================== ТОЧНІ ЧИСЛА
  /** Гроші й коефіцієнти відомості залишкової вартості рахуються точно, без двійкових дробів:
   *  число — ціле (BigInt) і кількість знаків після коми. Порожнє й нечислове — null: нуль,
   *  порожнє поле і «не застосовується» — різні речі. */
  const decOf = (v) => {
    if (v == null || typeof v === 'object') return null;
    const t = String(v).trim().replace(/[\s ]/g, '').replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    const neg = t[0] === '-';
    const [a, b = ''] = (neg ? t.slice(1) : t).split('.');
    const frac = b.replace(/0+$/, '');
    const n = BigInt(a + frac);
    return { n: neg ? -n : n, s: frac.length };
  };
  const decPow = (k) => 10n ** BigInt(k);
  const decMul = (x, y) => ({ n: x.n * y.n, s: x.s + y.s });
  const decAdd = (x, y) => { const s = Math.max(x.s, y.s); return { n: x.n * decPow(s - x.s) + y.n * decPow(s - y.s), s }; };
  const decSub = (x, y) => decAdd(x, { n: -y.n, s: y.s });
  const decCmp = (x, y) => { const d = decSub(x, y).n; return d < 0n ? -1 : d > 0n ? 1 : 0; };
  /** Округлення до d знаків; половина — від нуля, як ROUND в Excel. */
  const decRound = (x, d) => {
    if (x.s <= d) return x;
    const k = decPow(x.s - d);
    const neg = x.n < 0n, a = neg ? -x.n : x.n;
    const n = a / k + ((a % k) * 2n >= k ? 1n : 0n);
    return { n: neg ? -n : n, s: d };
  };
  /** Рядок із крапкою: точний (без зайвих нулів) або з рівно d знаками після округлення. */
  const decStr = (x, d = null) => {
    const y = d == null ? x : decRound(x, d);
    const neg = y.n < 0n;
    let t = (neg ? -y.n : y.n).toString();
    const s = d == null ? y.s : d;
    if (d != null && y.s < d) t += '0'.repeat(d - y.s);
    if (s > 0) { t = t.padStart(s + 1, '0'); t = `${t.slice(0, -s)}.${t.slice(-s)}`; }
    if (d == null && s > 0) t = t.replace(/\.?0+$/, '');
    return (neg && /[1-9]/.test(t) ? '-' : '') + t;
  };
  /** Як пишуть у папері: «16 212,96», «0,648». */
  const decUa = (x, d = null) => { const [a, b] = decStr(x, d).split('.'); return a.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (b ? `,${b}` : ''); };

  // ============================================== НОРМАТИВИ ЗАЛИШКОВОЇ ВАРТОСТІ
  /** Версійований довідник розрахунку залишкової вартості майна продовольчої служби: Методика,
   *  затверджена постановою КМУ від 29.05.1998 № 759 (у редакції постанови від 30.12.2015 № 1158), —
   *  пункти 5–11 і пункт 21 додатка 3 з таблицями 26 і 27, як у тексті на zakon.rada.gov.ua.
   *  Пункт 21 і таблиці однакові в редакціях від 23.08.2016 до 25.04.2026 (звірено 03.10.2026);
   *  редакції різняться пунктом 10. Оновлення довідника не перераховує затверджених відомостей:
   *  розрахунок рядка зберігає редакцію, параметри, коефіцієнти й результат. */
  const VAL_NORMS = {
    id: 'КМУ-759 / звірено 03.10.2026',
    act: 'Методика визначення залишкової вартості майна Збройних Сил України та інших військових формувань, затверджена постановою Кабінету Міністрів України від 29.05.1998 № 759',
    url: 'https://zakon.rada.gov.ua/laws/show/759-98-п',
    checked: '2026-10-03',
    // Редакції — за датою набрання чинності змін до пункту 10 (постанови КМУ 2026 року № 431 і № 515).
    editions: [
      { id: '2016-08-23', from: '', p10: '', title: 'редакція, чинна до 10.04.2026' },
      { id: '2026-04-10', from: '2026-04-10', p10: 'plain', title: 'редакція від 10.04.2026 (зміни постановою КМУ від 01.04.2026 № 431)' },
      { id: '2026-04-25', from: '2026-04-25', p10: 'except',
        title: 'редакція від 25.04.2026 (зміни постановами КМУ від 01.04.2026 № 431 і від 22.04.2026 № 515)' },
    ],
    p10since: '2026-04-10',                 // набрання чинності постановою № 431: від цієї дати — виняток пункту 10
    // Таблиця 26. КЕ за фактичним строком експлуатації (межа «до» — включно) або зберігання (років, включно).
    ke: ['1', '0.9', '0.8', '0.7', '0.6', '0.5'],
    keStore: ['1', '1', '0.9', '0.9', '0.8', '0.8'],
    storeUpTo: [5, 10, 15, 20, 25],
    groups: [
      { id: 'tz', name: 'Технічні засоби продовольчої служби (крім змонтованих на автомобільному шасі)',
        use: { 'год': [325, 650, 975, 1300, 1800], 'р': [2, 3, 5, 7, 8] } },
      // У тексті таблиці 26 інтервал зберігання цієї групи між «15 - 20» і «понад 25» записано «25 - 25 років».
      { id: 'portable', name: 'Переносне (з’ємне) обладнання польових технічних засобів та обладнання стаціонарних хлібозаводів',
        use: { 'год': [875, 1750, 2625, 3500, 4900] }, storeGap: [20, 25] },
      { id: 'goods', name: 'Майно продовольчої служби (брезенти, намети, чохли)', use: { 'міс': [4, 8, 12, 16, 20] } },
      { id: 'stationary', name: 'Технологічне, холодильне та немеханічне обладнання стаціонарних їдалень та складів',
        use: { 'р': [2, 3, 5, 7, 8] } },
    ],
    // Таблиця 27. КЗ за умовами зберігання (експлуатації), КТС за категорією якісного (технічного) стану.
    kz: [['в приміщенні, що опалюється', '1'],
      ['в приміщенні, що не опалюється, з дотриманням умов консервації', '0.9'],
      ['в приміщенні, що не опалюється (виріб незаконсервований)', '0.8'],
      ['на відкритих майданчиках під навісом з дотриманням умов консервації', '0.7'],
      ['на відкритих майданчиках під навісом (виріб незаконсервований)', '0.6'],
      ['на відкритих майданчиках з дотриманням умов консервації', '0.5'],
      ['на відкритих майданчиках (виріб незаконсервований)', '0.4']],
    kts: ['1', '0.9', '0.8', '0.7', '0.6'],
  };
  const VAL_UNIT = { 'год': ['годин', 'в годинах'], 'міс': ['місяців', 'в місяцях'], 'р': ['років', 'в роках'] };
  const VAL_PRICE_GROUPS = [['I', 'I — придбане за фіксованими державними цінами'], ['II', 'II — придбане за договірними цінами на внутрішньому ринку'],
    ['III', 'III — імпортоване'], ['IV', 'IV — за звітом про незалежну оцінку']];
  const VAL_ROMAN = ['I', 'II', 'III', 'IV', 'V'];
  /** Редакція Методики, чинна на дату складання відомості. Без дати редакція не визначена. */
  const valEdition = (date) => (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
    ? VAL_NORMS.editions.filter((e) => !e.from || e.from <= date).pop() : null);
  /** Номер інтервалу таблиці: перший, чия верхня межа не менша за значення; далі — останній, без межі. */
  const valInterval = (limits, v) => { const i = limits.findIndex((l) => decCmp(v, decOf(l)) <= 0); return i < 0 ? limits.length : i; };
  const valIntervalText = (limits, i, unit) => (i === 0 ? `до ${limits[0]} ${unit} включно`
    : i < limits.length ? `понад ${limits[i - 1]} до ${limits[i]} ${unit} включно` : `понад ${limits[limits.length - 1]} ${unit}`);
  /** Поля рядка, від яких залежить результат: змінилося хоч одне — розрахунок неактуальний. */
  const VAL_INPUTS = ['qty', 'price', 'group', 'ki', 'kiBasis', 'rate', 'rateBasis', 'appraisal', 'appraisalRef', 'complete', 'missing',
    'missingBasis', 'method', 'ng', 'mode', 'term', 'termUnit', 'storeYears', 'keOwn', 'keOwnBasis', 'cond', 'cat', 'scrap', 'scrapVal',
    'scrapBasis'];
  const VAL_P10 = ['kind', 'cause', 'basis', 'order', 'orderRef'];
  const valSig = (ln, doc) => JSON.stringify([VAL_NORMS.id, (valEdition(doc.date) || {}).id || '', VAL_INPUTS.map((f) => String(ln[f] ?? '').trim()),
    ln.method === 'p10' ? VAL_P10.map((f) => String((ln.p10 || {})[f] ?? '').trim()) : []]);
  /** Затверджена (і скасована) відомість тримає той результат, з яким її затвердили: оновлений
   *  довідник чи редакція її не чіпають. Решта — актуальна, доки не змінили параметр, дату чи довідник. */
  const valFrozen = (doc) => doc.state === 'затверджено' || doc.state === 'скасовано';
  const valStale = (ln, doc) => !ln.res || (!valFrozen(doc) && ln.res.sig !== valSig(ln, doc));

  /** Розрахунок рядка відомості: { need: [чого бракує], res: результат або null }. Нічого не
   *  домислює: без ціни, коефіцієнта індексації з підставою, комплектності, даних про брухт чи
   *  параметрів таблиць суми немає, а названо, чого саме бракує. Первісна вартість округлюється
   *  до копійок, далі множення без проміжного округлення — як у бланку відомості. */
  function valCalcLine(ln, doc) {
    const need = [], why = [];
    const txt = (f) => String(ln[f] ?? '').trim();
    const pos = (f) => { const v = decOf(ln[f]); return v && v.n >= 0n ? v : null; };
    const ed = valEdition(doc.date);
    if (!ed) need.push('не вказано дату складання відомості: за нею визначається редакція Методики');
    const qty = pos('qty');
    if (!qty || qty.n === 0n) need.push('не вказано кількість');
    // Первісна вартість — за ціновою групою (пункти 5 і 7 Методики).
    let vp = null;
    const grp = txt('group');
    if (!['I', 'II', 'III', 'IV'].includes(grp)) need.push('не обрано цінову групу (пункт 5 Методики)');
    else if (grp === 'IV') {
      const v = pos('appraisal');
      if (!v) need.push('не вказано первісну вартість за звітом про незалежну оцінку');
      if (!txt('appraisalRef')) need.push('не вказано реквізити звіту про оцінку');
      if (v && txt('appraisalRef')) {
        vp = decRound(v, 2);
        why.push(`IV цінова група: первісна вартість ${decUa(vp, 2)} грн — за звітом про оцінку (${txt('appraisalRef')}).`);
      }
    } else {
      const price = pos('price'), ki = pos('ki'), rate = pos('rate');
      if (!price) need.push(grp === 'III' ? 'не вказано ціну за контрактом в іноземній валюті' : 'не вказано ціну придбання');
      if (!ki || ki.n === 0n) need.push('не вказано коефіцієнт індексації');
      if (!txt('kiBasis')) need.push('не вказано підставу коефіцієнта індексації');
      if (grp === 'III' && (!rate || rate.n === 0n)) need.push('не вказано курс іноземної валюти на дату розрахунків');
      if (grp === 'III' && !txt('rateBasis')) need.push('не вказано валюту й дату курсу');
      if (price && ki && ki.n > 0n && txt('kiBasis') && (grp !== 'III' || (rate && rate.n > 0n && txt('rateBasis')))) {
        vp = decRound(grp === 'III' ? decMul(decMul(price, rate), ki) : decMul(price, ki), 2);
        why.push(grp === 'III'
          ? `III цінова група: Вп = Цк × КНБУ × Кі = ${decUa(price)} × ${decUa(rate)} × ${decUa(ki)} = ${decUa(vp, 2)} грн (${txt('rateBasis')}).`
          : `${grp} цінова група: Вп = ${grp === 'I' ? 'Цо(п)' : 'Цк'} × Кі = ${decUa(price, 2)} × ${decUa(ki)} = ${decUa(vp, 2)} грн.`);
        why.push(`Кі = ${decUa(ki)} — ${txt('kiBasis')}.`);
      }
    }
    // Недоукомплектоване майно: з первісної вартості виключається вартість того, чого бракує (пункт 9).
    let base = vp;
    if (txt('complete') === 'no') {
      const m = pos('missing');
      if (!m) need.push('не вказано первісну вартість відсутніх комплектувальних');
      if (!txt('missingBasis')) need.push('не вказано, яких комплектувальних бракує');
      if (m && vp && decCmp(m, vp) > 0) need.push('вартість відсутніх комплектувальних більша за первісну вартість');
      else if (m && vp && txt('missingBasis')) {
        base = decSub(vp, decRound(m, 2));
        why.push(`Недоукомплектоване (${txt('missingBasis')}): первісна вартість ${decUa(vp, 2)} − ${decUa(m, 2)} = ${decUa(base, 2)} грн (пункт 9).`);
      }
    } else if (txt('complete') !== 'yes') need.push('не вказано комплектність');
    // Сукупний коефіцієнт зносу.
    let k = null, ke = null, kz = null, kts = null;
    const rule = txt('method');
    if (rule === 'p10') {
      const p = ln.p10 || {};
      const got = (f) => String(p[f] ?? '').trim();
      const before = need.length;
      if (ed && !ed.p10) {
        need.push(`правило пункту 10 (Кскз = 1) діє з ${fmtDate(VAL_NORMS.p10since)}: на дату складання ${fmtDate(doc.date)} застосовується звичайний порядок пункту 21`);
      }
      if (!['destroyed', 'damaged'].includes(got('kind'))) need.push('не вказано, що сталося з майном: знищене (втрачене) чи пошкоджене без можливості відновлення');
      if (!['enemy', 'task'].includes(got('cause'))) need.push('не вказано обставину: дії противника чи виконання бойового (спеціального) завдання');
      if (!got('basis')) need.push('не вказано документ, що підтверджує обставини втрати');
      if (ed && ed.p10 === 'except') {
        if (!['yes', 'no'].includes(got('order'))) {
          need.push(`не вказано, чи було на ${fmtDate(VAL_NORMS.p10since)} видано наказ про списання цього майна без затвердженого єдиного акта списання`);
        } else if (got('order') === 'yes') {
          need.push(`виняток пункту 10: наказ про списання видано до ${fmtDate(VAL_NORMS.p10since)}, єдиний акт списання не затверджено — застосуйте звичайний порядок пункту 21`);
        }
      }
      if (ed && need.length === before) {
        k = decOf('1');
        why.push(`Кскз = 1 — абзац третій пункту 10 Методики (${ed.title}): майно ${got('kind') === 'destroyed' ? 'знищене (втрачене)'
          : 'пошкоджене, відновлення неможливе або економічно недоцільне'} ${got('cause') === 'enemy'
          ? 'внаслідок бойових або інших дій з боку противника' : 'у зв’язку з виконанням бойового (спеціального) завдання'}. Підстава: ${got('basis')}.`
          + (ed.p10 === 'except' ? ` Наказу про списання на ${fmtDate(VAL_NORMS.p10since)} без затвердженого єдиного акта не було.` : ''));
      }
    } else if (rule === 'p21') {
      const g = VAL_NORMS.groups.find((x) => x.id === txt('ng'));
      if (!g) need.push('не обрано нормативну групу майна (таблиця 26)');
      else if (txt('mode') === 'use') {
        const unit = txt('termUnit'), lim = g.use[unit], t = pos('term');
        if (!lim) need.push('не обрано одиницю строку експлуатації');
        else if (!t) need.push(`не вказано строк експлуатації ${VAL_UNIT[unit][1]}`);
        else {
          const i = valInterval(lim, t);
          ke = decOf(VAL_NORMS.ke[i]);
          why.push(`КЕ = ${decUa(ke)}: строк експлуатації ${decUa(t)} ${VAL_UNIT[unit][0]} — інтервал «${valIntervalText(lim, i, VAL_UNIT[unit][0])}» (таблиця 26, ${g.name}).`);
        }
      } else if (txt('mode') === 'store') {
        const t = pos('storeYears');
        if (!t) need.push('не вказано строк зберігання в роках');
        else if (g.storeGap && decCmp(t, decOf(g.storeGap[0])) > 0 && decCmp(t, decOf(g.storeGap[1])) <= 0) {
          // Інтервал у тексті таблиці неоднозначний: програма його не виправляє, а просить уточнення.
          const own = pos('keOwn');
          if (own && own.n > 0n && txt('keOwnBasis')) {
            ke = own;
            why.push(`КЕ = ${decUa(ke)} — за уточненням (${txt('keOwnBasis')}): для цієї групи інтервал зберігання понад 20 до 25 років у таблиці 26 записано «25 - 25 років».`);
          } else {
            need.push('таблиця 26: для переносного обладнання інтервал зберігання понад 20 до 25 років записано «25 - 25 років» — вкажіть КЕ й документ, яким його уточнено');
          }
        } else {
          const i = valInterval(VAL_NORMS.storeUpTo, t);
          ke = decOf(VAL_NORMS.keStore[i]);
          why.push(`КЕ = ${decUa(ke)}: строк зберігання ${decUa(t)} років — інтервал «${valIntervalText(VAL_NORMS.storeUpTo, i, 'років')}» (таблиця 26, ${g.name}).`);
        }
      } else need.push('не обрано, за чим визначається КЕ: строк експлуатації чи зберігання');
      const c = VAL_NORMS.kz[+txt('cond') - 1], cat = VAL_NORMS.kts[+txt('cat') - 1];
      if (!c) need.push('не обрано умови зберігання (таблиця 27)');
      else { kz = decOf(c[1]); why.push(`КЗ = ${decUa(kz)}: зберігання ${c[0]} (таблиця 27).`); }
      if (!cat) need.push('не вказано категорію якісного (технічного) стану');
      else { kts = decOf(cat); why.push(`КТС = ${decUa(kts)}: категорія ${VAL_ROMAN[+txt('cat') - 1]} (таблиця 27).`); }
      if (ke && kz && kts) {
        k = decMul(decMul(ke, kz), kts);
        why.push(`Кскз = КЕ × КЗ × КТС = ${decUa(ke)} × ${decUa(kz)} × ${decUa(kts)} = ${decUa(k)} (пункт 21 додатка 3).`);
      }
    } else need.push('не обрано спосіб розрахунку');
    // Нижня межа — вартість брухту (пункт 11): немає даних — це не нуль.
    let scrap = null;
    if (txt('scrap') === 'val') {
      scrap = pos('scrapVal');
      if (!scrap) need.push('не вказано вартість брухту');
      if (!txt('scrapBasis')) need.push('не вказано, чим визначено вартість брухту');
    } else if (txt('scrap') === 'na') {
      if (!txt('scrapBasis')) need.push('не вказано, чому нижня межа за вартістю брухту не застосовується');
    } else need.push('не вказано вартість брухту або що вона не застосовується');
    if (need.length || !base || !k || !qty) return { need, res: null };
    let unit = decMul(base, k);
    why.push(`Залишкова вартість одиниці: Взал = Вп × Кскз = ${decUa(base, 2)} × ${decUa(k)} = ${decUa(unit, 2)} грн.`);
    let floor = false;
    if (scrap && decCmp(scrap, unit) > 0) {
      floor = true;
      why.push(`Нижня межа (пункт 11): вартість брухту ${decUa(scrap, 2)} грн більша — залишкова вартість одиниці ${decUa(scrap, 2)} грн (${txt('scrapBasis')}).`);
      unit = decRound(scrap, 2);
    } else if (scrap) why.push(`Нижня межа (пункт 11): вартість брухту ${decUa(scrap, 2)} грн — на результат не впливає (${txt('scrapBasis')}).`);
    else why.push(`Нижня межа за вартістю брухту (пункт 11) не застосовується: ${txt('scrapBasis')}.`);
    const sum = decMul(unit, qty);
    const drop = decSub(base, unit);
    why.push(`Кількість ${decUa(qty)}: сума ${decUa(unit, 2)} × ${decUa(qty)} = ${decUa(sum, 2)} грн.`);
    if (drop.n > 0n) why.push(`Зменшення вартості одиниці проти первісної: ${decUa(drop, 2)} грн.`);
    why.push(`${VAL_NORMS.act}, ${ed.title}.`);
    return { need, res: { sig: valSig(ln, doc), ed: ed.id, norms: VAL_NORMS.id, rule, vp: decStr(vp, 2), base: decStr(base, 2),
      ke: ke ? decStr(ke) : '', kz: kz ? decStr(kz) : '', kts: kts ? decStr(kts) : '', k: decStr(k), unit: decStr(unit), sum: decStr(sum),
      drop: decStr(drop), floor, why } };
  }
  /** Розрахунок усієї відомості: рядки отримують результат або перелік того, чого бракує. */
  function valCalc(doc) {
    const bad = [];
    (doc.lines || []).forEach((ln, i) => {
      const { need, res } = valCalcLine(ln, doc);
      ln.res = res;
      for (const t of need) bad.push(`Рядок ${i + 1}: ${t}.`);
    });
    return bad;
  }
  /** Підсумок відомості — лише з актуальних розрахунків: сума точна, округлюється наприкінці. */
  function valTotal(doc) {
    let sum = decOf('0'), n = 0, stale = 0;
    for (const ln of doc.lines || []) {
      if (valStale(ln, doc)) { stale += 1; continue; }
      sum = decAdd(sum, decOf(ln.res.sum));
      n += 1;
    }
    return { sum: decStr(sum, 2), exact: decStr(sum), n, stale, ready: n > 0 && !stale };
  }

  // ========================================================= ДОКУМЕНТИ СЛУЖБИ
  /** Відомість залишкової вартості й акт якісного (технічного) стану — папери, які служба складає
   *  сама. Залишків, цін і проведених документів вони не чіпають: посилаються на майно з обліку
   *  й тримають копію його реквізитів на день складання. Стан: чернетка → підготовлено →
   *  затверджено (незмінна версія; виправлення — нова версія з причиною) або скасовано.
   *  «Затверджено» ставить людина; це позначка, а не підпис. */
  const PAPER = {
    valuation: { view: 'val', title: 'Залишкова вартість', crumb: 'оцінка / залишкова вартість', one: 'відомість', acc: 'відомість',
      fresh: '+ Нова відомість', word: 'Відомість залишкової вартості', empty: 'Відомостей ще немає.', file: 'В Excel',
      form: 'Додаток 1 до Методики (постанова КМУ № 759), бланк програми 1' },
    tech_act: { view: 'yats', title: 'Акти ЯТС', crumb: 'оцінка / акти якісного (технічного) стану', one: 'акт', acc: 'акт',
      fresh: '+ Новий акт', word: 'Акт якісного (технічного) стану', empty: 'Актів ще немає.', file: 'У Word',
      form: 'Додаток 1 до Порядку списання військового майна, бланк програми 1' },
  };
  const PAPER_OF_VIEW = { val: 'valuation', yats: 'tech_act' };
  const PAPER_TAG = { 'чернетка': 'tag--mv', 'підготовлено': 'tag--stock', 'затверджено': 'tag--in', 'скасовано': 'tag--ser' };
  const PAPER_UI = {};                                   // вид документа → { what, total, body, check, file }: заповнюють розділи нижче
  const papers = () => (Array.isArray(store.papers) ? store.papers : (store.papers = []));
  const paperById = (id) => papers().find((p) => p.id === id) || null;
  const paperNow = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return `${today()} ${z(d.getHours())}:${z(d.getMinutes())}`; };
  const paperOpen = (p) => p.state === 'чернетка';        // правиться лише чернетка
  const paperName = (p) => `${PAPER[p.kind].word} ${numNo(p.no || 'б/н')}${p.date ? ` від ${fmtDate(p.date)}` : ''}`;
  /** Час зміни й, для істотного, рядок історії документа. */
  function paperMark(p, what = '') {
    p.changed = paperNow();
    if (what) (p.history = p.history || []).push({ at: p.changed, what });
  }
  /** Підписант у документі — як він виглядав на дату документа: посада, звання, ім'я. */
  const sgOf = (person, date) => (person ? Object.assign({ pid: person.id }, signer(person, date)) : { pid: '', pos: '', rank: '', name: '' });
  const sgSlot = (p, slot) => (slot.startsWith('m:') ? (p.members || [])[+slot.slice(2)] : p[slot]);
  const sgFilled = (s) => !!(s && String(s.name || '').trim());

  function paperNew(kind) {
    const date = today();
    const p = { id: `p${uid().slice(1)}${uid().slice(1)}`, kind, no: '', date, state: 'чернетка', ver: 1, created: paperNow(), changed: '',
      basis: '', note: '', lines: [], versions: [], history: [],
      approver: sgOf(officialAt('командир', date), date), head: sgOf(null), members: [], agree: sgOf(officialAt('начальник служби', date), date) };
    Object.assign(p, PAPER_UI[kind].blank(date));
    papers().push(p);
    paperMark(p, 'створено');
    return p;
  }
  /** Копія — нова чернетка з тим самим змістом; розрахунок у ній треба повторити. */
  function paperCopy(src) {
    const p = JSON.parse(JSON.stringify(src));
    Object.assign(p, { id: `p${uid().slice(1)}${uid().slice(1)}`, no: '', date: today(), state: 'чернетка', ver: 1, created: paperNow(), changed: '',
      approved: '', fixReason: '', versions: [], history: [] });
    for (const ln of p.lines || []) { ln.id = uid(); delete ln.res; }
    papers().push(p);
    paperMark(p, `скопійовано з ${numNo(src.no || 'б/н')} від ${fmtDate(src.date)}`);
    return p;
  }
  /** Знімок документа для незмінної версії: усе, крім самих версій та історії. */
  function paperSnap(p) {
    const body = JSON.parse(JSON.stringify(p));
    delete body.versions; delete body.history;
    return body;
  }

  function paperSpec(kind) {
    const K = PAPER[kind], U = PAPER_UI[kind];
    const rows = papers().filter((p) => p.kind === kind);
    return {
      id: `pv-${K.view}`, rows, minWidth: '1000px', limit: REG_LIMIT,
      placeholder: 'Пошук: номер, майно, підрозділ, підстава',
      search: (p) => [p.no, p.sub || '', p.basis || '', p.state].concat((p.lines || []).flatMap((l) => [l.name, l.code, l.serial || ''])),
      filters: [
        { type: 'seg', key: 'st', options: [['', 'усі'], ['чернетка', 'чернетки'], ['підготовлено', 'підготовлені'], ['затверджено', 'затверджені'],
          ['скасовано', 'скасовані']], test: (p, v) => p.state === v },
        { type: 'period', key: 'd', label: 'дата', get: (p) => p.date },
      ],
      columns: [
        { key: 'date', label: 'дата', cls: 'c-date', sort: (p) => p.date || '', cell: (p) => fmtDate(p.date) },
        { key: 'no', label: '№', cls: 'c-code', style: 'width:110px', first: 1, sort: (p) => p.no || '', cell: (p) => `<b>${esc(p.no || 'б/н')}</b>` },
        { key: 'what', label: 'майно', cls: 'c-name c-name--stack', first: 1, sort: (p) => U.what(p), cellTitle: (p) => U.what(p),
          cell: (p) => `<b>${esc(U.what(p) || '—')}</b><small>${esc([p.sub, p.basis].filter(Boolean).join(' · '))}</small>` },
        { key: 'n', label: 'рядків', cls: 'c-num', style: 'width:64px', sort: (p) => (p.lines || []).length, cell: (p) => String((p.lines || []).length || '—') },
        { key: 'sum', label: 'сума, грн', cls: 'c-num', style: 'width:124px', sort: (p) => +U.total(p).sum || 0,
          cell: (p) => { const t = U.total(p); return t.ready ? decUa(decOf(t.sum), 2) : '<span class="c-num--dim">не розраховано</span>'; } },
        { key: 'state', label: 'стан', cls: 'c-tag', style: 'width:130px', first: 1, sort: (p) => PAPER_STATES.indexOf(p.state),
          cell: (p) => `<span class="tag ${PAPER_TAG[p.state] || ''}">${esc(p.state)}</span>${p.ver > 1 ? `<small>версія ${p.ver}</small>` : ''}` },
      ],
      row: (p) => ({ attrs: `data-act="paper-open" data-id="${esc(p.id)}"` }),
      count: (shown, all) => (shown.length === all.length ? String(all.length) : `${shown.length} із ${all.length}`),
      empty: K.empty,
    };
  }
  const PAPER_STATES = ['чернетка', 'підготовлено', 'затверджено', 'скасовано'];

  /** Рядок підписанта: посада, звання, ім'я — текстом, як стоятиме в папері; вибір із довідника
   *  людей підставляє те, що в людини було на дату документа. */
  function sgRow(p, slot, label, ro) {
    const s = sgSlot(p, slot) || {};
    const dis = ro ? ' disabled' : '';
    const inp = (k, ph, style) => `<div class="c-txt" style="${style}"><input class="rc-in rc-in--wide" style="width:100%;text-align:left"
      data-sg="${slot}" data-k="${k}" data-fid="sg:${slot}:${k}" value="${esc(s[k] || '')}" placeholder="${ph}" autocomplete="off"${dis}></div>`;
    const people = (store.people || []).filter((x) => x.surname).sort((a, b) => String(a.surname).localeCompare(String(b.surname), 'uk'));
    return `<div class="tbl__row tbl__row--plain">
      <div class="c-txt" style="flex:0 0 132px"><b>${esc(label)}</b></div>
      ${inp('pos', 'посада', 'flex:2 1 220px')}${inp('rank', 'звання', 'flex:0 0 140px')}${inp('name', 'Ім’я ПРІЗВИЩЕ', 'flex:1 1 170px')}
      <div class="c-acts" style="flex-basis:220px">${ro ? '' : `<select data-sg-pick="${slot}" aria-label="людина з довідника" style="max-width:150px">
        <option value="">з довідника…</option>${people.map((x) => `<option value="${esc(x.id)}">${esc(pShort(x))}</option>`).join('')}</select>${
        slot.startsWith('m:') ? rowBtn('paper-member-del', '✕', `data-i="${slot.slice(2)}"`, { bad: true, title: 'Прибрати члена комісії' }) : ''}`}</div></div>`;
  }
  function paperSigners(p, ro, slots) {
    const members = (p.members || []).map((_, i) => sgRow(p, `m:${i}`, i ? '' : 'Члени комісії', ro)).join('');
    return `<div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Комісія й підписи</div>
        <div class="panel__spacer"></div>${ro ? '' : '<button type="button" class="btn btn--sm" data-act="paper-member-add">+ Член комісії</button>'}</div>
      <div class="tbl" style="--tbl-min:auto">${slots.map(([slot, label]) => (slot === 'members' ? members : sgRow(p, slot, label, ro))).join('')}</div></div>`;
  }

  /** Що можна зробити з документом у його стані. */
  function paperStateBar(p, viewing) {
    const K = PAPER[p.kind];
    const b = (act, label, cls = '', title = '') => `<button type="button" class="btn ${cls}" data-act="${act}"${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
    const acts = [];
    if (viewing) acts.push(b('paper-ver', 'До поточної версії'));
    else {
      if (p.state === 'чернетка') acts.push(b('paper-ready', 'Підготовлено →', 'btn--primary', 'Документ повний: далі його затверджують'));
      if (p.state === 'підготовлено') acts.push(b('paper-approve', 'Затвердити…', 'btn--primary', 'Затверджену версію змінити не можна'), b('paper-draft', 'Повернути в чернетку'));
      if (p.state === 'затверджено') acts.push(b('paper-fix', 'Виправити…', '', 'Нова версія з причиною; затверджена лишається доступною'));
      acts.push(b('paper-copy', 'Копіювати'));
      if (p.state !== 'скасовано') acts.push(b('paper-cancel', 'Скасувати…', 'btn--danger'));
      if (p.state === 'чернетка' && !(p.versions || []).length) acts.push(b('paper-del', 'Видалити', 'btn--danger'));
    }
    const ver = viewing ? (p.versions || []).find((v) => v.ver === state.paperVer) : null;
    return `<div class="card" style="margin-bottom:12px"><div class="card__head">
      <span class="tag ${PAPER_TAG[viewing ? 'затверджено' : p.state] || ''}">${esc(viewing ? 'затверджено' : p.state)}</span>
      <span class="panel__count">${viewing ? `версія ${ver.ver}, затверджена ${fmtStamp(ver.at)}; поточна — версія ${p.ver}, ${esc(p.state)}`
    : `версія ${p.ver}${p.fixReason ? ` · виправлення: ${esc(p.fixReason)}` : ''} · створено ${fmtStamp(p.created)}${
      p.changed ? ` · змінено ${fmtStamp(p.changed)}` : ''}`}</span>
      <div class="panel__spacer"></div>${acts.join('')}</div>
      ${!viewing && p.state !== 'чернетка' ? `<div class="pad" style="padding-top:12px"><div class="callout">${
      p.state === 'підготовлено' ? `Підготовлений документ не правиться. Після підписання натисніть «Затвердити…»; щоб змінити — «Повернути в чернетку».`
        : p.state === 'затверджено' ? `Затверджена версія незмінна. «Виправити…» відкриє нову версію, а ця лишиться в переліку версій.`
          : `Документ скасовано. Його можна переглянути, вивантажити й скопіювати.`}</div></div>` : ''}</div>`;
  }
  /** Версії й історія: затверджені версії лишаються як були — їх можна відкрити й вивантажити. */
  function paperHistory(p) {
    const vers = (p.versions || []).slice().reverse().map((v) => `<div class="tbl__row tbl__row--plain">
      <div class="c-txt" style="flex:0 0 110px"><b>версія ${v.ver}</b></div><div class="c-txt" style="flex:0 0 150px">${esc(fmtStamp(v.at))}</div>
      <div class="c-txt">${esc(v.reason ? `виправлення: ${v.reason}` : 'перше затвердження')}</div>
      <div class="c-acts" style="flex-basis:220px">${rowBtn('paper-ver', 'Відкрити', `data-v="${v.ver}"`)}${rowBtn('paper-file', PAPER[p.kind].file, `data-v="${v.ver}"`)}</div></div>`).join('');
    const hist = (p.history || []).slice().reverse().map((h) => `<div class="tbl__row tbl__row--plain">
      <div class="c-txt" style="flex:0 0 150px">${esc(fmtStamp(h.at))}</div><div class="c-txt" style="white-space:normal">${esc(h.what)}</div></div>`).join('');
    // Розгорнута картка лишається розгорнутою й після перемальовування (запис, перевірка файлів).
    return `<details class="fold card" style="margin-bottom:12px" data-paper-hist${state.paperHist ? ' open' : ''}>
      <summary class="card__head"><div class="card__title">Версії й історія</div><span class="fold__hint">${
      cnt((p.versions || []).length, 'затверджена версія', 'затверджені версії', 'затверджених версій')}</span></summary>
      <div class="tbl" style="--tbl-min:auto">${vers}${hist}</div></details>`;
  }

  function renderPapers(kind) {
    const K = PAPER[kind], U = PAPER_UI[kind];
    const p = state.paperId ? paperById(state.paperId) : null;
    if (!p || p.kind !== kind) {
      state.paperId = null; state.paperVer = 0; state.paperBad = null;
      const reg = registry(paperSpec(kind));
      return { fill: true, head: head(K.crumb, K.title, `<button class="btn btn--primary" data-act="paper-new" data-pk="${kind}">${K.fresh}</button>`),
        body: `${flashBlock()}${reg.panel}<div class="card card--scroll card--fill">${reg.table}</div>` };
    }
    const ver = state.paperVer ? (p.versions || []).find((v) => v.ver === state.paperVer) : null;
    if (!ver) state.paperVer = 0;
    const doc = ver ? Object.assign({ versions: [], history: [] }, ver.body) : p;
    const ro = !!ver || !paperOpen(p);
    const bad = !ver && state.paperBad && state.paperBad.length ? `<div class="callout callout--bad" style="margin-bottom:12px">${
      state.paperBad.slice(0, 12).map(esc).join('<br>')}${state.paperBad.length > 12 ? `<br>і ще ${state.paperBad.length - 12}` : ''}</div>` : '';
    return {
      head: head(K.crumb, `${K.word} ${numNo(doc.no || 'б/н')}`, `<button class="btn" data-act="paper-close">← До переліку</button>
        ${U.actions(doc, ro)}<button class="btn${ro ? ' btn--primary' : ''}" data-act="paper-file"${ver ? ` data-v="${ver.ver}"` : ''}>${K.file}</button>`),
      body: `${flashBlock()}${bad}${paperStateBar(p, !!ver)}${U.body(doc, ro)}
        ${ver ? '' : filesCard(`paper|${p.id}`, 'Підписаний документ і додатки', 'скан підписаного примірника')}${ver ? '' : paperHistory(p)}`,
    };
  }

  function bindPapers() {
    if (!PAPER_OF_VIEW[state.view] || !state.paperId) return;
    const sc = $('#scroll');
    sc.querySelector('[data-paper-hist]')?.addEventListener('toggle', (e) => { state.paperHist = e.target.open; });
    const p = paperById(state.paperId);
    if (!p || !paperOpen(p) || state.paperVer) return;
    // Табуляція вже перевела фокус у наступне поле: після перемальовування повертаємо його туди ж.
    const after = () => {
      paperMark(p);
      save();
      const fid = ((document.activeElement || {}).dataset || {}).fid;
      render();
      const again = fid ? [...$('#scroll').querySelectorAll('[data-fid]')].find((x) => x.dataset.fid === fid) : null;
      if (again) again.focus();
    };
    sc.querySelectorAll('[data-pf]').forEach((el) => el.addEventListener('change', () => { p[el.dataset.pf] = el.value.trim(); after(); }));
    sc.querySelectorAll('[data-sg]').forEach((el) => el.addEventListener('change', () => {
      const s = sgSlot(p, el.dataset.sg);
      if (s) { s[el.dataset.k] = el.value.trim(); s.pid = ''; after(); }
    }));
    sc.querySelectorAll('[data-sg-pick]').forEach((el) => el.addEventListener('change', () => {
      const person = personBy(el.value);
      if (!person) return;
      const slot = el.dataset.sgPick;
      if (slot.startsWith('m:')) p.members[+slot.slice(2)] = sgOf(person, p.date);
      else p[slot] = sgOf(person, p.date);
      after();
    }));
    PAPER_UI[p.kind].bind(p, sc, after);
  }

  /** Дії над документом: стан, версії, копія, видалення. Решта — у розділі виду документа. */
  function paperAction(act, d) {
    switch (act) {
      case 'paper-new': { const fresh = paperNew(d.pk); save(); return go(PAPER[fresh.kind].view, { paperId: fresh.id, paperVer: 0, paperBad: null }); }
      case 'paper-open': { const x = paperById(d.id); return x ? go(PAPER[x.kind].view, { paperId: x.id, paperVer: 0, paperBad: null }) : null; }
      default: break;
    }
    const p = paperById(state.paperId);
    if (!p) return null;
    const K = PAPER[p.kind], U = PAPER_UI[p.kind];
    // Слово про зміну стану — після того, як її записано.
    const done = (what, said) => { paperMark(p, what); state.paperBad = null; render(); if (said) saveThen(said); else save(true); };
    switch (act) {
      case 'paper-close': return go(K.view, { paperId: null, paperVer: 0, paperBad: null });
      case 'paper-ver': state.paperVer = +d.v || 0; return render();
      case 'paper-file': {
        const v = +d.v ? (p.versions || []).find((x) => x.ver === +d.v) : null;
        return U.file(v ? Object.assign({ versions: [], history: [] }, v.body) : p);
      }
      case 'paper-member-add': if (paperOpen(p)) { (p.members = p.members || []).push(sgOf(null)); paperMark(p); save(); render(); } return null;
      case 'paper-member-del': if (paperOpen(p)) { p.members.splice(+d.i, 1); paperMark(p); save(); render(); } return null;
      case 'paper-ready': {
        const bad = U.check(p, 'ready');
        if (bad.length) { state.paperBad = bad; render(); return toast(`До готового документа бракує: ${cnt(bad.length, 'пункт', 'пункти', 'пунктів')}.`, true); }
        p.state = 'підготовлено';
        return done('підготовлено', `${paperName(p)}: підготовлено.`);
      }
      case 'paper-draft': p.state = 'чернетка'; return done('повернуто в чернетку');
      case 'paper-approve': {
        const date = String(prompt('Дата затвердження (РРРР-ММ-ДД)', p.approved || today()) || '').trim();
        if (!date) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return toast('Дату затвердження вкажіть як РРРР-ММ-ДД.', true);
        if (p.date && date < p.date) return toast('Дата затвердження раніша за дату складання.', true);
        const bad = U.check(p, 'approve');
        if (bad.length) { state.paperBad = bad; render(); return toast('Документ неповний: затвердити його не можна.', true); }
        p.approved = date;
        p.state = 'затверджено';
        // Затверджена версія тримає й те, що в налаштуваннях може змінитися: реквізити частини й бланк.
        p.unit = { name: unitInfo().legalName, code: unitCode(), service: unitInfo().serviceFull };
        p.form = K.form;
        (p.versions = p.versions || []).push({ ver: p.ver, at: paperNow(), reason: p.fixReason || '', body: paperSnap(p) });
        logChange('документ затверджено', `paper|${p.id}`, `${paperName(p)}, версія ${p.ver}`);
        return done(`затверджено ${fmtDate(date)}, версія ${p.ver}`, `${paperName(p)}: затверджено, версія ${p.ver}.`);
      }
      case 'paper-fix': {
        const reason = String(prompt('Причина виправлення затвердженого документа') || '').trim();
        if (!reason) return null;
        p.ver += 1; p.state = 'чернетка'; p.fixReason = reason; p.approved = '';
        logChange('документ виправляється', `paper|${p.id}`, `${paperName(p)}, версія ${p.ver}: ${reason}`);
        return done(`відкрито версію ${p.ver} для виправлення: ${reason}`);
      }
      case 'paper-cancel': {
        const reason = String(prompt(`Скасувати ${K.acc} ${numNo(p.no || 'б/н')}? Причина скасування`) || '').trim();
        if (!reason) return null;
        p.state = 'скасовано';
        logChange('документ скасовано', `paper|${p.id}`, `${paperName(p)}: ${reason}`);
        return done(`скасовано: ${reason}`);
      }
      case 'paper-copy': { const c = paperCopy(p); save(); return go(K.view, { paperId: c.id, paperVer: 0, paperBad: null, flash: `Копію створено: це нова чернетка.` }); }
      case 'paper-del': {
        if (!paperOpen(p) || (p.versions || []).length) return null;
        if (!confirm(`Видалити чернетку «${paperName(p)}»?`)) return null;
        store.papers = papers().filter((x) => x !== p);
        store.scans = (store.scans || []).filter((x) => x.key !== `paper|${p.id}`);
        logChange('чернетку видалено', `paper|${p.id}`, paperName(p));
        save(true, true);
        return go(K.view, { paperId: null, paperVer: 0, paperBad: null });
      }
      default: return U.action(act, d, p);
    }
  }

  // ======================================================= ЗАЛИШКОВА ВАРТІСТЬ
  /** Відомість щодо визначення залишкової вартості військового майна (Додаток 1 до Методики).
   *  Рядок — майно з обліку однієї ціни й одних параметрів: посилання на джерело (партія
   *  надходження, одиниця з номером, запис про знищення, рядок документа) і копія реквізитів.
   *  Параметри розрахунку вводить людина; коефіцієнти й суми рахує valCalcLine. */
  const VAL_TEXT = ['name', 'uom', 'serial', 'inv', 'acq', 'note'];
  const VAL_KEEP = '∅';                                   // у формі «для всіх рядків»: поле не змінювати
  const VAL_P10_KIND = [['destroyed', 'знищене (втрачене)'], ['damaged', 'пошкоджене, відновлення неможливе або економічно недоцільне']];
  const VAL_P10_CAUSE = [['enemy', 'бойові або інші дії противника'], ['task', 'виконання бойового (спеціального) завдання']];
  const valLine = (o) => Object.assign({ id: uid(), src: { kind: 'manual', label: 'внесено вручну' }, code: '', name: '', uom: '', serial: '', inv: '',
    qty: '', price: '', acq: '', note: '' }, o);
  const valMoney = (x) => (x == null || x === '' ? '' : (+x).toFixed(2));
  const valQty = (x) => String(round3(+x || 0));
  const valDocLabel = (r) => `${r.t || 'документ'} ${numNo(r.no)} від ${fmtDate(r.d)}${r.from ? `, ${r.from}` : ''}`;
  /** Партії позиції — рядки надходжень із ціною, від давніх до нових. */
  function valBatches(code) {
    const by = new Map();
    for (const r of docs) {
      if (r.kind !== 'in' || r.code !== code) continue;
      const price = +r.price || 0;
      const k = `${keyOfRow(r)}|${price.toFixed(2)}`;
      const x = by.get(k) || { doc: keyOfRow(r), id: r.id || 0, d: r.d, price, q: 0, acq: r.lot || r.d, label: valDocLabel(r) };
      x.q = round3(x.q + (+r.q || 0));
      by.set(k, x);
    }
    return [...by.values()].sort((a, b) => a.d.localeCompare(b.d));
  }
  /** Знищене за записом рапорту — частинами за цінами партій підрозділу на день події; чого
   *  партії не покривають, лишається без ціни: її вкаже людина, а не довідник. */
  function valDzParts(r) {
    if (r.price != null && String(r.price).trim() !== '') return [{ price: +r.price || 0, q: +r.qty || 0, d: '' }];
    if (r.unit) {
      const a = unitArrival(r.unit, r.date, null);
      return [{ price: a ? +a.price || 0 : null, q: 1, d: a ? a.lot || a.d : '' }];
    }
    const out = [];
    let need = +r.qty || 0;
    for (const l of lotsAt(r.date).get(`${r.sub}|${r.code}`) || []) {
      if (need <= 1e-9) break;
      if (l.q <= 1e-9) continue;
      const t = Math.min(need, l.q);
      const same = out.find((x) => Math.abs(x.price - l.price) < 0.005);
      if (same) same.q = round3(same.q + t); else out.push({ price: +l.price || 0, q: round3(t), d: l.d });
      need = round3(need - t);
    }
    if (need > 1e-9) out.push({ price: null, q: need, d: '' });
    return out;
  }
  /** Інвентарний номер для паперу — той, під яким майно веде ФЕС (необоротний актив). Власний
   *  номер служби з бирки («код/NNN») у документ не йде: це внутрішня позначка, комісія й ФЕС
   *  звіряють за номером ФЕС. Запаси інвентарного номера не мають. */
  const fesInvNo = (it) => (it && it.fes && it.nonrev ? String(it.fes) : '');
  function valLineOf(code, o) {
    const it = itemBy.get(code) || {};
    return valLine(Object.assign({ code, name: cleanName(it.name || code), uom: it.unit || '', inv: fesInvNo(it) }, o));
  }
  function valLinesOfUnit(id, date) {
    const u = unitBy.get(String(id));
    const a = u ? unitArrival(u.id, '9999-12-31', null) : null;
    if (!u) return [];
    return [valLineOf(u.code, { src: { kind: 'unit', unit: String(u.id), doc: a ? keyOfRow(a) : '', label: `${unitLabel(u)}${a ? `; ${valDocLabel(a)}` : ''}`,
      holder: unitHolderAt(u.id, date, null) || '' }, serial: u.serial || '', qty: '1', price: a ? valMoney(a.price) : '',
    acq: a ? a.lot || a.d : '' })];
  }
  function valLinesOfDz(r) {
    if (r.unit && unitBy.get(String(r.unit))) {
      return valLinesOfUnit(r.unit, r.date).map((ln) => Object.assign(ln, { src: Object.assign(ln.src, { kind: 'dz', dz: r.id }),
        note: r.report ? `рапорт ${numNo(r.report)}${r.reportDate ? ` від ${fmtDate(r.reportDate)}` : ''}` : '' }));
    }
    return valDzParts(r).map((part) => valLineOf(r.code, { src: { kind: 'dz', dz: r.id, sub: r.sub,
      label: `рапорт ${numNo(r.report || 'б/н')}${r.reportDate ? ` від ${fmtDate(r.reportDate)}` : ''}, ${r.sub}, подія ${fmtDate(r.date)}` },
    qty: valQty(part.q), price: part.price == null ? '' : valMoney(part.price), acq: part.d || '',
    note: r.report ? `рапорт ${numNo(r.report)}${r.reportDate ? ` від ${fmtDate(r.reportDate)}` : ''}` : '' }));
  }
  function valLinesOfDoc(key, picked = null) {
    const out = [];
    docs.filter((r) => keyOfRow(r) === key).forEach((r, i) => {
      if (picked && !picked.has(i)) return;
      const u = r.unit ? unitBy.get(String(r.unit)) : null;
      for (const part of rowParts(r)) {
        out.push(valLineOf(r.code, { src: { kind: 'doc', doc: key, unit: u ? String(u.id) : '', label: valDocLabel(r) }, serial: u ? u.serial || '' : '',
          qty: valQty(part.q), price: valMoney(part.price), acq: part.d || (r.kind === 'in' ? r.d : '') }));
      }
    });
    return out;
  }

  PAPER_UI.valuation = {
    blank: (date) => ({ asOf: date, approved: '', sub: '', copies: '' }),
    what: (p) => { const l = p.lines || []; return l.length ? `${l[0].name || l[0].code || 'майно'}${l.length > 1 ? ` і ще ${l.length - 1}` : ''}` : ''; },
    total: (p) => valTotal(p),
    actions: (p, ro) => (ro ? '' : '<button class="btn btn--primary" data-act="val-calc">Розрахувати</button>'),
    check: valCheck,
    body: valBody,
    bind: () => {},
    file: valFile,
    action: valAction,
  };

  /** Чого бракує відомості до готового документа. */
  function valCheck(p) {
    const bad = [];
    if (!String(p.no || '').trim()) bad.push('Не вказано номер відомості.');
    if (!p.date) bad.push('Не вказано дату складання.');
    if (!p.asOf) bad.push('Не вказано дату оцінки («станом на»).');
    if (!String(p.basis || '').trim()) bad.push('Не вказано підставу відомості.');
    if (!(p.lines || []).length) bad.push('У відомості немає жодного рядка.');
    (p.lines || []).forEach((ln, i) => {
      if (!String(ln.name || '').trim()) bad.push(`Рядок ${i + 1}: не вказано найменування.`);
      const { need } = valCalcLine(ln, p);
      for (const t of need) bad.push(`Рядок ${i + 1}: ${t}.`);
      if (!need.length && valStale(ln, p)) bad.push(`Рядок ${i + 1}: розрахунок неактуальний — натисніть «Розрахувати».`);
    });
    if (!sgFilled(p.approver)) bad.push('Не вказано, хто затверджує відомість.');
    if (!sgFilled(p.head)) bad.push('Не вказано голову комісії.');
    if (!(p.members || []).some(sgFilled)) bad.push('Не вказано жодного члена комісії.');
    return bad;
  }

  function valBody(p, ro) {
    const dis = ro ? ' disabled' : '';
    const ed = valEdition(p.date);
    const f = (field, label, type = 'text', span = '', extra = '') => `<div class="field${span}"><label>${label}</label>
      <input type="${type}" data-pf="${field}" data-fid="pf:${field}" value="${esc(p[field] || '')}" autocomplete="off"${extra}${dis}></div>`;
    const total = valTotal(p);
    const rows = (p.lines || []).map((ln, i) => {
      const need = valFrozen(p) ? [] : valCalcLine(ln, p).need;
      const stale = valStale(ln, p);
      const r = stale ? null : ln.res;
      const mark = need.length ? `<small class="num-bad">${esc(need[0])}${need.length > 1 ? ` і ще ${need.length - 1}` : ''}</small>`
        : stale ? '<small class="num-warn">розрахунок неактуальний</small>' : '';
      const d = (s, n = null) => (s === '' || s == null ? '—' : decUa(decOf(s), n));
      return `<div class="tbl__row${r ? '' : ' is-due'}" data-act="val-why" data-id="${esc(ln.id)}" title="${esc(need.join('; ') || 'Пояснення розрахунку')}">
        <div class="c-num c-num--dim" style="width:34px">${i + 1}</div>
        <div class="c-name c-name--stack" style="flex:2 1 220px"><b>${esc(ln.name || '—')}</b><small>${esc([ln.code, ln.serial ? `зав. № ${ln.serial}` : '',
          ln.inv ? `інв. № ${ln.inv}` : '', (ln.src || {}).label || ''].filter(Boolean).join(' · '))}</small>${mark}</div>
        <div class="c-num" style="width:64px">${decOf(ln.qty) ? decUa(decOf(ln.qty)) : '—'}<small>${esc(ln.uom || '')}</small></div>
        <div class="c-num" style="width:104px">${decOf(ln.price) ? decUa(decOf(ln.price), 2) : '—'}<small>${esc(String(ln.acq || '').slice(0, 4))}</small></div>
        <div class="c-num" style="width:104px">${r ? d(r.base, 2) : '—'}<small>${ln.group === 'IV' ? 'оцінка' : decOf(ln.ki) ? `Кі ${decUa(decOf(ln.ki))}` : ''}</small></div>
        <div class="c-num" style="width:96px">${r ? (r.rule === 'p10' ? 'пункт 10' : `${d(r.ke)} · ${d(r.kz)} · ${d(r.kts)}`) : '—'}</div>
        <div class="c-num" style="width:60px">${r ? `<b>${d(r.k)}</b>` : '—'}</div>
        <div class="c-num" style="width:104px">${r ? d(r.unit, 2) : '—'}${r && r.floor ? '<small>брухт</small>' : ''}</div>
        <div class="c-num" style="width:112px">${r ? `<b>${d(r.sum, 2)}</b>` : '—'}</div>
        <div class="c-acts" style="flex-basis:150px">${ro ? '' : rowBtn('val-line', '✎ Параметри', `data-id="${esc(ln.id)}"`, { main: !r })
          + rowBtn('val-line-del', '✕', `data-id="${esc(ln.id)}"`, { bad: true, title: 'Прибрати рядок' })}</div></div>`;
    }).join('');
    const subsList = `<datalist id="val-subs">${subs.map((s) => `<option value="${esc(s.name)}">`).join('')}</datalist>`;
    const acts = papers().filter((x) => x.kind === 'tech_act' && x.valId === p.id && x.state !== 'скасовано');
    return `<div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Реквізити</div>
        <div class="panel__spacer"></div><span class="panel__count" title="${esc(VAL_NORMS.act)}">${ed ? `Методика: ${esc(ed.title)}`
    : 'редакцію Методики визначає дата складання'}</span></div>
      <div class="form__grid">${f('no', 'Номер відомості')}${f('date', 'Дата складання', 'date')}${f('asOf', 'Станом на (дата оцінки)', 'date')}
        ${f('approved', 'Дата затвердження', 'date')}${f('sub', 'Підрозділ або призначення', 'text', '', ' list="val-subs"')}
        ${f('basis', 'Підстава: рапорт чи наказ, номер і дата', 'text', ' field--span2')}
        ${f('copies', 'Примірники', 'text', ' field--span2', ' placeholder="примірник № 1 — …; примірник № 2 — …"')}
        ${f('note', 'Примітка під таблицею', 'text', ' field--span2')}</div>${subsList}</div>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Майно й розрахунок</div>
        <div class="panel__spacer"></div><span class="panel__count">${total.ready ? `разом ${decUa(decOf(total.sum), 2)} грн`
    : (p.lines || []).length ? `не розраховано рядків: ${total.stale}` : ''}</span>
        ${acts.map((a) => `<button type="button" class="btn btn--sm" data-act="paper-open" data-id="${esc(a.id)}">Акт ЯТС ${esc(numNo(a.no || 'б/н'))}</button>`).join('')}
        ${(p.lines || []).length ? `<button type="button" class="btn btn--sm" data-act="val-to-act"
          title="Новий акт якісного (технічного) стану з майном і комісією цієї відомості">Акт ЯТС за відомістю</button>` : ''}
        ${ro ? '' : `<button type="button" class="btn btn--sm" data-act="val-bulk" title="Однакові параметри — усім рядкам одразу">Заповнити всі рядки…</button>
        <button type="button" class="btn btn--sm btn--primary" data-act="val-pick">+ Додати майно</button>`}</div>
      ${(p.lines || []).some((ln) => ln.method === 'p10') ? `<div class="panel"><div class="panel__note">Для майна, знищеного чи втраченого внаслідок бойових дій,
        акт технічного стану для цілей оцінки не складається (абзац п’ятий пункту 4 Методики).</div></div>` : ''}
      <div class="card--scroll"><div class="tbl" style="--tbl-min:1060px"><div class="tbl__head">
        <div class="tbl__h c-num" style="width:34px">№</div><div class="tbl__h c-name" style="flex:2 1 220px">найменування, номер, джерело</div>
        <div class="tbl__h c-num" style="width:64px">к-сть</div><div class="tbl__h c-num" style="width:104px" title="Ціна придбання й рік взяття на облік">ціна · рік</div>
        <div class="tbl__h c-num" style="width:104px" title="Первісна вартість">первісна</div>
        <div class="tbl__h c-num" style="width:96px" title="Коефіцієнти експлуатації, умов зберігання, технічного стану">Ке · Кз · Ктс</div>
        <div class="tbl__h c-num" style="width:60px" title="Сукупний коефіцієнт зносу">Кскз</div>
        <div class="tbl__h c-num" style="width:104px" title="Залишкова вартість одиниці">залишкова</div>
        <div class="tbl__h c-num" style="width:112px">сума, грн</div><div class="tbl__h c-acts" style="flex-basis:150px"></div></div>
        ${rows || `<div class="tbl__row tbl__row--plain"><div class="c-txt">${ro ? 'Рядків немає.' : 'Додайте майно з обліку: «+ Додати майно».'}</div></div>`}
        ${(p.lines || []).length ? `<div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-num" style="width:34px"></div>
          <div class="c-name" style="flex:2 1 220px"><b>На загальну суму</b></div><div class="c-num" style="width:64px"></div>
          <div class="c-num" style="width:104px"></div><div class="c-num" style="width:104px"></div><div class="c-num" style="width:96px"></div>
          <div class="c-num" style="width:60px"></div><div class="c-num" style="width:104px"></div>
          <div class="c-num" style="width:112px"><b>${total.ready ? decUa(decOf(total.sum), 2) : '—'}</b></div>
          <div class="c-acts" style="flex-basis:150px"></div></div>` : ''}</div></div></div>
      ${paperSigners(p, ro, [['approver', 'Затверджує'], ['head', 'Голова комісії'], ['members', ''], ['agree', 'Погоджено']])}`;
  }

  /** Поля параметрів розрахунку — для одного рядка або для всіх одразу (bulk: порожнє й
   *  «не змінювати» лишають значення рядка як було). Видно лише те, що потрібне обраному способу. */
  function valParamsHtml(v, ed, bulk) {
    const first = bulk ? [[VAL_KEEP, '— не змінювати —']] : [['', '— оберіть —']];
    const cur = (name) => (v[name] == null || (bulk && v[name] === '') ? (bulk ? VAL_KEEP : '') : String(v[name]));
    const on = (name, ...vals) => (bulk && cur(name) === VAL_KEEP) || vals.includes(cur(name));
    const sel = (name, label, options, span = '') => `<div class="field${span}"><label>${label}</label><select name="${name}">${
      first.concat(options).map(([val, text]) => `<option value="${esc(val)}"${cur(name) === String(val) ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></div>`;
    const inp = (name, label, span = '') => `<div class="field${span}"><label>${label}</label>
      <input name="${name}" value="${esc(v[name] ?? '')}" autocomplete="off"${bulk ? ' placeholder="не змінювати"' : ''}></div>`;
    const g = VAL_NORMS.groups.find((x) => x.id === cur('ng'));
    const units = g ? Object.keys(g.use) : Object.keys(VAL_UNIT);
    const gap = g && g.storeGap && decOf(v.storeYears) && decCmp(decOf(v.storeYears), decOf(g.storeGap[0])) > 0
      && decCmp(decOf(v.storeYears), decOf(g.storeGap[1])) <= 0;
    return `<div class="subhead"><b>Первісна вартість</b><span>пункти 5–8 Методики</span></div>
      <div class="form__grid">${sel('group', 'Цінова група', VAL_PRICE_GROUPS, ' field--span2')}
        ${bulk ? '' : inp('price', cur('group') === 'III' ? 'Ціна за контрактом, у валюті' : 'Ціна придбання, грн') + inp('acq', 'Взято на облік (рік або дата)')}
        ${on('group', 'I', 'II', 'III', '') ? inp('ki', 'Коефіцієнт індексації') + inp('kiBasis', 'Підстава коефіцієнта індексації', ' field--span2') : ''}
        ${on('group', 'III') ? inp('rate', 'Курс НБУ на дату розрахунків') + inp('rateBasis', 'Валюта й дата курсу', ' field--span2') : ''}
        ${on('group', 'IV') ? inp('appraisal', 'Первісна вартість за звітом, грн') + inp('appraisalRef', 'Звіт про оцінку: хто склав, номер і дата', ' field--span2') : ''}</div>
      <div class="subhead"><b>Сукупний коефіцієнт зносу</b><span>${ed ? esc(ed.title) : 'редакцію Методики визначає дата складання'}</span></div>
      <div class="form__grid">${sel('method', 'Спосіб розрахунку', [['p21', 'пункт 21 додатка 3: Кскз = КЕ × КЗ × КТС'],
    ['p10', 'пункт 10: втрата внаслідок бойових дій, Кскз = 1']], ' field--span')}
        ${on('method', 'p21') ? `${sel('ng', 'Нормативна група (таблиця 26)', VAL_NORMS.groups.map((x) => [x.id, x.name]), ' field--span')}
          ${sel('mode', 'КЕ визначається', [['use', 'за строком експлуатації'], ['store', 'за строком зберігання']])}
          ${on('mode', 'use') ? sel('termUnit', 'Одиниця строку', units.map((u) => [u, VAL_UNIT[u][0]])) + inp('term', 'Фактичний строк експлуатації') : ''}
          ${on('mode', 'store') ? inp('storeYears', 'Строк зберігання, років') : ''}
          ${gap || (bulk && (v.keOwn || v.keOwnBasis)) ? inp('keOwn', 'КЕ за уточненням') + inp('keOwnBasis', 'Документ, яким уточнено КЕ', ' field--span2') : ''}
          ${sel('cond', 'Умови зберігання (таблиця 27)', VAL_NORMS.kz.map((c, i) => [String(i + 1), c[0]]), ' field--span')}
          ${sel('cat', 'Категорія якісного (технічного) стану', VAL_ROMAN.map((r, i) => [String(i + 1), r]))}` : ''}
        ${on('method', 'p10') ? `${sel('p10.kind', 'Що сталося з майном', VAL_P10_KIND, ' field--span2')}${sel('p10.cause', 'Обставина', VAL_P10_CAUSE, ' field--span2')}
          ${inp('p10.basis', 'Документ, що підтверджує обставини: назва, номер, дата', ' field--span')}
          ${!ed || ed.p10 === 'except' ? sel('p10.order', `Наказ про списання, виданий до ${fmtDate(VAL_NORMS.p10since)}, без затвердженого єдиного акта`,
    [['no', 'не видавався'], ['yes', 'видано, акт не затверджено']], ' field--span2') + inp('p10.orderRef', 'Реквізити наказу, якщо видано') : ''}` : ''}</div>
      <div class="subhead"><b>Коригування</b><span>пункти 9 і 11 Методики</span></div>
      <div class="form__grid">${sel('complete', 'Комплектність', [['yes', 'комплектне'], ['no', 'недоукомплектоване']])}
        ${on('complete', 'no') ? inp('missing', 'Первісна вартість відсутнього, грн') + inp('missingBasis', 'Яких комплектувальних бракує', ' field--span2') : ''}
        ${sel('scrap', 'Нижня межа — вартість брухту', [['na', 'не застосовується'], ['val', 'вартість брухту відома']])}
        ${on('scrap', 'val') ? inp('scrapVal', 'Вартість брухту на одиницю, грн') : ''}
        ${on('scrap', 'na', 'val') ? inp('scrapBasis', cur('scrap') === 'val' ? 'Чим визначено вартість брухту' : 'Чому не застосовується або чим визначено', ' field--span2') : ''}</div>`;
  }
  const VAL_REDRAW = new Set(['group', 'method', 'ng', 'mode', 'termUnit', 'complete', 'scrap', 'storeYears']);
  /** Значення форми → рядок; у режимі «для всіх» — лише заповнене й лише туди, де дозволено. */
  function valApply(ln, v, bulk = false, onlyEmpty = false) {
    const put = (obj, key, val) => {
      const s = String(val ?? '').trim();
      if (bulk && (s === '' || s === VAL_KEEP)) return;
      if (bulk && onlyEmpty && String(obj[key] ?? '').trim()) return;
      obj[key] = s;
    };
    for (const f of (bulk ? [] : VAL_TEXT).concat(VAL_INPUTS)) if (f in v) put(ln, f, v[f]);
    for (const f of VAL_P10) if (`p10.${f}` in v) put(ln.p10 = ln.p10 || {}, f, v[`p10.${f}`]);
  }
  function valLineDialog(p, id) {
    const bulk = id == null;
    const ln = bulk ? null : (p.lines || []).find((x) => x.id === id);
    if (!bulk && !ln) return;
    const ed = valEdition(p.date);
    const v = {};
    if (ln) {
      for (const f of VAL_TEXT.concat(VAL_INPUTS)) v[f] = ln[f] ?? '';
      for (const f of VAL_P10) v[`p10.${f}`] = (ln.p10 || {})[f] ?? '';
    }
    const el = modalOpen(bulk ? `Параметри для всіх рядків (${(p.lines || []).length})` : `Рядок: ${ln.name || ln.code || 'майно'}`, `<form id="val-form">
      ${bulk ? `<div class="panel"><div class="panel__note">Заповніть лише те, що однакове для всіх рядків: порожні поля й «не змінювати» лишають рядки як були.</div>
        <label class="chip"><input type="checkbox" name="onlyEmpty" checked> не змінювати вже вказане в рядку</label></div>`
    : `<div class="form__grid"><div class="field field--span"><label>Найменування, модель, марка</label><input name="name" value="${esc(v.name)}" autocomplete="off"></div>
        <div class="field"><label>Заводський номер</label><input name="serial" value="${esc(v.serial)}" autocomplete="off"></div>
        <div class="field"><label>Інвентарний номер</label><input name="inv" value="${esc(v.inv)}" autocomplete="off"
          title="Номер, під яким майно веде ФЕС; номер служби з бирки сюди не пишуть"></div>
        <div class="field"><label>Одиниця виміру</label><input name="uom" value="${esc(v.uom)}" autocomplete="off"></div>
        <div class="field"><label>Кількість</label><input name="qty" value="${esc(v.qty)}" inputmode="decimal" autocomplete="off"></div>
        <div class="field field--span"><label>Примітка (графа 12)</label><input name="note" value="${esc(v.note)}" autocomplete="off"></div></div>
      <div class="panel"><div class="panel__note">Джерело в обліку: ${esc((ln.src || {}).label || '—')}</div></div>`}
      <div data-val-params></div>
      <div class="pad" style="padding-top:14px"><button class="btn btn--primary" type="submit">${bulk ? 'Застосувати до рядків' : 'Зберегти'}</button>
        <button class="btn" type="button" data-md="close">Скасувати</button></div></form>`);
    const form = el.querySelector('form'), box = el.querySelector('[data-val-params]');
    const read = () => { form.querySelectorAll('[name]').forEach((x) => { if (x.type !== 'checkbox') v[x.name] = x.value; }); };
    const draw = () => { box.innerHTML = valParamsHtml(v, ed, bulk); };
    draw();
    form.addEventListener('change', (e) => {
      read();
      if (!VAL_REDRAW.has(e.target.name)) return;
      if (e.target.name === 'ng') {
        const g = VAL_NORMS.groups.find((x) => x.id === v.ng);
        const units = g ? Object.keys(g.use) : [];
        if (!units.includes(v.termUnit)) v.termUnit = units.length === 1 ? units[0] : (bulk ? VAL_KEEP : '');
      }
      draw();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      read();
      if (bulk) {
        const onlyEmpty = !!form.querySelector('[name="onlyEmpty"]').checked;
        for (const x of p.lines || []) valApply(x, v, true, onlyEmpty);
      } else valApply(ln, v);
      paperMark(p);
      state.paperBad = null;
      modalClose();
      render();
      saveThen(bulk ? 'Параметри рядків збережено.' : 'Рядок збережено.');
    });
  }

  /** «Пояснення розрахунку»: вихідні дані, інтервали таблиць, коефіцієнти, формула, підстави. */
  function valWhy(p, id) {
    const ln = (p.lines || []).find((x) => x.id === id);
    if (!ln) return;
    const need = valFrozen(p) ? [] : valCalcLine(ln, p).need;
    const stale = valStale(ln, p);
    const list = (rows, cls = '') => `<div class="tbl" style="--tbl-min:auto">${rows.map((t) => `<div class="tbl__row tbl__row--plain">
      <div class="c-txt ${cls}" style="white-space:normal">${esc(t)}</div></div>`).join('')}</div>`;
    modalOpen(`Пояснення розрахунку: ${ln.name || ln.code || 'рядок'}`, `<div class="panel"><div class="panel__note">Джерело в обліку: ${
      esc((ln.src || {}).label || '—')}. Кількість ${esc(ln.qty || '—')} ${esc(ln.uom || '')}, ціна придбання ${
      decOf(ln.price) ? `${decUa(decOf(ln.price), 2)} грн` : '—'}, взято на облік: ${esc(ln.acq ? (ln.acq.length > 4 ? fmtDate(ln.acq) : ln.acq) : '—')}.</div></div>
      ${need.length ? `<div class="pad" style="padding-top:12px"><div class="callout callout--bad">Результату немає. Бракує:</div></div>${list(need.map((t) => `${t}.`), 'num-bad')}`
    : stale ? '<div class="pad" style="padding-top:12px"><div class="callout callout--bad">Параметри змінено після розрахунку: результат неактуальний. Натисніть «Розрахувати».</div></div>'
      : list(ln.res.why)}`);
  }

  /** Вибір майна з обліку: партії й одиниці позиції, записи про знищення, рядки документа.
   *  Вибране віддається add(рядки): відомість бере їх як є, акт ЯТС — своїми рядками. */
  function valPick(p, title, add) {
    const st = { tab: 'stock', q: '', code: '', doc: '' };
    const date = p.asOf || p.date || today();
    const el = modalOpen(title, `<div class="panel"><div class="seg">
        <button type="button" data-vp-tab="stock" class="is-on">З обліку</button><button type="button" data-vp-tab="dz">Зі знищеного майна</button>
        <button type="button" data-vp-tab="doc">З документа</button></div>
        <div class="search search--panel"><span>⌕</span><input type="search" data-vp-q placeholder="Пошук" autocomplete="off"></div></div>
      <div data-vp-body style="max-height:52vh;overflow:auto"></div>
      <div class="pad" style="padding-top:12px"><button type="button" class="btn btn--primary" data-vp-add>Додати</button>
        <button type="button" class="btn" data-md="close">Закрити</button> <span class="panel__count" data-vp-msg></span></div>`);
    const body = el.querySelector('[data-vp-body]');
    const row = (cells, attrs = '') => `<div class="tbl__row${attrs ? '' : ' tbl__row--plain'}"${attrs ? ` ${attrs}` : ''}>${cells}</div>`;
    const stockOn = (code) => round3(ledger.reduce((s, e) => (e.code === code && e.d <= date ? s + e.sg * e.q : s), 0));
    const words = () => qWords(st.q);
    const draw = () => {
      el.querySelectorAll('[data-vp-tab]').forEach((b) => b.classList.toggle('is-on', b.dataset.vpTab === st.tab));
      let html = '';
      if (st.tab === 'stock' && !st.code) {
        const list = tzItems().filter((it) => !words().length || hitAll(words(), it.code, it.name)).slice(0, 60);
        html = list.map((it) => row(`<div class="c-code">${esc(it.code)}</div><div class="c-name"><b>${esc(cleanName(it.name))}</b></div>
          <div class="c-unit">${esc(it.unit || '')}</div><div class="c-num" title="Числиться на ${fmtDate(date)}">${fmtNum(stockOn(it.code), '0')}</div>`,
        `data-vp-item="${esc(it.code)}"`)).join('') || row('<div class="c-txt">Позицій за цим пошуком немає.</div>');
      } else if (st.tab === 'stock') {
        const it = itemBy.get(st.code) || {};
        const us = (unitsOf.get(st.code) || []).map((u) => ({ u, a: unitArrival(u.id, '9999-12-31', null) }));
        html = row(`<div class="c-name"><b>${esc(st.code)} · ${esc(cleanName(it.name || ''))}</b><small>числиться на ${fmtDate(date)}: ${
          fmtNum(stockOn(st.code), '0')} ${esc(it.unit || '')}</small></div>
          <div class="c-acts" style="flex-basis:150px"><button type="button" class="btn btn--sm" data-vp-back>← Інша позиція</button></div>`)
          + us.map(({ u, a }) => row(`<div class="c-txt" style="flex:0 0 36px"><input type="checkbox" data-vp-unit="${esc(u.id)}"></div>
            <div class="c-name"><b>${esc(unitLabel(u) || 'одиниця без номера')}</b><small>${esc([u.inv ? `бирка ${u.inv}` : '', u.year ? `${u.year} р.` : '',
    unitHolderAt(u.id, date, null) || 'ніде не числиться'].filter(Boolean).join(' · '))}</small></div>
            <div class="c-num" style="width:120px">${a ? fmtMoney(a.price) : '—'}</div>`)).join('')
          + valBatches(st.code).map((b, i) => row(`<div class="c-num" style="width:86px"><input class="rc-in" data-vp-lot="${i}" inputmode="decimal"
              placeholder="к-сть" aria-label="кількість із партії"></div>
            <div class="c-name"><b>${esc(b.label)}</b><small>надійшло ${fmtNum(b.q)} ${esc(it.unit || '')}</small></div>
            <div class="c-num" style="width:120px">${fmtMoney(b.price)}</div>`)).join('');
      } else if (st.tab === 'dz') {
        const list = allDestroyed().filter((r) => !r.other && (!words().length
          || hitAll(words(), r.code, (itemBy.get(r.code) || {}).name || '', r.report || '', r.sub, r.status))).slice(0, 80);
        html = list.map((r) => row(`<div class="c-txt" style="flex:0 0 36px"><input type="checkbox" data-vp-dz="${esc(r.id)}"></div>
          <div class="c-date">${fmtDate(r.date)}</div><div class="c-name"><b>${esc(cleanName((itemBy.get(r.code) || {}).name || r.code))}</b><small>${
          esc([r.code, r.sub, r.report ? `рапорт ${numNo(r.report)}` : 'без рапорту', r.status].join(' · '))}</small></div>
          <div class="c-num">${fmtNum(r.qty)}</div>`)).join('') || row('<div class="c-txt">Записів про знищення за цим пошуком немає.</div>');
      } else if (!st.doc) {
        const seen = new Map();
        for (const r of docs) if (!seen.has(keyOfRow(r))) seen.set(keyOfRow(r), r);
        const list = [...seen.values()].filter((r) => !words().length || hitAll(words(), r.no, r.from || '', r.to || '', r.t || '')).slice(0, 60);
        html = list.map((r) => row(`<div class="c-date">${fmtDate(r.d)}</div><div class="c-name"><b>${esc(`${r.t || ''} ${numNo(r.no)}`)}</b>
          <small>${esc([r.from, r.to].filter(Boolean).join(' → '))}</small></div>`, `data-vp-doc="${esc(keyOfRow(r))}"`)).join('')
          || row('<div class="c-txt">Документів за цим пошуком немає.</div>');
      } else {
        const rows = docs.filter((r) => keyOfRow(r) === st.doc);
        html = row(`<div class="c-name"><b>${esc(rows[0] ? valDocLabel(rows[0]) : '')}</b></div>
          <div class="c-acts" style="flex-basis:150px"><button type="button" class="btn btn--sm" data-vp-back>← Інший документ</button></div>`)
          + rows.map((r, i) => row(`<div class="c-txt" style="flex:0 0 36px"><input type="checkbox" data-vp-docline="${i}" checked></div>
            <div class="c-name"><b>${esc(cleanName((itemBy.get(r.code) || {}).name || r.code))}</b><small>${esc([r.code,
    r.unit ? unitLabel(unitBy.get(String(r.unit))) : ''].filter(Boolean).join(' · '))}</small></div>
            <div class="c-num">${fmtNum(r.q)}</div><div class="c-num" style="width:120px">${esc(rowParts(r).map((x) => fmtMoney(x.price)).join('; '))}</div>`)).join('');
      }
      body.innerHTML = `<div class="tbl" style="--tbl-min:auto">${html}</div>`;
    };
    draw();
    el.querySelector('[data-vp-q]').addEventListener('input', debounce((e) => { st.q = e.target.value; draw(); }, 200));
    el.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-vp-tab]');
      if (tab) { st.tab = tab.dataset.vpTab; st.code = ''; st.doc = ''; return draw(); }
      if (e.target.closest('[data-vp-back]')) { st.code = ''; st.doc = ''; return draw(); }
      if (e.target.closest('input')) return null;
      const item = e.target.closest('[data-vp-item]'), doc = e.target.closest('[data-vp-doc]');
      if (item) { st.code = item.dataset.vpItem; return draw(); }
      if (doc) { st.doc = doc.dataset.vpDoc; return draw(); }
      if (!e.target.closest('[data-vp-add]')) return null;
      const lines = [], msg = el.querySelector('[data-vp-msg]');
      if (st.tab === 'stock' && st.code) {
        body.querySelectorAll('[data-vp-unit]:checked').forEach((x) => lines.push(...valLinesOfUnit(x.dataset.vpUnit, date)));
        const batches = valBatches(st.code);
        for (const x of body.querySelectorAll('[data-vp-lot]')) {
          const q = decOf(x.value);
          if (!String(x.value).trim()) continue;
          if (!q || q.n <= 0n) { msg.textContent = 'Кількість із партії — число, більше за нуль.'; msg.className = 'panel__count num-bad'; return null; }
          const b = batches[+x.dataset.vpLot];
          lines.push(valLineOf(st.code, { src: { kind: 'lot', doc: b.doc, id: b.id, label: b.label }, qty: decStr(q), price: valMoney(b.price), acq: b.acq }));
        }
      } else if (st.tab === 'dz') {
        const byId = new Map(allDestroyed().map((r) => [String(r.id), r]));
        body.querySelectorAll('[data-vp-dz]:checked').forEach((x) => { const r = byId.get(x.dataset.vpDz); if (r) lines.push(...valLinesOfDz(r)); });
      } else if (st.tab === 'doc' && st.doc) {
        lines.push(...valLinesOfDoc(st.doc, new Set([...body.querySelectorAll('[data-vp-docline]:checked')].map((x) => +x.dataset.vpDocline))));
      }
      if (!lines.length) { msg.textContent = 'Нічого не вибрано.'; msg.className = 'panel__count num-bad'; return null; }
      add(lines);
      paperMark(p);
      save();
      modalClose();
      state.paperBad = null;
      render();
      return toast(`Додано ${cnt(lines.length, 'рядок', 'рядки', 'рядків')}.`);
    });
  }

  /** Відомість у бланку Додатка 1: з розрахованого документа, копією того, що збережено. */
  function valFile(p) {
    if (!valTotal(p).ready) { toast('У Excel іде розрахована відомість: спершу «Розрахувати».', true); return null; }
    const ed = valEdition(p.date);
    const p10 = (p.lines || []).map((ln, i) => (ln.res.rule === 'p10' ? i + 1 : 0)).filter(Boolean);
    return toExcel({ kind: 'valuation', file: `Відомість залишкової вартості ${p.no || 'без номера'} від ${p.date}`,
      unit: (p.unit || {}).name || unitInfo().legalName, no: p.no || '', date: p.date, as_of: p.asOf || '', approved: p.approved || '', basis: p.basis || '', note: p.note || '',
      copies: p.copies || '', norms: `${VAL_NORMS.act}, ${ed ? ed.title : ''}`, p10,
      approver: p.approver || {}, head: p.head || {}, members: (p.members || []).filter(sgFilled), agree: p.agree || {},
      lines: p.lines.map((ln) => ({ name: [ln.name, ln.serial ? `зав. № ${ln.serial}` : '', ln.inv ? `інв. № ${ln.inv}` : ''].filter(Boolean).join(', '),
        uom: ln.uom || '', qty: ln.qty, price: ln.group === 'IV' ? '' : ln.price, year: String(ln.acq || '').slice(0, 4), group: ln.group,
        ki: ln.group === 'IV' ? '' : ln.ki, rate: ln.group === 'III' ? ln.rate : '', vp: ln.res.vp, base: ln.res.base,
        missing: ln.complete === 'no' ? ln.missing : '', ke: ln.res.ke, kz: ln.res.kz, kts: ln.res.kts, k: ln.res.k, rule: ln.res.rule,
        unit: ln.res.unit, floor: !!ln.res.floor, sum: ln.res.sum, note: ln.note || '' })),
      total: valTotal(p).sum });
  }

  function valAction(act, d, p) {
    const shown = state.paperVer ? ((p.versions || []).find((v) => v.ver === state.paperVer) || {}).body || p : p;
    switch (act) {
      case 'val-why': return valWhy(shown, d.id);
      case 'val-to-act': {
        if (!(shown.lines || []).length) return toast('У відомості ще немає майна.', true);
        const a = actFromValuation(shown);
        save();
        return go('yats', { paperId: a.id, paperVer: 0, paperBad: null,
          flash: `Акт складено за відомістю ${numNo(shown.no || 'б/н')}: майно й комісію перенесено, стан і висновок заповнює комісія.` });
      }
      default: break;
    }
    if (!paperOpen(p) || state.paperVer) return null;
    switch (act) {
      case 'val-calc': {
        const bad = valCalc(p);
        const t = valTotal(p);
        p.norms = VAL_NORMS.id;                         // версія нормативного довідника, за якою рахували
        paperMark(p, bad.length ? '' : `розраховано: ${decUa(decOf(t.sum), 2)} грн`);
        save();
        state.paperBad = bad;
        state.flash = bad.length ? `Розраховано рядків: ${t.n} із ${p.lines.length}. Решті бракує даних — перелік нижче.`
          : `Розраховано: ${cnt(t.n, 'рядок', 'рядки', 'рядків')} на ${decUa(decOf(t.sum), 2)} грн.`;
        return render();
      }
      case 'val-pick': return valPick(p, 'Додати майно до відомості', (lines) => { p.lines = (p.lines || []).concat(lines); });
      case 'val-bulk': return (p.lines || []).length ? valLineDialog(p, null) : toast('Спершу додайте майно.', true);
      case 'val-line': return valLineDialog(p, d.id);
      case 'val-line-del': {
        const ln = (p.lines || []).find((x) => x.id === d.id);
        if (!ln || !confirm(`Прибрати рядок «${ln.name || ln.code}» з відомості?`)) return null;
        p.lines = p.lines.filter((x) => x !== ln);
        paperMark(p);
        save();
        return render();
      }
      default: return null;
    }
  }

  // ================================================================ АКТИ ЯТС
  /** Акт якісного (технічного) стану — Додаток 1 до Порядку списання військового майна. Таблиця
   *  має дві частини: майно, що списується (`lines`), і майно, що оприбутковується (`income`);
   *  друга заповнюється лише тоді, коли є що оприбутковувати, і з першої не копіюється. Суми
   *  рахує програма з кількості й ціни. Тексти про стан і висновок пише комісія: програма їх не
   *  складає. Акт — документ: ні залишків, ні категорії стану одиниці він сам не змінює. */
  const ACT_TERM_UNITS = ['років', 'місяців', 'годин'];
  const ACT_TEXTS = [['complete', 'Комплектність'], ['storage', 'Умови зберігання'], ['defects', 'Виявлені дефекти й пошкодження'],
    ['repair', 'Можливість і доцільність відновлення'], ['catNew', 'Запропонована категорія'], ['conclusion', 'Висновок комісії'],
    ['grounds', 'Підстави висновку'], ['senior', 'Висновок старшого начальника']];
  const ACT_CODES = [['infoMark', 'Ознака інформації (000)'], ['regNo', 'Реєстраційний номер (001)'], ['sheetNo', 'Номер аркуша (002)'],
    ['docCode', 'Код документа (003)'], ['opCode', 'Код операції (004)']];
  const ACT_OFF = ['name', 'serial', 'inv', 'code', 'uom', 'cat', 'qty', 'price', 'normTerm', 'normUnit', 'factTerm', 'factUnit'];
  const ACT_IN = ['name', 'code', 'uom', 'cat', 'qty', 'price'];
  /** Сума рядка — кількість × ціна до копійки; без кількості чи ціни суми немає. */
  function actSum(ln) {
    const q = decOf(ln.qty), pr = decOf(ln.price);
    return q && pr && q.n > 0n && pr.n >= 0n ? decRound(decMul(q, pr), 2) : null;
  }
  function actSums(list) {
    let sum = decOf('0'), ok = true;
    for (const ln of list || []) { const s = actSum(ln); if (s) sum = decAdd(sum, s); else ok = false; }
    // Кількість різного майна в один підсумок не складається: лише коли одиниця виміру одна.
    const uoms = new Set((list || []).map((ln) => String(ln.uom || '').trim().toLowerCase()));
    const qty = ok && uoms.size === 1 ? (list || []).reduce((a, ln) => decAdd(a, decOf(ln.qty)), decOf('0')) : null;
    return { sum: decStr(sum, 2), qty: qty ? decStr(qty) : '', ok: ok && (list || []).length > 0 };
  }
  const actTerm = (v, unit) => (String(v ?? '').trim() ? `${String(v).trim()} ${unit || ''}`.trim() : '');
  const actTitle = (p) => String(p.title || '').trim() || ((p.lines || []).length === 1 ? p.lines[0].name
    : (p.lines || []).length ? 'військового майна згідно з переліком' : '');

  PAPER_UI.tech_act = {
    blank: () => ({ title: '', purpose: '', service: unitInfo().serviceFull || '', nomenNo: '', accMain: '', accCorr: '', infoMark: '', regNo: '',
      sheetNo: '', docCode: '', opCode: '', opDate: '', income: [], valId: '', complete: '', storage: '', defects: '', repair: '', catNew: '',
      conclusion: '', grounds: '', senior: '' }),
    what: (p) => { const l = (p.lines || []).concat(p.income || []); return l.length ? `${l[0].name || l[0].code || 'майно'}${l.length > 1 ? ` і ще ${l.length - 1}` : ''}` : ''; },
    total: (p) => { const t = actSums(p.lines); return { sum: t.sum, ready: t.ok }; },
    actions: () => '',
    check: actCheck,
    body: actBody,
    bind: () => {},
    file: actFile,
    action: actAction,
  };

  /** Чого бракує акту до готового документа. */
  function actCheck(p) {
    const bad = [];
    if (!String(p.no || '').trim()) bad.push('Не вказано номер акта.');
    if (!p.date) bad.push('Не вказано дату акта.');
    if (!(p.lines || []).length && !(p.income || []).length) bad.push('В акті немає жодного рядка майна.');
    (p.lines || []).forEach((ln, i) => {
      const row = `Рядок ${i + 1} (списати)`;
      if (!String(ln.name || '').trim()) bad.push(`${row}: не вказано найменування.`);
      if (!String(ln.uom || '').trim()) bad.push(`${row}: не вказано одиницю виміру.`);
      const q = decOf(ln.qty), pr = decOf(ln.price);
      if (!q || q.n <= 0n) bad.push(`${row}: не вказано кількість.`);
      if (!pr || pr.n < 0n) bad.push(`${row}: не вказано ціну за одиницю.`);
      if (String(ln.normTerm || '').trim() && !ln.normUnit) bad.push(`${row}: строк експлуатації за нормою без одиниці (років, місяців чи годин).`);
      if (String(ln.factTerm || '').trim() && !ln.factUnit) bad.push(`${row}: фактичний строк експлуатації без одиниці (років, місяців чи годин).`);
    });
    (p.income || []).forEach((ln, i) => {
      const row = `Рядок ${i + 1} (оприбуткувати)`;
      if (!String(ln.name || '').trim()) bad.push(`${row}: не вказано найменування.`);
      const q = decOf(ln.qty), pr = decOf(ln.price);
      const hasQ = q && q.n > 0n, hasP = pr && pr.n >= 0n && String(ln.price ?? '').trim() !== '';
      if (hasP && !hasQ) bad.push(`${row}: вказано ціну без кількості.`);
      else if (hasQ && !hasP) bad.push(`${row}: вказано кількість без залишкової вартості за одиницю.`);
      else if (!hasQ) bad.push(`${row}: не вказано кількість і залишкову вартість за одиницю.`);
    });
    if (!String(p.conclusion || '').trim()) bad.push('Не вказано висновок комісії.');
    if (!sgFilled(p.approver)) bad.push('Не вказано, хто затверджує акт.');
    if (!sgFilled(p.head)) bad.push('Не вказано голову комісії.');
    if (!(p.members || []).some(sgFilled)) bad.push('Не вказано жодного члена комісії.');
    return bad;
  }

  function actBody(p, ro) {
    const dis = ro ? ' disabled' : '';
    const f = (field, label, type = 'text', span = '', extra = '') => `<div class="field${span}"><label>${label}</label>
      <input type="${type}" data-pf="${field}" data-fid="pf:${field}" value="${esc(p[field] || '')}" autocomplete="off"${extra}${dis}></div>`;
    const d = (x, n = null) => (x ? decUa(x, n) : '—');
    const cat = (c) => VAL_ROMAN[+c - 1] || '—';
    const table = (list, key, off) => {
      const t = actSums(list);
      const rows = (list || []).map((ln, i) => `<div class="tbl__row tbl__row--plain${actSum(ln) ? '' : ' is-due'}">
        <div class="c-num c-num--dim" style="width:34px">${i + 1}</div>
        <div class="c-name c-name--stack" style="flex:2 1 220px"><b>${esc(ln.name || '—')}</b><small>${esc([ln.serial ? `зав. № ${ln.serial}` : '',
          ln.inv ? `інв. № ${ln.inv}` : '', (ln.src || {}).label || ''].filter(Boolean).join(' · '))}</small></div>
        <div class="c-code" style="width:70px">${esc(ln.code || '—')}</div><div class="c-unit" style="width:50px">${esc(ln.uom || '—')}</div>
        <div class="c-num" style="width:44px">${cat(ln.cat)}</div>
        <div class="c-num" style="width:64px">${d(decOf(ln.qty))}</div><div class="c-num" style="width:104px">${d(decOf(ln.price), 2)}</div>
        <div class="c-num" style="width:112px"><b>${d(actSum(ln), 2)}</b></div>
        ${off ? `<div class="c-txt" style="flex:0 0 96px">${esc(actTerm(ln.normTerm, ln.normUnit) || '—')}</div>
        <div class="c-txt" style="flex:0 0 96px">${esc(actTerm(ln.factTerm, ln.factUnit) || '—')}</div>` : ''}
        <div class="c-acts" style="flex-basis:150px">${ro ? '' : rowBtn('yats-line', '✎ Рядок', `data-id="${esc(ln.id)}" data-list="${key}"`)
          + rowBtn('yats-line-del', '✕', `data-id="${esc(ln.id)}" data-list="${key}"`, { bad: true, title: 'Прибрати рядок' })}</div></div>`).join('');
      return `<div class="card--scroll"><div class="tbl" style="--tbl-min:${off ? 1040 : 850}px"><div class="tbl__head">
        <div class="tbl__h c-num" style="width:34px">№</div><div class="tbl__h c-name" style="flex:2 1 220px">найменування, номер</div>
        <div class="tbl__h c-code" style="width:70px">код</div><div class="tbl__h c-unit" style="width:50px">од.</div>
        <div class="tbl__h c-num" style="width:44px">кат.</div><div class="tbl__h c-num" style="width:64px">к-сть</div>
        <div class="tbl__h c-num" style="width:104px">${off ? 'ціна' : 'залишкова'}</div><div class="tbl__h c-num" style="width:112px">сума, грн</div>
        ${off ? `<div class="tbl__h c-txt" style="flex:0 0 96px" title="Експлуатується за нормою">за нормою</div>
        <div class="tbl__h c-txt" style="flex:0 0 96px" title="Експлуатується фактично">фактично</div>` : ''}
        <div class="tbl__h c-acts" style="flex-basis:150px"></div></div>
        ${rows || `<div class="tbl__row tbl__row--plain"><div class="c-txt">${off ? (ro ? 'Рядків немає.' : 'Додайте майно: «+ Додати майно» або «+ Рядок».')
    : 'Заповнюється, коли є що оприбутковувати.'}</div></div>`}
        ${(list || []).length ? `<div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-num" style="width:34px"></div>
          <div class="c-name" style="flex:2 1 220px"><b>Усього</b></div><div class="c-code" style="width:70px"></div><div class="c-unit" style="width:50px"></div>
          <div class="c-num" style="width:44px"></div><div class="c-num" style="width:64px">${t.qty ? decUa(decOf(t.qty)) : ''}</div>
          <div class="c-num" style="width:104px"></div><div class="c-num" style="width:112px"><b>${t.ok ? decUa(decOf(t.sum), 2) : '—'}</b></div>
          ${off ? '<div class="c-txt" style="flex:0 0 96px"></div><div class="c-txt" style="flex:0 0 96px"></div>' : ''}
          <div class="c-acts" style="flex-basis:150px"></div></div>` : ''}</div></div>`;
    };
    const vals = papers().filter((x) => x.kind === 'valuation' && x.state !== 'скасовано');
    const linked = p.valId ? paperById(p.valId) : null;
    return `<div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Реквізити</div>
        <div class="panel__spacer"></div>${linked ? `<span class="panel__count">за відомістю ${esc(numNo(linked.no || 'б/н'))}</span>
        <button type="button" class="btn btn--sm" data-act="paper-open" data-id="${esc(linked.id)}">Відкрити відомість</button>` : ''}</div>
      <div class="form__grid">${f('no', 'Номер акта (005)')}${f('date', 'Дата акта (032)', 'date')}
        ${f('title', 'Майно в заголовку акта', 'text', ' field--span2', ` placeholder="${esc(actTitle(p))}"`)}
        ${f('purpose', 'Підстава (мета) операції (045)', 'text', ' field--span2')}${f('service', 'Служба (046)')}
        ${f('opDate', 'Дата операції (034)', 'date')}${ACT_CODES.map(([k, label]) => f(k, label)).join('')}
        ${f('nomenNo', 'Номенклатурний номер')}${f('accMain', 'Основний рахунок')}${f('accCorr', 'Кореспондентський рахунок')}
        <div class="field"><label>Відомість залишкової вартості</label><select data-pf="valId" data-fid="pf:valId"${dis}><option value="">—</option>${
    vals.map((x) => `<option value="${esc(x.id)}"${x.id === p.valId ? ' selected' : ''}>${esc(`${numNo(x.no || 'б/н')} від ${fmtDate(x.date)}`)}</option>`).join('')}</select></div>
      </div></div>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Списати</div><div class="panel__spacer"></div>
        ${ro ? '' : `<button type="button" class="btn btn--sm" data-act="yats-line-new" data-list="lines">+ Рядок</button>
        <button type="button" class="btn btn--sm btn--primary" data-act="yats-pick">+ Додати майно</button>`}</div>${table(p.lines, 'lines', true)}</div>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Оприбуткувати</div><div class="panel__spacer"></div>
        ${ro ? '' : '<button type="button" class="btn btn--sm" data-act="yats-line-new" data-list="income">+ Рядок</button>'}</div>${table(p.income, 'income', false)}</div>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Технічний стан і висновок</div>
        <div class="panel__spacer"></div><span class="panel__count">тексти пише комісія</span></div>
        <div class="form__grid">${ACT_TEXTS.map(([k, label]) => `<div class="field field--span2"><label>${label}</label>
          <textarea data-pf="${k}" data-fid="pf:${k}" rows="${k === 'conclusion' ? 4 : 2}"${dis}>${esc(p[k] || '')}</textarea></div>`).join('')}</div></div>
      ${paperSigners(p, ro, [['approver', 'Затверджує'], ['head', 'Голова комісії'], ['members', '']])}`;
  }

  function actLineDialog(p, key, id) {
    const off = key === 'lines';
    const list = p[key] = p[key] || [];
    const ln = id ? list.find((x) => x.id === id) : null;
    if (id && !ln) return;
    const v = ln || {};
    const inp = (name, label, span = '', attrs = '') => `<div class="field${span}"><label>${label}</label>
      <input name="${name}" value="${esc(v[name] ?? '')}" autocomplete="off"${attrs}></div>`;
    const sel = (name, label, options) => `<div class="field"><label>${label}</label><select name="${name}"><option value="">—</option>${
      options.map(([val, text]) => `<option value="${esc(val)}"${String(v[name] ?? '') === String(val) ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></div>`;
    const el = modalOpen(`${off ? 'Списати' : 'Оприбуткувати'}: ${ln ? ln.name || 'рядок' : 'новий рядок'}`, `<form id="yats-form"><div class="form__grid">
        ${inp('name', off ? 'Найменування військового майна' : 'Найменування озброєння (техніки, майна)', ' field--span')}
        ${off ? inp('serial', 'Заводський номер') + inp('inv', 'Інвентарний номер', '',
          ' title="Номер, під яким майно веде ФЕС; номер служби з бирки сюди не пишуть"') : ''}
        ${inp('code', 'Код номенклатури')}${inp('uom', 'Одиниця виміру')}${sel('cat', 'Категорія', VAL_ROMAN.map((r, i) => [String(i + 1), r]))}
        ${inp('qty', 'Кількість', '', ' inputmode="decimal"')}${inp('price', off ? 'Ціна за одиницю, грн' : 'Залишкова вартість за одиницю, грн', '', ' inputmode="decimal"')}
        ${off ? inp('normTerm', 'Експлуатується за нормою') + sel('normUnit', 'Одиниця строку за нормою', ACT_TERM_UNITS.map((u) => [u, u]))
          + inp('factTerm', 'Експлуатується фактично') + sel('factUnit', 'Одиниця фактичного строку', ACT_TERM_UNITS.map((u) => [u, u])) : ''}</div>
      ${ln && (ln.src || {}).label ? `<div class="panel"><div class="panel__note">Джерело в обліку: ${esc(ln.src.label)}</div></div>` : ''}
      <div class="pad" data-yats-msg hidden style="padding-top:10px;color:var(--bad)"></div>
      <div class="pad" style="padding-top:14px"><button class="btn btn--primary" type="submit">Зберегти</button>
        <button class="btn" type="button" data-md="close">Скасувати</button></div></form>`);
    el.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const row = ln || { id: uid() };
      for (const k of off ? ACT_OFF : ACT_IN) row[k] = String(fd.get(k) ?? '').trim();
      const bad = [];
      for (const [k, label] of [['qty', 'Кількість'], ['price', off ? 'Ціна' : 'Залишкова вартість']]) {
        if (row[k] && (!decOf(row[k]) || decOf(row[k]).n < 0n)) bad.push(`${label} — число, не менше за нуль.`);
      }
      const msg = el.querySelector('[data-yats-msg]');
      if (bad.length) { msg.hidden = false; msg.innerHTML = bad.map(esc).join('<br>'); return; }
      if (!ln) list.push(row);
      paperMark(p);
      state.paperBad = null;
      modalClose();
      render();
      saveThen('Рядок акта збережено.');
    });
    el.querySelector('input[name="name"]').focus();
  }

  /** Акт у Word за бланком: з того, що збережено в документі. */
  function actFile(p) {
    if (!(p.lines || []).length && !(p.income || []).length) { toast('В акті ще немає жодного рядка майна.', true); return null; }
    const row = (ln, off) => ({ name: [ln.name, off && ln.serial ? `зав. № ${ln.serial}` : '', off && ln.inv ? `інв. № ${ln.inv}` : ''].filter(Boolean).join(', '),
      code: ln.code || '', uom: ln.uom || '', cat: VAL_ROMAN[+ln.cat - 1] || '', qty: ln.qty || '', price: ln.price || '',
      sum: actSum(ln) ? decStr(actSum(ln), 2) : '', norm: off ? actTerm(ln.normTerm, ln.normUnit) : '', fact: off ? actTerm(ln.factTerm, ln.factUnit) : '' });
    const text = {};
    for (const [k] of ACT_TEXTS) text[k] = p[k] || '';
    return toExcel({ kind: 'tech_act', word: true, file: `Акт ЯТС ${p.no || 'без номера'} від ${p.date}`, unit: (p.unit || {}).code || unitCode(), no: p.no || '', date: p.date || '',
      title: actTitle(p), purpose: p.purpose || '', service: p.service || '', op_date: p.opDate || '',
      codes: Object.fromEntries(ACT_CODES.map(([k]) => [k, p[k] || ''])), nomen_no: p.nomenNo || '', acc_main: p.accMain || '', acc_corr: p.accCorr || '',
      off: (p.lines || []).map((ln) => row(ln, true)), income: (p.income || []).map((ln) => row(ln, false)),
      off_total: actSums(p.lines), in_total: actSums(p.income), text,
      approver: p.approver || {}, head: p.head || {}, members: (p.members || []).filter(sgFilled) });
  }

  /** Акт за відомістю залишкової вартості: майно й номери переходять без повторного введення;
   *  частина «оприбуткувати» лишається порожньою — її заповнює комісія. */
  function actFromValuation(v) {
    const p = paperNew('tech_act');
    Object.assign(p, { valId: v.id, purpose: v.basis || '', lines: (v.lines || []).map((ln) => ({ id: uid(), src: JSON.parse(JSON.stringify(ln.src || {})),
      code: ln.code || '', name: ln.name || '', serial: ln.serial || '', inv: ln.inv || '', uom: ln.uom || '', cat: ln.method === 'p21' ? ln.cat || '' : '',
      qty: ln.qty || '', price: ln.group === 'IV' ? '' : ln.price || '', normTerm: '', normUnit: '', factTerm: '', factUnit: '' })),
    head: JSON.parse(JSON.stringify(v.head || sgOf(null))), members: JSON.parse(JSON.stringify(v.members || [])),
    approver: JSON.parse(JSON.stringify(v.approver || sgOf(null))) });
    paperMark(p, `складено за відомістю ${numNo(v.no || 'б/н')} від ${fmtDate(v.date)}`);
    return p;
  }

  function actAction(act, d, p) {
    if (!paperOpen(p) || state.paperVer) return null;
    const list = d.list === 'income' ? 'income' : 'lines';
    switch (act) {
      case 'yats-pick': return valPick(p, 'Додати майно до акта', (lines) => {
        p.lines = (p.lines || []).concat(lines.map((ln) => {
          const u = (ln.src || {}).unit ? unitBy.get(String(ln.src.unit)) : null;
          return { id: ln.id, src: ln.src, code: ln.code, name: ln.name, serial: ln.serial, inv: ln.inv, uom: ln.uom,
            cat: u ? String(catAt(u, p.date || today()) || '') : '', qty: ln.qty, price: ln.price, normTerm: '', normUnit: '', factTerm: '', factUnit: '' };
        }));
      });
      case 'yats-line-new': return actLineDialog(p, list, null);
      case 'yats-line': return actLineDialog(p, list, d.id);
      case 'yats-line-del': {
        const ln = (p[list] || []).find((x) => x.id === d.id);
        if (!ln || !confirm(`Прибрати рядок «${ln.name || ln.code || 'без назви'}» з акта?`)) return null;
        p[list] = p[list].filter((x) => x !== ln);
        paperMark(p);
        save();
        return render();
      }
      default: return null;
    }
  }

  // ============================================================ ІМПОРТ ІСТОРІЇ
  /** Історія з Excel. Нова служба починає з чистої бази, а її журнали з 2022 року лежать у
   *  власних книгах. Файл за шаблоном програми (аркуші «Підрозділи», «Номенклатура»,
   *  «Документи») читає сервер, а тут його рядки проходять ті самі перевірки, що й форма
   *  документа, — у порядку дат, ніби документи вносили один за одним. Файл вноситься
   *  цілком або ніяк: історія, внесена наполовину, гірша за невнесену. */
  const IMP_KIND = { 'прихід': 'in', 'переміщення': 'mv', 'вибуття': 'wr', 'списання': 'wr', 'передача': 'wr',
    'знищення': 'dz', 'рапорт': 'dz', 'рапорт про знищення': 'dz' };
  const IMP_ORDER = { in: 0, mv: 1, wr: 2, dz: 3 };
  const IMP_SHEET = { subs: 'Підрозділи', items: 'Номенклатура', docs: 'Документи' };
  const IMP_SHOWN = 200;
  const impYes = (v) => /^(так|т|\+|1|true|yes|y)$/i.test(String(v || '').trim());

  /** Нові підрозділи з аркуша. Наявних не чіпає; підпорядкування — за назвою з програми
   *  або з того самого аркуша. */
  function impSubs(rows, bad) {
    const fresh = [];
    const names = new Set(rows.map((r) => r.name).filter(Boolean));
    const seen = new Set();
    for (const r of rows) {
      const err = (text) => bad.push({ sheet: IMP_SHEET.subs, row: r.row, text });
      if (!r.name) { err('немає назви підрозділу'); continue; }
      if (r.name.includes('|')) { err(`«${r.name}»: у назві не ставте «|»`); continue; }
      if (subBy.has(r.name) || seen.has(r.name)) continue;
      seen.add(r.name);
      if (r.parent === r.name) { err(`«${r.name}» підпорядкований сам собі`); continue; }
      if (r.parent && !subBy.has(r.parent) && !names.has(r.parent)) {
        err(`«${r.name}»: підрозділу «${r.parent}», якому він підпорядкований, немає ні в програмі, ні на аркуші`);
        continue;
      }
      const type = String(r.type || '').trim().toLowerCase() || 'рота';
      if (!SUB_KINDS.includes(type)) { err(`«${r.name}»: виду «${r.type}» немає. Є: ${SUB_KINDS.join(', ')}`); continue; }
      // Розформований підрозділ лишається в історії, але в нових документах його немає.
      const closed = impYes(r.closed);
      fresh.push({ id: uid(), name: r.name, parent: r.parent || '', type, active: !closed,
        note: r.note || (closed ? 'закритий' : '') });
    }
    // Підпорядкування по колу («А → Б → А») дерево не витримає: кожен рядок кола —
    // помилка з рядками файла, які його утворюють.
    const parentOf = new Map(subs.map((s) => [s.name, s.parent || '']));
    for (const s of fresh) parentOf.set(s.name, s.parent);
    const rowOf = new Map(rows.filter((r) => r.name).map((r) => [r.name, r.row]));
    const looped = new Set();
    for (const s of fresh) {
      const seen = [];
      let cur = s.name;
      while (cur && !seen.includes(cur)) { seen.push(cur); cur = parentOf.get(cur) || ''; }
      if (!cur || looped.has(s.name)) continue;
      const loop = seen.slice(seen.indexOf(cur)).concat(cur);
      looped.add(s.name);
      bad.push({ sheet: IMP_SHEET.subs, row: rowOf.get(s.name),
        text: `«${s.name}»: підпорядкування по колу — ${loop.map((n) => `«${n}»`).join(' → ')}`
          + ` (рядки ${[...new Set(loop.map((n) => rowOf.get(n)).filter(Boolean))].join(', ')})` });
    }
    return fresh.filter((s) => !looped.has(s.name));
  }

  /** Нові позиції з аркуша. Позиція, яка вже є в програмі, лишається як є: файл її не править. */
  function impItems(rows, bad, warn) {
    const fresh = [];
    const seen = new Map();
    const groupOf = (v) => {
      const t = String(v || '').trim();
      if (!t) return groupName.has('21.18') ? '21.18' : (D.groups[D.groups.length - 1] || [''])[0];
      if (groupName.has(t)) return t;
      const hit = D.groups.find(([, label]) => String(label).toLowerCase() === t.toLowerCase());
      return hit ? hit[0] : null;
    };
    for (const r of rows) {
      const err = (text) => bad.push({ sheet: IMP_SHEET.items, row: r.row, text });
      if (!r.code) { err('немає коду позиції'); continue; }
      if (seen.has(r.code)) { err(`код ${r.code} уже є в рядку ${seen.get(r.code)}`); continue; }
      seen.set(r.code, r.row);
      const have = itemBy.get(r.code);
      if (have) {
        if (r.name && normName(r.name) !== normName(have.name)) {
          warn.push({ sheet: IMP_SHEET.items, row: r.row,
            text: `код ${r.code} у програмі «${have.name}», у файлі «${r.name}». Лишається назва програми` });
        }
        continue;
      }
      if (!r.name) { err(`код ${r.code}: немає найменування`); continue; }
      if (!r.unit) { err(`код ${r.code}: немає одиниці виміру`); continue; }
      const group = groupOf(r.group);
      if (group == null) { err(`код ${r.code}: розділу «${r.group}» у табелі 21/Прод немає`); continue; }
      if (r.price === '?' || (r.price != null && !(r.price >= 0))) { err(`код ${r.code}: ціна не число`); continue; }
      const fes = String(r.fes || '').replace(/\s+/g, '');
      if (fes && !/^\d+$/.test(fes)) { err(`код ${r.code}: номер ФЕС пишуть лише цифрами`); continue; }
      // Номер ФЕС вирішує вид обліку так само, як у картці позиції: десять цифр із класом 10 чи 11.
      const byFes = fes ? fes.length === 10 && /^1[01]/.test(fes) : null;
      fresh.push({ code: r.code, name: r.name, unit: r.unit, group, price: Math.round((r.price || 0) * 100) / 100,
        nonrev: byFes ?? impYes(r.nonrev), fes, note: r.note || '', old: '', archived: '' });
    }
    return fresh;
  }

  /** Рядки аркуша «Документи» — у документи: той самий вид, дата, номер і маршрут складають
   *  один документ. Порядок — за датою; того самого дня спершу прихід, потім переміщення,
   *  вибуття й рапорти, а серед рівних — як у файлі. */
  function impDocs(rows, bad, priceOf, broken, warn = []) {
    const by = new Map();
    const named = new Set();
    rows.forEach((r, n) => {
      // Назва в рядку — для звірки з кодом: жодного спільного слова з назвою позиції — схоже, код не той.
      const it = r.name && r.code && !named.has(r.code) ? itemBy.get(r.code) : null;
      if (it && !mtzAlike(r.name, it.name)) {
        named.add(r.code);
        warn.push({ sheet: IMP_SHEET.docs, row: r.row, text: `код ${r.code} у програмі «${it.name}», у рядку «${r.name}». Перевірте код` });
      }
      const word = String(r.kind || '').trim().toLowerCase();
      const k = IMP_KIND[word];
      // Рядок приходу чи переміщення, який не пройшов, — це майно, якого далі бракуватиме.
      const err = (text) => {
        bad.push({ sheet: IMP_SHEET.docs, row: r.row, text });
        if (r.code && k !== 'wr' && k !== 'dz') broken.add(r.code);
      };
      const no = String(r.no || '').trim();
      const found = bad.length;
      if (!word) err('не вказано вид документа');
      else if (!k) err(`вид «${r.kind}» не розпізнано. Є: Прихід, Переміщення, Вибуття, Знищення`);
      if (!no) err('немає номера документа');
      if (!r.date) err(r.dateText ? `дата «${r.dateText}» не читається. Пишіть як 15.03.2022` : 'немає дати документа');
      if (!r.code) err('немає коду позиції');
      if (r.qty == null) err('немає кількості');
      else if (r.qty === '?' || !(r.qty > 0)) err('кількість має бути числом, більшим за нуль');
      if (r.price === '?' || (r.price != null && !(r.price >= 0))) err('ціна не число');
      if (bad.length > found) return;
      const from = String(r.from || '').trim();
      const to = k === 'in' ? String(r.to || '').trim() || 'склад' : k === 'dz' ? '' : String(r.to || '').trim();
      const key = [k, r.date, normNo(no), from, to].join('\u0000');
      let d = by.get(key);
      if (!d) {
        d = { k, n, row: r.row, lines: [],
          h: { type: r.type || MOVE_KINDS.find(([kk]) => kk === k)[2], no, date: r.date, from, to, basis: '', note: '',
            report: '', reportDate: '', act: '' } };
        by.set(key, d);
      }
      if (!d.h.basis && r.basis) d.h.basis = r.basis;
      if (k === 'dz' && !d.h.act && r.act) d.h.act = r.act;
      // Ціна: у приході — з рядка, а без неї — з аркуша «Номенклатура»; у рапорті — лише своя.
      const price = r.price != null ? r.price : (k === 'in' ? priceOf(r.code) : null);
      const ln = { code: r.code, qty: String(r.qty), price: (k === 'in' || k === 'dz') && price != null ? String(price) : '',
        note: r.note || '', lot: '', unit: '', row: r.row };
      // Та сама позиція двома рядками журналу (дві кухні — два рядки) — один рядок документа з сумою.
      const twin = k === 'dz' ? null : d.lines.find((x) => x.code === ln.code && x.price === ln.price && x.note === ln.note);
      if (twin) twin.qty = String(round3(+twin.qty + r.qty));
      else d.lines.push(ln);
    });
    return [...by.values()].sort((a, b) => (a.h.date < b.h.date ? -1 : a.h.date > b.h.date ? 1 : 0)
      || IMP_ORDER[a.k] - IMP_ORDER[b.k] || a.n - b.n);
  }

  /** Один документ файла — в облік, як його провела б форма: ті самі перевірки, той самий
   *  запис у журнал. Помилка лишає облік без цього документа й називає рядок файла. */
  function impPost(d, bad, warn, stat, broken) {
    const { k, h, lines } = d;
    const label = `${h.type} ${numNo(h.no)} від ${fmtDate(h.date)}`;
    // Прихід чи переміщення не пройшли — їхніх позицій далі бракуватиме. «Немає в наявності» за
    // такою позицією — наслідок, а не нова помилка: у звіт іде першопричина, наслідки лише лічаться.
    // Вибуття й рапорт, що не пройшли, нестачі далі не дають.
    const tainted = lines.some((l) => broken.has(l.code));
    let hidden = false;
    const fail = () => {
      if (k === 'in' || k === 'mv') for (const l of lines) broken.add(l.code);
      if (hidden) stat.after++;
    };
    const err = (text, row = d.row) => {
      if (tainted && /числиться|від’ємним/.test(text)) hidden = true;
      else bad.push({ sheet: IMP_SHEET.docs, row, text: `${label}: ${text}` });
    };
    // Форма дає вибрати підрозділ із переліку, файл — ні: назва має бути в довіднику.
    const found = bad.length;
    for (const [side, s] of (k === 'in' ? [['Кому', h.to]] : k === 'mv' ? [['Від кого', h.from], ['Кому', h.to]]
      : [['Від кого', h.from]])) {
      if (s && !subBy.has(s)) err(`«${side}»: підрозділу «${s}» немає ні в програмі, ні на аркуші «Підрозділи»`);
    }
    for (const ln of lines) {
      if (!itemBy.has(ln.code)) err(`коду ${ln.code} немає ні в програмі, ні на аркуші «Номенклатура»`, ln.row);
    }
    if (bad.length > found) { fail(); return; }
    // Документ, який уже є в обліку, файл удруге не вносить: той самий файл можна доповнити й подати знову.
    const there = k === 'dz'
      ? allDestroyed().some((x) => x.date === h.date && normNo(x.report) === normNo(h.no) && x.sub === h.from
        && lines.some((l) => l.code === x.code))
      : docs.some((r) => r.kind === k && r.d === h.date && normNo(r.no) === normNo(h.no) && r.from === h.from
        && (r.to || '') === (h.to || ''));
    if (there) { stat.skipped++; return; }
    state.moveKind = k;
    const dr = { kind: k, head: h, lines, warn: [] };
    const issues = checkDraft(dr, h, k);
    if (issues.length) { for (const t of issues) err(t); fail(); return; }
    const codes = new Set(lines.map((x) => x.code));
    // Номери в старих паперах повторюються законно: про повтор номера звіт мовчить, як і режим «вношу історію».
    const notes = dr.warn.filter((t) => !/ уже є (в обліку|на інший маршрут)/.test(t));
    if (k === 'dz') {
      const was = dzProfile(codes);
      for (const ln of lines) store.destroyed.push(dzRecord(h, ln, uid(), 'program'));
      dzCache = null;
      const over = newDzOver(codes, was);
      if (over) notes.push(dzOverMessage(over));
    } else {
      const before = negProfile(codes);
      const was = k === 'mv' ? dzProfile(codes) : null;
      const arr = store.docs[STORE_OF[k]];
      const at = arr.length;
      for (const row of rowsFromDraft(k, h, lines)) arr.push(row);
      const neg = newNegative(codes, before);
      if (neg) { arr.length = at; err(negMessage(neg, 'new')); fail(); return; }
      if (was) {
        dzCache = null;
        const over = newDzOver(codes, was);
        if (over) notes.push(dzOverMessage(over));
      }
    }
    recalc();
    for (const t of notes) warn.push({ sheet: IMP_SHEET.docs, row: d.row, text: `${label}: ${t}` });
    // Підписана звірка чи завершена інвентаризація після дати документа рахували без нього.
    if (periodLock([h.date], [h.from, k === 'wr' ? '' : h.to])) stat.locked++;
    stat.docs[k]++;
    stat.lines += lines.length;
    if (!stat.from || h.date < stat.from) stat.from = h.date;
    if (!stat.to || h.date > stat.to) stat.to = h.date;
  }

  /** Проганяє файл по обліку. keep=false — лише перевірка: облік повертається до того, яким
   *  був. keep=true — внесене лишається, якщо помилок немає. `undo` скасовує внесене. */
  function impRun(data, keep = false) {
    peopleInit();
    mergeOwnItems();
    const bad = [], warn = [];
    const snap = { incoming: store.docs.incoming.slice(), movement: store.docs.movement.slice(),
      writeoffs: store.docs.writeoffs.slice(), destroyed: store.destroyed.slice(), items: (store.items || []).slice(),
      subs: store.subs.slice(), moveKind: state.moveKind, editing: state.editing, editingReport: state.editingReport };
    const undo = () => {
      Object.assign(store.docs, { incoming: snap.incoming, movement: snap.movement, writeoffs: snap.writeoffs });
      store.destroyed = snap.destroyed;
      store.items = snap.items;
      store.subs = snap.subs;
      mergeOwnItems();
      recalc();
    };
    const stat = { subs: 0, items: 0, docs: { in: 0, mv: 0, wr: 0, dz: 0 }, lines: 0, skipped: 0, after: 0, locked: 0,
      from: '', to: '' };
    const broken = new Set();
    try {
      state.editing = null;
      state.editingReport = null;
      const newSubs = impSubs(data.subs || [], bad);
      if (newSubs.length) { store.subs = store.subs.concat(newSubs); rebuildSubs(store.subs, subMentions()); }
      const newItems = impItems(data.items || [], bad, warn);
      if (newItems.length) { store.items = (store.items || []).concat(newItems); mergeOwnItems(); applyPrices(); }
      stat.subs = newSubs.length;
      stat.items = newItems.length;
      // Ціна з аркуша «Номенклатура» — рядкам приходу без своєї, поки позиція ще не має ціни в програмі.
      const sheetPrice = new Map((data.items || []).filter((r) => r.price > 0).map((r) => [r.code, r.price]));
      const priceOf = (code) => ((itemBy.get(code) || {}).price > 0 ? null : sheetPrice.get(code) ?? null);
      for (const d of impDocs(data.docs || [], bad, priceOf, broken, warn)) impPost(d, bad, warn, stat, broken);
      if (stat.locked) {
        warn.push({ sheet: IMP_SHEET.docs, row: 0, text: `${cnt(stat.locked, 'документ', 'документи', 'документів')} у закритому періоді: `
          + 'підписані звірки й завершені інвентаризації рахували без них' });
      }
    } finally {
      state.moveKind = snap.moveKind;
      state.editing = snap.editing;
      state.editingReport = snap.editingReport;
    }
    if (bad.length || !keep) undo();
    bad.sort((a, b) => a.sheet.localeCompare(b.sheet, 'uk') || a.row - b.row);
    return { bad, warn, stat, undo };
  }

  const impCount = (st) => st.docs.in + st.docs.mv + st.docs.wr + st.docs.dz;
  /** «документів 245 (прихід 80, переміщення 140, вибуття 20, рапортів 5), рядків 730, …» */
  function impSummary(st) {
    const kinds = [['in', 'прихід'], ['mv', 'переміщення'], ['wr', 'вибуття'], ['dz', 'рапортів про знищення']]
      .filter(([k]) => st.docs[k]).map(([k, l]) => `${l} ${st.docs[k]}`).join(', ');
    return [impCount(st) ? `документів ${impCount(st)} (${kinds}), рядків ${st.lines}, з ${fmtDate(st.from)} по ${fmtDate(st.to)}`
      : 'документів 0',
    st.subs ? `нових підрозділів ${st.subs}` : '', st.items ? `нових позицій ${st.items}` : '',
    st.skipped ? `уже в обліку ${st.skipped}` : ''].filter(Boolean).join('; ');
  }

  function impOpen() {
    if (!native) { toast('Імпорт з Excel є лише в програмі на комп’ютері.', true); return; }
    state.imp = null;
    impShow();
  }
  function impShow() {
    const s = state.imp;
    const list = (title, rows, cls) => (rows.length ? `<div class="panel"><div class="panel__note"><b>${esc(title)}</b></div></div>
      <div class="tbl" style="--tbl-min:auto">${rows.slice(0, IMP_SHOWN).map((x) => `<div class="tbl__row tbl__row--plain">
        <div class="c-code" style="width:170px">${esc(x.sheet)}${x.row ? `, рядок ${esc(String(x.row))}` : ''}</div>
        <div class="c-txt ${cls}" style="white-space:normal">${esc(x.text)}</div></div>`).join('')}</div>
      ${rows.length > IMP_SHOWN ? `<div class="panel"><div class="panel__note">і ще ${rows.length - IMP_SHOWN}</div></div>` : ''}` : '');
    const res = s && s.res;
    const ready = res && !res.bad.length && (impCount(res.stat) || res.stat.subs || res.stat.items);
    modalOpen('Імпорт історії з Excel', `<div class="panel">
        <div class="panel__note">Файл за шаблоном програми: аркуші «Підрозділи», «Номенклатура», «Документи».
          Вноситься цілком або ніяк.</div>
        <div class="panel__spacer"></div>
        <button class="btn" data-act="imp-template">Шаблон в Excel</button>
        <button class="btn${ready ? '' : ' btn--primary'}" data-act="imp-file">Обрати файл…</button></div>
      ${res ? `<div class="panel"><div class="panel__note" id="imp-sum">«${esc(s.file)}»: ${res.bad.length
    ? `помилок ${res.bad.length}${res.stat.after
      ? `, через них не пройшло ще ${cnt(res.stat.after, 'документ', 'документи', 'документів')}` : ''}.
            Нічого не внесено: виправте файл і оберіть його знову. Без помилок: ${esc(impSummary(res.stat))}.`
    : `${esc(impSummary(res.stat))}. ${ready ? 'Помилок немає.' : 'Вносити нічого.'}`}</div>
        <div class="panel__spacer"></div>
        ${res.bad.length ? '<button class="btn" data-act="imp-errors">Помилки в Excel</button>' : ''}
        ${ready ? '<button class="btn btn--primary" data-act="imp-apply">Внести в облік</button>' : ''}</div>
        ${list('Помилки', res.bad, 'num-bad')}${list('Зауваження', res.warn, 'num-warn')}` : ''}`);
  }
  function impPick() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.xlsx';
    inp.addEventListener('change', () => { if (inp.files && inp.files[0]) impRead(inp.files[0]); });
    inp.click();
  }
  async function impRead(file) {
    let got;
    try {
      const r = await fetch('api/history-read', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
      got = await r.json();
    } catch (e) {
      toast('Файл не прочитано: ' + (e.message || e), true);
      return;
    }
    state.imp = { file: file.name, data: got, res: impRun(got) };
    impShow();
  }
  /** Вносить перевірений файл: один запис у базу з копією перед ним. Якщо база не прийняла,
   *  облік повертається до того, яким був, а причина стає помилкою у звіті. */
  async function impApply() {
    const s = state.imp;
    if (!s || !s.data) return;
    const res = impRun(s.data, true);
    s.res = res;
    if (res.bad.length) { impShow(); return; }                  // облік змінився, поки вікно було відкрите
    logChange('історію імпортовано', 'imp', `«${s.file}»: ${impSummary(res.stat)}`);
    // Запис, який уже йде, несе стан до імпорту: чекаємо його й пишемо свій.
    if (saving.busy) await saving.busy;
    saving.dirty = true;
    saving.backup = true;
    const ok = (await flush()) === true;
    if (!ok) {
      const why = (($('#save-bar') || {}).textContent || 'база не прийняла запис').replace(/\s*Виправте це.*$/, '');
      res.undo();
      store.log.pop();
      clearTimeout(saving.retry);
      saving.failed = false;
      saveBar('');
      save(true);
      res.bad.push({ sheet: 'База', row: 0, text: why });
      render();
      impShow();
      return;
    }
    modalClose();
    state.imp = null;
    state.flash = `Історію внесено з «${s.file}»: ${impSummary(res.stat)}.`;
    recalc();
    go('moves', { q: '', movesKindF: '', movesFrom: '', movesTo: '', sub: '' });
  }
  function impTemplate() {
    peopleInit();
    toExcel({ kind: 'history-template', file: 'Шаблон імпорту історії',
      subs: subs.map((x) => [x.name, x.parent || '', x.type || '', x.active ? '' : 'так', x.note || '']),
      items: items.map((i) => [i.code, i.name, i.unit || '', i.group || '', +i.price > 0 ? +i.price : '',
        i.nonrev ? 'так' : 'ні', i.fes || '', i.note || '']),
      subKinds: SUB_KINDS, groups: D.groups });
  }
  function impErrors() {
    const res = state.imp && state.imp.res;
    if (!res || !res.bad.length) return;
    toExcel({ file: 'Помилки імпорту історії', sheets: [{ name: 'Помилки', orientation: 'landscape',
      title: 'Помилки імпорту історії', subtitle: `файл «${state.imp.file}»`,
      head: [['Аркуш', 'Рядок', 'Що не так']], widths: [18, 8, 110],
      rows: res.bad.map((x) => [x.sheet, x.row || '', x.text]) }] });
  }
  function impAction(act) {
    switch (act) {
      case 'imp-open': return impOpen();
      case 'imp-template': return impTemplate();
      case 'imp-file': return impPick();
      case 'imp-apply': return impApply();
      case 'imp-errors': return impErrors();
      default: return null;
    }
  }

  // ============================================================ ЗАЯВКА НА НЕКОМПЛЕКТ
  /** Форма 21/Прод у бланку вищого штабу: підрозділ зі «Штату» (порожньо — уся частина)
   *  на звітну дату. Бланк, назви рядків і формули — з самого бланка; книгу будує сервер. */
  function form21Excel() {
    return toExcel({ kind: 'form21', sub: state.sub || '', date: state.asOf, file: `21 Прод на ${state.asOf}` });
  }
  /** Комплект одним рухом: зведена за частину, управління (усе поза батальйонами) і кожен
   *  батальйон — книга з аркушем на кожного й ті самі форми окремими файлами в одній теці. */
  function form21SetExcel() {
    return toExcel({ kind: 'form21set', date: state.asOf, file: `21 Прод на ${state.asOf}`,
      note: 'Окремі файли за батальйонами й розшифровка до форми лежать у тій самій теці.' });
  }

  function shortageExcel() {
    const date = state.asOf;
    const rows = applySubst(staffRows(date, state.sub).filter((g) => g.form === state.staffForm), state.staffForm);
    const withS = !!((store.subst || []).some((x) => x.form === state.staffForm) && store.ui.withSubst);
    const list = rows.filter((g) => g.staffed && (withS ? g.shortS : g.short) > 0);
    if (!list.length) { toast('Некомплекту немає.'); return; }
    // «Де бракує» рахується так само, як графа «Некомплект»: наявність мінус
    // знищене, не списане, і з тими самими замінами — у межах кожного підрозділу.
    // Раніше знищене й заміни тут не враховувались, і суми не сходилися.
    const perSubRows = new Map();
    const rowsOf = (sb) => {
      if (!perSubRows.has(sb)) {
        const rs = staffRows(date, sb).filter((g) => g.form === state.staffForm);
        if (withS) applySubst(rs, state.staffForm);
        perSubRows.set(sb, new Map(rs.map((g) => [g.line, g])));
      }
      return perSubRows.get(sb);
    };
    const perSub = (g) => [...new Set(g.subs.map(([sb]) => sb))].map((sb) => {
      const x = rowsOf(sb).get(g.line);
      const s = x ? (withS ? x.shortS : x.short) : 0;
      return s > 1e-9 ? `${sb} — ${fmtNum(s)}` : '';
    }).filter(Boolean).join('; ');
    toExcel({ file: `Заявка на некомплект ${date}`, sheets: [{
      name: 'Заявка', orientation: 'landscape', top: [unitInfo().legalName, unitInfo().serviceFull],
      title: 'ЗАЯВКА на доукомплектування технічними засобами продовольчої служби',
      subtitle: `станом на ${fmtDate(date)} · форма ${state.staffForm}${state.sub ? ' · ' + state.sub : ''}${withS ? ' · з урахуванням замін' : ''}`,
      head: [['№', 'Табельна позиція', 'За штатом', 'Наявно', withS ? 'По заміні' : '', 'Некомплект', 'Де бракує']],
      widths: [5, 44, 11, 11, 11, 12, 60],
      rows: list.map((g, i) => [i + 1, g.line, g.qty, round3(g.fact), withS ? g.subIn || '' : '', withS ? g.shortS : g.short, perSub(g)]),
      num: [2, 3, 4, 5],
      total: ['', 'Разом', list.reduce((a, g) => a + g.qty, 0), round3(list.reduce((a, g) => a + g.fact, 0)), '',
        list.reduce((a, g) => a + (withS ? g.shortS : g.short), 0), ''],
      signs: ['Начальник продовольчої служби'],
    }] });
  }

  // ============================================================ ЖУРНАЛ ЗМІН
  /** Хто що міняв — принаймні що й коли: провели, виправили (що саме), видалили,
   *  підписали, підшили. Тисячі останніх записів лежать разом з іншими даними. */
  function logChange(what, key, text) {
    store.log = store.log || [];
    const d = new Date();
    const t = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16).replace('T', ' ');
    const rec = { t, what, key: key || '', text: text || '' };
    if (me.name) rec.who = me.name;               // хто вніс — коли працюють кілька людей
    store.log.push(rec);
    if (store.log.length > 3000) store.log.splice(0, store.log.length - 3000);
  }
  const logOf = (pred) => (store.log || []).filter(pred).slice().reverse();
  function historyCard(keys, title = 'Історія змін') {
    const set = new Set(keys);
    const list = logOf((x) => set.has(x.key));
    if (!list.length) return '';
    return `<div class="card" style="margin-top:12px"><div class="card__head"><div class="card__title">${esc(title)}</div>
        <div class="panel__spacer"></div><span class="panel__count">${cnt(list.length, 'запис', 'записи', 'записів')}</span></div>
      <div class="tbl" style="--tbl-min:640px">${list.slice(0, 30).map((x) => `<div class="tbl__row tbl__row--plain">
        <div class="c-date" style="width:130px">${esc(x.t)}</div><div class="c-tag" style="width:140px"><b>${esc(x.what)}</b></div>
        <div class="c-txt" title="${esc(x.text)}">${esc(x.text)}</div></div>`).join('')}</div></div>`;
  }

  /** Вікно поверх програми: копії даних, журнал змін. */
  function modalOpen(title, html, cls = '') {
    modalClose();
    const el = document.createElement('div');
    el.id = 'modal';
    el.className = 'viewer';
    el.innerHTML = `<div class="viewer__box modal__box${cls ? ' ' + cls : ''}"><div class="viewer__bar"><b class="viewer__name">${esc(title)}</b>
      <button class="btn btn--sm" data-md="close" title="Закрити (Esc)">✕</button></div>
      <div class="modal__body">${html}</div></div>`;
    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.closest('[data-md="close"]')) modalClose();
      const b = e.target.closest('[data-md-restore]');
      if (b) restoreBackup(b.dataset.mdRestore);
    });
    document.body.appendChild(el);
    return el;
  }
  function modalClose() { const el = $('#modal'); if (el) el.remove(); }

  async function openBackups() {
    if (!native) { toast('Автоматичні копії є лише в програмі на комп’ютері.', true); return; }
    let list = [];
    try { list = await fetch('api/backups', { cache: 'no-store' }).then((r) => r.json()); } catch (e) { list = []; }
    const rows = list.map((b) => `<div class="tbl__row tbl__row--plain">
        <div class="c-date" style="width:150px"><b>${esc(fmtStamp(b.time))}</b></div>
        <div class="c-txt">${b.ok ? esc(`рядків документів: ${b.docs}, знищене: ${b.destroyed}, звірок: ${b.recon}`
          + `, інвентаризацій: ${b.inventories || 0}`) + (b.old_schema
          ? ' <small>копія попередньої версії програми, відновлюється з оновленням</small>' : '')
          : `<span class="num-bad">${esc(b.why || 'файл пошкоджено')}</span>`}</div>
        <div class="c-num" style="width:90px">${fmtSize(b.size)}</div>
        <div class="c-acts" style="flex-basis:120px">${b.ok ? `<button class="btn btn--sm" data-md-restore="${esc(b.name)}">Відновити</button>` : ''}</div>
      </div>`).join('');
    modalOpen('Копії даних', `<div class="panel"><div class="panel__note">Перед відновленням поточний стан теж зберігається в копію.</div></div>
      <div class="tbl" style="--tbl-min:720px">${rows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Копій ще немає.</div></div>'}</div>`);
  }
  async function restoreBackup(name) {
    if (!confirm(`Відновити дані з копії «${name}»?\n\nПоточний стан буде збережено в окрему копію.`)) return;
    try {
      const r = await fetch('api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }) });
      if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
      saving.dirty = false;
      location.reload();
    } catch (e) {
      toast('Не вдалося відновити: ' + (e.message || e), true);
    }
  }
  /** Копія бази туди, куди покаже людина (флешка, інший диск чи комп’ютер).
   *  Вікно «Зберегти як» показує сама програма — сторінка шляхів не бачить.
   *  Дата останньої такої копії лишається в налаштуваннях: її видно на кнопці,
   *  а через 30 днів без копії Зведення нагадує. */
  async function copyAway() {
    if (!native) { exportState(); return; }
    // Копія бази — лише те, що вже записано у файл. Незаписане (смуга «Зміни НЕ
    // записано») спершу пробуємо записати; не вийшло — воно йде окремим файлом
    // JSON у завантаження, і «Відновити з файла…» його приймає.
    if (saving.dirty || saving.failed || saving.busy) {
      const ok = await flush();
      if (!ok) {
        if (!confirm('Останні зміни ще не записано у файл: копія бази їх не міститиме.\n\n'
          + 'Зберегти незаписане окремим файлом (JSON у теці завантажень), а потім зробити копію бази?')) return;
        exportState();
      }
    }
    let r;
    try {
      r = await fetch('api/copy', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: store.ui.copyDir || '' }) }).then((x) => x.json());
    } catch (e) { toast('Не вдалося зробити копію: ' + (e.message || e), true); return; }
    if (!r.ok) { if (!r.cancelled) toast('Не вдалося зробити копію: ' + (r.error || ''), true); return; }
    store.ui.lastCopy = today();
    if (r.dir) store.ui.copyDir = r.dir;
    save(true);
    toast(`Копію бази записано: ${r.path}`);
    refresh();
  }
  /** Копія бази, принесена файлом: відновлюється так само, як автоматична —
   *  поточний стан перед цим сам лягає в копії. */
  async function restoreFile(f) {
    if (!confirm(`Відновити дані з копії бази «${f.name}»?

Поточний стан буде збережено в окрему копію.`)) return;
    try {
      const r = await fetch('api/restore-file', { method: 'POST', body: f });
      if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
      saving.dirty = false;
      location.reload();
    } catch (e) {
      toast('Не вдалося відновити: ' + (e.message || e), true);
    }
  }
  /** «Перевірити базу…» — звірка за правилами обліку (та сама, що й у
   *  build/verify_db.py), але без Python: перелік перевірок із поясненнями. */
  async function openVerify() {
    if (!native) { toast('Перевірка бази є лише в програмі на комп’ютері.', true); return; }
    let list;
    try {
      const r = await fetch('api/verify', { cache: 'no-store' });
      if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
      list = await r.json();
    } catch (e) { toast('Не вдалося перевірити: ' + (e.message || e), true); return; }
    // Порада (advisory) — стан звичайної роботи, як-от нові одиниці ще без
    // інвентарних номерів: показується як «увага», а не як збій обліку.
    const bad = list.filter((c) => !c.ok && !c.advisory);
    const warn = list.filter((c) => !c.ok && c.advisory);
    const mark = (c) => (c.ok ? ['num-ok', 'OK'] : c.advisory ? ['num-warn', 'УВАГА'] : ['num-bad', 'ЗБІЙ']);
    const rows = list.map((c) => `<div class="tbl__row tbl__row--plain">
        <div class="c-tag" style="width:64px"><b class="${mark(c)[0]}">${mark(c)[1]}</b></div>
        <div class="c-name"><b>${esc(c.name)}</b>${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</div></div>`).join('');
    modalOpen('Перевірка бази', `<div class="panel"><div class="panel__note">${bad.length
      ? `Не сходиться: ${cnt(bad.length, 'перевірка', 'перевірки', 'перевірок')}.`
      : warn.length
        ? `Облік сходиться, є ${cnt(warn.length, 'зауваження', 'зауваження', 'зауважень')}.`
        : 'Усі перевірки пройдено.'}</div></div>
      <div class="tbl" style="--tbl-min:640px">${rows}</div>`);
  }
  /** Пам’ятка на одну сторінку: що це, що де лежить, щоденні дії, клавіші,
   *  копії, скорочення. Для того, хто приймає справи; друкується з тієї ж
   *  картки — на папері лишається тільки текст. */
  function openMemo() {
    const li = (arr) => arr.map((x) => `<li>${x}</li>`).join('');
    const html = `<div class="memo">
      <div class="memo__head"><h2>Пам’ятка з обліку технічних засобів продовольчої служби</h2>
        <button class="btn btn--sm" data-act="memo-print">Друк</button></div>
      <div class="memo__cols">
      <section>
        <h3>Що це й де лежить</h3>
        <ul>${li([
          'Програма веде облік ТЗ ПС: документи, залишки по підрозділах, штат і некомплект, знищене, звірки, інвентаризації, відомість МТЗ, журнали № 47 і № 14.',
          'Дані зберігаються у файлі <b>Дані обліку/oblik.sqlite</b> поруч із програмою. У тій самій теці: <b>скани</b> (скани й фото), <b>вивантаження</b> (файли Excel), <b>копії</b> (автоматичні копії).',
          'На інший комп’ютер програму переносять разом із текою «Дані обліку».',
        ])}</ul>
        <h3>Щоденні дії</h3>
        <div class="memo__pairs">${INTRO.map(([t, d]) => `<div><b>${esc(t)}</b><span>${esc(d)}</span></div>`).join('')}</div>
        <h3>Як провести документ</h3>
        <ol>${li([
          '«+ Новий документ» у розділі «Документи».',
          'Вид документа, номер, дата, відправник і одержувач.',
          'Рядки: код або назва позиції, кількість.',
          'Перевірте підсумок і натисніть «Провести документ» (Ctrl+Enter).',
          '«Зберегти чернетку» відкладає незавершений документ. Проведений виправляють кнопкою «Виправити» в рядку; кожна правка записується в журнал змін.',
          'Знищене майно: рапорт — у «Знищеному майні», там само кнопка «Списати актом…» готує акт списання.',
        ])}</ol>
      </section>
      <section>
        <h3>Клавіші</h3>
        <div class="memo__pairs memo__pairs--keys">${[
          ['Ctrl+K', 'пошук по всій базі'],
          ['Enter', 'наступне поле форми'],
          ['Ctrl+Enter', 'провести документ'],
          ['Ctrl+Shift+Enter', 'провести й почати наступний'],
          ['↑ ↓', 'рядки таблиці'],
          ['Enter', 'відкрити рядок таблиці'],
          ['Esc', 'закрити картку'],
        ].map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join('')}</div>
        <h3>Копії та безпека</h3>
        <ul>${li([
          'Програма робить копію не рідше ніж раз на 10 хвилин роботи й зберігає 60 останніх: ⚙ → «Автоматичні копії…».',
          '<b>Раз на місяць</b> зберігайте копію на флешку чи інший комп’ютер: ⚙ → «Зберегти копію бази…».',
          'Відновлення з такої копії: ⚙ → «Відновити з файла…». Перевірка бази: ⚙ → «Перевірити базу…».',
          'Друге вікно програми на тих самих даних не відкривається.',
        ])}</ul>
        <h3>Скорочення</h3>
        <div class="memo__gloss">${Object.entries(GLOSSARY).filter(([k]) => k !== 'ФЄС')
          .map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}</div>
      </section>
      </div>
      <div class="memo__foot">Пам’ятка станом на ${fmtDate(today())}. Картку «З чого почати» повертає кнопка «?» унизу зліва.</div>
    </div>`;
    modalOpen('Пам’ятка', html);
  }
  function printMemo() {
    document.body.classList.add('printing-memo');
    const done = () => document.body.classList.remove('printing-memo');
    window.addEventListener('afterprint', done, { once: true });
    setTimeout(done, 60000);
    window.print();
  }
  function openLog() {
    const list = logOf(() => true);
    const whats = [...new Set(list.map((x) => x.what))].sort((a, b) => a.localeCompare(b, 'uk'));
    // Хто вніс — лише коли з програмою працює кілька людей: записи, внесені до того, без імені.
    const whos = [...new Set(list.map((x) => x.who).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
    const spec = () => ({
      id: 'log', rows: list, minWidth: '760px', limit: REG_LIMIT, placeholder: 'Пошук: номер, підрозділ, позиція',
      search: (x) => [x.t, x.what, x.text, x.key || '', x.who || ''],
      filters: [
        { type: 'select', key: 'what', label: 'дія', all: 'усі', options: whats.map((w) => [w, w]), test: (x, v) => x.what === v },
        ...(whos.length ? [{ type: 'select', key: 'who', label: 'хто', all: 'усі', options: whos.map((w) => [w, w]),
          test: (x, v) => x.who === v }] : []),
        { type: 'period', key: 'd', label: 'дата', get: (x) => x.t },
      ],
      columns: [
        { key: 't', label: 'час', cls: 'c-date', style: 'width:130px', sort: (x) => x.t, cell: (x) => esc(x.t) },
        ...(whos.length ? [{ key: 'who', label: 'хто', cls: 'c-txt', style: 'flex:0 0 130px', sort: (x) => x.who || '',
          cell: (x) => esc(x.who || '') }] : []),
        { key: 'what', label: 'дія', cls: 'c-tag', style: 'width:170px', first: 1, sort: (x) => x.what, cell: (x) => `<span class="tag tag--mv">${esc(x.what)}</span>` },
        { key: 'text', label: 'зміст', cls: 'c-txt', first: 1, sort: (x) => x.text, cell: (x) => esc(x.text) },
      ],
      row: (x) => ({ cls: 'tbl__row--plain', title: x.text }),
      count: (shown, all) => (shown.length === all.length ? cnt(all.length, 'запис', 'записи', 'записів') : `${shown.length} із ${all.length}`),
      empty: 'Журнал змін порожній.',
    });
    const el = modalOpen('Журнал змін', '<div id="log-reg"></div>');
    const draw = () => {
      const reg = registry(spec());
      el.querySelector('#log-reg').innerHTML = reg.panel + reg.table;
      bindRegistry(el);
    };
    regRedraw.set('log', () => {
      if (document.body.contains(el)) return draw();
      regRedraw.delete('log');
      return render();
    });
    draw();
    const q = el.querySelector('input[data-tf-q="log"]');
    if (q) q.focus();
  }

  // ============================================================ ЗАКРИТИЙ ПЕРІОД
  /** Документ заднім числом після підписаної звірки чи завершеної інвентаризації
   *  міняє вже підписані цифри. Не забороняємо — помилки бувають, — але кажемо
   *  прямо, що саме доведеться переробити, і пишемо це в журнал змін. */
  /** «Вношу історію» — режим внесення старих документів. Облік за кілька років
   *  вносять пачкою, і кожен такий документ потрапляє в закритий період: без
   *  цього режиму програма перепитувала б про кожен. Режим видно на формі й у
   *  «Потребує уваги», а в журналі змін позначка «у закритому періоді» лишається. */
  const histOn = () => !!store.ui.hist;

  function periodLock(dates, subsHit) {
    const d = dates.filter(Boolean).sort()[0];
    if (!d) return '';
    const hits = [];
    for (const r of allRecon()) {
      if (r.status !== 'підписано' || r.to < d) continue;
      if (!subsHit.some((s) => s && (s === r.sub || inSubtree(r.sub, s)))) continue;
      hits.push(`підписано звірку з «${r.sub}» станом на ${fmtDate(r.to)} (відомість №${r.no || '—'})`);
    }
    const ACC = { 'щорічна': 'щорічну', 'позапланова': 'позапланову', 'чергова': 'чергову' };
    for (const x of allInv()) {
      if (x.status !== 'завершено' || x.date < d) continue;
      const sc = x.scope || [];
      if (sc.length && !subsHit.some((s) => s && inScope(x, s))) continue;
      hits.push(`завершено ${ACC[x.kind] || x.kind} інвентаризацію${sc.length ? ` (${scopeShort(sc)})` : ''} станом на ${fmtDate(x.date)}`);
    }
    if (!hits.length) return '';
    return `Документ від ${fmtDate(d)} потрапляє в закритий період: ${[...new Set(hits)].slice(0, 4).join('; ')}`
      + `${hits.length > 4 ? ' тощо' : ''}. Цифри в них зміняться, підписане доведеться переробити.`
      + '\n\nДля внесення старих документів увімкніть у формі режим «вношу історію».'
      + '\n\nПровести все одно?';
  }

  // ---------------------------------------------------------- Заміни в штаті
  function substAdd() {
    const d = state.substDraft;
    if (!d.from || !d.to.length) { toast('Оберіть замінник і позицію, яку він замінює.', true); return; }
    store.subst = store.subst || [];
    const same = store.subst.find((r) => r.form === state.staffForm && r.from === d.from);
    const text = `«${substName(d.from)}» замість ${d.to.map((t) => `«${t}»`).join(', ')} (${state.staffForm})`;
    if (same) {
      // Друге правило на той самий замінник — це доповнення першого, а не дубль.
      for (const t of d.to) if (!same.to.includes(t)) same.to.push(t);
      toast(`Правило для «${substName(d.from)}» доповнено.`);
      logChange('заміну доповнено', 'subst|' + same.id, text);
    } else {
      const r = { id: uid(), form: state.staffForm, from: d.from, to: d.to.slice() };
      store.subst.push(r);
      toast(`Правило додано: «${substName(d.from)}» замість ${d.to.map((t) => `«${t}»`).join(', ')}.`);
      logChange('заміну додано', 'subst|' + r.id, text);
    }
    state.substDraft = { from: '', to: [] };
    save();
    render();
  }

  function substDelete(id) {
    const r = (store.subst || []).find((x) => x.id === id);
    if (!r || !confirm(`Видалити правило заміни для «${substName(r.from)}» (${r.to.join(', ')})?`)) return;
    store.subst = store.subst.filter((x) => x.id !== id);
    logChange('заміну видалено', 'subst|' + r.id, `«${substName(r.from)}» замість ${r.to.map((t) => `«${t}»`).join(', ')} (${r.form})`);
    save(true, true);
    render();
  }

  /** Черга правил — у межах своєї форми: сусід у загальному переліку буває
   *  правилом іншої форми, і стрілка тоді нічого видимого не робила. */
  function substMove(id, by) {
    const list = store.subst || [];
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    const mine = list.map((x, n) => [x, n]).filter(([x]) => x.form === list[i].form).map(([, n]) => n);
    const at = mine.indexOf(i);
    const j = mine[at + by];
    if (j == null) return;
    [list[i], list[j]] = [list[j], list[i]];
    logChange('черга замін', 'subst|' + list[j].id, `«${substName(list[j].from)}» ${by < 0 ? 'вище' : 'нижче'} (${list[j].form})`);
    save();
    render();
  }

  function bindSubst() {
    const form = state.staffForm;
    bindCombo('#sb-from', () => substSrcOpts(form), (v) => {
      const d = state.substDraft;
      state.substDraft = { from: v, to: d.to.filter((t) => t !== v) };
      render();
      if (!state.substDraft.to.length) setTimeout(() => $('#sb-to')?.focus(), 0);
    }, 'Чим замінюють', 'Enter — обрати');
    bindCombo('#sb-to', () => substTgtOpts(form), (v) => substTarget(v), 'Замість чого', 'Enter — додати');
  }

  /** Додати (чи прибрати) позицію, яку замінник закриває. Порядок додавання —
   *  це черговість, у якій він їх закриває. */
  function substTarget(line, on = true) {
    const d = state.substDraft;
    if (!on) d.to = d.to.filter((t) => t !== line);
    else if (line && line !== d.from && !d.to.includes(line)) d.to.push(line);
    render();
  }

  const substWho = (codes) => (codes || []).map((c) => {
    const it = itemBy.get(c);
    return c + ' ' + (it ? it.name : '');
  }).join(' ');
  const substSubs = (codes) => (codes || []).map((c) => {
    const it = itemBy.get(c);
    return `${it ? cleanName(it.name) : ''} (${c})`;
  });

  /** Що може йти за заміну: рядки форми з наявністю (надлишок — угорі) і
   *  позиції номенклатури, яких у табелі форми немає зовсім. Шукається й за
   *  назвою рядка, і за кодами та назвами позицій під ним: «єврокуб» знаходить
   *  рядок бланка, хоч у ньому написано «Ємність харчова 1000 л.». */
  function substSrcOpts(form) {
    const d = state.substDraft;
    const rows = staffRows(state.asOf, '').filter((g) => g.form === form && !g.ref);
    const lines = rows.filter((g) => g.fact > 0)
      .sort((a, b) => (b.fact - b.qty) - (a.fact - a.qty) || a.line.localeCompare(b.line, 'uk'))
      .map((g) => ({ value: g.line, label: g.line, search: substWho(g.codes), subs: substSubs(g.codes), current: g.line === d.from,
        meta: `наявно ${fmtNum(g.fact)}${g.staffed ? ` · штат ${fmtNum(g.qty)}` : ' · без штату'}${
          g.fact > g.qty ? ` · понад штат ${fmtNum(g.fact - g.qty)}` : ''}` }));
    const inForm = new Set(reportLines.filter((l) => l.form === form).flatMap((l) => l.codes));
    const loose = tzItems().filter((it) => !inForm.has(it.code))
      .map((it) => ({ it, q: balCode(it.code) }))
      .sort((a, b) => b.q - a.q || a.it.code.localeCompare(b.it.code, 'uk', { numeric: true }))
      .map(({ it, q }) => ({ value: '#' + it.code, label: `${cleanName(it.name)} · код ${it.code}`, search: it.name,
        current: '#' + it.code === d.from, meta: `${q ? 'наявно ' + fmtNum(q) : 'немає'} · поза табелем форми` }));
    return lines.concat(loose);
  }

  /** Що замінник закриває: позиції зі штатом, найбільший некомплект — угорі. */
  function substTgtOpts(form) {
    const d = state.substDraft;
    const all = staffRows(state.asOf, '').filter((g) => g.form === form && g.staffed);
    const here = new Map(staffRows(state.asOf, state.sub).filter((g) => g.form === form).map((g) => [g.line, g]));
    return all.filter((g) => g.line !== d.from && !d.to.includes(g.line))
      .map((g) => here.get(g.line) || Object.assign({}, g, { short: 0, qty: 0 }))
      .sort((a, b) => b.short - a.short || a.line.localeCompare(b.line, 'uk'))
      .map((g) => ({ value: g.line, label: g.line, search: substWho(g.codes), subs: substSubs(g.codes),
        meta: !g.qty ? `штату в «${state.sub}» немає` : `штат ${fmtNum(g.qty)} · ${g.short ? 'бракує ' + fmtNum(g.short) : 'укомплектовано'}` }));
  }

  function renderSubst() {
    const form = state.staffForm;
    const rows = applySubst(staffRows(state.asOf, state.sub).filter((g) => g.form === form), form);
    const by = substIndex(rows);
    const rules = (store.subst || []).filter((x) => x.form === form);
    const forms = [...staffForms].sort();
    const d = state.substDraft;
    const scopeName = state.sub || 'уся бригада';

    // Замінник обраний — під полем видно, скільки його є і скільки піде за заміну.
    let srcHint = 'Рядок форми або будь-яка позиція номенклатури.';
    if (d.from) {
      const g = substSource({ from: d.from }, rows, by);
      const code = isItemRef(d.from) ? d.from.slice(1) : '';
      const have = g ? g.fact : code ? (state.sub ? haveRollup(state.sub, code) : balCode(code)) : 0;
      srcHint = `${esc(scopeName)}: наявно ${fmtNum(have, '0')}${g && g.staffed ? `, власний штат ${fmtNum(g.qty)}. За заміну йде лише надлишок`
        : ', штату немає. За заміну йде вся наявність'}.`;
    }
    const lineOf = new Map(rows.map((g) => [g.line, g]));
    const chips = d.to.map((t, i) => {
      const g = lineOf.get(t);
      return `<span class="sb-chip"><b>${i + 1}</b>${esc(t)}${g ? `<small>${g.short ? 'бракує ' + fmtNum(g.short) : 'укомплектовано'}</small>` : ''}
        <button type="button" class="sb-chip__x" data-act="sb-rm" data-v="${esc(t)}" title="Прибрати">✕</button></span>`;
    }).join('');
    const quick = rows.filter((g) => g.staffed && g.short > 0 && g.line !== d.from && !d.to.includes(g.line))
      .sort((a, b) => b.short - a.short).slice(0, 8)
      .map((g) => `<button type="button" class="chip chip--btn" data-act="sb-qt" data-v="${esc(g.line)}" title="${esc(g.line)}">+ ${
        esc(shortName(g.line))} <b class="num-bad">−${fmtNum(g.short)}</b></button>`).join('');
    const fromLabel = d.from ? substName(d.from) : '';

    const ruleRows = rules.map((r, n) => {
      const src = substSource(r, rows, by);
      const got = src ? src.subTo : [];
      const spare = src ? Math.max(0, src.fact - src.qty) : 0;
      const effect = !src ? 'цієї позиції на дату немає'
        : got.length ? `закрито: ${got.map(([l, q]) => `${shortName(l)} – ${fmtNum(q)}`).join('; ')}`
          : spare ? 'некомплекту в цих позиціях немає' : 'надлишку понад власний штат немає';
      return `<div class="tbl__row tbl__row--plain">
        <div class="c-num c-num--dim" style="width:34px">${n + 1}</div>
        <div class="c-name" style="flex:2 1 0"><b>${esc(substName(r.from))}</b><small>замість: ${r.to.map(esc).join(', ')}</small></div>
        <div class="c-num">${src ? fmtNum(spare, '0') : '—'}</div>
        <div class="c-txt" style="flex:1.4 1 0" title="${esc(effect)}">${esc(effect)}</div>
        <div class="c-acts" style="flex-basis:150px">
          ${rowBtn('sb-up', '▲', `data-id="${esc(r.id)}"`, { title: 'Підняти в черзі', off: !n })}
          ${rowBtn('sb-down', '▼', `data-id="${esc(r.id)}"`, { title: 'Опустити в черзі', off: n >= rules.length - 1 })}
          ${rowBtn('sb-del', '✕ Видалити', `data-id="${esc(r.id)}"`, { bad: true, title: 'Видалити правило' })}</div>
      </div>`;
    }).join('');

    const touched = rows.filter((g) => g.staffed && (g.subIn || g.subOut || rules.some((r) => r.to.includes(g.line))));
    const effRows = touched.map((g) => `<div class="tbl__row tbl__row--plain">
        <div class="c-name"><b>${esc(g.line)}</b>${g.subFrom.length ? `<small>за рахунок: ${esc(g.subFrom.map(([l, q]) => `${shortName(l)} – ${fmtNum(q)}`).join('; '))}</small>` : ''}${
          g.subTo.length ? `<small>віддано на заміну: ${esc(g.subTo.map(([l, q]) => `${shortName(l)} – ${fmtNum(q)}`).join('; '))}</small>` : ''}</div>
        <div class="c-num">${fmtNum(g.qty)}</div>
        <div class="c-num">${fmtNum(g.fact, '0')}</div>
        <div class="c-num c-num--wide ${g.subIn ? 'num-ok' : 'c-num--dim'}">${g.subIn ? '+' + fmtNum(g.subIn) : '—'}</div>
        <div class="c-num c-num--wide">${g.short ? fmtNum(g.short) : '—'} → <b class="${g.shortS ? 'num-bad' : 'num-ok'}">${g.shortS ? fmtNum(g.shortS) : '0'}</b></div>
        <div class="c-num c-num--wide">${Math.round(g.pct * 100)}% → <b>${Math.round(g.pctS * 100)}%</b></div>
      </div>`).join('');
    const cov = coverage(rows, false), covS = coverage(rows, true);

    return {
      head: head('штат / заміни', 'Заміни в штаті', `${staffSeg('subst')}
        ${forms.length > 1 ? `<div class="seg">${forms.map((f) => `<button type="button" data-act="sf" data-v="${esc(f)}"${f === form ? ' class="is-on"' : ''}>форма ${esc(f)}</button>`).join('')}</div>` : ''}`),
      body: `<div class="panel"><div class="panel__note">
          Укомплектованість на ${fmtDate(state.asOf)} (${esc(scopeName)}):
          ${cov == null ? '—' : Math.round(cov * 100) + '%'}${rules.length ? `, із замінами <b class="num-ok">${Math.round(covS * 100)}%</b>` : ''}.</div></div>

      <div class="card form" style="margin-bottom:12px">
        <div class="card__head"><div class="card__title">Нове правило · форма ${esc(form)}</div></div>
        <div class="sb-new">
          <div class="field"><label>Чим замінюють</label>
            <input id="sb-from" value="${esc(fromLabel)}" data-cur="${esc(fromLabel)}" autocomplete="off" spellcheck="false"
              placeholder="Назва або код: єврокуб, КП-130">
            <div class="field__hint">${srcHint}</div></div>
          <div class="sb-new__arrow" aria-hidden="true">→</div>
          <div class="field"><label>Замість чого (по черзі)</label>
            ${chips ? `<div class="sb-chips">${chips}</div>` : ''}
            <input id="sb-to" value="" data-cur="" autocomplete="off" spellcheck="false"
              placeholder="${d.to.length ? 'Наступна позиція' : 'Назва або код: ЦВ-4, термос'}">
            ${quick ? `<div class="sb-quick"><span>найбільший некомплект:</span>${quick}</div>` : ''}</div>
        </div>
        <div class="card__foot">
          <button class="btn btn--primary" type="button" data-act="sb-add"${d.from && d.to.length ? '' : ' disabled'}>Додати правило</button>
          ${d.from || d.to.length ? '<button class="btn" type="button" data-act="sb-clear">Скасувати</button>' : ''}
        </div>
      </div>

      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Правила заміни</div>
          <div class="panel__spacer"></div><span class="panel__count">${cnt(rules.length, 'правило', 'правила', 'правил')}</span></div>
        <div class="card--scroll"><div class="tbl" style="--tbl-min:860px">
          <div class="tbl__head"><div class="tbl__h c-num" style="width:34px">№</div>
            <div class="tbl__h c-name" style="flex:2 1 0">замінник</div>
            <div class="tbl__h c-num">надлишок</div><div class="tbl__h c-txt" style="flex:1.4 1 0">результат</div>
            <div class="tbl__h c-acts" style="flex-basis:96px"></div></div>
          ${ruleRows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Правил ще немає.</div></div>'}
        </div></div></div>

      ${touched.length ? `<div class="card"><div class="card__head"><div class="card__title">Укомплектованість із замінами · ${esc(scopeName)}</div></div>
        <div class="card--scroll"><div class="tbl" style="--tbl-min:860px">
          <div class="tbl__head"><div class="tbl__h c-name">табельна позиція</div><div class="tbl__h c-num">штат</div>
            <div class="tbl__h c-num">наявно</div><div class="tbl__h c-num c-num--wide">по заміні</div>
            <div class="tbl__h c-num c-num--wide">некомплект</div><div class="tbl__h c-num c-num--wide">укомплект.</div></div>
          ${effRows}</div></div></div>` : ''}`,
    };
  }

  // ---------------------------------------------------------- Знищене майно
  /** Реєстр знищеного: рапорт, потім акт списання. Спільний для екрана й Excel. */
  function destroyedSpec() {
    const journal = allDestroyed();
    const vals = lossValues();
    const days = (r) => (r.reportDate && r.status !== 'списано'
      ? Math.round((Date.parse(state.asOf) - Date.parse(r.reportDate)) / 864e5) : null);
    const nameOf = (r) => (r.other ? r.name || '' : (itemBy.get(r.code) || {}).name || '');
    const units = (list) => list.reduce((a, r) => a + (r.other ? 0 : +r.qty || 0), 0);
    const money = (list) => round2(list.reduce((a, r) => a + ((vals.get(r.id) || {}).sum || 0), 0));
    const holders = subs.filter((sb) => sb.type !== 'бригада' && journal.some((r) => inSubtree(sb.name, r.sub)));
    // Спершу черга роботи: записи без акта (найдавніші згори), далі ті, що чекають
    // проведення акта, і вже списані (найновіші згори) — реєстр читається як перелік справ.
    const rank = (r) => (r.status === 'списано' ? 2 : r.status === 'включено до акта' ? 1 : 0);
    // Черга чекає від рапорту, а не від події: давніший рапорт — вище.
    const when = (r) => (r.status === 'списано' ? r.date : r.reportDate || r.date) || '';
    const byDate = (a, b, desc) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0) * (desc ? -1 : 1);
    const rows = journal.slice().sort((a, b) => rank(a) - rank(b) || byDate(a, b, rank(a) === 2));
    // Ланцюжок станів словами людини, а не моделі: «рапорт подано» → «акт №N не
    // проведений» → «списано актом №N». Номер акта відкриває сам акт, коли той проведений.
    const actRef = (r) => (r.act && actDocKey(r)
      ? `<span class="lnk" data-open="${esc(actDocKey(r))}" title="Відкрити документ">${esc(numNo(r.act))}</span>` : esc(numNo(r.act || '—')));
    const stateCell = (r) => {
      if (r.other) {
        return r.status === 'списано'
          ? `<span class="tag tag--in">списано</span><small>${esc(r.offNo || 'документ не вказано')}${r.offDate ? ' від ' + fmtDate(r.offDate) : ''}</small>`
          : '<span class="tag tag--out">не списано</span><small>документ списання — у рапорті</small>';
      }
      const d = days(r);
      if (r.status === 'списано') {
        return `<span class="tag tag--in">списано</span><small>${esc((r.actType || 'акт').toLowerCase())} ${actRef(r)}${
          r.actDate ? ' від ' + fmtDate(r.actDate) : ''}</small>`;
      }
      // Лічильник каже, чого саме чекає запис: акта — чи проведення вже складеного акта.
      if (r.status === 'включено до акта') {
        return `<span class="tag tag--out">акт не проведений</span><small>${actRef(r)}${d == null ? ''
          : ` · <span class="${d > 30 ? 'num-bad' : ''}">${d} дн. без проведення</span>`}</small>`;
      }
      return `<span class="tag tag--out">рапорт подано</span>${d == null ? ''
        : `<small><span class="${d > 30 ? 'num-bad' : ''}">${d} дн. без акта</span></small>`}`;
    };
    // Дії словами за станом запису: головна — та, що веде далі по ланцюжку; решта дрібніше.
    const actsCell = (r) => {
      const main = r.other || r.status === 'списано' ? ''
        : r.status === 'включено до акта'
          // Акт із цим номером уже проведено, але запис він не закрив (позиції чи кількості
          // в ньому замало): другий акт з тим самим номером не складаємо — відкриваємо той.
          ? (actDocKey(r)
            ? `<button type="button" class="ico-btn ico-btn--main" data-open="${esc(actDocKey(r))}"
                title="Акт ${esc(numNo(r.act))} проведено, але цього запису він не списав: відкрийте акт і допишіть позицію">Відкрити акт →</button>`
            // Довгий номер уже стоїть у графі стану — кнопці досить стрілки.
            : rowBtn('dz-wr', String(r.act).length > 8 ? 'Провести акт →' : `Провести акт ${esc(numNo(r.act))}`, `data-id="${esc(r.id)}"`,
              { main: true, title: `Відкрити чернетку акта ${numNo(r.act)} з цього запису — перевірити й провести` }))
          : rowBtn('dz-act', 'Списати актом…', `data-id="${esc(r.id)}"`,
            { main: true, title: 'Спитає номер акта, підготує чернетку акта списання й відкриє її' });
      const whole = !(r.part && r.status === 'списано');
      const more = [whole ? rowBtn('dz-edit', 'виправити', `data-id="${esc(r.id)}"`, { title: 'Виправити рапорт' }) : '',
        reportFilesBtn(r),
        whole ? rowBtn('dz-del', 'видалити', `data-id="${esc(r.id)}"`, { bad: true, title: 'Видалити запис' }) : ''].filter(Boolean).join('');
      return `${main}<span class="acts__more">${more}</span>`;
    };
    return {
      id: 'dz', rows, headSearch: true, minWidth: '1040px', acts: '160px', limit: REG_LIMIT,
      search: (r) => [r.code, nameOf(r), r.sub, r.report || '', r.act || r.offNo || '', r.note || '', r.other ? 'інше майно' : ''],
      filters: [
        // Три стани запису — три чипи, без перекриття («не списано» включало б і «акт не проведений»).
        { type: 'seg', key: 'st', options: [['', 'усі'], ['open', 'рапорт подано'], ['act', 'акт не проведений'], ['done', 'списано']],
          test: (r, v) => (v === 'open' ? r.status === 'рапорт подано' : v === 'act' ? r.status === 'включено до акта' : r.status === 'списано') },
        { type: 'select', key: 'sub', label: 'підрозділ', all: 'усі', options: holders.map((sb) => [sb.name, sb.name]),
          test: (r, v) => inSubtree(v, r.sub) },
        { type: 'period', key: 'd', label: 'дата події', get: (r) => r.date },
        { type: 'period', key: 'a', label: 'дата акта', get: (r) => (r.status === 'списано' ? r.actDate : '') },
        { type: 'toggle', key: 'late', label: 'понад 30 днів без списання', test: (r) => (days(r) ?? 0) > 30 },
      ],
      // Колонки вміщаються в 1366 px без прокрутки: код — під назвою, дата рапорту —
      // під номером, ціна — під сумою, номер акта й дні без акта — під станом.
      columns: [
        { key: 'date', label: 'дата події', cls: 'c-date', sort: (r) => r.date || '', cell: (r) => fmtDate(r.date) },
        { key: 'sub', label: 'підрозділ', cls: 'c-txt', style: 'flex:0 1 150px', first: 1, sort: (r) => r.sub, cell: (r) => esc(r.sub) },
        { key: 'name', label: 'найменування · код', cls: 'c-name c-name--stack', style: 'flex:2 1 230px', first: 1, sort: nameOf,
          cellTitle: (r) => (r.other ? 'Інше майно: обліку в програмі не веде, у довідку про втрати входить' : r.note || ''),
          cell: (r) => `<b>${esc(nameOf(r))}</b><small>${[r.other ? 'інше майно' : r.code,
            r.unit ? unitLabel(unitBy.get(String(r.unit))) : '', r.note].filter(Boolean).map(esc).join(' · ')}</small>` },
        { key: 'qty', label: 'к-сть', cls: 'c-num', style: 'width:56px', sort: (r) => +r.qty || 0,
          cellTitle: (r) => (r.part ? (r.status === 'списано' ? `Акт списав ${fmtNum(r.qty)} із ${fmtNum(r.whole)} за записом`
            : `Акт списав не все: ${fmtNum(r.qty)} із ${fmtNum(r.whole)} ще чекають`) : ''),
          cell: (r) => (r.part ? `${fmtNum(r.qty)}<small>із ${fmtNum(r.whole)}</small>`
            : `${fmtNum(r.qty)}${r.other && r.uom ? `<small>${esc(r.uom)}</small>` : ''}`) },
        { key: 'sum', label: 'сума · ціна, грн', cls: 'c-num c-num--stack', style: 'width:104px',
          title: 'Сума за ціною партії: списане — за партіями акта, не списане — за найдавнішою партією підрозділу на дату події; «за док.» — ціна за рапортом чи справою',
          sort: (r) => (vals.get(r.id) || {}).sum || 0,
          cellCls: (r) => ((vals.get(r.id) || {}).missing ? 'num-bad' : ''),
          cellTitle: (r) => { const v = vals.get(r.id) || {};
            return v.missing ? (r.other ? 'Без ціни: у рапорті ціни немає'
              : `Без ціни: у «${r.sub}» партій цієї позиції немає ні на ${fmtDate(r.date)}, ні на звітну дату`)
              : v.doc ? 'Ціна за документом (рапорт, справа ЄАС, відомість), не за партією' : ''; },
          cell: (r) => { const v = vals.get(r.id); return v && v.qty ? `${fmtMoney(v.sum)}<small>${fmtMoney(v.price)}${v.doc ? ' за док.' : ''}</small>` : '—'; } },
        { key: 'report', label: 'рапорт', cls: 'c-code', style: 'width:80px', first: 1, title: 'Номер і дата рапорту',
          sort: (r) => r.report || '', cellTitle: (r) => (r.reportDate ? `рапорт від ${fmtDate(r.reportDate)}` : ''),
          cell: (r) => `${esc(r.report || '—')}${r.reportDate ? `<small>${fmtDate(r.reportDate)}</small>` : ''}` },
        { key: 'status', label: 'стан · акт', cls: 'c-tag', style: 'width:168px', first: 1,
          title: 'Стан запису, акт списання і днів від рапорту без акта',
          // У межах стану — спершу ті, що чекають акта найдовше.
          sort: (r) => `${r.status}|${String(9999 - (days(r) ?? 0)).padStart(4, '0')}`,
          cellTitle: (r) => (r.other ? '' : actLabel(r)), cell: stateCell },
        { key: 'acts', label: '', cls: 'c-acts c-acts--col', cell: actsCell },
      ],
      // Запис, на який привело Зведення, підсвічено — щоб не шукати його очима.
      row: (r) => ({ attrs: `data-item="${esc(r.code)}"`, title: nameOf(r), cls: state.dzFocus && r.id === state.dzFocus ? 'is-sel' : '' }),
      total: (shown) => ({ name: '<b>Разом</b>', qty: fmtNum(units(shown), '0'), sum: fmtMoney(money(shown)) }),
      count: (shown, all) => `${shown.length === all.length ? cnt(all.length, 'запис', 'записи', 'записів') : `${shown.length} із ${all.length}`}`
        + ` · не списано ${fmtNum(units(shown.filter((r) => r.status !== 'списано')), '0')} од. на ${
          fmtMoney(money(shown.filter((r) => r.status !== 'списано')))} грн`,
      emptyFiltered: 'За цими фільтрами записів немає.',
    };
  }

  function renderDestroyed() {
    const spec = destroyedSpec();
    if (!spec.rows.length) {
      return {
        fill: true,
        head: head('облік / знищене майно', 'Знищене майно',
          '<button class="btn btn--primary" data-act="new-dz">+ Внести знищення</button>'),
        body: emptyBlock('⚠', 'Записів про знищення немає',
          'До акта списання знищене лишається в обліку, але не рахується наявним.',
          '<button class="btn btn--primary" data-act="new-dz">+ Внести знищення</button>'),
      };
    }
    const reg = registry(spec);
    return {
      fill: true,
      head: head('облік / знищене майно', 'Знищене майно', searchBox('Пошук: код, назва, підрозділ, рапорт, акт')
        + `${actionsExcel}<button class="btn" data-act="losses-xls"
            title="Втрачено, списано й залишок до списання: усього, у поточному році й за період — разом, за підрозділами й за найменуваннями">Довідка про втрати</button>
          <button class="btn btn--primary" data-act="new-dz">+ Внести знищення</button>`),
      body: `${flashBlock()}${reg.panel}<div class="card card--scroll card--fill">${reg.table}</div>`,
    };
  }

  /** Довідка про втрати в Excel: форми доповідей міняються, а питають одне —
   *  скільки втрачено, скільки списано й скільки лишилося, усього, за рік і за
   *  період, у гривнях і в одиницях. Один файл на чотири аркуші: підсумок,
   *  за підрозділами, за найменуваннями, рядки рапортів — і з нього беруть
   *  клітинку чи аркуш під потрібний бланк.
   *  Зріз довідки — підрозділ і пошук реєстру; стан і дати в ній самій. Аркуш
   *  «Рядки» — рівно те, що показує реєстр. */
  function lossesExcel() {
    const spec = destroyedSpec();
    const f = tfOf('dz');
    const period = f.dFrom || f.dTo ? [f.dFrom || '', f.dTo || ''] : null;
    const scope = regRows(Object.assign({}, spec, { filters: spec.filters.filter((x) => x.key === 'sub') }));
    if (!scope.length) { toast('Записів про знищення за цим відбором немає.'); return; }
    const asOf = state.asOf;
    const vals = lossValues();
    const nameOf = (code) => cleanName((itemBy.get(code) || {}).name || code);
    const rowName = (r) => (r.other ? r.name || '' : nameOf(r.code) + (r.unit ? `, ${unitLabel(unitBy.get(String(r.unit)))}` : ''));
    const hasOther = scope.some((r) => r.other);
    const year = asOf.slice(0, 4);
    const periodText = period ? `з ${period[0] ? fmtDate(period[0]) : 'початку обліку'} по ${fmtDate(period[1] && period[1] < asOf ? period[1] : asOf)}` : '';
    const sliceName = { total: `Усього станом на ${fmtDate(asOf)}`, year: `У поточному році (з 01.01.${year})`, period: `За період ${periodText}` };
    const groups = [['Втрачено всього', 'total', 'lost'], ['Списано всього', 'total', 'off'],
      [`Втрачено в ${year} році`, 'year', 'lost'], [`Списано в ${year} році`, 'year', 'off']]
      .concat(period ? [['Втрачено за період', 'period', 'lost'], ['Списано за період', 'period', 'off']] : [])
      .concat([['Залишок до списання', 'total', 'left']]);
    const pair = (s, kind) => (kind === 'lost' ? [s.lostQ, s.lostSum] : kind === 'off' ? [s.offQ, s.offSum] : [s.leftQ, s.leftSum]);
    const cells = (sum) => groups.flatMap(([, sl, kind]) => pair(sum[sl], kind));
    const grid = (lead) => ({
      head: [lead.concat(groups.map(([t]) => ({ t, span: 2 }))), lead.map(() => '').concat(groups.flatMap(() => ['од.', 'грн']))],
      num: groups.map((_, i) => lead.length + 2 * i), money: groups.map((_, i) => lead.length + 2 * i + 1),
      widths: lead.map((x) => (/найменування/i.test(x) ? 44 : /підрозділ/i.test(x) ? 26 : 9)).concat(groups.flatMap(() => [8, 14])),
    });
    const all = lossSummary(scope, asOf, period);
    const missing = round3(all.total.missing);
    const missingRows = scope.filter((r) => (vals.get(r.id) || {}).missing).length;
    const docRows = scope.filter((r) => (vals.get(r.id) || {}).doc).length;
    const top = [unitTop()];
    const title = hasOther ? 'ВТРАТИ ТЕХНІЧНИХ ЗАСОБІВ ТА ІНШОГО МАЙНА ПРОДОВОЛЬЧОЇ СЛУЖБИ'
      : 'ВТРАТИ ТЕХНІЧНИХ ЗАСОБІВ ПРОДОВОЛЬЧОЇ СЛУЖБИ';
    const subtitle = `станом на ${fmtDate(asOf)}`;
    const where = [f.sub ? `Підрозділ: ${f.sub} (з підпорядкованими)` : 'Уся частина']
      .concat(state.q.trim() ? [`Відбір: «${state.q.trim()}»`] : [])
      .concat(period ? [`Період (графи «за період»): ${periodText}`] : []);
    const method = ['Втрачено — за датою події рапорту про знищення, списано — за датою акта списання (витягу з наказу). '
      + 'Сума — за ціною партії: списане — за партіями, які взяв акт; не списане — за найдавнішою партією підрозділу на дату події.']
      .concat(docRows ? [`Ціна за документом (рапорт, справа ЄАС, відомість) замість партії — у ${cnt(docRows, 'рядку', 'рядках', 'рядках')}.`] : [])
      .concat(hasOther ? ['Інше майно (продукти, запаси, майно інших служб) — кількістю й ціною за рапортом, списане документом, названим у рядку; '
        + 'у графах «од.» — лише технічні засоби.'] : [])
      .concat(missing ? [`Без ціни ${cnt(missingRows, 'рядок', 'рядки', 'рядків')} на ${fmtNum(missing)} од.: `
        + 'у підрозділі партій цієї позиції немає ні на дату події, ні на звітну дату, або в рапорті ціни немає — у сумах не враховано.'] : []);
    // 1. Підсумок: рядок на зріз; інше майно — під ним, лише сумою.
    const summary = Object.entries(all).flatMap(([sl, s]) => [[sliceName[sl], s.lostQ, s.lostSum, s.offQ, s.offSum,
      sl === 'total' ? s.leftQ : '', sl === 'total' ? s.leftSum : '']]
      .concat(hasOther ? [['    у тому числі інше майно', '', s.otherLost, '', s.otherOff, '',
        sl === 'total' ? round2(s.otherLost - s.otherOff) : '']] : []));
    // 2. За підрозділами — у порядку довідника; 3. За найменуваннями — за кодом, інше майно — за назвою після них.
    const order = (name) => (subBy.get(name) || {}).order ?? 1e9;
    const bySub = [...new Set(scope.map((r) => r.sub))].sort((a, b) => order(a) - order(b) || a.localeCompare(b, 'uk'))
      .map((sub) => [sub].concat(cells(lossSummary(scope.filter((r) => r.sub === sub), asOf, period))));
    const keyOf = (r) => (r.other ? '~' + (r.name || '') : r.code);
    const byCode = [...new Set(scope.map(keyOf))].sort((a, b) => a.localeCompare(b, 'uk', { numeric: true }))
      .map((key) => {
        const mine = scope.filter((r) => keyOf(r) === key);
        const r0 = mine[0];
        const nos = (k) => [...new Set(mine.map((r) => r[k]).filter(Boolean))].join(', ');
        const lead = r0.other ? ['', r0.name || '', r0.uom || ''] : [r0.code, nameOf(r0.code), (itemBy.get(r0.code) || {}).unit || ''];
        return lead.concat(cells(lossSummary(mine, asOf, period)), [nos('report'), r0.other ? nos('offNo') : nos('act')]);
      });
    const totalOf = (lead, rows) => lead.concat(groups.map((_, i) => [
      round3(rows.reduce((a, r) => a + (+r[lead.length + 2 * i] || 0), 0)),
      round2(rows.reduce((a, r) => a + (+r[lead.length + 2 * i + 1] || 0), 0))]).flat());
    const gSub = grid(['Підрозділ']), gCode = grid(['Код', 'Найменування', 'Од.']);
    // 4. Рядки — як у реєстрі, з його фільтрами й порядком.
    const shown = regRows(spec);
    const lines = shown.map((r) => {
      const v = vals.get(r.id) || {};
      return [r.date, r.sub, r.other ? '' : r.code, rowName(r), r.qty,
        v.qty ? v.price : '', v.qty ? v.sum : '', r.report || '', r.reportDate || '', r.other ? r.offNo || '' : r.act || '',
        r.status === 'списано' ? r.actDate || '' : '', r.status];
    });
    toExcel({
      file: `Довідка про втрати на ${asOf}`,
      sheets: [{
        name: 'Підсумок', orientation: 'portrait', top, title, subtitle, lines: where,
        head: [['Зріз', { t: 'Втрачено', span: 2 }, { t: 'Списано', span: 2 }, { t: 'Залишок до списання', span: 2 }],
          ['', 'од.', 'грн', 'од.', 'грн', 'од.', 'грн']],
        widths: [36, 8, 15, 8, 15, 8, 15], rows: summary, num: [1, 3, 5], money: [2, 4, 6],
        after: method, signs: ['Начальник продовольчої служби'],
      }, {
        name: 'За підрозділами', orientation: 'landscape', top, title: `${title}: за підрозділами`, subtitle, lines: where,
        head: gSub.head, widths: gSub.widths, rows: bySub, num: gSub.num, money: gSub.money,
        total: totalOf(['Разом'], bySub),
      }, {
        name: 'За найменуваннями', orientation: 'landscape', top, title: `${title}: за найменуваннями`, subtitle, lines: where,
        head: [gCode.head[0].concat(['Рапорти', 'Акти']), gCode.head[1].concat(['', ''])],
        widths: gCode.widths.concat([22, 22]), rows: byCode, num: gCode.num, money: gCode.money,
        total: totalOf(['Разом', '', ''], byCode).concat(['', '']),
      }, {
        name: 'Рядки', orientation: 'landscape', top, title: `${title}: рядки рапортів`,
        subtitle: `${subtitle}${regActive(spec) ? ' · з фільтрами реєстру' : ''}`,
        head: [['Дата події', 'Підрозділ', 'Код', 'Найменування', 'К-сть', 'Ціна, грн', 'Сума, грн', 'Рапорт', 'Дата рапорту',
          'Акт чи наказ', 'Дата акта', 'Стан']],
        widths: [11, 24, 8, 44, 8, 12, 14, 10, 11, 12, 11, 16], rows: lines, num: [4], money: [5, 6],
        total: ['', 'Разом', '', '', round3(shown.reduce((a, r) => a + (r.other ? 0 : +r.qty || 0), 0)), '',
          round2(shown.reduce((a, r) => a + ((vals.get(r.id) || {}).sum || 0), 0)), '', '', '', '', ''],
      }],
    });
  }

  // ------------------------------------------------------------- Журнал № 47
  // ------------------------------------------------ вибір пошуком (журнали)
  /** Поле з пошуком замість довгого переліку: друкуєш частину
   *  коду чи назви — лишається лише те, що підходить; праворуч — скільки записів
   *  і який залишок. ↑↓ Enter — вибір, Esc — закрити. */
  const combo = { input: null, opts: [], shown: [], active: 0, choose: null, title: '', hint: '' };

  const comboField = (id, label, value, hint) => `<label class="chip chip--wide is-on combo" title="${esc(hint)}">
      <span class="chip__label">${esc(label)}</span>
      <input id="${id}" class="combo__input" value="${esc(value)}" data-cur="${esc(value)}" autocomplete="off" spellcheck="false"></label>`;

  function comboPop() {
    let el = $('#combo-pop');
    if (!el) {
      el = document.createElement('div');
      el.id = 'combo-pop';
      el.className = 'pick';
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const o = e.target.closest('[data-cv]');
        if (o) comboChoose(o.dataset.cv);
      });
      document.body.appendChild(el);
    }
    return el;
  }

  function comboClose() {
    const el = $('#combo-pop');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    combo.input = null;
  }

  function comboRender() {
    const inp = combo.input;
    if (!inp || !inp.isConnected) { comboClose(); return; }
    const words = qWords(inp.value);
    combo.shown = combo.opts.filter((o) => !words.length || hitAll(words, o.label, o.search || '')).slice(0, 250);
    if (!words.length && combo.active === 0) {
      const cur = combo.shown.findIndex((o) => o.current);
      if (cur > 0) combo.active = cur;
    }
    combo.active = Math.max(0, Math.min(combo.active, combo.shown.length - 1));
    const pop = comboPop();
    pop.innerHTML = `<div class="pick__head">${esc(combo.title)} · ${words.length ? 'знайдено ' + combo.shown.length
      : 'усього ' + combo.opts.length}<span>↑↓ вибір · ${esc(combo.hint || 'Enter — відкрити')} · Esc — закрити</span></div>
      <div class="pick__list">${combo.shown.map((o, n) => {
        // Знайшлося не за назвою, а за позиціями під нею — показуємо, за якими.
        const why = words.length && o.subs && !hitAll(words, o.label)
          ? o.subs.filter((x) => words.some((w) => normQ(x).includes(w))).slice(0, 3) : [];
        return `<div class="pick__opt${n === combo.active ? ' is-active' : ''}${
        o.current ? ' is-current' : ''}" data-cv="${esc(o.value)}">
        <span class="pick__name">${hl(o.label, words)}${why.length ? `<small class="pick__why">${why.map((x) => hl(x, words)).join('; ')}</small>` : ''}</span>
        <span class="pick__qty">${esc(o.meta || '')}</span></div>`;
      }).join('')
        || '<div class="pick__empty">Нічого не знайдено.</div>'}</div>`;
    const r = inp.getBoundingClientRect();
    const w = Math.min(Math.max(r.width + 60, 560), window.innerWidth - 16);
    const below = window.innerHeight - r.bottom - 10;
    pop.style.display = 'flex';
    pop.style.width = w + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    pop.style.top = (r.bottom + 3) + 'px';
    pop.style.bottom = '';
    pop.style.maxHeight = Math.max(200, Math.min(520, below)) + 'px';
    pop.querySelector('.pick__opt.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  function comboChoose(v) {
    const fn = combo.choose;
    comboClose();
    if (fn) fn(v);
  }

  function bindCombo(sel, optsFn, choose, title, hint = '') {
    const el = $(sel);
    if (!el) return;
    const open = () => {
      combo.input = el; combo.opts = optsFn(); combo.choose = choose; combo.title = title; combo.hint = hint; combo.active = 0;
      comboRender();
    };
    el.addEventListener('focus', () => {
      if (el.dataset.cur) el.placeholder = el.dataset.cur;
      el.value = '';
      open();
    });
    el.addEventListener('input', () => {
      if (combo.input !== el) { open(); return; }
      combo.active = 0;
      comboRender();
    });
    el.addEventListener('mousedown', () => { if (document.activeElement === el && combo.input !== el) open(); });
    el.addEventListener('keydown', (e) => {
      const n = combo.shown.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!n) return;
        combo.active = (combo.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        comboRender();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const o = combo.shown[combo.active];
        if (o) { el.blur(); choose(o.value); }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        el.blur();
      }
    });
    el.addEventListener('blur', () => {
      if (combo.input === el) comboClose();
      el.value = el.dataset.cur;
    });
  }

  function j47Options() {
    const n = new Map();
    for (const r of docs) n.set(r.code, (n.get(r.code) || 0) + 1);
    return items.filter((i) => n.has(i.code) && bookOfItem(i) === state.book).map((i) => ({
      value: i.code, label: `${i.code} · ${i.name}`, search: [i.serial, i.chassis, serialsOf.get(i.code)].filter(Boolean).join(' '),
      meta: `${cnt(n.get(i.code), 'запис', 'записи', 'записів')} · залишок ${fmtNum(balCode(i.code), '0')} ${i.unit || ''}`,
      current: i.code === state.j47code,
    }));
  }

  function j14Options() {
    const n = new Map();
    for (const r of docs) {
      if (bookOf(r.code) !== state.book) continue;
      for (const x of [r.from, r.to]) if (subBy.has(x)) n.set(x, (n.get(x) || 0) + 1);
    }
    return subs.filter((sb) => n.has(sb.name)).map((sb) => ({
      value: sb.name, label: sb.name, meta: `${cnt(n.get(sb.name), 'запис', 'записи', 'записів')} · ${sb.type}`,
      current: sb.name === state.j14sub,
    }));
  }

  /** ◀ ▶ — сусідня позиція (підрозділ) з рухом, без відкривання переліку. */
  function journalStep(by) {
    const list = state.view === 'j47' ? j47Options() : j14Options();
    if (!list.length) return;
    const cur = list.findIndex((o) => o.current);
    const next = list[(Math.max(0, cur) + by + list.length) % list.length];
    if (state.view === 'j47') state.j47code = next.value;
    else { state.j14sub = next.value; state.j14page = 1; }
    render();
  }

  /** Сторінка книги № 47 (Додаток 47) по одній позиції. Записи — у порядку
   *  документів; рядки одного документа з тим самим маршрутом — один запис, як
   *  у книзі. «Перебуває» — по частині в цілому; по складу й підрозділах —
   *  залишок після запису: hit — документ його змінив, інакше це чинний залишок.
   *  Спільна для екрана й Excel, щоб надруковане не розходилося з видимим. */
  function j47Model(code) {
    const order = new Map(subs.map((s, i) => [s.name, i]));
    const lines = [];
    const byKey = new Map();
    for (const r of chrono(docs.filter((x) => x.code === code))) {
      const k = `${keyOfRow(r)}|${r.from}|${r.to || ''}`;
      const m = byKey.get(k);
      if (m) { m.q = round3(m.q + r.q); continue; }
      const x = Object.assign({}, r);
      byKey.set(k, x);
      lines.push(x);
    }
    // Усі підрозділи з рухом — у порядку дерева, склад першим: обрізання до
    // восьми мовчки губило решту.
    const blocks = [...new Set(lines.flatMap((r) => [r.from, r.to]).filter((s) => subBy.has(s)))]
      .sort((a, b) => order.get(a) - order.get(b));
    const bal = new Map(blocks.map((s) => [s, 0]));
    let run = 0;
    const rows = lines.map((r) => {
      const inQ = r.kind === 'in' ? r.q : 0;
      const outQ = r.kind === 'wr' ? r.q : 0;
      run = round3(run + inQ - outQ);
      const cells = blocks.map((s) => {
        const plus = r.kind !== 'wr' && r.to === s ? r.q : 0;
        const minus = r.kind !== 'in' && r.from === s ? r.q : 0;
        if (!plus && !minus) return { bal: bal.get(s), delta: 0, hit: false };
        const v = round3(bal.get(s) + plus - minus);
        bal.set(s, v);
        return { bal: v, delta: round3(plus - minus), hit: true };
      });
      const party = r.kind === 'in' ? r.from : r.kind === 'mv' ? `${r.from} → ${r.to}` : r.to || '';
      return { r, inQ, outQ, run, cells, party };
    });
    return { it: itemBy.get(code) || { code, name: code, unit: '', price: 0 }, blocks, rows };
  }

  function renderJ47() {
    const mine = items.filter((i) => bookOfItem(i) === state.book);
    if (state.book === 'ОП' && !mine.length) return opBookEmpty('j47');
    const code = state.j47code && bookOf(state.j47code) === state.book ? state.j47code
      : ((mine.find((i) => docs.some((r) => r.code === i.code)) || mine[0] || {}).code || '');
    state.j47code = code;
    const { it, blocks, rows } = j47Model(code);
    // Смуга блоку підрозділу: чергування тла дає прочитати, до якого
    // підрозділу належить цифра за кілька колонок від його назви.
    const band = (bi) => (bi % 2 ? ' jr__b1' : '');
    const W = 92;
    const body = rows.map(({ r, inQ, outQ, run, cells, party }) => {
      const blk = cells.map((c, bi) => {
        if (!c.hit) {
          return `<div class="jr__cell jr__n jr__sep jr__was${band(bi)}" style="width:${W}px">${c.bal ? fmtNum(c.bal) : ''}</div>`;
        }
        const d = `${c.delta > 0 ? '+' : '−'}${fmtNum(Math.abs(c.delta))}`;
        return `<div class="jr__cell jr__n jr__sep jr__hit${band(bi)}" style="width:${W}px"
          title="${esc(blocks[bi])}: ${d}, стало ${fmtNum(c.bal, '0')}"><small>${d}</small> ${fmtNum(c.bal, '0')}</div>`;
      }).join('');
      return `<div class="jr__row" data-open="${esc(keyOfRow(r))}" title="Відкрити документ">
        <div class="jr__cell" style="width:80px">${fmtDate(r.d)}</div>
        <div class="jr__cell" style="width:130px" title="${esc(r.t)}">${esc(r.t)}</div>
        <div class="jr__cell" style="width:120px" title="${esc(r.no)}">${esc(r.no)}</div>
        <div class="jr__cell jr__flex" title="${esc(party || '—')}">${esc(party || '—')}</div>
        <div class="jr__cell jr__n jr__sep" style="width:64px">${inQ ? fmtNum(inQ) : ''}</div>
        <div class="jr__cell jr__n" style="width:64px">${outQ ? fmtNum(outQ) : ''}</div>
        <div class="jr__cell jr__n jr__open" style="width:76px">${fmtNum(run, '0')}</div>
        ${blk}</div>`;
    }).join('');

    return {
      fill: true,
      head: head('форми обліку / додаток 47', 'Книга обліку наявності та руху', `${journalSeg('j47')}
        ${comboField('cb-j47', 'ТМЦ', `${code} · ${it.name}`, 'Пошук за кодом або назвою')}
        <div class="seg"><button type="button" data-act="j-prev" title="Попередня позиція (Alt+↑)">◀</button>
          <button type="button" data-act="j-next" title="Наступна позиція (Alt+↓)">▶</button></div>
        <button class="btn" data-act="print" title="Поточна сторінка на бланку Додатка 47">В Excel</button>
        <button class="btn" data-act="j47-book" title="Усі сторінки книги в Excel">Уся книга</button>`),
      body: `${state.book === 'ОП' ? opBookPanel() : ''}<div class="panel">
          <div class="panel__note"><b>${esc(it.name)}</b> · ${esc(it.unit)} ·
            ${lotPricesText(it.code) ? 'ціни партій ' + lotPricesText(it.code) : 'ціна ' + fmtMoney(it.price)} грн${it.serial ? ' · зав. № ' + esc(it.serial) : ''}
            · рух у ${cnt(blocks.length, 'підрозділі', 'підрозділах', 'підрозділах')}</div>
          <div class="panel__count">${cnt(rows.length, 'запис', 'записи', 'записів')}</div></div>
        <div class="card card--scroll card--fill">
          <div class="jr" style="--tbl-min:${744 + blocks.length * W}px">
          <div class="jr__head jr__head--top">
            <div class="jr__blk jr__blk--l" style="width:80px;border-left:0">дата</div>
            <div class="jr__blk jr__blk--l" style="width:130px;border-left:0">документ</div>
            <div class="jr__blk jr__blk--l" style="width:120px;border-left:0">номер</div>
            <div class="jr__blk jr__blk--l jr__flex" style="border-left:0">постачальник (одержувач)</div>
            <div class="jr__blk jr__blk--grp" style="width:204px">за документами</div>
            ${blocks.length ? `<div class="jr__blk jr__blk--grp" style="width:${blocks.length * W}px">у тому числі на складі (у підрозділах)</div>` : ''}
          </div>
          <div class="jr__head jr__head--sub">
            <div class="jr__blk jr__flex" style="--fb:540px;border-left:0"></div>
            <div class="jr__blk jr__blk--n" style="width:64px" data-short="Над">надійшло</div>
            <div class="jr__blk jr__blk--n" style="width:64px;border-left:0" data-short="Виб">вибуло</div>
            <div class="jr__blk jr__blk--n" style="width:76px;border-left:0" data-short="Пер">перебуває</div>
            ${blocks.map((s, bi) => `<div class="jr__blk jr__blk--name${band(bi)}" style="width:${W}px" title="${esc(s)}"><span class="jr__nm">${esc(s)}</span></div>`).join('')}
          </div>
          ${body || '<div class="jr__row jr__row--empty"><div class="jr__cell">Рух по цій позиції відсутній</div></div>'}
        </div></div>`,
    };
  }

  // ------------------------------------------------------------- Журнал № 14
  const J14_PER_PAGE = 10;

  function renderJ14() {
    if (state.book === 'ОП' && !docs.some((r) => bookOf(r.code) === 'ОП')) return opBookEmpty('j14');
    const sub = state.j14sub;
    const lines = chrono(docs.filter((r) => (r.from === sub || r.to === sub) && bookOf(r.code) === state.book));
    const codes = [...new Set(lines.map((r) => r.code))]
      .sort((a, b) => String(a).localeCompare(String(b), 'uk', { numeric: true }));
    const pages = Math.max(1, Math.ceil(codes.length / J14_PER_PAGE));
    const page = Math.min(state.j14page, pages);
    state.j14page = page;
    const shown = codes.slice((page - 1) * J14_PER_PAGE, page * J14_PER_PAGE);
    const run = new Map(shown.map((c) => [c, 0]));
    // На сторінці лишаємо тільки документи, що торкаються її позицій: інакше
    // книга складу — це сотні рядків, з яких видно від сили десяток.
    const shownSet = new Set(shown);
    const pageLines = lines.filter((r) => shownSet.has(r.code));

    const band = (bi) => (bi % 2 ? ' jr__b1' : '');
    const body = pageLines.map((r) => {
      const cells = shown.map((c, bi) => {
        let plus = 0, minus = 0;
        if (r.code === c) {
          if (r.to === sub) plus = r.q;
          if (r.from === sub) minus = r.q;
        }
        const cur = (run.get(c) || 0) + plus - minus;
        run.set(c, cur);
        const b = band(bi);
        return `<div class="jr__cell jr__n jr__sep${b}" style="width:48px">${plus ? fmtNum(plus) : '<span class="jr__zero">0</span>'}</div>
                <div class="jr__cell jr__n${b}" style="width:48px">${minus ? fmtNum(minus) : '<span class="jr__zero">0</span>'}</div>
                <div class="jr__cell jr__n jr__open${b}" style="width:54px">${cur ? fmtNum(cur) : '<span class="jr__zero">0</span>'}</div>`;
      }).join('');
      const counter = r.kind === 'mv' ? (r.to === sub ? r.from : r.to) : r.kind === 'in' ? r.from : 'списано';
      return `<div class="jr__row" data-open="${esc(keyOfRow(r))}" title="Відкрити документ">
        <div class="jr__cell" style="width:80px">${fmtDate(r.d)}</div>
        <div class="jr__cell" style="width:120px">${esc(r.t)}</div>
        <div class="jr__cell" style="width:150px" title="${esc(r.no)}">${esc(r.no)} від ${fmtDate(r.d)}</div>
        <div class="jr__cell jr__flex" style="--fb:160px" title="${esc(counter)}">${esc(counter)}</div>
        ${cells}</div>`;
    }).join('');

    return {
      fill: true,
      head: head('форми обліку / додаток 14', 'Книга обліку матеріальних цінностей підрозділу', `${journalSeg('j14')}
        ${comboField('cb-j14', 'підрозділ', sub, 'Пошук за назвою підрозділу')}
        <div class="seg"><button type="button" data-act="j-prev" title="Попередній підрозділ (Alt+↑)">◀</button>
          <button type="button" data-act="j-next" title="Наступний підрозділ (Alt+↓)">▶</button></div>
        <button class="btn" data-act="print">В Excel</button>`),
      body: `<div class="panel">
          <div class="panel__note"><b>${codes.length}</b> ${plural(codes.length, 'позиція', 'позиції', 'позицій')} з рухом, по ${J14_PER_PAGE} на сторінці</div>
          <div class="pager">
            <div class="seg">
              <button data-page="${Math.max(1, page - 1)}"${page === 1 ? ' disabled' : ''}
                title="Попередня сторінка">◄</button>
              <button data-page="${Math.min(pages, page + 1)}"${page === pages ? ' disabled' : ''}
                title="Наступна сторінка">►</button>
            </div>
            <span class="pager__ind">стор. ${page} із ${pages}</span>
          </div>
          <div class="panel__count">${pageLines.length} із ${cnt(lines.length, 'запису', 'записів', 'записів')}</div></div>
        <div class="card card--scroll card--fill">
          <div class="jr" style="--tbl-min:${510 + shown.length * 150}px">
          <div class="jr__head jr__head--top">
            <div class="jr__blk jr__flex" style="--fb:510px;border-left:0">номенклатура</div>
            ${shown.map((c, bi) => {
        const nm = (itemBy.get(c) || {}).name || '';
        return `<div class="jr__blk jr__blk--name${band(bi)}" style="width:150px"
                  title="${c} · ${esc(nm)}"><span class="jr__nm">${c} · ${esc(nm)}</span></div>`;
      }).join('')}
          </div>
          <div class="jr__head jr__head--sub">
            <div class="jr__blk jr__blk--l" style="width:80px;border-left:0">дата</div>
            <div class="jr__blk jr__blk--l" style="width:120px;border-left:0">документ</div>
            <div class="jr__blk jr__blk--l" style="width:150px;border-left:0">номер і дата</div>
            <div class="jr__blk jr__blk--l jr__flex" style="--fb:160px;border-left:0">контрагент</div>
            ${shown.map((c, bi) => `<div class="jr__blk jr__blk--n${band(bi)}" style="width:48px" data-short="Пр">прих.</div>
              <div class="jr__blk jr__blk--n${band(bi)}" style="width:48px;border-left:0" data-short="Ви">вид.</div>
              <div class="jr__blk jr__blk--n${band(bi)}" style="width:54px;border-left:0" data-short="За">стан.</div>`).join('')}
          </div>
          ${body || '<div class="jr__row jr__row--empty"><div class="jr__cell">Рух у цьому підрозділі відсутній</div></div>'}
        </div></div>`,
    };
  }

  /** Згорнутий блок картки: другорядне ховається під заголовок із підказкою, що
   *  всередині; розгорнутий, доки там є що заповнити. */
  const fold = (title, hint, open, body) => `<details class="fold card" style="margin-bottom:12px"${open ? ' open' : ''}>
      <summary class="card__head"><div class="card__title">${esc(title)}</div><span class="fold__hint">${esc(hint)}</span></summary>${body}</details>`;

  /** Запасний шлях книги ОП: вивантажити «Облік ОП.xlsx», прийняти книгу, яку вели руками,
   *  і — поки книга ОП порожня — перенести стару книгу «Облік ОП». */
  function opBookPanel() {
    const last = (D.meta || {}).opBookExport || '';
    const empty = !docs.some((r) => bookOf(r.code) === 'ОП');
    return `<div class="panel">
        <div class="panel__note">Книга «Облік ОП»: ${last ? `вивантажено ${fmtDate(last)}` : 'ще не вивантажували'}</div>
        <div class="panel__spacer"></div>
        ${native ? `<button class="btn" data-act="op-export">Вивантажити книгу «Облік ОП»</button>
        <button class="btn" data-act="op-import">Прийняти книгу…</button>${empty
          ? '<button class="btn" data-act="op-legacy">Перенести стару книгу…</button>' : ''}` : ''}
      </div>`;
  }
  function opBookEmpty(view) {
    return {
      head: head('посуд і миючі / книги обліку', view === 'j14' ? 'Книга обліку підрозділу' : 'Книга обліку наявності та руху',
        journalSeg(view)),
      body: opBookPanel() + emptyBlock('▦', 'У книзі ОП ще немає записів',
        'Внесіть прихід у «Документи» розділу «Посуд і миючі», прийміть книгу «Облік ОП» або перенесіть стару книгу.'),
    };
  }
  /** Вибір файла кнопкою: прихований input створюється на один вибір. */
  function pickFile(accept, fn) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.addEventListener('change', () => { const f = inp.files && inp.files[0]; if (f) fn(f); });
    inp.click();
  }
  const listHtml = (arr) => `<ul class="op-rows">${(arr || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  async function opExport() {
    try {
      await flush();
      const r = await fetch('api/op-book/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await r.json();
      if (r.status === 409) {
        modalOpen('Книгу не вивантажено', `<div class="pad"><p>${esc(j.error)}</p>${listHtml(j.rows)}</div>`, 'modal__box--form');
        return;
      }
      if (!j.ok) throw new Error(j.error || `помилка ${r.status}`);
      if (j.download) {
        const a = document.createElement('a');
        a.href = j.download; a.download = '';
        document.body.appendChild(a); a.click(); a.remove();
      }
      toast(`Книгу вивантажено: ${j.path}`);
    } catch (e) { toast(`Не вдалося вивантажити книгу: ${e.message || e}`, true); }
  }
  async function opImport(file, legacy) {
    let j;
    try {
      await flush();
      const r = await fetch('api/op-book/preview' + (legacy ? '?legacy=1' : ''), { method: 'POST', body: file });
      j = await r.json();
    } catch (e) { toast(`Книгу не прочитано: ${e.message || e}`, true); return; }
    if (!j.ok) {
      modalOpen('Книга не приймається', `<div class="pad">${listHtml(j.problems || [j.error])}</div>`, 'modal__box--form');
      return;
    }
    const d = j.diff;
    const part = (title, arr) => (arr && arr.length ? `<h4>${esc(title)} · ${arr.length}</h4>${listHtml(arr.slice(0, 50))}` : '');
    const places = (j.places || []).map((p) => `<div class="field"><label>${esc(p)}</label>
        <select data-op-place="${esc(p)}"><option value="">як є</option>${subs.filter((sb) => sb.active).map((sb) =>
          `<option${sb.name === p ? ' selected' : ''}>${esc(sb.name)}</option>`).join('')}</select></div>`).join('');
    modalOpen(legacy ? 'Перенесення старої книги ОП' : 'Прийняти книгу ОП', `<div class="pad op-preview">
      ${d.same ? '<p>Книга збігається з програмою.</p>' : ''}
      ${part('Нові документи', d.docs.new)}${part('Змінені документи', d.docs.changed)}${part('Прибрані документи', d.docs.removed)}
      ${part('Нові позиції', d.items.new)}${part('Змінені позиції', d.items.changed)}${part('Прибрані позиції', d.items.removed)}
      ${part('Нові місця', d.subs)}${part('Контрагенти', d.parties)}
      ${places ? `<h4>Місця старої книги → підрозділи програми</h4><div class="form__grid">${places}</div>` : ''}
      ${part('Нормалізовано', j.report)}
      <div class="set-form__acts"><button class="btn btn--primary" data-act="op-apply" data-sha="${esc(j.sha)}"
        data-legacy="${legacy ? 1 : 0}">Прийняти</button></div></div>`, 'modal__box--form');
  }
  async function opApply(sha, legacy) {
    const mapping = {};
    document.querySelectorAll('#modal [data-op-place]').forEach((el) => { if (el.value) mapping[el.dataset.opPlace] = el.value; });
    if (!confirm('Прийняти книгу? Книга ОП у програмі стане такою, як у файлі; перед цим програма збереже копію бази.')) return;
    await flush();
    let j = {};
    let status = 0;
    try {
      const r = await fetch('api/op-book/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha, legacy, mapping }) });
      status = r.status;
      j = await r.json().catch(() => ({}));
    } catch (e) { j = { problems: [String(e.message || e)] }; }
    if (!j.ok) {
      modalOpen('Книгу не прийнято', `<div class="pad">${listHtml(j.problems || [j.error || `помилка ${status}`])}</div>`, 'modal__box--form');
      return;
    }
    sync.leaving = true;
    location.reload();
  }

  function emptyBlock(mark, title, text, acts = '') {
    return `<div class="empty">
      <div class="empty__mark" aria-hidden="true">${mark}</div>
      <div class="empty__title">${esc(title)}</div>
      <div class="empty__text">${esc(text)}</div>
      ${acts ? `<div class="empty__acts">${acts}</div>` : ''}
    </div>`;
  }

  // ------------------------------------------------------------------- події
  /** Усе похідне від журналів — проводки, стрічка, дерево підрозділів, ціни, партії — наново.
   *  Без перемальовування: імпорт історії проводить сотні документів поспіль і малює раз. */
  function recalc() {
    ledger = buildLedger();
    docs = buildDocs();
    // Підрозділ, доданий у програмі, вважається задіяним, щойно на нього
    // склали перший документ: тоді він з'являється й у фільтрах.
    // Задіяний — той, що згаданий хоч де-небудь в обліку, і рахується так від
    // першого показу: раніше лічильник «Підрозділи» зростав після першого ж
    // збереження, хоча нічого нового не з'явилося.
    rebuildSubs(Array.isArray(store.subs) ? store.subs : D.subs.map(baseSub), subMentions());
    applyPrices();
    allocateLots();
    balCache.key = null;
    dzCache = null;
  }
  function refresh() {
    recalc();
    render();
  }

  /** Переходи йдуть в історію вікна: «назад» (кнопка на екрані, Alt+←, бічна
   *  кнопка миші) повертає туди, звідки прийшли, — з документа в картку засобу
   *  й назад у документ, а не завжди в перелік. */
  const navSnap = () => ({ view: state.view, book: state.book, itemCode: state.itemCode, docKey: state.docKey,
    reconId: state.reconId, docBack: state.docBack, stId: state.stId, stSub: state.stSub,
    peopleTab: state.peopleTab, personId: state.personId, subName: state.subName,
    paperId: state.paperId || null, paperVer: state.paperVer || 0,
    idx: (history.state && history.state.idx) || 0 });
  const canBack = () => !!(history.state && history.state.idx > 0);

  function go(view, patch = {}) {
    const before = screenKey();
    Object.assign(state, patch, { view });
    if (screenKey() !== before) {
      const snap = navSnap();
      snap.idx = ((history.state && history.state.idx) || 0) + 1;
      try { history.pushState(snap, ''); } catch (e) { /* без історії теж працює */ }
    }
    render();
  }

  /** «← Назад»: у межах програми — на попередній екран, інакше — на запасний. */
  function goBack(fallback, patch = {}) {
    if (canBack()) { history.back(); return; }
    go(fallback, patch);
  }

  /** Один делегований обробник на всю оболонку: пункти меню, рядки таблиць,
   *  кнопки дій. Так нічого не «відвалюється» після перемальовування. */
  function bindGlobal() {
    // Enter у полі норми переводить у наступне — заповнення штату йде колонкою.
    // Зміна норми перемальовує таблицю, тож наступне поле шукаємо вже після цього.
    // Обробник один на весь час роботи: #scroll не перестворюється, і прив'язка
    // в bindBody додавала б ще один дублікат на кожному перемальовуванні.
    // Рядки таблиць ходять із клавіатури: ↑↓ — між рядками, Enter — відкрити.
    // Рядок стає фокусованим у render() (tabindex), тут — лише рух.
    $('#scroll').addEventListener('keydown', (e) => {
      const row = e.target.closest && e.target.closest('.tbl__row[tabindex]');
      if (row && !e.target.matches('input, select, textarea, button')) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const rows = [...$('#scroll').querySelectorAll('.tbl__row[tabindex]')];
          const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
          if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ block: 'nearest' }); }
          return;
        }
        if (e.key === 'Enter') { e.preventDefault(); row.click(); return; }
      }
      if (e.key !== 'Enter' || !e.target.matches('.norm')) return;
      e.preventDefault();
      const all = [...$('#scroll').querySelectorAll('.norm')];
      const next = all[all.indexOf(e.target) + 1];
      const code = next && next.dataset.norm;
      e.target.blur();
      if (!code) return;
      const nx = $(`.norm[data-norm="${code}"]`);
      if (nx) { nx.focus(); nx.select(); nx.scrollIntoView({ block: 'nearest' }); }
    });
    $('#scroll').addEventListener('scroll', () => { if (pick.input) pickRender(); }, { passive: true });
    window.addEventListener('resize', () => { if (pick.input) pickRender(); });
    document.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && (state.view === 'j47' || state.view === 'j14')) {
        e.preventDefault();
        journalStep(e.key === 'ArrowDown' ? 1 : -1);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (state.viewer && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
        && !e.target.closest('input, textarea, select')) {
        e.preventDefault();
        state.viewer.idx += e.key === 'ArrowRight' ? 1 : -1;
        viewerRender();
        return;
      }
      // Ctrl+K — пошук по всьому з будь-якого екрана (і в українській розкладці: це клавіша, не літера).
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') { e.preventDefault(); paletteOpen(); return; }
      if (e.key !== 'Escape') return;
      if ($('#palette')) { paletteClose(); return; }
      if ($('#modal')) { modalClose(); return; }
      if (state.viewer) { viewerClose(); return; }
      const q = $('#q');
      if (q && q.value && document.activeElement === q) { q.value = ''; state.q = ''; render(); }
    });
    // Колесо миші над числовим полем у фокусі тихо змінювало кількість чи ціну.
    document.addEventListener('wheel', (e) => {
      if (e.target.matches && e.target.matches('input[type="number"]') && document.activeElement === e.target) e.target.blur();
    }, { passive: true });
    // Рік у полі дати, набраний не повністю («30.09.26» дає 0026 рік): поле приймає будь-який
    // рік, тож про описку кажемо одразу; база такої дати не запише.
    document.addEventListener('change', (e) => {
      const el = e.target;
      if (!el.matches || !el.matches('input[type="date"]') || !el.value) return;
      const bad = dateYearOdd(el.value);
      if (bad) toast(`У даті рік ${bad}: уведіть рік повністю, чотирма цифрами`, true);
    }, true);
    document.addEventListener('click', (e) => {
      if (e.target.closest('input, select, textarea, label')) return;
      const el = e.target.closest('[data-nav],[data-act],[data-item],[data-code],[data-open],'
        + '[data-sub],[data-kind],[data-page],[data-accent],[data-density],[data-textsize],[data-wrap],[data-vw]');
      // Корінь документа несе атрибути оформлення, а не дію: якщо пошук дійшов
      // до нього, клац був по порожньому місцю.
      if (!el || el === document.documentElement || el === document.body) return;
      // Людина виділяє номер у рядку, щоб скопіювати, — це не клац по рядку.
      // Лише для рядків і лише коли виділене лежить у самому рядку: кнопки й
      // меню працюють завжди — раніше будь-який виділений текст на сторінці
      // (навіть у полі вводу) мовчки глушив усі кнопки.
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel && String(sel).trim() && !e.target.closest('button') && sel.anchorNode && el.contains(sel.anchorNode)) return;
      if (el.closest('#viewer')) return;
      const d = el.dataset;
      // Пункт меню відкриває корінь розділу, а не картку, що лишилась у ньому
      // відкритою: «Звірки» після підписаної відомості вели назад у відомість.
      // Пункт меню — новий екран із чистим пошуком: запит із «Руху й операцій»
      // інакше фільтрував реєстр знищеного, і той показував «записів немає».
      if (d.nav) {
        // Пункт книги ОП чи ТЗ відкриває свою книгу; фільтри іншої книги до неї не переходять.
        const book = d.book && d.book !== state.book
          ? { book: d.book, group: '', assetF: '', onlyShort: false, movesKindF: '' } : d.book ? { book: d.book } : {};
        return go(d.nav, Object.assign({ q: '' }, NAV_ROOT[d.nav] || {}, book));
      }
      if (d.vw != null && !d.act) return openViewer(d.vwKey, d.vw);
      if (d.act === 'att') return attActs[+d.i] ? attActs[+d.i]() : null;
      if (d.act === 'sort') return sortToggle(d.view, d.k, d.first);
      if (d.act === 'tf') { const fl = tfOf(d.id); fl[d.k] = d.v || ''; fl.limit = 0; return regRefresh(d.id); }
      if (d.act === 'tf-reset') { regReset(d.id); return regRefresh(d.id); }
      if (d.act === 'tf-more') { const fl = tfOf(d.id); fl.limit = Math.max(fl.limit || 0, REG_LIMIT) + REG_LIMIT; return regRefresh(d.id); }
      if (d.act === 'rc-doc') return reconToDoc(d.v);
      if (d.act === 'doc-based') return docBasedOn(d.doc, d.v);
      if (d.act === 'sub-handover') return subHandOver(d.sub);
      if (d.act === 'staff-open') { state.staffOpen = state.staffOpen === d.line ? null : d.line; return render(); }
      if (d.act && d.act.startsWith('st-')) return stocktakeAction(d.act, d);
      if (d.act && d.act.startsWith('mtz-')) return mtzAction(d.act, d);
      if (d.act && d.act.startsWith('f2-')) return form2Action(d.act, d);
      if (d.act && d.act.startsWith('pur-')) return purAction(d.act, d);
      if (d.act && /^(paper|val|yats)-/.test(d.act)) return paperAction(d.act, d);
      if (d.act && d.act.startsWith('imp-')) return impAction(d.act, d);
      if (d.act && /^(pp|ph|as|mvo|cmdr|off|loc)-|^file-add$/.test(d.act)) return peopleAction(d.act, d);
      if (d.act && /^(sd|nm)-/.test(d.act)) return subsAction(d.act, d);
      if (d.act === 'dz-del') return deleteDestroyed(d.id);
      if (d.act === 'dz-act') return actDestroyed(d.id);
      if (d.act === 'dz-wr') return writeoffFromAct(d.id);
      // Назад до записів «Знищене майно», уже відібраних за номером рапорту.
      if (d.act === 'dz-open') return go('destroyed', { q: d.v || '' });
      if (d.act === 'scan-del') return unlinkScan(d.path);
      if (d.act === 'rc-new') return reconNew(d.sub);
      if (d.act === 'rc-open') return reconOpen(d.id);
      if (d.act === 'rc-xls') return reconExcel([reconById(d.id)]);
      if (d.act === 'rc-line-del') {
        const r = current();
        const l = r && editable(r) ? r.lines[+d.i] : null;
        if (!l || !confirm(`Прибрати рядок «${l.name || 'без назви'}» з відомості?`)) return null;
        r.lines.splice(+d.i, 1);
        logChange('відомість змінено', 'recon|' + r.id, `Відомість №${r.no || '—'} · ${r.sub}: прибрано рядок «${l.name || '—'}»`);
        save();
        return render();
      }
      if (d.act === 'doc-print') return docExcel(d.doc);
      if (d.act === 'doc-edit') return editDoc(d.doc);
      if (d.act === 'doc-del') return deleteDoc(d.doc);
      if (d.act === 'mk') { state.movesKindF = d.v || ''; state.movesLimit = 200; return render(); }
      if (d.act === 'sub-asset') { state.subAsset = d.v || ''; return render(); }
      if (d.act === 'op-apply') return opApply(d.sha, d.legacy === '1');
      if (d.act === 'sub-book') { state.subBook = d.v === 'ОП' ? 'ОП' : 'ТЗ'; state.subAsset = ''; return render(); }
      if (d.act === 'j-prev' || d.act === 'j-next') return journalStep(d.act === 'j-next' ? 1 : -1);
      if (d.act === 'sf') { state.staffForm = d.v; state.substDraft = { from: '', to: [] }; return render(); }
      if (d.act === 'ws') { store.ui.withSubst = d.v === '1'; save(); return render(); }
      if (d.act === 'sb-del') return substDelete(d.id);
      if (d.act === 'dz-edit') return editReport(d.id);
      if (d.act === 'inv-move') {
        const [lo, hi, ...sub] = String(d.v).split('|');
        state.invMove = { code: d.code, lo: +lo, hi: +hi, from: +lo, to: +hi, was: sub.join('|'), sub: '', date: today(), note: '' };
        render();
        $('#scroll')?.scrollTo({ top: 0 });
        return null;
      }
      if (d.act === 'inv-go') return invMoveGo();
      if (d.act === 'inv-issue') return invIssueOpen();
      if (d.act === 'inv-issue-go') return invIssueGo();
      if (d.act === 'inv-cancel') { state.invMove = null; return render(); }
      if (d.act === 'staff-all') { state.staffAll = !state.staffAll; return render(); }
      if (d.act === 'lc-del') return lineCodesSet(d.line, (lineCodes.get(d.line) || []).filter((c) => c !== d.code));
      if (d.act === 'un-new') return unitEditOpen(null, d.code);
      if (d.act === 'un-edit') return unitEditOpen(d.id);
      if (d.act === 'un-save') return unitEditSave();
      if (d.act === 'un-cancel') { state.unitEdit = null; return render(); }
      if (d.act === 'ol-open') {
        state.ownLineOpen = true;
        render();
        return setTimeout(() => $('[data-ol="name"]')?.focus(), 0);
      }
      if (d.act === 'ol-cancel') { state.ownLineOpen = false; return render(); }
      if (d.act === 'ol-add') return ownLineAdd();
      if (d.act === 'ol-del') return ownLineDelete(d.line);
      if (d.act === 'sb-qt') return substTarget(d.v);
      if (d.act === 'sb-rm') return substTarget(d.v, false);
      if (d.act === 'sb-for') {
        state.substDraft = { from: '', to: [d.line] };
        go('subst');
        setTimeout(() => $('#sb-from')?.focus(), 0);
        return;
      }
      if (d.act === 'sb-up') return substMove(d.id, -1);
      if (d.act === 'sb-down') return substMove(d.id, 1);
      if (d.act === 'line-all') {
        const dr = draft(), ln = dr.lines[+d.i];
        if (!ln || !ln.code || state.moveKind === 'in') return;
        const have = lineHave(ln, dr.head.from, dr.head.date);
        if (have > 0) ln.qty = String(+have.toFixed(3));
        const q = $(`#doc-form [data-ln="qty"][data-i="${d.i}"]`);
        if (q) { q.value = ln.qty; q.focus(); }
        refreshLineHints();
        return;
      }
      if (d.act === 'line-code') return newCodeForLine(+d.i);
      if (d.act === 'line-del') {
        const dr = draft();
        if (dr.lines.length > 1) dr.lines.splice(+d.i, 1);
        return render();
      }
      if (d.act === 'intro-hide' || d.act === 'intro-show') {
        store.ui.hideIntro = d.act === 'intro-hide';
        save();
        if (d.act === 'intro-show' && state.view !== 'dash') return go('dash');
        return render();
      }
      if (d.act === 'doc-new') {
        if (!leaveEditing()) return null;
        state.formOpen = true;
        if (d.v) state.moveKind = d.v;
        if (state.view !== 'moves') return go('moves', { formOpen: true });
        render();
        $('#doc-form')?.scrollIntoView({ block: 'start' });
        $('#doc-form [name="no"]')?.focus();
        return null;
      }
      if (d.act) return act(d.act);
      if (d.kind) {
        // Вид документа при правці не міняється — і рапорту теж: інакше рапорт,
        // що виправлявся, лягав у чернетку нового й вносився вдруге.
        if (state.editing || state.editingReport) return;
        return go('moves', { moveKind: d.kind });
      }
      if (d.page) return go('j14', { j14page: +d.page });
      if (d.open) return openDoc(d.open);
      // Код позиції — рядок: у базі це текстове поле. Приведення до числа
      // розривало зв'язок із довідником, і картка засобу не відкривалася.
      if (d.item) return go('item', { itemCode: String(d.item) });
      if (d.code) return go('item', { itemCode: String(d.code) });
      // Підрозділ — картка підрозділу: майно, штат, звірка, МВО, документи.
      if (d.sub) return go('sub', { subName: d.sub });
      if (d.accent) {
        state.accent = d.accent; store.ui.accent = d.accent; save();
        applyTheme(); return render();
      }
      if (d.density) {
        state.density = d.density; store.ui.density = d.density; save();
        applyTheme(); return render();
      }
      if (d.textsize) {
        state.textSize = d.textsize; store.ui.textSize = d.textsize; save();
        applyTheme(); return render();
      }
      if (d.wrap != null) {
        state.wrap = d.wrap === '1'; store.ui.wrap = state.wrap; save();
        applyTheme(); return render();
      }
    });
  }

  /** Поля документа пишуться в чернетку одразу.
   *
   *  Найменування, дата й відправник міняють підказку про наявність, тому після
   *  них форма перемальовується. Кількість і примітки — ні: перемальовування на
   *  кожній натиснутій клавіші забирало б фокус.
   */
  function bindDraftFields() {
    const form = $('#doc-form');
    if (!form) return;
    const d = draft();
    form.querySelectorAll('[data-ln]').forEach((el) => {
      const i = +el.dataset.i, key = el.dataset.ln;
      const write = () => { d.lines[i][key] = el.value; };
      el.addEventListener('input', () => { write(); if (key === 'qty' || key === 'price') refreshLineHints(); keepDraftsSoon(); });
      el.addEventListener('change', () => { write(); refreshLineHints(); });
    });
    // Поле найменування: при вході порожніє, щоб одразу друкувати пошук, а
    // обране показує підказкою; вийшли без вибору — повертається як було.
    form.querySelectorAll('[data-pick]').forEach((el) => {
      el.addEventListener('focus', () => {
        const cur = el.value;
        el.value = '';
        if (cur) el.placeholder = cur;
        pickOpen(el);
      });
      el.addEventListener('input', () => {
        if (pick.input !== el) { pick.input = el; pick.i = +el.dataset.pick; }
        pick.active = 0;
        pickRender();
      });
      el.addEventListener('keydown', pickKey);
      el.addEventListener('blur', () => {
        if (pick.input === el) pickClose();
        pickRestore(el);
      });
    });
    // Enter не проводить документ: у шапці веде до наступного поля, у рядку —
    // до найменування наступного рядка. Провести — кнопкою або Ctrl+Enter.
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        pickClose();
        state.postNext = e.shiftKey && !state.editing && state.moveKind !== 'dz';
        form.requestSubmit();
        return;
      }
      const t = e.target;
      if (t.matches('textarea, button, [data-pick]')) return;
      e.preventDefault();
      if (t.dataset.ln) {
        const i = +t.dataset.i;
        if (t.dataset.ln === 'qty') {
          const p = $(`#doc-form [data-ln="price"][data-i="${i}"]`);
          if (p) { p.focus(); p.select(); return; }
        }
        if (i === d.lines.length - 1) { d.lines.push(emptyLine()); render(); }
        ($(`#doc-form [data-pick="${i + 1}"]`) || $(`#doc-form [data-ln="name"][data-i="${i + 1}"]`))?.focus();
        return;
      }
      const fields = [...form.querySelectorAll('.form__grid input, .form__grid select, .form__grid textarea')];
      const nx = fields[fields.indexOf(t) + 1];
      if (nx) nx.focus(); else $('#doc-form [data-pick="0"]')?.focus();
    });
    ['type', 'no', 'date', 'from', 'to', 'basis', 'note', 'report', 'reportDate', 'act']
      .forEach((name) => {
        const el = form.querySelector(`[name="${name}"]`);
        if (!el) return;
        el.addEventListener('input', () => {
          d.head[name] = el.value; d.head.auto = false; refreshSummary(); keepDraftsSoon();
        });
        el.addEventListener('change', () => {
          d.head[name] = el.value;
          d.head.auto = false;
          if (name === 'from' || name === 'date') refreshLineHints(); else refreshSummary();
        });
      });
  }

  /** Прив'язка полів вводу — вони живуть лише до наступного перемальовування. */
  function bindBody() {
    const q = $('#q');
    if (q) {
      q.addEventListener('input', debounce(() => {
        // Поле вже перемальовано (перейшли на інший екран, поки йшла затримка):
        // його текст — пошук того екрана, а не цього.
        if (!q.isConnected) return;
        // Фокус повертається в поле лише тоді, коли людина з нього не пішла:
        // Ctrl+K одразу після набору відкривав палітру, а за 200 мс фокус
        // повертався в пошук — далі текст ішов не туди, і Esc палітру не закривав.
        const had = document.activeElement === q;
        const pos = q.selectionStart;
        state.q = q.value;
        render();
        const nq = $('#q');
        if (nq && had && !$('#palette')) { nq.focus(); nq.setSelectionRange(pos, pos); }
      }, 200));
    }
    // Другий ярус шапки книги має прилипати рівно під першим, а висота першого
    // залежить від того, скільки рядків займуть назви ТМЦ. Міряємо, не вгадуємо.
    const top = $('.jr__head--top');
    if (top) top.parentElement.style.setProperty('--jr-top-h', top.offsetHeight + 'px');
    bindSelect('#f-group', (v) => { state.group = v; });
    bindSelect('#f-asset', (v) => { state.assetF = v; });
    bindSelect('#f-holder', (v) => { state.subHolder = v; });
    bindSelect('#f-sub', (v) => { state.sub = v; });
    bindSelect('#f-fes', (v) => { state.movesFes = v; });
    if (state.view === 'form2' || state.view === 'item') bindForm2Fields($('#scroll'));
    // Статус ФЕС у картці документа.
    $('#scroll').querySelectorAll('[data-fes]').forEach((el) => el.addEventListener('change', () => {
      fesSet(el.dataset.doc, { [el.dataset.fes]: el.value.trim() });
      render();
    }));
    bindRegistry($('#scroll'));
    bindSelect('#mf-from', (v) => { state.movesFrom = v; state.movesLimit = 200; });
    bindSelect('#mf-to', (v) => { state.movesTo = v; state.movesLimit = 200; });
    // Код позиції — рядок, а не число: у базі це текстове поле, і серед кодів
    // трапляються такі, що з нуля починаються. Приведення до числа тихо ламало
    // пошук по `itemBy`, і журнал показував не ту позицію, що обрана у списку.
    bindCombo('#cb-j47', j47Options, (v) => { state.j47code = String(v); render(); }, 'Позиції з рухом');
    bindCombo('#cb-j14', j14Options, (v) => { state.j14sub = v; state.j14page = 1; render(); }, 'Підрозділи з рухом');
    $('#doc-form')?.addEventListener('submit', submitDoc);
    $('#item-form')?.addEventListener('submit', submitItem);
    bindEllipsis();
    bindGlossary();
    bindScanDrop();
    bindRecon();
    bindSubst();
    bindDirs();
    bindPeople();
    bindStocktake();
    bindMtz();
    bindPurchases();
    bindPapers();
    bindDraftFields();
    $('#scroll').querySelectorAll('[data-norm]').forEach((el) => {
      el.addEventListener('change', () => {
        const scope = state.sub || rootName();
        const v = parseFloat(String(el.value).replace(',', '.'));
        // Норма пишеться на звітну дату: попередній строк лишається за
        // попередніми документами й розрахунками.
        normSet({ sub: scope, code: el.dataset.norm }, v > 0 ? v : 0, state.asOf);
        save();
        // Потреба форми 21/Прод складається з рядків, а код без рядка у форму не потрапляє.
        if (v > 0 && !inForm21(el.dataset.norm)) {
          toast(`Код ${el.dataset.norm} не прив’язано до рядка форми 21/Прод: у потребу форми ця норма не піде. `
            + 'Прив’яжіть код: «Усі позиції форми» → рядок → «+ код служби».', true);
        }
        // Перемальовуємо після того, як фокус уже перейшов (Tab чи клац у сусіднє
        // поле), і повертаємо його в те саме поле нової таблиці.
        setTimeout(() => {
          const a = document.activeElement;
          const next = a && a.matches && a.matches('.norm') ? a.dataset.norm : null;
          render();
          if (next) { const n = $(`.norm[data-norm="${next}"]`); if (n) { n.focus(); n.select(); } }
        }, 0);
      });
    });
  }

  /** Обрізаний текст у комірці — повний у підказці. Колонки ширшими не робимо:
   *  довге найменування чи посада мають читатися на наведення, а не розсувати
   *  таблицю. Обрізання визначаємо по факту, після розкладки. */
  function bindEllipsis() {
    const scope = $('#scroll');
    if (!scope) return;
    // Текст вкладених елементів — через пробіл: «15» і «витяг із наказу».
    const textOf = (el) => {
      const parts = [];
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) { const t = walk.currentNode.nodeValue.trim(); if (t) parts.push(t); }
      return parts.join(' ');
    };
    // Своя підказка, в якій уже є всі слова комірки, лишається як є; інакше
    // повний текст стає перед нею.
    const covers = (title, text) => text.replace(/📎\d*/gu, ' ').split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w)).every((w) => title.includes(w));
    let n = 0;
    for (const el of scope.querySelectorAll('.c-name b, .c-name small, .c-txt, .c-code, .tile__hint, .spec__v')) {
      if (n++ > 900) break;                  // довгі стрічки далі не міряємо
      if (el.querySelector('input, select, button')) continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const text = textOf(el);
      if (!el.title) el.title = text;
      else if (!covers(el.title, text)) el.title = `${text} · ${el.title}`;
    }
  }

  /** Проставляє підказки до скорочень скрізь, де вони трапляються: заголовки
   *  колонок, підписи, назви підрозділів. Те, що вже має свій `title`, не
   *  чіпаємо — там пояснення конкретніше. */
  function bindGlossary() {
    const scope = $('#scroll');
    if (!scope) return;
    const sel = '.tbl__h, .card__title, .chip__label, .spec__k, label, .seg button,'
      + ' .c-name b, .c-name small, .c-txt, .att__text, .panel__note b,'
      + ' .tile__label, .tile__hint';
    let n = 0;
    for (const el of scope.querySelectorAll(sel)) {
      if (n++ > 400) break;                  // довгі стрічки не обходимо цілком
      if (el.querySelector('input, select')) continue;
      const text = el.textContent.trim();
      if (!text || text.length > 70) continue;
      const hint = hintFor(text);
      if (!hint) continue;
      // Комірка вже несе повний текст (бо обрізана) — скорочення дописуємо поруч.
      el.title = el.title && el.title !== hint ? `${el.title} · ${hint}` : hint;
    }
  }

  function bindSelect(sel, fn) {
    const el = $(sel);
    if (el) el.addEventListener('change', () => { fn(el.value); render(); });
  }

  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // ------------------------------------------------ документи, внесені тут
  const STORE_OF = { in: 'incoming', mv: 'movement', wr: 'writeoffs' };

  /** Рядки документа в стані програми: [вид, масив, індекси]. Тут усі
   *  документи — і з паперових журналів служби, і внесені в програмі. */
  function storeRowsOf(key) {
    const [kind, d, no, from, to] = key.split('|');
    const arr = store.docs[STORE_OF[kind]] || [];
    const idx = [];
    // Маршрут — частина ключа: той самий номер того самого дня на інший
    // підрозділ — інший документ, і правити треба саме його рядки.
    arr.forEach((r, i) => {
      if (r[0] !== d || String(r[2]).trim() !== no) return;
      if (from !== undefined && String(r[3] ?? '').trim() !== from) return;
      if (to !== undefined && String(r[4] ?? '').trim() !== to) return;
      idx.push(i);
    });
    return { kind, d, no, from, to, arr, idx };
  }

  /** «Накладна №17 від 02.03.2026» — назва документа за його ключем. */
  function docTitleOf(key) {
    const { kind, d, no, arr, idx } = storeRowsOf(key);
    return `${(idx.length && arr[idx[0]][1]) || KIND_NAME[kind] || 'Документ'} ${numNo(no)} від ${fmtDate(d)}`;
  }

  /** Перше місце, де залишок іде в мінус, або null.
   *
   *  Видалити прихід, з якого потім видавали, — означає створити видачу з
   *  нічого. Тому перед видаленням і після правки перераховується вся стрічка
   *  проводок по зачеплених позиціях, а не лише дата самого документа.
   */
  /** Найглибший мінус по кожній парі «код|підрозділ» у стрічці проводок. */
  function negProfile(codes) {
    const run = new Map(), worst = new Map();
    for (const e of buildLedger()) {
      if (!codes.has(e.code)) continue;
      const k = e.code + '|' + e.sub;
      const v = (run.get(k) || 0) + e.sg * e.q;
      run.set(k, v);
      if (v < -1e-9 && (!worst.has(k) || v < worst.get(k).v - 1e-9)) {
        worst.set(k, { code: e.code, sub: e.sub, d: e.d, no: e.no, v });
      }
    }
    return worst;
  }

  /** Мінус, якого до зміни не було (або глибший за той, що вже був).
   *
   *  Перевіряється вся стрічка далі по часу, а не лише дата документа: прихід,
   *  внесений заднім числом, чи видалений прихід, з якого потім видавали, дають
   *  мінус у пізніших документах. Мінуси, що вже є в базі, роботи не блокують —
   *  лише нові. */
  function newNegative(codes, before) {
    for (const [k, x] of negProfile(codes)) {
      const was = before.get(k);
      if (!was || x.v < was.v - 1e-9) return x;
    }
    return null;
  }

  /** Знищеного, ще не списаного, більше, ніж числиться: майно пішло з підрозділу
   *  вже після того, як його знищено, — рапорт або накладна хибні, а фактична
   *  наявність іде в мінус. Найгірше місце на кожну пару «код|підрозділ». */
  function dzProfile(codes) {
    const out = new Map();
    const gone = new Map();
    for (const r of allDestroyed()) {
      if (!codes.has(r.code)) continue;
      const k = r.code + '\u0000' + r.sub;
      if (!gone.has(k)) gone.set(k, []);
      gone.get(k).push([r.date, 0, +r.qty || 0]);
      if (r.status === 'списано' && r.actDate) gone.get(k).push([r.actDate, 0, -(+r.qty || 0)]);
    }
    if (!gone.size) return out;
    const led = buildLedger();
    for (const [k, evs] of gone) {
      const [code, sub] = k.split('\u0000');
      const all = led.filter((e) => e.code === code && e.sub === sub).map((e) => [e.d, e.sg * e.q, 0])
        .concat(evs).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      let stock = 0, dz = 0;
      all.forEach(([d, q, g], i) => {
        stock += q; dz += g;
        if (all[i + 1] && all[i + 1][0] === d) return;          // підсумок — на кінець дня
        const over = round3(dz - stock);
        if (over > 1e-9 && (!out.has(k) || over > out.get(k).over + 1e-9)) {
          out.set(k, { code, sub, d, over, stock: round3(stock), gone: round3(dz) });
        }
      });
    }
    return out;
  }
  function newDzOver(codes, before) {
    for (const [k, x] of dzProfile(codes)) {
      const was = before.get(k);
      if (!was || x.over > was.over + 1e-9) return x;
    }
    return null;
  }
  const dzOverMessage = (x) => `«${(itemBy.get(x.code) || {}).name || x.code}»: на ${fmtDate(x.d)} у «${x.sub}» `
    + `числиться ${fmtNum(x.stock, '0')}, а знищеного й ще не списаного — ${fmtNum(x.gone)}. `
    + 'Знищене не переміщують: спершу спишіть його актом або перевірте дату рапорту.';

  /** Перший розрив у ланцюжку одиниці із заводським номером: накладна видає її
   *  звідти, де її на той час немає. Видалити чи переписати документ, яким кухня
   *  приїхала, означає лишити пізнішу накладну без неї. */
  function unitBreak(units) {
    if (!units || !units.size) return null;
    const moves = new Map();
    for (const r of buildDocs()) {
      const id = String(r.unit || '');
      if (!id || !units.has(id)) continue;
      if (!moves.has(id)) moves.set(id, []);
      moves.get(id).push(r);
    }
    for (const [id, arr] of moves) {
      arr.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : KIND_ORDER[a.kind] - KIND_ORDER[b.kind]));
      let holder = null;
      for (const r of arr) {
        if (r.kind === 'in') { holder = r.to; continue; }
        if (holder !== null && r.from !== holder) return { id, row: r, holder };
        holder = r.kind === 'wr' ? '' : r.to;
      }
    }
    return null;
  }

  function unitMessage(b) {
    const it = itemBy.get(b.row.code);
    return `${it ? cleanName(it.name) : b.row.code}, ${unitLabel(unitBy.get(String(b.id)))}: документ `
      + `${numNo(b.row.no)} від ${fmtDate(b.row.d)} видає її з «${b.row.from}», а за обліком вона `
      + `${b.holder ? `в «${b.holder}»` : 'ніде не числиться'}. Спершу виправте той документ.`;
  }

  /** Пояснення, чому зміна не пройшла, — з порадою під конкретну дію:
   *  новий документ забирає майно, яке пізніше вже видали; видалення чи
   *  виправлення лишає без майна пізніший документ. */
  function negMessage(neg, mode = 'edit') {
    const it = itemBy.get(neg.code);
    const what = `залишок «${it ? it.name : neg.code}» у «${neg.sub}» стане від’ємним (${fmtNum(neg.v)}) `
      + `за документом ${numNo(neg.no)} від ${fmtDate(neg.d)}. `;
    return what + (mode === 'new'
      ? 'Це майно пізніше видано. Зменште кількість або перевірте дату документа.'
      : 'Спершу виправте або видаліть той документ.');
  }

  function deleteDoc(key) {
    const { kind, d, no, arr, idx } = storeRowsOf(key);
    if (!idx.length) {
      alert('Документ не знайдено. Оновіть сторінку (F5).');
      return;
    }
    const rows = idx.map((i) => arr[i]);
    const names = rows.map((r) => {
      const code = r[5];
      const qty = r[6];
      const it = itemBy.get(code);
      return `  • ${it ? it.name : code} — ${fmtNum(qty)}`;
    }).join('\n');
    const files = filesOf(key).length;
    // Акт, яким списано знищене: після видалення воно знову знищене, не списане.
    const closing = kind === 'wr' ? allDestroyed().filter((x) => x.status === 'списано'
      && (x.actId ? actDocKey(x) === key : x.act && actDocsOf(x).some((w) => keyOfRow(w) === key))) : [];
    if (!confirm(`Видалити документ ${numNo(no)} від ${fmtDate(d)}?\n\n${names}\n\nУсі його рядки буде знято з обліку.`
      + (files ? `\nДо документа підшито ${cnt(files, 'файл', 'файли', 'файлів')}: ${files === 1 ? 'він лишиться' : 'вони лишаться'} в теці «скани».` : '')
      + (closing.length ? `\nЦим актом списано знищене за рапортами (${cnt(closing.length, 'запис', 'записи', 'записів')}): `
        + 'воно знову рахуватиметься знищеним, не списаним.' : ''))) return;
    const lock = periodLock([d], rows.flatMap((r) => [r[3], kind === 'wr' ? '' : r[4]]));  // одержувач вибуття — не підрозділ
    if (lock && !confirm(lock.replace('Провести все одно?', 'Видалити все одно?'))) return;
    const codes = new Set(rows.map((r) => r[5]));
    const units = new Set(rows.map((r) => String(rowUnit(kind, r) || '')).filter(Boolean));
    const before = negProfile(codes);
    const kept = arr.filter((_, i) => !idx.includes(i));
    const backup = arr.slice();
    store.docs[STORE_OF[kind]] = kept;
    const neg = newNegative(codes, before);
    const broke = neg ? null : unitBreak(units);
    if (neg || broke) {
      store.docs[STORE_OF[kind]] = backup;
      alert('Документ не видалено: ' + (neg ? negMessage(neg) : unitMessage(broke)));
      return;
    }
    logChange('видалено', key, `${kindName({ kind, to: kind === 'wr' ? rows[0][4] : '' })} ${numNo(no)} від ${fmtDate(d)}: ${names.replace(/\n\s*•\s*/g, '; ').replace(/^\s*•\s*/, '')}`
      + (lock ? ' — у закритому періоді' : ''));
    // Бюджетні реквізити надходження зникають разом із ним: новий документ під тим самим id починає з чистого.
    if (kind === 'in') for (const id of new Set(rows.map((r) => rowId('in', r)).filter(Boolean))) mtzForget(id);
    // Видалили документ, який саме виправляли: форма закривається, інакше
    // «Зберегти виправлення» внесло б його знову, уже новим документом.
    if (state.editing === key) { state.editing = null; state.draft = null; state.formOpen = false; }
    save(true, true);
    // Із картки видаленого документа повертаємось туди, звідки її відкрили.
    if (state.view === 'doc') state.view = state.docBack && state.docBack !== 'doc' ? state.docBack : 'moves';
    refresh();
    toast(`Документ ${numNo(no)} від ${fmtDate(d)} видалено.`);
  }

  /** Виправлення — це той самий документ у формі: рядки повертаються в
   *  чернетку, а оригінал лишається в обліку, доки нова редакція не пройде
   *  перевірок. Скасування правки нічого не змінює. */
  /** Проведено акт списання, а в підрозділі є знищене без акта на ті самі
   *  позиції — пропонуємо закрити ці записи цим актом, щоб знищене не
   *  віднімалось від наявності вдруге. */
  function offerDestroyedLink(h) {
    const key = docKey('wr', h.date, h.no, h.from, h.to || '');
    const rows = docs.filter((r) => keyOfRow(r) === key);
    // Скільки акт іще може закрити: його кількість мінус уже закрите ним. Запис,
    // що не вміщається цілим, не пропонуємо — інакше акт на 3 «закрив» би 5.
    const room = new Map();
    for (const r of rows) room.set(r.code, round3((room.get(r.code) || 0) + (+r.q || 0)));
    const units = new Set(rows.filter((r) => r.unit).map((r) => String(r.unit)));
    for (const x of allDestroyed()) {
      if (x.status !== 'списано' || !(x.actId ? actDocKey(x) === key
        : x.act && actDocsOf(x).some((w) => keyOfRow(w) === key))) continue;
      room.set(x.code, round3((room.get(x.code) || 0) - (+x.qty || 0)));
      if (x.unit) units.delete(String(x.unit));
    }
    const open = allDestroyed().filter((x) => x.sub === h.from && !x.act && !x.actId && x.status !== 'списано'
      && x.date <= h.date && room.get(x.code) > 0)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const pick = [];
    let skipped = 0;
    for (const x of open) {
      const q = +x.qty || 0;
      if ((x.unit && !units.has(String(x.unit))) || room.get(x.code) < q) { skipped++; continue; }
      room.set(x.code, round3(room.get(x.code) - q));
      if (x.unit) units.delete(String(x.unit));
      pick.push(x);
    }
    if (!pick.length) return;
    const list = pick.map((x) => `  • ${(itemBy.get(x.code) || {}).name || x.code}${
      x.unit ? ' (' + unitLabel(unitBy.get(String(x.unit))) + ')' : ''} — ${fmtNum(x.qty)}, `
      + `рапорт №${x.report || '—'} від ${fmtDate(x.date)}`).join('\n');
    if (!confirm(`У «${h.from}» є знищене без акта на ці позиції:\n\n${list}\n\nЗакрити ці записи актом ${numNo(h.no)}?`
      + (skipped ? `\n\nЩе ${cnt(skipped, 'запис', 'записи', 'записів')} не вміщається в кількість акта — їх не включено.` : ''))) return;
    for (const x of pick) {
      const r = store.destroyed.find((y) => y.id === x.id);
      if (r) r.act = h.no;
    }
    dzCache = null;
    save();
  }

  /** Вийти з режиму виправлення — лише за згодою. Інакше форма нового документа
   *  відкривалась із заголовком «Виправлення документа», і проведення підміняло
   *  документ, що виправлявся. */
  function leaveEditing() {
    if (!state.editing && state.editingReport) {
      if (!confirm(`Скасувати виправлення рапорту ${numNo(state.editingReport.no)}?\n\nРапорт лишиться без змін.`)) return false;
      state.editingReport = null;
      state.draft = null;
      return true;
    }
    if (!state.editing) return true;
    const no = state.editing.split('|')[2];
    if (!confirm(`Скасувати виправлення документа ${numNo(no)}?\n\nДокумент лишиться без змін.`)) return false;
    state.editing = null;
    state.draft = null;
    return true;
  }

  /** Незавершену чернетку — у бік, перш ніж форма отримає інший документ. */
  function stashDraft() {
    if (!state.editing && state.draft && hasContent(state.draft)) {
      state.drafts = state.drafts || {};
      state.drafts[slotOf(state.draft.kind, state.draft.book || 'ТЗ')] = state.draft;
    }
  }

  /** Примітка рядка в обліку: підстава документа, його примітка й примітка рядка
   *  через «; ». Так вона склалася в паперових журналах — і так її читає
   *  виправлення. */
  const composeNote = (h, ln) => [h.basis && 'підстава: ' + String(h.basis).replace(/;/g, ','),
    h.note, ln.note].filter(Boolean).join('; ');
  /** Обставини рапорту — підстава й обставини з шапки, спільні для всіх його
   *  рядків (примітка рядка — вони ж плюс свій текст). */
  const reportCirc = (h) => composeNote(h, {});
  /** Запис про знищення з рядка форми рапорту: техзасоби — позицією (з ціною
   *  за документом, коли її вказано), інше майно — назвою, кількістю, ціною й
   *  документом списання; акта програми в нього немає. */
  function dzRecord(h, ln, id, origin) {
    const rec = { id, date: h.date, sub: h.from, code: ln.other ? '' : ln.code, qty: +ln.qty, report: h.no,
      reportDate: h.reportDate || '', circ: reportCirc(h), lnote: ln.note || '', note: composeNote(h, ln), origin };
    if (String(ln.price ?? '').trim() !== '') rec.price = +ln.price;
    if (ln.other) {
      return Object.assign(rec, { other: true, name: String(ln.name || '').trim(), uom: String(ln.uom || '').trim(),
        offNo: String(ln.offNo || '').trim(), offDate: ln.offDate || '', act: '' });
    }
    return Object.assign(rec, { act: h.act || '' }, ln.unit ? { unit: String(ln.unit) } : {});
  }

  /** Чернетка з рядків документа — те саме, що в папері: рядок на кожну ціну
   *  партії, на кожну одиницю із заводським номером і на кожну примітку. База
   *  могла розкласти рядок на кілька партій — вони збираються назад в один. */
  function draftFromRows(kind, rows) {
    const first = rows[0];
    const noteOf = (r) => String(r[7] || '');
    const basisOf1 = (n) => (n.startsWith('підстава: ') ? n.split('; ')[0].slice(10) : '');
    const basis = basisOf1(noteOf(first));
    // Підстава спільна для всього документа; різна по рядках — лишається в них.
    const shared = !!basis && rows.every((r) => basisOf1(noteOf(r)) === basis);
    const rest = (r) => {
      const parts = noteOf(r).split('; ');
      if (shared) parts.shift();
      return parts.join('; ');
    };
    const lines = new Map();
    for (const r of rows) {
      const price = +r[8] || 0;
      const lot = kind === 'in' ? '' : String(r[9] || '');
      const ln = { code: String(r[5]),
                   qty: +r[6] || 0,
                   price: kind === 'in' ? String(price || '') : (lot ? String(price) : ''),
                   note: rest(r), lot, unit: String(rowUnit(kind, r) || '') };
      const have = lines.get(lineKeyOf(ln, kind));
      if (!have) { lines.set(lineKeyOf(ln, kind), ln); continue; }
      if (lot && lot < have.lot) have.lot = lot;
      have.qty = round3(have.qty + ln.qty);
    }
    return {
      kind,
      head: { type: first[1] || '', no: String(first[2]).trim(), date: first[0], from: first[3],
              to: first[4] || '', basis: shared ? basis : '',
              report: '', reportDate: '', act: '', note: '' },
      lines: [...lines.values()].map((ln) => Object.assign(ln, { qty: String(ln.qty) })),
    };
  }

  /** Рядки журналу з чернетки: поля паперу, ціна, дата партії, службовий хвіст
   *  (id документа в базі й походження) і одиниця із заводським номером. */
  function rowsFromDraft(k, h, lines, tail = []) {
    const id = tail[1] || 0, origin = tail[2] || 'program';
    return lines.map((ln) => {
      const svc = k === 'in' ? [linePrice(ln, k)] : [ln.lot ? +ln.price || 0 : 0, ln.lot || ''];
      if (id || ln.unit) {
        if (k === 'in') svc.push(h.date);      // прихід сам є партією — від своєї дати
        svc.push(id, origin);
        if (ln.unit) svc.push(+ln.unit || ln.unit);
      }
      const head = [h.date, h.type, h.no, h.from, k === 'in' ? (h.to || 'склад') : h.to || ''];
      return head.concat([ln.code, +ln.qty, composeNote(h, ln)], svc);
    });
  }

  function editDoc(key) {
    const { kind, arr, idx } = storeRowsOf(key);
    if (!idx.length) {
      alert('Документ не знайдено. Оновіть сторінку (F5).');
      return;
    }
    if (state.editing && state.editing !== key && !leaveEditing()) return;
    stashDraft();
    state.moveKind = kind;
    state.draft = draftFromRows(kind, idx.map((i) => arr[i]));
    state.draft.book = bookOf(state.draft.lines[0] ? state.draft.lines[0].code : '');
    state.draft.lines.push(emptyLine());
    state.editing = key;
    state.formOpen = true;
    go('moves', { q: '', formOpen: true, book: state.draft.book });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
  }

  // ------------------------------------------------ друк документа
  const W_ONES = { m: ['', 'один', 'два', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"],
                   f: ['', 'одна', 'дві', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"] };
  const W_TEENS = ['десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять',
    "п'ятнадцять", 'шістнадцять', 'сімнадцять', 'вісімнадцять', "дев'ятнадцять"];
  const W_TENS = ['', '', 'двадцять', 'тридцять', 'сорок', "п'ятдесят", 'шістдесят',
    'сімдесят', 'вісімдесят', "дев'яносто"];
  const W_HUND = ['', 'сто', 'двісті', 'триста', 'чотириста', "п'ятсот", 'шістсот',
    'сімсот', 'вісімсот', "дев'ятсот"];
  function words999(n, g) {
    const out = [];
    if (n >= 100) { out.push(W_HUND[Math.floor(n / 100)]); n %= 100; }
    if (n >= 10 && n <= 19) out.push(W_TEENS[n - 10]);
    else { if (n >= 20) { out.push(W_TENS[Math.floor(n / 10)]); n %= 10; } if (n) out.push(W_ONES[g][n]); }
    return out.join(' ');
  }
  /** Сума прописом у форматі, що вже стоїть у документах служби:
   *  «Дві тис. триста сорок п'ять грн. 60 коп.» */
  function moneyWords(sum) {
    const kop = Math.round(sum * 100);
    let n = Math.floor(kop / 100);
    const k = String(kop % 100).padStart(2, '0');
    if (n === 0) return `Нуль грн. ${k} коп.`;
    const parts = [];
    for (const [v, label, g] of [[1e9, 'млрд.', 'm'], [1e6, 'млн.', 'm'], [1e3, 'тис.', 'f']]) {
      if (n >= v) { parts.push(words999(Math.floor(n / v), g), label); n %= v; }
    }
    if (n) parts.push(words999(n, 'f'));
    const t = parts.filter(Boolean).join(' ');
    return `${t[0].toUpperCase()}${t.slice(1)} грн. ${k} коп.`;
  }

  /** Кількість прописом: «Чотири», «Три цілих 5 десятих» не вигадуємо —
   *  дробова частина лишається цифрами, як у бланках служби. */
  function qtyWords(q) {
    const whole = Math.floor(q), frac = Math.round((q - whole) * 1000);
    let t = whole === 0 ? 'нуль' : '';
    if (whole) {
      let n = whole;
      const parts = [];
      for (const [v, label, g] of [[1e9, 'млрд.', 'm'], [1e6, 'млн.', 'm'], [1e3, 'тис.', 'f']]) {
        if (n >= v) { parts.push(words999(Math.floor(n / v), g), label); n %= v; }
      }
      if (n) parts.push(words999(n, 'f'));
      t = parts.filter(Boolean).join(' ');
    }
    t = t[0].toUpperCase() + t.slice(1);
    return frac ? `${t} ціла ${frac} тисячних` : t;
  }

  /** Коротке повідомлення в куті вікна. На відміну від плашки над формою,
   *  його видно на будь-якому екрані — вивантажують і з журналів, і з довідників. */
  function toast(text, bad = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' toast--bad' : '');
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('toast--out'), 5500);
    setTimeout(() => el.remove(), 6200);
  }

  // ------------------------------------------------ вивантаження в Excel
  /** Друк іде через Excel: програма складає таблицю, сервер пише .xlsx у
   *  «Дані обліку/вивантаження» й одразу відкриває його. Без сервера (файл
   *  відкрито просто в браузері) — CSV, який Excel теж відкриє. */
  async function toExcel(spec) {
    if (!native) {
      const sh = (spec.sheets || [])[0];
      if (!sh) { alert('Вивантаження в Excel доступне в програмі на комп’ютері.'); return; }
      const flat = (row) => row.flatMap((c) => (c && typeof c === 'object'
        ? [c.t].concat(Array((c.span || 1) - 1).fill('')) : [c]));
      downloadCsv(spec.file || 'вивантаження', [...(sh.head || []).map(flat), ...(sh.rows || [])]);
      return;
    }
    try {
      const r = await fetch('api/excel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'помилка вивантаження');
      if (j.download) {
        // З іншого ПК: файл лягає на основному ПК, а браузер забирає його собі в «Завантаження».
        const a = document.createElement('a');
        a.href = j.download;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 1000);
        toast(`Файл завантажено: ${String(j.path || '').split(/[\\/]/).pop()}` + (spec.note ? `. ${spec.note}` : ''));
        return;
      }
      toast((j.opened ? `Відкрито ${spec.word ? 'у Word' : 'в Excel'}: ${j.path}` : `Файл збережено: ${j.path}`)
        + (spec.note ? `. ${spec.note}` : ''));
    } catch (e) {
      toast(`Не вдалося вивантажити ${spec.word ? 'у Word' : 'в Excel'}: ${e.message}`, true);
    }
  }

  function downloadCsv(name, rows) {
    // \u0414\u0430\u0442\u0438 \u2014 \u044f\u043a \u0443 \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u0430\u0445 \u0441\u043b\u0443\u0436\u0431\u0438: 11.09.2026, \u0430 \u043d\u0435 2026-09-11.
    const cell = (c) => (typeof c === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c) ? fmtDate(c) : String(c ?? ''));
    const csv = '\ufeff' + rows.map((r) => r.map((c) =>
      `"${cell(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${String(name).replace(/(\d{4})-(\d{2})-(\d{2})/g, '$3.$2.$1')}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  const OPERATION = { mv: 'Розподіл (видача)', in: 'Надходження', wr: 'Списання' };

  /** Документ у Excel. Накладна й прихід — на бланку служби «Накладна
   *  (вимога)», Додаток 25; акт списання — таблицею з підписами комісії. */
  function docExcel(key) {
    const [kind, d, no] = key.split('|');
    const rows = docs.filter((r) => keyOfRow(r) === key);
    if (!rows.length) return;
    const first = rows[0];
    const basis = basisOf(first.note);
    let qty = 0, sum = 0;
    const lines = rows.flatMap((r) => rowParts(r).map((p) => {
      const it = itemBy.get(r.code) || {};
      const u = r.unit ? unitBy.get(String(r.unit)) : null;
      qty += p.q; sum += p.price * p.q;
      // Номер одиниці стоїть у бланку поруч із назвою — так його пишуть у папері;
      // категорія — її, на дату документа. Кількістю категорія не відома — порожньо.
      return { name: (it.name || r.code) + (u ? `, ${unitLabel(u)}` : ''), code: r.code,
               uom: it.unit || '', cat: u ? catAt(u, d) : '', price: p.price, qty: p.q, note: cleanNote(r.note) };
    }));
    const nWords = `${cnt(rows.length, 'найменування', 'найменування', 'найменувань')}`;
    if (kind !== 'wr') {
      // Підписанти й місце складання — з довідників на дату накладної: торішня
      // накладна друкується тими, хто тоді відповідав, і там, де її складали.
      const who = (p) => (p ? signer(p, d) : null);
      const spec = {
        kind: 'invoice', file: `Накладна ${no} від ${d}`, no, date: d,
        operation: OPERATION[kind], basis, place: locationAt(d), unit: unitInfo(),
        sender: first.from, receiver: first.to,
        sender_person: kind === 'in' ? null : who(mvoFor(first.from, d)),
        receiver_person: who(mvoFor(first.to, d)),
        chief: who(officialAt('начальник служби', d)),
        accountant: who(officialAt('бухгалтер', d)),
        fes: who(officialAt('начальник ФЕС', d)),
        lines, qty_words: `${qtyWords(qty)} (усього ${nWords})`, sum_words: moneyWords(sum),
      };
      // Кого немає в довідниках на дату документа — того рядок у бланку
      // порожній; мовчати про це не можна, бо накладну підпишуть як є.
      const missing = [
        [spec.place, 'місце складання (вкладка «Дислокація»)'],
        [kind === 'in' || spec.sender_person, `МВО «${first.from}»`],
        [spec.receiver_person, `МВО «${first.to}»`],
        [spec.chief, 'начальник служби'],
        [spec.accountant, 'бухгалтер ФЕС'],
        [spec.fes, 'начальник ФЕС'],
      ].filter(([x]) => !x).map(([, name]) => name);
      if (missing.length) {
        toast(`У накладній лишаться порожні рядки. На ${fmtDate(d)} не знайдено: `
          + `${missing.join(', ')}. Додайте в «Люди й МВО».`, true);
      }
      return toExcel(spec);
    }
    // Назва — з виду паперу («Акт ПП ОЗ», «Витяг із наказу»), а не завжди «акт
    // списання»; примітки рядків — окремою графою, як у папері.
    const paper = String(first.t || '').trim() || (first.to ? 'Акт ПП' : 'Акт списання');
    // «Акт ПП» у бланку — повністю: «Акт приймання-передачі».
    const title = paper.replace(/^акт\s+пп(?=\s|$)/i, 'Акт приймання-передачі');
    const notes = lines.some((x) => x.note);
    return toExcel({
      file: `${paper} ${no} від ${d}`,
      sheets: [{
        name: paper.replace(/[[\]:*?\/\\]/g, ' ').slice(0, 31), orientation: notes ? 'landscape' : 'portrait',
        top: [unitInfo().legalName, unitInfo().serviceFull],
        title: `${title.toUpperCase()} № ${no}`, subtitle: `від ${fmtDate(d)}`,
        lines: (first.to ? [`Передає: ${unitInfo().legalName || 'військова частина'}, ${first.from}`, `Приймає: ${first.to}`]
          : [`Підрозділ: ${first.from}`]).concat(basis ? [`Підстава: ${basis}`] : []),
        head: [['№ з/п', 'Найменування', 'Код', 'Од. вим.', 'Кількість', 'Ціна, грн', 'Сума, грн']
          .concat(notes ? ['Примітка'] : [])],
        widths: [6, 46, 11, 9, 11, 12, 14].concat(notes ? [36] : []),
        rows: lines.map((x, i) => [i + 1, x.name, x.code, x.uom, x.qty, x.price || '', x.price * x.qty || '']
          .concat(notes ? [x.note || ''] : [])),
        num: [4], money: [5, 6], total: ['', 'Разом', '', '', qty, '', sum].concat(notes ? [''] : []),
        after: [`Усього ${nWords}, ${qtyWords(qty).toLowerCase()} од. На суму: ${moneyWords(sum)}`],
        signs: first.to ? ['Передав (посада, звання, підпис, ПІБ)', 'Прийняв (посада, звання, підпис, ПІБ)']
          : ['Голова комісії (посада, звання, підпис, ПІБ)', 'Члени комісії (посада, звання, підпис, ПІБ)'],
      }],
    });
  }

  /** Сторінка книги № 47 для бланка: значення граф так, як їх пише book47_export. */
  function j47Spec(code) {
    const { it, blocks, rows } = j47Model(code);
    return {
      code, name: it.name, uom: it.unit || '', price: +it.price || 0, prices: lotPricesText(it.code), blocks,
      rows: rows.map(({ r, inQ, outQ, run, cells, party }) => ({
        rec: r.d, type: r.t, no: String(r.no), date: r.d, party,
        in: inQ || null, out: outQ || null, total: run,
        // У графі підрозділу — лише залишок, який змінив цей документ.
        cells: cells.map((c) => (c.hit ? c.bal : null)),
      })),
    };
  }

  /** Журнал № 47 у Excel — на бланку Додатка 47: сторінка поточної позиції
   *  або вся книга (титул, зміст і по аркушу на кожну позицію з рухом). */
  function j47Excel(all = false) {
    if (!native) {
      if (all) { toast('Уся книга вивантажується в програмі на комп’ютері.', true); return; }
      const x = j47Spec(state.j47code);
      const head = ['Дата запису', 'Найменування документа', 'Номер документа', 'Дата документа',
        'Постачальник (одержувач)', 'Надійшло', 'Вибуло', 'Перебуває'].concat(x.blocks);
      downloadCsv(`Журнал 47 — ${x.code}`, [head, ...x.rows.map((r) => [fmtDate(r.rec), r.type, r.no,
        fmtDate(r.date), r.party, r.in ?? '', r.out ?? '', r.total].concat(r.cells.map((v) => v ?? '')))]);
      return;
    }
    const build = () => {
      const list = (all ? j47Options().map((o) => o.value) : [state.j47code]).map(j47Spec);
      const one = list[0];
      return toExcel({
        kind: 'book47', book: all, unit: unitInfo().legalName.replace(/^Військова частина\s*/i, ''),
        service: unitInfo().serviceFull, items: list,
        file: all ? `Книга обліку № 47 станом на ${fmtDate(today())}`
          : `Журнал 47 — ${one.code} ${one.name || ''}`.slice(0, 110),
      });
    };
    if (!all) return build();
    // Уся книга — по сторінці на кожну позицію з рухом, це десятки секунд:
    // спершу кажемо про це, і лише після того, як напис намалювався, рахуємо.
    toast('Готуємо всю книгу, це може тривати до хвилини…');
    return new Promise((resolve) => setTimeout(() => resolve(build()), 60));
  }

  /** Журнал № 14 у Excel: по аркушу на кожні десять позицій — як розворот
   *  канонічної книги, і жодна позиція не відпадає. */
  function j14Excel() {
    const sub = state.j14sub;
    const lines = chrono(docs.filter((r) => (r.from === sub || r.to === sub) && bookOf(r.code) === state.book));
    const codes = [...new Set(lines.map((r) => r.code))].sort((a, b) => a.localeCompare(b));
    const sheets = [];
    for (let p = 0; p < codes.length; p += J14_PER_PAGE) {
      const shown = codes.slice(p, p + J14_PER_PAGE);
      const set = new Set(shown);
      const run = new Map(shown.map((c) => [c, 0]));
      const rows = lines.filter((r) => set.has(r.code)).map((r) => {
        const counter = r.kind === 'mv' ? (r.to === sub ? r.from : r.to) : r.kind === 'in' ? r.from : 'списано';
        const cells = shown.flatMap((c) => {
          let plus = 0, minus = 0;
          if (r.code === c) { if (r.to === sub) plus = r.q; if (r.from === sub) minus = r.q; }
          const cur = (run.get(c) || 0) + plus - minus;
          run.set(c, cur);
          return [plus || '', minus || '', r.code === c ? cur : ''];
        });
        return [fmtDate(r.d), r.t, `${r.no} від ${fmtDate(r.d)}`, counter].concat(cells);
      });
      const head1 = ['Дата запису', 'Найменування документа', 'Номер і дата документа', 'Постачальник (одержувач)']
        .concat(shown.map((c) => ({ t: `${c} · ${(itemBy.get(c) || {}).name || ''}`, span: 3 })));
      const head2 = ['', '', '', ''].concat(shown.flatMap(() => ['надійшло', 'вибуло', 'становить']));
      sheets.push({
        name: `стор. ${sheets.length + 1}`, orientation: 'landscape',
        top: [unitTop()],
        title: 'КНИГА обліку наявності та руху військового майна (склад, підрозділ)',
        subtitle: `${sub} · сторінка ${sheets.length + 1}`,
        head: [head1, head2], widths: [11, 15, 20, 22].concat(shown.flatMap(() => [8, 8, 9])),
        rows, num: shown.flatMap((_, i) => [4 + i * 3, 5 + i * 3, 6 + i * 3]),
      });
    }
    if (!sheets.length) { alert('У цьому підрозділі руху немає.'); return; }
    return toExcel({ file: `Журнал 14 — ${sub}`, sheets });
  }

  /** Відомість інвентарних номерів: аркуш на підрозділ, діапазонами. */
  function invExcel() {
    const bySub = new Map();
    for (const r of regRows(inventorySpec())) {
      if (!bySub.has(r.sub)) bySub.set(r.sub, []);
      bySub.get(r.sub).push(r);
    }
    const sheets = [...bySub.entries()].map(([sub, list]) => ({
      name: sub, orientation: 'portrait',
      top: [unitTop()],
      title: 'ВІДОМІСТЬ інвентарних номерів', subtitle: `${sub} · номери наносяться на кожну одиницю`,
      head: [['№', 'Код', 'Найменування', 'Інвентарні номери', 'Одиниць']],
      widths: [5, 9, 52, 26, 9],
      rows: list.map((r, i) => {
        const it = itemBy.get(r.code) || {};
        const span = r.from === r.to ? invNo(r.code, r.from) : `${invNo(r.code, r.from)} — ${invNo(r.code, r.to)}`;
        return [i + 1, r.code, it.name || '', span, r.to - r.from + 1];
      }),
      num: [4], total: ['', '', 'Разом одиниць', '', list.reduce((a, r) => a + r.to - r.from + 1, 0)],
    }));
    if (!sheets.length) { alert('Одиниць із заводськими номерами ще немає — нема чого вивантажувати.'); return; }
    return toExcel({ file: `Відомість інвентарних номерів ${state.asOf}`, sheets });
  }

  /** Будь-який список на екрані — таблицею з тими самими фільтрами. */
  function listExcel() {
    const [name, rows] = exportRows();
    const head = rows[0], body = rows.slice(1);
    const numCols = head.map((_, i) => i).filter((i) => body.length && body.every((r) => r[i] === '' || typeof r[i] === 'number'));
    return toExcel({
      file: `Облік ТЗ — ${name} ${state.asOf}`,
      sheets: [{
        name, orientation: head.length > 6 ? 'landscape' : 'portrait',
        top: [unitTop()],
        title: name[0].toUpperCase() + name.slice(1), subtitle: `станом на ${fmtDate(state.asOf)}`,
        head: [head], widths: head.map((h) => (/найменування|примітка/.test(h) ? 44 : /підрозділ|звідки|куди/.test(h) ? 20 : 12)),
        rows: body, num: numCols,
      }],
    });
  }

  // ------------------------------------------------ власні позиції номенклатури
  /** Позиції, заведені в програмі. Прийшло нове обладнання — його треба мати в
   *  довіднику до того, як оприбуткувати: інакше в накладній його просто нема
   *  чого обрати. Зберігаються разом з іншими внесеними даними. */
  const ownItem = (r) => ({ code: String(r.code), name: r.name, group: r.group, unit: r.unit,
    price: +r.price || 0, cat: 0, serial: '', chassis: '', year: 0, nonrev: r.nonrev ? 1 : 0, own: true,
    fes: r.fes || '', note: r.note || '', old: r.old || '', archived: r.archived || '' });

  /** Позиції, заведені в програмі, приходять із бази разом з усіма іншими; тут
   *  лише підтримується робочий перелік між збереженнями — щойно заведену
   *  позицію треба бачити одразу, не чекаючи перезапуску. */
  const itemsReady = new WeakSet();
  function mergeOwnItems() {
    // Позиції, заведені в програмі, живуть у базі й після перезапуску приходять
    // із довідником (D.items, own), а не зі стану. Раніше порожній стартовий
    // перелік їх відкидав: картка зникала, наступна нова позиція брала той самий
    // код, а позиція, що вже була в документах, зупиняла всі збереження.
    if (!itemsReady.has(store)) {
      itemsReady.add(store);
      const had = new Map((Array.isArray(store.items) ? store.items : []).map((r) => [String(r.code), r]));
      for (const i of items) {
        if (i.own && !had.has(i.code)) {
          had.set(i.code, { code: i.code, name: i.name, group: i.group, unit: i.unit, price: i.price,
                            nonrev: !!i.nonrev });
        }
      }
      store.items = [...had.values()];
    }
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].own) { itemBy.delete(items[i].code); items.splice(i, 1); }
    }
    for (const r of store.items || []) {
      const base = itemBy.get(String(r.code));
      if (base && !base.own) {
        // Правка позиції з паперів служби: міняється те, що правили; код,
        // заводські номери, партії й номер ФЕС лишаються базовими.
        Object.assign(base, { name: r.name, group: r.group, unit: r.unit, nonrev: r.nonrev ? 1 : 0 });
        for (const k of ['fes', 'note', 'old', 'archived']) if (k in r) base[k] = r[k] || '';
        // Ціна з картки важить, доки позицію не оприбуткували з ціною.
        if ('price' in r) base.basePrice = +r.price || 0;
        continue;
      }
      const it = ownItem(r);
      items.push(it);
      itemBy.set(it.code, it);
    }
    items.sort((a, b) => a.code.localeCompare(b.code, 'uk', { numeric: true }));
  }

  /** Наступний вільний код: служба нумерує позиції підряд, тож новий — на
   *  одиницю більший за найбільший числовий код довідника. */
  function nextCode(book = 'ТЗ') {
    const nums = items.filter((i) => bookOfItem(i) === book).map((i) => +i.code).filter((n) => Number.isFinite(n) && n < 1e6);
    return String((nums.length ? Math.max(...nums) : book === 'ОП' ? 6000 : 10000) + 1);
  }

  const normName = (x) => String(x || '').toLowerCase().replace(/[\s"'«»,.]+/g, '');

  /** Де вже вжито код позиції: документи, знищене, звірки, норми, чернетки.
   *  Позицію, на яку щось посилається, не можна ні видалити, ні перекодувати —
   *  інакше ці записи вказуватимуть у порожнечу. */
  function itemUses(code) {
    const c = String(code);
    const out = [];
    const n = docs.filter((r) => r.code === c).length;
    if (n) out.push(cnt(n, 'рядок документів', 'рядки документів', 'рядків документів'));
    if ((store.destroyed || []).some((r) => r.code === c)) out.push('записи про знищення');
    if ((store.recon || []).some((r) => r.lines.some((l) => l.code === c))) out.push('відомості звірки');
    if (normsInit().some((n) => n.code === c)) out.push('норми');
    const inDrafts = [state.draft, ...Object.values(state.drafts || {})]
      .some((dr) => dr && dr.lines.some((l) => l.code === c));
    if (inDrafts) out.push('незавершена чернетка документа');
    return out;
  }

  function itemForm() {
    if (!state.newItem) return '';
    const d = state.newItem;
    const editing = !!d.editCode;
    const lockCode = editing && (d.base || itemUses(d.editCode).length > 0);
    // Позиція несе одну ціну — її й правлять тут; кілька цін мають лише коди,
    // оприбутковані до правила «інша ціна — інший код».
    const prices = editing ? codePrices(d.editCode) : [];
    const units = [...new Set(items.map((i) => i.unit).filter(Boolean))].sort();
    const op = (BOOK_OF_GROUP.get(d.group) || 'ТЗ') === 'ОП';
    return `<form class="card form" id="item-form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">${editing ? `Виправлення позиції ${esc(d.editCode)}`
        : d.like ? `Нова позиція за зразком ${esc(d.like)}` : 'Нова позиція номенклатури'}</div></div>
      <div class="form__grid">
        <div class="field"><label>Код <span class="req">*</span></label>
          <input name="code" value="${esc(d.code)}" required autocomplete="off"${lockCode
            ? ` readonly title="${d.base ? 'Код із паперів служби не змінюється' : 'Використаний код не змінюється'}"` : ''}></div>
        <div class="field field--span2"><label>Найменування <span class="req">*</span></label>
          <input name="name" value="${esc(d.name)}" required placeholder="як у накладній постачальника"></div>
        <div class="field"><label>Одиниця виміру <span class="req">*</span></label>
          <input name="unit" value="${esc(d.unit)}" list="units-list" required placeholder="шт">
          <datalist id="units-list">${units.map((u) => `<option value="${esc(u)}">`).join('')}</datalist></div>
        <div class="field field--span2"><label>${op ? 'Група' : 'Розділ 21/Прод'}</label>
          <select name="group">${D.groups.filter(([, , b]) => (b || 'ТЗ') === (op ? 'ОП' : 'ТЗ')).map(([c, l]) =>
            `<option value="${c}"${c === d.group ? ' selected' : ''}>${op ? '' : c + ' · '}${esc(l)}</option>`).join('')}</select></div>
        ${prices.length > 1 ? `<div class="field"><label>Ціна, грн</label>
          <input value="${esc(prices.map(fmtMoney).join('; '))}" disabled title="Оприбутковано за різними цінами"></div>` : `<div class="field"><label>Ціна, грн</label>
          <input name="price" type="number" min="0" step="0.01" value="${esc(+d.price > 0 ? (+d.price).toFixed(2) : '')}"${prices.length
            ? ' required title="Зміниться в усіх документах коду"' : ''}></div>`}
        ${op ? `<div class="field"><label>Дободач</label>
          <input name="perRation" type="number" min="0" step="any" value="${esc(d.perRation ?? '')}"
            title="Скільки добових видач покриває одиниця позиції"></div>` : `<div class="field"><label>Номер у ФЕС</label>
          <input name="fes" value="${esc(d.fes || '')}" inputmode="numeric" autocomplete="off"
            placeholder="інвентарний чи номенклатурний"
            title="Десять цифр із класом 10 чи 11 — необоротний актив, інший номер — запаси"></div>
        <div class="field field--span2"><label><input type="checkbox" name="nonrev"${d.nonrev ? ' checked' : ''}>
          Необоротний актив (субрахунки 10/11)</label>
          <small class="field__hint">${d.fes ? 'вид обліку — за номером ФЕС'
            : 'номера ФЕС немає, звірте з бухгалтерією'}</small></div>
        <div class="field"><label>Старі коди (облік 3.0)</label>
          <input name="old" value="${esc(d.old || '')}" placeholder="10102, 10103" autocomplete="off"
            title="Коди з книги 3.0, згорнуті в цю позицію: за ними її знайде пошук"></div>`}
        <div class="field field--span2"><label>Примітка</label>
          <input name="note" value="${esc(d.note || '')}" placeholder="паспорт, формуляр, звідки позиція"></div>
        <div class="field"><label><input type="checkbox" name="archived"${d.archived ? ' checked' : ''}>
          В архіві</label>
          <small class="field__hint">у нових приходах не пропонується</small></div>
      </div>
      <div class="card__foot">
        <button class="btn btn--primary" type="submit">${editing ? 'Зберегти зміни' : 'Додати позицію'}</button>
        <button class="btn" type="button" data-act="item-cancel">Скасувати</button>
        <div class="panel__spacer"></div>
        <span class="panel__count" id="item-msg"></span>
      </div>
    </form>`;
  }

  function submitItem(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const g = (k) => (f.get(k) || '').toString().trim();
    const code = g('code'), name = g('name'), unit = g('unit');
    const editing = state.newItem && state.newItem.editCode ? String(state.newItem.editCode) : null;
    const was = editing ? itemBy.get(editing) : null;
    const bad = [];
    if (!code) bad.push('Вкажіть код.');
    else if (code !== editing && itemBy.has(code)) bad.push(`Код ${code} уже зайнятий: «${itemBy.get(code).name}».`);
    if (!name) bad.push('Вкажіть найменування.');
    if (!unit) bad.push('Вкажіть одиницю виміру.');
    const fes = g('fes').replace(/\s+/g, '');
    if (fes && !/^\d+$/.test(fes)) bad.push('Номер ФЕС — лише цифри.');
    if (editing && code !== editing && itemUses(editing).length) {
      bad.push(`Код ${editing} змінити не можна: його вжито (${itemUses(editing).join(', ')}).`);
    }
    // Ціна позиції — ціна її приходів: виправлена тут, вона міняється в усіх
    // документах коду. Код із кількома цінами ціну тут не править.
    const prices = editing ? codePrices(editing) : [];
    const price = Math.round((+g('price') || 0) * 100) / 100;
    const fix = prices.length === 1 && Math.abs(price - prices[0]) >= 0.005 ? { was: prices[0], now: price } : null;
    if (fix && !(price > 0)) bad.push('Вкажіть ціну: позицію оприбутковано з ціною.');
    if (bad.length) {
      const m = $('#item-msg');
      if (m) { m.innerHTML = bad.map(esc).join('<br>'); m.style.color = 'var(--bad)'; }
      return;
    }
    // Та сама назва буває законно (п'ять причепів ЦВ-1,2 — п'ять карток): не
    // забороняємо, лише перепитуємо.
    const like = state.newItem && !editing ? state.newItem.like : null;
    const likeIt = like ? itemBy.get(String(like)) : null;
    if (name && !(was && normName(was.name) === normName(name))
      && !(likeIt && normName(likeIt.name) === normName(name))) {
      const same = items.find((i) => i.code !== editing && normName(i.name) === normName(name));
      if (same && !confirm(`Позиція з такою назвою вже є: ${same.code} «${same.name}».\n\n`
        + 'Завести ще одну картку з тією самою назвою?')) return;
    }
    // Одиниця виміру — у кожному документі позиції й у журналі 47: зміна
    // переписує й минулі папери, тож лише за згодою.
    const used = editing ? docs.filter((r) => r.code === editing).length : 0;
    if (was && unit !== was.unit && used && !confirm(`Одиниця виміру «${was.unit}» → «${unit}» зміниться в усіх `
      + `${cnt(used, 'рядку документів', 'рядках документів', 'рядках документів')} і в журналі № 47. Змінити?`)) return;
    let lock = '';
    if (fix) {
      const hit = docs.filter((r) => r.code === editing && Math.abs((+r.price || 0) - fix.was) < 0.005);
      if (!confirm(`Ціна коду ${editing} зміниться з ${fmtMoney(fix.was)} на ${fmtMoney(fix.now)} грн `
        + `у ${cnt(docCount(hit), 'документі', 'документах', 'документах')}. Змінити?`)) return;
      // Підписана звірка чи завершена інвентаризація рахували суми за старою ціною.
      lock = periodLock(hit.map((r) => r.d), hit.flatMap((r) => [r.from, r.kind === 'wr' ? '' : r.to]));
      if (lock && !histOn() && !confirm(lock.replace(/^Документ від \S+ потрапляє/, 'Зміна ціни потрапляє')
        .replace(/\n\nДля внесення старих документів[^\n]*/, '').replace('Провести все одно?', 'Змінити все одно?'))) return;
    }
    store.items = store.items || [];
    const base = state.newItem && state.newItem.base ? was : null;
    // Щойно вписаний номер ФЕС вирішує вид обліку: десять цифр із класом 10 чи 11 —
    // необоротний актив, інший номер — запаси (як правило бази asset_class.sql).
    // Номер той самий — вид обліку лишається таким, як позначила людина.
    const byFes = fes && fes !== String((was && was.fes) || '') ? fes.length === 10 && /^1[01]/.test(fes) : null;
    const fields = { code, name, unit, group: g('group'),
                     price: prices.length > 1 ? +(was.basePrice ?? was.price) || 0 : price,
                     nonrev: byFes ?? f.get('nonrev') === 'on',
                     fes, note: g('note'), old: g('old'),
                     archived: f.get('archived') === 'on' ? (was && was.archived) || today() : '' };
    if (f.has('perRation')) fields.perRation = g('perRation') === '' ? null : +g('perRation');
    if (editing) {
      const rec = store.items.find((x) => String(x.code) === editing);
      if (rec) Object.assign(rec, fields);
      else store.items.push(fields);                    // правка позиції з паперів служби
      const cls = was && !!was.nonrev !== fields.nonrev ? ` — тепер ${ASSET[fields.nonrev ? 'na' : 'stock'][1]}` : '';
      // Виправили саму лише ціну — у журналі змін один запис, про ціну.
      const onlyPrice = fix && was && ['name', 'unit', 'group', 'fes', 'note', 'old'].every((k) =>
        String(was[k] || '') === String(fields[k] || '')) && !!was.nonrev === !!fields.nonrev
        && !!was.archived === !!fields.archived;
      if (!onlyPrice) logChange('позицію виправлено', 'item|' + code, `${code} «${name}», ${unit}${base || fix || !fields.price ? '' : ', ' + fmtMoney(fields.price) + ' грн'}${cls}`);
      state.newItem = null;
      if (fix) {
        const hit = repriceRows(editing, fix.was, fix.now);
        logChange('ціну виправлено', 'item|' + code, `${code} «${name}»: ${fmtMoney(fix.was)} → ${fmtMoney(fix.now)} грн, `
          + cnt(hit.length, 'документ', 'документи', 'документів') + (lock ? ' — у закритому періоді' : ''));
        mergeOwnItems();
        save(true, true);
        refresh();
      } else {
        mergeOwnItems();
        applyPrices();
        save();
      }
      toast(fix ? `Ціну коду ${code} виправлено: ${fmtMoney(fix.now)} грн.` : `Позицію ${code} «${name}» виправлено.`);
      go('item', { itemCode: code });
      return;
    }
    store.items.push(fields);
    logChange('позицію заведено', 'item|' + code, `${code} «${name}», ${unit}${fields.price ? ', ' + fmtMoney(fields.price) + ' грн' : ''}`
      + (like ? `, як ${like}` : ''));
    mergeOwnItems();
    applyPrices();
    if (like) followLines(code, String(like));
    save();
    const back = state.newItem ? state.newItem.forLine : null;
    state.newItem = null;
    state.flash = null;
    toast(`Позицію ${code} «${name}» додано.`);
    if (back != null && state.draft && state.draft.lines[back]) {
      // Позицію заводили з накладної — ставимо її в той рядок і повертаємось.
      const dr = state.draft;
      dr.lines[back].code = code;
      if (like) dr.lines[back].unit = '';               // одиниця із заводським номером лишається в зразка
      if (back === dr.lines.length - 1) dr.lines.push(emptyLine());
      go('moves');
      const q = $(`#doc-form [data-ln="qty"][data-i="${back}"]`);
      if (q) { q.focus(); q.select(); }
      return;
    }
    render();
  }

  // ------------------------------------------------ записи про знищення
  /** Рядок рапорту про знищення: у рапорту свій життєвий цикл — рапорт, потім
   *  акт. Останній рядок забирає з бази й сам рапорт. */
  function deleteDestroyed(id) {
    const i = store.destroyed.findIndex((r) => r.id === id);
    if (i < 0) return;
    const r = store.destroyed[i];
    const it = itemBy.get(r.code);
    if (!confirm(`Видалити запис про знищення?

${r.other ? r.name : it ? it.name : r.code} — ${fmtNum(r.qty)}, `
      + `${r.sub}, ${fmtDate(r.date)}${r.report ? ', рапорт ' + numNo(r.report) : ''}`)) return;
    // Знищене, не списане, входить у «фактично» звірки й інвентаризації.
    const lock = periodLock([r.date], [r.sub]);
    if (lock && !histOn() && !confirm(lock.replace('Документ від', 'Рапорт від')
      .replace('Провести все одно?', 'Видалити все одно?'))) return;
    store.destroyed.splice(i, 1);
    logChange('знищення видалено', `dz|${r.date}|${r.report || ''}`,
      `${r.other ? r.name : it ? cleanName(it.name) : r.code} — ${fmtNum(r.qty)}, ${r.sub}, ${fmtDate(r.date)}${r.report ? ', рапорт ' + numNo(r.report) : ''}`
      + (lock ? ' — у закритому періоді' : ''));
    save(true, true);
    refresh();
    state.flash = 'Запис про знищення видалено.';
    render();
  }

  /** Ключ рапорту для файлів: за документом бази, а поки рапорт ще не
   *  записано — за підрозділом, номером і датою події. */
  const reportKey = (r) => (r.docId ? `dz|${r.docId}` : `dz|${r.sub}|${r.report || ''}|${r.date}`);
  function reportFilesBtn(r) {
    const key = reportKey(r);
    const n = filesOf(key).length;
    return (n ? `<button type="button" class="ico-btn" data-vw="0" data-vw-key="${esc(key)}" title="Відкрити скан рапорту">📎 скан${n > 1 ? ' · ' + n : ''}</button>` : '')
      + (native ? rowBtn('file-add', '+ скан', `data-key="${esc(key)}"`, { title: 'Підшити скан рапорту' }) : '');
  }

  /** Рапорт у форму: усі його рядки — за документом бази, а поки рапорт ще не
   *  записано — за номером, підрозділом і датою події. Проведення замінює рядки. */
  function editReport(id) {
    const r = allDestroyed().find((x) => x.id === id);
    if (!r || !leaveEditing()) return;
    const mine = (x) => (r.docId ? x.docId === r.docId
      : !x.docId && x.sub === r.sub && x.date === r.date && normNo(x.report) === normNo(r.report));
    // Частина запису, уже списана актом, — та сама одиниця запису.
    const recs = [];
    for (const x of allDestroyed()) {
      if (!mine(x)) continue;
      const id0 = String(x.id).replace(/~w$/, '');
      const had = recs.find((y) => String(y.id).replace(/~w$/, '') === id0);
      if (had) had.qty = round3(+had.qty + (+x.qty || 0)); else recs.push(Object.assign({}, x, { qty: x.part ? x.whole : x.qty }));
    }
    const acts = [...new Set(recs.map((x) => x.act).filter(Boolean))];
    const act0 = acts.length === 1 ? acts[0] : '';
    // Підстава й обставини — спільні для всього рапорту; у записів старих версій
    // є лише примітка рядка, і вона лишається в рядку.
    const own = recs.every((x) => x.circ != null);
    const circ = own ? String(recs[0].circ || '') : '';
    const basis = circ.startsWith('підстава: ') ? circ.split('; ')[0].slice(10) : '';
    stashDraft();
    state.moveKind = 'dz';
    state.editing = null;
    state.editingReport = { docId: r.docId || 0, origin: r.origin || 'program', no: r.report || '', act0,
      ids: recs.map((x) => String(x.id).replace(/~w$/, '')), old: recs.map((x) => Object.assign({}, x)) };
    state.draft = { kind: 'dz',
      head: { type: 'Рапорт', no: r.report || '', date: r.date, from: r.sub, to: '', basis,
              note: basis ? circ.split('; ').slice(1).join('; ') : circ,
              report: '', reportDate: r.reportDate || '', act: act0 },
      lines: recs.map((x) => (x.other
        ? { other: true, oid: String(x.id), name: x.name || '', qty: String(x.qty), uom: x.uom || '',
            price: x.price != null ? String(x.price) : '', note: own ? x.lnote || '' : x.note || '',
            offNo: x.offNo || '', offDate: x.offDate || '' }
        : { code: x.code, qty: String(x.qty), price: x.price != null ? String(x.price) : '',
            note: own ? x.lnote || '' : x.note || '', lot: '', unit: x.unit ? String(x.unit) : '' })).concat([emptyLine()]) };
    go('moves', { q: '', formOpen: true });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
  }

  /** Замінити рядки рапорту новою редакцією. Рядок, що лишився тією самою
   *  позицією (й одиницею), — той самий рядок бази: до нього прив'язані номер
   *  акта й скани. Номер акта в шапці змінили — він для всіх рядків (порожній
   *  знімає акт); не чіпали — у кожного рядка лишається свій. */
  function replaceReport(rep, h, lines) {
    const old = store.destroyed.filter((x) => rep.ids.includes(String(x.id)));
    const at = store.destroyed.indexOf(old[0]);
    const circ = reportCirc(h);
    const actSet = normNo(h.act) !== normNo(rep.act0);
    const used = new Set();
    const fresh = lines.map((ln) => {
      // Рядок іншого майна — свій за id запису, інакше за назвою.
      const was = old.find((o) => !used.has(o) && (ln.other
        ? o.other && (ln.oid ? String(o.id) === String(ln.oid) : o.name === String(ln.name || '').trim())
        : !o.other && o.code === ln.code && String(o.unit || '') === String(ln.unit || '')));
      if (was) used.add(was);
      const act = ln.other ? '' : (actSet || !was ? h.act : was.act) || '';
      return Object.assign(dzRecord(h, ln, was ? was.id : uid(), rep.origin || 'program'),
        ln.other ? {} : { act },
        rep.docId ? { docId: rep.docId } : {},
        was && was.lineId ? { lineId: was.lineId } : {},
        was && was.otherId ? { otherId: was.otherId } : {},
        was && !ln.other && was.actId && normNo(act) === normNo(was.act) ? { actId: was.actId } : {});
    });
    store.destroyed = store.destroyed.filter((x) => !rep.ids.includes(String(x.id)));
    store.destroyed.splice(at < 0 ? store.destroyed.length : at, 0, ...fresh);
    logChange('рапорт виправлено', `dz|${h.date}|${h.no}`, `${numNo(rep.no)} → ${numNo(h.no)} від ${fmtDate(h.date)}, «${h.from}»: `
      + lines.map((ln) => `${ln.other ? ln.name : cleanName((itemBy.get(ln.code) || {}).name || ln.code)} — ${fmtNum(+ln.qty)}`).join('; '));
    dzCache = null;
  }

  /** «Списати актом…» — одна дія замість двох («включити до акта», потім «провести
   *  акт»): питає номер акта, записує його на запис (і на решту рядків рапорту, за
   *  згодою), а далі одразу відкриває чернетку акта списання — лишається перевірити
   *  й провести. Проміжний стан «акт не проведений» лишається технічним: він
   *  видно, коли чернетку закрили, не провівши. Консиліум 01.10.2026, п'ятеро з п'яти. */
  function actDestroyed(id) {
    const r = allDestroyed().find((x) => x.id === id);
    if (!r) return;
    // Номер — з журналу актів служби; підказка — наступний після останнього проведеного акта.
    const lastAct = docs.filter((x) => x.kind === 'wr' && /\d/.test(String(x.no))).sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))[0];
    const no = prompt('Номер акта списання, яким списується це майно (з журналу актів служби).\n\n'
      + 'Далі відкриється чернетка акта — перевірити й провести.', r.act || (lastAct ? nextDocNo(lastAct.no) : ''));
    if (no == null) return;
    const act = no.trim();
    if (!act) { alert('Номер акта не вказано. Запис не змінено.'); return; }
    let target = r.id;
    // Частину запису акт уже списав, а решта йде до іншого акта: запис ділиться —
    // списане лишається за першим актом, решта стає окремим записом.
    if (r.part && normNo(act) !== normNo(r.act)) {
      const own = store.destroyed.find((y) => y.id === r.id);
      if (!own) return;
      // Решта — окремим рядком того самого рапорту, зі своїм актом.
      const copy = Object.assign({}, own, { id: uid(), qty: r.qty, act });
      delete copy.lineId;
      delete copy.actId;
      store.destroyed.push(copy);
      own.qty = round3((+own.qty || 0) - r.qty);
      target = copy.id;
    } else {
      // Акт із цим номером уже проведено, але для іншого підрозділу чи раніше за
      // подію: цього запису він не закриє, запис чекатиме свого акта.
      const fits = docs.some((x) => x.kind === 'wr' && normNo(x.no) === normNo(act) && x.from === r.sub && x.d >= r.date);
      const other = fits ? null : docs.find((x) => x.kind === 'wr' && normNo(x.no) === normNo(act));
      if (other && !confirm(`Акт ${numNo(act)} уже проведено: «${other.from}», ${fmtDate(other.d)}. Цього запису `
        + `(«${r.sub}», подія ${fmtDate(r.date)}) він не закриє: буде складено новий акт ${numNo(act)} від «${r.sub}».\n\nПродовжити?`)) return;
      // Рапорт іде до акта цілком, як у папері: решту його рядків, ще не включених
      // до акта, включаємо разом — інакше кожен рядок вимагав окремого вікна.
      const rest = allDestroyed().filter((x) => x.id !== r.id && x.status !== 'списано' && !x.act
        && x.sub === r.sub && x.date === r.date && normNo(x.report) === normNo(r.report));
      const all = rest.length && confirm(`Списати тим самим актом ${numNo(act)} і решту рапорту ${numNo(r.report)}: `
        + `${cnt(rest.length, 'рядок', 'рядки', 'рядків')}?`);
      for (const x of [r].concat(all ? rest : [])) {
        const own = store.destroyed.find((y) => y.id === x.id);
        if (!own) continue;
        if (normNo(own.act) !== normNo(act)) { delete own.actId; delete own.actSub; }
        own.act = act;
      }
    }
    dzCache = null;
    save();
    recalc();
    // Проведений акт із цим номером уже закрив запис — чернетка не потрібна.
    const base = String(target).replace(/~w$/, '');
    const left = allDestroyed().filter((x) => String(x.id).replace(/~w$/, '') === base && x.status !== 'списано');
    if (!left.length) {
      const done = allDestroyed().find((x) => String(x.id).replace(/~w$/, '') === base);
      state.flash = `Запис закрито актом ${numNo(act)}${done && done.actDate ? ` від ${fmtDate(done.actDate)}` : ''}: майно вже списане.`;
      render();
      return;
    }
    writeoffFromAct(left[0].id);
  }

  /** Виправили номер акта списання — записи про знищення, закриті ним, ідуть за
   *  ним. Зв'язок тримається на номері, і без цього знищене поверталося в «не
   *  списане»: акт уже зменшив залишок, а знищене віднімалося від нього вдруге.
   *  Лише записи цього акта: тезка з тим самим номером (торішній акт того
   *  самого підрозділу) своїх записів не віддає. */
  function relinkActs(list, newNo) {
    for (const x of list) {
      if (normNo(x.act) === normNo(newNo)) continue;
      const own = store.destroyed.find((y) => y.id === String(x.id).replace(/~w$/, ''));
      if (own) own.act = newNo;
    }
    dzCache = null;
  }

  /** Де майно запису числиться зараз: сам підрозділ запису, а коли той закритий або
   *  позиції там уже немає (передали накладною разом зі знищеним — так термоси
   *  2 б БпС опинилися не там, де їх знищили, 01.10.2026) — чинний підрозділ із цією
   *  позицією: спершу з того самого батальйону, далі з найбільшим залишком.
   *  Повертає { sub, why }, де why — чому не підрозділ запису (порожньо — свій). */
  function holderOf(code, sub, qty, unit = '') {
    const date = today();
    const sb = subBy.get(sub);
    // Одиниця із заводським номером числиться там, куди її востаннє передали.
    if (unit) {
      const at = unitHolderAt(unit, date, null);
      return at && at !== sub ? { sub: at, why: `одиниця на ${fmtDate(date)} числиться за «${at}»` } : { sub, why: '' };
    }
    const have = (s) => availableAt(code, s, date);
    if (sb && sb.active && have(sub) >= qty - 1e-9) return { sub, why: '' };
    const parent = sb ? sb.parent : '';
    const cands = subs.filter((s) => s.active && s.type !== 'бригада' && s.name !== sub && have(s.name) >= qty - 1e-9)
      .sort((a, b) => ((b.parent === parent) - (a.parent === parent)) || (have(b.name) - have(a.name)));
    const why = sb && !sb.active ? 'підрозділ закрито' : `на ${fmtDate(date)} цієї позиції там уже не числиться`;
    // Ніде не числиться стільки — акт лишається від підрозділу запису, але людина має це бачити.
    if (!cands.length) return { sub, why: `${why}, а в інших підрозділах такої кількості теж немає` };
    return { sub: cands[0].name, why };
  }

  /** Акт списання із записів про знищення: номер акта, підрозділ і позиції з
   *  кількостями переносяться в чернетку — лишається перевірити дату й провести.
   *  Чернетка пам'ятає, звідки вона (src): форма показує рядок-джерело, а після
   *  проведення записи йдуть за актом. Щойно акт проведено, записи самі стають
   *  «списано». */
  function writeoffFromAct(id) {
    const r = allDestroyed().find((x) => x.id === id);
    if (!r || !r.act) return;
    const same = allDestroyed().filter((x) => x.status !== 'списано'
      && normNo(x.act) === normNo(r.act) && x.sub === r.sub);
    // Рядок акта — позиція, а знищена кухня з номером — своїм рядком: акт
    // списує саме її, зі своєю партією.
    const byCode = new Map();
    for (const x of same) {
      const key = x.code + '|' + (x.unit || '');
      const had = byCode.get(key) || { code: x.code, unit: String(x.unit || ''), qty: 0 };
      had.qty = round3(had.qty + (+x.qty || 0));
      byCode.set(key, had);
    }
    const reports = [...new Set(same.map((x) => x.report).filter(Boolean))];
    const total = round3([...byCode.values()].reduce((a, x) => a + x.qty, 0));
    // Від кого акт: від підрозділу запису, а якщо майна там уже немає — від того, де воно є.
    const mine = byCode.get(r.code + '|' + (r.unit || '')) || { qty: +r.qty || 0 };
    const holder = holderOf(r.code, r.sub, mine.qty, r.unit ? String(r.unit) : '');
    if (!leaveEditing()) return;
    stashDraft();
    state.moveKind = 'wr';
    state.editing = null;
    state.draft = {
      kind: 'wr',
      head: {
        no: r.act, date: today(), from: holder.sub, to: '',
        basis: reports.length ? (reports.length > 1 ? 'рапорти №' : 'рапорт №') + reports.join(', №') : '',
        report: '', reportDate: '', act: '', note: '',
      },
      lines: [...byCode.values()].map(({ code, unit, qty }) => {
        const ln = { code, qty: String(qty), price: '', note: '', lot: '', unit: '' };
        const came = unit ? unitArrival(unit, today(), null) : null;
        if (came) Object.assign(ln, { unit, qty: '1', lot: came.lot || came.d, price: String(+came.price || 0) });
        return ln;
      }).concat([emptyLine()]),
      src: { kind: 'dz', ids: [...new Set(same.map((x) => String(x.id).replace(/~w$/, '')))],
        report: r.report || '', reportDate: r.reportDate || '', date: r.date, sub: r.sub, qty: total, n: same.length,
        moved: holder.why ? { was: r.sub, to: holder.sub, why: holder.why, stayed: holder.sub === r.sub } : null },
    };
    go('moves', { q: '', formOpen: true });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
  }

  /** Акт проведено з чернетки «Списати актом…»: записи «Знищене майно» ідуть за ним
   *  так, як його провели, — з номером із форми й від підрозділу, від якого він
   *  складений (той буває не підрозділом запису: майно вже передали). */
  function linkDraftRecords(src, h) {
    const ids = new Set((src.ids || []).map(String));
    for (const own of store.destroyed || []) {
      if (!ids.has(String(own.id)) || own.other) continue;
      if (normNo(own.act) !== normNo(h.no)) delete own.actId;
      own.act = h.no;
      if (h.from && h.from !== own.sub) own.actSub = h.from; else delete own.actSub;
    }
    dzCache = null;
  }

  /** Після такого акта: чи все списано — і кнопка назад до записів. */
  function dzFlash(src, said) {
    const ids = new Set((src.ids || []).map(String));
    const left = allDestroyed().filter((x) => ids.has(String(x.id).replace(/~w$/, '')) && x.status !== 'списано');
    const text = left.length
      ? `${said} Знищене за рапортом ${numNo(src.report || '—')} списано не все: ${fmtNum(left.reduce((a, x) => a + (+x.qty || 0), 0))} од. ще чекає акта.`
      : `${said} Знищене за рапортом ${numNo(src.report || '—')} списано: ${cnt(src.n, 'запис', 'записи', 'записів')}.`;
    return { text, btn: { label: 'До знищеного майна', act: 'dz-open', v: src.report || '' } };
  }

  /** Перевіряє чернетку й повертає перелік зауважень. Порожній — можна проводити.
   *
   *  Перевіряється те, що справді псує облік: документ без номера й дати, видача
   *  того, чого в підрозділі немає, маршрут «сам собі», повтор номера, два рядки
   *  на одне й те саме найменування. Решту хай вирішує людина.
   */
  function checkDraft(d, h, k) {
    const bad = [];
    const warn = [];
    d.warn = warn;
    // Батальйон майна не тримає — воно за його підрозділами (їдальня, ВМТЗ).
    for (const side of [h.from, h.to]) {
      if (side && subBy.get(side) && subs.some((x) => x.parent === side && / · їдальня$/i.test(x.name))) {
        warn.push(`Майно батальйону «${side}» числиться за його підрозділами (їдальня, ВМТЗ). `
          + 'Оберіть підрозділ або пізніше перенесіть майно з картки батальйону.');
      }
    }
    const no = h.no.trim();
    // Номер і сторони — частина ключа документа: із «|» у номері програма
    // більше не знаходила б його ні для виправлення, ні для видалення.
    if (no.includes('|')) bad.push('У номері документа не ставте «|» — за ним програма знаходить документ.');
    if (!no) bad.push(k === 'dz' ? 'Вкажіть номер рапорту.' : 'Вкажіть номер документа.');
    // Той самий вид, дата й номер — це той самий документ: такий блокуємо. Той
    // самий номер в іншому виді чи іншої дати буває законно (номер накладної
    // постачальника збігся з нашим актом) — про нього лише попереджаємо.
    else if (k !== 'dz') {
      const same = docs.filter((r) => normNo(r.no) === normNo(no) && keyOfRow(r) !== state.editing);
      const sameRoute = (r) => r.from === h.from && (k === 'wr' ? (r.to || '') === (h.to || '') : r.to === h.to);
      if (same.some((r) => r.kind === k && r.d === h.date && sameRoute(r))) {
        bad.push(`Документ «${kindName({ kind: k, to: k === 'wr' ? h.to : '' })}» ${numNo(no)} від ${fmtDate(h.date)} на цей маршрут уже є в обліку. Виправте номер або дату.`);
      } else if (same.some((r) => r.kind === k && r.d === h.date)) {
        const r0 = same.find((r) => r.kind === k && r.d === h.date);
        warn.push(`${numNo(no)} від ${fmtDate(h.date)} уже є на інший маршрут (${r0.from}${r0.to ? ' → ' + r0.to : ''}). Документи лишаться окремими.`);
      } else if (same.length) {
        const r0 = same[0];
        warn.push(`${numNo(no)} уже є в обліку: ${kindName(r0).toLowerCase()} від ${fmtDate(r0.d)}.`);
      }
    } else {
      const twice = allDestroyed().filter((x) => normNo(x.report) === normNo(no) && x.sub === h.from
        && !inEditedReport(x) && d.lines.some((l) => l.code && l.code === x.code));
      if (twice.length) warn.push(`Рапорт ${numNo(no)} по «${h.from}» на ці позиції вже внесено. Перевірте, чи це не повтор.`);
    }
    if (!h.date) bad.push('Вкажіть дату документа.');
    else if (h.date > today()) bad.push('Дата документа в майбутньому.');
    else if (firstDay() && h.date < firstDay()) {
      bad.push(`Дата раніша за початок обліку (${fmtDate(firstDay())}). Початок обліку — у реквізитах частини.`);
    }
    if (k === 'in' && !h.from.trim()) bad.push('Вкажіть, від кого надійшло майно.');
    if (k === 'in' && h.from.includes('|')) bad.push('У назві постачальника не ставте «|».');
    if (k === 'wr' && (h.to || '').includes('|')) bad.push('У назві одержувача не ставте «|».');
    if (k === 'wr' && h.to && subBy.get(h.to)) {
      bad.push(`«${h.to}» — підрозділ частини: майно між підрозділами передають накладною (переміщенням).`);
    }
    if (k !== 'in' && !h.from) bad.push('Вкажіть підрозділ-відправника.');
    if (k === 'mv') {
      if (!h.to) bad.push('Вкажіть одержувача.');
      else if (h.from === h.to) bad.push('Відправник і одержувач збігаються.');
    }

    const filled = d.lines.filter((x) => (x.other ? String(x.name || '').trim() : x.code) && +x.qty > 0);
    if (!filled.length) bad.push('Додайте хоча б одне найменування з кількістю.');
    const nameOf = (code) => { const it = itemBy.get(code); return it ? it.name : code; };
    const at = (ln) => {
      const u = ln.unit ? unitBy.get(String(ln.unit)) : null;
      return u ? `, ${unitLabel(u)},` : (byLot(k) && ln.lot ? ` за ${fmtMoney(+ln.price || 0)} грн` : '');
    };
    const seen = new Set(), seenUnits = new Set(), perCode = new Map(), perLot = new Map();
    for (const ln of filled) {
      if (ln.other) continue;
      // Повтор — це та сама позиція за тією самою ціною, тією самою одиницею й
      // приміткою; за іншою ціною чи з іншою одиницею це окремий рядок паперу.
      const key = JSON.stringify([ln.code, linePrice(ln, k).toFixed(2), String(ln.unit || ''),
                                  String(ln.note || '').trim()]);
      // У рапорті та сама позиція буває двома рядками паперу (різні обставини):
      // лише попереджаємо, а в документах руху це повтор, який треба об'єднати.
      if (seen.has(key)) {
        if (k === 'dz') warn.push(`«${nameOf(ln.code)}»${at(ln)} указано двічі.`);
        else bad.push(`«${nameOf(ln.code)}»${at(ln)} указано двічі. Об’єднайте в один рядок.`);
      }
      seen.add(key);
      perCode.set(ln.code, (perCode.get(ln.code) || []).concat([ln]));
      // Прихід одиниці з реєстру: одна штука, один рядок і не та, що вже десь числиться.
      if (ln.unit && k === 'in') {
        const u = unitBy.get(String(ln.unit));
        if (seenUnits.has(String(ln.unit))) bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: одна одиниця — один рядок.`);
        seenUnits.add(String(ln.unit));
        if (round3(+ln.qty) !== 1) {
          bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: одиниця із заводським номером — одна, а в рядку ${fmtNum(ln.qty)}.`);
        }
        const held = unitHolderAt(ln.unit, h.date);
        if (held) {
          bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: на ${fmtDate(h.date)} уже числиться в «${held}». `
            + 'Одну одиницю двічі не оприбутковують.');
        }
        continue;
      }
      if (ln.unit && byUnit(k)) {
        const u = unitBy.get(String(ln.unit));
        if (seenUnits.has(String(ln.unit))) {
          bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: одна одиниця — один рядок.`);
        }
        seenUnits.add(String(ln.unit));
        if (round3(+ln.qty) !== 1) {
          bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: одиниця із заводським номером — одна, `
            + `а в рядку ${fmtNum(ln.qty)}.`);
        }
        const where = unitHolderAt(ln.unit, h.date);
        if (where !== h.from) {
          bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: на ${fmtDate(h.date)} `
            + (where ? `числиться в «${where}»` : 'ніде не числиться') + `, а не в «${h.from}».`);
        } else if (k === 'dz' && destroyedUnitsAt(h.from, h.date).has(String(ln.unit))) {
          bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: уже внесена в рапорт про знищення.`);
        }
        continue;
      }
      if (!byLot(k)) continue;
      if (ln.lot) {
        const lk = ln.code + '|' + (+ln.price || 0).toFixed(2);
        perLot.set(lk, (perLot.get(lk) || []).concat([ln]));
      }
    }
    // Рядки однієї партії разом — не більше, ніж у ній лишилося. Коли перевищено
    // й позицію загалом, лишається лише повідомлення про позицію: воно каже, де
    // майно числиться, а два повідомлення про одне й те саме лише плутали.
    const lotBad = new Map();
    for (const mine of perLot.values()) {
      const have = lineHave(mine[0], h.from, h.date);
      const qty = round3(mine.reduce((a, x) => a + (+x.qty || 0), 0));
      if (qty > have + 1e-9) {
        lotBad.set(mine[0].code, (lotBad.get(mine[0].code) || []).concat([
          `«${nameOf(mine[0].code)}»${at(mine[0])}: у «${h.from}» на ${fmtDate(h.date)} такої партії `
          + `${fmtNum(have, '0')}, а в документі ${fmtNum(qty)}.`]));
      }
    }
    // Усі рядки позиції разом (з різних партій теж) — не більше, ніж числиться;
    // одиниці із заводськими номерами рахуються своїми рядками окремо.
    for (const [code, mine] of perCode) {
      if (k === 'in') continue;
      const qty = round3(mine.filter((x) => !x.unit).reduce((a, x) => a + (+x.qty || 0), 0));
      if (!qty) continue;
      const units = byUnit(k) ? unitsAt(code, h.from, h.date).length : 0;
      const have = lineHave({ code, lot: '', unit: '' }, h.from, h.date);
      // Виправлення рапорту не блокується тим, що вже було в ньому: рапорт із
      // паперу буває більшим за облік (річ числилась в іншому підрозділі).
      const was = k === 'dz' && state.editingReport ? state.editingReport.old
        .filter((o) => o.code === code && !o.unit).reduce((a, o) => a + (+o.qty || 0), 0) : 0;
      if (qty > Math.max(have, round3(was)) + 1e-9) {
        const where = holdersAt(code, h.date, h.from).slice(0, 3);
        lotBad.delete(code);
        bad.push(`«${nameOf(code)}»: у «${h.from}» на ${fmtDate(h.date)} числиться ${fmtNum(have, '0')}`
          + (units ? ` без номерних (${fmtNum(units, '0')} із заводськими номерами — окремими рядками)` : '')
          + `, а в документі ${fmtNum(qty)}.`
          + (where.length ? ` На цю дату числиться: ${where.map(([sub, q]) => `${sub} — ${fmtNum(q)}`).join(', ')}`
            + '. Спершу проведіть переміщення звідти.' : ''));
      }
    }
    for (const msgs of lotBad.values()) bad.push(...msgs);
    // Інша ціна — інший код: прихід несе ціну, з якою код уже в обліку, а код, якого
    // ще не приходували, — одну ціну на весь документ.
    if (k === 'in') {
      for (const [code, mine] of perCode) {
        const asked = [...new Set(mine.map((ln) => linePrice(ln, k)).filter((p) => p > 0).map((p) => p.toFixed(2)))].map(Number);
        const added = newPrices(code, asked, state.editing);
        if (!added.length) continue;
        const have = codePrices(code);
        const text = (list) => list.map((p) => fmtMoney(p)).join('; ');
        if (have.length) {
          bad.push(`Код ${code} оприбутковано за ${text(have)} грн, а в документі ${text(added)} грн. `
            + 'Для іншої ціни заведіть новий код, помилкову виправте в картці позиції.');
        } else {
          bad.push(`Код ${code} у документі за різними цінами: ${text(asked)} грн. Для іншої ціни заведіть новий код.`);
        }
      }
    }
    d.lines.forEach((ln, n) => {
      if (!ln.other && !ln.code && String(ln.qty ?? '').trim() !== '' && +ln.qty > 0) {
        bad.push(`Рядок ${n + 1}: не обрано найменування.`);
      }
    });
    // Інше майно: назва й кількість, ціна — число або порожньо, списання не
    // раніше за подію. Порожній рядок нікому не заважає.
    d.lines.forEach((ln, n) => {
      if (!ln.other) return;
      const name = String(ln.name || '').trim();
      if (!name && String(ln.qty ?? '').trim() === '' && String(ln.price ?? '').trim() === '') return;
      const who = name ? `«${name}»` : `Рядок ${n + 1}`;
      if (!name) bad.push(`Рядок ${n + 1}: вкажіть, що за інше майно.`);
      if (!(+ln.qty > 0)) bad.push(`${who}: не вказано кількість.`);
      if (String(ln.price ?? '').trim() !== '' && !(+ln.price >= 0)) bad.push(`${who}: ціна має бути невід'ємним числом.`);
      if (ln.offDate && h.date && ln.offDate < h.date) {
        bad.push(`${who}: списано ${fmtDate(ln.offDate)} — раніше за подію ${fmtDate(h.date)}.`);
      }
    });
    for (const ln of d.lines) {
      if (k === 'in' && ln.code) {
        if (String(ln.price ?? '').trim() !== '' && !(+ln.price >= 0)) {
          bad.push(`«${nameOf(ln.code)}»: ціна має бути невід'ємним числом.`);
        } else if (!(linePrice(ln, k) > 0)) {
          // Порожня ціна означає облікову ціну довідника; немає й там — питаємо.
          bad.push(`«${nameOf(ln.code)}»: вкажіть ціну — у довіднику її немає.`);
        }
      }
      if (ln.code && !(+ln.qty > 0)) {
        bad.push(`«${nameOf(ln.code)}»: не вказано кількість.`);
      }
      if (k === 'dz' && ln.code && String(ln.price ?? '').trim() !== '' && !(+ln.price >= 0)) {
        bad.push(`«${nameOf(ln.code)}»: ціна за документом має бути невід'ємним числом.`);
      }
    }
    return bad;
  }

  function showFormMsg(text, ok) {
    const m = $('#form-msg');
    if (!m) return;
    m.innerHTML = text;
    m.style.color = ok ? 'var(--ok)' : 'var(--bad)';
  }

  /** Запис у журнал змін: що проведено, а для виправлення — що саме змінилося. */
  function logDoc(k, h, lines, oldRows, editedKey, lock) {
    const nameOf = (code) => { const it = itemBy.get(code); return it ? cleanName(it.name) : code; };
    const key = k === 'dz' ? `dz|${h.date}|${h.no}` : docKey(k, h.date, h.no, h.from, h.to);
    const tail = lock ? ' — у закритому періоді' : '';
    if (!editedKey) {
      logChange(k === 'dz' ? 'рапорт внесено' : 'проведено', key, `${kindName({ kind: k, to: k === 'wr' ? h.to : '' }) || 'Рапорт про знищення'} ${numNo(h.no)}`
        + ` від ${fmtDate(h.date)}: ${lines.map((ln) => `${ln.other ? ln.name : nameOf(ln.code)} — ${fmtNum(+ln.qty)}`).join('; ')}${tail}`);
      return;
    }
    const ch = editChanges(k, h, lines, oldRows);
    const text = `${numNo(h.no)} від ${fmtDate(h.date)}: ${ch.join('; ') || 'змінено примітки чи підставу'}${tail}`;
    logChange('виправлено', key, text);
    if (editedKey !== key) logChange('виправлено', editedKey, `тепер ${text}`);
  }

  function submitDoc(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const g = (key) => (f.get(key) || '').toString().trim();
    const k = state.moveKind;
    const d = draft();
    // Шапка читається з форми, а не зі стану: користувач міг правити поля, не
    // залишаючи жодного з них, і подія `change` для останнього ще не пройшла.
    const h = Object.assign(d.head, {
      type: g('type'), no: g('no'), date: g('date'), from: g('from'), to: g('to'),
      basis: g('basis'), note: g('note'), report: g('report'),
      reportDate: g('reportDate'), act: g('act'),
    });

    const bad = checkDraft(d, h, k);
    if (bad.length) {
      state.postNext = false;
      showFormMsg(bad.map((x) => esc(x)).join('<br>'), false);
      $('#doc-form')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    // Номери в старих паперах повторюються законно (один номер рапорту на
    // кілька маршрутів), тому в режимі історії не перепитуємо — але й не мовчимо:
    // попередження їде в повідомлення про проведений документ.
    const warned = (d.warn || []).slice();
    if (warned.length && !histOn() && !confirm(warned.join('\n') + (k === 'dz' ? '\n\nВнести все одно?' : '\n\nПровести все одно?'))) return;

    // Закритий період: документ заднім числом після підписаної звірки чи
    // завершеної інвентаризації — лише з явної згоди. Для виправлення важить і
    // стара дата, і стара пара підрозділів.
    const lockDates = [h.date], lockSubs = [h.from, h.to];
    const oldRows = [];
    if (state.editing) {
      const o = storeRowsOf(state.editing);
      lockDates.push(o.d);
      for (const i of o.idx) { oldRows.push(o.arr[i]); lockSubs.push(o.arr[i][3], o.kind === 'wr' ? '' : o.arr[i][4]); }  // одержувач вибуття — не підрозділ
    }
    // Рапорт про знищення теж: знищене, не списане, міняє «фактично» у звірці й
    // інвентаризації на цю дату.
    const lock = periodLock(lockDates, lockSubs);
    if (lock && !histOn() && !confirm(k === 'dz' ? lock.replace('Документ від', 'Рапорт від')
      .replace('Провести все одно?', 'Внести все одно?') : lock)) return;

    const lines = d.lines.filter((x) => (x.other ? String(x.name || '').trim() : x.code) && +x.qty > 0);
    if (state.editing && state.editing.split('|')[0] !== k) {
      showFormMsg(esc('Вид документа не збігається з тим, що виправляється. Скасуйте виправлення й почніть знову.'), false);
      return;
    }
    // Знімок стрічки до змін: після проведення порівнюємо, чи не з'явився мінус.
    const saved = { incoming: store.docs.incoming.slice(), movement: store.docs.movement.slice(),
                    writeoffs: store.docs.writeoffs.slice() };
    let backup = null;
    let touched = lines.filter((x) => !x.other).map((x) => x.code);
    // Одиниці із заводськими номерами, яких торкається документ: і ті, що в новій
    // редакції, і ті, що були в старій, — ланцюжок кожної має лишитися цілим.
    const unitIds = new Set(lines.filter((x) => x.unit).map((x) => String(x.unit)));
    if (state.editing) {
      const old = storeRowsOf(state.editing);
      backup = { kind: old.kind, rows: old.arr.slice() };
      touched = touched.concat(old.idx.map((i) => old.arr[i][5]));
      for (const i of old.idx) {
        const u = rowUnit(old.kind, old.arr[i]);
        if (u) unitIds.add(String(u));
      }
    }
    const before = k === 'dz' ? null : negProfile(new Set(touched));
    // Знищене не переміщують: і переміщення з підрозділу, і рапорт заднім числом
    // не мають лишати знищеного більше, ніж там числиться.
    const dzBefore = k === 'mv' || k === 'dz' ? dzProfile(new Set(touched)) : null;
    const savedDz = store.destroyed.slice();
    // Записи про знищення, закриті актом, що виправляється: після зміни номера
    // вони йдуть саме за ним, а не за тезкою з тим самим старим номером.
    const actLinked = k === 'wr' && state.editing ? allDestroyed().filter((x) => !x.actId && x.act
      && actDocsOf(x).some((w) => keyOfRow(w) === state.editing)) : [];
    // Виправлений документ лишається тим самим записом бази: id і походження з
    // його рядків переходять на нові рядки, тож скани, зв'язок із рапортом і
    // партії, з яких видавали пізніше, не рвуться.
    let tail = [];
    if (state.editing) {
      const old = storeRowsOf(state.editing);
      const first = old.arr[old.idx[0]];
      if (first && rowId(old.kind, first)) tail = ['', rowId(old.kind, first), rowOrigin(old.kind, first)];
      store.docs[STORE_OF[old.kind]] = old.arr.filter((_, i) => !old.idx.includes(i));
    }
    const rep = k === 'dz' ? state.editingReport : null;
    if (rep) replaceReport(rep, h, lines);
    else if (k === 'dz') {
      for (const ln of lines) store.destroyed.push(dzRecord(h, ln, uid(), 'program'));
    } else {
      // Ціна з накладної постачальника, названа партія та одиниця із заводським
      // номером ідуть у рядок: без них облік узяв би найдавнішу партію й не знав
      // би, яка саме кухня поїхала.
      for (const row of rowsFromDraft(k, h, lines, tail)) store.docs[STORE_OF[k]].push(row);
    }

    if (before) {
      // Ні нова редакція, ні новий документ заднім числом не мають залишати
      // мінусів ніде далі по стрічці — і не мають рвати ланцюжок одиниці.
      const neg = newNegative(new Set(touched), before);
      const broke = neg ? null : unitBreak(unitIds);
      if (neg || broke) {
        Object.assign(store.docs, saved);
        ledger = buildLedger();
        showFormMsg(esc((backup ? 'Виправлення не проведено: ' : 'Документ не проведено: ')
          + (neg ? negMessage(neg, backup ? 'edit' : 'new') : unitMessage(broke))), false);
        $('#doc-form')?.scrollIntoView({ block: 'nearest' });
        return;
      }
    }
    if (dzBefore) {
      dzCache = null;
      const over = newDzOver(new Set(touched), dzBefore);
      if (over && histOn()) warned.push(dzOverMessage(over));
      else if (over && !confirm(dzOverMessage(over) + (k === 'dz' ? '\n\nВнести все одно?' : '\n\nПровести все одно?'))) {
        Object.assign(store.docs, saved);
        store.destroyed = savedDz;
        ledger = buildLedger();
        dzCache = null;
        return;
      }
    }
    // Акт із чернетки «Списати актом…»: записи «Знищене майно» — за ним, як його провели.
    const src = k === 'wr' && !state.editing && d.src && d.src.kind === 'dz' ? d.src : null;
    if (src) linkDraftRecords(src, h);
    const wasEditing = !!state.editing;
    const editedKey = state.editing;
    state.editing = null;
    // Ціну коду виправили в його приході: накладні й акти, що назвали партію за
    // старою ціною, несуть нову — партія та сама.
    if (k === 'in' && wasEditing) {
      for (const [code, was, now] of priceFixes(oldRows, lines, editedKey)) repriceRows(code, was, now, ['movement', 'writeoffs']);
      // Позицію з надходження прибрали: її бюджетні реквізити не лишаються чекати іншої під тим самим кодом.
      if (tail[1]) mtzForget(tail[1], new Set(lines.map((x) => String(x.code))));
    }
    logDoc(k, h, lines, oldRows, editedKey, lock);
    if (editedKey && k !== 'dz') rekeyScans(editedKey, docKey(k, h.date, h.no, h.from, h.to || ''));
    if (actLinked.length) relinkActs(actLinked, h.no);
    const kinds = cnt(lines.length, 'найменування', 'найменування', 'найменувань');
    const units = fmtNum(lines.reduce((a, x) => a + (x.other ? 0 : +x.qty || 0), 0));
    state.draft = null;
    save();
    refresh();
    // Пропозиція закрити знищене цим актом — уже з проведеним актом в обліку:
    // лише так видно, скільки він іще може закрити.
    if (k === 'wr') offerDestroyedLink(h);
    state.formOpen = false;                // документ проведено — бланк прибираємо
    if (k === 'dz') {
      state.flash = `Рапорт ${numNo(h.no)} від ${fmtDate(h.date)} ${rep ? 'виправлено' : 'внесено'}: ${kinds}, ${units} од.`
        + (warned.length ? ' ' + warned.join(' ') : '');
      state.editingReport = null;
      go('destroyed');
      return;
    }
    if (state.postNext && !wasEditing) {
      // Пачка документів: наступний — того самого виду, з тією самою датою й
      // маршрутом, номер — наступний після щойно проведеного.
      state.postNext = false;
      state.formOpen = true;                // пачка документів: бланк лишається
      const posted = docKey(k, h.date, h.no, h.from, h.to);
      state.draft = {
        kind: k,
        head: { type: h.type || '', no: nextDocNo(h.no), date: h.date, from: h.from, to: h.to,
                basis: h.basis, report: '', reportDate: '', act: '', note: '', auto: true },
        lines: [emptyLine()],
      };
      toast(`Документ ${numNo(h.no)} проведено: ${kinds}, ${units} од.`
        + (warned.length ? ' ' + warned.join(' ') : ''));
      go('moves');
      $('#doc-form')?.scrollIntoView({ block: 'start' });
      $('#doc-form [data-pick="0"]')?.focus();
      state.lastPosted = posted;
      return;
    }
    state.postNext = false;
    const said = `Документ ${numNo(h.no)} від ${fmtDate(h.date)} ${wasEditing ? 'виправлено' : 'проведено'}: ${kinds}, ${units} од.`
      + (warned.length ? ' ' + warned.join(' ') : '');
    state.flash = src ? dzFlash(src, said) : said;
    state.docBack = 'moves';
    state.docKey = docKey(k, h.date, h.no, h.from, h.to);
    go('doc');
  }

  /** Наступний номер: остання група цифр +1 зі збереженням нулів попереду —
   *  «ТЗ №17» → «ТЗ №18», «АКТ-2026-009» → «АКТ-2026-010». Без цифр — порожньо. */
  function nextDocNo(no) {
    const m = String(no || '').match(/^(.*?)(\d+)(\D*)$/);
    if (!m) return '';
    const n = String(+m[2] + 1).padStart(m[2].length, '0');
    return m[1] + n + m[3];
  }

  function act(name) {
    switch (name) {
      case 'new':
        if (!leaveEditing()) break;
        go('moves', { formOpen: true });
        $('#doc-form')?.scrollIntoView({ block: 'start' });
        break;
      case 'item-new':
        state.newItem = state.book === 'ОП'
          ? { code: nextCode('ОП'), name: '', unit: 'шт', group: 'ОП.1', price: '', nonrev: false, perRation: '' }
          : { code: nextCode(), name: '', unit: 'шт', group: '21.18', price: '', nonrev: false };
        go('nomen');
        break;
      case 'item-edit': {
        const it = itemBy.get(state.itemCode);
        if (!it) break;
        state.newItem = { code: it.code, name: it.name, unit: it.unit, group: it.group,
                          price: it.price || it.basePrice || '', nonrev: !!it.nonrev, editCode: it.code,
                          base: !it.own, fes: it.fes || '', note: it.note || '', old: it.old || '',
                          archived: it.archived || '', perRation: it.perRation ?? '' };
        go('nomen', { book: bookOfItem(it) });
        $('#item-form [name="name"]')?.focus();
        break;
      }
      case 'item-del': {
        const it = itemBy.get(state.itemCode);
        if (!it || !it.own) break;
        const uses = itemUses(it.code);
        if (uses.length) {
          alert(`Позицію ${it.code} «${it.name}» видалити не можна: її вжито (${uses.join(', ')}).\n\n`
            + 'Спершу виправте або видаліть ці записи.');
          break;
        }
        if (!confirm(`Видалити позицію ${it.code} «${it.name}» з довідника?`)) break;
        store.items = (store.items || []).filter((x) => String(x.code) !== it.code);
        logChange('позицію видалено', 'item|' + it.code, `${it.code} «${it.name}»`);
        mergeOwnItems();
        save(true, true);
        toast(`Позицію ${it.code} «${it.name}» видалено з довідника.`);
        go('nomen');
        break;
      }
      case 'item-cancel': {
        const back = state.newItem ? state.newItem.forLine : null;
        state.newItem = null;
        if (back != null && state.draft) go('moves'); else render();
        break;
      }
      case 'doc-later':
        // Чернетка лишається — просто прибираємо бланк з очей. Записуємо її
        // одразу, а не за таймером: вікно можуть закрити наступної миті.
        stashDraft();
        keepDrafts();
        state.formOpen = false;
        render();
        break;
      case 'only-mine': state.onlyMine = !state.onlyMine; state.movesLimit = 200; render(); break;
      case 'no-scan': state.noScan = !state.noScan; state.movesLimit = 200; render(); break;
      case 'more': state.movesLimit = (state.movesLimit || 200) + 200; render(); break;
      case 'edit-cancel': state.editing = null; state.editingReport = null; state.draft = null; render(); break;
      case 'line-add': {
        const dr = draft();
        dr.lines.push({ code: '', qty: '', price: '', note: '' });
        render();
        $(`#doc-form [data-pick="${dr.lines.length - 1}"]`)?.focus();
        break;
      }
      case 'line-other': {
        const dr = draft();
        dr.lines.push({ other: true, name: '', qty: '', uom: '', price: '', note: '', offNo: '', offDate: '' });
        render();
        $(`#doc-form [data-ln="name"][data-i="${dr.lines.length - 1}"]`)?.focus();
        break;
      }
      case 'draft-clear':
        if (hasContent(state.draft) && !confirm('Очистити форму? Усе, що в ній уписано, пропаде.')) break;
        state.draft = null;
        render();
        break;
      case 'journals-open': journalsDialog(); break;
      case 'op-export': opExport(); break;
      case 'folders-save': foldersSave(); break;
      case 'op-request': opRequestDialog(); break;
      case 'op-fes': pickFile('.xlsx', opFes); break;
      case 'fes-map-save': opFesSave(); break;
      case 'op-request-make': opRequestMake(); break;
      case 'op-import': pickFile('.xlsx', (f) => opImport(f, false)); break;
      case 'op-legacy': pickFile('.xlsx', (f) => opImport(f, true)); break;
      case 'journals-make': journalsMake(); break;
      case 'new-dz':
        if (!leaveEditing()) break;
        go('moves', { moveKind: 'dz', formOpen: true });
        $('#doc-form')?.scrollIntoView({ block: 'start' });
        break;
      case 'open-j47': go('j47', { j47code: state.itemCode, book: bookOf(state.itemCode) }); break;
      case 'j47-book': j47Excel(true); break;
      case 'doc-back': goBack(state.docBack && state.docBack !== 'doc' ? state.docBack : 'moves'); break;
      case 'back': goBack('nomen'); break;
      case 'short': state.onlyShort = !state.onlyShort; render(); break;
      case 'reset':
        Object.assign(state, { q: '', group: '', sub: '', onlyShort: false, onlyMine: false, noScan: false, assetF: '',
                               movesKindF: '', movesFrom: '', movesTo: '', movesLimit: 200, movesFes: '' });
        render();
        break;
      case 'print':
        if (state.view === 'j47') j47Excel();
        else if (state.view === 'j14') j14Excel();
        else if (state.view === 'inv') invExcel();
        else if (state.view === 'doc') docExcel(state.docKey);
        else if (state.view === 'recon') reconExcelDate();
        else listExcel();
        break;
      case 'export':
        if (state.view === 'doc') docExcel(state.docKey);
        else if (state.view === 'recon') reconExcelDate();
        else listExcel();
        break;

      case 'norms-demo': seedNormsFromBalance(); break;
      case 'norms-clear': {
        const scope = state.sub || rootName();
        const mine = normsInit().filter((n) => n.code && n.sub === scope);
        if (!mine.length) { toast(`Норм на коди для «${scope}» немає.`); break; }
        if (confirm(`Очистити ${cnt(mine.length, 'норму', 'норми', 'норм')} на коди для «${scope}» `
          + 'разом з усіма строками дії?\n\nНорми інших підрозділів лишаться.')) {
          store.norms = store.norms.filter((n) => !mine.includes(n));
          save(true, true); render();
        }
        break;
      }
      case 'clear-dz':
        if (confirm('Видалити рапорти про знищення, внесені в програмі?\n\nРапорти з паперових журналів лишаться.')) {
          store.destroyed = (store.destroyed || []).filter((x) => x.origin === 'seed'); save(true, true); refresh();
        }
        break;
      case 'state-export': copyAway(); break;
      case 'verify': openVerify(); break;
      case 'memo': openMemo(); break;
      case 'memo-print': printMemo(); break;
      case 'backups': openBackups(); break;
      case 'log': openLog(); break;
      case 'net-open': netOpen(); break;
      case 'net-save': netSave(); break;
      case 'net-logout': netLogout(); break;
      case 'search': paletteOpen(); break;
      case 'lines-all': linesAll(); break;
      case 'short-xls': shortageExcel(); break;
      case 'form21-xls': form21Excel(); break;
      case 'form21-set': form21SetExcel(); break;
      case 'losses-xls': lossesExcel(); break;
      case 'sub-nomen': go('nomen', { sub: state.subName, q: '', book: state.subBook || 'ТЗ', group: '' }); break;
      case 'sub-j14': go('j14', { j14sub: state.subName, j14page: 1, book: state.subBook || 'ТЗ' }); break;
      case 'sub-xls': subExcel(); break;
      case 'sub-filter-reset': state.subAsset = ''; state.subHolder = ''; render(); break;
      case 'first-unit': go('people', { peopleTab: 'unit', personId: null, assign: null }); break;
      case 'sub-rehold': {
        const child = ($('#f-rehold') || {}).value || '';
        if (!child) break;
        if (confirm(`Перенести майно, виписане на «${state.subName}», на «${child}»?\n\n`
          + 'У документах і записах про знищення батальйон буде замінено на цей підрозділ.')) {
          reholdToChild(state.subName, child);
        }
        break;
      }
      case 'sub-moves': go('moves', { sub: state.subName, q: '', movesLimit: 200, book: state.subBook || 'ТЗ' }); break;
      case 'sub-mvo': go('people', { peopleTab: 'resp', personId: null, assign: { kind: 'mvo', sub: state.subName } }); break;
      case 'scan-add': {
        const t = scanTarget();
        if (t) attachScan(t);
        break;
      }
      case 'post-next': {
        const form = $('#doc-form');
        if (!form) break;
        state.postNext = true;
        form.requestSubmit();
        break;
      }
      case 'hist':
        store.ui.hist = !store.ui.hist;
        save();
        render();
        toast(store.ui.hist
          ? 'Режим «вношу історію»: документи в закритому періоді проводяться без підтвердження.'
          : 'Режим «поточна робота»: документи в закритому періоді проводяться з підтвердженням.');
        break;
      case 'asof-today': {
        state.asOf = today();
        const el = $('#as-of');
        if (el) el.value = state.asOf;
        balCache.key = null;
        render();
        break;
      }
      case 'sb-add': substAdd(); break;
      case 'sb-clear': state.substDraft = { from: '', to: [] }; render(); break;
      case 'rc-back': if (canBack()) history.back(); else { state.reconId = null; go('recon'); } break;
      case 'rc-all': reconAll(); break;
      case 'rc-all-xls': reconExcelDate(); break;
      case 'rc-journal': reconJournalExcel(); break;
      case 'rc-fin': reconFill('fin'); break;
      case 'rc-fact': reconFill('fact'); break;
      case 'rc-line-add': {
        const r = current();
        if (!editable(r)) break;
        r.lines.push({ code: '', name: '', uom: 'шт', price: 0, fin: null, acc: 0, fact: null, note: '', extra: true });
        logChange('відомість доповнено', 'recon|' + r.id, `Відомість №${r.no || '—'} · ${r.sub}: дописано рядок`);
        save();
        render();
        document.querySelector(`[data-rl="${r.lines.length - 1}"][data-k="name"]`)?.focus();
        break;
      }
      case 'rc-sync': reconSync(); break;
      case 'rc-result': reconAutoResult(); break;
      case 'rc-sign': reconSign(true); break;
      case 'rc-unsign': reconSign(false); break;
      case 'rc-del': reconDelete(); break;
      case 'rc-print': reconExcel([reconById(state.reconId)]); break;
      case 'state-import': importState(); break;
      case 'reset-all':
        // Скидається лише те, що має позначку «внесено в програмі». Норми штату,
        // люди, МВО, дислокація й підрозділи такої позначки не мають (це і є
        // довідники бази), тож лишаються: раніше скидання видаляло всі норми,
        // разом із табелями 21/Прод і 3/Прод із паперів.
        if (confirm('Видалити все внесене в програмі: документи, рапорти про знищення, нові позиції номенклатури, '
          + 'звірки, інвентаризації, заміни в штаті, відомості залишкової вартості, акти ЯТС і підшиті скани?\n\n'
          + 'Документи й рапорти з паперових журналів служби (разом із виправленнями), норми штату, люди, МВО, '
          + 'дислокація й підрозділи лишаться як є. Поточний стан перед цим ляже в копії.')) {
          const base = (kind, arr) => (arr || []).filter((r) => rowOrigin(kind, r) === 'seed');
          store.docs = { incoming: base('in', store.docs.incoming), movement: base('mv', store.docs.movement),
                         writeoffs: base('wr', store.docs.writeoffs) };
          store.destroyed = (store.destroyed || []).filter((x) => x.origin === 'seed');
          store.items = []; store.recon = []; store.subst = [];
          store.scans = []; store.inventories = []; store.papers = [];
          mtzPrune();
          logChange('скинуто', '', 'внесене в програмі: документи, знищення, нові позиції, звірки, '
            + 'інвентаризації, заміни й скани');
          mergeOwnItems(); save(true, true); refresh();
        }
        break;
    }
  }

  /** Копія того, що внесено в програмі: документи, норми, знищення, вигляд. */
  function exportState() {
    const blob = new Blob([JSON.stringify(store, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `облік-тз-мої-дані-${today()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /** Відновлення з копії. Файл перевіряється на форму до того, як щось буде
   *  замінено: чужий чи зіпсований JSON не має стерти поточні дані. */
  function importState() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = native ? '.sqlite,.json,application/json' : '.json,application/json';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (native && /\.sqlite$/i.test(f.name)) { restoreFile(f); return; }
      let j;
      try { j = JSON.parse(await f.text()); } catch (e) {
        alert('Файл не прочитано: це не копія даних програми.');
        return;
      }
      const ok = j && typeof j === 'object' && j.docs && Array.isArray(j.docs.incoming)
        && Array.isArray(j.docs.movement) && Array.isArray(j.docs.writeoffs)
        && Array.isArray(j.destroyed || []) && typeof (j.norms || []) === 'object';
      if (!ok) { alert('У файлі немає даних обліку. Нічого не змінено.'); return; }
      const n = j.docs.incoming.length + j.docs.movement.length + j.docs.writeoffs.length;
      if (!confirm(`Відновити дані з «${f.name}»?

У копії: ${n} рядків документів, `
        + `${(Array.isArray(j.norms) ? j.norms : Object.keys(j.norms || {})).length} норм, `
        + `${(j.destroyed || []).length} записів знищення, `
        + `${(Array.isArray(j.items) ? j.items : []).length} нових позицій, `
        + `${(Array.isArray(j.recon) ? j.recon : []).length} звірок.
`
        + 'Поточні дані буде замінено, попередній стан лишиться в копіях.')) return;
      // Чого в копії немає (давній формат без норм чи позицій), те лишається
      // як є: порожній розділ означав би «видалити все», а не «не було в копії».
      if (j.norms) store.norms = j.norms;
      // Копія попередніх версій несе лише внесене в програмі: документи й рапорти
      // з паперових журналів жили окремо. Тоді вони лишаються, а внесене з копії
      // лягає поряд; номери актів до рапортів із паперів та копія тримала мапою.
      const oldCopy = !copyHasOrigin(j);
      const seed = (kind, arr) => (arr || []).filter((r) => rowOrigin(kind, r) === 'seed');
      const wrs = j.docs.writeoffs.map(wrRow);
      store.docs = oldCopy
        ? { incoming: seed('in', store.docs.incoming).concat(j.docs.incoming),
            movement: seed('mv', store.docs.movement).concat(j.docs.movement),
            writeoffs: seed('wr', store.docs.writeoffs).concat(wrs) }
        : { incoming: j.docs.incoming, movement: j.docs.movement, writeoffs: wrs };
      const dz = Array.isArray(j.destroyed) ? j.destroyed : [];
      store.destroyed = oldCopy ? (store.destroyed || []).filter((x) => x.origin === 'seed').concat(dz) : dz;
      if (oldCopy && j.dzActs && typeof j.dzActs === 'object') {
        for (const x of store.destroyed) {
          const a = x.origin === 'seed' && !x.act && j.dzActs[[x.date, x.sub, x.code, x.report].join('|')];
          if (a) x.act = String(a);
        }
      }
      if (Array.isArray(j.items)) store.items = j.items;
      store.recon = Array.isArray(j.recon) ? j.recon : [];
      store.subst = Array.isArray(j.subst) ? j.subst : [];
      store.scans = Array.isArray(j.scans) ? j.scans : [];
      store.inventories = Array.isArray(j.inventories) ? j.inventories : [];
      // Відомості й акти: копія, що їх знає, повертає їх разом із затвердженими версіями; копія
      // попередніх версій програми їх не має — тоді теперішні лишаються як є.
      if (Array.isArray(j.papers)) { store.papers = j.papers; saving.papers = true; }
      mtzPrune();
      for (const k of ['people', 'mvo', 'officials', 'locations', 'subs']) {
        if (Array.isArray(j[k])) store[k] = j[k]; else delete store[k];
      }
      // Довідники з копії лягають як є: вони й самі з бази, а не «поверх» неї.
      peopleReady.delete(store);
      peopleInit();
      store.ui = j.ui || store.ui;
      mergeOwnItems();
      stateBroken = null;
      saveBar('');
      save(true, true);
      refresh();
      state.flash = `Дані відновлено з «${f.name}».`;
      go('moves');
    });
    inp.click();
  }

  /** Стартова заготовка норм: поточна наявність по підрозділах як відправна точка. */
  /** Заготовка норм за наявністю — лише там, де норми ще немає: уписане руками
   *  не перезаписується. */
  function seedNormsFromBalance() {
    const scope = state.sub || rootName();
    const todo = tzItems().filter((i) => {
      const have = state.sub ? haveRollup(scope, i.code) : balCode(i.code);
      return have > 0 && !normOwn(scope, i.code);
    });
    if (!todo.length) { toast('Порожніх норм для наявних позицій немає.'); return; }
    if (!confirm(`Заповнити ${cnt(todo.length, 'порожню норму', 'порожні норми', 'порожніх норм')} для «${scope}» `
      + 'поточною наявністю? Уже вписані норми не зміняться. Норми на коди, прив’язані до рядків форми, '
      + 'підуть і в потребу форми 21/Прод.')) return;
    for (const i of todo) {
      normSet({ sub: scope, code: i.code }, state.sub ? haveRollup(scope, i.code) : balCode(i.code), state.asOf, false, true);
    }
    logChange('штат змінено', 'norm|' + scope, `${scope}: ${cnt(todo.length, 'норму', 'норми', 'норм')} заповнено `
      + `наявністю на ${fmtDate(state.asOf)}`);
    save(); render();
    toast(`Заповнено ${cnt(todo.length, 'норму', 'норми', 'норм')}. Перевірте цифри за штатом.`);
  }

  /** Експорт того, що на екрані, у CSV для Excel.
   *
   *  Раніше кнопка на будь-якому екрані вивантажувала номенклатуру — навіть
   *  зі стрічки документів, де людина чекає саме документи. Тепер кожен вигляд
   *  віддає свою таблицю з тими самими фільтрами, що й на екрані.
   */
  function exportRows() {
    const q = state.q.trim().toLowerCase();
    if (state.view === 'moves') {
      const head = ['дата', 'вид', 'номер', 'звідки', 'куди', 'код', 'найменування', 'кількість', 'примітка', 'стан'];
      const list = movesSorted();
      return ['документи', [head, ...list.map((r) => {
        const it = itemBy.get(r.code);
        return [r.d, KIND_TAG[r.kind][1], r.no, r.from, r.to, r.code, it ? it.name : '', r.q, r.note || '', DOC_STATUS[docStatus(r)][0]];
      })]];
    }
    if (state.view === 'supply' || state.view === 'subst') {
      const form = state.staffForm;
      const rows = applySubst(staffRows(state.asOf, state.sub).filter((g) => g.form === form), form);
      const withS = !!((store.subst || []).some((x) => x.form === form) && store.ui.withSubst);
      const head = ['табельна позиція', 'штат', 'наявно', 'знищено'].concat(withS ? ['по заміні', 'за рахунок'] : [])
        .concat(['некомплект', 'понад штат', '%']);
      return [`штат-${state.sub || 'бригада'}-${form.replace('/', '-')}${withS ? '-з-замінами' : ''}`,
        [head, ...rows.filter((g) => g.staffed || (withS && g.subOut)).map((g) => {
          const pct = withS ? g.pctS : g.pct;
          return [g.line, g.qty || '', g.have, g.destr || '']
            .concat(withS ? [g.subIn || '', g.subFrom.map(([l, q]) => `${l} – ${q}`).join('; ')] : [])
            .concat([(withS ? g.shortS : g.short) || '', (withS ? g.overS : g.over) || '',
              pct == null ? '' : Math.round(pct * 100) + '%']);
        })]];
    }
    if (state.view === 'destroyed') {
      const head = ['дата', 'підрозділ', 'код', 'найменування', 'кількість', 'ціна', 'сума', 'рапорт', 'дата рапорту',
        'чим списано', 'дата акта', 'статус'];
      const vals = lossValues();
      return ['знищене', [head, ...regRows(destroyedSpec()).map((r) => {
        const it = itemBy.get(r.code);
        const v = vals.get(r.id) || {};
        return [r.date, r.sub, r.code, r.other ? r.name || '' : it ? it.name : '', r.qty, v.qty ? v.price : '', v.qty ? v.sum : '',
          r.report || '', r.reportDate || '', r.other ? r.offNo || '' : actLabel(r), r.status === 'списано' ? r.actDate || '' : '', r.status];
      })]];
    }
    if (state.view === 'inv') {
      const head = ['код', 'найменування', 'підрозділ', 'перший номер', 'останній номер', 'одиниць'];
      return ['інвентарні-номери', [head, ...regRows(inventorySpec()).map((r) => {
        const it = itemBy.get(r.code);
        return [r.code, it ? it.name : '', r.sub, invNo(r.code, r.from), invNo(r.code, r.to), r.to - r.from + 1];
      })]];
    }
    if (state.view === 'subs') {
      const b = balances();
      const head = ['підрозділ', 'тип', 'власний залишок', 'з підлеглими'];
      return ['підрозділи', [head, ...subs.map((sb) => {
        const own = b.bySub.get(sb.name) || 0;
        const roll = [...b.bySub.entries()].reduce((a, [n, v]) => (inSubtree(sb.name, n) ? a + v : a), 0);
        return [sb.name, sb.type, own, roll];
      })]];
    }
    const head = ['код', 'найменування', 'група', 'од.вим.', 'облік', '№ ФЕС', 'остання ціна', 'ціни партій',
      'вартість, грн', 'наявно', 'знищено', 'фактично'];
    return ['номенклатура', [head, ...filteredItems().map((i) => {
      const have = state.sub ? balOf(i.code, state.sub) : balCode(i.code);
      const d = destroyedOf(i.code, state.sub || null);
      const lots = lotBreakdown(i.code, state.sub || null);
      return [i.code, i.name, i.group, i.unit, ASSET[assetOf(i)][1], i.fes || '', i.price,
        lotPricesText(i.code, state.sub || null, true), lots.value, have, d, have - d];
    })]];
  }



  // -------------------------------------------------------------- налаштування
  const ACCENTS = ['#3f5233', '#3d5666', '#7a5a33', '#5a4a63', '#6d3f36'];

  const ACCENT_NAMES = ['Хакі', 'Сталевий', 'Вохра', 'Слива', 'Цегла'];
  const DENSITIES = [['comfort', 'Вільна'], ['dense', 'Щільна'], ['compact', 'Дуже щільна']];
  const TEXT_SIZES = [['normal', 'Звичайний'], ['big', 'Більший'], ['bigger', 'Великий']];

  /** Версія програми й схема бази: два рядки в картці «Довідка». */
  function versionLines() {
    const m = D.meta || {};
    if (!m.version) return [];
    return [`Версія ${m.version}${m.versionDate ? ` від ${fmtDate(m.versionDate)}` : ''}`,
      m.schema ? `Схема бази ${m.schema}` : ''].filter(Boolean);
  }

  // ============================================================ НАЛАШТУВАННЯ
  /** Налаштування — окремий екран (до 1.10 — спливна панель біля ⚙): оформлення,
   *  робота в мережі, копії бази, перевірка, небезпечні дії й довідка. Людина з
   *  іншого ПК бачить лише те, що може зробити звідти: копії, відновлення й
   *  видалення всього внесеного — справа основного ПК. */
  function renderSettings() {
    const host = native && !me.remote;
    const card = (title, body, cls = '') => `<section class="card set-card${cls}">
      <div class="card__head"><div class="card__title">${esc(title)}</div></div>
      <div class="set-card__body">${body}</div></section>`;
    const row = (label, ctl) => `<div class="set-row"><span class="set-label">${esc(label)}</span>${ctl}</div>`;
    const act = (btn, hint) => `<div class="set-act">${btn}${hint ? `<span class="set-hint">${hint}</span>` : ''}</div>`;
    const seg = (list, on, attr) => `<div class="seg">${list.map(([k, l]) =>
      `<button type="button" data-${attr}="${k}"${on === k ? ' class="is-on"' : ''}>${l}</button>`).join('')}</div>`;

    const look = row('акцентний колір', `<div class="swatches">${ACCENTS.map((c, n) =>
      `<button type="button" class="swatch${state.accent === c ? ' is-on' : ''}" data-accent="${c}"
        style="background:${c}" title="${ACCENT_NAMES[n]}" aria-label="${ACCENT_NAMES[n]}"></button>`).join('')}</div>`)
      + row('щільність рядків', seg(DENSITIES, state.density, 'density'))
      + row('розмір тексту', seg(TEXT_SIZES, state.textSize || 'normal', 'textsize'))
      + row('довгі назви', seg([['0', 'Обрізати'], ['1', 'Переносити']], state.wrap ? '1' : '0', 'wrap'));

    let net = '';
    if (me.remote) {
      net = row('ви ввійшли як', `<b>${esc(me.name)}</b>`)
        + '<p class="set-note">Програма й база — на основному ПК служби. Ваші зміни записуються туди, разом зі змінами інших.</p>'
        + act('<button type="button" class="btn" data-act="net-logout">Вийти</button>', 'наступного разу — знову ім’я й код');
    } else if (host) {
      const n = me.net || {};
      const status = n.listening ? 'увімкнено' : n.on ? 'після перезапуску' : 'вимкнено';
      net = row('робота з інших ПК', `<b class="${n.listening ? 'num-ok' : n.on ? 'num-warn' : ''}">${status}</b>`)
        + (n.on ? row('адреса для інших ПК', `<div class="set-addr">${(n.addresses || []).map((a) =>
          `<code>${esc(a)}</code>`).join('')}</div>`) : '')
        + row('ваше ім’я в журналі змін', n.host_name ? `<b>${esc(n.host_name)}</b>` : '<span class="set-hint">не задано</span>')
        + act('<button type="button" class="btn" data-act="net-open">Налаштувати…</button>',
          n.on ? 'інші відкривають адресу в Edge чи Chrome і вписують ім’я та код доступу'
            : 'щоб інші ПК служби працювали з цією ж базою одночасно з вами');
    }

    const copies = host
      ? act(`<button type="button" class="btn" data-act="backups">Автоматичні копії…</button>`,
        lastBackup ? `остання ${esc(lastBackup)}` : 'лежать на цьому ж диску')
        + act(`<button type="button" class="btn" data-act="state-export">Зберегти копію бази…</button>`,
          store.ui.lastCopy ? `остання ${esc(fmtDate(store.ui.lastCopy))}` : 'раз на місяць — на флешку чи інший диск')
        + act('<button type="button" class="btn" data-act="state-import">Відновити з файла…</button>', 'копія бази з флешки')
      : native
        ? '<p class="set-note">Копії бази робляться й відновлюються на основному ПК.</p>'
        : act('<button type="button" class="btn" data-act="state-export">Зберегти копію даних…</button>',
          'дані зберігаються в цьому браузері')
          + act('<button type="button" class="btn" data-act="state-import">Відновити з файла…</button>', '');
    const data = copies + act('<button type="button" class="btn" data-act="imp-open">Імпорт історії з Excel…</button>',
      'підрозділи, позиції й документи за минулі роки');

    const check = act('<button type="button" class="btn" data-act="log">Журнал змін…</button>', 'хто, що й коли змінив')
      + (native ? act('<button type="button" class="btn" data-act="verify">Перевірити базу…</button>', 'пошук помилок в обліку') : '');

    const danger = me.remote ? '' : card('Небезпечні дії',
      act('<button type="button" class="btn btn--danger" data-act="clear-dz">Видалити рапорти про знищення…</button>',
        'лише внесені в програмі')
      + act('<button type="button" class="btn btn--danger" data-act="reset-all">Видалити все внесене в програмі…</button>',
        'документи, рапорти, звірки, інвентаризації, скани')
      + '<p class="set-note">Дані з паперових журналів, штат, люди, МВО, дислокація й підрозділи лишаються. '
      + 'Перед видаленням програма робить копію.</p>', ' set-card--danger');

    const help = act('<button type="button" class="btn" data-act="memo">Пам’ятка для служби…</button>', 'інструкція на одну сторінку')
      + (versionLines().length ? `<div class="set-version" id="app-version">${versionLines().map(esc).join('<br>')}</div>` : '');
    const gloss = `<div class="set-gloss">${Object.entries(GLOSSARY).filter(([k]) => k !== 'ФЄС')
      .map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}</div>`;

    return {
      head: head('програма', 'Налаштування'),
      body: `<div class="set-grid" id="settings">
        ${card('Оформлення', look)}
        ${net ? card('Робота в мережі', net) : ''}
        ${card('Дані та копії', data)}
        ${native && !me.remote ? card('Теки', foldersBody()) : ''}
        ${card('Перевірка', check)}
        ${danger}
        ${card('Довідка', help)}
        ${card('Скорочення', gloss, ' set-card--wide')}
      </div>`,
    };
  }

  // ---------------------------------------------------------------- 2/Прод
  /** Звіт-заявка 2/прод: дані рахує сервер з бази обох книг (api/form2); сторінка тримає останню
   *  відповідь у state.form2 і просить нову після кожної своєї правки цього екрана. */
  const F2_TABS = [['report', 'Звіт'], ['map', 'Відповідність'], ['notes', 'Записки'], ['parties', 'Контрагенти']];
  const f2Year = () => state.f2year || Number(today().slice(0, 4)) - (today().slice(5, 10) < '02-01' ? 1 : 0);
  async function form2Load(year = f2Year()) {
    if (!native || state.form2Loading) return;
    state.form2Loading = true;
    try {
      await flush();
      const r = await fetch(`api/form2?year=${year}`);
      if (!r.ok) throw new Error(await r.text());
      state.form2 = { year, data: await r.json() };
    } catch (e) {
      toast(`Звіт не зібрано: ${e.message || e}`, true);
    } finally {
      state.form2Loading = false;
      if (state.view === 'form2') render();
    }
  }
  /** Екран повертає { head, body }, як усі екрани (`render()` вставляє їх і кличе `bindBody`). */
  function renderForm2() {
    const year = f2Year();
    const tab = state.f2tab || 'report';
    const rep = state.form2 && state.form2.year === year ? state.form2.data : null;
    if (!rep && !state.form2Loading && native) setTimeout(() => form2Load(year), 0);
    const years = [];
    for (let y = Number(today().slice(0, 4)); y >= 2026; y--) years.push(y);
    if (!years.includes(year)) years.push(year);
    const yearSel = `<label class="chip is-on"><span class="chip__label">рік</span><select id="f2-year">${
      years.map((y) => `<option${y === year ? ' selected' : ''}>${y}</option>`).join('')}</select></label>`;
    const tabs = `<div class="seg">${F2_TABS.map(([k, l]) =>
      `<button type="button" data-act="f2-tab" data-v="${k}"${tab === k ? ' class="is-on"' : ''}>${l}</button>`).join('')}</div>`;
    const top = head('звіти / 2/прод', `Звіт-заявка 2/прод за ${year} рік`, yearSel + tabs);
    if (!native) return { head: top, body: '<div class="pad">2/Прод складається в програмі на комп’ютері.</div>' };
    if (!rep) return { head: top, body: '<div class="pad">Збираю звіт з бази…</div>' };
    const bad = rep.checks.filter((c) => c.level === '✗').length;
    const warn = rep.checks.length - bad;
    const unsure = form2MapNow().filter((m) => m.row && !m.checked).length;
    const state0 = `<div class="panel">
        <span class="tag">${rep.submittedPrev ? `зданий звіт ${year - 1}: є` : `зданого звіту ${year - 1} немає`}</span>
        <span class="tag">уточнити: ${unsure}</span>
        <span class="tag${bad ? ' tag--out' : ''}">перевірки: ✗ ${bad} · ⚠ ${warn}</span>
        <div class="panel__spacer"></div>
        <button type="button" class="btn" data-act="f2-submitted">Прийняти зданий звіт…</button>
        <button type="button" class="btn" data-act="f2-note">Пояснювальна</button>
        <button type="button" class="btn btn--primary" data-act="f2-package">Скласти пакет</button>
        <button type="button" class="btn" data-act="f2-submit" title="Запам'ятати графи 5–18 як зданий звіт: з них береться гр.8 наступного року">Звіт здано</button>
      </div>`;
    const body = { report: form2Report, map: form2MapTab, notes: form2Notes, parties: form2Parties }[tab](rep, year);
    return { head: top, body: `${state0}${body}` };
  }
  function form2Report(rep, year) {
    const rows = rep.rows.filter((r) => !r.header && ([5, 8, 11, 15, 18].some((c) => Math.abs(r.c[c]) > 1e-9)
      || Math.abs(r.balance) > 1e-9));
    const gap = (r) => +(r.c[18] - r.balance).toFixed(3);
    const num = (key, label, get) => ({ key, label, cls: 'c-num', sort: get, cell: (r) => fmtNum(get(r)) });
    const reg = registry({
      id: 'f2', rows, minWidth: '1080px', search: (r) => [r.name, String(r.row), ...r.codes], placeholder: 'Рядок, назва чи код',
      filters: [{ type: 'seg', key: 'show', options: [['', 'усі'], ['gap', 'з розбіжністю'], ['move', 'з рухом']],
        test: (r, v) => (v === 'gap' ? Math.abs(gap(r)) > 1e-9 : Math.abs(r.c[11]) + Math.abs(r.c[15]) > 1e-9) }],
      columns: [
        { key: 'row', label: 'рядок', cls: 'c-code', sort: (r) => r.row, cell: (r) => String(r.row) },
        { key: 'name', label: 'найменування', cls: 'c-name c-name--stack', sort: (r) => r.name, cell: (r) => `<b>${esc(r.name)}</b><small>${
          esc(r.uom || 'без одиниці')}${r.codes.length ? ' · ' + esc(r.codes.join(', ')) : ''}</small>` },
        num('c5', 'гр.5', (r) => r.c[5]), num('c8', 'гр.8', (r) => r.c[8]), num('c12', 'гр.12', (r) => r.c[12]),
        num('c13', 'гр.13', (r) => r.c[13]), num('c14', 'гр.14', (r) => r.c[14]), num('c16', 'гр.16', (r) => r.c[16]),
        num('c17', 'гр.17', (r) => r.c[17]), num('c18', 'гр.18', (r) => r.c[18]), num('bal', 'облік', (r) => r.balance),
        { key: 'gap', label: 'різниця', cls: 'c-num', sort: gap, cell: (r) => (Math.abs(gap(r)) > 1e-9
          ? `<span class="num-bad">${fmtNum(gap(r))}</span>` : '—') },
      ],
      row: (r) => ({ attrs: `data-act="f2-row" data-row="${r.row}"` }),
      empty: `У ${year} році руху за прив’язаними кодами немає, зданого звіту ${year - 1} теж немає.`,
    });
    regRedraw.set('f2', render);
    const open = state.f2row ? rep.rows.find((x) => x.row === state.f2row) : null;
    const checks = rep.checks.length ? `<div class="card" style="margin-top:12px"><div class="card__head">
        <div class="card__title">Перевірки</div></div><div class="pad">${rep.checks.map((c) =>
          `<div class="f2-check"><span class="${c.level === '✗' ? 'num-bad' : ''}">${c.level}</span> ${esc(c.text)}</div>`).join('')}</div></div>` : '';
    return reg.panel + (open ? form2RowCard(open) : '') + `<div class="card card--scroll">${reg.table}</div>` + checks;
  }
  /** Документи рядка звіту по графах, з вибором іншої графи для документа, — карткою над таблицею. */
  function form2RowCard(r) {
    const col = (id) => String(((store.docMeta || {})[id] || {}).col || '');
    const list = [12, 13, 14, 16, 17].map((c) => (r.docs[c].length ? `<h4>графа ${c}</h4>${r.docs[c].map((d) => `
      <div class="f2-check">${esc(d.type)} №${esc(d.no)} від ${fmtDate(d.date)} · ${esc(d.party || '—')} · ${fmtNum(d.qty)}
        <span class="tag">${esc(d.rule)}</span>${typeof d.id === 'number' ? `
        <select data-f2col="${d.id}">${[['', 'за правилом'], ...[12, 13, 14, 16, 17].map((x) => [String(x), 'гр.' + x])].map(([v, l]) =>
          `<option value="${v}"${col(d.id) === v ? ' selected' : ''}>${l}</option>`).join('')}</select>` : ''}
      </div>`).join('')}` : '')).join('');
    return `<div class="card" style="margin-bottom:12px"><div class="card__head">
        <div class="card__title">Рядок ${r.row}: ${esc(r.name)}</div><div class="panel__spacer"></div>
        <button type="button" class="btn btn--sm" data-act="f2-row" data-row="${r.row}">Закрити</button></div>
      <div class="pad">${list || 'Документів року немає.'}</div></div>`;
  }
  const f2RowName = () => {
    const out = new Map((D.form2Rows || []).map((r) => [r[0], r[1]]));
    for (const o of store.form2Own || []) out.set(o.row, o.name);
    return out;
  };
  const f2State = (m) => (!m ? 'не прив’язано' : m.skip ? 'поза 2/прод' : m.checked ? 'перевірено' : 'уточнити');
  function form2MapTab() {
    const map = new Map(form2MapNow().map((m) => [m.code, m]));
    const rowName = f2RowName();
    const rows = items.filter((i) => !i.archived).map((i) => ({ it: i, m: map.get(i.code) || null }));
    const reg = registry({
      id: 'f2m', rows, minWidth: '1000px', search: (r) => [r.it.code, r.it.name, r.m && r.m.row ? String(r.m.row) : ''],
      placeholder: 'Код, назва чи рядок',
      filters: [{ type: 'seg', key: 'st', options: [['', 'усі'], ['не прив’язано', 'не прив’язано'], ['уточнити', 'уточнити'],
        ['поза 2/прод', 'поза 2/прод']], test: (r, v) => f2State(r.m) === v },
      { type: 'seg', key: 'book', options: [['', 'обидві книги'], ['ТЗ', 'ТЗ'], ['ОП', 'ОП']], test: (r, v) => bookOfItem(r.it) === v }],
      columns: [
        { key: 'code', label: 'код', cls: 'c-code', sort: (r) => r.it.code, cell: (r) => esc(r.it.code) },
        { key: 'name', label: 'позиція', cls: 'c-name', sort: (r) => r.it.name, cell: (r) => `<b>${esc(r.it.name)}</b>` },
        { key: 'row', label: 'рядок 2/Прод', cls: 'c-txt', sort: (r) => (r.m && r.m.row) || 0, cell: (r) => `<input class="inp-num"
          data-f2bind="${esc(r.it.code)}" value="${r.m && r.m.row ? r.m.row : ''}" placeholder="№" aria-label="рядок 2/Прод">
          <small>${esc(r.m && r.m.row ? rowName.get(r.m.row) || 'немає такого рядка' : (r.m && r.m.skip) || '')}</small>` },
        { key: 'factor', label: '×', cls: 'c-num', cell: (r) => `<input class="inp-num" data-f2factor="${esc(r.it.code)}"
          value="${r.m ? r.m.factor || 1 : 1}" aria-label="множник">` },
        { key: 'st', label: 'стан', cls: 'c-tag', sort: (r) => f2State(r.m), cell: (r) => `<span class="tag">${esc(f2State(r.m))}</span>${
          r.m && r.m.checked ? `<small>${esc(r.m.checked)}${r.m.checkedOn ? ' · ' + fmtDate(r.m.checkedOn) : ''}</small>` : ''}` },
        { key: 'act', label: '', cls: 'c-acts', cell: (r) => `<button type="button" class="btn btn--sm" data-act="f2-check" data-code="${esc(r.it.code)}">Перевірено</button>
          <button type="button" class="btn btn--sm" data-act="f2-skip" data-code="${esc(r.it.code)}">Поза 2/прод</button>` },
      ],
      empty: 'Позицій немає.',
    });
    regRedraw.set('f2m', render);
    return `<div class="panel"><button type="button" class="btn" data-act="f2-map-read">Прийняти відповідність…</button></div>`
      + reg.panel + `<div class="card card--scroll">${reg.table}</div>`;
  }
  function form2Set(code, patch) {
    const cur = form2MapNow().find((m) => m.code === code) || { code, row: null, factor: 1, checked: null, checkedOn: null, skip: null };
    store.form2Map = store.form2Map || {};
    store.form2Map[code] = Object.assign({ row: cur.row, factor: cur.factor, checked: cur.checked, checkedOn: cur.checkedOn,
      skip: cur.skip }, patch);
    logChange('прив’язка 2/Прод', 'f2|' + code, JSON.stringify(store.form2Map[code]));
    save();
    if (state.view === 'form2') form2Load(f2Year()); else render();
  }
  function form2Notes(rep, year) {
    const mine = (store.form2Notes || []).filter((n) => n.year === year);
    const name = new Map(rep.rows.map((r) => [r.row, r.name]));
    const props = rep.proposals.filter((p) => !mine.some((n) => n.row === p.row && n.col === p.col)).map((p) => `
      <div class="f2-check">рядок ${p.row} «${esc(name.get(p.row) || '')}»: гр.${p.col} ${p.col === 14 ? '+' : '−'}${fmtNum(p.qty)}
        <button type="button" class="btn btn--sm" data-act="f2-note-add" data-row="${p.row}" data-col="${p.col}" data-qty="${p.qty}">Записка</button></div>`).join('');
    const list = mine.map((n) => `<div class="f2-check">рядок ${n.row} «${esc(name.get(n.row) || '')}» · гр.${n.col} · ${fmtNum(n.qty)}
        <input data-f2n="${esc(n.id)}" data-k="no" value="${esc(n.no || '')}" placeholder="№" aria-label="номер записки">
        <input type="date" data-f2n="${esc(n.id)}" data-k="date" value="${esc(n.date || '')}" aria-label="дата записки">
        <input data-f2n="${esc(n.id)}" data-k="reason" value="${esc(n.reason || '')}" placeholder="причина" aria-label="причина" style="flex:1">
        <button type="button" class="btn btn--sm" data-act="f2-note-del" data-id="${esc(n.id)}">Прибрати</button></div>`).join('');
    return `<div class="card"><div class="card__head"><div class="card__title">Різниця зі зданим звітом ${year - 1}</div></div>
        <div class="pad">${props || 'Різниці немає.'}</div></div>
      <div class="card" style="margin-top:12px"><div class="card__head"><div class="card__title">Записки ${year}</div></div>
        <div class="pad">${list || 'Записок немає.'}</div></div>`;
  }
  function form2Parties() {
    const kinds = ['військова частина', 'постачальник', 'фонд', 'інше'];
    const all = new Map((D.parties || []).map(([n, k]) => [n, k]));
    for (const [n, k] of Object.entries(store.parties || {})) all.set(n, k);
    const rows = [...all.entries()].map(([name, kind]) => ({ name, kind, guess: partyGuess(name) }));
    const reg = registry({
      id: 'f2p', rows, minWidth: '760px', search: (r) => [r.name], placeholder: 'Контрагент',
      filters: [{ type: 'toggle', key: 'diff', label: 'вид ≠ пропозиції', test: (r) => r.kind !== r.guess }],
      columns: [
        { key: 'name', label: 'контрагент', cls: 'c-name', sort: (r) => r.name, cell: (r) => `<b>${esc(r.name)}</b>` },
        { key: 'kind', label: 'вид', cls: 'c-txt', sort: (r) => r.kind, cell: (r) => `<select data-f2party="${esc(r.name)}"
          aria-label="вид контрагента">${kinds.map((k) => `<option${k === r.kind ? ' selected' : ''}>${k}</option>`).join('')}</select>` },
        { key: 'guess', label: 'пропозиція', cls: 'c-txt', cell: (r) => (r.kind === r.guess ? '—' : esc(r.guess)) },
      ],
      empty: 'Контрагентів ще немає: вони з’являються з першим приходом.',
    });
    regRedraw.set('f2p', render);
    return `<div class="panel"><button type="button" class="btn" data-act="f2-party-all">Прийняти пропозиції</button></div>`
      + reg.panel + `<div class="card card--scroll">${reg.table}</div>`;
  }
  /** Поля екрана 2/Прод і картки позиції: прив'язка, множник, записки, види контрагентів, рік. */
  function bindForm2Fields(root) {
    if (!root) return;
    root.querySelectorAll('[data-f2bind]').forEach((el) => el.addEventListener('change', () => {
      const v = el.value.trim();
      form2Set(el.dataset.f2bind, v ? { row: Number(v), skip: null, checked: null, checkedOn: null } : { row: null, skip: null });
    }));
    root.querySelectorAll('[data-f2factor]').forEach((el) => el.addEventListener('change', () => {
      const v = Number(String(el.value).replace(',', '.'));
      if (v > 0) form2Set(el.dataset.f2factor, { factor: v });
    }));
    root.querySelectorAll('[data-f2n]').forEach((el) => el.addEventListener('change', () => {
      const n = (store.form2Notes || []).find((x) => x.id === el.dataset.f2n);
      if (!n) return;
      n[el.dataset.k] = el.value.trim();
      save();
      form2Load(f2Year());
    }));
    root.querySelectorAll('[data-f2col]').forEach((el) => el.addEventListener('change', () => {
      const id = el.dataset.f2col;
      store.docMeta = store.docMeta || {};
      const cur = Object.assign({ report: '', order: '', scan: '', col: null }, store.docMeta[id] || {});
      cur.col = el.value ? Number(el.value) : null;
      store.docMeta[id] = cur;
      logChange('графа 2/прод', 'f2col|' + id, el.value ? 'гр.' + el.value : 'за правилом');
      save();
      form2Load(f2Year());
    }));
    root.querySelectorAll('[data-f2party]').forEach((el) => el.addEventListener('change', () => {
      store.parties = store.parties || {};
      store.parties[el.dataset.f2party] = el.value;
      save();
      form2Load(f2Year());
    }));
    const y = $('#f2-year');
    if (y) y.addEventListener('change', () => { state.f2year = Number(y.value); state.form2 = null; render(); });
  }
  /** Прив'язка позиції до рядка 2/Прод у картці позиції (обидві книги). */
  function form2ItemCard(i) {
    const m = form2MapNow().find((x) => x.code === i.code) || null;
    const rowName = f2RowName();
    const said = !m ? 'не прив’язано' : m.skip ? `поза 2/прод: ${m.skip}` : m.checked
      ? `перевірено: ${m.checked}${m.checkedOn ? ', ' + fmtDate(m.checkedOn) : ''}` : 'уточнити';
    return `<div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">2/Прод</div>
        <div class="panel__spacer"></div><span class="panel__count">${esc(said)}</span></div>
      <div class="panel">
        <label class="chip"><span class="chip__label">рядок</span><input class="inp-num" data-f2bind="${esc(i.code)}"
          value="${m && m.row ? m.row : ''}" placeholder="№"></label>
        <span class="panel__note">${esc(m && m.row ? rowName.get(m.row) || 'немає такого рядка' : '')}</span>
        <label class="chip"><span class="chip__label">×</span><input class="inp-num" data-f2factor="${esc(i.code)}"
          value="${m ? m.factor || 1 : 1}"></label>
        <button type="button" class="btn btn--sm" data-act="f2-check" data-code="${esc(i.code)}">Перевірено</button>
        <button type="button" class="btn btn--sm" data-act="f2-skip" data-code="${esc(i.code)}">Поза 2/прод</button>
      </div></div>`;
  }
  async function form2Submitted(file) {
    let j = {};
    try {
      await flush();
      const r = await fetch('api/form2/submitted', { method: 'POST', body: file });
      j = await r.json().catch(() => ({}));
    } catch (e) { j = { problems: [String(e.message || e)] }; }
    if (!j.ok) {
      modalOpen('Зданий звіт не прийнято', `<div class="pad">${listHtml(j.problems || [j.error || 'помилка'])}</div>`, 'modal__box--form');
      return;
    }
    toast(`Зданий звіт ${j.year}: ${cnt(j.rows, 'клітинка', 'клітинки', 'клітинок')}`);
    if (j.unknown && j.unknown.length) {
      modalOpen('Рядки, яких немає в переліку', `<div class="pad">${listHtml(j.unknown)}</div>`, 'modal__box--form');
    }
    form2Load(f2Year());
  }
  async function form2MapRead(file) {
    const day = new Date(file.lastModified || Date.now()).toISOString().slice(0, 10);
    let j = {};
    try {
      const r = await fetch(`api/form2/map-read?date=${day}`, { method: 'POST', body: file });
      j = await r.json().catch(() => ({}));
    } catch (e) { j = { problems: [String(e.message || e)] }; }
    if (!j.map) { toast(`Відповідність не прочитано: ${(j.problems || [j.error || 'помилка']).join('; ')}`, true); return; }
    const known = new Set(items.map((i) => i.code));
    const unknown = Object.keys(j.map).filter((c) => !known.has(c));
    const st = j.stats;
    state.f2pending = { map: j.map, own: j.own };
    modalOpen('Прийняти відповідність', `<div class="pad">
      <p>Кодів у таблиці: ${st.rows} · перевірено: ${st.checked} · уточнити: ${st.unsure} · поза 2/прод: ${st.skip} · без рядка: ${st.unbound}</p>
      ${j.own.length ? `<p>Власні рядки: ${j.own.map((o) => `${o.row} «${esc(o.name)}»`).join(', ')}</p>` : ''}
      ${unknown.length ? `<p>Кодів немає в програмі (лишаться без змін): ${esc(unknown.join(', '))}</p>` : ''}
      <div class="set-form__acts"><button type="button" class="btn btn--primary" data-act="f2-map-apply">Прийняти</button></div></div>`,
    'modal__box--form');
  }
  /** Дії екрана 2/Прод (кнопки несуть свої дані в data-атрибутах). */
  function form2Action(act, d) {
    switch (act) {
      case 'f2-tab': state.f2tab = d.v; return render();
      case 'f2-row': state.f2row = state.f2row === Number(d.row) ? null : Number(d.row); return render();
      case 'f2-check': return form2Set(d.code, { checked: me.name || 'основний ПК', checkedOn: today(), skip: null });
      case 'f2-skip': {
        const why = prompt('Чому код поза 2/прод (наприклад, «3/прод», «господарчі»)?', 'поза 2/прод');
        if (why && why.trim()) form2Set(d.code, { row: null, skip: why.trim(), checked: null, checkedOn: null });
        return null;
      }
      case 'f2-package': return toExcel({ kind: 'form2', year: f2Year(), file: `2прод ${f2Year()}` });
      case 'f2-note': return toExcel({ kind: 'form2note', year: f2Year(), word: true, file: `пояснювальна ${f2Year()}` });
      case 'f2-submit':
        if (!confirm(`Запам'ятати звіт ${f2Year()} як зданий? Графи 5–18 стануть основою гр.8 звіту ${f2Year() + 1}.`)) return null;
        return flush().then(() => fetch('api/form2/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ year: f2Year() }) })).then((r) => r.json()).then((j) => {
          toast(`Звіт здано: ${cnt(j.rows || 0, 'клітинка', 'клітинки', 'клітинок')}`);
          form2Load(f2Year());
        }).catch((e) => toast(`Не вдалося: ${e.message || e}`, true));
      case 'f2-submitted': return pickFile('.xlsx', form2Submitted);
      case 'f2-map-read': return pickFile('.xlsx', form2MapRead);
      case 'f2-map-apply': {
        const pend = state.f2pending;
        if (!pend) return null;
        const known = new Set(items.map((i) => i.code));
        store.form2Map = store.form2Map || {};
        let n = 0;
        for (const [code, e] of Object.entries(pend.map)) {
          if (!known.has(code)) continue;
          store.form2Map[code] = e;
          n += 1;
        }
        const have = new Set((D.form2Rows || []).map((r) => r[0]).concat((store.form2Own || []).map((o) => o.row)));
        store.form2Own = (store.form2Own || []).concat(pend.own.filter((o) => !have.has(o.row)));
        logChange('відповідність 2/Прод', 'f2map', cnt(n, 'код', 'коди', 'кодів'));
        state.f2pending = null;
        save();
        modalClose();
        return form2Load(f2Year());
      }
      case 'f2-note-add': {
        store.form2Notes = (store.form2Notes || []).concat([{ id: 'n' + Date.now().toString(36), year: f2Year(),
          row: Number(d.row), col: Number(d.col), qty: Number(d.qty), reason: `розбіжність звіту ${f2Year() - 1} з обліком`,
          no: '', date: '' }]);
        save();
        return form2Load(f2Year());
      }
      case 'f2-note-del':
        store.form2Notes = (store.form2Notes || []).filter((n) => n.id !== d.id);
        save();
        return form2Load(f2Year());
      case 'f2-party-all': {
        store.parties = store.parties || {};
        const all = new Map((D.parties || []).map(([n, k]) => [n, k]));
        for (const [n, k] of Object.entries(store.parties)) all.set(n, k);
        for (const [n, k] of all) if (k === 'інше' && partyGuess(n) !== 'інше') store.parties[n] = partyGuess(n);
        save();
        return form2Load(f2Year());
      }
      default: return null;
    }
  }

  /** Заявка на посуд, миючі й серветки на 30 днів за нормами наказу МОУ №390: середні добові видачі
   *  вписує людина, кількості й округлення до упаковки рахує програма, лист — у Word. */
  const OP_REQUEST_NORMS = [['одноразовий посуд', 1, 1000, 'к-т'], ['рідкий миючий засіб', 0.0016, 5, 'кг'],
    ['серветки паперові', 3, 1000, 'шт']];
  function opRequestDialog() {
    const last = (store.ui && store.ui.opRequest) || { perDay: '', to: '' };
    modalOpen('Заявка на 30 днів', `<div class="pad"><div class="form__grid">
      <div class="field"><label>Середні добові видачі, д/д</label><input data-opr="perDay" inputmode="decimal" value="${esc(last.perDay)}"></div>
      <div class="field"><label>Днів</label><input data-opr="days" inputmode="numeric" value="30"></div>
      <div class="field field--span2"><label>Кому</label><input data-opr="to" value="${esc(last.to)}" placeholder="Командиру …"></div></div>
      <div id="opr-calc" style="margin-top:10px"></div>
      <p class="set-note">Норми наказу МОУ №390: набір посуду на добову видачу (п.13), серветки — 3 шт на особу на добу
        (Норма №1), рідкий миючий засіб — 0,16 кг на 100 осіб на добу з одноразовим посудом (Норма №13, прим. 3).</p>
      <div class="set-form__acts"><button type="button" class="btn btn--primary" data-act="op-request-make">Скласти лист</button></div></div>`,
    'modal__box--form');
    const calc = () => {
      const pd = Number(String(($('[data-opr="perDay"]') || {}).value || '').replace(',', '.')) || 0;
      const days = Number(($('[data-opr="days"]') || {}).value) || 30;
      $('#opr-calc').innerHTML = OP_REQUEST_NORMS.map(([n, per, step, u]) => {
        const raw = pd * per * days;
        return `<div class="f2-check">${n}: ${fmtNum(+raw.toFixed(2))} → <b>${fmtNum(Math.ceil(raw / step - 1e-9) * step)}</b> ${u}</div>`;
      }).join('');
    };
    document.querySelectorAll('#modal [data-opr]').forEach((el) => el.addEventListener('input', calc));
    calc();
  }
  function opRequestMake() {
    const v = (k) => String(($(`[data-opr="${k}"]`) || {}).value || '').trim();
    const perDay = Number(v('perDay').replace(',', '.'));
    if (!(perDay > 0)) { toast('Вкажіть середні добові видачі.', true); return; }
    store.ui = store.ui || {};
    store.ui.opRequest = { perDay: v('perDay'), to: v('to') };
    save();
    toExcel({ kind: 'op_request', perDay, days: Number(v('days')) || 30, to: v('to'), date: today(), word: true,
      file: 'Заявка ОП, МЗ, серветки' });
    modalClose();
  }

  /** Звірка книги ОП зі звітом ФЕС «Залишки ТМЦ» (1С): розбіжності по кодах, партії, документи в
   *  дорозі. Позиція ФЕС (код ФЕС + ціна) зіставляється з кодом книги один раз — відповідність
   *  лишається в базі; так само місця ФЕС → підрозділи. Книга результату лягає в теку звірок. */
  async function opFes(file) {
    state.fesFile = file;
    let j = {};
    try {
      await flush();
      const r = await fetch(`api/op-fes?asOf=${state.asOf}`, { method: 'POST', body: file });
      j = await r.json().catch(() => ({}));
    } catch (e) { j = { problems: [String(e.message || e)] }; }
    if (!j.ok) {
      modalOpen('Звіт ФЕС не прочитано', `<div class="pad">${listHtml(j.problems || [j.error || 'помилка'])}</div>`, 'modal__box--form');
      return;
    }
    if (j.download) {
      const a = document.createElement('a');
      a.href = j.download; a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
    }
    opFesDialog(j);
  }
  function opFesDialog(j) {
    const opItems = items.filter((i) => bookOfItem(i) === 'ОП' && !i.archived);
    const places = (store.fesPlaces && typeof store.fesPlaces === 'object') ? store.fesPlaces : {};
    const um = j.unmapped.map((u) => `<div class="f2-check">${esc(u.code)} «${esc(u.name)}» · ${fmtMoney(u.price)} грн
        <select data-fesmap="${esc(u.code)}|${Math.round(u.price * 100)}" aria-label="код книги"><option value="">—</option>
          <option value="-">не з книги ОП</option>${opItems.map((i) => `<option value="${esc(i.code)}">${esc(i.code)} ${esc(i.name)} · ${fmtMoney(i.price)}</option>`).join('')}</select></div>`).join('');
    const pl = (j.places || []).map((name) => `<div class="f2-check">${esc(name)}
        <select data-fesplace="${esc(name)}" aria-label="підрозділ"><option value="">—</option>${subs.filter((sb) => sb.active).map((sb) =>
          `<option${places[name] === sb.name ? ' selected' : ''}>${esc(sb.name)}</option>`).join('')}</select></div>`).join('');
    const rows = j.rows.map((r) => `<div class="tbl__row"><div class="c-code">${esc(r.code)}</div><div class="c-name"><b>${esc(r.name)}</b></div>
        <div class="c-num">${fmtNum(r.fes, '0')}</div><div class="c-num">${fmtNum(r.book, '0')}</div>
        <div class="c-num${Math.abs(r.diff) > 1e-9 ? ' num-bad' : ''}">${fmtNum(r.diff, '0')}</div></div>`).join('');
    const lots = j.batches.filter((b) => b.fes == null || b.book == null || Math.abs(b.fes - b.book) > 1e-9)
      .map((b) => `<div class="f2-check">${esc(b.code)} · ${b.date ? fmtDate(b.date) : '—'} · ${esc(b.doc)} · ФЕС ${b.fes == null ? '—' : fmtNum(b.fes, '0')}
        · облік ${b.book == null ? 'такого приходу немає' : fmtNum(b.book, '0')}</div>`).join('');
    modalOpen(`Звірка ОП з ФЕС на ${fmtDate(j.as_of)}`, `<div class="pad">
      <div class="card card--scroll"><div class="tbl" style="--tbl-min:560px"><div class="tbl__head">
        <div class="tbl__h c-code">код</div><div class="tbl__h c-name">найменування</div><div class="tbl__h c-num">ФЕС</div>
        <div class="tbl__h c-num">облік</div><div class="tbl__h c-num">різниця</div></div>${rows
          || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Позицій книги ОП у звіті ФЕС немає: зіставте їх нижче.</div></div>'}</div></div>
      ${lots ? `<h4>Партії з розбіжністю</h4>${lots}` : ''}
      ${j.pending.length ? `<h4>Не дійшли до ФЕС</h4>${j.pending.map((x) => `<div class="f2-check">№${esc(x.no)} від ${fmtDate(x.date)}
        · ${esc(x.status)} · ${cnt(x.days, 'день', 'дні', 'днів')}</div>`).join('')}` : ''}
      ${um ? `<h4>Позиції ФЕС без відповідності</h4>${um}` : ''}
      ${pl ? `<h4>Місця ФЕС → підрозділи</h4>${pl}` : ''}
      <p class="set-note">Книга результату: ${esc(j.path || '')}</p>
      <div class="set-form__acts"><button type="button" class="btn btn--primary" data-act="fes-map-save">Зберегти відповідність і звірити знову</button></div>
    </div>`, 'modal__box--form');
  }
  async function opFesSave() {
    store.fesMap = Object.assign({}, store.fesMap || {});
    document.querySelectorAll('#modal [data-fesmap]').forEach((el) => {
      if (el.value) store.fesMap[el.dataset.fesmap] = el.value === '-' ? '' : el.value;
    });
    store.fesPlaces = Object.assign({}, store.fesPlaces || {});
    document.querySelectorAll('#modal [data-fesplace]').forEach((el) => {
      if (el.value) store.fesPlaces[el.dataset.fesplace] = el.value; else delete store.fesPlaces[el.dataset.fesplace];
    });
    logChange('звірка з ФЕС', 'fesmap', 'відповідність позицій і місць ФЕС');
    save();
    modalClose();
    if (state.fesFile) await opFes(state.fesFile);
  }

  /** Теки ручного шляху (книга «Облік ОП», звіти, заявки, звірки з ФЕС): порожнє поле — типова
   *  тека в «Дані обліку». Перелік тек дає сервер — інші розділи дописують туди свої. */
  function foldersBody() {
    if (!state.folders) {
      if (!state.foldersLoading) {
        state.foldersLoading = true;
        fetch('api/folders').then((r) => r.json()).then((list) => { state.folders = list; })
          .catch(() => { state.folders = []; })
          .finally(() => { state.foldersLoading = false; if (state.view === 'settings') render(); });
      }
      return '<p class="set-note">Читаю теки…</p>';
    }
    return `<div class="set-form">${state.folders.map((f) => `<div class="field"><label>${esc(f.label)}</label>
        <input data-folder="${esc(f.key)}" value="${esc(f.set ? f.path : '')}" placeholder="${esc(f.default)}"
          title="Повний шлях до теки; порожньо — типова тека"></div>`).join('')}
      <div class="set-form__acts"><button type="button" class="btn" data-act="folders-save">Зберегти теки</button></div></div>`;
  }
  async function foldersSave() {
    const body = {};
    document.querySelectorAll('[data-folder]').forEach((el) => { body[el.dataset.folder] = el.value.trim(); });
    try {
      const r = await fetch('api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
      if (!r.ok) throw new Error(await r.text());
      state.folders = await r.json();
      toast('Теки збережено.');
      render();
    } catch (e) { toast(`Теки не збережено: ${e.message || e}`, true); }
  }

  /** Робота в мережі — лише на основному ПК: увімкнути, код доступу, своє ім'я, порт. */
  function netOpen() {
    if (me.remote || !native) return;
    const n = me.net || {};
    modalOpen('Робота в мережі', `<div class="set-form" id="net-form">
      <label class="set-check"><input type="checkbox" name="on"${n.on ? ' checked' : ''}>
        <span>Дозволити роботу з інших ПК служби</span></label>
      <div class="form__grid">
        <div class="field"><label>Ваше ім’я на цьому ПК</label>
          <input name="host_name" maxlength="40" value="${esc(n.host_name || '')}" autocomplete="off">
          <div class="field__hint">так ваші зміни підписані в журналі змін</div></div>
        <div class="field"><label>Код доступу</label>
          <input name="code" type="password" autocomplete="new-password" placeholder="${n.has_code ? 'без змін' : 'щонайменше 4 знаки'}">
          <div class="field__hint">${n.has_code ? 'новий код — і всі вписують його заново' : 'його вписують на інших ПК разом зі своїм ім’ям'}</div></div>
        <div class="field"><label>Порт</label>
          <input name="port" type="number" min="1024" max="65535" value="${esc(String(n.port || 8770))}">
          <div class="field__hint">зазвичай 8770</div></div>
      </div>
      <p class="set-note">Основний ПК має бути ввімкнений, а програма на ньому — відкрита. Увімкнення, вимкнення
        й новий порт діють після перезапуску програми. Під час першого запуску Windows спитає дозвіл для мережі —
        дозвольте для приватних мереж.</p>
      <div class="set-form__acts"><button type="button" class="btn btn--primary" data-act="net-save">Зберегти</button></div>
    </div>`, 'modal__box--form');
  }

  async function netSave() {
    const f = $('#net-form');
    if (!f) return;
    const field = (name) => f.querySelector(`[name="${name}"]`);
    const was = me.net || {};
    const body = { on: field('on').checked, host_name: field('host_name').value.trim(), code: field('code').value,
      port: Number(field('port').value) || 8770 };
    try {
      const r = await fetch('api/network', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
    } catch (e) {
      toast(`Не вдалося зберегти: ${e.message || e}`, true);
      return;
    }
    await meLoad();
    modalClose();
    render();
    const restart = body.on !== !!was.listening || (body.on && body.port !== was.port);
    toast(restart ? `Збережено. Перезапустіть програму на цьому ПК — тоді робота з інших ПК ${body.on ? 'запрацює' : 'припиниться'}.`
      : 'Збережено.');
  }

  /** Вихід з іншого ПК: перепустка зникає, наступного разу — знову ім'я й код. */
  async function netLogout() {
    if (!confirm('Вийти? Наступного разу програма знову спитає ім’я й код доступу.')) return;
    await flush();
    try { await fetch('api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    sync.leaving = true;
    location.replace('./');
  }

  function applyTheme() {
    document.documentElement.style.setProperty('--accent', state.accent);
    // Атрибут оформлення навмисно зветься інакше, ніж кнопки в панелі. Поки він
    // звався `data-density`, делегований обробник знаходив його на самому
    // <html> — і будь-який клац у програмі відкривав панель оформлення.
    document.documentElement.dataset.rows = state.density;
    document.documentElement.dataset.text = state.textSize || 'normal';
    document.documentElement.dataset.wrap = state.wrap ? '1' : '0';
  }

  // -------------------------------------------------------------------- запуск
  async function boot() {
    await loadState();
    normalizeStore();
    const syncPack = syncTake();
    peopleInit();
    Object.assign(state, {
      accent: store.ui.accent || state.accent,
      density: store.ui.density || state.density,
      textSize: store.ui.textSize || 'normal',
      wrap: !!store.ui.wrap,
    });
    // Чернетки, відкладені в попередньому сеансі: keepDrafts їх записує в
    // store.ui, а тут вони повертаються — без цього вони «зберігалися», але
    // після перезапуску їх ніхто не показував.
    if (store.ui.drafts && typeof store.ui.drafts === 'object') {
      state.drafts = {};
      for (const [k, v] of Object.entries(store.ui.drafts)) {
        if (v && v.head && Array.isArray(v.lines)) state.drafts[k] = JSON.parse(JSON.stringify(v));
      }
      draftsSaved = JSON.stringify(state.drafts);
    }
    mergeOwnItems();
    syncStart(syncPack);
    ledger = buildLedger();
    docs = buildDocs();
    applyPrices();
    allocateLots();
    if (native) document.body.classList.add('is-native');
    if (me.remote) document.body.classList.add('is-remote');
    // Відомість МТЗ: перший місяць, за поданням якого стежить програма, запам'ятовується одразу —
    // інакше після строку він зсунувся б на наступний, і прострочене подання зникло б із контролю.
    if (mtzInit() && !stateBroken) save();
    checkFiles();                              // тихо: результат з'явиться в «Потребує уваги»
    // Незавершені документи з минулого разу — назад у форму.
    const kept = store.ui.drafts || {};
    draftsSaved = JSON.stringify(kept);
    state.drafts = {};
    for (const [k, v] of Object.entries(kept)) {
      if (v && v.lines && v.head) state.drafts[k] = JSON.parse(JSON.stringify(v));   // копія, не спільний об'єкт
    }
    const nKept = Object.keys(state.drafts).length;
    window.addEventListener('beforeunload', (e) => {
      // Чернетка, що чекає на таймер, теж має піти в базу перед закриттям.
      if (sync.leaving) return;               // вікно саме оновлюється: правки відкладено
      clearTimeout(draftTimer);
      keepDrafts();
      if (stateConflict || (!saving.dirty && !saving.busy && !saving.failed)) return;
      flush();
      e.preventDefault();
      e.returnValue = '';
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && saving.dirty) flush();
    });
    syncWatch();
    $('#side-role').textContent = `${unitInfo().legalName}`;
    $('#unit-name').textContent =
      `ТЗ ПС — облік технічних засобів продовольчої служби · ${unitInfo().legalName}`;
    const dateInput = $('#as-of');
    dateInput.value = state.asOf;
    dateInput.addEventListener('change', () => {
      state.asOf = dateInput.value || today();
      dateInput.value = state.asOf;         // порожнє поле не має приховувати дату розрахунку
      balCache.key = null;
      render();
    });
    $('#gear').addEventListener('click', () => (state.view === 'settings' ? goBack('dash') : go('settings')));
    bindGlobal();
    applyTheme();
    try { history.replaceState(navSnap(), ''); } catch (e) { /* ignore */ }
    window.addEventListener('popstate', (e) => {
      if (!e.state || !e.state.view) return;
      pickClose();
      const { idx, ...snap } = e.state;
      Object.assign(state, snap);
      state.restoreScroll = true;
      render();
    });
    render();
    if (stateBroken) {
      saveBar(`База обліку не читається (${stateBroken}), зміни не записуються. `
        + 'Відновіть дані з копії: ⚙ → «Автоматичні копії…».');
    } else if (sync.note) {
      toast(sync.note);
    } else if (nKept && !sync.fresh) {
      const KIND_OF = { in: 'приходу', mv: 'переміщення', wr: 'списання', dz: 'рапорту про знищення' };
      const kinds = Object.keys(state.drafts);
      state.moveKind = kinds.includes(state.moveKind) ? state.moveKind : kinds[0];
      toast(`Відновлено незавершен${nKept > 1 ? 'і чернетки' : 'у чернетку'} `
        + `${kinds.map((k) => KIND_OF[k] || k).join(', ')}. Відкрийте «+ Новий документ».`);
    }
  }

  /** Екран замість програми, коли база не читається. Не спирається ні на що з
   *  модуля, крім $ і esc: усе далі за D не ініціалізувалося. Копії показує з
   *  api/backups, відновлює через api/restore — той самий шлях, що й ⚙. */
  function dataBroken() {
    const draw = async () => {
      let why = '';
      try { const r = await fetch('data.js', { cache: 'no-store' }); if (!r.ok) why = await r.text(); } catch (e) { /* ignore */ }
      let list = [];
      try { list = await fetch('api/backups', { cache: 'no-store' }).then((r) => r.json()); } catch (e) { list = []; }
      const rows = (Array.isArray(list) ? list : []).map((b) => `<div class="tbl__row tbl__row--plain">
        <div class="c-date" style="width:150px"><b>${esc(b.time)}</b></div>
        <div class="c-txt">${b.ok ? esc(`рядків документів: ${b.docs}, знищене: ${b.destroyed}, звірок: ${b.recon}`)
          : `<span class="num-bad">${esc(b.why || 'файл пошкоджено')}</span>`}</div>
        <div class="c-acts" style="flex-basis:120px">${b.ok ? `<button class="btn btn--sm" data-broken-restore="${esc(b.name)}">Відновити</button>` : ''}</div>
      </div>`).join('');
      $('#head').innerHTML = '<div class="head__row"><h1>База обліку не читається</h1></div>';
      $('#scroll').innerHTML = `<div class="panel">
        <div class="panel__note num-bad">${esc(why || 'файл бази пошкоджено')}</div>
        <p>Облік лишився в копіях. Оберіть копію нижче — пошкоджений файл програма відкладе в теку «Дані обліку/копії»
        з поміткою «пошкоджено», а обрана копія стане робочою базою.</p>
        <p>Якщо копій тут немає, вони є в теці <b>%LOCALAPPDATA%\\OblikTZPS\\копії</b> або на флешці:
        <label class="btn btn--sm">Відновити з файла… <input type="file" accept=".sqlite" hidden data-broken-file></label></p>
      </div>
      <div class="tbl" style="--tbl-min:720px">${rows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Копій у теці даних немає.</div></div>'}</div>`;
    };
    const post = async (url, body, what) => {
      if (!confirm(`Відновити облік із копії «${what}»?\n\nПошкоджений файл буде відкладено в теку копій.`)) return;
      try {
        const r = await fetch(url, { method: 'POST', body });
        if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
        location.reload();
      } catch (e) { alert(`Не вдалося відновити: ${e.message}`); }
    };
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-broken-restore]');
      if (b) post('api/restore', JSON.stringify({ name: b.dataset.brokenRestore }), b.dataset.brokenRestore);
    });
    document.addEventListener('change', (e) => {
      const inp = e.target.closest('[data-broken-file]');
      if (inp && inp.files[0]) post('api/restore-file', inp.files[0], inp.files[0].name);
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw);
    else draw();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
