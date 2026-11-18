// Copyright (C) 2024 Todd Kulesza <todd@dropline.net>

// This file is part of TopHat.

// TopHat is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// TopHat is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with TopHat. If not, see <https://www.gnu.org/licenses/>.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { adjustAnimationTime } from 'resource:///org/gnome/shell/misc/animationUtils.js';

import { IActivity, IHistory, MaxHistoryLen } from './vitals.js';
import {
  AnimationDuration,
  AnimationEasing,
  paintAnchoredFill,
  SampleCadence,
  parseColor,
  traceRoundedRect,
} from './meter.js';

export enum HistoryStyle {
  SINGLE,
  DUAL,
}

const LineWidth = 1; // in logical pixels
const BarGap = 1; // in logical pixels
const BarMinHeight = 2; // in logical pixels

// One chart's worth of samples, oldest first, as fractions of the full height.
// `prevOldest` is the sample that just scrolled off the left edge, which is
// still partly visible while the chart slides.
interface Series {
  values: number[];
  prevOldest: number;
}

export const HistoryChart = GObject.registerClass(
  class HistoryChart extends St.Bin {
    private chartStyle;
    private grid;
    private lm;
    private chart: St.BoxLayout;
    private chartAlt: St.BoxLayout | null;
    private areaChart: St.DrawingArea;
    private areaChartAlt: St.DrawingArea | null;
    private areaMode = false;
    private areaSoftFill = true;
    private series: Series = { values: [], prevOldest: 0 };
    private seriesAlt: Series = { values: [], prevOldest: 0 };
    private areaColor: Cogl.Color | null = null;
    private updateInterval = AnimationDuration;
    private cadence = new SampleCadence();
    // How far the chart has slid toward its newest sample, from 0 to 1
    private scroll = 1;
    private scrollTimeline: Clutter.Timeline | null = null;
    private yLabelTop;
    private yLabelMiddle;
    private yLabelBottom;
    private xLabelNow;
    private xLabelThen;

    constructor(style = HistoryStyle.SINGLE) {
      super({ x_expand: true });
      this.chartStyle = style;
      this.grid = new St.Widget({
        x_expand: true,
        layout_manager: new Clutter.GridLayout({
          orientation: Clutter.Orientation.VERTICAL,
        }),
      });
      this.add_child(this.grid);
      this.lm = this.grid.layout_manager as Clutter.GridLayout;
      this.chart = new St.BoxLayout({
        style_class: 'tophat-chart',
        x_expand: true,
      });
      this.areaChart = new St.DrawingArea({
        name: 'HistoryAreaChart',
        x_expand: true,
        y_expand: true,
      });
      this.areaChart.connect('repaint', (area: St.DrawingArea) => {
        this.repaint(area, this.series, false);
      });
      if (this.chartStyle === HistoryStyle.DUAL) {
        this.chartAlt = new St.BoxLayout({
          style_class: 'tophat-chart tophat-chart-stacked-bottom',
          x_expand: true,
        });
        this.areaChartAlt = new St.DrawingArea({
          name: 'HistoryAreaChartAlt',
          x_expand: true,
          y_expand: true,
        });
        this.areaChartAlt.connect('repaint', (area: St.DrawingArea) => {
          this.repaint(area, this.seriesAlt, true);
        });
      } else {
        this.chartAlt = null;
        this.areaChartAlt = null;
      }

      this.yLabelTop = new St.Label();
      this.yLabelMiddle = new St.Label();
      this.yLabelBottom = new St.Label();
      this.xLabelNow = new St.Label();
      this.xLabelThen = new St.Label();

      this.build();
    }

    public setAreaMode(enabled: boolean) {
      if (enabled === this.areaMode) {
        return;
      }
      this.areaMode = enabled;
      this.queueRepaint();
    }

    public setAreaSoftFill(enabled: boolean) {
      this.areaSoftFill = enabled;
      this.queueRepaint();
    }

    // The chart slides by one sample over this many milliseconds
    public setUpdateInterval(interval: number) {
      if (Number.isFinite(interval) && interval > 0) {
        this.updateInterval = interval;
      }
    }

    public setYLabelTop(s: string) {
      this.yLabelTop.text = s;
    }

    public setYLabelMiddle(s: string) {
      this.yLabelMiddle.text = s;
    }

    public setYLabelBottom(s: string) {
      this.yLabelBottom.text = s;
    }

    public setThen(s: string) {
      this.xLabelThen.text = s;
    }

    public update(usage: IHistory[]) {
      const values = this.samples(
        usage.slice(-MaxHistoryLen).map((u) => u.val())
      );
      if (values) {
        this.push(values, null);
      }
    }

    public updateAlt(usage: IActivity[], max: number) {
      const recent = usage.slice(-MaxHistoryLen);
      const values = this.samples(
        recent.map((u) => (max ? u.valAlt() / max : 0))
      );
      const valuesAlt = this.samples(
        recent.map((u) => (max ? u.val() / max : 0))
      );
      if (values && valuesAlt) {
        this.push(values, valuesAlt);
      }
    }

    // History is stored newest first; the chart is drawn oldest first
    private samples(newestFirst: number[]): number[] | null {
      if (newestFirst.some((v) => !Number.isFinite(v))) {
        console.warn('[TopHat] history contains a non-finite value');
        return null;
      }
      return newestFirst.reverse().map((v) => Math.min(Math.max(v, 0), 1));
    }

    private push(values: number[], valuesAlt: number[] | null) {
      this.series = {
        values,
        prevOldest: this.series.values[0] ?? values[0],
      };
      if (valuesAlt) {
        this.seriesAlt = {
          values: valuesAlt,
          prevOldest: this.seriesAlt.values[0] ?? valuesAlt[0],
        };
      }
      this.startScroll();
    }

    // Slide the chart left by one sample, so it flows rather than steps
    private startScroll() {
      this.stopScroll();
      const duration = adjustAnimationTime(
        this.cadence.next(this.updateInterval)
      );
      if (duration <= 0 || !this.mapped) {
        this.scroll = 1;
        this.queueRepaint();
        return;
      }
      this.scroll = 0;
      const timeline = new Clutter.Timeline({ actor: this, duration });
      this.scrollTimeline = timeline;
      timeline.set_progress_mode(AnimationEasing);
      timeline.connect('new-frame', () => {
        this.scroll = timeline.get_progress();
        this.queueRepaint();
      });
      timeline.connect('completed', () => {
        this.scroll = 1;
        this.scrollTimeline = null;
        this.queueRepaint();
      });
      timeline.start();
      this.queueRepaint();
    }

    private stopScroll() {
      this.scrollTimeline?.stop();
      this.scrollTimeline = null;
    }

    private queueRepaint() {
      this.areaChart.queue_repaint();
      this.areaChartAlt?.queue_repaint();
    }

    public setColor(color: string) {
      this.areaColor = parseColor(color);
      if (!this.areaColor) {
        console.warn(`[TopHat] Error parsing ${color} to Cogl.Color`);
      }
      this.queueRepaint();
    }

    private repaint(area: St.DrawingArea, series: Series, inverted: boolean) {
      const cr = area.get_context();
      const [width, height] = area.get_surface_size();
      const color = this.areaColor;
      if (!color || series.values.length === 0 || width <= 0 || height <= 0) {
        cr.$dispose();
        return;
      }
      const scale = St.ThemeContext.get_for_stage(
        global.get_stage()
      ).get_scale_factor();

      // The plot fills its container edge to edge, following its rounded corners
      const container = area.get_parent() as St.Widget | null;
      const radius = Math.min(
        container?.get_theme_node().get_border_radius(St.Corner.TOPLEFT) ?? 0,
        width / 2,
        height / 2
      );
      if (radius > 0) {
        traceRoundedRect(
          cr,
          0,
          0,
          width,
          height,
          radius,
          radius,
          radius,
          radius
        );
        cr.clip();
      }
      if (inverted) {
        // Draw as usual, then flip so the plot hangs from the top
        cr.translate(0, height);
        cr.scale(1, -1);
      }
      cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, 1);
      if (this.areaMode) {
        this.drawArea(cr, width, height, series, scale);
      } else {
        this.drawBars(cr, width, height, series, scale);
      }
      cr.$dispose();
    }

    private drawBars(
      cr: Cairo.Context,
      width: number,
      height: number,
      series: Series,
      scale: number
    ) {
      const { values, prevOldest } = series;
      const gap = BarGap * scale;
      const pitch = (width + gap) / values.length;
      const barWidth = pitch - gap;
      const offset = (1 - this.scroll) * pitch;
      const all = [prevOldest, ...values];
      for (let i = 0; i < all.length; i++) {
        const x = (i - 1) * pitch + offset;
        if (x + barWidth < 0 || x > width) {
          continue;
        }
        const barHeight = Math.max(all[i] * height, BarMinHeight * scale);
        paintAnchoredFill(
          cr,
          height,
          x,
          barWidth,
          barHeight,
          0,
          barWidth / 2,
          false,
          false
        );
      }
    }

    private drawArea(
      cr: Cairo.Context,
      width: number,
      height: number,
      series: Series,
      scale: number
    ) {
      const { values, prevOldest } = series;
      const lineWidth = LineWidth * scale;
      const points =
        values.length === 1 ? [values[0], values[0]] : [prevOldest, ...values];
      const step = width / Math.max(values.length - 1, 1);
      const offset = values.length === 1 ? 0 : (1 - this.scroll) * step;
      const first = values.length === 1 ? 0 : -1;
      const xOf = (i: number) => (i + first) * step + offset;
      const yOf = (v: number) =>
        height - lineWidth / 2 - v * (height - lineWidth);
      // Monotone cubic tangents keep the curve from overshooting any sample
      const slopes = points.slice(1).map((v, i) => v - points[i]);
      const tangents = points.map((_, i) => {
        if (i === 0) {
          return slopes[0];
        }
        if (i === points.length - 1) {
          return slopes[i - 1];
        }
        const left = slopes[i - 1];
        const right = slopes[i];
        return left * right <= 0 ? 0 : (2 * left * right) / (left + right);
      });
      const tracePoints = () => {
        for (let i = 1; i < points.length; i++) {
          cr.curveTo(
            xOf(i - 1) + step / 3,
            yOf(points[i - 1] + tangents[i - 1] / 3),
            xOf(i) - step / 3,
            yOf(points[i] - tangents[i] / 3),
            xOf(i),
            yOf(points[i])
          );
        }
      };
      const color = this.areaColor;
      if (!color) {
        return;
      }
      const r = color.red / 255;
      const g = color.green / 255;
      const b = color.blue / 255;

      cr.moveTo(xOf(0), height);
      cr.lineTo(xOf(0), yOf(points[0]));
      tracePoints();
      cr.lineTo(xOf(points.length - 1), height);
      cr.closePath();
      cr.setSourceRGBA(r, g, b, this.areaSoftFill ? 0.35 : 1);
      cr.fill();

      cr.moveTo(xOf(0), yOf(points[0]));
      tracePoints();
      cr.setLineJoin(Cairo.LineJoin.ROUND);
      cr.setLineCap(Cairo.LineCap.ROUND);
      cr.setLineWidth(lineWidth);
      cr.setSourceRGBA(r, g, b, 1);
      cr.stroke();
    }

    private build() {
      let chartRowSpan = 2;
      if (this.chartAlt) {
        chartRowSpan = 1;
      }

      this.lm.attach(this.chart, 0, 0, 2, chartRowSpan);
      this.chart.add_child(this.areaChart);
      if (this.chartAlt) {
        this.lm.attach(this.chartAlt, 0, 1, 2, chartRowSpan);
        if (this.areaChartAlt) {
          this.chartAlt.add_child(this.areaChartAlt);
        }
        this.chart.add_style_class_name('tophat-chart-stacked-top');
      }

      const vbox = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        y_expand: true,
      });
      this.lm.attach(vbox, 2, 0, 1, 2);

      this.yLabelTop.text = '100%';
      this.yLabelTop.y_align = Clutter.ActorAlign.START;
      this.yLabelTop.y_expand = true;
      this.yLabelTop.add_style_class_name('tophat-chart-label');
      vbox.add_child(this.yLabelTop);

      this.yLabelMiddle.text = '50%';
      this.yLabelMiddle.y_align = Clutter.ActorAlign.CENTER;
      this.yLabelMiddle.y_expand = true;
      this.yLabelMiddle.add_style_class_name('tophat-chart-label');
      vbox.add_child(this.yLabelMiddle);

      this.yLabelBottom.text = '0%';
      this.yLabelBottom.y_align = Clutter.ActorAlign.END;
      this.yLabelBottom.y_expand = true;
      this.yLabelBottom.add_style_class_name('tophat-chart-label');
      vbox.add_child(this.yLabelBottom);

      this.xLabelThen.add_style_class_name('tophat-chart-label-then');
      this.lm.attach(this.xLabelThen, 0, 2, 1, 1);

      this.xLabelNow.text = _('now');
      this.xLabelNow.add_style_class_name('tophat-chart-label-now');
      this.lm.attach(this.xLabelNow, 1, 2, 1, 1);

      const label = new St.Label({ text: '' });
      this.lm.attach(label, 2, 2, 1, 1);
    }

    public override destroy() {
      this.stopScroll();
      this.grid.destroy();
      super.destroy();
    }
  }
);

export type HistoryChart = InstanceType<typeof HistoryChart>;
