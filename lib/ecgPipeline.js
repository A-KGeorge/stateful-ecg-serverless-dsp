/**
 * ECG Pipeline - Pan-Tompkins QRS Detection Algorithm
 *
 * Implements the classic Pan-Tompkins algorithm for real-time QRS complex detection
 * in ECG signals. This is the gold standard for heartbeat detection.
 *
 * Pipeline stages:
 * 1. Bandpass Filter (5-15 Hz) - Isolates QRS complex energy
 * 2. Differentiator - Emphasizes steep slopes (R-wave has steepest slope)
 * 3. Square - Amplifies large differences, suppresses small variations
 * 4. Moving Window Integration - Smooths signal over ~150ms window
 * 5. Adaptive Peak Detection - Finds R-peaks using dynamic threshold
 *
 * The CRITICAL stateful step is the Moving Average (step 4) which maintains
 * a ~150ms window of past samples. This is where serverless fails without
 * proper state management.
 */

import { createDspPipeline } from "dspx";

// MIT-BIH Arrhythmia Database parameters
const SAMPLE_RATE = 360; // Hz (MIT-BIH standard)

// Pan-Tompkins parameters
const BANDPASS_LOW = 5; // Hz - High-pass to remove baseline wander
const BANDPASS_HIGH = 15; // Hz - Low-pass to remove muscle noise & T-waves
const MW_SIZE = 30; // Moving window size (~83ms at 360 Hz)
const PEAK_THRESHOLD = 0.5; // Threshold for amplified signal (was 0.00005 before 10000x gain)
const MIN_PEAK_DISTANCE = 180; // Minimum samples between peaks (~500ms = 120 BPM max)

/**
 * Create Pan-Tompkins pipeline for QRS detection
 * @returns {DspProcessor} Configured pipeline
 */
export function createEcgPipeline() {
  const pipeline = createDspPipeline();

  // Step 1: Bandpass Filter (5-15 Hz) - DISABLED DUE TO BUG
  // TODO: Fix IIR Butterworth filter producing all zeros
  // Isolates QRS complex energy, removes baseline drift and high-freq noise
  pipeline.filter({
    type: "butterworth",
    mode: "bandpass",
    lowCutoffFrequency: BANDPASS_LOW,
    highCutoffFrequency: BANDPASS_HIGH,
    order: 2,
    sampleRate: SAMPLE_RATE,
  });

  // Step 2: Differentiate
  // Emphasizes steep slopes (R-wave has steepest slope in ECG)
  // y[n] = (x[n] - x[n-1]) * sampleRate
  pipeline.Differentiator();

  // Step 3: Square
  // Amplifies large differences, suppresses small variations
  // y[n] = x[n]^2
  pipeline.Square();

  // Step 3.5: Amplify
  // Scale squared signal to appropriate amplitude for peak detection
  // Pan-Tompkins expects values around 0.1-1.0 range
  pipeline.Amplify({ gain: 10000 });

  // Step 4: Moving Window Integration
  // CRITICAL STATEFUL STEP: Maintains ~150ms window of past samples
  // This is where serverless fails without state management
  pipeline.MovingAverage({ mode: "moving", windowSize: MW_SIZE });

  // Step 5: Peak Detection with Adaptive Threshold
  // Finds R-peaks using dynamic threshold based on signal history
  pipeline.PeakDetection({
    threshold: PEAK_THRESHOLD,
    mode: "moving",
    domain: "time",
    windowSize: 3,
    minPeakDistance: MIN_PEAK_DISTANCE, // ~400ms between peaks
  });

  return pipeline;
}

/**
 * Calculate heart rate from detected peaks
 * @param {number[]} peaks - Array of peak sample indices
 * @param {number} sampleRate - Sampling rate in Hz
 * @returns {Object} HR metrics
 */
export function calculateHeartRate(peaks, sampleRate = SAMPLE_RATE) {
  if (peaks.length < 2) {
    return { bpm: 0, rrIntervals: [], hrv: 0 };
  }

  // Calculate R-R intervals (in milliseconds)
  const rrIntervals = [];
  for (let i = 1; i < peaks.length; i++) {
    const interval = ((peaks[i] - peaks[i - 1]) / sampleRate) * 1000;
    rrIntervals.push(interval);
  }

  // Calculate BPM from average R-R interval
  const avgRR =
    rrIntervals.reduce((sum, rr) => sum + rr, 0) / rrIntervals.length;
  const bpm = 60000 / avgRR; // 60000 ms per minute

  // Calculate Heart Rate Variability (HRV) - Standard deviation of R-R intervals
  const meanRR = avgRR;
  const variance =
    rrIntervals.reduce((sum, rr) => sum + Math.pow(rr - meanRR, 2), 0) /
    rrIntervals.length;
  const hrv = Math.sqrt(variance);

  return {
    bpm: Math.round(bpm),
    rrIntervals,
    hrv: Math.round(hrv),
  };
}

