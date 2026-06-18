async function getServer(server) {
    try {
        // --- ADAPTIVE NETWORK TOGGLE ---
        // Automatically checks if your environment is set to local OR if your config IP says 'localhost'
        let isLocal = process.env.NODE_ENV === 'local' || server.ip.includes("localhost") || server.ip.includes("127.0.0.1");

        if (isLocal) {
            // LOCAL MODE: Safe memory lookup
            let portMatch = server.ip.match(/:(\d+)/);
            let currentWorkerPort = portMatch ? parseInt(portMatch[1]) : 4001;
            
            let matchedConfig = Config.servers.find(s => s.port === currentWorkerPort);
            if (!matchedConfig) return false;

            // --- NEW: CLEAN CLEAN NAME TRANSLATION ---
            let rawMode = matchedConfig.gamemode[0]; // e.g. 'siege_blitz'
            let cleanNames = {
                'tdm': 'TDM',
                'siege_blitz': 'Siege Blitz',
                'nexus': 'Nexus',
                'sandbox': 'Sandbox'
            };
            
            // Fallback to capitalizing the raw string if you create a new mode later
            let displayName = cleanNames[rawMode] || rawMode.toUpperCase();
            // ----------------------------------------

            return {
                name: displayName, // Now passes "Siege Blitz" instead of "SIEGE_BLITZ"
                players: 0, 
                ip: server.ip,
                destination: `http://${server.ip}`
            };
        }
    } catch (e) {
        console.error("[ServerTravel] getServer error:", e);
        return false;
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
        this.body.name = this.name;
        
        // Safety check to ensure settings object exists before assigning to it
        if (!this.body.settings) this.body.settings = {};
        
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
        try {
            let spawnChance = Math.random() < 1 / this.spawnChance;
            if (!spawnChance) return;

            let server = await getServer(this.self);
            if (!server) return;

            // Duplicate checks
            if (serverTravelHandler.pendingPortalSpawns.has(server.destination)) return; 
            let entitiesList = global.entities ? Object.values(global.entities) : [];
            let duplicateExists = entitiesList.some(e => e && e.isPortal && e.settings && e.settings.destination === server.destination);
            if (duplicateExists) return; 

            // Mark as pending
            serverTravelHandler.pendingPortalSpawns.add(server.destination);

            let spawnLocation;
            let portalProps = this.self.portal_properties || {};
            let roomDataFile = portalProps.roomData; 
            let targetLocation = portalProps.location;

            if (roomDataFile && targetLocation) {
                try {
                    let grid = require(`../roomSetup/rooms/${roomDataFile}.js`);
                    let validSpots = [];

                    for (let row = 0; row < grid.length; row++) {
                        for (let col = 0; col < grid[row].length; col++) {
                            let tile = grid[row][col];
                            if (tile === targetLocation || (tile && tile.id === targetLocation)) {
                                validSpots.push({ col, row });
                            }
                        }
                    }

                    if (validSpots.length > 0) {
                        let spot = validSpots[Math.floor(Math.random() * validSpots.length)];
                        let tileW = Config.map_tile_width || 420;
                        let tileH = Config.map_tile_height || 420;
                        let room = global.gameManager.room;
                        
                        let leftEdge = typeof room.x !== 'undefined' ? room.x : -(grid[0].length * tileW) / 2;
                        let topEdge = typeof room.y !== 'undefined' ? room.y : -(grid.length * tileH) / 2;

                        let jitterX = (Math.random() - 0.5) * (tileW * 0.8);
                        let jitterY = (Math.random() - 0.5) * (tileH * 0.8);

                        spawnLocation = {
                            x: leftEdge + (spot.col * tileW) + (tileW / 2) + jitterX,
                            y: topEdge + (spot.row * tileH) + (tileH / 2) + jitterY
                        };
                    }
                } catch (err) {
                    console.error(`[Server Travel] Map scanner failed on ${roomDataFile}.js:`, err);
                }
            }

            // Fallback
            if (!spawnLocation) {
                spawnLocation = global.gameManager.room.random();
            }

            let portal = new Portal(server.name, server.players, server.destination, server.ip);
            let portalLifespan = 30000; 
            
            portal.spawn(spawnLocation, this.color, portalLifespan);

            // Successfully spawned, queue the cleanup
            setTimeout(() => {
                serverTravelHandler.pendingPortalSpawns.delete(server.destination);
            }, portalLifespan);

        } catch (fatalError) {
            console.error("[Server Travel] Fatal Spawn Error:", fatalError);
            // FAILSAFE: Force clear the tracker if a crash occurred so the room isn't permanently locked
            if (this.self && this.self.ip) {
                serverTravelHandler.pendingPortalSpawns.forEach(dest => {
                    if (dest.includes(this.self.ip)) serverTravelHandler.pendingPortalSpawns.delete(dest);
                });
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