# System Architecture: Redis vs. Memcached comparative analysis

This document provides a comprehensive analysis of the system architecture, component design, data flow topology, and the technical trade-offs between Redis 7 and Memcached 1.6 in the Product Catalog API.

---

## 1. Project Objective

The core objective of this project is to implement, evaluate, and benchmark identical business requirements using two distinct in-memory architectures:
1.  **Redis 7 (Data Structure Topology)**: Moving computation closer to the data using advanced data structures (ZSET, Hash) and atomic operations (Lua).
2.  **Memcached 1.6 (High-Throughput Key-Value Topology)**: Utilizing a simpler key-value paradigm coupled with multi-threaded execution and client-side logic orchestration (distributed locking, cache versioning namespaces).

---

## 2. System Architecture Layout

The application functions as a high-performance proxy that abstracts caching operations behind a unified interface (`ICacheBackend`). Depending on the request headers or configurations, database lookups are supplemented by cache reads and writes.

```mermaid
graph TD
    subgraph Clients
        C1[HTTP Client 1]
        C2[HTTP Client 2]
        BM[memtier_benchmark]
    end

    subgraph Application Tier
        API[Catalog API Proxy Node.js/TS]
        Limiter[Rate Limiter Middleware]
        Factory[Cache Factory]
        Pool[DB Connection Pool]
    end

    subgraph Caching Tier
        Redis[Redis 7 Container]
        MC[Memcached 1.6 Container]
    end

    subgraph Database Tier
        DB[(PostgreSQL 15 Container)]
    end

    C1 -->|HTTP Requests| Limiter
    C2 -->|HTTP Requests| Limiter
    BM -->|Raw Cache Protocol| Redis
    BM -->|Raw Cache Protocol| MC
    
    Limiter -->|Allow| Factory
    Factory -->|Resolve Backend| Redis
    Factory -->|Resolve Backend| MC
    
    API -->|Read/Write Miss| Pool
    Pool -->|SQL Query| DB
```

---

## 3. Cache Design Topologies & Patterns

### 1. Product Invalidation Patterns
A critical challenge in distributed caching is maintaining cache consistency during database updates. We compare two distinct approaches:

```mermaid
graph LR
    subgraph Redis Invalidation
        R_POST[POST Update] --> R_DB[Update Postgres]
        R_POST --> R_DEL[Delete product:id]
        R_POST --> R_PUB[Publish 'product:invalidations' channel]
        R_PUB --> R_SUB[All App Instances listen and purge L1 local caches]
    end
```

```mermaid
graph LR
    subgraph Memcached Cache Versioning
        M_POST[POST Update] --> M_DB[Update Postgres]
        M_POST --> M_VER[Increment global_version key]
        M_GET[GET Request] --> M_READ_VER[Get global_version = v2]
        M_GET --> M_READ_KEY[Query product:v2:id]
        style M_READ_KEY fill:#ffcccc,stroke:#333,stroke-width:2px
    end
```

*   **Redis (Pub/Sub Invalidation)**:
    *   When a product is updated, the active caching layer deletes the key `product:<id>`.
    *   Simultaneously, the API publishes the invalidation event to a Redis channel. Any subscribed application instance receives this broadcast and can purge local L1 (in-memory) caches immediately.
*   **Memcached (Cache Versioning Namespace)**:
    *   Since Memcached lacks a pub/sub mechanism, cache keys are constructed as `product:v<version>:<id>`.
    *   A single global key `product:global_version` maintains the active namespace.
    *   When an update occurs, the global version key is incremented (`product:global_version = version + 1`). This immediately shifts the key namespace for subsequent queries, rendering all cached entries obsolete without requiring key-by-key deletions.

---

## 4. Key Modules & Technical Choices

