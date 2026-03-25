import json
import os
import queue
import re
import threading
import time
import base64
import gzip
import traceback
from datetime import datetime
from pathlib import Path
from urllib import error, parse, request

import tkinter as tk
from tkinter import messagebox, ttk
from tkinter.scrolledtext import ScrolledText

from dashboard_market_sync import (
    CONSOLE_EXPR_MAX_CHARS,
    build_memdelete_expression,
    build_mempatch_expression,
    build_memwrite_expression,
    collect_changed_leaf_writes,
    is_expression_too_long,
)


CONFIG_PATH = Path(__file__).with_name("dashboard_config.json")
ROOM_NAME_RE = re.compile(r"^[WE]\d+[NS]\d+$")
KNOWN_PHASES = {"BOOTSTRAP", "EARLY", "BASIC_INFRA", "STORAGE", "LINKS", "TERMINAL", "LABS"}
KNOWN_STATES = {"CRITICAL", "RECOVER", "GROW", "STOCKPILE", "DEFENSIVE", "SIEGE"}
# Broad Screeps resource catalog (resolved constant values), including minerals,
# reaction chain compounds/boosts, and common commodities/deposit resources.
GAME_RESOURCE_CATALOG = [
    "energy", "power", "ops",
    "H", "O", "U", "L", "K", "Z", "X", "G",
    "OH", "UL", "ZK",
    "UH", "UO", "KH", "KO", "LH", "LO", "ZH", "ZO", "GH", "GO",
    "UH2O", "UHO2", "KH2O", "KHO2", "LH2O", "LHO2", "ZH2O", "ZHO2", "GH2O", "GHO2",
    "XUH2O", "XUHO2", "XKH2O", "XKHO2", "XLH2O", "XLHO2", "XZH2O", "XZHO2", "XGH2O", "XGHO2",
    "silicon", "metal", "biomass", "mist",
    "utrium_bar", "lemergium_bar", "zynthium_bar", "keanium_bar", "ghodium_melt",
    "oxidant", "reductant", "purifier", "battery",
    "composite", "crystal", "liquid",
    "wire", "switch", "transistor", "microchip", "circuit", "device",
    "cell", "phlegm", "tissue", "muscle", "organoid", "organism",
    "alloy", "tube", "fixtures", "frame", "hydraulics", "machine",
    "condensate", "concentrate", "extract", "spirit", "emanation", "essence",
]

BASIC_RESOURCES = {
    "energy", "power", "ops",
    "H", "O", "U", "L", "K", "Z", "X", "G",
}

COMBINED_RESOURCES = {
    "OH", "UL", "ZK",
    "UH", "UO", "KH", "KO", "LH", "LO", "ZH", "ZO", "GH", "GO",
    "UH2O", "UHO2", "KH2O", "KHO2", "LH2O", "LHO2", "ZH2O", "ZHO2", "GH2O", "GHO2",
    "XUH2O", "XUHO2", "XKH2O", "XKHO2", "XLH2O", "XLHO2", "XZH2O", "XZHO2", "XGH2O", "XGHO2",
}

DEPOSIT_RESOURCES = {
    "silicon", "metal", "biomass", "mist",
}

COMMODITY_RESOURCES = {
    "utrium_bar", "lemergium_bar", "zynthium_bar", "keanium_bar", "ghodium_melt",
    "oxidant", "reductant", "purifier", "battery",
    "composite", "crystal", "liquid",
    "wire", "switch", "transistor", "microchip", "circuit", "device",
    "cell", "phlegm", "tissue", "muscle", "organoid", "organism",
    "alloy", "tube", "fixtures", "frame", "hydraulics", "machine",
    "condensate", "concentrate", "extract", "spirit", "emanation", "essence",
}

RESOURCE_CATEGORY_ORDER = ["Basics", "Compounds", "Commodities", "Deposits", "Other"]

DEBUG_ENABLED = str(os.environ.get("DASHBOARD_DEBUG", "")).strip().lower() in {"1", "true", "yes", "on"}
DEBUG_LOG_FILE = str(os.environ.get("DASHBOARD_LOG_FILE", "")).strip()


def _debug_log(event, **fields):
    if not DEBUG_ENABLED:
        return
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    extras = " ".join(f"{k}={fields[k]!r}" for k in sorted(fields))
    line = f"[dashboard-debug {timestamp}] {event}"
    if extras:
        line = f"{line} {extras}"
    print(line, flush=True)
    if DEBUG_LOG_FILE:
        try:
            Path(DEBUG_LOG_FILE).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
            with Path(DEBUG_LOG_FILE).expanduser().open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except Exception:
            pass


def _iter_screeps_config_candidates():
    seen = set()
    candidates = []

    cwd = Path.cwd().resolve()
    here = Path(__file__).resolve().parent

    for base in (cwd, here, *cwd.parents, *here.parents):
        try:
            path = (base / ".screeps.json").resolve()
        except Exception:
            continue
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        candidates.append(path)
    return candidates


def _read_token_from_screeps_config():
    for path in _iter_screeps_config_candidates():
        if not path.exists() or not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(data, dict):
            token = (data.get("token") or "").strip()
            if token:
                return token, path
    return "", None


def _json_load_maybe(value):
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return value
        if text.startswith("gz:"):
            payload = text[3:].strip()
            try:
                decoded = base64.b64decode(payload)
                unzipped = gzip.decompress(decoded).decode("utf-8", errors="replace").strip()
                text = unzipped
            except Exception:
                return value
        if text[0] in "{[":
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return value
    return value


class ScreepsApiClient:
    def __init__(self, base_url, token, timeout=10):
        self.base_url = base_url.rstrip("/")
        self.token = token.strip()
        self.timeout = timeout

    def _request_json(self, api_path, params=None, method="GET", payload=None):
        params = params or {}
        query = parse.urlencode({k: v for k, v in params.items() if v is not None and v != ""})
        url = f"{self.base_url}{api_path}"
        if query:
            url = f"{url}?{query}"

        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Token": self.token,
            "Authorization": f"Bearer {self.token}",
        }
        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        req = request.Request(url, method=method, headers=headers, data=body)
        try:
            with request.urlopen(req, timeout=self.timeout) as resp:
                body = resp.read().decode("utf-8", errors="replace")
        except error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {body[:200]}") from exc
        except error.URLError as exc:
            raise RuntimeError(f"Network error: {exc.reason}") from exc

        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Non-JSON response from {api_path}: {body[:200]}") from exc

    def get_profile(self):
        return self._request_json("/api/auth/me")

    def get_game_time(self, shard=None):
        return self._request_json("/api/game/time", {"shard": shard})

    def get_memory(self, memory_path="", shard=None):
        payload = self._request_json("/api/user/memory", {"path": memory_path, "shard": shard})
        data = payload.get("data", payload)
        return _json_load_maybe(data)

    def run_console(self, expression, shard=None):
        payload = {
            "expression": expression,
            "shard": shard,
        }
        return self._request_json("/api/user/console", method="POST", payload=payload)


def _looks_like_room_name(value):
    return isinstance(value, str) and bool(ROOM_NAME_RE.match(value))


def _norm_text(value):
    if value is None:
        return ""
    return str(value).strip()


def _norm_upper(value):
    return _norm_text(value).upper()


def build_room_rows(memory_obj, memory_path=""):
    if not isinstance(memory_obj, dict):
        return []

    rows = []
    mem_rooms = {}
    market_rooms = {}

    if isinstance(memory_obj.get("rooms"), dict):
        mem_rooms = memory_obj.get("rooms", {})
    if isinstance(memory_obj.get("market"), dict) and isinstance(memory_obj["market"].get("rooms"), dict):
        market_rooms = memory_obj["market"]["rooms"]

    if not mem_rooms and not market_rooms:
        room_like_keys = [k for k, v in memory_obj.items() if _looks_like_room_name(k) and isinstance(v, dict)]
        if room_like_keys:
            looks_market_cfg = any(
                isinstance(memory_obj[k], dict)
                and any(
                    key in memory_obj[k]
                    for key in ("enabled", "runEvery", "buy", "sell", "terminalStockTargets", "roomStockTargets")
                )
                for k in room_like_keys
            )
            if looks_market_cfg:
                market_rooms = {k: memory_obj[k] for k in room_like_keys}
            else:
                mem_rooms = {k: memory_obj[k] for k in room_like_keys}
        else:
            # Single-room payload support, e.g. memory_path="rooms.W44S28"
            leaf = memory_path.split(".")[-1].strip().upper() if memory_path else ""
            if _looks_like_room_name(leaf):
                mem_rooms = {leaf: memory_obj}

    room_names = sorted(set(mem_rooms.keys()) | set(market_rooms.keys()))
    for room_name in room_names:
        room_mem = mem_rooms.get(room_name, {})
        market_mem = market_rooms.get(room_name, {})
        spawn_ticket_count = 0
        if isinstance(room_mem, dict):
            ticket_index = room_mem.get("spawnTicketsByKey", {})
            if isinstance(ticket_index, dict):
                spawn_ticket_count = sum(
                    len(v) if isinstance(v, list) else 1 for v in ticket_index.values()
                )
        phase = ""
        policy_state = ""
        combat_state = ""
        if isinstance(room_mem, dict):
            overseer = room_mem.get("overseer", {})
            if isinstance(overseer, dict):
                policy = overseer.get("policy", {})
                condition = overseer.get("condition", {})
                if isinstance(policy, dict):
                    phase = _norm_upper(policy.get("phase", ""))
                    policy_state = _norm_upper(policy.get("state", ""))
                if not phase and isinstance(condition, dict):
                    phase = _norm_upper(condition.get("phase", ""))
                if not policy_state:
                    if isinstance(condition, dict):
                        policy_state = _norm_upper(condition.get("state", ""))
                if not policy_state:
                    policy_state = _norm_upper(overseer.get("state", room_mem.get("_opState", "")))
            admiral = room_mem.get("admiral", {})
            if isinstance(admiral, dict):
                combat_state = _norm_upper(admiral.get("state", ""))
        if phase and phase not in KNOWN_PHASES:
            phase = f"OTHER:{phase}"
        if policy_state and policy_state not in KNOWN_STATES:
            policy_state = f"OTHER:{policy_state}"
        remote_enabled = ""
        if isinstance(room_mem, dict):
            remote = room_mem.get("overseer", {}).get("remote", {})
            if isinstance(remote, dict) and "enabled" in remote:
                remote_enabled = str(bool(remote.get("enabled")))
        market_enabled = ""
        if isinstance(market_mem, dict) and "enabled" in market_mem:
            market_enabled = str(bool(market_mem.get("enabled")))

        rows.append(
            {
                "room": room_name,
                "phase": phase,
                "policy_state": policy_state,
                "combat_state": combat_state,
                "spawn_tickets": spawn_ticket_count,
                "remote_enabled": remote_enabled,
                "market_enabled": market_enabled,
            }
        )
    return rows


def build_creep_metrics(memory_obj):
    creeps = memory_obj.get("creeps", {}) if isinstance(memory_obj, dict) else {}
    if not isinstance(creeps, dict):
        return {"total": 0, "role_rows": []}

    by_role = {}
    for creep_mem in creeps.values():
        if not isinstance(creep_mem, dict):
            continue
        role = str(creep_mem.get("role", "unknown"))
        rec = by_role.setdefault(role, {"role": role, "count": 0})
        rec["count"] += 1

    role_rows = sorted(by_role.values(), key=lambda r: (-r["count"], r["role"]))
    return {"total": len(creeps), "role_rows": role_rows}


def build_market_rows(memory_obj):
    if not isinstance(memory_obj, dict):
        return []
    market = memory_obj.get("market", {})
    if not isinstance(market, dict):
        return []
    global_enabled = str(bool(market.get("globalEnabled", False))) if "globalEnabled" in market else ""
    rooms = market.get("rooms", {})
    if not isinstance(rooms, dict):
        return []
    rows = []
    for room_name in sorted(rooms):
        cfg = rooms.get(room_name, {})
        if not isinstance(cfg, dict):
            continue
        rows.append(
            {
                "room": room_name,
                "global_enabled": global_enabled,
                "enabled": str(bool(cfg.get("enabled", False))),
                "run_every": cfg.get("runEvery", ""),
                "min_credits": cfg.get("minCredits", ""),
                "energy_reserve": cfg.get("energyReserve", ""),
                "terminal_target": cfg.get("terminalEnergyTarget", ""),
                "terminal_max": cfg.get("terminalEnergyMax", ""),
                "max_deals": cfg.get("maxDealsPerRoom", ""),
                "energy_value": cfg.get("energyValue", ""),
                "max_overpay_pct": cfg.get("maxOverpayPct", ""),
                "sell_buffer_pct": cfg.get("sellBufferPct", ""),
                "buy_specs": len(cfg.get("buy", {})) if isinstance(cfg.get("buy"), dict) else 0,
                "sell_specs": len(cfg.get("sell", {})) if isinstance(cfg.get("sell"), dict) else 0,
                "terminal_targets": len(cfg.get("terminalStockTargets", {})) if isinstance(cfg.get("terminalStockTargets"), dict) else 0,
                "room_targets": len(cfg.get("roomStockTargets", {})) if isinstance(cfg.get("roomStockTargets"), dict) else 0,
            }
        )
    return rows


