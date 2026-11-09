# Pro SWPPP website conversion design

Status: proposed design saved at Ivan's request, October 7, 2026. Continue website work in a separate chat. This document authorizes planning only; no live site edits, form submissions, customer messages or deployment have occurred.

## Intended outcome

Help a contractor reach the correct next step quickly: request an estimate, place an existing/ready order, check project requirements, or call the team. Assess improvement through qualified inquiries and completed orders, with source and device context. Appearance, clicks and raw submission volume are supporting measures.

Ivan asked for a detailed conversion plan following the live website audit. Assumptions to validate: first-time visitors often want price/scope guidance before ordering; existing buyers still need fast order access; Derek can verify commercial claims and service boundaries. There is no agreed conversion-lift target or revenue guarantee.

## Evidence and scope

Read ../../audits/2026-10-07-public-website-review.md. Homepage inspected at 1440x900 and 375x812; order, estimate and quiz entry pages inspected at desktop. Current public stack exposes WordPress/Divi, Gravity Forms and analytics scripts. Admin access, actual page/form IDs, theme ownership and deployment process are unverified. The Railway SDR repository is a documentation location, not proof that it hosts the public website.

In scope: homepage/mobile repair, estimate-route prominence, readable service explanation, proof consistency, form clarity, funnel measurement and measured performance work. Preserve navy/blue/orange identity, actual people and relevant certification/customer proof. No platform migration is selected.

Out of scope: SDR application changes, Pipedrive contact/owner changes, n8n workflows, LinkedIn content/outreach implementation, Brevo, new paid campaigns, broad SEO/state-page rollout, new payment processing, rewriting regulatory rules, or adding automated follow-up sequences.

## Approaches considered

1. Repair mobile defects and adjust CTA placement only: lowest implementation effort; retains most current copy and page structure.
2. Repair defects, clarify the homepage journey and improve the existing estimate/order paths in the current platform: recommended candidate. Broader conversion value with a bounded surface.
3. Full redesign/platform rebuild: defer. Current evidence does not establish that migration is necessary, and forms/integrations would need extensive revalidation.

## Buyer journeys

| Visitor | Primary route | Information needed before action |
|---|---|---|
| Contractor seeking a quote | Get a SWPPP estimate | Coverage, quote inputs, response expectations, what is included |
| Buyer ready to order | Order a SWPPP | Required information, scope, price confirmation and delivery-clock terms |
| Buyer unsure about requirements | Existing qualification quiz | What the result can establish, next step, contact request expectations |
| Urgent/complex project | Tap/click to call | Office availability, rush option conditions, escalation route |
| Existing customer | Order/payment links | Direct access without repeating the acquisition story |

## Proposed homepage, in order

### Header

Compact logo and navigation. At desktop expose Estimate, Order, FAQs and contact access without requiring a menu for every route. Keep customer payment access available as a utility link. Mobile keeps a compact menu and clear primary action. Avoid an intrusive sticky action bar; test whether it is needed after the initial layout is usable.

### Hero

State the service and delivery promise together on desktop/mobile. Proposed headline direction: Certified SWPPP plans for your construction project. Supporting copy can carry nationwide coverage and the 72-hour promise only after Derek confirms its exact terms. Primary candidate CTA: Get a SWPPP estimate. Secondary: Order a SWPPP. Include a tap-to-call link for urgency.

Retain the real team photograph. Place concise, source-consistent rating/certification proof near the action. Avoid stacking a large logo, slogan, repeated superiority claim and badges ahead of the service explanation. At 375x812 the service, delivery promise and primary CTA must be visible on initial load without horizontal scrolling.

### What the buyer receives

Explain the actual deliverable and included support in plain language. Have Derek verify each item: plan documents, site-specific material, any filing help, inspections and ongoing support. Clearly distinguish included work from optional services. Do not infer that buying a plan guarantees every aspect of on-site compliance.

### How it works

Explain project details -> team review/price -> confirmed scope and delivery. State what information is needed now and what can follow later. Explain when the 72-hour clock starts, business/calendar-hour treatment and what exceptions apply using Derek-approved terms.

### Relevant proof

Select a small set of existing reviews that describe an outcome buyers care about. Preserve exact quotes and source links. Use verified project context if available and approved. Reconcile the visible review widget, static count and schema. Do not add a new widget merely to increase the number of badges.

### Coverage and questions

Provide clear links to existing locations/coverage and FAQs. Answer buying questions: quote inputs, typical scope, delivery timing, revisions/support, rush work and optional inspections. Keep the quiz available for uncertain visitors. Technical answers require Derek's review.

### Final action and footer

Repeat the estimate/order choice with a readable heading and phone alternative. Maintain normal text width on mobile. Preserve address, payment access and useful links. Remove repeated support promises that add no new information.

## Estimate page

Preserve its existing short form and next-step explanation as the starting point. Inventory actual required fields and downstream dependencies before changing them. Keep optional drawings optional. Label project location clearly. Do not silently add an acreage requirement or remove phone requirements without confirming the team's qualification needs.

Place the form near the opening explanation. Use persistent labels, clear required/optional treatment, suitable mobile keyboards and useful inline errors. Keep entered values after validation failure. The success state should explain expected response and contact route; it must only follow server-confirmed acceptance. Repeated clicks/reloads must not produce duplicate leads or conversions.

## Order and quiz pages

Retain the multi-step order structure unless observed abandonment identifies a specific problem. Give ready buyers a short preparation checklist and accurate price-confirmation explanation. Clarify optional charges and ongoing charges before commitment. Preserve field IDs, conditional logic, calculation rules, upload handling, notifications and feeds.

For the quiz, explain up front whether contact details are required to receive results. Preserve existing answers/rules until their owner verifies any change. Review the contact-consent presentation without silently changing stored consent semantics. A legal compliance conclusion is outside this design.

## Visual and accessibility requirements

Fix the missing mobile hero promise, empty mobile benefits panel and cramped final heading first. Use consistent CTA styles and type roles. Keep body text readable with adequate line spacing and contrast. Avoid sustained uppercase paragraphs. Support keyboard navigation, visible focus, real labels, error association and zoom/reflow. Retain alt text appropriate to meaningful photos/badges. Do not treat decorative motion as a conversion feature.

## Measurement and rollout principles

Measure qualified inquiries per eligible session and completed orders per eligible session by source/device. Separately measure form starts, errors, valid server-accepted submissions, team response time and quote progression. A browser submit click is not a confirmed lead. A submitted order form is not automatically a won/paid sale.

Repair confirmed defects across visitors; experiment on uncertain choices such as primary CTA emphasis. Use concurrent randomized comparison only if traffic and instrumentation support it. Otherwise report a same-length before/after comparison with traffic mix and seasonality limits. Preserve a release receipt, rollback and known test-record exclusion.
