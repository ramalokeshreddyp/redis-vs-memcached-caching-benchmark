# Questionnaire Responses

### 1. Why is Redis's single-threaded nature an advantage for the rate limiter and leaderboard implementation?
Redis processes commands serially inside a single-threaded event loop. This design guarantees atomic execution without the need for lock management or transactional overhead at the application layer:
*   **Rate Limiter**: We use a Lua script to fetch the current count, increment it, and apply an expiration if it is new. Because Redis runs the Lua script atomically in a single thread, it prevents concurrency race conditions (such as multiple clients creating keys without an expiry, or bypassing rate checks) without requiring client-side synchronization.
*   **Leaderboard**: We use `ZINCRBY` to update product view counts. The single-threaded model ensures that the Sorted Set (`ZSET`) tree node increment and ranking calculations occur atomically in a single event-loop turn, eliminating lost updates.

---

### 2. In what scenario would Memcached's multi-threaded architecture outperform Redis?
Memcached's multi-threaded architecture (which distributes incoming socket connections across worker threads via `libevent`) outperforms Redis in scenarios characterized by:
*   **Simple Key-Value Workloads**: Raw `GET` and `SET` operations on flat string values, where Redis is bound by the processing limit of a single CPU core.
*   **High Concurrency & Multi-Core Scaling**: High volumes of concurrent TCP connections where Memcached can scale horizontally across multiple CPU cores to handle socket I/O in parallel.
*   **Large Keyspaces**: Workloads requiring parallel memory lookup operations that would bottleneck Redis's single-threaded event loop.
This was demonstrated in our pipeline benchmarks where Memcached reached ~1.7 million operations per second at pipeline depth 50, outperforming Redis (~1.4 million operations per second).

---

### 3. What was the observed impact of pipeline depth (P=1 vs P=50) on throughput and latency?
*   **Throughput**: Pipelining reduces network socket read/write cycles by batching multiple commands together. Increasing the pipeline depth from P=1 to P=50 resulted in a massive throughput scaling:
    *   **Redis**: Throughput scaled from **81,154 Ops/sec** (P=1) to **1,419,990 Ops/sec** (P=50) — a ~17.5x scaling.
    *   **Memcached**: Throughput scaled from **183,862 Ops/sec** (P=1) to **1,707,023 Ops/sec** (P=50) — a ~9.3x scaling.
*   **Latency**: While pipelining decreases the average processing time per request, the time required to complete the entire batched pipeline write-read cycle increases as more commands are queued. We observed a corresponding increase in p99 latency:
    *   **Redis**: p99 latency increased from **0.383 ms** (P=1) to **1.463 ms** (P=50).
    *   **Memcached**: p99 latency increased from **0.279 ms** (P=1) to **1.407 ms** (P=50).

---

### 4. Describe the performance cost of implementing distributed locks in Memcached.
Because Memcached does not support native complex data structures (like sorted sets) or multi-key atomic transactions, updating the leaderboard requires client-side serialization and get-modify-set cycles. The performance costs include:
1.  **Increased RTT Overhead**: Rather than a single atomic update, the client must perform multiple network round trips: `add` (acquire lock) -> `get` (fetch data) -> `set` (save updated data) -> `delete` (release lock).
2.  **Payload & Bandwidth Overhead**: The entire serialized JSON array of leaderboard entries must be transferred over the network and parsed in application memory for every single view increment.
3.  **Contention & Blocked Threads**: Under high concurrency, multiple application processes compete for the lock. Failing to acquire the lock triggers retries with exponential backoffs, which blocks API execution loops and severely limits throughput compared to Redis's O(log N) native updates.

---

### 5. Why did you choose your specific invalidation strategy for Memcached over other alternatives?
We chose **Cache Versioning** (constructing lookup keys using a global namespace version, i.e., `product:v<version>:<id>`) for Memcached cache invalidations because:
1.  **Absence of Pub/Sub**: Memcached does not support a native Pub/Sub notification mechanism to invalidate local L1 (in-memory) caches across multiple API instances.
2.  **Bulk Invalidation Efficiency**: In typical catalog applications, direct key deletion of thousands of products individually causes a high volume of delete queries and cache keyspace cleanup calls. By incrementing a single global namespace version key, all old cached product items are invalidated in a single, O(1) atomic increment operation.
3.  **Consistency Guarantees**: A version namespace shift guarantees that subsequent read and write sequences will immediately reference the new version namespace, preventing race conditions where stale data is read during concurrent update operations.
