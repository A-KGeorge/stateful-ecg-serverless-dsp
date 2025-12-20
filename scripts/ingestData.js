/**
 * ECG Data Ingestion Script
 *
 * Simulates live ECG sensor by:
 * 1. Loading MIT-BIH dataset from Kaggle
 * 2. Batching signal into 1-second chunks
 * 3. Queuing chunks for worker processing
 *
 * Usage:
 *   npm run ingest -- data/100_ekg.csv patient-001
 *   node scripts/ingestData.js data/100_ekg.csv patient-001
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
 * Sleep utility for real-time simulation
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ingest signal as chunked jobs (simulates real-time streaming)
 * @param {number[]} signal - ECG signal array
 * @param {string} sensorId - Sensor identifier
 */
async function ingestSignal(signal, sensorId) {
  const numChunks = Math.floor(signal.length / CHUNK_SIZE);
  const delayMs = CHUNK_DURATION * 1000; // Convert seconds to milliseconds

  console.log(
    `🔄 Streaming ${numChunks} chunks in real-time (${CHUNK_DURATION}s intervals)...`
  );
  console.log(`   This will take approximately ${numChunks} seconds\n`);

  const startTime = Date.now();

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

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `  ⏱️  [${elapsed}s] Streamed chunk ${
        i + 1
      }/${numChunks} (${CHUNK_SIZE} samples)`
    );

    // Wait for chunk duration to simulate real-time data arrival
    // Skip delay on last chunk
    if (i < numChunks - 1) {
      await sleep(delayMs);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ Completed streaming ${numChunks} chunks in ${totalTime}s`);
  console.log(`  Sensor: ${sensorId}`);
}

/**
 * Main ingestion function
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse command line arguments
  let filePath = "data/100_ekg.csv"; // Default MIT-BIH record
  let sensorId = `patient-${Date.now()}`;

  // Use positional arguments: filePath sensorId
  if (args.length >= 1) {
    filePath = args[0];
    // If not absolute path and doesn't start with data/, prepend data/
    if (!filePath.startsWith("/") && !filePath.startsWith("data/")) {
      filePath = `data/${filePath}`;
    }
  }
  if (args.length >= 2) {
    sensorId = args[1];
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
