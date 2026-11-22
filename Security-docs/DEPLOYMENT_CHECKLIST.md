# Deployment Readiness Checklist

Use this before any public launch, and again before every paid or enterprise release. Check an item only when it is verified in the deployed product, not when it is merely planned. Owners: **Legal** (needs a lawyer), **Eng**, **Design**, **Ops**.

> This is an engineering checklist, not legal advice. Have a qualified lawyer review the Privacy Policy, Terms, Refund Policy and Cookie Policy for the regions you serve (for example the US/CCPA, EU/UK GDPR, and COPPA).

## How to use
- Mark each item `[x]` when done, or `[n/a]` with a one-line reason (for example "no marketing emails yet").
- Link evidence (URL, PR, screenshot) next to the item.
- Launch is blocked until every **Blocker** is checked.

---

## Part A: Legal, privacy and trust (the 20 items)

### 1. Privacy policy (Blocker, Legal)
- [ ] Published at a stable URL, linked from the footer, sign-up screen and installer
- [ ] States what is collected (account data from GitHub OAuth, messages, workspace files, host metadata, usage counts), why, how long it is kept, and who it is shared with
- [ ] States clearly that **API keys and env variables stay on the user's computer and are never sent to our servers**
- [ ] Lists sub-processors (hosting, database, LiveKit, Stripe, Sentry, PostHog, email provider)
- [ ] Explains user rights (access, correction, deletion, export, objection) and how to exercise them
- [ ] Explains that agents may send message content to the model provider the host chose, and that this is governed by that provider's terms
- [ ] Contact for privacy questions; effective date and change log

### 2. Terms of service (Blocker, Legal)
- [ ] Acceptable use (no malware, abuse, illegal content)
- [ ] Rules for hosting agents on your own machine and for using other people's agents (who is responsible for what an agent does)
- [ ] Statement that hosts are responsible for their own provider keys and provider terms compliance
- [ ] Limitation of liability and disclaimer for AI output
- [ ] Account termination, content ownership and licenses, governing law
- [ ] Acceptance recorded at sign-up (timestamp and version)

### 3. Refund policy (Legal; only if you charge)
- [ ] Published and linked from pricing and checkout
- [ ] Covers free trials, monthly vs annual plans, proration and cancellation
- [ ] Matches what Stripe is actually configured to do
- [ ] Mark `[n/a]` while the product is entirely free

### 4. Cookie policy (Blocker if any non-essential cookies or trackers; Legal)
- [ ] Inventory every cookie and similar storage item (session, CSRF, preferences, analytics) with purpose and lifetime
- [ ] Published and linked from the footer and the consent banner
- [ ] Note: the prototype sets no cookies; real sessions will add at least one essential cookie

### 5. Cookie consent banner (Blocker where EU/UK users are served; Eng, Design)
- [ ] Not shown for strictly necessary cookies only; shown when analytics or marketing trackers are used
- [ ] "Accept" and "Reject" are equally prominent; no pre-ticked boxes
- [ ] Nothing non-essential loads or sets cookies until consent is given
- [ ] Choice is stored, can be changed later (footer link), and respects Global Privacy Control where required
- [ ] Banner is keyboard and screen-reader accessible

### 6. Check form consents (Blocker, Eng, Legal)
- [ ] Sign-up links to Terms and Privacy; acceptance is an explicit action, not buried
- [ ] Marketing email opt-in is a **separate, unticked** checkbox
- [ ] No consent is bundled (terms, marketing and data sharing are separate choices)
- [ ] Consent records stored with timestamp, policy version and source
- [ ] Withdrawing consent is as easy as giving it

### 7. No unnecessary data (Blocker, Eng)
- [ ] Data map written: every field collected, its purpose, retention period and who can access it
- [ ] Remove any field with no clear purpose; do not collect phone, address or birthday unless needed
- [ ] Logs do not contain message bodies, tokens, keys or full IP addresses unless required
- [ ] Retention jobs implemented (message retention by plan, usage rollups, deleted-account purge)
- [ ] Analytics are minimal, anonymized where possible, and exclude message content
- [ ] Prototype note: the daemon sends only agent replies and a host label; keep it that way

### 8. Audit third-party SDKs and services (Blocker, Eng, Ops)
- [ ] List every third-party script, SDK, font host, API and service (GitHub, LiveKit, Stripe, Sentry, PostHog, Cloudflare, model providers, email)
- [ ] For each: what data it receives, where it processes it, whether a DPA is signed, and whether it can be disabled
- [ ] **Remove or self-host external requests the user does not need.** The prototype loads Google Fonts from Google's servers; self-host the font files instead so visitors' IP addresses are not sent to a third party
- [ ] Pin dependency versions, commit lockfiles, run `npm audit` / `pnpm audit` and a license scan in CI
- [ ] Sentry and PostHog configured to scrub message content and secrets
- [ ] Content-Security-Policy restricts script, style, font, image and connect sources to the approved list

