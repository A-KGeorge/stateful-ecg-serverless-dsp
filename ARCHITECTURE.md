# ECG Monitor Architecture Documentation

## Quick Reference: Production Deployment

| Decision            | Recommendation                        | Impact                   | Cost        |
| ------------------- | ------------------------------------- | ------------------------ | ----------- |
| **Lambda Region**   | Same as Redis (us-east-1)             | Required for VPC access  | -           |
| **Lambda AZ**       | Force same AZ as Redis                | **Latency: 7ms → 4ms**   | -           |
| **Redis Instance**  | cache.r6g.large (10 Gbps networking)  | Sub-millisecond I/O      | $145/month  |
| **Redis AZ**        | Single AZ (with replica in different) | **Critical for latency** | -           |
| **VPC Endpoints**   | Enable for SQS                        | No NAT gateway cost      | $7.20/month |
| **Connection Pool** | Reuse across Lambda warm starts       | Save 50ms per cold start | -           |
| **Pipelining**      | Batch GET state + GET metadata        | 2 round-trips → 1        | -           |
| **Monitor**         | Cross-AZ traffic = 0%                 | Each GB costs $0.01      | -           |

**Total**: ~$895/month (Lambda + ElastiCache + VPC endpoints) for 1,000 patients  
**Latency Target**: 4ms (3ms compute + 1ms Redis I/O)

---

## System Architecture

```mermaid
graph TD
    subgraph "Data Ingestion"
        A[MIT-BIH Dataset<br/>100_ekg.csv] -->|Parse CSV| B[Ingestion Script]
        B -->|Chunk into 1s batches<br/>360 samples each| C[Redis Queue<br/>ecg-chunks]
    end

    subgraph "Serverless Processing Layer"
        C -->|LPOP job| D[Serverless Worker<br/>AWS Lambda / GCP Function / Azure Function]
        D -->|1. Load State| E[(Redis State Store<br/>ecg:state:sensor-id<br/>758 bytes TOON)]
        D -->|2. Load Metadata| F[(Redis Metadata<br/>ecg:metadata:sensor-id<br/>lastPeakSample)]
        D -->|3. Process Chunk| G[Pan-Tompkins Pipeline]
        G -->|4. Save State| E
        G -->|5. Save Metadata| F
        G -->|6. Store Results| H[(Redis Results<br/>ecg:results:sensor-id)]
    end

    subgraph "Pan-Tompkins DSP Pipeline"
        G --> G1[1. Bandpass Filter<br/>5-15 Hz IIR]
        G1 --> G2[2. Differentiator<br/>Emphasize slopes]
        G2 --> G3[3. Square<br/>Amplify differences]
        G3 --> G4[4. Amplify<br/>10000x gain]
        G4 --> G5[5. Moving Average<br/>30-sample window]
        G5 --> G6[6. Peak Detection<br/>Adaptive threshold]
    end

    subgraph "Visualization Layer"
        H -->|Pub/Sub| I[Dashboard Server<br/>WebSocket + Redis Pub/Sub]
        I -->|Real-time broadcast| J[Web Dashboard<br/>Real-time ECG waveform<br/>Throttled 1 update/sec]
    end

    style D fill:#ff9900,stroke:#333,stroke-width:3px
    style E fill:#dc382d,stroke:#333,stroke-width:3px
    style G fill:#4a9eff,stroke:#333,stroke-width:3px
    style J fill:#28a745,stroke:#333,stroke-width:3px
```

## Data Flow Sequence

```mermaid
sequenceDiagram
    participant CSV as MIT-BIH CSV
    participant Ingest as Ingestion Script
    participant Queue as Redis Queue
    participant Worker as Serverless Worker
    participant State as Redis State
    participant Meta as Redis Metadata
    participant Pipeline as DSP Pipeline
    participant Results as Redis Results
    participant PubSub as Redis Pub/Sub
    participant Dashboard as Web Dashboard

    CSV->>Ingest: Load ECG data
    loop For each 1-second chunk
        Ingest->>Queue: Push job (360 samples)
    end

    loop Process each chunk (fast: <1ms)
        Worker->>Queue: LPOP next job
        Worker->>State: Load pipeline state
        Worker->>Meta: Load lastPeakSample
        Worker->>Pipeline: Process chunk

        Note over Pipeline: 1. Bandpass Filter (5-15 Hz)<br/>2. Differentiate<br/>3. Square<br/>4. Amplify (10000x)<br/>5. Moving Average (30 samples)<br/>6. Peak Detection

        Pipeline-->>Worker: Return peaks, BPM, HRV
        Worker->>State: Save new state (758 bytes)
        Worker->>Meta: Save lastPeakSample
        Worker->>Results: Store results
        Worker->>PubSub: Publish to ecg:results channel
    end

    loop Real-time updates (throttled)
        PubSub-->>Dashboard: WebSocket broadcast (instant)
        Dashboard->>Dashboard: Queue update
        Dashboard->>Dashboard: Process 1 update/sec (real-time speed)
        Dashboard->>Dashboard: Update waveform, metrics
    end
```

