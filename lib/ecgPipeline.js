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
const RR_CLEANING_WINDOW = 15;
const Z_THRESHOLD = 2.0;

/**
 * Creates a specialized dspx pipeline for RR interval processing.
 * This handles outlier detection and cleaning using native moving statistics.
 */
async function createCleaningPipeline() {
  const pipeline = createDspPipeline();

  // Calculate Z-Scores to find outliers relative to the recent history
  pipeline.ZScoreNormalize({ mode: "moving", windowSize: RR_CLEANING_WINDOW });

  // Calculate local mean to provide a "clean" replacement value for outliers
  pipeline.MovingAverage({ mode: "moving", windowSize: RR_CLEANING_WINDOW });

  return pipeline;
}

/**
 * Create Pan-Tompkins pipeline for QRS detection
 * @returns {DspProcessor} Configured pipeline
 */
export function createEcgPipeline() {
  const pipeline = createDspPipeline();

  // Step 1: Bandpass Filter (5-15 Hz)
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
export async function calculateHeartRate(peaks, sampleRate = SAMPLE_RATE) {
  if (peaks.length < 2) {
    return { bpm: 0, rrIntervals: [], hrv: 0 };
  }

  // Calculate R-R intervals (in milliseconds)
  const rrIntervals = new Float32Array(peaks.length - 1);
  for (let i = 1; i < peaks.length; i++) {
    rrIntervals[i - 1] = ((peaks[i] - peaks[i - 1]) / sampleRate) * 1000;
  }

  const cleaner = await createCleaningPipeline();

  const zScores = await cleaner.processCopy(rrIntervals, {
    channels: 1,
    sampleRate: SAMPLE_RATE,
  });

  const nnIntervals = [];
  let ectopicCount = 0;

  // Initial mean for the first few beats
  let runningMean = rrIntervals[0];

  for (let i = 0; i < rrIntervals.length; i++) {
    const rr = rrIntervals[i];
    const z = Math.abs(zScores[i]);

    // 1. Hard Physiological Limits
    const isOutOfRange = rr < 300 || rr > 2000;

    // 2. Native Statistical Outlier Check
    // If Z-Score > 2.0 (Threshold), it's statistically abnormal (Ectopic)
    const isStatisticalOutlier = i > 5 && z > Z_THRESHOLD;

    if (isOutOfRange || isStatisticalOutlier) {
      nnIntervals.push(runningMean); // Replace with local NN estimate
      ectopicCount++;
    } else {
      nnIntervals.push(rr);
      // Update running mean estimate (alpha-filter style for simplicity in this loop)
      runningMean = runningMean * 0.8 + rr * 0.2;
    }
  }

  cleaner.dispose();

  // Calculate BPM from average R-R interval
  const avgRR =
    rrIntervals.reduce((sum, rr) => sum + rr, 0) / rrIntervals.length;
  const bpm = 60000 / avgRR; // 60000 ms per minute

  // Calculate Heart Rate Variability (HRV) - Standard deviation of R-R intervals
  // HRV requires at least 2 R-R intervals (3 peaks) to be meaningful
  let hrv = 0;
  if (rrIntervals.length >= 2) {
    const meanRR = avgRR;
    const variance =
      rrIntervals.reduce((sum, rr) => sum + Math.pow(rr - meanRR, 2), 0) /
      rrIntervals.length;
    hrv = Math.sqrt(variance);
  }

  return {
    bpm: Math.round(bpm),
    rrIntervals,
    hrv: Math.round(hrv),
  };
}

/**
 * Detect arrhythmias based on heart rate metrics
 * @param {number} bpm - Heart rate in beats per minute
 * @param {number} hrv - Heart rate variability in ms (rolling window)
 * @param {number[]} currentRrIntervals - R-R intervals from current chunk only
 * @returns {Object} Arrhythmia classification
 */
export function detectArrhythmia(bpm, hrv, currentRrIntervals) {
  const alerts = [];

  // Only check BPM and HRV thresholds if we have valid data
  // Skip BPM checks for chunks with no beats (BPM = 0)
  if (bpm > 0) {
    // Bradycardia: HR < 60 BPM
    if (bpm < 60) {
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
  }

  // Irregular rhythm: High HRV suggests AFib or other arrhythmias
  // Only check if we have enough data in the rolling window
  if (hrv > 150) {
    alerts.push({
      type: "irregular",
      severity: "warning",
      message: `Irregular rhythm detected (HRV: ${hrv}ms)`,
    });
  }

  // Check for consecutive very different R-R intervals in CURRENT chunk only (PVC detection)
  // This prevents re-alerting on old PVCs
  for (let i = 1; i < currentRrIntervals.length; i++) {
    const ratio =
      Math.max(currentRrIntervals[i], currentRrIntervals[i - 1]) /
      Math.min(currentRrIntervals[i], currentRrIntervals[i - 1]);
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
 * @param {Object} metadata - Additional metadata (chunkIndex, lastPeakSample, rrHistory)
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
  const rrHistory = metadata.rrHistory || []; // Rolling window of R-R intervals

  // Resume state if available (critical for stateful processing)
  if (previousState) {
    await pipeline.loadState(previousState);
  }

  // Process chunk through Pan-Tompkins pipeline
  const peakMask = await pipeline.processCopy(chunk, {
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
  const {
    bpm,
    rrIntervals,
    hrv: instantHrv,
  } = await calculateHeartRate(allPeaks, SAMPLE_RATE);

  // Add new R-R intervals to rolling window (keep last 10 seconds = ~10-15 intervals)
  const updatedRrHistory = [...rrHistory, ...rrIntervals].slice(-15);

  // Calculate rolling HRV over longer window for more meaningful measurement
  let rollingHrv = 0;
  if (updatedRrHistory.length >= 2) {
    const meanRR =
      updatedRrHistory.reduce((sum, rr) => sum + rr, 0) /
      updatedRrHistory.length;
    const variance =
      updatedRrHistory.reduce((sum, rr) => sum + Math.pow(rr - meanRR, 2), 0) /
      updatedRrHistory.length;
    rollingHrv = Math.round(Math.sqrt(variance));
  }

  // Detect arrhythmias using rolling HRV but only NEW R-R intervals for PVC detection
  const arrhythmia = detectArrhythmia(bpm, rollingHrv, rrIntervals);

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
    hrv: rollingHrv, // Use rolling HRV instead of instant
    arrhythmia,
    state: newState,
    lastPeakSample: newLastPeakSample, // Pass to next chunk
    rrHistory: updatedRrHistory, // Pass rolling window to next chunk
  };
}
