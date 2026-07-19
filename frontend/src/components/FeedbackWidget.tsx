import { MessageSquarePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TALLY_FORM_ID } from "@/lib/feedbackConfig"

// Renders nothing if no form is configured, rather than a dead button.
export function FeedbackWidget() {
  if (!TALLY_FORM_ID) return null

  return (
    <Button
      variant="outline"
      size="icon"
      // Tally's embed.js (loaded in index.html) reads these data-tally-*
      // attributes and opens its hosted form as a modal on click - no
      // click handler of our own needed.
      data-tally-open={TALLY_FORM_ID}
      data-tally-layout="modal"
      // z-[1300]: a tier above every other fixed/overlay element in this
      // codebase (current max is z-[1210] on Popover/Select content, see
      // components/ui/popover.tsx/select.tsx) - this button must stay
      // clickable above any open Dialog/AlertDialog/toast.
      className="fixed right-4 bottom-4 z-[1300] rounded-full shadow-lg"
      aria-label="Send feedback"
      title="Send feedback"
    >
      <MessageSquarePlus className="size-4" />
    </Button>
  )
}
