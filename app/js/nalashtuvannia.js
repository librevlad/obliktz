// Облік ТЗ ПС · сторінка · налаштування.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

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

  // ---------------------------------------------------------------- акти списання за нормами
  /** Акти списання посуду, серветок і миючих засобів за нормами наказу 390 (книга ОП). Акт складає й править сервер (api/op-act):
   *  кількість — д/д пункту харчування за період × норма позиції на д/д, вниз до кроку групи й не більше залишку місця; сторінка
   *  її не рахує й не править. Документ акта — документ вибуття книги ОП, і відкривається він вікном акта. */
  const ACTS_TABS = [['acts', 'Акти'], ['rations', 'Дободачі'], ['points', 'Пункти харчування']];
  /** Підписанти пакета: [роль, порядок, підпис]. Ролі й порядок — ті самі, що в даних акта й на аркуші «Підписанти» Добовки. */
  const ACT_ROLES = [['командир', 0, 'Командир'], ['голова комісії', 0, 'Голова комісії'],
    ['член комісії', 1, 'Член комісії 1'], ['член комісії', 2, 'Член комісії 2'], ['член комісії', 3, 'Член комісії 3'],
    ['МВО', 0, 'МВО'], ['начальник служби', 0, 'Начальник служби'], ['бухгалтер', 0, 'Начфін'],
    ['начальник їдальні', 0, 'Начальник їдальні'], ['начальник штабу', 0, 'Начальник штабу'],
    ['начальник групи персоналу', 0, 'Начальник групи персоналу'], ['начальник логістики', 0, 'Начальник логістики']];
  /** Папери пакета: [роль, підпис, з номером]. Накладна — лише в акта, що списує зі складу: її пропонує сервер. */
  const ACT_PAPERS = [['накладна', 'Накладна (вимога)', true], ['рапорт', 'Рапорт-донесення', false],
    ['звірка', 'Акт звірки', true], ['розрахунок', 'Розрахунок', false]];
  /** Звідки типові дата й номер паперу: [папір, поле паперу, поле акта]. Поки їх не правили руками, вони йдуть за полем акта. */
  const ACT_PAPER_FROM = [['накладна', 'date', 'from'], ['рапорт', 'date', 'to'], ['звірка', 'date', 'date'],
    ['розрахунок', 'date', 'date'], ['накладна', 'no', 'number'], ['звірка', 'no', 'number']];
  const subKindOf = (name) => ((subBy.get(name) || {}).type || '');
  /** Підрозділ пункту харчування — запис довідника за `subId`: за ним пункт пов'язаний з підрозділом у базі, хоч би той змінив
   *  назву («Виправити назву», правка в картці підрозділу). Запис без `subId` (стан попередньої версії) — за назвою `sub`. */
  function pointSub(p) {
    if (!p) return null;
    const id = String(p.subId || '');
    const rec = id ? (store.subs || []).find((s) => s.id === id) || subs.find((s) => s.id === id) : null;
    return rec || subBy.get(p.sub) || null;
  }
  /** Теперішня назва підрозділу пункту (підрозділу немає — назва, з якою пункт прийшов). */
  function pointPlace(p) {
    return (pointSub(p) || {}).name || (p && p.sub) || '';
  }

  /** Варіанти поля «місце списання» пункту. Значення — ідентифікатор підрозділу (за ним пункт записується), підпис — теперішня
   *  назва; пропонуються чинні підрозділи й теперішнє місце пункту — закрите стоїть з позначкою «закритий», як у «підпорядкований»
   *  (parentOptions). Місця пункту немає серед записів довідника — його назва стоїть вибраною, доки не оберуть місце. */
  function pointPlaceOptions(placeId, place) {
    return (placeId ? '' : `<option value="" selected>${esc(place || '—')}</option>`)
      + subs.filter((s) => s.active || s.id === placeId).map((s) =>
        `<option value="${esc(s.id)}"${s.id === placeId ? ' selected' : ''}>${esc(s.name)}${s.active ? '' : ' · закритий'}</option>`).join('');
  }

  function renderActs() {
    if (state.book === 'СП') return renderSpActs();      // акти сухпаю — свій реєстр
    const tab = ACTS_TABS.some(([k]) => k === state.actsTab) ? state.actsTab : 'acts';
    const seg = `<div class="seg">${ACTS_TABS.map(([k, l]) => `<button type="button" data-act="oa-tab" data-v="${k}"${
      k === tab ? ' class="is-on"' : ''}>${l}</button>`).join('')}</div>`;
    const acts = tab === 'acts' ? `${actionsExcel}<button class="btn btn--primary" data-act="oa-new">+ Акт списання…</button>` : '';
    const body = { acts: actsList, rations: rationsTab, points: pointsTab }[tab]();
    // Реєстр актів і таблиця днів місяця — робочі області: шапка колонок лишається перед очима.
    return { fill: tab !== 'points', head: head('посуд і миючі / акти списання', 'Акти списання', seg + acts), body };
  }

  /** Рядки реєстру: дані акта зі стану, номер і дата — з документа акта, сума — за партіями його рядків, як у картці документа. */
  function actRows() {
    const acts = store.acts || {};
    const lines = new Map();
    for (const r of docs) {
      const id = String(r.id || '');
      if (!id || !acts[id]) continue;
      if (!lines.has(id)) lines.set(id, []);
      lines.get(id).push(r);
    }
    const names = new Map((store.points || []).map((p) => [p.id, p.name]));
    return Object.entries(acts).filter(([, a]) => a.kind !== 'sp').map(([id, a]) => {      // акти сухпаю — у «Сухпаї»
      const rows = lines.get(id) || [];
      const doc = rows[0] || {};
      const sum = rows.reduce((s, r) => s + rowParts(r).reduce((t, p) => t + p.price * p.q, 0), 0);
      return Object.assign({}, a, { id, no: String(doc.no ?? '').trim(), d: doc.d || '', pointName: names.get(a.point) || '—',
        n: new Set(rows.map((r) => r.code)).size, sum: Math.round(sum * 100) / 100,
        fes: ((store.docFes || {})[id] || {}).status || '' });
    }).filter((r) => r.no)
      .sort((x, y) => (x.d < y.d ? 1 : x.d > y.d ? -1 : y.no.localeCompare(x.no, 'uk', { numeric: true })));
  }

  function actsSpec() {
    const rows = actRows();
    const years = [...new Set(rows.map((r) => r.d.slice(0, 4)))].sort().reverse();
    const marks = (r) => [r.offNorm && 'не за нормою', r.daysChanged && 'дні змінилися'].filter(Boolean).join(', ');
    return {
      id: 'oacts', rows, minWidth: '900px', search: (r) => [r.no, r.pointName, r.note || ''], placeholder: 'Номер чи пункт',
      filters: [
        { type: 'seg', key: 'series', options: [['', 'усі'], ['ОП', 'ОП'], ['МЗ', 'МЗ']], test: (r, val) => r.series === val },
        { type: 'select', key: 'year', label: 'рік', all: 'усі', options: years.map((y) => [y, y]), test: (r, val) => r.d.startsWith(val) },
        { type: 'select', key: 'fes', label: 'ФЕС', all: 'усі', options: FES_STATUSES.map((s) => [s, s]).concat([['-', 'без статусу']]),
          test: (r, val) => (val === '-' ? !r.fes : r.fes === val) },
        { type: 'toggle', key: 'off', label: 'не за нормою', title: 'Акти з книги «Облік ОП», складені не за нормою', test: (r) => !!r.offNorm },
        { type: 'toggle', key: 'days', label: 'дні змінилися', title: 'Д/д періоду змінилися після складання акта', test: (r) => !!r.daysChanged },
      ],
      columns: [
        { key: 'no', label: '№', cls: 'c-code', style: 'width:120px', first: 1, sort: (r) => r.no, cell: (r) => `<b>${esc(numNo(r.no))}</b>` },
        { key: 'd', label: 'дата', cls: 'c-date', sort: (r) => r.d, cell: (r) => fmtDate(r.d) },
        { key: 'point', label: 'пункт харчування', cls: 'c-name c-name--stack', first: 1, sort: (r) => r.pointName,
          cellTitle: (r) => r.pointName, cell: (r) => `<b>${esc(r.pointName)}</b>${marks(r) ? `<small>${esc(marks(r))}</small>` : ''}` },
        { key: 'period', label: 'період', cls: 'c-txt', style: 'flex:0 0 196px', sort: (r) => r.from,
          cell: (r) => `${fmtDate(r.from)} — ${fmtDate(r.to)}` },
        { key: 'rations', label: 'д/д', cls: 'c-num', sort: (r) => +r.rations || 0, cell: (r) => fmtNum(r.rations) },
        { key: 'n', label: 'позицій', cls: 'c-num', sort: (r) => r.n, cell: (r) => fmtNum(r.n) },
        { key: 'sum', label: 'сума, грн', cls: 'c-num c-num--xwide', sort: (r) => r.sum, cell: (r) => fmtMoney(r.sum) },
        { key: 'fes', label: 'ФЕС', cls: 'c-txt', style: 'flex:0 0 112px', first: 1, sort: (r) => r.fes, cell: (r) => esc(r.fes || '—') },
      ],
      row: (r) => ({ attrs: `data-act="oa-open" data-id="${esc(r.id)}"` }),
      total: (shown) => ({ point: '<b>Разом</b>', sum: fmtMoney(shown.reduce((s, r) => s + r.sum, 0)) }),
      count: (shown, all) => (shown.length === all.length ? cnt(all.length, 'акт', 'акти', 'актів') : `${shown.length} із ${all.length}`),
      empty: 'Актів за нормами ще немає.',
    };
  }

  function actsList() {
    const reg = registry(actsSpec());
    return `${reg.panel}<div class="card card--scroll card--fill">${reg.table}</div>`;
  }

  // ---------------------------------------------------------------- дободачі й пункти харчування
  const MONTHS_SHORT = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];
  /** Як у базі: більше д/д за день не годує жоден пункт. */
  const RATIONS_MAX = 1000000;
  /** Назва пункту для порівняння: колонка Добовки й пункт програми — той самий пункт без огляду на регістр і зайві пробіли. */
  const pointKey = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  /** Сталі колонки аркуша «Дободачі» книги «Облік ОП» (op_book.RATION_HEAD): далі в шапці — пункти, тож так пункт не зветься. */
  const RATION_HEAD = ['дата', 'витяг', 'джерело'];
  const rationsSum = (pid, days) => days.reduce((s, day) => s + (+(store.rations || {})[`${pid}|${day}`] || 0), 0);
  /** День дободач, який прийме база: дата «рррр-мм-дд» з роком обліку (1950–2100). */
  const rationDayOk = (day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) && !dateYearOdd(day);
  /** День у слові про відмову — дд.мм.рррр, як у всіх словах про дату (не «рррр-мм-дд»); те, що на дату не схоже, — як є. */
  const rationDayName = (day) => (/^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? fmtDate(day) : String(day));
  /** Чому день із Добовки не береться (база його не прийняла б, як і клітинку дня): дата з опискою чи число не д/д. Можна — ''. */
  function rationBad(day, v) {
    if (!rationDayOk(day)) return `День «${rationDayName(day)}» не взято: у даті рік з опискою.`;
    if (!Number.isInteger(v) || v < 0 || v > RATIONS_MAX) return `Дободачі ${fmtDate(day)} не взято: «${v}» не ціле число від 0 до 1 000 000.`;
    return '';
  }

  /** Місяці, у яких є дободачі («рррр-мм»), — найсвіжіші першими; рік поза роками обліку не місяць обліку. */
  function rationMonths() {
    const out = new Set();
    for (const k of Object.keys(store.rations || {})) {
      const m = String(k.split('|')[1] || '').slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(m) && !dateYearOdd(m + '-01')) out.add(m);
    }
    return [...out].sort().reverse();
  }

  /** «Дободачі»: д/д чинних пунктів харчування за днями місяця. Рік і місяць — чипами (місяці з даними — жирним, майбутні —
   *  вимкнені); число правиться в клітинці (джерелом дня стає «вручну»), дні беруться вставкою з Добовки чи її файлом. День без
   *  жодного числа приглушений, внесений руками позначений ✎, джерело дня — у підказці рядка. */
  function rationsTab() {
    const pts = (store.points || []).filter((p) => !p.closed);
    const now = today().slice(0, 7);
    const have = rationMonths();
    // Вкладка відкривається на останньому місяці з даними (не пізніше теперішнього), а без даних — на теперішньому.
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(state.rationsMonth || '') && !dateYearOdd(state.rationsMonth + '-01')
      ? state.rationsMonth : have.find((m) => m <= now) || now;
    const year = month.slice(0, 4);
    const ys = [now, month, ...have].map((m) => +m.slice(0, 4)).concat([+now.slice(0, 4) - 1]);
    const years = [];
    for (let y = Math.max(...ys); y >= Math.min(...ys); y--) years.push(String(y));
    // Дні місяця — з частин дати («рррр-мм-дд»), без годинних поясів: від 1-го до останнього числа.
    const days = Array.from({ length: +monthEnd(month).slice(8, 10) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
    const r = store.rations || {};
    const dates = store.rationDates || {};
    const months = MONTHS_SHORT.map((label, i) => {
      const m = `${year}-${String(i + 1).padStart(2, '0')}`;
      const cls = [m === month && 'is-on', have.includes(m) && 'oa-has'].filter(Boolean).join(' ');
      return `<button type="button" data-act="oa-month" data-v="${m}" title="${esc(monthName(m))}"${cls ? ` class="${cls}"` : ''}${
        m > now && m !== month ? ' disabled' : ''}>${label}</button>`;
    }).join('');
    const filled = days.filter((day) => pts.some((p) => `${p.id}|${day}` in r)).length;
    const panel = `<div class="panel oa">
        <label class="chip is-on"><span class="chip__label">рік</span><select data-oa-year aria-label="рік">${years.map((y) =>
          `<option${y === year ? ' selected' : ''}>${y}</option>`).join('')}</select></label>
        <div class="seg oa-months">${months}</div>
        <button type="button" class="btn" data-act="oa-dob-file">Взяти з файла</button>
        <button type="button" class="btn" data-act="oa-dob-pick">Інший файл…</button>
        <textarea data-oa-paste="rations" rows="1" placeholder="Вставити з Добовки: Ctrl+A, Ctrl+C у Добовці — Ctrl+V тут"
          aria-label="Вставити з Добовки"></textarea>
        ${pts.length ? `<span class="panel__count" data-ration-filled>${cnt(filled, 'день', 'дні', 'днів')} з даними</span>` : ''}</div>`;
    if (!pts.length) return panel + '<div class="pad">Спершу заведіть пункт харчування на вкладці «Пункти харчування».</div>';
    const head = `<div class="tbl__head"><div class="tbl__h c-date">дата</div><div class="tbl__h c-txt">витяг</div>${
      pts.map((p) => `<div class="tbl__h c-num" title="${esc(p.name)}">${esc(p.name)}</div>`).join('')}</div>`;
    const rows = days.map((day) => {
      const dd = dates[day] || {};
      const empty = pts.every((p) => !(`${p.id}|${day}` in r));
      return `<div class="tbl__row tbl__row--plain${empty ? ' is-dim' : ''}${dd.src === 'вручну' ? ' oa-manual' : ''}"${
        dd.src ? ` title="${esc(dd.src)}"` : ''}><div class="c-date">${fmtDate(day)}</div><div class="c-txt">${esc(dd.order || '')}</div>${
        pts.map((p) => `<div class="c-num"><input class="rc-in" data-ration="${esc(p.id)}|${day}" inputmode="numeric" autocomplete="off"
          value="${esc(r[`${p.id}|${day}`] ?? '')}" aria-label="${esc(p.name)} ${fmtDate(day)}"></div>`).join('')}</div>`;
    }).join('');
    const totals = `<div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-date"><b>Разом</b></div><div class="c-txt"></div>${
      pts.map((p) => `<div class="c-num" data-ration-total="${esc(p.id)}">${fmtNum(rationsSum(p.id, days), '0')}</div>`).join('')}</div>`;
    // Ширина: дата 96 px, витяг (номери короткі) — від 60 px, пункт — 86 px; до десяти пунктів таблиця вміщується при 1366.
    return panel + `<div class="card card--scroll card--fill oa-days"><div class="tbl" style="--tbl-min:${172 + pts.length * 86}px">${
      head}${rows}${totals}</div></div>`;
  }

  /** Рік, вибраний на вкладці «Дободачі»: найсвіжіший місяць цього року з даними, інакше теперішній місяць чи січень. */
  function rationYearMonth(y) {
    const now = today().slice(0, 7);
    return rationMonths().find((m) => m.startsWith(y + '-')) || (now.startsWith(y + '-') ? now : `${y}-01`);
  }

  /** Число дободач, уписане в клітинку: ціле від 0, порожнє — дня немає. Джерелом дня стає «вручну»; позначка рядка й підсумок
   *  місяця оновлюються на місці — курсор лишається там, куди його перевели. */
  function rationSet(el) {
    const key = el.dataset.ration;
    const [pid, day] = key.split('|');
    const typed = String(el.value).replace(/\s/g, '');
    store.rations = store.rations || {};
    store.rationDates = store.rationDates || {};
    // День поза роками обліку (1950–2100) база не прийме: його можна лише очистити, і «вручну» він не стає.
    const odd = !rationDayOk(day);
    if (typed === '') delete store.rations[key];
    else if (!odd && /^\d+$/.test(typed) && Number(typed) <= RATIONS_MAX) store.rations[key] = Number(typed);
    else { toast('Дободачі — ціле число, не більше 1 000 000.', true); el.value = store.rations[key] ?? ''; return; }
    el.value = store.rations[key] ?? '';
    if (odd) delete store.rationDates[day];
    else store.rationDates[day] = Object.assign({}, store.rationDates[day] || {}, { src: 'вручну' });
    save();
    const all = [...document.querySelectorAll('#scroll input[data-ration]')];
    const row = el.closest('.tbl__row');
    if (row) {
      row.classList.add('oa-manual');
      row.title = 'вручну';
      row.classList.toggle('is-dim', ![...row.querySelectorAll('input[data-ration]')].some((x) => x.value !== ''));
    }
    const tot = document.querySelector(`#scroll [data-ration-total="${CSS.escape(pid)}"]`);
    if (tot) tot.textContent = fmtNum(all.filter((x) => x.dataset.ration.startsWith(pid + '|')).reduce((s, x) => s + (+x.value || 0), 0), '0');
    const filled = document.querySelector('#scroll [data-ration-filled]');
    if (filled) {
      const n = [...document.querySelectorAll('#scroll .oa-days .tbl__row')].filter((x) => [...x.querySelectorAll('input[data-ration]')]
        .some((i) => i.value !== '')).length;
      filled.textContent = `${cnt(n, 'день', 'дні', 'днів')} з даними`;
    }
  }

  /** Чому назву пункту харчування не можна взяти: порожня, така вже є (без різниці регістру й зайвих пробілів) чи це назва сталої
   *  колонки аркуша «Дободачі» — база й книга таких не приймають. Можна — ''. `id` — сам пункт (його теперішня назва не повтор). */
  function pointNameBad(name, id = null) {
    if (!name) return 'Пункт харчування без назви: впишіть назву.';
    const twin = (store.points || []).find((x) => x.id !== id && pointKey(x.name) === pointKey(name));
    if (twin) return `Пункт харчування «${twin.name}» уже є: назви пунктів не повторюються.`;
    if (RATION_HEAD.includes(pointKey(name))) return `Пункт харчування не може зватися «${name}»: так зветься колонка аркуша «Дободачі».`;
    return '';
  }

  /** Поле пункту харчування: назва (pointNameBad), місце списання (підрозділ за ідентифікатором), їдальня, назва у звірці,
   *  «закрито». */
  function pointSet(el) {
    const [id, f] = el.dataset.point.split('|');
    const p = (store.points || []).find((x) => x.id === id);
    if (!p) return;
    if (f === 'name') {
      const name = String(el.value).replace(/\s+/g, ' ').trim();
      const bad = pointNameBad(name, id);
      if (bad) {
        toast(bad, true);
        el.value = p.name;
        return;
      }
      p.name = name;
    } else if (f === 'closed') p.closed = el.checked ? today() : '';
    else if (f === 'sub') {
      // Місце — підрозділ за його ідентифікатором: значення поля — `subId`, назва — лише підпис.
      const s = subs.find((x) => x.id === el.value);
      if (!s) { el.value = (pointSub(p) || {}).id || ''; return; }
      p.subId = s.id;
      p.sub = s.name;
    } else p[f] = String(el.value).trim();
    save();
    // Перемальовуємо, коли фокус уже перейшов далі (Tab), і повертаємо його в те саме поле нової таблиці.
    setTimeout(() => {
      const a = document.activeElement;
      const next = a && a.dataset ? a.dataset.point : '';
      render();
      if (next) document.querySelector(`#scroll [data-point="${CSS.escape(next)}"]`)?.focus();
    }, 0);
  }

  /** Поля вкладок «Дободачі» й «Пункти харчування» живуть до наступного перемальовування — прив'язуються щоразу. */
  function bindActs() {
    const sc = $('#scroll');
    if (!sc || state.view !== 'acts') return;
    sc.querySelectorAll('input[data-ration]').forEach((el) => {
      el.addEventListener('change', () => rationSet(el));
      // Enter — той самий пункт наступного дня: дні з паперу вносять стовпцем.
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const pid = el.dataset.ration.split('|')[0];
        const col = [...sc.querySelectorAll('input[data-ration]')].filter((x) => x.dataset.ration.split('|')[0] === pid);
        const next = col[col.indexOf(el) + 1];
        if (next) { next.focus(); next.select(); } else el.blur();
      });
    });
    sc.querySelector('[data-oa-paste="rations"]')?.addEventListener('paste', (e) => {
      e.preventDefault();
      dobPaste((e.clipboardData || window.clipboardData).getData('text'), 'rations');
    });
    sc.querySelector('[data-oa-year]')?.addEventListener('change', (e) => { state.rationsMonth = rationYearMonth(e.target.value); render(); });
    sc.querySelectorAll('[data-point]').forEach((el) => el.addEventListener('change', () => pointSet(el)));
  }

  /** «Пункти харчування»: колонка Добовки → місце, з якого списується майно акта, назва їдальні в накладній і пункту у звірці.
   *  Пункт, за яким є акти, не видаляють — його закривають. */
  function pointsTab() {
    const used = new Set(Object.values(store.acts || {}).map((a) => a.point));
    const rows = (store.points || []).map((p) => Object.assign({}, p, { used: used.has(p.id), place: pointPlace(p),
      placeId: (pointSub(p) || {}).id || '' }));
    const subOpts = (r) => pointPlaceOptions(r.placeId, r.place);
    const reg = registry({
      id: 'opoints', rows, minWidth: '900px', search: (r) => [r.name, r.place, r.hall || '', r.title || ''], placeholder: 'Пункт чи місце',
      filters: [{ type: 'toggle', key: 'closed', label: 'закриті', test: (r) => !!r.closed }],
      columns: [
        { key: 'name', label: 'пункт (як у Добовці)', cls: 'c-name', sort: (r) => r.name,
          cell: (r) => `<input class="rc-in rc-in--wide" data-point="${esc(r.id)}|name" value="${esc(r.name)}" aria-label="назва пункту" autocomplete="off">` },
        { key: 'sub', label: 'місце списання', cls: 'c-txt', sort: (r) => r.place,
          cell: (r) => `<select data-point="${esc(r.id)}|sub" aria-label="місце списання">${subOpts(r)}</select>` },
        { key: 'hall', label: 'їдальня в накладній', cls: 'c-txt', sort: (r) => r.hall || '',
          cell: (r) => `<input class="rc-in rc-in--wide" data-point="${esc(r.id)}|hall" value="${esc(r.hall || '')}" aria-label="їдальня" autocomplete="off">` },
        { key: 'title', label: 'у звірці', cls: 'c-txt', sort: (r) => r.title || '',
          cell: (r) => `<input class="rc-in rc-in--wide" data-point="${esc(r.id)}|title" value="${esc(r.title || '')}" aria-label="назва у звірці" autocomplete="off">` },
        { key: 'closed', label: 'закрито', cls: 'c-status', sort: (r) => r.closed || '',
          cell: (r) => `<input type="checkbox" data-point="${esc(r.id)}|closed"${r.closed ? ' checked' : ''} aria-label="закрито"
            title="${r.closed ? `закрито ${esc(fmtDate(r.closed))}` : 'чинний'}">` },
        { key: 'del', label: '', cls: 'c-status', cell: (r) => (r.used ? ''
          : `<button type="button" class="btn btn--sm" data-act="oa-point-del" data-id="${esc(r.id)}">Видалити</button>`) },
      ],
      row: () => ({ cls: 'tbl__row--plain' }),  // рядок правиться в полях, а не відкривається
      count: (shown, all) => (shown.length === all.length ? cnt(all.length, 'пункт', 'пункти', 'пунктів') : `${shown.length} із ${all.length}`),
      empty: 'Пунктів харчування ще немає.',
    });
    regRedraw.set('opoints', render);
    return `<div class="panel"><button type="button" class="btn btn--primary" data-act="oa-point-new">+ Пункт харчування</button></div>`
      + reg.panel + `<div class="card card--scroll">${reg.table}</div>`;
  }

  /** Середні д/д для заявки на 30 днів: сума пунктів, що списують зі складу, за останні `days` днів із даними. */
  function rationsAverage(days = 30) {
    const pts = new Set((store.points || []).filter((p) => !p.closed && (pointSub(p) || {}).type === 'склад').map((p) => p.id));
    const byDay = {};
    for (const [k, n] of Object.entries(store.rations || {})) {
      const [id, day] = k.split('|');
      if (pts.has(id)) byDay[day] = (byDay[day] || 0) + (+n || 0);
    }
    const last = Object.keys(byDay).sort().slice(-days);
    return last.length ? Math.round(last.reduce((s, d) => s + byDay[d], 0) / last.length) : 0;
  }

  /** Групи позицій серії акта: ОП — одноразовий посуд, МЗ — серветки й миючі. */
  const ACT_SERIES_GROUPS = { 'ОП': ['ОП.1'], 'МЗ': ['ОП.2', 'ОП.3'] };
  /** Серії, акт яких за місяць [ps, pe] не складено: пункт мав д/д, на його місці на кінець місяця є позиції серії з нормою (акт
   *  мав би рядки), а день із д/д не покриває жоден акт серії цього пункту. */
  function actsDue(ps, pe) {
    const fed = [];
    for (const [k, n] of Object.entries(store.rations || {})) {
      const [pid, day] = k.split('|');
      if (+n > 0 && day >= ps && day <= pe) fed.push([pid, day]);
    }
    if (!fed.length) return [];
    const subOf = new Map((store.points || []).map((p) => [p.id, pointPlace(p)]));
    const acts = Object.values(store.acts || {});
    return Object.entries(ACT_SERIES_GROUPS).filter(([series, groups]) => {
      const codes = new Set(items.filter((i) => groups.includes(i.group) && +i.perRation > 0).map((i) => String(i.code)));
      if (!codes.size) return false;
      const stock = new Map();
      for (const e of ledger) {
        if (e.d > pe) break;
        if (codes.has(String(e.code))) stock.set(e.sub, (stock.get(e.sub) || 0) + e.sg * e.q);
      }
      return fed.some(([pid, day]) => (stock.get(subOf.get(pid)) || 0) > 1e-9
        && !acts.some((a) => a.series === series && a.point === pid && a.from <= day && day <= a.to));
    }).map(([series]) => series);
  }

  // ---------------------------------------------------------------- Добовка: вставка й файл
  /** Прочитане з Добовки до «Прийняти»: {j — відповідь сервера, w — вікно акта, з якого читали, чи null (вкладка «Дободачі»)}. */
  let dobLast = null;

  /** Вставка з Добовки: на вкладці «Дободачі» чи у вікні акта (`where` = 'act'). У вікні акта сервер ще знає перший день
   *  періоду (стовпець чисел без дат), дату акта й пункт (підписанти на дату). Програма Добовку лише читає. */
  async function dobPaste(text, where) {
    const w = where === 'act' && actShown(actWin) ? actWin : null;
    const point = w ? ((store.points || []).find((p) => p.id === w.point) || {}).name || '' : '';
    let r = null, j = {};
    try {
      await flush();
      r = await fetch('api/dobovka/paste', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, start: w ? w.from || '' : '', end: w ? w.to || '' : '', date: w ? w.date || '' : '', point }) });
      j = await r.json().catch(() => ({}));
    } catch (e) { r = null; }
    if (!r || !r.ok) { actSay(w, j.error || 'Вставку не прочитано.', true); return; }
    dobPreview(j, w);
  }

  /** Файл Добовки: без `file` — найсвіжіша «Добовка*.xlsx» теки з «Налаштування» → «Теки»; `file` — вибраний «Інший файл…».
   *  Вікно акта на екрані — читаємо для нього (підписанти на дату акта). */
  async function actDobFile(file) {
    const w = actShown(actWin) ? actWin : null;
    const point = w ? ((store.points || []).find((p) => p.id === w.point) || {}).name || '' : '';
    const q = w ? `?date=${encodeURIComponent(w.date || '')}&point=${encodeURIComponent(point)}` : '';
    let r = null, j = {};
    try {
      await flush();
      r = await fetch('api/dobovka/read' + q, { method: 'POST', body: file || '' });
      j = await r.json().catch(() => ({}));
    } catch (e) { r = null; }
    if (!r || !r.ok) { actSay(w, j.error || 'Добовку не прочитано.', true); return; }
    if (file && file.name && !j.file) {
      // Вибраний файл: назва й час збереження — його власні, як у файла з теки (місцевий час).
      j.file = file.name;
      const d = new Date(file.lastModified || 0);
      if (file.lastModified) j.saved = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16).replace('T', ' ');
    }
    dobPreview(j, w);
  }

  /** Що зміниться: дні наявних пунктів (і дні шматка без назви — пункту вікна акта), яких це стосується, «дата — було —
   *  стало» для днів, що вже були з іншим числом, і колонки, пунктів яких ще немає ([назва, днів]). Чого база не прийняла б
   *  (день із опискою в році, число не д/д, назва колонки, якою пункт не зветься), не береться: `bad` — слова про це. */
  function dobChanges(j, w) {
    const byName = new Map((store.points || []).map((p) => [pointKey(p.name), p]));
    const r = store.rations || {};
    const out = [], unknown = [], bad = [];
    let n = 0, vals = 0;
    const diff = (p, day, now) => { const k = `${p.id}|${day}`; if (k in r && +r[k] !== +now) out.push([day, p.name, r[k], now]); };
    const take = (day, v) => { const why = rationBad(day, v); if (why) bad.push(why); return !why; };
    for (const [name, days] of Object.entries(j.points || {})) {
      const p = byName.get(pointKey(name));
      if (!p) {
        const why = pointNameBad(String(name).replace(/\s+/g, ' ').trim());
        if (why) bad.push(why);
        else unknown.push([name, Object.entries(days).filter(([day, v]) => take(day, v)).length]);
        continue;
      }
      for (const [day, now] of Object.entries(days)) if (take(day, now)) { n++; diff(p, day, now); }
    }
    const wp = w ? (store.points || []).find((p) => p.id === w.point) : null;
    if (wp) for (const [day, now] of Object.entries(j.values || {})) if (take(day, now)) { vals++; diff(wp, day, now); }
    for (const day of Object.keys(j.orders || {})) if (!rationDayOk(day)) bad.push(`День «${rationDayName(day)}» не взято: у даті рік з опискою.`);
    out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { n, vals, out, unknown, bad: [...new Set(bad)] };
  }

  /** Перед «Прийняти»: що впізнано й що зміниться. Нічого, що можна взяти тут, — лише слово (у вікні акта — у його рядку). */
  function dobPreview(j, w = null) {
    const pts = Object.keys(j.points || {}).length;
    const ords = Object.keys(j.orders || {}).length;
    const vals = w ? Object.keys(j.values || {}).length : 0;
    const sigs = w ? (j.signersAt || []).length : 0;
    if (!pts && !ords && !vals && !sigs) {
      const piece = j.kind === 'pairs' || j.kind === 'column' || /^стовпець чисел/i.test((j.problems || [])[0] || '');
      actSay(w, !w && piece ? 'Дні одного пункту вставляйте у вікні акта.'
        : j.kind === 'sukhpai' ? 'Це аркуш «Сухпай»: його вставляють у вікні акта сухпаю («Сухпай» → «Акти списання»).'
        : (j.problems || [])[0] || (j.kind === 'signers' ? (w ? 'Рядка підписантів на дату акта немає.' : 'Підписантів бере вікно акта.')
          : 'Нічого не впізнано.'), true);
      return;
    }
    dobLast = { j, w };
    const c = dobChanges(j, w);
    const okOrds = Object.keys(j.orders || {}).filter(rationDayOk).length;
    const said = [c.n && `днів пунктів: ${c.n}`, c.vals && `днів пункту акта: ${c.vals}`, okOrds && `номерів витягів: ${okOrds}`,
      sigs && `підписантів на ${fmtDate(j.signersDate)}: ${sigs}`].filter(Boolean).join(' · ')
      || (c.unknown.length ? 'Пунктів харчування з цими назвами ще немає.' : 'Нічого не впізнано.');
    const problems = (j.problems || []).concat(c.bad);
    const subOpts = subs.filter((s) => s.active).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    const rows = c.out.slice(0, 30).map(([d, p, a, b]) => `<div class="tbl__row tbl__row--plain"><div class="c-date">${fmtDate(d)}</div>
        <div class="c-name"><b>${esc(p)}</b></div><div class="c-num">${fmtNum(a, '0')}</div><div class="c-num">${fmtNum(b, '0')}</div></div>`).join('');
    modalOpen(j.file ? `Добовка: ${j.file}` : 'Вставка з Добовки', `<div class="pad oa-dob">
      <p>${esc(said)}${j.saved ? ` <small>файл збережено ${esc(fmtStamp(j.saved))}</small>` : ''}</p>
      ${c.out.length ? `<div class="card card--scroll"><div class="tbl" style="--tbl-min:0"><div class="tbl__head">
        <div class="tbl__h c-date">дата</div><div class="tbl__h c-name">пункт</div><div class="tbl__h c-num">було</div>
        <div class="tbl__h c-num">стало</div></div>${rows}</div></div>${c.out.length > 30
          ? `<p class="set-note">і ще ${cnt(c.out.length - 30, 'день', 'дні', 'днів')}</p>` : ''}` : ''}
      ${c.unknown.map(([name, n]) => `<div class="field"><label>Новий пункт «${esc(name)}», ${cnt(n, 'день', 'дні', 'днів')}: місце списання</label>
        <select data-dob-map="${esc(name)}"><option value="">не брати</option>${subOpts}</select></div>`).join('')}
      ${problems.length ? `<p class="set-note">${problems.map(esc).join('<br>')}</p>` : ''}
      <div class="set-form__acts"><button type="button" class="btn" data-act="oa-dob-cancel">Скасувати</button>
        <button type="button" class="btn btn--primary" data-act="oa-dob-apply">Прийняти</button></div></div>`, 'modal__box--form');
  }

  /** Прочитане з Добовки — у дободачі. Дні пунктів — за назвою колонки; колонка без пункту стає новим пунктом із місцем з `map`
   *  (назва колонки → ідентифікатор підрозділу; порожнє — не брати), якщо такою назвою пункт зватися може (pointNameBad). Дні
   *  шматка без назви — пункту вікна акта `w`. Номери витягів — у дні. Джерелом взятого дня стає файл (чи «вставка з
   *  Добовки»): Добовка головніша за внесене руками. Дня чи числа, яких база не прийняла б (rationBad), не бере — їх назвало
   *  вікно перед «Прийняти». Повертає, що взято. */
  function rationsApply(j, map = {}, w = null) {
    store.points = store.points || [];
    store.rations = store.rations || {};
    store.rationDates = store.rationDates || {};
    const made = [];
    for (const [name, subId] of Object.entries(map)) {
      const s = subId ? subs.find((x) => x.id === subId) : null;
      const clean = String(name).replace(/\s+/g, ' ').trim();
      if (!s || pointNameBad(clean)) continue;
      store.points.push({ id: uid(), name: clean, sub: s.name, subId: s.id, hall: '', title: '', closed: '' });
      made.push(name);
    }
    const ids = new Map(store.points.map((p) => [pointKey(p.name), p.id]));
    const touched = new Set();
    const put = (id, day, v) => { if (rationBad(day, v)) return; store.rations[`${id}|${day}`] = v; touched.add(day); };
    for (const [name, days] of Object.entries(j.points || {})) {
      const id = ids.get(pointKey(name));
      if (!id) continue;
      for (const [day, v] of Object.entries(days)) put(id, day, v);
    }
    if (w && w.point) for (const [day, v] of Object.entries(j.values || {})) put(w.point, day, v);
    const src = j.file || 'вставка з Добовки';
    for (const day of touched) store.rationDates[day] = Object.assign({}, store.rationDates[day] || {}, { src });
    const orders = Object.entries(j.orders || {}).filter(([day]) => rationDayOk(day));
    for (const [day, no] of orders) store.rationDates[day] = Object.assign({}, store.rationDates[day] || {}, { order: no });
    const days = [...touched].sort();
    if (days.length) state.rationsMonth = days[days.length - 1].slice(0, 7);
    return { days: touched.size, orders: orders.length, points: made };
  }

  /** «Прийняти»: дні й номери — у дободачі; у вікні акта ще й підписанти на дату акта, і вікно малюється наново. */
  function dobApply() {
    if (!dobLast) return null;
    const { j, w } = dobLast;
    dobLast = null;
    const map = {};
    document.querySelectorAll('#modal [data-dob-map]').forEach((el) => { map[el.dataset.dobMap] = el.value; });
    const live = w && actWin === w ? w : null;          // вікно акта, з якого читали, ще не закрили
    const got = rationsApply(j, map, live);
    save();
    const sigs = live ? j.signersAt || [] : [];
    const said = [got.days && `днів: ${got.days}`, got.orders && `номерів витягів: ${got.orders}`,
      got.points.length && `нових пунктів: ${got.points.length}`, sigs.length && `підписантів: ${sigs.length}`].filter(Boolean);
    const text = said.length ? `Узято ${said.join(', ')}.` : 'Нічого не взято.';
    if (live) {
      for (const s of sigs) {
        const i = live.signers.findIndex((x) => x.role === s.role && +x.sort === +s.sort);
        if (i >= 0) live.signers[i] = Object.assign({}, s); else live.signers.push(Object.assign({}, s));
      }
      live.msg = { text, bad: false };
      // Вікно вставки лишається на екрані, доки вікно акта не намалюється наново: його кнопки вже взяте не повторять.
      document.querySelectorAll('#modal .oa-dob button').forEach((b) => { b.disabled = true; });
      return actPreview();                       // перемальовує вікно акта цілком
    }
    modalClose();
    render();
    toast(text);
    return null;
  }

  function actsAction(name, d) {
    switch (name) {
      case 'oa-tab': state.actsTab = d.v; return render();
      case 'oa-new': return actNew();
      case 'oa-open': return actOpen(d.id);
      case 'oa-close': actWin = null; return modalClose();
      case 'oa-save': return actSave();
      case 'oa-files': return actFiles();
      case 'oa-force': return actForce();
      case 'oa-keep': return actKeep();
      case 'oa-reveal': return actReveal(d.id || (actWin && actWin.docId));
      case 'oa-del': return actDelete();
      case 'oa-card': return actCard();
      case 'oa-dob-file': return actDobFile();
      case 'oa-dob-pick': return pickFile('.xlsx', (f) => actDobFile(f));
      case 'oa-dob-apply': return dobApply();
      case 'oa-dob-cancel': {
        const w = dobLast && dobLast.w;
        dobLast = null;
        return w && actWin === w ? actDraw() : modalClose();
      }
      case 'oa-month': state.rationsMonth = d.v; return render();
      case 'oa-point-new': {
        const place = subs.find((s) => s.active && s.type === 'склад') || subs.find((s) => s.active);
        if (!place) { toast('Спершу заведіть підрозділ.', true); return null; }
        const taken = new Set((store.points || []).map((p) => pointKey(p.name)));
        let n = (store.points || []).length + 1;
        while (taken.has(pointKey(`Пункт ${n}`))) n++;
        const p = { id: uid(), name: `Пункт ${n}`, sub: place.name, subId: place.id, hall: '', title: '', closed: '' };
        store.points = (store.points || []).concat([p]);
        save();
        regReset('opoints');                     // новий пункт не ховається за пошуком чи «закриті»
        render();
        const inp = document.querySelector(`#scroll [data-point="${CSS.escape(p.id)}|name"]`);
        if (inp) { inp.focus(); inp.select(); }
        return null;
      }
      case 'oa-point-del': {
        const p = (store.points || []).find((x) => x.id === d.id);
        if (!p || !confirm(`Видалити пункт харчування «${p.name}»? Його дободачі зникнуть.`)) return null;
        store.points = store.points.filter((x) => x.id !== d.id);
        for (const k of Object.keys(store.rations || {})) if (k.startsWith(d.id + '|')) delete store.rations[k];
        save(true, true);
        return render();
      }
      case 'oa-nonorm': actWin = null; modalClose(); return go('nomen', { book: 'ОП', q: d.code });
      default: return null;
    }
  }

  /** Вікно акта: {docId (0 — новий), series, point, from, to, date, number, signers, papers, note; was — яким складений акт був,
   *  коли вікно його відкрило; prop — пропозиція сервера; seq — номер останнього запиту пропозиції; msg — слово внизу вікна}. */
  let actWin = null;

  const actKey = (id) => { const r = id ? docs.find((x) => String(x.id) === String(id)) : null; return r ? keyOfRow(r) : ''; };
  const actOfKey = (key) => {
    const acts = store.acts || {};
    const r = key && Object.keys(acts).length ? docs.find((x) => keyOfRow(x) === key) : null;
    return r && r.id && acts[String(r.id)] ? String(r.id) : '';
  };

  /** Стан вікна складеного акта — з даних акта й шапки його документа. `was` сервер звіряє з базою: акт, який тим часом змінили
   *  чи видалили в іншому вікні, не переписується й не видаляється. */
  function actState(id) {
    const a = (store.acts || {})[String(id)];
    const doc = docs.find((r) => String(r.id) === String(id));
    if (!a || !doc) return null;
    const no = String(doc.no ?? '').trim();
    return { docId: Number(id), series: a.series, point: a.point, from: a.from, to: a.to, date: doc.d, number: no,
      signers: (a.signers || []).map((s) => Object.assign({}, s)), papers: JSON.parse(JSON.stringify(a.papers || {})),
      note: a.note || '', was: { number: no, date: doc.d, from: a.from, to: a.to, sig: a.sig || '' }, first: { number: no, date: doc.d } };
  }

  async function actNew() {
    const pts = (store.points || []).filter((p) => !p.closed);
    if (!pts.length) {
      go('acts', { book: 'ОП', actsTab: 'points' });
      toast('Спершу заведіть пункт харчування.', true);
      return;
    }
    actWin = { docId: 0, series: 'ОП', point: pts[0].id, from: '', to: '', date: today(), number: '', signers: [], papers: {}, note: '' };
    await actPreview(true);
  }

  async function actOpen(id, msg = null) {
    if (isSpAct(id)) return spActOpen(id, msg);         // документ акта сухпаю — вікном акта сухпаю
    const w = actState(id);
    if (!w) { toast('Такого акта немає.', true); return; }
    w.msg = msg;
    actWin = w;
    await actPreview();
  }

  /** Вікно акта зараз на екрані (а не закрите й не під іншим вікном). */
  const actShown = (w) => !!w && actWin === w && !!$('#modal [data-oa-win]');

  /** Перед запитом акта внесене на сторінці має лежати в базі: сервер рахує акт з бази (дободачі, пункти, позиції). */
  async function actSettle() {
    for (let i = 0; i < 4; i++) {
      if (saving.busy) { await saving.busy; continue; }
      if (!saving.dirty) return true;
      if (await flush() !== true) return false;
    }
    return !saving.dirty && !saving.busy;
  }

  /** Запит до сервера акта: { ok, status, j }; j — завжди об'єкт, слово відмови — у j.error. */
  async function actCall(path, payload) {
    try {
      return await purPost(path, payload);
    } catch (e) {
      return { ok: false, status: 0, j: { error: 'Програма не відповідає.' } };
    }
  }

  const ACT_NO_PERIOD = 'Вкажіть період акта.';
  /** Дати вікна акта: [поле, підпис]. */
  const ACT_DATES = [['from', 'Період з'], ['to', 'по'], ['date', 'Дата акта']];
  /** Дата вікна з роком поза роками обліку (1950–2100) — рік ще набирають чи в ньому зайва цифра: такої дати ще немає, і сервера
   *  з нею не питають (він рахував би дні від нульового року). Слово — як скрізь у програмі для такої дати. Усе гаразд — ''. */
  function actDateOdd(w) {
    for (const [k, label] of ACT_DATES) {
      const y = w[k] ? dateYearOdd(w[k]) : 0;
      if (y) return `У даті «${label}» рік ${y}: уведіть рік повністю, чотирма цифрами.`;
    }
    return '';
  }
  /** Дата акта чи його паперу (`what` — «акта», «паперу «…»») за правилами форми документа: рік з опискою, у майбутньому,
   *  раніше за початок обліку `first`. Гаразд — ''. Спільне для вікон актів ОП/МЗ і сухпаю (akty-sp.js). */
  function actDateRule(d, what, first) {
    const y = dateYearOdd(d);
    if (y) return `У даті ${what} рік ${y}: уведіть рік повністю, чотирма цифрами.`;
    if (d > today()) return `Дата ${what} в майбутньому.`;
    if (first && d < first) return `Дата ${what} раніша за початок обліку (${fmtDate(first)}). Початок обліку — у реквізитах частини.`;
    return '';
  }
  /** Перед «Скласти акт» / «Зберегти»: дати акта й паперів — за правилами форми документа (рік з опискою, у майбутньому, раніше
   *  за початок обліку). Відмова — словом, без запиту; усе гаразд — ''. */
  function actDatesBad(w) {
    const odd = actDateOdd(w);
    if (odd) return odd;
    const first = firstDay();
    const rule = (d, what) => actDateRule(d, what, first);
    if (!w.date) return 'Вкажіть дату акта.';
    const own = rule(w.date, 'акта');
    if (own) return own;
    for (const [role, label] of actPapersOf(w)) {
      const d = ((w.papers || {})[role] || {}).date;
      const bad = d ? rule(d, `паперу «${label}»`) : '';
      if (bad) return bad;
    }
    return '';
  }

  /** Пропозиція акта від сервера: д/д періоду, рядки за нормою, попередження.
   *  `fresh` — нове вікно чи інша серія або пункт нового акта: сервер ще й підставляє період від попереднього акта, номер,
   *  підписантів і папери. Лише її відповідь лягає в поля вікна, і вікно малюється наново цілком. Поки вона йде, вікно вимкнене
   *  (actFreeze), а перерахунок не починається: її ніщо не перебиває.
   *  Інакше — перерахунок за полями вікна: він міняє лише рядки й попередження (типове, що приклав би сервер, у вікно не йде).
   *  Без «з» чи «по» сервера не питають — він підставив би типовий період; у вікні — прохання вказати період.
   *  `quiet` — перерахунок після правки поля: коли відповідь приходить, а вікна акта на екрані немає (над ним інше вікно),
   *  нічого не малюється. Відповідь, що спізнилася (поля вже змінили ще раз), відкидається. */
  async function actPreview(fresh = false, quiet = false) {
    const w = actWin;
    if (!w || w.fresh) return;
    w.seq = (w.seq || 0) + 1;
    const seq = w.seq;
    const ask = fresh ? '' : !w.from || !w.to ? ACT_NO_PERIOD : actDateOdd(w);
    if (ask) {
      w.prop = { error: true, lines: [], warnings: [ask] };
      if (quiet && !actShown(w)) return;
      if (actShown(w)) actCalcDraw(w); else actDraw();
      return;
    }
    if (fresh) { w.fresh = true; actFreeze(w, true); }
    try {
      await actSettle();
      // Дата акта з опискою в році — ще не дата: свіжа пропозиція бере сьогоднішню.
      const body = fresh ? { series: w.series, point: w.point, date: dateYearOdd(w.date) ? '' : w.date }
        : { series: w.series, point: w.point, from: w.from, to: w.to, date: w.date, number: w.number, docId: w.docId || null };
      const { ok, j } = await actCall('api/op-act/preview', body);
      if (actWin !== w || seq !== w.seq) return;
      w.fresh = false;
      if (!ok && fresh && !actShown(w)) { actWin = null; toast(j.error || 'Пропозицію акта не складено.', true); return; }
      if (ok && fresh && j.defaults) Object.assign(w, j.defaults, { signers: j.signers || [], papers: j.papers || {} });
      w.prop = ok ? j : { error: true, lines: [], warnings: [j.error || 'Пропозицію акта не складено.'] };
      if (quiet && !actShown(w)) return;
      if (fresh || !actShown(w)) actDraw(); else actCalcDraw(w);
    } finally {
      // Лише свіжа пропозиція знімає свою «заморозку»: перерахунок, що спізнився, не знімає заморозки свіжої, що йде після нього.
      if (fresh) w.fresh = false;
    }
  }

  /** Свіжа пропозиція йде: поля, підписанти, папери й кнопки вікна вимкнені — нічого не правиться й не перераховується, доки
   *  вікно не намалюється наново з тим, що дав сервер. ✕ угорі вікна лишається. */
  function actFreeze(w, on) {
    if (!actShown(w)) return;
    if (on) w.keep = actFocusKey();             // вимкнене поле втрачає фокус: після перемальовування курсор повернеться в нього
    document.querySelectorAll('#modal [data-oa-win] input, #modal [data-oa-win] select, #modal [data-oa-win] textarea, '
      + '#modal [data-oa-win] button').forEach((el) => { el.disabled = on; });
  }
  /** Поле вікна акта у фокусі: [ключ data-атрибута, його значення] чи null. */
  function actFocusKey() {
    const a = document.activeElement;
    if (!a || !a.dataset || !a.closest || !a.closest('#modal [data-oa-win]')) return null;
    const attr = ['oa', 'oaSig', 'oaPaper', 'oaFes'].find((k) => k in a.dataset);
    return attr ? [attr, a.dataset[attr]] : null;
  }

  function actField(k, label, value, type = 'text') {
    return `<div class="field"><label>${label}</label><input data-oa="${k}" type="${type}" value="${esc(value || '')}" autocomplete="off"></div>`;
  }

  /** Що зміниться в документі складеного акта, якщо його зберегти: перерахунок за теперішніми днями й залишками. */
  function actChanges(w, lines) {
    if (!w.docId || !w.prop || w.prop.error) return [];
    const was = new Map();
    for (const r of docs) if (String(r.id) === String(w.docId)) was.set(String(r.code), round3((was.get(String(r.code)) || 0) + (+r.q || 0)));
    if (!was.size) return [];                   // документа ще немає на сторінці (акт щойно записано): порівнювати нема з чим
    const now = new Map(lines.map((l) => [String(l.code), +l.qty || 0]));
    const out = [];
    for (const code of new Set([...was.keys(), ...now.keys()])) {
      const a = was.get(code) || 0, b = now.get(code) || 0;
      if (Math.abs(a - b) > 1e-9) out.push(`${code}: ${fmtNum(a, '0')} → ${fmtNum(b, '0')}`);
    }
    return out.length ? [`Збереження перерахує акт: ${out.join('; ')}`] : [];
  }

  /** «Належить» по рядках — як у паперовому «Розрахунку» (op_act_export._shares): межа пулу (рядок норми наказу 390, `pool`)
   *  ділиться між його кодами за порядком рядків — кожному списане, останньому решта межі. Межа цілого пулу в кожному рядку
   *  читалася б так, ніби належить стільки разів, скільки кодів. */
  function actShares(lines) {
    const out = lines.map(() => 0);
    const pools = new Map();
    lines.forEach((l, i) => {
      const k = l.pool != null ? `p${l.pool}` : `${l.group}|${l.norm}`;
      if (!pools.has(k)) pools.set(k, []);
      pools.get(k).push(i);
    });
    for (const idx of pools.values()) {
      const limit = +lines[idx[0]].limit || 0;
      let used = 0;
      idx.forEach((i, n) => {
        const q = +lines[i].qty || 0;
        out[i] = n < idx.length - 1 ? q : Math.max(q, round3(limit - used));
        used = round3(used + q);
      });
    }
    return out;
  }

  /** Д/д, попередження й рядки акта — частина вікна, яку оновлює кожна пропозиція. Рядки лише для читання: кількість — за нормою. */
  function actCalcHtml(w) {
    const p = w.prop || {};
    const lines = p.lines || [];
    const days = (p.days || []).length, missing = (p.missing || []).length;
    const total = lines.reduce((s, l) => s + (+l.sum || 0), 0);
    const warns = (p.warnings || []).concat(actChanges(w, lines));
    const share = actShares(lines);
    const rows = lines.map((l, i) => `<div class="tbl__row tbl__row--plain">
        <div class="c-code">${esc(l.code)}</div><div class="c-name" title="${esc(l.name)}"><b>${esc(l.name)}</b></div>
        <div class="c-num c-num--xwide">${esc(fmtNorm(l.norm))} ${esc(l.uom || '')}</div><div class="c-num c-num--wide">${fmtNum(share[i], '0')}</div>
        <div class="c-num c-num--wide">${fmtNum(l.stock, '0')}</div><div class="c-num c-num--wide"><b>${fmtNum(l.qty, '0')}</b></div>
        <div class="c-num c-num--xwide">${fmtMoney(l.sum)}</div></div>`).join('');
    const said = p.error ? '' : `<b>${fmtNum(p.rations, '0')} д/д</b><span>${days ? `за ${cnt(days, 'день', 'дні', 'днів')}` : 'днів із дободачами немає'}${
      missing ? `, без даних ${cnt(missing, 'день', 'дні', 'днів')}` : ''}${p.sub ? ` · місце «${esc(p.sub)}»` : ''}</span>`;
    return `<div class="oa-rations">${said}
        <button type="button" class="btn btn--sm" data-act="oa-dob-file">Взяти з файла</button>
        <textarea data-oa-paste="act" rows="1" placeholder="Вставити з Добовки: Ctrl+V" aria-label="Вставити з Добовки"></textarea></div>
      ${warns.length ? `<div class="callout oa-warn">${warns.map(esc).join('<br>')}</div>` : ''}
      ${(p.noNorm || []).length ? `<div class="oa-nonorm"><span>Без норми:</span>${p.noNorm.map((c) => `<button type="button"
        class="btn btn--sm" data-act="oa-nonorm" data-code="${esc(c)}" title="${esc((itemBy.get(String(c)) || {}).name || '')}">${esc(c)}</button>`).join('')}</div>` : ''}
      <div class="card card--scroll oa-lines"><div class="tbl" style="--tbl-min:720px"><div class="tbl__head">
        <div class="tbl__h c-code">код</div><div class="tbl__h c-name">найменування</div><div class="tbl__h c-num c-num--xwide">норма на д/д</div>
        <div class="tbl__h c-num c-num--wide">належить</div><div class="tbl__h c-num c-num--wide">залишок</div>
        <div class="tbl__h c-num c-num--wide">до списання</div><div class="tbl__h c-num c-num--xwide">сума, грн</div></div>
        ${rows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Немає чого списувати.</div></div>'}
        ${lines.length ? `<div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-code"></div><div class="c-name"><b>Разом</b></div>
          <div class="c-num c-num--xwide"></div><div class="c-num c-num--wide"></div><div class="c-num c-num--wide"></div>
          <div class="c-num c-num--wide"></div><div class="c-num c-num--xwide">${fmtMoney(total)}</div></div>` : ''}</div></div>`;
  }

  /** Підписанти й папери пакета: кожне поле правиться; підписанти й папери лягають в акт знімком. */
  function actSigHtml(w) {
    const sig = (role, sort) => (w.signers || []).find((s) => s.role === role && +s.sort === sort) || {};
    const ph = { pos: 'посада', rank: 'звання', name: 'Ім’я ПРІЗВИЩЕ' };
    const people = ACT_ROLES.map(([role, sort, label]) => {
      const s = sig(role, sort);
      return `<div class="oa-row"><span>${esc(label)}</span>${['pos', 'rank', 'name'].map((f) => `<input class="rc-in rc-in--wide"
        data-oa-sig="${esc(role)}|${sort}|${f}" value="${esc(s[f] || '')}" placeholder="${ph[f]}" aria-label="${esc(label)}: ${ph[f]}"
        autocomplete="off">`).join('')}</div>`;
    }).join('');
    const papers = actPapersOf(w).map(([role, label, withNo]) => {
      const x = (w.papers || {})[role] || {};
      return `<div class="oa-row oa-row--paper"><span>${esc(label)}</span>${withNo ? `<input class="rc-in rc-in--wide"
        data-oa-paper="${role}|no" value="${esc(x.no || '')}" placeholder="номер" aria-label="${esc(label)}: номер" autocomplete="off">`
        : '<span></span>'}<input class="rc-in rc-in--wide" type="date" data-oa-paper="${role}|date" value="${esc(x.date || '')}"
        aria-label="${esc(label)}: дата"></div>`;
    }).join('');
    return `<details class="fold oa-sig"${w.sigOpen ? ' open' : ''}><summary><span class="card__title">Підписанти й папери</span>
        <span class="fold__hint">${esc(actSigHint(w))}</span></summary>
      <div class="oa-sig__body">
        <div class="oa-row oa-row--h"><span></span><span>посада</span><span>звання</span><span>ім’я та прізвище</span></div>${people}
        <div class="oa-row oa-row--h oa-row--paper"><span></span><span>номер</span><span>дата</span></div>${papers}
        <div class="oa-row oa-row--note"><span>Примітка</span><input class="rc-in rc-in--wide" data-oa="note" value="${esc(w.note || '')}"
          aria-label="Примітка" autocomplete="off"></div></div></details>`;
  }

  /** Папери пакета цього акта: накладна — лише коли її запропонував сервер (акт місця-складу). */
  const actPapersOf = (w) => ACT_PAPERS.filter(([role]) => role !== 'накладна' || 'накладна' in (w.papers || {}));

  /** «9 підписантів · 4 папери» — у згорнутому блоці видно, чи пакет підписано. */
  function actSigHint(w) {
    const named = ACT_ROLES.filter(([role, sort]) => (w.signers || []).some((s) => s.role === role && +s.sort === sort
      && String(s.name || '').trim())).length;
    return `${cnt(named, 'підписант', 'підписанти', 'підписантів')} · ${cnt(actPapersOf(w).length, 'папір', 'папери', 'паперів')}`;
  }

  const actMsgHtml = (w) => (w && w.msg && w.msg.text ? esc(w.msg.text) + (w.msg.download
    ? ` <a href="${esc(w.msg.download)}" download>Завантажити файли акта</a>` : '') + (w.msg.force
    ? ' <button type="button" class="btn btn--sm" data-act="oa-force">Перезаписати</button>'
      + ' <button type="button" class="btn btn--sm" data-act="oa-keep">Скасувати</button>' : '') : '');

  /** Вікно акта цілком. Поле у фокусі, розгорнуті підписанти й прокрутка лишаються, як були. */
  function actDraw() {
    const w = actWin;
    if (!w) return;
    const keep = (actShown(w) && actFocusKey()) || w.keep || null;     // поле, вимкнене на час свіжої пропозиції, — з actFreeze
    w.keep = null;
    const top = actShown(w) ? ($('#modal .modal__body') || {}).scrollTop || 0 : 0;
    const pts = (store.points || []).filter((x) => !x.closed || x.id === w.point);
    // Документ акта, щойно записаного без файлів, з'явиться на сторінці після оновлення: до того ні статусу ФЕС, ні картки.
    const known = !!w.docId && !!actKey(w.docId);
    const fes = known ? ((store.docFes || {})[String(w.docId)] || {}).status || '' : '';
    const el = modalOpen(w.docId ? `Акт ${numNo(w.was ? w.was.number : w.number)}` : 'Акт списання за нормами', `<div class="pad oa" data-oa-win>
      <div class="form__grid oa-head">
        <div class="field"><label>Серія</label><select data-oa="series"${w.docId ? ' disabled' : ''}>${['ОП', 'МЗ'].map((s) =>
          `<option${s === w.series ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field field--span2"><label>Пункт харчування</label><select data-oa="point">${pts.map((x) =>
          `<option value="${esc(x.id)}"${x.id === w.point ? ' selected' : ''}>${esc(x.name)}${x.closed ? ' (закрито)' : ''}</option>`).join('')}</select></div>
        ${actField('from', 'Період з', w.from, 'date')}${actField('to', 'по', w.to, 'date')}
        ${actField('date', 'Дата акта', w.date, 'date')}${actField('number', 'Номер', w.number)}
      </div>
      <div class="oa-calc">${actCalcHtml(w)}</div>
      ${actSigHtml(w)}
      <div class="oa-acts">
        ${known ? `<label class="chip${fes ? ' is-on' : ''}"><span class="chip__label">статус ФЕС</span><select data-oa-fes>
          <option value="">—</option>${FES_STATUSES.map((s) => `<option${s === fes ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>` : ''}
        ${w.docId ? '<button type="button" class="btn btn--danger" data-act="oa-del">Видалити</button>' : ''}
        <span class="oa-msg${w.msg && w.msg.bad ? ' num-bad' : ''}">${actMsgHtml(w)}</span>
        ${w.docId ? `${known ? '<button type="button" class="btn" data-act="oa-card">Картка документа</button>' : ''}
          ${me.remote ? '' : '<button type="button" class="btn" data-act="oa-reveal">Відкрити теку</button>'}
          <button type="button" class="btn" data-act="oa-files">Перескласти файли</button>` : ''}
        <button type="button" class="btn" data-act="oa-close">Закрити</button>
        <button type="button" class="btn btn--primary" data-act="oa-save">${w.docId ? 'Зберегти' : 'Скласти акт'}</button>
      </div></div>`, 'modal__box--form modal__box--wide');
    actBind(el, w);
    const body = el.querySelector('.modal__body');
    if (body && top) body.scrollTop = top;
    if (keep) [...el.querySelectorAll('input, select')].find((x) => x.dataset[keep[0]] === keep[1])?.focus();
  }

  /** Лише д/д, попередження й рядки: поля вікна не перемальовуються, і курсор у даті чи номері лишається на місці. На час запису
   *  (w.busy) вікно вимкнене, і перерахунок, що спізнився, його не будить (поле вставки й «Взяти з файла» лишаються вимкненими):
   *  розрахунок домалюється, коли запис скінчиться відмовою (actPost). */
  function actCalcDraw(w) {
    if (w.busy) { w.calcLate = true; return; }
    const box = $('#modal [data-oa-win] .oa-calc');
    if (!box) return;
    w.calcLate = false;
    box.innerHTML = actCalcHtml(w);
    actBindCalc(box);
  }

  function actBind(el, w) {
    el.querySelectorAll('[data-oa]').forEach((f) => f.addEventListener('change', () => actFieldSet(w, f.dataset.oa, f.value)));
    el.querySelectorAll('[data-oa-sig]').forEach((f) => f.addEventListener('input', () => {
      const [role, sort, k] = f.dataset.oaSig.split('|');
      let s = w.signers.find((x) => x.role === role && +x.sort === +sort);
      if (!s) { s = { role, sort: +sort, pos: '', rank: '', name: '' }; w.signers.push(s); }
      s[k] = f.value;
      actDropForce(w);
      const hint = el.querySelector('.oa-sig .fold__hint');
      if (hint) hint.textContent = actSigHint(w);
    }));
    el.querySelectorAll('[data-oa-paper]').forEach((f) => f.addEventListener('input', () => {
      const [role, k] = f.dataset.oaPaper.split('|');
      w.papers[role] = Object.assign({}, w.papers[role] || {}, { [k]: f.value });
      actDropForce(w);
      if (w.msg && w.msg.ask && w.msg.text !== ACT_NO_PERIOD && !actDatesBad(w)) actSay(w, '');   // дату паперу виправили
    }));
    el.querySelector('details.oa-sig')?.addEventListener('toggle', (e) => { w.sigOpen = e.target.open; });
    el.querySelector('[data-oa-fes]')?.addEventListener('change', (e) => {
      fesSet(String(w.docId), { status: e.target.value });
      e.target.closest('.chip')?.classList.toggle('is-on', !!e.target.value);
      render();
    });
    actBindCalc(el);
  }
  function actBindCalc(root) {
    root.querySelector('[data-oa-paste="act"]')?.addEventListener('paste', (e) => {
      e.preventDefault();
      dobPaste((e.clipboardData || window.clipboardData).getData('text'), 'act');
    });
  }

  /** Поле вікна змінили. Нове вікно, інша серія чи пункт — пропозиція наново (з типовим періодом); інше — перерахунок за 0,4 с
   *  після останньої правки. Типові дата й номер паперу йдуть за полем, з якого їх узято. Поки йде свіжа пропозиція, поля
   *  вимкнені, і правка нічого не міняє: вікно намалюється наново з тим, що дасть сервер. */
  function actFieldSet(w, k, val, still = false) {
    // Поки йде свіжа пропозиція чи запис (скласти, файли, видалити), правка нічого не міняє й нового запиту не починає.
    if (actWin !== w || w.fresh || (w.busy && !still)) return;
    const was = w[k];
    w[k] = val;
    if (String(was ?? '') !== String(val ?? '')) actDropForce(w);        // питання «Перезаписати» було про інший запит
    if (k === 'note') return;
    // Обидві дати періоду знову є — відмова «Вкажіть період акта.» у рядку вікна вже ні до чого; так само відмова за датою
    // (рік з опискою, майбутнє, раніше за початок обліку), коли дати вже гаразд.
    if ((k === 'from' || k === 'to') && w.from && w.to && w.msg && w.msg.text === ACT_NO_PERIOD) actSay(w, '');
    else if (w.msg && w.msg.ask && w.msg.text !== ACT_NO_PERIOD && !actDatesBad(w)) actSay(w, '');
    for (const [role, f, from] of ACT_PAPER_FROM) {
      const x = (w.papers || {})[role];
      if (from !== k || !x || x[f] !== was) continue;
      x[f] = val;
      const inp = [...document.querySelectorAll('#modal [data-oa-paper]')].find((e) => e.dataset.oaPaper === `${role}|${f}`);
      if (inp) inp.value = val;
    }
    if (still) return;
    clearTimeout(w.timer);
    if (!w.docId && (k === 'series' || k === 'point')) { w.from = ''; w.to = ''; actPreview(true); return; }
    w.timer = setTimeout(() => { if (actWin === w) actPreview(false, true); }, 400);
  }
  /** Поля вікна — у стан вікна перед записом: номер, уписаний і підтверджений Enter на кнопці, ще не дав події change. */
  function actTake(w) {
    if (!actShown(w)) return;
    document.querySelectorAll('#modal [data-oa]').forEach((el) => {
      if (!el.disabled && String(w[el.dataset.oa] ?? '') !== el.value) actFieldSet(w, el.dataset.oa, el.value, true);
    });
  }

  /** Слово внизу вікна акта; вікна немає на екрані — звичайне повідомлення. `force` — слово-питання про файл пакета, правлений
   *  руками ('save' — повторити «Зберегти», 'files' — «Перескласти файли»): поруч кнопки «Перезаписати» й «Скасувати». */
  function actSay(w, text, bad = false, download = '', force = '') {
    if (w) w.msg = text ? { text, bad, download, force } : null;
    const el = actShown(w) ? $('#modal .oa-msg') : null;
    if (el) { el.className = 'oa-msg' + (bad ? ' num-bad' : ''); el.innerHTML = actMsgHtml(w); return; }
    if (text) toast(text, bad);
  }
  /** Відмова «Скласти акт» / «Зберегти» за полями вікна (період, дати): вона зникає сама, щойно поля знову гаразд. */
  function actAsk(w, text) {
    actSay(w, text, true);
    if (w && w.msg) w.msg.ask = true;
  }
  /** Справжня правка вікна після слова-питання «Перезаписати» знімає питання: воно повторює лише той запит, про який спитали, —
   *  з новим номером, роком дати чи серією переписало б файли іншого пакета, про які не питали. */
  function actDropForce(w) {
    if (w && w.msg && w.msg.force) actSay(w, '');
  }

  /** На час запиту, що змінює базу, вікно не правиться: поля, підписанти, папери, кнопки й статус ФЕС вимкнені (правка, внесена
   *  тим часом, зникла б з оновленням сторінки, а інший пункт почав би нову пропозицію). ✕ угорі вікна лишається. Після
   *  відмови вмикається лише те, що вимкнув сам запит. */
  function actBusy(w, on) {
    if (!actShown(w)) return;
    document.querySelectorAll('#modal [data-oa-win] input, #modal [data-oa-win] select, #modal [data-oa-win] textarea, '
      + '#modal [data-oa-win] button').forEach((el) => {
      if (on && !el.disabled) { el.disabled = true; el.dataset.oaBusy = '1'; }
      if (!on && el.dataset.oaBusy) { el.disabled = false; delete el.dataset.oaBusy; }
    });
  }

  /** Запит, що змінює базу (скласти, перескласти файли, видалити). Спершу внесене на сторінці лягає в базу; вікно на час
   *  запиту вимкнене, а після успіху так і лишається — сторінка оновлюється. Відмова — словом у вікні. Акт записано, а файли ні
   *  (відповідь із docId): вікно стає цим актом, і повтор не складе другого. Файл пакета правили руками (409 з `changed`): слово
   *  сервера з питанням — «Перезаписати» повторює запит із `force: true` (акт уже записано — лише файли), «Скасувати» лишає файли.
   *  Сервер не прийняв акт (422) — вікно перераховується: перетин з актом, складеним тим часом, тепер видно, і його можна
   *  підтвердити повторним «Зберегти». */
  async function actPost(w, path, payload) {
    if (!w || w.busy) return null;
    w.busy = true;
    actBusy(w, true);
    actSay(w, '');
    // Поки внесене ляже в базу, сторінка може оновитись, поєднавши правки (syncLeave): запит тоді так і не піде, а вікно, що стане
    // на місце (actPack), саме скаже, що не сталося.
    w.undone = `${actUndone(path, w)}: сторінка оновилась, поєднавши правки. Натисніть ще раз.`;
    let done = false;
    try {
      if (!(await actSettle())) { actSay(w, 'Внесене на сторінці ще не записано в базу. Спробуйте ще раз.', true); return null; }
      w.undone = '';                             // запит пішов: чим він скінчився, скаже відповідь
      const { ok, status, j } = await actCall(path, payload);
      if (ok) { done = true; return j; }
      if (j.docId) actAdopt(w, j);              // і виправлений акт: у базі він уже такий, як у вікні, — `was` теж
      if (status === 409 && Array.isArray(j.changed)) {
        actSay(w, j.error || 'Файл пакета змінено після програми. Перезаписати?', true, '',
          !j.docId && /\/save$/.test(path) ? 'save' : 'files');
        return null;
      }
      actSay(w, j.error || `Не вдалося: помилка ${status}.`, true);
      if (status === 422 && !j.docId && /\/save$/.test(path)) setTimeout(() => { if (actWin === w) actPreview(false, true); }, 0);
      return null;
    } finally {
      if (!done) {
        w.busy = false;
        w.undone = '';
        actBusy(w, false);
        if (w.calcLate) { w.calcLate = false; actCalcDraw(w); }       // перерахунок, що спізнився, домальовується
      }
    }
  }

  /** Що не сталося, коли запит акта не пішов (оновлення сторінки перервало очікування): слова для вікна, що стане на місце. */
  function actUndone(path, w) {
    if (/\/delete$/.test(path)) return 'Акт не видалено';
    if (/\/files$/.test(path)) return 'Файли не перескладено';
    return w.docId ? 'Зміни акта не записано' : 'Акт не складено';
  }

  /** «Перезаписати» в слові-питанні: людина погодилась переписати файл пакета, правлений руками. */
  function actForce() {
    const w = actWin;
    const kind = w && w.msg && w.msg.force;
    if (!kind || w.busy) return null;
    actTake(w);                                  // уписане, що ще не дало change, — теж правка після питання: воно знімається
    if (!w.msg || w.msg.force !== kind) return null;
    return kind === 'save' ? actSave(true) : actFiles(true);
  }

  /** «Скасувати» після слова-питання «Перезаписати»: що саме лишилось як було. Після «Скласти акт» / «Зберегти» не записано
   *  нічого (ні акта, ні змін) — людина, що закрила вікно, не мусить гадати; після «Перескласти файли» акт уже в базі, лишились
   *  лише файли. */
  function actKeep() {
    const w = actWin;
    actSay(w, !w ? '' : w.msg && w.msg.force === 'save' ? 'Акт не записано, файли лишились як були.' : 'Файли лишились як були.');
  }

  function actAdopt(w, j) {
    const no = String(j.number || w.number || '').trim();
    // `sig` — відбиток акта таким, яким його щойно записано (відповідь сервера), як у акта з реєстру (actState): підписантів, змінених
    // в іншому вікні, вікно далі бачить (actSameWas), а сервер не дає їх переписати мовчки (op_acts._same_act).
    Object.assign(w, { docId: Number(j.docId), number: no,
      was: { number: no, date: w.date, from: w.from, to: w.to, sig: String(j.sig || '') } });
    if (actShown(w)) actDraw();
  }

  /** Акт у закритому періоді (підписана звірка місця, завершена інвентаризація) — лише з явної згоди, як і будь-який документ.
   *  Відмова — null; інакше { locked } — чи акт потрапляє в закритий період (тоді сервер позначає це в журналі змін, як форма
   *  документа: і в режимі «вношу історію», де згоди не питають). */
  function actLockOk(w, verb, dates) {
    const doc = w.docId ? docs.find((r) => String(r.id) === String(w.docId)) : null;
    const place = pointPlace((store.points || []).find((p) => p.id === w.point));
    const lock = periodLock(dates, [place, doc ? doc.from : '']);
    if (!lock) return { locked: false };
    return histOn() || confirm(lock.replace(/\n\nДля внесення старих документів[^\n]*/, '').replace('Провести все одно?', verb))
      ? { locked: true } : null;
  }

  /** «Скласти акт» / «Зберегти». `force` — «Перезаписати» після питання про файл пакета, правлений руками. */
  async function actSave(force = false) {
    const w = actWin;
    if (!w || w.busy || w.fresh) return;
    actTake(w);
    if (!w.from || !w.to) { actSay(w, ACT_NO_PERIOD, true); return; }
    const dates = actDatesBad(w);
    if (dates) { actAsk(w, dates); return; }
    if (!String(w.number || '').trim()) { actSay(w, 'Вкажіть номер акта.', true); return; }
    clearTimeout(w.timer);
    const edit = !!w.docId;
    const lock = actLockOk(w, edit ? 'Зберегти все одно?' : 'Скласти все одно?', [w.date, w.was ? w.was.date : '']);
    if (!lock) return;
    const payload = { docId: w.docId || null, series: w.series, point: w.point, from: w.from, to: w.to, date: w.date,
      number: w.number, signers: w.signers, papers: w.papers, note: w.note || '', overlapOk: (w.prop && w.prop.overlap) || [] };
    if (w.docId) payload.was = w.was;
    if (lock.locked) payload.locked = true;
    if (force === true) payload.force = true;
    const j = await actPost(w, 'api/op-act/save', payload);
    if (!j) return;
    const no = String(j.number || w.number).trim();
    const f = w.first;                          // яким акт був, коли вікно відкрили: його тека лишається на місці
    const old = f && (f.number !== no || String(f.date).slice(0, 4) !== String(w.date).slice(0, 4)) ? ` Тека ${f.number} лишилась.` : '';
    const locked = (j.locked || []).length ? ' Відкритий в Excel файл записано поруч.' : '';
    afterReload('acts', { book: 'ОП', actsTab: 'acts' }, `Акт ${numNo(no)} ${edit ? 'збережено' : 'складено'}.${locked}${old}`,
      j.download ? { download: j.download } : me.remote ? {} : { reveal: j.docId });
  }

  /** «Перескласти файли»; `force` — «Перезаписати» після питання про файл пакета, правлений руками. */
  async function actFiles(force = false) {
    const w = actWin;
    if (!w || !w.docId) return;
    const j = await actPost(w, 'api/op-act/files', force === true ? { docId: w.docId, force: true } : { docId: w.docId });
    if (!j) return;
    const locked = (j.locked || []).length ? ' Відкритий в Excel файл записано поруч.' : '';
    // Той самий екран після оновлення — і та сама книга: «Документи» ОП не стають «Документами» ТЗ.
    afterReload(state.view, Object.assign({}, syncView().state, { book: state.book }),
      `Файли акта ${numNo(w.was ? w.was.number : w.number)} перескладено.${locked}`,
      Object.assign({ open: w.docId }, j.download ? { download: j.download } : {}));
  }

  async function actReveal(id) {
    if (!id) return;
    const sp = isSpAct(id);
    const { ok, j } = await actCall(sp ? 'api/sp-act/reveal' : 'api/op-act/reveal', { docId: Number(id) });
    if (ok) return;
    // Слово — у рядку вікна свого акта (ОП/МЗ чи сухпаю), а вікна немає — звичайним повідомленням.
    if (sp) spSay(spWin && String(spWin.docId) === String(id) ? spWin : null, j.error || 'Теку не відкрито.', true);
    else actSay(actWin && String(actWin.docId) === String(id) ? actWin : null, j.error || 'Теку не відкрито.', true);
  }

  /** Видалити складений акт: з вікна акта чи з картки його документа (`w` — стан акта без вікна). */
  async function actDelete(w = actWin) {
    if (!w || !w.docId || w.busy) return;
    const no = w.was ? w.was.number : w.number;
    if (!confirm(`Видалити акт ${numNo(no)}? Документ вибуття зникне з обліку, файли в теці лишаться.`)) return;
    const lock = actLockOk(w, 'Видалити все одно?', [w.was ? w.was.date : w.date]);
    if (!lock) return;
    const id = w.docId;
    const j = await actPost(w, 'api/op-act/delete', lock.locked ? { docId: w.docId, was: w.was, locked: true } : { docId: w.docId, was: w.was });
    if (!j) return;
    docFieldsForget(id);                       // id видаленого останнім документа вільний: новий документ не успадкує поля акта
    afterReload('acts', isSpAct(id) ? { book: 'СП' } : { book: 'ОП', actsTab: 'acts' }, `Акт ${numNo(j.number || no)} видалено.`);
  }

  function actCard() {
    const key = actKey(actWin && actWin.docId);
    if (!key) { actSay(actWin, 'Документа акта на сторінці ще немає. Оновіть сторінку (F5).', true); return; }
    actWin = null;
    modalClose();
    openDoc(key, { plain: true });
  }

  /** Поля вікна акта, що переживають оновлення сторінки, яке зливає правки двох людей (syncLeave): уписане (номер, дати,
   *  підписанти — і взяті з Добовки, папери, примітка), складений акт (docId, яким його відкрило вікно) і пораховане. */
  const ACT_KEEP = ['docId', 'series', 'point', 'from', 'to', 'date', 'number', 'signers', 'papers', 'note', 'was', 'first',
    'prop', 'msg', 'sigOpen'];
  /** Відкрите вікно акта — для пакета syncLeave (без таймера й запиту, що йде); вікна немає — null. */
  function actPack() {
    const w = actWin;
    if (!w) return null;
    actTake(w);                                  // уписане, що ще не дало події change
    const out = {};
    for (const k of ACT_KEEP) if (w[k] !== undefined) out[k] = w[k];
    if (w.undone) out.msg = { text: w.undone, bad: true };      // запит чекав на базу й не пішов — вікно каже це саме
    if (w.fresh) out.fresh = true;               // свіжа пропозиція не дійшла — після оновлення її просять знову
    try { return JSON.parse(JSON.stringify(out)); } catch (e) { return null; }
  }
  /** Вікно бачило той самий акт, що тепер у базі: номер, дата, період і відбиток решти (`sig`) — що є у `was`, як op_acts._same_act. */
  function actSameWas(was, now) {
    if (!was) return true;
    if (!now) return false;
    for (const k of ['number', 'date', 'from', 'to']) {
      if (was[k] && String(was[k]).replace(/\s+/g, ' ').trim() !== String(now[k] || '').replace(/\s+/g, ' ').trim()) return false;
    }
    return !was.sig || was.sig === now.sig;
  }
  /** Після оновлення, що злило правки (syncLeave): вікно акта знову на екрані з усім, що в ньому було, — як і вікна, які не
   *  оновлюються, поки їх не закрили. Складений акт, який тим часом змінили чи видалили в іншому вікні, мовчки не
   *  переписується: слово у вікні каже, що сталося, а людина вирішує — «Зберегти» (чи «Скласти акт») або «Закрити». */
  function actRestore(pack) {
    if (!pack || typeof pack !== 'object') return;
    const w = Object.assign({ docId: 0, series: 'ОП', signers: [], papers: {}, note: '' }, pack);
    delete w.fresh;
    if (w.docId) {
      const now = actState(w.docId);
      const no = numNo(w.was ? w.was.number : w.number);
      if (!now) {
        w.msg = { text: `Акт ${no} тим часом видалили в іншому вікні. «Скласти акт» складе його знову з тим, що у вікні.`, bad: true };
        Object.assign(w, { docId: 0, was: null, first: null });
      } else if (!actSameWas(w.was, now.was)) {
        w.msg = { text: `Акт ${no} тим часом змінили в іншому вікні. «Зберегти» запише те, що у вікні, «Закрити» лишить змінений.`,
          bad: true };
        w.was = now.was;                         // людину спитали: «Зберегти» тепер переписує саме теперішній акт бази
      }
    }
    actWin = w;
    if (!pack.docId && (pack.fresh || !w.prop)) { actPreview(true); return; }    // пропозиція нового акта так і не дійшла
    actDraw();
    actPreview(false, true);                     // д/д і рядки — з бази, куди щойно лягли злиті правки
  }

  /** Сервер змінив базу (акт складено чи видалено, файли перескладено): сторінка береться за свіжі дані, а після оновлення
   *  відкриває екран `view` зі станом `patch` і каже `text`. `extra`: open — id акта, вікно якого відкрити знову (слово тоді у
   *  вікні); download — посилання на файли акта (інший ПК); reveal — id акта для кнопки «Відкрити теку». */
  const AFTER_KEY = 'oblik.after';
  function afterReload(view, patch, text, extra = {}) {
    try { sessionStorage.setItem(AFTER_KEY, JSON.stringify(Object.assign({}, extra, { view, patch, text }))); } catch (e) { /* без сховища — просто оновлення */ }
    sync.leaving = true;
    location.reload();
  }
  /** У запуску сторінки одразу після syncTake: екран стає станом ще до першого показу (його ж запам'ятовує історія вікна), а
   *  слово й вікно акта — після показу (afterShow). */
  function afterTake() {
    let a = null;
    try { a = JSON.parse(sessionStorage.getItem(AFTER_KEY) || 'null'); sessionStorage.removeItem(AFTER_KEY); } catch (e) { a = null; }
    if (!a || typeof a !== 'object' || !native || stateBroken) return null;
    if (app[a.view]) Object.assign(state, syncPlain(a.patch) ? a.patch : {}, { view: a.view });
    return a;
  }
  function afterShow(a) {
    if (a.open) { actOpen(a.open, a.text ? { text: a.text, bad: false, download: a.download || '' } : null); return; }
    if (!a.text) return;
    if (!a.download && !a.reveal) { toast(a.text); return; }
    // Слово з дією висить довше за звичайне й зникає після дії.
    const el = document.createElement('div');
    el.className = 'toast toast--act';
    el.append(`${a.text} `);
    const b = document.createElement(a.download ? 'a' : 'button');
    if (a.download) Object.assign(b, { href: a.download, download: '', textContent: 'Завантажити файли акта' });
    else { Object.assign(b, { type: 'button', className: 'btn btn--sm', textContent: 'Відкрити теку' }); b.dataset.act = 'oa-reveal'; b.dataset.id = String(a.reveal); }
    b.addEventListener('click', () => setTimeout(() => el.remove(), 300));
    el.appendChild(b);
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('toast--out'), 20000);
    setTimeout(() => el.remove(), 20700);
  }
