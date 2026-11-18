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

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import St from 'gi://St';

import {
  ExtensionMetadata,
  gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';
import { adjustAnimationTime } from 'resource:///org/gnome/shell/misc/animationUtils.js';

import { Vitals } from './vitals.js';
import { TopHatMonitor, MeterNoVal } from './monitor.js';
import { bytesToHumanString, roundMax } from './helpers.js';
import { HistoryChart, HistoryStyle } from './history.js';
import {
  AnimationEasing,
  FillCapRadius,
  paintAnchoredFill,
  parseColor,
  traceRoundedRect,
} from './meter.js';

const NetworkActivityThreshold = 1024; // bytes per second

export const NetMonitor = GObject.registerClass(
  class NetMonitor extends TopHatMonitor {
    private valueNetUp: St.Label;
    private valueNetDown: St.Label;
    private menuNetUp: St.Label;
    private menuNetDown: St.Label;
    private menuNetUpTotal: St.Label;
    private menuNetDownTotal: St.Label;
    private usageUnit;
    private networkBars: St.Widget;
    private uploadBarTrack: St.BoxLayout;
    private uploadBarArea: St.DrawingArea;
    private downloadBarTrack: St.BoxLayout;
    private downloadBarArea: St.DrawingArea;
    private fillColor: Cogl.Color | null = null;
    private maxSpeedBytesPerSecond = 125_000_000;
    private latestUpload = 0;
    private latestDownload = 0;
    // Fractions of each track that are filled: where they are heading, and
    // where they currently are while gliding there
    private targetBars = [0, 0];
    private shownBars = [0, 0];
    private barTimeline: Clutter.Timeline | null = null;

    constructor(metadata: ExtensionMetadata, gsettings: Gio.Settings) {
      super('Net Monitor', metadata, gsettings);

      if (gsettings.get_user_value('net-show-values') === null) {
        gsettings.set_boolean(
          'net-show-values',
          !gsettings.get_boolean('net-show-bars')
        );
      }

      this.setPanelIcon('arrows-bidirectional');
      this.icon.add_style_class_name('tophat-panel-icon-net');

      const vbox = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER,
        y_expand: true,
      });
      this.add_child(vbox);

      const networkBarsSlot = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        y_expand: true,
        visible: gsettings.get_boolean('net-show-bars'),
      });
      this.networkBars = networkBarsSlot;
      const networkBars = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'tophat-network-bars',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      networkBarsSlot.add_child(networkBars);
      this.maxSpeedBytesPerSecond =
        (gsettings.get_double('net-max-speed') * 1_000_000) / 8;
      // The track (a BoxLayout) paints the empty background; its child
      // drawing area paints the fill, clipped to the track's rounded outline.
      const buildTrack = (getFraction: () => number) => {
        const track = new St.BoxLayout({
          style_class: 'tophat-meter tophat-network-bar-track',
          x_expand: true,
        });
        const area = new St.DrawingArea({ x_expand: true, y_expand: true });
        area.connect('repaint', (a: St.DrawingArea) => {
          this.repaintNetworkBar(a, track, getFraction());
        });
        track.add_child(area);
        networkBars.add_child(track);
        return { track, area };
      };
      const upload = buildTrack(() => this.shownBars[0]);
      this.uploadBarTrack = upload.track;
      this.uploadBarArea = upload.area;
      const download = buildTrack(() => this.shownBars[1]);
      this.downloadBarTrack = download.track;
      this.downloadBarArea = download.area;
      vbox.add_child(networkBarsSlot);

      const valueNetUp = new St.Label({
        text: MeterNoVal,
        style_class: 'tophat-panel-usage-stacked',
        y_expand: true,
        y_align: Clutter.ActorAlign.END,
      });
      vbox.add_child(valueNetUp);
      this.valueNetUp = valueNetUp;
      const valueNetDown = new St.Label({
        text: MeterNoVal,
        style_class: 'tophat-panel-usage-stacked',
        y_expand: true,
        y_align: Clutter.ActorAlign.START,
      });
      vbox.add_child(valueNetDown);
      this.valueNetDown = valueNetDown;
      const showValues = gsettings.get_boolean('net-show-values');
      valueNetUp.visible = showValues;
      valueNetDown.visible = showValues;

      this.menuNetUp = new St.Label();
      this.menuNetDown = new St.Label();
      this.menuNetUpTotal = new St.Label();
      this.menuNetDownTotal = new St.Label();
      this.historyChart = new HistoryChart(HistoryStyle.DUAL);
      this.usageUnit = this.gsettings.get_string('network-usage-unit');
      let id = this.gsettings.connect(
        'changed::network-usage-unit',
        (settings) => {
          this.usageUnit = settings.get_string('network-usage-unit');
          let s = bytesToHumanString(0, this.usageUnit) + '/s';
          this.valueNetUp.text = s;
          this.menuNetUp.text = s;
          s = bytesToHumanString(0, this.usageUnit) + '/s';
          this.valueNetDown.text = s;
          this.menuNetDown.text = s;
        }
      );
      this.settingsSignals.push(id);
      id = this.gsettings.connect('changed::net-max-speed', (settings) => {
        this.maxSpeedBytesPerSecond =
          (settings.get_double('net-max-speed') * 1_000_000) / 8;
        this.updateNetworkBars();
      });
      this.settingsSignals.push(id);
      id = this.gsettings.connect('changed::net-show-bars', () => {
        this.updateNetworkDisplay();
      });
      this.settingsSignals.push(id);
      id = this.gsettings.connect('changed::net-show-values', () => {
        this.updateNetworkDisplay();
      });
      this.settingsSignals.push(id);
      id = this.gsettings.connect('changed::round-meter-bars', () => {
        this.updateNetworkBarRounding();
      });
      this.settingsSignals.push(id);
      this.visible = gsettings.get_boolean('show-net');
      id = this.gsettings.connect(
        'changed::show-net',
        (settings: Gio.Settings) => {
          this.visible = settings.get_boolean('show-net');
        }
      );
      this.settingsSignals.push(id);
      this.buildMenu();
      this.addMenuButtons();
      this.updateNetworkBarRounding();
      this.updateColor();
    }

    private updateNetworkDisplay() {
      const showBars = this.gsettings.get_boolean('net-show-bars');
      const showValues = this.gsettings.get_boolean('net-show-values');
      this.networkBars.visible = showBars;
      this.valueNetUp.visible = showValues;
      this.valueNetDown.visible = showValues;
      if (showBars) {
        this.updateNetworkBars();
      }
    }

    private updateNetworkBarRounding() {
      const rounded = this.gsettings.get_boolean('round-meter-bars');
      for (const track of [this.uploadBarTrack, this.downloadBarTrack]) {
        if (rounded) {
          track.add_style_class_name('tophat-meter-rounded');
        } else {
          track.remove_style_class_name('tophat-meter-rounded');
        }
        this.repaintNetworkBars();
      }
    }

    private updateNetworkBars(
      upload = this.latestUpload,
      download = this.latestDownload
    ) {
      this.latestUpload = Math.max(upload, 0);
      this.latestDownload = Math.max(download, 0);
      this.animateNetworkBars();
    }

    private fillFraction(speed: number) {
      return this.isActive(speed)
        ? Math.min(speed / this.maxSpeedBytesPerSecond, 1)
        : 0;
    }

    // Glide the fills from their current width to the new reading, over the
    // refresh interval, so they stay in smooth motion like the CPU line chart.
    private animateNetworkBars() {
      const target = [
        this.fillFraction(this.latestUpload),
        this.fillFraction(this.latestDownload),
      ];
      if (
        target[0] === this.targetBars[0] &&
        target[1] === this.targetBars[1]
      ) {
        return;
      }
      this.targetBars = target;
      this.barTimeline?.stop();
      this.barTimeline = null;

      const duration = adjustAnimationTime(this.updateIntervalMs);
      if (duration <= 0 || !this.networkBars.mapped) {
        this.shownBars = target;
        this.repaintNetworkBars();
        return;
      }
      const start = this.shownBars.slice();
      const timeline = new Clutter.Timeline({
        actor: this.networkBars,
        duration,
      });
      this.barTimeline = timeline;
      timeline.set_progress_mode(AnimationEasing);
      timeline.connect('new-frame', () => {
        const progress = timeline.get_progress();
        this.shownBars = target.map(
          (value, i) => start[i] + (value - start[i]) * progress
        );
        this.repaintNetworkBars();
      });
      timeline.connect('completed', () => {
        this.shownBars = target;
        this.barTimeline = null;
        this.repaintNetworkBars();
      });
      timeline.start();
    }

    private repaintNetworkBars() {
      this.uploadBarArea?.queue_repaint();
      this.downloadBarArea?.queue_repaint();
    }

    // Traffic at or below the threshold counts as idle for both the bars and
    // the arrows, so they always agree on whether a direction is active.
    private isActive(speed: number) {
      return speed > NetworkActivityThreshold;
    }

    // The fill grows from the left and is clipped to the track's rounded
    // outline, like overflow: hidden on a rounded box.
    private repaintNetworkBar(
      area: St.DrawingArea,
      track: St.BoxLayout,
      fraction: number
    ) {
      const cr = area.get_context();
      const [width, height] = area.get_surface_size();
      const color = this.fillColor;
      const scale = St.ThemeContext.get_for_stage(
        global.get_stage()
      ).get_scale_factor();
      const fillWidth = fraction > 0 ? Math.max(width * fraction, scale) : 0;
      if (!color || fillWidth <= 0 || width <= 0 || height <= 0) {
        cr.$dispose();
        return;
      }

      const radius = Math.min(
        track.get_theme_node().get_border_radius(St.Corner.TOPLEFT),
        width / 2,
        height / 2
      );
      traceRoundedRect(cr, 0, 0, width, height, radius, radius, radius, radius);
      cr.clip();

      const rounded = track.has_style_class_name('tophat-meter-rounded');
      cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, 1);
      // The fill grows from the left, so draw it as a bottom-anchored fill
      // turned a quarter turn
      cr.translate(width, 0);
      cr.rotate(Math.PI / 2);
      paintAnchoredFill(
        cr,
        width,
        0,
        height,
        fillWidth,
        radius,
        rounded ? Math.min(radius, FillCapRadius * scale) : 0,
        true,
        true
      );
      cr.$dispose();
    }

    private buildMenu() {
      let label = new St.Label({
        text: _('Network activity'),
        style_class: 'tophat-menu-header',
      });
      this.addMenuRow(label, 0, 2, 1);

      label = new St.Label({
        text: _('Sending:'),
        style_class: 'tophat-menu-label',
      });
      this.addMenuRow(label, 0, 1, 1);
      this.menuNetUp.text = MeterNoVal;
      this.menuNetUp.add_style_class_name('tophat-menu-value');
      this.addMenuRow(this.menuNetUp, 1, 1, 1);

      label = new St.Label({
        text: _('Receiving:'),
        style_class: 'tophat-menu-label',
      });
      this.addMenuRow(label, 0, 1, 1);
      this.menuNetDown.text = MeterNoVal;
      this.menuNetDown.add_style_class_name(
        'tophat-menu-value tophat-menu-section-end'
      );
      this.addMenuRow(this.menuNetDown, 1, 1, 1);

      label = new St.Label({
        text: _('Total sent:'),
        style_class: 'tophat-menu-label',
      });
      this.addMenuRow(label, 0, 1, 1);
      this.menuNetUpTotal.text = MeterNoVal;
      this.menuNetUpTotal.add_style_class_name('tophat-menu-value');
      this.addMenuRow(this.menuNetUpTotal, 1, 1, 1);

      label = new St.Label({
        text: _('Total received:'),
        style_class: 'tophat-menu-label',
      });
      this.addMenuRow(label, 0, 1, 1);
      this.menuNetDownTotal.text = MeterNoVal;
      this.menuNetDownTotal.add_style_class_name(
        'tophat-menu-value tophat-menu-section-end'
      );
      this.addMenuRow(this.menuNetDownTotal, 1, 1, 1);

      if (this.historyChart) {
        this.addMenuRow(this.historyChart, 0, 2, 1);
      }
    }

    public override bindVitals(vitals: Vitals): void {
      super.bindVitals(vitals);

      const updateActivity = () => {
        const upload = vitals.net_sent;
        const download = vitals.net_recv;
        if (upload < 0 || download < 0) {
          return;
        }
        const uploadText = bytesToHumanString(upload, this.usageUnit) + '/s';
        const downloadText =
          bytesToHumanString(download, this.usageUnit) + '/s';
        this.valueNetUp.text = uploadText;
        this.menuNetUp.text = uploadText;
        this.valueNetDown.text = downloadText;
        this.menuNetDown.text = downloadText;
        this.updateNetworkBars(upload, download);
      };
      let id = vitals.connect('notify::net-sent', updateActivity);
      this.vitalsSignals.push(id);
      id = vitals.connect('notify::net-recv', updateActivity);
      this.vitalsSignals.push(id);
      updateActivity();

      id = vitals.connect('notify::net-sent-total', () => {
        // console.log(`net-sent-total: ${vitals.net_sent_total}`);
        const s = bytesToHumanString(vitals.net_sent_total);
        this.menuNetUpTotal.text = s;
      });
      this.vitalsSignals.push(id);

      id = vitals.connect('notify::net-recv-total', () => {
        // console.log(`net-recv-total: ${vitals.net_recv_total}`);
        const s = bytesToHumanString(vitals.net_recv_total);
        this.menuNetDownTotal.text = s;
      });
      this.vitalsSignals.push(id);

      id = vitals.connect('notify::net-history', () => {
        if (!this.historyChart) {
          console.warn('[TopHat] Network history chart does not exist');
          return;
        }
        const history = vitals.getNetActivity();
        let max = 0;
        for (const na of history) {
          if (!na) {
            break;
          } else if (na.bytesRecv < 0) {
            console.warn(`na.bytesRecv < 0: ${na.bytesRecv}`);
          } else if (na.bytesSent < 0) {
            console.warn(`na.bytesSent < 0: ${na.bytesRecv}`);
          }
          if (na.bytesRecv > max) {
            max = na.bytesRecv;
          }
          if (na.bytesSent > max) {
            max = na.bytesSent;
          }
        }
        max = roundMax(max);
        const maxLabel = bytesToHumanString(max, this.usageUnit) + '/s';
        this.historyChart.setYLabelBottom(maxLabel);
        this.historyChart.setYLabelMiddle('0');
        this.historyChart.setYLabelTop(maxLabel);
        this.historyChart.updateAlt(history, max);
      });
      this.vitalsSignals.push(id);
    }

    public override destroy() {
      this.barTimeline?.stop();
      this.barTimeline = null;
      super.destroy();
    }

    protected override updateColor(): [string, boolean] {
      const [color, useAccent] = super.updateColor();
      this.fillColor = parseColor(color);
      this.repaintNetworkBars();
      return [color, useAccent];
    }
  }
);

export type NetMonitor = InstanceType<typeof NetMonitor>;
