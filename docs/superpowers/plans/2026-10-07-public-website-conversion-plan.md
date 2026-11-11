# Pro SWPPP Public Website Conversion Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans when implementation is requested. Steps use checkbox syntax. Start with source discovery and a local/staging preview. This plan is saved for continuation in another chat; no implementation is requested in this turn.

**Goal:** Increase qualified estimate requests and completed orders by fixing verified mobile defects, clarifying the buyer journey and measuring the complete conversion path.

**Architecture:** Extend the current public WordPress/Divi website and preserve its existing forms, notifications and CRM feeds. Discover the actual source/deployment mechanism before choosing files or editing templates. No website migration, new CRM writer or duplicate sales pipeline is assumed.

**Tech Stack:** Observed WordPress/Divi and Gravity Forms front end; GA4, GTM, Google Ads and Clarity scripts present. Backend configuration and hosting access require discovery.

**Spec:** ../specs/2026-10-07-public-website-conversion-design.md

**Audit:** ../../audits/2026-10-07-public-website-review.md

## Global constraints

- Public target is https://proswppp.com/ . Explicit client is Pro SWPPP/Derek. Never infer the target from the current working directory.
- The SWPPP Railway application is separate. This repository currently holds the plan/evidence; actual public-site source location is unverified.
- Preserve existing order/payment URLs, form IDs/field IDs, webhook mappings, notifications, conditional logic, consent semantics and deduplication.
- Keep current brand colors and real people/proof. No invented reviews, prices, certifications, guarantees, case studies or sales lift.
- No n8n/provider/CRM mutations, outreach, test mail or LinkedIn activation as part of website planning.
- Work in a local/staging copy with external deliveries disabled. Production form tests require an explicit, contained test plan before execution.
- Obtain a concrete preview and rollback before any separately authorized production release. User authorization carries across the continuation; do not request routine edit permission again.
- Treat the baseline measurements as local preliminary evidence; no Core Web Vitals pass/fail or historical conversion rate is established.

## Review focus

- Existing customers can still find order/payment access after estimate-first navigation changes. Task 3 and Task 5 cover this.
- Form retries, validation failure and refresh preserve input and cannot duplicate confirmed submissions. Task 4 and Task 6 cover this.
- Hidden responsive variants, tabs and delayed embeds retain essential mobile content without blank space or shifting CTAs. Task 2 and Task 5 cover this.
- Browser success events, accepted entries, CRM records and qualified/won states remain distinguishable. Task 1 and Task 6 cover this.
- Mixed paid/organic/direct traffic, low samples and changes in staff response time cannot become false lift claims. Task 1 and Task 7 cover this.

## Artifact map

Existing inputs:
- docs/audits/2026-10-07-public-website-review.md: findings and limitations.
- docs/superpowers/specs/2026-10-07-public-website-conversion-design.md: proposed buyer flow and design requirements.
- Private evidence directory: /Users/ivanmanfredi/.local/state/proswppp-sdr-delivery/2026-10-07-website-review/ . Contains screenshots, DOM/schema inspection, three-run viewport metrics and mobile reproduction.

Create during execution inside the confirmed public-site workspace:
- docs/website-conversion/source-map.md: page IDs, module/template ownership, form IDs, integration/analytics map and actual deployment route. Reference secrets by location only.
- docs/website-conversion/baseline.md: dated traffic/funnel evidence and missing fields.
- docs/website-conversion/content-approved.md: approved copy, service scope, guarantee terms and sources.
- docs/website-conversion/validation.md: device/flow checks and receipts.
- docs/website-conversion/release.md: exact changes, deployment, monitoring and rollback.

Select code/theme/module paths only after Task 0 identifies their real owners. A WordPress page may live in the database, a Divi export, a child theme or a managed snippets plugin; inventing a React component path here would misdirect implementation.

## Task 0: Identify and preserve the working site

**Produces:** exact source map and reversible working copy.

- [ ] Read the spec/audit and reproduce the public page version. Check whether someone has changed it since October 7.
- [ ] Locate the authorized WordPress/hosting/source access using the explicit client registry. Inspect existing access before asking Ivan for missing credentials; never print secrets.
- [ ] Record the homepage, estimate, order, quiz and payment page IDs/URLs; active theme/child-theme, builder version, relevant custom snippets and form IDs.
- [ ] Map each form's notification recipients, webhook/CRM feed, spam controls, conditional logic, uploads, payments if present, success state and analytics hooks. GET/read only during inventory.
- [ ] Identify the real deployment method and backup mechanism. Export the affected page layouts/forms and custom CSS/JS with a timestamp and restore instructions.
- [ ] Create a local/staging copy. Disable outbound mail, payment actions, CRM/webhook delivery and indexing in that copy. Confirm a staging form cannot reach production consumers before entering test data.
- [ ] Record which resources are shared with other pages, so a global CSS/plugin change receives wider checks.

**Accept when:** the next worker can name the exact affected source/module/form objects, preview locally and restore the original without touching unrelated systems.

## Task 1: Establish the conversion baseline

