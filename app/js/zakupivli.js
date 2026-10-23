// Облік ТЗ ПС · сторінка · закупівлі.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ================================================================ ЗАКУПІВЛІ
  /** Закупівлі: справи (розділ стану purchases) з рядками коштів (budget) і документами (purDocs); чисті функції —
   *  між маркерами «ЗАКУПІВЛІ» угорі, тут — екрани й файли в теках служби.
   *
   *  Спершу — надходження ззовні з бюджетними реквізитами, основа звіту «Що надійшло»: рядок — позиція документа
   *  надходження, той самий запис store.mtz.rows («id документа|код»), що й у відомості МТЗ: КПКВ і КЕКВ спільні.
   *  До них додаються джерело фінансування (`fund`), код видатків (`exp`) і частки (`parts`) — коли позицію віднесено
   *  до кількох джерел: сума часток дорівнює сумі позиції. Це вартість за документами надходження, а не підтверджені
   *  оплати. */
  // Джерело позиції — назвою фонду, як у рядках коштів: позначення відомості МТЗ («С», «БД», «ПДФО») — за `MTZ_SRC_OF_PUR` навпаки, а
  // назви, які писали старі версії, — їхнім фондом. Тож у графі «Джерело» одне джерело не стоїть двома назвами. Позначення, якого жоден
  // фонд не має, лишається як є, з «вид не уточнено».
  const PUR_FUND_OF_SRC = Object.fromEntries(Object.entries(MTZ_SRC_OF_PUR).map(([fund, src]) => [src, fund]));
  const PUR_FUND_OLD = { 'Благодійна допомога': 'Благодійні кошти', 'ПДФО — вид не уточнено': '10% ПДФО' };
  const purFundName = (fund) => PUR_FUND_OLD[fund] || fund || '';
  /** Гривні → копійки точно (за цифрами числа, не `x * 100` у double: 16,275 · 100 — це 1627,4999…). */
  const purKop = (x) => kopOf(x);
  /** Сума рядка надходження в копійках: ціна округлюється до копійки, далі — кількість у тисячних × ціна (`lineKop`), як у моделі закупівель. */
  const purLineKop = (q, price) => lineKop(q, kopOf(price));
  const purCarry = mtzCarry;                             // перенос залишків — не надходження, як і у відомості МТЗ
  /** Джерело позиції: вписане (старі версії) чи з позначення відомості МТЗ; «не входить» і порожнє — без джерела. */
  function purFundOf(a) {
    if (!a) return '';
    if (a.fund) return purFundName(a.fund);
    const src = String(a.src || '').trim();
    return !src || src === '-' ? '' : PUR_FUND_OF_SRC[src] || `${src} (вид не уточнено)`;
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
          sum: purKop(p.sum) / 100, fund: purFundName(p.fund), fundNote: p.fundNote || '', kpkv: p.kpkv || '', kekv: p.kekv || '',
          exp: p.exp || '' })));
      } else {
        out.push(Object.assign(base, { rid: x.key, part: 0, of: 0, sum: total, fund: purFundOf(a), fundNote: a.fundNote || '',
          kpkv: a.kpkv || '', kekv: a.kekv || '', exp: a.exp || '', badParts: Array.isArray(a.parts) && a.parts.length > 0 }));
      }
    }
    return out;
  }

  /** Рядок «Разом» звіту «Що надійшло»: сума (копійки складаються цілими, у гривні — раз), документів і позицій (частки однієї позиції —
   *  одна позиція). Кількість різного майна не складається. */
  function purTotal(rows) {
    return { sum: rows.reduce((s, x) => s + purKop(x.sum), 0) / 100, docs: new Set(rows.map((x) => x.id)).size,
      items: new Set(rows.map((x) => x.key)).size };
  }

  // ---------------------------------------------------------------- справи закупівель
  /** Розділи закупівель у стані: рядки коштів, справи, документи (кожен запис — з id). */
  const purBudget = () => (Array.isArray(store.budget) ? store.budget : (store.budget = []));
  const purList = () => (Array.isArray(store.purchases) ? store.purchases : (store.purchases = []));
  const purDocsList = () => (Array.isArray(store.purDocs) ? store.purDocs : (store.purDocs = []));
  const purYear = () => +state.purYear || +today().slice(0, 4);
  const purById = (id) => purList().find((p) => p.id === id) || null;
  const budById = (id) => purBudget().find((l) => l.id === id) || null;
  const pdById = (id) => purDocsList().find((d) => d.id === id) || null;
  const grnOf = (kop) => fmtMoney((+kop || 0) / 100);
  const budKey = (l) => `${l.year} · ${l.label}`;

  /** Поле суми в гривнях → копійки. Порожнє — нуль. Текст, що не число, нулем не пишеться: поле позначається (is-bad),
   *  `say` каже про це (на сторінці — плашка в куті, у вікні — рядок у самому вікні: плашка лежить під ним), а результат —
   *  null, і той, хто питає, зміни не записує. `signed` — чи може сума бути від'ємною (сума з рядка коштів — ні).
   *  Так само читається кожне поле суми закупівель. */
  function moneyIn(el, say = (text) => toast(text, true), signed = false) {
    const text = String(el.value ?? '').trim();
    const kop = text ? kopParse(text) : 0;
    const why = kop == null ? `Сума «${text}» — не число.`
      : !Number.isSafeInteger(kop) ? `Сума «${text}» завелика.`
        : kop < 0 && !signed ? `Сума «${text}» не може бути від’ємною.` : '';
    el.classList.toggle('is-bad', !!why);
    if (why) say(why);
    return why ? null : kop;
  }
  /** Поле кількості → число з не більш як трьома знаками після коми (у базі кількість — тисячні). Кома й крапка — обидві
   *  десяткові, пробіли між цифрами не заважають. Порожнє, не число («1,2,3», «два»), нуль і менше, четвертий знак, завелике —
   *  поле позначається (is-bad), `say` каже чому, а результат — null: той, хто питає, зміни не записує (тиха «нульова»
   *  кількість зробила б позицію без суми). */
  function qtyIn(el, say = (text) => toast(text, true)) {
    const text = String(el.value ?? '').trim();
    const m = /^([+-]?)(\d*)(?:[.,](\d*))?$/.exec(text.replace(/\s/g, ''));
    const frac = m ? (m[3] || '').replace(/0+$/, '') : '';                      // «2,5000» — це 2,5
    let milli = 0n;
    let why = '';
    if (!text) why = 'Кількість не вказано.';
    else if (!m || !/\d/.test(m[2] + (m[3] || ''))) why = `Кількість «${text}» — не число.`;
    else if (frac.length > 3) why = `Кількість «${text}» — не більш як три знаки після коми.`;
    else {
      milli = BigInt(m[2] || '0') * 1000n + BigInt((frac + '000').slice(0, 3));
      if (m[1] === '-' || milli === 0n) why = `Кількість «${text}» має бути більшою за нуль.`;
      else if (milli > 10n ** 12n) why = `Кількість «${text}» завелика.`;
    }
    el.classList.toggle('is-bad', !!why);
    if (why) say(why);
    return why ? null : Number(milli) / 1000;                                  // тисячні ділить double до найближчого числа з десяткового запису
  }

  function budBlank(year) {
    return { id: uid(), year, label: '', fund: '', kpkv: '', kekv: '', exp: '', community: '', purpose: '', agreeNo: '',
      agreeDate: '', decisionNo: '', decisionDate: '', returnBy: '', reportBy: '', missing: {}, note: '', moves: [] };
  }
  /** Підписанти версії — з «Люди й МВО» на дату; правляться у вікні складання (ТВО тощо). */
  function verBlank(label, date) {
    const at = (role) => sgOf(officialAt(role, date), date);
    return { id: uid(), label, reason: '', signedOn: '', sentNo: '', sentOn: '', answer: '', answerNo: '', answerOn: '',
      answerNote: '', handedOn: '', missing: {}, positions: [],
      signers: { cmdr: at('командир'), fes: at('начальник ФЕС'), chief: at('начальник служби'),
        exec: Object.assign(at('начальник служби'), { phone: unitInfo().phone || '' }) } };
  }
  function purBlank(year, title) {
    return { id: uid(), year, title, what: '', person: '', parent: '', source: '', closed: '',
      folder: `${year}/${safeFile(title)}`, missing: {}, note: '', funds: [], versions: [verBlank('1.0', today())] };
  }
  function posBlank() {
    return { id: uid(), name: '', specs: '', uom: 'шт', qty: 1, rule: 'середня', priceKop: 0, kekv: '', exp: '', dk: '',
      line: '', code: '', note: '', offers: [1, 2, 3].map(() => offerBlank('посилання')) };
  }
  function offerBlank(kind) {
    return { id: uid(), kind, seller: '', url: '', priceKop: 0, checked: '', no: '', date: '', note: '' };
  }
  function docBlank(kind, purchase) {
    return { id: uid(), kind, no: '', date: today(), purchase: purchase || '', parent: '', party: '', person: '', kop: 0,
      vatKop: 0, deliverBy: '', validTo: '', usedOn: '', returnedOn: '', payOn: '', procedure: '',
      state: kind === 'акт введення' ? 'чернетка' : '', fes: { status: '', date: '', register: '', ref: '' }, extra: {},
      missing: '', note: '', lines: [], parts: [], receipts: [] };
  }

  /** Ключі записів про файли закупівель у `store.scans`: рядок коштів, версія справи, документ закупівлі, реєстр на ФЕС. */
  const PUR_FILE_KEY = /^(bud|purver|purdoc|fesreg)\|/;

  /** Контекст чистих функцій: розділи стану, акти приймання обліку, переміщення, файли закупівель. Новий на кожен показ:
   *  `rcptShares` пам'ятає результат у `ctx.shares`, і давній контекст показував би застарілі числа. */
  function purCtx() {
    const rcpt = new Map();
    for (const r of docs) {
      if (r.kind !== 'in' || !r.id) continue;
      let x = rcpt.get(r.id);
      if (!x) {
        x = { id: r.id, key: keyOfRow(r), d: r.d, no: r.no, from: r.from, to: r.to, kop: 0,
          fes: (fesOf(r.id) || {}).status || '', lines: [], scan: filesOf(keyOfRow(r)).length > 0 };
        rcpt.set(r.id, x);
      }
      x.kop += lineKop(r.q, kopOf(r.price));
      x.lines.push({ code: r.code, q: r.q, price: r.price });
    }
    const rcptByKey = new Map([...rcpt.values()].map((x) => [x.key, x.id]));
    const files = new Map();
    for (const f of store.scans || []) {
      if (!PUR_FILE_KEY.test(f.key)) continue;
      if (!files.has(f.key)) files.set(f.key, []);
      files.get(f.key).push({ made: !!f.made, sha: f.sha || '' });
    }
    const moves = docs.filter((r) => r.kind === 'mv').map((r) => ({ code: r.code, from: r.from, to: r.to, d: r.d, q: r.q }));
    return { budget: purBudget(), purchases: purList(), purDocs: purDocsList(), today: today(), rcpt, rcptByKey, moves,
      files };
  }

  /** Куди лягає файл закупівлі: ключ теки, підтека, ім'я (таблиця «Файли» плану). Порожня частина імені (немає контрагента,
   *  номера, дати чи назви рядка) пропускається: `safeFile('')` — «вивантаження», а його в назві документа бути не має. */
  function purFolderFor(key) {
    const [kind, id, what] = String(key).split('|');
    const dd = (iso) => (iso ? fmtDate(iso) : '');
    const join = (...xs) => xs.filter(Boolean).join(' ');
    if (kind === 'bud') {
      const l = budById(id);
      if (!l) return null;
      const label = safePart(l.label);
      return { folder: 'purchases', dir: [l.year, 'Кошти', label].filter(Boolean).join('/'), name: join(safePart(what), label) };
    }
    if (kind === 'purver') {
      const pu = purList().find((p) => (p.versions || []).some((v) => v.id === id));
      const v = pu && pu.versions.find((x) => x.id === id);
      if (!v) return null;
      const names = { 'розрахунки': 'Розрахунки до рапорту', 'рапорт': 'Рапорт', '1фс': '1фс', '9фс': '9фс',
        'супровід': 'Супровід', 'відповідь': v.answer === 'не погоджено' ? 'Не погоджено' : 'Погодження',
        'кп': 'Комерційна пропозиція' };
      const label = safePart(v.label);
      return { folder: 'purchases', dir: !label || label === '1.0' ? purDirOf(pu) : `${purDirOf(pu)}/${label}`,
        name: names[what] || safePart(what) };
    }
    if (kind === 'purdoc') {
      const d = pdById(id);
      if (!d) return null;
      const year = String(d.date || today()).slice(0, 4);
      const no = safePart(d.no);
      const party = safePart(d.party);
      const from = d.date ? `від ${dd(d.date)}` : '';
      if (d.kind === 'договір') {
        const pu = purById(d.purchase);
        return { folder: 'purchases', dir: pu ? purDirOf(pu) : `${year}/Договори`,
          name: join('Договір', `№${no || 'б-н'}`, from, party && `(${party})`) };
      }
      if (d.kind === 'акт введення') {
        return { folder: 'receipts', dir: `${year}/Введення в експлуатацію`, name: join('Акт введення в експлуатацію', no) };
      }
      const word = { 'ВН': 'ВН', 'рахунок': 'Рахунок', 'довіреність': 'Довіреність', 'оплата': 'Оплата' }[d.kind] || 'Документ';
      return { folder: 'receipts', dir: `${year}/Отримання`, name: join(word, `№${no || 'б-н'}`, from, party && `(${party})`) };
    }
    return null;
  }
  /** Підшити файл закупівлі в теку служби під іменем служби. */
  function purAttach(key, files) {
    const where = purFolderFor(key);
    if (!where) return null;
    return attachScan({ key, date: today(), no: '', folderKey: where.folder, folder: where.dir, name: where.name }, files);
  }

  const purSeg = (cur) => `<div class="seg"><button type="button" data-nav="purch"${cur === 'purch' ? ' class="is-on"' : ''}>Справи</button>
      <button type="button" data-nav="purbud"${cur === 'purbud' ? ' class="is-on"' : ''}>Кошти</button></div>`;
  const PUR_TAG = { 'розрахунки': 'tag--mv', 'подано': 'tag--stock', 'не погоджено': 'tag--out', 'погоджено': 'tag--in',
    'договір': 'tag--in', 'поставка': 'tag--stock', 'на ФЕС': 'tag--stock', 'проведено': 'tag--in', 'видано': 'tag--in',
    'завершено': 'tag--ser', 'скасовано': 'tag--ser' };
  const purYears = () => [...new Set([purYear(), +today().slice(0, 4)].concat(purList().map((p) => +p.year),
    purBudget().map((l) => +l.year)))].filter(Boolean).sort((a, b) => a - b);
  const purYearSel = () => `<select class="btn" data-pur-year title="Рік" aria-label="Рік">${purYears().map((y) =>
    `<option${y === purYear() ? ' selected' : ''}>${y}</option>`).join('')}</select>`;

  function purSpec(ctx) {
    const rows = purList().filter((p) => +p.year === purYear()).map((pu) => {
      const n = purNums(pu, ctx);
      return { pu, st: purState(pu, ctx), n,
        lines: (pu.funds || []).map((f) => budById(f.line)).filter(Boolean),
        parties: [...new Set(ctx.purDocs.filter((d) => d.purchase === pu.id && d.party).map((d) => d.party))] };
    });
    const uniq = (f) => [...new Set(rows.flatMap(f).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
    return {
      id: 'pur', rows, minWidth: '1040px', limit: REG_LIMIT,
      placeholder: 'Пошук: тема, що купуємо, постачальник',
      search: (x) => [x.pu.title, x.pu.what, ...x.parties, ...x.lines.map((l) => l.label)],
      filters: [
        { type: 'seg', key: 'st', options: [['', 'усі']].concat(PUR_STATES.map((s) => [s, s])), test: (x, v) => x.st === v },
        { type: 'select', key: 'fund', label: 'джерело', all: 'усі', options: uniq((x) => x.lines.map((l) => l.fund)).map((v) => [v, v]),
          test: (x, v) => x.lines.some((l) => l.fund === v) },
        { type: 'select', key: 'com', label: 'громада', all: 'усі', options: uniq((x) => x.lines.map((l) => l.community)).map((v) => [v, v]),
          test: (x, v) => x.lines.some((l) => l.community === v) },
        { type: 'select', key: 'party', label: 'постачальник', all: 'усі', options: uniq((x) => x.parties).map((v) => [v, v]),
          test: (x, v) => x.parties.includes(v) },
      ],
      columns: [
        { key: 'title', label: 'закупівля', cls: 'c-name c-name--stack', style: 'flex:2 1 220px', first: 1, sort: (x) => x.pu.title,
          cellTitle: (x) => x.pu.what || x.pu.title,
          cell: (x) => `<b>${esc(x.pu.title)}</b><small>${esc([x.pu.what, x.lines.map((l) => l.label).join(', ')].filter(Boolean).join(' · '))}</small>` },
        { key: 'pack', label: 'пакет, грн', cls: 'c-num', style: 'width:110px', sort: (x) => x.n.pack, cell: (x) => grnOf(x.n.pack) },
        { key: 'con', label: 'договори', cls: 'c-num', style: 'width:110px', sort: (x) => x.n.contracts, cell: (x) => grnOf(x.n.contracts) },
        { key: 'got', label: 'поставлено', cls: 'c-num', style: 'width:110px', sort: (x) => x.n.delivered, cell: (x) => grnOf(x.n.delivered) },
        { key: 'paid', label: 'оплачено', cls: 'c-num', style: 'width:110px', sort: (x) => x.n.paid, cell: (x) => grnOf(x.n.paid) },
        { key: 'st', label: 'стан', cls: 'c-tag', style: 'width:110px', first: 1, sort: (x) => PUR_STATES.indexOf(x.st),
          cell: (x) => `<span class="tag ${PUR_TAG[x.st] || ''}">${esc(x.st)}</span>` },
      ],
      row: (x) => ({ attrs: `data-act="pur-open" data-id="${esc(x.pu.id)}"` }),
      total: (shown) => ({ title: '<b>Разом</b>', pack: grnOf(shown.reduce((s, x) => s + x.n.pack, 0)),
        con: grnOf(shown.reduce((s, x) => s + x.n.contracts, 0)), got: grnOf(shown.reduce((s, x) => s + x.n.delivered, 0)),
        paid: grnOf(shown.reduce((s, x) => s + x.n.paid, 0)) }),
      count: (shown, all) => (shown.length === all.length ? String(all.length) : `${shown.length} із ${all.length}`),
      empty: 'Закупівель ще немає.', emptyFiltered: 'За цими фільтрами закупівель немає.',
    };
  }

  function renderPurchases() {
    const ctx = purCtx();
    const pu = state.purId ? purById(state.purId) : null;
    if (pu) return renderPurCard(pu, ctx);
    const reg = registry(purSpec(ctx));
    return {
      fill: true,
      head: head(`закупівлі / ${purYear()}`, 'Закупівлі', `${purSeg('purch')}${purYearSel()}
        ${native && !me.remote ? '<button class="btn" data-act="pur-files-find">Знайти файли</button>' : ''}
        ${native ? '<button class="btn" data-act="pur-book">Книга «Закупівлі»…</button>' : ''}
        <button class="btn" data-act="pur-xls">В Excel</button>
        <button class="btn btn--primary" data-act="pur-new">+ Закупівля</button>`),
      body: `${flashBlock()}${reg.panel}<div class="card card--scroll card--fill">${reg.table}</div>`,
    };
  }

  /** Слово під плиткою «Пакет»: яку версію вона підсумовує (`purNums`) — погоджену з її номером, а коли такої нема, останню. */
  function purPackHint(pu) {
    const approved = purVersion(pu, 'approved');
    return approved ? `погоджена версія ${approved.label}` : 'остання версія';
  }

  /** Блоки картки закупівлі по порядку: кожна задача дописує свої. */
  const PUR_BLOCKS = [];
  function renderPurCard(pu, ctx) {
    const n = purNums(pu, ctx);
    const st = purState(pu, ctx);
    const tile = (label, kop, hint = '') => `<div class="tile"><div class="tile__label">${esc(label)}</div>
      <div class="tile__value">${grnOf(kop)} <small>грн</small></div>${hint ? `<div class="tile__hint">${esc(hint)}</div>` : ''}</div>`;
    return {
      head: head(`закупівлі / ${pu.year}`, pu.title, `<button class="btn" data-act="pur-close">← До переліку</button>
        <span class="tag ${PUR_TAG[st] || ''}">${esc(st)}</span>
        ${native && !me.remote ? `<button class="btn" data-act="pur-folder" data-id="${esc(pu.id)}">Відкрити теку</button>` : ''}
        <button class="btn" data-act="pur-edit" data-id="${esc(pu.id)}">Виправити</button>`),
      body: `${flashBlock()}<div class="pur-card">${purPerson(pu)}
        <div class="tiles">${tile('Пакет', n.pack, purPackHint(pu))}
          ${tile('Договори', n.contracts, n.economy > 0 ? `економія ${grnOf(n.economy)}` : '')}
          ${tile('Поставлено', n.delivered)}${tile('Оплачено', n.paid)}</div>
        ${PUR_BLOCKS.map((f) => f(pu, ctx)).join('')}</div>`,
    };
  }

  /** Рядок під шапкою картки: відповідальний. Посилань між закупівлями («з економії…», «перероблено з…») картка не показує: вони
   *  лежать у базі й у книзі «Закупівлі» (колонки «з економії» й «перероблено з»). */
  function purPerson(pu) {
    const who = pu.person ? personBy(pu.person) : null;
    return who ? `<div class="set-note" style="padding:0 4px">відповідальний ${esc(pSign(who))}</div>` : '';
  }

  /** Блок «Гроші»: з яких рядків коштів і скільки. */
  PUR_BLOCKS.push((pu, ctx) => {
    const rows = (pu.funds || []).map((f, i) => {
      const l = budById(f.line);
      const left = l ? budNums(l, ctx).unplanned : 0;
      return `<div class="tbl__row tbl__row--plain"><div class="c-name c-name--stack"><b>${esc(l ? `${l.label} · ${l.fund}` : 'рядка немає')}</b>
          <small>${l ? `не розплановано ${grnOf(left)}` : ''}</small></div>
        <div class="c-num" style="width:150px"><input class="rc-in" style="width:100%" data-pur-fund="${i}" value="${esc(kopStr(f.kop))}"
          inputmode="decimal" autocomplete="off" aria-label="сума з рядка"></div>
        <div class="c-acts">${rowBtn('pur-fund-del', '✕ Прибрати', `data-i="${i}"`, { bad: true, title: 'Прибрати рядок із закупівлі' })}</div></div>`;
    }).join('');
    const free = purBudget().filter((l) => l.year === pu.year && !(pu.funds || []).some((f) => f.line === l.id));
    return `<div class="card pur-block"><div class="card__head"><div class="card__title">Гроші</div>
        <span class="panel__count">${grnOf((pu.funds || []).reduce((s, f) => s + (+f.kop || 0), 0))} грн</span>
        ${free.length ? `<select data-pur-fund-add aria-label="рядок коштів"><option value="">+ Рядок коштів…</option>${free.map((l) =>
    `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join('')}</select>` : ''}</div>
      <div class="tbl" style="--tbl-min:auto">${rows || `<div class="tbl__row tbl__row--plain"><div class="c-txt">Рядків коштів ще не вказано.${
  free.length ? '' : ' Їх заводять на вкладці «Кошти».'}</div></div>`}</div></div>`;
  });

  function purNew() {
    const options = (year) => '<option value="">—</option>' + purBudget().filter((l) => l.year === year).map((l) =>
      `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join('');
    const el = modalOpen('Нова закупівля', `<form id="pur-new" class="pad"><div class="form__grid">
        <div class="field"><label>Рік</label><input name="year" type="number" value="${purYear()}" min="2000" max="2100"></div>
        <div class="field field--span"><label>Тема (назва теки)</label><input name="title" autocomplete="off" required></div>
        <div class="field field--span"><label>Що купуємо</label><input name="what" autocomplete="off"></div>
        <div class="field"><label>Рядок коштів</label><select name="line">${options(purYear())}</select></div>
        <div class="field"><label>Сума з рядка, грн</label><input name="sum" inputmode="decimal" autocomplete="off"></div></div>
      <div class="pad" data-pur-msg hidden style="color:var(--bad)"></div>
      <div style="padding-top:12px"><button class="btn btn--primary" type="submit">Завести</button>
        <button class="btn" type="button" data-md="close">Скасувати</button></div></form>`);
    const form = el.querySelector('form');
    const msg = el.querySelector('[data-pur-msg]');
    const fail = (text) => { msg.hidden = false; msg.textContent = text; };
    // Рядки коштів — того року, що вказано у вікні.
    form.elements.year.addEventListener('change', () => { form.elements.line.innerHTML = options(+form.elements.year.value || purYear()); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      msg.hidden = true;
      const f = new FormData(form);
      const year = +f.get('year') || purYear();
      const title = String(f.get('title') || '').trim().replace(/\s+/g, ' ');
      if (!title) { fail('Тему закупівлі не вказано.'); return; }
      // Тека — це й назва; закупівлю могли перейменувати, лишивши теку: тоді збігається тека, а не тема, і так про це й сказано.
      const why = purTwinWhy(year, title);
      if (why) { fail(why); return; }
      const pu = purBlank(year, title);
      pu.what = String(f.get('what') || '').trim();
      const line = String(f.get('line') || '');
      const typed = form.elements.sum.value.trim();
      if (typed && !line) { fail('Оберіть рядок коштів, з якого ця сума.'); return; }
      if (line) {
        const sum = moneyIn(form.elements.sum, fail);
        if (sum == null) return;
        // Вписане — те й лягає (і «0» теж); порожнє поле бере все, що в рядку ще не розплановано.
        pu.funds.push({ line, kop: typed ? sum : Math.max(0, budNums(budById(line), purCtx()).unplanned) });
      }
      purList().push(pu);
      state.purYear = year;
      logChange('закупівлю заведено', `pur|${pu.id}`, `${year} · ${title}`);
      modalClose();
      save();
      go('purch', { purId: pu.id });
    });
  }

  function bindPurchases() {
    if (!['purch', 'purbud', 'purdocs'].includes(state.view)) return;
    const sc = $('#scroll');
    $('#head').querySelector('[data-pur-year]')?.addEventListener('change', (e) => {
      state.purYear = +e.target.value;
      // Рік — частина екрана в історії вікна, а перемикач запису в ній не робить: без цього «назад» із картки вертало б на
      // попередній рік. Поточний запис оновлюється тут, до малювання.
      try { history.replaceState(navSnap(), ''); } catch (err) { /* без історії теж працює */ }
      render();
    });
    const pu = state.view === 'purch' && state.purId ? purById(state.purId) : null;
    if (pu) {
      sc.querySelectorAll('[data-pur-fund]').forEach((el) => el.addEventListener('change', () => {
        const f = pu.funds[+el.dataset.purFund];
        const kop = f ? moneyIn(el, undefined, false) : null;
        if (kop == null) return;
        f.kop = kop;
        logChange('гроші закупівлі', `pur|${pu.id}`, `${pu.title}, ${(budById(f.line) || {}).label || 'рядок коштів'}: ${grnOf(f.kop)}`);
        save();
        render();
      }));
      sc.querySelector('[data-pur-fund-add]')?.addEventListener('change', (e) => {
        const line = budById(e.target.value);
        if (!line) return;
        // Сума документів, що йшла до єдиного рядка, лишається на ньому й з другим рядком (`purFreezeParts`).
        for (const d of purFreezeParts(pu, purCtx())) {
          const p = d.parts[0];
          logChange('частки документа записано', `purdoc|${d.id}`, `${pdLabel(d)}: ${(budById(p.line) || {}).label || 'рядок коштів'} ${grnOf(p.kop)}`);
        }
        pu.funds.push({ line: line.id, kop: Math.max(0, budNums(line, purCtx()).unplanned) });
        logChange('рядок коштів додано до закупівлі', `pur|${pu.id}`, `${pu.title}: ${line.label}`);
        save();
        render();
      });
    }
    PUR_BINDS.forEach((f) => f(sc, pu));
  }
  /** Прив'язки блоків картки й вкладок: кожна задача дописує свої. */
  const PUR_BINDS = [];

  /** «✕ Прибрати» в «Гроші»: питання називає рядок і суму, документи, що перейдуть на рядок, який лишається, і ті, де частки на
   *  прибраному лишаться (`purLineDrop`); «так» прибирає рядок і знімає частки документів, що переходять. */
  function purFundDel(pu, i) {
    const f = pu && pu.funds[+i];
    if (!f) return null;
    const label = (budById(f.line) || {}).label || 'рядок коштів';
    const drop = purLineDrop(pu, purCtx(), f.line);
    const to = (budById(drop.to) || {}).label || 'рядок коштів';
    const names = (list) => list.map(pdLabel).join(', ');
    const ask = [`Прибрати із закупівлі «${pu.title}» рядок коштів «${label}» на ${grnOf(f.kop)} грн?`,
      drop.move.length ? `На рядок «${to}» перейдуть: ${names(drop.move)}.` : '',
      drop.stuck.length ? `Частки на рядку «${label}» лишаються в: ${names(drop.stuck)}; перерозкладіть їх.` : ''];
    if (!confirm(ask.filter(Boolean).join('\n\n'))) return null;
    pu.funds.splice(+i, 1);
    for (const d of drop.move) {
      d.parts = [];
      logChange('частки документа знято', `purdoc|${d.id}`, `${pdLabel(d)}: ${label} → ${to}`);
    }
    logChange('рядок коштів прибрано із закупівлі', `pur|${pu.id}`, `${pu.title}: ${label}`);
    save();
    return render();
  }

  /** Дії справ закупівель. Наступні задачі дописують свої `case` перед `default:`: статична перевірка
   *  tests/test_app_js.py шукає саме `case '…'` (дія без нього — «кнопка без обробника»), а маршрут
   *  `startsWith('pur-')` пускає сюди лише дії `pur-…` (дії інших префіксів — у своїх функціях). */
  function purAction(act, d) {
    const pu = state.purId ? purById(state.purId) : null;
    switch (act) {
      case 'pur-new': return purNew();
      case 'pur-open': return go('purch', { purId: d.id });
      case 'pur-close': return go('purch', { purId: null });
      case 'pur-folder': return purOpenFolder(purById(d.id));
      case 'pur-edit': return purEditDialog(purById(d.id));
      case 'pur-fund-del': return purFundDel(pu, d.i);
      case 'pur-pos-new': { const v = pu && purVersion(pu); return pu && !purVerSent(v) ? posDialog(pu, v, null) : null; }
      case 'pur-pos': {
        const v = pu && purVersion(pu);
        const p = v && !purVerSent(v) ? (v.positions || [])[+d.i] : null;
        return p ? posDialog(pu, v, p) : null;
      }
      case 'pur-pos-del': return purPosDel(pu, d.i);
      case 'pur-fit': { const v = pu && purVersion(pu); return v && !purVerSent(v) && (v.positions || []).length ? purFitDialog(pu, v) : null; }
      case 'pur-paper': return purPaper(pu, pu && purVersion(pu), d.paper, d.key);
      case 'pur-sent': return purSentDialog(pu, pu && purVersion(pu));
      case 'pur-receive': return purReceive(pdById(d.id));
      case 'pur-av-new': return purAvNew(d.doc);
      case 'pur-link': return purLinkDialog(d.doc ? +d.doc : 0, d.doc ? null : pu);
      case 'pur-rcpt': return openDoc(d.key);
      case 'pur-xls': return purXls();
      case 'pur-book': return purBookDialog();
      case 'pur-book-export': modalClose(); return purBookExport();
      case 'pur-book-import': modalClose(); return purBookImport();
      case 'pur-files-find': return purFilesFind();
      case 'pur-folder-pick': return purFolderPick(d.key);
      default: return null;
    }
  }

  /** Тека справи записується в неї при першій же дії з файлами (підшити скан, скласти папір, «Відкрити теку»). Справа з рядка
   *  книги без «теки» показується з текою «рік/тема» (`purDirOf`), але не пише її: після перейменування файли розійшлися б по
   *  двох теках. Лише з дії, ніколи під час показу. */
  function purPinFolder(pu) {
    if (!pu || pu.folder) return false;
    const dir = purDirOf(pu);
    if (!dir) return false;
    pu.folder = dir;
    save();
    return true;
  }
  /** Справа, чия тека береться для файла з ключем: папір версії `purver|…` чи договір `purdoc|…` (інші документи лежать у теках
   *  служби за роком і не залежать від теки справи). */
  function purOfFileKey(key) {
    const [kind, id] = String(key).split('|');
    if (kind === 'purver') return purList().find((p) => (p.versions || []).some((v) => v.id === id)) || null;
    if (kind === 'purdoc') {
      const d = pdById(id);
      return d && d.kind === 'договір' ? purById(d.purchase) : null;
    }
    return null;
  }
  /** Чому файл до цього запису закупівлі зараз не підшивають («» — можна). Лист штабу називається за відповіддю («Погодження» чи
   *  «Не погоджено»): поки відповіді нема, лист про відмову отримав би ім'я «Погодження». Кнопки без відповіді нема, а це — те
   *  саме для дії, до якої дійшли іншим шляхом (екран, не перемальований після зміни відповіді в іншому вікні). */
  function purFileRefusal(key) {
    const [kind, id, what] = String(key).split('|');
    if (kind !== 'purver' || what !== 'відповідь') return '';
    const pu = purOfFileKey(key);
    const v = pu && (pu.versions || []).find((x) => x.id === id);
    return v && !v.answer ? 'Спершу внесіть відповідь штабу: лист називається за нею.' : '';
  }
  /** «Відкрити теку»: Провідник показує саму теку справи (`api/reveal` приймає й каталог); якої ще немає — сервер
   *  створює її (`make`), тож відкривається й тека нової справи, у якій нічого немає. */
  async function purOpenFolder(pu) {
    const dir = pu ? purDirOf(pu) : '';
    if (!dir) return;
    purPinFolder(pu);
    try {
      const r = await fetch('api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: 'purchases', path: dir, make: true }) });
      if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
    } catch (e) {
      toast(`Не вдалося відкрити теку: ${e.message || e}`, true);
    }
  }

  // ------------------------------------------------ книга «Закупівлі» туди й назад, пошук файлів, файли з теки
  /** Відповідь сервера як `{ status, ok, j }`: `j` — завжди об'єкт, а текст помилки (400, 413, 500 приходять простим текстом) — його `error`. */
  async function purReply(r) {
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    return { status: r.status, ok: r.ok, j: j && typeof j === 'object' && !Array.isArray(j) ? j : { error: text } };
  }
  const purPost = async (url, body) => purReply(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) }));

  /** Вивантаження, перегляд і прийом книги, як і пошук файлів, йдуть по одному: друге натискання, поки перше не повернулось, нічого не робить. */
  let purBookBusy = false;
  /** «Книга «Закупівлі»…»: книга туди й назад — запасний шлях (головний принцип), тож її кнопки — у вікні, а не в шапці «Справ». */
  function purBookDialog() {
    modalOpen('Книга «Закупівлі»', `<div class="pad" id="pur-book" style="display:flex;flex-wrap:wrap;gap:8px">
      <button class="btn" data-act="pur-book-export">Вивантажити книгу</button>
      <button class="btn" data-act="pur-book-import">Прийняти книгу…</button></div>`, 'modal__box--form');
  }
  /** «Вивантажити книгу»: «Закупівлі.xlsx» і порожні бланки лягають у теку «Закупівлі». Книгу з внесеним руками сервер не перезаписує (409):
   *  вікно називає рядки й відсилає до «Прийняти книгу…»; книга, відкрита в Excel (теж 409), — лише слово сервера. */
  async function purBookExport() {
    if (purBookBusy) return;
    purBookBusy = true;
    try {
      await flush();                                                   // книга — з бази: щойно внесене спершу лягає в неї
      const { status, ok, j } = await purPost('api/pur-book/export', {});
      if (status === 409) { alert(purBookSay(j.error || 'Книгу не вивантажено.', j.rows, 12)); return; }
      if (!ok || !j.ok) { toast(j.error || `помилка ${status}`, true); return; }
      if (j.download) {                                                // з іншого ПК книга віддається завантаженням
        const a = document.createElement('a');
        a.href = j.download;
        a.download = 'Закупівлі.xlsx';
        document.body.appendChild(a);                                  // не всі браузери завантажують за кліком по елементу поза сторінкою
        a.click();
        a.remove();
      }
      const done = purBookDone(j);
      toast(done.text, done.bad);
    } catch (e) {
      toast(`Не вдалося вивантажити книгу: ${e.message || e}`, true);
    } finally {
      purBookBusy = false;
    }
  }
  /** «Прийняти книгу…»: вибір файла → перелік відмінностей від бази за аркушами → «Прийняти все» (усе або нічого, з копією бази). Обраний
   *  файл лишається тут: коли закупівлі в базі змінились після перегляду, «Прийняти все» переглядає той самий файл ще раз (`look`). */
  function purBookImport() {
    if (purBookBusy) return;
    pickFile('.xlsx', (file) => {                                     // вікно вибору відкривається в самому кліку: далі нічого не чекаємо
      const look = () => purBookPreview(file, look);
      return look();
    });
  }
  /** Перегляд книги: сервер рахує відмінності від бази й пам'ятає, що показано (`sha`). `again` — перегляд того самого файла наново. */
  async function purBookPreview(file, again = null) {
    if (purBookBusy) return;
    purBookBusy = true;
    try {
      await flush();
      const { status, ok, j } = await purReply(await fetch('api/pur-book/preview', { method: 'POST', body: file }));
      if (status === 422) { purBookRefused('Книга не приймається', j.error || 'Книга не приймається.', j.problems); return; }
      if (!ok || !j.ok) { toast(j.error || `помилка ${status}`, true); return; }
      const same = !!(j.diff && j.diff.same);
      const sheet = (x) => `<p data-sheet="${esc(x.sheet)}"><b>${esc(x.sheet)}</b>: ${esc(x.say)}${
        x.lists.map((l) => `<br><small>${esc(l)}</small>`).join('')}</p>`;
      const el = modalOpen('Прийняти книгу «Закупівлі»', `<div class="pad op-preview" id="pur-book-diff">
        <p class="set-note">${esc(file.name)}</p>
        ${same ? '<p>Відмінностей немає.</p>' : purDiffRows(j.diff).map(sheet).join('')}
        <div class="set-form__acts" style="padding-top:12px">${same ? '<button class="btn" type="button" data-md="close">Закрити</button>'
    : `<button class="btn" type="button" data-md="close">Скасувати</button>
          <button class="btn btn--primary" type="button" data-pur-apply>Прийняти все</button>`}</div></div>`, 'modal__box--form');
      el.querySelector('[data-pur-apply]')?.addEventListener('click', (e) => purBookApply(j.sha, e.currentTarget, again));
    } catch (e) {
      toast(`Книгу не прочитано: ${e.message || e}`, true);
    } finally {
      purBookBusy = false;
    }
  }
  /** Вікно з переліком того, чому книгу не прийнято: аркуш і рядок у кожному рядку, не більш як тридцять, решта — «… ще N». Слово
   *  сервера («книга не приймається») повторювало б заголовок, тож там, де є перелік, його замінює прохання виправити; без переліку
   *  (перегляд застарів, збій) слово сервера — єдине, що є. */
  function purBookRefused(title, error, problems) {
    const list = purClip(Array.isArray(problems) ? problems : [], 30);
    const lead = list.length ? 'Виправте в книзі рядки з переліку й оберіть її ще раз.' : String(error).replace(/^./, (c) => c.toUpperCase());
    modalOpen(title, `<div class="pad" id="pur-book-problems"><p>${esc(lead)}</p>${list.length ? listHtml(list) : ''}
      <div class="set-form__acts" style="padding-top:12px"><button class="btn" type="button" data-md="close">Закрити</button></div></div>`, 'modal__box--form');
  }
  /** «Прийняти все»: одне питання, тоді копія бази й прийом на сервері. Прийнято — вікно оновлюється, як після прийому книги ОП, і каже
   *  ім'я копії; відмова (книга з помилкою, перегляд застарів) лишає базу такою, як була. Закупівлі в базі змінились після перегляду —
   *  сервер нічого не міняє й відповідає 409 з новими відмінностями: слово сервера стає плашкою, а той самий файл переглядається
   *  наново (`again`), і вікно показує свіжі відмінності. Інші відмови — як завжди. */
  async function purBookApply(sha, button, again = null) {
    if (purBookBusy) return;
    if (!confirm('Прийняти книгу? Закупівлі в програмі стануть такими, як у файлі; перед цим програма збереже копію бази.')) return;
    purBookBusy = true;
    button.disabled = true;
    let applied = false;
    let stale = false;
    try {
      if (await flush() !== true) { toast('Внесене в цьому вікні ще не записано: книгу не прийнято.', true); return; }
      const { status, ok, j } = await purPost('api/pur-book/apply', { sha });
      if (status === 409 && j.diff && again) {
        stale = true;
        toast(j.error || 'Закупівлі змінились після перегляду.', true);
        return;
      }
      if (!ok || !j.ok) { purBookRefused('Книгу не прийнято', j.error || `помилка ${status}`, j.problems); return; }
      applied = true;
      purReload(`Книгу прийнято. Копія бази: ${j.backup}.`);
    } catch (e) {
      toast(`Не вдалося прийняти книгу: ${e.message || e}`, true);
    } finally {
      purBookBusy = false;
      if (!applied) button.disabled = false;                          // прийнято — вікно оновлюється, повторне натискання не потрібне
      if (stale) await again();                                        // уже не зайнято: перегляд наново відкриває своє вікно
    }
  }
  /** Базу змінив сервер, тож вікно береться за свіжі дані (як після прийому книги ОП): екран, рік і прокрутка лишаються, а слово
   *  про копію бази показується вже в оновленому вікні — до оновлення воно зникло б разом із ним. */
  function purReload(note) {
    syncFresh({ note });
    if (!sync.leaving) { sync.leaving = true; location.reload(); }     // сховища вікна нема: оновлюємось без слова
  }

  /** «Знайти файли»: файли закупівель (рядок коштів, версія, документ, реєстр на ФЕС), яких немає на місці — теку чи файл перенесли
   *  Провідником, — шукаються за вмістом у своїй теці служби. Знайдений файл перепідшивається на новий шлях, решта запису лишається.
   *  Запис без відбитка вмісту не знайти: він лишається серед не знайдених. Лише на основному ПК (теки видно тільки йому). */
  async function purFilesFind() {
    if (purBookBusy) return;
    purBookBusy = true;
    try {
      const mine = (store.scans || []).filter((f) => PUR_FILE_KEY.test(f.key) && f.folder && f.path);
      if (!mine.length) { toast(purFoundWord(0, 0)); return; }          // файлів закупівель ще немає (чиста програма): питати сервер нема про що
      // Зниклі — за тією самою перевіркою, що й «Потребує уваги»: сервер дивиться в теки служби, сторінка диска не бачить.
      const seen = await purPost('api/scan-check', { paths: [], files: mine.map((f) => ({ folder: f.folder, path: f.path })) });
      if (!seen.ok) { toast(seen.j.error || `помилка ${seen.status}`, true); return; }
      const gone = new Set((seen.j.missingFiles || []).map((f) => `${f.folder}|${f.path}`));
      const lost = mine.filter((f) => gone.has(`${f.folder}|${f.path}`));
      const asked = lost.filter((f) => f.sha).map((f) => ({ folder: f.folder, path: f.path, sha: f.sha, size: f.size }));
      let found = 0;
      if (asked.length) {
        const got = await purPost('api/files-find', { files: asked });
        if (!got.ok) { toast(got.j.error || `помилка ${got.status}`, true); return; }
        for (const x of got.j.found || []) {
          for (const f of lost) {
            if (f.folder !== x.folder || f.path !== x.was) continue;
            logChange('файл знайдено за вмістом', f.key, `${f.file}: ${x.was} → ${x.path}`);
            f.path = x.path;
            f.folder = x.folder;                                       // тека — та, де сервер знайшов файл (шукає в теці запису)
            found++;
          }
        }
      }
      if (found) {
        save(true);
        render();
        checkFiles();                                                  // «Потребує уваги» не називає вже знайдене
      }
      toast(purFoundWord(found, lost.length - found));
    } catch (e) {
      toast(`Не вдалося знайти файли: ${e.message || e}`, true);
    } finally {
      purBookBusy = false;
    }
  }
  /** «Підшити з теки…»: файл, який людина вже поклала Провідником у теку запису (папір версії — у теку версії), підшивається на місці,
   *  без копії: записуються його тека служби, шлях, розмір і відбиток. У переліку — файли теки, яких ще ніде не підшито, найновіші
   *  вгорі. Тека справи без «теки» закріплюється, щойно відкривається вікно (`purPinFolder`), ще до вибору файла: перелік і підшитий
   *  файл — з тієї самої теки. */
  async function purFolderPick(key) {
    purPinFolder(purOfFileKey(key));
    const where = purFolderFor(key);
    if (!where) { toast('Запису вже немає в справі: файл не підшито.', true); return; }
    let listed;
    try {
      listed = await purReply(await fetch(`api/folder-list?key=${encodeURIComponent(where.folder)}&path=${encodeURIComponent(where.dir)}`));
    } catch (e) {
      toast(`Теку не прочитано: ${e.message || e}`, true);
      return;
    }
    const { ok, j } = listed;
    if (!ok || !j.ok) { toast(j.error || 'Теку не прочитано.', true); return; }
    const pathOf = (name) => [where.dir, name].filter(Boolean).join('/');
    const taken = new Set((store.scans || []).filter((f) => f.folder === where.folder).map((f) => f.path));
    const free = (j.files || []).filter((f) => !taken.has(pathOf(f.name)))
      .sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')) || a.name.localeCompare(b.name, 'uk'));
    const rows = free.map((f) => `<div class="tbl__row tbl__row--plain"><div class="c-txt" title="${esc(f.name)}">${esc(f.name)}</div>
      <div class="c-num" style="width:76px">${esc(fmtSize(f.size))}</div><div class="c-date" style="width:132px">${esc(fmtStamp(f.mtime))}</div>
      <div class="c-acts" style="flex-basis:96px"><button class="btn btn--sm" type="button" data-pick-file="${esc(f.name)}" aria-label="Підшити файл ${esc(f.name)}">Підшити</button></div></div>`).join('');
    const el = modalOpen('Підшити з теки', `<div class="pad" id="pur-folder-pick">
      <p class="set-note" style="padding-bottom:6px">Тека «${esc(SERVICE_FOLDERS[where.folder] || where.folder)}»: ${esc(where.dir || '.')}</p>
      ${free.length ? `<div class="tbl" style="--tbl-min:auto">${rows}</div>` : '<p>У теці немає файлів, яких ще не підшито.</p>'}</div>`, 'modal__box--form');
    el.querySelectorAll('[data-pick-file]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      const path = pathOf(b.dataset.pickFile);
      try {
        const got = await purPost('api/folder-link', { folder: where.folder, path });
        if (!got.ok || !got.j.ok) { toast(got.j.error || 'Файл не підшито.', true); return; }
        store.scans = store.scans || [];
        if (!store.scans.some((f) => f.folder === where.folder && f.path === path)) {          // двічі натиснули: запис один
          store.scans.push({ key, date: today(), no: '', file: got.j.file, path, mime: got.j.mime, size: got.j.size, added: today(),
            folder: where.folder, sha: got.j.sha });
          logChange('файл підшито з теки', key, got.j.file);
        }
        modalClose();
        save(true);
        toast(`Підшито файл: ${got.j.file}.`);
        render();
      } catch (e) {
        toast(`Файл не підшито: ${e.message || e}`, true);
      } finally {
        b.disabled = false;
      }
    }));
  }
  function purEditDialog(pu) {
    if (!pu) return;
    const el = modalOpen(`Закупівля · ${pu.title}`, `<form id="pur-edit" class="pad"><div class="form__grid">
        <div class="field field--span"><label>Тема</label><input name="title" value="${esc(pu.title)}" required></div>
        <div class="field field--span"><label>Що купуємо</label><input name="what" value="${esc(pu.what)}"></div>
        <div class="field"><label>Відповідальний</label><select name="person">${personOptions(pu.person, today(), '—')}</select></div>
        <div class="field"><label>Позначка</label><select name="closed">${['', 'завершено', 'скасовано'].map((v) =>
    `<option value="${v}"${pu.closed === v ? ' selected' : ''}>${v || '—'}</option>`).join('')}</select></div>
        <div class="field field--span"><label>Примітка</label><input name="note" value="${esc(pu.note)}"></div></div>
      <div class="pad" data-pur-msg hidden style="color:var(--bad)"></div>
      <div style="padding-top:12px"><button class="btn btn--primary" type="submit">Зберегти</button>
        <button class="btn" type="button" data-md="close">Скасувати</button>
        ${!purDocsList().some((x) => x.purchase === pu.id) ? '<button class="btn btn--danger" type="button" data-pur-del>Видалити закупівлю</button>' : ''}</div></form>`);
    const msg = el.querySelector('[data-pur-msg]');
    el.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      msg.hidden = true;
      const f = new FormData(e.target);
      const title = String(f.get('title') || '').trim().replace(/\s+/g, ' ');
      if (!title) { msg.hidden = false; msg.textContent = 'Тему закупівлі не вказано.'; return; }
      const why = purTwinWhy(pu.year, title, pu);
      if (why) { msg.hidden = false; msg.textContent = why; return; }
      Object.assign(pu, { title, what: String(f.get('what') || '').trim(),
        closed: String(f.get('closed') || ''), person: String(f.get('person') || ''), note: String(f.get('note') || '').trim() });
      logChange('закупівлю виправлено', `pur|${pu.id}`, pu.title);
      modalClose();
      saveThen('Закупівлю збережено.');
      render();
    });
    el.querySelector('[data-pur-del]')?.addEventListener('click', () => {
      if (!confirm(`Видалити закупівлю «${pu.title}»?\n\nФайли в теці лишаться.`)) return;
      store.purchases = purList().filter((p) => p.id !== pu.id);
      // Записи про її файли йдуть разом із нею (версії — `purver|<id>|…`, документи — `purdoc|<id>`); самі файли лишаються в
      // теці: програма файлів не видаляє.
      const keys = new Set([...(pu.versions || []).map((v) => `purver|${v.id}`),
        ...purDocsList().filter((d) => d.purchase === pu.id).map((d) => `purdoc|${d.id}`)]);
      store.scans = (store.scans || []).filter((f) => !keys.has(String(f.key).split('|').slice(0, 2).join('|')));
      logChange('закупівлю видалено', `pur|${pu.id}`, pu.title);
      modalClose();
      save(true, true);
      go('purch', { purId: null });
    });
  }

  // ---------------------------------------------------------------- позиції й версії
  /** Версію подано, коли в неї є № супроводу чи відповідь штабу (як у `purState`): подану не правлять. */
  const purVerSent = verSent;
  /** Чому закупівлю цього року з такою темою не заводять (і не перейменовують): така тема чи така тека (Windows не розрізняє
   *  регістру: «Плити/кухня» і «Плити-кухня» — одна тека) вже є в іншої. Порожній рядок — можна. `own` — справа, яку правлять:
   *  вона не двійник собі, а поки в неї є своя тека, її назва теки від теми не залежить — тоді рахується лише тема. Справа без
   *  теки (рядок книги) має «рік/тема», тож нова тема міняє й теку. Єдине місце, де порівнюють теми й теки справ. */
  function purTwinWhy(year, title, own = null) {
    const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
    const folder = own && own.folder ? '' : `${year}/${safeFile(title)}`;
    const twin = purList().find((p) => p !== own && +p.year === +year && (same(p.title, title) || (folder && same(purDirOf(p), folder))));
    if (!twin) return '';
    return same(twin.title, title) ? `Закупівля «${title}» за ${year} рік уже є.`
      : `Тека «${purDirOf(twin)}» уже належить закупівлі «${twin.title}».`;
  }
  /** КЕКВ і код видатків позиції — ті, що пропонує ціна. Пара, запропонована за колишньою ціною (чи порожня) і не виправлена,
   *  йде за новою ціною; вписана руками лишається. `prev` — позиція до правки, `typed` — що стоїть у полях. */
  function purKekvAfter(prev, typed, priceKop) {
    const was = kekvFor(prev.priceKop);
    const now = kekvFor(priceKop);
    const untouched = typed.kekv === prev.kekv && typed.exp === prev.exp;
    const followed = (!prev.kekv && !prev.exp) || (prev.kekv === was.kekv && prev.exp === was.exp);
    if (untouched && followed) return now;
    return { kekv: typed.kekv || now.kekv, exp: typed.exp || now.exp };
  }

  /** Пропозиції, з яких береться ціна позиції за її правилом: посилання з ціною («середня»), перша КП з ціною («КП»), жодної
   *  («вручну»). Так само, як `posPrice`: лічильник «N ц.» під ціною каже про них, а не про все, що записано в позиції. */
  function posOffersUsed(p) {
    const priced = (p.offers || []).filter((o) => +o.priceKop > 0);
    if (p.rule === 'середня') return priced.filter((o) => o.kind === 'посилання');
    if (p.rule === 'КП') return priced.filter((o) => o.kind === 'КП').slice(0, 1);
    return [];
  }

  /** Блок «Позиції»: позиції останньої версії пакета (картка показує одну версію — `purVersion`), кнопки в один рядок, «розраховано
   *  X із Y» окремим рядком над таблицею, таблиця з підписами стовпців. Справа з книги без версій заводить першу «+ Позиція». */
  PUR_BLOCKS.push((pu) => {
    const v = purVersion(pu);
    const positions = (v && v.positions) || [];
    const ro = purVerSent(v);
    const total = verKop(v);
    const target = (pu.funds || []).reduce((s, f) => s + (+f.kop || 0), 0);
    const rows = positions.map((p, i) => {
      const used = posOffersUsed(p);
      return `<div class="tbl__row tbl__row--plain" data-pos="${esc(p.id)}">
        <div class="c-num pur-pos__n">${i + 1}</div>
        <div class="c-name c-name--stack pur-pos__name"><b>${esc(p.name || '—')}</b><small>${esc([p.uom, p.dk, p.code && `код ${p.code}`].filter(Boolean).join(' · '))}</small></div>
        <div class="c-num pur-pos__qty">${fmtNum(p.qty)}</div>
        <div class="c-num pur-pos__kop">${grnOf(p.priceKop)}<small>${esc(p.rule)}${used.length ? ` · ${used.length} ц.` : ''}</small></div>
        <div class="c-num pur-pos__kop">${grnOf(posKop(p))}</div>
        <div class="c-code pur-pos__code">${esc([p.kekv, p.exp].filter(Boolean).join('/'))}</div>
        <div class="c-acts">${ro ? '' : rowBtn('pur-pos', '✎ Виправити', `data-i="${i}"`, { title: 'Позиція й ціни' })
          + rowBtn('pur-pos-del', '✕ Прибрати', `data-i="${i}"`, { bad: true, title: 'Прибрати позицію' })}</div></div>`;
    }).join('');
    const head = `<div class="tbl__head"><div class="tbl__h c-num pur-pos__n">№</div><div class="tbl__h c-name pur-pos__name">найменування</div>
      <div class="tbl__h c-num pur-pos__qty">кількість</div><div class="tbl__h c-num pur-pos__kop">ціна, грн</div>
      <div class="tbl__h c-num pur-pos__kop">сума, грн</div><div class="tbl__h c-code pur-pos__code">КЕКВ / код</div><div class="tbl__h c-acts"></div></div>`;
    const rest = !target || total === target ? ''
      : total > target ? ` · <span class="num-bad">перевищено на ${grnOf(total - target)}</span>`
        : ` · <span class="num-warn">лишилось ${grnOf(target - total)}</span>`;
    return `<div class="card pur-block pur-pos-block"><div class="card__head"><div class="card__title">Позиції</div>
        <div class="panel__spacer"></div>
        ${ro ? '' : `<button class="btn btn--sm" data-act="pur-pos-new">+ Позиція</button>${
          positions.length ? '<button class="btn btn--sm" data-act="pur-fit">Підігнати до суми</button>' : ''}`}</div>
      <div class="pur-pos-sum">розраховано ${grnOf(total)}${target ? ` із ${grnOf(target)}` : ''}${rest}</div>
      <div class="tbl pur-pos">${rows ? head + rows : '<div class="tbl__row tbl__row--plain"><div class="c-txt">Позицій ще немає.</div></div>'}</div></div>`;
  });

  /** Вікно позиції: нова (`p` порожня) чи виправлення. Ціна — середня з посилань, ціна комерційної пропозиції (КП) чи вписана
   *  вручну. Показано всі посилання (не менше трьох) і всі КП: ціну `posPrice` бере з перших із ціною, і нічого, що її задає,
   *  не лишається прихованим. Кількість читає `qtyIn`, суми — `moneyIn`: що не число, нулем не пишеться — поля червоніють разом,
   *  слово лежить у самому вікні, а позиція не міняється. Ціна, якої правило не дає, теж не стає мовчки нулем: вписана вручну
   *  чи колишня ціна, а за правилом ціни немає, — відмова словом. Дані, яких вікно не показує (дата перевірки, примітки), лишаються. */
  function posDialog(pu, v, p) {
    const fresh = !p;
    const rec = JSON.parse(JSON.stringify(p || posBlank()));
    const prev = { priceKop: +rec.priceKop || 0, kekv: rec.kekv || '', exp: rec.exp || '' };
    rec.offers = rec.offers || [];
    const links = rec.offers.filter((o) => o.kind === 'посилання');
    while (links.length < 3) links.push(offerBlank('посилання'));
    const quotes = rec.offers.filter((o) => o.kind === 'КП');
    if (!quotes.length) quotes.push(offerBlank('КП'));
    const kn = (k, i) => (i ? `${k}${i}` : k);                 // поля першої КП — kpSeller, kpNo, kpDate, kpPrice; далі — з номером
    const lines = (pu.funds || []).map((f) => budById(f.line)).filter(Boolean);
    if (rec.line && budById(rec.line) && !lines.includes(budById(rec.line))) lines.push(budById(rec.line));
    const money = (kop) => (kop ? kopStr(kop) : '');
    const el = modalOpen(fresh ? 'Нова позиція' : `Позиція · ${rec.name}`, `<form id="pos-form" class="pad"><div class="form__grid">
        <div class="field field--span"><label>Найменування (як у 1ФС)</label><input name="name" value="${esc(rec.name)}" required autocomplete="off"></div>
        <div class="field field--span"><label>Технічні вимоги (ТТХ)</label><textarea name="specs" rows="2">${esc(rec.specs)}</textarea></div>
        <div class="field"><label>Одиниця</label><input name="uom" value="${esc(rec.uom)}" autocomplete="off"></div>
        <div class="field"><label>Кількість</label><input name="qty" inputmode="decimal" value="${esc(rec.qty)}" required autocomplete="off"></div>
        <div class="field"><label>Код ДК</label><input name="dk" value="${esc(rec.dk)}" autocomplete="off"></div>
        <div class="field"><label>Код номенклатури</label><input name="code" value="${esc(rec.code)}" placeholder="якщо вже є в обліку" autocomplete="off"></div>
        <div class="field"><label>Правило ціни</label><select name="rule">${PUR_RULES.map((r) => `<option${r === rec.rule ? ' selected' : ''}>${r}</option>`).join('')}</select></div>
        <div class="field"><label>Ціна вручну, грн</label><input name="hand" inputmode="decimal" autocomplete="off" value="${rec.rule === 'вручну' ? esc(money(rec.priceKop)) : ''}"></div>
        <div class="field"><label>КЕКВ</label><input name="kekv" value="${esc(rec.kekv)}" placeholder="за ціною" autocomplete="off"></div>
        <div class="field"><label>Код видатків</label><input name="exp" value="${esc(rec.exp)}" placeholder="за ціною" autocomplete="off"></div>
        <div class="field--span pur-links"><div class="pur-links__h">Посилання</div><div class="pur-links__h">Ціна, грн</div>
          ${links.map((o, i) => `<div class="field"><input name="url${i}" value="${esc(o.url)}" placeholder="https://" autocomplete="off" aria-label="Посилання ${i + 1}"></div>
          <div class="field"><input name="price${i}" inputmode="decimal" autocomplete="off" value="${esc(money(o.priceKop))}" aria-label="Ціна ${i + 1}, грн"></div>`).join('')}</div>
        <div class="field--span pur-kps"><div class="pur-links__h">${quotes.length > 1 ? 'Комерційні пропозиції' : 'Комерційна пропозиція'}</div>
          <div class="pur-links__h">№</div><div class="pur-links__h">Від</div><div class="pur-links__h">Ціна, грн</div>
          ${quotes.map((o, i) => `<div class="field"><input name="${kn('kpSeller', i)}" value="${esc(o.seller)}" placeholder="постачальник" autocomplete="off" aria-label="КП ${i + 1}: постачальник"></div>
          <div class="field"><input name="${kn('kpNo', i)}" value="${esc(o.no)}" autocomplete="off" aria-label="КП ${i + 1}: №"></div>
          <div class="field"><input name="${kn('kpDate', i)}" type="date" value="${esc(o.date)}" aria-label="КП ${i + 1}: від"></div>
          <div class="field"><input name="${kn('kpPrice', i)}" inputmode="decimal" autocomplete="off" value="${esc(money(o.priceKop))}" aria-label="КП ${i + 1}: ціна, грн"></div>`).join('')}</div>
        ${lines.length > 1 ? `<div class="field field--span2"><label>Рядок коштів</label><select name="line"><option value="">—</option>${lines.map((l) =>
    `<option value="${esc(l.id)}"${l.id === rec.line ? ' selected' : ''}>${esc(l.label)}</option>`).join('')}</select></div>` : ''}
        <div class="field ${lines.length > 1 ? 'field--span2' : 'field--span'}"><label>Примітка</label><input name="note" value="${esc(rec.note)}" autocomplete="off"></div></div>
      <div class="pos-foot"><div class="pad" data-pur-msg hidden style="color:var(--bad)"></div>
        <div><button class="btn btn--primary" type="submit">Зберегти</button>
          <button class="btn" type="button" data-md="close">Скасувати</button></div></div></form>`);
    const form = el.querySelector('form');
    const msg = el.querySelector('[data-pur-msg]');
    const fail = (field, text) => {                              // слово — у липкому низі вікна (видиме саме); поле, з якого воно, — у фокусі й червоне
      field.classList.add('is-bad');
      msg.hidden = false;
      msg.textContent = text;
      field.focus();
    };
    let autoHand = rec.rule === 'вручну' ? money(rec.priceKop) : '';        // що в «Ціна вручну» поставила сама програма: людиною вписане воно не вважається
    form.elements.rule.addEventListener('change', () => {
      const hand = form.elements.hand;
      const now = hand.value.trim();
      if (form.elements.rule.value === 'вручну') {
        if (!now && prev.priceKop) hand.value = autoHand = money(prev.priceKop);   // «вручну» замість «середня» чи «КП»: ціна лишається, а не стає нулем
      } else if (now && now === autoHand) {
        hand.value = '';                                                           // а назад — поставлене програмою не лишається в полі як вписане
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      msg.hidden = true;
      const f = new FormData(form);
      const g = (k) => String(f.get(k) || '').trim();
      const rule = g('rule');
      const bad = [];                                        // поля, що не пройшли: червоніють усі, слово — про перше з них
      const miss = (field) => (text) => bad.push([field, text]);
      const name = g('name').replace(/\s+/g, ' ');
      form.elements.name.classList.toggle('is-bad', !name);
      if (!name) bad.push([form.elements.name, 'Найменування не вказано.']);
      const qty = qtyIn(form.elements.qty, miss(form.elements.qty));
      const prices = links.map((o, i) => moneyIn(form.elements[`price${i}`], miss(form.elements[`price${i}`])));
      const kpPrices = quotes.map((o, i) => moneyIn(form.elements[kn('kpPrice', i)], miss(form.elements[kn('kpPrice', i)])));
      form.elements.hand.classList.remove('is-bad');
      const typedHand = g('hand');                           // вписана людиною (порожнє поле — ні)
      const hand = rule === 'вручну' || typedHand ? moneyIn(form.elements.hand, miss(form.elements.hand)) : 0;
      if (bad.length) { fail(bad[0][0], bad[0][1]); return; }
      if (rule === 'вручну' && !typedHand && prev.priceKop > 0) { fail(form.elements.hand, 'Впишіть ціну.'); return; }   // порожня — не нуль
      rec.name = name; rec.specs = g('specs'); rec.uom = g('uom'); rec.qty = qty; rec.dk = g('dk'); rec.code = g('code');
      rec.rule = rule; rec.note = g('note');
      if (form.elements.line) rec.line = g('line');          // «—» знімає рядок; без вибору (рядок один) лишається як був
      // Нові об'єкти, а не правка наявних: відмова нижче лишає вікно відкритим, і повторне «Зберегти» рахує від колишнього.
      // Пропозиція зникає лише тоді, коли людина спорожнила її рядок: у ньому було що показати (посилання — адреса чи ціна; КП —
      // постачальник, №, дата чи ціна), а тепер нічого. Усе інше з будь-якими даними (адреса, примітка, дата перевірки, продавець…)
      // лишається, навіть коли рядок цього не показує; порожнього нового рядка — нема.
      const linkShown = (o) => !!(+o.priceKop || o.url);
      const quoteShown = (o) => !!(+o.priceKop || o.seller || o.no || o.date);
      const anyData = (o) => !!(+o.priceKop || o.url || o.seller || o.no || o.date || o.note || o.checked);
      const made = links.map((o, i) => ({ ...o, priceKop: prices[i], url: g(`url${i}`),
        // Продавець — із адреси, але лише коли адресу змінили чи продавця ще не було: вписаного раніше (книга, імпорт) вікно не перебиває.
        seller: o.seller && g(`url${i}`) === String(o.url || '').trim() ? o.seller
          : (g(`url${i}`).match(/^https?:\/\/([^/]+)/) || [])[1] || o.seller || '',
        checked: prices[i] && (prices[i] !== (+o.priceKop || 0) || !o.checked) ? today() : (o.checked || '') }))
        .filter((n, i) => (linkShown(links[i]) ? linkShown(n) : anyData(n)));
      const kept = quotes.map((o, i) => ({ ...o, seller: g(kn('kpSeller', i)), no: g(kn('kpNo', i)), date: g(kn('kpDate', i)),
        priceKop: kpPrices[i] })).filter((n, i) => (quoteShown(quotes[i]) ? quoteShown(n) : anyData(n)));
      rec.offers = made.concat(kept);
      if (rule === 'вручну') rec.priceKop = hand;
      rec.priceKop = posPrice(rec);
      if (rule !== 'вручну') {
        if (!rec.priceKop && ((typedHand && hand) || prev.priceKop > 0)) {         // вписана чи колишня ціна, а правило її не дає
          fail(rule === 'КП' ? form.elements.kpPrice : form.elements.price0, `За правилом «${rule}» ціни немає — впишіть ${
            rule === 'КП' ? 'ціну КП' : 'ціни за посиланнями'} або оберіть «вручну».`);
          return;
        }
        if (rec.priceKop && typedHand && hand !== rec.priceKop) {                  // вписана ціна, якої правило не візьме, — не мовчки
          fail(form.elements.hand, 'Щоб узяти вписану ціну, оберіть «вручну».');
          return;
        }
      }
      Object.assign(rec, purKekvAfter(prev, { kekv: g('kekv'), exp: g('exp') }, rec.priceKop));
      if (!v) { v = verBlank('1.0', today()); pu.versions = (pu.versions || []).concat(v); }   // справа з книги без версій: перша — з першою позицією
      const at = v.positions.findIndex((x) => x.id === rec.id);
      if (at < 0) v.positions.push(rec); else v.positions[at] = rec;
      logChange(fresh ? 'позицію додано' : 'позицію виправлено', `pur|${pu.id}`, `${v.label}: ${rec.name} × ${fmtNum(rec.qty)} по ${grnOf(rec.priceKop)}`);
      modalClose();
      save();
      render();
    });
  }

  /** «Підігнати до суми»: ціна вибраної позиції добирається так, щоб разом дорівнювало сумі (за умовчанням — гроші закупівлі);
   *  коли рівно не виходить, ставиться найбільша ціна, з якою разом не перевищує суми (`fitPrice`), і сказано, скільки лишилось.
   *  Решта позицій уже на всю суму — відмова. */
  function purFitDialog(pu, v) {
    const target = (pu.funds || []).reduce((s, f) => s + (+f.kop || 0), 0);
    const el = modalOpen('Підігнати до суми', `<form id="fit-form" class="pad"><div class="form__grid">
        <div class="field"><label>Позиція</label><select name="pos">${v.positions.map((p, i) =>
    `<option value="${i}"${i === v.positions.length - 1 ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Разом має бути, грн</label><input name="target" inputmode="decimal" autocomplete="off" value="${target ? esc(kopStr(target)) : ''}"></div></div>
      <div class="pad" data-pur-msg hidden style="color:var(--bad)"></div>
      <div style="padding-top:12px"><button class="btn btn--primary" type="submit">Підігнати</button>
        <button class="btn" type="button" data-md="close">Скасувати</button></div></form>`, 'modal__box--form');
    const form = el.querySelector('form');
    const msg = el.querySelector('[data-pur-msg]');
    const fail = (text) => { msg.hidden = false; msg.textContent = text; };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      msg.hidden = true;
      const p = v.positions[+new FormData(form).get('pos')];
      const field = form.elements.target;
      if (!p) return;
      if (!field.value.trim()) { field.classList.add('is-bad'); fail('Суму не вказано.'); return; }
      const want = moneyIn(field, fail);
      if (want == null) return;
      const others = verKop(v) - posKop(p);
      if (!(+p.qty > 0)) { fail(`У позиції «${p.name}» не вказано кількість.`); return; }
      if (want - others <= 0) {
        field.classList.add('is-bad');
        fail(`Інші позиції вже на ${grnOf(others)} грн: на «${p.name}» не лишається нічого.`);
        return;
      }
      const got = fitPrice(want, others, p.qty);
      if (got.priceKop <= 0) {
        field.classList.add('is-bad');
        fail(`На «${p.name}» лишається ${grnOf(want - others)} грн: ціна за одиницю вийшла б менша за копійку.`);
        return;
      }
      const prev = { priceKop: +p.priceKop || 0, kekv: p.kekv || '', exp: p.exp || '' };
      p.rule = 'вручну';
      p.priceKop = got.priceKop;
      Object.assign(p, purKekvAfter(prev, prev, p.priceKop));
      logChange('ціну підігнано до суми', `pur|${pu.id}`, `${v.label}: ${p.name} по ${grnOf(p.priceKop)}${got.rest ? `, лишилось ${grnOf(got.rest)}` : ''}`);
      modalClose();
      save();
      render();
      if (got.rest) toast(`Рівно не виходить: лишилось ${grnOf(got.rest)} грн.`);
    });
  }

  function purPosDel(pu, i) {
    const v = pu && purVersion(pu);
    const p = v && !purVerSent(v) ? (v.positions || [])[+i] : null;
    if (!p || !confirm(`Прибрати позицію «${p.name}»?`)) return;
    v.positions.splice(+i, 1);
    logChange('позицію прибрано', `pur|${pu.id}`, `${v.label}: ${p.name}`);
    save(true, true);
    render();
  }

  // ---------------------------------------------------------------- пакет: папери, скани, подання й відповідь
  /** Папери версії: ключ файла, підпис у картці, папір сервера (порожньо — лише підшити скан). */
  const PUR_PAPERS = [['розрахунки', 'Розрахунки до рапорту', 'rozrakhunky'], ['рапорт', 'Рапорт з Додатком 1', 'raport'],
    ['1фс', '1ФС', '1fs'], ['9фс', '9ФС', '9fs'], ['супровід', 'Супровід', 'suprovid'], ['кп', 'Комерційні пропозиції', '']];
  /** Гроші для тексту паперу: «3 500,00» — звичайні пробіли між тисячами, кома, дві цифри копійок. Із `kopStr` (цілі числа), а не
   *  з ділення на 100: у double сума з трильйонів копійок мала б хвіст, а папір повторює копійки сторінки до одної. */
  const grnPlain = (kop) => {
    const [whole, frac] = kopStr(kop).split('.');
    return `${whole.replace(/\B(?=(\d{3})+$)/g, ' ')},${frac}`;
  };
  /** Підписант у папері — лише текст: `pid` людини з довідника й телефон виконавця в нього не йдуть. */
  const sgPlain = (x) => ({ pos: (x || {}).pos || '', rank: (x || {}).rank || '', name: (x || {}).name || '' });
  /** Дата паперу: підпис командира, а доки його нема, — сьогодні. За нею беруться місце складання й підписи з довідника. */
  const purPaperDate = (v) => v.signedOn || today();
  /** Рядок про комерційну пропозицію в Додатку 1: «Комерційна пропозиція ТОВ «Один» №7 від 02.02.2026» — з того, що вписано. */
  const purQuoteText = (o) => ['Комерційна пропозиція', o.seller, o.no && `№${o.no}`, o.date && `від ${fmtDate(o.date)}`]
    .filter(Boolean).join(' ');

  /** Специфікація паперу для сервера: реквізити частини, рядки коштів, позиції версії, підписанти. Гроші в ній — цілі копійки
   *  (сервер інших не приймає); місце складання — з дислокації на дату паперу, а не окреме поле реквізитів. */
  function purPaperSpec(pu, v, paper) {
    const u = unitInfo();
    const lines = (pu.funds || []).map((f) => budById(f.line)).filter(Boolean);
    const first = lines[0] || {};
    const s = v.signers || {};
    const positions = v.positions || [];
    const subs = lines.filter((l) => l.fund === 'Субвенція').length;
    const phrase = subs > 1 ? 'за рахунок субвенцій' : (PUR_PHRASE[first.fund] || '');
    const groups = [];
    for (const p of positions) {
      let g = groups.find((x) => x.kekv === p.kekv);
      if (!g) groups.push(g = { kekv: p.kekv, codes: [] });
      let c = g.codes.find((x) => x.exp === p.exp);
      if (!c) g.codes.push(c = { exp: p.exp, kop: 0 });
      c.kop += posKop(p);
    }
    const pairs = groups.flatMap((g) => g.codes.map((c) => ({ kekv: g.kekv, exp: c.exp, kop: c.kop })));
    const note = ['Просимо надати кошторисні призначення та асигнування по', first.kpkv || '', pairs.map((x) =>
      `КЕКВ ${x.kekv} код видатків ${x.exp} в сумі ${grnPlain(x.kop)} грн`).join(', '), `на ${pu.what || 'придбання майна'}.`]
      .filter(Boolean).join(' ');
    const signers = [sgPlain(s.cmdr), sgPlain(s.fes), sgPlain(s.chief)];
    const phone = (s.exec || {}).phone || u.phone || '';
    const spec = { unit: { name: u.legalName || '', code: unitCode(), edrpou: u.edrpou || '', fundCode: u.fundCode || '',
      service: u.serviceFull || '', place: locationAt(purPaperDate(v)), upperHq: u.upperHq || '', phone },
    year: pu.year, kpkv: first.kpkv || '' };
    if (paper === 'rozrakhunky') {
      spec.positions = positions.map((p) => {
        const offers = p.offers || [];
        return { name: p.name, qty: p.qty, specs: p.specs, priceKop: p.priceKop, kop: posKop(p),
          links: offers.filter((o) => o.kind === 'посилання' && o.url).map((o) => o.url)
            .concat(offers.filter((o) => o.kind === 'КП').map(purQuoteText)),
          offers: offers.map((o) => ({ kind: o.kind, seller: o.seller || '', url: o.url || '', priceKop: o.priceKop })) };      // робочий аркуш «Товари»
      });
      spec.chief = sgPlain(s.chief);
    } else if (paper === 'raport') {
      spec.chief = sgPlain(s.chief);
    } else if (paper === '1fs') {
      spec.rows = positions.map((p) => ({ kekv: p.kekv, exp: p.exp, name: p.name, uom: p.uom, qty: p.qty, priceKop: p.priceKop }));
      spec.general = first.fund === 'Загальний фонд';
      spec.signers = signers;
    } else if (paper === '9fs') {
      Object.assign(spec, { phrase, groups, note, signers, phone });
    } else if (paper === 'suprovid') {
      Object.assign(spec, { codes: pairs.map((x) => `КЕКВ ${x.kekv} код ${x.exp}`).join(', '), sumKop: verKop(v), phrase,
        cmdr: sgPlain(s.cmdr), attachments: lines.filter((l) => l.fund === 'Субвенція')
          .map((l) => `Рішення й угода ${l.community || l.label} – на ___ арк.`) });
    }
    return spec;
  }

  /** Слово, коли рядки коштів справи — з грошей закупівлі й з позицій версії (позиція може називати свій рядок) — різних КПКВ чи
   *  фондів. Папери беруть КПКВ, фразу про фонд і форму 1ФС з ПЕРШОГО рядка грошей закупівлі (`purPaperSpec`), решти рядків у них
   *  нема: людина має знати це до того, як віддасть папір на підпис. Порожньо — розбіжності нема (чи грошей закупівлі ще нема). */
  function purMixedLines(pu, v) {
    const first = (pu.funds || []).map((f) => budById(f.line)).filter(Boolean)[0];
    if (!first) return '';
    const ids = (pu.funds || []).map((f) => f.line).concat(((v && v.positions) || []).map((p) => p.line)).filter(Boolean);
    const lines = [...new Set(ids)].map((id) => budById(id)).filter(Boolean);
    const differs = (key) => lines.some((l) => (l[key] || '') !== (first[key] || ''));
    const what = [differs('kpkv') ? 'КПКВ' : '', differs('fund') ? 'фондів' : ''].filter(Boolean);
    return what.length ? `Рядки коштів різних ${what.join(' і ')}: папери складаються за першим із них («${first.label || 'без назви'}»).` : '';
  }

  /** Папери, які складаються зараз (ключі їхніх файлів): друге «Скласти», поки перше не повернулось, нічого не робить —
   *  два запити про один файл бачили б один одного «зміненим руками». */
  const purComposing = new Set();

  /** Скласти папір версії в її теку. Файл, змінений руками, програма без згоди не перезаписує: сервер відповідає 409, сторінка
   *  питає, і лише «так» шле запит ще раз із `force`. Теку справи без «теки» закріплює перший же папір. */
  async function purPaper(pu, v, paper, key, force = false) {
    if (!pu || !v || purVerSent(v) || !paper) return;
    const fk = `purver|${v.id}|${key}`;
    if (purComposing.has(fk)) return;
    // Excel і Word запускаються секунди: кнопка каже, що йде складання. Блок «Пакет» малює її так само, коли екран перемальовано
    // посеред складання (інший папір закінчився раніше), а після відмови вона вертається, бо екран тоді не перемальовується.
    // Кнопка — саме цієї версії й цього паперу: людина могла піти в іншу справу, і чужа кнопка не міняється.
    const mark = () => {
      const b = [...document.querySelectorAll('#scroll [data-act="pur-paper"]')].find((x) => x.dataset.ver === v.id && x.dataset.key === key);
      if (b) purPaperButton(b, purComposing.has(fk));
    };
    try {
      purComposing.add(fk);                                                       // усе, що може впасти, — у `try`: `finally` завжди знімає захист
      mark();
      let ask = await purPaperSend(pu, v, paper, fk, force);
      if (ask && !force) {
        if (!confirm(`${ask}\n\nЗміни, внесені у файл руками, буде втрачено.`)) return;
        ask = await purPaperSend(pu, v, paper, fk, true);                         // «так»: той самий запит, але з «force»
      }
      if (ask) toast(ask, true);                                                  // «force» був, а сервер питає знову, — це відмова, а не коло питань
    } catch (e) {
      toast(`Не вдалося скласти: ${e.message || e}`, true);
    } finally {
      purComposing.delete(fk);
      try { mark(); } catch (e) { /* екран змінився: кнопки вже нема */ }
    }
  }
  /** «Скласти» чи «Складається…»: слово й позначка кнопки паперу. */
  function purPaperButton(el, busy) {
    el.textContent = busy ? 'Складається…' : 'Скласти';
    el.classList.toggle('is-busy', busy);
  }
  /** Один запит `api/pur-paper`. Повертає питання сервера, коли файл змінено руками (409 `changed`); в усіх інших випадках — порожньо:
   *  складено, або слово про відмову вже показано. */
  async function purPaperSend(pu, v, paper, fk, force) {
    purPinFolder(pu);                                          // теку справи без «теки» закріплює перший папір — до того, як з неї береться шлях
    const where = purFolderFor(fk);
    if (!where) { toast('Версії вже немає в справі: папір не складено.', true); return ''; }
    const prev = (store.scans || []).find((f) => f.key === fk && f.made);
    let r;
    let j = {};
    try {
      const spec = Object.assign(purPaperSpec(pu, v, paper), { paper, dir: where.dir, prevSha: prev ? prev.sha || '' : '', force });
      r = await fetch('api/pur-paper', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
      const text = await r.text();
      try { j = JSON.parse(text); } catch (e) { j = { error: text }; }
    } catch (e) {
      toast(`Не вдалося скласти: ${e.message}`, true);
      return '';
    }
    if (r.status === 409 && j.changed) return j.error || 'Файл змінено після програми — перезаписати?';
    if (!r.ok || !j.ok) { toast(j.error || `помилка ${r.status}`, true); return ''; }       // 409 «відкрито в Excel чи Word» теж тут
    store.scans = (store.scans || []).filter((f) => !(f.key === fk && f.made));
    store.scans.push({ key: fk, date: today(), no: '', file: j.file, path: j.path, mime: '', size: j.size, added: today(),
      folder: j.folder, sha: j.sha, made: true });
    logChange('папір складено', `pur|${pu.id}`, `${v.label}: ${j.file}`);
    save(true);
    render();
    if (j.download) {                                           // з іншого ПК файл віддається завантаженням
      const a = document.createElement('a');
      a.href = j.download;
      a.download = j.file;
      document.body.appendChild(a);                             // не всі браузери завантажують за кліком по елементу поза сторінкою
      a.click();
      a.remove();
    }
    // .xls робить Excel основного ПК: з іншого ПК слово про його відсутність — про основний, а не про цей
    const noExcel = paper === '9fs' && !j.xls ? ` (.xlsx: на ${j.download ? 'основному' : 'цьому'} комп’ютері немає Excel для .xls)` : '';
    toast(`${j.opened ? 'Відкрито' : 'Складено'}: ${j.file}${noExcel}`);
    return '';
  }

  /** Стовпці таблиці підписантів: підпис у шапці, поле підписанта, ширина — ті самі в шапці й у рядках. Телефон — лише у виконавця
   *  (його вносять у 9/фс); в інших рядках його місце порожнє, щоб стовпці стояли рівно. */
  const PUR_SG_COLS = [['посада', 'pos', 'flex:2 1 220px'], ['звання', 'rank', 'flex:0 0 110px'],
    ['Ім’я ПРІЗВИЩЕ', 'name', 'flex:1 1 150px'], ['телефон', 'phone', 'flex:0 0 120px']];
  const purSgHead = () => `<div class="tbl__head"><div class="tbl__h" style="flex:0 0 130px">підписант</div>${PUR_SG_COLS.map(([ph, , style]) =>
    `<div class="tbl__h" style="${style};min-width:0">${ph}</div>`).join('')}<div class="tbl__h c-acts" style="flex-basis:150px"></div></div>`;
  /** Підписант версії: посада, звання й ім'я правляться (ТВО), людину можна взяти з довідника на дату паперу. */
  function purSgRow(v, slot, label, ro) {
    const s = (v.signers || {})[slot] || {};
    const dis = ro ? ' disabled' : '';
    const cell = ([ph, k, style]) => (k === 'phone' && slot !== 'exec' ? `<div class="c-txt" style="${style}"></div>`
      : `<div class="c-txt" style="${style}"><input class="rc-in rc-in--wide" style="width:100%;text-align:left"
        data-psg="${slot}" data-k="${k}" value="${esc(s[k] || '')}" placeholder="${ph}" aria-label="${esc(label)}: ${ph}" autocomplete="off"${dis}></div>`);
    return `<div class="tbl__row tbl__row--plain" data-sg="${slot}"><div class="c-txt" style="flex:0 0 130px"><b>${esc(label)}</b></div>
      ${PUR_SG_COLS.map(cell).join('')}
      <div class="c-acts" style="flex-basis:150px">${ro ? '' : `<select data-psg-pick="${slot}" aria-label="${esc(label)}: людина з довідника" style="max-width:150px">
        ${personOptions('', purPaperDate(v), 'з довідника…')}</select>`}</div></div>`;
  }

  /** Плитки файлів запису: складений програмою — «▤», підшитий скан — «▣»; плитка веде до свого файла. */
  const purChips = (fk) => filesOf(fk).map((f, i) => `<span class="chip chip--btn" data-vw="${i}" data-vw-key="${esc(fk)}"
    title="${esc(f.file)}">${f.made ? '▤' : '▣'} ${esc(f.file)}</span>`).join('');

  /** Блок «Пакет»: папери версії — «Скласти» й «Підшити скан»; підписанти. Подана версія папери не складає й підписантів не править. */
  PUR_BLOCKS.push((pu) => {
    const v = purVersion(pu);
    if (!v) return '';
    const ro = purVerSent(v);
    const steps = PUR_PAPERS.map(([key, word, paper]) => {
      const fk = `purver|${v.id}|${key}`;
      return `<div class="pur-step" data-step="${esc(key)}"><div class="pur-step__k">${esc(word)}</div>
        <div class="pur-files">${purChips(fk) || '<span class="c-num--dim">немає</span>'}</div>
        <div class="pur-step__acts">${ro || !paper ? '' : `<button class="btn btn--sm${purComposing.has(fk) ? ' is-busy' : ''}" data-act="pur-paper"
          data-paper="${paper}" data-key="${esc(key)}" data-ver="${esc(v.id)}" title="Скласти: ${esc(word)}">${purComposing.has(fk) ? 'Складається…' : 'Скласти'}</button>`}
          ${native ? `<button class="btn btn--sm" data-act="file-add" data-key="${esc(fk)}" title="Підшити скан: ${esc(word)}">Підшити скан</button>
          <button class="btn btn--sm" data-act="pur-folder-pick" data-key="${esc(fk)}" title="Підшити з теки: ${esc(word)}">Підшити з теки…</button>` : ''}</div></div>`;
    }).join('');
    const mixed = purMixedLines(pu, v);
    return `<div class="card pur-block pur-pack"><div class="card__head"><div class="card__title">Пакет · версія ${esc(v.label)}</div>
        <span class="panel__count">${esc((purFolderFor(`purver|${v.id}|рапорт`) || {}).dir || '')}</span></div>
      ${mixed ? `<div class="pur-warn" data-pur-warn>${esc(mixed)}</div>` : ''}${steps}
      <div class="tbl pur-sg-tbl">${purSgHead()}${purSgRow(v, 'cmdr', 'Командир', ro)}${purSgRow(v, 'fes', 'Начальник ФЕС', ro)}
        ${purSgRow(v, 'chief', 'Начальник служби', ro)}${purSgRow(v, 'exec', 'Виконавець', ro)}</div></div>`;
  });

  /** Блок «Подано й відповідь»: підпис командира, супровід, відповідь штабу (з листом), вимоги, передача закупівельникам. */
  PUR_BLOCKS.push((pu) => {
    const v = purVersion(pu);
    if (!v) return '';
    const fk = `purver|${v.id}|відповідь`;
    const chips = purChips(fk);
    const row = (name, k, val) => `<div class="pur-step" data-sent="${name}"><div class="pur-step__k">${esc(k)}</div>
      <div class="pur-files">${val || '<span class="c-num--dim">—</span>'}</div><div></div></div>`;
    // № і дата відповіді видно й без самої відповіді: внесене в форму не ховається
    const words = [v.answerNo ? numNo(v.answerNo) : '', v.answerOn ? `від ${fmtDate(v.answerOn)}` : ''].filter(Boolean).join(' ');
    const answer = (v.answer ? `<span class="tag ${PUR_TAG[v.answer] || ''}">${esc(v.answer)}</span>` : '') + (words ? `<span>${esc(words)}</span>` : '') + chips;
    // Лист штабу називається за відповіддю («Погодження» чи «Не погоджено»): до відповіді його підшивати нема як
    return `<div class="card pur-block pur-sent"><div class="card__head"><div class="card__title">Подано й відповідь</div>
        <div class="panel__spacer"></div>
        <button class="btn btn--sm" data-act="pur-sent" title="Підпис командира, супровід, відповідь штабу">Внести подання й відповідь…</button>
        ${native && v.answer ? `<button class="btn btn--sm" data-act="file-add" data-key="${esc(fk)}" title="Лист штабу з відповіддю">Підшити відповідь</button>` : ''}</div>
      ${row('signed', 'Підпис командира', v.signedOn ? fmtDate(v.signedOn) : '')}
      ${row('sent', 'Супровід', v.sentNo ? `${esc(numNo(v.sentNo))}${v.sentOn ? ` від ${fmtDate(v.sentOn)}` : ''}` : '')}
      ${row('answer', 'Відповідь штабу', answer)}
      ${row('note', 'Вимоги', esc(v.answerNote))}
      ${row('handed', 'Закупівельникам', v.handedOn ? fmtDate(v.handedOn) : '')}</div>`;
  });

  /** «Внести подання й відповідь…»: підпис, подання (супровід № і дата), відповідь штабу, передача закупівельникам — одна форма.
   *  Версія з № супроводу чи відповіддю подана; прибрати їх — виправити помилково внесене (стерти й дату супроводу: вона без № не
   *  приймається). Дати й поля, що суперечать одне одному, форма відмовляє словом у самому вікні: дата супроводу без №, відповідь
   *  раніше за супровід, версія «не погоджено», яку «передано закупівельникам». */
  function purSentDialog(pu, v) {
    if (!pu || !v) return;
    const el = modalOpen(`Версія ${v.label} · подання й відповідь`, `<form id="sent-form" class="pad"><div class="form__grid">
        <div class="field"><label>Підпис командира</label><input name="signedOn" type="date" value="${esc(v.signedOn)}"></div>
        <div class="field"><label>Супровід №</label><input name="sentNo" value="${esc(v.sentNo)}" placeholder="0000/…" autocomplete="off"></div>
        <div class="field"><label>Супровід від</label><input name="sentOn" type="date" value="${esc(v.sentOn)}"></div>
        <div class="field"><label>Відповідь</label><select name="answer">${['', 'погоджено', 'не погоджено'].map((a) =>
    `<option value="${a}"${a === v.answer ? ' selected' : ''}>${a || '—'}</option>`).join('')}</select></div>
        <div class="field"><label>Відповідь №</label><input name="answerNo" value="${esc(v.answerNo)}" placeholder="000/00/…" autocomplete="off"></div>
        <div class="field"><label>Відповідь від</label><input name="answerOn" type="date" value="${esc(v.answerOn)}"></div>
        <div class="field field--span"><label>Вимоги штабу</label><input name="answerNote" value="${esc(v.answerNote)}" autocomplete="off"></div>
        <div class="field"><label>Передано закупівельникам</label><input name="handedOn" type="date" value="${esc(v.handedOn)}"></div></div>
      <div class="pad" data-pur-msg hidden style="color:var(--bad)"></div>
      <div style="padding-top:12px"><button class="btn btn--primary" type="submit">Зберегти</button>
        <button class="btn" type="button" data-md="close">Скасувати</button></div></form>`, 'modal__box--form');
    const form = el.querySelector('form');
    const msg = el.querySelector('[data-pur-msg]');
    const fail = (name, text) => {                               // слово — у самому вікні, поле, з якого воно, — червоне й у фокусі
      form.elements[name].classList.add('is-bad');
      msg.hidden = false;
      msg.textContent = text;
      form.elements[name].focus();
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      msg.hidden = true;
      for (const x of form.querySelectorAll('.is-bad')) x.classList.remove('is-bad');
      const f = new FormData(form);
      const g = (k) => String(f.get(k) || '').trim();
      if (g('sentOn') && !g('sentNo')) { fail('sentNo', 'Дату супроводу вказано без №.'); return; }
      if (g('sentOn') && g('answerOn') && g('answerOn') < g('sentOn')) { fail('answerOn', 'Дата відповіді раніша за дату супроводу.'); return; }
      if (g('handedOn') && g('answer') === 'не погоджено') { fail('handedOn', 'Не погоджену версію закупівельникам не передають.'); return; }
      const was = v.sentNo;
      for (const k of ['signedOn', 'sentNo', 'sentOn', 'answer', 'answerNo', 'answerOn', 'answerNote', 'handedOn']) v[k] = g(k);
      logChange(v.sentNo && !was ? 'версію подано' : 'подання й відповідь', `pur|${pu.id}`,
        [v.label, v.sentNo && `супровід ${numNo(v.sentNo)}`, v.answer].filter(Boolean).join(' · '));
      modalClose();
      saveThen(v.sentNo && !was ? 'Версію подано: позиції більше не правляться.' : 'Збережено.');
      render();
    });
  }

  PUR_BINDS.push((sc, pu) => {
    const v = pu && purVersion(pu);
    if (!v || purVerSent(v)) return;
    sc.querySelectorAll('[data-psg]').forEach((el) => el.addEventListener('change', () => {
      v.signers = v.signers || {};
      v.signers[el.dataset.psg] = Object.assign({}, v.signers[el.dataset.psg], { [el.dataset.k]: el.value.trim() });
      save();
    }));
    sc.querySelectorAll('[data-psg-pick]').forEach((el) => el.addEventListener('change', () => {
      const person = personBy(el.value);
      if (!person) return;
      const slot = el.dataset.psgPick;
      v.signers = v.signers || {};
      const phone = slot === 'exec' ? { phone: (v.signers.exec || {}).phone || '' } : {};
      v.signers[slot] = Object.assign(sgOf(person, purPaperDate(v)), phone);
      save();
      render();
    }));
  });

  // ---------------------------------------------------------------- документи закупівель: договори, ВН, рахунки, довіреності, оплати
  /** Як документ закупівлі зветься в написах і в журналі змін. */
  const PD_WORD = { 'договір': 'Договір', 'ВН': 'ВН', 'рахунок': 'Рахунок', 'довіреність': 'Довіреність', 'оплата': 'Оплата',
    'акт введення': 'Акт введення', 'інше': 'Документ' };
  /** Над чим стоїть документ: ВН — над договором, рахунок — над договором чи ВН, оплата — над ВН чи рахунком,
   *  довіреність — над ВН чи договором. */
  const PD_PARENT = { 'ВН': ['договір'], 'рахунок': ['договір', 'ВН'], 'оплата': ['ВН', 'рахунок'], 'довіреність': ['ВН', 'договір'] };
  const pdLabel = (d) => `${PD_WORD[d.kind] || 'Документ'} ${d.no ? numNo(d.no) : 'б/н'}${d.date ? ` від ${fmtDate(d.date)}` : ''}`;
  /** «Кому» довіреності — ПІБ людини зі «Люди й МВО»; людини вже нема — порожньо (а не «кому » без імені). */
  const pdWho = (d) => (d.kind === 'довіреність' ? pSign(personBy(d.person)) : '');
  const pdWhoNote = (d) => (pdWho(d) ? `кому ${pdWho(d)}` : '');                                // у дереві: «кому Марко ЛЕВЧЕНКО»
  /** Плитки файлів запису: складений програмою — «▤», підшитий скан — «▣»; плитка веде до свого файла. */
  const pdChips = (key) => filesOf(key).map((f, i) => `<span class="chip chip--btn" data-vw="${i}" data-vw-key="${esc(key)}"
    title="${esc(f.file)}">${f.made ? '▤' : '▣'} ${esc(f.file)}</span>`).join(' ');

  /** Документ у назві списку: «ВН №0000», «оплата №б/н» (вид малими літерами). */
  const pdShort = (d) => `${d.kind === 'інше' ? 'документ' : d.kind} ${d.no ? numNo(d.no) : 'б/н'}`;
  /** «Під договором є: …» — вид документа в орудному відмінку. */
  const PD_UNDER = { 'договір': 'договором', 'ВН': 'ВН', 'рахунок': 'рахунком', 'довіреність': 'довіреністю', 'оплата': 'оплатою',
    'акт введення': 'актом введення', 'інше': 'документом' };
  /** Вигляд `purdocs` — картка акта введення (її відкривають з блока «Поставки» картки закупівлі й з картки приходу). Переліку
   *  документів закупівель немає: вигляд без акта (акт видалили, старе вікно, «назад» до видаленого) показує «Справи». */
  function renderPurDocs() {
    const av = state.purDocId ? pdById(state.purDocId) : null;
    if (av && av.kind === 'акт введення') return renderAvCard(av);
    state.view = 'purch';
    renderNav();
    return renderPurchases();
  }
  /** Новий документ закупівлі з тим, що відомо з документа, над яким він стоїть. */
  function pdNew(kind, purchase, parent) {
    const doc = docBlank(kind, purchase);
    const up = parent ? pdById(parent) : null;
    if (up) {
      Object.assign(doc, { parent: up.id, purchase: up.purchase || purchase, party: up.party || '' });
      if (kind === 'оплата') doc.kop = Math.max(0, (+up.kop || 0) - purDocsList().filter((x) => x.kind === 'оплата' && x.parent === up.id)
        .reduce((s, x) => s + (+x.kop || 0), 0));
    }
    return doc;
  }

  /** «+ …» біля документа чи в шапці блока: вікно нового документа з основою. Вид, якого нема, акт введення (його складають з акта
   *  приймання) і основа, під якою такий вид не стоїть (`PD_PARENT`), вікна не відкривають; основа, якої вже нема (її видалили в
   *  іншому вікні), — слово. */
  function pdAdd(kind, purchase, parent) {
    if (!PUR_DOC_KINDS.includes(kind) || kind === 'акт введення') return null;
    const up = parent ? pdById(parent) : null;
    if (parent && !up) { toast('Документа, під який це додають, уже немає.', true); return null; }
    if (up && !(PD_PARENT[kind] || []).includes(up.kind)) return null;
    return pdDialog(pdNew(kind, purchase, parent), true);
  }

  /** Документи, що стоять під документом на будь-якій глибині (за основою), у порядку переліку; кільце в даних не зациклює. */
  function pdDescendants(id) {
    const out = [];
    const seen = new Set([id]);
    const walk = (up) => {
      for (const d of purDocsList()) {
        if (d.parent !== up || seen.has(d.id)) continue;
        seen.add(d.id);
        out.push(d);
        walk(d.id);
      }
    };
    walk(id);
    return out;
  }

  /** Документ закупівлі: поля за видом, частки між рядками коштів, статус ФЕС, рядки ВН чи договору. Суми, частки, ціни й
   *  кількості читаються через `moneyIn` і `qtyIn`: текст, що не число, червонить поле, слово лежить унизу вікна, і нічого не
   *  пишеться. Що вікно для цього виду не показує (ПДВ оплати, «до сплати» рахунка, контрагент оплати без основи, основа з іншої
   *  закупівлі…), лишається в записі як було. Вікно відкривають із картки закупівлі: закупівлю документа можна змінити на іншу, але
   *  не прибрати («—» поле не має): документ без закупівлі не показує жоден екран. */
  function pdDialog(doc, fresh = false) {
    const rec = JSON.parse(JSON.stringify(doc));
    const kind = rec.kind;
    rec.fes = Object.assign({ status: '', date: '', register: '', ref: '' }, rec.fes);
    rec.lines = rec.lines || [];
    rec.parts = rec.parts || [];
    const parties = [...new Set(purDocsList().map((x) => x.party).concat((D.parties || []).map((p) => p[0])).filter(Boolean))];
    const money = (kop) => (kop ? kopStr(kop) : '');
    const f = (name, label, val, type = '') => `<div class="field${type === 'wide' ? ' field--span' : ''}"><label>${label}</label>
      <input name="${name}"${type === 'date' ? ' type="date"' : type === 'money' ? ' inputmode="decimal"' : ''} value="${esc(val || '')}" autocomplete="off"></div>`;
    const el = modalOpen(fresh ? `Новий документ: ${PD_WORD[kind]}` : pdLabel(rec), `<form id="pd-form" class="pad"><div class="form__grid">
        ${f('no', '№', rec.no)}${f('date', 'Дата', rec.date, 'date')}
        <div class="field"><label>Закупівля</label><select name="purchase">${purList().map((p) =>
    `<option value="${esc(p.id)}"${p.id === rec.purchase ? ' selected' : ''}>${esc(`${p.year} · ${p.title}`)}</option>`).join('')}</select></div>
        ${PD_PARENT[kind] ? '<div class="field"><label>До документа</label><select name="parent"></select></div>' : ''}
        ${kind === 'оплата' ? '' : `<div class="field field--span"><label>Контрагент</label><input name="party" list="pd-parties" value="${esc(rec.party)}" autocomplete="off"></div>`}
        ${f('sum', 'Сума, грн', money(rec.kop), 'money')}${['договір', 'ВН', 'рахунок'].includes(kind) ? f('vat', 'у т.ч. ПДВ, грн', money(rec.vatKop), 'money') : ''}
        ${kind === 'договір' ? f('deliverBy', 'Строк поставки', rec.deliverBy, 'date') + f('procedure', 'Процедура (№ UA-…)', rec.procedure) : ''}
        ${kind === 'ВН' ? f('payOn', '«До сплати»: дата', rec.payOn, 'date') : ''}
        ${kind === 'довіреність' ? `<div class="field"><label>Кому</label><select name="person">${personOptions(rec.person, rec.date || today(), '—')}</select></div>
          ${f('validTo', 'Дійсна до', rec.validTo, 'date')}${f('usedOn', 'Використана', rec.usedOn, 'date')}${f('returnedOn', 'Повернута', rec.returnedOn, 'date')}` : ''}
        ${['ВН', 'рахунок'].includes(kind) ? `<div class="field"><label>Статус ФЕС</label><select name="fes"><option value="">—</option>${PUR_FES_STATUSES.map((st) =>
    `<option${st === rec.fes.status ? ' selected' : ''}>${st}</option>`).join('')}</select></div>
          ${f('register', 'Реєстр', rec.fes.register)}${f('ref', '№ проводки ФЕС', rec.fes.ref)}` : ''}
        ${f('missing', 'Скану немає: причина', rec.missing, 'wide')}${f('note', 'Примітка', rec.note, 'wide')}</div>
      <div data-pd-parts></div>
      ${['ВН', 'договір'].includes(kind) ? `<div class="pd-sect"><div class="pd-sect__h"><b>Рядки</b>
        <button class="btn btn--sm" type="button" data-pd-line>+ Рядок</button>
        ${kind === 'ВН' ? '<button class="btn btn--sm" type="button" data-pd-copy>Рядки з договору</button>' : ''}</div><div data-pd-lines></div>
        <p class="set-note" data-pd-total hidden></p></div>` : ''}
      <datalist id="pd-parties">${parties.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <div class="pos-foot"><div class="pad" data-pd-msg hidden style="color:var(--bad)"></div>
        <div><button class="btn btn--primary" type="submit">Зберегти</button>
          <button class="btn" type="button" data-md="close">Скасувати</button>
          ${fresh ? '' : '<button class="btn btn--danger" type="button" data-pd-del>Видалити</button>'}</div></div></form>`);
    const form = el.querySelector('form');
    const msg = el.querySelector('[data-pd-msg]');
    const say = (text) => { msg.hidden = false; msg.textContent = text; };
    const fail = (field, text) => {                                // слово — у липкому низі вікна; поле, з якого воно, — у фокусі й червоне
      field.classList.add('is-bad');
      say(text);
      field.focus();
    };
    const has = (name) => !!form.elements[name];                     // поле є у вікні цього виду

    // Основа: документи того виду, що може стояти над цим; поточна основа лишається в переліку, навіть коли вона з іншої закупівлі.
    const drawParents = (selected) => {
      const select = form.elements.parent;
      if (!select) return;
      const purchase = form.elements.purchase.value;
      const kinds = PD_PARENT[kind] || [];
      const list = purDocsList().filter((x) => x.id !== rec.id && kinds.includes(x.kind) && (!purchase || x.purchase === purchase));
      const cur = pdById(selected);
      if (cur && cur.id !== rec.id && !list.includes(cur)) list.push(cur);
      select.innerHTML = `<option value="">—</option>${list.map((x) =>
        `<option value="${esc(x.id)}"${x.id === selected ? ' selected' : ''}>${esc(pdLabel(x))}</option>`).join('')}`;
    };

    // Частки між рядками коштів: рядки закупівлі, а ще ті, на які документ уже розділено (вони першими, у тому ж порядку).
    const typed = new Map(rec.parts.map((p) => [p.line, money(p.kop)]));
    const drawParts = () => {
      const pu = purById(form.elements.purchase.value);
      const lines = [...new Set(rec.parts.map((p) => p.line).concat(pu ? (pu.funds || []).map((x) => x.line) : []))]
        .map((id) => budById(id)).filter(Boolean);
      const show = rec.parts.length > 0 || (kind !== 'довіреність' && lines.length > 1);
      el.querySelector('[data-pd-parts]').innerHTML = !show ? '' : `<div class="pd-sect"><div class="pd-sect__h"><b>Частки між рядками коштів</b></div>
        <div class="form__grid">${lines.map((l) => `<div class="field"><label>${esc(l.label)}, грн</label>
          <input data-part="${esc(l.id)}" inputmode="decimal" autocomplete="off" value="${esc(typed.get(l.id) ?? '')}"></div>`).join('')}</div>
        <p class="set-note">Без часток діють частки документа, до якого цей належить; без нього документ не віднесено до жодного рядка.</p></div>`;
    };
    form.addEventListener('input', (e) => { if (e.target.dataset && e.target.dataset.part) typed.set(e.target.dataset.part, e.target.value); });

    // Рядки ВН чи договору: набраний текст лежить у `draft` як є (перемальовування його не губить), читається лише при «Зберегти».
    const box = el.querySelector('[data-pd-lines]');
    const blankLine = () => ({ id: uid(), name: '', code: '', uom: 'шт', qty: 1, priceKop: 0, fesNo: '', year: '', passport: '', life: '' });
    const asRow = (ln) => ({ ln, name: ln.name || '', code: ln.code || '', uom: ln.uom || '', qty: String(ln.qty ?? ''), price: money(ln.priceKop) });
    let draft = rec.lines.map(asRow);
    const untouched = (d) => !d.name.trim() && !d.code.trim() && !d.price.trim() && ['', '1'].includes(d.qty.trim()) && ['', 'шт'].includes(d.uom.trim());
    const syncLines = () => {
      if (!box) return;
      box.querySelectorAll('[data-li]').forEach((row) => {
        const d = draft[+row.dataset.li];
        if (d) for (const k of ['name', 'code', 'uom', 'qty', 'price']) d[k] = row.querySelector(`[data-lk="${k}"]`).value;
      });
    };
    // «Рядки разом»: рядки можуть бути неповні, тож розбіжність із сумою документа — лише слово, не відмова. Рядок, у якому
    // кількість чи ціна не число, не рахується (слова про нього скаже «Зберегти»); читає ті самі `qtyIn` і `moneyIn`, але мовчки.
    const total = el.querySelector('[data-pd-total]');
    const quiet = (value) => ({ value, classList: { toggle() {} } });
    const lineTotal = () => {
      if (!total) return;
      let counted = 0;
      let sum = 0;
      for (const d of draft) {
        if (untouched(d)) continue;
        const qty = qtyIn(quiet(d.qty), () => {});
        const price = moneyIn(quiet(d.price), () => {});
        if (qty == null || price == null) continue;
        counted++;
        sum += lineKop(qty, price);
      }
      const own = moneyIn(quiet(form.elements.sum.value), () => {});
      total.hidden = !counted || own == null || !Number.isSafeInteger(sum) || sum === own;
      total.textContent = total.hidden ? '' : `Рядки разом: ${grnOf(sum)}`;
    };
    const drawLines = () => {
      if (!box) return;
      const cell = (k, i, val, label, extra = '') => `<div class="field"><input data-lk="${k}"${extra} value="${esc(val)}" autocomplete="off" aria-label="Рядок ${i + 1}: ${label}"></div>`;
      box.innerHTML = !draft.length ? '<p class="set-note">Рядків ще немає.</p>' : `<div class="pd-line pd-line--head">${['Найменування', 'Код', 'Од.', 'К-сть', 'Ціна, грн']
        .map((t) => `<div class="pur-links__h">${t}</div>`).join('')}<div></div></div>${draft.map((d, i) => `<div class="pd-line" data-li="${i}">
        ${cell('name', i, d.name, 'найменування')}${cell('code', i, d.code, 'код')}${cell('uom', i, d.uom, 'одиниця')}
        ${cell('qty', i, d.qty, 'кількість', ' inputmode="decimal"')}${cell('price', i, d.price, 'ціна, грн', ' inputmode="decimal"')}
        <div><button type="button" class="ico-btn ico-btn--bad" data-pd-line-del="${i}" title="Прибрати рядок">✕ Прибрати</button></div></div>`).join('')}`;
      lineTotal();
    };
    form.addEventListener('input', (e) => {
      if (e.target.name === 'sum' || (box && box.contains(e.target))) { syncLines(); lineTotal(); }
    });

    drawParents(rec.parent);
    drawParts();
    drawLines();
    form.elements.purchase.addEventListener('change', () => {
      const cur = form.elements.parent ? pdById(form.elements.parent.value) : null;
      const purchase = form.elements.purchase.value;
      drawParents(cur && (!purchase || cur.purchase === purchase) ? cur.id : '');
      drawParts();
    });
    form.elements.parent?.addEventListener('change', () => {       // основа ставить свою закупівлю й, поки порожньо, свого контрагента
      const up = pdById(form.elements.parent.value);
      if (!up) return;
      if (up.purchase && up.purchase !== form.elements.purchase.value) { form.elements.purchase.value = up.purchase; drawParts(); }
      if (form.elements.party && !form.elements.party.value.trim() && up.party) form.elements.party.value = up.party;
    });
    el.querySelector('[data-pd-line]')?.addEventListener('click', () => {
      syncLines();
      draft.push(asRow(blankLine()));
      drawLines();
    });
    el.querySelector('[data-pd-copy]')?.addEventListener('click', () => {
      const up = pdById(form.elements.parent.value);
      if (!up || !(up.lines || []).length) { say(up ? 'У договорі рядків немає.' : 'Спершу оберіть договір.'); return; }
      syncLines();
      if (draft.some((d) => !untouched(d)) && !confirm('Рядки ВН буде замінено рядками договору.')) return;
      draft = up.lines.map((x) => asRow(Object.assign({}, x, { id: uid() })));
      drawLines();
    });
    box?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pd-line-del]');
      if (!b) return;
      syncLines();
      draft.splice(+b.dataset.pdLineDel, 1);
      drawLines();
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      msg.hidden = true;
      syncLines();
      form.querySelectorAll('.is-bad').forEach((x) => x.classList.remove('is-bad'));
      const fd = new FormData(form);
      const g = (k) => String(fd.get(k) || '').trim();
      const bad = [];                                                // поля, що не пройшли: червоніють усі, слово — про перше з них
      const miss = (field) => (text) => bad.push([field, text]);
      const kop = moneyIn(form.elements.sum, miss(form.elements.sum));
      const vat = has('vat') ? moneyIn(form.elements.vat, miss(form.elements.vat)) : rec.vatKop;
      if (has('vat') && vat != null && kop != null && vat > kop) {   // ПДВ — частина суми: більший за неї не буває (поле червонить `fail`)
        bad.push([form.elements.vat, 'ПДВ не може бути більшим за суму документа.']);
      }
      const partEls = [...form.querySelectorAll('[data-part]')];
      const parts = partEls.map((x) => ({ line: x.dataset.part, kop: moneyIn(x, miss(x)) }));
      const made = [];
      if (box) {
        draft.forEach((d, i) => {
          if (untouched(d)) return;                                  // порожній рядок не пишеться
          const row = box.querySelector(`[data-li="${i}"]`);
          const field = (k) => row.querySelector(`[data-lk="${k}"]`);
          const name = d.name.trim().replace(/\s+/g, ' ');
          if (!name) { field('name').classList.add('is-bad'); bad.push([field('name'), `Рядок ${i + 1}: найменування не вказано.`]); }
          const qty = qtyIn(field('qty'), miss(field('qty')));
          const priceKop = moneyIn(field('price'), miss(field('price')));
          made.push({ ln: d.ln, name, code: d.code.trim(), uom: d.uom.trim(), qty, priceKop });
        });
      }
      if (bad.length) { fail(bad[0][0], bad[0][1]); return; }
      const used = parts.filter((p) => p.kop);                       // частка 0 — рядок без частки
      if (used.length) {
        const total = used.reduce((s, p) => s + BigInt(p.kop), 0n);
        if (total !== BigInt(kop)) {
          for (const x of partEls) if (x.value.trim()) x.classList.add('is-bad');
          form.elements.sum.classList.add('is-bad');
          fail(partEls.find((x) => x.value.trim()), `Частки дають ${grnOf(Number(total))} грн, а сума документа — ${grnOf(kop)} грн.`);
          return;
        }
      }
      const parent = PD_PARENT[kind] ? g('parent') : rec.parent;
      const up = pdById(parent);
      const purchase = g('purchase') || (up && up.purchase) || '';
      if (['договір', 'ВН', 'оплата'].includes(kind) && !purchase) {   // запобіжник: «—» поле не має, а «Кошти» бачать лише документи закупівлі
        fail(form.elements.purchase, 'Оберіть закупівлю: без неї документ не потрапить у «Кошти».');
        return;
      }
      // Договір, ВН чи оплата, яких не візьме жоден рядок коштів, зникли б із «Коштів»: у закупівлі з кількома рядками суму
      // розкладають між ними (або вона береться в основи з частками).
      const home = purById(purchase);
      if (['договір', 'ВН', 'оплата'].includes(kind) && kop > 0 && home && (home.funds || []).length > 1
        && !docParts({ id: rec.id, parent, purchase, kop, parts: partEls.length ? used : rec.parts },
          { purchases: purList(), purDocs: purDocsList() }).length) {
        for (const x of partEls) x.classList.add('is-bad');
        fail(partEls[0] || form.elements.sum, 'У закупівлі кілька рядків коштів: розкладіть суму документа між ними.');
        return;
      }
      Object.assign(rec, { no: g('no'), date: g('date'), purchase, parent, kop, vatKop: vat, missing: g('missing'), note: g('note') });
      rec.party = kind === 'оплата' ? ((up && up.party) || rec.party || '') : g('party');
      for (const k of ['deliverBy', 'procedure', 'payOn', 'validTo', 'usedOn', 'returnedOn']) if (has(k)) rec[k] = g(k);
      if (has('person')) rec.person = g('person');
      if (has('fes')) {
        const st = g('fes');
        const was = doc.fes || {};
        rec.fes = { status: st, date: st !== (was.status || '') ? (st ? today() : '') : was.date || '', register: g('register'), ref: g('ref') };
      }
      if (partEls.length) rec.parts = used;
      if (box) rec.lines = made.map((m) => Object.assign(m.ln, { name: m.name, code: m.code, uom: m.uom, qty: m.qty, priceKop: m.priceKop }));
      const list = purDocsList();
      const at = list.findIndex((x) => x.id === rec.id);
      if (at >= 0) list[at] = rec; else list.push(rec);
      logChange(fresh ? 'документ закупівлі додано' : 'документ закупівлі виправлено', `purdoc|${rec.id}`, pdLabel(rec));
      modalClose();
      saveThen(`${pdLabel(rec)}: збережено.`);
      render();
    });
    el.querySelector('[data-pd-del]')?.addEventListener('click', () => {
      const under = pdDescendants(rec.id);
      if (under.length) {                                            // без основи вони втратили б її частки, а з ними — гроші в «Коштах»
        say(`Під ${PD_UNDER[kind] || 'документом'} є: ${under.map(pdShort).join(', ')} — спершу перенесіть їх під інший документ або видаліть.`);
        return;
      }
      const acts = (rec.receipts || []).length;
      if (!confirm(`Видалити ${pdLabel(rec)}?${acts ? `\n\nЗв’язок з актами приймання (${acts}) зникне, самі акти лишаться.` : ''}\n\nФайли в теці лишаться.`)) return;
      store.purDocs = purDocsList().filter((x) => x.id !== rec.id);
      store.scans = (store.scans || []).filter((s) => s.key !== `purdoc|${rec.id}`);      // записи про файли йдуть з документом, самі файли лишаються
      logChange('документ закупівлі видалено', `purdoc|${rec.id}`, pdLabel(rec));
      modalClose();
      save(true, true);
      render();
    });
  }
  function pdOpen(doc) {
    if (!doc) return;
    if (doc.kind === 'акт введення') go('purdocs', { purDocId: doc.id }); else pdDialog(doc);
  }

  // РЕЄСТР НА ФЕС: ПОЧАТОК — що передати на ФЕС і як це лягає в запит і в статуси (функції над станом сторінки, їх перевіряють у node).
  /** Як у реєстрі названо вид паперу обліку: акт приймання-передачі — повністю (так його називає й вивантаження в Excel). */
  const FES_DOC_NAME = { 'Акт приймання': 'Акт приймання-передачі', 'Акт ПП': 'Акт приймання-передачі', 'Акт ПП ОЗ': 'Акт приймання-передачі ОЗ',
    'Накладна': 'Накладна', 'Акт списання': 'Акт списання' };
  /** Документи закупівель, які йдуть на ФЕС, і як вони названі в реєстрі. */
  const FES_PUR_NAME = { 'ВН': 'Видаткова накладна', 'рахунок': 'Рахунок', 'акт введення': 'Акт введення в експлуатацію' };
  /** Назва реєстру — вона ж ключ запису про його файл і слово в статусі документів: «Реєстр від 01.10.2026». Файл сервер називає за тією
   *  самою датою, тож реєстр дня один. */
  const fesRegLabel = (date) => `Реєстр від ${fmtDate(date)}`;
  /** Примірники й аркуші — ціле число від 1 до 999; усе інше (порожнє, дріб, мінус, нуль попереду, слово) — 0, тобто відмова. */
  const fesRegWhole = (v) => (/^[1-9]\d{0,2}$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : 0);

  /** Порядок реєстру й файла: від давніх до нових, у межах дня — за номером (число в номері — як число). */
  const fesRegOrder = (a, b) => String(a.date || '').localeCompare(String(b.date || ''))
    || String(a.no || '').localeCompare(String(b.no || ''), 'uk', { numeric: true });

  /** Усі документи, що можуть іти до реєстру, — з будь-яким статусом: обліку всіх книг (без переносів залишків) і ВН, рахунки та акти
   *  введення закупівель. Кожен несе назву, номер, дату, статус ФЕС (`fes`), суму цілими копійками (за партіями рядків, як у картці
   *  документа), число примірників і книгу; `draft` — акт введення в чернетці: ще не папір. */
  function fesRegPool() {
    const out = [];
    const by = new Map();                                     // id документа обліку → його рядки (документ несе кілька позицій)
    for (const r of docs) {
      if (!r.id || !['in', 'mv', 'wr'].includes(r.kind) || (r.kind === 'in' && purCarry(r))) continue;
      if (!by.has(r.id)) by.set(r.id, []);
      by.get(r.id).push(r);
    }
    for (const [id, rows] of by) {
      const r = rows[0];
      const kop = rows.reduce((s, x) => s + rowParts(x).reduce((t, p) => t + lineKop(p.q, kopOf(p.price)), 0), 0);
      out.push({ key: `d:${id}`, ref: { doc: id }, name: FES_DOC_NAME[r.t] || r.t || 'Документ', no: r.no, date: r.d, fes: fesOf(id), kop,
        copies: r.kind === 'in' ? 3 : 1, book: bookOf(r.code), draft: false });
    }
    for (const d of purDocsList()) {
      const name = FES_PUR_NAME[d.kind];
      if (!name) continue;
      out.push({ key: `p:${d.id}`, ref: { pd: d.id }, name, no: d.no, date: d.date, fes: d.fes || null, kop: +d.kop || 0,
        copies: d.kind === 'акт введення' ? 3 : 1, book: '', draft: d.kind === 'акт введення' && avSt(d) === 'чернетка' });
    }
    return out;
  }

  /** Документи для реєстру від `date`. Кожен несе `group` (див. `fesRegGroup`), назву, номер, дату, статус ФЕС, суму, число примірників
   *  і книгу. Акт введення в чернетці не пропонується (лише вже внесений у реєстр цієї дати лишається в ньому). Від давніх до нових,
   *  у межах дня — за номером. */
  function fesRegCandidates(date = today()) {
    const label = fesRegLabel(date);
    const out = [];
    for (const x of fesRegPool()) {
      const group = fesRegGroup(x.fes, x.date, date, label);
      if (!group || (x.draft && group !== 'inreg')) continue;
      out.push({ key: x.key, ref: x.ref, group, name: x.name, no: x.no, date: x.date, status: (x.fes || {}).status || '', kop: x.kop,
        copies: x.copies, book: x.book });
    }
    return out.sort(fesRegOrder);
  }

  /** Порядок у вікні: спершу позначені за умовчанням (що чекають і вже в реєстрі), далі свіжі, далі — коли розкрито — старші; у межах
   *  групи — за датою, як у списку. Згорнуті старші не показуються. */
  const FES_REG_RANK = { wait: 0, inreg: 0, recent: 1, older: 2 };
  function fesRegView(list, showOld) {
    return list.filter((x) => showOld || x.group !== 'older').map((x, i) => [x, i])
      .sort((a, b) => FES_REG_RANK[a[0].group] - FES_REG_RANK[b[0].group] || a[1] - b[1]).map(([x]) => x);
  }

  /** Чи позначений документ: вже внесений у реєстр цієї дати — завжди (його позначку не знімають); інакше — як вибрала людина (`u.on`
   *  з пам'яті вікна), а коли вона не вибирала, — позначений лише той, що чекає. */
  const fesRegOn = (x, u) => x.group === 'inreg' || (u && typeof u.on === 'boolean' ? u.on : x.group === 'wait');

  /** Позначені документи за пам'яттю вікна (`ui`: ключ → { on, copies, sheets }), а не за тим, що видно на екрані: позначений, але схований
   *  (старший при згорнутому переліку чи такий, що став старшим після зміни дати) мовчки не пропадає. `hidden` — які з позначених
   *  зараз не видно. Порядок — як у списку (від давніх до нових): так вони йдуть і в реєстр. */
  function fesRegTicked(list, ui, showOld) {
    const ticked = list.filter((x) => fesRegOn(x, ui.get(x.key)));
    return { ticked, hidden: showOld ? [] : ticked.filter((x) => x.group === 'older') };
  }

  /** Примірники й аркуші рядка: що вписала людина (`u`), а ні — що стояло в складеному реєстрі цієї дати (`saved[ключ]` = [примірників,
   *  аркушів]), а ні — за умовчанням. */
  function fesRegCounts(x, u, saved) {
    const was = (saved && saved[x.key]) || [];
    return { copies: (u && u.copies) ?? was[0] ?? x.copies, sheets: (u && u.sheets) ?? was[1] ?? 1 };
  }

  /** Слово в порожньому вікні: лишилися самі старші (`olderCount`; їх ховає кнопка), усе вже передано (документи є, і всі мають статус за
   *  реєстром) чи документів до реєстру нема взагалі (акт введення в чернетці не документ реєстру). */
  function fesRegEmptyWord(olderCount, pool) {
    if (olderCount) return 'Свіжих документів для реєстру немає.';
    return pool.some((x) => !x.draft) ? 'Усі документи вже передано на ФЕС.' : 'Документів для реєстру немає.';
  }

  /** Запит на реєстр: рядки — назва, №, дата, примірники, аркуші, сума (цілі копійки); «Передав» — начальник служби на дату реєстру. */
  function fesRegSpec(picked, date) {
    const u = unitInfo();
    const chief = officialAt('начальник служби', date);
    return { paper: 'reestr', date, year: +date.slice(0, 4), unit: { name: u.legalName || '', code: unitCode() },
      rows: picked.map((x) => ({ name: x.name, no: x.no || '', date: x.date || '', copies: x.copies, sheets: x.sheets, kop: x.kop })),
      giver: { name: chief ? pSign(chief) : '' } };
  }

  /** Документам реєстру — «їде на ФЕС» і назва реєстру (решта їхнього статусу — витяг, примітка — лишається). Документ, що вже в цьому
   *  реєстрі, свого статусу не втрачає: «проведено» не вертається в «їде на ФЕС». Повертає, скільком документам статус змінено. */
  function fesRegMark(picked, label) {
    let n = 0;
    for (const x of picked) {
      if (x.group === 'inreg') continue;
      if (x.ref.doc) {
        fesSet(x.ref.doc, { status: 'їде на ФЕС', register: label });
      } else {
        const d = pdById(x.ref.pd);
        if (!d) continue;
        d.fes = { status: 'їде на ФЕС', date: today(), register: label, ref: (d.fes || {}).ref || '' };
        logChange('статус ФЕС', `purdoc|${d.id}`, `${d.no ? numNo(d.no) : 'б/н'}: їде на ФЕС`);
      }
      n++;
    }
    return n;
  }
  // РЕЄСТР НА ФЕС: КІНЕЦЬ

  /** Один запит `api/pur-paper` для реєстру. Повертає `{ ask }` — питання сервера, коли файл змінено руками (409 `changed`), `{ j }` —
   *  відповідь про складений файл; в усіх інших випадках — порожній об'єкт: слово про відмову вже показано (409 «відкрито в Excel чи
   *  Word» теж слово). */
  async function fesRegSend(spec, fk, force) {
    const prev = (store.scans || []).find((f) => f.key === fk && f.made);
    let r;
    let j = {};
    try {
      r = await fetch('api/pur-paper', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, spec, { prevSha: prev ? prev.sha || '' : '', force })) });
      const text = await r.text();
      try { j = JSON.parse(text); } catch (e) { j = { error: text }; }
    } catch (e) {
      toast(`Не вдалося скласти: ${e.message}`, true);
      return {};
    }
    if (r.status === 409 && j.changed) return { ask: j.error || 'Файл змінено після програми — перезаписати?' };
    if (!r.ok || !j.ok) { toast(j.error || `помилка ${r.status}`, true); return {}; }
    return { j };
  }

  /** Реєстр складено: документам — «їде на ФЕС», запис про файл (з примірниками й аркушами кожного документа: реєстр цієї дати, складений
   *  наново, бере їх звідси, а не втрачає; наново складений запис стає на місце попереднього), журнал, закрите вікно, а з іншого ПК —
   *  завантаження файла. */
  function fesRegDone(el, picked, date, label, fk, j) {
    const n = fesRegMark(picked, label);
    const rec = { key: fk, date, no: '', file: j.file, path: j.path, mime: '', size: j.size, added: today(), folder: j.folder, sha: j.sha,
      made: true, counts: Object.fromEntries(picked.map((x) => [x.key, [x.copies, x.sheets]])) };
    store.scans = store.scans || [];
    const at = store.scans.findIndex((f) => f.key === fk && f.made);
    if (at >= 0) store.scans[at] = rec;                        // на своєму місці: скан «Отримав», підшитий до першого файла, не опиняється перед ним
    else store.scans.push(rec);
    logChange('реєстр на ФЕС складено', fk, `${cnt(picked.length, 'документ', 'документи', 'документів')}: ${j.file}`);
    if (el.isConnected) modalClose();                          // вікно могли закрити, поки йшов запит, і тоді відкрите зараз — не наше
    save(true);
    render();
    if (j.download) {                                          // з іншого ПК файл віддається завантаженням
      const a = document.createElement('a');
      a.href = j.download;
      a.download = j.file;
      document.body.appendChild(a);                            // не всі браузери завантажують за кліком по елементу поза сторінкою
      a.click();
      a.remove();
    }
    toast(`Реєстр складено: ${j.file}.${n ? ` Позначено «їде на ФЕС»: ${n}.` : ''}`);
  }

  /** «Реєстр на ФЕС…»: дата реєстру й перелік документів. Угорі — позначене за умовчанням (явне очікування й уже внесене в реєстр цієї дати),
   *  далі свіже без статусу — без позначки, внизу — старше за FES_REG_DAYS днів, його ховає «Показати старші». Документ, що вже в реєстрі
   *  цієї дати, замкнений: файл складається наново повним. Дату можна міняти — перелік перераховується, а вписане в рядках лишається.
   *  Позначене береться з пам'яті вікна (`ui`), а не з екрана: позначений, але схований документ мовчки не пропадає — «Скласти реєстр»
   *  розгортає старші, каже про це й нічого не шле. Запит іде лише тоді, і лише після складеного файла ставляться статуси. Друге
   *  надсилання, поки перше в дорозі, нічого не робить. */
  function fesRegDialog() {
    const ui = new Map();                                      // що людина вписала в рядки: ключ → { on, copies, sheets }
    let date = today();
    let list = fesRegCandidates(date);
    let showOld = false;
    const el = modalOpen('Реєстр документів на ФЕС', `<form id="fes-reg" class="pad">
        <div class="field" style="max-width:240px;padding-top:16px"><label>Дата реєстру</label><input name="date" type="date" value="${esc(date)}"></div>
        <p class="set-note" data-reg-note hidden style="margin-top:10px"></p>
        <div style="margin-top:12px"><button class="btn btn--sm" type="button" data-reg-old hidden></button></div>
        <div class="tbl" data-reg-list style="--tbl-min:auto;margin-top:10px"></div>
        <div class="pos-foot"><div class="pad" data-reg-msg hidden style="color:var(--bad)"></div>
          <div><button class="btn btn--primary" type="submit">Скласти реєстр</button>
            <button class="btn" type="button" data-md="close">Скасувати</button></div></div></form>`);
    const form = el.querySelector('form');
    const box = el.querySelector('[data-reg-list]');
    const toggle = el.querySelector('[data-reg-old]');
    const note = el.querySelector('[data-reg-note]');
    const msg = el.querySelector('[data-reg-msg]');
    const send = form.querySelector('button[type="submit"]');
    const dateEl = form.elements.date;
    const rowEls = () => [...box.querySelectorAll('[data-reg-row]')];
    const rowOf = (key) => rowEls().find((r) => r.dataset.regRow === key) || null;
    /** Вписане в рядках — у пам'ять: перед тим як перелік малюється наново і перед «Скласти реєстр» (далі позначене й вписане беруться з
     *  пам'яті, а не з екрана). Замкнений рядок позначки не несе: вона не від людини. */
    const keep = () => {
      for (const r of rowEls()) {
        const on = r.querySelector('[data-reg]');
        ui.set(r.dataset.regRow, { on: on.disabled ? undefined : on.checked, copies: r.querySelector('[data-copies]').value,
          sheets: r.querySelector('[data-sheets]').value });
      }
    };
    /** Складений раніше реєстр цієї дати: його запис, а в ньому — примірники й аркуші кожного документа. */
    const madeAt = (d) => (store.scans || []).find((f) => f.made && f.key === `fesreg|${fesRegLabel(d)}`) || null;
    const paint = () => {
      const older = list.filter((x) => x.group === 'older');
      const shown = fesRegView(list, showOld);
      const { hidden } = fesRegTicked(list, ui, showOld);
      const made = madeAt(date);
      const counts = (made && made.counts) || {};
      toggle.hidden = !older.length;
      toggle.textContent = `${showOld ? 'Сховати' : 'Показати'} старші (${older.length})`;
      note.hidden = !(made || list.some((x) => x.group === 'inreg'));
      note.textContent = `${fesRegLabel(date)} уже складено: документи в ньому лишаються, а файл складається знову.`;
      const row = (x) => {
        const u = ui.get(x.key);
        const c = fesRegCounts(x, u, counts);
        return `<label class="tbl__row tbl__row--plain" data-reg-row="${esc(x.key)}">
          <div class="c-txt" style="flex:0 0 30px"><input type="checkbox" data-reg="${esc(x.key)}"${fesRegOn(x, u) ? ' checked' : ''}${x.group === 'inreg' ? ' disabled' : ''}></div>
          <div class="c-name c-name--stack" style="flex:2 1 220px"><b>${esc(x.name)} ${esc(x.no ? numNo(x.no) : 'б/н')}${esc(bookWord(x.book))}</b>
            <small>${esc([fmtDate(x.date), x.status].filter(Boolean).join(' · '))}</small></div>
          <div class="c-num" style="flex:0 0 110px">${x.kop ? grnOf(x.kop) : '—'}</div>
          <div class="c-num" style="flex:0 0 90px"><input class="rc-in" data-copies="${esc(x.key)}" value="${esc(c.copies)}"
            aria-label="примірників" title="примірників" autocomplete="off"></div>
          <div class="c-num" style="flex:0 0 90px"><input class="rc-in" data-sheets="${esc(x.key)}" value="${esc(c.sheets)}"
            aria-label="аркушів" title="аркушів" autocomplete="off"></div></label>`;
      };
      box.innerHTML = shown.length ? `<div class="tbl__head"><div class="tbl__h" style="flex:0 0 30px"></div>
          <div class="tbl__h c-name" style="flex:2 1 220px">документ</div><div class="tbl__h c-num" style="flex:0 0 110px">сума, грн</div>
          <div class="tbl__h c-num" style="flex:0 0 90px">примірників</div><div class="tbl__h c-num" style="flex:0 0 90px">аркушів</div></div>${shown.map(row).join('')}`
        : `<div class="tbl__row tbl__row--plain"><div class="c-txt">${fesRegEmptyWord(older.length, fesRegPool())}</div></div>`;
      send.disabled = !shown.length && !hidden.length;           // позначений, але схований документ лишає кнопку доступною: вона скаже про нього
    };
    /** Інша дата реєстру — інший перелік (вікно «свіжих» рахується від неї); недописана дата перелік не чіпає. */
    const recount = () => {
      const v = dateEl.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v === date) return;
      keep();
      date = v;
      list = fesRegCandidates(date);
      paint();
    };
    dateEl.addEventListener('input', recount);
    dateEl.addEventListener('change', recount);
    toggle.addEventListener('click', () => { keep(); showOld = !showOld; paint(); });
    const say = (text, field) => {                             // слово — у липкому низі вікна; поле, з якого воно, — червоне й у фокусі
      msg.hidden = false;
      msg.textContent = text;
      if (field) { field.classList.add('is-bad'); field.focus(); }
    };
    const busy = (on) => {
      send.textContent = on ? 'Складається…' : 'Скласти реєстр';
      send.classList.toggle('is-busy', on);
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.hidden = true;
      for (const x of form.querySelectorAll('.is-bad')) x.classList.remove('is-bad');
      const day = dateEl.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { say('Вкажіть дату реєстру.', dateEl); return; }
      keep();                                                  // що видно на екрані — у пам'ять: далі позначене й вписане беруться звідти
      const { ticked, hidden } = fesRegTicked(list, ui, showOld);
      if (hidden.length) {                                     // позначений, але схований документ мовчки не пропадає: старші розгортаються, і його видно
        showOld = true;
        paint();
        rowOf(hidden[0].key)?.scrollIntoView({ block: 'center' });
        say('Відмічені документи серед старших — перегляньте їх і натисніть «Скласти реєстр» ще раз.');
        return;
      }
      const saved = (madeAt(date) || {}).counts;
      const picked = [];
      for (const x of ticked) {
        const c = fesRegCounts(x, ui.get(x.key), saved);
        const copies = fesRegWhole(c.copies);
        const sheets = fesRegWhole(c.sheets);
        if (!copies) { say('Примірників — ціле число від 1 до 999.', rowOf(x.key)?.querySelector('[data-copies]')); return; }
        if (!sheets) { say('Аркушів — ціле число від 1 до 999.', rowOf(x.key)?.querySelector('[data-sheets]')); return; }
        picked.push(Object.assign({}, x, { copies, sheets }));
      }
      if (!picked.length) { say('Позначте документи реєстру.'); return; }
      const label = fesRegLabel(day);
      const fk = `fesreg|${label}`;
      if (purComposing.has(fk)) return;                        // той самий реєстр уже складається: другий запит бачив би щойно записаний файл «зміненим»
      const spec = fesRegSpec(picked, day);
      try {
        purComposing.add(fk);                                  // усе, що може впасти, — у `try`: `finally` завжди знімає захист
        busy(true);
        let got = await fesRegSend(spec, fk, false);
        if (got.ask) {
          if (!confirm(`${got.ask}\n\nЗміни, внесені у файл руками, буде втрачено.`)) return;
          got = await fesRegSend(spec, fk, true);              // «так»: той самий запит, але з «force»
          if (got.ask) { toast(got.ask, true); return; }       // «force» був, а сервер питає знову, — це відмова, а не коло питань
        }
        if (got.j) fesRegDone(el, picked, day, label, fk, got.j);
      } catch (err) {
        toast(`Не вдалося скласти: ${err.message || err}`, true);
      } finally {
        purComposing.delete(fk);
        busy(false);
      }
    });
    paint();
  }

  /** Блок «Договори»: кожен договір із ВН, рахунками, довіреностями й оплатами — деревом. */
  PUR_BLOCKS.push((pu) => {
    const mine = purDocsList().filter((d) => d.purchase === pu.id && d.kind !== 'акт введення');
    const ids = new Set(mine.map((d) => d.id));
    const seen = new Set();
    const add = (d, kind, label) => `<button class="btn btn--sm" data-act="pd-add" data-kind="${kind}" data-parent="${esc(d.id)}">${label}</button>`;
    const acts = (d) => {
      if (d.kind === 'договір') return add(d, 'ВН', '+ ВН') + add(d, 'рахунок', '+ Рахунок') + add(d, 'довіреність', '+ Довіреність');
      if (d.kind === 'ВН') {
        return add(d, 'оплата', '+ Оплата') + add(d, 'довіреність', '+ Довіреність')
          + `<button class="btn btn--sm btn--primary" data-act="pur-receive" data-id="${esc(d.id)}">Прийняти поставку</button>`;
      }
      if (d.kind === 'рахунок') return add(d, 'оплата', '+ Оплата');                   // довіреність — лише під ВН чи договором (PD_PARENT)
      return '';
    };
    const line = (d, depth) => `<div class="tbl__row tbl__row--plain" style="padding-left:${12 + depth * 22}px">
        <div class="c-name c-name--stack pd-name"><b class="lnk" data-act="pd-open" data-id="${esc(d.id)}">${esc(pdLabel(d))}</b>
          <small>${esc([pdWhoNote(d), d.party,
    d.kind === 'ВН' && d.payOn ? `до сплати ${fmtDate(d.payOn)}` : '',
    d.kind === 'договір' && d.deliverBy ? `поставка до ${fmtDate(d.deliverBy)}` : '',
    d.kind === 'довіреність' && d.validTo ? `дійсна до ${fmtDate(d.validTo)}` : '', (d.fes || {}).status].filter(Boolean).join(' · '))}</small></div>
        <div class="c-num pd-sum">${d.kop ? grnOf(d.kop) : '—'}</div>
        <div class="pur-files pd-files">${pdChips(`purdoc|${d.id}`)}</div>
        <div class="c-acts pd-acts">${acts(d)}${native ? `<button class="btn btn--sm" data-act="file-add" data-key="purdoc|${esc(d.id)}">Підшити скан</button>` : ''}</div></div>`;
    // Кожен документ — раз: ті, що не дійшли в дерево (зациклена основа, глибше за чотири рівні), стоять окремо, а не пропадають.
    const branch = (d, depth) => {
      seen.add(d.id);
      return line(d, depth) + (depth < 3 ? mine.filter((x) => x.parent === d.id).map((x) => (seen.has(x.id) ? '' : branch(x, depth + 1))).join('') : '');
    };
    const tree = mine.filter((d) => !d.parent || !ids.has(d.parent)).map((d) => branch(d, 0)).join('')
      + mine.filter((d) => !seen.has(d.id)).map((d) => (seen.has(d.id) ? '' : branch(d, 0))).join('');
    return `<div class="card pur-block pur-docs"><div class="card__head"><div class="card__title">Договори</div>
        <button class="btn btn--sm" data-act="pd-add" data-kind="договір">+ Договір</button>
        <button class="btn btn--sm" data-act="pd-add" data-kind="ВН">+ ВН</button>
        <button class="btn btn--sm" data-act="pd-add" data-kind="рахунок">+ Рахунок</button>
        <button class="btn btn--sm" data-act="pd-add" data-kind="довіреність">+ Довіреність</button></div>
      <div class="tbl">${tree || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Договорів ще немає.</div></div>'}</div></div>`;
  });

  /** Дії документів закупівель. Наступні задачі дописують свої `case` перед `default:`. */
  function pdAction(act, d) {
    const pu = state.view === 'purch' && state.purId ? purById(state.purId) : null;
    switch (act) {
      case 'pd-add': return pdAdd(d.kind, pu ? pu.id : '', d.parent || '');
      case 'pd-open': return pdOpen(pdById(d.id));
      case 'pd-fes-register': return fesRegDialog();
      default: return null;
    }
  }

  // ---------------------------------------------------------------- поставки закупівель: прийняти поставку, акт введення в експлуатацію
  /** «ВН №0000 від 01.01.2026»: вид, номер (немає — «б/н») і дата документа, коли вона є. */
  const purRef = (word, no, date) => [word, no ? numNo(no) : 'б/н', date ? `від ${fmtDate(date)}` : ''].filter(Boolean).join(' ');

  /** Чернетка акта приймання з ВН (чи договору): від кого, наступний номер року з літерою фонду, підстава й рядки — ВН, а коли їх нема,
   *  договору чи погодженої версії пакета. Рядок без коду довідника (коду нема або його в довіднику нема) у чернетку не йде, а названий у
   *  повідомленні: його обирають у формі. Книга чернетки — книга позиції першого рядка, а без рядків — відкрита зараз. Рух майна робить
   *  лише звичайне «Провести документ»: статусу ФЕС приймання не перевіряє. */
  function purReceive(doc) {
    if (!doc) return;
    const pu = purById(doc.purchase);
    const first = pu && pu.funds && pu.funds.length ? budById(pu.funds[0].line) : null;
    const up = pdById(doc.parent);
    const appr = pu ? purVersion(pu, 'approved') : null;
    const src = doc.lines.length ? doc.lines : up && up.lines.length ? up.lines
      : appr ? appr.positions.map((p) => ({ code: p.code, name: p.name, qty: p.qty, priceKop: p.priceKop })) : [];
    const known = (l) => !!l.code && itemBy.has(String(l.code));
    const lines = src.filter(known).map((l) => Object.assign(emptyLine(), { code: String(l.code), qty: String(l.qty || ''),
      price: l.priceKop ? kopStr(l.priceKop) : '' }));
    const nameless = src.filter((l) => !known(l)).map((l) => `${l.name || l.code} × ${fmtNum(l.qty)} по ${grnOf(l.priceKop)}`);
    const book = lines.length ? bookOf(lines[0].code) : state.book;
    if (!leaveEditing()) return;
    if (!freeDraftSlot('in', book, 'Замінити незавершену чернетку «Прихід»?\n\nНаписане в ній буде втрачено.')) return;
    state.editing = null;
    state.moveKind = 'in';
    const date = today();                                         // дата чернетки й рік її номера — з одного виклику: опівночі на Новий рік два розвели б їх
    state.draft = { kind: 'in', book, src: { kind: 'pur', doc: doc.id },
      head: { type: 'Акт приймання', no: nextAp(docs.filter((r) => r.kind === 'in').map((r) => r.no), +date.slice(0, 4), apLetter(first ? first.fund : '')),
        date, from: doc.party || (up && up.party) || '', to: 'склад', basis: purRef(doc.kind, doc.no, doc.date),
        report: '', reportDate: '', act: '', note: '' },
      lines: lines.concat([emptyLine()]) };
    state.flash = `Чернетка акта приймання за ${PD_UNDER[doc.kind] || doc.kind} ${doc.no ? numNo(doc.no) : 'б/н'}: перевірте рядки й проведіть.${nameless.length
      ? ` Без коду: ${nameless.join('; ')}. Оберіть позицію або «+ Нова позиція».` : ''}`;
    go('moves', { q: '', formOpen: true, book });
  }

  /** Картка «Закупівля» в документі приходу: з якою закупівлею, ВН і договором пов'язано, акт введення. */
  function purRcptCard(r0) {
    if (r0.kind !== 'in' || !r0.id) return '';
    const ctx = purCtx();
    const text = purRcptText(r0.id, ctx);
    const linked = (d) => (d.receipts || []).some((l) => rcptId(l, ctx) === r0.id);
    const av = ctx.purDocs.find((d) => d.kind === 'акт введення' && linked(d));
    const pus = [...new Set(ctx.purDocs.filter((d) => d.kind !== 'акт введення' && linked(d)).map((d) => d.purchase))].map(purById).filter(Boolean);
    return `<div class="card pur-rcpt" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Закупівля</div>
        <div class="panel__spacer"></div>${text ? '' : `<button class="btn btn--sm" data-act="pur-link" data-doc="${r0.id}">Прив’язати до закупівлі…</button>`}
        ${av ? `<button class="btn btn--sm" data-act="pd-open" data-id="${esc(av.id)}">${esc(pdLabel(av))}</button>`
    : `<button class="btn btn--sm btn--primary" data-act="pur-av-new" data-doc="${r0.id}">Скласти акт введення</button>`}</div>
      <div style="padding:10px 18px;font:400 12.5px var(--sans);color:var(--ink-2)">${text ? `${esc(text)} ${pus.map((pu) => `<a class="lnk" data-act="pur-open" data-id="${esc(pu.id)}">відкрити</a>`).join(' ')}`
    : 'Не з закупівлі або ще не прив’язано.'}</div></div>`;
  }

  /** Прив'язати прихід до ВН чи договору: з картки приходу (rid) або з картки закупівлі (pu — тоді приходи ще без зв'язку й документи
   *  цієї закупівлі). */
  function purLinkDialog(rid, pu) {
    const ctx = purCtx();
    const linked = new Set(ctx.purDocs.filter((d) => d.kind !== 'акт введення')                   // акт введення — папір після поставки, а не зв'язок
      .flatMap((d) => (d.receipts || []).map((l) => rcptId(l, ctx))));
    const rcpts = rid ? [ctx.rcpt.get(rid)].filter(Boolean)
      : [...ctx.rcpt.values()].filter((r) => !linked.has(r.id)).sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : b.id - a.id)).slice(0, 200);
    const targets = purDocsList().filter((d) => ['ВН', 'договір'].includes(d.kind) && (!pu || d.purchase === pu.id));
    if (!rcpts.length || !targets.length) {
      toast(rcpts.length ? 'Немає ВН чи договору, до яких прив’язати.' : 'Неприв’язаних приходів немає.', true);
      return;
    }
    const el = modalOpen('Прив’язати прихід до закупівлі', `<form class="pad"><div class="form__grid">
      <div class="field field--span"><label>Прихід</label><select name="rcpt">${rcpts.map((r) =>
    `<option value="${r.id}">${esc(`${numNo(r.no)} від ${fmtDate(r.d)} · ${r.from} · ${grnOf(r.kop)} грн`)}</option>`).join('')}</select></div>
      <div class="field field--span"><label>ВН чи договір</label><select name="doc">${targets.map((d) =>
    `<option value="${esc(d.id)}">${esc(`${(purById(d.purchase) || {}).title || '—'}: ${pdLabel(d)}`)}</option>`).join('')}</select></div></div>
      <div style="padding-top:12px"><button class="btn btn--primary" type="submit">Прив’язати</button>
        <button class="btn" type="button" data-md="close">Скасувати</button></div></form>`);
    el.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const d = pdById(f.get('doc'));
      const r = ctx.rcpt.get(+f.get('rcpt'));
      if (!d || !r) return;
      if (!(d.receipts || []).some((l) => rcptId(l, ctx) === r.id)) {
        d.receipts = (d.receipts || []).concat([{ doc: r.id, key: r.key }]);
        logChange('прихід прив’язано до закупівлі', `purdoc|${d.id}`, `${pdLabel(d)} ← ${r.no}`);
        save();
      }
      modalClose();
      render();
    });
  }

  /** Блок «Поставки»: акти приймання закупівлі, статус ФЕС, акт введення. */
  PUR_BLOCKS.push((pu, ctx) => {
    const rows = purRcpts(pu, ctx).map((id) => ctx.rcpt.get(id)).filter(Boolean)
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.id - b.id)).map((r) => {
        const av = ctx.purDocs.find((d) => d.kind === 'акт введення' && (d.receipts || []).some((l) => rcptId(l, ctx) === r.id));
        return `<div class="tbl__row tbl__row--plain"><div class="c-name c-name--stack" style="flex:2 1 220px">
          <b class="lnk" data-act="pur-rcpt" data-key="${esc(r.key)}">Акт приймання ${esc(numNo(r.no))}</b>
          <small>${esc([fmtDate(r.d), r.from].filter(Boolean).join(' · '))}</small></div>
        <div class="c-num" style="width:110px">${grnOf(r.kop)}</div>
        <div class="c-txt" style="width:110px">${esc(r.fes || 'ФЕС: —')}</div>
        <div class="c-acts" style="flex-basis:260px">${av ? `<button class="btn btn--sm" data-act="pd-open" data-id="${esc(av.id)}">${esc(pdLabel(av))}</button>`
    : `<button class="btn btn--sm btn--primary" data-act="pur-av-new" data-doc="${r.id}">Скласти акт введення</button>`}</div></div>`;
      });
    return `<div class="card pur-block pur-deliv"><div class="card__head"><div class="card__title">Поставки</div>
        <button class="btn btn--sm" data-act="pur-link">Прив’язати прихід…</button></div>
      <div class="tbl">${rows.join('') || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Поставок ще немає.</div></div>'}</div></div>`;
  });

  /** Строк корисного використання — як у попередньому акті введення того самого коду. */
  function lastLife(code) {
    for (const d of purDocsList().slice().reverse()) {
      if (d.kind !== 'акт введення') continue;
      const ln = d.lines.find((l) => l.code === code && l.life);
      if (ln) return ln.life;
    }
    return '';
  }

  /** Новий акт введення з акта приймання: номер АВ<рр>-nnn за номером АП, позиції з первісною вартістю, інв. № — номер ФЕС позиції
   *  (своїх номерів у паперах немає), підписанти — з «Люди й МВО» на дату. Місце складання порожнє: поки його не вписано, папір бере
   *  дислокацію на дату акта. Акт цього приходу вже є — відкривається він, а не другий. */
  function purAvNew(docId) {
    const ctx = purCtx();
    const rc = ctx.rcpt.get(+docId);
    if (!rc) { toast('Акта приймання вже немає.', true); return; }
    const linked = (d) => (d.receipts || []).some((l) => rcptId(l, ctx) === rc.id);
    const had = ctx.purDocs.find((d) => d.kind === 'акт введення' && linked(d));
    if (had) { go('purdocs', { purDocId: had.id }); return; }
    const links = ctx.purDocs.filter((d) => d.kind !== 'акт введення' && linked(d));
    const vn = links.find((d) => d.kind === 'ВН');
    const year = +String(rc.d).slice(0, 4);
    const av = docBlank('акт введення', (vn || links[0] || {}).purchase || '');
    Object.assign(av, { no: avNo(rc.no, year, purDocsList().filter((d) => d.kind === 'акт введення').map((d) => d.no)),
      date: rc.d, party: rc.from, kop: rc.kop, receipts: [{ doc: rc.id, key: rc.key }] });
    av.lines = rc.lines.map((l) => {
      const it = itemBy.get(l.code) || {};
      return { id: uid(), name: cleanName(it.name || l.code), code: l.code, uom: it.unit || '', qty: l.q, priceKop: kopOf(l.price),
        fesNo: fesInvNo(it), year: '', passport: '', life: lastLife(l.code) };
    });
    av.extra = { approver: sgOf(officialAt('командир', av.date), av.date), head: sgOf(null), members: [],
      accountant: sgOf(officialAt('начальник ФЕС', av.date), av.date), place: '', supplier: rc.from,
      location: rc.to, seen: [...new Set(av.lines.map((l) => l.name))].join(', '),
      docs: [vn ? purRef('ВН', vn.no, vn.date) : '', purRef('АКТ ПП', rc.no, rc.d)].filter(Boolean).join(' / '),
      versions: [] };
    purDocsList().push(av);
    logChange('акт введення складено', `purdoc|${av.id}`, `${av.no} до ${rc.no}`);
    save();
    go('purdocs', { purDocId: av.id });
  }

  /** Специфікація акта для сервера (форма наказу Мінфіну № 818). Рік — з дати акта (без дати він 0, і сервер скаже слово); місце
   *  складання — вписане в акті, а за його відсутності дислокація на дату акта; гроші — цілі копійки. */
  function avSpec(av) {
    const u = unitInfo();
    const ex = av.extra || {};
    const place = locationAt(av.date);
    return { paper: 'akt', no: av.no, date: av.date, year: /^\d{4}-\d{2}-\d{2}$/.test(av.date || '') ? +av.date.slice(0, 4) : 0,
      unit: { name: u.legalName || '', code: unitCode(), edrpou: u.edrpou || '', place },
      approver: sgPlain(ex.approver), head: sgPlain(ex.head), members: (ex.members || []).map(sgPlain), accountant: sgPlain(ex.accountant),
      place: ex.place || place, location: ex.location || '', seen: ex.seen || '', supplier: ex.supplier || av.party || '',
      docs: ex.docs || '', lines: av.lines.map((l) => ({ name: l.name, fesNo: l.fesNo || '', qty: l.qty, priceKop: l.priceKop,
        kop: lineKop(l.qty, l.priceKop), life: l.life || '', year: l.year || '', passport: l.passport || '' })) };
  }

  /** Скласти акт у Word. Файл, змінений руками, програма без згоди не перезаписує: сервер відповідає 409, сторінка питає, і лише «так»
   *  шле запит ще раз із `force`; відкритий у Word — слово. Друге натискання, поки перше в дорозі, нічого не робить. */
  async function avFile(av, force = false) {
    const fk = `purdoc|${av.id}`;
    if (purComposing.has(fk)) return;
    // Файл зветься за номером акта: без номера він був би «Акт введення в експлуатацію.docx», а з номером іншого акта — тим самим файлом.
    const no = String(av.no || '').trim();
    if (!no) { toast('Вкажіть номер акта: за ним складається файл.', true); return; }
    const twin = purDocsList().find((x) => x.kind === 'акт введення' && x.id !== av.id && normNo(x.no) === normNo(no));
    if (twin) { toast(`Номер ${no} уже має інший акт введення${twin.date ? ` від ${fmtDate(twin.date)}` : ''}: впишіть інший.`, true); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(av.date || '')) { toast('Вкажіть дату акта: за нею складається тека акта.', true); return; }
    // Кнопка — саме цього акта: людина могла відкрити інший, і чужа кнопка не міняється.
    const mark = () => {
      const b = [...document.querySelectorAll('[data-act="av-file"]')].find((x) => x.dataset.id === av.id);
      if (!b) return;
      b.textContent = purComposing.has(fk) ? 'Складається…' : 'У Word';
      b.classList.toggle('is-busy', purComposing.has(fk));
    };
    try {
      purComposing.add(fk);                                                       // усе, що може впасти, — у `try`: `finally` завжди знімає захист
      mark();
      let ask = await avSend(av, fk, force);
      if (ask && !force) {
        if (!confirm(`${ask}\n\nЗміни, внесені у файл руками, буде втрачено.`)) return;
        ask = await avSend(av, fk, true);                                         // «так»: той самий запит, але з «force»
      }
      if (ask) toast(ask, true);                                                  // «force» був, а сервер питає знову, — це відмова, а не коло питань
    } catch (e) {
      toast(`Не вдалося скласти: ${e.message || e}`, true);
    } finally {
      purComposing.delete(fk);
      try { mark(); } catch (e) { /* екран змінився: кнопки вже нема */ }
    }
  }
  /** Один запит `api/pur-paper` для акта. Повертає питання сервера, коли файл змінено руками (409 `changed`); в усіх інших випадках —
   *  порожньо: складено, або слово про відмову вже показано. Запис про файл несе теку й відбиток сервера. */
  async function avSend(av, fk, force) {
    const prev = (store.scans || []).find((f) => f.key === fk && f.made);
    let r;
    let j = {};
    try {
      const spec = Object.assign(avSpec(av), { prevSha: prev ? prev.sha || '' : '', force });
      r = await fetch('api/pur-paper', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
      const text = await r.text();
      try { j = JSON.parse(text); } catch (e) { j = { error: text }; }
    } catch (e) {
      toast(`Не вдалося скласти: ${e.message}`, true);
      return '';
    }
    if (r.status === 409 && j.changed) return j.error || 'Файл змінено після програми — перезаписати?';
    if (!r.ok || !j.ok) { toast(j.error || `помилка ${r.status}`, true); return ''; }        // 409 «відкрито в Excel чи Word» теж тут
    store.scans = (store.scans || []).filter((f) => !(f.key === fk && f.made));
    store.scans.push({ key: fk, date: av.date, no: av.no, file: j.file, path: j.path, mime: '', size: j.size, added: today(),
      folder: j.folder, sha: j.sha, made: true });
    logChange('папір складено', fk, `${av.no}: ${j.file}`);
    save(true);
    render();
    if (j.download) {                                           // з іншого ПК файл віддається завантаженням
      const a = document.createElement('a');
      a.href = j.download;
      a.download = j.file;
      document.body.appendChild(a);                             // не всі браузери завантажують за кліком по елементу поза сторінкою
      a.click();
      a.remove();
    }
    toast(`${j.opened ? 'Відкрито у Word' : 'Складено'}: ${j.file}`);
    return '';
  }

  /** Що не дає вважати акт підготовленим. */
  function avCheck(av) {
    const ex = av.extra || {};
    return [!av.no && 'немає номера', !av.date && 'немає дати', !av.lines.length && 'немає позицій',
      !(ex.approver || {}).name && 'немає, хто затверджує', !(ex.head || {}).name && 'немає голови комісії'].filter(Boolean);
  }
  /** Стан акта (порожній — чернетка, як у запису з книги) і куди з нього можна перейти: затверджений правиться лише через «Виправити…». */
  const avSt = (av) => av.state || 'чернетка';
  const AV_NEXT = { 'чернетка': ['підготовлено'], 'підготовлено': ['затверджено', 'чернетка'], 'затверджено': [] };
  function avState(av, st, what) {
    if (!(AV_NEXT[avSt(av)] || []).includes(st)) { toast('Акт уже в іншому стані: оновіть екран.', true); render(); return; }
    const bad = st === 'чернетка' ? [] : avCheck(av);
    if (bad.length) { toast(`Акт ще не готовий: ${bad.join(', ')}.`, true); return; }
    av.state = st;
    if (st === 'затверджено') {                                  // місце, не вписане руками, стає місцем дня затвердження: «Дислокація» його потім не посуне
      const ex = av.extra || (av.extra = {});
      if (!String(ex.place || '').trim()) ex.place = locationAt(av.date) || '';
    }
    logChange(what, `purdoc|${av.id}`, av.no);
    save();
    render();
  }
  /** «Виправити…»: попередній вміст затвердженого акта лишається в його записі, сам акт вертається в чернетку. */
  function avFix(av) {
    if (avSt(av) !== 'затверджено') return;
    const reason = String(prompt('Причина виправлення', '') || '').trim();
    if (!reason) return;
    const body = JSON.parse(JSON.stringify({ no: av.no, date: av.date, lines: av.lines, extra: Object.assign({}, av.extra, { versions: [] }) }));
    av.extra.versions = (av.extra.versions || []).concat([{ at: today(), reason, body }]);
    av.state = 'чернетка';
    logChange('акт введення виправляють', `purdoc|${av.id}`, `${av.no}: ${reason}`);
    save();
    render();
  }
  /** Члени комісії: рядок додають і прибирають лише в чернетці. */
  function avMember(av) {
    if (avSt(av) !== 'чернетка') return;
    av.extra.members = (av.extra.members || []).concat([sgOf(null)]);
    save();
    render();
  }
  function avMemberDel(av, i) {
    const list = av.extra.members || [];
    if (avSt(av) !== 'чернетка' || !Number.isInteger(i) || i < 0 || i >= list.length) return;
    av.extra.members = list.filter((_, k) => k !== i);
    save();
    render();
  }
  /** Чернетку акта можна видалити (помилково складений); записи про його файли йдуть із ним, самі файли лишаються в теці. */
  function avDelete(av) {
    if (avSt(av) !== 'чернетка') return;
    if (!confirm(`Видалити акт введення ${av.no ? numNo(av.no) : 'б/н'}?\n\nФайли в теці лишаться.`)) return;
    store.purDocs = purDocsList().filter((x) => x.id !== av.id);
    store.scans = (store.scans || []).filter((s) => s.key !== `purdoc|${av.id}`);
    logChange('документ закупівлі видалено', `purdoc|${av.id}`, pdLabel(av));
    save(true, true);
    goBack('purch', { purId: av.purchase || null });
  }

  /** Дії акта введення в експлуатацію. */
  function avAction(act, d) {
    const av = state.purDocId ? pdById(state.purDocId) : null;
    switch (act) {
      case 'av-close': return goBack('purch', { purId: av && av.purchase ? av.purchase : null });
      case 'av-file': return av ? avFile(av) : null;
      case 'av-member': return av ? avMember(av) : null;
      case 'av-member-del': return av ? avMemberDel(av, +d.i) : null;
      case 'av-ready': return av ? avState(av, 'підготовлено', 'акт введення підготовлено') : null;
      case 'av-draft': return av ? avState(av, 'чернетка', 'акт введення повернуто в чернетку') : null;
      case 'av-approve': return av && (avSt(av) !== 'підготовлено' || confirm(`Затвердити акт ${av.no}?\n\nЗатверджений акт правиться лише через «Виправити…».`))
        ? avState(av, 'затверджено', 'акт введення затверджено') : null;
      case 'av-fix': return av ? avFix(av) : null;
      case 'av-del': return av ? avDelete(av) : null;
      default: return null;
    }
  }

  /** Назва картки акта введення. */
  const avTitle = (av) => `Акт введення в експлуатацію ${av.no ? numNo(av.no) : 'б/н'}`;
  /** Рядок під назвою картки: за яким актом приймання складено й на яку суму; акта приймання вже нема — форма акта. */
  function avSubtitle(av) {
    const ctx = purCtx();
    const rc = (av.receipts || []).map((l) => ctx.rcpt.get(rcptId(l, ctx))).find(Boolean);
    return rc ? `За актом приймання ${numNo(rc.no)} від ${fmtDate(rc.d)} на ${grnOf(rc.kop)} грн` : 'Форма наказу Мінфіну № 818';
  }
  /** Після правки реквізитів на місці оновлюється те, що від них залежить: назва (номер) і підказка місця складання (дата). Картку
   *  не перемальовують: людина вже перейшла до наступного поля, і фокус зник би. */
  function avTouch(av, sc) {
    const title = document.querySelector('#head .title');
    if (title) title.textContent = avTitle(av);
    const place = sc.querySelector('[data-av="place"]');
    if (place) place.placeholder = locationAt(av.date);
  }

  /** Графи акта, які вписують руками: номер ФЕС (інв. № у папері), строк корисного використання, рік випуску, номер паспорта. */
  const AV_COLS = { fesNo: 'інв. № ФЕС', life: 'строк, років', year: 'рік випуску', passport: '№ паспорта' };
  function renderAvCard(av) {
    const st = avSt(av);
    const ro = st !== 'чернетка';
    const ex = av.extra || (av.extra = {});
    const dis = ro ? ' disabled' : '';
    const busy = purComposing.has(`purdoc|${av.id}`);
    const fld = (k, label, val, o = {}) => `<div class="field${o.span || ''}"><label>${label}</label><input data-av="${k}"${o.date ? ' type="date"' : ''}
      value="${esc(val || '')}"${o.ph ? ` placeholder="${esc(o.ph)}"` : ''}${o.tip ? ` title="${esc(o.tip)}"` : ''} aria-label="${esc(label)}" autocomplete="off"${dis}></div>`;
    const sgr = (key, label) => {
      const member = key.startsWith('m:');
      const s = (member ? (ex.members || [])[+key.slice(2)] : ex[key]) || {};
      return `<div class="tbl__row tbl__row--plain"><div class="c-txt" style="flex:0 0 130px"><b>${esc(label)}</b></div>
        ${['pos', 'rank', 'name'].map((k) => `<div class="c-txt" style="flex:1 1 150px"><input class="rc-in rc-in--wide" style="width:100%;text-align:left"
          data-avsg="${key}" data-k="${k}" value="${esc(s[k] || '')}" placeholder="${{ pos: 'посада', rank: 'звання', name: 'Ім’я ПРІЗВИЩЕ' }[k]}"
          aria-label="${esc(label)}: ${{ pos: 'посада', rank: 'звання', name: 'ім’я' }[k]}" autocomplete="off"${dis}></div>`).join('')}
        <div class="c-acts" style="flex-basis:210px">${ro ? '' : `<select data-avsg-pick="${key}" aria-label="${esc(label)}: людина з довідника" style="max-width:140px">
          ${personOptions('', av.date || today(), 'з довідника…')}</select>${member
    ? rowBtn('av-member-del', '✕ Прибрати', `data-i="${key.slice(2)}"`, { bad: true, title: 'Прибрати члена комісії' }) : ''}`}</div></div>`;
    };
    const lines = av.lines.map((l, i) => `<div class="tbl__row tbl__row--plain"><div class="c-name c-name--stack" style="flex:2 1 200px">
        <b>${esc(l.name)}</b><small>${esc(l.code)}</small></div>
        <div class="c-num" style="width:60px">${fmtNum(l.qty)}</div><div class="c-num" style="width:110px">${grnOf(l.priceKop)}</div>
        ${Object.entries(AV_COLS).map(([k, ph]) => `<div class="c-txt" style="width:110px"><input class="rc-in rc-in--wide" data-avl="${i}" data-k="${k}"
          value="${esc(l[k] || '')}" placeholder="${ph}" aria-label="${esc(l.name)}: ${ph}" autocomplete="off"${dis}></div>`).join('')}</div>`).join('');
    const bar = { 'чернетка': '<button class="btn btn--primary" data-act="av-ready">Підготовлено</button><button class="btn btn--danger" data-act="av-del">Видалити</button>',
      'підготовлено': '<button class="btn btn--primary" data-act="av-approve">Затвердити…</button><button class="btn" data-act="av-draft">Повернути в чернетку</button>',
      'затверджено': '<button class="btn" data-act="av-fix">Виправити…</button>' }[st] || '';
    const fes = av.fes || {};
    const versions = (ex.versions || []).filter((x) => x && typeof x === 'object');
    return {
      head: head('закупівлі / акти введення', avTitle(av),
        `<button class="btn" data-act="av-close">← Назад</button><span class="tag ${PAPER_TAG[st] || ''}">${esc(st)}</span>
        ${bar}<button class="btn${busy ? ' is-busy' : ''}" data-act="av-file" data-id="${esc(av.id)}">${busy ? 'Складається…' : 'У Word'}</button>`),
      body: `${flashBlock()}<div class="av-card pur-card">
        <div class="card pur-block"><div class="card__head"><div class="card__title">Реквізити</div></div>
          <div class="form__grid pad">${fld('no', '№', av.no)}${fld('date', 'Дата', av.date, { date: true })}
          ${fld('place', 'Місце складання', ex.place, { ph: locationAt(av.date), tip: 'Порожньо: місце складання береться з дислокації на дату акта' })}
          ${fld('location', 'Де знаходиться', ex.location)}${fld('supplier', 'Постачальник', ex.supplier, { span: ' field--span2' })}
          ${fld('docs', 'Перелік документації', ex.docs, { span: ' field--span2' })}${fld('seen', 'Проведено огляд', ex.seen, { span: ' field--span' })}</div></div>
        <div class="card pur-block"><div class="card__head"><div class="card__title">ФЕС</div>
          ${fes.date ? `<span class="panel__count">${esc(fmtDate(fes.date))}</span>` : ''}</div>
          <div class="form__grid pad"><div class="field"><label>Статус ФЕС</label>
            <select data-av-fes aria-label="Статус ФЕС"><option value="">—</option>${PUR_FES_STATUSES.map((s) =>
    `<option${s === fes.status ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
            <div class="field"><label>Реєстр</label><input data-avfes="register" value="${esc(fes.register || '')}" aria-label="Реєстр" autocomplete="off"></div>
            <div class="field"><label>№ проводки ФЕС</label><input data-avfes="ref" value="${esc(fes.ref || '')}" aria-label="№ проводки ФЕС" autocomplete="off"></div></div></div>
        <div class="card pur-block"><div class="card__head"><div class="card__title">Позиції</div></div><div class="tbl">
          <div class="tbl__head"><div class="tbl__h c-name" style="flex:2 1 200px">найменування</div><div class="tbl__h c-num" style="width:60px">к-сть</div>
            <div class="tbl__h c-num" style="width:110px">ціна, грн</div>${Object.values(AV_COLS).map((ph) =>
    `<div class="tbl__h c-txt" style="width:110px">${ph}</div>`).join('')}</div>${lines}</div></div>
        <div class="card pur-block"><div class="card__head"><div class="card__title">Комісія й підписи</div>
          ${ro ? '' : '<button class="btn btn--sm" data-act="av-member">+ Член комісії</button>'}</div><div class="tbl">
          ${sgr('approver', 'Затверджує')}${sgr('head', 'Голова комісії')}${(ex.members || []).map((_, i) => sgr(`m:${i}`, `Член ${i + 1}`)).join('')}
          ${sgr('accountant', 'Бухгалтерія')}</div></div>
        ${versions.length ? `<div class="card pur-block"><div class="card__head"><div class="card__title">Попередні редакції</div></div>
          <ul style="padding:6px 18px 10px 34px">${versions.map((x) => `<li>${fmtDate(x.at)}: ${esc(x.reason)}</li>`).join('')}</ul></div>` : ''}
        ${filesCard(`purdoc|${av.id}`, 'Складений і підписаний акт', 'скан підписаного акта')}</div>`,
    };
  }

  PUR_BINDS.push((sc) => {
    if (state.view !== 'purdocs' || !state.purDocId) return;
    const av = pdById(state.purDocId);
    if (!av || av.kind !== 'акт введення') return;
    sc.querySelector('[data-av-fes]')?.addEventListener('change', (e) => {
      const st = e.target.value;
      const was = av.fes || {};
      av.fes = { status: st, date: st !== (was.status || '') ? (st ? today() : '') : was.date || '', register: was.register || '', ref: was.ref || '' };
      logChange('статус ФЕС', `purdoc|${av.id}`, `${av.no}: ${st || 'статус знято'}`);
      save();
      render();
    });
    // Реєстр і № проводки приходять після підписання: їх вписують і в підготовленого, і в затвердженого акта.
    sc.querySelectorAll('[data-avfes]').forEach((el) => el.addEventListener('change', () => {
      const k = el.dataset.avfes;
      av.fes = Object.assign({ status: '', date: '', register: '', ref: '' }, av.fes, { [k]: el.value.trim() });
      logChange('реквізити ФЕС', `purdoc|${av.id}`, `${av.no}: ${k === 'register' ? 'реєстр' : '№ проводки'} ${av.fes[k] ? `«${av.fes[k]}»` : 'знято'}`);
      save();
    }));
    if (avSt(av) !== 'чернетка') return;
    const ex = av.extra;
    sc.querySelectorAll('[data-av]').forEach((el) => el.addEventListener('change', () => {
      const k = el.dataset.av;
      if (k === 'no' || k === 'date') av[k] = el.value.trim(); else ex[k] = el.value.trim();
      save();
      avTouch(av, sc);
    }));
    sc.querySelectorAll('[data-avl]').forEach((el) => el.addEventListener('change', () => {
      av.lines[+el.dataset.avl][el.dataset.k] = el.value.trim();
      save();
    }));
    const put = (key, sg) => {
      if (key.startsWith('m:')) ex.members[+key.slice(2)] = sg; else ex[key] = sg;
    };
    sc.querySelectorAll('[data-avsg]').forEach((el) => el.addEventListener('change', () => {
      const key = el.dataset.avsg;
      const cur = (key.startsWith('m:') ? ex.members[+key.slice(2)] : ex[key]) || {};
      put(key, Object.assign({}, cur, { [el.dataset.k]: el.value.trim() }));
      save();
    }));
    sc.querySelectorAll('[data-avsg-pick]').forEach((el) => el.addEventListener('change', () => {
      const person = personBy(el.value);
      if (!person) return;
      put(el.dataset.avsgPick, sgOf(person, av.date || today()));
      save();
      render();
    }));
  });

  /** Прихід виправили, і його ключ змінився: зв'язки документів закупівель, поставлені за ключем (id ще не прийшов з бази), йдуть за
   *  новим ключем. Зв'язок за id від ключа не залежить. */
  function rekeyPurLinks(oldKey, newKey) {
    if (oldKey === newKey) return;
    for (const d of store.purDocs || []) for (const l of d.receipts || []) if (!l.doc && l.key === oldKey) l.key = newKey;
  }

  // ---------------------------------------------------------------- кошти
  /** Чи посилається на рядок коштів хоч щось: гроші закупівлі, позиція пакета чи частка документа (рівно ті три посилання,
   *  які знає сервер): такий рядок не видаляють — сервер відмовив би всьому запису, і вікно не зберегло б нічого далі. */
  const budUsed = (id) => purList().some((p) => (p.funds || []).some((f) => f.line === id)
    || (p.versions || []).some((v) => (v.positions || []).some((x) => x.line === id)))
    || purDocsList().some((d) => (d.parts || []).some((p) => p.line === id));
  /** Дата першого запису «затверджено» за роком рядка: поточний рік — сьогодні, інший — 1 січня того року. */
  const budDayOf = (year) => (+year === +today().slice(0, 4) ? today() : `${String(year).padStart(4, '0')}-01-01`);
  const BUD_FIELDS = [['year', 'рік'], ['label', 'назва'], ['fund', 'фонд'], ['kpkv', 'КПКВ'], ['kekv', 'КЕКВ'], ['exp', 'код видатків'],
    ['purpose', 'призначення'], ['community', 'громада'], ['agreeNo', 'угода №'], ['agreeDate', 'угода від'], ['decisionNo', 'рішення №'],
    ['decisionDate', 'рішення від'], ['returnBy', 'повернути залишок до'], ['reportBy', 'звіт громаді до'], ['note', 'примітка']];
  const BUD_MOVE_FIELDS = [['kind', 'вид'], ['date', 'дата'], ['kop', 'сума'], ['basis', 'підстава'], ['note', 'примітка']];
  /** Значення поля в журналі змін: дата — по-людськи, сума — з «грн», текст — у лапках, порожнє — «—». */
  const budShow = (k, v) => (v === '' || v == null ? '—' : k === 'date' || /(Date|By)$/.test(k) ? fmtDate(v)
    : k === 'kop' ? `${grnOf(v)} грн` : k === 'year' ? String(v) : `«${v}»`);
  /** «поле: було → стало» для змінених полів запису — для журналу змін. */
  const budChanges = (before, after, fields) => fields.filter(([k]) => String(before[k] ?? '') !== String(after[k] ?? ''))
    .map(([k, name]) => `${name}: ${budShow(k, before[k])} → ${budShow(k, after[k])}`).join('; ');

  /** Реєстр «Кошти»: рядок на рядок коштів вибраного року, показники за формулами штабу (`budNums`). */
  function budSpec(ctx) {
    const rows = purBudget().filter((l) => +l.year === purYear()).map((l) => ({ l, n: budNums(l, ctx) }));
    const opts = (f) => [...new Set(rows.map(f).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk')).map((v) => [v, v]);
    const money = (key, label, title, get, w = 104) => ({ key, label, title, cls: 'c-num', style: `width:${w}px`,
      sort: (x) => get(x.n), cell: (x) => grnOf(get(x.n)) });
    return {
      id: 'bud', rows, minWidth: '1000px', limit: REG_LIMIT,
      placeholder: 'Пошук: назва, фонд, громада, коди',
      search: (x) => [x.l.label, x.l.fund, x.l.community, x.l.kpkv, x.l.kekv, x.l.exp, x.l.purpose],
      filters: [
        { type: 'select', key: 'fund', label: 'фонд', all: 'усі', options: opts((x) => x.l.fund), test: (x, v) => x.l.fund === v },
        { type: 'select', key: 'com', label: 'громада', all: 'усі', options: opts((x) => x.l.community), test: (x, v) => x.l.community === v },
      ],
      columns: [
        { key: 'label', label: 'рядок коштів', cls: 'c-name c-name--stack', style: 'flex:2 1 200px', first: 1, sort: (x) => x.l.label,
          cell: (x) => `<b>${esc(x.l.label)}</b><small>${esc([x.l.fund, x.l.community, [x.l.kekv, x.l.exp].filter(Boolean).join('/')]
            .filter(Boolean).join(' · '))}</small>` },
        money('appr', 'затверджено', 'затверджено і зміни', (n) => n.approved),
        money('fin', 'профінансовано', 'профінансовано без повернутого', (n) => n.financed, 116),
        money('com', 'зобов’язання', 'суми договорів', (n) => n.committed),
        money('got', 'поставлено', 'вартість прийнятого за актами приймання', (n) => n.delivered),
        money('used', 'використано', 'суми оплат', (n) => n.used),
        money('cash', 'залишок коштів', 'профінансовано без використаного', (n) => n.cashLeft),
        money('noc', 'без договору', 'профінансовано без суми договорів', (n) => n.noContract),
        money('free', 'не розплановано', 'затверджено без того, що взяли закупівлі', (n) => n.unplanned),
      ],
      row: (x) => ({ attrs: `data-act="bud-open" data-id="${esc(x.l.id)}"` }),
      total: (shown) => {
        const s = (f) => grnOf(shown.reduce((a, x) => a + f(x.n), 0));
        return { label: '<b>Разом</b>', appr: s((n) => n.approved), fin: s((n) => n.financed), com: s((n) => n.committed),
          got: s((n) => n.delivered), used: s((n) => n.used), cash: s((n) => n.cashLeft), noc: s((n) => n.noContract), free: s((n) => n.unplanned) };
      },
      count: (shown, all) => (shown.length === all.length ? String(all.length) : `${shown.length} із ${all.length}`),
      empty: 'Рядків коштів ще немає.', emptyFiltered: 'За цими фільтрами рядків немає.',
    };
  }

  function renderBudget() {
    const ctx = purCtx();
    const l = state.budId ? budById(state.budId) : null;
    if (l) return renderBudCard(l, ctx);
    const reg = registry(budSpec(ctx));
    return {
      fill: true,
      head: head(`закупівлі / кошти ${purYear()}`, 'Кошти', `${purSeg('purbud')}${purYearSel()}
        <button class="btn" data-act="bud-reports">Звіти…</button>
        <button class="btn" data-act="bud-xls">В Excel</button>
        <button class="btn btn--primary" data-act="bud-new">+ Рядок коштів</button>`),
      body: `${flashBlock()}${reg.panel}<div class="card card--scroll card--fill">${reg.table}</div>`,
    };
  }

  function renderBudCard(l, ctx) {
    const n = budNums(l, ctx);
    const dated = (no, date) => [no && `№${no}`, date && `від ${fmtDate(date)}`].filter(Boolean).join(' ');
    const spec = [['Фонд', l.fund], ['КПКВ', l.kpkv], ['КЕКВ / код', [l.kekv, l.exp].filter(Boolean).join(' / ')],
      ['Громада', l.community], ['Призначення', l.purpose], ['Угода', dated(l.agreeNo, l.agreeDate)],
      ['Рішення', dated(l.decisionNo, l.decisionDate)], ['Повернути залишок до', l.returnBy ? fmtDate(l.returnBy) : ''],
      ['Звіт громаді до', l.reportBy ? fmtDate(l.reportBy) : ''], ['Примітка', l.note]].filter(([, v]) => v)
      .map(([k, v]) => `<div><div class="spec__k">${esc(k)}</div><div class="spec__v">${esc(v)}</div></div>`).join('');
    const tile = (label, kop, hint = '') => `<div class="tile"><div class="tile__label">${esc(label)}</div>
      <div class="tile__value">${grnOf(kop)} <small>грн</small></div>${hint ? `<div class="tile__hint">${esc(hint)}</div>` : ''}</div>`;
    // За датою (стале сортування: записи одного дня лишаються в порядку внесення).
    const moves = [...(l.moves || [])].sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).map((m) =>
      `<div class="tbl__row tbl__row--plain"><div class="c-date">${fmtDate(m.date)}</div>
        <div class="c-txt" style="flex:0 0 140px">${esc(m.kind)}</div><div class="c-num" style="width:130px">${grnOf(m.kop)}</div>
        <div class="c-txt">${esc([m.basis, m.note].filter(Boolean).join(' · '))}</div>
        <div class="c-acts">${rowBtn('bud-move', '✎ Виправити', `data-m="${esc(m.id)}"`, { title: 'Виправити запис руху' })}${
  rowBtn('bud-move-del', '✕ Прибрати', `data-m="${esc(m.id)}"`, { bad: true, title: 'Прибрати запис руху' })}</div></div>`).join('');
    const users = purList().filter((p) => (p.funds || []).some((f) => f.line === l.id)).map((p) =>
      `<div class="tbl__row tbl__row--plain"><div class="c-name"><b><a class="lnk" data-act="pur-open" data-id="${esc(p.id)}">${esc(p.title)}</a></b></div>
        <div class="c-num" style="width:150px">${grnOf(p.funds.find((f) => f.line === l.id).kop)}</div></div>`).join('');
    const files = l.fund === 'Субвенція' ? ['угода', 'рішення', 'звіт'] : ['інше'];
    return {
      head: head(`закупівлі / кошти ${l.year}`, l.label, `<button class="btn" data-act="bud-close">← До переліку</button>
        <button class="btn" data-act="bud-edit" data-id="${esc(l.id)}">Виправити</button>
        <button class="btn btn--primary" data-act="bud-move">+ Запис руху</button>`),
      body: `${flashBlock()}<div class="bud-card pur-card">
        <div class="tiles">${tile('Затверджено', n.approved)}${tile('Профінансовано', n.financed)}${tile('Зобов’язання', n.committed)}${tile('Поставлено', n.delivered)}
          ${tile('Використано', n.used)}${tile('Залишок коштів', n.cashLeft)}${tile('Без договору', n.noContract)}${tile('Не розплановано', n.unplanned)}
          ${l.fund === 'Субвенція' ? tile('До повернення', n.toReturn, l.returnBy ? `до ${fmtDate(l.returnBy)}` : '') : ''}</div>
        <div class="card pur-block"><div class="card__head"><div class="card__title">Реквізити</div></div>
          <div style="padding:18px"><div class="spec">${spec}</div></div></div>
        <div class="card pur-block"><div class="card__head"><div class="card__title">Рух коштів</div></div>
          <div class="tbl bud-moves">${moves || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Записів ще немає.</div></div>'}</div></div>
        <div class="card pur-block"><div class="card__head"><div class="card__title">Закупівлі з цього рядка</div></div>
          <div class="tbl">${users || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Закупівель ще немає.</div></div>'}</div></div>
        ${files.map((what) => filesCard(`bud|${l.id}|${what}`, { 'угода': 'Угода з громадою', 'рішення': 'Рішення громади',
    'звіт': 'Звіт громаді', 'інше': 'Підстави' }[what], 'скан, лист, витяг')).join('')}</div>`,
    };
  }

  /** Вікно рядка коштів: новий (`l` порожній — з полем «Затверджено», яке стає першим записом руху) чи виправлення. */
  function budDialog(l) {
    const fresh = !l;
    const rec = l || budBlank(purYear());
    const el = modalOpen(fresh ? 'Новий рядок коштів' : `Рядок коштів · ${rec.label}`, `<form id="bud-form" class="pad"><div class="form__grid">
        <div class="field"><label>Рік</label><input name="year" type="number" value="${rec.year}" min="2000" max="2100"></div>
        <div class="field field--span"><label>Назва (унікальна в році)</label><input name="label" value="${esc(rec.label)}" required placeholder="ПДФО 3110/040" autocomplete="off"></div>
        <div class="field"><label>Фонд</label><select name="fund" required><option value="">—</option>${PUR_FUNDS.concat(rec.fund && !PUR_FUNDS.includes(rec.fund) ? [rec.fund] : []).map((v) =>
    `<option${v === rec.fund ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
        <div class="field"><label>КПКВ</label><input name="kpkv" value="${esc(rec.kpkv)}" placeholder="2101020" autocomplete="off"></div>
        <div class="field"><label>КЕКВ</label><input name="kekv" value="${esc(rec.kekv)}" autocomplete="off"></div>
        <div class="field"><label>Код видатків</label><input name="exp" value="${esc(rec.exp)}" autocomplete="off"></div>
        ${fresh ? `<div class="field"><label>Затверджено, грн</label><input name="approved" inputmode="decimal" autocomplete="off"></div>
        <div class="field"><label>Затверджено від</label><input name="approvedOn" type="date" value="${esc(budDayOf(rec.year))}"></div>` : ''}
        <div class="field field--span"><label>Призначення</label><input name="purpose" value="${esc(rec.purpose)}" autocomplete="off"></div>
        <div class="field"><label>Громада</label><input name="community" value="${esc(rec.community)}" autocomplete="off"></div>
        <div class="field"><label>Угода №</label><input name="agreeNo" value="${esc(rec.agreeNo)}" autocomplete="off"></div>
        <div class="field"><label>Угода від</label><input name="agreeDate" type="date" value="${esc(rec.agreeDate)}"></div>
        <div class="field"><label>Рішення №</label><input name="decisionNo" value="${esc(rec.decisionNo)}" autocomplete="off"></div>
        <div class="field"><label>Рішення від</label><input name="decisionDate" type="date" value="${esc(rec.decisionDate)}"></div>
        <div class="field"><label>Повернути залишок до</label><input name="returnBy" type="date" value="${esc(rec.returnBy)}"></div>
        <div class="field"><label>Звіт громаді до</label><input name="reportBy" type="date" value="${esc(rec.reportBy)}"></div>
        <div class="field field--span"><label>Примітка</label><input name="note" value="${esc(rec.note)}" autocomplete="off"></div></div>
      <div class="pad" data-pur-msg hidden style="color:var(--bad)"></div>
      <div style="padding-top:12px"><button class="btn btn--primary" type="submit">Зберегти</button>
        <button class="btn" type="button" data-md="close">Скасувати</button>
        ${!fresh && !budUsed(rec.id) ? '<button class="btn btn--danger" type="button" data-bud-del>Видалити рядок</button>' : ''}</div></form>`);
    const form = el.querySelector('form');
    const msg = el.querySelector('[data-pur-msg]');
    const fail = (text) => { msg.hidden = false; msg.textContent = text; };
    const on = form.elements.approvedOn;                                  // лише в новому рядку
    if (on) {
      let typed = false;                                                  // дату вписано руками — рік її вже не веде
      on.addEventListener('input', () => { typed = true; });
      form.elements.year.addEventListener('input', () => {
        const y = form.elements.year.value;
        if (!typed && /^[0-9]{4}$/.test(y)) on.value = budDayOf(y);
      });
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      msg.hidden = true;
      const f = new FormData(form);
      const g = (k) => String(f.get(k) || '').trim();
      const year = +g('year') || purYear();
      const label = g('label').replace(/\s+/g, ' ');
      if (!label) { fail('Назву рядка не вказано.'); return; }
      if (purBudget().some((x) => x.id !== rec.id && +x.year === year && x.label.toLowerCase() === label.toLowerCase())) {
        fail(`Рядок «${label}» за ${year} рік уже є.`);
        return;
      }
      // Затверджено — сума, не менша за нуль; текст, що не число, нулем не пишеться.
      const approved = fresh ? moneyIn(form.elements.approved, fail) : 0;
      if (approved == null) return;
      const before = { ...rec };
      Object.assign(rec, { year, label, fund: g('fund'), kpkv: g('kpkv'), kekv: g('kekv'), exp: g('exp'), purpose: g('purpose'),
        community: g('community'), agreeNo: g('agreeNo'), agreeDate: g('agreeDate'), decisionNo: g('decisionNo'),
        decisionDate: g('decisionDate'), returnBy: g('returnBy'), reportBy: g('reportBy'), note: g('note') });
      if (fresh) {
        if (approved) rec.moves.push({ id: uid(), kind: 'затверджено', date: g('approvedOn') || budDayOf(year), kop: approved, basis: '', note: '' });
        purBudget().push(rec);
      }
      state.purYear = year;
      const changes = fresh ? '' : budChanges(before, rec, BUD_FIELDS);
      if (fresh || changes) {
        logChange(fresh ? 'рядок коштів заведено' : 'рядок коштів виправлено', `bud|${rec.id}`, `${year} · ${label}${changes ? `: ${changes}` : ''}`);
      }
      modalClose();
      save();
      go('purbud', { budId: rec.id });
    });
    el.querySelector('[data-bud-del]')?.addEventListener('click', () => {
      const gone = (rec.moves || []).length;
      const sums = budNums(rec, purCtx());
      const what = gone ? `\n\nРазом із ним зникне ${cnt(gone, 'запис руху', 'записи руху', 'записів руху')}: затверджено ${
        grnOf(sums.approved)} грн, профінансовано ${grnOf(sums.financed)} грн.` : '';
      if (!confirm(`Видалити рядок коштів «${rec.label}»?${what}\n\nФайли в теці лишаться.`)) return;
      store.budget = purBudget().filter((x) => x.id !== rec.id);
      // Записи про файли рядка (`bud|<id>|…`) йдуть разом із ним; самі файли лишаються в теці служби.
      store.scans = (store.scans || []).filter((x) => !String(x.key).startsWith(`bud|${rec.id}|`));
      logChange('рядок коштів видалено', `bud|${rec.id}`, rec.label);
      modalClose();
      save(true, true);
      go('purbud', { budId: null });
    });
  }

  /** Вікно запису руху коштів: новий (`m` порожній) чи виправлення. Сума не нуль (нульовий запис нічого не міняє) і від'ємна лише в «зміні». */
  function budMoveDialog(l, m) {
    if (!Array.isArray(l.moves)) l.moves = [];
    const rec = m || { id: uid(), kind: 'профінансовано', date: today(), kop: 0, basis: '', note: '' };
    const el = modalOpen(`${l.label} · рух коштів`, `<form id="bud-move" class="pad"><div class="form__grid">
        <div class="field"><label>Вид</label><select name="kind">${PUR_MOVE_KINDS.map((k) => `<option${k === rec.kind ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
        <div class="field"><label>Дата</label><input name="date" type="date" value="${esc(rec.date)}" required></div>
        <div class="field"><label>Сума, грн (зміна зі знаком)</label><input name="sum" inputmode="decimal" autocomplete="off" value="${m ? esc(kopStr(rec.kop)) : ''}" required></div>
        <div class="field field--span"><label>Підстава</label><input name="basis" value="${esc(rec.basis)}" placeholder="лист, розподіл, виписка" autocomplete="off"></div>
        <div class="field field--span"><label>Примітка</label><input name="note" value="${esc(rec.note)}" autocomplete="off"></div></div>
      <div class="pad" data-pur-msg hidden style="color:var(--bad)"></div>
      <div style="padding-top:12px"><button class="btn btn--primary" type="submit">Зберегти</button>
        <button class="btn" type="button" data-md="close">Скасувати</button></div></form>`);
    const form = el.querySelector('form');
    const msg = el.querySelector('[data-pur-msg]');
    const fail = (text) => { msg.hidden = false; msg.textContent = text; };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      msg.hidden = true;
      const f = new FormData(form);
      const kind = String(f.get('kind'));
      const field = form.elements.sum;
      if (!field.value.trim()) { field.classList.add('is-bad'); fail('Суму не вказано.'); return; }
      const kop = moneyIn(field, fail, kind === 'зміна');
      if (kop == null) return;
      if (kop === 0) { field.classList.add('is-bad'); fail('Сума руху не може бути нулем.'); return; }       // нуль нічого не міняє
      const before = { ...rec };
      Object.assign(rec, { kind, date: String(f.get('date')), kop,
        basis: String(f.get('basis') || '').trim(), note: String(f.get('note') || '').trim() });
      if (!m) l.moves.push(rec);
      const changes = m ? budChanges(before, rec, BUD_MOVE_FIELDS) : '';
      if (!m || changes) {
        logChange('рух коштів', `bud|${l.id}`, `${l.label}: ${m ? changes : `${rec.kind} ${grnOf(rec.kop)} від ${fmtDate(rec.date)}`}`);
      }
      modalClose();
      saveThen('Запис руху збережено.');
      render();
    });
  }

  /** Дії вкладки «Кошти». Наступні задачі дописують свої `case` перед `default:`: статична перевірка
   *  tests/test_app_js.py шукає саме `case '…'`, а маршрут `startsWith('bud-')` пускає сюди лише дії `bud-…`. */
  function budAction(act, d) {
    const l = state.budId ? budById(state.budId) : null;
    const move = l && d.m ? (l.moves || []).find((m) => m.id === d.m) : null;
    switch (act) {
      case 'bud-new': return budDialog(null);
      case 'bud-open': return go('purbud', { budId: d.id });
      case 'bud-close': return go('purbud', { budId: null });
      case 'bud-edit': return budById(d.id) ? budDialog(budById(d.id)) : null;
      case 'bud-move': return l && (!d.m || move) ? budMoveDialog(l, move) : null;
      case 'bud-move-del': return l && move ? budMoveDel(l, move) : null;
      case 'bud-xls': return budXls();
      case 'bud-reports': return purReportsDialog();
      case 'bud-rep-use': modalClose(); return purReportUse();
      case 'bud-rep-table': modalClose(); return purReportTable();
      case 'bud-rep-where': modalClose(); return purReportWhere();
      case 'bud-rep-in': modalClose(); return purReportIn();
      default: return null;
    }
  }
  function budMoveDel(l, m) {
    if (!confirm(`Прибрати запис руху «${m.kind} ${grnOf(m.kop)} грн від ${fmtDate(m.date)}»?`)) return;
    l.moves = (l.moves || []).filter((x) => x.id !== m.id);
    logChange('рух коштів прибрано', `bud|${l.id}`, `${l.label}: ${m.kind} ${grnOf(m.kop)} від ${fmtDate(m.date)}`);
    save(true, true);
    render();
  }

  // ЗВІТИ КОШТІВ: ПОЧАТОК — звіти по грошах закупівель в Excel, відомість МТЗ з рядка коштів і тексти карток
  // (функції над станом сторінки, їх перевіряють у node). Гроші скрізь — цілі копійки з моделі; у клітинки Excel вони йдуть у гривнях (÷ 100).
  /** Частка a від b для клітинки Excel: шість знаків, а там, де b нуль, — нуль (відсоток від нічого). */
  const ratio = (a, b) => (b ? Math.round(a / b * 1e6) / 1e6 : 0);

  /** «В Excel» у «Справах»: показані рядки (з пошуком, фільтрами й сортуванням реєстру) і ті самі стовпці. */
  function purXls() {
    const shown = regRows(purSpec(purCtx()));
    const sum = (key) => shown.reduce((s, x) => s + x.n[key], 0) / 100;       // «Разом» екрана: копійки складаються цілими, у гривні — раз
    return toExcel({ file: `Закупівлі ${purYear()}`, sheets: [Object.assign({ name: 'Закупівлі', orientation: 'landscape', top: [unitTop()],
      title: `Закупівлі ${purYear()} року`, head: [['Закупівля', 'Що купуємо', 'Рядки коштів', 'Пакет', 'Договори', 'Поставлено',
        'Оплачено', 'Стан']], widths: [28, 36, 28, 14, 14, 14, 14, 14],
      rows: shown.map((x) => [x.pu.title, x.pu.what || '', x.lines.map((l) => l.label).join(', '), x.n.pack / 100, x.n.contracts / 100,
        x.n.delivered / 100, x.n.paid / 100, x.st]), money: [3, 4, 5, 6] },
      shown.length ? { total: ['Разом', '', '', sum('pack'), sum('contracts'), sum('delivered'), sum('paid'), ''] } : {})] });
  }
  /** «В Excel» у «Коштах»: показані рядки коштів і всі показники штабу. */
  function budXls() {
    const shown = regRows(budSpec(purCtx()));
    const KEYS = ['approved', 'financed', 'committed', 'delivered', 'used', 'cashLeft', 'noContract', 'unplanned'];
    return toExcel({ file: `Кошти ${purYear()}`, sheets: [Object.assign({ name: 'Кошти', orientation: 'landscape', top: [unitTop()],
      title: `Кошти ${purYear()} року`, head: [['Рядок коштів', 'Фонд', 'Громада', 'КЕКВ/код', 'Затверджено', 'Профінансовано',
        'Зобов’язання', 'Поставлено', 'Використано', 'Залишок коштів', 'Без договору', 'Не розплановано']],
      widths: [28, 18, 18, 10, 14, 14, 14, 14, 14, 14, 14, 14],
      rows: shown.map((x) => [x.l.label, x.l.fund, x.l.community, [x.l.kekv, x.l.exp].filter(Boolean).join('/')]
        .concat(KEYS.map((k) => x.n[k] / 100))), money: [4, 5, 6, 7, 8, 9, 10, 11] },
      shown.length ? { total: ['Разом', '', '', ''].concat(KEYS.map((k) => shown.reduce((s, x) => s + x.n[k], 0) / 100)) } : {})] });
  }
  /** «Звіти…» у «Коштах»: чотири звіти року, кожен — кнопкою (дії `bud-rep-…`). */
  function purReportsDialog() {
    modalOpen(`Звіти ${purYear()}`, `<div class="pad" style="display:flex;flex-wrap:wrap;gap:8px">
      <button class="btn" data-act="bud-rep-use">Використання коштів</button>
      <button class="btn" data-act="bud-rep-table">Таблиця закупівель</button>
      <button class="btn" data-act="bud-rep-where">Куди пішли кошти</button>
      <button class="btn" data-act="bud-rep-in">Що надійшло</button></div>`, 'modal__box--form');
  }
  /** «Використання коштів» у графах і формулах штабу; відсотки лежать у клітинках частками й показуються відсотком («pct» вивантаження). */
  function purReportUse() {
    const ctx = purCtx();
    const year = purYear();
    const on = fmtDate(today());
    const rows = purUseRows(ctx, year).map((r) => (r.group ? [r.text].concat(Array(12).fill(''))
      : [r.label, [r.kekv, r.exp].filter(Boolean).join('/'), r.approved / 100, r.committed / 100, r.budgetLeft / 100,
        ratio(r.committed, r.approved), ratio(r.committed, r.financed), r.financed / 100, r.used / 100, ratio(r.used, r.financed),
        r.cashLeft / 100, r.noContract / 100, r.note]));
    return toExcel({ file: `Використання коштів ${year} станом на ${on}`, sheets: [{
      name: 'Використання коштів', orientation: 'landscape', top: [unitTop()], title: `Використання коштів ${year} року`,
      subtitle: `станом на ${on}`,
      head: [['Рядок коштів', 'КЕКВ/код', 'Затверджено на рік', 'Взято зобов’язань', 'Залишок бюджетних зобов’язань',
        '% взяття зобов’язань', '% від фінансування', 'Профінансовано', 'Використано', '% використання', 'Залишок коштів',
        'Без договору', `Станом на ${on}`]],
      widths: [28, 10, 15, 15, 15, 11, 11, 15, 15, 11, 15, 15, 48], rows, money: [2, 3, 4, 7, 8, 10, 11], pct: [5, 6, 9] }] });
  }
  /** «Таблиця закупівель» служби за колонками штабу. */
  function purReportTable() {
    const year = purYear();
    const rows = purTableRows(purCtx(), year).map((r) => [unitInfo().serviceFull || 'Продовольча служба', r.kpkv, r.kekv, r.exp,
      r.status, r.fund, r.sum / 100, r.used / 100, r.left / 100, [r.purchase, r.note].filter(Boolean).join('; ')]);
    return toExcel({ file: `Таблиця закупівель ${year}`, sheets: [{ name: 'Лист1', orientation: 'landscape', top: [unitTop()],
      title: `Таблиця закупівель ${year}`, head: [['Служба', 'КПКВ', 'КЕКВ', 'КОД ВИДАТКІВ', 'СТАТУС ПОГОДЖЕННЯ', 'ДЖЕРЕЛО НАДХОДЖЕНЬ',
        'СУМА', 'ВИКОРИСТАНО', 'ЗАЛИШОК', 'ПРИМІТКА']], widths: [22, 16, 8, 10, 18, 26, 14, 14, 14, 44], rows, money: [6, 7, 8] }] });
  }
  /** «Куди пішли кошти»: рядок → закупівлі → договори, ВН і оплати → акти приймання → позиції й де вони зараз. Рядок бере закупівлі, що мають
   *  на ньому гроші, документ із часткою чи поставку; сума документа — його частка на цьому рядку, акта — частка приходу на ньому, розкладена
   *  по позиціях цілими копійками. Тож сума «Договір» рядка коштів — його «Взято зобов’язань», «Оплата» — «Використано», «акт приймання» —
   *  «Поставлено». Акт введення — не поставка: рядків не додає. */
  function purReportWhere() {
    const ctx = purCtx();
    const year = purYear();
    const shares = rcptShares(ctx);
    const stock = [...balances().map];
    const nowOf = new Map();
    const where = (code) => {
      if (!nowOf.has(code)) {
        nowOf.set(code, stock.filter(([k, v]) => k.startsWith(`${code}|`) && v > 0)
          .map(([k, v]) => `${k.slice(k.indexOf('|') + 1)}: ${fmtNum(v)}`).join('; '));
      }
      return nowOf.get(code);
    };
    const KINDS = ['договір', 'ВН', 'оплата'];
    const rows = [];
    for (const l of ctx.budget.filter((x) => +x.year === year)) {
      for (const pu of ctx.purchases) {
        const mine = ctx.purDocs.filter((d) => d.purchase === pu.id && KINDS.includes(d.kind) && docParts(d, ctx).some((p) => p.line === l.id))
          .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || String(a.date || '').localeCompare(String(b.date || '')));
        const got = new Map();                                  // прихід → його частка на рядку (документи ділять прихід між собою)
        for (const s of shares) if (s.purchase === pu.id && s.line === l.id) got.set(s.rid, (got.get(s.rid) || 0) + s.kop);
        for (const d of mine) {
          rows.push([l.label, pu.title, PD_WORD[d.kind], d.no, d.date ? fmtDate(d.date) : '', purPartyOf(d, ctx),
            docParts(d, ctx).filter((p) => p.line === l.id).reduce((s, p) => s + p.kop, 0) / 100, '', '', '', '', '']);
        }
        const rcpts = [...got].map(([rid, kop]) => ({ r: ctx.rcpt.get(rid), kop })).filter((x) => x.r)
          .sort((a, b) => (a.r.d < b.r.d ? -1 : a.r.d > b.r.d ? 1 : a.r.id - b.r.id));
        for (const { r, kop } of rcpts) {
          const lines = r.lines || [];
          const split = new Map(scaleParts(lines.map((ln, i) => ({ line: i, kop: lineKop(ln.q, kopOf(ln.price)) })), kop).map((p) => [p.line, p.kop]));
          const lead = [l.label, pu.title, 'акт приймання', r.no, fmtDate(r.d), r.from];
          if (!lines.length) rows.push(lead.concat([kop / 100, '', '', '', '', '']));
          lines.forEach((ln, i) => {
            const it = itemBy.get(ln.code) || {};
            // «Ціна» — та, з якої рахується сума позиції (до копійки): кількість × ціна = «Сума» (а коли прихід ділять рядки, «Сума» — частка)
            rows.push(lead.concat([(split.get(i) || 0) / 100, ln.code, cleanName(it.name || ln.code), ln.q, kopOf(ln.price) / 100, where(ln.code)]));
          });
        }
      }
    }
    return toExcel({ file: `Куди пішли кошти ${year}`, sheets: [{ name: 'Куди пішли кошти', orientation: 'landscape', top: [unitTop()],
      title: `Куди пішли кошти ${year} року`, head: [['Рядок коштів', 'Закупівля', 'Документ', '№', 'Дата', 'Контрагент', 'Сума, грн',
        'Код', 'Найменування', 'К-сть', 'Ціна, грн', 'Де зараз']], widths: [24, 24, 14, 14, 11, 24, 14, 8, 36, 8, 12, 40], rows, money: [6, 10],
      num: [9] }] });
  }
  /** «Що надійшло»: позиції надходжень ззовні за рік із реквізитами відомості МТЗ і закупівлею. КЕКВ, КПКВ і джерело — указані в позиції
   *  (відомість МТЗ), а де їх нема, — з рядка коштів закупівлі, з якої прийшов прихід. */
  function purReportIn() {
    const year = String(purYear());
    const ctx = purCtx();
    const list = purRows(`${year}-01-01`, `${year}-12-31`);
    const rows = list.map((x, i) => {
      const l = purRcptLine(x.id, ctx);
      return [i + 1, fmtDate(x.d), [x.t, numNo(x.no)].filter(Boolean).join(' '), x.from, x.code, x.name, x.uom, x.q, x.price, x.sum,
        x.kekv || (l ? l.kekv : ''), x.kpkv || (l ? kpkvShort(l.kpkv) : ''), x.fund || (l ? l.fund : ''), purRcptText(x.id, ctx)];
    });
    const t = purTotal(list);
    return toExcel({ file: `Що надійшло ${year}`, sheets: [Object.assign({ name: 'Що надійшло', orientation: 'landscape', top: [unitTop()],
      title: `Надходження ззовні ${year} року`, head: [['№', 'Дата', 'Документ', 'Від кого', 'Код', 'Найменування', 'Од.', 'К-сть',
        'Ціна, грн', 'Сума, грн', 'КЕКВ', 'КПКВ', 'Джерело', 'Закупівля']], widths: [5, 11, 20, 24, 8, 40, 6, 8, 12, 14, 8, 13, 22, 34],
      rows, num: [7], money: [8, 9] },
    list.length ? { total: ['', '', '', '', '', `Разом: документів ${t.docs}, позицій ${t.items}`, '', '', '', t.sum, '', '', '', ''] } : {})] });
  }

  // Відомість МТЗ бере джерело, КПКВ і КЕКВ приходу з рядка коштів його закупівлі (указане руками — першим). Поки жоден документ закупівель
  // не пов'язаний з приходом, функція нічого не дає й відомість така, якою була. Значок меню рахує відомість на кожному показі, тож контекст
  // закупівель, з якого вона бере рядок коштів, будується раз на показ (`renderSeq`) і лише знову, коли змінилося, скільки в стані приходів,
  // документів, справ чи рядків коштів.
  let mtzCtxMemo = { key: '', ctx: null };
  mtzPurOf = () => {
    if (!(store.purDocs || []).some((d) => (d.receipts || []).length)) return () => null;
    const key = [renderSeq, docs.length, (store.purDocs || []).length, (store.purchases || []).length, (store.budget || []).length].join('|');
    if (mtzCtxMemo.key !== key) mtzCtxMemo = { key, ctx: purCtx() };
    const ctx = mtzCtxMemo.ctx;
    return (id) => {
      const l = purRcptLine(id, ctx);
      return l ? { src: MTZ_SRC_OF_PUR[l.fund] || '', kpkv: kpkvShort(l.kpkv), kekv: l.kekv || '' } : null;
    };
  };

  /** «з закупівлі …» для позиції: за кожним її приходом із закупівлі. */
  function itemPurText(code) {
    const ctx = purCtx();
    const ids = [...new Set(docs.filter((r) => r.kind === 'in' && r.code === code && r.id).map((r) => r.id))];
    return [...new Set(ids.map((id) => purRcptText(id, ctx)).filter(Boolean))].join('; ');
  }
  /** Закупівля одиниці: її власний прихід або єдиний прихід коду ззовні; кілька приходів із закупівель без власного — «закупівля не визначена». */
  function unitPurText(u, code, ctx) {
    const own = (unitMoves().get(String(u.id)) || []).filter((r) => r.kind === 'in' && r.id).sort((a, b) => (a.d < b.d ? -1 : 1))[0];
    const ins = [...new Set(docs.filter((r) => r.kind === 'in' && r.code === code && r.id && !purCarry(r)).map((r) => r.id))];
    const rid = own ? own.id : ins.length === 1 ? ins[0] : 0;
    if (rid) return purRcptText(rid, ctx);
    return ins.some((id) => purRcptText(id, ctx)) ? 'закупівля не визначена' : '';
  }

  /** Блок «Одиниці»: що прийшло за закупівлею (за її документами поставки, не за актами введення) і де воно зараз. */
  PUR_BLOCKS.push((pu, ctx) => {
    const bal = balances().map;
    const delivered = new Set(rcptShares(ctx).filter((s) => s.purchase === pu.id).map((s) => s.rid));
    const rows = [];
    const rcpts = purRcpts(pu, ctx).filter((id) => delivered.has(id)).map((id) => ctx.rcpt.get(id)).filter(Boolean)
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.id - b.id));
    for (const r of rcpts) {
      for (const ln of r.lines) {
        const it = itemBy.get(ln.code) || {};
        const where = [...bal].filter(([k, v]) => k.startsWith(`${ln.code}|`) && v > 0)
          .map(([k, v]) => `${k.slice(k.indexOf('|') + 1)} — ${fmtNum(v)}`).join('; ');
        const shared = docs.some((x) => x.kind === 'in' && x.code === ln.code && x.id && x.id !== r.id && !purCarry(x));
        rows.push(`<div class="tbl__row tbl__row--plain"><div class="c-code" style="width:80px"><a class="lnk" data-code="${esc(ln.code)}">${esc(ln.code)}</a></div>
          <div class="c-name c-name--stack" style="flex:2 1 220px"><b>${esc(cleanName(it.name || ln.code))}</b><small>${esc(`${numNo(r.no)} від ${fmtDate(r.d)}`)}</small></div>
          <div class="c-num" style="width:60px">${fmtNum(ln.q)}</div>
          <div class="c-name c-name--stack" style="flex:2 1 220px"><b>${esc(where || 'немає на обліку')}</b>
            <small>${shared ? 'разом з іншими надходженнями коду' : ''}</small></div></div>`);
      }
    }
    return rows.length ? `<div class="card pur-block"><div class="card__head"><div class="card__title">Одиниці</div>
        <span class="panel__count">де зараз</span></div><div class="tbl">${rows.join('')}</div></div>` : '';
  });
  // ЗВІТИ КОШТІВ: КІНЕЦЬ
