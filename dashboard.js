/* ============================================================
   MedMinder v3 — Dashboard Page Logic (dashboard.js)
============================================================ */

'use strict';

let filterMode  = 'all';
let sortMode    = 'time';
let donutChart  = null;

/* ============================================================
   STOCK ANALYTICS — Pure calculation functions
   
   All functions below are pure: they take `reminders` as input
   and return a derived value. No DOM reads, no side-effects.
   This makes them trivially testable and reusable in history.js.
============================================================ */

/**
 * calcAnalytics(data)
 * ───────────────────
 * Single-pass analytics using Array.reduce() over the full
 * reminders array. One loop, four counters — O(n) complexity.
 *
 * Why reduce() instead of four separate filter() calls?
 *   Four filter() calls each traverse the full array → O(4n).
 *   One reduce() traverses it once → O(n).
 *   For large medicine lists this matters; it also keeps the
 *   logic co-located instead of scattered across the file.
 *
 * Demonstrates:
 *   • Array.reduce(callback, initialAccumulator)
 *     callback receives (accumulator, currentItem) per element.
 *     We MUST return the accumulator each iteration or it becomes
 *     undefined on the next call — a common reduce() bug.
 *   • Object destructuring in the callback parameter:
 *     { done, stock = 30, minimumStock = 5 }
 *     The `= 30` / `= 5` defaults make this backwards-compatible
 *     with reminders saved before stock tracking was added.
 *   • Computed property names in the accumulator object literal.
 *
 * @param  {Array}  data  - the reminders array (or any subset)
 * @returns {Object} analytics summary object
 */
function calcAnalytics(data) {
  /*
   * reduce() initial accumulator — all counters start at zero.
   * totalStock uses 0 because we add each reminder's stock count.
   */
  const result = data.reduce((acc, reminder) => {
    /*
     * Destructuring with defaults:
     *   Pull done, stock, minimumStock out of the reminder object.
     *   Default values (= 30, = 5) activate only when the field is
     *   undefined — i.e. reminders created before stock was added.
     */
    const { done, stock = 30, minimumStock = 5 } = reminder;

    // ── Completion counter ──
    if (done) acc.completed++;

    // ── Stock counters ──
    // getStockStatus() is defined in shared.js (added in previous task)
    const status = getStockStatus({ stock, minimumStock });
    if (status === 'out') acc.outOfStock++;
    if (status === 'low') acc.lowStock++;

    /*
     * totalStock — accumulates the sum of all stock values.
     * This is the canonical reduce() pattern:
     *   total = total + currentValue  (running sum)
     * Math.max(0, stock) guards against any corrupted negative value.
     */
    acc.totalStock += Math.max(0, stock);

    return acc; // MUST return accumulator — reduce() passes it as
                // the first argument on the very next iteration
  }, { completed: 0, outOfStock: 0, lowStock: 0, totalStock: 0 });

  return result;
}

/**
 * getStockAlertItems()
 * ─────────────────────
 * Returns only reminders that need stock attention, sorted so
 * out-of-stock items always appear above low-stock ones.
 *
 * Demonstrates:
 *   • Array.filter() — keeps items where predicate returns true.
 *     filter() is a higher-order function: it receives a function
 *     (the arrow) and calls it once per element, collecting truthy
 *     results into a new array. The original array is unchanged.
 *   • Array.sort() with a custom comparator.
 *   • getStockStatus() called as a callback — passing a named
 *     function (from shared.js) as a value is itself HOF usage.
 */
function getStockAlertItems() {
  /*
   * filter() predicate: keep reminder only when its stock status
   * is NOT 'ok'. getLowStockReminders() (shared.js) does the same
   * but we re-implement inline here so the sort step can follow.
   */
  return reminders
    .filter(r => getStockStatus(r) !== 'ok')
    .sort((a, b) => {
      /*
       * Custom sort comparator — sort 'out' before 'low'.
       * Converts status string → numeric priority so subtraction
       * gives the correct ascending order.
       * Higher priority number = appears first (we negate it).
       */
      const priority = { out: 2, low: 1, ok: 0 };
      return priority[getStockStatus(b)] - priority[getStockStatus(a)];
    });
}

/**
 * buildAnalyticsCards(analytics)
 * ──────────────────────────────
 * Pure template function — takes the analytics object and returns
 * an HTML string. Keeping HTML generation out of updateAnalytics()
 * keeps concerns separated (calculate vs. render).
 *
 * Demonstrates:
 *   • Destructuring in function parameters — pulls the four fields
 *     out of the analytics object in the function signature itself,
 *     so the body never has to write `analytics.completed` etc.
 *   • Template literals for multi-line HTML strings.
 *   • Ternary for conditional CSS class selection.
 *
 * @param  {{ completed, outOfStock, lowStock, totalStock }} analytics
 * @returns {string} HTML string for the four analytics cards
 */
function buildAnalyticsCards({ completed, outOfStock, lowStock, totalStock }) {
  /*
   * Each card's colour class is chosen by a ternary that mirrors
   * traffic-light logic: red if critical, yellow if warning, green/blue.
   */
  const outClass  = outOfStock > 0 ? 'c-red'    : 'c-green';
  const lowClass  = lowStock   > 0 ? 'c-yellow'  : 'c-green';

  return `
    <div class="stat-card s-green">
      <div class="stat-icon">✅</div>
      <div class="stat-num c-green" id="a-completed">${completed}</div>
      <div class="stat-label">Completed</div>
    </div>
    <div class="stat-card s-blue">
      <div class="stat-icon">📦</div>
      <div class="stat-num c-blue" id="a-total-stock">${totalStock}</div>
      <div class="stat-label">Total Stock</div>
    </div>
    <div class="stat-card ${lowStock > 0 ? 's-yellow' : 's-green'}">
      <div class="stat-icon">⚠️</div>
      <div class="stat-num ${lowClass}" id="a-low-stock">${lowStock}</div>
      <div class="stat-label">Low Stock</div>
    </div>
    <div class="stat-card ${outOfStock > 0 ? 's-red' : 's-green'}">
      <div class="stat-icon">⛔</div>
      <div class="stat-num ${outClass}" id="a-out-stock">${outOfStock}</div>
      <div class="stat-label">Out of Stock</div>
    </div>`;
}

