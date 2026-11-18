// Copyright (C) 2024 Todd Kulesza <todd@dropline.net>

// This file is part of TopHat.

// TopHat is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {
  ExtensionMetadata,
  gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import { bytesToHumanString } from './helpers.js';
import { File } from './file.js';
import { HistoryChart, HistoryStyle } from './history.js';
import { Orientation } from './meter.js';
import { TopHatMonitor, MeterNoVal } from './monitor.js';
import { IHistory, MaxHistoryLen, Vitals } from './vitals.js';

export type AcceleratorKind = 'gpu';
type UsageKind = 'percent';

export interface AcceleratorDevice {
  kind: AcceleratorKind;
  id: string;
  name: string;
  driver: string;
  pciSlot: string;
  usagePath?: string;
  usageKind: UsageKind;
  memoryUsedPath?: string;
  memoryTotalPath?: string;
  temperaturePath?: string;
}

class UsageSample implements IHistory {
  constructor(private usage: number) {}

  public val(): number {
    return this.usage;
  }

  public copy(): IHistory {
    return new UsageSample(this.usage);
  }
}

export function discoverAccelerators(): AcceleratorDevice[] {
  return discoverDevices('gpu', '/sys/class/drm', /^card\d+$/);
}

function discoverDevices(
  kind: AcceleratorKind,
  root: string,
  entryPattern: RegExp
): AcceleratorDevice[] {
  if (!new File(root).exists()) {
    return [];
  }

  let entries: string[];
  try {
    entries = new File(root).listSync();
  } catch (err) {
    console.warn(
      `[TopHat] Unable to enumerate ${kind} devices in ${root}: ${err}`
    );
    return [];
  }

  const devices = new Array<AcceleratorDevice>();
  for (const id of entries.filter((entry) => entryPattern.test(entry))) {
    const deviceRoot = `${root}/${id}/device`;
    const uevent = new File(`${deviceRoot}/uevent`).readSync();
    if (!uevent) {
      continue;
    }

    const fields = new Map<string, string>();
    for (const line of uevent.split('\n')) {
      const [key, ...value] = line.split('=');
      if (key && value.length > 0) {
        fields.set(key, value.join('='));
      }
    }
    const driver = fields.get('DRIVER') ?? '';
    if (
      driver === 'simple-framebuffer' ||
      driver === 'evdi' ||
      driver === 'rockchip-drm'
    ) {
      continue;
    }

    const usagePath = findFirstExisting([`${deviceRoot}/gpu_busy_percent`]);
    const usageKind: UsageKind = 'percent';
    const memoryUsedPath = findFirstExisting(
      [`${deviceRoot}/mem_info_vram_used`]
    );
    const memoryTotalPath = findFirstExisting(
      [`${deviceRoot}/mem_info_vram_total`]
    );

    const productName = findFirstValue([
      `${deviceRoot}/product_name`,
      `${deviceRoot}/model`,
    ]);
    const deviceNumber = id.match(/\d+$/)?.[0] ?? id;
    devices.push({
      kind,
      id,
      name: productName || `${kind.toUpperCase()} ${deviceNumber}`,
      driver,
      pciSlot: fields.get('PCI_SLOT_NAME') ?? '',
      usagePath,
      usageKind,
      memoryUsedPath,
      memoryTotalPath,
      temperaturePath: findTemperaturePath(deviceRoot),
    });
  }
  return devices;
}

function findFirstExisting(paths: string[]): string | undefined {
  return paths.find((path) => new File(path).exists());
}

function findFirstValue(paths: string[]): string {
  for (const path of paths) {
    const value = new File(path).readSync(false);
    if (value) {
      return value;
    }
  }
  return '';
}

function findTemperaturePath(deviceRoot: string): string | undefined {
  const hwmonRoot = `${deviceRoot}/hwmon`;
  if (!new File(hwmonRoot).exists()) {
    return undefined;
  }

  let hwmonEntries: string[];
  try {
    hwmonEntries = new File(hwmonRoot).listSync();
  } catch (err) {
    console.warn(`[TopHat] Unable to enumerate accelerator sensors: ${err}`);
    return undefined;
  }
  for (const hwmon of hwmonEntries) {
    for (let sensor = 1; sensor <= 8; sensor++) {
      const path = `${hwmonRoot}/${hwmon}/temp${sensor}_input`;
      if (new File(path).exists()) {
        return path;
      }
    }
  }
  return undefined;
}

