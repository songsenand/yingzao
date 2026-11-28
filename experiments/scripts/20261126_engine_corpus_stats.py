#!/usr/bin/env python3
"""Retrospective corpus metrics for the OpenSCAD vs CadQuery example pairs.

Reads ONLY the local example corpora (versions + runs + assembly contracts) and
prints/writes a JSON + Markdown table. No network, no model calls, deterministic.

Usage:
  python3 experiments/scripts/20261126_engine_corpus_stats.py \
      --out experiments/artifacts/20261126_engine_corpus/stats.json

Corpora (authoring engine in parentheses):
  examples/sewing-rotary-hook        (OpenSCAD, 1.5x two-shaft belt drive)
  examples/sewing-rotary-hook-cq     (CadQuery, 2x lower-shaft 2:1 gear)
  examples/bicycle-derailleur-3spd   (OpenSCAD, 0/5/10 mm, integrated indexing)
  examples/bicycle-derailleur-3spd-cq(CadQuery, 0/4/8 mm, external indexing)

The pairs are the SAME SUBJECT, not the same brief: scale, mechanism, travel and
part counts differ. The report explains why that forbids an engine verdict.
"""
import argparse, glob, json, math, os, statistics
from collections import Counter, defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PAIRS = {
    'shuttle': {
        'scad': 'examples/sewing-rotary-hook',
        'cq': 'examples/sewing-rotary-hook-cq',
    },
    'derailleur': {
        'scad': 'examples/bicycle-derailleur-3spd',
        'cq': 'examples/bicycle-derailleur-3spd-cq',
    },
}

FAIL_KEYWORDS = {
    'motion-interference': ['干涉', '失配'],
    'printability-wall/overhang': ['悬垂', '最薄', '壁厚', '可疑处'],
    'assembly-undeclared': ['未声明', '冲突'],
    'cnc-access': ['不可达', '倒扣', '封闭腔'],
    'turning': ['回转偏差', '车削'],
    'stress': ['MPa', '峰值'],
}


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - m) / d, (c + m) / d)


def ztest(k1, n1, k2, n2):
    if min(n1, n2) == 0:
        return 0.0
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    return (k1 / n1 - k2 / n2) / se if se else 0.0


def corpus_stats(rel):
    base = os.path.join(ROOT, rel)
    manifest = load(os.path.join(base, 'cad-data', 'manifest.json'), {'versions': []})
    versions = manifest.get('versions', []) if isinstance(manifest, dict) else manifest
    authored = Counter(v.get('partId') for v in versions)
    kernels = Counter(((v.get('backend') or {}).get('kernel') or '?') for v in versions)
    sessions = {v.get('originSessionId') for v in versions if v.get('originSessionId')}

    runs = []
    for f in glob.glob(os.path.join(base, 'cad-data', 'runs', '*', 'run.json')):
        j = load(f, None)
        if j:
            runs.append(j)
    runs.sort(key=lambda j: j.get('id', ''))
    status = Counter(j.get('status') for j in runs)
    kinds = Counter(j.get('kind') for j in runs)
    sessions |= {j.get('originSessionId') for j in runs if j.get('originSessionId')}

    # assembly contract: delivered part nodes + interfaces
    contract = load(os.path.join(base, 'assembly', 'assembly.json'), {})
    root = contract.get('root', contract)
    nodes = []

    def walk(n):
        nodes.append(n)
        for c in n.get('children') or []:
            walk(c)

    if root:
        walk(root)
    delivered = [n for n in nodes if n.get('kind') == 'part']
    interfaces = contract.get('interfaces') or root.get('interfaces') or []

    audit = load(os.path.join(base, 'assembly', 'delivery-audit.json'), {})
    audit_verdict = audit.get('verdict') or audit.get('status') or ('none' if not audit else '?')

    # source LOC (authored geometry only; cad-data is the corpus, not source)
    loc = Counter()
    files = 0
    for pat in ('**/*.scad', '**/*.py'):
        for f in glob.glob(os.path.join(base, pat), recursive=True):
            if f'{os.sep}cad-data{os.sep}' in f:
                continue
            try:
                lines = sum(1 for _ in open(f, errors='ignore'))
            except Exception:
                continue
            files += 1
            loc[os.path.splitext(f)[1]] += lines

    # failure-cause mix over non-pass runs (multi-label)
    causes = Counter()
    for j in runs:
        if j.get('status') == 'pass':
            continue
        s = j.get('summary') or ''
        for label, words in FAIL_KEYWORDS.items():
            if any(w in s for w in words):
                causes[label] += 1

    ts = [j.get('timestamp') for j in runs if j.get('timestamp')]
    ts += [v.get('timestamp') for v in versions if v.get('timestamp')]
    ts = sorted(t for t in ts if t)
    n = len(runs)
    fail = status.get('fail', 0)
    lo, hi = wilson(fail, n)
    return {
        'dir': rel,
        'kernels': dict(kernels),
        'sessions': len(sessions),
        'authored_parts': len(authored),
        'versions': len(versions),
        'versions_per_part': round(len(versions) / max(1, len(authored)), 2),
        'per_part_max': max(authored.values()) if authored else 0,
        'per_part_median': statistics.median(authored.values()) if authored else 0,
        'delivered_parts': len(delivered),
        'interfaces': len(interfaces),
        'runs': n,
        'status': dict(status),
        'pass': status.get('pass', 0),
        'check': status.get('check', 0),
        'fail': fail,
        'fail_pct': round(100 * fail / max(1, n), 1),
        'fail_ci95': [round(100 * lo, 1), round(100 * hi, 1)],
        'runs_per_part': round(n / max(1, len(authored)), 2),
        'run_kinds': dict(kinds),
        'run_kind_count': len(kinds),
        'failure_causes': dict(causes),
        'audit': audit_verdict,
        'source_files': files,
        'loc': dict(loc),
        'first': ts[0][:10] if ts else '?',
        'last': ts[-1][:10] if ts else '?',
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    out = {'pairs': {}}
    for pair, dirs in PAIRS.items():
        scad = corpus_stats(dirs['scad'])
        cq = corpus_stats(dirs['cq'])
        z = ztest(scad['fail'], scad['runs'], cq['fail'], cq['runs'])
        out['pairs'][pair] = {'scad': scad, 'cadquery': cq, 'fail_z': round(z, 2)}

    print(json.dumps(out, ensure_ascii=False, indent=2))
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, 'w') as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
            f.write('\n')

if __name__ == '__main__':
    main()
