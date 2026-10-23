// Облік ТЗ ПС · сторінка · відомість МТЗ.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

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

  /** Реквізити приходу з рядка коштів його закупівлі: розділ закупівель підставляє свою функцію (вона дає `id → {src, kpkv, kekv}` чи
   *  `null`). Поки закупівель немає, не дає нічого, і відомість така, якою була. */
  let mtzPurOf = () => () => null;

  /** Надходження ззовні за рік (до дати включно): рядок приходу — рядок відомості. Джерело, КПКВ і КЕКВ — указані руками, а де їх нема —
   *  з рядка коштів закупівлі, з якої прийшов прихід; кожне поле окремо. */
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
    const purOf = mtzPurOf();
    return [...by.values()].sort((a, b) => a.d.localeCompare(b.d) || a.id - b.id
      || String(a.code).localeCompare(String(b.code), 'uk', { numeric: true })).map((x) => {
      const a = saved[x.key] || {};
      const it = itemBy.get(x.code) || {};
      // Указане руками — першим; далі — рядок коштів закупівлі, з якої прийшов прихід.
      const p = purOf(x.id) || {};
      const auto = !a.src && !p.src && mtzOutside(x);
      return Object.assign(x, { sum: round2(x.q * x.price), src: a.src || p.src || (auto ? '-' : ''), auto,
        kpkv: a.kpkv || p.kpkv || '', kekv: a.kekv || p.kekv || '', group: a.group || MTZ_GROUP,
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
      head: head('техзасоби / відомість МТЗ', 'Відомість МТЗ', `
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
