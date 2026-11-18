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
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { adjustAnimationTime } from 'resource:///org/gnome/shell/misc/animationUtils.js';

export const AnimationDuration = 250;
export const AnimationEasing = Clutter.AnimationMode.LINEAR;
const LineWidth = 1.5; // in logical pixels
const LineSeparatorWidth = 1; // in logical pixels
export const FillCapRadius = 2; // in logical pixels
// Animations should last until the next sample arrives. Some sources (like
// the NPU) are polled asynchronously on their own timer, so their samples
// don't arrive exactly every refresh interval; this learns the real spacing
// so motion stays continuous instead of moving and then pausing.
export class SampleCadence {
  private lastMs = 0;
  private spacingMs = 0;

  // Call once per new sample; returns how long to animate toward it
  public next(nominalMs: number): number {
    const now = GLib.get_monotonic_time() / 1000;
    const delta = this.lastMs > 0 ? now - this.lastMs : nominalMs;
    this.lastMs = now;
    const clamped = Math.min(Math.max(delta, nominalMs / 2), nominalMs * 4);
    this.spacingMs =
      this.spacingMs > 0 ? (this.spacingMs + clamped) / 2 : clamped;
    return this.spacingMs;
  }
}

export enum Orientation {
  Horizontal,
  Vertical,
}

export function parseColor(c: string): Cogl.Color | null {
  let ok;
  let color;
  if (Cogl.color_from_string) {
    [ok, color] = Cogl.color_from_string(c);
  } else {
    // GNOME 46 and earlier
    // @ts-expect-error property does not exist
    [ok, color] = Clutter.color_from_string(c);
  }
  return ok ? color : null;
}

// St only clips children to a rectangle, so fills are drawn with Cairo and
// clipped to this path to follow a track's rounded corners.
export function traceRoundedRect(
  cr: Cairo.Context,
  x: number,
  y: number,
  width: number,
  height: number,
  topLeft: number,
  topRight: number,
  bottomRight: number,
  bottomLeft: number
) {
  cr.newSubPath();
  cr.arc(x + width - topRight, y + topRight, topRight, -Math.PI / 2, 0);
  cr.arc(
    x + width - bottomRight,
    y + height - bottomRight,
    bottomRight,
    0,
    Math.PI / 2
  );
  cr.arc(
    x + bottomLeft,
    y + height - bottomLeft,
    bottomLeft,
    Math.PI / 2,
    Math.PI
  );
  cr.arc(x + topLeft, y + topLeft, topLeft, Math.PI, (3 * Math.PI) / 2);
  cr.closePath();
}

// Paints (with the current source) a fill that grows upward from the bottom
// edge of a box `length` tall, as if the box clipped it with overflow:hidden.
// The fill is the box's own shape cut at its current level, with the two
// corners where that cut meets the box's outline rounded by up to
// `capRadius`, which is kept small so the fill still reads as the box being
// filled. That radius shrinks with the fill, so a short fill stays a thin
// sliver that follows the box's rounded bottom corners
// (`arcLeft`/`arcRight`, radius `cornerRadius`).
// The shape is built by eroding it by the cap radius, then filling and
// stroking it with a round join, which dilates it back with rounded corners.
export function paintAnchoredFill(
  cr: Cairo.Context,
  length: number,
  x: number,
  width: number,
  fill: number,
  cornerRadius: number,
  capRadius: number,
  arcLeft: boolean,
  arcRight: boolean
) {
  if (fill <= 0 || width <= 0) {
    return;
  }
  // A quarter of the fill keeps very short fills from collapsing into a dot
  const rho = Math.max(0, Math.min(capRadius, fill / 4, width / 2));
  const inner = cornerRadius - rho;
  const useLeft = arcLeft && inner > 0;
  const useRight = arcRight && inner > 0;
  const chordY = length - fill + rho;
  const belowY = length + rho; // below the box; clipped away by the caller
  const innerHeight = fill - 2 * rho;
  const centerY = length - cornerRadius;
  const centerLeft = x + cornerRadius;
  const centerRight = x + width - cornerRadius;

  // Where the chord crosses the corner arcs when the fill is shorter than them
  let angle = 0;
  let reach = 0;
  if (inner > 0 && innerHeight < inner) {
    const dy = inner - innerHeight;
    reach = Math.sqrt(Math.max(inner * inner - dy * dy, 0));
    angle = Math.atan2(dy, reach);
  }
  const startLeft = useLeft ? centerLeft - (angle ? reach : inner) : x + rho;
  const startRight = useRight
    ? centerRight + (angle ? reach : inner)
    : x + width - rho;

  cr.newPath();
  cr.moveTo(startLeft, chordY);
  cr.lineTo(startRight, chordY);
  if (useRight) {
    cr.arc(centerRight, centerY, inner, angle, Math.PI / 2);
    cr.lineTo(centerRight, belowY);
  } else {
    cr.lineTo(x + width - rho, belowY);
  }
  if (useLeft) {
    cr.lineTo(centerLeft, belowY);
    cr.arc(centerLeft, centerY, inner, Math.PI / 2, Math.PI - angle);
  } else {
    cr.lineTo(x + rho, belowY);
  }
  cr.closePath();
  cr.fillPreserve();
  if (rho > 0) {
    cr.setLineWidth(2 * rho);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.stroke();
  } else {
    cr.newPath();
  }
}