### Core Modules
1.  **Proxy Rate Limiter (`src/middleware/rate-limiter.ts`)**:
    *   First line of defense against request flooding.
    *   Extracts client IP or `X-User-Id` to keep rate records.
    *   Injects headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`).
2.  **Database Connection Pool (`src/db.ts`)**:
    *   Manages connection instances, reducing connection establishment overhead for database operations.
3.  **Cache Factory (`src/cache/factory.ts`)**:
    *   Implements the Strategy Pattern to dynamically route cache read/write tasks to Redis or Memcached based on the `X-Cache-Backend` header.
4.  **Redis Backend Wrapper (`src/cache/redis.ts`)**:
    *   Wraps the Redis 7 client. Executes Lua scripts for atomic operations and handles sorted sets for the leaderboard.
5.  **Memcached Backend Wrapper (`src/cache/memcached.ts`)**:
    *   Wraps the Memcached 1.6 client (`memjs`). Implements the distributed locking cycle (exponential backoff retry loop) and serialized sessions.

---

## 5. Technical Comparison: Redis vs. Memcached

| Architectural Feature | Redis 7.0 | Memcached 1.6 |
| :--- | :--- | :--- |
| **Execution Model** | Single-threaded event loop (for command execution) | Multi-threaded event loop (allocates to worker cores) |
| **Data Structures** | Rich (Strings, Hashes, Lists, Sets, Sorted Sets, Streams) | Simple Strings (Max payload size 1MB) |
| **Atomicity** | Atomic single commands, Lua Scripts, MULTI/EXEC | Single-key atomic operations (Incr, Decr, Add, CAS) |
| **Concurrency Guarantees** | Implemented on cache server (serialized execution) | Client-orchestrated locking (Add retry loops, CAS) |
| **Memory Allocation** | Dynamic memory allocation (glibc/jemalloc) | Slab Allocation (Pre-allocated chunk sizes, zero fragmentation) |
| **Pub/Sub Mechanism** | Native (Publish/Subscribe/Pattern subscribe) | Lacks Pub/Sub (requires versioning or version keys) |

### Pros & Cons Analysis

#### Redis
*   **Pros**:
    *   Rich data types reduce logic in the application tier (e.g. `ZSET` sort).
    *   Atomic execution model (Lua scripts) completely eliminates concurrency race conditions.
    *   Individual hash field updates save bandwidth and CPU cycles.
*   **Cons**:
    *   Single-threaded bottleneck: expensive operations (like `KEYS *`) block the entire server.
    *   Higher memory metadata overhead per key.

#### Memcached
*   **Pros**:
    *   Scales horizontally across multiple CPU cores in raw workloads.
    *   Extremely light memory overhead per key.
    *   Zero memory fragmentation due to Slab Allocation.
*   **Cons**:
    *   No native complex structures: sorting and array manipulations must be handled in application code.
    *   No transactional blocks: requires client-side distributed locking or CAS checks, introducing network overhead.
    *   No persistence options.

---

## 6. Execution & Data Flow Topology

### Rate Limiter Execution Flow
This diagram details the difference in rate limiter verification between Redis (Lua script) and Memcached (check-add-increment).

```mermaid
graph TD
    subgraph Redis Lua Rate Limiting
        R1[Request Received] --> R2[Run Lua Script]
        R2 --> R3{GET key}
        R3 -->|Exceeds Limit| R4[Return Current Count & TTL]
        R3 -->|Under Limit| R5[Increment Key]
        R5 --> R6{TTL Exists?}
        R6 -->|No| R7[Set TTL to 60s]
        R6 -->|Yes| R8[Keep current TTL]
        R8 --> R9[Return Current Count & TTL]
        R7 --> R9
    end

    subgraph Memcached Rate Limiting
        M1[Request Received] --> M2[Run INCR key]
        M2 -->|Succeeds| M3[Compare value with Limit]
        M2 -->|Fails/Key Missing| M4[Run ADD key '1' expires 60s]
        M4 -->|Succeeds| M5[Return count = 1]
        M4 -->|Fails/Race| M6[Retry INCR key]
        M6 --> M3
        M3 -->|<= Limit| M7[Allow Request]
        M3 -->|> Limit| M8[Block HTTP 429]
    end
```
