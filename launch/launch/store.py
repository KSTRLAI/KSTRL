"""API keys, plans and daily usage in SQLite (~/.launch/launch.db). Keys are stored as SHA-256 hashes."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home() / ".launch"
LIMITS = {"free": 2500.0, "max": 50000.0}
MODEL_WEIGHT = {"colossus-2": 0.5, "colossus-2.1": 1, "colossus-2.2": 1.6, "colossus-2.2-uc": 2.5, "colossus-3": 4}
MODE_WEIGHT = {"build": 1, "plan": 0.5, "ask": 0.35, "complete": 0.15, "commit": 0.35}


def credits(prompt_tokens: int, completion_tokens: int, model: str | None, mode: str | None) -> float:
    return (prompt_tokens + 3 * completion_tokens) / 1000 * MODEL_WEIGHT.get(model or "", 1) * MODE_WEIGHT.get(mode or "", 1)


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def next_reset_ms() -> int:
    now = datetime.now(timezone.utc)
    tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return int(tomorrow.timestamp() * 1000)


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


class Store:
    def __init__(self, path: Path | None = None):
        path = path or HOME / "launch.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS keys (
                    hash TEXT PRIMARY KEY, prefix TEXT, install_id TEXT, plan TEXT DEFAULT 'free',
                    name TEXT DEFAULT '', email TEXT DEFAULT '', created_at REAL, created_ip TEXT,
                    revoked INTEGER DEFAULT 0, banned INTEGER DEFAULT 0, secret TEXT);
                CREATE INDEX IF NOT EXISTS keys_install ON keys(install_id);
                CREATE TABLE IF NOT EXISTS usage (hash TEXT, day TEXT, credits REAL DEFAULT 0, PRIMARY KEY (hash, day));
            """)
            self.db.commit()

    # ---- keys ----
    def create(self, plan="free", name="", email="", install_id=None, ip=None) -> str:
        key = "sk-launch-" + secrets.token_urlsafe(32)
        with self.lock:
            # The full key is kept only for automatic (install) keys, so the same install can get it back.
            self.db.execute("INSERT INTO keys (hash, prefix, install_id, plan, name, email, created_at, created_ip, secret) VALUES (?,?,?,?,?,?,?,?,?)",
                            (hash_key(key), key[:16], install_id, plan, name, email, time.time(), ip, key if install_id else None))
            self.db.commit()
        return key

    def lookup(self, key: str):
        if not key:
            return None
        h = hash_key(key)
        row = self.db.execute("SELECT * FROM keys WHERE hash=?", (h,)).fetchone()
        if row and hmac.compare_digest(row["hash"], h) and not row["revoked"] and not row["banned"]:
            return row
        return None

    def by_install(self, install_id: str):
        return self.db.execute("SELECT * FROM keys WHERE install_id=? ORDER BY created_at DESC LIMIT 1", (install_id,)).fetchone()

    def created_since(self, seconds: float, ip: str | None = None) -> int:
        since = time.time() - seconds
        if ip:
            return self.db.execute("SELECT COUNT(*) FROM keys WHERE created_at>? AND created_ip=?", (since, ip)).fetchone()[0]
        return self.db.execute("SELECT COUNT(*) FROM keys WHERE created_at>? AND install_id IS NOT NULL", (since,)).fetchone()[0]

    def find(self, ref: str):
        """A key by its prefix (sk-launch-xxxxxx), full key, or install id."""
        return self.db.execute("SELECT * FROM keys WHERE prefix=? OR hash=? OR install_id=? ORDER BY created_at DESC LIMIT 1",
                               (ref[:16], hash_key(ref), ref)).fetchone()

    def set(self, key_hash: str, **fields):
        cols = ", ".join(f"{k}=?" for k in fields)
        with self.lock:
            self.db.execute(f"UPDATE keys SET {cols} WHERE hash=?", (*fields.values(), key_hash))
            self.db.commit()

    def all(self):
        day = today()
        return self.db.execute("SELECT k.*, COALESCE(u.credits,0) AS used FROM keys k LEFT JOIN usage u ON u.hash=k.hash AND u.day=? ORDER BY k.created_at", (day,)).fetchall()

    # ---- usage ----
    def used(self, key_hash: str) -> float:
        r = self.db.execute("SELECT credits FROM usage WHERE hash=? AND day=?", (key_hash, today())).fetchone()
        return float(r[0]) if r else 0.0

    def add_usage(self, key_hash: str, amount: float):
        with self.lock:
            self.db.execute("INSERT INTO usage (hash, day, credits) VALUES (?,?,?) ON CONFLICT(hash, day) DO UPDATE SET credits=credits+excluded.credits",
                            (key_hash, today(), amount))
            self.db.commit()

    def limit(self, row) -> float:
        return LIMITS.get(row["plan"], LIMITS["free"])
