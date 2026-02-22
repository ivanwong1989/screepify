function annotateRuntime(runtime, data) {
    if (!runtime || !data) return;
    runtime.debug = Object.assign(runtime.debug || {}, data);
}

module.exports = {
    annotateRuntime
};
