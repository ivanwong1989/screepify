// Type declarations for the type checker only (never bundled).

// The Screeps runtime provides these, but @types/screeps doesn't declare them.
declare var global: any;
declare var console: { log(...args: any[]): void };
declare var require: (id: string) => any;
declare var module: { exports: any };

// v2 Memory schema (DESIGN §7).
interface Memory {
    /** Schema version (kernel/memory.js). */
    v?: number;
    /** Console config overrides (config.js). */
    config?: Record<string, any>;
}

interface RoomMemory {
    /** Room kind (DESIGN §18.1). */
    k?: import('../contracts/ctx').RoomKind;
}

interface CreepMemory {
    /** Archetype / body class (miner, hauler, worker, ...). */
    a?: string;
    /** Spawn binding key (slot key or mission id). */
    b?: string;
    /** Task state: 'init' | 'gathering' | 'working' | 'idle'. */
    s?: string;
    /** Mission id (DESIGN §9). */
    m?: string;
    /** Current task (DESIGN §9). */
    t?: import('../contracts/task').Task;
    /** Home room (DESIGN §9). */
    h?: string;
}
