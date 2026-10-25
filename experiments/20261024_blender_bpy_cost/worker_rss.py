"""Measure the resident CAD worker's RSS before/after a ping (Linux only)."""
import subprocess, sys, time, json
script = 'dsh-cad-harness/python/cad_worker/worker.py'
p = subprocess.Popen([sys.executable, script], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True)
hello = p.stdout.readline()
time.sleep(0.3)
rss = int(open(f'/proc/{p.pid}/status').read().split('VmRSS:')[1].split()[0]) / 1024
print('WORKER_HELLO', hello.strip()[:120])
print(f'WORKER_BASELINE_RSS {rss:.0f}MiB')
p.stdin.write(json.dumps({'id': 1, 'op': 'ping', 'params': {}}) + '\n'); p.stdin.flush(); p.stdout.readline()
time.sleep(0.2)
rss = int(open(f'/proc/{p.pid}/status').read().split('VmRSS:')[1].split()[0]) / 1024
print(f'WORKER_AFTER_PING_RSS {rss:.0f}MiB')
p.kill()
