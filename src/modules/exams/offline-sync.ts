/**
 * Offline Sync Module
 * Stores exam answers in IndexedDB when offline and syncs when back online.
 */
import { get, set, del, keys } from "idb-keyval";
import { supabase } from "@/integrations/supabase/client";

const PENDING_PREFIX = "pending-sync-";

export interface PendingAnswer {
  submissionId: string;
  answers: Record<string, any>;
  warnings: number;
  timestamp: number;
}

/** Save answers locally (IndexedDB) for offline resilience */
export async function saveAnswersLocally(examId: string, data: PendingAnswer): Promise<void> {
  try {
    await set(`${PENDING_PREFIX}${examId}`, data);
  } catch {
    // Fallback to localStorage
    try {
      localStorage.setItem(`${PENDING_PREFIX}${examId}`, JSON.stringify(data));
    } catch {
      /* silent */
    }
  }
}

/** Remove local answers after successful sync */
export async function clearLocalAnswers(examId: string): Promise<void> {
  try {
    await del(`${PENDING_PREFIX}${examId}`);
  } catch {
    /* silent */
  }
  try {
    localStorage.removeItem(`${PENDING_PREFIX}${examId}`);
  } catch {
    /* silent */
  }
}

/** Get all pending syncs */
export async function getPendingSyncs(): Promise<{ examId: string; data: PendingAnswer }[]> {
  const results: { examId: string; data: PendingAnswer }[] = [];

  // Check IndexedDB
  try {
    const allKeys = await keys();
    for (const key of allKeys) {
      const k = String(key);
      if (k.startsWith(PENDING_PREFIX)) {
        const examId = k.replace(PENDING_PREFIX, "");
        const data = await get(k);
        if (data) results.push({ examId, data: data as PendingAnswer });
      }
    }
  } catch {
    /* silent */
  }

  // Check localStorage fallback
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PENDING_PREFIX)) {
        const examId = key.replace(PENDING_PREFIX, "");
        const raw = localStorage.getItem(key);
        if (raw) {
          try {
            results.push({ examId, data: JSON.parse(raw) });
          } catch {
            /* silent */
          }
        }
      }
    }
  } catch {
    /* silent */
  }

  return results;
}

/** Sync all pending answers to Supabase */
export async function syncPendingAnswers(): Promise<number> {
  const pending = await getPendingSyncs();
  let synced = 0;

  for (const { examId, data } of pending) {
    try {
      const { error } = await supabase
        .from("submissions")
        .update({
          answers: data.answers,
          focus_warnings: data.warnings,
        })
        .eq("id", data.submissionId);

      if (!error) {
        await clearLocalAnswers(examId);
        synced++;
      }
    } catch {
      // Will retry on next online event
    }
  }

  return synced;
}

/** Check if browser is online */
export function isOnline(): boolean {
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

/** Setup online/offline listeners for auto-sync */
export function setupOfflineSync(onSync?: (count: number) => void): () => void {
  const handleOnline = async () => {
    const count = await syncPendingAnswers();
    if (count > 0) onSync?.(count);
  };

  window.addEventListener("online", handleOnline);

  // Also try to sync on load if online
  if (isOnline()) {
    syncPendingAnswers().then((count) => {
      if (count > 0) onSync?.(count);
    });
  }

  return () => {
    window.removeEventListener("online", handleOnline);
  };
}