/**
 * buildStockAlertRows(alertItems)
 * ────────────────────────────────
 * Maps an array of low/out-of-stock reminders to HTML rows.
 *
 * Demonstrates:
 *   • Array.map() — transforms each reminder object into an HTML
 *     string. map() is a higher-order function: it receives the
 *     arrow function and calls it once per item, returning a new
 *     array of strings. The original array is untouched.
 *   • Chained .join('') collapses the string array into one string.
 *   • Destructuring inside the map callback.
 *   • getStockBadge() (shared.js) called as a mapping function.
 *
 * @param  {Array}  alertItems  - output of getStockAlertItems()
 * @returns {string} HTML string of table rows
 */
function buildStockAlertRows(alertItems) {
  /*
   * map() transforms each reminder object into a <tr> string.
   * Destructuring in the arrow parameter pulls out only the fields
   * we need — the rest of the reminder object is ignored here.
   */
  return alertItems.map(({ id, name, dose, stock = 30, minimumStock = 5, cat }) => {
    const status     = getStockStatus({ stock, minimumStock });
    const rowClass   = status === 'out' ? 'stock-row-out' : 'stock-row-low';
    const catMeta    = CAT_META[cat] || { emoji: '💊', label: cat };

    /*
     * getStockBadge() is imported from shared.js (previous task).
     * Passing the whole reminder object keeps the call clean — the
     * helper destructures what it needs internally.
     */
    const badge = getStockBadge({ name, stock, minimumStock });

    return `
      <div class="stock-alert-row ${rowClass}">
        <div class="sar-left">
          <span class="sar-cat">${catMeta.emoji}</span>
          <div class="sar-info">
            <span class="sar-name">${escHtml(name)}</span>
            <span class="sar-dose">${escHtml(dose)}</span>
          </div>
        </div>
        <div class="sar-right">
          ${badge}
        <button class="btn-icon edit" data-action="edit" data-id="${escHtml(id)}" title="Edit to update stock">✏️</button>          </div>
      </div>`;
  }).join('');  // join converts string[] → single string for innerHTML
}

/* ── Called by shared.js applyTheme() on theme change (BUG FIX #7) ── */
function onThemeChanged() {
  if (donutChart) {
    donutChart.destroy();
    donutChart = null;
  }
  render();
}

