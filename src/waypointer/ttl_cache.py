"""Small in-process TTL cache for the external-API clients.

routing.py (BRouter) talks to a shared public instance that is rate-limit
sensitive, and sees a visitor repeating an identical request within a short
window (an anchor dragged back to where it was, an undone edit). Generic
rather than routing-specific so any future external client can reuse it.
Single-process and deliberately not backed by Redis/a database, matching
rate_limit.py.
"""

import threading
import time
from typing import Generic, TypeVar

T = TypeVar("T")


class TTLCache(Generic[T]):
    def __init__(self, ttl_s: float) -> None:
        self._ttl_s = ttl_s
        self._lock = threading.Lock()
        self._store: dict[str, tuple[float, T]] = {}

    def get(self, key: str) -> T | None:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if expires_at < time.monotonic():
                del self._store[key]
                return None
            return value

    def set(self, key: str, value: T) -> None:
        with self._lock:
            self._store[key] = (time.monotonic() + self._ttl_s, value)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()
