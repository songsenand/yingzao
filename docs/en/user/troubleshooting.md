# Troubleshooting

[中文](../../user/troubleshooting.md) | English

| Symptom | What to do |
|---|---|
| No CAD tools in a session | The session is not **营造模式 (Yingzao mode)**: start one with that preset, or make it the default in Settings |
| “Runtime not ready” | First-use provisioning has not finished; wait, or set `DSH_CAD_PYTHON=eager` to warm it at startup |
| First use takes a long time | It is downloading the ~400 MB runtime; change mirror/index sources if needed (see [DESIGN.md](../../../DESIGN.md)) |
| Long session rejected for too many images | The default window keeps 24 images; headless sessions can set `DSH_CAD_IMAGE_WINDOW=1` |
| A capability says “unavailable (missing package)” | That platform lacks a prebuilt package; expected. The status names the reason (see [Limits](limits.md)) |
| `include <BOSL2/std.scad>` fails with “Can't open include file” | `OPENSCADPATH` must point at the directory that **contains** `BOSL2/` (usually `lib/`), not `lib/BOSL2` itself |
| Panel blank / model not visible | Refresh; if still blank, confirm the session is in Yingzao mode and that browser WebGL works |

## Still stuck

Provide three things and diagnosis gets much faster:

1. dsh version and OS;
2. reproduction steps (the sentence, the action);
3. the original error text from the panel or logs, not just “it failed”.

Install issues: [Install](install.md). Boundaries: [Limits](limits.md).
