# CadQuery bracket (L1.5)

`bracket.py` is the end-to-end authoring example: a 60×40×6 plate with four
Ø4.5 through-holes, R4 vertical corners, and four datum declarations.

Use it through the normal part tool:

```js
cad_part({ action: "generate", args: {
  code: <contents of bracket.py>,
  part: "CQ bracket",
  userIntent: "L1.5 example: 60x40x6 plate, 4 holes, R4, datum set",
} })
```

The version records `sourceFile: "model.py"` and `backend: {kernel:"cadquery"}`;
renders come from the STL→OpenSCAD path (the CQ pack has no VTK renderer).
`cad_session` action `info` reports the effective kernel.
