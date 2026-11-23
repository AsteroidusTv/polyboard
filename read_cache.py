"""Bounded process-local caching for shared reads."""

from collections import OrderedDict
from concurrent.futures import Future
from threading import Lock
from time import monotonic


class ReadCache:
    def __init__(self, capacity):
        self.capacity = capacity
        self.entries = OrderedDict()
        self.pending = {}
        self.lock = Lock()

    def read(self, key, load, *, ttl, refresh=False, cache_if=None):
        with self.lock:
            pending = self.pending.get(key)
            if pending is None:
                entry = self.entries.get(key)
                if not refresh and entry is not None and entry[0] > monotonic():
                    self.entries.move_to_end(key)
                    return entry[1], "HIT"
                self.entries.pop(key, None)
                future = self.pending[key] = Future()
        if pending is not None:
            return pending.result(), "SHARED"
        try:
            value = load()
            if cache_if is None or cache_if(value):
                with self.lock:
                    self.entries[key] = monotonic() + ttl, value
                    while len(self.entries) > self.capacity:
                        self.entries.popitem(last=False)
            future.set_result(value)
            return value, "REFRESH" if refresh else "MISS"
        except BaseException as error:
            future.set_exception(error)
            raise
        finally:
            with self.lock:
                del self.pending[key]
