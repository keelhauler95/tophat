// Copyright (C) 2022 Todd Kulesza <todd@dropline.net>

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

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import NM from 'gi://NM';

import {
  ExtensionPreferences,
  gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
// @ts-expect-error "Module exists"
import * as Config from 'resource:///org/gnome/Shell/Extensions/js/misc/config.js';

import { normalizeMonitorOrder, readFileSystems } from './helpers.js';

const GnomeMajorVer = parseInt(Config.PACKAGE_VERSION.split('.')[0]);

export default class TopHatPrefs extends ExtensionPreferences {
  fillPreferencesWindow(window: Adw.PreferencesWindow) {
    return new Promise<void>((resolve) => {
      this.loadIconTheme();

      window.add(this.buildGeneralPage());
      window.add(this.buildCpuPage());
      window.add(this.buildGpuPage());
      window.add(this.buildNpuPage());
      window.add(this.buildMemPage());
      window.add(this.buildDiskPage());
      window.add(this.buildNetPage());
      window.set_default_size(750, 475);
      resolve();
    });
  }

  private loadIconTheme() {
    const display = Gdk.Display.get_default();
    if (!display) {
      console.error('[TopHat] Could not connect to default Gdk.Display');
      return;
    }
    const iconTheme = Gtk.IconTheme.get_for_display(display);
    const path = `${this.metadata.dir.get_path()}/icons`;
    if (!iconTheme.get_search_path()?.includes(path)) {
      iconTheme.add_search_path(path);
    }
  }

  private buildGeneralPage() {
    const page = new Adw.PreferencesPage({
      title: _('General'),
      iconName: 'preferences-system-symbolic',
    });

    const group = new Adw.PreferencesGroup({ title: _('General') });
    page.add(group);

    // Position in panel
    let choices = new Gtk.StringList();
    choices.append(_('Left edge'));
    choices.append(_('Left'));
    choices.append(_('Center'));
    choices.append(_('Right'));
    choices.append(_('Right edge'));
    this.addComboRow(
      _('Position in panel'),
      choices,
      'position-in-panel',
      group
    );

    // Refresh speed
    choices = new Gtk.StringList();
    choices.append(_('Slow'));
    choices.append(_('Medium'));
    choices.append(_('Fast'));
    choices.append(_('Faster'));
    choices.append(_('Fastest'));
    this.addComboRow(_('Refresh speed'), choices, 'refresh-rate', group);

    choices = new Gtk.StringList();
    choices.append(_('System Monitor'));
    choices.append(_('Resources'));
    this.addComboRow(
      _('Application opened by monitor buttons'),
      choices,
      'monitor-app',
      group
    );

    // Meter color
    let control: Gtk.Switch | null;
    control = null;

    if (GnomeMajorVer >= 47) {
      const accentRow = this.addActionRow(
        _('Use system accent color'),
        'use-system-accent',
        group
      );
      control = accentRow.get_activatable_widget() as Gtk.Switch;
    }
    this.addColorRow(_('Meter color'), 'meter-fg-color', group, control);
    this.addActionRow(_('Round meter bars'), 'round-meter-bars', group);

    // Show icons
    this.addActionRow(_('Show icons beside monitors'), 'show-icons', group);

    // Show action buttons in menus
    this.addActionRow(
      _('Show action buttons in menus'),
      'show-menu-actions',
      group
    );

    // Group top processes by name
    this.addActionRow(
      _('Group top processes by command'),
      'group-procs',
      group
    );

    page.add(this.buildMonitorOrderGroup());

    return page;
  }

  private buildMonitorOrderGroup() {
    const settings = this.getSettings();
    const group = new Adw.PreferencesGroup({
      title: _('Monitor order'),
      description: _('Order of the monitors in the panel'),
    });
    const names: Record<string, string> = {
      cpu: _('CPU'),
      mem: _('Memory'),
      disk: _('Disk'),
      net: _('Network'),
      gpu: _('GPU'),
      npu: _('NPU'),
    };
    let rows = new Array<Adw.ActionRow>();

    const render = () => {
      for (const row of rows) {
        group.remove(row);
      }
      rows = [];
      const order = normalizeMonitorOrder(settings.get_strv('monitor-order'));
      order.forEach((key, i) => {
        const row = new Adw.ActionRow({ title: names[key] });
        const addMoveButton = (
          iconName: string,
          tooltip: string,
          target: number
        ) => {
          const button = new Gtk.Button({
            iconName,
            tooltipText: tooltip,
            valign: Gtk.Align.CENTER,
            cssClasses: ['flat'],
            sensitive: target >= 0 && target < order.length,
          });
          button.connect('clicked', () => {
            const next = [...order];
            [next[i], next[target]] = [next[target], next[i]];
            settings.set_strv('monitor-order', next);
          });
          row.add_suffix(button);
        };
        addMoveButton('go-up-symbolic', _('Move up'), i - 1);
        addMoveButton('go-down-symbolic', _('Move down'), i + 1);
        group.add(row);
        rows.push(row);
      });
    };

    settings.connect('changed::monitor-order', render);
    render();
    return group;
  }

  private buildCpuPage() {
    const page = new Adw.PreferencesPage({
      title: _('CPU'),
      iconName: 'cpu-icon-symbolic',
    });

    const group = new Adw.PreferencesGroup({ title: _('CPU') });
    page.add(group);

    // Enable
    this.addActionRow(_('Show the CPU monitor'), 'show-cpu', group);

    // Visualization
    const choices = new Gtk.StringList();
    choices.append(_('Usage meter'));
    choices.append(_('Numeric value'));
    choices.append(_('Both meter and value'));
    this.addComboRow(_('Show as'), choices, 'cpu-display', group);

    // Show each core
    this.addActionRow(_('Show each core'), 'cpu-show-cores', group);

    // Sort cores by usage
    this.addActionRow(_('Sort cores by usage'), 'cpu-sort-cores', group);

    // Normalize process CPU usage
    this.addActionRow(
      _('Normalize per-process CPU usage by CPU cores'),
      'cpu-normalize-proc-use',
      group
    );

    return page;
  }

  private buildGpuPage() {
    const page = new Adw.PreferencesPage({
      title: _('GPU'),
      iconName: 'tophat-pci-symbolic',
    });
    const group = new Adw.PreferencesGroup({ title: _('GPU') });
    page.add(group);

    this.addActionRow(_('Show GPU monitors'), 'show-gpu', group);
    this.addConditionalActionRow(
      _('Show usage value in panel'),
      'gpu-show-value',
      ['show-gpu'],
      group
    );
    return page;
  }

  private buildNpuPage() {
    const page = new Adw.PreferencesPage({
      title: _('NPU'),
      iconName: 'tophat-brain-augmented-symbolic',
    });
    const group = new Adw.PreferencesGroup({ title: _('NPU') });
    page.add(group);

    this.addActionRow(_('Show NPU monitors'), 'show-npu', group);

    this.addConditionalActionRow(
      _('Show usage value in panel'),
      'npu-show-value',
      ['show-npu'],
      group
    );
    return page;
  }

  private buildMemPage() {
    const page = new Adw.PreferencesPage({
      title: _('Memory'),
      iconName: 'mem-icon-symbolic',
    });

    const group = new Adw.PreferencesGroup({ title: _('Memory') });
    page.add(group);

    // Enable
    this.addActionRow(_('Show the memory monitor'), 'show-mem', group);

    // Visualization
    const choices = new Gtk.StringList();
    choices.append(_('Usage meter'));
    choices.append(_('Numeric value'));
    choices.append(_('Both meter and value'));
    this.addComboRow(_('Show as'), choices, 'mem-display', group);

    // Absolute units
    this.addActionRow(_('Show usage in GB'), 'mem-abs-units', group);

    return page;
  }

  private buildDiskPage() {
    const page = new Adw.PreferencesPage({
      title: _('Disk'),
      iconName: 'disk-icon-symbolic',
    });

    let group = new Adw.PreferencesGroup({ title: _('Disk activity') });
    page.add(group);

    // Enable
    this.addActionRow(_('Show the disk activity monitor'), 'show-disk', group);

    group = new Adw.PreferencesGroup({ title: _('Filesystem usage') });
    page.add(group);

    // Enable
    this.addActionRow(_('Show the filesystem monitor'), 'show-fs', group);

    // Visualization
    const choices = new Gtk.StringList();
    choices.append(_('Usage meter'));
    choices.append(_('Numeric value'));
    choices.append(_('Both meter and value'));
    this.addComboRow(_('Show as'), choices, 'fs-display', group);

    // Filesystem mount to monitor in the topbar
    const fsMountChoices = new Gtk.StringList();
    const monitorMountRow = this.addComboRow(
      _('Filesystem to monitor in topbar'),
      fsMountChoices,
      'mount-to-monitor',
      group,
      false
    );

    // Filesystem mounts to monitor in the menu
    const row = new Adw.ExpanderRow({
      title: _('Filesystems to show in menu'),
    });
    group.add(row);
    // Find available filesystems and add them to our widgets
    readFileSystems()
      .then((filesystems) => {
        const settings = this.getSettings();
        const toHide = settings
          .get_string('fs-hide-in-menu')
          .split(';')
          .filter((s) => {
            return s.length > 0;
          });
        const mountToMonitor = settings.get_string('mount-to-monitor');
        fsMountChoices.append(_('Automatic'));
        let i = 1;
        for (const fs of filesystems) {
          fsMountChoices.append(fs.mount);
          if (mountToMonitor === fs.mount) {
            monitorMountRow.set_selected(i);
          }
          const fsRow = new Adw.ActionRow({ title: fs.mount });
          const toggle = new Gtk.Switch({
            active: !toHide.includes(fs.mount),
            valign: Gtk.Align.CENTER,
          });
          //@ts-expect-error does not exist
          toggle.fs = fs.mount;
          toggle.connect('notify::active', (w) => {
            const toHide = settings
              .get_string('fs-hide-in-menu')
              .split(';')
              .filter((s) => {
                return s.length > 0;
              });
            if (w.get_active() && toHide.includes(w.fs)) {
              const i = toHide.indexOf(w.fs);
              if (i > -1) {
                toHide.splice(i, 1);
              }
            } else if (!w.get_active() && !toHide.includes(w.fs)) {
              toHide.push(w.fs);
            }
            settings.set_string(
              'fs-hide-in-menu',
              toHide
                .filter((s) => {
                  return s.length > 0;
                })
                .join(';')
            );
          });
          fsRow.add_suffix(toggle);
          row.add_row(fsRow);
          i++;
        }
      })
      .catch((err) => {
        console.error(
          `[TopHat] Error building filesystem preference page: ${err}`
        );
      });

    return page;
  }

  private buildNetPage() {
    const page = new Adw.PreferencesPage({
      title: _('Network'),
      iconName: 'tophat-arrows-bidirectional-symbolic',
    });

    const group = new Adw.PreferencesGroup({ title: _('Network') });
    page.add(group);

    // Enable network monitor
    this.addActionRow(_('Show the network monitor'), 'show-net', group);

    this.addConditionalActionRow(
      _('Show upload and download as stacked bars'),
      'net-show-bars',
      ['show-net'],
      group
    );
    this.addConditionalActionRow(
      _('Show upload/download speeds in panel'),
      'net-show-values',
      ['show-net'],
      group
    );

    const settings = this.getSettings();
    const maxSpeedRow = new Adw.SpinRow({
      title: _('Maximum speed (Mbps)'),
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 1_000_000,
        step_increment: 1,
        page_increment: 100,
        page_size: 0,
        value: settings.get_double('net-max-speed'),
      }),
      digits: 0,
      numeric: true,
      snap_to_ticks: true,
    });
    settings.bind(
      'net-max-speed',
      maxSpeedRow,
      'value',
      Gio.SettingsBindFlags.DEFAULT
    );
    group.add(maxSpeedRow);
    this.setRowVisibleWhenAll(maxSpeedRow, ['show-net', 'net-show-bars']);

    // Select network device
    const netDevChoices = new Gtk.StringList();
    netDevChoices.append(_('Automatic'));
    NM.Client.new_async(null, (obj, result) => {
      if (!obj) {
        console.error('[TopHat] obj is null');
        return;
      }
      const client = NM.Client.new_finish(result);
      if (!client) {
        console.error('[TopHat] client is null');
        return;
      }
      const devices = client.get_devices();
      for (const d of devices) {
        const iface = d.get_iface();
        const dt = d.get_device_type();
        if (dt !== NM.DeviceType.LOOPBACK) {
          netDevChoices.append(iface);
        }
      }
      const deviceRow = this.addComboRow(
        _('Network device'),
        netDevChoices,
        'network-device',
        group,
        false
      );
      this.setRowVisibleWhenAll(deviceRow, ['show-net']);
    });

    // Bits or bytes?
    const choices = new Gtk.StringList();
    choices.append(_('Bytes'));
    choices.append(_('Bits'));
    const unitRow = this.addComboRow(
      _('Measurement unit'),
      choices,
      'network-usage-unit',
      group
    );
    this.setRowVisibleWhenAll(unitRow, ['show-net']);

    return page;
  }

  private addActionRow(
    label: string,
    setting: string,
    group: Adw.PreferencesGroup
  ) {
    const settings = this.getSettings();
    const row = new Adw.ActionRow({ title: label });
    group.add(row);

    const toggle = new Gtk.Switch({
      active: settings.get_boolean(setting),
      valign: Gtk.Align.CENTER,
    });
    settings.bind(setting, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(toggle);
    row.activatable_widget = toggle;
    return row;
  }

  private addConditionalActionRow(
    label: string,
    setting: string,
    parentSettings: string | string[],
    group: Adw.PreferencesGroup
  ) {
    const row = this.addActionRow(label, setting, group);
    this.setRowVisibleWhenAll(
      row,
      Array.isArray(parentSettings) ? parentSettings : [parentSettings]
    );
    return row;
  }

  private setRowVisibleWhenAll(row: Gtk.Widget, settingsNames: string[]) {
    this.setRowVisibleWhen(row, settingsNames, () => {
      const settings = this.getSettings();
      return settingsNames.every((name) => settings.get_boolean(name));
    });
  }

  private setRowVisibleWhen(
    row: Gtk.Widget,
    settingsNames: string[],
    predicate: () => boolean
  ) {
    const settings = this.getSettings();
    const updateVisibility = () => {
      row.visible = predicate();
    };
    updateVisibility();
    for (const name of settingsNames) {
      settings.connect(`changed::${name}`, updateVisibility);
    }
  }

  private addColorRow(
    label: string,
    setting: string,
    group: Adw.PreferencesGroup,
    control: Gtk.Switch | null
  ) {
    const settings = this.getSettings();
    const row = new Adw.ActionRow({ title: label });
    group.add(row);

    const button = new Gtk.ColorButton();
    const color = settings.get_string(setting);
    if (color) {
      const rgba = new Gdk.RGBA();
      rgba.parse(color);
      button.set_rgba(rgba);
    }
    button.connect('color-set', (w) => {
      settings.set_string('meter-fg-color', w.get_rgba().to_string());
    });

    if (control) {
      row.set_sensitive(!control.active);
      control.connect('notify::active', (w: Gtk.Switch) => {
        row.set_sensitive(!w.active);
      });
    }

    row.add_suffix(button);
    row.activatable_widget = button;
  }

  private addComboRow(
    label: string,
    choices: Gtk.StringList,
    setting: string,
    group: Adw.PreferencesGroup,
    settingIsEnum = true
  ) {
    const settings = this.getSettings();
    let selected = 0;
    if (settingIsEnum) {
      selected = settings.get_enum(setting);
    } else {
      const selectedVal = settings.get_string(setting);
      for (let i = 0; choices && i < choices.get_n_items(); i++) {
        if (selectedVal === choices.get_string(i)) {
          selected = i;
        }
      }
    }

    const row = new Adw.ComboRow({
      title: label,
      model: choices,
      selected: selected,
    });

    row.connect('notify::selected', (widget: Adw.ComboRow) => {
      if (settingIsEnum) {
        settings.set_enum(setting, widget.selected);
      } else {
        const item = widget.selectedItem as Gtk.StringObject;
        settings.set_string(setting, item.string);
      }
    });

    group.add(row);
    return row;
  }
}