/* ── Greeting ── */
function updateGreeting() {
  const h = new Date().getHours();
  const [greeting, emoji] =
    h < 6  ? ['Good night!',      '🌙'] :
    h < 12 ? ['Good morning!',    '🌅'] :
    h < 17 ? ['Good afternoon!',  '☀️'] :
    h < 21 ? ['Good evening!',    '🌆'] :
             ['Good night!',      '🌙'];

  document.getElementById('greeting').textContent      = greeting;
  document.getElementById('hero-greeting').textContent = greeting;
  document.getElementById('hero-emoji').textContent    = emoji;

  const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  document.getElementById('today-date-str').textContent = new Date().toLocaleDateString(undefined, opts);
  document.getElementById('nav-date').textContent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ── Donut chart ─────────────────────────────────────────────────
 *
 * updateChart(stats)
 * ──────────────────
 * Renders a doughnut chart with two datasets:
 *
 *   Outer ring — Status breakdown (Taken / Pending / Overdue)
 *     One segment per status group; segment size = count of
 *     medicines in that group.
 *
 *   Inner ring — Per-medicine stock levels (Healthy / Low / Out)
 *     One segment per reminder, coloured by stock tier.
 *     This is the new ring added in this task.
 *
 * Both rings share the same Chart.js `datasets` array.
 * Chart.js renders multiple datasets as concentric doughnuts
 * automatically — no extra configuration required.
 *
 * ── DATASET GENERATION ─────────────────────────────────────────
 *
 * buildPerMedicineDataset(isDark)
 *   Uses map() to transform the `reminders` array into parallel
 *   arrays of values, colours, and rich tooltip metadata.
 *   Each reminder becomes one segment on the inner ring.
 *
 *   map() is used three times here (composable, not chained) so
 *   each concern is named and independently readable:
 *     • reminders.map(r => r.stock)         → segment sizes
 *     • reminders.map(r => stockColor(r))   → segment colours
 *     • reminders.map(r => tooltipMeta(r))  → tooltip payload
 *
 * ── TOOLTIP CUSTOMISATION ──────────────────────────────────────
 *
 * Chart.js tooltip callbacks receive a `tooltipItem` context object.
 * We use two callbacks:
 *
 *   title  — overrides the default label as the tooltip header.
 *            Receives an array of tooltip items (one per hovered
 *            segment). We pull item[0].dataIndex to look up the
 *            reminder name from our parallel metadata array.
 *
 *   label  — overrides the default "Dataset: value" line.
 *            Returns a string[] — each string becomes one line in
 *            the tooltip body. We return stock, status, category,
 *            and dose, all sourced from the metadata array built
 *            by map() during dataset construction.
 *
 * ── DYNAMIC LABEL MAPPING ──────────────────────────────────────
 *
 * The outer ring labels ('Taken', 'Pending', 'Overdue') are static.
 * The inner ring labels are dynamic — one per reminder — built via:
 *
 *   reminders.map(r => r.name)
 *
 * The legend for the inner ring is suppressed (display:false) because
 * listing every medicine name in a small legend would be illegible.
 * The tooltip is the discovery surface instead.
 *
 * ── REDUCE USAGE ───────────────────────────────────────────────
 *
 * stockSummary = reminders.reduce(...)
 *   Counts healthy / low / out in a single pass for the centre-text
 *   annotation and the subtitle line below the chart title.
 */

/* ── Helper: stock tier colour per reminder ── */
/**
 * stockSegmentColor(reminder, isDark)
 *
 * Maps stock level → a hex colour for the inner-ring segment.
 * Uses destructuring with defaults for backwards compatibility.
 * Returns a slightly-transparent colour in dark mode so the
 * outer ring doesn't get visually overpowered.
 *
 * @param {Object}  r      — reminder object
 * @param {boolean} isDark — current theme state
 * @returns {string} CSS colour string
 */
function stockSegmentColor(r, isDark) {
  const { stock = 30, minimumStock = 5 } = r;
  const level = getStockStatus({ stock, minimumStock }); // 'ok'|'low'|'out'

  /*
   * Lookup object as switch alternative — maps level key to colour.
   * Alpha (0.75) on dark mode prevents the inner ring from looking
   * heavier than the outer ring on dark backgrounds.
   */
  const palette = isDark
    ? { ok: 'rgba(52,211,153,0.75)',  low: 'rgba(251,191,36,0.75)',  out: 'rgba(248,113,113,0.75)' }
    : { ok: '#10b981',                low: '#f59e0b',                 out: '#ef4444' };

  return palette[level] ?? palette.ok;
}

/* ── Helper: rich tooltip metadata per reminder ── */
/**
 * buildTooltipMeta(reminder)
 *
 * Transforms one reminder into a plain object containing every
 * field the tooltip needs. Built once during dataset construction
 * (not on every hover event) so tooltip callbacks are O(1) lookups.
 *
 * Uses destructuring with defaults throughout.
 *
 * @param {Object} r — reminder object
 * @returns {{ name, stock, minimumStock, statusLabel, catLabel, catEmoji, dose }}
 */
function buildTooltipMeta(r) {
  const {
    name,
    stock        = 30,
    minimumStock = 5,
    cat,
    dose         = '—',
  } = r;

  /*
   * Status label — computed from the reminder's completion state
   * AND stock state together, mirroring what the card shows.
   * isOverdue() is shared.js; getStockStatus() is shared.js.
   */
  const stockStatus = getStockStatus({ stock, minimumStock });
  const doneLabel   = r.done     ? '✅ Taken'      : null;
  const overdueLabel= isOverdue(r) ? '⚠️ Overdue'  : null;
  const pendingLabel= (!r.done && !isOverdue(r)) ? '⏳ Pending' : null;
  const statusLabel = doneLabel ?? overdueLabel ?? pendingLabel;

  /*
   * Stock status label — separate from completion status.
   * Maps 'ok'|'low'|'out' → readable string for the tooltip line.
   */
  const stockLabels = { ok: '✅ Healthy', low: '⚠️ Low Stock', out: '❌ Out of Stock' };
  const stockLabel  = stockLabels[stockStatus];

  /* CAT_META is defined in shared.js — safe to access here */
  const { label: catLabel = cat, emoji: catEmoji = '💊' } = CAT_META[cat] ?? {};

  return { name, stock, minimumStock, statusLabel, stockLabel, catLabel, catEmoji, dose };
}

/* ── Main chart function ── */
function updateChart(stats) {
  const ctx    = document.getElementById('donut-chart').getContext('2d');
  const isDark = document.body.classList.contains('dark');

  /* ── Theme-aware colour tokens ── */
  const textColor   = isDark ? '#94a3b8' : '#4a5070';
  const borderColor = isDark ? '#1e293b' : '#ffffff';
  const mutedColor  = isDark ? '#64748b' : '#8892b0';

  /* ════════════════════════════════════════════════════════════════
   * OUTER DATASET — Status breakdown (Taken / Pending / Overdue)
   *
   * Simple three-segment ring: the same data that existed before.
   * Kept as dataset[0] (outermost ring in Chart.js stacking order).
   * ════════════════════════════════════════════════════════════════ */
  const outerDataset = {
    label:           'Status',
    data:            [stats.done, stats.pending, stats.overdue],
    backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
    borderColor,
    borderWidth:     3,
    hoverOffset:     10,
    /*
     * weight controls the relative radial thickness of each dataset.
     * Outer ring gets weight:2 so it's visually dominant; the inner
     * per-medicine ring gets weight:1 (set below).
     */
    weight:          2,
  };

  /* ════════════════════════════════════════════════════════════════
   * INNER DATASET — Per-medicine stock levels
   *
   * DATASET GENERATION with map():
   *
   *   reminders.map(r => r.stock ?? 30)
   *     Each reminder becomes one segment. Segment size = stock
   *     quantity so larger-stock medicines occupy more arc. We floor
   *     at 1 so out-of-stock medicines still produce a visible (thin)
   *     segment — otherwise they'd be invisible and untouchable.
   *
   *   reminders.map(r => stockSegmentColor(r, isDark))
   *     Parallel colour array: green=healthy, amber=low, red=out.
   *     Same index as the data array — Chart.js zips them together.
   *
   *   reminders.map(buildTooltipMeta)
   *     Parallel metadata array for tooltip callbacks.
   *     buildTooltipMeta is passed as a higher-order function value —
   *     map() calls it once per reminder.
   *
   * All three arrays are the same length (reminders.length), which
   * is the requirement for Chart.js parallel data/color arrays.
   * ════════════════════════════════════════════════════════════════ */

  /*
   * tooltipMeta is stored in a closure-accessible variable so the
   * tooltip callbacks (defined inside `options`) can reference it
   * without re-running map() on every hover event.
   */
  const tooltipMeta = reminders.map(buildTooltipMeta);

  const innerDataset = {
    label:           'Stock',
    /*
     * Math.max(1, ...) ensures out-of-stock reminders (stock=0) still
     * produce a thin visible segment — otherwise they're undetectable
     * in the chart and their tooltip becomes inaccessible.
     */
    data:            reminders.map(r => Math.max(1, r.stock ?? 30)),
    backgroundColor: reminders.map(r => stockSegmentColor(r, isDark)),
    borderColor,
    borderWidth:     2,
    hoverOffset:     6,
    weight:          1,
  };

  /* ════════════════════════════════════════════════════════════════
   * STOCK SUMMARY via reduce()
   *
   * Single-pass reduce computes three counters simultaneously.
   * Used to populate the subtitle line under the chart title.
   *
   * Demonstrates the canonical reduce() accumulator pattern:
   *   initial value  → { healthy: 0, low: 0, out: 0 }
   *   each iteration → increment the matching counter, return acc
   * ════════════════════════════════════════════════════════════════ */
  const stockSummary = reminders.reduce((acc, r) => {
    const level = getStockStatus(r); // 'ok' | 'low' | 'out'
    /*
     * Computed property name: acc[level]++ maps 'ok'→acc.ok,
     * 'low'→acc.low, 'out'→acc.out in one expression.
     * We remap 'ok' → 'healthy' in the initial accumulator key
     * to match the label used in the UI.
     */
    if (level === 'ok')  acc.healthy++;
    if (level === 'low') acc.low++;
    if (level === 'out') acc.out++;
    return acc;
  }, { healthy: 0, low: 0, out: 0 });

  /* ── Assemble Chart.js data object ── */
/* ── Assemble Chart.js data object ── */

  /*
   * OUTER RING — per-status medicine name lists
   * ─────────────────────────────────────────────
   * Three parallel arrays, one per outer-ring segment.
   * Built with filter() + map() so tooltip callbacks can list every
   * medicine name under its status group without re-scanning reminders
   * on every hover event (O(n) once here, O(1) lookup in callback).
   *
   * filter() keeps only reminders matching the status predicate;
   * map(r => r.name) transforms the filtered array into a name list.
   * Both are higher-order functions — they receive an arrow function
   * and call it once per element, leaving the original array untouched.
   *
   * isOverdue() is defined in shared.js and checks time + done flag.
   * A reminder is pending only when it is neither done nor overdue.
   */
  const outerNameGroups = [
    reminders.filter(r => r.done)                          // index 0 → Taken
              .map(r => r.name),
    reminders.filter(r => !r.done && !isOverdue(r))        // index 1 → Pending
              .map(r => r.name),
    reminders.filter(r => isOverdue(r))                    // index 2 → Overdue
              .map(r => r.name),
  ];

  const chartData = {
    /*
     * DYNAMIC LABEL MAPPING:
     * Outer ring: static three-label array — matches outerDataset.data indices.
     * Inner ring: reminders.map(r => r.name) — one label per reminder.
     *
     * Chart.js uses the `labels` array for the FIRST dataset only
     * when building the default legend. We override the legend for
     * dataset[1] with display:false (see plugins.legend below) so
     * only the three outer labels appear in the legend.
     */
    labels: ['Taken', 'Pending', 'Overdue', ...reminders.map(r => r.name)],
    datasets: [outerDataset, innerDataset],
  };

  /* ════════════════════════════════════════════════════════════════
   * UPDATE PATH — if chart already exists, swap data and update.
   *
   * We must fully replace both datasets (not just .data) because
   * the colours may have changed (theme toggle) and tooltipMeta
   * must be refreshed when reminders change.
   *
   * donutChart.options is NOT replaced here — options are only set
   * on first creation (below) because Chart.js re-applies them
   * correctly on update() without re-definition.
   * ════════════════════════════════════════════════════════════════ */
 if (donutChart) {
    donutChart.data = chartData;
    /* Re-sync legend colour for theme toggle */
    donutChart.options.plugins.legend.labels.color = textColor;

    /*
     * CRITICAL: re-bind tooltipMeta on the existing tooltip callbacks.
     *
     * tooltipMeta is rebuilt above via reminders.map(buildTooltipMeta)
     * on every render() call, so it always reflects the current state
     * of reminders (stock levels, done flags, categories).
     *
     * However, the tooltip callbacks (title & label) were closed over
     * the OLD tooltipMeta from the first Chart creation — they hold a
     * reference to the original array, not the new one. Swapping
     * donutChart.data does NOT update the closure reference.
     *
     * Fix: explicitly overwrite both callbacks on the live options
     * object so they close over the freshly-built tooltipMeta.
     * Chart.js reads options.plugins.tooltip.callbacks dynamically
     * on each hover, so this takes effect immediately without recreating
     * the chart.
     */
   donutChart.options.plugins.tooltip.callbacks.title = function(items) {
      const item = items[0];

      if (item.datasetIndex === 0) {
        /*
         * Re-uses outerNameGroups rebuilt at the top of this updateChart()
         * call — same closure-refresh pattern as tooltipMeta below.
         */
        const outerLabels = ['✅ Taken', '⏳ Pending', '🔴 Overdue'];
        const count       = item.parsed;
        return `${outerLabels[item.dataIndex] ?? 'Status'} — ${count} medicine${count !== 1 ? 's' : ''}`;
      }

      const { name } = tooltipMeta[item.dataIndex] ?? {};
      return name ?? 'Medicine';
    };

    donutChart.options.plugins.tooltip.callbacks.label = function(item) {
      /* ── Outer ring ── */
      if (item.datasetIndex === 0) {
        /*
         * Fresh outerNameGroups — rebuilt by filter()+map() above,
         * so this always reflects the current reminders state.
         */
        const names = outerNameGroups[item.dataIndex] ?? [];
        if (names.length === 0) return '  —';
        return names.map(name => `  · ${name}`);
      }

      /* ── Inner ring — per-medicine detail ── */
      /*
       * Destructuring from the REFRESHED tooltipMeta (closed over
       * the new array built at the top of this updateChart() call).
       * Each field maps to one tooltip line below.
       */
      const {
        stock,
        minimumStock,
        statusLabel,
        stockLabel,
        catEmoji,
        catLabel,
        dose,
        name,
      } = tooltipMeta[item.dataIndex] ?? {};

      /*
       * Dynamic tooltip lines built with map() over a data array.
       * Each entry is [emoji, label, value] — map() formats them
       * into display strings; filter() drops falsy entries.
       */
      const fields = [
        ['📦', 'Stock',    `${stock ?? '—'} / min ${minimumStock ?? 5}`],
        ['📊', 'Status',   statusLabel ?? '—'],
        ['🏷️', 'Stock',    stockLabel  ?? '—'],
        ['💊', 'Category', `${catEmoji ?? ''} ${catLabel ?? '—'}`.trim()],
        dose && dose !== '—' ? ['💊', 'Dose', dose] : null,
      ];

      return fields
        .filter(Boolean)                           // remove null dose line when absent
        .map(([emoji, , value]) => `  ${emoji} ${value}`);
    };

    donutChart.update('active');
    return;
  }

  /* ════════════════════════════════════════════════════════════════
   * CREATION PATH — first render, build the full Chart instance.
   * ════════════════════════════════════════════════════════════════ */
  donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: chartData,
    options: {
      cutout: '60%', // slightly smaller cutout — inner ring needs space

      /*
       * responsive: true (Chart.js default) + maintainAspectRatio: false
       * lets the canvas fill its container naturally on mobile.
       */
      responsive:          true,
      maintainAspectRatio: true,

      plugins: {

        /* ── LEGEND ─────────────────────────────────────────────
         *
         * Shows only the outer-ring labels (Taken/Pending/Overdue).
         * The inner ring's per-medicine legend is suppressed via
         * the dataset-level `label` override in the labels callback.
         *
         * generateLabels() is Chart.js's built-in legend builder.
         * We filter its output to only include items whose text
         * matches one of the three outer-ring labels — this hides
         * the inner-ring segments from the legend cleanly without
         * disabling the legend for the whole chart.
         * ────────────────────────────────────────────────────── */
        legend: {
          position: 'bottom',
          labels: {
            font:     { family: "'Plus Jakarta Sans'", size: 12, weight: '600' },
            color:    textColor,
            padding:  20,
            boxWidth: 14,
            boxHeight: 14,
            borderRadius: 4,
            useBorderRadius: true,

            /*
             * generateLabels() — filter to outer ring only.
             * chart.data.datasets[0] has 3 items (Taken/Pending/Overdue).
             * Default generation would also list every reminder name
             * from dataset[1]. We keep only indices 0–2.
             */
            generateLabels(chart) {
              const ds     = chart.data.datasets[0];
              const labels = ['Taken', 'Pending', 'Overdue'];
              const colors = ['#10b981', '#f59e0b', '#ef4444'];
              /*
               * map() over the three outer labels to build legend items.
               * Each item is a plain object matching Chart.js's LegendItem
               * interface: { text, fillStyle, strokeStyle, hidden, index }.
               */
              return labels.map((text, i) => ({
                text,
                fillStyle:   colors[i],
                strokeStyle: borderColor,
                lineWidth:   2,
                hidden:      ds.data[i] === 0,
                index:       i,
                datasetIndex: 0,
              }));
            },
          },
        },

        /* ── TOOLTIP ─────────────────────────────────────────────
         *
         * Two callbacks handle the two datasets differently:
         *
         *   title(items)
         *     items is an array of tooltip items for all hovered
         *     segments. items[0].datasetIndex tells us which ring
         *     was hovered (0 = outer/status, 1 = inner/stock).
         *     We return a different header for each ring.
         *
         *   label(item)
         *     item.datasetIndex === 0  → outer ring (status group)
         *       Return a simple count line.
         *     item.datasetIndex === 1  → inner ring (per-medicine)
         *       Return a string[] — each string is one tooltip line.
         *       We look up the pre-built tooltipMeta by item.dataIndex.
         *       This is an O(1) array lookup, not a DOM query.
         *
         * TOOLTIP CUSTOMISATION:
         *   bodyFont size 13px, padding 14px give comfortable reading.
         *   displayColors: false removes the coloured square next to
         *   each line, since we already have the segment colour visible
         *   in the chart itself.
         * ────────────────────────────────────────────────────── */
        tooltip: {
          backgroundColor: isDark ? '#1e293b' : '#ffffff',
          titleColor:      isDark ? '#e2e8f0' : '#1a1f36',
          bodyColor:       isDark ? '#94a3b8' : '#4a5070',
          borderColor:     isDark ? '#2d3a52' : '#e2e6f0',
          borderWidth:     1,
          padding:         14,
          cornerRadius:    10,
          displayColors:   true,
          boxWidth:        10,
          boxHeight:       10,
          titleFont:       { family: "'Plus Jakarta Sans'", size: 13, weight: '700' },
          bodyFont:        { family: "'Plus Jakarta Sans'", size: 12 },

          callbacks: {
            /*
             * title(items)
             * ─────────────
             * Returns the tooltip header string.
             *
             * Outer ring (datasetIndex 0):
             *   'Today's Status' — group header
             * Inner ring (datasetIndex 1):
             *   The reminder's name, looked up from tooltipMeta.
             *   tooltipMeta[item.dataIndex].name is safe because
             *   tooltipMeta and innerDataset.data are built from the
             *   same reminders.map() call in the same order.
             */
            title(items) {
              const item = items[0];

              if (item.datasetIndex === 0) {
                /*
                 * Outer ring — return the status group name as the header.
                 * outerLabels[dataIndex] maps 0→Taken, 1→Pending, 2→Overdue.
                 * The count comes from the dataset value at that index.
                 */
                const outerLabels = ['✅ Taken', '⏳ Pending', '🔴 Overdue'];
                const count       = item.parsed;
                return `${outerLabels[item.dataIndex] ?? 'Status'} — ${count} medicine${count !== 1 ? 's' : ''}`;
              }

              /*
               * Inner ring — medicine name as tooltip header.
               * Destructuring from tooltipMeta (parallel to innerDataset.data).
               */
              const { name } = tooltipMeta[item.dataIndex] ?? {};
              return name ?? 'Medicine';
            },

            /*
             * label(item)
             * ────────────
             * Returns a string OR string[] for the tooltip body.
             * Chart.js renders each string as a separate line.
             *
             * Outer ring: one concise line — "Taken: 2 medicines"
             * Inner ring: four lines — stock qty, stock status,
             *   completion status, category. Sourced entirely from
             *   the pre-built tooltipMeta object via destructuring.
             */
            label(item) {
              /* ── Outer ring ── */
              if (item.datasetIndex === 0) {
                /*
                 * outerNameGroups[dataIndex] is the pre-built name list for
                 * this status segment (Taken / Pending / Overdue).
                 *
                 * map() transforms each name string into an indented line;
                 * the result is a string[] which Chart.js renders as separate
                 * tooltip body lines — one medicine name per line.
                 *
                 * Destructuring in the map arrow ({ }) is not needed here
                 * since names are plain strings, not objects.
                 *
                 * If the segment has no medicines (empty group), we return
                 * a single placeholder line so the tooltip isn't blank.
                 */
                const names = outerNameGroups[item.dataIndex] ?? [];

                if (names.length === 0) return '  —';

                /*
                 * map() over the names array — each name becomes one
                 * indented tooltip line prefixed with a bullet character.
                 */
                return names.map(name => `  · ${name}`);
              }

              /* ── Inner ring — per-medicine detail ── */
              /*
               * Destructuring with defaults from the pre-built tooltipMeta.
               * name is included so the label can stand alone if title() fails.
               */
              const {
                stock,
                minimumStock,
                statusLabel,
                stockLabel,
                catEmoji,
                catLabel,
                dose,
                name,
              } = tooltipMeta[item.dataIndex] ?? {};

              /*
               * fields[] — each entry is a tuple [emoji, key, value].
               * Using map() over an array (rather than string concatenation)
               * makes it trivial to add, remove, or reorder tooltip lines.
               *
               * Conditional entries use a ternary that resolves to null for
               * absent optional fields; filter(Boolean) removes them before
               * map() formats them into display strings.
               *
               * Destructuring in the map arrow ([emoji, , value]) skips the
               * unused middle 'key' element via the empty-slot pattern.
               */
              const fields = [
                ['📦', 'Stock',    `${stock ?? '—'} / min ${minimumStock ?? 5}`],
                ['⏰', 'Status',   statusLabel ?? '—'],
                ['🏷️', 'Stock lvl', stockLabel  ?? '—'],
                ['🗂️', 'Category', `${catEmoji ?? ''} ${catLabel ?? '—'}`.trim()],
                dose && dose !== '—' ? ['💊', 'Dose', dose] : null,
              ];

              return fields
                .filter(Boolean)                        // drop null (absent dose)
                .map(([emoji, , value]) => `  ${emoji} ${value}`);
            },
          },
        },
      },

      animation: { animateRotate: true, animateScale: false, duration: 800 },
    },
  });
}

