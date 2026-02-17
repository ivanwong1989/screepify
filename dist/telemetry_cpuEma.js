function tick() {
    // 1. Configuration: How many ticks to average over
    const EMA_WINDOW = 20; // The 'X' ticks

    // 2. Get the CPU used this tick
    const cpuUsed = Game.cpu.getUsed();

    // 3. Initialize memory if it doesn't exist
    if (Memory.avgCpu === undefined) {
        Memory.avgCpu = cpuUsed;
    }

    // 4. Update the Moving Average
    // Formula: (OldAvg * (X-1) + NewValue) / X
    Memory.avgCpu = (Memory.avgCpu * (EMA_WINDOW - 1) + cpuUsed) / EMA_WINDOW;

    // 5. Output to console (optional)
    if (Game.time % 10 === 0) {
        //console.log(`Average CPU over ${EMA_WINDOW} ticks: ${Memory.avgCpu.toFixed(2)}`);
    }
}

module.exports = {
    tick
};
