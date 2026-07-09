import { describe, expect, it } from "vitest";
import {
  type Topology,
  canReach,
  deviceOwningIp,
  ipToInt,
  maskToPrefix,
  networkAddress,
  parseIp,
  sameSubnet,
} from "./topology";

describe("parseIp", () => {
  it("parsea IPs válidas", () => {
    expect(parseIp("192.168.1.1")).toEqual([192, 168, 1, 1]);
    expect(parseIp("0.0.0.0")).toEqual([0, 0, 0, 0]);
    expect(parseIp("255.255.255.255")).toEqual([255, 255, 255, 255]);
  });
  it("rechaza inválidas", () => {
    expect(parseIp("256.1.1.1")).toBeNull();
    expect(parseIp("1.2.3")).toBeNull();
    expect(parseIp("1.2.3.4.5")).toBeNull();
    expect(parseIp("a.b.c.d")).toBeNull();
    expect(parseIp("")).toBeNull();
    expect(parseIp(null)).toBeNull();
    expect(parseIp("192.168.01.1")).toEqual([192, 168, 1, 1]); // ceros a la izq permitidos
  });
});

describe("maskToPrefix", () => {
  it("dotted → prefijo", () => {
    expect(maskToPrefix("255.255.255.0")).toBe(24);
    expect(maskToPrefix("255.255.0.0")).toBe(16);
    expect(maskToPrefix("255.0.0.0")).toBe(8);
    expect(maskToPrefix("255.255.255.192")).toBe(26);
    expect(maskToPrefix("0.0.0.0")).toBe(0);
    expect(maskToPrefix("255.255.255.255")).toBe(32);
  });
  it("prefijo numérico o /N", () => {
    expect(maskToPrefix("24")).toBe(24);
    expect(maskToPrefix("/24")).toBe(24);
    expect(maskToPrefix("/0")).toBe(0);
    expect(maskToPrefix("32")).toBe(32);
  });
  it("rechaza máscaras no contiguas / inválidas", () => {
    expect(maskToPrefix("255.0.255.0")).toBeNull();
    expect(maskToPrefix("255.255.255.256")).toBeNull();
    expect(maskToPrefix("33")).toBeNull();
    expect(maskToPrefix(null)).toBeNull();
  });
});

describe("ipToInt / networkAddress / sameSubnet", () => {
  it("ipToInt", () => {
    expect(ipToInt("0.0.0.0")).toBe(0);
    expect(ipToInt("255.255.255.255")).toBe(4294967295);
    expect(ipToInt("192.168.1.1")).toBe(3232235777);
  });
  it("networkAddress", () => {
    expect(networkAddress("192.168.1.130", 25)).toBe(ipToInt("192.168.1.128"));
    expect(networkAddress("10.5.7.3", 8)).toBe(ipToInt("10.0.0.0"));
    expect(networkAddress("1.2.3.4", 0)).toBe(0);
  });
  it("sameSubnet", () => {
    expect(sameSubnet("192.168.1.10", "192.168.1.20", "255.255.255.0")).toBe(true);
    expect(sameSubnet("192.168.1.10", "192.168.2.20", "/24")).toBe(false);
    expect(sameSubnet("10.0.0.1", "10.0.255.254", "255.255.0.0")).toBe(true);
    expect(sameSubnet("192.168.1.130", "192.168.1.10", "/25")).toBe(false); // .128/25 vs .0/25
    expect(sameSubnet("1.1.1.1", "2.2.2.2", "bad")).toBe(false);
  });
});

// Topología: PC1 — SW1 — R1 — SW2 — PC2 (dos subredes ruteadas por R1).
function makeTopo(): Topology {
  return {
    devices: [
      {
        id: "pc1",
        name: "PC1",
        kind: "pc",
        interfaces: [{ name: "GigabitEthernet0/0", ip: "192.168.1.10", mask: "255.255.255.0", up: true }],
      },
      {
        id: "sw1",
        name: "SW1",
        kind: "switch",
        interfaces: [
          { name: "GigabitEthernet0/1", ip: null, mask: null, up: true },
          { name: "GigabitEthernet0/2", ip: null, mask: null, up: true },
        ],
      },
      {
        id: "r1",
        name: "R1",
        kind: "router",
        interfaces: [
          { name: "GigabitEthernet0/0", ip: "192.168.1.1", mask: "255.255.255.0", up: true },
          { name: "GigabitEthernet0/1", ip: "10.0.0.1", mask: "255.255.255.0", up: true },
        ],
      },
      {
        id: "sw2",
        name: "SW2",
        kind: "switch",
        interfaces: [
          { name: "GigabitEthernet0/1", ip: null, mask: null, up: true },
          { name: "GigabitEthernet0/2", ip: null, mask: null, up: true },
        ],
      },
      {
        id: "pc2",
        name: "PC2",
        kind: "pc",
        interfaces: [{ name: "GigabitEthernet0/0", ip: "10.0.0.10", mask: "255.255.255.0", up: true }],
      },
    ],
    links: [
      { a: { device: "pc1", iface: "GigabitEthernet0/0" }, b: { device: "sw1", iface: "GigabitEthernet0/1" } },
      { a: { device: "sw1", iface: "GigabitEthernet0/2" }, b: { device: "r1", iface: "GigabitEthernet0/0" } },
      { a: { device: "r1", iface: "GigabitEthernet0/1" }, b: { device: "sw2", iface: "GigabitEthernet0/1" } },
      { a: { device: "sw2", iface: "GigabitEthernet0/2" }, b: { device: "pc2", iface: "GigabitEthernet0/0" } },
    ],
  };
}

