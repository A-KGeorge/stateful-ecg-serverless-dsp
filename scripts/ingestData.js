/**
 * ECG Data Ingestion Script
 *
 * Simulates live ECG sensor by:
 * 1. Loading MIT-BIH dataset from Kaggle
 * 2. Batching signal into 1-second chunks
 * 3. Queuing chunks for worker processing
 *
 * Usage:
 *   npm run ingest -- --file data/100_.csv --sensor patient-001
 */

import { readFileSync } from "fs";
import { v4 as uuidv4 } from "uuid";
import { queueEcgJob } from "../lib/redisStore.js";

const SAMPLE_RATE = 360; // Hz (MIT-BIH standard)
const CHUNK_DURATION = 1; // seconds
const CHUNK_SIZE = SAMPLE_RATE * CHUNK_DURATION; // 360 samples per chunk

/**
 * Parse MIT-BIH CSV file
 * Format: ,MLII,V5,symbol (header row)
 * @param {string} filePath - Path to CSV file
 * @returns {Object} Parsed ECG data
 */
function parseEcgFile(filePath) {
  console.log(`📊 Loading ECG data from: ${filePath}`);

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").slice(1); // Skip header

  const timestamps = [];
  const mlii = []; // Lead II (most common for rhythm analysis)

  for (const line of lines) {
    if (!line.trim()) continue;

    // CSV format: index,MLII,V5,symbol
    const parts = line.split(",");
    if (parts.length < 2) continue;

    const index = parseFloat(parts[0]);
    const mliiVal = parseFloat(parts[1]);

    if (!isNaN(index) && !isNaN(mliiVal)) {
      timestamps.push(index);
      mlii.push(mliiVal);
    }
  }

  const duration = timestamps.length / SAMPLE_RATE;
  console.log(
    `✓ Loaded ${timestamps.length} samples (${duration.toFixed(1)}s)\n`
  );

  return { timestamps, signal: mlii };
}

/**
 * Ingest signal as chunked jobs
 * @param {number[]} signal - ECG signal array
 * @param {string} sensorId - Sensor identifier
 */
async function ingestSignal(signal, sensorId) {
  const numChunks = Math.floor(signal.length / CHUNK_SIZE);

  console.log(
    `🔄 Batching into ${numChunks} chunks of ${CHUNK_DURATION}s each...`
  );

  let jobsQueued = 0;

  for (let i = 0; i < numChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = start + CHUNK_SIZE;
    const chunk = signal.slice(start, end);

    await queueEcgJob({
      id: uuidv4(),
      sensorId,
      chunkIndex: i,
      samples: new Float32Array(chunk),
    });

    jobsQueued++;

    if (jobsQueued % 10 === 0) {
      console.log(`  Queued ${jobsQueued}/${numChunks} chunks...`);
    }
  }

  console.log(`\n✓ Queued ${jobsQueued} jobs for sensor: ${sensorId}`);
  console.log(`  Estimated processing time: ${numChunks}s`);
}

/**
 * Main ingestion function
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse command line arguments
  let filePath = "data/100_ekg.csv"; // Default MIT-BIH record
  let sensorId = `patient-${Date.now()}`;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) {
      filePath = args[i + 1];
      i++; // Skip next arg since we consumed it
    } else if (args[i] === "--sensor" && args[i + 1]) {
      sensorId = args[i + 1];
      i++; // Skip next arg since we consumed it
    }
  }

  console.log("🏥 ECG Data Ingestion Started");
  console.log(`   Sensor ID: ${sensorId}`);
  console.log(`   Data file: ${filePath}\n`);

  try {
    // Load ECG data
    const { signal } = parseEcgFile(filePath);

    // Ingest signal
    await ingestSignal(signal, sensorId);

    console.log("\n✅ Ingestion complete!");
    console.log("   Monitor worker terminal for processing results.");

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Ingestion failed:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
