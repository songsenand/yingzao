// Process catalog: the field's vocabulary for manufacturing processes.
//
// `manufacturing.allowed` is the user's decision space (what they can actually
// get made). A process id also needs an honest answer to "how would the harness
// verify it?" — that is `verification`, and it is a separate fact from "the id
// exists". A catalog entry can be:
//   - supported: evaluator built, covers the main geometric failure modes
//   - partial:   evaluator built, screens some criteria; read `handoff`
//   - planned:   the method/criteria/inputs are defined, the evaluator is not built
// There is deliberately no "unsupported with no method": every process names a
// method, and every method names what remains a handoff (physical test, CAE, vendor).
// Marking a process `planned` means "record the decision, do not read it as pass".

export type ProcessFamily = 'additive' | 'molding' | 'subtractive' | 'cutting' | 'forming';
export type ProcessSupport = 'supported' | 'partial' | 'planned';

export interface ProcessVerification {
  /** The method in one line: what geometry is measured, against what rule. */
  method: string;
  /** The evaluator family; null only when no check family can express the method yet. */
  evaluator: 'check_printability' | 'check_moldability' | 'check_machinability' | 'check_sheet2d' | 'check_turning' | null;
  /** Is the evaluator implemented today? */
  built: boolean;
  /** Criteria the method can decide. */
  criteria: string[];
  /** Inputs the method needs from the user/agent (the plan names them when missing). */
  inputs: string[];
  /** What this method cannot decide; a handoff to CAE/vendor/physical test. */
  handoff: string[];
  /** Additional evaluators for the same process (e.g. CNC access on top of the profile screen). */
  additional?: {
    evaluator: 'check_cnc_access' | 'check_sheet2d' | 'check_edm_access';
    built: boolean;
    criteria: string[];
    inputs: string[];
  }[];
}

export interface ProcessCapability {
  id: string;
  label: string;
  family: ProcessFamily;
  support: ProcessSupport;
  verification: ProcessVerification;
  note: string;
}

