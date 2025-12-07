/**
 * Redis Store - State and Job Queue Management
 *
 * Manages pipeline state persistence and job queuing for serverless workers.
 */

import Redis from "ioredis";

const redis = new Redis({
  host: "localhost",
  port: 6379,
  maxRetriesPerRequest: null,
});

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
 * Queue ECG processing job
 * @param {Object} job - Job data
 * @param {string} job.sensorId - Sensor identifier
 * @param {number} job.chunkIndex - Chunk sequence number
 * @param {Float32Array} job.samples - ECG samples
 */
export async function queueEcgJob(job) {
  const jobData = JSON.stringify({
    id: job.id || `${job.sensorId}-${job.chunkIndex}`,
    sensorId: job.sensorId,
    chunkIndex: job.chunkIndex,
    samples: Array.from(job.samples), // Convert Float32Array to regular array for JSON
    timestamp: Date.now(),
  });

  await redis.rpush("ecg-chunks", jobData);
}

/**
 * Dequeue next ECG job
 * @returns {Object|null} Job data or null if queue is empty
 */
export async function dequeueEcgJob() {
  const jobData = await redis.lpop("ecg-chunks");
  if (!jobData) return null;

  const job = JSON.parse(jobData);
  // Convert samples back to Float32Array
  job.samples = new Float32Array(job.samples);
  return job;
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
