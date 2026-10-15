"""XLB smoke probe v3: 3D incompressible channel, JAX CPU, official prepare_fields flow."""
import os, time
os.environ.setdefault("MPLCONFIGDIR", "/tmp/mpl")

import numpy as np
import jax, jax.numpy as jnp
import xlb

vs = xlb.velocity_set.D3Q19(
    precision_policy=xlb.PrecisionPolicy.FP32FP32,
    compute_backend=xlb.ComputeBackend.JAX,
)
xlb.init(velocity_set=vs, default_backend=xlb.ComputeBackend.JAX,
         default_precision_policy=xlb.PrecisionPolicy.FP32FP32)

NX, NY, NZ = 48, 24, 24
grid = xlb.grid.grid_factory(shape=(NX, NY, NZ), compute_backend=xlb.ComputeBackend.JAX)

U = 0.05
Re = 100
nu = U * (NY - 1) / Re
omega = 1.0 / (3.0 * nu + 0.5)

def plane(axis, at, spans):
    grids = [range(NX), range(NY), range(NZ)]
    grids[axis] = [at]
    return np.stack(np.meshgrid(*grids, indexing='ij')).reshape(3, -1)

inlet_idx = plane(0, 0, None)
outlet_idx = plane(0, NX - 1, None)
wall_lo = plane(1, 0, None)
wall_hi = plane(1, NY - 1, None)

bcs = [
    xlb.operator.boundary_condition.EquilibriumBC(rho=1.0, u=(U, 0.0, 0.0), indices=inlet_idx),
    xlb.operator.boundary_condition.DoNothingBC(indices=outlet_idx),
    xlb.operator.boundary_condition.HalfwayBounceBackBC(indices=wall_lo),
    xlb.operator.boundary_condition.HalfwayBounceBackBC(indices=wall_hi),
]

# --- patch: numpy 2.5.x changed `list += ndarray` to array semantics, breaking check_bc_overlaps ---
import xlb.helper, xlb.operator.stepper.nse_stepper as _nss
def _check_bc_overlaps_fixed(bclist, dim, compute_backend):
    index_list = [[] for _ in range(dim)]
    for bc in bclist:
        if bc.indices is None: continue
        arr = np.asarray(bc.indices)
        for d in range(dim):
            index_list[d].extend(arr[d].tolist())
    ia = np.unique(np.asarray(index_list), axis=-1)
    if ia.shape[-1] != len(index_list[0]):
        if compute_backend == xlb.ComputeBackend.WARP:
            raise ValueError("Boundary condition list contains duplicate indices!")
        print("WARNING: duplicate indices in bc list; order matters")
xlb.helper.check_bc_overlaps = _check_bc_overlaps_fixed
_nss.check_bc_overlaps = _check_bc_overlaps_fixed

stepper = xlb.operator.stepper.IncompressibleNavierStokesStepper(
    grid=grid, boundary_conditions=bcs, collision_type="BGK")
f_0, f_1, bc_mask, missing_mask = stepper.prepare_fields()

t0 = time.perf_counter()
for step in range(1, 4001):
    f_0, f_1 = stepper(f_0, f_1, bc_mask, missing_mask, omega, step)
    if step % 1000 == 0:
        jax.block_until_ready(f_0)
        print(f"step {step}: {time.perf_counter()-t0:6.2f}s")

f = np.asarray(f_0)
cc = np.array(vs.c).T  # (19, 3)
rho = f.sum(axis=0)
ux = (f * cc[:, 0].reshape(-1, 1, 1, 1)).sum(axis=0) / rho
mid_z = NZ // 2
prof = ux[NX // 2 - 4, :, mid_z]
y = np.arange(NY)
R = (NY - 1) / 2
para = 1.5 * U * (1 - ((y - R) / R) ** 2)
interior = slice(2, NY - 2)
err = np.abs(prof[interior] - para[interior]).max() / U
print(f"finite={np.isfinite(f).all()} | Poiseuille: max|du|/U = {err:.3f}")
print("profile:", np.round(prof, 4).tolist())
print(f"total {time.perf_counter()-t0:.2f}s / 4000 steps ({(time.perf_counter()-t0)/4000*1000:.2f} ms/step)")
