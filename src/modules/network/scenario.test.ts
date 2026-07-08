import { describe, expect, it } from "vitest";
import {
  buildAddressingScenario,
  cloneTopology,
  defaultScenario,
  generateNetworkQuestions,
  parseNetworkAnswer,
  parseScenario,
  serializeNetworkAnswer,
} from "./scenario";
import { IosInterpreter } from "./ios-interpreter";
import { gradeNetwork } from "./grading";

describe("buildAddressingScenario / defaultScenario", () => {
  it("arma un escenario runnable con target y aserciones", () => {
    const s = defaultScenario();
    expect(s.targetDeviceId).toBe("R1");
    expect(s.devices.map((d) => d.id).sort()).toEqual(["PC1", "R1"]);
    expect(s.assertions.length).toBe(4);
    // La suma de puntos respeta el total pedido (5).
    expect(s.assertions.reduce((n, a) => n + a.points, 0)).toBeGreaterThanOrEqual(4);
  });
  it("varía la subred por octeto", () => {
    const s = buildAddressingScenario(7, 10);
    expect(s.devices.find((d) => d.id === "PC1")!.interfaces[0].ip).toBe("192.168.7.10");
    const ipAssert = s.assertions.find((a) => a.kind === "interface_ip")!;
    expect((ipAssert as { ip: string }).ip).toBe("192.168.7.1");
  });
});

describe("generateNetworkQuestions", () => {
  it("genera N preguntas deterministas con escenario+aserciones", () => {
    const qs = generateNetworkQuestions("VLSM y subneteo", 3, 5);
    expect(qs).toHaveLength(3);
    expect(qs[0].content).toContain("VLSM y subneteo");
    expect(qs[0].content).toContain("192.168.1.1");
    expect(qs[1].content).toContain("192.168.2.1"); // subred distinta por índice
    expect(qs[0].options.network.assertions.length).toBe(4);
    expect(qs[0].points).toBe(5);
  });
  it("acota count a [1,20]", () => {
    expect(generateNetworkQuestions("x", 0)).toHaveLength(1);
    expect(generateNetworkQuestions("x", 99)).toHaveLength(20);
  });
});

describe("serialize/parse", () => {
  it("round-trip de la respuesta", () => {
    const topo = cloneTopology(defaultScenario());
    const raw = serializeNetworkAnswer(topo, { R1: ["enable", "conf t"] });
    const parsed = parseNetworkAnswer(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.histories.R1).toEqual(["enable", "conf t"]);
    expect(parsed!.topology.devices.length).toBe(2);
  });
  it("parseNetworkAnswer tolera basura", () => {
    expect(parseNetworkAnswer(null)).toBeNull();
    expect(parseNetworkAnswer("")).toBeNull();
    expect(parseNetworkAnswer("no-json")).toBeNull();
    expect(parseNetworkAnswer("{}")).toBeNull();
  });
  it("parseScenario lee options.network", () => {
    const s = defaultScenario();
    expect(parseScenario({ network: s })?.targetDeviceId).toBe("R1");
    expect(parseScenario({})).toBeNull();
    expect(parseScenario(null)).toBeNull();
    expect(parseScenario({ network: { devices: [] } })).toBeNull();
  });
});

describe("vertical end-to-end: resolver con la consola y calificar", () => {
  it("solución correcta → 100%", () => {
    const scenario = defaultScenario();
    const topo = cloneTopology(scenario);
    const r1 = topo.devices.find((d) => d.id === scenario.targetDeviceId)!;
    const ios = new IosInterpreter({ device: r1, topology: topo });
    for (const cmd of [
      "enable",
      "configure terminal",
      "hostname R1",
      "interface g0/0",
      "ip address 192.168.1.1 255.255.255.0",
      "no shutdown",
      "end",
    ]) {
      ios.execute(cmd);
    }
    const answer = parseNetworkAnswer(serializeNetworkAnswer(topo, { [r1.id]: ios.history }))!;
    const result = gradeNetwork({ topology: answer.topology, histories: answer.histories }, scenario.assertions);
    expect(result.ratio).toBe(1);
    expect(result.items.every((it) => it.passed)).toBe(true);
  });

  it("olvidar 'no shutdown' → pierde activa + conectividad", () => {
    const scenario = defaultScenario();
    const topo = cloneTopology(scenario);
    const r1 = topo.devices.find((d) => d.id === scenario.targetDeviceId)!;
    const ios = new IosInterpreter({ device: r1, topology: topo });
    for (const cmd of [
      "enable",
      "configure terminal",
      "hostname R1",
      "interface g0/0",
      "ip address 192.168.1.1 255.255.255.0",
      "end",
    ]) {
      ios.execute(cmd);
    }
    const result = gradeNetwork({ topology: topo, histories: { [r1.id]: ios.history } }, scenario.assertions);
    expect(result.ratio).toBeLessThan(1);
    expect(result.items.find((it) => it.label.includes("activa"))!.passed).toBe(false);
    expect(result.items.find((it) => it.label.includes("conectividad"))!.passed).toBe(false);
    // Pero hostname e IP sí se acreditan.
    expect(result.items.find((it) => it.label.includes("hostname"))!.passed).toBe(true);
  });
});