## State Management Deep Dive

```mermaid
graph LR
    subgraph "Chunk N-1"
        A1[Samples 0-359] --> B1[Pipeline State]
        B1 --> C1[Last Peak: Sample 287]
    end

    subgraph "State Serialization"
        C1 -->|TOON Binary| D[Redis Store<br/>758 bytes]
    end

    subgraph "Chunk N"
        D -->|Load State| E1[Pipeline Resumes]
        E1 --> F1[Samples 360-719]
        C1 --> G1[Combine Peaks]
        F1 --> H1[New Peak: Sample 540]
        H1 --> G1
        G1 --> I1[Calculate R-R Interval<br/>540 - 287 = 253 samples<br/>= 703ms @ 360Hz<br/>= 85 BPM]
    end

    subgraph "Next Iteration"
        H1 -->|Save for Chunk N+1| J1[Last Peak: Sample 540]
    end

    style D fill:#dc382d,stroke:#333,stroke-width:2px
    style I1 fill:#28a745,stroke:#333,stroke-width:2px
```

## Pipeline State Composition

```mermaid
classDiagram
    class PipelineState {
        +758 bytes total
        +IIRFilterState bandpass
        +DifferentiatorState diff
        +MovingAverageState ma
        +PeakDetectionState peak
    }

    class IIRFilterState {
        +Float64Array delays[4]
        +Float64Array coefficients[5]
        +~80 bytes
    }

    class DifferentiatorState {
        +float64 previousSample
        +8 bytes
    }

    class MovingAverageState {
        +Float64Array buffer[30]
        +float64 sum
        +uint32 index
        +~250 bytes
    }

    class PeakDetectionState {
        +float64 threshold
        +uint32 lastPeakIndex
        +Float64Array history[8]
        +~80 bytes
    }

    class Metadata {
        +uint32 lastPeakSample
        +Stored separately
    }

    PipelineState *-- IIRFilterState
    PipelineState *-- DifferentiatorState
    PipelineState *-- MovingAverageState
    PipelineState *-- PeakDetectionState
    PipelineState ..> Metadata : references
```

## Deployment Architecture

### AWS Lambda + SQS

```mermaid
graph TD
    A[ECG Sensors<br/>IoT Devices] -->|HTTPS/MQTT| B[API Gateway]
    B -->|Invoke| C[Ingestion Lambda]
    C -->|SendMessage| D[SQS Queue<br/>ecg-chunks]
    D -->|Trigger| E[Processing Lambda<br/>Node.js 22 Runtime]
    E <-->|Get/Set| F[ElastiCache Redis<br/>Cluster Mode]
    E -->|Write| G[DynamoDB<br/>Results Table]
    G -->|Stream| H[Analytics Lambda]
    H -->|Push| I[CloudWatch Dashboard]

    style E fill:#ff9900,stroke:#333,stroke-width:3px
    style F fill:#dc382d,stroke:#333,stroke-width:3px
```

### Google Cloud Functions + Pub/Sub

```mermaid
graph TD
    A[ECG Sensors] -->|HTTP POST| B[Cloud Functions<br/>Ingestion]
    B -->|Publish| C[Pub/Sub Topic<br/>ecg-chunks]
    C -->|Subscribe| D[Cloud Functions<br/>Processing]
    D <-->|Get/Set| E[Memorystore Redis]
    D -->|Write| F[Firestore<br/>Results Collection]
    F -->|Realtime| G[Web Dashboard]

    style D fill:#4285f4,stroke:#333,stroke-width:3px
    style E fill:#dc382d,stroke:#333,stroke-width:3px
```

## Performance Characteristics

### Latency Breakdown

```mermaid
gantt
    title Processing Latency per Chunk (Average: 3ms)
    dateFormat X
    axisFormat %L ms

    section Redis I/O
    Load State :0, 1
    Load Metadata :1, 2

    section DSP Processing
    Bandpass Filter :2, 3
    Differentiate + Square :3, 4
    Amplify + MA :4, 5
    Peak Detection :5, 6

    section State Save
    Serialize State :6, 7
    Save to Redis :7, 8
    Save Metadata :8, 9
```

### Scaling Characteristics

