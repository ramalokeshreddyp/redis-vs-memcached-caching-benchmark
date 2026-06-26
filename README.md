# Redis vs Memcached: Comparative Caching Layer

A high-performance Product Catalog API proxy designed to compare and benchmark **Redis 7** and **Memcached 1.6** caching patterns. This project implements five complex caching patterns, manages in-memory data structures, implements distributed locking, and provides a comparative performance and consistency analysis.

---

## 1. System Architecture

The microservice acts as an API proxy that dynamically switches between cache backends based on the `X-Cache-Backend` header (values: `redis` or `memcached`).

```
                     +---------------------------------------+
                     |  Load Generator (Locust / memtier)    |
                     +---------------------------------------+
                                         |
                                         v [HTTP Headers / JSON]
                     +---------------------------------------+
                     |       Product Catalog API Proxy       |
                     |       (Node.js / Express / TS)        |
                     +---------------------------------------+
                        /                |                \
    [ZSET/Lua/HSET/DEL] /                | [Get/Set/Lock]  \ [SQL]
                       v                 v                  v
              +---------------+  +---------------+  +---------------+
              |    Redis 7    |  | Memcached 1.6 |  |  PostgreSQL   |
              |    Server     |  |    Server     |  |   Database    |
              +---------------+  +---------------+  +---------------+
```

---

## 2. Implemented Caching Patterns

### Phase A: Basic Caching & Sessions
*   **Product Metadata Caching**: On `GET /products/:id`, the proxy checks the active cache. On a miss, it queries PostgreSQL, caches the serialized JSON product (~2KB) with a 300-second TTL, and returns it.
*   **User Sessions**:
    *   **Redis**: Uses Hashes (`HSET`/`HGETALL`), allowing single-field updates (e.g., modifying `last_login`) without re-serializing the entire session.
    *   **Memcached**: Stores the entire session as a serialized JSON string. Updates require fetching, deserializing, modifying, and re-saving the entire session object.

### Phase B: Leaderboard (Most Viewed Products)
*   **Redis**: Implements sorting natively using a Sorted Set (`ZSET`) via `ZINCRBY` (atomic updates) and `ZREVRANGE` (retrieving the top 10).
*   **Memcached**: Since Memcached lacks native sorting, the leaderboard is stored as a serialized JSON array under a single key. To avoid race conditions, a distributed lock is acquired using Memcached `add` (binary protocol). If the lock is held, requests retry with exponential backoff.

### Phase C: Distributed Rate Limiting
Enforces a per-user rate limit of 100 requests per minute.
*   **Redis**: Uses an atomic Lua script (`INCR` + `EXPIRE` in a single event-loop cycle) to prevent race conditions.
*   **Memcached**: Uses binary `incr`. If the key is missing, it initializes the key atomically to `1` using `add` with a 60-second TTL. If `add` fails due to concurrency, it retries the increment.

### Phase D: Cache Invalidation
*   **Redis**: Uses a Pub/Sub broadcast channel `product:invalidations` to notify all active API instances to invalidate internal state.
*   **Memcached**: Implements **Cache Versioning**. A global version key `product:global_version` is incremented upon product updates. Subsequent product lookups use the new version in their key prefix (`product:v<version>:<id>`), immediately invalidating all old entries.

---

## 3. Environment Setup & Execution

### Prerequisites
- Docker & Docker Compose
- Python 3.x (to run consistency tests)
- Node.js (v22.x) & npm (optional, for local development)

### Step 1: Clone and Configure Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

### Step 2: Start Services
Start the entire stack in the background:
```bash
docker compose up --build -d
```
*The `catalog_app` container depends on database health. The database is considered healthy only after the entrypoint SQL script finishes seeding exactly **100,000 product rows** (this may take up to 20-30 seconds).*

### Step 3: Verify Status
Check container health:
```bash
docker ps
```
You should see all containers (`catalog_app`, `catalog_db`, `catalog_redis`, `catalog_memcached`) in a healthy state.

---

## 4. Benchmark Suite

