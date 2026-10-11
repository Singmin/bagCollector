#!/bin/sh
# Read-only host/container sampling. Run once with collection off, once with it on.
# Usage: sh scripts/measure-learning-resources.sh baseline 120
set -eu
label=${1:-learning}
seconds=${2:-120}
case "$label" in *[!a-zA-Z0-9_-]*|'') echo 'label must be letters, digits, underscores or hyphens' >&2; exit 1;; esac
case "$seconds" in *[!0-9]*|'') echo 'seconds must be an integer' >&2; exit 1;; esac
mkdir -p /tmp/bagcollect-learning-metrics
output="/tmp/bagcollect-learning-metrics/$label.csv"
container=$(docker ps --filter label=com.docker.compose.service=scan-worker --format '{{.ID}}' | head -n 1)
[ -n "$container" ] || { echo 'scan-worker container not found' >&2; exit 1; }
echo 'unix_seconds,host_available_kib,scan_worker_rss_kib' > "$output"
start=$(date +%s)
while [ "$(($(date +%s) - start))" -lt "$seconds" ]; do
  available=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
  # VmRSS captures the actual single Node consumer, excluding Docker page cache.
  rss=$(docker exec "$container" sh -c 'awk "/^VmRSS:/ {sum+=\$2} END {print sum+0}" /proc/[0-9]*/status')
  echo "$(date +%s),$available,$rss" >> "$output"
  sleep 1
done
awk -F, 'NR>1 {if (min==0 || $2<min) min=$2; if ($3>peak) peak=$3} END {printf "Host minimum available: %.1f MiB; worker peak RSS: %.1f MiB\n",min/1024,peak/1024; if(min<204800) print "FAIL: available memory below 200 MiB"}' "$output"
echo "Saved $output. Compare learning peak minus baseline peak against 100 MiB. Compare scan diagnostics base/enhanced P95 separately."