### 9. Remove dark patterns (Blocker, Design, Legal)
- [ ] No pre-checked upsells or consents, no confirm-shaming copy, no hidden or tiny close buttons
- [ ] Cancelling a subscription takes no more steps than starting one
- [ ] No fake urgency (countdowns, "only 2 seats left") unless true
- [ ] No nagging that makes declining harder than accepting
- [ ] Review all onboarding, pricing, cancellation and cookie flows with this list

### 10. Remove hidden fees (Blocker if charging; Legal, Design)
- [ ] Total price is shown before checkout, including per-seat pricing, taxes and any overage
- [ ] Make clear that **model provider costs are paid by the host to the provider, not to us** (and that hosts may be billed by their provider when others use their agents)
- [ ] Renewal date, price and cancellation terms stated before purchase
- [ ] No fee appears for the first time at the final step

### 11. Remove fake reviews and testimonials (Blocker, Design, Legal)
- [ ] No invented reviews, ratings, user counts, logos or case studies
- [ ] Testimonials are real, attributable, with permission and dated
- [ ] No placeholder content ("Join 10,000 teams") that is not true
- [ ] Do not incentivize reviews without disclosure

### 12. Remove unsupported claims (Blocker, Legal, Design)
- [ ] Every claim on the site and in the app is true today and provable (for example "secure", "private", "your keys never leave your computer", "no cloud")
- [ ] Do not claim "end-to-end encrypted", "SOC 2", "GDPR compliant", "unhackable" or similar unless it is accurate and evidenced
- [ ] "Emergent learning" and "swarm intelligence" described honestly as what is built today (for example retrieval over team memory), not as unproven capabilities
- [ ] Performance and savings numbers have a source or are removed
- [ ] Keep a short claims register: claim, evidence, owner, review date

