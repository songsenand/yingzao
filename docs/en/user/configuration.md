# Configuration (user knobs)

[中文](../../user/configuration.md) | English

| Variable | Purpose | Default |
|---|---|---|
| `CAD_OPENSCAD_BIN` | Point at your own OpenSCAD executable | the plugin's candidate chain |
| `DSH_CAD_PYTHON` | `auto` / `eager` / `system` — provisioning policy for the private Python runtime | `auto` |
| `DSH_CAD_IMAGE_WINDOW` | Retained image window in context (lower it when a long session is rejected upstream) | 24; `1` for headless sessions |

All environment variables and diagnostic switches (including internal ones) are in [DESIGN.md §32](../../../DESIGN.md); only the three user-facing knobs are listed here.

## Common combinations

- **Slow network / want a warm first run**: `DSH_CAD_PYTHON=eager` provisions in the background at startup.
- **Machine already has Python 3.13**: `DSH_CAD_PYTHON=system` uses it, while locked dependencies are still installed from the lock.
- **Long session rejected for too many images**: lower `DSH_CAD_IMAGE_WINDOW`; use `1` for headless sessions.
