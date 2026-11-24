/**
 * THE CHART LAYER, shared by every screen that draws one.
 *
 * Ported from src/App.html, where the colours, the axis styling, the
 * tooltip shape and the two custom plugins sat inline among the render
 * functions. They are here instead because KPI 1, KPI 2 and the Comparison
 * screen all draw against the same target line and the same band colours,
 * and three copies of a colour is three chances for one chart to disagree
 * with another about what GREEN means.
 *
 * Nothing in here knows what a KPI is. It takes a config and draws it.
 *
 * ON CHART.JS. Loaded from the CDN, pinned to an exact version, exactly as
 * App.html pins it. If `Chart` is not defined - the CDN is unreachable, or
 * a test has not stubbed it - drawChart does nothing rather than throwing,
 * which is the same thing the original does. A screen with no chart on it
 * is still a screen with its tables, its tiles and its figures.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.kpiCharts = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Every live chart, by canvas id, so one can be destroyed before its
     canvas is drawn on again. Chart.js refuses a second chart on the same
     canvas, and the refusal is a console error nobody sees. */
  const charts = {};

  const BAR = {
    borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
    borderSkipped: false,
    maxBarThickness: 38
  };

  const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#4a3aa7'];

  const AXIS_FONT = { size: 11,
                      family: '-apple-system, "Segoe UI", Roboto, sans-serif' };


  /** The band's colour. The same four everywhere, or the screens disagree. */
  function bandColour(band) {
    if (band === 'GREEN') return '#0ca30c';
    if (band === 'YELLOW') return '#fab219';
    if (band === 'RED') return '#d03b3b';
    return '#8496a8';
  }


  /** The band's CSS class, for a pill. */
  function bandClass(band) {
    if (band === 'GREEN') return 'g';
    if (band === 'YELLOW') return 'a';
    if (band === 'RED') return 'r';
    return '';
  }


  function gridStyle() {
    return {
      border: { display: false },
      grid: { color: '#eaeff5', drawTicks: false, lineWidth: 1 },
      ticks: { color: '#7b8b9d', font: AXIS_FONT, padding: 8 }
    };
  }


  function categoryAxis() {
    return {
      border: { display: false },
      grid: { display: false },
      ticks: { color: '#5a6b7d', font: AXIS_FONT, padding: 6 }
    };
  }


  function tooltipStyle(callbacks) {
    return {
      backgroundColor: '#14202e',
      titleFont: { size: 12, weight: '600' },
      bodyFont: { size: 12 },
      padding: 10,
      cornerRadius: 6,
      displayColors: false,
      callbacks: callbacks
    };
  }


  /**
   * The target line, and the badge that names it.
   *
   * The line is SOLID. Dashes read as noise at this size, and the one line
   * on the chart that is not data is the one that most needs to look
   * deliberate.
   */
  const targetLinePlugin = {
    id: 'targetLine',
    afterDatasetsDraw: function (chart, args, opts) {
      if (!opts || typeof opts.value !== 'number') return;

      // Cleared first, so it never describes a badge from an earlier render
      // that this one is not going to draw.
      chart.$targetBadge = null;

      // A combo chart has two y scales, so the caller names the one the
      // target belongs to. Everything else has a single 'y' and says nothing.
      const y = chart.scales[opts.scaleId || 'y'];
      if (!y || opts.value < y.min || opts.value > y.max) return;

      const ctx = chart.ctx;
      const at = y.getPixelForValue(opts.value);
      const left = chart.chartArea.left;
      const right = chart.chartArea.right;

      ctx.save();
      ctx.strokeStyle = opts.color || '#1e3a5f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(left, at);
      ctx.lineTo(right, at);
      ctx.stroke();

      if (opts.label) {
        /*
          Drawn in the gutter the caller reserves with layout.padding.right,
          so the badge can never sit on top of a bar - overlapping the data
          would be worse than having no label at all.

          The plot area is not always the last thing on the right, though.
          A chart with a right-hand axis puts its ticks there, and a badge
          pinned to chartArea.right landed squarely on them. So step over
          anything drawn to the right of the plot and start clear of it.
          Charts with no right-hand axis are unaffected: the loop finds
          nothing and the badge stays where it was.
        */
        let axisEdge = 0;
        Object.keys(chart.scales).forEach(function (id) {
          const scale = chart.scales[id];
          if (scale && scale.position === 'right' && scale.right > axisEdge) {
            axisEdge = scale.right;
          }
        });
        const edge = Math.max(right, axisEdge);

        ctx.font = '700 9.5px -apple-system, "Segoe UI", Roboto, sans-serif';
        const width = ctx.measureText(opts.label).width + 14;

        /*
          Never draw off the end of the canvas. The gutters are sized for
          these labels, but the label is built from a target the committee
          can change - two more digits and "Target 99.5%" is wider than the
          space reserved for it. Pulling the badge back so it ends at the
          edge costs a few pixels of gutter; being sliced in half costs the
          reader the number, which is the one thing the badge is for.
        */
        let x = edge + 8;
        const limit = chart.width - 4;
        if (x + width > limit) x = Math.max(4, limit - width);

        /*
          Where the badge actually ended up, for the test that checks it
          stayed on the canvas and off the right-hand axis. Recording it is
          the only way that check can be honest: a test that recalculates
          the placement is really testing its own copy of this arithmetic,
          and passes happily while the chart on screen is wrong.
        */
        chart.$targetBadge = { x: x, width: width, plotRight: right,
                               axisRight: axisEdge };

        ctx.fillStyle = opts.color || '#1e3a5f';
        ctx.beginPath();
        ctx.roundRect(x, at - 9, width, 18, 9);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(opts.label, x + width / 2, at);
      }
      ctx.restore();
    }
  };


  /** The number above each bar. */
  const valueLabelPlugin = {
    id: 'valueLabels',
    afterDatasetsDraw: function (chart, args, opts) {
      if (!opts || !opts.enabled) return;
      const ctx = chart.ctx;
      const decimals = opts.decimals || 0;
      const suffix = opts.suffix || '';

      ctx.save();
      // Text tokens, never the series colour: a label wearing the mark's
      // hue is unreadable the moment that hue is a light one.
      ctx.font = '700 10.5px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = '#14202e';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';

      chart.data.datasets.forEach(function (dataset, i) {
        const meta = chart.getDatasetMeta(i);
        if (meta.hidden) return;
        meta.data.forEach(function (bar, j) {
          const value = dataset.data[j];
          if (value === null || value === undefined) return;
          ctx.fillText(Number(value).toFixed(decimals) + suffix, bar.x, bar.y - 4);
        });
      });
      ctx.restore();
    }
  };


  /** Draws one, replacing whatever was on that canvas. */
  function drawChart(canvasId, config) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return null;

    if (charts[canvasId]) charts[canvasId].destroy();
    charts[canvasId] = new Chart(canvas.getContext('2d'), config);
    return charts[canvasId];
  }


  /**
   * Puts a sentence where a chart would go, or takes one away.
   *
   * A chart of four zeroes is four invisible bars under a fractional axis.
   * Saying "no ticket in any section was late" is both truer and better
   * news, and it is the case this exists for.
   *
   * @return {boolean} whether a message is now showing
   */
  function chartMessage(canvasId, html) {
    const box = document.getElementById(canvasId + 'Empty');
    const canvas = document.getElementById(canvasId);

    if (html) {
      if (charts[canvasId]) { charts[canvasId].destroy(); delete charts[canvasId]; }
      if (canvas) canvas.hidden = true;
      if (box) { box.innerHTML = html; box.hidden = false; }
      return true;
    }

    if (canvas) canvas.hidden = false;
    if (box) box.hidden = true;
    return false;
  }


  /** The live chart on a canvas, for the browser suite to read. */
  function chartOn(canvasId) { return charts[canvasId] || null; }


  return {
    BAR: BAR, SERIES: SERIES, AXIS_FONT: AXIS_FONT,
    bandColour: bandColour, bandClass: bandClass,
    gridStyle: gridStyle, categoryAxis: categoryAxis, tooltipStyle: tooltipStyle,
    targetLinePlugin: targetLinePlugin, valueLabelPlugin: valueLabelPlugin,
    drawChart: drawChart, chartMessage: chartMessage, chartOn: chartOn
  };
}));
