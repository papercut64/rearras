async function getServer(server) {
    try {
        // Extract the port number from the ip string (e.g., "localhost:4001" -> "4001")
        let currentWorkerPort = parseInt(server.ip.split(":")[1]);
        
        // Directly find the local room data right out of your config configuration file
        let matchedConfig = Config.servers.find(s => s.port === currentWorkerPort);
        
        if (!matchedConfig) return false;

        // Instantly return the formatting the portal engine needs, completely bypassing 'fetch'
        return {
            name: matchedConfig.gamemode[0].toUpperCase(), // e.g., "TDM" or "NEXUS"
            players: 0, // Default to 0 for local testing
            ip: server.ip,
            destination: `http://${server.ip}` // Forces standard local http/ws connection
        };
    } catch (e) {
        console.log(e);
    }
}

// Portal spawner class
let Portal = class {
    constructor(name, players, destination, ip) {
        this.name = name;
        this.players = players;
        this.destination = destination;
        this.ip = ip;
        this.body = null;
    }
    spawn(loc, color = "#ffffff", duration) {
        if (loc.data) loc.data.has_portal = true;
        this.body = new Entity(loc.data ? loc.randomInside() : loc);
        this.body.define("serverPortal");
        this.body.isPortal = true;
        this.body.color.base = color;
        this.body.godmode = true;
        this.body.team = -101;
        this.body.isPortal = true;
        this.body.name = this.name;
        this.body.settings.scoreLabel = `${this.players} player${this.players === 1 ? "" : "s"}`;
        this.body.settings.destination = this.destination;
        this.body.allowedOnMinimap = true;
        this.body.alwaysShowOnMinimap = true;
        this.body.minimapColor = 19;
        let updateInterval = setInterval(async () => {
            let data = await getServer({ip: this.ip});
            if (data) {
                this.body.settings.scoreLabel = `${data.players} player${data.players === 1 ? "" : "s"}`;
                this.body.name = data.name;
            }
        }, 5000);
        setTimeout(() => {
            clearInterval(updateInterval);
            this.body.destroy();
            if (loc.data) loc.data.has_portal = false;
        }, duration);
    }
}
class serverTravelHandler {
    // Initialize a static tracking Set directly attached to the class context
    static pendingPortalSpawns = new Set();

    constructor(self, spawnChance, color) {
        this.self = self;
        this.spawnChance = spawnChance;
        this.color = color;
    }
    async spawnRandom() {
        let spawnChance = Math.random() < 1 / this.spawnChance;
        if (spawnChance) {
            let server = await getServer(this.self);
            if (server) {
                // Gate 1: Check the static class-level tracker safely
                if (serverTravelHandler.pendingPortalSpawns.has(server.destination)) {
                    return; // Already spawning this type, abort!
                }

                // Gate 2: Convert the active entity hash-map safely to an array
                let entitiesList = global.entities ? Object.values(global.entities) : [];
                
                // Gate 3: Scan the live map for an active portal matching this destination
                let duplicateExists = entitiesList.some(e => 
                    e && e.isPortal && e.settings && e.settings.destination === server.destination
                );
                
                if (duplicateExists) {
                    return; // Active portal already exists on the map, abort!
                }

                // Mark as pending immediately before running asynchronous spawning code
                serverTravelHandler.pendingPortalSpawns.add(server.destination);

                let tiles = global.gameManager.room.portalTiles ? global.gameManager.room.portalTiles.filter(tile => tile && !tile.data.has_portal) : [];
                if (!tiles.length) tiles = false;
                
                let portal = new Portal(server.name, server.players, server.destination, server.ip);
                
                // Portal lifespan configuration (e.g., 20 seconds)
                let portalLifespan = 20000; 
                
                portal.spawn(tiles ? ran.choose(tiles) : global.gameManager.room.random(), this.color, portalLifespan);

                // Clean up the pending tracker only after the portal lifespan finishes and it despawns
                setTimeout(() => {
                    serverTravelHandler.pendingPortalSpawns.delete(server.destination);
                }, portalLifespan);
            }
        }
    }
}
if (loadedAddons.includes("chatCommands")) {
    addChatCommand({
        command: ["join", "j"],
        description: "Connects you to another server",
        level: 3,
        hidden: true,
        run: ({ args, socket }) => {
            if (!args[0]) {
                socket.talk("m", 5_000, "No server specified.");
                return;
            }
            let server = Config.servers.find(
                s => s.id === args[0]
            );
            if (!server) {
                socket.talk("m", 5_000, "Server not found.");
                return;
            }
            global.gameManager.socketManager.sendToServer(socket, `http://${server.host}`);
        }
    })
}

module.exports = { serverTravelHandler }