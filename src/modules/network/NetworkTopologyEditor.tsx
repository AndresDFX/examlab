/**
 * NetworkTopologyEditor — editor GUI de topología de red para la pregunta
 * "Red (GUI)" (`red_gui`). El alumno CONSTRUYE/edita una topología visual
 * (hostnames, direccionamiento de interfaces, enlaces) y se serializa al MISMO
 * modelo `Topology` que la consola; la calificación reusa `gradeNetwork`
 * (mismas aserciones). Ver [docs/research/network-question-integrations.md].
 *
 * Sin dependencias nuevas (no React Flow): un diagrama SVG esquemático
 * (auto-layout) + formularios estructurados por dispositivo + editor de
 * enlaces. Reinicia desde la topología del escenario (parcial) y el alumno la
 * completa para cumplir las aserciones.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Network, Plus, Trash2, Link2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { RowAction } from "@/components/ui/row-action";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Device, type Topology } from "./topology";
import {
  type NetworkScenario,
  cloneTopology,
  parseNetworkAnswer,
  serializeNetworkAnswer,
} from "./scenario";

interface Props {
  scenario: NetworkScenario;
  /** Respuesta serializada previa (topología del alumno). Solo se lee al montar. */
  value?: string | null;
  onChange?: (serialized: string) => void;
  readOnly?: boolean;
}

const KIND_FILL: Record<string, string> = {
  router: "#e7f5ff",
  switch: "#fff8e1",
  pc: "#e6fcf5",
  server: "#f3f0ff",
};

