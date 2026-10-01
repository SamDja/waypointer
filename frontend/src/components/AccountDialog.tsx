import { useState, type FormEvent, type ReactNode } from "react"
import { CircleCheck, Download, MailWarning } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Turnstile } from "@/components/Turnstile"
import {
  changeEmail,
  changePassword,
  deleteAccount,
  downloadAccountData,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  signIn,
  signUp,
} from "@/lib/accountApi"
import { track } from "@/lib/analytics"
import { toast } from "@/lib/toast"
import type { Account } from "@/types/account"

export type AccountView = "signin" | "signup" | "forgot" | "check-email" | "reset" | "settings"

// Mirrors passwords.py's MIN_PASSWORD_LENGTH - the backend has the final say.
const MIN_PASSWORD_LENGTH = 10

export interface AccountDialogProps {
  // null = closed.
  view: AccountView | null
  onViewChange: (view: AccountView | null) => void
  // The token from a /?reset=… email link, for the "reset" view.
  resetToken: string | null
  account: Account | null
  onAccountChange: (account: Account | null) => void
}

// Runs one form's submit: busy while it's in flight, the failure shown
// inline - toasts sit under dialogs (see DESIGN.md), so a toast would go
// unseen here.
function useSubmit() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong - please try again.")
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run, setError }
}

function Field({
  id,
  label,
  hint,
  ...input
}: { id: string; label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} required {...input} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function FormError({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <Callout variant="destructive" role="alert">
      {error}
    </Callout>
  )
}

function SwitchLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={onClick}>
      {children}
    </Button>
  )
}

function SignInForm({
  onSignedIn,
  onViewChange,
}: {
  onSignedIn: (account: Account) => void
  onViewChange: (view: AccountView) => void
}) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const { busy, error, run } = useSubmit()

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      const account = await signIn(email, password)
      track("signed_in")
      onSignedIn(account)
    })
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <Field id="signin-email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Field
        id="signin-password"
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <FormError error={error} />
      <Button type="submit" loading={busy}>
        Sign in
      </Button>
      <div className="flex justify-between gap-2">
        <SwitchLink onClick={() => onViewChange("forgot")}>Forgot your password?</SwitchLink>
        <SwitchLink onClick={() => onViewChange("signup")}>Create an account</SwitchLink>
      </div>
    </form>
  )
}

function SignUpForm({
  onSent,
  onViewChange,
}: {
  onSent: (email: string) => void
  onViewChange: (view: AccountView) => void
}) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [captcha, setCaptcha] = useState<string | null>(null)
  // Remounting the captcha after a refused submit gets a fresh token -
  // each one is single use.
  const [captchaKey, setCaptchaKey] = useState(0)
  const { busy, error, run } = useSubmit()

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      try {
        await signUp(email, password, captcha)
      } finally {
        setCaptcha(null)
        setCaptchaKey((key) => key + 1)
      }
      track("signed_up")
      onSent(email)
    })
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <Field id="signup-email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Field
        id="signup-password"
        label="Password"
        type="password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD_LENGTH}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words make a good one.`}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Turnstile key={captchaKey} onToken={setCaptcha} />
      <FormError error={error} />
      <Button type="submit" loading={busy}>
        Create account
      </Button>
      <p className="text-xs text-muted-foreground">
        Your routes stay in your browser. An account stores only your email address and a securely hashed password.
        You can download or delete your data at any time.
      </p>
      <SwitchLink onClick={() => onViewChange("signin")}>Already have an account? Sign in</SwitchLink>
    </form>
  )
}

