import { describe, expect, it } from "vitest";
import { type Assertion, gradeNetwork } from "./grading";
import { type Topology } from "./topology";

function configuredTopo(): Topology {
  return {
    devices: [
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
        id: "pc1",
        name: "PC1",
        kind: "pc",
        interfaces: [{ name: "GigabitEthernet0/0", ip: "192.168.1.10", mask: "255.255.255.0", up: true }],
      },
      {
        id: "pc2",
        name: "PC2",
        kind: "pc",
        interfaces: [{ name: "GigabitEthernet0/0", ip: "10.0.0.10", mask: "255.255.255.0", up: true }],
      },
    ],
    links: [
      { a: { device: "pc1", iface: "GigabitEthernet0/0" }, b: { device: "r1", iface: "GigabitEthernet0/0" } },
      { a: { device: "r1", iface: "GigabitEthernet0/1" }, b: { device: "pc2", iface: "GigabitEthernet0/0" } },
    ],
  };
}

describe("gradeNetwork — aserciones individuales", () => {
  it("hostname", () => {
    const topo = configuredTopo();
    expect(gradeNetwork({ topology: topo }, [{ kind: "hostname", device: "R1", equals: "R1", points: 1 }]).ratio).toBe(1);
    expect(gradeNetwork({ topology: topo }, [{ kind: "hostname", device: "R1", equals: "CORE", points: 1 }]).ratio).toBe(0);
  });

  it("interface_ip (con y sin máscara)", () => {
    const topo = configuredTopo();
    const ok: Assertion = { kind: "interface_ip", device: "R1", iface: "gi0/0", ip: "192.168.1.1", mask: "255.255.255.0", points: 2 };
    expect(gradeNetwork({ topology: topo }, [ok]).earned).toBe(2);
    // Nombre de interfaz abreviado en la aserción también resuelve.
    const badIp: Assertion = { kind: "interface_ip", device: "R1", iface: "GigabitEthernet0/0", ip: "192.168.1.99", points: 2 };
    expect(gradeNetwork({ topology: topo }, [badIp]).earned).toBe(0);
    const badMask: Assertion = { kind: "interface_ip", device: "R1", iface: "GigabitEthernet0/0", ip: "192.168.1.1", mask: "/25", points: 2 };
    expect(gradeNetwork({ topology: topo }, [badMask]).items[0].passed).toBe(false);
  });

  it("interface_up", () => {
    const topo = configuredTopo();
    expect(gradeNetwork({ topology: topo }, [{ kind: "interface_up", device: "R1", iface: "gi0/1", points: 1 }]).ratio).toBe(1);
    topo.devices[0].interfaces[1].up = false;
    expect(gradeNetwork({ topology: topo }, [{ kind: "interface_up", device: "R1", iface: "gi0/1", points: 1 }]).ratio).toBe(0);
  });

  it("connectivity end-to-end ruteada", () => {
    const topo = configuredTopo();
    expect(gradeNetwork({ topology: topo }, [{ kind: "connectivity", from: "PC1", toIp: "10.0.0.10", points: 3 }]).ratio).toBe(1);
    topo.devices[0].interfaces[1].up = false; // baja R1 Gi0/1 → se corta la ruta
    expect(gradeNetwork({ topology: topo }, [{ kind: "connectivity", from: "PC1", toIp: "10.0.0.10", points: 3 }]).ratio).toBe(0);
  });

  it("command_used (substring y regex)", () => {
    const topo = configuredTopo();
    const histories = {
      r1: ["enable", "configure terminal", "hostname R1", "ip address 192.168.1.1 255.255.255.0"],
    };
    expect(gradeNetwork({ topology: topo, histories }, [{ kind: "command_used", device: "R1", pattern: "hostname", points: 1 }]).ratio).toBe(1);
    expect(
      gradeNetwork({ topology: topo, histories }, [
        { kind: "command_used", device: "R1", pattern: "/ip address .*255\\.255\\.255\\.0/", points: 1 },
      ]).ratio,
    ).toBe(1);
    expect(gradeNetwork({ topology: topo, histories }, [{ kind: "command_used", device: "R1", pattern: "router ospf", points: 1 }]).ratio).toBe(0);
  });

  it("dispositivo/interfaz inexistente → falla con detalle", () => {
    const topo = configuredTopo();
    const r = gradeNetwork({ topology: topo }, [{ kind: "hostname", device: "NOPE", equals: "x", points: 1 }]);
    expect(r.items[0].passed).toBe(false);
    expect(r.items[0].detail).toContain("no encontrado");
  });
});

describe("gradeNetwork — puntaje agregado", () => {
  it("suma puntos y calcula ratio", () => {
    const topo = configuredTopo();
    const assertions: Assertion[] = [
      { kind: "hostname", device: "R1", equals: "R1", points: 1 },
      { kind: "interface_ip", device: "R1", iface: "gi0/0", ip: "192.168.1.1", mask: "255.255.255.0", points: 2 },
      { kind: "interface_ip", device: "R1", iface: "gi0/1", ip: "10.0.0.1", points: 2 },
      { kind: "connectivity", from: "PC1", toIp: "10.0.0.10", points: 5 },
      { kind: "hostname", device: "R1", equals: "WRONG", points: 2, label: "hostname alterno (debe fallar)" },
    ];
    const r = gradeNetwork({ topology: topo }, assertions);
    expect(r.total).toBe(12);
    expect(r.earned).toBe(10); // todo menos la aserción WRONG (2 pts)
    expect(r.ratio).toBeCloseTo(10 / 12, 5);
    expect(r.items).toHaveLength(5);
    expect(r.items[4].label).toBe("hostname alterno (debe fallar)");
    expect(r.items[4].passed).toBe(false);
  });

  it("total 0 → ratio 0 (sin división por cero)", () => {
    expect(gradeNetwork({ topology: configuredTopo() }, []).ratio).toBe(0);
  });
});
