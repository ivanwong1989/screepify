var roleTower = {
    /**
     * @param {StructureTower} tower
     */
    run: function(tower) {
        // Read task assigned by Tasker (ephemeral for this tick)
        const task = tower.room._towerTasks && tower.room._towerTasks[tower.id];
        if (!task) return;

        const target = Game.getObjectById(task.targetId);
        if (!target) return;

        if (task.action === 'attack') tower.attack(target);
        else if (task.action === 'heal') tower.heal(target);
        else if (task.action === 'repair') tower.repair(target);
    }
};

module.exports = roleTower;
