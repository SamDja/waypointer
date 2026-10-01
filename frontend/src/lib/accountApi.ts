import { request } from "@/lib/api"
import type { Account, AccountStatus } from "@/types/account"

// The account endpoints (backend auth.py). The session is an HttpOnly
// cookie the browser sends by itself on these same-origin requests - nothing
// here ever sees or stores it. Every 4xx `detail` from these endpoints is
// written for the visitor, so request()'s default trustDetail applies.

const UNAVAILABLE = "Accounts aren't available right now - please try again in a moment."

function form(fields: Record<string, string | null | undefined>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) data.append(key, value)
  }
  return data
}

async function post(url: string, fields: Record<string, string | null | undefined>): Promise<Response> {
  return request(url, { method: "POST", body: form(fields) }, { failed: UNAVAILABLE })
}

export async function fetchAccountStatus(): Promise<AccountStatus> {
  const response = await request("/api/auth/me", {}, { failed: UNAVAILABLE })
  return (await response.json()) as AccountStatus
}

export async function signUp(email: string, password: string, turnstileToken: string | null): Promise<void> {
  await post("/api/auth/signup", { email, password, turnstile_token: turnstileToken })
}

export async function signIn(email: string, password: string): Promise<Account> {
  return (await (await post("/api/auth/login", { email, password })).json()) as Account
}

export async function signOut(): Promise<void> {
  await post("/api/auth/logout", {})
}

export async function verifyEmail(token: string): Promise<Account> {
  return (await (await post("/api/auth/verify", { token })).json()) as Account
}

export async function resendVerification(): Promise<void> {
  await post("/api/auth/resend-verification", {})
}

export async function requestPasswordReset(email: string, turnstileToken: string | null): Promise<void> {
  await post("/api/auth/forgot-password", { email, turnstile_token: turnstileToken })
}

export async function resetPassword(token: string, password: string): Promise<Account> {
  return (await (await post("/api/auth/reset-password", { token, password })).json()) as Account
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await post("/api/account/password", { current_password: currentPassword, new_password: newPassword })
}

export async function changeEmail(password: string, newEmail: string): Promise<void> {
  await post("/api/account/email", { password, new_email: newEmail })
}

export async function confirmEmailChange(token: string): Promise<Account> {
  return (await (await post("/api/auth/confirm-email", { token })).json()) as Account
}

export async function deleteAccount(password: string): Promise<void> {
  await post("/api/account/delete", { password })
}

export async function downloadAccountData(): Promise<void> {
  const response = await request("/api/account/export", {}, { failed: UNAVAILABLE })
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement("a")
  link.href = url
  link.download = "sulla-via-account.json"
  link.click()
  URL.revokeObjectURL(url)
}
