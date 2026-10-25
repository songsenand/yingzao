"""Run a command; report wall time and child peak RSS (Linux/KiB -> MiB)."""
import subprocess, sys, time, resource
t0 = time.time()
p = subprocess.run(sys.argv[1:], capture_output=True, text=True)
rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024
print(f'MEASURE wall={time.time() - t0:.2f}s maxrss={rss:.0f}MiB exit={p.returncode}')
for line in (p.stdout + p.stderr).splitlines():
    if any(k in line for k in ('VIEW ', 'BATCH_TOTAL', 'Saved:', 'Error', 'Traceback')):
        print(line)