```mermaid
graph LR
    subgraph "Single Patient"
        A1[1 chunk/sec] --> B1[1 worker<br/>3ms latency]
    end

    subgraph "1,000 Patients"
        A2[1,000 chunks/sec] --> B2[1,000 workers<br/>3ms latency<br/>Auto-scaled]
    end

    subgraph "10,000 Patients"
        A3[10,000 chunks/sec] --> B3[10,000 workers<br/>3ms latency<br/>Redis Cluster]
    end

    style B2 fill:#28a745,stroke:#333,stroke-width:2px
    style B3 fill:#ffc107,stroke:#333,stroke-width:2px
```

## Cost Analysis

```mermaid
pie title Monthly Cost Comparison (1,000 Patients)
    "Serverless (Lambda + Redis)" : 750
    "EC2 (c5.2xlarge 24/7)" : 2920
```

### Detailed Cost Breakdown

**Serverless Architecture** (AWS Lambda + ElastiCache):

- Lambda invocations: 86.4M requests/month × $0.0000002 = $17.28
- Lambda compute: 86.4M × 3ms × $0.0000166667/GB-sec (256MB) = $432
- ElastiCache (t3.medium): $100/month
- Data transfer: ~$200/month
- **Total**: ~$750/month

**Traditional EC2**:

- c5.2xlarge (8 vCPU, 16GB): $0.34/hour × 730 hours = $248.20/month
- 10× instances for redundancy: $2,482/month
- Load balancer: $20/month
- EBS volumes: $100/month
- Monitoring: $50/month
- **Total**: ~$2,920/month

**Savings**: 74% reduction with serverless

## State Format Specification

### TOON Binary Format

```
Offset | Size | Field
-------|------|-------------------------------
0x00   | 4    | Magic bytes: "TOON"
0x04   | 1    | Version: 0x01
0x05   | 2    | NumStages (uint16_le)
0x07   | N    | Stage 1 data
  0x07 | 1    | Type name length
  0x08 | L    | Type name (UTF-8)
  +L   | 4    | Data size (uint32_le)
  +4   | D    | Binary data blob
...    | ...  | Repeat for each stage
```

**Advantages**:

- No string-to-float conversion (preserves precision)
- 94% smaller than JSON (758 vs 12,450 bytes)
- Fast serialization/deserialization (<1ms)
- Deterministic format (bit-exact reproducibility)

## Error Handling & Resilience

```mermaid
stateDiagram-v2
    [*] --> Dequeue: Worker starts
    Dequeue --> LoadState: Job received
    LoadState --> Process: State loaded
    LoadState --> Process: First chunk (no state)
    Process --> SaveState: Processing complete
    SaveState --> [*]: Success

    LoadState --> Error: Redis unavailable
    Process --> Error: Processing failed
    SaveState --> Error: Save failed

    Error --> Retry: Retry (max 3)
    Retry --> LoadState: Retry load
    Retry --> DeadLetter: Max retries
    DeadLetter --> [*]: Move to DLQ
```

## Production Network Topology

```mermaid
graph TB
    subgraph "AWS Region: us-east-1"
        subgraph "Availability Zone: us-east-1a"
            subgraph "VPC: 10.0.0.0/16"
                subgraph "Private Subnet A: 10.0.1.0/24"
                    L1[Lambda Function 1<br/>ENI: 10.0.1.10]
                    L2[Lambda Function 2<br/>ENI: 10.0.1.11]
                    L3[Lambda Function N<br/>ENI: 10.0.1.12]
                    R1[ElastiCache Redis<br/>Primary: 10.0.1.50<br/>r6g.large - 10 Gbps]
                end

                subgraph "Private Subnet B: 10.0.2.0/24"
                    R2[ElastiCache Redis<br/>Replica: 10.0.2.50]
                end
            end
        end

        SQS[SQS Queue<br/>ecg-chunks<br/>VPC Endpoint]

        subgraph "Public Subnet"
            NAT[NAT Gateway<br/>Not needed for Redis]
        end
    end

    L1 -.->|0.3-1ms| R1
    L2 -.->|0.3-1ms| R1
    L3 -.->|0.3-1ms| R1
    R1 -.->|Async replication| R2
    SQS -->|Trigger| L1
    SQS -->|Trigger| L2
    SQS -->|Trigger| L3

    style R1 fill:#dc382d,stroke:#333,stroke-width:3px
    style L1 fill:#ff9900,stroke:#333,stroke-width:2px
    style L2 fill:#ff9900,stroke:#333,stroke-width:2px
    style L3 fill:#ff9900,stroke:#333,stroke-width:2px
```

### Network Latency Breakdown

| Operation             | Latency | % of Total | Optimization                              |
| --------------------- | ------- | ---------- | ----------------------------------------- |
| **SQS → Lambda**      | ~10ms   | N/A        | Event-driven (async)                      |
| **Redis: Load State** | 0.5ms   | 12.5%      | ✅ Same AZ, enhanced networking           |
| **DSP Processing**    | 3ms     | 75%        | ✅ Optimized C++ with SIMD                |
| **Redis: Save State** | 0.5ms   | 12.5%      | ✅ Same AZ, pipelining                    |
| **Total Per Chunk**   | **4ms** | 100%       | **Target: <5ms for real-time processing** |

