const roleUniversal = require('role_role.universal');

/**
 * Empire universal executor role.
 *
 * Intent:
 * - Keep empire creep behavior explicit via dedicated role id.
 * - Reuse the stable universal task executor for now.
 * - Allow future divergence without touching room-level role runner.
 */
module.exports = {
    run: function(creep) {
        return roleUniversal.run(creep);
    }
};

