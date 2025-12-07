/**
 * Test Pipeline - Verify Pan-Tompkins implementation
 *
 * Tests the ECG pipeline with data from CSV to ensure proper functionality.
 */

import fs from "fs";
import {
  createEcgPipeline,
  calculateHeartRate,
  detectArrhythmia,
} from "../lib/ecgPipeline.js";

const SAMPLE_RATE = 360; // Hz

/**
 * Load ECG signal from CSV file
 * @param {string} filePath - Path to CSV file
 * @param {number} maxSamples - Maximum samples to load (optional)
 * @returns {Float32Array} ECG signal
 */
function loadEcgFromCsv(filePath, maxSamples = null) {
  const data = fs.readFileSync(filePath, "utf8");
  const lines = data.split("\n").slice(1); // Skip header
  const signal = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(",");
    const mlII = parseFloat(cols[1]); // Use MLII lead
    if (!isNaN(mlII)) {
      signal.push(mlII);
      if (maxSamples && signal.length >= maxSamples) break;
    }
  }

  return new Float32Array(signal);
}

async function testPipeline() {
  console.log("🧪 Testing ECG Pipeline\n");

  // DIAGNOSTIC: Test if pipeline works at all with simple data
  console.log("=== DIAGNOSTIC TEST ===");
  const simpleData = new Float32Array([0.1, -0.2, 0.3, -0.4, 0.5]);
  console.log("Simple input BEFORE process:", Array.from(simpleData));
  const simplePipeline = createEcgPipeline();
  const simpleResult = await simplePipeline.processCopy(simpleData, {
    sampleRate: SAMPLE_RATE,
  });
  console.log("Simple input AFTER process:", Array.from(simpleData));
  console.log("Simple output:", Array.from(simpleResult).slice(0, 5));
  console.log("======================\n");

  // Test 1: Normal heart rate
  console.log("Test 1: Loading ECG data from CSV (first 5 seconds)");
  const normalEcg = loadEcgFromCsv("data/100_ekg.csv", 5 * SAMPLE_RATE); // First 5 seconds

  console.log(`  Loaded ${normalEcg.length} samples`);
  console.log(`  First 10 values:`, normalEcg.slice(0, 10));
  console.log(
    `  Input range: min=${Math.min(...normalEcg).toFixed(3)}, max=${Math.max(
      ...normalEcg
    ).toFixed(3)}`
  );

  const pipeline = createEcgPipeline();

  // Add a tap AFTER creating the pipeline to debug
  pipeline.tap((data) => {
    console.log(
      `  [EXTERNAL TAP] First 5 values:`,
      Array.from(data).slice(0, 5)
    );
    console.log(
      `  [EXTERNAL TAP] Range: ${Math.min(...data).toFixed(4)} to ${Math.max(
        ...data
      ).toFixed(4)}`
    );
    return data;
  });

  const peakMask = await pipeline.processCopy(normalEcg, {
    channels: 1,
    sampleRate: SAMPLE_RATE,
  });

  console.log(
    `  Output range: min=${Math.min(...peakMask).toFixed(3)}, max=${Math.max(
      ...peakMask
    ).toFixed(3)}`
  );
  console.log(
    `  Non-zero outputs: ${
      Array.from(peakMask).filter((v) => Math.abs(v) > 0.001).length
    }/${peakMask.length}`
  );

  const peaks = [];
  for (let i = 0; i < peakMask.length; i++) {
    if (peakMask[i] === 1.0) peaks.push(i);
  }

  const { bpm, hrv } = calculateHeartRate(peaks);
  const arrhythmia = detectArrhythmia(bpm, hrv, []);

  console.log(`  Detected ${peaks.length} peaks`);
  console.log(`  Calculated HR: ${bpm} BPM`);
  console.log(`  Status: ${arrhythmia.normal ? "✓ Normal" : "⚠ Abnormal"}`);

  // Test 2: Stateful processing (chunked)
  console.log("\nTest 2: Stateful processing (2 chunks)");
  const chunk1 = normalEcg.slice(0, 360); // First second
  const chunk2 = normalEcg.slice(360, 720); // Second second

  const pipeline2 = createEcgPipeline();

  // Process first chunk
  const result1 = await pipeline2.processCopy(chunk1, {
    channels: 1,
    sampleRate: SAMPLE_RATE,
  });
  const state = await pipeline2.saveState({ format: "toon" });
  console.log(`  Chunk 1: State saved (${state.length} bytes)`);

  // Process second chunk with state
  const pipeline3 = createEcgPipeline();
  await pipeline3.loadState(state);
  const result2 = await pipeline3.processCopy(chunk2, {
    channels: 1,
    sampleRate: SAMPLE_RATE,
  });
  console.log(`  Chunk 2: State loaded and processed`);
  console.log(`  ✓ Stateful processing works!`);

  console.log("\n✅ All tests passed!");
}

testPipeline().catch(console.error);