### Critical Network Optimizations

#### 1. **Same-AZ Deployment**

```bash
# WITHOUT same-AZ optimization (different AZs)
Lambda (us-east-1a) ←→ Redis (us-east-1b)
Latency: 2-3ms per operation
Total: 3ms compute + 6ms I/O = 9ms ❌

# WITH same-AZ optimization
Lambda (us-east-1a) ←→ Redis (us-east-1a)
Latency: 0.3-0.5ms per operation
Total: 3ms compute + 1ms I/O = 4ms ✅
```

**Implementation**:

```yaml
# CloudFormation
LambdaFunction:
  Properties:
    VpcConfig:
      SubnetIds:
        - !Ref PrivateSubnetA # Force us-east-1a

RedisCluster:
  Properties:
    PreferredCacheClusterAZs:
      - us-east-1a # Colocate with Lambda
```

#### 2. **Enhanced Network Instance Types**

| Instance Type    | Network Bandwidth | Redis Latency | Cost/Hour |
| ---------------- | ----------------- | ------------- | --------- |
| cache.t3.medium  | Up to 5 Gbps      | 1-2ms         | $0.068    |
| cache.r6g.large  | **10 Gbps**       | **0.3-0.5ms** | $0.201    |
| cache.r6g.xlarge | 12 Gbps           | 0.2-0.4ms     | $0.403    |

**Recommendation**: `cache.r6g.large` for optimal latency/cost ratio

#### 3. **Connection Pooling**

```javascript
// Reuse Redis connection across Lambda invocations
let redisClient;

export async function handler(event) {
  if (!redisClient) {
    redisClient = new Redis({
      host: process.env.REDIS_URL,
      port: 6379,
      keepAlive: 30000, // Keep connection alive
      maxRetriesPerRequest: 1, // Fail fast
      enableOfflineQueue: false, // No queueing
    });
  }

  // Redis client persists across warm invocations
  // Saves ~50ms connection overhead
}
```

#### 4. **VPC Endpoint for SQS** (Optional)

```yaml
SQSEndpoint:
  Type: AWS::EC2::VPCEndpoint
  Properties:
    ServiceName: com.amazonaws.us-east-1.sqs
    VpcId: !Ref VPC
```

**Benefit**: Lambda → SQS traffic stays within VPC (no NAT gateway)

## Security Considerations

- **State Encryption**: Redis data encrypted at rest (ElastiCache encryption)
- **Network Security**: VPC isolation for Lambda + Redis
- **Authentication**: IAM roles for resource access
- **Data Privacy**: PHI-compliant storage (HIPAA-eligible services)
- **Audit Logging**: CloudTrail for all API calls
- **State Validation**: Checksum verification on deserialization

## Monitoring & Observability

**Key Metrics**:

- **Processing latency** (p50, p99, p99.9)
- **Redis latency** (separate from compute time)
  - GET latency (state load)
  - SET latency (state save)
  - Network round-trip time
- **Lambda cold start** (VPC ENI creation: 5-10s)
- **State size over time** (detect memory leaks)
- **Peak detection accuracy** (vs ground truth)
- **Redis hit/miss ratio** (should be 100% hit)
- **Worker invocation count**
- **Queue depth** (SQS)
- **Network metrics**:
  - Lambda → Redis latency (target: <1ms)
  - Cross-AZ traffic (should be 0%)
  - VPC endpoint usage

**CloudWatch Custom Metrics**:

```javascript
await cloudwatch.putMetricData({
  Namespace: "ECG/Processing",
  MetricData: [
    {
      MetricName: "RedisLatency",
      Value: redisLoadTime,
      Unit: "Milliseconds",
      Dimensions: [
        { Name: "Operation", Value: "LoadState" },
        { Name: "AvailabilityZone", Value: "us-east-1a" },
      ],
    },
  ],
});
```

**Alarms**:

- ⚠️ Processing latency > 10ms (2.5× target)
- ⚠️ Redis latency > 2ms (indicates cross-AZ traffic)
- 🚨 State size > 2KB (indicates state bloat/memory leak)
- 🚨 Redis unavailability (automatic failover to replica)
- ⚠️ Queue depth > 1000 (ingestion faster than processing)
- 🚨 Lambda error rate > 1% (state corruption/network issues)
- ⚠️ Cross-AZ data transfer > 0 GB (cost optimization)

---

**Last Updated**: December 2025  
**Version**: 1.0.0  
**Author**: A-KGeorge
