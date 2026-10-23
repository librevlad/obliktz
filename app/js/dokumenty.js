// Облік ТЗ ПС · сторінка · документи, підбір рядків, партії, одиниці.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

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
      : isSpRp(state.book) ? bookEmptyDocs(state.book)
      : emptyBlock('⇆', op ? 'Документів посуду й миючих ще немає' : 'Документів ще немає',
        op ? 'Внесіть прихід або перенесіть стару книгу «Облік ОП».' : 'Внесіть перший прихід.',
        (formOpen() ? '' : '<button class="btn btn--primary" data-act="doc-new">+ Новий документ</button>')
        + (op && native ? '<button class="btn" data-act="op-legacy">Перенести стару книгу…</button>' : ''));

    return {
      head: head(isSpRp(state.book) ? `${BOOKS[state.book].crumb} / документи`
        : op ? 'посуд і миючі / документи' : 'техзасоби / первинні документи', 'Документи',
        // Своя кнопка нового документа, а не спільна: вона ховається, поки
        // форма відкрита, — інакше в шапці стояли дві однакові.
        searchBox('Пошук: номер, код, найменування, підрозділ, зав. №, примітка') + actionsExcel
        + (state.book === 'СП' ? '<button class="btn" data-act="book-q1prod" data-book="СП" '
          + 'title="Квартал звіту 1/прод за Добовкою">Розрахувати «1прод»</button>' : '')
        + '<button class="btn" data-act="pd-fes-register">Реєстр на ФЕС…</button>'
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
      const units = (byUnit() && where && book === 'ТЗ' ? unitsAt(it.code, where, date) : [])
        .filter((u) => !gone.has(String(u.id)));
      const lots = byLot() && where && book === 'ТЗ' ? lotChoices(it.code, where, date) : [];
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
    state.newItem = { code: nextCode(state.book), name: typed, unit: 'шт',
                      group: isSpRp(state.book) ? BOOKS[state.book].group : state.book === 'ОП' ? 'ОП.1' : '21.18', price: '',
                      nonrev: false, forLine: i };
    go('nomen');
    $('#item-form [name="name"]')?.focus();
  }

  /** Прийшло те саме майно за іншою ціною: йому заводиться своя позиція — з тією
   *  самою назвою, одиницею, розділом і номером ФЕС, сусіднім вільним кодом і ціною
   *  рядка; у книзі ОП — ще й з тією самою нормою на д/д і рядком норми наказу 390
   *  (той самий виріб, і акт ділить між кодами одну межу), у книзі СП чи РП — з тим самим
   *  дободачем і видом у звіті 1/прод. Після збереження вона стає в цей рядок. */
  function newCodeForLine(i) {
    const ln = draft().lines[i];
    const it = ln ? itemBy.get(ln.code) : null;
    if (!it) return;
    pickClose();
    state.newItem = { code: freeCodeAfter(it.code), name: it.name, unit: it.unit, group: it.group,
                      price: String(ln.price ?? ''), nonrev: !!it.nonrev, fes: it.fes || '',
                      forLine: i, like: it.code };
    if (bookOfItem(it) === 'ОП') Object.assign(state.newItem, { perRation: it.perRation ?? '', normLine: it.normLine || '' });
    else if (isSpRp(bookOfItem(it))) Object.assign(state.newItem, { perRation: it.perRation ?? '', kind1: it.kind1 || '' });
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
    // Ключ відкладеної чернетки — її комірка («in@ОП»), а не вид документа: вид і книга — з самої чернетки.
    const open = Object.values(state.drafts || {}).filter((v) => hasContent(v));
    const cell = (v) => slotOf(v.kind, v.book || 'ТЗ');
    if (state.draft && hasContent(state.draft) && !open.some((v) => cell(v) === cell(state.draft))) open.push(state.draft);
    if (!open.length) return '';
    const what = open.map((v) => `${KIND_NAME[v.kind] || 'Рапорт'}${bookWord(v.book)}${v.head.no ? ' ' + numNo(v.head.no) : ''}`
      + (v.head.date ? ` від ${fmtDate(v.head.date)}` : '')).join('; ');
    return `<div class="flash flash--warn" style="margin-bottom:12px">
      <span>${statusTag('draft')} <b>${cnt(open.length, 'незавершений документ', 'незавершені документи',
        'незавершених документів')}</b> у формі: ${esc(what)}.</span>
      <span><button class="btn btn--sm btn--primary" data-act="doc-new" data-v="${esc(open[0].kind)}" data-book="${esc(open[0].book || 'ТЗ')}">Дописати</button></span>
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
    const no = h.no || (k === 'mv' && !state.editing && (d.book || 'ТЗ') === 'ТЗ' ? suggestMvNo() : '');

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

      ${isDz || (k === 'wr' && (d.book || 'ТЗ') === 'ТЗ' && !(d.src && d.src.kind === 'dz')) ? `<div class="pad" style="padding-top:14px">
        <div class="callout">${isDz
        ? `Знищене майно <b>продовжує числитися</b> в обліковому залишку, доки не проведено
           акт списання. Акт складається на вкладці «Техзасоби» → «Знищене» кнопкою «Списати актом…».`
        : `Знищене майно списують на вкладці <span class="lnk" data-nav="destroyed" data-book="ТЗ">«Техзасоби» → «Знищене»</span>:
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
