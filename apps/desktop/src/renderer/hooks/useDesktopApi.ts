import { leaseRefusalText } from "../../shared/leaseRefusal";
import { reportLeaseRefusal } from "../state/leaseRefusals";
import type { DesktopApi } from "../types/desktopApi";

// The desktop API, as every screen reaches it.
//
// It is the preload's api with one addition: a call the main process refuses because this computer
// does not hold the domain's lease is REPORTED (state/leaseRefusals.ts) before the caller sees the
// error, which then reaches the caller unchanged. A screen that swallows errors, shows its own
// generic text or has no catch at all still cannot hide who writes the domain (docs/37 section W).
//
// A plain copy, built once per api object: every method wrapped, every nested group (sessionStore)
// copied the same way. Not a Proxy -- the preload's object may be frozen, and a frozen object's
// properties cannot be answered with anything but themselves. Built once, so `api` and every
// `api.someMethod` keep their identity across renders and are safe in a hook's dependency list.

type Group = Record<string, unknown>;

const reportIfLeaseRefusal = (error: unknown): void => {
  const sentence = leaseRefusalText(error);
  if (sentence !== null) reportLeaseRefusal(sentence);
};

function reportingCopy(source: Group): Group {
  const copy: Group = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "function") {
      copy[key] = (...args: unknown[]): unknown => {
        const outcome: unknown = Reflect.apply(value, source, args);
        // The caller gets the SAME promise, settling at the same moment as before: the report is a
        // side branch, not a link in the chain. Chaining added a microtask to every call, which was
        // enough to change what a screen showed by the end of a click.
        if (outcome instanceof Promise) outcome.catch(reportIfLeaseRefusal);
        return outcome;
      };
    } else if (typeof value === "object" && value !== null) {
      copy[key] = reportingCopy(value as Group);
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

const built = new WeakMap<object, DesktopApi>();

/** The desktop API, reporting lease refusals. For code outside a component as well as in one. */
export const desktopApi = (): DesktopApi => {
  const source = window.desktop.api;
  let api = built.get(source);
  if (api === undefined) {
    // The copy has exactly the source's methods, each answering exactly as the source does.
    api = reportingCopy(source as unknown as Group) as unknown as DesktopApi;
    built.set(source, api);
  }
  return api;
};

export const useDesktopApi = (): DesktopApi => desktopApi();
