/* ============================================================
   MedMinder v3 — History Page Logic (history.js)
============================================================ */

'use strict';

let hFilter     = 'all';
let hSort       = 'time';
let viewMode    = 'card';
let searchQ     = '';
let statusChart = null;

/* ── Called by shared.js on theme change (BUG FIX #7) ── */
function onThemeChanged() {
  if (statusChart) {
    statusChart.destroy();
    statusChart = null;
  }
  render();
}

function setView(m) {
  viewMode = m;
  document.getElementById('vt-card').classList.toggle('active',  m === 'card');
  document.getElementById('vt-table').classList.toggle('active', m === 'table');
  render();
}

/* ============================================================
   STATUS DONUT CHART — updateStatusChart(stats)
   ──────────────────────────────────────────────
   Renders a doughnut chart with TWO datasets:

     Outer ring — Status breakdown (Taken / Pending / Overdue)
       Three segments sized by medicine count per group.
       Tooltips list every medicine name in that group.

     Inner ring — Per-medicine stock levels (Healthy / Low / Out)
       One segment per reminder, coloured by stock tier.
       Tooltips show name, stock qty, stock status, category,
       reminder time, and dose.

   TOOLTIP ARCHITECTURE:
     tooltipMeta  — built once with reminders.map(buildHistTooltipMeta)
                    O(n) at render time; O(1) lookup on every hover.
     outerNameGroups — three name arrays (one per status group)
                    built with filter()+map(); same O(n)/O(1) split.

   UPDATE vs CREATION:
     On update, we re-assign both callbacks on the live options object
     so the new tooltipMeta / outerNameGroups closures take effect
     immediately without destroying and recreating the chart.
     (Chart.js reads callbacks dynamically on each hover.)
============================================================ */

/* ── Helper: stock segment colour per reminder ── */
/**
 * histStockColor(r, isDark)
 *
 * Maps stock level → colour for the inner ring segment.
 * Mirrors stockSegmentColor() in dashboard.js — kept local so
 * history.js has no dependency on dashboard.js being loaded.
 *
 * @param {Object}  r      — reminder object
 * @param {boolean} isDark — current theme flag
 * @returns {string} CSS colour string
 */
function histStockColor(r, isDark) {
  /*
   * Destructuring with defaults — backwards-compatible with reminders
   * saved before stock tracking was added (stock/minimumStock absent).
   */
  const { stock = 30, minimumStock = 5 } = r;
  const level = getStockStatus({ stock, minimumStock }); // 'ok'|'low'|'out'

  /*
   * Lookup object as switch alternative — maps level key → colour.
   * Slightly transparent in dark mode so the inner ring doesn't
   * visually overpower the outer status ring.
   */
  const palette = isDark
    ? { ok: 'rgba(52,211,153,0.75)', low: 'rgba(251,191,36,0.75)', out: 'rgba(248,113,113,0.75)' }
    : { ok: '#10b981',               low: '#f59e0b',                out: '#ef4444' };

  return palette[level] ?? palette.ok;
}

/* ── Helper: rich tooltip metadata per reminder ── */
/**
 * buildHistTooltipMeta(r)
 *
 * Transforms one reminder into a plain object containing every
 * field the tooltip needs. Called once via reminders.map() during
 * dataset construction — NOT on every hover event.
 *
 * Mirrors buildTooltipMeta() in dashboard.js, extended with `time`
 * (reminder time) so the History chart can show the scheduled time.
 *
 * Uses destructuring with defaults throughout for safety.
 *
 * @param {Object} r — reminder object
 * @returns {{ name, stock, minimumStock, statusLabel, stockLabel,
 *             catLabel, catEmoji, dose, time }}
 */
function buildHistTooltipMeta(r) {
  const {
    name,
    stock        = 30,
    minimumStock = 5,
    cat,
    dose         = '—',
    time         = '',
  } = r;

  /*
   * Completion + overdue status — mirrors what the card badge shows.
   * isOverdue() is defined in shared.js.
   * Ternary chain: done wins > overdue > pending.
   */
  const statusLabel =
    r.done       ? '✅ Taken'   :
    isOverdue(r) ? '⚠️ Overdue' :
                   '⏳ Pending';

  /*
   * Stock health label — separate axis from completion status.
   * Maps 'ok'|'low'|'out' → emoji-prefixed readable string.
   */
  const stockStatus = getStockStatus({ stock, minimumStock });
  const stockLabels = { ok: '✅ Healthy', low: '⚠️ Low Stock', out: '❌ Out of Stock' };
  const stockLabel  = stockLabels[stockStatus];

  /* CAT_META is defined in shared.js */
  const { label: catLabel = cat, emoji: catEmoji = '💊' } = CAT_META[cat] ?? {};

  /* formatTime() is defined in shared.js — converts 'HH:MM' → '8:00 AM' */
  const timeLabel = time ? formatTime(time) : '—';

  return { name, stock, minimumStock, statusLabel, stockLabel, catLabel, catEmoji, dose, timeLabel };
}

