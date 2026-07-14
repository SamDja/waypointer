import { useRef, useState, type DragEvent } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface ImportCardProps {
  file: File | null
  onFileChange: (file: File) => void
}

export function ImportCard({ file, onFileChange }: ImportCardProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragActive, setIsDragActive] = useState(false)

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragActive(false)
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) onFileChange(dropped)
  }

  return (
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
  )
}