/* ── Progress ring ── */
function updateRing(pct) {
  const circumference = 2 * Math.PI * 40;
  const offset = circumference * (1 - pct / 100);
  document.getElementById('ring-fill').style.strokeDashoffset = offset;
  document.getElementById('ring-pct').textContent = pct + '%';
  const msg =
    pct === 0   ? 'No medicines taken yet' :
    pct < 50    ? 'Keep going, you\'re doing great!' :
    pct < 100   ? 'Almost there! 🎯' :
                  '🎉 All medicines taken today!';
  document.getElementById('ring-msg').textContent = msg;
}
/* ── Stock Analytics Panel ── */
/**
 * updateAnalytics()
 * ─────────────────
 * Orchestrates the analytics pipeline for this render cycle:
 *   1. calcAnalytics()       → pure number crunching (reduce)
 *   2. buildAnalyticsCards() → turns numbers into HTML (template)
 *   3. getStockAlertItems()  → filters reminders needing attention
 *   4. buildStockAlertRows() → maps those reminders to HTML rows
 *   5. DOM writes            → inject both HTML strings
 *
 * Keeping steps 1-4 as pure functions and doing all DOM writes
 * here in one place makes the data flow easy to follow and debug.
 */
function updateAnalytics() {
  /* Step 1 — crunch the numbers (single reduce pass) */
  const analytics   = calcAnalytics(reminders);

  /* Step 2 — build analytics card HTML from the numbers */
  const cardsHTML   = buildAnalyticsCards(analytics);

  /* Step 3 — get reminders needing stock attention (filter + sort) */
  const alertItems  = getStockAlertItems();

  /* Step 4 — map those reminders to alert row HTML */
  const rowsHTML    = alertItems.length
    ? buildStockAlertRows(alertItems)
    : `<p class="stock-all-ok">✅ All medicines have sufficient stock.</p>`;

  /* Step 5 — DOM writes (only after all HTML is ready) */
  const cardsEl = document.getElementById('analytics-cards');
  const rowsEl  = document.getElementById('stock-alert-rows');
  const panelEl = document.getElementById('stock-alert-panel');

  if (cardsEl) cardsEl.innerHTML = cardsHTML;
  if (rowsEl)  rowsEl.innerHTML  = rowsHTML;

  /*
   * Show the stock alert panel only when there is something to warn
   * about. classList.toggle(class, condition) is a single-call
   * alternative to if/else add()/remove() — cleaner and atomic.
   */
  if (panelEl) panelEl.classList.toggle('show', alertItems.length > 0);
}