export const PROCESS_CATALOG: Record<string, ProcessCapability> = {
  'fdm-pla-0.4': {
    id: 'fdm-pla-0.4', label: 'FDM PLA 0.4 mm', family: 'additive', support: 'supported',
    verification: {
      method: 'wall / feature / gap + overhang-area screen in the print frame',
      evaluator: 'check_printability', built: true,
      criteria: ['min-wall', 'min-feature', 'min-gap', 'overhang-area', 'print-orientation'],
      inputs: ['layer/nozzle profile', 'printOrientationDeg'],
      handoff: ['layer adhesion', 'warp', 'actual print time'],
    },
    note: 'the built-in profile; samples/areas, not a print test',
  },
  'sla-resin': {
    id: 'sla-resin', label: 'SLA / DLP resin', family: 'additive', support: 'partial',
    verification: {
      method: 'wall/feature/gap + overhang/support + escape-passage (drainage) reachability',
      evaluator: 'check_printability', built: true,
      criteria: ['min-wall', 'min-feature', 'min-gap', 'overhang-angle', 'escape-passage'],
      inputs: ['resin profile', 'drain-hole location'],
      handoff: ['cup suction', 'shrink/warp', 'post-cure'],
    },
    note: 'the escape rule checks enclosed voids + hole diameters; it is reachability, not flow',
  },
  'sls-pa12': {
    id: 'sls-pa12', label: 'SLS / MJF PA12', family: 'additive', support: 'partial',
    verification: {
      method: 'wall/feature/gap + escape-passage (powder removal) reachability',
      evaluator: 'check_printability', built: true,
      criteria: ['min-wall', 'min-feature', 'min-gap', 'escape-passage'],
      inputs: ['powder profile', 'escape-hole location'],
      handoff: ['powder cleaning', 'nesting/orientation economics', 'warp/density'],
    },
    note: 'overhang is off (powder bed supports); escape is void reachability, not cleaning',
  },
  'injection-pp': {
    id: 'injection-pp', label: 'Injection molding (PP)', family: 'molding', support: 'partial',
    verification: {
      method: 'profile-driven wall/feature/gap + draft/undercut (draft solver when draftMinDeg is declared)',
      evaluator: 'check_printability', built: true,
      criteria: ['min-wall', 'min-feature', 'min-gap', 'draft (declared)', 'undercut (no feasible pull)'],
      inputs: ['polymer profile', 'min draft angle'],
      handoff: ['fill/pack', 'sink', 'warp', 'gate/cooling'],
    },
    note: 'the draft/undercut half is the same solver the die-casting profile uses',
  },
  'die-casting-alu': {
    id: 'die-casting-alu', label: 'Die casting (Al)', family: 'molding', support: 'partial',
    verification: {
      method: 'wall/feature/gap + draft/undercut via best-pull-direction draft solver',
      evaluator: 'check_printability', built: true,
      criteria: ['min-wall', 'min-feature', 'min-gap', 'draft', 'undercut (no feasible pull)'],
      inputs: ['min draft', 'alloy wall rules'],
      handoff: ['fill/porosity', 'thermal cracking', 'gates/overflow', 'die life'],
    },
    note: 'the solver finds a feasible pull direction and the worst face margin; it does not model metal flow',
  },
  'vacuum-forming': {
    id: 'vacuum-forming', label: 'Vacuum forming', family: 'molding', support: 'partial',
    verification: {
      method: 'wall/feature/gap + draft via best-pull-direction draft solver',
      evaluator: 'check_printability', built: true,
      criteria: ['min-wall (nominal)', 'min-feature', 'min-gap', 'draft'],
      inputs: ['sheet thickness', 'min draft', 'draw-ratio limit (handoff)'],
      handoff: ['draw ratio', 'thinning distribution', 'webbing', 'cooling'],
    },
    note: 'the wall number is nominal; actual wall thins with draw, which is a handoff',
  },
  'sand-casting': {
    id: 'sand-casting', label: 'Sand casting', family: 'molding', support: 'partial',
    verification: {
      method: 'wall/feature/gap + draft via best-pull-direction draft solver',
      evaluator: 'check_printability', built: true,
      criteria: ['min-wall', 'min-feature', 'min-gap', 'draft'],
      inputs: ['min draft', 'machining allowance'],
      handoff: ['shrinkage', 'porosity', 'sand defects', 'gating/risering'],
    },
    note: 'geometry screen only; gating/risering and shrinkage allowance are a casting handoff',
  },
  'forging': {
    id: 'forging', label: 'Forging (die)', family: 'forming', support: 'partial',
    verification: {
      method: 'wall/feature/gap + draft via best-pull-direction draft solver',
      evaluator: 'check_printability', built: true,
      criteria: ['min-wall', 'min-feature', 'min-gap', 'draft'],
      inputs: ['min draft', 'parting line (handoff)'],
      handoff: ['grain flow', 'flash', 'die wear', 'cracks'],
    },
    note: 'the parting line is not modelled; the solver only answers whether a pull direction exists',
  },
  'cnc-3axis': {
    id: 'cnc-3axis', label: 'CNC milling (3-axis / desktop)', family: 'subtractive', support: 'partial',
    verification: {
      method: 'wall/feature/gap + circular-bore tool radius + hole aspect (check_printability, shipped cnc-3axis profile)',
      evaluator: 'check_printability', built: true,
      criteria: ['min-wall', 'min-feature', 'min-gap', 'circular-bore tool radius', 'hole-aspect'],
      inputs: ['cutter radius', 'max depth/diameter', 'wall/feature/gap rules'],
      handoff: ['oblique setups', 'tool length/diameter/collision', 'fixturing', 'chatter/cost'],
      additional: [{
        evaluator: 'check_cnc_access', built: true,
        criteria: ['tool-access (six principal directions)', 'undercut (no principal access)', 'setup-count'],
        inputs: ['maxSetups', 'requireAllAccessible'],
      }],
    },
    note: 'partial: the profile covers circular bores/wall; check_cnc_access covers six-direction reach/setups; oblique setups and tool/fixture limits remain handoffs',
  },
  'cnc-turning': {
    id: 'cnc-turning', label: 'CNC turning (lathe)', family: 'subtractive', support: 'partial',
    verification: {
      method: 'bar-stock fit + L/D + rotational-symmetry deviation about the spindle axis (check_turning)',
      evaluator: 'check_turning', built: true,
      criteria: ['bar-stock-fit', 'ld-ratio', 'rotational-symmetry'],
      inputs: ['barDiameterMm', 'maxLdRatio', 'symmetryToleranceMm', 'requireSymmetry'],
      handoff: ['undercut / tool access along the profile', 'chatter/deflection', 'surface finish', 'bar feeder limits'],
    },
    note: 'partial: a non-symmetric part is a warning unless requireSymmetry; undercut/tool access are handoffs',
  },
  'laser-cut-sheet': {
    id: 'laser-cut-sheet', label: 'Laser cutting (sheet)', family: 'cutting', support: 'partial',
    verification: {
      method: '2D section screen: round-hole diameter + hole-to-outside wall + hole spacing, after kerf (check_sheet2d)',
      evaluator: 'check_sheet2d', built: true,
      criteria: ['min-hole (round)', 'min-feature (hole-to-outside)', 'min-spacing', 'kerf'],
      inputs: ['kerfMm', 'minHoleMm', 'minFeatureMm', 'minSpacingMm'],
      handoff: ['non-circular hole width', 'outer tabs/narrow ribs', 'heat-affected zone', 'taper', 'surface finish'],
    },
    note: 'partial: the section screen covers round holes/walls/spacing; non-circular holes and outer tabs are handoffs',
  },
  'waterjet': {
    id: 'waterjet', label: 'Waterjet (sheet/plate)', family: 'cutting', support: 'partial',
    verification: {
      method: '2D section screen: round-hole diameter + hole-to-outside wall + hole spacing, after kerf (check_sheet2d)',
      evaluator: 'check_sheet2d', built: true,
      criteria: ['min-hole (round)', 'min-feature (hole-to-outside)', 'min-spacing', 'kerf'],
      inputs: ['kerfMm', 'minHoleMm', 'minFeatureMm', 'minSpacingMm'],
      handoff: ['non-circular hole width', 'outer tabs/narrow ribs', 'taper vs thickness', 'surface finish', 'abrasive cost'],
    },
    note: 'same section screen as laser; taper is a handoff, not a geometric pass',
  },
  'sheet-metal-bend': {
    id: 'sheet-metal-bend', label: 'Sheet metal (laser + bend)', family: 'forming', support: 'partial',
    verification: {
      method: '2D cut section (round holes/walls/spacing, after kerf) + optional bend checks: hole-to-bend, min flange, bend-relief heuristic',
      evaluator: 'check_sheet2d', built: true,
      criteria: ['min-hole (round, cut)', 'min-feature (cut)', 'min-spacing (cut)', 'kerf', 'hole-to-bend', 'min-flange', 'bend-relief (heuristic)'],
      inputs: ['kerfMm', 'minHoleMm', 'minFeatureMm', 'minSpacingMm', 'bendLines (u/v)', 'minHoleToBendMm', 'minFlangeMm', 'minBendReliefMm'],
      handoff: ['flat pattern / K-factor', 'bend-relief notch geometry', 'springback', 'tooling limits'],
    },
    note: 'partial: cut features are exact; bend checks are heuristic (line/point distances); flat pattern/K-factor need bend angle+thickness',
  },
  'edm': {
    id: 'edm', label: 'EDM (wire/sink)', family: 'subtractive', support: 'partial',
    verification: {
      method: 'wall/feature/gap + circular-bore electrode/wire radius + hole aspect (check_printability, edm profile)',
      evaluator: 'check_printability', built: true,
      criteria: ['min-wall', 'min-feature', 'min-gap', 'circular-bore electrode radius', 'hole-aspect'],
      inputs: ['electrode/wire radius', 'max depth/diameter'],
      handoff: ['non-circular sinker pockets/electrode access', 'electrode wear', 'surface finish', 'burn time'],
      additional: [{
        evaluator: 'check_sheet2d', built: true,
        criteria: ['wire-cut round-hole', 'min-feature', 'min-spacing', 'kerf'],
        inputs: ['kerfMm', 'minHoleMm', 'minFeatureMm', 'minSpacingMm'],
      }, {
        evaluator: 'check_edm_access', built: true,
        criteria: ['electrode-access (single burn axis)'],
        inputs: ['burnAxis', 'requireAllReachable'],
      }],
    },
    note: 'partial: profile covers circular bores; check_sheet2d covers wire-cut 2D features; sinker electrode access is a handoff',
  },
  'extrusion': {
    id: 'extrusion', label: 'Profile extrusion', family: 'forming', support: 'partial',
    verification: {
      method: '2D section at mid-length: wall / round-hole / spacing, after kerf (check_sheet2d)',
      evaluator: 'check_sheet2d', built: true,
      criteria: ['min-wall', 'min-hole (round)', 'min-spacing'],
      inputs: ['kerfMm', 'minHoleMm', 'minFeatureMm', 'minSpacingMm'],
      handoff: ['constant-section check', 'die swell', 'cooling/warp', 'pull speed', 'hollow-section rule'],
    },
    note: 'a section screen, not an extrusion-die check; constant-section and die swell are handoffs',
  },

};

export function processCapability(id: string): ProcessCapability | null {
  return PROCESS_CATALOG[id] ?? null;
}
