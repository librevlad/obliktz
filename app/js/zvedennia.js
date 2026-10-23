// Облік ТЗ ПС · сторінка · Зведення.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

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
    ['Внести рапорт про знищення', 'потім знищене списують актом: «Техзасоби» → «Знищене»', 'doc-new', 'dz'],
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
