"""Generate a 2D structured channel mesh in SU2 .su2 format.

Domain: [0, 1] x [0, 0.5] (meters — SU2 is SI).
Markers: inlet (x=0), outlet (x=1), wall (y=0 and y=0.5).
"""
NX, NY = 65, 33          # nodes
L, H = 1.0, 0.5          # meters

def idx(i, j):
    return j * NX + i

lines = []
lines.append("NDIME= 2")
lines.append(f"NPOIN= {NX * NY}")
for j in range(NY):
    for i in range(NX):
        lines.append(f"{i * L / (NX - 1):.10f}\t{j * H / (NY - 1):.10f}\t{idx(i, j)}")

# quads: 4 nodes, CCW
nquad = (NX - 1) * (NY - 1)
lines.append(f"NELEM= {nquad}")
for j in range(NY - 1):
    for i in range(NX - 1):
        a, b, c, d = idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)
        lines.append(f"4\t{a}\t{b}\t{c}\t{d}")

def marker(tag, pairs):
    lines.append(f"MARKER_TAG= {tag}")
    lines.append(f"MARKER_ELEMS= {len(pairs)}")
    for a, b in pairs:
        lines.append(f"3\t{a}\t{b}")

inlet = [(idx(0, j), idx(0, j + 1)) for j in range(NY - 1)]
outlet = [(idx(NX - 1, j), idx(NX - 1, j + 1)) for j in range(NY - 1)]
wall = ([(idx(i, 0), idx(i + 1, 0)) for i in range(NX - 1)]
        + [(idx(i, NY - 1), idx(i + 1, NY - 1)) for i in range(NX - 1)])

lines.append(f"NMARK= 3")
marker("inlet", inlet)
marker("outlet", outlet)
marker("wall", wall)

with open("channel.su2", "w") as f:
    f.write("\n".join(lines) + "\n")
print(f"channel.su2: {NX*NY} points, {nquad} quads, "
      f"markers inlet={len(inlet)} outlet={len(outlet)} wall={len(wall)}")
