// Облік ТЗ ПС · сторінка · документи служби: залишкова вартість, акти ЯТС.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ============================================================== ТОЧНІ ЧИСЛА
  /** Гроші й коефіцієнти відомості залишкової вартості рахуються точно, без двійкових дробів:
   *  число — ціле (BigInt) і кількість знаків після коми. Порожнє й нечислове — null: нуль,
   *  порожнє поле і «не застосовується» — різні речі. */
  const decOf = (v) => {
    if (v == null || typeof v === 'object') return null;
    const t = String(v).trim().replace(/[\s ]/g, '').replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    const neg = t[0] === '-';
    const [a, b = ''] = (neg ? t.slice(1) : t).split('.');
    const frac = b.replace(/0+$/, '');
    const n = BigInt(a + frac);
    return { n: neg ? -n : n, s: frac.length };
  };
  const decPow = (k) => 10n ** BigInt(k);
  const decMul = (x, y) => ({ n: x.n * y.n, s: x.s + y.s });
  const decAdd = (x, y) => { const s = Math.max(x.s, y.s); return { n: x.n * decPow(s - x.s) + y.n * decPow(s - y.s), s }; };
  const decSub = (x, y) => decAdd(x, { n: -y.n, s: y.s });
  const decCmp = (x, y) => { const d = decSub(x, y).n; return d < 0n ? -1 : d > 0n ? 1 : 0; };
  /** Округлення до d знаків; половина — від нуля, як ROUND в Excel. */
  const decRound = (x, d) => {
    if (x.s <= d) return x;
    const k = decPow(x.s - d);
    const neg = x.n < 0n, a = neg ? -x.n : x.n;
    const n = a / k + ((a % k) * 2n >= k ? 1n : 0n);
    return { n: neg ? -n : n, s: d };
  };
  /** Рядок із крапкою: точний (без зайвих нулів) або з рівно d знаками після округлення. */
  const decStr = (x, d = null) => {
    const y = d == null ? x : decRound(x, d);
    const neg = y.n < 0n;
    let t = (neg ? -y.n : y.n).toString();
    const s = d == null ? y.s : d;
    if (d != null && y.s < d) t += '0'.repeat(d - y.s);
    if (s > 0) { t = t.padStart(s + 1, '0'); t = `${t.slice(0, -s)}.${t.slice(-s)}`; }
    if (d == null && s > 0) t = t.replace(/\.?0+$/, '');
    return (neg && /[1-9]/.test(t) ? '-' : '') + t;
  };
  /** Як пишуть у папері: «16 212,96», «0,648». */
  const decUa = (x, d = null) => { const [a, b] = decStr(x, d).split('.'); return a.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (b ? `,${b}` : ''); };

  // ============================================== НОРМАТИВИ ЗАЛИШКОВОЇ ВАРТОСТІ
  /** Версійований довідник розрахунку залишкової вартості майна продовольчої служби: Методика,
   *  затверджена постановою КМУ від 29.05.1998 № 759 (у редакції постанови від 30.12.2015 № 1158), —
   *  пункти 5–11 і пункт 21 додатка 3 з таблицями 26 і 27, як у тексті на zakon.rada.gov.ua.
   *  Пункт 21 і таблиці однакові в редакціях від 23.08.2016 до 25.04.2026 (звірено 03.10.2026);
   *  редакції різняться пунктом 10. Оновлення довідника не перераховує затверджених відомостей:
   *  розрахунок рядка зберігає редакцію, параметри, коефіцієнти й результат. */
  const VAL_NORMS = {
    id: 'КМУ-759 / звірено 03.10.2026',
    act: 'Методика визначення залишкової вартості майна Збройних Сил України та інших військових формувань, затверджена постановою Кабінету Міністрів України від 29.05.1998 № 759',
    url: 'https://zakon.rada.gov.ua/laws/show/759-98-п',
    checked: '2026-10-03',
    // Редакції — за датою набрання чинності змін до пункту 10 (постанови КМУ 2026 року № 431 і № 515).
    editions: [
      { id: '2016-08-23', from: '', p10: '', title: 'редакція, чинна до 10.04.2026' },
      { id: '2026-04-10', from: '2026-04-10', p10: 'plain', title: 'редакція від 10.04.2026 (зміни постановою КМУ від 01.04.2026 № 431)' },
      { id: '2026-04-25', from: '2026-04-25', p10: 'except',
        title: 'редакція від 25.04.2026 (зміни постановами КМУ від 01.04.2026 № 431 і від 22.04.2026 № 515)' },
    ],
    p10since: '2026-04-10',                 // набрання чинності постановою № 431: від цієї дати — виняток пункту 10
    // Таблиця 26. КЕ за фактичним строком експлуатації (межа «до» — включно) або зберігання (років, включно).
    ke: ['1', '0.9', '0.8', '0.7', '0.6', '0.5'],
    keStore: ['1', '1', '0.9', '0.9', '0.8', '0.8'],
    storeUpTo: [5, 10, 15, 20, 25],
    groups: [
      { id: 'tz', name: 'Технічні засоби продовольчої служби (крім змонтованих на автомобільному шасі)',
        use: { 'год': [325, 650, 975, 1300, 1800], 'р': [2, 3, 5, 7, 8] } },
      // У тексті таблиці 26 інтервал зберігання цієї групи між «15 - 20» і «понад 25» записано «25 - 25 років».
      { id: 'portable', name: 'Переносне (з’ємне) обладнання польових технічних засобів та обладнання стаціонарних хлібозаводів',
        use: { 'год': [875, 1750, 2625, 3500, 4900] }, storeGap: [20, 25] },
      { id: 'goods', name: 'Майно продовольчої служби (брезенти, намети, чохли)', use: { 'міс': [4, 8, 12, 16, 20] } },
      { id: 'stationary', name: 'Технологічне, холодильне та немеханічне обладнання стаціонарних їдалень та складів',
        use: { 'р': [2, 3, 5, 7, 8] } },
    ],
    // Таблиця 27. КЗ за умовами зберігання (експлуатації), КТС за категорією якісного (технічного) стану.
    kz: [['в приміщенні, що опалюється', '1'],
      ['в приміщенні, що не опалюється, з дотриманням умов консервації', '0.9'],
      ['в приміщенні, що не опалюється (виріб незаконсервований)', '0.8'],
      ['на відкритих майданчиках під навісом з дотриманням умов консервації', '0.7'],
      ['на відкритих майданчиках під навісом (виріб незаконсервований)', '0.6'],
      ['на відкритих майданчиках з дотриманням умов консервації', '0.5'],
      ['на відкритих майданчиках (виріб незаконсервований)', '0.4']],
    kts: ['1', '0.9', '0.8', '0.7', '0.6'],
  };
  const VAL_UNIT = { 'год': ['годин', 'в годинах'], 'міс': ['місяців', 'в місяцях'], 'р': ['років', 'в роках'] };
  const VAL_PRICE_GROUPS = [['I', 'I — придбане за фіксованими державними цінами'], ['II', 'II — придбане за договірними цінами на внутрішньому ринку'],
    ['III', 'III — імпортоване'], ['IV', 'IV — за звітом про незалежну оцінку']];
  const VAL_ROMAN = ['I', 'II', 'III', 'IV', 'V'];
  /** Редакція Методики, чинна на дату складання відомості. Без дати редакція не визначена. */
  const valEdition = (date) => (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
    ? VAL_NORMS.editions.filter((e) => !e.from || e.from <= date).pop() : null);
  /** Номер інтервалу таблиці: перший, чия верхня межа не менша за значення; далі — останній, без межі. */
  const valInterval = (limits, v) => { const i = limits.findIndex((l) => decCmp(v, decOf(l)) <= 0); return i < 0 ? limits.length : i; };
  const valIntervalText = (limits, i, unit) => (i === 0 ? `до ${limits[0]} ${unit} включно`
    : i < limits.length ? `понад ${limits[i - 1]} до ${limits[i]} ${unit} включно` : `понад ${limits[limits.length - 1]} ${unit}`);
  /** Поля рядка, від яких залежить результат: змінилося хоч одне — розрахунок неактуальний. */
  const VAL_INPUTS = ['qty', 'price', 'group', 'ki', 'kiBasis', 'rate', 'rateBasis', 'appraisal', 'appraisalRef', 'complete', 'missing',
    'missingBasis', 'method', 'ng', 'mode', 'term', 'termUnit', 'storeYears', 'keOwn', 'keOwnBasis', 'cond', 'cat', 'scrap', 'scrapVal',
    'scrapBasis'];
  const VAL_P10 = ['kind', 'cause', 'basis', 'order', 'orderRef'];
  const valSig = (ln, doc) => JSON.stringify([VAL_NORMS.id, (valEdition(doc.date) || {}).id || '', VAL_INPUTS.map((f) => String(ln[f] ?? '').trim()),
    ln.method === 'p10' ? VAL_P10.map((f) => String((ln.p10 || {})[f] ?? '').trim()) : []]);
  /** Затверджена (і скасована) відомість тримає той результат, з яким її затвердили: оновлений
   *  довідник чи редакція її не чіпають. Решта — актуальна, доки не змінили параметр, дату чи довідник. */
  const valFrozen = (doc) => doc.state === 'затверджено' || doc.state === 'скасовано';
  const valStale = (ln, doc) => !ln.res || (!valFrozen(doc) && ln.res.sig !== valSig(ln, doc));

  /** Розрахунок рядка відомості: { need: [чого бракує], res: результат або null }. Нічого не
   *  домислює: без ціни, коефіцієнта індексації з підставою, комплектності, даних про брухт чи
   *  параметрів таблиць суми немає, а названо, чого саме бракує. Первісна вартість округлюється
   *  до копійок, далі множення без проміжного округлення — як у бланку відомості. */
  function valCalcLine(ln, doc) {
    const need = [], why = [];
    const txt = (f) => String(ln[f] ?? '').trim();
    const pos = (f) => { const v = decOf(ln[f]); return v && v.n >= 0n ? v : null; };
    const ed = valEdition(doc.date);
    if (!ed) need.push('не вказано дату складання відомості: за нею визначається редакція Методики');
    const qty = pos('qty');
    if (!qty || qty.n === 0n) need.push('не вказано кількість');
    // Первісна вартість — за ціновою групою (пункти 5 і 7 Методики).
    let vp = null;
    const grp = txt('group');
    if (!['I', 'II', 'III', 'IV'].includes(grp)) need.push('не обрано цінову групу (пункт 5 Методики)');
    else if (grp === 'IV') {
      const v = pos('appraisal');
      if (!v) need.push('не вказано первісну вартість за звітом про незалежну оцінку');
      if (!txt('appraisalRef')) need.push('не вказано реквізити звіту про оцінку');
      if (v && txt('appraisalRef')) {
        vp = decRound(v, 2);
        why.push(`IV цінова група: первісна вартість ${decUa(vp, 2)} грн — за звітом про оцінку (${txt('appraisalRef')}).`);
      }
    } else {
      const price = pos('price'), ki = pos('ki'), rate = pos('rate');
      if (!price) need.push(grp === 'III' ? 'не вказано ціну за контрактом в іноземній валюті' : 'не вказано ціну придбання');
      if (!ki || ki.n === 0n) need.push('не вказано коефіцієнт індексації');
      if (!txt('kiBasis')) need.push('не вказано підставу коефіцієнта індексації');
      if (grp === 'III' && (!rate || rate.n === 0n)) need.push('не вказано курс іноземної валюти на дату розрахунків');
      if (grp === 'III' && !txt('rateBasis')) need.push('не вказано валюту й дату курсу');
      if (price && ki && ki.n > 0n && txt('kiBasis') && (grp !== 'III' || (rate && rate.n > 0n && txt('rateBasis')))) {
        vp = decRound(grp === 'III' ? decMul(decMul(price, rate), ki) : decMul(price, ki), 2);
        why.push(grp === 'III'
          ? `III цінова група: Вп = Цк × КНБУ × Кі = ${decUa(price)} × ${decUa(rate)} × ${decUa(ki)} = ${decUa(vp, 2)} грн (${txt('rateBasis')}).`
          : `${grp} цінова група: Вп = ${grp === 'I' ? 'Цо(п)' : 'Цк'} × Кі = ${decUa(price, 2)} × ${decUa(ki)} = ${decUa(vp, 2)} грн.`);
        why.push(`Кі = ${decUa(ki)} — ${txt('kiBasis')}.`);
      }
    }
    // Недоукомплектоване майно: з первісної вартості виключається вартість того, чого бракує (пункт 9).
    let base = vp;
    if (txt('complete') === 'no') {
      const m = pos('missing');
      if (!m) need.push('не вказано первісну вартість відсутніх комплектувальних');
      if (!txt('missingBasis')) need.push('не вказано, яких комплектувальних бракує');
      if (m && vp && decCmp(m, vp) > 0) need.push('вартість відсутніх комплектувальних більша за первісну вартість');
      else if (m && vp && txt('missingBasis')) {
        base = decSub(vp, decRound(m, 2));
        why.push(`Недоукомплектоване (${txt('missingBasis')}): первісна вартість ${decUa(vp, 2)} − ${decUa(m, 2)} = ${decUa(base, 2)} грн (пункт 9).`);
      }
    } else if (txt('complete') !== 'yes') need.push('не вказано комплектність');
    // Сукупний коефіцієнт зносу.
    let k = null, ke = null, kz = null, kts = null;
    const rule = txt('method');
    if (rule === 'p10') {
      const p = ln.p10 || {};
      const got = (f) => String(p[f] ?? '').trim();
      const before = need.length;
      if (ed && !ed.p10) {
        need.push(`правило пункту 10 (Кскз = 1) діє з ${fmtDate(VAL_NORMS.p10since)}: на дату складання ${fmtDate(doc.date)} застосовується звичайний порядок пункту 21`);
      }
      if (!['destroyed', 'damaged'].includes(got('kind'))) need.push('не вказано, що сталося з майном: знищене (втрачене) чи пошкоджене без можливості відновлення');
      if (!['enemy', 'task'].includes(got('cause'))) need.push('не вказано обставину: дії противника чи виконання бойового (спеціального) завдання');
      if (!got('basis')) need.push('не вказано документ, що підтверджує обставини втрати');
      if (ed && ed.p10 === 'except') {
        if (!['yes', 'no'].includes(got('order'))) {
          need.push(`не вказано, чи було на ${fmtDate(VAL_NORMS.p10since)} видано наказ про списання цього майна без затвердженого єдиного акта списання`);
        } else if (got('order') === 'yes') {
          need.push(`виняток пункту 10: наказ про списання видано до ${fmtDate(VAL_NORMS.p10since)}, єдиний акт списання не затверджено — застосуйте звичайний порядок пункту 21`);
        }
      }
      if (ed && need.length === before) {
        k = decOf('1');
        why.push(`Кскз = 1 — абзац третій пункту 10 Методики (${ed.title}): майно ${got('kind') === 'destroyed' ? 'знищене (втрачене)'
          : 'пошкоджене, відновлення неможливе або економічно недоцільне'} ${got('cause') === 'enemy'
          ? 'внаслідок бойових або інших дій з боку противника' : 'у зв’язку з виконанням бойового (спеціального) завдання'}. Підстава: ${got('basis')}.`
          + (ed.p10 === 'except' ? ` Наказу про списання на ${fmtDate(VAL_NORMS.p10since)} без затвердженого єдиного акта не було.` : ''));
      }
    } else if (rule === 'p21') {
      const g = VAL_NORMS.groups.find((x) => x.id === txt('ng'));
      if (!g) need.push('не обрано нормативну групу майна (таблиця 26)');
      else if (txt('mode') === 'use') {
        const unit = txt('termUnit'), lim = g.use[unit], t = pos('term');
        if (!lim) need.push('не обрано одиницю строку експлуатації');
        else if (!t) need.push(`не вказано строк експлуатації ${VAL_UNIT[unit][1]}`);
        else {
          const i = valInterval(lim, t);
          ke = decOf(VAL_NORMS.ke[i]);
          why.push(`КЕ = ${decUa(ke)}: строк експлуатації ${decUa(t)} ${VAL_UNIT[unit][0]} — інтервал «${valIntervalText(lim, i, VAL_UNIT[unit][0])}» (таблиця 26, ${g.name}).`);
        }
      } else if (txt('mode') === 'store') {
        const t = pos('storeYears');
        if (!t) need.push('не вказано строк зберігання в роках');
        else if (g.storeGap && decCmp(t, decOf(g.storeGap[0])) > 0 && decCmp(t, decOf(g.storeGap[1])) <= 0) {
          // Інтервал у тексті таблиці неоднозначний: програма його не виправляє, а просить уточнення.
          const own = pos('keOwn');
          if (own && own.n > 0n && txt('keOwnBasis')) {
            ke = own;
            why.push(`КЕ = ${decUa(ke)} — за уточненням (${txt('keOwnBasis')}): для цієї групи інтервал зберігання понад 20 до 25 років у таблиці 26 записано «25 - 25 років».`);
          } else {
            need.push('таблиця 26: для переносного обладнання інтервал зберігання понад 20 до 25 років записано «25 - 25 років» — вкажіть КЕ й документ, яким його уточнено');
          }
        } else {
          const i = valInterval(VAL_NORMS.storeUpTo, t);
          ke = decOf(VAL_NORMS.keStore[i]);
          why.push(`КЕ = ${decUa(ke)}: строк зберігання ${decUa(t)} років — інтервал «${valIntervalText(VAL_NORMS.storeUpTo, i, 'років')}» (таблиця 26, ${g.name}).`);
        }
      } else need.push('не обрано, за чим визначається КЕ: строк експлуатації чи зберігання');
      const c = VAL_NORMS.kz[+txt('cond') - 1], cat = VAL_NORMS.kts[+txt('cat') - 1];
      if (!c) need.push('не обрано умови зберігання (таблиця 27)');
      else { kz = decOf(c[1]); why.push(`КЗ = ${decUa(kz)}: зберігання ${c[0]} (таблиця 27).`); }
      if (!cat) need.push('не вказано категорію якісного (технічного) стану');
      else { kts = decOf(cat); why.push(`КТС = ${decUa(kts)}: категорія ${VAL_ROMAN[+txt('cat') - 1]} (таблиця 27).`); }
      if (ke && kz && kts) {
        k = decMul(decMul(ke, kz), kts);
        why.push(`Кскз = КЕ × КЗ × КТС = ${decUa(ke)} × ${decUa(kz)} × ${decUa(kts)} = ${decUa(k)} (пункт 21 додатка 3).`);
      }
    } else need.push('не обрано спосіб розрахунку');
    // Нижня межа — вартість брухту (пункт 11): немає даних — це не нуль.
    let scrap = null;
    if (txt('scrap') === 'val') {
      scrap = pos('scrapVal');
      if (!scrap) need.push('не вказано вартість брухту');
      if (!txt('scrapBasis')) need.push('не вказано, чим визначено вартість брухту');
    } else if (txt('scrap') === 'na') {
      if (!txt('scrapBasis')) need.push('не вказано, чому нижня межа за вартістю брухту не застосовується');
    } else need.push('не вказано вартість брухту або що вона не застосовується');
    if (need.length || !base || !k || !qty) return { need, res: null };
    let unit = decMul(base, k);
    why.push(`Залишкова вартість одиниці: Взал = Вп × Кскз = ${decUa(base, 2)} × ${decUa(k)} = ${decUa(unit, 2)} грн.`);
    let floor = false;
    if (scrap && decCmp(scrap, unit) > 0) {
      floor = true;
      why.push(`Нижня межа (пункт 11): вартість брухту ${decUa(scrap, 2)} грн більша — залишкова вартість одиниці ${decUa(scrap, 2)} грн (${txt('scrapBasis')}).`);
      unit = decRound(scrap, 2);
    } else if (scrap) why.push(`Нижня межа (пункт 11): вартість брухту ${decUa(scrap, 2)} грн — на результат не впливає (${txt('scrapBasis')}).`);
    else why.push(`Нижня межа за вартістю брухту (пункт 11) не застосовується: ${txt('scrapBasis')}.`);
    const sum = decMul(unit, qty);
    const drop = decSub(base, unit);
    why.push(`Кількість ${decUa(qty)}: сума ${decUa(unit, 2)} × ${decUa(qty)} = ${decUa(sum, 2)} грн.`);
    if (drop.n > 0n) why.push(`Зменшення вартості одиниці проти первісної: ${decUa(drop, 2)} грн.`);
    why.push(`${VAL_NORMS.act}, ${ed.title}.`);
    return { need, res: { sig: valSig(ln, doc), ed: ed.id, norms: VAL_NORMS.id, rule, vp: decStr(vp, 2), base: decStr(base, 2),
      ke: ke ? decStr(ke) : '', kz: kz ? decStr(kz) : '', kts: kts ? decStr(kts) : '', k: decStr(k), unit: decStr(unit), sum: decStr(sum),
      drop: decStr(drop), floor, why } };
  }
  /** Розрахунок усієї відомості: рядки отримують результат або перелік того, чого бракує. */
  function valCalc(doc) {
    const bad = [];
    (doc.lines || []).forEach((ln, i) => {
      const { need, res } = valCalcLine(ln, doc);
      ln.res = res;
      for (const t of need) bad.push(`Рядок ${i + 1}: ${t}.`);
    });
    return bad;
  }
  /** Підсумок відомості — лише з актуальних розрахунків: сума точна, округлюється наприкінці. */
  function valTotal(doc) {
    let sum = decOf('0'), n = 0, stale = 0;
    for (const ln of doc.lines || []) {
      if (valStale(ln, doc)) { stale += 1; continue; }
      sum = decAdd(sum, decOf(ln.res.sum));
      n += 1;
    }
    return { sum: decStr(sum, 2), exact: decStr(sum), n, stale, ready: n > 0 && !stale };
  }

  // ========================================================= ДОКУМЕНТИ СЛУЖБИ
  /** Відомість залишкової вартості й акт якісного (технічного) стану — папери, які служба складає
   *  сама. Залишків, цін і проведених документів вони не чіпають: посилаються на майно з обліку
   *  й тримають копію його реквізитів на день складання. Стан: чернетка → підготовлено →
   *  затверджено (незмінна версія; виправлення — нова версія з причиною) або скасовано.
   *  «Затверджено» ставить людина; це позначка, а не підпис. */
  const PAPER = {
    valuation: { view: 'val', title: 'Залишкова вартість', crumb: 'техзасоби / залишкова вартість', one: 'відомість', acc: 'відомість',
      fresh: '+ Нова відомість', word: 'Відомість залишкової вартості', empty: 'Відомостей ще немає.', file: 'В Excel',
      form: 'Додаток 1 до Методики (постанова КМУ № 759), бланк програми 1' },
    tech_act: { view: 'yats', title: 'Акти ЯТС', crumb: 'техзасоби / акти якісного (технічного) стану', one: 'акт', acc: 'акт',
      fresh: '+ Новий акт', word: 'Акт якісного (технічного) стану', empty: 'Актів ще немає.', file: 'У Word',
      form: 'Додаток 1 до Порядку списання військового майна, бланк програми 1' },
  };
  const PAPER_OF_VIEW = { val: 'valuation', yats: 'tech_act' };
  const PAPER_TAG = { 'чернетка': 'tag--mv', 'підготовлено': 'tag--stock', 'затверджено': 'tag--in', 'скасовано': 'tag--ser' };
  const PAPER_UI = {};                                   // вид документа → { what, total, body, check, file }: заповнюють розділи нижче
  const papers = () => (Array.isArray(store.papers) ? store.papers : (store.papers = []));
  const paperById = (id) => papers().find((p) => p.id === id) || null;
  const paperNow = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return `${today()} ${z(d.getHours())}:${z(d.getMinutes())}`; };
  const paperOpen = (p) => p.state === 'чернетка';        // правиться лише чернетка
  const paperName = (p) => `${PAPER[p.kind].word} ${numNo(p.no || 'б/н')}${p.date ? ` від ${fmtDate(p.date)}` : ''}`;
  /** Час зміни й, для істотного, рядок історії документа. */
  function paperMark(p, what = '') {
    p.changed = paperNow();
    if (what) (p.history = p.history || []).push({ at: p.changed, what });
  }
  /** Підписант у документі — як він виглядав на дату документа: посада, звання, ім'я. */
  const sgOf = (person, date) => (person ? Object.assign({ pid: person.id }, signer(person, date)) : { pid: '', pos: '', rank: '', name: '' });
  const sgSlot = (p, slot) => (slot.startsWith('m:') ? (p.members || [])[+slot.slice(2)] : p[slot]);
  const sgFilled = (s) => !!(s && String(s.name || '').trim());

  function paperNew(kind) {
    const date = today();
    const p = { id: `p${uid().slice(1)}${uid().slice(1)}`, kind, no: '', date, state: 'чернетка', ver: 1, created: paperNow(), changed: '',
      basis: '', note: '', lines: [], versions: [], history: [],
      approver: sgOf(officialAt('командир', date), date), head: sgOf(null), members: [], agree: sgOf(officialAt('начальник служби', date), date) };
    Object.assign(p, PAPER_UI[kind].blank(date));
    papers().push(p);
    paperMark(p, 'створено');
    return p;
  }
  /** Копія — нова чернетка з тим самим змістом; розрахунок у ній треба повторити. */
  function paperCopy(src) {
    const p = JSON.parse(JSON.stringify(src));
    Object.assign(p, { id: `p${uid().slice(1)}${uid().slice(1)}`, no: '', date: today(), state: 'чернетка', ver: 1, created: paperNow(), changed: '',
      approved: '', fixReason: '', versions: [], history: [] });
    for (const ln of p.lines || []) { ln.id = uid(); delete ln.res; }
    papers().push(p);
    paperMark(p, `скопійовано з ${numNo(src.no || 'б/н')} від ${fmtDate(src.date)}`);
    return p;
  }
  /** Знімок документа для незмінної версії: усе, крім самих версій та історії. */
  function paperSnap(p) {
    const body = JSON.parse(JSON.stringify(p));
    delete body.versions; delete body.history;
    return body;
  }

  function paperSpec(kind) {
    const K = PAPER[kind], U = PAPER_UI[kind];
    const rows = papers().filter((p) => p.kind === kind);
    return {
      id: `pv-${K.view}`, rows, minWidth: '1000px', limit: REG_LIMIT,
      placeholder: 'Пошук: номер, майно, підрозділ, підстава',
      search: (p) => [p.no, p.sub || '', p.basis || '', p.state].concat((p.lines || []).flatMap((l) => [l.name, l.code, l.serial || ''])),
      filters: [
        { type: 'seg', key: 'st', options: [['', 'усі'], ['чернетка', 'чернетки'], ['підготовлено', 'підготовлені'], ['затверджено', 'затверджені'],
          ['скасовано', 'скасовані']], test: (p, v) => p.state === v },
        { type: 'period', key: 'd', label: 'дата', get: (p) => p.date },
      ],
      columns: [
        { key: 'date', label: 'дата', cls: 'c-date', sort: (p) => p.date || '', cell: (p) => fmtDate(p.date) },
        { key: 'no', label: '№', cls: 'c-code', style: 'width:110px', first: 1, sort: (p) => p.no || '', cell: (p) => `<b>${esc(p.no || 'б/н')}</b>` },
        { key: 'what', label: 'майно', cls: 'c-name c-name--stack', first: 1, sort: (p) => U.what(p), cellTitle: (p) => U.what(p),
          cell: (p) => `<b>${esc(U.what(p) || '—')}</b><small>${esc([p.sub, p.basis].filter(Boolean).join(' · '))}</small>` },
        { key: 'n', label: 'рядків', cls: 'c-num', style: 'width:64px', sort: (p) => (p.lines || []).length, cell: (p) => String((p.lines || []).length || '—') },
        { key: 'sum', label: 'сума, грн', cls: 'c-num', style: 'width:124px', sort: (p) => +U.total(p).sum || 0,
          cell: (p) => { const t = U.total(p); return t.ready ? decUa(decOf(t.sum), 2) : '<span class="c-num--dim">не розраховано</span>'; } },
        { key: 'state', label: 'стан', cls: 'c-tag', style: 'width:130px', first: 1, sort: (p) => PAPER_STATES.indexOf(p.state),
          cell: (p) => `<span class="tag ${PAPER_TAG[p.state] || ''}">${esc(p.state)}</span>${p.ver > 1 ? `<small>версія ${p.ver}</small>` : ''}` },
      ],
      row: (p) => ({ attrs: `data-act="paper-open" data-id="${esc(p.id)}"` }),
      count: (shown, all) => (shown.length === all.length ? String(all.length) : `${shown.length} із ${all.length}`),
      empty: K.empty,
    };
  }
  const PAPER_STATES = ['чернетка', 'підготовлено', 'затверджено', 'скасовано'];

  /** Рядок підписанта: посада, звання, ім'я — текстом, як стоятиме в папері; вибір із довідника
   *  людей підставляє те, що в людини було на дату документа. */
  function sgRow(p, slot, label, ro) {
    const s = sgSlot(p, slot) || {};
    const dis = ro ? ' disabled' : '';
    const inp = (k, ph, style) => `<div class="c-txt" style="${style}"><input class="rc-in rc-in--wide" style="width:100%;text-align:left"
      data-sg="${slot}" data-k="${k}" data-fid="sg:${slot}:${k}" value="${esc(s[k] || '')}" placeholder="${ph}" autocomplete="off"${dis}></div>`;
    const people = (store.people || []).filter((x) => x.surname).sort((a, b) => String(a.surname).localeCompare(String(b.surname), 'uk'));
    return `<div class="tbl__row tbl__row--plain">
      <div class="c-txt" style="flex:0 0 132px"><b>${esc(label)}</b></div>
      ${inp('pos', 'посада', 'flex:2 1 220px')}${inp('rank', 'звання', 'flex:0 0 140px')}${inp('name', 'Ім’я ПРІЗВИЩЕ', 'flex:1 1 170px')}
      <div class="c-acts" style="flex-basis:220px">${ro ? '' : `<select data-sg-pick="${slot}" aria-label="людина з довідника" style="max-width:150px">
        <option value="">з довідника…</option>${people.map((x) => `<option value="${esc(x.id)}">${esc(pShort(x))}</option>`).join('')}</select>${
        slot.startsWith('m:') ? rowBtn('paper-member-del', '✕', `data-i="${slot.slice(2)}"`, { bad: true, title: 'Прибрати члена комісії' }) : ''}`}</div></div>`;
  }
  function paperSigners(p, ro, slots) {
    const members = (p.members || []).map((_, i) => sgRow(p, `m:${i}`, i ? '' : 'Члени комісії', ro)).join('');
    return `<div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Комісія й підписи</div>
        <div class="panel__spacer"></div>${ro ? '' : '<button type="button" class="btn btn--sm" data-act="paper-member-add">+ Член комісії</button>'}</div>
      <div class="tbl" style="--tbl-min:auto">${slots.map(([slot, label]) => (slot === 'members' ? members : sgRow(p, slot, label, ro))).join('')}</div></div>`;
  }

  /** Що можна зробити з документом у його стані. */
  function paperStateBar(p, viewing) {
    const K = PAPER[p.kind];
    const b = (act, label, cls = '', title = '') => `<button type="button" class="btn ${cls}" data-act="${act}"${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
    const acts = [];
    if (viewing) acts.push(b('paper-ver', 'До поточної версії'));
    else {
      if (p.state === 'чернетка') acts.push(b('paper-ready', 'Підготовлено →', 'btn--primary', 'Документ повний: далі його затверджують'));
      if (p.state === 'підготовлено') acts.push(b('paper-approve', 'Затвердити…', 'btn--primary', 'Затверджену версію змінити не можна'), b('paper-draft', 'Повернути в чернетку'));
      if (p.state === 'затверджено') acts.push(b('paper-fix', 'Виправити…', '', 'Нова версія з причиною; затверджена лишається доступною'));
      acts.push(b('paper-copy', 'Копіювати'));
      if (p.state !== 'скасовано') acts.push(b('paper-cancel', 'Скасувати…', 'btn--danger'));
      if (p.state === 'чернетка' && !(p.versions || []).length) acts.push(b('paper-del', 'Видалити', 'btn--danger'));
    }
    const ver = viewing ? (p.versions || []).find((v) => v.ver === state.paperVer) : null;
    return `<div class="card" style="margin-bottom:12px"><div class="card__head">
      <span class="tag ${PAPER_TAG[viewing ? 'затверджено' : p.state] || ''}">${esc(viewing ? 'затверджено' : p.state)}</span>
      <span class="panel__count">${viewing ? `версія ${ver.ver}, затверджена ${fmtStamp(ver.at)}; поточна — версія ${p.ver}, ${esc(p.state)}`
    : `версія ${p.ver}${p.fixReason ? ` · виправлення: ${esc(p.fixReason)}` : ''} · створено ${fmtStamp(p.created)}${
      p.changed ? ` · змінено ${fmtStamp(p.changed)}` : ''}`}</span>
      <div class="panel__spacer"></div>${acts.join('')}</div>
      ${!viewing && p.state !== 'чернетка' ? `<div class="pad" style="padding-top:12px"><div class="callout">${
      p.state === 'підготовлено' ? `Підготовлений документ не правиться. Після підписання натисніть «Затвердити…»; щоб змінити — «Повернути в чернетку».`
        : p.state === 'затверджено' ? `Затверджена версія незмінна. «Виправити…» відкриє нову версію, а ця лишиться в переліку версій.`
          : `Документ скасовано. Його можна переглянути, вивантажити й скопіювати.`}</div></div>` : ''}</div>`;
  }
  /** Версії й історія: затверджені версії лишаються як були — їх можна відкрити й вивантажити. */
  function paperHistory(p) {
    const vers = (p.versions || []).slice().reverse().map((v) => `<div class="tbl__row tbl__row--plain">
      <div class="c-txt" style="flex:0 0 110px"><b>версія ${v.ver}</b></div><div class="c-txt" style="flex:0 0 150px">${esc(fmtStamp(v.at))}</div>
      <div class="c-txt">${esc(v.reason ? `виправлення: ${v.reason}` : 'перше затвердження')}</div>
      <div class="c-acts" style="flex-basis:220px">${rowBtn('paper-ver', 'Відкрити', `data-v="${v.ver}"`)}${rowBtn('paper-file', PAPER[p.kind].file, `data-v="${v.ver}"`)}</div></div>`).join('');
    const hist = (p.history || []).slice().reverse().map((h) => `<div class="tbl__row tbl__row--plain">
      <div class="c-txt" style="flex:0 0 150px">${esc(fmtStamp(h.at))}</div><div class="c-txt" style="white-space:normal">${esc(h.what)}</div></div>`).join('');
    // Розгорнута картка лишається розгорнутою й після перемальовування (запис, перевірка файлів).
    return `<details class="fold card" style="margin-bottom:12px" data-paper-hist${state.paperHist ? ' open' : ''}>
      <summary class="card__head"><div class="card__title">Версії й історія</div><span class="fold__hint">${
      cnt((p.versions || []).length, 'затверджена версія', 'затверджені версії', 'затверджених версій')}</span></summary>
      <div class="tbl" style="--tbl-min:auto">${vers}${hist}</div></details>`;
  }

  function renderPapers(kind) {
    const K = PAPER[kind], U = PAPER_UI[kind];
    const p = state.paperId ? paperById(state.paperId) : null;
    if (!p || p.kind !== kind) {
      state.paperId = null; state.paperVer = 0; state.paperBad = null;
      const reg = registry(paperSpec(kind));
      return { fill: true, head: head(K.crumb, K.title, `<button class="btn btn--primary" data-act="paper-new" data-pk="${kind}">${K.fresh}</button>`),
        body: `${flashBlock()}${reg.panel}<div class="card card--scroll card--fill">${reg.table}</div>` };
    }
    const ver = state.paperVer ? (p.versions || []).find((v) => v.ver === state.paperVer) : null;
    if (!ver) state.paperVer = 0;
    const doc = ver ? Object.assign({ versions: [], history: [] }, ver.body) : p;
    const ro = !!ver || !paperOpen(p);
    const bad = !ver && state.paperBad && state.paperBad.length ? `<div class="callout callout--bad" style="margin-bottom:12px">${
      state.paperBad.slice(0, 12).map(esc).join('<br>')}${state.paperBad.length > 12 ? `<br>і ще ${state.paperBad.length - 12}` : ''}</div>` : '';
    return {
      head: head(K.crumb, `${K.word} ${numNo(doc.no || 'б/н')}`, `<button class="btn" data-act="paper-close">← До переліку</button>
        ${U.actions(doc, ro)}<button class="btn${ro ? ' btn--primary' : ''}" data-act="paper-file"${ver ? ` data-v="${ver.ver}"` : ''}>${K.file}</button>`),
      body: `${flashBlock()}${bad}${paperStateBar(p, !!ver)}${U.body(doc, ro)}
        ${ver ? '' : filesCard(`paper|${p.id}`, 'Підписаний документ і додатки', 'скан підписаного примірника')}${ver ? '' : paperHistory(p)}`,
    };
  }

  function bindPapers() {
    if (!PAPER_OF_VIEW[state.view] || !state.paperId) return;
    const sc = $('#scroll');
    sc.querySelector('[data-paper-hist]')?.addEventListener('toggle', (e) => { state.paperHist = e.target.open; });
    const p = paperById(state.paperId);
    if (!p || !paperOpen(p) || state.paperVer) return;
    // Табуляція вже перевела фокус у наступне поле: після перемальовування повертаємо його туди ж.
    const after = () => {
      paperMark(p);
      save();
      const fid = ((document.activeElement || {}).dataset || {}).fid;
      render();
      const again = fid ? [...$('#scroll').querySelectorAll('[data-fid]')].find((x) => x.dataset.fid === fid) : null;
      if (again) again.focus();
    };
    sc.querySelectorAll('[data-pf]').forEach((el) => el.addEventListener('change', () => { p[el.dataset.pf] = el.value.trim(); after(); }));
    sc.querySelectorAll('[data-sg]').forEach((el) => el.addEventListener('change', () => {
      const s = sgSlot(p, el.dataset.sg);
      if (s) { s[el.dataset.k] = el.value.trim(); s.pid = ''; after(); }
    }));
    sc.querySelectorAll('[data-sg-pick]').forEach((el) => el.addEventListener('change', () => {
      const person = personBy(el.value);
      if (!person) return;
      const slot = el.dataset.sgPick;
      if (slot.startsWith('m:')) p.members[+slot.slice(2)] = sgOf(person, p.date);
      else p[slot] = sgOf(person, p.date);
      after();
    }));
    PAPER_UI[p.kind].bind(p, sc, after);
  }

  /** Дії над документом: стан, версії, копія, видалення. Решта — у розділі виду документа. */
  function paperAction(act, d) {
    switch (act) {
      case 'paper-new': { const fresh = paperNew(d.pk); save(); return go(PAPER[fresh.kind].view, { paperId: fresh.id, paperVer: 0, paperBad: null }); }
      case 'paper-open': { const x = paperById(d.id); return x ? go(PAPER[x.kind].view, { paperId: x.id, paperVer: 0, paperBad: null }) : null; }
      default: break;
    }
    const p = paperById(state.paperId);
    if (!p) return null;
    const K = PAPER[p.kind], U = PAPER_UI[p.kind];
    // Слово про зміну стану — після того, як її записано.
    const done = (what, said) => { paperMark(p, what); state.paperBad = null; render(); if (said) saveThen(said); else save(true); };
    switch (act) {
      case 'paper-close': return go(K.view, { paperId: null, paperVer: 0, paperBad: null });
      case 'paper-ver': state.paperVer = +d.v || 0; return render();
      case 'paper-file': {
        const v = +d.v ? (p.versions || []).find((x) => x.ver === +d.v) : null;
        return U.file(v ? Object.assign({ versions: [], history: [] }, v.body) : p);
      }
      case 'paper-member-add': if (paperOpen(p)) { (p.members = p.members || []).push(sgOf(null)); paperMark(p); save(); render(); } return null;
      case 'paper-member-del': if (paperOpen(p)) { p.members.splice(+d.i, 1); paperMark(p); save(); render(); } return null;
      case 'paper-ready': {
        const bad = U.check(p, 'ready');
        if (bad.length) { state.paperBad = bad; render(); return toast(`До готового документа бракує: ${cnt(bad.length, 'пункт', 'пункти', 'пунктів')}.`, true); }
        p.state = 'підготовлено';
        return done('підготовлено', `${paperName(p)}: підготовлено.`);
      }
      case 'paper-draft': p.state = 'чернетка'; return done('повернуто в чернетку');
      case 'paper-approve': {
        const date = String(prompt('Дата затвердження (РРРР-ММ-ДД)', p.approved || today()) || '').trim();
        if (!date) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return toast('Дату затвердження вкажіть як РРРР-ММ-ДД.', true);
        if (p.date && date < p.date) return toast('Дата затвердження раніша за дату складання.', true);
        const bad = U.check(p, 'approve');
        if (bad.length) { state.paperBad = bad; render(); return toast('Документ неповний: затвердити його не можна.', true); }
        p.approved = date;
        p.state = 'затверджено';
        // Затверджена версія тримає й те, що в налаштуваннях може змінитися: реквізити частини й бланк.
        p.unit = { name: unitInfo().legalName, code: unitCode(), service: unitInfo().serviceFull };
        p.form = K.form;
        (p.versions = p.versions || []).push({ ver: p.ver, at: paperNow(), reason: p.fixReason || '', body: paperSnap(p) });
        logChange('документ затверджено', `paper|${p.id}`, `${paperName(p)}, версія ${p.ver}`);
        return done(`затверджено ${fmtDate(date)}, версія ${p.ver}`, `${paperName(p)}: затверджено, версія ${p.ver}.`);
      }
      case 'paper-fix': {
        const reason = String(prompt('Причина виправлення затвердженого документа') || '').trim();
        if (!reason) return null;
        p.ver += 1; p.state = 'чернетка'; p.fixReason = reason; p.approved = '';
        logChange('документ виправляється', `paper|${p.id}`, `${paperName(p)}, версія ${p.ver}: ${reason}`);
        return done(`відкрито версію ${p.ver} для виправлення: ${reason}`);
      }
      case 'paper-cancel': {
        const reason = String(prompt(`Скасувати ${K.acc} ${numNo(p.no || 'б/н')}? Причина скасування`) || '').trim();
        if (!reason) return null;
        p.state = 'скасовано';
        logChange('документ скасовано', `paper|${p.id}`, `${paperName(p)}: ${reason}`);
        return done(`скасовано: ${reason}`);
      }
      case 'paper-copy': { const c = paperCopy(p); save(); return go(K.view, { paperId: c.id, paperVer: 0, paperBad: null, flash: `Копію створено: це нова чернетка.` }); }
      case 'paper-del': {
        if (!paperOpen(p) || (p.versions || []).length) return null;
        if (!confirm(`Видалити чернетку «${paperName(p)}»?`)) return null;
        store.papers = papers().filter((x) => x !== p);
        store.scans = (store.scans || []).filter((x) => x.key !== `paper|${p.id}`);
        logChange('чернетку видалено', `paper|${p.id}`, paperName(p));
        save(true, true);
        return go(K.view, { paperId: null, paperVer: 0, paperBad: null });
      }
      default: return U.action(act, d, p);
    }
  }

  // ======================================================= ЗАЛИШКОВА ВАРТІСТЬ
  /** Відомість щодо визначення залишкової вартості військового майна (Додаток 1 до Методики).
   *  Рядок — майно з обліку однієї ціни й одних параметрів: посилання на джерело (партія
   *  надходження, одиниця з номером, запис про знищення, рядок документа) і копія реквізитів.
   *  Параметри розрахунку вводить людина; коефіцієнти й суми рахує valCalcLine. */
  const VAL_TEXT = ['name', 'uom', 'serial', 'inv', 'acq', 'note'];
  const VAL_KEEP = '∅';                                   // у формі «для всіх рядків»: поле не змінювати
  const VAL_P10_KIND = [['destroyed', 'знищене (втрачене)'], ['damaged', 'пошкоджене, відновлення неможливе або економічно недоцільне']];
  const VAL_P10_CAUSE = [['enemy', 'бойові або інші дії противника'], ['task', 'виконання бойового (спеціального) завдання']];
  const valLine = (o) => Object.assign({ id: uid(), src: { kind: 'manual', label: 'внесено вручну' }, code: '', name: '', uom: '', serial: '', inv: '',
    qty: '', price: '', acq: '', note: '' }, o);
  const valMoney = (x) => (x == null || x === '' ? '' : (+x).toFixed(2));
  const valQty = (x) => String(round3(+x || 0));
  const valDocLabel = (r) => `${r.t || 'документ'} ${numNo(r.no)} від ${fmtDate(r.d)}${r.from ? `, ${r.from}` : ''}`;
  /** Партії позиції — рядки надходжень із ціною, від давніх до нових. */
  function valBatches(code) {
    const by = new Map();
    for (const r of docs) {
      if (r.kind !== 'in' || r.code !== code) continue;
      const price = +r.price || 0;
      const k = `${keyOfRow(r)}|${price.toFixed(2)}`;
      const x = by.get(k) || { doc: keyOfRow(r), id: r.id || 0, d: r.d, price, q: 0, acq: r.lot || r.d, label: valDocLabel(r) };
      x.q = round3(x.q + (+r.q || 0));
      by.set(k, x);
    }
    return [...by.values()].sort((a, b) => a.d.localeCompare(b.d));
  }
  /** Знищене за записом рапорту — частинами за цінами партій підрозділу на день події; чого
   *  партії не покривають, лишається без ціни: її вкаже людина, а не довідник. */
  function valDzParts(r) {
    if (r.price != null && String(r.price).trim() !== '') return [{ price: +r.price || 0, q: +r.qty || 0, d: '' }];
    if (r.unit) {
      const a = unitArrival(r.unit, r.date, null);
      return [{ price: a ? +a.price || 0 : null, q: 1, d: a ? a.lot || a.d : '' }];
    }
    const out = [];
    let need = +r.qty || 0;
    for (const l of lotsAt(r.date).get(`${r.sub}|${r.code}`) || []) {
      if (need <= 1e-9) break;
      if (l.q <= 1e-9) continue;
      const t = Math.min(need, l.q);
      const same = out.find((x) => Math.abs(x.price - l.price) < 0.005);
      if (same) same.q = round3(same.q + t); else out.push({ price: +l.price || 0, q: round3(t), d: l.d });
      need = round3(need - t);
    }
    if (need > 1e-9) out.push({ price: null, q: need, d: '' });
    return out;
  }
  /** Інвентарний номер для паперу — той, під яким майно веде ФЕС (необоротний актив). Власний
   *  номер служби з бирки («код/NNN») у документ не йде: це внутрішня позначка, комісія й ФЕС
   *  звіряють за номером ФЕС. Запаси інвентарного номера не мають. */
  const fesInvNo = (it) => (it && it.fes && it.nonrev ? String(it.fes) : '');
  function valLineOf(code, o) {
    const it = itemBy.get(code) || {};
    return valLine(Object.assign({ code, name: cleanName(it.name || code), uom: it.unit || '', inv: fesInvNo(it) }, o));
  }
  function valLinesOfUnit(id, date) {
    const u = unitBy.get(String(id));
    const a = u ? unitArrival(u.id, '9999-12-31', null) : null;
    if (!u) return [];
    return [valLineOf(u.code, { src: { kind: 'unit', unit: String(u.id), doc: a ? keyOfRow(a) : '', label: `${unitLabel(u)}${a ? `; ${valDocLabel(a)}` : ''}`,
      holder: unitHolderAt(u.id, date, null) || '' }, serial: u.serial || '', qty: '1', price: a ? valMoney(a.price) : '',
    acq: a ? a.lot || a.d : '' })];
  }
  function valLinesOfDz(r) {
    if (r.unit && unitBy.get(String(r.unit))) {
      return valLinesOfUnit(r.unit, r.date).map((ln) => Object.assign(ln, { src: Object.assign(ln.src, { kind: 'dz', dz: r.id }),
        note: r.report ? `рапорт ${numNo(r.report)}${r.reportDate ? ` від ${fmtDate(r.reportDate)}` : ''}` : '' }));
    }
    return valDzParts(r).map((part) => valLineOf(r.code, { src: { kind: 'dz', dz: r.id, sub: r.sub,
      label: `рапорт ${numNo(r.report || 'б/н')}${r.reportDate ? ` від ${fmtDate(r.reportDate)}` : ''}, ${r.sub}, подія ${fmtDate(r.date)}` },
    qty: valQty(part.q), price: part.price == null ? '' : valMoney(part.price), acq: part.d || '',
    note: r.report ? `рапорт ${numNo(r.report)}${r.reportDate ? ` від ${fmtDate(r.reportDate)}` : ''}` : '' }));
  }
  function valLinesOfDoc(key, picked = null) {
    const out = [];
    docs.filter((r) => keyOfRow(r) === key).forEach((r, i) => {
      if (picked && !picked.has(i)) return;
      const u = r.unit ? unitBy.get(String(r.unit)) : null;
      for (const part of rowParts(r)) {
        out.push(valLineOf(r.code, { src: { kind: 'doc', doc: key, unit: u ? String(u.id) : '', label: valDocLabel(r) }, serial: u ? u.serial || '' : '',
          qty: valQty(part.q), price: valMoney(part.price), acq: part.d || (r.kind === 'in' ? r.d : '') }));
      }
    });
    return out;
  }

  PAPER_UI.valuation = {
    blank: (date) => ({ asOf: date, approved: '', sub: '', copies: '' }),
    what: (p) => { const l = p.lines || []; return l.length ? `${l[0].name || l[0].code || 'майно'}${l.length > 1 ? ` і ще ${l.length - 1}` : ''}` : ''; },
    total: (p) => valTotal(p),
    actions: (p, ro) => (ro ? '' : '<button class="btn btn--primary" data-act="val-calc">Розрахувати</button>'),
    check: valCheck,
    body: valBody,
    bind: () => {},
    file: valFile,
    action: valAction,
  };

  /** Чого бракує відомості до готового документа. */
  function valCheck(p) {
    const bad = [];
    if (!String(p.no || '').trim()) bad.push('Не вказано номер відомості.');
    if (!p.date) bad.push('Не вказано дату складання.');
    if (!p.asOf) bad.push('Не вказано дату оцінки («станом на»).');
    if (!String(p.basis || '').trim()) bad.push('Не вказано підставу відомості.');
    if (!(p.lines || []).length) bad.push('У відомості немає жодного рядка.');
    (p.lines || []).forEach((ln, i) => {
      if (!String(ln.name || '').trim()) bad.push(`Рядок ${i + 1}: не вказано найменування.`);
      const { need } = valCalcLine(ln, p);
      for (const t of need) bad.push(`Рядок ${i + 1}: ${t}.`);
      if (!need.length && valStale(ln, p)) bad.push(`Рядок ${i + 1}: розрахунок неактуальний — натисніть «Розрахувати».`);
    });
    if (!sgFilled(p.approver)) bad.push('Не вказано, хто затверджує відомість.');
    if (!sgFilled(p.head)) bad.push('Не вказано голову комісії.');
    if (!(p.members || []).some(sgFilled)) bad.push('Не вказано жодного члена комісії.');
    return bad;
  }

  function valBody(p, ro) {
    const dis = ro ? ' disabled' : '';
    const ed = valEdition(p.date);
    const f = (field, label, type = 'text', span = '', extra = '') => `<div class="field${span}"><label>${label}</label>
      <input type="${type}" data-pf="${field}" data-fid="pf:${field}" value="${esc(p[field] || '')}" autocomplete="off"${extra}${dis}></div>`;
    const total = valTotal(p);
    const rows = (p.lines || []).map((ln, i) => {
      const need = valFrozen(p) ? [] : valCalcLine(ln, p).need;
      const stale = valStale(ln, p);
      const r = stale ? null : ln.res;
      const mark = need.length ? `<small class="num-bad">${esc(need[0])}${need.length > 1 ? ` і ще ${need.length - 1}` : ''}</small>`
        : stale ? '<small class="num-warn">розрахунок неактуальний</small>' : '';
      const d = (s, n = null) => (s === '' || s == null ? '—' : decUa(decOf(s), n));
      return `<div class="tbl__row${r ? '' : ' is-due'}" data-act="val-why" data-id="${esc(ln.id)}" title="${esc(need.join('; ') || 'Пояснення розрахунку')}">
        <div class="c-num c-num--dim" style="width:34px">${i + 1}</div>
        <div class="c-name c-name--stack" style="flex:2 1 220px"><b>${esc(ln.name || '—')}</b><small>${esc([ln.code, ln.serial ? `зав. № ${ln.serial}` : '',
          ln.inv ? `інв. № ${ln.inv}` : '', (ln.src || {}).label || ''].filter(Boolean).join(' · '))}</small>${mark}</div>
        <div class="c-num" style="width:64px">${decOf(ln.qty) ? decUa(decOf(ln.qty)) : '—'}<small>${esc(ln.uom || '')}</small></div>
        <div class="c-num" style="width:104px">${decOf(ln.price) ? decUa(decOf(ln.price), 2) : '—'}<small>${esc(String(ln.acq || '').slice(0, 4))}</small></div>
        <div class="c-num" style="width:104px">${r ? d(r.base, 2) : '—'}<small>${ln.group === 'IV' ? 'оцінка' : decOf(ln.ki) ? `Кі ${decUa(decOf(ln.ki))}` : ''}</small></div>
        <div class="c-num" style="width:96px">${r ? (r.rule === 'p10' ? 'пункт 10' : `${d(r.ke)} · ${d(r.kz)} · ${d(r.kts)}`) : '—'}</div>
        <div class="c-num" style="width:60px">${r ? `<b>${d(r.k)}</b>` : '—'}</div>
        <div class="c-num" style="width:104px">${r ? d(r.unit, 2) : '—'}${r && r.floor ? '<small>брухт</small>' : ''}</div>
        <div class="c-num" style="width:112px">${r ? `<b>${d(r.sum, 2)}</b>` : '—'}</div>
        <div class="c-acts" style="flex-basis:150px">${ro ? '' : rowBtn('val-line', '✎ Параметри', `data-id="${esc(ln.id)}"`, { main: !r })
          + rowBtn('val-line-del', '✕', `data-id="${esc(ln.id)}"`, { bad: true, title: 'Прибрати рядок' })}</div></div>`;
    }).join('');
    const subsList = `<datalist id="val-subs">${subs.map((s) => `<option value="${esc(s.name)}">`).join('')}</datalist>`;
    const acts = papers().filter((x) => x.kind === 'tech_act' && x.valId === p.id && x.state !== 'скасовано');
    return `<div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Реквізити</div>
        <div class="panel__spacer"></div><span class="panel__count" title="${esc(VAL_NORMS.act)}">${ed ? `Методика: ${esc(ed.title)}`
    : 'редакцію Методики визначає дата складання'}</span></div>
      <div class="form__grid">${f('no', 'Номер відомості')}${f('date', 'Дата складання', 'date')}${f('asOf', 'Станом на (дата оцінки)', 'date')}
        ${f('approved', 'Дата затвердження', 'date')}${f('sub', 'Підрозділ або призначення', 'text', '', ' list="val-subs"')}
        ${f('basis', 'Підстава: рапорт чи наказ, номер і дата', 'text', ' field--span2')}
        ${f('copies', 'Примірники', 'text', ' field--span2', ' placeholder="примірник № 1 — …; примірник № 2 — …"')}
        ${f('note', 'Примітка під таблицею', 'text', ' field--span2')}</div>${subsList}</div>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Майно й розрахунок</div>
        <div class="panel__spacer"></div><span class="panel__count">${total.ready ? `разом ${decUa(decOf(total.sum), 2)} грн`
    : (p.lines || []).length ? `не розраховано рядків: ${total.stale}` : ''}</span>
        ${acts.map((a) => `<button type="button" class="btn btn--sm" data-act="paper-open" data-id="${esc(a.id)}">Акт ЯТС ${esc(numNo(a.no || 'б/н'))}</button>`).join('')}
        ${(p.lines || []).length ? `<button type="button" class="btn btn--sm" data-act="val-to-act"
          title="Новий акт якісного (технічного) стану з майном і комісією цієї відомості">Акт ЯТС за відомістю</button>` : ''}
        ${ro ? '' : `<button type="button" class="btn btn--sm" data-act="val-bulk" title="Однакові параметри — усім рядкам одразу">Заповнити всі рядки…</button>
        <button type="button" class="btn btn--sm btn--primary" data-act="val-pick">+ Додати майно</button>`}</div>
      ${(p.lines || []).some((ln) => ln.method === 'p10') ? `<div class="panel"><div class="panel__note">Для майна, знищеного чи втраченого внаслідок бойових дій,
        акт технічного стану для цілей оцінки не складається (абзац п’ятий пункту 4 Методики).</div></div>` : ''}
      <div class="card--scroll"><div class="tbl" style="--tbl-min:1060px"><div class="tbl__head">
        <div class="tbl__h c-num" style="width:34px">№</div><div class="tbl__h c-name" style="flex:2 1 220px">найменування, номер, джерело</div>
        <div class="tbl__h c-num" style="width:64px">к-сть</div><div class="tbl__h c-num" style="width:104px" title="Ціна придбання й рік взяття на облік">ціна · рік</div>
        <div class="tbl__h c-num" style="width:104px" title="Первісна вартість">первісна</div>
        <div class="tbl__h c-num" style="width:96px" title="Коефіцієнти експлуатації, умов зберігання, технічного стану">Ке · Кз · Ктс</div>
        <div class="tbl__h c-num" style="width:60px" title="Сукупний коефіцієнт зносу">Кскз</div>
        <div class="tbl__h c-num" style="width:104px" title="Залишкова вартість одиниці">залишкова</div>
        <div class="tbl__h c-num" style="width:112px">сума, грн</div><div class="tbl__h c-acts" style="flex-basis:150px"></div></div>
        ${rows || `<div class="tbl__row tbl__row--plain"><div class="c-txt">${ro ? 'Рядків немає.' : 'Додайте майно з обліку: «+ Додати майно».'}</div></div>`}
        ${(p.lines || []).length ? `<div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-num" style="width:34px"></div>
          <div class="c-name" style="flex:2 1 220px"><b>На загальну суму</b></div><div class="c-num" style="width:64px"></div>
          <div class="c-num" style="width:104px"></div><div class="c-num" style="width:104px"></div><div class="c-num" style="width:96px"></div>
          <div class="c-num" style="width:60px"></div><div class="c-num" style="width:104px"></div>
          <div class="c-num" style="width:112px"><b>${total.ready ? decUa(decOf(total.sum), 2) : '—'}</b></div>
          <div class="c-acts" style="flex-basis:150px"></div></div>` : ''}</div></div></div>
      ${paperSigners(p, ro, [['approver', 'Затверджує'], ['head', 'Голова комісії'], ['members', ''], ['agree', 'Погоджено']])}`;
  }

  /** Поля параметрів розрахунку — для одного рядка або для всіх одразу (bulk: порожнє й
   *  «не змінювати» лишають значення рядка як було). Видно лише те, що потрібне обраному способу. */
  function valParamsHtml(v, ed, bulk) {
    const first = bulk ? [[VAL_KEEP, '— не змінювати —']] : [['', '— оберіть —']];
    const cur = (name) => (v[name] == null || (bulk && v[name] === '') ? (bulk ? VAL_KEEP : '') : String(v[name]));
    const on = (name, ...vals) => (bulk && cur(name) === VAL_KEEP) || vals.includes(cur(name));
    const sel = (name, label, options, span = '') => `<div class="field${span}"><label>${label}</label><select name="${name}">${
      first.concat(options).map(([val, text]) => `<option value="${esc(val)}"${cur(name) === String(val) ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></div>`;
    const inp = (name, label, span = '') => `<div class="field${span}"><label>${label}</label>
      <input name="${name}" value="${esc(v[name] ?? '')}" autocomplete="off"${bulk ? ' placeholder="не змінювати"' : ''}></div>`;
    const g = VAL_NORMS.groups.find((x) => x.id === cur('ng'));
    const units = g ? Object.keys(g.use) : Object.keys(VAL_UNIT);
    const gap = g && g.storeGap && decOf(v.storeYears) && decCmp(decOf(v.storeYears), decOf(g.storeGap[0])) > 0
      && decCmp(decOf(v.storeYears), decOf(g.storeGap[1])) <= 0;
    return `<div class="subhead"><b>Первісна вартість</b><span>пункти 5–8 Методики</span></div>
      <div class="form__grid">${sel('group', 'Цінова група', VAL_PRICE_GROUPS, ' field--span2')}
        ${bulk ? '' : inp('price', cur('group') === 'III' ? 'Ціна за контрактом, у валюті' : 'Ціна придбання, грн') + inp('acq', 'Взято на облік (рік або дата)')}
        ${on('group', 'I', 'II', 'III', '') ? inp('ki', 'Коефіцієнт індексації') + inp('kiBasis', 'Підстава коефіцієнта індексації', ' field--span2') : ''}
        ${on('group', 'III') ? inp('rate', 'Курс НБУ на дату розрахунків') + inp('rateBasis', 'Валюта й дата курсу', ' field--span2') : ''}
        ${on('group', 'IV') ? inp('appraisal', 'Первісна вартість за звітом, грн') + inp('appraisalRef', 'Звіт про оцінку: хто склав, номер і дата', ' field--span2') : ''}</div>
      <div class="subhead"><b>Сукупний коефіцієнт зносу</b><span>${ed ? esc(ed.title) : 'редакцію Методики визначає дата складання'}</span></div>
      <div class="form__grid">${sel('method', 'Спосіб розрахунку', [['p21', 'пункт 21 додатка 3: Кскз = КЕ × КЗ × КТС'],
    ['p10', 'пункт 10: втрата внаслідок бойових дій, Кскз = 1']], ' field--span')}
        ${on('method', 'p21') ? `${sel('ng', 'Нормативна група (таблиця 26)', VAL_NORMS.groups.map((x) => [x.id, x.name]), ' field--span')}
          ${sel('mode', 'КЕ визначається', [['use', 'за строком експлуатації'], ['store', 'за строком зберігання']])}
          ${on('mode', 'use') ? sel('termUnit', 'Одиниця строку', units.map((u) => [u, VAL_UNIT[u][0]])) + inp('term', 'Фактичний строк експлуатації') : ''}
          ${on('mode', 'store') ? inp('storeYears', 'Строк зберігання, років') : ''}
          ${gap || (bulk && (v.keOwn || v.keOwnBasis)) ? inp('keOwn', 'КЕ за уточненням') + inp('keOwnBasis', 'Документ, яким уточнено КЕ', ' field--span2') : ''}
          ${sel('cond', 'Умови зберігання (таблиця 27)', VAL_NORMS.kz.map((c, i) => [String(i + 1), c[0]]), ' field--span')}
          ${sel('cat', 'Категорія якісного (технічного) стану', VAL_ROMAN.map((r, i) => [String(i + 1), r]))}` : ''}
        ${on('method', 'p10') ? `${sel('p10.kind', 'Що сталося з майном', VAL_P10_KIND, ' field--span2')}${sel('p10.cause', 'Обставина', VAL_P10_CAUSE, ' field--span2')}
          ${inp('p10.basis', 'Документ, що підтверджує обставини: назва, номер, дата', ' field--span')}
          ${!ed || ed.p10 === 'except' ? sel('p10.order', `Наказ про списання, виданий до ${fmtDate(VAL_NORMS.p10since)}, без затвердженого єдиного акта`,
    [['no', 'не видавався'], ['yes', 'видано, акт не затверджено']], ' field--span2') + inp('p10.orderRef', 'Реквізити наказу, якщо видано') : ''}` : ''}</div>
      <div class="subhead"><b>Коригування</b><span>пункти 9 і 11 Методики</span></div>
      <div class="form__grid">${sel('complete', 'Комплектність', [['yes', 'комплектне'], ['no', 'недоукомплектоване']])}
        ${on('complete', 'no') ? inp('missing', 'Первісна вартість відсутнього, грн') + inp('missingBasis', 'Яких комплектувальних бракує', ' field--span2') : ''}
        ${sel('scrap', 'Нижня межа — вартість брухту', [['na', 'не застосовується'], ['val', 'вартість брухту відома']])}
        ${on('scrap', 'val') ? inp('scrapVal', 'Вартість брухту на одиницю, грн') : ''}
        ${on('scrap', 'na', 'val') ? inp('scrapBasis', cur('scrap') === 'val' ? 'Чим визначено вартість брухту' : 'Чому не застосовується або чим визначено', ' field--span2') : ''}</div>`;
  }
  const VAL_REDRAW = new Set(['group', 'method', 'ng', 'mode', 'termUnit', 'complete', 'scrap', 'storeYears']);
  /** Значення форми → рядок; у режимі «для всіх» — лише заповнене й лише туди, де дозволено. */
  function valApply(ln, v, bulk = false, onlyEmpty = false) {
    const put = (obj, key, val) => {
      const s = String(val ?? '').trim();
      if (bulk && (s === '' || s === VAL_KEEP)) return;
      if (bulk && onlyEmpty && String(obj[key] ?? '').trim()) return;
      obj[key] = s;
    };
    for (const f of (bulk ? [] : VAL_TEXT).concat(VAL_INPUTS)) if (f in v) put(ln, f, v[f]);
    for (const f of VAL_P10) if (`p10.${f}` in v) put(ln.p10 = ln.p10 || {}, f, v[`p10.${f}`]);
  }
  function valLineDialog(p, id) {
    const bulk = id == null;
    const ln = bulk ? null : (p.lines || []).find((x) => x.id === id);
    if (!bulk && !ln) return;
    const ed = valEdition(p.date);
    const v = {};
    if (ln) {
      for (const f of VAL_TEXT.concat(VAL_INPUTS)) v[f] = ln[f] ?? '';
      for (const f of VAL_P10) v[`p10.${f}`] = (ln.p10 || {})[f] ?? '';
    }
    const el = modalOpen(bulk ? `Параметри для всіх рядків (${(p.lines || []).length})` : `Рядок: ${ln.name || ln.code || 'майно'}`, `<form id="val-form">
      ${bulk ? `<div class="panel"><div class="panel__note">Заповніть лише те, що однакове для всіх рядків: порожні поля й «не змінювати» лишають рядки як були.</div>
        <label class="chip"><input type="checkbox" name="onlyEmpty" checked> не змінювати вже вказане в рядку</label></div>`
    : `<div class="form__grid"><div class="field field--span"><label>Найменування, модель, марка</label><input name="name" value="${esc(v.name)}" autocomplete="off"></div>
        <div class="field"><label>Заводський номер</label><input name="serial" value="${esc(v.serial)}" autocomplete="off"></div>
        <div class="field"><label>Інвентарний номер</label><input name="inv" value="${esc(v.inv)}" autocomplete="off"
          title="Номер, під яким майно веде ФЕС; номер служби з бирки сюди не пишуть"></div>
        <div class="field"><label>Одиниця виміру</label><input name="uom" value="${esc(v.uom)}" autocomplete="off"></div>
        <div class="field"><label>Кількість</label><input name="qty" value="${esc(v.qty)}" inputmode="decimal" autocomplete="off"></div>
        <div class="field field--span"><label>Примітка (графа 12)</label><input name="note" value="${esc(v.note)}" autocomplete="off"></div></div>
      <div class="panel"><div class="panel__note">Джерело в обліку: ${esc((ln.src || {}).label || '—')}</div></div>`}
      <div data-val-params></div>
      <div class="pad" style="padding-top:14px"><button class="btn btn--primary" type="submit">${bulk ? 'Застосувати до рядків' : 'Зберегти'}</button>
        <button class="btn" type="button" data-md="close">Скасувати</button></div></form>`);
    const form = el.querySelector('form'), box = el.querySelector('[data-val-params]');
    const read = () => { form.querySelectorAll('[name]').forEach((x) => { if (x.type !== 'checkbox') v[x.name] = x.value; }); };
    const draw = () => { box.innerHTML = valParamsHtml(v, ed, bulk); };
    draw();
    form.addEventListener('change', (e) => {
      read();
      if (!VAL_REDRAW.has(e.target.name)) return;
      if (e.target.name === 'ng') {
        const g = VAL_NORMS.groups.find((x) => x.id === v.ng);
        const units = g ? Object.keys(g.use) : [];
        if (!units.includes(v.termUnit)) v.termUnit = units.length === 1 ? units[0] : (bulk ? VAL_KEEP : '');
      }
      draw();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      read();
      if (bulk) {
        const onlyEmpty = !!form.querySelector('[name="onlyEmpty"]').checked;
        for (const x of p.lines || []) valApply(x, v, true, onlyEmpty);
      } else valApply(ln, v);
      paperMark(p);
      state.paperBad = null;
      modalClose();
      render();
      saveThen(bulk ? 'Параметри рядків збережено.' : 'Рядок збережено.');
    });
  }

  /** «Пояснення розрахунку»: вихідні дані, інтервали таблиць, коефіцієнти, формула, підстави. */
  function valWhy(p, id) {
    const ln = (p.lines || []).find((x) => x.id === id);
    if (!ln) return;
    const need = valFrozen(p) ? [] : valCalcLine(ln, p).need;
    const stale = valStale(ln, p);
    const list = (rows, cls = '') => `<div class="tbl" style="--tbl-min:auto">${rows.map((t) => `<div class="tbl__row tbl__row--plain">
      <div class="c-txt ${cls}" style="white-space:normal">${esc(t)}</div></div>`).join('')}</div>`;
    modalOpen(`Пояснення розрахунку: ${ln.name || ln.code || 'рядок'}`, `<div class="panel"><div class="panel__note">Джерело в обліку: ${
      esc((ln.src || {}).label || '—')}. Кількість ${esc(ln.qty || '—')} ${esc(ln.uom || '')}, ціна придбання ${
      decOf(ln.price) ? `${decUa(decOf(ln.price), 2)} грн` : '—'}, взято на облік: ${esc(ln.acq ? (ln.acq.length > 4 ? fmtDate(ln.acq) : ln.acq) : '—')}.</div></div>
      ${need.length ? `<div class="pad" style="padding-top:12px"><div class="callout callout--bad">Результату немає. Бракує:</div></div>${list(need.map((t) => `${t}.`), 'num-bad')}`
    : stale ? '<div class="pad" style="padding-top:12px"><div class="callout callout--bad">Параметри змінено після розрахунку: результат неактуальний. Натисніть «Розрахувати».</div></div>'
      : list(ln.res.why)}`);
  }

  /** Вибір майна з обліку: партії й одиниці позиції, записи про знищення, рядки документа.
   *  Вибране віддається add(рядки): відомість бере їх як є, акт ЯТС — своїми рядками. */
  function valPick(p, title, add) {
    const st = { tab: 'stock', q: '', code: '', doc: '' };
    const date = p.asOf || p.date || today();
    const el = modalOpen(title, `<div class="panel"><div class="seg">
        <button type="button" data-vp-tab="stock" class="is-on">З обліку</button><button type="button" data-vp-tab="dz">Зі знищеного майна</button>
        <button type="button" data-vp-tab="doc">З документа</button></div>
        <div class="search search--panel"><span>⌕</span><input type="search" data-vp-q placeholder="Пошук" autocomplete="off"></div></div>
      <div data-vp-body style="max-height:52vh;overflow:auto"></div>
      <div class="pad" style="padding-top:12px"><button type="button" class="btn btn--primary" data-vp-add>Додати</button>
        <button type="button" class="btn" data-md="close">Закрити</button> <span class="panel__count" data-vp-msg></span></div>`);
    const body = el.querySelector('[data-vp-body]');
    const row = (cells, attrs = '') => `<div class="tbl__row${attrs ? '' : ' tbl__row--plain'}"${attrs ? ` ${attrs}` : ''}>${cells}</div>`;
    const stockOn = (code) => round3(ledger.reduce((s, e) => (e.code === code && e.d <= date ? s + e.sg * e.q : s), 0));
    const words = () => qWords(st.q);
    const draw = () => {
      el.querySelectorAll('[data-vp-tab]').forEach((b) => b.classList.toggle('is-on', b.dataset.vpTab === st.tab));
      let html = '';
      if (st.tab === 'stock' && !st.code) {
        const list = tzItems().filter((it) => !words().length || hitAll(words(), it.code, it.name)).slice(0, 60);
        html = list.map((it) => row(`<div class="c-code">${esc(it.code)}</div><div class="c-name"><b>${esc(cleanName(it.name))}</b></div>
          <div class="c-unit">${esc(it.unit || '')}</div><div class="c-num" title="Числиться на ${fmtDate(date)}">${fmtNum(stockOn(it.code), '0')}</div>`,
        `data-vp-item="${esc(it.code)}"`)).join('') || row('<div class="c-txt">Позицій за цим пошуком немає.</div>');
      } else if (st.tab === 'stock') {
        const it = itemBy.get(st.code) || {};
        const us = (unitsOf.get(st.code) || []).map((u) => ({ u, a: unitArrival(u.id, '9999-12-31', null) }));
        html = row(`<div class="c-name"><b>${esc(st.code)} · ${esc(cleanName(it.name || ''))}</b><small>числиться на ${fmtDate(date)}: ${
          fmtNum(stockOn(st.code), '0')} ${esc(it.unit || '')}</small></div>
          <div class="c-acts" style="flex-basis:150px"><button type="button" class="btn btn--sm" data-vp-back>← Інша позиція</button></div>`)
          + us.map(({ u, a }) => row(`<div class="c-txt" style="flex:0 0 36px"><input type="checkbox" data-vp-unit="${esc(u.id)}"></div>
            <div class="c-name"><b>${esc(unitLabel(u) || 'одиниця без номера')}</b><small>${esc([u.inv ? `бирка ${u.inv}` : '', u.year ? `${u.year} р.` : '',
    unitHolderAt(u.id, date, null) || 'ніде не числиться'].filter(Boolean).join(' · '))}</small></div>
            <div class="c-num" style="width:120px">${a ? fmtMoney(a.price) : '—'}</div>`)).join('')
          + valBatches(st.code).map((b, i) => row(`<div class="c-num" style="width:86px"><input class="rc-in" data-vp-lot="${i}" inputmode="decimal"
              placeholder="к-сть" aria-label="кількість із партії"></div>
            <div class="c-name"><b>${esc(b.label)}</b><small>надійшло ${fmtNum(b.q)} ${esc(it.unit || '')}</small></div>
            <div class="c-num" style="width:120px">${fmtMoney(b.price)}</div>`)).join('');
      } else if (st.tab === 'dz') {
        const list = allDestroyed().filter((r) => !r.other && (!words().length
          || hitAll(words(), r.code, (itemBy.get(r.code) || {}).name || '', r.report || '', r.sub, r.status))).slice(0, 80);
        html = list.map((r) => row(`<div class="c-txt" style="flex:0 0 36px"><input type="checkbox" data-vp-dz="${esc(r.id)}"></div>
          <div class="c-date">${fmtDate(r.date)}</div><div class="c-name"><b>${esc(cleanName((itemBy.get(r.code) || {}).name || r.code))}</b><small>${
          esc([r.code, r.sub, r.report ? `рапорт ${numNo(r.report)}` : 'без рапорту', r.status].join(' · '))}</small></div>
          <div class="c-num">${fmtNum(r.qty)}</div>`)).join('') || row('<div class="c-txt">Записів про знищення за цим пошуком немає.</div>');
      } else if (!st.doc) {
        const seen = new Map();
        for (const r of docs) if (!seen.has(keyOfRow(r))) seen.set(keyOfRow(r), r);
        const list = [...seen.values()].filter((r) => !words().length || hitAll(words(), r.no, r.from || '', r.to || '', r.t || '')).slice(0, 60);
        html = list.map((r) => row(`<div class="c-date">${fmtDate(r.d)}</div><div class="c-name"><b>${esc(`${r.t || ''} ${numNo(r.no)}`)}</b>
          <small>${esc([r.from, r.to].filter(Boolean).join(' → '))}</small></div>`, `data-vp-doc="${esc(keyOfRow(r))}"`)).join('')
          || row('<div class="c-txt">Документів за цим пошуком немає.</div>');
      } else {
        const rows = docs.filter((r) => keyOfRow(r) === st.doc);
        html = row(`<div class="c-name"><b>${esc(rows[0] ? valDocLabel(rows[0]) : '')}</b></div>
          <div class="c-acts" style="flex-basis:150px"><button type="button" class="btn btn--sm" data-vp-back>← Інший документ</button></div>`)
          + rows.map((r, i) => row(`<div class="c-txt" style="flex:0 0 36px"><input type="checkbox" data-vp-docline="${i}" checked></div>
            <div class="c-name"><b>${esc(cleanName((itemBy.get(r.code) || {}).name || r.code))}</b><small>${esc([r.code,
    r.unit ? unitLabel(unitBy.get(String(r.unit))) : ''].filter(Boolean).join(' · '))}</small></div>
            <div class="c-num">${fmtNum(r.q)}</div><div class="c-num" style="width:120px">${esc(rowParts(r).map((x) => fmtMoney(x.price)).join('; '))}</div>`)).join('');
      }
      body.innerHTML = `<div class="tbl" style="--tbl-min:auto">${html}</div>`;
    };
    draw();
    el.querySelector('[data-vp-q]').addEventListener('input', debounce((e) => { st.q = e.target.value; draw(); }, 200));
    el.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-vp-tab]');
      if (tab) { st.tab = tab.dataset.vpTab; st.code = ''; st.doc = ''; return draw(); }
      if (e.target.closest('[data-vp-back]')) { st.code = ''; st.doc = ''; return draw(); }
      if (e.target.closest('input')) return null;
      const item = e.target.closest('[data-vp-item]'), doc = e.target.closest('[data-vp-doc]');
      if (item) { st.code = item.dataset.vpItem; return draw(); }
      if (doc) { st.doc = doc.dataset.vpDoc; return draw(); }
      if (!e.target.closest('[data-vp-add]')) return null;
      const lines = [], msg = el.querySelector('[data-vp-msg]');
      if (st.tab === 'stock' && st.code) {
        body.querySelectorAll('[data-vp-unit]:checked').forEach((x) => lines.push(...valLinesOfUnit(x.dataset.vpUnit, date)));
        const batches = valBatches(st.code);
        for (const x of body.querySelectorAll('[data-vp-lot]')) {
          const q = decOf(x.value);
          if (!String(x.value).trim()) continue;
          if (!q || q.n <= 0n) { msg.textContent = 'Кількість із партії — число, більше за нуль.'; msg.className = 'panel__count num-bad'; return null; }
          const b = batches[+x.dataset.vpLot];
          lines.push(valLineOf(st.code, { src: { kind: 'lot', doc: b.doc, id: b.id, label: b.label }, qty: decStr(q), price: valMoney(b.price), acq: b.acq }));
        }
      } else if (st.tab === 'dz') {
        const byId = new Map(allDestroyed().map((r) => [String(r.id), r]));
        body.querySelectorAll('[data-vp-dz]:checked').forEach((x) => { const r = byId.get(x.dataset.vpDz); if (r) lines.push(...valLinesOfDz(r)); });
      } else if (st.tab === 'doc' && st.doc) {
        lines.push(...valLinesOfDoc(st.doc, new Set([...body.querySelectorAll('[data-vp-docline]:checked')].map((x) => +x.dataset.vpDocline))));
      }
      if (!lines.length) { msg.textContent = 'Нічого не вибрано.'; msg.className = 'panel__count num-bad'; return null; }
      add(lines);
      paperMark(p);
      save();
      modalClose();
      state.paperBad = null;
      render();
      return toast(`Додано ${cnt(lines.length, 'рядок', 'рядки', 'рядків')}.`);
    });
  }

  /** Відомість у бланку Додатка 1: з розрахованого документа, копією того, що збережено. */
  function valFile(p) {
    if (!valTotal(p).ready) { toast('У Excel іде розрахована відомість: спершу «Розрахувати».', true); return null; }
    const ed = valEdition(p.date);
    const p10 = (p.lines || []).map((ln, i) => (ln.res.rule === 'p10' ? i + 1 : 0)).filter(Boolean);
    return toExcel({ kind: 'valuation', file: `Відомість залишкової вартості ${p.no || 'без номера'} від ${p.date}`,
      unit: (p.unit || {}).name || unitInfo().legalName, no: p.no || '', date: p.date, as_of: p.asOf || '', approved: p.approved || '', basis: p.basis || '', note: p.note || '',
      copies: p.copies || '', norms: `${VAL_NORMS.act}, ${ed ? ed.title : ''}`, p10,
      approver: p.approver || {}, head: p.head || {}, members: (p.members || []).filter(sgFilled), agree: p.agree || {},
      lines: p.lines.map((ln) => ({ name: [ln.name, ln.serial ? `зав. № ${ln.serial}` : '', ln.inv ? `інв. № ${ln.inv}` : ''].filter(Boolean).join(', '),
        uom: ln.uom || '', qty: ln.qty, price: ln.group === 'IV' ? '' : ln.price, year: String(ln.acq || '').slice(0, 4), group: ln.group,
        ki: ln.group === 'IV' ? '' : ln.ki, rate: ln.group === 'III' ? ln.rate : '', vp: ln.res.vp, base: ln.res.base,
        missing: ln.complete === 'no' ? ln.missing : '', ke: ln.res.ke, kz: ln.res.kz, kts: ln.res.kts, k: ln.res.k, rule: ln.res.rule,
        unit: ln.res.unit, floor: !!ln.res.floor, sum: ln.res.sum, note: ln.note || '' })),
      total: valTotal(p).sum });
  }

  function valAction(act, d, p) {
    const shown = state.paperVer ? ((p.versions || []).find((v) => v.ver === state.paperVer) || {}).body || p : p;
    switch (act) {
      case 'val-why': return valWhy(shown, d.id);
      case 'val-to-act': {
        if (!(shown.lines || []).length) return toast('У відомості ще немає майна.', true);
        const a = actFromValuation(shown);
        save();
        return go('yats', { paperId: a.id, paperVer: 0, paperBad: null,
          flash: `Акт складено за відомістю ${numNo(shown.no || 'б/н')}: майно й комісію перенесено, стан і висновок заповнює комісія.` });
      }
      default: break;
    }
    if (!paperOpen(p) || state.paperVer) return null;
    switch (act) {
      case 'val-calc': {
        const bad = valCalc(p);
        const t = valTotal(p);
        p.norms = VAL_NORMS.id;                         // версія нормативного довідника, за якою рахували
        paperMark(p, bad.length ? '' : `розраховано: ${decUa(decOf(t.sum), 2)} грн`);
        save();
        state.paperBad = bad;
        state.flash = bad.length ? `Розраховано рядків: ${t.n} із ${p.lines.length}. Решті бракує даних — перелік нижче.`
          : `Розраховано: ${cnt(t.n, 'рядок', 'рядки', 'рядків')} на ${decUa(decOf(t.sum), 2)} грн.`;
        return render();
      }
      case 'val-pick': return valPick(p, 'Додати майно до відомості', (lines) => { p.lines = (p.lines || []).concat(lines); });
      case 'val-bulk': return (p.lines || []).length ? valLineDialog(p, null) : toast('Спершу додайте майно.', true);
      case 'val-line': return valLineDialog(p, d.id);
      case 'val-line-del': {
        const ln = (p.lines || []).find((x) => x.id === d.id);
        if (!ln || !confirm(`Прибрати рядок «${ln.name || ln.code}» з відомості?`)) return null;
        p.lines = p.lines.filter((x) => x !== ln);
        paperMark(p);
        save();
        return render();
      }
      default: return null;
    }
  }

  // ================================================================ АКТИ ЯТС
  /** Акт якісного (технічного) стану — Додаток 1 до Порядку списання військового майна. Таблиця
   *  має дві частини: майно, що списується (`lines`), і майно, що оприбутковується (`income`);
   *  друга заповнюється лише тоді, коли є що оприбутковувати, і з першої не копіюється. Суми
   *  рахує програма з кількості й ціни. Тексти про стан і висновок пише комісія: програма їх не
   *  складає. Акт — документ: ні залишків, ні категорії стану одиниці він сам не змінює. */
  const ACT_TERM_UNITS = ['років', 'місяців', 'годин'];
  const ACT_TEXTS = [['complete', 'Комплектність'], ['storage', 'Умови зберігання'], ['defects', 'Виявлені дефекти й пошкодження'],
    ['repair', 'Можливість і доцільність відновлення'], ['catNew', 'Запропонована категорія'], ['conclusion', 'Висновок комісії'],
    ['grounds', 'Підстави висновку'], ['senior', 'Висновок старшого начальника']];
  const ACT_CODES = [['infoMark', 'Ознака інформації (000)'], ['regNo', 'Реєстраційний номер (001)'], ['sheetNo', 'Номер аркуша (002)'],
    ['docCode', 'Код документа (003)'], ['opCode', 'Код операції (004)']];
  const ACT_OFF = ['name', 'serial', 'inv', 'code', 'uom', 'cat', 'qty', 'price', 'normTerm', 'normUnit', 'factTerm', 'factUnit'];
  const ACT_IN = ['name', 'code', 'uom', 'cat', 'qty', 'price'];
  /** Сума рядка — кількість × ціна до копійки; без кількості чи ціни суми немає. */
  function actSum(ln) {
    const q = decOf(ln.qty), pr = decOf(ln.price);
    return q && pr && q.n > 0n && pr.n >= 0n ? decRound(decMul(q, pr), 2) : null;
  }
  function actSums(list) {
    let sum = decOf('0'), ok = true;
    for (const ln of list || []) { const s = actSum(ln); if (s) sum = decAdd(sum, s); else ok = false; }
    // Кількість різного майна в один підсумок не складається: лише коли одиниця виміру одна.
    const uoms = new Set((list || []).map((ln) => String(ln.uom || '').trim().toLowerCase()));
    const qty = ok && uoms.size === 1 ? (list || []).reduce((a, ln) => decAdd(a, decOf(ln.qty)), decOf('0')) : null;
    return { sum: decStr(sum, 2), qty: qty ? decStr(qty) : '', ok: ok && (list || []).length > 0 };
  }
  const actTerm = (v, unit) => (String(v ?? '').trim() ? `${String(v).trim()} ${unit || ''}`.trim() : '');
  const actTitle = (p) => String(p.title || '').trim() || ((p.lines || []).length === 1 ? p.lines[0].name
    : (p.lines || []).length ? 'військового майна згідно з переліком' : '');

  PAPER_UI.tech_act = {
    blank: () => ({ title: '', purpose: '', service: unitInfo().serviceFull || '', nomenNo: '', accMain: '', accCorr: '', infoMark: '', regNo: '',
      sheetNo: '', docCode: '', opCode: '', opDate: '', income: [], valId: '', complete: '', storage: '', defects: '', repair: '', catNew: '',
      conclusion: '', grounds: '', senior: '' }),
    what: (p) => { const l = (p.lines || []).concat(p.income || []); return l.length ? `${l[0].name || l[0].code || 'майно'}${l.length > 1 ? ` і ще ${l.length - 1}` : ''}` : ''; },
    total: (p) => { const t = actSums(p.lines); return { sum: t.sum, ready: t.ok }; },
    actions: () => '',
    check: actCheck,
    body: actBody,
    bind: () => {},
    file: actFile,
    action: actAction,
  };

  /** Чого бракує акту до готового документа. */
  function actCheck(p) {
    const bad = [];
    if (!String(p.no || '').trim()) bad.push('Не вказано номер акта.');
    if (!p.date) bad.push('Не вказано дату акта.');
    if (!(p.lines || []).length && !(p.income || []).length) bad.push('В акті немає жодного рядка майна.');
    (p.lines || []).forEach((ln, i) => {
      const row = `Рядок ${i + 1} (списати)`;
      if (!String(ln.name || '').trim()) bad.push(`${row}: не вказано найменування.`);
      if (!String(ln.uom || '').trim()) bad.push(`${row}: не вказано одиницю виміру.`);
      const q = decOf(ln.qty), pr = decOf(ln.price);
      if (!q || q.n <= 0n) bad.push(`${row}: не вказано кількість.`);
      if (!pr || pr.n < 0n) bad.push(`${row}: не вказано ціну за одиницю.`);
      if (String(ln.normTerm || '').trim() && !ln.normUnit) bad.push(`${row}: строк експлуатації за нормою без одиниці (років, місяців чи годин).`);
      if (String(ln.factTerm || '').trim() && !ln.factUnit) bad.push(`${row}: фактичний строк експлуатації без одиниці (років, місяців чи годин).`);
    });
    (p.income || []).forEach((ln, i) => {
      const row = `Рядок ${i + 1} (оприбуткувати)`;
      if (!String(ln.name || '').trim()) bad.push(`${row}: не вказано найменування.`);
      const q = decOf(ln.qty), pr = decOf(ln.price);
      const hasQ = q && q.n > 0n, hasP = pr && pr.n >= 0n && String(ln.price ?? '').trim() !== '';
      if (hasP && !hasQ) bad.push(`${row}: вказано ціну без кількості.`);
      else if (hasQ && !hasP) bad.push(`${row}: вказано кількість без залишкової вартості за одиницю.`);
      else if (!hasQ) bad.push(`${row}: не вказано кількість і залишкову вартість за одиницю.`);
    });
    if (!String(p.conclusion || '').trim()) bad.push('Не вказано висновок комісії.');
    if (!sgFilled(p.approver)) bad.push('Не вказано, хто затверджує акт.');
    if (!sgFilled(p.head)) bad.push('Не вказано голову комісії.');
    if (!(p.members || []).some(sgFilled)) bad.push('Не вказано жодного члена комісії.');
    return bad;
  }

  function actBody(p, ro) {
    const dis = ro ? ' disabled' : '';
    const f = (field, label, type = 'text', span = '', extra = '') => `<div class="field${span}"><label>${label}</label>
      <input type="${type}" data-pf="${field}" data-fid="pf:${field}" value="${esc(p[field] || '')}" autocomplete="off"${extra}${dis}></div>`;
    const d = (x, n = null) => (x ? decUa(x, n) : '—');
    const cat = (c) => VAL_ROMAN[+c - 1] || '—';
    const table = (list, key, off) => {
      const t = actSums(list);
      const rows = (list || []).map((ln, i) => `<div class="tbl__row tbl__row--plain${actSum(ln) ? '' : ' is-due'}">
        <div class="c-num c-num--dim" style="width:34px">${i + 1}</div>
        <div class="c-name c-name--stack" style="flex:2 1 220px"><b>${esc(ln.name || '—')}</b><small>${esc([ln.serial ? `зав. № ${ln.serial}` : '',
          ln.inv ? `інв. № ${ln.inv}` : '', (ln.src || {}).label || ''].filter(Boolean).join(' · '))}</small></div>
        <div class="c-code" style="width:70px">${esc(ln.code || '—')}</div><div class="c-unit" style="width:50px">${esc(ln.uom || '—')}</div>
        <div class="c-num" style="width:44px">${cat(ln.cat)}</div>
        <div class="c-num" style="width:64px">${d(decOf(ln.qty))}</div><div class="c-num" style="width:104px">${d(decOf(ln.price), 2)}</div>
        <div class="c-num" style="width:112px"><b>${d(actSum(ln), 2)}</b></div>
        ${off ? `<div class="c-txt" style="flex:0 0 96px">${esc(actTerm(ln.normTerm, ln.normUnit) || '—')}</div>
        <div class="c-txt" style="flex:0 0 96px">${esc(actTerm(ln.factTerm, ln.factUnit) || '—')}</div>` : ''}
        <div class="c-acts" style="flex-basis:150px">${ro ? '' : rowBtn('yats-line', '✎ Рядок', `data-id="${esc(ln.id)}" data-list="${key}"`)
          + rowBtn('yats-line-del', '✕', `data-id="${esc(ln.id)}" data-list="${key}"`, { bad: true, title: 'Прибрати рядок' })}</div></div>`).join('');
      return `<div class="card--scroll"><div class="tbl" style="--tbl-min:${off ? 1040 : 850}px"><div class="tbl__head">
        <div class="tbl__h c-num" style="width:34px">№</div><div class="tbl__h c-name" style="flex:2 1 220px">найменування, номер</div>
        <div class="tbl__h c-code" style="width:70px">код</div><div class="tbl__h c-unit" style="width:50px">од.</div>
        <div class="tbl__h c-num" style="width:44px">кат.</div><div class="tbl__h c-num" style="width:64px">к-сть</div>
        <div class="tbl__h c-num" style="width:104px">${off ? 'ціна' : 'залишкова'}</div><div class="tbl__h c-num" style="width:112px">сума, грн</div>
        ${off ? `<div class="tbl__h c-txt" style="flex:0 0 96px" title="Експлуатується за нормою">за нормою</div>
        <div class="tbl__h c-txt" style="flex:0 0 96px" title="Експлуатується фактично">фактично</div>` : ''}
        <div class="tbl__h c-acts" style="flex-basis:150px"></div></div>
        ${rows || `<div class="tbl__row tbl__row--plain"><div class="c-txt">${off ? (ro ? 'Рядків немає.' : 'Додайте майно: «+ Додати майно» або «+ Рядок».')
    : 'Заповнюється, коли є що оприбутковувати.'}</div></div>`}
        ${(list || []).length ? `<div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-num" style="width:34px"></div>
          <div class="c-name" style="flex:2 1 220px"><b>Усього</b></div><div class="c-code" style="width:70px"></div><div class="c-unit" style="width:50px"></div>
          <div class="c-num" style="width:44px"></div><div class="c-num" style="width:64px">${t.qty ? decUa(decOf(t.qty)) : ''}</div>
          <div class="c-num" style="width:104px"></div><div class="c-num" style="width:112px"><b>${t.ok ? decUa(decOf(t.sum), 2) : '—'}</b></div>
          ${off ? '<div class="c-txt" style="flex:0 0 96px"></div><div class="c-txt" style="flex:0 0 96px"></div>' : ''}
          <div class="c-acts" style="flex-basis:150px"></div></div>` : ''}</div></div>`;
    };
    const vals = papers().filter((x) => x.kind === 'valuation' && x.state !== 'скасовано');
    const linked = p.valId ? paperById(p.valId) : null;
    return `<div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Реквізити</div>
        <div class="panel__spacer"></div>${linked ? `<span class="panel__count">за відомістю ${esc(numNo(linked.no || 'б/н'))}</span>
        <button type="button" class="btn btn--sm" data-act="paper-open" data-id="${esc(linked.id)}">Відкрити відомість</button>` : ''}</div>
      <div class="form__grid">${f('no', 'Номер акта (005)')}${f('date', 'Дата акта (032)', 'date')}
        ${f('title', 'Майно в заголовку акта', 'text', ' field--span2', ` placeholder="${esc(actTitle(p))}"`)}
        ${f('purpose', 'Підстава (мета) операції (045)', 'text', ' field--span2')}${f('service', 'Служба (046)')}
        ${f('opDate', 'Дата операції (034)', 'date')}${ACT_CODES.map(([k, label]) => f(k, label)).join('')}
        ${f('nomenNo', 'Номенклатурний номер')}${f('accMain', 'Основний рахунок')}${f('accCorr', 'Кореспондентський рахунок')}
        <div class="field"><label>Відомість залишкової вартості</label><select data-pf="valId" data-fid="pf:valId"${dis}><option value="">—</option>${
    vals.map((x) => `<option value="${esc(x.id)}"${x.id === p.valId ? ' selected' : ''}>${esc(`${numNo(x.no || 'б/н')} від ${fmtDate(x.date)}`)}</option>`).join('')}</select></div>
      </div></div>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Списати</div><div class="panel__spacer"></div>
        ${ro ? '' : `<button type="button" class="btn btn--sm" data-act="yats-line-new" data-list="lines">+ Рядок</button>
        <button type="button" class="btn btn--sm btn--primary" data-act="yats-pick">+ Додати майно</button>`}</div>${table(p.lines, 'lines', true)}</div>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Оприбуткувати</div><div class="panel__spacer"></div>
        ${ro ? '' : '<button type="button" class="btn btn--sm" data-act="yats-line-new" data-list="income">+ Рядок</button>'}</div>${table(p.income, 'income', false)}</div>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Технічний стан і висновок</div>
        <div class="panel__spacer"></div><span class="panel__count">тексти пише комісія</span></div>
        <div class="form__grid">${ACT_TEXTS.map(([k, label]) => `<div class="field field--span2"><label>${label}</label>
          <textarea data-pf="${k}" data-fid="pf:${k}" rows="${k === 'conclusion' ? 4 : 2}"${dis}>${esc(p[k] || '')}</textarea></div>`).join('')}</div></div>
      ${paperSigners(p, ro, [['approver', 'Затверджує'], ['head', 'Голова комісії'], ['members', '']])}`;
  }

  function actLineDialog(p, key, id) {
    const off = key === 'lines';
    const list = p[key] = p[key] || [];
    const ln = id ? list.find((x) => x.id === id) : null;
    if (id && !ln) return;
    const v = ln || {};
    const inp = (name, label, span = '', attrs = '') => `<div class="field${span}"><label>${label}</label>
      <input name="${name}" value="${esc(v[name] ?? '')}" autocomplete="off"${attrs}></div>`;
    const sel = (name, label, options) => `<div class="field"><label>${label}</label><select name="${name}"><option value="">—</option>${
      options.map(([val, text]) => `<option value="${esc(val)}"${String(v[name] ?? '') === String(val) ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></div>`;
    const el = modalOpen(`${off ? 'Списати' : 'Оприбуткувати'}: ${ln ? ln.name || 'рядок' : 'новий рядок'}`, `<form id="yats-form"><div class="form__grid">
        ${inp('name', off ? 'Найменування військового майна' : 'Найменування озброєння (техніки, майна)', ' field--span')}
        ${off ? inp('serial', 'Заводський номер') + inp('inv', 'Інвентарний номер', '',
          ' title="Номер, під яким майно веде ФЕС; номер служби з бирки сюди не пишуть"') : ''}
        ${inp('code', 'Код номенклатури')}${inp('uom', 'Одиниця виміру')}${sel('cat', 'Категорія', VAL_ROMAN.map((r, i) => [String(i + 1), r]))}
        ${inp('qty', 'Кількість', '', ' inputmode="decimal"')}${inp('price', off ? 'Ціна за одиницю, грн' : 'Залишкова вартість за одиницю, грн', '', ' inputmode="decimal"')}
        ${off ? inp('normTerm', 'Експлуатується за нормою') + sel('normUnit', 'Одиниця строку за нормою', ACT_TERM_UNITS.map((u) => [u, u]))
          + inp('factTerm', 'Експлуатується фактично') + sel('factUnit', 'Одиниця фактичного строку', ACT_TERM_UNITS.map((u) => [u, u])) : ''}</div>
      ${ln && (ln.src || {}).label ? `<div class="panel"><div class="panel__note">Джерело в обліку: ${esc(ln.src.label)}</div></div>` : ''}
      <div class="pad" data-yats-msg hidden style="padding-top:10px;color:var(--bad)"></div>
      <div class="pad" style="padding-top:14px"><button class="btn btn--primary" type="submit">Зберегти</button>
        <button class="btn" type="button" data-md="close">Скасувати</button></div></form>`);
    el.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const row = ln || { id: uid() };
      for (const k of off ? ACT_OFF : ACT_IN) row[k] = String(fd.get(k) ?? '').trim();
      const bad = [];
      for (const [k, label] of [['qty', 'Кількість'], ['price', off ? 'Ціна' : 'Залишкова вартість']]) {
        if (row[k] && (!decOf(row[k]) || decOf(row[k]).n < 0n)) bad.push(`${label} — число, не менше за нуль.`);
      }
      const msg = el.querySelector('[data-yats-msg]');
      if (bad.length) { msg.hidden = false; msg.innerHTML = bad.map(esc).join('<br>'); return; }
      if (!ln) list.push(row);
      paperMark(p);
      state.paperBad = null;
      modalClose();
      render();
      saveThen('Рядок акта збережено.');
    });
    el.querySelector('input[name="name"]').focus();
  }

  /** Акт у Word за бланком: з того, що збережено в документі. */
  function actFile(p) {
    if (!(p.lines || []).length && !(p.income || []).length) { toast('В акті ще немає жодного рядка майна.', true); return null; }
    const row = (ln, off) => ({ name: [ln.name, off && ln.serial ? `зав. № ${ln.serial}` : '', off && ln.inv ? `інв. № ${ln.inv}` : ''].filter(Boolean).join(', '),
      code: ln.code || '', uom: ln.uom || '', cat: VAL_ROMAN[+ln.cat - 1] || '', qty: ln.qty || '', price: ln.price || '',
      sum: actSum(ln) ? decStr(actSum(ln), 2) : '', norm: off ? actTerm(ln.normTerm, ln.normUnit) : '', fact: off ? actTerm(ln.factTerm, ln.factUnit) : '' });
    const text = {};
    for (const [k] of ACT_TEXTS) text[k] = p[k] || '';
    return toExcel({ kind: 'tech_act', word: true, file: `Акт ЯТС ${p.no || 'без номера'} від ${p.date}`, unit: (p.unit || {}).code || unitCode(), no: p.no || '', date: p.date || '',
      title: actTitle(p), purpose: p.purpose || '', service: p.service || '', op_date: p.opDate || '',
      codes: Object.fromEntries(ACT_CODES.map(([k]) => [k, p[k] || ''])), nomen_no: p.nomenNo || '', acc_main: p.accMain || '', acc_corr: p.accCorr || '',
      off: (p.lines || []).map((ln) => row(ln, true)), income: (p.income || []).map((ln) => row(ln, false)),
      off_total: actSums(p.lines), in_total: actSums(p.income), text,
      approver: p.approver || {}, head: p.head || {}, members: (p.members || []).filter(sgFilled) });
  }

  /** Акт за відомістю залишкової вартості: майно й номери переходять без повторного введення;
   *  частина «оприбуткувати» лишається порожньою — її заповнює комісія. */
  function actFromValuation(v) {
    const p = paperNew('tech_act');
    Object.assign(p, { valId: v.id, purpose: v.basis || '', lines: (v.lines || []).map((ln) => ({ id: uid(), src: JSON.parse(JSON.stringify(ln.src || {})),
      code: ln.code || '', name: ln.name || '', serial: ln.serial || '', inv: ln.inv || '', uom: ln.uom || '', cat: ln.method === 'p21' ? ln.cat || '' : '',
      qty: ln.qty || '', price: ln.group === 'IV' ? '' : ln.price || '', normTerm: '', normUnit: '', factTerm: '', factUnit: '' })),
    head: JSON.parse(JSON.stringify(v.head || sgOf(null))), members: JSON.parse(JSON.stringify(v.members || [])),
    approver: JSON.parse(JSON.stringify(v.approver || sgOf(null))) });
    paperMark(p, `складено за відомістю ${numNo(v.no || 'б/н')} від ${fmtDate(v.date)}`);
    return p;
  }

  function actAction(act, d, p) {
    if (!paperOpen(p) || state.paperVer) return null;
    const list = d.list === 'income' ? 'income' : 'lines';
    switch (act) {
      case 'yats-pick': return valPick(p, 'Додати майно до акта', (lines) => {
        p.lines = (p.lines || []).concat(lines.map((ln) => {
          const u = (ln.src || {}).unit ? unitBy.get(String(ln.src.unit)) : null;
          return { id: ln.id, src: ln.src, code: ln.code, name: ln.name, serial: ln.serial, inv: ln.inv, uom: ln.uom,
            cat: u ? String(catAt(u, p.date || today()) || '') : '', qty: ln.qty, price: ln.price, normTerm: '', normUnit: '', factTerm: '', factUnit: '' };
        }));
      });
      case 'yats-line-new': return actLineDialog(p, list, null);
      case 'yats-line': return actLineDialog(p, list, d.id);
      case 'yats-line-del': {
        const ln = (p[list] || []).find((x) => x.id === d.id);
        if (!ln || !confirm(`Прибрати рядок «${ln.name || ln.code || 'без назви'}» з акта?`)) return null;
        p[list] = p[list].filter((x) => x !== ln);
        paperMark(p);
        save();
        return render();
      }
      default: return null;
    }
  }