export const AcceleratorMonitor = GObject.registerClass(
  class AcceleratorMonitor extends TopHatMonitor {
    private device: AcceleratorDevice;
    private usage: St.Label;
    private menuUsage: St.Label;
    private menuMemory: St.Label;
    private menuTemperature: St.Label;
    private history: UsageSample[];
    private pollSource = 0;
    private polling = false;
    private fileErrors = new Set<string>();
    private monitorEnabled: boolean;
    private summaryInterval = 2.5;

    constructor(
      metadata: ExtensionMetadata,
      gsettings: Gio.Settings,
      device: AcceleratorDevice
    ) {
      super(
        `${device.kind.toUpperCase()}: ${device.name}`,
        metadata,
        gsettings
      );
      this.device = device;
      this.setPanelIcon('pci');

      this.usage = new St.Label({
        text: MeterNoVal,
        style_class: 'tophat-panel-usage',
        y_align: Clutter.ActorAlign.CENTER,
      });
      this.add_child(this.usage);
      this.meter.setNumBars(1);
      this.meter.setOrientation(Orientation.Vertical);
      this.add_child(this.meter);

      this.historyChart = new HistoryChart(HistoryStyle.SINGLE);
      this.history = Array.from(
        { length: MaxHistoryLen },
        () => new UsageSample(0)
      );
      this.historyChart.setYLabelTop('100%');
      this.historyChart.setYLabelMiddle('50%');
      this.historyChart.setYLabelBottom('0%');
      this.historyChart.update(this.history);

      this.menuUsage = new St.Label({ text: MeterNoVal });
      this.menuMemory = new St.Label({ text: MeterNoVal });
      this.menuTemperature = new St.Label({ text: MeterNoVal });
      this.buildMenu();
      this.addMenuButtons();
      this.updateColor();

      const valueSetting = `${device.kind}-show-value`;
      this.usage.visible = gsettings.get_boolean(valueSetting);
      const valueId = gsettings.connect(
        `changed::${valueSetting}`,
        (settings) => {
          this.usage.visible = settings.get_boolean(valueSetting);
        }
      );
      this.settingsSignals.push(valueId);
      const visibleSetting = `show-${device.kind}`;
      this.monitorEnabled = gsettings.get_boolean(visibleSetting);
      this.visible = this.monitorEnabled;
      const id = gsettings.connect(`changed::${visibleSetting}`, (settings) => {
        this.monitorEnabled = settings.get_boolean(visibleSetting);
        this.visible = this.monitorEnabled;
        if (this.vitals) {
          this.schedulePoll(this.summaryInterval);
          if (this.monitorEnabled) {
            void this.poll();
          }
        }
      });
      this.settingsSignals.push(id);
    }

    private buildMenu() {
      const title = new St.Label({
        text: _('GPU activity'),
        style_class: 'tophat-menu-header',
      });
      this.addMenuRow(title, 0, 2, 1);
      this.addMenuDetailRow(_('Utilization:'), this.menuUsage);
      // Skip metrics this device does not expose, rather than show n/a forever
      if (this.device.memoryUsedPath && this.device.memoryTotalPath) {
        this.addMenuDetailRow(_('Memory:'), this.menuMemory);
      }
      if (this.device.temperaturePath) {
        this.addMenuDetailRow(_('Temperature:'), this.menuTemperature);
      }
      if (this.historyChart) {
        this.addMenuRow(this.historyChart, 0, 2, 1);
      }
    }

    private addMenuDetailRow(labelText: string, value: St.Label) {
      const label = new St.Label({
        text: labelText,
        style_class: 'tophat-menu-label',
      });
      value.add_style_class_name('tophat-menu-value');
      this.addMenuRow(label, 0, 1, 1);
      this.addMenuRow(value, 1, 1, 1);
    }

    public override bindVitals(vitals: Vitals): void {
      super.bindVitals(vitals);
      const updateInterval = () => {
        this.summaryInterval = vitals.summary_interval;
        this.schedulePoll(this.summaryInterval);
      };
      updateInterval();
      const id = vitals.connect('notify::summary-interval', updateInterval);
      this.vitalsSignals.push(id);
      void this.poll();
    }

    private schedulePoll(intervalSeconds: number) {
      if (this.pollSource > 0) {
        GLib.source_remove(this.pollSource);
        this.pollSource = 0;
      }
      if (!this.monitorEnabled) {
        return;
      }
      const interval = Math.round(
        Math.max(intervalSeconds * 1000, 250)
      );
      this.pollSource = GLib.timeout_add(GLib.PRIORITY_LOW, interval, () => {
        void this.poll();
        return GLib.SOURCE_CONTINUE;
      });
    }

    private async poll() {
      if (this.polling) {
        return;
      }
      this.polling = true;
      try {
        const [usage, memoryUsed, memoryTotal, temperature] = await Promise.all(
          [
            this.readUsage(),
            this.readNumber(this.device.memoryUsedPath),
            this.readNumber(this.device.memoryTotalPath),
            this.readNumber(this.device.temperaturePath),
          ]
        );
        if (usage !== null) {
          this.usage.text = `${(usage * 100).toFixed(0)}%`;
          this.menuUsage.text = this.usage.text;
          this.meter.setBarSizes([usage]);
          this.history.unshift(new UsageSample(usage));
          this.history.length = MaxHistoryLen;
          this.historyChart?.update(this.history);
        } else {
          this.usage.text = MeterNoVal;
          this.menuUsage.text = MeterNoVal;
          this.meter.setBarSizes([0]);
        }

        if (memoryUsed !== null && memoryTotal !== null) {
          this.menuMemory.text = `${bytesToHumanString(memoryUsed)} / ${bytesToHumanString(memoryTotal)}`;
        } else {
          this.menuMemory.text = MeterNoVal;
        }
        this.menuTemperature.text =
          temperature === null
            ? MeterNoVal
            : `${(temperature / 1000).toFixed(0)} °C`;
      } catch (err) {
        console.error(
          `[TopHat] Unable to update ${this.device.kind} ${this.device.id}: ${err}`
        );
      } finally {
        this.polling = false;
      }
    }

    private async readUsage(): Promise<number | null> {
      const value = await this.readNumber(this.device.usagePath);
      return value === null ? null : Math.min(Math.max(value / 100, 0), 1);
    }

    private async readNumber(path?: string): Promise<number | null> {
      if (!path) {
        return null;
      }
      try {
        const value = Number(await new File(path).read());
        return Number.isFinite(value) ? value : null;
      } catch (err) {
        if (!this.fileErrors.has(path)) {
          console.warn(
            `[TopHat] Unable to read accelerator metric ${path}: ${err}`
          );
          this.fileErrors.add(path);
        }
        return null;
      }
    }

    public override destroy() {
      if (this.pollSource > 0) {
        GLib.source_remove(this.pollSource);
        this.pollSource = 0;
      }
      super.destroy();
    }
  }
);

export type AcceleratorMonitor = InstanceType<typeof AcceleratorMonitor>;
