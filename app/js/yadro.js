/* Облік ТЗ ПС — десктоп-застосунок над даними «Облік ТЗ 4.0».
 *
 * Розрахункове ядро повторює модель книги: три журнали документів зводяться
 * в один нормалізований реєстр проводок (одна сторона операції = один рядок),
 * а будь-який залишок — це сума проводок по коду й підрозділу до заданої дати.
 * Нічого не зберігається як «поточний залишок», тому цифри завжди відповідають
 * документам. Знищене майно числиться в обліку, доки не проведено акт списання.
 */
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';


  const D = window.OBLIK_DATA;
  const LS = 'oblik-tz-ps-v1';

  // ------------------------------------------------------------------ утиліти
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtDate = (iso) => (iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '—');
  const fmtNum = (n, dash = '—') => (n === 0 || n == null ? dash : String(+(+n).toFixed(3)));
  /** Норма на д/д — до шести знаків: 0,0016 кг миючого на особу `fmtNum` округлив би до 0,002. */
  const fmtNorm = (n, dash = '—') => (n === 0 || n == null || n === '' ? dash : String(+(+n).toFixed(6)));
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

  // База не читається (пошкоджений файл): сервер віддає дані порожньої бази з причиною в meta.broken —
  // модулі вантажаться, а замість програми екран із поясненням і копіями для відновлення (boot не йде).
  // data.js не прийшов зовсім — той самий екран і зупинка тут: спільного `return` між модулями немає.
  if (!D || (D.meta || {}).broken) { dataBroken(); if (!D) throw new Error('data.js не завантажився'); }

  /** Екран замість програми, коли база не читається. Не спирається ні на що з
   *  модуля, крім $ і esc: усе далі за D не ініціалізувалося. Копії показує з
   *  api/backups, відновлює через api/restore — той самий шлях, що й «Налаштування». */
  function dataBroken() {
    const draw = async () => {
      let why = (D && (D.meta || {}).broken) || '';
      if (!why) try { const r = await fetch('data.js', { cache: 'no-store' }); if (!r.ok) why = await r.text(); } catch (e) { /* ignore */ }
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

  // --------------------------------------------------------------- модель даних
  // Номенклатура — з бази цілком: і те, що прийшло з паперів служби, і те, що
  // завели в програмі (`own` — щоб картка дозволяла правити саме своє).
  const items = D.items.map((r) => ({
    code: r[0], name: r[1], group: r[2], unit: r[3], price: r[4],
    cat: r[5], serial: r[6], chassis: r[7], year: r[8], nonrev: r[9], own: !!r[10], fes: r[11] || '',
    note: r[12] || '', old: r[13] || '', archived: r[14] || '', perRation: r[15] ?? null, normLine: r[16] || '', kind1: r[17] || '',
  }));
  /** Рядок норми наказу 390 за ключем (op_norms.PER_RATION): [ключ, назва, одиниця, норма на д/д, підстава, група] чи null. */
  const opNormLine = (key) => (key ? ((D.opNorms || {}).perRation || []).find((r) => r[0] === key) || null : null);
  /** Рядки наказу 390 групи й одиниці позиції ОП, чиє число збігається з нормою на д/д (як op_norms.line_state: група, одиниця й
   *  число). Рядка не вибрано, а їх два й більше (тарілка мілка, десертна, виделка й стакан — по 3 шт), — акт такої позиції не бере
   *  (R60). Число округлюється до шести знаків, як per_milli на сервері. */
  const normLinesFit = (group, unit, per) => {
    const p = Math.round(per * 1e6) / 1e6;
    return p > 0 ? ((D.opNorms || {}).perRation || []).filter((r) => r[5] === group && r[2] === unit && Math.abs(r[3] - p) < 1e-9) : [];
  };
  /** Під нормою в картці позиції ОП: який рядок норми наказу 390 вибрано (за ним акт ділить межу між кодами); не вибрано, а число
   *  є в кількох рядках групи, — «Оберіть рядок норми». `at` — що в картці зараз: { group, unit, per }. */
  const normLineHint = (key, at) => {
    const l = opNormLine(key);
    if (l) return `рядок норми: ${l[1]}`;
    return at && normLinesFit(at.group, at.unit, at.per).length > 1 ? 'Оберіть рядок норми' : 'рядок норми не вибрано';
  };
  const itemBy = new Map(items.map((i) => [i.code, i]));
  const groupName = new Map(D.groups);

  // КНИГИ ОБЛІКУ: ПОЧАТОК
  /** Чотири книги обліку: ТЗ (техзасоби, обладнання, багаторазовий посуд), ОП (посуд одноразового
   *  використання, миючі засоби, серветки), СП (сухі пайки, продукти ПК, тара, тютюн) і РП (реторт-пакети,
   *  облік неофіційний). Позиція належить книзі своєї групи; «Позиції», «Документи» й книги № 47/14
   *  показують книгу `state.book`. */
  const BOOK_OF_GROUP = new Map((D.groups || []).map((g) => [g[0], g[2] || 'ТЗ']));
  const bookOfItem = (it) => (it && BOOK_OF_GROUP.get(it.group)) || 'ТЗ';
  const bookOf = (code) => bookOfItem(itemBy.get(String(code)));
  /** Чернетки документів — свої в кожної книги: прихід ТЗ і прихід сухпаю не змішуються. */
  const slotOf = (kind, book) => (book && book !== 'ТЗ' ? kind + '@' + book : kind);
  /** Книги СП і РП: слова, шляхи й поля, яких немає в ТЗ і ОП. `types` — вид рядка звіту 1/прод (колонка
   *  «тип» книги) — той самий перелік, що book_xlsx.SP.types / RP.types на сервері; `best` — «придатний
   *  до» в рядку приходу, `q1` — квартал звіту 1/прод у рядку списання; `perRation` — дободач позиції. */
  const BOOKS = {
    'СП': { slug: 'sp', label: 'Сухпай', crumb: 'сухпай', of: 'сухпаю', file: 'Облік СП', codeBase: 7000, group: 'СП.1',
            title: 'Сухі пайки, продукти ПК, тара й тютюнові вироби', items: 'Позицій сухпаю ще немає',
            docs: 'Документів сухпаю ще немає', perRation: true, best: true, q1: true, typeLabel: 'Вид у звіті 1/прод',
            types: ['ПНСП', 'ПНСП-Р', 'ДПНП', 'ДПНП-Р', 'іноземні добові', 'іноземні раціони', 'тара'] },
    'РП': { slug: 'rp', label: 'Реторт-пакети', crumb: 'реторт-пакети', of: 'реторт-пакетів', file: 'Облік РП',
            codeBase: 20000, group: 'РП.1', title: 'Реторт-пакети', items: 'Позицій реторт-пакетів ще немає',
            docs: 'Документів реторт-пакетів ще немає', perRation: false, best: false, q1: false, unofficial: true,
            typeLabel: 'Тип', types: ['реторт-пакети'] },
  };
  /** Книга СП чи РП: їхні екрани — гілка поруч з екранами ТЗ і ОП. */
  const isSpRp = (book) => Object.prototype.hasOwnProperty.call(BOOKS, book);
  /** Дободач текстом для поля й картки: ціле — «1»; дріб зі знаменником 2, 3, 4 чи 6 — «1/3», «1/2» (0.5), «3/2» (1.5); решта —
   *  десятковим числом до шести знаків, як рахує сервер. Значення, показане в полі й записане назад без правки, не міняється:
   *  дріб береться лише для числа, що є ним з точністю до 1e-9 (так книга пише «=1/3»), а не «майже» — 0.333334 лишається 0.333334.
   *  Нуль і від'ємне число (так лежало в базі чи книзі) — не дободач: поле порожнє, щоб позицію можна було записати знову, а картка каже «—». */
  function rationText(x) {
    if (x == null || x === '') return '';
    const n = Number(x);
    if (!Number.isFinite(n) || n <= 0) return '';
    for (const den of [2, 3, 4, 6]) {
      const num = Math.round(n * den);
      if (Math.abs(n % 1) > 1e-9 && num && Math.abs(num / den - n) < 1e-9) return `${num}/${den}`;
    }
    const rounded = +n.toFixed(6);
    return rounded > 0 ? String(rounded) : '';
  }
  /** Дободач із поля: «1/3», «0,5», «1»; порожньо — null; що не число («abc», «1 1/2», «1/3/2») — NaN, «1/0» — Infinity
   *  (такий дободач відхиляє `perRationBad`). */
  function rationOf(s) {
    const t = String(s ?? '').trim().replace(',', '.');
    if (!t) return null;
    const m = t.match(/^(\d+)\s*\/\s*(\d+)$/);
    return m ? +m[1] / +m[2] : +t;
  }
  /** У полі «Дободач» уписано не число й не дріб більше нуля («abc», «1/0», «0», «-1»): такий дободач у запис не йде — NaN й
   *  Infinity у JSON стали б null, і поле стерлося б мовчки. Порожнє поле — дободача немає, а не помилка. */
  function perRationBad(text) {
    const n = rationOf(text);
    return n != null && !(Number.isFinite(n) && n > 0);
  }
  /** Слово про книгу в підписах чернеток: ТЗ — без слова, ОП — «(посуд і миючі)», будь-яка інша книга — її назва в дужках. */
  const BOOK_WORD = { 'ОП': 'посуд і миючі' };
  const bookWord = (book) => (book && book !== 'ТЗ' ? ` (${BOOK_WORD[book] || book})` : '');
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
  /** Де документ у ФЕС: той самий перелік, що state_db.FES_STATUSES, — для документів чотирьох книг. */
  const FES_STATUSES = ['немає витяга', 'роздрукувати', 'на підписі', 'їде на ФЕС', 'проведено', 'переробка'];
  /** Те саме для документів закупівель: їхня таблиця знає п'ять станів (purchases_db.PUR_FES_STATUSES), «роздрукувати» —
   *  лише документів книг. */
  const PUR_FES_STATUSES = FES_STATUSES.filter((s) => s !== 'роздрукувати');
  // ЗАКУПІВЛІ: ПОЧАТОК — чисті функції закупівель (їх перевіряють окремо, у node).
  /** Види руху рядка коштів, фонди, документи закупівлі, правила ціни, стани справи. */
  const PUR_MOVE_KINDS = ['затверджено', 'зміна', 'профінансовано', 'повернуто'];
  const PUR_FUNDS = ['10% ПДФО', 'Загальний фонд', 'Субвенція', 'Спецфонд (інші кошти)', 'Благодійні кошти'];
  const PUR_DOC_KINDS = ['договір', 'ВН', 'рахунок', 'довіреність', 'оплата', 'акт введення', 'інше'];
  const PUR_RULES = ['середня', 'КП', 'вручну'];
  const PUR_STATES = ['розрахунки', 'подано', 'не погоджено', 'погоджено', 'договір', 'поставка', 'на ФЕС',
    'проведено', 'видано', 'завершено', 'скасовано'];
  /** Джерело відомості МТЗ за фондом рядка коштів (інших фондів відомість не має). */
  const MTZ_SRC_OF_PUR = { '10% ПДФО': 'ПДФО', 'Субвенція': 'С', 'Благодійні кошти': 'БД' };
  /** Слова 9/фс і супроводу про фонд. */
  const PUR_PHRASE = { '10% ПДФО': 'за рахунок 10% ПДФО', 'Субвенція': 'за рахунок субвенції',
    'Спецфонд (інші кошти)': 'за спеціальним фондом', 'Загальний фонд': 'за загальним фондом' };
  const PUR_LIMIT_KOP = 2000000;            // 20 000 грн за одиницю: від неї — 3110/040, дешевше — 2210/030

  // Гроші — цілі копійки, а рахунок — цілими числами (BigInt): сторінка, книга й папери збігаються до копійки
  // (`line_kop` у desktop/purchases_book.py). `Math.round(x * 100)` і добуток у double на половинах розходилися б
  // з ними: 1,005 * 100 — це 100,49999999999999, а `Math.round(-0.5)` — це -0.
  /** n / d до цілого, найближче; половина — від нуля. Дільник d ненульовий: ділення BigInt на 0n кидає RangeError. */
  const divRound = (n, d) => {
    const a = n < 0n ? -n : n, b = d < 0n ? -d : d;
    const r = (2n * a + b) / (2n * b);
    return (n < 0n) !== (d < 0n) ? -r : r;
  };
  /** Ціле число копійок (чи тисячних) → BigInt; дробове відкидається, не число й нескінченність — 0. */
  const bigKop = (x) => {
    const n = Math.trunc(+x);
    return Number.isFinite(n) ? BigInt(n) : 0n;
  };
  /** Запис числа з експонентою («1e3», «-1,5E2», «.5e1», «2E2 грн»): одиниця в кінці дозволена, як і в десяткового. */
  const KOP_EXP = /^[+-]?(\d+\.?\d*|\.\d+)e[+-]?\d+\D*$/i;
  /** «12 345,67», «,5», «12,5 грн», «1.005₴» чи 12345.67 → копійки; null — це не число. Десяткове число (з одиницею в
   *  кінці чи без) округлюється до копійки точно, за цифрами тексту (половина — від нуля); запис з експонентою («1e3») —
   *  через float. Усе інше — не число, і з нього не береться числовий початок: «1,234.56», «12 грн 50 коп», «5м2», «12.5.6»
   *  не дають ні 1,23, ні 12, ні 5, ні 12,5 грн (хибна сума гірша за відсутню). Теж null: порожнє, текст без цифр,
   *  нескінченність і число, що не вміщується в double. */
  const kopParse = (v) => {
    const s = String(v ?? '').replace(/\s/g, '').replace(',', '.');                // \s забирає й нерозривні пробіли
    // знак, цифри з крапкою (і «.5», і «5.»), далі лише не цифри: одиниця; цифра після числа (e3, друга крапка) — не одиниця
    const m = /^([+-]?)(\d*)(?:\.(\d+))?\D*$/.exec(s);
    let kop = null;
    if (m && /\d/.test(s)) {
      const frac = m[3] || '';
      const up = frac.length > 2 && frac[2] >= '5';                                // третя цифра від 5: від половини копійки
      const mag = BigInt(m[2] + (frac + '00').slice(0, 2)) + (up ? 1n : 0n);      // ціла частина може бути порожньою («.5»)
      kop = Number(m[1] === '-' ? -mag : mag);
    } else if (KOP_EXP.test(s)) {
      const x = parseFloat(s);
      kop = Math.sign(x) * Math.round(Math.abs(x) * 100);
    }
    return Number.isFinite(kop) ? kop || 0 : null;                                  // «|| 0»: мінус нуль назовні не виходить
  };
  /** Копійки з тексту чи числа; що не число — нуль (поля сум перед цим питають `kopParse`). */
  const kopOf = (v) => kopParse(v) ?? 0;
  /** Копійки → «1234.56» для поля вводу: цілі числа, без double (його `kopParse` читає назад до копійки). */
  const kopStr = (kop) => {
    const n = Math.trunc(+kop || 0), a = Math.abs(n), r = a % 100;
    return `${n < 0 ? '-' : ''}${(a - r) / 100}.${String(r).padStart(2, '0')}`;
  };
  /** Копійки (число чи BigInt) → гривні для слова: «9 876,50» (нерозривний пробіл між тисячами, кома); цілими числами, без double. */
  const kopGrn = (kop) => {
    const n = typeof kop === 'bigint' ? kop : bigKop(kop), a = n < 0n ? -n : n;
    return `${n < 0n ? '-' : ''}${String(a / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')},${String(a % 100n).padStart(2, '0')}`;
  };
  /** Сума рядка: кількість (до трьох знаків) × ціна в копійках, одне округлення до копійки (половина — від нуля). */
  const lineKop = (qty, priceKop) => {
    const q = +qty || 0;
    const qm = Math.sign(q) * Math.round(Math.abs(q) * 1000);                       // кількість у тисячних
    return Number(divRound(bigKop(qm) * bigKop(priceKop), 1000n));
  };
  /** Середня додатних цін, округлена до копійки (половина — вгору): цілі сума й ділення. */
  const avgKop = (list) => {
    const xs = list.map((x) => +x).filter((x) => Number.isFinite(x) && x > 0).map(bigKop);
    return xs.length ? Number(divRound(xs.reduce((s, x) => s + x, 0n), BigInt(xs.length))) : 0;
  };
  /** Ціна позиції за її правилом: середня трьох посилань, ціна комерційної пропозиції або вписана. */
  function posPrice(p) {
    const offers = p.offers || [];
    if (p.rule === 'середня') return avgKop(offers.filter((o) => o.kind === 'посилання').map((o) => +o.priceKop || 0));
    if (p.rule === 'КП') {
      const kp = offers.find((o) => o.kind === 'КП' && +o.priceKop > 0);
      return kp ? +kp.priceKop : 0;
    }
    return +p.priceKop || 0;
  }
  const posKop = (p) => lineKop(p.qty, p.priceKop);
  const verKop = (v) => ((v && v.positions) || []).reduce((s, p) => s + posKop(p), 0);
  const kekvFor = (priceKop) => (priceKop >= PUR_LIMIT_KOP ? { kekv: '3110', exp: '040' } : { kekv: '2210', exp: '030' });
  /** Ціна позиції, з якою разом дорівнює цілі; rest — що лишається, коли рівно не виходить. Береться найбільша ціна, з якою сума
   *  рядка (округлена до копійки, половина — від нуля) не перевищує решти: floor((ціна·к-сть + 500) / 1000) ≤ left, тобто
   *  ціна·к-сть ≤ 1000·left + 499 (к-сть у тисячних). Ціна без округлення суми в розрахунку промахувалась би: на 1,00 грн при 0,7 вона
   *  давала 1,42 і «лишилось 0,01», хоч 1,43 × 0,7 = 1,001, тобто 1,00 рівно. Ділення цілими числами: у double 7 ÷ 0,07 дає 99,999… */
  function fitPrice(targetKop, othersKop, qty) {
    const q = +qty || 0;
    const diff = (+targetKop || 0) - (+othersKop || 0);
    const left = Number.isFinite(diff) ? Math.round(diff) : 0;
    const qm = bigKop(Math.round(q * 1000));
    if (qm <= 0n) return { priceKop: 0, rest: left };
    const priceKop = left > 0 ? Number((BigInt(left) * 1000n + 499n) / qm) : 0;
    return { priceKop, rest: left - lineKop(q, priceKop) };
  }
  /** Остання версія або остання погоджена. */
  function purVersion(pu, which = 'last') {
    const vs = (pu && pu.versions) || [];
    if (which === 'approved') return vs.filter((v) => v.answer === 'погоджено').pop() || null;
    return vs[vs.length - 1] || null;
  }
  /** Ті самі пропорції на іншу суму. Рахує цілими числами: `kop * частка / разом` у double на сумах у трильйони
   *  копійок розходиться з книгою на копійку, а `Math.round` половину мінуса округлює до нуля. Залишок округлення бере
   *  остання частка з вагою (того ж знаку, що й сума ваг): частка без ваги лишається нулем, а не мінусом. */
  function scaleParts(parts, kop) {
    if (!parts.length) return [];
    const weight = parts.map((p) => bigKop(p.kop));
    const total = weight.reduce((s, w) => s + w, 0n);
    if (total === 0n) return [{ line: parts[0].line, kop }];
    const whole = bigKop(kop);
    const sign = total > 0n ? 1n : -1n;
    let last = parts.length - 1;
    while (weight[last] * sign <= 0n) last--;                       // сума ваг не нуль, тож така частка є
    let left = whole;
    const out = parts.map((p, i) => {
      if (i === last) return null;
      const k = divRound(whole * weight[i], total);
      left -= k;
      return { line: p.line, kop: Number(k) };
    });
    out[last] = { line: parts[last].line, kop: Number(left) };
    return out;
  }
  const purAt = (ctx, id) => ctx.purchases.find((p) => p.id === id) || null;
  const purDocAt = (ctx, id) => ctx.purDocs.find((d) => d.id === id) || null;
  /** Частки документа між рядками коштів: свої; без них — як у документа-основи (ВН — як договір);
   *  без основи — цілим до єдиного рядка закупівлі; інакше — не віднесено. */
  function docParts(doc, ctx, depth = 0) {
    const own = (doc.parts || []).filter((p) => p && p.line);
    if (own.length) return own.map((p) => ({ line: p.line, kop: +p.kop || 0 }));
    const up = doc.parent && depth < 4 ? purDocAt(ctx, doc.parent) : null;
    if (up && up.id !== doc.id) {
      const pp = docParts(up, ctx, depth + 1);
      if (pp.length) return scaleParts(pp, +doc.kop || 0);
    }
    const pu = purAt(ctx, doc.purchase);
    const lines = pu ? (pu.funds || []).map((f) => f.line) : [];
    return lines.length === 1 ? [{ line: lines[0], kop: +doc.kop || 0 }] : [];
  }
  /** Перед другим рядком коштів закупівлі. Документ, чий ланцюг основ не має часток, йде до її рядка цілим лише тому, що рядок
   *  один (`docParts`); з другим рядком він не йшов би нікуди, і договір чи оплата випали б із «Коштів». Такий документ закупівлі із
   *  сумою більшою за нуль дістає цю частку своєю, `parts: [{ line, kop }]`, — серед тих, чиї гроші «Кошти» беруть або під якими такі
   *  стоять (договір, ВН, рахунок, оплата); акт введення й довіреність «Кошти» не рахують. Основи йдуть раніше за документи під
   *  ними, і частка пишеться одразу: документ під щойно записаною основою бере частки від неї й далі (розклад договору потім
   *  розкладе й ВН з оплатою), тож своєї не дістає. Свою дістає лише той, чий ланцюг доходить до єдиного рядка, — корінь, документ під
   *  основою без суми чи під основою з іншої закупівлі без часток. Порівняння з тією самою закупівлею без рядків знаходить саме їх.
   *  Записує частки й повертає змінені документи. */
  function purFreezeParts(pu, ctx) {
    if (!pu || (pu.funds || []).length !== 1) return [];
    const bare = Object.assign({}, ctx, { purchases: ctx.purchases.map((p) => (p.id === pu.id ? Object.assign({}, p, { funds: [] }) : p)) });
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const money = ['договір', 'ВН', 'рахунок', 'оплата'];
    const depth = (d) => {                                        // скільки основ над документом; кільце в даних обмежене
      let n = 0;
      for (let up = purDocAt(ctx, d.parent); up && n < 8; up = purDocAt(ctx, up.parent)) n++;
      return n;
    };
    const out = [];
    const list = ctx.purDocs.filter((d) => d.purchase === pu.id && money.includes(d.kind) && +d.kop > 0);
    for (const d of list.map((x) => [depth(x), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1])) {
      const parts = docParts(d, ctx);
      if (parts.length && !same(parts, docParts(d, bare))) {
        d.parts = parts;
        out.push(d);
      }
    }
    return out;
  }
  /** Що станеться з частками документів закупівлі, коли з неї прибирають рядок коштів `line`. Лишається рівно один рядок — документи,
   *  уся сума яких лежить однією часткою на прибраному (так її записує `purFreezeParts`), переходять на нього: `move`, їхні частки
   *  знімаються. Розклад на кілька рядків із часткою на прибраному програма сама не вирішить, як і одну частку на ньому, коли рядків
   *  лишається кілька чи жодного: `stuck` — їх називають у питанні, частки лишаються. `to` — рядок, на який переходять. Нічого не змінює. */
  function purLineDrop(pu, ctx, line) {
    const rest = ((pu && pu.funds) || []).filter((f) => f.line !== line);
    const own = (d) => (d.parts || []).filter((p) => p && p.line);
    const hit = ctx.purDocs.filter((d) => pu && d.purchase === pu.id && own(d).some((p) => p.line === line));
    if (rest.length !== 1) return { move: [], stuck: hit, to: '' };
    return { move: hit.filter((d) => own(d).length === 1), stuck: hit.filter((d) => own(d).length > 1), to: rest[0].line };
  }
  /** Акт приймання, з яким пов'язано документ: за id, а поки його немає — за ключем документа. */
  const rcptId = (link, ctx) => (link && link.doc && ctx.rcpt.has(link.doc) ? link.doc
    : (link && ctx.rcptByKey.get(link.key)) || 0);
  /** Вартість актів приймання за документами закупівель, що на них посилаються (у пропорції їхніх
   *  сум), далі — за частками кожного документа між рядками коштів. Акт введення не береться: він не поставка, а папір після неї
   *  (як і в `purRcptText`), і його частка йшла б в «нікуди». */
  function rcptShares(ctx) {
    if (ctx.shares) return ctx.shares;
    const by = new Map();
    for (const d of ctx.purDocs) {
      if (d.kind === 'акт введення') continue;
      for (const link of d.receipts || []) {
        const id = rcptId(link, ctx);
        if (!id) continue;
        if (!by.has(id)) by.set(id, []);
        if (!by.get(id).includes(d)) by.get(id).push(d);
      }
    }
    const out = [];
    for (const [rid, list] of by) {
      const r = ctx.rcpt.get(rid);
      if (!r) continue;
      for (const s of scaleParts(list.map((d) => ({ line: d.id, kop: +d.kop || 1 })), r.kop)) {
        const d = list.find((x) => x.id === s.line);
        const parts = docParts(d, ctx);
        for (const p of parts.length ? scaleParts(parts, s.kop) : [{ line: '', kop: s.kop }]) {
          out.push({ rid, doc: d.id, purchase: d.purchase, line: p.line, kop: p.kop });
        }
      }
    }
    ctx.shares = out;
    return out;
  }
  const pct = (a, b) => (b ? Math.round(a / b * 10000) / 100 : 0);
  /** Показники рядка коштів за формулами штабу, у копійках. */
  function budNums(line, ctx) {
    const mv = (k) => (line.moves || []).filter((m) => m.kind === k).reduce((s, m) => s + (+m.kop || 0), 0);
    const approved = mv('затверджено') + mv('зміна');
    const financed = mv('профінансовано') - mv('повернуто');
    const onLine = (d) => docParts(d, ctx).filter((p) => p.line === line.id).reduce((s, p) => s + p.kop, 0);
    const kinds = (k) => ctx.purDocs.filter((d) => d.kind === k).reduce((s, d) => s + onLine(d), 0);
    const committed = kinds('договір');
    const used = kinds('оплата');
    const delivered = rcptShares(ctx).filter((x) => x.line === line.id).reduce((s, x) => s + x.kop, 0);
    let planned = 0;
    for (const pu of ctx.purchases) {
      if (pu.closed === 'скасовано') continue;
      const cons = ctx.purDocs.filter((d) => d.purchase === pu.id && d.kind === 'договір');
      planned += cons.length ? cons.reduce((s, d) => s + onLine(d), 0)
        : (pu.funds || []).filter((f) => f.line === line.id).reduce((s, f) => s + (+f.kop || 0), 0);
    }
    return { approved, financed, committed, used, delivered, planned, unplanned: approved - planned,
      budgetLeft: approved - committed, noContract: financed - committed, cashLeft: financed - used,
      pctTaken: pct(committed, approved), pctFin: pct(committed, financed), pctUsed: pct(used, financed),
      toReturn: line.fund === 'Субвенція' ? Math.max(0, financed - used) : 0 };
  }
  /** Суми справи: гроші, пакет (погоджена або остання версія), договори, поставлено, оплачено, економія. */
  function purNums(pu, ctx) {
    const docsOf = ctx.purDocs.filter((d) => d.purchase === pu.id);
    const sum = (k) => docsOf.filter((d) => d.kind === k).reduce((s, d) => s + (+d.kop || 0), 0);
    const v = purVersion(pu, 'approved') || purVersion(pu);
    const pack = v ? verKop(v) : 0;
    const contracts = sum('договір');
    return { funds: (pu.funds || []).reduce((s, f) => s + (+f.kop || 0), 0), pack, contracts,
      delivered: rcptShares(ctx).filter((x) => x.purchase === pu.id).reduce((s, x) => s + x.kop, 0),
      paid: sum('оплата'), economy: contracts ? pack - contracts : 0 };
  }
  const purRcpts = (pu, ctx) => [...new Set(ctx.purDocs.filter((d) => d.purchase === pu.id)
    .flatMap((d) => (d.receipts || []).map((l) => rcptId(l, ctx)).filter(Boolean)))];
  /** Версію подано, коли в неї є вихідний № чи відповідь штабу: відповідь без № (книга, історія, форма) — теж подана. */
  const verSent = (v) => !!(v && (v.sentNo || v.answer));
  /** Стан справи одним словом — за найдальшим етапом. */
  function purState(pu, ctx) {
    if (pu.closed) return pu.closed;
    const rids = purRcpts(pu, ctx);
    if (rids.length) {
      const st = rids.map((id) => (ctx.rcpt.get(id) || {}).fes || '');
      if (st.every((s) => s === 'проведено')) {
        const issued = rids.some((id) => {
          const r = ctx.rcpt.get(id);
          return r && (ctx.moves || []).some((m) => m.from === r.to && m.d >= r.d && (r.lines || []).some((l) => l.code === m.code));
        });
        return issued ? 'видано' : 'проведено';
      }
      return st.every((s) => s === 'їде на ФЕС' || s === 'проведено') ? 'на ФЕС' : 'поставка';
    }
    if (ctx.purDocs.some((d) => d.purchase === pu.id && d.kind === 'договір')) return 'договір';
    const v = purVersion(pu);
    if (!v || !verSent(v)) return 'розрахунки';
    if (v.answer === 'погоджено') return 'погоджено';
    return v.answer === 'не погоджено' ? 'не погоджено' : 'подано';
  }
  /** Наступний номер акта приймання: лічильник року спільний для «БД» і «С». */
  function nextAp(nos, year, letter) {
    const yy = String(year).slice(2);
    let max = 0;
    for (const no of nos) {
      const m = String(no).trim().match(/^АП(\d\d)-(?:БД|С)-(\d+)$/);
      if (m && m[1] === yy) max = Math.max(max, +m[2]);
    }
    return `АП${yy}-${letter}-${String(max + 1).padStart(3, '0')}`;
  }
  /** Номер акта введення — номер його акта приймання, якщо ним ще не названо інший акт; інакше й без акта приймання з таким номером —
   *  наступний вільний за рік: два акти з одним номером ділили б одну назву файла. */
  function avNo(apNo, year, nos) {
    const m = String(apNo || '').trim().match(/^АП(\d\d)-(?:БД|С)-(\d+)$/);
    const taken = (no) => nos.some((x) => String(x).trim().toLowerCase() === no.toLowerCase());
    if (m && !taken(`АВ${m[1]}-${m[2]}`)) return `АВ${m[1]}-${m[2]}`;
    const yy = m ? m[1] : String(year).slice(2);
    let max = 0;
    for (const no of nos) {
      const x = String(no).trim().match(/^АВ(\d\d)-(\d+)$/i);
      if (x && x[1] === yy) max = Math.max(max, +x[2]);
    }
    return `АВ${yy}-${String(max + 1).padStart(3, '0')}`;
  }
  const apLetter = (fund) => (fund === 'Субвенція' ? 'С' : 'БД');
  const kpkvShort = (kpkv) => String(kpkv || '').split('/').slice(0, 2).join('/');
  const NAME_LIMIT = 80;          // довжина частини шляху: стільки лишає `launcher` у теці скану (папери — до 120, `safe_name`)
  const NAME_EDGES = /^[ .]+|[ .]+$/g;
  // Дата в імені, як її впізнає сервер: `\b` у Python — межа за літерою чи цифрою будь-якої писемності.
  const ISO_IN_NAME = /(?<![\p{L}\p{N}_])(\p{Nd}{4})-(\p{Nd}{2})-(\p{Nd}{2})(?![\p{L}\p{N}_])/gu;
  /** Ім'я файла чи теки, яке сервер не змінює: воно стале щодо обох його чисток — `purchase_papers._part` (через
   *  `excel_export.safe_name`) і чистки частин шляху скану в `launcher`. Знаки, яких не терпить Windows (`\ / : * ? " < > |`,
   *  `[` `]`), і знаки керування → «-»; пробіли — по одному; пробіли й крапки з країв геть; дата рррр-мм-дд → дд.мм.рррр;
   *  не довше за NAME_LIMIT знаків, після зрізу краї чистяться знову; порожнє → «вивантаження», як у `safe_name`.
   *  Необов'язкову частину довшого імені (контрагент, номер, назва рядка) беруть через `safePart`: порожня лишається
   *  порожньою, а не стає словом «вивантаження» посеред назви документа. */
  const safePart = (name) => {
    let s = String(name || '').replace(/[\\/:*?"<>|[\]\x00-\x1f\x7f]+/g, '-').replace(/\s+/g, ' ');
    for (let prev = null; prev !== s;) {          // дата, зріз і краї дають одне одному роботу (зріз відкриває дату чи край): до сталого
      prev = s;
      s = s.replace(ISO_IN_NAME, '$3.$2.$1').replace(NAME_EDGES, '');
      s = [...s].slice(0, NAME_LIMIT).join('');
    }
    return s;
  };
  const safeFile = (name) => safePart(name) || 'вивантаження';
  /** Тека справи відносно кореня «Закупівлі»: її власна (`folder`) або, коли її не записано (справа з рядка книги без «теки»),
   *  «рік/тема», очищена так, як чистить сервер, — туди ляже й перший файл справи, і саме її відкриває «Відкрити теку». */
  const purDirOf = (pu) => pu.folder || [pu.year, safePart(pu.title)].filter(Boolean).join('/');
  /** Днів від a до b (обидві — рррр-мм-дд): додатне, коли b пізніше; те саме, що `daysBetween` нижче, але тут — для
   *  чистих функцій, які перевіряють окремо. */
  const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  /** «з закупівлі <тема>, договір №…, ВН №…» за приходом; прихід не з закупівлі — порожньо. По одній частині на закупівлю (у порядку
   *  документів), договір названо раз, ВН — кожна; акт введення сюди не входить: він не поставка, а папір після неї. */
  function purRcptText(docId, ctx) {
    const links = ctx.purDocs.filter((d) => d.kind !== 'акт введення' && (d.receipts || []).some((l) => rcptId(l, ctx) === docId));
    const out = [];
    for (const pid of [...new Set(links.map((d) => d.purchase).filter(Boolean))]) {
      const pu = purAt(ctx, pid);
      if (!pu) continue;
      const mine = links.filter((d) => d.purchase === pid);
      const cons = [...new Set(mine.map((d) => (d.kind === 'договір' ? d : purDocAt(ctx, d.parent))).filter((d) => d && d.kind === 'договір'))];
      const vns = mine.filter((d) => d.kind === 'ВН');
      out.push([`з закупівлі ${pu.title}`, ...cons.map((d) => `договір №${d.no || 'б/н'}`), ...vns.map((d) => `ВН №${d.no || 'б/н'}`)].join(', '));
    }
    return out.join('; ');
  }
  /** Реєстр на ФЕС: за скільки днів до дати реєстру документ без статусу ще вважається свіжим. Статуси ФЕС з'явилися в програмі пізніше за
   *  облік, тож документи від його початку жодного не мають: без межі реєстр пропонував би їх усі. Свіжі пропонуються без позначки,
   *  старші ховає кнопка «Показати старші». */
  const FES_REG_DAYS = 90;
  /** Статуси, з якими документ чекає на реєстр: його пропонують позначеним. «Роздрукувати» теж: акт складено, а на ФЕС він ще не
   *  дійшов. Решта («їде на ФЕС», «проведено») — документ уже в ФЕС. */
  const FES_WAIT = ['немає витяга', 'роздрукувати', 'на підписі', 'переробка'];
  /** Де документ у переліку реєстру від дати `regDate` (назва реєстру — `label`, `fes` — статус ФЕС документа): 'wait' — явне очікування
   *  (позначений), 'inreg' — уже внесений у реєстр цієї дати (лишається в ньому, коли файл складають знову), 'recent' — без статусу, не
   *  старший за FES_REG_DAYS днів (без позначки), 'older' — без статусу й старший (за кнопкою), '' — не для реєстру (уже передано).
   *  Документ без дати чи з нерозбірливою вважається свіжим: прихований, він лишився б непоміченим. */
  function fesRegGroup(fes, docDate, regDate, label) {
    const st = (fes && fes.status) || '';
    if (FES_WAIT.includes(st)) return 'wait';
    if (label && fes && fes.register === label) return 'inreg';
    if (st) return '';
    const age = dayDiff(docDate, regDate);
    return Number.isFinite(age) && age > FES_REG_DAYS ? 'older' : 'recent';
  }

  /** Гроші словами для приміток звіту: «1 234,50» (звичайні пробіли між тисячами, «−» для мінуса). Копійки ріжуться цілими числами:
   *  `(kop / 100).toFixed(2)` на великих сумах розходився б з обліком на копійку. */
  const grnWords = (kop) => kopGrn(kop).replace(/\xa0/g, ' ').replace(/^-/, '−');
  /** Тисячі гривень з одним знаком, цілими числами (найближче, половина — від нуля): 1 234 500 коп. → «12,3 тис», 175 000 коп. → «1,8 тис»,
   *  600 000 коп. → «6 тис». */
  const thous = (kop) => {
    const t = divRound(bigKop(kop), 10000n);
    const a = t < 0n ? -t : t;
    return `${t < 0n ? '−' : ''}${a / 10n}${a % 10n ? `,${a % 10n}` : ''} тис`;
  };
  /** Контекст без актів введення: акт — не поставка, тож стан закупівлі для звіту не бере прихід, на який посилається лише він (а з
   *  ним і суми «Поставлено» лишаються ті самі, що без акта). Без актів — сам контекст. */
  const purDelivery = (ctx) => (ctx.purDocs.some((d) => d.kind === 'акт введення')
    ? Object.assign({}, ctx, { purDocs: ctx.purDocs.filter((d) => d.kind !== 'акт введення'), shares: null }) : ctx);
  /** Суми закупівлі для примітки: усієї справи (`purNums`) чи, коли справа бере кілька рядків коштів і названо рядок `line`, — її суми на цьому
   *  рядку: договори — за частками документів, поставлено — за частками приходів, гроші («торги», «на погодженні») — частка рядка в «Грошах» справи.
   *  Справа з одним рядком коштів — суми всієї справи, як і без рядка. */
  function purLineNums(pu, ctx, line = '') {
    const n = purNums(pu, ctx);
    if (!line || (pu.funds || []).length < 2) return n;
    const sum = (list) => list.reduce((s, x) => s + x, 0);
    return Object.assign({}, n, {
      contracts: sum(ctx.purDocs.filter((d) => d.purchase === pu.id && d.kind === 'договір')
        .map((d) => docParts(d, ctx).filter((p) => p.line === line).reduce((a, p) => a + p.kop, 0))),
      delivered: sum(rcptShares(ctx).filter((x) => x.purchase === pu.id && x.line === line).map((x) => x.kop)),
      pack: sum((pu.funds || []).filter((f) => f.line === line).map((f) => +f.kop || 0)) });
  }
  /** Графа «Станом на» звіту штабу: стан закупівлі словами з сумою цього етапу (`purState` за поставками, без актів введення). Справа на кілька
   *  рядків коштів пише в кожному рядку суми цього рядка (`line` — його id), а не всієї справи. Закрита як «завершено» без приходів у програмі —
   *  отримане береться за договорами. */
  function purStateNote(pu, ctx, line = '') {
    const c = purDelivery(ctx);
    const n = purLineNums(pu, c, line);
    const st = purState(pu, c);
    if (['поставка', 'на ФЕС', 'проведено', 'видано', 'завершено'].includes(st)) {
      return `${thous(n.delivered || (st === 'завершено' ? n.contracts : 0))} ${pu.title} — отримано`;
    }
    if (st === 'договір') return `${thous(n.contracts)} ${pu.title} — в дорозі`;
    if (st === 'погоджено') return `${thous(n.pack)} ${pu.title} — торги`;
    if (st === 'подано') return `${thous(n.pack)} ${pu.title} — на погодженні`;
    return '';
  }
  /** «Використання коштів»: фонд → рядки (КЕКВ/код) з показниками штабу й приміткою зі справ. Скасована закупівля в примітку не йде:
   *  її гроші вже не розплановано на неї (як у `budNums`). */
  function purUseRows(ctx, year) {
    const lines = ctx.budget.filter((l) => +l.year === +year);
    const out = [];
    for (const fund of [...new Set(lines.map((l) => l.fund || ''))]) {
      out.push({ group: true, text: fund || 'не вказано' });
      for (const l of lines.filter((x) => (x.fund || '') === fund)) {
        const n = budNums(l, ctx);
        const notes = ctx.purchases.filter((p) => +p.year === +year && p.closed !== 'скасовано' && (p.funds || []).some((f) => f.line === l.id))
          .map((p) => purStateNote(p, ctx, l.id)).filter(Boolean);
        if (n.unplanned > 0) notes.push(`${notes.length ? 'економія' : 'не розплановано'} ${grnWords(n.unplanned)}`);
        out.push(Object.assign({ group: false, label: l.label, kekv: l.kekv, exp: l.exp, note: notes.join('; ') }, n));
      }
    }
    return out;
  }
  /** «Таблиця закупівель» служби: рядок на закупівлю × її рядок коштів. Скасованої закупівлі в ній немає: після переробки в нову закупівлю
   *  її гроші стоять у новій, і разом вони подвоїлися б. */
  function purTableRows(ctx, year) {
    const out = [];
    for (const pu of ctx.purchases.filter((p) => +p.year === +year && p.closed !== 'скасовано')) {
      const v = purVersion(pu);
      const status = v && v.answer ? v.answer : v && v.sentNo ? 'на погодженні' : 'не подано';
      for (const f of pu.funds || []) {
        const l = ctx.budget.find((x) => x.id === f.line);
        if (!l) continue;
        const used = ctx.purDocs.filter((d) => d.purchase === pu.id && d.kind === 'оплата')
          .reduce((s, d) => s + docParts(d, ctx).filter((p) => p.line === l.id).reduce((a, p) => a + p.kop, 0), 0);
        out.push({ purchase: pu.title, kpkv: l.kpkv, kekv: l.kekv, exp: l.exp, status,
          fund: l.fund === 'Субвенція' ? ['Субвенція', l.community].filter(Boolean).join(' ') : l.fund,
          sum: +f.kop || 0, used, left: (+f.kop || 0) - used,
          note: [l.agreeNo ? `угода №${l.agreeNo}` : '', purStateNote(pu, ctx, l.id)].filter(Boolean).join('; ') });
      }
    }
    return out;
  }
  /** Контрагент документа для звіту: у оплати він той, що в документа, під яким вона стоїть (свого в неї часто нема), і лише коли в
   *  основи нікого — її власний; в інших видів — власний. */
  const purPartyOf = (d, ctx) => (d.kind === 'оплата' && (purDocAt(ctx, d.parent) || {}).party) || d.party || '';
  /** Рядок коштів приходу — за документом закупівлі, що на нього посилається (перша частка). Акт введення прихід до рядка не зводить. */
  function purRcptLine(docId, ctx) {
    const s = rcptShares(ctx).find((x) => x.rid === docId && x.line);
    return s ? ctx.budget.find((l) => l.id === s.line) || null : null;
  }

  // Слова вікон книги «Закупівлі» й пошуку файлів — за відповідями сервера; самі вікна й запити — у розділі закупівель (`purBookExport`…).
  /** Лічильник у відмінностях аркуша без власного ключа (файли, комісії…): «+3» — у книзі на три рядки більше, «-2» — на два менше. */
  const PUR_DIFF_COUNTER = /^[+-]\d+$/;
  /** Скільки записів у переліку відмінностей аркуша: ключ — один запис, лічильник «+3» — три. */
  const purDiffCount = (list) => (list || []).reduce((n, x) => n + (PUR_DIFF_COUNTER.test(String(x)) ? Math.abs(+x) : 1), 0);
  /** Не більш як `max` рядків переліку, решта — одним рядком «… ще N». */
  function purClip(lines, max) {
    const all = (lines || []).map(String);
    return all.length > max ? all.slice(0, max).concat(`… ще ${all.length - max}`) : all;
  }
  /** Текст вікна-попередження про книгу, яку не вивантажено: слово сервера й, під ним, рядки (до `max`). Без рядків — лише слово. */
  function purBookSay(error, rows, max) {
    const list = Array.isArray(rows) ? rows : [];
    return list.length ? `${error}\n\n${purClip(list, max).join('\n')}` : String(error);
  }
  /** Відмінності книги від бази за аркушами для вікна «Прийняти книгу…»: аркуш, скільки нових, змінених і прибраних записів та їхні
   *  ключі (по шість у кожному переліку). Аркуші без відмінностей, `same` і те, що не аркуш, пропущено. */
  function purDiffRows(diff) {
    const out = [];
    for (const [sheet, x] of Object.entries(diff || {})) {
      if (sheet === 'same' || !x || typeof x !== 'object') continue;
      const groups = [['нових', 'нові', x.new], ['змінено', 'змінені', x.changed], ['прибрано', 'прибрані', x.removed]].map(([say, word, list]) => ({
        say, word, n: purDiffCount(list), keys: purClip((list || []).filter((k) => !PUR_DIFF_COUNTER.test(String(k))), 6) }));
      const shown = groups.filter((g) => g.n);
      if (shown.length) {
        out.push({ sheet, say: shown.map((g) => `${g.say} ${g.n}`).join(', '),
          lists: shown.filter((g) => g.keys.length).map((g) => `${g.word}: ${g.keys.join('; ')}`) });
      }
    }
    return out;
  }
  /** Слово після вивантаження книги: де вона лежить, чи склались бланки й чи читається книга назад (інакше її не приймуть). `bad` —
   *  слово попереджає, а не лише повідомляє. З іншого ПК книгу завантажив браузер (`download`), а шлях і бланки — на основному. */
  function purBookDone(j) {
    const trim = (s) => String(s).replace(/[.\s]+$/, '');
    const back = Array.isArray(j.readBack) ? j.readBack : [];
    const parts = [`${j.download ? 'Книгу вивантажено й завантажено браузером.' : `Книгу вивантажено: ${j.path}.`} Закупівель: ${j.purchases}, документів: ${j.docs}.`,
      j.blanksError ? `Бланки не складено: ${trim(j.blanksError)}.` : `Бланки лежать у теці «Бланки»${j.download ? ' на основному комп’ютері' : ''}.`];
    if (back.length) parts.push(`Книга не читається назад: ${purClip(back.map(trim), 2).join('; ')}.`);
    return { text: parts.join(' '), bad: !!(j.blanksError || back.length) };
  }
  /** Слово після «Знайти файли»: скільки зниклих файлів знайдено за вмістом і скільки лишилось невідомо де. */
  function purFoundWord(found, rest) {
    if (!found && !rest) return 'Зниклих файлів немає.';
    if (!found) return `Зниклих файлів знайти не вдалося: ${rest}.`;
    return rest ? `Знайдено файлів: ${found}. Не знайдено: ${rest}.` : `Знайдено й перепідшито файлів: ${found}.`;
  }
  // ЗАКУПІВЛІ: КІНЕЦЬ

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
    if (hit) {
      docs = buildDocs();
      allocateLots();
      // Картка щойно проведеного документа чекала на id: поля ФЕС і книги з'являються одразу, слово про проведення лишається.
      if (state.view === 'doc') {
        if (!state.flash && flashShown && flashShown.doc === state.docKey) state.flash = flashShown.f;
        render();
      }
    }
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

  /** Смуга, коли база не прийняла запис через дані: відмова бази (речення — з крапкою в кінці чи без неї, друга крапка смузі ні
   *  до чого) і що робити далі. */
  const saveRefused = (why) => `Зміни НЕ записано: ${String(why).replace(/[.\s]+$/, '')}. Виправте це — усе внесене запишеться з наступною зміною.`;

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
      saveBar('Зміни не записуються: файл даних пошкоджено. Відновіть дані з копії: «Налаштування» → «Автоматичні копії…».');
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
      saveBar(saveRefused(res.refused));
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
          + 'Не закривайте вікно. Якщо смуга не зникає — «Налаштування» → «Зберегти копію бази…»: незаписане програма '
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
  /** Розділи з великими записами, які правлять частинами: закупівля з версіями й позиціями, рядок коштів із рухом. Правка
   *  вікна лягає на свіжий запис поле за полем, а вкладені переліки з id — запис за записом: двоє, що правлять різне в тій самій
   *  закупівлі (один — суму з рядка коштів, другий — подання версії), не затирають одне одного. Те саме поле — як скрізь. */
  const SYNC_DEEP = new Set(['purchases', 'budget']);

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
   *  змінив хтось інший (лишається правка вікна). `deep` — правки всередині запису розділу з SYNC_DEEP: вкладені записи з id
   *  там теж зливаються поле за полем. */
  function syncApply(theirs, ops, deep = false) {
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
        const one = (x) => Array.isArray(x) && x.length === 1 && syncPlain(x[0]);
        if (op.by === 'id' && (deep || (op.p.length === 1 && SYNC_DEEP.has(op.p[0]))) && one(have) && one(op.was) && one(op.now)) {
          if (syncApply(have[0], syncDiff(op.was[0], op.now[0]), true).length) clashes.push(op);
          continue;
        }
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
  const SYNC_VIEW = ['view', 'book', 'subBook', 'asOf', 'q', 'group', 'sub', 'onlyShort', 'onlyMine', 'noScan', 'assetF', 'subAsset',
    'subHolder', 'subFilterFor', 'stId', 'stSub', 'mtzMonth', 'peopleTab', 'personId', 'movesKindF', 'staffForm',
    'movesFrom', 'movesTo', 'movesLimit', 'itemCode', 'reconDate', 'reconId', 'j14sub', 'j14page', 'j47code',
    'moveKind', 'docKey', 'docBack', 'subName', 'paperId', 'paperVer', 'staffAll', 'normTerms', 'purId', 'budId',
    'purDocId', 'purYear', 'paperHist', 'staffOpen', 'sort', 'tf', 'actsTab', 'rationsMonth'];
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
    ownLines: 'форма 21/Прод', lineCodes: 'форма 21/Прод', docFes: 'статус ФЕС', docMeta: 'поля документів', lineExtra: 'поля рядків документів',
    form2Map: 'прив’язки 2/Прод', form2Own: 'рядки 2/Прод', form2Cells: '2/прод', form2Notes: 'записки 2/прод',
    parties: 'контрагенти', fesMap: 'звірка з ФЕС', fesPlaces: 'звірка з ФЕС', budget: 'кошти', purchases: 'закупівлі',
    purDocs: 'документи закупівель', points: 'пункти харчування', rations: 'дободачі', rationDates: 'дні дободач',
    acts: 'акти списання' };
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
      // Відкрите вікно акта — теж: після оновлення воно стає на екран з усім уписаним (actRestore, spRestore).
      sessionStorage.setItem(SYNC_PACK, JSON.stringify({ ops, view: syncView(), reason, act: actPack(), sp: spPack() }));
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

  /** У вікні нічого не вносять, а хтось записав зміни — вікно підтягує їх. `info.note` — власне слово для оновленого вікна (прийом
   *  книги закупівель: сервер сам змінив базу й назвав копію), замість «дані змінено в іншому вікні». */
  function syncFresh(info) {
    try {
      sessionStorage.setItem(SYNC_PACK, JSON.stringify({ ops: [], view: syncView(), reason: 'fresh',
        who: info.who || '', at: info.at || '', note: info.note || '' }));
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
      sync.note = pack.note || `Оновлено: дані змінено в іншому вікні${syncWho(pack)}.`;
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
    if (state.editing || state.editingReport) return;          // документ чи рапорт у виправленні — не чернетка: оригінал і так в обліку
    const all = Object.assign({}, state.drafts || {});
    if (state.draft) {
      // Відкрита чернетка — у своїй комірці (`slotOf`), а не під видом документа: чернетка приходу ОП лягала під «in» і витісняла
      // відкладену чернетку приходу ТЗ, а після перезапуску поверталась би в комірку ТЗ.
      const slot = slotOf(state.draft.kind, state.draft.book || 'ТЗ');
      if (hasContent(state.draft)) all[slot] = state.draft;
      else delete all[slot];
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
  /** Чернетки з налаштувань вікна — у відкладені, кожна у своїй комірці за видом і книгою самої чернетки, а не за ключем запису:
   *  попередня версія писала відкриту чернетку під її видом («in» і для ОП), тож ключу не вірять. Копії, не спільні об'єкти;
   *  дві чернетки однієї комірки (так могло лягти в старому записі) — лишається остання, відкрита. */
  function restoreDrafts(saved) {
    const out = {};
    for (const [k, v] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
      if (!(v && v.head && Array.isArray(v.lines))) continue;
      out[slotOf(v.kind || String(k).split('@')[0], v.book || 'ТЗ')] = JSON.parse(JSON.stringify(v));
    }
    return out;
  }
  /** Що відновлено після перезапуску: «приходу (посуд і миючі), списання» — вид у родовому відмінку й книга самої чернетки. */
  const DRAFT_KIND_OF = { in: 'приходу', mv: 'переміщення', wr: 'списання', dz: 'рапорту про знищення' };
  const draftsWord = (list) => list.map((v) => (DRAFT_KIND_OF[v.kind] || v.kind) + bookWord(v.book)).join(', ');
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
    hubTab: {},                    // розділ меню → вкладка, на якій його лишили (у цьому вікні)
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
   *  важить лише для «Налаштування» → «Видалити рапорти про знищення, внесені в програмі…».
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
  /** Що скидається, коли відкривають іншу книгу: фільтри списків однієї книги до іншої не переходять (пункт меню й «Дописати»). */
  const BOOK_FILTERS_OFF = { group: '', assetF: '', onlyShort: false, movesKindF: '' };

  /** Стан розділів, що мають і перелік, і картку в одному екрані: пункт меню
   *  завжди відкриває перелік. Те саме з відповіддю «Забезпеченості» (spSupply): пункт меню її скидає, а зміна обліку скидає в
   *  recalc(), тож числа рахуються наново щоразу, коли екран відкривають, — і з меню, і «назад». */
  const NAV_ROOT = {
    destroyed: { dzFocus: null },
    recon: { reconId: null },
    stocktake: { stId: null, stSub: '' },
    people: { personId: null, assign: null },
    mtz: { mtzMonth: null },
    purch: { purId: null },
    purbud: { budId: null },
    val: { paperId: null, paperVer: 0, paperBad: null },
    yats: { paperId: null, paperVer: 0, paperBad: null },
    acts: { actsTab: 'acts' },
    spsupply: { spSupply: null },                 // числа рахуються наново щоразу, коли екран відкривають
  };
  // Меню — розділи роботи (хаби, як в iprod): рядок меню — розділ, його екрани — вкладки над шапкою.
  // Вкладка — той самий вигляд (view), що й колишній пункт меню: go('moves') відкриває «Техзасоби» на
  // «Документах», старі переходи працюють. Розділ книги (book) відкриває свою книгу. Вкладка з views
  // світиться й на своїх підекранах; badge — лічильник «треба зробити», їхня сума стоїть на рядку меню.
  // Вкладки, якої немає в карті екранів (app), не видно: розділ показує лише те, що вже є.
  const HUBS = [
    { id: 'dash', ico: '▤', label: 'Зведення', tabs: [
      { id: 'dash', label: 'Потребує уваги' }] },
    { id: 'tz', ico: '⚒', label: 'Техзасоби', book: 'ТЗ', tabs: [
      { id: 'moves', label: 'Документи' },
      { id: 'nomen', label: 'Номенклатура' },
      { id: 'inv', label: 'Інвентарні номери' },
      { id: 'destroyed', label: 'Знищене', badge: () => allDestroyed().filter((x) => x.status !== 'списано').length || '' },
      { id: 'recon', label: 'Звірки', badge: () => reconDue() || '' },
      { id: 'stocktake', label: 'Інвентаризація',
        badge: () => (store.inventories || []).filter((x) => x.status !== 'завершено').length || '' },
      { id: 'mtz', label: 'МТЗ', badge: () => mtzTodo() || '' },
      { id: 'supply', label: 'Штат і потреба', views: ['subst'] },
      { id: 'val', label: 'Залишкова вартість', badge: () => papers().filter((p) => p.kind === 'valuation'
        && (p.state === 'чернетка' || p.state === 'підготовлено')).length || '' },
      { id: 'yats', label: 'Акти ЯТС', badge: () => papers().filter((p) => p.kind === 'tech_act'
        && (p.state === 'чернетка' || p.state === 'підготовлено')).length || '' },
      { id: 'j47', label: 'Журнали 47 і 14', views: ['j14'] }] },
    { id: 'op', ico: '◌', label: 'Посуд і миючі', book: 'ОП', tabs: [
      { id: 'nomen', label: 'Позиції' },
      { id: 'moves', label: 'Документи' },
      { id: 'acts', label: 'Акти списання', badge: () => Object.values(store.acts || {}).filter((a) => a.kind !== 'sp' && a.daysChanged).length || '' },
      { id: 'j47', label: 'Книги 47 і 14', views: ['j14'] }] },
    { id: 'sp', ico: '◍', label: 'Сухпай', book: 'СП', tabs: [
      { id: 'nomen', label: 'Позиції' },
      { id: 'moves', label: 'Документи' },
      { id: 'acts', label: 'Акти списання', badge: () => Object.entries(store.acts || {}).filter(([id, a]) => a.kind === 'sp'
        && SP_TODO.includes(((store.docFes || {})[id] || {}).status)).length || '' },
      { id: 'spsupply', label: 'Забезпеченість' },
      { id: 'j47', label: 'Книги 47 і 14', views: ['j14'] }] },
    { id: 'rp', ico: '◒', label: 'Реторт-пакети', book: 'РП', tabs: [
      { id: 'nomen', label: 'Позиції' },
      { id: 'moves', label: 'Документи' },
      { id: 'j47', label: 'Книги 47 і 14', views: ['j14'] }] },
    { id: 'post', ico: '⊕', label: 'Постачання', tabs: [
      { id: 'purch', label: 'Закупівлі', views: ['purbud', 'purdocs'] }] },
    { id: 'zvity', ico: '◫', label: 'Звіти', tabs: [
      { id: 'form2', label: '2/Прод', badge: () => form2MapNow().filter((m) => m.row && !m.checked).length || '' },
      { id: 'form11', label: '11/прод' },
      { id: 'opysy', label: 'Описи 572' }] },
    { id: 'dovidnyky', ico: '⊞', label: 'Довідники', tabs: [
      { id: 'subs', label: 'Підрозділи' },
      { id: 'people', label: 'Люди й МВО' }] },
    { id: 'settings', ico: '⚙', label: 'Налаштування', tabs: [
      { id: 'settings', label: 'Налаштування' }] },
  ];
  /** Картки відкриваються з вкладки й лишаються під нею: документ — під «Документами» своєї книги. */
  const CARD_TAB = { item: 'nomen', doc: 'moves', sub: 'subs' };
  const hubTabs = (hub) => hub.tabs.filter((t) => app[t.id]);
  /** Розділ і вкладка екрана: спершу розділ своєї книги, тоді будь-який (знищене живе в «Техзасобах»,
   *  хоч би яка книга була відкрита); невідомий вигляд — «Зведення», як і в render. */
  function hubAt(view = state.view, book = state.book) {
    const v = CARD_TAB[view] || view;
    for (const own of [true, false]) {
      for (const hub of HUBS) {
        if (own && hub.book && hub.book !== book) continue;
        const tab = hubTabs(hub).find((t) => t.id === v || (t.views || []).includes(v));
        if (tab) return { hub, tab };
      }
    }
    return { hub: HUBS[0], tab: HUBS[0].tabs[0] };
  }
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

  /** Рядки меню. data-views — вигляди розділу (з ними перевірки знаходять рядок за екраном). */
  function renderNav(cur = hubAt()) {
    $('#nav').innerHTML = HUBS.map((hub) => {
      const tabs = hubTabs(hub);
      if (!tabs.length) return '';
      const todo = tabs.filter((t) => t.badge).reduce((a, t) => a + (Number(t.badge()) || 0), 0);
      return `<button class="nav__item${hub === cur.hub ? ' is-active' : ''}" data-hub="${hub.id}"${
        hub.book ? ` data-book="${hub.book}"` : ''} data-views="${tabs.flatMap((t) => [t.id, ...(t.views || [])]).join(' ')}">
           <span class="nav__ico">${hub.ico}</span>
           <span class="nav__label">${esc(hub.label)}</span>
           <span class="nav__badge">${todo || ''}</span>
         </button>`;
    }).join('');
  }
  /** Вкладки розділу над шапкою екрана; розділ з одним екраном вкладок не має. */
  function hubBar(cur) {
    const tabs = hubTabs(cur.hub);
    if (tabs.length < 2) return '';
    return `<nav class="tabs" aria-label="${esc(cur.hub.label)}">${tabs.map((t) => {
      const n = t.badge ? t.badge() : '';
      return `<button type="button" class="tabs__item${t === cur.tab ? ' is-on' : ''}" data-nav="${t.id}"${
        cur.hub.book ? ` data-book="${cur.hub.book}"` : ''}>${esc(t.label)}${
        n !== '' && n != null ? `<span class="tabs__badge">${esc(n)}</span>` : ''}</button>`;
    }).join('')}</nav>`;
  }

  /** Рядок під назвою сторінки: що показано й на яку дату. Без інструкцій —
   *  що можна зробити, кажуть кнопки. Дати й підрозділ — зі стану. */
  const SUB_TEXT = {
    spsupply: () => 'Добові дачі по місцях проти потреби «доби × особи»',
    dash: () => `Стан обліку на ${fmtDate(state.asOf)}`,
    nomen: () => `Залишки на ${fmtDate(state.asOf)} ${state.sub ? `по «${state.sub}»` : 'по всій бригаді'}`,
    subs: () => 'Дерево частини',
    supply: () => `Норма за табелем і наявність на ${fmtDate(state.asOf)}`,
    inv: () => 'Номери одиниць по підрозділах',
    item: () => 'Картка позиції',
    doc: () => '',
    moves: () => 'Первинні документи за весь період',
    acts: () => (state.book === 'СП' ? 'Сухі пайки, підігрівачі й вода за рапортами підрозділів' : null)
      || ({ rations: 'Дободачі пунктів харчування за днями', points: 'Пункти харчування й місця списання' }[state.actsTab]
      || 'Посуд, серветки й миючі за нормами наказу 390'),
    form2: () => `Бланк А2788 за ${f2Year()} рік: рух з документів книг ТЗ і ОП, зданий звіт і записки`,
    form11: () => 'Тара книги СП (категорія «Т») за календарний квартал',
    opysy: () => 'Чернетки інвентаризаційних описів запасів з книг СП і ОП за формою № 572',
    recon: () => (state.reconId
      ? 'Звірка за Додатком 1/9'
      : 'Щомісячні відомості звірки за Додатком 1/9'),
    stocktake: () => 'Наказ, комісія, описи по МВО й акт за формами наказу Мінфіну № 572',
    destroyed: () => 'Рапорти про знищення й акти списання',
    mtz: () => `Закуплене й отримане за ${mtzSpan(mtzMonth())}, станом на ${fmtDate(mtzAsOf(mtzMonth()))}`,
    purch: () => (state.purId ? 'Справа закупівлі' : `Закупівлі ${purYear()} року`),
    purbud: () => (state.budId && budById(state.budId) ? 'Рядок коштів' : `Кошти ${purYear()} року`),
    purdocs: () => { const d = state.purDocId ? pdById(state.purDocId) : null; return d && d.kind === 'акт введення' ? avSubtitle(d) : ''; },
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
          : state.view === 'val' || state.view === 'yats' ? `${state.paperId || ''}|${state.paperVer || ''}`
            : state.view === 'purch' ? (state.purId || '') : state.view === 'purbud' ? (state.budId || '')
              : state.view === 'purdocs' ? (state.purDocId || '') : state.view === 'acts' ? (state.actsTab || 'acts') : '');

  /** Лічильник показів: що залежить від стану сторінки, але дорого будується, будують раз на показ (див. `mtzPurOf`). */
  let renderSeq = 0;
  function render() {
    renderSeq++;
    pickClose();
    comboClose();
    const cur = hubAt();
    state.hubTab[cur.hub.id] = cur.tab.id;
    renderNav(cur);
    renderAsOf();
    const v = app[state.view] || renderDash;
    const out = v();
    $('#head').innerHTML = hubBar(cur) + out.head;
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