function ForgotForm({ onSent, onViewChange }: { onSent: (email: string) => void; onViewChange: (view: AccountView) => void }) {
  const [email, setEmail] = useState("")
  const [captcha, setCaptcha] = useState<string | null>(null)
  const [captchaKey, setCaptchaKey] = useState(0)
  const { busy, error, run } = useSubmit()

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      try {
        await requestPasswordReset(email, captcha)
      } finally {
        setCaptcha(null)
        setCaptchaKey((key) => key + 1)
      }
      onSent(email)
    })
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <Field id="forgot-email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Turnstile key={captchaKey} onToken={setCaptcha} />
      <FormError error={error} />
      <Button type="submit" loading={busy}>
        Send reset link
      </Button>
      <SwitchLink onClick={() => onViewChange("signin")}>Back to sign in</SwitchLink>
    </form>
  )
}

function ResetForm({ token, onDone }: { token: string; onDone: (account: Account) => void }) {
  const [password, setPassword] = useState("")
  const { busy, error, run } = useSubmit()

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    void run(async () => onDone(await resetPassword(token, password)))
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <Field
        id="reset-password"
        label="New password"
        type="password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD_LENGTH}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <FormError error={error} />
      <Button type="submit" loading={busy}>
        Set new password
      </Button>
    </form>
  )
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function EmailSection({ account }: { account: Account }) {
  const [newEmail, setNewEmail] = useState("")
  const [password, setPassword] = useState("")
  const [sentTo, setSentTo] = useState<string | null>(null)
  const resend = useSubmit()
  const [resent, setResent] = useState(false)
  const change = useSubmit()

  function handleChange(event: FormEvent) {
    event.preventDefault()
    void change.run(async () => {
      await changeEmail(password, newEmail)
      setSentTo(newEmail)
      setNewEmail("")
      setPassword("")
    })
  }

  return (
    <SettingsSection title="Email">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{account.email}</span>
        {account.email_verified ? (
          <span className="flex items-center gap-1 text-xs text-success-foreground">
            <CircleCheck className="size-3" /> Verified
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-warning-foreground">
            <MailWarning className="size-3" /> Not verified yet
          </span>
        )}
      </p>
      {!account.email_verified && (
        <div className="flex flex-col gap-2">
          {resent ? (
            <Callout variant="success">We sent a new link to {account.email}.</Callout>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              loading={resend.busy}
              onClick={() =>
                void resend.run(async () => {
                  await resendVerification()
                  setResent(true)
                })
              }
            >
              Resend the verification email
            </Button>
          )}
          <FormError error={resend.error} />
        </div>
      )}
      {sentTo ? (
        <Callout variant="success">
          Check {sentTo} for a confirmation link. Your account keeps its current address until you follow it.
        </Callout>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={handleChange}>
          <Field id="new-email" label="New email address" type="email" autoComplete="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          <Field
            id="new-email-password"
            label="Your password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <FormError error={change.error} />
          <Button type="submit" variant="outline" className="w-fit" loading={change.busy}>
            Change email
          </Button>
        </form>
      )}
    </SettingsSection>
  )
}

function PasswordSection() {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [done, setDone] = useState(false)
  const { busy, error, run } = useSubmit()

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      await changePassword(current, next)
      setCurrent("")
      setNext("")
      setDone(true)
    })
  }

  return (
    <SettingsSection title="Password">
      <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
        {/* Lets a password manager tie the new password to this account. */}
        <input type="email" autoComplete="username" hidden readOnly />
        <Field
          id="current-password"
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => {
            setCurrent(e.target.value)
            setDone(false)
          }}
        />
        <Field
          id="next-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. Your other devices will be signed out.`}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <FormError error={error} />
        {done && <Callout variant="success">Password changed.</Callout>}
        <Button type="submit" variant="outline" className="w-fit" loading={busy}>
          Change password
        </Button>
      </form>
    </SettingsSection>
  )
}

