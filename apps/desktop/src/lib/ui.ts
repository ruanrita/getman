import { create } from "zustand";

/** Transient UI state that is never persisted. */
export const useToast = create<{ message?: string; show(message: string): void }>((set) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    message: undefined,
    show: (message) => {
      clearTimeout(timer);
      set({ message });
      timer = setTimeout(() => set({ message: undefined }), 3000);
    },
  };
});

export function toast(message: string) {
  useToast.getState().show(message);
}

export function downloadText(filename: string, text: string, mime = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "export";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
