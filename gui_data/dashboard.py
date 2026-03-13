import json
import queue
import re
import threading
import time
import base64
import gzip
from datetime import datetime
from pathlib import Path
from urllib import error, parse, request

import tkinter as tk
from tkinter import messagebox, ttk
from tkinter.scrolledtext import ScrolledText


CONFIG_PATH = Path(__file__).with_name("dashboard_config.json")
ROOM_NAME_RE = re.compile(r"^[WE]\d+[NS]\d+$")


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

    def _request_json(self, api_path, params=None):
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
        req = request.Request(url, method="GET", headers=headers)
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


def _looks_like_room_name(value):
    return isinstance(value, str) and bool(ROOM_NAME_RE.match(value))


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
        op_state = ""
        economy_state = ""
        admiral_state = ""
        if isinstance(room_mem, dict):
            overseer = room_mem.get("overseer", {})
            if isinstance(overseer, dict):
                op_state = overseer.get("opState", room_mem.get("_opState", ""))
                economy_state = overseer.get("economyState", "")
            admiral = room_mem.get("admiral", {})
            if isinstance(admiral, dict):
                admiral_state = admiral.get("state", "")
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
                "op_state": op_state,
                "economy_state": economy_state,
                "admiral_state": admiral_state,
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
                return fallback

        profile = safe_call(client.get_profile, {})
        game_time = safe_call(lambda: client.get_game_time(shard=shard), {})
        memory_obj = safe_call(lambda: client.get_memory(memory_path=memory_path, shard=shard), {})

        return {
            "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "profile": profile,
            "game_time": game_time,
            "memory": memory_obj,
            "room_rows": build_room_rows(memory_obj, memory_path=memory_path),
            "creep_metrics": build_creep_metrics(memory_obj),
            "market_rows": build_market_rows(memory_obj),
            "market_details": build_market_details(memory_obj),
            "labs_rows": build_labs_rows(memory_obj),
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

        ttk.Label(left, text="Rooms / States").pack(anchor="w")
        columns = ("room", "op_state", "economy_state", "admiral_state", "spawn_tickets", "remote_enabled", "market_enabled")
        self.rooms_tree = ttk.Treeview(left, columns=columns, show="headings", height=18)
        self.rooms_tree.pack(fill=tk.BOTH, expand=True)
        self.rooms_tree.heading("room", text="Room")
        self.rooms_tree.heading("op_state", text="Op State")
        self.rooms_tree.heading("economy_state", text="Economy")
        self.rooms_tree.heading("admiral_state", text="Admiral")
        self.rooms_tree.heading("spawn_tickets", text="Spawn Tickets")
        self.rooms_tree.heading("remote_enabled", text="Remote")
        self.rooms_tree.heading("market_enabled", text="Market")
        self.rooms_tree.column("room", width=100, anchor="w")
        self.rooms_tree.column("op_state", width=90, anchor="center")
        self.rooms_tree.column("economy_state", width=100, anchor="center")
        self.rooms_tree.column("admiral_state", width=90, anchor="center")
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
        self.market_tree = ttk.Treeview(market_tab, columns=market_cols, show="headings")
        self.market_tree.pack(fill=tk.BOTH, expand=True)
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
        ttk.Label(market_tab, text="Selected Room Market Details").pack(anchor="w", pady=(8, 0))
        self.market_details_text = ScrolledText(market_tab, wrap=tk.NONE, font=("Consolas", 10), height=14)
        self.market_details_text.pack(fill=tk.BOTH, expand=True)
        self.market_details_text.insert("1.0", "Select a market room row to view buy/sell/stock-target details.")
        self.market_details_text.configure(state=tk.DISABLED)

        labs_cols = ("enabled", "run_every", "mode", "transfer_priority", "input_target", "reagent_a", "reagent_b", "rooms")
        self.labs_tree = ttk.Treeview(labs_tab, columns=labs_cols, show="headings", height=3)
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

        ttk.Label(raw_tab, text="Raw Memory JSON").pack(anchor="w")
        self.raw_json = ScrolledText(raw_tab, wrap=tk.NONE, font=("Consolas", 10))
        self.raw_json.pack(fill=tk.BOTH, expand=True)

    def _summary_item(self, parent, label, var, column):
        frame = ttk.Frame(parent, padding=(6, 4))
        frame.grid(row=0, column=column, sticky="nsew")
        ttk.Label(frame, text=label).pack(anchor="w")
        ttk.Label(frame, textvariable=var, font=("Segoe UI", 10, "bold")).pack(anchor="w")

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

    def _pull_once(self):
        settings = self._collect_settings()
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
        self.status_var.set("Pulling once...")

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

    def _drain_queue(self):
        while True:
            try:
                kind, payload = self.queue.get_nowait()
            except queue.Empty:
                break
            if kind == "snapshot":
                self._apply_snapshot(payload)
            elif kind == "error":
                self.status_var.set(f"Error: {payload}")
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
        labs_rows = snapshot.get("labs_rows", [])
        errors = snapshot.get("errors", [])

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
                    row.get("op_state", ""),
                    row.get("economy_state", ""),
                    row.get("admiral_state", ""),
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

        self.labs_tree.delete(*self.labs_tree.get_children())
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

        self.raw_json.delete("1.0", tk.END)
        self.raw_json.insert("1.0", json.dumps(memory_obj, indent=2, ensure_ascii=True, default=str))

    def _on_market_row_selected(self, _event=None):
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
