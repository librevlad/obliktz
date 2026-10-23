// Облік ТЗ ПС · сторінка · 2/Прод.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ---------------------------------------------------------------- 2/Прод
  /** Звіт-заявка 2/прод: дані рахує сервер з бази книг ТЗ і ОП (api/form2); сторінка тримає останню
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
  /** Позиції, що йдуть у 2/Прод: книг ТЗ і ОП (звіт сервера читає лише їх); сухпай і реторт-пакети мають свої книги й звіти, прив'язувати
   *  їх нікуди — у переліку «не прив'язано» вони тільки засмічували б відповідність. */
  const form2Items = () => items.filter((i) => !i.archived && !isSpRp(bookOfItem(i)));
  function form2MapTab() {
    const map = new Map(form2MapNow().map((m) => [m.code, m]));
    const rowName = f2RowName();
    const rows = form2Items().map((i) => ({ it: i, m: map.get(i.code) || null }));
    const reg = registry({
      id: 'f2m', rows, minWidth: '1000px', search: (r) => [r.it.code, r.it.name, r.m && r.m.row ? String(r.m.row) : ''],
      placeholder: 'Код, назва чи рядок',
      filters: [{ type: 'seg', key: 'st', options: [['', 'усі'], ['не прив’язано', 'не прив’язано'], ['уточнити', 'уточнити'],
        ['поза 2/прод', 'поза 2/прод']], test: (r, v) => f2State(r.m) === v },
      { type: 'seg', key: 'book', options: [['', 'ТЗ і ОП'], ['ТЗ', 'ТЗ'], ['ОП', 'ОП']], test: (r, v) => bookOfItem(r.it) === v }],
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
  /** Прив'язка позиції до рядка 2/Прод у картці позиції (книги ТЗ і ОП; позиція сухпаю чи реторт-пакетів блока не має). */
  function form2ItemCard(i) {
    if (isSpRp(bookOfItem(i))) return '';
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

  /** Заявка на посуд, миючі й серветки на 30 днів за нормами наказу МОУ №390: середні добові видачі — середнє дободач
   *  пунктів, що списують зі складу, за останні 30 днів із даними (поле правиться; даних немає — останнє вписане), кількості
   *  й округлення до упаковки рахує програма, лист — у Word. */
  const OP_REQUEST_NORMS = (D.opNorms && D.opNorms.requestView) || [];       // [підпис, норма, крок, одиниця]: слова вікна, не листа
  function opRequestDialog() {
    const last = (store.ui && store.ui.opRequest) || { perDay: '', to: '' };
    modalOpen('Заявка на 30 днів', `<div class="pad"><div class="form__grid">
      <div class="field"><label>Середні добові видачі, д/д</label><input data-opr="perDay" inputmode="decimal" value="${esc(rationsAverage() || last.perDay)}"></div>
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
        return `<div class="f2-check">${esc(n)}: ${fmtNum(+raw.toFixed(2))} → <b>${fmtNum(Math.ceil(raw / step - 1e-9) * step)}</b> ${esc(u)}</div>`;
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

  /** Звірка книги ОП чи СП зі звітом ФЕС «Залишки ТМЦ» (1С): розбіжності по кодах, партії, документи в
   *  дорозі. Позиція ФЕС (код ФЕС + ціна) зіставляється з кодом книги один раз — відповідність
   *  лишається в базі; так само місця ФЕС → підрозділи. Позиція з кодом однієї книги в звірці іншої
   *  не питається; «не з книги» — для кожної книги своє («-ОП СП»). Книга результату лягає в теку звірок. */
  const FES_BOOKS = ['ОП', 'СП'];
  async function opFes(file) {
    state.fesFile = file;
    state.fesBook = FES_BOOKS.includes(state.book) ? state.book : 'ОП';
    let j = {};
    try {
      await flush();
      const r = await fetch(`api/op-fes?asOf=${state.asOf}&book=${encodeURIComponent(state.fesBook)}`, { method: 'POST', body: file });
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
    const book = j.book || 'ОП';
    const opItems = items.filter((i) => bookOfItem(i) === book && !i.archived);
    const places = (store.fesPlaces && typeof store.fesPlaces === 'object') ? store.fesPlaces : {};
    const um = j.unmapped.map((u) => `<div class="f2-check">${esc(u.code)} «${esc(u.name)}» · ${fmtMoney(u.price)} грн
        <select data-fesmap="${esc(u.code)}|${Math.round(u.price * 100)}" aria-label="код книги"><option value="">—</option>
          <option value="-">не з книги ${esc(book)}</option>${opItems.map((i) => `<option value="${esc(i.code)}">${esc(i.code)} ${esc(i.name)} · ${fmtMoney(i.price)}</option>`).join('')}</select></div>`).join('');
    const pl = (j.places || []).map((name) => `<div class="f2-check">${esc(name)}
        <select data-fesplace="${esc(name)}" aria-label="підрозділ"><option value="">—</option>${subs.filter((sb) => sb.active).map((sb) =>
          `<option${places[name] === sb.name ? ' selected' : ''}>${esc(sb.name)}</option>`).join('')}</select></div>`).join('');
    const rows = j.rows.map((r) => `<div class="tbl__row"><div class="c-code">${esc(r.code)}</div><div class="c-name"><b>${esc(r.name)}</b></div>
        <div class="c-num">${fmtNum(r.fes, '0')}</div><div class="c-num">${fmtNum(r.book, '0')}</div>
        <div class="c-num${Math.abs(r.diff) > 1e-9 ? ' num-bad' : ''}">${fmtNum(r.diff, '0')}</div></div>`).join('');
    const lots = j.batches.filter((b) => b.fes == null || b.book == null || Math.abs(b.fes - b.book) > 1e-9)
      .map((b) => `<div class="f2-check">${esc(b.code)} · ${b.date ? fmtDate(b.date) : '—'} · ${esc(b.doc)} · ФЕС ${b.fes == null ? '—' : fmtNum(b.fes, '0')}
        · облік ${b.book == null ? 'такого приходу немає' : fmtNum(b.book, '0')}</div>`).join('');
    modalOpen(`Звірка ${esc(book)} з ФЕС на ${fmtDate(j.as_of)}`, `<div class="pad">
      <div class="card card--scroll"><div class="tbl" style="--tbl-min:560px"><div class="tbl__head">
        <div class="tbl__h c-code">код</div><div class="tbl__h c-name">найменування</div><div class="tbl__h c-num">ФЕС</div>
        <div class="tbl__h c-num">облік</div><div class="tbl__h c-num">різниця</div></div>${rows
          || `<div class="tbl__row tbl__row--plain"><div class="c-txt">Позицій книги ${esc(book)} у звіті ФЕС немає: зіставте їх нижче.</div></div>`}</div></div>
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
    const book = state.fesBook || 'ОП';
    document.querySelectorAll('#modal [data-fesmap]').forEach((el) => {
      if (!el.value) return;
      if (el.value !== '-') { store.fesMap[el.dataset.fesmap] = el.value; return; }
      const cur = store.fesMap[el.dataset.fesmap];                 // «не з книги» інших книг лишається
      const marks = new Set(typeof cur === 'string' && cur.startsWith('-') ? cur.slice(1).split(' ').filter(Boolean)
        : cur === '' ? ['ОП'] : []);
      marks.add(book);
      store.fesMap[el.dataset.fesmap] = `-${[...marks].join(' ')}`;
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
    // Тека без типового значення (Добовка: програма її лише читає) порожньою не означає «типова».
    const hint = (f) => (f.key === 'dobovka' ? 'Повний шлях до теки з файлом «Добовка*.xlsx». Програма теку лише читає.'
      : f.default ? 'Повний шлях до теки; порожньо — типова тека' : 'Повний шлях до теки');
    return `<div class="set-form">${state.folders.map((f) => `<div class="field"><label>${esc(f.label)}</label>
        <input data-folder="${esc(f.key)}" value="${esc(f.set ? f.path : '')}" placeholder="${esc(f.default || 'не задано')}"
          title="${esc(hint(f))}"></div>`).join('')}
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
