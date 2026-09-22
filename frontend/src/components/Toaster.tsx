import { CheckCircle2Icon, InfoIcon, Loader2Icon, XCircleIcon } from "lucide-react"
import { ToastAction, ToastClose, ToastProvider, ToastRoot, ToastTitle, ToastViewport } from "@/components/ui/toast"
import { dismissToast, useToasts } from "@/lib/toast"

const VARIANT_STYLE = {
  loading: { root: "default", icon: null },
  success: { root: "success", icon: <CheckCircle2Icon className="size-4 shrink-0 text-green-600 dark:text-green-400" /> },
  error: { root: "destructive", icon: <XCircleIcon className="size-4 shrink-0 text-destructive" /> },
  info: { root: "default", icon: <InfoIcon className="size-4 shrink-0 text-muted-foreground" /> },
} as const

export function Toaster() {
  const toasts = useToasts()

  return (
    <ToastProvider>
      {toasts.map(({ id, message, variant, actions }) => (
        <ToastRoot
          key={id}
          variant={VARIANT_STYLE[variant].root}
          onOpenChange={(open) => {
            if (!open) dismissToast(id)
          }}
        >
          {variant === "loading" ? (
            <Loader2Icon className="size-4 shrink-0 animate-spin" />
          ) : (
            VARIANT_STYLE[variant].icon
          )}
          <ToastTitle>{message}</ToastTitle>
          {actions?.map((action) => (
            <ToastAction
              key={action.label}
              altText={action.label}
              onClick={() => {
                action.onClick()
                dismissToast(id)
              }}
            >
              {action.label}
            </ToastAction>
          ))}
          {/* Loading toasts aren't dismissable - they represent an
              in-flight action and must stay until it resolves. */}
          {variant !== "loading" && <ToastClose />}
        </ToastRoot>
      ))}
      <ToastViewport />
    </ToastProvider>
  )
}
