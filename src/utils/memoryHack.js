class MemoryHack {

    static register() {
        MemoryHack.memory = RawMemory._parsed || Memory;
    }

    static runHack() {
        delete global.Memory;
        global.Memory = MemoryHack.memory;
        RawMemory._parsed = MemoryHack.memory;
    }
}

module.exports = MemoryHack;