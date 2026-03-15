const handlers = Object.create(null);

function register(type, handler) {
    if (!type || !handler) return;
    handlers[type] = handler;
}

function get(type) {
    return handlers[type] || null;
}

function getAll() {
    return handlers;
}

module.exports = {
    register,
    get,
    getAll
};