### 13. Accessibility: alt text and labels (Blocker, Design, Eng)
- [ ] Every meaningful image has descriptive alt text; decorative images use empty alt
- [ ] Icon-only buttons have accessible names (`aria-label`)
- [ ] Form fields have visible labels, not just placeholders (the prototype's inputs rely on placeholders)
- [ ] New chat messages are announced to screen readers with an `aria-live` region, without being noisy
- [ ] Target: WCAG 2.2 level AA

### 14. Fix color contrast (Blocker, Design)
- [ ] Text meets 4.5:1 (3:1 for large text); UI components and focus rings meet 3:1, in **both** light and dark themes
- [ ] Check muted text, placeholder text, agent badges and status dots with a contrast tool; the prototype's muted grey text on grey backgrounds is a likely failure
- [ ] Status is never conveyed by color alone (online/offline dots also need text or an icon)
- [ ] Verified with an automated check (axe, Lighthouse) plus a manual pass

### 15. Keyboard navigation (Blocker, Design, Eng)
- [ ] Every interactive element is reachable and operable by keyboard, in a logical order
- [ ] Visible focus indicator everywhere
- [ ] "Skip to content" link; landmarks (`nav`, `main`, `aside`) and sensible heading structure
- [ ] Channel list, tabs, modals and menus follow standard keyboard patterns (arrow keys, Esc to close, focus trapped in modals and returned on close)
- [ ] Enter sends a message, with a documented shortcut for new lines
- [ ] `prefers-reduced-motion` respected; text can be zoomed to 200% without breaking layout
- [ ] Tested with a screen reader (VoiceOver, NVDA) on the main flows

### 16. Add business details (Blocker, Legal)
- [ ] Legal entity name, registered address, and contact email shown in the footer and in the policies
- [ ] Support contact and expected response time
- [ ] Company registration or tax ID where required by the region
- [ ] A named privacy contact (and an EU/UK representative or DPO if required)
- [ ] Security contact and a `security.txt` at `/.well-known/security.txt`

### 17. Age consent and children's data (Blocker, Legal, Eng)
- [ ] Minimum age stated in the Terms (suggest 16+, or 18+ for simplicity) and checked at sign-up
- [ ] No knowing collection of data from children under 13 (COPPA) or under the local digital-consent age (13-16 under GDPR)
- [ ] Process for deleting an account if you learn the user is under age
- [ ] Do not target ads or analytics at minors; the product is not designed for children
- [ ] If a school or youth use case is ever pursued, get specific legal review first

### 18. Unsubscribe link in emails (Blocker if sending marketing or notification email; Eng)
- [ ] Every marketing email has a one-click unsubscribe link and the standard `List-Unsubscribe` headers
- [ ] Unsubscribe takes effect promptly (within days at most) with no login required
- [ ] Transactional emails (receipts, security alerts, invites) are separate from marketing
- [ ] Sending identity is accurate; physical business address included where required (CAN-SPAM)
- [ ] SPF, DKIM and DMARC configured for the sending domain
- [ ] Mark `[n/a]` until the app sends any email

### 19. License fonts and images (Blocker, Design, Legal)
- [ ] Every font, icon set, image, illustration and sound has a recorded license that allows commercial use
- [ ] Prototype font (Bricolage Grotesque) is under the SIL Open Font License; keep the license text with self-hosted files
- [ ] No stock or scraped images without a license; no copyrighted logos
- [ ] Keep an `ASSETS_LICENSES.md` listing asset, source, license, attribution requirements
- [ ] Third-party code licenses audited (no incompatible licenses in the dependency tree)

### 20. Data deletion request (Blocker, Eng, Legal)
- [ ] Users can delete their account and data from settings, without emailing support
- [ ] Deletion covers messages (or anonymizes them where a thread must remain coherent), workspace files, host registrations, tokens, usage records and backups (within a stated window)
- [ ] Requests are completed within the legal time limit (for example 30 days) and confirmed to the user
- [ ] Data export (portable format) is available
- [ ] Sub-processors are notified or purged as needed (analytics, error tracking, email lists)
- [ ] Deleting a host revokes its token; deleting an agent removes its memory
- [ ] Tested end to end, including restoring from a backup without resurrecting deleted users

---

## Part B: Security readiness (Blocker unless noted)

### Authentication and access
- [ ] Real authentication (GitHub OAuth); the prototype's name-only login is removed
- [ ] Short-lived sessions, secure cookies (`HttpOnly`, `Secure`, `SameSite`), logout and session revocation
- [ ] Server-side role checks for every channel, agent invocation and workspace file
- [ ] Per-host tokens, stored hashed, rotatable and revocable; the shared `HOST_KEY` from the prototype is gone
- [ ] Rate limits on login, messages, host connections and file writes
- [ ] 2FA available for owners and admins (Recommended)

### Agents and the daemon
- [ ] All agent execution runs in the sandbox (no home directory access, scoped mounts, non-root, resource limits)
- [ ] Network egress deny-by-default with an allowlist
- [ ] API keys stored in the OS keychain only; never logged, never sent to the server, never placed in prompts
- [ ] Approval required for high-risk tools (shell outside workspace, network writes, `git push`, deletions)
- [ ] Per-requester token budgets enforced and persisted across restarts
- [ ] Delegation depth and cost caps in place
- [ ] Prompt-injection tests run against channel content, workspace files and tool outputs
- [ ] Local audit log of agent actions

### Application security
- [ ] All inbound WebSocket and HTTP payloads validated with schemas; payload size caps enforced
- [ ] Output encoding prevents XSS (the prototype uses `textContent`; keep that rule, and sanitize anything rendered as Markdown)
- [ ] Security headers: CSP, `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, frame protections
- [ ] CSRF protection for cookie-authenticated endpoints; WebSocket origin checking
- [ ] No secrets in the repo; secret scanning enabled in CI
- [ ] GitHub sync pushes only to the dedicated sync branch, with `main` and protected branches blocked in code and a pre-push secret scan

### Infrastructure and operations
- [ ] HTTPS only, TLS 1.2+ with automatic renewal; WebSockets over `wss://`
- [ ] Production database not publicly reachable; least-privilege credentials; encrypted at rest
- [ ] Secrets in a secret manager, not in the image or environment files in git
- [ ] Container image minimal, non-root, scanned for vulnerabilities
- [ ] Automated backups with a tested restore, and a documented retention period
- [ ] Persistent volume or database for data (no data on ephemeral disks)
- [ ] Health checks, uptime monitoring, alerting and centralized logs without personal content
- [ ] Staging environment mirrors production; migrations tested before release
- [ ] Dependency audit and update policy in CI (Dependabot or similar)

### Desktop app and distribution
- [ ] Installers code-signed (Apple Developer ID with notarization; Windows certificate)
- [ ] Auto-update with signature verification
- [ ] Update channel and rollback plan

### Incident response and assurance
- [ ] Written incident response plan: who is paged, how users are told, regulator notification (for example within 72 hours under GDPR when required)
- [ ] `security.txt` and a vulnerability disclosure policy
- [ ] Independent security review of the daemon, sandbox and protocol before public launch
- [ ] Penetration test of the control plane (Recommended before enterprise sales)

---

## Part C: Product and ops readiness

- [ ] Status page and support channel
- [ ] Load test: expected concurrent WebSocket connections per instance, with a plan for horizontal scaling (Redis pub/sub)
- [ ] Graceful handling of daemon disconnects, offline agents and server restarts (messages not lost)
- [ ] Error messages explain what happened and how to fix it, without leaking internals
- [ ] Uninstall removes the daemon, its local data and its keychain entries
- [ ] Onboarding explains in plain language what the daemon can do on the user's computer and what it can't
- [ ] Provider terms reviewed for letting others use a host's API key; per-agent setting to disable sharing

---

## Launch gate

| Gate | Condition |
|---|---|
| Private beta | Parts A items 1, 2, 6, 7, 8, 16, 17, 20 and all Part B authentication, agent and application items are done |
| Public launch | Every **Blocker** above is checked, a lawyer has reviewed the legal documents, and the independent security review has no open high-severity findings |
| Paid launch | Adds items 3, 10, 18 (if emailing) and Stripe and tax configuration |

## Review log
| Date | Reviewer | Scope | Result |
|---|---|---|---|
| | | | |