export const TopHatMeter = GObject.registerClass(
  class TopHatMeter extends St.BoxLayout {
    private area: St.DrawingArea;
    private meterOrientation;
    private scaleFactor = 1;
    private color: Cogl.Color;
    private barWidth: number; // in pixels
    private lineMode = false;
    private values: number[] = [];
    private timeline: Clutter.Timeline | null = null;
    private lineSeparators = false;
    private lineSoftFill = false;
    private updateInterval = AnimationDuration;
    private cadence = new SampleCadence();

    constructor() {
      super({
        style_class: 'tophat-meter',
        y_align: Clutter.ActorAlign.CENTER,
        y_expand: true,
        name: 'TopHatMeter',
      });
      this.meterOrientation = Orientation.Horizontal;
      this.color = new Cogl.Color();
      this.barWidth = 8;

      this.area = new St.DrawingArea({
        y_expand: true,
        name: 'TopHatMeterArea',
      });
      this.area.connect('repaint', (area: St.DrawingArea) => {
        this.repaint(area);
      });
      this.add_child(this.area);

      const themeContext = St.ThemeContext.get_for_stage(global.get_stage());
      this.scaleFactor = themeContext.get_scale_factor();
      themeContext.connect('notify::scale-factor', (obj: St.ThemeContext) => {
        this.scaleFactor = obj.get_scale_factor();
        this.barWidth = this.computeBarWidth(this.values.length);
        this.updateAreaWidth();
      });
      // The bars and line clip themselves to the track's border radius
      this.connect('style-changed', () => {
        this.area.queue_repaint();
      });
    }

    public isLineMode(): boolean {
      return this.lineMode;
    }

    public setLineSeparators(enabled: boolean) {
      this.lineSeparators = enabled;
      this.area.queue_repaint();
    }

    public setLineSoftFill(enabled: boolean) {
      this.lineSoftFill = enabled;
      this.area.queue_repaint();
    }

    // Fills glide from one reading to the next over this many milliseconds
    public setUpdateInterval(interval: number) {
      if (!Number.isFinite(interval) || interval <= 0) {
        console.warn(`[TopHat] invalid meter update interval: ${interval}`);
        return;
      }
      this.updateInterval = interval;
    }

    public setLineMode(enabled: boolean) {
      if (enabled === this.lineMode) {
        return;
      }
      this.lineMode = enabled;
      this.stopAnimation();
      this.area.queue_repaint();
    }

    // Match the width the bars (plus 1px gaps) occupy
    private updateAreaWidth() {
      const n = Math.max(this.values.length, 1);
      this.area.set_width(n * this.barWidth + (n - 1) * this.scaleFactor);
      this.area.queue_repaint();
    }

    private repaint(area: St.DrawingArea) {
      const cr = area.get_context();
      const [width, height] = area.get_surface_size();
      const values = this.values;
      if (values.length === 0 || width <= 0 || height <= 0) {
        cr.$dispose();
        return;
      }

      const radius = Math.min(
        this.get_theme_node().get_border_radius(St.Corner.TOPLEFT),
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

      if (this.lineMode) {
        this.drawLine(cr, width, height, values);
      } else {
        this.drawBars(cr, width, height, radius, values);
      }
      cr.$dispose();
    }

    private drawBars(
      cr: Cairo.Context,
      width: number,
      height: number,
      radius: number,
      values: number[]
    ) {
      const n = values.length;
      const gap = this.scaleFactor;
      const barWidth = (width - (n - 1) * gap) / n;
      const rounded = this.has_style_class_name('tophat-meter-rounded');
      cr.setSourceRGBA(
        this.color.red / 255,
        this.color.green / 255,
        this.color.blue / 255,
        1
      );
      // Corner arcs are only meaningful when a bar is at least as wide as them
      const arcs = radius <= barWidth;
      for (let i = 0; i < n; i++) {
        if (values[i] <= 0) {
          continue;
        }
        // Fractional heights are anti-aliased, so small changes glide rather
        // than snapping a pixel at a time; a non-zero value is always visible.
        const barHeight = Math.max(height * values[i], this.scaleFactor);
        paintAnchoredFill(
          cr,
          height,
          i * (barWidth + gap),
          barWidth,
          barHeight,
          radius,
          rounded ? Math.min(radius, FillCapRadius * this.scaleFactor) : 0,
          arcs && i === 0,
          arcs && i === n - 1
        );
      }
    }

    private drawLine(
      cr: Cairo.Context,
      width: number,
      height: number,
      values: number[]
    ) {
      const lineWidth = LineWidth * this.scaleFactor;
      // One point per core, spread edge to edge; a single value is a flat line
      const points = values.length === 1 ? [values[0], values[0]] : values;
      const step = width / (points.length - 1);
      const yOf = (v: number) =>
        height - lineWidth / 2 - v * (height - lineWidth);
      // Monotone cubic tangents round extrema without overshooting core values.
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
            (i - 1 + 1 / 3) * step,
            yOf(points[i - 1] + tangents[i - 1] / 3),
            (i - 1 / 3) * step,
            yOf(points[i] - tangents[i] / 3),
            i * step,
            yOf(points[i])
          );
        }
      };
      const r = this.color.red / 255;
      const g = this.color.green / 255;
      const b = this.color.blue / 255;

      cr.setSourceRGBA(r, g, b, this.lineSoftFill ? 0.35 : 1);
      cr.moveTo(0, height);
      cr.lineTo(0, yOf(points[0]));
      tracePoints();
      cr.lineTo(width, height);
      cr.closePath();
      cr.fill();

      // Stroke on top so idle cores still show a visible line
      cr.moveTo(0, yOf(points[0]));
      tracePoints();
      cr.setLineJoin(Cairo.LineJoin.ROUND);
      cr.setLineCap(Cairo.LineCap.ROUND);
      cr.setLineWidth(lineWidth);
      cr.setSourceRGBA(r, g, b, 1);
      cr.stroke();

      if (this.lineSeparators && points.length > 1) {
        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        const separatorWidth = LineSeparatorWidth * this.scaleFactor;
        for (let i = 1; i < points.length; i++) {
          const x = (i - 0.5) * step;
          cr.rectangle(x - separatorWidth / 2, 0, separatorWidth, height);
        }
        cr.fill();
        cr.restore();
      }
    }

    public getNumBars(): number {
      return this.values.length;
    }

    public setNumBars(n: number) {
      this.stopAnimation();
      this.values = new Array<number>(n).fill(0);
      this.barWidth = this.computeBarWidth(n);
      this.updateAreaWidth();
    }

    private computeBarWidth(n: number, wasVertical = false) {
      let width = 8;
      if (wasVertical) {
        // If we're in vertical panel mode, use narrower widths
        if (n > 12) {
          n = 1;
        } else if (n > 9) {
          n = 2;
        } else if (n > 6) {
          width = 4;
        } else if (n > 2) {
          width = 6;
        }
      } else {
        if (n > 8) {
          width = 4; // Reduce bar width by half when there are many bars
        } else if (n > 4) {
          width = 6; // Reduce bar width by 3/4 when there are a few bars
        }
      }
      return width * this.scaleFactor;
    }

    public setOrientation(o: Orientation) {
      this.meterOrientation = o;
    }

    public setRoundedBars(rounded: boolean) {
      this.set_clip_to_allocation(rounded);
      if (rounded) {
        this.add_style_class_name('tophat-meter-rounded');
      } else {
        this.remove_style_class_name('tophat-meter-rounded');
      }
      this.area.queue_repaint();
    }

    public setBarSizes(n: number[]) {
      if (n.some((v) => !Number.isFinite(v))) {
        console.warn('[TopHat] called setBarSizes() with non-finite values');
        return;
      }
      const target = n.map((v) => Math.min(Math.max(v, 0), 1));
      this.stopAnimation();
      const duration = adjustAnimationTime(
        this.cadence.next(this.updateInterval)
      );
      if (duration <= 0 || target.length !== this.values.length) {
        this.values = target;
        this.barWidth = this.computeBarWidth(target.length);
        this.updateAreaWidth();
        return;
      }
      const start = this.values.slice();
      const timeline = new Clutter.Timeline({
        actor: this,
        duration,
      });
      this.timeline = timeline;
      timeline.set_progress_mode(AnimationEasing);
      timeline.connect('new-frame', () => {
        const progress = timeline.get_progress();
        this.values = target.map(
          (value, i) => start[i] + (value - start[i]) * progress
        );
        this.area.queue_repaint();
      });
      timeline.connect('completed', () => {
        this.values = target;
        this.timeline = null;
        this.area.queue_repaint();
      });
      timeline.start();
    }

    public setColor(c: string) {
      const color = parseColor(c);
      if (!color) {
        console.warn(`Error parsing ${c} to Cogl.Color`);
        return;
      }
      this.color = color;
      this.area.queue_repaint();
    }

    public reorient() {
      // This is to play nice with the dash-to-panel extension
      const wasVertical = this.orientation === Clutter.Orientation.VERTICAL;
      this.set_orientation(Clutter.Orientation.HORIZONTAL);
      this.set_x_expand(false);
      this.set_x_align(Clutter.ActorAlign.CENTER);
      this.set_y_align(Clutter.ActorAlign.CENTER);
      this.barWidth = this.computeBarWidth(this.getNumBars(), wasVertical);
      this.updateAreaWidth();
    }

    private stopAnimation() {
      this.timeline?.stop();
      this.timeline = null;
    }

    public override destroy() {
      this.stopAnimation();
      super.destroy();
    }
  }
);

export type TopHatMeter = InstanceType<typeof TopHatMeter>;
