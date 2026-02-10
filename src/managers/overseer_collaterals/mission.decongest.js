module.exports = {
    generate: function(room, intel, context, missions) {
        const parkingFlags = intel.flags.filter(f => f.name.startsWith('Parking'));
        if (parkingFlags.length === 0) return;

        missions.push({
            name: 'decongest:parking',
            type: 'decongest',
            targetNames: parkingFlags.map(f => f.name),
            priority: 1
        });
    }
};
