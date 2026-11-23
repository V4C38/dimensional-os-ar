"""Elapsed time for Go2 freshness deadlines, including system suspend."""

from collections.abc import Callable
import ctypes
import sys
import time


def _clock() -> Callable[[], float]:
    if sys.platform == "darwin":
        kernel = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        continuous = kernel.mach_continuous_time
        continuous.restype = ctypes.c_uint64

        class Timebase(ctypes.Structure):
            _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]

        timebase = Timebase()
        kernel.mach_timebase_info(ctypes.byref(timebase))
        scale = timebase.numer / timebase.denom / 1e9
        return lambda: float(continuous()) * scale

    if hasattr(time, "CLOCK_BOOTTIME"):
        clock_id = time.CLOCK_BOOTTIME
        return lambda: time.clock_gettime(clock_id)
    return time.monotonic


live_time = _clock()