**Consumes:** source/integration map. **Produces:** baseline and event contract.

- [ ] Read available analytics for the most recent complete 28 days and the preceding 28 days. Record exact dates, device/source splits, consent coverage and known outages. If the available window differs, record it rather than filling missing days with zero.
- [ ] Identify eligible sessions, estimate starts, accepted estimate entries, order starts and accepted orders. Exclude known test/internal/spam records using documented evidence; retain an excluded-count reconciliation.
- [ ] Link confirmed submissions to downstream records using an existing submission ID or explicit mapping. Keep ambiguous links unresolved. Do not introduce public-visible CRM fields for analytics.
- [ ] Agree a practical qualified-inquiry definition with Derek: real buyer/project, served scope and enough information for the team to respond. Record qualification coverage separately.
- [ ] Record median/time-distribution of first human response where supported. A front-end improvement can lose value if staff cannot respond.
- [ ] Inventory existing GA4/GTM/Ads events and both observed Clarity project tags. Determine whether duplicate tags or conversions exist before changing their configuration.
- [ ] Define events below and reuse equivalent existing events where possible. Do not fire renamed duplicates into existing ad conversion actions.

| Event | Trigger | Minimum non-PII fields |
|---|---|---|
| swppp_cta_click | Actual estimate/order/quiz/call link activation | route, placement, page_path, experiment variant if any |
| swppp_form_start | First meaningful interaction with a form | form_kind, step, page_path |
| swppp_form_step_complete | Validated transition to the next step | form_kind, step |
| swppp_form_error | User-visible validation/submission failure | form_kind, step, stable error category; no entered values |
| swppp_form_success | Server-confirmed accepted submission | form_kind, approved opaque dedup key |

Keep names, emails, phone numbers, project addresses, notes, drawings links and raw form values out of analytics payloads. Retain permitted campaign attribution according to the current consent setup. An opaque analytics key must not contain or derive directly from personal information.

**Accept when:** totals can be reconciled through the known part of the funnel and missing data is explicit. Clicking submit or visiting a thank-you URL alone cannot manufacture a confirmed submission.

## Task 2: Repair verified mobile defects

**Consumes:** original layouts and screenshots. **Produces:** bounded fixes in the existing layout system.

- [ ] Reproduce the missing service heading/72-hour hero promise at 375px. Inspect Divi responsive variants; preserve the same core message at every supported width.
- [ ] Reproduce the empty first benefits tab. Inspect the active mobile content and remove/repair the empty responsive override while preserving tab semantics and content.
- [ ] Expand the final CTA heading's effective width. It previously measured about 120px and wrapped into six short lines at 375px.
- [ ] Reduce the oversized mobile header while retaining a usable logo/menu and clear navigation.
- [ ] Correct white-on-light-blue panel contrast using the current palette; verify computed contrast and screenshot readability.
- [ ] Locate the recurring Unexpected token 'class' error. Fix only after identifying the owning script/snippet; do not attribute the blank tab to that error without evidence.
- [ ] Check default and alternate tabs, menu opening/closing, repeated navigation, font loading and zoom. Record before/after screenshots and functional results.

**Accept when:** essential hero content is visible, the first benefits tab has content, final CTA text uses a readable width, no new navigation defects occur, and the investigated script error is resolved or explicitly separated as an open issue.

## Task 3: Build the homepage conversion preview

**Consumes:** spec, fixed modules, content approved by Derek where factual changes are proposed. **Produces:** desktop/mobile preview.

- [ ] Draft a section outline using the spec: header/hero -> deliverables -> process -> proof -> coverage/questions -> final action/footer.
- [ ] Keep the estimate and order routes distinct and clearly named. Preserve direct access for returning customers and a phone route for urgent inquiries.
- [ ] Position the estimate route near the opening service promise. Retain the team photo and compact proof; avoid pushing the action below oversized branding.
- [ ] Replace repetitive assurance with verified scope and process information. Flag claims that require Derek's factual answer before final copy.
- [ ] Explain included/optional services and guarantee timing using approved terms. No invented base price or rush promise.
- [ ] Reconcile review counts/ratings against an authoritative current source and make schema/visible proof agree. Do not remove valid schema wholesale or infer rich-result eligibility.
- [ ] Use consistent heading/body/CTA styles and spacing. Keep proof source links and recognisable Pro SWPPP branding.
- [ ] Review the preview with the actual buyer scenarios in the spec. Each visitor must identify a suitable next step without reading the entire page.

**Accept when:** the preview supports all five buyer journeys; every core factual claim has a source/approval; no ready-order/customer route is lost. Save desktop and mobile comparison captures for review.

## Task 4: Improve estimate, order and quiz clarity

**Consumes:** form/integration map and baseline. **Produces:** form-page previews with preserved contracts.

