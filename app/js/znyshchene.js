// Облік ТЗ ПС · сторінка · знищене майно.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ---------------------------------------------------------- Знищене майно
  /** Реєстр знищеного: рапорт, потім акт списання. Спільний для екрана й Excel. */
  function destroyedSpec() {
    const journal = allDestroyed();
    const vals = lossValues();
    const days = (r) => (r.reportDate && r.status !== 'списано'
      ? Math.round((Date.parse(state.asOf) - Date.parse(r.reportDate)) / 864e5) : null);
    const nameOf = (r) => (r.other ? r.name || '' : (itemBy.get(r.code) || {}).name || '');
    const units = (list) => list.reduce((a, r) => a + (r.other ? 0 : +r.qty || 0), 0);
    const money = (list) => round2(list.reduce((a, r) => a + ((vals.get(r.id) || {}).sum || 0), 0));
    const holders = subs.filter((sb) => sb.type !== 'бригада' && journal.some((r) => inSubtree(sb.name, r.sub)));
    // Спершу черга роботи: записи без акта (найдавніші згори), далі ті, що чекають
    // проведення акта, і вже списані (найновіші згори) — реєстр читається як перелік справ.
    const rank = (r) => (r.status === 'списано' ? 2 : r.status === 'включено до акта' ? 1 : 0);
    // Черга чекає від рапорту, а не від події: давніший рапорт — вище.
    const when = (r) => (r.status === 'списано' ? r.date : r.reportDate || r.date) || '';
    const byDate = (a, b, desc) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0) * (desc ? -1 : 1);
    const rows = journal.slice().sort((a, b) => rank(a) - rank(b) || byDate(a, b, rank(a) === 2));
    // Ланцюжок станів словами людини, а не моделі: «рапорт подано» → «акт №N не
    // проведений» → «списано актом №N». Номер акта відкриває сам акт, коли той проведений.
    const actRef = (r) => (r.act && actDocKey(r)
      ? `<span class="lnk" data-open="${esc(actDocKey(r))}" title="Відкрити документ">${esc(numNo(r.act))}</span>` : esc(numNo(r.act || '—')));
    const stateCell = (r) => {
      if (r.other) {
        return r.status === 'списано'
          ? `<span class="tag tag--in">списано</span><small>${esc(r.offNo || 'документ не вказано')}${r.offDate ? ' від ' + fmtDate(r.offDate) : ''}</small>`
          : '<span class="tag tag--out">не списано</span><small>документ списання — у рапорті</small>';
      }
      const d = days(r);
      if (r.status === 'списано') {
        return `<span class="tag tag--in">списано</span><small>${esc((r.actType || 'акт').toLowerCase())} ${actRef(r)}${
          r.actDate ? ' від ' + fmtDate(r.actDate) : ''}</small>`;
      }
      // Лічильник каже, чого саме чекає запис: акта — чи проведення вже складеного акта.
      if (r.status === 'включено до акта') {
        return `<span class="tag tag--out">акт не проведений</span><small>${actRef(r)}${d == null ? ''
          : ` · <span class="${d > 30 ? 'num-bad' : ''}">${d} дн. без проведення</span>`}</small>`;
      }
      return `<span class="tag tag--out">рапорт подано</span>${d == null ? ''
        : `<small><span class="${d > 30 ? 'num-bad' : ''}">${d} дн. без акта</span></small>`}`;
    };
    // Дії словами за станом запису: головна — та, що веде далі по ланцюжку; решта дрібніше.
    const actsCell = (r) => {
      const main = r.other || r.status === 'списано' ? ''
        : r.status === 'включено до акта'
          // Акт із цим номером уже проведено, але запис він не закрив (позиції чи кількості
          // в ньому замало): другий акт з тим самим номером не складаємо — відкриваємо той.
          ? (actDocKey(r)
            ? `<button type="button" class="ico-btn ico-btn--main" data-open="${esc(actDocKey(r))}"
                title="Акт ${esc(numNo(r.act))} проведено, але цього запису він не списав: відкрийте акт і допишіть позицію">Відкрити акт →</button>`
            // Довгий номер уже стоїть у графі стану — кнопці досить стрілки.
            : rowBtn('dz-wr', String(r.act).length > 8 ? 'Провести акт →' : `Провести акт ${esc(numNo(r.act))}`, `data-id="${esc(r.id)}"`,
              { main: true, title: `Відкрити чернетку акта ${numNo(r.act)} з цього запису — перевірити й провести` }))
          : rowBtn('dz-act', 'Списати актом…', `data-id="${esc(r.id)}"`,
            { main: true, title: 'Спитає номер акта, підготує чернетку акта списання й відкриє її' });
      const whole = !(r.part && r.status === 'списано');
      const more = [whole ? rowBtn('dz-edit', 'виправити', `data-id="${esc(r.id)}"`, { title: 'Виправити рапорт' }) : '',
        reportFilesBtn(r),
        whole ? rowBtn('dz-del', 'видалити', `data-id="${esc(r.id)}"`, { bad: true, title: 'Видалити запис' }) : ''].filter(Boolean).join('');
      return `${main}<span class="acts__more">${more}</span>`;
    };
    return {
      id: 'dz', rows, headSearch: true, minWidth: '1040px', acts: '160px', limit: REG_LIMIT,
      search: (r) => [r.code, nameOf(r), r.sub, r.report || '', r.act || r.offNo || '', r.note || '', r.other ? 'інше майно' : ''],
      filters: [
        // Три стани запису — три чипи, без перекриття («не списано» включало б і «акт не проведений»).
        { type: 'seg', key: 'st', options: [['', 'усі'], ['open', 'рапорт подано'], ['act', 'акт не проведений'], ['done', 'списано']],
          test: (r, v) => (v === 'open' ? r.status === 'рапорт подано' : v === 'act' ? r.status === 'включено до акта' : r.status === 'списано') },
        { type: 'select', key: 'sub', label: 'підрозділ', all: 'усі', options: holders.map((sb) => [sb.name, sb.name]),
          test: (r, v) => inSubtree(v, r.sub) },
        { type: 'period', key: 'd', label: 'дата події', get: (r) => r.date },
        { type: 'period', key: 'a', label: 'дата акта', get: (r) => (r.status === 'списано' ? r.actDate : '') },
        { type: 'toggle', key: 'late', label: 'понад 30 днів без списання', test: (r) => (days(r) ?? 0) > 30 },
      ],
      // Колонки вміщаються в 1366 px без прокрутки: код — під назвою, дата рапорту —
      // під номером, ціна — під сумою, номер акта й дні без акта — під станом.
      columns: [
        { key: 'date', label: 'дата події', cls: 'c-date', sort: (r) => r.date || '', cell: (r) => fmtDate(r.date) },
        { key: 'sub', label: 'підрозділ', cls: 'c-txt', style: 'flex:0 1 150px', first: 1, sort: (r) => r.sub, cell: (r) => esc(r.sub) },
        { key: 'name', label: 'найменування · код', cls: 'c-name c-name--stack', style: 'flex:2 1 230px', first: 1, sort: nameOf,
          cellTitle: (r) => (r.other ? 'Інше майно: обліку в програмі не веде, у довідку про втрати входить' : r.note || ''),
          cell: (r) => `<b>${esc(nameOf(r))}</b><small>${[r.other ? 'інше майно' : r.code,
            r.unit ? unitLabel(unitBy.get(String(r.unit))) : '', r.note].filter(Boolean).map(esc).join(' · ')}</small>` },
        { key: 'qty', label: 'к-сть', cls: 'c-num', style: 'width:56px', sort: (r) => +r.qty || 0,
          cellTitle: (r) => (r.part ? (r.status === 'списано' ? `Акт списав ${fmtNum(r.qty)} із ${fmtNum(r.whole)} за записом`
            : `Акт списав не все: ${fmtNum(r.qty)} із ${fmtNum(r.whole)} ще чекають`) : ''),
          cell: (r) => (r.part ? `${fmtNum(r.qty)}<small>із ${fmtNum(r.whole)}</small>`
            : `${fmtNum(r.qty)}${r.other && r.uom ? `<small>${esc(r.uom)}</small>` : ''}`) },
        { key: 'sum', label: 'сума · ціна, грн', cls: 'c-num c-num--stack', style: 'width:104px',
          title: 'Сума за ціною партії: списане — за партіями акта, не списане — за найдавнішою партією підрозділу на дату події; «за док.» — ціна за рапортом чи справою',
          sort: (r) => (vals.get(r.id) || {}).sum || 0,
          cellCls: (r) => ((vals.get(r.id) || {}).missing ? 'num-bad' : ''),
          cellTitle: (r) => { const v = vals.get(r.id) || {};
            return v.missing ? (r.other ? 'Без ціни: у рапорті ціни немає'
              : `Без ціни: у «${r.sub}» партій цієї позиції немає ні на ${fmtDate(r.date)}, ні на звітну дату`)
              : v.doc ? 'Ціна за документом (рапорт, справа ЄАС, відомість), не за партією' : ''; },
          cell: (r) => { const v = vals.get(r.id); return v && v.qty ? `${fmtMoney(v.sum)}<small>${fmtMoney(v.price)}${v.doc ? ' за док.' : ''}</small>` : '—'; } },
        { key: 'report', label: 'рапорт', cls: 'c-code', style: 'width:80px', first: 1, title: 'Номер і дата рапорту',
          sort: (r) => r.report || '', cellTitle: (r) => (r.reportDate ? `рапорт від ${fmtDate(r.reportDate)}` : ''),
          cell: (r) => `${esc(r.report || '—')}${r.reportDate ? `<small>${fmtDate(r.reportDate)}</small>` : ''}` },
        { key: 'status', label: 'стан · акт', cls: 'c-tag', style: 'width:168px', first: 1,
          title: 'Стан запису, акт списання і днів від рапорту без акта',
          // У межах стану — спершу ті, що чекають акта найдовше.
          sort: (r) => `${r.status}|${String(9999 - (days(r) ?? 0)).padStart(4, '0')}`,
          cellTitle: (r) => (r.other ? '' : actLabel(r)), cell: stateCell },
        { key: 'acts', label: '', cls: 'c-acts c-acts--col', cell: actsCell },
      ],
      // Запис, на який привело Зведення, підсвічено — щоб не шукати його очима.
      row: (r) => ({ attrs: `data-item="${esc(r.code)}"`, title: nameOf(r), cls: state.dzFocus && r.id === state.dzFocus ? 'is-sel' : '' }),
      total: (shown) => ({ name: '<b>Разом</b>', qty: fmtNum(units(shown), '0'), sum: fmtMoney(money(shown)) }),
      count: (shown, all) => `${shown.length === all.length ? cnt(all.length, 'запис', 'записи', 'записів') : `${shown.length} із ${all.length}`}`
        + ` · не списано ${fmtNum(units(shown.filter((r) => r.status !== 'списано')), '0')} од. на ${
          fmtMoney(money(shown.filter((r) => r.status !== 'списано')))} грн`,
      emptyFiltered: 'За цими фільтрами записів немає.',
    };
  }

  function renderDestroyed() {
    const spec = destroyedSpec();
    if (!spec.rows.length) {
      return {
        fill: true,
        head: head('техзасоби / знищене майно', 'Знищене майно',
          '<button class="btn btn--primary" data-act="new-dz">+ Внести знищення</button>'),
        body: emptyBlock('⚠', 'Записів про знищення немає',
          'До акта списання знищене лишається в обліку, але не рахується наявним.',
          '<button class="btn btn--primary" data-act="new-dz">+ Внести знищення</button>'),
      };
    }
    const reg = registry(spec);
    return {
      fill: true,
      head: head('техзасоби / знищене майно', 'Знищене майно', searchBox('Пошук: код, назва, підрозділ, рапорт, акт')
        + `${actionsExcel}<button class="btn" data-act="losses-xls"
            title="Втрачено, списано й залишок до списання: усього, у поточному році й за період — разом, за підрозділами й за найменуваннями">Довідка про втрати</button>
          <button class="btn btn--primary" data-act="new-dz">+ Внести знищення</button>`),
      body: `${flashBlock()}${reg.panel}<div class="card card--scroll card--fill">${reg.table}</div>`,
    };
  }

  /** Довідка про втрати в Excel: форми доповідей міняються, а питають одне —
   *  скільки втрачено, скільки списано й скільки лишилося, усього, за рік і за
   *  період, у гривнях і в одиницях. Один файл на чотири аркуші: підсумок,
   *  за підрозділами, за найменуваннями, рядки рапортів — і з нього беруть
   *  клітинку чи аркуш під потрібний бланк.
   *  Зріз довідки — підрозділ і пошук реєстру; стан і дати в ній самій. Аркуш
   *  «Рядки» — рівно те, що показує реєстр. */
  function lossesExcel() {
    const spec = destroyedSpec();
    const f = tfOf('dz');
    const period = f.dFrom || f.dTo ? [f.dFrom || '', f.dTo || ''] : null;
    const scope = regRows(Object.assign({}, spec, { filters: spec.filters.filter((x) => x.key === 'sub') }));
    if (!scope.length) { toast('Записів про знищення за цим відбором немає.'); return; }
    const asOf = state.asOf;
    const vals = lossValues();
    const nameOf = (code) => cleanName((itemBy.get(code) || {}).name || code);
    const rowName = (r) => (r.other ? r.name || '' : nameOf(r.code) + (r.unit ? `, ${unitLabel(unitBy.get(String(r.unit)))}` : ''));
    const hasOther = scope.some((r) => r.other);
    const year = asOf.slice(0, 4);
    const periodText = period ? `з ${period[0] ? fmtDate(period[0]) : 'початку обліку'} по ${fmtDate(period[1] && period[1] < asOf ? period[1] : asOf)}` : '';
    const sliceName = { total: `Усього станом на ${fmtDate(asOf)}`, year: `У поточному році (з 01.01.${year})`, period: `За період ${periodText}` };
    const groups = [['Втрачено всього', 'total', 'lost'], ['Списано всього', 'total', 'off'],
      [`Втрачено в ${year} році`, 'year', 'lost'], [`Списано в ${year} році`, 'year', 'off']]
      .concat(period ? [['Втрачено за період', 'period', 'lost'], ['Списано за період', 'period', 'off']] : [])
      .concat([['Залишок до списання', 'total', 'left']]);
    const pair = (s, kind) => (kind === 'lost' ? [s.lostQ, s.lostSum] : kind === 'off' ? [s.offQ, s.offSum] : [s.leftQ, s.leftSum]);
    const cells = (sum) => groups.flatMap(([, sl, kind]) => pair(sum[sl], kind));
    const grid = (lead) => ({
      head: [lead.concat(groups.map(([t]) => ({ t, span: 2 }))), lead.map(() => '').concat(groups.flatMap(() => ['од.', 'грн']))],
      num: groups.map((_, i) => lead.length + 2 * i), money: groups.map((_, i) => lead.length + 2 * i + 1),
      widths: lead.map((x) => (/найменування/i.test(x) ? 44 : /підрозділ/i.test(x) ? 26 : 9)).concat(groups.flatMap(() => [8, 14])),
    });
    const all = lossSummary(scope, asOf, period);
    const missing = round3(all.total.missing);
    const missingRows = scope.filter((r) => (vals.get(r.id) || {}).missing).length;
    const docRows = scope.filter((r) => (vals.get(r.id) || {}).doc).length;
    const top = [unitTop()];
    const title = hasOther ? 'ВТРАТИ ТЕХНІЧНИХ ЗАСОБІВ ТА ІНШОГО МАЙНА ПРОДОВОЛЬЧОЇ СЛУЖБИ'
      : 'ВТРАТИ ТЕХНІЧНИХ ЗАСОБІВ ПРОДОВОЛЬЧОЇ СЛУЖБИ';
    const subtitle = `станом на ${fmtDate(asOf)}`;
    const where = [f.sub ? `Підрозділ: ${f.sub} (з підпорядкованими)` : 'Уся частина']
      .concat(state.q.trim() ? [`Відбір: «${state.q.trim()}»`] : [])
      .concat(period ? [`Період (графи «за період»): ${periodText}`] : []);
    const method = ['Втрачено — за датою події рапорту про знищення, списано — за датою акта списання (витягу з наказу). '
      + 'Сума — за ціною партії: списане — за партіями, які взяв акт; не списане — за найдавнішою партією підрозділу на дату події.']
      .concat(docRows ? [`Ціна за документом (рапорт, справа ЄАС, відомість) замість партії — у ${cnt(docRows, 'рядку', 'рядках', 'рядках')}.`] : [])
      .concat(hasOther ? ['Інше майно (продукти, запаси, майно інших служб) — кількістю й ціною за рапортом, списане документом, названим у рядку; '
        + 'у графах «од.» — лише технічні засоби.'] : [])
      .concat(missing ? [`Без ціни ${cnt(missingRows, 'рядок', 'рядки', 'рядків')} на ${fmtNum(missing)} од.: `
        + 'у підрозділі партій цієї позиції немає ні на дату події, ні на звітну дату, або в рапорті ціни немає — у сумах не враховано.'] : []);
    // 1. Підсумок: рядок на зріз; інше майно — під ним, лише сумою.
    const summary = Object.entries(all).flatMap(([sl, s]) => [[sliceName[sl], s.lostQ, s.lostSum, s.offQ, s.offSum,
      sl === 'total' ? s.leftQ : '', sl === 'total' ? s.leftSum : '']]
      .concat(hasOther ? [['    у тому числі інше майно', '', s.otherLost, '', s.otherOff, '',
        sl === 'total' ? round2(s.otherLost - s.otherOff) : '']] : []));
    // 2. За підрозділами — у порядку довідника; 3. За найменуваннями — за кодом, інше майно — за назвою після них.
    const order = (name) => (subBy.get(name) || {}).order ?? 1e9;
    const bySub = [...new Set(scope.map((r) => r.sub))].sort((a, b) => order(a) - order(b) || a.localeCompare(b, 'uk'))
      .map((sub) => [sub].concat(cells(lossSummary(scope.filter((r) => r.sub === sub), asOf, period))));
    const keyOf = (r) => (r.other ? '~' + (r.name || '') : r.code);
    const byCode = [...new Set(scope.map(keyOf))].sort((a, b) => a.localeCompare(b, 'uk', { numeric: true }))
      .map((key) => {
        const mine = scope.filter((r) => keyOf(r) === key);
        const r0 = mine[0];
        const nos = (k) => [...new Set(mine.map((r) => r[k]).filter(Boolean))].join(', ');
        const lead = r0.other ? ['', r0.name || '', r0.uom || ''] : [r0.code, nameOf(r0.code), (itemBy.get(r0.code) || {}).unit || ''];
        return lead.concat(cells(lossSummary(mine, asOf, period)), [nos('report'), r0.other ? nos('offNo') : nos('act')]);
      });
    const totalOf = (lead, rows) => lead.concat(groups.map((_, i) => [
      round3(rows.reduce((a, r) => a + (+r[lead.length + 2 * i] || 0), 0)),
      round2(rows.reduce((a, r) => a + (+r[lead.length + 2 * i + 1] || 0), 0))]).flat());
    const gSub = grid(['Підрозділ']), gCode = grid(['Код', 'Найменування', 'Од.']);
    // 4. Рядки — як у реєстрі, з його фільтрами й порядком.
    const shown = regRows(spec);
    const lines = shown.map((r) => {
      const v = vals.get(r.id) || {};
      return [r.date, r.sub, r.other ? '' : r.code, rowName(r), r.qty,
        v.qty ? v.price : '', v.qty ? v.sum : '', r.report || '', r.reportDate || '', r.other ? r.offNo || '' : r.act || '',
        r.status === 'списано' ? r.actDate || '' : '', r.status];
    });
    toExcel({
      file: `Довідка про втрати на ${asOf}`,
      sheets: [{
        name: 'Підсумок', orientation: 'portrait', top, title, subtitle, lines: where,
        head: [['Зріз', { t: 'Втрачено', span: 2 }, { t: 'Списано', span: 2 }, { t: 'Залишок до списання', span: 2 }],
          ['', 'од.', 'грн', 'од.', 'грн', 'од.', 'грн']],
        widths: [36, 8, 15, 8, 15, 8, 15], rows: summary, num: [1, 3, 5], money: [2, 4, 6],
        after: method, signs: ['Начальник продовольчої служби'],
      }, {
        name: 'За підрозділами', orientation: 'landscape', top, title: `${title}: за підрозділами`, subtitle, lines: where,
        head: gSub.head, widths: gSub.widths, rows: bySub, num: gSub.num, money: gSub.money,
        total: totalOf(['Разом'], bySub),
      }, {
        name: 'За найменуваннями', orientation: 'landscape', top, title: `${title}: за найменуваннями`, subtitle, lines: where,
        head: [gCode.head[0].concat(['Рапорти', 'Акти']), gCode.head[1].concat(['', ''])],
        widths: gCode.widths.concat([22, 22]), rows: byCode, num: gCode.num, money: gCode.money,
        total: totalOf(['Разом', '', ''], byCode).concat(['', '']),
      }, {
        name: 'Рядки', orientation: 'landscape', top, title: `${title}: рядки рапортів`,
        subtitle: `${subtitle}${regActive(spec) ? ' · з фільтрами реєстру' : ''}`,
        head: [['Дата події', 'Підрозділ', 'Код', 'Найменування', 'К-сть', 'Ціна, грн', 'Сума, грн', 'Рапорт', 'Дата рапорту',
          'Акт чи наказ', 'Дата акта', 'Стан']],
        widths: [11, 24, 8, 44, 8, 12, 14, 10, 11, 12, 11, 16], rows: lines, num: [4], money: [5, 6],
        total: ['', 'Разом', '', '', round3(shown.reduce((a, r) => a + (r.other ? 0 : +r.qty || 0), 0)), '',
          round2(shown.reduce((a, r) => a + ((vals.get(r.id) || {}).sum || 0), 0)), '', '', '', '', ''],
      }],
    });
  }
