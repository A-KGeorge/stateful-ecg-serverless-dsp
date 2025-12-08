/**
 * ECG Worker - Serverless processing worker
 *
 * Simulates a serverless function that:
 * 1. Pulls ECG chunks from a queue
 * 2. Loads previous pipeline state from Redis
 * 3. Processes the chunk
 * 4. Saves new state back to Redis
 * 5. Stores results
 *
 * In production, this would be deployed as:
 * - AWS Lambda triggered by SQS
 * - Google Cloud Function triggered by Pub/Sub
 * - Azure Function triggered by Service Bus
 */

import {
  dequeueEcgJob,
  loadPipelineState,
  savePipelineState,
  saveResult,
  saveMetadata,
  loadMetadata,
  publishResult,
} from "../lib/redisStore.js";
import { processEcgChunk } from "../lib/ecgPipeline.js";
import * as fs from "fs";

/**
 * Process a single ECG job
 * @param {Object} job - ECG processing job
 */
async function processJob(job) {
  const { id, sensorId, chunkIndex, samples } = job;

  console.log(`\n▶ Processing job ${id}`);
  console.log(`  Sensor: ${sensorId}`);
  console.log(`  Chunk: ${chunkIndex} (${samples.length} samples)`);

  fs.appendFileSync(
    "worker.log",
    `\n▶ Processing job ${id} (sensor: ${sensorId}, chunk: ${chunkIndex})\n`
  );

  try {
    // Load previous state (the magic that makes stateful serverless work!)
    const previousState = await loadPipelineState(sensorId);
    const metadata = (await loadMetadata(sensorId)) || {};

    if (previousState) {
      console.log(`  Resuming from saved state (chunk ${chunkIndex})`);
      fs.appendFileSync(
        "worker.log",
        `  Resuming from saved state (chunk ${chunkIndex})\n`
      );
    } else {
      console.log(`  Starting fresh pipeline (first chunk)`);
      fs.appendFileSync(
        "worker.log",
        `  Starting fresh pipeline (first chunk)\n`
      );
    }

    // Process the chunk with state continuity
    const startTime = Date.now();
    const result = await processEcgChunk(samples, previousState, {
      chunkIndex,
      lastPeakSample: metadata.lastPeakSample || null,
      rrHistory: metadata.rrHistory || [],
    });
    const processingTime = Date.now() - startTime;

    // Save new state and metadata for next chunk
    await savePipelineState(sensorId, result.state);
    await saveMetadata(sensorId, {
      lastPeakSample: result.lastPeakSample,
      rrHistory: result.rrHistory,
    });

    // Store results
    const resultData = {
      chunkIndex,
      peaks: result.peaks.length,
      bpm: result.bpm,
      hrv: result.hrv,
      arrhythmia: result.arrhythmia,
      timestamp: Date.now(),
      processingTime,
    };

    await saveResult(sensorId, resultData);

    // Publish to real-time channel with ECG samples for visualization
    await publishResult({
      sensorId,
      ...resultData,
      samples: Array.from(samples.slice(0, 360)), // Send raw ECG samples for waveform
      peakIndices: result.peaks.map((p) => p % 360), // Convert to local indices
    });

    // Log results
    console.log(`  Detected ${result.peaks.length} heartbeats`);
    console.log(`  Heart Rate: ${result.bpm} BPM`);
    console.log(`  HRV: ${result.hrv} ms`);

    fs.appendFileSync(
      "worker.log",
      `  Detected ${result.peaks.length} heartbeats\n` +
        `  Heart Rate: ${result.bpm} BPM\n` +
        `  HRV: ${result.hrv} ms\n`
    );

    if (result.arrhythmia.normal) {
      console.log(`  ✓ Normal sinus rhythm`);
      fs.appendFileSync("worker.log", `  ✓ Normal sinus rhythm\n`);
    } else {
      console.log(`  ⚠ Arrhythmia detected:`);
      result.arrhythmia.alerts.forEach((alert) => {
        console.log(`    - ${alert.message} (${alert.severity})`);
      });
      fs.appendFileSync(
        "worker.log",
        `  ⚠ Arrhythmia detected:\n` +
          result.arrhythmia.alerts
            .map((alert) => `    - ${alert.message} (${alert.severity})\n`)
            .join("")
      );
    }

    console.log(`✓ Job ${id} completed in ${processingTime}ms`);
    fs.appendFileSync(
      "worker.log",
      `✓ Job ${id} completed in ${processingTime}ms\n`
    );
  } catch (error) {
    console.error(`✗ Job ${id} failed:`, error.message);
    fs.appendFileSync("worker.log", `✗ Job ${id} failed: ${error.message}\n`);
    console.error(error.stack);
  }
}

/**
 * Main worker loop
 */
async function main() {
  console.log("❤️  ECG Worker started");
  console.log("Ready to process heartbeats...\n");

  // Poll for jobs (in production, this would be event-driven)
  while (true) {
    const job = await dequeueEcgJob();

    if (job) {
      await processJob(job);
    } else {
      // No jobs available, wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

main().catch((error) => {
  console.error("Worker crashed:", error);
  process.exit(1);
});
