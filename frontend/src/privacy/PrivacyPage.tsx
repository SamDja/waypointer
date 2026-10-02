import type { ReactNode } from "react"
import { ArrowLeft } from "lucide-react"
import { Logo } from "@/components/Logo"
import { Button } from "@/components/ui/button"
import {
  CONTACT_EMAIL,
  CONTROLLER_NAME,
  EMAIL_PROVIDER,
  HOSTING_COUNTRY,
  LAST_UPDATED,
  LOG_RETENTION,
  SESSION_DAYS,
  UNVERIFIED_ACCOUNT_DAYS,
} from "./privacyConfig"

// The privacy notice (/privacy.html). Written to be read by visitors, so it
// says plainly what happens, and it has to stay true: when the app starts
// sending something new somewhere, or storing something new, this changes
// with it. Deployment-specific facts live in privacyConfig.ts.

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function P({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed">{children}</p>
}

function List({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed">{children}</ul>
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  )
}

export function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-8">
        <header className="flex flex-col gap-4">
          <Button variant="ghost" className="w-fit" asChild>
            <a href="/">
              <ArrowLeft className="size-4" />
              Back to Sulla Via
            </a>
          </Button>
          <div className="flex items-center gap-2">
            <Logo className="w-7" />
            <h1 className="text-xl font-semibold">Privacy at Sulla Via</h1>
          </div>
          <p className="text-xs text-muted-foreground">Last updated {LAST_UPDATED}</p>
          <P>
            Sulla Via helps you add useful places to your routes. This page explains, in plain words, what happens to
            your data when you use it: what we keep, what we don't, who else is involved, and what you can do about
            it. The short version: you can use Sulla Via without an account, your routes stay in your browser, and an
            account holds only what it needs to work.
          </P>
        </header>

        <Section title="Who runs Sulla Via">
          <P>
            Sulla Via is run by {CONTROLLER_NAME}, who is responsible for your data (the "controller" under the
            GDPR). For anything about your data, write to <a className="text-primary underline underline-offset-2" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
            The server and its database are in {HOSTING_COUNTRY}.
          </P>
        </Section>

        <Section title="Using Sulla Via without an account">
          <P>Everything except connecting other apps works without an account. When you use it:</P>
          <List>
            <li>
              <strong>Your routes aren't stored.</strong> A route you load or draw is sent to our server only to find
              places along it and to build the file you download; it's handled in memory and forgotten when the
              request is done.
            </li>
            <li>
              <strong>Your preferences stay in your browser</strong> (its local storage): your activity, speeds, POI
              types, theme, and an unfinished route so you can pick it up again. We can't see them, and clearing your
              browser's site data removes them.
            </li>
            <li>
              <strong>Our server keeps technical logs</strong> of the requests it answers (which address was asked for,
              when, and how it went), to keep the service running and to spot faults and abuse. They're kept for{" "}
              {LOG_RETENTION}. To stop any one visitor overloading the service, the server also briefly remembers how
              many requests came from each network address - for an hour at most, in memory only.
            </li>
          </List>
        </Section>

        <Section title="Services your browser talks to">
          <P>
            Some parts of the map come straight from other services, so your browser contacts them directly and they
            see your network address, like any website you visit:
          </P>
          <List>
            <li>
              <strong>Cloudflare</strong> carries all traffic to and from Sulla Via (it's how the site is reached from
              the internet) and provides the "I'm not a robot" check on sign-up and password reset (Turnstile).{" "}
              <Ext href="https://www.cloudflare.com/privacypolicy/">Cloudflare's privacy policy</Ext>.
            </li>
            <li>
              <strong>OpenFreeMap</strong> serves the map itself, and <strong>Amazon Web Services</strong> (its open
              terrain data) the elevation behind the hiking map's contour lines. They receive the map areas you look
              at.
            </li>
            <li>
              <strong>Wikimedia Commons, Panoramax and Mapillary</strong> serve the photos shown in a place's popup,
              when you open one that has photos.
            </li>
            <li>
              <strong>Umami</strong> (Umami Cloud) counts how Sulla Via is used - which features, how often - so we
              can tell what to improve. It sets no cookies, doesn't store your network address, and we never send it
              your email address. It does receive the name of a place you pick in the search, and an outline of a
              route you plan, rounded to about a kilometre so that it can't pinpoint where you live.{" "}
              <Ext href="https://umami.is/privacy">Umami's privacy policy</Ext>.
            </li>
            <li>
              <strong>Tally</strong> provides the feedback form. Its script loads with the page; what you write in the
              form goes to Tally. <Ext href="https://tally.so/help/privacy-policy">Tally's privacy policy</Ext>.
            </li>
          </List>
          <P>
            Our server also asks a few services for things on your behalf, without passing on who you are: BRouter
            (the route between the points you place), Photon by komoot (the places matching what you type in the
            search, near the part of the map you're looking at), and Wikimedia Commons, Wikidata, Panoramax and
            Mapillary (which photos belong to a place).
          </P>
        </Section>

        <Section title="If you create an account">
          <P>
            An account is for connecting your fitness apps and keeping your settings across devices. It holds:
          </P>
          <List>
            <li>
              <strong>Your name</strong> (whatever you'd like us to call you) and <strong>email address</strong>, and
              when you confirmed it.
            </li>
            <li>
              <strong>Your password, hashed</strong> (with Argon2id) - never the password itself, which we can't see or
              recover.
            </li>
            <li>
              <strong>The browsers you're signed in on</strong>: when each session started and was last used, and the
              browser's own description of itself (its "user agent"), so a session can be recognised and ended.
            </li>
            <li>
              <strong>The fitness apps you connect</strong> (see below), and your <strong>speed settings</strong> (riding
              and climbing speed) for each activity.
            </li>
            <li>
              When the account was created and last signed in to, and when you accepted this notice (and which
              version of it).
            </li>
          </List>
          <P>
            We use this only to run your account: signing you in, keeping it secure, and sending the emails it needs
            (confirming your address, resetting your password, telling you about changes to the account). We don't
            send newsletters or marketing, and we don't sell or share your data with anyone. The legal basis is the
            agreement to provide the account you asked for; keeping it secure (limiting sign-in attempts, the robot
            check) is our legitimate interest.
          </P>
          <P>
            Account emails are delivered by {EMAIL_PROVIDER}, which therefore handles your email address and the
            email's content. Signing in uses one cookie, which only keeps you signed in - there are no advertising or
            tracking cookies. If enabled, a new password is checked against{" "}
            <Ext href="https://haveibeenpwned.com/Passwords">Have I Been Pwned's list of breached passwords</Ext>: only
            the first five characters of a scrambled version (a hash) of it are sent, never the password.
          </P>
        </Section>

        <Section title="Connecting Strava or Wahoo">
          <P>
            When you connect Strava or Wahoo, that app gives Sulla Via an access key for your account there. We store
            it encrypted, use it only when you ask (to list or import your routes and activities, or to send a route
            to Wahoo), and never show it to your browser. We keep the name the app shows for your account, and which
            permissions you granted. Routes you import aren't stored - they go straight into your browser like a
            file you'd loaded yourself.
          </P>
          <P>
            Disconnecting an app, or deleting your account, removes the key and withdraws Sulla Via's access on the
            app's side too. You can also withdraw it from Strava's or Wahoo's own settings at any time.
          </P>
        </Section>

        <Section title="How long things are kept">
          <List>
            <li>
              <strong>Your account</strong>: until you delete it. Deleting it removes everything listed above at once.
            </li>
            <li>
              <strong>An account whose email was never confirmed</strong>: deleted automatically{" "}
              {UNVERIFIED_ACCOUNT_DAYS} days after sign-up.
            </li>
            <li>
              <strong>A sign-in session</strong>: ends {SESSION_DAYS} days after you last used it, or when you sign
              out.
            </li>
            <li>
              <strong>Links in our emails</strong>: work for 24 hours (30 minutes for a password reset) and only once,
              and are removed soon after.
            </li>
            <li>
              <strong>Technical logs</strong>: {LOG_RETENTION}.
            </li>
          </List>
        </Section>

        <Section title="Your rights">
          <P>Under data protection law you can, at any time:</P>
          <List>
            <li>
              <strong>See and take a copy of your data</strong> - "Download my data" in your account settings.
            </li>
            <li>
              <strong>Correct it</strong> - your name, email address and settings can all be changed there.
            </li>
            <li>
              <strong>Delete it</strong> - "Delete account" in your account settings, straight away.
            </li>
            <li>
              <strong>Object to or ask us to limit</strong> how we use it, or ask anything else about it - write to{" "}
              {CONTACT_EMAIL}.
            </li>
            <li>
              <strong>Complain</strong> to your data protection authority if you think we've got something wrong.
            </li>
          </List>
        </Section>

        <Section title="Changes to this page">
          <P>
            If what we do with your data changes, this page changes first, and the date at the top says when. If a
            change matters for your account, we'll tell you by email before it applies.
          </P>
        </Section>
      </main>
    </div>
  )
}
