import { cn } from "@/lib/utils"

export interface StatusMessageProps {
  message: string
  isError: boolean
}

export function StatusMessage({ message, isError }: StatusMessageProps) {
  if (!message) return null
  return (
    <p className={cn("text-sm", isError ? "text-destructive" : "text-muted-foreground")}>
      {message}
    </p>
  )
}
