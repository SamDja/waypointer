import { useRef, useState, type DragEvent } from "react"
import { Button } from "@/components/ui/button"
import { WahooImportDialog } from "@/components/WahooImportDialog"
import { toast, updateToast } from "@/lib/toast"
import { missingWahooScopeWarning } from "@/lib/wahooAuth"
import { connectWahoo } from "@/lib/wahooConnect"
import { type WahooTokens } from "@/lib/wahooSettings"
import { cn } from "@/lib/utils"
import { FileUp } from "lucide-react"

export interface ImportCardProps {
  file: File | null
  onFileChange: (file: File) => void
  wahooTokens: WahooTokens | null
  onWahooTokensChange: (tokens: WahooTokens | null) => void
}

export function ImportCard({ file, onFileChange, wahooTokens, onWahooTokensChange }: ImportCardProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragActive, setIsDragActive] = useState(false)
  const [isConnectingWahoo, setIsConnectingWahoo] = useState(false)
  const [showWahooImport, setShowWahooImport] = useState(false)

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragActive(false)
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) onFileChange(dropped)
  }

  async function handleConnectWahoo() {
    setIsConnectingWahoo(true)
    const toastId = toast("Connecting to Wahoo...", "loading")
    try {
      const tokens = await connectWahoo()
      onWahooTokensChange(tokens)
      const scopeWarning = missingWahooScopeWarning(tokens)
      updateToast(toastId, scopeWarning ?? "Connected to Wahoo.", scopeWarning !== null ? "error" : "success")
    } catch (err) {
      updateToast(toastId, err instanceof Error ? err.message : "Failed to connect to Wahoo.", "error")
    } finally {
      setIsConnectingWahoo(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragActive(true)
        }}
        onDragLeave={() => setIsDragActive(false)}
        onDrop={handleDrop}
        className={cn(
          "flex flex-col items-center gap-3 rounded-md border-2 border-dashed p-6 text-center transition-colors",
          isDragActive ? "border-primary bg-accent" : "border-input"
        )}
      >
        <FileUp size={48} strokeWidth={1}></FileUp>
        <p className="text-sm text-muted-foreground">
          {file ? file.name : "Drag and drop a GPX file here"}
        </p>
        <Button type="button" onClick={() => inputRef.current?.click()}>
          Choose File
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".gpx"
          className="hidden"
          onChange={(e) => {
            const selected = e.target.files?.[0]
            if (selected) onFileChange(selected)
          }}
        />
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      {wahooTokens ? (
        <Button variant="secondary" className="w-full" onClick={() => setShowWahooImport(true)}>
          Import from Wahoo
        </Button>
      ) : (
        <Button
          variant="secondary"
          className="w-full"
          loading={isConnectingWahoo}
          onClick={handleConnectWahoo}
        >
          {isConnectingWahoo ? "Connecting…" : "Connect Wahoo to import a route"}
        </Button>
      )}

      <WahooImportDialog open={showWahooImport} onOpenChange={setShowWahooImport} onImport={onFileChange} />
    </div>
  )
}
