// Облік ТЗ ПС · сторінка · звірки з підрозділами.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ------------------------------------------------ звірки з підрозділами
  /** Раз на місяць служба звіряє облік із кожним підрозділом, що тримає майно:
   *  узагальнююча відомість (Додаток 1 до Інструкції з обліку військового
   *  майна) — по кожній партії кількість за фінансовим обліком, за обліком
   *  служби й фактично, — підписи обох сторін і запис у журнал результатів
   *  звірки (Додаток 9). Підписані відомості з бази — лише для читання; ті, що
   *  складені тут, зберігаються разом з іншими внесеними даними. */
  const baseRecon = (D.recon || []).map((r) => ({
    id: 'db' + r[0], base: true, sub: r[1], no: r[2], date: r[3], from: r[4], to: r[5],
    title: r[6], signerPos: r[7], signerName: r[8], chiefPos: r[9], chiefName: r[10],
    result: r[11], decision: r[12], note: r[13], status: r[14], source: r[15],
    lines: (r[16] || []).map((l) => ({ code: l[0], name: l[1], uom: l[2], price: l[3],
      fin: l[4], acc: l[5], fact: l[6], note: l[7] })),
  }));
  const responsible = new Map((D.responsible || []).map((r) => [r[0], { name: r[1], pos: r[2] }]));
  const allRecon = () => baseRecon.concat(store.recon || []);
  const reconById = (id) => allRecon().find((r) => r.id === id);
  const reconOrder = (a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : a.date < b.date ? -1 : 1);
  const reconOf = (sub) => allRecon().filter((r) => r.sub === sub).sort(reconOrder);
  const round3 = (x) => Math.round(x * 1000) / 1000;
  const cleanName = (x) => String(x || '').replace(/[ ,]*\d{9,}\s*$/, '').trim();
  const numOrNull = (x) => (x === '' || x == null || !Number.isFinite(+x) ? null : +x);

  /** Підрозділ у родовому відмінку для шапки відомості. Як підрозділи частини
   *  названо в паперах, каже довідник (D.subTitles: шапка відомості й місце в
   *  описі); склад, батальйони, їхні взводи, їдальні й стрілецькі роти названо за
   *  правилами нижче. Решта лишається як є — у відомості цей рядок можна
   *  виправити, і наступна звірка візьме вже виправлений. */
  const subTitles = new Map((D.subTitles || []).map((r) => [r[0], { title: r[1] || '', where: r[2] || '' }]));
  const BAT_GEN = [[/^(\d+) б ТрО$/, '$1 батальйону територіальної оборони'],
    [/^(\d+) б БпС$/, '$1 батальйону безпілотних систем']];
  const UNIT_GEN = { 'ВМТЗ': 'взводу матеріального забезпечення',
    'ВБпАК': 'взводу безпілотних авіаційних комплексів', 'їдальня': 'їдальні' };
  const SUB_GEN = { 'склад': 'складу продовольчої служби' };
  function unitTitle(sub) {
    const own = (subTitles.get(sub) || {}).title;
    if (own) return own;
    const bat = (x) => { for (const [re, t] of BAT_GEN) if (re.test(x)) return x.replace(re, t); return null; };
    const [a, b] = String(sub).split(' · ');
    if (b) {
      const unit = /^\d+ СР$/.test(b) ? b.replace(/^(\d+) СР$/, '$1 стрілецької роти') : (UNIT_GEN[b] || b);
      return `${unit} ${bat(a) || a}`;
    }
    return bat(a) || SUB_GEN[a] || a;
  }

  /** Той самий день місяцем раніше: період звірки служби — з 25-го по 25-те. */
  function monthBefore(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 2, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(d, last));
    return t.toISOString().slice(0, 10);
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

  /** Рядки відомості з обліку: партії підрозділу на дату. Знищене, ще не
   *  списане, фактично відсутнє — воно віднімається від «фактично» й пояснюється
   *  в примітці (рапорт, акт), як того й вимагає графа 8. */
  function reconLines(sub, date) {
    const out = [];
    for (const [k, arr] of lotsAt(date)) {
      const i = k.indexOf('|');
      if (k.slice(0, i) !== sub) continue;
      const code = k.slice(i + 1);
      if (isSpRp(bookOf(code))) continue;           // сухпай і реторт-пакети — свої книги, не звірка й не опис ТЗ
      const byPrice = new Map();
      for (const l of arr) byPrice.set(l.price, (byPrice.get(l.price) || 0) + l.q);
      const it = itemBy.get(code) || {};
      for (const [price, q] of byPrice) {
        if (Math.abs(q) < 1e-9) continue;
        out.push({ code, name: cleanName(it.name || code), uom: it.unit || '', price,
                   fin: null, acc: round3(q), fact: round3(q), note: '' });
      }
    }
    out.sort((a, b) => a.code.localeCompare(b.code, 'uk', { numeric: true }) || b.price - a.price);
    const gone = allDestroyed().filter((x) => !x.other && x.sub === sub && openAt(x, date));
    for (const code of new Set(gone.map((x) => x.code))) {
      const recs = gone.filter((x) => x.code === code);
      const why = recs.map((x) => `знищено ${fmtNum(x.qty)} од. ${fmtDate(x.date)}`
        + `${x.report ? ', рапорт ' + numNo(x.report) : ''}${x.act ? ', акт ' + numNo(x.act) + ' не проведено' : ', акта немає'}`)
        .join('; ');
      const mine = out.filter((l) => l.code === code);
      const cut = (ln, q) => {
        const t = Math.min(q, Math.max(0, ln.fact));
        if (t > 0) { ln.fact = round3(ln.fact - t); ln.note = why; }
        return t;
      };
      // Знищена одиниця з номером — зі своєї партії; решта — від найдавнішої, як
      // її й спише акт без названої партії. Раніше знищене віднімалося від
      // найдорожчої: відомість і проведений потім акт розходилися в цінах, і
      // наступна звірка показувала нестачу однієї ціни й лишок іншої.
      let left = 0;
      for (const x of recs) {
        const came = x.unit ? unitArrival(x.unit, date, null) : null;
        const ln = came && mine.find((l) => Math.abs(l.price - (+came.price || 0)) < 0.005);
        left = round3(left + (+x.qty || 0) - (ln ? cut(ln, +x.qty || 0) : 0));
      }
      const lots = (lotsAt(date).get(sub + '|' + code) || []).slice()
        .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
      for (const l of lots) {
        if (left <= 1e-9) break;
        const ln = mine.find((x) => Math.abs(x.price - l.price) < 0.005);
        if (ln) left = round3(left - cut(ln, Math.min(left, Math.max(0, l.q))));
      }
      for (const ln of mine) if (left > 1e-9) left = round3(left - cut(ln, left));
    }
    return out;
  }

  const lineDiff = (l) => (l.fin != null && Math.abs(l.fin - l.acc) > 1e-9)
    || (l.fact != null && Math.abs(l.fact - l.acc) > 1e-9);
  function reconResult(r) {
    const diff = r.lines.filter(lineDiff);
    const noFes = r.lines.some((l) => l.fin == null);
    if (!diff.length) return noFes ? 'Розбіжностей з фактичною наявністю немає; з фінансовим обліком не звірено'
      : 'Розбіжностей немає';
    return diff.map((l) => `${l.name}${l.price ? ` (${fmtMoney(l.price)} грн)` : ''}: `
      + `${l.fin != null && Math.abs(l.fin - l.acc) > 1e-9 ? `за ФЕС ${fmtNum(l.fin, '0')}, ` : ''}`
      + `за обліком ${fmtNum(l.acc, '0')}, фактично ${fmtNum(l.fact, '0')}${l.note ? ' — ' + l.note : ''}`)
      .join('; ');
  }

  /** Стан звірки підрозділу: остання відомість і скільки днів минуло. */
  function reconStatus(sub) {
    const list = reconOf(sub);
    const last = list[list.length - 1] || null;
    const days = last ? daysBetween(last.to, today()) : null;
    let kind = 'due';
    if (last && last.status !== 'підписано') kind = 'draft';
    else if (last && days <= 31) kind = 'ok';
    return { last, days, kind };
  }

  /** Підрозділи, з якими звіряються: ті, що на дату тримають майно, і ті, з ким
   *  звірка вже була. Тип вузла не важить: ФЄС теж тримає майно (скажімо,
   *  єврокуб за накладною) і має МВО, а майно на самому вузлі бригади — помилка
   *  документа, яку краще бачити, ніж ховати. */
  function reconSubs(date) {
    const hold = new Map();
    for (const e of ledger) {
      if (e.d > date) break;
      if (isSpRp(bookOf(e.code))) continue;           // сухпай і реторт-пакети — свої книги: підрозділ лише з ними звірки не потребує
      const h = hold.get(e.sub) || { units: 0, codes: new Map() };
      h.units += e.sg * e.q;
      h.codes.set(e.code, (h.codes.get(e.code) || 0) + e.sg * e.q);
      hold.set(e.sub, h);
    }
    const withRecon = new Set(allRecon().map((r) => r.sub));
    return subs
      .map((sb) => {
        const h = hold.get(sb.name);
        const pos = h ? [...h.codes.values()].filter((v) => Math.abs(v) > 1e-9).length : 0;
        return { sub: sb.name, type: sb.type, pos, units: h ? round3(h.units) : 0 };
      })
      .filter((x) => x.pos || withRecon.has(x.sub));
  }
  const reconDue = () => reconSubs(today()).filter((x) => reconStatus(x.sub).kind !== 'ok').length;

  function nextReconNo() {
    const nums = allRecon().map((r) => parseInt(r.no, 10)).filter((n) => Number.isFinite(n));
    return String((nums.length ? Math.max(...nums) : 0) + 1);
  }

  function reconNew(sub, quiet = false) {
    const date = state.reconDate || today();
    const list = reconOf(sub);
    const prev = list[list.length - 1];
    const any = allRecon().slice().sort(reconOrder).pop();
    const resp = responsible.get(sub);
    const title = (prev && prev.title) || unitTitle(sub);
    // Хто підписує — з довідника «МВО й посадовці» на дату відомості: МВО
    // підрозділу й начальник служби. Звання й посада — ті, що були на цю дату.
    const posRank = (p) => { const at = personAt(p, date); return [at.pos, at.rank].filter(Boolean).join(', '); };
    const mvo = mvoAt(sub, date);
    const chief = officialAt('начальник служби', date);
    const r = {
      id: uid(), sub, no: nextReconNo(), date, to: date,
      from: prev && prev.to < date ? prev.to : monthBefore(date),
      title,
      signerPos: (mvo && posRank(mvo)) || (prev && prev.signerPos) || (resp && resp.pos)
        || `Командир ${title} ${unitGen()}`,
      signerName: (mvo && pSign(mvo)) || (prev && prev.signerName) || (resp && resp.name) || '',
      chiefPos: (chief && posRank(chief)) || (any && any.chiefPos)
        || `Начальник продовольчої служби ${unitGen()}`,
      chiefName: (chief && pSign(chief)) || (any && any.chiefName) || D.meta.chief || '',
      lines: likePrev(reconLines(sub, date), prev), result: '', decision: '', note: '',
      status: 'складено', created: today(),
    };
    store.recon = store.recon || [];
    store.recon.push(r);
    logChange('відомість складено', 'recon|' + r.id, `Відомість №${r.no} · ${sub} на ${fmtDate(date)}`);
    save();
    if (quiet) return r;
    state.flash = `Відомість №${r.no} для «${sub}» на ${fmtDate(date)} складено: `
      + `${cnt(r.lines.length, 'рядок', 'рядки', 'рядків')}. Внесіть дані ФЕС у графу «за фінансовим обліком» `
      + 'і перевірте «фактично».';
    go('recon', { reconId: r.id });
    return r;
  }

  /** Назви, одиниці й порядок рядків — як у попередній відомості цього
   *  підрозділу: її вже підписали, і «Кухня КП-130» не має щомісяця
   *  перетворюватися на «Кухня причіпна КП-130 без паспорта». */
  function likePrev(lines, prev) {
    if (!prev || !prev.lines.length) return lines;
    const at = new Map(), byCode = new Map();
    prev.lines.forEach((l, i) => {
      at.set(l.code + '|' + l.price, i);
      if (!byCode.has(l.code)) byCode.set(l.code, i);
    });
    const pos = (l) => {
      const exact = [...at.entries()].find(([k]) => {
        const [c, p] = [k.slice(0, k.lastIndexOf('|')), +k.slice(k.lastIndexOf('|') + 1)];
        return c === l.code && Math.abs(p - l.price) < 0.05;
      });
      return exact ? exact[1] : byCode.has(l.code) ? byCode.get(l.code) + 0.5 : Infinity;
    };
    for (const l of lines) {
      const i = pos(l);
      if (Number.isFinite(i)) {
        const was = prev.lines[Math.floor(i)];
        l.name = was.name || l.name;
        l.uom = was.uom || l.uom;
      }
      l._pos = i;
    }
    return lines.map((l, k) => [l, k]).sort((a, b) => (a[0]._pos - b[0]._pos) || (a[1] - b[1]))
      .map(([l]) => { delete l._pos; return l; });
  }

  function reconOpen(id) { go('recon', { reconId: id }); }

  /** Відомості для всіх підрозділів, з якими на цю дату ще не складено. */
  function reconAll() {
    const date = state.reconDate || today();
    const todo = reconSubs(date).filter((x) => x.pos
      && !reconOf(x.sub).some((r) => r.to === date));
    if (!todo.length) { toast(`На ${fmtDate(date)} відомості вже складено для всіх підрозділів.`); return; }
    if (!confirm(`Скласти відомості на ${fmtDate(date)} для ${cnt(todo.length, 'підрозділу', 'підрозділів', 'підрозділів')}?\n\n`
      + todo.map((x) => '  • ' + x.sub).join('\n'))) return;
    for (const x of todo) reconNew(x.sub, true);
    state.flash = `Складено ${cnt(todo.length, 'відомість', 'відомості', 'відомостей')} на ${fmtDate(date)}.`;
    render();
  }

  const current = () => (state.reconId ? reconById(state.reconId) : null);
  const editable = (r) => r && !r.base && r.status !== 'підписано';

  function reconFill(key) {
    const r = current();
    if (!editable(r)) return;
    if (key === 'fact') {
      const manual = r.lines.filter((l) => l.fact != null && Math.abs(l.fact - l.acc) > 1e-9).length;
      if (manual && !confirm(`У ${cnt(manual, 'рядку', 'рядках', 'рядках')} «фактично» відрізняється від обліку `
        + '(вписане вручну чи знищене без акта). Замінити на облік?')) return;
    }
    for (const l of r.lines) {
      if (key === 'fin' ? l.fin == null : true) l[key] = l.acc;
      if (key === 'fact') delete l.factSet;
    }
    save(); render();
  }

  /** Облік на дату відомості вже не такий, як у її рядках. */
  /** Підписана відомість, під якою облік уже інший: документ заднім числом у
   *  закритий період проведено з відома людини, але підписаний папір від
   *  цього не змінився — його треба переробити або знати, що він застарів. */
  const signedStale = (r) => !!r && r.status === 'підписано' && !r.base && reconStale(r);

  function reconStale(r) {
    if (!r || r.base) return false;
    const sig = (arr) => arr.filter((l) => !l.extra && !l.left).map((l) => l.code + '|' + l.price + '|' + l.acc).sort().join(';');
    return sig(reconLines(r.sub, r.to)) !== sig(r.lines);
  }

  /** Перескласти рядки з обліку, не гублячи того, що вже вписано руками. */
  function reconSync() {
    const r = current();
    if (!editable(r)) return;
    const was = new Map(r.lines.filter((l) => !l.extra).map((l) => [l.code + '|' + l.price, l]));
    const auto = (l) => /^знищено /.test(l.note || '');
    const fresh = reconLines(r.sub, r.to);
    const now = new Set(fresh.map((l) => l.code + '|' + l.price));
    // Рядки, дописані руками, і ті, що з обліку служби пішли, але вже мають
    // цифри ФЕС, «фактично» чи примітку, лишаються: інакше внесене зникало.
    const keep = r.lines.filter((l) => l.extra || (!now.has(l.code + '|' + l.price)
      && (l.fin != null || l.factSet || (l.note && !auto(l)))))
      .map((l) => (l.extra ? l : Object.assign(l, { acc: 0, left: true })));
    r.lines = likePrev(fresh, { lines: r.lines }).map((l) => {
      const old = was.get(l.code + '|' + l.price);
      if (!old) return l;
      // «Фактично», вписане руками, лишається. Підставлене з обліку (дорівнює
      // обліку чи зменшене на знищене) рахується заново: інакше після нових
      // документів відомість показувала б розбіжність, якої немає.
      const manual = old.factSet || (old.fact != null && Math.abs(old.fact - old.acc) > 1e-9 && !auto(old));
      return Object.assign(l, { fin: old.fin },
        manual ? { fact: old.fact, factSet: true } : {},
        old.note && !auto(old) ? { note: old.note } : {});
    }).concat(keep);
    save();
    toast('Рядки відомості оновлено з обліку, внесене вручну збережено.');
    render();
  }

  function reconAutoResult() {
    const r = current();
    if (!editable(r)) return;
    const auto = reconResult(r);
    if (r.result && r.result.trim() && r.result !== auto
      && !confirm('Замінити текст графи 5 переліком розбіжностей?')) return;
    r.result = auto;
    save(); render();
  }

  function reconSign(on) {
    const r = current();
    if (!r || r.base) return;
    if (on) {
      if (reconStale(r) && !confirm('Облік на дату відомості змінився після складання, цифри у відомості застаріли. '
        + 'Позначити підписаною як є?')) return;
      if (r.lines.some((l) => l.fin == null)
        && !confirm('Графа «за фінансовим обліком» заповнена не для всіх рядків. Позначити підписаною все одно?')) return;
      if (!r.result) r.result = reconResult(r);
      // Підпис після виправлення — та сама відомість: дата підпису лишається
      // тією, що була, якщо людина не вкаже іншу.
      let when = today();
      if (r.signedWas) {
        const got = prompt('Дата підпису відомості (РРРР-ММ-ДД):', r.signedWas);
        if (got == null) return;
        when = /^\d{4}-\d{2}-\d{2}$/.test(got.trim()) ? got.trim() : r.signedWas;
      }
      r.status = 'підписано';
      r.signed = when;
    } else {
      // Підписана відомість закриває період: зняти підпис — відкрити його знову.
      if (!confirm(`Зняти підпис з відомості №${r.no || '—'} «${r.sub}» на ${fmtDate(r.to)}?\n\n`
        + 'Документи до цієї дати знову проводитимуться без попередження про закритий період.')) return;
      r.status = 'складено';
      r.signedWas = r.signed || r.signedWas || '';
      r.signed = '';
    }
    logChange(on ? 'звірку підписано' : 'підпис знято', 'recon|' + r.id,
      `Відомість №${r.no || '—'} · ${r.sub} на ${fmtDate(r.to)}`);
    save();
    toast(on ? `Відомість №${r.no} позначено підписаною.`
      : `З відомості №${r.no} знято підпис.`);
    render();
  }

  function reconDelete() {
    const r = current();
    if (!r || r.base) return;
    if (r.status === 'підписано') {
      alert('Підписану відомість видалити не можна. Спершу зніміть підпис.');
      return;
    }
    if (!confirm(`Видалити відомість №${r.no} «${r.sub}» на ${fmtDate(r.to)}?`)) return;
    store.recon = store.recon.filter((x) => x.id !== r.id);
    state.reconId = null;
    logChange('відомість видалено', 'recon|' + r.id, `Відомість №${r.no || '—'} · ${r.sub} на ${fmtDate(r.to)}`);
    save(true, true);
    toast(`Відомість №${r.no} видалено.`);
    go('recon');
  }

  // ------------------------------------------------ вивантаження звірок
  const reconSpec = (r) => ({
    sub: r.sub, sheet: r.sub, no: r.no, date: r.date, from: r.from, to: r.to, title: r.title,
    lines: r.lines.map((l) => ({ name: l.name, uom: l.uom, price: l.price, fin: l.fin,
      acc: l.acc, fact: l.fact, note: l.note })),
    signer_pos: r.signerPos, signer_name: r.signerName, chief_pos: r.chiefPos, chief_name: r.chiefName,
    unit: unitCode(), legal_name: unitInfo().legalName,
  });
  function reconExcel(list, file) {
    list = list.filter(Boolean);
    if (!list.length) return;
    const one = list[0];
    return toExcel({ kind: 'recon', statements: list.map(reconSpec),
      file: file || `Узагальнююча відомість ${one.no ? '№' + one.no + ' ' : ''}${one.sub} на ${one.to}` });
  }
  function reconExcelDate() {
    const date = state.reconDate || today();
    // Аркуші — у порядку дерева підрозділів, як на екрані: склад, роти, батальйони.
    const order = new Map(subs.map((sb, i) => [sb.name, i]));
    const list = allRecon().filter((r) => r.to === date)
      .sort((a, b) => (order.get(a.sub) ?? 1e9) - (order.get(b.sub) ?? 1e9));
    if (!list.length) {
      toast(`На ${fmtDate(date)} відомостей ще не складено.`, true);
      return;
    }
    return reconExcel(list, `Узагальнюючі відомості на ${date} (${list.length})`);
  }
  function reconJournalExcel() {
    const rows = allRecon().slice().sort(reconOrder).map((r) => [
      r.date, [r.chiefPos, r.chiefName].filter(Boolean).join(' '), r.sub,
      [r.signerPos, r.signerName].filter(Boolean).join(' '), r.result || reconResult(r),
      r.decision || '', [r.no ? `відомість №${r.no}` : '',
        r.status === 'підписано' ? '' : 'не підписано', r.note].filter(Boolean).join('; ')]);
    if (!rows.length) { toast('Журнал звірок порожній.', true); return; }
    return toExcel({ kind: 'recon-journal', service: 'продовольча служба', unit: unitCode(), rows,
      file: `Журнал результатів звірки ${unitCode() || unitInfo().legalName}` });
  }

  // ------------------------------------------------ екран звірок
  const RECON_KIND = { ok: ['tag--in', 'звірено'], draft: ['tag--mv', 'не підписано'], due: ['tag--out', 'не звірено'] };

  function renderRecon() {
    if (state.reconId) {
      const r = current();
      if (r) return renderReconEdit(r);
      state.reconId = null;
    }
    const date = state.reconDate || today();
    const holders = reconSubs(date);
    const stOf = (x) => reconStatus(x.sub);
    const diffsOf = (x) => { const l = stOf(x).last; return l ? l.lines.filter(lineDiff).length : 0; };
    const due = holders.filter((x) => stOf(x).kind !== 'ok').length;
    const subReg = registry({
      id: 'recon', rows: holders, minWidth: '1000px', placeholder: 'Пошук: підрозділ',
      search: (x) => [x.sub, x.type || ''],
      filters: [
        { type: 'seg', key: 'kind', options: [['', 'усі'], ['due', 'не звірено'], ['draft', 'не підписано'], ['ok', 'звірено']],
          test: (x, v) => stOf(x).kind === v },
      ],
      columns: [
        { key: 'sub', label: 'підрозділ', cls: 'c-name', first: 1, sort: (x) => x.sub,
          cell: (x) => `<b>${esc(x.sub)}</b><small>${esc(x.type)}</small>` },
        { key: 'pos', label: 'позицій', cls: 'c-num', sort: (x) => x.pos, cell: (x) => String(x.pos) },
        { key: 'units', label: 'одиниць', cls: 'c-num', sort: (x) => x.units, cell: (x) => fmtNum(x.units, '0') },
        { key: 'days', label: 'остання звірка', cls: 'c-txt', style: 'flex:1.2 1 0',
          sort: (x) => (stOf(x).last ? stOf(x).days : 1e9),
          cell: (x) => { const t = stOf(x); return t.last ? `${t.last.no ? `№${esc(t.last.no)} ` : ''}на ${fmtDate(t.last.to)}, ${cnt(t.days, 'день', 'дні', 'днів')} тому` : 'не було'; } },
        { key: 'diffs', label: 'розбіжностей', cls: 'c-num', style: 'width:104px', sort: diffsOf,
          cellCls: (x) => (diffsOf(x) ? 'num-bad' : 'c-num--dim'), cell: (x) => String(diffsOf(x) || '—') },
        { key: 'kind', label: 'стан', cls: 'c-tag', style: 'width:120px', first: 1, sort: (x) => RECON_KIND[stOf(x).kind][1],
          cell: (x) => { const [cls, lbl] = RECON_KIND[stOf(x).kind]; return `<span class="tag ${cls}">${lbl}</span>`; } },
        { key: 'acts', label: '', cls: 'c-acts', style: 'flex-basis:190px', cell: (x) => {
          const last = stOf(x).last;
          const onDate = reconOf(x.sub).find((r) => r.to === date);
          return `${onDate ? `<button type="button" class="btn btn--sm" data-act="rc-open" data-id="${esc(onDate.id)}">Відкрити</button>`
            : x.pos ? `<button type="button" class="btn btn--sm btn--primary" data-act="rc-new" data-sub="${esc(x.sub)}">Скласти відомість</button>` : ''}${
            last ? `<button type="button" class="ico-btn" data-act="rc-xls" data-id="${esc(last.id)}" title="Остання відомість в Excel">⤓</button>` : ''}`;
        } },
      ],
      row: (x) => {
        const last = stOf(x).last;
        return { cls: stOf(x).kind === 'ok' ? '' : 'is-due', attrs: last ? `data-act="rc-open" data-id="${esc(last.id)}"` : '' };
      },
      count: (shown, all) => `${shown.length === all.length ? cnt(all.length, 'підрозділ', 'підрозділи', 'підрозділів')
        : `${shown.length} із ${all.length}`} · не звірено ${due}`,
      empty: 'На цю дату майно не числиться ні за одним підрозділом.',
    });

    const journalRows = allRecon().slice().sort(reconOrder).reverse();
    const signer = (r) => [r.signerPos, r.signerName].filter(Boolean).join(', ');
    const result = (r) => r.result || reconResult(r);
    const jSubs = [...new Set(journalRows.map((r) => r.sub))]
      .sort((a, b) => (subBy.get(a)?.order ?? 999) - (subBy.get(b)?.order ?? 999));
    const jReg = registry({
      id: 'rcj', rows: journalRows, minWidth: '1000px', panelCls: 'panel--inset', limit: REG_LIMIT,
      placeholder: 'Пошук: номер, підрозділ, підписант',
      search: (r) => [r.no || '', r.sub, signer(r), result(r)],
      filters: [
        { type: 'select', key: 'sub', label: 'підрозділ', all: 'усі', options: jSubs.map((x) => [x, x]), test: (r, v) => r.sub === v },
        { type: 'seg', key: 'st', options: [['', 'усі'], ['draft', 'не підписано'], ['signed', 'підписано']],
          test: (r, v) => (v === 'signed') === (r.status === 'підписано') },
        { type: 'period', key: 'd', label: 'дата', get: (r) => r.date },
      ],
      columns: [
        { key: 'date', label: 'дата', cls: 'c-date', sort: (r) => r.date || '', cell: (r) => fmtDate(r.date) },
        { key: 'no', label: '№', cls: 'c-code', style: 'width:60px', first: 1, sort: (r) => r.no || '', cell: (r) => esc(r.no || '—') },
        { key: 'sub', label: 'підрозділ', cls: 'c-txt', style: 'flex:0 1 190px', first: 1, sort: (r) => r.sub, cell: (r) => `<b>${esc(r.sub)}</b>` },
        { key: 'signer', label: 'з ким звірено', cls: 'c-txt', first: 1, sort: signer, cell: (r) => esc(signer(r)) },
        { key: 'result', label: 'результат', cls: 'c-txt', style: 'flex:1.4 1 0', first: 1, sort: result, cellTitle: result, cell: (r) => esc(result(r)) },
        { key: 'status', label: 'стан', cls: 'c-tag', style: 'width:120px', first: 1,
          title: 'Підписана відомість, під якою облік змінився (документ заднім числом), позначена: цифри в ній уже не ті',
          sort: (r) => `${r.status}|${signedStale(r) ? 0 : 1}`,
          cell: (r) => `<span class="tag ${r.status === 'підписано' ? 'tag--in' : 'tag--mv'}">${esc(r.status)}</span>${
            signedStale(r) ? '<small class="num-bad">облік змінився</small>' : ''}` },
      ],
      row: (r) => ({ attrs: `data-act="rc-open" data-id="${esc(r.id)}"` }),
      count: (shown, all) => (shown.length === all.length ? cnt(all.length, 'відомість', 'відомості', 'відомостей') : `${shown.length} із ${all.length}`),
      empty: 'Звірок ще не було.',
    });
    return {
      head: head('техзасоби / контроль', 'Звірки з підрозділами', `
        <label class="chip is-on"><span class="chip__label">станом на</span>
          <input id="rc-date" type="date" value="${esc(date)}"></label>
        <button class="btn" data-act="rc-journal" title="Додаток 9 в Excel">Журнал звірок</button>
        <button class="btn" data-act="rc-all-xls">Відомості в Excel</button>
        <button class="btn btn--primary" data-act="rc-all">Скласти для всіх</button>`),
      body: `${flashBlock()}
      ${subReg.panel}
      <div class="card" style="margin-bottom:12px"><div class="card--scroll">${subReg.table}</div></div>
      <div class="card"><div class="card__head"><div class="card__title">Журнал результатів звірки</div></div>
        ${jReg.panel}<div class="card--scroll">${jReg.table}</div></div>`,
    };
  }

  function renderReconEdit(r) {
    const ro = !editable(r);
    const dis = ro ? ' disabled' : '';
    const fresh = !r.base ? reconLines(r.sub, r.to) : null;
    // Порядок рядків свій (як у минулій відомості), тож порівнюємо набір партій;
    // рядки, дописані руками (лише у ФЕС, лишки), в обліку служби й не мають бути.
    const sig = (arr) => arr.filter((l) => !l.extra && !l.left).map((l) => l.code + '|' + l.price + '|' + l.acc).sort().join(';');
    const changed = fresh && !ro && sig(fresh) !== sig(r.lines);
    const tot = (k) => r.lines.reduce((a, l) => a + (l[k] == null ? 0 : +l[k]), 0);
    const value = r.lines.reduce((a, l) => a + (+l.price || 0) * (+l.acc || 0), 0);
    const cell = (i, k, v) => `<input class="rc-in" data-rl="${i}" data-k="${k}" value="${esc(v == null ? '' : v)}"${dis}
      inputmode="decimal" autocomplete="off">`;
    const text = (i, k, v, ph) => `<input class="rc-in rc-in--wide" data-rl="${i}" data-k="${k}" value="${esc(v || '')}"${dis}
      placeholder="${esc(ph)}" autocomplete="off">`;
    const lines = r.lines.map((l, i) => `<div class="tbl__row tbl__row--plain${lineDiff(l) ? ' is-diff' : ''}" data-line="${i}">
        <div class="c-num c-num--dim" style="width:40px">${i + 1}</div>
        ${l.extra && !ro ? `<div class="c-name">${text(i, 'name', l.name, 'найменування як у ФЕС')}${text(i, 'code', l.code, 'код, якщо є')}</div>
        <div class="c-unit">${text(i, 'uom', l.uom, 'од.')}</div>
        <div class="c-num c-num--wide">${cell(i, 'price', l.price || '')}</div>`
        : `<div class="c-name"><b title="${esc(l.name)}">${esc(l.name)}</b><small>${esc([l.code || '', l.extra ? 'дописано' : '',
          l.left ? 'в обліку служби вже немає' : ''].filter(Boolean).join(' · '))}</small></div>
        <div class="c-unit">${esc(l.uom || '')}</div>
        <div class="c-num c-num--wide">${l.price ? fmtMoney(l.price) : '—'}</div>`}
        <div class="c-num c-num--input">${cell(i, 'fin', l.fin)}</div>
        <div class="c-num">${fmtNum(l.acc, '0')}</div>
        <div class="c-num c-num--input">${cell(i, 'fact', l.fact)}</div>
        <div class="c-txt rc-note">${ro ? esc(l.note || '') : `<input class="rc-in rc-in--wide" data-rl="${i}" data-k="note" value="${esc(l.note || '')}" placeholder="причина розбіжності, документи для списання">`}${
          (l.extra || l.left) && !ro ? rowBtn('rc-line-del', '✕ Прибрати', `data-i="${i}"`, { bad: true, title: 'Прибрати рядок із відомості' }) : ''}</div>
      </div>`).join('');
    const field = (k, label, v, span, type = 'text') => `<div class="field${span ? ' field--span2' : ''}"><label>${label}</label>
      <input data-rf="${k}" type="${type}" value="${esc(v || '')}"${dis}></div>`;
    // Графи 6 і 7 (рішення начальника, примітки) дописують і після підпису, і в
    // підписаних відомостях із бази: рішення приймають уже за підписаною.
    const area = (k, label, v, ph) => `<div class="field field--span2"><label>${label}</label>
      <textarea data-rf="${k}" placeholder="${esc(ph)}"${k === 'decision' || k === 'note' ? '' : dis}>${esc(v || '')}</textarea></div>`;
    return {
      head: head(`звірки / ${r.sub}`, `Узагальнююча відомість${r.no ? ' № ' + r.no : ''} · ${r.sub}`, `
        <button class="btn" data-act="rc-back">← До звірок</button>
        <button class="btn" data-act="rc-print">В Excel</button>${native ? `
        <button class="btn" data-act="scan-add" title="Додати скан підписаної відомості">+ Скан</button>` : ''}${r.base ? '' : r.status === 'підписано'
        ? '<button class="btn" data-act="rc-unsign">Зняти підпис</button>'
        : '<button class="btn btn--primary" data-act="rc-sign">Підписано ✓</button>'}${r.base || r.status === 'підписано' ? ''
        : '<button class="btn btn--danger" data-act="rc-del">Видалити</button>'}`),
      body: `${flashBlock()}
      ${r.base ? `<div class="flash flash--info">Підписана відомість із бази обліку${r.source ? ` (файл «${esc(r.source)}»)` : ''}. Лише для читання.</div>` : ''}
      ${signedStale(r) ? `<div class="flash flash--warn">Після підпису облік на ${fmtDate(r.to)} змінився (документ заднім числом): цифри у відомості вже не збігаються з обліком. Зніміть підпис і перескладіть або лишіть як є свідомо.</div>` : ''}
      ${filesOf('recon|' + r.id).length || r.status === 'підписано'
        ? filesCard('recon|' + r.id, 'Скан підписаної відомості', 'підшийте скан після підпису') : ''}
      ${changed ? `<div class="flash flash--warn">Облік «${esc(r.sub)}» на ${fmtDate(r.to)} не збігається з відомістю.
        <button class="btn btn--sm" data-act="rc-sync">Оновити з обліку</button></div>` : ''}
      ${reconDiffPanel(r)}
      <div class="tiles">
        <div class="tile"><div class="tile__label">Рядків</div><div class="tile__value">${r.lines.length}</div>
          <div class="tile__hint">партій на ${fmtDate(r.to)}</div></div>
        <div class="tile"><div class="tile__label">За обліком служби</div><div class="tile__value">${fmtNum(tot('acc'), '0')}</div>
          <div class="tile__hint">${fmtMoney(value)} грн</div></div>
        <div class="tile"><div class="tile__label">Фактично</div><div class="tile__value" id="rc-fact">${fmtNum(tot('fact'), '0')}</div>
          <div class="tile__hint">за ФЕС: <span id="rc-fin">${r.lines.some((l) => l.fin != null) ? fmtNum(tot('fin'), '0') : 'не заповнено'}</span></div></div>
        <div class="tile"><div class="tile__label">Розбіжностей</div>
          <div class="tile__value ${r.lines.some(lineDiff) ? 'num-bad' : ''}" id="rc-diff">${r.lines.filter(lineDiff).length}</div>
          <div class="tile__hint">${esc(r.status)}${r.signed ? ' ' + fmtDate(r.signed) : ''}</div></div>
      </div>
      <form class="card form" id="rc-form" style="margin-bottom:12px" onsubmit="return false">
        <div class="card__head"><div class="card__title">Шапка й підписи</div></div>
        <div class="form__grid">
          ${field('no', 'Номер відомості', r.no)}
          ${field('date', 'Дата складання', r.date, false, 'date')}
          ${field('from', 'Період з', r.from, false, 'date')}
          ${field('to', 'Період по', r.to, false, 'date')}
          ${field('title', 'Підрозділ у шапці (родовий відмінок)', r.title, true)}
          ${field('signerPos', 'З ким звіряємо: посада', r.signerPos, true)}
          ${field('signerName', 'Ім\u2019я ПРІЗВИЩЕ', r.signerName)}
          ${field('chiefPos', 'Хто звіряє: посада', r.chiefPos, true)}
          ${field('chiefName', 'Ім\u2019я ПРІЗВИЩЕ', r.chiefName)}
        </div>
      </form>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Військове майно</div>
          <div class="panel__spacer"></div>${ro ? '' : `
          <button class="btn btn--sm" data-act="rc-line-add" title="Позиція, що є у ФЕС чи фактично, але не в обліку служби">+ Рядок</button>
          <button class="btn btn--sm" data-act="rc-fin" title="Заповнити лише порожні клітинки">ФЕС = облік служби</button>
          <button class="btn btn--sm" data-act="rc-fact" title="Перезаписати всю графу">Фактично = облік</button>`}</div>
        <div class="card--scroll"><div class="tbl" style="--tbl-min:1100px">
          <div class="tbl__head">
            <div class="tbl__h c-num" style="width:40px">№</div><div class="tbl__h c-name">найменування</div>
            <div class="tbl__h c-unit">од.</div><div class="tbl__h c-num c-num--wide">ціна, грн</div>
            <div class="tbl__h c-num c-num--input">за фін. обліком</div><div class="tbl__h c-num">за обліком служби</div>
            <div class="tbl__h c-num c-num--input">фактично</div><div class="tbl__h c-txt rc-note">примітки</div>
          </div>${lines || '<div class="tbl__row tbl__row--plain"><div class="c-txt">На цю дату майно за підрозділом не числиться.</div></div>'}
        </div></div></div>
      <form class="card form" id="rc-form2" onsubmit="return false">
        <div class="card__head"><div class="card__title">Запис у журнал результатів звірки</div>
          <div class="panel__spacer"></div>${ro ? '' : '<button class="btn btn--sm" data-act="rc-result">Результати за розбіжностями</button>'}</div>
        <div class="form__grid">
          ${area('result', 'Результати проведеної звірки (графа 5)', r.result, reconResult(r))}
          ${area('decision', 'Рішення начальника (графа 6)', r.decision, 'заходи з усунення розбіжностей')}
          ${area('note', 'Примітки (графа 7)', r.note, '')}
        </div>
      </form>`,
    };
  }

  /** Поля відомості пишуться одразу, без перемальовування — інакше курсор
   *  злітав би на кожній цифрі. Підсумки й підсвітка оновлюються на місці. */
  function bindRecon() {
    const dateEl = $('#rc-date');
    if (dateEl) dateEl.addEventListener('change', () => { state.reconDate = dateEl.value || today(); render(); });
    const r = current();
    if (r && !editable(r)) {
      const keep = debounce(() => save(), 400);
      document.querySelectorAll('[data-rf="decision"], [data-rf="note"]').forEach((el) => {
        el.addEventListener('input', () => {
          r[el.dataset.rf] = el.value;
          // Відомість із бази: графи 6 і 7 ідуть у її ж запис.
          if (r.base) {
            store.reconBase = store.reconBase || {};
            store.reconBase[String(r.id).replace(/^db/, '')] = { decision: r.decision || '', note: r.note || '' };
          }
          keep();
        });
        el.addEventListener('change', () => logChange('відомість доповнено', 'recon|' + r.id,
          `Відомість №${r.no || '—'} · ${r.sub}: ${el.dataset.rf === 'decision' ? 'рішення начальника' : 'примітки'}`));
      });
      return;
    }
    if (!r) return;
    const touch = debounce(() => save(), 400);
    const totals = () => {
      const tot = (k) => r.lines.reduce((a, l) => a + (l[k] == null ? 0 : +l[k]), 0);
      const f = $('#rc-fact'); if (f) f.textContent = fmtNum(tot('fact'), '0');
      const fin = $('#rc-fin'); if (fin) fin.textContent = r.lines.some((l) => l.fin != null) ? fmtNum(tot('fin'), '0') : 'не заповнено';
      const dEl = $('#rc-diff');
      if (dEl) { const n = r.lines.filter(lineDiff).length; dEl.textContent = n; dEl.classList.toggle('num-bad', n > 0); }
    };
    document.querySelectorAll('[data-rf]').forEach((el) => {
      el.addEventListener('input', () => { r[el.dataset.rf] = el.value; touch(); });
      // Інша дата «станом на» — інший облік: перемальовуємо, щоб з'явилась
      // пропозиція оновити рядки.
      if (el.dataset.rf === 'to') el.addEventListener('change', () => { save(); render(); });
    });
    const cells = [...document.querySelectorAll('.rc-in')];
    cells.forEach((el) => {
      el.addEventListener('input', () => {
        const l = r.lines[+el.dataset.rl];
        const k = el.dataset.k;
        if (['note', 'name', 'code', 'uom'].includes(k)) l[k] = el.value;
        else if (k === 'price') l.price = numOrNull(el.value.replace(',', '.')) || 0;
        else l[k] = numOrNull(el.value.replace(',', '.'));
        if (el.dataset.k === 'fact') l.factSet = true;           // вписано руками — оновлення з обліку не чіпає
        el.closest('.tbl__row').classList.toggle('is-diff', lineDiff(l));
        totals();
        touch();
      });
      // Enter — та сама графа наступного рядка: відомість заповнюють стовпчиком.
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const next = cells.find((c) => c.dataset.k === el.dataset.k && +c.dataset.rl === +el.dataset.rl + 1);
        if (next) { next.focus(); next.select(); }
      });
    });
  }
