// Облік ТЗ ПС · сторінка · документ.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

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

  /** Документ акта за нормами відкривається вікном акта; `plain` — його звичайна картка (з вікна акта, «Картка документа»). */
  function openDoc(key, opts) {
    const actId = actOfKey(key);
    if (actId && !(opts && opts.plain)) { actOpen(actId); return; }
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

  /** Поля документа книги СП чи РП, яких немає в рядку обліку: рапорт і наказ акта, «придатний до» рядка приходу
   *  (сухпай) і квартал звіту 1/прод рядка списання (сухпай; вписаний людиною «Розрахувати «1прод»» не перераховує).
   *  Поле рядка — за кодом і приміткою, як рядок зводить книга. До запису документа id немає. Документ без таких
   *  полів (переміщення, прихід реторт-пакетів) картки не має. */
  function bookDocCard(rows, r0) {
    const b = BOOKS[bookOf(r0.code)];
    if (!b) return '';
    const field = r0.kind === 'wr' && b.q1 ? 'q1' : r0.kind === 'in' && b.best ? 'best' : '';
    if (!field && r0.kind !== 'wr') return '';
    const title = `<div class="card__title">Книга «${esc(b.file)}»</div>`;
    if (!r0.id) {
      return `<div class="card" style="margin-bottom:12px"><div class="card__head">${title}
        <div class="panel__spacer"></div><span class="panel__count">поля з’являться після запису документа</span></div></div>`;
    }
    const meta = (store.docMeta || {})[r0.id] || {};
    const extra = (store.lineExtra || {})[r0.id] || {};
    const seen = new Set();
    const lines = field ? rows.filter((r) => !seen.has(`${r.code}|${r.note}`) && seen.add(`${r.code}|${r.note}`)).map((r) => {
      const key = `${r.code}|${r.note}`;
      const x = extra[key] || {};
      const it = itemBy.get(r.code) || {};
      return `<div class="tbl__row tbl__row--plain">
          <div class="c-code">${esc(r.code)}</div>
          <div class="c-name"><b>${esc(it.name || 'код ' + r.code)}</b></div>
          <div class="c-txt" style="flex:0 0 260px">${field === 'best'
            ? `<input type="date" data-lx="best" data-doc="${r0.id}" data-key="${esc(key)}" value="${esc(x.best || '')}"
                aria-label="Придатний до">`
            : `<input data-lx="q1" data-doc="${r0.id}" data-key="${esc(key)}" value="${esc(x.q1 || '')}" placeholder="III кв 2026"
                aria-label="Квартал звіту 1/прод"> <small>${x.fixed ? 'вписано' : x.q1 ? 'розраховано' : ''}</small>`}</div>
        </div>`;
    }).join('') : '';
    return `<div class="card" style="margin-bottom:12px"><div class="card__head">${title}
        <div class="panel__spacer"></div>${field ? `<span class="panel__count">${field === 'best' ? 'придатний до' : '1прод'}</span>` : ''}</div>
      ${r0.kind === 'wr' ? `<div class="panel fes-panel">
        <label class="chip${meta.report ? ' is-on' : ''}"><span class="chip__label">рапорт</span>
          <input data-dmeta="report" data-doc="${r0.id}" value="${esc(meta.report || '')}" placeholder="№123 від 01.09.2026"
            style="width:420px" title="Кілька рапортів записують через «; »"></label>
        <label class="chip${meta.order ? ' is-on' : ''}"><span class="chip__label">наказ</span>
          <input data-dmeta="order" data-doc="${r0.id}" value="${esc(meta.order || '')}" placeholder="№45 п.7 від 02.09.2026"
            style="width:260px"></label>
      </div>` : ''}
      ${lines ? `<div class="tbl">${lines}</div>` : ''}</div>`;
  }
  /** Рапорт чи наказ документа (document_extra); інші поля запису (скан, графа 2/прод) лишаються. */
  function docMetaSet(docId, patch) {
    store.docMeta = store.docMeta || {};
    const key = String(docId);
    store.docMeta[key] = Object.assign({ report: '', order: '', scan: '', col: null }, store.docMeta[key] || {}, patch);
    logChange('поля документа', 'doc|' + key, Object.entries(patch).map(([k, v]) =>
      `${k === 'report' ? 'рапорт' : 'наказ'}: ${v || '—'}`).join(', '));
    save();
  }
  /** «Придатний до» чи квартал 1/прод рядка. Квартал, уписаний людиною, позначено (fixed): «Розрахувати «1прод»»
   *  його не перераховує; стерли — знову рахує програма. */
  function lineExtraSet(docId, lineKey, patch) {
    store.lineExtra = store.lineExtra || {};
    const key = String(docId);
    const doc = store.lineExtra[key] = store.lineExtra[key] || {};
    const cur = Object.assign({ best: '', q1: '', fixed: false }, doc[lineKey] || {}, patch);
    if ('q1' in patch) cur.fixed = !!patch.q1;
    if (cur.best || cur.q1) doc[lineKey] = cur;
    else delete doc[lineKey];
    if (!Object.keys(doc).length) delete store.lineExtra[key];
    save();
  }

  /** Поля видаленого документа: його id стає вільним, і новий документ може його дістати — він починає з порожніх
   *  (так само зникають бюджетні реквізити надходження, mtzForget). */
  function docFieldsForget(id) {
    for (const map of [store.docFes, store.docMeta, store.lineExtra]) if (map) delete map[String(id)];
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
      ${fesCard(r0)}${purRcptCard(r0)}
      ${bookDocCard(rows, r0)}
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

  /** Слово, яке картка документа щойно показала. Перемальовування не від людини — база дала id щойно проведеному
   *  документу (adoptIds) — його не губить. */
  let flashShown = null;

  /** Повідомлення про щойно проведений документ. Показується один раз —
   *  далі воно лише заважало б. */
  /** Повідомлення — рядок або { text, btn: { label, act, v?, id? } | { label, nav } }:
   *  із кнопкою наступного кроку, коли він один і очевидний («Провести акт №N»). */
  function flashBlock() {
    if (!state.flash) return '';
    const f = typeof state.flash === 'string' ? { text: state.flash } : state.flash;
    state.flash = null;
    flashShown = state.view === 'doc' ? { doc: state.docKey, f } : null;
    const b = f.btn;
    const btn = b ? `<span><button type="button" class="btn btn--sm btn--primary" ${b.nav
      ? `data-nav="${esc(b.nav)}"` : `data-act="${esc(b.act)}"${b.v != null ? ` data-v="${esc(b.v)}"` : ''}${
        b.id != null ? ` data-id="${esc(b.id)}"` : ''}`}>${esc(b.label)}</button></span>` : '';
    return `<div class="flash${btn ? ' flash--acts' : ''}">${btn ? `<span>${esc(f.text)}</span>${btn}` : esc(f.text)}</div>`;
  }
