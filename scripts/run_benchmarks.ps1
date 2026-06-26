# PowerShell script to run memtier_benchmark against Redis and Memcached services

# Ensure results directory exists
New-Item -ItemType Directory -Force -Path results | Out-Null

# 1. Redis Benchmarks
Write-Host "Starting Redis Benchmarks..."
"=== Redis Benchmark Results ===" | Out-File -FilePath results/redis_bench.txt -Encoding utf8

foreach ($p in 1, 10, 50) {
  Write-Host "Running Redis benchmark with pipeline depth: $p..."
  "--------------------------------------------------------" | Out-File -FilePath results/redis_bench.txt -Append -Encoding utf8
  "Pipeline Depth: $p" | Out-File -FilePath results/redis_bench.txt -Append -Encoding utf8
  "--------------------------------------------------------" | Out-File -FilePath results/redis_bench.txt -Append -Encoding utf8
  
  docker run --rm --network gpp-25_default redislabs/memtier_benchmark `
    -s redis `
    -p 6379 `
    --protocol=redis `
    --ratio=9:1 `
    --pipeline=$p `
    --key-pattern=G:G `
    --requests=10000 `
    -c 10 `
    -t 2 2>&1 | Out-File -FilePath results/redis_bench.txt -Append -Encoding utf8
    
  "`r`n`r`n" | Out-File -FilePath results/redis_bench.txt -Append -Encoding utf8
}

# 2. Memcached Benchmarks
Write-Host "Starting Memcached Benchmarks..."
"=== Memcached Benchmark Results ===" | Out-File -FilePath results/memcached_bench.txt -Encoding utf8

foreach ($p in 1, 10, 50) {
  Write-Host "Running Memcached benchmark with pipeline depth: $p..."
  "--------------------------------------------------------" | Out-File -FilePath results/memcached_bench.txt -Append -Encoding utf8
  "Pipeline Depth: $p" | Out-File -FilePath results/memcached_bench.txt -Append -Encoding utf8
  "--------------------------------------------------------" | Out-File -FilePath results/memcached_bench.txt -Append -Encoding utf8
  
  docker run --rm --network gpp-25_default redislabs/memtier_benchmark `
    -s memcached `
    -p 11211 `
    --protocol=memcache_binary `
    --ratio=9:1 `
    --pipeline=$p `
    --key-pattern=G:G `
    --requests=10000 `
    -c 10 `
    -t 2 2>&1 | Out-File -FilePath results/memcached_bench.txt -Append -Encoding utf8
    
  "`r`n`r`n" | Out-File -FilePath results/memcached_bench.txt -Append -Encoding utf8
}

Write-Host "All benchmarks completed successfully."
