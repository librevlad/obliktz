// Облік ТЗ ПС · сторінка · інвентаризація.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ============================================================ ІНВЕНТАРИЗАЦІЯ
  /** Інвентаризація — окрема подія: наказ, комісія, дати, описи й акт, скани.
   *  Описи складаються з обліку на дату — по кожному підрозділу, що тримає майно,
   *  окремо необоротні активи й запаси (форма наказу Мінфіну від 17.06.2015 №572).
   *  «Фактично» за замовчуванням — облік мінус знищене, ще не списане; комісія
   *  виправляє там, де порахувала інакше, і розбіжності йдуть в акт. */
  const ACC_FIXED = '1116 «Необоротні матеріальні активи спеціального призначення», 1016 «Інструменти, '
    + 'прилади, інвентар», 1113 «Малоцінні необоротні матеріальні активи», 1014 «Машини та обладнання»';
  // Субрахунок 1511 «Продукти харчування» — в описах продуктів, не техзасобів (власник, 01.10.2026).
  const ACC_STOCK = '1812 «Малоцінні та швидкозношувані предмети», 1516 «Тара»';
  const ST_KINDS = ['щорічна', 'позапланова', 'чергова'];
  const ST_GEN = { 'щорічна': 'щорічної', 'позапланова': 'позапланової', 'чергова': 'чергової' };
  const ST_FINDINGS = [
    '- оперативний облік у службі ведеться згідно з вимогами наказу Міністерства оборони України від 17.08.2017 № 440;',
    '- звірка облікових даних продовольчої служби тилу логістики зі складським та бухгалтерським обліком проводиться своєчасно;',
    '- фактична наявність військового майна відповідає даним бухгалтерського обліку та первинним документам;',
    '- збереження матеріальних цінностей служби забезпечено у відповідності з вимогами керівних документів щодо порядку їх зберігання.',
  ].join('\n');
  const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня',
    'вересня', 'жовтня', 'листопада', 'грудня'];
  const dayMonth = (iso) => (iso ? `${+iso.slice(8, 10)} ${MONTHS_GEN[+iso.slice(5, 7) - 1]}` : '___ ________');
  const dateWords = (iso) => (iso ? `${dayMonth(iso)} ${iso.slice(0, 4)} року` : '___ ________ 20__ року');
  const dateShort = (iso) => (iso ? `${dayMonth(iso)} ${iso.slice(0, 4)}р.` : '___ ________ 20__р.');
  const quoteDate = (iso) => (iso ? `«${+iso.slice(8, 10)}» ${MONTHS_GEN[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)} року`
    : '«___» ________ 20__ року');
  const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
  const round2 = (x) => Math.round(x * 100) / 100;

  // Хто затвердив і підписав, МВО описів — як записано в паперах самої
  // інвентаризації; чого там немає, підставить довідник на дату.
  const bIds = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, 'b' + v]));
  const baseInv = (D.inventories || []).map((x) => Object.assign({}, x, { base: true,
    head: x.head != null ? 'b' + x.head : '', members: (x.members || []).map((m) => 'b' + m),
    sign: bIds(x.sign), mvo: bIds(x.mvo), scope: x.scope || [], remark: x.note || '',
    where: {}, fact: {}, note: {}, status: 'завершено' }));
  // Папери інвентаризації з бази — у тому ж переліку файлів, що й підшиті в програмі.
  for (const x of baseInv) {
    for (const f of (x.files || [])) {
      const k = 'st|' + x.id;
      if (!scans.has(k)) scans.set(k, []);
      scans.get(k).push({ file: f[0], path: f[1], mime: f[2], size: f[3], kind: f[4], note: f[5] });
    }
  }
  /** «3 б ТрО» або «4 б ТрО, 2 б БпС і ще 9» — охоплення коротко. */
  const scopeShort = (sc) => (sc.length <= 3 ? sc.join(', ') : `${sc.slice(0, 2).join(', ')} і ще ${sc.length - 2}`);
  const inScope = (inv, sub) => !(inv.scope || []).length || inv.scope.some((t) => t === sub || inSubtree(t, sub));
  const allInv = () => baseInv.concat(store.inventories || []).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const invById = (id) => allInv().find((x) => x.id === id) || null;
  const stReadonly = (inv) => !inv || inv.base || inv.status === 'завершено';

  function stNew(from = null) {
    peopleInit();
    const t = today();
    const y = t.slice(0, 4);
    const date = t <= `${y}-12-25` ? `${y}-12-25` : t;
    // «На основі цієї» — саме цієї: склад комісії й тексти беруться з неї, а не з
    // останньої за датою.
    const prev = from && from.date < date ? from : allInv().filter((x) => x.date < date).pop();
    const inv = {
      id: uid(), kind: 'щорічна', date, start: `${y}-11-01` <= date ? `${y}-11-01` : date, end: date,
      orderNo: '', orderDate: '', prevDate: prev ? prev.date : '',
      head: prev ? prev.head || '' : '', members: prev ? (prev.members || []).slice() : [],
      sign: {}, mvo: {}, where: Object.assign({}, (prev && prev.where) || {}), fact: {}, note: {},
      accFixed: (prev && prev.accFixed) || ACC_FIXED, accStock: (prev && prev.accStock) || ACC_STOCK,
      findings: (prev && prev.findings) || ST_FINDINGS, status: 'чернетка', created: t,
    };
    store.inventories = store.inventories || [];
    store.inventories.push(inv);
    save();
    // Перша інвентаризація попередньої не має: про перенесений склад комісії їй казати нічого.
    state.flash = `Інвентаризацію станом на ${fmtDate(date)} заведено. ` + (prev
      ? `Склад комісії перенесено з попередньої (${fmtDate(prev.date)}). Перевірте склад і впишіть номер та дату наказу.`
      : 'Впишіть номер і дату наказу та склад комісії.');
    go('stocktake', { stId: inv.id, stSub: '' });
  }

  /** Підписанти: вказані в самій інвентаризації або посадовці з довідника на дату. */
  function stSigners(inv) {
    const pick = (k, role) => personBy((inv.sign || {})[k]) || officialAt(role, inv.date);
    return { chief: pick('chief', 'начальник служби'), buh: pick('buh', 'бухгалтер'),
      cmd: pick('cmd', 'командир'), nachlog: pick('nachlog', 'начальник логістики'),
      // Голову інвентаризаційної комісії частини називає наказ: довідник такої посади не веде.
      chair: personBy((inv.sign || {}).chair), fes: pick('fes', 'начальник ФЕС') };
  }
  const stMvo = (inv, sub) => personBy((inv.mvo || {})[sub]) || mvoAt(sub, inv.date);
  /** Командир підрозділу для опису: названий у самій інвентаризації або з довідника на дату. */
  const stCmdr = (inv, sub) => personBy((inv.cmdr || {})[sub]) || cmdrFor(sub, inv.date);
  /** «майор ПЕТРЕНКО Т. Г.» — член комісії в плані й протоколі. */
  const stMember = (p, date) => (p ? [personAt(p, date).rank, pShort(p)].filter(Boolean).join(' ') : '');
  const ST_SERVICE = 'продовольчої служби тилу логістики';

  /** Де зберігається майно — у тексті опису («та зберігаються: …»): правка в
   *  самому описі, місце з довідника (як і шапка відомості) або за правилами. */
  const WHERE_TOP = { 'склад': 'на продовольчому складі господарчого взводу роти матеріального забезпечення' };
  function stWhere(inv, sub) {
    if (inv.where && inv.where[sub]) return inv.where[sub];
    const [a, b] = String(sub).split(' · ');
    const place = (subTitles.get(sub) || {}).where
      || (b ? `в ${b === 'їдальня' ? 'їдальні' : b} ${a}` : (WHERE_TOP[a] || `в ${a}`));
    return `${place} ${unitGen()}`;
  }

  /** Рядки описів з обліку: партії підрозділу на дату, а одиниця із заводським номером чи
   *  номером шасі — своїм рядком на одну штуку: опис називає її номер, і комісія звіряє
   *  саме її. Знищене за рапортом віднімається спершу від названих у рапортах одиниць. */
  function stSource(sub, date, registry = false) {
    const out = [];
    const goneUnits = destroyedUnitsAt(sub, date);
    const placed = new Set();
    for (const l of reconLines(sub, date)) {
      const units = unitsAt(l.code, sub, date).filter((u) => Math.abs(u.price - l.price) < 0.005)
        .map((u) => unitBy.get(String(u.id))).filter((u) => u && (u.serial || u.chassis));
      // Одиниця, якої документи не називали: де вона, каже закріплення її інвентарного номера.
      if (registry) {
        for (const u of unitsOf.get(l.code) || []) {
          if (units.length + 1 > l.acc + 1e-9) break;
          if (!(u.serial || u.chassis) || placed.has(u.id) || unitMoves().has(String(u.id)) || invHolder(u) !== sub) continue;
          placed.add(u.id);
          units.push(u);
        }
      }
      if (!units.length || units.length > l.acc + 1e-9) { out.push(l); continue; }
      let gone = round3(l.acc - l.fact);
      const rows = units.map((u) => {
        const lost = gone > 1e-9 && goneUnits.has(String(u.id));
        if (lost) gone = round3(gone - 1);
        return { u, fact: lost ? 0 : 1 };
      });
      const bulk = round3(l.acc - units.length);
      const bulkGone = Math.min(bulk, Math.max(0, gone));
      gone = round3(gone - bulkGone);
      for (let i = rows.length - 1; i >= 0 && gone > 1e-9; i--) {
        if (rows[i].fact) { rows[i].fact = 0; gone = round3(gone - 1); }
      }
      for (const { u, fact } of rows) {
        out.push(Object.assign({}, l, { acc: 1, fact, note: fact ? '' : l.note, unit: String(u.id),
          serial: u.serial || '', chassis: u.chassis || '', year: u.year || '' }));
      }
      if (bulk > 1e-9) {
        out.push(Object.assign({}, l, { acc: bulk, fact: round3(bulk - bulkGone), note: bulkGone > 1e-9 ? l.note : '' }));
      }
    }
    return out;
  }

  /** За ким закріплено інвентарний номер одиниці («10109/012» — у діапазоні підрозділу). */
  function invHolder(u) {
    const seq = +String(u.inv || '').split('/')[1];
    if (!seq) return '';
    return (inventory.find((r) => r.code === u.code && r.from <= seq && seq <= r.to) || {}).sub || '';
  }

  /** Рядки описів підрозділу: партії на дату, «фактично» — з поправками комісії. Опис з бази
   *  (минулих років) складається лише з документів: закріплення номерів — нинішнє. */
  function stLines(inv, sub) {
    const src = inv.frozen ? (inv.frozen.lines || {})[sub] || [] : stSource(sub, inv.date, !inv.base);
    return src.map((l) => {
      const it = itemBy.get(l.code) || {};
      const key = `${sub}|${l.code}|${l.price}${l.unit ? '|u' + l.unit : ''}`;
      const fact = inv.fact && inv.fact[key] != null ? +inv.fact[key] : l.fact;
      const note = inv.note && inv.note[key] != null ? inv.note[key] : l.note;
      const one = l.unit ? l : it;                    // одиниця рядка або єдина одиниця позиції
      return { key, code: l.code, name: l.name, uom: l.uom, price: l.price, acc: l.acc, def: l.fact, fact, note,
        fixed: !!it.nonrev, unit: l.unit || '', fes: it.fes || '',
        serial: one.serial || '', chassis: one.chassis || '', year: one.year || '' };
    });
  }
  /** Заводський номер рядка, а без нього — номер шасі: графа «заводський» опису. */
  const stSerial = (l) => l.serial || (l.chassis ? 'шасі ' + l.chassis : '');
  const stSubs = (inv) => (inv.frozen ? (inv.frozen.subs || []).slice()
    : reconSubs(inv.date).filter((x) => x.pos).map((x) => x.sub).filter((sub) => inScope(inv, sub)));
  /** Інші місця плану — майно служби поза обліком програми (продукти, вода): назва, МВО й вид
   *  майна вписані руками. Рядок без назви місця ще порожній: у папери й підрахунки не йде. */
  const stPlaces = (inv) => (inv.places || []).filter((p) => String(p.place || '').trim());
  /** «запаси (продукти харчування)» → «запасів (продукти харчування)»: назва опису в реєстрі. */
  // Не \b: межа слова в JavaScript — лише для латиниці, після «запаси» вона не стає.
  const stKindsGen = (k) => String(k || '').trim().replace(/^запаси(?=\s|$)/i, 'запасів')
    .replace(/^необоротні активи(?=\s|$)/i, 'необоротних активів');
  /** Розбіжність, яку знайшла комісія: «фактично» не те, що дає облік мінус знищене.
   *  Знищене за рапортом, ще не списане, — не нестача: воно задокументоване й
   *  іде в акт окремим пунктом. */
  const stDiff = (l) => Math.abs(l.fact - l.def) > 1e-9;
  const stGone = (l) => l.def < l.acc - 1e-9;
  function stTotals(rows) {
    const t = { n: rows.length, accQty: 0, accSum: 0, factQty: 0, factSum: 0 };
    for (const l of rows) {
      t.accQty += l.acc; t.factQty += l.fact;
      t.accSum += round2(l.acc * l.price); t.factSum += round2(l.fact * l.price);
    }
    t.accQty = round3(t.accQty); t.factQty = round3(t.factQty);
    t.accSum = round2(t.accSum); t.factSum = round2(t.factSum);
    return t;
  }
  function stSummary(inv) {
    let lines = 0, diffs = 0, gone = 0, accSum = 0, short = 0, over = 0, goneSum = 0, descs = 0;
    const perSub = new Map();
    for (const sub of stSubs(inv)) {
      const ls = stLines(inv, sub);
      const d = ls.filter(stDiff);
      const g = ls.filter(stGone);
      lines += ls.length; diffs += d.length; gone += g.length;
      descs += (ls.some((l) => l.fixed) ? 1 : 0) + (ls.some((l) => !l.fixed) ? 1 : 0);
      for (const l of ls) {
        accSum += round2(l.acc * l.price);
        goneSum += round2((l.acc - l.def) * l.price);
        const x = round2((l.fact - l.def) * l.price);
        if (x < 0) short -= x; else over += x;
      }
      perSub.set(sub, { lines: ls, diffs: d, gone: g });
    }
    return { lines, diffs, gone, accSum: round2(accSum), short: round2(short), over: round2(over),
      goneSum: round2(goneSum), descs, perSub };
  }

  /** Текст результату для акта. Без розбіжностей — однією фразою, як у
   *  паперовому акті. Знищене за рапортами, ще не списане, — окремим пунктом:
   *  це не нестача, а втрата, на яку вже є документ і чекає акт списання. */
  function stResultText(inv, sum = stSummary(inv)) {
    const out = [];
    if (!sum.diffs) out.push('За результатами проведеної інвентаризації лишків та нестач не встановлено.');
    else {
      out.push(`За результатами проведеної інвентаризації встановлено${sum.short ? ` нестачу на суму ${fmtMoney(sum.short)} грн` : ''}`
        + `${sum.short && sum.over ? ' та' : ''}${sum.over ? ` лишки на суму ${fmtMoney(sum.over)} грн` : ''}:`);
      for (const [sub, x] of sum.perSub) {
        for (const l of x.diffs) {
          const d = round3(l.fact - l.def);
          out.push(`- ${sub}: ${l.name} — ${d < 0 ? 'нестача' : 'лишок'} ${fmtNum(Math.abs(d))} ${l.uom}`
            + ` на суму ${fmtMoney(Math.abs(d) * l.price)} грн${l.note && !stGone(l) ? ` (${l.note})` : ''};`);
        }
      }
    }
    if (sum.gone) {
      out.push(`Майно, знищене й не списане на дату інвентаризації (підстава — рапорти, акти списання не проведено), `
        + `на суму ${fmtMoney(sum.goneSum)} грн:`);
      for (const [sub, x] of sum.perSub) {
        for (const l of x.gone) {
          const q = round3(l.acc - l.def);
          out.push(`- ${sub}: ${l.name} — ${fmtNum(q)} ${l.uom} на суму ${fmtMoney(q * l.price)} грн`
            + `${l.note ? ` (${l.note})` : ''};`);
        }
      }
    }
    return out.join('\n');
  }

  function stAttachText(inv, sum = stSummary(inv)) {
    return ['- Інвентаризаційні описи запасів (продовольчої служби), які рахуються за військовою частиною та її підрозділами;',
      '- Інвентаризаційні описи необоротних активів (продовольчої служби), які рахуються за військовою частиною '
      + `та її підрозділами (разом ${cnt(sum.descs + stPlaces(inv).length, 'опис', 'описи', 'описів')}).`].join('\n');
  }

  /** Описи підрозділів: по опису необоротних активів і запасів на кожного, хто тримає майно. */
  function stDescriptions(inv, list) {
    const date = inv.date;
    const qW = (q) => lowerFirst(qtyWords(q));
    const nW = (n) => intWords(n, 'm');
    const descriptions = [];
    for (const sub of list) {
      const lines = stLines(inv, sub);
      const mvo = stMvo(inv, sub);
      for (const fixed of [true, false]) {
        const rows = lines.filter((l) => l.fixed === fixed);
        if (!rows.length) continue;
        const t = stTotals(rows);
        descriptions.push({
          sheet: `${fixed ? 'Необор.' : 'Запаси'} ${sub}`, type: fixed ? 'fixed' : 'stock', sub,
          title: `${fixed ? 'необоротних активів' : 'запасів'} ${ST_SERVICE} ${stWhere(inv, sub)}`,
          where: stWhere(inv, sub), mvo: signer(mvo, date),
          // Наказ про інвентаризацію: опис підписує й командир підрозділу, де її проводили.
          cmdr: signer(stCmdr(inv, sub), date),
          rows: rows.map((l) => ({ name: l.name, uom: l.uom, price: l.price, acc: l.acc, fact: l.fact,
            accSum: round2(l.acc * l.price), factSum: round2(l.fact * l.price), note: l.note,
            // Номер ФЕС: інвентарний у необоротних активів, номенклатурний у запасів.
            inv: fixed ? l.fes : '', nomen: fixed ? '' : l.fes,
            serial: fixed ? stSerial(l) : '', year: fixed && l.year ? String(l.year) : '' })),
          totals: t,
          words: { n: nW(t.n), factQty: qW(t.factQty), factSum: lowerFirst(moneyWords(t.factSum)),
            accQty: qW(t.accQty), accSum: lowerFirst(moneyWords(t.accSum)) },
        });
      }
    }
    return descriptions;
  }

  /** План проведення інвентаризації: де, у кого, які описи, коли й хто з підкомісії. */
  function stPlan(inv) {
    const date = inv.date;
    const who = stSigners(inv);
    const tail = ' ' + unitGen();
    const rows = stSubs(inv).map((sub) => {
      const ls = stLines(inv, sub);
      const p = (inv.plan || {})[sub] || {};
      const m = stMvo(inv, sub);
      const where = stWhere(inv, sub);
      return { place: `${sub}\n${where.endsWith(tail) ? where.slice(0, -tail.length) : where}`,
        mvo: m ? [personAt(m, date).rank, pSign(m)].filter(Boolean).join(' ') : '',
        kinds: [ls.some((l) => l.fixed) ? 'необоротні активи' : '', ls.some((l) => !l.fixed) ? 'запаси' : '']
          .filter(Boolean).join(', '),
        date: p.date || '', who: stMember(personBy(p.who), date), mark: p.done ? `проведено ${fmtDate(p.done)}` : '' };
    });
    // Інші місця — після підрозділів з майном, у тому порядку, як їх вписано.
    for (const p of stPlaces(inv)) {
      rows.push({ place: p.place.trim(), mvo: String(p.mvo || '').trim(), kinds: String(p.kinds || '').trim(), date: p.date || '',
        who: stMember(personBy(p.who), date), mark: p.done ? `проведено ${fmtDate(p.done)}` : '' });
    }
    return { agree: signer(who.chair, date), approve: signer(who.cmd, date), rows };
  }

  /** Протокол комісії (форма наказу Мінфіну №572): що встановлено в наявності й що робити з
   *  розбіжностями. Знищене за рапортом, ще не списане, — втрата до списання; те, що комісія
   *  порахувала інакше, — лишок або нестача. */
  function stProtocol(inv) {
    const date = inv.date;
    const t = { fixedQty: 0, fixedSum: 0, stockQty: 0, stockSum: 0 };
    const rows = [];
    for (const sub of stSubs(inv)) {
      const m = stMvo(inv, sub);
      const mvo = m ? pSign(m) : '';
      for (const l of stLines(inv, sub)) {
        const k = l.fixed ? 'fixed' : 'stock';
        t[k + 'Qty'] = round3(t[k + 'Qty'] + l.fact);
        t[k + 'Sum'] = round2(t[k + 'Sum'] + round2(l.fact * l.price));
        const name = l.name + (stSerial(l) ? `, зав. № ${stSerial(l)}` : '');
        if (stGone(l)) {
          const q = round3(l.def - l.acc);
          rows.push({ name, mvo, qty: q, sum: round2(q * l.price), reason: l.note || '', loss: true });
        }
        if (stDiff(l)) {
          const q = round3(l.fact - l.def);
          rows.push({ name, mvo, qty: q, sum: round2(q * l.price), reason: stGone(l) ? '' : l.note || '' });
        }
      }
    }
    return { approve: signer(stSigners(inv).cmd, date), date: inv.end || date, totals: t, rows };
  }

  /** Реєстр паперів, які підкомісія здає начальникові ФЕС: акт, кожен опис і протокол. */
  function stRegister(inv) {
    const date = inv.date;
    const closed = inv.end || date;
    const rows = [{ doc: 'Акт інвентаризації', date: closed, who: '' }];
    for (const d of stDescriptions(inv, stSubs(inv))) {
      rows.push({ doc: `Інвентаризаційний опис ${d.type === 'fixed' ? 'необоротних активів' : 'запасів'}`, date,
        who: [[d.mvo.rank, d.mvo.name].filter(Boolean).join(' '), d.sub].filter(Boolean).join(', ') });
    }
    for (const p of stPlaces(inv)) {
      rows.push({ doc: `Інвентаризаційний опис ${stKindsGen(p.kinds)}`.trim(), date,
        who: [String(p.mvo || '').trim(), p.place.trim()].filter(Boolean).join(', ') });
    }
    rows.push({ doc: 'Протокол інвентаризаційної комісії', date: closed, who: '' });
    return { fes: signer(stSigners(inv).fes, date), rows };
  }

  /** Строки, які ставить наказ про інвентаризацію: що подати, до якого числа й коли подано. */
  const ST_DUE = [['plan', 'План проведення командирові', 'подання плану інвентаризації'],
    ['fes', 'Акти з описами начальникові ФЕС', 'здачі актів з описами інвентаризації начальникові ФЕС'],
    ['act', 'Акт командирові на затвердження', 'подання акта інвентаризації на затвердження']];
  /** Стан строку на дату: виконано, скільки днів лишилось чи на скільки прострочено. */
  function stDueState(inv, k, t = today()) {
    const due = (inv.due || {})[k] || '';
    const sent = (inv.sent || {})[k] || '';
    if (sent) return { due, sent, kind: 'done', text: `виконано ${fmtDate(sent)}` };
    if (!due) return { due, sent, kind: '', text: '' };
    const left = daysBetween(t, due);
    if (left < 0) return { due, sent, left, kind: 'late', text: `прострочено на ${cnt(-left, 'день', 'дні', 'днів')}` };
    return { due, sent, left, kind: left <= 7 ? 'soon' : 'wait',
      text: left ? `лишилось ${cnt(left, 'день', 'дні', 'днів')}` : 'строк сьогодні' };
  }
  /** Найближчий строк, якого ще не виконано. */
  function stNextDue(inv, t = today()) {
    return ST_DUE.map(([k, , what]) => Object.assign({ k, what }, stDueState(inv, k, t)))
      .filter((x) => x.due && !x.sent).sort((a, b) => a.due.localeCompare(b.due))[0] || null;
  }
  /** Підрозділи, де день за планом минув, а відмітки «проведено» немає. */
  const stLate = (inv, t = today()) => stSubs(inv).filter((sub) => {
    const p = (inv.plan || {})[sub] || {};
    return !!p.date && p.date < t && !p.done;
  }).concat(stPlaces(inv).filter((p) => !!p.date && p.date < t && !p.done).map((p) => p.place.trim()));

  /** Хід інвентаризації на дату: у яких підрозділах її вже проведено. */
  function stProgress(inv, asOf = today()) {
    const sum = stSummary(inv);
    const late = new Set(stLate(inv, asOf));
    const t = { subs: 0, done: 0, late: late.size, descs: 0, doneDescs: 0, lines: 0, sum: 0, doneSum: 0, diffs: 0 };
    const rows = stSubs(inv).map((sub) => {
      const ls = (sum.perSub.get(sub) || { lines: [] }).lines;
      const p = (inv.plan || {})[sub] || {};
      const m = stMvo(inv, sub);
      const descs = (ls.some((l) => l.fixed) ? 1 : 0) + (ls.some((l) => !l.fixed) ? 1 : 0);
      const money = round2(ls.reduce((a, l) => a + round2(l.acc * l.price), 0));
      const done = p.done && p.done <= asOf ? p.done : '';
      const diffs = ls.filter(stDiff).length;
      t.subs += 1; t.descs += descs; t.lines += ls.length; t.sum = round2(t.sum + money); t.diffs += diffs;
      if (done) { t.done += 1; t.doneDescs += descs; t.doneSum = round2(t.doneSum + money); }
      return { sub, mvo: m ? [personAt(m, inv.date).rank, pSign(m)].filter(Boolean).join(' ') : '', descs, lines: ls.length,
        sum: money, plan: p.date || '', done, late: late.has(sub), diffs, who: stMember(personBy(p.who), inv.date) };
    });
    // Інші місця плану: опис один, рядків і сум за обліком програми немає.
    for (const p of stPlaces(inv)) {
      const name = p.place.trim();
      const done = p.done && p.done <= asOf ? p.done : '';
      t.subs += 1; t.descs += 1;
      if (done) { t.done += 1; t.doneDescs += 1; }
      rows.push({ sub: name, mvo: String(p.mvo || '').trim(), descs: 1, lines: null, sum: null, plan: p.date || '', done,
        late: late.has(name), diffs: 0, who: stMember(personBy(p.who), inv.date), other: true });
    }
    return { date: asOf, rows, totals: t, short: sum.short, over: sum.over, gone: sum.gone, goneSum: sum.goneSum };
  }

  /** Відомості про хід інвентаризації для доповіді: підсумок словами й рядок на підрозділ. */
  function stProgressPaper(inv) {
    const p = stProgress(inv);
    const t = p.totals;
    const places = stPlaces(inv).length;
    const lines = [
      `Підрозділів із майном — ${t.subs - places}${places ? `, інших місць — ${places}` : ''}, інвентаризацію проведено в ${t.done}, `
        + `лишилось — ${t.subs - t.done}.`,
      `Описів — ${t.descs}, складено — ${t.doneDescs}.`,
      `Майна за обліком на ${fmtMoney(t.sum)} грн, перевірено на ${fmtMoney(t.doneSum)} грн.`,
      t.diffs ? `Розбіжності: рядків — ${t.diffs}${p.short ? `, нестача на ${fmtMoney(p.short)} грн` : ''}${
        p.over ? `, лишки на ${fmtMoney(p.over)} грн` : ''}.` : 'Лишків та нестач не встановлено.',
    ];
    if (p.gone) lines.push(`Знищене за рапортами, не списане: рядків — ${p.gone}, на ${fmtMoney(p.goneSum)} грн.`);
    if (t.late) lines.push(`День за планом минув, інвентаризацію не проведено: ${p.rows.filter((r) => r.late).map((r) => r.sub).join(', ')}.`);
    return { date: p.date, lines, rows: p.rows, totals: t };
  }

  /** Спека книги Excel: описи обраних підрозділів і папери підкомісії — акт, план, протокол,
   *  реєстр. `blank` — робочі описи: облік надруковано, фактичну наявність вписує комісія.
   *  `progress` — відомості про хід на сьогодні. */
  function stSpec(inv, list, withAct, more = {}) {
    const date = inv.date;
    const who = stSigners(inv);
    const only = [more.plan && 'План', more.protocol && 'Протокол', more.register && 'Реєстр'].filter(Boolean);
    const name = more.blank ? 'Робочі описи' : !list.length && !withAct && only.length === 1 ? `${only[0]} інвентаризації`
      : 'Інвентаризація';
    return {
      kind: 'inventory', file: more.progress ? `Хід інвентаризації на ${today()}`
        : `${name} на ${date}${list.length === 1 ? ' — ' + list[0] : ''}`,
      unit: unitCode(), legal_name: unitInfo().legalName, edrpou: unitInfo().edrpou, date, start: inv.start, end: inv.end || date,
      orderDate: inv.orderDate, orderNo: inv.orderNo, orderItem: inv.orderItem || '',
      service: ST_SERVICE, place: locationAt(date), blank: !!more.blank,
      accFixed: inv.accFixed || ACC_FIXED, accStock: inv.accStock || ACC_STOCK,
      head: signer(personBy(inv.head), date, true),
      members: (inv.members || []).map((id) => signer(personBy(id), date, true)).filter((x) => x.name),
      chief: signer(who.chief, date), buh: signer(who.buh, date),
      descriptions: stDescriptions(inv, list), act: withAct ? stAct(inv) : null,
      plan: more.plan ? stPlan(inv) : null, protocol: more.protocol ? stProtocol(inv) : null,
      register: more.register ? stRegister(inv) : null, progress: more.progress ? stProgressPaper(inv) : null,
    };
  }

  function stAct(inv) {
    const date = inv.date;
    const who = stSigners(inv);
    const one = (p) => { const at = personAt(p, date); return [at.pos && at.pos + ',', at.rank, pShort(p)].filter(Boolean).join(' '); };
    const members = (inv.members || []).map(personBy).filter(Boolean);
    const sum = stSummary(inv);
    const kind = inv.kind || 'щорічна';
    return {
      approve: Object.assign(signer(who.cmd, date), { date: inv.end || date }),
      title: `${ST_GEN[kind] || kind} інвентаризації військового майна продовольчої служби тилу логістики `
        + `${unitGen()}${(inv.scope || []).length ? ` (${inv.scope.join(', ')})` : ''}`,
      intro: `${kind[0].toUpperCase() + kind.slice(1)} інвентаризація військового майна продовольчої служби тилу `
        + `логістики ${unitGen()} проведена станом на ${quoteDate(date)} у період з `
        + `${dayMonth(inv.start || date)} по ${dateWords(inv.end || date)} внутрішньою перевірочною комісією у складі:`,
      head: one(personBy(inv.head)), members: members.map(one).join(', '),
      basis: inv.orderNo || inv.orderDate ? `Підстава: наказ командира ${unitGen()} від `
        + `${dateWords(inv.orderDate)} №${inv.orderNo || '___'}${inv.orderItem ? ` (пункт ${inv.orderItem})` : ''}.` : '',
      prev: inv.prevDate ? `Попередня інвентаризація проводилась станом на ${dateShort(inv.prevDate)}` : '',
      asof: `Акт складений станом на ${dateShort(date)}`,
      findings: String(inv.findings || ST_FINDINGS).split('\n').filter((x) => x.trim()),
      result: stResultText(inv, sum),
      attachments: String(inv.attach || stAttachText(inv, sum)).split('\n').filter((x) => x.trim()),
      ack: [signer(who.nachlog, date), signer(who.chief, date)].filter((x) => x.name),
    };
  }

  async function stExcel(inv, list, withAct, more = {}) {
    const spec = stSpec(inv, list, withAct, more);
    if (!spec.descriptions.length && !spec.act && !spec.plan && !spec.protocol && !spec.register && !spec.progress) {
      toast('На цю дату в обраних підрозділах майна немає.', true);
      return;
    }
    const missing = list.filter((sub) => !stMvo(inv, sub));
    await toExcel(spec);
    if (missing.length) {
      toast(`Описи без підпису МВО: ${missing.join(', ')}. Призначте МВО в «Довідники» → «Люди й МВО».`);
    }
  }

  function renderStocktake() {
    const inv = state.stId ? invById(state.stId) : null;
    if (state.stId && !inv) state.stId = null;
    return inv ? renderStocktakeCard(inv) : renderStocktakeList();
  }

  function renderStocktakeList() {
    const list = allInv().slice().reverse();
    const kinds = [...new Set(list.map((x) => x.kind).filter(Boolean))];
    const headOf = (x) => { const p = personBy(x.head); return p ? pShort(p) : ''; };
    const order = (x) => (x.orderNo || x.orderDate ? `№${x.orderNo || '—'} від ${fmtDate(x.orderDate)}` : '');
    const stOf = (x) => (x.status === 'завершено' ? 'завершено' : 'у роботі');
    const files = (x) => filesOf('st|' + x.id).length;
    const reg = registry({
      id: 'st', rows: list, minWidth: '900px', placeholder: 'Пошук: вид, наказ, голова комісії',
      search: (x) => [x.kind, order(x), headOf(x), (x.scope || []).join(' ')],
      filters: [
        { type: 'seg', key: 'state', options: [['', 'усі'], ['work', 'у роботі'], ['done', 'завершено']],
          test: (x, v) => (v === 'done') === (x.status === 'завершено') },
        ...(kinds.length > 1 ? [{ type: 'select', key: 'kind', label: 'вид', all: 'усі', options: kinds.map((k) => [k, k]),
          test: (x, v) => x.kind === v }] : []),
      ],
      columns: [
        { key: 'date', label: 'станом на', cls: 'c-date', sort: (x) => x.date || '', cell: (x) => fmtDate(x.date) },
        { key: 'kind', label: 'вид', cls: 'c-txt', style: 'flex:0 0 170px', first: 1, sort: (x) => x.kind || '',
          cell: (x) => `<b>${esc(x.kind)}</b>${(x.scope || []).length
            ? `<small title="${esc(x.scope.join(', '))}">${esc(scopeShort(x.scope))}</small>` : ''}` },
        { key: 'order', label: 'наказ', cls: 'c-txt', style: 'flex:0 1 220px', sort: (x) => x.orderDate || '',
          cell: (x) => (order(x) ? esc(order(x)) : '<span class="c-num--dim">не внесено</span>') },
        { key: 'head', label: 'голова комісії', cls: 'c-txt', first: 1, sort: headOf, cell: (x) => esc(headOf(x) || '—') },
        { key: 'files', label: 'файлів', cls: 'c-num', sort: files, cell: (x) => String(files(x) || '—') },
        { key: 'status', label: 'стан', cls: 'c-tag', style: 'width:120px', first: 1, sort: stOf,
          cell: (x) => `<span class="tag ${x.status === 'завершено' ? 'tag--in' : 'tag--mv'}">${esc(stOf(x))}</span>` },
      ],
      row: (x) => ({ attrs: `data-act="st-open" data-id="${esc(x.id)}"` }),
      empty: 'Інвентаризацій ще немає.',
    });
    return {
      head: head('техзасоби / контроль', 'Інвентаризація', '<button class="btn btn--primary" data-act="st-new">+ Нова інвентаризація</button>'),
      body: `${flashBlock()}${reg.panel}<div class="card card--scroll">${reg.table}</div>`,
    };
  }

  /** Що охоплює інвентаризація: уся частина або обрані підрозділи з підлеглими. */
  function stScopeField(inv, ro) {
    const sc = inv.scope || [];
    const label = sc.length ? sc.join(', ') : 'усю частину';
    if (ro) return `<div class="field field--span2"><label>Охоплює</label><div class="st-scope">${esc(label)}</div></div>`;
    const tops = subs.filter((x) => x.depth === 1 && (x.active || sc.includes(x.name))).map((x) => x.name);
    return `<div class="field field--span2"><label>Охоплює</label>
      <details class="st-scope"><summary>${esc(label)}</summary>
        <div class="st-scope__list">${tops.map((n) => `<label><input type="checkbox" data-stscope="${esc(n)}"${
          sc.includes(n) ? ' checked' : ''}> ${esc(n)}</label>`).join('')}</div>
        <div class="field__hint">разом із підлеглими підрозділами</div>
      </details></div>`;
  }

  function renderStocktakeCard(inv) {
    peopleInit();
    const ro = stReadonly(inv);
    const dis = ro ? ' disabled' : '';
    const sum = stSummary(inv);
    const who = stSigners(inv);
    const date = inv.date;
    if (state.stSub) return stPreview(inv, state.stSub, sum);
    const field = (k, label, type = 'text', v = inv[k]) => `<div class="field"><label>${label}</label>
      <input data-stf="${k}" type="${type}" value="${esc(v || '')}"${dis}></div>`;
    const pSel = (attr, sel, hint) => `<select ${attr}${dis}>${personOptions(sel, date, hint)}</select>`;
    const members = (inv.members || []).map((id, i) => `<div class="st-member">${pSel(`data-stm="${i}"`, id, '— оберіть —')}
      ${ro ? '' : rowBtn('st-mdel', '✕ Прибрати', `data-i="${i}"`, { bad: true, title: 'Прибрати з комісії' })}</div>`).join('');
    const sgn = (k, role, label) => {
      const own = (inv.sign || {})[k];
      const dflt = officialAt(role, date);
      return `<div class="field"><label>${label}</label>${pSel(`data-sts="${k}"`, own || '', dflt ? `за довідником: ${pSign(dflt)}` : '— не призначено —')}</div>`;
    };
    // Підписанти інвентаризації: ключ у картці, посада в довіднику, роль у паперах.
    const SIGNERS = [['chief', 'начальник служби', 'Дані в описах перевірив'], ['buh', 'бухгалтер', 'Облікові дані вніс (бухгалтер)'],
      ['cmd', 'командир', 'Затверджує акт'], ['nachlog', 'начальник логістики', 'З актом ознайомлений'],
      ['chair', '', 'План погоджує (голова комісії частини)'], ['fes', 'начальник ФЕС', 'Папери приймає (начальник ФЕС)']];
    // Комісія й посадовці згорнуті, щойно заповнені: до них повертаються рідко,
    // а план і описи — щодня (консиліум 01.10.2026: картка перевантажена).
    const teamOk = !!inv.head && (inv.members || []).length > 0
      && SIGNERS.every(([k, role]) => (inv.sign || {})[k] || (role && officialAt(role, date)));
    const teamHint = teamOk
      ? `голова ${pSign(personBy(inv.head)) || '—'} · ${cnt((inv.members || []).length, 'член', 'члени', 'членів')} · посадовців ${SIGNERS.length}`
      : 'ще не заповнено: голова, члени комісії, посадовці для підписів';
    const subRows = stSubs(inv).map((sub) => {
      const x = sum.perSub.get(sub) || { lines: [], diffs: [] };
      const fx = x.lines.filter((l) => l.fixed), st = x.lines.filter((l) => !l.fixed);
      const tf = stTotals(fx), ts = stTotals(st);
      const own = (inv.mvo || {})[sub];
      const m = stMvo(inv, sub);
      return `<div class="tbl__row tbl__row--plain${x.diffs.length ? ' is-diff' : ''}${m ? '' : ' is-due'}">
        <div class="c-name"><b class="lnk" data-act="st-sub" data-sub="${esc(sub)}" title="Відкрити описи">${esc(sub)}</b>
          <small>${esc(subBy.get(sub)?.type || '')}</small></div>
        <div class="c-txt" style="flex:1.1 1 0">${ro ? esc(m ? pSign(m) : 'МВО не призначено')
          : `<select data-stmvo="${esc(sub)}">${personOptions(own || '', date, m && !own ? `за довідником: ${pSign(m)}` : '— МВО не призначено —')}</select>`}</div>
        <div class="c-num">${fx.length ? `${fx.length} / ${fmtNum(tf.accQty, '0')}` : '—'}</div>
        <div class="c-num c-num--wide">${fx.length ? fmtMoney(tf.accSum) : '—'}</div>
        <div class="c-num">${st.length ? `${st.length} / ${fmtNum(ts.accQty, '0')}` : '—'}</div>
        <div class="c-num c-num--wide">${st.length ? fmtMoney(ts.accSum) : '—'}</div>
        <div class="c-num ${x.diffs.length ? 'num-bad' : x.gone.length ? 'num-warn' : 'c-num--dim'}"
          title="Розбіжності комісії${x.gone.length ? `. Знищене, не списане: ${x.gone.length} рядк.` : ''}">${x.diffs.length
          || (x.gone.length ? `зн. ${x.gone.length}` : '—')}</div>
        <div class="c-acts" style="flex-basis:170px">
          <button type="button" class="btn btn--sm" data-act="st-sub" data-sub="${esc(sub)}">Описи</button>
          <button type="button" class="ico-btn" data-act="st-xls-sub" data-sub="${esc(sub)}" title="Описи підрозділу в Excel">⤓</button></div>
      </div>`;
    }).join('');
    // План: дату, відповідального члена підкомісії й відмітку «проведено» на кожний підрозділ
    // вписують тут.
    const team = [inv.head].concat(inv.members || []).map(personBy).filter(Boolean);
    const late = new Set(stLate(inv));
    const dueRows = ST_DUE.map(([k, label]) => {
      const st = stDueState(inv, k);
      const cell = (attr, v) => (ro ? esc(v ? fmtDate(v) : '—')
        : `<input type="date" class="rc-in rc-in--wide" ${attr}="${k}" value="${esc(v)}" aria-label="${esc(label)}">`);
      return `<div class="tbl__row tbl__row--plain${st.kind === 'late' ? ' is-due' : ''}">
        <div class="c-name"><b>${esc(label)}</b></div>
        <div class="c-txt" style="flex:0 0 170px">${cell('data-std', st.due)}</div>
        <div class="c-txt" style="flex:0 0 170px">${cell('data-stx', st.sent)}</div>
        <div class="c-txt ${st.kind === 'late' ? 'num-bad' : st.kind === 'soon' ? 'num-warn' : ''}">${esc(st.text || '—')}</div>
      </div>`;
    }).join('');
    const planRows = stSubs(inv).map((sub) => {
      const x = sum.perSub.get(sub) || { lines: [] };
      const p = (inv.plan || {})[sub] || {};
      const kinds = [x.lines.some((l) => l.fixed) ? 'необоротні активи' : '', x.lines.some((l) => !l.fixed) ? 'запаси' : '']
        .filter(Boolean).join(', ');
      return `<div class="tbl__row tbl__row--plain${late.has(sub) ? ' is-due' : ''}">
        <div class="c-name"><b>${esc(sub)}</b><small>${esc(stMvo(inv, sub) ? pSign(stMvo(inv, sub)) : 'МВО не призначено')}</small></div>
        <div class="c-txt">${esc(kinds)}</div>
        <div class="c-txt" style="flex:0 0 170px">${ro ? esc(fmtDate(p.date) || '—')
          : `<input type="date" class="rc-in rc-in--wide" data-stpd="${esc(sub)}" value="${esc(p.date || '')}"
              min="${esc(inv.start || '')}" max="${esc(inv.end || '')}" aria-label="дата проведення, ${esc(sub)}">`}</div>
        <div class="c-txt" style="flex:1.2 1 0">${ro ? esc(stMember(personBy(p.who), date) || '—')
          : `<select data-stpw="${esc(sub)}" aria-label="відповідальний, ${esc(sub)}"><option value="">— не призначено —</option>${
            team.map((m) => `<option value="${esc(m.id)}"${m.id === p.who ? ' selected' : ''}>${esc(stMember(m, date))}</option>`).join('')}</select>`}</div>
        <div class="c-txt" style="flex:0 0 170px">${ro ? esc(p.done ? fmtDate(p.done) : '—')
          : `<input type="date" class="rc-in rc-in--wide" data-stpx="${esc(sub)}" value="${esc(p.done || '')}"
              min="${esc(inv.start || '')}" aria-label="проведено, ${esc(sub)}">`}</div>
      </div>`;
    }).join('');
    // Інші місця плану — вписані руками: назва, МВО й вид майна текстом, решта як у підрозділів.
    const placeRows = (inv.places || []).map((p) => {
      const pid = esc(p.id);
      const name = String(p.place || '').trim();
      const txt = (k, ph, label) => (ro ? esc(p[k] || '') : `<input class="rc-in rc-in--wide" data-stpl="${pid}" data-k="${k}"
            value="${esc(p[k] || '')}" placeholder="${ph}" aria-label="${label}, інше місце">`);
      return `<div class="tbl__row tbl__row--plain${name && late.has(name) ? ' is-due' : ''}">
        <div class="c-name st-place">${ro ? `<b>${esc(name)}</b><small>${esc(p.mvo || 'МВО не вказано')}</small>`
          : `${txt('place', 'місце зберігання', 'місце')}${txt('mvo', 'МВО: звання, ім’я ПРІЗВИЩЕ', 'МВО')}`}</div>
        <div class="c-txt">${txt('kinds', 'вид майна (описи)', 'вид майна')}</div>
        <div class="c-txt" style="flex:0 0 170px">${ro ? esc(fmtDate(p.date) || '—')
          : `<input type="date" class="rc-in rc-in--wide" data-stpl="${pid}" data-k="date" value="${esc(p.date || '')}"
              min="${esc(inv.start || '')}" max="${esc(inv.end || '')}" aria-label="дата проведення, ${esc(name || 'інше місце')}">`}</div>
        <div class="c-txt" style="flex:1.2 1 0">${ro ? esc(stMember(personBy(p.who), date) || '—')
          : `<select data-stpl="${pid}" data-k="who" aria-label="відповідальний, ${esc(name || 'інше місце')}"><option value="">— не призначено —</option>${
            team.map((m) => `<option value="${esc(m.id)}"${m.id === p.who ? ' selected' : ''}>${esc(stMember(m, date))}</option>`).join('')}</select>`}</div>
        <div class="c-txt st-place__last" style="flex:0 0 170px">${ro ? esc(p.done ? fmtDate(p.done) : '—')
          : `<input type="date" class="rc-in rc-in--wide" data-stpl="${pid}" data-k="done" value="${esc(p.done || '')}"
              min="${esc(inv.start || '')}" aria-label="проведено, ${esc(name || 'інше місце')}">
            ${rowBtn('st-pdel', '✕ Прибрати', `data-id="${pid}"`, { bad: true, title: 'Прибрати місце з плану' })}`}</div>
      </div>`;
    }).join('');
    return {
      head: head(`інвентаризація / ${fmtDate(date)}`, `${inv.kind[0].toUpperCase() + inv.kind.slice(1)} інвентаризація станом на ${fmtDate(date)}`, `
        <button class="btn" data-act="st-back">← До інвентаризацій</button>
        <button class="btn" data-act="st-xls-all" title="План, акт, протокол, реєстр і описи">В Excel: усі папери</button>${
        inv.base ? `<button class="btn btn--primary" data-act="st-new" data-id="${esc(inv.id)}">+ Нова на основі цієї</button>`
          : inv.status === 'завершено' ? '<button class="btn" data-act="st-reopen">Відкрити для правки</button>'
            : `<button class="btn btn--primary" data-act="st-finish">Завершити ✓</button>
               <button class="btn btn--danger" data-act="st-del" title="Інвентаризацію з планом і описами буде видалено">Видалити інвентаризацію</button>`}`),
      body: `${flashBlock()}
        ${inv.base ? `<div class="flash flash--info">Інвентаризація з бази обліку (${esc(inv.source || 'описи ' + fmtDate(date))}), лише
          для читання. Описи нижче складено з обліку програми на ${fmtDate(date)}.
          Паперові описи є серед файлів.${inv.remark ? `<br>${esc(inv.remark)}` : ''}</div>` : ''}
        ${inv.status === 'завершено' && !inv.base ? '<div class="flash flash--info">Інвентаризацію завершено. Щоб змінити дані, натисніть «Відкрити для правки».</div>' : ''}
        <div class="tiles">
          <div class="tile"><div class="tile__label">Описів</div><div class="tile__value">${sum.descs}</div>
            <div class="tile__hint">${cnt(stSubs(inv).length, 'підрозділ', 'підрозділи', 'підрозділів')} з майном</div></div>
          <div class="tile"><div class="tile__label">Рядків</div><div class="tile__value">${sum.lines}</div>
            <div class="tile__hint">${fmtMoney(sum.accSum)} грн за обліком</div></div>
          <div class="tile"><div class="tile__label">Розбіжності комісії</div>
            <div class="tile__value ${sum.diffs ? 'num-bad' : ''}">${sum.diffs || '—'}</div>
            <div class="tile__hint">${sum.diffs ? `нестача ${fmtMoney(sum.short)} грн, лишки ${fmtMoney(sum.over)} грн`
              : 'фактична наявність збігається з обліком'}</div></div>
          <div class="tile"><div class="tile__label">Знищене, не списане</div>
            <div class="tile__value ${sum.gone ? 'num-warn' : ''}">${sum.gone || '—'}</div>
            <div class="tile__hint">${sum.gone ? `${fmtMoney(sum.goneSum)} грн` : 'немає'}</div></div>
        </div>
        <div class="card form" style="margin-bottom:12px">
          <div class="card__head"><div class="card__title">Реквізити</div></div>
          <div class="form__grid">
            <div class="field"><label>Вид</label><select data-stf="kind"${dis}>${ST_KINDS.map((k) =>
              `<option${k === inv.kind ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
            ${field('date', 'Станом на', 'date')}${field('start', 'Розпочата', 'date')}${field('end', 'Закінчена', 'date')}
            ${field('orderNo', 'Наказ №')}${field('orderDate', 'Наказ від', 'date')}${field('orderItem', 'Пункт наказу')}
            ${field('prevDate', 'Попередня інвентаризація', 'date')}
            ${stScopeField(inv, ro)}
            <div class="field field--span2"><label>Субрахунки необоротних активів</label>
              <input data-stf="accFixed" value="${esc(inv.accFixed || ACC_FIXED)}"${dis}></div>
            <div class="field field--span2"><label>Субрахунки запасів</label>
              <input data-stf="accStock" value="${esc(inv.accStock || ACC_STOCK)}"${dis}></div>
          </div>
        </div>
        ${fold('Комісія й посадовці', teamHint, !teamOk, `<div class="grid-2" style="padding:0 6px 6px">
          <div class="form"><div class="card__head" style="border-bottom:0;padding-bottom:4px"><div class="card__title">Комісія</div></div>
            <div class="pad"><div class="field"><label>Голова комісії</label>${pSel('data-sth="1"', inv.head, '— оберіть —')}</div>
              <div class="field" style="margin-top:10px"><label>Члени комісії</label>${members || '<div class="panel__note">Членів ще не додано.</div>'}</div>
              ${ro ? '' : '<button class="btn btn--sm" data-act="st-madd" style="margin-top:8px">+ Член комісії</button>'}</div></div>
          <div class="form"><div class="card__head" style="border-bottom:0;padding-bottom:4px"><div class="card__title">Посадовці</div></div>
            <div class="form__grid" style="grid-template-columns:1fr;border-bottom:0;padding-top:0">
              ${SIGNERS.map(([k, role, label]) => sgn(k, role, label)).join('')}
            </div></div>
        </div>`)}
        ${filesCard('st|' + inv.id, 'Скани й документи інвентаризації', 'наказ, підписані описи, акт')}
        <div class="card" style="margin-bottom:12px">
          <div class="card__head"><div class="card__title">Строки за наказом</div></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:760px">
            <div class="tbl__head"><div class="tbl__h c-name">що</div>
              <div class="tbl__h c-txt" style="flex:0 0 170px">строк</div>
              <div class="tbl__h c-txt" style="flex:0 0 170px">виконано</div><div class="tbl__h c-txt">стан</div></div>
            ${dueRows}
          </div></div></div>
        <div class="card" style="margin-bottom:12px">
          <div class="card__head"><div class="card__title">План проведення</div>
            <div class="panel__spacer"></div><span class="panel__count" id="st-plan-count">${stPlanCount(inv)}</span>
            ${ro ? '' : '<button class="btn btn--sm" data-act="st-padd" title="Майно служби, якого програма не обліковує: продукти, вода на складах">+ Місце поза обліком</button>'}
            <button class="btn btn--sm" data-act="st-xls-plan">План в Excel</button>
            <button class="btn btn--sm" data-act="st-xls-progress">Хід в Excel</button></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:1000px">
            <div class="tbl__head"><div class="tbl__h c-name">підрозділ</div><div class="tbl__h c-txt">описи</div>
              <div class="tbl__h c-txt" style="flex:0 0 170px">дата проведення</div>
              <div class="tbl__h c-txt" style="flex:1.2 1 0" title="Відповідальний член підкомісії">відповідальний</div>
              <div class="tbl__h c-txt" style="flex:0 0 170px">проведено</div></div>
            ${planRows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">На цю дату майно не числиться за жодним підрозділом.</div></div>'}${placeRows}
          </div></div></div>
        <div class="card" style="margin-bottom:12px">
          <div class="card__head"><div class="card__title">Описи по матеріально відповідальних особах</div>
            <div class="panel__spacer"></div>
            <button class="btn btn--sm" data-act="st-xls-work" title="Облік надруковано, фактичну наявність вписує комісія">Робочі описи в Excel</button></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:1080px">
            <div class="tbl__head"><div class="tbl__h c-name">підрозділ</div><div class="tbl__h c-txt" style="flex:1.1 1 0">МВО</div>
              <div class="tbl__h c-num">необор.: ряд./од.</div><div class="tbl__h c-num c-num--wide">сума, грн</div>
              <div class="tbl__h c-num">запаси: ряд./од.</div><div class="tbl__h c-num c-num--wide">сума, грн</div>
              <div class="tbl__h c-num">розбіжн.</div><div class="tbl__h c-acts" style="flex-basis:170px"></div></div>
            ${subRows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">На цю дату майно не числиться за жодним підрозділом.</div></div>'}
          </div></div></div>
        <div class="card form">
          <div class="card__head"><div class="card__title">Акт інвентаризації</div>
            <div class="panel__spacer"></div><button class="btn btn--sm" data-act="st-xls-act">Акт в Excel</button>
            <button class="btn btn--sm" data-act="st-xls-prot">Протокол в Excel</button>
            <button class="btn btn--sm" data-act="st-xls-reg">Реєстр в Excel</button></div>
          <div class="form__grid">
            <div class="field field--span2"><label>За результатами встановлено</label>
              <textarea data-stf="findings" rows="5"${dis}>${esc(inv.findings || ST_FINDINGS)}</textarea></div>
            ${inv.base && inv.result ? `<div class="field field--span2"><label>Результат за паперовим актом</label>
              <textarea rows="${Math.min(10, 2 + String(inv.result).split('\n').length)}" disabled>${esc(inv.result)}</textarea></div>` : ''}
            <div class="field field--span2"><label>${inv.base ? 'Результат за описами з обліку програми' : 'Результат (формується з описів)'}</label>
              <textarea rows="${Math.min(10, 2 + sum.diffs)}" disabled>${esc(stResultText(inv, sum))}</textarea></div>
            <div class="field field--span2"><label>До акту додається</label>
              <textarea data-stf="attach" rows="3"${dis}>${esc(inv.attach || stAttachText(inv, sum))}</textarea></div>
          </div>
          ${(sum.diffs || sum.gone) && /відповідає даним/.test(inv.findings || ST_FINDINGS) ? `<div class="flash flash--warn" style="margin:0 16px 16px">
            ${sum.diffs ? 'Є розбіжності' : 'Є знищене, не списане майно'}, а в «встановлено» написано, що фактична наявність
            відповідає даним обліку. Виправте цей пункт.</div>` : ''}
        </div>`,
    };
  }

  /** Описи одного підрозділу: облік, фактично (комісія виправляє), інші відомості. */
  function stPreview(inv, sub, sum) {
    const ro = stReadonly(inv);
    const lines = stLines(inv, sub);
    const m = stMvo(inv, sub);
    const date = inv.date;
    const table = (fixed) => {
      const rows = lines.filter((l) => l.fixed === fixed);
      if (!rows.length) return '';
      const t = stTotals(rows);
      const body = rows.map((l, i) => `<div class="tbl__row tbl__row--plain${stDiff(l) ? ' is-diff' : stGone(l) ? ' is-gone' : ''}">
          <div class="c-num c-num--dim" style="width:40px">${i + 1}</div>
          <div class="c-name"><b class="lnk" data-code="${esc(l.code)}" title="Відкрити картку позиції">${esc(l.name)}</b>
            <small>${esc(l.code)}${l.fes ? ' · ФЕС ' + esc(l.fes) : ''}${l.serial ? ' · зав. № ' + esc(l.serial) : ''}${
              l.chassis ? ' · шасі № ' + esc(l.chassis) : ''}${l.year ? ' · ' + esc(l.year) + ' р.' : ''}</small></div>
          <div class="c-unit">${esc(l.uom)}</div>
          <div class="c-num c-num--wide">${l.price ? fmtMoney(l.price) : '—'}</div>
          <div class="c-num">${fmtNum(l.acc, '0')}</div>
          <div class="c-num c-num--input">${ro ? fmtNum(l.fact, '0')
            : `<input class="rc-in" data-stq="${esc(l.key)}" value="${esc(String(+l.fact.toFixed(3)))}" inputmode="decimal"
                title="Фактична кількість${l.def !== l.acc ? ' без знищеного' : ''}">`}</div>
          <div class="c-num c-num--xwide">${fmtMoney(l.fact * l.price)}</div>
          <div class="c-txt rc-note">${ro ? esc(l.note) : `<input class="rc-in rc-in--wide" data-stn="${esc(l.key)}" value="${esc(l.note)}"
              placeholder="інші відомості">`}</div>
        </div>`).join('');
      return `<div class="card" style="margin-bottom:12px">
        <div class="card__head"><div class="card__title">${fixed ? 'Опис необоротних активів' : 'Опис запасів'}</div>
          <div class="panel__spacer"></div><span class="panel__count">${cnt(rows.length, 'рядок', 'рядки', 'рядків')}
            · за обліком ${fmtNum(t.accQty, '0')} од. на ${fmtMoney(t.accSum)} грн
            · фактично ${fmtNum(t.factQty, '0')} од. на ${fmtMoney(t.factSum)} грн</span></div>
        <div class="card--scroll"><div class="tbl" style="--tbl-min:1000px">
          <div class="tbl__head"><div class="tbl__h c-num" style="width:40px">№</div><div class="tbl__h c-name">найменування</div>
            <div class="tbl__h c-unit">од.</div><div class="tbl__h c-num c-num--wide">ціна, грн</div>
            <div class="tbl__h c-num">за обліком</div><div class="tbl__h c-num c-num--input">фактично</div>
            <div class="tbl__h c-num c-num--xwide">сума фактично</div><div class="tbl__h c-txt">інші відомості</div></div>
          ${body}
          <div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-num" style="width:40px"></div>
            <div class="c-name"><b>Разом</b></div><div class="c-unit"></div><div class="c-num c-num--wide"></div>
            <div class="c-num">${fmtNum(t.accQty, '0')}</div><div class="c-num c-num--input">${fmtNum(t.factQty, '0')}</div>
            <div class="c-num c-num--xwide">${fmtMoney(t.factSum)}</div><div class="c-txt"></div></div>
        </div></div></div>`;
    };
    const subsList = stSubs(inv);
    const at = subsList.indexOf(sub);
    return {
      head: head(`інвентаризація / ${fmtDate(date)} / описи`, sub, `
        <button class="btn" data-act="st-sub" data-sub="">← До інвентаризації</button>
        <div class="seg"><button type="button" data-act="st-sub" data-sub="${esc(subsList[at - 1] || '')}"${at > 0 ? '' : ' disabled'}
            title="Попередній підрозділ">◀</button>
          <button type="button" data-act="st-sub" data-sub="${esc(subsList[at + 1] || '')}"${at >= 0 && at < subsList.length - 1 ? '' : ' disabled'}
            title="Наступний підрозділ">▶</button></div>
        <button class="btn btn--primary" data-act="st-xls-sub" data-sub="${esc(sub)}">Описи в Excel</button>`),
      body: `${flashBlock()}
        <div class="card form" style="margin-bottom:12px"><div class="form__grid">
          <div class="field"><label>Матеріально відповідальна особа</label>${ro ? `<input value="${esc(m ? pSign(m) : '—')}" disabled>`
            : `<select data-stmvo="${esc(sub)}">${personOptions((inv.mvo || {})[sub] || '', date,
              mvoAt(sub, date) && !(inv.mvo || {})[sub] ? `за довідником: ${pSign(mvoAt(sub, date))}` : '— МВО не призначено —')}</select>`}</div>
          <div class="field"><label>Посада й звання на ${fmtDate(date)}</label>
            <input value="${esc(m ? [personAt(m, date).pos, personAt(m, date).rank].filter(Boolean).join(', ') : '')}" disabled></div>
          <div class="field field--span2"><label>Місце зберігання</label>
            <input data-stw="${esc(sub)}" value="${esc(stWhere(inv, sub))}"${ro ? ' disabled' : ''}></div>
          <div class="field field--span2"><label>Командир (начальник) підрозділу</label>${ro
            ? `<input value="${esc(stCmdr(inv, sub) ? pSign(stCmdr(inv, sub)) : '—')}" disabled>`
            : `<select data-stcmdr="${esc(sub)}">${personOptions((inv.cmdr || {})[sub] || '', date,
              cmdrFor(sub, date) && !(inv.cmdr || {})[sub] ? `за довідником: ${pSign(cmdrFor(sub, date))}` : '— не вказано —')}</select>`}</div>
        </div></div>
        ${ro ? '' : `<div class="panel"><div class="panel__note">Графу «фактично» заповнено за обліком без знищеного, не списаного.</div></div>`}
        ${table(true)}${table(false)}
        ${lines.length ? '' : emptyBlock('∅', 'Майна немає', `На ${fmtDate(date)} за «${sub}» нічого не числиться.`)}`,
    };
  }

  function stUpdate(fn) {
    const inv = invById(state.stId);
    if (!inv || stReadonly(inv)) return null;
    fn(inv);
    inv.updated = today();
    save();
    return inv;
  }

  /** «проведено N з M» над планом: підрозділи з майном і названі інші місця. */
  function stPlanCount(inv) {
    const done = stSubs(inv).filter((sub) => ((inv.plan || {})[sub] || {}).done).length
      + stPlaces(inv).filter((p) => p.done).length;
    return `проведено ${done} з ${stSubs(inv).length + stPlaces(inv).length}`;
  }

  function bindStocktake() {
    if (state.view !== 'stocktake' || !state.stId) return;
    const sc = $('#scroll');
    sc.querySelectorAll('[data-stf]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => {
        const was = inv.date;
        inv[el.dataset.stf] = el.value;
        // «Розпочата» не пізніше, «закінчена» не раніше за «станом на»: типові
        // 01.11–25.12 при інвентаризації станом на 23.09 давали «закінчена 25.12».
        // Закінчена, яку не правили окремо (дорівнює попередній даті), іде за датою.
        if (el.dataset.stf === 'date' && inv.date) {
          if (!inv.end || inv.end === was || inv.end < inv.date) inv.end = inv.date;
          if (inv.start && inv.start > inv.date) inv.start = inv.date;
        }
      });
      if (el.tagName !== 'TEXTAREA') render();
    }));
    sc.querySelectorAll('[data-sth]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => { inv.head = el.value; }); render();
    }));
    sc.querySelectorAll('[data-stscope]').forEach((el) => el.addEventListener('change', () => {
      const open = el.closest('details');
      stUpdate((inv) => {
        const sub = el.dataset.stscope;
        inv.scope = (inv.scope || []).filter((x) => x !== sub).concat(el.checked ? [sub] : []);
      });
      render();
      if (open) $('#scroll details.st-scope')?.setAttribute('open', '');
    }));
    sc.querySelectorAll('[data-stm]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => { inv.members[+el.dataset.stm] = el.value; }); render();
    }));
    sc.querySelectorAll('[data-sts]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => { inv.sign = inv.sign || {}; if (el.value) inv.sign[el.dataset.sts] = el.value; else delete inv.sign[el.dataset.sts]; });
      render();
    }));
    sc.querySelectorAll('[data-stmvo]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => { inv.mvo = inv.mvo || {}; if (el.value) inv.mvo[el.dataset.stmvo] = el.value; else delete inv.mvo[el.dataset.stmvo]; });
      render();
    }));
    sc.querySelectorAll('[data-stw]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => { inv.where = inv.where || {}; inv.where[el.dataset.stw] = el.value.trim(); });
    }));
    // План: дата й відповідальний на підрозділ; порожній запис не зберігається.
    const planSet = (sub, k, v) => stUpdate((inv) => {
      const plan = Object.assign({}, inv.plan || {});
      const p = Object.assign({}, plan[sub] || {});
      if (v) p[k] = v; else delete p[k];
      if (Object.keys(p).length) plan[sub] = p; else delete plan[sub];
      inv.plan = plan;
    });
    sc.querySelectorAll('[data-stpd]').forEach((el) => el.addEventListener('change', () => { planSet(el.dataset.stpd, 'date', el.value); render(); }));
    sc.querySelectorAll('[data-stpw]').forEach((el) => el.addEventListener('change', () => planSet(el.dataset.stpw, 'who', el.value)));
    sc.querySelectorAll('[data-stpx]').forEach((el) => el.addEventListener('change', () => {
      if (el.value > today()) { toast('Відмітку «проведено» ставлять не раніше дня проведення.', true); el.value = ''; }
      planSet(el.dataset.stpx, 'done', el.value);
      render();
    }));
    // Строки наказу: строк і день, коли подано; порожній запис не зберігається.
    const dueSet = (part, k, v) => stUpdate((inv) => {
      const d = Object.assign({}, inv[part] || {});
      if (v) d[k] = v; else delete d[k];
      inv[part] = d;
    });
    sc.querySelectorAll('[data-std]').forEach((el) => el.addEventListener('change', () => { dueSet('due', el.dataset.std, el.value); render(); }));
    sc.querySelectorAll('[data-stx]').forEach((el) => el.addEventListener('change', () => { dueSet('sent', el.dataset.stx, el.value); render(); }));
    sc.querySelectorAll('[data-stcmdr]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => {
        const cmdr = Object.assign({}, inv.cmdr || {});
        if (el.value) cmdr[el.dataset.stcmdr] = el.value; else delete cmdr[el.dataset.stcmdr];
        inv.cmdr = cmdr;
      });
    }));
    sc.querySelectorAll('[data-stn]').forEach((el) => el.addEventListener('change', () => {
      stUpdate((inv) => { inv.note = inv.note || {}; inv.note[el.dataset.stn] = el.value.trim(); });
    }));
    // Інші місця плану: кожне поле — своє; назва й МВО лишаються, як надруковано.
    sc.querySelectorAll('[data-stpl]').forEach((el) => el.addEventListener('change', () => {
      const k = el.dataset.k;
      if (k === 'done' && el.value > today()) { toast('Відмітку «проведено» ставлять не раніше дня проведення.', true); el.value = ''; }
      const inv = stUpdate((x) => {
        const p = (x.places || []).find((y) => y.id === el.dataset.stpl);
        if (p) p[k] = el.tagName === 'INPUT' && el.type !== 'date' ? el.value.trim() : el.value;
      });
      if (k === 'date' || k === 'done') render();
      // Назва місця вводиться підряд із МВО й видом майна: перемальовувати не можна
      // (пішов би фокус), а лічильник над планом змінюється — підставляється на місці.
      else if (inv) { const c = $('#st-plan-count'); if (c) c.textContent = stPlanCount(inv); }
    }));
    const cells = [...sc.querySelectorAll('[data-stq]')];
    cells.forEach((el, i) => {
      el.addEventListener('change', () => {
        const key = el.dataset.stq;
        const raw = String(el.value).replace(',', '.').trim();
        const v = raw === '' ? null : +raw;
        if (v != null && (!Number.isFinite(v) || v < 0)) { toast('Кількість має бути невід’ємним числом.', true); el.value = ''; return; }
        const next = cells[i + 1] && cells[i + 1].dataset.stq;
        const focusNext = el.dataset.enter === '1';
        stUpdate((inv) => {
          inv.fact = inv.fact || {};
          const line = stLines(inv, state.stSub).find((l) => l.key === key);
          if (v == null || (line && Math.abs(v - line.def) < 1e-9)) delete inv.fact[key]; else inv.fact[key] = v;
        });
        render();
        if (focusNext && next) { const n = $(`[data-stq="${CSS.escape(next)}"]`); if (n) { n.focus(); n.select(); } }
      });
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        el.dataset.enter = '1';
        el.blur();
        if (!el.isConnected) return;
        const n = cells[i + 1];
        if (n) { n.focus(); n.select(); }
      });
    });
  }

  function stocktakeAction(what, d) {
    const inv = invById(state.stId);
    switch (what) {
      case 'st-new': return stNew(d.id ? invById(d.id) : null);
      case 'st-open': return go('stocktake', { stId: d.id, stSub: '' });
      case 'st-back': return goBack('stocktake', { stId: null, stSub: '' });
      case 'st-sub': return go('stocktake', { stSub: d.sub || '' });
      case 'st-madd': stUpdate((x) => { x.members = (x.members || []).concat(['']); }); return render();
      case 'st-mdel': stUpdate((x) => { x.members.splice(+d.i, 1); }); return render();
      case 'st-padd': {
        // Нове місце бере вид майна й відповідального з попереднього: місця одного роду йдуть низкою.
        let id = '';
        stUpdate((x) => {
          const last = (x.places || []).slice(-1)[0] || {};
          id = uid();
          (x.places = x.places || []).push({ id, place: '', mvo: '', kinds: last.kinds || '', date: '', who: last.who || '', done: '' });
        });
        render();
        if (id) $(`[data-stpl="${CSS.escape(id)}"][data-k="place"]`)?.focus();
        return null;
      }
      case 'st-pdel': stUpdate((x) => { x.places = (x.places || []).filter((p) => p.id !== d.id); }); return render();
      case 'st-xls-sub': return inv && stExcel(inv, [d.sub], false);
      case 'st-xls-all': return inv && stExcel(inv, stSubs(inv), true, { plan: true, protocol: true, register: true });
      case 'st-xls-act': return inv && stExcel(inv, [], true);
      case 'st-xls-plan': return inv && stExcel(inv, [], false, { plan: true });
      case 'st-xls-prot': return inv && stExcel(inv, [], false, { protocol: true });
      case 'st-xls-reg': return inv && stExcel(inv, [], false, { register: true });
      case 'st-xls-work': return inv && stExcel(inv, stSubs(inv), false, { blank: true });
      case 'st-xls-progress': return inv && stExcel(inv, [], false, { progress: true });
      case 'st-finish': {
        if (!inv) return;
        // Інвентаризацію, заведену наперед (грудневу — у вересні), завершити
        // раніше її дати не можна: завершена закриває період до своєї дати, і
        // кожен новий документ до кінця року перепитував би про закритий період.
        if (inv.date > today()) {
          alert(`Інвентаризацію станом на ${fmtDate(inv.date)} можна завершити не раніше цієї дати.`);
          return;
        }
        const miss = [];
        if (!inv.orderNo || !inv.orderDate) miss.push('номер і дата наказу');
        if (inv.start && inv.end && inv.start > inv.end) miss.push('дати: «розпочата» пізніше за «закінчена»');
        if (!personBy(inv.head)) miss.push('голова комісії');
        if (!(inv.members || []).filter(personBy).length) miss.push('члени комісії');
        const noMvo = stSubs(inv).filter((sub) => !stMvo(inv, sub));
        if (noMvo.length) miss.push('МВО: ' + noMvo.join(', '));
        const noCmdr = stSubs(inv).filter((sub) => !stCmdr(inv, sub));
        if (noCmdr.length) miss.push('командири підрозділів: ' + noCmdr.join(', '));
        if (miss.length && !confirm(`Не заповнено: ${miss.join('; ')}. Усе одно завершити?`)) return;
        // Підписані описи — документ: завершена інвентаризація тримає їх такими,
        // якими їх підписали, навіть коли потім заднім числом внесуть документ.
        const frozen = { subs: stSubs(inv), lines: {} };
        for (const sub of frozen.subs) frozen.lines[sub] = stSource(sub, inv.date, !inv.base);
        // Дата першого завершення лишається: повторне після правки — це виправлення.
        stUpdate((x) => { x.status = 'завершено'; x.finished = x.finished || today(); x.frozen = frozen; });
        logChange('інвентаризацію завершено', 'st|' + inv.id, `${inv.kind} станом на ${fmtDate(inv.date)}`);
        save(true, true);
        state.flash = 'Інвентаризацію завершено. Підшийте скани підписаних описів і акта.';
        return render();
      }
      case 'st-reopen':
        if (!inv || inv.base) return;
        // Завершена інвентаризація закриває період; відкрита — знову рахує описи з
        // обліку, і те, що внесли заднім числом після завершення, потрапить у них.
        if (!confirm(`Відкрити для правки інвентаризацію станом на ${fmtDate(inv.date)}?\n\n`
          + 'Описи знову складатимуться з поточного обліку, а документи до цієї дати '
          + 'проводитимуться без попередження про закритий період.')) return;
        inv.status = 'чернетка';
        delete inv.frozen;
        logChange('інвентаризацію відкрито', 'st|' + inv.id, `${inv.kind} станом на ${fmtDate(inv.date)}`);
        save(true, true);
        return render();
      case 'st-del':
        if (!inv || inv.base || inv.status === 'завершено') return;
        if (!confirm(`Видалити інвентаризацію станом на ${fmtDate(inv.date)}?\n\nВнесену фактичну наявність буде видалено, `
          + 'скани залишаться в теці.')) return;
        store.inventories = store.inventories.filter((x) => x.id !== inv.id);
        logChange('інвентаризацію видалено', 'st|' + inv.id, `${inv.kind} станом на ${fmtDate(inv.date)}`);
        save(true, true);
        return go('stocktake', { stId: null, stSub: '' });
      default: return null;
    }
  }

  /** Числівник словами з родом одиниць: «двадцять два» номери, «двадцять дві» одиниці. */
  function intWords(n, g = 'm') {
    n = Math.floor(Math.abs(+n || 0));
    if (n === 0) return 'нуль';
    const parts = [];
    for (const [v, label, gg] of [[1e9, 'млрд.', 'm'], [1e6, 'млн.', 'm'], [1e3, 'тис.', 'f']]) {
      if (n >= v) { parts.push(words999(Math.floor(n / v), gg), label); n %= v; }
    }
    if (n) parts.push(words999(n, g));
    return parts.filter(Boolean).join(' ');
  }

  /** Дії довідника людей і вкладень (data-act з параметрами). */
  function peopleAction(what, d) {
    peopleInit();
    const p = personBy(state.personId);
    switch (what) {
      case 'pp-tab': state.peopleTab = d.v; state.personId = null; return render();
      case 'pp-new': return personNew();
      case 'pp-open':
        if (state.view !== 'people' || (state.peopleTab || 'people') !== 'people') {
          return go('people', { peopleTab: 'people', personId: d.id, q: '' });
        }
        state.personId = state.personId === d.id ? null : d.id;
        render();
        $('#scroll').scrollTop = 0;
        return null;
      case 'pp-close': state.personId = null; return render();
      case 'pp-del': return personDelete();
      case 'ph-add': {
        if (!p) return null;
        // Два записи історії на одну дату база не приймає: на сьогодні запис
        // уже є — правимо його, а не заводимо другий.
        if ((p.hist || []).some((h) => h.date === today())) {
          toast('Запис на сьогодні вже є — змініть звання чи посаду в ньому.', true);
          return null;
        }
        p.hist.push(Object.assign({}, personAt(p, today()), { date: today(), basis: '' }));
        save();
        return render();
      }
      case 'ph-del':
        if (!p || p.hist.length < 2) return null;
        if (!confirm('Видалити цей запис історії?\n\nДокументи на ту дату візьмуть попереднє звання й посаду.')) return null;
        p.hist.splice(+d.i, 1);
        save();
        return render();
      case 'as-kind': state.assign = { kind: d.v }; return render();
      case 'as-add': return assignAdd();
      case 'mvo-end': return assignEnd(d.id);
      case 'cmdr-end': return assignEnd(d.id, 'cmdr');
      case 'off-end': return assignEnd(d.id, 'role');
      case 'as-edit': {
        const kind = assignKind(d.v);
        const r = ASSIGN[kind].list().find((x) => x.id === d.id);
        if (!r) return null;
        state.assign = { kind, id: r.id, sub: r.sub, role: r.role, person: r.person, from: r.from || '', to: r.to || '', note: r.note || '' };
        render();
        $('#scroll')?.scrollTo({ top: 0 });
        return null;
      }
      case 'as-cancel': state.assign = { kind: (state.assign || {}).kind || 'mvo' }; return render();
      case 'mvo-del': return assignDelete('mvo', d.id);
      case 'cmdr-del': return assignDelete('cmdr', d.id);
      case 'off-del': return assignDelete('role', d.id);
      case 'loc-add': return locationAdd();
      case 'loc-del': return locationDelete(d.id);
      case 'file-add': {
        const why = purFileRefusal(d.key);
        if (why) { toast(why, true); return null; }
        purPinFolder(purOfFileKey(d.key));                       // перший файл справи без «теки» записує її теку
        const t = fileTarget(d.key);
        if (t) attachScan(t);
        return null;
      }
      default: return null;
    }
  }
