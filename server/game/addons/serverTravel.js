async function getServer(server) {
    try {
        if (!server || !server.ip || !server.ip.includes(":")) {
            return false; // Skip if it's a placeholder IP
        }

        // --- ADAPTIVE NETWORK TOGGLE ---
        let isLocal = process.env.NODE_ENV === 'local' || server.ip.includes("localhost") || server.ip.includes("127.0.0.1");

        if (isLocal) {
            // LOCAL MODE: Safe memory lookup
            let currentWorkerPort = parseInt(server.ip.split(":")[1]);
            let matchedConfig = Config.servers.find(s => s.port === currentWorkerPort);
            if (!matchedConfig) return false;

            // Clean Name Translation for the portal hover labels
            let rawMode = matchedConfig.gamemode[0];
            let cleanNames = {
                'tdm': 'TDM',
                'siege_blitz': 'Siege Blitz',
                'nexus': 'Nexus',
                'sandbox': 'Sandbox'
            };
            let displayName = cleanNames[rawMode] || rawMode.toUpperCase();

            return {
                name: displayName,
                players: 0, 
                ip: server.ip,
                destination: `http://${server.ip}` // Force local unencrypted connection
            };
            } else {
            // --- PRODUCTION MODE: Internal VPS Fetch ---
            let masterPort = 3000; 
            
            let data = await fetch(`http://127.0.0.1:${masterPort}/portalPermission`)
                .then(async (res) => {
                    let text = await res.text();
                    try {
                        return JSON.parse(text);
                    } catch {
                        console.warn("[Server Travel] Server responded with raw text:", text);
                        return false;
                    }
                })
                .catch((err) => {
                    console.error("[Server Travel] VPS Internal Fetch Failed:", err.message);
                    return false;
                });
                
            if (!data) return false;
            
            // Fix: Calculate the internal port offset (e.g., Target 3002 -> Internal 4002)
            let targetPort = parseInt(server.ip.split(":")[1]);
            let internalPort = targetPort + 1000; 
            
            // Find the statistics matching the calculated internal port
            let matchedData = Array.isArray(data) ? data.find(s => s.ip.endsWith(`:${internalPort}`)) : null;
            let finalData = matchedData || (Array.isArray(data) ? data[0] : data);

            // Re-apply the clean names dictionary for production
            let rawMode = finalData.gameMode ? finalData.gameMode.toLowerCase().replace(/\s+/g, '_') : 'tdm';
            let cleanNames = {
                'tdm': 'TDM',
                'siege_blitz': 'Siege Blitz',
                'nexus': 'Nexus',
                'sandbox': 'Sandbox'
            };
            let displayName = cleanNames[rawMode] || (finalData.gameMode || "Game Room");

            return {
                name: displayName,
                players: finalData.players || 0,
                ip: server.ip,
                destination: `https://${server.ip}` // Passes secure HTTPS route to the player's browser
            };
        }
    } catch (e) {
        console.error("[Server Travel] getServer failed:", e);
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

            serverTravelHandler.pendingPortalSpawns.add(server.destination);

            let spawnLocation;
            let portalProps = this.self.portal_properties || {};
            let roomDataFile = portalProps.roomData; 
            let targetLocation = portalProps.location;

            // --- STRICT ENFORCEMENT: ONLY SPAWN IF ROOM DATA IS FOUND ---
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
                    } else {
                        // Logic: If user requested a room but we found 0 spots, do NOT spawn randomly
                        console.warn(`[Server Travel] Requested ${targetLocation} in ${roomDataFile}, but no tiles were found.`);
                        serverTravelHandler.pendingPortalSpawns.delete(server.destination);
                        return; // Abort the spawn entirely
                    }
                } catch (err) {
                    console.error(`[Server Travel] Map scanner failed on ${roomDataFile}.js:`, err);
                    serverTravelHandler.pendingPortalSpawns.delete(server.destination);
                    return; // Abort on file error
                }
            } else {
                // Only use pure random if no specific room/location was requested
                spawnLocation = global.gameManager.room.random();
            }

            let portal = new Portal(server.name, server.players, server.destination, server.ip);
            let portalLifespan = 30000; 
            
            portal.spawn(spawnLocation, this.color, portalLifespan);

            setTimeout(() => {
                serverTravelHandler.pendingPortalSpawns.delete(server.destination);
            }, portalLifespan);

        } catch (fatalError) {
            console.error("[Server Travel] Fatal Spawn Error:", fatalError);
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