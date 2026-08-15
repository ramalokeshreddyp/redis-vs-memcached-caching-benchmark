# Questionnaire Responses

### 1. Why is Redis's single-threaded nature an advantage for the rate limiter and leaderboard implementation?
Redis processes commands serially inside a single-threaded event loop. This design guarantees atomic execution without the need for lock management or transactional overhead at the application layer:
*   **Rate Limiter**: We use a Lua script to fetch the current count, increment it, and apply an expiration if it is new. Because Redis runs the Lua script atomically in a single thread, it prevents concurrency race conditions (such as multiple clients creating keys without an expiry, or bypassing rate checks) without requiring client-side synchronization.
*   **Leaderboard**: We use `ZINCRBY` to update product view counts. The single-threaded model ensures that the Sorted Set (`ZSET`) tree node increment and ranking calculations occur atomically in a single event-loop turn, eliminating lost updates.

---

### 2. In what scenario would Memcached's multi-threaded architecture outperform Redis?
Memcached's multi-threaded architecture (which distributes incoming socket connections across worker threads via `libevent`) outperforms Redis in scenarios characterized by:
*   **Simple Key-Value Workloads**: Flat string operations (like `GET` and `SET`), where Redis's performance is bound by a single CPU core.
*   **High Concurrency & Multi-Core Scaling**: High volume of concurrent TCP connections where Memcached can scale horizontally across multiple CPU cores to handle socket I/O in parallel.
*   **Large Keyspaces**: Workloads requiring parallel memory lookup operations that would bottleneck Redis's single-threaded event loop.
This was demonstrated in our pipeline benchmarks where Memcached reached **1,838,100 Ops/sec** at pipeline depth 50, outperforming Redis (**1,108,052 Ops/sec**).

---

### 3. What was the observed impact of pipeline depth (P=1 vs P=50) on throughput and latency?
*   **Throughput**: Pipelining reduces network socket read/write cycles by batching multiple commands together. Increasing the pipeline depth from P=1 to P=50 resulted in a massive throughput scaling:
    *   **Redis**: Throughput scaled from **330,484 Ops/sec** (P=1) to **1,108,052 Ops/sec** (P=50) — a ~3.35x scaling.
    *   **Memcached**: Throughput scaled from **123,231 Ops/sec** (P=1) to **1,838,100 Ops/sec** (P=50) — a ~14.9x scaling.
*   **Latency**: While pipelining decreases the average processing time per request, the time required to complete the entire batched pipeline write-read cycle increases as more commands are queued. We observed a corresponding increase in p99 latency:
    *   **Redis**: p99 latency increased from **0.439 ms** (P=1) to **2.207 ms** (P=50).
    *   **Memcached**: p99 latency increased from **0.679 ms** (P=1) to **1.215 ms** (P=50).

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

---

## Direct Interview Questions & Answers

### 6. How would you implement the distributed locking mechanism in Memcached to prevent the lost increments observed in your non-locked leaderboard test?
We implemented lock-protected leaderboard updates in [`src/cache/memcached.ts`](file:///c:/Users/lokes/Downloads/redis-vs-memcached-caching-benchmark-main%20(1)/redis-vs-memcached-caching-benchmark-main/src/cache/memcached.ts) using the following mechanism:
1. **Atomic Lock Acquisition (`add` command)**: We attempt to set a lock key (e.g., `lock:leaderboard`) using Memcached's `add` command with a short TTL (e.g., 5 seconds). The `add` command is atomic and succeeds only if the key does not already exist.
2. **Backoff and Retry**: If the lock acquisition fails (the key already exists), the thread enters a retry loop with exponential backoff and jitter (starting at 5ms, backoff capped at 150ms) up to a maximum number of retries (100).
3. **Exclusive Critical Section**: Once the lock is acquired, the thread performs the get-modify-set cycle (reading the leaderboard JSON, incrementing the view count, sorting the results, and writing the updated JSON array back).
4. **Release Lock (`delete` command)**: In a `finally` block, we delete the lock key to release it for other concurrent workers.

### 7. Why did you choose to use Redis Hashes (HSET/HGETALL) for session storage instead of storing the session as a serialized JSON string like in Memcached?
1. **Granular Updates**: Redis Hashes allow reading/writing specific fields (`HSET`, `HGET`) without retrieving, parsing, or rewriting the entire session object. In contrast, Memcached's flat key-value model requires a full get-modify-set serialization loop.
2. **Concurrency Safety**: If two concurrent API requests update different fields of the same session (e.g., updating a shopping cart item and updating a last-seen timestamp) at the same time:
   * With serialized JSON (Memcached), the request that finishes last will overwrite the other's changes (lost updates).
   * With Redis Hashes (`HSET`), both field-level updates are executed independently and atomically by Redis's single-threaded engine, preventing race conditions.
3. **Efficiency and CPU Savings**: Avoiding serialization/deserialization overhead in Node.js for every minor session field update saves CPU cycles and reduces payload sizes over the network.
