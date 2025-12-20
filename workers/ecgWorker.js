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
  ackEcgJob,
  recoverPendingJobs,
  initializeConsumerGroup,
  getQueueDepth,
} from "../lib/redisStore.js";
import { processEcgChunk } from "../lib/ecgPipeline.js";
import * as fs from "fs";

// Worker configuration
const CONSUMER_NAME = `ecg-worker-${process.pid}`;
let running = false;
let pelCleanupInterval;

/**
 * Process a single ECG job
 * @param {Object} job - ECG processing job
 */
async function processJob(job) {
  const { id, sensorId, chunkIndex, samples, messageId, deliveryCount } = job;

  console.log(`\n▶ Processing job ${id}`);
  console.log(`  Sensor: ${sensorId}`);
  console.log(`  Chunk: ${chunkIndex} (${samples.length} samples)`);

  if (deliveryCount) {
    console.log(`  📦 Recovered message (delivery #${deliveryCount})`);
  }

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

    // Acknowledge message
    if (messageId) {
      await ackEcgJob(messageId);
    }
  } catch (error) {
    console.error(`✗ Job ${id} failed:`, error.message);
    fs.appendFileSync("worker.log", `✗ Job ${id} failed: ${error.message}\n`);
    console.error(error.stack);
  }
}

/**
 * Recover pending messages from PEL
 */
async function recoverPendingMessages() {
  console.log("🔍 Checking for pending messages...");

  try {
    const recovered = await recoverPendingJobs(CONSUMER_NAME);

    if (recovered.length === 0) {
      console.log("✅ No pending messages found");
      return;
    }

    console.log(
      `⚠️  Found ${recovered.length} pending messages, recovering...`
    );

    for (const job of recovered) {
      await processJob(job);
    }

    console.log("✅ Pending message recovery complete");
  } catch (err) {
    console.error("❌ Error during PEL recovery:", err);
  }
}

/**
 * Start periodic PEL cleanup (every 5 minutes)
 */
function startPelCleanup() {
  pelCleanupInterval = setInterval(async () => {
    if (running) {
      await recoverPendingMessages();
    }
  }, 5 * 60 * 1000);
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  console.log("⚠️  Shutting down gracefully...");
  running = false;

  if (pelCleanupInterval) {
    clearInterval(pelCleanupInterval);
  }

  console.log("👋 ECG Worker stopped");
  process.exit(0);
}

/**
 * Main worker loop
 */
async function main() {
  console.log("❤️  ECG Worker started");
  console.log(`   Consumer: ${CONSUMER_NAME}`);
  console.log("   Ready to process heartbeats...\n");

  // Initialize consumer group
  await initializeConsumerGroup();

  // Recover any pending messages
  await recoverPendingMessages();

  // Start periodic PEL cleanup
  startPelCleanup();

  running = true;
  let consecutiveEmptyPolls = 0;
  let backlogMode = false;

  // Poll for jobs (in production, this would be event-driven)
  while (running) {
    const job = await dequeueEcgJob(CONSUMER_NAME);

    if (job) {
      consecutiveEmptyPolls = 0;

      // Check queue depth to detect backlog
      const queueDepth = await getQueueDepth();

      // Enter backlog mode if queue has more than 10 pending jobs
      if (!backlogMode && queueDepth > 10) {
        backlogMode = true;
        console.log(
          `\n🚀 BACKLOG DETECTED: ${queueDepth} pending jobs - Processing at maximum speed!`
        );
      }

      await processJob(job);

      // Exit backlog mode when caught up
      if (backlogMode && queueDepth <= 5) {
        backlogMode = false;
        console.log(
          `\n✅ BACKLOG CLEARED: Caught up! Resuming normal operation.\n`
        );
      }

      // In backlog mode, process continuously without delay
      // In normal mode, continue immediately if there are more jobs
      if (!backlogMode && queueDepth === 0) {
        // Only add minimal delay if queue is empty
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } else {
      consecutiveEmptyPolls++;

      // If we've had multiple empty polls, wait a bit longer
      const waitTime = consecutiveEmptyPolls > 5 ? 100 : 10;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }
}

// Graceful shutdown handlers
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error("Worker crashed:", error);
  process.exit(1);
});
