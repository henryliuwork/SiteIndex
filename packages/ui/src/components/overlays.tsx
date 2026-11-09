import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "./primitives";

export function Drawer({ open, onOpenChange, title, description, children, footer, width = "standard", className = "" }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: "standard" | "wide";
  className?: string;
}) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const descriptionId = useId();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="si-drawer-overlay" />
        <Dialog.Content
          aria-describedby={description ? descriptionId : undefined}
          className={"si-drawer si-drawer-" + width + (className ? " " + className : "")}
          onOpenAutoFocus={() => {
            returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocusRef.current;
            returnFocusRef.current = null;
            if (target?.isConnected) target.focus();
          }}
        >
          <div className="si-drawer-heading">
            <div className="si-drawer-heading-copy">
              <Dialog.Title className="si-drawer-title">{title}</Dialog.Title>
              {description && <Dialog.Description id={descriptionId} className="si-drawer-description">{description}</Dialog.Description>}
            </div>
            <Dialog.Close asChild><button className="si-drawer-close" type="button" aria-label="关闭抽屉" title="关闭抽屉"><X size={16} aria-hidden="true" /></button></Dialog.Close>
          </div>
          <div className="si-drawer-content">{children}</div>
          {footer && <div className="si-drawer-footer">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export type ToastTone = "success" | "error" | "info";
export interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

interface ToastMessage {
  id: number;
  tone: ToastTone;
  message: string;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextId = useRef(0);
  const show = useCallback((tone: ToastTone, message: string) => {
    const id = ++nextId.current;
    setToasts((current) => [...current, { id, tone, message }].slice(-4));
  }, []);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const api = useMemo<ToastApi>(() => ({
    success: (message) => show("success", message),
    error: (message) => show("error", message),
    info: (message) => show("info", message),
  }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="si-toast-region" aria-label="通知">
        {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: number) => void }) {
  const dismiss = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);
  useEffect(() => {
    if (toast.tone === "error") return;
    const timer = window.setTimeout(dismiss, 3000);
    return () => window.clearTimeout(timer);
  }, [dismiss, toast.tone]);

  return (
    <div className={"si-toast si-toast-" + toast.tone} role={toast.tone === "error" ? "alert" : "status"} aria-atomic="true">
      <span>{toast.message}</span>
      <button type="button" aria-label="关闭通知" title="关闭通知" onClick={dismiss}><X size={14} aria-hidden="true" /></button>
    </div>
  );
}

export function useToast(): ToastApi {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast 必须在 ToastProvider 内使用。");
  return toast;
}
