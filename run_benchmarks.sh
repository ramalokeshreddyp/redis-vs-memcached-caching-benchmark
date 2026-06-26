#!/bin/bash
# Script to run memtier_benchmark against Redis and Memcached services

# Create results directory if not exists
mkdir -p results

echo "=== Running Redis benchmarks ==="
echo "=== Redis Benchmark Results ===" > results/redis_bench.txt

for pipeline in 1 10 50; do
  echo "Running Redis benchmark with pipeline depth: ${pipeline}..."
  echo "--------------------------------------------------------" >> results/redis_bench.txt
  echo "Pipeline Depth: ${pipeline}" >> results/redis_bench.txt
  echo "--------------------------------------------------------" >> results/redis_bench.txt
  
  docker run --rm --network gpp-25_default redislabs/memtier_benchmark \
    -s redis \
    -p 6379 \
    --protocol=redis \
    --ratio=9:1 \
    --pipeline=${pipeline} \
    --key-pattern=G:G \
    --requests=10000 \
    -c 10 \
    -t 2 >> results/redis_bench.txt 2>&1
    
  echo -e "\n\n" >> results/redis_bench.txt
done

echo "=== Running Memcached benchmarks ==="
echo "=== Memcached Benchmark Results ===" > results/memcached_bench.txt

for pipeline in 1 10 50; do
  echo "Running Memcached benchmark with pipeline depth: ${pipeline}..."
  echo "--------------------------------------------------------" >> results/memcached_bench.txt
  echo "Pipeline Depth: ${pipeline}" >> results/memcached_bench.txt
  echo "--------------------------------------------------------" >> results/memcached_bench.txt
  
  docker run --rm --network gpp-25_default redislabs/memtier_benchmark \
    -s memcached \
    -p 11211 \
    --protocol=memcache_binary \
    --ratio=9:1 \
    --pipeline=${pipeline} \
    --key-pattern=G:G \
    --requests=10000 \
    -c 10 \
    -t 2 >> results/memcached_bench.txt 2>&1
    
  echo -e "\n\n" >> results/memcached_bench.txt
done

echo "All benchmarks completed."