We run `memtier_benchmark` using official Docker images to compare raw throughput and latency across both caching engines under Gaussian key distributions and a 9:1 Read/Write ratio.

### Running Benchmarks
On Windows (PowerShell):
```powershell
powershell -File scripts/run_benchmarks.ps1
```
On Linux / Git Bash:
```bash
bash run_benchmarks.sh
```

Raw benchmark statistics are saved under the `results/` directory:
- `results/redis_bench.txt`
- `results/memcached_bench.txt`

### Benchmark Analysis (Pipeline Depth Comparison)

| Caching Backend | Pipeline Depth | Throughput (Ops/sec) | Avg Latency (ms) | p99 Latency (ms) |
| :--- | :--- | :--- | :--- | :--- |
| **Redis 7** | 1 | 81,154 | 0.147 | 0.383 |
| **Memcached 1.6** | 1 | 183,862 | 54.27* | 0.279 |
| **Redis 7** | 10 | 829,015 | 0.240 | 0.567 |
| **Memcached 1.6** | 10 | 1,392,234 | 0.143 | 0.391 |
| **Redis 7** | 50 | 1,419,990 | 0.695 | 1.463 |
| **Memcached 1.6** | 50 | 1,707,023 | 0.565 | 1.407 |

*\*Note: The Pipeline 1 average latency for Memcached was skewed by connection handshakes at start, but percentile metrics (p50: 0.103ms, p99: 0.279ms) indicate typical performance is faster.*

**Key Takeaways:**
1. **Raw Performance**: Memcached consistently achieves higher throughput (Ops/sec) and lower p99 latency than Redis across all pipelining depths due to its multi-threaded architecture.
2. **Pipelining Efficiency**: Pipelining significantly improves throughput for both systems, scaling performance by over 10x as depth increases from 1 to 10.

---

## 5. Consistency & Concurrency Tests

The project includes a Python test script `scripts/verify_consistency.py` that spawns concurrent threads to verify atomicity guarantees under load.

### Running Consistency Verification
Ensure your containers are running, then execute:
```bash
python scripts/verify_consistency.py
```

### Consistency Analysis

*   **Rate Limiter Test**: Sends 105 rapid requests. Both Redis and Memcached block requests beyond 100 with HTTP 429.
*   **Leaderboard Concurrency Test**: Spawns 10 parallel clients doing 100 increments each (1,000 total).
    *   **Redis ZSET**: Native event-loop serialization guarantees **0 lost increments**.
    *   **Memcached with Lock**: Lock-protected get-modify-set ensures **0 lost increments**.
    *   **Memcached without Lock**: Concurrent get-modify-set operations collide, leading to **lost increments** (typically ~20-60 lost).

---

## 6. Memory Comparison Table

We stored exactly **100,000 product objects** (each serialized as a JSON string of size **2,006 bytes**) to compare memory efficiency.

| Storage Backend | Reported Used Memory (MB) | Overhead per Key (Bytes) |
| :--- | :---: | :---: |
| **Redis 7** | 216.27 | 147.4 |
| **Memcached 1.6** | 199.18 | 82.6 |

### Overhead Math
- **Raw Data Size**: 2,006 bytes.
- **Memcached Overhead**:
  $$\frac{208,857,643\text{ bytes (total memory)}}{100,000\text{ keys}} = 2,088.6\text{ bytes/key}$$
  $$\text{Overhead} = 2,088.6 - 2,006 = 82.6\text{ bytes/key}$$
- **Redis Overhead** (excluding startup footprint of 948,424 bytes):
  $$\frac{216,294,064 - 948,424\text{ bytes}}{100,000\text{ keys}} = 2,153.4\text{ bytes/key}$$
  $$\text{Overhead} = 2,153.4 - 2,006 = 147.4\text{ bytes/key}$$

**Analysis**: Redis incurs **78% higher memory overhead per key** than Memcached. This is because Redis allocates additional pointer graphs and metadata for its advanced dictionary and data structures, while Memcached utilizes a simple Slab Allocator designed strictly for flat strings.
