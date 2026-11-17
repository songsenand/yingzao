"""Nominal dimensions used by the v0 generator.

These are the selection/dimension tables the catalog deliberately does not
duplicate. They are nominal v0 values for fit/visual generation, not a claim of
full standard compliance; families with approximate tables say so in
`DIMENSION_SOURCE`.

All dimensions in mm. The origin conventions are in `DATUMS`.
"""

# family -> thread -> head data
HEX_BOLT = {
    "M3": {"af": 5.5, "k": 2.0},
    "M4": {"af": 7.0, "k": 2.8},
    "M5": {"af": 8.0, "k": 3.5},
    "M6": {"af": 10.0, "k": 4.0},
    "M8": {"af": 13.0, "k": 5.3},
    "M10": {"af": 16.0, "k": 6.4},
    "M12": {"af": 18.0, "k": 7.5},
    "M16": {"af": 24.0, "k": 10.0},
}

SOCKET_CAP = {
    "M3": {"head_d": 5.5, "k": 3.0},
    "M4": {"head_d": 7.0, "k": 4.0},
    "M5": {"head_d": 8.5, "k": 5.0},
    "M6": {"head_d": 10.0, "k": 6.0},
    "M8": {"head_d": 13.0, "k": 8.0},
    "M10": {"head_d": 16.0, "k": 10.0},
}

HEX_NUT = {
    "M3": {"af": 5.5, "m": 2.4},
    "M4": {"af": 7.0, "m": 3.2},
    "M5": {"af": 8.0, "m": 4.0},
    "M6": {"af": 10.0, "m": 5.0},
    "M8": {"af": 13.0, "m": 6.5},
    "M10": {"af": 16.0, "m": 8.0},
    "M12": {"af": 18.0, "m": 10.0},
    "M16": {"af": 24.0, "m": 13.0},
}

FLAT_WASHER = {
    "M3": {"id": 3.2, "od": 7.0, "t": 0.5},
    "M4": {"id": 4.3, "od": 9.0, "t": 0.8},
    "M5": {"id": 5.3, "od": 10.0, "t": 1.0},
    "M6": {"id": 6.4, "od": 12.0, "t": 1.6},
    "M8": {"id": 8.4, "od": 16.0, "t": 1.6},
    "M10": {"id": 10.5, "od": 20.0, "t": 2.0},
    "M12": {"id": 13.0, "od": 24.0, "t": 2.5},
    "M16": {"id": 17.0, "od": 30.0, "t": 3.0},
}

SPRING_WASHER = {
    "M3": {"id": 3.1, "od": 6.2, "t": 0.8},
    "M4": {"id": 4.1, "od": 7.6, "t": 1.0},
    "M5": {"id": 5.1, "od": 9.2, "t": 1.2},
    "M6": {"id": 6.1, "od": 11.8, "t": 1.6},
    "M8": {"id": 8.1, "od": 14.8, "t": 2.0},
    "M10": {"id": 10.2, "od": 18.1, "t": 2.2},
    "M12": {"id": 12.2, "od": 21.1, "t": 2.5},
}

BEARING = {
    "6000": {"bore": 10, "od": 26, "width": 8},
    "6001": {"bore": 12, "od": 28, "width": 8},
    "6002": {"bore": 15, "od": 32, "width": 9},
    "6003": {"bore": 17, "od": 35, "width": 10},
    "6004": {"bore": 20, "od": 42, "width": 12},
    "6005": {"bore": 25, "od": 47, "width": 12},
}

# DIN 471 approximate v0: (thickness, free inner diameter, free outer diameter)
RETAINING_RING = {
    10: {"t": 1.0, "id": 9.6, "od": 11.5},
    12: {"t": 1.0, "id": 11.5, "od": 13.8},
    15: {"t": 1.0, "id": 14.2, "od": 16.8},
    20: {"t": 1.2, "id": 19.0, "od": 22.5},
    25: {"t": 1.2, "id": 23.9, "od": 27.5},
    30: {"t": 1.5, "id": 28.6, "od": 32.5},
    40: {"t": 1.75, "id": 38.0, "od": 43.5},
    50: {"t": 2.0, "id": 47.0, "od": 54.0},
}

SHAFT_COLLAR = {
    6: {"od": 12.0, "w": 8.0},
    8: {"od": 16.0, "w": 8.0},
    10: {"od": 20.0, "w": 10.0},
    12: {"od": 22.0, "w": 10.0},
    16: {"od": 28.0, "w": 12.0},
}