- [ ] Estimate: bring the form and response expectation together; clarify labels, required fields and optional drawings. Check whether location fields can be clarified without changing field IDs or feed mappings.
- [ ] Order: explain what the buyer needs before starting and how price/scope confirmation works. Retain the three-step data collection unless evidence supports a smaller change.
- [ ] Order: review recurring/optional charges, selected defaults and confirmation text with Derek. Display only real approved charges.
- [ ] Quiz: explain contact-detail requirements before the visitor begins. Verify existing conditional steps and result handling; do not rewrite compliance logic from inference.
- [ ] Keep values on validation errors, associate errors with their fields, use appropriate input types/autocomplete, maintain keyboard/focus flow and prevent repeated acceptance during retries.
- [ ] Preserve notification, consent, upload and CRM mappings. Use mocked/staging receivers to inspect payloads without production deliveries.
- [ ] Confirm success messaging appears only after acceptance and tells the buyer what happens next. Use the team's actual response commitment.

**Accept when:** valid and invalid input scenarios behave predictably; existing feed payload contracts match; retries create a single accepted record in the test receiver; no production side effects occur.

## Task 5: Performance, responsive and accessibility checks

- [ ] Run new baseline and candidate tests serially in the same environment with identical network/CPU settings, at least three fresh contexts each. Verify page title/content before interpreting results.
- [ ] Obtain field data from Search Console/CrUX if authorized and available. Report no-data explicitly. Keep lab results and field results separate.
- [ ] Inspect font families/weights and icon-font use; remove or subset only unused resources. Confirm every retained icon/text glyph still renders.
- [ ] Investigate the 41 observed script resources, third-party widgets and captcha cost. Load work where required without breaking spam protection, reviews or form dependencies.
- [ ] Resolve duplicate analytics loading only after identifying ownership and validating conversion attribution.
- [ ] Reserve space for delayed media/widgets; check actual shift sources. Verify hero image priority, dimensions and mobile asset selection without harming the retained team photograph.
- [ ] Review widths 375,390,768,1280,1366,1440 and 1920. Confirm no whole-page horizontal overflow; preserve intentional scrolling controls.
- [ ] Test keyboard-only operation, visible focus, labels, errors, contrast and 200% zoom/reflow. Check Safari/iOS or an actual phone when available and record any untested environment.
- [ ] Review the whole page after lazy content settles. Reject capture artifacts and offscreen carousel text as design findings.

**Accept when:** conversion-critical content/actions remain usable across checked widths; known empty content is fixed; measured performance is no worse under controlled comparison or a documented tradeoff is accepted. Target LCP<=2.5s, CLS<=0.1 and INP<=200ms where suitable field evidence exists; do not fabricate a passing field result from local tests.

## Task 6: Review, release and monitor

- [ ] Produce a review package containing the actual preview, before/after captures, content changes, known limits, integration checks and rollback.
- [ ] Confirm separately authorized release scope. Preserve any concurrent site edits and publish only the reviewed changes.
- [ ] Record affected pages/templates/snippets, backup/export locations, release timestamp and deployment method.
- [ ] Recheck public mobile/desktop routes, CTA destinations, form rendering, script errors and event initialization.
- [ ] If a production end-to-end test is authorized, define the exact test record, recipient behavior, CRM exclusion and cleanup before submitting. Otherwise state that production delivery remains unverified.
- [ ] Observe the next legitimate inquiries/orders where authorized; reconcile acceptance and downstream delivery without replaying them.
- [ ] Roll back affected page/assets if a release breaks ordering, submission or core mobile content. Preserve newly received customer records and current analytics data during rollback.

**Accept when:** the released page matches the reviewed artifact, operational checks have receipts, and any unverified production delivery is plainly documented.

## Task 7: Evaluate conversion effect

- [ ] Compare qualified estimate inquiries / eligible sessions and accepted orders / eligible sessions, split by mobile/desktop and source. Also show raw numerators, denominators and qualification coverage.
- [ ] Check form-start-to-accepted-submission progression, errors, response time, quote progression and supported won-deal links. Do not count an order form as booked revenue without the relevant evidence.
- [ ] Keep technical bug fixes outside experiments. Test one uncertain decision, such as CTA emphasis, using stable visitor assignment if traffic supports concurrent comparison.
- [ ] Set experiment duration/sample needs from the observed baseline, expected effect worth detecting and traffic. Do not invent a sample size or claim significance from a few inquiries.
- [ ] If traffic is limited, use clearly labeled directional before/after results with matched windows and source mix. Explain changes in ads, seasonality, sales staffing or tracking coverage.
- [ ] Continue, revise or revert based on qualified outcomes and operational burden. Do not claim extra sales solely from a higher click rate.

## Handoff to the next chat

Read this plan, the linked design and audit first. Reuse the existing screenshots/receipts; recheck only facts likely to have changed. Start with Task 0 source mapping and a safe preview. Keep public-site work separate from the running SDR protection observation, which has its own explicit scope and scheduler. LinkedIn call-content is a separate planning item. No new top-level chat was created by this handoff.

## Completion receipt expected

Report pages changed, buyer-flow improvement, form/integration checks, performance evidence, release status and the first date when a meaningful conversion comparison will be available. Save unknowns as unknowns. Provide exact artifact/source paths after source discovery.
