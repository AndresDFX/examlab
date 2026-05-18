import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectTenantSlug,
  clearTenantCache,
  applyTenantBranding,
  buildTenantInviteUrl,
} from "./tenant";

const STORAGE_KEY = "examlab.active_tenant_slug";

// jsdom permite mutar location.hostname con cuidado.
function mockHost(host: string, search = "") {
  Object.defineProperty(window, "location", {
    writable: true,
    value: {
      href: `https://${host}/path${search}`,
      hostname: host,
      protocol: "https:",
      pathname: "/path",
      search,
      origin: `https://${host}`,
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  clearTenantCache();
});

afterEach(() => {
  window.localStorage.clear();
  clearTenantCache();
});

describe("detectTenantSlug — subdomain", () => {
  it("extrae subdomain válido", () => {
    mockHost("uni.examlab.com");
    expect(detectTenantSlug()).toBe("uni");
  });

  it("acepta slug con guiones y dígitos", () => {
    mockHost("uni-bog-2026.examlab.com");
    expect(detectTenantSlug()).toBe("uni-bog-2026");
  });

  it("ignora subdominios reservados", () => {
    mockHost("www.examlab.com");
    expect(detectTenantSlug()).toBeNull();
    mockHost("app.examlab.com");
    expect(detectTenantSlug()).toBeNull();
    mockHost("admin.examlab.com");
    expect(detectTenantSlug()).toBeNull();
    mockHost("api.examlab.com");
    expect(detectTenantSlug()).toBeNull();
  });

  it("ignora host sin subdomain (dominio raíz)", () => {
    mockHost("examlab.com");
    expect(detectTenantSlug()).toBeNull();
  });

  it("ignora localhost y bare hostnames", () => {
    mockHost("localhost");
    expect(detectTenantSlug()).toBeNull();
  });

  it("rechaza slugs con formato inválido", () => {
    mockHost("UPPERCASE.examlab.com");
    expect(detectTenantSlug()).toBeNull();
    mockHost("with_underscore.examlab.com");
    expect(detectTenantSlug()).toBeNull();
  });
});

describe("detectTenantSlug — query param fallback", () => {
  it("usa ?tenant=slug cuando no hay subdomain", () => {
    mockHost("examlab.com", "?tenant=uni");
    expect(detectTenantSlug()).toBe("uni");
  });

  it("persiste el slug en localStorage al usar query param", () => {
    mockHost("examlab.com", "?tenant=uni-x");
    detectTenantSlug();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("uni-x");
  });

  it("subdomain tiene prioridad sobre query param", () => {
    mockHost("uni.examlab.com", "?tenant=other");
    expect(detectTenantSlug()).toBe("uni");
  });

  it("rechaza query param con formato inválido", () => {
    mockHost("examlab.com", "?tenant=INVALID_UPPER");
    expect(detectTenantSlug()).toBeNull();
  });
});

describe("detectTenantSlug — localStorage fallback", () => {
  it("usa localStorage si no hay subdomain ni query param", () => {
    window.localStorage.setItem(STORAGE_KEY, "stored-slug");
    mockHost("examlab.com");
    expect(detectTenantSlug()).toBe("stored-slug");
  });

  it("rechaza valor inválido en localStorage", () => {
    window.localStorage.setItem(STORAGE_KEY, "Invalid_Slug");
    mockHost("examlab.com");
    expect(detectTenantSlug()).toBeNull();
  });

  it("normaliza a minúsculas el slug almacenado", () => {
    window.localStorage.setItem(STORAGE_KEY, "MixedCase-Slug");
    mockHost("examlab.com");
    // El validador rechaza mayúsculas → null
    expect(detectTenantSlug()).toBeNull();
  });
});

describe("detectTenantSlug — orden de prioridad", () => {
  it("subdomain > query param > localStorage", () => {
    window.localStorage.setItem(STORAGE_KEY, "from-storage");
    mockHost("from-subdomain.examlab.com", "?tenant=from-query");
    expect(detectTenantSlug()).toBe("from-subdomain");
  });

  it("query param > localStorage cuando no hay subdomain", () => {
    window.localStorage.setItem(STORAGE_KEY, "from-storage");
    mockHost("examlab.com", "?tenant=from-query");
    expect(detectTenantSlug()).toBe("from-query");
  });

  it("localStorage cuando subdomain reservado y sin query param", () => {
    window.localStorage.setItem(STORAGE_KEY, "from-storage");
    mockHost("www.examlab.com");
    expect(detectTenantSlug()).toBe("from-storage");
  });
});

describe("clearTenantCache", () => {
  it("borra el slug almacenado en localStorage", () => {
    window.localStorage.setItem(STORAGE_KEY, "uni");
    clearTenantCache();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("buildTenantInviteUrl", () => {
  it("usa origin explícito cuando se pasa", () => {
    expect(buildTenantInviteUrl("uni", "https://examlab.com")).toBe(
      "https://examlab.com/?tenant=uni",
    );
  });

  it("quita trailing slash del origin", () => {
    expect(buildTenantInviteUrl("uni", "https://examlab.com/")).toBe(
      "https://examlab.com/?tenant=uni",
    );
    expect(buildTenantInviteUrl("uni", "https://examlab.com///")).toBe(
      "https://examlab.com/?tenant=uni",
    );
  });

  it("usa window.location.origin cuando no se pasa origin", () => {
    mockHost("app.examlab.com");
    expect(buildTenantInviteUrl("uni")).toBe("https://app.examlab.com/?tenant=uni");
  });

  it("encoda el slug para URL safety", () => {
    // Si el slug llegara con caracteres raros (no debería pero por defensa),
    // el query param se debe escapar correctamente.
    expect(buildTenantInviteUrl("a b", "https://x.com")).toBe(
      "https://x.com/?tenant=a%20b",
    );
  });

  it("acepta slugs con guiones y dígitos", () => {
    expect(buildTenantInviteUrl("uni-2026", "https://x.com")).toBe(
      "https://x.com/?tenant=uni-2026",
    );
  });
});

describe("applyTenantBranding", () => {
  afterEach(() => {
    // Limpia las CSS vars que se pudieron haber seteado
    document.documentElement.style.removeProperty("--tenant-primary");
    document.documentElement.style.removeProperty("--tenant-secondary");
  });

  it("setea ambas CSS variables cuando el tenant trae colores", () => {
    applyTenantBranding({
      id: "t",
      slug: "x",
      name: "X",
      status: "active",
      logo_url: null,
      primary_color: "#ff0000",
      secondary_color: "#00ff00",
    });
    expect(document.documentElement.style.getPropertyValue("--tenant-primary")).toBe("#ff0000");
    expect(document.documentElement.style.getPropertyValue("--tenant-secondary")).toBe("#00ff00");
  });

  it("solo setea --tenant-primary si secondary_color es null", () => {
    applyTenantBranding({
      id: "t",
      slug: "x",
      name: "X",
      status: "active",
      logo_url: null,
      primary_color: "#abcdef",
      secondary_color: null,
    });
    expect(document.documentElement.style.getPropertyValue("--tenant-primary")).toBe("#abcdef");
    expect(document.documentElement.style.getPropertyValue("--tenant-secondary")).toBe("");
  });

  it("limpia las CSS vars si el tenant no trae colores", () => {
    // Setea valores previos
    document.documentElement.style.setProperty("--tenant-primary", "#stale");
    document.documentElement.style.setProperty("--tenant-secondary", "#stale");

    applyTenantBranding({
      id: "t",
      slug: "x",
      name: "X",
      status: "active",
      logo_url: null,
      primary_color: null,
      secondary_color: null,
    });

    expect(document.documentElement.style.getPropertyValue("--tenant-primary")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--tenant-secondary")).toBe("");
  });

  it("limpia las CSS vars cuando se llama con null (logout)", () => {
    document.documentElement.style.setProperty("--tenant-primary", "#stale");
    document.documentElement.style.setProperty("--tenant-secondary", "#stale");

    applyTenantBranding(null);

    expect(document.documentElement.style.getPropertyValue("--tenant-primary")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--tenant-secondary")).toBe("");
  });
});
