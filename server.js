/**
 * WebSocket server for ECG dashboard with Redis Pub/Sub
 * Provides real-time ECG updates via WebSocket connection
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import Redis from "ioredis";
import { getResults } from "./lib/redisStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DEFAULT_SENSOR = "patient-demo";

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Serve dashboard
  if (req.url === "/" || req.url === "/index.html") {
    const htmlPath = path.join(__dirname, "public", "index.html");
    fs.readFile(htmlPath, "utf8", (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error loading dashboard");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }

  // API: Get latest results
  if (req.url === "/api/latest-results") {
    try {
      const sensorId =
        new URL(req.url, `http://${req.headers.host}`).searchParams.get(
          "sensor"
        ) || DEFAULT_SENSOR;

      const results = await getResults(sensorId, 1);

      if (results.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No results yet" }));
        return;
      }

      const latest = results[results.length - 1];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(latest));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // API: Get all results
  if (req.url.startsWith("/api/results")) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const sensorId = url.searchParams.get("sensor") || DEFAULT_SENSOR;
      const limit = parseInt(url.searchParams.get("limit") || "100");

      const results = await getResults(sensorId, limit);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

// WebSocket server for real-time updates
const wss = new WebSocketServer({ server });
const redisSub = new Redis({ host: "localhost", port: 6379 });

// Subscribe to results channel
redisSub.subscribe("ecg:results", (err) => {
  if (err) {
    console.error("Failed to subscribe to Redis channel:", err);
  } else {
    console.log("📡 Subscribed to ecg:results channel");
  }
});

// Broadcast new results to all connected clients
redisSub.on("message", (channel, message) => {
  if (channel === "ecg:results") {
    const result = JSON.parse(message);

    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        // WebSocket.OPEN
        client.send(JSON.stringify(result));
      }
    });
  }
});

// Handle WebSocket connections
wss.on("connection", (ws) => {
  console.log("🔌 Client connected");

  ws.on("close", () => {
    console.log("🔌 Client disconnected");
  });

  // Send initial data on connection
  getResults(DEFAULT_SENSOR, 1)
    .then((results) => {
      if (results.length > 0) {
        ws.send(JSON.stringify(results[results.length - 1]));
      } else {
        ws.send(JSON.stringify({ error: "No results yet" }));
      }
    })
    .catch((err) => {
      console.error("Error fetching initial data:", err);
    });
});

server.listen(PORT, () => {
  console.log(`\n🏥 ECG Monitor Dashboard`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`\n   Showing results for sensor: ${DEFAULT_SENSOR}\n`);
});
