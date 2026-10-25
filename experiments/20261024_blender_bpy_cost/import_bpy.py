"""Measure `import bpy` alone (module form)."""
import time
t = time.time()
import bpy, sys
print(f'IMPORT {time.time() - t:.2f}s BPY {bpy.app.version_string} PY {sys.version.split()[0]}')
