// Tally form id, not a secret - just identifies which public Tally form
// FeedbackWidget's button should pop open (see tally.so/widgets/embed.js's
// data-tally-open convention, loaded in index.html).
export const TALLY_FORM_ID = import.meta.env.VITE_TALLY_FORM_ID as string | undefined