DIMENSION_SOURCE = {
    "iso4014": "nominal ISO 4014 head/shank table; not a compliance certificate",
    "iso4762": "nominal ISO 4762 head table; not a compliance certificate",
    "iso4026": "nominal ISO 4026; plain shank/point only",
    "iso4032": "nominal ISO 4032 nut table; bore represented with clearance",
    "iso7040": "nominal ISO 7040 M8; nylon insert is visual only",
    "iso7089": "nominal ISO 7089 washer table",
    "din127": "nominal DIN 127 spring-washer table; split-ring representation",
    "iso15": "ISO 15 6000-series boundary dimensions",
    "iso3601": "O-ring ID/CS from catalog; torus representation",
    "din471": "approximate DIN 471 v0 table; C-ring representation",
    "din6885": "catalog key dimensions; chamfered box",
    "iso2338": "catalog pin dimensions; chamfered cylinder",
    "din2098": "catalog wire/OD/free length; fit is an annular envelope",
    "shaft-collar": "nominal generic collar table; not a standard",
}

DATUMS = {
    "iso4014": {
        "axis": {"point": [0, 0, 0], "dir": [0, 0, 1]},
        "seat": {"point": [0, 0, 0], "normal": [0, 0, -1]},
        "top": {"point": [0, 0, None], "normal": [0, 0, 1]},
    },
    "iso4762": {
        "axis": {"point": [0, 0, 0], "dir": [0, 0, 1]},
        "seat": {"point": [0, 0, 0], "normal": [0, 0, -1]},
        "top": {"point": [0, 0, None], "normal": [0, 0, 1]},
    },
    "iso4026": {
        "axis": {"point": [0, 0, 0], "dir": [0, 0, 1]},
        "end": {"point": [0, 0, 0], "normal": [0, 0, -1]},
    },
    "iso4032": {
        "axis": {"point": [0, 0, 0], "dir": [0, 0, 1]},
        "seat": {"point": [0, 0, 0], "normal": [0, 0, -1]},
        "top": {"point": [0, 0, None], "normal": [0, 0, 1]},
    },
    "iso7040": {
        "axis": {"point": [0, 0, 0], "dir": [0, 0, 1]},
        "seat": {"point": [0, 0, 0], "normal": [0, 0, -1]},
        "top": {"point": [0, 0, None], "normal": [0, 0, 1]},
    },
    "iso7089": {
        "axis": {"point": [0, 0, 0], "dir": [0, 0, 1]},
        "seat": {"point": [0, 0, 0], "normal": [0, 0, -1]},
        "top": {"point": [0, 0, None], "normal": [0, 0, 1]},
    },
    "din127": {
        "axis": {"point": [0, 0, 0], "dir": [0, 0, 1]},
        "seat": {"point": [0, 0, 0], "normal": [0, 0, -1]},
    },
    "iso15": {
        "bore-axis": {"point": [0, 0, 0], "dir": [0, 0, 1]},
        "inner-face": {"point": [0, 0, 0], "normal": [0, 0, -1]},
        "outer-face": {"point": [0, 0, None], "normal": [0, 0, 1]},
    },
    "iso3601": {
        "axis": {"point": [0, 0, 0], "dir": [0, 0, 1]},
        "center-plane": {"point": [0, 0, 0], "normal": [0, 0, 1]},
    },
    "din471": {
        "axis": {"point": [0, 0, 0], "dir": [0, 0, 1]},
        "face": {"point": [0, 0, 0], "normal": [0, 0, -1]},
    },
    "din6885": {
        "center": {"point": [0, 0, 0]},
        "long-axis": {"point": [0, 0, 0], "dir": [1, 0, 0]},
    },
    "iso2338": {
        "axis": {"point": [0, 0, 0], "dir": [0, 0, 1]},
        "end": {"point": [0, 0, 0], "normal": [0, 0, -1]},
    },
    "din2098": {
        "axis": {"point": [0, 0, 0], "dir": [0, 0, 1]},
        "end-face": {"point": [0, 0, 0], "normal": [0, 0, -1]},
    },
    "shaft-collar": {
        "axis": {"point": [0, 0, 0], "dir": [0, 0, 1]},
        "face": {"point": [0, 0, 0], "normal": [0, 0, -1]},
    },
}