function DataSection({ onDeleted }: { onDeleted: () => void }) {
  const [password, setPassword] = useState("")
  const [confirming, setConfirming] = useState(false)
  const download = useSubmit()
  const remove = useSubmit()

  function handleDelete(event: FormEvent) {
    event.preventDefault()
    setConfirming(true)
  }

  return (
    <SettingsSection title="Your data">
      <p className="text-xs text-muted-foreground">
        Your account holds your email address, a hashed password (never the password itself) and the list of browsers
        you're signed in on. Routes and settings stay in your browser. Nothing is shared with anyone, and deleting
        your account removes all of it straight away.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        loading={download.busy}
        onClick={() => void download.run(downloadAccountData)}
      >
        <Download className="size-4" />
        Download my data
      </Button>
      <FormError error={download.error} />

      <form className="flex flex-col gap-3" onSubmit={handleDelete}>
        <Field
          id="delete-password"
          label="Delete your account - enter your password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <FormError error={remove.error} />
        <Button type="submit" variant="destructive" className="w-fit" loading={remove.busy}>
          Delete account
        </Button>
      </form>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your account?</AlertDialogTitle>
            <AlertDialogDescription>
              Your account and everything stored with it are deleted for good. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive-solid"
              onClick={() =>
                void remove.run(async () => {
                  await deleteAccount(password)
                  onDeleted()
                })
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  )
}

const TITLES: Record<AccountView, { title: string; description: string }> = {
  signin: { title: "Sign in", description: "Welcome back!" },
  signup: {
    title: "Create an account",
    description: "Sulla Via works without one - an account is for connecting your fitness apps and for features in testing.",
  },
  forgot: { title: "Reset your password", description: "We'll email you a link to choose a new one." },
  "check-email": { title: "Check your inbox", description: "" },
  reset: { title: "Choose a new password", description: "You'll be signed in once it's set." },
  settings: { title: "Your account", description: "" },
}

// Every account screen in one dialog: sign in, sign up, forgot/reset
// password, and the signed-in account's settings.
export function AccountDialog({ view, onViewChange, resetToken, account, onAccountChange }: AccountDialogProps) {
  const [sent, setSent] = useState<{ email: string; kind: "signup" | "reset" } | null>(null)
  const shown = view ?? "signin"
  const { title, description } = TITLES[shown]

  function handleSent(kind: "signup" | "reset") {
    return (email: string) => {
      setSent({ email, kind })
      onViewChange("check-email")
    }
  }

  function handleSignedIn(next: Account) {
    onAccountChange(next)
    onViewChange(null)
    toast(`Signed in as ${next.email}.`)
  }

  return (
    <Dialog open={view !== null} onOpenChange={(open) => !open && onViewChange(null)}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
          {!description && <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>

        {shown === "signin" && <SignInForm onSignedIn={handleSignedIn} onViewChange={onViewChange} />}
        {shown === "signup" && <SignUpForm onSent={handleSent("signup")} onViewChange={onViewChange} />}
        {shown === "forgot" && <ForgotForm onSent={handleSent("reset")} onViewChange={onViewChange} />}
        {shown === "check-email" && (
          <div className="flex flex-col gap-4">
            {/* Worded so it's true whether or not the address has an account -
                the server answers both the same way. */}
            <p className="text-sm">
              {sent?.kind === "reset"
                ? `If there's an account for ${sent.email}, we've sent it a link to reset your password.`
                : `We've sent an email to ${sent?.email ?? "you"}. Follow the link in it to finish signing up.`}
            </p>
            <p className="text-xs text-muted-foreground">It can take a minute to arrive - check your spam folder too.</p>
            <Button variant="outline" className="w-fit" onClick={() => onViewChange(null)}>
              Close
            </Button>
          </div>
        )}
        {shown === "reset" &&
          (resetToken ? (
            <ResetForm
              token={resetToken}
              onDone={(next) => {
                onAccountChange(next)
                onViewChange(null)
                toast("Password changed - you're signed in.")
              }}
            />
          ) : (
            <Callout variant="destructive">This link is incomplete. Please ask for a new one.</Callout>
          ))}
        {shown === "settings" && account && (
          <div className="flex flex-col gap-4">
            <EmailSection account={account} />
            <PasswordSection />
            <DataSection
              onDeleted={() => {
                onAccountChange(null)
                onViewChange(null)
                toast("Your account has been deleted.")
              }}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
