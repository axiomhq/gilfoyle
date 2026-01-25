# Failure Mode Catalog

Common failure patterns with symptoms, detection queries, and root causes.

## Deployment-Related

**Symptoms:** Errors/latency spike immediately after deploy time  
**Detection:** Query window around deploy, compare before/after

```apl
['logs'] | where _time between (datetime(2024-01-15T14:00:00Z) .. datetime(2024-01-15T14:30:00Z))
| summarize count() by bin(_time, 1m), status
```

**Common causes:** Bad config, missing env vars, incompatible schema, null pointer

## Resource Exhaustion

**Symptoms:** Timeouts increase gradually, then cliff  
**Check:** Connection pools, thread pools, file descriptors, memory

```apl
['logs'] | where _time between (ago(1h) .. now()) 
| where message has_cs "timeout" or message has_cs "connection refused" or message has_cs "pool"
| summarize count() by bin_auto(_time), service
```

**Common causes:** Connection leak, missing close() calls, undersized pools

## Cascading Failure

**Symptoms:** Multiple services failing, but one started first  
**Detection:** Find which service's errors appeared first

```apl
['logs'] | where _time between (ago(1h) .. now()) | where status >= 500 
| summarize first_error = min(_time) by service 
| order by first_error asc | take 5
```

**Root cause:** Usually a shared dependency (DB, cache, auth, queue)

## Thundering Herd

**Symptoms:** Spike in traffic immediately after an outage ends  
**Detection:** Request rate spike after recovery

```apl
['logs'] | where _time between (ago(1h) .. now()) 
| summarize count() by bin(_time, 10s) | order by _time asc
```

**Common causes:** Retry storms, cache stampede, client reconnection flood

## DNS/Certificate Issues

**Symptoms:** All traffic fails, or specific domain/endpoint fails  
**Check:** TLS handshake errors, DNS resolution failures

```apl
['logs'] | where _time between (ago(1h) .. now())
| where message has_cs "certificate" or message has_cs "DNS" or message has_cs "handshake"
| summarize count() by bin_auto(_time)
```

**Common causes:** Expired cert, DNS propagation, misconfigured SNI, CA issues

## Queue Backlog / Consumer Lag

**Symptoms:** Increasing latency, messages piling up, consumer lag growing  
**Check:** Queue depth metrics, dead letter queues

```apl
['metrics'] | where _time between (ago(1h) .. now())
| where metric has_cs "queue" or metric has_cs "lag"
| summarize max(value) by bin_auto(_time), queue_name
```

**Common causes:** Slow consumer, poison message, upstream spike, consumer crash

## Configuration/Feature Flag Issues

**Symptoms:** Only specific cohorts affected (region, tenant, feature tier)  
**Detection:** Use spotlight to find distinguishing factors

```apl
['logs'] | where _time between (ago(15m) .. now())
| summarize spotlight(status >= 500, region, tenant_tier, feature_flag)
```

**Common causes:** Flag targeting wrong cohort, config not propagated, rollout percentage issue

## Database Issues

**Symptoms:** Slow queries, connection timeouts, deadlocks  
**Check:** Query duration, connection pool usage, lock waits

```apl
['logs'] | where _time between (ago(1h) .. now())
| where message has_cs "deadlock" or message has_cs "lock wait" or message has_cs "slow query"
| summarize count() by bin_auto(_time), service
```

**Common causes:** Missing index, N+1 queries, lock contention, connection exhaustion

## Memory/GC Issues

**Symptoms:** Latency spikes, periodic slowdowns, OOM kills  
**Check:** GC pause times, memory usage, heap size

```apl
['metrics'] | where _time between (ago(1h) .. now())
| where metric has_cs "gc" or metric has_cs "heap" or metric has_cs "memory"
| summarize max(value), avg(value) by bin_auto(_time), service
```

**Common causes:** Memory leak, undersized heap, allocation pressure, GC tuning

## External Dependency Failure

**Symptoms:** Errors correlate with calls to external service  
**Check:** Third-party status pages, timeout patterns

```apl
['logs'] | where _time between (ago(1h) .. now())
| where service == "payment-gateway" or message has_cs "stripe" or message has_cs "external"
| summarize count() by status, bin_auto(_time)
```

**Common causes:** Third-party outage, rate limiting, API deprecation, network issues
