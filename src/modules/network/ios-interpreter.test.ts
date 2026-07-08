import { describe, expect, it } from "vitest";
import { IosInterpreter, canonicalIface } from "./ios-interpreter";
import { type Topology, findInterface } from "./topology";

function makeTopo(): Topology {
  return {
    devices: [
      {
        id: "r1",
        name: "R1",
        kind: "router",
        interfaces: [
          { name: "GigabitEthernet0/0", ip: null, mask: null, up: false },
          { name: "GigabitEthernet0/1", ip: null, mask: null, up: false },
        ],
      },
      {
        id: "pc1",
        name: "PC1",
        kind: "pc",
        interfaces: [{ name: "GigabitEthernet0/0", ip: "192.168.1.10", mask: "255.255.255.0", up: true }],
      },
    ],
    links: [
      { a: { device: "r1", iface: "GigabitEthernet0/0" }, b: { device: "pc1", iface: "GigabitEthernet0/0" } },
    ],
  };
}

function iosOnR1() {
  const topo = makeTopo();
  const r1 = topo.devices.find((d) => d.id === "r1")!;
  return { topo, r1, ios: new IosInterpreter({ device: r1, topology: topo }) };
}

describe("canonicalIface", () => {
  it("normaliza abreviaturas al nombre completo", () => {
    expect(canonicalIface("g0/0")).toBe("GigabitEthernet0/0");
    expect(canonicalIface("gi0/0")).toBe("GigabitEthernet0/0");
    expect(canonicalIface("GigabitEthernet0/0")).toBe("GigabitEthernet0/0");
    expect(canonicalIface("fa0/1")).toBe("FastEthernet0/1");
    expect(canonicalIface("f0/1")).toBe("FastEthernet0/1");
    expect(canonicalIface("se0/0/0")).toBe("Serial0/0/0");
    expect(canonicalIface("lo0")).toBe("Loopback0");
    expect(canonicalIface("vlan1")).toBe("Vlan1");
  });
});

describe("IosInterpreter — modos y prompt", () => {
  it("transita user → priv → config → if → priv", () => {
    const { ios } = iosOnR1();
    expect(ios.prompt()).toBe("R1>");
    ios.execute("enable");
    expect(ios.prompt()).toBe("R1#");
    ios.execute("configure terminal");
    expect(ios.prompt()).toBe("R1(config)#");
    ios.execute("interface gi0/0");
    expect(ios.prompt()).toBe("R1(config-if)#");
    ios.execute("exit");
    expect(ios.prompt()).toBe("R1(config)#");
    ios.execute("end");
    expect(ios.prompt()).toBe("R1#");
  });

  it("hostname cambia el prompt", () => {
    const { ios, r1 } = iosOnR1();
    ios.execute("enable");
    ios.execute("conf t");
    ios.execute("hostname CORE");
    expect(r1.name).toBe("CORE");
    expect(ios.prompt()).toBe("CORE(config)#");
  });
});

describe("IosInterpreter — configuración de interfaz (con abreviaturas)", () => {
  it("ip address + no shutdown configuran la interfaz enlazada", () => {
    const { ios, r1 } = iosOnR1();
    ios.execute("en");
    ios.execute("conf t");
    ios.execute("int g0/0"); // abreviatura → GigabitEthernet0/0
    ios.execute("ip add 192.168.1.1 255.255.255.0"); // 'add' abrevia 'address'
    ios.execute("no shut");
    const gi = findInterface(r1, "GigabitEthernet0/0")!;
    expect(gi.ip).toBe("192.168.1.1");
    expect(gi.mask).toBe("255.255.255.0");
    expect(gi.up).toBe(true);
  });

  it("acepta prefijo como máscara y lo normaliza a dotted", () => {
    const { ios, r1 } = iosOnR1();
    ios.execute("enable");
    ios.execute("configure terminal");
    ios.execute("interface GigabitEthernet0/1");
    ios.execute("ip address 10.0.0.1 /24");
    expect(findInterface(r1, "GigabitEthernet0/1")!.mask).toBe("255.255.255.0");
  });

  it("shutdown baja la interfaz; no ip address la limpia", () => {
    const { ios, r1 } = iosOnR1();
    ios.execute("enable");
    ios.execute("conf t");
    ios.execute("interface gi0/0");
    ios.execute("ip address 192.168.1.1 255.255.255.0");
    ios.execute("no shutdown");
    ios.execute("shutdown");
    expect(findInterface(r1, "GigabitEthernet0/0")!.up).toBe(false);
    ios.execute("no ip address");
    expect(findInterface(r1, "GigabitEthernet0/0")!.ip).toBeNull();
  });
});

describe("IosInterpreter — show y ping", () => {
  it("show running-config refleja la configuración", () => {
    const { ios } = iosOnR1();
    ios.execute("enable");
    ios.execute("conf t");
    ios.execute("hostname CORE");
    ios.execute("interface gi0/0");
    ios.execute("ip address 192.168.1.1 255.255.255.0");
    ios.execute("no shutdown");
    ios.execute("end");
    const run = ios.execute("show running-config").join("\n");
    expect(run).toContain("hostname CORE");
    expect(run).toContain("interface GigabitEthernet0/0");
    expect(run).toContain("ip address 192.168.1.1 255.255.255.0");
  });

  it("show ip interface brief lista interfaces con estado", () => {
    const { ios } = iosOnR1();
    ios.execute("enable");
    ios.execute("conf t");
    ios.execute("interface gi0/0");
    ios.execute("ip address 192.168.1.1 255.255.255.0");
    ios.execute("no shutdown");
    ios.execute("end");
    const out = ios.execute("sh ip int br").join("\n");
    expect(out).toContain("GigabitEthernet0/0");
    expect(out).toContain("192.168.1.1");
    expect(out).toMatch(/GigabitEthernet0\/1\s+unassigned/);
  });

  it("ping falla sin la interfaz activa y funciona tras no shutdown", () => {
    const { ios } = iosOnR1();
    ios.execute("enable");
    ios.execute("conf t");
    ios.execute("interface gi0/0");
    ios.execute("ip address 192.168.1.1 255.255.255.0");
    // sin 'no shutdown' todavía
    ios.execute("end");
    expect(ios.execute("ping 192.168.1.10").join("\n")).toContain("0 percent");
    // ahora la levantamos
    ios.execute("conf t");
    ios.execute("interface gi0/0");
    ios.execute("no shutdown");
    ios.execute("end");
    expect(ios.execute("ping 192.168.1.10").join("\n")).toContain("100 percent");
  });
});

describe("IosInterpreter — errores y utilidades", () => {
  it("comando desconocido → % Invalid input", () => {
    const { ios } = iosOnR1();
    ios.execute("enable");
    expect(ios.execute("foobar")[0]).toContain("% Invalid input");
  });

  it("registra el historial de comandos ejecutados", () => {
    const { ios } = iosOnR1();
    ios.execute("enable");
    ios.execute("conf t");
    ios.execute("");
    expect(ios.history).toEqual(["enable", "conf t"]); // la línea vacía no se registra
  });

  it("ip address inválida es rechazada", () => {
    const { ios } = iosOnR1();
    ios.execute("enable");
    ios.execute("conf t");
    ios.execute("interface gi0/0");
    expect(ios.execute("ip address 999.1.1.1 255.255.255.0")[0]).toContain("Invalid IP");
  });
});
