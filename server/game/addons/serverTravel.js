async function getServer(server) {
    try {
        // Automatically check the environment variable OR the string itself
        let isLocal = process.env.NODE_ENV === 'local' || server.ip.includes("localhost") || server.ip.includes("127.0.0.1");

        if (isLocal) {
            // LOCAL MODE: Safe in-memory lookup (bypasses port 443 and fetch errors)
            let portMatch = server.ip.match(/:(\d+)/);
            let currentWorkerPort = portMatch ? parseInt(portMatch[1]) : 4001;
            
            let matchedConfig = Config.servers.find(s => s.port === currentWorkerPort);
            if (!matchedConfig) return false;

            return {
                name: matchedConfig.gamemode[0].toUpperCase(),
                players: 0, 
                ip: server.ip,
                destination: `http://${server.ip}` // Forces standard local http:// routing
            };
        } else {
            // PRODUCTION MODE: Secure network fetch for live rearras.dev players
            let data = await fetch(`https://${server.ip}/portalPermission`).then(r => r.json()).catch(() => false);
            if (!data) return false;
            data = data[0];

            return {
                name: (data.gameMode || "Game Room").trim(),
                players: data.players || 0,
                ip: server.ip,
                destination: `https://${data.ip}` // Forces secure wss:// routing over port 443
            };
        }
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
                // Duplicate prevention checks
                if (serverTravelHandler.pendingPortalSpawns.has(server.destination)) return; 
                let entitiesList = global.entities ? Object.values(global.entities) : [];
                let duplicateExists = entitiesList.some(e => e && e.isPortal && e.settings && e.settings.destination === server.destination);
                if (duplicateExists) return; 

                serverTravelHandler.pendingPortalSpawns.add(server.destination);

                // --- NEW: DYNAMIC ROOM TILE LOOKUP ---
                let spawnLocation;
                let portalProps = this.self.portal_properties || {};
                let roomDataFile = portalProps.roomData; // e.g., 'room_nexus'
                let targetLocation = portalProps.location; // e.g., 'prt1'

                if (roomDataFile && targetLocation) {
                    try {
                        // Dynamically load the specific room grid map file 
                        let grid = require(`../roomSetup/rooms/${roomDataFile}.js`);
                        let validSpots = [];

                        // Scan the entire 2D array for tiles that match your 'prt' tag
                        for (let row = 0; row < grid.length; row++) {
                            for (let col = 0; col < grid[row].length; col++) {
                                let tile = grid[row][col];
                                if (tile === targetLocation || (tile && tile.id === targetLocation)) {
                                    validSpots.push({ col, row });
                                }
                            }
                        }

                        if (validSpots.length > 0) {
                            // Pick a random grid cell from the valid pool
                            let spot = validSpots[Math.floor(Math.random() * validSpots.length)];
                            
                            // Map the array columns/rows to physical engine coordinates
                            let tileW = Config.map_tile_width || 420;
                            let tileH = Config.map_tile_height || 420;
                            let room = global.gameManager.room;
                            
                            // Account for variable Arras zero-point origins
                            let leftEdge = typeof room.x !== 'undefined' ? room.x : -(grid[0].length * tileW) / 2;
                            let topEdge = typeof room.y !== 'undefined' ? room.y : -(grid.length * tileH) / 2;

                            // Add minor jitter so portals don't stack mathematically perfectly in the dead center every time
                            let jitterX = (Math.random() - 0.5) * (tileW * 0.8);
                            let jitterY = (Math.random() - 0.5) * (tileH * 0.8);

                            spawnLocation = {
                                x: leftEdge + (spot.col * tileW) + (tileW / 2) + jitterX,
                                y: topEdge + (spot.row * tileH) + (tileH / 2) + jitterY
                            };
                        }
                    } catch (err) {
                        console.error(`[Server Travel] Could not load ${roomDataFile}.js to scan for ${targetLocation}.`);
                    }
                }

                // Fallback to pure random ONLY if the file scan failed or you didn't configure a region
                if (!spawnLocation) {
                    spawnLocation = global.gameManager.room.random();
                }
                // -------------------------------------

                let portal = new Portal(server.name, server.players, server.destination, server.ip);
                let portalLifespan = 30000; // Despawns after 30 seconds
                
                portal.spawn(spawnLocation, this.color, portalLifespan);

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