/**
 * Detect arrhythmias based on heart rate metrics
 * @param {number} bpm - Heart rate in beats per minute
 * @param {number} hrv - Heart rate variability in ms
 * @param {number[]} rrIntervals - R-R intervals in ms
 * @returns {Object} Arrhythmia classification
 */
export function detectArrhythmia(bpm, hrv, rrIntervals) {
  const alerts = [];

  // Bradycardia: HR < 60 BPM
  if (bpm > 0 && bpm < 60) {
    alerts.push({
      type: "bradycardia",
      severity: "warning",
      message: `Slow heart rate detected (${bpm} BPM)`,
    });
  }

  // Tachycardia: HR > 100 BPM
  if (bpm > 100) {
    alerts.push({
      type: "tachycardia",
      severity: bpm > 150 ? "critical" : "warning",
      message: `Elevated heart rate detected (${bpm} BPM)`,
    });
  }

  // Irregular rhythm: High HRV suggests AFib or other arrhythmias
  if (hrv > 150) {
    alerts.push({
      type: "irregular",
      severity: "warning",
      message: `Irregular rhythm detected (HRV: ${hrv}ms)`,
    });
  }

  // Check for consecutive very different R-R intervals (PVC detection)
  for (let i = 1; i < rrIntervals.length; i++) {
    const ratio =
      Math.max(rrIntervals[i], rrIntervals[i - 1]) /
      Math.min(rrIntervals[i], rrIntervals[i - 1]);
    if (ratio > 1.5) {
      alerts.push({
        type: "pvc",
        severity: "info",
        message: "Premature beat detected",
      });
      break; // Only report once per chunk
    }
  }

  return {
    normal: alerts.length === 0,
    alerts,
  };
}

/**
 * Process ECG chunk with state management
 * @param {Float32Array} chunk - ECG signal chunk
 * @param {Object} previousState - Serialized pipeline state
 * @param {Object} metadata - Additional metadata (chunkIndex, lastPeakSample)
 * @returns {Object} Processing results
 */
export async function processEcgChunk(
  chunk,
  previousState = null,
  metadata = {}
) {
  const pipeline = createEcgPipeline();
  const chunkIndex = metadata.chunkIndex || 0;
  const lastPeakSample = metadata.lastPeakSample || null;

  // Resume state if available (critical for stateful processing)
  if (previousState) {
    await pipeline.loadState(previousState);
  }

  // Process chunk through Pan-Tompkins pipeline
  const peakMask = await pipeline.process(chunk, {
    channels: 1,
    sampleRate: SAMPLE_RATE,
  });

  // Extract peak indices from binary mask (local to this chunk)
  const localPeaks = [];
  for (let i = 0; i < peakMask.length; i++) {
    if (peakMask[i] === 1.0) {
      localPeaks.push(i);
    }
  }

  // Convert local peak indices to global sample indices
  const chunkOffset = chunkIndex * chunk.length;
  const globalPeaks = localPeaks.map((idx) => chunkOffset + idx);

  // Combine with last peak from previous chunk for continuous R-R calculation
  const allPeaks =
    lastPeakSample !== null ? [lastPeakSample, ...globalPeaks] : globalPeaks;

  // Save state for next chunk (TOON format for efficiency)
  const newState = await pipeline.saveState({ format: "toon" });

  // Calculate metrics using all available peaks
  const { bpm, rrIntervals, hrv } = calculateHeartRate(allPeaks, SAMPLE_RATE);
  const arrhythmia = detectArrhythmia(bpm, hrv, rrIntervals);

  // Store last peak for next chunk
  const newLastPeakSample =
    globalPeaks.length > 0
      ? globalPeaks[globalPeaks.length - 1]
      : lastPeakSample;

  // Clean up
  pipeline.dispose();

  return {
    peaks: localPeaks, // Return local indices for this chunk
    bpm,
    hrv,
    arrhythmia,
    state: newState,
    lastPeakSample: newLastPeakSample, // Pass to next chunk
  };
}
