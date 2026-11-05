# Motion fixtures

`windup-cam-slider.json` is a reproducible `simulate_motion` input for the windup-frog
cam/slider subset:

- `drum` v043 fixed;
- `cam` v049 driven at 2π rad/s;
- `slider` v033 prescribed ±2 mm sine (period 1 s, phase −π/2);
- parts use their authored world coordinates (`position [0,0,0]`).

Usage: pass it as `pearl_run({execute:true, inputs:{fit:{clearanceThreshold:0}, motion:<file>}})`.

The real run r073 produced 49 interference checks and 46 events (first
`cam↔slider 0.145mm³ @ t=0.042s`), `samplingSatisfied=true`, `maxJointDriftMm=0`.
It is a **negative** fixture: the point is that the harness finds and localizes the
motion problem, not that this particular joint setup is a valid mechanism.
