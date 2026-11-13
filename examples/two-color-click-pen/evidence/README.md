# Cam timing evidence

`cam_timing.py` reads the delivered rotor STL (`cad-data/versions/v085/model.stl`)
and casts vertical rays at the two follower radii, taking the **lowest** hit as
the cam surface. It then computes the refill rear/tip positions and the
black-arm-vs-red-track clearance for 181 rotor angles (2° step).

Run with the pinned runtime from the project root:

```text
run_python({script:"evidence/cam_timing.py"})
```

Output: `cam_timing.json`.

Known sampling caveat: the rotor fins are built from 2° sector boxes, so a ray
can hit a sector side and read up to 0.400 mm away from the analytic profile.
The three click states sit on flat plateaus, where the error is 0.000 mm. The
0.4 mm is therefore a **sampling/faceting** number, not a functional cam error.
The carrier pad is 1.6–2.0 mm wide, so the real contact is the upper envelope
under the pad, not the single centre ray.
