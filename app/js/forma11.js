// Облік ТЗ ПС · сторінка · 11/прод.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ---------------------------------------------------------------- 11/прод
  /** Звіт про продовольчу тару 11/прод за календарний квартал: цифри рахує сервер з книги СП (api/form11 — тара «Т»),
   *  сторінка тримає останню відповідь у F11. Квартал — останній завершений, ‹ › — сусідні; «Скласти звіт» кладе книгу
   *  в теку звітів («<рік>\<N> квартал\11прод») і відкриває її. Відповідь прив'язана до кварталу й до версії даних
   *  вікна: після збереження змін екран збирає звіт наново. Відповідь-помилку екран тримає, доки не натиснуто «Повторити». */
  const F11 = { key: '', data: null, loading: '' };
  const F11_ROMAN = ['I', 'II', 'III', 'IV'];
  /** Номер кварталу сьогоднішнього дня (рік × 4 + квартал − 1): › далі за нього не веде. */
  const f11Now = () => Number(today().slice(0, 4)) * 4 + Math.floor((Number(today().slice(5, 7)) - 1) / 3);
  /** [рік, квартал] екрана: вибраний ‹ › або останній завершений. */
  function f11Quarter() {
    if (state.f11q) return state.f11q;
    const n = f11Now() - 1;
    return [Math.floor(n / 4), n % 4 + 1];
  }
  async function f11Load(key) {
    F11.loading = key;
    let got;
    let at = key;                                       // ключ відповіді: версія даних — після запису змін вікна
    try {
      await flush();
      const [y, q] = JSON.parse(key);
      at = JSON.stringify([y, q, stateVersion]);
      const r = await fetch(`api/form11?year=${y}&q=${q}`);
      if (!r.ok) throw new Error(await r.text());
      got = await r.json();
    } catch (e) {
      got = { error: String(e.message || e) };
    }
    if (F11.loading !== key) return;
    F11.loading = '';
    Object.assign(F11, { key: at, data: got });
    if (state.view === 'form11') render();
  }
  function renderForm11() {
    const [y, q] = f11Quarter();
    const key = JSON.stringify([y, q, stateVersion]);
    const bar = `<div class="psweek"><button type="button" class="btn" data-act="f11-q" data-v="-1" title="Попередній квартал">‹</button>
      <span class="psweek__label">${F11_ROMAN[q - 1]} кв ${y}</span>
      <button type="button" class="btn" data-act="f11-q" data-v="1" title="Наступний квартал"${
  y * 4 + q - 1 >= f11Now() ? ' disabled' : ''}>›</button></div>`;
    const top = head('звіти / 11/прод', `Звіт про продовольчу тару за ${F11_ROMAN[q - 1]} квартал ${y} року`, bar);
    if (!native) return { head: top, body: '<div class="pad">11/прод складається в програмі на комп’ютері.</div>' };
    const rep = F11.key === key ? F11.data : null;
    if (!rep) {
      if (F11.loading !== key) setTimeout(() => f11Load(key), 0);
      return { head: top, body: '<div class="pad">Збираю звіт з книги СП…</div>' };
    }
    if (rep.error) {                                    // збій тримається в кеші: сам він не повторюється, «Повторити» питає знову
      return { head: top, body: `<div class="callout callout--bad">${esc(rep.error)}</div>
        <div class="pad"><button type="button" class="btn" data-act="f11-retry">Повторити</button></div>` };
    }
    const bad = rep.checks.filter((c) => c.level === '✗').length;
    const panel = `<div class="panel">
        <span class="tag">${fmtDate(rep.from)} – ${fmtDate(rep.to)}</span>${rep.to >= today()
  ? '<span class="tag tag--stock">квартал ще не закінчився</span>' : ''}
        <span class="tag">документів: ${rep.docs.length}</span>
        <span class="tag${bad ? ' tag--out' : ''}">перевірки: ✗ ${bad} · ⚠ ${rep.checks.length - bad}</span>
        <div class="panel__spacer"></div>
        <button type="button" class="btn btn--primary" data-act="f11-make" title="Скласти книгу в теку звітів">Скласти звіт</button>
      </div>`;
    const num = (k, label) => ({ key: `c${k}`, label, cls: 'c-num', sort: (r) => r.c[k], cell: (r) => fmtNum(r.c[k]) });
    const rows = registry({
      id: 'f11', rows: rep.rows, minWidth: '900px', search: (r) => [r.name, r.code], placeholder: 'Назва чи код',
      columns: [
        { key: 'code', label: 'код', cls: 'c-code', sort: (r) => r.code, cell: (r) => esc(r.code) },
        { key: 'name', label: 'найменування', cls: 'c-name c-name--stack', sort: (r) => r.name,
          cell: (r) => `<b>${esc(r.name)}</b><small>${esc(r.uom || 'без одиниці')}</small>` },
        num(4, 'гр.4'), num(5, 'гр.5'), num(6, 'гр.6'), num(8, 'гр.8'), num(9, 'гр.9'), num(10, 'гр.10'),
        num(11, 'гр.11'), num(12, 'гр.12'), num(14, 'гр.14'),
        { key: 'book', label: 'книга СП', cls: 'c-num', sort: (r) => r.book, cell: (r) => (Math.abs(r.c[14] - r.book) > 1e-6
          ? `<span class="num-bad">${fmtNum(r.book)}</span>` : fmtNum(r.book)) },
      ],
      empty: 'Тари в книзі СП немає: позиції групи «Тара» (категорія «Т») заводять у «Сухпай» → «Позиції».',
    });
    regRedraw.set('f11', render);
    const docs = registry({
      id: 'f11d', rows: rep.docs, minWidth: '900px', search: (d) => [d.no, d.paper, d.party, d.place, d.code, d.name],
      placeholder: 'Документ, від кого / кому чи код',
      columns: [
        { key: 'date', label: 'дата', cls: 'c-date', sort: (d) => d.date, cell: (d) => fmtDate(d.date) },
        { key: 'doc', label: 'документ', cls: 'c-name c-name--stack', sort: (d) => d.no, cell: (d) => `<b>${esc(d.paper)} №${
          esc(d.no)}</b><small>${esc(d.party || '—')}${d.place ? ' · ' + esc(d.place) : ''}</small>` },
        { key: 'item', label: 'позиція', cls: 'c-name c-name--stack', sort: (d) => d.name,
          cell: (d) => `<b>${esc(d.name)}</b><small>${esc(d.code)}</small>` },
        { key: 'qty', label: 'кількість', cls: 'c-num', sort: (d) => d.qty,
          cell: (d) => `${fmtNum(d.qty)}<small>${esc(d.uom)}</small>` },
        { key: 'col', label: 'графа', cls: 'c-num', sort: (d) => d.col, cell: (d) => `гр.${d.col}` },
        { key: 'rule', label: 'правило', cls: 'c-txt', sort: (d) => d.rule, cell: (d) => esc(d.rule) },
      ],
      empty: `У ${F11_ROMAN[q - 1]} кварталі ${y} року тара через межу частини не рухалась.`,
    });
    regRedraw.set('f11d', render);
    const checks = rep.checks.length ? `<div class="card" style="margin-top:12px"><div class="card__head">
        <div class="card__title">Перевірки</div></div><div class="pad">${rep.checks.map((c) =>
          `<div class="f2-check"><span class="${c.level === '✗' ? 'num-bad' : ''}">${c.level}</span> ${esc(c.text)}</div>`).join('')}</div></div>` : '';
    return {
      head: top,
      body: `${panel}<div id="form11">${rows.panel}<div class="card card--scroll">${rows.table}</div>
        <div class="subhead"><b>Документи кварталу</b><span>тара через межу частини</span></div>
        ${docs.panel}<div class="card card--scroll">${docs.table}</div>${checks}</div>`,
    };
  }
  /** Дії 11/прод (`f11-…`). */
  function form11Action(act, d) {
    switch (act) {
      case 'f11-q': {
        let [y, q] = f11Quarter();
        q += Number(d.v);
        if (q < 1) { y -= 1; q = 4; }
        if (q > 4) { y += 1; q = 1; }
        state.f11q = [y, q];
        return render();
      }
      case 'f11-retry':
        F11.key = '';                                   // відповідь-помилку забуто: екран збере звіт наново
        return render();
      case 'f11-make': {
        const [y, q] = f11Quarter();
        return toExcel({ kind: 'form11', year: y, q, file: `11прод ${q} квартал ${y}` });
      }
      default: return null;
    }
  }
