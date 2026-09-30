import { describe, expect, it } from "vitest";
import { requiresFullEngineeringTools } from "../src/main/engineering/intent.js";

describe("engineering intent", () => {
  it("recognizes requests that need the full CAD and solver toolset", () => {
    expect(requiresFullEngineeringTools("Create a complete preliminary engineering project with FreeCAD and CalculiX simulation.")).toBe(true);
    expect(requiresFullEngineeringTools("Run an FEA simulation of this bracket.")).toBe(true);
  });

  it("does not block ordinary engineering discussion", () => {
    expect(requiresFullEngineeringTools("Explain why a bracket bends under load.")).toBe(false);
  });

  it("does not block a bare mention of 'simulation' with no engineering-project context", () => {
    // Regression test: the old regex matched the bare word "simulation"
    // anywhere in the message, so an unrelated conceptual question tripped
    // the same CAD/CalculiX refusal as an actual engineering request.
    expect(requiresFullEngineeringTools("What is a Monte Carlo simulation?")).toBe(false);
    expect(requiresFullEngineeringTools("Can you explain how weather simulation works?")).toBe(false);
  });

  it("still recognizes a simulation request when it names an engineering domain", () => {
    expect(requiresFullEngineeringTools("Please run a structural simulation on this bracket.")).toBe(true);
    expect(requiresFullEngineeringTools("Start a circuit simulation for this filter.")).toBe(true);
  });
});
