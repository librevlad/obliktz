// Облік ТЗ ПС · сторінка · журнали № 47 і № 14.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

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
    if (isSpRp(state.book) && !mine.length) return bookEmptyJournal('j47', state.book);
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
      body: `${state.book === 'ОП' ? opBookPanel() : isSpRp(state.book) ? bookPanel(state.book) : ''}<div class="panel">
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
    if (isSpRp(state.book) && !docs.some((r) => bookOf(r.code) === state.book)) return bookEmptyJournal('j14', state.book);
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
      // Книга лягла, але назад читається не вся (скажімо, дата з опискою в році): книга на місці, а що в ній не так — рядком на
      // кожну причину, щоб виправити до того, як нею вести облік руками.
      const back = Array.isArray(j.readBack) ? j.readBack.filter(Boolean) : [];
      if (back.length) {
        modalOpen('Книгу вивантажено', `<div class="pad"><p>${esc(`Книгу вивантажено: ${j.path}.`)} Назад вона читається не вся:</p>
          ${listHtml(back)}</div>`, 'modal__box--form');
        return;
      }
      toast(`Книгу вивантажено: ${j.path}`);
    } catch (e) { toast(`Не вдалося вивантажити книгу: ${e.message || e}`, true); }
  }
  /** Книга, яку переглядають: «Прийняти» на базі, що змінилась після перегляду (409), переглядає той самий файл наново. */
  let opBookFile = null;
  async function opImport(file, legacy) {
    opBookFile = { file, legacy };
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
    const acts = d.acts || {};
    const points = d.points || {};
    const days = (d.rations || {}).changed || 0;
    const places = (j.places || []).map((p) => `<div class="field"><label>${esc(p)}</label>
        <select data-op-place="${esc(p)}"><option value="">як є</option>${subs.filter((sb) => sb.active).map((sb) =>
          `<option${sb.name === p ? ' selected' : ''}>${esc(sb.name)}</option>`).join('')}</select></div>`).join('');
    modalOpen(legacy ? 'Перенесення старої книги ОП' : 'Прийняти книгу ОП', `<div class="pad op-preview">
      ${d.same ? '<p>Книга збігається з програмою.</p>' : ''}
      ${part('Нові документи', d.docs.new)}${part('Змінені документи', d.docs.changed)}${part('Прибрані документи', d.docs.removed)}
      ${part('Нові позиції', d.items.new)}${part('Змінені позиції', d.items.changed)}${part('Прибрані позиції', d.items.removed)}
      ${part('Нові акти', acts.new)}${part('Змінені акти', acts.changed)}${part('Прибрані акти', acts.removed)}
      ${days ? `<h4>${esc(`Дободачі · змінених записів ${days}`)}</h4>` : ''}
      ${part('Нові пункти харчування', points.new)}${part('Змінені пункти харчування', points.changed)}${
        part('Прибрані пункти харчування', points.removed)}
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
    if (status === 409 && j.diff && opBookFile) {                       // облік ОП змінився після перегляду: той самий файл — наново
      toast(j.error || 'Облік ОП змінився після перегляду.', true);
      await opImport(opBookFile.file, opBookFile.legacy);
      return;
    }
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