/* ── Main render ── */
function render() {
  const filtered = filterReminders(reminders, filterMode);
  const sorted   = sortReminders(filtered, sortMode);
  const stats    = calcStats(reminders);
  const pct      = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

  document.getElementById('s-total').textContent   = stats.total;
  document.getElementById('s-pending').textContent = stats.pending;
  document.getElementById('s-done').textContent    = stats.done;
  document.getElementById('s-overdue').textContent = stats.overdue;
  document.getElementById('hero-pct').textContent  = pct + '%';

  document.getElementById('hero-sub').textContent = stats.total === 0
    ? 'Add your first medicine reminder!'
    : `${stats.done} of ${stats.total} medicines taken today`;

  updateRing(pct);
  updateChart(stats);
  updateAnalytics();   // stock analytics cards + low-stock warning panel

  const alertEl = document.getElementById('overdue-alert');
  if (stats.overdue > 0) {
    alertEl.classList.add('show');
    document.getElementById('overdue-msg').textContent =
      `🚨 ${stats.overdue} overdue medicine${stats.overdue > 1 ? 's' : ''}! Please take them now.`;
  } else {
    alertEl.classList.remove('show');
  }

  if (Notification.permission === 'granted') {
    const dot = document.getElementById('notif-dot');
    if (dot) dot.classList.add('show');
  }

  document.getElementById('skeletons').style.display = 'none';
  const list = document.getElementById('list');
  list.style.display       = 'flex';
  list.style.flexDirection = 'column';

  if (sorted.length === 0) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">💊</div>
      <p>No reminders for this filter.<br/>
      <a href="MedMinder_Add.html" style="color:var(--accent);font-weight:700;">Add one now →</a></p></div>`;
    return;
  }

  /*
   * map() — higher-order function: transforms each reminder object
   * into an HTML string. The arrow function passed to map() is
   * called once per reminder; map() collects all return values
   * into a new array. join('') then collapses that array to one
   * string for a single innerHTML assignment (one DOM reflow).
   *
   * Two badge types are computed per card:
   *   statusTag  — done / overdue / (none)   from existing logic
   *   stockBadge — out / low / (none)         from shared.js getStockBadge()
   * Both are empty strings when not applicable, so no extra
   * conditional rendering logic is needed in the template.
   */
  list.innerHTML = sorted.map((r, i) => {
    const over = isOverdue(r);

    // ── Status badge (completion state) ──
    const statusTag = r.done
      ? `<span class="tag tag-done">✅ Taken</span>`
      : over ? `<span class="tag tag-overdue">⚠️ Overdue</span>` : '';

    /*
     * ── Stock badge ──
     * getStockBadge() is defined in shared.js (stock tracking task).
     * It receives the full reminder object and destructures internally.
     * Returns '' for healthy stock so the template stays clean.
     */
    const stockBadge = getStockBadge(r);

    /*
     * buildStockDetailTag() returns the stock count + level label.
     * Computed here (not inline) so the template string stays readable.
     * Uses destructuring with defaults internally — see its definition.
     */
    const stockDetail = buildStockDetailTag(r);

    return `
    <div class="med-card cat-${escHtml(r.cat)}${r.done ? ' done' : ''}" style="animation-delay:${i * 40}ms">
      <div class="check-box ${r.done ? 'checked' : ''}" data-action="toggle" data-id="${escHtml(r.id)}" title="${r.done ? 'Mark pending' : 'Mark taken'}" style="cursor:pointer">${r.done ? '✓' : ''}</div>
      <div class="med-info">
        <div class="med-name">${escHtml(r.name)}</div>
        <div class="med-meta">
          <span class="tag tag-time">⏰ ${formatTime(r.time)}</span>
          <span class="tag tag-dose">💊 ${escHtml(r.dose)}</span>
          <span class="tag tag-cat">${CAT_META[r.cat]?.emoji || '💊'} ${escHtml(CAT_META[r.cat]?.label || r.cat)}</span>
          <span class="tag tag-freq">🔁 ${escHtml(r.freq)}</span>
          ${statusTag}${stockBadge}
          ${stockDetail}
        </div>
        ${r.notes ? `<div class="med-notes">${escHtml(r.notes)}</div>` : ''}
      </div>
      <div class="med-actions">
        <button class="btn-icon add-stock" data-action="add-stock" data-id="${escHtml(r.id)}" title="Add stock doses">➕ Stock</button>
        <button class="btn-icon edit"      data-action="edit"      data-id="${escHtml(r.id)}" title="Edit">✏️</button>
        <button class="btn-icon del"       data-action="delete"    data-id="${escHtml(r.id)}" title="Delete">🗑️</button>
      </div>
    </div>`;
  }).join('');
}

/* ── Handlers ── */
function handleToggle(id) {
  const nowDone = toggleDone(id);
  const idx     = findById(reminders, id);
  if (idx !== -1) {
    _toast(
      nowDone
        ? `"${reminders[idx].name}" marked as taken ✓`
        : `"${reminders[idx].name}" unmarked`,
      nowDone ? 'success' : 'info'
    );
  }
  if (nowDone) cancelReminderNotif(id); // cancel pending notification
  else scheduleAllReminders();          // re-schedule if unmarked
  render();
}

function handleDelete(id) {
  const idx = findById(reminders, id);
  if (idx === -1) return;
  const name = reminders[idx].name;
  cancelReminderNotif(id);
  if (deleteReminder(id)) _toast(`Deleted "${name}"`, 'error');
  render();
}
/* ── Inventory: stock level categoriser ──────────────────────────
 *
 * getStockLevel(stock, minimumStock)
 * ──────────────────────────────────
 * Pure function — maps numeric stock onto one of three named tiers.
 * Centralising this logic here means card template, alert rows, and
 * analytics all use the SAME thresholds; changing one number fixes
 * everything at once.
 *
 * WHY NOT inline ternaries in the template?
 *   Inline ternaries scatter business logic across the UI layer.
 *   A named function is testable, readable, and reusable.
 *
 * Categories (matches requirements):
 *   'healthy'  → stock > minimumStock  (no warning needed)
 *   'low'      → 1 ≤ stock ≤ minimumStock
 *   'out'      → stock === 0
 *
 * @param  {number} stock
 * @param  {number} minimumStock
 * @returns {'healthy'|'low'|'out'}
 */
function getStockLevel(stock = 30, minimumStock = 5) {
  if (stock === 0)          return 'out';
  if (stock <= minimumStock) return 'low';
  return 'healthy';
}

/* ── Inventory: stock detail tag for cards ───────────────────────
 *
 * buildStockDetailTag(reminder)
 * ──────────────────────────────
 * Returns a small inline HTML tag showing the current stock count
 * plus a warning label when stock is low or out.
 *
 * Uses destructuring with defaults so reminders that pre-date stock
 * tracking still render correctly (stock=30, minimumStock=5).
 *
 * Three cases handled via a lookup object (higher-order pattern):
 *   out     → red  "❌ Out of Stock"
 *   low     → amber "⚠ Low Stock · N left"
 *   healthy → blue  "📦 Stock: N"  (visible but unstyled)
 *
 * @param  {Object} reminder
 * @returns {string} HTML string — always returns something (never '')
 */
function buildStockDetailTag({ stock = 30, minimumStock = 5 }) {
  const level = getStockLevel(stock, minimumStock);

  /*
   * Lookup object used as a switch alternative.
   * Each value is a template string — the level key selects the
   * right one. This avoids an if/else chain and keeps all three
   * variants visible side by side for easy comparison.
   */
  const tags = {
    out:     `<span class="tag stock-tag stock-tag-out">❌ Out of Stock</span>`,
    low:     `<span class="tag stock-tag stock-tag-low">⚠ Low Stock · ${stock} left</span>`,
    healthy: `<span class="tag stock-tag stock-tag-ok">📦 Stock: ${stock}</span>`,
  };

  return tags[level];
}

/* ── Inventory: Add Stock handler ────────────────────────────────
 *
 * handleAddStock(id)
 * ──────────────────
 * Prompts the user for how many doses to add, validates the input,
 * writes the new stock value back to the reminders array, and calls
 * saveReminders() to persist to localStorage — all in one function.
 *
 * DATA FLOW (localStorage update):
 *   1. findById()     → locate the reminder's index in the array
 *   2. Validate input → parse, guard NaN, guard negatives
 *   3. Mutate field   → reminders[idx].stock += amount
 *   4. saveReminders()→ JSON.stringify(reminders) → localStorage.setItem()
 *   5. render()       → re-paint dashboard with updated values
 *
 * WHY NOT updateReminder()?
 *   updateReminder() in shared.js requires the full medicine form
 *   payload (name, dose, time, cat, freq, notes). We only need to
 *   touch one field — a targeted mutation + saveReminders() is
 *   cleaner and avoids clobbering unrelated fields.
 *
 * @param {string} id — reminder id from card's data-id attribute
 */
function handleAddStock(id) {
  /*
   * findById returns the array index, not the object.
   * We need the index so we can mutate in place and saveReminders()
   * will serialise the updated array correctly.
   */
  const idx = findById(reminders, id);
  if (idx === -1) return;

  /*
   * Destructuring with defaults — same pattern used throughout
   * shared.js. If stock is undefined (old reminder), we start at 30.
   */
  const { name, stock = 30, minimumStock = 5 } = reminders[idx];

  /*
   * prompt() is the lightest possible UI — no modal dependency.
   * Returns null when the user cancels (we guard for that below).
   */
  const raw = prompt(
    `➕ Add stock for "${name}"\n\nCurrent stock: ${stock} dose${stock !== 1 ? 's' : ''}\nMinimum threshold: ${minimumStock}\n\nEnter doses to add:`,
    '10'
  );

  if (raw === null) return; // user cancelled — do nothing

  /*
   * parseInt(raw, 10) — radix 10 prevents octal parsing of inputs
   * like "010". isNaN() and <= 0 guards reject garbage inputs.
   */
  const amount = parseInt(raw, 10);
  if (isNaN(amount) || amount <= 0) {
    _toast('⚠️ Please enter a positive whole number', 'error');
    return;
  }

  /* Hard cap: a single add of > 999 is almost certainly a typo */
  if (amount > 999) {
    _toast('⚠️ Maximum single addition is 999 doses', 'error');
    return;
  }

  /*
   * Direct mutation — we update only the stock field.
   * The spread in updateReminder() would also work but requires
   * a full form payload; this is the minimal targeted write.
   */
  reminders[idx].stock = stock + amount;

  /*
   * saveReminders() (shared.js) serialises the full reminders array
   * to localStorage via JSON.stringify. One call covers everything:
   *   reminders[idx].stock mutation → saveReminders()
   *     → JSON.stringify(reminders) → localStorage.setItem(key, json)
   */
  saveReminders();

  /*
   * Post-add stock categorisation for the toast.
   * Uses filter() + .length as a higher-order summary — count how
   * many reminders are now low/out after the update.
   */
  const newLevel    = getStockLevel(reminders[idx].stock, minimumStock);
  const levelLabels = { healthy: 'healthy ✅', low: 'low ⚠️', out: 'out ❌' };

  _toast(
    `Added ${amount} dose${amount !== 1 ? 's' : ''} to "${name}" · now ${reminders[idx].stock} (${levelLabels[newLevel]})`,
    newLevel === 'healthy' ? 'success' : newLevel === 'low' ? 'warn' : 'error'
  );

  render(); // re-paint cards, analytics, and stock alert panel
}

function goEdit(id) {
  sessionStorage.setItem('editId', id);
  location.href = 'MedMinder_Add.html';
}

function markAllDone() {
  const pending = reminders.filter(r => !r.done);
  pending.forEach(r => toggleDone(r.id));
  _toast(
    pending.length > 0 ? `Marked ${pending.length} as taken ✓` : 'All already taken!',
    pending.length > 0 ? 'success' : 'info'
  );
  render();
}

function promptUser() {
  const name = prompt('Enter your name / profile:', currentUser);
  if (name && name.trim()) {
    currentUser = name.trim().toLowerCase() || 'default';
    localStorage.setItem(USER_KEY, currentUser);
    loadReminders();
    updateUserUI();
    _toast(`Switched to profile: ${currentUser}`, 'info');
    seedDemo();
    render();
  }
}

function updateUserUI() {

   // Get logged-in user from sessionStorage
   const user = getCurrentUser();

   // If no user found, stop execution
   if (!user) return;

   // Update avatar and username in navbar
   document.getElementById('user-avatar').textContent =
      (user.name || "User").charAt(0).toUpperCase();

   document.getElementById('user-name-display').textContent =
      user.name || "User";
}

/* ── Event listeners ── */

/*
 * FILTER chips — unchanged, already uses event delegation correctly.
 */
document.getElementById('filters').addEventListener('click', e => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  filterMode = btn.dataset.filter;
  document.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  render();
});

document.querySelectorAll('.sort-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    sortMode = btn.dataset.sort;
    document.querySelectorAll('.sort-chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    render();
  });
});

/*
 * ── EVENT DELEGATION for medicine card actions ──────────────────
 *
 * WHY EVENT DELEGATION?
 *   Medicine cards are created dynamically — they don't exist in
 *   the DOM at page load. Attaching onclick="" inline handlers or
 *   calling addEventListener() inside render() means:
 *     • A new listener is created for EVERY card on EVERY render.
 *     • Old listeners leak if the element is replaced by innerHTML.
 *     • Memory grows with each re-render cycle.
 *
 * EVENT DELEGATION SOLUTION:
 *   Attach ONE listener to the static parent (#list-root — the
 *   permanent wrapper that always exists). When a button inside
 *   any card is clicked, the event BUBBLES UP through the DOM tree
 *   until it reaches #list-root. We inspect e.target there.
 *
 * PERFORMANCE BENEFIT:
 *   1 listener replaces N×3 listeners (N = number of cards).
 *   For 50 reminders that's 150 listeners → 1. The listener also
 *   survives render() re-paints automatically since it is on the
 *   stable parent, not the replaced children.
 *
 * DYNAMIC DOM HANDLING:
 *   Because delegation listens on a persistent ancestor, newly
 *   injected cards are covered immediately — no re-binding needed.
 *   e.target.closest() walks up from the actual clicked element
 *   (which might be an emoji span inside the button) to find the
 *   nearest matching ancestor with the data-action attribute.
 *
 * DATA FLOW:
 *   HTML buttons carry  data-action="toggle|edit|delete"
 *                       data-id="<reminder-id>"
 *   The handler reads both via element.dataset.
 */
document.getElementById('list').addEventListener('click', e => {
  /*
   * e.target is the exact element clicked — could be the button
   * itself, or a text/emoji node inside it.
   * .closest('[data-action]') walks UP the DOM from e.target and
   * returns the first ancestor (inclusive) that has data-action,
   * or null if none found (e.g. clicking the card background).
   */
  const el = e.target.closest('[data-action]');
  if (!el) return; // click was not on an action element — ignore

  /*
   * dataset.action and dataset.id are set directly on the button
   * in the render() template. No DOM query needed — the data
   * travels with the event through bubbling.
   */
  const { action, id } = el.dataset;
  if (!id) return; // safety guard — malformed element

  /*
   * classList.contains() checks which action type triggered.
   * A switch over dataset.action would also work; classList is
   * used here to show the pattern explicitly as required.
   */
 if (el.classList.contains('check-box') || action === 'toggle') {
    handleToggle(id);
  } else if (action === 'add-stock') {
    /*
     * 'add-stock' bubbles up from the ➕ Stock button.
     * Routed here rather than via inline onclick so the single
     * parent listener covers dynamically re-rendered cards.
     */
    handleAddStock(id);
  } else if (action === 'edit') {
    goEdit(id);
  } else if (action === 'delete') {
    handleDelete(id);
  }
});

/*
 * Stock alert panel — also uses delegation.
 * The panel is populated dynamically by updateAnalytics() so the
 * same reasoning applies: one listener on the stable parent covers
 * all dynamically injected edit buttons inside alert rows.
 */
document.getElementById('stock-alert-panel').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  if (!id) return;
  if (action === 'edit') goEdit(id);
});

/* ── Init ── */
(function init() {
  if (!protectRoute()) return;
  initTheme();
  initToast();
  initUser();
  loadReminders();
  seedDemo();
  updateGreeting();
  updateUserUI();
  document.querySelectorAll('.nav-link').forEach(a =>
    a.classList.toggle('active', a.getAttribute('href').includes('Dashboard'))
  );
  setTimeout(render, 400);
  initNotifications();           // auto-request permission + schedule precise timers
  setInterval(checkReminders, 60000);  // fallback polling
  setInterval(render, 60000);
})();
