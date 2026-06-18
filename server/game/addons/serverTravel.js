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
            // PRODUCTION MODE: Hardcoded Local Loopback
            // DO NOT use the domain name here, it triggers the firewall/timeout seen in image_dff224.png
            let masterPort = 3000; 
            
            // Force the fetch to stay strictly on the local machine (127.0.0.1)
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
            // ... rest of your logic
                
            if (!data) return false;
            
            // Figure out what port this worker is trying to target (e.g., "3001")
            let targetPort = server.ip.split(":")[1];
            
            // Find the correct statistics from the payload array matching that port
            let matchedData = Array.isArray(data) ? data.find(s => s.ip.endsWith(targetPort)) : null;
            let finalData = matchedData || (Array.isArray(data) ? data[0] : data);

            return {
                name: (finalData.gameMode || "Game Room").trim(),
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
                // Duplicate prevention
                if (serverTravelHandler.pendingPortalSpawns.has(server.destination)) return;
                
                let entitiesList = global.entities ? Object.values(global.entities) : [];
                if (entitiesList.some(e => e && e.isPortal && e.settings && e.settings.destination === server.destination)) return;

                serverTravelHandler.pendingPortalSpawns.add(server.destination);

                // --- FORCED SPAWN LOGIC ---
                // Skip the tile filter and force a valid room coordinate
                let portal = new Portal(server.name, server.players, server.destination, server.ip);
                let portalLifespan = 20000;
                
                // Force spawn at a random location within the room
                portal.spawn(global.gameManager.room.random(), this.color, portalLifespan);

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