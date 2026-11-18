#!/usr/bin/env python3
# Copyright (C) 2025 Todd Kulesza <todd@dropline.net>

# This file is part of TopHat.

# TopHat is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

# TopHat is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.

# You should have received a copy of the GNU General Public License
# along with TopHat. If not, see <https://www.gnu.org/licenses/>.

"""Report AMD XDNA NPU utilization for TopHat.

GNOME Shell extensions are written in GJS, which cannot issue ioctls, so
TopHat runs this helper to query the amdxdna driver's sensor interface (the
same method used by Resources and Lemonade).

Usage: npu-sensors.py DEVICE_NODE POWER_STATE_FILE

For every line received on stdin, one line is written to stdout: the average
utilization of the AI Engine columns as a percentage (0-100), or -1 if it is
unavailable. The helper exits when stdin is
closed.
"""

import ctypes
import fcntl
import os
import sys

IOC_WRITE = 1
IOC_READ = 2
DRM_IOCTL_BASE = ord("d")
DRM_COMMAND_BASE = 0x40
DRM_IOCTL_VERSION_NR = 0x00
DRM_AMDXDNA_GET_INFO = 7
DRM_AMDXDNA_QUERY_SENSORS = 4
AMDXDNA_SENSOR_TYPE_COLUMN_UTILIZATION = 1
MAX_SENSORS = 16
MIN_DRM_VERSION = (0, 7)


def ioctl_number(number, size):
    return (
        ((IOC_READ | IOC_WRITE) << 30)
        | (DRM_IOCTL_BASE << 8)
        | number
        | (size << 16)
    )


class DrmVersion(ctypes.Structure):
    _fields_ = [
        ("version_major", ctypes.c_int),
        ("version_minor", ctypes.c_int),
        ("version_patchlevel", ctypes.c_int),
        ("name_len", ctypes.c_size_t),
        ("name", ctypes.c_void_p),
        ("date_len", ctypes.c_size_t),
        ("date", ctypes.c_void_p),
        ("desc_len", ctypes.c_size_t),
        ("desc", ctypes.c_void_p),
    ]


class GetInfo(ctypes.Structure):
    _fields_ = [
        ("param", ctypes.c_uint32),
        ("buffer_size", ctypes.c_uint32),
        ("buffer", ctypes.c_uint64),
    ]


class Sensor(ctypes.Structure):
    _fields_ = [
        ("label", ctypes.c_uint8 * 64),
        ("input", ctypes.c_uint32),
        ("max", ctypes.c_uint32),
        ("average", ctypes.c_uint32),
        ("highest", ctypes.c_uint32),
        ("status", ctypes.c_uint8 * 64),
        ("units", ctypes.c_uint8 * 16),
        ("unitm", ctypes.c_int8),
        ("type", ctypes.c_uint8),
        ("pad", ctypes.c_uint8 * 6),
    ]


def has_sensor_support(fd):
    version = DrmVersion()
    request = ioctl_number(DRM_IOCTL_VERSION_NR, ctypes.sizeof(version))
    fcntl.ioctl(fd, request, version)
    return (version.version_major, version.version_minor) >= MIN_DRM_VERSION


def query_utilization(fd):
    """Return the utilization of each column, in percent."""
    sensors = (Sensor * MAX_SENSORS)()
    info = GetInfo(
        DRM_AMDXDNA_QUERY_SENSORS,
        ctypes.sizeof(sensors),
        ctypes.addressof(sensors),
    )
    request = ioctl_number(
        DRM_COMMAND_BASE + DRM_AMDXDNA_GET_INFO, ctypes.sizeof(info)
    )
    fcntl.ioctl(fd, request, info)

    return [
        sensor.input * 10.0**sensor.unitm
        for sensor in sensors[: info.buffer_size // ctypes.sizeof(Sensor)]
        if sensor.type == AMDXDNA_SENSOR_TYPE_COLUMN_UTILIZATION
    ]


def read_utilization(device_node, power_state_file):
    # Opening the device node wakes a sleeping NPU, so only query it when it
    # is already active; a sleeping NPU is idle by definition.
    try:
        with open(power_state_file) as f:
            if f.read().strip() != "D0":
                return 0.0
    except OSError:
        pass

    try:
        fd = os.open(device_node, os.O_RDWR)
    except OSError:
        return None
    try:
        if not has_sensor_support(fd):
            return None
        columns = query_utilization(fd)
    except OSError:
        return None
    finally:
        os.close(fd)

    if not columns:
        return None
    return sum(columns) / len(columns)


def main():
    if len(sys.argv) != 3:
        print("usage: npu-sensors.py DEVICE_NODE POWER_STATE_FILE", file=sys.stderr)
        return 2
    device_node, power_state_file = sys.argv[1:]
    for _ in sys.stdin:
        utilization = read_utilization(device_node, power_state_file)
        print("-1" if utilization is None else f"{utilization:.1f}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