def _format_market_resource_specs(specs, mode):
    if not isinstance(specs, dict) or not specs:
        return ["(none)"]
    rows = []
    for resource_type in sorted(specs):
        spec = specs.get(resource_type, {})
        if not isinstance(spec, dict):
            rows.append(f"{resource_type}: {spec}")
            continue
        enabled = spec.get("enabled", True)
        if mode == "buy":
            rows.append(
                f"{resource_type}: enabled={bool(enabled)} batch={spec.get('batch', '-')}"
                f" maxPrice={spec.get('maxPrice', '-')}"
            )
        else:
            rows.append(
                f"{resource_type}: enabled={bool(enabled)} batch={spec.get('batch', '-')}"
                f" minPrice={spec.get('minPrice', '-')}"
            )
    return rows


def _format_market_targets(targets):
    if not isinstance(targets, dict) or not targets:
        return ["(none)"]
    return [f"{resource_type}: {targets[resource_type]}" for resource_type in sorted(targets)]


def build_market_details(memory_obj):
    if not isinstance(memory_obj, dict):
        return {}
    market = memory_obj.get("market", {})
    if not isinstance(market, dict):
        return {}
    rooms = market.get("rooms", {})
    if not isinstance(rooms, dict):
        return {}

    global_enabled = market.get("globalEnabled", None)
    details = {}
    for room_name in sorted(rooms):
        cfg = rooms.get(room_name, {})
        if not isinstance(cfg, dict):
            continue
        lines = [
            f"Room: {room_name}",
            f"Global Enabled: {global_enabled if global_enabled is not None else '-'}",
            f"Room Enabled: {bool(cfg.get('enabled', False))}",
            "",
            "Buy Specs:",
        ]
        lines.extend(_format_market_resource_specs(cfg.get("buy", {}), mode="buy"))
        lines.extend(["", "Sell Specs:"])
        lines.extend(_format_market_resource_specs(cfg.get("sell", {}), mode="sell"))
        lines.extend(["", "Terminal Stock Targets:"])
        lines.extend(_format_market_targets(cfg.get("terminalStockTargets", {})))
        lines.extend(["", "Room Stock Targets:"])
        lines.extend(_format_market_targets(cfg.get("roomStockTargets", {})))
        details[room_name] = "\n".join(lines)
    return details


def build_labs_rows(memory_obj):
    if not isinstance(memory_obj, dict):
        return []
    labs = memory_obj.get("labs", {})
    if not isinstance(labs, dict):
        return []
    reaction = labs.get("reaction", {}) if isinstance(labs.get("reaction"), dict) else {}
    return [
        {
            "enabled": str(bool(labs.get("enabled", False))),
            "run_every": labs.get("runEvery", ""),
            "mode": labs.get("mode", ""),
            "transfer_priority": labs.get("transferPriority", ""),
            "input_target": labs.get("inputTarget", ""),
            "reagent_a": reaction.get("reagentA", ""),
            "reagent_b": reaction.get("reagentB", ""),
            "rooms": len(labs.get("rooms", {})) if isinstance(labs.get("rooms"), dict) else 0,
        }
    ]


def extract_market_config(memory_obj):
    if not isinstance(memory_obj, dict):
        return {"globalEnabled": False, "rooms": {}}
    market = memory_obj.get("market", {})
    if not isinstance(market, dict):
        return {"globalEnabled": False, "rooms": {}}
    rooms = market.get("rooms", {})
    if not isinstance(rooms, dict):
        rooms = {}
    return {
        "globalEnabled": bool(market.get("globalEnabled", False)),
        "rooms": rooms,
    }


def extract_labs_config(memory_obj):
    if not isinstance(memory_obj, dict):
        return {}
    labs = memory_obj.get("labs", {})
    if not isinstance(labs, dict):
        return {}
    return labs


class Poller:
    def __init__(self, output_queue):
        self.output_queue = output_queue
        self._thread = None
        self._stop = threading.Event()

    def start(self, settings):
        self.stop()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, args=(settings,), daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        self._thread = None

    def _run(self, settings):
        interval = max(1.0, float(settings["interval"]))
        while not self._stop.is_set():
            started = time.time()
            try:
                client = ScreepsApiClient(
                    base_url=settings["server_url"],
                    token=settings["token"],
                    timeout=10,
                )
                snapshot = self._fetch_snapshot(client, settings)
                self.output_queue.put(("snapshot", snapshot))
            except Exception as exc:  # noqa: BLE001
                self.output_queue.put(("error", str(exc)))

            elapsed = time.time() - started
            wait_for = max(0.2, interval - elapsed)
            if self._stop.wait(wait_for):
                break

    def _fetch_snapshot(self, client, settings):
        shard = settings["shard"]
        memory_path = settings["memory_path"]

        errors = []

        def safe_call(fn, fallback):
            try:
                return fn()
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc))
                _debug_log("fetch.safe_call.error", function=repr(fn), error=str(exc))
                return fallback

        profile = safe_call(client.get_profile, {})
        game_time = safe_call(lambda: client.get_game_time(shard=shard), {})
        memory_obj = safe_call(lambda: client.get_memory(memory_path=memory_path, shard=shard), {})
        root_memory_obj = memory_obj
        if memory_path:
            root_memory_obj = safe_call(lambda: client.get_memory(memory_path="", shard=shard), {})

        room_rows = build_room_rows(memory_obj, memory_path=memory_path)
        creep_metrics = build_creep_metrics(memory_obj)
        market_rows = build_market_rows(root_memory_obj)
        market_details = build_market_details(root_memory_obj)
        market_config = extract_market_config(root_memory_obj)
        labs_rows = build_labs_rows(root_memory_obj)
        labs_config = extract_labs_config(root_memory_obj)
        _debug_log(
            "fetch.snapshot.summary",
            shard=shard,
            memory_path=memory_path,
            errors=len(errors),
            room_rows=len(room_rows),
            market_rows=len(market_rows),
            market_rooms=len(market_config.get("rooms", {})) if isinstance(market_config, dict) else -1,
            labs_rows=len(labs_rows),
        )

        return {
            "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "profile": profile,
            "game_time": game_time,
            "memory": memory_obj,
            "room_rows": room_rows,
            "creep_metrics": creep_metrics,
            "market_rows": market_rows,
            "market_details": market_details,
            "market_config": market_config,
            "labs_rows": labs_rows,
            "labs_config": labs_config,
            "errors": errors,
        }


class DashboardApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Screeps Memory Dashboard")
        self.geometry("1200x780")
        self.minsize(1000, 640)

        self.queue = queue.Queue()
        self.poller = Poller(self.queue)
        self._build_ui()
        self._load_config(silent=True)
        self._autofill_token_from_screeps_config()
        _debug_log("ui.init", geometry=self.geometry(), minsize=f"{self.minsize()[0]}x{self.minsize()[1]}")
        self.after(250, self._drain_queue)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _build_ui(self):
        self.server_var = tk.StringVar(value="https://screeps.com")
        self.token_var = tk.StringVar(value="")
        self.shard_var = tk.StringVar(value="shard3")
        self.path_var = tk.StringVar(value="")
        self.interval_var = tk.StringVar(value="5")
        self.status_var = tk.StringVar(value="Idle")
        self.user_var = tk.StringVar(value="-")
        self.tick_var = tk.StringVar(value="-")
        self.updated_var = tk.StringVar(value="-")
        self.creeps_var = tk.StringVar(value="-")
        self.market_details_by_room = {}
        self.market_room_var = tk.StringVar(value="")
        self.market_send_from_var = tk.StringVar(value="")
        self.market_send_to_var = tk.StringVar(value="")
        self.market_send_resource_var = tk.StringVar(value="energy")
        self.market_send_amount_var = tk.StringVar(value="5000")
        self.market_send_desc_var = tk.StringVar(value="")
        self.market_order_id_var = tk.StringVar(value="")
        self.market_form_global_enabled_var = tk.BooleanVar(value=False)
        self.market_form_room_enabled_var = tk.BooleanVar(value=False)
        self.market_form_run_every_var = tk.StringVar(value="")
        self.market_form_min_credits_var = tk.StringVar(value="")
        self.market_form_energy_reserve_var = tk.StringVar(value="")
        self.market_form_terminal_target_var = tk.StringVar(value="")
        self.market_form_terminal_max_var = tk.StringVar(value="")
        self.market_form_max_deals_var = tk.StringVar(value="")
        self.market_form_energy_value_var = tk.StringVar(value="")
        self.market_form_max_overpay_var = tk.StringVar(value="")
        self.market_form_sell_buffer_var = tk.StringVar(value="")
        self.market_resource_rows = {}
        self.market_resource_notebook = None
        self.market_resource_tab_bodies = {}
        self.market_resource_signature = ()
        self.market_add_resource_var = tk.StringVar(value="")
        self.market_memory_sync_generation = 0
        self.console_expr_max_chars = CONSOLE_EXPR_MAX_CHARS
        self.labs_room_var = tk.StringVar(value="")
        self.labs_reagent_a_var = tk.StringVar(value="H")
        self.labs_reagent_b_var = tk.StringVar(value="O")
        self.labs_reverse_product_var = tk.StringVar(value="GH2O")
        self.labs_form_enabled_var = tk.BooleanVar(value=False)
        self.labs_form_run_every_var = tk.StringVar(value="")
        self.labs_form_mode_var = tk.StringVar(value="react")
        self.labs_form_transfer_priority_var = tk.StringVar(value="")
        self.labs_form_input_target_var = tk.StringVar(value="")
        self.labs_form_boost_target_var = tk.StringVar(value="")
        self.labs_form_max_reactions_var = tk.StringVar(value="")
        self.labs_form_cleanup_idle_var = tk.BooleanVar(value=False)
        self.labs_form_debug_var = tk.BooleanVar(value=False)
        self.labs_form_reagent_a_var = tk.StringVar(value="")
        self.labs_form_reagent_b_var = tk.StringVar(value="")
        self.labs_form_reverse_product_var = tk.StringVar(value="")
        self.labs_form_input_labs_var = tk.StringVar(value="")
        self.labs_form_output_labs_var = tk.StringVar(value="")
        self.market_config_snapshot = {"globalEnabled": False, "rooms": {}}
        self.labs_config_snapshot = {}

        root = ttk.Frame(self, padding=12)
        root.pack(fill=tk.BOTH, expand=True)

        settings = ttk.LabelFrame(root, text="Connection")
        settings.pack(fill=tk.X)
        settings.columnconfigure(1, weight=1)
        settings.columnconfigure(3, weight=1)

        ttk.Label(settings, text="Server URL").grid(row=0, column=0, sticky="w", padx=6, pady=4)
        ttk.Entry(settings, textvariable=self.server_var).grid(row=0, column=1, sticky="ew", padx=6, pady=4)
        ttk.Label(settings, text="Shard").grid(row=0, column=2, sticky="w", padx=6, pady=4)
        ttk.Entry(settings, textvariable=self.shard_var, width=14).grid(row=0, column=3, sticky="ew", padx=6, pady=4)

        ttk.Label(settings, text="Auth Token").grid(row=1, column=0, sticky="w", padx=6, pady=4)
        ttk.Entry(settings, textvariable=self.token_var, show="*").grid(row=1, column=1, sticky="ew", padx=6, pady=4)
        ttk.Label(settings, text="Memory Path").grid(row=1, column=2, sticky="w", padx=6, pady=4)
        ttk.Entry(settings, textvariable=self.path_var).grid(row=1, column=3, sticky="ew", padx=6, pady=4)

        ttk.Label(settings, text="Refresh (sec)").grid(row=2, column=0, sticky="w", padx=6, pady=4)
        ttk.Entry(settings, textvariable=self.interval_var, width=8).grid(row=2, column=1, sticky="w", padx=6, pady=4)
        ttk.Button(settings, text="Start Polling", command=self._start_polling).grid(row=2, column=2, padx=6, pady=4, sticky="ew")
        ttk.Button(settings, text="Stop", command=self._stop_polling).grid(row=2, column=3, padx=6, pady=4, sticky="ew")

        actions = ttk.Frame(settings)
        actions.grid(row=3, column=0, columnspan=4, sticky="ew", padx=4, pady=4)
        for i in range(3):
            actions.columnconfigure(i, weight=1)
        ttk.Button(actions, text="Pull Once", command=self._pull_once).grid(row=0, column=0, sticky="ew", padx=4)
        ttk.Button(actions, text="Save Config", command=self._save_config).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(actions, text="Load Config", command=self._load_config).grid(row=0, column=2, sticky="ew", padx=4)

        summary = ttk.LabelFrame(root, text="Summary")
        summary.pack(fill=tk.X, pady=(10, 0))
        for i in range(5):
            summary.columnconfigure(i, weight=1)

        self._summary_item(summary, "Status", self.status_var, 0)
        self._summary_item(summary, "User", self.user_var, 1)
        self._summary_item(summary, "Game Time", self.tick_var, 2)
        self._summary_item(summary, "Last Updated", self.updated_var, 3)
        self._summary_item(summary, "Creeps", self.creeps_var, 4)

        content = ttk.Panedwindow(root, orient=tk.HORIZONTAL)
        content.pack(fill=tk.BOTH, expand=True, pady=(10, 0))

        left = ttk.Frame(content)
        right = ttk.Frame(content)
        content.add(left, weight=1)
        content.add(right, weight=2)

        ttk.Label(left, text="Rooms / Phase/State").pack(anchor="w")
        columns = ("room", "phase", "policy_state", "combat_state", "spawn_tickets", "remote_enabled", "market_enabled")
        self.rooms_tree = ttk.Treeview(left, columns=columns, show="headings", height=18)
        self.rooms_tree.pack(fill=tk.BOTH, expand=True)
        self.rooms_tree.heading("room", text="Room")
        self.rooms_tree.heading("phase", text="Phase")
        self.rooms_tree.heading("policy_state", text="Policy State")
        self.rooms_tree.heading("combat_state", text="Combat")
        self.rooms_tree.heading("spawn_tickets", text="Spawn Tickets")
        self.rooms_tree.heading("remote_enabled", text="Remote")
        self.rooms_tree.heading("market_enabled", text="Market")
        self.rooms_tree.column("room", width=100, anchor="w")
        self.rooms_tree.column("phase", width=95, anchor="center")
        self.rooms_tree.column("policy_state", width=110, anchor="center")
        self.rooms_tree.column("combat_state", width=90, anchor="center")
        self.rooms_tree.column("spawn_tickets", width=110, anchor="e")
        self.rooms_tree.column("remote_enabled", width=80, anchor="center")
        self.rooms_tree.column("market_enabled", width=80, anchor="center")

        tabs = ttk.Notebook(right)
        tabs.pack(fill=tk.BOTH, expand=True)

        creeps_tab = ttk.Frame(tabs, padding=6)
        market_tab = ttk.Frame(tabs, padding=6)
        labs_tab = ttk.Frame(tabs, padding=6)
        raw_tab = ttk.Frame(tabs, padding=6)
        tabs.add(creeps_tab, text="Creeps")
        tabs.add(market_tab, text="Market")
        tabs.add(labs_tab, text="Labs")
        tabs.add(raw_tab, text="Raw JSON")
        market_scroll = self._make_scrollable_tab(market_tab, padding=6)
        labs_scroll = self._make_scrollable_tab(labs_tab, padding=6)

        ttk.Label(creeps_tab, text="Creep Count by Role").pack(anchor="w")
        creep_cols = ("role", "count")
        self.creeps_tree = ttk.Treeview(creeps_tab, columns=creep_cols, show="headings", height=10)
        self.creeps_tree.pack(fill=tk.BOTH, expand=True)
        for c, t, w in (
            ("role", "Role", 140),
            ("count", "Count", 70),
        ):
            self.creeps_tree.heading(c, text=t)
            self.creeps_tree.column(c, width=w, anchor="center" if c != "role" else "w")

        market_cols = (
            "room",
            "global_enabled",
            "enabled",
            "run_every",
            "min_credits",
            "energy_reserve",
            "terminal_target",
            "terminal_max",
            "max_deals",
            "energy_value",
            "max_overpay_pct",
            "sell_buffer_pct",
            "buy_specs",
            "sell_specs",
            "terminal_targets",
            "room_targets",
        )
        self.market_tree = ttk.Treeview(market_scroll, columns=market_cols, show="headings", height=8)
        self.market_tree.pack(fill=tk.X, expand=False)
        for c, t, w in (
            ("room", "Room", 90),
            ("global_enabled", "Global", 70),
            ("enabled", "Enabled", 70),
            ("run_every", "Run Every", 80),
            ("min_credits", "Min Credits", 100),
            ("energy_reserve", "Energy Reserve", 110),
            ("terminal_target", "Terminal Target", 115),
            ("terminal_max", "Terminal Max", 105),
            ("max_deals", "Max Deals", 80),
            ("energy_value", "Energy Value", 90),
            ("max_overpay_pct", "Max Overpay %", 100),
            ("sell_buffer_pct", "Sell Buffer %", 100),
            ("buy_specs", "Buy Specs", 80),
            ("sell_specs", "Sell Specs", 80),
            ("terminal_targets", "Term Targets", 95),
            ("room_targets", "Room Targets", 95),
        ):
            self.market_tree.heading(c, text=t)
            self.market_tree.column(c, width=w, anchor="center" if c != "room" else "w")
        self.market_tree.bind("<<TreeviewSelect>>", self._on_market_row_selected)
        market_controls = ttk.LabelFrame(market_scroll, text="Controls (console-backed)")
        market_controls.pack(fill=tk.X, pady=(8, 0))
        for i in range(4):
            market_controls.columnconfigure(i, weight=1)
        ttk.Button(market_controls, text='market("status")', command=lambda: self._run_market_command('market("status")')).grid(row=0, column=0, padx=4, pady=4, sticky="ew")
        ttk.Button(market_controls, text="Global On (memwrite)", command=lambda: self._run_market_global_set(True)).grid(row=0, column=1, padx=4, pady=4, sticky="ew")
        ttk.Button(market_controls, text="Global Off (memwrite)", command=lambda: self._run_market_global_set(False)).grid(row=0, column=2, padx=4, pady=4, sticky="ew")
        ttk.Button(market_controls, text="Clear Rooms (memwrite)", command=self._run_market_reset_all_rooms).grid(row=0, column=3, padx=4, pady=4, sticky="ew")

        ttk.Label(market_controls, text="Room").grid(row=1, column=0, padx=4, pady=4, sticky="w")
        ttk.Entry(market_controls, textvariable=self.market_room_var).grid(row=1, column=1, padx=4, pady=4, sticky="ew")
        ttk.Button(market_controls, text='room status', command=lambda: self._run_market_room_action("status")).grid(row=1, column=2, padx=4, pady=4, sticky="ew")
        ttk.Button(market_controls, text='room on/off', command=self._run_market_room_toggle).grid(row=1, column=3, padx=4, pady=4, sticky="ew")

        ttk.Button(market_controls, text="Delete Room CFG (memdelete)", command=self._run_market_reset_room).grid(row=2, column=0, padx=4, pady=4, sticky="ew")
        ttk.Button(market_controls, text='market("calc", room, "force")', command=self._run_market_calc_force).grid(row=2, column=1, padx=4, pady=4, sticky="ew")
        ttk.Button(market_controls, text='market("room", room, "report")', command=self._run_market_report).grid(row=2, column=2, padx=4, pady=4, sticky="ew")
        ttk.Button(market_controls, text='market("orders")', command=lambda: self._run_market_command('market("orders")')).grid(row=2, column=3, padx=4, pady=4, sticky="ew")

        ttk.Label(market_controls, text='Send: from').grid(row=3, column=0, padx=4, pady=4, sticky="w")
        ttk.Entry(market_controls, textvariable=self.market_send_from_var).grid(row=3, column=1, padx=4, pady=4, sticky="ew")
        ttk.Label(market_controls, text="to").grid(row=3, column=2, padx=4, pady=4, sticky="w")
        ttk.Entry(market_controls, textvariable=self.market_send_to_var).grid(row=3, column=3, padx=4, pady=4, sticky="ew")

        ttk.Label(market_controls, text="resource").grid(row=4, column=0, padx=4, pady=4, sticky="w")
        ttk.Entry(market_controls, textvariable=self.market_send_resource_var).grid(row=4, column=1, padx=4, pady=4, sticky="ew")
        ttk.Label(market_controls, text="amount").grid(row=4, column=2, padx=4, pady=4, sticky="w")
        ttk.Entry(market_controls, textvariable=self.market_send_amount_var).grid(row=4, column=3, padx=4, pady=4, sticky="ew")
        ttk.Label(market_controls, text="desc").grid(row=5, column=0, padx=4, pady=4, sticky="w")
        ttk.Entry(market_controls, textvariable=self.market_send_desc_var).grid(row=5, column=1, columnspan=2, padx=4, pady=4, sticky="ew")
        ttk.Button(market_controls, text='market("send", ...)', command=self._run_market_send).grid(row=5, column=3, padx=4, pady=4, sticky="ew")

        ttk.Label(market_controls, text="Order ID").grid(row=6, column=0, padx=4, pady=4, sticky="w")
        ttk.Entry(market_controls, textvariable=self.market_order_id_var).grid(row=6, column=1, padx=4, pady=4, sticky="ew")
        ttk.Button(market_controls, text='market("order","cancel",id)', command=self._run_market_order_cancel).grid(row=6, column=2, padx=4, pady=4, sticky="ew")
        ttk.Button(market_controls, text='market("order","untrack",id)', command=self._run_market_order_untrack).grid(row=6, column=3, padx=4, pady=4, sticky="ew")

        ttk.Label(
            market_controls,
            text="Market keys: globalEnabled; rooms.<ROOM>.enabled, runEvery, minCredits, energyReserve, terminalEnergyTarget, terminalEnergyMax, maxDealsPerRoom, energyValue, maxOverpayPct, sellBufferPct, buy, sell, terminalStockTargets, roomStockTargets",
            wraplength=900,
        ).grid(row=7, column=0, columnspan=4, padx=4, pady=(2, 4), sticky="w")
        ttk.Button(market_controls, text="Probe Memory Write (temp)", command=self._run_market_memory_probe).grid(row=8, column=0, columnspan=2, padx=4, pady=(0, 4), sticky="ew")

        market_form = ttk.LabelFrame(market_scroll, text="Market Form (no manual keys)")
        market_form.pack(fill=tk.X, pady=(8, 0))
        for i in range(6):
            market_form.columnconfigure(i, weight=1)
        ttk.Checkbutton(market_form, text="Global Enabled", variable=self.market_form_global_enabled_var).grid(row=0, column=0, padx=4, pady=4, sticky="w")
        ttk.Button(market_form, text="Apply Global Toggle", command=self._apply_market_global_form).grid(row=0, column=1, padx=4, pady=4, sticky="ew")
        ttk.Button(market_form, text="Load Room -> Form", command=self._load_market_form_from_room_entry).grid(row=0, column=2, padx=4, pady=4, sticky="ew")
        ttk.Button(market_form, text="Apply Room Form", command=self._apply_market_room_form).grid(row=0, column=3, padx=4, pady=4, sticky="ew")

        ttk.Checkbutton(market_form, text="Room Enabled", variable=self.market_form_room_enabled_var).grid(row=1, column=0, padx=4, pady=4, sticky="w")
        ttk.Label(market_form, text="runEvery").grid(row=1, column=1, padx=4, pady=4, sticky="w")
        ttk.Entry(market_form, textvariable=self.market_form_run_every_var).grid(row=1, column=2, padx=4, pady=4, sticky="ew")
        ttk.Label(market_form, text="minCredits").grid(row=1, column=3, padx=4, pady=4, sticky="w")
        ttk.Entry(market_form, textvariable=self.market_form_min_credits_var).grid(row=1, column=4, padx=4, pady=4, sticky="ew")

        ttk.Label(market_form, text="energyReserve").grid(row=2, column=0, padx=4, pady=4, sticky="w")
        ttk.Entry(market_form, textvariable=self.market_form_energy_reserve_var).grid(row=2, column=1, padx=4, pady=4, sticky="ew")
        ttk.Label(market_form, text="terminalEnergyTarget").grid(row=2, column=2, padx=4, pady=4, sticky="w")
        ttk.Entry(market_form, textvariable=self.market_form_terminal_target_var).grid(row=2, column=3, padx=4, pady=4, sticky="ew")
        ttk.Label(market_form, text="terminalEnergyMax").grid(row=2, column=4, padx=4, pady=4, sticky="w")
        ttk.Entry(market_form, textvariable=self.market_form_terminal_max_var).grid(row=2, column=5, padx=4, pady=4, sticky="ew")

        ttk.Label(market_form, text="maxDealsPerRoom").grid(row=3, column=0, padx=4, pady=4, sticky="w")
        ttk.Entry(market_form, textvariable=self.market_form_max_deals_var).grid(row=3, column=1, padx=4, pady=4, sticky="ew")
        ttk.Label(market_form, text="energyValue").grid(row=3, column=2, padx=4, pady=4, sticky="w")
        ttk.Entry(market_form, textvariable=self.market_form_energy_value_var).grid(row=3, column=3, padx=4, pady=4, sticky="ew")
        ttk.Label(market_form, text="maxOverpayPct").grid(row=3, column=4, padx=4, pady=4, sticky="w")
        ttk.Entry(market_form, textvariable=self.market_form_max_overpay_var).grid(row=3, column=5, padx=4, pady=4, sticky="ew")

        ttk.Label(market_form, text="sellBufferPct").grid(row=4, column=0, padx=4, pady=4, sticky="w")
        ttk.Entry(market_form, textvariable=self.market_form_sell_buffer_var).grid(row=4, column=1, padx=4, pady=4, sticky="ew")
        ttk.Label(market_form, text="Add Resource").grid(row=4, column=2, padx=4, pady=4, sticky="w")
        ttk.Entry(market_form, textvariable=self.market_add_resource_var).grid(row=4, column=3, padx=4, pady=4, sticky="ew")
        ttk.Button(market_form, text="Add Row", command=self._add_market_resource_row).grid(row=4, column=4, padx=4, pady=4, sticky="ew")
        ttk.Button(market_form, text="Reset Catalog Rows", command=self._reset_market_resource_rows).grid(row=4, column=5, padx=4, pady=4, sticky="ew")
        resources_frame = ttk.LabelFrame(market_form, text="Resource Matrix")
        resources_frame.grid(row=5, column=0, columnspan=6, padx=4, pady=4, sticky="nsew")
        market_form.rowconfigure(5, weight=1)
        resources_frame.columnconfigure(0, weight=1)
        resources_frame.rowconfigure(0, weight=1)
        self.market_resource_notebook = ttk.Notebook(resources_frame, height=340)
        self.market_resource_notebook.pack(fill=tk.BOTH, expand=True)
        self._rebuild_market_resource_table(GAME_RESOURCE_CATALOG)

        ttk.Label(market_scroll, text="Selected Room Market Details").pack(anchor="w", pady=(8, 0))
        self.market_details_text = ScrolledText(market_scroll, wrap=tk.NONE, font=("Consolas", 10), height=12)
        self.market_details_text.pack(fill=tk.X, expand=False)
        self.market_details_text.insert("1.0", "Select a market room row to view buy/sell/stock-target details.")
        self.market_details_text.configure(state=tk.DISABLED)
        ttk.Label(market_scroll, text="Market Command Log").pack(anchor="w", pady=(8, 0))
        self.market_cmd_log = ScrolledText(market_scroll, wrap=tk.WORD, font=("Consolas", 10), height=6)
        self.market_cmd_log.pack(fill=tk.X, expand=False)
        self.market_cmd_log.configure(state=tk.DISABLED)

        labs_cols = ("enabled", "run_every", "mode", "transfer_priority", "input_target", "reagent_a", "reagent_b", "rooms")
        self.labs_tree = ttk.Treeview(labs_scroll, columns=labs_cols, show="headings", height=3)
        self.labs_tree.pack(fill=tk.X, expand=False)
        for c, t, w in (
            ("enabled", "Enabled", 80),
            ("run_every", "Run Every", 90),
            ("mode", "Mode", 90),
            ("transfer_priority", "Transfer Prio", 110),
            ("input_target", "Input Target", 95),
            ("reagent_a", "Reagent A", 90),
            ("reagent_b", "Reagent B", 90),
            ("rooms", "Rooms", 70),
        ):
            self.labs_tree.heading(c, text=t)
            self.labs_tree.column(c, width=w, anchor="center")
        labs_controls = ttk.LabelFrame(labs_scroll, text="Controls (console-backed)")
        labs_controls.pack(fill=tk.X, pady=(8, 0))
        for i in range(4):
            labs_controls.columnconfigure(i, weight=1)
        ttk.Button(labs_controls, text='lab("status")', command=lambda: self._run_labs_command('lab("status")')).grid(row=0, column=0, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_controls, text='lab("on")', command=lambda: self._run_labs_command('lab("on")')).grid(row=0, column=1, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_controls, text='lab("off")', command=lambda: self._run_labs_command('lab("off")')).grid(row=0, column=2, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_controls, text='lab("roomsReset")', command=lambda: self._run_labs_command('lab("roomsReset")')).grid(row=0, column=3, padx=4, pady=4, sticky="ew")

        ttk.Button(labs_controls, text='lab("idle")', command=lambda: self._run_labs_command('lab("idle")')).grid(row=1, column=0, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_controls, text='lab("purge")', command=lambda: self._run_labs_command('lab("purge")')).grid(row=1, column=1, padx=4, pady=4, sticky="ew")
        ttk.Label(labs_controls, text="Room").grid(row=1, column=2, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_controls, textvariable=self.labs_room_var).grid(row=1, column=3, padx=4, pady=4, sticky="ew")

        ttk.Button(labs_controls, text="room status", command=lambda: self._run_labs_room_action(None)).grid(row=2, column=0, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_controls, text='room "on"', command=lambda: self._run_labs_room_action("on")).grid(row=2, column=1, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_controls, text='room "off"', command=lambda: self._run_labs_room_action("off")).grid(row=2, column=2, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_controls, text='room "idle"', command=lambda: self._run_labs_command_with_room("roomIdle")).grid(row=2, column=3, padx=4, pady=4, sticky="ew")

        ttk.Label(labs_controls, text='React A').grid(row=3, column=0, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_controls, textvariable=self.labs_reagent_a_var).grid(row=3, column=1, padx=4, pady=4, sticky="ew")
        ttk.Label(labs_controls, text='React B').grid(row=3, column=2, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_controls, textvariable=self.labs_reagent_b_var).grid(row=3, column=3, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_controls, text='Run lab("react", A, B)', command=self._run_labs_react).grid(row=4, column=0, columnspan=2, padx=4, pady=4, sticky="ew")
        ttk.Label(labs_controls, text="Reverse Product").grid(row=4, column=2, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_controls, textvariable=self.labs_reverse_product_var).grid(row=4, column=3, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_controls, text='Run lab("reverse", product)', command=self._run_labs_reverse).grid(row=5, column=0, columnspan=2, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_controls, text='Run lab("roomPurge", room)', command=lambda: self._run_labs_command_with_room("roomPurge")).grid(row=5, column=2, columnspan=2, padx=4, pady=4, sticky="ew")

        ttk.Label(
            labs_controls,
            text="Labs keys: enabled, runEvery, mode, transferPriority, inputTarget, boostTarget, maxReactionsPerTick, cleanupIdle, reaction, reverse, inputLabs, outputLabs, boosts, rooms.<ROOM>.*",
            wraplength=900,
        ).grid(row=6, column=0, columnspan=4, padx=4, pady=(2, 4), sticky="w")

        labs_form = ttk.LabelFrame(labs_scroll, text="Labs Form (no manual keys)")
        labs_form.pack(fill=tk.X, pady=(8, 0))
        for i in range(6):
            labs_form.columnconfigure(i, weight=1)
        ttk.Checkbutton(labs_form, text="Enabled", variable=self.labs_form_enabled_var).grid(row=0, column=0, padx=4, pady=4, sticky="w")
        ttk.Label(labs_form, text="mode").grid(row=0, column=1, padx=4, pady=4, sticky="w")
        ttk.Combobox(
            labs_form,
            textvariable=self.labs_form_mode_var,
            values=("react", "reverse", "idle", "purge"),
            state="readonly",
            width=12,
        ).grid(row=0, column=2, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_form, text="Load Global -> Form", command=self._load_labs_form_from_global).grid(row=0, column=3, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_form, text="Load Room -> Form", command=self._load_labs_form_from_room_entry).grid(row=0, column=4, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_form, text="Apply Form To Global", command=self._apply_labs_global_form).grid(row=0, column=5, padx=4, pady=4, sticky="ew")

        ttk.Label(labs_form, text="runEvery").grid(row=1, column=0, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_form, textvariable=self.labs_form_run_every_var).grid(row=1, column=1, padx=4, pady=4, sticky="ew")
        ttk.Label(labs_form, text="transferPriority").grid(row=1, column=2, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_form, textvariable=self.labs_form_transfer_priority_var).grid(row=1, column=3, padx=4, pady=4, sticky="ew")
        ttk.Label(labs_form, text="inputTarget").grid(row=1, column=4, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_form, textvariable=self.labs_form_input_target_var).grid(row=1, column=5, padx=4, pady=4, sticky="ew")

        ttk.Label(labs_form, text="boostTarget").grid(row=2, column=0, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_form, textvariable=self.labs_form_boost_target_var).grid(row=2, column=1, padx=4, pady=4, sticky="ew")
        ttk.Label(labs_form, text="maxReactionsPerTick").grid(row=2, column=2, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_form, textvariable=self.labs_form_max_reactions_var).grid(row=2, column=3, padx=4, pady=4, sticky="ew")
        ttk.Checkbutton(labs_form, text="cleanupIdle", variable=self.labs_form_cleanup_idle_var).grid(row=2, column=4, padx=4, pady=4, sticky="w")
        ttk.Checkbutton(labs_form, text="debug", variable=self.labs_form_debug_var).grid(row=2, column=5, padx=4, pady=4, sticky="w")

        ttk.Label(labs_form, text="reaction.reagentA").grid(row=3, column=0, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_form, textvariable=self.labs_form_reagent_a_var).grid(row=3, column=1, padx=4, pady=4, sticky="ew")
        ttk.Label(labs_form, text="reaction.reagentB").grid(row=3, column=2, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_form, textvariable=self.labs_form_reagent_b_var).grid(row=3, column=3, padx=4, pady=4, sticky="ew")
        ttk.Label(labs_form, text="reverse.product").grid(row=3, column=4, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_form, textvariable=self.labs_form_reverse_product_var).grid(row=3, column=5, padx=4, pady=4, sticky="ew")

        ttk.Label(labs_form, text="inputLabs (comma separated)").grid(row=4, column=0, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_form, textvariable=self.labs_form_input_labs_var).grid(row=4, column=1, columnspan=2, padx=4, pady=4, sticky="ew")
        ttk.Label(labs_form, text="outputLabs (comma separated)").grid(row=4, column=3, padx=4, pady=4, sticky="w")
        ttk.Entry(labs_form, textvariable=self.labs_form_output_labs_var).grid(row=4, column=4, columnspan=2, padx=4, pady=4, sticky="ew")

        ttk.Label(labs_form, text="boosts (JSON)").grid(row=5, column=0, padx=4, pady=4, sticky="w")
        self.labs_form_boosts_text = ScrolledText(labs_form, wrap=tk.NONE, font=("Consolas", 9), height=4)
        self.labs_form_boosts_text.grid(row=5, column=1, columnspan=2, padx=4, pady=4, sticky="ew")
        ttk.Label(labs_form, text="reverse (JSON override)").grid(row=5, column=3, padx=4, pady=4, sticky="w")
        self.labs_form_reverse_text = ScrolledText(labs_form, wrap=tk.NONE, font=("Consolas", 9), height=4)
        self.labs_form_reverse_text.grid(row=5, column=4, columnspan=2, padx=4, pady=4, sticky="ew")
        ttk.Button(labs_form, text="Apply Form To Room", command=self._apply_labs_room_form).grid(row=6, column=5, padx=4, pady=4, sticky="ew")
        ttk.Label(labs_scroll, text="Labs Command Log").pack(anchor="w", pady=(8, 0))
        self.labs_cmd_log = ScrolledText(labs_scroll, wrap=tk.WORD, font=("Consolas", 10), height=7)
        self.labs_cmd_log.pack(fill=tk.X, expand=False)
        self.labs_cmd_log.configure(state=tk.DISABLED)

        ttk.Label(raw_tab, text="Raw Memory JSON").pack(anchor="w")
        self.raw_json = ScrolledText(raw_tab, wrap=tk.NONE, font=("Consolas", 10))
        self.raw_json.pack(fill=tk.BOTH, expand=True)

    def _summary_item(self, parent, label, var, column):
        frame = ttk.Frame(parent, padding=(6, 4))
        frame.grid(row=0, column=column, sticky="nsew")
        ttk.Label(frame, text=label).pack(anchor="w")
        ttk.Label(frame, textvariable=var, font=("Segoe UI", 10, "bold")).pack(anchor="w")

    def _make_scrollable_tab(self, parent, padding=6):
        container = ttk.Frame(parent)
        container.pack(fill=tk.BOTH, expand=True)

        canvas = tk.Canvas(container, highlightthickness=0)
        scrollbar = ttk.Scrollbar(container, orient=tk.VERTICAL, command=canvas.yview)
        canvas.configure(yscrollcommand=scrollbar.set)

        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        inner = ttk.Frame(canvas, padding=padding)
        window_id = canvas.create_window((0, 0), window=inner, anchor="nw")

        def on_inner_config(_event=None):
            canvas.configure(scrollregion=canvas.bbox("all"))

        def on_canvas_config(event):
            canvas.itemconfigure(window_id, width=event.width)

        def on_mousewheel(event):
            delta = int(-event.delta / 120) if event.delta else 0
            if delta != 0:
                canvas.yview_scroll(delta, "units")
            return "break"

        def bind_wheel(_event=None):
            canvas.bind_all("<MouseWheel>", on_mousewheel)

        def unbind_wheel(_event=None):
            canvas.unbind_all("<MouseWheel>")

        inner.bind("<Configure>", on_inner_config)
        canvas.bind("<Configure>", on_canvas_config)
        inner.bind("<Enter>", bind_wheel)
        inner.bind("<Leave>", unbind_wheel)
        canvas.bind("<Enter>", bind_wheel)
        canvas.bind("<Leave>", unbind_wheel)

        return inner

    def _autofill_token_from_screeps_config(self):
        if (self.token_var.get() or "").strip():
            return False
        token, path = _read_token_from_screeps_config()
        if not token:
            return False
        self.token_var.set(token)
        self.status_var.set(f"Loaded token from {path}")
        return True

    def _resolve_token_for_settings(self, settings):
        token = (settings.get("token") or "").strip()
        if token:
            return settings
        auto_token, path = _read_token_from_screeps_config()
        if auto_token:
            settings["token"] = auto_token
            self.token_var.set(auto_token)
            self.status_var.set(f"Loaded token from {path}")
        return settings

    def _normalize_room_input(self, room_value):
        room_name = (room_value or "").strip().upper()
        if not room_name:
            raise ValueError("Room is required.")
        if not ROOM_NAME_RE.match(room_name):
            raise ValueError(f"Invalid room name: {room_name}")
        return room_name

    def _append_log(self, widget, text):
        widget.configure(state=tk.NORMAL)
        widget.insert(tk.END, text + "\n")
        widget.see(tk.END)
        widget.configure(state=tk.DISABLED)

    def _set_text_widget_json(self, widget, value):
        widget.delete("1.0", tk.END)
        widget.insert("1.0", json.dumps(value if value is not None else {}, indent=2, ensure_ascii=True))

    def _read_text_widget_json(self, widget, label):
        raw = widget.get("1.0", tk.END).strip()
        if not raw:
            return {}
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid {label} JSON: {exc}") from exc
        if not isinstance(value, dict):
            raise ValueError(f"{label} JSON must be an object.")
        return value

    def _parse_number_or_empty(self, text, label, allow_float=False):
        raw = (text or "").strip()
        if raw == "":
            return None
        try:
            value = float(raw) if allow_float else int(raw)
        except ValueError as exc:
            kind = "number" if allow_float else "integer"
            raise ValueError(f"{label} must be a {kind}.") from exc
        return value

    def _build_market_room_patch_from_form(self):
        patch = {
            "enabled": bool(self.market_form_room_enabled_var.get()),
        }
        delete_paths = []
        numeric_map = [
            ("runEvery", self.market_form_run_every_var.get(), False),
            ("minCredits", self.market_form_min_credits_var.get(), False),
            ("energyReserve", self.market_form_energy_reserve_var.get(), False),
            ("terminalEnergyTarget", self.market_form_terminal_target_var.get(), False),
            ("terminalEnergyMax", self.market_form_terminal_max_var.get(), False),
            ("maxDealsPerRoom", self.market_form_max_deals_var.get(), False),
            ("energyValue", self.market_form_energy_value_var.get(), True),
            ("maxOverpayPct", self.market_form_max_overpay_var.get(), True),
            ("sellBufferPct", self.market_form_sell_buffer_var.get(), True),
        ]
        for key, raw, allow_float in numeric_map:
            value = self._parse_number_or_empty(raw, key, allow_float=allow_float)
            if value is not None:
                patch[key] = value

        room_key = (self.market_room_var.get() or "").strip().upper()
        cfg = self.market_config_snapshot if isinstance(self.market_config_snapshot, dict) else {}
        rooms = cfg.get("rooms", {}) if isinstance(cfg.get("rooms"), dict) else {}
        room_cfg = rooms.get(room_key, {}) if isinstance(rooms.get(room_key, {}), dict) else {}
        existing_buy = room_cfg.get("buy", {}) if isinstance(room_cfg.get("buy"), dict) else {}
        existing_sell = room_cfg.get("sell", {}) if isinstance(room_cfg.get("sell"), dict) else {}
        existing_terminal_targets = room_cfg.get("terminalStockTargets", {}) if isinstance(room_cfg.get("terminalStockTargets"), dict) else {}
        existing_room_targets = room_cfg.get("roomStockTargets", {}) if isinstance(room_cfg.get("roomStockTargets"), dict) else {}

        buy = {}
        sell = {}
        terminal_targets = {}
        room_targets = {}
        for resource, row in self.market_resource_rows.items():
            buy_enabled = bool(row["buy_enabled"].get())
            sell_enabled = bool(row["sell_enabled"].get())

            buy_batch = self._parse_number_or_empty(row["buy_batch"].get(), f"{resource}.buy.batch", allow_float=False)
            buy_max = self._parse_number_or_empty(row["buy_max_price"].get(), f"{resource}.buy.maxPrice", allow_float=True)
            sell_batch = self._parse_number_or_empty(row["sell_batch"].get(), f"{resource}.sell.batch", allow_float=False)
            sell_min = self._parse_number_or_empty(row["sell_min_price"].get(), f"{resource}.sell.minPrice", allow_float=True)
            terminal_target = self._parse_number_or_empty(row["terminal_target"].get(), f"{resource}.terminalStockTarget", allow_float=False)
            room_target = self._parse_number_or_empty(row["room_target"].get(), f"{resource}.roomStockTarget", allow_float=False)

            buy_in_existing = resource in existing_buy
            sell_in_existing = resource in existing_sell
            terminal_in_existing = resource in existing_terminal_targets
            room_in_existing = resource in existing_room_targets

            include_buy = buy_enabled or buy_batch is not None or buy_max is not None
            include_sell = sell_enabled or sell_batch is not None or sell_min is not None
            include_terminal_target = terminal_target is not None and terminal_target > 0
            include_room_target = room_target is not None and room_target > 0
            if resource == "energy":
                # Energy uses terminalEnergyTarget, not terminalStockTargets.
                include_terminal_target = False

            if include_buy:
                spec = {"enabled": bool(buy_enabled)}
                if buy_batch is not None:
                    spec["batch"] = buy_batch
                if buy_max is not None:
                    spec["maxPrice"] = buy_max
                buy[resource] = spec
            elif buy_in_existing:
                # Disabled + empty means remove stale resource config from memory.
                delete_paths.append(["market", "rooms", room_key, "buy", resource])

            if include_sell:
                spec = {"enabled": bool(sell_enabled)}
                if sell_batch is not None:
                    spec["batch"] = sell_batch
                if sell_min is not None:
                    spec["minPrice"] = sell_min
                sell[resource] = spec
            elif sell_in_existing:
                # Disabled + empty means remove stale resource config from memory.
                delete_paths.append(["market", "rooms", room_key, "sell", resource])

            if include_terminal_target:
                terminal_targets[resource] = terminal_target
            elif terminal_in_existing:
                # Blank or <=0 means remove stale target from memory.
                delete_paths.append(["market", "rooms", room_key, "terminalStockTargets", resource])
            if include_room_target:
                room_targets[resource] = room_target
            elif room_in_existing:
                # Blank or <=0 means remove stale target from memory.
                delete_paths.append(["market", "rooms", room_key, "roomStockTargets", resource])

        if buy:
            patch["buy"] = buy
        if sell:
            patch["sell"] = sell
        if terminal_targets:
            patch["terminalStockTargets"] = terminal_targets
        if room_targets:
            patch["roomStockTargets"] = room_targets
        return patch, delete_paths

    def _load_market_form(self, room_name):
        room_key = (room_name or "").strip().upper()
        cfg = self.market_config_snapshot if isinstance(self.market_config_snapshot, dict) else {"globalEnabled": False, "rooms": {}}
        self.market_form_global_enabled_var.set(bool(cfg.get("globalEnabled", False)))
        room_cfg = {}
        rooms = cfg.get("rooms", {})
        if isinstance(rooms, dict):
            room_cfg = rooms.get(room_key, {}) if room_key else {}
        if not isinstance(room_cfg, dict):
            room_cfg = {}

        self.market_form_room_enabled_var.set(bool(room_cfg.get("enabled", False)))
        self.market_form_run_every_var.set(str(room_cfg.get("runEvery", "")))
        self.market_form_min_credits_var.set(str(room_cfg.get("minCredits", "")))
        self.market_form_energy_reserve_var.set(str(room_cfg.get("energyReserve", "")))
        self.market_form_terminal_target_var.set(str(room_cfg.get("terminalEnergyTarget", "")))
        self.market_form_terminal_max_var.set(str(room_cfg.get("terminalEnergyMax", "")))
        self.market_form_max_deals_var.set(str(room_cfg.get("maxDealsPerRoom", "")))
        self.market_form_energy_value_var.set(str(room_cfg.get("energyValue", "")))
        self.market_form_max_overpay_var.set(str(room_cfg.get("maxOverpayPct", "")))
        self.market_form_sell_buffer_var.set(str(room_cfg.get("sellBufferPct", "")))
        buy = room_cfg.get("buy", {}) if isinstance(room_cfg.get("buy"), dict) else {}
        sell = room_cfg.get("sell", {}) if isinstance(room_cfg.get("sell"), dict) else {}
        terminal_targets = room_cfg.get("terminalStockTargets", {}) if isinstance(room_cfg.get("terminalStockTargets"), dict) else {}
        room_targets = room_cfg.get("roomStockTargets", {}) if isinstance(room_cfg.get("roomStockTargets"), dict) else {}
        for resource, row in self.market_resource_rows.items():
            b = buy.get(resource, {})
            s = sell.get(resource, {})
            terminal_value = terminal_targets.get(resource)
            room_value = room_targets.get(resource)
            row["buy_enabled"].set(bool(b.get("enabled", False)) if isinstance(b, dict) else False)
            row["sell_enabled"].set(bool(s.get("enabled", False)) if isinstance(s, dict) else False)
            row["buy_batch"].set("" if not isinstance(b, dict) or b.get("batch") is None else str(b.get("batch")))
            row["buy_max_price"].set("" if not isinstance(b, dict) or b.get("maxPrice") is None else str(b.get("maxPrice")))
            row["sell_batch"].set("" if not isinstance(s, dict) or s.get("batch") is None else str(s.get("batch")))
            row["sell_min_price"].set("" if not isinstance(s, dict) or s.get("minPrice") is None else str(s.get("minPrice")))
            if resource == "energy":
                row["terminal_target"].set("")
            else:
                row["terminal_target"].set("" if terminal_value is None or terminal_value <= 0 else str(terminal_value))
            row["room_target"].set("" if room_value is None or room_value <= 0 else str(room_value))

    def _market_resource_category(self, resource):
        if resource in BASIC_RESOURCES:
            return "Basics"
        if resource in COMBINED_RESOURCES:
            return "Compounds"
        if resource in COMMODITY_RESOURCES:
            return "Commodities"
        if resource in DEPOSIT_RESOURCES:
            return "Deposits"
        return "Other"

    def _collect_market_resource_list(self):
        def normalize_resource_key(value):
            if value is None:
                return ""
            text = str(value).strip()
            return text

        resources = {normalize_resource_key(r) for r in GAME_RESOURCE_CATALOG}
        resources.discard("")
        catalog_set = set(resources)
        cfg = self.market_config_snapshot if isinstance(self.market_config_snapshot, dict) else {}
        rooms = cfg.get("rooms", {}) if isinstance(cfg.get("rooms"), dict) else {}
        for room_cfg in rooms.values():
            if not isinstance(room_cfg, dict):
                continue
            for key in ("buy", "sell", "terminalStockTargets", "roomStockTargets"):
                block = room_cfg.get(key, {})
                if isinstance(block, dict):
                    for resource_key in block.keys():
                        normalized = normalize_resource_key(resource_key)
                        if normalized:
                            resources.add(normalized)
        if not resources:
            resources = set(GAME_RESOURCE_CATALOG)
            resources.discard("")
        return sorted(resources, key=lambda r: (r not in catalog_set, r))

    def _snapshot_market_resource_table_values(self):
        snapshot = {}
        for resource, row in self.market_resource_rows.items():
            snapshot[resource] = {
                "buy_enabled": bool(row["buy_enabled"].get()),
                "buy_batch": row["buy_batch"].get(),
                "buy_max_price": row["buy_max_price"].get(),
                "sell_enabled": bool(row["sell_enabled"].get()),
                "sell_batch": row["sell_batch"].get(),
                "sell_min_price": row["sell_min_price"].get(),
                "terminal_target": row["terminal_target"].get(),
                "room_target": row["room_target"].get(),
            }
        return snapshot

    def _rebuild_market_resource_table(self, resources, existing_values=None):
        if self.market_resource_notebook is None:
            return
        normalized_resources = []
        seen = set()
        for resource in resources or []:
            text = "" if resource is None else str(resource).strip()
            if not text or text in seen:
                continue
            seen.add(text)
            normalized_resources.append(text)
        if not normalized_resources:
            normalized_resources = [r for r in GAME_RESOURCE_CATALOG if isinstance(r, str) and r.strip()]
        resources = normalized_resources
        old_tabs = list(self.market_resource_notebook.tabs())
        for tab_id in old_tabs:
            try:
                tab_widget = self.market_resource_notebook.nametowidget(tab_id)
            except Exception:
                tab_widget = None
            self.market_resource_notebook.forget(tab_id)
            if tab_widget is not None:
                tab_widget.destroy()
        self.market_resource_rows = {}
        self.market_resource_tab_bodies = {}

        headers = [
            "Resource",
            "Buy On",
            "Buy Batch",
            "Buy MaxPrice",
            "Sell On",
            "Sell Batch",
            "Sell MinPrice",
            "Terminal Target",
            "Room Target",
        ]

        category_to_resources = {name: [] for name in RESOURCE_CATEGORY_ORDER}
        for resource in resources:
            category_to_resources.setdefault(self._market_resource_category(resource), []).append(resource)

        for category in RESOURCE_CATEGORY_ORDER:
            category_resources = category_to_resources.get(category, [])
            if not category_resources:
                continue
            tab = ttk.Frame(self.market_resource_notebook)
            self.market_resource_notebook.add(tab, text=category)

            table_host = ttk.Frame(tab)
            table_host.pack(fill=tk.BOTH, expand=True)
            table_canvas = tk.Canvas(table_host, highlightthickness=0)
            table_vscroll = ttk.Scrollbar(table_host, orient=tk.VERTICAL, command=table_canvas.yview)
            table_hscroll = ttk.Scrollbar(table_host, orient=tk.HORIZONTAL, command=table_canvas.xview)
            table_canvas.configure(yscrollcommand=table_vscroll.set, xscrollcommand=table_hscroll.set)
            table_vscroll.pack(side=tk.RIGHT, fill=tk.Y)
            table_hscroll.pack(side=tk.BOTTOM, fill=tk.X)
            table_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

            table_body = ttk.Frame(table_canvas)
            window_id = table_canvas.create_window((0, 0), window=table_body, anchor="nw")

            def on_body_config(_event=None, c=table_canvas):
                c.configure(scrollregion=c.bbox("all"))

            def on_canvas_config(event, c=table_canvas, win=window_id):
                c.itemconfigure(win, width=max(event.width, table_body.winfo_reqwidth()))

            def on_mousewheel(event, c=table_canvas):
                delta = int(-event.delta / 120) if event.delta else 0
                if delta:
                    c.yview_scroll(delta, "units")
                    return "break"
                return None

            table_body.bind("<Configure>", on_body_config)
            table_canvas.bind("<Configure>", on_canvas_config)
            table_body.bind("<MouseWheel>", on_mousewheel)
            table_canvas.bind("<MouseWheel>", on_mousewheel)
            self.market_resource_tab_bodies[category] = table_body
            for col in range(len(headers)):
                table_body.columnconfigure(col, weight=1 if col >= 2 else 0)
            for c, text in enumerate(headers):
                ttk.Label(table_body, text=text).grid(row=0, column=c, padx=2, pady=2, sticky="w")

            for idx, resource in enumerate(category_resources, start=1):
                buy_enabled = tk.BooleanVar(value=False)
                buy_batch = tk.StringVar(value="")
                buy_max_price = tk.StringVar(value="")
                sell_enabled = tk.BooleanVar(value=False)
                sell_batch = tk.StringVar(value="")
                sell_min_price = tk.StringVar(value="")
                terminal_target = tk.StringVar(value="")
                room_target = tk.StringVar(value="")

                ttk.Label(table_body, text=resource).grid(row=idx, column=0, padx=2, pady=2, sticky="w")
                ttk.Checkbutton(table_body, variable=buy_enabled).grid(row=idx, column=1, padx=2, pady=2, sticky="w")
                ttk.Entry(table_body, textvariable=buy_batch, width=8).grid(row=idx, column=2, padx=2, pady=2, sticky="ew")
                ttk.Entry(table_body, textvariable=buy_max_price, width=8).grid(row=idx, column=3, padx=2, pady=2, sticky="ew")
                ttk.Checkbutton(table_body, variable=sell_enabled).grid(row=idx, column=4, padx=2, pady=2, sticky="w")
                ttk.Entry(table_body, textvariable=sell_batch, width=8).grid(row=idx, column=5, padx=2, pady=2, sticky="ew")
                ttk.Entry(table_body, textvariable=sell_min_price, width=8).grid(row=idx, column=6, padx=2, pady=2, sticky="ew")
                terminal_target_entry = ttk.Entry(table_body, textvariable=terminal_target, width=10)
                terminal_target_entry.grid(row=idx, column=7, padx=2, pady=2, sticky="ew")
                if resource == "energy":
                    terminal_target.set("")
                    terminal_target_entry.configure(state="disabled")
                ttk.Entry(table_body, textvariable=room_target, width=10).grid(row=idx, column=8, padx=2, pady=2, sticky="ew")

                self.market_resource_rows[resource] = {
                    "buy_enabled": buy_enabled,
                    "buy_batch": buy_batch,
                    "buy_max_price": buy_max_price,
                    "sell_enabled": sell_enabled,
                    "sell_batch": sell_batch,
                    "sell_min_price": sell_min_price,
                    "terminal_target": terminal_target,
                    "room_target": room_target,
                }
                if existing_values and resource in existing_values:
                    prev = existing_values[resource]
                    buy_enabled.set(bool(prev.get("buy_enabled", False)))
                    buy_batch.set(str(prev.get("buy_batch", "")))
                    buy_max_price.set(str(prev.get("buy_max_price", "")))
                    sell_enabled.set(bool(prev.get("sell_enabled", False)))
                    sell_batch.set(str(prev.get("sell_batch", "")))
                    sell_min_price.set(str(prev.get("sell_min_price", "")))
                    terminal_target.set(str(prev.get("terminal_target", "")))
                    room_target.set(str(prev.get("room_target", "")))
        tabs = self.market_resource_notebook.tabs()
        if tabs:
            self.market_resource_notebook.select(tabs[0])
        self.market_resource_signature = tuple(resources)
        _debug_log(
            "ui.market_table.rebuild",
            resource_rows=len(self.market_resource_rows),
            tabs=len(tabs),
            tab_labels=[self.market_resource_notebook.tab(t, "text") for t in tabs],
            old_tabs=len(old_tabs),
        )

    def _rebuild_market_resource_table_from_snapshot(self):
        resources = self._collect_market_resource_list()
        signature = tuple(resources)
        if signature == self.market_resource_signature and self.market_resource_rows:
            _debug_log(
                "ui.market_table.rebuild.skip",
                reason="resource-signature-unchanged",
                resource_rows=len(self.market_resource_rows),
            )
            return
        existing_values = self._snapshot_market_resource_table_values()
        self._rebuild_market_resource_table(resources, existing_values=existing_values)

    def _add_market_resource_row(self):
        resource = (self.market_add_resource_var.get() or "").strip()
        if not resource:
            messagebox.showerror("Market form", "Resource value is required.")
            return
        if resource.upper() in {"H", "O", "U", "L", "K", "Z", "X", "G", "OH", "UL", "ZK"} or any(ch.isdigit() for ch in resource):
            normalized = resource.upper()
        else:
            normalized = resource.lower()
        existing = set(self.market_resource_rows.keys())
        existing.add(normalized)
        existing_values = self._snapshot_market_resource_table_values()
        self._rebuild_market_resource_table(
            sorted(existing, key=lambda r: (r not in GAME_RESOURCE_CATALOG, r)),
            existing_values=existing_values,
        )
        self.market_add_resource_var.set("")

    def _reset_market_resource_rows(self):
        self._rebuild_market_resource_table_from_snapshot()

    def _load_labs_form(self, room_name=None):
        cfg = self.labs_config_snapshot if isinstance(self.labs_config_snapshot, dict) else {}
        room_cfg = {}
        if room_name:
            rooms = cfg.get("rooms", {})
            if isinstance(rooms, dict):
                room_cfg = rooms.get(room_name, {})
        if not isinstance(room_cfg, dict):
            room_cfg = {}
        merged = dict(cfg)
        merged.update(room_cfg)

        self.labs_form_enabled_var.set(bool(merged.get("enabled", False)))
        self.labs_form_run_every_var.set(str(merged.get("runEvery", "")))
        self.labs_form_mode_var.set(str(merged.get("mode", "react") or "react"))
        self.labs_form_transfer_priority_var.set(str(merged.get("transferPriority", "")))
        self.labs_form_input_target_var.set(str(merged.get("inputTarget", "")))
        self.labs_form_boost_target_var.set(str(merged.get("boostTarget", "")))
        self.labs_form_max_reactions_var.set(str(merged.get("maxReactionsPerTick", "")))
        self.labs_form_cleanup_idle_var.set(bool(merged.get("cleanupIdle", False)))
        self.labs_form_debug_var.set(bool(merged.get("debug", False)))
        reaction = merged.get("reaction", {}) if isinstance(merged.get("reaction"), dict) else {}
        reverse = merged.get("reverse", {}) if isinstance(merged.get("reverse"), dict) else {}
        self.labs_form_reagent_a_var.set(str(reaction.get("reagentA", "")))
        self.labs_form_reagent_b_var.set(str(reaction.get("reagentB", "")))
        self.labs_form_reverse_product_var.set(str(reverse.get("product", "")))
        input_labs = merged.get("inputLabs", [])
        output_labs = merged.get("outputLabs", [])
        self.labs_form_input_labs_var.set(",".join(input_labs) if isinstance(input_labs, list) else "")
        self.labs_form_output_labs_var.set(",".join(output_labs) if isinstance(output_labs, list) else "")
        self._set_text_widget_json(self.labs_form_boosts_text, merged.get("boosts", {}))
        self._set_text_widget_json(self.labs_form_reverse_text, reverse)

    def _run_console_expressions(self, expressions, target):
        if not isinstance(expressions, list) or not expressions:
            return
        oversized = [expr for expr in expressions if is_expression_too_long(expr, self.console_expr_max_chars)]
        if oversized:
            messagebox.showerror(
                "Console command too long",
                f"{target}: command exceeds max length ({self.console_expr_max_chars} chars).\n"
                f"Use smaller diffs or split operations.",
            )
            return
        settings = self._collect_settings()
        settings = self._resolve_token_for_settings(settings)
        try:
            self._validate_settings(settings)
        except ValueError as exc:
            messagebox.showerror("Invalid settings", str(exc))
            return

        def worker():
            client = ScreepsApiClient(
                base_url=settings["server_url"],
                token=settings["token"],
                timeout=10,
            )
            for expression in expressions:
                try:
                    result = client.run_console(expression=expression, shard=settings["shard"])
                    self.queue.put(("console", {"target": target, "expression": expression, "result": result}))
                except Exception as exc:  # noqa: BLE001
                    self.queue.put(("console_error", {"target": target, "expression": expression, "error": str(exc)}))

        self.status_var.set(f"Sending {len(expressions)} console command(s) ({target})...")
        threading.Thread(target=worker, daemon=True).start()

    def _run_console_expression(self, expression, target):
        self._run_console_expressions([expression], target)

    def _run_memory_writes(self, write_ops, target):
        expressions = [build_memwrite_expression(path_parts, value) for path_parts, value in write_ops]
        self._run_console_expressions(expressions, target=target)

    def _run_memory_updates(self, write_ops, delete_paths, target):
        expressions = []
        expressions.extend(build_memdelete_expression(path_parts) for path_parts in delete_paths)
        expressions.extend(build_memwrite_expression(path_parts, value) for path_parts, value in write_ops)
        self._run_console_expressions(expressions, target=target)

    def _run_memory_set(self, path_parts, value, target):
        if not isinstance(path_parts, list) or not path_parts:
            raise ValueError("path_parts must be a non-empty list.")
        for part in path_parts:
            if not isinstance(part, str) or not part:
                raise ValueError("Each memory path segment must be a non-empty string.")
        expression = build_memwrite_expression(path_parts, value)
        self._run_console_expression(expression, target=target)

    def _run_memory_patch(self, path_parts, patch, target):
        if not isinstance(path_parts, list) or not path_parts:
            raise ValueError("path_parts must be a non-empty list.")
        for part in path_parts:
            if not isinstance(part, str) or not part:
                raise ValueError("Each memory path segment must be a non-empty string.")
        expression = build_mempatch_expression(path_parts, patch)
        self._run_console_expression(expression, target=target)

    def _run_memory_delete(self, path_parts, target):
        if not isinstance(path_parts, list) or not path_parts:
            raise ValueError("path_parts must be a non-empty list.")
        for part in path_parts:
            if not isinstance(part, str) or not part:
                raise ValueError("Each memory path segment must be a non-empty string.")
        expression = build_memdelete_expression(path_parts)
        self._run_console_expression(expression, target=target)

    def _run_market_command(self, expression):
        self._run_console_expression(expression, target="market")

    def _run_labs_command(self, expression):
        self._run_console_expression(expression, target="labs")

    def _run_market_room_action(self, action):
        try:
            room_name = self._normalize_room_input(self.market_room_var.get())
        except ValueError as exc:
            messagebox.showerror("Market control", str(exc))
            return
        room_json = json.dumps(room_name, ensure_ascii=True)
        action_value = "status" if action is None else action
        action_json = json.dumps(action_value, ensure_ascii=True)
        self._run_market_command(f"market(\"room\", {room_json}, {action_json})")

    def _run_market_room_toggle(self):
        try:
            room_name = self._normalize_room_input(self.market_room_var.get())
        except ValueError as exc:
            messagebox.showerror("Market control", str(exc))
            return
        cfg = self.market_config_snapshot if isinstance(self.market_config_snapshot, dict) else {"rooms": {}}
        rooms = cfg.get("rooms", {}) if isinstance(cfg.get("rooms"), dict) else {}
        room_cfg = rooms.get(room_name, {}) if isinstance(rooms.get(room_name, {}), dict) else {}
        next_enabled = not bool(room_cfg.get("enabled", False))
        self._run_memory_set(["market", "rooms", room_name, "enabled"], next_enabled, target="market-memory")

    def _run_market_global_set(self, enabled):
        self._run_memory_set(["market", "globalEnabled"], bool(enabled), target="market-memory")

    def _run_market_reset_all_rooms(self):
        self._run_memory_set(["market", "rooms"], {}, target="market-memory")

    def _run_market_reset_room(self):
        try:
            room_name = self._normalize_room_input(self.market_room_var.get())
        except ValueError as exc:
            messagebox.showerror("Market control", str(exc))
            return
        self._run_memory_delete(["market", "rooms", room_name], target="market-memory")

    def _run_market_calc_force(self):
        try:
            room_name = self._normalize_room_input(self.market_room_var.get())
        except ValueError as exc:
            messagebox.showerror("Market control", str(exc))
            return
        room_json = json.dumps(room_name, ensure_ascii=True)
        self._run_market_command(f"market(\"calc\", {room_json}, \"force\")")

    def _run_market_report(self):
        try:
            room_name = self._normalize_room_input(self.market_room_var.get())
        except ValueError as exc:
            messagebox.showerror("Market control", str(exc))
            return
        room_json = json.dumps(room_name, ensure_ascii=True)
        self._run_market_command(f"market(\"room\", {room_json}, \"report\")")

    def _run_market_memory_probe(self):
        self._run_console_expression('memwrite("market._guiProbe", Game.time)', target="market-memory")

    def _schedule_market_memory_sync(self):
        self.market_memory_sync_generation += 1
        generation = self.market_memory_sync_generation
        # Market memory writes are eventually consistent from console to API memory reads.
        # Queue a few delayed pulls so GUI state catches up without requiring manual refreshes.
        for delay_ms in (1200, 3000, 6000):
            self.after(delay_ms, lambda g=generation: self._run_market_memory_sync_pull(g))

    def _run_market_memory_sync_pull(self, generation):
        if generation != self.market_memory_sync_generation:
            return
        self._pull_once(status_text="Syncing market memory...")

    def _run_market_send(self):
        try:
            from_room = self._normalize_room_input(self.market_send_from_var.get())
            to_room = self._normalize_room_input(self.market_send_to_var.get())
        except ValueError as exc:
            messagebox.showerror("Market control", str(exc))
            return
        resource = (self.market_send_resource_var.get() or "").strip()
        if not resource:
            messagebox.showerror("Market control", "Resource is required.")
            return
        try:
            amount = int((self.market_send_amount_var.get() or "").strip())
        except ValueError:
            messagebox.showerror("Market control", "Amount must be an integer.")
            return
        if amount <= 0:
            messagebox.showerror("Market control", "Amount must be > 0.")
            return
        desc = (self.market_send_desc_var.get() or "").strip()

        from_json = json.dumps(from_room, ensure_ascii=True)
        to_json = json.dumps(to_room, ensure_ascii=True)
        resource_json = json.dumps(resource, ensure_ascii=True)
        amount_json = str(amount)
        if desc:
            desc_json = json.dumps(desc, ensure_ascii=True)
            self._run_market_command(
                f"market(\"send\", {from_json}, {to_json}, {resource_json}, {amount_json}, {desc_json})"
            )
        else:
            self._run_market_command(
                f"market(\"send\", {from_json}, {to_json}, {resource_json}, {amount_json})"
            )

    def _run_market_order_cancel(self):
        order_id = (self.market_order_id_var.get() or "").strip()
        if not order_id:
            messagebox.showerror("Market control", "Order ID is required.")
            return
        order_json = json.dumps(order_id, ensure_ascii=True)
        self._run_market_command(f"market(\"order\", \"cancel\", {order_json})")

    def _run_market_order_untrack(self):
        order_id = (self.market_order_id_var.get() or "").strip()
        if not order_id:
            messagebox.showerror("Market control", "Order ID is required.")
            return
        order_json = json.dumps(order_id, ensure_ascii=True)
        self._run_market_command(f"market(\"order\", \"untrack\", {order_json})")

    def _load_market_form_from_room_entry(self):
        try:
            room_name = self._normalize_room_input(self.market_room_var.get())
        except ValueError as exc:
            messagebox.showerror("Market form", str(exc))
            return
        self._load_market_form(room_name)

    def _apply_market_global_form(self):
        self._run_memory_set(
            ["market", "globalEnabled"],
            bool(self.market_form_global_enabled_var.get()),
            target="market-memory",
        )

    def _apply_market_room_form(self):
        try:
            room_name = self._normalize_room_input(self.market_room_var.get())
            patch, delete_paths = self._build_market_room_patch_from_form()
        except ValueError as exc:
            messagebox.showerror("Market form", str(exc))
            return
        cfg = self.market_config_snapshot if isinstance(self.market_config_snapshot, dict) else {}
        rooms = cfg.get("rooms", {}) if isinstance(cfg.get("rooms"), dict) else {}
        room_cfg = rooms.get(room_name, {}) if isinstance(rooms.get(room_name), dict) else {}
        write_ops = collect_changed_leaf_writes(["market", "rooms", room_name], room_cfg, patch)
        if not write_ops and not delete_paths:
            self.status_var.set("No market room changes to apply.")
            return
        self._run_memory_updates(write_ops, delete_paths, target="market-memory")

    def _run_labs_room_action(self, mode):
        try:
            room_name = self._normalize_room_input(self.labs_room_var.get())
        except ValueError as exc:
            messagebox.showerror("Labs control", str(exc))
            return
        room_json = json.dumps(room_name, ensure_ascii=True)
        if mode is None:
            self._run_labs_command(f"lab(\"room\", {room_json})")
            return
        mode_json = json.dumps(mode, ensure_ascii=True)
        self._run_labs_command(f"lab(\"room\", {room_json}, {mode_json})")

    def _run_labs_command_with_room(self, command_name):
        try:
            room_name = self._normalize_room_input(self.labs_room_var.get())
        except ValueError as exc:
            messagebox.showerror("Labs control", str(exc))
            return
        room_json = json.dumps(room_name, ensure_ascii=True)
        self._run_labs_command(f"lab(\"{command_name}\", {room_json})")

    def _run_labs_react(self):
        a = (self.labs_reagent_a_var.get() or "").strip()
        b = (self.labs_reagent_b_var.get() or "").strip()
        if not a or not b:
            messagebox.showerror("Labs control", "Reagent A and Reagent B are required.")
            return
        a_json = json.dumps(a, ensure_ascii=True)
        b_json = json.dumps(b, ensure_ascii=True)
        self._run_labs_command(f"lab(\"react\", {a_json}, {b_json})")

    def _run_labs_reverse(self):
        product = (self.labs_reverse_product_var.get() or "").strip()
        if not product:
            messagebox.showerror("Labs control", "Reverse product is required.")
            return
        product_json = json.dumps(product, ensure_ascii=True)
        self._run_labs_command(f"lab(\"reverse\", {product_json})")

    def _build_labs_patch_from_form(self):
        patch = {
            "enabled": bool(self.labs_form_enabled_var.get()),
            "mode": (self.labs_form_mode_var.get() or "react").strip(),
            "cleanupIdle": bool(self.labs_form_cleanup_idle_var.get()),
            "debug": bool(self.labs_form_debug_var.get()),
        }
        numeric_map = [
            ("runEvery", self.labs_form_run_every_var.get(), False),
            ("transferPriority", self.labs_form_transfer_priority_var.get(), False),
            ("inputTarget", self.labs_form_input_target_var.get(), False),
            ("boostTarget", self.labs_form_boost_target_var.get(), False),
            ("maxReactionsPerTick", self.labs_form_max_reactions_var.get(), False),
        ]
        for key, raw, allow_float in numeric_map:
            value = self._parse_number_or_empty(raw, key, allow_float=allow_float)
            if value is not None:
                patch[key] = value

        reaction = {}
        ra = (self.labs_form_reagent_a_var.get() or "").strip()
        rb = (self.labs_form_reagent_b_var.get() or "").strip()
        if ra:
            reaction["reagentA"] = ra
        if rb:
            reaction["reagentB"] = rb
        if reaction:
            patch["reaction"] = reaction

        reverse = self._read_text_widget_json(self.labs_form_reverse_text, "reverse")
        rev_product = (self.labs_form_reverse_product_var.get() or "").strip()
        if rev_product:
            reverse["product"] = rev_product
        if reverse:
            patch["reverse"] = reverse

        boosts = self._read_text_widget_json(self.labs_form_boosts_text, "boosts")
        patch["boosts"] = boosts

        input_labs = [x.strip() for x in (self.labs_form_input_labs_var.get() or "").split(",") if x.strip()]
        output_labs = [x.strip() for x in (self.labs_form_output_labs_var.get() or "").split(",") if x.strip()]
        if input_labs:
            patch["inputLabs"] = input_labs
        if output_labs:
            patch["outputLabs"] = output_labs
        return patch

    def _load_labs_form_from_global(self):
        self._load_labs_form(None)

    def _load_labs_form_from_room_entry(self):
        try:
            room_name = self._normalize_room_input(self.labs_room_var.get())
        except ValueError as exc:
            messagebox.showerror("Labs form", str(exc))
            return
        self._load_labs_form(room_name)

    def _apply_labs_global_form(self):
        try:
            patch = self._build_labs_patch_from_form()
        except ValueError as exc:
            messagebox.showerror("Labs form", str(exc))
            return
        self._run_memory_patch(["labs"], patch, target="labs-memory")

    def _apply_labs_room_form(self):
        try:
            room_name = self._normalize_room_input(self.labs_room_var.get())
            patch = self._build_labs_patch_from_form()
        except ValueError as exc:
            messagebox.showerror("Labs form", str(exc))
            return
        self._run_memory_patch(["labs", "rooms", room_name], patch, target="labs-memory")

    def _collect_settings(self):
        return {
            "server_url": self.server_var.get().strip(),
            "token": self.token_var.get().strip(),
            "shard": self.shard_var.get().strip(),
            "memory_path": self.path_var.get().strip(),
            "interval": self.interval_var.get().strip() or "5",
        }

    def _validate_settings(self, settings):
        if not settings["server_url"]:
            raise ValueError("Server URL is required.")
        if not settings["token"]:
            raise ValueError("Auth token is required.")
        try:
            interval = float(settings["interval"])
        except ValueError as exc:
            raise ValueError("Refresh must be a number.") from exc
        if interval < 1:
            raise ValueError("Refresh must be at least 1 second.")

    def _start_polling(self):
        settings = self._collect_settings()
        settings = self._resolve_token_for_settings(settings)
        try:
            self._validate_settings(settings)
        except ValueError as exc:
            messagebox.showerror("Invalid settings", str(exc))
            return
        self.status_var.set("Polling...")
        self.poller.start(settings)

    def _stop_polling(self):
        self.poller.stop()
        self.status_var.set("Stopped")

    def _pull_once(self, status_text="Pulling once..."):
        settings = self._collect_settings()
        settings = self._resolve_token_for_settings(settings)
        try:
            self._validate_settings(settings)
        except ValueError as exc:
            messagebox.showerror("Invalid settings", str(exc))
            return

        def one_shot():
            try:
                client = ScreepsApiClient(
                    base_url=settings["server_url"],
                    token=settings["token"],
                    timeout=10,
                )
                snapshot = self.poller._fetch_snapshot(client, settings)
                self.queue.put(("snapshot", snapshot))
            except Exception as exc:  # noqa: BLE001
                self.queue.put(("error", str(exc)))

        threading.Thread(target=one_shot, daemon=True).start()
        self.status_var.set(status_text)

    def _save_config(self):
        settings = self._collect_settings()
        try:
            CONFIG_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")
            self.status_var.set(f"Config saved: {CONFIG_PATH.name}")
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("Save failed", str(exc))

    def _load_config(self, silent=False):
        if not CONFIG_PATH.exists():
            if not silent:
                messagebox.showinfo("Config", "No saved config file found.")
            return
        try:
            settings = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("Load failed", str(exc))
            return

        self.server_var.set(settings.get("server_url", self.server_var.get()))
        self.token_var.set(settings.get("token", self.token_var.get()))
        self.shard_var.set(settings.get("shard", self.shard_var.get()))
        self.path_var.set(settings.get("memory_path", self.path_var.get()))
        self.interval_var.set(str(settings.get("interval", self.interval_var.get())))
        self.status_var.set(f"Config loaded: {CONFIG_PATH.name}")
        self._autofill_token_from_screeps_config()

    def _drain_queue(self):
        try:
            while True:
                try:
                    kind, payload = self.queue.get_nowait()
                except queue.Empty:
                    break
                try:
                    if kind == "snapshot":
                        self._apply_snapshot(payload)
                    elif kind == "error":
                        self.status_var.set(f"Error: {payload}")
                    elif kind == "console":
                        target = payload.get("target", "console")
                        expression = payload.get("expression", "")
                        result = payload.get("result", {})
                        line = f"[{datetime.now().strftime('%H:%M:%S')}] {expression}\n{json.dumps(result, ensure_ascii=True, default=str)}"
                        if str(target).startswith("market"):
                            self._append_log(self.market_cmd_log, line)
                        else:
                            self._append_log(self.labs_cmd_log, line)
                        if str(target) == "market-memory":
                            cmd_ok = result.get("ok") if isinstance(result, dict) and isinstance(result.get("ok"), bool) else None
                            if cmd_ok is False:
                                self.status_var.set("Market memory command rejected.")
                            else:
                                self.status_var.set("Market memory command accepted. Waiting for memory propagation...")
                                self._schedule_market_memory_sync()
                        else:
                            self.status_var.set(f"Command sent ({target})")
                            self._pull_once()
                    elif kind == "console_error":
                        target = payload.get("target", "console")
                        expression = payload.get("expression", "")
                        err = payload.get("error", "unknown error")
                        line = f"[{datetime.now().strftime('%H:%M:%S')}] {expression}\nERROR: {err}"
                        if str(target).startswith("market"):
                            self._append_log(self.market_cmd_log, line)
                        else:
                            self._append_log(self.labs_cmd_log, line)
                        self.status_var.set(f"Command failed ({target})")
                except Exception as exc:  # noqa: BLE001
                    self.status_var.set(f"UI update error: {exc}")
                    print(traceback.format_exc())
        finally:
            self.after(250, self._drain_queue)

    def _apply_snapshot(self, snapshot):
        profile = snapshot.get("profile", {})
        game_time = snapshot.get("game_time", {})
        memory_obj = snapshot.get("memory")
        room_rows = snapshot.get("room_rows", [])
        creep_metrics = snapshot.get("creep_metrics", {})
        creep_role_rows = creep_metrics.get("role_rows", [])
        market_rows = snapshot.get("market_rows", [])
        market_details = snapshot.get("market_details", {})
        market_config = snapshot.get("market_config", {})
        labs_rows = snapshot.get("labs_rows", [])
        labs_config = snapshot.get("labs_config", {})
        errors = snapshot.get("errors", [])
        _debug_log(
            "ui.snapshot.apply",
            errors=len(errors),
            room_rows=len(room_rows),
            market_rows=len(market_rows),
            market_details=len(market_details) if isinstance(market_details, dict) else -1,
            market_rooms=len(market_config.get("rooms", {})) if isinstance(market_config, dict) and isinstance(market_config.get("rooms"), dict) else -1,
        )

        if errors:
            self.status_var.set(f"Partial data ({len(errors)} issue(s))")
        elif not room_rows:
            self.status_var.set("Connected (no room rows for selected memory path)")
        else:
            self.status_var.set("Connected")
        self.updated_var.set(snapshot.get("fetched_at", "-"))
        self.user_var.set(profile.get("username") or profile.get("user", {}).get("username") or "-")
        self.tick_var.set(str(game_time.get("time", game_time.get("tick", "-"))))
        self.creeps_var.set(str(creep_metrics.get("total", 0)))

        self.rooms_tree.delete(*self.rooms_tree.get_children())
        for row in room_rows:
            self.rooms_tree.insert(
                "",
                tk.END,
                values=(
                    row.get("room", ""),
                    row.get("phase", ""),
                    row.get("policy_state", ""),
                    row.get("combat_state", ""),
                    row.get("spawn_tickets", ""),
                    row.get("remote_enabled", ""),
                    row.get("market_enabled", ""),
                ),
            )

        self.creeps_tree.delete(*self.creeps_tree.get_children())
        for row in creep_role_rows:
            self.creeps_tree.insert(
                "",
                tk.END,
                values=(
                    row.get("role", ""),
                    row.get("count", 0),
                ),
            )

        self.market_tree.delete(*self.market_tree.get_children())
        self.market_details_by_room = market_details if isinstance(market_details, dict) else {}
        self.market_config_snapshot = market_config if isinstance(market_config, dict) else {"globalEnabled": False, "rooms": {}}
        self._rebuild_market_resource_table_from_snapshot()
        for row in market_rows:
            self.market_tree.insert(
                "",
                tk.END,
                values=(
                    row.get("room", ""),
                    row.get("global_enabled", ""),
                    row.get("enabled", ""),
                    row.get("run_every", ""),
                    row.get("min_credits", ""),
                    row.get("energy_reserve", ""),
                    row.get("terminal_target", ""),
                    row.get("terminal_max", ""),
                    row.get("max_deals", ""),
                    row.get("energy_value", ""),
                    row.get("max_overpay_pct", ""),
                    row.get("sell_buffer_pct", ""),
                    row.get("buy_specs", 0),
                    row.get("sell_specs", 0),
                    row.get("terminal_targets", 0),
                    row.get("room_targets", 0),
                ),
            )
        self._refresh_market_details_from_selection()
        if (self.market_room_var.get() or "").strip():
            self._load_market_form((self.market_room_var.get() or "").strip().upper())
        else:
            self.market_form_global_enabled_var.set(bool(self.market_config_snapshot.get("globalEnabled", False)))
        self.after_idle(self._debug_log_market_layout_state)

        self.labs_tree.delete(*self.labs_tree.get_children())
        self.labs_config_snapshot = labs_config if isinstance(labs_config, dict) else {}
        for row in labs_rows:
            self.labs_tree.insert(
                "",
                tk.END,
                values=(
                    row.get("enabled", ""),
                    row.get("run_every", ""),
                    row.get("mode", ""),
                    row.get("transfer_priority", ""),
                    row.get("input_target", ""),
                    row.get("reagent_a", ""),
                    row.get("reagent_b", ""),
                    row.get("rooms", ""),
                ),
            )
        if (self.labs_room_var.get() or "").strip():
            self._load_labs_form((self.labs_room_var.get() or "").strip().upper())
        else:
            self._load_labs_form(None)

        self.raw_json.delete("1.0", tk.END)
        self.raw_json.insert("1.0", json.dumps(memory_obj, indent=2, ensure_ascii=True, default=str))

    def _debug_log_market_layout_state(self):
        if not DEBUG_ENABLED:
            return
        try:
            notebook = self.market_resource_notebook
            tabs = notebook.tabs() if notebook is not None else []
            selected = notebook.select() if notebook is not None and tabs else ""
            _debug_log(
                "ui.market_layout",
                root_size=f"{self.winfo_width()}x{self.winfo_height()}",
                notebook_exists=bool(notebook),
                notebook_size=f"{notebook.winfo_width()}x{notebook.winfo_height()}" if notebook is not None else "0x0",
                notebook_mapped=bool(notebook.winfo_ismapped()) if notebook is not None else False,
                tab_count=len(tabs),
                selected_tab=selected,
            )
        except Exception as exc:  # noqa: BLE001
            _debug_log("ui.market_layout.error", error=str(exc))

    def report_callback_exception(self, exc, val, tb):  # noqa: N802
        trace = "".join(traceback.format_exception(exc, val, tb))
        _debug_log("ui.callback.exception", error=str(val), traceback=trace)
        print(trace, flush=True)
        try:
            self.status_var.set(f"UI callback error: {val}")
        except Exception:
            pass

    def _on_market_row_selected(self, _event=None):
        selected = self.market_tree.selection()
        if selected:
            values = self.market_tree.item(selected[0], "values")
            if values:
                room_name = (values[0] or "").strip()
                if room_name:
                    self.market_room_var.set(room_name)
                    if not (self.market_send_from_var.get() or "").strip():
                        self.market_send_from_var.set(room_name)
                    self._load_market_form(room_name)
        self._refresh_market_details_from_selection()

    def _refresh_market_details_from_selection(self):
        selected = self.market_tree.selection()
        room_name = ""
        if selected:
            values = self.market_tree.item(selected[0], "values")
            if values:
                room_name = values[0]

        text = self.market_details_by_room.get(room_name) if room_name else None
        if not text:
            text = "Select a market room row to view buy/sell/stock-target details."

        self.market_details_text.configure(state=tk.NORMAL)
        self.market_details_text.delete("1.0", tk.END)
        self.market_details_text.insert("1.0", text)
        self.market_details_text.configure(state=tk.DISABLED)

    def _on_close(self):
        self.poller.stop()
        self.destroy()


def main():
    app = DashboardApp()
    app.mainloop()


if __name__ == "__main__":
    main()