/* ── Main chart function ── */
function updateStatusChart(stats) {
  const ctx    = document.getElementById('status-chart').getContext('2d');
  const isDark = document.body.classList.contains('dark');

  /* ── Theme-aware colour tokens ── */
  const textColor   = isDark ? '#94a3b8' : '#4a5070';
  const borderColor = isDark ? '#1e293b' : '#ffffff';
  const mutedColor  = isDark ? '#64748b' : '#8892b0';

  /* ════════════════════════════════════════════════════════════════
   * OUTER DATASET — Status breakdown (Taken / Pending / Overdue)
   *
   * Three-segment ring. Segment size = count of medicines per group.
   * dataIndex mapping: 0 → Taken, 1 → Pending, 2 → Overdue.
   * ════════════════════════════════════════════════════════════════ */
  const outerDataset = {
    label:           'Status',
    data:            [stats.done, stats.pending, stats.overdue],
    backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
    borderColor,
    borderWidth:     3,
    hoverOffset:     10,
    /*
     * weight:2 gives the outer ring more radial thickness than the
     * inner per-medicine ring (weight:1 below), keeping the status
     * breakdown visually dominant.
     */
    weight:          2,
  };

  /* ════════════════════════════════════════════════════════════════
   * INNER DATASET — Per-medicine stock levels
   *
   * DATASET GENERATION with map():
   *
   *   reminders.map(r => Math.max(1, r.stock ?? 30))
   *     One segment per reminder. Size = stock quantity so
   *     higher-stock medicines occupy more arc. Math.max(1, ...)
   *     ensures out-of-stock (stock=0) medicines still produce a
   *     thin visible segment — otherwise they're undetectable and
   *     their tooltip becomes inaccessible.
   *
   *   reminders.map(r => histStockColor(r, isDark))
   *     Parallel colour array: green=healthy, amber=low, red=out.
   *     Same index as data array — Chart.js zips them together.
   *
   *   reminders.map(buildHistTooltipMeta)
   *     Parallel metadata array for tooltip callbacks.
   *     buildHistTooltipMeta is passed as a higher-order function
   *     value — map() calls it once per reminder.
   *
   * All three arrays share the same length (reminders.length).
   * ════════════════════════════════════════════════════════════════ */

  /*
   * tooltipMeta — stored in a variable accessible to the tooltip
   * callbacks defined below. Built once here (O(n)), then each
   * hover is an O(1) index lookup into this pre-built array.
   */
  const tooltipMeta = reminders.map(buildHistTooltipMeta);

  const innerDataset = {
    label:           'Stock',
    data:            reminders.map(r => Math.max(1, r.stock ?? 30)),
    backgroundColor: reminders.map(r => histStockColor(r, isDark)),
    borderColor,
    borderWidth:     2,
    hoverOffset:     6,
    weight:          1,
  };

  /* ════════════════════════════════════════════════════════════════
   * OUTER RING — per-status name lists
   *
   * Built with filter()+map() — two higher-order functions chained:
   *   filter() keeps only reminders matching the status predicate,
   *   returning a new array (original untouched).
   *   map(r => r.name) transforms each reminder → its name string.
   *
   * Three parallel arrays, one per segment (Taken/Pending/Overdue).
   * outerNameGroups[dataIndex] gives the name list for that segment —
   * the same dataIndex Chart.js passes into tooltip callbacks.
   *
   * A reminder is pending only when it is neither done nor overdue.
   * isOverdue() is defined in shared.js.
   * ════════════════════════════════════════════════════════════════ */
  const outerNameGroups = [
    reminders.filter(r => r.done)                      // index 0 → Taken
              .map(r => r.name),
    reminders.filter(r => !r.done && !isOverdue(r))    // index 1 → Pending
              .map(r => r.name),
    reminders.filter(r => isOverdue(r))                // index 2 → Overdue
              .map(r => r.name),
  ];

  /* ── Assemble Chart.js data object ── */
  const chartData = {
    /*
     * DYNAMIC LABEL MAPPING:
     *   Outer ring:  ['Taken', 'Pending', 'Overdue'] — three static labels.
     *   Inner ring:  reminders.map(r => r.name) — one label per reminder.
     *
     * Chart.js uses the labels array for the FIRST dataset's legend.
     * The inner-ring legend is suppressed via generateLabels() below
     * so only the three outer status labels appear.
     *
     * item.label in tooltip callbacks resolves from this flat array
     * using dataIndex — inner ring items get their medicine name here
     * as a correct fallback even if the title callback were removed.
     */
    labels:   ['Taken', 'Pending', 'Overdue', ...reminders.map(r => r.name)],
    datasets: [outerDataset, innerDataset],
  };

  /* ════════════════════════════════════════════════════════════════
   * UPDATE PATH — chart already exists, swap data + refresh callbacks.
   *
   * We replace both datasets (not just .data) because colours may
   * have changed (theme toggle) and tooltipMeta / outerNameGroups
   * must be refreshed when reminders change.
   *
   * CRITICAL — re-assign both tooltip callbacks so they close over
   * the fresh tooltipMeta and outerNameGroups built above.
   * Chart.js reads callbacks dynamically on each hover, so this
   * takes effect immediately without recreating the chart.
   * ════════════════════════════════════════════════════════════════ */
  if (statusChart) {
    statusChart.data = chartData;
    statusChart.options.plugins.legend.labels.color = textColor;

    /* ── title callback — refresh closure ── */
    statusChart.options.plugins.tooltip.callbacks.title = function(items) {
      const item = items[0];

      if (item.datasetIndex === 0) {
        /*
         * Outer ring header — status group name + medicine count.
         * outerLabels[dataIndex] maps 0→Taken, 1→Pending, 2→Overdue.
         * item.parsed is the raw data value (medicine count).
         */
        const outerLabels = ['✅ Taken', '⏳ Pending', '🔴 Overdue'];
        const count       = item.parsed;
        return `${outerLabels[item.dataIndex] ?? 'Status'} — ${count} medicine${count !== 1 ? 's' : ''}`;
      }

      /*
       * Inner ring header — medicine name from freshly-built tooltipMeta.
       * Destructuring pulls only `name` from the meta object.
       */
      const { name } = tooltipMeta[item.dataIndex] ?? {};
      return name ?? 'Medicine';
    };

    /* ── label callback — refresh closure ── */
    statusChart.options.plugins.tooltip.callbacks.label = function(item) {
      /* ── Outer ring — list medicine names in this status group ── */
      if (item.datasetIndex === 0) {
        /*
         * outerNameGroups[dataIndex] is the pre-filtered name list.
         * map() transforms each name string into an indented bullet line.
         * Chart.js renders string[] as one line per element.
         * If the group is empty (count=0) return a placeholder so
         * the tooltip body isn't blank.
         */
        const names = outerNameGroups[item.dataIndex] ?? [];
        if (names.length === 0) return '  —';
        return names.map(name => `  · ${name}`);
      }

      /* ── Inner ring — per-medicine rich detail ── */
      /*
       * Destructuring from the REFRESHED tooltipMeta.
       * Each field becomes one tooltip line via the fields array below.
       */
      const {
        stock,
        minimumStock,
        statusLabel,
        stockLabel,
        catEmoji,
        catLabel,
        dose,
        timeLabel,
      } = tooltipMeta[item.dataIndex] ?? {};

      /*
       * fields[] — each entry is [emoji, value].
       * map() over this array (higher-order function) formats each
       * tuple into an indented display string.
       * filter(Boolean) removes null entries (absent optional fields).
       *
       * Destructuring in the map arrow ([emoji, value]) unpacks the
       * two-element tuple cleanly without index access.
       */
      const fields = [
        ['⏰', timeLabel   ?? '—'],
        ['📦', `Stock: ${stock ?? '—'} / min ${minimumStock ?? 5}`],
        ['📊', statusLabel ?? '—'],
        ['🏷️', stockLabel  ?? '—'],
        ['🗂️', `${catEmoji ?? ''} ${catLabel ?? '—'}`.trim()],
        dose && dose !== '—' ? ['💊', `Dose: ${dose}`] : null,
      ];

      return fields
        .filter(Boolean)                           // drop null (absent dose)
        .map(([emoji, value]) => `  ${emoji} ${value}`);
    };

    statusChart.update('active');
    return;
  }

  /* ════════════════════════════════════════════════════════════════
   * CREATION PATH — first render, build the full Chart instance.
   * ════════════════════════════════════════════════════════════════ */
  statusChart = new Chart(ctx, {
    type: 'doughnut',
    data: chartData,
    options: {
      cutout: '60%', // slightly smaller than 70% to give inner ring room

      responsive:          true,
      maintainAspectRatio: true,

      plugins: {

        /* ── LEGEND ─────────────────────────────────────────────
         *
         * Shows only the outer-ring labels (Taken/Pending/Overdue).
         * generateLabels() filters Chart.js's default output to
         * only include the three outer-ring items, hiding the inner
         * per-medicine legend without disabling the legend entirely.
         * ────────────────────────────────────────────────────── */
        legend: {
          position: 'bottom',
          labels: {
            font:            { family: "'Plus Jakarta Sans'", size: 12, weight: '600' },
            color:           textColor,
            padding:         16,
            boxWidth:        12,
            boxHeight:       12,
            borderRadius:    4,
            useBorderRadius: true,

            /*
             * generateLabels() — keep only the three outer-ring items.
             * map() over the static label list builds LegendItem objects
             * matching Chart.js's interface: { text, fillStyle, ... }.
             * hidden: true when the segment count is zero — greys it out.
             */
            generateLabels(chart) {
              const ds     = chart.data.datasets[0];
              const labels = ['Taken', 'Pending', 'Overdue'];
              const colors = ['#10b981', '#f59e0b', '#ef4444'];
              return labels.map((text, i) => ({
                text,
                fillStyle:    colors[i],
                strokeStyle:  borderColor,
                lineWidth:    2,
                hidden:       ds.data[i] === 0,
                index:        i,
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
         *     items[0].datasetIndex === 0  → outer ring
         *       Shows status group name + count as the header.
         *     items[0].datasetIndex === 1  → inner ring
         *       Shows the medicine name looked up from tooltipMeta.
         *
         *   label(item)
         *     item.datasetIndex === 0  → outer ring
         *       Returns string[] of medicine names in that group,
         *       one name per tooltip line, prefixed with '·'.
         *     item.datasetIndex === 1  → inner ring
         *       Returns string[] of detail lines:
         *       time, stock qty, completion status, stock health,
         *       category, and dose (optional).
         *
         * Both callbacks use pre-built arrays (tooltipMeta,
         * outerNameGroups) for O(1) lookup — no re-filtering on hover.
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
             * Outer ring: status group name + count as tooltip header.
             * Inner ring: medicine name from tooltipMeta.
             *
             * items is an array of tooltip items for all hovered segments.
             * We only inspect items[0] — Chart.js passes one item per
             * hovered segment; for a doughnut there is always exactly one.
             */
            title(items) {
              const item = items[0];

              if (item.datasetIndex === 0) {
                /*
                 * outerLabels[dataIndex] gives the status group name.
                 * item.parsed is the raw segment value (medicine count).
                 */
                const outerLabels = ['✅ Taken', '⏳ Pending', '🔴 Overdue'];
                const count       = item.parsed;
                return `${outerLabels[item.dataIndex] ?? 'Status'} — ${count} medicine${count !== 1 ? 's' : ''}`;
              }

              /*
               * Inner ring — medicine name.
               * Destructuring: pulls only `name` out of the meta object.
               * tooltipMeta[dataIndex] is safe because tooltipMeta and
               * innerDataset.data are both built from reminders.map()
               * in the same iteration order.
               */
              const { name } = tooltipMeta[item.dataIndex] ?? {};
              return name ?? 'Medicine';
            },

            /*
             * label(item)
             * ────────────
             * Returns string | string[] for the tooltip body.
             * Chart.js renders each string as a separate body line.
             *
             * Outer ring (datasetIndex 0):
             *   string[] — one '· MedicineName' line per medicine in group.
             *
             * Inner ring (datasetIndex 1):
             *   string[] built from fields[] using map() + filter(Boolean).
             *   Each field is a [emoji, value] tuple; destructuring in the
             *   map arrow unpacks it cleanly without index access.
             */
            label(item) {
              /* ── Outer ring — list names in this status segment ── */
              if (item.datasetIndex === 0) {
                /*
                 * outerNameGroups[dataIndex] → pre-filtered name array.
                 * map() formats each name into a '· Name' line.
                 * filter(Boolean) is not needed here (names are strings)
                 * but added defensively against any empty-string names.
                 */
                const names = outerNameGroups[item.dataIndex] ?? [];
                if (names.length === 0) return '  —';
                return names.map(name => `  · ${name}`);
              }

              /* ── Inner ring — per-medicine rich detail ── */
              /*
               * Destructuring from tooltipMeta — all fields pre-computed
               * by buildHistTooltipMeta() at dataset construction time.
               * No DOM access, no re-filtering here — pure O(1) lookup.
               */
              const {
                stock,
                minimumStock,
                statusLabel,
                stockLabel,
                catEmoji,
                catLabel,
                dose,
                timeLabel,
              } = tooltipMeta[item.dataIndex] ?? {};

              /*
               * fields[] — each element is a [emoji, value] tuple or null.
               *
               * DESIGN:
               *   Array of tuples (rather than direct string concatenation)
               *   makes it trivial to add, remove, or reorder tooltip lines.
               *   filter(Boolean) removes null entries before map() runs.
               *
               * DESTRUCTURING IN MAP:
               *   .map(([emoji, value]) => ...) destructures each tuple
               *   in the arrow parameter — the empty-slot pattern is not
               *   needed here since both elements are used.
               *
               * LINES (in display order):
               *   1. Scheduled time
               *   2. Stock quantity with minimum threshold
               *   3. Completion status (Taken / Pending / Overdue)
               *   4. Stock health (Healthy / Low / Out)
               *   5. Category with emoji
               *   6. Dose — only when present and not '—'
               */
              const fields = [
                ['⏰', timeLabel   ?? '—'],
                ['📦', `Stock: ${stock ?? '—'} / min ${minimumStock ?? 5}`],
                ['📊', statusLabel ?? '—'],
                ['🏷️', stockLabel  ?? '—'],
                ['🗂️', `${catEmoji ?? ''} ${catLabel ?? '—'}`.trim()],
                dose && dose !== '—' ? ['💊', `Dose: ${dose}`] : null,
              ];

              return fields
                .filter(Boolean)
                .map(([emoji, value]) => `  ${emoji} ${value}`);
            },
          },
        },
      },

      animation: { animateRotate: true, animateScale: false, duration: 700 },
    },
  });
}

/* ── Category bars ── */
function renderCatBars() {
  const counts = reminders.reduce((a, r) => { a[r.cat] = (a[r.cat] || 0) + 1; return a; }, {});
  const total  = reminders.length || 1;
  const colors = { morning: '#f59e0b', afternoon: '#3b82f6', evening: '#8b5cf6', night: '#06b6d4', asneeded: '#ef4444' };
  document.getElementById('cat-bars').innerHTML = CAT_ORDER.map(cat => {
    const count = counts[cat] || 0;
    const pct   = Math.round(count / total * 100);
    const meta  = CAT_META[cat];
    return `<div class="br-row">
      <div class="br-lbl">${meta.emoji} ${meta.label}</div>
      <div class="br-track"><div class="br-fill" style="width:${pct}%;background:${colors[cat]}"></div></div>
      <div class="br-count">${count}</div>
    </div>`;
  }).join('');
}

/* ── Main render ── */
function render() {
  const stats = calcStats(reminders);
  document.getElementById('h-total').textContent = reminders.length;
  document.getElementById('h-done').textContent  = stats.done;
  const rate = reminders.length > 0 ? Math.round(stats.done / reminders.length * 100) : 0;
  document.getElementById('h-rate').textContent  = rate + '%';

  updateStatusChart(stats);
  renderCatBars();

  let result = filterReminders(reminders, hFilter);
  result     = sortReminders(result, hSort);
  if (searchQ.trim()) {
    const q = searchQ.toLowerCase();
    result = result.filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.dose.toLowerCase().includes(q) ||
      r.notes.toLowerCase().includes(q)
    );
  }

  document.getElementById('result-count').textContent =
    `${result.length} of ${reminders.length} reminder${reminders.length !== 1 ? 's' : ''}`;
  document.getElementById('result-stats').textContent =
    `| ${stats.done} taken, ${stats.overdue} overdue`;

  document.getElementById('skeletons').style.display = 'none';
  const container = document.getElementById('history-content');
  container.style.display = 'block';

  if (result.length === 0) {
    container.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div>
      <p>No reminders found.<br/>
      <a href="MedMinder_Add.html" style="color:var(--accent);font-weight:700;">Add one →</a></p></div>`;
    return;
  }

  viewMode === 'table' ? renderTable(result, container) : renderCards(result, container);
}

/* ── Cards view ── */
function renderCards(data, container) {
  container.innerHTML = `<div id="list" style="display:flex;flex-direction:column;gap:10px">${
    data.map((r, i) => {
      const over   = isOverdue(r);
      const meta   = CAT_META[r.cat] || { emoji: '💊', label: r.cat };
      const statusTag = r.done
        ? `<span class="tag tag-done">✅ Taken</span>`
        : over
          ? `<span class="tag tag-overdue">⚠️ Overdue</span>`
          : `<span class="tag" style="background:var(--yellow-bg);color:#92400e;">⏳ Pending</span>`;
     /*
       * buildStockDetailTag() is defined in dashboard.js.
       * history.js is loaded after dashboard.js on the History page?
       * Actually each page loads its own JS. We reuse the same
       * getStockBadge() from shared.js here for the history page,
       * and define a local stockDetail inline using getStockLevel().
       *
       * getStockLevel is defined in dashboard.js which is NOT loaded
       * on the History page, so we replicate the inline logic here
       * using the shared.js getStockStatus() helper which already
       * exists and returns 'out' | 'low' | 'ok'.
       *
       * STOCK DETAIL TAG — inline factory:
       *   Destructuring with defaults ensures backwards compatibility.
       *   getStockStatus() (shared.js) maps to level labels.
       *   A lookup object (higher-order pattern) selects the tag HTML.
       */
      const { stock: rStock = 30, minimumStock: rMin = 5 } = r;
      const rLevel   = getStockStatus({ stock: rStock, minimumStock: rMin });
      const stockDetailH = {
        out: `<span class="tag stock-tag stock-tag-out">❌ Out of Stock</span>`,
        low: `<span class="tag stock-tag stock-tag-low">⚠ Low Stock · ${rStock} left</span>`,
        ok:  `<span class="tag stock-tag stock-tag-ok">📦 Stock: ${rStock}</span>`,
      }[rLevel];

      return `<div class="med-card cat-${escHtml(r.cat)}${r.done ? ' done' : ''}" style="animation-delay:${i * 35}ms">
        <div class="check-box ${r.done ? 'checked' : ''}" data-action="toggle" data-id="${escHtml(r.id)}" style="cursor:pointer">${r.done ? '✓' : ''}</div>
        <div class="med-info">
          <div class="med-name">${escHtml(r.name)}</div>
          <div class="med-meta">
            <span class="tag tag-time">⏰ ${formatTime(r.time)}</span>
            <span class="tag tag-dose">💊 ${escHtml(r.dose)}</span>
            <span class="tag tag-cat">${meta.emoji} ${escHtml(meta.label)}</span>
            <span class="tag tag-freq">🔁 ${escHtml(r.freq)}</span>
            ${statusTag}
            ${stockDetailH}
          </div>
          ${r.notes ? `<div class="med-notes">${escHtml(r.notes)}</div>` : ''}
        </div>
        <div class="med-actions">
          <button class="btn-icon add-stock" data-action="add-stock" data-id="${escHtml(r.id)}" title="Add stock doses">➕ Stock</button>
          <button class="btn-icon edit"      data-action="edit"      data-id="${escHtml(r.id)}" title="Edit">✏️</button>
          <button class="btn-icon del"       data-action="delete"    data-id="${escHtml(r.id)}" title="Delete">🗑️</button>
        </div>
      </div>`;
    }).join('')
  }</div>`;
}

/* ── Table view ── */
function renderTable(data, container) {
  container.innerHTML = `<div class="tbl-wrap"><table class="med-table">
    <thead><tr>
      <th>Medicine</th><th>Dose</th><th>Time</th><th>Category</th><th>Frequency</th><th>Status</th><th>Stock</th><th>Actions</th>    </tr></thead>
    <tbody>${data.map(r => {
      const over = isOverdue(r);
      const meta = CAT_META[r.cat] || { emoji: '💊', label: r.cat };
      const sc   = r.done ? 'status-done' : over ? 'status-overdue' : 'status-pending';
      const st   = r.done ? '✅ Taken'    : over ? '⚠️ Overdue'    : '⏳ Pending';
      /*
       * Stock column — uses getStockStatus() (shared.js) to pick a
       * display string. reduce()-computed totals live in render();
       * here we only need per-row status for the table cell.
       *
       * Destructuring with defaults (stock=30, minimumStock=5) keeps
       * backwards compatibility with pre-stock-tracking reminders.
       */
      const { stock: tStock = 30, minimumStock: tMin = 5 } = r;
      const tLevel  = getStockStatus({ stock: tStock, minimumStock: tMin });
      const stockCell = {
        out: `<span class="status-badge status-overdue">❌ Out (0)</span>`,
        low: `<span class="status-badge status-pending">⚠ Low (${tStock})</span>`,
        ok:  `<span class="status-badge status-done">📦 ${tStock}</span>`,
      }[tLevel];

      return `<tr>
        <td><span class="tbl-name">${escHtml(r.name)}</span></td>
        <td>${escHtml(r.dose)}</td>
        <td><span style="font-family:var(--mono);font-size:12px">${formatTime(r.time)}</span></td>
        <td>${meta.emoji} ${escHtml(meta.label)}</td>
        <td>${escHtml(r.freq)}</td>
        <td><span class="status-badge ${sc}">${st}</span></td>
        <td>${stockCell}</td>
        <td><div class="tbl-actions">
          <button class="btn-icon add-stock" data-action="add-stock" data-id="${escHtml(r.id)}" title="Add stock">➕</button>
          <button class="btn-icon edit"      data-action="edit"      data-id="${escHtml(r.id)}" title="Edit">✏️</button>
          <button class="btn-icon del"       data-action="delete"    data-id="${escHtml(r.id)}" title="Delete">🗑️</button>
        </div></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

/* ── Handlers ── */
function handleToggle(id) {
  const nowDone = toggleDone(id);
  const idx = findById(reminders, id);
  if (idx !== -1) {
    _toast(
      nowDone ? `"${reminders[idx].name}" marked taken` : `"${reminders[idx].name}" unmarked`,
      nowDone ? 'success' : 'info'
    );
  }
  if (nowDone) cancelReminderNotif(id);
  else scheduleAllReminders();
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

function goEdit(id) {
  sessionStorage.setItem('editId', id);
  location.href = 'MedMinder_Add.html';
}

function clearAll() {
  if (!reminders.length) { _toast('Nothing to delete', 'info'); return; }
  if (!confirm(`Delete all ${reminders.length} reminders? This cannot be undone.`)) return;
  reminders = [];
  saveReminders();
  _toast('All reminders deleted', 'error');
  render();
}

function clearSearch() {
  document.getElementById('search').value = '';
  searchQ = '';
  document.getElementById('search-clear').classList.remove('show');
  render();
}

/* ── Import ── */
/**
 * handleImport(e)
 * ───────────────
 * Entry point wired to <input type="file" onchange="handleImport(event)">
 * in MedMinder_History.html. Orchestrates the full import pipeline:
 *
 *   1. Guard checks  — no file selected, wrong MIME type, oversized file
 *   2. FileReader    — reads the file as text asynchronously
 *   3. Empty check   — catches zero-byte files before JSON.parse
 *   4. JSON.parse    — converts raw text → JS value (throws on syntax error)
 *   5. validateImportPayload() [shared.js] — structure + field validation
 *   6. mergeImported()         [shared.js] — dedup + localStorage write
 *   7. Toast + render          — user feedback + UI repaint
 *
 * FileReader API basics:
 *   FileReader is asynchronous — it does not block the UI thread.
 *   .readAsText(file) starts reading; when done the browser fires
 *   the `onload` event and populates `event.target.result` with the
 *   full file content as a string. We then parse that string.
 *   `onerror` fires if the OS denies access (e.g. locked file).
 *
 * Why not fetch() or fs.readFile()?
 *   fetch() requires a URL; we have a local File object from the
 *   <input>. fs.readFile() is Node.js only. FileReader is the
 *   browser-native API for reading user-selected files.
 *
 * @param {Event} e - the 'change' event from <input type="file">
 */
function handleImport(e) {
  /*
   * e.target.files is a FileList (array-like, not a real Array).
   * Index [0] gives the first (and only) selected file, or
   * undefined if the user cancelled the dialog.
   */
  const file = e.target.files[0];

  /* ── Guard 1: no file selected ── */
  if (!file) return;

  /* ── Guard 2: MIME / extension check ──
   * file.type is set by the OS based on file extension.
   * We accept 'application/json' and '' (type unknown — common on
   * some operating systems for .json files).
   * This is a UX hint, not a security boundary (content is still
   * validated fully before any data is written).
   */
  const acceptedTypes = new Set(['application/json', 'text/plain', '']);
  if (file.type && !acceptedTypes.has(file.type)) {
    _toast(`Import failed: expected a .json file, got "${file.type}"`, 'error');
    e.target.value = ''; // reset input so the same file can be retried
    return;
  }

  /* ── Guard 3: file size ──
   * 5 MB is a generous upper bound for any realistic medicine list.
   * Reading a huge file can freeze the UI; rejecting early is safer.
   * 1 MB = 1_048_576 bytes  (using numeric separator for readability).
   */
  const MAX_BYTES = 5 * 1_048_576; // 5 MB
  if (file.size > MAX_BYTES) {
    _toast('Import failed: file is too large (max 5 MB)', 'error');
    e.target.value = '';
    return;
  }

  /*
   * FileReader instantiation — one instance per import operation.
   * We create it locally (not at module level) so there is no
   * shared state between concurrent imports (even though the UI
   * only allows one at a time, this is a safer pattern).
   */
  const reader = new FileReader();

  /* ── FileReader: async success callback ── */
  reader.onload = function onFileLoaded(ev) {
    /*
     * ev.target.result contains the entire file content as a string.
     * We name the function `onFileLoaded` (not an arrow) so it
     * appears with a meaningful name in stack traces.
     */
    const raw = ev.target.result;

    /* ── Guard 4: empty file ──
     * JSON.parse('') throws SyntaxError, but the error message is
     * cryptic. We detect the empty case explicitly for a clear toast.
     * .trim() handles files that contain only whitespace / newlines.
     */
    if (!raw || !raw.trim()) {
      _toast('Import failed: the selected file is empty', 'error');
      return;
    }

    let parsed;
    try {
      /*
       * JSON.parse() — converts a JSON string into a JS value.
       * It throws SyntaxError for any malformed JSON:
       *   • trailing commas       { "a": 1, }
       *   • unquoted keys         { a: 1 }
       *   • single-quoted strings { "a": 'b' }
       *   • bare text             hello world
       * We catch all of these in the catch block below.
       */
      parsed = JSON.parse(raw);
    } catch (syntaxErr) {
      /*
       * Include the native SyntaxError message — it contains the
       * line/column of the problem, which helps technical users.
       */
      _toast(`Import failed: invalid JSON — ${syntaxErr.message}`, 'error');
      console.error('[MedMinder Import] JSON.parse error:', syntaxErr);
      return;
    }

    let validatedItems;
    try {
      /*
       * validateImportPayload() is defined in shared.js.
       * It throws a descriptive Error for any structural problem:
       *   • not an array / no .reminders key
       *   • missing required fields (name, time, cat, freq)
       *   • invalid enum values
       *   • wrong types for stock fields
       * The thrown message is shown directly in the toast — no
       * need for a separate error-code system.
       */
      validatedItems = validateImportPayload(parsed);
    } catch (validationErr) {
      _toast(`Import failed: ${validationErr.message}`, 'error');
      console.warn('[MedMinder Import] Validation error:', validationErr);
      return;
    }

    /*
     * mergeImported() [shared.js]:
     *   • deduplicates by id using Set + filter()
     *   • appends new items to the `reminders` module array
     *   • calls saveReminders() → JSON.stringify → localStorage.setItem()
     * Returns { added, skipped } counts for the success toast.
     *
     * Destructuring the return value — pulls both numbers out of
     * the returned object in one statement.
     */
    const { added, skipped } = mergeImported(validatedItems);

    /*
     * Toast messages — three distinct outcomes:
     *   added > 0, skipped > 0  →  partial import (some duplicates)
     *   added > 0, skipped = 0  →  clean import (all new)
     *   added = 0               →  nothing new (all duplicates)
     *
     * The ternary chain mirrors the priority of information:
     * the user cares most about how many were added.
     */
    if (added > 0 && skipped > 0) {
      _toast(
        `Imported ${added} reminder${added !== 1 ? 's' : ''} ✓ ` +
        `(${skipped} duplicate${skipped !== 1 ? 's' : ''} skipped)`,
        'success'
      );
    } else if (added > 0) {
      _toast(
        `Successfully imported ${added} reminder${added !== 1 ? 's' : ''} ✓`,
        'success'
      );
    } else {
      _toast(
        'No new reminders imported — all entries already exist',
        'info'
      );
    }

    /* Re-render the history page with the updated reminders array */
    render();
  };

  /* ── FileReader: error callback ──
   * Fires if the OS cannot read the file (permissions, locked, etc.).
   * reader.error is a DOMException with a .name property.
   */
  reader.onerror = function onFileError() {
    const reason = reader.error?.message || 'unknown OS error';
    _toast(`Import failed: could not read file — ${reason}`, 'error');
    console.error('[MedMinder Import] FileReader error:', reader.error);
  };

  /*
   * reader.readAsText(file) — starts the async read operation.
   * The browser reads the file on a background thread and fires
   * `onload` (or `onerror`) when done. JS execution continues
   * immediately after this line — the function returns before
   * onload runs. This is the event-driven async model.
   *
   * No encoding argument → defaults to UTF-8, which covers all
   * standard JSON files.
   */
  reader.readAsText(file);

  /*
   * Reset the file input value AFTER starting the read.
   * This allows the user to re-import the same file if they edit
   * it and try again — without resetting, the browser sees no
   * "change" event for the same filename a second time.
   */
  e.target.value = '';
}

/* ── Inventory: Add Stock (history page) ────────────────────────
 *
 * Mirrors dashboard.js handleAddStock() exactly.
 * Duplicated here because history.js is a separate page bundle —
 * shared.js is the only common script. Keeping it local avoids a
 * circular dependency and makes the page self-contained.
 *
 * DATA FLOW — same as dashboard:
 *   findById → validate → mutate reminders[idx].stock
 *   → saveReminders() → localStorage → render()
 *
 * ADVANCED JS CONCEPTS USED:
 *   • Destructuring with defaults  ({ stock = 30, minimumStock = 5 })
 *   • filter() + .length to count remaining low-stock items after add
 *   • Lookup object as switch alternative (higher-order pattern)
 *   • parseInt(raw, 10) with radix for safe numeric parsing
 */
function handleAddStock(id) {
  const idx = findById(reminders, id);
  if (idx === -1) return;

  const { name, stock = 30, minimumStock = 5 } = reminders[idx];

  const raw = prompt(
    `➕ Add stock for "${name}"\n\nCurrent stock: ${stock} dose${stock !== 1 ? 's' : ''}\nMinimum threshold: ${minimumStock}\n\nEnter doses to add:`,
    '10'
  );
  if (raw === null) return;

  const amount = parseInt(raw, 10);
  if (isNaN(amount) || amount <= 0) {
    _toast('⚠️ Please enter a positive whole number', 'error');
    return;
  }
  if (amount > 999) {
    _toast('⚠️ Maximum single addition is 999 doses', 'error');
    return;
  }

  reminders[idx].stock = stock + amount;
  saveReminders(); // JSON.stringify(reminders) → localStorage

  /*
   * filter() — higher-order function: count how many reminders are
   * still low/out after this restock. Informs the toast message.
   * Returns a new array (original untouched) — we only need .length.
   */
  const stillLow = reminders.filter(r => getStockStatus(r) !== 'ok').length;
  const newLevel = getStockStatus(reminders[idx]);

  const levelLabel = { ok: 'healthy ✅', low: 'low ⚠️', out: 'out ❌' }[newLevel] || '';
  _toast(
    `Added ${amount} dose${amount !== 1 ? 's' : ''} to "${name}" · now ${reminders[idx].stock} (${levelLabel})` +
    (stillLow > 0 ? ` · ${stillLow} medicine${stillLow !== 1 ? 's' : ''} still need attention` : ''),
    newLevel === 'ok' ? 'success' : newLevel === 'low' ? 'warn' : 'error'
  );

  render();
}

/*
 * ── EVENT DELEGATION for history card & table actions ───────────
 *
 * One listener on the stable #history-content parent handles
 * toggle, add-stock, edit, and delete for both card and table views.
 * renderCards() and renderTable() replace the children on every
 * render() call — delegating to the static parent means we never
 * need to re-bind after a re-render.
 *
 * data-action / data-id are set in the button templates above.
 * e.target.closest('[data-action]') walks up from the clicked node
 * (which may be an emoji text node inside the button) to find the
 * nearest ancestor with data-action — covers all button internals.
 *
 * WHY A SINGLE PARENT LISTENER?
 *   renderCards() and renderTable() both replace #history-content's
 *   innerHTML on every render(). Any listeners attached to the old
 *   child elements are discarded with them, causing action buttons
 *   to silently stop working after the first search/filter/sort.
 *
 * THE FIX — delegate to #history-content:
 *   #history-content is a static element (never replaced, only its
 *   children change). A single 'click' listener here catches all
 *   clicks on card buttons, table buttons, and check-boxes through
 *   event bubbling — regardless of how many times render() has run.
 */
document.getElementById('history-content').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;

  const { action, id } = el.dataset;
  if (!id) return;

  if (el.classList.contains('check-box') || action === 'toggle') {
    handleToggle(id);
  } else if (action === 'add-stock') {
    handleAddStock(id);
  } else if (action === 'edit') {
    goEdit(id);
  } else if (action === 'delete') {
    handleDelete(id);
  }
});

/* ── Events ── */

document.getElementById('hist-filters').addEventListener('click', e => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  hFilter = btn.dataset.filter;
  document.querySelectorAll('#hist-filters .chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  render();
});

document.querySelectorAll('.sort-chip').forEach(btn => btn.addEventListener('click', () => {
  hSort = btn.dataset.sort;
  document.querySelectorAll('.sort-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  render();
}));

document.getElementById('search').addEventListener('input', debounce(e => {
  searchQ = e.target.value;
  document.getElementById('search-clear').classList.toggle('show', !!searchQ);
  render();
}, 240));

/* ── Init ── */
(function init() {  
  if (!protectRoute()) return;
  initTheme();
  initToast();
  initUser();
  loadReminders();
  seedDemo();
  initNotifications();
  document.querySelectorAll('.nav-link').forEach(a =>
    a.classList.toggle('active', a.getAttribute('href').includes('History'))
  );
  document.getElementById('nav-date').textContent =
    new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  setTimeout(render, 350);
})();