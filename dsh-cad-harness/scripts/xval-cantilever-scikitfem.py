import numpy as np
from skfem import MeshHex, ElementHex1, Basis, asm, condense, solve
from skfem.models.elasticity import linear_elasticity
from skfem import ElementVectorH1
L,B,H,E,nu,F = 100.,10.,10.,200000.,0.3,100.
I = B*H**3/12
dref = F*L**3/(3*E*I); sref = 6*F*L/(B*H*H)
print(f"梁理论: δ={dref:.4f}mm  σ_max={sref:.2f}MPa")
print(f"{'dx':>5} {'单元':>7} {'δ(mm)':>9} {'δ误差':>8} | 我的matrix-free δ / 误差")
mine = {2.5:(0.1930,-3.5),1.25:(0.1982,-0.9),0.625:(0.1997,-0.2)}
for n in (4,8):
    dx = 10./n
    m = MeshHex.init_tensor(np.linspace(0,L,10*n+1), np.linspace(-5,5,n+1), np.linspace(-5,5,n+1))
    b = Basis(m, ElementVectorH1(ElementHex1()))
    lam = E*nu/((1+nu)*(1-2*nu)); mu = E/(2*(1+nu))
    K = asm(linear_elasticity(lam, mu), b)
    nd = b.nodal_dofs; xn = b.doflocs[0, nd[0]]
    fixed = nd[:, np.isclose(xn,0.)].ravel()
    tip = np.where(np.isclose(xn, L))[0]
    f = np.zeros(b.N); f[nd[1,tip]] = -F/len(tip)
    u = solve(*condense(K, f, D=fixed))
    delta = -float(np.mean(u[nd[1,tip]]))
    r = K@u - f
    react = float(np.sum(r[nd[1, np.isclose(xn,0.)]]))
    err = 100*(delta-dref)/dref
    md, me = mine[dx]
    print(f"{dx:5.3f} {m.t.shape[1]:7d} {delta:9.4f} {err:+7.1f}% | {md:.4f} / {me:+.1f}%   反力={react:.2f}N")