export function NetworkTopologyEditor({ scenario, value, onChange, readOnly }: Props) {
  const { t } = useTranslation();
  const [topo, setTopo] = useState<Topology>(() => cloneTopology(scenario));
  const initedRef = useRef(false);

  // Init/reanudar UNA vez desde value (o el escenario). `value` solo al montar.
  useEffect(() => {
    if (initedRef.current) return;
    initedRef.current = true;
    const parsed = parseNetworkAnswer(value);
    if (parsed?.topology?.devices?.length) {
      setTopo(cloneTopology(parsed.topology));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Emite el cambio serializado (topología final; sin historial de comandos).
  const emit = (next: Topology) => {
    setTopo(next);
    onChange?.(serializeNetworkAnswer(next, {}));
  };

  const updateDevice = (id: string, patch: Partial<Device>) => {
    emit({
      ...topo,
      devices: topo.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    });
  };

  const updateIface = (
    devId: string,
    ifaceName: string,
    patch: Partial<{ ip: string | null; mask: string | null; up: boolean }>,
  ) => {
    emit({
      ...topo,
      devices: topo.devices.map((d) =>
        d.id === devId
          ? { ...d, interfaces: d.interfaces.map((i) => (i.name === ifaceName ? { ...i, ...patch } : i)) }
          : d,
      ),
    });
  };

  const removeLink = (idx: number) => {
    emit({ ...topo, links: topo.links.filter((_, i) => i !== idx) });
  };

  // Editor "agregar enlace": dos selects (dispositivo:interfaz).
  const [linkA, setLinkA] = useState("");
  const [linkB, setLinkB] = useState("");
  const ifaceOptions = topo.devices.flatMap((d) =>
    d.interfaces.map((i) => ({ value: `${d.id}::${i.name}`, label: `${d.name || d.id} · ${i.name}` })),
  );
  const addLink = () => {
    if (!linkA || !linkB || linkA === linkB) return;
    const [da, ia] = linkA.split("::");
    const [dbb, ib] = linkB.split("::");
    emit({
      ...topo,
      links: [...topo.links, { a: { device: da, iface: ia }, b: { device: dbb, iface: ib } }],
    });
    setLinkA("");
    setLinkB("");
  };

  // ── Diagrama SVG esquemático (auto-layout en grilla) ──
  const cols = Math.ceil(Math.sqrt(topo.devices.length)) || 1;
  const cellW = 150;
  const cellH = 96;
  const pad = 16;
  const pos = new Map<string, { x: number; y: number }>();
  topo.devices.forEach((d, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    pos.set(d.id, { x: pad + c * cellW + cellW / 2, y: pad + r * cellH + cellH / 2 });
  });
  const rows = Math.ceil(topo.devices.length / cols) || 1;
  const svgW = pad * 2 + cols * cellW;
  const svgH = pad * 2 + rows * cellH;

  return (
    <div className="rounded-md border overflow-hidden">
      {/* Diagrama */}
      <div className="bg-muted/30 p-2 overflow-x-auto">
        <div className="flex items-center gap-1.5 text-xs font-medium mb-1">
          <Network className="h-3.5 w-3.5" />
          {t("networkGui.diagramTitle", { defaultValue: "Diagrama" })}
        </div>
        <svg
          width={svgW}
          height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="max-w-full"
          role="img"
          aria-label={t("networkGui.diagramTitle", { defaultValue: "Diagrama" })}
        >
          {topo.links.map((l, i) => {
            const a = pos.get(l.a.device);
            const b = pos.get(l.b.device);
            if (!a || !b) return null;
            return (
              <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#94a3b8" strokeWidth={2} />
            );
          })}
          {topo.devices.map((d) => {
            const p = pos.get(d.id)!;
            const w = 110;
            const h = 44;
            return (
              <g key={d.id}>
                <rect
                  x={p.x - w / 2}
                  y={p.y - h / 2}
                  width={w}
                  height={h}
                  rx={6}
                  fill={KIND_FILL[d.kind] ?? "#eef2ff"}
                  stroke="#1e1e1e"
                  strokeWidth={1.5}
                />
                <text x={p.x} y={p.y - 2} textAnchor="middle" fontSize={12} fill="#1e1e1e">
                  {d.name || d.id}
                </text>
                <text x={p.x} y={p.y + 13} textAnchor="middle" fontSize={9} fill="#64748b">
                  {d.kind}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Revisión (readOnly): resumen NO editable del direccionamiento — es lo
          que se califica, así que debe verse (no solo el diagrama). */}
      {readOnly && (
        <div className="p-3 space-y-2 border-t text-xs">
          {topo.devices.map((d) => (
            <div key={d.id} className="rounded-md border p-2">
              <div className="font-mono font-medium">
                {d.name || d.id} <span className="opacity-60">({d.kind})</span>
              </div>
              {d.interfaces.map((i) => (
                <div key={i.name} className="pl-2 opacity-80 font-mono">
                  {i.name}: {i.ip ?? "—"}
                  {i.mask ? ` / ${i.mask}` : ""} ·{" "}
                  {i.up ? t("networkGui.up", { defaultValue: "activa" }) : "down"}
                </div>
              ))}
            </div>
          ))}
          {topo.links.length > 0 && (
            <div className="opacity-70">
              {t("networkGui.links", { defaultValue: "Enlaces" })}:{" "}
              {topo.links
                .map((l) => `${l.a.device}:${l.a.iface} ↔ ${l.b.device}:${l.b.iface}`)
                .join(" · ")}
            </div>
          )}
        </div>
      )}

      {/* Dispositivos + interfaces (edición) */}
      {!readOnly && (
        <div className="p-3 space-y-3 border-t">
          {topo.devices.map((d) => (
            <div key={d.id} className="rounded-md border p-2 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase text-muted-foreground w-14 shrink-0">{d.kind}</span>
                <Input
                  value={d.name}
                  onChange={(e) => updateDevice(d.id, { name: e.target.value })}
                  className="h-8 text-sm"
                  placeholder={t("networkGui.hostname", { defaultValue: "hostname" })}
                />
              </div>
              {d.interfaces.map((i) => (
                <div key={i.name} className="flex flex-wrap items-center gap-2 pl-2">
                  <span className="text-xs font-mono w-40 shrink-0 truncate">{i.name}</span>
                  <Input
                    value={i.ip ?? ""}
                    onChange={(e) => updateIface(d.id, i.name, { ip: e.target.value || null })}
                    className="h-7 text-xs w-32"
                    placeholder="IP"
                  />
                  <Input
                    value={i.mask ?? ""}
                    onChange={(e) => updateIface(d.id, i.name, { mask: e.target.value || null })}
                    className="h-7 text-xs w-32"
                    placeholder={t("networkGui.mask", { defaultValue: "máscara" })}
                  />
                  <label className="flex items-center gap-1 text-xs">
                    <Switch
                      checked={i.up}
                      onCheckedChange={(v) => updateIface(d.id, i.name, { up: v })}
                    />
                    {t("networkGui.up", { defaultValue: "activa" })}
                  </label>
                </div>
              ))}
            </div>
          ))}

          {/* Enlaces */}
          <div className="rounded-md border p-2 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <Link2 className="h-3.5 w-3.5" />
              {t("networkGui.links", { defaultValue: "Enlaces" })}
            </div>
            {topo.links.map((l, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="font-mono flex-1 truncate">
                  {l.a.device}:{l.a.iface} ↔ {l.b.device}:{l.b.iface}
                </span>
                <RowAction
                  label={t("networkGui.removeLink", { defaultValue: "Quitar enlace" })}
                  icon={Trash2}
                  tone="destructive"
                  onClick={() => removeLink(i)}
                />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Select value={linkA} onValueChange={setLinkA}>
                <SelectTrigger className="h-7 text-xs w-44">
                  <SelectValue placeholder={t("networkGui.endpointA", { defaultValue: "Extremo A" })} />
                </SelectTrigger>
                <SelectContent>
                  {ifaceOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={linkB} onValueChange={setLinkB}>
                <SelectTrigger className="h-7 text-xs w-44">
                  <SelectValue placeholder={t("networkGui.endpointB", { defaultValue: "Extremo B" })} />
                </SelectTrigger>
                <SelectContent>
                  {ifaceOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" size="sm" onClick={addLink} disabled={!linkA || !linkB || linkA === linkB}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                {t("networkGui.addLink", { defaultValue: "Agregar enlace" })}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
