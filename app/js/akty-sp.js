// Облік ТЗ ПС · сторінка · акти сухпаю.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ---------------------------------------------------------------- акти сухпаю
  /** Акти сухпаю (вид «sp», серія СП) за рапортом підрозділу. Дні рапорту й особи — з Добовки (аркуш «Сухпай»: «Знайти в
   *  Добовці» чи вставка аркуша) або вписані; рядки рахує сервер (api/sp-act): пайки — людино-дні кожного пайка ÷ дободач
   *  угору (першому пайку — решта людино-днів рапорту), підігрівачі — по одному на пайок з підігрівачем, вода — особи дня ×
   *  норма на дату (з кодів води місця, спершу найстаріший прихід), «інше» — кількість, вписана людиною. Решти кількостей
   *  сторінка не рахує й не править.
   *  Документ акта — документ вибуття книги СП, відкривається він вікном акта сухпаю; виправлення й видалення — ті самі
   *  запити ядра актів, що й в акта ОП/МЗ (`was` — яким акт був у вікні). */
  const SP_ROLES = [['командир', 0, 'Командир'], ['голова комісії', 0, 'Голова комісії'],
    ['член комісії', 1, 'Член комісії 1'], ['член комісії', 2, 'Член комісії 2'], ['член комісії', 3, 'Член комісії 3'],
    ['МВО', 0, 'МВО місця'], ['начальник служби', 0, 'Начальник служби'], ['бухгалтер', 0, 'Начфін'],
    ['одержувач', 0, 'Одержувач']];
  /** Папери пакета: [роль, підпис]. Рапорт — вхідний номер і дата; витяг — номер наказу з пунктом («301 п.18») і дата. */
  const SP_PAPERS = [['накладна', 'Накладна (вимога)'], ['роздавальна', 'Роздавальна відомість'],
    ['рапорт', 'Рапорт, вх. №'], ['витяг', 'Витяг з наказу, № і пункт']];
  /** Статуси ФЕС, що чекають на людину: лічильник вкладки. */
  const SP_TODO = ['немає витяга', 'роздрукувати'];
  const isSpAct = (id) => ((store.acts || {})[String(id)] || {}).kind === 'sp';

  /** Рядки реєстру: дані акта зі стану; номер, дата, підрозділ (примітка рядків) і місце — з документа акта; сума — за
   *  партіями рядків; рапорт — поле документа. */
  function spActRows() {
    const acts = store.acts || {};
    const lines = new Map();
    for (const r of docs) {
      const id = String(r.id || '');
      if (!id || !isSpAct(id)) continue;
      if (!lines.has(id)) lines.set(id, []);
      lines.get(id).push(r);
    }
    return Object.entries(acts).filter(([, a]) => a.kind === 'sp').map(([id, a]) => {
      const rows = lines.get(id) || [];
      const doc = rows[0] || {};
      const sum = rows.reduce((s, r) => s + rowParts(r).reduce((t, p) => t + p.price * p.q, 0), 0);
      return Object.assign({}, a, { id, no: String(doc.no ?? '').trim(), d: doc.d || '', label: doc.note || '',
        holder: doc.from || '', report: ((store.docMeta || {})[id] || {}).report || '', sum: Math.round(sum * 100) / 100,
        fes: ((store.docFes || {})[id] || {}).status || '' });
    }).filter((r) => r.no)
      .sort((x, y) => (x.d < y.d ? 1 : x.d > y.d ? -1 : y.no.localeCompare(x.no, 'uk', { numeric: true })));
  }

  function spActsSpec() {
    const rows = spActRows();
    const years = [...new Set(rows.map((r) => r.d.slice(0, 4)))].sort().reverse();
    return {
      id: 'spacts', rows, minWidth: '900px', search: (r) => [r.no, r.label, r.report, r.holder],
      placeholder: 'Номер, підрозділ чи рапорт',
      filters: [
        { type: 'select', key: 'year', label: 'рік', all: 'усі', options: years.map((y) => [y, y]), test: (r, val) => r.d.startsWith(val) },
        { type: 'select', key: 'fes', label: 'ФЕС', all: 'усі', options: FES_STATUSES.map((s) => [s, s]).concat([['-', 'без статусу']]),
          test: (r, val) => (val === '-' ? !r.fes : r.fes === val) },
      ],
      columns: [
        { key: 'no', label: '№', cls: 'c-code', style: 'width:120px', first: 1, sort: (r) => r.no, cell: (r) => `<b>${esc(numNo(r.no))}</b>` },
        { key: 'd', label: 'дата', cls: 'c-date', sort: (r) => r.d, cell: (r) => fmtDate(r.d) },
        { key: 'label', label: 'підрозділ', cls: 'c-name c-name--stack', first: 1, sort: (r) => r.label, cellTitle: (r) => r.label,
          cell: (r) => `<b>${esc(r.label || '—')}</b><small>${esc(r.holder)}</small>` },
        { key: 'report', label: 'рапорт', cls: 'c-txt', style: 'flex:0 0 170px', sort: (r) => r.report, cell: (r) => esc(r.report || '—') },
        { key: 'period', label: 'дні', cls: 'c-txt', style: 'flex:0 0 196px', sort: (r) => r.from,
          cell: (r) => `${fmtDate(r.from)} — ${fmtDate(r.to)}` },
        { key: 'rations', label: 'людино-дні', cls: 'c-num', sort: (r) => +r.rations || 0, cell: (r) => fmtNum(r.rations) },
        { key: 'sum', label: 'сума, грн', cls: 'c-num c-num--xwide', sort: (r) => r.sum, cell: (r) => fmtMoney(r.sum) },
        { key: 'fes', label: 'ФЕС', cls: 'c-txt', style: 'flex:0 0 112px', first: 1, sort: (r) => r.fes, cell: (r) => esc(r.fes || '—') },
      ],
      row: (r) => ({ attrs: `data-act="sa-open" data-id="${esc(r.id)}"` }),
      total: (shown) => ({ label: '<b>Разом</b>', sum: fmtMoney(shown.reduce((s, r) => s + r.sum, 0)) }),
      count: (shown, all) => (shown.length === all.length ? cnt(all.length, 'акт', 'акти', 'актів') : `${shown.length} із ${all.length}`),
      empty: 'Актів сухпаю ще немає.',
    };
  }

  function renderSpActs() {
    const reg = registry(spActsSpec());
    return { fill: true, head: head('сухпай / акти списання', 'Акти списання',
      '<button class="btn btn--primary" data-act="sa-new">+ Акт сухпаю…</button>'),
    body: `${reg.panel}<div class="card card--scroll card--fill">${reg.table}</div>` };
  }

  /** Вікно акта сухпаю: {docId (0 — новий), report, label, party, holder, rations [{code, days, heater}] (heater: null —
   *  людина не позначала, вирішить сервер), heater, water, other [{code, qty}], days [[дата, осіб]], date, number, signers,
   *  papers, note; was — яким складений акт був, коли вікно його відкрило (з відбитком `sig`); prop — пропозиція сервера;
   *  drawn — вікно вже намальоване (далі пропозиція міняє лише рядки)}. Вікно, закрите людиною («Закрити», ✕, Esc), відповідь
   *  сервера, що спізнилася, знову не відкриває (spPreview). */
  let spWin = null;
  const spShown = (w) => !!w && spWin === w && !!$('#modal [data-sa-win]');
  /** Позиції книги СП для списків вікна: чинні й коди самого акта (`own`), хоч би їх тим часом відправили в архів, — інакше
   *  поле показало б «без підігрівачів» чи «без води», і «Зберегти» прибрало б рядок з акта й паперів (як «Місце» лишає місце
   *  акта). Підпис: код і назва, архівна — з позначкою. */
  const spItems = (test, own = []) => items.filter((i) => bookOfItem(i) === 'СП' && (!i.archived || own.includes(String(i.code)))
    && test(i)).sort((a, b) => String(a.code).localeCompare(String(b.code), 'uk', { numeric: true }))
    .map((i) => [String(i.code), `${i.code} ${i.name}${i.archived ? ' (в архіві)' : ''}`]);

  function spState(id) {
    const a = (store.acts || {})[String(id)];
    const rows = docs.filter((r) => String(r.id) === String(id));
    if (!a || !rows.length) return null;
    const doc = rows[0];
    const no = String(doc.no ?? '').trim();
    const of = (name) => Object.keys(a.roles || {}).filter((c) => a.roles[c] === name);
    const heated = new Set(a.heated || []);
    const qty = (c) => rows.filter((r) => String(r.code) === c).reduce((s, r) => s + (+r.q || 0), 0);
    return { docId: Number(id), report: ((a.papers || {})['рапорт'] || {}).no || '', label: doc.note || '', party: a.party || '',
      holder: doc.from || '', heater: of('підігрівач')[0] || '', water: of('вода')[0] || '', heaterSet: true,
      rations: of('пайок').map((c) => ({ code: c, days: (a.pdays || {})[c] ?? '', heater: heated.has(c) })),
      other: of('інше').map((c) => ({ code: c, qty: String(qty(c)) })),
      days: (a.days || []).map((x) => [x[0], x[1]]), date: doc.d, number: no,
      signers: (a.signers || []).map((s) => Object.assign({}, s)), papers: JSON.parse(JSON.stringify(a.papers || {})),
      note: a.note || '', was: { number: no, date: doc.d, from: a.from, to: a.to, sig: a.sig || '' } };
  }

  async function spActNew() {
    actWin = null;                               // вікно акта ОП/МЗ, якщо лишилось, не перехоплює закриття цього
    spWin = { docId: 0, report: '', label: '', party: '', holder: '', rations: [{ code: '', days: '', heater: null }],
      heater: '', water: '', other: [], days: [], date: today(), number: '', signers: [], papers: {}, note: '' };
    await spPreview(true);
  }

  async function spActOpen(id, msg = null) {
    const w = spState(id);
    if (!w) { toast('Такого акта немає.', true); return; }
    actWin = null;
    w.msg = msg;
    spWin = w;
    await spPreview(false);
  }

  /** Запит акта з полів вікна; номер рапорту з поля «Рапорт» — і в папері «рапорт» (там він лягає в акт). */
  const spBody = (w) => ({ docId: w.docId || null, report: w.report, label: w.label, party: w.party, holder: w.holder,
    rations: (w.rations || []).map((r) => ({ code: r.code, days: r.days, heater: r.heater })), heater: w.heater,
    water: w.water, other: (w.other || []).map((o) => ({ code: o.code, qty: o.qty })), days: w.days, date: w.date,
    number: w.number, signers: w.signers,
    papers: Object.assign({}, w.papers, { 'рапорт': Object.assign({}, (w.papers || {})['рапорт'] || {},
      w.report ? { no: w.report } : {}) }), note: w.note || '' });

  /** Пропозиція сервера: рядки, людино-дні, залишок, попередження. Свіжа (`fresh`: нове вікно, знайдений рапорт) — ще й
   *  типові значення: вони лягають лише в порожні поля (і підігрівач — поки людина його не обирала). */
  async function spPreview(fresh = false) {
    const w = spWin;
    if (!w) return;
    fresh = fresh || !!w.fresh;                  // свіжа ще не дійшла: і цей запит свіжий, типові значення не губляться
    w.seq = (w.seq || 0) + 1;
    const seq = w.seq;
    if (fresh) w.fresh = true;                   // пакет оновлення сторінки (spPack) попросить її знову
    await actSettle();
    const { ok, j } = await actCall('api/sp-act/preview', Object.assign(spBody(w), fresh ? { fresh: true } : {}));
    if (spWin !== w || seq !== w.seq) return;
    w.fresh = false;
    if (w.drawn && !spShown(w)) { spWin = null; return; }       // вікно закрили (✕, Esc): відповідь, що спізнилася, його не відкриває
    if (ok && j.defaults) {
      const d = j.defaults;
      for (const k of ['date', 'number', 'holder', 'party', 'water']) if (!w[k]) w[k] = d[k] || '';
      if (!w.heaterSet && !w.heater) w.heater = d.heater || '';
      if (!w.rations.length) w.rations.push({ code: '', days: '', heater: null });
      if (!w.rations[0].code && d.ration) w.rations[0].code = d.ration;
      if (!(w.signers || []).length) w.signers = (d.signers || []).map((s) => Object.assign({}, s));
      for (const [role] of SP_PAPERS) {
        const x = (w.papers || {})[role] || {};
        if (!x.no && !x.date) w.papers[role] = Object.assign({}, (d.papers || {})[role] || {});
      }
    }
    w.prop = ok ? j : { error: true, lines: [], warnings: [j.error || 'Пропозицію акта не складено.'] };
    if (fresh || !w.drawn) spDraw();
    else if (spShown(w)) { spCalcDraw(w); spRationsSync(w); }
  }

  function spField(k, label, value, type = 'text', span = '') {
    return `<div class="field${span}"><label>${label}</label><input data-sa="${k}" type="${type}" value="${esc(value || '')}"
      autocomplete="off"></div>`;
  }
  function spSelect(k, label, value, options, none, span = '') {
    return `<div class="field${span}"><label>${label}</label><select data-sa="${k}"><option value="">${esc(none)}</option>${
      options.map(([v, t]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
  }

  /** Дні рапорту: дата й осіб кожного дня; правка — перерахунок. */
  function spDaysHtml(w) {
    const days = w.days || [];
    const persons = days.reduce((s, x) => s + (+x[1] || 0), 0);
    const rows = days.map(([d, n], i) => `<div class="sa-day"><input type="date" data-sa-day="${i}|0" value="${esc(d)}"
        aria-label="День ${i + 1}"><input type="number" min="1" step="1" data-sa-day="${i}|1" value="${esc(n)}"
        aria-label="Осіб, день ${i + 1}"><button type="button" class="btn btn--sm" data-act="sa-day-del" data-i="${i}"
        title="Прибрати день">✕</button></div>`).join('');
    return `<div class="sa-days"><div class="sa-days__head"><b>Дні рапорту</b><span>${days.length
      ? `${cnt(days.length, 'день', 'дні', 'днів')}, ${cnt(persons, 'людино-день', 'людино-дні', 'людино-днів')}` : 'днів ще немає'}</span>
      <button type="button" class="btn btn--sm" data-act="sa-day-add">+ День</button></div>
      <div class="sa-days__list">${rows || '<p class="sa-empty">Знайдіть рапорт у Добовці чи «+ День».</p>'}</div></div>`;
  }

  const spOptions = (list, value) => `<option value="">—</option>${list.map(([v, t]) =>
    `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(t)}</option>`).join('')}`;
  const spPersons = (w) => (w.days || []).reduce((s, x) => s + (+x[1] || 0), 0);
  const spRest = (w) => spPersons(w) - (w.rations || []).slice(1).reduce((s, r) => s + (+r.days || 0), 0);
  /** Позначка «з підігрівачем»: людина ставила — її, ні — як вирішив сервер (рядок пайка в пропозиції). */
  const spHeated = (w, r) => (r.heater != null ? r.heater
    : !!(((w.prop || {}).lines || []).find((l) => l.role === 'пайок' && l.code === r.code) || {}).heater);

  /** Пайки акта: код, людино-дні (першому — решта людино-днів рапорту), «з підігрівачем». */
  function spRationsHtml(w, list) {
    const rows = (w.rations || []).map((r, i) => `<div class="sa-day sa-line">
        <select data-sa-ration="${i}|code" aria-label="Пайок ${i + 1}">${spOptions(list, r.code)}</select>
        <input type="number" min="1" step="1" data-sa-ration="${i}|days" value="${esc(i ? r.days : Math.max(spRest(w), 0))}"
          aria-label="Людино-дні, пайок ${i + 1}"${i ? '' : ' readonly title="Решта людино-днів рапорту"'}>
        <label class="sa-check"><input type="checkbox" data-sa-ration="${i}|heater"${spHeated(w, r) ? ' checked' : ''}>з підігрівачем</label>
        ${i ? `<button type="button" class="btn btn--sm" data-act="sa-ration-del" data-i="${i}" title="Прибрати пайок">✕</button>` : ''}
      </div>`).join('');
    return `<div class="sa-days"><div class="sa-days__head"><b>Пайки</b><span>людино-дні, з підігрівачем</span>
      <button type="button" class="btn btn--sm" data-act="sa-ration-add">+ Пайок</button></div>
      <div class="sa-days__list">${rows}</div></div>`;
  }

  /** Інше: позиції книги СП з кількістю, вписаною людиною (готові страви, мюслі…). */
  function spOtherHtml(w, list) {
    const rows = (w.other || []).map((o, i) => `<div class="sa-day sa-line">
        <select data-sa-other="${i}|code" aria-label="Інше ${i + 1}">${spOptions(list, o.code)}</select>
        <input type="number" min="0" step="any" data-sa-other="${i}|qty" value="${esc(o.qty)}" aria-label="Кількість, інше ${i + 1}">
        <button type="button" class="btn btn--sm" data-act="sa-other-del" data-i="${i}" title="Прибрати">✕</button></div>`).join('');
    return `<div class="sa-days"><div class="sa-days__head"><b>Інше</b><span>${rows ? 'кількість вручну' : 'готові страви, мюслі'}</span>
      <button type="button" class="btn btn--sm" data-act="sa-other-add">+ Інше</button></div>
      ${rows ? `<div class="sa-days__list">${rows}</div>` : ''}</div>`;
  }

  /** Після пропозиції: решта людино-днів першого пайка й позначки, які людина не ставила, — як порахував сервер. */
  function spRationsSync(w) {
    if (!spShown(w)) return;
    const first = $('#modal [data-sa-ration="0|days"]');
    if (first) first.value = Math.max(spRest(w), 0);
    document.querySelectorAll('#modal [data-sa-ration$="|heater"]').forEach((box) => {
      const r = (w.rations || [])[+box.dataset.saRation.split('|')[0]];
      if (r && r.heater == null) box.checked = spHeated(w, r);
    });
  }

  /** Людино-дні, попередження й рядки — частина вікна, яку оновлює кожна пропозиція. Рядки лише для читання. */
  function spCalcHtml(w) {
    const p = w.prop || {};
    const lines = p.lines || [];
    const total = lines.reduce((s, l) => s + (+l.sum || 0), 0);
    const rows = lines.map((l) => `<div class="tbl__row tbl__row--plain">
        <div class="c-code">${esc(l.code)}</div><div class="c-name" title="${esc(l.name)}"><b>${esc(l.name)}</b></div>
        <div class="c-txt sa-rule" title="${esc(l.rule || '')}">${esc(l.rule || '')}</div>
        <div class="c-num c-num--wide">${fmtNum(l.stock, '0')}</div><div class="c-num c-num--wide"><b>${fmtNum(l.qty, '0')}</b> ${esc(l.uom || '')}</div>
        <div class="c-num c-num--xwide">${fmtMoney(l.sum)}</div></div>`).join('');
    const said = p.error ? '' : `<b>${fmtNum(p.rations || 0, '0')} людино-дн.</b><span>${p.holder ? `місце «${esc(p.holder)}»` : ''}</span>`;
    return `<div class="oa-rations">${said}</div>
      ${(p.warnings || []).length ? `<div class="callout oa-warn">${p.warnings.map(esc).join('<br>')}</div>` : ''}
      <div class="card card--scroll oa-lines"><div class="tbl" style="--tbl-min:720px"><div class="tbl__head">
        <div class="tbl__h c-code">код</div><div class="tbl__h c-name">найменування</div><div class="tbl__h c-txt sa-rule">як пораховано</div>
        <div class="tbl__h c-num c-num--wide">залишок</div><div class="tbl__h c-num c-num--wide">до списання</div>
        <div class="tbl__h c-num c-num--xwide">сума, грн</div></div>
        ${rows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Немає чого списувати.</div></div>'}
        ${lines.length ? `<div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-code"></div><div class="c-name"><b>Разом</b></div>
          <div class="c-txt sa-rule"></div><div class="c-num c-num--wide"></div><div class="c-num c-num--wide"></div>
          <div class="c-num c-num--xwide">${fmtMoney(total)}</div></div>` : ''}</div></div>`;
  }

  /** Підписанти й папери пакета: кожне поле правиться; лягають в акт знімком. */
  function spSigHtml(w) {
    const sig = (role, sort) => (w.signers || []).find((s) => s.role === role && +s.sort === sort) || {};
    const ph = { pos: 'посада', rank: 'звання', name: 'Ім’я ПРІЗВИЩЕ' };
    const people = SP_ROLES.map(([role, sort, label]) => {
      const s = sig(role, sort);
      return `<div class="oa-row"><span>${esc(label)}</span>${['pos', 'rank', 'name'].map((f) => `<input class="rc-in rc-in--wide"
        data-sa-sig="${esc(role)}|${sort}|${f}" value="${esc(s[f] || '')}" placeholder="${ph[f]}" aria-label="${esc(label)}: ${ph[f]}"
        autocomplete="off">`).join('')}</div>`;
    }).join('');
    const papers = SP_PAPERS.map(([role, label]) => {
      const x = (w.papers || {})[role] || {};
      return `<div class="oa-row oa-row--paper"><span>${esc(label)}</span><input class="rc-in rc-in--wide" data-sa-paper="${role}|no"
        value="${esc(x.no || '')}" placeholder="номер" aria-label="${esc(label)}: номер" autocomplete="off"><input class="rc-in rc-in--wide"
        type="date" data-sa-paper="${role}|date" value="${esc(x.date || '')}" aria-label="${esc(label)}: дата"></div>`;
    }).join('');
    const named = SP_ROLES.filter(([role, sort]) => String(sig(role, sort).name || '').trim()).length;
    return `<details class="fold oa-sig"${w.sigOpen ? ' open' : ''}><summary><span class="card__title">Підписанти й папери</span>
        <span class="fold__hint">${esc(cnt(named, 'підписант', 'підписанти', 'підписантів'))}</span></summary>
      <div class="oa-sig__body">
        <div class="oa-row oa-row--h"><span></span><span>посада</span><span>звання</span><span>ім’я та прізвище</span></div>${people}
        <div class="oa-row oa-row--h oa-row--paper"><span></span><span>номер</span><span>дата</span></div>${papers}
        <div class="oa-row oa-row--note"><span>Примітка</span><input class="rc-in rc-in--wide" data-sa="note" value="${esc(w.note || '')}"
          aria-label="Примітка" autocomplete="off"></div></div></details>`;
  }

  /** Слово внизу вікна; `force` — питання про файл пакета, правлений руками: поруч «Перезаписати» й «Скасувати», як у вікні
   *  акта ОП/МЗ (actMsgHtml). */
  const spMsgHtml = (w) => (w && w.msg && w.msg.text ? esc(w.msg.text) + (w.msg.download
    ? ` <a href="${esc(w.msg.download)}" download>Завантажити файли акта</a>` : '') + (w.msg.force
    ? ' <button type="button" class="btn btn--sm" data-act="sa-force">Перезаписати</button>'
      + ' <button type="button" class="btn btn--sm" data-act="sa-keep">Скасувати</button>' : '') : '');

  /** Вікно акта сухпаю цілком; поле у фокусі й прокрутка лишаються. */
  function spDraw() {
    const w = spWin;
    if (!w) return;
    const a = document.activeElement;
    const keep = spShown(w) && a && a.dataset ? ['sa', 'saDay', 'saRation', 'saOther', 'saSig', 'saPaper'].map((k) => [k, a.dataset[k]])
      .find((x) => x[1] != null) : null;
    const top = spShown(w) ? ($('#modal .modal__body') || {}).scrollTop || 0 : 0;
    const known = !!w.docId && !!actKey(w.docId);
    const fes = known ? ((store.docFes || {})[String(w.docId)] || {}).status || '' : '';
    const places = subs.filter((s) => s.active || s.name === w.holder).map((s) => [s.name, s.name]);
    const own = [w.heater, w.water, ...(w.rations || []).map((r) => r.code), ...(w.other || []).map((o) => o.code)]
      .filter(Boolean).map(String);
    const rations = spItems((i) => +i.perRation > 0, own);
    const others = spItems((i) => !(+i.perRation > 0), own);
    const all = spItems(() => true, own);
    const hint = !rations.length ? '<p class="sa-empty">Позиції сухпаю з дободачем ще немає: «Сухпай» → «Позиції» → «+ Нова позиція».</p>' : '';
    const el = modalOpen(w.docId ? `Акт ${numNo(w.was ? w.was.number : w.number)}` : 'Акт сухпаю', `<div class="pad oa sa" data-sa-win>
      <div class="form__grid oa-head">
        ${spField('report', 'Рапорт, вх. №', w.report)}
        <div class="field field--span2"><label>Добовка, аркуш «Сухпай»</label><div class="sa-find">
          <button type="button" class="btn" data-act="sa-find">Знайти в Добовці</button>
          <textarea data-sa-paste rows="1" placeholder="чи вставте аркуш: Ctrl+V" aria-label="Вставити аркуш «Сухпай»"></textarea></div></div>
        ${spField('label', 'Підрозділ', w.label)}${spField('party', 'Одержувач у паперах', w.party, 'text', ' field--span2')}
        ${spSelect('holder', 'Місце', w.holder, places, '—', ' field--span2')}
        ${spSelect('heater', 'Підігрівач', w.heater, others, 'без підігрівачів', ' field--span2')}
        ${spSelect('water', 'Вода', w.water, others, 'без води', ' field--span2')}
        ${spField('date', 'Дата акта', w.date, 'date')}${spField('number', 'Номер', w.number)}
      </div>${hint}
      ${spRationsHtml(w, rations)}${spOtherHtml(w, all)}
      ${spDaysHtml(w)}
      <div class="oa-calc">${spCalcHtml(w)}</div>
      ${spSigHtml(w)}
      <div class="oa-acts">
        ${known ? `<label class="chip${fes ? ' is-on' : ''}"><span class="chip__label">статус ФЕС</span><select data-sa-fes>
          <option value="">—</option>${FES_STATUSES.map((s) => `<option${s === fes ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>` : ''}
        ${w.docId ? '<button type="button" class="btn btn--danger" data-act="sa-del">Видалити</button>' : ''}
        <span class="oa-msg${w.msg && w.msg.bad ? ' num-bad' : ''}">${spMsgHtml(w)}</span>
        ${w.docId ? `${known ? '<button type="button" class="btn" data-act="sa-card">Картка документа</button>' : ''}
          ${me.remote ? '' : '<button type="button" class="btn" data-act="sa-reveal">Відкрити теку</button>'}
          <button type="button" class="btn" data-act="sa-files">Перескласти файли</button>` : ''}
        <button type="button" class="btn" data-act="sa-close">Закрити</button>
        <button type="button" class="btn btn--primary" data-act="sa-save">${w.docId ? 'Зберегти' : 'Скласти акт'}</button>
      </div></div>`, 'modal__box--form modal__box--wide');
    w.drawn = true;
    spBind(el, w);
    const body = el.querySelector('.modal__body');
    if (body && top) body.scrollTop = top;
    if (keep) [...el.querySelectorAll('input, select')].find((x) => x.dataset[keep[0]] === keep[1])?.focus();
  }

  /** Лише людино-дні, попередження й рядки. На час запису (w.busy) перерахунок, що спізнився, не малюється: він домалюється,
   *  коли запис скінчиться відмовою (spPost), як у вікні акта ОП/МЗ. */
  function spCalcDraw(w) {
    if (w.busy) { w.calcLate = true; return; }
    w.calcLate = false;
    const box = $('#modal [data-sa-win] .oa-calc');
    if (box) box.innerHTML = spCalcHtml(w);
  }

  /** Поле вікна змінили: перерахунок за 0,4 с після останньої правки (місце, пайок, дні — одразу видно рядки). */
  function spSoon(w) {
    clearTimeout(w.timer);
    w.timer = setTimeout(() => { if (spWin === w) spPreview(false); }, 400);
  }

  /** Поле вікна. Номер і дата накладної й роздавальної йдуть за номером і датою акта, поки їх не правили руками; номер
   *  рапорту — одне число в полі «Рапорт, вх. №» і в рядку паперу «рапорт» (spReportRow — у зворотний бік). */
  function spSet(w, k, v) {
    const was = w[k];
    w[k] = v;
    if (String(was ?? '') !== String(v ?? '')) spDropForce(w);
    if (k === 'heater') w.heaterSet = true;
    if (k === 'report') {
      w.papers = Object.assign({}, w.papers, { 'рапорт': Object.assign({}, (w.papers || {})['рапорт'] || {}, { no: v }) });
      const row = [...document.querySelectorAll('#modal [data-sa-paper]')].find((e) => e.dataset.saPaper === 'рапорт|no');
      if (row && row.value !== v) row.value = v;
      return;
    }
    if (k !== 'number' && k !== 'date') return;
    const f = k === 'number' ? 'no' : 'date';
    for (const role of ['накладна', 'роздавальна']) {
      const x = (w.papers || {})[role];
      if (!x || (x[f] || '') !== (was || '')) continue;
      x[f] = v;
      const inp = [...document.querySelectorAll('#modal [data-sa-paper]')].find((e) => e.dataset.saPaper === `${role}|${f}`);
      if (inp) inp.value = v;
    }
  }

  function spBind(el, w) {
    el.querySelectorAll('[data-sa]').forEach((f) => f.addEventListener('change', () => {
      spSet(w, f.dataset.sa, f.value);
      if (f.dataset.sa !== 'note' && f.dataset.sa !== 'report') spSoon(w);
    }));
    el.querySelectorAll('[data-sa-day]').forEach((f) => f.addEventListener('change', () => {
      const [i, k] = f.dataset.saDay.split('|').map(Number);
      if (!w.days[i]) return;
      w.days[i][k] = k ? (Number(f.value) || 0) : f.value;
      spDropForce(w);
      spRationsSync(w);
      spSoon(w);
    }));
    el.querySelectorAll('[data-sa-ration]').forEach((f) => f.addEventListener('change', () => {
      const [i, k] = f.dataset.saRation.split('|');
      const r = (w.rations || [])[+i];
      if (!r) return;
      if (k === 'heater') r.heater = f.checked;
      else if (k === 'days') r.days = f.value;
      else { r.code = f.value; r.heater = null; }          // інший пайок — позначка, як підкаже сервер
      spDropForce(w);
      spRationsSync(w);
      spSoon(w);
    }));
    el.querySelectorAll('[data-sa-other]').forEach((f) => f.addEventListener('change', () => {
      const [i, k] = f.dataset.saOther.split('|');
      const o = (w.other || [])[+i];
      if (!o) return;
      o[k] = f.value;
      spDropForce(w);
      spSoon(w);
    }));
    el.querySelectorAll('[data-sa-sig]').forEach((f) => f.addEventListener('input', () => {
      const [role, sort, k] = f.dataset.saSig.split('|');
      let s = w.signers.find((x) => x.role === role && +x.sort === +sort);
      if (!s) { s = { role, sort: +sort, pos: '', rank: '', name: '' }; w.signers.push(s); }
      s[k] = f.value;
      spDropForce(w);
    }));
    el.querySelectorAll('[data-sa-paper]').forEach((f) => f.addEventListener('input', () => {
      const [role, k] = f.dataset.saPaper.split('|');
      w.papers[role] = Object.assign({}, w.papers[role] || {}, { [k]: f.value });
      spDropForce(w);
      if (role === 'рапорт' && k === 'no') spReportRow(w, f.value);
    }));
    el.querySelector('details.oa-sig')?.addEventListener('toggle', (e) => { w.sigOpen = e.target.open; });
    el.querySelector('[data-sa-fes]')?.addEventListener('change', (e) => {
      fesSet(String(w.docId), { status: e.target.value });
      e.target.closest('.chip')?.classList.toggle('is-on', !!e.target.value);
      render();
    });
    el.querySelector('[data-sa-paste]')?.addEventListener('paste', (e) => {
      e.preventDefault();
      spFind((e.clipboardData || window.clipboardData).getData('text'));
    });
  }

  /** Поля вікна — у стан перед записом: значення, уписане й не підтверджене (без події change), теж іде. */
  function spTake(w) {
    if (!spShown(w)) return;
    document.querySelectorAll('#modal [data-sa]').forEach((el) => {
      if (!el.disabled && String(w[el.dataset.sa] ?? '') !== el.value) spSet(w, el.dataset.sa, el.value);
    });
    document.querySelectorAll('#modal [data-sa-ration$="|days"]:not([readonly])').forEach((el) => {
      const r = (w.rations || [])[+el.dataset.saRation.split('|')[0]];
      if (r) r.days = el.value;
    });
    document.querySelectorAll('#modal [data-sa-other$="|qty"]').forEach((el) => {
      const o = (w.other || [])[+el.dataset.saOther.split('|')[0]];
      if (o) o.qty = el.value;
    });
  }

  /** Номер рапорту, виправлений у рядку паперу «рапорт», — і в полі «Рапорт, вх. №» угорі: інакше spTake повернув би звідти
   *  старий номер (зворотний бік — spSet). */
  function spReportRow(w, v) {
    w.report = v;
    const top = $('#modal [data-sa="report"]');
    if (top && top.value !== v) top.value = v;
  }

  /** Слово внизу вікна; вікна немає на екрані — звичайне повідомлення. `force` — слово-питання про файл пакета, правлений
   *  руками ('save' — повторити «Скласти акт» / «Зберегти», 'files' — «Перескласти файли»): поруч «Перезаписати» й «Скасувати». */
  function spSay(w, text, bad = false, download = '', force = '') {
    if (w) w.msg = text ? { text, bad, download, force } : null;
    const el = spShown(w) ? $('#modal [data-sa-win] .oa-msg') : null;
    if (el) { el.className = 'oa-msg' + (bad ? ' num-bad' : ''); el.innerHTML = spMsgHtml(w); return; }
    if (text) toast(text, bad);
  }
  /** Справжня правка вікна після питання «Перезаписати» знімає питання: воно повторює лише той запит, про який спитали. */
  function spDropForce(w) {
    if (w && w.msg && w.msg.force) spSay(w, '');
  }

  /** «Знайти в Добовці» (без `text` — найновіша Добовка теки «Добовка») чи вставка аркуша «Сухпай»: дні й особи рапорту,
   *  підрозділ, дата рапорту; акт, уже вписаний у ці дні Добовки, — попередженням. Далі — свіжа пропозиція. */
  async function spFind(text = '') {
    const w = spWin;
    if (!w) return;
    spTake(w);
    const report = String(w.report || '').trim();
    if (!report) { spSay(w, 'Вкажіть номер рапорту.', true); return; }
    const { ok, j } = await actCall('api/sp-act/report', text ? { report, text } : { report });
    if (spWin !== w) return;
    if (!ok) { spSay(w, j.error || 'Рапорт не знайдено.', true); return; }
    w.days = (j.days || []).map((x) => [x[0], x[1]]);
    if (!w.docId || !w.label) w.label = j.label || '';
    const was = (w.papers || {})['рапорт'] || {};
    w.papers = Object.assign({}, w.papers, { 'рапорт': { no: report, date: j.reportDate || was.date || '' } });
    const own = w.was ? w.was.number : '';
    const other = (j.acts || []).filter((x) => x !== own);
    w.msg = { text: `Рапорт №${report}: ${j.label}, ${cnt(w.days.length, 'день', 'дні', 'днів')}${j.file ? ` (${j.file})` : ''}.`
      + (other.length ? ` У Добовці вже вписано акт ${other.join(', ')}.` : '')
      + ((j.others || []).length ? ` Той самий рапорт ще в: ${j.others.join(', ')}.` : ''), bad: !!other.length };
    await spPreview(true);
  }

  function spBusy(w, on) {
    if (!spShown(w)) return;
    document.querySelectorAll('#modal [data-sa-win] .oa-acts .btn, #modal [data-sa-fes]').forEach((b) => { b.disabled = on; });
  }

  /** Запит, що змінює базу (скласти, перескласти файли, видалити): спершу внесене на сторінці лягає в базу; кнопки на
   *  час запиту вимкнені. Акт записано, а файли ні (відповідь із docId), — вікно стає цим актом, і повтор другого не складе.
   *  Файл пакета правили руками (скажімо, вписали прізвища в роздавальну; 409 з `changed`): слово сервера з питанням —
   *  «Перезаписати» повторює запит із `force: true`, «Скасувати» лишає файли, як у вікні акта ОП/МЗ (actPost). Сервер не
   *  прийняв акт (422) — вікно перераховується, і рядки «Бракує…» — свіжі. Сторінка, що тим часом оновилась, поєднавши
   *  правки, ставить вікно на місце (spPack) і каже, що запит не пішов (actUndone). */
  async function spPost(w, path, payload) {
    if (!w || w.busy) return null;
    w.busy = true;
    spBusy(w, true);
    spSay(w, '');
    w.undone = `${actUndone(path, w)}: сторінка оновилась, поєднавши правки. Натисніть ще раз.`;
    let done = false;
    try {
      if (!(await actSettle())) { spSay(w, 'Внесене на сторінці ще не записано в базу. Спробуйте ще раз.', true); return null; }
      w.undone = '';                             // запит пішов: чим він скінчився, скаже відповідь
      const { ok, status, j } = await actCall(path, payload);
      if (ok) { done = true; return j; }
      if (j.docId) {
        // `sig` — відбиток акта таким, яким його щойно записано: зміни з іншого вікна далі видно (op_acts._same_act).
        const no = String(j.number || w.number || '').trim();
        Object.assign(w, { docId: Number(j.docId), number: no, was: { number: no, date: w.date, sig: String(j.sig || '') } });
        if (spShown(w)) spDraw();
      }
      if (status === 409 && Array.isArray(j.changed)) {
        spSay(w, j.error || 'Файл пакета змінено після програми. Перезаписати?', true, '',
          !j.docId && /\/save$/.test(path) ? 'save' : 'files');
        return null;
      }
      spSay(w, j.error || `Не вдалося: помилка ${status}.`, true);
      if (status === 422 && !j.docId && /\/save$/.test(path)) setTimeout(() => { if (spWin === w) spPreview(false); }, 0);
      return null;
    } finally {
      if (!done) {
        w.busy = false;
        w.undone = '';
        spBusy(w, false);
        if (w.calcLate) spCalcDraw(w);           // перерахунок, що спізнився, домальовується
      }
    }
  }

  /** «Перезаписати» в слові-питанні: людина погодилась переписати файл пакета, правлений руками. */
  function spForce() {
    const w = spWin;
    const kind = w && w.msg && w.msg.force;
    if (!kind || w.busy) return null;
    spTake(w);                                   // уписане, що ще не дало change, — теж правка після питання: воно знімається
    if (!w.msg || w.msg.force !== kind) return null;
    return kind === 'save' ? spSave(true) : spFiles(true);
  }
  /** «Скасувати» після питання «Перезаписати»: що лишилось як було (після «Скласти акт» / «Зберегти» — нічого не записано). */
  function spKeep() {
    const w = spWin;
    spSay(w, !w ? '' : w.msg && w.msg.force === 'save' ? 'Акт не записано, файли лишились як були.' : 'Файли лишились як були.');
  }

  /** Акт у закритому періоді (підписана звірка місця, завершена інвентаризація) — лише з явної згоди. */
  function spLock(w, verb, dates) {
    const doc = w.docId ? docs.find((r) => String(r.id) === String(w.docId)) : null;
    const lock = periodLock(dates, [w.holder, doc ? doc.from : '']);
    if (lock && !histOn() && !confirm(lock.replace(/\n\nДля внесення старих документів[^\n]*/, '').replace('Провести все одно?', verb))) {
      return null;                                         // людина відмовилась
    }
    return !!lock;                                         // true — запис у закритому періоді (позначка в журналі змін)
  }

  /** Перед «Скласти акт» / «Зберегти»: дати акта й паперів — за правилами форми документа (рік з опискою, у майбутньому,
   *  раніше за початок обліку), як у вікні акта ОП/МЗ; дні рапорту — з повним роком (видача буває й наперед). Усе гаразд — ''. */
  function spDatesBad(w) {
    const first = firstDay();
    if (!w.date) return 'Вкажіть дату акта.';
    const dates = [[w.date, 'акта']].concat(SP_PAPERS.map(([role, label]) => [((w.papers || {})[role] || {}).date, `паперу «${label}»`]));
    for (const [d, what] of dates) {
      const bad = d ? actDateRule(d, what, first) : '';
      if (bad) return bad;
    }
    const odd = (w.days || []).map(([d]) => (d ? dateYearOdd(d) : 0)).find(Boolean);
    return odd ? `У дні рапорту рік ${odd}: уведіть рік повністю, чотирма цифрами.` : '';
  }

  /** «Скласти акт» / «Зберегти». `force` — «Перезаписати» після питання про файл пакета, правлений руками. */
  async function spSave(force = false) {
    const w = spWin;
    if (!w || w.busy) return;
    spTake(w);
    if (!String(w.number || '').trim()) { spSay(w, 'Вкажіть номер акта.', true); return; }
    if (!w.holder) { spSay(w, 'Оберіть місце, з якого списується сухпай.', true); return; }
    if (!(w.days || []).length) { spSay(w, 'Немає днів рапорту: знайдіть рапорт у Добовці чи «+ День».', true); return; }
    const dates = spDatesBad(w);
    if (dates) { spSay(w, dates, true); return; }
    clearTimeout(w.timer);
    const edit = !!w.docId;
    const closed = spLock(w, edit ? 'Зберегти все одно?' : 'Скласти все одно?', [w.date, w.was ? w.was.date : '']);
    if (closed === null) return;
    const payload = Object.assign(spBody(w), closed ? { locked: true } : {});
    if (w.docId) payload.was = w.was;
    if (force === true) payload.force = true;
    const j = await spPost(w, 'api/sp-act/save', payload);
    if (!j) return;
    const no = String(j.number || w.number).trim();
    const locked = (j.locked || []).length ? ' Відкритий в Excel файл записано поруч.' : '';
    afterReload('acts', { book: 'СП' }, `Акт ${numNo(no)} ${edit ? 'збережено' : 'складено'}.${locked}`,
      j.download ? { download: j.download } : me.remote ? {} : { reveal: j.docId });
  }

  /** «Перескласти файли»; `force` — «Перезаписати» після питання про файл пакета, правлений руками. */
  async function spFiles(force = false) {
    const w = spWin;
    if (!w || !w.docId) return;
    const j = await spPost(w, 'api/sp-act/files', force === true ? { docId: w.docId, force: true } : { docId: w.docId });
    if (!j) return;
    const locked = (j.locked || []).length ? ' Відкритий в Excel файл записано поруч.' : '';
    afterReload(state.view, Object.assign({}, syncView().state, { book: state.book }),
      `Файли акта ${numNo(w.was ? w.was.number : w.number)} перескладено.${locked}`,
      Object.assign({ open: w.docId }, j.download ? { download: j.download } : {}));
  }

  async function spDelete() {
    const w = spWin;
    if (!w || !w.docId || w.busy) return;
    const no = w.was ? w.was.number : w.number;
    if (!confirm(`Видалити акт ${numNo(no)}? Документ вибуття зникне з обліку, файли в теці лишаться.`)) return;
    const closed = spLock(w, 'Видалити все одно?', [w.was ? w.was.date : w.date]);
    if (closed === null) return;
    const id = w.docId;
    const j = await spPost(w, 'api/sp-act/delete', Object.assign({ docId: w.docId, was: w.was }, closed ? { locked: true } : {}));
    if (!j) return;
    docFieldsForget(id);                         // id видаленого останнім документа вільний: новий документ не успадкує полів акта
    afterReload('acts', { book: 'СП' }, `Акт ${numNo(j.number || no)} видалено.`);
  }

  function spCard() {
    const key = actKey(spWin && spWin.docId);
    if (!key) { spSay(spWin, 'Документа акта на сторінці ще немає. Оновіть сторінку (F5).', true); return; }
    spWin = null;
    modalClose();
    openDoc(key, { plain: true });
  }

  /** Поля вікна акта сухпаю, що переживають оновлення сторінки, яке зливає правки двох людей (syncLeave): уписане (рапорт,
   *  підрозділ, одержувач, місце, пайки, підігрівач, вода, інше, дні, дата, номер, підписанти, папери, примітка), складений акт
   *  (docId, яким його відкрило вікно) і пораховане — як у вікна акта ОП/МЗ (actPack). */
  const SP_KEEP = ['docId', 'report', 'label', 'party', 'holder', 'rations', 'heater', 'heaterSet', 'water', 'other', 'days',
    'date', 'number', 'signers', 'papers', 'note', 'was', 'prop', 'msg', 'sigOpen'];
  /** Відкрите вікно акта сухпаю — для пакета syncLeave (без таймера й запиту, що йде); вікна немає — null. */
  function spPack() {
    const w = spWin;
    if (!w || !spShown(w)) return null;
    spTake(w);                                   // уписане, що ще не дало події change
    const out = {};
    for (const k of SP_KEEP) if (w[k] !== undefined) out[k] = w[k];
    if (w.undone) out.msg = { text: w.undone, bad: true };      // запит чекав на базу й не пішов — вікно каже це саме
    if (w.fresh) out.fresh = true;               // свіжа пропозиція не дійшла — після оновлення її просять знову
    try { return JSON.parse(JSON.stringify(out)); } catch (e) { return null; }
  }
  /** Після оновлення, що злило правки (syncLeave): вікно акта сухпаю знову на екрані з усім, що в ньому було. Складений акт,
   *  який тим часом змінили чи видалили в іншому вікні, мовчки не переписується: слово у вікні каже, що сталося. */
  function spRestore(pack) {
    if (!pack || typeof pack !== 'object') return;
    const w = Object.assign({ docId: 0, rations: [], other: [], days: [], signers: [], papers: {}, note: '' }, pack);
    delete w.fresh;
    if (!w.rations.length) w.rations.push({ code: '', days: '', heater: null });
    if (w.docId) {
      const now = spState(w.docId);
      const no = numNo(w.was ? w.was.number : w.number);
      if (!now) {
        w.msg = { text: `Акт ${no} тим часом видалили в іншому вікні. «Скласти акт» складе його знову з тим, що у вікні.`, bad: true };
        Object.assign(w, { docId: 0, was: null });
      } else if (!actSameWas(w.was, now.was)) {
        w.msg = { text: `Акт ${no} тим часом змінили в іншому вікні. «Зберегти» запише те, що у вікні, «Закрити» лишить змінений.`,
          bad: true };
        w.was = now.was;                         // людину спитали: «Зберегти» тепер переписує саме теперішній акт бази
      }
    }
    actWin = null;
    spWin = w;
    if (!pack.docId && (pack.fresh || !w.prop)) { spPreview(true); return; }     // пропозиція нового акта так і не дійшла
    spDraw();
    spPreview(false);                            // рядки й залишки — з бази, куди щойно лягли злиті правки
  }

  function spAction(name, d) {
    const w = spWin;
    switch (name) {
      case 'sa-new': return spActNew();
      case 'sa-open': return spActOpen(d.id);
      case 'sa-close': spWin = null; return modalClose();
      case 'sa-find': return spFind();
      case 'sa-day-add': {
        if (!w) return null;
        spTake(w);
        const last = (w.days[w.days.length - 1] || [])[0];
        const next = last ? new Date(new Date(last + 'T12:00:00').getTime() + 86400000).toISOString().slice(0, 10) : w.date || today();
        w.days.push([next, (w.days[w.days.length - 1] || [])[1] || 1]);
        spDraw();
        return spSoon(w);
      }
      case 'sa-day-del': if (!w) return null; spTake(w); w.days.splice(+d.i, 1); spDraw(); return spSoon(w);
      case 'sa-ration-add': if (!w) return null; spTake(w); w.rations.push({ code: '', days: '', heater: null }); return spDraw();
      case 'sa-ration-del': if (!w) return null; spTake(w); w.rations.splice(+d.i, 1); spDraw(); return spSoon(w);
      case 'sa-other-add': if (!w) return null; spTake(w); w.other.push({ code: '', qty: '' }); return spDraw();
      case 'sa-other-del': if (!w) return null; spTake(w); w.other.splice(+d.i, 1); spDraw(); return spSoon(w);
      case 'sa-save': return spSave();
      case 'sa-files': return spFiles();
      case 'sa-force': return spForce();
      case 'sa-keep': return spKeep();
      case 'sa-reveal': return actReveal(d.id || (w && w.docId));
      case 'sa-del': return spDelete();
      case 'sa-card': return spCard();
      default: return null;
    }
  }
