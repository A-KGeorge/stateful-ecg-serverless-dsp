/**
 * Redis Store - State and Job Queue Management
 *
 * Manages pipeline state persistence and job queuing for serverless workers.
 * Uses Redis Streams for reliable message delivery with consumer groups.
 */

import Redis from "ioredis";

const redis = new Redis({
  host: "localhost",
  port: 6379,
  maxRetriesPerRequest: null,
});

// Redis Streams configuration
const ECG_STREAM = "ecg:chunks";
const CONSUMER_GROUP = "ecg-workers";
const BATCH_SIZE = 1;
const BLOCK_MS = 5000;

/**
 * Initialize consumer group (idempotent)
 */
export async function initializeConsumerGroup() {
  try {
    await redis.xgroup("CREATE", ECG_STREAM, CONSUMER_GROUP, "0", "MKSTREAM");
    console.log(`✅ Created consumer group: ${CONSUMER_GROUP}`);
  } catch (err) {
    if (err.message.includes("BUSYGROUP")) {
      console.log(`✅ Consumer group already exists: ${CONSUMER_GROUP}`);
    } else {
      throw err;
    }
  }
}

/**
 * Save pipeline state to Redis
 * @param {string} sensorId - Unique sensor identifier
 * @param {Buffer} state - Serialized pipeline state (TOON format)
 */
export async function savePipelineState(sensorId, state) {
  const key = `ecg:state:${sensorId}`;
  await redis.set(key, state);
}

/**
 * Publish result to Redis Pub/Sub channel for real-time updates
 * @param {Object} result - ECG processing result
 */
export async function publishResult(result) {
  await redis.publish("ecg:results", JSON.stringify(result));
}

/**
 * Load pipeline state from Redis
 * @param {string} sensorId - Unique sensor identifier
 * @returns {Buffer|null} Serialized pipeline state or null
 */
export async function loadPipelineState(sensorId) {
  const key = `ecg:state:${sensorId}`;
  const data = await redis.getBuffer(key);
  return data;
}

/**
 * Queue ECG processing job using Redis Streams
 * @param {Object} job - Job data
 * @param {string} job.sensorId - Sensor identifier
 * @param {number} job.chunkIndex - Chunk sequence number
 * @param {Float32Array} job.samples - ECG samples
 */
export async function queueEcgJob(job) {
  const jobData = {
    id: job.id || `${job.sensorId}-${job.chunkIndex}`,
    sensorId: job.sensorId,
    chunkIndex: String(job.chunkIndex),
    samples: JSON.stringify(Array.from(job.samples)), // Convert Float32Array to JSON string
    timestamp: String(Date.now()),
  };

  // XADD returns the message ID
  await redis.xadd(ECG_STREAM, "*", ...Object.entries(jobData).flat());
}

/**
 * Dequeue next ECG job using Redis Streams consumer group
 * @param {string} consumerName - Name of this consumer
 * @returns {Object|null} Job data with messageId or null if queue is empty
 */
export async function dequeueEcgJob(consumerName) {
  const results = await redis.xreadgroup(
    "GROUP",
    CONSUMER_GROUP,
    consumerName,
    "COUNT",
    BATCH_SIZE,
    "BLOCK",
    BLOCK_MS,
    "STREAMS",
    ECG_STREAM,
    ">"
  );

  if (!results || results.length === 0) {
    return null;
  }

  const [_streamName, messages] = results[0];
  if (!messages || messages.length === 0) {
    return null;
  }

  const [messageId, fields] = messages[0];

  // Parse fields (Redis returns flat array: [key1, val1, key2, val2, ...])
  const data = {};
  for (let i = 0; i < fields.length; i += 2) {
    data[fields[i]] = fields[i + 1];
  }

  return {
    messageId,
    id: data.id,
    sensorId: data.sensorId,
    chunkIndex: parseInt(data.chunkIndex),
    samples: new Float32Array(JSON.parse(data.samples)),
    timestamp: parseInt(data.timestamp),
  };
}

/**
 * Acknowledge ECG job completion
 * @param {string} messageId - Redis stream message ID
 */
export async function ackEcgJob(messageId) {
  await redis.xack(ECG_STREAM, CONSUMER_GROUP, messageId);
}

/**
 * Recover pending jobs from PEL (Pending Entries List)
 * @param {string} consumerName - Name of this consumer
 * @returns {Array} Array of recovered jobs
 */
export async function recoverPendingJobs(consumerName) {
  const pending = await redis.xpending(
    ECG_STREAM,
    CONSUMER_GROUP,
    "-",
    "+",
    100
  );

  if (!Array.isArray(pending) || pending.length === 0) {
    return [];
  }

  const recoveredJobs = [];

  for (const entry of pending) {
    const [messageId, _consumerName, idleTime, deliveryCount] = entry;

    // Only claim messages idle for >30 seconds
    if (idleTime < 30000) continue;

    try {
      const claimed = await redis.xclaim(
        ECG_STREAM,
        CONSUMER_GROUP,
        consumerName,
        30000,
        messageId
      );

      if (claimed && claimed.length > 0) {
        const [_claimedId, fields] = claimed[0];

        const data = {};
        for (let i = 0; i < fields.length; i += 2) {
          data[fields[i]] = fields[i + 1];
        }

        recoveredJobs.push({
          messageId,
          id: data.id,
          sensorId: data.sensorId,
          chunkIndex: parseInt(data.chunkIndex),
          samples: new Float32Array(JSON.parse(data.samples)),
          timestamp: parseInt(data.timestamp),
          deliveryCount,
        });
      }
    } catch (err) {
      console.error(`❌ Failed to recover message ${messageId}:`, err.message);
    }
  }

  return recoveredJobs;
}

/**
 * Save processing results
 * @param {string} sensorId - Sensor identifier
 * @param {Object} result - Processing result
 */
export async function saveResult(sensorId, result) {
  const key = `ecg:results:${sensorId}`;
  await redis.rpush(key, JSON.stringify(result));
}

/**
 * Get processing results for a sensor
 * @param {string} sensorId - Sensor identifier
 * @param {number} limit - Maximum number of results to return
 * @returns {Array} Array of results
 */
export async function getResults(sensorId, limit = 100) {
  const key = `ecg:results:${sensorId}`;
  const results = await redis.lrange(key, -limit, -1);
  return results.map((r) => JSON.parse(r));
}

/**
 * Save metadata (lastPeakSample) for a sensor
 * @param {string} sensorId - Sensor identifier
 * @param {Object} metadata - Metadata object
 */
export async function saveMetadata(sensorId, metadata) {
  const key = `ecg:metadata:${sensorId}`;
  await redis.set(key, JSON.stringify(metadata));
}

/**
 * Load metadata for a sensor
 * @param {string} sensorId - Sensor identifier
 * @returns {Object|null} Metadata object or null
 */
export async function loadMetadata(sensorId) {
  const key = `ecg:metadata:${sensorId}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : null;
}

export { redis };
