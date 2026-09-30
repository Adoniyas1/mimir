/** Full engineering requests require the broad project/CAD/solver toolset.
 * A core-tier model is intentionally never given that surface, so this
 * detects requests that must be declined instead of answered with invented
 * CAD or simulation results.
 *
 * The bare word "simulation" used to be enough on its own to match — so
 * "what is a Monte Carlo simulation?" tripped the same CAD refusal as an
 * actual FreeCAD/CalculiX request. Simulation only counts now when it's
 * paired with an actual engineering-domain action (run/perform/start a
 * CAD/structural/thermal/electrical/circuit simulation); FreeCAD, CalculiX,
 * finite element, and FEA stay unqualified since those terms are already
 * specific enough not to appear in casual conversation. */
export function requiresFullEngineeringTools(userText: string): boolean {
  return /\b(?:full|complete|preliminary)\s+engineering\s+project\b|\b(?:FreeCAD|CalculiX|finite[ -]element|FEA)\b|\b(?:run|perform|start)\s+(?:an?\s+|the\s+)?(?:CAD|structural|thermal|electrical|circuit)\s+simulation\b/i.test(userText);
}
