import { createElement } from "react";
import { createRoot } from "react-dom/client";
import CampaignsView from "./CampaignsView";
import ListsView from "./ListsView";
import ContactsView from "./ContactsView";
import AutomationsView from "./AutomationsView";
import { nurtureApi, type NurtureContact } from "../../lib/nurtureApi";

// Synthetic read responses only. Real provider functions are restored after every run.
export async function runNurtureReadRegressions() {
  const original = { ...nurtureApi };
  const originalUser = localStorage.getItem("swppp_sdr_user");
  const host = document.createElement("div");
  host.style.display = "none";
  document.body.append(host);
  const root = createRoot(host);
  const passed: string[] = [];
  const wait = async (check: () => boolean) => {
    const until = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > until) throw new Error(`Nurture regression timed out: ${host.textContent?.slice(0, 200)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const has = (text: string) => host.textContent?.includes(text) === true;
  const click = (text: string) => {
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === text);
    if (!button) throw new Error(`Missing regression control: ${text}`);
    button.click();
  };
  try {
    nurtureApi.account = async () => ({ email: null, companyName: null, credits: null, creditsType: null, planType: null });
    nurtureApi.lists = async () => ({ lists: [] });
    nurtureApi.campaigns = async () => { throw new Error("Synthetic campaign outage"); };
    root.render(createElement(CampaignsView));
    await wait(() => has("Synthetic campaign outage"));
    nurtureApi.campaigns = async () => ({ campaigns: [] });
    click("Try again");
    await wait(() => has("No campaigns found in Brevo.") && !has("Synthetic campaign outage"));
    passed.push("Campaign failure retries and clears its error");

    nurtureApi.lists = async () => { throw new Error("Synthetic list outage"); };
    root.render(createElement(ListsView, { onDrill: () => {} }));
    await wait(() => has("Synthetic list outage"));
    nurtureApi.lists = async () => ({ lists: [] });
    click("Try again");
    await wait(() => has("No audiences found in Brevo.") && !has("Synthetic list outage"));
    passed.push("Audience failure retries and shows a truthful empty state");

    nurtureApi.automationEngine = async () => { throw new Error("Synthetic trigger outage"); };
    root.render(createElement(AutomationsView));
    await wait(() => has("Synthetic trigger outage"));
    if (has("not configured")) throw new Error("Trigger outage was mistaken for missing configuration");
    nurtureApi.automationEngine = async () => ({ configured: true, active: true, name: "Fixture trigger", lastRun: null });
    click("Try again");
    await wait(() => has("Fixture trigger") && !has("Synthetic trigger outage"));
    if (!has("Status unverified") || has("no runs yet")) throw new Error("Unverified automation history was presented as complete");
    passed.push("Trigger outages stay distinct from configuration and recover");

    const contacts = (n: number): NurtureContact[] => Array.from({ length: n }, (_, i) => ({ email: `fixture${i}@example.invalid`, attributes: {} }));
    nurtureApi.listContacts = async (_id, offset = 0) => ({ contacts: contacts(offset ? 2 : 50), count: null });
    root.render(createElement(ContactsView, { listId: 1 }));
    await wait(() => host.querySelectorAll("tbody tr").length === 50);
    const next = host.querySelector<HTMLButtonElement>('button[aria-label="Next contacts page"]');
    if (!has("Total contacts unavailable") || !next || next.disabled) throw new Error("Unknown contact total blocked pagination or appeared as zero");
    next.click();
    await wait(() => host.querySelectorAll("tbody tr").length === 2 && has("51–52"));
    if (!host.querySelector<HTMLButtonElement>('button[aria-label="Next contacts page"]')?.disabled) throw new Error("Short final page still permits next");
    passed.push("Unknown totals permit full-page pagination and stop on the short final page");

    let resolveOld: ((value: { contacts: NurtureContact[]; count: number | null }) => void) | undefined;
    let oldRequested = false;
    nurtureApi.listContacts = async (id) => {
      if (id === 2) { oldRequested = true; return new Promise((resolve) => { resolveOld = resolve; }); }
      return { contacts: [{ email: "new-list@example.invalid" }], count: 1 };
    };
    root.render(createElement(ContactsView, { listId: 2 }));
    await wait(() => oldRequested);
    root.render(createElement(ContactsView, { listId: 3 }));
    await wait(() => has("new-list@example.invalid"));
    resolveOld?.({ contacts: [{ email: "old-list@example.invalid" }], count: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!has("new-list@example.invalid") || has("old-list@example.invalid")) throw new Error("Delayed old-list response replaced the selected list");
    passed.push("Delayed responses cannot replace a newly selected audience");
    localStorage.setItem("swppp_sdr_user", JSON.stringify({ role: "sdr" }));
    root.render(createElement(ContactsView, { listId: 4 }));
    await wait(() => has("Admins manage audience membership.") && host.querySelectorAll("tbody tr").length === 1);
    if (host.querySelector('input[aria-label="Contact email to add"]') || [...host.querySelectorAll("button")].some((button) => button.textContent === "remove" || button.textContent === "Add")) throw new Error("Staff user has membership controls");
    if (!host.querySelector('button[aria-label="Next contacts page"]')) throw new Error("Staff viewing pagination was removed");
    passed.push("Staff can view contacts and pagination without membership mutation controls");
    return passed;
  } finally {
    root.unmount();
    host.remove();
    Object.assign(nurtureApi, original);
    if (originalUser == null) localStorage.removeItem("swppp_sdr_user"); else localStorage.setItem("swppp_sdr_user", originalUser);
  }
}