describe("deviceOwningIp", () => {
  it("encuentra el dueño de una IP", () => {
    const topo = makeTopo();
    expect(deviceOwningIp(topo, "10.0.0.10")?.id).toBe("pc2");
    expect(deviceOwningIp(topo, "192.168.1.1")?.id).toBe("r1");
    expect(deviceOwningIp(topo, "8.8.8.8")).toBeUndefined();
  });
});

describe("canReach", () => {
  it("same-subnet vía switch", () => {
    const topo = makeTopo();
    expect(canReach(topo, "pc1", "192.168.1.1")).toBe(true); // PC1 → R1 gw
  });
  it("cross-subnet ruteado por R1", () => {
    const topo = makeTopo();
    expect(canReach(topo, "pc1", "10.0.0.10")).toBe(true); // PC1 → PC2
    expect(canReach(topo, "pc1", "10.0.0.1")).toBe(true); // PC1 → R1 far iface
  });
  it("IP inexistente → false", () => {
    expect(canReach(makeTopo(), "pc1", "8.8.8.8")).toBe(false);
  });
  it("interfaz del router abajo corta el ruteo", () => {
    const topo = makeTopo();
    topo.devices.find((d) => d.id === "r1")!.interfaces[1].up = false; // R1 Gi0/1 down
    expect(canReach(topo, "pc1", "10.0.0.10")).toBe(false);
    expect(canReach(topo, "pc1", "192.168.1.1")).toBe(true); // subred cercana sigue OK
  });
  it("origen sin IP activa no puede hacer ping", () => {
    const topo = makeTopo();
    topo.devices.find((d) => d.id === "pc1")!.interfaces[0].up = false;
    expect(canReach(topo, "pc1", "192.168.1.1")).toBe(false);
  });
  it("destino en interfaz caída no es alcanzable", () => {
    const topo = makeTopo();
    topo.devices.find((d) => d.id === "pc2")!.interfaces[0].up = false;
    expect(canReach(topo, "pc1", "10.0.0.10")).toBe(false);
  });
  it("endpoints no reenvían (PC no rutea)", () => {
    // Si reemplazamos R1 por un PC, deja de rutear entre subredes.
    const topo = makeTopo();
    topo.devices.find((d) => d.id === "r1")!.kind = "pc";
    expect(canReach(topo, "pc1", "10.0.0.10")).toBe(false);
    expect(canReach(topo, "pc1", "192.168.1.1")).toBe(true); // pero sigue siendo alcanzable como destino
  });

  // ── Adversariales (validación de errores 2026-07-08): grading = notas reales ──
  it("conectividad multi-salto a través de DOS routers", () => {
    // PC_A — R1 — R2 — PC_B (dos routers en el camino).
    const topo: Topology = {
      devices: [
        { id: "A", name: "A", kind: "pc", interfaces: [{ name: "e0", ip: "10.0.1.2", mask: "255.255.255.0", up: true }] },
        { id: "R1", name: "R1", kind: "router", interfaces: [{ name: "e0", ip: "10.0.1.1", mask: "255.255.255.0", up: true }, { name: "e1", ip: "10.0.2.1", mask: "255.255.255.0", up: true }] },
        { id: "R2", name: "R2", kind: "router", interfaces: [{ name: "e0", ip: "10.0.2.2", mask: "255.255.255.0", up: true }, { name: "e1", ip: "10.0.3.1", mask: "255.255.255.0", up: true }] },
        { id: "B", name: "B", kind: "pc", interfaces: [{ name: "e0", ip: "10.0.3.2", mask: "255.255.255.0", up: true }] },
      ],
      links: [
        { a: { device: "A", iface: "e0" }, b: { device: "R1", iface: "e0" } },
        { a: { device: "R1", iface: "e1" }, b: { device: "R2", iface: "e0" } },
        { a: { device: "R2", iface: "e1" }, b: { device: "B", iface: "e0" } },
      ],
    };
    expect(canReach(topo, "A", "10.0.3.2")).toBe(true);
    // Si baja una interfaz intermedia de R2, se corta.
    topo.devices.find((d) => d.id === "R2")!.interfaces[1].up = false;
    expect(canReach(topo, "A", "10.0.3.2")).toBe(false);
  });

  it("BFS termina con ciclos de switches (no loop infinito)", () => {
    // Triángulo SW1-SW2-SW3 + un PC en cada uno. Debe alcanzar sin colgarse.
    const sw = (id: string) => ({
      id,
      name: id,
      kind: "switch" as const,
      interfaces: [
        { name: "g0", ip: null, mask: null, up: true },
        { name: "g1", ip: null, mask: null, up: true },
        { name: "g2", ip: null, mask: null, up: true },
      ],
    });
    const topo: Topology = {
      devices: [
        sw("S1"),
        sw("S2"),
        sw("S3"),
        { id: "P1", name: "P1", kind: "pc", interfaces: [{ name: "e0", ip: "172.16.0.1", mask: "255.255.0.0", up: true }] },
        { id: "P2", name: "P2", kind: "pc", interfaces: [{ name: "e0", ip: "172.16.0.2", mask: "255.255.0.0", up: true }] },
      ],
      links: [
        { a: { device: "S1", iface: "g0" }, b: { device: "S2", iface: "g0" } },
        { a: { device: "S2", iface: "g1" }, b: { device: "S3", iface: "g0" } },
        { a: { device: "S3", iface: "g1" }, b: { device: "S1", iface: "g1" } }, // cierra el ciclo
        { a: { device: "P1", iface: "e0" }, b: { device: "S1", iface: "g2" } },
        { a: { device: "P2", iface: "e0" }, b: { device: "S3", iface: "g2" } },
      ],
    };
    expect(canReach(topo, "P1", "172.16.0.2")).toBe(true);
  });
});
