import type React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// El componente usa supabase.storage y useAuth — mockeamos ambos para
// poder testar render + descarga + borrado sin tocar red.
const mockState = {
  signedUrl: "https://example.com/signed",
  signedUrlError: null as { message: string } | null,
  removeError: null as { message: string } | null,
  lastDeletePath: null as string | null,
  lastDeleteId: null as string | null,
  deleteError: null as { message: string } | null,
};

vi.mock("@/integrations/supabase/client", () => {
  return {
    supabase: {
      storage: {
        from: vi.fn(() => ({
          createSignedUrl: vi.fn(() =>
            Promise.resolve(
              mockState.signedUrlError
                ? { data: null, error: mockState.signedUrlError }
                : { data: { signedUrl: mockState.signedUrl }, error: null },
            ),
          ),
          remove: vi.fn((paths: string[]) => {
            mockState.lastDeletePath = paths[0];
            return Promise.resolve({ data: null, error: mockState.removeError });
          }),
        })),
      },
      from: vi.fn(() => ({
        delete: vi.fn(() => ({
          eq: vi.fn((_col: string, val: string) => {
            mockState.lastDeleteId = val;
            return Promise.resolve({ error: mockState.deleteError });
          }),
        })),
      })),
    },
  };
});

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "user-mine", email: "me@test" } }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// El componente usa useConfirm() en lugar de window.confirm nativo.
// Mockeamos el hook para que siempre resuelva según `confirmResult` —
// evita rendering del AlertDialog real (portal + radix) y permite
// controlar el flujo de confirmación por test.
const confirmResult = { value: true };
vi.mock("@/shared/components/ConfirmDialog", () => ({
  useConfirm: () => async () => confirmResult.value,
  ConfirmProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { FeedbackCommentAttachments } from "./FeedbackCommentAttachments";
import type { AttachmentRow } from "@/modules/grading/feedback-attachments";

const ROW_MINE: AttachmentRow = {
  id: "a-1",
  comment_id: "c-1",
  path: "user-mine/c-1/foto.png",
  name: "foto.png",
  mime_type: "image/png",
  size_bytes: 2048,
  uploaded_by: "user-mine",
  created_at: "2026-01-01T00:00:00Z",
};

const ROW_OTHER: AttachmentRow = {
  id: "a-2",
  comment_id: "c-1",
  path: "other-user/c-1/doc.pdf",
  name: "doc.pdf",
  mime_type: "application/pdf",
  size_bytes: 5 * 1024 * 1024,
  uploaded_by: "other-user",
  created_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  mockState.signedUrl = "https://example.com/signed";
  mockState.signedUrlError = null;
  mockState.removeError = null;
  mockState.lastDeletePath = null;
  mockState.lastDeleteId = null;
  mockState.deleteError = null;
  // Default: confirm() resuelve true. Tests que necesiten cancelar lo
  // setean a false explícitamente.
  confirmResult.value = true;
});

describe("FeedbackCommentAttachments — render", () => {
  it("no renderiza nada cuando attachments es vacío", () => {
    const { container } = render(<FeedbackCommentAttachments attachments={[]} />);
    expect(container.querySelector("[data-testid='feedback-attachments']")).toBeNull();
  });

  it("renderiza una fila por attachment", () => {
    render(<FeedbackCommentAttachments attachments={[ROW_MINE, ROW_OTHER]} />);
    expect(screen.getByText("foto.png")).toBeInTheDocument();
    expect(screen.getByText("doc.pdf")).toBeInTheDocument();
  });

  it("muestra el tamaño formateado en KB/MB", () => {
    render(<FeedbackCommentAttachments attachments={[ROW_MINE, ROW_OTHER]} />);
    expect(screen.getByText("2 KB")).toBeInTheDocument();
    expect(screen.getByText("5 MB")).toBeInTheDocument();
  });

  it("muestra 'Quitar' solo en adjuntos del usuario actual", () => {
    render(<FeedbackCommentAttachments attachments={[ROW_MINE, ROW_OTHER]} />);
    // Botón "Quitar foto.png" existe; "Quitar doc.pdf" NO.
    expect(screen.queryByRole("button", { name: /Quitar foto.png/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Quitar doc.pdf/ })).toBeNull();
  });

  it("oculta 'Quitar' cuando closed=true (incluso para mis propios)", () => {
    render(<FeedbackCommentAttachments attachments={[ROW_MINE]} closed />);
    expect(screen.queryByRole("button", { name: /Quitar/ })).toBeNull();
  });
});

describe("FeedbackCommentAttachments — borrado", () => {
  it("borra del storage + de la tabla al confirmar", async () => {
    const onChanged = vi.fn();
    render(<FeedbackCommentAttachments attachments={[ROW_MINE]} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: /Quitar foto.png/ }));
    // useConfirm devolvió true → ejecuta el delete
    expect(mockState.lastDeletePath).toBe(ROW_MINE.path);
    expect(mockState.lastDeleteId).toBe(ROW_MINE.id);
    expect(onChanged).toHaveBeenCalled();
  });

  it("NO borra si el usuario cancela el confirm", async () => {
    confirmResult.value = false;
    const onChanged = vi.fn();
    render(<FeedbackCommentAttachments attachments={[ROW_MINE]} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: /Quitar foto.png/ }));
    expect(mockState.lastDeletePath).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
